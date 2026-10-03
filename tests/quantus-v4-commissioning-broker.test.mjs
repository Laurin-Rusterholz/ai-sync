import test from 'node:test';
import assert from 'node:assert/strict';
import {setup as sourceSetup,T,RUN} from './fixtures/quantus-v4-leadership-fixture.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
import {casMutate} from './quantus-v3-runtime-cas-harness.mjs';
import * as S from '../netlify/lib/quantus-v3-runtime-state.mjs';
import {createCommissioningBroker} from '../runtime/quantus-v3/src/commissioning-broker.mjs';
import {createCommissioningIngress,commissioningProfileHash} from '../runtime/quantus-v3/src/commissioning-ingress.mjs';
import {bindCommissioningSourcePort} from '../runtime/quantus-v3/src/commissioning-source.mjs';
import {createOpenAITransport} from '../runtime/quantus-v3/src/openai-transport.mjs';
import {createCostAdapter,createCommissioningCostAdapter} from '../runtime/quantus-v3/src/cost-adapter.mjs';
import {reserveCommissioningWithMonthlyCap,monthToDateMicros} from '../runtime/quantus-v3/src/monthly-cost-cap.mjs';
import {createPortRegistry,availablePort} from '../runtime/quantus-v3/src/ports.mjs';
const key=F.createSigningKey(),run='shadow:2026-10-02:process09:4.0';
const profile={instructions:'Reviewed source instructions',tools:[{name:'quantus_context',description:'read scoped context',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}]};
function policy(){return {schema:'quantus-v3-cost-policy/1',version:'synthetic',fixture:true,currency:'USD',approval:{approvedBy:'fixture',approvalRef:'SYNTHETIC',approvedAtMs:T-1000},effectiveFromMs:T-1000,effectiveUntilMs:T+86400000,dayLimitMicros:50000000,runLimitMicros:50000000,callLimitMicros:10000000,unresolvedBlockMicros:10000000,featureFlags:{providers:'live'},models:{'openai:test-model':{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000,maxCallMicros:10000000}}};}
async function setup(options={}){
 const s=await sourceSetup(),operations=[],wire=[];let sends=0;
 const authority={schemaVersion:1,audience:'https://broker.invalid/v4/commissioning/respond',serviceAccount:'worker@shadow-invalid.iam.gserviceaccount.com',sourceProjectId:'source-invalid',sourceTenant:'quantus',shadowProjectId:'shadow-invalid',shadowTenant:'shadow',bindingHash:'a'.repeat(64),allocationId:'allocation-test',model:'test-model',profiles:{lead:commissioningProfileHash(profile)},allowedRuns:[run],maxStepIndex:10};
 const values={FIREBASE_PROJECT_ID:'source-invalid',FIREBASE_DATABASE_URL:'https://source-invalid.firebaseio.com',FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'source-invalid',client_email:'broker@source-invalid.iam.gserviceaccount.com',private_key:'SYNTHETIC'})};
 const source=bindCommissioningSourcePort({corePort:availablePort('core',s.core),authority,envRead:n=>values[n]});
 casMutate(s.store,d=>reserveCommissioningWithMonthlyCap(d,{now:T,verifiedScope:s.scope,policy:policy(),__allowFixturePolicy:true,authorization:{schemaVersion:1,allocationId:'allocation-test',bindingHash:'a'.repeat(64),month:'2026-10',maxMicros:10000000,approvedBy:'fixture',approvalRef:'SYNTHETIC',approvedAtMs:T-1000,expiresAtMs:options.expiresAtMs??T+86400000}}));
 if(!options.keepProductiveLease)casMutate(s.store,d=>S.releaseLease(d,{...s.scope,now:T}));
 const transport=createOpenAITransport({apiKey:'SYNTHETIC',model:'test-model',modelPricing:{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000},maxOutputTokens:100,fetchImpl:async(url,init)=>{
  sends++;wire.push(JSON.parse(init.body));await options.beforeProvider?.(s);
  if(options.unknown)return new Response('unconfirmed',{status:503});
  return new Response(JSON.stringify({id:'response-'+sends,status:'completed',usage:{input_tokens:50,output_tokens:10},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'durable answer'}]}]}),{status:200,headers:{'content-type':'application/json','x-request-id':'provider-'+sends}});
 }});
 const ports=createPortRegistry('worker',{core:source,clock:availablePort('clock',s.clock),jwks:F.jwksPort(key),costPolicy:availablePort('costPolicy',{load:async()=>options.policy??policy()})});
 const broker=createCommissioningBroker({ports,transport,artifacts:s.artifacts.store,artifactBucket:'quantus-test-artifacts',__allowFixturePolicy:!options.disallowFixture});
 const makeRouter=()=>createCommissioningIngress({authority,profiles:{lead:profile},transport,ports,execute:async args=>{operations.push(args.operation);return broker.execute(args);}});
 let router=makeRouter();
 const request=async(over={})=>{const response=await router.handle({method:'POST',path:'/v4/commissioning/respond',headers:{'x-forwarded-proto':'https','content-type':'application/json',authorization:'Bearer '+F.schedulerToken(key,{audience:authority.audience,email:authority.serviceAccount,nowMs:s.clock.now()})},bodyText:JSON.stringify({runKey:run,sectionId:'lead',stepIndex:0,inputJson:JSON.stringify([{role:'user',content:'context'}]),...over})});return {...response,json:JSON.parse(response.body)};};
 return {...s,source,ports,transport,broker,operations,wire,request,get sends(){return sends;},newIngress(){router=makeRouter();}};
}
test('complete authenticated broker persists before settlement, releases source lease and replays without another model call',async()=>{
 const s=await setup(),before=s.store.snapshot().automation.runtime.runsByKey;let sawDurableBeforeSettle=false;
 const mutate=s.core.mutate;s.core.mutate=async args=>{if(args.commandKey.startsWith('cost-settle:'))sawDurableBeforeSettle=Object.values(s.store.snapshot().automation.runtime.cost.callsById).some(c=>c.commissioningResponseRecorded);return mutate(args);};
 const first=await s.request();assert.equal(first.status,200,first.body);assert.equal(first.json.outcome,'settled');assert.equal(first.json.response.result.text,'durable answer');assert.equal(first.json.replayed,false);
 assert.equal(sawDurableBeforeSettle,true);assert.equal(s.sends,1);assert.equal(s.wire[0].instructions,profile.instructions);
 assert.equal(s.store.snapshot().automation.activeLease,null);assert.deepEqual(s.store.snapshot().automation.runtime.runsByKey,before);assert.ok(before[RUN]);
 s.newIngress();const replay=await s.request();assert.equal(replay.status,200,replay.body);assert.equal(replay.json.replayed,true);assert.equal(s.sends,1);
 assert.equal(monthToDateMicros(s.store.snapshot(),T).totalMicros,10000000);
 const changed=await s.request({inputJson:JSON.stringify([{role:'user',content:'changed'}])});assert.equal(changed.status,409);assert.equal(s.sends,1);
});
test('an unexpired productive source lease wins and is never stolen',async()=>{
 const s=await setup({keepProductiveLease:true}),lease=s.store.snapshot().automation.activeLease;
 const r=await s.request();assert.equal(r.status,409,r.body);assert.equal(r.json.error,'commissioning_source_busy');assert.equal(s.sends,0);assert.deepEqual(s.store.snapshot().automation.activeLease,lease);
});
test('concurrent delivery cannot dispatch the same operation twice',async()=>{
 let signalStarted,finish;const started=new Promise(r=>signalStarted=r),wait=new Promise(r=>finish=r);
 const s=await setup({beforeProvider:async()=>{signalStarted();await wait;}});
 const first=s.request();await started;const second=await s.request();assert.equal(second.status,409);assert.equal(s.sends,1);
 finish();assert.equal((await first).status,200);assert.equal((await s.request()).status,200);assert.equal(s.sends,1);
});
for(const point of ['commission-acquire-','commission-response-','cost-settle:','commission-release-'])test('lost acknowledgement at '+point+' recovers without duplicate dispatch',async()=>{
 const s=await setup();const mutate=s.core.mutate;let lost=false;
 s.core.mutate=async args=>{const out=await mutate(args);if(!lost&&args.commandKey.startsWith(point)){lost=true;throw Error('lost acknowledgement');}return out;};
 const r=await s.request();assert.equal(r.status,200,r.body);assert.equal(lost,true);assert.equal(s.sends,1);assert.equal(s.store.snapshot().automation.activeLease,null);
 assert.equal((await s.request()).status,200);assert.equal(s.sends,1);
 assert.equal(Object.values(s.store.snapshot().automation.runtime.cost.callsById)[0].state,'settled');
});
test('provider outcome unknown is retained and never blindly resent',async()=>{
 const s=await setup({unknown:true});const r=await s.request();assert.equal(r.status,200,r.body);assert.equal(r.json.outcome,'unknown');assert.equal(r.json.dispatchAllowed,false);
 assert.equal((await s.request()).json.outcome,'unknown');assert.equal(s.sends,1);assert.equal(s.store.snapshot().automation.activeLease,null);
 assert.equal(Object.values(s.store.snapshot().automation.runtime.cost.callsById)[0].state,'unknown');
});
test('missing response persistence produces an unresolved operation instead of a second paid call',async()=>{
 const s=await setup({beforeProvider:s=>s.artifacts.setPrivate(false)});assert.equal((await s.request()).status,502);
 s.artifacts.setPrivate(true);const next=await s.request();assert.equal(next.status,409,next.body);assert.equal(next.json.error,'commissioning_outcome_unresolved');assert.equal(s.sends,1);
});
test('late result and fresh retry after allocation expiry recover the existing operation only',async()=>{
 const s=await setup({expiresAtMs:T+500,beforeProvider:s=>s.setNow(T+1000)});
 const first=await s.request();assert.equal(first.status,200,first.body);assert.equal((await s.request()).status,200);assert.equal(s.sends,1);
 assert.equal((await s.request({stepIndex:1})).status,409);assert.equal(s.sends,1);
});
test('expired source authority cannot persist a late result and retry cannot resend it',async()=>{
 const s=await setup({beforeProvider:s=>s.setNow(T+121000)});
 assert.notEqual((await s.request()).status,200);assert.equal(s.sends,1);assert.equal(s.store.snapshot().automation.activeLease,null);
 const retry=await s.request();assert.equal(retry.status,409);assert.equal(retry.json.error,'commissioning_outcome_unresolved');assert.equal(s.sends,1);
});
test('a fenced broker never releases a replacement source holder',async()=>{
 const s=await setup({beforeProvider:s=>{s.setNow(T+121000);casMutate(s.store,d=>S.acquireLease(d,{holder:'replacement',scope:'quantus:mainrun',now:s.clock.now()}));}});
 assert.notEqual((await s.request()).status,200);assert.equal(s.store.snapshot().automation.activeLease.holder,'replacement');assert.equal(s.sends,1);
});
test('missing real cost policy never obtains a provider call despite valid admission',async()=>{
 const s=await setup({disallowFixture:true});const r=await s.request();assert.equal(r.status,503);assert.equal(s.sends,0);assert.equal(s.store.snapshot().automation.activeLease,null);
});
test('normal gates and forged admission cannot be used as commissioning authority',async()=>{
 const s=await setup();const fake={callId:'fake',runKey:run,provider:'openai',model:'test-model',prepared:{contentHash:'a'.repeat(64),inputTokens:1,outputTokens:1},commissioning:{allocationId:'allocation-test',bindingHash:'a'.repeat(64),operationId:'fake'}};
 const ctx={ports:s.ports,config:{mode:'commissioning'},now:T,requestId:'fake',verifiedScope:s.scope};
 await assert.rejects(()=>createCostAdapter(ctx,{commissioningOperation:fake}).reserve({...fake,...fake.prepared}),e=>e.error==='external_effects_not_allowed');
 await assert.rejects(()=>createCommissioningCostAdapter(ctx,{operation:fake}).reserve({...fake,...fake.prepared}),e=>e.error==='commissioning_capability_invalid');
 assert.throws(()=>createCommissioningCostAdapter({...ctx,config:{mode:'shadow'}},{operation:fake}),e=>e.error==='commissioning_adapter_not_configured');
 assert.equal(s.sends,0);
});
test('an admitted prepared request cannot be redirected to another provider instance',async()=>{
 const s=await setup();assert.equal((await s.request()).status,200);const before=s.store.snapshot();
 const other={...s.transport,dispatch:async()=>{throw Error('must not execute');}};
 const broker=createCommissioningBroker({ports:s.ports,transport:other,artifacts:s.artifacts.store,artifactBucket:'quantus-test-artifacts'});
 await assert.rejects(()=>broker.execute({operation:s.operations[0]}),e=>e.error==='commissioning_transport_mismatch');assert.deepEqual(s.store.snapshot(),before);
});
test('artifact storage preflight blocks payment and permits safe retry before any dispatch claim',async()=>{
 const s=await setup();s.artifacts.setPrivate(false);const first=await s.request();assert.equal(first.status,503,first.body);assert.equal(s.sends,0);
 assert.equal(Object.values(s.store.snapshot().automation.runtime.cost.callsById)[0].dispatch.claimed,false);
 s.artifacts.setPrivate(true);assert.equal((await s.request()).status,200);assert.equal(s.sends,1);
});
for(const phase of ['cost-reserve:','cost-claim:'])test('source lease expiry during '+phase+' CAS retry cannot write a late reservation/claim',async()=>{
 const s=await setup(),mutate=s.core.mutate;let entered=false;
 s.core.mutate=async args=>{
  if(args.commandKey.startsWith(phase)){
   entered=true;s.onMutation(attempt=>{if(attempt===0)s.store.forceWrite(d=>d);else s.setNow(T+121000);});
   try{return await mutate(args);}finally{s.onMutation(null);}
  }
  return mutate(args);
 };
 const r=await s.request();assert.notEqual(r.status,200);assert.equal(entered,true);assert.equal(s.sends,0);
 const calls=Object.values(s.store.snapshot().automation.runtime.cost.callsById);
 if(phase==='cost-reserve:')assert.equal(calls.length,0);else assert.equal(calls[0].dispatch.claimed,false);
});
test('a delayed valid claim uses its committed timestamp and still dispatches once',async()=>{
 const s=await setup(),mutate=s.core.mutate;
 s.core.mutate=async args=>{if(args.commandKey.startsWith('cost-claim:'))s.setNow(T+10);return mutate(args);};
 const r=await s.request();assert.equal(r.status,200,r.body);assert.equal(s.sends,1);
 assert.equal(Object.values(s.store.snapshot().automation.runtime.cost.callsById)[0].dispatch.claimedAtMs,T+10);
});


test('recovery-only admission never creates or dispatches a missing source operation',async()=>{
 const s=await setup(),before=s.store.snapshot();const missing=await s.request({recoveryOnly:true});
 assert.equal(missing.status,409);assert.match(missing.body,/commissioning_recovery_missing/);assert.equal(s.sends,0);assert.deepEqual(s.store.snapshot(),before);
 assert.equal((await s.request()).status,200);const recovered=await s.request({recoveryOnly:true});assert.equal(recovered.status,200);assert.equal(recovered.json.replayed,true);assert.equal(s.sends,1);
 assert.equal((await s.request({recoveryOnly:false})).status,400);
});
