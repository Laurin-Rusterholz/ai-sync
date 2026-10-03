/** Durable active leadership exchanges. All writes use the existing core CAS
 * port, with a fresh lease check inside every CAS attempt. Payloads live in
 * verified private storage; core contains immutable references. Settled older
 * exchanges move into verified history segments; their original payloads and
 * cost/replay identities remain intact. Retention never follows from rollover.
 *
 * This module does not dispatch providers or tools. Recording a response is
 * not evidence that its cost settled, its tool ran, or the daily run completed.
 */
import { createHash } from 'node:crypto';
import { assertLeadership, readRuntime, settleCost, resolveUnknownCost } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { HttpError } from './errors.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';
import { leadershipCoverageFacts } from './leadership-coverage.mjs';
import {isCommissioningClientFor,commissioningClientContract} from './commissioning-client.mjs';
import { commandUnconfirmed } from './leadership-command-state.mjs';

import { JOURNAL_LIMITS, encodeRuntimePayload, assertActiveRuntimeCapacity } from './runtime-payload.mjs';
export { JOURNAL_LIMITS, WORK_PAYLOAD_BYTES, WORK_RESULT_BYTES, encodeRuntimePayload, assertActiveRuntimeCapacity } from './runtime-payload.mjs';
const commissionedJournals=new WeakMap();
export const isCommissioningJournal=journal=>commissionedJournals.has(journal);
export const commissioningJournalContract=journal=>commissionedJournals.get(journal)??null;
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
  if (!record(journal) || ![1, 2, 3].includes(journal.schemaVersion) || !Array.isArray(journal.entries)
    || journal.entries.length > JOURNAL_LIMITS.turns) fail('journal_invalid', 503);
  if (journal.schemaVersion === 3) {
    if (!Array.isArray(journal.segments) || !journal.segments.length || journal.segments.length > JOURNAL_LIMITS.segments
      || !journal.entries.length) fail('journal_segments_invalid', 503);
    let count = 0;
    for (const segment of journal.segments) {
      if (!record(segment) || Object.keys(segment).sort().join(',') !== 'archive,count,start'
        || segment.start !== count || !Number.isSafeInteger(segment.count) || segment.count < 1 || segment.count >= JOURNAL_LIMITS.turns
        || !validArtifactReference(segment.archive)) fail('journal_segments_invalid', 503);
      count += segment.count;
    }
    if (journal.archivedCount !== count) fail('journal_segments_invalid', 503);
  } else if (journal.segments !== undefined || journal.archivedCount !== undefined) fail('journal_segments_invalid', 503);
  validateEntries(journal.entries, journal.schemaVersion);
  return journal;
}

function validateEntries(entries, schemaVersion) {
  const seen = new Set();
  for (const entry of entries) {
    if (!record(entry) || typeof entry.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(entry.callId)
      || seen.has(entry.callId) || !digest(entry.requestHash)
      || !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs <= 0) fail('journal_invalid', 503);
    seen.add(entry.callId);
    for (const field of ['request', 'response', 'tool']) {
      const value = entry[field];
      if (value === null && field !== 'request') continue;
      if (!record(value) || !digest(value.hash)) fail('journal_invalid', 503);
      if (schemaVersion === 1) {
        if (Object.keys(value).sort().join(',') !== 'hash,text' || typeof value.text !== 'string'
          || Buffer.byteLength(value.text) > JOURNAL_LIMITS[`${field}Bytes`] || hash(value.text) !== value.hash) fail('journal_invalid', 503);
        try { JSON.parse(value.text); } catch { fail('journal_invalid', 503); }
      } else if (Object.keys(value).sort().join(',') !== 'artifact,hash' || !validArtifactReference(value.artifact)
        || value.artifact.hash !== value.hash || value.artifact.bytes > JOURNAL_LIMITS[`${field}Bytes`]) fail('journal_invalid', 503);
    }
    if (entry.tool !== null && entry.response === null) fail('journal_invalid', 503);
  }
}

