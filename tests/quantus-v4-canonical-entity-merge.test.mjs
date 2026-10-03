import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function fn(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start > 0);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
}
const start = html.indexOf('const TRANSPORT_ROOTS = new Set([');
const transport = html.slice(start, html.indexOf(']);', start) + 3);
function merge(local, remote, tombstones = {}) {
  const build = new Function('idbBackup', 'localStorage', 'normalizeData', 'mergeAndPersistDeleteLog', 'flattenDeleteLog', 'console',
    transport + '\n' + ['entityTimestamp', 'mergeEntity', 'applyTombstonesToList', 'markV3ProtectedGap', 'markV3LocalDivergence', 'mergeData'].map(fn).join('\n') + '\nreturn mergeData;');
  return build(() => {}, {setItem() {}}, d => d, () => tombstones, d => d, {log() {}, warn() {}})(local, remote);
}
const canonical = () => ({id:'lead', title:'Server', updatedAt:'2026-10-01T10:00:00Z', status:'in_arbeit', operationalState:'doing', operationalStateVersion:1,
  operationalStateSource:{model:1, legacyValue:'in_arbeit', mappedAt:'2026-10-03T03:17:10Z'}, operationalRoles:{accountable:'chatgpt',executor:'openai'}});
const data = (item, key='chatgptLeads') => ({entities:{[key]:item ? {lead:item} : {}}});
const fields = ['operationalState','operationalStateVersion','operationalStateSource','operationalRoles','operationalStateUnmapped'];
for (const collection of ['chatgptLeads','chatgptTasks','tasks']) {
  test(collection + ': old UI edits cannot replace the canonical tuple or its closure proof', () => {
    const remote = {...canonical(), operationalState:'done', operationalStateVersion:4};
    remote.operationalStateSource.closure = {kind:'evidence',id:'receipt'};
    for (const timestamp of [remote.updatedAt, '2026-10-04T10:00:00Z']) {
      const local = {id:'lead',title:'Edited locally',updatedAt:timestamp,operationalState:'decision_required',comments:[{id:'new',text:'Keep my answer'}]};
      const original = structuredClone(local);
      const result = merge(data(local,collection),data(remote,collection));
      const entity = result.entities[collection].lead;
      for (const field of fields) assert.deepEqual(entity[field],remote[field]);
      assert.equal(entity.title,'Edited locally');
      assert.equal(entity.comments[0].text,'Keep my answer');
      assert.deepEqual(result._v3LocalDivergence[0].snapshot,original);
      assert.deepEqual(local,original);
      assert.equal(result._v3ProtectedGap,undefined);
    }
  });
}
test('a forged higher local revision cannot resurrect fields absent on the server', () => {
  const local={...canonical(),operationalStateVersion:999999,operationalStateUnmapped:'unknown'};
  const result=merge(data(local),data(canonical()));
  assert.equal(result.entities.chatgptLeads.lead.operationalStateVersion,1);
  assert.equal(Object.hasOwn(result.entities.chatgptLeads.lead,'operationalStateUnmapped'),false);
});
test('ambiguous migration stays explicit and repeat merge is stable', () => {
  const remote={...canonical(),operationalState:null,operationalStateUnmapped:'ambiguous'};
  const result=merge(data({...canonical(),operationalState:'done'}),data(remote));
  assert.equal(result.entities.chatgptLeads.lead.operationalState,null);
  const clean=merge(data(result.entities.chatgptLeads.lead),data(remote));
  assert.equal(clean._v3LocalDivergence,undefined);
  assert.equal(clean._v3ProtectedGap,undefined);
});
test('missing or damaged server tuples block instead of accepting local authority', () => {
  for(const remote of [null,{id:'lead'}, {...canonical(),operationalStateSource:null}, {...canonical(),operationalStateVersion:0}, {...canonical(),operationalState:'invented'}]) {
    const result=merge(data(canonical()),data(remote));
    assert.deepEqual(result._v3ProtectedGap,['entities']);
  }
});
test('a stale client deletion cannot remove canonical work', () => {
  const result=merge(data(null),data(canonical()),{lead:Date.parse('2026-10-05')});
  assert.deepEqual(result._v3ProtectedGap,['entities']);
  assert.equal(result.entities.chatgptLeads.lead.operationalState,'doing');
});
test('unmigrated legacy items and unrelated collections retain existing behavior', () => {
  const local={id:'lead',updatedAt:'2026-10-03',operationalState:'decision_required'};
  const remote={id:'lead',updatedAt:'2026-10-01'};
  assert.deepEqual(merge(data(local),data(remote)).entities.chatgptLeads.lead,local);
  assert.equal(merge(data(canonical(),'custom'),data(null,'custom'))._v3ProtectedGap,undefined);
});
test('entity divergence is retained before writes; failed retention and gaps block', async () => {
  const guardStart=html.indexOf('async function guardV3ProtectedWrite(');
  const guardSrc=html.slice(guardStart,html.indexOf('\n}\n',guardStart)+3);
  const build=new Function('retainV3ProtectedGapLocally','retainV3LocalDivergenceSecurely', fn('detectV3ProtectedGap')+'\n'+fn('detectV3LocalDivergence')+'\n'+guardSrc+'\nreturn guardV3ProtectedWrite;');
  const make=()=>merge(data({...canonical(),operationalStateVersion:999}),data(canonical()));
  let retained;
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const guard=build(async()=>true,async items=>{retained=items;return waiting;});
  let finished=false;
  const pending=guard(make()).then(result=>{finished=true;return result;});
  await Promise.resolve();
  assert.equal(finished,false);
  assert.equal(retained[0].snapshot.operationalStateVersion,999);
  release(true);
  assert.equal(await pending,null);
  const denied=await build(async()=>true,async()=>false)(make());
  assert.equal(denied.reason,'v3_divergence_retention_failed');
  let gapSnapshot;
  const gap=await build(async merged=>{gapSnapshot=merged.entities;return true;},async()=>true)(merge(data(canonical()),data(null)));
  assert.equal(gap.reason,'v3_protected_gap');
  assert.equal(gapSnapshot.chatgptLeads.lead.operationalStateVersion,1);
});
