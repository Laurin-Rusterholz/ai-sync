import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadershipJournal, JOURNAL_LIMITS, encodeRuntimePayload } from '../runtime/quantus-v3/src/leadership-journal.mjs';
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
  assert.ok(!JSON.stringify(store.snapshot()).includes('x'.repeat(1000)), 'large payload is external, not in core');
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
  const journal = createLeadershipJournal({ core: lyingCore, clock: s.clock, runKey: RUN, verifiedScope: s.scope, artifacts: s.artifacts.store });
  await assert.rejects(journal.begin({ ...ID, request: REQUEST }), /journal_readback_failed/);
});

test('external payload references keep core bounded without reserving megabytes of inline response space', async () => {
  const s = await setup();
  await s.journal.begin({ ...ID, request: REQUEST });
  await s.journal.begin({ ...ID, callId: 'lead-call-2', request: REQUEST });
  await s.journal.begin({ ...ID, callId: 'lead-call-3', request: REQUEST });
  assert.equal((await s.journal.read()).length, 3);
  assert.ok(JSON.stringify(s.store.snapshot()).length < 18000);
  s.store.forceWrite(d => { d.padding = 'x'.repeat(JOURNAL_LIMITS.coreBytes - 20000); return d; });
  await assert.rejects(s.journal.begin({ ...ID, callId: 'lead-call-4', request: REQUEST }), /journal_core_capacity/);
});

function inlineJournal(s) {
  const journal = { schemaVersion: 1, entries: [{ ...ID, createdAtMs: T,
    request: encodeRuntimePayload(REQUEST, JOURNAL_LIMITS.requestBytes),
    response: encodeRuntimePayload(RESPONSE, JOURNAL_LIMITS.responseBytes),
    tool: encodeRuntimePayload(TOOL, JOURNAL_LIMITS.toolBytes) }] };
  s.store.forceWrite(d => { const run = d.automation.runtime.runsByKey[RUN];
    run.leadershipJournalInitialized = true; run.leadershipJournal = structuredClone(journal); return d; });
  return journal;
}

test('legacy inline journal moves only after external readback and retains exact request/result content', async () => {
  const s = await setup();
  inlineJournal(s);
  const before = await s.journal.read();
  await assert.rejects(s.journal.begin({ ...ID, request: REQUEST }), /journal_migration_required/);
  assert.deepEqual(await s.journal.migrateInline(), { migrated: true });
  assert.deepEqual(await s.make().read(), before);
  const saved = s.store.snapshot().automation.runtime.runsByKey[RUN].leadershipJournal;
  assert.equal(saved.schemaVersion, 2);
  assert.ok(saved.entries.every(e => ['request', 'response', 'tool'].every(f => !Object.hasOwn(e[f], 'text'))));
  const puts = s.store.stats.puts;
  assert.deepEqual(await s.make().migrateInline(), { migrated: false });
  assert.equal(s.store.stats.puts, puts);
});

test('storage failure cannot remove inline journal contents', async () => {
  const s = await setup(), original = inlineJournal(s);
  s.artifacts.setPrivate(false);
  await assert.rejects(s.journal.migrateInline(), /artifact_bucket_not_private/);
  assert.deepEqual(s.store.snapshot().automation.runtime.runsByKey[RUN].leadershipJournal, original);
});

test('concurrent legacy revision during migration is preserved and prevents replacement', async () => {
  const s = await setup(); inlineJournal(s);
  s.onMutation(attempt => { if (attempt === 0) s.store.forceWrite(d => {
    const entry = d.automation.runtime.runsByKey[RUN].leadershipJournal.entries[0];
    entry.response = encodeRuntimePayload({ ...RESPONSE, actualMicros: 2 }, JOURNAL_LIMITS.responseBytes);
    return d;
  }); });
  await assert.rejects(s.journal.migrateInline(), /journal_migration_conflict/);
  const kept = s.store.snapshot().automation.runtime.runsByKey[RUN].leadershipJournal;
  assert.equal(kept.schemaVersion, 1);
  assert.equal(JSON.parse(kept.entries[0].response.text).actualMicros, 2);
});

test('an expired lease after artifact upload cannot commit a new journal reference', async () => {
  const s = await setup();
  const artifacts = { ...s.artifacts.store, async put(args) {
    const ref = await s.artifacts.store.put(args); s.setNow(T + 121000); return ref;
  } };
  const journal = createLeadershipJournal({ core: s.core, clock: s.clock, runKey: RUN, verifiedScope: s.scope, artifacts });
  await assert.rejects(journal.begin({ ...ID, request: REQUEST }), /lease_expired/);
  assert.equal(s.store.snapshot().automation.runtime.runsByKey[RUN].leadershipJournal, undefined);
});

test('large provider response uses the separate 3 MiB limit while request and tool limits remain bounded', async () => {
  const s = await setup();
  await s.journal.begin({ ...ID, request: REQUEST });
  const response = { ...RESPONSE, result: { usable: true, text: 'x'.repeat(600000) } };
  await s.journal.recordResponse({ ...ID, response });
  assert.deepEqual((await s.journal.read())[0].response, response);
  assert.ok(JSON.stringify(s.store.snapshot()).length < 15000);
  await assert.rejects(s.journal.recordTool({ ...ID, tool: { text: 'x'.repeat(JOURNAL_LIMITS.toolBytes) } }), /journal_payload_too_large/);
});

test('foreign tenant and aborted migration cannot mutate journal state', async () => {
  const s = await setup();
  assert.throws(() => createLeadershipJournal({ core: s.core, clock: s.clock, runKey: RUN.replace('quantus:', 'foreign:'),
    verifiedScope: s.scope, artifacts: s.artifacts.store }), /journal_scope_mismatch/);
  const original = inlineJournal(s), controller = new AbortController();
  const journal = createLeadershipJournal({ core: s.core, clock: s.clock, runKey: RUN, verifiedScope: s.scope,
    artifacts: s.artifacts.store, signal: controller.signal });
  s.onMutation(() => controller.abort());
  await assert.rejects(journal.migrateInline(), /journal_interrupted/);
  assert.deepEqual(s.store.snapshot().automation.runtime.runsByKey[RUN].leadershipJournal, original);
});

test('aggregate read limit is checked before downloading an oversized full transcript', async () => {
  const s = await setup();
  const text = 'x'.repeat(2900000);
  for (let i = 0; i < 6; i++) {
    const id = { ...ID, callId: `large-call-${i}` };
    await s.journal.begin({ ...id, request: REQUEST });
    await s.journal.recordResponse({ ...id, response: { ...RESPONSE, usageReceiptId: `response-${i}`, result: { text } } });
  }
  const requests = s.artifacts.calls.length;
  await assert.rejects(s.journal.read(), /journal_read_budget/);
  assert.equal(s.artifacts.calls.length, requests);
  assert.ok(JSON.stringify(s.store.snapshot()).length < 40000);
});
