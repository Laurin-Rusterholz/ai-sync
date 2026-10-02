import { readRuntime, assertLeadership, finishRun } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { domainFingerprint, jsonHash } from './domain-fingerprint.mjs';
import { HttpError } from './errors.mjs';
export const WAVE_PROOF_MAX_AGE_MS = 60000;
const fail = reason => { throw new HttpError(409, 'wave_completion_' + reason); };

/** Called inside the real worker CAS. A wave can stop with open work, but
 * only after current full context coverage; this never makes the day green. */
export function finishWorkWave(data, { runKey, sectionId, verifiedScope, now, tenant, policyVersion }) {
  const parsed = parseSlotRunKey(runKey);
  assertLeadership(data, verifiedScope, now);
  if (parsed.tenant !== tenant || parsed.policyVersion !== policyVersion || parsed.slot === 'close23') fail('scope_invalid');
  const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
  if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
    || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_invalid');
  const coverage = run.contextCoverage, proof = coverage?.proof, checkedAt = Date.parse(proof?.checkedAt);
  if (!proof || coverage.hash !== jsonHash(proof) || proof.runId !== 'run_' + parsed.localDate
    || !Number.isSafeInteger(proof.dataRevision) || proof.dataRevision < 0
    || coverage.checkpointRevision !== proof.dataRevision + 1 || data.automation.dataRevision < coverage.checkpointRevision
    || coverage.domainHash !== domainFingerprint(data)
    || !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > WAVE_PROOF_MAX_AGE_MS
    || !/^[a-f0-9]{64}$/.test(proof.policyHash) || !/^[a-f0-9]{64}$/.test(proof.worksetHash)
    || !Number.isSafeInteger(proof.itemCount) || proof.itemCount < 0 || typeof proof.callId !== 'string' || !proof.callId)
    fail('proof_invalid');
  const daily = data.dailyBriefing?.assistantRuns?.[parsed.localDate];
  if (daily?.phase !== 'active' || daily.policyVersion !== policyVersion
    || daily.slotReceipts?.[parsed.slot]?.slotKey !== runKey
    || !data.entities?.chatgptNotes?.[daily.startNoteId]) fail('day_invalid');
  const evidenceRef = 'wave-proof:' + coverage.hash;
  const result = finishRun(data, { runKey, outcome: 'wave_processed', evidenceRef, runnerMode: 'live', now, verifiedScope });
  if (!result.result?.ok) fail('rejected');
  return result;
}
