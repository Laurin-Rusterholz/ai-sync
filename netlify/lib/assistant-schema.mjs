/* ══ Tagesbriefing v3 — Schema, Zustandsmodell, Policy, Schutzfelder ═══════
 *
 * Die EINE Quelle fuer:
 *   · die Form von dailyBriefing.assistantRuns[YYYY-MM-DD] und data.automation
 *   · das einzige Zustandsmodell (operationalState) mit Versionszaehler,
 *     erlaubten Uebergaengen und expliziten Rollen
 *   · die einmalige, versionierte Abbildung der Altstatus — danach ist
 *     operationalState FUEHREND, der Altstatus nur noch eine Ableitung
 *   · die Policy mit festen Sicherheitsvorgaben (23:00, 09+23, 15 Minuten,
 *     Quantus-Kernquelle) — eine Policy ist vollstaendig oder unbrauchbar
 *   · Schutzfelder, Command-Schemas und die Rolle, die ein Kommando
 *     ausfuehren darf (Agent, Nutzer, Adapter, Worker)
 *
 * Keine zweite Aufgaben- oder Statusdatenbank: die Arbeit lebt in
 * entities.chatgptLeads / chatgptTasks / tasks. Der Kern haelt an diesen
 * Objekten den fuehrenden Zustand (operationalState, operationalStateVersion,
 * operationalRoles, operationalStateSource) und daneben nur Buchhaltung.
 *
 * Dieses Modul ist reines JavaScript ohne Node-Abhaengigkeiten; es kann
 * unveraendert im Browser laufen.
 * ═════════════════════════════════════════════════════════════════════════ */

export const SCHEMA_VERSION = 3;
export const POLICY_SCHEMA = "tagesbriefing-policy/3";
export const STATE_MODEL_VERSION = "state-model/3";

export const OPERATIONAL_STATES = Object.freeze([
  "doing", "waiting_external", "waiting_user", "delegated", "review", "done", "cancelled",
]);
export const OFFENE_ZUSTAENDE = Object.freeze(["doing", "waiting_external", "waiting_user", "delegated", "review"]);
export const WARTE_ZUSTAENDE = Object.freeze(["waiting_external", "waiting_user", "delegated"]);
export const ABGESCHLOSSENE_ZUSTAENDE = Object.freeze(["done", "cancelled"]);

/* Erlaubte Uebergaenge ueber transitionState. Wartezustaende werden NUR ueber
 * setWaiting betreten (mit Beleg); von dort geht es nach doing (Warten
 * beendet) oder review (Rueckgabe gesichtet). Ein Abgeschlossenes wird nur
 * mit Grund wieder geoeffnet. */
export const TRANSITIONS = Object.freeze({
  doing:            Object.freeze(["review", "done", "cancelled"]),
  waiting_external: Object.freeze(["doing", "review", "cancelled"]),
  waiting_user:     Object.freeze(["doing", "review", "cancelled"]),
  delegated:        Object.freeze(["doing", "review", "cancelled"]),
  review:           Object.freeze(["doing", "done", "cancelled"]),
  done:             Object.freeze(["doing"]),
  cancelled:        Object.freeze(["doing"]),
});

export const RUN_PHASES = Object.freeze(["created", "active", "final", "exception_open"]);
export const EXECUTORS = Object.freeze(["openai", "claude", "gemini", "user", "external"]);
export const ACCOUNTABLES = Object.freeze(["chatgpt", "user"]);

export const SOURCE_TYPES = Object.freeze(["chatgptLead", "chatgptTask", "task", "project", "intake", "question", "document", "job", "evidence"]);

/* Sammlungen im Bestand, aus denen Arbeit stammt. Projekte tragen nur
 * Fristen (deadlines) bei. */
export const QUELLEN = Object.freeze({
  chatgptLead: Object.freeze({ store: "chatgptLeads", statusField: "status", legacyClosed: Object.freeze(["abgeschlossen"]) }),
  chatgptTask: Object.freeze({ store: "chatgptTasks", statusField: "state", legacyClosed: Object.freeze(["erledigt"]) }),
  task: Object.freeze({ store: "tasks", statusField: "status", legacyClosed: Object.freeze(["done"]) }),
});

