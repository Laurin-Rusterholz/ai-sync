/** Bounded, revision-consistent context reader. Partial pages never produce
 * complete context. No model calls, mutation, automatic restart or role change.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';

export async function readLeadershipContext({ gateway, query, scopeId, signal, maxPages = 100, maxBytes = 384 * 1024 } = {}) {
  if (!gateway?.execute || !['run.context', 'run.workset', 'lead.context', 'notes.recent', 'policy.current', 'run.status'].includes(query)
    || typeof scopeId !== 'string' || !scopeId || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024) throw new TypeError('context_reader_configuration_invalid');
  const items = [], seenItems = new Set(), seenCursors = new Set();
  let cursor = '', revision = null, bytes = 0, pages = 0, serverNow = null;
  const incomplete = reason => ({ complete: false, reason, query, scopeId, items, dataRevision: revision, pages, cursor, serverNow });
  while (pages < maxPages) {
    if (signal?.aborted) throw new HttpError(409, 'context_read_interrupted');
    const callId = 'ctx-' + createHash('sha256').update(JSON.stringify([query, scopeId, cursor])).digest('hex');
    const receipt = await gateway.execute({ name: query === 'run.status' ? 'quantus_run_status' : 'quantus_context',
      arguments: query === 'run.status' ? { cursor } : { query, scopeId, cursor } }, { responseId: 'context-bootstrap', callId });
    if (signal?.aborted) throw new HttpError(409, 'context_read_interrupted');
    if (!receipt.confirmed) return incomplete('page_unconfirmed');
    const page = receipt.response.body;
    if (page.query !== query || page.scopeId !== scopeId || page.count !== page.items.length) return incomplete('page_binding_invalid');
    if (revision !== null && page.dataRevision !== revision) return incomplete('data_revision_changed');
    revision = page.dataRevision; serverNow = page.serverNow; pages++;
    const pageBytes = Buffer.byteLength(JSON.stringify(page.items));
    if (bytes + pageBytes > maxBytes) return incomplete('context_byte_limit');
    if (page.items.some(item => !item || typeof item.id !== 'string' || !item.id || seenItems.has(item.id))
      || new Set(page.items.map(i => i.id)).size !== page.items.length) return incomplete('duplicate_or_invalid_item');
    for (const item of page.items) { seenItems.add(item.id); items.push(item); }
    bytes += pageBytes;
    if (page.hasMore === false) {
      if (page.complete !== true || page.pageStatus !== 'done' || page.cursor !== null) return incomplete('page_incomplete');
      return { complete: true, reason: null, query, scopeId, items, dataRevision: revision, pages, cursor: null, serverNow };
    }
    if (page.complete !== false || page.pageStatus !== 'more' || !page.items.length
      || typeof page.cursor !== 'string' || !page.cursor || seenCursors.has(page.cursor)) return incomplete('pagination_invalid');
    seenCursors.add(page.cursor); cursor = page.cursor;
  }
  return incomplete('context_page_limit');
}
