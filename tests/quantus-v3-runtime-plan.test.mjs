/* ══ Paket E1-C: Sollplan, Monitor, Wiederholung, Tagesbetrieb ════════════
 *
 * Produktionsbefund, aus dem diese Datei entstanden ist: der Sollplan der
 * v3-Laufzeit existierte bisher nur als Text im Gesamtkonzept. Ohne
 * ausfuehrbaren Plan gibt es keine pruefbare Antwort auf die Fragen
 *   · welche vier Slots sind an einem Umstellungstag wirklich faellig,
 *   · was passiert, wenn ein Slot gar nicht erst startet, und
 *   · wie oft darf eine Zustellung wiederholt werden.
 * Die Tests rufen die echten Funktionen mit echten Zeitpunkten auf; es gibt
 * keine Stringpruefung auf Quelltext und keinen Mock, der immer ok sagt.
 *
 * Belegt (soweit ein reines Planungspaket reichen kann): T21 (Monitor
 * erkennt und holt nach), T22 (Zuerich-Sommer-/Winterzeit ergibt eindeutige
 * Slots), T39 (Heartbeat und fehlgeschlagene Warnzustellung), Teile von T24
 * und T34.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";

const TENANT = "quantus";
const PV = "3.0";
const iso = (s) => Date.parse(s);

/* ── Genau vier Hauptslots ─────────────────────────────────────────────── */

test("es gibt exakt vier Hauptslots mit festen Ortszeiten", () => {
  assert.equal(P.MAIN_SLOTS.length, 4);
  assert.deepEqual(P.SLOT_NAMES, ["briefing04", "process09", "continue14", "close23"]);
  assert.deepEqual(P.MAIN_SLOTS.map((s) => `${s.hour}:${s.minute}`), ["4:0", "9:0", "14:0", "23:0"]);
  assert.throws(() => P.requireSlot("preflight2230"), /unknown_slot/);
  assert.throws(() => { P.MAIN_SLOTS.push({ slot: "extra" }); }, TypeError);
});

test("der Slotschluessel ist stabil und streng geprueft", () => {
  const a = P.slotRunKey(TENANT, "2026-09-19", "process09", PV);
  const b = P.slotRunKey(TENANT, "2026-09-19", "process09", PV);
  assert.equal(a, b);
  assert.equal(a, "quantus:2026-09-19:process09:3.0");
  assert.deepEqual(P.parseSlotRunKey(a), { tenant: TENANT, localDate: "2026-09-19", slot: "process09", policyVersion: PV, runKey: a });
  assert.throws(() => P.slotRunKey("quan:tus", "2026-09-19", "process09", PV), /invalid_tenant/);
  assert.throws(() => P.slotRunKey(TENANT, "2026-13-01", "process09", PV), /invalid_local_date/);
  assert.throws(() => P.slotRunKey(TENANT, "2026-02-30", "process09", PV), /invalid_local_date/);
  assert.throws(() => P.slotRunKey(TENANT, "2026-09-19", "process09", "3 0"), /invalid_policy_version/);
  assert.throws(() => P.parseSlotRunKey("quantus:2026-09-19:process09"), /invalid_run_key/);
});

/* ── T22: Sommer-/Winterzeit ───────────────────────────────────────────── */

test("T22 Umstellung Fruehjahr 2026-03-29: vier eindeutige Slots in CEST", () => {
  const slots = P.plannedSlots(TENANT, "2026-03-29", PV);
  assert.deepEqual(slots.map((s) => new Date(s.plannedAtMs).toISOString()), [
    "2026-03-29T02:00:00.000Z", // 04:00 CEST
    "2026-03-29T07:00:00.000Z",
    "2026-03-29T12:00:00.000Z",
    "2026-03-29T21:00:00.000Z",
  ]);
  assert.equal(new Set(slots.map((s) => s.runKey)).size, 4);
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i].plannedAtMs > slots[i - 1].plannedAtMs);
});

test("T22 Umstellung Herbst 2026-10-25: vier eindeutige Slots in CET", () => {
  const slots = P.plannedSlots(TENANT, "2026-10-25", PV);
  assert.deepEqual(slots.map((s) => new Date(s.plannedAtMs).toISOString()), [
    "2026-10-25T03:00:00.000Z", // 04:00 CET
    "2026-10-25T08:00:00.000Z",
    "2026-10-25T13:00:00.000Z",
    "2026-10-25T22:00:00.000Z",
  ]);
  assert.equal(new Set(slots.map((s) => s.runKey)).size, 4);
});

