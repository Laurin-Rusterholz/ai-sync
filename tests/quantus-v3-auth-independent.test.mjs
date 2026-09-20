import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = process.env.QUANTUS_AUTH_REVIEW_ROOT || fileURLToPath(new URL('../', import.meta.url));
const from = path => pathToFileURL(root + '/' + path);
const A = await import(from('netlify/lib/quantus-v3-auth.mjs'));
const C = await import(from('netlify/lib/quantus-v3-cursor.mjs'));
const { makeEnv, makeSigningKey, makeIdToken, keySourceFor, POLICY_VERSION, TENANT } = await import(from('tests/fixtures/quantus-v3-auth-fixtures.mjs'));

const time = Date.parse('2026-09-19T10:00:00Z');
const now = () => time;
const env = makeEnv();
const { config } = A.resolveAuthConfig(env.read);
const { config: cursorConfig } = C.resolveCursorConfig(env.read);
const principal = { kind: 'user', issuedBy: A.ISSUERS.firebase, role: 'user', id: 'review-user', tenant: TENANT };
const key = makeSigningKey();

test('C1-R2-01: key-fetch failures obey the same cooldown as unknown kids', async () => {
  let requests = 0;
  const source = A.createGooglePublicKeySource({ now, fetchImpl: async () => { requests++; throw new Error('provider unavailable'); } });
  for (let i = 0; i < 5; i++) { try { await source.get('made-up-' + i); } catch {} }
  assert.equal(requests, 1, 'an unavailable provider cannot be queried once per hostile token');
});
test('C1-R2-02: malformed revocation lookup is not coerced to never-revoked', async () => {
  const token = makeIdToken({ key, now: time });
  const deps = { config, keySource: keySourceFor(key), now };
  assert.equal((await A.verifyFirebaseIdToken(token, { ...deps, userLookup: async () => ({ disabled: false, validSince: 0, tenantId: null }) })).ok, true);
  const invalid = await A.verifyFirebaseIdToken(token, { ...deps, userLookup: async () => ({ disabled: false, validSince: NaN, tenantId: null }) });
  assert.equal(invalid.ok, false);
});
test('C1-R2-03: cursor supports valid initial numeric data revision zero', async () => {
  const signed = await C.signCursor({ config: cursorConfig, principal, query: 'lead.context', scopeId: 'lead-1',
    dataRevision: 0, policyVersion: POLICY_VERSION, now });
  assert.equal(signed.ok, true, signed.reason);
  const checked = await C.verifyCursor(signed.cursor, { config: cursorConfig, authConfig: config, principal,
    expectedQuery: 'lead.context', expectedScopeKind: 'lead', expectedScopeId: 'lead-1',
    dataRevision: 0, policyVersion: POLICY_VERSION, scopeObject: { kind: 'lead', id: 'lead-1', ownerId: principal.id, tenant: TENANT }, now });
  assert.equal(checked.ok, true, checked.reason);
});
test('C1-R2-04: invalid data revisions cannot be signed as valid cursors', async () => {
  for (const dataRevision of [-1, 1.5, {}, 'not-a-revision']) {
    const signed = await C.signCursor({ config: cursorConfig, principal, query: 'lead.context', scopeId: 'lead-1',
      dataRevision, policyVersion: POLICY_VERSION, now });
    assert.equal(signed.ok, false, JSON.stringify(dataRevision));
  }
});
test('C1-R2-05: exceeding secret-scan depth cannot certify unexamined content safe', () => {
  let value = { apiKey: 'synthetic-secret-never-real' };
  for (let i = 0; i < 8; i++) value = { nested: value };
  assert.equal(A.assertNoProviderSecrets(value).ok, false);
});
