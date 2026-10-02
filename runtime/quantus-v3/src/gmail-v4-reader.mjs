/** Read-only, account-bound Gmail source for v4. No cursor is committed here:
 * the durable importer must persist each original before advancing a page or
 * history watermark. A history 404 requests a full rescan, never an empty sync.
 * Mail, headers, HTML and attachment names are untrusted source data.
 */
import { HttpError } from './errors.mjs';

export const GMAIL_V4_ORIGIN = 'https://gmail.googleapis.com/gmail/v1';
export const GMAIL_V4_QUERY = '-in:chats -in:spam -in:trash';
export const GMAIL_V4_LIMITS = Object.freeze({ responseBytes: 8 * 1024 * 1024,
  decodedBytes: 6 * 1024 * 1024, mimeParts: 1000, mimeDepth: 32, pageSize: 100, timeoutMs: 20000 });
const fail = (code, status = 502) => { throw new HttpError(status, `gmail_v4_${code}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const historyId = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const opaque = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x20\x7f]/.test(v);
const headersValid = v => Array.isArray(v) && v.every(h => object(h) && typeof h.name === 'string' && typeof h.value === 'string');
const array = (v, validate) => v === undefined ? [] : Array.isArray(v) && v.every(validate) ? v : fail('response_invalid');
function nextToken(body) {
  if (body.nextPageToken === undefined) return null;
  if (!opaque(body.nextPageToken)) fail('response_invalid');
  return body.nextPageToken;
}
function base64Bytes(data, size) {
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)
    || !Number.isSafeInteger(size) || size < 0) fail('body_encoding_invalid');
  const bytes = Buffer.from(data, 'base64url');
  if ((data.includes('=') && data.length % 4 !== 0)
    || bytes.toString('base64url') !== data.replace(/=+$/, '') || bytes.length !== size) fail('body_encoding_invalid');
  return bytes;
}

export function createGmailV4Reader({ account, getAccessToken, fetchImpl = globalThis.fetch,
  timeoutMs = GMAIL_V4_LIMITS.timeoutMs } = {}) {
  if (typeof account !== 'string' || account !== account.trim() || account.length > 254
    || !/^[^\s/@?#]+@[^\s/@?#]+\.[^\s/@?#]+$/.test(account)
    || typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 85000) fail('configuration_invalid', 503);
  account = account.toLowerCase();
  const base = `${GMAIL_V4_ORIGIN}/users/${encodeURIComponent(account)}`;

  // The deadline includes token acquisition, response headers and streamed
  // body. Even a broken token/fetch implementation that ignores AbortSignal
  // cannot keep this phase alive or cause a later request after expiry.
  async function get(path, query, signal) {
    if (signal?.aborted) fail('interrupted', 409);
    const abort = new AbortController();
    let reader, rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    function stop(code, status) {
      abort.abort();
      if (reader) void reader.cancel().catch(() => {});
      rejectDeadline(new HttpError(status, `gmail_v4_${code}`));
    }
    const interrupt = () => stop('interrupted', 409);
    signal?.addEventListener('abort', interrupt, { once: true });
    const timer = setTimeout(() => stop('timeout', 504), timeoutMs);
    const active = () => { if (abort.signal.aborted || signal?.aborted) fail('interrupted', 409); };
    try {
      return await Promise.race([deadline, (async () => {
        let credential;
        try { credential = await getAccessToken({ signal: abort.signal }); } catch { fail('auth_unavailable', 503); }
        active();
        if (typeof credential?.token !== 'string' || !credential.token || /[\r\n]/.test(credential.token)) fail('auth_unavailable', 503);
        const url = new URL(base + path);
        for (const [key, value] of Object.entries(query || {})) if (value !== null) url.searchParams.set(key, String(value));
        let response;
        try { response = await fetchImpl(url.href, { method: 'GET', redirect: 'error',
          headers: { authorization: `Bearer ${credential.token}`, accept: 'application/json' }, signal: abort.signal }); }
        catch { fail('request_failed'); }
        active();
        if (!Number.isInteger(response?.status)) fail('response_invalid');
        // Error bodies can contain provider credentials, user data or HTML.
        // Never read them or repeat them in a diagnostic.
        if (response.status !== 200) {
          if (response.body?.cancel) void response.body.cancel().catch(() => {});
          if (response.status === 404) return { notFound: true };
          if (response.status === 401 || response.status === 403) fail('auth_rejected', 403);
          if (response.status === 429) fail('rate_limited', 429);
          fail('request_failed');
        }
        if (!response.body?.getReader) fail('response_invalid');
        const length = response.headers?.get('content-length');
        if (length && /^\d+$/.test(length) && Number(length) > GMAIL_V4_LIMITS.responseBytes) {
          void response.body.cancel().catch(() => {});
          fail('response_too_large', 413);
        }
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            active();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > GMAIL_V4_LIMITS.responseBytes) {
              void reader.cancel().catch(() => {});
              fail('response_too_large', 413);
            }
            chunks.push(Buffer.from(part.value));
          }
        } finally { reader.releaseLock(); reader = null; }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { fail('response_invalid'); }
        if (!object(body)) fail('response_invalid');
        return { body };
      })()]);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail('response_unreadable');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', interrupt); }
  }

  async function attachment({ messageId, attachmentId, signal }) {
    if (!id(messageId) || !opaque(attachmentId)) fail('attachment_identity_invalid', 400);
    const result = await get(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {}, signal);
    if (result.notFound) return { missing: true };
    const bytes = base64Bytes(result.body.data, result.body.size);
    if (bytes.length > GMAIL_V4_LIMITS.decodedBytes) fail('decoded_too_large', 413);
    return { missing: false, bytes, original: result.body };
  }

  async function messageOperation(signal, work) {
    if (signal?.aborted) fail('interrupted', 409);
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const interrupt = () => {
      controller.abort(); rejectDeadline(new HttpError(409, 'gmail_v4_interrupted'));
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    const timer = setTimeout(() => {
      // Reject with the overall deadline before the nested request observes
      // the propagated abort, so the diagnostic remains deterministic.
      rejectDeadline(new HttpError(504, 'gmail_v4_timeout')); controller.abort();
    }, timeoutMs);
    try { return await Promise.race([deadline, work(controller.signal)]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', interrupt); }
  }

  return Object.freeze({
    account, query: GMAIL_V4_QUERY,
    async profile({ signal } = {}) {
      const result = await get('/profile', {}, signal);
      if (result.notFound || typeof result.body.emailAddress !== 'string'
        || result.body.emailAddress.toLowerCase() !== account) fail('account_mismatch', 403);
      if (!historyId(result.body.historyId)) fail('response_invalid');
      return { account, historyId: result.body.historyId };
    },
    async listPage({ pageToken = null, signal } = {}) {
      if (pageToken !== null && !opaque(pageToken)) fail('page_token_invalid', 400);
      const result = await get('/messages', { q: GMAIL_V4_QUERY, maxResults: GMAIL_V4_LIMITS.pageSize, pageToken }, signal);
      if (result.notFound) fail('mailbox_unavailable');
      const messages = array(result.body.messages, m => object(m) && id(m.id) && id(m.threadId));
      return { ids: [...new Set(messages.map(m => m.id))], nextPageToken: nextToken(result.body) };
    },
    async historyPage({ startHistoryId, pageToken = null, signal } = {}) {
      if (!historyId(startHistoryId) || (pageToken !== null && !opaque(pageToken))) fail('history_cursor_invalid', 400);
      const result = await get('/history', { startHistoryId, pageToken, maxResults: GMAIL_V4_LIMITS.pageSize }, signal);
      if (result.notFound) return { resetRequired: true };
      const body = result.body;
      if (!historyId(body.historyId) || BigInt(body.historyId) < BigInt(startHistoryId)) fail('history_regressed');
      const history = array(body.history, h => object(h) && historyId(h.id));
      const changed = new Map(); let previous = BigInt(startHistoryId);
      for (const row of history) {
        if (BigInt(row.id) <= previous || BigInt(row.id) > BigInt(body.historyId)) fail('history_regressed');
        previous = BigInt(row.id);
        let rowChanges = 0;
        function remember(message, kind) {
          if (!object(message) || !id(message.id)) fail('response_invalid');
          rowChanges++;
          const old = changed.get(message.id) || { id: message.id, changes: [], historyIds: [] };
          if (!old.changes.includes(kind)) old.changes.push(kind);
          if (!old.historyIds.includes(row.id)) old.historyIds.push(row.id);
          changed.set(message.id, old);
        }
        // All change classes, including label removal/deletion, matter. The
        // generic list also covers future changes rather than dropping them.
        for (const message of array(row.messages, object)) remember(message, 'changed');
        for (const kind of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'])
          for (const event of array(row[kind], object)) remember(event.message, kind);
        if (!rowChanges) fail('response_invalid');
      }
      return { resetRequired: false, changes: [...changed.values()], historyId: body.historyId,
        nextPageToken: nextToken(body) };
    },
    getAttachment: attachment,
    async getMessage({ messageId, signal: parentSignal } = {}) {
      return messageOperation(parentSignal, async signal => {
        if (!id(messageId)) fail('message_identity_invalid', 400);
        const result = await get(`/messages/${encodeURIComponent(messageId)}`, { format: 'full' }, signal);
        if (result.notFound) return { missing: true, id: messageId };
        const original = result.body;
        if (original.id !== messageId || !id(original.threadId) || !historyId(original.historyId)
          || typeof original.internalDate !== 'string' || !/^\d+$/.test(original.internalDate)
          || !Number.isSafeInteger(Number(original.internalDate)) || !object(original.payload)) fail('message_invalid');
        const labels = array(original.labelIds, v => typeof v === 'string');
        const parts = [], attachments = [], gaps = [], detachedBodies = [];
        let partCount = 0, decodedSize = 0;
        async function visit(part, path, depth) {
          if (++partCount > GMAIL_V4_LIMITS.mimeParts || depth > GMAIL_V4_LIMITS.mimeDepth) fail('mime_limit_exceeded', 413);
          if (!object(part) || typeof part.mimeType !== 'string' || !object(part.body)
            || (part.filename !== undefined && typeof part.filename !== 'string')
            || (part.headers !== undefined && !headersValid(part.headers))) fail('mime_invalid');
          const children = array(part.parts, object), mime = part.mimeType.toLowerCase();
          const location = { path, partId: typeof part.partId === 'string' ? part.partId : null, mimeType: part.mimeType };
          const filename = part.filename || '';
          const contentDisposition = (part.headers || []).find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
          const isAttachment = !!filename || /^attachment\s*(?:;|$)/i.test(contentDisposition.trim());
          if (isAttachment || (!mime.startsWith('multipart/') && !['text/plain', 'text/html'].includes(mime))) {
            attachments.push({ ...location, filename, size: part.body.size ?? null,
              attachmentId: part.body.attachmentId ?? null, status: 'unread' });
            gaps.push({ ...location, reason: 'attachment_unread' });
            return; // e.g. message/rfc822 children belong to the attachment.
          }
          if (mime.startsWith('multipart/')) {
            if (!children.length) gaps.push({ ...location, reason: 'multipart_empty' });
            for (let i = 0; i < children.length; i++) await visit(children[i], `${path}.${i}`, depth + 1);
            return;
          }
          if (children.length) fail('mime_invalid');
          let bytes;
          if (part.body.data !== undefined) bytes = base64Bytes(part.body.data, part.body.size);
          else if (part.body.attachmentId) {
            const fetched = await attachment({ messageId, attachmentId: part.body.attachmentId, signal });
            if (fetched.missing) { gaps.push({ ...location, reason: 'body_missing' }); return; }
            bytes = fetched.bytes;
            if (bytes.length !== part.body.size) fail('body_size_mismatch');
            detachedBodies.push({ ...location, attachmentId: part.body.attachmentId, original: fetched.original });
          } else if (part.body.size === 0) bytes = Buffer.alloc(0);
          else { gaps.push({ ...location, reason: 'body_missing' }); return; }
          decodedSize += bytes.length;
          if (decodedSize > GMAIL_V4_LIMITS.decodedBytes) fail('decoded_too_large', 413);
          const contentType = (part.headers || []).find(h => h.name.toLowerCase() === 'content-type')?.value || '';
          const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
          let text;
          try { text = new TextDecoder(charset?.[1] || charset?.[2] || 'utf-8', { fatal: true }).decode(bytes); }
          catch { gaps.push({ ...location, reason: 'text_encoding_unreadable' }); return; }
          parts.push({ ...location, text });
        }
        await visit(original.payload, '0', 0);
        const headers = original.payload.headers || [];
        const header = name => headers.filter(h => h.name.toLowerCase() === name).map(h => h.value);
        return { missing: false, account, id: messageId, threadId: original.threadId, historyId: original.historyId,
          internalDate: original.internalDate, labels, subject: header('subject'), from: header('from'), to: header('to'),
          messageIds: header('message-id'), parts, attachments, gaps, detachedBodies, partial: gaps.length > 0,
          // All variants and the complete original are retained. HTML is never
          // rendered and a text/plain alternative never hides an unread HTML part.
          original };
      });
    },
  });
}