test("T22 der Assistententag ist am Umstellungstag 23 bzw. 25 Stunden lang", () => {
  const kurz = P.assistantDayEndMs("2026-03-28") - P.wallTimeToMs("2026-03-28", 4, 0);
  const lang = P.assistantDayEndMs("2026-10-24") - P.wallTimeToMs("2026-10-24", 4, 0);
  assert.equal(kurz, 23 * P.HOUR_MS);
  assert.equal(lang, 25 * P.HOUR_MS);
});

test("T22 Luecke und Doppelung sind festgelegt, nicht zufaellig", () => {
  // 02:30 gibt es am 29.03. nicht — nach vorn geschoben auf 03:30 Ortszeit.
  assert.equal(new Date(P.wallTimeToMs("2026-03-29", 2, 30)).toISOString(), "2026-03-29T01:30:00.000Z");
  // 02:30 gibt es am 25.10. zweimal — der FRUEHERE Zeitpunkt gilt.
  assert.equal(new Date(P.wallTimeToMs("2026-10-25", 2, 30)).toISOString(), "2026-10-25T00:30:00.000Z");
  // Die Umstellung liegt um 01:00 UTC (02:00 CET -> 03:00 CEST).
  assert.equal(P.zurichOffsetMinutes(iso("2026-03-29T00:59:00Z")), 60);
  assert.equal(P.zurichOffsetMinutes(iso("2026-03-29T01:01:00Z")), 120);
  assert.equal(P.zurichOffsetMinutes(iso("2026-10-25T00:59:00Z")), 120);
  assert.equal(P.zurichOffsetMinutes(iso("2026-10-25T01:01:00Z")), 60);
});

test("der Assistententag beginnt um 04:00 Ortszeit", () => {
  assert.equal(P.assistantDay(iso("2026-09-20T00:30:00+02:00")), "2026-09-19");
  assert.equal(P.assistantDay(iso("2026-09-20T04:00:00+02:00")), "2026-09-20");
  assert.equal(P.localDate(iso("2026-09-20T00:30:00+02:00")), "2026-09-20");
});

test("nextSlotStartMs laeuft ueber die Tagesgrenze weiter", () => {
  const nachts = iso("2026-09-20T01:00:00+02:00");
  assert.equal(new Date(P.nextSlotStartMs(nachts)).toISOString(), new Date(P.wallTimeToMs("2026-09-20", 4, 0)).toISOString());
  const nachmittag = iso("2026-09-19T15:00:00+02:00");
  assert.equal(P.nextSlotStartMs(nachmittag), P.wallTimeToMs("2026-09-19", 23, 0));
});

test("ungueltige Zeitpunkte werden abgewiesen, nicht stillschweigend gedeutet", () => {
  for (const bad of [NaN, Infinity, "2026-09-19", null, undefined, 1.5e300]) {
    assert.throws(() => P.localDate(bad), /invalid_timestamp/, `Wert ${String(bad)}`);
  }
  assert.throws(() => P.plannedSlots(TENANT, "2026-09-19", PV, { toleranceMs: -1 }), /invalid_tolerance/);
  assert.throws(() => P.wallTimeToMs("2026-09-19", 24, 0), /invalid_wall_hour/);
});

/* ── T21: Monitor ──────────────────────────────────────────────────────── */

const leereSicht = { runs: [], incidents: [], intents: [], monitor: { lastHeartbeatAtMs: null } };

test("T21 fehlender Start nach 10 Minuten ergibt Vorfall UND Nachholabsicht — auch ohne jeden Lauf", () => {
  const now = P.wallTimeToMs("2026-09-19", 9, 11); // 11 Minuten nach 09:00
  const plan = P.buildMonitorPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 1 });
  const runKey = P.slotRunKey(TENANT, "2026-09-19", "process09", PV);
  assert.deepEqual(plan.incidents.map((i) => i.id), [
    `inc:missed_start:${P.slotRunKey(TENANT, "2026-09-19", "briefing04", PV)}`,
    `inc:missed_start:${runKey}`,
  ]);
  const vorfall = plan.incidents.find((i) => i.runKey === runKey);
  assert.equal(vorfall.kind, "missed_slot_start");
  assert.equal(vorfall.runExists, false);
  assert.deepEqual(plan.intents.filter((i) => i.runKey === runKey).map((i) => i.id), [`catchup:${runKey}`]);
  assert.equal(plan.intents.find((i) => i.runKey === runKey).kind, "slot_catchup");
});

