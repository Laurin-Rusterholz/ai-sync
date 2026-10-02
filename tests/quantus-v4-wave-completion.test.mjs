import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from './quantus-v3-e2-fixtures.mjs';
import * as H from './quantus-v3-runtime-cas-harness.mjs';
import * as IDEM from '../netlify/lib/quantus-v3-idempotency.mjs';
import { migrateCore, POLICY_TEMPLATE } from '../netlify/lib/assistant-core.mjs';
import { createIntegrationCorePort } from '../runtime/quantus-v3/src/integration-ports.mjs';
import { createBriefingSectionWork } from '../runtime/quantus-v3/src/briefing-bootstrap.mjs';
import { domainFingerprint, jsonHash } from '../runtime/quantus-v3/src/domain-fingerprint.mjs';
import { reserveCost } from '../netlify/lib/quantus-v3-runtime-state.mjs';
const T = Date.parse('2026-10-02T07:01:00Z');
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };

async function service(mode = 'valid') {
  const now = mode === 'night' ? Date.parse('2026-10-02T21:01:00Z') : T;
  const clock = F.createClock(now), key = F.createSigningKey(), tasks = F.createTasksPort();
  const store = H.createCasStore(migrateCore({ entities: { chatgptLeads: {
    lead1: { id: 'lead1', status: 'neu', assignee: 'chatgpt', instruction: 'Still needs action' },
  } } }, { now }).data);
  const core = await createIntegrationCorePort({ tenantId: 'quantus', principalId: 'http-worker', loadModules: async () => ({ idem: IDEM,
    admin: { async readAppDataDocument() { return { data: store.read().text, etag: 'fixture' }; },
      async mutateAppData(_, mutate) { return H.casMutate(store, mutate); } } }) });
  let calls = 0;
  const work = createBriefingSectionWork({ core: core.impl, clock: clock.port.impl, policy,
    config: { tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun' },
    inner: { async next(args) {
      calls++;
      if (mode === 'cost') await core.impl.mutate({ commandKey: 'reserved-cost', requestId: 'reserved-cost', now: clock.value,
        mutate: data => reserveCost(data, { callId: 'unresolved-call', runKey: args.runKey, provider: 'openai', model: 'synthetic',
          contentHash: 'synthetic-unresolved-content', inputTokens: 1, outputTokens: 0, now: clock.value,
          verifiedScope: args.verifiedScope, policy: { schema: 'quantus-v3-cost-policy/1', version: 'synthetic', currency: 'USD',
            approval: { approvedBy: 'fixture', approvalRef: 'NOT-REAL', approvedAtMs: now - 1 },
            effectiveFromMs: now - 1, effectiveUntilMs: now + 600000, dayLimitMicros: 1000, runLimitMicros: 1000,
            callLimitMicros: 1000, unresolvedBlockMicros: 1000, featureFlags: { providers: 'live' },
            models: { 'openai:synthetic': { inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 0, maxCallMicros: 1000 } } } }) });
      if (mode !== 'missing') await core.impl.mutate({ commandKey: 'coverage', requestId: 'coverage', now: clock.value, mutate(data) {
        const proof = { runId: 'run_2026-10-02', dataRevision: data.automation.dataRevision,
          checkedAt: new Date(clock.value - (mode === 'stale' ? 60001 : 0)).toISOString(),
          policyHash: 'a'.repeat(64), worksetHash: 'b'.repeat(64), itemCount: 1, callId: 'synthetic-coverage' };
        data.automation.runtime.runsByKey[args.runKey].contextCoverage = { proof, hash: jsonHash(proof),
          checkpointRevision: data.automation.dataRevision + 1, domainHash: domainFingerprint(data) };
        return { data, result: {} };
      } });
      if (mode === 'changed') store.forceWrite(d => { d.entities.chatgptLeads.lead1.instruction = 'Changed by user';
        d.automation.dataRevision++; return d; });
      if (mode === 'runtime') await core.impl.mutate({ commandKey: 'runtime-only', requestId: 'runtime-only', now: clock.value,
        mutate(data) { data.automation.runtime.runsByKey[args.runKey].testRuntimeCounter = 1; return { data, result: {} }; } });
      return { done: true, completion: 'wave_processed', finalized: false };
    } } });
  const s = await F.startService({ role: 'worker', ports: { clock: clock.port, jwks: F.jwksPort(key), core,
    tasks: tasks.port, sectionWork: work }, configOverrides: { QUANTUS_V3_POLICY_VERSION: '4.0', QUANTUS_V3_REQUIRED_SOURCES: '["core"]',
    QUANTUS_V3_RUNTIME_MODE: 'live', QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: 'true', QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed() } });
  const slot = mode === 'night' ? 'close23' : 'process09', runKey = `quantus:2026-10-02:${slot}:4.0`;
  const post = () => s.post('/v3/slot/start', { token: F.schedulerToken(key, {
    audience: F.AUD.slotStart, email: F.SA.schedulerStart, nowMs: clock.value }), body: { slot } });
  return { s, store, post, runKey, tasks, get calls() { return calls; } };
}

test('real HTTP daytime completion keeps open work and the day active, without a continuation or duplicate work', async t => {
  for (const mode of ['valid', 'runtime']) {
    const f = await service(mode); t.after(() => f.s.close());
    const result = await f.post(); assert.equal(result.status, 200, result.text);
    assert.equal(result.json.outcome, 'finished', result.text); assert.equal(result.json.completion, 'wave_processed');
    assert.equal(result.json.green, false);
    const data = f.store.snapshot(), run = data.automation.runtime.runsByKey[f.runKey];
    assert.equal(run.phase, 'finished'); assert.equal(run.outcome.kind, 'wave_processed');
    assert.equal(data.dailyBriefing.assistantRuns['2026-10-02'].phase, 'active');
    assert.equal(data.dailyBriefing.assistantRuns['2026-10-02'].finalNoteId, null);
    assert.equal(data.entities.chatgptLeads.lead1.instruction, 'Still needs action');
    assert.equal(run.pendingContinuationId, null);
    assert.equal((await f.post()).json.outcome, 'duplicate'); assert.equal(f.calls, 1);
  }
});
test('missing/stale coverage, a concurrent domain edit and a close23 wave claim cannot finish through the real HTTP worker', async t => {
  for (const mode of ['missing', 'stale', 'changed', 'night', 'cost']) {
    const f = await service(mode); t.after(() => f.s.close());
    const result = await f.post(); assert.equal(result.status, 200, result.text);
    assert.equal(result.json.outcome, 'exception_open', result.text); assert.equal(result.json.green, false);
    assert.notEqual(f.store.snapshot().automation.runtime.runsByKey[f.runKey].phase, 'finished');
    if (mode === 'changed') assert.equal(f.store.snapshot().entities.chatgptLeads.lead1.instruction, 'Changed by user');
  }
});
