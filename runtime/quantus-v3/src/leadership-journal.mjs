/** Durable active leadership exchanges. All writes use the existing core CAS
 * port, with a fresh lease check inside every CAS attempt. Payloads live in
 * verified private storage; core contains immutable references. Completed
 * exchanges must be archived by the retention worker before removal.
 *
 * This module does not dispatch providers or tools. Recording a response is
 * not evidence that its cost settled, its tool ran, or the daily run completed.
 */
import { createHash } from 'node:crypto';
import { assertLeadership, readRuntime, settleCost, resolveUnknownCost } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { HttpError } from './errors.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';

import { JOURNAL_LIMITS, encodeRuntimePayload, assertActiveRuntimeCapacity } from './runtime-payload.mjs';
export { JOURNAL_LIMITS, WORK_PAYLOAD_BYTES, WORK_RESULT_BYTES, encodeRuntimePayload, assertActiveRuntimeCapacity } from './runtime-payload.mjs';
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = text => createHash('sha256').update(text).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (error, status = 409) => { throw new HttpError(status, error); };

function area(data, runKey, { create = false } = {}) {
  const runtime = readRuntime(data);
  const run = runtime.runsByKey[runKey];
  if (!record(run) || run.runKey !== runKey) fail('journal_run_missing');
  const initialized = run.leadershipJournalInitialized;
  if (initialized === undefined && run.leadershipJournal === undefined) {
    if (!create) return null;
    run.leadershipJournalInitialized = true;
    run.leadershipJournal = { schemaVersion: 2, entries: [] };
  } else if (initialized !== true) fail('journal_invalid', 503);
  const journal = run.leadershipJournal;
  if (!record(journal) || ![1, 2].includes(journal.schemaVersion) || !Array.isArray(journal.entries)
    || journal.entries.length > JOURNAL_LIMITS.turns) fail('journal_invalid', 503);
  const seen = new Set();
  for (const entry of journal.entries) {
    if (!record(entry) || typeof entry.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(entry.callId)
      || seen.has(entry.callId) || !digest(entry.requestHash)
      || !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs <= 0) fail('journal_invalid', 503);
    seen.add(entry.callId);
    for (const field of ['request', 'response', 'tool']) {
      const value = entry[field];
      if (value === null && field !== 'request') continue;
      if (!record(value) || !digest(value.hash)) fail('journal_invalid', 503);
      if (journal.schemaVersion === 1) {
        if (Object.keys(value).sort().join(',') !== 'hash,text' || typeof value.text !== 'string'
          || Buffer.byteLength(value.text) > JOURNAL_LIMITS[`${field}Bytes`] || hash(value.text) !== value.hash) fail('journal_invalid', 503);
        try { JSON.parse(value.text); } catch { fail('journal_invalid', 503); }
      } else if (Object.keys(value).sort().join(',') !== 'artifact,hash' || !validArtifactReference(value.artifact)
        || value.artifact.hash !== value.hash || value.artifact.bytes > JOURNAL_LIMITS[`${field}Bytes`]) fail('journal_invalid', 503);
    }
    if (entry.tool !== null && entry.response === null) fail('journal_invalid', 503);
  }
  return journal;
}

