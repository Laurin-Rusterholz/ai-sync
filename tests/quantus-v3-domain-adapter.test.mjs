/*
 * Quantus v3, Paket C3a — der kanonische Domaenen-Adapter gegen den ECHTEN
 * Kern aus Paket B, ueber die ECHTE C2-Kette, den ECHTEN Idempotenz-Umschlag
 * und die ECHTE E1-Laufzeit dieses Checkouts (Integrationsstand 48dc1fe8,
 * Tree d309cc65…, plus die engen C3a-Vertragsanpassungen) sowie die
 * C3b-Verdrahtung 4379061 (im Checkout, Blob-Hash wird hier verifiziert).
 * Ausweise sind synthetisch signiert; es gibt keinen Ersatzbestand und
 * keinen Fallback.
 *
 * Was diese Tests festhalten (Review 7bbbd42 und Auftrag „alle Verben"):
 *   • jedes der 23 Verben hat einen positiven Weg, der im Bestand des
 *     Speichers nachgelesen wird, und mindestens einen negativen;
 *   • die Leitung fuehrt ihre Lease mit (lease{holder,fence}); ein falscher
 *     Fence, ein fremder Halter, eine abgelaufene oder fehlende Lease sind
 *     403 — je CAS-Versuch geprueft, nie aus der gespeicherten Lease geraten;
 *   • ein Spezialist liest und schreibt nur SEINEN aktiven Auftrag (Ausweis-
 *     jobId = Auftragskennung): abgelaufen, abgebrochen, fremder Executor,
 *     veraltete Quellversion oder fremder Lauf sind 403 — auch beim Lesen;
 *   • Kennungen mit Doppelpunkt sind adressierbar, nichts wird umcodiert;
 *   • ein Tag laesst sich ueber C2 bis zum echten closeRun fuehren
 *     (Slot-Quittungen, Quellenpruefungen, Belege, Abschluss), und nach
 *     einem Widerspruch ist der Status blockiert;
 *   • Wiederholungen, Idempotenzkonflikte, CAS-Konflikte, veraltete Versionen,
 *     fremde Mandanten/Eigentuemer, kaputter Kern (kontrollierte 503).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as K from "../netlify/lib/assistant-core.mjs";
import * as E1 from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as S from "../netlify/lib/quantus-v3-service.mjs";
import * as A from "../netlify/lib/quantus-v3-auth.mjs";
import * as R from "../netlify/lib/quantus-v3-runtime.mjs";
import * as IDEM from "../netlify/lib/quantus-v3-idempotency.mjs";
import { COMMAND_VERB_NAMES } from "../netlify/lib/quantus-v3-command-envelope.mjs";
import { attSegEncode } from "../netlify/lib/blob-key-policy.mjs";
import * as FA from "./fixtures/quantus-v3-auth-fixtures.mjs";
import * as FC from "./fixtures/quantus-v3-c2-fixtures.mjs";
import { createQuantusV3DomainAdapter, describeDomainPorts, VERB_BINDINGS, DOMAIN_PORT_VARS } from "../netlify/lib/quantus-v3-domain-adapter.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
const JOB = "job_c1_claude";                        // der Auftrag des Claude-Spezialisten
const ATT = (name) => "attachment-text__" + attSegEncode("chatgptLead") + "__" + attSegEncode("l1") + "__" + attSegEncode(name);
const POLICY = Object.freeze({ ...K.POLICY_TEMPLATE, version: POLICY_VERSION, tenant: TENANT, requiredSources: [{ id: "quantus-core", kind: "quantus-core" }, { id: "gmail-inbox", kind: "mail" }] });
const AGENT = { kind: "agent", id: "chatgpt-run" }, ADAPTER = { kind: "adapter", id: "gmail-adapter" }, USER_B = { kind: "user", id: OWNER };

let cmdN = 0;
const bCmd = (data, type, payload, now, actor = AGENT) => {
  const r = K.applyCommand(data, { type, commandId: "fix_" + String(++cmdN).padStart(6, "0"), now, payload }, { policy: POLICY, actor });
  assert.equal(r.ok, true, `${type}: ${r.error} ${JSON.stringify(r.detail)}`);
  return r.data;
};
const ver = (data, sourceType, id) => K.effektiverZustand(sourceType, K.quelleFinden(data, sourceType, id)).version;
const laufVersion = (data, date = DATE) => data.dailyBriefing.assistantRuns[date].revision;
const sicher = (id) => id.replace(/[^A-Za-z0-9]/g, "_");

function bestand() {
  const t0 = "2026-09-18T10:00:00.000Z";
  const lead = (id, extra) => ({
    id, title: "Kunden anlegen " + id, rawInput: "Bitte Firma Muster AG als Kunde anlegen.", status: "in_arbeit", readAt: t0, assignee: "chatgpt",
    interpretation: "Neue Organisation", research: "gesucht", plan: "anlegen", execution: "angelegt", result: "#/organizations/abc",
    assessment: {}, assignmentReason: "klein", linkedOrganizations: ["abc"], createdAt: t0, updatedAt: t0, comments: [], ...extra,
  });
  return {
    entities: {
      tasks: { t1: { id: "t1", title: "Rechnung zahlen", status: "todo", dueDate: "2026-09-21", createdAt: t0, updatedAt: t0, comments: [] } },
      projects: {}, notes: {}, chatgptNotes: {},
      chatgptLeads: {
        l1: lead("l1", { comments: [
          { id: "c1", text: "Erste Rueckmeldung", createdAt: "2026-09-19T08:00:00.000Z", author: "laurin" },
          { id: "c2", text: "Zweite Rueckmeldung", createdAt: "2026-09-19T08:05:00.000Z", author: "laurin" },
          { id: "c3", text: "Dritte Rueckmeldung", createdAt: "2026-09-19T08:10:00.000Z", author: "laurin" },
        ] }),
        l2: lead("l2", { status: "abgeschlossen", closedAt: t0, closedBy: "assistant" }),
        "l:9": lead("l:9"),   // Originalkennung mit Doppelpunkt — adressierbar, nie umcodiert
      },
      chatgptTasks: { c1: { id: "c1", text: "Namen ergaenzen", state: "offen", anchorKind: "organization", anchorId: "o1", createdAt: t0, updatedAt: t0 } },
    },
    journal: { documents: [] }, mobilePushes: [], dailyBriefing: { routines: [], dailyLog: {} },
  };
}
function kern() {
  let d = K.migrateCore(bestand(), { now: T("2026-09-19T06:00:00Z") }).data;
  const b4 = K.slotBeginnMs(DATE, "briefing04") + MIN, p9 = K.slotBeginnMs(DATE, "process09") + MIN;
  d = bCmd(d, "ensureRun", { date: DATE }, b4);
  d = bCmd(d, "ensureStartNote", { date: DATE, noteId: "note_start_" + DATE }, b4 + MIN);
  d = bCmd(d, "recordSlotReceipt", { date: DATE, slot: "briefing04", receiptId: "rcpt_b4" }, b4 + 2 * MIN);
  d = bCmd(d, "recordSlotReceipt", { date: DATE, slot: "process09", receiptId: "rcpt_p9" }, p9);
  for (const [sourceType, id] of [["chatgptLead", "l1"], ["chatgptLead", "l:9"], ["chatgptTask", "c1"], ["task", "t1"]]) d = bCmd(d, "addItemRef", { date: DATE, sourceType, sourceId: id }, JETZT - 2 * MIN);
  d = bCmd(d, "registerEvidence", { evidenceId: "ev_l1", kind: "message", ref: "msg_l1", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "thread_l1" }, observedAt: new Date(JETZT - 5 * MIN).toISOString(), fingerprint: "fp_l1_0123456789abcdef" }, JETZT - 4 * MIN, ADAPTER);
  d = bCmd(d, "askQuestion", { questionId: "q_c1", sourceType: "chatgptTask", sourceId: "c1", text: "Welcher Name?", date: DATE }, JETZT - 3 * MIN);
  d = bCmd(d, "createJob", { jobId: JOB, kind: "recherche", purpose: "Namen recherchieren", sourceType: "chatgptTask", sourceId: "c1", inputVersion: ver(d, "chatgptTask", "c1"), executor: "claude", contextRefs: [{ sourceType: "chatgptLead", sourceId: "l1" }], expiresAt: new Date(JETZT + STD).toISOString() }, JETZT - 10 * MIN);
  d = bCmd(d, "createJob", { jobId: "job_l1_cancelled", kind: "recherche", purpose: "abgebrochen", sourceType: "chatgptLead", sourceId: "l1", inputVersion: ver(d, "chatgptLead", "l1"), executor: "claude", contextRefs: [], expiresAt: new Date(JETZT + STD).toISOString() }, JETZT - 9 * MIN);
  d = bCmd(d, "cancelJob", { jobId: "job_l1_cancelled", reason: "Test" }, JETZT - 8 * MIN);
  return d;
}
const BASIS = kern();

/* ══ Verdrahtung ═════════════════════════════════════════════════════════ */
const PORTS = Object.freeze({ policy: POLICY, ownerId: OWNER, read: () => undefined });
const adapter = ({ now = () => JETZT, ...extra } = {}) => createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now, ports: { ...PORTS, ...extra } });
const umgebung = () => FA.makeEnv({ tenant: TENANT, mode: "enforce", overrides: { QUANTUS_V3_API_WRITES: "enabled" } });
function deps({ env = umgebung(), store = FC.makeStore({ snapshot: BASIS }), now = JETZT, domain = undefined } = {}) {
  let n = 0;
  const uhr = () => now;
  return {
    now: uhr, newRequestId: () => `req-${++n}`, env: env.read,
    keySource: FA.keySourceFor(key), userLookup: FA.userLookupFor({ tenantId: TENANT }),
    rateLimiter: FC.makeRateLimiter(), store,
    idempotency: { prepare: IDEM.prepareIdempotentCommand, apply: IDEM.applyIdempotentCommand },
    domain: domain === undefined ? adapter({ now: uhr }) : domain, _env: env, _store: store,
  };
}
const nutzerToken = (sub = OWNER, tenant = TENANT, now = JETZT) => FA.makeIdToken({ key, sub, now, tenant });
async function jobToken(env, { role, principalId, jobId = RUN_ID, assignedJobIds = null, audience = "quantus-ingest" }) {
  const { config } = A.resolveAuthConfig(env.read);
  const t = await A.mintJobToken({ config, audience, jobId, role, principalId, tenant: TENANT, assignedJobIds, now: () => JETZT });
  assert.equal(t.ok, true, JSON.stringify(t));
  return t.token;
}
const GEPRUEFT = new Set();   // positiv nachgewiesene Verben
async function sende(d, { verb, payload, token = nutzerToken(), jobId = RUN_ID, expectedEntityVersion = 0, idempotencyKey = null, validateOnly = false, lease = null }) {
  const body = { ...FC.commandBody({ verb, jobId, expectedEntityVersion, payload }), ...(lease ? { lease } : {}) };
  const res = await S.handleCommandRequest(FC.makeRequest({ headers: FC.commandHeaders({ token, origin: APP, idempotencyKey, validateOnly }), body }), d);
  if (res.status === 200 && res.body.applied === true && res.body.replayed === false) GEPRUEFT.add(verb);
  return res;
}
async function lese(d, { route = "quantus-context", query, scopeId, pageSize = null, cursor = null, token = nutzerToken(), jobId = null }) {
  const url = new URL(`${APP}/.netlify/functions/${route}`);
  url.searchParams.set("query", query); url.searchParams.set("scopeId", scopeId);
  if (pageSize != null) url.searchParams.set("pageSize", String(pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  if (jobId) url.searchParams.set("jobId", jobId);
  return S.handleReadRequest(FC.makeRequest({ method: "GET", url: url.toString(), headers: { authorization: `Bearer ${token}`, origin: APP } }), d, { route });
}
/* Lease fuer die Leitung — ueber E1, mit dem echten Fence als Rueckgabe. */
function mitLease(data, { holder = "cloud-scheduler", at = JETZT - 1000, ttlMs = 120000, slot = "process09" } = {}) {
  const r = E1.acquireLease(data, { holder, scope: K.slotKey(TENANT, DATE, slot, POLICY_VERSION), ttlMs, now: at });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  return { data: r.data, lease: { holder, fence: r.result.fence } };
}
const mussOk = (res, was) => { assert.equal(res.status, 200, `${was}: ${JSON.stringify(res.body)}`); assert.equal(res.body.applied, true, was); return res; };

/* ══ 1. Fabrik, Ports, C3b-Verdrahtung ═══════════════════════════════════ */
test("C3a-01 Fabrik nach C3b-Vertrag (f39cad2, Blob verifiziert): fuenf Methoden; fehlende Backendkonfiguration ist 503 mit Namen; alle 23 Verben gebunden", async () => {
  const reviewedBlobs = {
    "netlify/lib/quantus-v3-runtime.mjs": "ca5cd3e7bd157e8126c4933043fc3bdf6e4f96d6",
    "netlify/lib/quantus-v3-identity-access.mjs": "0dcb215997e96993130622fa20a2c04bcdfdb2a4",
  };
  for (const [f, erwartet] of Object.entries(reviewedBlobs)) {
    const ist = execFileSync("git", ["hash-object", f], { cwd: ROOT, encoding: "utf8" }).trim();
    assert.equal(ist, erwartet, `${f} weicht von C3b f39cad2 ab`);
  }
  const a = adapter();
  for (const m of R.DOMAIN_ADAPTER_METHODS) assert.equal(typeof a[m], "function", m);
  assert.equal(R.DOMAIN_FACTORY_EXPORT, "createQuantusV3DomainAdapter");
  const erwarte = (ports, reason, rest = {}) => assert.throws(() => createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => JETZT, ...rest, ports: { ...PORTS, ...ports } }),
    (e) => e.status === 503 && e.code === "auth_not_configured" && String(e.reason).startsWith(reason), reason);
  erwarte({ policy: undefined }, "domain_policy_missing:" + DOMAIN_PORT_VARS.policyJson);
  erwarte({ policy: undefined, read: () => "{nicht json" }, "domain_policy_unparsable");
  erwarte({ policy: { ...POLICY, closure: { earliestLocalTime: "22:00", requiredReceipts: ["process09", "close23"] } } }, "domain_policy_invalid:POLICY_CLOSURE_TOO_EARLY");
  erwarte({ policy: { ...POLICY, version: "v3-andere" } }, "domain_policy_version_mismatch");
  erwarte({ policy: { ...POLICY, tenant: "anderer" } }, "domain_policy_tenant_mismatch");
  erwarte({ ownerId: undefined }, "domain_owner_missing:" + DOMAIN_PORT_VARS.ownerUid);
  erwarte({}, "domain_policy_version_missing", { policyVersion: "" });
  erwarte({}, "domain_tenant_missing", { tenantId: null });
  erwarte({}, "domain_mode_invalid", { mode: "live" });
  erwarte({}, "domain_clock_missing", { now: JETZT });
  const ausUmgebung = createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => JETZT,
    ports: { read: (n) => ({ [DOMAIN_PORT_VARS.policyJson]: JSON.stringify(POLICY), [DOMAIN_PORT_VARS.ownerUid]: OWNER })[n] } });
  assert.equal(ausUmgebung.policyVersion, POLICY_VERSION); assert.equal(ausUmgebung.ownerId, OWNER);
  assert.deepEqual(describeDomainPorts({ read: () => undefined }), { ok: false, missing: [DOMAIN_PORT_VARS.policyJson, DOMAIN_PORT_VARS.ownerUid] });
  assert.deepEqual(describeDomainPorts({ ports: PORTS }), { ok: true, missing: [] });
  const env = umgebung();
  const firebase = { async readAppDataDocument() { return { exists: true, parsed: structuredClone(BASIS) }; }, async mutateAppData() { throw new Error("nicht im Test"); }, async firebaseDbGetWithEtag() { return { value: null, etag: "x" }; }, async firebaseDbSet() { return { ok: true }; } };
  R.resetRuntimeCachesForTests();
  const laufzeit = await R.buildRuntimeDeps({ write: true, read: env.read, firebaseModule: firebase, idempotencyModule: IDEM, now: () => JETZT, domainFactory: (p) => createQuantusV3DomainAdapter({ ...p, ports: PORTS }) });
  assert.equal(laufzeit.wiring.domain, true); assert.equal(laufzeit.wiring.domainReason, null); assert.equal(laufzeit.domain.tenant, TENANT);
  const ohnePorts = await R.buildRuntimeDeps({ write: true, read: env.read, firebaseModule: firebase, idempotencyModule: IDEM, now: () => JETZT, domainFactory: (p) => createQuantusV3DomainAdapter({ ...p, ports: { read: () => undefined } }) });
  assert.equal(ohnePorts.domain, null); assert.equal(ohnePorts.wiring.domainReason, "domain_factory_failed");
  const res = await lese(deps({ env, domain: ohnePorts.domain }), { query: "notes.recent", scopeId: "l1" });
  assert.equal(res.status, 503); assert.equal(res.body.reason, "domain_adapter_not_available");
  assert.deepEqual(Object.keys(VERB_BINDINGS).sort(), [...COMMAND_VERB_NAMES].sort());
  for (const [v, b] of Object.entries(VERB_BINDINGS)) assert.match(b, /^(E1\.)?[A-Za-z]+( \| [A-Za-z]+)?$/, v);
});

