/* ══ E2 — die sechs Gegenbeispiele zum Kostenadapter ═════════════════════
 *
 * Die unabhaengige Pruefung hat den Adapter gegen den ECHTEN
 * Idempotenzumschlag laufen lassen. Sechs Faelle kamen durch, alle auf
 * zwei Ursachen zurueckzufuehren: ein WIEDERGEGEBENER Buchungsbeleg wurde
 * als Sendeberechtigung gelesen, und gerechnet wurde mit der Zeit vom
 * Anfragebeginn statt mit einer frischen.
 *
 * Diese Datei haelt alle sechs fest. Der Kernport meldet hier — wie der
 * echte Umschlag — `replayed` und `wrote`; zusaetzlich gibt es einen Port,
 * der darueber falsch berichtet, damit auch die Nachpruefung am Bestand
 * belegt ist.
 *
 * Keine echten Provideraufrufe, keine Kosten. Alle Preise und Freigaben
 * sind synthetisch.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import * as E1 from "../netlify/lib/quantus-v3-runtime-state.mjs";
import { createCostAdapter, DISPATCH_LEASE_RESERVE_MS, pruefeUnmittelbarVorSendung } from "../runtime/quantus-v3/src/cost-adapter.mjs";
import { createPortRegistry, availablePort } from "../runtime/quantus-v3/src/ports.mjs";

const SCOPE = "quantus:mainrun";
const T0 = PLAN.wallTimeToMs("2026-09-19", 9, 0);
const RUNKEY = PLAN.slotRunKey("quantus", "2026-09-19", "process09", "3.0");
const ANBIETER = "fixture-provider";
const MODELL = "model-a";
const HASH = "hashAAAAAAAAAAAAAAAA";
const TOKENS = { inputTokens: 100_000, outputTokens: 0 };   // = 100 Mikro

function policy(over = {}, basis = T0) {
  return {
    schema: "quantus-v3-cost-policy/1",
    version: "synthetic-1",
    fixture: true,
    currency: "CHF",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: basis - 86_400_000 },
    effectiveFromMs: basis - 86_400_000,
    effectiveUntilMs: basis + 30 * 86_400_000,
    dayLimitMicros: 300, runLimitMicros: 300, callLimitMicros: 250, unresolvedBlockMicros: 1000,
    featureFlags: { providers: "live" },
    models: { [`${ANBIETER}:${MODELL}`]: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 } },
    ...over,
  };
}

const liveConfig = () => F.configFor("worker", {
  QUANTUS_V3_RUNTIME_MODE: "live",
  QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
  QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed(),
  QUANTUS_V3_REQUIRED_SOURCES: JSON.stringify(["gmail-inbox"]),
});

/* Der Kernport meldet `replayed` und `wrote` — genau wie der echte
 * Umschlag. `luegen` laesst ihn beides beschoenigen. */
function aufbau({ policyFolge = () => policy(), now = T0, luegen = false, leaseReserveMs } = {}) {
  const store = F.createCasStore(F.baseCore());
  const core = F.createCorePort(store);
  const clock = F.createClock(now);
  const a = F.casMutate(store, (d) => E1.acquireLease(d, { holder: "runner-a", scope: SCOPE, now }));
  const verifiedScope = { holder: "runner-a", fence: a.result.fence, scope: SCOPE };
  const echterPort = core.port.impl;
  const kernPort = luegen
    ? availablePort("core", {
      read: (...args) => echterPort.read(...args),
      async mutate(...args) { const out = await echterPort.mutate(...args); return { ...out, replayed: false, wrote: true }; },
    })
    : core.port;
  const pp = { schritte: [], port: availablePort("costPolicy", {
    async load({ step }) { pp.schritte.push(step); return policyFolge(step, clock); },
  }) };
  const ports = createPortRegistry("worker", { clock: clock.port, core: kernPort, costPolicy: pp.port });
  const ctx = { ports, config: liveConfig(), now, requestId: "req-1", verifiedScope };
  return {
    store, core, clock, pp, ctx,
    adapter: createCostAdapter(ctx, { __allowFixturePolicy: true, ...(leaseReserveMs === undefined ? {} : { leaseReserveMs }) }),
  };
}

