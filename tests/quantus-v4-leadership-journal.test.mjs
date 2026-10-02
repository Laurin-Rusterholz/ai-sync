import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadershipJournal, JOURNAL_LIMITS } from '../runtime/quantus-v3/src/leadership-journal.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';

const ID = { callId: 'lead-call-1', requestHash: 'a'.repeat(64) };
const REQUEST = { instructions: 'Trusted policy', input: [{ role: 'user', content: 'job' }], tools: [] };
const RESPONSE = { outcome: 'settled', actualMicros: 1, usageReceiptId: 'resp_1', result: { usable: true, text: 'reviewed' } };
const TOOL = { confirmed: true, response: { status: 200, body: { requestId: 'r1', applied: true } } };


test('actual idempotency envelope persists ordered exchanges and survives a fresh journal instance', async () => {
  const { journal, store, make } = await setup();
  assert.deepEqual(await journal.read(), []);
  await journal.begin({ ...ID, request: REQUEST });
  await journal.recordResponse({ ...ID, response: RESPONSE });
  await journal.recordTool({ ...ID, tool: TOOL });
  const entries = await make().read();
  assert.deepEqual(entries[0].request, REQUEST);
  assert.deepEqual(entries[0].response, RESPONSE);
  assert.deepEqual(entries[0].tool, TOOL);
  const puts = store.stats.puts;
  await journal.recordResponse({ ...ID, response: RESPONSE });
  assert.equal(store.stats.puts, puts, 'replay does not write a second response');
});

test('same call with changed request hash, request body, response or tool cannot replay success', async () => {
  const { journal } = await setup();
  await journal.begin({ ...ID, request: REQUEST });
  await assert.rejects(journal.begin({ ...ID, requestHash: 'b'.repeat(64), request: REQUEST }), /journal_request_conflict/);
  await assert.rejects(journal.begin({ ...ID, request: { ...REQUEST, instructions: 'changed' } }), /journal_record_conflict/);
  await journal.recordResponse({ ...ID, response: RESPONSE });
  await assert.rejects(journal.recordResponse({ ...ID, response: { ...RESPONSE, actualMicros: 2 } }), /journal_record_conflict/);
  await journal.recordTool({ ...ID, tool: TOOL });
  await assert.rejects(journal.recordTool({ ...ID, tool: { ...TOOL, confirmed: false } }), /journal_record_conflict/);
});

test('out-of-order records cannot hide an absent request or model response', async () => {
  const { journal } = await setup();
  await assert.rejects(journal.recordResponse({ ...ID, response: RESPONSE }), /journal_request_missing/);
  await journal.begin({ ...ID, request: REQUEST });
  await assert.rejects(journal.recordTool({ ...ID, tool: TOOL }), /journal_response_missing/);
});

test('expired and replaced leases reject new writes AND already acknowledged replay requests', async () => {
  for (const replacement of [false, true]) {
    const { journal, store, setNow } = await setup();
    await journal.begin({ ...ID, request: REQUEST });
    if (replacement) store.forceWrite(d => { d.automation.activeLease.holder = 'worker-b'; return d; });
    else setNow(T + 121000);
    const puts = store.stats.puts;
    await assert.rejects(journal.begin({ ...ID, request: REQUEST }), /lease_(expired|foreign_holder)/);
    await assert.rejects(journal.recordResponse({ ...ID, response: RESPONSE }), /lease_(expired|foreign_holder)/);
    assert.equal(store.stats.puts, puts);
  }
});

test('CAS retries recheck fresh time and preserve a competing user change', async () => {
  const s = await setup();
  s.onMutation(attempt => { if (attempt === 0) s.store.forceWrite(d => { d.userEdit = 'retained'; return d; }); });
  await s.journal.begin({ ...ID, request: REQUEST });
  assert.equal(s.store.snapshot().userEdit, 'retained');
  assert.equal(s.store.stats.conflicts, 1);
  s.onMutation(attempt => { if (attempt === 0) s.store.forceWrite(d => d); else s.setNow(T + 121000); });
  await assert.rejects(s.journal.recordResponse({ ...ID, response: RESPONSE }), /lease_expired/);
  assert.equal(s.store.snapshot().automation.runtime.runsByKey[RUN].leadershipJournal.entries[0].response, null);
});

test('removed or corrupted journal is never silently initialized over its marker', async () => {
  for (const corrupt of [j => { delete j.leadershipJournal; }, j => { j.leadershipJournal.entries[0].request.text = '{}'; }]) {
    const s = await setup();
    await s.journal.begin({ ...ID, request: REQUEST });
    s.store.forceWrite(d => { corrupt(d.automation.runtime.runsByKey[RUN]); return d; });
    await assert.rejects(s.journal.read(), /journal_invalid/);
    await assert.rejects(s.journal.begin({ ...ID, request: REQUEST }), /journal_invalid/);
  }
});

test('large active response is stored once while the real idempotency receipt stays small', async () => {
  const { journal, store } = await setup();
  await journal.begin({ ...ID, request: REQUEST });
  const response = { ...RESPONSE, result: { usable: true, text: 'x'.repeat(100000) } };
  await journal.recordResponse({ ...ID, response });
  assert.equal((await journal.read())[0].response.result.text.length, 100000);
  assert.ok(JSON.stringify(store.snapshot().automation.idempotencyByKey).length < 10000);
});

test('ambiguous JSON, oversized payloads and null records fail before mutation', async () => {
  const s = await setup();
  const hole = []; hole.length = 1; hole.extra = 'not-index-zero';
  for (const request of [null, { v: undefined }, { v: NaN }, { v: hole }, { text: 'x'.repeat(JOURNAL_LIMITS.requestBytes) }]) {
    const puts = s.store.stats.puts;
    await assert.rejects(s.journal.begin({ ...ID, request }), /journal_payload_/);
    assert.equal(s.store.stats.puts, puts);
  }
});

test('independent readback rejects a false success receipt', async () => {
  const s = await setup();
  const lyingCore = { read: s.core.read, async mutate(args) {
    const before = s.store.snapshot();
    const out = await s.core.mutate(args);
    s.store.forceWrite(() => before);
    return out;
  } };
  const journal = createLeadershipJournal({ core: lyingCore, clock: s.clock, runKey: RUN, verifiedScope: s.scope });
  await assert.rejects(journal.begin({ ...ID, request: REQUEST }), /journal_readback_failed/);
});

test('pending responses reserve worst-case room before another model call can begin', async () => {
  const s = await setup();
  await s.journal.begin({ ...ID, request: REQUEST });
  await s.journal.begin({ ...ID, callId: 'lead-call-2', request: REQUEST });
  await assert.rejects(s.journal.begin({ ...ID, callId: 'lead-call-3', request: REQUEST }), /journal_core_capacity/);
  assert.equal((await s.journal.read()).length, 2);
  await s.journal.recordResponse({ ...ID, response: RESPONSE });
  await s.journal.begin({ ...ID, callId: 'lead-call-3', request: REQUEST });
  assert.equal((await s.journal.read()).length, 3);
});
