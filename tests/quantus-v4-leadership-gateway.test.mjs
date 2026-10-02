import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadershipGateway } from '../runtime/quantus-v3/src/leadership-gateway.mjs';
import { createOpenAITransport } from '../runtime/quantus-v3/src/openai-transport.mjs';
import { createC2HttpTransport } from '../runtime/quantus-v3/src/c2-transport.mjs';
import { authorize, ISSUERS, resolveAuthConfig, mintJobToken } from '../netlify/lib/quantus-v3-auth.mjs';
import { makeEnv, TENANT, POLICY_VERSION } from './fixtures/quantus-v3-auth-fixtures.mjs';
import { handleReadRequest } from '../netlify/lib/quantus-v3-service.mjs';
import { makeCoreSnapshot, makeStore, makeDomain, makeRateLimiter } from './fixtures/quantus-v3-c2-fixtures.mjs';

const metadata = { requestId: 'server_1', serverNow: '2026-10-02T10:00:00Z', dataRevision: 12 };
function setup(response = { status: 200, body: { ...metadata, ok: true, applied: true, dryRun: false } }) {
  const calls = [], minted = [];
  const gateway = createLeadershipGateway({
    transport: { async send(r) { calls.push(r); return structuredClone(response); } },
    jobTokenIssuer: { async mint(r) { minted.push(r); return 'fixture-job-token'; } }, clock: { now: () => 1790935200000 },
    runKey: 'tenant:2026-10-02:briefing04:v4', tenant: 'tenant',
    lease: async () => ({ holder: 'holder-1', fence: 2 }),
    toolsEnabled: Object.fromEntries(['quantus_context', 'quantus_read', 'quantus_command', 'quantus_run_status'].map(t => [t, true])),
  });
  return { gateway, calls, minted };
}
const invocation = { responseId: 'resp_1', callId: 'call_1' };
const command = { name: 'quantus_command', arguments: { verb: 'lead.comment', expectedEntityVersion: 5, payloadJson: '{"leadId":"lead-1","text":"Reviewed"}' } };

test('all four tool definitions are accepted by the strict OpenAI transport', () => {
  const t = createOpenAITransport({ apiKey: 'fixture', model: 'fixture', modelPricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } });
  assert.ok(t.prepare({ instructions: 'policy', input: [{ role: 'user', content: 'job' }], tools: setup().gateway.definitions() }).contentHash);
});

test('commands use real envelope validation and stable runtime-owned job, lease and replay identity', async () => {
  const { gateway, calls, minted } = setup();
  const first = await gateway.execute(command, invocation);
  const second = await gateway.execute(command, invocation);
  assert.equal(first.confirmed, true);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(calls[0].payload.jobId, 'run_2026-10-02');
  assert.deepEqual(calls[0].payload.lease, { holder: 'holder-1', fence: 2 });
  assert.equal(calls[0].payload.expectedEntityVersion, 5);
  assert.equal(calls[0].credential, 'fixture-job-token');
  assert.equal(minted[0].audience, 'quantus-ingest');
  assert.equal(minted[0].jobId, 'run_2026-10-02');
});

test('no user answers, finalization, arbitrary fields, paths or forged identity reach transport', async () => {
  const { gateway, calls, minted } = setup();
  for (const arguments_ of [
    { ...command.arguments, verb: 'briefing.answer' },
    { ...command.arguments, verb: 'run.finalize' },
    { ...command.arguments, role: 'scheduler' },
    { ...command.arguments, payloadJson: '{"leadId":"lead-1","text":"x","overall":"green"}' },
    { ...command.arguments, payloadJson: '{"leadId":"app-data.json","text":"x"}' },
    { ...command.arguments, payloadJson: '{"leadId":"lead-1","text":"x","tenant":"other"}' },
  ]) await assert.rejects(gateway.execute({ name: command.name, arguments: arguments_ }, invocation));
  assert.equal(calls.length, 0); assert.equal(minted.length, 0);
});

test('assigned run status is fixed by runtime; model cannot choose another run', async () => {
  const { gateway, calls } = setup();
  await gateway.execute({ name: 'quantus_run_status', arguments: { cursor: '' } }, invocation);
  assert.deepEqual(calls[0].searchParams, { query: 'run.status', scopeId: 'status_2026-10-02', jobId: 'run_2026-10-02', pageSize: '50' });
  await assert.rejects(gateway.execute({ name: 'quantus_run_status', arguments: { cursor: '', scopeId: 'status_2026-10-01' } }, invocation));
});

test('pagination metadata and conflicts stay intact; dry runs do not confirm writes; no automatic retries', async () => {
  const paged = setup({ status: 200, body: { ...metadata, ok: true, hasMore: true, complete: false, cursor: 'signed-page-2', items: [] } });
  const page = await paged.gateway.execute({ name: 'quantus_context', arguments: { query: 'run.context', scopeId: 'run_2026-10-02', cursor: 'signed-page-1' } }, invocation);
  assert.equal(paged.calls[0].searchParams.cursor, 'signed-page-1');
  assert.equal(page.response.body.hasMore, true);
  assert.equal(page.response.body.cursor, 'signed-page-2');
  for (const response of [{ status: 200, body: { ok: true, dryRun: true, applied: false } }, { status: 409, body: { ok: false, reason: 'stale_entity' } }]) {
    const { gateway, calls } = setup(response);
    const r = await gateway.execute(command, invocation);
    assert.equal(r.confirmed, false); assert.deepEqual(r.response, response); assert.equal(calls.length, 1);
  }
});

