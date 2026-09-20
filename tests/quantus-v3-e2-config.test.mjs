/* ══ Paket E2 — Konfiguration und Ports, streng fail closed ══════════════
 *
 * Ohne vollstaendige Konfiguration startet kein Dienst mit Vorgabewerten,
 * sondern antwortet auf JEDER Route mit 503 und nennt die fehlenden
 * Variablennamen — nie Werte.
 *
 * Geprueft wird auch, was NICHT geht: `live` ohne vollstaendige
 * Freigabetore, ein Watchdog mit Task-Port, eine Route ohne eigene
 * Aufruferliste.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRuntimeConfig, ACTIVATION_GATES, RUNTIME_MODES, DEFAULT_MODE,
  SECTION_DEADLINE_MS, externalEffectsAllowed,
} from "../runtime/quantus-v3/src/config.mjs";
import { createPortRegistry, REQUIRED_PORTS, FORBIDDEN_PORTS, availablePort, unavailablePort } from "../runtime/quantus-v3/src/ports.mjs";
import { createIntegrationCorePort } from "../runtime/quantus-v3/src/integration-ports.mjs";
import { createApp, createUnconfiguredApp, ROUTE_TABLE } from "../runtime/quantus-v3/src/app.mjs";
import { TOOL_PORTS, TOOL_PORT_NAMES, QUANTUS_TOOLS, SERVICE_ROLE_VERBS, createToolClient } from "../runtime/quantus-v3/src/tool-ports.mjs";
import * as F from "./quantus-v3-e2-fixtures.mjs";

const lese = (env) => (name) => env[name];

test("ohne Umgebung gibt es keinen Dienst, nur eine Liste fehlender Namen", () => {
  const res = resolveRuntimeConfig(lese({}));
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "runtime_not_configured");
  assert.deepEqual(res.body.missing, ["QUANTUS_V3_ENDPOINTS", "QUANTUS_V3_POLICY_VERSION", "QUANTUS_V3_RUNTIME_ROLE", "QUANTUS_V3_TENANT"]);
  // Es stehen ausschliesslich Namen drin, keine Werte.
  assert.equal(JSON.stringify(res.body).includes("@"), false);
});

test("ein unkonfigurierter Dienst antwortet auf jeder Route mit 503", async () => {
  const res = resolveRuntimeConfig(lese({}));
  const app = createUnconfiguredApp(res);
  const antwort = await app.router.handle({ method: "POST", path: "/v3/slot/start", headers: {}, bodyText: "{}" });
  assert.equal(antwort.status, 503);
  assert.equal(JSON.parse(antwort.body).error, "runtime_not_configured");
  assert.deepEqual(app.router.routes, []);
});

test("die Betriebsart ist ohne Angabe dry_run", () => {
  const config = F.configFor("worker");
  assert.equal(config.mode, DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, "dry_run");
  assert.deepEqual([...RUNTIME_MODES], ["dry_run", "shadow", "live"]);
  assert.equal(config.allowExternalEffects, false);
  assert.equal(externalEffectsAllowed(config), false);
  assert.equal(config.gatesComplete, false);
});

test("live gibt es nur mit ALLEN Freigabetoren und ausdruecklicher Erlaubnis", () => {
  const ohneTore = resolveRuntimeConfig(lese(F.envFor("worker", { QUANTUS_V3_RUNTIME_MODE: "live", QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true" })));
  assert.equal(ohneTore.ok, false);
  assert.ok(ohneTore.body.invalid.includes("QUANTUS_V3_RUNTIME_MODE:activation_gate_not_passed"));

  const ohneErlaubnis = resolveRuntimeConfig(lese(F.envFor("worker", { QUANTUS_V3_RUNTIME_MODE: "live", QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed() })));
  assert.equal(ohneErlaubnis.ok, false);
  assert.ok(ohneErlaubnis.body.invalid.includes("QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS"));

  // Ein Tor ohne Nachweis zaehlt nicht als bestanden.
  const ohneNachweis = JSON.parse(F.allGatesPassed());
  ohneNachweis.restoreDrill = { passed: true, ref: "" };
  const halb = resolveRuntimeConfig(lese(F.envFor("worker", {
    QUANTUS_V3_RUNTIME_MODE: "live", QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
    QUANTUS_V3_ACTIVATION_GATES: JSON.stringify(ohneNachweis),
  })));
  assert.equal(halb.ok, false);

  // Im Live-Betrieb ist auch ein belegpflichtiger Quellensatz Pflicht —
  // sonst waere jeder Abschluss trivial gruen.
  const ohneQuellen = resolveRuntimeConfig(lese(F.envFor("worker", {
    QUANTUS_V3_RUNTIME_MODE: "live", QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
    QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed(),
  })));
  assert.equal(ohneQuellen.ok, false);
  assert.ok(ohneQuellen.body.invalid.includes("QUANTUS_V3_REQUIRED_SOURCES:empty_in_live"));

  const vollstaendig = resolveRuntimeConfig(lese(F.envFor("worker", {
    QUANTUS_V3_RUNTIME_MODE: "live", QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
    QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed(),
    QUANTUS_V3_REQUIRED_SOURCES: JSON.stringify(["gmail-inbox", "calendar-primary"]),
  })));
  assert.equal(vollstaendig.ok, true);
  assert.deepEqual([...vollstaendig.config.requiredSources], ["calendar-primary", "gmail-inbox"]);
  assert.equal(externalEffectsAllowed(vollstaendig.config), true);
  assert.deepEqual(Object.keys(vollstaendig.config.gates).sort(), [...ACTIVATION_GATES].sort());
});

test("shadow wirkt nicht nach aussen, auch mit allen Toren", () => {
  const res = resolveRuntimeConfig(lese(F.envFor("worker", {
    QUANTUS_V3_RUNTIME_MODE: "shadow", QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
    QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed(),
  })));
  assert.equal(res.ok, true);
  assert.equal(externalEffectsAllowed(res.config), false);
});

test("jede Route hat ihre EIGENE Kennung und Aufruferliste", () => {
  const config = F.configFor("worker");
  assert.deepEqual(Object.keys(config.endpoints).sort(), ["run.continue", "slot.start"]);
  assert.notEqual(config.endpoints["slot.start"].audience, config.endpoints["run.continue"].audience);
  assert.deepEqual(config.endpoints["slot.start"].allowedServiceAccounts, [F.SA.schedulerStart]);
  assert.deepEqual(config.endpoints["run.continue"].allowedServiceAccounts, [F.SA.tasks]);

  for (const kaputt of [
    { "slot.start": { audience: "http://unsicher.test.invalid", allowedServiceAccounts: [F.SA.schedulerStart] } },
    { "slot.start": { audience: F.AUD.slotStart, allowedServiceAccounts: [] } },
    { "slot.start": { audience: F.AUD.slotStart, allowedServiceAccounts: ["*"] } },
    { "slot.start": { audience: F.AUD.slotStart, allowedServiceAccounts: ["wer@gmail.com"] } },
  ]) {
    const res = resolveRuntimeConfig(lese(F.envFor("worker", {
      QUANTUS_V3_ENDPOINTS: JSON.stringify({ ...kaputt, "run.continue": { audience: F.AUD.runContinue, allowedServiceAccounts: [F.SA.tasks] } }),
    })));
    assert.equal(res.ok, false, JSON.stringify(kaputt));
    assert.ok(res.body.invalid.includes("QUANTUS_V3_ENDPOINTS:slot.start"));
  }
});

test("die Abschnittsfrist laesst sich senken, aber nie ueber 90 Sekunden heben", () => {
  assert.equal(SECTION_DEADLINE_MS, 90_000);
  assert.equal(F.configFor("worker").sectionDeadlineMs, 90_000);
  assert.equal(F.configFor("worker", { QUANTUS_V3_SECTION_DEADLINE_MS: "30000" }).sectionDeadlineMs, 30_000);
  for (const wert of ["90001", "600000", "1000", "abc", "-1"]) {
    const res = resolveRuntimeConfig(lese(F.envFor("worker", { QUANTUS_V3_SECTION_DEADLINE_MS: wert })));
    assert.equal(res.ok, false, wert);
  }
});

/* ── Ports ─────────────────────────────────────────────────────────────── */

