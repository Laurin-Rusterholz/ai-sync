import { createHash } from 'node:crypto';
import { canonicalJson, pruefeId, effektiverZustand, ABGESCHLOSSENE_ZUSTAENDE, STATE_MODEL_VERSION, rollenAbleiten } from './assistant-schema.mjs';
import { klon, requireCore } from './assistant-migration.mjs';
import { bump } from './assistant-buchhaltung.mjs';
import { istLokalDatum, isoAus } from './assistant-zeit.mjs';

const fail = (error, detail = null) => ({ ok: false, error, detail });
const intakeFingerprint = entry => createHash('sha256').update(canonicalJson([
  entry.id, entry.text, entry.channel, entry.receivedAt, entry.registeredAt, entry.registeredBy, entry.origin ?? null,
])).digest('hex');
// Source identity, independent of caller, run, retry and idempotency key.
export const acceptedIntakeLeadId = (tenant, intakeId) => 'intake_lead_' + createHash('sha256').update(canonicalJson([tenant, intakeId])).digest('hex');

export function acceptIntake(input, { intakeId, date, leadId }, ctx) {
  const data = klon(requireCore(input));
  pruefeId(intakeId, 'intakeId');
  if (leadId !== undefined) pruefeId(leadId, 'leadId');
  const entry = data.automation.intakeById[intakeId];
  if (!entry) return fail('SOURCE_NOT_FOUND', intakeId);
  if (!['open', 'done'].includes(entry.status)) return fail('INTAKE_ACCEPT_CONFLICT', entry.status);
  if (typeof entry.text !== 'string' || !entry.text.trim()) return fail('INTAKE_TEXT_MISSING');
  const run = istLokalDatum(date) && data.dailyBriefing.assistantRuns[date];
  if (!run) return fail('RUN_MISSING', date);
  if (run.phase === 'final') return fail('RUN_FINAL');
  const previous = entry.acceptance;
  if (previous && (previous.schemaVersion !== 1 || typeof previous.leadId !== 'string'
    || previous.sourceFingerprint !== intakeFingerprint(entry)
    || entry.linkedTo?.sourceType !== 'chatgptLead' || entry.linkedTo.sourceId !== previous.leadId))
    return fail('INTAKE_ACCEPT_CONFLICT', 'acceptance_record_inconsistent');
  if (entry.linkedTo && entry.linkedTo.sourceType !== 'chatgptLead') return fail('INTAKE_ACCEPT_CONFLICT', 'already_linked_elsewhere');
  const linked = previous?.leadId || entry.linkedTo?.sourceId;
  if (linked && leadId && linked !== leadId) return fail('INTAKE_ACCEPT_CONFLICT', 'different_lead');
  const targetId = linked || leadId || acceptedIntakeLeadId(ctx.policy.tenant, intakeId);
  pruefeId(targetId, 'targetLeadId');
  if (Object.hasOwn(data._deleteLog?.chatgptLeads || {}, targetId) || Object.hasOwn(data._deleteLog?.chatgptLead || {}, targetId))
    return fail('INTAKE_ACCEPT_CONFLICT', 'lead_deleted');
  let lead = data.entities.chatgptLeads[targetId];
  if (previous) {
    if (!lead || entry.status !== 'done' || !Array.isArray(lead.intakeRefs) || !lead.intakeRefs.includes(intakeId))
      return fail('INTAKE_ACCEPT_CONFLICT', 'accepted_lead_missing_or_changed');
    return { ok: true, data, leadId: targetId, created: false };
  }
  if ((linked || leadId) && !lead) return fail('LINK_TARGET_NOT_FOUND', targetId);
  if (!linked && !leadId && lead) return fail('INTAKE_ACCEPT_CONFLICT', 'derived_id_taken');
  const now = isoAus(ctx.now), created = !lead;
  if (lead) {
    const state = effektiverZustand('chatgptLead', lead);
    if (state.unmigrated || state.unmapped || state.versionInvalid) return fail('NOT_MIGRATED', targetId);
    if (ABGESCHLOSSENE_ZUSTAENDE.includes(state.state)) return fail('SOURCE_CLOSED', targetId);
    if (lead.intakeRefs !== undefined && (!Array.isArray(lead.intakeRefs) || lead.intakeRefs.some(x => typeof x !== 'string')))
      return fail('INTAKE_ACCEPT_CONFLICT', 'invalid_lead_intake_refs');
    lead.intakeRefs = [...new Set([...(lead.intakeRefs || []), intakeId])];
    lead.operationalStateVersion = state.version + 1;
    lead.updatedAt = now;
  } else {
    lead = { id: targetId, title: entry.text.split('\n')[0].trim().slice(0, 200), rawInput: entry.text,
      status: 'neu', assignee: 'chatgpt', createdAt: now, updatedAt: now, createdBy: ctx.actor.id,
      sourceIntakeId: intakeId, intakeRefs: [intakeId], comments: [],
      operationalState: 'doing', operationalStateVersion: 1,
      operationalStateSource: { model: STATE_MODEL_VERSION, legacyField: 'status', legacyValue: 'neu', mappedAt: now, note: 'acceptIntake' } };
    lead.operationalRoles = rollenAbleiten('chatgptLead', lead);
    data.entities.chatgptLeads[targetId] = lead;
  }
  entry.linkedTo = { sourceType: 'chatgptLead', sourceId: targetId };
  entry.status = 'done'; entry.handledAt = now; entry.handledBy = ctx.actor.id;
  entry.acceptance = { schemaVersion: 1, leadId: targetId, acceptedAt: now, acceptedBy: ctx.actor.id,
    sourceFingerprint: intakeFingerprint(entry), created };
  for (const ref of [{ sourceType: 'intake', sourceId: intakeId }, { sourceType: 'chatgptLead', sourceId: targetId }])
    if (!run.itemRefs.some(r => r.sourceType === ref.sourceType && r.sourceId === ref.sourceId)) run.itemRefs.push({ ...ref, includedAt: now });
  run.revision++; run.updatedAt = now;
  bump(data, ctx.now);
  return { ok: true, data, leadId: targetId, created };
}
