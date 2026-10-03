import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../netlify/lib/quantus-v3-runtime-state.mjs';
import {reserveCommissioningWithMonthlyCap as hold, reserveCostWithMonthlyCap as call, monthToDateMicros} from '../runtime/quantus-v3/src/monthly-cost-cap.mjs';
import {createCasStore,casMutate,casRace,baseCore} from './quantus-v3-runtime-cas-harness.mjs';
const now=Date.parse('2026-09-19T08:00:00Z');
function setup(time=now){
 const store=createCasStore(baseCore());
 const {fence}=casMutate(store,d=>S.acquireLease(d,{holder:'r',scope:'quantus:mainrun',now:time})).result;
 const input={now:time,verifiedScope:{holder:'r',scope:'quantus:mainrun',fence},__allowFixturePolicy:true,policy:{
  schema:'quantus-v3-cost-policy/1',version:'synthetic-1',fixture:true,currency:'USD',
  approval:{approvedBy:'test-fixture',approvalRef:'SYNTHETIC-NOT-A-REAL-APPROVAL',approvedAtMs:time-3600000},
  effectiveFromMs:time-3600000,effectiveUntilMs:time+86400000,
  dayLimitMicros:1000000000,runLimitMicros:1000000000,callLimitMicros:20000000,unresolvedBlockMicros:1000000000,
  featureFlags:{providers:'live'},models:{'synthetic:model':{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:0,maxCallMicros:20000000}}
 }};
 return {store,input};
}
function grant(id='shadow-1',maxMicros=10000000,time=now){return {schemaVersion:1,allocationId:id,bindingHash:'a'.repeat(64),month:'2026-09',maxMicros,approvedBy:'test-fixture',approvalRef:'SYNTHETIC-NOT-A-REAL-APPROVAL',approvedAtMs:time-1000,expiresAtMs:time+86400000};}
const allocation=(input,a)=>d=>hold(d,{...input,authorization:a});
const provider=(input,id,tokens)=>d=>call(d,{...input,callId:id,runKey:'quantus:2026-09-19:process09:3.0',provider:'synthetic',model:'model',contentHash:'hash-'+id.padEnd(20,'x'),inputTokens:tokens,outputTokens:0},{capMicros:50000000});

