import test from 'node:test';
import assert from 'node:assert/strict';
import {setup as leadershipSetup,T,RUN} from './fixtures/quantus-v4-leadership-fixture.mjs';
import {createCommissioningResponseJournal} from '../runtime/quantus-v3/src/commissioning-response-journal.mjs';
import {createCommissioningIngress,commissioningProfileHash,assertCommissioningOperation} from '../runtime/quantus-v3/src/commissioning-ingress.mjs';
import {bindCommissioningSourcePort} from '../runtime/quantus-v3/src/commissioning-source.mjs';
import {createOpenAITransport} from '../runtime/quantus-v3/src/openai-transport.mjs';
import {createPortRegistry,availablePort} from '../runtime/quantus-v3/src/ports.mjs';
import {reserveCommissioningWithMonthlyCap,monthToDateMicros} from '../runtime/quantus-v3/src/monthly-cost-cap.mjs';
import {casMutate} from './quantus-v3-runtime-cas-harness.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
import * as S from '../netlify/lib/quantus-v3-runtime-state.mjs';
const key=F.createSigningKey(),shadowRun='shadow:2026-10-02:process09:4.0';
const profile={instructions:'Trusted fixture',tools:[{name:'quantus_context',description:'read',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}]};
const RESPONSE={outcome:'settled',actualMicros:23,usageReceiptId:'response-fixture',providerRequestId:'provider-fixture',result:{usable:true,text:'original answer',toolCalls:[]}};
function policy(){return {schema:'quantus-v3-cost-policy/1',version:'synthetic',fixture:true,currency:'USD',approval:{approvedBy:'fixture',approvalRef:'SYNTHETIC',approvedAtMs:T-1000},effectiveFromMs:T-1000,effectiveUntilMs:T+86400000,dayLimitMicros:50000000,runLimitMicros:50000000,callLimitMicros:10000000,unresolvedBlockMicros:10000000,featureFlags:{providers:'live'},models:{'openai:test-model':{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000,maxCallMicros:10000000}}};}
async function setup({claim=true,expiresAtMs=T+10000}={}){
 const s=await leadershipSetup();
 const authority={schemaVersion:1,audience:'https://broker.invalid/v4/commissioning/respond',serviceAccount:'worker@shadow-invalid.iam.gserviceaccount.com',sourceProjectId:'source-invalid',sourceTenant:'quantus',shadowProjectId:'shadow-invalid',shadowTenant:'shadow',bindingHash:'a'.repeat(64),allocationId:'allocation-test',model:'test-model',profiles:{lead:commissioningProfileHash(profile)},allowedRuns:[shadowRun],maxStepIndex:10};
 const env={FIREBASE_PROJECT_ID:'source-invalid',FIREBASE_DATABASE_URL:'https://source-invalid.firebaseio.com',FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'source-invalid',client_email:'broker@source-invalid.iam.gserviceaccount.com',private_key:'SYNTHETIC'})};
 const source=bindCommissioningSourcePort({corePort:availablePort('core',s.core),authority,envRead:n=>env[n]});
 casMutate(s.store,d=>reserveCommissioningWithMonthlyCap(d,{now:T,verifiedScope:s.scope,policy:policy(),__allowFixturePolicy:true,authorization:{schemaVersion:1,allocationId:'allocation-test',bindingHash:'a'.repeat(64),month:'2026-10',maxMicros:10000000,approvedBy:'fixture',approvalRef:'SYNTHETIC',approvedAtMs:T-1000,expiresAtMs}}));
 const transport=createOpenAITransport({apiKey:'SYNTHETIC',model:'test-model',modelPricing:{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000},maxOutputTokens:100,fetchImpl:()=>{throw Error('must never dispatch');}});
 const ports=createPortRegistry('worker',{core:source,clock:availablePort('clock',s.clock),jwks:F.jwksPort(key)});
 let operation;
 const router=createCommissioningIngress({authority,profiles:{lead:profile},transport,ports,execute:async({operation:op})=>{operation=op;return {admitted:true};}});
 const request=async()=>router.handle({method:'POST',path:'/v4/commissioning/respond',headers:{'x-forwarded-proto':'https','content-type':'application/json',authorization:'Bearer '+F.schedulerToken(key,{audience:authority.audience,email:authority.serviceAccount,nowMs:s.clock.now(),ttlS:1})},bodyText:JSON.stringify({runKey:shadowRun,sectionId:'lead',stepIndex:0,inputJson:JSON.stringify([{role:'user',content:'test'}])})});
 assert.equal((await request()).status,200);
 const input={...operation,...operation.prepared,now:T,verifiedScope:s.scope,policy:policy(),__allowFixturePolicy:true};
 casMutate(s.store,d=>S.reserveCost(d,input));
 if(claim)casMutate(s.store,d=>S.claimCostDispatch(d,{...input,claimId:'claim-test'}));
 const make=(over={})=>createCommissioningResponseJournal({operation,core:source.impl,clock:s.clock,verifiedScope:s.scope,artifacts:s.artifacts.store,artifactBucket:'quantus-test-artifacts',...over});
 return {...s,source,request,get operation(){return operation;},make,journal:make(),input};
}
test('actual CAS/idempotency and private artifact store persist immutable response without touching productive runs',async()=>{
 const s=await setup(),before=s.store.snapshot().automation.runtime.runsByKey;
 assert.equal(await s.journal.read(),null);assert.deepEqual(await s.journal.record(RESPONSE),RESPONSE);
 assert.deepEqual(await s.make().read(),RESPONSE);const puts=s.store.stats.puts;
 await s.make().record(RESPONSE);assert.equal(s.store.stats.puts,puts);
 assert.deepEqual(s.store.snapshot().automation.runtime.runsByKey,before);assert.ok(before[RUN]);assert.equal(before[shadowRun],undefined);
 assert.equal(s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].state,'reserved');
 await s.make().settle();assert.equal(s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].state,'settled');
 assert.equal(monthToDateMicros(s.store.snapshot(),T).totalMicros,10000000);
});
test('conflicting response never overwrites original even with a new receipt key',async()=>{
 const s=await setup();await s.journal.record(RESPONSE);
 await assert.rejects(()=>s.journal.record({...RESPONSE,actualMicros:24}),/commissioning_response_conflict/);
 assert.deepEqual(await s.make().read(),RESPONSE);
});
test('response can be recorded after original token/allocation expiry, but never creates fresh dispatch permission',async()=>{
 const s=await setup({expiresAtMs:T+500});s.setNow(T+2000);
 await s.journal.record(RESPONSE);await s.journal.settle();
 assert.throws(()=>assertCommissioningOperation(s.operation,{data:s.store.snapshot(),now:s.clock.now(),core:s.source.impl}));
 assert.equal((await s.request()).status,200,'fresh authenticated retry may recover the claimed expired operation');
 assert.deepEqual(await s.make().read(),RESPONSE);
});
test('unclaimed reservation cannot acquire a response or recovery admission after expiry',async()=>{
 const s=await setup({claim:false,expiresAtMs:T+500});
 await assert.rejects(()=>s.journal.record(RESPONSE),/commissioning_receipt_binding_invalid/);
 s.setNow(T+2000);assert.equal((await s.request()).status,409);
});
test('expired/replaced source lease blocks fresh writes and already recorded reads',async()=>{
 for(const replace of [false,true]){const s=await setup();await s.journal.record(RESPONSE);
  if(replace)s.store.forceWrite(d=>{d.automation.activeLease.holder='other';return d;});else s.setNow(T+121000);
  await assert.rejects(()=>s.make().read(),/lease_/);await assert.rejects(()=>s.make().record(RESPONSE),/lease_/);
 }
});
test('unknown cost is reconciled exclusively from the stored provider receipt',async()=>{
 const s=await setup();await s.journal.record(RESPONSE);
 casMutate(s.store,d=>S.markCostOutcomeUnknown(d,{callId:s.operation.callId,reason:'lost-reply',now:T,verifiedScope:s.scope}));
 await s.make().settle();await s.make().settle();
 const call=s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId];assert.equal(call.state,'settled');assert.equal(call.settledMicros,23);
});
test('lost core acknowledgement recovers recorded response without duplicating it',async()=>{
 const s=await setup();const original=s.core.mutate;let lose=true;
 s.core.mutate=async args=>{const out=await original(args);if(lose&&args.commandKey.startsWith('commission-response-')){lose=false;throw Error('lost acknowledgement');}return out;};
 await assert.rejects(()=>s.journal.record(RESPONSE),/lost acknowledgement/);
 assert.deepEqual(await s.make().read(),RESPONSE);await s.make().record(RESPONSE);await s.make().settle();
});
test('real CAS retry preserves a competing user edit and rechecks the lease',async()=>{
 const s=await setup();s.onMutation(attempt=>{if(attempt===0)s.store.forceWrite(d=>({...d,userEdit:'kept'}));});
 await s.journal.record(RESPONSE);assert.equal(s.store.snapshot().userEdit,'kept');assert.ok(s.store.stats.conflicts>0);
 const stale=await setup();stale.onMutation(attempt=>{if(attempt===0)stale.store.forceWrite(d=>d);else stale.setNow(T+121000);});
 await assert.rejects(()=>stale.journal.record(RESPONSE),/lease_expired/);
 assert.equal(stale.store.snapshot().automation.runtime.cost.callsById[stale.operation.callId].commissioningResponse,undefined);
});
test('failed/private/foreign artifact storage cannot produce an acknowledged pointer',async()=>{
 for(const variant of ['private','foreign','readback']){
  const s=await setup();let journal=s.journal;
  if(variant==='private')s.artifacts.setPrivate(false);
  if(variant==='foreign')journal=s.make({artifactBucket:'foreign-bucket'});
  if(variant==='readback')journal=s.make({artifacts:{put:args=>s.artifacts.store.put(args),read:async()=>'{"different":true}'}});
  await assert.rejects(()=>journal.record(RESPONSE));
  assert.equal(s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].commissioningResponse,undefined);
 }
});
test('removed pointers and corrupted immutable payloads remain visible failures',async()=>{
 const s=await setup();await s.journal.record(RESPONSE);
 const pointer=s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].commissioningResponse;
 s.artifacts.objects.get(pointer.artifact.objectName).text='{}';await assert.rejects(()=>s.make().read(),/artifact_hash_mismatch/);
 s.store.forceWrite(d=>{delete d.automation.runtime.cost.callsById[s.operation.callId].commissioningResponse;return d;});
 assert.throws(()=>S.readRuntime(s.store.snapshot()),/commissioning_call_ledger_invalid/);
});
test('unknown provider outcome remains immutable and cannot be interpreted as a settled receipt',async()=>{
 const s=await setup();await s.journal.record({outcome:'unknown',reason:'timeout'});
 await assert.rejects(()=>s.make().settle(),/commissioning_usage_unconfirmed/);
 await assert.rejects(()=>s.journal.record(RESPONSE),/commissioning_response_conflict/);
 assert.equal(s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].state,'reserved');
});
test('an already settled cost cannot gain a contradictory retained response',async()=>{
 const s=await setup();casMutate(s.store,d=>S.settleCost(d,{callId:s.operation.callId,actualMicros:22,usageReceiptId:'other-receipt',now:T,verifiedScope:s.scope}));
 await assert.rejects(()=>s.journal.record(RESPONSE),/commissioning_response_cost_conflict/);
 assert.equal(s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].commissioningResponse,undefined);
});