const reserviere = (a) => a.reserve({ callId: "call-1", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH, ...TOKENS });

function zaehler() {
  const s = { sends: 0 };
  s.send = async (antwort) => { s.sends += 1; return antwort; };
  return s;
}

/* ── 1: nach einer Abrechnung ─────────────────────────────────────────── */

test("CR-1 nach `settled` sendet dieselbe callId+claimId nicht noch einmal", async () => {
  const { adapter, store } = aufbau();
  await reserviere(adapter);
  const z = zaehler();
  const ok = await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 80, usageReceiptId: "receipt-1" }),
  });
  assert.equal(ok.outcome, "settled");
  assert.equal(z.sends, 1);

  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 80, usageReceiptId: "receipt-1" }),
  }), (e) => e.error === "dispatch_not_allowed" && e.detail.blocksRetry === true);
  assert.equal(z.sends, 1, "genau eine Sendung");
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].settledMicros, 80);
});

/* ── 2: nach einem unklaren Ausgang ───────────────────────────────────── */

test("CR-2 nach `unknown` sendet dieselbe callId+claimId nicht noch einmal", async () => {
  const { adapter, store } = aufbau();
  await reserviere(adapter);
  const z = zaehler();
  const out = await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "unknown", providerRequestId: "req-unklar" }),
  });
  assert.equal(out.outcome, "unknown");
  assert.equal(z.sends, 1);

  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_not_allowed");
  // Auch mit einer NEUEN Anspruchskennung bleibt es gesperrt.
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-2",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_not_allowed");
  assert.equal(z.sends, 1, "nach unklarem Ausgang wird nie blind wiederholt");
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].state, "unknown");
});

/* ── 3: zwei gleiche Anspruechte gleichzeitig ─────────────────────────── */

test("CR-3 zwei gleichzeitige gleiche Anspruechte senden nur einmal", async () => {
  const { adapter, store } = aufbau();
  await reserviere(adapter);

  let sends = 0;
  let freigeben = null;
  const tor = new Promise((resolve) => { freigeben = resolve; });
  let erstesBetreten = null;
  const betreten = new Promise((resolve) => { erstesBetreten = resolve; });
  const send = async () => {
    sends += 1;
    erstesBetreten();
    await tor;
    return { outcome: "settled", actualMicros: 50, usageReceiptId: `receipt-${sends}` };
  };

  const erste = adapter.claimAndDispatch({ callId: "call-1", claimId: "dispatch-1", send });
  await betreten;
  assert.equal(sends, 1, "der erste Sendevorgang haengt am Tor");

  const zweite = adapter.claimAndDispatch({ callId: "call-1", claimId: "dispatch-1", send });
  await assert.rejects(() => zweite, (e) => e.error === "dispatch_not_allowed" && e.detail.blocksRetry === true);
  assert.equal(sends, 1, "der zweite Sendevorgang startet NICHT, solange der erste offen ist");

  freigeben();
  const ergebnis = await erste;
  assert.equal(ergebnis.outcome, "settled");
  assert.equal(sends, 1);
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].settledMicros, 50);
});

/* ── 4: langsames Laden des Preisstands ───────────────────────────────── */

