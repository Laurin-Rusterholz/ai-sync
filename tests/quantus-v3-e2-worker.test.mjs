/* ══ Paket E2 — der kurze HTTP-Worker gegen echte lokale Handler ══════════
 *
 * Diese Datei startet den ECHTEN Dienst auf einem lokalen Port und spricht
 * ihn ueber HTTP an. Geprueft wird Verhalten, nicht Quelltext: Ausweis,
 * Wiederholung, 90-Sekunden-Grenze, Checkpoint, Fortsetzung, doppelte
 * Zustellung, ungueltiger Slot, fehlender Port.
 *
 * Kein Deployment, kein Google-Aufruf, kein bezahlter Aufruf. Der Kernport
 * laeuft ueber die echte CAS-Schleife mit den echten E1-Mutatoren.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { continuationTaskId } from "../runtime/quantus-v3/src/task-names.mjs";

const T_START = PLAN.wallTimeToMs("2026-09-19", 9, 0) + 2_000;   // zwei Sekunden nach 09:00
const RUNKEY = PLAN.slotRunKey(F.TENANT, "2026-09-19", "process09", F.POLICY_VERSION);

async function workerService(options = {}) {
  const key = F.createSigningKey();
  const clock = F.createClock(options.startMs ?? T_START);
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const tasks = F.createTasksPort();
  const work = F.createSectionWorkPort({ count: options.steps ?? 2, clock, clockStepMs: options.clockStepMs ?? 0 });
  const ports = {
    clock: clock.port, jwks: F.jwksPort(key),
    core: options.coreUnavailable ? F.unavailablePort("core", "integration_cas_envelope_not_wired") : core.port,
    tasks: options.tasksUnavailable ? F.unavailablePort("tasks", "cloud_tasks_client_not_wired") : tasks.port,
    sectionWork: options.workUnavailable ? F.unavailablePort("sectionWork", "section_work_provider_not_wired") : work.port,
  };
  const service = await F.startService({ role: "worker", ports, configOverrides: options.configOverrides ?? {} });
  const startToken = () => F.schedulerToken(key, { audience: F.AUD.slotStart, email: F.SA.schedulerStart, nowMs: clock.value });
  const taskToken = () => F.schedulerToken(key, { audience: F.AUD.runContinue, email: F.SA.tasks, nowMs: clock.value });
  return { key, clock, core, tasks, work, service, startToken, taskToken };
}

function taskHeaders(runKey, continuationId, retryCount = 0) {
  return {
    "x-cloudtasks-taskname": continuationTaskId(runKey, continuationId),
    "x-cloudtasks-queuename": F.QUEUE_NAME,
    "x-cloudtasks-taskretrycount": String(retryCount),
  };
}

/* ── Startlauf ─────────────────────────────────────────────────────────── */

test("ein Slotstart legt genau einen Lauf an und endet ohne Gruen", async (t) => {
  const s = await workerService({ steps: 2 });
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "finished");
  assert.equal(res.json.runKey, RUNKEY);
  assert.equal(res.json.mode, "dry_run");
  assert.equal(res.json.steps, 2);
  assert.equal(res.json.green, false, "im dry_run gibt es kein Gruen");

  const runtime = s.core.store.snapshot().automation.runtime;
  const run = runtime.runsByKey[RUNKEY];
  assert.equal(run.phase, "finished");
  assert.equal(run.outcome.kind, "dry_run");
  assert.equal(run.green, false);
  assert.equal(runtime.leaseFenceCounter, 1);
});

test("der Startschluessel ist tenant:lokalesDatum:slot:policyVersion und kommt vom Server", async (t) => {
  const s = await workerService();
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.json.runKey, `${F.TENANT}:2026-09-19:process09:${F.POLICY_VERSION}`);
  // Mandant und Policy-Version stehen NICHT im Rumpf — ein Versuch, sie
  // mitzuschicken, wird abgewiesen.
  const gefaelscht = await s.service.post("/v3/slot/start", {
    token: s.startToken(), body: { slot: "process09", tenant: "fremd", policyVersion: "9.9" },
  });
  assert.equal(gefaelscht.status, 400);
  assert.equal(gefaelscht.json.error, "server_controlled_field_in_payload");
  assert.deepEqual(gefaelscht.json.detail.fields.sort(), ["policyVersion", "tenant"]);
});

