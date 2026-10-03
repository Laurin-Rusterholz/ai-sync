import { createHash } from 'node:crypto';
import { canonicalJson, effektiverZustand, ABGESCHLOSSENE_ZUSTAENDE } from './assistant-schema.mjs';
import { requireCore, klon } from './assistant-migration.mjs';
import { istLokalDatum, isoAus } from './assistant-zeit.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = x => createHash('sha256').update(canonicalJson(x)).digest('hex');
const fail = (error, detail = null) => ({ ok: false, error, detail });
export const legacyQuestionFingerprint = (leadId, question) => hash([leadId, question]);
function matchesCandidate(question, candidate) {
  return question.id === candidate.questionId && ['open', 'answered', 'withdrawn'].includes(question.status)
    && istLokalDatum(question.runDate) && typeof question.askedAt === 'string' && Number.isFinite(Date.parse(question.askedAt))
    && question.sourceType === 'chatgptLead' && question.sourceId === candidate.leadId
    && question.legacySource?.leadId === candidate.leadId && question.legacySource?.fingerprint === candidate.fingerprint
    && question.text === candidate.text && canonicalJson(question.options) === canonicalJson(candidate.options)
    && question.recommendation === candidate.recommendation && question.legacyAnswerDraft === candidate.answerDraft
    && canonicalJson(question.legacyAnsweredAt) === canonicalJson(candidate.previousAnsweredAt);
}
function migrationState(leadId, lead, questions, related = Object.values(questions).filter(q => q?.legacySource?.leadId === leadId)) {
  const state = lead ? effektiverZustand('chatgptLead', lead) : null;
  return hash([lead?.status ?? null, state?.state ?? null, state?.version ?? null,
    related.slice().sort((a, b) => a.id.localeCompare(b.id))]);
}

export function inspectLegacyQuestion(leadId, lead) {
  const original = lead?.pendingQuestion;
  if (original == null) return { absent: true };
  const state = effektiverZustand('chatgptLead', lead);
  // Historical answers on closed leads are history, never new instructions.
  if (lead.status === 'abgeschlossen' || ABGESCHLOSSENE_ZUSTAENDE.includes(state.state)) return { closed: true };
  const fingerprint = legacyQuestionFingerprint(leadId, original);
  const problem = reason => ({ leadId, fingerprint, reason });
  if (state.unmigrated || state.unmapped || state.versionInvalid) return problem('legacy_lead_state_unresolved');
  if (!record(original) || typeof original.text !== 'string' || !original.text.trim() || original.text.length > 2000)
    return problem('legacy_question_text_invalid');
  const options = original.options ?? [];
  if (!Array.isArray(options) || options.length > 8 || options.some(x => typeof x !== 'string' || !x.trim() || x.length > 200))
    return problem('legacy_question_options_invalid');
  if (original.answer != null && (typeof original.answer !== 'string' || original.answer.length > 8000))
    return problem('legacy_question_answer_invalid');
  if (original.recommendation != null && (typeof original.recommendation !== 'string' || original.recommendation.length > 2000))
    return problem('legacy_question_recommendation_invalid');
  return { leadId, fingerprint, questionId: 'legacyq_' + fingerprint, text: original.text,
    options: options.slice(), recommendation: original.recommendation ?? null,
    answerDraft: original.answer ?? null, previousAnsweredAt: original.answeredAt ?? null };
}

