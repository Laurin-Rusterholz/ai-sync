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
  mapRunStatusPageToEvidence, TASK_DISPATCH_DEADLINE, DEFAULT_CORE_KEY,
} from "../runtime/quantus-v3/src/integration-ports.mjs";
import { runIdForRunKey, runKeyFromRunId, statusScopeIdForRunKey } from "../runtime/quantus-v3/src/run-ids.mjs";
import { createToolClient } from "../runtime/quantus-v3/src/tool-ports.mjs";
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

/* ── Abschlussnachweis: die ECHTE Leseantwort von C2 ──────────────────── */

const SCOPE_ID = statusScopeIdForRunKey(RUNKEY);
const RUN_ID = runIdForRunKey(RUNKEY);

/*
 * Genau die Form, die `handleReadRequest` der Integration 48dc1fe
 * zurueckgibt — Umschlagfelder und ein Eintrag, der auf
 * `VISIBLE_FIELDS.run_status` beschnitten ist. Nichts darin ist erfunden.
 */
function leseAntwort({ item = {}, body = {}, status = 200 } = {}) {
  const eintrag = {
    id: "status_1", runId: RUN_ID, state: "completed", stage: "abschluss",
    entityVersion: 4, updatedAt: "2026-09-19T08:59:00Z", openQuestions: [], blocked: false,
    ...item,
  };
  const items = body.items === undefined ? [eintrag] : body.items;
  return {
    status,
    body: {
      ok: true, requestId: "r-1", serverNow: new Date(T0).toISOString(),
      dataRevision: 42, query: "run.status", scopeId: SCOPE_ID,
      items, count: items.length, hasMore: false, complete: true,
      pageStatus: "done", pageReason: null, cursor: null,
      entityVersions: Object.fromEntries(items
        .filter((e) => e && typeof e.id === "string" && Number.isSafeInteger(e.entityVersion))
        .map((e) => [e.id, e.entityVersion])),
      ...body,
    },
  };
}

const ERWARTET = { runKey: RUNKEY, runId: RUN_ID, scopeId: SCOPE_ID, tenant: "quantus", policyVersion: "3.0" };