test("eine Wiederholung des Scheduler-Starts verdoppelt weder Lauf noch Wirkung", async (t) => {
  const s = await workerService({ steps: 2 });
  t.after(() => s.service.close());
  const erst = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(erst.json.outcome, "finished");
  const putsNachErst = s.core.store.stats.puts;
  const schritteNachErst = s.work.handed;

  // Zweite Zustellung desselben Starts, neues Token, neue Anfrage-Id.
  const zweit = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(zweit.status, 200);
  assert.equal(zweit.json.outcome, "duplicate");
  assert.equal(zweit.json.reason, "slot_start_replay");
  assert.equal(s.core.store.stats.puts, putsNachErst, "kein zweiter Schreibvorgang");
  assert.equal(s.work.handed, schritteNachErst, "keine zweite Arbeit");
  assert.equal(Object.keys(s.core.store.snapshot().automation.runtime.runsByKey).length, 1);
});

test("eine Wiederholung nach Mitternacht erzeugt keinen Lauf fuer den naechsten Tag", async (t) => {
  // Cloud Scheduler wiederholt den 23-Uhr-Auftrag um 00:05. Wer das lokale
  // Datum aus der Ankunftszeit nimmt, legt einen zweiten Lauf fuer den 20.
  // an. Hier wird der Slot serverseitig auf den 19. aufgeloest — und weil
  // das Spaetfenster um 23:30 endet, startet er gar nicht mehr.
  const nachMitternacht = PLAN.wallTimeToMs("2026-09-20", 0, 5);
  const s = await workerService({ startMs: nachMitternacht });
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "close23" } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, "slot_window_closed");
  assert.equal(res.json.detail.runKey, PLAN.slotRunKey(F.TENANT, "2026-09-19", "close23", F.POLICY_VERSION));
  const runs = s.core.store.snapshot().automation.runtime?.runsByKey ?? {};
  assert.deepEqual(Object.keys(runs), [], "kein Lauf fuer den 20. und keiner fuer den 19.");
});

test("ein 23-Uhr-Start innerhalb des Spaetfensters laeuft normal", async (t) => {
  const s = await workerService({ startMs: PLAN.wallTimeToMs("2026-09-19", 23, 1) });
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "close23" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.runKey, PLAN.slotRunKey(F.TENANT, "2026-09-19", "close23", F.POLICY_VERSION));
  assert.equal(res.json.outcome, "finished");
});

test("ein viel zu spaeter Direktstart wird abgewiesen — dafuer gibt es den Monitor", async (t) => {
  const vielSpaeter = PLAN.wallTimeToMs("2026-09-19", 9, 0) + 7 * 60 * 60 * 1000;
  const s = await workerService({ startMs: vielSpaeter });
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, "slot_start_too_late");
  assert.equal(Object.keys(s.core.store.snapshot().automation.runtime?.runsByKey ?? {}).length, 0);
});

test("ein unbekannter Slot kommt nicht durch", async (t) => {
  const s = await workerService();
  t.after(() => s.service.close());
  for (const slot of ["preflight2230", "briefing05", "", 42, null]) {
    const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot } });
    assert.equal(res.status, 400, `slot ${String(slot)}`);
    assert.equal(res.json.error, "slot_start_invalid");
  }
  const leer = await s.service.post("/v3/slot/start", { token: s.startToken(), body: {} });
  assert.equal(leer.status, 400);
  const extra = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09", extra: 1 } });
  assert.equal(extra.status, 400, "unbekannte Felder sind ein Fehler, kein Ignorieren");
});

/* ── 90-Sekunden-Grenze und Checkpoint ─────────────────────────────────── */

