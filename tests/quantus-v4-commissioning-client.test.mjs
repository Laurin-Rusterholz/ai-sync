import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommissioningService} from '../runtime/quantus-v3/src/commissioning-composition.mjs';
import {loadV4LeadershipInstructions} from '../runtime/quantus-v3/src/v4-leadership-loop.mjs';
import {leadershipToolDefinitions} from '../runtime/quantus-v3/src/leadership-gateway.mjs';
import {reserveCommissioningWithMonthlyCap} from '../runtime/quantus-v3/src/monthly-cost-cap.mjs';
import {releaseLease} from '../netlify/lib/quantus-v3-runtime-state.mjs';
import {casMutate} from './quantus-v3-runtime-cas-harness.mjs';
import {createLeadershipJournal,JOURNAL_LIMITS} from '../runtime/quantus-v3/src/leadership-journal.mjs';
import {createLeadershipLoop} from '../runtime/quantus-v3/src/leadership-loop.mjs';
import {createOpenAIWorkerPorts} from '../runtime/quantus-v3/src/openai-composition.mjs';
import {POLICY_TEMPLATE} from '../netlify/lib/assistant-schema.mjs';
import {DOMAIN_PORT_VARS} from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import {migrateCore} from '../netlify/lib/assistant-migration.mjs';
import {createHash} from 'node:crypto';
import {createCommissioningClient} from '../runtime/quantus-v3/src/commissioning-client.mjs';
import {createOpenAIRequestContract,createOpenAITransport} from '../runtime/quantus-v3/src/openai-transport.mjs';
import {resolveShadowBinding,shadowIsolationMarker,isolateShadowCorePort} from '../runtime/quantus-v3/src/shadow-isolation.mjs';
import {commissioningProfileHash} from '../runtime/quantus-v3/src/commissioning-ingress.mjs';
import {availablePort} from '../runtime/quantus-v3/src/ports.mjs';
import {setup,T,RUN} from './fixtures/quantus-v4-leadership-fixture.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex'),key=F.createSigningKey();
const profile={instructions:'Reviewed',tools:[{name:'quantus_context',description:'Scoped read',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}]};
async function fixture(options={}){
 const selectedProfile=options.profile??profile;
 const f=await setup(options.initialData),binding={schemaVersion:1,sourceProjectId:'source-invalid',sourceTenant:'source',sourceC2Origin:'https://source.invalid',projectId:'shadow-invalid',tenant:'quantus',c2Origin:'https://shadow.invalid',databaseUrl:'https://shadow-invalid.firebaseio.com',ref:'isolated-test-only'};
 const config={mode:'shadow',role:'worker',tenant:'quantus',c2BaseUrl:binding.c2Origin};
 const env={QUANTUS_V4_SHADOW_BINDING:JSON.stringify(binding),FIREBASE_PROJECT_ID:binding.projectId,FIREBASE_DATABASE_URL:binding.databaseUrl,QUANTUS_V3_FIREBASE_PROJECT_ID:binding.projectId,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:binding.projectId,client_email:'worker@shadow-invalid.iam.gserviceaccount.com',private_key:'SYNTHETIC'})};
 const args={config,envRead:n=>env[n]},resolved=resolveShadowBinding(args);
 f.store.forceWrite(d=>{d.automation.shadowIsolation=shadowIsolationMarker(resolved);return d;});
 const core=isolateShadowCorePort({...args,corePort:availablePort('core',f.core)}).impl;
 const connection={audience:'https://broker.invalid/v4/commissioning/respond',bindingHash:resolved.hash,allocationId:'allocation-test',serviceAccount:'worker@shadow-invalid.iam.gserviceaccount.com',profiles:{process09:{id:'process-profile',hash:commissioningProfileHash(selectedProfile)}}};
 const contract=createOpenAIRequestContract({model:'test-model',modelPricing:{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000}});
 const request={...selectedProfile,input:[{role:'user',content:'original context'}]},prepared=contract.prepare(request),wire=[];
 const token=()=>F.schedulerToken(key,{audience:connection.audience,email:connection.serviceAccount,nowMs:T});
 const configClient={config,core,clock:f.clock,connection,contract,jwks:F.jwksPort(key).impl,getIdToken:async()=>{await options.onToken?.(f);return token();},timeoutMs:options.timeoutMs??1000,fetchImpl:async(url,init)=>{
  wire.push({url,init});await options.onFetch?.(f);const body=JSON.parse(init.body),operationId=hash([connection.allocationId,resolved.hash,body.runKey,body.sectionId,body.stepIndex]);
  const receipt={schemaVersion:1,callId:'commission-'+operationId,requestHash:prepared.contentHash,runKey:body.runKey,sectionId:body.sectionId,stepIndex:body.stepIndex,provider:'openai',model:'test-model',commissioning:{allocationId:connection.allocationId,bindingHash:resolved.hash,operationId},contract:{inputTokens:prepared.inputTokens,outputTokens:prepared.outputTokens},settledMicros:60,overrunMicros:0,outcome:'settled',response:{outcome:'settled',actualMicros:60,usageReceiptId:'synthetic-receipt',result:{usable:true,text:'answer',toolCalls:[],output:[]}},replayed:wire.length>1,dispatchAllowed:false};
  options.changeReceipt?.(receipt);return options.response??new Response(JSON.stringify(receipt),{status:200});
 }};
 const client=createCommissioningClient(configClient),call=over=>client.respond({runKey:RUN,stepIndex:0,request,verifiedScope:f.scope,...over});
 return {...f,core,connection,contract,request,prepared,wire,configClient,client,call};
}
test('keyless request contract uses identical bytes but cannot dispatch or cross paid transport instances',async()=>{
 const f=await fixture();assert.equal(f.contract.dispatch,undefined);
 const paid=createOpenAITransport({apiKey:'SYNTHETIC',model:f.contract.model,modelPricing:f.contract.modelPricing,fetchImpl:async()=>{throw Error('must not send');}});
 assert.deepEqual(paid.prepare(f.request),f.prepared);
 await assert.rejects(paid.dispatch({prepared:f.prepared,requestId:'test'}),/prepared_request_required/);
});
test('client defaults to attached Google workload identity before the broker request',async()=>{
 const f=await fixture();let identities=0;
 const client=createCommissioningClient({...f.configClient,getIdToken:undefined,identityFetch:async(url,init)=>{
  identities++;assert.equal(f.wire.length,0);assert.equal(new URL(url).hostname,'metadata.google.internal');
  assert.equal(init.headers['Metadata-Flavor'],'Google');
  return new Response(F.schedulerToken(key,{audience:f.connection.audience,email:f.connection.serviceAccount,nowMs:T}),{headers:{'Metadata-Flavor':'Google'}});
 }});
 assert.equal(identities,0);
 const result=await client.respond({runKey:RUN,stepIndex:0,request:f.request,verifiedScope:f.scope});
 assert.equal(result.outcome,'settled');assert.equal(identities,1);assert.equal(f.wire.length,1);
});
test('isolated client uses stable reviewed profile identity and never mutates a local cost ledger',async()=>{
 const f=await fixture(),before=f.store.snapshot();const a=await f.call(),b=await f.call();assert.equal(a.callId,b.callId);assert.equal(b.replayed,true);
 const payloads=f.wire.map(w=>JSON.parse(w.init.body));assert.deepEqual(payloads[0],payloads[1]);assert.equal(payloads[0].sectionId,'process-profile');
 assert.deepEqual(Object.keys(payloads[0]).sort(),['inputJson','runKey','sectionId','stepIndex']);
 assert.equal(f.wire[0].init.redirect,'error');assert.deepEqual(f.store.snapshot(),before);
 assert.equal(f.wire[0].init.headers['x-serverless-authorization'],f.wire[0].init.headers.authorization);
});
test('unbound cores, altered binding and paid transports are rejected before HTTP',async()=>{
 const f=await fixture();for(const over of [{core:f.configClient.core?{...f.core}:{}},{connection:{...f.connection,bindingHash:'f'.repeat(64)}},{contract:{...f.contract}},{config:{...f.configClient.config,mode:'live'}}])assert.throws(()=>createCommissioningClient({...f.configClient,...over}));
 assert.equal(f.wire.length,0);
});
test('changed instructions, different run and invalid ordinal cannot reach broker',async()=>{
 const f=await fixture();for(const over of [{request:{...f.request,instructions:'Injected'}},{runKey:'other:2026-10-02:process09:4.0'},{stepIndex:-1}])await assert.rejects(f.call(over));assert.equal(f.wire.length,0);
});
test('expired identity or lease after async credential lookup prevents sending',async()=>{
 const f=await fixture({onToken:f=>f.setNow(T+3600001)});await assert.rejects(f.call());assert.equal(f.wire.length,0);
});
test('fenced late broker response is not handed to worker',async()=>{
 const f=await fixture({onFetch:f=>f.setNow(T+121000)});await assert.rejects(f.call());assert.equal(f.wire.length,1);
});
test('receipt tampering and mismatched cost evidence are refused',async()=>{
 for(const changeReceipt of [r=>r.callId='wrong',r=>r.requestHash='f'.repeat(64),r=>r.runKey='other',r=>r.model='other',r=>r.contract.outputTokens++,r=>r.commissioning.bindingHash='f'.repeat(64),r=>r.response.actualMicros++,r=>r.dispatchAllowed=true,r=>r.overrunMicros=-1]){
  const f=await fixture({changeReceipt});await assert.rejects(f.call(),e=>e.error==='commissioning_receipt_mismatch');assert.equal(f.wire.length,1);
 }
});
test('HTTP refusal is not retried and response body is never exposed as an error',async()=>{
 const f=await fixture({response:new Response('SECRET-SERVER-BODY',{status:503})});await assert.rejects(f.call(),e=>e.error==='commissioning_broker_rejected'&&!e.message.includes('SECRET'));assert.equal(f.wire.length,1);
});
test('timeout ends the call even when transport ignores abort; no automatic resend',async()=>{
 let release;const wait=new Promise(r=>release=r);const f=await fixture({timeoutMs:10,onFetch:()=>wait});
 await assert.rejects(f.call(),e=>e.error==='commissioning_response_unconfirmed');assert.equal(f.wire.length,1);release();
});

