/** Feed actual offline Terraform service state into the source composition.
 * All credentials, tokens, source data and HTTP replies are synthetic. */
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createCommissioningService} from '../runtime/quantus-v3/src/commissioning-composition.mjs';
import {availablePort} from '../runtime/quantus-v3/src/ports.mjs';
import {reserveCommissioningWithMonthlyCap} from '../runtime/quantus-v3/src/monthly-cost-cap.mjs';
import {releaseLease} from '../netlify/lib/quantus-v3-runtime-state.mjs';
import {setup,T} from '../tests/fixtures/quantus-v4-leadership-fixture.mjs';
import {casMutate} from '../tests/quantus-v3-runtime-cas-harness.mjs';
import * as F from '../tests/quantus-v3-e2-fixtures.mjs';

let summary,resources;const diagnostics=[];
for await(const line of createInterface({input:createReadStream(process.argv[2]),crlfDelay:Infinity})){
 if(!/"type"\s*:\s*"(?:test_summary|diagnostic)"/.test(line)
   && !(/"type"\s*:\s*"test_state"/.test(line)&&/"@testrun"\s*:\s*"render_source_broker"/.test(line)))continue;
 const event=JSON.parse(line);
 if(event.type==='test_summary')summary=event.test_summary;
 if(event.type==='diagnostic')diagnostics.push(event.diagnostic);
 if(event.type==='test_state'&&event['@testrun']==='render_source_broker')resources=event.test_state.root_module.resources;
}
if(summary?.status!=='pass')for(const d of diagnostics)console.error(d.summary,d.detail);
assert.equal(summary?.status,'pass',JSON.stringify(summary));
assert.ok(resources,'missing actual Terraform broker test state');
const services=resources.filter(r=>r.type==='google_cloud_run_v2_service');assert.equal(services.length,1);
const service=services[0].values,container=service.template[0].containers[0];
assert.deepEqual(container.command,['node']);
assert.deepEqual(container.args,['runtime/quantus-v3/src/commissioning-server.mjs']);
const entries=container.env,env=Object.fromEntries(entries.filter(e=>!e.value_source?.length).map(e=>[e.name,e.value]));
assert.equal(new Set(entries.map(e=>e.name)).size,entries.length);
const authority=JSON.parse(env.QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON);
assert.deepEqual(service.custom_audiences,[authority.audience]);
assert.equal(env.QUANTUS_V4_COMMISSIONING_SOURCE_SERVICE_ACCOUNT,service.template[0].service_account);
assert.equal(env.FIREBASE_PROJECT_ID,authority.sourceProjectId);
const invoker=resources.find(r=>r.type==='google_cloud_run_v2_service_iam_binding').values;
assert.deepEqual(invoker.members,['serviceAccount:'+authority.serviceAccount]);
assert.ok(!resources.some(r=>/google_(cloud_tasks|cloud_scheduler|service_account_key|secret_manager_secret_version)/.test(r.type)));
const policy={schema:'quantus-v3-cost-policy/1',version:'test-only',currency:'USD',
 approval:{approvedBy:'test-operator',approvalRef:'test-only-approval',approvedAtMs:T-1000},
 effectiveFromMs:T-1000,effectiveUntilMs:T+86400000,dayLimitMicros:50000000,runLimitMicros:50000000,
 callLimitMicros:10000000,unresolvedBlockMicros:10000000,featureFlags:{providers:'live'},models:{
 ['openai:'+authority.model]:{inputMicrosPerMillionTokens:Number(env.QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK),
 outputMicrosPerMillionTokens:Number(env.QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK),maxCallMicros:10000000}}};
const synthetic={FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:env.FIREBASE_PROJECT_ID,
 client_email:service.template[0].service_account,private_key:'SYNTHETIC-NEVER-USED'}),
 QUANTUS_V4_OPENAI_API_KEY:'SYNTHETIC-NEVER-USED',QUANTUS_V3_COST_POLICY_JSON:JSON.stringify(policy)};
assert.deepEqual(entries.filter(e=>e.value_source?.length).map(e=>e.name).sort(),Object.keys(synthetic).sort());
for(const entry of entries.filter(e=>e.value_source?.length))env[entry.name]=synthetic[entry.name];

const f=await setup(),signing=F.createSigningKey();let sends=0,tokenReads=0;
// No constructor can reach global fetch, credentials, metadata or a real API.
const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('offline broker verification attempted network');};
try{
 const dependencies={clock:f.clock,jwks:F.jwksPort(signing),createCore:async()=>availablePort('core',f.core),
  createTokens:async()=>({ok:true,get:async()=>{tokenReads++;return 'synthetic-token';}}),artifactFetch:f.artifacts.fetchImpl,
  providerFetch:async()=>{sends++;return new Response(JSON.stringify({id:'response-fixture',status:'completed',
   usage:{input_tokens:50,output_tokens:10},output:[{type:'message',role:'assistant',status:'completed',
    content:[{type:'output_text',text:'synthetic retained response'}]}]}),{status:200});}};
 const before=f.store.snapshot();
 const app=await createCommissioningService({envRead:n=>env[n],dependencies});
 assert.deepEqual(f.store.snapshot(),before);assert.equal(sends,0);assert.equal(tokenReads,0);
 const slots=JSON.parse(env.QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON);
 const section=Object.keys(slots).find(k=>slots[k]==='process09');assert.ok(section);
 const request={method:'POST',path:'/v4/commissioning/respond',headers:{'x-forwarded-proto':'https','content-type':'application/json',
  authorization:'Bearer '+F.schedulerToken(signing,{audience:authority.audience,email:authority.serviceAccount,nowMs:T})},
  bodyText:JSON.stringify({runKey:authority.allowedRuns[0],sectionId:section,stepIndex:0,inputJson:'[{"role":"user","content":"synthetic isolated input"}]'})};
 const unauth=await app.handle({...request,headers:{'x-forwarded-proto':'https'}});assert.equal(unauth.status,401);
 const withoutAllocation=await app.handle(request);assert.notEqual(withoutAllocation.status,200);
 assert.equal(sends,0);assert.equal(tokenReads,0);assert.deepEqual(f.store.snapshot(),before);
 casMutate(f.store,d=>reserveCommissioningWithMonthlyCap(d,{now:T,verifiedScope:f.scope,policy,authorization:{
  schemaVersion:1,allocationId:authority.allocationId,bindingHash:authority.bindingHash,month:'2026-10',
  maxMicros:10000000,approvedBy:'test-operator',approvalRef:'test-only-approval',approvedAtMs:T-1000,expiresAtMs:T+86400000}}));
 casMutate(f.store,d=>releaseLease(d,{...f.scope,now:T}));
 const first=await app.handle(request);assert.equal(first.status,200,first.body);
 assert.equal(JSON.parse(first.body).response.result.text,'synthetic retained response');
 const replay=await app.handle(request);assert.equal(replay.status,200,replay.body);
 assert.equal(JSON.parse(replay.body).replayed,true);assert.equal(sends,1);
 assert.equal(f.store.snapshot().automation.activeLease,null);
 const mismatched={...env,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({...JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON),
  client_email:'other@'+authority.sourceProjectId+'.iam.gserviceaccount.com'})};
 await assert.rejects(createCommissioningService({envRead:n=>mismatched[n],dependencies}),{error:'commissioning_source_mismatch'});
 assert.equal(sends,1);
}finally{globalThis.fetch=originalFetch;}
console.log('Actual Terraform broker environment: constructor, denied unallocated call, source-funded synthetic response and single-call replay pass. No real network.');
