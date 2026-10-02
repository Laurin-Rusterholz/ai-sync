/** One resumable phase per step. Model responses precede tool effects in the
 * journal; cost settlement is read back before execution. Tool retries use the
 * original provider response/call IDs, hence the gateway's same idempotency key.
 * A model completion is text, never permission to finalize a daily run.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { JOURNAL_LIMITS } from './leadership-journal.mjs';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function commandUnconfirmed(call, receipt) {
  if (call.name !== 'quantus_command' || receipt.confirmed === true) return false;
  const { status, body } = receipt.response || {};
  if (status === 200 && body?.dryRun === true && body?.applied === false) return false;
  // Explicit pre-execution rejection can be reconsidered by the model. A
  // malformed success, server error or timeout might already have committed;
  // do not give it a new model call ID and risk a duplicate effect.
  return !(body?.ok === false && [400, 401, 403, 404, 409, 413, 422, 429].includes(status));
}

function contextOverCapacity(call, receipt) {
  return ['quantus_context', 'quantus_read', 'quantus_run_status'].includes(call.name)
    && ['read_byte_limit', 'read_page_limit'].includes(receipt?.readFailure);
}

export function createLeadershipLoop({ runKey, journal, openai, gateway, costAdapter, completionCheck } = {}) {
  if (typeof runKey !== 'string' || !journal?.begin || !journal?.settleResponse || !openai?.prepare
    || !gateway?.execute || !costAdapter?.claimAndDispatch) throw new TypeError('leadership_loop_configuration_missing');
  const callIdAt = index => 'lead-' + hash([runKey, index]);
  return Object.freeze({
    async step({ initialRequest, signal } = {}) {
      const checkAbort = () => { if (signal?.aborted) throw new HttpError(409, 'leadership_interrupted'); };
      checkAbort();
      // Older inline journals move only after immutable storage readback and
      // an exact CAS match. Failure leaves their original payloads untouched.
      if (journal.migrateInline) await journal.migrateInline();
      const entries = await journal.read();
      const tools = gateway.definitions();
      const trusted = { instructions: initialRequest?.instructions, tools,
        transport: { provider: openai.provider, model: openai.model, modelPricing: openai.modelPricing, maxOutputTokens: openai.maxOutputTokens } };
      // Policy and tool definitions are runtime input, never model output.
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.callId !== callIdAt(i)) throw new HttpError(409, 'leadership_sequence_invalid');
        if (hash({ instructions: e.request.instructions, tools: e.request.tools, transport: e.request.transport }) !== hash(trusted)) throw new HttpError(409, 'leadership_policy_changed');
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
          const coverage = completionCheck ? await completionCheck({ entries, signal }) : { complete: true };
          if (coverage.complete === true) return { kind: 'model_complete', text: result.text, callId: current.callId, finalized: false,
            ...(coverage.proof ? { coverageProof: coverage.proof } : {}) };
          if (coverage.blocked) return { kind: 'blocked', reason: coverage.reason, callId: current.callId };
          // Runtime-generated continuation, never an instruction copied from
          // source text. The tentative completion remains in durable history.
          const input = [...current.request.input, ...result.output, { role: 'user', content: JSON.stringify({
            backendContinuation: { reason: coverage.reason, requiredReads: coverage.requiredReads,
              instruction: 'Die Backend-Prüfung bestätigt den Abschluss noch nicht. Lies diese Abfragen vollständig ab leerem Cursor und bearbeite neue oder geänderte Originale.' },
          }) }];
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
          const input = [...current.request.input, ...result.output,
            { type: 'function_call_output', call_id: result.toolCalls[0].callId, output: JSON.stringify(current.tool) }];
          current = { callId: callIdAt(entries.length), request: { ...trusted, input }, response: null };
        }
      } else if (!current) {
        current = { callId: callIdAt(0), request: { ...trusted, input: initialRequest?.input }, response: null };
      }
      if (entries.length >= JOURNAL_LIMITS.turns && !entries.some(e => e.callId === current.callId)) return { kind: 'blocked', reason: 'model_turn_limit' };
      checkAbort();
      const prepared = openai.prepare(current.request);
      if (current.requestHash && current.requestHash !== prepared.contentHash) throw new HttpError(409, 'leadership_request_changed');
      await journal.begin({ callId: current.callId, requestHash: prepared.contentHash, request: current.request });
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
