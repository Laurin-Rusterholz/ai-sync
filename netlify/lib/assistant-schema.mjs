/* ══ Tagesbriefing v3 — Schema, Zustandsmapping, Policy, Schutzfelder ═══════
 *
 * Was hier steht, ist die EINE Quelle fuer:
 *   · die Form von dailyBriefing.assistantRuns[YYYY-MM-DD] und data.automation
 *   · das einzige Betriebszustandsmodell (operationalState) und die
 *     Abbildung der gewachsenen Altstatus darauf
 *   · die Policy (vollstaendig oder gar nicht — kein Default-Gruen)
 *   · die Schutzfelder, die kein Agent ueber ein Kommando setzen darf
 *   · die Command-Schemas, ueber die der Kern spaeter ausschliesslich
 *     angesprochen wird
 *
 * Es gibt KEINE zweite Aufgaben- oder Statusdatenbank: die Arbeit lebt
 * weiter in entities.chatgptLeads / chatgptTasks / tasks / projects. Der
 * Kern schreibt an diese Objekte genau ein abgeleitetes Feld
 * (operationalState samt Herkunftsvermerk) und legt daneben nur Buchhaltung
 * ab (Laeufe, Belege, Fragen/Antworten, Dokumente, Jobs, Zaehler).
 * ═════════════════════════════════════════════════════════════════════════ */

export const SCHEMA_VERSION = 3;
export const POLICY_SCHEMA = "tagesbriefing-policy/3";

export const OPERATIONAL_STATES = Object.freeze([
  "doing", "waiting_external", "waiting_user", "delegated", "review", "done", "cancelled",
]);
export const OFFENE_ZUSTAENDE = Object.freeze(["doing", "waiting_external", "waiting_user", "delegated", "review"]);
export const WARTE_ZUSTAENDE = Object.freeze(["waiting_external", "waiting_user", "delegated"]);
export const ABGESCHLOSSENE_ZUSTAENDE = Object.freeze(["done", "cancelled"]);

export const RUN_PHASES = Object.freeze(["created", "active", "final", "exception_open"]);
export const EXECUTORS = Object.freeze(["openai", "claude", "gemini", "user", "external"]);

export const SOURCE_TYPES = Object.freeze(["chatgptLead", "chatgptTask", "task", "project", "intake", "question", "document", "job"]);

/* Sammlungen im Bestand, aus denen Arbeit stammt. Projekte tragen nur
 * Fristen (deadlines) bei; ihr eigener Status wird nicht in
 * operationalState uebersetzt (siehe docs/tagesbriefing-v3-kern.md). */
export const QUELLEN = Object.freeze({
  chatgptLead: Object.freeze({ store: "chatgptLeads", statusField: "status" }),
  chatgptTask: Object.freeze({ store: "chatgptTasks", statusField: "state" }),
  task: Object.freeze({ store: "tasks", statusField: "status" }),
});

/* ── Abbildung der Altstatus ────────────────────────────────────────────
 * Der Altstatus bleibt das Feld, das die Clients schreiben. Das Mapping
 * ist bewusst konservativ:
 *   · Ein "wartet"/"waiting" ohne Gegenpartei wird zum passendsten
 *     Wartezustand, bekommt aber KEINE Warte-Evidenz erfunden. Ohne
 *     Evidenz ist der Zustand in der Ampel nicht gruen — genau das ist die
 *     Absicht: ein Altbestand kann sich nicht selbst freisprechen.
 *   · Unbekannte Werte werden NICHT stumm nach done gedeutet: das Ergebnis
 *     ist { operationalState: null, unmapped: true } — sichtbar im
 *     Migrationsbericht und rot in der Ampel.
 */
