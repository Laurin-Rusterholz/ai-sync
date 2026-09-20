/* ══ Paket E2 — Monitor, Vorabcheck und unabhaengiger Watchdog ═══════════
 *
 * Drei echte lokale Dienste, ueber HTTP angesprochen. Geprueft wird, dass
 *   · der Fuenf-Minuten-Monitor Vorfall und Nachholabsicht anlegt und die
 *     faelligen Absichten mit STABILEN Tasknamen einreiht,
 *   · derselbe Tick nichts verdoppelt und ein bereits vorhandener Task
 *     kein Fehler ist,
 *   · der 22:30-Vorabcheck keinen fuenften Hauptauftrag erzeugen kann,
 *   · der Watchdog in einem eigenen Dienst ohne Task-Port laeuft und eine
 *     fehlgeschlagene Warnung nie als zugestellt gilt.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { continuationTaskId } from "../runtime/quantus-v3/src/task-names.mjs";

const NOW = PLAN.wallTimeToMs("2026-09-19", 9, 11);   // elf Minuten nach 09:00
const KEY04 = PLAN.slotRunKey(F.TENANT, "2026-09-19", "briefing04", F.POLICY_VERSION);
const KEY09 = PLAN.slotRunKey(F.TENANT, "2026-09-19", "process09", F.POLICY_VERSION);

async function monitorService(options = {}) {
  const key = F.createSigningKey();
  const clock = F.createClock(options.startMs ?? NOW);
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const tasks = F.createTasksPort();
  const service = await F.startService({
    role: "monitor",
    ports: { clock: clock.port, jwks: F.jwksPort(key), core: core.port, tasks: tasks.port },
    configOverrides: options.configOverrides ?? {},
  });
  const token = (audience) => F.schedulerToken(key, { audience, email: F.SA.schedulerMonitor, nowMs: clock.value });
  return { key, clock, core, tasks, service, token };
}

async function watchdogService(options = {}) {
  const key = F.createSigningKey();
  const clock = F.createClock(options.startMs ?? NOW);
  const core = options.core ?? F.createCorePort(F.createCasStore(F.baseCore()));
  const alert = F.createAlertPort({ delivered: options.delivered !== false, throws: options.throws === true });
  const service = await F.startService({
    role: "watchdog",
    ports: { clock: clock.port, jwks: F.jwksPort(key), core: core.port, alert: alert.port },
  });
  const token = () => F.schedulerToken(key, { audience: F.AUD.watchdogCheck, email: F.SA.schedulerWatchdog, nowMs: clock.value });
  return { key, clock, core, alert, service, token };
}

/* ── Monitor ───────────────────────────────────────────────────────────── */

test("der Monitor legt Vorfall und Nachholabsicht an und reiht sie ein", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  const res = await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.createdIncidents, 2, "04:00 und 09:00 sind ueberfaellig");
  assert.equal(res.json.createdIntents, 2);
  assert.equal(res.json.dispatched, 2);
  assert.equal(res.json.duplicateTasks, 0);
  assert.equal(res.json.enqueueFailures, 0);
  assert.equal(res.json.mode, "dry_run");
  assert.match(res.json.tickId, /^tick:quantus:3\.0:\d+$/);

  // Die Tasknamen sind stabil aus Lauf und Absicht abgeleitet.
  assert.deepEqual([...m.tasks.created.keys()].sort(), [
    continuationTaskId(KEY04, `catchup:${KEY04}`),
    continuationTaskId(KEY09, `catchup:${KEY09}`),
  ].sort());
  const runtime = m.core.store.snapshot().automation.runtime;
  assert.equal(Object.keys(runtime.runsByKey).length, 0, "der Monitor legt keinen Lauf an");
  assert.equal(runtime.monitor.lastHeartbeatAtMs, NOW);
});