test("T21 innerhalb der Toleranz gibt es keinen Vorfall", () => {
  const now = P.wallTimeToMs("2026-09-19", 4, 9); // 9 Minuten nach 04:00
  const plan = P.buildMonitorPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 1 });
  assert.deepEqual(plan.incidents, []);
  assert.deepEqual(plan.intents, []);
});

test("T21 zweite Ausfuehrung im selben Fenster ergibt identische Kennungen und nichts Neues", () => {
  const now1 = P.wallTimeToMs("2026-09-19", 9, 11);
  const now2 = now1 + 90_000; // gleicher Fuenf-Minuten-Eimer? nein: neuer Tick, aber gleiche Ids
  const erst = P.buildMonitorPlan(leereSicht, { now: now1, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 1 });
  const sicht = {
    ...leereSicht,
    incidents: erst.incidents.map((i) => ({ id: i.id, resolvedAtMs: null })),
    intents: erst.intents.map((i) => ({ id: i.id, state: "pending", runKey: i.runKey, notBeforeMs: i.notBeforeMs, deliveries: 0 })),
  };
  const zweit = P.buildMonitorPlan(sicht, { now: now2, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 1 });
  assert.deepEqual(zweit.incidents, []);
  assert.deepEqual(zweit.intents, []);
  // Die faelligen Absichten werden erneut zur Zustellung vorgeschlagen — das
  // ist kein zweiter Auftrag, sondern dieselbe Absicht.
  assert.deepEqual(zweit.dispatch.map((d) => d.intentId).sort(), erst.intents.map((i) => i.id).sort());
  assert.equal(P.monitorTickId(TENANT, PV, now1), P.monitorTickId(TENANT, PV, now1 + 60_000));
  assert.notEqual(P.monitorTickId(TENANT, PV, now1), P.monitorTickId(TENANT, PV, now1 + 5 * 60_000));
});

test("T21 ein spaeter gestarteter Lauf loescht den Vorfall nicht, er markiert ihn nur", () => {
  const now = P.wallTimeToMs("2026-09-19", 10, 0);
  const runKey = P.slotRunKey(TENANT, "2026-09-19", "process09", PV);
  const incidentId = `inc:missed_start:${runKey}`;
  const sicht = {
    runs: [{ runKey, hasStarted: true, phase: "active" }],
    incidents: [{ id: incidentId, resolvedAtMs: null }],
    intents: [],
    monitor: { lastHeartbeatAtMs: now - 60_000 },
  };
  const plan = P.buildMonitorPlan(sicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 1 });
  assert.equal(plan.incidents.some((i) => i.id === incidentId), false);
  assert.deepEqual(plan.resolutions.filter((r) => r.incidentId === incidentId), [{ incidentId, resolvedBy: "run_started", atMs: now, runKey }]);
});

test("T21 der konfigurierte Startzeitraum verhindert eine Flut alter Nachholauftraege", () => {
  const now = P.wallTimeToMs("2026-09-19", 23, 30);
  const ohneGrenze = P.buildMonitorPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-01-01", windowDays: 14 });
  // Selbst mit 14 Tagen Fenster bleibt die Zahl neuer Eintraege je Tick gedeckelt.
  assert.equal(ohneGrenze.incidents.length + ohneGrenze.intents.length, P.MONITOR_MAX_NEW_PER_TICK);
  assert.equal(ohneGrenze.truncated, true);
  const mitGrenze = P.buildMonitorPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 14 });
  assert.equal(mitGrenze.incidents.length, 4);
  assert.equal(mitGrenze.intents.length, 4);
  assert.equal(mitGrenze.truncated, false);
  assert.equal(mitGrenze.windowFrom, "2026-09-19");
});

test("der Monitorplan ist deterministisch: gleiche Eingabe, gleiches Ergebnis", () => {
  const now = P.wallTimeToMs("2026-09-19", 14, 30);
  const a = P.buildMonitorPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 2 });
  const b = P.buildMonitorPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV, startLocalDate: "2026-09-19", windowDays: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

/* ── Vorabcheck 22:30 ──────────────────────────────────────────────────── */

