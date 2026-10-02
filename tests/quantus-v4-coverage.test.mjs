import test from 'node:test';
import assert from 'node:assert/strict';
import { completeToolRead } from '../runtime/quantus-v3/src/complete-tool-read.mjs';
import { createLeadershipCompletionCheck, requiredLeadershipReads } from '../runtime/quantus-v3/src/leadership-coverage.mjs';
const runKey = 'quantus:2026-10-02:process09:4.0';
const required = requiredLeadershipReads(runKey);
const itemsFor = query => query === 'policy.current' ? [{ id: 'policy_4.0', policyVersion: '4.0' }]
  : query === 'run.status' ? [{ id: 'status_2026-10-02', runId: 'run_2026-10-02', policyVersion: '4.0' }]
    : [{ id: 'ctx_task_t1', sourceId: 't1', sourceType: 'task', sourceMissing: false, title: 'Open task' }];
function receipt(expected, items = itemsFor(expected.query), dataRevision = 8) {
  return { confirmed: true, readComplete: true, response: { status: 200, body: {
    ok: true, ...expected, items, count: items.length, hasMore: false, complete: true, pageStatus: 'done', cursor: null,
    dataRevision, serverNow: '2026-10-02T07:01:00Z', requestId: 'read-' + expected.query,
  } } };
}
function history() {
  return required.map(expected => ({ response: { result: { toolCalls: [{ name: expected.query === 'run.status' ? 'quantus_run_status' : 'quantus_context',
    arguments: expected.query === 'run.status' ? { cursor: '' } : { ...expected, cursor: '' } }] } }, tool: receipt(expected) }));
}

test('complete read collects pages at one revision and never calls page three after a bound', async () => {
  const expected = required[1], first = receipt(expected).response;
  first.body.hasMore = true; first.body.complete = false; first.body.pageStatus = 'more'; first.body.cursor = 'next';
  let calls = 0;
  const next = async cursor => { calls++; assert.equal(cursor, 'next'); return receipt(expected, [{ id: 'ctx_task_t2' }]).response; };
  const result = await completeToolRead({ first, ...expected, next });
  assert.equal(result.readComplete, true);
  assert.equal(result.response.body.count, 2);
  assert.equal(result.readPages.length, 2);
  assert.equal(calls, 1);
  calls = 0;
  const limited = await completeToolRead({ first, ...expected, next, maxPages: 1 });
  assert.equal(limited.readComplete, false);
  assert.equal(limited.readFailure, 'read_page_limit');
  assert.equal(calls, 0);
});

test('revision drift, duplicate identity, repeated cursor, bytes and suffix reads cannot claim completeness', async () => {
  for (const flaw of ['revision', 'duplicate', 'cursor', 'bytes', 'suffix']) {
    const expected = required[1], first = receipt(expected).response;
    first.body.hasMore = true; first.body.complete = false; first.body.pageStatus = 'more'; first.body.cursor = 'next';
    const next = async () => {
      if (flaw === 'cursor') return first;
      const r = receipt(expected, [{ id: flaw === 'duplicate' ? 'ctx_task_t1' : 'ctx_task_t2' }]).response;
      if (flaw === 'revision') r.body.dataRevision++;
      return r;
    };
    const result = await completeToolRead({ first, ...expected, next, maxBytes: flaw === 'bytes' ? 10 : 100000,
      cursor: flaw === 'suffix' ? 'old-cursor' : '' });
    assert.equal(result.readComplete, false, flaw);
  }
});

test('no recorded complete workset is no completion; legacy run.context does not substitute for it', async () => {
  const check = createLeadershipCompletionCheck({ runKey, gateway: { execute: () => assert.fail('no refresh before required reads') } });
  assert.equal((await check({ entries: [] })).reason, 'required_context_unread');
  const entries = history();
  entries[1].response.result.toolCalls[0].arguments.query = 'run.context';
  assert.deepEqual((await check({ entries })).requiredReads, [required[1]]);
  entries[1] = history()[1]; entries[1].tool.readComplete = false;
  assert.deepEqual((await check({ entries })).requiredReads, [required[1]]);
});

test('fresh same-content reads tolerate runtime revisions but actual arrivals require model rereading', async () => {
  for (const changed of [false, true]) {
    const check = createLeadershipCompletionCheck({ runKey, gateway: { async execute(call) {
      const expected = call.name === 'quantus_run_status' ? required[2] : required.find(r => r.query === call.arguments.query);
      const items = itemsFor(expected.query);
      if (changed && expected.query === 'run.workset') items.push({ id: 'ctx_task_arrived', sourceId: 'arrived', sourceMissing: false });
      return receipt(expected, items, 99);
    } } });
    const result = await check({ entries: history() });
    assert.equal(result.complete, !changed);
    if (changed) assert.deepEqual(result.requiredReads, [required[1], required[2]]);
    else { assert.equal(result.proof.itemCount, 1); assert.equal(result.proof.dataRevision, 99); }
  }
});

test('writes after a complete read invalidate workset and status coverage', async () => {
  const entries = [...history(), { response: { result: { toolCalls: [{ name: 'quantus_command' }] } }, tool: { response: { body: { applied: true } } } }];
  const check = createLeadershipCompletionCheck({ runKey, gateway: { execute: () => assert.fail('must ask for current reads') } });
  assert.deepEqual((await check({ entries })).requiredReads, [required[1], required[2]]);
});

test('missing originals, foreign policy, incomplete refresh and cross-query revision changes cannot complete', async () => {
  for (const flaw of ['missing', 'policy', 'partial', 'revision']) {
    const check = createLeadershipCompletionCheck({ runKey, gateway: { async execute(call) {
      const expected = call.name === 'quantus_run_status' ? required[2] : required.find(r => r.query === call.arguments.query);
      const r = receipt(expected);
      if (flaw === 'missing' && expected.query === 'run.workset') r.response.body.items[0].sourceMissing = true;
      if (flaw === 'policy' && expected.query === 'policy.current') r.response.body.items[0].policyVersion = 'foreign';
      if (flaw === 'partial') r.readComplete = false;
      if (flaw === 'revision' && expected.query === 'run.status') r.response.body.dataRevision++;
      return r;
    } } });
    const result = await check({ entries: history() });
    assert.equal(result.complete, false, flaw);
    assert.equal(result.blocked === true, flaw !== 'revision', flaw);
  }
});

test('oversized source pages yield bounded explicit failures, not oversized journal records or success', async () => {
  const expected = required[1];
  const first = receipt(expected, [{ id: 'large', text: 'x'.repeat(500000) }]).response;
  const result = await completeToolRead({ first, ...expected, next: () => assert.fail('no extra page') });
  assert.equal(result.readComplete, false);
  assert.equal(result.readFailure, 'read_byte_limit');
  assert.equal(result.response.body.ok, false);
  assert.equal(result.response.body.complete, false);
  assert.ok(JSON.stringify(result).length < 1000);
});
