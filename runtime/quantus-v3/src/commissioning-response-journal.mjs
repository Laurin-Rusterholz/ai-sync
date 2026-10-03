/** Immutable provider responses attached to their source cost call, never to
 * a productive run's conversation. Uses the existing private artifact store,
 * payload validation, source CAS and cost receipt reconciliation. */
import {createHash} from 'node:crypto';
import {HttpError} from './errors.mjs';
import {assertLeadership,readRuntime,settleCost,resolveUnknownCost} from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import {assertCommissioningReceipt,assertCommissioningOperation} from './commissioning-ingress.mjs';
import {commissioningSourceIdentity} from './commissioning-source.mjs';
import {JOURNAL_LIMITS,encodeRuntimePayload,assertActiveRuntimeCapacity} from './runtime-payload.mjs';
import {validArtifactReference} from './work-artifact-store.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const fail=(code,status=409)=>{throw new HttpError(status,code);};
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function confirmSettled(call,response){
  if(call.state==='settled'&&(response.outcome!=='settled'||call.settledMicros!==response.actualMicros
    ||call.usageReceiptId!==response.usageReceiptId||(response.providerRequestId&&call.providerRequestId!==response.providerRequestId)))fail('commissioning_response_cost_conflict');
}
function responseShape(response){
  if(!record(response)||!['settled','unknown'].includes(response.outcome))fail('commissioning_response_invalid',400);
  if(response.outcome==='settled'&&(!Number.isSafeInteger(response.actualMicros)||response.actualMicros<0
    ||typeof response.usageReceiptId!=='string'||!response.usageReceiptId))fail('commissioning_response_invalid',400);
  if(response.providerRequestId!==undefined&&response.providerRequestId!==null&&typeof response.providerRequestId!=='string')fail('commissioning_response_invalid',400);
}
export function createCommissioningResponseJournal({operation,core,clock,verifiedScope,artifacts,artifactBucket,signal}){
  const identity=commissioningSourceIdentity(core);
  if(!identity||!core?.mutate||!clock?.now||!artifacts?.put||!artifacts?.read
    ||verifiedScope?.scope!==identity.tenant+':mainrun'||typeof artifactBucket!=='string'||!artifactBucket)fail('commissioning_journal_configuration_invalid',503);
  const scope=Object.freeze({...verifiedScope});
  function authority(data,pending=false){
    if(signal?.aborted)fail('commissioning_journal_interrupted');
    const now=clock.now();assertLeadership(data,scope,now);
    if(pending){
      assertCommissioningOperation(operation,{data,now,core});
      const call=readRuntime(data).cost.callsById[operation.callId];
      if(!call||call.state!=='reserved'||call.dispatch.claimed)fail('commissioning_preflight_state_invalid');
      return call;
    }
    return assertCommissioningReceipt(operation,{data,now,core});
  }
  async function snapshot(pending=false){const data=(await core.read())?.data;const call=authority(data,pending);return {data,call};}
  function reference(ref){
    if(!validArtifactReference(ref)||ref.bucket!==artifactBucket
      ||ref.objectName!==`quantus-v4/${identity.tenant}/work/${ref.hash}.json`)fail('commissioning_artifact_binding_invalid',503);
  }
  async function load(pointer){
    reference(pointer.artifact);
    const text=await artifacts.read(pointer.artifact,{signal});
    if(typeof text!=='string'||Buffer.byteLength(text)!==pointer.artifact.bytes||hash(text)!==pointer.artifact.hash)fail('commissioning_response_readback_failed',502);
    let response;try{response=JSON.parse(text);}catch{fail('commissioning_response_readback_failed',502);}
    responseShape(response);return response;
  }
  async function read(){
    const pointer=(await snapshot()).call.commissioningResponse;
    if(!pointer)return null;
    const response=await load(pointer);
    const current=(await snapshot()).call;
    if(JSON.stringify(current.commissioningResponse)!==JSON.stringify(pointer))fail('commissioning_response_changed');
    confirmSettled(current,response);
    return response;
  }
  return Object.freeze({read,
    async prepare(){
      await snapshot(true);
      const manifest={schemaVersion:1,callId:operation.callId,requestHash:operation.prepared.contentHash,
        runKey:operation.runKey,provider:operation.provider,model:operation.model,
        inputTokens:operation.prepared.inputTokens,outputTokens:operation.prepared.outputTokens,
        commissioning:operation.commissioning};
      const encoded=encodeRuntimePayload(manifest,JOURNAL_LIMITS.requestBytes);
      const artifact=await artifacts.put({...encoded,signal});reference(artifact);
      if(artifact.hash!==encoded.hash||artifact.bytes!==Buffer.byteLength(encoded.text)
        ||await artifacts.read(artifact,{signal})!==encoded.text)fail('commissioning_preflight_readback_failed',502);
      await snapshot(true);
      return artifact;
    },
    async record(response){
      responseShape(response);
      const encoded=encodeRuntimePayload(response,JOURNAL_LIMITS.responseBytes);
      const before=await snapshot(),previous=before.call.commissioningResponse;
      confirmSettled(before.call,response);
      if(previous){if(previous.artifact.hash!==encoded.hash)fail('commissioning_response_conflict');return read();}
      const artifact=await artifacts.put({...encoded,signal});reference(artifact);
      if(artifact.hash!==encoded.hash||artifact.bytes!==Buffer.byteLength(encoded.text)
        ||await artifacts.read(artifact,{signal})!==encoded.text)fail('commissioning_response_readback_failed',502);
      await snapshot();
      const commandKey='commission-response-'+hash(JSON.stringify([operation.callId,operation.prepared.contentHash,encoded.hash]));
      const outcome=await core.mutate({commandKey,requestId:commandKey,now:clock.now(),mutate(data){
        const call=authority(data),existing=call.commissioningResponse;
        confirmSettled(call,response);
        if(existing&&existing.artifact.hash!==encoded.hash)fail('commissioning_response_conflict');
        if(!existing){call.commissioningResponseRecorded=true;call.commissioningResponse={schemaVersion:1,requestHash:operation.prepared.contentHash,artifact:structuredClone(artifact),recordedAtMs:clock.now()};}
        assertActiveRuntimeCapacity(data);
        return {data,result:{callId:operation.callId,hash:encoded.hash}};
      }});
      if(outcome?.result?.hash!==encoded.hash)fail('commissioning_response_receipt_invalid',502);
      const result=await read();
      if(!result||encodeRuntimePayload(result,JOURNAL_LIMITS.responseBytes).hash!==encoded.hash)fail('commissioning_response_readback_failed',502);
      return result;
    },
    async settle(){
      const before=await snapshot(),pointer=before.call.commissioningResponse;
      if(!pointer)fail('commissioning_response_missing');
      const response=await load(pointer);
      if(response.outcome!=='settled')fail('commissioning_usage_unconfirmed');
      const commandKey='commission-settle-'+hash(JSON.stringify([operation.callId,pointer.artifact.hash]));
      const out=await core.mutate({commandKey,requestId:commandKey,now:clock.now(),mutate(data){
        const call=authority(data);
        if(JSON.stringify(call.commissioningResponse)!==JSON.stringify(pointer))fail('commissioning_response_changed');
        const input={callId:operation.callId,actualMicros:response.actualMicros,usageReceiptId:response.usageReceiptId,
          providerRequestId:response.providerRequestId??null,now:clock.now(),verifiedScope:scope};
        const result=call.state==='unknown'?resolveUnknownCost(data,{...input,resolution:'charged',evidence:{kind:'persisted_provider_receipt',ref:response.usageReceiptId}}):settleCost(data,input);
        if(!result.result?.ok)fail('commissioning_settlement_rejected');return result;
      }});
      if(!out?.result?.ok)fail('commissioning_settlement_rejected');
      const current=(await snapshot()).call;
      if(current.state!=='settled'||current.settledMicros!==response.actualMicros||current.usageReceiptId!==response.usageReceiptId
        ||(response.providerRequestId&&current.providerRequestId!==response.providerRequestId))fail('commissioning_settlement_readback_failed',502);
      return {settled:true,overrunMicros:current.overrunMicros};
    }
  });
}