test("der 22:30-Vorabcheck kann strukturell keinen fuenften Hauptauftrag erzeugen", () => {
  const now = P.wallTimeToMs("2026-09-19", 22, 30);
  const runKey = P.slotRunKey(TENANT, "2026-09-19", "continue14", PV);
  const sicht = {
    runs: [{ runKey, hasStarted: true, phase: "checkpointed", pendingContinuationId: "cont-1" }],
    incidents: [{ id: "inc:missed_start:x", resolvedAtMs: null, runKey }],
    intents: [{ id: "cont-1", state: "pending", runKey, notBeforeMs: now - 1000, deliveries: 1 }],
    monitor: {},
  };
  const plan = P.buildPreflightPlan(sicht, { now, tenant: TENANT, policyVersion: PV });
  assert.equal(plan.applicable, true);
  assert.deepEqual(plan.intents, []);
  assert.deepEqual(plan.incidents, []);
  assert.deepEqual(plan.newMainRuns, []);
  // Jede Reparatur zeigt auf eine BESTEHENDE Verpflichtung.
  const bekannt = new Set(["cont-1", "inc:missed_start:x", runKey]);
  for (const r of plan.repairs) assert.ok(bekannt.has(r.intentId || r.incidentId || r.runKey), JSON.stringify(r));
  assert.deepEqual(plan.repairs.map((r) => r.kind).sort(), ["escalate_open_incident", "redeliver_intent", "resume_checkpointed_run"]);
});

test("der Vorabcheck laeuft nur in seinem Fenster und legt fuer close23 nichts an", () => {
  const now = P.wallTimeToMs("2026-09-19", 22, 30);
  const leer = P.buildPreflightPlan(leereSicht, { now, tenant: TENANT, policyVersion: PV });
  assert.deepEqual(leer.repairs, []);
  const frueh = P.buildPreflightPlan(leereSicht, { now: P.wallTimeToMs("2026-09-19", 21, 0), tenant: TENANT, policyVersion: PV });
  assert.equal(frueh.applicable, false);
  assert.equal(frueh.reason, "outside_preflight_window");
  assert.deepEqual(frueh.repairs, []);
});

/* ── Zustellwiederholung ───────────────────────────────────────────────── */

test("voruebergehende Fehler: hoechstens 5 Zustellungen, Backoff 30 s bis 10 min", () => {
  const now = iso("2026-09-19T10:00:00Z");
  const warten = [1, 2, 3, 4].map((d) => P.planDeliveryRetry({ now, deliveries: d, errorClass: "transient" }).waitMs);
  assert.deepEqual(warten, [30_000, 60_000, 120_000, 240_000]);
  assert.equal(P.backoffMs(20), P.RETRY.maxMs);
  const schluss = P.planDeliveryRetry({ now, deliveries: 5, errorClass: "transient" });
  assert.equal(schluss.retry, false);
  assert.equal(schluss.reason, "max_deliveries");
  assert.equal(schluss.checkpoint, true, "Checkpoint statt Endlosschleife");
  assert.equal(schluss.incident, true);
});

test("429 beachtet Retry-After, aber nicht unbegrenzt", () => {
  const now = iso("2026-09-19T10:00:00Z");
  const kurz = P.planDeliveryRetry({ now, deliveries: 1, errorClass: "rate_limited", retryAfterMs: 5_000 });
  assert.equal(kurz.waitMs, 30_000, "nie kuerzer als der eigene Backoff");
  const lang = P.planDeliveryRetry({ now, deliveries: 1, errorClass: "rate_limited", retryAfterMs: 15 * 60_000 });
  assert.equal(lang.waitMs, 15 * 60_000);
  assert.equal(lang.honouredRetryAfter, true);
  const absurd = P.planDeliveryRetry({ now, deliveries: 1, errorClass: "rate_limited", retryAfterMs: 5 * 60 * 60_000 });
  assert.equal(absurd.waitMs, P.RETRY.retryAfterCapMs);
  const kaputt = P.planDeliveryRetry({ now, deliveries: 1, errorClass: "rate_limited", retryAfterMs: -5 });
  assert.equal(kaputt.waitMs, 30_000);
  assert.equal(kaputt.honouredRetryAfter, false);
});

test("401/403/Schema/Budget werden nicht blind wiederholt", () => {
  const now = iso("2026-09-19T10:00:00Z");
  for (const cls of ["auth", "forbidden", "schema", "budget", "policy", "not_found"]) {
    const plan = P.planDeliveryRetry({ now, deliveries: 1, errorClass: cls });
    assert.equal(plan.retry, false, cls);
    assert.equal(plan.terminal, true, cls);
    assert.equal(plan.nextAtMs, null, cls);
    assert.equal(plan.incident, true, cls);
  }
});