/* Zustaende der Buchhaltungskarten — alles andere ist ein Fehler, den die
 * Ampel rot meldet (nie stillschweigend uebersprungen). */
export const KARTEN_ZUSTAENDE = Object.freeze({
  intake: Object.freeze(["open", "done", "cancelled"]),
  question: Object.freeze(["open", "answered", "withdrawn"]),
  document: Object.freeze(["open", "done", "cancelled"]),
  job: Object.freeze(["queued", "running", "returned", "failed", "cancelled", "expired"]),
});

/* ── Einmalige Abbildung der Altstatus (nur in der Migration) ───────────
 * Konservativ: was nicht eindeutig ist, wird NICHT geraten. "wartet" und
 * "waiting" tragen keine Gegenpartei und keinen Beleg — sie sind mehrdeutig
 * und bleiben als Migrationskonflikt sichtbar (operationalState null,
 * operationalStateUnmapped "ambiguous"), bis ein Kommando mit Beleg den
 * Zustand setzt. Unbekannte Werte ebenso ("unknown"). */
export function mapChatgptLead(l) {
  const status = l && typeof l.status === "string" ? l.status : null;
  const bekannt = ["neu", "verstanden", "in_arbeit", "wartet", "abgeschlossen"];
  if (!bekannt.includes(status)) return unmapped("status", status, "unknown");
  if (status === "abgeschlossen") {
    if (l.closedBy === "laurin" && (l.obsoleteReason || l.obsolete)) return mapped("cancelled", "status", status, "hinfaellig durch Laurin");
    return mapped("done", "status", status);
  }
  if (l.assignee === "cowork" && l.handoverAt && !l.returnedAt) return mapped("delegated", "status", status, "Cowork-Paket unterwegs (Altbestand, ohne Job-Beleg)");
  if (l.assignee === "cowork" && l.returnedAt) return mapped("review", "status", status, "Cowork-Rueckgabe liegt vor (Altbestand)");
  if (status === "wartet") return unmapped("status", status, "ambiguous");
  return mapped("doing", "status", status);
}

export function mapChatgptTask(t) {
  const state = t && typeof t.state === "string" ? t.state : null;
  if (!["offen", "erledigt", "wartet"].includes(state)) return unmapped("state", state, "unknown");
  if (state === "erledigt") return mapped("done", "state", state);
  if (state === "wartet") return unmapped("state", state, "ambiguous");
  return mapped("doing", "state", state);
}

export function mapTask(t) {
  const status = t && typeof t.status === "string" ? t.status : null;
  const tabelle = { todo: "doing", doing: "doing", review: "review", done: "done" };
  if (status === "waiting") return unmapped("status", status, "ambiguous");
  if (!Object.prototype.hasOwnProperty.call(tabelle, status)) return unmapped("status", status, "unknown");
  return mapped(tabelle[status], "status", status);
}

function mapped(operationalState, legacyField, legacyValue, note = null) {
  return { operationalState, legacyField, legacyValue, unmapped: false, reason: null, note };
}
function unmapped(legacyField, legacyValue, reason) {
  return { operationalState: null, legacyField, legacyValue: legacyValue == null ? null : String(legacyValue), unmapped: true, reason, note: reason === "ambiguous" ? "mehrdeutiger Altstatus ohne Gegenpartei/Beleg" : "unbekannter Altstatus" };
}

export const MAPPER = Object.freeze({ chatgptLead: mapChatgptLead, chatgptTask: mapChatgptTask, task: mapTask });

/* Rollen werden in der Migration EINMAL explizit abgeleitet und am Objekt
 * gespeichert (operationalRoles). Danach zaehlt nur das gespeicherte Feld;
 * der Altwert assignee bleibt unangetastet (regulaere Aufgaben behalten
 * ihren menschlichen Assignee, er wird nie in einen Modellnamen umbenannt). */
export function rollenAbleiten(sourceType, entity) {
  if (sourceType === "chatgptLead") {
    const executor = entity?.assignee === "cowork" ? "claude" : entity?.assignee === "chatgpt" ? "openai" : null;
    return { accountable: "chatgpt", executor };
  }
  if (sourceType === "chatgptTask") return { accountable: "chatgpt", executor: "openai" };
  return { accountable: "user", executor: "user" };
}

