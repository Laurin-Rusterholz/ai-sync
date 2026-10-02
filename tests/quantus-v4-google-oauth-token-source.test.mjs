import test from 'node:test';
import assert from 'node:assert/strict';
import { getStore, setEnvironmentContext } from '@netlify/blobs';
import { getValidAccessToken, updateTokenEmail } from '../netlify/lib/gcal-shared.mjs';
import { createGoogleOAuthTokenSource, createNetlifyGoogleTokenSource, GOOGLE_OAUTH_URL } from '../runtime/quantus-v3/src/google-oauth-token-source.mjs';

const T = 1790960000000;
const scope = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar';
const old = { access_token: 'private-old-access', refresh_token: 'private-refresh', expiry: T - 1, scope, userMetadata: 'keep' };
const refreshed = { access_token: 'private-new-access', token_type: 'Bearer', expires_in: 3600 };
function build({ credentials = old, handler = async () => Response.json(refreshed), options = {} } = {}) {
  let value = structuredClone(credentials), version = 1;
  const reads = [], writes = [], requests = [];
  const store = {
    async getWithMetadata(key, options) { reads.push({ key, options }); return value === null ? null : { data: structuredClone(value), etag: String(version), metadata: {} }; },
    async set(key, next, options) {
      writes.push({ key, options });
      if (value === null || options.onlyIfMatch !== String(version)) return { modified: false };
      value = JSON.parse(next); version++; return { modified: true, etag: String(version) };
    },
  };
  const config = { store, clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret', now: () => T,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return handler(url, init); }, ...options };
  return { source: createGoogleOAuthTokenSource(config), config, store, reads, writes, requests,
    value: () => structuredClone(value), replace(next) { value = structuredClone(next); version++; } };
}

test('valid token is read strongly on every call and only the access token leaves the private source', async () => {
  const f = build({ credentials: { ...old, expiry: T + 3600000 } });
  assert.deepEqual(await f.source.get(), { token: old.access_token });
  assert.deepEqual(f.reads, [{ key: 'tokens', options: { type: 'json', consistency: 'strong' } }]);
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
  f.replace(null);
  await assert.rejects(f.source.get(), /google_oauth_not_connected/);
});

test('refresh uses fixed Google endpoint, conditional store update and independent confirmation', async () => {
  const f = build();
  assert.deepEqual(await f.source.get(), { token: refreshed.access_token });
  const { url, init } = f.requests[0];
  assert.equal(url, GOOGLE_OAUTH_URL); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  const body = new URLSearchParams(init.body);
  assert.equal(body.get('refresh_token'), old.refresh_token);
  assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('scope'), null);
  assert.deepEqual(f.writes, [{ key: 'tokens', options: { onlyIfMatch: '1' } }]);
  assert.equal(f.reads.length, 2); assert.equal(f.value().expiry, T + 3600000);
  assert.equal(f.value().userMetadata, 'keep'); assert.equal(f.value().refresh_token, old.refresh_token);
});

test('a provider-rotated refresh token is persisted but never returned to the caller', async () => {
  const f = build({ handler: async () => Response.json({ ...refreshed, refresh_token: 'private-rotated-refresh' }) });
  assert.deepEqual(await f.source.get(), { token: refreshed.access_token });
  assert.equal(f.value().refresh_token, 'private-rotated-refresh');
});

test('a new connection or disconnect wins against an in-flight refresh', async () => {
  for (const value of [null, { ...old, access_token: 'other-account-access', refresh_token: 'other-account-refresh', expiry: T + 7200000 }]) {
    const f = build({ handler: async () => { f.replace(value); return Response.json(refreshed); } });
    await assert.rejects(f.source.get(), /google_oauth_connection_changed/);
    assert.deepEqual(f.value(), value);
  }
});

test('lost write acknowledgement recovers by re-reading without another refresh', async () => {
  const f = build(); let once = true;
  const source = createGoogleOAuthTokenSource({ ...f.config, store: { ...f.store, async set(...args) {
    const out = await f.store.set(...args); if (once) { once = false; throw new Error('private-write-body'); } return out;
  } } });
  await assert.rejects(source.get(), /google_oauth_refresh_write_unknown/);
  assert.deepEqual(await source.get(), { token: refreshed.access_token }); assert.equal(f.requests.length, 1);
});

test('a write acknowledgement without matching fresh state never returns the refreshed token', async () => {
  const f = build();
  const source = createGoogleOAuthTokenSource({ ...f.config, store: { ...f.store, async set(...args) {
    const out = await f.store.set(...args); f.replace({ ...old, expiry: T + 3600000 }); return out;
  } } });
  await assert.rejects(source.get(), /google_oauth_refresh_readback_failed/);
});

