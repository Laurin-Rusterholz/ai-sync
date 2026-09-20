/* ══ E1 — die sechs Gegenbeispiele der ZWEITEN Pruefungsrunde ════════════
 *
 * Nach 8031323 sind in vier Gruppen sechs weitere echte Gegenbeispiele
 * durchgekommen. Sie stehen hier als eigene Datei, damit keines davon
 * still zurueckfaellt. Alle benutzen echte Funktionen und echte
 * CAS-Schnappschuesse.
 *
 * Vorlage wie in der Pruefung: synthetische Policy (fixture: true),
 * Anbieter `fixture-provider`, Modell `model-a`, 1000 Mikro je Million
 * Eingabetoken und 2000 je Million Ausgabetoken, Tag 300 / Lauf 300 /
 * Aufruf 250. Keine echten Preise, keine echte Freigabe.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createCasStore, casMutate, casRace } from "./quantus-v3-runtime-cas-harness.mjs";

const SCOPE = "quantus:mainrun";
const ANBIETER = "fixture-provider";
const MODELL = "model-a";
const HASH_A = "hashAAAAAAAAAAAAAAAA";
const HASH_B = "hashBBBBBBBBBBBBBBBB";
const T0 = P.wallTimeToMs("2026-09-19", 9, 0);
const RUNKEY = P.slotRunKey("quantus", "2026-09-19", "process09", "3.0");
const TOKENS_100 = { inputTokens: 100_000, outputTokens: 0 };   // = 100 Mikro
const TOKENS_200 = { inputTokens: 200_000, outputTokens: 0 };   // = 200 Mikro

function minimalCore() {
  return {
    entities: {},
    automation: { schemaVersion: 3, dataRevision: 0, idempotencyByKey: {}, activeLease: null },
  };
}

function policy(over = {}, basis = T0) {
  return {
    schema: "quantus-v3-cost-policy/1",
    version: "synthetic-1",
    fixture: true,
    currency: "CHF",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: basis - 86_400_000 },
    effectiveFromMs: basis - 86_400_000,
    effectiveUntilMs: basis + 30 * 86_400_000,
    dayLimitMicros: 300,
    runLimitMicros: 300,
    callLimitMicros: 250,
    unresolvedBlockMicros: 1000,
    featureFlags: { providers: "live" },
    models: {
      [`${ANBIETER}:${MODELL}`]: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 },
    },
    ...over,
  };
}

function aufgesetzt(now = T0) {
  const store = createCasStore(minimalCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now }));
  assert.equal(a.result.ok, true);
  return { store, verified: { holder: "runner-a", fence: a.result.fence, scope: SCOPE } };
}

function reserviere(store, verified, over = {}) {
  return casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-1", runKey: RUNKEY, provider: ANBIETER, model: MODELL,
    contentHash: HASH_A, now: T0, verifiedScope: verified, policy: policy(),
    __allowFixturePolicy: true, ...TOKENS_100, ...over,
  }));
}

function claim(store, verified, over = {}) {
  return casMutate(store, (d) => S.claimCostDispatch(d, {
    callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified,
    policy: policy(), __allowFixturePolicy: true, ...over,
  }));
}

/* ── R2-01: der Claim muss die AKTUELLE Freigabe pruefen ───────────────── */