test("unklarer Mail-/Provider-Ausgang wird abgeglichen, nicht erneut gesendet", () => {
  const now = iso("2026-09-19T10:00:00Z");
  const plan = P.planDeliveryRetry({ now, deliveries: 1, errorClass: "unknown_outcome" });
  assert.equal(plan.retry, false);
  assert.equal(plan.requiresReconciliation, true);
  assert.equal(plan.terminal, false);
  // Auch eine unbekannte Fehlerklasse gilt als unklar, nicht als harmlos.
  const fremd = P.planDeliveryRetry({ now, deliveries: 1, errorClass: "irgendwas" });
  assert.equal(fremd.retry, false);
  assert.equal(fremd.requiresReconciliation, true);
  assert.throws(() => P.planDeliveryRetry({ now, deliveries: -1, errorClass: "transient" }), /invalid_deliveries/);
  assert.throws(() => P.planDeliveryRetry({ now, deliveries: 1.5, errorClass: "transient" }), /invalid_deliveries/);
});

/* ── Tagesbetrieb, Nacht, harte Fristen ────────────────────────────────── */

const tags = P.wallTimeToMs("2026-09-19", 10, 0);
const nachts = P.wallTimeToMs("2026-09-19", 23, 40);

test("tagsueber werden Antworten und bestaetigte Rueckgaben sofort bearbeitet", () => {
  for (const kind of ["answer", "confirmed_return"]) {
    const d = P.planItemHandling({ id: "i1", kind, leadId: "L1" }, { now: tags });
    assert.equal(d.action, "handle_now", kind);
    assert.equal(d.daytime, true);
  }
});

test("nicht dringender Neuintake wandert in den naechsten Hauptslot, nachts wird gesammelt", () => {
  const tag = P.planItemHandling({ id: "i2", kind: "intake" }, { now: tags });
  assert.equal(tag.action, "defer_to_slot");
  assert.equal(tag.resumeAtMs, P.wallTimeToMs("2026-09-19", 14, 0));
  const nacht = P.planItemHandling({ id: "i3", kind: "answer" }, { now: nachts });
  assert.equal(nacht.action, "collect");
  assert.equal(nacht.reason, "night_window");
  assert.equal(nacht.resumeAtMs, P.wallTimeToMs("2026-09-20", 4, 0));
});

test("T34 eine belegte harte Frist vor dem naechsten Slot kann Snooze und Minimalmodus nicht verdecken", () => {
  const frist = P.wallTimeToMs("2026-09-19", 12, 0); // vor dem 14-Uhr-Slot
  const item = {
    id: "i4", kind: "followup", leadId: "L9",
    hardDeadlineAtMs: frist,
    snoozedUntilMs: P.wallTimeToMs("2026-09-20", 9, 0),
    mandate: { ok: true, ref: "mandat-42" },
  };
  const mitBudget = P.planItemHandling(item, { now: tags, budgetAvailable: true, minimalMode: true });
  assert.equal(mitBudget.action, "handle_now");
  assert.equal(mitBudget.exception, true);
  assert.equal(mitBudget.hidden, false);

  const ohneBudget = P.planItemHandling(item, { now: tags, budgetAvailable: false, minimalMode: true });
  assert.equal(ohneBudget.action, "escalate");
  assert.equal(ohneBudget.reason, "hard_deadline_without_budget");
  assert.equal(ohneBudget.requiresIncident, true);

  const ohneMandat = P.planItemHandling({ ...item, mandate: null }, { now: tags, budgetAvailable: true });
  assert.equal(ohneMandat.action, "escalate");
  assert.equal(ohneMandat.reason, "hard_deadline_without_mandate");

  // Ohne harte Frist wirkt Snooze ganz normal.
  const normal = P.planItemHandling({ id: "i5", kind: "followup", snoozedUntilMs: tags + 3600_000 }, { now: tags });
  assert.equal(normal.action, "collect");
  assert.equal(normal.reason, "snoozed");
});

