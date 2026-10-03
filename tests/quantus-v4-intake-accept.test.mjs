import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateCore, applyCommand, POLICY_TEMPLATE, effektiverZustand } from '../netlify/lib/assistant-core.mjs';
import { acceptedIntakeLeadId } from '../netlify/lib/assistant-intake-accept.mjs';
const now = Date.parse('2026-10-03T09:00:00Z'), date = '2026-10-03';
const policy = { ...POLICY_TEMPLATE, tenant: 'quantus', requiredSources: [{ id: 'core', kind: 'quantus-core' }], noExternalSources: true }, actor = { kind: 'user', id: 'owner' };
function apply(data, type, payload, who = actor) { return applyCommand(data, { type, payload, commandId: 'test-' + type, now }, { policy, actor: who }); }
function fixture() {
  let data = migrateCore({ entities: { chatgptLeads: { existing: { id: 'existing', title: 'Keep', status: 'in_arbeit', custom: { keep: true } } } }, _deleteLog: {} }, { now }).data;
  data = apply(data, 'ensureRun', { date }, { kind: 'system', id: 'test' }).data;
  const r = apply(data, 'registerIntake', { intakeId: 'incoming', text: 'Bitte prüfen\nVollständiger Originaltext 🧩', channel: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r)); return r.data;
}
const accept = (data, extra = {}, who) => apply(data, 'acceptIntake', { intakeId: 'incoming', date, ...extra }, who);
test('accept creates exactly one canonical open lead with full input and both run references in one revision', () => {
  const data = fixture(), before = structuredClone(data), r = accept(data);
  assert.equal(r.ok, true, r.error); assert.equal(r.created, true);
  assert.equal(r.leadId, acceptedIntakeLeadId('quantus', 'incoming'));
  assert.deepEqual(data, before);
  const lead = r.data.entities.chatgptLeads[r.leadId], intake = r.data.automation.intakeById.incoming;
  assert.equal(lead.rawInput, data.automation.intakeById.incoming.text);
  assert.equal(lead.title, 'Bitte prüfen'); assert.equal(lead.createdBy, 'owner');
  assert.equal(effektiverZustand('chatgptLead', lead).state, 'doing'); assert.equal(lead.operationalStateVersion, 1);
  assert.deepEqual(lead.operationalRoles, { accountable: 'chatgpt', executor: 'openai' });
  assert.equal(intake.linkedTo.sourceId, lead.id); assert.equal(intake.status, 'done');
  assert.equal(r.data.automation.dataRevision, data.automation.dataRevision + 1);
  assert.equal(r.data.dailyBriefing.assistantRuns[date].itemRefs.length, 2);
  assert.deepEqual(r.data.automation.idempotencyByKey, data.automation.idempotencyByKey);
  const repeated = accept(r.data);
  assert.equal(repeated.ok, true); assert.equal(repeated.noop, true); assert.deepEqual(repeated.data, r.data);
});
test('link existing lead preserves contents and increments its version; different target cannot replace acceptance', () => {
  const data = fixture(), version = data.entities.chatgptLeads.existing.operationalStateVersion;
  const r = accept(data, { leadId: 'existing' }); assert.equal(r.ok, true); assert.equal(r.created, false);
  assert.equal(Object.keys(r.data.entities.chatgptLeads).length, 1);
  assert.deepEqual(r.data.entities.chatgptLeads.existing.custom, { keep: true });
  assert.equal(r.data.entities.chatgptLeads.existing.operationalStateVersion, version + 1);
  assert.equal(accept(r.data).noop, true);
  assert.equal(accept(r.data, { leadId: 'elsewhere' }).error, 'INTAKE_ACCEPT_CONFLICT');
});
test('historically handled intake without lead is repaired, cancelled intake remains cancelled', () => {
  const old = fixture(); old.automation.intakeById.incoming.status = 'done'; old.automation.intakeById.incoming.reason = 'intake.accept';
  assert.equal(accept(old).created, true);
  old.automation.intakeById.incoming.status = 'cancelled';
  assert.equal(accept(old).error, 'INTAKE_ACCEPT_CONFLICT');
});
test('missing, closed, unmapped, colliding and tombstoned targets do not create or overwrite anything', () => {
  const missing = fixture(); assert.equal(accept(missing, { leadId: 'absent' }).error, 'LINK_TARGET_NOT_FOUND');
  for (const state of ['done', 'cancelled']) {
    const data = fixture(); data.entities.chatgptLeads.existing.operationalState = state;
    assert.equal(accept(data, { leadId: 'existing' }).error, 'SOURCE_CLOSED');
  }
  for (const damage of [data => { data._deleteLog.chatgptLeads = { [acceptedIntakeLeadId('quantus', 'incoming')]: now }; },
    data => { const id = acceptedIntakeLeadId('quantus', 'incoming'); data.entities.chatgptLeads[id] = { ...data.entities.chatgptLeads.existing, id }; }]) {
    const data = fixture(); damage(data); const before = structuredClone(data);
    const r = accept(data); assert.equal(r.error, 'INTAKE_ACCEPT_CONFLICT'); assert.deepEqual(r.data, before);
  }
  const accepted = accept(fixture()); delete accepted.data.entities.chatgptLeads[accepted.leadId];
  assert.equal(accept(accepted.data).error, 'INTAKE_ACCEPT_CONFLICT', 'accepted deleted lead is not resurrected');
});
test('closed daily run and unauthorized actors fail; no fabricated intake or question confirmation', () => {
  const data = fixture();
  for (const kind of ['system', 'adapter', 'worker', 'agent']) assert.equal(accept(data, {}, { kind, id: 'no' }).error, 'ACTOR_REJECTED');
  const closed = structuredClone(data); closed.dailyBriefing.assistantRuns[date].phase = 'final';
  assert.equal(accept(closed).error, 'RUN_FINAL');
  const accepted = accept(data);
  assert.deepEqual(accepted.data.automation.answersById, data.automation.answersById);
  assert.deepEqual(accepted.data.automation.questionsById, data.automation.questionsById);
});

test('acceptance is bound to original source; later legacy text or link edits cannot silently confirm different work', () => {
  for (const edit of [d => { d.automation.intakeById.incoming.text = 'Different'; },
    d => { d.automation.intakeById.incoming.channel = 'forged'; },
    d => { d.automation.intakeById.incoming.linkedTo.sourceId = 'existing'; }]) {
    const r = accept(fixture()); edit(r.data); const before = structuredClone(r.data);
    const rejected = accept(r.data); assert.equal(rejected.error, 'INTAKE_ACCEPT_CONFLICT'); assert.deepEqual(rejected.data, before);
  }
});
