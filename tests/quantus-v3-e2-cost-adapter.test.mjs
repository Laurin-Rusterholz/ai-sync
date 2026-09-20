/* ══ Paket E2 — der Adaptervertrag fuer bezahlte Aufrufe ══════════════════
 *
 * Dieselben Grenzen wie in E1, eine Ebene hoeher belegt: der Preisstand
 * wird fuer JEDEN Schritt frisch geladen, gesendet wird nur nach einer
 * erfolgreichen Sendefreigabe, und ein unklarer Ausgang bleibt gebunden.
 *
 * Kein Netz, kein Provider, kein bezahlter Aufruf. Alle Preise und
 * Freigaben sind synthetisch.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import * as E1 from "../netlify/lib/quantus-v3-runtime-state.mjs";
import { createCostAdapter } from "../runtime/quantus-v3/src/cost-adapter.mjs";
import { createPortRegistry, availablePort, unavailablePort, REQUIRED_PORTS } from "../runtime/quantus-v3/src/ports.mjs";

const SCOPE = "quantus:mainrun";
const T0 = PLAN.wallTimeToMs("2026-09-19", 9, 0);
const RUNKEY = PLAN.slotRunKey("quantus", "2026-09-19", "process09", "3.0");
const ANBIETER = "fixture-provider";
const MODELL = "model-a";
const HASH = "hashAAAAAAAAAAAAAAAA";
const TOKENS = { inputTokens: 100_000, outputTokens: 0 };   // = 100 Mikro

function policy(over = {}) {
  return {
    schema: "quantus-v3-cost-policy/1",
    version: "synthetic-1",
    fixture: true,
    currency: "CHF",
    approval: { approvedBy: "test-fixture", approvalRef: "SYNTHETIC-NOT-A-REAL-APPROVAL", approvedAtMs: T0 - 86_400_000 },
    effectiveFromMs: T0 - 86_400_000,
    effectiveUntilMs: T0 + 30 * 86_400_000,
    dayLimitMicros: 300, runLimitMicros: 300, callLimitMicros: 250, unresolvedBlockMicros: 1000,
    featureFlags: { providers: "live" },
    models: { [`${ANBIETER}:${MODELL}`]: { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 } },
    ...over,
  };
}

/* Die Testvorlage traegt `fixture: true` und wird ausserhalb der Tests von
 * E1 abgelehnt. Der Adapter bekommt die Testnaht ausdruecklich uebergeben;
 * ein produktiver Preisstand traegt das Merkmal nie. */
function policyPort(folge) {
  const schritte = [];
  return {
    schritte,
    port: availablePort("costPolicy", {
      async load({ step }) {
        schritte.push(step);
        return typeof folge === "function" ? folge(step, schritte.length) : folge;
      },
    }),
  };
}

function aufbau(folge, { policyPortVerfuegbar = true, now = T0 } = {}) {
  const store = F.createCasStore(F.baseCore());
  const core = F.createCorePort(store);
  const a = F.casMutate(store, (d) => E1.acquireLease(d, { holder: "runner-a", scope: SCOPE, now }));
  const verifiedScope = { holder: "runner-a", fence: a.result.fence, scope: SCOPE };
  const pp = policyPort(folge);
  const clock = F.createClock(now);
  const ports = createPortRegistry("worker", {
    clock: clock.port,
    core: core.port,
    costPolicy: policyPortVerfuegbar ? pp.port : unavailablePort("costPolicy", "cost_policy_not_wired"),
  });
  // Bezahlte Aufrufe gibt es nur im Live-Betrieb mit allen Freigabetoren —
  // der Adapter prueft das bei jedem Schritt frisch.
  const config = F.configFor("worker", {
    QUANTUS_V3_RUNTIME_MODE: "live",
    QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
    QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed(),
    QUANTUS_V3_REQUIRED_SOURCES: JSON.stringify(["gmail-inbox"]),
  });
  const ctx = { ports, config, now, requestId: "req-1", verifiedScope };
  return { store, core, ports, ctx, pp, clock, adapter: createCostAdapter(ctx, { __allowFixturePolicy: true }) };
}

