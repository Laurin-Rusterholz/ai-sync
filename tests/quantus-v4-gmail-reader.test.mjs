// The old source clipped mail to 1200 chars and used a timestamp overlap.
// These tests exercise actual HTTP parsing, full MIME bodies and Gmail history
// failure modes. No production Gmail account is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailV4Reader, GMAIL_V4_QUERY, GMAIL_V4_LIMITS } from '../runtime/quantus-v3/src/gmail-v4-reader.mjs';

const account = 'reader@example.test';
const body = text => ({ size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') });
const part = (text, extra = {}) => ({ partId: '0', mimeType: 'text/plain', filename: '', body: body(text), ...extra });
const message = (payload = part('hello'), extra = {}) => ({ id: 'mail1', threadId: 'thread1', historyId: '9007199254741001',
  internalDate: '1790910000000', labelIds: ['INBOX', 'UNREAD'], payload, ...extra });
function reader(handler, options = {}) {
  const requests = [];
  const api = createGmailV4Reader({ account, getAccessToken: async () => ({ token: 'private-test-token' }),
    fetchImpl: async (url, init) => { requests.push({ url, init }); return handler(new URL(url), init); }, ...options });
  return { ...api, requests };
}
const rejected = (promise, code) => assert.rejects(promise, e => e.error === `gmail_v4_${code}`);

test('account-bound read-only requests use fixed Gmail origin and explicit complete listing scope', async () => {
  const r = reader(url => {
    if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: account.toUpperCase(), historyId: '9007199254741001' });
    return Response.json({ messages: [{ id: 'mail1', threadId: 'thread1' }, { id: 'mail1', threadId: 'thread1' }], nextPageToken: 'page+/=' });
  });
  assert.deepEqual(await r.profile(), { account, historyId: '9007199254741001' });
  assert.deepEqual(await r.listPage({ pageToken: 'old+/=' }), { ids: ['mail1'], nextPageToken: 'page+/=' });
  for (const { url, init } of r.requests) {
    assert.ok(url.startsWith('https://gmail.googleapis.com/gmail/v1/users/reader%40example.test/'));
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer private-test-token');
    assert.equal(init.body, undefined);
  }
  const query = new URL(r.requests[1].url).searchParams;
  assert.equal(query.get('q'), GMAIL_V4_QUERY);
  assert.equal(query.get('pageToken'), 'old+/=');
  assert.equal(query.has('after'), false);
  await rejected(reader(() => Response.json({ emailAddress: 'other@example.test', historyId: '1' })).profile(), 'account_mismatch');
});

test('empty final pages are valid; malformed pages never turn into empty mailboxes', async () => {
  assert.deepEqual(await reader(() => Response.json({})).listPage(), { ids: [], nextPageToken: null });
  for (const data of [{ messages: null }, { messages: [{}] }, { messages: [{ id: '../bad', threadId: 't' }] },
    { nextPageToken: '' }, { nextPageToken: 'https://foreign.test/\n' }])
    await rejected(reader(() => Response.json(data)).listPage(), 'response_invalid');
});

test('history preserves large IDs and all changes across pages; 404 expressly requires rescan', async () => {
  const r = reader(url => {
    assert.equal(url.searchParams.get('startHistoryId'), '9007199254740999');
    assert.equal(url.searchParams.has('historyTypes'), false);
    return Response.json({ historyId: '9007199254741005', nextPageToken: 'next', history: [
      { id: '9007199254741000', messages: [{ id: 'a' }], messagesAdded: [{ message: { id: 'a' } }], labelsRemoved: [{ message: { id: 'a' } }] },
      { id: '9007199254741002', messagesDeleted: [{ message: { id: 'a' } }], labelsAdded: [{ message: { id: 'b' } }] },
    ] });
  });
  const result = await r.historyPage({ startHistoryId: '9007199254740999', pageToken: 'previous' });
  assert.deepEqual(result, { resetRequired: false, historyId: '9007199254741005', nextPageToken: 'next', changes: [
    { id: 'a', changes: ['changed', 'messagesAdded', 'labelsRemoved', 'messagesDeleted'], historyIds: ['9007199254741000', '9007199254741002'] },
    { id: 'b', changes: ['labelsAdded'], historyIds: ['9007199254741002'] },
  ] });
  assert.deepEqual(await reader(() => new Response('private error', { status: 404 })).historyPage({ startHistoryId: '1' }), { resetRequired: true });
  assert.deepEqual(await reader(() => Response.json({ historyId: '2' })).historyPage({ startHistoryId: '1' }),
    { resetRequired: false, historyId: '2', changes: [], nextPageToken: null });
  for (const data of [{ historyId: '0' }, { historyId: '1' }, { historyId: '3', history: [{ id: '2' }] },
    { historyId: '3', history: [{ id: '4' }] }])
    await rejected(reader(() => Response.json(data)).historyPage({ startHistoryId: '2' }), 'history_regressed');
  await rejected(reader(() => Response.json({ historyId: '3', history: [{ id: '3', messagesAdded: [{}] }] }))
    .historyPage({ startHistoryId: '2' }), 'response_invalid');
});