test("CR-4 ein 121 Sekunden langes Laden des Preisstands laesst die Fuehrung ablaufen — es wird nicht gesendet", async () => {
  const { adapter, store, clock } = aufbau({
    policyFolge: (step, uhr) => {
      if (step === "claim") uhr.advance(121_000);   // laenger als die Lease lebt
      return policy();
    },
  });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_not_allowed" && e.detail.code === "lease_expired");
  assert.equal(z.sends, 0, "nichts gesendet");
  assert.equal(clock.value, T0 + 121_000);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

test("CR-4b reicht die Fuehrung nicht mehr fuer die Verbuchung, wird gar nicht gesendet", async () => {
  const { adapter, store } = aufbau({
    policyFolge: (step, uhr) => {
      if (step === "claim") uhr.advance(100_000);   // 20 s Rest, noetig sind 30
      return policy();
    },
  });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.detail.code === "lease_too_short_for_dispatch" && e.detail.requiredMs === DISPATCH_LEASE_RESERVE_MS);
  assert.equal(z.sends, 0);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

/* ── 5: Tageswechsel waehrend des Ladens ──────────────────────────────── */

test("CR-5 ein Tageswechsel zwischen Reservierung und Sendung stoppt die Sendung", async () => {
  const kurzVorMitternacht = Date.parse("2026-09-19T23:59:30+02:00");
  const { adapter, store } = aufbau({
    now: kurzVorMitternacht,
    policyFolge: (step, uhr) => {
      if (step === "claim") uhr.advance(31_000);
      return policy({}, kurzVorMitternacht);
    },
  });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.detail.code === "billing_day_rolled_over");
  assert.equal(z.sends, 0, "nicht gegen das Budget von gestern gesendet");
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.callsById["call-1"].billingLocalDate, "2026-09-19");
  assert.equal(cost.callsById["call-1"].dispatch.claimed, false);
});

/* ── 6: ein Port, der ueber Wiederholung falsch berichtet ─────────────── */

test("CR-6 auch ein Port, der `replayed`/`wrote` beschoenigt, bekommt keine zweite Sendung", async () => {
  const { adapter, store } = aufbau({ luegen: true });
  await reserviere(adapter);
  const z = zaehler();
  await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 60, usageReceiptId: "receipt-1" }),
  });
  assert.equal(z.sends, 1);

  // Der Port meldet die Wiederholung nicht. Die Nachpruefung am Bestand
  // faengt sie trotzdem: der Aufruf ist nicht mehr `reserved`.
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 60 }),
  }), (e) => e.error === "dispatch_not_allowed" && (e.detail.code === "claim_state_mismatch" || e.detail.code === "cost_state_invalid"));
  assert.equal(z.sends, 1);
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].settledMicros, 60);
});

test("CR-6b ein Port, der `wrote`/`replayed` gar nicht meldet, ist ein Vertragsbruch", async () => {
  const basis = aufbau();
  const roh = basis.core.port.impl;
  const stumm = availablePort("core", {
    read: (...a) => roh.read(...a),
    async mutate(...a) { const out = await roh.mutate(...a); return { ok: out.ok, result: out.result }; },
  });
  const ports = createPortRegistry("worker", { clock: basis.clock.port, core: stumm, costPolicy: basis.pp.port });
  const ctx = { ...basis.ctx, ports };
  const adapter = createCostAdapter(ctx, { __allowFixturePolicy: true });
  await adapter.reserve({ callId: "call-2", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: "hashBBBBBBBBBBBBBBBB", ...TOKENS });
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-2", claimId: "dispatch-1", send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.status === 502 && e.detail.reason === "wrote_or_replayed_missing");
  assert.equal(z.sends, 0, "im Zweifel wird nicht gesendet");
});

/* ── Widerruf unmittelbar vor der Sendung ─────────────────────────────── */

test("CR-7 ein Widerruf des Preisstands unmittelbar vor der Sendung verhindert sie", async () => {
  for (const [name, zweite] of [
    ["auf dry_run zurueckgestuft", policy({ featureFlags: { providers: "dry_run" } })],
    ["abgelaufen", policy({ effectiveUntilMs: T0 })],
    ["Freigabe entzogen", policy({ approval: null })],
    ["ganz weg", null],
  ]) {
    const { adapter, store } = aufbau({ policyFolge: (step) => (step === "claim" ? zweite : policy()) });
    await reserviere(adapter);
    const z = zaehler();
    await assert.rejects(() => adapter.claimAndDispatch({
      callId: "call-1", claimId: "dispatch-1", send: () => z.send({ outcome: "settled", actualMicros: 10 }),
    }), (e) => e.status >= 400, name);
    assert.equal(z.sends, 0, name);
    assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false, name);
  }
});

