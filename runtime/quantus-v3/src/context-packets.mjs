import { createHash } from 'node:crypto';
import { validArtifactReference } from './work-artifact-store.mjs';
import { encodeRuntimePayload, JOURNAL_LIMITS } from './runtime-payload.mjs';
import { HttpError } from './errors.mjs';

export const PACKET_BYTES = 128 * 1024;
export const SNAPSHOT_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxPages: 2000 });
const PREFIX = 'q4packet.';
const SCHEMA = 'quantus-context-snapshot/1';
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const contextFingerprint = items => createHash('sha256').update(JSON.stringify(canonical([...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))).digest('hex');
const fail = reason => { throw new HttpError(409, reason); };
export const isPacketCursor = cursor => typeof cursor === 'string' && cursor.startsWith(PREFIX);
export function packetCursor(manifest, index) {
  return PREFIX + Buffer.from(JSON.stringify({ manifest, index })).toString('base64url');
}
function decode(cursor) {
  let value;
  try { value = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), 'base64url').toString('utf8')); } catch { fail('context_packet_cursor_invalid'); }
  if (!isPacketCursor(cursor) || !value || Object.keys(value).sort().join(',') !== 'index,manifest'
    || !validArtifactReference(value.manifest) || !Number.isSafeInteger(value.index) || value.index < 1
    || packetCursor(value.manifest, value.index) !== cursor) fail('context_packet_cursor_invalid');
  return value;
}
const size = value => Buffer.byteLength(JSON.stringify(value));

function partition(items) {
  const result = [], fresh = () => ({ items: [], fragments: [] });
  let part = fresh();
  function add(key, value) {
    const candidate = { ...part, [key]: [...part[key], value] };
    if (size(candidate) > PACKET_BYTES) { result.push(part); part = fresh(); }
    part[key].push(value);
    if (size(part) > PACKET_BYTES) fail('context_packet_record_too_large');
  }
  for (const item of items) {
    if (size({ items: [item], fragments: [] }) <= PACKET_BYTES) { add('items', item); continue; }
    // Full JSON is split without truncation, including oversized individual
    // fields. Do not split a UTF-16 surrogate pair between fragments.
    const json = JSON.stringify(item), chunks = [];
    for (let start = 0; start < json.length;) {
      let end = Math.min(start + 24000, json.length);
      if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
      chunks.push(json.slice(start, end)); start = end;
    }
    const originalHash = createHash('sha256').update(json).digest('hex');
    chunks.forEach((jsonFragment, fragmentIndex) => add('fragments', {
      originalId: item.id, originalHash, fragmentIndex, fragmentCount: chunks.length, jsonFragment,
    }));
  }
  if (part.items.length || part.fragments.length || !result.length) result.push(part);
  return result;
}

/** Snapshot capture finishes at one C2 revision before any journal/core write.
 * Its immutable parts survive journal-induced revision changes. The opaque
 * cursor selects a part, never a URL, path, tenant or authority.
 */
