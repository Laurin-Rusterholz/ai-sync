import { openCommandQueue, createCommandTransport, canonicalIntentJson } from './quantus-v3-command-client.mjs';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(value) && !value.includes('__');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const digest = async (text, cryptoImpl) => Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');

export async function legacyAnswerIntent({ accountKey, leadId, question, answer, cryptoImpl = globalThis.crypto }) {
  if (typeof accountKey !== 'string' || !accountKey || accountKey.length > 200) fail('sign_in_required');
  if (!safeId(leadId) || !question || typeof question.text !== 'string' || !question.text.trim()
    || question.answeredAt) fail('legacy_question_not_addressable');
  if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > 8000) fail('answer_invalid');
  const original = JSON.parse(canonicalIntentJson(question));
  const fingerprint = await digest(canonicalIntentJson([leadId, original]), cryptoImpl);
  const key = await digest(JSON.stringify([accountKey, fingerprint]), cryptoImpl);
  const intent = { accountKey, operationId: 'legacy-answer-' + key,
    legacyOperation: { kind: 'legacy_question_answer', schemaVersion: 1, leadId, question: original,
      fingerprint, questionId: 'legacyq_' + fingerprint, answer: answer.trim() } };
  canonicalIntentJson(intent.legacyOperation);
  return intent;
}

// A question is immutable and accepts exactly one answer. Its operation key
// survives reloads, multiple tabs and lost responses; a different answer must
// never overwrite an already queued intention. Identity is scoped to the user.
export async function answerIntent({ accountKey, question, answer, cryptoImpl = globalThis.crypto }) {
  if (typeof accountKey !== 'string' || !accountKey || accountKey.length > 200) fail('sign_in_required');
  if (!question || !safeId(question.id) || question.status !== 'open' || !dateValid(question.runDate)) fail('question_not_addressable');
  if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > 8000) fail('answer_invalid');
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([accountKey, question.id])));
  const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { accountKey, operationId: 'briefing-answer-' + key,
    command: { schemaVersion: 3, verb: 'briefing.answer', jobId: 'run_' + question.runDate, expectedEntityVersion: 0,
      payload: { briefingId: 'run_' + question.runDate, questionId: question.id, answer: answer.trim(), answerId: 'answer_' + key } } };
}

