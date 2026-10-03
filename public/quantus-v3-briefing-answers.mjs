import { openCommandQueue, createCommandTransport } from './quantus-v3-command-client.mjs';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(value) && !value.includes('__');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

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

export async function openBriefingAnswers({ accountKey, getAuth, origin, indexedDB, fetchImpl, now = Date.now, cryptoImpl = globalThis.crypto } = {}) {
  const queue = await openCommandQueue({ indexedDB, databaseName: 'quantus-v3-briefing-answers', now });
  const transport = createCommandTransport({ origin, getAuth, fetchImpl, now, writesEnabled: true });
  const checkedTransport = { async send(entry, options) {
    const result = await transport.send(entry, options);
    if (result.ok && ![entry.command.payload.questionId, entry.command.payload.answerId]
      .every(id => Object.hasOwn(result.receipt.entityVersions, id))) {
      return { ok: false, status: 0, code: 'answer_receipt_incomplete', retryable: true, uncertain: true };
    }
    return result;
  } };
  return Object.freeze({
    close: () => queue.close(),
    list: () => queue.list(accountKey, { includeAcknowledged: true }),
    async submit(question, answer) {
      const intent = await answerIntent({ accountKey, question, answer, cryptoImpl });
      // Only this durable commit permits the UI to say 'on this device saved'.
      return queue.enqueue(intent);
    },
    async flush() {
      const auth = await getAuth();
      if (!auth || auth.accountKey !== accountKey) fail('sign_in_required');
      await queue.resumeAfterSignIn(accountKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try { return await queue.drain(accountKey, { transport: checkedTransport, limit: 8, signal: controller.signal }); }
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
});

export function renderBriefingAnswers(questions, entries = [], drafts = {}) {
  const byQuestion = new Map(entries.filter(e => e.command?.verb === 'briefing.answer').map(e => [e.command.payload.questionId, e]));
  const shown = new Map(questions.filter(q => q && safeId(q.id) && q.status === 'open').map(q => [q.id, q]));
  // An unresolved local intention remains visible even after another device
  // answers the question, or the server question disappears from this snapshot.
  for (const [id, entry] of byQuestion) if (entry.status !== 'acknowledged' && !shown.has(id)) shown.set(id, { id, text: 'Noch nicht bestätigte Antwort', status: 'unavailable' });
  return '<h3>Fragen aus der automatischen Verarbeitung</h3><p class="mini">Aus dem synchronisierten Fragenbestand. Antworten werden einzeln an den Server übertragen.</p>'
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
export function bindBriefingAnswers({ host, client, questions, drafts, isCurrent = () => true }) {
  let busy = false;
  clearTimeout(host._answerRetryTimer);
  const status = text => { if (isCurrent() && host.isConnected) host.querySelector('[data-answer-status]').textContent = text; };
  async function draw() {
    const entries = await client.list();
    if (isCurrent() && host.isConnected) {
      host.innerHTML = renderBriefingAnswers(questions, entries, drafts);
      clearTimeout(host._answerRetryTimer);
      const pending = entries.filter(e => ['pending', 'retry_wait'].includes(e.status));
      if (pending.length) host._answerRetryTimer = setTimeout(async () => {
        if (!isCurrent() || !host.isConnected) return;
        if (busy) { await draw(); return; }
        busy = true;
        try {
          const result = await client.flush();
          await draw();
          if (result.paused) status('Die Server-Schnittstelle ist noch nicht zum Schreiben freigegeben. Deine Antwort bleibt auf diesem Gerät gesichert.');
        } catch (_) { status('Übertragung noch offen. Bitte Anmeldung prüfen oder Übertragungen erneut prüfen.'); }
        finally { busy = false; }
      }, Math.min(600_000, Math.max(30_000, Math.min(...pending.map(e => e.nextAttemptAt || 0)) - Date.now())));
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
