import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIWorkerPorts } from '../runtime/quantus-v3/src/openai-composition.mjs';
import { migrateCore } from '../netlify/lib/assistant-migration.mjs';
import { POLICY_TEMPLATE } from '../netlify/lib/assistant-schema.mjs';
import { createQuantusV3DomainAdapter, DOMAIN_PORT_VARS } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
import { reserveCost } from '../netlify/lib/quantus-v3-runtime-state.mjs';

const assistantPolicy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'quantus-core', kind: 'quantus-core' }], noExternalSources: true };
// Synthetic in-process operator policy; never loaded into a real service.
const costPolicy = { schema: 'quantus-v3-cost-policy/1', version: 'test-only', currency: 'USD',
  approval: { approvedBy: 'synthetic-test', approvalRef: 'NOT-A-REAL-APPROVAL', approvedAtMs: T - 1000 },
  effectiveFromMs: T - 1000, effectiveUntilMs: T + 86400000,
  dayLimitMicros: 1000000, runLimitMicros: 1000000, callLimitMicros: 100000, unresolvedBlockMicros: 1000000,
  featureFlags: { providers: 'live' }, models: { 'openai:test-model': {
    inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 1000, maxCallMicros: 100000 } } };
async function build({ mode = 'live', providerFailure = false, compaction = false } = {}) {
  const s = await setup(migrateCore({ entities: { tasks: { task1: { id: 'task1', status: 'todo' } } } }, { now: T }).data);
  const requests = [], tools = [];
  const env = { QUANTUS_V4_OPENAI_API_KEY: 'test-secret-not-real', QUANTUS_V4_OPENAI_MODEL: 'test-model',
    QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK: '1000', QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK: '1000',
    QUANTUS_V4_PROMPT_VERSION: '4.0.0', QUANTUS_V3_COST_POLICY_JSON: JSON.stringify(costPolicy),
    [DOMAIN_PORT_VARS.policyJson]: JSON.stringify(assistantPolicy) };
  if (compaction) env.QUANTUS_V4_OPENAI_COMPACT_THRESHOLD = '16000';
  const config = { ...F.configFor('worker', { QUANTUS_V3_RUNTIME_MODE: mode,
    QUANTUS_V3_REQUIRED_SOURCES: '["quantus-core"]', QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: 'true', QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed() }),
    tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun', c2BaseUrl: 'https://quantus.invalid',
    toolsEnabled: { quantus_context: true, quantus_read: true, quantus_command: true, quantus_run_status: true } };
  const args = { runKey: RUN, sectionId: 'section-1', verifiedScope: s.scope, cursor: { position: 0 } };
  const make = overrides => createOpenAIWorkerPorts({ config, corePort: { available: true, impl: s.core }, clockPort: s.clock,
    envRead: name => env[name], artifactStore: s.artifacts.store,
    jobTokenIssuer: { available: true, async mint({ jobId, tenant }) {
      assert.equal(jobId, 'run_2026-10-02'); assert.equal(tenant, 'quantus'); return 'test-job-token';
    } },
    c2Transport: { async send(request) {
      tools.push(request);
      const params = request.searchParams, data = s.store.snapshot();
      const domain = createQuantusV3DomainAdapter({ policyVersion: '4.0', tenantId: 'quantus', mode: 'enforce',
        now: () => T, ports: { policy: assistantPolicy, ownerId: 'test-owner' } });
      const revision = data.automation.dataRevision;
      let afterId = null;
      if (params.cursor) {
        const decoded = JSON.parse(params.cursor);
        assert.equal(decoded.revision, revision, 'no journal/cost write may occur between context pages');
        afterId = decoded.afterId;
      }
      const page = domain.listPage(data, { query: params.query, scopeId: params.scopeId, pageSize: 1,
        afterId, principal: { role: 'lead_agent', jobId: 'run_2026-10-02' } });
      return { status: 200, body: { ok: true, requestId: `read-${tools.length}`, serverNow: new Date(T).toISOString(),
        dataRevision: revision, query: params.query, scopeId: params.scopeId, items: page.items, count: page.items.length,
        hasMore: page.hasMore, complete: !page.hasMore, pageStatus: page.hasMore ? 'more' : 'done',
        cursor: page.hasMore ? JSON.stringify({ revision, afterId: page.nextAfterId }) : null } };
    } },
    providerFetch: async (_, request) => {
      requests.push(JSON.parse(request.body));
      if (providerFailure) throw new Error('test network failed');
      return Response.json({ id: `response_${requests.length}`, status: 'completed', usage: { input_tokens: 10, output_tokens: 10 },
        output: [...(compaction && requests.length === 2 ? [{ type: 'compaction', id: 'cmp_composition', encrypted_content: 'test-opaque-state' }] : []),
          ...(requests.length <= 3 ? [{ type: 'function_call', status: 'completed',
          name: requests.length === 3 ? 'quantus_run_status' : 'quantus_context', call_id: `read${requests.length}`,
          arguments: JSON.stringify(requests.length === 3 ? { cursor: '' } : {
            query: requests.length === 1 ? 'policy.current' : 'run.workset',
            scopeId: requests.length === 1 ? 'policy_current' : 'run_2026-10-02', cursor: '',
          }) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Review complete; backend proof still required.' }] }])] });
    }, ...overrides });
  return { ...s, args, make, requests, tools, env, config };
}

test('production compaction retains independent coverage evidence and only uses explicit valid configuration', async () => {
  const s = await build({ compaction: true });
  let outcome;
  for (let i = 0; i < 8; i++) {
    const p = await s.make();
    assert.equal(p.sectionWork.available, true);
    outcome = await p.sectionWork.impl.next(s.args);
    if (outcome.done) break;
  }
  assert.equal(outcome.done, true);
  assert.equal(s.requests.length, 4);
  for (const request of s.requests)
    assert.deepEqual(request.context_management, [{ type: 'compaction', compact_threshold: 16000 }]);
  assert.equal(s.requests[2].input[0].type, 'compaction');
  assert.equal(s.requests[2].input[0].encrypted_content, 'test-opaque-state');
  assert.equal(s.requests[2].input[1].call_id, 'read2');
  const run = s.store.snapshot().automation.runtime.runsByKey[RUN];
  assert.equal(run.contextCoverage.proof.itemCount, 2);
  assert.equal(run.leadershipJournal.entries.length, 4);
  assert.equal(run.phase, 'active', 'compaction and coverage never grant daily finalization');
  for (const threshold of ['', 'invalid', '999', '100001', '16000.5', null]) {
    s.env.QUANTUS_V4_OPENAI_COMPACT_THRESHOLD = threshold;
    assert.equal((await s.make()).sectionWork.reason, 'openai_compaction_not_configured');
  }
  assert.equal(s.requests.length, 4);
});

test('production composition bootstraps real domain, journals provider/tool steps and resumes without granting finalization', async () => {
  const s = await build();
  let p = await s.make();
  assert.equal(p.sectionWork.available, true, p.sectionWork.reason);
  const first = await p.sectionWork.impl.next(s.args);
  assert.match(first.stepId, /:model_recorded$/);
  assert.equal(s.requests.length, 1);
  assert.match(s.requests[0].instructions, /automatische\nArbeitsläufe/);
  const daily = s.store.snapshot().dailyBriefing.assistantRuns['2026-10-02'];
  assert.ok(daily.startNoteId);
  assert.ok(daily.itemRefs.some(r => r.sourceId === 'task1'));
  p = await s.make();
  assert.match((await p.sectionWork.impl.next(s.args)).stepId, /:tool_recorded$/);
  assert.equal(s.tools.length, 1);
  assert.equal(s.tools[0].credential, 'test-job-token');
  assert.match((await p.sectionWork.impl.next(s.args)).stepId, /:model_recorded$/);
  for (let i = 0; i < 2; i++) {
    assert.match((await (await s.make()).sectionWork.impl.next(s.args)).stepId, /:tool_recorded$/);
    assert.match((await (await s.make()).sectionWork.impl.next(s.args)).stepId, /:model_recorded$/);
  }
  const complete = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(complete.done, true, JSON.stringify(complete));
  assert.equal(s.requests.length, 4);
  const proof = s.store.snapshot().automation.runtime.runsByKey[RUN].contextCoverage.proof;
  assert.equal(proof.itemCount, 2);
  assert.match(proof.worksetHash, /^[a-f0-9]{64}$/);
  const recordedTools = (await s.journal.read()).filter(e => e.tool);
  assert.equal(recordedTools[1].tool.readPages.length, 2, 'workset spans both pages before journal mutation');
  assert.equal(recordedTools[1].tool.response.body.count, 2);
  assert.equal(s.store.snapshot().dailyBriefing.assistantRuns['2026-10-02'].phase, 'active');
  assert.ok(Object.values(s.store.snapshot().automation.runtime.cost.callsById).every(c => c.state === 'settled'));
  assert.equal(JSON.stringify(s.store.snapshot()).includes('Review complete; backend proof still required.'), false, 'raw response is external');
});

test('unconfirmed provider outcome remains blocked across new worker instances without another call', async () => {
  const s = await build({ providerFailure: true });
  const result = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'provider_outcome_unknown');
  assert.equal((await (await s.make()).sectionWork.impl.next(s.args)).blocked, true);
  assert.equal(s.requests.length, 1);
});

test('missing model/prices/version or issuer never falls back to Anthropic or exposes secrets', async () => {
  const s = await build();
  for (const key of ['QUANTUS_V4_OPENAI_MODEL', 'QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK', 'QUANTUS_V4_PROMPT_VERSION']) {
    const p = await s.make({ envRead: name => name === key ? undefined : s.env[name] });
    assert.equal(p.sectionWork.available, false);
    assert.equal(JSON.stringify(p).includes(s.env.QUANTUS_V4_OPENAI_API_KEY), false);
  }
  assert.equal((await s.make({ jobTokenIssuer: { available: false } })).sectionWork.available, false);
  assert.equal(s.requests.length, 0);
});

test('dry-run, revoked cost policy, expired lease and aborted section cannot dispatch a provider request', async () => {
  for (const kind of ['dry_run', 'revoked', 'expired', 'abort']) {
    const s = await build({ mode: kind === 'dry_run' ? 'dry_run' : 'live' });
    const p = await s.make();
    if (kind === 'revoked') delete s.env.QUANTUS_V3_COST_POLICY_JSON;
    if (kind === 'expired') s.setNow(T + 121000);
    const controller = new AbortController(); if (kind === 'abort') controller.abort();
    if (kind === 'dry_run' || kind === 'revoked') {
      const result = await p.sectionWork.impl.next({ ...s.args, signal: controller.signal });
      assert.equal(result.blocked, true);
      assert.equal(result.reason, kind === 'dry_run' ? 'external_effects_not_allowed' : 'cost_policy_unavailable');
    } else await assert.rejects(p.sectionWork.impl.next({ ...s.args, signal: controller.signal }));
    assert.equal(s.requests.length, 0, kind);
    assert.equal(s.tools.length, 0, kind);
  }
});

test('production OpenAI reservation enforces the shared 50 USD monthly cap', async () => {
  const s = await build();
  const large = { ...costPolicy, dayLimitMicros: 100000000, runLimitMicros: 100000000,
    callLimitMicros: 20000000, unresolvedBlockMicros: 100000000,
    models: { ...costPolicy.models, 'openai:earlier-model': {
      inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 0, maxCallMicros: 20000000 } } };
  s.env.QUANTUS_V3_COST_POLICY_JSON = JSON.stringify(large);
  for (let i = 0; i < 5; i++) {
    const key = `earlier-${i}`;
    await s.core.mutate({ commandKey: key, requestId: key, now: T, mutate: d => reserveCost(d, {
      callId: key, runKey: RUN, provider: 'openai', model: 'earlier-model', contentHash: `test-content-hash-${i}`,
      inputTokens: 10000000, outputTokens: 0, now: T, verifiedScope: s.scope, policy: large,
    }) });
  }
  const result = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'monthly_budget_exceeded');
  assert.equal(s.requests.length, 0);
});

test('a concurrent original write after the fresh check prevents saving coverage and prompts fresh work on resume', async () => {
  const s = await build();
  for (let i = 0; i < 7; i++) await (await s.make()).sectionWork.impl.next(s.args);
  let changed = false;
  const p = await s.make({ corePort: { ...s.core, async mutate(args) {
    if (!changed && args.commandKey.startsWith('v4-coverage-')) {
      changed = true;
      s.store.forceWrite(d => {
        d.entities.tasks.late = { id: 'late', title: 'Arrived during final check', status: 'todo' };
        d.automation.dataRevision++;
        return d;
      });
    }
    return s.core.mutate(args);
  } } });
  await assert.rejects(p.sectionWork.impl.next(s.args), { error: 'context_changed_before_checkpoint' });
  assert.equal(s.store.snapshot().automation.runtime.runsByKey[RUN].contextCoverage, undefined);
  assert.equal(s.requests.length, 4);
  const resumed = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(resumed.done, false);
  assert.match(s.requests[4].input.at(-1).content, /context_contents_changed/);
});
