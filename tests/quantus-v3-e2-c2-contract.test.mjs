/* ══ E2 ⇄ B/C3a/C2/Idempotenz — der Vertragstest gegen den ECHTEN Checkout ═
 *
 * BEFUND, DER DIESE DATEI AUSGELOEST HAT
 * --------------------------------------
 * Eine fruehere Fassung fuhr die Kette gegen einen historischen Git-Stand
 * (`git show 48dc1fe:…`) statt gegen das, was tatsaechlich im Checkout
 * liegt — und benutzte dabei eine ERFUNDENE Lauf-Id-Kodierung sowie eine
 * ERFUNDENE Abschlussnachweisform. Diese Datei laedt NICHTS aus dem
 * Git-Objektspeicher: `assistant-core.mjs`, `quantus-v3-domain-adapter.mjs`,
 * `quantus-v3-service.mjs`, `quantus-v3-auth.mjs`, `quantus-v3-idempotency.mjs`
 * und `quantus-v3-runtime-state.mjs` (E1) sind die Dateien, die auf DIESEM
 * main-Stand liegen — direkt importiert.
 *
 * Getrieben wird ein ECHTER Tag: `ensureRun` → Quellenpruefung
 * (`recordSourceCheck`) → Beleg (`registerEvidence`) → Abschluss eines
 * Elements (`transitionState`, gebunden an den Beleg) → `closeRun` (B's
 * einziger, durch `pruefeAbschluss`/`dailyAssistantTrafficLight` gesicherter
 * Abschlussweg). Erst DANACH wird ueber die echte C2-Kette gelesen:
 * `quantus-run-status` mit einem Dienst-Zugangsdatum (Rolle `scheduler`),
 * `quantus-context` mit einem echten, laufgebundenen Job-Token (Rolle
 * `lead_agent` — `run_context` darf kein Dienst-Zugangsdatum lesen, siehe
 * `ROLE_POLICY`). Beide Antworten komponiert `integration-ports.mjs` zu
 * einem Nachweis, den `validateClosureEvidence` (E2) gegen alle vier
 * Kriterien prueft: aktueller Fence, vollstaendiger Quellensatz, belegter
 * B-Abschluss, aktuelle Version.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as K from "../netlify/lib/assistant-core.mjs";
import * as A from "../netlify/lib/quantus-v3-auth.mjs";
import * as S from "../netlify/lib/quantus-v3-service.mjs";
import { createQuantusV3DomainAdapter } from "../netlify/lib/quantus-v3-domain-adapter.mjs";
import * as FA from "./fixtures/quantus-v3-auth-fixtures.mjs";
import * as FC from "./fixtures/quantus-v3-c2-fixtures.mjs";
import { createC2HttpTransport } from "../runtime/quantus-v3/src/c2-transport.mjs";
import { createToolClient } from "../runtime/quantus-v3/src/tool-ports.mjs";
import { createRunStatusClosureEvidencePort } from "../runtime/quantus-v3/src/integration-ports.mjs";
import { validateClosureEvidence, CLOSURE_FINAL_STATE, CLOSURE_EVIDENCE_MAX_AGE_MS } from "../runtime/quantus-v3/src/worker-handlers.mjs";
import { runIdForRunKey, statusScopeIdForRunKey } from "../runtime/quantus-v3/src/run-ids.mjs";
import { slotRunKey } from "../netlify/lib/quantus-v3-runtime-plan.mjs";

const { TENANT, POLICY_VERSION } = FA;
const OWNER = "uid-laurin";
const APP = "https://management-xo2-pro.netlify.app";
const DATE = "2026-09-19";
const RUNKEY = slotRunKey(TENANT, DATE, "close23", POLICY_VERSION);
const RUN_ID = runIdForRunKey(RUNKEY);           // "run_2026-09-19"
const STATUS_SCOPE_ID = statusScopeIdForRunKey(RUNKEY);
const MIN = 60_000;
const CONTEXT_ITEM_ID = "ctx_chatgptLead_l1";

/* Genau EINE, minimale Kern-Quelle: eine erforderliche interne Quelle
 * ("quantus-core", B verlangt genau eine solche), keine externe. */
