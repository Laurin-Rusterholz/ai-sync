/** One resumable phase per step. Model responses precede tool effects in the
 * journal; cost settlement is read back before execution. Tool retries use the
 * original provider response/call IDs, hence the gateway's same idempotency key.
 * A model completion is text, never permission to finalize a daily run.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import {isOpenAIRequestContract} from './openai-transport.mjs';
import { JOURNAL_LIMITS,isCommissioningJournal,commissioningJournalContract } from './leadership-journal.mjs';
import { continueLeadershipInput } from './leadership-conversation.mjs';
import { commandUnconfirmed } from './leadership-command-state.mjs';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function contextOverCapacity(call, receipt) {
  return ['quantus_context', 'quantus_read', 'quantus_run_status'].includes(call.name)
    && ['read_byte_limit', 'read_page_limit'].includes(receipt?.readFailure);
}

export function createLeadershipLoop({ runKey, journal, openai, gateway, costAdapter, completionCheck } = {}) {
  const commissioned=isCommissioningJournal(journal);
  if(commissioned&&(!isOpenAIRequestContract(openai)||commissioningJournalContract(journal)!==openai))throw new TypeError('commissioning_keyless_contract_required');
  if (typeof runKey !== 'string' || !journal?.begin || !journal?.settleResponse || !openai?.prepare
    || !gateway?.execute || (!commissioned&&!costAdapter?.claimAndDispatch)) throw new TypeError('leadership_loop_configuration_missing');
  const callIdAt = index => 'lead-' + hash([runKey, index]);
  return Object.freeze({
    async step({ initialRequest, signal } = {}) {
      const checkAbort = () => { if (signal?.aborted) throw new HttpError(409, 'leadership_interrupted'); };
      checkAbort();
      // Older inline journals move only after immutable storage readback and
      // an exact CAS match. Failure leaves their original payloads untouched.
      if (journal.migrateInline) await journal.migrateInline();
      if (journal.rolloverIfNeeded) await journal.rolloverIfNeeded();
      const entries = await journal.read();
      const tools = gateway.definitions();
      const compactionEnabled = openai.compactionThreshold != null;
      const trusted = { instructions: initialRequest?.instructions, tools,
        transport: { provider: openai.provider, model: openai.model, modelPricing: openai.modelPricing, maxOutputTokens: openai.maxOutputTokens,
          ...(compactionEnabled ? { compactionThreshold: openai.compactionThreshold } : {}) } };
      // Policy and tool definitions are runtime input, never model output.
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.callId !== callIdAt(i)) throw new HttpError(409, 'leadership_sequence_invalid');
        const policyHash = e.archived === true ? e.policyHash
          : hash({ instructions: e.request.instructions, tools: e.request.tools, transport: e.request.transport });
        if (policyHash !== hash(trusted)) throw new HttpError(409, 'leadership_policy_changed');
      }
      let current = entries.at(-1);
      if (current?.response) {
        if (current.response.outcome !== 'settled') return { kind: 'blocked', reason: 'provider_outcome_unknown', callId: current.callId };
        const settled = await journal.settleResponse({ callId: current.callId });
        if (settled.overrunMicros > 0) return { kind: 'blocked', reason: 'provider_cost_overrun', callId: current.callId };
        const result = current.response.result;
        if (result?.usable !== true) return { kind: 'blocked', reason: result?.reason || 'model_output_unusable', callId: current.callId };
        if (!Array.isArray(result.toolCalls) || result.toolCalls.length > 1) throw new HttpError(502, 'leadership_output_invalid');
        if (!result.toolCalls.length) {
          if (journal.verifyArchives) await journal.verifyArchives();
          const coverage = completionCheck ? await completionCheck({ entries, signal }) : { complete: true };
          if (coverage.complete === true) return { kind: 'model_complete', text: result.text, callId: current.callId, finalized: false,
            ...(coverage.proof ? { coverageProof: coverage.proof } : {}) };
          if (coverage.blocked) return { kind: 'blocked', reason: coverage.reason, callId: current.callId };
          // Runtime-generated continuation, never an instruction copied from
          // source text. The tentative completion remains in durable history.
          const input = continueLeadershipInput({ input: current.request.input, output: result.output, compactionEnabled,
            appended: [{ role: 'user', content: JSON.stringify({
            backendContinuation: { reason: coverage.reason, requiredReads: coverage.requiredReads,
              instruction: 'Die Backend-Prüfung bestätigt den Abschluss noch nicht. Lies diese Abfragen vollständig; verwende den angegebenen Fortsetzungscursor oder starte bei fehlendem Cursor leer. Bearbeite neue oder geänderte Originale.' },
          }) }] });
          current = { callId: callIdAt(entries.length), request: { ...trusted, input }, response: null };
        } else if (!current.tool) {
          checkAbort();
          const call = result.toolCalls[0];
          const receipt = await gateway.execute(call, { responseId: current.response.usageReceiptId, callId: call.callId });
          await journal.recordTool({ callId: current.callId, requestHash: current.requestHash, tool: receipt });
          if (commandUnconfirmed(call, receipt)) return { kind: 'blocked', reason: 'command_outcome_unconfirmed', callId: current.callId };
          if (contextOverCapacity(call, receipt)) return { kind: 'blocked', reason: 'context_capacity_exceeded', callId: current.callId };
          return { kind: 'tool_recorded', callId: current.callId, confirmed: receipt.confirmed === true };
        } else {
          if (commandUnconfirmed(result.toolCalls[0], current.tool)) return { kind: 'blocked', reason: 'command_outcome_unconfirmed', callId: current.callId };
          if (contextOverCapacity(result.toolCalls[0], current.tool)) return { kind: 'blocked', reason: 'context_capacity_exceeded', callId: current.callId };
          // The next request includes original reasoning/call items unchanged.
          const input = continueLeadershipInput({ input: current.request.input, output: result.output, compactionEnabled,
            appended: [{ type: 'function_call_output', call_id: result.toolCalls[0].callId, output: JSON.stringify(current.tool) }] });
          current = { callId: callIdAt(entries.length), request: { ...trusted, input }, response: null };
        }
      } else if (!current) {
        current = { callId: callIdAt(0), request: { ...trusted, input: initialRequest?.input }, response: null };
      }
      if (entries.filter(e => e.archived !== true).length >= JOURNAL_LIMITS.turns && !entries.some(e => e.callId === current.callId))
        return { kind: 'blocked', reason: 'model_turn_limit' };
      checkAbort();
      let prepared;
      try { prepared = openai.prepare(current.request); }
      catch (error) {
        if (error instanceof TypeError && error.message === 'request_too_large')
          return { kind: 'blocked', reason: 'model_context_capacity_exceeded', callId: current.callId };
        throw error;
      }
      if (current.requestHash && current.requestHash !== prepared.contentHash) throw new HttpError(409, 'leadership_request_changed');
      await journal.begin({ callId: current.callId, requestHash: prepared.contentHash, request: current.request });
      if(commissioned){
        checkAbort();
        const charged=await journal.dispatchCommissioning({callId:current.callId,requestHash:prepared.contentHash,signal});
        return {kind:charged.outcome==='settled'?'model_recorded':'blocked',callId:current.callId,
          ...(charged.outcome==='settled'?{}:{reason:'provider_outcome_unknown'})};
      }
      await costAdapter.reserve({ callId: current.callId, runKey, provider: openai.provider, model: openai.model,
        contentHash: prepared.contentHash, inputTokens: prepared.inputTokens, outputTokens: prepared.outputTokens, modelPricing: openai.modelPricing });
      checkAbort();
      const charged = await costAdapter.claimAndDispatch({ callId: current.callId, claimId: current.callId + ':send', modelPricing: openai.modelPricing,
        async send() {
          const response = await openai.dispatch({ prepared, requestId: current.callId, signal });
          // A crash after this write can recover both output and confirmed
          // usage. A crash before it remains claimed; never blindly resend.
          await journal.recordResponse({ callId: current.callId, requestHash: prepared.contentHash, response });
          return response;
        },
      });
      return { kind: charged.outcome === 'settled' ? 'model_recorded' : 'blocked',
        ...(charged.outcome === 'settled' ? {} : { reason: 'provider_outcome_unknown' }), callId: current.callId };
    },
  });
}
