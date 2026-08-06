/*
 * FlowerTech-Portal: Zugangsprüfung.
 *
 * Regression: Die Herkunftsprüfung lief nur, WENN ein Origin-Header vorhanden
 * war (`!fromMachine && origin && !allowed.has(origin)`). Ein Aufruf ganz ohne
 * Origin — curl, Skript, beliebiger Server — übersprang die Prüfung damit
 * stillschweigend und landete direkt in der Verarbeitung.
 *
 * Erwartet: Zulässig sind genau zwei Wege — Browser mit erlaubter Herkunft
 * ODER Server-zu-Server mit gültiger Signatur. Alles andere wird abgewiesen,
 * bevor irgendetwas gespeichert wird.
 *
 * Der Test ruft den echten Handler auf. Firebase wird dabei nie erreicht: Jeder
 * hier geprüfte Fall muss vorher abbrechen. Passiert doch ein Aufruf die
 * Zugangsprüfung, schlägt der Test durch den fehlenden Firebase-Zugang fehl —
 * genau das soll er.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = "test-secret-fuer-die-signaturpruefung";
process.env.FLOWERTECH_WEBHOOK_SECRET = SECRET;
process.env.FLOWERTECH_ALLOWED_ORIGINS = "https://erlaubt.example";

const handler = (await import(path.join(root, "netlify/functions/flowertech-portal.mjs"))).default;

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

const VALID_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";       // 28 Zeichen
const BODY = {
  token: VALID_TOKEN,
  kind: "briefing",
  payload: {
    contactEmail: "test@example.ch",
    goal: "Wir brauchen eine neue Website mit Kontaktformular.",
  },
};

function request(headers, body = BODY) {
  return new Request("https://quantus.example/.netlify/functions/flowertech-portal", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: JSON.stringify(body),
  });
}

// ── 1. Ohne Origin und ohne Signatur: abgewiesen ───────────────────────────
{
  const response = await handler(request({}));
  ok(response.status === 401,
    `Aufruf ohne Origin und ohne Signatur muss 401 liefern, war ${response.status}`);
  const data = await response.json();
  ok(/Signatur/i.test(data.error || ""), "die Ablehnung nennt den Grund nicht");
}

// ── 2. Falsche Signatur ohne Origin: abgewiesen ────────────────────────────
{
  const response = await handler(request({ "X-FlowerTech-Signature": "falsch" }));
  ok(response.status === 401, `falsche Signatur ohne Origin muss 401 liefern, war ${response.status}`);
}

// Gleich lange, aber falsche Signatur — der Vergleich darf nicht auf die Länge
// allein hereinfallen.
{
  const wrong = "x".repeat(SECRET.length);
  const response = await handler(request({ "X-FlowerTech-Signature": wrong }));
  ok(response.status === 401, `gleich lange Falschsignatur muss 401 liefern, war ${response.status}`);
}

// ── 3. Fremde Herkunft ohne Signatur: abgewiesen ───────────────────────────
{
  const response = await handler(request({ Origin: "https://boese.example" }));
  ok(response.status === 403, `fremde Herkunft muss 403 liefern, war ${response.status}`);
}

// ── 4. Honeypot greift weiterhin vor allem anderen ─────────────────────────
{
  const response = await handler(request(
    { "X-FlowerTech-Signature": SECRET },
    Object.assign({}, BODY, { website: "spam" })));
  ok(response.status === 202, `der Honeypot muss 202 liefern, war ${response.status}`);
}

// ── 5. Gültige Signatur kommt durch die Zugangsprüfung ─────────────────────
// Danach greift die Inhaltsprüfung: ein ungültiger Token wird mit 400
// abgelehnt. Das beweist, dass die Signatur akzeptiert wurde (sonst 401) und
// die Verarbeitung trotzdem nicht blind weiterläuft.
{
  const response = await handler(request(
    { "X-FlowerTech-Signature": SECRET },
    Object.assign({}, BODY, { token: "zu-kurz" })));
  ok(response.status === 400,
    `gültige Signatur mit unbrauchbarem Token muss 400 liefern, war ${response.status}`);
}

// ── 6. Erlaubte Browser-Herkunft kommt durch die Zugangsprüfung ────────────
{
  const response = await handler(request(
    { Origin: "https://erlaubt.example" },
    Object.assign({}, BODY, { token: "zu-kurz" })));
  ok(response.status === 400,
    `erlaubte Herkunft muss die Zugangsprüfung passieren, war ${response.status}`);
}
{
  const response = await handler(request(
    { Origin: "https://flowertech.ch" },
    Object.assign({}, BODY, { token: "zu-kurz" })));
  ok(response.status === 400, "die fest eingebaute Herkunft flowertech.ch wird nicht mehr akzeptiert");
}

// ── 7. Vorflug und Methode bleiben unverändert ─────────────────────────────
{
  const response = await handler(new Request("https://quantus.example/x", { method: "OPTIONS" }));
  ok(response.status === 204, `OPTIONS muss 204 liefern, war ${response.status}`);
  const response2 = await handler(new Request("https://quantus.example/x", { method: "GET" }));
  ok(response2.status === 405, `GET muss 405 liefern, war ${response2.status}`);
}

// ── 8. Der n8n-Webhook prüft die Signatur VOR der Normalisierung ───────────
{
  const workflow = JSON.parse(
    fs.readFileSync(path.join(root, "n8n/flowertech-lead-to-project.workflow.json"), "utf8"));
  ok(workflow.active === false, "der n8n-Workflow ist nicht mehr standardmässig inaktiv");

  const gate = workflow.nodes.find((n) => n.id === "ft-signature");
  ok(!!gate, "der Signatur-Check-Node fehlt im n8n-Workflow");
  ok(gate.type === "n8n-nodes-base.if", "der Signatur-Check ist kein Verzweigungs-Node");
  const condition = gate.parameters.conditions.conditions[0];
  ok(condition.leftValue.includes("x-flowertech-signature"),
    "der Signatur-Check liest den Header nicht");
  ok(condition.rightValue.includes("$env.FT_WEBHOOK_SECRET"),
    "der Signatur-Check vergleicht nicht gegen die Umgebungsvariable");

  // Der Webhook geht zuerst in den Signatur-Check, nicht direkt in die Normalisierung.
  const fromWebhook = workflow.connections["Webhook: flowertech-lead"].main[0];
  ok(fromWebhook.length === 1 && fromWebhook[0].node === "Signatur gueltig?",
    "der Webhook läuft wieder direkt in die Normalisierung");
  const fromGate = workflow.connections["Signatur gueltig?"].main;
  ok(fromGate[0][0].node === "Normalisieren & zuordnen", "der Ja-Zweig führt nicht zur Normalisierung");
  ok(fromGate[1][0].node === "Antwort: nicht signiert", "es fehlt der Ablehnungszweig");
  const reject = workflow.nodes.find((n) => n.id === "ft-respond-unauth");
  ok(reject && reject.parameters.options.responseCode === 401,
    "der Ablehnungszweig antwortet nicht mit 401");

  // Der Mail-Eingang bleibt der interne, deaktivierte Zweig ohne Signatur.
  const imap = workflow.nodes.find((n) => n.id === "ft-imap");
  ok(imap && imap.disabled === true, "der optionale Mail-Eingang ist nicht mehr deaktiviert");
  ok(workflow.connections["Mail-Eingang (optional)"].main[0][0].node === "Normalisieren & zuordnen",
    "der interne Mail-Zweig wurde umgehängt");

  // Keine Geheimnisse im Workflow-JSON.
  const raw = fs.readFileSync(path.join(root, "n8n/flowertech-lead-to-project.workflow.json"), "utf8");
  ok(!/"credentials"\s*:/.test(raw), "im Workflow-JSON stehen Credentials");
  ok(!/(secret|token|password)"\s*:\s*"[A-Za-z0-9_\-+/=]{12,}"/i.test(raw),
    "im Workflow-JSON steht ein eingebettetes Geheimnis");
}

console.log(`flowertech portal auth: ok (${checks} Pruefungen)`);
