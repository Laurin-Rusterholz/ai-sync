/* ══ E1 — die neun Gegenbeispiele aus der unabhaengigen Pruefung ══════════
 *
 * Jeder Fall hier ist genau der Ablauf, mit dem die Pruefung Commit 022e844
 * gekippt hat. Sie stehen als eigene Datei, damit keiner davon still
 * zurueckfaellt. Alle benutzen echte Funktionen, echte CAS-Schnappschuesse
 * und die in der Pruefung genannte Vorlage:
 *
 *   entities {}, automation { schemaVersion 3, dataRevision 0,
 *                             idempotencyByKey {}, activeLease null }
 *   synthetische Policy (fixture: true), 200-Mikro-Aufrufe aus
 *   100'000 Eingabe- und 50'000 Ausgabetoken bei 1000/2000 je Million,
 *   Tag 300 / Lauf 300 / Aufruf 250.
 *
 * Keine echten Preise, keine echte Freigabe, keine Produktionsdaten.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createCasStore, casMutate } from "./quantus-v3-runtime-cas-harness.mjs";

const SCOPE = "quantus:mainrun";
const T0 = P.wallTimeToMs("2026-09-19", 9, 0);
const HEUTE = "2026-09-19";
const RUNKEY = P.slotRunKey("quantus", HEUTE, "process09", "3.0");
const RUNKEY2 = P.slotRunKey("quantus", HEUTE, "continue14", "3.0");
const ANBIETER = "synthetic-provider";
const MODELL = "synthetic-model-a";
const MODELL_B = "synthetic-model-b";
const HASH_A = "hashAAAAAAAAAAAAAAAA";
const HASH_B = "hashBBBBBBBBBBBBBBBB";
const TOKENS = { inputTokens: 100_000, outputTokens: 50_000 };   // = 200 Mikro

/* Genau die Vorlage aus der Pruefung. */
function minimalCore() {
  return {
    entities: {},
    automation: { schemaVersion: 3, dataRevision: 0, idempotencyByKey: {}, activeLease: null },
  };
}

function policy(over = {}) {
  const preis = { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 };
  return {
    schema: "quantus-v3-cost-policy/1",
    version: "synthetic-1",
    fixture: true,
    currency: "CHF",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: T0 - 86_400_000 },
    effectiveFromMs: T0 - 86_400_000,
    effectiveUntilMs: T0 + 30 * 86_400_000,
    dayLimitMicros: 300,
    runLimitMicros: 300,
    callLimitMicros: 250,
    unresolvedBlockMicros: 1000,
    featureFlags: { providers: "live" },
    models: { [`${ANBIETER}:${MODELL}`]: preis, [`${ANBIETER}:${MODELL_B}`]: preis },
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
    __allowFixturePolicy: true, ...TOKENS, ...over,
  }));
}

/* ── 1: geloeschter Tagesbeleg ─────────────────────────────────────────── */

test("G1 ein geloeschter Tagesbeleg laesst frueheren Verbrauch nicht vergessen", () => {
  const { store, verified } = aufgesetzt();
  assert.equal(reserviere(store, verified).result.ok, true);
  assert.equal(store.snapshot().automation.runtime.cost.byDay[HEUTE].openMicros, 200);

  // Der Angriff aus der Pruefung: der Tagesbeleg verschwindet.
  store.forceWrite((data) => { delete data.automation.runtime.cost.byDay[HEUTE]; return data; });

  // Frueher wurde das als 0 gelesen und eine zweite Reservierung erlaubt.
  assert.throws(() => S.reserveCost(store.snapshot(), {
    callId: "call-2", runKey: RUNKEY2, provider: ANBIETER, model: MODELL, contentHash: HASH_B,
    now: T0 + 1000, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS,
  }), (e) => e.code === "cost_ledger_inconsistent" && e.status === 503 && e.detail.reason === "day_bucket_missing");

  // Auch jeder Lesezugriff sperrt — der Ledger ist kaputt, nicht leer.
  assert.throws(() => S.costSnapshot(store.snapshot(), { localDate: HEUTE }), (e) => e.status === 503);
  assert.throws(() => S.readRuntime(store.snapshot()), (e) => e.code === "cost_ledger_inconsistent");
});

