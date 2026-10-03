import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let localDataRestorePromise = Promise.resolve();'),html.indexOf('// Gedrosselte Nutzer-Warnung'));
const statusSource=html.slice(html.indexOf('function v3SpeicherStatusText()'),html.indexOf('// Zwingende Handlungen:'));
const state=(stamp,notes)=>({entities:{tasks:{}},meta:{updatedAt:stamp},dailyBriefing:{dailyLog:{today:{notes}}}});
const stale=state('2026-10-02T21:04:49Z','old');
const current=state('2026-10-03T02:05:48Z','review');
function fixture(restore) {
  const APP={state:{data:null,storage:{status:'saved'}}};let renders=0;
  const api=new Function('APP','localStorage','STORAGE_KEY','normalizeData','emptyData','idbRestore','getSyncStats','applyEmbeddedSettings','render','console',
    source+statusSource+';return {loadInitialLocalData,loadLocalData,v3SpeicherStatusText};')(
    APP,{getItem:()=>JSON.stringify(stale)},'mgmt-v4-data',x=>structuredClone(x),()=>({entities:{}}),restore,
    ()=>({totalEntities:1}),()=>{},()=>{renders++;},{log(){},error(){}});
  return {APP,api,renders:()=>renders};
}
test('startup waits for current durable copy before returning a renderable initial state',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const f=fixture(label=>label==='before_close'?held:Promise.resolve(null));
  let completed=false;const starting=f.api.loadInitialLocalData().then(x=>{completed=true;return x;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,false);assert.equal(f.renders(),0);
  assert.equal(f.api.v3SpeicherStatusText(),'Lokale Sicherung wird geladen…');
  release(current);const loaded=await starting;
  assert.deepEqual(loaded,current);assert.equal(f.renders(),0);
  assert.equal(f.APP.state.storage.localHydration,'ready');
  assert.match(f.api.v3SpeicherStatusText(),/Serverbestätigung unbekannt/);
  const init=html.slice(html.indexOf('async function init() {'));
  assert.ok(init.indexOf('await loadInitialLocalData();')<init.indexOf('// Initial render'));
  assert.ok(init.includes('await loadInitialLocalData();'));
});
test('unavailable or older recovery copies leave the valid local data intact',async()=>{
  for(const older of [null,state('2026-09-06T13:26:26Z','older')]){
    const f=fixture(async()=>older);
    assert.deepEqual(await f.api.loadInitialLocalData(),stale);
    assert.equal(f.APP.state.storage.localHydration,'ready');
  }
});
test('a late previous recovery cannot replace a newer load or clear its loading indicator',async()=>{
  let releaseOld,releaseNew,call=0;
  const oldPromise=new Promise(resolve=>{releaseOld=resolve;});
  const newPromise=new Promise(resolve=>{releaseNew=resolve;});
  const f=fixture(label=>label==='localStorage_overflow'?(++call===1?oldPromise:newPromise):Promise.resolve(null));
  const first=f.api.loadInitialLocalData();
  f.APP.state.data=f.api.loadLocalData();
  releaseOld(state('2026-10-04T00:00:00Z','superseded recovery'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.APP.state.storage.localHydration,'loading');
  assert.deepEqual(f.APP.state.data,stale);
  releaseNew(current);await first;
  assert.deepEqual(f.APP.state.data,current);assert.equal(f.APP.state.storage.localHydration,'ready');
});
test('in-memory changes newer than a recovery copy survive hydration',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const f=fixture(label=>label==='before_close'?held:Promise.resolve(null));
  const starting=f.api.loadInitialLocalData();
  const edited=state('2026-10-03T04:00:00Z','new change');f.APP.state.data=edited;
  release(current);await starting;assert.deepEqual(f.APP.state.data,edited);
});