export function rollenFuer(sourceType, entity) {
  const r = entity && entity.operationalRoles;
  if (r && typeof r === "object" && ACCOUNTABLES.includes(r.accountable) && (r.executor === null || EXECUTORS.includes(r.executor))) {
    return { accountable: r.accountable, executor: r.executor, explicit: true };
  }
  return { ...rollenAbleiten(sourceType, entity), explicit: false };
}

/* Der wirksame Zustand einer Entitaet.
 *
 * NACH der Migration ist operationalState fuehrend. Ein spaeter vom Client
 * geaenderter Altstatus aendert den Serverzustand NICHT — er wird als Drift
 * sichtbar (drift: { legacyNow, legacyAtMapping, expected }) und in der
 * Ampel rot gemeldet, bis ein Kommando den Zustand setzt. Ein Altstatus
 * "abgeschlossen" kann so nie ein done vortaeuschen.
 *
 * VOR der Migration (kein operationalStateSource) gibt es keinen
 * verlaesslichen Zustand: unmigrated: true, die Ampel meldet NOT_MIGRATED. */
export function effektiverZustand(sourceType, entity) {
  const q = QUELLEN[sourceType];
  if (!q) throw new RangeError(`effektiverZustand: unbekannter sourceType ${sourceType}`);
  const e = entity || {};
  const src = e.operationalStateSource && typeof e.operationalStateSource === "object" ? e.operationalStateSource : null;
  const legacyNow = typeof e[q.statusField] === "string" ? e[q.statusField] : null;
  if (!src) {
    return { state: null, version: 0, unmigrated: true, unmapped: false, reason: null, drift: null, legacyNow, versionInvalid: true };
  }
  const state = typeof e.operationalState === "string" && OPERATIONAL_STATES.includes(e.operationalState) ? e.operationalState : null;
  const unmapped = state === null;
  const version = Number.isInteger(e.operationalStateVersion) && e.operationalStateVersion > 0 ? e.operationalStateVersion : 0;
  const erwartet = legacyFuer(sourceType, state, e, src);
  const drift = legacyNow !== erwartet && legacyNow !== src.legacyValue ? { legacyNow, legacyAtMapping: src.legacyValue, expected: erwartet } : null;
  // Ein abgeschlossener Zustand ist entweder aus der Migration (Altstatus war
  // damals abgeschlossen, seither kein Kommando) oder traegt den
  // Abschlussbeleg des Kommandos (source.closure). Alles andere ist eine
  // unbelegte Behauptung.
  const geschlossen = ABGESCHLOSSENE_ZUSTAENDE.includes(state);
  const ausMigration = !src.changedAt && q.legacyClosed.includes(src.legacyValue);
  const unproven = geschlossen && !ausMigration && !(src.closure && typeof src.closure === "object");
  return {
    state, version, unmigrated: false, unmapped,
    reason: unmapped ? (e.operationalStateUnmapped === "unknown" ? "unknown" : "ambiguous") : null,
    drift, legacyNow, versionInvalid: version === 0, unproven,
  };
}

/* Die lesbare Ableitung: welcher Altstatus zum Serverzustand gehoert.
 * Wird in diesem Paket NICHT zurueckgeschrieben (keine Client-Aenderungen);
 * sie dient der Drift-Erkennung und spaeteren Ansichten. */
export function legacyFuer(sourceType, state, entity, src) {
  if (state === null) return src ? src.legacyValue : null;
  if (sourceType === "chatgptLead") {
    if (state === "done" || state === "cancelled") return "abgeschlossen";
    if (WARTE_ZUSTAENDE.includes(state)) return "wartet";
    if (state === "review") return src && ["in_arbeit", "wartet"].includes(src.legacyValue) ? src.legacyValue : "in_arbeit";
    return src && ["neu", "verstanden", "in_arbeit"].includes(src.legacyValue) ? src.legacyValue : "in_arbeit";
  }
  if (sourceType === "chatgptTask") {
    if (state === "done" || state === "cancelled") return "erledigt";
    if (WARTE_ZUSTAENDE.includes(state)) return "wartet";
    return "offen";
  }
  if (state === "done" || state === "cancelled") return "done";
  if (WARTE_ZUSTAENDE.includes(state)) return "waiting";
  if (state === "review") return "review";
  return src && ["todo", "doing"].includes(src.legacyValue) ? src.legacyValue : "doing";
}

