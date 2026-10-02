import { createHash } from 'node:crypto';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { runIdForRunKey, statusScopeIdForRunKey } from './run-ids.mjs';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const fingerprint = items => createHash('sha256').update(JSON.stringify(canonical([...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))).digest('hex');
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

/** Model prose never establishes coverage. Require recorded complete reads,
 * then independently refresh their sources without intervening journal writes.
 * Runtime-only revision changes do not change content fingerprints; new work
 * or changed policy requires the model to read the updated complete workset.
 */
export function createLeadershipCompletionCheck({ runKey, gateway }) {
  const required = requiredLeadershipReads(runKey), parsed = parseSlotRunKey(runKey);
  const runId = runIdForRunKey(runKey);
  return async ({ entries, signal }) => {
    const records = new Map();
    let lastWrite = -1;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], call = entry.response?.result?.toolCalls?.[0];
      if (call?.name === 'quantus_command' && entry.tool?.response?.body?.applied === true) lastWrite = index;
      for (const expected of required) {
        const matches = expected.query === 'run.status' ? call?.name === 'quantus_run_status'
          : call?.name === 'quantus_context' && call.arguments?.query === expected.query && call.arguments.scopeId === expected.scopeId;
        if (matches && call.arguments?.cursor === '' && valid(entry.tool, expected)) records.set(expected.query, { index, receipt: entry.tool });
      }
    }
    const missing = required.filter(r => !records.has(r.query) || (r.query !== 'policy.current' && records.get(r.query).index < lastWrite));
    if (missing.length) return { complete: false, reason: 'required_context_unread', requiredReads: missing };
    const fresh = [];
    for (const expected of required) {
      if (signal?.aborted) return { complete: false, blocked: true, reason: 'context_check_interrupted' };
      let receipt;
      try {
        receipt = await gateway.execute({ name: expected.query === 'run.status' ? 'quantus_run_status' : 'quantus_context',
          arguments: expected.query === 'run.status' ? { cursor: '' } : { ...expected, cursor: '' } },
          { responseId: 'completion-check', callId: 'coverage-' + expected.query.replace('.', '-') });
      } catch { return { complete: false, blocked: true, reason: 'context_refresh_unconfirmed' }; }
      if (!valid(receipt, expected)) return { complete: false, blocked: true, reason: 'context_refresh_unconfirmed' };
      fresh.push(receipt.response.body);
    }
    if (fresh.some(b => b.dataRevision !== fresh[0].dataRevision))
      return { complete: false, reason: 'context_revision_changed', requiredReads: required };
    const [policy, workset, status] = fresh;
    if (policy.items.length !== 1 || policy.items[0].policyVersion !== parsed.policyVersion
      || status.items.length !== 1 || status.items[0].runId !== runId || status.items[0].policyVersion !== parsed.policyVersion)
      return { complete: false, blocked: true, reason: 'context_policy_or_run_mismatch' };
    if (workset.items.some(item => item.sourceMissing === true))
      return { complete: false, blocked: true, reason: 'context_original_missing' };
    const changed = [required[0], required[1]].filter((r, i) => fingerprint(fresh[i].items) !== fingerprint(records.get(r.query).receipt.response.body.items));
    if (changed.length) return { complete: false, reason: 'context_contents_changed', requiredReads: [...changed, required[2]] };
    return { complete: true, proof: { runId, dataRevision: status.dataRevision, checkedAt: status.serverNow,
      policyHash: fingerprint(policy.items), worksetHash: fingerprint(workset.items), itemCount: workset.count } };
  };
}
