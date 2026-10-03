/** Dedicated source broker wiring. No ordinary runtime flags are modified,
 * no allocation is created, and no remote work occurs merely at startup. */
import {createIntegrationCorePort} from './integration-ports.mjs';
import {bindCommissioningSourcePort} from './commissioning-source.mjs';
import {createCommissioningIngress} from './commissioning-ingress.mjs';
import {createCommissioningBroker} from './commissioning-broker.mjs';
import {createOpenAITransport} from './openai-transport.mjs';
import {createWorkArtifactStore} from './work-artifact-store.mjs';
import {createGoogleAccessTokenSource,createGoogleJwksPort} from './google-transport.mjs';
import {createEnvCostPolicyPort} from './cost-policy-port.mjs';
import {availablePort,createPortRegistry} from './ports.mjs';
import {loadV4LeadershipInstructions} from './v4-leadership-loop.mjs';
import {leadershipToolDefinitions} from './leadership-gateway.mjs';
import {parseSlotRunKey} from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import {JOURNAL_LIMITS} from './runtime-payload.mjs';
import {HttpError} from './errors.mjs';
const fail=code=>{throw new HttpError(503,code);};
const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
const json=(read,key)=>{try{const v=JSON.parse(read(key));if(!record(v))throw Error();return v;}catch{fail('commissioning_configuration_invalid');}};

export async function createCommissioningService({envRead=name=>process.env[name],logger=null,
  dependencies={}}={}) {
  // Dependency substitution is a constructor seam, never an HTTP/env option.
  const authority=json(envRead,'QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON');
  const slots=json(envRead,'QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON');
  const promptVersion=envRead('QUANTUS_V4_PROMPT_VERSION');
  if(!record(authority.profiles)||Object.keys(slots).length!==Object.keys(authority.profiles).length
    ||Object.keys(slots).some(k=>!Object.hasOwn(authority.profiles,k)))fail('commissioning_profile_mismatch');
  const profiles={};
  for(const [section,slot]of Object.entries(slots)){
    const {instructions}=await loadV4LeadershipInstructions({slot,promptVersion});
    profiles[section]={instructions,tools:leadershipToolDefinitions()};
  }
  const apiKey=envRead('QUANTUS_V4_OPENAI_API_KEY'),model=envRead('QUANTUS_V4_OPENAI_MODEL');
  const rates=['QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK','QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK'].map(envRead);
  if(typeof apiKey!=='string'||!apiKey.trim()||model!==authority.model
    ||rates.some(v=>typeof v!=='string'||!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))))fail('commissioning_provider_not_configured');
  const compact=envRead('QUANTUS_V4_OPENAI_COMPACT_THRESHOLD');
  if(compact!==undefined&&(typeof compact!=='string'||!/^\d+$/.test(compact)))fail('commissioning_provider_not_configured');
  const transport=createOpenAITransport({apiKey,model,fetchImpl:dependencies.providerFetch,
    modelPricing:{inputMicrosPerMillionTokens:Number(rates[0]),outputMicrosPerMillionTokens:Number(rates[1])},
    compactionThreshold:compact===undefined?null:Number(compact)});
  const source=bindCommissioningSourcePort({authority,envRead,corePort:await (dependencies.createCore??createIntegrationCorePort)({
    tenantId:authority.sourceTenant,principalId:'quantus-v4-commissioning',savedBy:'quantus-v4-commissioning'})});
  const tokens=await (dependencies.createTokens??createGoogleAccessTokenSource)({});
  if(!tokens?.ok||typeof tokens.get!=='function')fail('commissioning_artifact_credentials_missing');
  const bucket=envRead('QUANTUS_V4_ARTIFACT_BUCKET');
  const artifacts=createWorkArtifactStore({bucket,tenant:authority.sourceTenant,getAccessToken:tokens.get,
    fetchImpl:dependencies.artifactFetch,maxPayloadBytes:JOURNAL_LIMITS.responseBytes});
  const clock=dependencies.clock??{now:()=>Date.now()};
  const ports=createPortRegistry('worker',{core:source,clock:availablePort('clock',clock),
    jwks:dependencies.jwks??createGoogleJwksPort({}),costPolicy:createEnvCostPolicyPort(envRead)});
  const broker=createCommissioningBroker({ports,transport,artifacts,artifactBucket:bucket});
  // Ingress snapshots and validates every authority/profile field. Profile slot
  // binding is also checked before any source lease or cost mutation.
  return createCommissioningIngress({authority,profiles,transport,ports,logger,execute:args=>{
    if(parseSlotRunKey(args.operation.runKey).slot!==slots[args.operation.sectionId])
      throw new HttpError(409,'commissioning_profile_slot_mismatch');
    return broker.execute(args);
  }});
}

export function unavailableCommissioningService(){
  return Object.freeze({async handle(){return {status:503,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'},
    body:JSON.stringify({error:'commissioning_not_configured'})};}});
}