import {createCostAdapter} from '../runtime/quantus-v3/src/cost-adapter.mjs';
import {JOURNAL_LIMITS} from '../runtime/quantus-v3/src/runtime-payload.mjs';
test('source capacity for the response pointer is reserved before an additional paid call',async()=>{
 const s=await setup();
 s.store.forceWrite(d=>{d.largeExistingField='x'.repeat(JOURNAL_LIMITS.coreBytes-Buffer.byteLength(JSON.stringify(d))-2000);return d;});
 const ports=createPortRegistry('worker',{core:s.source,clock:availablePort('clock',s.clock),costPolicy:availablePort('costPolicy',{load:async()=>policy()})});
 const config=F.configFor('worker',{QUANTUS_V3_RUNTIME_MODE:'live',QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS:'true',QUANTUS_V3_ACTIVATION_GATES:F.allGatesPassed(),QUANTUS_V3_REQUIRED_SOURCES:JSON.stringify(['gmail-inbox'])});
 const adapter=createCostAdapter({config,ports,verifiedScope:s.scope,now:T,requestId:'capacity-test'},{__allowFixturePolicy:true,monthlyCap:{capMicros:50000000}});
 await assert.rejects(()=>adapter.reserve({...s.operation,...s.operation.prepared,callId:'new-capacity-call',contentHash:'c'.repeat(64),commissioning:{...s.operation.commissioning,operationId:'new-step'}}),e=>e.error==='journal_core_capacity');
 assert.equal(s.store.snapshot().automation.runtime.cost.callsById['new-capacity-call'],undefined);
});
test('a different model contract cannot supply the retained receipt for this admission',async()=>{
 const s=await setup();s.store.forceWrite(d=>{d.automation.runtime.cost.callsById[s.operation.callId].model='different-model';return d;});
 await assert.rejects(()=>s.journal.record(RESPONSE),/commissioning_receipt_binding_invalid/);
});
test('capacity lost after reservation still prevents the dispatch claim',async()=>{
 const s=await setup({claim:false});
 s.store.forceWrite(d=>{d.largeExistingField='x'.repeat(JOURNAL_LIMITS.coreBytes-Buffer.byteLength(JSON.stringify(d))-2000);return d;});
 const ports=createPortRegistry('worker',{core:s.source,clock:availablePort('clock',s.clock),costPolicy:availablePort('costPolicy',{load:async()=>policy()})});
 const config=F.configFor('worker',{QUANTUS_V3_RUNTIME_MODE:'live',QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS:'true',QUANTUS_V3_ACTIVATION_GATES:F.allGatesPassed(),QUANTUS_V3_REQUIRED_SOURCES:JSON.stringify(['gmail-inbox'])});
 const adapter=createCostAdapter({config,ports,verifiedScope:s.scope,now:T,requestId:'capacity-claim'},{__allowFixturePolicy:true});let sends=0;
 await assert.rejects(()=>adapter.claimAndDispatch({callId:s.operation.callId,claimId:'capacity-claim',commissioning:s.operation.commissioning,send:async()=>{sends++;return {outcome:'unknown'};}}),e=>e.error==='journal_core_capacity');
 assert.equal(sends,0);assert.equal(s.store.snapshot().automation.runtime.cost.callsById[s.operation.callId].dispatch.claimed,false);
});
