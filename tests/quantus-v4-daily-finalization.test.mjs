import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDailyFinalization } from '../runtime/quantus-v3/src/daily-finalization.mjs';
import { createBriefingSectionWork } from '../runtime/quantus-v3/src/briefing-bootstrap.mjs';
import { applyCommand, POLICY_TEMPLATE, migrateCore } from '../netlify/lib/assistant-core.mjs';
import { setup } from './fixtures/quantus-v4-leadership-fixture.mjs';
import * as E1 from '../netlify/lib/quantus-v3-runtime-state.mjs';
const NOW = Date.parse('2026-10-02T21:01:00Z'), DATE = '2026-10-02', RUN = 'quantus:2026-10-02:close23:4.0';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function build({ open = false, external = false } = {}) {
  let data = migrateCore({ entities: { chatgptLeads: open ? { l1: { id: 'l1', status: 'neu', assignee: 'chatgpt' } } : {} } }, { now: NOW }).data;
  const p = external ? { ...policy, requiredSources: [...policy.requiredSources, { id: 'mail', kind: 'mail' }], noExternalSources: false } : policy;
  for (const slot of ['briefing04', 'process09', 'continue14']) {
    const r = applyCommand(data, { type: 'ensureRunSlot', commandId: slot, now: NOW,
      payload: { date: DATE, slot, receiptId: 'receipt-' + slot } }, { policy: p, actor: { kind: 'system', id: 'fixture' } });
    assert.equal(r.ok, true); data = r.data;
  }
  const f = await setup(data, { initialNow: NOW, runKey: RUN });
  const config = { core: f.core, clock: f.clock, policy: p, tenant: 'quantus', runKey: RUN,
    sectionId: 'section-1', verifiedScope: f.scope, enabled: true };
  const args = { runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope };
  const bootstrap = inner => createBriefingSectionWork({ core: f.core, clock: f.clock, policy: p,
    config: { tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun' }, inner }).impl;
  await bootstrap({ async next() { return { done: false }; } }).next(args);
  await f.core.mutate({ commandKey: 'fixture-coverage', requestId: 'fixture-coverage', now: NOW, mutate(d) {
    const proof = { runId: 'run_' + DATE, dataRevision: d.automation.dataRevision, checkedAt: new Date(NOW).toISOString(),
      policyHash: 'a'.repeat(64), worksetHash: 'b'.repeat(64), itemCount: 0, callId: 'synthetic-backend-proof' };
    d.automation.runtime.runsByKey[RUN].contextCoverage = { proof, hash: hash(proof), checkpointRevision: d.automation.dataRevision + 1 };
    return { data: d, result: {} };
  } });
  return { ...f, config, args, bootstrap, make: options => createDailyFinalization({ ...config, ...options }) };
}
test('backend atomically closes the whole day with a core check and one bound final note, then replays without another write', async () => {
  const f = await build(), before = f.store.snapshot(), puts = f.store.stats.puts;
  assert.equal((await f.make().next()).finalized, true);
  const after = f.store.snapshot(), daily = after.dailyBriefing.assistantRuns[DATE];
  assert.equal(daily.phase, 'final'); assert.equal(f.store.stats.puts, puts + 1);
  assert.equal(daily.closureRevision, before.automation.dataRevision + 1);
  assert.equal(daily.sourceChecks.core.checkedBy, 'quantus-v4-daily-finalization');
  assert.ok(after.entities.chatgptNotes[daily.finalNoteId]);
  assert.equal((await f.make().next()).finalized, true); assert.equal(f.store.stats.puts, puts + 1);
});
test('open work and missing external checks block finalization without committing the tentative core refresh', async () => {
  for (const options of [{ open: true }, { external: true }]) {
    const f = await build(options), before = f.store.snapshot();
    const result = await f.make().next();
    assert.equal(result.blocked, true); assert.equal(result.reason, 'daily_closure_blocked');
    assert.deepEqual(f.store.snapshot().dailyBriefing, before.dailyBriefing);
    assert.equal(f.store.snapshot().automation.dataRevision, before.automation.dataRevision);
  }
});
test('lost acknowledgement resumes through the actual bootstrap and never reopens or creates a second final note', async () => {
  const f = await build();
  const core = { ...f.core, async mutate(input) { await f.core.mutate(input); throw new Error('ack_lost'); } };
  await assert.rejects(f.make({ core }).next(), /ack_lost/);
  const puts = f.store.stats.puts;
  await assert.rejects(f.bootstrap({ async next() { throw new Error('must not execute'); } }).next(f.args), /final_verifier_missing/);
  assert.equal((await f.bootstrap({ next: () => f.make().next(), resumeFinalized: () => f.make().next() }).next(f.args)).finalized, true);
  assert.equal(f.store.stats.puts, puts);
});
test('concurrent user changes invalidate coverage in CAS without losing those edits', async () => {
  const f = await build(); let once = true;
  f.onMutation(() => { if (!once) return; once = false; f.store.forceWrite(d => {
    d.automation.dataRevision++; d.entities.tasks.newTask = { id: 'newTask', status: 'todo' }; return d;
  }); });
  await assert.rejects(f.make().next(), /context_changed/);
  assert.ok(f.store.snapshot().entities.tasks.newTask);
  assert.notEqual(f.store.snapshot().dailyBriefing.assistantRuns[DATE].phase, 'final');
});
test('missing note or changed final state fails independent readback and replay', async () => {
  const f = await build();
  const core = { ...f.core, async mutate(input) { const r = await f.core.mutate(input);
    f.store.forceWrite(d => { delete d.entities.chatgptNotes[r.result.marker.noteId]; return d; }); return r; } };
  await assert.rejects(f.make({ core }).next(), /readback_failed/);
  await assert.rejects(f.make().next(), /readback_failed/);
});
test('invalid proof, expired authority and disabled effects cannot create a final day', async () => {
  for (const mode of ['proof', 'lease', 'disabled', 'future']) {
    const f = await build();
    if (mode === 'lease') f.setNow(NOW + 120001);
    if (mode === 'proof' || mode === 'future') f.store.forceWrite(d => {
      const c = d.automation.runtime.runsByKey[RUN].contextCoverage;
      if (mode === 'proof') c.proof.worksetHash = 'forged';
      else { c.proof.checkedAt = new Date(NOW + 1).toISOString(); c.hash = hash(c.proof); }
      return d;
    });
    if (mode === 'disabled') assert.equal((await f.make({ enabled: false }).next()).blocked, true);
    else await assert.rejects(f.make().next());
    assert.notEqual(f.store.snapshot().dailyBriefing.assistantRuns[DATE].phase, 'final');
  }
});

test('a finalization survives a real fenced continuation, but a changed domain original never replays as finalized', async () => {
  const f = await build(); await f.make().next();
  const cursor = { fence: f.scope.fence, position: 'after-final-write' };
  await f.core.mutate({ commandKey: 'checkpoint', requestId: 'checkpoint', now: NOW,
    mutate: d => E1.checkpointRunSection(d, { runKey: RUN, sectionId: 'section-1', continuationId: 'cont-1',
      checkpointId: 'cp-1', cursor, reason: 'section_deadline', now: NOW, verifiedScope: f.scope }) });
  await f.core.mutate({ commandKey: 'release', requestId: 'release', now: NOW,
    mutate: d => E1.releaseLease(d, { ...f.scope, now: NOW }) });
  const acquired = await f.core.mutate({ commandKey: 'acquire', requestId: 'acquire', now: NOW,
    mutate: d => E1.acquireLease(d, { holder: 'worker-b', scope: 'quantus:mainrun', now: NOW }) });
  const scope = { holder: 'worker-b', scope: 'quantus:mainrun', fence: acquired.result.fence };
  await f.core.mutate({ commandKey: 'resume', requestId: 'resume', now: NOW,
    mutate: d => E1.startRunSection(d, { runKey: RUN, sectionId: 'section-2', kind: 'http', resumeFrom: 'cont-1', now: NOW, verifiedScope: scope }) });
  const next = () => f.make({ sectionId: 'section-2', verifiedScope: scope }).next();
  assert.equal((await f.bootstrap({ next, resumeFinalized: next }).next({ ...f.args, sectionId: 'section-2', verifiedScope: scope,
    resumedFrom: 'cont-1', cursor })).finalized, true);
  f.store.forceWrite(d => { d.entities.tasks.unseen = { id: 'unseen', status: 'todo' }; return d; });
  await assert.rejects(next(), /readback_failed/);
});

test('the source-refreshing closure command is backend-only', async () => {
  const f = await build();
  for (const kind of ['agent', 'user', 'adapter', 'worker']) {
    const r = applyCommand(f.store.snapshot(), { type: 'closeRunAfterCoreRead', commandId: 'forged', now: NOW,
      payload: { date: DATE, finalNoteId: 'forged' } }, { policy, actor: { kind, id: 'caller' } });
    assert.equal(r.ok, false);
  }
});
