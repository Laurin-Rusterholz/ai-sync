/* ══ Quantus v3 — C2: der öffentliche Befehlsumschlag ═════════════════════
 *
 * Der Umschlag ist die einzige Form, in der ein Befehl hereinkommt. Aus dem
 * Konzept (PDF S. 9), wörtlich:
 *
 *   {
 *     schemaVersion: 3,
 *     verb: "lead.comment",
 *     jobId: "job_20260920_42",
 *     expectedEntityVersion: 17,
 *     payload: { leadId: "lead_123", text: "...", evidenceRefs: ["artifact_456"] }
 *   }
 *
 * mit den Kopfzeilen `Authorization: Bearer <Laufzeit-Zugangsdatum>`,
 * `Content-Type: application/json` und `Idempotency-Key`.
 *
 * DREI REGELN, DIE DIESE DATEI DURCHSETZT
 * ---------------------------------------
 * 1. GESCHLOSSEN, AUCH VERSCHACHTELT. Jedes Feld — im Umschlag wie im
 *    Nutzinhalt jedes Fachverbs — steht in einer Liste. Ein unbekanntes Feld
 *    ist ein Fehler, kein „wird halt ignoriert". Sonst wandert irgendwann ein
 *    Feld mit, das ein späterer Umbau plötzlich auswertet.
 * 2. NICHTS AUS DEM KÖRPER, WAS DER SERVER BESTIMMT. `now`, `requestId`,
 *    `actor`, `tenant`, Rollen, Rechte, Policy: wer sie mitschickt, bekommt
 *    eine Absage — nicht ein stilles Überschreiben.
 * 3. KEINE PFADE. Jede Id ist eine Id (`[A-Za-z0-9_-]`, kein `/`, kein `.`,
 *    kein `__`), damit aus einem Befehl nie ein Firebase-Pfad, ein Blob-Key
 *    oder ein Wurzel-Patch werden kann. Felder wie `path`, `patch`, `op`,
 *    `$set` existieren nicht und werden beim Namen abgewiesen.
 *
 * Diese Datei enthält KEINE Fachlogik: sie sagt, welche Felder ein Verb hat
 * und welches Objekt dafür autorisiert werden muss — nicht, was das Verb
 * bewirkt. Das bewirkt der Domänen-Adapter (siehe quantus-v3-service.mjs);
 * fehlt er, antwortet der Dienst 503 statt irgendetwas zu tun.
 * ═══════════════════════════════════════════════════════════════════════ */

import { authError, authOk, COMMAND_MAX_BYTES, IDENTITY_FIELDS } from "./quantus-v3-auth.mjs";

export const COMMAND_SCHEMA_VERSION = 3;

/* Der Umschlag selbst — genau diese fünf Felder. */
export const ENVELOPE_FIELDS = Object.freeze(["schemaVersion", "verb", "jobId", "expectedEntityVersion", "payload"]);

/* Felder, die der Server bestimmt und die im Körper nichts zu suchen haben.
   IDENTITY_FIELDS (Rolle, Mandant, Principal …) kommen aus dem Auth-Modul. */
export const SERVER_CONTROLLED_FIELDS = Object.freeze([
  "now", "serverNow", "timestamp", "requestId", "actor", "actorId", "user",
  "idempotencyKey", "dataRevision", "entityVersions", "policy", "policyVersion",
  "replayed", "ok",
]);

