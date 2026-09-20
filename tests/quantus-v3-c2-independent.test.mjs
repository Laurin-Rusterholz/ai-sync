import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = process.env.QUANTUS_API_REVIEW_ROOT || fileURLToPath(new URL('../', import.meta.url));
const from = path => pathToFileURL(root + '/' + path);
const S = await import(from('netlify/lib/quantus-v3-service.mjs'));
const A = await import(from('netlify/lib/quantus-v3-auth.mjs'));
const R = await import(from('netlify/lib/quantus-v3-rate-limiter.mjs'));
const F = await import(from('tests/fixtures/quantus-v3-c2-fixtures.mjs'));
const AF = await import(from('tests/fixtures/quantus-v3-auth-fixtures.mjs'));
const integration = process.env.QUANTUS_INTEGRATION_ROOT || fileURLToPath(new URL('../', import.meta.url));
const I = await import(pathToFileURL(integration + '/netlify/lib/quantus-v3-idempotency.mjs'));
const Client = await import(pathToFileURL(integration + '/public/quantus-v3-command-client.mjs'));
const at = Date.parse('2026-09-20T09:00:00Z');
const APP = 'https://management-xo2-pro.netlify.app';
const key = AF.makeSigningKey();
const token = AF.makeIdToken({ key, sub: 'uid-laurin', now: at, tenant: F.TENANT });
function harness({ write = false, snapshot, domain, now = () => at } = {}) {
  const env = AF.makeEnv({ tenant: F.TENANT, mode: write ? 'enforce' : null, overrides: write ? { QUANTUS_V3_API_WRITES: 'enabled' } : {} });
  let seq = 0;
  return { env, now, newRequestId: () => 'review_' + ++seq,
    keySource: AF.keySourceFor(key), userLookup: AF.userLookupFor({ tenantId: F.TENANT }),
    rateLimiter: F.makeRateLimiter(), store: F.makeStore({ snapshot }), domain: domain || F.makeDomain(),
    idempotency: { prepare: I.prepareIdempotentCommand, apply: I.applyIdempotentCommand },
  };
}
const deps = h => ({ ...h, env: h.env.read });
function read(h, { pageSize = 25 } = {}) {
  return S.handleReadRequest(F.makeRequest({ method: 'GET', url: `${APP}/.netlify/functions/quantus-context?query=notes.recent&scopeId=${F.LEAD_ID}&pageSize=${pageSize}`,
    headers: { authorization: `Bearer ${token}`, origin: APP },
  }), deps(h), { route: 'quantus-context' });
}
function send(h, { credential = token, body = F.commandBody(), origin = APP, idempotencyKey = 'independent-review-key' } = {}) {
  return S.handleCommandRequest(F.makeRequest({ headers: F.commandHeaders({ token: credential, origin, idempotencyKey }), body }), deps(h));
}
const note = (id, extra = {}) => ({ kind: 'note', id, ownerId: 'uid-laurin', tenant: F.TENANT,
  jobId: F.RUN_ID, leadId: F.LEAD_ID, entityVersion: 1, text: 'Synthetic note', ...extra });

