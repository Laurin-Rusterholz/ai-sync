import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailSourceSync } from '../runtime/quantus-v3/src/gmail-source-sync.mjs';
import { createGmailV4Reader } from '../runtime/quantus-v3/src/gmail-v4-reader.mjs';
import { setup, RUN, T } from './fixtures/quantus-v4-leadership-fixture.mjs';
import { startRunSection } from '../netlify/lib/quantus-v3-runtime-state.mjs';
import { casMutate } from './quantus-v3-runtime-cas-harness.mjs';

const account = 'reader@example.test';
const message = (id, historyId = '110', partial = false) => ({ id, threadId: 'thread1', historyId, internalDate: '1790910000000',
  payload: { mimeType: 'text/plain', filename: partial ? 'attachment.txt' : '', body: { size: 4, data: 'bWFpbA' } } });
async function build(handler) {
  const f = await setup(), calls = [];
  const reader = createGmailV4Reader({ account, getAccessToken: async () => ({ token: 'fixture' }), fetchImpl: async (url, init) => {
    const u = new URL(url); calls.push(u); return handler(u, init);
  } });
  const config = { reader, core: f.core, clock: f.clock, artifacts: f.artifacts.store, tenant: 'quantus', account,
    sourceId: 'gmail-inbox', runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope };
  const make = extra => createGmailSourceSync({ ...config, ...extra });
  return { ...f, calls, config, make, step: () => make().next(),
    state: () => Object.values(f.store.snapshot().automation.runtime.gmailSync?.sources || {})[0],
    records: () => Object.values(f.store.snapshot().automation.runtime.gmailRegistry?.sources || {})[0]?.records || {} };
}
async function finish(f, extra = {}) {
  for (let i = 0; i < 100; i++) { const result = await f.make(extra).next(); if (result.done) return result; }
  assert.fail('source did not finish');
}
const emptyHandler = url => {
  if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: account, historyId: '100' });
  if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] });
  if (url.pathname.endsWith('/history')) return Response.json({ historyId: '120' });
  return Response.json(message(url.pathname.split('/').at(-1)));
};

test('full scan, all pages, individual registrations and catch-up survive a fresh worker each step', async () => {
  const f = await build(url => {
    if (url.pathname.endsWith('/messages')) return Response.json(url.searchParams.get('pageToken') === 'second'
      ? { messages: [{ id: 'b', threadId: 'thread1' }] } : { messages: [{ id: 'a', threadId: 'thread1' }], nextPageToken: 'second' });
    if (url.pathname.endsWith('/history')) {
      assert.equal(url.searchParams.get('startHistoryId'), '100');
      return Response.json({ historyId: '130', history: [{ id: '125', messagesAdded: [{ message: { id: 'c' } }], labelsAdded: [{ message: { id: 'a' } }] }] });
    }
    return emptyHandler(url);
  });
  const result = await finish(f);
  assert.equal(result.historyId, '130'); assert.equal(result.partial, false);
  assert.deepEqual(Object.values(f.records()).map(r => r.messageId).sort(), ['a', 'b', 'c']);
  assert.equal(Object.values(f.records()).find(r => r.messageId === 'a').version, 1);
  const count = f.calls.length;
  assert.equal((await f.step()).done, true); assert.equal(f.calls.length, count);
  assert.equal(f.store.snapshot().automation.sourceCursors, undefined); // no daily source success forged
});

test('watermark remains unpromoted until every message of the final history page is registered', async () => {
  const f = await build(url => url.pathname.endsWith('/history')
    ? Response.json({ historyId: '120', history: [{ id: '110', messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] }] }) : emptyHandler(url));
  for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.state().phase, 'message'); assert.equal(f.state().count, 2); assert.equal(f.state().historyId, null);
  await f.step(); assert.equal(f.state().index, 1); assert.equal(f.state().historyId, null);
  await f.step(); assert.equal(f.state().index, 2); assert.equal(f.state().historyId, null);
  assert.equal((await f.step()).historyId, '120');
});

