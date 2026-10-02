import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableSectionWork, WORK_CURSOR_SCHEMA } from '../runtime/quantus-v3/src/durable-section-work.mjs';
import { WORK_PAYLOAD_BYTES, JOURNAL_LIMITS } from '../runtime/quantus-v3/src/leadership-journal.mjs';
import * as E1 from '../netlify/lib/quantus-v3-runtime-state.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';
import { artifactFixture } from './fixtures/quantus-v4-artifact-fixture.mjs';

async function fixture(inner) {
  const s = await setup();
  const artifacts = artifactFixture();
  const make = (provider = inner, core = s.core) => createDurableSectionWork({
    core, clock: s.clock, inner: provider, artifacts: artifacts.store, leaseScope: s.scope.scope, pipelineId: 'test-pipeline-v1' }).impl;
  return { ...s, artifacts, make, work: make(), args: { runKey: RUN, sectionId: 'section-1', verifiedScope: s.scope, cursor: null } };
}
async function resume(s, cursor) {
  await s.core.mutate({ commandKey: 'checkpoint', requestId: 'checkpoint', now: T,
    mutate: d => E1.checkpointRunSection(d, { runKey: RUN, sectionId: 'section-1', continuationId: 'cont-1',
      checkpointId: 'cp-1', cursor, reason: 'section_deadline', now: T, verifiedScope: s.scope }) });
  await s.core.mutate({ commandKey: 'release', requestId: 'release', now: T, mutate: d => E1.releaseLease(d, { ...s.scope, now: T }) });
  const acquired = await s.core.mutate({ commandKey: 'acquire', requestId: 'acquire', now: T,
    mutate: d => E1.acquireLease(d, { holder: 'worker-b', scope: s.scope.scope, now: T }) });
  const scope = { holder: 'worker-b', scope: s.scope.scope, fence: acquired.result.fence };
  const started = await s.core.mutate({ commandKey: 'resume', requestId: 'resume', now: T,
    mutate: d => E1.startRunSection(d, { runKey: RUN, sectionId: 'section-2', kind: 'http', resumeFrom: 'cont-1', now: T, verifiedScope: scope }) });
  assert.equal(started.result.ok, true);
  return { runKey: RUN, sectionId: 'section-2', resumedFrom: 'cont-1', cursor, verifiedScope: scope };
}

test('large message payload survives the actual 8 KiB checkpoint and new lease without truncation', async () => {
  const text = 'Nachricht äöü '.repeat(12000);
  let calls = 0;
  const s = await fixture({ async next({ cursor, verifiedScope }) {
    calls++;
    if (!cursor) return { done: false, stepId: 'source-page-1', cursor: { phase: 'review', text, fence: verifiedScope.fence } };
    assert.equal(cursor.text, text);
    assert.equal(cursor.fence, verifiedScope.fence);
    return { done: true, stepId: 'review-done' };
  } });
  const first = await s.work.next(s.args);
  assert.equal(first.cursor.schema, WORK_CURSOR_SCHEMA);
  assert.ok(Buffer.byteLength(JSON.stringify(first.cursor)) < 500);
  const blob = structuredClone(s.store.snapshot().automation.runtime.runsByKey[RUN].sectionWork.blobs[first.cursor.blobId]);
  assert.ok(!JSON.stringify(s.store.snapshot()).includes(text.slice(0, 1000)), 'mail text never enters the core');
  assert.ok(s.artifacts.objects.get(blob.objectName).text.includes(text));
  const resumed = await resume(s, first.cursor);
  assert.equal((await s.make().next(resumed)).done, true);
  assert.equal(calls, 2);
  assert.deepEqual(s.store.snapshot().automation.runtime.runsByKey[RUN].sectionWork.blobs[first.cursor.blobId], blob);
  assert.ok(JSON.stringify(s.store.snapshot().automation.idempotencyByKey).length < 18000, 'large text is not duplicated into idempotency receipts');
});

test('acknowledged result replays after process reconstruction without another source/provider call', async () => {
  let calls = 0;
  const inner = { async next() { calls++; return { done: false, stepId: 'page-1', cursor: { phase: 'next', text: 'original' } }; } };
  const s = await fixture(inner);
  const first = await s.work.next(s.args), puts = s.store.stats.puts;
  assert.deepEqual(await s.make().next(s.args), first);
  assert.equal(calls, 1);
  assert.equal(s.store.stats.puts, puts);
});

test('failure after durable claim remains unknown and is never repeated automatically', async () => {
  let calls = 0;
  const s = await fixture({ async next() { calls++; throw new Error('provider_connection_lost'); } });
  await assert.rejects(s.work.next(s.args), /provider_connection_lost/);
  await assert.rejects(s.make().next(s.args), /work_outcome_unknown/);
  assert.equal(calls, 1);
});

test('parallel delivery cannot dispatch twice even before the first result is persisted', async () => {
  let release, started, calls = 0;
  const entered = new Promise(r => { started = r; }), hold = new Promise(r => { release = r; });
  const s = await fixture({ async next() { calls++; started(); await hold; return { done: true }; } });
  const first = s.work.next(s.args);
  await entered;
  await assert.rejects(s.make().next(s.args), /work_outcome_unknown|work_claim_unconfirmed/);
  release(); await first;
  assert.equal(calls, 1);
});