test("eine Ausnahme braucht Mandat UND Budget, auch bei dringendem Intake", () => {
  const dringend = { id: "i6", kind: "intake", urgent: true, mandate: { ok: true, ref: "m1" } };
  assert.equal(P.planItemHandling(dringend, { now: tags, budgetAvailable: true }).action, "handle_now");
  const ohne = P.planItemHandling(dringend, { now: tags, budgetAvailable: false });
  assert.equal(ohne.action, "defer_to_slot");
  assert.equal(ohne.reason, "urgent_without_budget");
});

test("faellige Nachfassungen werden je Lead zu EINER Absicht zusammengefasst", () => {
  const items = [
    { id: "f1", kind: "followup", leadId: "L1", dueAtMs: tags - 1000 },
    { id: "f2", kind: "followup", leadId: "L1", dueAtMs: tags - 2000 },
    { id: "f3", kind: "followup", leadId: "L2", dueAtMs: tags - 1000 },
    { id: "f4", kind: "followup", leadId: "L2", dueAtMs: tags + 3600_000 },
  ];
  const { coalesced, decisions } = P.coalesceFollowUps(items, { now: tags });
  assert.deepEqual(coalesced.map((c) => c.coalesceKey), ["L1", "L2"]);
  assert.deepEqual(coalesced[0].itemIds, ["f1", "f2"]);
  assert.deepEqual(coalesced[1].itemIds, ["f3"]);
  assert.equal(decisions.find((d) => d.itemId === "f4").reason, "followup_not_due");
});

test("unbekannte Arbeitsarten werden abgewiesen statt geraten", () => {
  assert.throws(() => P.planItemHandling({ id: "x", kind: "irgendwas" }, { now: tags }), /unknown_item_kind/);
  assert.throws(() => P.planItemHandling({ kind: "answer" }, { now: tags }), /invalid_item_id/);
  assert.throws(() => P.planItemHandling({ id: "x", kind: "answer", dueAtMs: 1.5 }, { now: tags }), /invalid_timestamp/);
});

/* ── T39: Heartbeat und Warnzustellung ─────────────────────────────────── */

test("T39 der Monitor-Heartbeat kennt seinen eigenen Ausfall und verspricht keine Verfuegbarkeit", () => {
  const now = iso("2026-09-19T10:00:00Z");
  const frisch = P.planHeartbeat({ now, lastHeartbeatAtMs: now - 60_000 });
  assert.equal(frisch.stale, false);
  assert.equal(frisch.missedTicks, 0);
  assert.equal(frisch.availabilityClaim, null);

  const alt = P.planHeartbeat({ now, lastHeartbeatAtMs: now - 25 * 60_000 });
  assert.equal(alt.stale, true);
  assert.equal(alt.escalate, true);
  assert.equal(alt.missedTicks, 4);

  const nie = P.planHeartbeat({ now, lastHeartbeatAtMs: null });
  assert.equal(nie.stale, true);
  assert.equal(nie.ageMs, null);

  // Der Watchdog ist ausdruecklich UNABHAENGIG.
  assert.equal(alt.watchdog.contract, "external_independent");
  assert.deepEqual([...alt.watchdog.mustNotShare], ["scheduler", "runtime", "credentials"]);
});

test("T39 eine fehlgeschlagene Warnzustellung gilt nie als zugestellt", () => {
  const now = iso("2026-09-19T10:00:00Z");
  const erst = P.planWarningEscalation({ now, failures: 0, channels: ["mail", "push"], channelsTried: ["mail"] });
  assert.equal(erst.assumeDelivered, false);
  assert.equal(erst.nextChannel, "push");
  assert.equal(erst.escalateToWatchdog, false);
  assert.equal(erst.failures, 1);

  const letzte = P.planWarningEscalation({ now, failures: 2, channels: ["mail", "push"], channelsTried: ["mail", "push"] });
  assert.equal(letzte.nextChannel, null);
  assert.equal(letzte.escalateToWatchdog, true);
  assert.equal(letzte.reason, "all_warning_channels_failed");
  assert.equal(letzte.assumeDelivered, false);
});

test("das Spaetfenster endet hart um 23:30 Ortszeit", () => {
  const fenster = P.lateWindow("2026-10-25");
  assert.equal(fenster.slot, "close23");
  assert.equal(new Date(fenster.startMs).toISOString(), "2026-10-25T22:00:00.000Z");
  assert.equal(new Date(fenster.hardStopAtMs).toISOString(), "2026-10-25T22:30:00.000Z");
  assert.equal(fenster.maxExtraSections, 2);
  assert.equal(fenster.sectionMs, 5 * 60_000);
});
