import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { legacyAnswerIntent, openBriefingAnswers, renderBriefingAnswers } from '../public/quantus-v3-briefing-answers.mjs';
import { legacyQuestionFingerprint } from '../netlify/lib/assistant-legacy-questions.mjs';
const original = { text: 'Welche Möglichkeit?', options: ['Äpfel', 'Birnen'], extra: { z: 1, a: 'Grüsse' } };
const auth = { accountKey: 'owner', idToken: 'token' };
async function setup(t) {
  let questions = [], current = auth, now = Date.parse('2026-10-03T09:00:00Z'), lose = false;
  const sent = [];
  const options = { accountKey: auth.accountKey, indexedDB: new IDBFactory(), origin: 'https://quantus.example',
    now: () => now, getAuth: async () => current, getQuestions: () => questions,
    fetchImpl: async (_url, init) => {
      const command = JSON.parse(init.body); sent.push(command);
      if (lose) { lose = false; throw new Error('response lost'); }
      return new Response(JSON.stringify({ ok: true, applied: true, replayed: sent.length > 1,
        serverNow: '2026-10-03T09:00:00.000Z', requestId: 'req-one', dataRevision: 8,
        entityVersions: { [command.payload.questionId]: 2, [command.payload.answerId]: 1 } }));
    } };
  const client = await openBriefingAnswers(options); t.after(() => client.close());
  const intent = await legacyAnswerIntent({ accountKey: auth.accountKey, leadId: 'lead_one', question: original, answer: 'Äpfel' });
  const mapped = { id: intent.legacyOperation.questionId, text: original.text, status: 'open', runDate: '2026-10-03',
    sourceType: 'chatgptLead', sourceId: 'lead_one', legacySource: { leadId: 'lead_one', fingerprint: intent.legacyOperation.fingerprint } };
  return { client, options, sent, mapped, setQuestions: value => { questions = value; },
    switchAccount: () => { current = { ...auth, accountKey: 'other' }; }, loseResponse: () => { lose = true; }, advance: () => { now += 30_000; } };
}
test('legacy browser identity equals backend fingerprint, independent of JSON key order', async () => {
  const before = structuredClone(original);
  const intent = await legacyAnswerIntent({ accountKey: 'owner', leadId: 'lead_one', question: original, answer: ' Äpfel ' });
  assert.equal(intent.legacyOperation.fingerprint, legacyQuestionFingerprint('lead_one', original));
  const reordered = { extra: { a: 'Grüsse', z: 1 }, options: ['Äpfel', 'Birnen'], text: original.text };
  assert.equal(intent.operationId, (await legacyAnswerIntent({ accountKey: 'owner', leadId: 'lead_one', question: reordered, answer: 'Birnen' })).operationId);
  assert.deepEqual(original, before);
  original.extra.z = 2;
  assert.equal(intent.legacyOperation.question.extra.z, 1);
  original.extra.z = 1;
});
test('unmapped legacy answer survives reload and only exact server mapping enables API command', async t => {
  const h = await setup(t);
  await h.client.submitLegacy('lead_one', original, 'Äpfel');
  assert.equal((await h.client.flush()).unmapped, 1); assert.equal(h.sent.length, 0);
  const reopened = await openBriefingAnswers(h.options); t.after(() => reopened.close());
  assert.equal((await reopened.list())[0].legacyOperation.answer, 'Äpfel');
  h.setQuestions([h.mapped]); await reopened.flush();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].verb, 'briefing.answer');
  assert.equal(h.sent[0].payload.questionId, h.mapped.id);
  assert.ok(!JSON.stringify(h.sent[0]).includes('extra'));
  const entries = await reopened.list();
  assert.equal(entries.find(e => e.legacyOperation).deliveryStatus, 'acknowledged');
  assert.ok(entries.find(e => e.legacyOperation).resolvedOperationId);
});
for (const mutation of [q => ({ ...q, sourceId: 'other' }), q => ({ ...q, sourceType: 'task' }),
  q => ({ ...q, legacySource: { ...q.legacySource, fingerprint: 'wrong' } }),
  q => ({ ...q, status: 'withdrawn' }), q => ({ ...q, runDate: '2026-02-30' })]) {
  test('unverified, changed or closed mapping retains answer without sending: ' + mutation.toString(), async t => {
    const h = await setup(t); await h.client.submitLegacy('lead_one', original, 'Äpfel');
    h.setQuestions([mutation(h.mapped)]); await h.client.flush();
    assert.equal(h.sent.length, 0); assert.equal((await h.client.list())[0].legacyOperation.answer, 'Äpfel');
    assert.match(renderBriefingAnswers([], await h.client.list()), /Äpfel/);
  });
}
test('parallel tabs cannot replace an original intention or pretend a different canonical answer confirms it', async t => {
  const h = await setup(t), other = await openBriefingAnswers(h.options); t.after(() => other.close());
  await Promise.all([h.client.submitLegacy('lead_one', original, 'Äpfel'), other.submitLegacy('lead_one', original, 'Äpfel')]);
  await assert.rejects(other.submitLegacy('lead_one', original, 'Birnen'), { code: 'operation_id_conflict' });
  h.setQuestions([h.mapped]); await other.submit(h.mapped, 'Birnen'); await other.flush();
  const retained = (await h.client.list()).find(e => e.legacyOperation);
  assert.equal(retained.deliveryStatus, 'conflict'); assert.equal(retained.resolvedOperationId, null);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].payload.answer, 'Birnen');
});
test('lost response retries same command, preserving original until bound acknowledgement', async t => {
  const h = await setup(t); h.setQuestions([h.mapped]);
  await h.client.submitLegacy('lead_one', original, 'Äpfel'); h.loseResponse(); await h.client.flush();
  assert.equal((await h.client.list()).find(e => e.legacyOperation).deliveryStatus, 'retry_wait');
  h.advance(); await h.client.flush(); assert.deepEqual(h.sent[0], h.sent[1]);
  assert.equal((await h.client.list()).find(e => e.legacyOperation).deliveryStatus, 'acknowledged');
});
test('account change prevents reconciliation and scopes retained answers', async t => {
  const h = await setup(t); await h.client.submitLegacy('lead_one', original, 'Äpfel');
  h.setQuestions([h.mapped]); h.switchAccount();
  await assert.rejects(h.client.flush(), { code: 'sign_in_required' }); assert.equal(h.sent.length, 0);
  const other = await openBriefingAnswers({ ...h.options, accountKey: 'other' }); t.after(() => other.close());
  assert.deepEqual(await other.list(), []); assert.equal((await h.client.list()).length, 1);
});

