import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCore, applyCommand, POLICY_TEMPLATE } from '../netlify/lib/assistant-core.mjs';
import { planLegacyQuestions } from '../netlify/lib/assistant-legacy-questions.mjs';
import { createLegacyQuestionPreparation } from '../runtime/quantus-v3/src/legacy-question-preparation.mjs';
import { createAnswerPreparation } from '../runtime/quantus-v3/src/answer-preparation.mjs';
import { renderBriefingAnswers } from '../public/quantus-v3-briefing-answers.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';
const date = '2026-10-02';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0', requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const system = { kind: 'system', id: 'migration-test' };
const original = { text: 'Welcher Termin?', options: ['Heute', 'Morgen'], recommendation: 'Morgen', askedAt: '2026-09-30T09:00:00Z', answer: null, answeredAt: null, unknownFutureField: { preserved: true } };
function cmd(data, type, payload, actor = system) { return applyCommand(data, { type, payload, now: T, commandId: 'test-' + type }, { policy, actor }); }
function core(count = 1, question = original) {
  const leads = Object.fromEntries(Array.from({ length: count }, (_, i) => ['l' + i, { id: 'l' + i, status: 'neu', title: 'Lead ' + i, pendingQuestion: structuredClone(question) }]));
  const migrated = migrateCore({ entities: { chatgptLeads: leads }, _deleteLog: [{ id: 'keep' }] }, { now: T }).data;
  const result = cmd(migrated, 'ensureRunSlot', { date, slot: 'process09', receiptId: 'receipt' });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
}
async function fixture(data = core()) {
  const f = await setup(data);
  const config = { core: f.core, clock: f.clock, policy, tenant: 'quantus', runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope, enabled: true };
  return { ...f, config, make: options => createLegacyQuestionPreparation({ ...config, ...options }) };
}