/* ── Policy mit festen Sicherheitsvorgaben ──────────────────────────────
 * Diese Grenzen sind nicht konfigurierbar; eine Policy, die sie lockert,
 * ist ungueltig:
 *   · Abschluss fruehestens 23:00 Ortszeit (23:00–23:59)
 *   · Quittungen process09 UND close23 zwingend
 *   · Quellen hoechstens 15 Minuten alt
 *   · eine Quelle der Art "quantus-core" (der Bestand selbst) ist immer
 *     Pflicht; noExternalSources verzichtet nur auf EXTERNE Quellen */
export const POLICY_LIMITS = Object.freeze({
  sourceMaxAgeMinutesMax: 15,
  evaluationTtlMinutesMax: 15,
  deferralLimitMax: 3,
  maxWaitDaysMax: 30,
  earliestClosureLocalTime: "23:00",
  requiredReceipts: Object.freeze(["process09", "close23"]),
  coreSourceKind: "quantus-core",
});
export const FEATURE_FLAG_MODES = Object.freeze(["dry_run", "live"]);
export const SLOT_NAMEN = Object.freeze(["briefing04", "process09", "continue14", "close23"]);

export const POLICY_TEMPLATE = Object.freeze({
  schema: POLICY_SCHEMA,
  version: "3.0",
  tenant: "quantus",
  timezone: "Europe/Zurich",
  sourceMaxAgeMinutes: 15,
  evaluationTtlMinutes: 15,
  deferralLimit: 3,
  maxWaitDays: 30,
  requiredSources: [],          // mindestens { id, kind: "quantus-core" }; extern z. B. { id: "gmail-inbox", kind: "mail" }
  noExternalSources: false,
  closure: Object.freeze({ earliestLocalTime: "23:00", requiredReceipts: ["process09", "close23"] }),
  featureFlags: Object.freeze({ writes: "dry_run", runner: "dry_run", providers: "dry_run" }),
});

export function validatePolicy(policy) {
  const fehler = [];
  const p = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : null;
  if (!p) return { ok: false, errors: ["POLICY_MISSING"] };
  if (p.schema !== POLICY_SCHEMA) fehler.push("POLICY_SCHEMA");
  if (typeof p.version !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(p.version)) fehler.push("POLICY_VERSION");
  if (typeof p.tenant !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.tenant)) fehler.push("POLICY_TENANT");
  if (p.timezone !== "Europe/Zurich") fehler.push("POLICY_TIMEZONE");
  const ganz = (k, max) => {
    const name = "POLICY_" + k.replace(/([A-Z])/g, "_$1").toUpperCase();
    if (!(Number.isInteger(p[k]) && p[k] > 0)) fehler.push(name);
    else if (p[k] > max) fehler.push(name + "_ABOVE_LIMIT");
  };
  ganz("sourceMaxAgeMinutes", POLICY_LIMITS.sourceMaxAgeMinutesMax);
  ganz("evaluationTtlMinutes", POLICY_LIMITS.evaluationTtlMinutesMax);
  ganz("deferralLimit", POLICY_LIMITS.deferralLimitMax);
  ganz("maxWaitDays", POLICY_LIMITS.maxWaitDaysMax);
  if (!Array.isArray(p.requiredSources)) fehler.push("POLICY_REQUIRED_SOURCES");
  else {
    const ids = new Set();
    let kern = 0, extern = 0;
    for (const s of p.requiredSources) {
      if (!s || typeof s.id !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(s.id) || typeof s.kind !== "string" || !s.kind) { fehler.push("POLICY_SOURCE_SHAPE"); break; }
      if (ids.has(s.id)) { fehler.push("POLICY_SOURCE_DUPLICATE"); break; }
      ids.add(s.id);
      if (s.kind === POLICY_LIMITS.coreSourceKind) kern++; else extern++;
    }
    if (kern !== 1) fehler.push("POLICY_CORE_SOURCE_REQUIRED");
    if (extern === 0 && p.noExternalSources !== true) fehler.push("POLICY_SOURCES_NOT_CONFIGURED");
    if (extern > 0 && p.noExternalSources === true) fehler.push("POLICY_NO_EXTERNAL_CONTRADICTS_SOURCES");
  }
  const c = p.closure;
  if (!c || typeof c !== "object") fehler.push("POLICY_CLOSURE");
  else {
    const t = String(c.earliestLocalTime || "");
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fehler.push("POLICY_CLOSURE_TIME_INVALID");
    else if (t < POLICY_LIMITS.earliestClosureLocalTime) fehler.push("POLICY_CLOSURE_TOO_EARLY");
    if (!Array.isArray(c.requiredReceipts) || !c.requiredReceipts.every((s) => SLOT_NAMEN.includes(s))) fehler.push("POLICY_CLOSURE_RECEIPTS_INVALID");
    else for (const s of POLICY_LIMITS.requiredReceipts) if (!c.requiredReceipts.includes(s)) fehler.push("POLICY_CLOSURE_RECEIPT_REQUIRED:" + s);
  }
  const f = p.featureFlags;
  if (!f || typeof f !== "object") fehler.push("POLICY_FEATURE_FLAGS");
  else for (const k of ["writes", "runner", "providers"]) if (!FEATURE_FLAG_MODES.includes(f[k])) fehler.push("POLICY_FLAG_" + k.toUpperCase());
  return { ok: fehler.length === 0, errors: fehler };
}

