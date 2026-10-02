/** Deterministic read/import preparation before model work. Each bounded batch
 * retains source checkpoints and immutable per-version intake identities.
 * A source-check receipt proves acquisition/inclusion, never semantic closure.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { createGmailSourceSync } from './gmail-source-sync.mjs';
import { createGmailMessageRegistry } from './gmail-message-registry.mjs';
import { createGmailIntakeBinding, gmailIntakeDescriptor } from './gmail-intake-binding.mjs';
import { applyCommand, validatePolicy } from '../../../netlify/lib/assistant-core.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';

const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw new HttpError(409, `gmail_preparation_${code}`); };
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-gmail-preparation' });
export function createGmailWorkerPreparation(options) {
  const { core, clock, tenant, account, sourceId, runKey, sectionId, verifiedScope, signal, policy } = options;
  const parsed = parseSlotRunKey(runKey), identity = { tenant, account, sourceId };
  if (!validatePolicy(policy).ok || !policy.requiredSources.some(s => s.id === sourceId && ['gmail', 'mail'].includes(s.kind))) fail('source_not_required');
  const sync = createGmailSourceSync(options), registry = createGmailMessageRegistry(options), binding = createGmailIntakeBinding(options);
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
    return run;
  }
  async function snapshot() { const d = (await core.read())?.data; check(d); return d; }
  function pending(data, inventory) {
    const missing = [];
    for (const row of inventory.records) {
      const { binding, intakeId, text } = gmailIntakeDescriptor(identity, row), entry = data.automation.intakeById?.[intakeId];
      if (!entry) { missing.push(row); continue; }
      if (entry.id !== intakeId || entry.text !== text || entry.channel !== 'gmail'
        || entry.registeredBy !== 'quantus-v4-gmail-intake' || !equal(entry.origin, { sourceType: 'gmail', sourceId })
        || !equal(entry.externalSource, binding)) fail('intake_invalid');
    }
    return missing;
  }
  function verifyCheck(data, marker) {
    const actual = data.dailyBriefing?.assistantRuns?.[parsed.localDate]?.sourceChecks?.[sourceId];
    if (!actual || actual.cursor !== marker.cursor || actual.outcome !== marker.outcome
      || actual.checkedAt !== marker.checkedAt || actual.checkedBy !== ACTOR.id) fail('source_check_changed');
  }
  return Object.freeze({
    async next({ deadlineAtMs = clock.now() + 60000 } = {}) {
      const started = clock.now(), progress = [];
      // Internal checkpoint units are part of one bounded source operation;
      // the worker still records/budgets each returned batch as a tool step.
      for (let unit = 0; unit < 8; unit++) {
        if (progress.length && clock.now() + 20000 >= deadlineAtMs) break;
        const source = await sync.next();
        if (!source.done) { progress.push(['sync', source.revision]); continue; }
        const inventory = await registry.inventory(), data = await snapshot();
        const runtime = readRuntime(data), sourceState = runtime.gmailSync?.sources?.[registry.sourceKey];
        if (sourceState?.revision !== source.revision || sourceState.phase !== 'done' || sourceState.runKey !== runKey
          || !equal(runtime.gmailRegistry?.sources?.[registry.sourceKey] ?? null, inventory.source)) fail('source_changed');
        const todo = pending(data, inventory);
        if (todo.length) {
          const item = await binding.bind({ messageId: todo[0].messageId });
          progress.push(['intake', item.intakeId]); continue;
        }
        const outcome = source.partial ? 'partial' : 'ok';
        const identityHash = hash([identity, runKey, source.revision, source.historyId, source.proof, inventory.fingerprint, outcome]);
        const cursor = `gmail-v4:${identityHash}`;
        const markerFor = checkedAt => ({ identityHash, cursor, outcome, checkedAt, sourceKey: registry.sourceKey,
          sourceRevision: source.revision, historyId: source.historyId, originalCount: inventory.records.length, proof: source.proof,
          registryFingerprint: inventory.fingerprint });
        const existing = check(data).gmailPreparation;
        if (existing) {
          if (!equal(existing, markerFor(existing.checkedAt)) || !Number.isFinite(Date.parse(existing.checkedAt))
            || Date.parse(existing.checkedAt) < sourceState.completedAtMs || Date.parse(existing.checkedAt) > clock.now()) fail('prepared_source_changed');
          verifyCheck(data, existing);
          if (progress.length) break; // bind new inventory in the bootstrap before any model call
          return { ready: true, outcome };
        }
        const checkedAt = new Date(clock.now()).toISOString();
        const marker = markerFor(checkedAt);
        const commandKey = 'v4-gmail-prepared-' + identityHash;
        const saved = await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(current) {
          const run = check(current), rt = readRuntime(current);
          if (run.gmailPreparation || !equal(rt.gmailSync?.sources?.[registry.sourceKey], sourceState)
            || !equal(rt.gmailRegistry?.sources?.[registry.sourceKey] ?? null, inventory.source)
            || pending(current, inventory).length) fail('source_changed');
          const applied = applyCommand(current, { type: 'recordSourceCheck', commandId: commandKey, now: Date.parse(checkedAt),
            payload: { date: parsed.localDate, sourceId, cursor, outcome,
              detail: `${inventory.records.length} Originalversionen registriert und als Eingange gebunden; fachliche Bearbeitung separat.` } },
          { policy, actor: ACTOR });
          if (!applied.ok) fail('source_check_rejected');
          check(applied.data).gmailPreparation = marker;
          assertActiveRuntimeCapacity(applied.data);
          return { data: applied.data, result: { identityHash } };
        } });
        const fresh = await snapshot();
        if (saved.result?.identityHash !== identityHash || !equal(check(fresh).gmailPreparation, marker)) fail('readback_failed');
        if (!equal(readRuntime(fresh).gmailSync?.sources?.[registry.sourceKey], sourceState)
          || !equal(readRuntime(fresh).gmailRegistry?.sources?.[registry.sourceKey] ?? null, inventory.source)
          || pending(fresh, inventory).length) fail('source_changed');
        verifyCheck(fresh, marker);
        progress.push(['prepared', identityHash]); break;
      }
      if (!progress.length) fail('no_progress');
      return { ready: false, stepId: 'gmail-preparation-' + hash([runKey, progress]),
        durationMs: Math.max(0, clock.now() - started), cursor: { schema: 'quantus-gmail-preparation/1', runKey,
          fence: verifiedScope.fence, progress: progress.at(-1) } };
    },
  });
}
