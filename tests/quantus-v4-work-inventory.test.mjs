import test from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../netlify/lib/assistant-core.mjs';
import { createQuantusV3DomainAdapter } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import { projectPage } from '../netlify/lib/quantus-v3-read-helpers.mjs';

const DATE = '2026-10-02', NOW = Date.parse('2026-10-02T07:01:00Z'), RUN = 'run_' + DATE;
const POLICY = { ...K.POLICY_TEMPLATE, requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true };
const SYSTEM = { kind: 'system', id: 'scheduler' };
let seq = 0;
function command(data, type, payload, actor = SYSTEM) {
  return K.applyCommand(data, { type, payload, now: NOW, commandId: 'inventory-' + ++seq }, { policy: POLICY, actor });
}
function base() {
  const data = K.migrateCore({ entities: {
    chatgptLeads: {
      lead1: { id: 'lead1', title: 'Open', rawInput: 'Original request', status: 'neu', comments: [] },
      closed: { id: 'closed', title: 'Closed', status: 'abgeschlossen', closedBy: 'laurin', obsolete: true, comments: [] },
    },
    chatgptTasks: { chat1: { id: 'chat1', text: 'Assistant task', state: 'offen' } },
    tasks: { later: { id: 'later', title: 'Future user task', status: 'todo', dueDate: '2026-12-01' } },
    projects: { project1: { id: 'project1', title: 'Project', status: 'active', deadlines: [{ id: 'deadline1', title: 'Due', date: DATE, done: false, private: 'not projected' }] } },
    chatgptNotes: { note1: { id: 'note1', title: 'Instructions', instruction: 'Existing note instructions' }, archived: { id: 'archived', archived: true, instruction: 'old' } },
    notes: { noteflow: { id: 'noteflow', content: 'untouched' } }, habits: { water: { id: 'water', count: 7 } },
  }, dailyBriefing: { routines: [{ id: 'routine' }], dailyLog: {} } }, { now: NOW - 1000 }).data;
  Object.assign(data.automation, {
    intakeById: { intake1: { id: 'intake1', status: 'open', text: 'Incoming', channel: 'manual' } },
    questionsById: { question1: { id: 'question1', status: 'answered', sourceType: 'chatgptLead', sourceId: 'lead1', text: 'Which?', options: ['A', 'B'], answerId: 'answer1' } },
    answersById: { answer1: { id: 'answer1', questionId: 'question1', text: 'A', answeredAt: new Date(NOW).toISOString(), consumedAt: null } },
    documentsById: { document1: { id: 'document1', status: 'open', name: 'Document', parse: { outcome: 'unreadable', private: 'not projected' } } },
    jobsById: { job1: { id: 'job1', state: 'failed', sourceType: 'chatgptLead', sourceId: 'lead1', purpose: 'Research' } },
    evidenceById: { evidence1: { id: 'evidence1', sourceType: 'chatgptLead', sourceId: 'lead1', kind: 'message', ref: 'mail_1', fingerprint: '0123456789abcdef' } },
  });
  return data;
}
const keys = refs => refs.map(r => r.sourceType + ':' + r.sourceId);
const open = data => command(data, 'ensureRunSlot', { date: DATE, slot: 'process09', receiptId: 'receipt-9' });

test('slot creation atomically discovers originals across every supported source type without changing their state', () => {
  const before = base(); const out = open(before);
  assert.equal(out.ok, true); assert.equal(out.data.automation.dataRevision, before.automation.dataRevision + 1);
  assert.deepEqual(out.data.entities, before.entities);
  for (const name of ['questionsById', 'answersById', 'documentsById', 'jobsById', 'intakeById']) assert.deepEqual(out.data.automation[name], before.automation[name]);
  assert.deepEqual(out.data.dailyBriefing.routines, before.dailyBriefing.routines);
  assert.deepEqual(keys(out.data.dailyBriefing.assistantRuns[DATE].itemRefs), [
    'answer:answer1', 'chatgptLead:lead1', 'chatgptNote:note1', 'chatgptTask:chat1', 'document:document1',
    'evidence:evidence1', 'intake:intake1', 'job:job1', 'project:project1', 'question:question1', 'task:later',
  ]);
  assert.equal(out.inventoryAdded, 11);
  const repeat = open(out.data); assert.equal(repeat.noop, true);
  assert.deepEqual(repeat.data, out.data);
});

