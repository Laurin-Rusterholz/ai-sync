/* ══ E2 — die echten Portanbindungen ═════════════════════════════════════
 *
 * Geprueft wird das, was ohne Zugangsdaten pruefbar ist: die Verdrahtung
 * an den echten Umschlag, der Inhalt der Cloud-Tasks-Anfrage und die
 * strenge Abbildung des Abschlussnachweises.
 *
 * Zwei Dinge ausdruecklich NICHT: es gibt keinen Dummy-Erfolg, und es
 * wird nichts nachgebaut, was der Integration gehoert. Wo ein Modul oder
 * ein Transport fehlt, ist die Antwort ein Port mit Grund.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import * as E1 from "../netlify/lib/quantus-v3-runtime-state.mjs";
import {
  createIntegrationCorePort, createCloudTasksPort, createRunStatusClosureEvidencePort,
  mapRunStatusPage, mapRunContextPage, CLOSURE_FINAL_STATE,
  TASK_DISPATCH_DEADLINE, DEFAULT_CORE_KEY,
} from "../runtime/quantus-v3/src/integration-ports.mjs";
import { runIdForRunKey, statusScopeIdForRunKey } from "../runtime/quantus-v3/src/run-ids.mjs";
import { createToolClient, TOOL_PORTS } from "../runtime/quantus-v3/src/tool-ports.mjs";
import { continuationTaskId } from "../runtime/quantus-v3/src/task-names.mjs";

const T0 = PLAN.wallTimeToMs("2026-09-19", 9, 0);
const RUNKEY = PLAN.slotRunKey("quantus", "2026-09-19", "process09", "3.0");
const QUEUE = "projects/test-invalid/locations/europe-west6/queues/quantus-v3-continuations";
const SCOPE = "quantus:mainrun";

/* ── Kernport ─────────────────────────────────────────────────────────── */

test("bei fehlendem Umschlag bleibt der Port leer und nennt den Grund", async () => {
  const port = await createIntegrationCorePort({ tenantId: "quantus", principalId: "runner-a",
    loadModules: async () => { throw new Error("module unavailable"); },
  });
  assert.equal(port.available, false);
  assert.equal(port.name, "core");
  assert.equal(port.reason, "integration_cas_envelope_not_wired");
  assert.equal(port.impl, null);
});

test("der integrierte Checkout liefert den echten Kernport", async () => {
  const port = await createIntegrationCorePort({ tenantId: "quantus", principalId: "runner-a" });
  assert.equal(port.available, true);
  assert.equal(typeof port.impl.read, "function");
  assert.equal(typeof port.impl.mutate, "function");
});

test("ohne verifizierten Mandanten oder Principal gibt es den Port gar nicht", async () => {
  assert.equal((await createIntegrationCorePort({ principalId: "runner-a" })).reason, "tenant_not_configured");
  assert.equal((await createIntegrationCorePort({ tenantId: "quantus" })).reason, "principal_not_configured");
  assert.equal((await createIntegrationCorePort({ tenantId: "", principalId: "" })).reason, "tenant_not_configured");
});

test("ein Umschlag ohne die erwarteten Ausfuhren wird benannt, nicht geraten", async () => {
  const port = await createIntegrationCorePort({
    tenantId: "quantus", principalId: "runner-a",
    loadModules: async () => ({ admin: { mutateAppData: () => {} }, idem: {} }),
  });
  assert.equal(port.available, false);
  assert.equal(port.reason, "missing_export:readAppDataDocument");
});

/* Ein Ersatz fuer den echten Umschlag, der seinen dokumentierten Vertrag
 * einhaelt: ein Beleg je Schluessel, Wiederholung ohne Schreibvorgang,
 * kodierte Fehler mit Status. Er steht NUR hier, damit die Verdrahtung
 * pruefbar ist — er ersetzt den echten Umschlag nicht. */
