import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../netlify/lib/quantus-v3-runtime-state.mjs';
import * as P from '../netlify/lib/quantus-v3-runtime-plan.mjs';

const T = Date.parse('2026-09-19T08:00:00Z');
const runKey = P.slotRunKey('review', '2026-09-19', 'process09', '3.0');
const runKey2 = P.slotRunKey('review', '2026-09-19', 'continue14', '3.0');
const policy = {
  schema: S.COST_POLICY_SCHEMA, version: 'review-fixture-1', fixture: true, currency: 'CHF',
  approval: { approvedBy: 'fixture', approvalRef: 'not-a-real-approval', approvedAtMs: T - 1000 },
  effectiveFromMs: T - 1000, effectiveUntilMs: T + 30 * 86_400_000,
  dayLimitMicros: 300, runLimitMicros: 300, callLimitMicros: 250, unresolvedBlockMicros: 150,
  featureFlags: { providers: 'live' },
  models: {
    'fixture-provider:model-a': { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 },
    'fixture-provider:model-b': { inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000, maxCallMicros: 250 },
  },
};
function ready(now = T) {
  const data = { entities: {}, automation: { schemaVersion: 3, dataRevision: 0, idempotencyByKey: {}, activeLease: null } };
  const got = S.acquireLease(data, { holder: 'review-runner', scope: 'review:main', now });
  assert.equal(got.result.ok, true);
  return { data: got.data, scope: { holder: 'review-runner', scope: 'review:main', fence: got.result.fence } };
}
function reserve(data, scope, changes = {}) {
  return S.reserveCost(data, { verifiedScope: scope, now: T, callId: 'call-1', runKey, contentHash: 'hashAAAAAAAAAAAAAAAA',
    provider: 'fixture-provider', model: 'model-a', inputTokens: 100_000, outputTokens: 50_000,
    policy, __allowFixturePolicy: true, ...changes });
}
function denied(action) {
  try { return action().result.ok === false; } catch (error) { return error.status >= 400; }
}

test('E1-01: lost day bucket must not reset already reserved daily spend', () => {
  let { data, scope } = ready();
  data = reserve(data, scope).data;
  delete data.automation.runtime.cost.byDay['2026-09-19'];
  assert.ok(denied(() => reserve(data, scope, { callId: 'call-2', runKey: runKey2, contentHash: 'hashBBBBBBBBBBBBBBBB' })));
});
test('E1-02: negative aggregate spend must fail closed rather than fund another call', () => {
  let { data, scope } = ready();
  data = reserve(data, scope).data;
  data.automation.runtime.cost.byDay['2026-09-19'].openMicros = -2000;
  assert.ok(denied(() => reserve(data, scope, { callId: 'call-2', runKey: runKey2, contentHash: 'hashBBBBBBBBBBBBBBBB' })));
});
test('E1-03: missing retained fence counter must never revive an old fence after release', () => {
  let { data, scope } = ready();
  data = S.releaseLease(data, { ...scope, now: T + 1000 }).data;
  delete data.automation.runtime.leaseFenceCounter;
  const result = (() => { try { return S.acquireLease(data, { holder: scope.holder, scope: scope.scope, now: T + 2000 }); } catch (error) { return { error }; } })();
  assert.ok(result.error?.status === 503 || result.result?.fence > scope.fence);
});
test('E1-04: a persisted oversized lease must not authorize leadership', () => {
  const { data, scope } = ready();
  data.automation.activeLease.ttlMs = 10 * 3_600_000;
  data.automation.activeLease.expiresAtMs = T + 10 * 3_600_000;
  assert.ok(denied(() => ({ result: S.checkLeadership(data, scope, T + 3_600_000) })));
});
test('E1-05: duplicate reservation is not a second permission to dispatch a paid call', () => {
  let { data, scope } = ready();
  data = reserve(data, scope).data;
  const duplicate = reserve(data, scope);
  assert.equal(duplicate.result.dispatchAllowed, false);
});
test('E1-06: reusing call id for a changed model or run is a conflict even with same content hash', () => {
  let { data, scope } = ready();
  data = reserve(data, scope).data;
  assert.ok(denied(() => reserve(data, scope, { model: 'model-b', runKey: runKey2 })));
});
test('E1-07: another section cannot silently replace an uncheckpointed open section', () => {
  let { data, scope } = ready();
  data = S.startRunSection(data, { verifiedScope: scope, now: T, runKey, sectionId: 'http-1', kind: 'http' }).data;
  const second = S.startRunSection(data, { verifiedScope: scope, now: T + 60_000, runKey, sectionId: 'http-2', kind: 'http' });
  assert.equal(second.result.ok, false);
});
test('E1-08: the first approved late extension is possible after the main 20 minutes', () => {
  const start = Date.parse('2026-09-19T23:00:00+02:00');
  const closeKey = P.slotRunKey('review', '2026-09-19', 'close23', '3.0');
  let { data, scope } = ready(start);
  data = S.startRunSection(data, { verifiedScope: scope, now: start, runKey: closeKey, sectionId: 'main', kind: 'work' }).data;
  for (let minute = 1; minute <= 20; minute++) data = S.renewLease(data, { ...scope, now: start + minute * 60_000 }).data;
  const afterMain = start + 20 * 60_000;
  data = S.recordToolStep(data, { verifiedScope: scope, now: afterMain, runKey: closeKey, sectionId: 'main', stepId: 'work-1', durationMs: 20 * 60_000 }).data;
  data = S.checkpointRunSection(data, { verifiedScope: scope, now: afterMain, runKey: closeKey, sectionId: 'main', checkpointId: 'checkpoint-1',
    continuationId: 'continuation-1', reason: 'budget_exhausted', cursor: {} }).data;
  const late = S.startRunSection(data, { verifiedScope: scope, now: afterMain, runKey: closeKey, sectionId: 'late-1', kind: 'late',
    resumeFrom: 'continuation-1', budgetAvailable: true });
  assert.equal(late.result.ok, true, JSON.stringify(late.result));
});
test('E1-09: historical catchup charges the actual spend day, not an old daily allowance', () => {
  const now = T + 86_400_000;
  const { data, scope } = ready(now);
  const got = reserve(data, scope, { now });
  assert.equal(got.result.ok, true);
  const call = got.data.automation.runtime.cost.callsById['call-1'];
  assert.equal(call.billingLocalDate, '2026-09-20');
  assert.equal(call.runLocalDate, '2026-09-19');
  assert.equal(got.data.automation.runtime.cost.byDay['2026-09-19'], undefined);
  assert.ok(denied(() => reserve(got.data, scope, { now, callId: 'call-2', contentHash: 'hashBBBBBBBBBBBBBBBB',
    runKey: P.slotRunKey('review', '2026-09-20', 'process09', '3.0') })));
});