export function mapChatgptLead(l) {
  const status = l && typeof l.status === "string" ? l.status : null;
  const bekannt = ["neu", "verstanden", "in_arbeit", "wartet", "abgeschlossen"];
  if (!bekannt.includes(status)) return unmapped("status", status);
  if (status === "abgeschlossen") {
    if (l.closedBy === "laurin" && (l.obsoleteReason || l.obsolete)) return mapped("cancelled", "status", status, "hinfaellig durch Laurin");
    return mapped("done", "status", status);
  }
  // Cowork-Abgabe: abgegeben und noch nicht zurueck → delegiert; zurueck → review.
  if (l.assignee === "cowork" && l.handoverAt && !l.returnedAt) return mapped("delegated", "status", status, "Cowork-Paket unterwegs");
  if (l.assignee === "cowork" && l.returnedAt) return mapped("review", "status", status, "Cowork-Rueckgabe liegt vor");
  if (status === "wartet") return mapped("waiting_user", "status", status, "Altstatus wartet ohne Gegenpartei — Evidenz fehlt");
  return mapped("doing", "status", status);
}

export function mapChatgptTask(t) {
  const state = t && typeof t.state === "string" ? t.state : null;
  if (!["offen", "erledigt", "wartet"].includes(state)) return unmapped("state", state);
  if (state === "erledigt") return mapped("done", "state", state);
  if (state === "wartet") return mapped("waiting_user", "state", state, "Altstatus wartet ohne Gegenpartei — Evidenz fehlt");
  return mapped("doing", "state", state);
}

export function mapTask(t) {
  const status = t && typeof t.status === "string" ? t.status : null;
  const tabelle = { todo: "doing", doing: "doing", waiting: "waiting_external", review: "review", done: "done" };
  if (!Object.prototype.hasOwnProperty.call(tabelle, status)) return unmapped("status", status);
  const hint = status === "waiting" ? "Altstatus waiting ohne Gegenpartei — Evidenz fehlt" : null;
  return mapped(tabelle[status], "status", status, hint);
}

function mapped(operationalState, legacyField, legacyValue, note = null) {
  return { operationalState, legacyField, legacyValue, unmapped: false, note };
}
function unmapped(legacyField, legacyValue) {
  return { operationalState: null, legacyField, legacyValue: legacyValue == null ? null : String(legacyValue), unmapped: true, note: "unbekannter Altstatus" };
}

export const MAPPER = Object.freeze({ chatgptLead: mapChatgptLead, chatgptTask: mapChatgptTask, task: mapTask });

/* Wer traegt die Verantwortung, wer fuehrt aus.
 * KI-Leads: accountable = chatgpt. Executor nach Zuweisung: chatgpt → openai,
 * cowork → claude. Regulaere Aufgaben gehoeren dem Nutzer; ihr assignee-Feld
 * wird NICHT in einen Modellnamen umbenannt. */
export function rollenFuer(sourceType, entity) {
  if (sourceType === "chatgptLead") {
    const executor = entity?.assignee === "cowork" ? "claude" : entity?.assignee === "chatgpt" ? "openai" : null;
    return { accountable: "chatgpt", executor };
  }
  if (sourceType === "chatgptTask") return { accountable: "chatgpt", executor: "openai" };
  return { accountable: "user", executor: "user" };
}

/* Den wirksamen Betriebszustand einer Entitaet bestimmen.
 * Reihenfolge: (1) hat der Client den Altstatus seit dem letzten Mapping
 * veraendert, gilt der Altstatus (er ist die Wahrheit der Oberflaeche);
 * (2) sonst gilt das gespeicherte operationalState — aber "done" nur, wenn
 * der Altstatus es bestaetigt. Ein von aussen hingeschriebenes done ohne
 * abgeschlossenen Altstatus ist eine BEHAUPTUNG und wird als solche gemeldet. */
