import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGmailOriginalStore, GMAIL_ORIGINAL_LIMITS } from '../runtime/quantus-v3/src/gmail-original-store.mjs';
import { createGmailV4Reader } from '../runtime/quantus-v3/src/gmail-v4-reader.mjs';
import { artifactFixture } from './fixtures/quantus-v4-artifact-fixture.mjs';

const account = 'reader@example.test';
const source = text => JSON.stringify({ missing: false, account, id: 'mail1', original: { id: 'mail1', text } });
const hash = text => createHash('sha256').update(text).digest('hex');
function setup(options = {}) {
  const fixture = artifactFixture();
  const config = { artifacts: fixture.store, tenant: 'quantus', account, sourceId: 'gmail-inbox', lease: async () => {}, ...options };
  return { fixture, config, store: createGmailOriginalStore(config) };
}
async function putJson(artifacts, value) {
  const text = JSON.stringify(value);
  return artifacts.put({ text, hash: hash(text) });
}

test('real Gmail reader output larger than one artifact survives byte splits and a fresh instance exactly', async () => {
  const text = 'Original: ä👩🏽‍💻\r\n'.repeat(110000);
  const original = { id: 'mail1', threadId: 'thread1', historyId: '1001', internalDate: '1790910000000',
    payload: { mimeType: 'text/plain', body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') } } };
  const reader = createGmailV4Reader({ account, getAccessToken: async () => ({ token: 'fixture' }), fetchImpl: async () => Response.json(original) });
  const mail = await reader.getMessage({ messageId: 'mail1' });
  const serialized = JSON.stringify(mail);
  assert.ok(Buffer.byteLength(serialized) > 3 * 1024 * 1024);
  const { fixture, config, store } = setup();
  const result = await store.put({ messageId: 'mail1', text: serialized });
  const resumed = await createGmailOriginalStore(config).read({ messageId: 'mail1', reference: result.reference });
  assert.equal(resumed.text, serialized); assert.deepEqual(resumed.original, mail);
  assert.equal(resumed.original.parts[0].text, text); assert.equal(result.contentHash, hash(serialized));
  assert.ok([...fixture.objects.values()].every(v => Buffer.byteLength(v.text) < 512 * 1024));
  const before = fixture.objects.size;
  assert.deepEqual(await store.put({ messageId: 'mail1', text: serialized }), result);
  assert.equal(fixture.objects.size, before);
});

test('scope and original identity prevent mailbox, source, tenant or message substitution', async () => {
  const { store, config, fixture } = setup();
  const out = await store.put({ messageId: 'mail1', text: source('private') });
  for (const change of [{ account: 'other@example.test' }, { tenant: 'other' }, { sourceId: 'other-source' }])
    await assert.rejects(createGmailOriginalStore({ ...config, ...change }).read({ messageId: 'mail1', reference: out.reference }), /manifest_invalid/);
  await assert.rejects(store.read({ messageId: 'other', reference: out.reference }), /manifest_invalid/);
  const count = fixture.objects.size;
  await assert.rejects(store.put({ messageId: 'other', text: source('private') }), /source_identity_mismatch/);
  await assert.rejects(store.put({ messageId: 'mail1', text: JSON.stringify({ missing: true, account, id: 'mail1' }) }), /source_identity_mismatch/);
  assert.equal(fixture.objects.size, count);
});

test('missing, changed or differently generated stored originals never pass readback', async () => {
  for (const mode of ['missing', 'hash', 'generation']) {
    const { store, fixture } = setup();
    const out = await store.put({ messageId: 'mail1', text: source('x'.repeat(300000)) });
    const manifest = JSON.parse(fixture.objects.get(out.reference.objectName).text), ref = manifest.parts[0];
    if (mode === 'missing') fixture.objects.delete(ref.objectName);
    if (mode === 'hash') fixture.objects.get(ref.objectName).text += ' ';
    if (mode === 'generation') fixture.objects.get(ref.objectName).generation = '999';
    await assert.rejects(store.read({ messageId: 'mail1', reference: out.reference }), /artifact_(read_failed|hash_mismatch|response_too_large)/);
  }
});

test('self-consistent forged manifests cannot reorder, omit, repeat or replace original parts', async () => {
  const { store, fixture } = setup();
  const a = await store.put({ messageId: 'mail1', text: source('a'.repeat(600000)) });
  const b = await store.put({ messageId: 'mail1', text: source('b'.repeat(600000)) });
  const ma = JSON.parse(fixture.objects.get(a.reference.objectName).text);
  const mb = JSON.parse(fixture.objects.get(b.reference.objectName).text);
  for (const parts of [[...ma.parts].reverse(), ma.parts.slice(1), [ma.parts[0], ma.parts[0], ma.parts[2]], [mb.parts[0], ...ma.parts.slice(1)]]) {
    const ref = await putJson(fixture.store, { ...ma, parts });
    await assert.rejects(store.read({ messageId: 'mail1', reference: ref }), /gmail_original_(manifest_invalid|part_invalid)/);
  }
  const part = JSON.parse(fixture.objects.get(ma.parts[0].objectName).text);
  const replaced = await putJson(fixture.store, { ...part, data: Buffer.alloc(GMAIL_ORIGINAL_LIMITS.partBytes, 97).toString('base64url') });
  const ref = await putJson(fixture.store, { ...ma, parts: [replaced, ...ma.parts.slice(1)] });
  await assert.rejects(store.read({ messageId: 'mail1', reference: ref }), /content_mismatch/);
});

test('an upload acknowledgement alone is insufficient; actual readback is mandatory', async () => {
  const { fixture } = setup();
  const store = createGmailOriginalStore({ tenant: 'quantus', account, sourceId: 'gmail', lease: async () => {},
    artifacts: { put: fixture.store.put, read: async () => '{}' } });
  await assert.rejects(store.put({ messageId: 'mail1', text: source('x') }), /artifact_mismatch/);
  assert.equal(fixture.objects.size, 1); // no manifest/cursor receipt is returned
});

test('lease loss and abort between parts stop further uploads and final receipt', async () => {
  let checks = 0;
  const { store, fixture } = setup({ lease: async () => { if (++checks === 5) throw new Error('lease_expired'); } });
  await assert.rejects(store.put({ messageId: 'mail1', text: source('x'.repeat(600000)) }), /lease_expired/);
  assert.equal(fixture.objects.size, 1);
  const controller = new AbortController(); controller.abort();
  const stopped = setup({ signal: controller.signal });
  await assert.rejects(stopped.store.put({ messageId: 'mail1', text: source('x') }), /interrupted/);
  assert.equal(stopped.fixture.objects.size, 0);
});

test('private storage revocation and lost upload receipt cannot produce a confirmed source', async () => {
  const { store, config, fixture } = setup();
  const out = await store.put({ messageId: 'mail1', text: source('x') });
  fixture.setPrivate(false);
  await assert.rejects(store.read({ messageId: 'mail1', reference: out.reference }), /artifact_bucket_not_private/);
  fixture.setPrivate(true);
  let once = true;
  const interrupted = createGmailOriginalStore({ ...config, artifacts: { ...fixture.store, async put(args) {
    const ref = await fixture.store.put(args);
    if (once) { once = false; throw new Error('lost_ack'); }
    return ref;
  } } });
  await assert.rejects(interrupted.put({ messageId: 'mail1', text: source('new') }), /lost_ack/);
  const retried = await interrupted.put({ messageId: 'mail1', text: source('new') });
  assert.equal((await store.read({ messageId: 'mail1', reference: retried.reference })).text, source('new'));
});

test('oversize, foreign originals and malformed manifest limits fail before uncontrolled reads', async () => {
  const { store, fixture } = setup();
  await assert.rejects(store.put({ messageId: 'mail1', text: 'x'.repeat(GMAIL_ORIGINAL_LIMITS.bytes + 1) }), /size_invalid/);
  await assert.rejects(store.put({ messageId: 'mail1', text: '{' }), /json_invalid/);
  await assert.rejects(store.put({ messageId: 'mail1', text: '{"text":"' + String.fromCharCode(0xd800) + '"}' }), /encoding_invalid/);
  assert.equal(fixture.objects.size, 0);
  const result = await store.put({ messageId: 'mail1', text: source('x') });
  const manifest = JSON.parse(fixture.objects.get(result.reference.objectName).text);
  for (const fields of [{ bytes: GMAIL_ORIGINAL_LIMITS.bytes + 1 }, { bytes: 0 }, { parts: [] }, { extra: 'unknown' }]) {
    const ref = await putJson(fixture.store, { ...manifest, ...fields });
    await assert.rejects(store.read({ messageId: 'mail1', reference: ref }), /manifest_invalid/);
  }
});