test("derselbe Tick zweimal schreibt nichts doppelt und reiht nichts doppelt ein", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  const puts = m.core.store.stats.puts;

  const zweit = await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  assert.equal(zweit.status, 200);
  assert.equal(zweit.json.duplicate, true);
  assert.equal(zweit.json.createdIncidents, 0);
  assert.equal(m.core.store.stats.puts, puts, "kein zweiter Schreibvorgang");
  // Eingereiht wird wieder versucht — der Name deduped, das ist kein Fehler.
  assert.equal(zweit.json.dispatched, 0);
  assert.equal(zweit.json.duplicateTasks, 2);
  assert.equal(m.tasks.created.size, 2);
});

test("ein spaeterer Tick findet nichts Neues und flutet die Historie nicht", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  m.clock.set(NOW + 6 * 60_000);
  const spaeter = await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  assert.equal(spaeter.json.duplicate, false, "neues Fuenf-Minuten-Fenster, neuer Tick");
  assert.equal(spaeter.json.createdIncidents, 0);
  assert.equal(spaeter.json.createdIntents, 0);
  const runtime = m.core.store.snapshot().automation.runtime;
  assert.equal(Object.keys(runtime.incidentsById).length, 2);
  assert.equal(Object.keys(runtime.continuationsById).length, 2);
});

test("ohne Startzeitraum gibt es den Monitordienst gar nicht erst", () => {
  // Der konfigurierte Startzeitraum verhindert, dass ein leerer Bestand
  // eine Historienflut ausloest. Er ist Pflicht, nicht Empfehlung.
  assert.throws(() => F.configFor("monitor", { QUANTUS_V3_MONITOR_START_LOCAL_DATE: undefined }),
    /QUANTUS_V3_MONITOR_START_LOCAL_DATE/);
  assert.throws(() => F.configFor("monitor", { QUANTUS_V3_MONITOR_START_LOCAL_DATE: "19.09.2026" }),
    /QUANTUS_V3_MONITOR_START_LOCAL_DATE/);
});

test("scheitert das Einreihen, bleibt die Absicht offen und wird gezaehlt", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  m.tasks.failOnce("cloud_tasks_unavailable");
  const res = await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.enqueueFailures, 1);
  assert.equal(res.json.dispatched, 1);
  // Die Absicht steht weiter im Kern und kommt im naechsten Tick wieder.
  const offen = Object.values(m.core.store.snapshot().automation.runtime.continuationsById);
  assert.equal(offen.length, 2);
  assert.ok(offen.every((i) => i.state === "pending"));
});

/* ── Vorabcheck ────────────────────────────────────────────────────────── */

test("der 22:30-Vorabcheck repariert nur Bestehendes und legt nie einen Hauptauftrag an", async (t) => {
  const m = await monitorService({ startMs: NOW });
  t.after(() => m.service.close());
  // Erst einen Vorfall und eine Absicht erzeugen lassen …
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });
  const taskCountVorher = m.tasks.created.size;

  // … dann um 22:30 den Vorabcheck.
  m.clock.set(PLAN.wallTimeToMs("2026-09-19", 22, 30));
  const res = await m.service.post("/v3/monitor/preflight", { token: m.token(F.AUD.monitorPreflight) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.applicable, true);
  assert.equal(res.json.newMainRuns, 0);
  assert.ok(res.json.repairs >= 2);
  assert.equal(res.json.duplicateTasks, taskCountVorher, "die bestehenden Absichten, sonst nichts");
  assert.equal(res.json.dispatched, 0);

  // Der Vorabcheck hat NICHTS am Bestand veraendert.
  const runtime = m.core.store.snapshot().automation.runtime;
  assert.equal(Object.keys(runtime.continuationsById).length, 2);
  assert.equal(Object.keys(runtime.runsByKey).length, 0);
  // Insbesondere gibt es keinen Lauf und keine Absicht fuer close23.
  const close23 = PLAN.slotRunKey(F.TENANT, "2026-09-19", "close23", F.POLICY_VERSION);
  assert.equal(Object.values(runtime.continuationsById).some((i) => i.runKey === close23), false);
});