export function effektiverZustand(sourceType, entity) {
  const mapper = MAPPER[sourceType];
  if (!mapper) throw new RangeError(`effektiverZustand: unbekannter sourceType ${sourceType}`);
  const abgeleitet = mapper(entity || {});
  const gespeichert = entity && typeof entity.operationalState === "string" ? entity.operationalState : null;
  const herkunft = entity && entity.operationalStateSource && typeof entity.operationalStateSource === "object" ? entity.operationalStateSource : null;

  if (abgeleitet.unmapped) return { state: null, unmapped: true, inconsistent: false, legacy: abgeleitet, stored: gespeichert };

  const legacyUnveraendert = herkunft && herkunft.legacyValue === abgeleitet.legacyValue;
  if (!gespeichert || !OPERATIONAL_STATES.includes(gespeichert) || !legacyUnveraendert) {
    return { state: abgeleitet.operationalState, unmapped: false, inconsistent: false, legacy: abgeleitet, stored: gespeichert };
  }
  if (ABGESCHLOSSENE_ZUSTAENDE.includes(gespeichert) && !ABGESCHLOSSENE_ZUSTAENDE.includes(abgeleitet.operationalState)) {
    // Behauptung "done/cancelled" ohne bestaetigenden Altstatus.
    return { state: abgeleitet.operationalState, unmapped: false, inconsistent: true, legacy: abgeleitet, stored: gespeichert };
  }
  return { state: gespeichert, unmapped: false, inconsistent: false, legacy: abgeleitet, stored: gespeichert };
}

/* ── Policy ─────────────────────────────────────────────────────────────
 * Eine Policy ist entweder VOLLSTAENDIG oder unbrauchbar. Es gibt keine
 * Voreinstellung, die im Zweifel gruen ergibt. Die Vorlage unten traegt
 * alle Schalter auf dry_run und KEINE Quellen — sie ist absichtlich nicht
 * gueltig, bis jemand die Quellen ausdruecklich benennt. */
export const FEATURE_FLAG_MODES = Object.freeze(["dry_run", "live"]);

export const POLICY_TEMPLATE = Object.freeze({
  schema: POLICY_SCHEMA,
  version: "3.0",
  tenant: "quantus",
  timezone: "Europe/Zurich",
  sourceMaxAgeMinutes: 15,
  evaluationTtlMinutes: 15,
  deferralLimit: 3,
  maxWaitDays: 30,
  requiredSources: [],          // z. B. [{ id: "gmail-inbox", kind: "mail" }]
  noExternalSources: false,     // nur zusammen mit requiredSources: [] gueltig
  closure: Object.freeze({ earliestLocalTime: "23:00", requiredReceipts: ["process09", "close23"] }),
  featureFlags: Object.freeze({ writes: "dry_run", runner: "dry_run", providers: "dry_run" }),
});

export function validatePolicy(policy) {
  const fehler = [];
  const p = policy && typeof policy === "object" ? policy : null;
  if (!p) return { ok: false, errors: ["POLICY_MISSING"] };
  if (p.schema !== POLICY_SCHEMA) fehler.push("POLICY_SCHEMA");
  if (typeof p.version !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(p.version)) fehler.push("POLICY_VERSION");
  if (typeof p.tenant !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.tenant)) fehler.push("POLICY_TENANT");
  if (p.timezone !== "Europe/Zurich") fehler.push("POLICY_TIMEZONE");
  for (const k of ["sourceMaxAgeMinutes", "evaluationTtlMinutes", "deferralLimit", "maxWaitDays"]) {
    if (!(Number.isInteger(p[k]) && p[k] > 0)) fehler.push("POLICY_" + k.replace(/([A-Z])/g, "_$1").toUpperCase());
  }
  if (!Array.isArray(p.requiredSources)) fehler.push("POLICY_REQUIRED_SOURCES");
  else {
    const ids = new Set();
    for (const s of p.requiredSources) {
      if (!s || typeof s.id !== "string" || !s.id || typeof s.kind !== "string" || !s.kind) { fehler.push("POLICY_SOURCE_SHAPE"); break; }
      if (ids.has(s.id)) { fehler.push("POLICY_SOURCE_DUPLICATE"); break; }
      ids.add(s.id);
    }
    if (p.requiredSources.length === 0 && p.noExternalSources !== true) fehler.push("POLICY_SOURCES_NOT_CONFIGURED");
  }
  const c = p.closure;
  if (!c || typeof c !== "object" || !/^\d{2}:\d{2}$/.test(String(c.earliestLocalTime || "")) || !Array.isArray(c.requiredReceipts) || !c.requiredReceipts.length) fehler.push("POLICY_CLOSURE");
  const f = p.featureFlags;
  if (!f || typeof f !== "object") fehler.push("POLICY_FEATURE_FLAGS");
  else for (const k of ["writes", "runner", "providers"]) if (!FEATURE_FLAG_MODES.includes(f[k])) fehler.push("POLICY_FLAG_" + k.toUpperCase());
  return { ok: fehler.length === 0, errors: fehler };
}

