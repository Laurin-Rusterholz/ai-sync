import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createCommissioningService,unavailableCommissioningService} from '../runtime/quantus-v3/src/commissioning-composition.mjs';
import {commissioningProfileHash} from '../runtime/quantus-v3/src/commissioning-ingress.mjs';
import {loadV4LeadershipInstructions} from '../runtime/quantus-v3/src/v4-leadership-loop.mjs';
import {leadershipToolDefinitions} from '../runtime/quantus-v3/src/leadership-gateway.mjs';
import {createNodeRequestListener} from '../runtime/quantus-v3/src/http.mjs';
import {availablePort} from '../runtime/quantus-v3/src/ports.mjs';
import {setup,T} from './fixtures/quantus-v4-leadership-fixture.mjs';
import {casMutate} from './quantus-v3-runtime-cas-harness.mjs';
import {releaseLease} from '../netlify/lib/quantus-v3-runtime-state.mjs';
import {reserveCommissioningWithMonthlyCap} from '../runtime/quantus-v3/src/monthly-cost-cap.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
const run='shadow:2026-10-02:process09:4.0',key=F.createSigningKey();
async function fixture(){
 const f=await setup();let sends=0,body;
 const {instructions}=await loadV4LeadershipInstructions({slot:'process09',promptVersion:'4.0.0'});
 const profile={instructions,tools:leadershipToolDefinitions()};
 const authority={schemaVersion:1,audience:'https://broker.invalid/v4/commissioning/respond',serviceAccount:'worker@shadow-invalid.iam.gserviceaccount.com',sourceProjectId:'source-invalid',sourceTenant:'quantus',shadowProjectId:'shadow-invalid',shadowTenant:'shadow',bindingHash:'a'.repeat(64),allocationId:'a-test',model:'test-model',profiles:{lead:commissioningProfileHash(profile)},allowedRuns:[run,'shadow:2026-10-02:close23:4.0'],maxStepIndex:10};
 const policy={schema:'quantus-v3-cost-policy/1',version:'test-only',currency:'USD',approval:{approvedBy:'test-operator',approvalRef:'test-only-approval',approvedAtMs:T-1000},effectiveFromMs:T-1000,effectiveUntilMs:T+86400000,dayLimitMicros:50000000,runLimitMicros:50000000,callLimitMicros:10000000,unresolvedBlockMicros:10000000,featureFlags:{providers:'live'},models:{'openai:test-model':{inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:1000000,maxCallMicros:10000000}}};
 const env={QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON:JSON.stringify(authority),QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON:JSON.stringify({lead:'process09'}),QUANTUS_V4_PROMPT_VERSION:'4.0.0',QUANTUS_V4_OPENAI_API_KEY:'NEVER-REAL-SECRET',QUANTUS_V4_OPENAI_MODEL:'test-model',QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK:'1000000',QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK:'1000000',QUANTUS_V4_ARTIFACT_BUCKET:'quantus-test-artifacts',QUANTUS_V3_COST_POLICY_JSON:JSON.stringify(policy),FIREBASE_PROJECT_ID:'source-invalid',FIREBASE_DATABASE_URL:'https://source-invalid.firebaseio.com',FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'source-invalid',client_email:'broker@source-invalid.iam.gserviceaccount.com',private_key:'SYNTHETIC'})};
 casMutate(f.store,d=>reserveCommissioningWithMonthlyCap(d,{now:T,verifiedScope:f.scope,policy,authorization:{schemaVersion:1,allocationId:'a-test',bindingHash:'a'.repeat(64),month:'2026-10',maxMicros:10000000,approvedBy:'test-operator',approvalRef:'test-only-approval',approvedAtMs:T-1000,expiresAtMs:T+86400000}}));
 casMutate(f.store,d=>releaseLease(d,{...f.scope,now:T}));
 const dependencies={clock:f.clock,jwks:F.jwksPort(key),createCore:async()=>availablePort('core',f.core),createTokens:async()=>({ok:true,get:async()=>'synthetic-token'}),artifactFetch:f.artifacts.fetchImpl,providerFetch:async(url,init)=>{sends++;body=JSON.parse(init.body);return new Response(JSON.stringify({id:'response-test',status:'completed',usage:{input_tokens:50,output_tokens:10},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'retained'}]}]}),{status:200});}};
 const make=()=>createCommissioningService({envRead:n=>env[n],dependencies});
 const request=(over={})=>({method:'POST',path:'/v4/commissioning/respond',headers:{'x-forwarded-proto':'https','content-type':'application/json',authorization:'Bearer '+F.schedulerToken(key,{audience:authority.audience,email:authority.serviceAccount,nowMs:T})},bodyText:JSON.stringify({runKey:run,sectionId:'lead',stepIndex:0,inputJson:JSON.stringify([{role:'user',content:'isolated input'}]),...over})});
 return {...f,env,dependencies,profile,make,request,get sends(){return sends;},get body(){return body;}};
}
test('dedicated composition authenticates, uses reviewed profiles, persists and replays over real HTTP',async t=>{
 const f=await fixture(),before=f.store.snapshot(),app=await f.make();assert.deepEqual(f.store.snapshot(),before);assert.equal(f.sends,0);assert.equal(f.artifacts.calls.length,0);
 const server=createServer(createNodeRequestListener(app,{maxBytes:512*1024}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port+'/v4/commissioning/respond',req=f.request();
 const unauth=await fetch(url,{method:'POST',headers:{'x-forwarded-proto':'https'},body:req.bodyText});assert.equal(unauth.status,401);assert.equal(f.sends,0);
 const call=()=>fetch(url,{method:'POST',headers:req.headers,body:req.bodyText});
 const first=await call(),a=await first.json();assert.equal(first.status,200,JSON.stringify(a));assert.equal(a.response.result.text,'retained');
 assert.equal(f.body.instructions,f.profile.instructions);assert.equal(f.body.tools.length,f.profile.tools.length);assert.equal(f.sends,1);
 const replay=await call();assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);assert.equal(f.sends,1);
 assert.deepEqual(f.store.snapshot().automation.runtime.runsByKey,before.automation.runtime.runsByKey);
 assert.equal(f.store.snapshot().automation.activeLease,null);
});
test('wrong slot cannot acquire source leadership or spend',async()=>{
 const f=await fixture(),app=await f.make(),before=f.store.snapshot();
 const r=await app.handle(f.request({runKey:'shadow:2026-10-02:close23:4.0'}));assert.equal(r.status,409);assert.match(r.body,/commissioning_profile_slot_mismatch/);
 assert.deepEqual(f.store.snapshot(),before);assert.equal(f.sends,0);
});
test('configuration errors and unreviewed prompt hashes cannot activate a broker',async()=>{
 for(const change of [e=>delete e.QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON,e=>e.QUANTUS_V4_PROMPT_VERSION='fake',e=>e.QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON='{"lead":"close23"}',e=>e.QUANTUS_V4_OPENAI_MODEL='different',e=>e.FIREBASE_PROJECT_ID='shadow-invalid',e=>e.FIREBASE_OAUTH_REFRESH_TOKEN='NEVER-REAL-SECRET',e=>e.QUANTUS_V4_ARTIFACT_BUCKET='invalid/bucket',e=>e.QUANTUS_V4_OPENAI_COMPACT_THRESHOLD='nan']){
  const f=await fixture(),before=f.store.snapshot();change(f.env);await assert.rejects(f.make);assert.equal(f.sends,0);assert.deepEqual(f.store.snapshot(),before);
 }
});
test('fresh policy withdrawal and fixture policy stay blocked in production composition',async()=>{
 for(const policy of [undefined,JSON.stringify({fixture:true})]){
  const f=await fixture(),app=await f.make();f.env.QUANTUS_V3_COST_POLICY_JSON=policy;
  const r=await app.handle(f.request());assert.notEqual(r.status,200);assert.equal(f.sends,0);assert.equal(f.store.snapshot().automation.activeLease,null);
 }
});
test('deployed source account pins the credential identity used for both CAS and artifacts',async()=>{
 const f=await fixture();
 f.env.QUANTUS_V4_COMMISSIONING_SOURCE_SERVICE_ACCOUNT='broker@source-invalid.iam.gserviceaccount.com';
 await f.make();
 const before=f.store.snapshot();
 for(const value of ['', 'different@source-invalid.iam.gserviceaccount.com', 'broker@shadow-invalid.iam.gserviceaccount.com']){
  f.env.QUANTUS_V4_COMMISSIONING_SOURCE_SERVICE_ACCOUNT=value;
  await assert.rejects(f.make,{error:'commissioning_source_mismatch'});
  assert.deepEqual(f.store.snapshot(),before);assert.equal(f.sends,0);assert.equal(f.artifacts.calls.length,0);
 }
});
test('unconfigured service and standalone startup never reveal invalid configuration values',async()=>{
 const r=await unavailableCommissioningService().handle({});assert.equal(r.status,503);assert.equal(r.body,'{"error":"commissioning_not_configured"}');
 const child=spawnSync(process.execPath,['runtime/quantus-v3/src/commissioning-server.mjs'],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,PORT:'invalid',QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON:'NEVER-REAL-SECRET'},encoding:'utf8',timeout:10000});
 assert.notEqual(child.status,0);assert.match(child.stderr,/commissioning_not_configured/);assert.doesNotMatch(child.stderr+child.stdout,/NEVER-REAL-SECRET/);
});
