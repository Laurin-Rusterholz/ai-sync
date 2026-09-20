import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../netlify/lib/assistant-core.mjs';

const date = '2026-09-19';
const now = Date.parse('2026-09-19T23:05:00+02:00');
const policy = { ...K.POLICY_TEMPLATE, tenant: 'review', requiredSources: [{ id: 'quantus-core', kind: 'quantus-core' }, { id: 'gmail', kind: 'mail' }] };
const actor = kind => ({ kind, id: `review-${kind}` });
let seq = 0;
function attempt(data, type, payload, kind = 'agent') {
  return K.applyCommand(data, { type, payload, now, commandId: 'review_' + ++seq }, { policy, actor: actor(kind) });
}
function cmd(data, type, payload, kind) {
  const r = attempt(data, type, payload, kind);
  assert.equal(r.ok, true, JSON.stringify({ type, error: r.error, detail: r.detail }));
  return r.data;
}
function day(task = false) {
  let data = K.migrateCore({ entities: { tasks: {}, projects: {}, notes: {}, chatgptNotes: {}, chatgptLeads: {},
    chatgptTasks: task ? { t1: { id: 't1', title: 'Independent task', state: 'offen' } } : {},
  } }, { now }).data;
  data = cmd(data, 'ensureRun', { date });
  data = cmd(data, 'ensureStartNote', { date, noteId: 'start_review' });
  for (const slot of K.SLOT_KEYS) data = cmd(data, 'recordSlotReceipt', { date, slot, receiptId: 'receipt_' + slot });
  for (const source of policy.requiredSources) data = cmd(data, 'recordSourceCheck', { date, sourceId: source.id, outcome: 'ok', cursor: 'verified' }, 'adapter');
  if (task) data = cmd(data, 'addItemRef', { date, sourceType: 'chatgptTask', sourceId: 't1' });
  else assert.equal(evaluate(data).overall, 'green');
  return data;
}
const evaluate = data => K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, policy);
function returned(data) {
  data = cmd(data, 'createJob', { jobId: 'job_review', kind: 'review', purpose: 'Verify source', sourceType: 'chatgptTask', sourceId: 't1',
    inputVersion: 1, executor: 'claude', contextRefs: [{ sourceType: 'chatgptTask', sourceId: 't1' }], expiresAt: new Date(now + 3600_000).toISOString() });
  data = cmd(data, 'recordJobReturn', { jobId: 'job_review', outcome: 'returned', resultRef: 'review_result', resultHash: 'a'.repeat(64) }, 'worker');
  assert.equal(data.automation.jobsById.job_review.result.stale, false);
  return data;
}
function doneWithEvidence() {
  let data = day(true);
  data = cmd(data, 'registerEvidence', { evidenceId: 'proof_review', kind: 'mail', ref: 'mail_review', sourceType: 'chatgptTask', sourceId: 't1',
    origin: { adapter: 'gmail', ref: 'message_review' }, observedAt: new Date(now - 1000).toISOString(), fingerprint: 'sha256-' + 'a'.repeat(64) }, 'adapter');
  data = cmd(data, 'transitionState', { sourceType: 'chatgptTask', sourceId: 't1', state: 'done', expectedVersion: 1, evidence: { kind: 'evidence', evidenceId: 'proof_review' } });
  assert.equal(evaluate(data).overall, 'green');
  return data;
}

for (const field of ['idempotencyByKey', 'outboxById', 'dataRevision']) {
  test(`B3-01: rerunning migration must not erase a lost ${field} ledger in an already-v3 core`, () => {
    const data = day();
    const unchanged = K.migrateCore(data, { now: now + 1 });
    assert.equal(unchanged.changed, false, 'valid migration remains idempotent');
    delete data.automation[field];
    assert.throws(() => K.migrateCore(data, { now: now + 1 }), error => error.status === 503);
  });
}
test('B3-02: a return becoming stale after arrival must not be accepted against newer work', () => {
  let data = returned(day(true));
  const control = attempt(data, 'reviewJobResult', { jobId: 'job_review', verdict: 'accepted', reviewer: 'review-agent' });
  assert.equal(control.ok, true, 'current result is reviewable');
  data = cmd(data, 'transitionState', { sourceType: 'chatgptTask', sourceId: 't1', state: 'review', expectedVersion: 1 }, 'user');
  assert.equal(data.entities.chatgptTasks.t1.operationalStateVersion, 2);
  const result = attempt(data, 'reviewJobResult', { jobId: 'job_review', verdict: 'accepted', reviewer: 'review-agent' });
  assert.equal(result.ok, false, 'input changed after worker return; stored result.stale=false is no longer authoritative');
});
test('B3-03: lost done-proof cannot stay green or preserve a final closure', () => {
  let data = doneWithEvidence();
  data = cmd(data, 'closeRun', { date, finalNoteId: 'final_review' });
  delete data.automation.evidenceById.proof_review;
  const contradiction = K.pruefeWiderspruch(data, { date }, { now: now + 1, policy });
  assert.deepEqual([evaluate(data).coverage, contradiction.contradictions.length > 0], ['red', true]);
});
test('B3-04: changed accepted worker result cannot silently preserve final closure', () => {
  let data = returned(day(true));
  data = cmd(data, 'reviewJobResult', { jobId: 'job_review', verdict: 'accepted', reviewer: 'review-agent' });
  data = cmd(data, 'transitionState', { sourceType: 'chatgptTask', sourceId: 't1', state: 'done', expectedVersion: 2, evidence: { kind: 'job', jobId: 'job_review' } });
  assert.equal(evaluate(data).overall, 'green');
  data = cmd(data, 'closeRun', { date, finalNoteId: 'final_review' });
  data.automation.jobsById.job_review.result.hash = 'b'.repeat(64);
  const contradiction = K.pruefeWiderspruch(data, { date }, { now: now + 1, policy });
  assert.deepEqual([evaluate(data).coverage, contradiction.contradictions.length > 0], ['red', true]);
});
