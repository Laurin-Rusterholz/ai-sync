import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {openQuickCapture} from '../public/quantus-v4-quick-capture.mjs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function fn(name){const start=html.indexOf('function '+name+'(');assert.ok(start>0);return html.slice(start,html.indexOf('\n}\n',start)+3);}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('lead inbox renders shared account-bound capture, restores exact draft and loads retained requests',()=>{
  const win={dbQuickLeadDraftForAccount:()=>({title:'<Original>',text:'Mehrzeilig\n& vollständig',source:'https://example.org',projectId:'p',next:'Prüfen'})};
  new Function('window','coreAuthCurrentUser','esc',fn('renderBriefingQuickLead')+';window.renderBriefingQuickLead=renderBriefingQuickLead;')(win,()=>({uid:'owner'}),esc);
  let pending;
  const view=new Function('APP','window','setTimeout','chatgptLeadIsClosed','chatgptLeadDisplayStatus',fn('viewChatgptLeads')+';return viewChatgptLeads;')({state:{data:{entities:{chatgptLeads:{},projects:{p:{id:'p',title:'Projekt'},gone:{id:'gone',deleted:true}}}}}},win,f=>pending=f,()=>false,()=> 'neu');
  const actual=view();assert.match(actual,/id="dbQuickCaptureQueue"/);assert.match(actual,/data-account-key="owner"/);
  assert.match(actual,/&lt;Original&gt;/);assert.match(actual,/Mehrzeilig\n&amp; vollständig/);assert.match(actual,/value="p" selected/);assert.ok(!actual.includes('value="gone"'));
  let loaded=0;win.dbLoadQuickCaptures=()=>loaded++;pending();assert.equal(loaded,1);
  assert.ok(!actual.includes('id="cglQuickTitle"'));assert.match(actual,/data-action="cgl-quick-title"/);
});
test('legacy keyboard submit dispatches shared async capture and cannot create a local lead',()=>{
  const start=html.indexOf('    case "cgl-quick-create": {'),end=html.indexOf('    case "cgl-mark-read":',start);let submitted=0,stopped=0;
  const invoke=new Function('window','stop','action','switch(action){'+html.slice(start,end)+'}');
  invoke({dbCreateQuickLead:()=>submitted++},()=>stopped++,'cgl-quick-create');
  assert.equal(submitted,1);assert.equal(stopped,1);
});
test('draft retention ignores another account and absent form, including background render',()=>{
  const start=html.indexOf('window.dbQuickLeadDraftForAccount = function()'),end=html.indexOf('window.dbKeepWeekDraft',start);
  let uid='owner',formOwner='owner',present=true;
  const win={},fields={dbLeadTitle:'Titel',dbLeadText:'Nicht verlieren',dbLeadSource:'',dbLeadProject:'',dbLeadNext:''};
  const document={getElementById:id=>id==='dbQuickLead'?(present?{getAttribute:()=>formOwner}:null):{value:fields[id]||''}};
  new Function('window','document','coreAuthCurrentUser',html.slice(start,end))(win,document,()=>({uid}));
  win.dbKeepLeadDraft();assert.equal(win._dbQuickLeadDraft.text,'Nicht verlieren');
  present=false;fields.dbLeadText='';win.dbKeepLeadDraft();assert.equal(win._dbQuickLeadDraft.text,'Nicht verlieren');
  present=true;uid='other';win.dbKeepLeadDraft();assert.deepEqual(win.dbQuickLeadDraftForAccount(),{});assert.equal(win._dbQuickLeadDraft.accountKey,'owner');
  uid='owner';assert.equal(win.dbQuickLeadDraftForAccount().text,'Nicht verlieren');
});
test('account changes during authentication cannot transfer form content to the new account',async()=>{
  let uid='owner',submits=0;const win={dbQuickLeadDraftForAccount:()=>({})};
  const start=html.indexOf('let _v4CaptureBusy = false;'),end=html.indexOf('\nfunction renderV3ChatgptCockpit',start);
  const input={value:'Private original'},button={disabled:false};
  new Function('window','document','dbQuickCaptureAccount','coreAuthCurrentUser','toast','dbRefreshCapturedLeads',html.slice(start,end))(
    win,{getElementById:id=>id==='dbQuickLead'?{getAttribute:()=> 'owner'}:id==='dbQuickLeadSubmit'?button:input},
    async()=>{uid='other';return {accountKey:'other',client:{submit:async()=>submits++}}},()=>({uid}),()=>{},()=>{});
  await win.dbCreateQuickLead();assert.equal(submits,0);assert.equal(input.value,'Private original');assert.equal(button.disabled,false);
});
test('queue submit rejects stale authentication and cannot accept a caller-supplied account override',async t=>{
  let uid='other';const client=await openQuickCapture({accountKey:'owner',getAuth:async()=>({accountKey:uid}),getRun:()=>null,origin:'https://quantus.example',indexedDB:new IDBFactory()});t.after(()=>client.close());
  await assert.rejects(client.submit({captureId:'one',fields:{title:'Original'}}),{code:'sign_in_required'});assert.deepEqual(await client.list(),[]);
  uid='owner';await client.submit({accountKey:'other',captureId:'one',fields:{title:'Original'}});
  const entries=await client.list();assert.equal(entries.length,1);assert.equal(entries[0].accountKey,'owner');
});
test('confirmed capture readback preserves local data before merge and fences failed backup and account changes',async()=>{
  for(const scenario of ['ok','backup_failed','account_changed','protected_conflict']){
    let uid='owner';const calls=[],local={meta:{updatedAt:'same'},local:'draft'},remote={meta:{updatedAt:'same'},entities:{chatgptLeads:{new_lead:{id:'new_lead'}}}},APP={state:{data:local}};
    const source='async '+fn('dbRefreshCapturedLeads')+';return dbRefreshCapturedLeads;';
    const run=new Function('APP','coreAuthCurrentUser','remoteGetByKey','idbBackup','mergeData','normalizeData','guardV3ProtectedWrite','saveLocalData','render',source)(APP,()=>({uid}),async()=>{calls.push('read');return {ok:true,data:remote}},async data=>{assert.equal(data,local);calls.push('backup');if(scenario==='account_changed')uid='other';return scenario!=='backup_failed'},(a,b)=>{calls.push('merge');return {...a,...b}},x=>x,async()=>scenario==='protected_conflict',()=>calls.push('saveLocal'),()=>calls.push('render'));
    await run('owner');
    if(scenario==='ok'){assert.deepEqual(calls,['read','backup','merge','saveLocal','render']);assert.equal(APP.state.data.local,'draft');assert.ok(APP.state.data.entities.chatgptLeads.new_lead);}
    else {assert.equal(APP.state.data,local);assert.ok(!calls.includes('saveLocal'));assert.ok(!calls.includes('render'));}
  }
});

test('retry recovers an acknowledged lead absent locally without registering another capture',async()=>{
  const APP={state:{data:{entities:{chatgptLeads:{}}}}};let reads=0,flushes=0;
  const entries=[{operationId:'one',leadId:'server_lead'}];
  const run=new Function('APP','coreAuthCurrentUser','dbRefreshCapturedLeads','async '+fn('dbFlushQuickCaptures')+';return dbFlushQuickCaptures;')(APP,()=>({uid:'owner'}),async()=>{reads++;APP.state.data.entities.chatgptLeads.server_lead={id:'server_lead'}});
  const client={list:async()=>entries,flush:async()=>flushes++};
  await run(client,'owner');assert.equal(reads,1);assert.equal(flushes,1);
  await run(client,'owner');assert.equal(reads,1);assert.equal(flushes,2);
});