/* ══ 2. Lesen ════════════════════════════════════════════════════════════ */
test("C3a-02 kanonisches Lesen aus dem echten Kern: Notizinhalte, Lead, Laufkontext, Warteschlange, Status, Policy; Rechte je Rolle; GET schreibt nie; kaputter Kern ist 503", async () => {
  const d = deps();
  const notizen = await lese(d, { query: "notes.recent", scopeId: "l1" });
  assert.equal(notizen.status, 200, JSON.stringify(notizen.body));
  assert.deepEqual(notizen.body.items.map((n) => [n.id, n.text, n.leadId, n.author]), [["c3", "Dritte Rueckmeldung", "l1", "laurin"], ["c2", "Zweite Rueckmeldung", "l1", "laurin"], ["c1", "Erste Rueckmeldung", "l1", "laurin"]]);
  assert.equal(notizen.body.complete, true);
  for (const n of notizen.body.items) { assert.equal(n.tenant, undefined); assert.equal(typeof n.entityVersion, "number"); }
  const lead = await lese(d, { query: "lead.context", scopeId: "l1" });
  assert.equal(lead.status, 200); assert.deepEqual([lead.body.items[0].id, lead.body.items[0].state, lead.body.items[0].entityVersion], ["l1", "doing", ver(BASIS, "chatgptLead", "l1")]);
  assert.deepEqual(lead.body.entityVersions, { l1: ver(BASIS, "chatgptLead", "l1") });
  const doppelpunkt = await lese(d, { query: "lead.context", scopeId: "l:9" });
  assert.equal(doppelpunkt.status, 200, JSON.stringify(doppelpunkt.body)); assert.equal(doppelpunkt.body.items[0].id, "l:9");
  assert.equal((await lese(d, { query: "lead.context", scopeId: "l-9" })).body.reason, "object_not_found", "nichts wird umcodiert");
  assert.equal((await lese(d, { query: "run.context", scopeId: RUN_ID })).body.reason, "data_category_not_allowed_for_role");
  const leitung = await jobToken(d._env, { role: "lead_agent", principalId: "lead-agent-1", assignedJobIds: [RUN_ID], audience: "quantus-context" });
  const kontext = await lese(d, { query: "run.context", scopeId: RUN_ID, token: leitung });
  assert.equal(kontext.status, 200, JSON.stringify(kontext.body));
  assert.deepEqual(kontext.body.items.map((x) => x.id), ["ctx_chatgptLead_l1", "ctx_chatgptLead_l:9", "ctx_chatgptTask_c1", "ctx_task_t1"]);
  assert.equal(kontext.body.items[0].text, "Bitte Firma Muster AG als Kunde anlegen."); assert.deepEqual(kontext.body.items[0].evidenceRefs, ["ev_l1"]); assert.equal(kontext.body.complete, true);
  const warteschlange = await lese(d, { route: "quantus-read", query: "run.queue", scopeId: RUN_ID });
  assert.deepEqual(warteschlange.body.items.map((r) => [r.id, r.date, r.state, r.slot, r.entityVersion]), [[RUN_ID, DATE, "active", "process09", laufVersion(BASIS)]]);
  const policy = await lese(d, { query: "policy.current", scopeId: "policy_" + POLICY_VERSION });
  assert.equal(policy.status, 200); assert.equal(policy.body.items[0].policyVersion, POLICY_VERSION); assert.equal(policy.body.items[0].mode, "enforce");
  const status = await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: d._env.secrets.service.checker });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const s = status.body.items[0];
  assert.deepEqual([s.id, s.runId, s.state, s.stage, s.openQuestions, s.blocked], ["status_" + DATE, RUN_ID, "active", "process09", 1, true]);
  assert.equal((await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE })).status, 200, "der Eigentuemer sieht den Status");
  assert.equal((await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: nutzerToken("uid-fremd") })).status, 403);
  assert.equal(d._store.spur.mutates, 0); assert.equal(JSON.stringify(d._store.snapshot), JSON.stringify(BASIS), "GET veraendert den Bestand nicht");
  assert.equal((await lese(d, { query: "notes.recent", scopeId: "l1", token: nutzerToken("uid-fremd") })).status, 403);
  assert.equal((await lese(d, { query: "notes.recent", scopeId: "l1", token: nutzerToken(OWNER, "anderer-haushalt") })).status, 403);
  assert.equal((await lese(d, { route: "quantus-read", query: "lead.context", scopeId: "l1", token: d._env.secrets.service.scheduler })).status, 403, "Scheduler ohne Leadzugriff");
  const kaputt = deps({ store: FC.makeStore({ snapshot: { entities: { tasks: [] }, automation: { schemaVersion: 3, dataRevision: 1, idempotencyByKey: {} }, dailyBriefing: {} } }) });
  const k = await lese(kaputt, { query: "lead.context", scopeId: "l1" });
  assert.equal(k.status, 503); assert.equal(k.body.error, "core_invalid"); assert.match(k.body.reason, /^CORE_/);
});

