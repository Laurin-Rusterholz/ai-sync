/** OpenAI leadership transport (concept v4).
 * One paid response, never a tool executor or a retry loop. The runner must
 * reserve/claim through cost-adapter before dispatch and persist the response
 * before executing its validated calls. Source/tool content stays in input;
 * instructions and tool definitions are supplied by the trusted runtime.
 * https://developers.openai.com/api/docs/guides/function-calling
 */
import { validateSchema } from './schema.mjs';
import { createHash } from 'node:crypto';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const LEADERSHIP_TOOLS = Object.freeze(['quantus_context', 'quantus_read', 'quantus_command', 'quantus_run_status']);
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function integer(v, min, max, label) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(label);
  return v;
}

// A deliberately small strict-schema subset, identical to the local validator.
// Refuse unsupported schema constructs instead of silently ignoring constraints.
function strictSchema(rule, depth = 0) {
  if (!isRecord(rule) || depth > 12) throw new TypeError('tool_schema_invalid');
  const common = ['type', 'description'];
  const keys = { object: ['properties', 'required', 'additionalProperties'], array: ['items', 'maxItems'],
    string: ['enum', 'pattern', 'minLength', 'maxLength'], integer: ['minimum', 'maximum'], boolean: [] };
  if (!Object.hasOwn(keys, rule.type) || Object.keys(rule).some(k => ![...common, ...keys[rule.type]].includes(k))) throw new TypeError('tool_schema_unsupported');
  const result = structuredClone(rule);
  if (rule.type === 'object') {
    if (!isRecord(rule.properties) || !Array.isArray(rule.required) || rule.additionalProperties !== false
      || rule.required.length !== Object.keys(rule.properties).length || new Set(rule.required).size !== rule.required.length
      || rule.required.some(k => !Object.hasOwn(rule.properties, k))) throw new TypeError('tool_schema_not_strict');
    result.properties = Object.fromEntries(Object.entries(rule.properties).map(([k, v]) => [k, strictSchema(v, depth + 1)]));
  } else if (rule.type === 'array') result.items = strictSchema(rule.items, depth + 1);
  if (rule.pattern !== undefined) new RegExp(rule.pattern);
  return result;
}

