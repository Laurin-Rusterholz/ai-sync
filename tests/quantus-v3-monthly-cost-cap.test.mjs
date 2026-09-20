/*
 * Betriebs-Kostenfreigabe: explizite globale $50/Kalendermonat-Grenze,
 * $30-Warnschwelle (Europe/Zurich), GETRENNT von jeder Cost-Policy-Grenze
 * und von Codex-Arbeitscredits. Prueft `monthly-cost-cap.mjs` direkt gegen
 * den ECHTEN CAS-Pruefstand (dieselbe Technik wie
 * tests/quantus-v3-runtime-cost.test.mjs) — keine Stub-Attrappe, kein
 * erfundener Zustand.
 *
 * Deckt genau die vom Nutzer verlangten Faelle ab: 29.99/30/49.99/50 USD
 * (Grenzwerte), parallele Reservierungen (Atomaritaet), unklarer Ausgang
 * zaehlt zum Worst-Case-Verbrauch, und ein Monatswechsel setzt weder etwas
 * zurueck noch verliert er offene Verpflichtungen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createCasStore, casMutate, casRace, baseCore } from "./quantus-v3-runtime-cas-harness.mjs";
import { MONTHLY_CAP_MICROS, MONTHLY_WARN_MICROS, monthToDateMicros, reserveCostWithMonthlyCap } from "../runtime/quantus-v3/src/monthly-cost-cap.mjs";

const SCOPE = "quantus:mainrun";
const T0 = Date.parse("2026-09-19T08:00:00.000Z"); // Europe/Zurich: 2026-09-19, Sommerzeit (+2h)
const RUNKEY = P.slotRunKey("quantus", "2026-09-19", "process09", "3.0");
const MODELL = "synthetic-model-a";
const ANBIETER = "synthetic-provider";
// `S.reserveCost` deckelt jede EINZELNE Reservierung auf MAX_TOKENS_PER_CALL
// Tokens — bei 1 Mikro/Token also hoechstens $10 pro Aufruf. Groessere
// Summen werden hier deshalb bewusst ueber MEHRERE Aufrufe aufgebaut, genau
// wie im echten Betrieb (viele kleine Tagesbriefing-Laeufe).
assert.equal(S.MAX_TOKENS_PER_CALL, 10_000_000, "Testannahme ueber die Einzelaufrufgrenze");

assert.equal(MONTHLY_CAP_MICROS, 50_000_000, "Testannahme: $50 Grenze");
assert.equal(MONTHLY_WARN_MICROS, 30_000_000, "Testannahme: $30 Warnschwelle");

/* SYNTHETISCHE Vorlage — 1 Mikro pro Eingabe-Token, damit Testbetraege exakt
 * konstruierbar sind. `fixture: true`, ausserhalb der Tests von
 * validateCostPolicy abgelehnt. */
function policy(over = {}) {
  return {
    schema: "quantus-v3-cost-policy/1",
    version: "synthetic-1",
    fixture: true,
    currency: "USD",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: T0 - 86_400_000 },
    effectiveFromMs: T0 - 3_600_000,
    effectiveUntilMs: T0 + 90 * 86_400_000,
    dayLimitMicros: 1_000_000_000,
    runLimitMicros: 1_000_000_000,
    callLimitMicros: 20_000_000,
    unresolvedBlockMicros: 1_000_000_000,
    featureFlags: { providers: "live" },
    models: {
      [`${ANBIETER}:${MODELL}`]: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0, maxCallMicros: 20_000_000 },
    },
    ...over,
  };
}

function laufBereit(now = T0) {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now })).result;
  const verified = { holder: "r", fence, scope: SCOPE };
  return { store, verified };
}

let hashSeq = 0;
function reservieren(store, verified, { callId, inputTokens, now = T0, cap = { capMicros: MONTHLY_CAP_MICROS }, pol = policy() }) {
  return casMutate(store, (d) => reserveCostWithMonthlyCap(d, {
    callId, runKey: RUNKEY, provider: ANBIETER, model: MODELL,
    contentHash: `hash${String(++hashSeq).padStart(16, "0")}`,
    inputTokens, outputTokens: 0, now, verifiedScope: verified, policy: pol, __allowFixturePolicy: true,
  }, cap));
}

