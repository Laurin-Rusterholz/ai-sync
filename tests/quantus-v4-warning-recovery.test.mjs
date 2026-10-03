import test from 'node:test';
import assert from 'node:assert/strict';
import * as E1 from '../netlify/lib/quantus-v3-runtime-state.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
import { setup, T } from './fixtures/quantus-v4-leadership-fixture.mjs';

async function build(t, { mode = 'live', changeReceipt, concurrentFailure = false, readbackFailure = false, deliveryDelay = 0, omitReceiptReader = false } = {}) {
  const s = await setup();
  await s.core.mutate({ commandKey: 'fixture-heartbeat', requestId: 'fixture', now: T, mutate(data) {
    const next = structuredClone(data); next.automation.runtime.monitor.lastHeartbeatAtMs = T;
    return E1.recordWarningFailure(next, { failureId: 'original-warning', channel: 'primary', now: T });
  } });
  const beforeLease = structuredClone(s.store.snapshot().automation.activeLease);
  const key = F.createSigningKey(), clock = F.createClock(T + 1000);
  const sent = [], receipts = new Map();
  const alert = F.availablePort('alert', {
    async send(event) {
      if (!receipts.has(event.warningId)) {
        sent.push(event);
        if (deliveryDelay) clock.advance(deliveryDelay);
        receipts.set(event.warningId, { warningId: event.warningId, receiptId: 'r-' + sent.length,
          channel: 'test-owner-channel', deliveredAtMs: clock.value, delivered: true });
      }
      return { receiptId: receipts.get(event.warningId).receiptId };
    },
    async readReceipt({ warningId }) {
      if (concurrentFailure) {
        concurrentFailure = false;
        await s.core.mutate({ commandKey: 'second-failure', requestId: 'fixture', now: clock.value,
          mutate: data => E1.recordWarningFailure(data, { failureId: 'second-warning', channel: 'primary', now: clock.value }) });
      }
      const receipt = structuredClone(receipts.get(warningId));
      if (readbackFailure) s.onRead(() => { throw Error('lost independent readback'); });
      return changeReceipt ? changeReceipt(receipt) : receipt;
    },
  });
  const service = await F.startService({ role: 'watchdog',
    ports: { core: F.availablePort('core', s.core), clock: clock.port, jwks: F.jwksPort(key),
      alert: omitReceiptReader ? F.availablePort("alert", { send: alert.impl.send }) : alert },
    configOverrides: { QUANTUS_V3_RUNTIME_MODE: mode,
      QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: mode === 'live' ? 'true' : 'false',
      QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed() } });
  t.after(() => service.close());
  const post = () => service.post('/v3/watchdog/check', { token: F.schedulerToken(key,
    { audience: F.AUD.watchdogCheck, email: F.SA.schedulerWatchdog, nowMs: clock.value }) });
  return { ...s, service, sent, clock, post, beforeLease };
}

test('fresh heartbeat still escalates an unresolved warning and persists verified receipt through real CAS', async t => {
  const s = await build(t);
  const res = await s.post();
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.stale, false);
  assert.equal(res.json.alerted, true);
  assert.equal(res.json.escalatedToWatchdogChannel, true);
  assert.equal(res.json.warningDeliveryPending, false);
  assert.equal(s.sent[0].kind, 'warning_delivery_failed');
  const m = s.store.snapshot().automation.runtime.monitor;
  assert.equal(m.warnFailures, 1);
  assert.equal(m.acknowledgedWarnFailures, 1);
  assert.equal(Object.keys(m.warningDeliveriesById).length, 1);
  assert.deepEqual(s.store.snapshot().automation.activeLease, s.beforeLease);
  assert.equal((await s.post()).json.alerted, false);
  assert.equal(s.sent.length, 1);
});

test('an intervening failure is not acknowledged by an older receipt', async t => {
  const s = await build(t, { concurrentFailure: true });
  const first = await s.post();
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.warningDeliveryPending, true);
  const m = s.store.snapshot().automation.runtime.monitor;
  assert.equal(m.warnFailures, 2);
  assert.equal(m.acknowledgedWarnFailures, 1);
  assert.equal((await s.post()).json.warningDeliveryPending, false);
  assert.equal(s.sent.length, 2);
  assert.notEqual(s.sent[0].warningId, s.sent[1].warningId);
});

