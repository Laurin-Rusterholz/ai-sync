/** Isolated worker transport to the source broker. No provider credential,
 * local cost claim or automatic retry. Repeating the same immutable operation
 * asks the source broker to recover its durable receipt. */
import {createHash} from 'node:crypto';
import {HttpError} from './errors.mjs';
import {isIsolatedShadowCore,isolatedShadowBinding} from './shadow-isolation.mjs';
import {assertLeadership,readRuntime} from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import {parseSlotRunKey} from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import {commissioningProfileHash} from './commissioning-ingress.mjs';
import {isOpenAIRequestContract} from './openai-transport.mjs';
import {verifyGoogleIdToken} from './oidc.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(code,status=409)=>{throw new HttpError(status,code);};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(v)&&!v.includes('__');
const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function createCommissioningClient({config,core,clock,connection,contract,getIdToken,jwks,fetchImpl=fetch,timeoutMs=80000}){
  const binding=isolatedShadowBinding(core);
  if(!isIsolatedShadowCore(core,config)||config.role!=='worker'||!clock?.now||!record(connection)
    ||!/^https:\/\/[a-z0-9.-]+(?::\d+)?\/v4\/commissioning\/respond$/.test(connection.audience)
    ||connection.bindingHash!==binding.hash||!id(connection.allocationId)
    ||typeof connection.serviceAccount!=='string'||!connection.serviceAccount.endsWith('@'+binding.projectId+'.iam.gserviceaccount.com')
    ||!record(connection.profiles)||!Object.keys(connection.profiles).length
    ||!isOpenAIRequestContract(contract)||!contract?.prepare||contract.provider!=='openai'||typeof contract.dispatch==='function'
    ||typeof getIdToken!=='function'||!jwks?.getKeys||typeof fetchImpl!=='function'
    ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>85000)fail('commissioning_client_not_configured',503);
  const approved=structuredClone(connection),prepare=contract.prepare.bind(contract);
  for(const [slot,p]of Object.entries(approved.profiles))if(!['briefing04','process09','continue14','close23'].includes(slot)
    ||!record(p)||!id(p.id)||!/^[a-f0-9]{64}$/.test(p.hash))fail('commissioning_client_not_configured',503);
  async function active(runKey,scope){
    const {data}=await core.read();assertLeadership(data,scope,clock.now());
    const run=readRuntime(data).runsByKey[runKey],section=run?.sections?.[run.currentSectionId];
    if(run?.phase!=='active'||section?.closed!==false||section.holder!==scope.holder||section.fence!==scope.fence)
      fail('commissioning_shadow_section_mismatch');
  }
  return Object.freeze({async respond({runKey,stepIndex,request,verifiedScope,signal}){
    const parsed=parseSlotRunKey(runKey),profile=approved.profiles[parsed.slot];
    if(parsed.tenant!==binding.tenant||!profile||!Number.isSafeInteger(stepIndex)||stepIndex<0||stepIndex>4095
      ||commissioningProfileHash(request)!==profile.hash)fail('commissioning_client_request_invalid',400);
    const prepared=prepare(request),inputJson=JSON.stringify(request.input);
    if(Buffer.byteLength(inputJson)>256*1024)fail('commissioning_client_request_invalid',400);
    const operationId=hash([approved.allocationId,binding.hash,runKey,profile.id,stepIndex]);
    const callId='commission-'+operationId;
    const controller=new AbortController();let rejectDeadline,reader;
    const deadline=new Promise((_,reject)=>{rejectDeadline=reject;});
    const abort=()=>{controller.abort();void reader?.cancel().catch(()=>{});rejectDeadline(new HttpError(504,'commissioning_response_unconfirmed'));};
    const timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const check=()=>{if(controller.signal.aborted)fail('commissioning_response_unconfirmed',504);};
    try{return await Promise.race([deadline,(async()=>{
      check();await active(runKey,verifiedScope);check();
      const token=await getIdToken({audience:approved.audience,signal:controller.signal});
      const keys=await jwks.getKeys();check();
      verifyGoogleIdToken(token,{audience:approved.audience,allowedServiceAccounts:[approved.serviceAccount],jwks:keys,now:clock.now()});
      await active(runKey,verifiedScope);check();
      // Recheck token lifetime after the final awaited source read.
      verifyGoogleIdToken(token,{audience:approved.audience,allowedServiceAccounts:[approved.serviceAccount],jwks:keys,now:clock.now()});
      const response=await fetchImpl(approved.audience,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({runKey,sectionId:profile.id,stepIndex,inputJson})});
      check();if(!response.ok){void response.body?.cancel().catch(()=>{});fail('commissioning_broker_rejected',response.status>=400&&response.status<=599?response.status:502);}
      reader=response.body?.getReader();if(!reader)fail('commissioning_response_unconfirmed',502);
      const chunks=[];let size=0;
      for(;;){const part=await reader.read();check();if(part.done)break;size+=part.value.byteLength;if(size>3*1024*1024){void reader.cancel().catch(()=>{});fail('commissioning_response_too_large',502);}chunks.push(Buffer.from(part.value));}
      let receipt;try{receipt=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('commissioning_response_unconfirmed',502);}
      if(!record(receipt)||receipt.schemaVersion!==1||receipt.callId!==callId||receipt.requestHash!==prepared.contentHash
        ||receipt.runKey!==runKey||receipt.sectionId!==profile.id||receipt.stepIndex!==stepIndex||receipt.model!==contract.model||receipt.provider!=='openai'
        ||receipt.commissioning?.allocationId!==approved.allocationId||receipt.commissioning?.bindingHash!==binding.hash||receipt.commissioning?.operationId!==operationId
        ||receipt.contract?.inputTokens!==prepared.inputTokens||receipt.contract?.outputTokens!==prepared.outputTokens
        ||receipt.dispatchAllowed!==false||typeof receipt.replayed!=='boolean'||!['settled','unknown'].includes(receipt.outcome)
        ||receipt.response?.outcome!==receipt.outcome||!Number.isSafeInteger(receipt.overrunMicros)||receipt.overrunMicros<0)
        fail('commissioning_receipt_mismatch',502);
      if(receipt.outcome==='settled'&&(!Number.isSafeInteger(receipt.settledMicros)||receipt.settledMicros<0
        ||receipt.settledMicros!==receipt.response.actualMicros||typeof receipt.response.usageReceiptId!=='string'||!receipt.response.usageReceiptId))fail('commissioning_receipt_mismatch',502);
      await active(runKey,verifiedScope);check();return receipt;
    })()]);}catch(error){if(error instanceof HttpError)throw error;fail('commissioning_response_unconfirmed',502);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }});
}