test('missing Gmail scopes, invalid token type/lifetime and corrupt records cannot enable mail access', async () => {
  for (const credentials of [{ ...old, scope: 'https://www.googleapis.com/auth/calendar' }, { ...old, scope: undefined }])
    await assert.rejects(build({ credentials }).source.get(), /google_oauth_mail_scope_missing/);
  for (const delta of [{ token_type: 'DPoP' }, { expires_in: 0 }, { expires_in: 86401 }, { access_token: 'line\nbreak' },
    { refresh_token: '' }, { scope: 'https://www.googleapis.com/auth/gmail.metadata' }]) {
    const f = build({ handler: async () => Response.json({ ...refreshed, ...delta }) });
    await assert.rejects(f.source.get(), /google_oauth_(refresh_response_invalid|mail_scope_missing)/);
    assert.equal(f.writes.length, 0);
  }
  const f = build();
  const bad = createGoogleOAuthTokenSource({ ...f.config, store: { ...f.store, getWithMetadata: async () => ({ data: old }) } });
  await assert.rejects(bad.get(), /google_oauth_stored_connection_invalid/);
});

test('provider/store failures are fixed diagnostics and do not include private payloads', async () => {
  for (const handler of [async () => new Response('private-google-error', { status: 400 }),
    async () => { throw new Error('private-transport-error'); }, async () => new Response('not-json'),
    async () => new Response(new ReadableStream({ start(c) { c.error(new Error('private-stream-error')); } }))]) {
    await assert.rejects(build({ handler }).source.get(), error => !error.message.includes('private-'));
  }
  const f = build();
  await assert.rejects(createGoogleOAuthTokenSource({ ...f.config, store: { ...f.store, getWithMetadata: async () => { throw new Error('private-netlify-token'); } } }).get(),
    e => e.error === 'google_oauth_store_unavailable' && !e.message.includes('private-'));
});

test('deadline includes Blob reads and late completions cannot trigger a refresh or write', async () => {
  const f = build(); let resolve;
  const source = createGoogleOAuthTokenSource({ ...f.config, timeoutMs: 15,
    store: { ...f.store, getWithMetadata: () => new Promise(r => { resolve = r; }) } });
  await assert.rejects(source.get(), /google_oauth_timeout/);
  resolve({ data: old, etag: '1' }); await new Promise(r => setImmediate(r));
  assert.equal(f.requests.length, 0); assert.equal(f.writes.length, 0);
  for (const handler of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))])
    await assert.rejects(build({ handler, options: { timeoutMs: 15 } }).source.get(), /google_oauth_timeout/);
});

test('abort and oversized response stop credential updates', async () => {
  const controller = new AbortController(); controller.abort(); const f = build();
  await assert.rejects(f.source.get({ signal: controller.signal }), /google_oauth_interrupted/);
  assert.equal(f.reads.length, 0);
  const large = build({ handler: async () => new Response(' '.repeat(65537)) });
  await assert.rejects(large.source.get(), /google_oauth_refresh_response_invalid/);
  assert.equal(large.writes.length, 0);
});

test('explicit Netlify factory targets only the existing site-wide OAuth store and fails closed without config', async () => {
  const env = { QUANTUS_V4_GOOGLE_NETLIFY_SITE_ID: '12345678-1234-1234-1234-123456789012',
    QUANTUS_V4_GOOGLE_NETLIFY_TOKEN: 'private-netlify-token', QUANTUS_V4_GOOGLE_CLIENT_ID: 'client-id', QUANTUS_V4_GOOGLE_CLIENT_SECRET: 'private-secret' };
  const f = build({ credentials: { ...old, expiry: T + 3600000 } }); let options;
  const result = await createNetlifyGoogleTokenSource({ envRead: key => env[key], now: () => T,
    loadBlobs: async () => ({ getStore(value) { options = value; return f.store; } }) });
  assert.equal(result.available, true); assert.deepEqual(await result.get(), { token: old.access_token });
  assert.deepEqual(options, { name: 'quantus-google-oauth', siteID: env.QUANTUS_V4_GOOGLE_NETLIFY_SITE_ID,
    token: env.QUANTUS_V4_GOOGLE_NETLIFY_TOKEN, consistency: 'strong', apiURL: 'https://api.netlify.com' });
  const missing = await createNetlifyGoogleTokenSource({ envRead: () => undefined, loadBlobs: () => assert.fail('no ambient fallback') });
  assert.deepEqual(missing, { available: false, reason: 'google_oauth_not_configured' });
});