test("fehlende Pflichtports werden benannt, nicht ersetzt", async () => {
  const registry = createPortRegistry("worker", {});
  assert.deepEqual(registry.missingRequired().sort(), [...REQUIRED_PORTS.worker].sort());
  assert.throws(() => registry.require("core"), (e) => e.status === 503 && e.error === "port_unavailable" && e.detail.port === "core");
  assert.equal(registry.has("core"), false);
  const echt = await createIntegrationCorePort({ tenantId: "quantus", principalId: "runner-a",
    loadModules: async () => { throw new Error("module unavailable"); },
  });
  assert.equal(echt.available, false);
  assert.equal(echt.reason, "integration_cas_envelope_not_wired");
});

test("der Watchdog darf keinen Task-Port und keinen Monitorzugriff haben", () => {
  assert.deepEqual([...FORBIDDEN_PORTS.watchdog], ["tasks", "sectionWork", "monitorInvoke", "closureEvidence"]);
  for (const verboten of FORBIDDEN_PORTS.watchdog) {
    assert.throws(() => createPortRegistry("watchdog", { [verboten]: availablePort(verboten, {}) }),
      /Unabhaengigkeit verletzt|unbekannter Port/, verboten);
  }
  const ok = createPortRegistry("watchdog", { clock: availablePort("clock", { now: () => 1 }) });
  assert.equal(ok.has("tasks"), false);
  assert.deepEqual([...REQUIRED_PORTS.watchdog].sort(), ["alert", "clock", "core", "jwks"]);
});