/* Feldnamen, die nach Pfad, Patch oder Datenbankbefehl riechen. */
export const FORBIDDEN_SHAPE_FIELDS = Object.freeze([
  "path", "paths", "key", "keys", "blobKey", "ref", "refPath", "patch", "ops", "op",
  "$set", "$unset", "update", "set", "root", "entities", "automation", "__proto__",
  "prototype", "constructor",
]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/* Eine Id ist eine Id. Zusätzlich zum Alphabet fällt `__` durch: das ist der
   Segmenttrenner der Blob-Schlüssel (blob-key-policy.mjs), und eine Id, die
   wie ein Schlüssel aussieht, soll gar nicht erst entstehen. Dieselbe Regel
   gilt für Cursor-Scopes. */
function isSafeId(value) {
  return typeof value === "string" && ID_PATTERN.test(value) && !value.includes("__");
}
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/* ── Feldtypen: klein, streng, ohne Umwandlung ──────────────────────────── */
const id = ({ optional = false } = {}) => ({ kind: "id", optional });
const text = (max, { optional = false } = {}) => ({ kind: "text", max, optional });
const ids = (max, { optional = false } = {}) => ({ kind: "ids", max, optional });
const list = (max, item, { optional = false } = {}) => ({ kind: "list", max, item, optional });
const enumOf = (values, { optional = false } = {}) => ({ kind: "enum", values, optional });
const iso = ({ optional = false } = {}) => ({ kind: "iso", optional });
const day = ({ optional = false } = {}) => ({ kind: "day", optional });
const int = (min, max, { optional = false } = {}) => ({ kind: "int", min, max, optional });

/*
 * Die Fachverben. Für jedes:
 *   fields  geschlossenes Schema des Nutzinhalts
 *   target  welches Objekt autorisiert wird: Art und das Payload-Feld mit
 *           seiner Id (`null` ⇒ der Lauf aus `jobId`)
 *
 * Die Verben sind dieselben wie in der C1-Matrix; `context.read` fehlt hier,
 * weil Lesen über benannte Abfragen läuft, nicht über den Befehlsweg.
 */
export const COMMAND_VERBS = Object.freeze({
  "intake.create": {
    target: { kind: "run", idField: null },
    fields: { source: enumOf(["mail", "manual", "document", "system"]), title: text(200), text: text(8000, { optional: true }), evidenceRefs: ids(20, { optional: true }) },
  },
  "intake.accept": {
    target: { kind: "intake", idField: "intakeId" },
    fields: { intakeId: id(), leadId: id({ optional: true }) },
  },
  "task.create": {
    target: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), title: text(200), dueAt: iso({ optional: true }), notes: text(2000, { optional: true }) },
  },
  "lead.comment": {
    target: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), text: text(8000), evidenceRefs: ids(20, { optional: true }) },
  },
  "lead.transition": {
    target: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), toState: text(64), reason: text(1000, { optional: true }), evidenceRefs: ids(20, { optional: true }) },
  },
  "lead.schedule": {
    target: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), waitUntil: iso(), reason: text(1000, { optional: true }) },
  },
  "briefing.answer": {
    target: { kind: "briefing", idField: "briefingId" },
    fields: { briefingId: id(), questionId: id(), answer: text(8000), decision: enumOf(["yes", "no", "later", "custom"], { optional: true }) },
  },
  "briefing.consumeAnswer": {
    target: { kind: "briefing_answer", idField: "answerId" },
    fields: { briefingId: id(), answerId: id() },
  },
  "question.create": {
    target: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), text: text(2000), options: list(8, text(200), { optional: true }) },
  },
  "question.resolve": {
    target: { kind: "question", idField: "questionId" },
    fields: { questionId: id(), answer: text(2000) },
  },
  "document.register": {
    target: { kind: "document", idField: "documentId" },
    fields: { documentId: id(), title: text(200), sourceRef: id({ optional: true }) },
  },
  "document.processed": {
    target: { kind: "document", idField: "documentId" },
    fields: { documentId: id(), extractionRef: id(), summary: text(4000, { optional: true }) },
  },
  "worker.assign": {
    target: { kind: "run", idField: null },
    // `workerKind` ist die Art des Spezialisten, KEINE Rollenbehauptung: die
    // Rechte des Aufrufers hängen weiter ausschliesslich an seinem Ausweis.
    fields: { assignmentId: id(), workerKind: enumOf(["claude", "gemini"]), contextRef: id(), dueAt: iso({ optional: true }) },
  },
  "worker.return": {
    target: { kind: "assignment", idField: "assignmentId" },
    fields: { assignmentId: id(), resultRef: id(), summary: text(8000), evidenceRefs: ids(20, { optional: true }) },
  },
  "worker.review": {
    target: { kind: "worker_result", idField: "resultId" },
    fields: { resultId: id(), verdict: enumOf(["accepted", "rejected", "revise"]), notes: text(4000, { optional: true }) },
  },
  "run.ensure": {
    target: { kind: "run", idField: null },
    fields: { slot: enumOf(["04:00", "09:00", "14:00", "23:00"]), date: day() },
  },
  "run.claim": {
    target: { kind: "run", idField: null },
    fields: { leaseSeconds: int(1, 900) },
  },
  "run.renew": {
    target: { kind: "run", idField: null },
    fields: { leaseSeconds: int(1, 900) },
  },
  "run.checkpoint": {
    target: { kind: "run", idField: null },
    fields: { stage: text(64), note: text(2000, { optional: true }) },
  },
  "run.finalize": {
    target: { kind: "run", idField: null },
    fields: { outcome: enumOf(["complete", "partial", "failed"]), summaryRef: id({ optional: true }) },
  },
  "note.append": {
    target: { kind: "run", idField: null },
    // `noteScope` heisst bewusst nicht `scope`: `scope` ist ein Feldname, mit
    // dem sonst Rechte behauptet werden, und wird deshalb generell abgewiesen.
    fields: { noteId: id(), text: text(8000), noteScope: enumOf(["run", "lead"]), leadId: id({ optional: true }) },
  },
  "run.log": {
    target: { kind: "run", idField: null },
    fields: { event: text(64), detail: text(2000, { optional: true }) },
  },
});