function charge(tokens, rate) {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError('usage_invalid');
  const amount = (BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('usage_invalid');
  return Number(amount);
}

async function readJson(response, signal) {
  if (!response.body?.getReader) throw new Error('response_unreadable');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { cancel(); throw new Error('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function modelResult(body, tools) {
  if (body.status !== 'completed') return { usable: false, reason: 'response_not_completed' };
  if (!Array.isArray(body.output)) return { usable: false, reason: 'output_invalid' };
  const calls = [], texts = [], seen = new Set();
  for (const item of body.output) {
    if (!isRecord(item)) return { usable: false, reason: 'output_invalid' };
    if (item.type === 'function_call') {
      const tool = tools.find(t => t.name === item.name);
      if (!tool || !SAFE_ID.test(item.call_id ?? '') || seen.has(item.call_id) || item.status !== 'completed') return { usable: false, reason: 'tool_call_invalid' };
      let args;
      try { args = JSON.parse(item.arguments); } catch { return { usable: false, reason: 'tool_arguments_invalid' }; }
      if (!validateSchema(args, tool.parameters).ok) return { usable: false, reason: 'tool_arguments_invalid' };
      seen.add(item.call_id);
      calls.push({ callId: item.call_id, name: item.name, arguments: args });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) return { usable: false, reason: 'message_invalid' };
      for (const content of item.content) {
        if (content?.type === 'refusal') return { usable: false, reason: 'model_refusal' };
        if (content?.type !== 'output_text' || typeof content.text !== 'string') return { usable: false, reason: 'message_invalid' };
        texts.push(content.text);
      }
    } else if (item.type !== 'reasoning') return { usable: false, reason: 'output_type_not_allowed' };
  }
  if (calls.length > 1) return { usable: false, reason: 'parallel_tool_calls_not_allowed' };
  if (!calls.length && !texts.some(t => t.trim())) return { usable: false, reason: 'empty_completion' };
  return { usable: true, toolCalls: calls, text: texts.join('\n'), output: body.output };
}

export function createOpenAITransport({ apiKey, model, modelPricing, fetchImpl = fetch, maxOutputTokens = 4096, timeoutMs = 45000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof model !== 'string' || !model.trim()) throw new TypeError('openai_configuration_missing');
  integer(maxOutputTokens, 1, 100000, 'max_output_tokens_invalid');
  integer(timeoutMs, 1, 85000, 'timeout_invalid');
  const inputRate = integer(modelPricing?.inputMicrosPerMillionTokens, 0, Number.MAX_SAFE_INTEGER, 'input_price_invalid');
  const outputRate = integer(modelPricing?.outputMicrosPerMillionTokens, 0, Number.MAX_SAFE_INTEGER, 'output_price_invalid');
  const preparedRequests = new WeakMap();
  return Object.freeze({
    provider: 'openai', model, maxOutputTokens,
    prepare({ instructions, input, tools }) {
      if (typeof instructions !== 'string' || !instructions.trim() || !Array.isArray(input) || !input.length
        || !Array.isArray(tools) || !tools.length || tools.length > 4) throw new TypeError('request_invalid');
      // A context result may contain any text but cannot introduce a higher role.
      if (input.some(i => !isRecord(i) || ['system', 'developer'].includes(i.role))) throw new TypeError('input_role_invalid');
      const names = new Set();
      const definitions = tools.map(t => {
        if (!LEADERSHIP_TOOLS.includes(t.name) || names.has(t.name) || typeof t.description !== 'string') throw new TypeError('tool_not_allowed');
        names.add(t.name);
        return { type: 'function', name: t.name, description: t.description, parameters: strictSchema(t.parameters), strict: true };
      });
      const request = { model, instructions, input, tools: definitions, max_output_tokens: maxOutputTokens,
        store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false };
      const body = JSON.stringify(request);
      const bytes = Buffer.byteLength(body);
      if (bytes > MAX_REQUEST_BYTES) throw new TypeError('request_too_large');
      // Reserve conservatively for precisely these immutable bytes plus framing.
      const prepared = Object.freeze({ inputTokens: bytes + 1024, outputTokens: maxOutputTokens,
        contentHash: createHash('sha256').update(body).digest('hex') });
      preparedRequests.set(prepared, { body, definitions });
      return prepared;
    },
    async dispatch({ prepared, requestId, signal } = {}) {
      const request = preparedRequests.get(prepared);
      if (!request || !SAFE_ID.test(requestId ?? '')) throw new TypeError('prepared_request_required');
      if (signal?.aborted) return { outcome: 'unknown', reason: 'aborted_before_dispatch' };
      const controller = new AbortController();
      let rejectDeadline, timer;
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      const abort = () => { controller.abort(); rejectDeadline(new Error('timeout_or_aborted')); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, timeoutMs);
      let providerRequestId = null;
      try {
        const result = await Promise.race([deadline, (async () => {
          const response = await fetchImpl(OPENAI_RESPONSES_URL, { method: 'POST', redirect: 'error',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-client-request-id': requestId },
            body: request.body, signal: controller.signal });
          providerRequestId = response.headers?.get('x-request-id') || null;
          if (!response.ok) { void response.body?.cancel().catch(() => {}); return { outcome: 'unknown', providerRequestId, reason: `http_${response.status}` }; }
          const body = await readJson(response, controller.signal);
          if (!isRecord(body) || typeof body.id !== 'string' || !body.id || !isRecord(body.usage)) return { outcome: 'unknown', providerRequestId, reason: 'usage_missing' };
          let actualMicros;
          try {
            actualMicros = charge(body.usage.input_tokens, inputRate) + charge(body.usage.output_tokens, outputRate);
            integer(actualMicros, 0, Number.MAX_SAFE_INTEGER, 'usage_invalid');
          } catch { return { outcome: 'unknown', providerRequestId, reason: 'usage_invalid' }; }
          // Valid billed usage settles even a refused/incomplete/invalid output.
          // Such an output is never handed to the command dispatcher.
          return { outcome: 'settled', actualMicros, usageReceiptId: body.id,
            providerRequestId: providerRequestId || body.id, result: modelResult(body, request.definitions) };
        })()]);
        return result;
      } catch {
        controller.abort();
        return { outcome: 'unknown', providerRequestId, reason: 'response_unconfirmed' };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  });
}