test("CR-8 ein unbekannter Rueckgabebeleg bindet den Aufruf und sperrt denselben Inhalt", async () => {
  const { adapter, store } = aufbau();
  await reserviere(adapter);
  const z = zaehler();
  const out = await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "unknown", providerRequestId: "req-offen" }),
  });
  assert.equal(out.blocksRetry, true);
  assert.equal(E1.isBlindRetryBlocked(store.snapshot(), HASH), true);

  // Ein neuer Aufruf mit demselben Inhalt kommt nicht durch.
  await assert.rejects(() => adapter.reserve({
    callId: "call-neu", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH, ...TOKENS,
  }), (e) => e.detail.code === "unknown_outcome_blocks_retry");
  assert.equal(z.sends, 1);
});

/* ══ Zweite Runde: langsames Kern-I/O zwischen Pruefung und Sendung ══════
 *
 * Jedes gewartete Kern-I/O kann dauern — ein Lesen, ein CAS-Durchlauf mit
 * Wiederholungen. Wird die Zeit VOR diesem I/O genommen, kann die
 * Fuehrung ablaufen, waehrend der Adapter noch glaubt, sie zu halten.
 * ═════════════════════════════════════════════════════════════════════ */

/* Ein Kernport, der bei einem bestimmten Lesevorgang die Uhr vorstellt. */
function verzoegerndenKern(core, clock, { beiLesen, verzoegerungMs }) {
  const roh = core.port.impl;
  let lesen = 0;
  return {
    get reads() { return lesen; },
    port: availablePort("core", {
      async read(...a) {
        lesen += 1;
        const out = await roh.read(...a);
        if (lesen === beiLesen) clock.advance(verzoegerungMs);
        return out;
      },
      mutate: (...a) => roh.mutate(...a),
    }),
  };
}

function aufbauMitVerzoegerung({ beiLesen, verzoegerungMs, now = T0 }) {
  const store = F.createCasStore(F.baseCore());
  const core = F.createCorePort(store);
  const clock = F.createClock(now);
  const a = F.casMutate(store, (d) => E1.acquireLease(d, { holder: "runner-a", scope: SCOPE, now }));
  const verifiedScope = { holder: "runner-a", fence: a.result.fence, scope: SCOPE };
  const langsam = verzoegerndenKern(core, clock, { beiLesen, verzoegerungMs });
  const pp = { schritte: [], port: availablePort("costPolicy", {
    async load({ step }) { pp.schritte.push(step); return policy(); },
  }) };
  const ports = createPortRegistry("worker", { clock: clock.port, core: langsam.port, costPolicy: pp.port });
  const ctx = { ports, config: liveConfig(), now, requestId: "req-1", verifiedScope };
  return { store, core, clock, langsam, ctx, adapter: createCostAdapter(ctx, { __allowFixturePolicy: true }) };
}

test("CR-9 Positivkontrolle: ohne Verzoegerung sendet der normale Weg genau einmal", async () => {
  const { adapter, store } = aufbauMitVerzoegerung({ beiLesen: 99, verzoegerungMs: 0 });
  await reserviere(adapter);
  const z = zaehler();
  const out = await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 70, usageReceiptId: "receipt-1" }),
  });
  assert.equal(out.outcome, "settled");
  assert.equal(out.settledMicros, 70);
  assert.equal(z.sends, 1);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].state, "settled");
});

test("CR-10 ein langsames Lesen VOR dem Anspruch laesst nicht senden", async () => {
  // Lesen 1 = reserve, Lesen 2 = pruefeFrisch(claim), Lesen 3 = vor dem Anspruch.
  const { adapter, store, clock } = aufbauMitVerzoegerung({ beiLesen: 3, verzoegerungMs: 121_000 });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_not_allowed" && e.detail.code === "lease_expired");
  assert.equal(z.sends, 0, "nichts gesendet");
  assert.ok(clock.value >= T0 + 121_000);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false,
    "es wurde nicht einmal beansprucht");
});

test("CR-11 ein langsames Lesen NACH dem Anspruch laesst nicht senden", async () => {
  // Lesen 4 = die Nachpruefung unmittelbar vor der Sendung.
  const { adapter, store, clock } = aufbauMitVerzoegerung({ beiLesen: 4, verzoegerungMs: 121_000 });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_aborted_before_send" && e.detail.code === "lease_expired" && e.detail.blocksRetry === true);
  assert.equal(z.sends, 0, "nichts gesendet, obwohl der Anspruch schon stand");
  assert.ok(clock.value >= T0 + 121_000);

  // Der Anspruch bleibt stehen und sperrt jede Wiederholung desselben
  // Inhalts, bis jemand ihn belegt aufloest.
  const call = store.snapshot().automation.runtime.cost.callsById["call-1"];
  assert.equal(call.state, "reserved");
  assert.equal(call.dispatch.claimed, true);
  assert.equal(E1.isBlindRetryBlocked(store.snapshot(), HASH), true);
});