test('missing, corrupted and cross-run payloads do not get reconstructed or sent to the inner worker', async () => {
  for (const mode of ['missing', 'corrupt', 'run', 'fence', 'removed-area']) {
    let calls = 0;
    const s = await fixture({ async next() { calls++; return { done: false, stepId: 'page-1', cursor: { phase: 'next', text: 'original' } }; } });
    const result = await s.work.next(s.args), cursor = structuredClone(result.cursor);
    if (mode === 'run') cursor.runKey = RUN.replace('quantus:', 'foreign:');
    else if (mode === 'fence') cursor.fence = 999;
    else s.store.forceWrite(d => {
      const run = d.automation.runtime.runsByKey[RUN];
      if (mode === 'missing') delete run.sectionWork.blobs[cursor.blobId];
      if (mode === 'corrupt') run.sectionWork.blobs[cursor.blobId].text = '{}';
      if (mode === 'removed-area') delete run.sectionWork;
      return d;
    });
    await assert.rejects(s.make().next({ ...s.args, cursor }), /work_/);
    assert.equal(calls, 1);
  }
});

test('fresh scope and time are rechecked on CAS retry and on completed-result replay', async () => {
  let calls = 0;
  const s = await fixture({ async next() { calls++; return { done: true }; } });
  s.onMutation(attempt => {
    if (attempt === 0) s.store.forceWrite(d => { d.userEdit = 'kept'; return d; });
    else s.setNow(T + 121000);
  });
  await assert.rejects(s.work.next(s.args), /lease_expired/);
  assert.equal(calls, 0);
  assert.equal(s.store.snapshot().userEdit, 'kept');
  const fresh = await fixture({ async next() { calls++; return { done: true }; } });
  await fresh.work.next(fresh.args);
  fresh.setNow(T + 121000);
  await assert.rejects(fresh.make().next(fresh.args), /lease_expired/);
  assert.equal(calls, 1);
});

test('false claim acknowledgement blocks dispatch and false result acknowledgement cannot report success', async () => {
  for (const stage of ['claim', 'result']) {
    let calls = 0;
    const s = await fixture({ async next() { calls++; return { done: false, stepId: 'p1', cursor: { text: 'x' } }; } });
    const core = { read: s.core.read, async mutate(args) {
      const before = s.store.snapshot(), out = await s.core.mutate(args);
      if (args.commandKey.startsWith(`work-${stage}-`)) s.store.forceWrite(() => before);
      return out;
    } };
    await assert.rejects(s.make(undefined, core).next(s.args), /work_(claim|result)_readback_failed/);
    assert.equal(calls, stage === 'claim' ? 0 : 1);
  }
});

test('capacity is reserved before dispatch, oversized payloads stay unknown, no active content is trimmed', async () => {
  let calls = 0;
  const s = await fixture({ async next() { calls++; return { done: true }; } });
  s.store.forceWrite(d => { d.retained = 'x'.repeat(JOURNAL_LIMITS.coreBytes - 12000); return d; });
  await assert.rejects(s.work.next(s.args), /journal_core_capacity/);
  assert.equal(calls, 0);
  assert.equal(s.store.snapshot().retained.length, JOURNAL_LIMITS.coreBytes - 12000);
  const large = await fixture({ async next() { return { done: false, stepId: 'too-big', cursor: { text: 'x'.repeat(WORK_PAYLOAD_BYTES) } }; } });
  await assert.rejects(large.work.next(large.args), /journal_payload_too_large/);
  await assert.rejects(large.make().next(large.args), /work_outcome_unknown/);
});

test('an unrelated old payload cannot replace the checkpoint consumed by this section', async () => {
  let calls = 0;
  const s = await fixture({ async next({ cursor }) { calls++; return { done: false, stepId: `p-${calls}`, cursor: { n: (cursor?.n || 0) + 1 } }; } });
  const first = await s.work.next(s.args), second = await s.work.next({ ...s.args, cursor: first.cursor });
  const resumed = await resume(s, second.cursor);
  await assert.rejects(s.make().next({ ...resumed, cursor: first.cursor }), /work_checkpoint_mismatch/);
  assert.equal(calls, 2);
});

test('failed protected storage leaves the claimed step unknown without inventing a saved cursor or retrying effects', async () => {
  let calls = 0, s;
  s = await fixture({ async next() {
    calls++; s.artifacts.setPrivate(false);
    return { done: false, stepId: 'provider-result', cursor: { text: 'A result that must not disappear silently' } };
  } });
  await assert.rejects(s.work.next(s.args), /artifact_bucket_not_private/);
  const area = s.store.snapshot().automation.runtime.runsByKey[RUN].sectionWork;
  assert.deepEqual(area.blobs, {});
  assert.equal(Object.values(area.steps)[0].state, 'claimed');
  s.artifacts.setPrivate(true);
  await assert.rejects(s.make().next(s.args), /work_outcome_unknown/);
  assert.equal(calls, 1);
});
