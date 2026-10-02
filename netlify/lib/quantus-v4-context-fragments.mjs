import { createHash } from 'node:crypto';
const digest = text => createHash('sha256').update(text).digest('hex');
const identity = ['kind', 'tenant', 'ownerId', 'runId', 'jobId', 'entityVersion'];
const fragmentId = (id, index) => `fragment_${digest(id)}_${index}`;

/** Keep C2 pages within their transport envelope without truncating a large
 * original. Identity/authority remain on every fragment for normal C2 checks.
 */
export function fragmentContextItems(items, project = item => item) {
  return items.flatMap(item => {
    const visible = project(item);
    if (!visible || visible.id !== item.id) throw new TypeError('context_projection_incomplete');
    const text = JSON.stringify(visible);
    if (Buffer.byteLength(text) <= 96 * 1024) return [item];
    const chunks = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 12000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(start, end)); start = end;
    }
    const hash = digest(text), binding = Object.fromEntries(identity.filter(k => Object.hasOwn(item, k)).map(k => [k, item[k]]));
    return chunks.map((text, index) => ({ ...binding, id: fragmentId(item.id, index),
      contextFragment: { originalId: item.id, hash, index, count: chunks.length, text } }));
  });
}

export function assembleContextItems(items) {
  const originals = [], ids = new Set();
  for (let offset = 0; offset < items.length;) {
    const first = items[offset], f = first?.contextFragment;
    let original = first;
    if (f !== undefined) {
      if (!f || f.index !== 0 || !Number.isSafeInteger(f.count) || f.count < 1 || f.count > items.length - offset
        || typeof f.originalId !== 'string' || typeof f.hash !== 'string' || !/^[a-f0-9]{64}$/.test(f.hash))
        throw new TypeError('context_fragments_incomplete');
      const chunks = [];
      for (let index = 0; index < f.count; index++) {
        const item = items[offset + index], p = item?.contextFragment;
        if (!p || p.index !== index || p.count !== f.count || p.originalId !== f.originalId || p.hash !== f.hash
          || typeof p.text !== 'string' || item.id !== fragmentId(f.originalId, index)
          || identity.some(k => item[k] !== first[k])) throw new TypeError('context_fragments_invalid');
        chunks.push(p.text);
      }
      const text = chunks.join('');
      if (digest(text) !== f.hash) throw new TypeError('context_fragments_hash_mismatch');
      original = JSON.parse(text);
      if (original.id !== f.originalId || identity.some(k => original[k] !== first[k]) || original.contextFragment !== undefined)
        throw new TypeError('context_fragments_binding_invalid');
      offset += f.count;
    } else offset++;
    if (!original || typeof original.id !== 'string' || ids.has(original.id)) throw new TypeError('context_original_duplicate');
    ids.add(original.id); originals.push(original);
  }
  return originals;
}