test("G2 eine negative oder verbogene Summe wird nie als 0 gelesen", () => {
  for (const [name, wert] of [["negativ", -2000], ["zu klein", 0], ["zu gross", 99999], ["kaputt", "viel"]]) {
    const { store, verified } = aufgesetzt();
    assert.equal(reserviere(store, verified).result.ok, true);
    store.forceWrite((data) => { data.automation.runtime.cost.byDay[HEUTE].openMicros = wert; return data; });
    assert.throws(() => S.reserveCost(store.snapshot(), {
      callId: "call-2", runKey: RUNKEY2, provider: ANBIETER, model: MODELL, contentHash: HASH_B,
      now: T0 + 1000, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS,
    }), (e) => e.code === "cost_ledger_inconsistent" && e.status === 503, name);
  }
  // Ebenso fuer Belegindex und Ungeklaert-Liste.
  const { store, verified } = aufgesetzt();
  reserviere(store, verified);
  store.forceWrite((data) => { data.automation.runtime.cost.contentHashIndex = {}; return data; });
  assert.throws(() => S.readRuntime(store.snapshot()), (e) => e.detail.reason === "content_hash_index");
});

test("G2b nur ein GANZ neuer Laufzeitbereich wird angelegt, ein halber nie ergaenzt", () => {
  const store = createCasStore(minimalCore());
  // Ganz neu: wird angelegt.
  assert.equal(casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result.ok, true);
  // Halb: wird abgelehnt, nicht aufgefuellt.
  store.forceWrite((data) => { delete data.automation.runtime.cost; return data; });
  assert.throws(() => S.readRuntime(store.snapshot()), (e) => e.code === "runtime_area_invalid" && e.detail.reason === "missing_area");
  assert.throws(() => S.acquireLease(store.snapshot(), { holder: "r", scope: SCOPE, now: T0 + 1000 }), (e) => e.status === 503);
});

/* ── 3: fehlender Fence-Zaehler ────────────────────────────────────────── */

