/** Backend-only exactly-once transfer of immutable user answers into open
 * work. A consumed answer remains linked to its source; it is not evidence
 * that the requested action has been performed.
 */
import { createHash } from 'node:crypto';
import { applyCommand, validatePolicy, answerIntakeText, answerIntakeContext } from '../../../netlify/lib/assistant-core.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { HttpError } from './errors.mjs';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-answer-preparation' });
const fail = reason => { throw new HttpError(409, `answer_preparation_${reason}`); };

export function createAnswerPreparation({ core, clock, policy, tenant, runKey, sectionId, verifiedScope, signal, enabled }) {
  if (!core?.read || !core?.mutate || !clock?.now || !validatePolicy(policy).ok || policy.tenant !== tenant
    || parseSlotRunKey(runKey).tenant !== tenant || parseSlotRunKey(runKey).policyVersion !== policy.version
    || verifiedScope?.scope !== `${tenant}:mainrun`) fail('configuration_invalid');
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
  }
  return Object.freeze({
    async next() {
      const data = (await core.read())?.data; check(data);
      // A prior consumption cannot hide lost work on replay or the next day.
      // Completed/linked intakes are retained, never reopened by this audit.
      for (const a of Object.values(data.automation.answersById)) {
        if (a.consumption === undefined && a.consumedBy !== ACTOR.id) continue;
        const id = 'answer-' + hash([tenant, a.id, a.questionId]), q = data.automation.questionsById[a.questionId];
        const entry = data.automation.intakeById[id];
        if (!a.consumedAt || a.consumedBy !== ACTOR.id || !equal(a.consumption, { kind: 'intake', intakeId: id })
          || !q || !entry || entry.text !== answerIntakeText(a, q) || entry.channel !== 'quantus-answer'
          || entry.registeredBy !== ACTOR.id || !equal(entry.origin, { sourceType: 'answer', sourceId: a.id })
          || !equal(entry.answerContext, answerIntakeContext(a, q))) fail('consumed_work_missing');
      }
      const candidates = Object.values(data.automation.answersById).filter(a => !a.consumedAt)
        .sort((a, b) => String(a.answeredAt).localeCompare(String(b.answeredAt)) || a.id.localeCompare(b.id));
      if (!candidates.length) return { ready: true };
      if (enabled !== true) return { ready: false, blocked: true, reason: 'external_effects_not_allowed' };
      const answer = candidates[0], question = data.automation.questionsById[answer.questionId];
      const intakeId = 'answer-' + hash([tenant, answer.id, answer.questionId]);
      const key = 'v4-answer-consume-' + hash([tenant, answer, question]);
      const started = clock.now();
      const saved = await core.mutate({ commandKey: key, requestId: key, now: started, mutate(current) {
        check(current);
        if (!equal(current.automation.answersById[answer.id], answer)
          || !equal(current.automation.questionsById[answer.questionId], question)) fail('original_changed');
        const result = applyCommand(current, { type: 'consumeAnswerToIntake', commandId: key, now: clock.now(),
          payload: { answerId: answer.id, intakeId, consumer: ACTOR.id } }, { policy, actor: ACTOR });
        if (!result.ok) fail(result.error?.toLowerCase() || 'domain_rejected');
        assertActiveRuntimeCapacity(result.data);
        return { data: result.data, result: { answerId: answer.id, intakeId, textHash: hash(result.entry.text),
          consumedAt: result.answer.consumedAt } };
      } });
      const fresh = (await core.read())?.data; check(fresh);
      const a = fresh.automation.answersById[answer.id], entry = fresh.automation.intakeById[intakeId];
      if (saved.result?.answerId !== answer.id || saved.result?.intakeId !== intakeId
        || !a || !equal(a, { ...answer, consumedAt: saved.result.consumedAt, consumedBy: ACTOR.id,
          consumption: { kind: 'intake', intakeId } })
        || !entry || entry.id !== intakeId || hash(entry.text) !== saved.result.textHash || entry.channel !== 'quantus-answer'
        || !equal(entry.origin, { sourceType: 'answer', sourceId: answer.id }) || entry.registeredBy !== ACTOR.id
        || !equal(entry.answerContext, answerIntakeContext(answer, question))
        || entry.status !== 'open' || entry.linkedTo !== null
        || !equal(fresh.automation.questionsById[answer.questionId], question)) fail('readback_failed');
      return { ready: false, stepId: key, durationMs: Math.max(0, clock.now() - started),
        cursor: { schema: 'quantus-answer-preparation/1', runKey, fence: verifiedScope.fence, answerId: answer.id, intakeId } };
    },
  });
}
