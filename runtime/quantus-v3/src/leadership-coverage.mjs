import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { runIdForRunKey, statusScopeIdForRunKey } from './run-ids.mjs';
import { contextFingerprint as fingerprint, validContextPacket } from './context-packets.mjs';

export function requiredLeadershipReads(runKey) {
  return [ { query: 'policy.current', scopeId: 'policy_current' },
    { query: 'run.workset', scopeId: runIdForRunKey(runKey) },
    { query: 'run.status', scopeId: statusScopeIdForRunKey(runKey) } ];
}

function valid(receipt, expected) {
  const b = receipt?.response?.body;
  return receipt?.confirmed === true && receipt.readComplete === true && receipt.response.status === 200
    && b?.ok === true && b.query === expected.query && b.scopeId === expected.scopeId
    && b.complete === true && b.hasMore === false && b.pageStatus === 'done' && b.cursor === null
    && Array.isArray(b.items) && b.items.length === b.count && Number.isSafeInteger(b.dataRevision)
    && b.dataRevision >= 0 && typeof b.serverNow === 'string' && Number.isFinite(Date.parse(b.serverNow))
    && b.items.every(i => i && typeof i.id === 'string' && i.id)
    && new Set(b.items.map(i => i.id)).size === b.items.length;
}
function snapshot(receipt, expected) {
  if (expected.query === 'run.workset' && validContextPacket(receipt, expected)) {
    const p = receipt.contextPacket;
    return { hash: p.contentHash, count: p.itemCount, sourceMissing: p.sourceMissing };
  }
  if (valid(receipt, expected)) return { hash: fingerprint(receipt.response.body.items), count: receipt.response.body.count,
    sourceMissing: receipt.response.body.items.some(i => i.sourceMissing === true) };
  return null;
}

/** Only trusted journal code persists these facts, after checking the full
 * original receipt. They are never copied from model text or tool arguments.
 */
export function leadershipCoverageFacts(entry, runKey) {
  const call = entry.response?.result?.toolCalls?.[0];
  const facts = { writeApplied: call?.name === 'quantus_command' && entry.tool?.response?.body?.applied === true, read: null };
  for (const expected of requiredLeadershipReads(runKey)) {
    const matches = expected.query === 'run.status' ? call?.name === 'quantus_run_status'
      : call?.name === 'quantus_context' && call.arguments?.query === expected.query && call.arguments.scopeId === expected.scopeId;
    const observed = matches ? snapshot(entry.tool, expected) : null;
    if (!observed) continue;
    facts.read = { ...expected, snapshot: observed, inputCursor: call.arguments?.cursor ?? null,
      nextCursor: entry.tool.response.body.cursor,
      packet: expected.query === 'run.workset' && validContextPacket(entry.tool, expected) ? entry.tool.contextPacket : null };
  }
  return facts;
}

/** Model prose never establishes coverage. Require recorded complete reads,
 * then independently refresh their sources without intervening journal writes.
 * Runtime-only revision changes do not change content fingerprints; new work
 * or changed policy requires the model to read the updated complete workset.
 */
export function createLeadershipCompletionCheck({ runKey, gateway }) {
  const required = requiredLeadershipReads(runKey), parsed = parseSlotRunKey(runKey);
  const runId = runIdForRunKey(runKey);
  return async ({ entries, signal }) => {
    const records = new Map(), chains = new Map();
    let lastWrite = -1;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], facts = entry.archived === true ? entry.coverageFacts : leadershipCoverageFacts(entry, runKey);
      if (facts.writeApplied) lastWrite = index;
      for (const expected of required) {
        const read = facts.read;
        if (read?.query !== expected.query || read.scopeId !== expected.scopeId) continue;
        if (read.packet) {
          const p = read.packet, previous = chains.get(expected.query);
          if (p.index === 0 && read.inputCursor === '') {
            chains.set(expected.query, { first: index, read });
            records.delete(expected.query);
          } else if (previous && p.index === previous.read.packet.index + 1
            && read.inputCursor === previous.read.nextCursor
            && JSON.stringify({ ...p, index: 0 }) === JSON.stringify({ ...previous.read.packet, index: 0 })) {
            chains.set(expected.query, { first: previous.first, read });
          } else { chains.delete(expected.query); records.delete(expected.query); continue; }
          if (p.index + 1 === p.count) records.set(expected.query, { index: chains.get(expected.query).first, read });
        } else if (read.inputCursor === '') {
          records.set(expected.query, { index, read }); chains.delete(expected.query);
        }
      }
    }
    const missing = required.filter(r => !records.has(r.query) || (r.query !== 'policy.current' && records.get(r.query).index < lastWrite));
    if (missing.length) return { complete: false, reason: 'required_context_unread', requiredReads: missing.map(r => {
      const chain = chains.get(r.query);
      return chain && chain.first > lastWrite && chain.read.nextCursor
        ? { ...r, cursor: chain.read.nextCursor } : r;
    }) };
    const fresh = [];
    for (const expected of required) {
      if (signal?.aborted) return { complete: false, blocked: true, reason: 'context_check_interrupted' };
      let receipt;
      try {
        receipt = await gateway.execute({ name: expected.query === 'run.status' ? 'quantus_run_status' : 'quantus_context',
          arguments: expected.query === 'run.status' ? { cursor: '' } : { ...expected, cursor: '' } },
          { responseId: 'completion-check', callId: 'coverage-' + expected.query.replace('.', '-') });
      } catch { return { complete: false, blocked: true, reason: 'context_refresh_unconfirmed' }; }
      if (!snapshot(receipt, expected) || (receipt.contextPacket && receipt.contextPacket.index !== 0))
        return { complete: false, blocked: true, reason: 'context_refresh_unconfirmed' };
      fresh.push(receipt);
    }
    if (fresh.some(r => r.response.body.dataRevision !== fresh[0].response.body.dataRevision))
      return { complete: false, reason: 'context_revision_changed', requiredReads: required };
    const [policy, , status] = fresh.map(r => r.response.body), workset = snapshot(fresh[1], required[1]);
    if (policy.items.length !== 1 || policy.items[0].policyVersion !== parsed.policyVersion
      || status.items.length !== 1 || status.items[0].runId !== runId || status.items[0].policyVersion !== parsed.policyVersion)
      return { complete: false, blocked: true, reason: 'context_policy_or_run_mismatch' };
    if (workset.sourceMissing)
      return { complete: false, blocked: true, reason: 'context_original_missing' };
    const changed = [required[0], required[1]].filter((r, i) => snapshot(fresh[i], r).hash !== records.get(r.query).read.snapshot.hash);
    if (changed.length) return { complete: false, reason: 'context_contents_changed', requiredReads: [...changed, required[2]] };
    return { complete: true, proof: { runId, dataRevision: status.dataRevision, checkedAt: status.serverNow,
      policyHash: fingerprint(policy.items), worksetHash: workset.hash, itemCount: workset.count } };
  };
}
