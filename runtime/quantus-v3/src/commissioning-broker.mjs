/** Source-side provider coordinator. Acquires real source leadership and
 * persists response evidence before settlement/acknowledgement. Admission is
 * opaque and checked again here; no caller-supplied lease or live gates. */
import {randomUUID} from 'node:crypto';
import {HttpError} from './errors.mjs';
import {acquireLease,releaseLease,assertLeadership,readRuntime,markCostOutcomeUnknown} from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import {assertCommissioningOperation,assertCommissioningReceipt,assertCommissioningTransport} from './commissioning-ingress.mjs';
import {commissioningSourceIdentity} from './commissioning-source.mjs';
import {createCommissioningCostAdapter} from './cost-adapter.mjs';
import {createCommissioningResponseJournal} from './commissioning-response-journal.mjs';
const fail=(code,status=409)=>{throw new HttpError(status,code);};

export function createCommissioningBroker({ports,transport,artifacts,artifactBucket,__allowFixturePolicy=false}){
  const core=ports.require('core'),clock=ports.require('clock'),identity=commissioningSourceIdentity(core);
  if(!identity||transport?.provider!=='openai'||typeof transport.dispatch!=='function'||!transport.modelPricing
    ||!artifacts?.put||!artifacts?.read||typeof artifactBucket!=='string'||!artifactBucket)fail('commissioning_broker_not_configured',503);
  const dispatch=transport.dispatch.bind(transport),pricing=Object.freeze({...transport.modelPricing});
  const config=Object.freeze({mode:'commissioning'});
  async function data(){const snapshot=await core.read();readRuntime(snapshot?.data);return snapshot.data;}
  function admission(operation,current){
    const now=clock.now();
    try{assertCommissioningOperation(operation,{data:current,now,core});}
    catch(error){
      if(!['commissioning_authorization_expired','commissioning_month_mismatch'].includes(error.error))throw error;
      assertCommissioningReceipt(operation,{data:current,now,core,freshPrincipal:true});
    }
  }
  async function release(scope,holder){
    try{
      await core.mutate({commandKey:'commission-release-'+holder,requestId:holder,now:clock.now(),
        mutate:d=>releaseLease(d,{...scope,now:clock.now()})});
    }catch{/* A lost acknowledgement is resolved from the actual source lease. */}
    const lease=(await data()).automation.activeLease;
    if(lease?.holder===scope.holder&&lease?.fence===scope.fence&&lease?.scope===scope.scope)fail('commissioning_release_unconfirmed',502);
    // Never release a replacement holder. Own authority already ended.
  }
  return Object.freeze({async execute({operation}){
    assertCommissioningTransport(operation,transport);
    admission(operation,await data());
    const holder='commission-'+randomUUID(),scopeName=identity.tenant+':mainrun';
    let verifiedScope;
    try{
      let acquisitionError;
      try{
        const out=await core.mutate({commandKey:'commission-acquire-'+holder,requestId:holder,now:clock.now(),
          mutate:d=>{admission(operation,d);return acquireLease(d,{holder,scope:scopeName,now:clock.now()});}});
        if(!out?.result?.ok)fail('commissioning_source_busy');
      }catch(error){acquisitionError=error;}
      const current=await data(),lease=current.automation.activeLease;
      if(!lease||lease.holder!==holder||lease.scope!==scopeName){if(acquisitionError)throw acquisitionError;fail('commissioning_lease_unconfirmed',502);}
      verifiedScope=Object.freeze({holder,scope:scopeName,fence:lease.fence});
      assertLeadership(current,verifiedScope,clock.now());
      admission(operation,current);
      const journal=createCommissioningResponseJournal({operation,core,clock,verifiedScope,artifacts,artifactBucket});
      async function recover(replayed){
        const latest=await data();assertLeadership(latest,verifiedScope,clock.now());
        const call=readRuntime(latest).cost.callsById[operation.callId];
        if(!call?.dispatch.claimed)return null;
        const response=await journal.read();
        if(!response)fail('commissioning_outcome_unresolved');
        if(response.outcome==='settled')await journal.settle();
        else if(call.state==='reserved'){
          const out=await core.mutate({commandKey:'commission-unknown-'+operation.callId,requestId:holder,now:clock.now(),mutate:d=>{
            assertCommissioningReceipt(operation,{data:d,now:clock.now(),core});
            return markCostOutcomeUnknown(d,{callId:operation.callId,reason:'persisted_unknown_response',now:clock.now(),verifiedScope});
          }});
          if(!out?.result?.ok)fail('commissioning_unknown_unrecorded',502);
        }
        const confirmed=await data();assertLeadership(confirmed,verifiedScope,clock.now());
        const receipt=readRuntime(confirmed).cost.callsById[operation.callId];
        return {schemaVersion:1,callId:operation.callId,requestHash:operation.prepared.contentHash,
          runKey:operation.runKey,sectionId:operation.sectionId,stepIndex:operation.stepIndex,
          provider:operation.provider,model:operation.model,commissioning:operation.commissioning,
          contract:{inputTokens:operation.prepared.inputTokens,outputTokens:operation.prepared.outputTokens},
          settledMicros:receipt.settledMicros??null,overrunMicros:receipt.overrunMicros??0,
          outcome:response.outcome,response,replayed,dispatchAllowed:false};
      }
      const retained=await recover(true);if(retained)return retained;
      if(operation.recoveryOnly===true)fail('commissioning_recovery_missing');
      const adapter=createCommissioningCostAdapter({ports,config,now:clock.now(),requestId:holder,verifiedScope},
        {operation,__allowFixturePolicy});
      await adapter.reserve({...operation,...operation.prepared,modelPricing:pricing});
      await journal.prepare(); // prove private artifact write/read before paying
      try{
        await adapter.claimAndDispatch({callId:operation.callId,claimId:operation.callId+'-dispatch',commissioning:operation.commissioning,
          modelPricing:pricing,send:async()=>{
            const response=await dispatch({prepared:operation.prepared,requestId:operation.callId});
            await journal.record(response); // durable before cost settlement and HTTP acknowledgement
            return response;
          }});
      }catch(error){
        // Includes a committed response whose acknowledgement was lost and
        // whose cost was conservatively marked unknown by the adapter.
        const current=await data();
        if(readRuntime(current).cost.callsById[operation.callId]?.commissioningResponse){
          const recovered=await recover(true);if(recovered)return recovered;
        }
        throw error;
      }
      const result=await recover(false);if(!result)fail('commissioning_response_missing',502);return result;
    }finally{if(verifiedScope)await release(verifiedScope,holder);}
  }});
}
