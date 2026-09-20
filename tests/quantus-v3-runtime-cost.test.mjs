/* ══ Paket E1-B: Kostenbelege im zentralen automation-Kern ════════════════
 *
 * Produktionsbefund: es gab bisher gar keinen Kostenbeleg. Ein Lauf haette
 * ein Modell aufrufen koennen, ohne dass irgendwo stuende, was er dafuer
 * ausgeben darf, was er ausgegeben hat und was aus einem Aufruf wurde,
 * dessen Antwort nie ankam. Genau daraus entstehen die drei teuren Fehler:
 * doppelte Belastung, doppelte Erstattung und blinde Wiederholung eines
 * Aufrufs, der vielleicht schon gelaufen ist.
 *
 * ACHTUNG: Alle Preise, Modellnamen und Freigaben in dieser Datei sind
 * SYNTHETISCH. Die Vorlage traegt `fixture: true` und wird ausserhalb der
 * Tests von validateCostPolicy abgelehnt. Das Modul selbst enthaelt keinen
 * einzigen Modellnamen und keinen einzigen Preis.
 *
 * Belegt: T25 (atomare Parallelreservierungen halten das Limit ein),
 * Teile von T24 (Budgeterschoepfung ohne falsches Gruen) und die
 * Beleg-Deduplizierung aus T26/T05 auf Kostenseite.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createCasStore, casMutate, casRace, baseCore } from "./quantus-v3-runtime-cas-harness.mjs";

const SCOPE = "quantus:mainrun";
const T0 = Date.parse("2026-09-19T08:00:00.000Z");
const RUNKEY = P.slotRunKey("quantus", "2026-09-19", "process09", "3.0");
const RUNKEY2 = P.slotRunKey("quantus", "2026-09-19", "continue14", "3.0");
const MODELL = "synthetic-model-a";
const ANBIETER = "synthetic-provider";
const HASH_A = "hashAAAAAAAAAAAAAAAA";
const HASH_B = "hashBBBBBBBBBBBBBBBB";

/* SYNTHETISCHE Vorlage — keine echten Preise, keine echte Freigabe. */
function policy(over = {}) {
  return {
    schema: "quantus-v3-cost-policy/1",
    version: "synthetic-1",
    fixture: true,
    currency: "CHF",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: T0 - 86_400_000 },
    effectiveFromMs: T0 - 3_600_000,
    effectiveUntilMs: T0 + 30 * 86_400_000,
    dayLimitMicros: 1000,
    runLimitMicros: 300,
    callLimitMicros: 250,
    unresolvedBlockMicros: 150,
    featureFlags: { providers: "live" },
    models: {
      [`${ANBIETER}:${MODELL}`]: {
        inputMicrosPerMillionTokens: 1000,
        outputMicrosPerMillionTokens: 2000,
        maxCallMicros: 250,
      },
    },
    ...over,
  };
}
const TOKENS = { inputTokens: 100_000, outputTokens: 50_000 }; // = 100 + 100 = 200 Mikro
const OPT = { allowFixture: true };

function laufBereit(now = T0) {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now })).result;
  const verified = { holder: "r", fence, scope: SCOPE };
  return { store, verified };
}

function reservieren(store, verified, over = {}) {
  return casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-1", runKey: RUNKEY, provider: ANBIETER, model: MODELL,
    contentHash: HASH_A, now: T0, verifiedScope: verified, policy: policy(),
    __allowFixturePolicy: true, ...TOKENS, ...over,
  }));
}

/* ── Policy ────────────────────────────────────────────────────────────── */

test("eine synthetische Testvorlage ist ausserhalb der Tests unbrauchbar", () => {
  assert.equal(S.validateCostPolicy(policy(), { now: T0 }).ok, false);
  assert.deepEqual(S.validateCostPolicy(policy(), { now: T0 }).errors, ["cost_policy_fixture_rejected"]);
  assert.equal(S.validateCostPolicy(policy(), { now: T0, allowFixture: true }).ok, true);
});