test("CR-12 ein Tageswechsel waehrend des letzten Lesens laesst nicht senden", async () => {
  const kurzVorMitternacht = Date.parse("2026-09-19T23:59:30+02:00");
  const { adapter, store } = aufbauMitVerzoegerung({ beiLesen: 4, verzoegerungMs: 31_000, now: kurzVorMitternacht });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_aborted_before_send" && e.detail.code === "billing_day_rolled_over");
  assert.equal(z.sends, 0);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].billingLocalDate, "2026-09-19");
});

test("CR-13 ein Fencewechsel zwischen Anspruch und Sendung laesst nicht senden", async () => {
  const store = F.createCasStore(F.baseCore());
  const core = F.createCorePort(store);
  const clock = F.createClock(T0);
  const a = F.casMutate(store, (d) => E1.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const verifiedScope = { holder: "runner-a", fence: a.result.fence, scope: SCOPE };
  const roh = core.port.impl;
  let lesen = 0;
  const kern = availablePort("core", {
    async read(...args) {
      lesen += 1;
      if (lesen === 4) {
        // Ein anderer Laeufer hat inzwischen uebernommen.
        clock.advance(E1.LEASE_TTL_MS + 1);
        F.casMutate(store, (d) => E1.acquireLease(d, { holder: "runner-b", scope: SCOPE, now: clock.value }));
      }
      return roh.read(...args);
    },
    mutate: (...args) => roh.mutate(...args),
  });
  const pp = availablePort("costPolicy", { async load() { return policy(); } });
  const ports = createPortRegistry("worker", { clock: clock.port, core: kern, costPolicy: pp });
  const ctx = { ports, config: liveConfig(), now: T0, requestId: "req-1", verifiedScope };
  const adapter = createCostAdapter(ctx, { __allowFixturePolicy: true });
  await reserviere(adapter);
  const z = zaehler();
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: () => z.send({ outcome: "settled", actualMicros: 10 }),
  }), (e) => e.error === "dispatch_aborted_before_send" && ["lease_lost", "lease_fenced", "lease_expired"].includes(e.detail.code));
  assert.equal(z.sends, 0, "der fremde Fence sendet nichts in unserem Namen");
});

test("CR-14 die Endkontrolle ist rein und prueft alle vier Dinge", () => {
  const scope = { holder: "runner-a", fence: 1, scope: SCOPE };
  const gate = {
    leaseHolder: "runner-a", leaseScope: SCOPE, leaseFence: 1,
    leaseExpiresAtMs: T0 + 120_000, callState: "reserved", claimed: true,
    claimId: "dispatch-1", claimedAtMs: T0, billingLocalDate: "2026-09-19", maxMicros: 100,
  };
  const basis = { gate, policy: policy(), verifiedScope: scope, sendeZeit: T0, leaseReserveMs: 30_000, allowFixture: true };
  assert.equal(pruefeUnmittelbarVorSendung(basis).ok, true, "Positivkontrolle");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, gate: { ...gate, leaseFence: 2 } }).code, "lease_fenced");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, gate: { ...gate, leaseHolder: "runner-b" } }).code, "lease_lost");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, sendeZeit: T0 + 120_001 }).code, "lease_expired");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, sendeZeit: T0 + 100_000 }).code, "lease_too_short_for_dispatch");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, gate: { ...gate, billingLocalDate: "2026-09-18" } }).code, "billing_day_rolled_over");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, policy: policy({ featureFlags: { providers: "dry_run" } }) }).code, "providers_not_live");
  assert.equal(pruefeUnmittelbarVorSendung({ ...basis, policy: policy({ effectiveUntilMs: T0 }) }).code, "cost_policy_invalid");
});
