import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailContextHydrator } from '../runtime/quantus-v3/src/gmail-context-hydrator.mjs';
import { createGmailIntakeBinding } from '../runtime/quantus-v3/src/gmail-intake-binding.mjs';
import { createGmailMessageRegistry } from '../runtime/quantus-v3/src/gmail-message-registry.mjs';
import { createBriefingSectionWork } from '../runtime/quantus-v3/src/briefing-bootstrap.mjs';
import { createLeadershipGateway } from '../runtime/quantus-v3/src/leadership-gateway.mjs';
import { contextFingerprint } from '../runtime/quantus-v3/src/context-packets.mjs';
import { createQuantusV3DomainAdapter } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import { projectPage } from '../netlify/lib/quantus-v3-read-helpers.mjs';
import { POLICY_TEMPLATE, migrateCore } from '../netlify/lib/assistant-core.mjs';
import { setup, RUN, T } from './fixtures/quantus-v4-leadership-fixture.mjs';

const account = 'reader@example.test', scopeId = 'run_2026-10-02';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0', requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const mail = (historyId = '100', extra = {}) => JSON.stringify({ missing: false, account, id: 'mail1',
  threadId: 'thread1', historyId, internalDate: String(T), partial: false, gaps: [], parts: [{ text: 'Complete content' }],
  original: { id: 'mail1', threadId: 'thread1', historyId }, ...extra });
