import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../netlify/lib/quantus-v3-job-router.mjs';
const T = Date.parse('2026-09-20T09:00:00Z');
const iso = value => new Date(value).toISOString();

function fixture() {
  const policy = {
    schema: R.ROUTER_POLICY_SCHEMA, version: 'test-1', tenant: 'test', costUnit: 'microUSD',
    models: {
      lead: { provider: 'openai', modelId: 'synthetic-lead', tested: true,
        approvedFor: ['leadership', 'text_work'], contextTokensMax: 10000, revokedAt: null },
      worker: { provider: 'claude', modelId: 'synthetic-worker', tested: true,
        approvedFor: ['text_work', 'second_opinion'], contextTokensMax: 10000, revokedAt: null },
    },
    tools: { openai: [], claude: [] }, secondOpinion: { maxUnits: 5 },
    freshness: { attestationMaxAgeMs: 3600000, measurementMaxAgeMs: 86400000 },
    sandbox: { isolatedAvailable: false }, featureFlags: { providers: 'dry_run' },
  };
  const facts = {
    schema: R.ROUTER_FACTS_SCHEMA,
    task: { sourceType: 'chatgptLead', sourceId: 'lead-1', sourceVersion: 3,
      taskClass: 'bounded_text', goal: 'Draft synthetic text', requiredTools: [],
      expectedReturn: { format: 'markdown' }, acceptanceCriteria: ['Bounded result'] },
    context: { requiredDataIds: ['lead:lead-1'], tokensMeasured: 100,
      grants: {
        openai: { dataIds: ['lead:lead-1'], revokedDataIds: [], tools: [] },
        claude: { dataIds: ['lead:lead-1'], revokedDataIds: [], tools: [] },
      } },
    capabilities: { leadershipCanDo: true }, budget: { availableUnits: 100, unit: 'microUSD' },
    measurements: {
      self: { units: 10, measuredAt: iso(T - 1000), unit: 'microUSD', modelKey: 'lead', policyVersion: 'test-1', sourceVersion: 3 },
      delegation: { claude: { executionUnits: 3, handoverUnits: 1, reviewUnits: 1, measuredAt: iso(T - 1000),
        unit: 'microUSD', modelKey: 'worker', policyVersion: 'test-1', sourceVersion: 3 } },
    },
    risk: { flagged: false, authorityConfirmed: true },
    deterministicChecks: { deadline: 'ok', duplicate: 'ok', permission: 'ok', state: 'ok' },
  };
  return { policy, facts };
}
function plan(change = () => {}) {
  const input = fixture();
  change(input);
  input.facts.attestation = { by: 'backend', at: iso(T - 100), fingerprint: R.factsFingerprint(input.facts) };
  return R.planJobRoute({ ...input, now: T });
}
function blocked(result) {
  assert.ok(result.ok === false || ['blocked', 'draft'].includes(result.route?.kind), JSON.stringify(result.route));
}

test('G1-00: measured cheaper bounded work yields a non-authorizing plan', () => {
  const result = plan();
  assert.equal(result.route.kind, 'delegate');
  assert.equal(result.route.executor, 'claude');
  assert.equal(result.manifest.budget.total, 5);
  assert.equal(result.manifest.executionAuthorized, false);
});
test('G1-01: unrelated currency units cannot be compared as the same budget', () => {
  blocked(plan(({ facts }) => { facts.budget.unit = 'JPY'; }));
});
test('G1-02: absent self measurements are not proof that delegation is cheaper or capability is missing', () => {
  blocked(plan(({ facts }) => { facts.measurements.self = null; }));
});
test('G1-03: measurements from the future cannot justify the route at the current time', () => {
  blocked(plan(({ facts }) => {
    facts.measurements.self.measuredAt = iso(T + 86400000);
    facts.measurements.delegation.claude.measuredAt = iso(T + 86400000);
  }));
});
test('G1-04: a flagged action without confirmed authority remains a draft regardless of task class', () => {
  blocked(plan(({ facts }) => { facts.risk = { flagged: true, authorityConfirmed: false }; }));
});
test('G1-05: malformed required tools is a structured denial rather than an uncaught exception', () => {
  let result;
  assert.doesNotThrow(() => { result = plan(({ facts }) => { facts.task.requiredTools = 'quantus_command'; }); });
  blocked(result);
});