test("C3a-03 Spezialist liest NUR seinen konkret gebundenen aktiven Auftrag — nicht die Vereinigung aller Auftraege; Ablauf, Abbruch, Quellversion, fremder Lauf zaehlen auch beim Lesen (Review 7bbbd42/1)", async () => {
  const env = umgebung();
  const claude = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist", jobId: JOB, audience: "quantus-context" });
  const d = deps({ env });
  const eigener = await lese(d, { query: "run.context", scopeId: RUN_ID, jobId: JOB, token: claude });
  assert.equal(eigener.status, 200, JSON.stringify(eigener.body));
  assert.deepEqual(eigener.body.items.map((x) => x.id), ["ctx_chatgptLead_l1", "ctx_chatgptTask_c1"], "nur Quelle und contextRefs SEINES Auftrags");
  assert.equal((await lese(d, { query: "lead.context", scopeId: "l1", jobId: JOB, token: claude })).status, 403, "kein allgemeiner Leadzugriff");
  assert.equal((await lese(d, { query: "run.context", scopeId: RUN_ID, token: claude })).body.reason, "job_mismatch", "ohne den eigenen Auftrag als jobId: C1 lehnt ab");
  const abgelaufen = structuredClone(BASIS); for (const j of Object.values(abgelaufen.automation.jobsById)) j.expiresAt = new Date(JETZT - 1).toISOString();
  const r1 = await lese(deps({ env, store: FC.makeStore({ snapshot: abgelaufen }) }), { query: "run.context", scopeId: RUN_ID, jobId: JOB, token: claude });
  assert.equal(r1.status, 403, JSON.stringify(r1.body)); assert.equal(r1.body.reason, "assignment_expired"); assert.equal(r1.body.items, undefined);
  const abgebrochen = bCmd(BASIS, "cancelJob", { jobId: JOB, reason: "Test" }, JETZT - MIN);
  assert.equal((await lese(deps({ env, store: FC.makeStore({ snapshot: abgebrochen }) }), { query: "run.context", scopeId: RUN_ID, jobId: JOB, token: claude })).body.reason, "assignment_not_active:cancelled");
  const gemini = await jobToken(env, { role: "specialist_gemini", principalId: "gemini-spezialist", jobId: JOB, audience: "quantus-context" });
  assert.equal((await lese(d, { query: "run.context", scopeId: RUN_ID, jobId: JOB, token: gemini })).body.reason, "assignment_foreign_executor");
  const veraltet = bCmd(BASIS, "transitionState", { sourceType: "chatgptTask", sourceId: "c1", state: "review", expectedVersion: ver(BASIS, "chatgptTask", "c1") }, JETZT - MIN);
  assert.equal((await lese(deps({ env, store: FC.makeStore({ snapshot: veraltet }) }), { query: "run.context", scopeId: RUN_ID, jobId: JOB, token: claude })).body.reason, "assignment_stale_source");
  const anderer = bCmd(BASIS, "ensureRun", { date: "2026-09-21" }, K.slotBeginnMs("2026-09-21", "briefing04") + MIN);
  assert.equal((await lese(deps({ env, store: FC.makeStore({ snapshot: anderer }) }), { query: "run.context", scopeId: "run_2026-09-21", jobId: JOB, token: claude })).body.reason, "assignment_run_mismatch");
  const unbekannt = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist", jobId: "job_gibt_es_nicht", audience: "quantus-context" });
  assert.equal((await lese(d, { query: "run.context", scopeId: RUN_ID, jobId: "job_gibt_es_nicht", token: unbekannt })).body.reason, "object_not_found");
  const zweiter = bCmd(BASIS, "createJob", { jobId: "job_l9_claude", kind: "recherche", purpose: "zweiter Claude-Auftrag", sourceType: "chatgptLead", sourceId: "l:9", inputVersion: ver(BASIS, "chatgptLead", "l:9"), executor: "claude", contextRefs: [{ sourceType: "task", sourceId: "t1" }], expiresAt: new Date(JETZT + STD).toISOString() }, JETZT - 5 * MIN);
  const seite = adapter().listPage(zweiter, { query: "run.context", scopeId: RUN_ID, pageSize: 10, afterId: null, principal: { role: "specialist_claude", jobId: JOB, tenant: TENANT, id: "claude-spezialist" } });
  assert.deepEqual(seite.items.map((x) => [x.id, x.jobId]), [["ctx_chatgptLead_l1", JOB], ["ctx_chatgptTask_c1", JOB]], "der zweite Claude-Auftrag (l:9, t1) bleibt unsichtbar");
});

test("C3a-04 Seiten: vollstaendig oder ehrlich abgebrochen", async () => {
  const d = deps();
  const erste = await lese(d, { query: "notes.recent", scopeId: "l1", pageSize: 2 });
  assert.deepEqual(erste.body.items.map((n) => n.id), ["c3", "c2"]); assert.equal(erste.body.complete, false); assert.ok(erste.body.cursor);
  const zweite = await lese(d, { query: "notes.recent", scopeId: "l1", pageSize: 2, cursor: erste.body.cursor });
  assert.deepEqual(zweite.body.items.map((n) => n.id), ["c1"]); assert.equal(zweite.body.complete, true); assert.equal(zweite.body.cursor, null);
  const a = d.domain;
  assert.deepEqual(a.listPage(BASIS, { query: "notes.recent", scopeId: "l1", pageSize: 2, afterId: "c_gibt_es_nicht", principal: {} }), { items: [], hasMore: false, nextAfterId: null, aborted: true, abortReason: "after_id_unknown" });
  const alle = a.listPage(BASIS, { query: "run.context", scopeId: RUN_ID, pageSize: 3, afterId: null, principal: { role: "lead_agent" } });
  assert.equal(alle.hasMore, true); assert.equal(alle.nextAfterId, "ctx_chatgptTask_c1"); assert.equal(alle.total, 4);
  assert.deepEqual(a.listPage(BASIS, { query: "run.context", scopeId: RUN_ID, pageSize: 3, afterId: alle.nextAfterId, principal: { role: "lead_agent" } }).items.map((x) => x.id), ["ctx_task_t1"]);
  assert.equal(a.listPage(BASIS, { query: "run.context", scopeId: "run_9999-01-01", pageSize: 3, afterId: null, principal: {} }).abortReason, "scope_not_found");
  assert.throws(() => a.listPage({ entities: {}, automation: {} }, { query: "run.queue", scopeId: RUN_ID, pageSize: 3, afterId: null, principal: {} }), (e) => e.code === "core_invalid" && e.status === 503);
  assert.throws(() => a.loadObject({ entities: {}, automation: {} }, { kind: "lead", id: "l1" }), (e) => e.code === "core_invalid" && e.status === 503);
});