test('isolated client talks to real signed source ingress, CAS broker and artifact store without a second cost ledger',async()=>{
 const {instructions}=await loadV4LeadershipInstructions({slot:'process09',promptVersion:'4.0.0'});
 const f=await fixture({profile:{instructions,tools:leadershipToolDefinitions()}}),source=await setup();let paid=0;
 const policy={schema:'quantus-v3-cost-policy/1',version:'test-only',currency:'USD',approval:{approvedBy:'test',approvalRef:'test-only',approvedAtMs:T-1000},effectiveFromMs:T-1000,effectiveUntilMs:T+86400000,dayLimitMicros:50000000,runLimitMicros:50000000,callLimitMicros:10000000,unresolvedBlockMicros:10000000,featureFlags:{providers:'live'},models:{'openai:test-model':{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000,maxCallMicros:10000000}}};
 const authority={schemaVersion:1,audience:f.connection.audience,serviceAccount:f.connection.serviceAccount,sourceProjectId:'source-invalid',sourceTenant:'source',shadowProjectId:'shadow-invalid',shadowTenant:'quantus',bindingHash:f.connection.bindingHash,allocationId:f.connection.allocationId,model:'test-model',profiles:{'process-profile':commissioningProfileHash(f.request)},allowedRuns:[RUN],maxStepIndex:10};
 casMutate(source.store,d=>reserveCommissioningWithMonthlyCap(d,{now:T,verifiedScope:source.scope,policy,authorization:{schemaVersion:1,allocationId:authority.allocationId,bindingHash:authority.bindingHash,month:'2026-10',maxMicros:10000000,approvedBy:'test',approvalRef:'test-only',approvedAtMs:T-1000,expiresAtMs:T+86400000}}));
 casMutate(source.store,d=>releaseLease(d,{...source.scope,now:T}));
 const env={QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON:JSON.stringify(authority),QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON:JSON.stringify({'process-profile':'process09'}),QUANTUS_V4_PROMPT_VERSION:'4.0.0',QUANTUS_V4_OPENAI_API_KEY:'SYNTHETIC',QUANTUS_V4_OPENAI_MODEL:'test-model',QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK:'1000000',QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK:'1000000',QUANTUS_V4_ARTIFACT_BUCKET:'quantus-test-artifacts',QUANTUS_V3_COST_POLICY_JSON:JSON.stringify(policy),FIREBASE_PROJECT_ID:'source-invalid',FIREBASE_DATABASE_URL:'https://source-invalid.firebaseio.com',FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'source-invalid',client_email:'broker@source-invalid.iam.gserviceaccount.com',private_key:'SYNTHETIC'})};
 const service=await createCommissioningService({envRead:n=>env[n],dependencies:{clock:source.clock,jwks:F.jwksPort(key),createCore:async()=>availablePort('core',source.core),createTokens:async()=>({ok:true,get:async()=>'synthetic'}),artifactFetch:source.artifacts.fetchImpl,providerFetch:async()=>{paid++;return new Response(JSON.stringify({id:'paid-test',status:'completed',usage:{input_tokens:50,output_tokens:10},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'actual stored output'}]}]}),{status:200});}}});
 const client=createCommissioningClient({...f.configClient,timeoutMs:5000,fetchImpl:async(url,init)=>{const r=await service.handle({method:init.method,path:new URL(url).pathname,headers:{...init.headers,'x-forwarded-proto':'https'},bodyText:init.body});return new Response(r.body,{status:r.status,headers:r.headers});}});
 const before=f.store.snapshot(),send=()=>client.respond({runKey:RUN,stepIndex:0,request:f.request,verifiedScope:f.scope});
 const a=await send(),b=await send();assert.equal(a.response.result.text,'actual stored output');assert.equal(b.replayed,true);assert.equal(paid,1);
 assert.equal(a.requestHash,f.prepared.contentHash);assert.equal(a.settledMicros,60);assert.deepEqual(f.store.snapshot(),before);
 const calls=Object.values(source.store.snapshot().automation.runtime.cost.callsById);assert.equal(calls.length,1);assert.equal(calls[0].state,'settled');assert.ok(calls[0].commissioningResponse);
});

