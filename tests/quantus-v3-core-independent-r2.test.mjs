import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../netlify/lib/assistant-core.mjs';
import { prepareIdempotentCommand, applyIdempotentCommand } from '../netlify/lib/quantus-v3-idempotency.mjs';

const date = '2026-09-19';
const now = Date.parse('2026-09-19T23:05:00+02:00');
const policy = { ...K.POLICY_TEMPLATE, tenant: 'review', requiredSources: [{ id: 'quantus-core', kind: 'quantus-core' }, { id: 'gmail-inbox', kind: 'mail' }] };
const agent = { kind: 'agent', id: 'review-agent' };
const adapter = { kind: 'adapter', id: 'review-adapter' };
let sequence = 0;
function command(data, type, payload, at = now, actor = agent) {
  const result = K.applyCommand(data, { type, commandId: 'review_' + ++sequence, now: at, payload }, { policy, actor });
  assert.equal(result.ok, true, type + ': ' + JSON.stringify(result.detail || result.error));
  return result.data;
}
function preparedDay({ waiting = false, project = false } = {}) {
  const entities = { tasks: {}, projects: {}, notes: {}, chatgptNotes: {}, chatgptLeads: {}, chatgptTasks: {} };
  if (waiting) entities.chatgptLeads.l1 = { id: 'l1', title: 'Review lead', status: 'in_arbeit', readAt: '2026-09-19T06:00:00Z', assignee: 'chatgpt' };
  if (project) entities.projects.p1 = { id: 'p1', status: 'active', deadlines: [{ id: 'd1', date, done: true }] };
  let data = K.migrateCore({ entities }, { now }).data;
  data = command(data, 'ensureRun', { date });
  data = command(data, 'ensureStartNote', { date, noteId: 'start_review' });
  for (const slot of K.SLOT_KEYS) data = command(data, 'recordSlotReceipt', { date, slot, receiptId: 'receipt_' + slot });
  for (const source of policy.requiredSources) data = command(data, 'recordSourceCheck', { date, sourceId: source.id, outcome: 'ok', cursor: 'verified' }, now, adapter);
  if (waiting) {
    data = command(data, 'addItemRef', { date, sourceType: 'chatgptLead', sourceId: 'l1' });
    data = command(data, 'registerEvidence', {
      evidenceId: 'proof_review', kind: 'mail', ref: 'mail_review', sourceType: 'chatgptLead', sourceId: 'l1',
      origin: { adapter: 'gmail', ref: 'message_review' }, observedAt: new Date(now - 60_000).toISOString(), fingerprint: 'sha256-' + 'a'.repeat(64),
    }, now, adapter);
    data = command(data, 'setWaiting', {
      sourceType: 'chatgptLead', sourceId: 'l1', expectedVersion: 1, state: 'waiting_external',
      counterparty: 'External partner', nextAction: 'Review reply', followUpAt: new Date(now + 86_400_000).toISOString(),
      evidence: { kind: 'evidence', evidenceId: 'proof_review' },
    });
  }
  const evaluation = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, policy);
  assert.equal(evaluation.overall, 'green', 'Fixture must first be valid: ' + JSON.stringify(evaluation.reasons));
  return data;
}
const evaluate = data => K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, policy);