export function kernQuelleId(policy) {
  const s = (policy && Array.isArray(policy.requiredSources) ? policy.requiredSources : []).find((x) => x && x.kind === POLICY_LIMITS.coreSourceKind);
  return s ? s.id : null;
}

/* ── Schutzfelder ───────────────────────────────────────────────────────
 * Setzt ausschliesslich der Kern. Kein Kommando darf sie in beliebiger
 * Tiefe mitliefern. finalNoteId/startNoteId/correctionId sind Eingaben der
 * Kommandos closeRun/ensureStartNote/invalidateClosure, deren Handler alle
 * Voraussetzungen prueft — deshalb nicht in dieser Liste. */
export const PROTECTED_FIELDS = Object.freeze([
  "finalAt", "closureRevision", "closureCutoff", "closureOutcomes", "finalEvaluation", "phase",
  "invalidatedAt", "archiveRef", "overallGreen", "userApproval", "approved", "approvedBy",
  "operationalState", "operationalStateSource", "operationalStateVersion", "operationalStateUnmapped", "operationalRoles",
  "consumedAt", "answeredAt", "deferrals", "reviewedAt", "handledAt", "verifiedAt", "verifiedBy",
  "dataRevision", "revision", "evaluatedRevision", "validUntil", "coverage", "operations", "waitingSince",
  "idempotencyByKey", "activeLease",
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

/* ── Command-Schemas und Ausfuehrende ───────────────────────────────────
 * Jedes Kommando nennt seine Felder ausdruecklich; Unbekanntes ist ein
 * Fehler. "actors" sagt, welche Art Aufrufer es ausfuehren darf. Belege,
 * Dokumente, Parse-Ergebnisse und Job-Rueckgaben kommen NUR ueber
 * vertrauenswuerdige Backend-Adapter bzw. Worker; Antworten NUR vom Nutzer.
 * Der Dispatcher prueft ctx.actor — ohne Aufrufer laeuft nichts. */
export const ACTOR_KINDS = Object.freeze(["agent", "user", "adapter", "worker", "system"]);

export const COMMAND_SCHEMAS = Object.freeze({
  ensureRun:            Object.freeze({ required: ["date"], optional: [], actors: ["agent", "system"] }),
  ensureStartNote:      Object.freeze({ required: ["date", "noteId"], optional: ["title", "content"], actors: ["agent", "system"] }),
  recordSlotReceipt:    Object.freeze({ required: ["date", "slot", "receiptId"], optional: ["note"], actors: ["agent", "system"] }),
  recordSourceCheck:    Object.freeze({ required: ["date", "sourceId", "cursor", "outcome"], optional: ["detail"], actors: ["adapter", "system"] }),
  addItemRef:           Object.freeze({ required: ["date", "sourceType", "sourceId"], optional: ["carriedFrom"], actors: ["agent", "system"] }),
  carryOverRefs:        Object.freeze({ required: ["fromDate", "toDate"], optional: [], actors: ["agent", "system"] }),
  observeSource:        Object.freeze({ required: ["sourceType", "sourceId"], optional: [], actors: ["agent", "system"] }),
  setWaiting:           Object.freeze({ required: ["sourceType", "sourceId", "expectedVersion", "state", "counterparty", "nextAction", "followUpAt", "evidence"], optional: [], actors: ["agent"] }),
  transitionState:      Object.freeze({ required: ["sourceType", "sourceId", "state"], optional: ["expectedVersion", "reason", "evidence", "linkTo", "results"], actors: ["agent", "user"] }),
  registerIntake:       Object.freeze({ required: ["intakeId", "text", "channel"], optional: ["receivedAt", "sourceType", "sourceId"], actors: ["user", "adapter", "system"] }),
  askQuestion:          Object.freeze({ required: ["questionId", "sourceType", "sourceId", "text"], optional: ["date", "options"], actors: ["agent"] }),
  recordAnswer:         Object.freeze({ required: ["answerId", "questionId", "text"], optional: [], actors: ["user"] }),
  consumeAnswer:        Object.freeze({ required: ["answerId", "consumer"], optional: [], actors: ["agent", "system"] }),
  registerEvidence:     Object.freeze({ required: ["evidenceId", "kind", "ref", "sourceType", "sourceId", "origin", "observedAt", "fingerprint"], optional: ["summary"], actors: ["adapter"] }),
  registerDocument:     Object.freeze({ required: ["documentId", "attachmentId", "name", "hash", "mime", "size", "origin", "linkedTo"], optional: [], actors: ["adapter", "user"] }),
  recordDocumentParse:  Object.freeze({ required: ["documentId", "outcome"], optional: ["error", "textRef", "extractHash"], actors: ["adapter", "agent", "system"] }),
  createJob:            Object.freeze({ required: ["jobId", "kind", "purpose", "sourceType", "sourceId", "inputVersion", "executor", "contextRefs", "expiresAt"], optional: [], actors: ["agent", "system"] }),
  cancelJob:            Object.freeze({ required: ["jobId", "reason"], optional: [], actors: ["agent", "system", "user"] }),
  recordJobReturn:      Object.freeze({ required: ["jobId", "outcome"], optional: ["resultRef", "resultHash", "error"], actors: ["worker"] }),
  reviewJobResult:      Object.freeze({ required: ["jobId", "verdict", "reviewer"], optional: ["note"], actors: ["agent", "user"] }),
  closeRun:             Object.freeze({ required: ["date", "finalNoteId"], optional: [], actors: ["agent", "system"] }),
  invalidateClosure:    Object.freeze({ required: ["date", "correctionId", "reason", "contradiction"], optional: [], actors: ["agent", "system", "user"] }),
  // ── Erweiterung C3a: was die C2-Fachverben brauchen und B bisher nicht hatte ──
  createTask:           Object.freeze({ required: ["taskId", "title"], optional: ["dueDate", "notes", "linkedLeadId"], actors: ["user", "agent"] }),
  addComment:           Object.freeze({ required: ["sourceType", "sourceId", "commentId", "text"], optional: ["evidenceRefs"], actors: ["user", "agent"] }),
  appendRunNote:        Object.freeze({ required: ["date", "noteId", "text"], optional: ["linkedLeadId"], actors: ["user", "agent", "system"] }),
  recordRunEvent:       Object.freeze({ required: ["date", "eventId", "event"], optional: ["detail"], actors: ["agent", "system"] }),
  recordRunCheckpoint:  Object.freeze({ required: ["date", "checkpointId", "stage"], optional: ["note"], actors: ["agent", "system"] }),
});

export function validateCommandShape(command) {
  const fehler = [];
  if (!command || typeof command !== "object" || Array.isArray(command)) return { ok: false, errors: ["COMMAND_SHAPE"] };
  const schema = COMMAND_SCHEMAS[command.type];
  if (!schema) return { ok: false, errors: ["COMMAND_UNKNOWN"] };
  // Die Kennung ist informativ (Idempotenz lebt im Umschlag): dieselbe Form wie dessen requestId.
  if (typeof command.commandId !== "string" || !command.commandId.length || command.commandId.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(command.commandId)) fehler.push("COMMAND_ID");
  if (typeof command.now !== "number" || !Number.isFinite(command.now)) fehler.push("COMMAND_NOW");
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, errors: [...fehler, "COMMAND_PAYLOAD"] };
  const erlaubt = new Set([...schema.required, ...schema.optional]);
  for (const k of schema.required) if (!(k in payload)) fehler.push("PAYLOAD_MISSING:" + k);
  for (const k of Object.keys(payload)) if (!erlaubt.has(k)) fehler.push("PAYLOAD_UNKNOWN:" + k);
  for (const p of findeSchutzfelder(payload)) fehler.push("PAYLOAD_PROTECTED:" + p);
  return { ok: fehler.length === 0, errors: fehler };
}

export function validateActor(commandType, actor) {
  const schema = COMMAND_SCHEMAS[commandType];
  if (!schema) return { ok: false, errors: ["COMMAND_UNKNOWN"] };
  if (!actor || typeof actor !== "object" || !ACTOR_KINDS.includes(actor.kind) || typeof actor.id !== "string" || !actor.id) return { ok: false, errors: ["ACTOR_MISSING"] };
  if (!schema.actors.includes(actor.kind)) return { ok: false, errors: ["ACTOR_NOT_ALLOWED:" + actor.kind] };
  return { ok: true, errors: [] };
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
    idempotencyByKey: {},     // gehoert dem Transaktionsumschlag (quantus-v3-idempotency.mjs); der Kern liest und schreibt es NIE
    activeLease: null,        // gehoert Paket E1 (quantus-v3-runtime-state.mjs); der Kern liest und schreibt es NIE
    sourceCursors: {},
    policyRef: null,
    evidenceById: {},
    progressById: {},
    waitingById: {},
    migration: null,
  };
}

