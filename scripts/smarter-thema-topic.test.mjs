#!/usr/bin/env node
// ============================================================================
// Test für den n8n-Code-Node "Thema auswaehlen" (smarter-daily) — Topic-Override.
//
//   node scripts/smarter-thema-topic.test.mjs
//
// Extrahiert den ECHTEN jsCode aus n8n/smarter-daily.workflow.json und führt ihn
// unter dem n8n-Ausführungsmodell aus (async-Funktion mit Top-Level-return,
// injizierte $json / $()-Globals). Prüft:
//  - manuelles Thema (Webhook body.topic) überschreibt die Queue-Auswahl
//  - ohne Topic: unverändert nächstes pending-Thema, wird "delivered"
//  - leere Queue ohne Topic: hasWork:false
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wf = JSON.parse(readFileSync(join(root, "n8n/smarter-daily.workflow.json"), "utf8"));
const node = wf.nodes.find((n) => n.name === "Thema auswaehlen");
if (!node) { console.error("Node 'Thema auswaehlen' nicht gefunden"); process.exit(1); }
const jsCode = node.parameters.jsCode;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Baut den $()-Node-Accessor. nodeData: { "<NodeName>": <json-Objekt> }.
// Nicht vorhandene Nodes werfen (wie in n8n bei nicht ausgeführten Nodes).
function makeDollar(nodeData) {
  return function (name) {
    if (!(name in nodeData)) throw new Error("Node '" + name + "' hat nicht ausgeführt");
    return { first: () => ({ json: nodeData[name] }) };
  };
}
async function runNode($json, nodeData) {
  const fn = new AsyncFunction("$json", "$", jsCode);
  return fn($json, makeDollar(nodeData));
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (detail ? "  → " + detail : "")); }
}

const CFG = { timezone: "Europe/Zurich", dailyMinutes: 30 };
const QUEUE = {
  u1: { title: "ALV Grundlagen", content: "Quelltext A", status: "pending", order: 0 },
  u2: { title: "Zweites Thema", content: "Quelltext B", status: "pending", order: 1 },
  u3: { title: "Schon erledigt", content: "x", status: "delivered", order: 2 }
};

console.log("smarter-daily Node 'Thema auswaehlen' — Topic-Override\n");

// 1) Manuelles Thema via Webhook body.topic -> überschreibt Queue-Auswahl.
{
  const nodeData = {
    "RTDB: config lesen": CFG,
    "Webhook: manuelle Generierung": { body: { topic: "Photosynthese", source: "manual" } }
  };
  let r, threw = null;
  try { r = await runNode(QUEUE, nodeData); } catch (e) { threw = e; }
  check("Topic: wirft NICHT", threw === null, threw && threw.message);
  check("Topic: hasWork true", r && r[0].json.hasWork === true);
  check("Topic: unitTitle = topic", r && r[0].json.unitTitle === "Photosynthese");
  check("Topic: manualTopic true", r && r[0].json.manualTopic === true);
  check("Topic: unitIds leer (kein Queue-Konsum)", r && Array.isArray(r[0].json.unitIds) && r[0].json.unitIds.length === 0);
  check("Topic: queueUpdate leer", r && r[0].json.queueUpdate && Object.keys(r[0].json.queueUpdate).length === 0);
  check("Topic: combinedText enthält Thema", r && r[0].json.combinedText.indexOf("Photosynthese") >= 0);
  check("Topic: system-Prompt vorhanden", r && typeof r[0].json.system === "string" && r[0].json.system.indexOf("SPRACHE:") >= 0);
  check("Topic: dateKey yyyy-mm-dd", r && /^\d{4}-\d{2}-\d{2}$/.test(r[0].json.dateKey));
}

// 1b) Topic vorhanden, aber leer/whitespace -> wie ohne Topic (Queue-Auswahl).
{
  const nodeData = {
    "RTDB: config lesen": CFG,
    "Webhook: manuelle Generierung": { body: { topic: "   " } }
  };
  let r = await runNode(QUEUE, nodeData);
  check("leerer Topic: fällt auf Queue zurück", r && r[0].json.manualTopic === false && r[0].json.unitTitle === "ALV Grundlagen");
}

// 2) Kein Topic (Schedule-Lauf: Webhook-Node nicht ausgeführt) -> Queue-Auswahl.
{
  const nodeData = { "RTDB: config lesen": CFG }; // Webhook-Node fehlt -> $() wirft -> Fallback
  let r, threw = null;
  try { r = await runNode(QUEUE, nodeData); } catch (e) { threw = e; }
  check("kein Topic: wirft NICHT", threw === null, threw && threw.message);
  check("kein Topic: hasWork true", r && r[0].json.hasWork === true);
  check("kein Topic: nimmt pending[0] nach order (u1)", r && r[0].json.unitTitle === "ALV Grundlagen");
  check("kein Topic: unitIds = [u1]", r && JSON.stringify(r[0].json.unitIds) === JSON.stringify(["u1"]));
  check("kein Topic: markiert u1 delivered", r && r[0].json.queueUpdate.u1 && r[0].json.queueUpdate.u1.status === "delivered");
  check("kein Topic: manualTopic false", r && r[0].json.manualTopic === false);
}

// 3) Leere Queue, kein Topic -> hasWork:false.
{
  const nodeData = { "RTDB: config lesen": CFG };
  let r = await runNode({}, nodeData);
  check("leere Queue: hasWork false", r && r[0].json.hasWork === false);
  check("leere Queue: dateKey gesetzt", r && /^\d{4}-\d{2}-\d{2}$/.test(r[0].json.dateKey));
}

// 3b) Leere Queue, ABER Topic -> trotzdem manuelles Thema (kein Queue nötig).
{
  const nodeData = { "RTDB: config lesen": CFG, "Webhook: manuelle Generierung": { body: { topic: "Quantenmechanik" } } };
  let r = await runNode({}, nodeData);
  check("leere Queue + Topic: hasWork true", r && r[0].json.hasWork === true && r[0].json.unitTitle === "Quantenmechanik");
}

// 4) RTDB-Queue-Wrapper ({data:{...}}) wird wie bisher entpackt.
{
  const nodeData = { "RTDB: config lesen": CFG };
  let r = await runNode({ data: QUEUE }, nodeData);
  check("Queue-Wrapper {data}: pending[0] gewählt", r && r[0].json.unitTitle === "ALV Grundlagen");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