test('shared ledger holds exact cap, denies both kinds of new obligations, retains user data',()=>{
 const {store,input}=setup(),before=store.snapshot();
 assert.equal(casMutate(store,provider(input,'live',10000000)).result.ok,true);
 const first=casMutate(store,allocation(input,grant('shadow',40000000)));
 assert.equal(first.result.ok,true);assert.equal(first.result.dispatchAllowed,false);
 assert.deepEqual(monthToDateMicros(first.data,now),{month:'2026-09',totalMicros:50000000,openMicros:50000000,settledMicros:0});
 for(const mutate of [provider(input,'overflow',1),allocation(input,grant('overflow',1))]){
  const snapshot=store.snapshot(),out=casMutate(store,mutate);
  assert.equal(out.result.code,'monthly_budget_exceeded');assert.equal(out.wrote,false);assert.deepEqual(store.snapshot(),snapshot);
 }
 for(const key of ['entities','journal','_deleteLog','einUnbekanntesFeld'])assert.deepEqual(first.data[key],before[key]);
 assert.equal(Object.keys(first.data.automation.runtime.cost.callsById).length,1);
});
for(const opponent of ['provider','allocation'])test(`real CAS conflict: ${opponent} retries against global holds`,()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant('seed',49990000)));
 const race=casRace(store,allocation(input,grant('a',5000)),opponent==='provider'?provider(input,'b',8000):allocation(input,grant('b',8000)));
 assert.equal(race.a.wrote,true);assert.equal(race.b.conflict,true);assert.equal(race.retryB.result.code,'monthly_budget_exceeded');
 assert.equal(race.retryB.wrote,false);assert.equal(monthToDateMicros(race.finalData,now).totalMicros,49995000);
});
test('lost receipt replays without a second hold; changed immutable approval conflicts',()=>{
 const {store,input}=setup(),auth=grant();casMutate(store,allocation(input,auth));const before=store.snapshot();
 const replay=casMutate(store,allocation(input,auth));assert.equal(replay.wrote,false);assert.equal(replay.result.duplicate,true);assert.equal(replay.result.dispatchAllowed,false);
 for(const change of [{maxMicros:1},{bindingHash:'b'.repeat(64)},{approvalRef:'different'},{expiresAtMs:auth.expiresAtMs+1}]){
  assert.equal(casMutate(store,allocation(input,{...auth,...change})).result.code,'commissioning_allocation_conflict');
 }
 assert.deepEqual(store.snapshot(),before);
});
test('expiry never releases the hold; Zurich month boundary retains historical obligations',()=>{
 const time=Date.parse('2026-09-30T21:59:59Z'),{store,input}=setup(time),auth=grant('month',50000000,time);
 casMutate(store,allocation(input,auth));
 assert.equal(monthToDateMicros(store.snapshot(),time).totalMicros,50000000);
 assert.equal(monthToDateMicros(store.snapshot(),time+1000).totalMicros,0);
 assert.throws(()=>hold(store.snapshot(),{...input,now:time+1000,authorization:grant('late',1,time)}),{code:'commissioning_month_mismatch'});
 assert.throws(()=>hold(store.snapshot(),{...input,now:auth.expiresAtMs,authorization:auth}),{code:'commissioning_authorization_expired'});
 assert.equal(monthToDateMicros(store.snapshot(),time).totalMicros,50000000);
 assert.equal(store.snapshot().automation.runtime.cost.commissioningAllocationsById.month.state,'held');
});
test('malformed holds fail closed for both monthly reads and normal provider reservations',()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant()));
 const changes=[r=>r.state='released',r=>r.authorization.maxMicros=-1,r=>r.authorization.month='2026-10',r=>r.extra=true,r=>r.authorization.extra=true,r=>r.authorization.bindingHash='invalid',r=>r.reservedAtMs=r.authorization.expiresAtMs];
 for(const change of changes){
  const data=store.snapshot();change(data.automation.runtime.cost.commissioningAllocationsById['shadow-1']);
  assert.throws(()=>monthToDateMicros(data,now),{code:'commissioning_allocation_ledger_invalid'});
  assert.throws(()=>provider(input,'new',1)(data),{code:'commissioning_allocation_ledger_invalid'});
 }
});
test('hold requires current leadership and policy; never behaves as a dispatchable or releasable call',()=>{
 const {store,input}=setup();
 assert.throws(()=>hold(store.snapshot(),{...input,verifiedScope:{...input.verifiedScope,fence:input.verifiedScope.fence+1},authorization:grant()}));
 assert.throws(()=>hold(store.snapshot(),{...input,__allowFixturePolicy:false,authorization:grant()}),{code:'cost_policy_invalid'});
 assert.throws(()=>hold(store.snapshot(),{...input,policy:{...input.policy,effectiveUntilMs:now},authorization:grant()}),{code:'cost_policy_invalid'});
 casMutate(store,allocation(input,grant()));const before=store.snapshot();
 for(const fn of [S.claimCostDispatch,S.releaseCostReservation]){
  try{const out=fn(before,{...input,callId:'shadow-1',claimId:'claim',evidence:{kind:'not_dispatched',ref:'test'}});assert.equal(out.result.ok,false);}catch(error){assert.match(error.code,/cost_call/);}
 }
 assert.deepEqual(store.snapshot(),before);
});
test('unresolved real provider obligations block a new commissioning hold',()=>{
 const {store,input}=setup();casMutate(store,provider(input,'unknown',100));
 casMutate(store,d=>S.claimCostDispatch(d,{...input,callId:'unknown',claimId:'claim'}));
 casMutate(store,d=>S.markCostOutcomeUnknown(d,{...input,callId:'unknown',reason:'timeout'}));
 const out=casMutate(store,allocation({...input,policy:{...input.policy,unresolvedBlockMicros:0}},grant()));
 assert.equal(out.result.code,'unresolved_cost_blocking');assert.equal(out.wrote,false);
});

test('invalid policy currency or approval metadata cannot poison the ledger',()=>{
 const {store,input}=setup(),before=store.snapshot();
 for(const patch of [{currency:'EUR'},{approval:{...input.policy.approval,approvedAtMs:now+1}},{approval:{...input.policy.approval,approvalRef:' '}},{approval:{...input.policy.approval,approvalRef:'x'.repeat(501)}}]){
  assert.throws(()=>hold(before,{...input,policy:{...input.policy,...patch},authorization:grant()}),{code:'commissioning_policy_invalid'});
 }
 assert.deepEqual(store.snapshot(),before);
});

const childBinding = operationId => ({allocationId:'shadow-1',bindingHash:'a'.repeat(64),operationId});
const childCall = (input,id,tokens,operationId=id) => provider({...input,commissioning:childBinding(operationId)},id,tokens);
const childClaim = (input,id,operationId=id) => d => S.claimCostDispatch(d,{...input,callId:id,claimId:'claim-'+id,commissioning:childBinding(operationId)});

