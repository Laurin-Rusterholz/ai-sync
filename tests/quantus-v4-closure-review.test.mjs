import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, migrateCore, POLICY_TEMPLATE } from '../netlify/lib/assistant-core.mjs';
import { finishRun } from '../netlify/lib/quantus-v3-runtime-state.mjs';
import { createClosureReviewPort } from '../runtime/quantus-v3/src/closure-review.mjs';
import { DOMAIN_PORT_VARS } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import { setup } from './fixtures/quantus-v4-leadership-fixture.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
const NOW = Date.parse('2026-10-02T21:01:00Z'), DATE = '2026-10-02', RUN = 'quantus:2026-10-02:close23:4.0';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const config = { tenant: 'quantus', policyVersion: '4.0', mode: 'live', allowExternalEffects: true, gatesComplete: true };
function command(data, type, payload, now = NOW) {
  const r = applyCommand(data, { type, payload, commandId: type, now }, { policy, actor: { kind: 'system', id: 'fixture' } });
  assert.equal(r.ok, true, JSON.stringify(r.detail || r.error)); return r.data;
}
async function build({ contradict = true, dates = [DATE] } = {}) {
  let data = migrateCore({ entities: { projects: { p1: { id: 'p1', status: 'active',
    deadlines: [{ id: 'd1', date: DATE, done: true }] } } } }, { now: NOW }).data;
  for (const date of dates) {
    const at = Date.parse(date + 'T21:01:00Z');
    for (const slot of ['briefing04', 'process09', 'continue14', 'close23'])
      data = command(data, 'ensureRunSlot', { date, slot, receiptId: 'receipt-' + date + '-' + slot }, at);
    data = command(data, 'ensureStartNote', { date, noteId: 'start-' + date, content: 'Test start' }, at);
    data = command(data, 'closeRunAfterCoreRead', { date, finalNoteId: date === DATE ? 'final' : 'final-' + date }, at);
  }
  const f = await setup(data, { initialNow: NOW, runKey: RUN });
  await f.core.mutate({ commandKey: 'finish', requestId: 'finish', now: NOW,
    mutate: d => finishRun(d, { runKey: RUN, outcome: 'completed', evidenceRef: 'synthetic-domain-proof', runnerMode: 'live', now: NOW, verifiedScope: f.scope }) });
  f.setNow(NOW + 1000);
  if (contradict) f.store.forceWrite(d => { d.entities.projects.p1.deadlines[0].done = false; d.automation.dataRevision++; return d; });
  const args = { core: f.core, clock: f.clock, config, envRead: name => name === DOMAIN_PORT_VARS.policyJson ? JSON.stringify(policy) : undefined };
  return { ...f, args, make: options => createClosureReviewPort({ ...args, ...options }).impl };
}
test('monitor correction is atomic, preserves the final note and revokes runtime green; replay never duplicates it', async () => {
  const f = await build(), before = f.store.snapshot();
  const result = await f.make().review(), after = f.store.snapshot();
  assert.deepEqual(result, { corrected: 1, pending: 0 });
  assert.equal(after.automation.dataRevision, before.automation.dataRevision + 1);
  assert.deepEqual(after.entities.chatgptNotes.final, before.entities.chatgptNotes.final);
  assert.deepEqual(after.automation.activeLease, before.automation.activeLease);
  const daily = after.dailyBriefing.assistantRuns[DATE];
  assert.equal(daily.phase, 'exception_open'); assert.equal(daily.corrections.length, 1);
  assert.ok(after.entities.chatgptNotes[daily.corrections[0].id]);
  assert.equal(after.automation.runtime.runsByKey[RUN].green, false);
  const puts = f.store.stats.puts;
  assert.deepEqual(await f.make().review(), { corrected: 0, pending: 0 }); assert.equal(f.store.stats.puts, puts);
});
test('new intake after cutoff remains open for the next run without invalidating history', async () => {
  const f = await build({ contradict: false });
  f.store.forceWrite(d => command(d, 'registerIntake', { intakeId: 'later', text: 'New work', channel: 'test',
    receivedAt: new Date(NOW + 1000).toISOString() }, NOW + 1000));
  assert.deepEqual(await f.make().review(), { corrected: 0, pending: 0 });
  assert.equal(f.store.snapshot().automation.intakeById.later.status, 'open');
  assert.equal(f.store.snapshot().dailyBriefing.assistantRuns[DATE].phase, 'final');
});
test('concurrent monitor deliveries share one correction and report only one new write', async () => {
  const f = await build();
  const results = await Promise.all([f.make().review(), f.make().review()]);
  assert.equal(results.reduce((sum, r) => sum + r.corrected, 0), 1);
  assert.equal(f.store.snapshot().dailyBriefing.assistantRuns[DATE].corrections.length, 1);
});
test('one monitor delivery corrects multiple contradicted dates with separate atomic records', async () => {
  const f = await build({ dates: ['2026-10-01', DATE] }), before = f.store.snapshot();
  assert.deepEqual(await f.make().review(), { corrected: 2, pending: 0 });
  const after = f.store.snapshot();
  assert.equal(after.automation.dataRevision, before.automation.dataRevision + 2);
  for (const date of ['2026-10-01', DATE]) assert.equal(after.dailyBriefing.assistantRuns[date].phase, 'exception_open');
  assert.deepEqual(after.entities.chatgptNotes.final, before.entities.chatgptNotes.final);
  assert.deepEqual(after.entities.chatgptNotes['final-2026-10-01'], before.entities.chatgptNotes['final-2026-10-01']);
});
test('lost acknowledgement recovers the correction, while missing correction notes or markers fail replay', async () => {
  const f = await build(), core = { ...f.core, async mutate(args) { await f.core.mutate(args); throw new Error('ack_lost'); } };
  await assert.rejects(f.make({ core }).review(), /ack_lost/);
  assert.equal((await f.make().review()).corrected, 0);
  const snapshot = f.store.snapshot(), marker = snapshot.automation.runtime.monitor.closureReviews[DATE];
  f.store.forceWrite(d => { delete d.entities.chatgptNotes[marker.correctionId]; return d; });
  await assert.rejects(f.make().review(), /correction_readback_failed/);
  f.store.forceWrite(() => snapshot);
  f.store.forceWrite(d => { delete d.automation.runtime.monitor.closureReviews[DATE]; return d; });
  await assert.rejects(f.make().review(), /correction_marker_missing/);
});
test('CAS rechecks the contradiction and preserves unrelated concurrent user edits', async () => {
  for (const resolved of [false, true]) {
    const f = await build(); let once = true;
    f.onMutation(() => { if (!once) return; once = false; f.store.forceWrite(d => {
      if (resolved) d.entities.projects.p1.deadlines[0].done = true;
      else d.entities.projects.p1.title = 'Concurrent user edit';
      d.automation.dataRevision++; return d;
    }); });
    if (resolved) { await assert.rejects(f.make().review(), /contradiction_changed/);
      assert.equal(f.store.snapshot().dailyBriefing.assistantRuns[DATE].phase, 'final'); }
    else { await f.make().review(); assert.equal(f.store.snapshot().entities.projects.p1.title, 'Concurrent user edit'); }
  }
});
test('dry-run does not correct a day and missing or mismatched policy is unavailable', async () => {
  const f = await build(), puts = f.store.stats.puts;
  assert.deepEqual(await f.make({ config: { ...config, mode: 'dry_run' } }).review(), { corrected: 0, pending: 1 });
  assert.equal(f.store.stats.puts, puts);
  assert.equal(createClosureReviewPort({ ...f.args, envRead: () => undefined }).available, false);
  assert.equal(createClosureReviewPort({ ...f.args, config: { ...config, tenant: 'foreign' } }).available, false);
});
test('the actual authenticated monitor tick invokes real closure correction before its scheduling plan', async t => {
  const f = await build(), key = F.createSigningKey(), tasks = F.createTasksPort();
  const s = await F.startService({ role: 'monitor', ports: { clock: F.availablePort('clock', f.clock), jwks: F.jwksPort(key),
    core: F.availablePort('core', f.core), tasks: tasks.port, closureReview: createClosureReviewPort(f.args) },
    configOverrides: { QUANTUS_V3_POLICY_VERSION: '4.0', QUANTUS_V3_RUNTIME_MODE: 'live',
      QUANTUS_V3_REQUIRED_SOURCES: '["core"]', QUANTUS_V3_MONITOR_START_LOCAL_DATE: DATE,
      QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: 'true', QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed() } });
  t.after(() => s.close());
  const post = () => s.post('/v3/monitor/tick', { token: F.schedulerToken(key, {
    audience: F.AUD.monitorTick, email: F.SA.schedulerMonitor, nowMs: f.clock.now() }) });
  const first = await post(); assert.equal(first.status, 200, first.text); assert.equal(first.json.closureCorrections, 1);
  assert.equal(f.store.snapshot().dailyBriefing.assistantRuns[DATE].phase, 'exception_open');
  const second = await post(); assert.equal(second.status, 200, second.text); assert.equal(second.json.closureCorrections, 0);
});
