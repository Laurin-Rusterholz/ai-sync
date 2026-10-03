import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommissioningTasksPermission } from '../runtime/quantus-v3/src/commissioning-tasks.mjs';
import { createCloudTasksHttpTransport } from '../runtime/quantus-v3/src/google-transport.mjs';
import { createCloudTasksPort } from '../runtime/quantus-v3/src/integration-ports.mjs';
import { continuationTaskId } from '../runtime/quantus-v3/src/task-names.mjs';
import { resolveShadowBinding, shadowIsolationMarker, isolateShadowCorePort } from '../runtime/quantus-v3/src/shadow-isolation.mjs';
import { availablePort } from '../runtime/quantus-v3/src/ports.mjs';
import { checkpointRunSection, projectMonitorView, applyMonitorPlan } from '../netlify/lib/quantus-v3-runtime-state.mjs';
import { buildMonitorPlan } from '../netlify/lib/quantus-v3-runtime-plan.mjs';
import { casMutate } from './quantus-v3-runtime-cas-harness.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';

async function fixture({ role='worker', onToken, onRead, status=200 }={}) {
 const f=await setup(),binding={schemaVersion:1,sourceProjectId:'source-invalid',sourceTenant:'source',sourceC2Origin:'https://source.invalid',projectId:'shadow-invalid',tenant:'quantus',c2Origin:'https://shadow.invalid',databaseUrl:'https://shadow-invalid.firebaseio.com',ref:'synthetic-isolation-only'};
 const tasks={queue:'projects/shadow-invalid/locations/europe-west1/queues/shadow',targetUrl:'https://worker.invalid/v3/run/continue',audience:'https://worker.invalid/v3/run/continue',oidcServiceAccount:'tasks@shadow-invalid.iam.gserviceaccount.com'};
 const config={mode:'shadow',role,tenant:'quantus',policyVersion:'4.0',c2BaseUrl:binding.c2Origin,tasks};
 const env={QUANTUS_V4_SHADOW_BINDING:JSON.stringify(binding),FIREBASE_PROJECT_ID:binding.projectId,FIREBASE_DATABASE_URL:binding.databaseUrl,QUANTUS_V3_FIREBASE_PROJECT_ID:binding.projectId,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:binding.projectId,client_email:role+'@shadow-invalid.iam.gserviceaccount.com',private_key:'SYNTHETIC'})};
 const envRead=n=>env[n],resolved=resolveShadowBinding({config,envRead});
 f.store.forceWrite(d=>{d.automation.shadowIsolation=shadowIsolationMarker(resolved);return d;});
 const core=isolateShadowCorePort({config,envRead,corePort:availablePort('core',f.core)}).impl;
 casMutate(f.store,d=>checkpointRunSection(d,{runKey:RUN,sectionId:'section-1',checkpointId:'cp-test',continuationId:'cont-test',reason:'test',cursor:{},now:T,verifiedScope:f.scope}));
 const approved={schemaVersion:1,bindingHash:resolved.hash,...tasks,approvedAtMs:T-1000,expiresAtMs:T+60000};
 env.QUANTUS_V4_COMMISSIONING_TASKS_JSON=JSON.stringify(approved);
 const options={config,core,clock:f.clock,envRead},permission=createCommissioningTasksPermission(options),sends=[];let tokens=0;
 const transport=createCloudTasksHttpTransport({commissioningPermission:permission,accessTokenSource:{async get(){tokens++;await onToken?.(f);return 'synthetic-token';}},fetchImpl:async(url,init)=>{sends.push({url,init});return Response.json(status===409?{error:{status:'ALREADY_EXISTS'}}:{name:'synthetic-task'},{status});}});
 f.onRead(onRead?()=>onRead(f):null);
 const port=createCloudTasksPort({transport:transport.transport});
 const args={...tasks,runKey:RUN,continuationId:'cont-test',taskId:continuationTaskId(RUN,'cont-test'),scheduleAtMs:T};
 return {...f,options,approved,env,permission,transport,port,args,sends,get tokens(){return tokens;}};
}

test('worker and monitor enqueue the real durable checkpoint through narrow permission without live gates',async()=>{
 for(const role of ['worker','monitor']){
  const f=await fixture({role}),before=f.store.snapshot();assert.equal(f.transport.ok,true);
  assert.equal((await f.port.impl.enqueueContinuation(f.args)).enqueued,true);
  assert.equal(f.sends.length,1);assert.deepEqual(f.store.snapshot(),before);assert.equal(f.options.config.mode,'shadow');
  assert.equal(f.options.config.allowExternalEffects,undefined);
 }
});