test('child reservations use the hold once while real day/run/call limits still apply',()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant('shadow-1',40000000)));casMutate(store,provider(input,'live',10000000));
 assert.equal(casMutate(store,childCall(input,'child',1000000)).result.ok,true);
 assert.equal(monthToDateMicros(store.snapshot(),now).totalMicros,50000000);
 assert.equal(casMutate(store,provider(input,'extra-live',1)).result.code,'monthly_budget_exceeded');
 const limited={...input,policy:{...input.policy,dayLimitMicros:11000000,runLimitMicros:11000000,callLimitMicros:10000000}};
 assert.equal(casMutate(store,childCall(limited,'excess-day',1)).result.code,'day_budget_exceeded');
 casMutate(store,childClaim(input,'child'));
 casMutate(store,d=>S.settleCost(d,{...input,callId:'child',actualMicros:300000,usageReceiptId:'child-receipt',providerRequestId:'child-provider'}));
 assert.deepEqual(monthToDateMicros(store.snapshot(),now),{month:'2026-09',totalMicros:50000000,settledMicros:300000,openMicros:49700000});
});
test('concurrent child commitments cannot exceed their allocation inside the real CAS',()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant('shadow-1',10000)));
 const race=casRace(store,childCall(input,'child-a',6000),childCall(input,'child-b',6000));
 assert.equal(race.a.wrote,true);assert.equal(race.b.conflict,true);assert.equal(race.retryB.result.code,'commissioning_budget_exceeded');
 assert.equal(race.retryB.wrote,false);assert.equal(monthToDateMicros(race.finalData,now).totalMicros,10000);
});
test('global operation identity rejects changed ids and binding; lost replies never allow a second dispatch',()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant()));
 const original=childCall(input,'original',1000,'stable-operation');
 casMutate(store,original);
 assert.equal(casMutate(store,original).wrote,false);
 assert.equal(casMutate(store,childCall(input,'different-id',1000,'stable-operation')).result.code,'commissioning_operation_conflict');
 assert.equal(casMutate(store,provider(input,'original',1000)).result.code,'commissioning_binding_conflict');
 assert.equal(casMutate(store,d=>S.claimCostDispatch(d,{...input,callId:'original',claimId:'unbound'})).result.code,'commissioning_binding_conflict');
 const claim=childClaim(input,'original','stable-operation');assert.equal(casMutate(store,claim).result.dispatchAllowed,true);
 assert.equal(casMutate(store,claim).result.code,'dispatch_already_claimed');
 assert.equal(casMutate(store,original).result.dispatchAllowed,false);
 casMutate(store,d=>S.markCostOutcomeUnknown(d,{...input,callId:'original',reason:'lost_reply'}));
 assert.equal(casMutate(store,childCall(input,'restored-child-id',1000,'stable-operation')).result.code,'commissioning_operation_conflict');
 assert.equal(monthToDateMicros(store.snapshot(),now).totalMicros,10000000);
});
test('released child cannot recycle its operation or commitment; settled excess remains globally visible',()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant('shadow-1',1000)));
 casMutate(store,childCall(input,'released',400));
 casMutate(store,d=>S.releaseCostReservation(d,{...input,callId:'released',evidence:{kind:'not_dispatched',ref:'test'}}));
 assert.equal(casMutate(store,childCall(input,'new',601)).result.code,'commissioning_budget_exceeded');
 assert.equal(casMutate(store,childCall(input,'reused-op',1,'released')).result.code,'commissioning_operation_conflict');
 casMutate(store,childCall(input,'settled',600));casMutate(store,childClaim(input,'settled'));
 casMutate(store,d=>S.settleCost(d,{...input,callId:'settled',actualMicros:700,usageReceiptId:'overrun-receipt',providerRequestId:'overrun-provider'}));
 assert.deepEqual(monthToDateMicros(store.snapshot(),now),{month:'2026-09',totalMicros:1100,settledMicros:700,openMicros:400});
 assert.equal(casMutate(store,provider(input,'after-overrun',1)).result.code,'cost_overrun_blocks_reservation');
});
test('expiry after reservation blocks a fresh child dispatch without erasing the obligation',()=>{
 const {store,input}=setup();const auth={...grant(),expiresAtMs:now+100};
 casMutate(store,allocation(input,auth));casMutate(store,childCall(input,'expires',1000));
 assert.throws(()=>childClaim({...input,now:now+100},'expires')(store.snapshot()),{code:'commissioning_authorization_expired'});
 assert.equal(monthToDateMicros(store.snapshot(),now+100).totalMicros,10000000);
 assert.equal(store.snapshot().automation.runtime.cost.callsById.expires.dispatch.claimed,false);
});
test('foreign or tampered child links never reduce the global obligation',()=>{
 const {store,input}=setup();casMutate(store,allocation(input,grant()));casMutate(store,childCall(input,'child',1000));
 for(const patch of [{allocationId:'missing'},{bindingHash:'b'.repeat(64)},{operationId:null},{extra:'x'}]){
  const data=store.snapshot();Object.assign(data.automation.runtime.cost.callsById.child.commissioning,patch);
  assert.throws(()=>monthToDateMicros(data,now),{code:'commissioning_call_ledger_invalid'});
 }
 const data=store.snapshot();data.automation.runtime.cost.commissioningAllocationsById['shadow-1'].authorization.maxMicros=999;
 assert.throws(()=>monthToDateMicros(data,now),{code:'commissioning_call_ledger_invalid'});
});