function ersatzUmschlag(store) {
  const belege = new Map();
  const puts = { count: 0 };
  return {
    puts,
    admin: {
      async readAppDataDocument() {
        const text = store.read().text;
        return { exists: text !== null, data: text, parsed: text ? JSON.parse(text) : null, etag: "e1" };
      },
      async mutateAppData(key, mutator) {
        const current = store.read();
        const parsed = JSON.parse(current.text);
        const out = mutator(parsed);
        if (out.unchanged !== true) {
          const saved = store.put(JSON.stringify(out.data), current.etag);
          if (!saved.ok) throw Object.assign(new Error("cas_exhausted"), { code: "cas_exhausted", status: 503 });
          puts.count += 1;
        }
        return { data: out.data, result: out.result };
      },
    },
    idem: {
      prepareIdempotentCommand({ tenantId, principalId, key, requestId, now }) {
        return { ledgerKey: `${tenantId}|${principalId}|${key}`, requestId, now };
      },
      applyIdempotentCommand(current, prepared, applyCommand) {
        if (belege.has(prepared.ledgerKey)) {
          return { data: current, result: { ...belege.get(prepared.ledgerKey), replayed: true }, unchanged: true };
        }
        const reduced = applyCommand(current);
        const antwort = { ...reduced.result, ok: true, replayed: false, requestId: prepared.requestId, dataRevision: reduced.data.automation.dataRevision };
        belege.set(prepared.ledgerKey, antwort);
        return { data: reduced.data, result: antwort };
      },
    },
  };
}

test("der Kernport reicht Ergebnis, Wiederholung und Schreibvorgang korrekt durch", async () => {
  const store = F.createCasStore(F.baseCore());
  const umschlag = ersatzUmschlag(store);
  const port = await createIntegrationCorePort({
    tenantId: "quantus", principalId: "runner-a", loadModules: async () => umschlag,
  });
  assert.equal(port.available, true);

  const erst = await port.impl.mutate({
    commandKey: "attempt-lease:runner-a", requestId: "req-1", now: T0,
    mutate: (data) => E1.acquireLease(data, { holder: "runner-a", scope: SCOPE, now: T0 }),
  });
  assert.equal(erst.result.ok, true);
  assert.equal(erst.result.fence, 1);
  assert.equal(erst.replayed, false);
  assert.equal(erst.wrote, true);
  assert.equal(umschlag.puts.count, 1);

  // Derselbe Schluessel noch einmal: Beleg, kein Schreibvorgang.
  const zweit = await port.impl.mutate({
    commandKey: "attempt-lease:runner-a", requestId: "req-2", now: T0 + 1000,
    mutate: (data) => E1.acquireLease(data, { holder: "runner-a", scope: SCOPE, now: T0 + 1000 }),
  });
  assert.equal(zweit.replayed, true);
  assert.equal(zweit.wrote, false, "eine Wiederholung schreibt nicht — und berechtigt zu nichts");
  assert.equal(umschlag.puts.count, 1);

  const gelesen = await port.impl.read();
  assert.equal(gelesen.data.automation.activeLease.holder, "runner-a");
  assert.equal(E1.readRuntime(gelesen.data).leaseFenceCounter, 1);
});

test("der Kernport reicht kodierte Fehler des Kerns durch, statt sie zu schlucken", async () => {
  const store = F.createCasStore(F.baseCore());
  const port = await createIntegrationCorePort({
    tenantId: "quantus", principalId: "runner-a", loadModules: async () => ersatzUmschlag(store),
  });
  await assert.rejects(() => port.impl.mutate({
    commandKey: "kaputt", requestId: "req-1", now: T0,
    mutate: (data) => E1.acquireLease(data, { holder: "runner-a", scope: SCOPE, now: T0, ttlMs: 6 * 3600_000 }),
  }), (e) => e.code === "invalid_ttl");
  assert.equal(store.stats.puts, 0);
});

test("der Kernport verlangt Kommandoschluessel und Mutator", async () => {
  const store = F.createCasStore(F.baseCore());
  const port = await createIntegrationCorePort({
    tenantId: "quantus", principalId: "runner-a", loadModules: async () => ersatzUmschlag(store),
  });
  await assert.rejects(() => port.impl.mutate({ requestId: "r", now: T0, mutate: (d) => ({ data: d, result: {} }) }),
    (e) => e.error === "command_key_required");
  await assert.rejects(() => port.impl.mutate({ commandKey: "k", requestId: "r", now: T0 }),
    (e) => e.error === "mutator_required");
  assert.equal(DEFAULT_CORE_KEY, "app-data.json");
});

/* ── Cloud Tasks ──────────────────────────────────────────────────────── */