const POLICY = Object.freeze({
  ...K.POLICY_TEMPLATE, version: POLICY_VERSION, tenant: TENANT,
  requiredSources: [{ id: "quantus-core", kind: "quantus-core" }],
  noExternalSources: true,
});

let cmdN = 0;
function bCmd(data, type, payload, now, actor = { kind: "agent", id: "chatgpt-run" }) {
  const r = K.applyCommand(data, { type, commandId: "fix_" + String(++cmdN).padStart(6, "0"), now, payload }, { policy: POLICY, actor });
  assert.equal(r.ok, true, `${type}: ${r.error} ${JSON.stringify(r.detail)}`);
  return r.data;
}
const ver = (data, sourceType, id) => K.effektiverZustand(sourceType, K.quelleFinden(data, sourceType, id)).version;

/* Ein einziges, echtes chatgptLead — dieselben Rollenfelder, die B fuer
 * ein "explizit" zugewiesenes Element verlangt (sonst ROLES_MISSING). */
function bestand() {
  const t0 = "2026-09-18T10:00:00.000Z";
  return {
    entities: {
      tasks: {}, projects: {}, notes: {}, chatgptNotes: {},
      chatgptLeads: {
        l1: {
          id: "l1", title: "Kunde anlegen", rawInput: "Bitte Firma Muster AG anlegen.",
          status: "in_arbeit", readAt: t0, assignee: "chatgpt",
          interpretation: "Neue Organisation", research: "gesucht", plan: "anlegen", execution: "angelegt", result: "#/organizations/abc",
          assessment: {}, assignmentReason: "klein", linkedOrganizations: ["abc"], createdAt: t0, updatedAt: t0, comments: [],
        },
      },
      chatgptTasks: {},
    },
    journal: { documents: [] }, mobilePushes: [], dailyBriefing: { routines: [], dailyLog: {} },
  };
}

/* Der Tag: ensureRun → Quellenpruefung → Beleg → Abschluss des Elements
 * → closeRun. Alles direkt ueber B, nicht ueber C2 — C2 wird erst zum
 * LESEN benutzt (siehe unten), das ist der Teil, den dieses Paket bezeugt. */
function gruenerTag() {
  let d = K.migrateCore(bestand(), { now: Date.parse("2026-09-18T06:00:00Z") }).data;
  d = bCmd(d, "ensureRun", { date: DATE }, K.slotBeginnMs(DATE, "briefing04") + MIN);
  d = bCmd(d, "ensureStartNote", { date: DATE, noteId: "note_start_" + DATE }, K.slotBeginnMs(DATE, "briefing04") + 2 * MIN);
  d = bCmd(d, "addItemRef", { date: DATE, sourceType: "chatgptLead", sourceId: "l1" }, K.slotBeginnMs(DATE, "briefing04") + 3 * MIN);
  for (const slot of ["briefing04", "process09", "continue14", "close23"]) {
    d = bCmd(d, "recordSlotReceipt", { date: DATE, slot, receiptId: "rcpt_" + slot }, K.slotBeginnMs(DATE, slot) + MIN);
  }
  const abend = K.wandzeitZuMs(DATE, 23, 5);
  d = bCmd(d, "recordSourceCheck", { date: DATE, sourceId: "quantus-core", cursor: "c-1", outcome: "ok" }, abend - 8 * MIN, { kind: "system", id: "quantus-scheduler" });
  d = bCmd(d, "registerEvidence", {
    evidenceId: "ev_l1", kind: "message", ref: "msg_l1", sourceType: "chatgptLead", sourceId: "l1",
    origin: { adapter: "gmail", ref: "t_l1" }, observedAt: new Date(abend - 7 * MIN).toISOString(), fingerprint: "fp_l1_0123456789abcdef",
  }, abend - 6 * MIN, { kind: "adapter", id: "gmail-adapter" });
  d = bCmd(d, "transitionState", {
    sourceType: "chatgptLead", sourceId: "l1", state: "done",
    expectedVersion: ver(d, "chatgptLead", "l1"), evidence: { kind: "evidence", evidenceId: "ev_l1" },
  }, abend - 5 * MIN);
  d = bCmd(d, "closeRun", { date: DATE, finalNoteId: "note_final_" + DATE }, abend);
  const lauf = d.dailyBriefing.assistantRuns[DATE];
  assert.equal(lauf.phase, "final", JSON.stringify(lauf.finalEvaluation));
  assert.equal(lauf.finalEvaluation.coverage, "green");
  assert.equal(lauf.finalEvaluation.operations, "green");
  return { data: d, abendMs: abend };
}