test("fehlende, nicht freigegebene oder abgelaufene Konfiguration sperrt bezahlte Aufrufe", () => {
  const faelle = [
    [undefined, "cost_policy_missing"],
    [policy({ schema: "etwas-anderes" }), "cost_policy_schema"],
    [policy({ approval: null }), "cost_policy_not_approved"],
    [policy({ approval: { approvedBy: "", approvalRef: "x", approvedAtMs: 1 } }), "cost_policy_not_approved"],
    [policy({ effectiveUntilMs: T0 - 1000 }), "cost_policy_expired"],
    [policy({ effectiveFromMs: T0 + 1000, effectiveUntilMs: T0 + 2000 }), "cost_policy_not_yet_effective"],
    [policy({ models: {} }), "cost_policy_models"],
    [policy({ runLimitMicros: 5000 }), "cost_policy_run_above_day"],
    [policy({ callLimitMicros: 900 }), "cost_policy_call_above_run"],
    [policy({ dayLimitMicros: 1.5 }), "cost_policy_dayLimitMicros"],
    [policy({ currency: "chf" }), "cost_policy_currency"],
    [policy({ unresolvedBlockMicros: -1 }), "cost_policy_unresolved_block"],
  ];
  for (const [p, code] of faelle) {
    const v = S.validateCostPolicy(p, { now: T0, allowFixture: true });
    assert.equal(v.ok, false, code);
    assert.ok(v.errors.includes(code), `${code} fehlt in ${JSON.stringify(v.errors)}`);
    assert.throws(() => S.assertPaidCallAllowed(p, { now: T0, allowFixture: true }), (e) => e.status === 503 || e.code === "providers_not_live");
  }
});

test("Featureflags stehen ohne ausdrueckliche Angabe auf dry_run", () => {
  for (const p of [policy({ featureFlags: undefined }), policy({ featureFlags: {} })]) {
    const v = S.validateCostPolicy(p, { now: T0, allowFixture: true });
    assert.equal(v.ok, true);
    assert.equal(v.providers, "dry_run");
    assert.equal(v.flagsDefaulted, true);
    assert.throws(() => S.assertPaidCallAllowed(p, { now: T0, allowFixture: true }), (e) => e.code === "providers_not_live");
  }
  assert.equal(S.assertPaidCallAllowed(policy(), { now: T0, allowFixture: true }).providers, "live");
});

test("Mikrobetraege sind ganzzahlig, gedeckelt und ueberlaufsicher", () => {
  const p = policy();
  assert.equal(S.estimateCostMicros(p, { provider: ANBIETER, model: MODELL, ...TOKENS, __allowFixturePolicy: true }), 200);
  // Aufrundung statt Gleitkommarest: 1 Token kostet einen ganzen Mikro.
  assert.equal(S.estimateCostMicros(p, { provider: ANBIETER, model: MODELL, inputTokens: 1, outputTokens: 0, __allowFixturePolicy: true }), 1);
  assert.throws(() => S.estimateCostMicros(p, { provider: ANBIETER, model: "gibt-es-nicht", ...TOKENS, __allowFixturePolicy: true }), /model_not_priced/);
  assert.throws(() => S.estimateCostMicros(p, { provider: ANBIETER, model: MODELL, inputTokens: 1e9, __allowFixturePolicy: true }), /invalid_integer/);
  assert.throws(() => S.estimateCostMicros(p, { provider: ANBIETER, model: MODELL, inputTokens: 1.5, __allowFixturePolicy: true }), /invalid_integer/);
  assert.throws(() => S.estimateCostMicros(p, { provider: ANBIETER, model: MODELL, inputTokens: 300_000, __allowFixturePolicy: true }),
    /call_price_above_model_cap/, "300 Mikro liegen ueber der Modellgrenze von 250");
  const gross = policy({ models: { [`${ANBIETER}:${MODELL}`]: { inputMicrosPerMillionTokens: S.MAX_MICROS_PER_MILLION_TOKENS, outputMicrosPerMillionTokens: 0, maxCallMicros: S.MAX_MICROS } }, callLimitMicros: S.MAX_MICROS, runLimitMicros: S.MAX_MICROS, dayLimitMicros: S.MAX_MICROS });
  assert.equal(Number.isSafeInteger(S.estimateCostMicros(gross, { provider: ANBIETER, model: MODELL, inputTokens: S.MAX_TOKENS_PER_CALL, __allowFixturePolicy: true })), true);
});