test("G3 ein fehlender Fence-Zaehler ist 503 — ein alter Fence bekommt nie wieder Rechte", () => {
  const store = createCasStore(minimalCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  assert.equal(a.result.fence, 1);
  casMutate(store, (d) => S.releaseLease(d, { holder: "runner-a", fence: 1, scope: SCOPE, now: T0 + 1000 }));

  store.forceWrite((data) => { delete data.automation.runtime.leaseFenceCounter; return data; });
  assert.throws(() => S.acquireLease(store.snapshot(), { holder: "runner-a", scope: SCOPE, now: T0 + 2000 }),
    (e) => e.code === "runtime_area_invalid" && e.status === 503 && e.detail.reason === "lease_fence_counter");

  // Auch ein zurueckgedrehter Zaehler faellt auf.
  store.forceWrite((data) => { data.automation.runtime.leaseFenceCounter = 0; data.automation.activeLease = null; return data; });
  const runKeyMitFence = () => store.forceWrite((data) => {
    data.automation.runtime.runsByKey = { [RUNKEY]: { runKey: RUNKEY, sections: { s1: { id: "s1", fence: 7 } } } };
    return data;
  });
  runKeyMitFence();
  assert.throws(() => S.acquireLease(store.snapshot(), { holder: "runner-a", scope: SCOPE, now: T0 + 3000 }),
    (e) => e.detail.reason === "fence_counter_behind" && e.detail.observed === 7);
});

/* ── 4: Lease mit erfundener Laufzeit ──────────────────────────────────── */

test("G4 eine Lease mit zehn Stunden Laufzeit ist ein kaputter Datensatz, kein Besitz", () => {
  const { store } = aufgesetzt();
  const zehnStunden = 10 * 60 * 60 * 1000;
  store.forceWrite((data) => {
    const l = data.automation.activeLease;
    l.ttlMs = zehnStunden;
    l.expiresAtMs = T0 + zehnStunden;
    return data;
  });
  const verified = { holder: "runner-a", fence: 1, scope: SCOPE };
  assert.throws(() => S.checkLeadership(store.snapshot(), verified, T0 + 3_600_000),
    (e) => e.code === "lease_record_invalid" && e.status === 503 && e.detail.reason === "ttl_out_of_range");
  assert.throws(() => S.assertLeadership(store.snapshot(), verified, T0 + 3_600_000), (e) => e.status === 503);

  // Auch stimmige Einzelwerte mit falschem Zusammenhang fallen durch.
  const faelle = [
    ["expires_mismatch", (l) => { l.expiresAtMs = l.renewedAtMs + 100_000; }],
    ["renew_by_mismatch", (l) => { l.renewByMs = l.renewedAtMs + 119_000; }],
    ["acquired_after_renewed", (l) => { l.acquiredAtMs = l.renewedAtMs + 1; }],
  ];
  for (const [reason, verbiegen] of faelle) {
    const { store: s2 } = aufgesetzt();
    s2.forceWrite((data) => { verbiegen(data.automation.activeLease); return data; });
    assert.throws(() => S.checkLeadership(s2.snapshot(), { holder: "runner-a", fence: 1, scope: SCOPE }, T0 + 1000),
      (e) => e.code === "lease_record_invalid" && e.detail.reason === reason, reason);
  }

  // Ein hochgesetzter Fence faellt schon beim Zaehlerabgleich auf.
  const { store: s3 } = aufgesetzt();
  s3.forceWrite((data) => { data.automation.activeLease.fence = 99; return data; });
  assert.throws(() => S.checkLeadership(s3.snapshot(), { holder: "runner-a", fence: 99, scope: SCOPE }, T0 + 1000),
    (e) => e.code === "runtime_area_invalid" && e.detail.reason === "fence_counter_behind" && e.detail.observed === 99);
});

/* ── 5: Sendefreigabe ──────────────────────────────────────────────────── */

test("G5 eine wiederholte Reservierung ist keine neue Sendefreigabe", () => {
  const { store, verified } = aufgesetzt();
  const erst = reserviere(store, verified);
  assert.equal(erst.result.dispatchAllowed, false, "die Reservierung allein sendet nichts");

  const claim = casMutate(store, (d) => S.claimCostDispatch(d, { callId: "call-1", claimId: "dispatch-1", now: T0 + 100, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true }));
  assert.equal(claim.result.ok, true);
  assert.equal(claim.result.dispatchAllowed, true);

  // Genau hier stuerzt der Laeufer ab: gesendet, aber kein Vermerk.
  const zweit = reserviere(store, verified);
  assert.equal(zweit.result.duplicate, true);
  assert.equal(zweit.result.dispatchAllowed, false);
  assert.equal(zweit.result.dispatchClaimed, true);

  const zweiterClaim = casMutate(store, (d) => S.claimCostDispatch(d, { callId: "call-1", claimId: "dispatch-2", now: T0 + 200, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true }));
  assert.equal(zweiterClaim.result.ok, false);
  assert.equal(zweiterClaim.result.code, "dispatch_already_claimed");
  assert.equal(zweiterClaim.result.detail.blocksRetry, true);
  assert.equal(zweiterClaim.wrote, false);

  // Auch derselbe Anspruch noch einmal oeffnet nichts.
  const gleicherClaim = casMutate(store, (d) => S.claimCostDispatch(d, { callId: "call-1", claimId: "dispatch-1", now: T0 + 300, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true }));
  assert.equal(gleicherClaim.result.code, "dispatch_already_claimed");

  // Und ein neuer Aufruf mit demselben Inhalt ist gesperrt, bis der Ausgang
  // belegt aufgeloest ist.
  assert.equal(S.isBlindRetryBlocked(store.snapshot(), HASH_A), true);
  const neuerVersuch = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-neu", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
    now: T0 + 400, verifiedScope: verified, policy: policy(), __allowFixturePolicy: true, ...TOKENS,
  }));
  assert.equal(neuerVersuch.result.code, "unknown_outcome_blocks_retry");
  assert.equal(neuerVersuch.result.detail.reason, "dispatch_claimed_unresolved");

  // "Nie abgeschickt" ist nach einem Anspruch keine zulaessige Begruendung.
  const freigabe = casMutate(store, (d) => S.releaseCostReservation(d, {
    callId: "call-1", now: T0 + 500, verifiedScope: verified, evidence: { kind: "not_dispatched", ref: "x" },
  }));
  assert.equal(freigabe.result.code, "dispatch_claimed_requires_provider_evidence");
});

/* ── 6: der vollstaendige Aufrufvertrag ────────────────────────────────── */