// Planning never writes or infers a question from matching text. The complete
// original pendingQuestion participates in its immutable source identity.
export function planLegacyQuestions(input) {
  const data = requireCore(input), items = [], unresolved = [];
  const leads = data.entities.chatgptLeads, questions = data.automation.questionsById;
  const byLead = new Map();
  for (const [qid, q] of Object.entries(questions)) if (q?.legacySource) {
    if (!record(q.legacySource) || typeof q.legacySource.leadId !== 'string' || !q.legacySource.leadId
      || !/^[a-f0-9]{64}$/.test(q.legacySource.fingerprint) || q.id !== qid || qid !== 'legacyq_' + q.legacySource.fingerprint) {
      unresolved.push({ leadId: null, reason: 'legacy_question_link_invalid' }); continue;
    }
    const id = q.legacySource.leadId;
    if (!byLead.has(id)) byLead.set(id, []);
    byLead.get(id).push(q);
  }
  const ids = new Set([...Object.keys(leads), ...byLead.keys()]);
  for (const leadId of [...ids].sort()) {
    const lead = leads[leadId];
    const candidate = inspectLegacyQuestion(leadId, lead);
    const related = byLead.get(leadId) || [], old = related.filter(q => q.status === 'open');
    if (candidate.reason) { unresolved.push({ leadId, reason: candidate.reason }); continue; }
    const existing = candidate.questionId && questions[candidate.questionId];
    if (existing && !matchesCandidate(existing, candidate)) {
      unresolved.push({ leadId, reason: 'legacy_question_identity_conflict' }); continue;
    }
    if ((!candidate.absent && !candidate.closed && !existing)
      || old.some(q => q.id !== candidate.questionId || candidate.absent || candidate.closed)) {
      items.push({ leadId, fingerprint: legacyQuestionFingerprint(leadId, lead?.pendingQuestion ?? null),
        expectedState: migrationState(leadId, lead, questions, related) });
    }
  }
  return { items, unresolved };
}

export function migrateLegacyQuestions(input, { date, items }, ctx) {
  const data = klon(requireCore(input));
  if (!istLokalDatum(date) || !data.dailyBriefing.assistantRuns[date]
    || data.dailyBriefing.assistantRuns[date].phase === 'final') return fail('LEGACY_QUESTION_RUN_INVALID');
  if (!Array.isArray(items) || !items.length || items.length > 32
    || new Set(items.map(x => x?.leadId)).size !== items.length) return fail('LEGACY_QUESTION_BATCH_INVALID');
  const changed = [];
  for (const item of items) {
    const lead = data.entities.chatgptLeads[item?.leadId];
    if (typeof item?.leadId !== 'string' || legacyQuestionFingerprint(item.leadId, lead?.pendingQuestion ?? null) !== item.fingerprint)
      return fail('LEGACY_QUESTION_SOURCE_CHANGED');
    if (item.expectedState !== migrationState(item.leadId, lead, data.automation.questionsById))
      return fail('LEGACY_QUESTION_SOURCE_CHANGED');
    const candidate = inspectLegacyQuestion(item.leadId, lead);
    if (candidate.reason) return fail('LEGACY_QUESTION_UNRESOLVED', candidate.reason);
    for (const q of Object.values(data.automation.questionsById)) {
      if (q?.legacySource?.leadId === item.leadId && q.status === 'open'
        && (candidate.closed || candidate.absent || q.id !== candidate.questionId)) {
        q.status = 'withdrawn'; q.withdrawnAt = isoAus(ctx.now); q.withdrawalReason = 'legacy_source_changed';
        changed.push(q.id);
      }
    }
    if (candidate.absent || candidate.closed) continue;
    const existing = data.automation.questionsById[candidate.questionId];
    if (existing) {
      if (!matchesCandidate(existing, candidate)) return fail('LEGACY_QUESTION_IDENTITY_CONFLICT');
      continue;
    }
    const q = { id: candidate.questionId, sourceType: 'chatgptLead', sourceId: item.leadId,
      text: candidate.text, options: candidate.options, recommendation: candidate.recommendation,
      askedAt: isoAus(ctx.now), askedBy: ctx.actor.id, status: 'open', answerId: null, runDate: date,
      legacySource: { leadId: item.leadId, fingerprint: candidate.fingerprint },
      legacyAnswerDraft: candidate.answerDraft, legacyAnsweredAt: candidate.previousAnsweredAt };
    data.automation.questionsById[q.id] = q;
    changed.push(q.id);
  }
  if (changed.length) { data.automation.dataRevision++; data.automation.updatedAt = isoAus(ctx.now); }
  return { ok: true, data, changed };
}

export function verifyLegacyQuestionSource(data, question) {
  if (!question.legacySource) return true;
  const { leadId, fingerprint } = question.legacySource;
  const lead = data.entities.chatgptLeads[leadId];
  if (!lead || question.sourceType !== 'chatgptLead' || question.sourceId !== leadId) return false;
  const candidate = inspectLegacyQuestion(leadId, lead);
  return !candidate.reason && !candidate.closed && !candidate.absent
    && candidate.fingerprint === fingerprint && candidate.questionId === question.id && matchesCandidate(question, candidate);
}