/* ── Reservierung ──────────────────────────────────────────────────────── */

test("eine Reservierung steht VOR dem Aufruf und wird im zentralen Kern verbucht", () => {
  const { store, verified } = laufBereit();
  const r = reservieren(store, verified);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.maxMicros, 200);
  // Die Reservierung allein sendet NICHT. Dafuer gibt es claimCostDispatch.
  assert.equal(r.result.dispatchAllowed, false);
  assert.equal(r.result.dispatchClaimed, false);
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.callsById["call-1"].state, "reserved");
  assert.equal(cost.byDay["2026-09-19"].openMicros, 200);
  assert.equal(cost.byRun[RUNKEY].openMicros, 200);
  assert.equal(cost.policyRef.approvalRef, "SYNTHETIC-NOT-A-REAL-APPROVAL");
});

test("im dry_run wird nichts bezahlt aufgerufen und nichts belastet", () => {
  const { store, verified } = laufBereit();
  const r = reservieren(store, verified, { policy: policy({ featureFlags: { providers: "dry_run" } }) });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.mode, "dry_run");
  assert.equal(r.result.chargeable, false);
  assert.equal(r.result.maxMicros, 0);
  assert.equal(r.result.estimatedMicros, 200, "der Preis wird trotzdem gerechnet und geprueft");
  assert.equal(r.result.dispatchAllowed, false);
  // Der Claim verlangt eine frische, freigegebene Policy mit providers=live.
  assert.throws(() => S.claimCostDispatch(store.snapshot(), {
    callId: "call-1", claimId: "dispatch-1", now: T0 + 500, verifiedScope: verified,
    policy: policy({ featureFlags: { providers: "dry_run" } }), __allowFixturePolicy: true,
  }), (e) => e.code === "providers_not_live");
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].openMicros, 0);
});

test("ohne fuehrenden Besitz gibt es keine Reservierung", () => {
  const { store, verified } = laufBereit();
  const abgelaufen = T0 + S.LEASE_TTL_MS + 1;
  assert.throws(() => S.reserveCost(store.snapshot(), {
    callId: "call-x", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
    now: abgelaufen, verifiedScope: verified, policy: policy({ effectiveUntilMs: abgelaufen + 1000 }),
    __allowFixturePolicy: true, ...TOKENS,
  }), (e) => e.code === "lease_expired");
});

test("dieselbe Call-Id mit demselben Inhalt ist eine Wiederholung, mit anderem Inhalt ein Konflikt", () => {
  const { store, verified } = laufBereit();
  reservieren(store, verified);
  const puts = store.stats.puts;
  const gleich = reservieren(store, verified);
  assert.equal(gleich.result.duplicate, true);
  assert.equal(gleich.wrote, false);
  assert.equal(store.stats.puts, puts, "keine zweite Belastung");
  const anders = reservieren(store, verified, { contentHash: HASH_B });
  assert.equal(anders.result.ok, false);
  assert.equal(anders.result.code, "cost_call_conflict");
  assert.equal(anders.wrote, false);
});

test("T25 zwei Reservierungen auf DEMSELBEN Schnappschuss ueberschreiten das Laufbudget nicht", () => {
  const { store, verified } = laufBereit();
  // runLimit 300, jede Reservierung 200 — zwei passen nicht.
  const rennen = casRace(
    store,
    (d) => S.reserveCost(d, { callId: "c-a", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A, now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS }),
    (d) => S.reserveCost(d, { callId: "c-b", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_B, now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS }),
  );
  assert.equal(rennen.a.result.ok, true);
  assert.equal(rennen.b.result.ok, true, "auf dem alten Schnappschuss sah B noch Platz");
  assert.equal(rennen.b.conflict, true, "der CAS hat den zweiten Schreibvorgang abgewiesen");
  assert.equal(rennen.retryB.result.ok, false);
  assert.equal(rennen.retryB.result.code, "run_budget_exceeded");
  assert.equal(rennen.retryB.result.detail.wouldBe, 400);
  assert.equal(store.snapshot().automation.runtime.cost.byRun[RUNKEY].openMicros, 200);
});

