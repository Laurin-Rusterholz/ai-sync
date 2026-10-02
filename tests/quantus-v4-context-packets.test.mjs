import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFixture } from './fixtures/quantus-v4-artifact-fixture.mjs';
import { createContextPackets, contextFingerprint, packetCursor, PACKET_BYTES } from '../runtime/quantus-v3/src/context-packets.mjs';
import { createLeadershipCompletionCheck, requiredLeadershipReads } from '../runtime/quantus-v3/src/leadership-coverage.mjs';
import { createLeadershipGateway } from '../runtime/quantus-v3/src/leadership-gateway.mjs';
import { fragmentContextItems, assembleContextItems } from '../netlify/lib/quantus-v4-context-fragments.mjs';
import { assertNoProviderSecrets } from '../netlify/lib/quantus-v3-auth.mjs';

const runKey = 'quantus:2026-10-02:process09:4.0', tenant = 'quantus';
const expected = { query: 'run.workset', scopeId: 'run_2026-10-02' };
const items = Array.from({ length: 8 }, (_, i) => ({ id: `ctx_task_${i}`, text: String(i).repeat(80000), sourceMissing: false }));
function read(originals = items, revision = 8, query = expected.query, scopeId = expected.scopeId) {
  return { confirmed: true, readComplete: true, readPages: [], response: { status: 200, body: {
    ok: true, query, scopeId, dataRevision: revision, serverNow: '2026-10-02T07:01:00Z', requestId: 'source-read',
    items: originals, count: originals.length, complete: true, hasMore: false, pageStatus: 'done', cursor: null,
  } } };
}
function setup() {
  const a = artifactFixture({ maxPayloadBytes: 3 * 1024 * 1024 });
  let active = true;
  const make = (override = {}) => createContextPackets({ artifacts: a.store, runKey, tenant,
    lease: async () => { if (!active) throw new Error('lease revoked'); }, ...override });
  return { a, make, revoke: () => { active = false; } };
}
async function capture(s, originals = items) {
  let receipt = await s.make().capture(read(originals));
  const receipts = [receipt];
  while (receipt.response.body.hasMore) {
    receipt = await s.make().resume({ ...expected, cursor: receipt.response.body.cursor }); receipts.push(receipt);
  }
  return receipts;
}
function entry(receipt, cursor = '') {
  return { response: { result: { toolCalls: [{ name: 'quantus_context', arguments: { ...expected, cursor } }] } }, tool: receipt };
}
function history(receipts) {
  const required = requiredLeadershipReads(runKey);
  return [
    { response: { result: { toolCalls: [{ name: 'quantus_context', arguments: { ...required[0], cursor: '' } }] } },
      tool: read([{ id: 'policy_4.0', policyVersion: '4.0' }], 8, required[0].query, required[0].scopeId) },
    ...receipts.map((r, i) => entry(r, i ? receipts[i - 1].response.body.cursor : '')),
    { response: { result: { toolCalls: [{ name: 'quantus_run_status', arguments: { cursor: '' } }] } },
      tool: read([{ id: 'status_2026-10-02', runId: expected.scopeId, policyVersion: '4.0' }], 8, required[2].query, required[2].scopeId) },
  ];
}

test('large immutable context spans bounded packets and survives fresh worker instances', async () => {
  const s = setup(), receipts = await capture(s);
  assert.ok(receipts.length > 1);
  assert.deepEqual(receipts.flatMap(r => r.response.body.items), items);
  for (const [index, r] of receipts.entries()) {
    assert.equal(r.contextPacket.index, index); assert.equal(r.contextPacket.contentHash, contextFingerprint(items));
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < PACKET_BYTES + 8192);
    assert.equal(r.readComplete, false, 'a packet never claims whole-workset completeness');
  }
  const manifest = JSON.parse(await s.a.store.read(receipts[0].contextPacket.manifest));
  assert.equal(manifest.complete, true); assert.equal(manifest.itemCount, 8);
  assert.equal(manifest.parts.length, receipts.length);
});

