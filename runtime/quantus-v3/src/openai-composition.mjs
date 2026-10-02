/** Production leadership composition. Missing configuration never selects a
 * different provider. External effects still require the existing live gates,
 * fresh cost policy, atomic monthly cap and current section/lease authority.
 */
import { unavailablePort } from './ports.mjs';
import { HttpError } from './errors.mjs';
import { createEnvCostPolicyPort } from './cost-policy-port.mjs';
import { createCostAdapter } from './cost-adapter.mjs';
import { MONTHLY_CAP_MICROS } from './monthly-cost-cap.mjs';
import { loadAssistantPolicy } from './section-work.mjs';
import { createBriefingSectionWork } from './briefing-bootstrap.mjs';
import { createOpenAITransport } from './openai-transport.mjs';
import { createLeadershipGateway } from './leadership-gateway.mjs';
import { createLeadershipJournal, JOURNAL_LIMITS } from './leadership-journal.mjs';
import { createV4LeadershipLoop } from './v4-leadership-loop.mjs';
import { createC2HttpTransport } from './c2-transport.mjs';
import { createJobTokenIssuer } from './job-token-issuer.mjs';
import { createWorkArtifactStore } from './work-artifact-store.mjs';
import { createGoogleAccessTokenSource } from './google-transport.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { loadQuantusV4Prompts, MAIN_PROMPT_SLOTS } from '../../../netlify/lib/quantus-v4-prompts.mjs';
import { createHash } from 'node:crypto';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';

