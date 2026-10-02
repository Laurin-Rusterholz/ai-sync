import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorkArtifactStore } from '../runtime/quantus-v3/src/work-artifact-store.mjs';
import { WORK_PAYLOAD_BYTES } from '../runtime/quantus-v3/src/leadership-journal.mjs';
import { artifactFixture } from './fixtures/quantus-v4-artifact-fixture.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');
const content = JSON.stringify({ message: 'Geschützter Originaltext.' });

test('create-only upload is generation-pinned and verified; repeated content cannot overwrite', async () => {
  const s = artifactFixture();
  const first = await s.store.put({ text: content, hash: digest(content) });
  const second = await s.store.put({ text: content, hash: digest(content) });
  assert.deepEqual(second, first);
  assert.equal(s.objects.size, 1);
  assert.equal(await s.store.read(first), content);
  for (const c of s.calls) {
    const url = new URL(c.url);
    assert.equal(url.origin, 'https://storage.googleapis.com');
    assert.equal(c.options.redirect, 'error');
    assert.equal(c.options.headers.authorization, 'Bearer test-token');
    assert.ok(!url.searchParams.has('access_token'));
    if (c.options.method === 'POST') {
      assert.equal(url.searchParams.get('ifGenerationMatch'), '0');
      assert.equal(url.searchParams.get('name'), `quantus-v4/quantus/work/${digest(content)}.json`);
      assert.ok(!url.searchParams.has('predefinedAcl'));
    }
    if (url.searchParams.get('alt') === 'media') assert.equal(url.searchParams.get('generation'), first.generation);
  }
});

test('foreign bucket/tenant, arbitrary object names and extra fields fail before any request', async () => {
  const s = artifactFixture(), ref = await s.store.put({ text: content, hash: digest(content) });
  for (const change of [{ bucket: 'foreign-bucket' }, { objectName: ref.objectName.replace('/quantus/', '/foreign/') },
    { objectName: 'https://attacker.invalid/steal' }, { url: 'https://attacker.invalid' }, { generation: 101 }]) {
    const calls = s.calls.length;
    await assert.rejects(s.store.read({ ...ref, ...change }), /artifact_reference_invalid/);
    assert.equal(s.calls.length, calls);
  }
});

test('hash changes, missing objects and replaced generations cannot be mistaken for the saved artifact', async () => {
  for (const mode of ['hash', 'missing', 'generation']) {
    const s = artifactFixture(), ref = await s.store.put({ text: content, hash: digest(content) });
    if (mode === 'hash') s.objects.get(ref.objectName).text = content.replace('Original', 'Geändert');
    if (mode === 'missing') s.objects.delete(ref.objectName);
    if (mode === 'generation') s.objects.get(ref.objectName).generation = '999';
    await assert.rejects(s.store.read(ref), /artifact_(hash_mismatch|read_failed)/);
  }
});

test('public-access prevention is required on write and reread, including when revoked later', async () => {
  const s = artifactFixture();
  s.setPrivate(false);
  await assert.rejects(s.store.put({ text: content, hash: digest(content) }), /artifact_bucket_not_private/);
  assert.equal(s.objects.size, 0);
  s.setPrivate(true);
  const ref = await s.store.put({ text: content, hash: digest(content) });
  s.setPrivate(false);
  await assert.rejects(s.store.read(ref), /artifact_bucket_not_private/);
});

test('request deadlines include credential acquisition, fetch and a stalled streaming body', async () => {
  for (const mode of ['token', 'fetch', 'body']) {
    const never = () => new Promise(() => {});
    const store = createWorkArtifactStore({ bucket: 'quantus-test-artifacts', tenant: 'quantus', timeoutMs: 20,
      getAccessToken: mode === 'token' ? never : async () => 'test-token',
      fetchImpl: mode === 'fetch' ? never : async () => new Response(new ReadableStream({ start() {} })) });
    await assert.rejects(store.put({ text: content, hash: digest(content) }), /artifact_request_interrupted/);
  }
});

test('oversized bodies, invalid metadata and reflected credential errors fail without exposing data', async () => {
  for (const mode of ['large', 'metadata', 'network']) {
    const s = artifactFixture({ intercept(url) {
      if (mode === 'network') throw new Error('secret-token-and-original-message');
      if (mode === 'large') return new Response('x'.repeat(65537));
      if (url.includes('fields=bucket')) return new Response('{malformed');
    } });
    await assert.rejects(s.store.put({ text: content, hash: digest(content) }), e => {
      assert.ok(!e.message.includes('secret-token-and-original-message'));
      return /artifact_(response_too_large|metadata_invalid|request_failed)/.test(e.message);
    });
  }
});

test('incorrect payload hashes and size limits are rejected before upload', async () => {
  const s = artifactFixture();
  await assert.rejects(s.store.put({ text: content, hash: 'a'.repeat(64) }), /artifact_payload_invalid/);
  const big = 'x'.repeat(WORK_PAYLOAD_BYTES + 1);
  await assert.rejects(s.store.put({ text: big, hash: digest(big) }), /artifact_payload_invalid/);
  assert.equal(s.calls.length, 0);
});
