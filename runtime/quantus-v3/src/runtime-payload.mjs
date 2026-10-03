import {MAX_ARTIFACT_BYTES} from '../../../netlify/lib/quantus-v4-artifact-reference.mjs';
import { createHash } from 'node:crypto';
import { readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { HttpError } from './errors.mjs';

export const JOURNAL_LIMITS = Object.freeze({ requestBytes: 512 * 1024, responseBytes: MAX_ARTIFACT_BYTES,
  toolBytes: 512 * 1024, coreBytes: 18 * 1024 * 1024, readBytes: 16 * 1024 * 1024,
  rolloverBytes: 8 * 1024 * 1024, turns: 30, segments: 1000 });
export const WORK_PAYLOAD_BYTES = 512 * 1024;
export const WORK_RESULT_BYTES = 8 * 1024;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (error, status = 409) => { throw new HttpError(status, error); };

// Validate without changing property order: reconstructed provider requests
// must retain exactly the same immutable bytes used for cost reservation.
export function encodeRuntimePayload(value, limit) {
  const seen = new Set();
  let nodes = 0;
  function visit(v, depth) {
    if (++nodes > 100000 || depth > 32) fail('journal_payload_too_complex', 413);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v) || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) fail('journal_payload_invalid', 400);
    if (Object.getOwnPropertySymbols(v).length) fail('journal_payload_invalid', 400);
    seen.add(v);
    if (Array.isArray(v) && (Object.keys(v).length !== v.length
      || Array.from({ length: v.length }, (_, i) => i).some(i => !Object.hasOwn(v, i)))) fail('journal_payload_invalid', 400);
    for (const key of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !Object.hasOwn(d, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('journal_payload_invalid', 400);
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limit) fail('journal_payload_too_large', 413);
  return { text, hash: hash(text) };
}

export function assertActiveRuntimeCapacity(data) {
  let reserved = 0;
  for (const call of Object.values(readRuntime(data).cost.callsById)) {
    if (call.commissioning && call.state !== "released" && !call.commissioningResponse) reserved += 4096;
  }
  for (const run of Object.values(readRuntime(data).runsByKey)) {
    const steps = run.sectionWork?.steps;
    if (steps !== undefined) {
      if (!record(steps)) fail('work_state_invalid', 503);
      // A claimed step reserves metadata and its compact result before source
      // work. Large payloads live externally, never in this core document.
      for (const step of Object.values(steps)) {
        if (!record(step) || !['claimed', 'completed'].includes(step.state)) fail('work_state_invalid', 503);
        if (step.state === 'claimed') reserved += 2 * WORK_RESULT_BYTES + 4096;
      }
    }
    const entries = run.leadershipJournal?.entries;
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail('journal_invalid', 503);
    if ([2, 3].includes(run.leadershipJournal.schemaVersion)) {
      for (const entry of entries) {
        if (!record(entry)) fail('journal_invalid', 503);
        // Only small, immutable reference records can enter this format.
        if (entry.response === null) reserved += 4096;
        if (entry.tool === null) reserved += 4096;
      }
      continue;
    }
    for (const entry of entries) {
      // JSON text is stored inside JSON; escaping may double its byte size.
      if (entry.response === null) reserved += 2 * (JOURNAL_LIMITS.responseBytes + JOURNAL_LIMITS.toolBytes);
      else if (entry.tool === null) {
        let response;
        try { response = JSON.parse(entry.response.text); } catch { fail('journal_invalid', 503); }
        if (response.result?.usable === true && response.result?.toolCalls?.length) reserved += 2 * JOURNAL_LIMITS.toolBytes;
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) + reserved > JOURNAL_LIMITS.coreBytes) fail('journal_core_capacity', 413);
}