export const COMMAND_VERB_NAMES = Object.freeze(Object.keys(COMMAND_VERBS));

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function forbiddenFieldName(key) {
  return FORBIDDEN_SHAPE_FIELDS.includes(key)
    || SERVER_CONTROLLED_FIELDS.includes(key)
    || IDENTITY_FIELDS.includes(key);
}

function checkField(spec, value, feld) {
  switch (spec.kind) {
    case "id":
      if (!isSafeId(value)) return `field_invalid:${feld}`;
      return null;
    case "text":
      if (typeof value !== "string" || !value.length || value.length > spec.max) return `field_invalid:${feld}`;
      // Steuerzeichen (ausser Zeilenumbruch und Tabulator) gehören nicht in Text.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return `field_invalid:${feld}`;
      return null;
    case "ids":
      if (!Array.isArray(value) || value.length > spec.max) return `field_invalid:${feld}`;
      for (const entry of value) if (!isSafeId(entry)) return `field_invalid:${feld}`;
      return null;
    case "list":
      if (!Array.isArray(value) || value.length > spec.max) return `field_invalid:${feld}`;
      for (const entry of value) {
        const fehler = checkField(spec.item, entry, feld);
        if (fehler) return fehler;
      }
      return null;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) return `field_invalid:${feld}`;
      return null;
    case "iso":
      if (typeof value !== "string" || !ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return `field_invalid:${feld}`;
      return null;
    case "day":
      if (typeof value !== "string" || !DATE_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return `field_invalid:${feld}`;
      return null;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) return `field_invalid:${feld}`;
      return null;
    default:
      return `field_invalid:${feld}`;
  }
}

/*
 * Prüft den Umschlag. Rückgabe: { ok: true, command } oder eine Absage.
 * `command` ist eine NEU gebaute, eingefrorene Kopie — nur bekannte Felder,
 * in bekannter Form. Was hereinkam, wird nicht weitergereicht.
 */