/* ══ 3. Vertikal: ein Kern-Kommando ueber C2 + echte Idempotenz ══════════ */
test("C3a-05 lead.transition wirkt als B.transitionState — nachgelesen, wiederholt, CAS-geprueft, versionsgesichert; Kern-Konflikte sind domain_conflict", async () => {
  const d = deps();
  const v0 = ver(BASIS, "chatgptLead", "l1");
  const payload = { leadId: "l1", toState: "done", evidenceRefs: ["ev_l1"], reason: "Kunde angelegt" };
  const r = mussOk(await sende(d, { verb: "lead.transition", payload, expectedEntityVersion: v0, idempotencyKey: "k-done-l1" }), "done");
  assert.deepEqual(r.body.entityVersions, { l1: v0 + 1 }); assert.equal(r.body.effect.state, "done"); assert.equal(r.body.command, "transitionState");
  const nach = d._store.snapshot;
  assert.equal(K.effektiverZustand("chatgptLead", nach.entities.chatgptLeads.l1).state, "done");
  assert.equal(nach.entities.chatgptLeads.l1.operationalStateSource.closure.evidenceId, "ev_l1");
  assert.equal(nach.entities.chatgptLeads.l1.status, "in_arbeit", "der Altstatus wird nicht zurueckgeschrieben");
  assert.equal((await lese(d, { query: "lead.context", scopeId: "l1" })).body.items[0].state, "done");
  const wieder = await sende(d, { verb: "lead.transition", payload, expectedEntityVersion: v0, idempotencyKey: "k-done-l1" });
  assert.equal(wieder.body.replayed, true); assert.deepEqual(wieder.body.entityVersions, { l1: v0 + 1 }); assert.equal(d._store.snapshot.automation.dataRevision, nach.automation.dataRevision);
  assert.equal((await sende(d, { verb: "lead.transition", payload: { ...payload, reason: "anders" }, expectedEntityVersion: v0, idempotencyKey: "k-done-l1" })).body.error, "idempotency_conflict");
  assert.equal((await sende(d, { verb: "lead.transition", payload: { leadId: "l1", toState: "doing", reason: "auf" }, expectedEntityVersion: v0, idempotencyKey: "k-alt" })).body.error, "stale_entity_version");
  const verboten = await sende(d, { verb: "lead.transition", payload: { leadId: "l1", toState: "review" }, expectedEntityVersion: v0 + 1, idempotencyKey: "k-rev" });
  assert.equal(verboten.status, 409); assert.equal(verboten.body.error, "domain_conflict"); assert.equal(verboten.body.reason, "TRANSITION_NOT_ALLOWED");
  assert.equal(Object.keys(d._store.snapshot.automation.idempotencyByKey).length, 1, "Ablehnungen hinterlassen keine Quittung");
  const d2 = deps();
  assert.equal((await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "done" }, expectedEntityVersion: v0 })).body.reason, "DONE_EVIDENCE_MISSING");
  assert.equal((await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "waiting_external" }, expectedEntityVersion: v0 })).body.reason, "use_lead_schedule_for_waiting");
  assert.equal((await sende(d2, { verb: "lead.transition", payload: { leadId: "l1", toState: "done", evidenceRefs: ["ev_fremd"] }, expectedEntityVersion: v0 })).body.reason, "evidence_ref_unknown");
  assert.equal((await sende(d2, { verb: "lead.transition", payload, expectedEntityVersion: v0, token: nutzerToken("uid-fremd") })).body.reason, "object_not_owned");
  assert.equal((await sende(d2, { verb: "lead.transition", payload, expectedEntityVersion: v0, token: nutzerToken(OWNER, "anderer") })).status, 403);
  assert.equal(JSON.stringify(d2._store.snapshot), JSON.stringify(BASIS), "Ablehnungen schreiben nichts");
  const dp = mussOk(await sende(d2, { verb: "lead.transition", payload: { leadId: "l:9", toState: "review" }, expectedEntityVersion: ver(BASIS, "chatgptLead", "l:9"), idempotencyKey: "k-dp" }), "l:9");
  assert.equal(K.effektiverZustand("chatgptLead", d2._store.snapshot.entities.chatgptLeads["l:9"]).state, "review"); assert.deepEqual(Object.keys(dp.body.entityVersions), ["l:9"]);
  const d3 = deps({ store: FC.makeStore({ snapshot: BASIS, conflictsBefore: 2 }) });
  mussOk(await sende(d3, { verb: "lead.transition", payload, expectedEntityVersion: v0, idempotencyKey: "k-cas" }), "cas"); assert.equal(d3._store.spur.mutatorCalls, 3);
  assert.equal(K.effektiverZustand("chatgptLead", d3._store.snapshot.entities.chatgptLeads.l1).version, v0 + 1);
  assert.equal((await sende(deps({ store: FC.makeStore({ snapshot: BASIS, unknownOutcome: true }) }), { verb: "lead.transition", payload, expectedEntityVersion: v0 })).status, 503);
  const pruefung = await sende(deps(), { verb: "lead.transition", payload, expectedEntityVersion: v0, validateOnly: true });
  assert.equal(pruefung.body.validated, true); assert.equal(pruefung.body.observedEntityVersion, v0);
});

/* ══ 4. Nutzerverben ═════════════════════════════════════════════════════ */
test("C3a-06 Nutzer: intake.create/accept, task.create, lead.comment, briefing.answer, question.resolve, document.register, note.append — positiv und negativ", async () => {
  const d = deps();
  const in1 = mussOk(await sende(d, { verb: "intake.create", payload: { source: "manual", title: "Neue Anfrage", text: "Bitte Offerte pruefen", intakeId: "intake_1" }, idempotencyKey: "k-in" }), "intake");
  assert.equal(d._store.snapshot.automation.intakeById.intake_1.text, "Neue Anfrage\nBitte Offerte pruefen"); assert.equal(d._store.snapshot.automation.intakeById.intake_1.registeredBy, OWNER);
  const in2 = mussOk(await sende(d, { verb: "intake.create", payload: { source: "mail", title: "Ohne Kennung" }, idempotencyKey: "k-in2" }), "intake abgeleitet");
  assert.match(Object.keys(in2.body.entityVersions)[0], /^intake_[0-9a-f]{32}$/);
  assert.equal((await sende(d, { verb: "intake.create", payload: { source: "manual", title: "anders", intakeId: "intake_1" }, idempotencyKey: "k-in3" })).body.reason, "INTAKE_IMMUTABLE:intake_1");
  const iv = in1.body.entityVersions.intake_1;
  const acc = mussOk(await sende(d, { verb: "intake.accept", payload: { intakeId: "intake_1", leadId: "l1" }, expectedEntityVersion: iv, idempotencyKey: "k-acc" }), "accept");
  assert.deepEqual(d._store.snapshot.automation.intakeById.intake_1.linkedTo, { sourceType: "chatgptLead", sourceId: "l1" }); assert.notEqual(acc.body.entityVersions.intake_1, iv);
  assert.equal((await sende(d, { verb: "intake.accept", payload: { intakeId: "intake_1" }, expectedEntityVersion: iv })).body.error, "stale_entity_version");
  const t = mussOk(await sende(d, { verb: "task.create", payload: { leadId: "l1", title: "Offerte nachfassen", dueAt: "2026-09-25T21:30:00Z", notes: "bis Freitag", taskId: "t_neu" }, idempotencyKey: "k-task" }), "task");
  const aufgabe = d._store.snapshot.entities.tasks.t_neu;
  assert.deepEqual([aufgabe.title, aufgabe.dueDate, aufgabe.linkedChatgptLeads, aufgabe.createdBy, K.effektiverZustand("task", aufgabe).state], ["Offerte nachfassen", "2026-09-25", ["l1"], OWNER, "doing"]);
  assert.deepEqual(t.body.entityVersions, { t_neu: 1, l1: ver(BASIS, "chatgptLead", "l1") });
  assert.equal((await sende(d, { verb: "task.create", payload: { leadId: "l_fremd", title: "x" } })).body.reason, "object_not_found", "der Anker-Lead muss existieren");
  mussOk(await sende(d, { verb: "lead.comment", payload: { leadId: "l1", text: "Kunde hat angerufen", evidenceRefs: ["ev_l1"], commentId: "c4" }, expectedEntityVersion: ver(BASIS, "chatgptLead", "l1"), idempotencyKey: "k-com" }), "comment");
  assert.deepEqual(d._store.snapshot.entities.chatgptLeads.l1.comments.at(-1), { id: "c4", text: "Kunde hat angerufen", createdAt: new Date(JETZT).toISOString(), author: OWNER, authorKind: "user", evidenceRefs: ["ev_l1"] });
  assert.equal((await lese(d, { query: "notes.recent", scopeId: "l1" })).body.items[0].text, "Kunde hat angerufen");
  assert.equal((await sende(d, { verb: "lead.comment", payload: { leadId: "l1", text: "x", evidenceRefs: ["ev_erfunden"] }, expectedEntityVersion: ver(BASIS, "chatgptLead", "l1") })).body.reason, "EVIDENCE_REF_UNKNOWN:ev_erfunden");
  assert.equal((await sende(d, { verb: "lead.comment", payload: { leadId: "l1", text: "anders", commentId: "c4" }, expectedEntityVersion: ver(BASIS, "chatgptLead", "l1") })).body.reason, "COMMENT_IMMUTABLE:c4");
  const ans = mussOk(await sende(d, { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "Muster AG", answerId: "a_c1" }, idempotencyKey: "k-ans" }), "answer");
  assert.equal(d._store.snapshot.automation.answersById.a_c1.answeredBy, OWNER); assert.equal(d._store.snapshot.automation.questionsById.q_c1.status, "answered"); assert.ok("q_c1" in ans.body.entityVersions);
  assert.equal((await sende(d, { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "anders" } })).body.reason, "QUESTION_NOT_OPEN:answered");
  assert.equal((await sende(d, { verb: "briefing.answer", payload: { briefingId: "run_2026-09-19", questionId: "q_c1", answer: "x" } })).body.reason, "object_not_found");
  const d2 = deps({ store: FC.makeStore({ snapshot: bCmd(BASIS, "askQuestion", { questionId: "q_l1", sourceType: "chatgptLead", sourceId: "l1", text: "Adresse?", date: DATE }, JETZT - MIN) }) });
  const qv = d2.domain.loadObject(d2._store.snapshot, { kind: "question", id: "q_l1" }).entityVersion;
  mussOk(await sende(d2, { verb: "question.resolve", payload: { questionId: "q_l1", answer: "Bahnhofstrasse 1" }, expectedEntityVersion: qv, idempotencyKey: "k-res" }), "resolve");
  assert.equal(d2._store.snapshot.automation.questionsById.q_l1.status, "answered");
  assert.equal((await sende(d2, { verb: "question.resolve", payload: { questionId: "q_l1", answer: "x" }, expectedEntityVersion: qv })).body.error, "stale_entity_version");
  const doc = mussOk(await sende(d, { verb: "document.register", payload: { documentId: "doc_1", title: "Vertrag", attachmentRef: ATT("vertrag.pdf"), contentHash: "a".repeat(64), origin: "upload", mime: "application/pdf", size: 1234, leadId: "l1" }, idempotencyKey: "k-doc" }), "document");
  const dok = d._store.snapshot.automation.documentsById.doc_1;
  assert.deepEqual([dok.attachmentId, dok.hash, dok.mime, dok.size, dok.origin.channel, dok.linkedTo.sourceId, dok.registeredBy, dok.status], [ATT("vertrag.pdf"), "a".repeat(64), "application/pdf", 1234, "upload", "l1", OWNER, "open"]);
  assert.match(dok.origin.ref, /^req-\d+$/, "die Herkunftsreferenz ist die Anfragekennung des Umschlags"); assert.ok("doc_1" in doc.body.entityVersions);
  assert.equal((await sende(d, { verb: "document.register", payload: { documentId: "doc_2", title: "V", attachmentRef: "attachment-text__kaputt", contentHash: "a".repeat(64), origin: "upload", mime: "application/pdf", size: 1, leadId: "l1" } })).body.reason, "DOCUMENT_ATTACHMENT_ID_INVALID:attachment-text__kaputt", "der Kern prueft den Anhangsschluessel");
  assert.equal((await sende(d, { verb: "document.register", payload: { documentId: "doc_1", title: "V", attachmentRef: ATT("anders.pdf"), contentHash: "b".repeat(64), origin: "upload", mime: "application/pdf", size: 1, leadId: "l1" } })).body.reason, "DOCUMENT_IMMUTABLE:doc_1");
  mussOk(await sende(d, { verb: "note.append", payload: { noteId: "note_u1", text: "Bank hat bestaetigt", noteScope: "lead", leadId: "l1" }, idempotencyKey: "k-note" }), "note");
  const note = d._store.snapshot.entities.chatgptNotes.note_u1;
  assert.deepEqual([note.instruction, note.assistantNote.kind, note.assistantNote.runDate, note.linkedChatgptLeads, note.author], ["Bank hat bestaetigt", "assistantEntry", DATE, ["l1"], OWNER]);
  assert.deepEqual(d._store.snapshot.dailyBriefing.assistantRuns[DATE].noteIds, ["note_u1"]);
  assert.equal((await sende(d, { verb: "note.append", payload: { noteId: "note_u2", text: "x", noteScope: "lead" } })).body.reason, "lead_id_required_for_lead_scope");
  assert.equal((await sende(d, { verb: "note.append", payload: { noteId: "note_u1", text: "anders", noteScope: "run" } })).body.reason, "NOTE_ID_TAKEN:note_u1");
  assert.equal((await sende(d, { verb: "note.append", payload: { noteId: "note_p1", text: "Pruefer", noteScope: "run" }, token: d._env.secrets.service.checker })).status, 200);
  assert.equal((await sende(d, { verb: "lead.schedule", payload: { leadId: "l1", waitUntil: new Date(JETZT + 2 * TAG).toISOString(), counterparty: "Bank", nextAction: "nachfragen", evidenceRefs: ["ev_l1"] }, expectedEntityVersion: ver(BASIS, "chatgptLead", "l1") })).body.reason, "ACTOR_REJECTED:ACTOR_NOT_ALLOWED:user", "B erlaubt setWaiting nur der Leitung");
});

