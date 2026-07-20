#!/usr/bin/env node
// ============================================================================
// Integrationstest für den n8n-Code-Node "Dokument bauen" (smarter-daily).
//
//   node scripts/smarter-daily-node.test.mjs
//
// Extrahiert den ECHTEN jsCode aus n8n/smarter-daily.workflow.json und führt ihn
// unter dem n8n-Ausführungsmodell aus ("Run Once for All Items": async-Funktion
// mit Top-Level-return, injizierte $json / $()-Globals). Prüft, dass der Node bei
// reiner Prosa, werfendem $("Thema auswaehlen").first(), leerer Antwort und
// gültigem JSON IMMER ein valides [{ json: { dateKey, docObject, queueUpdate } }]
// zurückgibt statt zu werfen ("Code doesn't return items properly").
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wf = JSON.parse(readFileSync(join(root, "n8n/smarter-daily.workflow.json"), "utf8"));
const node = wf.nodes.find((n) => n.name === "Dokument bauen");
if (!node) { console.error("Node 'Dokument bauen' nicht gefunden"); process.exit(1); }
const jsCode = node.parameters.jsCode;

// n8n JS Task Runner ("Run Once for All Items") ~ async-Funktion mit Top-Level-
// return und injizierten Globals. So faithful wie möglich nachgebildet.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runNode($json, dollar) {
  const fn = new AsyncFunction("$json", "$", jsCode);
  return fn($json, dollar);
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (detail ? "  → " + detail : "")); }
}
function isValidItems(r) {
  return Array.isArray(r) && r.length === 1 && r[0] && r[0].json &&
    typeof r[0].json.dateKey !== "undefined" &&
    r[0].json.docObject && typeof r[0].json.docObject === "object" &&
    typeof r[0].json.queueUpdate === "object";
}
function metaDollar(metaObj) { return () => ({ first: () => ({ json: metaObj }) }); }
function throwingDollar() { return () => ({ first: () => { throw new Error("Referenced node is unexecuted"); } }); }

const META = { dateKey: "2026-07-20", unitTitle: "ALV / Wiedereingliederung", unitIds: ["u1"], queueUpdate: { u1: { status: "delivered" } } };

console.log("smarter-daily Node 'Dokument bauen' — Integrationstest\n");

// 1) EXAKT der gemeldete Fall: reine Prosa, KEIN JSON, ein einziger text-Block.
{
  const resp = { content: [{ type: "text", text: "Um die Wiedereingliederung zu foerdern, unterstuetzt die ALV die Foerderung der selbststaendigen Erwerbstaetigkeit." }], stop_reason: "end_turn" };
  let r, threw = null;
  try { r = await runNode(resp, metaDollar(META)); } catch (e) { threw = e; }
  check("Prosa-only: wirft NICHT", threw === null, threw && threw.message);
  check("Prosa-only: valides items-Array", isValidItems(r), JSON.stringify(r).slice(0, 200));
  check("Prosa-only: generationError true", r && r[0].json.docObject.generationError === true);
  check("Prosa-only: done false", r && r[0].json.docObject.done === false);
  check("Prosa-only: questions leer", r && Array.isArray(r[0].json.docObject.questions) && r[0].json.docObject.questions.length === 0);
  check("Prosa-only: Rohtext im theoryHtml", r && r[0].json.docObject.theoryHtml.indexOf("Wiedereingliederung") >= 0);
  check("Prosa-only: dateKey aus meta", r && r[0].json.dateKey === "2026-07-20");
  check("Prosa-only: queueUpdate erhalten (Thema wird delivered)", r && r[0].json.queueUpdate && r[0].json.queueUpdate.u1 && r[0].json.queueUpdate.u1.status === "delivered");
  check("Prosa-only: documentHtml gerendert", r && typeof r[0].json.docObject.documentHtml === "string" && r[0].json.docObject.documentHtml.indexOf("Automatische Aufbereitung fehlgeschlagen") >= 0);
}

// 2) $("Thema auswaehlen").first() WIRFT → Notfall-Fallback, kein Abbruch.
{
  const resp = { content: [{ type: "text", text: "irgendein Text" }] };
  let r, threw = null;
  try { r = await runNode(resp, throwingDollar()); } catch (e) { threw = e; }
  check("first() wirft: Node wirft NICHT", threw === null, threw && threw.message);
  check("first() wirft: valides items-Array", isValidItems(r));
  check("first() wirft: generationError true", r && r[0].json.docObject.generationError === true);
  check("first() wirft: dateKey per safeTodayKey (yyyy-mm-dd)", r && /^\d{4}-\d{2}-\d{2}$/.test(r[0].json.dateKey));
  check("first() wirft: leeres queueUpdate", r && Object.keys(r[0].json.queueUpdate).length === 0);
}

// 3) Leere Antwort (kein text-Block) → Fallback statt throw.
{
  const resp = { content: [{ type: "thinking", thinking: "…" }], stop_reason: "end_turn" };
  let r, threw = null;
  try { r = await runNode(resp, metaDollar(META)); } catch (e) { threw = e; }
  check("leere Antwort: wirft NICHT", threw === null, threw && threw.message);
  check("leere Antwort: valides items-Array", isValidItems(r));
  check("leere Antwort: generationError true", r && r[0].json.docObject.generationError === true);
}

// 4) Prosa + eingebettetes JSON → echtes Dokument (kein Fallback).
{
  const resp = { content: [{ type: "text", text: 'Gerne! {"theoryHtml":"<p>Echt</p>","questions":[{"q":"Was?","a":"Das."}],"flashcards":[{"front":"F","back":"B"}]} Ende.' }] };
  let r, threw = null;
  try { r = await runNode(resp, metaDollar(META)); } catch (e) { threw = e; }
  check("Prosa+JSON: wirft NICHT", threw === null, threw && threw.message);
  check("Prosa+JSON: valides items-Array", isValidItems(r));
  check("Prosa+JSON: KEIN generationError", r && !r[0].json.docObject.generationError);
  check("Prosa+JSON: theoryHtml übernommen", r && r[0].json.docObject.theoryHtml === "<p>Echt</p>");
  check("Prosa+JSON: Frage übernommen", r && r[0].json.docObject.questions[0].q === "Was?");
  check("Prosa+JSON: documentHtml gerendert", r && r[0].json.docObject.documentHtml.indexOf("<!doctype html>") >= 0);
}

// 5) Reines JSON mit trailing comma → repariert, echtes Dokument.
{
  const resp = { content: [{ type: "text", text: '{"theoryHtml":"<p>T</p>","questions":[],}' }] };
  let r, threw = null;
  try { r = await runNode(resp, metaDollar(META)); } catch (e) { threw = e; }
  check("trailing comma: wirft NICHT", threw === null, threw && threw.message);
  check("trailing comma: KEIN generationError", r && !r[0].json.docObject.generationError);
  check("trailing comma: theoryHtml übernommen", r && r[0].json.docObject.theoryHtml === "<p>T</p>");
}

// 6) Struktur-Sicherung: genau EIN Top-Level-return im Node-Code.
{
  // Entferne Funktionskörper grob, um nur Top-Level-Statements zu betrachten:
  // zähle "return output;" (der einzige Top-Level-return dieser Implementierung).
  const topReturns = (jsCode.match(/^\s*return output;\s*$/gm) || []).length;
  check("genau ein 'return output;' (single tail return)", topReturns === 1, "gefunden: " + topReturns);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
