/* ══ Quantus v3 — C2: Lesehilfen, sichtbare Felder, Seiten ════════════════
 *
 * Lesen ist der stillere Teil des Risikos: Was hier hinausgeht, geht an
 * Agenten, die es weitertragen — in Modelltext, in Zusammenfassungen, in
 * fremde Systeme. Deshalb gilt hier dieselbe Strenge wie beim Schreiben:
 *
 *  • SICHTBARE FELDER SIND EINE LISTE. Jede Datenkategorie hat eine
 *    Positivliste; alles andere wird abgeschnitten, auch verschachtelt. Was
 *    neu ins Datenmodell kommt, ist also NICHT automatisch sichtbar.
 *  • KEIN FREITEXTFELD MIT GEHEIMNIS. Vor dem Ausliefern läuft die
 *    Geheimnissuche aus C1 über die Seite. Ein Treffer ist ein Fehler des
 *    Servers, kein „dann halt mit".
 *  • EINE GEDECKELTE ODER ABGEBROCHENE SEITE IST NIE VOLLSTÄNDIG. Dafür
 *    sorgt `describePage` aus quantus-v3-cursor.mjs; hier wird nur sauber
 *    hineingereicht, was sie unterscheiden kann.
 *
 * Die Inhalte selbst kommen aus dem Domänen-Adapter. Fehlt er, liest der
 * Dienst gar nicht erst (503) — siehe quantus-v3-service.mjs.
 * ═══════════════════════════════════════════════════════════════════════ */

import { authError, authOk, assertNoProviderSecrets } from "./quantus-v3-auth.mjs";
import { NAMED_QUERIES } from "./quantus-v3-cursor.mjs";

/* Welche Felder eine Kategorie nach aussen zeigt. Bewusst knapp: Id, Zustand,
   Zeitstempel, kurze Bezeichnung. Freitext nur dort, wo er der Zweck ist. */
export const VISIBLE_FIELDS = Object.freeze({
  run: Object.freeze(["id", "slot", "date", "state", "entityVersion", "createdAt", "updatedAt", "leaseExpiresAt"]),
  run_status: Object.freeze(["id", "runId", "state", "stage", "entityVersion", "updatedAt", "openQuestions", "blocked"]),
  run_context: Object.freeze(["id", "runId", "kind", "title", "text", "entityVersion", "updatedAt", "evidenceRefs"]),
  lead: Object.freeze(["id", "title", "state", "entityVersion", "updatedAt", "waitUntil", "openQuestionId"]),
  note: Object.freeze(["id", "runId", "leadId", "text", "entityVersion", "createdAt", "author"]),
  policy: Object.freeze(["id", "policyVersion", "mode", "entityVersion", "updatedAt", "limits"]),
  task: Object.freeze(["id", "leadId", "title", "state", "dueAt", "entityVersion", "updatedAt"]),
  intake: Object.freeze(["id", "source", "title", "state", "entityVersion", "createdAt"]),
  question: Object.freeze(["id", "leadId", "text", "state", "entityVersion", "updatedAt"]),
  briefing: Object.freeze(["id", "date", "state", "entityVersion", "updatedAt"]),
  briefing_answer: Object.freeze(["id", "briefingId", "questionId", "state", "entityVersion", "updatedAt"]),
  document: Object.freeze(["id", "title", "state", "entityVersion", "updatedAt"]),
  assignment: Object.freeze(["id", "runId", "workerKind", "state", "entityVersion", "dueAt"]),
  worker_result: Object.freeze(["id", "assignmentId", "state", "summary", "entityVersion", "updatedAt"]),
  system_status: Object.freeze(["id", "state", "entityVersion", "updatedAt"]),
});

/* Verschachtelte Felder, die ausnahmsweise mitdürfen — mit eigener Liste. */
const NESTED_FIELDS = Object.freeze({
  "policy.limits": Object.freeze(["maxLeads", "maxTasks", "maxTokens"]),
});

/*
 * Welcher Eintrag zu welchem Scope gehört.
 *
 * BEFUND (Review 33a4b3d): Autorisiert wurde nur der SCOPE. Lieferte der
 * Fachadapter in einer erlaubten Seite einen fremden Eintrag (anderer Mandant,
 * fremder Eigentümer, fremder Lead), ging er mit 200 hinaus. Die Beziehung
 * zwischen Eintrag und Scope ist deshalb jetzt Teil der Prüfung — zusätzlich
 * zur vollen Rechteprüfung jedes einzelnen Eintrags im Dienst.
 */
export const SCOPE_RELATION = Object.freeze({
  "run.context": (item, scopeId) => String(item.runId || item.jobId || "") === scopeId,
  "lead.context": (item, scopeId) => String(item.id || "") === scopeId,
  "notes.recent": (item, scopeId) => String(item.leadId || "") === scopeId,
  "run.queue": (item) => Boolean(item.id),
  "run.status": (item) => Boolean(item.id),
  "policy.current": (item) => Boolean(item.id),
});

