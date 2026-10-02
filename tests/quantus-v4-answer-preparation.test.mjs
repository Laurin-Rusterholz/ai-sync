import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerPreparation } from '../runtime/quantus-v3/src/answer-preparation.mjs';
import { applyCommand, POLICY_TEMPLATE, migrateCore, collectRunInventory } from '../netlify/lib/assistant-core.mjs';
import { setup, RUN, T } from './fixtures/quantus-v4-leadership-fixture.mjs';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const system = { kind: 'system', id: 'setup' };
function command(data, type, payload, actor = system) {
  const result = applyCommand(data, { type, payload, commandId: 'test-' + type, now: T }, { policy, actor });
  assert.equal(result.ok, true, JSON.stringify(result.detail || result.error)); return result.data;
}
async function build() {
  let data = migrateCore({ entities: { chatgptLeads: { lead1: { id: 'lead1', title: 'Mail senden', status: 'neu', assignee: 'chatgpt' } },
    tasks: { t1: { id: 't1', status: 'todo' } } } }, { now: T }).data;
  data = command(data, 'askQuestion', { questionId: 'q1', sourceType: 'chatgptLead', sourceId: 'lead1', text: 'Mail senden?', options: ['Ja', 'Nein'] }, { kind: 'agent', id: 'agent' });
  data = command(data, 'recordAnswer', { answerId: 'a1', questionId: 'q1', text: 'Ja, bitte senden.' }, { kind: 'user', id: 'owner' });
  const f = await setup(data);
  const config = { core: f.core, clock: f.clock, policy, tenant: 'quantus', runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope, enabled: true };
  return { ...f, config, make: options => createAnswerPreparation({ ...config, ...options }) };
}
test('answer consumption and open work are one revision and retain the exact user event and source question', async () => {
  const f = await build(), before = f.store.snapshot();
  const result = await f.make().next(), after = f.store.snapshot();
  const answer = after.automation.answersById.a1, intake = after.automation.intakeById[result.cursor.intakeId];
  assert.equal(after.automation.dataRevision, before.automation.dataRevision + 1);
  assert.deepEqual({ ...answer, consumedAt: null, consumedBy: null, consumption: undefined },
    { ...before.automation.answersById.a1, consumption: undefined });
  assert.equal(answer.consumption.intakeId, intake.id); assert.equal(intake.status, 'open');
  assert.ok(intake.text.includes('Deine Antwort: Ja, bitte senden.'));
  assert.equal(intake.answerContext.sourceId, 'lead1');
  assert.deepEqual(after.entities, before.entities);
  assert.ok(collectRunInventory(after).some(r => r.sourceType === 'intake' && r.sourceId === intake.id));
});
test('fresh-instance replay does not consume twice or reopen a handled intake', async () => {
  const f = await build(), result = await f.make().next();
  f.store.forceWrite(d => { d.automation.intakeById[result.cursor.intakeId].status = 'done'; return d; });
  const puts = f.store.stats.puts;
  assert.equal((await f.make().next()).ready, true);
  assert.equal(f.store.stats.puts, puts); assert.equal(Object.keys(f.store.snapshot().automation.intakeById).length, 1);
});
test('lost acknowledgement recovers the atomically created work without another domain write', async () => {
  const f = await build(); let lost = true;
  const core = { ...f.core, async mutate(args) { const r = await f.core.mutate(args); if (lost) { lost = false; throw new Error('ack_lost'); } return r; } };
  await assert.rejects(f.make({ core }).next(), /ack_lost/);
  const puts = f.store.stats.puts;
  assert.equal((await f.make().next()).ready, true); assert.equal(f.store.stats.puts, puts);
});
test('CAS retries preserve user edits and reject changes to the immutable answer/question', async () => {
  for (const mode of ['user', 'answer', 'question']) {
    const f = await build(); let once = true;
    f.onMutation(() => { if (!once) return; once = false; f.store.forceWrite(d => {
      if (mode === 'user') d.entities.tasks.t1.title = 'User edit';
      if (mode === 'answer') d.automation.answersById.a1.text = 'changed';
      if (mode === 'question') d.automation.questionsById.q1.sourceId = 'other';
      return d;
    }); });
    if (mode === 'user') { await f.make().next(); assert.equal(f.store.snapshot().entities.tasks.t1.title, 'User edit'); }
    else { await assert.rejects(f.make().next(), /original_changed/); assert.equal(f.store.snapshot().automation.answersById.a1.consumedAt, null); }
  }
});
test('receipt without matching readback is rejected and missing consumed work cannot vanish on replay', async () => {
  const f = await build();
  const core = { ...f.core, async mutate(args) {
    const r = await f.core.mutate(args);
    f.store.forceWrite(d => { delete d.automation.intakeById[r.result.intakeId]; return d; }); return r;
  } };
  await assert.rejects(f.make({ core }).next(), /readback_failed/);
  await assert.rejects(f.make().next(), /consumed_work_missing/);
});
test('missing source, expired lease, revoked activation and foreign section cannot consume an answer', async () => {
  for (const mode of ['source', 'lease', 'disabled', 'section']) {
    const f = await build(), options = {};
    if (mode === 'source') f.store.forceWrite(d => { delete d.entities.chatgptLeads.lead1; return d; });
    if (mode === 'lease') f.setNow(T + 120001);
    if (mode === 'disabled') options.enabled = false;
    if (mode === 'section') options.sectionId = 'other';
    if (mode === 'disabled') assert.equal((await f.make(options).next()).blocked, true);
    else await assert.rejects(f.make(options).next());
    assert.equal(f.store.snapshot().automation.answersById.a1.consumedAt, null);
  }
});
test('the model/user cannot invoke backend transfer, and copied instructions cannot prove completed actions', async () => {
  const f = await build();
  for (const kind of ['agent', 'user', 'adapter', 'worker']) {
    const r = applyCommand(f.store.snapshot(), { type: 'consumeAnswerToIntake', commandId: 'forged', now: T,
      payload: { answerId: 'a1', intakeId: 'forged', consumer: 'forged' } }, { policy, actor: { kind, id: 'caller' } });
    assert.equal(r.ok, false);
  }
  const prepared = await f.make().next();
  f.store.forceWrite(d => { d.automation.intakeById[prepared.cursor.intakeId].status = 'done';
    d.entities.chatgptLeads.lead1.result = 'Unproven model completion claim'; return d; });
  const data = f.store.snapshot(), lead = data.entities.chatgptLeads.lead1;
  const r = applyCommand(data, { type: 'transitionState', commandId: 'close', now: T,
    payload: { sourceType: 'chatgptLead', sourceId: 'lead1', state: 'done', expectedVersion: lead.operationalStateVersion,
      evidence: { kind: 'answer', answerId: 'a1' } } }, { policy, actor: { kind: 'agent', id: 'agent' } });
  assert.equal(r.ok, false); assert.equal(r.error, 'DONE_ANSWER_IS_INSTRUCTION');
});