// ── Grenzwerte: 29.99 / 30 / 49.99 / 50 USD (in Mikro-USD) ────────────────
test("Monatsgrenze: 29.99/30/49.99/50 USD werden erlaubt, jeder weitere Cent darueber wird abgelehnt", () => {
  const { store, verified } = laufBereit();
  const schritte = [
    { tokens: 10_000_000, erwartet: 10_000_000 },   // $10.00
    { tokens: 10_000_000, erwartet: 20_000_000 },   // $20.00
    { tokens: 9_990_000, erwartet: 29_990_000 },    // $29.99 — unter der Warnschwelle
    { tokens: 10_000, erwartet: 30_000_000 },       // $30.00 — GENAU die Warnschwelle, E1 blockiert hier NICHT
    { tokens: 10_000_000, erwartet: 40_000_000 },   // $40.00
    { tokens: 9_990_000, erwartet: 49_990_000 },    // $49.99 — knapp unter der Grenze
    { tokens: 10_000, erwartet: 50_000_000 },       // $50.00 — GENAU die Grenze, noch erlaubt
  ];
  for (const [i, s] of schritte.entries()) {
    const out = reservieren(store, verified, { callId: `call-${i}`, inputTokens: s.tokens });
    assert.equal(out.result.ok, true, `Schritt ${i} (Ziel ${s.erwartet}) haette erlaubt sein muessen: ${JSON.stringify(out.result)}`);
    const stand = monthToDateMicros(out.data, T0);
    assert.equal(stand.totalMicros, s.erwartet, `nach Schritt ${i} falsche Monatssumme`);
  }
  // JEDER weitere Cent — und sei es nur 1 Mikro-USD — ueber $50 wird abgelehnt.
  const ueber = reservieren(store, verified, { callId: "call-over", inputTokens: 1 });
  assert.equal(ueber.result.ok, false, "1 Mikro-USD ueber $50 haette abgelehnt werden muessen");
  assert.equal(ueber.result.code, "monthly_budget_exceeded", JSON.stringify(ueber.result));
  assert.equal(ueber.wrote, false, "eine abgelehnte Reservierung darf NICHTS schreiben");
  // Der Bestand bleibt bei exakt $50.00 — nicht $50.000001.
  const nachAblehnung = monthToDateMicros(store.snapshot(), T0);
  assert.equal(nachAblehnung.totalMicros, 50_000_000);
});

test("ohne konfigurierte Monatsgrenze bleibt reserveCostWithMonthlyCap IDENTISCH zu E1.reserveCost (additiv, keine Verhaltensaenderung)", () => {
  const { store, verified } = laufBereit();
  // Fuenf mal $10 = $50, dann NOCH EINMAL $10 (insgesamt $60) — OHNE
  // `monthlyCap` (null) muss das trotzdem erlaubt bleiben.
  for (let i = 0; i < 6; i++) {
    const out = reservieren(store, verified, { callId: `nocap-${i}`, inputTokens: 10_000_000, cap: null });
    assert.equal(out.result.ok, true, `Aufruf ${i} ohne monthlyCap haette erlaubt sein muessen: ${JSON.stringify(out.result)}`);
  }
  const stand = monthToDateMicros(store.snapshot(), T0);
  assert.equal(stand.totalMicros, 60_000_000, "ohne konfigurierte Grenze darf $50 ueberschritten werden — die neue Grenze ist rein additiv");
});

// ── Atomaritaet: zwei gleichzeitige Reservierungen ueberschreiten die Grenze gemeinsam nicht ──
test("konkurrierende Reservierungen ueberschreiten die Monatsgrenze gemeinsam NICHT (echter CAS-Konflikt + Wiederholung)", () => {
  const { store, verified } = laufBereit();
  // Vorbelegung: $49.99 bereits verbraucht (vier mal $10 + einmal $9.99).
  for (let i = 0; i < 4; i++) {
    const out = reservieren(store, verified, { callId: `vor-${i}`, inputTokens: 10_000_000 });
    assert.equal(out.result.ok, true, JSON.stringify(out.result));
  }
  const letzterVor = reservieren(store, verified, { callId: "vor-4", inputTokens: 9_990_000 });
  assert.equal(letzterVor.result.ok, true, JSON.stringify(letzterVor.result));
  assert.equal(monthToDateMicros(store.snapshot(), T0).totalMicros, 49_990_000);

  // A und B lesen BEIDE denselben (bereits $49.99-)Stand, JEDER fuer sich
  // unter der Grenze ($49.995 bzw. $49.998) — GEMEINSAM ($50.003) NICHT.
  const mutatorA = (d) => reserveCostWithMonthlyCap(d, {
    callId: "race-a", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: "hashRaceA00000000",
    inputTokens: 5_000, outputTokens: 0, now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true,
  }, { capMicros: MONTHLY_CAP_MICROS });
  const mutatorB = (d) => reserveCostWithMonthlyCap(d, {
    callId: "race-b", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: "hashRaceB00000000",
    inputTokens: 8_000, outputTokens: 0, now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true,
  }, { capMicros: MONTHLY_CAP_MICROS });

  const rennen = casRace(store, mutatorA, mutatorB);
  assert.equal(rennen.a.wrote, true, "A haette zuerst schreiben muessen: " + JSON.stringify(rennen.a));
  assert.equal(rennen.a.result.ok, true);
  assert.ok(rennen.retryB, "B haette einen CAS-Konflikt gehabt haben muessen (echte Wiederholung noetig)");
  assert.equal(rennen.retryB.result.ok, false, "B's Wiederholung MUSS die inzwischen von A geschriebene Summe sehen und ablehnen: " + JSON.stringify(rennen.retryB.result));
  assert.equal(rennen.retryB.result.code, "monthly_budget_exceeded");
  assert.equal(rennen.retryB.wrote, false);

  const endstand = monthToDateMicros(store.snapshot(), T0);
  assert.equal(endstand.totalMicros, 49_990_000 + 5_000, "nur A's Reservierung darf im Endstand stehen");
  assert.ok(endstand.totalMicros <= MONTHLY_CAP_MICROS, "die Grenze darf gemeinsam nie ueberschritten werden");
});