test('expired history triggers a full rescan and retains already registered messages and gaps', async () => {
  let expired = true;
  const f = await build(url => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] });
    if (url.pathname.endsWith('/messages/a')) return Response.json(message('a', '110', true));
    if (url.pathname.endsWith('/history') && expired) { expired = false; return new Response('', { status: 404 }); }
    return emptyHandler(url);
  });
  const result = await finish(f);
  assert.equal(f.state().recoveries, 1); assert.equal(result.partial, true);
  assert.equal(f.calls.filter(u => u.pathname.endsWith('/profile')).length, 2);
  assert.equal(Object.values(f.records())[0].version, 1); assert.equal(Object.keys(f.state().gaps).length, 1);
});

test('message 404 is an explicit gap, never a fabricated deletion or an empty complete mail', async () => {
  const f = await build(url => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'gone', threadId: 'thread1' }] });
    if (url.pathname.endsWith('/messages/gone')) return new Response('', { status: 404 });
    return emptyHandler(url);
  });
  assert.equal((await finish(f)).partial, true); assert.equal(Object.keys(f.records()).length, 0);
  assert.equal(Object.values(f.state().gaps)[0].reason, 'message_missing');
});

test('a later runtime run uses the last completed history cursor and updates the existing record', async () => {
  let later = false;
  const f = await build(url => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] });
    if (later && url.pathname.endsWith('/history')) {
      assert.equal(url.searchParams.get('startHistoryId'), '120');
      return Response.json({ historyId: '150', history: [{ id: '145', labelsRemoved: [{ message: { id: 'a' } }] }] });
    }
    if (url.pathname.endsWith('/messages/a')) return Response.json(message('a', later ? '145' : '110'));
    return emptyHandler(url);
  });
  await finish(f); later = true;
  const laterRun = 'quantus:2026-10-02:continue14:4.0';
  casMutate(f.store, data => startRunSection(data, { runKey: laterRun, sectionId: 'section-2', kind: 'http', now: T, verifiedScope: f.scope }));
  const result = await finish(f, { runKey: laterRun, sectionId: 'section-2' });
  assert.equal(result.historyId, '150'); assert.equal(Object.values(f.records())[0].version, 2);
  assert.equal(f.calls.filter(u => u.pathname.endsWith('/messages')).length, 1);
});

test('lost checkpoint acknowledgement resumes saved page and never repeats an already advanced message', async () => {
  const f = await build(url => url.pathname.endsWith('/messages')
    ? Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] }) : emptyHandler(url));
  await f.step(); await f.step(); await f.step(); // pending first page
  let once = true;
  const core = { ...f.core, async mutate(args) {
    const out = await f.core.mutate(args);
    if (once && args.commandKey.startsWith('v4-gmail-sync-')) { once = false; throw new Error('ack_lost'); }
    return out;
  } };
  await assert.rejects(f.make({ core }).next(), /ack_lost/);
  assert.equal(f.state().index, 1); assert.equal(Object.keys(f.records()).length, 1);
  await finish(f);
  assert.equal(f.calls.filter(u => u.pathname.endsWith('/messages/a')).length, 1);
});

test('failed registry transaction cannot advance the page index; retry safely registers the message', async () => {
  const f = await build(url => url.pathname.endsWith('/messages')
    ? Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] }) : emptyHandler(url));
  await f.step(); await f.step(); await f.step();
  const core = { ...f.core, async mutate(args) {
    if (args.commandKey.startsWith('v4-gmail-register-')) throw new Error('source_commit_failed');
    return f.core.mutate(args);
  } };
  await assert.rejects(f.make({ core }).next(), /source_commit_failed/);
  assert.equal(f.state().index, 0); assert.equal(Object.keys(f.records()).length, 0);
  await finish(f); assert.equal(Object.values(f.records())[0].version, 1);
});

test('changed registered source at checkpoint CAS prevents advancing the page', async () => {
  const f = await build(url => url.pathname.endsWith('/messages')
    ? Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] }) : emptyHandler(url));
  await f.step(); await f.step(); await f.step();
  const core = { ...f.core, async mutate(args) {
    if (args.commandKey.startsWith('v4-gmail-sync-')) f.store.forceWrite(data => {
      Object.values(Object.values(data.automation.runtime.gmailRegistry.sources)[0].records)[0].importedAtMs++;
      return data;
    });
    return f.core.mutate(args);
  } };
  await assert.rejects(f.make({ core }).next(), /registration_changed/);
  assert.equal(f.state().index, 0);
});

