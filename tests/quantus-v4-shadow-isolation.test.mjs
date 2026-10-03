import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveShadowBinding,shadowIsolationMarker,isolateShadowCorePort,isIsolatedShadowCore} from '../runtime/quantus-v3/src/shadow-isolation.mjs';
import {createIntegrationCorePort} from '../runtime/quantus-v3/src/integration-ports.mjs';
import {createOpenAIWorkerPorts} from '../runtime/quantus-v3/src/openai-composition.mjs';
import * as idem from '../netlify/lib/quantus-v3-idempotency.mjs';
import {migrateCore} from '../netlify/lib/assistant-migration.mjs';
const binding={schemaVersion:1,sourceProjectId:'quantus-source-test',sourceTenant:'source',sourceC2Origin:'https://source.invalid',projectId:'quantus-shadow-test',tenant:'shadow',c2Origin:'https://shadow.invalid',databaseUrl:'https://quantus-shadow-test-default-rtdb.europe-west1.firebasedatabase.app',ref:'synthetic-isolation-test-only'};
function fixture(){
  const config={mode:'shadow',role:'worker',tenant:'shadow',c2BaseUrl:binding.c2Origin,tasks:{queue:'projects/'+binding.projectId+'/locations/europe-west1/queues/shadow'}};
  const env={QUANTUS_V4_SHADOW_BINDING:JSON.stringify(binding),FIREBASE_PROJECT_ID:binding.projectId,FIREBASE_DATABASE_URL:binding.databaseUrl,QUANTUS_V3_FIREBASE_PROJECT_ID:binding.projectId,
    FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:binding.projectId,client_email:'worker@'+binding.projectId+'.iam.gserviceaccount.com',private_key:'synthetic-never-used'})};
  return {config,env,envRead:n=>env[n]};
}
test('shadow binding requires separate project, tenant, canonical origins, explicit database and matching credentials',()=>{
  const f=fixture(),b=resolveShadowBinding(f);assert.ok(b);assert.equal(Object.isFrozen(b),true);assert.equal(b.hash.length,64);
  for(const change of [{sourceProjectId:binding.projectId},{sourceTenant:binding.tenant},{sourceC2Origin:binding.c2Origin},{c2Origin:binding.c2Origin+':443'}, {databaseUrl:binding.databaseUrl+'/root'}, {ref:''},{extra:'not allowed'}]){
    const x=fixture();x.env.QUANTUS_V4_SHADOW_BINDING=JSON.stringify({...binding,...change});assert.equal(resolveShadowBinding(x),null,JSON.stringify(change));
  }
  for(const [key,value] of [['FIREBASE_DATABASE_URL',''],['FIREBASE_PROJECT_ID',binding.sourceProjectId],['FIREBASE_OAUTH_REFRESH_TOKEN','do-not-use'],['QUANTUS_V3_FIREBASE_PROJECT_ID',binding.sourceProjectId],['FIREBASE_SERVICE_ACCOUNT_JSON','{}']]){
    const x=fixture();x.env[key]=value;assert.equal(resolveShadowBinding(x),null,key);
  }
  const x=fixture();x.config.tasks.queue='projects/'+binding.sourceProjectId+'/locations/europe-west1/queues/live';assert.equal(resolveShadowBinding(x),null);
  x.config.mode='live';assert.equal(resolveShadowBinding(x),null);
});
test('unbound shadow composition cannot bootstrap or construct a provider',async()=>{
  let read=0,write=0,provider=0;
  const f=fixture(),ports=await createOpenAIWorkerPorts({...f,corePort:{async read(){read++;},async mutate(){write++;}},clockPort:{now:()=>Date.now()},providerFetch:async()=>provider++});
  assert.equal(ports.sectionWork.available,false);assert.equal(ports.sectionWork.reason,'shadow_isolation_not_configured');
  assert.deepEqual([read,write,provider],[0,0,0]);
});
test('dry-run OpenAI path cannot create daily runs, start notes or call external providers',async()=>{
  let read=0,write=0,provider=0;
  const ports=await createOpenAIWorkerPorts({config:{mode:'dry_run'},corePort:{async read(){read++;},async mutate(){write++;}},clockPort:{now:()=>Date.now()},envRead:()=>undefined,providerFetch:async()=>provider++});
  assert.equal(ports.sectionWork.available,true);const result=await ports.sectionWork.impl.next({});assert.equal(result.blocked,true);assert.equal(result.reason,'external_effects_not_allowed');
  assert.deepEqual([read,write,provider],[0,0,0]);
});
test('isolated core checks durable marker on reads, before replay and inside every real CAS mutation',async()=>{
  const f=fixture(),b=resolveShadowBinding(f),source=migrateCore({entities:{tasks:{real:{id:'real',title:'Untouched production original',status:'todo'}}}},{now:Date.parse('2026-10-03T09:00:00Z')}).data;
  const sourceBefore=structuredClone(source);let shadow={...structuredClone(source),automation:{...source.automation,shadowIsolation:shadowIsolationMarker(b)}};
  let calls=0,changeBeforeMutator=false;
  const admin={async readAppDataDocument(){return {data:JSON.stringify(shadow),etag:'synthetic'}},async mutateAppData(key,mutator){
    calls++;const candidate=structuredClone(shadow);if(changeBeforeMutator)delete candidate.automation.shadowIsolation;
    const result=mutator(candidate);shadow=result.data;return result;
  }};
  const core=await createIntegrationCorePort({tenantId:'shadow',principalId:'shadow-worker',loadModules:async()=>({admin,idem})});
  const isolated=isolateShadowCorePort({...f,corePort:core});assert.equal(isolated.available,true);assert.equal(isIsolatedShadowCore(isolated.impl),true);assert.equal(isIsolatedShadowCore(core.impl),false);
  assert.deepEqual((await isolated.impl.read()).data.entities,source.entities);
  const args={commandKey:'shadow-step',requestId:'r1',now:Date.parse('2026-10-03T10:00:00Z'),mutate(data){data.entities.tasks.real.title='Shadow result';return {data,result:{changed:true}}}};
  const first=await isolated.impl.mutate(args);assert.equal(first.result.changed,true);assert.equal(shadow.entities.tasks.real.title,'Shadow result');assert.deepEqual(source,sourceBefore);
  const replay=await isolated.impl.mutate(args);assert.equal(replay.replayed,true);
  const before=structuredClone(shadow);changeBeforeMutator=true;
  await assert.rejects(isolated.impl.mutate({...args,commandKey:'second'}),e=>e.error==='shadow_isolation_mismatch');assert.deepEqual(shadow,before);changeBeforeMutator=false;
  await assert.rejects(isolated.impl.mutate({...args,commandKey:'third',mutate(data){delete data.automation.shadowIsolation;return {data,result:{}}}}),e=>e.error==='shadow_isolation_mismatch');assert.deepEqual(shadow,before);
  delete shadow.automation.shadowIsolation;const count=calls;
  await assert.rejects(isolated.impl.read(),e=>e.error==='shadow_isolation_mismatch');
  await assert.rejects(isolated.impl.mutate(args),e=>e.error==='shadow_isolation_mismatch');assert.equal(calls,count,'replay cannot skip the durable binding');
});
