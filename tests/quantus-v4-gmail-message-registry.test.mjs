import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailMessageRegistry } from '../runtime/quantus-v3/src/gmail-message-registry.mjs';
import { setup, RUN, T } from './fixtures/quantus-v4-leadership-fixture.mjs';

const account = 'reader@example.test';
const mail = (id = 'mail1', historyId = '100', extra = {}) => JSON.stringify({ missing: false, account, id,
  threadId: 'thread1', historyId, partial: false, gaps: [], original: { id, threadId: 'thread1', historyId, body: 'complete original' }, ...extra });
async function build(options = {}) {
  const fixture = await setup();
  const config = { core: fixture.core, clock: fixture.clock, artifacts: fixture.artifacts.store, tenant: 'quantus', account,
    sourceId: 'gmail-inbox', runKey: RUN, sectionId: 'section-1', verifiedScope: fixture.scope, ...options };
  return { ...fixture, config, registry: createGmailMessageRegistry(config) };
}
const rows = f => f.store.snapshot().automation.runtime.gmailRegistry.sources[f.registry.sourceKey];

test('one account/provider-ID is permanent across fresh instances and repeats without another core write', async () => {
  const f = await build();
  const first = await f.registry.register({ messageId: 'mail1', text: mail() });
  assert.equal(first.confirmed, true); assert.equal(first.record.version, 1);
  const puts = f.store.stats.puts;
  const second = await createGmailMessageRegistry(f.config).register({ messageId: 'mail1', text: mail() });
  assert.deepEqual(second, first); assert.equal(f.store.stats.puts, puts); assert.equal(rows(f).count, 1);
  assert.equal(f.store.snapshot().einUnbekanntesFeld.bleibt, true);
  assert.equal(f.store.snapshot().journal.entries[0].text, 'unberuehrt');
  assert.equal(f.store.snapshot().automation.sourceCursors, undefined);
});

test('a new history version retains the independently readable earlier original and stable registry identity', async () => {
  const f = await build();
  const first = await f.registry.register({ messageId: 'mail1', text: mail() });
  const second = await f.registry.register({ messageId: 'mail1', text: mail('mail1', '105', { partial: true, gaps: [{ reason: 'attachment_unread' }] }) });
  assert.equal(rows(f).count, 1); assert.equal(rows(f).revision, 2); assert.equal(second.record.version, 2);
  assert.equal(second.record.partial, true);
  const prior = await f.registry.readPrevious({ messageId: 'mail1' });
  assert.deepEqual(prior.record, first.record); assert.deepEqual(prior.original, first.original);
  for (const history of ['99', '105'])
    await assert.rejects(f.registry.register({ messageId: 'mail1', text: mail('mail1', history) }), /history_not_newer/);
  assert.equal(rows(f).revision, 2);
});

test('prior-version reads follow only the committed chain and reject changed history', async () => {
  const f = await build();
  assert.equal(await f.registry.readPrevious({ messageId: 'mail1' }), null);
  await f.registry.register({ messageId: 'mail1', text: mail() });
  assert.equal(await f.registry.readPrevious({ messageId: 'mail1' }), null);
  await f.registry.register({ messageId: 'mail1', text: mail('mail1', '102') });
  const second = Object.values(rows(f).records)[0];
  await f.registry.register({ messageId: 'mail1', text: mail('mail1', '104') });
  f.store.forceWrite(d => {
    Object.values(d.automation.runtime.gmailRegistry.sources[f.registry.sourceKey].records)[0].previous = second.previous;
    return d;
  });
  await assert.rejects(f.registry.readPrevious({ messageId: 'mail1' }), /archive_invalid/);
});

test('same provider-ID in another account has a separate bound registry and original', async () => {
  const f = await build();
  await f.registry.register({ messageId: 'mail1', text: mail() });
  const other = createGmailMessageRegistry({ ...f.config, account: 'other@example.test' });
  await other.register({ messageId: 'mail1', text: mail('mail1', '100', { account: 'other@example.test' }) });
  assert.equal(f.store.snapshot().automation.runtime.gmailRegistry.sourceCount, 2);
  assert.equal((await other.read({ messageId: 'mail1' })).original.account, 'other@example.test');
  assert.equal((await f.registry.read({ messageId: 'mail1' })).original.account, account);
});

test('lost CAS acknowledgement recovers from the original record without duplicate version or upload effects', async () => {
  const f = await build(); let lost = true;
  const registry = createGmailMessageRegistry({ ...f.config, core: { ...f.core, async mutate(args) {
    const result = await f.core.mutate(args);
    if (lost) { lost = false; throw new Error('ack_lost'); }
    return result;
  } } });
  await assert.rejects(registry.register({ messageId: 'mail1', text: mail() }), /ack_lost/);
  const puts = f.store.stats.puts, objects = f.artifacts.objects.size;
  assert.equal((await registry.register({ messageId: 'mail1', text: mail() })).record.version, 1);
  assert.equal(f.store.stats.puts, puts); assert.equal(f.artifacts.objects.size, objects);
});