test("T25 das Tagesbudget gilt ueber Laeufe hinweg", () => {
  const { store, verified } = laufBereit();
  const klein = policy({ dayLimitMicros: 300, runLimitMicros: 300 });
  casMutate(store, (d) => S.reserveCost(d, { callId: "c1", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A, now: T0, verifiedScope: verified, policy: klein, __allowFixturePolicy: true, ...TOKENS }));
  const zweit = casMutate(store, (d) => S.reserveCost(d, { callId: "c2", runKey: RUNKEY2, provider: ANBIETER, model: MODELL, contentHash: HASH_B, now: T0, verifiedScope: verified, policy: klein, __allowFixturePolicy: true, ...TOKENS }));
  assert.equal(zweit.result.code, "day_budget_exceeded");
  assert.equal(zweit.wrote, false);
});

/* ── Verbrauch, Freigabe, Belege ───────────────────────────────────────── */

test("bestaetigter Verbrauch gibt den ungenutzten Rest frei und wird dedupliziert", () => {
  const { store, verified } = laufBereit();
  reservieren(store, verified);
  const s = casMutate(store, (d) => S.settleCost(d, {
    callId: "call-1", actualMicros: 120, usageReceiptId: "receipt-1", providerRequestId: "req-1",
    now: T0 + 1000, verifiedScope: verified,
  }));
  assert.equal(s.result.settledMicros, 120);
  assert.equal(s.result.releasedMicros, 80);
  assert.deepEqual(s.result.violations, []);
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.byDay["2026-09-19"].openMicros, 0);
  assert.equal(cost.byDay["2026-09-19"].settledMicros, 120);
  assert.equal(cost.byDay["2026-09-19"].releasedMicros, 80);

  // Genau derselbe Beleg noch einmal: Wiederholung, keine zweite Belastung.
  const puts = store.stats.puts;
  const nochmal = casMutate(store, (d) => S.settleCost(d, {
    callId: "call-1", actualMicros: 120, usageReceiptId: "receipt-1", providerRequestId: "req-1",
    now: T0 + 2000, verifiedScope: verified,
  }));
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(store.stats.puts, puts);
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].settledMicros, 120);
});

test("eine fremde Belegkennung kann nicht auf einen anderen Aufruf gebucht werden", () => {
  const { store, verified } = laufBereit();
  reservieren(store, verified);
  casMutate(store, (d) => S.reserveCost(d, { callId: "call-2", runKey: RUNKEY2, provider: ANBIETER, model: MODELL, contentHash: HASH_B, now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS }));
  casMutate(store, (d) => S.settleCost(d, { callId: "call-1", actualMicros: 100, usageReceiptId: "receipt-1", providerRequestId: "req-1", now: T0 + 1000, verifiedScope: verified }));
  const doppelt = casMutate(store, (d) => S.settleCost(d, { callId: "call-2", actualMicros: 100, usageReceiptId: "receipt-1", now: T0 + 2000, verifiedScope: verified }));
  assert.equal(doppelt.result.code, "usage_receipt_conflict");
  assert.equal(doppelt.result.detail.ownedBy, "call-1");
  const req = casMutate(store, (d) => S.settleCost(d, { callId: "call-2", actualMicros: 100, providerRequestId: "req-1", now: T0 + 2000, verifiedScope: verified }));
  assert.equal(req.result.code, "provider_request_conflict");
});

