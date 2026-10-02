import { applyCommand, requireCore, pruefeWiderspruch } from '../../../netlify/lib/assistant-core.mjs';
import { readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { loadAssistantPolicy } from './section-work.mjs';
import { availablePort, unavailablePort } from './ports.mjs';
import { externalEffectsAllowed } from './config.mjs';
import { jsonHash } from './domain-fingerprint.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { HttpError } from './errors.mjs';
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-closure-review' });
const fail = reason => { throw new HttpError(409, 'closure_review_' + reason); };

export function createClosureReviewPort({ core, clock, config, envRead }) {
  if (core && Object.hasOwn(core, 'available')) core = core.available ? core.impl : null;
  const loaded = loadAssistantPolicy(envRead);
  if (!core?.read || !core?.mutate || !clock?.now || !loaded.ok)
    return unavailablePort('closureReview', 'closure_review_not_configured');
  const policy = structuredClone(loaded.policy);
  if (policy.tenant !== config.tenant || policy.version !== config.policyVersion)
    return unavailablePort('closureReview', 'closure_review_policy_mismatch');
  function audit(data) {
    requireCore(data);
    const runtime = readRuntime(data), markers = runtime.monitor.closureReviews || {};
    for (const [date, daily] of Object.entries(data.dailyBriefing.assistantRuns))
      if (daily.corrections?.some(c => c.by === ACTOR.id && c.id !== markers[date]?.correctionId)) fail('correction_marker_missing');
    for (const [date, marker] of Object.entries(markers)) {
      const daily = data.dailyBriefing.assistantRuns[date];
      if (daily?.phase !== 'exception_open' || jsonHash(daily.corrections?.find(c => c.id === marker.correctionId)) !== marker.correctionHash
        || daily.finalNoteId !== marker.finalNoteId || daily.closureRevision !== marker.closureRevision
        || jsonHash(daily.closureOutcomes) !== marker.closureOutcomesHash
        || jsonHash(data.entities.chatgptNotes[marker.finalNoteId]) !== marker.finalNoteHash
        || jsonHash(data.entities.chatgptNotes[marker.correctionId]) !== marker.correctionNoteHash)
        fail('correction_readback_failed');
      for (const run of Object.values(runtime.runsByKey)) if (run.localDate === date
        && run.green !== false) fail('runtime_green_after_correction');
    }
    return runtime;
  }
  function candidates(data) {
    audit(data);
    const out = [];
    for (const [date, daily] of Object.entries(data.dailyBriefing.assistantRuns).sort(([a], [b]) => a.localeCompare(b))) {
      if (daily.phase !== 'final') continue;
      if (daily.policyVersion !== policy.version) fail('historical_policy_unavailable');
      if (!daily.finalNoteId || !data.entities.chatgptNotes[daily.finalNoteId]
        || !daily.closureOutcomes || !Number.isSafeInteger(daily.closureRevision)
        || !Number.isFinite(Date.parse(daily.closureCutoff)) || Date.parse(daily.closureCutoff) > clock.now()) fail('final_evidence_missing');
      const check = pruefeWiderspruch(data, { date }, { now: clock.now(), policy });
      if (!check.ok || !check.final) fail('domain_check_failed');
      if (check.contradictions.length) out.push({ date, daily, contradiction: check.contradictions[0] });
    }
    return out;
  }
  async function reviewOne() {
      const initial = (await core.read())?.data, pending = candidates(initial);
      if (!pending.length || !externalEffectsAllowed(config)) return { corrected: 0, pending: pending.length };
      // Each correction has its own transaction and independent readback.
      const { date, daily, contradiction } = pending[0];
      const finalNote = initial.entities.chatgptNotes[daily.finalNoteId];
      const identity = jsonHash([config.tenant, date, daily.closureRevision, daily.finalNoteId]);
      const correctionId = 'v4-correction-' + identity, key = 'v4-closure-review-' + identity;
      const saved = await core.mutate({ commandKey: key, requestId: key, now: clock.now(), mutate(data) {
        audit(data);
        const current = data.dailyBriefing.assistantRuns[date];
        if (jsonHash(current) !== jsonHash(daily) || jsonHash(data.entities.chatgptNotes[daily.finalNoteId]) !== jsonHash(finalNote))
          fail('final_changed');
        const result = applyCommand(data, { type: 'invalidateClosure', commandId: key, now: clock.now(), payload: {
          date, correctionId, reason: 'Die erneute Backend-Prüfung widerspricht dem gespeicherten Abschluss.',
          contradiction: { sourceType: contradiction.sourceType, sourceId: contradiction.sourceId },
        } }, { policy, actor: ACTOR });
        if (!result.ok || result.already) fail('contradiction_changed');
        const runtime = readRuntime(result.data);
        const marker = { correctionId, finalNoteId: daily.finalNoteId, finalNoteHash: jsonHash(finalNote),
          closureRevision: daily.closureRevision, closureOutcomesHash: jsonHash(daily.closureOutcomes),
          correctionNoteHash: jsonHash(result.data.entities.chatgptNotes[correctionId]), correctionHash: jsonHash(result.correction) };
        runtime.monitor.closureReviews ??= {};
        runtime.monitor.closureReviews[date] = marker;
        for (const run of Object.values(runtime.runsByKey)) if (run.localDate === date) {
          run.green = false;
          run.dailyClosureInvalidation = { correctionId, atMs: clock.now() };
        }
        assertActiveRuntimeCapacity(result.data);
        return { data: result.data, result: { marker } };
      } });
      const fresh = (await core.read())?.data;
      const runtime = audit(fresh);
      if (jsonHash(runtime.monitor.closureReviews?.[date]) !== jsonHash(saved.result?.marker)) fail('receipt_mismatch');
      return { corrected: saved.replayed === true ? 0 : 1, pending: candidates(fresh).length };
  }
  return availablePort('closureReview', {
    async review() {
      const started = clock.now(); let corrected = 0, pending = 0;
      do {
        const result = await reviewOne(); corrected += result.corrected; pending = result.pending;
        if (!result.corrected) break;
      } while (pending && corrected < 8 && clock.now() - started < 20000);
      return { corrected, pending };
    },
  });
}