test('unknown source outcome remains unknown and large or stalled bodies remain bounded',async()=>{
 const unknown=await fixture({changeReceipt:r=>{r.outcome='unknown';r.response={outcome:'unknown',reason:'unconfirmed'};r.settledMicros=null;}});
 assert.equal((await unknown.call()).outcome,'unknown');
 const large=await fixture({response:new Response('x'.repeat(3*1024*1024+1))});
 await assert.rejects(large.call(),e=>e.error==='commissioning_response_too_large');
 let cancelled=false;
 const stalled=await fixture({timeoutMs:20,response:new Response(new ReadableStream({cancel(){cancelled=true;}}))});
 await assert.rejects(stalled.call(),e=>e.error==='commissioning_response_unconfirmed');assert.equal(cancelled,true);
});


test('commissioned leadership loop persists source output and resumes with recovery-only verification',async()=>{
 const f=await fixture(),journal=()=>createLeadershipJournal({core:f.core,clock:f.clock,runKey:RUN,verifiedScope:f.scope,artifacts:f.artifacts.store,commissioningClient:f.client});
 const gateway={definitions:()=>profile.tools,execute:async()=>{throw Error('no tool expected');}};
 const make=()=>createLeadershipLoop({runKey:RUN,journal:journal(),openai:f.contract,gateway});
 const first=await make().step({initialRequest:f.request});assert.equal(first.kind,'model_recorded');
 const next=await make().step({initialRequest:f.request});assert.equal(next.kind,'model_complete');
 assert.deepEqual(f.store.snapshot().automation.runtime.cost.callsById,{});
 const bodies=f.wire.map(w=>JSON.parse(w.init.body));assert.equal(bodies[0].recoveryOnly,undefined);assert.equal(bodies[1].recoveryOnly,true);
 const wrong=createOpenAIRequestContract({model:'test-model',modelPricing:f.contract.modelPricing,maxOutputTokens:512});
 assert.throws(()=>createLeadershipLoop({runKey:RUN,journal:journal(),openai:wrong,gateway}),/commissioning_keyless_contract_required/);
});

