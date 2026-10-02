import test from 'node:test';
import assert from 'node:assert/strict';
import { readLeadershipContext } from '../runtime/quantus-v3/src/leadership-context.mjs';
import { createLeadershipGateway } from '../runtime/quantus-v3/src/leadership-gateway.mjs';
import { projectItem, projectPage } from '../netlify/lib/quantus-v3-read-helpers.mjs';

const base = { query: 'run.context', scopeId: 'run_2026-10-02' };
const page = (items, extra = {}) => ({ ...base, ok: true, requestId: 'r1', serverNow: '2026-10-02T12:00:00Z', dataRevision: 5,
  items, count: items.length, hasMore: false, complete: true, pageStatus: 'done', cursor: null, ...extra });
function source(pages) {
  const calls = [];
  return { calls, async execute(call) { calls.push(call); return { confirmed: true, response: { body: pages[Math.min(calls.length - 1, pages.length - 1)] } }; } };
}

test('all pages use signed continuation cursors and one revision before completeness is declared', async () => {
  const gateway = source([page([{ id: 'a' }], { hasMore: true, complete: false, pageStatus: 'more', cursor: 'signed-2' }), page([{ id: 'b' }])]);
  const result = await readLeadershipContext({ gateway, ...base });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map(i => i.id), ['a', 'b']);
  assert.equal(result.pages, 2); assert.equal(result.dataRevision, 5);
  assert.equal(gateway.calls[1].arguments.cursor, 'signed-2');
});

test('repeated cursors, duplicate items and changed revisions remain incomplete', async () => {
  const first = page([{ id: 'a' }], { hasMore: true, complete: false, pageStatus: 'more', cursor: 'signed-2' });
  for (const [second, reason] of [
    [page([{ id: 'b' }], { dataRevision: 6 }), 'data_revision_changed'],
    [page([{ id: 'a' }]), 'duplicate_or_invalid_item'],
    [page([{ id: 'b' }], { hasMore: true, complete: false, pageStatus: 'more', cursor: 'signed-2' }), 'pagination_invalid'],
  ]) {
    const result = await readLeadershipContext({ gateway: source([first, second]), ...base });
    assert.equal(result.complete, false); assert.equal(result.reason, reason);
  }
});

test('partial final pages, wrong scope and budget exhaustion never become complete context', async () => {
  for (const [p, options, reason] of [
    [page([], { complete: false, pageStatus: 'aborted' }), {}, 'page_incomplete'],
    [page([{ id: 'a' }], { scopeId: 'foreign' }), {}, 'page_binding_invalid'],
    [page([{ id: 'a', text: 'long' }]), { maxBytes: 2 }, 'context_byte_limit'],
    [page([{ id: 'a' }], { hasMore: true, complete: false, pageStatus: 'more', cursor: 'next' }), { maxPages: 1 }, 'context_page_limit'],
  ]) {
    const result = await readLeadershipContext({ gateway: source([p]), ...base, ...options });
    assert.equal(result.complete, false); assert.equal(result.reason, reason);
  }
});

test('an interrupted load makes no call; unconfirmed pages do not contribute items', async () => {
  const signal = AbortSignal.abort(); const gateway = source([page([])]);
  await assert.rejects(readLeadershipContext({ gateway, ...base, signal }), /context_read_interrupted/);
  assert.equal(gateway.calls.length, 0);
  const result = await readLeadershipContext({ ...base, gateway: { execute: async () => ({ confirmed: false }) } });
  assert.equal(result.reason, 'page_unconfirmed'); assert.deepEqual(result.items, []);
});

test('gateway respects the policy query page ceiling instead of requesting 50 and receiving a rejection', async () => {
  let request;
  const gateway = createLeadershipGateway({ runKey: 'quantus:2026-10-02:process09:4.0', tenant: 'quantus', clock: { now: () => 1 },
    lease: async () => ({ holder: 'h', fence: 1 }), jobTokenIssuer: { mint: async () => 'fixture' }, toolsEnabled: { quantus_context: true },
    transport: { send: async r => { request = r; return { status: 200, body: page([{ id: 'policy_3.0' }], { query: 'policy.current', scopeId: 'policy_current' }) }; } } });
  const result = await readLeadershipContext({ gateway, query: 'policy.current', scopeId: 'policy_current' });
  assert.equal(result.complete, true); assert.equal(request.searchParams.pageSize, '10');
  assert.equal(request.searchParams.jobId, 'run_2026-10-02');
});

test('policy projection carries limits and source identities but never nested private extras', () => {
  const out = projectItem('policy', { id: 'policy_3.0', limits: { maxWaitDays: 30, maxTokens: { secret: 'private' }, private: 'private' },
    closure: { earliestLocalTime: '23:00', requiredReceipts: ['process09', 'close23'], private: 'private' },
    featureFlags: { writes: 'dry_run', runner: 'dry_run', providers: 'dry_run', key: 'private' },
    requiredSources: [{ id: 'gmail-inbox', kind: 'mail', privateAccount: 'private' }] });
  assert.deepEqual(out.limits, { maxWaitDays: 30 });
  assert.deepEqual(out.requiredSources, [{ id: 'gmail-inbox', kind: 'mail' }]);
  assert.deepEqual(out.closure.requiredReceipts, ['process09', 'close23']);
  assert.ok(!JSON.stringify(out).includes('private'));
  const invalid = projectPage('policy.current', [{ id: 'policy', requiredSources: [{ id: 'missing-kind' }] }]);
  assert.equal(invalid.usable, false);
});
