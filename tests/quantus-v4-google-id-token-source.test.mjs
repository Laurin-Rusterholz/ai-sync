import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleIdTokenSource } from '../runtime/quantus-v3/src/google-id-token-source.mjs';
import { createSigningKey, schedulerToken, jwksPort } from './quantus-v3-e2-fixtures.mjs';
const key = createSigningKey(), now = Date.parse('2026-10-03T07:00:00Z');
const audience = 'https://broker.invalid/v4/commissioning/respond';
const serviceAccount = 'worker@shadow-invalid.iam.gserviceaccount.com';
const signed = overrides => schedulerToken(key, { audience, email: serviceAccount, nowMs: now, overrides });
const response = token => new Response(token, { headers: { 'Metadata-Flavor': 'Google' } });
const base = { audience, serviceAccount, clock: { now: () => now }, jwks: jwksPort(key).impl };
const rejected = error => error.error === 'google_id_token_unavailable' && !error.message.includes('SECRET');

test('fixed metadata recipient, attached account and signed result; construction has no effects', async () => {
  const requests = [], token = signed();
  const source = createGoogleIdTokenSource({ ...base, fetchImpl: async (url, init) => {
    requests.push({ url, init }); return response(token);
  } });
  assert.equal(requests.length, 0);
  assert.equal(await source.get({ audience }), token);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin, 'http://metadata.google.internal');
  assert.equal(url.pathname, '/computeMetadata/v1/instance/service-accounts/default/identity');
  assert.equal(url.searchParams.get('audience'), audience);
  assert.equal(url.searchParams.get('format'), 'full');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(requests[0].init.headers, { 'Metadata-Flavor': 'Google' });
});

test('caller cannot change fixed recipient and pre-aborted acquisition does not send', async () => {
  let sends = 0;
  const source = createGoogleIdTokenSource({ ...base, fetchImpl: async () => { sends++; return response(signed()); } });
  await assert.rejects(source.get({ audience: 'https://foreign.invalid' }), rejected);
  await assert.rejects(source.get({ audience, signal: AbortSignal.abort() }), rejected);
  assert.equal(sends, 0);
});

test('valid Google signature, configured audience/account and current lifetime all required', async () => {
  const other = createSigningKey('other');
  for (const token of [signed({ aud: 'https://foreign.invalid' }), signed({ email: 'other@shadow-invalid.iam.gserviceaccount.com' }),
    signed({ exp: now / 1000 }), signed({ email_verified: false }),
    schedulerToken(other, { audience, email: serviceAccount, nowMs: now }), 'SECRET-NOT-A-JWT']) {
    const source = createGoogleIdTokenSource({ ...base, fetchImpl: async () => response(token) });
    await assert.rejects(source.get({ audience }), rejected);
  }
});

test('expiry is checked after awaited public-key lookup', async () => {
  let current = now;
  const source = createGoogleIdTokenSource({ ...base, clock: { now: () => current },
    jwks: { async getKeys() { current += 600001; return jwksPort(key).impl.getKeys(); } },
    fetchImpl: async () => response(signed()) });
  await assert.rejects(source.get({ audience }), rejected);
});

test('HTTP failures, missing metadata provenance and oversized tokens fail without retries', async () => {
  for (const result of [new Response('SECRET', { status: 503 }), new Response(signed()), response('x'.repeat(8193))]) {
    let sends = 0;
    const source = createGoogleIdTokenSource({ ...base, fetchImpl: async () => { sends++; return result; } });
    await assert.rejects(source.get({ audience }), rejected); assert.equal(sends, 1);
  }
});

test('deadline bounds uncooperative fetch, body and key lookup', async () => {
  let cancelled = false;
  for (const options of [
    { fetchImpl: () => new Promise(() => {}) },
    { fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Metadata-Flavor': 'Google' } }) },
    { fetchImpl: async () => response(signed()), jwks: { getKeys: () => new Promise(() => {}) } },
  ]) {
    const source = createGoogleIdTokenSource({ ...base, ...options, timeoutMs: 10 });
    await assert.rejects(source.get({ audience }), rejected);
  }
  assert.equal(cancelled, true);
});

test('aborting an active request cancels metadata fetch', async () => {
  const controller = new AbortController(); let observed;
  const source = createGoogleIdTokenSource({ ...base, fetchImpl: async (_url, { signal }) => {
    observed = signal; controller.abort(); return response(signed());
  } });
  await assert.rejects(source.get({ audience, signal: controller.signal }), rejected);
  assert.equal(observed.aborted, true);
});