/* ══ 5. Leitung: Lease MITGEFUEHRT, je Versuch geprueft ═════════════════ */
test("C3a-07 Leitung: ohne praesentierte Lease, mit falschem Fence, fremdem Halter, abgelaufener oder fremder Lease 403 (Review 7bbbd42/2); mit gueltiger Lease wirken question.create, lead.schedule, worker.assign, worker.review, run.checkpoint, run.log, document.processed, task.create, lead.comment", async () => {
  const env = umgebung();
  const token = await jobToken(env, { role: "lead_agent", principalId: "lead-agent-1", assignedJobIds: [RUN_ID] });
  const v0 = ver(BASIS, "chatgptLead", "l1");
  const frage = { leadId: "l1", text: "Welche Adresse?", questionId: "q_l1" };
  const ohne = deps({ env });
  const r0 = await sende(ohne, { verb: "question.create", payload: frage, token, lease: { holder: "cloud-scheduler", fence: 1 } });
  assert.equal(r0.status, 403); assert.equal(r0.body.reason, "lease_absent"); assert.equal(ohne._store.spur.mutatorCalls, 1, "im CAS geprueft, nichts geschrieben");
  const { data: mit, lease } = mitLease(BASIS);
  const d = deps({ env, store: FC.makeStore({ snapshot: mit }) });
  assert.equal((await sende(d, { verb: "question.create", payload: frage, token })).body.reason, "lease_not_presented", "die Leitung muss die Lease mitfuehren");
  assert.equal((await sende(d, { verb: "question.create", payload: frage, token, lease: { holder: lease.holder, fence: lease.fence + 1 } })).body.reason, "lease_fenced", "Review (2): der Fence kommt vom Claimenden und wird durch E1 geprueft, nicht aus der Lease ersetzt");
  assert.equal((await sende(d, { verb: "question.create", payload: frage, token, lease: { holder: "anderer", fence: lease.fence } })).body.reason, "lease_foreign_holder");
  const abgelaufen = mitLease(BASIS, { at: JETZT - 130000 });
  assert.equal((await sende(deps({ env, store: FC.makeStore({ snapshot: abgelaufen.data }) }), { verb: "question.create", payload: frage, token, lease: abgelaufen.lease })).body.reason, "lease_expired");
  const gestern = mitLease(bCmd(BASIS, "ensureRun", { date: "2026-09-19" }, JETZT - TAG), { slot: "close23" });
  gestern.data.automation.activeLease.scope = K.slotKey(TENANT, "2026-09-19", "close23", POLICY_VERSION);
  assert.equal((await sende(deps({ env, store: FC.makeStore({ snapshot: gestern.data }) }), { verb: "question.create", payload: frage, token, lease: gestern.lease })).body.reason, "lease_scope_mismatch", "eine Lease eines anderen Tages bindet nicht");
  assert.equal(JSON.stringify(d._store.snapshot), JSON.stringify(mit), "keine Wirkung ohne gueltige Bindung");
  // Direkt am Adapter, Review (2) wortgleich: Fence = gespeicherter Fence − 1 wird NICHT akzeptiert
  // (zweite Lease nach Ablauf der ersten: Fence 2; praesentiert wird 1).
  const erste = mitLease(BASIS, { at: JETZT - 200000 });
  const zweite = mitLease(erste.data, { at: JETZT - 1000 });
  assert.equal(zweite.data.automation.activeLease.fence, 2);
  const bindung = (fence) => adapter().assertActiveBinding({ snapshot: zweite.data, principal: { role: "lead_agent", id: "lead-agent-1", tenant: TENANT }, jobId: RUN_ID, nowMs: JETZT, command: { lease: { holder: "cloud-scheduler", fence } } });
  assert.deepEqual(bindung(1), { ok: false, reason: "lease_fenced" }, "ein Fence unter dem gespeicherten darf nie gelten");
  assert.deepEqual(bindung(0), { ok: false, reason: "lease_invalid" });
  assert.deepEqual(bindung(2), { ok: true });
  // Gueltig: question.create mit Optionen.
  const q = mussOk(await sende(d, { verb: "question.create", payload: { ...frage, options: ["Bahnhofstrasse", "Postfach"] }, token, lease, idempotencyKey: "k-q" }), "question");
  assert.deepEqual([d._store.snapshot.automation.questionsById.q_l1.askedBy, d._store.snapshot.automation.questionsById.q_l1.runDate, d._store.snapshot.automation.questionsById.q_l1.options], ["lead-agent-1", DATE, ["Bahnhofstrasse", "Postfach"]]);
  assert.ok("q_l1" in q.body.entityVersions && "l1" in q.body.entityVersions);
  // Ein CAS-Konflikt prueft die Bindung in jedem Versuch neu: verschwindet die Lease vor dem zweiten Versuch, ist es 403.
  let versuch = 0;
  const flatternd = FC.makeStore({ snapshot: mit, conflictsBefore: 1 });
  const echtesMutate = flatternd.mutate.bind(flatternd);
  flatternd.mutate = async (k, mutator, o) => echtesMutate(k, (aktuell) => { versuch += 1; if (versuch === 2) { const w = structuredClone(aktuell); w.automation.activeLease = null; return mutator(w); } return mutator(aktuell); }, o);
  const fl = await sende(deps({ env, store: flatternd }), { verb: "run.log", payload: { event: "tick", eventId: "ev_fl" }, token, lease, expectedEntityVersion: laufVersion(mit) });
  assert.equal(fl.status, 403); assert.equal(fl.body.reason, "lease_absent"); assert.equal(versuch, 2);
  // lead.schedule: Warten auf den Nutzer ueber die gestellte Frage.
  const warten = mussOk(await sende(d, { verb: "lead.schedule", payload: { leadId: "l1", waitUntil: new Date(JETZT + 2 * TAG).toISOString(), counterparty: "user", nextAction: "Antwort abwarten", evidenceRefs: ["q_l1"] }, token, lease, expectedEntityVersion: v0, idempotencyKey: "k-wait" }), "schedule");
  const w = d._store.snapshot.automation.waitingById["chatgptLead:l1"];
  assert.deepEqual([w.state, w.evidence.kind, w.evidence.questionId, w.setBy], ["waiting_user", "question", "q_l1", "lead-agent-1"]); assert.deepEqual(warten.body.entityVersions, { l1: v0 + 1 });
  assert.match((await sende(d, { verb: "lead.schedule", payload: { leadId: "l:9", waitUntil: new Date(JETZT + 2 * TAG).toISOString(), counterparty: "chatgpt", nextAction: "x", evidenceRefs: ["ev_l1"] }, token, lease, expectedEntityVersion: ver(BASIS, "chatgptLead", "l:9") })).body.reason, /^WAITING_INCOMPLETE:.*WAIT_COUNTERPARTY_SELF/);
  assert.match((await sende(d, { verb: "lead.schedule", payload: { leadId: "l:9", waitUntil: new Date(JETZT - MIN).toISOString(), counterparty: "Bank", nextAction: "x", evidenceRefs: ["ev_l1"] }, token, lease, expectedEntityVersion: ver(BASIS, "chatgptLead", "l:9") })).body.reason, /^WAITING_INCOMPLETE:WAIT_FOLLOWUP_PAST/);
  // worker.assign: ein echter Auftrag (createJob) mit aufgeloesten Kontextreferenzen.
  const auftrag = { assignmentId: "job_l9_gemini", executor: "gemini", sourceVersion: ver(BASIS, "chatgptLead", "l:9"), allowedContextIds: ["t1", "ev_l1", "c1"], dueAt: new Date(JETZT + 2 * STD).toISOString(), sourceType: "chatgptLead", sourceId: "l:9", purpose: "Adresse recherchieren", jobKind: "recherche" };
  const assign = mussOk(await sende(d, { verb: "worker.assign", payload: auftrag, token, lease, idempotencyKey: "k-assign" }), "assign");
  const j = d._store.snapshot.automation.jobsById.job_l9_gemini;
  assert.deepEqual([j.executor, j.sourceId, j.purpose, j.kind, j.state, j.createdBy, j.contextRefs], ["gemini", "l:9", "Adresse recherchieren", "recherche", "queued", "lead-agent-1", [{ sourceType: "task", sourceId: "t1" }, { sourceType: "evidence", sourceId: "ev_l1" }, { sourceType: "chatgptTask", sourceId: "c1" }]]);
  assert.equal(d._store.snapshot.automation.outboxById["job:job_l9_gemini"].mode, "dry_run"); assert.ok("job_l9_gemini" in assign.body.entityVersions);
  assert.equal((await sende(d, { verb: "worker.assign", payload: { ...auftrag, assignmentId: "job_x", sourceVersion: 99 }, token, lease })).body.reason, "VERSION_MISMATCH");
  assert.equal((await sende(d, { verb: "worker.assign", payload: { ...auftrag, assignmentId: "job_x", allowedContextIds: ["gibt_es_nicht"] }, token, lease })).body.reason, "context_ref_unknown");
  assert.match((await sende(d, { verb: "worker.assign", payload: { ...auftrag, assignmentId: "job_x", dueAt: new Date(JETZT + 8 * TAG).toISOString() }, token, lease })).body.reason, /^JOB_EXPIRES_INVALID/);
  // worker.review nach einer echten Rueckgabe (B, Worker): das Ergebnis ist der Auftrag.
  const zurueck = bCmd(d._store.snapshot, "recordJobReturn", { jobId: JOB, outcome: "returned", resultRef: "res_c1", resultHash: "a".repeat(64), summary: "drei Treffer" }, JETZT - MIN, { kind: "worker", id: "claude-spezialist" });
  const d3 = deps({ env, store: FC.makeStore({ snapshot: zurueck }) });
  const ergV = d3.domain.loadObject(zurueck, { kind: "worker_result", id: "res_c1" }).entityVersion;
  const review = mussOk(await sende(d3, { verb: "worker.review", payload: { resultId: "res_c1", verdict: "accepted", notes: "passt" }, token, lease, expectedEntityVersion: ergV, idempotencyKey: "k-rev" }), "review");
  assert.deepEqual([zurueck.automation.jobsById[JOB].review, d3._store.snapshot.automation.jobsById[JOB].review.verdict, d3._store.snapshot.automation.jobsById[JOB].review.reviewer], [null, "accepted", "lead-agent-1"]);
  assert.equal(K.effektiverZustand("chatgptTask", d3._store.snapshot.entities.chatgptTasks.c1).state, "review"); assert.ok("res_c1" in review.body.entityVersions);
  assert.equal((await sende(d3, { verb: "worker.review", payload: { resultId: "res_c1", verdict: "rejected" }, token, lease, expectedEntityVersion: review.body.entityVersions.res_c1 })).body.reason, "JOB_ALREADY_REVIEWED:accepted");
  assert.equal((await sende(d3, { verb: "worker.review", payload: { resultId: "res_unbekannt", verdict: "accepted" }, token, lease })).body.reason, "object_not_found");
  // run.checkpoint und run.log fuehren den Lauf fort.
  const rv = laufVersion(d._store.snapshot);
  const cp = mussOk(await sende(d, { verb: "run.checkpoint", payload: { stage: "lesen", note: "Posteingang gesichtet", checkpointId: "cp_1" }, token, lease, expectedEntityVersion: rv, idempotencyKey: "k-cp" }), "checkpoint");
  assert.deepEqual(d._store.snapshot.dailyBriefing.assistantRuns[DATE].lastCheckpoint, { id: "cp_1", stage: "lesen", at: new Date(JETZT).toISOString() }); assert.deepEqual(cp.body.entityVersions, { [RUN_ID]: rv + 1 });
  assert.equal((await lese(d, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: env.secrets.service.checker })).body.items[0].stage, "lesen");
  mussOk(await sende(d, { verb: "run.log", payload: { event: "mail_gelesen", detail: "3 Nachrichten", eventId: "ev_1" }, token, lease, expectedEntityVersion: rv + 1, idempotencyKey: "k-log" }), "log");
  assert.deepEqual(d._store.snapshot.dailyBriefing.assistantRuns[DATE].events.map((e) => [e.id, e.event, e.detail, e.by]), [["ev_1", "mail_gelesen", "3 Nachrichten", "lead-agent-1"]]);
  assert.equal((await sende(d, { verb: "run.checkpoint", payload: { stage: "anders", checkpointId: "cp_1" }, token, lease, expectedEntityVersion: rv + 2 })).body.reason, "CHECKPOINT_IMMUTABLE:cp_1");
  assert.equal((await sende(d, { verb: "run.log", payload: { event: "x" }, token, lease, expectedEntityVersion: rv })).body.error, "stale_entity_version");
  // document.processed: Parse-Ergebnis der Leitung auf einem Nutzer-Dokument.
  const mitDok = bCmd(mit, "registerDocument", { documentId: "doc_1", attachmentId: ATT("vertrag.pdf"), name: "Vertrag", hash: "a".repeat(64), mime: "application/pdf", size: 1, origin: { channel: "upload", ref: "x" }, linkedTo: { sourceType: "chatgptLead", sourceId: "l1" } }, JETZT - MIN, USER_B);
  const d4 = deps({ env, store: FC.makeStore({ snapshot: mitDok }) });
  const dv = d4.domain.loadObject(mitDok, { kind: "document", id: "doc_1" }).entityVersion;
  mussOk(await sende(d4, { verb: "document.processed", payload: { documentId: "doc_1", extractionRef: ATT("vertrag.txt"), contentHash: "c".repeat(64) }, token, lease, expectedEntityVersion: dv, idempotencyKey: "k-parse" }), "processed");
  assert.deepEqual([d4._store.snapshot.automation.documentsById.doc_1.parse.outcome, d4._store.snapshot.automation.documentsById.doc_1.parse.textRef, d4._store.snapshot.automation.documentsById.doc_1.parse.checkedBy], ["parsed", ATT("vertrag.txt"), "lead-agent-1"]);
  assert.equal((await sende(d4, { verb: "document.processed", payload: { documentId: "doc_1", extractionRef: ATT("nochmal.txt"), contentHash: "c".repeat(64) }, token, lease, expectedEntityVersion: dv })).body.error, "stale_entity_version");
  assert.equal((await sende(deps({ env, store: FC.makeStore({ snapshot: mitDok }) }), { verb: "document.processed", payload: { documentId: "doc_1", extractionRef: "attachment-text__kaputt", contentHash: "c".repeat(64) }, token, lease, expectedEntityVersion: dv })).body.reason, "PARSE_TEXTREF_INVALID:attachment-text__kaputt");
  // task.create und lead.comment durch die Leitung (Akteur agent).
  mussOk(await sende(d, { verb: "task.create", payload: { leadId: "l:9", title: "Adresse pruefen", taskId: "t_agent" }, token, lease, idempotencyKey: "k-tagent" }), "task agent");
  assert.equal(d._store.snapshot.entities.tasks.t_agent.createdBy, "lead-agent-1");
  mussOk(await sende(d, { verb: "lead.comment", payload: { leadId: "l:9", text: "Recherche laeuft", commentId: "c_agent" }, token, lease, expectedEntityVersion: ver(BASIS, "chatgptLead", "l:9"), idempotencyKey: "k-cagent" }), "comment agent");
  assert.equal(d._store.snapshot.entities.chatgptLeads["l:9"].comments[0].authorKind, "agent");
  const fremd = await jobToken(env, { role: "lead_agent", principalId: "lead-agent-1", jobId: "run_2026-09-21", assignedJobIds: ["run_2026-09-21"] });
  assert.equal((await sende(d, { verb: "question.create", payload: frage, token: fremd, jobId: "run_2026-09-21", lease })).status, 403);
});

