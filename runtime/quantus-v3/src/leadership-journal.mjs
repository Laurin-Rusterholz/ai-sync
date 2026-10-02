/** Durable active leadership exchanges. All writes use the existing core CAS
 * port, with a fresh lease check inside every CAS attempt. Payloads are private
 * runtime state, never part of the model-facing read projection. Completed
 * exchanges must be archived by the retention worker before removal.
 *
 * This module does not dispatch providers or tools. Recording a response is
 * not evidence that its cost settled, its tool ran, or the daily run completed.
 */
import { createHash } from 'node:crypto';
import { assertLeadership, readRuntime, settleCost, resolveUnknownCost } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { HttpError } from './errors.mjs';

export const JOURNAL_LIMITS = Object.freeze({ requestBytes: 512 * 1024, responseBytes: 3 * 1024 * 1024,
  toolBytes: 512 * 1024, coreBytes: 18 * 1024 * 1024, turns: 30 });
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = text => createHash('sha256').update(text).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (error, status = 409) => { throw new HttpError(status, error); };

// Validate without changing property order: reconstructed provider requests
// must retain exactly the same immutable bytes used for cost reservation.
function encode(value, limit) {
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

function area(data, runKey, { create = false } = {}) {
  const runtime = readRuntime(data);
  const run = runtime.runsByKey[runKey];
  if (!record(run) || run.runKey !== runKey) fail('journal_run_missing');
  const initialized = run.leadershipJournalInitialized;
  if (initialized === undefined && run.leadershipJournal === undefined) {
    if (!create) return null;
    run.leadershipJournalInitialized = true;
    run.leadershipJournal = { schemaVersion: 1, entries: [] };
  } else if (initialized !== true) fail('journal_invalid', 503);
  const journal = run.leadershipJournal;
  if (!record(journal) || journal.schemaVersion !== 1 || !Array.isArray(journal.entries)
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
      if (!record(value) || typeof value.text !== 'string' || !digest(value.hash)
        || Buffer.byteLength(value.text) > JOURNAL_LIMITS[`${field}Bytes`] || hash(value.text) !== value.hash) fail('journal_invalid', 503);
      try { JSON.parse(value.text); } catch { fail('journal_invalid', 503); }
    }
    if (entry.tool !== null && entry.response === null) fail('journal_invalid', 503);
  }
  return journal;
}

function view(entry) {
  return { callId: entry.callId, requestHash: entry.requestHash, createdAtMs: entry.createdAtMs,
    request: JSON.parse(entry.request.text), response: entry.response === null ? null : JSON.parse(entry.response.text),
    tool: entry.tool === null ? null : JSON.parse(entry.tool.text) };
}

function assertCapacity(data) {
  let reserved = 0;
  for (const run of Object.values(readRuntime(data).runsByKey)) {
    const entries = run.leadershipJournal?.entries;
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail('journal_invalid', 503);
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

export function createLeadershipJournal({ core, clock, runKey, verifiedScope } = {}) {
  parseSlotRunKey(runKey);
  if (!core?.read || !core?.mutate || !clock?.now || !record(verifiedScope)) throw new TypeError('journal_configuration_missing');
  const scope = Object.freeze({ ...verifiedScope });
  async function snapshot() {
    const data = (await core.read())?.data;
    assertLeadership(data, scope, clock.now());
    return data;
  }
  async function write(field, { callId, requestHash, payload }) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(callId) || !digest(requestHash)) fail('journal_identity_invalid', 400);
    if (!record(payload)) fail('journal_payload_invalid', 400);
    const encoded = encode(payload, JOURNAL_LIMITS[`${field}Bytes`]);
    // The content digest participates in the command key. The real core port
    // binds only commandKey; a reused call ID with different content must still
    // reach the journal's immutable-entry check instead of replaying success.
    const commandKey = 'v4-journal-' + hash(JSON.stringify([runKey, callId, requestHash, field, encoded.hash]));
    await snapshot(); // Also enforce authority when the idempotency port replays.
    const result = await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
      assertLeadership(data, scope, clock.now());
      const journal = area(data, runKey, { create: field === 'request' });
      if (!journal) fail('journal_request_missing');
      let entry = journal.entries.find(e => e.callId === callId);
      if (!entry) {
        if (field !== 'request') fail('journal_request_missing');
        if (journal.entries.length >= JOURNAL_LIMITS.turns) fail('journal_turn_limit');
        entry = { callId, requestHash, createdAtMs: clock.now(), request: encoded, response: null, tool: null };
        journal.entries.push(entry);
      } else {
        if (entry.requestHash !== requestHash) fail('journal_request_conflict');
        if (field === 'tool' && entry.response === null) fail('journal_response_missing');
        if (entry[field] !== null && entry[field].hash !== encoded.hash) fail('journal_record_conflict');
        entry[field] = encoded;
      }
      assertCapacity(data);
      // Only a small receipt enters the idempotency ledger, never a second copy
      // of full provider output (the ledger's own result limit is 64 KiB).
      return { data, result: { callId, field, hash: encoded.hash } };
    } });
    if (result?.result?.hash !== encoded.hash) fail('journal_receipt_invalid', 502);
    // Independent readback catches an acknowledged but missing write/replay.
    const current = await snapshot();
    assertCapacity(current);
    const journal = area(current, runKey);
    const entry = journal?.entries.find(e => e.callId === callId);
    if (!entry || entry.requestHash !== requestHash || entry[field]?.hash !== encoded.hash) fail('journal_readback_failed', 502);
    return view(entry);
  }
  return Object.freeze({
    async read() { return (area(await snapshot(), runKey)?.entries || []).map(view); },
    begin({ callId, requestHash, request }) { return write('request', { callId, requestHash, payload: request }); },
    recordResponse({ callId, requestHash, response }) { return write('response', { callId, requestHash, payload: response }); },
    recordTool({ callId, requestHash, tool }) { return write('tool', { callId, requestHash, payload: tool }); },
    async settleResponse({ callId }) {
      // Recover only a receipt already persisted in this run's private journal.
      // The caller cannot supply a price, usage count or evidence object here.
      function evidence(data) {
        const entry = area(data, runKey)?.entries.find(e => e.callId === callId);
        if (!entry?.response) fail('journal_response_missing');
        const response = JSON.parse(entry.response.text);
        const cost = readRuntime(data).cost.callsById[callId];
        if (!cost || cost.runKey !== runKey || cost.contentHash !== entry.requestHash || cost.dispatch?.claimed !== true) fail('journal_cost_binding_invalid');
        if (response.outcome !== 'settled' || !Number.isSafeInteger(response.actualMicros) || response.actualMicros < 0
          || typeof response.usageReceiptId !== 'string' || !response.usageReceiptId) fail('journal_usage_unconfirmed');
        return { entry, response, cost };
      }
      const initial = evidence(await snapshot());
      const commandKey = 'v4-settle-' + hash(JSON.stringify([runKey, callId, initial.entry.response.hash]));
      await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
        assertLeadership(data, scope, clock.now());
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