test("eine Ueberschreitung der Reservierung wird sichtbar und sperrt weitere Reservierungen", () => {
  const { store, verified } = laufBereit();
  reservieren(store, verified);
  const s = casMutate(store, (d) => S.settleCost(d, { callId: "call-1", actualMicros: 260, usageReceiptId: "receipt-9", now: T0 + 1000, verifiedScope: verified }));
  assert.equal(s.result.ok, true, "die Belastung ist geschehen und wird verbucht");
  assert.equal(s.result.overrunMicros, 60);
  assert.deepEqual(s.result.violations, ["settled_overrun"]);
  const weiter = casMutate(store, (d) => S.reserveCost(d, { callId: "call-3", runKey: RUNKEY2, provider: ANBIETER, model: MODELL, contentHash: HASH_B, now: T0 + 2000, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS }));
  assert.equal(weiter.result.code, "cost_overrun_blocks_reservation");
  assert.equal(S.costSnapshot(store.snapshot(), {}).overrunMicros, 60);
});

test("die Freigabe einer ungenutzten Reservierung braucht einen Beleg", () => {
  const { store, verified } = laufBereit();
  reservieren(store, verified);
  assert.throws(() => S.releaseCostReservation(store.snapshot(), { callId: "call-1", now: T0 + 1000, verifiedScope: verified }), /release_evidence_required/);
  assert.throws(() => S.releaseCostReservation(store.snapshot(), { callId: "call-1", now: T0 + 1000, verifiedScope: verified, evidence: { kind: "weil-ich-es-sage", ref: "x" } }), /release_evidence_required/);
  const f = casMutate(store, (d) => S.releaseCostReservation(d, { callId: "call-1", now: T0 + 1000, verifiedScope: verified, evidence: { kind: "provider_rejected", ref: "err-400" } }));
  assert.equal(f.result.releasedMicros, 200);
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].openMicros, 0);
  // Zweite Freigabe mit demselben Beleg: Wiederholung, keine doppelte Erstattung.
  const puts = store.stats.puts;
  const nochmal = casMutate(store, (d) => S.releaseCostReservation(d, { callId: "call-1", now: T0 + 2000, verifiedScope: verified, evidence: { kind: "provider_rejected", ref: "err-400" } }));
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(store.stats.puts, puts);
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].releasedMicros, 200);
});

/* ── Unklarer Ausgang ──────────────────────────────────────────────────── */

function mitUnklaremAusgang() {
  const { store, verified } = laufBereit();
  reservieren(store, verified);
  const u = casMutate(store, (d) => S.markCostOutcomeUnknown(d, {
    callId: "call-1", reason: "socket_hang_up", providerRequestId: "req-unklar", now: T0 + 1000, verifiedScope: verified,
  }));
  return { store, verified, u };
}

test("ein unklarer Provider-Ausgang bleibt reserviert und blockiert die blinde Wiederholung", () => {
  const { store, verified, u } = mitUnklaremAusgang();
  assert.equal(u.result.blocksRetry, true);
  assert.equal(u.result.retryAllowed, false);
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.callsById["call-1"].state, "unknown");
  assert.equal(cost.byDay["2026-09-19"].openMicros, 200, "der Betrag bleibt gebunden");
  assert.equal(cost.unresolved.micros, 200);
  assert.equal(S.isBlindRetryBlocked(store.snapshot(), HASH_A), true);
  assert.equal(S.isBlindRetryBlocked(store.snapshot(), HASH_B), false);

  // Derselbe Inhalt darf nicht einfach neu bezahlt werden.
  const wieder = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-neu", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
    now: T0 + 2000, verifiedScope: verified, policy: policy({ unresolvedBlockMicros: 100000 }), __allowFixturePolicy: true, ...TOKENS,
  }));
  assert.equal(wieder.result.code, "unknown_outcome_blocks_retry");
  assert.equal(wieder.result.detail.blockingCallId, "call-1");
});

test("ein ungeklaerter Aufruf kann weder abgerechnet noch einfach freigegeben werden", () => {
  const { store, verified } = mitUnklaremAusgang();
  const s = casMutate(store, (d) => S.settleCost(d, { callId: "call-1", actualMicros: 100, now: T0 + 3000, verifiedScope: verified }));
  assert.equal(s.result.code, "unknown_requires_resolution");
  const f = casMutate(store, (d) => S.releaseCostReservation(d, { callId: "call-1", now: T0 + 3000, verifiedScope: verified, evidence: { kind: "not_dispatched", ref: "x" } }));
  assert.equal(f.result.code, "unknown_requires_resolution");
  assert.equal(store.snapshot().automation.runtime.cost.unresolved.micros, 200);
});

