/** Resolve only server-bound mail intakes already authorized in a complete C2
 * workset. Exact source originals, including explicit gaps, enter the same
 * projection/secret scan and immutable packet fingerprint as other context.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { createGmailOriginalStore } from './gmail-original-store.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';
import { projectPage } from '../../../netlify/lib/quantus-v3-read-helpers.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { runIdForRunKey } from './run-ids.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { SNAPSHOT_LIMITS } from './context-packets.mjs';

const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, fields) => object(v) && Object.keys(v).sort().join(',') === fields.split(',').sort().join(',');
const fail = reason => { throw new HttpError(409, `gmail_context_${reason}`); };

export function createGmailContextHydrator({ core, clock, artifacts, runKey, tenant, sectionId, verifiedScope, signal }) {
  if (!core?.read || !clock?.now || !artifacts?.read || !artifacts?.put
    || parseSlotRunKey(runKey).tenant !== tenant || verifiedScope?.scope !== `${tenant}:mainrun`) fail('configuration_invalid');
  const runId = runIdForRunKey(runKey);
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
  }
  async function snapshot() { const data = (await core.read())?.data; check(data); return data; }
  function validateBinding(entry) {
    const binding = entry?.externalSource, row = binding?.record, identity = binding?.identity;
    if (!keys(binding, 'schema,identity,sourceKey,record') || binding.schema !== 'quantus-gmail-intake/1'
      || !keys(identity, 'tenant,account,sourceId') || identity.tenant !== tenant || binding.sourceKey !== hash(identity)
      || !keys(row, 'messageId,threadId,historyId,contentHash,bytes,reference,version,previous,importedAtMs,partial,gapCount')
      || !/^[A-Za-z0-9_-]{1,256}$/.test(row.messageId || '') || !/^[A-Za-z0-9_-]{1,256}$/.test(row.threadId || '')
      || !/^[1-9][0-9]{0,29}$/.test(row.historyId || '') || !/^[a-f0-9]{64}$/.test(row.contentHash || '')
      || !Number.isSafeInteger(row.version) || row.version < 1 || !validArtifactReference(row.reference)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 32 * 1024 * 1024
      || !Number.isSafeInteger(row.importedAtMs) || row.importedAtMs <= 0
      || (row.version === 1 ? row.previous !== null : !validArtifactReference(row.previous))
      || !Number.isSafeInteger(row.gapCount) || row.gapCount < 0 || row.partial !== (row.gapCount > 0)
      || entry.id !== 'gmail-' + hash([identity, row.messageId, row.version, row.contentHash])
      || entry.registeredBy !== 'quantus-v4-gmail-intake' || entry.channel !== 'gmail'
      || !equal(entry.origin, { sourceType: 'gmail', sourceId: identity.sourceId })) fail('binding_invalid');
    return binding;
  }
  function registryRow(data, binding) {
    const runtime = readRuntime(data), source = runtime.gmailRegistry?.sources?.[binding.sourceKey];
    if (runtime.gmailRegistryInitialized !== true || !equal(source?.identity, binding.identity)) fail('registry_invalid');
    const row = source.records?.[hash([binding.identity.account, binding.record.messageId])];
    if (!row || row.messageId !== binding.record.messageId || !Number.isSafeInteger(row.version)
      || row.version < binding.record.version) fail('registry_invalid');
    return row;
  }
  async function proveVersion(binding, current) {
    let row = current;
    // Historical open intakes remain readable, but only through the committed
    // registry chain. Never trust an arbitrary artifact supplied in core text.
    for (let depth = 0; !equal(row, binding.record); depth++) {
      if (depth >= 1000 || row.version <= binding.record.version || !validArtifactReference(row.previous)) fail('version_chain_invalid');
      await snapshot();
      const text = await artifacts.read(row.previous, { signal });
      await snapshot();
      if (typeof text !== 'string' || Buffer.byteLength(text) !== row.previous.bytes
        || createHash('sha256').update(text).digest('hex') !== row.previous.hash) fail('version_chain_invalid');
      let previous;
      try { previous = JSON.parse(text); } catch { fail('version_chain_invalid'); }
      if (!keys(previous, 'schema,identity,record') || previous.schema !== 'quantus-gmail-registry-version/1'
        || !equal(previous.identity, binding.identity) || previous.record?.messageId !== binding.record.messageId
        || previous.record.version !== row.version - 1 || !/^[1-9][0-9]{0,29}$/.test(previous.record.historyId || '')
        || !/^[1-9][0-9]{0,29}$/.test(row.historyId || '')
        || BigInt(previous.record.historyId) >= BigInt(row.historyId)) fail('version_chain_invalid');
      row = previous.record;
    }
  }
  return Object.freeze({
    async hydrate({ items, dataRevision, scopeId }) {
      if (scopeId !== runId || !Array.isArray(items) || !Number.isSafeInteger(dataRevision)) fail('scope_invalid');
      const data = await snapshot();
      if (data.automation.dataRevision !== dataRevision) fail('revision_changed');
      const output = [], bindings = [];
      for (const item of items) {
        const entry = item.sourceType === 'intake' ? data.automation.intakeById?.[item.sourceId] : null;
        if (entry?.externalSource === undefined) { output.push(item); continue; }
        if (item.runId !== runId || item.id !== `ctx_intake_${entry.id}` || item.sourceId !== entry.id
          || item.text !== entry.text || item.sourceMissing !== true) fail('item_binding_invalid');
        const binding = validateBinding(entry), row = binding.record, current = registryRow(data, binding);
        const latestId = 'gmail-' + hash([binding.identity, current.messageId, current.version, current.contentHash]);
        const latestEntry = data.automation.intakeById?.[latestId];
        if (!latestEntry || !equal(validateBinding(latestEntry).record, current)) fail('latest_version_unbound');
        await proveVersion(binding, current);
        const originalStore = createGmailOriginalStore({ artifacts, ...binding.identity, signal, lease: snapshot });
        const value = await originalStore.read({ messageId: row.messageId, reference: row.reference });
        const mail = value.original;
        if (value.contentHash !== row.contentHash || value.bytes !== row.bytes || mail.historyId !== row.historyId
          || mail.threadId !== row.threadId || mail.partial !== row.partial || !Array.isArray(mail.gaps)
          || mail.gaps.length !== row.gapCount) fail('original_mismatch');
        let details;
        try { details = JSON.parse(item.contextDetails); } catch { fail('item_binding_invalid'); }
        if (!object(details) || details.originalState !== 'external_read_required') fail('item_binding_invalid');
        const enriched = { ...item, text: value.text, sourceMissing: row.partial, contextDetails: JSON.stringify({ ...details,
          originalState: 'verified', untrustedSource: true, original: { kind: 'gmail', account: binding.identity.account,
            messageId: row.messageId, version: row.version, latestVersion: current.version,
            superseded: current.version !== row.version, contentHash: row.contentHash, partial: row.partial, gapCount: row.gapCount } }) };
        // Scan the entire allowed original before packet splitting. Never let
        // fragment boundaries hide a provider secret or silently truncate text.
        const projected = projectPage('run.workset', [enriched], { maxStringLength: SNAPSHOT_LIMITS.maxBytes });
        if (!projected.ok || !projected.usable || projected.items[0]?.text !== value.text) fail('projection_rejected');
        output.push(projected.items[0]); bindings.push({ intakeId: entry.id, entry, binding, current, latestId, latestEntry });
      }
      if (Buffer.byteLength(JSON.stringify(output)) > SNAPSHOT_LIMITS.maxBytes) fail('snapshot_capacity');
      const fresh = await snapshot();
      if (fresh.automation.dataRevision !== dataRevision) fail('revision_changed');
      for (const b of bindings) if (!equal(fresh.automation.intakeById?.[b.intakeId], b.entry)
        || !equal(fresh.automation.intakeById?.[b.latestId], b.latestEntry)
        || !equal(registryRow(fresh, b.binding), b.current)) fail('source_changed');
      return output;
    },
  });
}