/* Pflichtsammlungen des Bestands: fehlen sie oder sind sie keine Karte,
 * ist der Bestand korrupt — fuer Mutation UND Ampel. NoteFlow (entities.notes)
 * ist keine Pflicht des Kerns und bleibt unberuehrt. */
export const PFLICHT_STORES = Object.freeze(["tasks", "projects", "chatgptLeads", "chatgptTasks", "chatgptNotes"]);

/* Karten, die requireCore als Objekt verlangt. */
export const AUTOMATION_KARTEN = Object.freeze([
  "intakeById", "questionsById", "answersById", "documentsById", "jobsById", "outboxById",
  "idempotencyByKey", "sourceCursors", "evidenceById", "progressById", "waitingById",
]);

export const ID_MUSTER = /^[A-Za-z0-9_.:-]{1,120}$/;
export function pruefeId(id, name = "id") {
  if (typeof id !== "string" || !ID_MUSTER.test(id)) throw new TypeError(`${name}: unzulaessige Kennung`);
  return id;
}

export function sourceKey(sourceType, sourceId) {
  if (!SOURCE_TYPES.includes(sourceType)) throw new RangeError(`unbekannter sourceType ${sourceType}`);
  return `${sourceType}:${pruefeId(sourceId, "sourceId")}`;
}