test("ein Tageswechsel gibt einen alten unklaren Aufruf nicht frei", () => {
  const { store, verified } = mitUnklaremAusgang();
  const naechsterTag = P.wallTimeToMs("2026-09-20", 9, 0);
  const runKeyMorgen = P.slotRunKey("quantus", "2026-09-20", "process09", "3.0");
  // Bewusst grosszuegige Ungeklaert-Schwelle, damit dieser Test WIRKLICH den
  // Tageswechsel prueft und nicht nur die Ungeklaert-Sperre aus dem Test davor.
  const pMorgen = policy({ effectiveUntilMs: naechsterTag + 86_400_000, unresolvedBlockMicros: 500 });

  // Der neue Tag hat ein frisches Budget — der alte Aufruf bleibt trotzdem gebunden.
  casMutate(store, (d) => S.renewLease(d, { holder: "r", fence: verified.fence, scope: SCOPE, now: T0 + 60_000 }));
  const neuerBesitz = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: naechsterTag })).result;
  const v2 = { holder: "r", fence: neuerBesitz.fence, scope: SCOPE };
  const neu = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-morgen", runKey: runKeyMorgen, provider: ANBIETER, model: MODELL, contentHash: HASH_B,
    now: naechsterTag, verifiedScope: v2, policy: pMorgen, __allowFixturePolicy: true, ...TOKENS,
  }));
  assert.equal(neu.result.ok, true, "der neue Tag hat sein eigenes Budget");
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.callsById["call-1"].state, "unknown", "der alte Aufruf ist weiter ungeklaert");
  assert.equal(cost.byDay["2026-09-19"].openMicros, 200);
  assert.equal(cost.unresolved.micros, 200);
  assert.equal(S.isBlindRetryBlocked(store.snapshot(), HASH_A), true);

  const versuch = casMutate(store, (d) => S.releaseCostReservation(d, {
    callId: "call-1", now: naechsterTag + 1000, verifiedScope: v2, evidence: { kind: "not_dispatched", ref: "tageswechsel" },
  }));
  assert.equal(versuch.result.code, "unknown_requires_resolution");
});

test("zu viel Ungeklaertes sperrt jede weitere Reservierung", () => {
  const { store, verified } = mitUnklaremAusgang(); // 200 Mikro ungeklaert, Grenze 150
  const weiter = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-9", runKey: RUNKEY2, provider: ANBIETER, model: MODELL, contentHash: HASH_B,
    now: T0 + 2000, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS,
  }));
  assert.equal(weiter.result.code, "unresolved_cost_blocking");
  assert.equal(weiter.result.detail.unresolvedMicros, 200);
});

test("ein ungeklaerter Aufruf wird nur mit Beleg aufgeloest — und dann genau einmal", () => {
  const { store, verified } = mitUnklaremAusgang();
  assert.throws(() => S.resolveUnknownCost(store.snapshot(), { callId: "call-1", resolution: "charged", actualMicros: 180, now: T0 + 3000, verifiedScope: verified }), /resolution_evidence_required/);
  assert.throws(() => S.resolveUnknownCost(store.snapshot(), { callId: "call-1", resolution: "vielleicht", now: T0 + 3000, verifiedScope: verified, evidence: { kind: "x", ref: "y" } }), /unknown_resolution/);
  const ohneReq = casMutate(store, (d) => S.resolveUnknownCost(d, {
    callId: "call-1", resolution: "not_charged", now: T0 + 3000, verifiedScope: verified, evidence: { kind: "provider_usage_report", ref: "report-1" },
  }));
  assert.equal(ohneReq.result.code, "resolution_requires_provider_request");

  const geklaert = casMutate(store, (d) => S.resolveUnknownCost(d, {
    callId: "call-1", resolution: "charged", actualMicros: 180, usageReceiptId: "receipt-spaet",
    now: T0 + 4000, verifiedScope: verified, evidence: { kind: "provider_usage_report", ref: "report-1" },
  }));
  assert.equal(geklaert.result.state, "settled");
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.unresolved.micros, 0);
  assert.equal(cost.unresolved.count, 0);
  assert.equal(cost.byDay["2026-09-19"].settledMicros, 180);
  assert.equal(cost.byDay["2026-09-19"].releasedMicros, 20);
  assert.equal(cost.byDay["2026-09-19"].openMicros, 0);
  assert.equal(cost.byDay["2026-09-19"].unknownMicros, 0);

  // Zweite Aufloesung: keine doppelte Belastung, keine doppelte Erstattung.
  const puts = store.stats.puts;
  const nochmal = casMutate(store, (d) => S.resolveUnknownCost(d, {
    callId: "call-1", resolution: "charged", actualMicros: 180, now: T0 + 5000, verifiedScope: verified, evidence: { kind: "provider_usage_report", ref: "report-1" },
  }));
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(store.stats.puts, puts);
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].settledMicros, 180);
});