test('C2-00: genuine signed user plus actual integrated idempotency commits once and replays', async () => {
  const h = harness({ write: true });
  const first = await send(h);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  const second = await send(h);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.replayed, true);
  assert.equal(h.domain.spur.applies, 1);
  assert.equal(h.store.snapshot.automation.dataRevision, 8);
});
test('C2-01: allowed scope does not authorize a foreign returned note', async () => {
  const foreign = note('private_note', { ownerId: 'uid-foreign', tenant: 'other-tenant', leadId: 'foreign_lead', text: 'Private synthetic content' });
  const h = harness({ domain: F.makeDomain({ listResult: { items: [foreign], hasMore: false } }) });
  const result = await read(h);
  assert.notEqual(result.status, 200, 'each returned object needs fresh scope/ownership/category authorization before projection');
});
test('C2-02: a missing hasMore signal cannot certify a complete dataset', async () => {
  const h = harness({ domain: F.makeDomain({ listResult: { items: [note('n1')] } }) });
  const result = await read(h);
  assert.notEqual(result.body.complete, true);
});
test('C2-03: an overfull adapter page cannot be delivered as a complete requested one-item page', async () => {
  const h = harness({ domain: F.makeDomain({ listResult: { items: [note('n1'), note('n2')], hasMore: false } }) });
  const result = await read(h, { pageSize: 1 });
  assert.equal(result.status !== 200 || (result.body.items.length <= 1 && result.body.complete !== true), true);
});
test('C2-04: invalid core revision is not fabricated as zero during dry-run', async () => {
  const snapshot = F.makeCoreSnapshot();
  delete snapshot.automation.dataRevision;
  const result = await send(harness({ snapshot }));
  assert.equal(result.status, 503);
});
test('C2-05: a server dry-run is not a durable command acknowledgement to the actual client', async () => {
  const h = harness();
  const transport = Client.createCommandTransport({ origin: APP, getAuth: async () => ({ accountKey: 'review', idToken: token }), writesEnabled: true,
    fetchImpl: async (url, init) => {
      const response = await S.handleCommandRequest(F.makeRequest({ method: init.method, url, headers: { ...init.headers, origin: APP }, body: init.body }), deps(h));
      return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
    },
  });
  const result = await transport.send({ accountKey: 'review', operationId: 'test-dry-run', command: F.commandBody() });
  assert.equal(h.store.spur.mutates, 0);
  assert.equal(result.ok, false, 'no command was applied; queue must remain pending');
});
test('C2-06: rate limiter never uses an absent or wildcard compare-and-swap precondition', async () => {
  for (const serverEtag of [null, '', '*']) {
    let writes = 0;
    const limiter = R.createCasRateLimiter({ getWithEtag: async () => ({ value: null, serverEtag }), set: async () => { writes++; return { ok: true }; } });
    await assert.rejects(limiter.increment({ key: 'review', windowStartMs: at, windowMs: 60000 }));
    assert.equal(writes, 0);
  }
});
test('C2-07: corrupted negative rate counters do not become extra allowance', async () => {
  let writes = 0;
  const limiter = R.createCasRateLimiter({ getWithEtag: async () => ({ value: { count: -1000, windowStartMs: at }, serverEtag: '"v1"' }),
    set: async () => { writes++; return { ok: true }; } });
  await assert.rejects(limiter.increment({ key: 'review', windowStartMs: at, windowMs: 60000 }));
  assert.equal(writes, 0);
});
test('C2-08: a lease expiring before the CAS attempt cannot pass using handler-start time', async () => {
  let current = at;
  const snapshot = F.makeCoreSnapshot({ leaseOwner: 'review-agent', leaseExpiresAt: new Date(at + 30000).toISOString() });
  const h = harness({ write: true, snapshot, now: () => current });
  const { config } = A.resolveAuthConfig(h.env.read);
  const minted = await A.mintJobToken({ config, audience: 'quantus-ingest', jobId: F.RUN_ID, assignedJobIds: [F.RUN_ID], role: 'lead_agent', principalId: 'review-agent', tenant: F.TENANT, now: () => at });
  assert.equal(minted.ok, true);
  const baseline = await send(h, { credential: minted.token, origin: null, idempotencyKey: 'lease-control' });
  assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
  const before = h.domain.spur.applies;
  const mutate = h.store.mutate.bind(h.store);
  h.store.mutate = async (...args) => { current = at + 31000; return mutate(...args); };
  const result = await send(h, { credential: minted.token, origin: null, body: F.commandBody({ expectedEntityVersion: 18 }) });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(h.domain.spur.applies, before);
});
for (const [verb, expectedEntityVersion, payload] of [
  ['intake.create', 0, { source: 'manual', title: 'New user request' }],
  ['task.create', 0, { leadId: F.LEAD_ID, title: 'Derived task' }],
  ['note.append', 0, { noteId: 'user-note', text: 'Ordinary note', noteScope: 'run' }],
]) {
  test(`C2-09: an authenticated owner's ${verb} is not impossible because envelope and role categories disagree`, async () => {
    const h = harness({ write: true });
    const result = await send(h, { body: F.commandBody({ verb, expectedEntityVersion, payload }) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  });
}

test('C2-10: a create command versions its new resource, not its existing authorization anchor', async () => {
  const h = harness({ write: true });
  const result = await send(h, { body: F.commandBody({ verb: 'task.create', expectedEntityVersion: 17,
    payload: { leadId: F.LEAD_ID, title: 'Wrong version domain' } }) });
  assert.equal(result.status, 409);
  assert.equal(h.domain.spur.applies, 0);
});