test("G6 dieselbe Call-Id mit anderem Modell, Lauf oder Tokenumfang ist ein Konflikt", () => {
  const abweichungen = [
    ["model", { model: MODELL_B }],
    ["runKey", { runKey: RUNKEY2 }],
    ["provider", { provider: "synthetic-provider-2" }],
    ["inputTokens", { inputTokens: 90_000 }],
    ["outputTokens", { outputTokens: 40_000 }],
  ];
  for (const [feld, anders] of abweichungen) {
    const { store, verified } = aufgesetzt();
    assert.equal(reserviere(store, verified).result.ok, true);
    const p = feld === "provider"
      ? policy({ models: { ...policy().models, "synthetic-provider-2:synthetic-model-a": { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 } } })
      : policy();
    const res = casMutate(store, (d) => S.reserveCost(d, {
      callId: "call-1", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
      now: T0 + 1000, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS, ...anders,
    }));
    assert.equal(res.result.ok, false, feld);
    assert.equal(res.result.code, "cost_call_conflict", feld);
    assert.ok(res.result.detail.differs.includes(feld) || res.result.detail.differs.includes("maxMicros"), `${feld}: ${JSON.stringify(res.result.detail.differs)}`);
    assert.equal(res.wrote, false, feld);
  }
  // Ein wirklich identischer Aufruf bleibt eine Wiederholung.
  const { store, verified } = aufgesetzt();
  reserviere(store, verified);
  assert.equal(reserviere(store, verified).result.duplicate, true);
});

/* ── 7: zwei offene Abschnitte ─────────────────────────────────────────── */

test("G7 ein zweiter Abschnitt ohne Checkpoint gibt es nicht — die Grenzen bleiben", () => {
  const { store, verified } = aufgesetzt();
  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "http-1", kind: "http", now: T0, verifiedScope: verified }));
  casMutate(store, (d) => S.renewLease(d, { holder: "runner-a", fence: 1, scope: SCOPE, now: T0 + 55_000 }));

  const zweiter = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "http-2", kind: "http", now: T0 + 60_000, verifiedScope: verified }));
  assert.equal(zweiter.result.ok, false);
  assert.equal(zweiter.result.code, "section_already_open");
  assert.equal(zweiter.result.detail.openSectionId, "http-1");
  assert.equal(zweiter.wrote, false);
  assert.equal(store.snapshot().automation.runtime.runsByKey[RUNKEY].currentSectionId, "http-1");

  // Eine Wiederaufnahme ist moeglich — aber nur ausdruecklich und protokolliert.
  const falsch = casMutate(store, (d) => S.startRunSection(d, {
    runKey: RUNKEY, sectionId: "http-2", kind: "http", now: T0 + 60_000, verifiedScope: verified,
    crashRecovery: { previousSectionId: "http-9", reason: "instance_lost" },
  }));
  assert.equal(falsch.result.code, "crash_recovery_invalid");

  const erlaubt = casMutate(store, (d) => S.startRunSection(d, {
    runKey: RUNKEY, sectionId: "http-2", kind: "http", now: T0 + 60_000, verifiedScope: verified,
    crashRecovery: { previousSectionId: "http-1", reason: "instance_lost" },
  }));
  assert.equal(erlaubt.result.ok, true);
  assert.equal(erlaubt.result.recoveredSectionId, "http-1");
  const run = store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.equal(run.sections["http-1"].closed, true);
  assert.equal(run.sections["http-1"].closeReason, "crash_recovery:instance_lost");
  assert.deepEqual(run.recoveries.map((r) => r.sectionId), ["http-1"]);
  // Die Wandzeit des abgebrochenen Abschnitts zaehlt weiter mit.
  assert.equal(run.closedSectionsMs, 60_000);
});

test("G7b Nicht-Werkzeug-Arbeit zaehlt gegen das 20-Minuten-Budget", () => {
  const { store, verified } = aufgesetzt();
  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "w1", kind: "work", now: T0, verifiedScope: verified }));
  // Kein einziger Werkzeugschritt — nur Wandzeit.
  for (let t = 60_000; t <= 20 * 60_000; t += 60_000) {
    casMutate(store, (d) => S.renewLease(d, { holder: "runner-a", fence: 1, scope: SCOPE, now: T0 + t }));
  }
  const run = store.snapshot().automation.runtime.runsByKey[RUNKEY];
  const budget = S.evaluateRuntimeBudget(run, { now: T0 + 20 * 60_000 });
  assert.equal(run.toolMs, 0, "es gab keinen Werkzeugschritt");
  assert.equal(budget.activeMs, 20 * 60_000, "die Wandzeit zaehlt trotzdem");
  assert.equal(budget.mustStop, true);
  assert.ok(budget.reasons.includes("run_active_ms_exhausted"), JSON.stringify(budget.reasons));
  assert.equal(budget.remainingActiveMs, 0);
});

