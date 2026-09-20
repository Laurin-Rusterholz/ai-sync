/* ══ Paket E1-C: der Monitorplan im zentralen Kern ════════════════════════
 *
 * Produktionsbefund: ein Monitor, der bei jeder Ausfuehrung dieselbe
 * Feststellung noch einmal aufschreibt, erzeugt binnen Stunden Tausende
 * Vorfaelle und verdeckt damit genau das, was er melden sollte. Und ein
 * Monitor, der nur dann etwas tut, wenn schon ein Lauf existiert, uebersieht
 * den schlimmsten Fall: den Slot, der gar nicht erst gestartet ist.
 *
 * Diese Datei fuehrt Plan (rein) und Schreibpfad (CAS) zusammen und prueft
 * beides gegen echte konkurrierende Schnappschuesse.
 *
 * Belegt: T21 (erkennen und nachholen ohne Duplikate), T39 (Heartbeat und
 * fehlgeschlagene Warnzustellung werden verbucht), Teile von T20.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createCasStore, casMutate, casRace, baseCore } from "./quantus-v3-runtime-cas-harness.mjs";

const TENANT = "quantus";
const PV = "3.0";
const SCOPE = "quantus:mainrun";
const START = "2026-09-19";
const NOW = P.wallTimeToMs(START, 9, 11);            // 11 Minuten nach 09:00
const KEY04 = P.slotRunKey(TENANT, START, "briefing04", PV);
const KEY09 = P.slotRunKey(TENANT, START, "process09", PV);

function tick(store, now) {
  const plan = P.buildMonitorPlan(S.projectMonitorView(store.snapshot()), {
    now, tenant: TENANT, policyVersion: PV, startLocalDate: START, windowDays: 1,
  });
  const out = casMutate(store, (d) => S.applyMonitorPlan(d, { plan, now }));
  return { plan, out };
}

test("T21 der Monitor legt Vorfall und Nachholabsicht an, obwohl es keinen Lauf gibt", () => {
  const store = createCasStore(baseCore());
  const { plan, out } = tick(store, NOW);
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.createdIncidents.sort(), [`inc:missed_start:${KEY04}`, `inc:missed_start:${KEY09}`].sort());
  assert.deepEqual(out.result.createdIntents.sort(), [`catchup:${KEY04}`, `catchup:${KEY09}`].sort());
  const rt = store.snapshot().automation.runtime;
  assert.equal(Object.keys(rt.runsByKey).length, 0, "der Monitor legt KEINEN Lauf an");
  assert.equal(rt.incidentsById[`inc:missed_start:${KEY09}`].resolvedAtMs, null);
  assert.equal(rt.incidentsById[`inc:missed_start:${KEY09}`].source, "monitor");
  assert.equal(rt.continuationsById[`catchup:${KEY09}`].state, "pending");
  assert.equal(rt.monitor.lastHeartbeatAtMs, NOW);
  assert.equal(plan.truncated, false);
});

test("T21 derselbe Tick zweimal ausgefuehrt schreibt nicht zweimal", () => {
  const store = createCasStore(baseCore());
  const { plan } = tick(store, NOW);
  const puts = store.stats.puts;
  const nochmal = casMutate(store, (d) => S.applyMonitorPlan(d, { plan, now: NOW }));
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(nochmal.wrote, false);
  assert.equal(store.stats.puts, puts);
});

test("T21 ein spaeterer Tick findet nichts Neues und flutet die Historie nicht", () => {
  const store = createCasStore(baseCore());
  tick(store, NOW);
  const spaeter = tick(store, NOW + 6 * 60_000);
  assert.deepEqual(spaeter.plan.incidents, []);
  assert.deepEqual(spaeter.plan.intents, []);
  assert.deepEqual(spaeter.out.result.createdIncidents, []);
  assert.deepEqual(spaeter.out.result.createdIntents, []);
  const rt = store.snapshot().automation.runtime;
  assert.equal(Object.keys(rt.incidentsById).length, 2);
  assert.equal(Object.keys(rt.continuationsById).length, 2);
  // Die faellige Absicht wird weiterhin zur Zustellung vorgeschlagen.
  assert.deepEqual(spaeter.plan.dispatch.map((d) => d.intentId).sort(), [`catchup:${KEY04}`, `catchup:${KEY09}`]);
});

test("T21 zwei Monitorlaeufe auf DEMSELBEN Schnappschuss erzeugen keine Duplikate", () => {
  const store = createCasStore(baseCore());
  const plan = P.buildMonitorPlan(S.projectMonitorView(store.snapshot()), {
    now: NOW, tenant: TENANT, policyVersion: PV, startLocalDate: START, windowDays: 1,
  });
  const rennen = casRace(
    store,
    (d) => S.applyMonitorPlan(d, { plan, now: NOW }),
    (d) => S.applyMonitorPlan(d, { plan, now: NOW }),
  );
  assert.equal(rennen.a.result.createdIncidents.length, 2);
  assert.equal(rennen.b.conflict, true);
  assert.equal(rennen.retryB.result.duplicate, true, "derselbe Tick ist schon verbucht");
  assert.equal(rennen.retryB.wrote, false);
  assert.equal(Object.keys(store.snapshot().automation.runtime.incidentsById).length, 2);
  assert.equal(store.stats.puts, 1);
});

test("T21 das Nachholen erledigt den Vorfall, loescht ihn aber nicht", () => {
  const store = createCasStore(baseCore());
  tick(store, NOW);
  const entdecktAm = store.snapshot().automation.runtime.incidentsById[`inc:missed_start:${KEY09}`].detectedAtMs;

  // Der Laeufer nimmt die Nachholabsicht auf und startet den fehlenden Slot.
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: NOW + 60_000 })).result;
  const verified = { holder: "r", fence, scope: SCOPE };
  casMutate(store, (d) => S.recordContinuationDelivery(d, { continuationId: `catchup:${KEY09}`, deliveryId: "dlv-1", now: NOW + 61_000 }));
  const start = casMutate(store, (d) => S.startRunSection(d, {
    runKey: KEY09, sectionId: "s1", now: NOW + 62_000, verifiedScope: verified, resumeFrom: `catchup:${KEY09}`,
  }));
  assert.equal(start.result.started, true, "die Nachholabsicht legt den fehlenden Lauf an");
  assert.equal(store.snapshot().automation.runtime.continuationsById[`catchup:${KEY09}`].state, "consumed");

  const spaeter = tick(store, NOW + 10 * 60_000);
  assert.deepEqual(spaeter.out.result.resolved, [`inc:missed_start:${KEY09}`]);
  const vorfall = store.snapshot().automation.runtime.incidentsById[`inc:missed_start:${KEY09}`];
  assert.equal(vorfall.resolvedAtMs, NOW + 10 * 60_000);
  assert.equal(vorfall.resolvedBy, "run_started");
  assert.equal(vorfall.detectedAtMs, entdecktAm, "der historische Vorfall bleibt unveraendert stehen");
  assert.equal(vorfall.kind, "missed_slot_start");
});

test("T20 dieselbe Nachholabsicht doppelt zugestellt startet den Slot nur einmal", () => {
  const store = createCasStore(baseCore());
  tick(store, NOW);
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: NOW + 60_000 })).result;
  const verified = { holder: "r", fence, scope: SCOPE };
  const intentId = `catchup:${KEY09}`;
  casMutate(store, (d) => S.recordContinuationDelivery(d, { continuationId: intentId, deliveryId: "dlv-1", now: NOW + 61_000 }));
  casMutate(store, (d) => S.recordContinuationDelivery(d, { continuationId: intentId, deliveryId: "dlv-2", now: NOW + 61_500 }));
  casMutate(store, (d) => S.startRunSection(d, { runKey: KEY09, sectionId: "s1", now: NOW + 62_000, verifiedScope: verified, resumeFrom: intentId }));
  const zweit = casMutate(store, (d) => S.startRunSection(d, { runKey: KEY09, sectionId: "s2", now: NOW + 63_000, verifiedScope: verified, resumeFrom: intentId }));
  assert.equal(zweit.result.alreadyConsumed, true);
  assert.equal(zweit.wrote, false);
  assert.equal(Object.keys(store.snapshot().automation.runtime.runsByKey[KEY09].sections).length, 1);
  assert.equal(store.snapshot().automation.runtime.continuationsById[intentId].deliveries, 2);
});

test("der Monitor braucht keinen fuehrenden Besitz und stoert einen laufenden Lauf nicht", () => {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: NOW })).result;
  const { out } = tick(store, NOW + 1000);
  assert.equal(out.result.ok, true);
  assert.equal(store.snapshot().automation.activeLease.holder, "runner-a");
  assert.equal(store.snapshot().automation.activeLease.fence, fence);
  assert.equal(S.requiresLeadership("monitor"), false);
});

test("ein fremder oder zeitlich unpassender Plan wird abgewiesen", () => {
  const store = createCasStore(baseCore());
  const plan = P.buildMonitorPlan(S.projectMonitorView(store.snapshot()), {
    now: NOW, tenant: TENANT, policyVersion: PV, startLocalDate: START, windowDays: 1,
  });
  assert.throws(() => S.applyMonitorPlan(store.snapshot(), { plan, now: NOW + 1 }), /monitor_plan_time_mismatch/);
  assert.throws(() => S.applyMonitorPlan(store.snapshot(), { plan: { ...plan, schema: "fremd" }, now: NOW }), /invalid_monitor_plan/);
  assert.throws(() => S.applyMonitorPlan(store.snapshot(), { plan: { ...plan, kind: "preflight" }, now: NOW }), /invalid_monitor_plan/);
  assert.equal(store.stats.puts, 0);
});

test("eine gedeckelte Tickmenge wird als gedeckelt vermerkt, nicht stillschweigend verschluckt", () => {
  const store = createCasStore(baseCore());
  const spaet = P.wallTimeToMs(START, 23, 30);
  const plan = P.buildMonitorPlan(S.projectMonitorView(store.snapshot()), {
    now: spaet, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-01", windowDays: 14,
  });
  assert.equal(plan.truncated, true);
  const out = casMutate(store, (d) => S.applyMonitorPlan(d, { plan, now: spaet }));
  assert.equal(out.result.truncated, true);
  assert.equal(store.snapshot().automation.runtime.monitor.lastTruncatedAtMs, spaet);
});

test("die Tick-Historie bleibt beschraenkt", () => {
  const store = createCasStore(baseCore());
  for (let i = 0; i < S.MONITOR_TICK_HISTORY + 5; i++) tick(store, NOW + i * 5 * 60_000);
  const monitor = store.snapshot().automation.runtime.monitor;
  assert.equal(monitor.recentTickIds.length, S.MONITOR_TICK_HISTORY);
  assert.equal(Object.keys(monitor.ticksById).length, S.MONITOR_TICK_HISTORY);
});

test("T39 eine fehlgeschlagene Warnzustellung wird verbucht und nie als zugestellt gewertet", () => {
  const store = createCasStore(baseCore());
  const erst = casMutate(store, (d) => S.recordWarningFailure(d, { channel: "mail", failureId: "wf-1", now: NOW }));
  assert.equal(erst.result.warnFailures, 1);
  assert.equal(erst.result.assumeDelivered, false);
  const gleich = casMutate(store, (d) => S.recordWarningFailure(d, { channel: "mail", failureId: "wf-1", now: NOW + 1000 }));
  assert.equal(gleich.result.duplicate, true);
  assert.equal(gleich.wrote, false);
  const zweit = casMutate(store, (d) => S.recordWarningFailure(d, { channel: "push", failureId: "wf-2", now: NOW + 2000 }));
  assert.equal(zweit.result.warnFailures, 2);

  // Der Plan sieht den Zustand und eskaliert an den unabhaengigen Watchdog.
  const sicht = S.projectMonitorView(store.snapshot());
  assert.equal(sicht.monitor.warnFailures, 2);
  const eskalation = P.planWarningEscalation({ now: NOW + 3000, failures: sicht.monitor.warnFailures, channels: ["mail", "push"], channelsTried: ["mail", "push"] });
  assert.equal(eskalation.escalateToWatchdog, true);
  assert.equal(eskalation.assumeDelivered, false);
});

test("projectMonitorView liest nur und legt nichts an", () => {
  const roh = baseCore();
  const sicht = S.projectMonitorView(roh);
  assert.deepEqual(sicht.runs, []);
  assert.deepEqual(sicht.incidents, []);
  assert.deepEqual(sicht.intents, []);
  assert.equal(sicht.monitor.lastHeartbeatAtMs, null);
  assert.equal(roh.automation.runtime, undefined, "die Nur-Lese-Sicht hat nichts angelegt");
  assert.equal(roh.automation.dataRevision, 7);
});

test("ein kaputter Laufzeitbereich sperrt, statt ihn zu ueberschreiben", () => {
  const nachweis = { schemaVersion: 1, initializedAtMs: 1, initializedBy: "test" };
  const kaputt = baseCore({ automation: { schemaVersion: 3, dataRevision: 1, idempotencyByKey: {}, runtimeInit: nachweis, runtime: { schemaVersion: 99 } } });
  assert.throws(() => S.projectMonitorView(kaputt), (e) => e.code === "runtime_area_invalid" && e.status === 503);
  const falschTyp = baseCore({ automation: { schemaVersion: 3, dataRevision: 1, idempotencyByKey: {}, runtimeInit: nachweis, runtime: "nein" } });
  assert.throws(() => S.readRuntime(falschTyp), (e) => e.code === "runtime_area_invalid");
  // Ein Bereich ohne seinen Initialisierungsnachweis ist ebenfalls gesperrt.
  const ohneNachweis = baseCore({ automation: { schemaVersion: 3, dataRevision: 1, idempotencyByKey: {}, runtime: S.emptyRuntimeArea() } });
  assert.throws(() => S.readRuntime(ohneNachweis), (e) => e.code === "runtime_init_marker_missing" && e.status === 503);
});
