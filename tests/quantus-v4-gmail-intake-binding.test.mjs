import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailIntakeBinding } from '../runtime/quantus-v3/src/gmail-intake-binding.mjs';
import { createGmailMessageRegistry } from '../runtime/quantus-v3/src/gmail-message-registry.mjs';
import { createBriefingSectionWork } from '../runtime/quantus-v3/src/briefing-bootstrap.mjs';
import { createQuantusV3DomainAdapter } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import { POLICY_TEMPLATE, collectRunInventory, applyCommand, migrateCore } from '../netlify/lib/assistant-core.mjs';
import { setup, RUN, T } from './fixtures/quantus-v4-leadership-fixture.mjs';

const account = 'reader@example.test';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0', requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const mail = (historyId = '100', extra = {}) => JSON.stringify({ missing: false, account, id: 'mail1',
  threadId: 'thread1', historyId, internalDate: String(T - 86400000), partial: false, gaps: [], parts: [{ text: 'Full original '.repeat(2000) }],
  original: { id: 'mail1', threadId: 'thread1', historyId }, ...extra });
async function build() {
  const f = await setup(migrateCore({ entities: { tasks: { t1: { id: 't1', status: 'todo' } } } }, { now: T }).data);
  const config = { core: f.core, clock: f.clock, artifacts: f.artifacts.store, tenant: 'quantus', account,
    sourceId: 'gmail-inbox', runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope, policy };
  const registry = createGmailMessageRegistry(config);
  await registry.register({ messageId: 'mail1', text: mail() });
  return { ...f, config, registry, binding: createGmailIntakeBinding(config) };
}

test('binds a real original atomically to an open compact intake, inventory and honest C2 workset', async () => {
  const f = await build(), before = f.store.snapshot().automation.dataRevision;
  const out = await f.binding.bind({ messageId: 'mail1' });
  const data = f.store.snapshot();
  assert.equal(data.automation.dataRevision, before + 1);
  assert.equal(out.entry.status, 'open'); assert.equal(out.entry.linkedTo, null);
  assert.equal(out.entry.receivedAt, new Date(T - 86400000).toISOString());
  assert.ok(out.entry.text.length < 250); assert.ok(out.original.parts[0].text.length > 20000);
  assert.equal(out.entry.externalSource.record.contentHash, (await f.registry.read({ messageId: 'mail1' })).record.contentHash);
  assert.ok(collectRunInventory(data).some(r => r.sourceType === 'intake' && r.sourceId === out.intakeId));
  const work = createBriefingSectionWork({ core: f.core, clock: f.clock, policy,
    config: { tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun' }, inner: { async next() { return {}; } } });
  await work.impl.next({ runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope });
  const domain = createQuantusV3DomainAdapter({ tenantId: 'quantus', policyVersion: '4.0', mode: 'enforce', now: () => T,
    ports: { policy, ownerId: 'owner', read: () => undefined } });
  const page = domain.listPage(f.store.snapshot(), { query: 'run.workset', scopeId: 'run_2026-10-02', pageSize: 50,
    principal: { role: 'lead_agent', jobId: 'run_2026-10-02' } });
  const item = page.items.find(i => i.sourceId === out.intakeId);
  assert.equal(item.sourceMissing, true);
  assert.equal(JSON.parse(item.contextDetails).originalState, 'external_read_required');
  assert.equal(JSON.stringify(item).includes(out.entry.externalSource.record.reference.objectName), false);
});

test('fresh-instance replay preserves handled state and does not write or duplicate the intake', async () => {
  const f = await build(), out = await f.binding.bind({ messageId: 'mail1' });
  f.store.forceWrite(d => { d.automation.intakeById[out.intakeId].status = 'done'; return d; });
  const puts = f.store.stats.puts;
  const replay = await createGmailIntakeBinding(f.config).bind({ messageId: 'mail1' });
  assert.equal(replay.created, false); assert.equal(replay.entry.status, 'done'); assert.equal(f.store.stats.puts, puts);
});

test('new source version creates distinct open work and retains the earlier exact original binding', async () => {
  const f = await build(), old = await f.binding.bind({ messageId: 'mail1' });
  await f.registry.register({ messageId: 'mail1', text: mail('101', { partial: true, gaps: [{ reason: 'attachment_unread' }] }) });
  const next = await f.binding.bind({ messageId: 'mail1' });
  assert.notEqual(next.intakeId, old.intakeId); assert.equal(next.entry.externalSource.record.version, 2);
  assert.equal(next.entry.externalSource.record.gapCount, 1); assert.equal(next.entry.status, 'open');
  assert.deepEqual(f.store.snapshot().automation.intakeById[old.intakeId], old.entry);
});

test('lost acknowledgement recovers and CAS user changes survive without repeating original I/O', async () => {
  const f = await build(); let lost = true, changed = false, readsAtCas;
  f.onMutation(() => {
    const count = f.artifacts.calls.length;
    readsAtCas ??= count; assert.equal(count, readsAtCas);
    if (!changed) { changed = true; f.store.forceWrite(d => { d.entities.tasks.t1.title = 'user edit'; return d; }); }
  });
  const binding = createGmailIntakeBinding({ ...f.config, core: { ...f.core, async mutate(args) {
    const result = await f.core.mutate(args);
    if (lost) { lost = false; throw new Error('lost_ack'); } return result;
  } } });
  await assert.rejects(binding.bind({ messageId: 'mail1' }), /lost_ack/);
  f.onMutation(null);
  const puts = f.store.stats.puts, out = await binding.bind({ messageId: 'mail1' });
  assert.equal(out.created, false); assert.equal(f.store.stats.puts, puts);
  assert.equal(f.store.snapshot().entities.tasks.t1.title, 'user edit');
});

test('changed source at CAS, missing original, expired authority and forged binding are rejected', async () => {
  for (const mode of ['source', 'original', 'lease', 'binding']) {
    const f = await build();
    if (mode === 'source') f.onMutation(() => f.store.forceWrite(d => {
      Object.values(d.automation.runtime.gmailRegistry.sources[f.registry.sourceKey].records)[0].importedAtMs++;
      return d;
    }));
    if (mode === 'original') {
      const row = (await f.registry.read({ messageId: 'mail1' })).record;
      f.artifacts.objects.delete(row.reference.objectName);
    }
    if (mode === 'lease') f.setNow(T + 120001);
    if (mode === 'binding') {
      const out = await f.binding.bind({ messageId: 'mail1' });
      f.store.forceWrite(d => { delete d.automation.intakeById[out.intakeId].externalSource; return d; });
    }
    await assert.rejects(f.binding.bind({ messageId: 'mail1' }));
  }
});

test('ordinary intake commands cannot mint the server-owned external binding', async () => {
  const f = await build();
  for (const kind of ['user', 'agent', 'adapter', 'system']) {
    const out = applyCommand(f.store.snapshot(), { type: 'registerIntake', commandId: 'forged', now: T,
      payload: { intakeId: 'forged', text: 'mail', channel: 'gmail', externalSource: { schema: 'quantus-gmail-intake/1' } } },
    { policy, actor: { kind, id: 'caller' } });
    assert.equal(out.ok, false);
  }
});