/* ── 8: 20 + 5 + 5 ─────────────────────────────────────────────────────── */

test("G8 das Hauptbudget verbraucht nicht die beiden Spaetfenster — echte 20+5+5-Folge", () => {
  const TAG = "2026-09-19";
  const KEY = P.slotRunKey("quantus", TAG, "close23", "3.0");
  const START = P.wallTimeToMs(TAG, 23, 0);
  const store = createCasStore(minimalCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: START }));
  const verified = { holder: "runner-a", fence: a.result.fence, scope: SCOPE };
  const erneuern = (bis) => {
    for (let t = 60_000; t <= bis; t += 60_000) {
      const r = casMutate(store, (d) => S.renewLease(d, { holder: "runner-a", fence: verified.fence, scope: SCOPE, now: START + t }));
      assert.equal(r.result.ok, true, `Erneuerung bei +${t / 1000}s`);
    }
  };

  // Hauptabschnitt: 23:00 bis 23:20, ein Werkzeugschritt ueber 20 Minuten.
  casMutate(store, (d) => S.startRunSection(d, { runKey: KEY, sectionId: "main", kind: "work", now: START, verifiedScope: verified }));
  erneuern(20 * 60_000);
  const schritt = casMutate(store, (d) => S.recordToolStep(d, {
    runKey: KEY, sectionId: "main", stepId: "big", durationMs: 1_200_000,
    now: START + 20 * 60_000, verifiedScope: verified,
  }));
  assert.equal(schritt.result.ok, true);
  assert.equal(schritt.result.mustCheckpoint, true, "das Hauptbudget ist aufgebraucht");
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: KEY, sectionId: "main", checkpointId: "cp-main", continuationId: "cont-1",
    reason: "budget", cursor: {}, now: START + 20 * 60_000, verifiedScope: verified,
  }));

  // Erstes Zusatzfenster um 23:20 — MUSS erlaubt sein.
  const late1 = casMutate(store, (d) => S.startRunSection(d, {
    runKey: KEY, sectionId: "late-1", kind: "late", now: START + 20 * 60_000,
    verifiedScope: verified, resumeFrom: "cont-1", budgetAvailable: true,
  }));
  assert.equal(late1.result.ok, true, JSON.stringify(late1.result));
  assert.equal(late1.result.budgetMs, 5 * 60_000);
  assert.equal(late1.result.lateSections, 1);
  assert.equal(late1.result.grantedExtraMs, 5 * 60_000);

  erneuern(25 * 60_000);
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: KEY, sectionId: "late-1", checkpointId: "cp-l1", continuationId: "cont-2",
    reason: "late", cursor: {}, now: START + 25 * 60_000, verifiedScope: verified,
  }));

  // Zweites Zusatzfenster um 23:25 — ebenfalls erlaubt.
  const late2 = casMutate(store, (d) => S.startRunSection(d, {
    runKey: KEY, sectionId: "late-2", kind: "late", now: START + 25 * 60_000,
    verifiedScope: verified, resumeFrom: "cont-2", budgetAvailable: true,
  }));
  assert.equal(late2.result.ok, true, JSON.stringify(late2.result));
  assert.equal(late2.result.lateSections, 2);
  assert.equal(late2.result.grantedExtraMs, 10 * 60_000);

  erneuern(30 * 60_000);
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: KEY, sectionId: "late-2", checkpointId: "cp-l2", continuationId: "cont-3",
    reason: "late", cursor: {}, now: START + 30 * 60_000, verifiedScope: verified,
  }));

  // Ein drittes gibt es nicht — und 23:30 ist ohnehin Schluss.
  const late3 = casMutate(store, (d) => S.startRunSection(d, {
    runKey: KEY, sectionId: "late-3", kind: "late", now: START + 30 * 60_000,
    verifiedScope: verified, resumeFrom: "cont-3", budgetAvailable: true,
  }));
  assert.equal(late3.result.ok, false);
  assert.equal(late3.result.code, "late_hard_stop");

  const run = store.snapshot().automation.runtime.runsByKey[KEY];
  assert.equal(run.closedSectionsMs, 30 * 60_000, "20 + 5 + 5 Minuten Wandzeit");
  assert.equal(run.grantedExtraMs, 10 * 60_000);
  assert.equal(run.green, false);
});