test('commissioned journal archives only remotely verified settled history without fabricated local costs',async()=>{
 let corrupt=false;
 const f=await fixture({changeReceipt:r=>{if(corrupt)r.response.usageReceiptId='changed';}});
 const journal=()=>createLeadershipJournal({core:f.core,clock:f.clock,runKey:RUN,verifiedScope:f.scope,artifacts:f.artifacts.store,commissioningClient:f.client});
 const j=journal();
 for(let n=0;n<JOURNAL_LIMITS.turns;n++){
  const callId='lead-'+hash([RUN,n]);await j.begin({callId,requestHash:f.prepared.contentHash,request:f.request});
  await j.dispatchCommissioning({callId,requestHash:f.prepared.contentHash});
 }
 assert.equal((await j.rolloverIfNeeded()).rolled,true);await journal().verifyArchives();
 assert.deepEqual(f.store.snapshot().automation.runtime.cost.callsById,{});
 assert.equal((await journal().read()).length,JOURNAL_LIMITS.turns);
 corrupt=true;await assert.rejects(journal().verifyArchives(),e=>e.error==='journal_source_receipt_mismatch');
});

test('missing or changed source evidence prevents tool execution and no ordinary journal can opt into commissioning',async()=>{
 let corrupt=false,executed=0;
 const f=await fixture({changeReceipt:r=>{
  r.response.result={usable:true,text:'',toolCalls:[{callId:'call-test',name:'quantus_context',arguments:{}}],
    output:[{type:'function_call',call_id:'call-test',name:'quantus_context',arguments:'{}'}]};
  if(corrupt)r.response.usageReceiptId='changed';
 }});
 const j=createLeadershipJournal({core:f.core,clock:f.clock,runKey:RUN,verifiedScope:f.scope,artifacts:f.artifacts.store,commissioningClient:f.client});
 const loop=createLeadershipLoop({runKey:RUN,journal:j,openai:f.contract,gateway:{definitions:()=>profile.tools,execute:async()=>executed++}});
 await loop.step({initialRequest:f.request});corrupt=true;await assert.rejects(loop.step({initialRequest:f.request}));assert.equal(executed,0);
 assert.throws(()=>createLeadershipJournal({core:f.core,clock:f.clock,runKey:RUN,verifiedScope:f.scope,artifacts:f.artifacts.store,commissioningClient:{...f.client}}),/journal_commissioning_binding_invalid/);
});