export function createLeadershipJournal({ core, clock, runKey, verifiedScope, artifacts, signal, commissioningClient } = {}) {
  const parsed = parseSlotRunKey(runKey);
  if (!core?.read || !core?.mutate || !clock?.now || !record(verifiedScope) || !artifacts?.put || !artifacts?.read) throw new TypeError('journal_configuration_missing');
  if(commissioningClient&&!isCommissioningClientFor(commissioningClient,core))fail('journal_commissioning_binding_invalid',503);
  const sourceProofs=new Map();
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
  function activeBytes(journal) {
    return (journal?.entries || []).reduce((sum, e) => sum + ['request', 'response', 'tool'].reduce((s, f) =>
      s + (e[f] === null ? 0 : e[f].artifact?.bytes ?? Buffer.byteLength(e[f].text)), 0), 0);
  }
  function checkReadBudget(journal) {
    if (activeBytes(journal) > JOURNAL_LIMITS.readBytes) fail('journal_read_budget', 413);
  }
  async function externalize(encoded) {
    const artifact = await artifacts.put({ ...encoded, signal });
    if (!validArtifactReference(artifact) || artifact.hash !== encoded.hash || artifact.bytes !== Buffer.byteLength(encoded.text)
      || await artifacts.read(artifact, { signal }) !== encoded.text) fail('journal_artifact_readback_failed', 502);
    return { hash: encoded.hash, artifact };
  }
  function summary(entry) {
    return { archived: true, callId: entry.callId, requestHash: entry.requestHash, createdAtMs: entry.createdAtMs,
      policyHash: hash(JSON.stringify({ instructions: entry.request.instructions, tools: entry.request.tools, transport: entry.request.transport })),
      coverageFacts: leadershipCoverageFacts(entry, runKey) };
  }
  function usageForClosed(entry) {
    const response = entry.response, calls = response?.result?.toolCalls;
    if (response?.outcome !== 'settled' || response.result?.usable !== true || !Array.isArray(calls) || calls.length > 1
      || !Number.isSafeInteger(response.actualMicros) || response.actualMicros < 0 || typeof response.usageReceiptId !== 'string'
      || !response.usageReceiptId || (calls.length === 1 && (!entry.tool || commandUnconfirmed(calls[0], entry.tool))))
      fail('journal_history_unconfirmed');
    return { callId: entry.callId, requestHash: entry.requestHash, actualMicros: response.actualMicros,
      usageReceiptId: response.usageReceiptId, providerRequestId: response.providerRequestId ?? null };
  }
  function ordinal(journal,callId) {
    const offset=journal?.archivedCount||0,index=journal?.entries.findIndex(e=>e.callId===callId);
    if(!Number.isInteger(index)||index<0)fail('journal_entry_missing');
    const n=offset+index;
    if(callId!=='lead-'+hash(JSON.stringify([runKey,n])))fail('journal_sequence_invalid');
    return n;
  }
  async function verifySource(original,index) {
    if(!commissioningClient)return null;
    if(original.callId!=='lead-'+hash(JSON.stringify([runKey,index])))fail('journal_sequence_invalid');
    const proof=await commissioningClient.recover({runKey,stepIndex:index,request:original.request,verifiedScope:scope,signal});
    if(proof.requestHash!==original.requestHash||proof.outcome!=='settled'
      ||JSON.stringify(proof.response)!==JSON.stringify(original.response))fail('journal_source_receipt_mismatch');
    sourceProofs.set(original.callId,{requestHash:original.requestHash,proof});
    await snapshot();return proof;
  }
  function verifyCost(data, usage) {
    if(commissioningClient){
      const verified=sourceProofs.get(usage.callId),proof=verified?.proof;
      if(verified?.requestHash!==usage.requestHash||proof?.outcome!=='settled'||proof.settledMicros!==usage.actualMicros
        ||proof.response.usageReceiptId!==usage.usageReceiptId
        ||(usage.providerRequestId&&proof.response.providerRequestId!==usage.providerRequestId)||proof.overrunMicros!==0)
        fail('journal_history_cost_unconfirmed');
      return;
    }
    const cost = readRuntime(data).cost?.callsById?.[usage.callId];
    if (cost?.runKey !== runKey || cost.state !== 'settled' || cost.dispatch?.claimed !== true
      || cost.contentHash !== usage.requestHash || cost.settledMicros !== usage.actualMicros
      || cost.usageReceiptId !== usage.usageReceiptId || (usage.providerRequestId && cost.providerRequestId !== usage.providerRequestId)
      || (cost.overrunMicros ?? 0) !== 0) fail('journal_history_cost_unconfirmed');
  }
  async function readSegment(segment) {
    await snapshot();
    const text = await artifacts.read(segment.archive, { signal });
    if (typeof text !== 'string' || Buffer.byteLength(text) !== segment.archive.bytes || hash(text) !== segment.archive.hash)
      fail('journal_history_readback_failed', 502);
    let archive; try { archive = JSON.parse(text); } catch { fail('journal_history_invalid', 503); }
    if (archive?.schema !== 'quantus-leadership-history/1' || archive.runKey !== runKey || archive.start !== segment.start
      || !Array.isArray(archive.entries) || archive.entries.length !== segment.count
      || !Array.isArray(archive.summaries) || archive.summaries.length !== segment.count) fail('journal_history_invalid', 503);
    validateEntries(archive.entries, 2);
    archive.summaries.forEach((s, index) => {
      const e = archive.entries[index];
      if (s?.archived !== true || s.callId !== e.callId || s.requestHash !== e.requestHash || s.createdAtMs !== e.createdAtMs
        || !digest(s.policyHash) || !record(s.coverageFacts) || typeof s.coverageFacts.writeApplied !== 'boolean'
        || (s.coverageFacts.read !== null && !record(s.coverageFacts.read))) fail('journal_history_invalid', 503);
    });
    await snapshot(); return archive;
  }
  async function archivedEntry(journal, callId) {
    for (const segment of journal?.segments || []) {
      const archive = await readSegment(segment), entry = archive.entries.find(e => e.callId === callId);
      if (entry) return entry;
    }
    return null;
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
    const nextId = 'lead-' + hash(JSON.stringify([runKey, (before?.archivedCount || 0) + (before?.entries.length || 0)]));
    if (!previous && before?.schemaVersion === 3 && callId !== nextId) {
      const old = await archivedEntry(before, callId);
      if (old) {
        if (old.requestHash !== requestHash || old[field]?.hash !== encoded.hash) fail('journal_record_conflict');
        const result = await view(old);
        if (JSON.stringify(area(await snapshot(), runKey)) !== JSON.stringify(before)) fail('journal_read_changed');
        return result;
      }
    }
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
      if (![2, 3].includes(journal.schemaVersion)) fail('journal_migration_required');
      if (JSON.stringify(journal.segments || []) !== JSON.stringify(before?.segments || [])) fail('journal_segments_changed');
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
  const journalApi=Object.freeze({
    async read() {
      const journal = area(await snapshot(), runKey);
      checkReadBudget(journal);
      const result = []; let metadataBytes = 0;
      for (const segment of journal?.segments || []) {
        const archive = await readSegment(segment);
        metadataBytes += Buffer.byteLength(JSON.stringify(archive.summaries));
        if (metadataBytes > JOURNAL_LIMITS.readBytes) fail('journal_history_metadata_budget', 413);
        result.push(...archive.summaries);
      }
      for (const entry of journal?.entries || []) result.push(await view(entry));
      if (JSON.stringify(area(await snapshot(), runKey)) !== JSON.stringify(journal)) fail('journal_read_changed');
      return result;
    },
    async rolloverIfNeeded() {
      const initial = area(await snapshot(), runKey);
      if (!initial || initial.schemaVersion === 1 || initial.entries.length < 2
        || (initial.entries.length < JOURNAL_LIMITS.turns && activeBytes(initial) < JOURNAL_LIMITS.rolloverBytes)) return { rolled: false };
      if ((initial.segments?.length || 0) >= JOURNAL_LIMITS.segments) fail('journal_history_segment_limit');
      // Retain the latest exchange in full, including a pending response/tool.
      // Only settled predecessors can enter an immutable history segment.
      const entries = initial.entries.slice(0, -1), summaries = [], usages = [];
      for (const [index,entry] of entries.entries()) {
        const original = await view(entry), usage = usageForClosed(original);
        await verifySource(original,(initial.archivedCount||0)+index);
        verifyCost(await snapshot(), usage); usages.push(usage); summaries.push(summary(original));
      }
      const start = initial.archivedCount || 0;
      const archive = { schema: 'quantus-leadership-history/1', runKey, start, entries, summaries };
      const stored = await externalize(encodeRuntimePayload(archive, JOURNAL_LIMITS.responseBytes));
      const replacement = { schemaVersion: 3, archivedCount: start + entries.length,
        segments: [...(initial.segments || []), { start, count: entries.length, archive: stored.artifact }], entries: initial.entries.slice(-1) };
      const initialHash = hash(JSON.stringify(initial));
      const commandKey = 'v4-journal-rollover-' + hash(JSON.stringify([runKey, initialHash, stored.hash]));
      await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
        authority(data);
        if (hash(JSON.stringify(area(data, runKey))) !== initialHash) fail('journal_rollover_conflict');
        usages.forEach(u => verifyCost(data, u));
        readRuntime(data).runsByKey[runKey].leadershipJournal = structuredClone(replacement);
        area(data, runKey); assertActiveRuntimeCapacity(data);
        return { data, result: { historyHash: stored.hash } };
      } });
      if (JSON.stringify(area(await snapshot(), runKey)) !== JSON.stringify(replacement)) fail('journal_rollover_readback_failed', 502);
      await readSegment(replacement.segments.at(-1));
      return { rolled: true, archivedCount: replacement.archivedCount };
    },
    async verifyArchives() {
      const initial = area(await snapshot(), runKey);
      for (const segment of initial?.segments || []) {
        const archive = await readSegment(segment), usages = [];
        // Stream originals one exchange at a time: total history may exceed
        // the active-window budget, but no complete history is held in RAM.
        for (let index = 0; index < archive.entries.length; index++) {
          const original = await view(archive.entries[index]);
          if (JSON.stringify(summary(original)) !== JSON.stringify(archive.summaries[index])) fail('journal_history_proof_mismatch');
          await verifySource(original,segment.start+index);
          usages.push(usageForClosed(original));
        }
        const data = await snapshot(); usages.forEach(u => verifyCost(data, u));
      }
      if (JSON.stringify(area(await snapshot(), runKey)) !== JSON.stringify(initial)) fail('journal_read_changed');
      return { verified: true, archivedCount: initial?.archivedCount || 0 };
    },
    async migrateInline() {
      const initial = area(await snapshot(), runKey);
      if (!initial || initial.schemaVersion !== 1) return { migrated: false };
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
    ...(commissioningClient?{async dispatchCommissioning({callId,requestHash,signal:callSignal}){
      const initial=area(await snapshot(),runKey),entry=initial?.entries.find(e=>e.callId===callId);
      if(!entry||entry.requestHash!==requestHash)fail('journal_entry_missing');
      const request=await readPayload(entry.request,'request');
      if(commissioningClientContract(commissioningClient).prepare(request).contentHash!==requestHash)fail('journal_request_contract_mismatch');
      const proof=await commissioningClient.respond({runKey,stepIndex:ordinal(initial,callId),request,verifiedScope:scope,signal:callSignal??signal});
      if(callSignal?.aborted)fail('journal_interrupted');
      if(proof.requestHash!==requestHash)fail('journal_source_receipt_mismatch');
      await write('response',{callId,requestHash,payload:proof.response});
      return proof;
    }}:{}),
    async settleResponse({ callId }) {
      // Recover only a receipt already persisted in this run's private journal.
      // The caller cannot supply a price, usage count or evidence object here.
      const observed = area(await snapshot(), runKey)?.entries.find(e => e.callId === callId);
      if (!observed?.response) fail('journal_response_missing');
      const loadedResponse = await readPayload(observed.response, 'response');
      if(commissioningClient){
        const initial=area(await snapshot(),runKey);
        const proof=await verifySource(await view(observed),ordinal(initial,callId));
        if(JSON.stringify(area(await snapshot(),runKey)?.entries.find(e=>e.callId===callId))!==JSON.stringify(observed))fail('journal_response_changed');
        return {settled:true,overrunMicros:proof.overrunMicros};
      }
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
  if(commissioningClient)commissionedJournals.set(journalApi,commissioningClientContract(commissioningClient));
  return journalApi;
}
