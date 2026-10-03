import {openCommandQueue,createCommandTransport,canonicalIntentJson} from './quantus-v3-command-client.mjs';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,120}$/.test(v)&&!v.includes('__');
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function waitingIntent({accountKey,lead,counterparty,nextAction,waitUntil,evidenceId,cryptoImpl=globalThis.crypto}){
 if(!id(accountKey))fail('sign_in_required');
 if(!id(lead?.id)||!lead.operationalStateSource||!Number.isSafeInteger(lead.operationalStateVersion)
   ||lead.operationalStateVersion<1||!['doing','waiting_external','waiting_user','delegated','review'].includes(lead.operationalState))fail('lead_not_addressable');
 if(typeof counterparty!=='string'||!counterparty.trim()||counterparty.trim().length>200
   ||typeof nextAction!=='string'||!nextAction.trim()||nextAction.trim().length>500)fail('waiting_fields_invalid');
 if(typeof waitUntil!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(waitUntil)
   ||!Number.isFinite(Date.parse(waitUntil))||new Date(waitUntil).toISOString()!==waitUntil||!id(evidenceId))fail('waiting_evidence_or_date_invalid');
 // An explicit correction is a new intent, never an overwrite/rebase of the
 // old one. Both keep the captured version, so at most one can apply.
 const bytes=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([
  accountKey,lead.id,lead.operationalStateVersion,counterparty.trim(),nextAction.trim(),waitUntil,evidenceId])));
 const key=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 return {accountKey,operationId:'lead-wait-'+key,legacyOperation:{kind:'lead_waiting',schemaVersion:1,
  leadId:lead.id,version:lead.operationalStateVersion,title:String(lead.title||''),
  counterparty:counterparty.trim(),nextAction:nextAction.trim(),waitUntil,evidenceId}};
}
const validRun=r=>r&&/^run_\d{4}-\d{2}-\d{2}$/.test(r.id)&&r.id==='run_'+r.date
 &&Number.isFinite(Date.parse(r.date))&&new Date(r.date).toISOString().slice(0,10)===r.date
 &&['created','active','exception_open'].includes(r.phase);
export async function openLeadWaiting({accountKey,getAuth,getRun,origin,indexedDB,fetchImpl,now=Date.now,cryptoImpl=globalThis.crypto}){
 const queue=await openCommandQueue({indexedDB,databaseName:'quantus-v4-lead-waiting',now});
 const transport=createCommandTransport({origin,getAuth,fetchImpl,now,writesEnabled:true});
 const all=()=>queue.list(accountKey,{includeAcknowledged:true});let busy=false,nextCheckAt=0;
 const checked={async send(entry,options){const result=await transport.send(entry,options);
  if(result.ok&&result.receipt.entityVersions[entry.command.payload.leadId]!==entry.command.expectedEntityVersion+1)
   return {ok:false,status:0,code:'waiting_receipt_incomplete',retryable:true,uncertain:true};
  return result;
 }};
 async function reconcile(){
  const entries=await all(),known=new Set(entries.map(e=>e.operationId));
  for(const entry of entries.filter(e=>e.legacyOperation?.kind==='lead_waiting')){
   const p=entry.legacyOperation;
   const expected=await waitingIntent({accountKey,lead:{id:p.leadId,title:p.title,operationalStateVersion:p.version,
    operationalStateSource:{},operationalState:'doing'},...p,cryptoImpl});
   if(expected.operationId!==entry.operationId||canonicalIntentJson(expected.legacyOperation)!==canonicalIntentJson(p))fail('stored_operation_corrupt');
   const commandId=entry.operationId+'-send';if(known.has(commandId))continue;
   const run=await getRun();if(!validRun(run))continue;
   await queue.enqueue({accountKey,operationId:commandId,command:{schemaVersion:3,verb:'lead.schedule',jobId:run.id,
    expectedEntityVersion:p.version,payload:{leadId:p.leadId,counterparty:p.counterparty,nextAction:p.nextAction,
     waitUntil:p.waitUntil,evidenceRefs:[p.evidenceId]}}});
  }
 }
 return Object.freeze({close:()=>queue.close(),nextCheckAt:()=>nextCheckAt,
  async submit(input){
   if((await getAuth())?.accountKey!==accountKey)fail('sign_in_required');
   const intent=await waitingIntent({...input,accountKey,cryptoImpl});
   if((await getAuth())?.accountKey!==accountKey)fail('sign_in_required');
   return queue.retainLegacy(intent);
  },
  async list(){const entries=await all(),commands=new Map(entries.filter(e=>e.command).map(e=>[e.operationId,e]));
   return entries.filter(e=>e.legacyOperation?.kind==='lead_waiting').map(e=>({...e,deliveryStatus:commands.get(e.operationId+'-send')?.status||'run_pending'}));},
  async flush(){if(busy)return {busy:true};busy=true;nextCheckAt=now()+30000;
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
   try{if((await getAuth())?.accountKey!==accountKey)fail('sign_in_required');
    await queue.resumeAfterSignIn(accountKey);await reconcile();
    return await queue.drain(accountKey,{transport:checked,limit:8,signal:controller.signal});
   }finally{clearTimeout(timer);busy=false;}
  }
 });
}
export const waitingStatusText=status=>({run_pending:'Auf diesem Gerät gesichert · wartet auf einen Tageslauf',
 pending:'Warteauftrag gesichert · noch nicht bestätigt',retry_wait:'Serverbestätigung ausstehend · Warteauftrag bleibt gesichert',
 acknowledged:'Wartezustand vom Server bestätigt',conflict:'Lead inzwischen geändert · Warteauftrag bitte prüfen',
 needs_sign_in:'Bitte erneut anmelden · Warteauftrag bleibt gesichert',needs_review:'Warteauftrag prüfen · Beleg oder Termin wurde nicht bestätigt',
 upgrade_required:'App-Aktualisierung erforderlich · Warteauftrag bleibt gesichert'}[status]||'Warteauftrag noch nicht bestätigt');
