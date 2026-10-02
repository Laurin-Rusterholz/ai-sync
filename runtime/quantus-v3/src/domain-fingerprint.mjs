import { createHash } from 'node:crypto';
export const jsonHash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export function domainFingerprint(data) {
  const copy = structuredClone(data);
  // These technical areas have separate authority/ledger checks. Every other
  // field, including original content and source checks, remains bound.
  delete copy.automation.runtime; delete copy.automation.activeLease;
  delete copy.automation.idempotencyByKey; delete copy.automation.dataRevision;
  return jsonHash(copy);
}
