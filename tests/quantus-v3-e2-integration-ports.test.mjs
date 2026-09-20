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
  mapRunStatusToEvidence, TASK_DISPATCH_DEADLINE, DEFAULT_CORE_KEY,
} from "../runtime/quantus-v3/src/integration-ports.mjs";
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

/* ── Abschlussnachweis ueber das Statuswerkzeug ───────────────────────── */

function statusAntwort(over = {}) {
  return {
    runStatus: {
      runKey: RUNKEY, tenant: "quantus", policyVersion: "3.0", dataRevision: 42,
      closure: {
        state: "final", fence: 1, evidenceRef: "closure:2026-09-19:process09:abc123",
        verifiedAtMs: T0,
        sources: [{ id: "gmail-inbox", status: "ok", checkedAtMs: T0 }],
        ...(over.closure || {}),
      },
      ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "closure")),
    },
  };
}

test("die Abbildung des Statuswerkzeugs ist streng", () => {
  const erwartet = { runKey: RUNKEY, tenant: "quantus", policyVersion: "3.0" };
  const gut = mapRunStatusToEvidence(statusAntwort(), erwartet);
  assert.equal(gut.evidenceRef, "closure:2026-09-19:process09:abc123");
  assert.equal(gut.dataRevision, 42);
  assert.equal(gut.fence, 1);
  assert.deepEqual(gut.sources, [{ id: "gmail-inbox", status: "ok", checkedAtMs: T0 }]);

  // Was nicht eindeutig abgeschlossen ist, ergibt keinen Nachweis.
  assert.equal(mapRunStatusToEvidence(null, erwartet), null);
  assert.equal(mapRunStatusToEvidence({}, erwartet), null);
  assert.equal(mapRunStatusToEvidence(statusAntwort({ runKey: "fremd" }), erwartet), null);
  assert.equal(mapRunStatusToEvidence(statusAntwort({ closure: { state: "active" } }), erwartet), null);
  assert.equal(mapRunStatusToEvidence(statusAntwort({ closure: { sources: "viele" } }), erwartet), null);
  // Fehlende Einzelfelder werden zu null — die Pruefung im Worker weist sie ab.
  const luecke = mapRunStatusToEvidence(statusAntwort({ closure: { evidenceRef: 7, verifiedAtMs: "jetzt" } }), erwartet);
  assert.equal(luecke.evidenceRef, null);
  assert.equal(luecke.verifiedAtMs, null);
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

test("mit freigeschaltetem Werkzeug liefert der Port den abgebildeten Nachweis", async () => {
  const gesendet = [];
  const client = createToolClient({
    transport: async function send() { return null; },
    credential: { async get() { return "x".repeat(40); } },
    tenant: "quantus", policyVersion: "3.0", toolsEnabled: { quantus_run_status: true },
  });
  // createToolClient erwartet ein Objekt mit `send`.
  const echterClient = createToolClient({
    transport: { async send(req) { gesendet.push(req); return statusAntwort(); } },
    credential: { async get() { return "x".repeat(40); } },
    tenant: "quantus", policyVersion: "3.0", toolsEnabled: { quantus_run_status: true },
  });
  const port = createRunStatusClosureEvidencePort({ toolClient: echterClient, tenant: "quantus", policyVersion: "3.0" });
  const nachweis = await port.impl.load({ runKey: RUNKEY, now: T0 });
  assert.equal(nachweis.runKey, RUNKEY);
  assert.equal(nachweis.evidenceRef, "closure:2026-09-19:process09:abc123");
  assert.equal(gesendet.length, 1);
  assert.equal(gesendet[0].route, "quantus-run-status");
  assert.equal(gesendet[0].verb, "context.read");
  assert.equal(gesendet[0].role, "scheduler");
  assert.ok(client);
});

test("ohne Werkzeugklienten gibt es den Nachweisport nicht", () => {
  assert.equal(createRunStatusClosureEvidencePort({}).reason, "run_status_tool_not_wired");
  assert.equal(createRunStatusClosureEvidencePort({ toolClient: {} }).reason, "run_status_tool_not_wired");
});
