import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { answerIntent, openBriefingAnswers, renderBriefingAnswers, bindBriefingAnswers } from '../public/quantus-v3-briefing-answers.mjs';

const question = { id: 'q_one', text: 'Wann?', status: 'open', runDate: '2026-10-03', options: ['Heute', 'Morgen'], sourceType: 'chatgptLead', sourceId: 'lead_one' };
const auth = { accountKey: 'uid-one', idToken: 'valid-token' };
const goodResponse = (command) => new Response(JSON.stringify({ ok: true, replayed: false,
  applied: true, serverNow: '2026-10-03T09:00:00.000Z', requestId: 'req-1', dataRevision: 7,
  entityVersions: { [command.payload.questionId]: 3, [command.payload.answerId]: 4 } }));
async function setup(t, overrides = {}) {
  let now = Date.parse('2026-10-03T09:00:00.000Z');
  const options = { accountKey: auth.accountKey, getAuth: async () => auth, origin: 'https://quantus.example', indexedDB: new IDBFactory(), now: () => now,
    fetchImpl: async (_url, init) => goodResponse(JSON.parse(init.body)), ...overrides };
  const client = await openBriefingAnswers(options);
  t.after(() => client.close());
  return { client, options, advance: ms => { now += ms; } };
}

test('stable user/question identity, exact closed API envelope, no core mutation', async () => {
  const before = structuredClone(question);
  const a = await answerIntent({ accountKey: auth.accountKey, question, answer: 'Heute' });
  const b = await answerIntent({ accountKey: auth.accountKey, question, answer: 'Morgen' });
  assert.equal(a.operationId, b.operationId);
  assert.notEqual(a.operationId, (await answerIntent({ accountKey: 'uid-other', question, answer: 'Heute' })).operationId);
  assert.equal(a.command.verb, 'briefing.answer');
  assert.equal(a.command.jobId, 'run_2026-10-03');
  assert.equal(a.command.expectedEntityVersion, 0);
  assert.deepEqual(question, before);
});

for (const change of [{ status: 'answered' }, { id: '../wrong' }, { id: 'q__wrong' }, { runDate: null }, { runDate: '2026-02-30' }]) {
  test('unaddressable question is not guessed: ' + JSON.stringify(change), async () => {
    await assert.rejects(answerIntent({ accountKey: auth.accountKey, question: { ...question, ...change }, answer: 'Ja' }), { code: 'question_not_addressable' });
  });
}

test('offline answer survives reopen, then receives bound server acknowledgement', async t => {
  const h = await setup(t, { fetchImpl: async () => { throw new Error('offline'); } });
  const saved = await h.client.submit(question, 'Heute');
  assert.equal(saved.status, 'pending');
  await h.client.flush();
  assert.equal((await h.client.list())[0].status, 'retry_wait');
  h.client.close(); h.advance(30_000);
  const reopened = await openBriefingAnswers({ ...h.options, fetchImpl: async (_url, init) => goodResponse(JSON.parse(init.body)) });
  t.after(() => reopened.close());
  assert.equal((await reopened.list())[0].command.payload.answer, 'Heute');
  await reopened.flush();
  assert.equal((await reopened.list())[0].status, 'acknowledged');
});

test('multiple tabs and changed draft cannot replace an unresolved answer', async t => {
  let calls = 0;
  const h = await setup(t, { fetchImpl: async (_url, init) => { calls++; return goodResponse(JSON.parse(init.body)); } });
  const other = await openBriefingAnswers(h.options); t.after(() => other.close());
  await Promise.all([h.client.submit(question, 'Heute'), other.submit(question, 'Heute')]);
  await assert.rejects(other.submit(question, 'Morgen'), { code: 'operation_id_conflict' });
  assert.equal((await h.client.list()).length, 1);
  await h.client.flush(); await other.flush();
  assert.equal(calls, 1);
  assert.equal((await other.list())[0].command.payload.answer, 'Heute');
});

test('account switch prevents transmission and never reads another account queue', async t => {
  let current = auth, calls = 0;
  const h = await setup(t, { getAuth: async () => current, fetchImpl: async () => { calls++; throw new Error(); } });
  await h.client.submit(question, 'Privat');
  current = { ...auth, accountKey: 'other' };
  await assert.rejects(h.client.flush(), { code: 'sign_in_required' });
  const other = await openBriefingAnswers({ ...h.options, accountKey: 'other' }); t.after(() => other.close());
  assert.deepEqual(await other.list(), []); assert.equal(calls, 0);
  assert.equal((await h.client.list())[0].status, 'pending');
});

