import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailWorkerPreparation } from '../runtime/quantus-v3/src/gmail-worker-preparation.mjs';
import { createGmailV4Reader } from '../runtime/quantus-v3/src/gmail-v4-reader.mjs';
import { createBriefingSectionWork } from '../runtime/quantus-v3/src/briefing-bootstrap.mjs';
import { migrateCore, POLICY_TEMPLATE } from '../netlify/lib/assistant-core.mjs';
import { setup, RUN, T } from './fixtures/quantus-v4-leadership-fixture.mjs';
const account = 'mail@example.test', date = '2026-10-02';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'core', kind: 'quantus-core' }, { id: 'gmail-inbox', kind: 'gmail' }], noExternalSources: false };
async function build({ count = 3, missing = false, partial = false } = {}) {
  const f = await setup(migrateCore({ entities: { tasks: { t1: { id: 't1', status: 'todo' } } } }, { now: T }).data);
  const calls = [];
  const reader = createGmailV4Reader({ account, getAccessToken: async () => ({ token: 'synthetic-access' }),
    fetchImpl: async url => {
      url = new URL(url); calls.push(url.pathname);
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: account, historyId: '100' });
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: Array.from({ length: count }, (_, n) => ({ id: `mail${n}`, threadId: 'thread1' })) });
      if (url.pathname.endsWith('/history')) return Response.json({ historyId: '200' });
      if (missing) return new Response('', { status: 404 });
      const id = url.pathname.split('/').at(-1);
      return Response.json({ id, threadId: 'thread1', historyId: '150', internalDate: String(T - 10000),
        payload: { mimeType: 'text/plain', filename: partial ? 'attachment.txt' : '', headers: [],
          body: { data: Buffer.from('original ' + id).toString('base64url'), size: Buffer.byteLength('original ' + id) } } });
    } });
  const config = { core: f.core, clock: f.clock, artifacts: f.artifacts.store, tenant: 'quantus', account,
    sourceId: 'gmail-inbox', runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope, reader, policy };
  await createBriefingSectionWork({ ...config, config: { tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun' },
    inner: { async next() { return {}; } } }).impl.next(config);
  const make = overrides => createGmailWorkerPreparation({ ...config, ...overrides });
  return { ...f, config, calls, make };
}
async function finish(f, overrides) {
  const steps = [];
  for (let n = 0; n < 100; n++) {
    const result = await f.make(overrides).next();
    if (result.ready) return { result, steps };
    assert.ok(result.stepId); assert.ok(!steps.includes(result.stepId)); steps.push(result.stepId);
  }
  assert.fail('preparation did not finish');
}
test('real Gmail acquisition and all intake bindings complete before a persisted source check, across fresh instances', async () => {
  const f = await build({ count: 20 });
  const { result, steps } = await finish(f);
  assert.equal(result.outcome, 'ok'); assert.ok(steps.length > 1); assert.ok(steps.length < 10);
  const data = f.store.snapshot(), entries = Object.values(data.automation.intakeById);
  assert.equal(entries.length, 20); assert.ok(entries.every(e => e.status === 'open' && e.externalSource));
  const check = data.dailyBriefing.assistantRuns[date].sourceChecks['gmail-inbox'];
  assert.equal(check.outcome, 'ok'); assert.ok(check.cursor.startsWith('gmail-v4:'));
  assert.equal(data.automation.runtime.runsByKey[RUN].gmailPreparation.originalCount, 20);
  const puts = f.store.stats.puts, calls = f.calls.length;
  await finish(f); assert.equal(f.store.stats.puts, puts); assert.equal(f.calls.length, calls);
});
test('a genuinely empty mailbox is distinct from a missing-message gap', async () => {
  for (const missing of [false, true]) {
    const f = await build({ count: missing ? 1 : 0, missing });
    const { result } = await finish(f);
    assert.equal(result.outcome, missing ? 'partial' : 'ok');
    assert.equal(Object.keys(f.store.snapshot().automation.intakeById).length, 0);
    assert.equal(f.store.snapshot().dailyBriefing.assistantRuns[date].sourceChecks['gmail-inbox'].outcome, result.outcome);
  }
});
test('lost final acknowledgement recovers without duplicating intakes or source-check revisions', async () => {
  const f = await build(); let lost = false;
  const core = { ...f.core, async mutate(args) {
    const r = await f.core.mutate(args);
    if (args.commandKey.startsWith('v4-gmail-prepared-') && !lost) { lost = true; throw new Error('lost_ack'); }
    return r;
  } };
  await assert.rejects(finish(f, { core }), /lost_ack/);
  const puts = f.store.stats.puts;
  await finish(f); assert.equal(f.store.stats.puts, puts);
  assert.equal(Object.keys(f.store.snapshot().automation.intakeById).length, 3);
});
test('an unread attachment remains a partial bound source, never a successful full-source check', async () => {
  const f = await build({ count: 1, partial: true });
  assert.equal((await finish(f)).result.outcome, 'partial');
  const entry = Object.values(f.store.snapshot().automation.intakeById)[0];
  assert.equal(entry.externalSource.record.partial, true);
  assert.equal(entry.status, 'open');
});
test('a concurrent domain edit survives source-check CAS and no I/O repeats within retry', async () => {
  const f = await build(); let changed = false, io;
  const core = { ...f.core, async mutate(args) {
    if (args.commandKey.startsWith('v4-gmail-prepared-')) f.onMutation(() => {
      io ??= f.artifacts.calls.length; assert.equal(f.artifacts.calls.length, io);
      if (!changed) { changed = true; f.store.forceWrite(d => { d.entities.tasks.t1.title = 'user edit'; return d; }); }
    });
    return f.core.mutate(args);
  } };
  await finish(f, { core }); assert.equal(changed, true);
  assert.equal(f.store.snapshot().entities.tasks.t1.title, 'user edit');
});
test('changed source check, corrupt intake and expired lease never pass a ready marker', async () => {
  for (const mode of ['source_check', 'intake', 'lease', 'marker']) {
    const f = await build(); await finish(f);
    if (mode === 'lease') f.setNow(T + 120001);
    else f.store.forceWrite(d => {
      if (mode === 'source_check') d.dailyBriefing.assistantRuns[date].sourceChecks['gmail-inbox'].outcome = 'partial';
      else if (mode === 'marker') d.automation.runtime.runsByKey[RUN].gmailPreparation.originalCount++;
      else Object.values(d.automation.intakeById)[0].externalSource.record.version++;
      return d;
    });
    await assert.rejects(f.make().next());
  }
});
test('time slice stops after persisted progress and the next instance resumes', async () => {
  const f = await build();
  const first = await f.make().next({ deadlineAtMs: T + 10000 });
  assert.equal(first.ready, false); assert.equal(first.cursor.progress[0], 'sync');
  assert.equal(f.calls.length, 0);
  await finish(f); assert.equal(Object.keys(f.store.snapshot().automation.intakeById).length, 3);
});
