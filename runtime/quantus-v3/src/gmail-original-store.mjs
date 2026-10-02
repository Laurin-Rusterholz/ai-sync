/** Immutable source originals outside the core. A single mail can exceed the
 * artifact store's object limit: a manifest binds every byte-sized part, the
 * mailbox, source and provider Message-ID. Callers must authorize that source
 * before reading and commit a cursor only after this independent readback.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';

export const GMAIL_ORIGINAL_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, partBytes: 256 * 1024, parts: 128 });
const digest = v => createHash('sha256').update(v).digest('hex');
const fail = code => { throw new HttpError(409, `gmail_original_${code}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => object(v) && Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
const messageIdValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const hashValid = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function createGmailOriginalStore({ artifacts, tenant, account, sourceId, lease, signal } = {}) {
  if (!artifacts?.put || !artifacts?.read || typeof lease !== 'function'
    || typeof tenant !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)
    || typeof sourceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(sourceId)
    || typeof account !== 'string' || account !== account.trim().toLowerCase() || account.length > 254
    || !/^[^\s/@?#]+@[^\s/@?#]+\.[^\s/@?#]+$/.test(account)) fail('configuration_invalid');
  const scopeFor = messageId => {
    if (!messageIdValid(messageId)) fail('message_identity_invalid');
    return { tenant, account, sourceId, messageId };
  };
  async function active() {
    if (signal?.aborted) fail('interrupted');
    await lease();
    if (signal?.aborted) fail('interrupted');
  }
  async function readArtifact(ref) {
    if (!validArtifactReference(ref)) fail('reference_invalid');
    await active();
    const text = await artifacts.read(ref, { signal });
    await active();
    // Do not delegate proof solely to an acknowledgement or store adapter.
    if (typeof text !== 'string' || Buffer.byteLength(text) !== ref.bytes || digest(text) !== ref.hash) fail('artifact_mismatch');
    return text;
  }
  async function putArtifact(value) {
    const text = JSON.stringify(value), hash = digest(text);
    await active();
    const ref = await artifacts.put({ text, hash, signal });
    await active();
    if (!validArtifactReference(ref) || ref.hash !== hash || ref.bytes !== Buffer.byteLength(text)
      || await readArtifact(ref) !== text) fail('write_unconfirmed');
    return ref;
  }
  function parse(text) {
    try { return JSON.parse(text); } catch { fail('json_invalid'); }
  }
  function validateOriginal(text, messageId) {
    const v = parse(text);
    if (!object(v) || v.missing !== false || v.account !== account || v.id !== messageId
      || v.original?.id !== messageId) fail('source_identity_mismatch');
    return v;
  }
  async function read({ messageId, reference }) {
    const scope = scopeFor(messageId), scopeHash = digest(JSON.stringify(scope));
    const manifest = parse(await readArtifact(reference));
    if (!keys(manifest, 'schema,scope,contentHash,bytes,parts') || manifest.schema !== 'quantus-gmail-original/1'
      || JSON.stringify(manifest.scope) !== JSON.stringify(scope) || !hashValid(manifest.contentHash)
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > GMAIL_ORIGINAL_LIMITS.bytes
      || !Array.isArray(manifest.parts) || manifest.parts.length !== Math.ceil(manifest.bytes / GMAIL_ORIGINAL_LIMITS.partBytes)
      || manifest.parts.length > GMAIL_ORIGINAL_LIMITS.parts) fail('manifest_invalid');
    const chunks = [];
    for (let index = 0; index < manifest.parts.length; index++) {
      const part = parse(await readArtifact(manifest.parts[index]));
      if (!keys(part, 'schema,scopeHash,contentHash,index,count,data') || part.schema !== 'quantus-gmail-original-part/1'
        || part.scopeHash !== scopeHash || part.contentHash !== manifest.contentHash
        || part.index !== index || part.count !== manifest.parts.length
        || typeof part.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part.data)) fail('part_invalid');
      const bytes = Buffer.from(part.data, 'base64url');
      const expected = Math.min(GMAIL_ORIGINAL_LIMITS.partBytes, manifest.bytes - index * GMAIL_ORIGINAL_LIMITS.partBytes);
      if (bytes.toString('base64url') !== part.data || bytes.length !== expected) fail('part_invalid');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.contentHash) fail('content_mismatch');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('encoding_invalid'); }
    const original = validateOriginal(text, messageId);
    await active();
    return { text, original, contentHash: manifest.contentHash, bytes: manifest.bytes };
  }
  return Object.freeze({
    read,
    async put({ messageId, text }) {
      const scope = scopeFor(messageId), scopeHash = digest(JSON.stringify(scope));
      if (typeof text !== 'string' || Buffer.byteLength(text) < 1 || Buffer.byteLength(text) > GMAIL_ORIGINAL_LIMITS.bytes) fail('size_invalid');
      if (Buffer.from(text).toString('utf8') !== text) fail('encoding_invalid');
      validateOriginal(text, messageId);
      const bytes = Buffer.from(text), contentHash = digest(bytes), count = Math.ceil(bytes.length / GMAIL_ORIGINAL_LIMITS.partBytes);
      const parts = [];
      for (let index = 0; index < count; index++) {
        parts.push(await putArtifact({ schema: 'quantus-gmail-original-part/1', scopeHash, contentHash, index, count,
          data: bytes.subarray(index * GMAIL_ORIGINAL_LIMITS.partBytes, (index + 1) * GMAIL_ORIGINAL_LIMITS.partBytes).toString('base64url') }));
      }
      const reference = await putArtifact({ schema: 'quantus-gmail-original/1', scope, contentHash, bytes: bytes.length, parts });
      const verified = await read({ messageId, reference });
      if (verified.text !== text) fail('write_unconfirmed');
      return { reference, contentHash, bytes: bytes.length };
    },
  });
}