/* ── Schutzfelder ───────────────────────────────────────────────────────
 * Diese Felder setzt ausschliesslich der Kern selbst (Abschluss,
 * Invalidierung, Migration). finalNoteId/startNoteId sind KEINE
 * Schutzfelder, sondern Eingaben der Kommandos closeRun/ensureStartNote —
 * dort prueft der Handler alle Voraussetzungen, bevor er sie setzt.
 * Kein Kommando darf ein Schutzfeld mitliefern — auch nicht
 * "zur Sicherheit" oder in einem beliebigen Freitextfeld. Der Dispatcher
 * lehnt jedes Kommando ab, dessen Nutzlast eines davon enthaelt, in
 * beliebiger Tiefe. */
export const PROTECTED_FIELDS = Object.freeze([
  "finalAt", "closureRevision", "closureCutoff", "phase",
  "invalidatedAt", "archiveRef", "overallGreen", "userApproval", "approved", "approvedBy",
  "operationalState", "operationalStateSource", "consumedAt", "answeredAt", "deferrals",
  "dataRevision", "revision", "evaluatedRevision", "validUntil", "coverage", "operations",
]);
const PROTECTED_SET = new Set(PROTECTED_FIELDS);

export function findeSchutzfelder(payload, pfad = "", gefunden = [], tiefe = 0) {
  if (tiefe > 12 || payload == null || typeof payload !== "object") return gefunden;
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => findeSchutzfelder(v, `${pfad}[${i}]`, gefunden, tiefe + 1));
    return gefunden;
  }
  for (const k of Object.keys(payload)) {
    const p = pfad ? `${pfad}.${k}` : k;
    if (PROTECTED_SET.has(k)) gefunden.push(p);
    findeSchutzfelder(payload[k], p, gefunden, tiefe + 1);
  }
  return gefunden;
}

/* ── Command-Schemas ────────────────────────────────────────────────────
 * Jedes Kommando nennt seine erlaubten Felder ausdruecklich. Unbekannte
 * Felder sind ein Fehler, nicht "wird ignoriert" — sonst kaeme ueber ein
 * ignoriertes Feld heute und ein durchgereichtes Feld morgen doch ein
 * Schutzfeld in den Kern. Die Kommandos sind die einzige Stelle, an der
 * spaeter der CAS-Schreibpfad ansetzt. */
export const COMMAND_SCHEMAS = Object.freeze({
  ensureRun:            Object.freeze({ required: ["date"], optional: [] }),
  ensureStartNote:      Object.freeze({ required: ["date", "noteId"], optional: ["title", "content"] }),
  recordSlotReceipt:    Object.freeze({ required: ["date", "slot", "receiptId"], optional: ["note"] }),
  recordSourceCheck:    Object.freeze({ required: ["date", "sourceId", "cursor", "outcome"], optional: ["detail"] }),
  addItemRef:           Object.freeze({ required: ["date", "sourceType", "sourceId"], optional: ["carriedFrom"] }),
  observeSource:        Object.freeze({ required: ["sourceType", "sourceId"], optional: [] }),
  setWaiting:           Object.freeze({ required: ["sourceType", "sourceId", "state", "counterparty", "nextAction", "followUpAt", "evidence"], optional: [] }),
  transitionState:      Object.freeze({ required: ["sourceType", "sourceId", "state"], optional: ["reason", "linkTo"] }),
  registerIntake:       Object.freeze({ required: ["intakeId", "text", "channel"], optional: ["receivedAt", "sourceType", "sourceId"] }),
  askQuestion:          Object.freeze({ required: ["questionId", "sourceType", "sourceId", "text"], optional: ["date"] }),
  recordAnswer:         Object.freeze({ required: ["answerId", "questionId", "text"], optional: [] }),
  consumeAnswer:        Object.freeze({ required: ["answerId", "consumer"], optional: [] }),
  registerDocument:     Object.freeze({ required: ["documentId", "name", "storageRef"], optional: ["mime", "size", "sourceType", "sourceId"] }),
  recordDocumentParse:  Object.freeze({ required: ["documentId", "outcome"], optional: ["error", "textRef"] }),
  createJob:            Object.freeze({ required: ["jobId", "kind", "sourceType", "sourceId", "executor"], optional: [] }),
  recordJobReturn:      Object.freeze({ required: ["jobId", "outcome"], optional: ["resultRef", "error"] }),
  acquireLease:         Object.freeze({ required: ["holder", "ttlMs"], optional: [] }),
  releaseLease:         Object.freeze({ required: ["holder"], optional: [] }),
  carryOverRefs:        Object.freeze({ required: ["fromDate", "toDate"], optional: [] }),
  closeRun:             Object.freeze({ required: ["date", "finalNoteId"], optional: [] }),
  invalidateClosure:    Object.freeze({ required: ["date", "correctionId", "reason", "contradiction"], optional: [] }),
});