test('oversized Unicode original is losslessly split and reconstructable, never a truncated item', async () => {
  const s = setup(), original = { id: 'large', text: '🪵\\\"\n'.repeat(55000), sourceMissing: false };
  const receipts = await capture(s, [original]);
  const fragments = receipts.flatMap(r => r.response.body.fragments);
  assert.ok(fragments.length > 2); assert.equal(receipts.flatMap(r => r.response.body.items).length, 0);
  assert.deepEqual(JSON.parse(fragments.map(f => f.jsonFragment).join('')), original);
  fragments.forEach((f, i) => { assert.equal(f.fragmentIndex, i); assert.equal(f.fragmentCount, fragments.length); });
});

test('snapshot resumption refuses another run, scope, tampering, missing artifacts and revoked authority', async () => {
  const s = setup(), first = await s.make().capture(read()), cursor = first.response.body.cursor;
  await assert.rejects(s.make({ runKey: 'quantus:2026-10-03:process09:4.0' }).resume({ ...expected, cursor }), /scope_mismatch/);
  await assert.rejects(s.make().resume({ ...expected, scopeId: 'run_2026-10-03', cursor }), /scope_mismatch/);
  await assert.rejects(s.make().resume({ ...expected, cursor: packetCursor(first.contextPacket.manifest, 999) }), /cursor_invalid/);
  await assert.rejects(s.make().resume({ ...expected, cursor, currentRevision: 7 }), /revision_regressed/);
  const manifest = JSON.parse(await s.a.store.read(first.contextPacket.manifest));
  const saved = s.a.objects.get(manifest.parts[1].objectName);
  s.a.objects.delete(manifest.parts[1].objectName);
  await assert.rejects(s.make().resume({ ...expected, cursor }), /artifact_read_failed/);
  s.a.objects.set(manifest.parts[1].objectName, { ...saved, text: saved.text + ' ' });
  await assert.rejects(s.make().resume({ ...expected, cursor }), /artifact_hash_mismatch/);
  s.a.objects.set(manifest.parts[1].objectName, saved); s.revoke();
  await assert.rejects(s.make().resume({ ...expected, cursor }), /lease revoked/);
});

test('incomplete capture and unavailable private storage never yield a packet success', async () => {
  const s = setup();
  await assert.rejects(s.make().capture({ ...read(), readComplete: false }), /snapshot_incomplete/);
  s.a.setPrivate(false);
  await assert.rejects(s.make().capture(read()), /bucket_not_private/);
  const c = new AbortController(); c.abort();
  await assert.rejects(s.make({ signal: c.signal }).capture(read()), /packet_interrupted/);
});

test('coverage requires every consecutive packet and provides the exact missing continuation', async () => {
  const s = setup(), receipts = await capture(s);
  const checker = createLeadershipCompletionCheck({ runKey, gateway: { execute: () => assert.fail('no refresh before full chain') } });
  const partial = await checker({ entries: history(receipts.slice(0, 2)) });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.requiredReads, [{ ...expected, cursor: receipts[1].response.body.cursor }]);
  for (const bad of [receipts.slice(1), [receipts.at(-1)], [receipts[0], receipts[2]], [receipts[0], receipts[0]]]) {
    assert.equal((await checker({ entries: history(bad) })).complete, false);
  }
  const entries = history(receipts);
  entries.splice(3, 0, { response: { result: { toolCalls: [{ name: 'quantus_command' }] } }, tool: { response: { body: { applied: true } } } });
  assert.deepEqual((await checker({ entries })).requiredReads, [expected], 'write during a packet chain invalidates the whole snapshot');
});

test('fresh full-snapshot hash detects arrivals and missing originals after all packets were read', async () => {
  const s = setup(), receipts = await capture(s), entries = history(receipts);
  for (const mode of ['same', 'changed', 'missing']) {
    const originals = structuredClone(items);
    if (mode === 'changed') originals[7].text += 'new';
    if (mode === 'missing') originals[7].sourceMissing = true;
    const fresh = await s.make().capture(read(originals, 90));
    const checker = createLeadershipCompletionCheck({ runKey, gateway: { async execute(call) {
      if (call.arguments?.query === 'run.workset') return fresh;
      const r = structuredClone(call.name === 'quantus_run_status' ? entries.at(-1).tool : entries[0].tool);
      r.response.body.dataRevision = 90; return r;
    } } });
    const result = await checker({ entries });
    assert.equal(result.complete, mode === 'same');
    if (mode === 'same') assert.equal(result.proof.itemCount, 8);
    else assert.equal(result.reason, mode === 'missing' ? 'context_original_missing' : 'context_contents_changed');
  }
});

