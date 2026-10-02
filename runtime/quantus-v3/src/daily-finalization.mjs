/** Backend closure after independently verified model coverage. Source-check
 * refresh and domain closure are pure mutations committed in one CAS. */
import { createHash } from 'node:crypto';
import { applyCommand, validatePolicy } from '../../../netlify/lib/assistant-core.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { runIdForRunKey } from './run-ids.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { HttpError } from './errors.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-daily-finalization' });
const fail = reason => { throw new HttpError(409, `daily_finalization_${reason}`); };
function domainHash(data) {
  const copy = structuredClone(data);
  // Lease/checkpoint/idempotency writes advance the global revision without
  // changing any domain original. Only these known areas are excluded.
  delete copy.automation.runtime; delete copy.automation.activeLease;
  delete copy.automation.idempotencyByKey; delete copy.automation.dataRevision;
  return hash(copy);
}

export function createDailyFinalization({ core, clock, policy, tenant, runKey, sectionId, verifiedScope, signal, enabled }) {
  const parsed = parseSlotRunKey(runKey);
  if (!core?.read || !core?.mutate || !clock?.now || !validatePolicy(policy).ok
    || policy.tenant !== tenant || parsed.tenant !== tenant || parsed.policyVersion !== policy.version
    || verifiedScope?.scope !== `${tenant}:mainrun`) fail('configuration_invalid');
  policy = structuredClone(policy);
  const date = parsed.localDate, noteId = 'v4-final-' + hash([tenant, date, policy.version]);
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const runtime = readRuntime(data).runsByKey[runKey], section = runtime?.sections?.[sectionId];
    if (runtime?.phase !== 'active' || runtime.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
    return runtime;
  }
  function verify(data, marker) {
    const runtime = check(data), daily = data.dailyBriefing?.assistantRuns?.[date];
    const coverage = runtime.contextCoverage;
    if (!marker || marker.schema !== 'quantus-daily-finalization/1' || marker.runKey !== runKey
      || marker.policyHash !== hash(policy) || marker.noteId !== noteId
      || !coverage || hash(coverage.proof) !== coverage.hash || coverage.hash !== marker.coverageHash
      || coverage.proof.dataRevision !== marker.coverageRevision
      || coverage.checkpointRevision !== marker.checkpointRevision || marker.checkpointRevision !== marker.coverageRevision + 1
      || daily?.phase !== 'final' || daily.finalNoteId !== noteId
      || daily.closureRevision !== marker.closureRevision || data.automation.dataRevision < marker.closureRevision
      || domainHash(data) !== marker.domainHash
      || hash(daily) !== marker.dailyHash || hash(data.entities.chatgptNotes[noteId]) !== marker.noteHash)
      fail('readback_failed');
  }
  return Object.freeze({
    async next() {
      const initial = (await core.read())?.data, runtime = check(initial);
      if (runtime.dailyFinalization) {
        verify(initial, runtime.dailyFinalization);
        return { done: true, finalized: true };
      }
      // Daytime waves cannot create a final day. Their runtime disposition
      // continues to be decided by the independent worker evidence path.
      if (parsed.slot !== 'close23') return { done: true, finalized: false };
      if (enabled !== true) return { done: false, blocked: true, reason: 'external_effects_not_allowed' };
      const coverage = runtime.contextCoverage, proof = coverage?.proof;
      const checked = Date.parse(proof?.checkedAt);
      if (!proof || coverage.hash !== hash(proof) || proof.runId !== runIdForRunKey(runKey)
        || !Number.isSafeInteger(proof.dataRevision) || coverage.checkpointRevision !== proof.dataRevision + 1
        || coverage.checkpointRevision !== initial.automation.dataRevision
        || !Number.isFinite(checked) || checked > clock.now()
        || clock.now() - checked > policy.evaluationTtlMinutes * 60000
        || !/^[a-f0-9]{64}$/.test(proof.policyHash) || !/^[a-f0-9]{64}$/.test(proof.worksetHash)
        || !Number.isSafeInteger(proof.itemCount) || proof.itemCount < 0
        || typeof proof.callId !== 'string' || !proof.callId) fail('coverage_invalid');
      const key = 'v4-finalize-' + hash([runKey, coverage.hash, policy]);
      let saved;
      try { saved = await core.mutate({ commandKey: key, requestId: key, now: clock.now(), mutate(data) {
        const current = check(data);
        if (data.automation.dataRevision !== coverage.checkpointRevision || hash(current.contextCoverage) !== hash(coverage))
          fail('context_changed');
        if (clock.now() < checked || clock.now() - checked > policy.evaluationTtlMinutes * 60000) fail('coverage_stale');
        const closed = applyCommand(data, { type: 'closeRunAfterCoreRead', commandId: key, now: clock.now(),
          payload: { date, finalNoteId: noteId } }, { policy, actor: ACTOR });
        if (!closed.ok) {
          if (closed.error !== 'CLOSURE_BLOCKED') fail('domain_rejected');
          // Discard the tentative core refresh as well: no partial commit.
          throw new HttpError(409, 'daily_closure_blocked', { blockers: (closed.detail || []).map(b => b.code) });
        }
        if (closed.already) fail('unbound_existing_final');
        const daily = closed.data.dailyBriefing.assistantRuns[date];
        const marker = { schema: 'quantus-daily-finalization/1', runKey, policyHash: hash(policy),
          coverageHash: coverage.hash, coverageRevision: proof.dataRevision, checkpointRevision: coverage.checkpointRevision,
          closureRevision: daily.closureRevision,
          noteId, dailyHash: hash(daily), noteHash: hash(closed.data.entities.chatgptNotes[noteId]), domainHash: domainHash(closed.data) };
        readRuntime(closed.data).runsByKey[runKey].dailyFinalization = marker;
        assertActiveRuntimeCapacity(closed.data);
        return { data: closed.data, result: { marker } };
      } }); } catch (error) {
        if (error?.error !== 'daily_closure_blocked') throw error;
        return { done: false, blocked: true, reason: 'daily_closure_blocked', blockers: error.detail?.blockers || [] };
      }
      const fresh = (await core.read())?.data;
      if (hash(check(fresh).dailyFinalization) !== hash(saved.result?.marker)) fail('receipt_mismatch');
      verify(fresh, saved.result.marker);
      return { done: true, finalized: true };
    },
  });
}