test("jeder Dienst kennt nur seine eigenen Routen", () => {
  assert.deepEqual(ROUTE_TABLE.worker.map((r) => r.path), ["/v3/slot/start", "/v3/run/continue"]);
  assert.deepEqual(ROUTE_TABLE.monitor.map((r) => r.path), ["/v3/monitor/tick", "/v3/monitor/preflight"]);
  assert.deepEqual(ROUTE_TABLE.watchdog.map((r) => r.path), ["/v3/watchdog/check"]);
  const app = createApp({ config: F.configFor("watchdog"), ports: {} });
  assert.deepEqual(app.router.routes, ["POST /v3/watchdog/check"]);
  assert.throws(() => createApp({ config: F.configFor("worker"), ports: createPortRegistry("monitor", {}) }), /passen nicht zusammen/);
});

/* ── Werkzeugports ─────────────────────────────────────────────────────── */

test("es gibt genau acht Werkzeugports — keinen Vollzugriffsport", () => {
  assert.deepEqual(TOOL_PORT_NAMES, [
    "context.run", "run.checkpoint", "run.claim", "run.ensure",
    "run.finalize", "run.log", "run.renew", "status.run",
  ]);
  // Verben, die C1 dem Backend zwar erlaubt, die dieses Paket aber nicht
  // braucht, gibt es hier nicht.
  const belegteVerben = new Set(Object.values(TOOL_PORTS).map((p) => p.verb));
  for (const nichtGebraucht of ["briefing.consumeAnswer", "document.processed", "note.append"]) {
    assert.ok(SERVICE_ROLE_VERBS.backend_checker.includes(nichtGebraucht), nichtGebraucht);
    assert.equal(belegteVerben.has(nichtGebraucht), false, `${nichtGebraucht} soll kein Port sein`);
  }
  // Und kein Sammelverb.
  for (const sammel of ["command.submit", "job.advance", "mail.send", "policy.write", "grant.write"]) {
    assert.equal(belegteVerben.has(sammel), false, sammel);
  }
});