/* ══ 6. Scheduler und Pruefer ════════════════════════════════════════════ */
test("C3a-08 Scheduler/Pruefer: run.ensure quittiert den Slot, run.claim liefert den Fence, run.renew braucht ihn, TTL 10..120 s, run.sourceCheck, consumeAnswer, finalize", async () => {
  const env = umgebung();
  const sched = env.secrets.service.scheduler, checker = env.secrets.service.checker;
  const d = deps({ env });
  const morgen = "2026-09-21", morgenId = "run_" + morgen, m4 = K.slotBeginnMs(morgen, "briefing04") + MIN;
  const dm = deps({ env, now: m4 });
  const ensure = mussOk(await sende(dm, { verb: "run.ensure", payload: { slot: "04:00", date: morgen, receiptId: "rcpt_m4" }, token: sched, jobId: morgenId, expectedEntityVersion: 0, idempotencyKey: "k-ens" }), "ensure");
  const lauf = dm._store.snapshot.dailyBriefing.assistantRuns[morgen];
  assert.deepEqual([ensure.body.effect.created, ensure.body.effect.receiptCreated, lauf.phase, lauf.slotReceipts.briefing04.receiptId, lauf.policyVersion], [true, true, "active", "rcpt_m4", POLICY_VERSION]);
  assert.deepEqual(ensure.body.entityVersions, { [morgenId]: 1 });
  assert.equal((await sende(dm, { verb: "run.ensure", payload: { slot: "04:00", date: morgen, receiptId: "rcpt_m4" }, token: sched, jobId: morgenId, expectedEntityVersion: 1, idempotencyKey: "k-ens2" })).body.effect.receiptCreated, false, "Wiederholung ist ein No-op");
  assert.equal((await sende(dm, { verb: "run.ensure", payload: { slot: "09:00", date: morgen }, token: sched, jobId: morgenId, expectedEntityVersion: 1 })).body.reason, "SLOT_NOT_STARTED", "kein Slot vor seiner Zeit");
  assert.equal((await sende(dm, { verb: "run.ensure", payload: { slot: "04:00", date: "2026-09-22" }, token: sched, jobId: morgenId, expectedEntityVersion: 1 })).body.reason, "run_id_date_mismatch");
  assert.equal((await sende(dm, { verb: "run.ensure", payload: { slot: "04:00", date: morgen, receiptId: "anders" }, token: sched, jobId: morgenId, expectedEntityVersion: 1 })).body.reason, "SLOT_ALREADY_RECEIPTED");
  const rv = laufVersion(BASIS);
  const claim = mussOk(await sende(d, { verb: "run.claim", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv, idempotencyKey: "k-claim" }), "claim");
  assert.deepEqual([claim.body.effect.acquired, claim.body.effect.fence, claim.body.effect.scope], [true, 1, K.slotKey(TENANT, DATE, "process09", POLICY_VERSION)]);
  assert.equal(d._store.snapshot.automation.activeLease.holder, "cloud-scheduler"); assert.equal(d._store.snapshot.automation.activeLease.expiresAtMs, JETZT + 60000);
  assert.equal(E1.checkLeadership(d._store.snapshot, { holder: "cloud-scheduler", scope: claim.body.effect.scope, fence: 1 }, JETZT).ok, true);
  assert.equal((await lese(d, { route: "quantus-read", query: "run.queue", scopeId: RUN_ID, token: sched })).body.items[0].leaseExpiresAt, new Date(JETZT + 60000).toISOString());
  assert.equal((await sende(d, { verb: "run.claim", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv, idempotencyKey: "k-claim2" })).body.effect.duplicate, true);
  assert.equal((await sende(d, { verb: "run.claim", payload: { leaseSeconds: 121 }, token: sched, expectedEntityVersion: rv })).body.reason, "field_invalid:leaseSeconds", "der Umschlag kennt den E1-Vertrag");
  assert.equal((await sende(d, { verb: "run.claim", payload: { leaseSeconds: 9 }, token: sched, expectedEntityVersion: rv })).body.reason, "field_invalid:leaseSeconds");
  const fremdeLease = deps({ env, store: FC.makeStore({ snapshot: mitLease(BASIS, { holder: "anderer" }).data }) });
  assert.equal((await sende(fremdeLease, { verb: "run.claim", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv })).body.reason, "lease:lease_held");
  const lease = { holder: "cloud-scheduler", fence: claim.body.effect.fence };
  assert.equal((await sende(d, { verb: "run.renew", payload: { leaseSeconds: 90 }, token: sched, expectedEntityVersion: rv })).body.reason, "lease_not_presented");
  assert.equal((await sende(d, { verb: "run.renew", payload: { leaseSeconds: 90 }, token: sched, expectedEntityVersion: rv, lease: { holder: "cloud-scheduler", fence: 2 } })).body.reason, "lease:lease_fenced");
  assert.equal((await sende(d, { verb: "run.renew", payload: { leaseSeconds: 90 }, token: sched, expectedEntityVersion: rv, lease: { holder: "anderer", fence: 1 } })).body.reason, "lease_holder_mismatch");
  const renew = mussOk(await sende(d, { verb: "run.renew", payload: { leaseSeconds: 90 }, token: sched, expectedEntityVersion: rv, lease, idempotencyKey: "k-renew" }), "renew");
  assert.equal(renew.body.effect.renewed, true); assert.equal(d._store.snapshot.automation.activeLease.expiresAtMs, JETZT + 90000);
  assert.equal((await sende(deps({ env }), { verb: "run.renew", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv, lease })).body.reason, "lease:lease_absent");
  assert.equal((await sende(fremdeLease, { verb: "run.renew", payload: { leaseSeconds: 60 }, token: sched, expectedEntityVersion: rv, lease })).body.reason, "lease:lease_fenced");
  const sc = mussOk(await sende(d, { verb: "run.sourceCheck", payload: { sourceId: "gmail-inbox", cursor: "hist-4711", outcome: "ok" }, token: checker, expectedEntityVersion: rv, idempotencyKey: "k-sc" }), "sourceCheck");
  assert.deepEqual([d._store.snapshot.dailyBriefing.assistantRuns[DATE].sourceChecks["gmail-inbox"].outcome, d._store.snapshot.automation.sourceCursors["gmail-inbox"].cursor, d._store.snapshot.dailyBriefing.assistantRuns[DATE].sourceChecks["gmail-inbox"].checkedBy], ["ok", "hist-4711", "backend-pruefer"]);
  assert.deepEqual(sc.body.entityVersions, { [RUN_ID]: rv + 1 });
  assert.equal((await sende(d, { verb: "run.sourceCheck", payload: { sourceId: "gmail-inbox", cursor: "x", outcome: "ok" }, token: sched, expectedEntityVersion: rv + 1 })).body.reason, "verb_not_allowed_for_role");
  mussOk(await sende(d, { verb: "run.log", payload: { event: "tick", eventId: "ev_s" }, token: sched, expectedEntityVersion: rv + 1, idempotencyKey: "k-slog" }), "log sched");
  const d3 = deps({ env });
  mussOk(await sende(d3, { verb: "briefing.answer", payload: { briefingId: RUN_ID, questionId: "q_c1", answer: "Muster AG", answerId: "a_c1" }, idempotencyKey: "k-a" }), "answer");
  const av = d3.domain.loadObject(d3._store.snapshot, { kind: "briefing_answer", id: "a_c1" }).entityVersion;
  assert.equal((await sende(d3, { verb: "briefing.consumeAnswer", payload: { briefingId: "run_2026-09-19", answerId: "a_c1" }, token: checker, expectedEntityVersion: av })).body.reason, "briefing_answer_mismatch");
  const konsum = mussOk(await sende(d3, { verb: "briefing.consumeAnswer", payload: { briefingId: RUN_ID, answerId: "a_c1" }, token: checker, expectedEntityVersion: av, idempotencyKey: "k-c" }), "consume");
  assert.equal(d3._store.snapshot.automation.answersById.a_c1.consumedBy, "backend-pruefer");
  assert.equal((await sende(d3, { verb: "briefing.consumeAnswer", payload: { briefingId: RUN_ID, answerId: "a_c1" }, token: checker, expectedEntityVersion: konsum.body.entityVersions.a_c1 })).body.reason, "ANSWER_ALREADY_CONSUMED");
  const fin = await sende(d3, { verb: "run.finalize", payload: { outcome: "complete" }, token: checker, expectedEntityVersion: laufVersion(d3._store.snapshot) });
  assert.equal(fin.status, 409); assert.equal(fin.body.error, "domain_conflict"); assert.equal(fin.body.reason, "CLOSURE_BLOCKED", "kein done ohne Nachweis");
  const partial = mussOk(await sende(d3, { verb: "run.finalize", payload: { outcome: "partial", summaryRef: "note_teil" }, token: checker, expectedEntityVersion: laufVersion(d3._store.snapshot), idempotencyKey: "k-part" }), "partial");
  assert.deepEqual(d3._store.snapshot.dailyBriefing.assistantRuns[DATE].events.map((e) => [e.event, e.detail, e.by]), [["finalize:partial", "summaryRef:note_teil", "backend-pruefer"]]);
  assert.equal(d3._store.snapshot.dailyBriefing.assistantRuns[DATE].phase, "active", "partial schliesst nicht"); assert.ok(partial.body.entityVersions[RUN_ID]);
  assert.equal((await sende(d3, { verb: "lead.transition", payload: { leadId: "l1", toState: "doing" }, token: sched, expectedEntityVersion: 1 })).status, 403, "der Scheduler schreibt keine Inhalte");
});

