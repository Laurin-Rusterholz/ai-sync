/** Private immutable working payloads, compact runtime checkpoints. A durable
 * claim precedes every inner call; a lost response is never blindly repeated.
 * No retention/trim happens here: verified external archival owns that step.
 */
import { createHash } from 'node:crypto';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { assertActiveRuntimeCapacity, encodeRuntimePayload, WORK_PAYLOAD_BYTES, WORK_RESULT_BYTES } from './leadership-journal.mjs';
import { availablePort } from './ports.mjs';
import { HttpError } from './errors.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';

export const WORK_CURSOR_SCHEMA = 'quantus-work-cursor/1';
const hash = text => createHash('sha256').update(text).digest('hex');
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = (code, status = 409) => { throw new HttpError(status, code); };
const MAX_STEPS = 60;
const RESULT_BYTES = WORK_RESULT_BYTES;

function decode(value, limit) {
  if (!record(value) || typeof value.text !== 'string' || !digest(value.hash)
    || Buffer.byteLength(value.text) > limit || hash(value.text) !== value.hash) fail('work_state_invalid', 503);
  try { return JSON.parse(value.text); } catch { fail('work_state_invalid', 503); }
}
function area(run, pipelineId, create = false) {
  if (run.sectionWorkInitialized === undefined && run.sectionWork === undefined) {
    if (!create) return null;
    run.sectionWorkInitialized = true;
    run.sectionWork = { schemaVersion: 1, pipelineId, blobs: {}, steps: {} };
  }
  const a = run.sectionWork;
  if (run.sectionWorkInitialized !== true || !record(a) || a.schemaVersion !== 1 || a.pipelineId !== pipelineId
    || !record(a.blobs) || !record(a.steps) || Object.keys(a.steps).length > MAX_STEPS
    || Object.keys(a.blobs).length > MAX_STEPS) fail('work_state_invalid', 503);
  for (const [id, blob] of Object.entries(a.blobs)) {
    if (!digest(id) || blob?.hash !== id || !validArtifactReference(blob)) fail('work_state_invalid', 503);
  }
  for (const [id, step] of Object.entries(a.steps)) {
    if (!digest(id) || !record(step) || typeof step.sectionId !== 'string' || !step.sectionId
      || !Number.isSafeInteger(step.fence) || step.fence < 1 || !Number.isSafeInteger(step.claimedAtMs)
      || !['claimed', 'completed'].includes(step.state) || !(step.inputId === null || digest(step.inputId))) fail('work_state_invalid', 503);
    if (step.inputId !== null && !a.blobs[step.inputId]) fail('work_state_invalid', 503);
    if (step.state === 'claimed') { if (step.result !== null) fail('work_state_invalid', 503); }
    else {
      const result = decode(step.result, RESULT_BYTES);
      if (!record(result) || typeof result.done !== 'boolean') fail('work_state_invalid', 503);
      if (result.cursor && (!validRef(result.cursor) || !a.blobs[result.cursor.blobId])) fail('work_state_invalid', 503);
    }
  }
  return a;
}
function validRef(ref) {
  return record(ref) && Object.keys(ref).sort().join(',') === 'blobId,fence,runKey,schema'
    && ref.schema === WORK_CURSOR_SCHEMA && digest(ref.blobId) && typeof ref.runKey === 'string'
    && Number.isSafeInteger(ref.fence) && ref.fence > 0;
}
function samePayloadRef(a, b) {
  return validRef(a) && validRef(b) && a.schema === b.schema && a.runKey === b.runKey && a.blobId === b.blobId;
}