export function parseCommandEnvelope(value, { maxBytes = COMMAND_MAX_BYTES } = {}) {
  if (!isPlainObject(value)) return authError("invalid_request", "envelope_not_an_object");

  const unbekannt = Object.keys(value).filter((k) => !ENVELOPE_FIELDS.includes(k));
  if (unbekannt.length) return authError("invalid_request", "envelope_unknown_field");

  if (value.schemaVersion !== COMMAND_SCHEMA_VERSION) return authError("invalid_request", "schema_version_unsupported");

  const verb = value.verb;
  if (typeof verb !== "string" || !Object.prototype.hasOwnProperty.call(COMMAND_VERBS, verb)) {
    return authError("forbidden", "unknown_verb");
  }
  const descriptor = COMMAND_VERBS[verb];

  const jobId = value.jobId;
  if (!isSafeId(jobId)) return authError("invalid_request", "job_id_invalid");

  const expected = value.expectedEntityVersion;
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0 || expected > Number.MAX_SAFE_INTEGER) {
    return authError("invalid_request", "expected_entity_version_invalid");
  }

  const payload = value.payload;
  if (!isPlainObject(payload)) return authError("invalid_request", "payload_not_an_object");

  // Geschlossen: kein unbekanntes Feld, kein serverbestimmtes Feld, kein
  // Pfad-/Patch-Name — auch nicht verschachtelt.
  const tiefeFehler = scanForbiddenNested(payload, 0);
  if (tiefeFehler) return authError("invalid_request", tiefeFehler);

  const bekannt = Object.keys(descriptor.fields);
  for (const key of Object.keys(payload)) {
    if (!bekannt.includes(key)) return authError("invalid_request", "payload_unknown_field");
  }

  const sauber = {};
  for (const [feld, spec] of Object.entries(descriptor.fields)) {
    const vorhanden = Object.prototype.hasOwnProperty.call(payload, feld);
    if (!vorhanden) {
      if (spec.optional) continue;
      return authError("invalid_request", `field_missing:${feld}`);
    }
    const wert = payload[feld];
    if (wert === undefined) return authError("invalid_request", `field_invalid:${feld}`);
    const fehler = checkField(spec, wert, feld);
    if (fehler) return authError("invalid_request", fehler);
    sauber[feld] = Array.isArray(wert) ? Object.freeze([...wert]) : wert;
  }

  const command = Object.freeze({
    schemaVersion: COMMAND_SCHEMA_VERSION,
    verb,
    jobId,
    expectedEntityVersion: expected,
    payload: Object.freeze(sauber),
  });

  const bytes = Buffer.byteLength(JSON.stringify(command), "utf8");
  if (bytes > maxBytes) return authError("payload_too_large", "command_too_large");

  return authOk({ command, descriptor: Object.freeze({ ...descriptor.target, verb }) });
}

/* Verschachtelte Suche nach verbotenen Feldnamen und zu tiefen Strukturen.
   Ein Nutzinhalt ist flach gedacht; drei Ebenen sind mehr als genug. */
function scanForbiddenNested(value, tiefe) {
  if (tiefe > 3) return "payload_too_deep";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const fehler = scanForbiddenNested(entry, tiefe + 1);
      if (fehler) return fehler;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (!isPlainObject(value)) return "payload_unknown_field";
  for (const key of Object.keys(value)) {
    if (forbiddenFieldName(key)) return "payload_forbidden_field";
    const fehler = scanForbiddenNested(value[key], tiefe + 1);
    if (fehler) return fehler;
  }
  return null;
}

/* Der Idempotenz-Schlüssel kommt aus der Kopfzeile, nie aus dem Körper. */
export function parseIdempotencyKey(headerValue) {
  const raw = String(headerValue == null ? "" : headerValue).trim();
  if (!raw) return authError("invalid_request", "idempotency_key_missing");
  if (raw.length > 200) return authError("invalid_request", "idempotency_key_invalid");
  if (!/^[A-Za-z0-9_.:-]+$/.test(raw)) return authError("invalid_request", "idempotency_key_invalid");
  return authOk({ idempotencyKey: raw });
}

export default {
  parseCommandEnvelope, parseIdempotencyKey,
  COMMAND_VERBS, COMMAND_VERB_NAMES, ENVELOPE_FIELDS, COMMAND_SCHEMA_VERSION,
};