test("R2-01a eine inzwischen auf dry_run gestellte Policy erlaubt keinen Dispatch", () => {
  const { store, verified } = aufgesetzt();
  assert.equal(reserviere(store, verified).result.ok, true);
  assert.throws(() => S.claimCostDispatch(store.snapshot(), {
    callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified,
    policy: policy({ featureFlags: { providers: "dry_run" } }), __allowFixturePolicy: true,
  }), (e) => e.code === "providers_not_live" && e.status === 409);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

test("R2-01b eine abgelaufene Policy erlaubt keinen Dispatch", () => {
  const { store, verified } = aufgesetzt();
  assert.equal(reserviere(store, verified).result.ok, true);
  assert.throws(() => S.claimCostDispatch(store.snapshot(), {
    callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified,
    policy: policy({ effectiveUntilMs: T0 - 1 }), __allowFixturePolicy: true,
  }), (e) => e.code === "cost_policy_invalid" && e.status === 503 && e.detail.errors.includes("cost_policy_expired"));
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

test("R2-01c eine fehlende oder nicht freigegebene Policy erlaubt keinen Dispatch", () => {
  const { store, verified } = aufgesetzt();
  assert.equal(reserviere(store, verified).result.ok, true);
  for (const [name, p] of [
    ["fehlt", undefined],
    ["null", null],
    ["ohne Freigabe", policy({ approval: null })],
  ]) {
    assert.throws(() => S.claimCostDispatch(store.snapshot(), {
      callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified,
      policy: p, __allowFixturePolicy: true,
    }), (e) => e.status === 503 || e.status === 409, name);
  }
  // Eine Policy, in der das Modell dieses Aufrufs gar nicht mehr steht,
  // ist eine sichtbare Absage ohne Schreibvorgang.
  const ohnePreiszeile = casMutate(store, (d) => S.claimCostDispatch(d, {
    callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified,
    policy: policy({ models: { "fremd:modell": { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1, maxCallMicros: 10 } } }),
    __allowFixturePolicy: true,
  }));
  assert.equal(ohnePreiszeile.result.code, "policy_price_unavailable");
  assert.equal(ohnePreiszeile.wrote, false);
  // Eine erfundene Testvorlage kommt ohne ausdrueckliche Erlaubnis nicht durch.
  assert.throws(() => S.claimCostDispatch(store.snapshot(), {
    callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified, policy: policy(),
  }), (e) => e.detail.errors.includes("cost_policy_fixture_rejected"));
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

test("R2-01d Positivkontrolle: mit frischer Freigabe klappt der Claim genau einmal", () => {
  const { store, verified } = aufgesetzt();
  reserviere(store, verified);
  const erst = claim(store, verified);
  assert.equal(erst.result.ok, true);
  assert.equal(erst.result.dispatchAllowed, true);
  assert.equal(erst.result.policyVersion, "synthetic-1");
  assert.equal(erst.result.billingLocalDate, "2026-09-19");

  const zweit = claim(store, verified, { claimId: "dispatch-2", now: T0 + 2000 });
  assert.equal(zweit.result.ok, false);
  assert.equal(zweit.result.code, "dispatch_already_claimed");
  assert.equal(zweit.wrote, false);
});

test("R2-01e ein inzwischen geaenderter Preis oder eine gesenkte Grenze sperrt den Claim", () => {
  const teurer = { inputMicrosPerMillionTokens: 2000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 };
  const { store, verified } = aufgesetzt();
  reserviere(store, verified);
  const preisWeg = claim(store, verified, { policy: policy({ models: { [`${ANBIETER}:${MODELL}`]: teurer } }) });
  assert.equal(preisWeg.result.code, "policy_price_changed");
  assert.equal(preisWeg.result.detail.reserved, 100);
  assert.equal(preisWeg.result.detail.current, 200);

  const grenzeGesenkt = claim(store, verified, { policy: policy({ callLimitMicros: 50, runLimitMicros: 50, dayLimitMicros: 50 }) });
  assert.equal(grenzeGesenkt.result.code, "call_limit_lowered");
  assert.equal(grenzeGesenkt.result.detail.limit, 50);
  assert.equal(grenzeGesenkt.wrote, false);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

/* ── R2-02: Tageswechsel zwischen Reservierung und Sendung ─────────────── */

test("R2-02 ein Tageswechsel zwischen Reservierung und Dispatch sprengt das Tagesbudget nicht", () => {
  const T = Date.parse("2026-09-19T23:59:30+02:00");
  const SPAETER = T + 31_000;                      // 2026-09-20T00:00:01+02:00
  assert.equal(P.localDate(T), "2026-09-19");
  assert.equal(P.localDate(SPAETER), "2026-09-20");

  const store = createCasStore(minimalCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T }));
  const verified = { holder: "runner-a", fence: a.result.fence, scope: SCOPE };
  const gestern = P.slotRunKey("quantus", "2026-09-19", "close23", "3.0");
  const heute = P.slotRunKey("quantus", "2026-09-20", "briefing04", "3.0");
  const p = policy({}, T);

  const alt = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-1", runKey: gestern, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
    now: T, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS_200,
  }));
  assert.equal(alt.result.ok, true);
  assert.equal(alt.result.billingLocalDate, "2026-09-19");

  // Nach Mitternacht: frisches Tagesbudget, also geht eine zweite
  // Reservierung durch.
  const neu = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-today", runKey: heute, provider: ANBIETER, model: MODELL, contentHash: HASH_B,
    now: SPAETER, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS_200,
  }));
  assert.equal(neu.result.ok, true);
  assert.equal(neu.result.billingLocalDate, "2026-09-20");

  // Der alte Anspruch darf jetzt NICHT mehr gegen das Budget von gestern
  // gehalten werden — sonst gaeben beide zusammen 400 Mikro am 20. aus.
  const spaeterClaim = casMutate(store, (d) => S.claimCostDispatch(d, {
    callId: "call-1", claimId: "dispatch-1", now: SPAETER, verifiedScope: verified,
    policy: p, __allowFixturePolicy: true,
  }));
  assert.equal(spaeterClaim.result.ok, false);
  assert.equal(spaeterClaim.result.code, "billing_day_rolled_over");
  assert.equal(spaeterClaim.result.detail.reservedFor, "2026-09-19");
  assert.equal(spaeterClaim.result.detail.today, "2026-09-20");
  assert.equal(spaeterClaim.wrote, false);

  // Der kontrollierte Weg: belegt freigeben und neu reservieren — und dann
  // greift die Tagesgrenze von 300 wie sie soll.
  const freigabe = casMutate(store, (d) => S.releaseCostReservation(d, {
    callId: "call-1", now: SPAETER, verifiedScope: verified,
    evidence: { kind: "day_rollover", ref: "tageswechsel-2026-09-20" },
  }));
  assert.equal(freigabe.result.ok, true);
  const nochmal = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-1-neu", runKey: gestern, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
    now: SPAETER, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS_200,
  }));
  assert.equal(nochmal.result.ok, false);
  assert.equal(nochmal.result.code, "day_budget_exceeded");
  assert.equal(nochmal.result.detail.localDate, "2026-09-20");
  assert.equal(nochmal.result.detail.wouldBe, 400);

  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.byDay["2026-09-20"].openMicros, 200, "genau ein offener Aufruf am 20.");
  assert.equal(cost.byDay["2026-09-19"].openMicros, 0);
  assert.equal(cost.byDay["2026-09-19"].releasedMicros, 200, "keine doppelte Freigabe");
});