test("der Abschnitt endet an der 90-Sekunden-Grenze mit Checkpoint und Fortsetzung", async (t) => {
  // Jeder Schritt laesst 30 s vergehen. Nach dem dritten Schritt ist das
  // Abschnittsbudget von E1 (90 s) aufgebraucht — der Lauf haelt an,
  // statt weiterzumachen.
  const s = await workerService({ steps: 50, clockStepMs: 30_000 });
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "checkpointed");
  assert.equal(res.json.green, false);
  assert.equal(res.json.steps, 3);
  assert.equal(res.json.reason, "budget");
  assert.equal(res.json.enqueued, true);
  assert.equal(res.json.duplicateTask, false);
  assert.equal(res.json.continuationId, `cont:start:${RUNKEY}`);
  assert.equal(res.json.taskId, continuationTaskId(RUNKEY, `cont:start:${RUNKEY}`));

  const runtime = s.core.store.snapshot().automation.runtime;
  const run = runtime.runsByKey[RUNKEY];
  assert.equal(run.phase, "checkpointed");
  assert.equal(run.pendingContinuationId, `cont:start:${RUNKEY}`);
  assert.deepEqual(run.checkpoint.cursor, { position: 3 }, "der Cursor ist dauerhaft");
  assert.equal(s.tasks.created.size, 1);
  const task = [...s.tasks.created.values()][0];
  assert.equal(task.queue, F.QUEUE);
  assert.equal(task.targetUrl, F.AUD.runContinue);
  assert.equal(task.oidcServiceAccount, F.SA.tasks);

  // Der Lauf steht spaetestens 90 s nach dem Start still.
  assert.ok(run.checkpoint.atMs <= T_START + 90_000, `Checkpoint bei +${(run.checkpoint.atMs - T_START) / 1000}s`);
});

test("auch ohne Budgetbruch endet der Abschnitt an der eigenen Frist", async (t) => {
  // 20 s je Schritt: nach vier Schritten ist das E1-Budget noch nicht aus,
  // aber die Abschnittsfrist (90 s minus 10 s Polster) ist erreicht.
  const s = await workerService({ steps: 50, clockStepMs: 20_000 });
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "checkpointed");
  assert.equal(res.json.reason, "section_deadline");
  assert.equal(res.json.steps, 4);
  const run = s.core.store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.ok(run.checkpoint.atMs <= T_START + 90_000);
});

test("ein bereits vorhandener Task-Name ist kein Fehler, sondern eine Dublette", async (t) => {
  const s = await workerService({ steps: 50, clockStepMs: 30_000 });
  t.after(() => s.service.close());
  const continuationId = `cont:start:${RUNKEY}`;
  // Cloud Tasks kennt den Namen schon (z. B. aus einer frueheren Zustellung).
  s.tasks.created.set(continuationTaskId(RUNKEY, continuationId), { pre: true });
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "checkpointed");
  assert.equal(res.json.enqueued, false);
  assert.equal(res.json.duplicateTask, true);
  assert.equal(s.tasks.created.size, 1, "kein zweiter Task");
});

test("scheitert das Einreihen, bleibt der Checkpoint stehen und die Absicht offen", async (t) => {
  const s = await workerService({ steps: 50, clockStepMs: 30_000 });
  t.after(() => s.service.close());
  s.tasks.failOnce("cloud_tasks_unavailable");
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.status, 500);
  const run = s.core.store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.equal(run.phase, "checkpointed", "der Stand ist dauerhaft, bevor eingereiht wird");
  assert.equal(run.pendingContinuationId, `cont:start:${RUNKEY}`);
});

/* ── Fortsetzung ───────────────────────────────────────────────────────── */

async function bisCheckpoint() {
  const s = await workerService({ steps: 50, clockStepMs: 30_000 });
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(res.json.outcome, "checkpointed");
  return { s, continuationId: res.json.continuationId };
}

test("eine Fortsetzung wird genau einmal verbraucht", async (t) => {
  const { s, continuationId } = await bisCheckpoint();
  t.after(() => s.service.close());
  s.clock.set(s.clock.value + 1000);
  const erst = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: taskHeaders(RUNKEY, continuationId, 0),
  });
  assert.equal(erst.status, 200, erst.text);
  assert.equal(erst.json.outcome, "checkpointed", "der naechste Abschnitt laeuft wieder in die Grenze");
  assert.equal(erst.json.sectionId, `resume:${continuationId}`);
  assert.equal(s.core.store.snapshot().automation.runtime.continuationsById[continuationId].state, "consumed");

  // Zweite Zustellung desselben Tasks (Cloud-Tasks-Wiederholung).
  const zweit = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: taskHeaders(RUNKEY, continuationId, 1),
  });
  assert.equal(zweit.status, 200);
  assert.equal(zweit.json.outcome, "duplicate");
  assert.equal(zweit.json.reason, "continuation_already_consumed");
});