test('a later synchronization adds new originals once and retains historical references', () => {
  let data = open(base()).data;
  data.entities.chatgptTasks.late = { id: 'late', text: 'Arrived later', state: 'offen' };
  data = K.migrateCore(data, { now: NOW }).data;
  delete data.entities.chatgptNotes.note1;
  const revision = data.automation.dataRevision;
  const next = command(data, 'syncRunInventory', { date: DATE });
  assert.equal(next.ok, true); assert.equal(next.added, 1);
  assert.equal(next.data.automation.dataRevision, revision + 1);
  assert.ok(keys(next.data.dailyBriefing.assistantRuns[DATE].itemRefs).includes('chatgptNote:note1'));
  const repeat = command(next.data, 'syncRunInventory', { date: DATE });
  assert.equal(repeat.noop, true); assert.equal(repeat.added, 0);
});

test('the discovery command is backend-owned; models cannot supply a curated work list', () => {
  const data = open(base()).data;
  for (const kind of ['agent', 'user', 'worker', 'adapter']) {
    const result = command(data, 'syncRunInventory', { date: DATE }, { kind, id: 'caller' });
    assert.equal(result.ok, false); assert.equal(result.error, 'ACTOR_REJECTED');
    assert.deepEqual(result.data, data);
  }
  assert.equal(command(data, 'syncRunInventory', { date: DATE, itemRefs: [] }).ok, false);
});

test('unknown states and unsupported completion claims stay in the inventory; corrupt cards abort it', () => {
  const data = base();
  data.entities.chatgptLeads.lead1.operationalState = 'done';
  data.automation.intakeById.intake1.status = 'unrecognized';
  const refs = keys(K.collectRunInventory(data));
  assert.ok(refs.includes('chatgptLead:lead1')); assert.ok(refs.includes('intake:intake1'));
  data.automation.documentsById.broken = null;
  assert.throws(() => K.collectRunInventory(data), /Invalid inventory source/);
});

test('all inventory references produce scoped context; absent originals stay explicit and private extras stay out', () => {
  const data = open(base()).data;
  delete data.entities.chatgptNotes.note1;
  const domain = createQuantusV3DomainAdapter({ tenantId: 'quantus', policyVersion: POLICY.version, mode: 'enforce', now: () => NOW,
    ports: { policy: POLICY, ownerId: 'owner', read: () => undefined } });
  const page = domain.listPage(data, { query: 'run.context', scopeId: RUN, pageSize: 50, afterId: null, principal: { role: 'lead_agent', jobId: RUN } });
  assert.equal(page.items.length, 11);
  assert.ok(page.items.every(i => i.jobId === RUN && i.runId === RUN));
  const visible = projectPage('run.context', page.items);
  assert.equal(visible.usable, true);
  const byType = Object.fromEntries(visible.items.map(i => [i.sourceType, i]));
  assert.equal(byType.chatgptNote.sourceMissing, true);
  assert.equal(byType.chatgptNote.state, 'missing');
  assert.equal(byType.answer.text, 'A');
  assert.equal(byType.answer.state, 'unconsumed');
  assert.equal(JSON.parse(byType.project.contextDetails).deadlines[0].date, DATE);
  assert.equal(JSON.parse(byType.document.contextDetails).parse.outcome, 'unreadable');
  assert.equal(byType.task.dueAt, '2026-12-01');
  assert.ok(!JSON.stringify(visible).includes('not projected'));
  assert.ok(!JSON.stringify(visible).includes('noteflow'));
});

test('proof reference lists are complete or unusable, never silently limited to fifty', () => {
  const item = { id: 'context', evidenceRefs: Array.from({ length: 75 }, (_, i) => 'proof-' + i) };
  assert.equal(projectPage('run.context', [item]).items[0].evidenceRefs.length, 75);
  item.evidenceRefs = Array.from({ length: 1001 }, (_, i) => 'proof-' + i);
  assert.equal(projectPage('run.context', [item]).usable, false);
});