/* ── R2-03: zwei vorbereitete Duplikate ────────────────────────────────── */

function zweiDuplikate() {
  const { store, verified } = aufgesetzt();
  for (const callId of ["call-1", "call-2"]) {
    const r = casMutate(store, (d) => S.reserveCost(d, {
      callId, runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
      now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS_100,
    }));
    assert.equal(r.result.ok, true, callId);
  }
  return { store, verified };
}

test("R2-03 der zweite gleich lautende Aufruf kann nicht auch noch beansprucht werden", () => {
  const { store, verified } = zweiDuplikate();
  const erst = claim(store, verified);
  assert.equal(erst.result.dispatchAllowed, true);

  const zweit = casMutate(store, (d) => S.claimCostDispatch(d, {
    callId: "call-2", claimId: "dispatch-2", now: T0 + 2000, verifiedScope: verified,
    policy: policy(), __allowFixturePolicy: true,
  }));
  assert.equal(zweit.result.ok, false);
  assert.equal(zweit.result.code, "unknown_outcome_blocks_retry");
  assert.equal(zweit.result.detail.blockingCallId, "call-1");
  assert.equal(zweit.result.detail.reason, "dispatch_claimed_unresolved");
  assert.equal(zweit.wrote, false);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-2"].dispatch.claimed, false);
});

test("R2-03b zwei gleichzeitige Anspruechte auf demselben Schnappschuss: nur einer sendet", () => {
  const { store, verified } = zweiDuplikate();
  const rennen = casRace(
    store,
    (d) => S.claimCostDispatch(d, { callId: "call-1", claimId: "dispatch-1", now: T0 + 1000, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true }),
    (d) => S.claimCostDispatch(d, { callId: "call-2", claimId: "dispatch-2", now: T0 + 1000, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true }),
  );
  assert.equal(rennen.a.result.dispatchAllowed, true);
  assert.equal(rennen.b.result.dispatchAllowed, true, "auf dem alten Schnappschuss sah B noch frei");
  assert.equal(rennen.b.conflict, true, "der CAS hat den zweiten Schreibvorgang abgewiesen");
  assert.equal(rennen.retryB.result.ok, false);
  assert.equal(rennen.retryB.result.code, "unknown_outcome_blocks_retry");
  assert.equal(rennen.retryB.wrote, false);
  const calls = store.snapshot().automation.runtime.cost.callsById;
  assert.equal(calls["call-1"].dispatch.claimed, true);
  assert.equal(calls["call-2"].dispatch.claimed, false);
  assert.equal(store.stats.puts, 4, "Lease, zwei Reservierungen und genau EIN Claim");
});