export function createContextPackets({ artifacts, runKey, tenant, lease, signal }) {
  if (!artifacts?.put || !artifacts?.read || typeof lease !== 'function') throw new TypeError('context_packets_not_configured');
  async function check() { if (signal?.aborted) fail('context_packet_interrupted'); await lease(); if (signal?.aborted) fail('context_packet_interrupted'); }
  async function save(value, limit) {
    await check();
    const encoded = encodeRuntimePayload(value, limit);
    const ref = await artifacts.put({ ...encoded, signal });
    if (!validArtifactReference(ref) || ref.hash !== encoded.hash || ref.bytes !== Buffer.byteLength(encoded.text)
      || await artifacts.read(ref, { signal }) !== encoded.text) fail('context_packet_storage_unconfirmed');
    await check(); return ref;
  }
  async function load(ref) {
    await check(); const text = await artifacts.read(ref, { signal });
    const hash = createHash('sha256').update(text).digest('hex');
    if (!validArtifactReference(ref) || hash !== ref.hash || Buffer.byteLength(text) !== ref.bytes) fail('context_packet_storage_unconfirmed');
    let value; try { value = JSON.parse(text); } catch { fail('context_packet_storage_unconfirmed'); }
    await check(); return value;
  }
  function bound(manifest, query, scopeId) {
    if (manifest?.schema !== SCHEMA || manifest.runKey !== runKey || manifest.tenant !== tenant
      || manifest.query !== query || manifest.scopeId !== scopeId || manifest.complete !== true
      || !Array.isArray(manifest.parts) || !manifest.parts.length || !manifest.parts.every(validArtifactReference)
      || typeof manifest.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.contentHash)
      || !Number.isSafeInteger(manifest.itemCount) || manifest.itemCount < 0
      || !Number.isSafeInteger(manifest.dataRevision) || manifest.dataRevision < 0
      || typeof manifest.sourceMissing !== 'boolean') fail('context_packet_scope_mismatch');
  }
  async function deliver(manifest, reference, index, query, scopeId) {
    bound(manifest, query, scopeId);
    if (index >= manifest.parts.length) fail('context_packet_cursor_invalid');
    const part = await load(manifest.parts[index]);
    if (part.schema !== SCHEMA || part.runKey !== runKey || part.tenant !== tenant || part.index !== index
      || part.contentHash !== manifest.contentHash || !Array.isArray(part.items) || !Array.isArray(part.fragments)) fail('context_packet_part_invalid');
    const hasMore = index + 1 < manifest.parts.length;
    return { confirmed: true, idempotencyKey: null, readComplete: false,
      contextPacket: { schema: SCHEMA, manifest: reference, contentHash: manifest.contentHash,
        itemCount: manifest.itemCount, sourceMissing: manifest.sourceMissing, index, count: manifest.parts.length },
      response: { status: 200, body: { ok: true, query, scopeId, dataRevision: manifest.dataRevision,
        requestId: manifest.requestId, serverNow: manifest.serverNow, items: part.items, fragments: part.fragments,
        count: part.items.length, hasMore, complete: !hasMore, pageStatus: hasMore ? 'more' : 'done',
        cursor: hasMore ? packetCursor(reference, index + 1) : null } } };
  }
  return Object.freeze({
    async capture(read) {
      if (read.readComplete !== true) fail('context_snapshot_incomplete');
      const body = read.response.body;
      if (size(body) <= PACKET_BYTES) return null;
      const contentHash = contextFingerprint(body.items), parts = partition(body.items), refs = [];
      for (let index = 0; index < parts.length; index++) refs.push(await save({ schema: SCHEMA, runKey, tenant, contentHash, index, ...parts[index] }, PACKET_BYTES + 4096));
      const manifest = { schema: SCHEMA, runKey, tenant, query: body.query, scopeId: body.scopeId,
        complete: true, contentHash, itemCount: body.items.length, sourceMissing: body.items.some(i => i.sourceMissing === true),
        dataRevision: body.dataRevision, requestId: body.requestId, serverNow: body.serverNow, readPages: read.readPages, parts: refs };
      const reference = await save(manifest, JOURNAL_LIMITS.responseBytes);
      return deliver(manifest, reference, 0, body.query, body.scopeId);
    },
    async resume({ cursor, query, scopeId, currentRevision }) {
      const { manifest: reference, index } = decode(cursor), manifest = await load(reference);
      if (currentRevision !== undefined && (!Number.isSafeInteger(currentRevision) || currentRevision < manifest.dataRevision))
        fail('context_packet_revision_regressed');
      return deliver(manifest, reference, index, query, scopeId);
    },
  });
}

// Journal receipts originate in the trusted gateway. A final packet alone is
// insufficient: the coverage checker additionally verifies the entire chain.
export function validContextPacket(receipt, expected) {
  const p = receipt?.contextPacket, b = receipt?.response?.body;
  return receipt?.confirmed === true && receipt.response.status === 200 && b?.ok === true
    && p?.schema === SCHEMA && validArtifactReference(p.manifest) && /^[a-f0-9]{64}$/.test(p.contentHash ?? '')
    && Number.isSafeInteger(p.itemCount) && p.itemCount >= 0 && typeof p.sourceMissing === 'boolean'
    && Number.isSafeInteger(p.index) && p.index >= 0 && Number.isSafeInteger(p.count) && p.count > p.index
    && b.query === expected.query && b.scopeId === expected.scopeId && Array.isArray(b.items) && b.count === b.items.length
    && Array.isArray(b.fragments) && Number.isSafeInteger(b.dataRevision) && b.dataRevision >= 0
    && typeof b.requestId === 'string' && b.requestId.length > 0
    && typeof b.serverNow === 'string' && Number.isFinite(Date.parse(b.serverNow))
    && b.hasMore === (p.index + 1 < p.count) && b.complete === (p.index + 1 === p.count)
    && b.pageStatus === (b.hasMore ? 'more' : 'done') && b.cursor === (b.hasMore ? packetCursor(p.manifest, p.index + 1) : null);
}