function tasksAufbau(antwort) {
  const gesendet = [];
  const port = createCloudTasksPort({
    transport: { async createTask(anfrage) { gesendet.push(anfrage); return typeof antwort === "function" ? antwort(anfrage) : antwort; } },
  });
  return { gesendet, port };
}

const einreihen = (port) => port.impl.enqueueContinuation({
  taskId: continuationTaskId(RUNKEY, `cont:start:${RUNKEY}`),
  runKey: RUNKEY, continuationId: `cont:start:${RUNKEY}`, scheduleAtMs: T0,
  queue: QUEUE, targetUrl: "https://worker.test.invalid/v3/run/continue",
  oidcServiceAccount: "quantus-v3-tasks@test-invalid.iam.gserviceaccount.com",
  audience: "https://worker.test.invalid/v3/run/continue",
});

test("die Cloud-Tasks-Anfrage ist vollstaendig und traegt den stabilen Namen", async () => {
  const { gesendet, port } = tasksAufbau({ status: 200 });
  const out = await einreihen(port);
  assert.deepEqual(out, { enqueued: true, duplicate: false, name: `${QUEUE}/tasks/${continuationTaskId(RUNKEY, `cont:start:${RUNKEY}`)}` });
  assert.equal(gesendet.length, 1);
  const a = gesendet[0];
  assert.equal(a.url, `https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
  assert.equal(a.method, "POST");
  const task = a.payload.task;
  assert.equal(task.name, `${QUEUE}/tasks/c-quantus_3a2026-09-19_3aprocess09_3a3_2e0--cont_3astart_3aquantus_3a2026-09-19_3aprocess09_3a3_2e0`);
  assert.equal(task.dispatchDeadline, TASK_DISPATCH_DEADLINE);
  assert.equal(task.scheduleTime, new Date(T0).toISOString());
  assert.equal(task.httpRequest.url, "https://worker.test.invalid/v3/run/continue");
  assert.equal(task.httpRequest.httpMethod, "POST");
  assert.deepEqual(task.httpRequest.oidcToken, {
    serviceAccountEmail: "quantus-v3-tasks@test-invalid.iam.gserviceaccount.com",
    audience: "https://worker.test.invalid/v3/run/continue",
  });
  // Der Rumpf traegt genau Lauf und Fortsetzung — keine Identitaet.
  assert.deepEqual(JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8")),
    { runKey: RUNKEY, continuationId: `cont:start:${RUNKEY}` });
});

test("ein vergebener Name ist eine Dublette, kein Fehler", async () => {
  for (const antwort of [{ status: 409 }, { status: 200, error: "ALREADY_EXISTS" }]) {
    const { port } = tasksAufbau(antwort);
    assert.deepEqual(await einreihen(port), { enqueued: false, duplicate: true, reason: "ALREADY_EXISTS" });
  }
});

test("jede andere Antwort ist ein Fehler, kein stiller Erfolg", async () => {
  for (const antwort of [{ status: 500 }, { status: 403 }, { }, null, "ok"]) {
    const { port } = tasksAufbau(antwort);
    await assert.rejects(() => einreihen(port), (e) => e.status === 502, JSON.stringify(antwort));
  }
});

test("ein unzulaessiger Queue-Pfad oder Name kommt gar nicht erst hinaus", async () => {
  const { gesendet, port } = tasksAufbau({ status: 200 });
  await assert.rejects(() => port.impl.enqueueContinuation({
    taskId: "c-gueltig", runKey: RUNKEY, continuationId: "c1", scheduleAtMs: T0,
    queue: "nicht/ein/queue/pfad", targetUrl: "https://worker.test.invalid/v3/run/continue",
    oidcServiceAccount: "x@test-invalid.iam.gserviceaccount.com",
  }), /Queue-Pfad/);
  assert.deepEqual(gesendet, []);
});

test("ohne Transport gibt es den Task-Port nicht", () => {
  assert.equal(createCloudTasksPort({}).reason, "cloud_tasks_transport_not_wired");
  assert.equal(createCloudTasksPort({ transport: {} }).reason, "cloud_tasks_transport_not_wired");
});


/* ── Die B/C3a-Laufkennung: run_YYYY-MM-DD, keine Erfindung ────────────── */

const RUN_ID = runIdForRunKey(RUNKEY);
const SCOPE_ID = statusScopeIdForRunKey(RUNKEY);

test("die Lauf-Id folgt der echten B-Konvention (assistant-abschluss.mjs: run.phase, dailyBriefing.assistantRuns[date])", () => {
  assert.equal(RUN_ID, "run_2026-09-19");
  assert.equal(SCOPE_ID, "status_2026-09-19");
  // Beide sind einfache B-Ids ohne jede Umkodierung — und erfuellen die
  // echte C2-Id-Regel (`quantus-v3-service.mjs`) direkt.
  assert.match(RUN_ID, /^[A-Za-z0-9_:-]{1,120}$/);
  assert.match(SCOPE_ID, /^[A-Za-z0-9_:-]{1,120}$/);
  // Mehrere E1-Slot-Laeufe DESSELBEN Tages ergeben dieselbe B-Id — das
  // ist das Modell (ein Lauf pro Kalendertag), keine Kollision.
  const andererSlot = PLAN.slotRunKey("quantus", "2026-09-19", "briefing04", "3.0");
  assert.equal(runIdForRunKey(andererSlot), RUN_ID);
  // Ein anderer Tag ergibt eine andere Id.
  assert.notEqual(runIdForRunKey(PLAN.slotRunKey("quantus", "2026-09-20", "process09", "3.0")), RUN_ID);
});

/* ── Rollenbindung: context.run gehoert lead_agent, nicht scheduler ─────── */

test("context.run ist an lead_agent gebunden — run_context darf kein Dienst-Zugangsdatum lesen", () => {
  assert.equal(TOOL_PORTS["context.run"].role, "lead_agent");
  assert.equal(TOOL_PORTS["context.run"].scopeKind, "run_context");
  assert.equal(TOOL_PORTS["status.run"].role, "scheduler");
  assert.equal(TOOL_PORTS["status.run"].scopeKind, "run_status");
});

/* ── mapRunStatusPage / mapRunContextPage: die ECHTE Seitenform von C2 ──── */

function statusSeite(over = {}, itemOver = {}) {
  const eintrag = { id: "status_1", runId: RUN_ID, state: CLOSURE_FINAL_STATE, stage: "abschluss",
    entityVersion: 4, updatedAt: "2026-09-19T08:59:00Z", openQuestions: 0, blocked: false, ...itemOver };
  const items = over.items === undefined ? [eintrag] : over.items;
  return { status: 200, body: {
    ok: true, requestId: "r-1", serverNow: new Date(T0).toISOString(),
    dataRevision: 42, query: "run.status", scopeId: SCOPE_ID,
    items, count: items.length, hasMore: false, complete: true,
    pageStatus: "done", pageReason: null, cursor: null,
    entityVersions: Object.fromEntries(items.filter((e) => e?.id).map((e) => [e.id, e.entityVersion])),
    ...over,
  } };
}

function contextSeite(over = {}, items = null) {
  const echte = items || [
    { id: "ctx_chatgptLead_l1", runId: RUN_ID, kind: "run_context", title: "x", text: "", entityVersion: 3, updatedAt: "2026-09-19T08:00:00Z", evidenceRefs: ["ev_l1"] },
    { id: "ctx_chatgptTask_c1", runId: RUN_ID, kind: "run_context", title: "y", text: "", entityVersion: 1, updatedAt: "2026-09-19T08:01:00Z", evidenceRefs: [] },
  ];
  return { status: 200, body: {
    ok: true, requestId: "r-2", serverNow: new Date(T0).toISOString(),
    dataRevision: 42, query: "run.context", scopeId: RUN_ID,
    items: echte, count: echte.length, hasMore: false, complete: true,
    pageStatus: "done", pageReason: null, cursor: null,
    entityVersions: Object.fromEntries(echte.filter((e) => e?.id).map((e) => [e.id, e.entityVersion])),
    ...over,
  } };
}

test("mapRunStatusPage: gebunden an Datensatz-Id und Version, urteilt selbst nicht ueber final/blocked", () => {
  const out = mapRunStatusPage(statusSeite(), { runId: RUN_ID, scopeId: SCOPE_ID });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.page.evidenceRef, "runstatus:status_1:v4");
  assert.equal(out.page.dataRevision, 42);
  assert.equal(out.page.state, CLOSURE_FINAL_STATE);
  assert.equal(out.page.blocked, false);
  assert.equal(out.page.openQuestions, 0);
  // Auch ein "aktiver", nicht abgeschlossener Lauf bildet sauber ab —
  // das URTEIL liegt bei validateClosureEvidence, nicht hier.
  const aktiv = mapRunStatusPage(statusSeite({}, { state: "active", blocked: false }), { runId: RUN_ID, scopeId: SCOPE_ID });
  assert.equal(aktiv.ok, true);
  assert.equal(aktiv.page.state, "active");
});

test("mapRunStatusPage: eine unvollstaendige oder fremde Seite ist kein Nachweis", () => {
  const faelle = [
    [statusSeite({ complete: false, pageStatus: "aborted" }), "page_not_complete"],
    [statusSeite({ hasMore: true, pageStatus: "more", complete: false }), "page_not_complete"],
    [statusSeite({ items: [] }), "run_status_not_found"],
    [statusSeite({ ok: false }), "body_not_ok"],
    [statusSeite({ query: "run.queue" }), "query_echo_mismatch"],
    [statusSeite({ scopeId: "status_fremd" }), "scope_echo_mismatch"],
    [statusSeite({ entityVersions: { status_1: 9 } }), "entity_version_mismatch"],
    [{ status: 403, body: {} }, "status_not_ok"],
  ];
  for (const [antwort, code] of faelle) {
    const out = mapRunStatusPage(antwort, { runId: RUN_ID, scopeId: SCOPE_ID });
    assert.equal(out.ok, false, code);
    assert.equal(out.code, code);
  }
});

test("mapRunContextPage: ein Eintrag je gefuehrter Quelle, Id ist der projizierte C2-Eintrag", () => {
  const out = mapRunContextPage(contextSeite(), { runId: RUN_ID, scopeId: RUN_ID });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.page.sources, [
    { id: "ctx_chatgptLead_l1", status: "ok", checkedAtMs: T0 },
    { id: "ctx_chatgptTask_c1", status: "ok", checkedAtMs: T0 },
  ]);
  assert.equal(out.page.dataRevision, 42);
});

test("mapRunContextPage: eine Quelle ausserhalb des Laufs oder ohne brauchbare Version faellt auf", () => {
  const fremd = mapRunContextPage(contextSeite({}, [{ id: "ctx_x", runId: "run_2026-01-01", entityVersion: 1 }]), { runId: RUN_ID, scopeId: RUN_ID });
  assert.equal(fremd.ok, false);
  assert.equal(fremd.code, "item_outside_run");
  const kaputt = mapRunContextPage(contextSeite({}, [{ id: "ctx_x", runId: RUN_ID, entityVersion: null }]), { runId: RUN_ID, scopeId: RUN_ID });
  assert.equal(kaputt.ok, true);
  assert.equal(kaputt.page.sources[0].status, "not_ok");
});

/* ── Der Nachweisport: ZWEI echte Aufrufe, korrekt rollengebunden ───────── */

test("der Nachweisport ruft status.run MIT Dienst-Zugangsdatum und context.run MIT Job-Token", async () => {
  const gesendet = [];
  const jobTokenAufrufe = [];
  const toolClient = createToolClient({
    transport: { async send(req) { gesendet.push(req); return req.route === "quantus-run-status" ? statusSeite() : contextSeite(); } },
    credential: { async get(role) { return `dienst-${role}-${"x".repeat(30)}`; } },
    jobTokenIssuer: { async mint(opts) { jobTokenAufrufe.push(opts); return "job-token-fuer-" + opts.jobId; } },
    tenant: "quantus", policyVersion: "3.0",
    toolsEnabled: { quantus_run_status: true, quantus_context: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: "quantus", policyVersion: "3.0" });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 7, now: T0 });

  assert.equal(gesendet.length, 2);
  const status = gesendet.find((r) => r.route === "quantus-run-status");
  const kontext = gesendet.find((r) => r.route === "quantus-context");
  assert.match(status.credential, /^dienst-scheduler-/, "status.run nutzt das Dienst-Zugangsdatum der Rolle scheduler");
  assert.equal(kontext.credential, "job-token-fuer-" + RUN_ID, "context.run nutzt ein LAUFGEBUNDENES Job-Token");
  assert.equal(jobTokenAufrufe.length, 1);
  assert.equal(jobTokenAufrufe[0].jobId, RUN_ID);
  assert.equal(jobTokenAufrufe[0].audience, "quantus-context");

  assert.equal(nachweis.runKey, RUNKEY);
  assert.equal(nachweis.state, CLOSURE_FINAL_STATE);
  assert.equal(nachweis.blocked, false);
  assert.equal(nachweis.fence, 7);
  assert.equal(nachweis.fenceAttestedByC2, false);
  assert.deepEqual(nachweis.sources, [
    { id: "ctx_chatgptLead_l1", status: "ok", checkedAtMs: T0 },
    { id: "ctx_chatgptTask_c1", status: "ok", checkedAtMs: T0 },
  ]);
});

test("fehlt der Job-Token-Aussteller, bleibt sources leer statt erfunden — status wird trotzdem geliefert", async () => {
  const toolClient = createToolClient({
    transport: { async send(req) { return req.route === "quantus-run-status" ? statusSeite() : (() => { throw new Error("darf nicht gerufen werden"); })(); } },
    credential: { async get() { return "x".repeat(40); } },
    jobTokenIssuer: null,   // C1-eigene Zugangsdaten fehlen
    tenant: "quantus", policyVersion: "3.0",
    toolsEnabled: { quantus_run_status: true, quantus_context: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: "quantus", policyVersion: "3.0" });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 1, now: T0 });
  assert.equal(nachweis.state, CLOSURE_FINAL_STATE);
  assert.equal(nachweis.sources, null);
  assert.equal(port.impl.lastFailure, "port_unavailable");
});

test("solange run_status abgeschaltet ist, gibt es GAR KEINEN Nachweis — auch keinen halben", async () => {
  const toolClient = createToolClient({
    transport: { async send() { throw new Error("darf nicht gerufen werden"); } },
    credential: { async get() { return "x".repeat(40); } },
    jobTokenIssuer: { async mint() { return "job-token-x"; } },
    tenant: "quantus", policyVersion: "3.0",
    toolsEnabled: { quantus_run_status: false, quantus_context: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: "quantus", policyVersion: "3.0" });
  await assert.rejects(() => port.impl.load({ runKey: RUNKEY, fence: 1, now: T0 }),
    (e) => e.status === 503 && e.error === "tool_disabled" && e.detail.route === "quantus-run-status");
});

test("zwei Seiten mit unterschiedlicher Datenrevision ergeben keinen konsistenten Nachweis", async () => {
  const toolClient = createToolClient({
    transport: { async send(req) { return req.route === "quantus-run-status" ? statusSeite() : contextSeite({ dataRevision: 43 }); } },
    credential: { async get() { return "x".repeat(40); } },
    jobTokenIssuer: { async mint() { return "job-token-x"; } },
    tenant: "quantus", policyVersion: "3.0",
    toolsEnabled: { quantus_run_status: true, quantus_context: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: "quantus", policyVersion: "3.0" });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 1, now: T0 });
  assert.equal(nachweis.sources, null);
  assert.equal(port.impl.lastFailure, "data_revision_inconsistent");
});

test("ein Laufschluessel, der keine B-Id ergibt, liefert gar keinen Nachweis", async () => {
  const toolClient = createToolClient({
    transport: { async send() { throw new Error("darf nicht gerufen werden"); } },
    credential: { async get() { return "x".repeat(40); } },
    jobTokenIssuer: { async mint() { return "job-token-x"; } },
    tenant: "quantus", policyVersion: "3.0",
    toolsEnabled: { quantus_run_status: true, quantus_context: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: "quantus", policyVersion: "3.0" });
  assert.equal(await port.impl.load({ runKey: "kaputt", now: T0 }), null);
  assert.equal(port.impl.lastFailure, "run_key_invalid");
});

test("ohne Werkzeugklienten gibt es den Nachweisport nicht", () => {
  assert.equal(createRunStatusClosureEvidencePort({}).reason, "run_status_tool_not_wired");
  assert.equal(createRunStatusClosureEvidencePort({ toolClient: {} }).reason, "run_status_tool_not_wired");
});