test('missing page evidence, initialized state deletion and expired lease fail without progress', async () => {
  for (const mode of ['page', 'state', 'lease']) {
    const f = await build(emptyHandler); await f.step(); await f.step(); await f.step();
    if (mode === 'page') f.artifacts.objects.delete(f.state().page.objectName);
    if (mode === 'state') f.store.forceWrite(d => { delete d.automation.runtime.gmailSync; return d; });
    if (mode === 'lease') f.setNow(T + 120001);
    const puts = f.store.stats.puts;
    await assert.rejects(f.step()); assert.equal(f.store.stats.puts, puts);
  }
});

test('pagination cycles and regressed provider history stop instead of producing a successful cursor', async () => {
  const f = await build(url => url.pathname.endsWith('/messages')
    ? Response.json({ messages: [], nextPageToken: url.searchParams.get('pageToken') === 'a' ? 'b' : 'a' }) : emptyHandler(url));
  await assert.rejects(finish(f), /page_cycle/);
  assert.equal(f.state().historyId, null);
  const g = await build(url => url.pathname.endsWith('/history')
    ? Response.json(url.searchParams.get('pageToken') ? { historyId: '120' } : { historyId: '130', nextPageToken: 'next' }) : emptyHandler(url));
  await assert.rejects(finish(g), /history_regressed/); assert.equal(g.state().historyId, null);
});

test('lost registry acknowledgement leaves the index pending and retry uses the already registered original', async () => {
  const f = await build(url => url.pathname.endsWith('/messages')
    ? Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] }) : emptyHandler(url));
  await f.step(); await f.step(); await f.step();
  let once = true;
  const core = { ...f.core, async mutate(args) {
    const out = await f.core.mutate(args);
    if (once && args.commandKey.startsWith('v4-gmail-register-')) { once = false; throw new Error('ack_lost'); }
    return out;
  } };
  await assert.rejects(f.make({ core }).next(), /ack_lost/);
  assert.equal(f.state().index, 0); assert.equal(Object.keys(f.records()).length, 1);
  await finish(f); assert.equal(Object.values(f.records())[0].version, 1);
});

test('an unfinished page carries into the next runtime run without relisting or losing its index', async () => {
  const f = await build(url => url.pathname.endsWith('/messages')
    ? Response.json({ messages: [{ id: 'a', threadId: 'thread1' }, { id: 'b', threadId: 'thread1' }] }) : emptyHandler(url));
  await f.step(); await f.step(); await f.step(); await f.step();
  const nextRun = 'quantus:2026-10-02:continue14:4.0';
  casMutate(f.store, data => startRunSection(data, { runKey: nextRun, sectionId: 'section-2', kind: 'http', now: T, verifiedScope: f.scope }));
  await finish(f, { runKey: nextRun, sectionId: 'section-2' });
  assert.equal(f.calls.filter(u => u.pathname.endsWith('/messages')).length, 1);
  assert.equal(f.calls.filter(u => u.pathname.endsWith('/messages/a')).length, 1);
  assert.equal(Object.keys(f.records()).length, 2);
});

test('revoked Gmail authorization leaves its message index and watermark unchanged', async () => {
  const f = await build(url => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'a', threadId: 'thread1' }] });
    if (url.pathname.endsWith('/messages/a')) return new Response('private error', { status: 401 });
    return emptyHandler(url);
  });
  await f.step(); await f.step(); await f.step();
  const before = f.state();
  await assert.rejects(f.step(), /gmail_v4_auth_rejected/);
  assert.deepEqual(f.state(), before); assert.equal(Object.keys(f.records()).length, 0);
});

test('a changed completion checkpoint during evidence readback cannot return stale success', async () => {
  const f = await build(emptyHandler); await finish(f);
  let once = true;
  const artifacts = { ...f.artifacts.store, async read(...args) {
    const text = await f.artifacts.store.read(...args);
    if (once) {
      once = false;
      f.store.forceWrite(data => { Object.values(data.automation.runtime.gmailSync.sources)[0].revision++; return data; });
    }
    return text;
  } };
  await assert.rejects(f.make({ artifacts }).next(), /completion_changed/);
});