/* ── Verdrahtung: echte Domaene, echter Dienst, echte Ausweise ──────────── */

const PORTS = Object.freeze({ policy: POLICY, ownerId: OWNER, read: () => undefined });
function aufbau() {
  const { data, abendMs } = gruenerTag();
  const env = FA.makeEnv({ tenant: TENANT, mode: "enforce", overrides: { QUANTUS_V3_API_WRITES: "enabled" } });
  const store = FC.makeStore({ snapshot: data });
  const domain = createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => abendMs + MIN, ports: PORTS });
  let n = 0;
  const deps = { now: () => abendMs + MIN, newRequestId: () => `req-${++n}`, env: env.read,
    keySource: { async get() { return null; } }, userLookup: async () => null,
    rateLimiter: FC.makeRateLimiter(), store, domain };

  const gesendet = [];
  const fetchGegenKette = async (url, init = {}) => {
    const headerMap = new Map(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    headerMap.set("x-forwarded-proto", "https");
    const route = new URL(url).pathname.split("/").pop();
    gesendet.push({ route, method: init.method, url });
    const req = { method: init.method, url,
      headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
      async text() { return init.body == null ? "" : String(init.body); } };
    const antwort = await S.handleReadRequest(req, deps, { route });
    return new Response(antwort.body === null ? null : JSON.stringify(antwort.body), { status: antwort.status, headers: { "content-type": "application/json" } });
  };
  const transport = createC2HttpTransport({ baseUrl: APP, fetchImpl: fetchGegenKette });

  const { config: authConfig } = A.resolveAuthConfig(env.read);
  const jobTokenIssuer = {
    async mint({ audience, jobId, tenant, now }) {
      const t = await A.mintJobToken({ config: authConfig, audience, jobId, tenant, role: "lead_agent", principalId: "quantus-v3-runtime:lead_agent", assignedJobIds: [jobId], now: () => now });
      assert.equal(t.ok, true, JSON.stringify(t));
      return t.token;
    },
  };
  const toolClient = createToolClient({
    transport, credential: { async get() { return env.secrets.service.scheduler; } },
    jobTokenIssuer, tenant: TENANT, policyVersion: POLICY_VERSION,
    toolsEnabled: { quantus_run_status: true, quantus_context: true },
  });
  return { data, abendMs, deps, gesendet, toolClient, env, authConfig };
}

test("die gepruefte Kette ist auf diesem Checkout ladbar (kein Git-Objektspeicher)", () => {
  assert.equal(typeof K.applyCommand, "function", "assistant-core");
  assert.equal(typeof S.handleReadRequest, "function", "quantus-v3-service");
  assert.equal(typeof A.resolveAuthConfig, "function", "quantus-v3-auth");
  assert.equal(typeof A.mintJobToken, "function", "quantus-v3-auth");
  assert.equal(typeof createQuantusV3DomainAdapter, "function", "quantus-v3-domain-adapter");
});

test("run.status erreicht die echte C2/B-Kette mit dem Dienst-Zugangsdatum (Rolle scheduler)", async () => {
  const { toolClient, gesendet, abendMs } = aufbau();
  const antwort = await toolClient.call("status.run", { query: "run.status", scopeId: STATUS_SCOPE_ID, jobId: RUN_ID, pageSize: 100 }, { now: abendMs + MIN });
  assert.equal(antwort.status, 200, JSON.stringify(antwort.body));
  assert.equal(antwort.body.items[0].runId, RUN_ID);
  assert.equal(antwort.body.items[0].state, "final");
  assert.equal(antwort.body.items[0].blocked, false);
  assert.equal(antwort.body.items[0].openQuestions, 0);
  assert.equal(gesendet[0].route, "quantus-run-status");
});

