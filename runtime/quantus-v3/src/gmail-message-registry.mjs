/** Permanent provider-ID registry. Only compact current references enter the
 * authoritative core; superseded references form an immutable private chain.
 * All external I/O precedes CAS. This module does not advance a mail cursor or
 * mark a message classified/handled: source ingestion and work completion are
 * different facts.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { createGmailOriginalStore } from './gmail-original-store.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = code => { throw new HttpError(409, `gmail_registry_${code}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const idValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const historyValid = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const hashValid = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fields = (v, list) => object(v) && Object.keys(v).sort().join(',') === list.split(',').sort().join(',');

export function createGmailMessageRegistry({ core, clock, artifacts, tenant, account, sourceId,
  runKey, sectionId, verifiedScope, signal } = {}) {
  if (!core?.read || !core?.mutate || !clock?.now || !artifacts?.put || !artifacts?.read
    || parseSlotRunKey(runKey).tenant !== tenant || verifiedScope?.scope !== `${tenant}:mainrun`)
    fail('configuration_invalid');
  const identity = { tenant, account, sourceId }, sourceKey = hash(identity);
  const messageKey = id => { if (!idValid(id)) fail('message_id_invalid'); return hash([account, id]); };
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const runtime = readRuntime(data), run = runtime.runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
    return runtime;
  }
  async function snapshot() { const data = (await core.read())?.data; check(data); return data; }
  const originals = createGmailOriginalStore({ artifacts, tenant, account, sourceId, signal, lease: snapshot });

  function validRecord(row, expectedMessageId = row?.messageId) {
    if (!fields(row, 'messageId,threadId,historyId,contentHash,bytes,reference,version,previous,importedAtMs,partial,gapCount')
      || !idValid(row.messageId) || row.messageId !== expectedMessageId || !idValid(row.threadId) || !historyValid(row.historyId)
      || !hashValid(row.contentHash) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 32 * 1024 * 1024
      || !validArtifactReference(row.reference) || !Number.isSafeInteger(row.version) || row.version < 1
      || (row.version === 1 ? row.previous !== null : !validArtifactReference(row.previous))
      || !Number.isSafeInteger(row.importedAtMs) || row.importedAtMs <= 0
      || typeof row.partial !== 'boolean' || !Number.isSafeInteger(row.gapCount) || row.gapCount < 0
      || row.partial !== (row.gapCount > 0)) fail('record_invalid');
    return row;
  }
  function area(data) {
    const runtime = check(data), root = runtime.gmailRegistry, marker = runtime.gmailRegistryInitialized;
    if (root === undefined && marker === undefined) return null;
    if (marker !== true || !fields(root, 'schema,sources,sourceCount') || root.schema !== 1 || !object(root.sources)
      || root.sourceCount !== Object.keys(root.sources).length) fail('area_invalid');
    for (const [key, source] of Object.entries(root.sources)) {
      if (!hashValid(key) || !fields(source, 'identity,records,count,revision') || !object(source.identity)
        || key !== hash(source.identity) || !object(source.records) || source.count !== Object.keys(source.records).length
        || !Number.isSafeInteger(source.revision) || source.revision < source.count) fail('area_invalid');
    }
    const source = root.sources[sourceKey];
    if (!source) return null;
    if (JSON.stringify(source.identity) !== JSON.stringify(identity)) fail('source_mismatch');
    for (const [key, row] of Object.entries(source.records)) {
      validRecord(row);
      if (key !== messageKey(row.messageId)) fail('record_invalid');
    }
    return source;
  }
  function record(data, messageId) { return area(data)?.records[messageKey(messageId)] ?? null; }
  function validateRead(value, row = null) {
    const mail = value.original;
    if (!historyValid(mail.historyId) || mail.historyId !== mail.original?.historyId
      || !idValid(mail.threadId) || mail.threadId !== mail.original?.threadId
      || !Array.isArray(mail.gaps) || typeof mail.partial !== 'boolean' || mail.partial !== (mail.gaps.length > 0)) fail('source_invalid');
    if (row && (value.contentHash !== row.contentHash || value.bytes !== row.bytes
      || mail.id !== row.messageId || mail.historyId !== row.historyId || mail.threadId !== row.threadId
      || mail.partial !== row.partial || mail.gaps.length !== row.gapCount)) fail('source_mismatch');
    return mail;
  }
  async function readOriginal(row) {
    const value = await originals.read({ messageId: row.messageId, reference: row.reference });
    validateRead(value, row);
    return value;
  }
  async function archive(row) {
    const text = JSON.stringify({ schema: 'quantus-gmail-registry-version/1', identity, record: row }), digest = hash(text);
    await snapshot();
    const ref = await artifacts.put({ text, hash: digest, signal });
    await snapshot();
    if (!validArtifactReference(ref) || ref.hash !== digest || ref.bytes !== Buffer.byteLength(text)
      || await artifacts.read(ref, { signal }) !== text) fail('archive_unconfirmed');
    await snapshot();
    return ref;
  }
  async function verifyCurrent(messageId, expected) {
    const current = record(await snapshot(), messageId);
    if (JSON.stringify(current) !== JSON.stringify(expected)) fail('readback_mismatch');
    const original = await readOriginal(current);
    if (JSON.stringify(record(await snapshot(), messageId)) !== JSON.stringify(expected)) fail('changed_during_readback');
    return { record: structuredClone(current), original: original.original, confirmed: true };
  }
  return Object.freeze({
    sourceKey,
    async read({ messageId }) {
      const row = record(await snapshot(), messageId);
      if (!row) return null;
      return verifyCurrent(messageId, row);
    },
    async readPrevious({ messageId }) {
      const current = record(await snapshot(), messageId);
      if (!current || current.previous === null) return null;
      const reference = current.previous;
      if (!validArtifactReference(reference)) fail('archive_invalid');
      await snapshot();
      const text = await artifacts.read(reference, { signal });
      await snapshot();
      if (typeof text !== 'string' || hash(text) !== reference.hash || Buffer.byteLength(text) !== reference.bytes) fail('archive_invalid');
      let value;
      try { value = JSON.parse(text); } catch { fail('archive_invalid'); }
      if (!fields(value, 'schema,identity,record') || value.schema !== 'quantus-gmail-registry-version/1'
        || JSON.stringify(value.identity) !== JSON.stringify(identity)) fail('archive_invalid');
      validRecord(value.record, messageId);
      if (value.record.version !== current.version - 1 || BigInt(value.record.historyId) >= BigInt(current.historyId)) fail('archive_invalid');
      const original = await readOriginal(value.record);
      if (JSON.stringify(record(await snapshot(), messageId)) !== JSON.stringify(current)) fail('changed_during_readback');
      return { record: value.record, original: original.original, confirmed: true };
    },
    async register({ messageId, text }) {
      const key = messageKey(messageId), initial = await snapshot(), before = record(initial, messageId);
      // Every accepted source version has an independently read original.
      // Uploads can be retried safely; they never run inside the CAS callback.
      const stored = await originals.put({ messageId, text });
      const verified = await originals.read({ messageId, reference: stored.reference });
      const mail = validateRead(verified);
      if (before?.contentHash === stored.contentHash) return verifyCurrent(messageId, before);
      if (before && BigInt(mail.historyId) <= BigInt(before.historyId)) fail('history_not_newer');
      if (before) await readOriginal(before);
      const previous = before ? await archive(before) : null;
      const importedAtMs = clock.now();
      const row = validRecord({ messageId, threadId: mail.threadId, historyId: mail.historyId,
        contentHash: stored.contentHash, bytes: stored.bytes, reference: stored.reference,
        version: (before?.version || 0) + 1, previous, importedAtMs, partial: mail.partial, gapCount: mail.gaps.length });
      const commandKey = 'v4-gmail-register-' + hash([identity, messageId, before, row]);
      await snapshot();
      const result = await core.mutate({ commandKey, requestId: commandKey, now: importedAtMs, mutate(data) {
        const runtime = check(data), actual = record(data, messageId);
        if (JSON.stringify(actual) !== JSON.stringify(before)) fail('concurrent_message_change');
        if (!runtime.gmailRegistry) {
          runtime.gmailRegistry = { schema: 1, sources: {}, sourceCount: 0 };
          runtime.gmailRegistryInitialized = true;
        }
        const root = runtime.gmailRegistry;
        if (!root.sources[sourceKey]) {
          root.sources[sourceKey] = { identity, records: {}, count: 0, revision: 0 };
          root.sourceCount++;
        }
        const source = root.sources[sourceKey];
        if (source.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
        source.records[key] = structuredClone(row);
        if (!before) source.count++;
        source.revision++;
        assertActiveRuntimeCapacity(data);
        return { data, result: { contentHash: row.contentHash, version: row.version } };
      } });
      if (result.result?.contentHash !== row.contentHash || result.result?.version !== row.version) fail('receipt_invalid');
      return verifyCurrent(messageId, row);
    },
  });
}
