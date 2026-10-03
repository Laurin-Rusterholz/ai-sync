/** Narrow authority to enqueue existing isolated continuation intents.
 * This capability does not enable general live effects, create intents or
 * grant provider, tool, notification or productive queue permissions. */
import { isIsolatedShadowCore, isolatedShadowBinding } from './shadow-isolation.mjs';
import { readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { continuationTaskId, taskName } from './task-names.mjs';
import { HttpError } from './errors.mjs';
const permissions = new WeakMap();
const fields = ['schemaVersion','bindingHash','queue','targetUrl','oidcServiceAccount','audience','approvedAtMs','expiresAtMs'];
const fail = () => { throw new HttpError(409,'commissioning_task_not_authorized'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k=>Object.hasOwn(value,k));

export function createCommissioningTasksPermission({ config, core, clock, envRead } = {}) {
  try {
    if (!isIsolatedShadowCore(core,config) || !['worker','monitor'].includes(config.role) || !clock?.now) return null;
    const binding = isolatedShadowBinding(core), approved = JSON.parse(envRead('QUANTUS_V4_COMMISSIONING_TASKS_JSON'));
    if (!exact(approved,fields) || approved.schemaVersion !== 1 || approved.bindingHash !== binding.hash
      || !Number.isSafeInteger(approved.approvedAtMs) || approved.approvedAtMs <= 0
      || !Number.isSafeInteger(approved.expiresAtMs) || approved.expiresAtMs <= approved.approvedAtMs
      || !approved.queue.startsWith('projects/'+binding.projectId+'/locations/')
      || !/^https:\/\/[a-z0-9.-]+(?::\d+)?\/v3\/run\/continue$/.test(approved.targetUrl)
      || approved.audience !== approved.targetUrl
      || !new RegExp('^[A-Za-z0-9._-]+@'+binding.projectId+'\\.iam\\.gserviceaccount\\.com$').test(approved.oidcServiceAccount)
      || ['queue','targetUrl','oidcServiceAccount','audience'].some(k=>approved[k]!==config.tasks?.[k])) return null;
    taskName(approved.queue,'configuration-check');
    if (clock.now()<approved.approvedAtMs || clock.now()>=approved.expiresAtMs) return null;
    const permission = Object.freeze({});
    permissions.set(permission,{approved,core,clock,tenant:binding.tenant,policyVersion:config.policyVersion});
    return permission;
  } catch { return null; }
}

export const isCommissioningTasksPermission = permission => permissions.has(permission);

export async function authorizeCommissioningTask(permission, request) {
  const bound = permissions.get(permission); if (!bound) fail();
  const {approved,core,clock,tenant,policyVersion} = bound;
  const current = () => {const now=clock.now();if(now<approved.approvedAtMs||now>=approved.expiresAtMs)fail();};
  current();
  if (request.method!=='POST'||request.url!==`https://cloudtasks.googleapis.com/v2/${approved.queue}/tasks`
    || !exact(request.payload,['task'])) fail();
  const task=request.payload.task, http=task?.httpRequest;
  if (!exact(task,['name','dispatchDeadline','scheduleTime','httpRequest']) || task.dispatchDeadline!=='100s'
    || !exact(http,['url','httpMethod','headers','body','oidcToken']) || http.url!==approved.targetUrl || http.httpMethod!=='POST'
    || !exact(http.headers,['Content-Type']) || http.headers['Content-Type']!=='application/json'
    || !exact(http.oidcToken,['serviceAccountEmail','audience']) || http.oidcToken.serviceAccountEmail!==approved.oidcServiceAccount
    || http.oidcToken.audience!==approved.audience || typeof http.body!=='string' || http.body.length>4096) fail();
  let body, parsed;
  try {
    body=JSON.parse(Buffer.from(http.body,'base64').toString('utf8'));
    if (!exact(body,['runKey','continuationId']) || Buffer.from(JSON.stringify(body)).toString('base64')!==http.body) fail();
    parsed=parseSlotRunKey(body.runKey);
    if (parsed.tenant!==tenant||parsed.policyVersion!==policyVersion
      ||task.name!==taskName(approved.queue,continuationTaskId(body.runKey,body.continuationId))) fail();
  } catch { fail(); }
  const scheduled=Date.parse(task.scheduleTime);
  if(!Number.isSafeInteger(scheduled)||scheduled>=approved.expiresAtMs)fail();
  const {data}=await core.read();current(); // durable isolation marker is checked by the branded port
  const runtime=readRuntime(data),intent=runtime.continuationsById[body.continuationId],run=runtime.runsByKey[body.runKey];
  if(intent?.state!=='pending'||intent.id!==body.continuationId||intent.runKey!==body.runKey
    ||!['run_continuation','exception_continuation','slot_catchup'].includes(intent.kind)
    ||(run ? run.pendingContinuationId!==body.continuationId||run.phase==='finished'
      : intent.kind!=='slot_catchup'||intent.source!=='monitor')
    ||!Number.isSafeInteger(intent.notBeforeMs)||scheduled<intent.notBeforeMs)fail();
}
