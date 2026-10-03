import {openCommandQueue, createCommandTransport, canonicalIntentJson} from './quantus-v3-command-client.mjs';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(value) && !value.includes('__');
const fail = code => {throw Object.assign(new Error(code), {code});};
export async function cancellationIntent({accountKey, lead, reason, toState='cancelled', evidenceRefs=[], cryptoImpl=globalThis.crypto}) {
  if (!id(accountKey)) fail('sign_in_required');
  if (!id(lead?.id) || !lead.operationalStateSource || !Number.isSafeInteger(lead.operationalStateVersion)
    || lead.operationalStateVersion < 1 || !['doing','cancelled','done'].includes(toState)
    || (toState !== 'doing' ? ['done','cancelled'].includes(lead.operationalState) : !['done','cancelled'].includes(lead.operationalState))) fail('lead_not_addressable');
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) fail('reason_invalid');
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 1 || !evidenceRefs.every(id)
    || toState !== 'done' && evidenceRefs.length) fail('evidence_invalid');
  let completion = {};
  if (toState === 'done') {
    if (typeof lead.result !== 'string' || !lead.result.trim()) fail('result_missing');
    const resultBytes=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(lead.result));
    const resultHash=Array.from(new Uint8Array(resultBytes),b=>b.toString(16).padStart(2,'0')).join('');
    completion={result:lead.result,resultHash,evidenceRefs:[...evidenceRefs]};
  }
  const identity=[accountKey,lead.id,lead.operationalStateVersion];
  if (toState === 'done') identity.push(completion.resultHash,completion.evidenceRefs);
  const bytes=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
  const key=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  return {accountKey,operationId:'lead-cancel-'+key,legacyOperation:{kind:'lead_cancellation',schemaVersion:1,
    leadId:lead.id,version:lead.operationalStateVersion,title:String(lead.title||''),toState,reason:reason.trim(),...completion}};
}
const validRun = r => r && /^run_\d{4}-\d{2}-\d{2}$/.test(r.id) && r.id==='run_'+r.date
  && Number.isFinite(Date.parse(r.date)) && new Date(r.date).toISOString().slice(0,10)===r.date
  && ['created','active','exception_open'].includes(r.phase);
export async function openLeadCancellations({accountKey,getAuth,getRun,getLead=async()=>null,origin,indexedDB,fetchImpl,now=Date.now,cryptoImpl=globalThis.crypto}) {
  const queue=await openCommandQueue({indexedDB,databaseName:'quantus-v4-lead-cancellations',now});
  const transport=createCommandTransport({origin,getAuth,fetchImpl,now,writesEnabled:true});
  const all=()=>queue.list(accountKey,{includeAcknowledged:true});
  let busy=false,nextCheckAt=0;
  const checked={async send(entry,options){
    const result=await transport.send(entry,options);
    if(result.ok && result.receipt.entityVersions[entry.command.payload.leadId]!==entry.command.expectedEntityVersion+1)
      return {ok:false,status:0,code:'cancellation_receipt_incomplete',retryable:true,uncertain:true};
    return result;
  }};
  async function reconcile(){
    const entries=await all(),known=new Map(entries.map(e=>[e.operationId,e]));
    for(const entry of entries.filter(e=>e.legacyOperation?.kind==='lead_cancellation')){
      const p=entry.legacyOperation;
      const expected=await cancellationIntent({accountKey,lead:{id:p.leadId,title:p.title,operationalStateVersion:p.version,operationalStateSource:{},operationalState:p.toState==='doing'?'cancelled':'doing',result:p.result},reason:p.reason,toState:p.toState,evidenceRefs:p.evidenceRefs||[],cryptoImpl});
      if(expected.operationId!==entry.operationId || canonicalIntentJson(expected.legacyOperation)!==canonicalIntentJson(p))fail('stored_operation_corrupt');
      const commandId=entry.operationId+'-send';
      if(known.has(commandId))continue;
      const run=await getRun();if(!validRun(run))continue;
      if (p.toState === 'done') {
        const current=await getLead(p.leadId);
        if (!current || current.operationalStateVersion!==p.version || current.result!==p.result) continue;
      }
      await queue.enqueue({accountKey,operationId:commandId,command:{schemaVersion:3,verb:'lead.transition',jobId:run.id,
        expectedEntityVersion:p.version,payload:{leadId:p.leadId,toState:p.toState,reason:p.reason,...(p.toState==='done'?{expectedResultHash:p.resultHash,evidenceRefs:p.evidenceRefs}: {})}}});
    }
  }
  return Object.freeze({close:()=>queue.close(),nextCheckAt:()=>nextCheckAt,
    async submit(input){
      const auth=await getAuth();if(auth?.accountKey!==accountKey)fail('sign_in_required');
      const intent=await cancellationIntent({...input,accountKey,cryptoImpl});
      if((await getAuth())?.accountKey!==accountKey)fail('sign_in_required');
      return queue.retainLegacy(intent);
    },
    async list(){const entries=await all(),commands=new Map(entries.filter(e=>e.command).map(e=>[e.operationId,e]));
      return entries.filter(e=>e.legacyOperation?.kind==='lead_cancellation').map(e=>({...e,
        deliveryStatus:commands.get(e.operationId+'-send')?.status||(e.legacyOperation.toState==='done'?'completion_pending':'run_pending')}));},
    async flush(){if(busy)return {busy:true};busy=true;nextCheckAt=now()+30000;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
      try {if((await getAuth())?.accountKey!==accountKey)fail('sign_in_required');
        await queue.resumeAfterSignIn(accountKey);await reconcile();
        return await queue.drain(accountKey,{transport:checked,limit:8,signal:controller.signal});
      }finally{clearTimeout(timer);busy=false;}
    }
  });
}
export const cancellationStatusText = (status,toState='cancelled') => ({completion_pending:'Auf diesem Gerät gesichert · wartet auf passenden Serverstand und Tageslauf',run_pending:'Auf diesem Gerät gesichert · wartet auf einen Tageslauf',
  pending:toState==='doing'?'Auf diesem Gerät gesichert · Wiederöffnung noch nicht bestätigt':'Auf diesem Gerät gesichert · Abschluss noch nicht bestätigt',retry_wait:'Serverbestätigung ausstehend · Auftrag bleibt gesichert',
  acknowledged:toState==='doing'?'Wiederöffnung vom Server bestätigt':toState==='done'?'Abschluss vom Server bestätigt':'Hinfälligkeit vom Server bestätigt',conflict:'Lead inzwischen geändert · Auftrag bitte prüfen',
  needs_sign_in:'Bitte erneut anmelden · Auftrag bleibt gesichert',needs_review:'Übertragung ungeklärt · Auftrag bleibt gesichert',
  upgrade_required:'App-Aktualisierung erforderlich · Auftrag bleibt gesichert'}[status]||'Serverbestätigung ausstehend');
