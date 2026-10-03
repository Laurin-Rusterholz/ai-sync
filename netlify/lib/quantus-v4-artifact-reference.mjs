/** Pure schema shared by the source cost ledger and private artifact storage. */
export const MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
export const ARTIFACT_SCHEMA = 'quantus-work-artifact/1';
export function validArtifactReference(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === 'bucket,bytes,generation,hash,objectName,schema'
    && v.schema === ARTIFACT_SCHEMA && typeof v.bucket === 'string' && typeof v.objectName === 'string'
    && typeof v.hash === 'string' && /^[a-f0-9]{64}$/.test(v.hash)
    && typeof v.generation === 'string' && /^[1-9][0-9]{0,30}$/.test(v.generation)
    && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= MAX_ARTIFACT_BYTES;
}

