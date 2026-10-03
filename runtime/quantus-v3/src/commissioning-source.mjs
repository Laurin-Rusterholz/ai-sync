/** Bind the broker's existing core port to explicitly configured source
 * credentials. Never initialize or copy a core and never accept a shadow core. */
import {availablePort} from './ports.mjs';
import {HttpError} from './errors.mjs';
const identities=new WeakMap();
const fail=()=>{throw new HttpError(503,'commissioning_source_mismatch');};
const check=data=>{if(!data||!data.automation||Object.hasOwn(data.automation,'shadowIsolation'))fail();};
export function commissioningSourceIdentity(core){return identities.get(core)||null;}
export function bindCommissioningSourcePort({corePort,authority,envRead}){
  const project=authority?.sourceProjectId,tenant=authority?.sourceTenant;
  try{
    if(!corePort?.available||typeof corePort.impl?.read!=='function'||typeof corePort.impl?.mutate!=='function'
      ||typeof project!=='string'||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)
      ||typeof tenant!=='string'||!tenant||envRead('FIREBASE_PROJECT_ID')!==project||envRead('FIREBASE_OAUTH_REFRESH_TOKEN'))fail();
    const database=envRead('FIREBASE_DATABASE_URL');
    if(typeof database!=='string'||!new RegExp('^https://(?:'+project+'\\.firebaseio\\.com|'+project+'-default-rtdb(?:\\.[a-z0-9-]+)?\\.firebasedatabase\\.app)$').test(database))fail();
    const credential=JSON.parse(envRead('FIREBASE_SERVICE_ACCOUNT_JSON')||'null');
    if(credential?.type!=='service_account'||credential.project_id!==project
      ||typeof credential.client_email!=='string'||!credential.client_email.endsWith('@'+project+'.iam.gserviceaccount.com')
      ||typeof credential.private_key!=='string'||!credential.private_key.trim())fail();
  }catch{fail();}
  const original=corePort.impl;
  const impl={async read(){const snapshot=await original.read();check(snapshot?.data);return snapshot;},
    async mutate(request){
      check((await original.read())?.data); // check even if the command receipt is replayed
      return original.mutate({...request,mutate:data=>{
        check(data);const out=request.mutate(data);
        if(out&&typeof out.then==='function'){Promise.resolve(out).catch(()=>{});fail();}
        check(out?.data??out);return out;
      }});
    }};
  identities.set(impl,Object.freeze({projectId:project,tenant}));
  return availablePort('core',Object.freeze(impl));
}
