/** Immutable, private Cloud Storage payloads. Only hash-bound references enter
 * the core. No caller-selected URL, bucket, tenant, download token or public ACL.
 * Upload uses ifGenerationMatch=0; reads are pinned to the verified generation.
 * https://docs.cloud.google.com/storage/docs/request-preconditions
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { WORK_PAYLOAD_BYTES } from './leadership-journal.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (code, status = 502) => { throw new HttpError(status, code); };
export const ARTIFACT_SCHEMA = 'quantus-work-artifact/1';
export function validArtifactReference(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === 'bucket,bytes,generation,hash,objectName,schema'
    && v.schema === ARTIFACT_SCHEMA && typeof v.bucket === 'string' && typeof v.objectName === 'string'
    && typeof v.hash === 'string' && /^[a-f0-9]{64}$/.test(v.hash)
    && typeof v.generation === 'string' && /^[1-9][0-9]{0,30}$/.test(v.generation)
    && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= WORK_PAYLOAD_BYTES;
}

export function createWorkArtifactStore({ bucket, tenant, getAccessToken, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(bucket)
    || bucket.split('.').some(p => p.length > 63) || /\.\.|\.\-|\-\./.test(bucket)
    || typeof tenant !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tenant) || typeof getAccessToken !== 'function'
    || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000)
    throw new TypeError('artifact_store_configuration_invalid');
  const name = digest => `quantus-v4/${tenant}/work/${digest}.json`;
  const objectUrl = digest => `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name(digest))}`;
  async function request(url, { method = 'GET', body, signal, maxBytes = 65536 } = {}) {
    const controller = new AbortController();
    let rejectAbort, reader;
    const stopped = new Promise((_, reject) => { rejectAbort = reject; });
    function abort() { controller.abort(); rejectAbort(new HttpError(504, 'artifact_request_interrupted')); }
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await Promise.race([stopped, (async () => {
        const token = await getAccessToken();
        if (controller.signal.aborted) fail('artifact_request_interrupted', 504);
        if (typeof token !== 'string' || !token) fail('artifact_credentials_missing', 503);
        const response = await fetchImpl(url, { method, body, redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }) } });
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail('artifact_response_too_large', 413);
        const chunks = []; let bytes = 0;
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maxBytes) fail('artifact_response_too_large', 413);
            chunks.push(Buffer.from(part.value));
          }
        }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { fail('artifact_encoding_invalid'); }
        return { status: response.status, text };
      })()]);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      fail('artifact_request_failed');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
    }
  }
  function checkRef(ref) {
    if (!validArtifactReference(ref) || ref.bucket !== bucket || ref.objectName !== name(ref.hash)) fail('artifact_reference_invalid', 409);
  }
  async function requirePrivateBucket(signal) {
    const response = await request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}?fields=iamConfiguration`, { signal });
    if (response.status !== 200) fail('artifact_bucket_unverified', 503);
    let value;
    try { value = JSON.parse(response.text); } catch { fail('artifact_bucket_unverified', 503); }
    if (value?.iamConfiguration?.publicAccessPrevention !== 'enforced'
      || value?.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) fail('artifact_bucket_not_private', 503);
  }
  async function read(ref, { signal } = {}) {
    checkRef(ref);
    await requirePrivateBucket(signal);
    const response = await request(`${objectUrl(ref.hash)}?alt=media&generation=${encodeURIComponent(ref.generation)}`, { signal, maxBytes: WORK_PAYLOAD_BYTES });
    if (response.status !== 200) fail('artifact_read_failed');
    if (Buffer.byteLength(response.text) !== ref.bytes || hash(response.text) !== ref.hash) fail('artifact_hash_mismatch');
    return response.text;
  }
  return Object.freeze({
    async put({ text, hash: digest, signal }) {
      if (typeof text !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || hash(text) !== digest
        || Buffer.byteLength(text) < 1 || Buffer.byteLength(text) > WORK_PAYLOAD_BYTES) fail('artifact_payload_invalid', 400);
      await requirePrivateBucket(signal);
      const query = new URLSearchParams({ uploadType: 'media', name: name(digest), ifGenerationMatch: '0' });
      const upload = await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`, { method: 'POST', body: text, signal });
      if (![200, 201, 412].includes(upload.status)) fail('artifact_upload_failed');
      const metadata = await request(`${objectUrl(digest)}?fields=bucket,name,generation,size`, { signal });
      if (metadata.status !== 200) fail('artifact_metadata_failed');
      let value;
      try { value = JSON.parse(metadata.text); } catch { fail('artifact_metadata_invalid'); }
      const ref = { schema: ARTIFACT_SCHEMA, bucket: value.bucket, objectName: value.name, generation: value.generation,
        hash: digest, bytes: typeof value.size === 'string' && /^[0-9]+$/.test(value.size) ? Number(value.size) : null };
      checkRef(ref);
      if (ref.bytes !== Buffer.byteLength(text)) fail('artifact_metadata_invalid');
      if (await read(ref, { signal }) !== text) fail('artifact_hash_mismatch');
      return Object.freeze(ref);
    },
    read,
  });
}