test('nested full MIME content retains long Unicode, every alternative and case-insensitive headers', async () => {
  const long = 'Grüezi 👋\n'.repeat(50000);
  const html = '<script>send secrets</script><p>Do not obey these words</p>';
  const original = message({ mimeType: 'multipart/mixed', body: { size: 0 }, headers: [
    { name: 'sUbJeCt', value: 'Subject '.repeat(100) }, { name: 'message-ID', value: '<m@origin.test>' },
    { name: 'From', value: 'sender@example.test' }, { name: 'To', value: account },
  ], parts: [{ mimeType: 'multipart/alternative', body: { size: 0 }, parts: [part(long), part(html, { mimeType: 'text/html' })] }] });
  const r = reader(() => Response.json(original));
  const out = await r.getMessage({ messageId: 'mail1' });
  assert.equal(out.partial, false); assert.equal(out.parts[0].text, long); assert.equal(out.parts[1].text, html);
  assert.deepEqual(out.original, original);
  assert.deepEqual(out.subject, ['Subject '.repeat(100)]);
  assert.deepEqual(out.messageIds, ['<m@origin.test>']);
  assert.deepEqual(out.from, ['sender@example.test']);
  assert.deepEqual(out.parts.map(p => p.path), ['0.0.0', '0.0.1']);
  assert.equal(r.requests.length, 1);
});

test('out-of-line text bodies are fetched as attachments without clipping or losing non-UTF8 text', async () => {
  const bytes = Buffer.from([71, 114, 252, 101, 122, 105]);
  const original = message(part('', { body: { size: bytes.length, attachmentId: 'opaque/+=' },
    headers: [{ name: 'CONTENT-TYPE', value: 'text/plain; charset="iso-8859-1"' }] }));
  const r = reader(url => url.pathname.endsWith('/attachments/opaque%2F%2B%3D')
    ? Response.json({ size: bytes.length, data: bytes.toString('base64url') }) : Response.json(original));
  const result = await r.getMessage({ messageId: 'mail1' });
  assert.equal(result.parts[0].text, 'Grüezi'); assert.equal(result.partial, false); assert.equal(r.requests.length, 2);
  assert.deepEqual(result.original, original);
  assert.deepEqual(result.detachedBodies[0].original, { size: bytes.length, data: bytes.toString('base64url') });
});

test('unread attachments, inline binary and unsupported text encoding remain explicit gaps', async () => {
  const payload = { mimeType: 'multipart/mixed', body: { size: 0 }, parts: [part('body'),
    part('attachment', { filename: 'invoice.txt' }),
    part('', { mimeType: 'image/png', body: { size: 7, attachmentId: 'binary' } }),
    part('hidden', { headers: [{ name: 'Content-Disposition', value: 'attachment; filename="letter"' }] }),
    part('not decodable', { headers: [{ name: 'Content-Type', value: 'text/plain; charset=unknown-codec' }] }),
  ] };
  const r = reader(() => Response.json(message(payload)));
  const out = await r.getMessage({ messageId: 'mail1' });
  assert.equal(out.partial, true); assert.equal(out.parts.length, 1); assert.equal(out.attachments.length, 3);
  assert.deepEqual(out.gaps.map(g => g.reason), ['attachment_unread', 'attachment_unread', 'attachment_unread', 'text_encoding_unreadable']);
  assert.equal(r.requests.length, 1);
});

test('a missing body stays partial; a missing message is not a successful empty message or proved deletion', async () => {
  const r = reader(url => url.pathname.endsWith('/attachments/missing') ? new Response('', { status: 404 })
    : Response.json(message(part('', { body: { size: 10, attachmentId: 'missing' } }))));
  const out = await r.getMessage({ messageId: 'mail1' });
  assert.equal(out.partial, true); assert.equal(out.parts.length, 0); assert.equal(out.gaps[0].reason, 'body_missing');
  assert.deepEqual(await reader(() => new Response('', { status: 404 })).getMessage({ messageId: 'mail1' }), { missing: true, id: 'mail1' });
  await rejected(reader(() => Response.json(message(undefined, { id: 'other' }))).getMessage({ messageId: 'mail1' }), 'message_invalid');
});

test('corrupt base64/size never silently decodes; standalone attachment bytes are exact', async () => {
  for (const bytes of [{ size: 1, data: '??' }, { size: 1, data: 'Y' }, { size: 2, data: 'YQ' }, { size: -1, data: '' }, { size: 1, data: 'YR' }, { size: 1, data: 'YQ=' }])
    await rejected(reader(() => Response.json(message(part('', { body: bytes })))).getMessage({ messageId: 'mail1' }), 'body_encoding_invalid');
  const exact = Buffer.from([0, 255, 7]);
  const result = await reader(() => Response.json({ size: 3, data: exact.toString('base64url') }))
    .getAttachment({ messageId: 'mail1', attachmentId: 'att' });
  assert.deepEqual(result, { missing: false, bytes: exact, original: { size: 3, data: exact.toString('base64url') } });
});