test('actual desktop helper saves before network, blocks duplicate clicks and only refreshes after receipt', async t => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('const _v3LeadAnswersInFlight = new Set();');
  const end = html.indexOf('\n};', start) + 3;
  assert.ok(start > 0 && end > start);
  const h = await setup(t); h.setQuestions([h.mapped]);
  let release, sends = 0, refreshes = 0;
  const client = await openBriefingAnswers({ ...h.options, fetchImpl: async (...args) => {
    sends++; await new Promise(resolve => { release = resolve; }); return h.options.fetchImpl(...args);
  } }); t.after(() => client.close());
  const notices = [], win = { dbLoadServerQuestions: async () => {} };
  const mod = await import('../public/quantus-v3-briefing-answers.mjs');
  new Function('window', 'dbV3AnswerAccount', 'coreAuthCurrentUser', 'toast', 'syncFreshness', html.slice(start, end))(
    win, async () => ({ accountKey: auth.accountKey, client, mod }), () => ({ uid: auth.accountKey }),
    (...args) => notices.push(args), async () => { refreshes++; });
  const button = { disabled: false };
  const sending = win.dbSendLeadAnswer('lead_one', original, 'Äpfel', button);
  for (let n = 0; n < 100 && !release; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function'); assert.equal(button.disabled, true);
  assert.ok(notices.some(n => n[1] === 'Antwort auf diesem Gerät gesichert'));
  assert.ok(!notices.some(n => n[1] === 'Antwort vom Server bestätigt'));
  await win.dbSendLeadAnswer('lead_one', original, 'Birnen', button); assert.equal(sends, 1);
  assert.equal(refreshes, 0); release(); await sending;
  assert.equal(button.disabled, false); assert.equal(refreshes, 1);
  assert.ok(notices.some(n => n[1] === 'Antwort vom Server bestätigt'));
});