test('B2-01: corrupt required maps cannot be green in the shared evaluator', () => {
  for (const field of ['questionsById', 'documentsById', 'jobsById']) {
    const data = preparedDay();
    data.automation[field] = [];
    assert.equal(evaluate(data).operations, 'red', field);
  }
});
test('B2-02: missing source stores and invalid revisions cannot be green', () => {
  const data = preparedDay();
  delete data.entities.chatgptLeads;
  data.automation.dataRevision = -1;
  assert.equal(evaluate(data).operations, 'red');
});
test('B2-03: waiting counterpart change invalidates a cached green evaluation', () => {
  const data = preparedDay({ waiting: true });
  const cached = evaluate(data);
  const context = { run: data.dailyBriefing.assistantRuns[date], data, now: now + 1, policy };
  assert.equal(K.isEvaluationCurrent(cached, context).current, true);
  data.automation.waitingById['chatgptLead:l1'].counterparty = '';
  assert.equal(evaluate(data).coverage, 'red');
  assert.equal(K.isEvaluationCurrent(cached, context).current, false);
});
test('B2-04: required source failure invalidates cached green', () => {
  const data = preparedDay();
  const cached = evaluate(data);
  const context = { run: data.dailyBriefing.assistantRuns[date], data, now: now + 1, policy };
  assert.equal(K.isEvaluationCurrent(cached, context).current, true);
  data.dailyBriefing.assistantRuns[date].sourceChecks['quantus-core'].outcome = 'unreachable';
  assert.equal(evaluate(data).operations, 'red');
  assert.equal(K.isEvaluationCurrent(cached, context).current, false);
});
test('B2-05: loss of the referenced evidence invalidates a finalized obligation', () => {
  let data = preparedDay({ waiting: true });
  data = command(data, 'closeRun', { date, finalNoteId: 'final_review' });
  delete data.automation.evidenceById.proof_review;
  assert.equal(evaluate(data).coverage, 'red');
  assert.ok(K.pruefeWiderspruch(data, { date }, { now: now + 1, policy }).contradictions.length > 0);
});
test('B2-06: loss of waiting prerequisites invalidates a finalized obligation', () => {
  let data = preparedDay({ waiting: true });
  data = command(data, 'closeRun', { date, finalNoteId: 'final_review' });
  delete data.automation.waitingById['chatgptLead:l1'].nextAction;
  assert.equal(evaluate(data).coverage, 'red');
  assert.ok(K.pruefeWiderspruch(data, { date }, { now: now + 1, policy }).contradictions.length > 0);
});
test('B2-07: reopening an already checked project deadline invalidates closure', () => {
  let data = preparedDay({ project: true });
  data = command(data, 'closeRun', { date, finalNoteId: 'final_review' });
  data.entities.projects.p1.deadlines[0].done = false;
  assert.equal(evaluate(data).coverage, 'red');
  assert.ok(K.pruefeWiderspruch(data, { date }, { now: now + 1, policy }).contradictions.length > 0);
});
test('B2-08: briefing notes use the existing ChatGPT Notes source', () => {
  const data = preparedDay();
  assert.ok(data.entities.chatgptNotes[data.dailyBriefing.assistantRuns[date].startNoteId]);
});
test('B2-09: idempotency adapter must use trusted prepared time, never command time', () => {
  const data = preparedDay();
  const prepared = prepareIdempotentCommand({
    tenantId: 'review', principalId: 'review-agent', key: 'review-timestamp-1', requestId: 'request_review_1',
    now: '2026-09-19T10:00:00.000Z', command: { type: 'closeRun', now, payload: { date, finalNoteId: 'early_final' } },
  });
  assert.throws(() => applyIdempotentCommand(data, prepared, K.commandReducer({ policy, actor: agent })),
    error => error.code === 'COMMAND_BODY_TIME_FORBIDDEN' && error.status === 400);
});
test('B2-09b: close without a forged time still cannot close before trusted 23:00', () => {
  const data = preparedDay();
  const before = structuredClone(data);
  const prepared = prepareIdempotentCommand({
    tenantId: 'review', principalId: 'review-agent', key: 'review-timestamp-2', requestId: 'request_review_2',
    now: '2026-09-19T10:00:00.000Z', command: { type: 'closeRun', payload: { date, finalNoteId: 'early_final' } },
  });
  assert.throws(() => applyIdempotentCommand(data, prepared, K.commandReducer({ policy, actor: agent })),
    error => error.code === 'CLOSURE_BLOCKED' && error.status === 409);
  assert.deepEqual(data, before);
});
