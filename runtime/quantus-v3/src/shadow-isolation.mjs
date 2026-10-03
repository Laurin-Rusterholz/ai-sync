/** A shadow worker must use an explicitly isolated Firebase project, tenant and
 * C2 origin. This establishes storage isolation only; it does not authorize
 * provider spending, external actions or claim any completed trial evidence.
 */
import {createHash} from 'node:crypto';
import {availablePort, unavailablePort} from './ports.mjs';
import {HttpError} from './errors.mjs';
const boundPorts = new WeakMap();
const fields = ['schemaVersion','sourceProjectId','sourceTenant','sourceC2Origin','projectId','tenant','c2Origin','databaseUrl','ref'];
const project = s => typeof s === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(s);
const tenant = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const origin = s => typeof s === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(s) && new URL(s).origin === s;
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const digest = v => createHash('sha256').update(JSON.stringify(fields.map(k=>v[k]))).digest('hex');
const fail = () => {throw new HttpError(503,'shadow_isolation_mismatch');};
export function resolveShadowBinding({config,envRead}) {
  try {
    const raw = envRead('QUANTUS_V4_SHADOW_BINDING');
    if (config?.mode !== 'shadow' || typeof raw !== 'string') return null;
    const b = JSON.parse(raw);
    if (!record(b) || Object.keys(b).length !== fields.length || Object.keys(b).some(k=>!fields.includes(k))
      || b.schemaVersion !== 1 || !project(b.projectId) || !project(b.sourceProjectId) || b.projectId === b.sourceProjectId
      || !tenant(b.tenant) || !tenant(b.sourceTenant) || b.tenant === b.sourceTenant || b.tenant !== config.tenant
      || !origin(b.c2Origin) || !origin(b.sourceC2Origin) || b.c2Origin === b.sourceC2Origin
      || typeof b.ref !== 'string' || b.ref.trim() !== b.ref || b.ref.length < 4 || b.ref.length > 500) return null;
    // Canonical default-instance names only: no aliases, paths, credentials or
    // fall-through to firebase-admin's productive default URL.
    const allowedDb = new RegExp('^https://(?:' + b.projectId + '\\.firebaseio\\.com|' + b.projectId + '-default-rtdb(?:\\.[a-z0-9-]+)?\\.firebasedatabase\\.app)$');
    if (typeof b.databaseUrl !== 'string' || !allowedDb.test(b.databaseUrl)
      || envRead('FIREBASE_DATABASE_URL') !== b.databaseUrl || envRead('FIREBASE_PROJECT_ID') !== b.projectId
      || envRead('FIREBASE_OAUTH_REFRESH_TOKEN')) return null;
    const sa = JSON.parse(envRead('FIREBASE_SERVICE_ACCOUNT_JSON') || 'null');
    if (!record(sa) || sa.type !== 'service_account' || sa.project_id !== b.projectId
      || typeof sa.client_email !== 'string' || !sa.client_email.endsWith('@'+b.projectId+'.iam.gserviceaccount.com')
      || typeof sa.private_key !== 'string' || !sa.private_key.trim()) return null;
    if (config.role === 'worker' && (config.c2BaseUrl !== b.c2Origin
      || envRead('QUANTUS_V3_FIREBASE_PROJECT_ID') !== b.projectId)) return null;
    if (config.tasks && !config.tasks.queue?.startsWith('projects/'+b.projectId+'/')) return null;
    return Object.freeze({...b,hash:digest(b)});
  } catch { return null; }
}
export function shadowIsolationMarker(binding) {
  if (!binding?.hash || binding.hash !== digest(binding)) fail();
  return {schemaVersion:1,bindingHash:binding.hash,projectId:binding.projectId,tenant:binding.tenant};
}
function assertMarker(data,binding) {
  const marker = data?.automation?.shadowIsolation, expected = shadowIsolationMarker(binding);
  if (!record(marker) || Object.keys(marker).length !== Object.keys(expected).length
    || Object.keys(expected).some(k=>marker[k]!==expected[k])) fail();
}
export function isolateShadowCorePort({corePort,config,envRead}) {
  const binding = resolveShadowBinding({config,envRead});
  const inner = corePort?.available ? corePort.impl : null;
  if (!binding || !inner?.read || !inner?.mutate) return unavailablePort('core','shadow_isolation_not_configured');
  const impl = Object.freeze({
    async read() {const snapshot=await inner.read();assertMarker(snapshot?.data,binding);return snapshot;},
    async mutate(args) {
      // A replay can skip its mutator; verify the durable marker before every
      // request as well as before/after each actual CAS attempt.
      const current=await inner.read();assertMarker(current?.data,binding);
      return inner.mutate({...args,mutate(data){
        assertMarker(data,binding);const result=args.mutate(data);
        if (!result || typeof result.then==='function') fail();
        assertMarker(result.data,binding);return result;
      }});
    },
  });
  boundPorts.set(impl,{binding,role:config.role,c2BaseUrl:config.c2BaseUrl});
  return availablePort('core',impl);
}
export const isIsolatedShadowCore = (impl,config) => {
  const bound=boundPorts.get(impl);
  return !!bound && config?.mode==='shadow' && config.tenant===bound.binding.tenant
    && config.role===bound.role && config.c2BaseUrl===bound.c2BaseUrl;
};

// Immutable reviewed binding only; no credential values are exposed.
export const isolatedShadowBinding = impl => boundPorts.get(impl)?.binding ?? null;