test("zwei gleichzeitige Aufloesungen desselben ungeklaerten Aufrufs erstatten nur einmal", () => {
  const { store, verified } = mitUnklaremAusgang();
  const aufloesen = (d) => S.resolveUnknownCost(d, {
    callId: "call-1", resolution: "not_charged", providerRequestId: "req-unklar",
    now: T0 + 4000, verifiedScope: verified, evidence: { kind: "provider_usage_report", ref: "report-1" },
  });
  const rennen = casRace(store, aufloesen, aufloesen);
  assert.equal(rennen.a.result.resolved, true);
  assert.equal(rennen.b.conflict, true);
  assert.equal(rennen.retryB.result.duplicate, true);
  assert.equal(rennen.retryB.wrote, false);
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.byDay["2026-09-19"].releasedMicros, 200, "genau eine Erstattung");
  assert.equal(cost.unresolved.count, 0);
});

test("alle Fehlerzustaende bleiben sichtbar und der Ledger liegt nur im zentralen Kern", () => {
  const vorher = baseCore();
  const store = createCasStore(vorher);
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const verified = { holder: "r", fence, scope: SCOPE };
  reservieren(store, verified);
  casMutate(store, (d) => S.markCostOutcomeUnknown(d, { callId: "call-1", reason: "timeout", now: T0 + 1000, verifiedScope: verified }));
  const nachher = store.snapshot();
  assert.deepEqual(Object.keys(nachher).sort(), Object.keys(vorher).sort());
  assert.deepEqual(
    Object.keys(nachher.automation).filter((k) => !Object.hasOwn(vorher.automation, k)).sort(),
    ["runtime", "runtimeInit"],
  );
  const snap = S.costSnapshot(nachher, { localDate: "2026-09-19", runKey: RUNKEY });
  assert.equal(snap.day.openMicros, 200);
  assert.equal(snap.run.openMicros, 200);
  assert.deepEqual(snap.unresolved.callIds, ["call-1"]);
  assert.equal(snap.calls, 1);
});

test("unbekannte Aufrufkennungen und kaputte Eingaben werden abgewiesen", () => {
  const { store, verified } = laufBereit();
  const data = store.snapshot();
  assert.equal(S.settleCost(data, { callId: "gibt-es-nicht", actualMicros: 1, now: T0, verifiedScope: verified }).result.code, "cost_call_unknown");
  assert.throws(() => S.reserveCost(data, { callId: "c", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: "kurz", now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS }), /invalid_identifier/);
  assert.throws(() => S.settleCost(data, { callId: "c", actualMicros: -1, now: T0, verifiedScope: verified }), /invalid_integer/);
  assert.throws(() => S.settleCost(data, { callId: "c", actualMicros: 1.5, now: T0, verifiedScope: verified }), /invalid_integer/);
  assert.throws(() => S.reserveCost(data, { callId: "c", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A, localDate: "2026-09-20", now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS }), /billing_date_mismatch/);
});