import * as F from './quantus-v3-e2-fixtures.mjs';
import {createCostAdapter} from '../runtime/quantus-v3/src/cost-adapter.mjs';
import {createPortRegistry,availablePort} from '../runtime/quantus-v3/src/ports.mjs';
function adapterSetup({expiresAtMs=now+86400000,delayRead=false,mode='live'}={}) {
 const {store,input}=setup();casMutate(store,allocation(input,{...grant(),expiresAtMs}));
 const core=F.createCorePort(store),clock=F.createClock(now);
 let readCount=0;
 const wrapped=availablePort('core',{
  read:async()=>{const out=await core.port.impl.read();if(delayRead&&++readCount===4)clock.set(expiresAtMs);return out;},
  mutate:args=>core.port.impl.mutate(args)
 });
 const ports=createPortRegistry('worker',{core:wrapped,clock:clock.port,costPolicy:availablePort('costPolicy',{load:async()=>input.policy})});
 const config=F.configFor('worker',{QUANTUS_V3_RUNTIME_MODE:mode,QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS:'true',QUANTUS_V3_ACTIVATION_GATES:F.allGatesPassed(),QUANTUS_V3_REQUIRED_SOURCES:JSON.stringify(['gmail-inbox'])});
 const adapter=createCostAdapter({ports,config,now,requestId:'req-child',verifiedScope:input.verifiedScope},{__allowFixturePolicy:true,monthlyCap:{capMicros:50000000}});
 return {adapter,store};
}
const adapterReserve = adapter => adapter.reserve({callId:'adapter-child',runKey:'quantus:2026-09-19:process09:3.0',provider:'synthetic',model:'model',contentHash:'hash-adapter-child-0000',inputTokens:1000,outputTokens:0,commissioning:childBinding('adapter-operation')});
test('real cost adapter carries binding through reservation, dispatch, settlement and receipt replay',async()=>{
 const {adapter,store}=adapterSetup();let sends=0;
 await adapterReserve(adapter);
 const request={callId:'adapter-child',claimId:'adapter-claim',commissioning:childBinding('adapter-operation'),send:async()=>{sends++;return {outcome:'settled',actualMicros:700,usageReceiptId:'adapter-receipt'};}};
 await adapter.claimAndDispatch(request);
 assert.equal(sends,1);assert.equal(store.snapshot().automation.runtime.cost.callsById['adapter-child'].state,'settled');
 await assert.rejects(()=>adapter.claimAndDispatch(request));assert.equal(sends,1);
 assert.equal(monthToDateMicros(store.snapshot(),now).totalMicros,10000000);
});
test('approval expiring during final awaited source read prevents the actual send',async()=>{
 const {adapter}=adapterSetup({expiresAtMs:now+100,delayRead:true});let sends=0;
 await adapterReserve(adapter);
 await assert.rejects(()=>adapter.claimAndDispatch({callId:'adapter-child',claimId:'expire-claim',commissioning:childBinding('adapter-operation'),send:async()=>{sends++;return {outcome:'unknown'};}}),e=>e.detail?.code==='commissioning_authorization_expired');
 assert.equal(sends,0);
});
test('allocation support does not bypass the shadow activation gate',async()=>{
 const {adapter}=adapterSetup({mode:'shadow'});
 await assert.rejects(()=>adapterReserve(adapter),e=>e.code==='external_effects_not_allowed'||e.error==='external_effects_not_allowed');
});
