import test from 'node:test';import assert from 'node:assert/strict';
await import('../public/quantus-briefing-device.js');
const ui=globalThis.QuantusBriefingDevice;
test('device briefing preserves source data, ignores deleted/closed leads and separates personal tasks',()=>{
 const data={entities:{chatgptLeads:{a:{id:'a',pendingQuestion:{text:'Choose',kind:'decision'}},b:{id:'b',deletedAt:'2026-10-06',pendingQuestion:{text:'Deleted'}},c:{id:'c',status:'abgeschlossen',pendingQuestion:{text:'Closed'}},d:{id:'d',operationalState:null,operationalStateSource:{},pendingQuestion:{text:'Unmapped'}}},tasks:{a:{id:'a'},b:{id:'b',assignee:'cowork'},c:{id:'c',assignee:'chatgpt'},d:{id:'d',status:'done'}}}};
 const before=JSON.stringify(data),m=ui.model(data,'2026-10-07');assert.equal(m.decisions.length,1);assert.equal(m.questions.length,1);assert.equal(m.counts.unknown,1);assert.deepEqual(m.tasks.map(t=>t.id),['a']);ui.render({data,date:'2026-10-07'});assert.equal(JSON.stringify(data),before);
});
test('source links stay with their exact project and untrusted content is escaped',()=>{
 const data={entities:{projects:{p:{id:'p',title:'Project P'},q:{id:'q',title:'Project Q'}},chatgptLeads:{a:{id:'a',title:'<img src=x onerror=alert(1)>',linkedProjects:['p'],lastAction:'P only',externalLinks:[{url:'javascript:alert(1)',label:'bad'},{url:'https://example.com',label:'source'}]}}}};
 const html=ui.render({data,date:'2026-10-07'});assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('javascript:'));assert.ok(html.includes('https://example.com/'));const q=html.slice(html.indexOf('Project Q'));assert.ok(!q.split('</article>')[0].includes('P only'));
});
test('unverified runs, overdue follow-ups and returned Cowork work never appear completed',()=>{
 assert.equal(ui.color({operationalState:'waiting_external',waitingOn:'X',waitingSince:'2026-01-01',nextAction:'Check',followUpAt:'2026-01-02'},Date.parse('2026-10-07')),'red');assert.equal(ui.color({operationalState:'delegated_cowork',expectedReturnAt:'2027-01-01',returnedAt:'2026-10-06'},Date.parse('2026-10-07')),'red');
 const html=ui.render({date:'2026-10-07'});assert.equal((html.match(/Nicht bestätigt/g)||[]).length,4);assert.ok(html.includes('Keine Quellenprüfung'));assert.equal(ui.safeUrl('https://user:password@example.com'),'');
});
