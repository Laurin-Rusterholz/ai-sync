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

// ── 8. Der n8n-Webhook authentifiziert VOR der Normalisierung ─────────────
// Die Instanz hat keine Variables-Lizenz, deshalb keine $env-Abhaengigkeit
// mehr: Beide Nodes nutzen dasselbe n8n-Credential (Header Auth). n8n prueft
// den Header am Webhook, bevor der Workflow ueberhaupt laeuft.
{
  const file = path.join(root, "n8n/flowertech-lead-to-project.workflow.json");
  const raw = fs.readFileSync(file, "utf8");
  const workflow = JSON.parse(raw);
  const CRED = "FlowerTech Shared Signature";

  ok(workflow.active === false, "der n8n-Workflow ist nicht mehr standardmässig inaktiv");
  ok(!raw.includes("$env"), "der Workflow haengt wieder an n8n-Variables ($env)");

  // Webhook: Header Auth ueber das Credential.
  const webhook = workflow.nodes.find((n) => n.id === "ft-webhook");
  ok(!!webhook, "der Webhook-Node fehlt");
  ok(webhook.parameters.authentication === "headerAuth",
    "der Webhook verlangt keine Header-Authentifizierung");
  ok(webhook.credentials?.httpHeaderAuth?.name === CRED,
    `der Webhook nutzt nicht das Credential "${CRED}"`);

  // Ausgehender Aufruf: dasselbe Credential, feste oeffentliche Basis.
  const api = workflow.nodes.find((n) => n.id === "ft-api");
  ok(!!api, "der HTTP-Node fehlt");
  ok(api.parameters.authentication === "genericCredentialType"
    && api.parameters.genericAuthType === "httpHeaderAuth",
    "der ausgehende Aufruf nutzt keine Header-Auth per Credential");
  ok(api.credentials?.httpHeaderAuth?.name === CRED,
    `der ausgehende Aufruf nutzt nicht dasselbe Credential "${CRED}"`);
  ok(api.parameters.url === "https://management-xo2-pro.netlify.app/.netlify/functions/flowertech-portal",
    `die Quantus-Basis steht nicht fest im HTTP-Node: ${api.parameters.url}`);
  // Der Signatur-Header darf NICHT mehr als Parameter dastehen — sonst waere er
  // ein Ort, an dem versehentlich ein Klartext-Geheimnis landet.
  const headerNames = (api.parameters.headerParameters?.parameters || []).map((h) => h.name);
  ok(!headerNames.some((n) => /signature/i.test(n)),
    "der Signatur-Header steht wieder als Parameter im Workflow");

  // Auth passiert vor der Normalisierung: der Webhook geht direkt dorthin,
  // das alte $env-IF ist weg.
  ok(!workflow.nodes.some((n) => n.id === "ft-signature"),
    "das $env-basierte Signatur-IF ist zurueck");
  const fromWebhook = workflow.connections["Webhook: flowertech-lead"].main[0];
  ok(fromWebhook.length === 1 && fromWebhook[0].node === "Normalisieren & zuordnen",
    "der Webhook fuehrt nicht direkt in die Normalisierung");

  // Kein Fallback-Token: ohne Projekt-Token wird nichts angelegt.
  const code = workflow.nodes.find((n) => n.id === "ft-normalize").parameters.jsCode;
  ok(!/FT_DEFAULT_TOKEN/.test(code), "der Fallback-Token ist zurueck");
  ok(/const token = pick\('token', 'projectToken'\);/.test(code),
    "der Token kommt nicht mehr ausschliesslich aus dem Eingang");

  // Der Mail-Eingang bleibt der interne, deaktivierte Zweig.
  const imap = workflow.nodes.find((n) => n.id === "ft-imap");
  ok(imap && imap.disabled === true, "der optionale Mail-Eingang ist nicht mehr deaktiviert");

  // Keine Geheimnisse im JSON — Credential-Referenzen tragen nur id und name.
  for (const node of workflow.nodes) {
    for (const value of Object.values(node.credentials || {})) {
      ok(Object.keys(value).every((k) => k === "id" || k === "name"),
        `der Credential-Verweis in ${node.name} enthaelt mehr als id/name`);
      ok(!value.id, `der Credential-Verweis in ${node.name} ist an eine Instanz gebunden`);
    }
  }
  ok(!/(secret|password|apiKey)"\s*:\s*"[^"]{8,}"/i.test(raw),
    "im Workflow-JSON steht ein eingebettetes Geheimnis");

  // Die zwei manuellen Schritte sind im Workflow dokumentiert.
  const doku = workflow.nodes.find((n) => n.id === "sn-ft-doc").parameters.content;
  ok(/Credential anlegen/i.test(doku), "der Doku-Hinweis zum Anlegen des Credentials fehlt");
  ok(/X-FlowerTech-Signature/.test(doku), "der Doku-Hinweis nennt den Header-Namen nicht");
  ok(/FLOWERTECH_WEBHOOK_SECRET/.test(doku), "der Doku-Hinweis nennt die Netlify-Variable nicht");
  ok(/BEIDEN Nodes|beiden Nodes/i.test(doku), "der Doku-Hinweis nennt nicht beide Nodes");
}

console.log(`flowertech portal auth: ok (${checks} Pruefungen)`);