test("run.context erreicht die echte C2/B-Kette NUR mit einem laufgebundenen Job-Token (Rolle lead_agent) — ein Dienst-Zugangsdatum wird 403", async () => {
  const { deps, env } = aufbau();
  const url = new URL(`${APP}/.netlify/functions/quantus-context`);
  url.searchParams.set("query", "run.context"); url.searchParams.set("scopeId", RUN_ID); url.searchParams.set("jobId", RUN_ID);
  const mitDienstZugangsdatum = await S.handleReadRequest(
    FC.makeRequest({ method: "GET", url: url.toString(), headers: { authorization: `Bearer ${env.secrets.service.scheduler}`, origin: APP } }),
    deps, { route: "quantus-context" },
  );
  assert.equal(mitDienstZugangsdatum.status, 403, JSON.stringify(mitDienstZugangsdatum.body));

  const { config } = A.resolveAuthConfig(env.read);
  const jobToken = await A.mintJobToken({ config, audience: "quantus-context", jobId: RUN_ID, tenant: TENANT, role: "lead_agent", principalId: "p", assignedJobIds: [RUN_ID], now: deps.now });
  const mitJobToken = await S.handleReadRequest(
    FC.makeRequest({ method: "GET", url: url.toString(), headers: { authorization: `Bearer ${jobToken.token}`, origin: APP } }),
    deps, { route: "quantus-context" },
  );
  assert.equal(mitJobToken.status, 200, JSON.stringify(mitJobToken.body));
  assert.deepEqual(mitJobToken.body.items.map((i) => i.id), [CONTEXT_ITEM_ID]);
  assert.deepEqual(mitJobToken.body.items[0].evidenceRefs, ["ev_l1"]);
});

test("der zusammengesetzte Nachweisport liefert einen echten, gruenen Abschlussnachweis aus B/C2", async () => {
  const { toolClient, abendMs } = aufbau();
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: TENANT, policyVersion: POLICY_VERSION });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 3, now: abendMs + MIN });
  assert.notEqual(nachweis, null, `kein Nachweis: ${port.impl.lastFailure}`);
  assert.equal(nachweis.state, CLOSURE_FINAL_STATE);
  assert.equal(nachweis.blocked, false);
  assert.deepEqual(nachweis.sources, [{ id: CONTEXT_ITEM_ID, status: "ok", checkedAtMs: nachweis.verifiedAtMs }]);
  assert.equal(nachweis.fence, 3);
  assert.equal(nachweis.fenceAttestedByC2, false);

  // Und die VOLLE Pruefung (alle vier Kriterien) laesst diesen echten
  // Nachweis durch — nicht als Attrappe, sondern gegen den echten Ausgang
  // von B's closeRun ueber die echte C2-Kette gelesen.
  const urteil = validateClosureEvidence(nachweis, {
    runKey: RUNKEY, tenant: TENANT, policyVersion: POLICY_VERSION, fence: 3,
    now: nachweis.verifiedAtMs, requiredSources: [CONTEXT_ITEM_ID],
  });
  assert.deepEqual(urteil, { ok: true, errors: [] });
});

test("ein Quellensatz, der eine bei B tatsaechlich nicht gefuehrte Quelle verlangt, faellt durch — nichts wird ergaenzt", async () => {
  const { toolClient, abendMs } = aufbau();
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: TENANT, policyVersion: POLICY_VERSION });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 3, now: abendMs + MIN });
  const urteil = validateClosureEvidence(nachweis, {
    runKey: RUNKEY, tenant: TENANT, policyVersion: POLICY_VERSION, fence: 3,
    now: nachweis.verifiedAtMs, requiredSources: [CONTEXT_ITEM_ID, "ctx_chatgptTask_c1"],
  });
  assert.equal(urteil.ok, false);
  assert.ok(urteil.errors.some((e) => e.startsWith("sources_incomplete")), urteil.errors.join(","));
});

