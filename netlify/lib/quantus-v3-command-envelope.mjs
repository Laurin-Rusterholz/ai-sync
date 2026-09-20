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
const hash = ({ optional = false } = {}) => ({ kind: "hash", optional });

/*
 * Die Fachverben. Für jedes:
 *   fields  geschlossenes Schema des Nutzinhalts
 *   target  welches Objekt autorisiert wird: Art und das Payload-Feld mit
 *           seiner Id (`null` ⇒ der Lauf aus `jobId`)
 *
 * Die Verben sind dieselben wie in der C1-Matrix; `context.read` fehlt hier,
 * weil Lesen über benannte Abfragen läuft, nicht über den Befehlsweg.
 */
/*
 * Die 22 Fachverben.
 *
 * Für jedes stehen drei Dinge fest:
 *   fields    geschlossenes Schema des Nutzinhalts
 *   resource  worauf das Verb WIRKT (bestimmt die Datenkategorie der
 *             Rechteprüfung). `idField: null` heisst: die Ressource entsteht
 *             erst — ein Anlegevorgang.
 *   anchor    woran die BINDUNG hängt (Mandant, Eigentum, Auftrag,
 *             Zuweisung). `{ self: true }` = die Ressource selbst,
 *             `idField: null` = der Lauf aus `jobId`.
 *
 * BEFUND (Review 33a4b3d): Beides war dasselbe Feld. Dadurch scheiterte jeder
 * Anlegevorgang („intake.create" prüfte die Kategorie des LAUFS gegen die
 * Rechte für „intake"), und die naheliegende Abhilfe — den Anker einfach
 * miterlauben — hätte die Rechte verbreitert. Jetzt sind es zwei Angaben.
 *
 * Die Nutzinhalte sind mit dem Kernvertrag abgeglichen: `lead.schedule` trägt
 * Gegenpartei, nächste Handlung, Nachfasszeitpunkt und Belege;
 * `document.register` Anhang, Inhaltsabdruck und Herkunft; die Worker-Verben
 * Quellversion, Ausführer und die erlaubten Kontext-Ids. Fehlt eines dieser
 * Felder, wird NICHTS erfunden — der Befehl wird abgewiesen.
 */