test("die Fortsetzung muss sich mit ihrem Task-Namen und ihrer Queue ausweisen", async (t) => {
  const { s, continuationId } = await bisCheckpoint();
  t.after(() => s.service.close());
  const ohne = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: { "x-cloudtasks-queuename": F.QUEUE_NAME },
  });
  assert.equal(ohne.status, 400);
  assert.equal(ohne.json.error, "task_name_mismatch");

  const falsch = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: { ...taskHeaders(RUNKEY, "cont:fremd", 0), "x-cloudtasks-queuename": F.QUEUE_NAME },
  });
  assert.equal(falsch.status, 400);
  assert.equal(falsch.json.error, "task_name_mismatch");

  const fremdeQueue = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: { ...taskHeaders(RUNKEY, continuationId, 0), "x-cloudtasks-queuename": "fremde-queue" },
  });
  assert.equal(fremdeQueue.status, 400);
  assert.equal(fremdeQueue.json.error, "task_queue_mismatch");
});

test("nach zu vielen Task-Wiederholungen gibt es exception_open, kein weiteres Drehen", async (t) => {
  const { s, continuationId } = await bisCheckpoint();
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: taskHeaders(RUNKEY, continuationId, 5),
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "exception_open");
  assert.equal(res.json.green, false);
  assert.equal(res.json.reason, "task_retries_exhausted");
  const runtime = s.core.store.snapshot().automation.runtime;
  assert.equal(runtime.runsByKey[RUNKEY].phase, "exception_open");
  assert.equal(Object.values(runtime.incidentsById).some((i) => i.kind === "run_exception"), true);
});

test("eine unbekannte Fortsetzung wird abgewiesen", async (t) => {
  const { s } = await bisCheckpoint();
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId: "cont:erfunden" },
    headers: taskHeaders(RUNKEY, "cont:erfunden", 0),
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, "continuation_unknown");
});

/* ── Fehlende Ports ────────────────────────────────────────────────────── */

test("ein fehlender Port scheitert mit 503 und nennt ihn — nichts wird vorgetaeuscht", async (t) => {
  for (const [option, port] of [["coreUnavailable", "core"], ["workUnavailable", "sectionWork"], ["tasksUnavailable", "tasks"]]) {
    const s = await workerService({ [option]: true, steps: 50, clockStepMs: 30_000 });
    t.after(() => s.service.close());
    const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
    assert.equal(res.status, 503, `${port}: ${res.text}`);
    assert.equal(res.json.error, "port_unavailable");
    assert.equal(res.json.detail.port, port);
    if (option === "coreUnavailable") {
      assert.equal(res.json.detail.reason, "integration_cas_envelope_not_wired");
    }
  }
});

/* ── Rand ──────────────────────────────────────────────────────────────── */

test("es gibt keine anonyme und keine unbekannte Route", async (t) => {
  const s = await workerService();
  t.after(() => s.service.close());
  assert.deepEqual(s.service.app.router.routes, ["POST /v3/run/continue", "POST /v3/slot/start"]);
  const ohneToken = await s.service.post("/v3/slot/start", { body: { slot: "process09" } });
  assert.equal(ohneToken.status, 401);
  for (const pfad of ["/", "/healthz", "/v3", "/v3/slot/start/", "/metrics"]) {
    const res = await s.service.post(pfad, { token: s.startToken(), body: {} });
    assert.equal(res.status, 404, pfad);
  }
  const getRes = await fetch(s.service.url("/v3/slot/start"), { headers: { "x-forwarded-proto": "https" } });
  assert.equal(getRes.status, 404);
});

test("ohne TLS an der Grenze geht nichts", async (t) => {
  const s = await workerService();
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", {
    token: s.startToken(), body: { slot: "process09" }, headers: { "x-forwarded-proto": "http" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, "tls_required");
});

