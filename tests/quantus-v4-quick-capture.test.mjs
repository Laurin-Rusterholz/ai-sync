import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { captureIntent, openQuickCapture } from '../public/quantus-v4-quick-capture.mjs';
const fields = { title: 'Auftrag', text: 'Volltext', projectId: 'project_one', sourceUrl: 'https://example.org/original', nextAction: 'Original prüfen' };
async function fixture(t) {
  let run = null, current = 'owner', now = Date.parse('2026-10-03T09:00:00Z'), lose = false;
  const requests = [], committed = new Map();
  const options = { accountKey: 'owner', getAuth: async () => ({ accountKey: current, idToken: 'valid' }),
    getRun: () => run, origin: 'https://quantus.example', indexedDB: new IDBFactory(), now: () => now,
    fetchImpl: async (_url, init) => {
      const cmd = JSON.parse(init.body), key = init.headers['Idempotency-Key']; requests.push({ cmd, key });
      if (!committed.has(key)) committed.set(key, { ok: true, applied: true, replayed: false, requestId: 'r-' + committed.size,
        serverNow: '2026-10-03T09:00:00.000Z', dataRevision: committed.size + 1,
        entityVersions: { [cmd.payload.intakeId]: 7, ...(cmd.verb === 'intake.accept' ? { lead_created: 1, [cmd.jobId]: 3 } : {}) },
        ...(cmd.verb === 'intake.accept' ? { effect: { leadId: 'lead_created' } } : {}) });
      if (lose) { lose = false; throw Error('lost after commit'); }
      return new Response(JSON.stringify(committed.get(key)));
    } };
  const client = await openQuickCapture(options); t.after(() => client.close());
  return { client, options, requests, committed, activate: () => { run = { id: 'run_2026-10-03', date: '2026-10-03', phase: 'active' }; },
    switchAccount: () => { current = 'other'; }, lose: () => { lose = true; }, advance: () => { now += 30000; } };
}
test('full capture survives reload without a run; confirmed create precedes acceptance with bound version', async t => {
  const f = await fixture(t); await f.client.submit({ captureId: 'one', fields }); await f.client.flush();
  assert.equal(f.requests.length, 0); assert.equal((await f.client.list())[0].deliveryStatus, 'run_pending');
  const reopened = await openQuickCapture(f.options); t.after(() => reopened.close());
  f.activate(); await reopened.flush();
  assert.deepEqual(f.requests.map(r => r.cmd.verb), ['intake.create','intake.accept']);
  assert.equal(f.requests[1].cmd.expectedEntityVersion, 7);
  for (const key of Object.keys(fields)) assert.equal(f.requests[0].cmd.payload[key], fields[key]);
  assert.equal((await reopened.list())[0].leadId, 'lead_created');
});
test('lost create response cannot trigger acceptance; stable retry recovers one source', async t => {
  const f = await fixture(t); f.activate(); await f.client.submit({ captureId: 'one', fields }); f.lose(); await f.client.flush();
  assert.deepEqual(f.requests.map(r => r.cmd.verb), ['intake.create']);
  f.advance(); await f.client.flush();
  assert.equal(f.requests[0].key, f.requests[1].key); assert.equal(f.committed.size, 2);
  assert.equal((await f.client.list())[0].deliveryStatus, 'acknowledged');
});
test('duplicate intent is immutable and account switch prevents any command', async t => {
  const f = await fixture(t); await f.client.submit({ captureId: 'one', fields });
  await f.client.submit({ captureId: 'one', fields });
  await assert.rejects(f.client.submit({ captureId: 'one', fields: { ...fields, projectId: 'different' } }), { code: 'operation_id_conflict' });
  f.activate(); f.switchAccount(); await assert.rejects(f.client.flush(), { code: 'sign_in_required' });
  assert.equal(f.requests.length, 0);
  const other = await openQuickCapture({ ...f.options, accountKey: 'other' }); t.after(() => other.close()); assert.deepEqual(await other.list(), []);
});
test('invalid metadata and credential-bearing links are rejected without truncation', () => {
  for (const change of [{ sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://u:pw@example.org' },
    { text: 'x'.repeat(8001) }, { projectId: '../bad' }, { nextAction: 'x'.repeat(501) }, { arbitrary: true }])
    assert.throws(() => captureIntent({ accountKey: 'owner', captureId: 'one', fields: { ...fields, ...change } }), { code: 'capture_invalid' });
});

test('actual quick-capture button secures full input before clearing and only claims lead after receipt', async t => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = source.indexOf('let _v4CaptureBusy = false;'), end = source.indexOf('\nfunction renderV3ChatgptCockpit', start);
  assert.ok(start > 0 && end > start);
  const f = await fixture(t); f.activate(); let release;
  const client = await openQuickCapture({ ...f.options, fetchImpl: async (...args) => {
    if (!release) await new Promise(resolve => { release = resolve; });
    return f.options.fetchImpl(...args);
  } }); t.after(() => client.close());
  const inputs = Object.fromEntries(Object.entries({ dbLeadTitle: fields.title, dbLeadText: fields.text,
    dbLeadProject: fields.projectId, dbLeadSource: fields.sourceUrl, dbLeadNext: fields.nextAction }).map(([id,value])=>[id,{value}]));
  const button = { disabled: false }; inputs.dbQuickLeadSubmit = button;
  const win = { _dbQuickLeadDraft: {}, dbQuickLeadDraftForAccount() { return this._dbQuickLeadDraft; }, dbLoadQuickCaptures: async () => {}, dbKeepLeadDraft() {} };
  const notices = []; let refreshed = 0;
  const mod = await import('../public/quantus-v4-quick-capture.mjs');
  new Function('window','document','dbQuickCaptureAccount','coreAuthCurrentUser','toast','dbRefreshCapturedLeads',source.slice(start,end))(
    win,{ getElementById: id => inputs[id] },async()=>({ accountKey:'owner',mod,client }),()=>({uid:'owner'}),
    (...args)=>notices.push(args),async()=>{refreshed++;});
  const sending = win.dbCreateQuickLead();
  for(let n=0;n<100&&!release;n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(typeof release,'function'); assert.equal(button.disabled,true);
  assert.equal(inputs.dbLeadText.value,''); assert.equal((await client.list())[0].legacyOperation.payload.text, fields.text);
  assert.ok(notices.some(n=>n[1]==='Anfrage auf diesem Gerät gesichert'));
  assert.ok(!notices.some(n=>n[1]==='Lead vom Server bestätigt'));
  await win.dbCreateQuickLead(); assert.equal((await client.list()).length,1);
  release(); await sending;
  assert.equal(refreshed,1); assert.equal(button.disabled,false);
  assert.ok(notices.some(n=>n[1]==='Lead vom Server bestätigt'));
});

test('receipt missing created lead cannot mark capture complete', async t => {
  const f = await fixture(t); f.activate();
  const client = await openQuickCapture({ ...f.options, fetchImpl: async (...args) => {
    const response = await f.options.fetchImpl(...args), body = await response.json();
    if (body.effect) delete body.entityVersions[body.effect.leadId];
    return new Response(JSON.stringify(body));
  } }); t.after(()=>client.close());
  await client.submit({ captureId:'one', fields }); await client.flush();
  assert.equal((await client.list())[0].deliveryStatus,'retry_wait'); assert.equal((await client.list())[0].leadId,null);
});