export function validateCommandShape(command) {
  const fehler = [];
  if (!command || typeof command !== "object") return { ok: false, errors: ["COMMAND_SHAPE"] };
  const schema = COMMAND_SCHEMAS[command.type];
  if (!schema) return { ok: false, errors: ["COMMAND_UNKNOWN"] };
  if (typeof command.commandId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(command.commandId)) fehler.push("COMMAND_ID");
  if (typeof command.now !== "number" || !Number.isFinite(command.now)) fehler.push("COMMAND_NOW");
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, errors: [...fehler, "COMMAND_PAYLOAD"] };
  const erlaubt = new Set([...schema.required, ...schema.optional]);
  for (const k of schema.required) if (!(k in payload)) fehler.push("PAYLOAD_MISSING:" + k);
  for (const k of Object.keys(payload)) if (!erlaubt.has(k)) fehler.push("PAYLOAD_UNKNOWN:" + k);
  const schutz = findeSchutzfelder(payload);
  for (const p of schutz) fehler.push("PAYLOAD_PROTECTED:" + p);
  return { ok: fehler.length === 0, errors: fehler };
}

/* ── Leere Huellen ─────────────────────────────────────────────────────── */
export function leererRun(date, policyVersion) {
  return {
    id: "run_" + date,
    date,
    timezone: "Europe/Zurich",
    revision: 0,
    policyVersion: policyVersion || null,
    phase: "created",
    slotReceipts: { briefing04: null, process09: null, continue14: null, close23: null },
    startNoteId: null,
    finalNoteId: null,
    closureRevision: null,
    closureCutoff: null,
    itemRefs: [],
    sourceChecks: {},
    finalAt: null,
    invalidatedAt: null,
    archiveRef: null,
    corrections: [],
    createdAt: null,
    updatedAt: null,
  };
}

export function leereAutomation() {
  return {
    schemaVersion: SCHEMA_VERSION,
    dataRevision: 0,
    intakeById: {},
    questionsById: {},
    answersById: {},
    documentsById: {},
    jobsById: {},
    outboxById: {},
    idempotencyByKey: {},
    activeLease: null,
    sourceCursors: {},
    policyRef: null,
    progressById: {},
    waitingById: {},
    migration: null,
  };
}

export const ID_MUSTER = /^[A-Za-z0-9_.:-]{1,120}$/;
export function pruefeId(id, name = "id") {
  if (typeof id !== "string" || !ID_MUSTER.test(id)) throw new TypeError(`${name}: unzulaessige Kennung`);
  return id;
}

export function sourceKey(sourceType, sourceId) {
  if (!SOURCE_TYPES.includes(sourceType)) throw new RangeError(`unbekannter sourceType ${sourceType}`);
  return `${sourceType}:${pruefeId(sourceId, "sourceId")}`;
}
