/** Only a validated server-side compaction item can replace earlier model
 * context. Original requests, responses and tool proofs remain in the journal.
 * This rule is NOT for standalone /responses/compact output (which must be
 * retained in full).
 * https://developers.openai.com/api/docs/guides/compaction
 */
export function validCompactionItem(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
    && item.type === 'compaction' && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 160
    && typeof item.encrypted_content === 'string' && item.encrypted_content.trim().length > 0
    && Object.keys(item).every(k => ['type', 'id', 'encrypted_content', 'created_by'].includes(k))
    && (item.created_by === undefined || typeof item.created_by === 'string');
}

export function continueLeadershipInput({ input, output, appended, compactionEnabled = false }) {
  // Never interpret nested source/tool text as a provider compaction marker.
  const cut = compactionEnabled ? output.findLastIndex(validCompactionItem) : -1;
  if (cut >= 0 && output.slice(0, cut).some(item => item.type === 'function_call'))
    throw new TypeError('compaction_after_tool_call');
  return [...(cut < 0 ? [...input, ...output] : output.slice(cut)), ...appended];
}
