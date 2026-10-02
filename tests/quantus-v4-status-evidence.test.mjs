import test from 'node:test';
import assert from 'node:assert/strict';
import { projectItem, projectPage } from '../netlify/lib/quantus-v3-read-helpers.mjs';

const reason = (code, extra = {}) => ({ axis: 'coverage', code, severity: 'red', ...extra });
const status = reasons => ({ id: 'status_2026-10-02', evaluationReasons: reasons });

test('status groups all occurrences without exposing source identities or reason details', () => {
  const out = projectItem('run_status', status([
    reason('ITEM_OPEN', { sourceId: 'foreign-item', detail: { privateMail: 'sensitive' } }),
    reason('ITEM_OPEN'), reason('SOURCE_STALE', { axis: 'operations' }),
  ]));
  assert.deepEqual(out.evaluationReasons, [
    { axis: 'coverage', code: 'ITEM_OPEN', severity: 'red', count: 2 },
    { axis: 'operations', code: 'SOURCE_STALE', severity: 'red', count: 1 },
  ]);
  assert.equal(out.evaluationReasonCount, 3);
  assert.equal(out.evaluationReasonGroupCount, 2);
  assert.equal(out.evaluationReasonsComplete, true);
  assert.ok(!JSON.stringify(out).includes('sensitive'));
  assert.ok(!JSON.stringify(out).includes('foreign-item'));
});

test('bounded reason groups explicitly report omitted groups and retain total counts', () => {
  const reasons = Array.from({ length: 70 }, (_, i) => reason(`ISSUE_${i}`));
  const out = projectItem('run_status', { ...status(reasons), evaluationReasonCount: 0,
    evaluationReasonGroupCount: 0, evaluationReasonsComplete: true });
  assert.equal(out.evaluationReasons.length, 50);
  assert.equal(out.evaluationReasonCount, 70);
  assert.equal(out.evaluationReasonGroupCount, 70);
  assert.equal(out.evaluationReasonsComplete, false);
});

test('repeated reason occurrences do not consume the group limit', () => {
  const out = projectItem('run_status', status(Array.from({ length: 200 }, () => reason('ITEM_OPEN'))));
  assert.equal(out.evaluationReasons[0].count, 200);
  assert.equal(out.evaluationReasonsComplete, true);
  assert.equal(out.evaluationReasonCount, 200);
});

test('malformed or missing reasons cannot advertise a complete evaluation', () => {
  for (const reasons of [null, {}, [null], [reason('bad free text')], [reason('OK', { axis: {} })], [reason('OK', { severity: 'green' })]]) {
    const out = projectItem('run_status', { ...status(reasons), evaluationReasonsComplete: true });
    assert.equal(out.evaluationReasonsComplete, false);
  }
  const absent = projectItem('run_status', { id: 'status', evaluationReasonsComplete: true });
  assert.equal(absent.evaluationReasonsComplete, undefined);
});

test('real page projection exposes server evaluation metadata but excludes arbitrary internal fields', () => {
  const page = projectPage('run.status', [{ ...status([]), coverage: 'green', operations: 'yellow', overall: 'yellow',
    evaluatedAt: '2026-10-02T10:00:00Z', validUntil: '2026-10-02T10:05:00Z', evaluatedRevision: 7,
    evaluationCached: false, policyVersion: 'test/3', internalMail: 'private', evaluatedFingerprint: 'internal' }]);
  assert.equal(page.ok, true);
  const out = page.items[0];
  assert.equal(out.coverage, 'green');
  assert.equal(out.operations, 'yellow');
  assert.equal(out.overall, 'yellow');
  assert.equal(out.evaluatedRevision, 7);
  assert.equal(out.evaluationCached, false);
  assert.equal(out.evaluationReasonsComplete, true);
  assert.equal(out.internalMail, undefined);
  assert.equal(out.evaluatedFingerprint, undefined);
});