test('open legacy question is migrated in one revision with complete source identity and unchanged originals', async () => {
  const f = await fixture(), before = f.store.snapshot();
  const result = await f.make().next(), after = f.store.snapshot();
  assert.equal(result.ready, false);
  const [q] = Object.values(after.automation.questionsById);
  assert.equal(q.text, original.text); assert.deepEqual(q.options, original.options);
  assert.equal(q.status, 'open'); assert.equal(q.runDate, date);
  assert.equal(q.legacySource.leadId, 'l0'); assert.match(q.legacySource.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(after.entities, before.entities); assert.deepEqual(after._deleteLog, before._deleteLog);
  assert.equal(after.automation.dataRevision, before.automation.dataRevision + 1);
  const puts = f.store.stats.puts;
  assert.equal((await f.make().next()).ready, true); assert.equal(f.store.stats.puts, puts);
});

test('legacy answer is only a draft, not a fabricated confirmed user event or consumed instruction', async () => {
  const f = await fixture(core(1, { ...original, answer: 'Morgen', answeredAt: '2026-10-01T10:00:00Z' }));
  await f.make().next();
  const data = f.store.snapshot(), [q] = Object.values(data.automation.questionsById);
  assert.equal(q.legacyAnswerDraft, 'Morgen'); assert.equal(q.status, 'open');
  assert.deepEqual(data.automation.answersById, {});
  assert.equal((await createAnswerPreparation(f.config).next()).ready, true);
  assert.deepEqual(f.store.snapshot().automation.intakeById, {});
  const html = renderBriefingAnswers([q]);
  assert.match(html, /bitte prüfen und ausdrücklich bestätigen/); assert.match(html, />Morgen<\/textarea>/);
  const answered = cmd(data, 'recordAnswer', { questionId: q.id, answerId: 'confirmed', text: 'Morgen' }, { kind: 'user', id: 'real-owner' });
  assert.equal(answered.ok, true); assert.equal(answered.data.automation.answersById.confirmed.answeredBy, 'real-owner');
});

test('changed legacy source rejects stale answer and withdraws the old open question atomically', async () => {
  const f = await fixture(); await f.make().next();
  const old = Object.values(f.store.snapshot().automation.questionsById)[0];
  f.store.forceWrite(d => { d.entities.chatgptLeads.l0.pendingQuestion.unknownFutureField.preserved = false; return d; });
  const stale = cmd(f.store.snapshot(), 'recordAnswer', { questionId: old.id, answerId: 'stale', text: 'Ja' }, { kind: 'user', id: 'owner' });
  assert.equal(stale.error, 'LEGACY_QUESTION_SOURCE_CHANGED');
  await f.make().next();
  const questions = Object.values(f.store.snapshot().automation.questionsById);
  assert.equal(questions.length, 2); assert.equal(questions.filter(q => q.status === 'open').length, 1);
  assert.equal(questions.find(q => q.id === old.id).status, 'withdrawn');
});

test('closed and deleted leads never become new questions; existing open migration questions are withdrawn', async () => {
  for (const mode of ['closed', 'deleted']) {
    const f = await fixture(); await f.make().next();
    f.store.forceWrite(d => { if (mode === 'closed') { d.entities.chatgptLeads.l0.operationalState = 'done'; d.entities.chatgptLeads.l0.operationalStateVersion++; } else delete d.entities.chatgptLeads.l0; return d; });
    await f.make().next();
    assert.equal(Object.values(f.store.snapshot().automation.questionsById)[0].status, 'withdrawn');
    assert.equal((await f.make().next()).ready, true);
  }
  const data = core(); data.entities.chatgptLeads.l0.operationalState = 'done';
  assert.deepEqual(planLegacyQuestions(data).items, []);
});

test('canonical reopened state leads; a stale legacy closed flag cannot suppress its new question', async () => {
  const data = core(); data.entities.chatgptLeads.l0.status = 'abgeschlossen';
  assert.equal(data.entities.chatgptLeads.l0.operationalState, 'doing');
  const f = await fixture(data); await f.make().next();
  assert.equal(Object.values(f.store.snapshot().automation.questionsById)[0].status, 'open');
  assert.equal(f.store.snapshot().entities.chatgptLeads.l0.status, 'abgeschlossen', 'historical field stays untouched');
});

test('ambiguous legacy values remain visible as unresolved and are never guessed', async () => {
  for (const question of [{ ...original, text: '' }, { ...original, options: 'ja' }, { ...original, answer: { wrong: true } }]) {
    const f = await fixture(core(1, question));
    const before = f.store.snapshot(), result = await f.make().next();
    assert.equal(result.blocked, true); assert.equal(result.reason, 'legacy_questions_require_review');
    assert.equal(result.unresolved[0].leadId, 'l0'); assert.deepEqual(f.store.snapshot(), before);
  }
});

test('only system can migrate; malformed batch and source conflicts fail without partial writes', () => {
  const data = core(2), items = planLegacyQuestions(data).items;
  for (const kind of ['user', 'agent', 'worker', 'adapter']) {
    assert.equal(cmd(data, 'migrateLegacyQuestions', { date, items }, { kind, id: 'caller' }).error, 'ACTOR_REJECTED');
  }
  assert.equal(cmd(data, 'migrateLegacyQuestions', { date, items: [] }).ok, false);
  items[1].fingerprint = 'wrong';
  const result = cmd(data, 'migrateLegacyQuestions', { date, items });
  assert.equal(result.error, 'LEGACY_QUESTION_SOURCE_CHANGED'); assert.deepEqual(result.data, data);
});

test('batch limit yields real progress and consumes the remaining sources on the next step', async () => {
  const f = await fixture(core(35));
  await f.make().next(); assert.equal(Object.keys(f.store.snapshot().automation.questionsById).length, 32);
  await f.make().next(); assert.equal(Object.keys(f.store.snapshot().automation.questionsById).length, 35);
  assert.equal((await f.make().next()).ready, true);
});

test('lost acknowledgement and parallel workers preserve one question per exact source', async () => {
  const f = await fixture(); let lost = true;
  const wrapped = { ...f.core, async mutate(args) { const result = await f.core.mutate(args); if (lost) { lost = false; throw new Error('lost_receipt'); } return result; } };
  await assert.rejects(f.make({ core: wrapped }).next(), /lost_receipt/);
  const puts = f.store.stats.puts;
  assert.equal((await f.make().next()).ready, true); assert.equal(f.store.stats.puts, puts);
  const other = await fixture(); await Promise.all([other.make().next(), other.make().next()]);
  assert.equal(Object.keys(other.store.snapshot().automation.questionsById).length, 1);
});

test('CAS retries preserve unrelated edits and reject a changed legacy original', async () => {
  for (const changed of [false, true]) {
    const f = await fixture(); let once = true;
    f.onMutation(() => { if (!once) return; once = false; f.store.forceWrite(d => {
      if (changed) d.entities.chatgptLeads.l0.pendingQuestion.text = 'Neue Frage';
      else d.entities.chatgptLeads.l0.title = 'User edit'; return d;
    }); });
    if (changed) { await assert.rejects(f.make().next(), /SOURCE_CHANGED/); assert.deepEqual(f.store.snapshot().automation.questionsById, {}); }
    else { await f.make().next(); assert.equal(f.store.snapshot().entities.chatgptLeads.l0.title, 'User edit'); }
  }
});

test('missing readback, altered canonical content, disabled writes and expired authority cannot claim completion', async () => {
  const f = await fixture();
  const lying = { ...f.core, async mutate(args) { const result = await f.core.mutate(args); f.store.forceWrite(d => { d.automation.questionsById = {}; return d; }); return result; } };
  await assert.rejects(f.make({ core: lying }).next(), /readback_failed/);
  const altered = await fixture(); await altered.make().next();
  altered.store.forceWrite(d => { Object.values(d.automation.questionsById)[0].text = 'Tampered'; return d; });
  assert.equal((await altered.make().next()).blocked, true);
  const inactive = await fixture();
  assert.equal((await inactive.make({ enabled: false }).next()).blocked, true);
  assert.deepEqual(inactive.store.snapshot().automation.questionsById, {});
  inactive.setNow(T + 120001); await assert.rejects(inactive.make().next());
});

test('damaged migration links stay unresolved rather than becoming an empty successful scan', async () => {
  for (const damage of [q => { q.legacySource = 'wrong'; }, q => { q.id = 'wrong'; }, q => { q.status = 'unknown'; }]) {
    const f = await fixture(); await f.make().next();
    f.store.forceWrite(data => { damage(Object.values(data.automation.questionsById)[0]); return data; });
    assert.equal((await f.make().next()).blocked, true);
  }
});
