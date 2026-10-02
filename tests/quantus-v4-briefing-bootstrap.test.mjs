import test from 'node:test';
import assert from 'node:assert/strict';
import { createBriefingSectionWork } from '../runtime/quantus-v3/src/briefing-bootstrap.mjs';
import { migrateCore } from '../netlify/lib/assistant-migration.mjs';
import { applyCommand } from '../netlify/lib/assistant-core.mjs';
import { POLICY_TEMPLATE } from '../netlify/lib/assistant-schema.mjs';
import * as E1 from '../netlify/lib/quantus-v3-runtime-state.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';
import { createFSourcePorts } from '../runtime/quantus-v3/src/f-composition.mjs';
import { DOMAIN_PORT_VARS } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
import { artifactFixture } from './fixtures/quantus-v4-artifact-fixture.mjs';

const DATE = '2026-10-02';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0', requiredSources: [{ id: 'quantus-core', kind: 'quantus-core' }], noExternalSources: true };
const config = { tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun' };
async function fixture() {
  const s = await setup(migrateCore({ entities: { tasks: { t1: { id: 't1', status: 'todo' } } } }, { now: T }).data);
  let calls = 0;
  const make = (core = s.core, inner = { async next() {
    calls++;
    const d = s.store.snapshot(), run = d.dailyBriefing.assistantRuns[DATE];
    assert.ok(run.slotReceipts.process09);
    assert.ok(run.startNoteId);
    assert.ok(run.itemRefs.some(r => r.sourceType === 'task' && r.sourceId === 't1'));
    return { done: false, stepId: `inner-${calls}`, cursor: { n: calls } };
  } }) => createBriefingSectionWork({ core, clock: s.clock, policy, config, inner }).impl;
  return { ...s, make, work: make(), args: { runKey: RUN, sectionId: 'section-1', verifiedScope: s.scope }, get calls() { return calls; } };
}

test('real core envelope bootstraps absent daily run, start note and inventory before inner work, once', async () => {
  const s = await fixture();
  assert.equal(s.store.snapshot().dailyBriefing.assistantRuns[DATE], undefined);
  const originals = structuredClone(s.store.snapshot().entities.tasks);
  await s.work.next(s.args);
  assert.equal(s.calls, 1);
  assert.deepEqual(s.store.snapshot().entities.tasks, originals);
  assert.equal(s.store.snapshot().dailyBriefing.assistantRuns[DATE].phase, 'active');
  const puts = s.store.stats.puts;
  await s.make().next(s.args);
  assert.equal(s.store.stats.puts, puts, 'reconstructed worker does not duplicate writes');
  assert.equal(s.calls, 2);
  assert.ok(JSON.stringify(s.store.snapshot().automation.idempotencyByKey).length < 10000);
});

test('continuation uses its new verified lease and refreshes newly arrived originals without another start note', async () => {
  const s = await fixture();
  await s.work.next(s.args);
  const cursor = { n: 1, fence: s.scope.fence };
  await s.core.mutate({ commandKey: 'test-checkpoint', requestId: 'test-checkpoint', now: T,
    mutate: d => E1.checkpointRunSection(d, { runKey: RUN, sectionId: 'section-1', continuationId: 'cont-1',
      checkpointId: 'checkpoint-1', cursor, reason: 'section_deadline', now: T, verifiedScope: s.scope }) });
  s.store.forceWrite(d => { d.entities.chatgptNotes.arrived = { id: 'arrived', instruction: 'New instruction' }; return d; });
  await s.core.mutate({ commandKey: 'test-release', requestId: 'test-release', now: T,
    mutate: d => E1.releaseLease(d, { ...s.scope, now: T }) });
  const acquired = await s.core.mutate({ commandKey: 'test-acquire', requestId: 'test-acquire', now: T,
    mutate: d => E1.acquireLease(d, { holder: 'worker-b', scope: config.leaseScope, now: T }) });
  const nextScope = { holder: 'worker-b', scope: config.leaseScope, fence: acquired.result.fence };
  await s.core.mutate({ commandKey: 'test-resume', requestId: 'test-resume', now: T,
    mutate: d => E1.startRunSection(d, { runKey: RUN, sectionId: 'section-2', kind: 'http', resumeFrom: 'cont-1', now: T, verifiedScope: nextScope }) });
  const resumed = { ...s.args, sectionId: 'section-2', resumedFrom: 'cont-1', verifiedScope: nextScope, cursor };
  await assert.rejects(s.work.next({ ...resumed, cursor: { ...cursor, n: 999 } }), /briefing_checkpoint_mismatch/);
  await s.make(s.core, { async next(args) {
    assert.equal(args.cursor.fence, nextScope.fence);
    assert.equal(args.cursor.n, 1);
    return { done: true };
  } }).next(resumed);
  assert.equal(cursor.fence, s.scope.fence, 'caller and stored checkpoint remain unchanged');
  const run = s.store.snapshot().dailyBriefing.assistantRuns[DATE];
  assert.ok(run.itemRefs.some(r => r.sourceId === 'arrived'));
  assert.equal(Object.values(s.store.snapshot().entities.chatgptNotes).filter(n => n.assistantNote?.kind === 'assistantStart').length, 1);
});

test('foreign tenant, policy, holder, closed section and expired authority cannot execute inner work', async () => {
  for (const mode of ['tenant', 'policy', 'holder', 'section', 'expired']) {
    const s = await fixture();
    const args = structuredClone(s.args);
    if (mode === 'tenant') args.runKey = RUN.replace('quantus:', 'other:');
    if (mode === 'policy') args.runKey = RUN.replace(':4.0', ':5.0');
    if (mode === 'holder') args.verifiedScope.holder = 'foreign';
    if (mode === 'section') s.store.forceWrite(d => { d.automation.runtime.runsByKey[RUN].sections['section-1'].closed = true; return d; });
    if (mode === 'expired') s.setNow(T + 121000);
    const puts = s.store.stats.puts;
    await assert.rejects(s.work.next(args));
    assert.equal(s.calls, 0);
    assert.equal(s.store.stats.puts, puts);
  }
});

test('a false acknowledged write cannot start source work', async () => {
  const s = await fixture();
  const lying = { read: s.core.read, async mutate(args) {
    const before = s.store.snapshot();
    const out = await s.core.mutate(args);
    if (s.store.snapshot().entities.chatgptNotes && Object.keys(s.store.snapshot().entities.chatgptNotes).length)
      s.store.forceWrite(() => before);
    return out;
  } };
  await assert.rejects(s.make(lying).next(s.args), /briefing_bootstrap_readback_failed/);
  assert.equal(s.calls, 0);
});

test('deleted start note or marker corruption after success stays visible and blocks further work', async () => {
  for (const mode of ['note', 'marker']) {
    const s = await fixture();
    await s.work.next(s.args);
    s.store.forceWrite(d => {
      if (mode === 'note') delete d.entities.chatgptNotes[d.dailyBriefing.assistantRuns[DATE].startNoteId];
      else d.automation.runtime.runsByKey[RUN].sections['section-1'].briefingBootstrap = 'corrupt';
      return d;
    });
    await assert.rejects(s.make().next(s.args), /briefing_bootstrap_/);
    assert.equal(s.calls, 1);
  }
});

test('CAS retry preserves concurrent user work and rechecks lease expiry before any source call', async () => {
  const s = await fixture();
  s.onMutation(attempt => {
    if (attempt === 0) s.store.forceWrite(d => { d.userEdit = 'retained'; return d; });
    else s.setNow(T + 121000);
  });
  await assert.rejects(s.work.next(s.args), /lease_expired/);
  assert.equal(s.store.snapshot().userEdit, 'retained');
  assert.equal(s.calls, 0);
});

test('an existing final or different-policy daily run is rejected before any write', async () => {
  for (const mode of ['final', 'policy']) {
    const s = await fixture();
    await s.work.next(s.args);
    s.store.forceWrite(d => {
      const run = d.dailyBriefing.assistantRuns[DATE];
      if (mode === 'final') run.phase = 'final';
      else run.policyVersion = 'other';
      return d;
    });
    const puts = s.store.stats.puts;
    await assert.rejects(s.work.next(s.args), /briefing_bootstrap_daily_run_conflict/);
    assert.equal(s.store.stats.puts, puts);
    assert.equal(s.calls, 1);
  }
});

test('conflicting slot receipt reports the actual domain rejection and cannot invoke sources', async () => {
  const s = await fixture();
  s.store.forceWrite(d => applyCommand(d, { type: 'ensureRunSlot', commandId: 'other-start', now: T,
    payload: { date: DATE, slot: 'process09', receiptId: 'other-receipt' } }, { policy, actor: { kind: 'system', id: 'other' } }).data);
  const puts = s.store.stats.puts;
  await assert.rejects(s.work.next(s.args), /briefing_bootstrap_SLOT_ALREADY_RECEIPTED/);
  assert.equal(s.store.stats.puts, puts);
  assert.equal(s.calls, 0);
});

test('actual HTTP worker plus production source composition bootstraps an empty daily run before Gmail access', async t => {
  const clock = F.createClock(T), key = F.createSigningKey();
  const core = F.createCorePort(F.createCasStore(migrateCore({ entities: {} }, { now: T }).data));
  const tasks = F.createTasksPort();
  const actualConfig = { ...config, tenant: F.TENANT, policyVersion: F.POLICY_VERSION,
    leaseScope: `${F.TENANT}:mainrun`, mode: 'dry_run', allowExternalEffects: false, gatesComplete: false };
  const actualPolicy = { ...policy, tenant: F.TENANT, version: F.POLICY_VERSION,
    noExternalSources: false, requiredSources: [...policy.requiredSources, { id: 'gmail', kind: 'mail' }] };
  const env = { [DOMAIN_PORT_VARS.policyJson]: JSON.stringify(actualPolicy),
    QUANTUS_V3_ANTHROPIC_API_KEY: 'test-only-no-provider-dispatch', QUANTUS_V3_ANTHROPIC_MODEL: 'configured-test-model',
    QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK: '1', QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK: '1' };
  let sources = 0;
  const ports = await createFSourcePorts({ config: actualConfig, corePort: core.port, clockPort: clock.port.impl,
    artifactStore: artifactFixture({ tenant: F.TENANT }).store,
    envRead: n => env[n], loadGmailToken: async () => async () => {
      const d = core.store.snapshot(), run = d.dailyBriefing.assistantRuns[DATE];
      assert.ok(run?.slotReceipts.process09, 'domain receipt exists before token lookup');
      assert.ok(d.entities.chatgptNotes[run.startNoteId], 'start note is persisted before source access');
      sources++;
      return { error: 'test_no_credentials' }; // No network or paid provider invocation.
    } });
  assert.equal(ports.sectionWork.available, true, ports.sectionWork.reason);
  const service = await F.startService({ role: 'worker', ports: { ...ports, clock: clock.port, jwks: F.jwksPort(key), core: core.port, tasks: tasks.port } });
  t.after(() => service.close());
  const token = () => F.schedulerToken(key, { audience: F.AUD.slotStart, email: F.SA.schedulerStart, nowMs: clock.value });
  const first = await service.post('/v3/slot/start', { token: token(), body: { slot: 'process09' } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.green, false);
  assert.equal(sources, 1);
  const replay = await service.post('/v3/slot/start', { token: token(), body: { slot: 'process09' } });
  assert.equal(replay.json.outcome, 'duplicate');
  assert.equal(sources, 1);
  assert.equal(core.store.snapshot().dailyBriefing.assistantRuns[DATE].sourceChecks.gmail.outcome, 'auth_error');
});