test('packets from two complete snapshots cannot be mixed into one coverage claim', async () => {
  const s = setup(), first = await capture(s), other = await capture(s, items.map(i => ({ ...i, title: 'changed' })));
  const mixed = history(first);
  mixed[2] = entry(other[1], first[0].response.body.cursor);
  const checker = createLeadershipCompletionCheck({ runKey, gateway: { execute: () => assert.fail('no refresh') } });
  const result = await checker({ entries: mixed });
  assert.equal(result.complete, false); assert.deepEqual(result.requiredReads, [expected]);
});

test('gateway reauthorizes each packet but resumes its immutable revision without live API cursor reuse', async () => {
  const s = setup(), requests = []; let revision = 8, authorized = true;
  const make = () => createLeadershipGateway({ runKey, tenant, artifacts: s.a.store, clock: { now: () => 1790935200000 },
    lease: async () => ({ holder: 'worker', fence: 1 }), jobTokenIssuer: { mint: async () => 'test-token' },
    toolsEnabled: { quantus_context: true }, transport: { async send(r) {
      requests.push(r);
      if (!authorized) return { status: 403, body: { ok: false } };
      assert.ok(!r.searchParams.cursor?.startsWith('q4packet.'));
      const index = r.searchParams.cursor ? Number(r.searchParams.cursor) : 0;
      const result = read([items[index]], revision).response;
      if (index < items.length - 1) Object.assign(result.body, { hasMore: true, complete: false, pageStatus: 'more', cursor: String(index + 1) });
      return result;
    } } });
  const execute = cursor => make().execute({ name: 'quantus_context', arguments: { ...expected, cursor } }, { responseId: 'response_1', callId: 'call_1' });
  const first = await execute(''); assert.equal(requests.length, items.length);
  revision++;
  const second = await execute(first.response.body.cursor);
  assert.equal(second.contextPacket.index, 1); assert.equal(second.response.body.dataRevision, 8);
  assert.equal(requests.length, items.length + 1, 'only reauthorization reads live state during packet resumption');
  authorized = false;
  await assert.rejects(execute(second.response.body.cursor), /authorization_unconfirmed/);
});

test('C2 fragments reconstruct a multi-megabyte original and reject missing, altered, reordered or foreign pieces', () => {
  const originals = [{ kind: 'run_context', tenant, jobId: expected.scopeId, id: 'huge', text: '🧩\\'.repeat(350000) }];
  const fragments = fragmentContextItems(originals);
  assert.ok(fragments.length > 50);
  assert.ok(fragments.every(f => Buffer.byteLength(JSON.stringify(f)) < 96 * 1024));
  assert.deepEqual(assembleContextItems(fragments), originals);
  for (const mode of ['missing', 'altered', 'reordered', 'foreign']) {
    const bad = structuredClone(fragments);
    if (mode === 'missing') bad.pop();
    if (mode === 'altered') bad[1].contextFragment.text += 'x';
    if (mode === 'reordered') [bad[0], bad[1]] = [bad[1], bad[0]];
    if (mode === 'foreign') bad[1].jobId = 'foreign';
    assert.throws(() => assembleContextItems(bad), /context_fragments/);
  }
});

test('large-original secret scan has a bounded explicit override and scans across future fragment boundaries', () => {
  const text = 'x'.repeat(1100000);
  assert.equal(assertNoProviderSecrets({ text }).ok, false, 'ordinary callers retain the default limit');
  assert.equal(assertNoProviderSecrets({ text }, { maxStringLength: 16 * 1024 * 1024 }).ok, true);
  const secret = ' sk-' + 'A'.repeat(25);
  assert.equal(assertNoProviderSecrets({ text: text + secret }, { maxStringLength: 16 * 1024 * 1024 }).ok, false);
  for (const maxStringLength of [0, NaN, Infinity, 16 * 1024 * 1024 + 1, '16000000'])
    assert.equal(assertNoProviderSecrets({ text }, { maxStringLength }).ok, false);
});
