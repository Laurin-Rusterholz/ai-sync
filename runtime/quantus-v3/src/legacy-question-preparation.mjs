import { createHash } from 'node:crypto';
import { applyCommand, validatePolicy } from '../../../netlify/lib/assistant-core.mjs';
import { planLegacyQuestions } from '../../../netlify/lib/assistant-legacy-questions.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { HttpError } from './errors.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-legacy-question-preparation' });
const fail = reason => { throw new HttpError(409, 'legacy_question_preparation_' + reason); };

export function createLegacyQuestionPreparation({ core, clock, policy, tenant, runKey, sectionId, verifiedScope, signal, enabled }) {
  const slot = parseSlotRunKey(runKey);
  if (!core?.read || !core?.mutate || !clock?.now || !validatePolicy(policy).ok || policy.tenant !== tenant
    || slot.tenant !== tenant || slot.policyVersion !== policy.version || verifiedScope?.scope !== `${tenant}:mainrun`) fail('configuration_invalid');
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
  }
  return Object.freeze({ async next() {
    const data = (await core.read())?.data; check(data);
    const plan = planLegacyQuestions(data);
    if (!plan.items.length) return plan.unresolved.length
      ? { ready: false, blocked: true, reason: 'legacy_questions_require_review', unresolved: plan.unresolved }
      : { ready: true };
    if (enabled !== true) return { ready: false, blocked: true, reason: 'external_effects_not_allowed' };
    const items = plan.items.slice(0, 32), payload = { date: slot.localDate, items };
    const key = 'v4-legacy-questions-' + hash([tenant, policy.version, payload]);
    const started = clock.now();
    const saved = await core.mutate({ commandKey: key, requestId: key, now: started, mutate(current) {
      check(current);
      const result = applyCommand(current, { type: 'migrateLegacyQuestions', commandId: key, now: clock.now(), payload }, { policy, actor: ACTOR });
      if (!result.ok) fail(result.error || 'domain_rejected');
      assertActiveRuntimeCapacity(result.data);
      return { data: result.data, result: { key, changed: result.changed,
        proof: hash(result.changed.map(id => result.data.automation.questionsById[id])) } };
    } });
    const fresh = (await core.read())?.data; check(fresh);
    const result = saved.result;
    if (result?.key !== key || !Array.isArray(result.changed)
      || hash(result.changed.map(id => fresh.automation.questionsById[id])) !== result.proof) fail('readback_failed');
    const remaining = planLegacyQuestions(fresh);
    if (remaining.items.some(item => items.some(old => old.leadId === item.leadId && old.fingerprint === item.fingerprint
      && old.expectedState === item.expectedState))) fail('readback_failed');
    return { ready: false, stepId: key, durationMs: Math.max(0, clock.now() - started),
      cursor: { schema: 'quantus-legacy-question-preparation/1', runKey, fence: verifiedScope.fence, changed: result.changed } };
  } });
}