async function commissionedWorker(){
 const {instructions}=await loadV4LeadershipInstructions({slot:'process09',promptVersion:'4.0.0'});
 const f=await fixture({profile:{instructions,tools:leadershipToolDefinitions()},initialData:migrateCore({entities:{}}, {now:T}).data});
 const config={...f.configClient.config,policyVersion:'4.0',leaseScope:'quantus:mainrun',toolsEnabled:{quantus_context:true}};
 const permission={schemaVersion:1,connection:f.connection,isolatedDomain:true,sourceReadIds:[]};
 const policy={...POLICY_TEMPLATE,tenant:'quantus',version:'4.0',requiredSources:[{id:'quantus-core',kind:'quantus-core'}],noExternalSources:true};
 const env={QUANTUS_V4_OPENAI_MODEL:'test-model',QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK:'1000000',QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK:'1000000',QUANTUS_V4_PROMPT_VERSION:'4.0.0',QUANTUS_V4_COMMISSIONING_WORKER_JSON:JSON.stringify(permission),[DOMAIN_PORT_VARS.policyJson]:JSON.stringify(policy)};
 const brokerRequests=[],tools=[];
 const make=over=>createOpenAIWorkerPorts({config,corePort:f.core,clockPort:f.clock,envRead:n=>env[n],artifactStore:f.artifacts.store,
  jobTokenIssuer:{available:true,async mint(){return 'synthetic-job-token';}},
  c2Transport:{async send(request){tools.push(request);return {status:503,body:{error:'synthetic-source-unavailable'}};}},
  providerFetch:async()=>{throw Error('shadow must never contact provider directly');},
  commissioningJwks:F.jwksPort(key).impl,
  identityFetch:async()=>new Response(F.schedulerToken(key,{audience:f.connection.audience,email:f.connection.serviceAccount,nowMs:T}),{headers:{'Metadata-Flavor':'Google'}}),
  commissioningFetch:async(_url,init)=>{
   const body=JSON.parse(init.body);brokerRequests.push(body);
   const prepared=f.contract.prepare({instructions,tools:leadershipToolDefinitions(),input:JSON.parse(body.inputJson)});
   const operationId=hash([f.connection.allocationId,f.connection.bindingHash,body.runKey,body.sectionId,body.stepIndex]);
   const call={callId:'policy-read',name:'quantus_context',arguments:{query:'policy.current',scopeId:'policy_current',cursor:''}};
   return Response.json({schemaVersion:1,callId:'commission-'+operationId,requestHash:prepared.contentHash,runKey:body.runKey,sectionId:body.sectionId,stepIndex:body.stepIndex,provider:'openai',model:'test-model',commissioning:{allocationId:f.connection.allocationId,bindingHash:f.connection.bindingHash,operationId},contract:{inputTokens:prepared.inputTokens,outputTokens:prepared.outputTokens},settledMicros:60,overrunMicros:0,outcome:'settled',response:{outcome:'settled',actualMicros:60,usageReceiptId:'synthetic-receipt',result:{usable:true,text:'',toolCalls:[call],output:[{type:'function_call',call_id:call.callId,name:call.name,arguments:JSON.stringify(call.arguments)}]}},replayed:body.recoveryOnly===true,dispatchAllowed:false});
  },...over});
 return {...f,config,permission,policy,env,make,brokerRequests,tools,args:{runKey:RUN,sectionId:'section-1',verifiedScope:f.scope}};
}

