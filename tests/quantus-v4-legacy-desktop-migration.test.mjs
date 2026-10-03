import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCore, v3Spuren, requireCore } from '../netlify/lib/assistant-migration.mjs';
import { effektiverZustand } from '../netlify/lib/assistant-schema.mjs';
const now=Date.parse('2026-10-03T03:00:00Z');
const lead=(id,state,extra={})=>({id,title:'Legacy '+id,status:'in_arbeit',assignee:'chatgpt',
  operationalState:state,pendingQuestion:{kind:'information',text:'Original question',options:['Option']},...extra});
const seed=()=>({entities:{chatgptLeads:{a:lead('a','information_required'),b:lead('b','information_required'),
  c:lead('c','doing'),d:lead('d','decision_required')}},dailyBriefing:{routines:[{id:'r',archived:true}],
  dailyLog:{'2026-10-03':{notes:'Original review'}}},_deleteLog:{tasks:{gone:1}},custom:{keep:true}});

test('pre-canonical desktop states migrate once without losing originals or pretending waiting proof',()=>{
  const input=seed(),before=structuredClone(input),result=migrateCore(input,{now});
  assert.deepEqual(input,before);assert.equal(result.report.mode,'initial');
  assert.deepEqual(v3Spuren(input),[]);
  requireCore(result.data);
  for(const id of ['a','b','d']){
    const e=result.data.entities.chatgptLeads[id];
    assert.equal(e.operationalState,null);assert.equal(e.operationalStateUnmapped,'ambiguous');
    assert.equal(e.operationalStateSource.legacyDesktopState,input.entities.chatgptLeads[id].operationalState);
    assert.deepEqual(e.pendingQuestion,input.entities.chatgptLeads[id].pendingQuestion);
    assert.equal(effektiverZustand('chatgptLead',e).unmapped,true);
  }
  assert.equal(result.data.entities.chatgptLeads.c.operationalState,'doing');
  assert.equal(result.report.conflicts.length,3);
  assert.deepEqual(result.data.dailyBriefing.dailyLog,input.dailyBriefing.dailyLog);
  assert.deepEqual(result.data.dailyBriefing.routines,input.dailyBriefing.routines);
  assert.deepEqual(result.data._deleteLog,input._deleteLog);assert.deepEqual(result.data.custom,input.custom);
  const repeat=migrateCore(result.data,{now:now+60000});
  assert.equal(repeat.changed,false);assert.deepEqual(repeat.data,result.data);
});

test('any canonical marker keeps a missing ledger fail-closed, including null and invalid markers',()=>{
  for(const field of ['operationalStateSource','operationalStateVersion','operationalRoles','operationalStateUnmapped']){
    for(const value of [null,0,{},'invalid']){
      const input=seed();input.entities.chatgptLeads.a[field]=value;const before=structuredClone(input);
      assert.throws(()=>migrateCore(input,{now}),{code:'CORE_PARTIAL_V3'},field);
      assert.deepEqual(input,before);
    }
  }
  for(const field of ['automation','assistantRuns']){
    const input=seed();if(field==='automation')input.automation={};else input.dailyBriefing.assistantRuns={};
    assert.throws(()=>migrateCore(input,{now}),{code:'CORE_PARTIAL_V3'});
  }
});

test('damaged migrated cores cannot be reinitialized through the desktop exception',()=>{
  const valid=migrateCore(seed(),{now}).data;
  for(const path of ['automation','automation.idempotencyByKey','automation.outboxById','automation.dataRevision','dailyBriefing.assistantRuns']){
    const damaged=structuredClone(valid),parts=path.split('.');let obj=damaged;
    for(const p of parts.slice(0,-1))obj=obj[p];delete obj[parts.at(-1)];
    assert.throws(()=>migrateCore(damaged,{now}),{code:'CORE_PARTIAL_V3'},path);
  }
});

test('only recognized legacy Lead shapes qualify; other collections and canonical-only states do not',()=>{
  for(const state of ['waiting_user','delegated','made_up',null]){
    const input=seed();input.entities.chatgptLeads.a.operationalState=state;
    assert.throws(()=>migrateCore(input,{now}),{code:'CORE_PARTIAL_V3'});
  }
  const task=seed();task.entities.tasks={t:{id:'t',status:'doing',operationalState:'doing'}};
  assert.throws(()=>migrateCore(task,{now}),{code:'CORE_PARTIAL_V3'});
  const bad=seed();bad.entities.chatgptLeads.a.status='unrecognized';
  assert.throws(()=>migrateCore(bad,{now}),{code:'CORE_PARTIAL_V3'});
});

test('desktop closure cannot silently close an open legacy lead; matching legacy closure remains auditable',()=>{
  const input={entities:{chatgptLeads:{open:lead('open','done'),closed:lead('closed','done',{status:'abgeschlossen'}),
    cancelled:lead('cancelled','cancelled',{status:'abgeschlossen',closedBy:'laurin',obsoleteReason:'Duplicate'})}}};
  const {data}=migrateCore(input,{now});
  assert.equal(data.entities.chatgptLeads.open.operationalState,null);
  assert.equal(data.entities.chatgptLeads.closed.operationalState,'done');
  assert.equal(data.entities.chatgptLeads.cancelled.operationalState,'cancelled');
  assert.equal(data.entities.chatgptLeads.open.operationalStateSource.legacyDesktopState,'done');
});

test('repeat migration maps a new desktop lead without resetting any existing ledger or revision',()=>{
  const data=migrateCore({entities:{}},{now}).data;
  data.automation.dataRevision=37;
  data.automation.idempotencyByKey.saved={historical:'receipt'};
  data.automation.outboxById.sent={historical:'effect'};
  const before=structuredClone(data.automation);
  data.entities.chatgptLeads.new=lead('new','information_required');
  const result=migrateCore(data,{now:now+1});
  assert.equal(result.report.mode,'repeat');
  assert.equal(result.data.automation.dataRevision,37);
  assert.deepEqual(result.data.automation.idempotencyByKey,before.idempotencyByKey);
  assert.deepEqual(result.data.automation.outboxById,before.outboxById);
  assert.equal(result.data.entities.chatgptLeads.new.operationalState,null);
});
