import { openCommandQueue, createCommandTransport, canonicalIntentJson } from './quantus-v3-command-client.mjs';
const safeId = s => typeof s === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(s) && !s.includes('__');
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function captureIntent({ accountKey, captureId, fields }) {
  if (!accountKey) fail('sign_in_required');
  if (!safeId(captureId) || !fields || Object.keys(fields).some(k => !['title','text','projectId','sourceUrl','nextAction'].includes(k))) fail('capture_invalid');
  const payload = { source: 'manual', intakeId: 'capture_' + captureId };
  if (!safeId(payload.intakeId)) fail('capture_invalid');
  for (const [key, max] of [['title',200],['text',8000],['projectId',120],['sourceUrl',2000],['nextAction',500]]) {
    if (fields[key] === undefined || fields[key] === '') continue;
    if (typeof fields[key] !== 'string' || fields[key].length > max) fail('capture_invalid');
    if (fields[key].trim()) payload[key] = fields[key].trim();
  }
  if (!payload.title && !payload.text) fail('capture_invalid');
  if (!payload.title) payload.title = payload.text.split('\n')[0].slice(0, 200);
  if (payload.projectId && !safeId(payload.projectId)) fail('capture_invalid');
  if (payload.sourceUrl) {
    let url; try { url = new URL(payload.sourceUrl); } catch (_) { fail('capture_invalid'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) fail('capture_invalid');
  }
  const result = { accountKey, operationId: 'capture-intent-' + captureId,
    legacyOperation: { kind: 'quick_capture', schemaVersion: 1, captureId, payload } };
  canonicalIntentJson(result); return result;
}
const validRun = run => run && safeId(run.id) && /^run_\d{4}-\d{2}-\d{2}$/.test(run.id)
  && run.id === 'run_' + run.date && Number.isFinite(Date.parse(run.date))
  && new Date(run.date).toISOString().slice(0, 10) === run.date && ['created','active','exception_open'].includes(run.phase);
export async function openQuickCapture({ accountKey, getAuth, getRun, origin, indexedDB, fetchImpl, now = Date.now } = {}) {
  const queue = await openCommandQueue({ indexedDB, databaseName: 'quantus-v4-quick-capture', now });
  const transport = createCommandTransport({ origin, getAuth, fetchImpl, now, writesEnabled: true });
  let busy = false;
  let nextCheckAt = now() + 30000;
  const all = () => queue.list(accountKey, { includeAcknowledged: true });
  const checked = { async send(entry, options) {
    const result = await transport.send(entry, options);
    if (!result.ok) return result;
    const versions = result.receipt.entityVersions, intakeId = entry.command.payload.intakeId;
    const leadId = result.receipt.effect?.leadId;
    if (!Number.isSafeInteger(versions[intakeId]) || versions[intakeId] <= 0
      || entry.command.verb === 'intake.accept' && (!safeId(leadId) || !Number.isSafeInteger(versions[leadId]) || versions[leadId] < 1
        || !Number.isSafeInteger(versions[entry.command.jobId])))
      return { ok: false, code: 'capture_receipt_incomplete', status: 0, retryable: true, uncertain: true };
    return result;
  } };
  async function reconcile() {
    const entries = await all(), commands = new Map(entries.filter(e => e.command).map(e => [e.operationId,e]));
    for (const entry of entries.filter(e => e.legacyOperation?.kind === 'quick_capture')) {
      const old = entry.legacyOperation, payload = old.payload;
      const expected = captureIntent({ accountKey, captureId: old.captureId, fields: Object.fromEntries(Object.entries(payload).filter(([k]) => !['source','intakeId'].includes(k))) });
      if (entry.operationId !== expected.operationId || canonicalIntentJson(old) !== canonicalIntentJson(expected.legacyOperation)) fail('stored_operation_corrupt');
      const createId = 'capture-create-' + old.captureId, acceptId = 'capture-accept-' + old.captureId;
      const create = commands.get(createId);
      if (!create) {
        const run = await getRun(); if (!validRun(run)) continue;
        await queue.enqueue({ accountKey, operationId: createId, command: { schemaVersion: 3, verb: 'intake.create', jobId: run.id, expectedEntityVersion: 0, payload } });
      } else if (create.status === 'acknowledged' && !commands.has(acceptId)) {
        await queue.enqueue({ accountKey, operationId: acceptId, command: { schemaVersion: 3, verb: 'intake.accept', jobId: create.command.jobId,
          expectedEntityVersion: create.receipt.entityVersions[payload.intakeId], payload: { intakeId: payload.intakeId } } });
      }
    }
  }
  return Object.freeze({ close: () => queue.close(),
    nextCheckAt: () => nextCheckAt,
    submit: fields => queue.retainLegacy(captureIntent({ accountKey, ...fields })),
    async list() {
      const entries = await all(), byId = new Map(entries.map(e => [e.operationId,e]));
      return entries.filter(e => e.legacyOperation?.kind === 'quick_capture').map(e => {
        const id = e.legacyOperation.captureId, create = byId.get('capture-create-' + id), accept = byId.get('capture-accept-' + id);
        return { ...e, deliveryStatus: accept?.status || (create?.status === 'acknowledged' ? 'accept_pending' : create?.status || 'run_pending'),
          leadId: accept?.status === 'acknowledged' ? accept.receipt.effect.leadId : null };
      });
    },
    async flush() {
      if (busy) return { busy: true }; busy = true;
      nextCheckAt = now() + 30000;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const auth = await getAuth(); if (auth?.accountKey !== accountKey) fail('sign_in_required');
        await queue.resumeAfterSignIn(accountKey);
        for (let stage = 0; stage < 2 && !controller.signal.aborted; stage++) {
          await reconcile();
          const result = await queue.drain(accountKey, { transport: checked, limit: 8, signal: controller.signal });
          if (result.paused) return result;
        }
        return { ok: true };
      } finally { clearTimeout(timeout); busy = false; }
    },
  });
}
export const captureStatusText = status => ({
  run_pending: 'Auf diesem Gerät gesichert · wartet auf einen aktiven Tageslauf',
  pending: 'Auf diesem Gerät gesichert · Übertragung offen', retry_wait: 'Auf diesem Gerät gesichert · Serverbestätigung ausstehend',
  accept_pending: 'Eingang bestätigt · Lead-Erstellung noch offen', acknowledged: 'Lead vom Server bestätigt',
  conflict: 'Konflikt · Auftrag bleibt gesichert; bitte prüfen', needs_sign_in: 'Bitte erneut anmelden · Auftrag bleibt gesichert',
  needs_review: 'Übertragung ungeklärt · Auftrag bleibt gesichert', upgrade_required: 'App-Aktualisierung erforderlich · Auftrag bleibt gesichert',
}[status] || 'Übertragung ungeklärt');
