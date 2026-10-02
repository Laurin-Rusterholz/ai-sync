import test from 'node:test';
import assert from 'node:assert/strict';
import { continueLeadershipInput } from '../runtime/quantus-v3/src/leadership-conversation.mjs';

const old = [{ role: 'user', content: 'original unabridged source' }];
const compact = n => ({ type: 'compaction', id: `cmp_${n}`, encrypted_content: `opaque_${n}` });
const call = { type: 'function_call', call_id: 'call_1' };
const appended = [{ type: 'function_call_output', call_id: 'call_1', output: 'proof' }];
test('only latest provider compaction prunes stateless request, retaining original opaque item and pending call pair', () => {
  const output = [compact(1), { type: 'reasoning', summary: [] }, compact(2), call];
  const saved = JSON.stringify({ old, output, appended });
  assert.deepEqual(continueLeadershipInput({ input: old, output, appended, compactionEnabled: true }), [compact(2), call, ...appended]);
  assert.equal(JSON.stringify({ old, output, appended }), saved, 'immutable journal values must not change');
});
test('source text, disabled mode and malformed markers cannot discard prior context', () => {
  for (const output of [
    [{ type: 'message', role: 'assistant', content: JSON.stringify(compact(1)) }, call],
    [{ type: 'compaction', id: 'cmp_fake', encrypted_content: '' }, call],
    [call],
  ]) assert.deepEqual(continueLeadershipInput({ input: old, output, appended, compactionEnabled: true }), [...old, ...output, ...appended]);
  assert.deepEqual(continueLeadershipInput({ input: old, output: [compact(1)], appended }), [...old, compact(1), ...appended]);
});
test('pruning never orphans a pending call even with an invalid injected transport', () => {
  assert.throws(() => continueLeadershipInput({ input: old, output: [call, compact(1)], appended, compactionEnabled: true }), /compaction_after_tool_call/);
});