export function createDurableSectionWork({ core, clock, inner, artifacts, leaseScope, pipelineId } = {}) {
  if (!core?.read || !core?.mutate || !clock?.now || !inner?.next || !artifacts?.put || !artifacts?.read || typeof leaseScope !== 'string'
    || typeof pipelineId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(pipelineId)) throw new TypeError('durable_work_configuration_missing');
  return availablePort('sectionWork', {
    async next(args) {
      const { runKey, sectionId, verifiedScope, signal } = args;
      const parsed = parseSlotRunKey(runKey);
      if (leaseScope !== `${parsed.tenant}:mainrun` || verifiedScope?.scope !== leaseScope) fail('work_scope_mismatch');
      function check(data) {
        if (signal?.aborted) fail('work_interrupted');
        assertLeadership(data, verifiedScope, clock.now());
        const runtime = readRuntime(data), run = runtime.runsByKey[runKey], section = run?.sections?.[sectionId];
        if (run?.phase !== 'active' || run.currentSectionId !== sectionId || !section || section.closed === true
          || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('work_section_mismatch');
        return { runtime, run, section };
      }
      async function snapshot() { const data = (await core.read())?.data; check(data); return data; }
      const startCursor = v => record(v) && Object.keys(v).join(',') === 'position' && v.position === 0;
      const reference = startCursor(args.cursor) ? null : (args.cursor ?? null);
      if (reference !== null && (!validRef(reference) || reference.runKey !== runKey)) fail('work_cursor_invalid');
      const inputId = reference?.blobId ?? null;
      const stepKey = hash(JSON.stringify([pipelineId, runKey, sectionId, inputId]));
      function input(data) {
        const { runtime, run, section } = check(data), a = area(run, pipelineId);
        if (reference === null) {
          if (section.resumedFrom) {
            const cp = run.checkpoint, intent = runtime.continuationsById[args.resumedFrom];
            if (!startCursor(args.cursor) || !startCursor(cp?.cursor) || cp.continuationId !== args.resumedFrom
              || section.resumedFrom !== args.resumedFrom || intent?.runKey !== runKey
              || intent.consumedBySectionId !== sectionId || Object.keys(a?.steps || {}).length) fail('work_checkpoint_missing');
          }
          return null;
        }
        if (!a?.blobs[inputId]) fail('work_payload_missing', 503);
        const producedHere = Object.values(a.steps).some(step => step.sectionId === sectionId && step.state === 'completed'
          && samePayloadRef(decode(step.result, RESULT_BYTES).cursor, reference));
        if (!producedHere) {
          const cp = run.checkpoint, intent = runtime.continuationsById[args.resumedFrom];
          if (!args.resumedFrom || section.resumedFrom !== args.resumedFrom || cp?.continuationId !== args.resumedFrom
            || !samePayloadRef(cp.cursor, reference) || cp.fence !== cp.cursor.fence
            || intent?.runKey !== runKey || intent.consumedBySectionId !== sectionId) fail('work_checkpoint_mismatch');
          if (![verifiedScope.fence, cp.cursor.fence].includes(reference.fence)) fail('work_checkpoint_mismatch');
        } else if (reference.fence !== verifiedScope.fence) fail('work_checkpoint_mismatch');
        return a.blobs[inputId];
      }
      let data = await snapshot();
      const inputRef = input(data);
      const prior = area(check(data).run, pipelineId)?.steps[stepKey];
      if (prior) {
        if (prior.state !== 'completed') fail('work_outcome_unknown');
        return decode(prior.result, RESULT_BYTES);
      }
      let state = inputRef === null ? null : decode({ text: await artifacts.read(inputRef, { signal }), hash: inputRef.hash }, WORK_PAYLOAD_BYTES);
      if (state !== null && !record(state)) fail('work_state_invalid', 503);
      // The original external object remains immutable; only the execution
      // copy receives the independently verified current section's lease.
      if (state && Object.hasOwn(state, 'fence')) state = { ...state, fence: verifiedScope.fence };
      const claimKey = `work-claim-${stepKey}`;
      const claim = await core.mutate({ commandKey: claimKey, requestId: claimKey, now: clock.now(), mutate(draft) {
        const { run } = check(draft); input(draft);
        const a = area(run, pipelineId, true);
        if (a.steps[stepKey]) fail('work_already_claimed');
        if (Object.keys(a.steps).length >= MAX_STEPS) fail('work_step_limit');
        a.steps[stepKey] = { sectionId, inputId, fence: verifiedScope.fence, claimedAtMs: clock.now(), state: 'claimed', result: null };
        assertActiveRuntimeCapacity(draft);
        return { data: draft, result: { stepKey, state: 'claimed' } };
      } });
      if (claim?.replayed !== false || claim?.wrote !== true || claim.result?.stepKey !== stepKey) fail('work_claim_unconfirmed');
      data = await snapshot();
      const claimed = area(check(data).run, pipelineId)?.steps[stepKey];
      if (claimed?.state !== 'claimed' || claimed.fence !== verifiedScope.fence) fail('work_claim_readback_failed', 502);
      assertActiveRuntimeCapacity(data);
      input(data);
      const output = await inner.next({ ...args, cursor: state });
      if (!record(output) || typeof output.done !== 'boolean' || (!output.done && (typeof output.stepId !== 'string' || !output.stepId)))
        fail('work_response_invalid', 502);
      const result = { ...output };
      let blob = null;
      if (Object.hasOwn(output, 'cursor') && output.cursor !== null) {
        if (!record(output.cursor)) fail('work_response_invalid', 502);
        const encodedState = encodeRuntimePayload(output.cursor, WORK_PAYLOAD_BYTES);
        await snapshot();
        blob = await artifacts.put({ ...encodedState, signal });
        if (!validArtifactReference(blob) || blob.hash !== encodedState.hash || blob.bytes !== Buffer.byteLength(encodedState.text)
          || await artifacts.read(blob, { signal }) !== encodedState.text) fail('work_artifact_readback_failed', 502);
        result.cursor = { schema: WORK_CURSOR_SCHEMA, runKey, blobId: blob.hash, fence: verifiedScope.fence };
      }
      const encoded = encodeRuntimePayload(result, RESULT_BYTES);
      const finishKey = `work-result-${hash(JSON.stringify([stepKey, encoded.hash, blob?.hash ?? null]))}`;
      await snapshot();
      await core.mutate({ commandKey: finishKey, requestId: finishKey, now: clock.now(), mutate(draft) {
        const a = area(check(draft).run, pipelineId), step = a?.steps[stepKey];
        if (!step || step.fence !== verifiedScope.fence) fail('work_claim_missing');
        if (step.state === 'completed' && step.result.hash !== encoded.hash) fail('work_result_conflict');
        if (blob) a.blobs[blob.hash] = blob;
        step.state = 'completed'; step.result = encoded;
        assertActiveRuntimeCapacity(draft);
        return { data: draft, result: { stepKey, resultHash: encoded.hash } };
      } });
      data = await snapshot();
      const saved = area(check(data).run, pipelineId)?.steps[stepKey];
      if (saved?.state !== 'completed' || saved.result.hash !== encoded.hash) fail('work_result_readback_failed', 502);
      return decode(saved.result, RESULT_BYTES);
    },
  });
}
