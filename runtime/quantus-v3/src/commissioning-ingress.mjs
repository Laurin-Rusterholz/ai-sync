/** Authenticated source-side commissioning ingress. This factory is not wired
 * into the production server. It confers no runtime activation permission:
 * execution still needs the source broker, real source lease and cost adapter.
 * Request identities and request profiles come from reviewed server config.
 */
import {createHash} from 'node:crypto';
import {commissioningSourceIdentity} from './commissioning-source.mjs';
import {createRouter} from './http.mjs';
import {HttpError} from './errors.mjs';
import {readRuntime} from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import {parseSlotRunKey,localDate} from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
const PATH='/v4/commissioning/respond';
const capabilities=new WeakMap();
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(v)&&!v.includes('__');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(status,code)=>{throw new HttpError(status,code);};
const fields=['schemaVersion','audience','serviceAccount','sourceProjectId','sourceTenant','shadowProjectId','shadowTenant','bindingHash','allocationId','model','profiles','allowedRuns','maxStepIndex'];
const project=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
export const commissioningProfileHash=profile=>hash([profile.instructions,profile.tools]);

function authoritySnapshot(authority,sourceIdentity,profiles,transport){
  if(!record(authority)||Object.keys(authority).length!==fields.length||!fields.every(k=>Object.hasOwn(authority,k))
    ||authority.schemaVersion!==1||!project(authority.sourceProjectId)||!project(authority.shadowProjectId)
    ||authority.sourceProjectId===authority.shadowProjectId||!id(authority.sourceTenant)||!id(authority.shadowTenant)
    ||authority.sourceTenant===authority.shadowTenant||!digest(authority.bindingHash)||!id(authority.allocationId)
    ||typeof authority.audience!=='string'||!/^https:\/\/[a-z0-9.-]+(?::\d+)?\/v4\/commissioning\/respond$/.test(authority.audience)
    ||typeof authority.serviceAccount!=='string'||!new RegExp('^[a-z][a-z0-9-]*@'+authority.shadowProjectId+'\\.iam\\.gserviceaccount\\.com$').test(authority.serviceAccount)
    ||!Number.isSafeInteger(authority.maxStepIndex)||authority.maxStepIndex<0||authority.maxStepIndex>4095
    ||!Array.isArray(authority.allowedRuns)||!authority.allowedRuns.length||authority.allowedRuns.length>124
    ||new Set(authority.allowedRuns).size!==authority.allowedRuns.length
    ||!record(authority.profiles)||!Object.keys(authority.profiles).length||Object.keys(authority.profiles).length>32
    ||sourceIdentity?.projectId!==authority.sourceProjectId||sourceIdentity?.tenant!==authority.sourceTenant
    ||transport?.provider!=='openai'||transport.model!==authority.model||typeof transport.prepare!=='function'
    ||typeof authority.model!=='string'||!authority.model.trim()) fail(503,'commissioning_authority_invalid');
  try{for(const run of authority.allowedRuns)if(parseSlotRunKey(run).tenant!==authority.shadowTenant)throw Error();}
  catch{fail(503,'commissioning_authority_invalid');}
  for(const [section,expected]of Object.entries(authority.profiles)){
    const profile=profiles?.[section];
    if(!id(section)||!digest(expected)||!record(profile)||typeof profile.instructions!=='string'||!profile.instructions.trim()
      ||!Array.isArray(profile.tools)||commissioningProfileHash(profile)!==expected)fail(503,'commissioning_profile_mismatch');
  }
  return freeze(structuredClone(authority));
}

/** An executor must recheck this capability with fresh source data and time
 * before cost reservation/claim; a serialized or caller-made object cannot
 * become a capability. Source lease verification remains the cost adapter's
 * responsibility. The capability is not a provider dispatch receipt. */
export function assertCommissioningOperation(operation,{data,now,core}){
  const cap=capabilities.get(operation);
  if(!cap||!Number.isSafeInteger(now)||now<=0)fail(403,'commissioning_capability_invalid');
  const {authority,principal}=cap;
  const sourceIdentity=commissioningSourceIdentity(core);
  if(sourceIdentity?.projectId!==authority.sourceProjectId||sourceIdentity?.tenant!==authority.sourceTenant)fail(503,'commissioning_source_mismatch');
  if(now>=principal.expiresAtMs)fail(401,'unauthenticated');
  const cost=readRuntime(data).cost;
  const auth=cost.commissioningAllocationsById?.[authority.allocationId]?.authorization;
  if(!auth||auth.bindingHash!==authority.bindingHash)fail(409,'commissioning_allocation_mismatch');
  if(now<auth.approvedAtMs||now>=auth.expiresAtMs)fail(409,'commissioning_authorization_expired');
  if(localDate(now).slice(0,7)!==auth.month)fail(409,'commissioning_month_mismatch');
  const known=cost.callsById[operation.callId];
  if(operation.recoveryOnly===true&&!known?.dispatch?.claimed)fail(409,'commissioning_recovery_missing');
  if(known&&(known.contentHash!==operation.prepared.contentHash
    ||known.runKey!==operation.runKey||known.provider!==operation.provider||known.model!==operation.model
    ||known.contract.inputTokens!==operation.prepared.inputTokens||known.contract.outputTokens!==operation.prepared.outputTokens
    ||known.commissioning?.allocationId!==operation.commissioning.allocationId
    ||known.commissioning?.bindingHash!==operation.commissioning.bindingHash
    ||known.commissioning?.operationId!==operation.commissioning.operationId))fail(409,'commissioning_operation_conflict');
  return true;
}