export function createLeadershipJournal({ core, clock, runKey, verifiedScope, artifacts, signal } = {}) {
  const parsed = parseSlotRunKey(runKey);
  if (!core?.read || !core?.mutate || !clock?.now || !record(verifiedScope) || !artifacts?.put || !artifacts?.read) throw new TypeError('journal_configuration_missing');
  const scope = Object.freeze({ ...verifiedScope });
  if (scope.scope !== `${parsed.tenant}:mainrun`) fail('journal_scope_mismatch');
  function authority(data) {
    if (signal?.aborted) fail('journal_interrupted');
    assertLeadership(data, scope, clock.now());
  }
  async function snapshot() {
    if (signal?.aborted) fail('journal_interrupted');
    const data = (await core.read())?.data;
    authority(data);
    return data;
  }
  async function readPayload(value, field) {
    if (value === null) return null;
    const text = value.artifact ? await artifacts.read(value.artifact, { signal }) : value.text;
    if (typeof text !== 'string' || Buffer.byteLength(text) > JOURNAL_LIMITS[`${field}Bytes`] || hash(text) !== value.hash)
      fail('journal_payload_readback_failed', 502);
    let payload;
    try { payload = JSON.parse(text); } catch { fail('journal_payload_readback_failed', 502); }
    if (!record(payload)) fail('journal_payload_readback_failed', 502);
    return payload;
  }
  async function view(entry) {
    const [request, response, tool] = await Promise.all(['request', 'response', 'tool'].map(f => readPayload(entry[f], f)));
    return { callId: entry.callId, requestHash: entry.requestHash, createdAtMs: entry.createdAtMs, request, response, tool };
  }
  function checkReadBudget(journal) {
    const bytes = (journal?.entries || []).reduce((sum, e) => sum + ['request', 'response', 'tool'].reduce((s, f) =>
      s + (e[f] === null ? 0 : e[f].artifact?.bytes ?? Buffer.byteLength(e[f].text)), 0), 0);
    if (bytes > JOURNAL_LIMITS.readBytes) fail('journal_read_budget', 413);
  }
  async function externalize(encoded) {
    const artifact = await artifacts.put({ ...encoded, signal });
    if (!validArtifactReference(artifact) || artifact.hash !== encoded.hash || artifact.bytes !== Buffer.byteLength(encoded.text)
      || await artifacts.read(artifact, { signal }) !== encoded.text) fail('journal_artifact_readback_failed', 502);
    return { hash: encoded.hash, artifact };
  }
  async function write(field, { callId, requestHash, payload }) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(callId) || !digest(requestHash)) fail('journal_identity_invalid', 400);
    if (!record(payload)) fail('journal_payload_invalid', 400);
    const encoded = encodeRuntimePayload(payload, JOURNAL_LIMITS[`${field}Bytes`]);
    // The content digest participates in the command key. The real core port
    // binds only commandKey; a reused call ID with different content must still
    // reach the journal's immutable-entry check instead of replaying success.
    const commandKey = 'v4-journal-' + hash(JSON.stringify([runKey, callId, requestHash, field, encoded.hash]));
    const before = area(await snapshot(), runKey);
    if (before?.schemaVersion === 1) fail('journal_migration_required');
    const previous = before?.entries.find(e => e.callId === callId);
    if (!previous && field !== 'request') fail('journal_request_missing');
    if (previous?.requestHash && previous.requestHash !== requestHash) fail('journal_request_conflict');
    if (field === 'tool' && previous?.response === null) fail('journal_response_missing');
    if (previous?.[field] && previous[field].hash !== encoded.hash) fail('journal_record_conflict');
    if (previous?.[field]) {
      const result = await view(previous);
      const current = area(await snapshot(), runKey)?.entries.find(e => e.callId === callId);
      if (JSON.stringify(current) !== JSON.stringify(previous)) fail('journal_readback_failed', 502);
      return result;
    }
    if (!previous && (before?.entries.length || 0) >= JOURNAL_LIMITS.turns) fail('journal_turn_limit');
    const stored = await externalize(encoded);
    await snapshot(); // Also enforce authority after storage I/O and on replay.
    const result = await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
      authority(data);
      const journal = area(data, runKey, { create: field === 'request' });
      if (!journal) fail('journal_request_missing');
      if (journal.schemaVersion !== 2) fail('journal_migration_required');
      let entry = journal.entries.find(e => e.callId === callId);
      if (!entry) {
        if (field !== 'request') fail('journal_request_missing');
        if (journal.entries.length >= JOURNAL_LIMITS.turns) fail('journal_turn_limit');
        entry = { callId, requestHash, createdAtMs: clock.now(), request: stored, response: null, tool: null };
        journal.entries.push(entry);
      } else {
        if (entry.requestHash !== requestHash) fail('journal_request_conflict');
        if (field === 'tool' && entry.response === null) fail('journal_response_missing');
        if (entry[field] !== null && entry[field].hash !== encoded.hash) fail('journal_record_conflict');
        entry[field] = stored;
      }
      assertActiveRuntimeCapacity(data);
      // Only a small receipt enters the idempotency ledger, never a second copy
      // of full provider output (the ledger's own result limit is 64 KiB).
      return { data, result: { callId, field, hash: encoded.hash } };
    } });
    if (result?.result?.hash !== encoded.hash) fail('journal_receipt_invalid', 502);
    // Independent readback catches an acknowledged but missing write/replay.
    const current = await snapshot();
    assertActiveRuntimeCapacity(current);
    const journal = area(current, runKey);
    const entry = journal?.entries.find(e => e.callId === callId);
    if (!entry || entry.requestHash !== requestHash || entry[field]?.hash !== encoded.hash) fail('journal_readback_failed', 502);
    const viewed = await view(entry);
    if (JSON.stringify(area(await snapshot(), runKey)?.entries.find(e => e.callId === callId)) !== JSON.stringify(entry))
      fail('journal_readback_failed', 502);
    return viewed;
  }
  return Object.freeze({
    async read() {
      const journal = area(await snapshot(), runKey);
      checkReadBudget(journal);
      const result = [];
      for (const entry of journal?.entries || []) result.push(await view(entry));
      if (JSON.stringify(area(await snapshot(), runKey)) !== JSON.stringify(journal)) fail('journal_read_changed');
      return result;
    },
    async migrateInline() {
      const initial = area(await snapshot(), runKey);
      if (!initial || initial.schemaVersion === 2) return { migrated: false };
      checkReadBudget(initial);
      const replacement = structuredClone(initial);
      for (const entry of replacement.entries) for (const field of ['request', 'response', 'tool']) {
        if (entry[field] === null) continue;
        await snapshot();
        entry[field] = await externalize(entry[field]);
      }
      replacement.schemaVersion = 2;
      const originalHash = hash(JSON.stringify(initial));
      const commandKey = 'v4-journal-migrate-' + hash(JSON.stringify([runKey, originalHash, replacement]));
      await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
        authority(data);
        if (hash(JSON.stringify(area(data, runKey))) !== originalHash) fail('journal_migration_conflict');
        readRuntime(data).runsByKey[runKey].leadershipJournal = structuredClone(replacement);
        area(data, runKey); assertActiveRuntimeCapacity(data);
        return { data, result: { migrated: true } };
      } });
      if (JSON.stringify(area(await snapshot(), runKey)) !== JSON.stringify(replacement)) fail('journal_migration_readback_failed', 502);
      return { migrated: true };
    },
    begin({ callId, requestHash, request }) { return write('request', { callId, requestHash, payload: request }); },
    recordResponse({ callId, requestHash, response }) { return write('response', { callId, requestHash, payload: response }); },
    recordTool({ callId, requestHash, tool }) { return write('tool', { callId, requestHash, payload: tool }); },
    async settleResponse({ callId }) {
      // Recover only a receipt already persisted in this run's private journal.
      // The caller cannot supply a price, usage count or evidence object here.
      const observed = area(await snapshot(), runKey)?.entries.find(e => e.callId === callId);
      if (!observed?.response) fail('journal_response_missing');
      const loadedResponse = await readPayload(observed.response, 'response');
      function evidence(data) {
        const entry = area(data, runKey)?.entries.find(e => e.callId === callId);
        if (!entry?.response) fail('journal_response_missing');
        if (JSON.stringify(entry.response) !== JSON.stringify(observed.response) || entry.requestHash !== observed.requestHash) fail('journal_response_changed');
        const response = loadedResponse;
        const cost = readRuntime(data).cost.callsById[callId];
        if (!cost || cost.runKey !== runKey || cost.contentHash !== entry.requestHash || cost.dispatch?.claimed !== true) fail('journal_cost_binding_invalid');
        if (response.outcome !== 'settled' || !Number.isSafeInteger(response.actualMicros) || response.actualMicros < 0
          || typeof response.usageReceiptId !== 'string' || !response.usageReceiptId) fail('journal_usage_unconfirmed');
        return { entry, response, cost };
      }
      const initial = evidence(await snapshot());
      const commandKey = 'v4-settle-' + hash(JSON.stringify([runKey, callId, initial.entry.response.hash]));
      await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
        authority(data);
        const { response, cost } = evidence(data);
        const input = { callId, actualMicros: response.actualMicros, usageReceiptId: response.usageReceiptId,
          providerRequestId: response.providerRequestId ?? null, now: clock.now(), verifiedScope: scope };
        const out = cost.state === 'unknown'
          ? resolveUnknownCost(data, { ...input, resolution: 'charged', evidence: { kind: 'persisted_provider_receipt', ref: response.usageReceiptId } })
          : settleCost(data, input);
        if (!out.result?.ok) fail('journal_cost_settlement_rejected');
        return out;
      } });
      const { cost, response } = evidence(await snapshot());
      if (cost.state !== 'settled' || cost.settledMicros !== response.actualMicros || cost.usageReceiptId !== response.usageReceiptId
        || (response.providerRequestId && cost.providerRequestId !== response.providerRequestId)) fail('journal_cost_readback_failed', 502);
      return { settled: true, overrunMicros: cost.overrunMicros };
    },
  });
}