export async function createOpenAIWorkerPorts({ config, corePort, clockPort,
  envRead = name => process.env[name], artifactStore, jobTokenIssuer,
  c2Transport, providerFetch = globalThis.fetch } = {}) {
  const costPolicy = createEnvCostPolicyPort(envRead);
  const unavailable = reason => ({ sectionWork: unavailablePort('sectionWork', reason), costPolicy });
  if (corePort && Object.hasOwn(corePort, 'available')) corePort = corePort.available ? corePort.impl : null;
  if (!corePort?.read || !corePort?.mutate || !clockPort?.now) return unavailable('leadership_core_or_clock_missing');
  const apiKey = envRead('QUANTUS_V4_OPENAI_API_KEY');
  const model = envRead('QUANTUS_V4_OPENAI_MODEL');
  const promptVersion = envRead('QUANTUS_V4_PROMPT_VERSION');
  const compact = envRead('QUANTUS_V4_OPENAI_COMPACT_THRESHOLD');
  if (compact !== undefined && (typeof compact !== 'string' || !/^\d+$/.test(compact)
    || !Number.isSafeInteger(Number(compact)) || Number(compact) < 1000 || Number(compact) > 100000))
    return unavailable('openai_compaction_not_configured');
  const rates = ['QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK', 'QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK'].map(envRead);
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof model !== 'string' || !model.trim()
    || rates.some(v => typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))))
    return unavailable('openai_provider_not_configured');
  const policyResult = loadAssistantPolicy(envRead);
  if (!policyResult.ok) return unavailable('assistant_policy_not_configured');
  try {
    for (const slot of MAIN_PROMPT_SLOTS) await loadQuantusV4Prompts({ slot, expectedVersion: promptVersion });
  } catch { return unavailable('v4_prompt_bundle_unavailable'); }
  if (!config?.c2BaseUrl) return unavailable('c2_base_url_not_configured');
  jobTokenIssuer ??= await createJobTokenIssuer({});
  if (jobTokenIssuer.available !== true || typeof jobTokenIssuer.mint !== 'function') return unavailable('leadership_job_token_unavailable');
  try {
    if (!artifactStore) {
      const bucket = envRead('QUANTUS_V4_ARTIFACT_BUCKET');
      if (!bucket) return unavailable('artifact_bucket_not_configured');
      const tokens = await createGoogleAccessTokenSource({});
      if (!tokens.ok) return unavailable('artifact_credentials_not_configured');
      artifactStore = createWorkArtifactStore({ bucket, tenant: config.tenant,
        getAccessToken: tokens.get, maxPayloadBytes: JOURNAL_LIMITS.responseBytes });
    }
    c2Transport ??= createC2HttpTransport({ baseUrl: config.c2BaseUrl });
    const openai = createOpenAITransport({ apiKey, model, fetchImpl: providerFetch,
      compactionThreshold: compact === undefined ? null : Number(compact),
      modelPricing: { inputMicrosPerMillionTokens: Number(rates[0]), outputMicrosPerMillionTokens: Number(rates[1]) } });
    const inner = { async next({ runKey, sectionId, verifiedScope, signal }) {
      const startedAt = clockPort.now();
      function check(data) {
        if (signal?.aborted) throw new HttpError(409, 'leadership_interrupted');
        assertLeadership(data, verifiedScope, clockPort.now());
        const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
        if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
          || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence)
          throw new HttpError(409, 'leadership_section_mismatch');
        if (signal?.aborted) throw new HttpError(409, 'leadership_interrupted');
      }
      async function activeLease() {
        check((await corePort.read())?.data);
        return { holder: verifiedScope.holder, fence: verifiedScope.fence };
      }
      await activeLease();
      const journal = createLeadershipJournal({ core: corePort, clock: clockPort, runKey, verifiedScope, artifacts: artifactStore, signal });
      const gateway = createLeadershipGateway({ transport: c2Transport, jobTokenIssuer, clock: clockPort,
        runKey, tenant: config.tenant, toolsEnabled: config.toolsEnabled, lease: activeLease, signal });
      const costAdapter = createCostAdapter({ config, now: startedAt, verifiedScope, requestId: `leadership:${sectionId}`,
        ports: { require(name) {
          if (name === 'core') return corePort;
          if (name === 'clock') return clockPort;
          if (name === 'costPolicy') return costPolicy.impl;
          throw new HttpError(503, 'port_unavailable');
        } } }, { monthlyCap: { capMicros: MONTHLY_CAP_MICROS } });
      const loop = await createV4LeadershipLoop({ tenant: config.tenant, promptVersion, runKey, journal, openai, gateway, costAdapter });
      let result;
      try { result = await loop.step({ signal }); }
      catch (error) {
        // These are explicit local gate decisions, not an unknown provider
        // outcome. Persist them through the worker's exception path.
        await activeLease();
        const code = error?.error || error?.code;
        if (!['cost_policy_unavailable', 'cost_policy_invalid', 'external_effects_not_allowed',
          'providers_not_live', 'cost_reserve_rejected', 'cost_claim_rejected'].includes(code)) throw error;
        return { done: false, blocked: true,
          reason: code === 'cost_reserve_rejected' && error.detail?.code === 'monthly_budget_exceeded'
            ? 'monthly_budget_exceeded' : code };
      }
      await activeLease();
      if (result.kind === 'blocked') return { done: false, blocked: true, reason: result.reason };
      // Runtime completion still passes through independent closureEvidence.
      // Model text is not a persisted user note or a daily finalization proof.
      if (result.kind === 'model_complete') {
        if (!result.coverageProof) throw new HttpError(502, 'context_coverage_proof_missing');
        const proof = { ...result.coverageProof, callId: result.callId };
        const hash = createHash('sha256').update(JSON.stringify(proof)).digest('hex');
        const key = 'v4-coverage-' + createHash('sha256').update(JSON.stringify([runKey, hash])).digest('hex');
        const saved = await corePort.mutate({ commandKey: key, requestId: key, now: clockPort.now(), mutate(data) {
          check(data);
          if (data.automation.dataRevision !== proof.dataRevision) throw new HttpError(409, 'context_changed_before_checkpoint');
          readRuntime(data).runsByKey[runKey].contextCoverage = { hash, proof };
          assertActiveRuntimeCapacity(data);
          return { data, result: { hash } };
        } });
        const data = (await corePort.read())?.data;
        check(data);
        const stored = readRuntime(data).runsByKey[runKey].contextCoverage;
        if (saved.result?.hash !== hash || stored?.hash !== hash || JSON.stringify(stored.proof) !== JSON.stringify(proof))
          throw new HttpError(502, 'context_coverage_readback_failed');
        return { done: true };
      }
      if (!['model_recorded', 'tool_recorded'].includes(result.kind)) throw new HttpError(502, 'leadership_phase_invalid');
      return { done: false, stepId: `${result.callId}:${result.kind}`, durationMs: Math.max(0, clockPort.now() - startedAt),
        cursor: { schema: 'quantus-leadership-cursor/1', runKey, fence: verifiedScope.fence, callId: result.callId, phase: result.kind } };
    } };
    return { costPolicy, sectionWork: createBriefingSectionWork({ core: corePort, clock: clockPort,
      policy: policyResult.policy, config, inner }) };
  } catch {
    // Constructor diagnostics must never echo environment values or secrets.
    return unavailable('openai_worker_construction_failed');
  }
}
