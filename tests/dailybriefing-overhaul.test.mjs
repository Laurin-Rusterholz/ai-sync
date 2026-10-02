import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const helpers = html.slice(html.indexOf('function dbWeekBounds('), html.indexOf('function renderV3ChatgptCockpit('));
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(data = {}) {
  const APP = {state:{data:{entities:{projects:{p:{id:'p',title:'Project'}},chatgptLeads:{},scheduledMessages:{}, ...data}}}};
  const fields = Object.fromEntries(['dbLeadTitle','dbLeadText','dbLeadSource','dbLeadProject','dbLeadNext','dbQuickLeadResult','dbWeekReviewText'].map(id=>[id,{value:'',innerHTML:''}]));
  const window = {_dbDate:'2026-10-02'};
  let saved=0;
  window.createChatgptLead = (title,text) => { const id='l'+Object.keys(APP.state.data.entities.chatgptLeads).length; APP.state.data.entities.chatgptLeads[id]={id,title,rawInput:text};return id; };
  const api = new Function('APP','window','document','esc','fmtDateTime','nowIso','todayYmd','scheduleSave','render','toast','v3LeadOperationalState','v3LeadWhoseTurn',helpers+';return {dbWeekBounds,dbSafeSourceUrl,renderBriefingLinks,renderBriefingFocus,renderBriefingProjectContext,renderBriefingWeekReview};')(APP,window,{getElementById:id=>fields[id]},escape,x=>x,()=> '2026-10-02T12:00:00Z',()=> '2026-10-02',()=>saved++,()=>{},()=>{},x=>x.operationalState||'doing',()=> 'ChatGPT');
  return {api,APP,window,fields,saved:()=>saved};
}
test('Week belongs to Monday even over year and DST boundaries',()=>{
  const {api}=fixture();
  assert.deepEqual(api.dbWeekBounds('2027-01-01'),{start:'2026-12-28',end:'2027-01-03'});
  assert.deepEqual(api.dbWeekBounds('2026-10-25'),{start:'2026-10-19',end:'2026-10-25'});
});
test('Capture validates before creating and writes links on the original lead only',()=>{
  const f=fixture(); f.fields.dbLeadText.value='Please investigate';f.fields.dbLeadSource.value='javascript:alert(1)';
  f.window.dbCreateQuickLead();assert.equal(Object.keys(f.APP.state.data.entities.chatgptLeads).length,0);
  f.fields.dbLeadSource.value='https://example.com/source';f.fields.dbLeadProject.value='p';f.fields.dbLeadNext.value='Read original';f.window.dbCreateQuickLead();
  const l=f.APP.state.data.entities.chatgptLeads.l0;assert.deepEqual(l.linkedProjects,['p']);assert.equal(l.nextAction,'Read original');assert.equal(l.externalLinks[0].url,'https://example.com/source');assert.equal(l.assignee,'chatgpt');assert.match(f.fields.dbQuickLeadResult.innerHTML,/data-id="l0"/);
  assert.equal(f.APP.state.data.dailyBriefing,undefined);
});
test('Weekly report survives editing with original links and same identity',()=>{
  const f=fixture();f.fields.dbWeekReviewText.value='Results with gaps';f.window.dbSaveWeekReview();
  const id='weekly_review_2026-09-28';const original=f.APP.state.data.entities.scheduledMessages[id];assert.ok(original);original.linkedProjects=['p'];
  f.fields.dbWeekReviewText.value='Reviewed results';f.window.dbSaveWeekReview();const updated=f.APP.state.data.entities.scheduledMessages[id];assert.equal(Object.keys(f.APP.state.data.entities.scheduledMessages).length,1);assert.deepEqual(updated.linkedProjects,['p']);assert.equal(updated.content,'Reviewed results');
  assert.equal(f.APP.state.data.automation,undefined);assert.equal(f.APP.state.data.dailyBriefing,undefined);
});
test('Cross-project context never includes unrelated work; unsafe content stays text',()=>{
  const f=fixture({tasks:{a:{id:'a',title:'X',projectId:'p',status:'todo'}},chatgptLeads:{a:{id:'a',title:'<img src=x>',linkedProjects:['p'],nextAction:'Read'},b:{id:'b',title:'Foreign confidential',linkedProjects:['other']}}});
  const output=f.api.renderBriefingProjectContext([{id:'p',title:'Project'}]);assert.match(output,/1 offene Aufgaben/);assert.match(output,/&lt;img src=x&gt;/);assert.doesNotMatch(output,/Foreign confidential/);
  const links=f.api.renderBriefingLinks({externalLinks:[{url:'javascript:alert(1)'},{url:'https://example.com',label:'<script>'}]});assert.doesNotMatch(links,/javascript:/);assert.match(links,/&lt;script&gt;/);
});
test('Missing summary and source cannot look like a successful check',()=>{
  const f=fixture();const output=f.api.renderBriefingFocus('2026-10-02','',[]);assert.match(output,/fehlt noch eine Zusammenfassung/);assert.doesNotMatch(output,/erledigt|vollständig geprüft/);assert.match(f.api.renderBriefingLinks({}),/Noch keine Quelle/);
});
