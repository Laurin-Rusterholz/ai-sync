export const ORIGINAL_READBACK_KINDS = Object.freeze([
  'run', 'lead', 'task', 'question', 'document', 'assignment', 'worker_result', 'note',
]);
export const validOriginalId = id => typeof id === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(id) && !id.includes('__');