const reserviere = (a) => a.reserve({ callId: "call-1", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH, ...TOKENS });

test("der Preisstand wird fuer JEDEN Schritt frisch geladen", async () => {
  const { adapter, pp } = aufbau(policy());
  await reserviere(adapter);
  assert.deepEqual(pp.schritte, ["reserve"]);
  await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: async () => ({ outcome: "settled", actualMicros: 80, usageReceiptId: "receipt-1" }),
  });
  assert.deepEqual(pp.schritte, ["reserve", "claim"], "die Policy der Reservierung wird nicht wiederverwendet");
});

test("die Reservierung allein gibt nie eine Sendefreigabe", async () => {
  const { adapter } = aufbau(policy());
  const res = await reserviere(adapter);
  assert.equal(res.dispatchAllowed, false);
  assert.equal(res.maxMicros, 100);
});

test("ein zwischenzeitlich zurueckgezogener Preisstand verhindert die Sendung", async () => {
  for (const [name, zweite] of [
    ["dry_run", policy({ featureFlags: { providers: "dry_run" } })],
    ["abgelaufen", policy({ effectiveUntilMs: T0 - 1 })],
    ["fehlt", null],
    ["ohne Freigabe", policy({ approval: null })],
  ]) {
    const { adapter, store } = aufbau((step) => (step === "reserve" ? policy() : zweite));
    await reserviere(adapter);
    let gesendet = false;
    await assert.rejects(() => adapter.claimAndDispatch({
      callId: "call-1", claimId: "dispatch-1",
      send: async () => { gesendet = true; return { outcome: "settled", actualMicros: 10 }; },
    }), (e) => e.status >= 400, name);
    assert.equal(gesendet, false, `${name}: es wurde nichts gesendet`);
    assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false, name);
  }
});

test("ein Tageswechsel zwischen Reservierung und Sendung stoppt den Adapter", async () => {
  // Reserviert um 23:59:30; das Laden des Preisstands vor der Sendung
  // dauert 31 Sekunden. Der Adapter rechnet mit der FRISCHEN Zeit.
  const kurzVorMitternacht = Date.parse("2026-09-19T23:59:30+02:00");
  let uhr = null;
  const { adapter, store, clock } = aufbau((step) => {
    if (step === "claim") uhr.advance(31_000);
    return policy();
  }, { now: kurzVorMitternacht });
  uhr = clock;
  await reserviere(adapter);
  let gesendet = false;
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: async () => { gesendet = true; return { outcome: "settled", actualMicros: 10 }; },
  }), (e) => e.error === "dispatch_not_allowed" && e.detail.code === "billing_day_rolled_over");
  assert.equal(gesendet, false);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].dispatch.claimed, false);
});

test("ohne Preisstandport gibt es 503 und keinen Aufruf", async () => {
  const { adapter } = aufbau(policy(), { policyPortVerfuegbar: false });
  await assert.rejects(() => reserviere(adapter),
    (e) => e.status === 503 && e.error === "port_unavailable" && e.detail.port === "costPolicy");
  assert.ok(REQUIRED_PORTS.worker.includes("costPolicy"), "der Port gehoert zu den Pflichtports des Workers");
});

test("ein gescheiterter Provideraufruf hinterlaesst einen gebundenen, unklaren Ausgang", async () => {
  const { adapter, store } = aufbau(policy());
  await reserviere(adapter);
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: async () => { throw new Error("socket hang up"); },
  }), (e) => e.error === "provider_outcome_unknown" && e.detail.retryAllowed === false);

  const call = store.snapshot().automation.runtime.cost.callsById["call-1"];
  assert.equal(call.state, "unknown");
  assert.equal(E1.isBlindRetryBlocked(store.snapshot(), HASH), true);
});

test("eine unbrauchbare Provider-Antwort gilt als unklar, nicht als Erfolg", async () => {
  for (const antwort of [undefined, null, {}, { outcome: "irgendwas" }, "ok"]) {
    const { adapter, store } = aufbau(policy());
    await reserviere(adapter);
    await assert.rejects(() => adapter.claimAndDispatch({
      callId: "call-1", claimId: "dispatch-1", send: async () => antwort,
    }), (e) => e.error === "provider_outcome_unknown", JSON.stringify(antwort));
    assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].state, "unknown");
  }
});

