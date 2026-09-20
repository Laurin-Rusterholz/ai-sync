import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../netlify/lib/quantus-v3-runtime-state.mjs';
import * as P from '../netlify/lib/quantus-v3-runtime-plan.mjs';

const T = Date.parse('2026-09-19T23:59:30+02:00');
const runKey = P.slotRunKey('review', '2026-09-19', 'close23', '3.0');
function policy() {
  return {
    schema: S.COST_POLICY_SCHEMA, version: 'review-1', fixture: true, currency: 'CHF',
    approval: { approvedBy: 'fixture', approvalRef: 'not-real', approvedAtMs: T - 1000 },
    effectiveFromMs: T - 1000, effectiveUntilMs: T + 86_400_000,
    dayLimitMicros: 300, runLimitMicros: 300, callLimitMicros: 250,
    unresolvedBlockMicros: 300, featureFlags: { providers: 'live' },
    models: { 'fixture-provider:model-a': {
      inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250,
    } },
  };
}
function ready() {
  const input = { entities: {}, automation: { schemaVersion: 3, dataRevision: 0, idempotencyByKey: {}, activeLease: null } };
  const got = S.acquireLease(input, { holder: 'review-runner', scope: 'review:main', now: T });
  assert.equal(got.result.ok, true);
  return { data: got.data, scope: { holder: 'review-runner', scope: 'review:main', fence: got.result.fence } };
}
function reserve(data, scope, changes = {}) {
  const result = S.reserveCost(data, {
    verifiedScope: scope, now: T, callId: 'call-1', runKey, contentHash: 'hashAAAAAAAAAAAAAAAA',
    provider: 'fixture-provider', model: 'model-a', inputTokens: 100_000, outputTokens: 0,
    policy: policy(), __allowFixturePolicy: true, ...changes,
  });
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  return result.data;
}
function claim(data, scope, changes = {}) {
  return S.claimCostDispatch(data, { verifiedScope: scope, now: T + 1000, callId: 'call-1',
    claimId: 'claim-1', policy: policy(), __allowFixturePolicy: true, ...changes });
}
function denied(fn) {
  try { return fn().result.ok === false; } catch (error) { return error.status >= 400; }
}
test('E1R2-00: a current approved reservation can be dispatched once', () => {
  const { data, scope } = ready();
  const result = claim(reserve(data, scope), scope);
  assert.equal(result.result.dispatchAllowed, true);
  assert.ok(denied(() => claim(result.data, scope)));
});
for (const mode of ['dry_run', 'expired', 'missing']) {
  test(`E1R2-01: dispatch rejects ${mode} current policy despite an older live reservation`, () => {
    const { data, scope } = ready();
    const pending = reserve(data, scope);
    const current = policy();
    if (mode === 'dry_run') current.featureFlags.providers = 'dry_run';
    if (mode === 'expired') current.effectiveUntilMs = T + 500;
    assert.ok(denied(() => claim(pending, scope, { policy: mode === 'missing' ? undefined : current })));
  });
}
test('E1R2-02: crossing midnight cannot dispatch an old-day reservation against a fresh allowance', () => {
  const { data, scope } = ready();
  const pending = reserve(data, scope, { inputTokens: 200_000 });
  const nextDay = T + 31_000;
  const todayKey = P.slotRunKey('review', '2026-09-20', 'briefing04', '3.0');
  const today = reserve(pending, scope, { now: nextDay, callId: 'today', runKey: todayKey,
    inputTokens: 200_000, contentHash: 'hashBBBBBBBBBBBBBBBB' });
  assert.ok(denied(() => claim(today, scope, { now: nextDay })));
});
test('E1R2-03: two existing reservations cannot both claim the same unresolved content', () => {
  const { data, scope } = ready();
  const first = reserve(data, scope);
  const both = reserve(first, scope, { callId: 'call-2' });
  const dispatched = claim(both, scope);
  assert.equal(dispatched.result.dispatchAllowed, true);
  assert.ok(denied(() => claim(dispatched.data, scope, { callId: 'call-2', claimId: 'claim-2' })));
});
test('E1R2-04: deletion of an initialized runtime must not reset the fence and cost ledger', () => {
  const { data, scope } = ready();
  const reserved = reserve(data, scope);
  const released = S.releaseLease(reserved, { ...scope, now: T + 1000 });
  assert.equal(released.result.ok, true);
  const intact = S.acquireLease(released.data, { holder: scope.holder, scope: scope.scope, now: T + 2000 });
  assert.ok(intact.result.fence > scope.fence);
  assert.equal(Object.keys(intact.data.automation.runtime.cost.callsById).length, 1);
  delete released.data.automation.runtime;
  assert.ok(denied(() => S.acquireLease(released.data, { holder: scope.holder, scope: scope.scope, now: T + 2000 })));
});