/* ══ 7. Spezialist ═══════════════════════════════════════════════════════ */
test("C3a-09 Spezialist: worker.return nur auf den eigenen, aktiven, nicht abgelaufenen Auftrag mit akzeptierter Quellversion — dann echte Rueckgabe mit Abdruck", async () => {
  const env = umgebung();
  const claude = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist", jobId: JOB });
  const gemini = await jobToken(env, { role: "specialist_gemini", principalId: "gemini-spezialist", jobId: JOB });
  const rueckgabe = (assignmentId, extra = {}) => ({ assignmentId, resultRef: "res_" + assignmentId, summary: "fertig", sourceVersion: ver(BASIS, "chatgptTask", "c1"), resultHash: "e".repeat(64), ...extra });
  const d = deps({ env });
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe(JOB), token: gemini, jobId: JOB })).body.reason, "assignment_foreign_executor");
  const andererAuftrag = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist", jobId: "job_l1_cancelled" });
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe("job_l1_cancelled"), token: andererAuftrag, jobId: "job_l1_cancelled" })).body.reason, "assignment_not_active:cancelled");
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe("job_l1_cancelled"), token: claude, jobId: JOB })).body.reason, "object_foreign_job", "Rueckgabe an einen anderen Auftrag als den des Ausweises: C1 lehnt ab");
  const abgelaufen = structuredClone(BASIS); abgelaufen.automation.jobsById[JOB].expiresAt = new Date(JETZT - 1).toISOString();
  assert.equal((await sende(deps({ env, store: FC.makeStore({ snapshot: abgelaufen }) }), { verb: "worker.return", payload: rueckgabe(JOB), token: claude, jobId: JOB })).body.reason, "assignment_expired");
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe(JOB, { sourceVersion: 99 }), token: claude, jobId: JOB })).body.reason, "source_version_not_accepted");
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe(JOB, { resultHash: "kein-hash" }), token: claude, jobId: JOB })).body.reason, "field_invalid:resultHash");
  assert.equal(JSON.stringify(d._store.snapshot), JSON.stringify(BASIS));
  const ok = mussOk(await sende(d, { verb: "worker.return", payload: rueckgabe(JOB), token: claude, jobId: JOB, idempotencyKey: "k-ret" }), "return");
  const j = d._store.snapshot.automation.jobsById[JOB];
  assert.deepEqual([j.state, j.result.ref, j.result.hash, j.result.summary, j.result.receivedFrom, j.result.stale], ["returned", "res_" + JOB, "e".repeat(64), "fertig", "claude-spezialist", false]);
  assert.ok(("res_" + JOB) in ok.body.entityVersions);
  assert.equal((await sende(d, { verb: "worker.return", payload: rueckgabe(JOB), token: claude, jobId: JOB })).body.reason, "assignment_not_active:returned", "eine zweite Rueckgabe bindet nicht mehr");
  const lesend = await jobToken(env, { role: "specialist_claude", principalId: "claude-spezialist", jobId: JOB, audience: "quantus-context" });
  assert.equal((await lese(d, { query: "run.context", scopeId: RUN_ID, jobId: JOB, token: lesend })).body.reason, "assignment_not_active:returned", "nach der Rueckgabe auch kein Kontext mehr");
});