async function build(extra = {}) {
  const f = await setup(migrateCore({ entities: { tasks: { t1: { id: 't1', status: 'todo' } } } }, { now: T }).data);
  const config = { core: f.core, clock: f.clock, artifacts: f.artifacts.store, tenant: 'quantus', account,
    sourceId: 'gmail-inbox', runKey: RUN, sectionId: 'section-1', verifiedScope: f.scope, policy };
  const registry = createGmailMessageRegistry(config), binding = createGmailIntakeBinding(config);
  const original = mail('100', extra);
  await registry.register({ messageId: 'mail1', text: original });
  const intake = await binding.bind({ messageId: 'mail1' });
  const work = createBriefingSectionWork({ ...config, config: { tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun' },
    inner: { async next() { return {}; } } });
  await work.impl.next(config);
  const domain = createQuantusV3DomainAdapter({ tenantId: 'quantus', policyVersion: '4.0', mode: 'enforce', now: () => T,
    ports: { policy, ownerId: 'owner', read: () => undefined } });
  function page() {
    const data = f.store.snapshot();
    const raw = domain.listPage(data, { query: 'run.workset', scopeId, pageSize: 50, principal: { role: 'lead_agent', jobId: scopeId } });
    return { items: projectPage('run.workset', raw.items).items, dataRevision: data.automation.dataRevision, scopeId };
  }
  return { ...f, config, registry, binding, intake, original, page, make: overrides => createGmailContextHydrator({ ...config, ...overrides }) };
}

test('hydrates exact full original with matching intake version and no private storage coordinates', async () => {
  const f = await build();
  const input = f.page(), items = await f.make().hydrate(input), item = items.find(i => i.sourceId === f.intake.intakeId);
  assert.equal(item.text, f.original); assert.equal(item.sourceMissing, false);
  const details = JSON.parse(item.contextDetails);
  assert.equal(details.originalState, 'verified'); assert.equal(details.untrustedSource, true);
  assert.equal(details.original.contentHash, f.intake.entry.externalSource.record.contentHash);
  assert.equal(JSON.stringify(items).includes(f.intake.entry.externalSource.record.reference.objectName), false);
  assert.equal(input.items.find(i => i.sourceId === f.intake.intakeId).sourceMissing, true);
});

test('historical open intakes follow committed versions across more than one predecessor', async () => {
  const f = await build();
  for (const h of ['101', '102']) {
    await f.registry.register({ messageId: 'mail1', text: mail(h) });
    await f.binding.bind({ messageId: 'mail1' });
  }
  const items = await f.make().hydrate(f.page());
  assert.deepEqual(items.filter(i => i.sourceType === 'intake').map(i => JSON.parse(i.text).historyId).sort(), ['100', '101', '102']);
  f.store.forceWrite(d => {
    Object.values(d.automation.runtime.gmailRegistry.sources[f.registry.sourceKey].records)[0].previous = f.intake.entry.externalSource.record.reference;
    Object.values(d.automation.intakeById).find(e => e.externalSource?.record.version === 3)
      .externalSource.record.previous = f.intake.entry.externalSource.record.reference;
    return d;
  });
  await assert.rejects(f.make().hydrate(f.page()), /version_chain_invalid/);
});

test('unread attachments stay explicit and prevent an all-originals-read claim', async () => {
  const f = await build({ partial: true, gaps: [{ reason: 'attachment_unread', attachmentId: 'att1' }] });
  const item = (await f.make().hydrate(f.page())).find(i => i.sourceType === 'intake');
  assert.equal(item.sourceMissing, true); assert.equal(JSON.parse(item.text).gaps[0].attachmentId, 'att1');
  assert.equal(JSON.parse(item.contextDetails).original.gapCount, 1);
});

test('a newer registered original cannot remain invisible behind an older bound intake', async () => {
  const f = await build();
  await f.registry.register({ messageId: 'mail1', text: mail('101') });
  await assert.rejects(f.make().hydrate(f.page()), /latest_version_unbound/);
  await f.binding.bind({ messageId: 'mail1' });
  const items = await f.make().hydrate(f.page());
  const older = items.find(i => i.sourceId === f.intake.intakeId);
  assert.equal(JSON.parse(older.contextDetails).original.superseded, true);
  assert.equal(JSON.parse(older.contextDetails).original.latestVersion, 2);
});

test('scope/identity forgery, missing original and revoked lease cannot expose an original', async () => {
  for (const mode of ['scope', 'item', 'tenant', 'missing', 'lease']) {
    const f = await build(), page = f.page();
    if (mode === 'scope') page.scopeId = 'run_2026-10-03';
    if (mode === 'item') page.items.find(i => i.sourceType === 'intake').id = 'forged';
    if (mode === 'tenant') f.store.forceWrite(d => {
      d.automation.intakeById[f.intake.intakeId].externalSource.identity.tenant = 'other'; return d;
    });
    if (mode === 'missing') f.artifacts.objects.delete(f.intake.entry.externalSource.record.reference.objectName);
    if (mode === 'lease') f.setNow(T + 120001);
    await assert.rejects(f.make().hydrate(page));
  }
});

test('concurrent source and domain changes during full read invalidate the whole result', async () => {
  for (const mode of ['source', 'revision', 'binding']) {
    const f = await build(); let changed = false;
    const hydrate = f.make({ artifacts: { ...f.artifacts.store, async read(...args) {
      const text = await f.artifacts.store.read(...args);
      if (!changed) { changed = true; f.store.forceWrite(d => {
        if (mode === 'revision') d.automation.dataRevision++;
        else if (mode === 'binding') d.automation.intakeById[f.intake.intakeId].text = 'changed';
        else Object.values(d.automation.runtime.gmailRegistry.sources[f.registry.sourceKey].records)[0].importedAtMs++;
        return d;
      }); }
      return text;
    } } });
    await assert.rejects(hydrate.hydrate(f.page()), /source_changed|revision_changed/);
  }
});

test('full-original secret scanning cannot be bypassed at packet boundaries', async () => {
  for (const prefix of ['sk-', 'sk-proj-', 'sk-svcacct-']) {
    const f = await build({ parts: [{ text: 'x'.repeat(23990) + ' ' + prefix + 'a'.repeat(70) }] });
    await assert.rejects(f.make().hydrate(f.page()), /projection_rejected/);
  }
});

test('real gateway packets preserve and fingerprint the complete hydrated Unicode mail', async () => {
  const f = await build({ parts: [{ text: '🪵 Original\n'.repeat(25000) }] });
  const hydrate = f.make(), expected = await hydrate.hydrate(f.page());
  let reads = 0;
  const makeGateway = () => createLeadershipGateway({ artifacts: f.artifacts.store, runKey: RUN, tenant: 'quantus',
    clock: f.clock, lease: async () => f.scope, toolsEnabled: { quantus_context: true }, hydrateWorkset: hydrate.hydrate,
    jobTokenIssuer: { async mint() { return 'synthetic-token'; } }, transport: { async send() {
      reads++; const p = f.page(); return { status: 200, body: { ok: true, query: 'run.workset', ...p,
        requestId: 'test-read', serverNow: new Date(T).toISOString(), count: p.items.length, hasMore: false,
        complete: true, pageStatus: 'done', cursor: null } };
    } } });
  let cursor = '', count = 0; const items = [], fragments = [];
  do {
    const r = await makeGateway().execute({ name: 'quantus_context', arguments: { query: 'run.workset', scopeId, cursor } },
      { responseId: 'test', callId: `read${count++}` });
    assert.equal(r.confirmed, true); assert.equal(r.contextPacket.sourceMissing, false);
    assert.equal(r.contextPacket.contentHash, contextFingerprint(expected));
    items.push(...r.response.body.items); fragments.push(...r.response.body.fragments);
    cursor = r.response.body.cursor;
  } while (cursor);
  assert.ok(count > 1); assert.equal(reads, count);
  const mail = JSON.parse(fragments.sort((a, b) => a.fragmentIndex - b.fragmentIndex).map(f => f.jsonFragment).join(''));
  assert.equal(mail.text, f.original); items.push(mail);
  assert.equal(contextFingerprint(items), contextFingerprint(expected));
});