test("ausserhalb seines Fensters tut der Vorabcheck nichts", async (t) => {
  const m = await monitorService({ startMs: PLAN.wallTimeToMs("2026-09-19", 20, 0) });
  t.after(() => m.service.close());
  const res = await m.service.post("/v3/monitor/preflight", { token: m.token(F.AUD.monitorPreflight) });
  assert.equal(res.status, 200);
  assert.equal(res.json.applicable, false);
  assert.equal(res.json.reason, "outside_preflight_window");
  assert.equal(res.json.repairs, 0);
});

test("der Monitor nimmt keine Tokens des Scheduler-Start-Kontos an", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  const fremd = F.schedulerToken(m.key, { audience: F.AUD.monitorTick, email: F.SA.schedulerStart, nowMs: NOW });
  const res = await m.service.post("/v3/monitor/tick", { token: fremd });
  assert.equal(res.status, 401);
});

/* ── Watchdog ──────────────────────────────────────────────────────────── */

test("der Watchdog laeuft als eigener Dienst ohne Task-Port", async (t) => {
  const w = await watchdogService();
  t.after(() => w.service.close());
  assert.deepEqual(w.service.app.router.routes, ["POST /v3/watchdog/check"]);
  assert.equal(w.service.app.ports.has("tasks"), false);
  assert.equal(w.service.app.ports.has("sectionWork"), false);
});

test("ein frischer Herzschlag ist kein Alarm", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });

  const w = await watchdogService({ core: m.core, startMs: NOW + 60_000 });
  t.after(() => w.service.close());
  const res = await w.service.post("/v3/watchdog/check", { token: w.token() });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.stale, false);
  assert.equal(res.json.alerted, false);
  assert.deepEqual(w.alert.sent, []);
});

test("ein alter Herzschlag loest genau eine Warnung aus", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });

  const w = await watchdogService({ core: m.core, startMs: NOW + 30 * 60_000 });
  t.after(() => w.service.close());
  const res = await w.service.post("/v3/watchdog/check", { token: w.token() });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.stale, true);
  assert.equal(res.json.alerted, true);
  assert.equal(res.json.missedTicks, 5);
  assert.equal(w.alert.sent.length, 1);
  assert.equal(w.alert.sent[0].kind, "monitor_heartbeat_stale");
});

test("eine fehlgeschlagene Warnung gilt nie als zugestellt und wird verbucht", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });

  for (const modus of [{ delivered: false }, { throws: true }]) {
    const w = await watchdogService({ core: m.core, startMs: NOW + 30 * 60_000, ...modus });
    t.after(() => w.service.close());
    const res = await w.service.post("/v3/watchdog/check", { token: w.token() });
    assert.equal(res.status, 503, JSON.stringify(modus));
    assert.equal(res.json.error, "warning_delivery_failed");
    assert.equal(res.json.detail.recorded, true);
  }
  const monitor = m.core.store.snapshot().automation.runtime.monitor;
  assert.equal(monitor.warnFailures, 1, "derselbe Fuenf-Minuten-Eimer wird nur einmal gezaehlt");
  assert.equal(monitor.lastWarnFailureChannel, "watchdog_primary");
});

test("ohne Warnweg gibt es 503, keinen stillen Erfolg", async (t) => {
  const m = await monitorService();
  t.after(() => m.service.close());
  await m.service.post("/v3/monitor/tick", { token: m.token(F.AUD.monitorTick) });

  const key = F.createSigningKey();
  const clock = F.createClock(NOW + 30 * 60_000);
  const service = await F.startService({
    role: "watchdog",
    ports: { clock: clock.port, jwks: F.jwksPort(key), core: m.core.port, alert: F.unavailablePort("alert", "alert_channel_not_wired") },
  });
  t.after(() => service.close());
  const token = F.schedulerToken(key, { audience: F.AUD.watchdogCheck, email: F.SA.schedulerWatchdog, nowMs: clock.value });
  const res = await service.post("/v3/watchdog/check", { token });
  assert.equal(res.status, 503);
  assert.equal(res.json.error, "port_unavailable");
  assert.equal(res.json.detail.port, "alert");
});
