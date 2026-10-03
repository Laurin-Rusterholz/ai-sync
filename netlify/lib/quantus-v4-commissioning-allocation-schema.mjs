import {localDate} from './quantus-v3-runtime-plan.mjs';
/** Immutable, held commissioning allocations in the authoritative cost ledger.
 * A hold is not a provider call or permission to dispatch. It never expires
 * back into spendable budget merely because its approval window has ended.
 */
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=s=>typeof s==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(s)&&!s.includes('__');
const text=s=>typeof s==='string'&&s.trim()===s&&s.length>=1&&s.length<=500;
const ms=n=>Number.isSafeInteger(n)&&n>0&&n<=8640000000000000;
export const ALLOCATION_AUTH_FIELDS=Object.freeze(['schemaVersion','allocationId','bindingHash','month','maxMicros','approvedBy','approvalRef','approvedAtMs','expiresAtMs']);
export function validCommissioningAuthorization(a){
  return record(a)&&Object.keys(a).length===ALLOCATION_AUTH_FIELDS.length&&ALLOCATION_AUTH_FIELDS.every(k=>Object.hasOwn(a,k))
    &&a.schemaVersion===1&&id(a.allocationId)&&typeof a.bindingHash==='string'&&/^[a-f0-9]{64}$/.test(a.bindingHash)
    &&typeof a.month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)&&Number(a.month.slice(0,4))>=2000
    &&Number.isSafeInteger(a.maxMicros)&&a.maxMicros>0&&a.maxMicros<=50_000_000
    &&text(a.approvedBy)&&text(a.approvalRef)&&ms(a.approvedAtMs)&&ms(a.expiresAtMs)&&a.expiresAtMs>a.approvedAtMs;
}
export function sameCommissioningAuthorization(a,b){
  return validCommissioningAuthorization(a)&&validCommissioningAuthorization(b)&&ALLOCATION_AUTH_FIELDS.every(k=>a[k]===b[k]);
}
export function validateCommissioningAllocations(entries){
  if(entries===undefined)return true;
  if(!record(entries)||Object.keys(entries).length>512)return false;
  for(const [key,r]of Object.entries(entries)){
    if(!record(r)||Object.keys(r).length!==6||!['allocationId','state','authorization','reservedAtMs','policyVersion','policyApprovalRef'].every(k=>Object.hasOwn(r,k))
      ||r.allocationId!==key||!id(key)||r.state!=='held'||!validCommissioningAuthorization(r.authorization)||r.authorization.allocationId!==key
      ||!ms(r.reservedAtMs)||r.reservedAtMs<r.authorization.approvedAtMs||r.reservedAtMs>=r.authorization.expiresAtMs
      ||localDate(r.reservedAtMs).slice(0,7)!==r.authorization.month
      ||!text(r.policyVersion)||!text(r.policyApprovalRef))return false;
  }
  return true;
}
export function commissioningHeldMicros(entries,month){
  if(!validateCommissioningAllocations(entries))throw Object.assign(new Error('commissioning_allocation_ledger_invalid'),{code:'commissioning_allocation_ledger_invalid',status:503});
  let total=0;
  for(const r of Object.values(entries||{}))if(r.authorization.month===month){
    total+=r.authorization.maxMicros;
    if(!Number.isSafeInteger(total))throw Object.assign(new Error('commissioning_allocation_total_invalid'),{code:'commissioning_allocation_total_invalid',status:503});
  }
  return total;
}
