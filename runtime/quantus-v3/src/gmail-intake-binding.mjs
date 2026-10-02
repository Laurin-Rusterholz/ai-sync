/** Server-owned binding of a registered mail version to an open domain intake.
 * The compact intake is a reference, never a substitute for reading the full
 * original. Model/user text cannot mint a binding through registerIntake.
 */
import { createHash } from 'node:crypto';
import { applyCommand } from '../../../netlify/lib/assistant-core.mjs';
import { validatePolicy } from '../../../netlify/lib/assistant-schema.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { createGmailMessageRegistry } from './gmail-message-registry.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { HttpError } from './errors.mjs';

const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw new HttpError(409, `gmail_intake_${code}`); };
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-gmail-intake' });

export function gmailIntakeDescriptor(identity, row) {
  return { binding: { schema: 'quantus-gmail-intake/1', identity, sourceKey: hash(identity), record: row },
    intakeId: 'gmail-' + hash([identity, row.messageId, row.version, row.contentHash]),
    text: `Gmail-Nachricht ${row.messageId}, Version ${row.version}. Vollstaendiges Original vor Bearbeitung lesen. Offene Inhaltsluecken: ${row.gapCount}.` };
}

export function createGmailIntakeBinding({ core, clock, artifacts, tenant, account, sourceId,
  runKey, sectionId, verifiedScope, signal, policy } = {}) {
  const parsed = parseSlotRunKey(runKey);
  if (!core?.read || !core?.mutate || !clock?.now || !validatePolicy(policy).ok
    || policy.tenant !== tenant || parsed.tenant !== tenant || parsed.policyVersion !== policy.version
    || verifiedScope?.scope !== `${tenant}:mainrun`) fail('configuration_invalid');
  policy = structuredClone(policy);
  const identity = { tenant, account, sourceId };
  const registry = createGmailMessageRegistry({ core, clock, artifacts, tenant, account, sourceId,
    runKey, sectionId, verifiedScope, signal });
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    if (!data?.automation?.intakeById || typeof data.automation.intakeById !== 'object'
      || Array.isArray(data.automation.intakeById)) fail('intake_area_invalid');
    assertLeadership(data, verifiedScope, clock.now());
    const run = readRuntime(data).runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
  }
  async function snapshot() { const d = (await core.read())?.data; check(d); return d; }
  function current(data, messageId) {
    const runtime = readRuntime(data), source = runtime.gmailRegistry?.sources?.[registry.sourceKey];
    if (runtime.gmailRegistryInitialized !== true || !equal(source?.identity, identity)) fail('source_missing');
    return source.records?.[hash([account, messageId])];
  }
  function verify(data, intakeId, text, binding, receivedAt) {
    const entry = data.automation.intakeById[intakeId];
    if (!entry || entry.id !== intakeId || entry.text !== text || entry.channel !== 'gmail'
      || !equal(entry.origin, { sourceType: 'gmail', sourceId })
      || entry.receivedAt !== receivedAt || entry.registeredBy !== ACTOR.id || !equal(entry.externalSource, binding)) fail('binding_invalid');
    return entry;
  }
  return Object.freeze({
    async bind({ messageId }) {
      // Includes independent manifest/part/hash and live lease checks.
      const verified = await registry.read({ messageId });
      if (!verified?.confirmed) fail('original_missing');
      const timestamp = verified.original.internalDate;
      if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)
        || !Number.isSafeInteger(Number(timestamp)) || !Number.isFinite(new Date(Number(timestamp)).getTime())) fail('received_at_invalid');
      const receivedAt = new Date(Number(timestamp)).toISOString();
      const row = verified.record;
      const { binding, intakeId, text } = gmailIntakeDescriptor(identity, row);
      const initial = await snapshot();
      if (!equal(current(initial, messageId), row)) fail('source_changed');
      if (initial.automation.intakeById[intakeId]) {
        const entry = verify(initial, intakeId, text, binding, receivedAt);
        return { intakeId, entry: structuredClone(entry), original: verified.original, created: false };
      }
      const commandKey = 'v4-gmail-intake-' + hash(binding);
      const result = await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
        check(data);
        if (!equal(current(data, messageId), row)) fail('source_changed');
        if (data.automation.intakeById[intakeId]) {
          verify(data, intakeId, text, binding, receivedAt);
          return { data, result: { intakeId } };
        }
        const applied = applyCommand(data, { type: 'registerIntake', commandId: commandKey, now: clock.now(), payload: {
          intakeId, text, channel: 'gmail', sourceType: 'gmail', sourceId, receivedAt,
        } }, { policy, actor: ACTOR });
        if (!applied.ok || applied.created !== true) fail('domain_rejected');
        applied.data.automation.intakeById[intakeId].externalSource = structuredClone(binding);
        assertActiveRuntimeCapacity(applied.data);
        return { data: applied.data, result: { intakeId } };
      } });
      if (result.result?.intakeId !== intakeId) fail('receipt_invalid');
      const data = await snapshot(), entry = verify(data, intakeId, text, binding, receivedAt);
      if (!equal(current(data, messageId), row)) fail('source_changed');
      return { intakeId, entry: structuredClone(entry), original: verified.original, created: true };
    },
  });
}