test("R2-03c nach belegter Aufloesung des ersten darf der zweite senden", () => {
  const { store, verified } = zweiDuplikate();
  claim(store, verified);
  casMutate(store, (d) => S.settleCost(d, {
    callId: "call-1", actualMicros: 90, usageReceiptId: "receipt-1", providerRequestId: "req-1",
    now: T0 + 3000, verifiedScope: verified,
  }));
  const zweit = casMutate(store, (d) => S.claimCostDispatch(d, {
    callId: "call-2", claimId: "dispatch-2", now: T0 + 4000, verifiedScope: verified,
    policy: policy(), __allowFixturePolicy: true,
  }));
  assert.equal(zweit.result.ok, true);
  assert.equal(zweit.result.dispatchAllowed, true);
});

/* ── R2-04: ein geloeschter Laufzeitbereich ist keine Erstinitialisierung ─ */

test("R2-04 Positivkontrolle: ein intakter Neuerwerb behaelt Fence-Zaehler und Kostenbeleg", () => {
  const { store, verified } = aufgesetzt();
  reserviere(store, verified);
  casMutate(store, (d) => S.releaseLease(d, { holder: "runner-a", fence: 1, scope: SCOPE, now: T0 + 1000 }));
  const neu = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 + 2000 }));
  assert.equal(neu.result.fence, 2);
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.callsById["call-1"].maxMicros, 100);
  assert.equal(cost.byDay["2026-09-19"].openMicros, 100);
});

test("R2-04 ein geloeschter Laufzeitbereich wird nicht neu angelegt — 503, Kern unveraendert", () => {
  const { store, verified } = aufgesetzt();
  reserviere(store, verified);
  casMutate(store, (d) => S.releaseLease(d, { holder: "runner-a", fence: 1, scope: SCOPE, now: T0 + 1000 }));
  store.forceWrite((data) => { delete data.automation.runtime; return data; });
  const vorher = JSON.stringify(store.snapshot());
  const putsVorher = store.stats.puts;

  assert.throws(() => S.acquireLease(store.snapshot(), { holder: "runner-a", scope: SCOPE, now: T0 + 2000 }),
    (e) => e.code === "runtime_missing_after_init" && e.status === 503);
  assert.throws(() => S.readRuntime(store.snapshot()), (e) => e.code === "runtime_missing_after_init");
  assert.throws(() => S.costSnapshot(store.snapshot(), {}), (e) => e.status === 503);
  assert.equal(JSON.stringify(store.snapshot()), vorher, "der Kern ist unveraendert");
  assert.equal(store.stats.puts, putsVorher, "es wurde nichts geschrieben");
});

test("R2-04 auch ein Restore ohne Laufzeitbereich bleibt gesperrt", () => {
  // Ein alter Schnappschuss, der den Nachweis traegt, aber den Bereich
  // verloren hat — genau das, was ein unsauberes Restore hinterlaesst.
  const restauriert = {
    entities: {},
    automation: {
      schemaVersion: 3, dataRevision: 42, idempotencyByKey: {}, activeLease: null,
      runtimeInit: { schemaVersion: 1, initializedAtMs: T0 - 86_400_000, initializedBy: "runtime" },
    },
  };
  assert.throws(() => S.acquireLease(restauriert, { holder: "r", scope: SCOPE, now: T0 }),
    (e) => e.code === "runtime_missing_after_init" && e.status === 503);
  assert.equal(restauriert.automation.dataRevision, 42);
});

test("R2-04 eine erste Initialisierung bleibt kontrolliert moeglich", () => {
  const store = createCasStore(minimalCore());
  const erst = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  assert.equal(erst.result.ok, true);
  const nachweis = store.snapshot().automation.runtimeInit;
  assert.equal(nachweis.schemaVersion, 1);
  assert.equal(nachweis.initializedAtMs, T0);
  assert.equal(typeof nachweis.initializedBy, "string");

  // Der Nachweis wird bei spaeteren Mutationen nicht neu gesetzt.
  casMutate(store, (d) => S.releaseLease(d, { holder: "runner-a", fence: 1, scope: SCOPE, now: T0 + 5000 }));
  assert.equal(store.snapshot().automation.runtimeInit.initializedAtMs, T0);

  // Ein kaputter Nachweis sperrt ebenfalls.
  store.forceWrite((data) => { data.automation.runtimeInit = { schemaVersion: 99 }; return data; });
  assert.throws(() => S.readRuntime(store.snapshot()), (e) => e.code === "runtime_init_marker_invalid" && e.status === 503);
});