// ── Unklarer Ausgang zaehlt zum Worst-Case-Verbrauch ──────────────────────
// Ueber die ECHTEN E1-Uebergaenge aufgebaut (reserve -> claim -> settle/
// markUnknown/release) statt eines hand-erfundenen Ledger-Zustands — der
// Konsistenzpruefer (`validateCostArea`) verlangt exakt uebereinstimmende
// Vertraege/Indizes/Aggregate, die nur die echten Funktionen korrekt
// herstellen.
test("monthToDateMicros zaehlt reserved/unknown zum vollen Hoechstbetrag, settled zum tatsaechlichen Betrag, released gar nicht", () => {
  const { store, verified } = laufBereit();
  const einsPreis = policy({ models: { [`${ANBIETER}:${MODELL}`]: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0, maxCallMicros: 20_000_000 } } });

  // c1 bleibt "reserved" ($5).
  reservieren(store, verified, { callId: "c1", inputTokens: 5_000_000, cap: null, pol: einsPreis });
  // c2 wird beansprucht und dann als "unknown" verbucht ($7, worst case).
  reservieren(store, verified, { callId: "c2", inputTokens: 7_000_000, cap: null, pol: einsPreis });
  casMutate(store, (d) => S.claimCostDispatch(d, { callId: "c2", claimId: "c2:1", now: T0, verifiedScope: verified, policy: einsPreis, __allowFixturePolicy: true }));
  casMutate(store, (d) => S.markCostOutcomeUnknown(d, { callId: "c2", reason: "provider_timeout", now: T0, verifiedScope: verified }));
  // c3 wird beansprucht und settled ($3 reserviert, $2.25 tatsaechlich abgerechnet).
  reservieren(store, verified, { callId: "c3", inputTokens: 3_000_000, cap: null, pol: einsPreis });
  casMutate(store, (d) => S.claimCostDispatch(d, { callId: "c3", claimId: "c3:1", now: T0, verifiedScope: verified, policy: einsPreis, __allowFixturePolicy: true }));
  casMutate(store, (d) => S.settleCost(d, { callId: "c3", actualMicros: 2_250_000, usageReceiptId: "r-c3", providerRequestId: "pr-c3", now: T0, verifiedScope: verified }));
  // c4 wird reserviert, aber VOR dem Senden freigegeben ($4, zaehlt 0).
  reservieren(store, verified, { callId: "c4", inputTokens: 4_000_000, cap: null, pol: einsPreis });
  casMutate(store, (d) => S.releaseCostReservation(d, { callId: "c4", now: T0, verifiedScope: verified, evidence: { kind: "not_dispatched", ref: "test-c4" } }));

  const stand = monthToDateMicros(store.snapshot(), T0);
  // 5_000_000 (reserved) + 7_000_000 (unknown, worst case) + 2_250_000 (settled, tatsaechlich) + 0 (released)
  assert.equal(stand.totalMicros, 5_000_000 + 7_000_000 + 2_250_000, JSON.stringify(stand));
  assert.equal(stand.openMicros, 5_000_000 + 7_000_000);
  assert.equal(stand.settledMicros, 2_250_000);
});