export function belongsToScope(query, item, scopeId) {
  const regel = Object.prototype.hasOwnProperty.call(SCOPE_RELATION, query) ? SCOPE_RELATION[query] : null;
  if (!regel || !item || typeof item !== "object") return false;
  try { return regel(item, String(scopeId)) === true; } catch { return false; }
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/*
 * Ein Eintrag, auf die sichtbaren Felder beschnitten. Fehlende Felder fehlen
 * (statt als `null` zu erscheinen); unbekannte Felder verschwinden.
 */
export function projectItem(category, item) {
  const erlaubt = Object.prototype.hasOwnProperty.call(VISIBLE_FIELDS, category) ? VISIBLE_FIELDS[category] : null;
  if (!erlaubt) return null;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const out = {};
  for (const feld of erlaubt) {
    if (!Object.prototype.hasOwnProperty.call(item, feld)) continue;
    const wert = item[feld];
    if (wert === undefined) continue;
    const nested = NESTED_FIELDS[`${category}.${feld}`];
    if (nested) {
      if (!wert || typeof wert !== "object" || Array.isArray(wert)) continue;
      const teil = {};
      for (const k of nested) if (Object.prototype.hasOwnProperty.call(wert, k)) teil[k] = wert[k];
      out[feld] = teil;
      continue;
    }
    if (wert && typeof wert === "object" && !Array.isArray(wert)) continue;   // unbekannte Struktur: nicht zeigen
    if (Array.isArray(wert)) {
      // Listen nur aus einfachen Werten, und begrenzt.
      if (wert.some((e) => e && typeof e === "object")) continue;
      out[feld] = wert.slice(0, 50);
      continue;
    }
    out[feld] = wert;
  }
  return out;
}

/*
 * Eine ganze Seite beschneiden. Ein Eintrag, der nach dem Beschneiden keine
 * Id mehr hat, ist unbrauchbar — dann gilt die Seite als abgebrochen
 * (`describePage` macht daraus `complete: false`).
 */
export function projectPage(query, items) {
  const named = Object.prototype.hasOwnProperty.call(NAMED_QUERIES, query) ? NAMED_QUERIES[query] : null;
  if (!named) return authError("forbidden", "query_not_allowed");
  if (!Array.isArray(items)) return authError("invalid_request", "items_not_a_list");

  const out = [];
  for (const eintrag of items) {
    const beschnitten = projectItem(named.itemCategory, eintrag);
    if (!beschnitten || !beschnitten.id) return authOk({ items: [{ error: "item_unusable" }], usable: false });
    out.push(beschnitten);
  }
  // Letzte Kontrolle: nichts Geheimnisartiges verlässt den Server. Die
  // Standardtiefe, nicht eine knappe: seit der zweiten Review ist eine
  // abgebrochene Suche eine ABSAGE — ein zu kleines Budget würde also
  // gültige Seiten sperren statt Geheimnisse zu finden.
  const geheim = assertNoProviderSecrets(out);
  if (!geheim.ok) return authError("forbidden", "secret_in_read_result");
  return authOk({ items: out, usable: true });
}

/* Seitengrösse aus einem Parameter — streng, mit Deckel je Abfrage. */
export function pageSizeFor(query, raw) {
  const named = Object.prototype.hasOwnProperty.call(NAMED_QUERIES, query) ? NAMED_QUERIES[query] : null;
  if (!named) return authError("forbidden", "query_not_allowed");
  if (raw == null || raw === "") return authOk({ pageSize: Math.min(DEFAULT_PAGE_SIZE, named.maxPageSize) });
  if (!/^\d{1,4}$/.test(String(raw))) return authError("invalid_request", "page_size_invalid");
  const wert = Number(raw);
  if (!Number.isInteger(wert) || wert < 1 || wert > named.maxPageSize || wert > MAX_PAGE_SIZE) {
    return authError("invalid_request", "page_size_out_of_bounds");
  }
  return authOk({ pageSize: wert });
}

/*
 * Die Entitätsversionen einer Seite: nur Id → Version, nichts weiter. Der
 * Aufrufer braucht sie für `expectedEntityVersion`; alles darüber hinaus wäre
 * zusätzliche Sichtbarkeit ohne Zweck.
 */
export function entityVersionsOf(items) {
  const out = {};
  for (const eintrag of Array.isArray(items) ? items : []) {
    if (!eintrag || typeof eintrag !== "object") continue;
    const id = eintrag.id;
    const version = eintrag.entityVersion;
    if (typeof id === "string" && Number.isInteger(version)) out[id] = version;
  }
  return out;
}

export default { VISIBLE_FIELDS, projectItem, projectPage, pageSizeFor, entityVersionsOf, belongsToScope, SCOPE_RELATION, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