test("G8b ohne Budget und ohne Schrittvorrat gibt es auch kein Zusatzfenster", () => {
  const TAG = "2026-09-19";
  const KEY = P.slotRunKey("quantus", TAG, "close23", "3.0");
  const START = P.wallTimeToMs(TAG, 23, 0);
  const store = createCasStore(minimalCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: START }));
  const verified = { holder: "r", fence: a.result.fence, scope: SCOPE };
  casMutate(store, (d) => S.startRunSection(d, { runKey: KEY, sectionId: "main", kind: "work", now: START, verifiedScope: verified }));
  // 30 Schritte verbrauchen den Schrittvorrat.
  for (let i = 1; i <= 30; i++) {
    casMutate(store, (d) => S.recordToolStep(d, { runKey: KEY, sectionId: "main", stepId: `s${i}`, durationMs: 0, now: START + i * 1000, verifiedScope: verified }));
  }
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: KEY, sectionId: "main", checkpointId: "cp", continuationId: "c1", reason: "steps", cursor: {},
    now: START + 60_000, verifiedScope: verified,
  }));
  const ohneBudget = casMutate(store, (d) => S.startRunSection(d, {
    runKey: KEY, sectionId: "late-1", kind: "late", now: START + 61_000, verifiedScope: verified, resumeFrom: "c1",
  }));
  assert.equal(ohneBudget.result.code, "late_section_without_budget");
  const mitBudget = casMutate(store, (d) => S.startRunSection(d, {
    runKey: KEY, sectionId: "late-1", kind: "late", now: START + 61_000, verifiedScope: verified, resumeFrom: "c1", budgetAvailable: true,
  }));
  assert.equal(mitBudget.result.code, "budget_exhausted");
  assert.deepEqual(mitBudget.result.detail.reasons, ["run_tool_steps_exhausted"], "die 30 Schritte gelten weiter");
});

/* ── 9: Abrechnungstag ─────────────────────────────────────────────────── */

test("G9 ein Nachholauf vom Vortag belastet das HEUTIGE Tagesbudget", () => {
  const heuteMs = P.wallTimeToMs("2026-09-20", 10, 0);
  const gestern = P.slotRunKey("quantus", "2026-09-19", "close23", "3.0");
  const heute = P.slotRunKey("quantus", "2026-09-20", "process09", "3.0");
  const p = policy({ effectiveUntilMs: heuteMs + 86_400_000 });

  const store = createCasStore(minimalCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: heuteMs }));
  const verified = { holder: "r", fence: a.result.fence, scope: SCOPE };

  // Der Nachholauf traegt das Datum vom 19., wird aber auf den 20. gebucht.
  const nachhol = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-gestern", runKey: gestern, provider: ANBIETER, model: MODELL, contentHash: HASH_A,
    now: heuteMs, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS,
  }));
  assert.equal(nachhol.result.ok, true);
  assert.equal(nachhol.result.billingLocalDate, "2026-09-20");
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.byDay["2026-09-20"].openMicros, 200);
  assert.equal(cost.byDay["2026-09-19"], undefined, "der Vortag wird nicht belastet");
  assert.equal(cost.callsById["call-gestern"].runLocalDate, "2026-09-19", "die Laufidentitaet bleibt");

  // Der heutige Lauf faellt damit ueber das Tageslimit von 300.
  const heutig = casMutate(store, (d) => S.reserveCost(d, {
    callId: "call-heute", runKey: heute, provider: ANBIETER, model: MODELL, contentHash: HASH_B,
    now: heuteMs + 1000, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS,
  }));
  assert.equal(heutig.result.ok, false);
  assert.equal(heutig.result.code, "day_budget_exceeded");
  assert.equal(heutig.result.detail.localDate, "2026-09-20");
  assert.equal(heutig.result.detail.wouldBe, 400);

  // Ein mitgeschicktes abweichendes Datum wird abgewiesen, nicht geglaubt.
  assert.throws(() => S.reserveCost(store.snapshot(), {
    callId: "call-x", runKey: gestern, provider: ANBIETER, model: MODELL, contentHash: "hashCCCCCCCCCCCCCCCC",
    localDate: "2026-09-19", now: heuteMs, verifiedScope: verified, policy: p, __allowFixturePolicy: true, ...TOKENS,
  }), (e) => e.code === "billing_date_mismatch");
});