test('server write gate leaves the exact intention pending, without claimed success', async t => {
  const h = await setup(t, { fetchImpl: async () => new Response(JSON.stringify({ error: 'api_writes_disabled' }), { status: 503 }) });
  await h.client.submit(question, 'Ja');
  assert.equal((await h.client.flush()).paused, true);
  assert.equal((await h.client.list())[0].status, 'pending');
});

test('receipt without both question and answer is not a confirmation', async t => {
  const h = await setup(t, { fetchImpl: async (_url, init) => {
    const response = await goodResponse(JSON.parse(init.body)).json();
    delete response.entityVersions.q_one;
    return new Response(JSON.stringify(response));
  } });
  await h.client.submit(question, 'Ja'); await h.client.flush();
  assert.equal((await h.client.list())[0].status, 'retry_wait');
  assert.equal((await h.client.list())[0].lastError.code, 'answer_receipt_incomplete');
});

test('invalid answer and unavailable durable storage never pretend to save', async t => {
  const h = await setup(t);
  for (const answer of ['', ' ', 'x'.repeat(8001)]) await assert.rejects(h.client.submit(question, answer), { code: 'answer_invalid' });
  assert.deepEqual(await h.client.list(), []);
  await assert.rejects(openBriefingAnswers({ ...h.options, indexedDB: null }), { code: 'durable_storage_unavailable' });
});

test('UI escapes input, offers options, preserves unresolved orphan answers and truthful status', async t => {
  const h = await setup(t);
  const dirty = { ...question, text: '<script>bad()</script>', options: ['" onclick="bad()'] };
  const html = renderBriefingAnswers([dirty], [], { q_one: '</textarea><script>bad()</script>' });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /data-answer-option="&quot; onclick=&quot;bad\(\)/);
  assert.match(html, /Zugehörigen Lead öffnen/);
  await h.client.submit(question, 'Heute');
  const pending = renderBriefingAnswers([], await h.client.list());
  assert.match(pending, /Heute/); assert.match(pending, /Übertragung noch offen/);
  assert.ok(!pending.includes('data-answer-submit'));
  await h.client.flush();
  assert.match(renderBriefingAnswers([question], await h.client.list()), /Vom Server bestätigt/);
  assert.ok(!renderBriefingAnswers([question], await h.client.list()).includes('data-answer-submit'));
});

test('actual click binding fills options, preserves drafts, persists before sending and waits for server proof', async t => {
  let release;
  const h = await setup(t, { fetchImpl: async (_url, init) => {
    await new Promise(resolve => { release = resolve; });
    return goodResponse(JSON.parse(init.body));
  } });
  const field = { value: '', focus() {}, matches: selector => selector === '[data-answer-text]', closest: () => row };
  const row = { dataset: { serverQuestion: question.id }, querySelector: () => field };
  const status = { textContent: '' };
  const host = { isConnected: true, innerHTML: '', querySelector: () => status, contains: () => true };
  t.after(() => { host.isConnected = false; clearTimeout(host._answerRetryTimer); });
  const drafts = {};
  await bindBriefingAnswers({ host, client: h.client, questions: [question], drafts });
  const button = kind => ({ disabled: false, dataset: { answerOption: 'Morgen' }, closest: () => row, hasAttribute: attr => attr === kind });
  const event = target => ({ target: { closest: () => target }, preventDefault() {} });
  await host.onclick(event(button('data-answer-option')));
  assert.equal(field.value, 'Morgen'); assert.equal(drafts.q_one, 'Morgen');
  assert.deepEqual(await h.client.list(), [], 'choosing an option alone sends nothing');
  field.value = 'Heute Nachmittag'; host.oninput({ target: field });
  assert.equal(drafts.q_one, 'Heute Nachmittag');
  const sending = host.onclick(event(button('data-answer-submit')));
  for (let n = 0; n < 100 && !release; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function');
  assert.match(host.innerHTML, /Übertragung noch offen/);
  assert.ok(!host.innerHTML.includes('Vom Server bestätigt'));
  assert.equal((await h.client.list())[0].command.payload.answer, 'Heute Nachmittag');
  release(); await sending;
  assert.match(host.innerHTML, /Vom Server bestätigt/);
  assert.equal((await h.client.list())[0].status, 'acknowledged');
});

test('a detached or different-account view does not send an answer', async t => {
  const h = await setup(t);
  const host = { isConnected: false, innerHTML: 'old', contains: () => true };
  await bindBriefingAnswers({ host, client: h.client, questions: [question], drafts: {}, isCurrent: () => false });
  await host.onclick({ target: { closest: () => ({}) } });
  assert.equal(host.innerHTML, 'old'); assert.deepEqual(await h.client.list(), []);
});