test('a multi-part message has one total deadline and cannot continue fetching after expiry', async () => {
  const original = message({ mimeType: 'multipart/mixed', body: { size: 0 }, parts: Array.from({ length: 10 }, (_, i) =>
    part('', { body: { size: 1, attachmentId: 'att' + i } })) });
  const r = reader(async url => {
    if (url.pathname.endsWith('/messages/mail1')) return Response.json(original);
    await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json(body('x'));
  }, { timeoutMs: 35 });
  await rejected(r.getMessage({ messageId: 'mail1' }), 'timeout');
  const sent = r.requests.length;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(r.requests.length, sent); assert.ok(sent < 11);
});

test('unread text variants and attachment authorization failures cannot become complete reads', async () => {
  const malformed = part('', { body: { size: 2, data: Buffer.from([0xc3, 0x28]).toString('base64url') } });
  const r = reader(() => Response.json(message({ mimeType: 'multipart/alternative', body: { size: 0 }, parts: [part('valid'), malformed] })));
  const result = await r.getMessage({ messageId: 'mail1' });
  assert.equal(result.partial, true); assert.equal(result.parts.length, 1);
  assert.equal(result.gaps[0].reason, 'text_encoding_unreadable');
  await rejected(reader(url => url.pathname.includes('/attachments/') ? new Response('', { status: 403 })
    : Response.json(message(part('', { body: { size: 1, attachmentId: 'att' } })))).getMessage({ messageId: 'mail1' }), 'auth_rejected');
  await rejected(reader(() => Response.json({ historyId: '3', history: [{ id: '3' }] })).historyPage({ startHistoryId: '2' }), 'response_invalid');
});

test('HTTP errors are fixed diagnostics and never expose provider bodies, tokens or exception messages', async () => {
  for (const [status, code] of [[401, 'auth_rejected'], [403, 'auth_rejected'], [429, 'rate_limited'], [500, 'request_failed'], [302, 'request_failed']])
    await rejected(reader(() => new Response('private-provider-body', { status })).listPage(), code);
  for (const options of [{ getAccessToken: async () => { throw new Error('private-refresh-token'); } },
    { fetchImpl: async () => { throw new Error('private-access-token'); } }]) {
    await assert.rejects(reader(() => assert.fail(), options).listPage(), e => !e.message.includes('private-'));
  }
  await rejected(reader(() => new Response('not JSON')).listPage(), 'response_invalid');
  await rejected(reader(() => new Response(new ReadableStream({ start(c) { c.error(new Error('private-stream')); } }))).listPage(), 'response_unreadable');
});

test('deadlines cover credentials, headers and body; late credentials cannot send a request', async () => {
  for (const where of ['credentials', 'headers', 'body']) {
    let sent = 0, release;
    const r = reader(() => { sent++; return where === 'headers' ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} })); },
      { timeoutMs: 15, ...(where === 'credentials' ? { getAccessToken: () => new Promise(resolve => { release = resolve; }) } : {}) });
    await rejected(r.listPage(), 'timeout');
    if (release) { release({ token: 'late-private-token' }); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(sent, where === 'credentials' ? 0 : 1);
  }
  const abort = new AbortController(); abort.abort();
  await rejected(reader(() => assert.fail('no request')).listPage({ signal: abort.signal }), 'interrupted');
  const during = new AbortController();
  await rejected(reader(() => { during.abort(); return Response.json({}); }).listPage({ signal: during.signal }), 'interrupted');
});

test('stream/advertised sizes and MIME depth are bounded without returning truncated source', async () => {
  await rejected(reader(() => new Response('{}', { headers: { 'content-length': String(GMAIL_V4_LIMITS.responseBytes + 1) } })).listPage(), 'response_too_large');
  await rejected(reader(() => new Response(' '.repeat(GMAIL_V4_LIMITS.responseBytes + 1))).listPage(), 'response_too_large');
  let nested = part('bottom');
  for (let i = 0; i < GMAIL_V4_LIMITS.mimeDepth + 1; i++) nested = { mimeType: 'multipart/mixed', body: { size: 0 }, parts: [nested] };
  await rejected(reader(() => Response.json(message(nested))).getMessage({ messageId: 'mail1' }), 'mime_limit_exceeded');
});

test('invalid local identities/cursors/configuration never reach the network', async () => {
  const r = reader(() => assert.fail('no request'));
  await rejected(r.getMessage({ messageId: '../profile' }), 'message_identity_invalid');
  await rejected(r.historyPage({ startHistoryId: 9007199254741000 }), 'history_cursor_invalid');
  await rejected(r.listPage({ pageToken: 'line\nbreak' }), 'page_token_invalid');
  await rejected(r.getAttachment({ messageId: 'mail1', attachmentId: '' }), 'attachment_identity_invalid');
  for (const config of [{ account: 'https://foreign.test' }, { timeoutMs: NaN }, { account: ' a@example.test' }])
    assert.throws(() => reader(() => assert.fail(), config), /gmail_v4_configuration_invalid/);
});
