import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {cancellationIntent,openLeadCancellations} from '../public/quantus-v4-lead-cancellation.mjs';
const lead=()=>({id:'lead_one',title:'A lead',operationalState:'doing',operationalStateVersion:3,operationalStateSource:{model:1}});
async function fixture(t){
  let run=null,account='owner',now=Date.parse('2026-10-03T10:00:00Z'),lose=false,wrong=false,conflict=false;
  const requests=[],committed=new Map();
  const options={accountKey:'owner',getAuth:async()=>({accountKey:account,idToken:'valid'}),getRun:()=>run,
    origin:'https://quantus.example',indexedDB:new IDBFactory(),now:()=>now,
    fetchImpl:async(url,init)=>{const cmd=JSON.parse(init.body),key=init.headers['Idempotency-Key'];requests.push({cmd,key});
      if(conflict)return new Response(JSON.stringify({error:'entity_version_conflict'}),{status:409});
      if(!committed.has(key))committed.set(key,{ok:true,applied:true,replayed:false,requestId:'r1',serverNow:'2026-10-03T10:00:00.000Z',dataRevision:7,entityVersions:{lead_one:4}});
      if(lose){lose=false;throw Error('lost');}
      const receipt=structuredClone(committed.get(key));if(wrong)receipt.entityVersions.lead_one=3;
      return new Response(JSON.stringify(receipt));}};
  const client=await openLeadCancellations(options);t.after(()=>client.close());
  return {client,options,requests,committed,activate:()=>{run={id:'run_2026-10-03',date:'2026-10-03',phase:'active'};},
    switch:()=>{account='other';},advance:()=>{now+=30000;},lose:()=>{lose=true;},wrong:()=>{wrong=true;},conflict:()=>{conflict=true;}};
}
test('durable reason survives reload while no run exists; cancellation uses captured version',async t=>{
  const f=await fixture(t),original=lead();await f.client.submit({lead:original,reason:'No longer needed'});await f.client.flush();
  assert.equal(f.requests.length,0);assert.equal((await f.client.list())[0].deliveryStatus,'run_pending');
  const second=await openLeadCancellations(f.options);t.after(()=>second.close());f.activate();await second.flush();
  assert.deepEqual(f.requests[0].cmd.payload,{leadId:'lead_one',toState:'cancelled',reason:'No longer needed'});
  assert.equal(f.requests[0].cmd.expectedEntityVersion,3);assert.equal((await second.list())[0].deliveryStatus,'acknowledged');
  assert.deepEqual(original,lead());
});
test('lost response retries the same immutable command; duplicate clicks do not duplicate cancellation',async t=>{
  const f=await fixture(t);f.activate();await f.client.submit({lead:lead(),reason:'reason'});await f.client.submit({lead:lead(),reason:'reason'});
  f.lose();await f.client.flush();assert.equal((await f.client.list())[0].deliveryStatus,'retry_wait');
  f.advance();await f.client.flush();assert.equal(f.requests[0].key,f.requests[1].key);assert.equal(f.committed.size,1);
  assert.equal((await f.client.list())[0].deliveryStatus,'acknowledged');
});
test('different reason for same lead version conflicts instead of overwriting intention',async t=>{
  const f=await fixture(t);await f.client.submit({lead:lead(),reason:'first'});
  await assert.rejects(f.client.submit({lead:lead(),reason:'second'}),{code:'operation_id_conflict'});
  assert.equal((await f.client.list())[0].legacyOperation.reason,'first');
});
test('account switch cannot dispatch or expose another account queue',async t=>{
  const f=await fixture(t);await f.client.submit({lead:lead(),reason:'private'});f.activate();f.switch();
  await assert.rejects(f.client.flush(),{code:'sign_in_required'});assert.equal(f.requests.length,0);
  const second=await openLeadCancellations({...f.options,accountKey:'other'});t.after(()=>second.close());assert.deepEqual(await second.list(),[]);
});
test('wrong receipt version cannot claim closure, stale entity rejection cannot rebase',async t=>{
  for(const mode of ['wrong','conflict']){const f=await fixture(t);f.activate();await f.client.submit({lead:lead(),reason:'reason'});f[mode]();await f.client.flush();
    assert.equal((await f.client.list())[0].deliveryStatus,mode==='wrong'?'retry_wait':'conflict');
    f.advance();await f.client.flush();assert.ok(f.requests.every(r=>r.cmd.expectedEntityVersion===3));}
});
test('invalid reason, unmigrated and closed entities remain untouched',async()=>{
  for(const input of [{lead:lead(),reason:''},{lead:lead(),reason:'x'.repeat(1001)},{lead:{id:'lead_one'},reason:'r'},
    {lead:{...lead(),operationalState:'cancelled'},reason:'r'}])await assert.rejects(cancellationIntent({accountKey:'owner',...input}));
});
test('actual UI secures the intent before clearing the form and never marks the lead closed locally',async t=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const start=html.indexOf('const _v4CancellationBusy = new Set();'),end=html.indexOf('\nfunction viewChatgptLeadDetail',start);
  assert.ok(start>0&&end>start);const f=await fixture(t);let release;
  const gate=new Promise(resolve=>{release=resolve;}),win={_cglObsolete:{id:'lead_one',grund:'reason'},cglLoadCancellations:async()=>{}};
  const notices=[];const client={submit:async args=>{await gate;return f.client.submit(args);}};
  const cancel=new Function('window','cglCancellationAccount','coreAuthCurrentUser','render','toast','cglFlushCancellations','cglKeepStateDrafts',html.slice(start,end)+'\nreturn cglCancelLead;')(
    win,async()=>({client,accountKey:'owner'}),()=>({uid:'owner'}),()=>{},(...args)=>notices.push(args),async()=>{},()=>{});
  const original=lead(),pending=cancel(original,'reason');await Promise.resolve();await Promise.resolve();
  assert.equal(win._cglObsolete.grund,'reason');await cancel(original,'reason');release();await pending;
  assert.equal((await f.client.list()).length,1);assert.equal(win._cglObsolete,null);assert.deepEqual(original,lead());
  assert.ok(notices.some(n=>n[1]==='Auftrag gesichert'));assert.ok(!notices.some(n=>n[1]==='Als hinfällig geschlossen'));
});
test('canonical closure controls the displayed closed state, independent of old status',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const start=html.indexOf('function chatgptLeadIsClosed(l) {'),end=html.indexOf('\n}',start)+2;
  const closed=new Function(html.slice(start,end)+'\nreturn chatgptLeadIsClosed;')();
  assert.equal(closed({...lead(),operationalState:'cancelled',status:'in_arbeit'}),true);
  assert.equal(closed({...lead(),operationalState:'doing',status:'abgeschlossen'}),false);
  assert.equal(closed({...lead(),operationalState:null,status:'abgeschlossen'}),false);
  assert.equal(closed({status:'abgeschlossen'}),true);
});
test('reopening is an explicit version-bound intent and retains its full reason',async()=>{
  const intent=await cancellationIntent({accountKey:'owner',lead:{...lead(),operationalState:'cancelled'},toState:'doing',reason:'New documents need review'});
  assert.equal(intent.legacyOperation.toState,'doing');assert.equal(intent.legacyOperation.reason,'New documents need review');
  await assert.rejects(cancellationIntent({accountKey:'owner',lead:lead(),toState:'doing',reason:'not closed'}));
});
