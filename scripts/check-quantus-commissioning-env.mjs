/** Verify actual offline Terraform-rendered container environments against the
 * runtime constructors. All secret values below are synthetic test fixtures.
 * No cloud, metadata, credential, source or provider request is permitted. */
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {resolveRuntimeConfig} from '../runtime/quantus-v3/src/config.mjs';
import {createOpenAIWorkerPorts} from '../runtime/quantus-v3/src/openai-composition.mjs';
import {createCommissioningTasksPermission} from '../runtime/quantus-v3/src/commissioning-tasks.mjs';
import {resolveShadowBinding,shadowIsolationMarker,isolateShadowCorePort} from '../runtime/quantus-v3/src/shadow-isolation.mjs';
import {availablePort} from '../runtime/quantus-v3/src/ports.mjs';
import {POLICY_TEMPLATE} from '../netlify/lib/assistant-schema.mjs';
import {makeEnv} from '../tests/fixtures/quantus-v3-auth-fixtures.mjs';
import {setup,T} from '../tests/fixtures/quantus-v4-leadership-fixture.mjs';

// Verbose Terraform includes large provider schemas. Retain only the selected
// render's resources, final verdict and diagnostics rather than every state.
let summary,resources;const diagnostics=[];
for await(const line of createInterface({input:createReadStream(process.argv[2]),crlfDelay:Infinity})){
 if(!/"type"\s*:\s*"(?:test_summary|diagnostic)"/.test(line)
   && !(/"type"\s*:\s*"test_state"/.test(line)&&/"@testrun"\s*:\s*"commissioned_shadow_runtime"/.test(line)))continue;
 const event=JSON.parse(line);
 if(event.type==='test_summary')summary=event.test_summary;
 if(event.type==='diagnostic')diagnostics.push(event.diagnostic);
 if(event.type==='test_state'&&event['@testrun']==='commissioned_shadow_runtime')resources=event.test_state.root_module.resources;
}
if(summary?.status!=='pass')for(const diagnostic of diagnostics)console.error(diagnostic.summary,diagnostic.detail);
assert.equal(summary?.status,'pass',JSON.stringify(summary));
assert.ok(resources,'missing actual commissioned Terraform test state');
const services=resources.filter(r=>r.type==='google_cloud_run_v2_service');
assert.equal(services.length,3);
const never=()=>{throw Error('offline environment verification attempted external work');};

for(const service of services){
 const role=service.name,container=service.values.template[0].containers[0];
 const entries=container.env,env=Object.fromEntries(entries.filter(e=>!e.value_source?.length).map(e=>[e.name,e.value]));
 assert.equal(new Set(entries.map(e=>e.name)).size,entries.length,'duplicate runtime environment name');
 const auth=makeEnv({tenant:env.QUANTUS_V3_TENANT});
 const policy={...POLICY_TEMPLATE,tenant:env.QUANTUS_V3_TENANT,version:env.QUANTUS_V3_POLICY_VERSION,
  requiredSources:[{id:'quantus-core',kind:'quantus-core'}],noExternalSources:true};
 const synthetic={
  FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:env.FIREBASE_PROJECT_ID,
   client_email:service.values.template[0].service_account,private_key:randomBytes(32).toString('hex')}),
  QUANTUS_V3_TAGESBRIEFING_POLICY_JSON:JSON.stringify(policy),
  QUANTUS_V3_TOOL_CREDENTIAL_SCHEDULER:auth.secrets.service.scheduler,
  QUANTUS_V3_COST_POLICY_JSON:JSON.stringify({version:'synthetic-only',effectiveUntilMs:T+86400000}),
  QUANTUS_V3_WORKER_TOKEN_KEYS:auth.vars.QUANTUS_V3_WORKER_TOKEN_KEYS,
  QUANTUS_V3_SERVICE_CREDENTIALS:auth.vars.QUANTUS_V3_SERVICE_CREDENTIALS,
 };
 assert.ok(!entries.some(e=>e.name==='QUANTUS_V4_OPENAI_API_KEY'),'provider credential exposed to isolated runtime');
 for(const entry of entries.filter(e=>e.value_source?.length)){
  assert.ok(Object.hasOwn(synthetic,entry.name),'unexpected secret mapping');env[entry.name]=synthetic[entry.name];
 }
 const envRead=name=>env[name],resolved=resolveRuntimeConfig(envRead);
 assert.equal(resolved.ok,true,JSON.stringify(resolved.body));
 assert.equal(resolved.config.mode,'shadow');assert.equal(resolved.config.allowExternalEffects,false);
 assert.equal(resolved.config.gatesComplete,false);
 const f=await setup(),binding=resolveShadowBinding({config:resolved.config,envRead});assert.ok(binding,'rendered isolation mismatch');
 f.store.forceWrite(d=>{d.automation.shadowIsolation=shadowIsolationMarker(binding);return d;});
 const core=isolateShadowCorePort({config:resolved.config,envRead,corePort:availablePort('core',f.core)});
 assert.equal(core.available,true);
 const permission=createCommissioningTasksPermission({config:resolved.config,core:core.impl,clock:f.clock,envRead});
 assert.equal(Boolean(permission),role!=='watchdog','rendered task permission does not match role/runtime');
 if(role==='worker'){
  const ports=await createOpenAIWorkerPorts({config:resolved.config,corePort:core,clockPort:f.clock,envRead,
   artifactStore:f.artifacts.store,jobTokenIssuer:{available:true,mint:never},c2Transport:{send:never},
   providerFetch:never,commissioningFetch:never,identityFetch:never,gmailFetch:never});
  assert.equal(ports.sectionWork.available,true,ports.sectionWork.reason);
 }else assert.equal(env.QUANTUS_V4_COMMISSIONING_WORKER_JSON,undefined);
}
console.log('Actual Terraform shadow environments accepted by runtime; no provider key or external work.');
