import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyAnswerIntent, findMigratedQuestion, reconcileLegacyQuestionRows } from '../public/quantus-v3-briefing-answers.mjs';
const original = { text: 'Welcher Termin?', options: ['Heute'], recommendation: 'Heute', unknown: { keep: 1 } };
async function canonical() {
  const { legacyOperation: old } = await legacyAnswerIntent({ accountKey: 'owner', leadId: 'lead_one', question: original, answer: 'Heute' });
  return { id: old.questionId, text: original.text, options: original.options, recommendation: original.recommendation,
    legacyAnswerDraft: null, legacyAnsweredAt: null, status: 'open', runDate: '2026-10-03',
    sourceType: 'chatgptLead', sourceId: 'lead_one', legacySource: { leadId: 'lead_one', fingerprint: old.fingerprint } };
}
function fixture({ text = '', targetText = '', readOnly = false } = {}) {
  const input = { value: text }, answer = { value: targetText, readOnly, focused: false, focus() { this.focused = true; } };
  const notices = [], buttons = [{ disabled: false }], counter = { textContent: '(1)' };
  const doc = { activeElement: input, createElement: () => ({ dataset: {}, textContent: '' }) };
  const row = { dataset: { legacyQuestionLead: 'lead_one', legacyQuestionOriginal: JSON.stringify(original) }, hidden: false,
    style: {}, isConnected: true, ownerDocument: doc, append: node => notices.push(node),
    querySelector: selector => selector === 'input' ? input : notices.find(n => Object.hasOwn(n.dataset, 'legacyDraftNotice')),
    querySelectorAll: () => buttons };
  const section = { hidden: false, style: {}, querySelectorAll: () => [row], querySelector: () => counter };
  const root = { querySelectorAll: selector => selector === '[data-legacy-question-lead]' ? [row] : [section] };
  const host = { isConnected: true, querySelector: () => ({ querySelector: () => answer }) };
  return { input, answer, row, section, root, host, notices, buttons, counter, drafts: {}, isCurrent: () => true };
}
test('exact full original and canonical content are required, not just source or text', async () => {
  const q = await canonical();
  assert.equal(await findMigratedQuestion('lead_one', original, [q]), q);
  for (const other of [{ ...original, unknown: { keep: 2 } }, { ...original, answer: 'Unconfirmed' }])
    assert.equal(await findMigratedQuestion('lead_one', other, [q]), null);
  for (const change of [{ text: 'Changed' }, { options: ['Morgen'] }, { legacyAnswerDraft: 'Other' },
    { sourceId: 'other' }, { runDate: '2026-02-30' }, { status: 'made_up' }])
    assert.equal(await findMigratedQuestion('lead_one', original, [{ ...q, ...change }]), null);
});
test('one answer field, draft and focus move only after canonical row exists; counts exclude hidden rows', async () => {
  const q = await canonical(), f = fixture({ text: 'Heute Nachmittag' });
  await reconcileLegacyQuestionRows({ ...f, questions: [q] });
  assert.equal(f.answer.value, 'Heute Nachmittag'); assert.equal(f.drafts[q.id], 'Heute Nachmittag');
  assert.equal(f.answer.focused, true); assert.equal(f.row.hidden, true); assert.equal(f.row.style.display, 'none');
  assert.equal(f.section.hidden, true); assert.equal(f.counter.textContent, '(0)');
  f.answer.value = 'Neu im gemeinsamen Feld'; f.drafts[q.id] = f.answer.value;
  await reconcileLegacyQuestionRows({ ...f, questions: [q] });
  assert.equal(f.answer.value, 'Neu im gemeinsamen Feld', 'hidden old input cannot overwrite subsequent edits');
});
test('different draft or immutable pending answer stays visible, never overwritten', async () => {
  for (const readOnly of [false, true]) {
    const q = await canonical(), f = fixture({ text: 'Morgen', targetText: 'Heute', readOnly });
    await reconcileLegacyQuestionRows({ ...f, questions: [q] });
    assert.equal(f.answer.value, 'Heute'); assert.equal(f.input.value, 'Morgen'); assert.equal(f.row.hidden, false);
    assert.match(f.notices[0].textContent, /anderer Entwurf/);
  }
});
test('unmapped draft survives view replacement, stays scoped to exact source and can be cleared', async () => {
  const f = fixture({ text: 'Entwurf' }); await reconcileLegacyQuestionRows({ ...f, questions: [] });
  const next = fixture(); next.drafts = f.drafts;
  await reconcileLegacyQuestionRows({ ...next, questions: [] }); assert.equal(next.input.value, 'Entwurf');
  next.input.value = ''; next.row.oninput({ target: next.input });
  const cleared = fixture(); cleared.drafts = f.drafts;
  await reconcileLegacyQuestionRows({ ...cleared, questions: [] }); assert.equal(cleared.input.value, '');
  const changed = fixture(); changed.drafts = f.drafts;
  changed.row.dataset.legacyQuestionOriginal = JSON.stringify({ ...original, unknown: { keep: 9 } });
  await reconcileLegacyQuestionRows({ ...changed, questions: [] }); assert.equal(changed.input.value, '');
});
test('account or view change during hash prevents draft transfer and hiding', async () => {
  const q = await canonical(), f = fixture({ text: 'Private' }); let current = true;
  await reconcileLegacyQuestionRows({ ...f, questions: [q], isCurrent: () => current,
    cryptoImpl: { subtle: { async digest(...args) { current = false; return crypto.subtle.digest(...args); } } } });
  assert.equal(f.answer.value, ''); assert.equal(f.row.hidden, false);
});
test('typing during hash is preserved; absent canonical view does not hide original', async () => {
  const q = await canonical(), f = fixture({ text: 'Before' });
  await reconcileLegacyQuestionRows({ ...f, questions: [q], cryptoImpl: { subtle: { async digest(...args) {
    f.input.value = 'After'; return crypto.subtle.digest(...args);
  } } } }); assert.equal(f.answer.value, 'After');
  const absent = fixture(); absent.host.querySelector = () => null;
  await reconcileLegacyQuestionRows({ ...absent, questions: [q] }); assert.equal(absent.row.hidden, false);
});
test('answered and withdrawn originals have no duplicate send; unsent text remains readable', async () => {
  for (const status of ['answered', 'withdrawn']) for (const text of ['', 'Keep draft']) {
    const q = { ...await canonical(), status }, f = fixture({ text });
    await reconcileLegacyQuestionRows({ ...f, questions: [q] });
    assert.equal(f.buttons[0].disabled, true); assert.equal(f.input.readOnly, true);
    assert.equal(f.row.hidden, !text); assert.equal(f.input.value, text);
    assert.match(f.notices[0].textContent, status === 'answered' ? /bereits beantwortet/ : /zurückgenommen/);
  }
});

test('a retained unmapped answer owns the visible row, but a different unsent draft is preserved', async () => {
  const intent = await legacyAnswerIntent({ accountKey: 'owner', leadId: 'lead_one', question: original, answer: 'Heute' });
  for (const text of ['', 'Heute', 'Morgen']) {
    const f = fixture({ text });
    await reconcileLegacyQuestionRows({ ...f, questions: [], entries: [intent] });
    assert.equal(f.row.hidden, text !== 'Morgen');
    assert.equal(f.input.value, text);
  }
  const missing = fixture(); missing.host.querySelector = () => null;
  await reconcileLegacyQuestionRows({ ...missing, questions: [], entries: [intent] }); assert.equal(missing.row.hidden, false);
});
