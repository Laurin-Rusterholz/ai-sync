import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {waitingIntent,openLeadWaiting} from '../public/quantus-v4-lead-waiting.mjs';
const lead=()=>({id:'lead_one',title:'A lead',operationalState:'doing',operationalStateVersion:3,operationalStateSource:{model:1}});
const input=()=>({lead:lead(),counterparty:'Muster AG',nextAction:'Nachfragen',waitUntil:'2030-10-04T07:00:00.000Z',evidenceId:'proof_one'});
async function fixture(t){
 let run=null,account='owner',now=Date.parse('2030-10-03T10:00:00Z'),lose=false,wrong=false,conflict=false;
 const requests=[],committed=new Map();
 const options={accountKey:'owner',getAuth:async()=>({accountKey:account,idToken:'valid'}),getRun:()=>run,
  origin:'https://quantus.example',indexedDB:new IDBFactory(),now:()=>now,
  fetchImpl:async(url,init)=>{const cmd=JSON.parse(init.body),key=init.headers['Idempotency-Key'];requests.push({cmd,key});
   if(conflict)return new Response(JSON.stringify({error:'entity_version_conflict'}),{status:409});
   if(!committed.has(key))committed.set(key,{ok:true,applied:true,replayed:false,requestId:'r1',serverNow:'2030-10-03T10:00:00.000Z',dataRevision:7,entityVersions:{lead_one:4}});
   if(lose){lose=false;throw Error('lost');}const receipt=structuredClone(committed.get(key));if(wrong)receipt.entityVersions.lead_one=3;
   return new Response(JSON.stringify(receipt));}};
 const client=await openLeadWaiting(options);t.after(()=>client.close());
 return {client,options,requests,committed,activate:()=>{run={id:'run_2030-10-03',date:'2030-10-03',phase:'active'};},
  switch:()=>{account='other';},advance:()=>{now+=30000;},lose:()=>{lose=true;},wrong:()=>{wrong=true;},conflict:()=>{conflict=true;}};
}
test('complete waiting intent survives reload and no-run delay without locally changing the lead',async t=>{
 const f=await fixture(t),original=input();await f.client.submit(original);await f.client.flush();
 assert.equal(f.requests.length,0);assert.equal((await f.client.list())[0].deliveryStatus,'run_pending');
 const second=await openLeadWaiting(f.options);t.after(()=>second.close());f.activate();await second.flush();
 assert.deepEqual(f.requests[0].cmd.payload,{leadId:'lead_one',counterparty:'Muster AG',nextAction:'Nachfragen',waitUntil:original.waitUntil,evidenceRefs:['proof_one']});
 assert.equal(f.requests[0].cmd.verb,'lead.schedule');assert.equal(f.requests[0].cmd.expectedEntityVersion,3);
 assert.equal((await second.list())[0].deliveryStatus,'acknowledged');assert.deepEqual(original,input());
});
test('duplicate clicks and lost receipts retain one immutable operation',async t=>{
 const f=await fixture(t);f.activate();await f.client.submit(input());await f.client.submit(input());
 f.lose();await f.client.flush();assert.equal((await f.client.list())[0].deliveryStatus,'retry_wait');
 f.advance();await f.client.flush();assert.equal(f.requests[0].key,f.requests[1].key);assert.equal(f.committed.size,1);
 assert.equal((await f.client.list())[0].legacyOperation.nextAction,'Nachfragen');
});
test('an explicit corrected request preserves the previous intention and its captured version',async t=>{
 const f=await fixture(t);await f.client.submit(input());await f.client.submit({...input(),counterparty:'Corrected bank'});
 const entries=await f.client.list();assert.equal(entries.length,2);
 assert.deepEqual(entries.map(e=>e.legacyOperation.counterparty).sort(),['Corrected bank','Muster AG']);
 assert.ok(entries.every(e=>e.legacyOperation.version===3));
});
test('account switching cannot send or expose another owner waiting intent',async t=>{
 const f=await fixture(t);await f.client.submit(input());f.activate();f.switch();
 await assert.rejects(f.client.flush(),{code:'sign_in_required'});assert.equal(f.requests.length,0);
 const other=await openLeadWaiting({...f.options,accountKey:'other'});t.after(()=>other.close());assert.deepEqual(await other.list(),[]);
});
test('stale version and incomplete acknowledgement stay unconfirmed without rebasing the request',async t=>{
 for(const mode of ['wrong','conflict']){const f=await fixture(t);f.activate();await f.client.submit(input());f[mode]();await f.client.flush();
  assert.equal((await f.client.list())[0].deliveryStatus,mode==='wrong'?'retry_wait':'conflict');f.advance();await f.client.flush();
  assert.ok(f.requests.every(r=>r.cmd.expectedEntityVersion===3));}
});
test('invalid fields, calendar dates, missing proof and closed/unmigrated leads cannot be queued',async()=>{
 for(const change of [{counterparty:''},{nextAction:'x'.repeat(501)},{waitUntil:'2030-02-31T07:00:00.000Z'},
  {evidenceId:''},{lead:{id:'lead_one'}},{lead:{...lead(),operationalState:'done'}}])
  await assert.rejects(waitingIntent({accountKey:'owner',...input(),...change}));
});

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
test('actual proof selector excludes foreign, incomplete and ambiguous records',()=>{
 const start=html.indexOf('function chatgptLeadWaitingState(l) {'),end=html.indexOf('\nfunction chatgptLeadOperationalBoxHtml',start);
 const good={id:'proof_one',sourceType:'chatgptLead',sourceId:'lead_one',kind:'message',ref:'msg',fingerprint:'hash'};
 const APP={state:{data:{automation:{evidenceById:{proof_one:good,foreign:{...good,id:'foreign',sourceId:'other'},
  broken:{...good,id:'broken',fingerprint:null},ambiguous:{...good,id:'ambiguous'}},jobsById:{ambiguous:{id:'ambiguous'}}}}}};
 const state=new Function('APP',html.slice(start,end)+'\nreturn chatgptLeadWaitingState;')(APP);
 assert.deepEqual(state(lead()).options.map(o=>o.id),['proof_one']);assert.ok(state(lead()).addressable);
 assert.ok(!state({id:'lead_one'}).addressable);
});
test('actual waiting button submits a versioned command and uses Zurich time without local status writes',()=>{
 const start=html.indexOf('case "cgl-set-waiting-external": {'),end=html.indexOf('\n    // Verschiebungen',start);
 const timeStart=html.indexOf('function v3ZurichLocalToUtcIso('),timeEnd=html.indexOf('\n// Dieselbe',timeStart);
 const convert=new Function(html.slice(timeStart,timeEnd)+'\nreturn v3ZurichLocalToUtcIso;')();
 assert.equal(convert('2030-07-01','09:00'),'2030-07-01T07:00:00.000Z');assert.equal(convert('2030-12-01','09:00'),'2030-12-01T08:00:00.000Z');
 assert.equal(convert('2030-02-31','09:00'),null);
 const original=lead(),values={cglWaitOn_lead_one:'Muster AG',cglWaitNext_lead_one:'Nachfragen',cglWaitUntil_lead_one:'2030-07-01',cglWaitEvidence_lead_one:'proof_one'},calls=[];
 const run=new Function('action','id','leads','stop','ownEntity','document','toast','chatgptLeadWaitingState','v3ZurichLocalToUtcIso','cglSaveWaiting',
  'switch(action){'+html.slice(start,end)+'}');
 run('cgl-set-waiting-external','lead_one',{lead_one:original},()=>{},(m,id)=>m[id],{getElementById:id=>({value:values[id]})},()=>{},
  ()=>({options:[{id:'proof_one'}]}),convert,(l,v)=>calls.push({l,v}));
 assert.equal(calls.length,1);assert.equal(calls[0].v.waitUntil,'2030-07-01T07:00:00.000Z');assert.deepEqual(original,lead());
});
test('actual postpone button retains the confirmed proof and never fabricates progress or a local state',()=>{
 const start=html.indexOf('case "cgl-postpone-followup": {'),end=html.indexOf('\n    // Konzept v2 A/B',start);
 const original=lead(),waiting={counterparty:'Bank',nextAction:'Nachfragen',evidence:{kind:'evidence',evidenceId:'proof_one'}};
 const APP={state:{data:{automation:{waitingById:{'chatgptLead:lead_one':waiting}}}}},calls=[];
 const run=new Function('action','id','leads','stop','ownEntity','document','toast','APP','v3ZurichLocalToUtcIso','cglSaveWaiting',
  'switch(action){'+html.slice(start,end)+'}');
 run('cgl-postpone-followup','lead_one',{lead_one:original},()=>{},(m,id)=>m[id],
  {getElementById:id=>({value:id.startsWith('cglPostponeAction')?'Neuer Text':'2030-10-05'})},()=>{},APP,()=> '2030-10-05T07:00:00.000Z',(l,v)=>calls.push(v));
 assert.deepEqual(calls,[{counterparty:'Bank',nextAction:'Neuer Text',waitUntil:'2030-10-05T07:00:00.000Z',evidenceId:'proof_one'}]);
 assert.deepEqual(original,lead());assert.equal(waiting.nextAction,'Nachfragen');
});
test('acknowledged waiting change can be read back after failure without another command or root upload',async()=>{
 const start=html.indexOf('async function cglFlushCancellations('),end=html.indexOf('\nwindow.cglLoadCancellations',start);
 let reads=0,backups=0,renders=0;const APP={state:{data:{old:true}}};
 const flush=new Function('coreAuthCurrentUser','remoteGetByKey','idbBackup','APP','mergeData','normalizeData','guardV3ProtectedWrite','saveLocalData','cglKeepStateDrafts','render',
  html.slice(start,end)+'\nreturn cglFlushCancellations;')(()=>({uid:'owner'}),async()=>++reads===1?{ok:false}:{ok:true,data:{confirmed:true}},
  async()=>{backups++;return true;},APP,(a,b)=>b,v=>v,async()=>false,()=>{},()=>{},()=>{renders++;});
 const client={list:async()=>[{operationId:'same',deliveryStatus:'acknowledged'}],flush:async()=>{}};
 await flush(client,'owner','pre_waiting_refresh',true);assert.deepEqual(APP.state.data,{old:true});
 await flush(client,'owner','pre_waiting_refresh',true);assert.deepEqual(APP.state.data,{confirmed:true});assert.equal(backups,1);assert.equal(renders,1);
});
test('typed waiting drafts are preserved before rerender and bound to the active owner and lead',()=>{
 const start=html.indexOf('function cglKeepStateDrafts() {'),end=html.indexOf('\nconst _v4CancellationBusy',start);
 const window={};
 const keep=new Function('window','document','coreAuthCurrentUser',html.slice(start,end)+'\nreturn cglKeepStateDrafts;')(
  window,{getElementById:id=>id==='cglWaitingQueue'?{dataset:{leadId:'lead_one'}}:id==='cglWaitNext_lead_one'?{value:'Changed while saving'}:null},()=>({uid:'owner'}));
 keep();assert.deepEqual(window._cglWaitingDraft,{accountKey:'owner',leadId:'lead_one',fields:{cglWaitNext:'Changed while saving'}});
});
test('actual save waits for durable storage before rendering, preserving the original lead',async t=>{
 const f=await fixture(t);let release;const gate=new Promise(r=>{release=r;}),renders=[];
 const start=html.indexOf('async function cglSaveWaiting(l, input) {'),end=html.indexOf('\nfunction viewChatgptLeadDetail',start);
 const save=new Function('_v4WaitingBusy','coreAuthCurrentUser','cglWaitingAccount','cglKeepStateDrafts','render','toast','cglFlushCancellations','window',
  html.slice(start,end)+'\nreturn cglSaveWaiting;')(new Set(),()=>({uid:'owner'}),async()=>({accountKey:'owner',client:{submit:async v=>{await gate;return f.client.submit(v);}}}),
  ()=>{},()=>renders.push(1),()=>{},async()=>{},{cglLoadWaiting:async()=>{}});
 const original=lead(),pending=save(original,input());await Promise.resolve();await Promise.resolve();assert.equal(renders.length,0);
 await save(original,input());release();await pending;assert.equal((await f.client.list()).length,1);assert.deepEqual(original,lead());assert.equal(renders.length,1);
});