test('existing worker runs through metadata identity and broker without an API key or shadow cost claims',async()=>{
 const f=await commissionedWorker(),before=structuredClone(f.config);
 const ports=await f.make();assert.equal(ports.sectionWork.available,true,ports.sectionWork.reason);
 const result=await ports.sectionWork.impl.next(f.args);assert.equal(result.cursor.phase,'model_recorded');
 assert.ok(f.store.snapshot().dailyBriefing.assistantRuns['2026-10-02'].startNoteId);
 assert.equal(f.brokerRequests.length,1);assert.equal(f.brokerRequests[0].recoveryOnly,undefined);
 const resumed=await (await f.make()).sectionWork.impl.next(f.args);assert.equal(resumed.cursor.phase,'tool_recorded');
 assert.equal(f.brokerRequests[1].recoveryOnly,true);assert.equal(f.tools.length,1);
 assert.deepEqual(f.store.snapshot().automation.runtime.cost.callsById,{});assert.deepEqual(f.config,before);
 assert.equal(f.config.mode,'shadow');assert.equal(f.config.allowExternalEffects,undefined);
});

test('worker rejects missing permission, extra source reads and changed profiles before any bootstrap or HTTP',async()=>{
 for(const change of [p=>delete p.isolatedDomain,p=>p.isolatedDomain=false,p=>p.sourceReadIds=['unapproved-mail'],p=>p.connection.profiles.process09.hash='f'.repeat(64)]){
  const f=await commissionedWorker(),p=structuredClone(f.permission);change(p);
  f.env.QUANTUS_V4_COMMISSIONING_WORKER_JSON=JSON.stringify(p);const before=f.store.snapshot();
  assert.equal((await f.make()).sectionWork.available,false);assert.deepEqual(f.store.snapshot(),before);assert.equal(f.brokerRequests.length,0);
 }
});

test('configured required mail cannot be acquired without its explicit commissioning read permission',async()=>{
 const f=await commissionedWorker();
 f.env[DOMAIN_PORT_VARS.policyJson]=JSON.stringify({...f.policy,noExternalSources:false,requiredSources:[...f.policy.requiredSources,{id:'required-mail',kind:'gmail'}]});
 const before=f.store.snapshot(),ports=await f.make();
 assert.equal(ports.sectionWork.available,false);assert.equal(ports.sectionWork.reason,'commissioning_source_permission_mismatch');
 assert.deepEqual(f.store.snapshot(),before);assert.equal(f.brokerRequests.length,0);
});

test('lost isolated storage marker after worker construction prevents bootstrap and broker dispatch',async()=>{
 const f=await commissionedWorker(),ports=await f.make();assert.equal(ports.sectionWork.available,true);
 f.store.forceWrite(d=>{delete d.automation.shadowIsolation;return d;});const before=f.store.snapshot();
 await assert.rejects(ports.sectionWork.impl.next(f.args),e=>e.error==='shadow_isolation_mismatch');
 assert.deepEqual(f.store.snapshot(),before);assert.equal(f.brokerRequests.length,0);
});