test('real authorization grants own status only; foreign tenant/job and specialists stay denied', () => {
  const { config } = resolveAuthConfig(makeEnv({ tenant: TENANT }).read);
  const principal = { kind: 'worker', issuedBy: ISSUERS.jobToken, id: 'leader', role: 'lead_agent', tenant: TENANT, jobId: 'run-1', assignedJobIds: ['run-1'] };
  const object = { kind: 'run_status', id: 'status-1', tenant: TENANT, jobId: 'run-1' };
  const args = { principal, object, verb: 'context.read', dataCategory: 'run_status', policyVersion: POLICY_VERSION, config };
  assert.equal(authorize(args).ok, true);
  assert.equal(authorize({ ...args, object: { ...object, jobId: 'run-2' } }).ok, false);
  assert.equal(authorize({ ...args, object: { ...object, tenant: 'foreign' } }).ok, false);
  for (const role of ['specialist_claude', 'specialist_gemini']) assert.equal(authorize({ ...args, principal: { ...principal, role } }).ok, false);
  assert.equal(authorize({ ...args, verb: 'run.finalize', dataCategory: 'run', object: { ...object, kind: 'run' } }).ok, false);
});

test('C2 deadline includes a never-ending response body and does not retry the command', async () => {
  let calls = 0, cancelled = false;
  const t = createC2HttpTransport({ baseUrl: 'https://quantus.example', fetchImpl: async () => {
    calls++; return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
  } });
  await assert.rejects(t.send({ route: 'quantus-ingest', method: 'POST', payload: {}, credential: 'fixture', idempotencyKey: 'stable', timeoutMs: 20 }), e => e.error === 'c2_request_timeout');
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test('C2 stops reading at the byte limit and rejects redirects for credentials', async () => {
  let cancelled = false;
  const t = createC2HttpTransport({ baseUrl: 'https://quantus.example', maxResponseBytes: 10, fetchImpl: async (_, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; } }));
  } });
  await assert.rejects(t.send({ route: 'quantus-read', method: 'GET', searchParams: {}, credential: 'fixture', timeoutMs: 100 }), e => e.error === 'c2_response_too_large');
  assert.equal(cancelled, true);
});


test('a successful HTTP response with missing revision or broken pagination is not confirmed', async () => {
  for (const body of [
    { ok: true, applied: true, dryRun: false },
    { ...metadata, ok: true, applied: true, dryRun: false, dataRevision: null },
  ]) assert.equal((await setup({ status: 200, body }).gateway.execute(command, invocation)).confirmed, false);
  const broken = setup({ status: 200, body: { ...metadata, ok: true, items: [], hasMore: true, complete: false, cursor: null } });
  assert.equal((await broken.gateway.execute({ name: 'quantus_run_status', arguments: { cursor: '' } }, invocation)).confirmed, false);
});

test('gateway reads through real C2 authentication, signed job token, object binding and projection', async () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const env = makeEnv({ tenant: TENANT });
  const { config } = resolveAuthConfig(env.read);
  for (const bound of [true, false]) {
    const snapshot = makeCoreSnapshot();
    const status = { kind: 'run_status', id: 'status_2026-10-02', runId: 'run_2026-10-02',
      jobId: bound ? 'run_2026-10-02' : 'run_foreign', tenant: TENANT, state: 'active', entityVersion: 1,
      internalSecretNote: 'must not appear' };
    snapshot.entities.runStatus = { [status.id]: status };
    const store = makeStore({ snapshot });
    const domain = makeDomain({ listResult: { items: [status], hasMore: false } });
    const transport = createC2HttpTransport({ baseUrl: 'https://quantus.example', fetchImpl: async (url, init) => {
      const reply = await handleReadRequest(new Request(url, init), {
        now: () => now, newRequestId: () => 'receipt_1', env: env.read, store, domain, rateLimiter: makeRateLimiter(),
      }, { route: 'quantus-run-status' });
      return Response.json(reply.body, { status: reply.status });
    } });
    const gateway = createLeadershipGateway({ transport, runKey: `${TENANT}:2026-10-02:briefing04:v4`, tenant: TENANT,
      clock: { now: () => now }, lease: async () => ({ holder: 'h1', fence: 1 }), toolsEnabled: { quantus_run_status: true },
      jobTokenIssuer: { async mint({ audience, jobId, tenant }) {
        const result = await mintJobToken({ config, audience, jobId, tenant, role: 'lead_agent', principalId: 'leader', assignedJobIds: [jobId], now: () => now });
        assert.equal(result.ok, true); return result.token;
      } },
    });
    const result = await gateway.execute({ name: 'quantus_run_status', arguments: { cursor: '' } }, invocation);
    assert.equal(result.confirmed, bound, JSON.stringify(result));
    assert.equal(result.response.status, bound ? 200 : 403);
    assert.ok(!JSON.stringify(result).includes('must not appear'));
  }
});