test("ein ausdruecklich unklarer Ausgang wird gebunden gemeldet, nicht geworfen", async () => {
  const { adapter, store } = aufbau(policy());
  await reserviere(adapter);
  const out = await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: async () => ({ outcome: "unknown", providerRequestId: "req-unklar" }),
  });
  assert.equal(out.outcome, "unknown");
  assert.equal(out.retryAllowed, false);
  assert.equal(out.blocksRetry, true);
  assert.equal(store.snapshot().automation.runtime.cost.callsById["call-1"].providerRequestId, "req-unklar");
});

test("der erfolgreiche Weg belegt Verbrauch und gibt den Rest frei — genau einmal", async () => {
  const { adapter, store } = aufbau(policy());
  await reserviere(adapter);
  const out = await adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1",
    send: async () => ({ outcome: "settled", actualMicros: 80, usageReceiptId: "receipt-1", providerRequestId: "req-1" }),
  });
  assert.equal(out.outcome, "settled");
  assert.equal(out.settledMicros, 80);
  assert.equal(out.releasedMicros, 20);
  assert.deepEqual(out.violations, []);

  // Ein zweiter Anspruch fuer denselben Aufruf geht nicht mehr durch.
  let gesendet = false;
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-2",
    send: async () => { gesendet = true; return { outcome: "settled", actualMicros: 80 }; },
  }), (e) => e.error === "dispatch_not_allowed");
  assert.equal(gesendet, false);
  const cost = store.snapshot().automation.runtime.cost;
  assert.equal(cost.byDay["2026-09-19"].settledMicros, 80, "keine doppelte Belastung");
});

test("ohne vollstaendige Freigabetore gibt es keinen bezahlten Aufruf", async () => {
  const { ports, ctx } = aufbau(policy());
  const dryRun = createCostAdapter({ ...ctx, config: F.configFor("worker") }, { __allowFixturePolicy: true });
  await assert.rejects(() => dryRun.reserve({ callId: "call-1", runKey: RUNKEY, provider: ANBIETER, model: MODELL, contentHash: HASH, ...TOKENS }),
    (e) => e.error === "external_effects_not_allowed" && e.detail.mode === "dry_run");
  assert.ok(ports.has("core"));
});

test("ein wiederholter Anspruchsbeleg ist keine neue Sendefreigabe", async () => {
  const { adapter, store } = aufbau(policy());
  await reserviere(adapter);
  let gesendet = 0;
  const senden = async () => { gesendet += 1; return { outcome: "settled", actualMicros: 80, usageReceiptId: `receipt-${gesendet}` }; };
  await adapter.claimAndDispatch({ callId: "call-1", claimId: "dispatch-1", send: senden });
  assert.equal(gesendet, 1);

  // Genau dieselbe Zustellung noch einmal: der Kern liefert den Beleg von
  // damals. Das darf NICHT wieder senden.
  await assert.rejects(() => adapter.claimAndDispatch({ callId: "call-1", claimId: "dispatch-1", send: senden }),
    (e) => e.error === "dispatch_not_allowed" && e.detail.code === "claim_receipt_replayed");
  assert.equal(gesendet, 1, "kein zweiter Provideraufruf");
  assert.equal(store.snapshot().automation.runtime.cost.byDay["2026-09-19"].settledMicros, 80);
});

test("ein Kern ohne Initialisierungsnachweis sperrt jeden bezahlten Schritt", async () => {
  const { adapter, store } = aufbau(policy());
  await reserviere(adapter);
  store.forceWrite((data) => { delete data.automation.runtime; return data; });
  let gesendet = false;
  await assert.rejects(() => adapter.claimAndDispatch({
    callId: "call-1", claimId: "dispatch-1", send: async () => { gesendet = true; return { outcome: "settled", actualMicros: 1 }; },
  }), (e) => e.code === "runtime_missing_after_init" || e.error === "runtime_missing_after_init");
  assert.equal(gesendet, false);
});