export const COMMAND_VERBS = Object.freeze({
  "intake.create": {
    resource: { kind: "intake", idField: null , creates: true},
    anchor: { kind: "run", idField: null },
    fields: { source: enumOf(["mail", "manual", "document", "system"]), title: text(200), text: text(8000, { optional: true }), evidenceRefs: ids(20, { optional: true }) },
  },
  "intake.accept": {
    resource: { kind: "intake", idField: "intakeId" },
    anchor: { self: true },
    fields: { intakeId: id(), leadId: id({ optional: true }) },
  },
  "task.create": {
    resource: { kind: "task", idField: null , creates: true},
    anchor: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), title: text(200), dueAt: iso({ optional: true }), notes: text(2000, { optional: true }) },
  },
  "lead.comment": {
    resource: { kind: "lead", idField: "leadId" },
    anchor: { self: true },
    fields: { leadId: id(), text: text(8000), evidenceRefs: ids(20, { optional: true }) },
  },
  "lead.transition": {
    resource: { kind: "lead", idField: "leadId" },
    anchor: { self: true },
    fields: { leadId: id(), toState: text(64), reason: text(1000, { optional: true }), evidenceRefs: ids(20, { optional: true }) },
  },
  "lead.schedule": {
    resource: { kind: "lead", idField: "leadId" },
    anchor: { self: true },
    // Warten heisst: auf WEN, mit WELCHEM nächsten Schritt, bis WANN, belegt
    // WOMIT. Ohne diese vier gibt es kein Warten (Kernvertrag Paket B).
    fields: {
      leadId: id(), waitUntil: iso(), counterparty: text(200), nextAction: text(500),
      evidenceRefs: ids(20), followUpAt: iso({ optional: true }), reason: text(1000, { optional: true }),
    },
  },
  "briefing.answer": {
    resource: { kind: "briefing_answer", idField: null , creates: true},
    anchor: { kind: "briefing", idField: "briefingId" },
    fields: { briefingId: id(), questionId: id(), answer: text(8000), decision: enumOf(["yes", "no", "later", "custom"], { optional: true }) },
  },
  "briefing.consumeAnswer": {
    resource: { kind: "briefing_answer", idField: "answerId" },
    anchor: { self: true },
    fields: { briefingId: id(), answerId: id() },
  },
  "question.create": {
    resource: { kind: "question", idField: null , creates: true},
    anchor: { kind: "lead", idField: "leadId" },
    fields: { leadId: id(), text: text(2000), options: list(8, text(200), { optional: true }) },
  },
  "question.resolve": {
    resource: { kind: "question", idField: "questionId" },
    anchor: { self: true },
    fields: { questionId: id(), answer: text(2000) },
  },
  "document.register": {
    resource: { kind: "document", idField: null , creates: true},
    anchor: { kind: "run", idField: null },
    // Ein Dokument ohne geprüften Anhang, Abdruck und Herkunft ist eine
    // Behauptung, kein Beleg.
    fields: {
      documentId: id(), title: text(200), attachmentRef: id(), contentHash: hash(),
      origin: enumOf(["mail", "upload", "scan", "external"]),
      linkedLeadIds: ids(20, { optional: true }), sourceRef: id({ optional: true }),
    },
  },
  "document.processed": {
    resource: { kind: "document", idField: "documentId" },
    anchor: { self: true },
    fields: { documentId: id(), extractionRef: id(), contentHash: hash(), summary: text(4000, { optional: true }) },
  },
  "worker.assign": {
    resource: { kind: "assignment", idField: null , creates: true},
    anchor: { kind: "run", idField: null },
    // `executor` ist die Art des Spezialisten, KEINE Rollenbehauptung: die
    // Rechte des Aufrufers hängen weiter ausschliesslich an seinem Ausweis.
    // `sourceVersion` bindet den Auftrag an den Stand, auf dem er beruht,
    // `allowedContextIds` an genau die Kontexte, die er lesen darf.
    fields: {
      assignmentId: id(), executor: enumOf(["claude", "gemini"]), sourceVersion: int(0, Number.MAX_SAFE_INTEGER),
      allowedContextIds: ids(20), dueAt: iso({ optional: true }),
    },
  },
  "worker.return": {
    resource: { kind: "worker_result", idField: null , creates: true},
    anchor: { kind: "assignment", idField: "assignmentId" },
    fields: {
      assignmentId: id(), resultRef: id(), summary: text(8000),
      sourceVersion: int(0, Number.MAX_SAFE_INTEGER), evidenceRefs: ids(20, { optional: true }),
    },
  },
  "worker.review": {
    resource: { kind: "worker_result", idField: "resultId" },
    anchor: { self: true },
    fields: { resultId: id(), verdict: enumOf(["accepted", "rejected", "revise"]), notes: text(4000, { optional: true }) },
  },
  "run.ensure": {
    // Der Lauf entsteht hier — deshalb ist er RESSOURCE und Anker zugleich,
    // und deshalb darf er beim Anlegen noch fehlen.
    resource: { kind: "run", idField: null , ensure: true},
    anchor: { self: true },
    fields: { slot: enumOf(["04:00", "09:00", "14:00", "23:00"]), date: day() },
  },
  "run.claim": {
    resource: { kind: "run", idField: null , fromJob: true}, anchor: { self: true },
    fields: { leaseSeconds: int(1, 900) },
  },
  "run.renew": {
    resource: { kind: "run", idField: null , fromJob: true}, anchor: { self: true },
    fields: { leaseSeconds: int(1, 900) },
  },
  "run.checkpoint": {
    resource: { kind: "run", idField: null , fromJob: true}, anchor: { self: true },
    fields: { stage: text(64), note: text(2000, { optional: true }) },
  },
  "run.finalize": {
    resource: { kind: "run", idField: null , fromJob: true}, anchor: { self: true },
    fields: { outcome: enumOf(["complete", "partial", "failed"]), summaryRef: id({ optional: true }) },
  },
  "note.append": {
    resource: { kind: "note", idField: null , creates: true},
    anchor: { kind: "run", idField: null },
    // `noteScope` heisst bewusst nicht `scope`: `scope` ist ein Feldname, mit
    // dem sonst Rechte behauptet werden, und wird deshalb generell abgewiesen.
    fields: { noteId: id(), text: text(8000), noteScope: enumOf(["run", "lead"]), leadId: id({ optional: true }) },
  },
  "run.log": {
    resource: { kind: "run", idField: null , fromJob: true}, anchor: { self: true },
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
    case "hash":
      // Ein Inhaltsabdruck ist ein SHA-256 in Hex — nichts anderes.
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return `field_invalid:${feld}`;
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

  return authOk({
    command,
    descriptor: Object.freeze({
      verb,
      resource: Object.freeze({ ...descriptor.resource }),
      anchor: Object.freeze({ ...descriptor.anchor }),
    }),
  });
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
