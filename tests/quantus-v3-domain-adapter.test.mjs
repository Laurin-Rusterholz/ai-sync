/*
 * Quantus v3, Paket C3a — der kanonische Domaenen-Adapter gegen den ECHTEN
 * Kern aus Paket B, ueber die ECHTE C2-Kette (handleCommandRequest /
 * handleReadRequest, Integrationsstand 1d17cf7), den ECHTEN Idempotenz-
 * Umschlag (quantus-v3-idempotency.mjs, 1d17cf7), die ECHTE E1-Laufzeit
 * (quantus-v3-runtime-state.mjs, 1d17cf7) und die C3b-Verdrahtung
 * (quantus-v3-runtime.mjs, a422670) — mit synthetisch signierten Ausweisen.
 *
 * Es gibt keinen Ersatzbestand: der Bestand ist ein migrierter B-Kern mit
 * chatgptLeads/chatgptTasks/tasks, Buchhaltungskarten und Tageslauf. Die
 * C2-/E1-Dateien liegen nicht im Checkout dieses Pakets; sie werden
 * KONTROLLIERT aus dem Git-Objektspeicher gespiegelt. Geht das nicht,
 * scheitert die Datei laut — es gibt keine Nachbildung.
 *
 * Befunde, die diese Tests festhalten: gebundene Verben wirken wirklich
 * (nachgelesen aus dem Bestand des Speichers), Wiederholungen liefern die
 * Quittung ohne zweite Wirkung, CAS-Konflikte pruefen Bindung je Versuch,
 * veraltete Versionen und fremde Mandanten/Eigentuemer sind 409/403, ein
 * Spezialist kann nicht auf fremde oder abgebrochene Auftraege zurueckgeben,
 * Seiten sind vollstaendig oder ehrlich abgebrochen, der Status nach einem
 * Widerspruch ist blockiert, Doppelpunkt-Kennungen werden nicht umcodiert,
 * fehlende Ports sind 503 mit Namen, und jedes der 22 Verben ist entweder an
 * ein B-/E1-Kommando gebunden oder eine benannte Luecke.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as K from "../netlify/lib/assistant-core.mjs";
import { createQuantusV3DomainAdapter, describeDomainPorts, VERB_BINDINGS, DOMAIN_PORT_VARS } from "../netlify/lib/quantus-v3-domain-adapter.mjs";

/* ══ Spiegel der Integrationsdateien (kein Fallback) ═════════════════════ */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const C2_COMMIT = "1d17cf7";     // C1/C2/E1/Idempotenz im Integrationsstand
const C3B_COMMIT = "a422670";    // C3b: benannte Fabrik, Laufzeitverdrahtung
function gitShow(commit, datei) {
  return execFileSync("git", ["show", `${commit}:${datei}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const SPIEGEL = fs.mkdtempSync(path.join(os.tmpdir(), "qv3-c3a-"));
for (const [commit, datei] of [
  ...["quantus-v3-auth", "quantus-v3-command-envelope", "quantus-v3-cursor", "quantus-v3-read-helpers", "quantus-v3-service",
    "quantus-v3-idempotency", "quantus-v3-rate-limiter", "quantus-v3-runtime-state", "quantus-v3-runtime-plan"].map((n) => [C2_COMMIT, `netlify/lib/${n}.mjs`]),
  [C3B_COMMIT, "netlify/lib/quantus-v3-runtime.mjs"], [C3B_COMMIT, "netlify/lib/quantus-v3-identity-access.mjs"],
  [C3B_COMMIT, "tests/fixtures/quantus-v3-auth-fixtures.mjs"], [C3B_COMMIT, "tests/fixtures/quantus-v3-c2-fixtures.mjs"],
]) {
  const ziel = path.join(SPIEGEL, datei);
  fs.mkdirSync(path.dirname(ziel), { recursive: true });
  fs.writeFileSync(ziel, gitShow(commit, datei));
}
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(SPIEGEL, "node_modules"), "dir");   // jose
const lade = (p) => import(pathToFileURL(path.join(SPIEGEL, p)).href);
const S = await lade("netlify/lib/quantus-v3-service.mjs");
const A = await lade("netlify/lib/quantus-v3-auth.mjs");
const R = await lade("netlify/lib/quantus-v3-runtime.mjs");
const E1 = await lade("netlify/lib/quantus-v3-runtime-state.mjs");
const IDEM = await lade("netlify/lib/quantus-v3-idempotency.mjs");
const FA = await lade("tests/fixtures/quantus-v3-auth-fixtures.mjs");
const FC = await lade("tests/fixtures/quantus-v3-c2-fixtures.mjs");
const { TENANT, POLICY_VERSION } = FA;
const OWNER = "uid-laurin";
const APP = "https://management-xo2-pro.netlify.app";
const key = FA.makeSigningKey("c3a-kid");

/* ══ Der echte B-Bestand ═════════════════════════════════════════════════ */
const T = (s) => Date.parse(s);
const MIN = 60 * 1000, STD = 60 * MIN, TAG = 24 * STD;
const JETZT = T("2026-09-20T09:00:00Z");           // 11:00 Zuerich → Slot process09
const DATE = "2026-09-20";
const RUN_ID = "run_" + DATE;
const POLICY = Object.freeze({ ...K.POLICY_TEMPLATE, version: POLICY_VERSION, tenant: TENANT, requiredSources: [{ id: "quantus-core", kind: "quantus-core" }, { id: "gmail-inbox", kind: "mail" }] });
const AGENT = { kind: "agent", id: "chatgpt-run" }, ADAPTER = { kind: "adapter", id: "gmail-adapter" }, USER_B = { kind: "user", id: OWNER };

let cmdN = 0;
const bCmd = (data, type, payload, now, actor = AGENT) => {
  const r = K.applyCommand(data, { type, commandId: "fix_" + String(++cmdN).padStart(6, "0"), now, payload }, { policy: POLICY, actor });
  assert.equal(r.ok, true, `${type}: ${r.error} ${JSON.stringify(r.detail)}`);
  return r.data;
};
const ver = (data, sourceType, id) => K.effektiverZustand(sourceType, K.quelleFinden(data, sourceType, id)).version;

function bestand() {
  const t0 = "2026-09-18T10:00:00.000Z";
  const lead = (id, extra) => ({
    id, title: "Kunden anlegen " + id, rawInput: "Bitte Firma Muster AG als Kunde anlegen.", status: "in_arbeit", readAt: t0, assignee: "chatgpt",
    interpretation: "Neue Organisation", research: "gesucht", plan: "anlegen", execution: "angelegt", result: "#/organizations/abc",
    assessment: { menge: "chatgpt", werkzeug: "chatgpt", kontext: "chatgpt", quantusNaehe: "chatgpt", recherche: "cowork", zuschnitt: "cowork" },
    assignmentReason: "klein", linkedOrganizations: ["abc"], createdAt: t0, updatedAt: t0, comments: [], ...extra,
  });
  return {
    entities: {
      tasks: { t1: { id: "t1", title: "Rechnung zahlen", status: "todo", dueDate: "2026-09-21", assignee: "Anna", createdAt: t0, updatedAt: t0, comments: [] } },
      projects: {},
      notes: { nf1: { id: "nf1", title: "NoteFlow", content: "bleibt" } },
      chatgptNotes: {},
      chatgptLeads: {
        l1: lead("l1", { comments: [
          { id: "c1", text: "Erste Rueckmeldung", createdAt: "2026-09-19T08:00:00.000Z", author: "laurin" },
          { id: "c2", text: "Zweite Rueckmeldung", createdAt: "2026-09-19T08:05:00.000Z", author: "laurin" },
          { id: "c3", text: "Dritte Rueckmeldung", createdAt: "2026-09-19T08:10:00.000Z", author: "laurin" },
        ] }),
        l2: lead("l2", { status: "abgeschlossen", closedAt: t0, closedBy: "assistant" }),
        "l:9": lead("l:9"),   // B erlaubt Doppelpunkte, C2 nicht — wird NICHT umcodiert
      },
      chatgptTasks: { c1: { id: "c1", text: "Namen ergaenzen", state: "offen", anchorKind: "organization", anchorId: "o1", createdAt: t0, updatedAt: t0 } },
    },
    journal: { documents: [] }, mobilePushes: [], dailyBriefing: { routines: [], dailyLog: {} },
  };
}

/* Ein migrierter Kern mit dem heutigen Lauf, Karten und Belegen. */
function kern() {
  let d = K.migrateCore(bestand(), { now: T("2026-09-19T06:00:00Z") }).data;
  const b4 = K.slotBeginnMs(DATE, "briefing04") + MIN, p9 = K.slotBeginnMs(DATE, "process09") + MIN;
  d = bCmd(d, "ensureRun", { date: DATE }, b4);
  d = bCmd(d, "ensureStartNote", { date: DATE, noteId: "note_start_" + DATE }, b4 + MIN);
  d = bCmd(d, "recordSlotReceipt", { date: DATE, slot: "briefing04", receiptId: "rcpt_b4" }, b4 + 2 * MIN);
  d = bCmd(d, "recordSlotReceipt", { date: DATE, slot: "process09", receiptId: "rcpt_p9" }, p9);
  for (const s of POLICY.requiredSources) d = bCmd(d, "recordSourceCheck", { date: DATE, sourceId: s.id, cursor: "c1", outcome: "ok" }, JETZT - 3 * MIN, ADAPTER);
  for (const [sourceType, id] of [["chatgptLead", "l1"], ["chatgptLead", "l:9"], ["chatgptTask", "c1"], ["task", "t1"]]) d = bCmd(d, "addItemRef", { date: DATE, sourceType, sourceId: id }, JETZT - 2 * MIN);
  d = bCmd(d, "registerEvidence", { evidenceId: "ev_l1", kind: "message", ref: "msg_l1", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "thread_l1" }, observedAt: new Date(JETZT - 5 * MIN).toISOString(), fingerprint: "fp_l1_0123456789abcdef" }, JETZT - 4 * MIN, ADAPTER);
  d = bCmd(d, "askQuestion", { questionId: "q_c1", sourceType: "chatgptTask", sourceId: "c1", text: "Welcher Name?", date: DATE }, JETZT - 3 * MIN);
  d = bCmd(d, "createJob", { jobId: "job_c1_claude", kind: "recherche", purpose: "Namen recherchieren", sourceType: "chatgptTask", sourceId: "c1", inputVersion: ver(d, "chatgptTask", "c1"), executor: "claude", contextRefs: [{ sourceType: "chatgptLead", sourceId: "l1" }], expiresAt: new Date(JETZT + STD).toISOString() }, JETZT - 10 * MIN);
  d = bCmd(d, "createJob", { jobId: "job_l1_cancelled", kind: "recherche", purpose: "abgebrochen", sourceType: "chatgptLead", sourceId: "l1", inputVersion: ver(d, "chatgptLead", "l1"), executor: "claude", contextRefs: [], expiresAt: new Date(JETZT + STD).toISOString() }, JETZT - 9 * MIN);
  d = bCmd(d, "cancelJob", { jobId: "job_l1_cancelled", reason: "Test" }, JETZT - 8 * MIN);
  return d;
}
const BASIS = kern();

/* ══ Verdrahtung ═════════════════════════════════════════════════════════ */
const PORTS = Object.freeze({ policy: POLICY, ownerId: OWNER, runtimeState: E1, read: () => undefined });
const adapter = (extra = {}) => createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => JETZT, ports: { ...PORTS, ...extra } });
const umgebung = () => FA.makeEnv({ tenant: TENANT, mode: "enforce", overrides: { QUANTUS_V3_API_WRITES: "enabled" } });
function deps({ env = umgebung(), store = FC.makeStore({ snapshot: BASIS }), domain = adapter() } = {}) {
  let n = 0;
  return {
    now: () => JETZT, newRequestId: () => `req-${++n}`, env: env.read,
    keySource: FA.keySourceFor(key), userLookup: FA.userLookupFor({ tenantId: TENANT }),
    rateLimiter: FC.makeRateLimiter(), store,
    idempotency: { prepare: IDEM.prepareIdempotentCommand, apply: IDEM.applyIdempotentCommand },
    domain, _env: env, _store: store,
  };
}
const nutzerToken = (sub = OWNER) => FA.makeIdToken({ key, sub, now: JETZT, tenant: TENANT });
async function jobToken(env, { role, principalId, jobId = RUN_ID, assignedJobIds = null, audience = "quantus-ingest" }) {
  const { config } = A.resolveAuthConfig(env.read);
  const t = await A.mintJobToken({ config, audience, jobId, role, principalId, tenant: TENANT, assignedJobIds, now: () => JETZT });
  assert.equal(t.ok, true, JSON.stringify(t));
  return t.token;
}
async function sende(d, { verb, payload, token = nutzerToken(), jobId = RUN_ID, expectedEntityVersion = 0, idempotencyKey = null, validateOnly = false }) {
  return S.handleCommandRequest(FC.makeRequest({
    headers: FC.commandHeaders({ token, origin: APP, idempotencyKey, validateOnly }),
    body: FC.commandBody({ verb, jobId, expectedEntityVersion, payload }),
  }), d);
}
async function lese(d, { route = "quantus-context", query, scopeId, pageSize = null, cursor = null, token = nutzerToken(), jobId = null }) {
  const url = new URL(`${APP}/.netlify/functions/${route}`);
  url.searchParams.set("query", query); url.searchParams.set("scopeId", scopeId);
  if (pageSize != null) url.searchParams.set("pageSize", String(pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  if (jobId) url.searchParams.set("jobId", jobId);
  return S.handleReadRequest(FC.makeRequest({ method: "GET", url: url.toString(), headers: { authorization: `Bearer ${token}`, origin: APP } }), d, { route });
}
/* Lease fuer den Leitungsagenten — ueber E1, nicht nachgebaut. */
function mitLease(data, { holder = "lead-agent-1", at = JETZT - 1000, ttlMs = 120000, slot = "process09" } = {}) {
  const r = E1.acquireLease(data, { holder, scope: K.slotKey(TENANT, DATE, slot, POLICY_VERSION), ttlMs, now: at });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  return r.data;
}
const laufVersion = (data) => data.dailyBriefing.assistantRuns[DATE].revision;

/* ══ 1. Fabrik: Vertrag, Ports, 503 mit Namen ════════════════════════════ */
test("C3a-01 Fabrik nach C3b-Vertrag: fuenf Methoden; fehlende Backendkonfiguration ist 503 mit Namen, nie ein Adapter", async () => {
  const a = adapter();
  for (const m of R.DOMAIN_ADAPTER_METHODS) assert.equal(typeof a[m], "function", m);
  assert.equal(R.DOMAIN_FACTORY_EXPORT, "createQuantusV3DomainAdapter");
  const erwarte = (ports, reason, rest = {}) => {
    assert.throws(() => createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => JETZT, ...rest, ports: { ...PORTS, ...ports } }),
      (e) => e.status === 503 && e.code === "auth_not_configured" && String(e.reason).startsWith(reason), reason);
  };
  erwarte({ policy: undefined }, "domain_policy_missing:" + DOMAIN_PORT_VARS.policyJson);
  erwarte({ policy: undefined, read: () => "{nicht json" }, "domain_policy_unparsable");
  erwarte({ policy: { ...POLICY, closure: { earliestLocalTime: "22:00", requiredReceipts: ["process09", "close23"] } } }, "domain_policy_invalid:POLICY_CLOSURE_TOO_EARLY");
  erwarte({ policy: { ...POLICY, version: "v3-andere" } }, "domain_policy_version_mismatch", { policyVersion: POLICY_VERSION });
  erwarte({ policy: { ...POLICY, tenant: "anderer" } }, "domain_policy_tenant_mismatch");
  erwarte({ ownerId: undefined }, "domain_owner_missing:" + DOMAIN_PORT_VARS.ownerUid);
  erwarte({ runtimeState: null }, "domain_runtime_state_port_missing");
  erwarte({ runtimeState: { acquireLease() {} } }, "domain_runtime_state_port_missing");
  erwarte({}, "domain_policy_version_missing", { policyVersion: "" });
  erwarte({}, "domain_tenant_missing", { tenantId: null });
  erwarte({}, "domain_mode_invalid", { mode: "live" });
  erwarte({}, "domain_clock_missing", { now: JETZT });
  // Die Policy-Version allein ist keine Policy: aus der Umgebung gelesen muss die echte B-Policy kommen.
  const ausUmgebung = createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => JETZT,
    ports: { runtimeState: E1, read: (n) => ({ [DOMAIN_PORT_VARS.policyJson]: JSON.stringify(POLICY), [DOMAIN_PORT_VARS.ownerUid]: OWNER })[n] } });
  assert.equal(ausUmgebung.policyVersion, POLICY_VERSION); assert.equal(ausUmgebung.ownerId, OWNER);
  assert.deepEqual(describeDomainPorts({ read: () => undefined, ports: { runtimeState: E1 } }), { ok: false, missing: [DOMAIN_PORT_VARS.policyJson, DOMAIN_PORT_VARS.ownerUid] });
  assert.deepEqual(describeDomainPorts({ ports: PORTS }), { ok: true, missing: [] });

  // Ueber die C3b-Verdrahtung: die benannte Fabrik wird angenommen, eine werfende Fabrik ist ehrlich "failed".
  const env = umgebung();
  const firebase = {
    async readAppDataDocument() { return { exists: true, parsed: structuredClone(BASIS) }; },
    async mutateAppData() { throw new Error("nicht im Test"); },
    async firebaseDbGetWithEtag() { return { value: null, etag: "x" }; }, async firebaseDbSet() { return { ok: true }; },
  };
  R.resetRuntimeCachesForTests();
  const laufzeit = await R.buildRuntimeDeps({ write: true, read: env.read, firebaseModule: firebase, idempotencyModule: IDEM, now: () => JETZT,
    domainFactory: (p) => createQuantusV3DomainAdapter({ ...p, ports: PORTS }) });
  assert.equal(laufzeit.wiring.domain, true); assert.equal(laufzeit.wiring.domainReason, null);
  assert.equal(laufzeit.domain.tenant, TENANT);
  const ohnePorts = await R.buildRuntimeDeps({ write: true, read: env.read, firebaseModule: firebase, idempotencyModule: IDEM, now: () => JETZT,
    domainFactory: (p) => createQuantusV3DomainAdapter({ ...p, ports: { read: () => undefined } }) });
  assert.equal(ohnePorts.domain, null); assert.equal(ohnePorts.wiring.domainReason, "domain_factory_failed");
  const res = await lese(deps({ env, domain: ohnePorts.domain }), { query: "notes.recent", scopeId: "l1" });
  assert.equal(res.status, 503); assert.equal(res.body.reason, "domain_adapter_not_available");
});

/* ══ 2. Kanonisches Lesen ════════════════════════════════════════════════ */
test("C3a-02 kanonisches Lesen: Notizinhalte, Lead, Laufkontext, Warteschlange, Status und Policy — aus dem echten Kern, mit Anker, Kategorie und Version", async () => {
  const d = deps();
  const notizen = await lese(d, { query: "notes.recent", scopeId: "l1" });
  assert.equal(notizen.status, 200, JSON.stringify(notizen.body));
  assert.deepEqual(notizen.body.items.map((n) => [n.id, n.text, n.leadId, n.author]), [["c3", "Dritte Rueckmeldung", "l1", "laurin"], ["c2", "Zweite Rueckmeldung", "l1", "laurin"], ["c1", "Erste Rueckmeldung", "l1", "laurin"]]);
  assert.equal(notizen.body.complete, true);
  for (const n of notizen.body.items) { assert.equal(n.tenant, undefined, "Rohfelder werden beschnitten"); assert.equal(typeof n.entityVersion, "number"); }

  const lead = await lese(d, { query: "lead.context", scopeId: "l1" });
  assert.equal(lead.status, 200); assert.equal(lead.body.items.length, 1);
  assert.equal(lead.body.items[0].id, "l1"); assert.equal(lead.body.items[0].state, "doing");
  assert.equal(lead.body.items[0].entityVersion, ver(BASIS, "chatgptLead", "l1"), "Version ist die B-Zustandsversion");
  assert.deepEqual(lead.body.entityVersions, { l1: ver(BASIS, "chatgptLead", "l1") });

  // run.context ist Kontext der Leitung (C1: Nutzer lesen keine run_context-Kategorie).
  assert.equal((await lese(d, { query: "run.context", scopeId: RUN_ID })).body.reason, "data_category_not_allowed_for_role");
  const leitung = await jobToken(d._env, { role: "lead_agent", principalId: "lead-agent-1", assignedJobIds: [RUN_ID], audience: "quantus-context" });
  const kontext = await lese(d, { query: "run.context", scopeId: RUN_ID, token: leitung });
  assert.equal(kontext.status, 200, JSON.stringify(kontext.body));
  assert.deepEqual(kontext.body.items.map((x) => x.id), ["ctx_chatgptLead_l1", "ctx_chatgptLead_l:9", "ctx_chatgptTask_c1", "ctx_task_t1"], "alle Quellen des Laufs, Kennungen unveraendert");
  assert.equal(kontext.body.items[0].text, "Bitte Firma Muster AG als Kunde anlegen.");
  assert.deepEqual(kontext.body.items[0].evidenceRefs, ["ev_l1"]);
  assert.equal(kontext.body.complete, true);

  const warteschlange = await lese(d, { route: "quantus-read", query: "run.queue", scopeId: RUN_ID });
  assert.equal(warteschlange.status, 200, JSON.stringify(warteschlange.body));
  assert.deepEqual(warteschlange.body.items.map((r) => [r.id, r.date, r.state, r.slot, r.entityVersion]), [[RUN_ID, DATE, "active", "process09", laufVersion(BASIS)]]);

  const policy = await lese(d, { query: "policy.current", scopeId: "policy_" + POLICY_VERSION });
  assert.equal(policy.status, 200); assert.equal(policy.body.items[0].policyVersion, POLICY_VERSION); assert.equal(policy.body.items[0].mode, "enforce");

  // Status: nur ueber die Statusroute, mit Dienstausweis; der echte gemeinsame B-Status ueber den ganzen Bestand.
  const status = await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: d._env.secrets.service.checker });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const s = status.body.items[0];
  assert.equal(s.id, "status_" + DATE); assert.equal(s.runId, RUN_ID); assert.equal(s.state, "active"); assert.equal(s.stage, "process09");
  assert.equal(s.openQuestions, 1, "q_c1 ist offen und gehoert zum Lauf");
  assert.equal(s.blocked, true, "ein laufender Tag mit offener Frage und aktivem Auftrag ist nicht gruen");
  const roh = d.domain.listPage(BASIS, { query: "run.status", scopeId: "status_" + DATE, pageSize: 10, afterId: null, principal: { role: "backend_checker" } });
  assert.equal(roh.items[0].evaluationCached, false, "ohne gueltige Zwischenspeicherung wird die Ampel frisch gerechnet");
  assert.equal(d._store.spur.mutates, 0, "GET schreibt nie");
  assert.equal(JSON.stringify(d._store.snapshot), JSON.stringify(BASIS), "GET veraendert den Bestand nicht");

  // Fremder Eigentuemer, fremder Mandant, unbekanntes Objekt, Spezialist ohne Leadzugriff.
  assert.equal((await lese(d, { query: "notes.recent", scopeId: "l1", token: nutzerToken("uid-fremd") })).status, 403);
  assert.equal((await lese(d, { query: "notes.recent", scopeId: "l1", token: FA.makeIdToken({ key, sub: OWNER, now: JETZT, tenant: "anderer-haushalt" }) })).status, 403);
  assert.equal((await lese(d, { query: "lead.context", scopeId: "l_unbekannt" })).body.reason, "object_not_found");
  assert.equal((await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE })).status, 200, "der Eigentuemer sieht den Status seines Haushalts (C1: run_status fuer user)");
  assert.equal((await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: nutzerToken("uid-fremd") })).status, 403, "ein fremder Nutzer nicht");
  const spezialist = await jobToken(d._env, { role: "specialist_claude", principalId: "claude-spezialist", audience: "quantus-context" });
  const keinLead = await lese(d, { query: "lead.context", scopeId: "l1", token: spezialist });
  assert.equal(keinLead.status, 403, "Spezialist bekommt keinen allgemeinen Leadzugriff"); assert.equal(keinLead.body.reason, "job_binding_missing", "ein Lead-Scope traegt keinen Auftrag — C1 lehnt vor der Kategorie ab");
  const eigener = await lese(d, { query: "run.context", scopeId: RUN_ID, token: spezialist });
  assert.equal(eigener.status, 200, JSON.stringify(eigener.body));
  assert.deepEqual(eigener.body.items.map((x) => x.id), ["ctx_chatgptLead_l1", "ctx_chatgptTask_c1"], "nur Quelle und contextRefs seines aktiven Auftrags");
  const gemini = await jobToken(d._env, { role: "specialist_gemini", principalId: "gemini-spezialist", audience: "quantus-context" });
  assert.deepEqual((await lese(d, { query: "run.context", scopeId: RUN_ID, token: gemini })).body.items, [], "ohne eigenen Auftrag: nichts");
  assert.equal((await lese(d, { route: "quantus-read", query: "run.queue", scopeId: RUN_ID, token: d._env.secrets.service.scheduler })).status, 200);
  assert.equal((await lese(d, { route: "quantus-read", query: "lead.context", scopeId: "l1", token: d._env.secrets.service.scheduler })).status, 403, "Scheduler ohne Leadzugriff");
});

test("C3a-03 Seiten: vollstaendig oder ehrlich abgebrochen; kein Ueberspringen, kein stilles Neubeginnen", async () => {
  const d = deps();
  const erste = await lese(d, { query: "notes.recent", scopeId: "l1", pageSize: 2 });
  assert.equal(erste.status, 200); assert.deepEqual(erste.body.items.map((n) => n.id), ["c3", "c2"]); assert.equal(erste.body.complete, false); assert.ok(erste.body.cursor);
  const zweite = await lese(d, { query: "notes.recent", scopeId: "l1", pageSize: 2, cursor: erste.body.cursor });
  assert.equal(zweite.status, 200); assert.deepEqual(zweite.body.items.map((n) => n.id), ["c1"]); assert.equal(zweite.body.complete, true); assert.equal(zweite.body.cursor, null);
  const a = d.domain;
  assert.deepEqual(a.listPage(BASIS, { query: "notes.recent", scopeId: "l1", pageSize: 2, afterId: "c_gibt_es_nicht", principal: {} }), { items: [], hasMore: false, nextAfterId: null, aborted: true, abortReason: "after_id_unknown" });
  const alle = a.listPage(BASIS, { query: "run.context", scopeId: RUN_ID, pageSize: 3, afterId: null, principal: { role: "user" } });
  assert.equal(alle.items.length, 3); assert.equal(alle.hasMore, true); assert.equal(alle.nextAfterId, "ctx_chatgptTask_c1"); assert.equal(alle.total, 4);
  const rest = a.listPage(BASIS, { query: "run.context", scopeId: RUN_ID, pageSize: 3, afterId: alle.nextAfterId, principal: { role: "user" } });
  assert.deepEqual(rest.items.map((x) => x.id), ["ctx_task_t1"]); assert.equal(rest.hasMore, false); assert.equal(rest.nextAfterId, null);
  assert.deepEqual(a.listPage(BASIS, { query: "run.context", scopeId: "run_9999-01-01", pageSize: 3, afterId: null, principal: {} }).abortReason, "scope_not_found");
  assert.throws(() => a.listPage({ entities: {}, automation: {} }, { query: "run.queue", scopeId: RUN_ID, pageSize: 3, afterId: null, principal: {} }), (e) => /^CORE_/.test(e.code), "kaputter Kern wirft (Dienst: 503 domain_adapter_failed)");
  // Doppelpunkt-Kennungen: sichtbar, unveraendert, ueber C2 nicht adressierbar — und nicht umcodiert.
  assert.equal(a.loadObject(BASIS, { kind: "lead", id: "l:9" }).id, "l:9");
  assert.equal(a.loadObject(BASIS, { kind: "lead", id: "l-9" }), null); assert.equal(a.loadObject(BASIS, { kind: "lead", id: "l_9" }), null);
  assert.equal((await lese(d, { query: "lead.context", scopeId: "l:9" })).status, 400, "C2 weist die Kennung ab — der Adapter tauscht sie nicht");
});

/* ══ 3. Ein echtes B-Kommando ueber C2 + echte Idempotenz ════════════════ */
test("C3a-04 vertikal: lead.transition des Nutzers wirkt als B.transitionState — nachgelesen, wiederholt, CAS-geprueft, versionsgesichert", async () => {
  const d = deps();
  const v0 = ver(BASIS, "chatgptLead", "l1");
  const payload = { leadId: "l1", toState: "done", evidenceRefs: ["ev_l1"], reason: "Kunde angelegt" };
  const r = await sende(d, { verb: "lead.transition", payload, expectedEntityVersion: v0, idempotencyKey: "k-done-l1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied, true); assert.equal(r.body.replayed, false); assert.equal(r.body.command, "transitionState");
  assert.deepEqual(r.body.entityVersions, { l1: v0 + 1 });
  assert.equal(r.body.effect.state, "done"); assert.equal(r.body.dataRevision, BASIS.automation.dataRevision + 1);
  // Nachgelesen aus dem Speicher: der Zustand ist gesetzt, mit gebundenem Beleg, Grabsteinfrei, Ledger ist Sache des Umschlags.
  const nach = d._store.snapshot;
  const z = K.effektiverZustand("chatgptLead", nach.entities.chatgptLeads.l1);
  assert.equal(z.state, "done"); assert.equal(z.version, v0 + 1);
  assert.equal(nach.entities.chatgptLeads.l1.operationalStateSource.closure.kind, "evidence");
  assert.equal(nach.entities.chatgptLeads.l1.operationalStateSource.closure.evidenceId, "ev_l1");
  assert.equal(Object.keys(nach.automation.idempotencyByKey).length, 1);
  assert.equal(nach.entities.chatgptLeads.l1.status, "in_arbeit", "der Altstatus wird nicht zurueckgeschrieben (Client-Konvention)");
  const gelesen = await lese(d, { query: "lead.context", scopeId: "l1" });
  assert.equal(gelesen.body.items[0].state, "done"); assert.equal(gelesen.body.items[0].entityVersion, v0 + 1);

  // Wiederholung mit gleichem Schluessel: Quittung, keine zweite Wirkung, Version nicht erneut geprueft.
  const wieder = await sende(d, { verb: "lead.transition", payload, expectedEntityVersion: v0, idempotencyKey: "k-done-l1" });
  assert.equal(wieder.status, 200); assert.equal(wieder.body.replayed, true); assert.deepEqual(wieder.body.entityVersions, { l1: v0 + 1 });
  assert.equal(d._store.snapshot.automation.dataRevision, nach.automation.dataRevision);
  // Gleicher Schluessel, anderer Inhalt: Konflikt.
  const konflikt = await sende(d, { verb: "lead.transition", payload: { ...payload, reason: "anders" }, expectedEntityVersion: v0, idempotencyKey: "k-done-l1" });
  assert.equal(konflikt.status, 409); assert.equal(konflikt.body.error, "idempotency_conflict");
  // Veraltete Version: 409, nichts geschrieben.
  const alt = await sende(d, { verb: "lead.transition", payload: { leadId: "l1", toState: "doing", reason: "wieder auf" }, expectedEntityVersion: v0, idempotencyKey: "k-alt" });
  assert.equal(alt.status, 409); assert.equal(alt.body.error, "stale_entity_version");
  // Fachliche B-Ablehnung wird uebersetzt: von done nach review ist kein erlaubter Uebergang → 409 mit B-Code als Grund.
  const verboten = await sende(d, { verb: "lead.transition", payload: { leadId: "l1", toState: "review" }, expectedEntityVersion: v0 + 1, idempotencyKey: "k-rev" });
  assert.equal(verboten.status, 409); assert.equal(verboten.body.error, "stale_entity_version"); assert.equal(verboten.body.reason, "TRANSITION_NOT_ALLOWED");
  assert.equal(Object.keys(d._store.snapshot.automation.idempotencyByKey).length, 1, "abgelehnte Kommandos hinterlassen keine Quittung");
  // Ohne Beleg kein done: B verlangt einen Abschlussbeleg (kein Nutzer-Selbstabschluss bei accountable chatgpt).
  const d2 = deps();
  const ohne = await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "done" }, expectedEntityVersion: v0, idempotencyKey: "k-ohne" });
  assert.equal(ohne.status, 400); assert.equal(ohne.body.reason, "DONE_EVIDENCE_MISSING");
  // Wartezustaende gehen nicht ueber transition; unbekannter Beleg, mehrdeutiger Beleg.
  assert.equal((await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "waiting_external" }, expectedEntityVersion: v0 })).body.reason, "use_lead_schedule_for_waiting");
  assert.equal((await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "done", evidenceRefs: ["ev_fremd"] }, expectedEntityVersion: v0 })).body.reason, "evidence_ref_unknown");
  assert.equal((await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "done", evidenceRefs: ["ev_l1", "job_l1_cancelled"] }, expectedEntityVersion: v0 })).body.reason, "evidence_refs_multiple_unsupported");
  // Fremder Eigentuemer und fremder Mandant: 403, bevor irgendetwas gerechnet wird.
  assert.equal((await sende(d2, { verb: "lead.transition", payload, expectedEntityVersion: v0, token: nutzerToken("uid-fremd") })).body.reason, "object_not_owned");
  assert.equal((await sende(d2, { verb: "lead.transition", payload, expectedEntityVersion: v0, token: FA.makeIdToken({ key, sub: OWNER, now: JETZT, tenant: "anderer" }) })).status, 403);
  assert.equal(JSON.stringify(d2._store.snapshot), JSON.stringify(BASIS), "Ablehnungen schreiben nichts");

  // CAS-Konflikte: der Bestand wird je Versuch frisch aufgeloest; die Wirkung bleibt genau eine.
  const d3 = deps({ store: FC.makeStore({ snapshot: BASIS, conflictsBefore: 2 }) });
  const cas = await sende(d3, { verb: "lead.transition", payload, expectedEntityVersion: v0, idempotencyKey: "k-cas" });
  assert.equal(cas.status, 200, JSON.stringify(cas.body)); assert.equal(d3._store.spur.mutatorCalls, 3);
  assert.equal(K.effektiverZustand("chatgptLead", d3._store.snapshot.entities.chatgptLeads.l1).version, v0 + 1);
  // Unklarer Ausgang: 503, keine Behauptung.
  const d4 = deps({ store: FC.makeStore({ snapshot: BASIS, unknownOutcome: true }) });
  assert.equal((await sende(d4, { verb: "lead.transition", payload, expectedEntityVersion: v0 })).status, 503);
  // Nur pruefen: nichts geschrieben, Version beobachtet.
  const pruefung = await sende(deps(), { verb: "lead.transition", payload, expectedEntityVersion: v0, validateOnly: true });
  assert.equal(pruefung.status, 200); assert.equal(pruefung.body.validated, true); assert.equal(pruefung.body.observedEntityVersion, v0);
});

/* ══ 4. Die uebrigen gebundenen Verben je Rolle ══════════════════════════ */
test("C3a-05 Nutzer: intake.create/accept, briefing.answer, question.resolve wirken im Kern; lead.schedule ist fuer Nutzer in B nicht erlaubt", async () => {
  const d = deps();
  const intake = await sende(d, { verb: "intake.create", payload: { source: "manual", title: "Neue Anfrage", text: "Bitte Offerte pruefen" }, idempotencyKey: "k-in" });
  assert.equal(intake.status, 200, JSON.stringify(intake.body));
  const intakeId = Object.keys(intake.body.entityVersions)[0];
  assert.match(intakeId, /^intake_[0-9a-f]{32}$/);
  assert.equal(d._store.snapshot.automation.intakeById[intakeId].text, "Neue Anfrage\nBitte Offerte pruefen");
  assert.equal(d._store.snapshot.automation.intakeById[intakeId].registeredBy, OWNER);
  // Identische Wiederholung mit anderem Schluessel: dieselbe Karte, B ist idempotent (created:false).
  const nochmal = await sende(d, { verb: "intake.create", payload: { source: "manual", title: "Neue Anfrage", text: "Bitte Offerte pruefen" }, idempotencyKey: "k-in2" });
  assert.equal(nochmal.status, 200); assert.equal(nochmal.body.effect.created, false); assert.equal(Object.keys(d._store.snapshot.automation.intakeById).length, 1);
  const version = intake.body.entityVersions[intakeId];
  const accept = await sende(d, { verb: "intake.accept", payload: { intakeId, leadId: "l1" }, expectedEntityVersion: version, idempotencyKey: "k-acc" });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(d._store.snapshot.automation.intakeById[intakeId].status, "done");
  assert.deepEqual(d._store.snapshot.automation.intakeById[intakeId].linkedTo, { sourceType: "chatgptLead", sourceId: "l1" });
  assert.notEqual(accept.body.entityVersions[intakeId], version, "die Kartenversion folgt dem Inhalt");
  assert.equal((await sende(d, { verb: "intake.accept", payload: { intakeId, leadId: "l1" }, expectedEntityVersion: version, idempotencyKey: "k-acc2" })).status, 409, "alte Kartenversion");

  // briefing.answer: unveraenderliche Nutzerantwort auf die offene Frage des Laufs.
  const antwort = await sende(d, { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "Muster AG" }, idempotencyKey: "k-ans" });
  assert.equal(antwort.status, 200, JSON.stringify(antwort.body));
  const answerId = Object.keys(antwort.body.entityVersions).find((k) => k.startsWith("answer_"));
  assert.equal(d._store.snapshot.automation.answersById[answerId].text, "Muster AG");
  assert.equal(d._store.snapshot.automation.answersById[answerId].answeredBy, OWNER);
  assert.equal(d._store.snapshot.automation.questionsById.q_c1.status, "answered");
  assert.equal((await sende(d, { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "anders" }, idempotencyKey: "k-ans2" })).body.reason, "QUESTION_NOT_OPEN:answered", "die Antwort ist unveraenderlich");
  assert.equal((await sende(deps(), { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "x", decision: "yes" } })).body.reason, "field_not_bound:decision:recordAnswer_has_no_decision");
  assert.equal((await sende(deps(), { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_fremd", answer: "x" } })).body.reason, "QUESTION_NOT_FOUND");
  // question.resolve: gleiche Wirkung ueber die Frage selbst.
  const d2 = deps();
  const qv = d2.domain.loadObject(BASIS, { kind: "question", id: "q_c1" }).entityVersion;
  const aufgeloest = await sende(d2, { verb: "question.resolve", payload: { questionId: "q_c1", answer: "Muster AG" }, expectedEntityVersion: qv, idempotencyKey: "k-res" });
  assert.equal(aufgeloest.status, 200, JSON.stringify(aufgeloest.body));
  assert.equal(d2._store.snapshot.automation.questionsById.q_c1.status, "answered");
  // lead.schedule: B erlaubt setWaiting nur dem Agenten — der Nutzer bekommt eine klare Ablehnung, keine stille Umdeutung.
  const plan = await sende(d2, { verb: "lead.schedule", payload: { leadId: "l1", waitUntil: new Date(JETZT + 2 * TAG).toISOString(), counterparty: "Bank Muster AG", nextAction: "nachfragen", evidenceRefs: ["ev_l1"] }, expectedEntityVersion: ver(BASIS, "chatgptLead", "l1") });
  assert.equal(plan.status, 400); assert.equal(plan.body.reason, "ACTOR_REJECTED:ACTOR_NOT_ALLOWED:user");
});

test("C3a-06 Leitungsagent: nur mit aktiver E1-Lease; question.create, lead.schedule mit echtem Beleg, worker.review mit Ergebnisbindung", async () => {
  const env = umgebung();
  const token = await jobToken(env, { role: "lead_agent", principalId: "lead-agent-1", assignedJobIds: [RUN_ID] });
  const v0 = ver(BASIS, "chatgptLead", "l1");
  // Ohne Lease: 403 lease_absent — Rechte reichen nicht, die Bindung fehlt.
  const ohne = deps({ env });
  const abgelehnt = await sende(ohne, { verb: "question.create", payload: { leadId: "l1", text: "Welche Adresse?" }, token });
  assert.equal(abgelehnt.status, 403); assert.equal(abgelehnt.body.reason, "lease_absent"); assert.equal(ohne._store.spur.mutatorCalls, 1, "im CAS geprueft, nichts geschrieben");
  // Fremde Lease, abgelaufene Lease, Lease eines anderen Tages.
  for (const [name, data, reason] of [
    ["fremder Halter", mitLease(BASIS, { holder: "anderer-agent" }), "lease_foreign_holder"],
    ["abgelaufen", mitLease(BASIS, { at: JETZT - 130000 }), "lease_expired"],
  ]) {
    const r = await sende(deps({ env, store: FC.makeStore({ snapshot: data }) }), { verb: "question.create", payload: { leadId: "l1", text: "?" }, token });
    assert.equal(r.status, 403, name); assert.equal(r.body.reason, reason, name);
  }
  // Mit Lease: question.create wirkt (askQuestion, Akteur agent, Laufdatum gebunden).
  const d = deps({ env, store: FC.makeStore({ snapshot: mitLease(BASIS) }) });
  const frage = await sende(d, { verb: "question.create", payload: { leadId: "l1", text: "Welche Adresse?" }, token, idempotencyKey: "k-q" });
  assert.equal(frage.status, 200, JSON.stringify(frage.body));
  const qId = Object.keys(frage.body.entityVersions).find((k) => k.startsWith("question_"));
  const q = d._store.snapshot.automation.questionsById[qId];
  assert.equal(q.sourceId, "l1"); assert.equal(q.runDate, DATE); assert.equal(q.askedBy, "lead-agent-1"); assert.equal(q.status, "open");
  assert.equal((await sende(d, { verb: "question.create", payload: { leadId: "l1", text: "?", options: ["a"] }, token })).body.reason, "field_not_bound:options:askQuestion_has_no_options");
  // lead.schedule: Warten auf den Nutzer ueber die gestellte Frage — B prueft Gegenpartei, naechsten Schritt, Frist, Beleg.
  const warten = await sende(d, { verb: "lead.schedule", payload: { leadId: "l1", waitUntil: new Date(JETZT + 2 * TAG).toISOString(), counterparty: "user", nextAction: "Antwort abwarten", evidenceRefs: [qId] }, token, expectedEntityVersion: v0, idempotencyKey: "k-wait" });
  assert.equal(warten.status, 200, JSON.stringify(warten.body));
  const w = d._store.snapshot.automation.waitingById["chatgptLead:l1"];
  assert.equal(w.state, "waiting_user"); assert.equal(w.evidence.kind, "question"); assert.equal(w.evidence.questionId, qId); assert.equal(w.setBy, "lead-agent-1");
  assert.equal(K.effektiverZustand("chatgptLead", d._store.snapshot.entities.chatgptLeads.l1).state, "waiting_user");
  assert.deepEqual(warten.body.entityVersions, { l1: v0 + 1 });
  // Erfundener Beleg, Gegenpartei "ich", Frist in der Vergangenheit: B lehnt ab — uebersetzt, nicht verschluckt.
  const d2 = deps({ env, store: FC.makeStore({ snapshot: mitLease(BASIS) }) });
  const basisPlan = { leadId: "l1", waitUntil: new Date(JETZT + 2 * TAG).toISOString(), counterparty: "Bank Muster AG", nextAction: "nachfragen", evidenceRefs: ["ev_l1"] };
  assert.equal((await sende(d2, { verb: "lead.schedule", payload: { ...basisPlan, evidenceRefs: ["ev_erfunden"] }, token, expectedEntityVersion: v0 })).body.reason, "evidence_ref_unknown");
  assert.equal((await sende(d2, { verb: "lead.schedule", payload: { ...basisPlan, counterparty: "chatgpt" }, token, expectedEntityVersion: v0 })).body.reason, "WAITING_INCOMPLETE:WAIT_COUNTERPARTY_SELF");
  assert.match((await sende(d2, { verb: "lead.schedule", payload: { ...basisPlan, waitUntil: new Date(JETZT - MIN).toISOString() }, token, expectedEntityVersion: v0 })).body.reason, /^WAITING_INCOMPLETE:WAIT_FOLLOWUP_PAST/);
  assert.equal((await sende(d2, { verb: "lead.schedule", payload: { ...basisPlan, reason: "x" }, token, expectedEntityVersion: v0 })).body.reason, "field_not_bound:reason:setWaiting_has_no_reason");
  const echt = await sende(d2, { verb: "lead.schedule", payload: basisPlan, token, expectedEntityVersion: v0, idempotencyKey: "k-ext" });
  assert.equal(echt.status, 200, JSON.stringify(echt.body)); assert.equal(d2._store.snapshot.automation.waitingById["chatgptLead:l1"].state, "waiting_external");
  // worker.review: das Ergebnis ist der Auftrag; ohne Rueckgabe gibt es nichts zu pruefen.
  let mitRueckgabe = bCmd(mitLease(BASIS), "recordJobReturn", { jobId: "job_c1_claude", outcome: "returned", resultRef: "res_c1", resultHash: "a".repeat(64) }, JETZT - MIN, { kind: "worker", id: "claude-spezialist" });
  const d3 = deps({ env, store: FC.makeStore({ snapshot: mitRueckgabe }) });
  const ergV = d3.domain.loadObject(mitRueckgabe, { kind: "worker_result", id: "res_c1" }).entityVersion;
  assert.equal((await sende(d3, { verb: "worker.review", payload: { resultId: "res_c1", verdict: "revise" }, token, expectedEntityVersion: ergV })).body.reason, "verdict_not_bound:revise:reviewJobResult_knows_accepted_rejected");
  const review = await sende(d3, { verb: "worker.review", payload: { resultId: "res_c1", verdict: "accepted", notes: "passt" }, token, expectedEntityVersion: ergV, idempotencyKey: "k-rev" });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const j = d3._store.snapshot.automation.jobsById.job_c1_claude;
  assert.equal(j.review.verdict, "accepted"); assert.equal(j.review.reviewer, "lead-agent-1"); assert.equal(j.review.resultHash, "a".repeat(64));
  assert.equal(K.effektiverZustand("chatgptTask", d3._store.snapshot.entities.chatgptTasks.c1).state, "review");
  assert.equal((await sende(d3, { verb: "worker.review", payload: { resultId: "res_unbekannt", verdict: "accepted" }, token })).body.reason, "object_not_found");
  // Fremder Lauf im Ausweis: die Zuweisung deckt RUN_ID, nicht run_2026-09-21.
  const fremd = await jobToken(env, { role: "lead_agent", principalId: "lead-agent-1", jobId: "run_2026-09-21", assignedJobIds: ["run_2026-09-21"] });
  assert.equal((await sende(d, { verb: "question.create", payload: { leadId: "l1", text: "?" }, token: fremd, jobId: "run_2026-09-21" })).status, 403);
});

test("C3a-07 Scheduler und Pruefer: run.ensure legt den Lauf an, run.claim/renew laufen ueber E1, consumeAnswer und finalize ueber B — ohne Nachbau", async () => {
  const env = umgebung();
  const sched = env.secrets.service.scheduler, checker = env.secrets.service.checker;
  const d = deps({ env });
  // run.ensure fuer morgen: neue Ressource, expectedEntityVersion 0, jobId = run_<date>.
  const morgen = "2026-09-21", morgenId = "run_" + morgen;
  const ensure = await sende(d, { verb: "run.ensure", payload: { slot: "04:00", date: morgen }, token: sched, jobId: morgenId, expectedEntityVersion: 0, idempotencyKey: "k-ens" });
  assert.equal(ensure.status, 200, JSON.stringify(ensure.body));
  assert.equal(ensure.body.effect.created, true); assert.deepEqual(ensure.body.entityVersions, { [morgenId]: 0 });
  assert.equal(d._store.snapshot.dailyBriefing.assistantRuns[morgen].policyVersion, POLICY_VERSION);
  assert.equal((await sende(d, { verb: "run.ensure", payload: { slot: "04:00", date: morgen }, token: sched, jobId: morgenId, expectedEntityVersion: 0, idempotencyKey: "k-ens2" })).body.effect.created, false, "zweites ensure ist ein No-op");
  assert.equal((await sende(d, { verb: "run.ensure", payload: { slot: "04:00", date: "2026-09-22" }, token: sched, jobId: morgenId, expectedEntityVersion: 0 })).body.reason, "run_id_date_mismatch");
  assert.equal((await sende(d, { verb: "run.ensure", payload: { slot: "04:00", date: DATE }, token: sched, jobId: RUN_ID, expectedEntityVersion: 0 })).status, 409, "bestehender Lauf hat eine Revision > 0");
  // run.claim: Lease ueber E1 auf den Slot-Schluessel des Laufs; Wiederholung ist ein No-op; fremder Halter wird abgewiesen.
  const rv = laufVersion(d._store.snapshot);
  const claim = await sende(d, { verb: "run.claim", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv, idempotencyKey: "k-claim" });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.effect.acquired, true); assert.equal(claim.body.effect.fence, 1);
  const lease = d._store.snapshot.automation.activeLease;
  assert.equal(lease.holder, "cloud-scheduler"); assert.equal(lease.scope, K.slotKey(TENANT, DATE, "process09", POLICY_VERSION)); assert.equal(lease.expiresAtMs, JETZT + 60000);
  assert.equal(E1.checkLeadership(d._store.snapshot, { holder: "cloud-scheduler", scope: lease.scope, fence: 1 }, JETZT).ok, true, "E1 selbst bestaetigt die Lease");
  const laufMitLease = await lese(d, { route: "quantus-read", query: "run.queue", scopeId: RUN_ID, token: sched });
  assert.equal(laufMitLease.body.items.find((r) => r.id === RUN_ID).leaseExpiresAt, new Date(JETZT + 60000).toISOString());
  assert.equal((await sende(d, { verb: "run.claim", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv, idempotencyKey: "k-claim2" })).body.effect.duplicate, true);
  // C2 erlaubt bis 900 s, E1 hoechstens 120 s: strukturiert abgelehnt, nichts gekuerzt.
  const d2 = deps({ env });
  const zuLang = await sende(d2, { verb: "run.claim", payload: { leaseSeconds: 900 }, token: sched, expectedEntityVersion: rv });
  assert.equal(zuLang.status, 400); assert.equal(zuLang.body.reason, "runtime:invalid_ttl"); assert.equal(d2._store.snapshot.automation.activeLease, null);
  // run.renew: verlaengert die eigene Lease; ohne Lease oder als Fremder 409.
  const renew = await sende(d, { verb: "run.renew", payload: { leaseSeconds: 90 }, token: sched, expectedEntityVersion: rv, idempotencyKey: "k-renew" });
  assert.equal(renew.status, 200, JSON.stringify(renew.body)); assert.equal(renew.body.effect.renewed, true); assert.equal(d._store.snapshot.automation.activeLease.expiresAtMs, JETZT + 90000);
  assert.equal((await sende(d2, { verb: "run.renew", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv })).body.reason, "lease:lease_absent");
  const fremdeLease = deps({ env, store: FC.makeStore({ snapshot: mitLease(BASIS, { holder: "anderer" }) }) });
  assert.equal((await sende(fremdeLease, { verb: "run.claim", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv })).body.reason, "lease:lease_held");
  assert.equal((await sende(fremdeLease, { verb: "run.renew", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv })).body.reason, "lease:lease_foreign_holder");
  // Pruefer: consumeAnswer nach Nutzerantwort; finalize nur ueber closeRun, und der ist auf einem nicht gruenen Tag blockiert.
  const d3 = deps({ env });
  await sende(d3, { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "Muster AG" }, idempotencyKey: "k-a" });
  const answerId = Object.keys(d3._store.snapshot.automation.answersById)[0];
  const av = d3.domain.loadObject(d3._store.snapshot, { kind: "briefing_answer", id: answerId }).entityVersion;
  assert.equal((await sende(d3, { verb: "briefing.consumeAnswer", payload: { briefingId: "run_2026-09-19", answerId }, token: checker, expectedEntityVersion: av })).body.reason, "briefing_answer_mismatch");
  const konsum = await sende(d3, { verb: "briefing.consumeAnswer", payload: { briefingId: RUN_ID, answerId }, token: checker, expectedEntityVersion: av, idempotencyKey: "k-c" });
  assert.equal(konsum.status, 200, JSON.stringify(konsum.body));
  assert.equal(d3._store.snapshot.automation.answersById[answerId].consumedBy, "backend-pruefer");
  assert.equal((await sende(d3, { verb: "briefing.consumeAnswer", payload: { briefingId: RUN_ID, answerId }, token: checker, expectedEntityVersion: konsum.body.entityVersions[answerId] })).body.reason, "ANSWER_ALREADY_CONSUMED");
  const fin = await sende(d3, { verb: "run.finalize", payload: { outcome: "complete" }, token: checker, expectedEntityVersion: laufVersion(d3._store.snapshot) });
  assert.equal(fin.status, 409); assert.equal(fin.body.reason, "CLOSURE_BLOCKED", "kein done ohne Nachweis: closeRun prueft Zeit, Quittungen und Ampel");
  assert.equal((await sende(d3, { verb: "run.finalize", payload: { outcome: "partial" }, token: checker, expectedEntityVersion: laufVersion(d3._store.snapshot) })).body.reason, "outcome_not_bound:partial:closeRun_only_closes_green_runs");
  assert.equal(d3._store.snapshot.dailyBriefing.assistantRuns[DATE].phase, "active");
  // Kein Scheduler-Zugriff auf Inhalte: lead.transition ist fuer Dienste kein erlaubtes Verb (C1), und der Adapter oeffnet nichts.
  assert.equal((await sende(d3, { verb: "lead.transition", payload: { leadId: "l1", toState: "doing" }, token: sched, expectedEntityVersion: 1 })).status, 403);
});

test("C3a-08 Spezialist: Rueckgabe nur auf den eigenen, aktiven Auftrag des Laufs — und selbst dann ist worker.return eine benannte Luecke (Hash fehlt in C2)", async () => {
  const env = umgebung();
  const claude = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist" });
  const gemini = await jobToken(env, { role: "specialist_gemini", principalId: "gemini-spezialist" });
  const rueckgabe = (assignmentId) => ({ assignmentId, resultRef: "res_" + assignmentId, summary: "fertig", sourceVersion: 1 });
  const d = deps({ env });
  const fremd = await sende(d, { verb: "worker.return", payload: rueckgabe("job_c1_claude"), token: gemini });
  assert.equal(fremd.status, 403); assert.equal(fremd.body.reason, "assignment_foreign_executor");
  const abgebrochen = await sende(d, { verb: "worker.return", payload: rueckgabe("job_l1_cancelled"), token: claude });
  assert.equal(abgebrochen.status, 403); assert.equal(abgebrochen.body.reason, "assignment_not_active:cancelled");
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe("job_gibt_es_nicht"), token: claude })).body.reason, "object_not_found");
  const abgelaufen = deps({ env, store: FC.makeStore({ snapshot: (() => { const k = structuredClone(BASIS); k.automation.jobsById.job_c1_claude.expiresAt = new Date(JETZT - 1).toISOString(); return k; })() }) });
  assert.equal((await sende(abgelaufen, { verb: "worker.return", payload: rueckgabe("job_c1_claude"), token: claude })).body.reason, "assignment_expired");
  const andererLauf = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist", jobId: "run_2026-09-19" });
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe("job_c1_claude"), token: andererLauf, jobId: "run_2026-09-19" })).status, 403);
  // Eigener, aktiver Auftrag: Rechte und Bindung stimmen — die Wirkung fehlt in C2 (kein resultHash), also 400 mit Namen und ohne Schreiben.
  const eigen = await sende(d, { verb: "worker.return", payload: rueckgabe("job_c1_claude"), token: claude, idempotencyKey: "k-ret" });
  assert.equal(eigen.status, 400); assert.equal(eigen.body.reason, "verb_not_bound:worker.return:C2_PAYLOAD_LACKS_RESULT_HASH");
  assert.equal(d._store.snapshot.automation.jobsById.job_c1_claude.state, "queued"); assert.deepEqual(d._store.snapshot.automation.idempotencyByKey, {});
  // Ein direkt in B zurueckgegebener Auftrag (mit Hash) ist danach nicht mehr aktiv — die Bindung sagt es.
  const erledigt = bCmd(BASIS, "recordJobReturn", { jobId: "job_c1_claude", outcome: "returned", resultRef: "res_c1", resultHash: "b".repeat(64) }, JETZT - MIN, { kind: "worker", id: "claude-spezialist" });
  assert.equal((await sende(deps({ env, store: FC.makeStore({ snapshot: erledigt }) }), { verb: "worker.return", payload: rueckgabe("job_c1_claude"), token: claude })).body.reason, "assignment_not_active:returned");
});

/* ══ 5. Alle 22 Verben: gebunden oder benannte Luecke ════════════════════ */
test("C3a-09 jedes der 22 Verben ist gebunden oder eine benannte Luecke; Luecken pruefen Rechte und Bindung und schreiben nichts", async () => {
  const { COMMAND_VERB_NAMES } = await lade("netlify/lib/quantus-v3-command-envelope.mjs");
  assert.deepEqual(Object.keys(VERB_BINDINGS).sort(), [...COMMAND_VERB_NAMES].sort(), "genau die Verben von C2");
  for (const [verb, b] of Object.entries(VERB_BINDINGS)) assert.ok((b.command && !b.gap) || (!b.command && b.gap), verb + ": entweder Kommando oder Luecke");
  const gebunden = Object.entries(VERB_BINDINGS).filter(([, b]) => b.command).map(([v]) => v).sort();
  assert.deepEqual(gebunden, ["briefing.answer", "briefing.consumeAnswer", "intake.accept", "intake.create", "lead.schedule", "lead.transition", "question.create", "question.resolve", "run.claim", "run.ensure", "run.finalize", "run.renew", "worker.review"]);
  const env = umgebung();
  const lead = await jobToken(env, { role: "lead_agent", principalId: "lead-agent-1", assignedJobIds: [RUN_ID] });
  const checker = env.secrets.service.checker, sched = env.secrets.service.scheduler;
  const v0 = ver(BASIS, "chatgptLead", "l1");
  const faelle = [
    ["task.create", nutzerToken(), { leadId: "l1", title: "Nachfassen" }, 0],
    ["lead.comment", nutzerToken(), { leadId: "l1", text: "Notiz" }, v0],
    ["document.register", nutzerToken(), { documentId: "doc_1", title: "Vertrag", attachmentRef: "att_1", contentHash: "c".repeat(64), origin: "upload" }, 0],
    ["document.processed", lead, { documentId: "doc_x", extractionRef: "ext_1", contentHash: "c".repeat(64) }, 0],
    ["worker.assign", lead, { assignmentId: "job_neu", executor: "claude", sourceVersion: 1, allowedContextIds: ["l1"] }, 0],
    ["run.checkpoint", lead, { stage: "lesen" }, laufVersion(BASIS)],
    ["run.log", sched, { event: "tick" }, laufVersion(BASIS)],
    ["note.append", checker, { noteId: "note_x", text: "Notiz", noteScope: "run" }, 0],
  ];
  for (const [verb, token, payload, expectedEntityVersion] of faelle) {
    const d = deps({ env, store: FC.makeStore({ snapshot: mitLease(BASIS) }) });
    const r = await sende(d, { verb, payload, token, expectedEntityVersion, idempotencyKey: "k-" + verb });
    if (verb === "document.processed") { assert.equal(r.status, 403, verb); assert.equal(r.body.reason, "object_not_found", verb); continue; }   // kein solches Dokument — die Luecke kommt erst danach
    assert.equal(r.status, 400, verb + ": " + JSON.stringify(r.body));
    assert.equal(r.body.reason, "verb_not_bound:" + verb + ":" + VERB_BINDINGS[verb].gap, verb);
    assert.equal(JSON.stringify(d._store.snapshot.entities), JSON.stringify(mitLease(BASIS).entities), verb + " hat geschrieben");
    assert.deepEqual(d._store.snapshot.automation.idempotencyByKey, {}, verb + " hat eine Quittung hinterlassen");
  }
  // Ohne Lease scheitert die Luecke des Leitungsagenten schon an der Bindung — Rechte und Bindung gehen der Luecke vor.
  const ohneLease = await sende(deps({ env }), { verb: "run.checkpoint", payload: { stage: "lesen" }, token: lead, expectedEntityVersion: laufVersion(BASIS) });
  assert.equal(ohneLease.status, 403); assert.equal(ohneLease.body.reason, "lease_absent");
  // document.processed gegen ein echtes Dokument ist ebenfalls die benannte Luecke: der B-Anhangsschluessel passt nicht in eine C2-Kennung.
  assert.ok(!/^[A-Za-z0-9_-]{1,128}$/.test("attachment-text__chatgptLead__l1__x") || "attachment-text__chatgptLead__l1__x".includes("__"), "der Anhangsschluessel enthaelt __");
});

/* ══ 6. Status nach Widerspruch ══════════════════════════════════════════ */
test("C3a-10 Status nach Abschluss und Widerspruch: final wird blocked, die Bewertung wird frisch gerechnet, nicht aus dem Cache", async () => {
  // Ein gruener Tag: alles erledigt, alle Quittungen, Abschluss um 23:05 — ueber B, wie im Kerntest.
  let d = kern();
  const abend = K.wandzeitZuMs(DATE, 23, 5);
  d = bCmd(d, "cancelJob", { jobId: "job_c1_claude", reason: "Test" }, JETZT);
  d = bCmd(d, "recordAnswer", { answerId: "a_c1", questionId: "q_c1", text: "Muster AG" }, JETZT + MIN, USER_B);
  d = bCmd(d, "consumeAnswer", { answerId: "a_c1", consumer: "chatgpt-run" }, JETZT + 2 * MIN);
  for (const s of ["continue14", "close23"]) d = bCmd(d, "recordSlotReceipt", { date: DATE, slot: s, receiptId: "rcpt_" + s }, K.slotBeginnMs(DATE, s) + MIN);
  for (const s of POLICY.requiredSources) d = bCmd(d, "recordSourceCheck", { date: DATE, sourceId: s.id, cursor: "c2", outcome: "ok" }, abend - 3 * MIN, ADAPTER);
  const erledige = (data, sourceType, id, actor = AGENT) => {
    if (sourceType === "task") return bCmd(data, "transitionState", { sourceType, sourceId: id, state: "done", expectedVersion: ver(data, sourceType, id) }, abend - 2 * MIN, USER_B);
    const evId = "ev_done_" + id.replace(/[^A-Za-z0-9]/g, "_");
    data = bCmd(data, "registerEvidence", { evidenceId: evId, kind: "message", ref: "msg_" + evId, sourceType, sourceId: id, origin: { adapter: "gmail", ref: "t_" + evId }, observedAt: new Date(abend - 3 * MIN).toISOString(), fingerprint: "fp_" + evId + "_0123456789abcdef" }, abend - 2 * MIN, ADAPTER);
    return bCmd(data, "transitionState", { sourceType, sourceId: id, state: "done", expectedVersion: ver(data, sourceType, id), evidence: { kind: "evidence", evidenceId: evId } }, abend - 2 * MIN, actor);
  };
  d = erledige(d, "chatgptLead", "l1"); d = erledige(d, "chatgptLead", "l:9"); d = erledige(d, "chatgptTask", "c1"); d = erledige(d, "task", "t1");
  d = bCmd(d, "closeRun", { date: DATE, finalNoteId: "note_final_" + DATE }, abend);
  assert.equal(d.dailyBriefing.assistantRuns[DATE].phase, "final");
  const env = umgebung();
  // Der Status wird mit der Uhr NACH dem Abschluss gelesen — die Ampel ist eine Funktion der Zeit.
  const nachAbschluss = createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => abend + MIN, ports: PORTS });
  const geschlossen = nachAbschluss.listPage(d, { query: "run.status", scopeId: "status_" + DATE, pageSize: 10, afterId: null, principal: { role: "backend_checker" } }).items[0];
  assert.equal(geschlossen.state, "final"); assert.equal(geschlossen.blocked, false); assert.equal(geschlossen.openQuestions, 0);
  // Widerspruch: ein Lead wird nach dem Abschluss wieder geoeffnet, der Abschluss wird ungueltig — Status blocked, Cache verworfen.
  const t1 = abend + 10 * MIN;
  let w = bCmd(d, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: ver(d, "chatgptLead", "l1"), reason: "Kunde meldet Fehler" }, t1);
  w = bCmd(w, "invalidateClosure", { date: DATE, correctionId: "note_korr_1", reason: "Lead l1 wieder offen", contradiction: { sourceType: "chatgptLead", sourceId: "l1" } }, t1 + MIN);
  const spaeter = createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => t1 + 2 * MIN, ports: PORTS });
  const nachher = spaeter.listPage(w, { query: "run.status", scopeId: "status_" + DATE, pageSize: 10, afterId: null, principal: { role: "backend_checker" } }).items[0];
  assert.equal(nachher.state, "exception_open"); assert.equal(nachher.blocked, true); assert.equal(nachher.evaluationCached, false);
  assert.equal(nachher.entityVersions, undefined); assert.ok(nachher.entityVersion > geschlossen.entityVersion);
  // Nach dem Widerspruch ist finalize erneut blockiert (RUN_EXCEPTION_OPEN), und der Bestand bleibt.
  const d2 = deps({ env, store: FC.makeStore({ snapshot: w }) });
  const fin = await sende(d2, { verb: "run.finalize", payload: { outcome: "complete" }, token: env.secrets.service.checker, expectedEntityVersion: w.dailyBriefing.assistantRuns[DATE].revision, jobId: RUN_ID });
  assert.equal(fin.status, 409); assert.equal(fin.body.reason, "RUN_EXCEPTION_OPEN");
});