/* ══ 8. Ein ganzer Tag ueber C2 bis zum echten Abschluss ════════════════ */
test("C3a-10 ein Tag ueber C2: Slot-Quittungen, Quellenpruefungen, Belege, Abschluss (closeRun) — danach Widerspruch, Status blockiert, finalize 409", async () => {
  const env = umgebung();
  const sched = env.secrets.service.scheduler, checker = env.secrets.service.checker;
  let d = K.migrateCore(bestand(), { now: T("2026-09-19T06:00:00Z") }).data;
  d = bCmd(d, "ensureRun", { date: DATE }, K.slotBeginnMs(DATE, "briefing04") + MIN);
  d = bCmd(d, "ensureStartNote", { date: DATE, noteId: "note_start_" + DATE }, K.slotBeginnMs(DATE, "briefing04") + 2 * MIN);
  const abend = K.wandzeitZuMs(DATE, 23, 5);
  for (const id of ["l1", "l:9"]) d = bCmd(d, "registerEvidence", { evidenceId: "ev_" + sicher(id), kind: "message", ref: "msg_" + id, sourceType: "chatgptLead", sourceId: id, origin: { adapter: "gmail", ref: "t_" + id }, observedAt: new Date(abend - 4 * MIN).toISOString(), fingerprint: "fp_" + sicher(id) + "_0123456789abcdef" }, abend - 3 * MIN, ADAPTER);
  d = bCmd(d, "registerEvidence", { evidenceId: "ev_c1", kind: "message", ref: "msg_c1", sourceType: "chatgptTask", sourceId: "c1", origin: { adapter: "gmail", ref: "t_c1" }, observedAt: new Date(abend - 4 * MIN).toISOString(), fingerprint: "fp_c1_0123456789abcdef" }, abend - 3 * MIN, ADAPTER);
  d = bCmd(d, "transitionState", { sourceType: "chatgptTask", sourceId: "c1", state: "done", expectedVersion: ver(d, "chatgptTask", "c1"), evidence: { kind: "evidence", evidenceId: "ev_c1" } }, abend - 2 * MIN);
  d = bCmd(d, "transitionState", { sourceType: "task", sourceId: "t1", state: "done", expectedVersion: ver(d, "task", "t1") }, abend - 2 * MIN, USER_B);
  const store = FC.makeStore({ snapshot: d });
  const um = (ms) => deps({ env, store, now: ms });
  const rev = () => laufVersion(store.snapshot);
  for (const [c2, slot] of [["04:00", "briefing04"], ["09:00", "process09"], ["14:00", "continue14"], ["23:00", "close23"]]) {
    mussOk(await sende(um(K.slotBeginnMs(DATE, slot) + MIN), { verb: "run.ensure", payload: { slot: c2, date: DATE, receiptId: "rcpt_" + slot }, token: sched, expectedEntityVersion: rev(), idempotencyKey: "k-" + slot }), "ensure " + slot);
  }
  for (const s of POLICY.requiredSources) mussOk(await sende(um(abend - 3 * MIN), { verb: "run.sourceCheck", payload: { sourceId: s.id, cursor: "c-" + s.id, outcome: "ok" }, token: checker, expectedEntityVersion: rev(), idempotencyKey: "k-src-" + s.id }), "source " + s.id);
  for (const id of ["l1", "l:9"]) mussOk(await sende(um(abend - 2 * MIN), { verb: "lead.transition", payload: { leadId: id, toState: "done", evidenceRefs: ["ev_" + sicher(id)] }, token: nutzerToken(OWNER, TENANT, abend - 2 * MIN), expectedEntityVersion: ver(store.snapshot, "chatgptLead", id), idempotencyKey: "k-done-" + id }), "done " + id);
  assert.equal((await sende(um(K.wandzeitZuMs(DATE, 22, 0)), { verb: "run.finalize", payload: { outcome: "complete" }, token: checker, expectedEntityVersion: rev() })).body.reason, "CLOSURE_BLOCKED", "vor 23:00 kein Abschluss");
  const fin = mussOk(await sende(um(abend), { verb: "run.finalize", payload: { outcome: "complete", summaryRef: "note_final_" + DATE }, token: checker, expectedEntityVersion: rev(), idempotencyKey: "k-final" }), "finalize");
  const lauf = store.snapshot.dailyBriefing.assistantRuns[DATE];
  assert.deepEqual([lauf.phase, lauf.finalNoteId, lauf.finalEvaluation.coverage, lauf.finalEvaluation.operations, !!store.snapshot.entities.chatgptNotes["note_final_" + DATE]], ["final", "note_final_" + DATE, "green", "green", true]);
  assert.equal(fin.body.effect.already, false);
  assert.equal((await sende(um(abend + MIN), { verb: "run.finalize", payload: { outcome: "complete", summaryRef: "note_final_" + DATE }, token: checker, expectedEntityVersion: rev(), idempotencyKey: "k-final2" })).body.effect.already, true, "ein zweiter Abschluss ist ein No-op");
  const status = await lese(um(abend + MIN), { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: checker });
  assert.deepEqual([status.body.items[0].state, status.body.items[0].blocked, status.body.items[0].openQuestions], ["final", false, 0]);
  const t1 = abend + 10 * MIN;
  let w = bCmd(store.snapshot, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: ver(store.snapshot, "chatgptLead", "l1"), reason: "Kunde meldet Fehler" }, t1);
  w = bCmd(w, "invalidateClosure", { date: DATE, correctionId: "note_korr_1", reason: "Lead l1 wieder offen", contradiction: { sourceType: "chatgptLead", sourceId: "l1" } }, t1 + MIN);
  const dw = deps({ env, store: FC.makeStore({ snapshot: w }), now: t1 + 2 * MIN });
  const nachher = (await lese(dw, { route: "quantus-run-status", query: "run.status", scopeId: "status_" + DATE, token: checker })).body.items[0];
  assert.deepEqual([nachher.state, nachher.blocked], ["exception_open", true]);
  assert.equal(dw.domain.listPage(w, { query: "run.status", scopeId: "status_" + DATE, pageSize: 5, afterId: null, principal: { role: "backend_checker" } }).items[0].evaluationCached, false);
  const wieder = await sende(dw, { verb: "run.finalize", payload: { outcome: "complete" }, token: checker, expectedEntityVersion: laufVersion(w) });
  assert.equal(wieder.status, 409); assert.equal(wieder.body.reason, "RUN_EXCEPTION_OPEN");
});

/* ══ 9. Bilanz: jedes Verb positiv nachgewiesen ═════════════════════════ */
test("C3a-11 Bilanz: alle 23 Verben des Umschlags wurden ueber die echte Kette mit Wirkung im Kern nachgewiesen", () => {
  const fehlend = [...COMMAND_VERB_NAMES].filter((v) => !GEPRUEFT.has(v));
  assert.deepEqual(fehlend, [], "ohne positiven Nachweis: " + fehlend.join(", "));
  assert.equal(GEPRUEFT.size, 23);
});
