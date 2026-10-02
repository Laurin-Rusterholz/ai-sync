/** Connect a leased runtime section to its authoritative daily briefing before
 * any source/provider work. Domain commands keep their own single-revision
 * transactions; readback is mandatory before the inner worker can execute.
 */
import { createHash } from 'node:crypto';
import { applyCommand, collectRunInventory } from '../../../netlify/lib/assistant-core.mjs';
import { validatePolicy } from '../../../netlify/lib/assistant-schema.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';
import { availablePort } from './ports.mjs';
import { HttpError } from './errors.mjs';

const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (code, status = 409) => { throw new HttpError(status, code); };
const ACTOR = Object.freeze({ kind: 'system', id: 'quantus-v4-briefing-bootstrap' });

export function createBriefingSectionWork({ core, clock, policy, config, inner } = {}) {
  if (!core?.read || !core?.mutate || !clock?.now || !inner?.next || !validatePolicy(policy).ok)
    throw new TypeError('briefing_bootstrap_configuration_missing');
  if (policy.tenant !== config?.tenant || policy.version !== config?.policyVersion
    || config.leaseScope !== `${policy.tenant}:mainrun`) throw new TypeError('briefing_bootstrap_policy_mismatch');
  // Configuration is trusted, but still copied: a caller cannot mutate its
  // tenant or note content after the idempotency identity has been derived.
  policy = structuredClone(policy);
  const tenant = config.tenant, version = config.policyVersion, leaseScope = config.leaseScope;
  return availablePort('sectionWork', {
    async next(args) {
      const { runKey, sectionId, verifiedScope, signal } = args;
      const parsed = parseSlotRunKey(runKey);
      if (parsed.tenant !== tenant || parsed.policyVersion !== version || verifiedScope?.scope !== leaseScope)
        fail('briefing_bootstrap_scope_mismatch');
      const identity = hash([runKey, policy]);
      const receiptId = `v4-slot-${identity}`;
      const noteId = `v4-start-${hash([tenant, parsed.localDate, version])}`;
      const noteText = `Tagesbriefing ${parsed.localDate} gestartet. Die offenen Originaleintraege werden geprueft. Ergebnisse und offene Punkte folgen; dies ist keine Abschlussbestaetigung.`;
      const marker = hash([runKey, sectionId, policy, noteText]);
      function check(data) {
        if (signal?.aborted) fail('briefing_bootstrap_aborted');
        assertLeadership(data, verifiedScope, clock.now());
        const daily = data.dailyBriefing?.assistantRuns?.[parsed.localDate];
        const runtimeRun = readRuntime(data).runsByKey[runKey];
        if (daily && (daily.policyVersion !== version || (daily.phase === 'final'
          && runtimeRun?.dailyFinalization?.runKey !== runKey))) fail('briefing_bootstrap_daily_run_conflict');
        const section = runtimeRun?.sections?.[sectionId];
        if (runtimeRun?.phase !== 'active' || runtimeRun.currentSectionId !== sectionId
          || !section || section.closed === true || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence)
          fail('briefing_bootstrap_section_mismatch');
        return section;
      }
      async function snapshot() { const data = (await core.read())?.data; check(data); return data; }
      function innerArgs(data) {
        const cursor = args.cursor;
        if (!cursor || !Number.isSafeInteger(cursor.fence) || cursor.fence === verifiedScope.fence) return args;
        // A continuation receives a new lease. Rebind only the exact durable
        // checkpoint consumed by this section, never an arbitrary old cursor.
        const runtime = readRuntime(data), run = runtime.runsByKey[runKey];
        const checkpoint = run.checkpoint, section = check(data);
        const intent = runtime.continuationsById[args.resumedFrom];
        if (!args.resumedFrom || section.resumedFrom !== args.resumedFrom
          || checkpoint?.continuationId !== args.resumedFrom || checkpoint.fence !== cursor.fence
          || intent?.runKey !== runKey || intent.consumedBySectionId !== sectionId
          || JSON.stringify(checkpoint.cursor) !== JSON.stringify(cursor)) fail('briefing_checkpoint_mismatch');
        return { ...args, cursor: { ...structuredClone(cursor), fence: verifiedScope.fence } };
      }
      function verifyDomain(data, { inventory = false } = {}) {
        const run = data.dailyBriefing?.assistantRuns?.[parsed.localDate];
        const note = data.entities?.chatgptNotes?.[run?.startNoteId];
        if (!run || (run.phase === 'final' && readRuntime(data).runsByKey[runKey]?.dailyFinalization?.runKey !== runKey) || run.policyVersion !== version
          || run.slotReceipts?.[parsed.slot]?.receiptId !== receiptId
          || run.slotReceipts[parsed.slot].slotKey !== runKey
          || typeof note?.instruction !== 'string' || !note.instruction.trim()
          || note.assistantNote?.runDate !== parsed.localDate || note.assistantNote?.kind !== 'assistantStart')
          fail('briefing_bootstrap_readback_failed', 502);
        if (inventory) {
          const refs = new Set((run.itemRefs || []).map(r => `${r.sourceType}:${r.sourceId}`));
          if (collectRunInventory(data).some(r => !refs.has(`${r.sourceType}:${r.sourceId}`)))
            fail('briefing_inventory_readback_failed', 502);
        }
      }
      const initial = await snapshot();
      innerArgs(initial); // Reject forged continuation state before writes.
      if (initial.dailyBriefing?.assistantRuns?.[parsed.localDate]?.phase === 'final') {
        verifyDomain(initial);
        if (typeof inner.resumeFinalized !== 'function') fail('briefing_bootstrap_final_verifier_missing');
        return inner.resumeFinalized(innerArgs(initial));
      }
      const existing = check(initial).briefingBootstrap;
      if (existing !== undefined && existing !== marker) fail('briefing_bootstrap_marker_invalid', 503);
      if (existing === marker) {
        verifyDomain(initial);
        const refs = new Set((initial.dailyBriefing.assistantRuns[parsed.localDate].itemRefs || []).map(r => `${r.sourceType}:${r.sourceId}`));
        const missing = collectRunInventory(initial).filter(r => !refs.has(`${r.sourceType}:${r.sourceId}`));
        if (missing.length) {
          // Work arriving inside a section must be bound before the next
          // model/tool phase; otherwise live workset reads would reveal it
          // while legitimate commands still failed the stored run binding.
          await command('syncRunInventory', { date: parsed.localDate }, [sectionId, 'arrivals', hash(missing)]);
          const refreshed = await snapshot();
          verifyDomain(refreshed, { inventory: true });
          return inner.next(innerArgs(refreshed));
        }
        return inner.next(innerArgs(initial));
      }
      async function command(type, payload, identityParts) {
        const commandKey = 'v4-bootstrap-' + hash([runKey, type, payload, policy, ...identityParts]);
        await snapshot(); // Replayed receipts must not bypass current authority.
        const out = await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
          check(data);
          const result = applyCommand(data, { type, payload, commandId: commandKey, now: clock.now() }, { policy, actor: ACTOR });
          if (!result.ok) fail(`briefing_bootstrap_${result.error || result.code || 'command_rejected'}`);
          // Never duplicate the full run/core in the bounded idempotency ledger.
          return { data: result.data, result: { commandKey } };
        } });
        if (out?.result?.commandKey !== commandKey) fail('briefing_bootstrap_receipt_invalid', 502);
      }
      await command('ensureRunSlot', { date: parsed.localDate, slot: parsed.slot, receiptId }, []);
      await command('ensureStartNote', { date: parsed.localDate, noteId, content: noteText }, []);
      await command('syncRunInventory', { date: parsed.localDate }, [sectionId]);
      const ready = await snapshot();
      verifyDomain(ready, { inventory: true });
      const commandKey = `v4-bootstrap-ready-${marker}`;
      await core.mutate({ commandKey, requestId: commandKey, now: clock.now(), mutate(data) {
        const section = check(data);
        verifyDomain(data, { inventory: true });
        section.briefingBootstrap = marker;
        return { data, result: { marker } };
      } });
      const final = await snapshot();
      if (check(final).briefingBootstrap !== marker) fail('briefing_bootstrap_readback_failed', 502);
      verifyDomain(final);
      return inner.next(innerArgs(final));
    },
  });
}
