import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolveRuntimeConfig } from '../runtime/quantus-v3/src/config.mjs';
import { resolveAuthConfig } from '../netlify/lib/quantus-v3-auth.mjs';
import { createOpenAIWorkerPorts } from '../runtime/quantus-v3/src/openai-composition.mjs';
import { loadAssistantPolicy } from '../runtime/quantus-v3/src/section-work.mjs';
import { POLICY_TEMPLATE } from '../netlify/lib/assistant-schema.mjs';
import { makeEnv } from './fixtures/quantus-v3-auth-fixtures.mjs';
import { envFor } from './quantus-v3-e2-fixtures.mjs';
import { setup, T } from './fixtures/quantus-v4-leadership-fixture.mjs';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const contract = readJson('../infra/quantus-v3/runtime-env.json');
const inputs = readJson('../infra/quantus-v3/tests/runtime.auto.tfvars.json');
function deployment(role) {
  const auth = makeEnv({ tenant: inputs.tenant });
  const account = `quantus-${role}@quantus-test-project.iam.gserviceaccount.com`;
  const policy = { ...POLICY_TEMPLATE, tenant: inputs.tenant, version: inputs.policy_version,
    requiredSources: [{ id: 'quantus-core', kind: 'quantus-core' }], noExternalSources: true };
  const secrets = {
    [`firebase_${role}`]: JSON.stringify({ type: 'service_account', client_email: account, private_key: randomBytes(32).toString('hex') }),
    assistant_policy: JSON.stringify(policy), tool_credential: auth.secrets.service.scheduler,
    cost_policy: JSON.stringify({ version: 'synthetic-only', effectiveUntilMs: T + 86400000 }),
    worker_token_keys: auth.vars.QUANTUS_V3_WORKER_TOKEN_KEYS,
    service_credentials: auth.vars.QUANTUS_V3_SERVICE_CREDENTIALS,
    openai_api_key: randomBytes(32).toString('hex'),
  };
  const env = envFor(role, {
    QUANTUS_V3_POLICY_VERSION: inputs.policy_version,
    QUANTUS_V3_EXPECTED_SERVICE_ACCOUNT: account,
    ...Object.fromEntries(contract.public[role].map(name => [name, inputs.runtime_settings[name]])),
    ...Object.fromEntries(Object.entries(contract.secrets[role]).map(([name, key]) => [name, secrets[key]])),
    ...(role === 'worker' ? { QUANTUS_V3_FIREBASE_TENANT: inputs.tenant, QUANTUS_V3_MODE: 'enforce' } : {}),
  });
  return { env, read: name => env[name], policy };
}

for (const role of ['worker', 'monitor', 'watchdog']) {
  test(`Terraform environment contract initializes real ${role} configuration`, () => {
    const d = deployment(role);
    const result = resolveRuntimeConfig(d.read);
    assert.equal(result.ok, true, JSON.stringify(result.body));
    assert.equal(result.config.role, role);
    assert.equal(result.config.mode, 'dry_run');
    if (role !== 'watchdog') assert.equal(loadAssistantPolicy(d.read).ok, true);
    if (role === 'worker') assert.equal(resolveAuthConfig(d.read).ok, true);
  });
}

test('mapped worker secrets and settings initialize real leadership and cost ports', async () => {
  const d = deployment('worker'), s = await setup();
  const ports = await createOpenAIWorkerPorts({ config: resolveRuntimeConfig(d.read).config,
    corePort: s.core, clockPort: s.clock, envRead: d.read, artifactStore: s.artifacts.store,
    jobTokenIssuer: { available: true, mint() { throw Error('no token requested by configuration test'); } },
    providerFetch() { throw Error('configuration must not dispatch'); } });
  assert.equal(ports.sectionWork.available, true, ports.sectionWork.reason);
  assert.equal((await ports.costPolicy.impl.load()).version, 'synthetic-only');
  delete d.env.QUANTUS_V3_COST_POLICY_JSON;
  assert.equal(await ports.costPolicy.impl.load(), null);
});

for (const defect of ['missing', 'malformed', 'wrong-account', 'wrong-type', 'no-key', 'oauth-override']) {
  test(`deployed identity ${defect} is rejected without disclosing credentials`, () => {
    const d = deployment('worker');
    const original = d.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const account = JSON.parse(original);
    if (defect === 'missing') delete d.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (defect === 'malformed') d.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{';
    if (defect === 'wrong-account') account.client_email = 'other@quantus-test-project.iam.gserviceaccount.com';
    if (defect === 'wrong-type') account.type = 'authorized_user';
    if (defect === 'no-key') delete account.private_key;
    if (['wrong-account', 'wrong-type', 'no-key'].includes(defect)) d.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    if (defect === 'oauth-override') d.env.FIREBASE_OAUTH_REFRESH_TOKEN = randomBytes(32).toString('hex');
    const result = resolveRuntimeConfig(d.read);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(JSON.stringify(result).includes(JSON.parse(original).private_key), false);
    if (d.env.FIREBASE_OAUTH_REFRESH_TOKEN) assert.equal(JSON.stringify(result).includes(d.env.FIREBASE_OAUTH_REFRESH_TOKEN), false);
  });
}