test('CAS user edits are preserved and retry never repeats external source storage', async () => {
  const f = await build(); let once = true, uploadsAtCas;
  f.onMutation(() => {
    const uploads = f.artifacts.calls.filter(c => c.options.method === 'POST').length;
    if (uploadsAtCas === undefined) uploadsAtCas = uploads;
    else assert.equal(uploads, uploadsAtCas);
    if (once) { once = false; f.store.forceWrite(d => { d.entities.tasks.t1.title = 'user edit'; return d; }); }
  });
  const result = await f.registry.register({ messageId: 'mail1', text: mail() });
  assert.equal(result.confirmed, true); assert.ok(f.store.stats.conflicts > 0);
  assert.equal(f.store.snapshot().entities.tasks.t1.title, 'user edit');
});

test('a conflicting source commit is rejected; a changed record cannot pass independent readback', async () => {
  for (const stage of ['cas', 'readback']) {
    const f = await build();
    await f.registry.register({ messageId: 'mail1', text: mail() });
    let once = true;
    const change = () => f.store.forceWrite(d => {
      const source = d.automation.runtime.gmailRegistry.sources[f.registry.sourceKey];
      Object.values(source.records)[0].importedAtMs++;
      return d;
    });
    const registry = createGmailMessageRegistry({ ...f.config, core: { ...f.core, async mutate(args) {
      if (stage === 'cas' && once) { once = false; change(); }
      const result = await f.core.mutate(args);
      if (stage === 'readback' && once) { once = false; change(); }
      return result;
    } } });
    await assert.rejects(registry.register({ messageId: 'mail1', text: mail('mail1', '101') }),
      stage === 'cas' ? /concurrent_message_change/ : /readback_mismatch/);
  }
});

test('deleted registry after initialization, missing record or invalid version never silently resets', async () => {
  for (const mode of ['area', 'record', 'version']) {
    const f = await build(); await f.registry.register({ messageId: 'mail1', text: mail() });
    f.store.forceWrite(d => {
      if (mode === 'area') delete d.automation.runtime.gmailRegistry;
      else {
        const s = d.automation.runtime.gmailRegistry.sources[f.registry.sourceKey];
        if (mode === 'record') delete s.records[Object.keys(s.records)[0]];
        else Object.values(s.records)[0].version = 0;
      }
      return d;
    });
    await assert.rejects(f.registry.register({ messageId: 'mail1', text: mail() }), /gmail_registry_(area_invalid|record_invalid)/);
  }
});

test('expired lease, foreign section and unreadable original stop mutation or confirmed replay', async () => {
  const f = await build();
  const saved = await f.registry.register({ messageId: 'mail1', text: mail() });
  f.artifacts.objects.delete(saved.record.reference.objectName);
  await assert.rejects(f.registry.read({ messageId: 'mail1' }), /artifact_read_failed/);
  const foreign = createGmailMessageRegistry({ ...f.config, sectionId: 'other-section' });
  await assert.rejects(foreign.register({ messageId: 'mail2', text: mail('mail2') }), /section_mismatch/);
  const puts = f.store.stats.puts;
  f.setNow(T + 120001);
  await assert.rejects(f.registry.register({ messageId: 'mail2', text: mail('mail2') }));
  assert.equal(f.store.stats.puts, puts);
});

test('inconsistent source metadata does not become a registered complete source', async () => {
  const f = await build();
  for (const extra of [{ partial: false, gaps: [{}] }, { historyId: 'NaN' }, { threadId: 'other' }])
    await assert.rejects(f.registry.register({ messageId: 'mail1', text: mail('mail1', '100', extra) }), /source_invalid/);
  assert.equal(f.store.snapshot().automation.runtime.gmailRegistry, undefined);
});

test('the first ID remains registered after more than the old 300-message overlap window', async () => {
  const f = await build();
  for (let i = 0; i < 301; i++) {
    const id = 'mail' + i;
    await f.registry.register({ messageId: id, text: mail(id) });
  }
  const puts = f.store.stats.puts;
  const old = await createGmailMessageRegistry(f.config).register({ messageId: 'mail0', text: mail('mail0') });
  assert.equal(old.record.version, 1); assert.equal(rows(f).count, 301); assert.equal(f.store.stats.puts, puts);
});

test('lease expiry at the CAS boundary rejects a prepared source without registering it', async () => {
  const f = await build();
  f.onMutation(() => f.setNow(T + 120001));
  await assert.rejects(f.registry.register({ messageId: 'mail1', text: mail() }));
  assert.equal(f.store.snapshot().automation.runtime.gmailRegistry, undefined);
  assert.ok(f.artifacts.objects.size > 0); // uncommitted private originals are not deleted or counted as imports
});