test("jeder Werkzeugport passt zu Werkzeug UND Rollenmatrix", () => {
  for (const [name, port] of Object.entries(TOOL_PORTS)) {
    assert.ok(QUANTUS_TOOLS[port.tool].verbs.includes(port.verb), name);
    assert.ok(SERVICE_ROLE_VERBS[port.role].includes(port.verb), name);
    assert.ok(["scheduler", "backend_checker"].includes(port.role), name);
  }
  assert.deepEqual(Object.values(QUANTUS_TOOLS).map((t) => t.route).sort(),
    ["quantus-context", "quantus-ingest", "quantus-read", "quantus-run-status"]);
});

test("ein abgeschaltetes Werkzeug scheitert mit 503, bevor irgendetwas hinausgeht", async () => {
  const gesendet = [];
  const client = createToolClient({
    transport: { async send(req) { gesendet.push(req); return { ok: true }; } },
    credential: { async get() { return "synthetisches-testgeheimnis-0123456789"; } },
    tenant: F.TENANT, policyVersion: F.POLICY_VERSION,
    toolsEnabled: {},   // wie in C1: alle vier stehen auf false
  });
  await assert.rejects(() => client.call("run.ensure", { runKey: "quantus:2026-09-19:process09:3.0", slot: "process09", localDate: "2026-09-19" }),
    (e) => e.status === 503 && e.error === "tool_disabled" && e.detail.route === "quantus-ingest");
  assert.deepEqual(gesendet, [], "es ging nichts hinaus");
});

test("ein unbekannter Port und eine kaputte Nutzlast verlassen den Prozess nicht", async () => {
  const gesendet = [];
  const client = createToolClient({
    transport: { async send(req) { gesendet.push(req); return { ok: true }; } },
    credential: { async get() { return "synthetisches-testgeheimnis-0123456789"; } },
    tenant: F.TENANT, policyVersion: F.POLICY_VERSION,
    toolsEnabled: { quantus_command: true, quantus_context: true },
  });
  await assert.rejects(() => client.call("mail.send", {}), (e) => e.error === "tool_port_unknown");
  await assert.rejects(() => client.call("run.ensure", { runKey: "unsinn", slot: "process09", localDate: "2026-09-19" }),
    (e) => e.error === "tool_payload_invalid");
  // Eine Identitaetsbehauptung in der Nutzlast wird abgewiesen.
  await assert.rejects(() => client.call("run.ensure", { runKey: "quantus:2026-09-19:process09:3.0", slot: "process09", localDate: "2026-09-19", role: "admin" }),
    (e) => e.error === "server_controlled_field_in_payload");
  assert.deepEqual(gesendet, []);

  // Der erlaubte Aufruf geht durch — mit Rolle, Verb und Route aus dem Port.
  const ok = await client.call("run.ensure", { runKey: "quantus:2026-09-19:process09:3.0", slot: "process09", localDate: "2026-09-19" });
  assert.equal(ok.ok, true);
  assert.equal(gesendet.length, 1);
  assert.equal(gesendet[0].route, "quantus-ingest");
  assert.equal(gesendet[0].verb, "run.ensure");
  assert.equal(gesendet[0].role, "scheduler");
  assert.equal(gesendet[0].tenant, F.TENANT);
});

test("ohne Transport oder Zugangsdatum gibt es 503, keinen Versuch", async () => {
  const ohneTransport = createToolClient({ transport: null, credential: { async get() { return "x".repeat(40); } }, tenant: F.TENANT, policyVersion: F.POLICY_VERSION, toolsEnabled: { quantus_command: true } });
  await assert.rejects(() => ohneTransport.call("run.log", { runKey: "quantus:2026-09-19:process09:3.0", event: "start" }),
    (e) => e.status === 503 && e.detail.port === "toolTransport");
  const ohneGeheimnis = createToolClient({ transport: { async send() { throw new Error("darf nicht passieren"); } }, credential: { async get() { return null; } }, tenant: F.TENANT, policyVersion: F.POLICY_VERSION, toolsEnabled: { quantus_command: true } });
  await assert.rejects(() => ohneGeheimnis.call("run.log", { runKey: "quantus:2026-09-19:process09:3.0", event: "start" }),
    (e) => e.status === 503 && e.error === "tool_credential_missing");
});