/** Recording an already claimed outcome is not new spending. The original
 * in-process admission and an exact existing call are mandatory even after
 * token/allocation expiry; the journal separately requires current source
 * leadership. Recovery admission additionally requires a fresh principal. */
export function assertCommissioningReceipt(operation,{data,now,core,freshPrincipal=false}) {
  const cap=capabilities.get(operation), identity=commissioningSourceIdentity(core);
  if(!cap||!Number.isSafeInteger(now)||now<=0)fail(403,'commissioning_capability_invalid');
  if(identity?.projectId!==cap.authority.sourceProjectId||identity?.tenant!==cap.authority.sourceTenant)fail(503,'commissioning_source_mismatch');
  if(freshPrincipal&&now>=cap.principal.expiresAtMs)fail(401,'unauthenticated');
  const call=readRuntime(data).cost.callsById[operation.callId];
  if(!call||!call.dispatch.claimed||!['reserved','unknown','settled'].includes(call.state)
    ||call.contentHash!==operation.prepared.contentHash||call.runKey!==operation.runKey
    ||call.provider!==operation.provider||call.model!==operation.model
    ||call.contract.inputTokens!==operation.prepared.inputTokens||call.contract.outputTokens!==operation.prepared.outputTokens
    ||call.commissioning?.allocationId!==operation.commissioning.allocationId
    ||call.commissioning?.bindingHash!==operation.commissioning.bindingHash
    ||call.commissioning?.operationId!==operation.commissioning.operationId)fail(409,'commissioning_receipt_binding_invalid');
  return call;
}

export function assertCommissioningTransport(operation,transport){
  if(!capabilities.has(operation)||capabilities.get(operation).transport!==transport)fail(403,'commissioning_transport_mismatch');
}

export function createCommissioningIngress({authority,profiles,transport,ports,execute,logger=null}){
  const core=ports.require('core');
  const sourceIdentity=commissioningSourceIdentity(core);
  const approved=authoritySnapshot(authority,sourceIdentity,profiles,transport);
  const templates=freeze(structuredClone(profiles));
  // Capture the reviewed implementation now; changing a caller-owned transport
  // object later cannot swap the model preparation behind this approval.
  const prepare=transport.prepare.bind(transport);
  return createRouter({config:{maxRequestBytes:512*1024,endpoints:{'commissioning.respond':{
    audience:approved.audience,allowedServiceAccounts:[approved.serviceAccount]}}},ports,logger,
    routes:[{method:'POST',path:PATH,endpointKey:'commissioning.respond',handler:async ctx=>{
      const body=ctx.body;
      if(![4,5].includes(Object.keys(body).length)||!['runKey','sectionId','stepIndex','inputJson'].every(k=>Object.hasOwn(body,k))
        ||Object.keys(body).some(k=>!['runKey','sectionId','stepIndex','inputJson','recoveryOnly'].includes(k))
        ||(Object.hasOwn(body,'recoveryOnly')&&body.recoveryOnly!==true)
        ||typeof body.runKey!=='string'||typeof body.sectionId!=='string'
        ||!approved.allowedRuns.includes(body.runKey)||!Object.hasOwn(approved.profiles,body.sectionId)
        ||!Number.isSafeInteger(body.stepIndex)||body.stepIndex<0||body.stepIndex>approved.maxStepIndex
        ||typeof body.inputJson!=='string'||Buffer.byteLength(body.inputJson)>256*1024)fail(400,'commissioning_request_invalid');
      let input;try{input=JSON.parse(body.inputJson);}catch{fail(400,'commissioning_input_invalid');}
      const template=templates[body.sectionId];
      let prepared;try{prepared=prepare({instructions:template.instructions,tools:template.tools,input});}
      catch{fail(400,'commissioning_input_invalid');}
      // Do not derive identity from requestId, request bytes, caller-generated
      // job ids or restart counters. Changed content keeps the same identity.
      const operationId=hash([approved.allocationId,approved.bindingHash,body.runKey,body.sectionId,body.stepIndex]);
      const operation=Object.freeze({callId:'commission-'+operationId,runKey:body.runKey,sectionId:body.sectionId,
        stepIndex:body.stepIndex,recoveryOnly:body.recoveryOnly===true,model:approved.model,provider:'openai',prepared,
        commissioning:freeze({allocationId:approved.allocationId,bindingHash:approved.bindingHash,operationId})});
      capabilities.set(operation,{authority:approved,principal:ctx.principal,transport});
      const snapshot=await core.read();
      const checkedAt=ports.require('clock').now();
      try { assertCommissioningOperation(operation,{data:snapshot?.data,now:checkedAt,core}); }
      catch(error) {
        if(!['commissioning_authorization_expired','commissioning_month_mismatch'].includes(error.error))throw error;
        if(!readRuntime(snapshot.data).cost.callsById[operation.callId]?.dispatch.claimed)throw error;
        assertCommissioningReceipt(operation,{data:snapshot?.data,now:checkedAt,core,freshPrincipal:true});
      }
      if(typeof execute!=='function')fail(503,'commissioning_executor_unavailable');
      // Executor returns persisted results only. It must not treat admission as
      // a cost claim or export this local capability to the isolated database.
      return {status:200,body:await execute({operation,requestId:ctx.requestId,principal:ctx.principal})};
    }}]});
}