export async function openBriefingAnswers({ accountKey, getAuth, origin, indexedDB, fetchImpl, getQuestions = () => [], now = Date.now, cryptoImpl = globalThis.crypto } = {}) {
  const queue = await openCommandQueue({ indexedDB, databaseName: 'quantus-v3-briefing-answers', now });
  let nextCheckAt = 0;
  const transport = createCommandTransport({ origin, getAuth, fetchImpl, now, writesEnabled: true });
  const checkedTransport = { async send(entry, options) {
    const result = await transport.send(entry, options);
    if (result.ok && ![entry.command.payload.questionId, entry.command.payload.answerId]
      .every(id => Object.hasOwn(result.receipt.entityVersions, id))) {
      return { ok: false, status: 0, code: 'answer_receipt_incomplete', retryable: true, uncertain: true };
    }
    return result;
  } };
  const legacyEntries = entries => entries.filter(e => e.legacyOperation?.kind === 'legacy_question_answer' && e.legacyOperation.schemaVersion === 1);
  async function list() {
    const entries = await queue.list(accountKey, { includeAcknowledged: true });
    const questions = await getQuestions();
    const commands = new Map(entries.filter(e => e.command?.verb === 'briefing.answer').map(e => [e.command.payload.questionId, e]));
    return entries.map(entry => {
      if (!entry.legacyOperation || entry.legacyOperation.kind !== 'legacy_question_answer') return entry;
      const command = commands.get(entry.legacyOperation.questionId);
      const same = command && command.command.payload.answer === entry.legacyOperation.answer;
      const question = Array.isArray(questions) && questions.find(q => q?.id === entry.legacyOperation.questionId
        && q?.legacySource?.fingerprint === entry.legacyOperation.fingerprint && q.sourceId === entry.legacyOperation.leadId);
      return { ...entry, deliveryStatus: command ? same ? command.status : 'conflict' : question && question.status !== 'open' ? 'source_changed' : 'legacy_unmapped',
        resolvedOperationId: same ? command.operationId : null };
    });
  }
  async function reconcileLegacy() {
    const questions = await getQuestions();
    if (!Array.isArray(questions)) fail('questions_unavailable');
    let unmapped = 0, mapped = 0;
    const entries = await queue.list(accountKey, { includeAcknowledged: true });
    const commands = new Map(entries.filter(e => e.command?.verb === 'briefing.answer').map(e => [e.command.payload.questionId, e]));
    for (const entry of legacyEntries(entries)) {
      const old = entry.legacyOperation;
      if (commands.has(old.questionId)) continue;
      const question = questions.find(q => q?.id === old.questionId && q?.legacySource?.leadId === old.leadId
        && q.legacySource.fingerprint === old.fingerprint && q.sourceType === 'chatgptLead' && q.sourceId === old.leadId);
      if (!question || question.status !== 'open' || !dateValid(question.runDate)) { unmapped++; continue; }
      if (mapped >= 32) { unmapped++; continue; }
      const verified = await legacyAnswerIntent({ accountKey, leadId: old.leadId, question: old.question, answer: old.answer, cryptoImpl });
      if (entry.operationId !== verified.operationId || canonicalIntentJson(old) !== canonicalIntentJson(verified.legacyOperation)) fail('stored_operation_corrupt');
      try { await queue.enqueue(await answerIntent({ accountKey, question, answer: old.answer, cryptoImpl })); }
      catch (error) { if (error?.code !== 'operation_id_conflict') throw error; }
      mapped++;
    }
    return unmapped;
  }
  return Object.freeze({
    close: () => queue.close(),
    list,
    nextCheckAt: () => nextCheckAt,
    async submitLegacy(leadId, question, answer) {
      return queue.retainLegacy(await legacyAnswerIntent({ accountKey, leadId, question, answer, cryptoImpl }));
    },
    async submit(question, answer) {
      const intent = await answerIntent({ accountKey, question, answer, cryptoImpl });
      // Only this durable commit permits the UI to say 'on this device saved'.
      return queue.enqueue(intent);
    },
    async flush() {
      nextCheckAt = now() + 30_000;
      const auth = await getAuth();
      if (!auth || auth.accountKey !== accountKey) fail('sign_in_required');
      const unmapped = await reconcileLegacy();
      await queue.resumeAfterSignIn(accountKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try { return { ...await queue.drain(accountKey, { transport: checkedTransport, limit: 8, signal: controller.signal }), unmapped }; }
      finally { clearTimeout(timeout); }
    },
  });
}

const labels = Object.freeze({
  pending: 'Auf diesem Gerät gesichert · Übertragung noch offen',
  retry_wait: 'Auf diesem Gerät gesichert · Serverbestätigung ausstehend',
  acknowledged: 'Vom Server bestätigt · ChatGPT kann die Antwort verarbeiten',
  needs_sign_in: 'Auf diesem Gerät gesichert · bitte erneut anmelden',
  conflict: 'Konflikt · gespeicherte Antwort prüfen; keine zweite Antwort versandt',
  upgrade_required: 'Auf diesem Gerät gesichert · App-Aktualisierung erforderlich',
  needs_review: 'Übertragung ungeklärt · Antwort bleibt auf diesem Gerät erhalten',
  legacy_unmapped: 'Auf diesem Gerät gesichert · die ursprüngliche Frage muss noch vom Server übernommen werden',
  source_changed: 'Frage geändert oder bereits beantwortet · die auf diesem Gerät gesicherte Antwort bitte prüfen',
});
export const answerDeliveryText = status => labels[status] || 'Übertragung ungeklärt';

// Only the complete original, including unknown fields, identifies a migrated
// question. Matching lead IDs or visible text alone would hide changed work.
export async function findMigratedQuestion(leadId, original, questions, cryptoImpl = globalThis.crypto) {
  if (!safeId(leadId) || !original || typeof original.text !== 'string') return null;
  const fingerprint = await digest(canonicalIntentJson([leadId, original]), cryptoImpl);
  return questions.find(q => q?.id === 'legacyq_' + fingerprint
    && q.sourceType === 'chatgptLead' && q.sourceId === leadId
    && q.legacySource?.leadId === leadId && q.legacySource.fingerprint === fingerprint
    && ['open', 'answered', 'withdrawn'].includes(q.status) && dateValid(q.runDate)
    && q.text === original.text && canonicalIntentJson(q.options) === canonicalIntentJson(original.options ?? [])
    && q.recommendation === (original.recommendation ?? null)
    && q.legacyAnswerDraft === (original.answer ?? null)
    && canonicalIntentJson(q.legacyAnsweredAt) === canonicalIntentJson(original.answeredAt ?? null)) || null;
}

export async function reconcileLegacyQuestionRows({ root, host, questions, drafts, entries = [], isCurrent, cryptoImpl = globalThis.crypto }) {
  if (!root?.querySelectorAll) return;
  for (const row of root.querySelectorAll('[data-legacy-question-lead]')) {
    if (row.hidden && row.dataset.legacyQuestionResolved === 'open') continue;
    let question, retained;
    try {
      if (!isCurrent() || !host.isConnected) return;
      const original = JSON.parse(row.dataset.legacyQuestionOriginal);
      const key = 'legacy-draft:' + row.dataset.legacyQuestionLead + ':' + canonicalIntentJson(original);
      retained = entries.find(e => !e.resolvedOperationId && e.legacyOperation?.kind === 'legacy_question_answer'
        && e.legacyOperation.leadId === row.dataset.legacyQuestionLead
        && canonicalIntentJson(e.legacyOperation.question) === canonicalIntentJson(original));
      const input = row.querySelector('input');
      if (input) {
        if (!input.value && Object.hasOwn(drafts, key)) input.value = drafts[key];
        else drafts[key] = input.value;
        row.oninput = event => { if (event.target === input && isCurrent()) drafts[key] = input.value; };
      }
      question = await findMigratedQuestion(row.dataset.legacyQuestionLead, original, questions, cryptoImpl);
    }
    catch (_) { continue; } // Invalid original or mapping remains visible.
    if (!isCurrent() || !host.isConnected) return;
    if (!row.isConnected) continue;
    const field = row.querySelector('input');
    const text = field?.value || '';
    if (retained && (!text || text.trim() === retained.legacyOperation.answer)
      && safeId(retained.operationId) && host.querySelector('[data-retained-legacy="' + retained.operationId + '"]')) {
      row.hidden = true; row.style.display = 'none'; continue;
    }
    if (!question) continue;
    const target = host.querySelector('[data-server-question="' + question.id + '"]');
    const answer = target?.querySelector('[data-answer-text]');
    if (question.status === 'open' && answer) {
      // Read the draft AFTER the asynchronous fingerprint check. Never replace
      // an already queued answer or a different draft in the canonical view.
      if (text && answer.value && text !== answer.value) {
        let notice = row.querySelector('[data-legacy-draft-notice]');
        if (!notice) { notice = row.ownerDocument.createElement('p'); notice.dataset.legacyDraftNotice = ''; row.append(notice); }
        notice.textContent = 'Hier steht ein anderer Entwurf. Er bleibt erhalten; bitte mit der Antwort im gemeinsamen Fragenbereich vergleichen.';
        continue;
      }
      if (text && !answer.readOnly) { drafts[question.id] = text; answer.value = text; }
      // An active old input moves its focus with its exact text.
      if (field && row.ownerDocument.activeElement === field) answer.focus();
      row.hidden = true;
      row.style.display = 'none';
      row.dataset.legacyQuestionResolved = 'open';
    } else if (question.status !== 'open' && !row.dataset.legacyQuestionResolved) {
      const notice = row.ownerDocument.createElement('p');
      notice.textContent = question.status === 'answered'
        ? 'Diese Frage ist im synchronisierten Serverbestand bereits beantwortet.'
        : 'Diese Frage wurde vom Server zurückgenommen. Eine neue Frage muss separat bestätigt werden.';
      row.append(notice);
      if (field) field.readOnly = true;
      for (const button of row.querySelectorAll('button')) button.disabled = true;
      // Preserve an unsent differing draft visibly, without another send action.
      if (text) { const label = row.ownerDocument.createElement('p'); label.textContent = 'Dein noch nicht gesendeter Entwurf bleibt hier zum Vergleichen erhalten.'; row.append(label); }
      else { row.hidden = true; row.style.display = 'none'; }
      row.dataset.legacyQuestionResolved = question.status;
    }
  }
  if (!isCurrent() || !host.isConnected) return;
  for (const section of root.querySelectorAll('[data-legacy-question-section]')) {
    const rows = [...section.querySelectorAll('[data-legacy-question-lead]')];
    if (!rows.length) continue;
    const visible = rows.filter(row => !row.hidden).length;
    const counter = section.querySelector('[data-legacy-question-count]');
    if (counter) counter.textContent = '(' + visible + ')';
    section.hidden = visible === 0;
    section.style.display = visible === 0 ? 'none' : '';
  }
}

export function renderBriefingAnswers(questions, entries = [], drafts = {}) {
  const byQuestion = new Map(entries.filter(e => e.command?.verb === 'briefing.answer').map(e => [e.command.payload.questionId, e]));
  const shown = new Map(questions.filter(q => q && safeId(q.id) && q.status === 'open').map(q => [q.id, q]));
  // An unresolved local intention remains visible even after another device
  // answers the question, or the server question disappears from this snapshot.
  for (const [id, entry] of byQuestion) if (entry.status !== 'acknowledged' && !shown.has(id)) shown.set(id, { id, text: 'Noch nicht bestätigte Antwort', status: 'unavailable' });
  const retained = entries.filter(e => e.legacyOperation?.kind === 'legacy_question_answer' && !e.resolvedOperationId);
  return '<h3>Fragen aus der automatischen Verarbeitung</h3><p class="mini">Aus dem synchronisierten Fragenbestand. Antworten werden einzeln an den Server übertragen.</p>'
    + retained.map(e => '<div class="db-item" data-retained-legacy="' + esc(e.operationId) + '" style="display:block"><strong>' + esc(e.legacyOperation.question.text) + '</strong>'
      + '<p>' + esc(e.legacyOperation.answer) + '</p><p class="mini" role="status">' + esc(answerDeliveryText(e.deliveryStatus)) + '</p>'
      + '<button class="btn sm" data-action="cgl-open" data-id="' + esc(e.legacyOperation.leadId) + '">Zugehörigen Lead öffnen</button></div>').join('')
    + (shown.size ? Array.from(shown.values()).map(q => {
      const entry = byQuestion.get(q.id), addressable = dateValid(q.runDate) && q.status === 'open';
      const text = entry?.command.payload.answer ?? drafts[q.id] ?? q.legacyAnswerDraft ?? '';
      return '<div class="db-item" style="display:block" data-server-question="' + esc(q.id) + '">'
        + '<strong>' + esc(q.text) + '</strong>'
        + (q.legacyAnswerDraft ? '<p class="mini">Antwort aus dem Altbestand – bitte prüfen und ausdrücklich bestätigen. Sie wurde noch nicht als neue Nutzerantwort verarbeitet.</p>' : '')
        + (q.recommendation ? '<p class="mini">Empfehlung: ' + esc(q.recommendation) + '</p>' : '')
        + (q.sourceType === 'chatgptLead' && safeId(q.sourceId) ? '<div><button class="btn sm" data-action="cgl-open" data-id="' + esc(q.sourceId) + '">Zugehörigen Lead öffnen</button></div>' : '')
        + '<div class="db-link-row">' + (!entry && addressable && Array.isArray(q.options) ? q.options.filter(o => typeof o === 'string').slice(0, 8).map(o => '<button class="btn sm" data-answer-option="' + esc(o) + '">' + esc(o) + '</button>').join('') : '') + '</div>'
        + '<label>Deine Antwort<textarea rows="3" maxlength="8000" data-answer-text' + (entry || !addressable ? ' readonly' : '') + '>' + esc(text) + '</textarea></label>'
        + (!entry && addressable ? '<button class="btn primary" data-answer-submit>Antwort senden</button>' : '')
        + '<p class="mini" role="status">' + esc(entry ? labels[entry.status] || 'Übertragung ungeklärt' : addressable ? 'Noch nicht gesendet' : 'Die Frage ist noch keinem bestätigten Tageslauf zugeordnet. Antwort hier noch nicht möglich.') + '</p></div>';
    }).join('') : '<p class="mini">Im synchronisierten Bestand liegen keine offenen Server-Fragen vor.</p>')
    + '<button class="btn sm" data-answer-retry>Übertragungen prüfen</button><p class="mini" data-answer-status role="status"></p>';
}

// The host can be replaced by the app's normal pull/merge/render cycle. Drafts
// live in the controller, separately for each signed-in account, never in core.
export function bindBriefingAnswers({ host, client, questions, drafts, isCurrent = () => true, legacyRoot }) {
  let busy = false;
  clearTimeout(host._answerRetryTimer);
  const status = text => { if (isCurrent() && host.isConnected) host.querySelector('[data-answer-status]').textContent = text; };
  async function draw() {
    const entries = await client.list();
    if (isCurrent() && host.isConnected) {
      host.innerHTML = renderBriefingAnswers(questions, entries, drafts);
      await reconcileLegacyQuestionRows({ root: legacyRoot, host, questions, drafts, entries, isCurrent });
      if (!isCurrent() || !host.isConnected) return;
      clearTimeout(host._answerRetryTimer);
      const pending = entries.filter(e => ['pending', 'retry_wait'].includes(e.status) || e.deliveryStatus === 'legacy_unmapped');
      if (pending.length) host._answerRetryTimer = setTimeout(async () => {
        if (!isCurrent() || !host.isConnected) return;
        if (busy) return;
        busy = true;
        try {
          const result = await client.flush();
          await draw();
          if (result.paused) status('Die Server-Schnittstelle ist noch nicht zum Schreiben freigegeben. Deine Antwort bleibt auf diesem Gerät gesichert.');
        } catch (_) { status('Übertragung noch offen. Bitte Anmeldung prüfen oder Übertragungen erneut prüfen.'); }
        finally { busy = false; }
      }, Math.min(600_000, Math.max(100, Math.max(client.nextCheckAt?.() || 0, Math.min(...pending.map(e => e.nextAttemptAt || 0))) - Date.now())));
    }
  }
  host.oninput = event => {
    const row = event.target.closest('[data-server-question]');
    if (row && event.target.matches('[data-answer-text]') && isCurrent()) drafts[row.dataset.serverQuestion] = event.target.value;
  };
  host.onclick = async event => {
    const button = event.target.closest('[data-answer-option], [data-answer-submit], [data-answer-retry]');
    if (!button || !host.contains(button) || busy || !isCurrent()) return;
    event.preventDefault();
    const row = button.closest('[data-server-question]');
    const question = row && questions.find(q => q.id === row.dataset.serverQuestion);
    if (button.hasAttribute('data-answer-option')) {
      const value = button.dataset.answerOption;
      if (!question?.options?.includes(value)) return;
      drafts[question.id] = value;
      row.querySelector('[data-answer-text]').value = value;
      row.querySelector('[data-answer-text]').focus();
      return;
    }
    busy = true; button.disabled = true;
    try {
      if (button.hasAttribute('data-answer-submit')) {
        await client.submit(question, row.querySelector('[data-answer-text]').value);
        await draw();
      }
      const result = await client.flush();
      await draw();
      if (result.paused) status('Die Server-Schnittstelle ist noch nicht zum Schreiben freigegeben. Deine Antwort bleibt auf diesem Gerät gesichert.');
    } catch (error) {
      status(error?.code === 'operation_id_conflict'
        ? 'Für diese Frage ist bereits eine andere Antwort gesichert. Sie wurde nicht überschrieben. Bitte die Übertragungen prüfen.'
        : error?.code === 'sign_in_required' ? 'Bitte anmelden. Noch nicht bestätigte Antworten bleiben auf diesem Gerät erhalten.'
          : 'Nicht bestätigt. Text bleibt erhalten; bitte Übertragung und Anmeldung prüfen.');
    } finally { busy = false; button.disabled = false; }
  };
  return draw();
}
