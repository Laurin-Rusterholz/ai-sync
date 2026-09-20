/*
 * Kompatibler Betriebsweg (Netlify Scheduled Function statt der nicht
 * ausgerollten Cloud-Run-Infrastruktur): tests/quantus-v3-daily-briefing.mjs
 * gegen den ECHTEN CAS-Pruefstand (dieselbe Technik wie
 * tests/quantus-v3-runtime-cost.test.mjs / quantus-v3-f-source-processing),
 * mit lokalen HTTP-Attrappen fuer Gmail/Anthropic — kein Netz, kein
 * bezahlter Aufruf, keine echten Zugangsdaten.
 *
 * Deckt genau das ab, was fuer einen echten Morgenlauf ohne Browser
 * zwingend ist: der Anthropic-Schluessel kommt NUR aus den bereits
 * synchronisierten Einstellungen (nie aus env, nie geloggt/zurueckgegeben),
 * die $50/Monat-Grenze blockiert VOR jedem Aufruf, zwei gleichzeitige
 * Zustellungen fuehren nie zu zwei Laeufen, und eine fehlende Quelle wird
 * ehrlich markiert statt Vollstaendigkeit zu behaupten.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { migrateCore } from "../netlify/lib/assistant-migration.mjs";
import { POLICY_TEMPLATE } from "../netlify/lib/assistant-schema.mjs";
import * as E1 from "../netlify/lib/quantus-v3-runtime-state.mjs";
import { createCasStore, casMutate } from "./quantus-v3-runtime-cas-harness.mjs";
import { runDailyBriefing, checkDailyBriefingConfig } from "../netlify/lib/quantus-v3-daily-briefing.mjs";
import { MONTHLY_CAP_MICROS } from "../runtime/quantus-v3/src/monthly-cost-cap.mjs";

const TENANT = "quantus";
const DATE = "2026-09-21";
const T0 = Date.parse("2026-09-21T02:05:00.000Z"); // kurz nach 04:00 Europe/Zurich (Sommerzeit)
const POLICY_JSON = JSON.stringify({ ...POLICY_TEMPLATE, tenant: TENANT, requiredSources: [{ id: "quantus-core", kind: "quantus-core" }, { id: "gmail", kind: "mail" }] });

// Dieselbe Preisreferenz wie QUANTUS_V3_ANTHROPIC_*_MICROS_PER_MTOK unten —
// ZWEI getrennte Vertraege (Tagesbriefing-Policy vs. Kostenrichtlinie),
// genau wie cost-adapter.mjs es voraussetzt.
function realCostPolicy(overrides = {}) {
  return {
    schema: "quantus-v3-cost-policy/1", version: "1", currency: "USD",
    approval: { approvedBy: "test", approvalRef: "t-1", approvedAtMs: T0 - 1000 },
    effectiveFromMs: T0 - 1000, effectiveUntilMs: T0 + 999_999_999,
    dayLimitMicros: 10_000_000, runLimitMicros: 5_000_000, callLimitMicros: 1_000_000,
    unresolvedBlockMicros: 5_000_000, featureFlags: { providers: "live" },
    models: { "anthropic:claude-sonnet-5": { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000, maxCallMicros: 1_000_000 } },
    ...overrides,
  };
}
function baseEnv(overrides = {}) {
  return {
    QUANTUS_V3_ANTHROPIC_MODEL: "claude-sonnet-5",
    QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK: "2000000",
    QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK: "10000000",
    QUANTUS_V3_TENANT: TENANT,
    QUANTUS_V3_TAGESBRIEFING_POLICY_JSON: POLICY_JSON,
    QUANTUS_V3_COST_POLICY_JSON: JSON.stringify(realCostPolicy()),
    ...overrides,
  };
}
function envReadFrom(env) { return (name) => env[name]; }

function startHttp(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}
function sendJson(res, status, obj) { const body = JSON.stringify(obj); res.writeHead(status, { "content-type": "application/json" }); res.end(body); }

function gmailServer({ ids = ["m1"], messages = {} } = {}) {
  return startHttp(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/users/me/messages") return sendJson(res, 200, { messages: ids.map((id) => ({ id })), nextPageToken: null });
    const m = url.pathname.match(/^\/users\/me\/messages\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      return sendJson(res, 200, messages[id] || { id, threadId: id, internalDate: String(T0), snippet: "leer", payload: { headers: [] } });
    }
    sendJson(res, 404, { error: "not_found" });
  });
}
function anthropicServer({ captured = [], text = "Zusammenfassung des Tages." } = {}) {
  return startHttp(async (req, res) => {
    const body = await readJson(req);
    captured.push(body);
    sendJson(res, 200, { id: "msg_1", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 50 } });
  });
}

function seedCore({ anthropicApiKey = "sk-ant-test-key-not-real" } = {}) {
  const migrated = migrateCore({ entities: {} }, { now: T0 }).data;
  migrated._settings = { anthropicApiKey };
  return migrated;
}
function fakeCoreAccess(store) {
  return {
    mutateCore: async (key, mutator) => casMutate(store, mutator),
    readCore: async () => {
      const snap = store.read();
      const parsed = snap.text ? JSON.parse(snap.text) : null;
      return { exists: parsed != null, parsed, etag: null, serverEtag: snap.etag };
    },
  };
}

// ── Preflight: nur Namen, nie Werte ───────────────────────────────────────
test("checkDailyBriefingConfig meldet fehlende Namen, nie Werte", () => {
  const ohne = checkDailyBriefingConfig(envReadFrom({}));
  assert.equal(ohne.ok, false);
  assert.ok(ohne.missing.includes("QUANTUS_V3_ANTHROPIC_MODEL"));
  assert.ok(ohne.missing.includes("QUANTUS_V3_TAGESBRIEFING_POLICY_JSON"));
  const mit = checkDailyBriefingConfig(envReadFrom(baseEnv()));
  assert.equal(mit.ok, true, JSON.stringify(mit));
});

// ── Erfolgspfad: echter Entwurf, echte Kostenabrechnung, Wasserzeichen ────
test("ein vollstaendig konfigurierter Lauf liest Gmail, sendet an Sonnet und speichert den echten Entwurf", async (t) => {
  const gmail = await gmailServer({ ids: ["m1"] });
  const captured = [];
  const anthropic = await anthropicServer({ captured, text: "Eindeutiger Testentwurf 9f2a." });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({
    now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore,
    gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0,
  });
  assert.equal(ergebnis.ok, true, JSON.stringify(ergebnis));
  assert.equal(ergebnis.drafted, true, JSON.stringify(ergebnis));
  assert.equal(captured.length, 1, "Sonnet haette genau einmal aufgerufen werden muessen");

  const data = store.snapshot();
  // DASSELBE Id-Schema wie section-work.mjs/renderV3AutomationStatus()
  // erwartet ("v3-draft:<tenant>:<date>:<slot>:<policyVersion>") — sonst
  // wuerde der Entwurf in der bestehenden DailyBriefing-Anzeige nicht
  // gefunden.
  const runKey = `${TENANT}:${DATE}:briefing04:${POLICY_TEMPLATE.version}`;
  const note = data.entities.chatgptNotes[`v3-draft:${runKey}`];
  assert.ok(note, `die Notiz muss unter dem UI-kompatiblen Id-Schema stehen: ${JSON.stringify(Object.keys(data.entities.chatgptNotes))}`);
  assert.match(note.instruction, /Eindeutiger Testentwurf 9f2a\./, JSON.stringify(note));
  const call = data.automation.runtime.cost.callsById[`daily:${DATE}`];
  assert.equal(call.state, "settled", JSON.stringify(call));
  assert.equal(data.automation.activeLease, null, "die Pacht muss nach dem Lauf wieder frei sein");
  const check = data.dailyBriefing.assistantRuns[DATE].sourceChecks.gmail;
  assert.equal(check.outcome, "ok");
  assert.ok(JSON.parse(check.cursor).sinceMs, "das Wasserzeichen muss nach einem gelungenen Entwurf vorruecken");
});

// ── Schluessel kommt NUR aus den synchronisierten Einstellungen ───────────
test("ohne in den Einstellungen hinterlegten Anthropic-Schluessel wird ehrlich blockiert, kein Aufruf versucht", async (t) => {
  const gmail = await gmailServer({ ids: ["m1"] });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore({ anthropicApiKey: "" }));
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({ now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore, gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0 });
  assert.equal(ergebnis.ok, false);
  assert.equal(ergebnis.blocked, "anthropic_key_not_configured");
  assert.equal(captured.length, 0, "ohne Schluessel darf Sonnet gar nicht erst kontaktiert werden");
});

// ── $50/Monat-Grenze blockiert VOR jedem Aufruf ───────────────────────────
function seedCostPolicy() {
  return {
    schema: "quantus-v3-cost-policy/1", version: "seed-1", fixture: true, currency: "USD",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: T0 - 86_400_000 },
    effectiveFromMs: T0 - 3_600_000, effectiveUntilMs: T0 + 90 * 86_400_000,
    dayLimitMicros: 1_000_000_000, runLimitMicros: 1_000_000_000, callLimitMicros: 20_000_000,
    unresolvedBlockMicros: 1_000_000_000, featureFlags: { providers: "live" },
    // DIESELBEN Preise wie baseEnv() (2 USD/Mio. Input-Token) — der Sitz
    // dieses Tests haengt nicht an der echten QUANTUS_V3_COST_POLICY_JSON
    // (die es fuer diesen Betriebsweg gar nicht braucht), nur am Ledger.
    models: { "anthropic:claude-sonnet-5": { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 0, maxCallMicros: 20_000_000 } },
  };
}
test("die $50/Monat-Grenze blockiert den Aufruf, BEVOR Sonnet kontaktiert wird", async (t) => {
  const gmail = await gmailServer({ ids: ["m1"] });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const seedNow = T0 - 120_000; // laengst abgelaufen, bevor runDailyBriefing seine eigene Pacht holt
  const seedScope = `${TENANT}:netlify-daily-briefing`;
  const acq = casMutate(store, (d) => E1.acquireLease(d, { holder: "seed", scope: seedScope, ttlMs: 60_000, now: seedNow }));
  assert.equal(acq.result.ok, true, JSON.stringify(acq.result));
  const verified = { holder: "seed", fence: acq.result.fence, scope: seedScope };
  // Genau $50.00 vorbelegt, ueber drei Reservierungen (Einzelaufrufgrenze
  // 10 Mio. Token): $20 + $20 + $10.
  for (const [i, tokens] of [10_000_000, 10_000_000, 5_000_000].entries()) {
    const r = casMutate(store, (d) => E1.reserveCost(d, {
      callId: `seed-${i}`, runKey: `${TENANT}:${DATE}:briefing04:seed-1`, provider: "anthropic", model: "claude-sonnet-5",
      contentHash: `seedhash${String(i).padStart(24, "0")}`, inputTokens: tokens, outputTokens: 0,
      now: seedNow, verifiedScope: verified, policy: seedCostPolicy(), __allowFixturePolicy: true,
    }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
  }

  const { mutateCore, readCore } = fakeCoreAccess(store);
  // Tages-/Laufgrenze bewusst grosszuegig: dieser Test isoliert GENAU die
  // NEUE Monatsgrenze, nicht die vorbestehende Tagesgrenze (die bei $50
  // vorbelegtem Ledger sonst zuerst greifen wuerde).
  const env = baseEnv({ QUANTUS_V3_COST_POLICY_JSON: JSON.stringify(realCostPolicy({ dayLimitMicros: 1_000_000_000, runLimitMicros: 1_000_000_000 })) });
  const ergebnis = await runDailyBriefing({ now: T0, envRead: envReadFrom(env), mutateCore, readCore, gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0 });
  assert.equal(ergebnis.ok, false, JSON.stringify(ergebnis));
  assert.match(ergebnis.blocked, /^reserve:monthly_budget_exceeded/, JSON.stringify(ergebnis));
  assert.equal(captured.length, 0, "ueber der Monatsgrenze darf Sonnet gar nicht erst kontaktiert werden");
  // Der Quellenbeleg selbst (Gmail wurde ja gelesen) bleibt trotzdem ehrlich stehen.
  assert.equal(store.snapshot().dailyBriefing.assistantRuns[DATE].sourceChecks.gmail.outcome, "ok");
});

// ── Duplikatschutz: zwei gleichzeitige Zustellungen fuehren nie zu zwei Laeufen ──
test("zwei gleichzeitige Zustellungen fuehren zu genau EINEM Lauf, keinem doppelten Aufruf", async (t) => {
  const gmail = await gmailServer({ ids: ["m1"] });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const [erste, zweite] = await Promise.all([
    runDailyBriefing({ now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore, gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0 }),
    runDailyBriefing({ now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore, gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0 }),
  ]);
  const ergebnisse = [erste, zweite];
  const uebersprungen = ergebnisse.filter((e) => e.skipped === "duplicate_delivery");
  const durchgefuehrt = ergebnisse.filter((e) => e.ok && e.drafted === true);
  assert.equal(durchgefuehrt.length, 1, `genau EIN Lauf haette wirklich arbeiten duerfen: ${JSON.stringify(ergebnisse)}`);
  assert.equal(uebersprungen.length + durchgefuehrt.length, 2);
  assert.equal(captured.length, 1, "Sonnet darf trotz zweier gleichzeitiger Zustellungen nur einmal kontaktiert werden");
});

// ── Fehlende Quelle wird ehrlich markiert, nie Vollstaendigkeit erfunden ──
test("eine leere Gmail-Antwort (kein neuer Inhalt) markiert die Quelle ehrlich, ohne einen Entwurf zu erfinden", async (t) => {
  const gmail = await gmailServer({ ids: [] });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({ now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore, gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0 });
  assert.equal(ergebnis.ok, true, JSON.stringify(ergebnis));
  assert.equal(ergebnis.drafted, false, "ohne Nachrichten darf kein Entwurf erfunden werden");
  assert.equal(captured.length, 0, "ohne Quellinhalt wird Sonnet gar nicht erst kontaktiert");
  assert.equal(store.snapshot().dailyBriefing.assistantRuns[DATE].sourceChecks.gmail.outcome, "ok");
});

// ── Review 7f614a8, Befund 1: eine lange Gmail-Abfrage darf die Pacht nicht
// stillschweigend als noch gueltig behaupten — die Pacht wird nach dem Scan
// mit einer FRISCHEN Uhr verlaengert, und spaetere Schritte pruefen erneut
// frisch. ──────────────────────────────────────────────────────────────
test("Befund 1: die Pacht wird nach einem langen Scan verlaengert — spaetere Schritte, die die urspruengliche Frist ueberschritten haetten, gelingen trotzdem", async (t) => {
  let simTime = T0;
  const clock = () => simTime;
  const gmail = await startHttp(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/users/me/messages") return sendJson(res, 200, { messages: [{ id: "m1" }], nextPageToken: null });
    const m = url.pathname.match(/^\/users\/me\/messages\/(.+)$/);
    if (m) {
      simTime += 80_000; // der Scan selbst verbraucht 80s der urspruenglichen 120s-Pacht
      return sendJson(res, 200, { id: "m1", threadId: "m1", internalDate: String(T0), snippet: "leer", payload: { headers: [] } });
    }
    sendJson(res, 404, {});
  });
  const captured = [];
  const anthropic = await startHttp(async (req, res) => {
    const body = await readJson(req);
    captured.push(body);
    simTime += 90_000; // die Sendung selbst dauert weitere 90s — zusammen 170s, MEHR als die urspruengliche 120s-Frist
    sendJson(res, 200, { id: "msg_1", content: [{ type: "text", text: "Zusammenfassung." }], usage: { input_tokens: 500, output_tokens: 50 } });
  });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({
    now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore,
    gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock,
  });
  // 170s Gesamtlaufzeit haetten die URSPRUENGLICHE 120s-Pacht klar
  // ueberschritten — nur die Verlaengerung nach dem Scan (bei 80s, also
  // noch rechtzeitig) macht den Rest ueberhaupt moeglich.
  assert.equal(ergebnis.ok, true, `die verlaengerte Pacht haette den Lauf trotz 170s Gesamtlaufzeit tragen muessen: ${JSON.stringify(ergebnis)}`);
  assert.equal(ergebnis.drafted, true, JSON.stringify(ergebnis));
  assert.equal(captured.length, 1);
});

test("Befund 1: eine Pacht, die schon WAEHREND des Scans wirklich ablaeuft, wird ehrlich als verloren gemeldet, nicht stillschweigend weiterverwendet", async (t) => {
  let simTime = T0;
  const clock = () => simTime;
  const gmail = await startHttp(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/users/me/messages") return sendJson(res, 200, { messages: [{ id: "m1" }], nextPageToken: null });
    const m = url.pathname.match(/^\/users\/me\/messages\/(.+)$/);
    if (m) {
      simTime += 130_000; // laenger als die volle 120s-Pacht — sie ist beim naechsten Schritt WIRKLICH abgelaufen
      return sendJson(res, 200, { id: "m1", threadId: "m1", internalDate: String(T0), snippet: "leer", payload: { headers: [] } });
    }
    sendJson(res, 404, {});
  });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({
    now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore,
    gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock,
  });
  assert.equal(ergebnis.ok, false, "eine wirklich abgelaufene Pacht darf NIE als noch gueltig behandelt werden: " + JSON.stringify(ergebnis));
  assert.match(ergebnis.blocked, /^lease_lost_during_scan/, JSON.stringify(ergebnis));
  assert.equal(captured.length, 0, "ohne gueltige Pacht darf Sonnet gar nicht erst kontaktiert werden");
});

// ── Befund 2: strikt positive Preise ──────────────────────────────────────
test("Befund 2: ein leerer, nullwertiger oder negativer Modellpreis gilt als NICHT konfiguriert", () => {
  for (const kaputterPreis of ["", "0", "-1", "-2000000"]) {
    const env = baseEnv({ QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK: kaputterPreis });
    const status = checkDailyBriefingConfig(envReadFrom(env));
    assert.equal(status.ok, false, `Preis "${kaputterPreis}" haette abgelehnt werden muessen`);
    assert.ok(status.missing.includes("QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK"), JSON.stringify(status));
  }
});

// ── Befund 3+4: realistische Mengenbegrenzung, explizit `partial` ─────────
test("Befund 3+4: ueber dem Mengenlimit werden keine weiteren Nachrichten abgerufen, und der Ausgang ist ausdruecklich 'partial'", async (t) => {
  const ids1 = Array.from({ length: 25 }, (_, i) => `m${i + 1}`);
  const ids2 = Array.from({ length: 20 }, (_, i) => `m${i + 26}`);
  let getMessageAufrufe = 0;
  const gmail = await startHttp(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/users/me/messages") {
      const seite = url.searchParams.get("pageToken") ? { ids: ids2, next: null } : { ids: ids1, next: "p2" };
      return sendJson(res, 200, { messages: seite.ids.map((id) => ({ id })), nextPageToken: seite.next });
    }
    const m = url.pathname.match(/^\/users\/me\/messages\/(.+)$/);
    if (m) {
      getMessageAufrufe++;
      return sendJson(res, 200, { id: decodeURIComponent(m[1]), threadId: "x", internalDate: String(T0), snippet: "leer", payload: { headers: [] } });
    }
    sendJson(res, 404, {});
  });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore());
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({
    now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore,
    gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0,
  });
  assert.equal(ergebnis.ok, true, JSON.stringify(ergebnis));
  assert.equal(ergebnis.sourceOutcome, "partial", `45 Nachrichten bei einem Mengenlimit von 40 duerfen NIE 'ok' ergeben: ${JSON.stringify(ergebnis)}`);
  assert.equal(getMessageAufrufe, 40, `es duerfen genau 40 getMessage()-Aufrufe erfolgen (das Limit), nicht 45: tatsaechlich ${getMessageAufrufe}`);
  const check = store.snapshot().dailyBriefing.assistantRuns[DATE].sourceChecks.gmail;
  assert.equal(check.outcome, "partial");
});

// ── Befund 5: ehrlicher Quellenstatus bleibt sichtbar, auch ohne Schluessel ──
test("Befund 5: ohne Anthropic-Schluessel wird trotzdem ein ehrlicher Gmail-Quellenstatus fuer heute gespeichert", async (t) => {
  const gmail = await gmailServer({ ids: ["m1"] });
  const captured = [];
  const anthropic = await anthropicServer({ captured });
  t.after(async () => { await gmail.close(); await anthropic.close(); });

  const store = createCasStore(seedCore({ anthropicApiKey: "" }));
  const { mutateCore, readCore } = fakeCoreAccess(store);
  const ergebnis = await runDailyBriefing({
    now: T0, envRead: envReadFrom(baseEnv()), mutateCore, readCore,
    gmailApiBase: gmail.base, anthropicApiBase: anthropic.base, getGmailToken: async () => ({ token: "test-token" }), clock: () => T0,
  });
  assert.equal(ergebnis.ok, false);
  assert.equal(ergebnis.blocked, "anthropic_key_not_configured");
  assert.equal(captured.length, 0, "ohne Schluessel darf Sonnet gar nicht erst kontaktiert werden");
  const check = store.snapshot().dailyBriefing.assistantRuns[DATE].sourceChecks.gmail;
  assert.ok(check, "der Gmail-Quellenstatus muss trotzdem gespeichert sein — 'kein Schluessel' heisst nicht 'gar nichts sichtbar'");
  assert.equal(check.outcome, "ok", JSON.stringify(check));
});
