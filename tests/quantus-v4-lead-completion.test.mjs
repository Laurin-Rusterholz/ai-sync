import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {cancellationIntent,openLeadCancellations,cancellationStatusText} from '../public/quantus-v4-lead-cancellation.mjs';
const lead=()=>({id:'l1',title:'Original',result:'Ergebnis mit Umlaut ä\nVollständig.',operationalState:'doing',operationalStateVersion:3,operationalStateSource:{model:1},operationalRoles:{accountable:'chatgpt',executor:'openai'}});
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const extract=name=>{const start=html.indexOf('function '+name+'(');assert.ok(start>0);return html.slice(start,html.indexOf('\n}\n',start)+3);};
const candidates=(data,l=lead())=>new Function('APP','chatgptLeadMissing',extract('chatgptLeadCompletionState')+'\nreturn chatgptLeadCompletionState;')({state:{data}},()=>[])(l);
async function fixture(t){let remote=lead(),now=Date.parse('2026-10-03T10:00:00Z'),lost=false;const calls=[],committed=new Map();
 const options={accountKey:'owner',getAuth:async()=>({accountKey:'owner',idToken:'test'}),getRun:()=>({id:'run_2026-10-03',date:'2026-10-03',phase:'active'}),getLead:async()=>remote,
  origin:'https://quantus.example',indexedDB:new IDBFactory(),now:()=>now,fetchImpl:async(url,init)=>{const cmd=JSON.parse(init.body),key=init.headers['Idempotency-Key'];calls.push({cmd,key});
   if(!committed.has(key))committed.set(key,{ok:true,applied:true,replayed:false,requestId:'r1',serverNow:'2026-10-03T10:00:00.000Z',dataRevision:9,entityVersions:{l1:4}});
   if(lost){lost=false;throw Error('lost');}return new Response(JSON.stringify(committed.get(key)));}};
 const client=await openLeadCancellations(options);t.after(()=>client.close());return {client,options,calls,committed,remote:r=>{remote=r;},lose:()=>{lost=true;},advance:()=>{now+=30000;}};
}
test('completion waits for the exact persisted result, then sends chosen proof and result hash',async t=>{
 const f=await fixture(t),l=lead();await f.client.submit({lead:l,reason:'Geprüft',toState:'done',evidenceRefs:['ev_1']});f.remote({...l,result:'Alter Serverstand'});await f.client.flush();
 assert.equal(f.calls.length,0);assert.equal((await f.client.list())[0].deliveryStatus,'completion_pending');f.remote(l);await f.client.flush();
 assert.equal(f.calls.length,1);const p=f.calls[0].cmd.payload;
 assert.deepEqual(p.evidenceRefs,['ev_1']);assert.equal(p.expectedResultHash,createHash('sha256').update(l.result).digest('hex'));
 assert.equal((await f.client.list())[0].deliveryStatus,'acknowledged');assert.equal(cancellationStatusText('acknowledged','done'),'Abschluss vom Server bestätigt');
});
test('lost completion reply survives reload and reuses one immutable request',async t=>{
 const f=await fixture(t);await f.client.submit({lead:lead(),reason:'Geprüft',toState:'done',evidenceRefs:['ev_1']});f.lose();await f.client.flush();
 const second=await openLeadCancellations(f.options);t.after(()=>second.close());f.advance();await second.flush();assert.equal(f.calls[0].key,f.calls[1].key);assert.equal(f.committed.size,1);
 assert.equal((await second.list())[0].deliveryStatus,'acknowledged');
});
test('changed results create distinct explicit intents without replacing earlier result evidence',async t=>{
 const f=await fixture(t);for(const result of ['first','second'])await f.client.submit({lead:{...lead(),result},reason:'Geprüft',toState:'done',evidenceRefs:['ev_1']});
 const entries=await f.client.list();assert.equal(entries.length,2);assert.deepEqual(entries.map(e=>e.legacyOperation.result).sort(),['first','second']);
 assert.notEqual(entries[0].operationId,entries[1].operationId);
});
test('invalid proof references and missing result are rejected without truncation',async()=>{
 for(const input of [{lead:{...lead(),result:''},evidenceRefs:[]},{lead:lead(),evidenceRefs:['a','b']},{lead:lead(),evidenceRefs:['bad.id']}])
  await assert.rejects(cancellationIntent({accountKey:'owner',reason:'Geprüft',toState:'done',...input}));
});
test('UI proof choices exclude foreign, ambiguous, unreviewed and instruction-only records',()=>{
 const own={sourceType:'chatgptLead',sourceId:'l1'};
 const data={automation:{evidenceById:{ev:{id:'ev',...own,kind:'message',ref:'m',fingerprint:'fp'},foreign:{id:'foreign',...own,sourceId:'l2',ref:'m',fingerprint:'fp'},collision:{id:'collision',...own,ref:'m',fingerprint:'fp'}},
  jobsById:{job:{id:'job',...own,state:'returned',purpose:'Checked',result:{ref:'r',hash:'h'},review:{verdict:'accepted',resultRef:'r',resultHash:'h'}},bad:{id:'bad',...own,state:'returned',result:{ref:'r',hash:'changed'},review:{verdict:'accepted',resultRef:'r',resultHash:'old'}}},
  questionsById:{q:{id:'q',...own,status:'answered'},collision:{id:'collision',...own,status:'answered'}},
  answersById:{answer:{id:'answer',questionId:'q',consumedAt:'2026-10-03',text:'Done'},instruction:{id:'instruction',questionId:'q',consumedAt:'2026-10-03',consumption:{kind:'intake'}}}}};
 assert.deepEqual(candidates(data).options.map(x=>x.id),['ev','job','answer']);assert.deepEqual(candidates(data).missing,[]);
 data.automation.questionsById.q.status='open';assert.ok(candidates(data).missing.includes('offene Rückfrage'));
 data.automation.jobsById.job.state='running';assert.ok(candidates(data).missing.includes('laufender Auftrag'));
});
test('own user task needs no external proof, unmapped state and missing roles remain blocked',()=>{
 assert.deepEqual(candidates({}, {...lead(),operationalRoles:{accountable:'user',executor:'user'}}).missing,[]);
 assert.ok(candidates({}).missing.includes('zugeordneter Abschlussnachweis'));
 assert.ok(candidates({}, {...lead(),operationalState:null}).missing.includes('abschliessbarer Betriebszustand'));
 assert.ok(candidates({}, {...lead(),operationalRoles:null}).missing.includes('bestätigte Zuständigkeit'));
});
test('actual close action submits selected proof and never changes local closure fields',()=>{
 const start=html.indexOf('    case "cgl-close": {'),end=html.indexOf('    case "cgl-warten-cancel":',start);assert.ok(start>0&&end>start);
 const body='switch(action){'+html.slice(start,end)+'}';const requests=[],notices=[],l=lead(),original=structuredClone(l);let selected='';
 const click=new Function('action','id','leads','ownEntity','stop','chatgptLeadCompletionState','document','toast','cglCancelLead',body);
 const invoke=()=>click('cgl-close','l1',{l1:l},(map,id)=>map[id],()=>{},()=>({missing:[],options:[{id:'ev_1'}],self:false}),{getElementById:()=>({value:selected})},(...a)=>notices.push(a),(...a)=>requests.push(a));
 invoke();assert.equal(requests.length,0);selected='ev_1';invoke();assert.equal(requests.length,1);assert.equal(requests[0][2],'done');assert.deepEqual(requests[0][3],['ev_1']);assert.deepEqual(l,original);
});