// ── Monatswechsel: kein Rueckfall, keine Ruecksetzung offener Verpflichtungen ──
test("Monatswechsel: ein Kalendermonat startet bei $0, ein offener Anspruch aus dem Vormonat wird NICHT geloescht und zaehlt weiter dort", () => {
  const augustJetzt = Date.parse("2026-08-31T08:00:00.000Z");
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: augustJetzt })).result;
  const verifiedAugust = { holder: "r", fence, scope: SCOPE };
  // Ein echter, offener (weiterhin "reserved") August-Anspruch — kein
  // erfundener Zustand.
  const alt = casMutate(store, (d) => S.reserveCost(d, {
    callId: "alt", runKey: P.slotRunKey("quantus", "2026-08-31", "close23", "3.0"),
    provider: ANBIETER, model: MODELL, contentHash: "hashAugust00000000",
    inputTokens: 10_000_000, outputTokens: 0,
    now: augustJetzt, verifiedScope: verifiedAugust,
    policy: policy({ effectiveFromMs: augustJetzt - 3_600_000 }), __allowFixturePolicy: true,
  }));
  assert.equal(alt.result.ok, true, JSON.stringify(alt.result));

  const septemberJetzt = Date.parse("2026-09-01T08:00:00.000Z");
  const septemberStand = monthToDateMicros(store.snapshot(), septemberJetzt);
  assert.equal(septemberStand.month, "2026-09");
  assert.equal(septemberStand.totalMicros, 0, "der neue Kalendermonat darf NICHT mit dem offenen August-Anspruch beginnen");

  const augustStand = monthToDateMicros(store.snapshot(), augustJetzt);
  assert.equal(augustStand.month, "2026-08");
  assert.equal(augustStand.totalMicros, 10_000_000, "der offene August-Anspruch ist dort weiterhin sichtbar — nicht geloescht, nicht zurueckgesetzt");

  // Eine neue September-Reservierung wird NUR gegen den September-Stand
  // geprueft — der offene August-Anspruch blockiert den neuen Monat nicht
  // faelschlich, UND er wird durch die neue Reservierung nicht geloescht.
  const { fence: fence2 } = casMutate(store, (d) => S.acquireLease(d, { holder: "r2", scope: SCOPE, now: septemberJetzt })).result;
  const verifiedSept = { holder: "r2", fence: fence2, scope: SCOPE };
  const neu = casMutate(store, (d) => reserveCostWithMonthlyCap(d, {
    callId: "sept-1", runKey: P.slotRunKey("quantus", "2026-09-01", "briefing04", "3.0"),
    provider: ANBIETER, model: MODELL, contentHash: "hashSept000000000",
    inputTokens: 9_990_000, outputTokens: 0,
    now: septemberJetzt, verifiedScope: verifiedSept,
    policy: policy({ effectiveFromMs: septemberJetzt - 3_600_000 }), __allowFixturePolicy: true,
  }, { capMicros: MONTHLY_CAP_MICROS }));
  assert.equal(neu.result.ok, true, "die neue September-Reservierung darf vom offenen August-Anspruch nicht blockiert werden: " + JSON.stringify(neu.result));
  const nachNeu = store.snapshot();
  assert.ok(nachNeu.automation.runtime.cost.callsById.alt, "der offene August-Anspruch darf durch die September-Reservierung nicht geloescht werden");
  assert.equal(nachNeu.automation.runtime.cost.callsById.alt.state, "reserved", "der August-Anspruch bleibt offen/unveraendert");
});

// ── Eine wiedergegebene (bereits genehmigte) Reservierung wird NICHT
// nachtraeglich abgelehnt, nur weil ANDERE Aufrufe inzwischen die
// Monatsgrenze erreicht haben — sie fuegt nichts Neues hinzu. ────────────
test("eine idempotent wiedergegebene Reservierung wird nicht nachtraeglich durch die Monatsgrenze abgelehnt", () => {
  const { store, verified } = laufBereit();
  // c0 wird zuerst legitim reserviert (weit unter der Grenze). EXAKT
  // derselbe Vertrag (gleicher contentHash) macht einen spaeteren
  // Zustellversuch zu einer echten Wiederholung, kein `cost_call_conflict`.
  const c0Mutator = (d) => reserveCostWithMonthlyCap(d, {
    callId: "c0", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: "hashWiederholung00",
    inputTokens: 1_000_000, outputTokens: 0, now: T0, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true,
  }, { capMicros: MONTHLY_CAP_MICROS });
  const erste = casMutate(store, c0Mutator);
  assert.equal(erste.result.ok, true, JSON.stringify(erste.result));
  // Danach fuellen ANDERE Aufrufe den Monat bis exakt an die Grenze.
  for (let i = 0; i < 4; i++) {
    const out = reservieren(store, verified, { callId: `fill-${i}`, inputTokens: 9_997_500 });
    assert.equal(out.result.ok, true, JSON.stringify(out.result));
  }
  assert.equal(monthToDateMicros(store.snapshot(), T0).totalMicros, 1_000_000 + 4 * 9_997_500);
  // Eine WIEDERHOLUNG der ERSTEN, laengst genehmigten Reservierung (z. B.
  // ein erneuter Zustellversuch desselben Kommandos) darf nicht ploetzlich
  // an der inzwischen erreichten Monatsgrenze scheitern.
  const wiederholung = casMutate(store, c0Mutator);
  assert.equal(wiederholung.result.ok, true, "eine idempotente Wiederholung darf nie an der Monatsgrenze scheitern: " + JSON.stringify(wiederholung.result));
  assert.equal(wiederholung.wrote, false, "eine Wiederholung schreibt nichts Neues");
});