test("ein falscher Fence oder ein veralteter Nachweis fallen durch — der echte Inhalt allein genuegt nicht", async () => {
  const { toolClient, abendMs } = aufbau();
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: TENANT, policyVersion: POLICY_VERSION });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 3, now: abendMs + MIN });
  const basis = { runKey: RUNKEY, tenant: TENANT, policyVersion: POLICY_VERSION, requiredSources: [CONTEXT_ITEM_ID] };
  assert.equal(validateClosureEvidence(nachweis, { ...basis, fence: 99, now: nachweis.verifiedAtMs }).errors.includes("fence_mismatch"), true);
  assert.equal(validateClosureEvidence(nachweis, { ...basis, fence: 3, now: nachweis.verifiedAtMs + CLOSURE_EVIDENCE_MAX_AGE_MS + 1 }).errors.includes("evidence_stale"), true);
});

test("VOR dem Abschluss (Lauf noch nicht final) liefert die echte Kette einen ehrlich unfertigen Status — kein falsches Gruen", async () => {
  const env = FA.makeEnv({ tenant: TENANT, mode: "enforce", overrides: { QUANTUS_V3_API_WRITES: "enabled" } });
  let d = K.migrateCore(bestand(), { now: Date.parse("2026-09-18T06:00:00Z") }).data;
  d = bCmd(d, "ensureRun", { date: DATE }, K.slotBeginnMs(DATE, "briefing04") + MIN);
  const nowMs = K.slotBeginnMs(DATE, "process09") + MIN;
  const store = FC.makeStore({ snapshot: d });
  const domain = createQuantusV3DomainAdapter({ policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce", now: () => nowMs, ports: PORTS });
  let n = 0;
  const deps = { now: () => nowMs, newRequestId: () => `req-${++n}`, env: env.read,
    keySource: { async get() { return null; } }, userLookup: async () => null,
    rateLimiter: FC.makeRateLimiter(), store, domain };
  const fetchGegenKette = async (url, init = {}) => {
    const headerMap = new Map(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    headerMap.set("x-forwarded-proto", "https");
    const route = new URL(url).pathname.split("/").pop();
    const req = { method: init.method, url, headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null }, async text() { return ""; } };
    const antwort = await S.handleReadRequest(req, deps, { route });
    return new Response(antwort.body === null ? null : JSON.stringify(antwort.body), { status: antwort.status, headers: { "content-type": "application/json" } });
  };
  const toolClient = createToolClient({
    transport: createC2HttpTransport({ baseUrl: APP, fetchImpl: fetchGegenKette }),
    credential: { async get() { return env.secrets.service.scheduler; } },
    jobTokenIssuer: { async mint() { throw new Error("darf hier nicht gerufen werden — run.context wird bei fehlendem Abschluss nicht gebraucht"); } },
    tenant: TENANT, policyVersion: POLICY_VERSION,
    toolsEnabled: { quantus_run_status: true, quantus_context: true },
  });
  const antwort = await toolClient.call("status.run", { query: "run.status", scopeId: statusScopeIdForRunKey(RUNKEY), jobId: RUN_ID, pageSize: 100 }, { now: nowMs });
  assert.equal(antwort.status, 200);
  assert.equal(antwort.body.items[0].state, "created");
  const urteil = validateClosureEvidence(
    { runKey: RUNKEY, tenant: TENANT, policyVersion: POLICY_VERSION, fence: 1, dataRevision: 0, evidenceRef: "runstatus:x:v1", verifiedAtMs: nowMs, state: antwort.body.items[0].state, blocked: antwort.body.items[0].blocked, sources: null },
    { runKey: RUNKEY, tenant: TENANT, policyVersion: POLICY_VERSION, fence: 1, now: nowMs, requiredSources: [] },
  );
  assert.equal(urteil.ok, false);
  assert.ok(urteil.errors.includes("run_not_final"));
});