for (const [name, changeReceipt] of Object.entries({
  unconfirmed: r => ({ ...r, delivered: false }),
  wrongWarning: r => ({ ...r, warningId: 'other' }),
  wrongReceipt: r => ({ ...r, receiptId: 'other' }),
  future: r => ({ ...r, deliveredAtMs: T + 9000 }),
  beforeFailure: r => ({ ...r, deliveredAtMs: T - 1 }),
  malformed: () => ({ delivered: true }),
})) test(`${name} receipt cannot clear the failure or report delivered`, async t => {
  const s = await build(t, { changeReceipt });
  for (let i = 0; i < 2; i++) {
    const res = await s.post();
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error, 'warning_delivery_failed');
  }
  const m = s.store.snapshot().automation.runtime.monitor;
  assert.equal(m.acknowledgedWarnFailures ?? 0, 0);
  assert.equal(m.warnFailures, 1, 'no recursive failure-about-failure counter');
  assert.equal(s.sent.length, 1, 'stable warning ID reaches the idempotent adapter');
});

for (const mode of ['dry_run', 'shadow']) test(`${mode} does not send or acknowledge warnings`, async t => {
  const s = await build(t, { mode }), before = s.store.snapshot();
  const res = await s.post();
  assert.equal(res.status, 200);
  assert.equal(res.json.alerted, false);
  assert.equal(res.json.warningDeliveryPending, true);
  assert.equal(s.sent.length, 0);
  assert.deepEqual(s.store.snapshot(), before);
});

test('lost receipt readback does not report success; retry observes the durable receipt', async t => {
  const s = await build(t, { readbackFailure: true });
  const res = await s.post();
  assert.equal(res.status, 500, res.text);
  assert.equal(res.json.alerted, undefined);
  s.onRead(null);
  const retry = await s.post();
  assert.equal(retry.status, 200, retry.text);
  assert.equal(s.sent.length, 1);
});

test('acknowledgement cannot exist without matching receipt evidence', async () => {
  const s = await setup(), data = s.store.snapshot();
  data.automation.runtime.monitor.warnFailures = 1;
  data.automation.runtime.monitor.acknowledgedWarnFailures = 1;
  assert.throws(() => E1.readRuntime(data), /runtime_area_invalid/);
});


test('delivery after request start uses the fresh trusted clock', async t => {
  const s = await build(t, { deliveryDelay: 5000 });
  const response = await s.post();
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.alerted, true);
  const receipt = Object.values(s.store.snapshot().automation.runtime.monitor.warningDeliveriesById)[0];
  assert.equal(receipt.deliveredAtMs, T + 6000);
});

test('a send-only adapter cannot establish delivery', async t => {
  const s = await build(t, { omitReceiptReader: true });
  const response = await s.post();
  assert.equal(response.status, 503, response.text);
  assert.equal(response.json.error, 'warning_receipt_port_unavailable');
  assert.equal(s.sent.length, 0);
});

test('concurrent authenticated checks acknowledge once with the same stable adapter ID', async t => {
  const s = await build(t);
  const results = await Promise.all([s.post(), s.post(), s.post()]);
  for (const r of results) assert.equal(r.status, 200, r.text);
  assert.equal(s.sent.length, 1);
  const monitor = s.store.snapshot().automation.runtime.monitor;
  assert.equal(monitor.acknowledgedWarnFailures, 1);
  assert.equal(Object.keys(monitor.warningDeliveriesById).length, 1);
});

test('receipt replay is immutable and acknowledgement cannot exceed observed failures', async () => {
  const s = await setup();
  const failed = E1.recordWarningFailure(s.store.snapshot(), { now: T, channel: 'primary', failureId: 'f' }).data;
  const receipt = { now: T, warningId: 'warning-test', channel: 'owner-channel', receiptId: 'r1',
    deliveredAtMs: T, observedFailureCount: 1 };
  const delivered = E1.recordWarningDelivery(failed, receipt);
  assert.equal(E1.recordWarningDelivery(delivered.data, receipt).unchanged, true);
  assert.throws(() => E1.recordWarningDelivery(delivered.data, { ...receipt, receiptId: 'r2' }), /warning_receipt_conflict/);
  assert.throws(() => E1.recordWarningDelivery(failed, { ...receipt, observedFailureCount: 2 }), /warning_delivery_invalid/);
  assert.throws(() => E1.recordWarningDelivery(failed, { ...receipt, deliveredAtMs: T + 1 }), /warning_delivery_invalid/);
});
