import { createHash } from 'node:crypto';

/** Read all pages before the caller journals the tool result. Journal/cost
 * writes increment dataRevision and would invalidate a cursor between model
 * turns. Limits and concurrent changes remain incomplete, never successful.
 */
export async function completeToolRead({ first, query, scopeId, cursor = '', next, signal,
  maxBytes = 384 * 1024, maxPages = 100 }) {
  const items = [], ids = new Set(), cursors = new Set(), readPages = [];
  let response = first, revision = null, bytes = 0;
  const incomplete = reason => {
    const b = response?.body;
    // Never try to journal an oversized rejected source page. Retain bounded
    // provenance and the failure, not a silently truncated successful context.
    return { response: { status: response?.status ?? 502, body: {
      ok: false, error: reason, query, scopeId, items: [], count: 0, complete: false,
      hasMore: b?.hasMore === true, pageStatus: 'partial', pageReason: reason,
      cursor: typeof b?.cursor === 'string' && b.cursor.length <= 4096 ? b.cursor : null,
      dataRevision: Number.isSafeInteger(b?.dataRevision) ? b.dataRevision : null,
      requestId: typeof b?.requestId === 'string' ? b.requestId.slice(0, 200) : null,
      serverNow: typeof b?.serverNow === 'string' ? b.serverNow.slice(0, 40) : null,
    } }, readPages, readFailure: reason, readComplete: false };
  };
  for (let n = 0; n < maxPages; n++) {
    if (signal?.aborted) return incomplete('read_interrupted');
    const body = response?.body;
    if (response?.status !== 200 || body?.ok !== true || body.query !== query || body.scopeId !== scopeId
      || typeof body.requestId !== 'string' || !body.requestId || typeof body.serverNow !== 'string'
      || !Number.isFinite(Date.parse(body.serverNow)) || !Number.isSafeInteger(body.dataRevision) || body.dataRevision < 0
      || !Array.isArray(body.items) || body.count !== body.items.length) return incomplete('read_page_invalid');
    if (revision !== null && body.dataRevision !== revision) return incomplete('read_revision_changed');
    revision = body.dataRevision;
    bytes += Buffer.byteLength(JSON.stringify(body));
    if (bytes > maxBytes) return incomplete('read_byte_limit');
    if (body.items.some(item => !item || typeof item.id !== 'string' || !item.id || ids.has(item.id))
      || new Set(body.items.map(item => item.id)).size !== body.items.length) return incomplete('read_identity_invalid');
    for (const item of body.items) { ids.add(item.id); items.push(item); }
    readPages.push({ requestId: body.requestId, dataRevision: revision, count: body.count,
      hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
    if (body.hasMore === false) {
      if (body.complete !== true || body.pageStatus !== 'done' || body.cursor !== null) return incomplete('read_page_incomplete');
      // A supplied cursor represents a suffix, never the entire workset.
      return { response: { ...response, body: { ...body, items, count: items.length,
        assembled: true, pageCount: readPages.length,
        entityVersions: Object.fromEntries(items.filter(i => Number.isSafeInteger(i.entityVersion)).map(i => [i.id, i.entityVersion])) } },
        readPages, readComplete: cursor === '', ...(cursor ? { readFailure: 'read_started_midstream' } : {}) };
    }
    if (body.hasMore !== true || body.complete !== false || body.pageStatus !== 'more'
      || !body.items.length || typeof body.cursor !== 'string' || !body.cursor || cursors.has(body.cursor))
      return incomplete('read_pagination_invalid');
    cursors.add(body.cursor);
    if (n + 1 >= maxPages) return incomplete('read_page_limit');
    try { response = await next(body.cursor); }
    catch { return incomplete(signal?.aborted ? 'read_interrupted' : 'read_page_unavailable'); }
  }
  return incomplete('read_page_limit');
}
