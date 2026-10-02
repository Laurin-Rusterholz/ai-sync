import test from 'node:test';
import assert from 'node:assert/strict';
import { createC2HttpTransport } from '../runtime/quantus-v3/src/c2-transport.mjs';
import { createLeadershipGateway } from '../runtime/quantus-v3/src/leadership-gateway.mjs';

test('section abort interrupts a hanging response stream and cancels its reader', async () => {
  const controller = new AbortController();
  let cancel = false, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const transport = createC2HttpTransport({ baseUrl: 'https://test.invalid', fetchImpl: async () => new Response(new ReadableStream({
    pull() { entered(); }, cancel() { cancel = true; },
  })) });
  const pending = transport.send({ route: 'quantus-context', method: 'GET', credential: 'test', signal: controller.signal });
  await reading;
  controller.abort();
  await assert.rejects(pending, { error: 'c2_request_interrupted' });
  assert.equal(cancel, true);
});

test('pre-aborted request and abort during credential mint dispatch no tool request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const gateway = createLeadershipGateway({ runKey: 'quantus:2026-10-02:process09:4.0', tenant: 'quantus',
    clock: { now: () => Date.now() }, lease: async () => ({ holder: 'test', fence: 1 }), signal: controller.signal,
    toolsEnabled: { quantus_context: true }, jobTokenIssuer: { async mint() { controller.abort(); return 'test'; } },
    transport: { async send() { calls++; } } });
  await assert.rejects(gateway.execute({ name: 'quantus_context', arguments: { query: 'run.context', scopeId: 'run_2026-10-02', cursor: '' } },
    { responseId: 'response1', callId: 'call1' }), { error: 'leadership_interrupted' });
  const transport = createC2HttpTransport({ baseUrl: 'https://test.invalid', fetchImpl: async () => { calls++; } });
  await assert.rejects(transport.send({ route: 'quantus-context', method: 'GET', credential: 'test', signal: controller.signal }),
    { error: 'c2_request_interrupted' });
  assert.equal(calls, 0);
});