/* Browserfaehiger, deterministischer Fingerabdruck (cyrb53 vorwaerts und
 * rueckwaerts, 128 Bit hex) fuer Bestands-Fingerabdruecke — kein
 * node:crypto in der geteilten Logik. */
function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
/* Kanonisches JSON (Schluessel sortiert, undefined/Funktionen weggelassen,
 * nicht-endliche Zahlen als null) — fuer Signaturen ueber ganze Projektionen,
 * damit keine Handauswahl von Feldern etwas uebersehen kann. */
export function canonicalJson(value) {
  const seen = new Set();
  const visit = (v) => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
    if (typeof v !== "object") return "null";
    if (seen.has(v)) throw new TypeError("canonicalJson: zyklische Struktur");
    seen.add(v);
    let out;
    if (Array.isArray(v)) out = "[" + v.map((x) => (x === undefined ? "null" : visit(x))).join(",") + "]";
    else out = "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined && typeof v[k] !== "function").map((k) => JSON.stringify(k) + ":" + visit(v[k])).join(",") + "}";
    seen.delete(v);
    return out;
  };
  return visit(value);
}

export function stringFingerprint(str) {
  const s = String(str);
  let r = "";
  for (let i = s.length - 1; i >= 0; i--) r += s[i];
  return cyrb53(s, 0) + cyrb53(r, 0x9e3779b9);
}