test('duplicate task acknowledgement stays explicit and keeps the durable intent pending',async()=>{
 const f=await fixture({status:409}),r=await f.port.impl.enqueueContinuation(f.args);
 assert.equal(r.duplicate,true);assert.equal(r.enqueued,false);assert.equal(f.store.snapshot().automation.runtime.continuationsById['cont-test'].state,'pending');
});

test('forged capability, missing approval, wrong binding, productive queue or caller never grants transport',async()=>{
 const f=await fixture();
 assert.equal(createCloudTasksHttpTransport({commissioningPermission:{...f.permission},accessTokenSource:{get:async()=>''}}).ok,false);
 for(const patch of [{bindingHash:'f'.repeat(64)},{queue:f.approved.queue.replace('shadow-invalid','source-invalid')},{oidcServiceAccount:'tasks@source-invalid.iam.gserviceaccount.com'},{expiresAtMs:T},{extra:true}]){
  f.env.QUANTUS_V4_COMMISSIONING_TASKS_JSON=JSON.stringify({...f.approved,...patch});assert.equal(createCommissioningTasksPermission(f.options),null);
 }
 delete f.env.QUANTUS_V4_COMMISSIONING_TASKS_JSON;assert.equal(createCommissioningTasksPermission(f.options),null);
 assert.equal(f.sends.length,0);
});

test('changed destination, identity, body, schedule or task name is rejected before access token acquisition',async()=>{
 for(const patch of [{targetUrl:'https://productive.invalid/v3/run/continue'},{oidcServiceAccount:'other@shadow-invalid.iam.gserviceaccount.com'},
  {queue:'projects/shadow-invalid/locations/europe-west1/queues/other'},{taskId:'different'},{continuationId:'missing'},
  {runKey:RUN.replace('quantus:','foreign:')},{scheduleAtMs:T-1},{scheduleAtMs:T+60000}]){
  const f=await fixture();await assert.rejects(f.port.impl.enqueueContinuation({...f.args,...patch}));assert.equal(f.tokens,0);assert.equal(f.sends.length,0);
 }
});

test('consumed or lost intent, missing marker and expiration after credential await prevent enqueue',async()=>{
 for(const onToken of [f=>f.setNow(T+60000),f=>f.store.forceWrite(d=>{delete d.automation.shadowIsolation;return d;}),
  f=>f.store.forceWrite(d=>{d.automation.runtime.continuationsById['cont-test'].state='consumed';return d;}),
  f=>f.store.forceWrite(d=>{delete d.automation.runtime.continuationsById['cont-test'];return d;})]){
  const f=await fixture({onToken});await assert.rejects(f.port.impl.enqueueContinuation(f.args));assert.equal(f.tokens,1);assert.equal(f.sends.length,0);
 }
});

test('monitor catch-up may start a missing run only from its persisted slot-catchup intent',async()=>{
 const f=await fixture({role:'monitor'});
 const plan=buildMonitorPlan(projectMonitorView(f.store.snapshot()),{now:T,tenant:'quantus',policyVersion:'4.0',startLocalDate:'2026-10-02'});
 const intent=plan.intents.find(i=>i.kind==='slot_catchup');assert.ok(intent);
 casMutate(f.store,d=>applyMonitorPlan(d,{plan,now:T}));
 const args={...f.args,runKey:intent.runKey,continuationId:intent.id,taskId:continuationTaskId(intent.runKey,intent.id)};
 assert.equal(f.store.snapshot().automation.runtime.runsByKey[intent.runKey],undefined);
 assert.equal((await f.port.impl.enqueueContinuation(args)).enqueued,true);
 f.store.forceWrite(d=>{delete d.automation.runtime.continuationsById[intent.id].source;return d;});
 await assert.rejects(f.port.impl.enqueueContinuation(args));assert.equal(f.sends.length,1);
});

test('expiration during final awaited core read cannot reach network',async()=>{
 let reads=0;
 const f=await fixture({onRead:f=>{if(++reads===2)f.setNow(T+60000);}});
 await assert.rejects(f.port.impl.enqueueContinuation(f.args));assert.equal(f.tokens,1);assert.equal(f.sends.length,0);
});