test("Rumpf: nur application/json, nur Objekte, nur bis zur Groessengrenze", async (t) => {
  const s = await workerService();
  t.after(() => s.service.close());
  const token = s.startToken();
  const falscherTyp = await s.service.post("/v3/slot/start", { token, body: { slot: "process09" }, headers: { "content-type": "text/plain" } });
  assert.equal(falscherTyp.status, 400);
  assert.equal(falscherTyp.json.error, "content_type_invalid");

  const liste = await fetch(s.service.url("/v3/slot/start"), {
    method: "POST",
    headers: { "x-forwarded-proto": "https", "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "[1,2,3]",
  });
  assert.equal(liste.status, 400);

  const kaputt = await fetch(s.service.url("/v3/slot/start"), {
    method: "POST",
    headers: { "x-forwarded-proto": "https", "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{nicht json",
  });
  assert.equal(kaputt.status, 400);

  const riesig = await fetch(s.service.url("/v3/slot/start"), {
    method: "POST",
    headers: { "x-forwarded-proto": "https", "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slot: "process09", fuellung: "x".repeat(40_000) }),
  });
  assert.equal(riesig.status, 413);
});

test("jede Antwort ist JSON mit no-store und einer Anfrage-Id", async (t) => {
  const s = await workerService();
  t.after(() => s.service.close());
  const res = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.json.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers["x-quantus-request-id"], res.json.requestId);
});

/* ── Absturz zwischen Checkpoint und Einreihen ─────────────────────────── */

test("nach einem Absturz zwischen Checkpoint und Einreihen holt die naechste Zustellung das Einreihen nach", async (t) => {
  const s = await workerService({ steps: 50, clockStepMs: 30_000 });
  t.after(() => s.service.close());
  s.tasks.failOnce("cloud_tasks_unavailable");
  const kaputt = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(kaputt.status, 500, "das Einreihen ist gescheitert");
  assert.equal(s.tasks.created.size, 0);

  // Der Scheduler wiederholt. Der Checkpoint steht, also wird nur noch
  // eingereiht — kein zweiter Lauf, keine zweite Arbeit.
  const schritteVorher = s.work.handed;
  const wieder = await s.service.post("/v3/slot/start", { token: s.startToken(), body: { slot: "process09" } });
  assert.equal(wieder.status, 200, wieder.text);
  assert.equal(wieder.json.outcome, "checkpointed");
  assert.equal(wieder.json.reason, "slot_start_replay");
  assert.equal(wieder.json.enqueued, true);
  assert.equal(s.work.handed, schritteVorher, "keine zweite Arbeit");
  assert.equal(s.tasks.created.size, 1);
  assert.equal(Object.keys(s.core.store.snapshot().automation.runtime.runsByKey).length, 1);
});

test("jeder Versuch hat seinen EIGENEN Besitz und gibt ihn am Ende frei", async (t) => {
  const { s, continuationId } = await bisCheckpoint();
  t.after(() => s.service.close());
  // Nach dem Startversuch ist der Besitz frei — der naechste Versuch
  // muss nicht auf den Ablauf warten.
  assert.equal(s.core.store.snapshot().automation.activeLease, null);
  const fenceNachStart = s.core.store.snapshot().automation.runtime.leaseFenceCounter;
  assert.equal(fenceNachStart, 1);

  s.clock.set(s.clock.value + 1000);
  const res = await s.service.post("/v3/run/continue", {
    token: s.taskToken(), body: { runKey: RUNKEY, continuationId },
    headers: taskHeaders(RUNKEY, continuationId, 0),
  });
  assert.equal(res.status, 200, res.text);
  const runtime = s.core.store.snapshot().automation.runtime;
  assert.equal(s.core.store.snapshot().automation.activeLease, null, "auch dieser Versuch gibt frei");
  assert.equal(runtime.leaseFenceCounter, 2, "ein neuer Versuch, ein neuer Fence");

  // Waehrend des langen Abschnitts wurde die Fuehrung erneuert.
  assert.ok(s.core.calls.some((k) => k.startsWith("renew:")), JSON.stringify(s.core.calls));
  // Und die Besitzer der beiden Versuche waren verschieden.
  const abschnitte = runtime.runsByKey[RUNKEY].sections;
  const halter = [...new Set(Object.values(abschnitte).map((x) => x.holder))];
  assert.equal(halter.length, 2, `zwei Versuche, zwei Besitzer: ${JSON.stringify(halter)}`);
  for (const h of halter) assert.match(h, /^worker-rev-0001:[0-9a-f-]{36}$/);
});