test('actual pinned Blob SDK sends If-Match on token updates and preserves a concurrent new connection', async () => {
  for (const conflict of [false, true]) {
    let current = structuredClone(old), version = 1;
    const writes = [], requests = [];
    const store = getStore({ name: 'quantus-google-oauth', siteID: '12345678-1234-1234-1234-123456789012',
      token: 'private-netlify-token', consistency: 'strong', apiURL: 'https://api.netlify.com', fetch: async (url, init) => {
        requests.push({ url, method: init.method });
        if (new URL(url).origin === 'https://api.netlify.com') {
          assert.ok(url.endsWith('/site:quantus-google-oauth/tokens'));
          assert.equal(init.headers.authorization, 'Bearer private-netlify-token');
          return Response.json({ url: 'https://blob-fixture.example/tokens' });
        }
        assert.equal(url, 'https://blob-fixture.example/tokens');
        assert.equal(init.headers?.authorization, undefined);
        if (init.method === 'get') return Response.json(current, { headers: { etag: String(version) } });
        assert.equal(init.method, 'put'); writes.push(init);
        assert.equal(init.headers['if-match'], '1');
        if (init.headers['if-match'] !== String(version)) return new Response('', { status: 412 });
        current = JSON.parse(init.body); version++;
        return new Response('', { headers: { etag: String(version) } });
      } });
    const source = createGoogleOAuthTokenSource({ store, clientId: 'client-id', clientSecret: 'private-client', now: () => T,
      fetchImpl: async () => {
        if (conflict) { current = { ...old, access_token: 'other-connection', expiry: T + 3600000 }; version++; }
        return Response.json(refreshed);
      } });
    if (conflict) {
      await assert.rejects(source.get(), /google_oauth_connection_changed/);
      assert.equal(current.access_token, 'other-connection');
    } else assert.deepEqual(await source.get(), { token: refreshed.access_token });
    assert.equal(writes.length, 1);
    assert.ok(requests.every(r => ['get', 'put'].includes(r.method)));
  }
});

test('existing Netlify Calendar/Gmail access uses the safe writer and retains forced refresh without Gmail consent', async () => {
  const originalFetch = globalThis.fetch;
  const previous = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  let credentials = { ...old, scope: 'https://www.googleapis.com/auth/calendar', expiry: Date.now() + 3600000 }, version = 1;
  let refreshes = 0, writes = 0, race = false;
  try {
    process.env.GOOGLE_CLIENT_ID = 'fixture-client'; process.env.GOOGLE_CLIENT_SECRET = 'private-fixture';
    setEnvironmentContext({ siteID: '12345678-1234-1234-1234-123456789012', token: 'private-site' });
    globalThis.fetch = async (url, init) => {
      if (url === GOOGLE_OAUTH_URL) { refreshes++; return Response.json(refreshed); }
      if (String(url).startsWith('https://api.netlify.com/')) return Response.json({ url: 'https://blob-fixture.example/tokens' });
      assert.equal(url, 'https://blob-fixture.example/tokens');
      if (init.method === 'get') return Response.json(credentials, { headers: { etag: String(version) } });
      assert.equal(init.method, 'put'); assert.equal(init.headers['if-match'], String(version));
      if (race) { race = false; credentials = { ...old, access_token: 'private-other-account' }; version++; return new Response('', { status: 412 }); }
      credentials = JSON.parse(init.body); writes++; version++;
      return new Response('', { headers: { etag: String(version) } });
    };
    assert.deepEqual(await getValidAccessToken(), { token: old.access_token }); assert.equal(refreshes, 0);
    assert.deepEqual(await getValidAccessToken({ forceRefresh: true }), { token: refreshed.access_token });
    assert.equal(refreshes, 1); assert.equal(writes, 1); assert.equal(credentials.scope, 'https://www.googleapis.com/auth/calendar');
    assert.equal(await updateTokenEmail({ accessToken: refreshed.access_token, email: 'reader@example.test' }), true);
    assert.equal(credentials.email, 'reader@example.test'); assert.equal(writes, 2);
    assert.equal(await updateTokenEmail({ accessToken: old.access_token, email: 'stale@example.test' }), false);
    race = true;
    assert.equal(await updateTokenEmail({ accessToken: refreshed.access_token, email: 'changed@example.test' }), false);
    assert.equal(credentials.access_token, 'private-other-account'); assert.equal(credentials.email, undefined); assert.equal(writes, 2);
  } finally {
    globalThis.fetch = originalFetch; setEnvironmentContext({});
    if (previous.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = previous.id;
    if (previous.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = previous.secret;
  }
});