test("die Laufschluessel-Zuordnung ist umkehrbar und C2-tauglich", () => {
  assert.match(SCOPE_ID, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(RUN_ID, /^[A-Za-z0-9_-]{1,128}$/);
  assert.ok(!SCOPE_ID.includes("__") && !RUN_ID.includes("__"));
  assert.equal(runKeyFromRunId(RUN_ID), RUNKEY);
  assert.notEqual(SCOPE_ID, RUN_ID);
  // Zwei verschiedene Schluessel ergeben nie dieselbe Id.
  const anders = PLAN.slotRunKey("quantus", "2026-09-19", "process09", "3-0");
  assert.notEqual(runIdForRunKey(anders), RUN_ID);
  // Ein Laufschluessel ist selbst NIE eine gueltige C2-Id.
  assert.ok(!/^[A-Za-z0-9_-]{1,128}$/.test(RUNKEY));
});

test("aus der echten Seite wird ein Nachweis — gebunden an Datensatz und Version", () => {
  const out = mapRunStatusPageToEvidence(leseAntwort(), ERWARTET);
  assert.equal(out.ok, true, out.code);
  assert.equal(out.evidence.evidenceRef, "runstatus:status_1:v4");
  assert.equal(out.evidence.dataRevision, 42);
  assert.equal(out.evidence.verifiedAtMs, T0);
  assert.equal(out.evidence.green, true);
  // Was C2 nicht bezeugt, wird auch nicht behauptet.
  assert.equal(out.evidence.fence, null);
  assert.equal(out.evidence.fenceAttestedByC2, false);
  assert.equal(out.evidence.sources, null);
});

test("eine unvollstaendige Seite ist kein Nachweis — auch nicht fuer Abwesenheit", () => {
  const faelle = [
    [leseAntwort({ body: { complete: false, pageStatus: "aborted", pageReason: "item_unusable" } }), "page_not_complete"],
    [leseAntwort({ body: { pageStatus: "more", complete: false, hasMore: true, cursor: "c" } }), "page_not_complete"],
    [leseAntwort({ body: { hasMore: true } }), "page_not_complete"],
    [leseAntwort({ body: { items: [] } }), "run_status_not_found"],
    [leseAntwort({ body: { ok: false } }), "body_not_ok"],
    [leseAntwort({ body: { query: "run.queue" } }), "query_echo_mismatch"],
    [leseAntwort({ body: { scopeId: "s-fremd" } }), "scope_echo_mismatch"],
    [leseAntwort({ body: { dataRevision: null } }), "data_revision_invalid"],
    [leseAntwort({ body: { serverNow: "irgendwann" } }), "server_now_invalid"],
    [leseAntwort({ status: 403 }), "status_not_ok"],
    [leseAntwort({ item: { state: "running" } }), "run_not_final"],
    [leseAntwort({ item: { blocked: true } }), "run_blocked"],
    [leseAntwort({ item: { openQuestions: ["q1"] } }), "open_questions"],
    [leseAntwort({ item: { runId: "r-fremd" } }), "run_status_not_found"],
    [leseAntwort({ body: { entityVersions: { status_1: 9 } } }), "entity_version_mismatch"],
  ];
  for (const [antwort, code] of faelle) {
    const out = mapRunStatusPageToEvidence(antwort, ERWARTET);
    assert.equal(out.ok, false, `haette scheitern muessen: ${code}`);
    assert.equal(out.code, code);
  }
});

test("zwei Eintraege zu demselben Lauf sind mehrdeutig, kein Nachweis", () => {
  const doppelt = leseAntwort({ body: { items: [
    { id: "status_1", runId: RUN_ID, state: "completed", entityVersion: 4, openQuestions: [], blocked: false },
    { id: "status_2", runId: RUN_ID, state: "aborted", entityVersion: 2, openQuestions: [], blocked: false },
  ] } });
  assert.equal(mapRunStatusPageToEvidence(doppelt, ERWARTET).code, "run_status_ambiguous");
});

test("solange das Statuswerkzeug abgeschaltet ist, gibt es keinen Nachweis", async () => {
  const client = createToolClient({
    transport: { async send() { throw new Error("darf nicht passieren"); } },
    credential: { async get() { return "synthetisches-testgeheimnis-0123456789"; } },
    tenant: "quantus", policyVersion: "3.0",
    toolsEnabled: {},   // wie in C1: alle vier stehen auf false
  });
  const port = createRunStatusClosureEvidencePort({ toolClient: client, tenant: "quantus", policyVersion: "3.0" });
  assert.equal(port.available, true);
  await assert.rejects(() => port.impl.load({ runKey: RUNKEY, now: T0 }),
    (e) => e.status === 503 && e.error === "tool_disabled" && e.detail.route === "quantus-run-status");
});

test("der Port ruft GET mit Query-String und C2-tauglichen Ids", async () => {
  const gesendet = [];
  const client = createToolClient({
    transport: { async send(req) { gesendet.push(req); return leseAntwort(); } },
    credential: { async get() { return "x".repeat(40); } },
    tenant: "quantus", policyVersion: "3.0", toolsEnabled: { quantus_run_status: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient: client, tenant: "quantus", policyVersion: "3.0" });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 7, now: T0 });

  assert.equal(gesendet.length, 1);
  const anfrage = gesendet[0];
  assert.equal(anfrage.route, "quantus-run-status");
  assert.equal(anfrage.method, "GET");
  assert.equal(anfrage.payload, null);
  assert.deepEqual(anfrage.searchParams, { query: "run.status", scopeId: SCOPE_ID, jobId: RUN_ID, pageSize: "100" });

  assert.equal(nachweis.runKey, RUNKEY);
  assert.equal(nachweis.evidenceRef, "runstatus:status_1:v4");
  // Der Fence bleibt der des Aufrufers — C2 bezeugt ihn nicht.
  assert.equal(nachweis.fence, 7);
  assert.equal(nachweis.fenceAttestedByC2, false);
});

test("ein Laufschluessel, der keine C2-Id ergibt, liefert keinen geratenen Nachweis", async () => {
  const zuLang = PLAN.slotRunKey("t".repeat(64), "2026-09-19", "process09", "a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p");
  const client = createToolClient({
    transport: { async send() { throw new Error("darf nicht passieren"); } },
    credential: { async get() { return "x".repeat(40); } },
    tenant: "quantus", policyVersion: "3.0", toolsEnabled: { quantus_run_status: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient: client, tenant: "quantus", policyVersion: "3.0" });
  assert.equal(await port.impl.load({ runKey: zuLang, now: T0 }), null);
  assert.equal(port.impl.lastFailure, "run_id_too_long");
});

test("ohne Werkzeugklienten gibt es den Nachweisport nicht", () => {
  assert.equal(createRunStatusClosureEvidencePort({}).reason, "run_status_tool_not_wired");
  assert.equal(createRunStatusClosureEvidencePort({ toolClient: {} }).reason, "run_status_tool_not_wired");
});
