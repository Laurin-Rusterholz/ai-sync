/*
 * v3 C2 — der öffentliche Umschlag, wörtlich nach Konzept (PDF S. 9).
 *
 * Der Umschlag ist die Stelle, an der ein Aufrufer am billigsten etwas
 * hineinschmuggeln kann: ein Feld mehr, ein Pfad statt einer Id, eine
 * Zeitangabe, die der Server eigentlich selbst setzt. Deshalb ist er
 * geschlossen — auch verschachtelt — und deshalb steht jedes Verb mit seinem
 * eigenen Schema da.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCommandEnvelope, parseIdempotencyKey, COMMAND_VERBS, COMMAND_VERB_NAMES,
  ENVELOPE_FIELDS, COMMAND_SCHEMA_VERSION,
} from "../netlify/lib/quantus-v3-command-envelope.mjs";
import { VERBS, OBJECT_KIND_CATEGORY, COMMAND_MAX_BYTES } from "../netlify/lib/quantus-v3-auth.mjs";

const PDF_BEISPIEL = Object.freeze({
  schemaVersion: 3,
  verb: "lead.comment",
  jobId: "job_20260920_42",
  expectedEntityVersion: 17,
  payload: { leadId: "lead_123", text: "...", evidenceRefs: ["artifact_456"] },
});

test("das Beispiel aus dem Konzept wird wörtlich angenommen", () => {
  const res = parseCommandEnvelope(structuredClone(PDF_BEISPIEL));
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(JSON.parse(JSON.stringify(res.command)), PDF_BEISPIEL);
  assert.equal(res.descriptor.resource.kind, "lead");
  assert.equal(res.descriptor.resource.idField, "leadId");
  assert.equal(res.descriptor.anchor.self, true);
  assert.equal(COMMAND_SCHEMA_VERSION, 3);
  assert.deepEqual([...ENVELOPE_FIELDS], ["schemaVersion", "verb", "jobId", "expectedEntityVersion", "payload", "lease"]);
});

test("der Umschlag ist geschlossen", () => {
  for (const kaputt of [
    { ...PDF_BEISPIEL, extra: 1 },
    { ...PDF_BEISPIEL, schemaVersion: 2 },
    { ...PDF_BEISPIEL, schemaVersion: "3" },
    { ...PDF_BEISPIEL, verb: "lead.kommentieren" },
    { ...PDF_BEISPIEL, verb: "constructor" },
    { ...PDF_BEISPIEL, jobId: "job/42" },
    { ...PDF_BEISPIEL, jobId: "" },
    { ...PDF_BEISPIEL, expectedEntityVersion: -1 },
    { ...PDF_BEISPIEL, expectedEntityVersion: 1.5 },
    { ...PDF_BEISPIEL, expectedEntityVersion: "17" },
    { ...PDF_BEISPIEL, payload: null },
    { ...PDF_BEISPIEL, payload: [] },
  ]) {
    const res = parseCommandEnvelope(kaputt);
    assert.equal(res.ok, false, `${JSON.stringify(kaputt).slice(0, 60)}… wurde angenommen`);
    assert.ok([400, 403, 413].includes(res.status));
  }
  for (const nichts of [null, undefined, "text", 42, []]) {
    assert.equal(parseCommandEnvelope(nichts).ok, false);
  }
});

test("der Nutzinhalt ist geschlossen — auch verschachtelt", () => {
  const mitExtra = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { ...PDF_BEISPIEL.payload, dringend: true } });
  assert.equal(mitExtra.reason, "payload_unknown_field");

  const fehlt = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { leadId: "lead_123" } });
  assert.equal(fehlt.reason, "field_missing:text");

  // Verschachtelt: ein Objekt, wo ein Text stehen müsste.
  const verschachtelt = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { leadId: "lead_123", text: { wert: "x" } } });
  assert.equal(verschachtelt.reason, "field_invalid:text");
});

test("was der Server bestimmt, darf nicht im Körper stehen", () => {
  for (const feld of ["now", "serverNow", "requestId", "actor", "tenant", "tenantId", "role", "principal", "policyVersion", "dataRevision", "idempotencyKey", "issuedBy", "kind", "scopes"]) {
    const res = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { ...PDF_BEISPIEL.payload, [feld]: "x" } });
    assert.equal(res.ok, false, `${feld} wurde im Körper akzeptiert`);
    assert.equal(res.reason, "payload_forbidden_field");
  }
  // Auch eine Ebene tiefer.
  const tief = parseCommandEnvelope({
    ...PDF_BEISPIEL, verb: "question.create",
    payload: { leadId: "lead_1", text: "Frage", options: ["a"] },
  });
  assert.equal(tief.ok, true);
});

test("keine Pfade, keine Blob-Keys, keine Wurzel-Patches", () => {
  for (const feld of ["path", "patch", "op", "$set", "key", "blobKey", "entities", "automation", "root", "__proto__"]) {
    const res = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { ...PDF_BEISPIEL.payload, [feld]: "x" } });
    assert.equal(res.ok, false, `${feld} wurde akzeptiert`);
  }
  for (const leadId of ["appStore/app-data_json", "lead_123/../x", "lead.123", "attachment-text__a__b", "lead 123", "x".repeat(200)]) {
    const res = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { ...PDF_BEISPIEL.payload, leadId } });
    assert.equal(res.ok, false, `leadId "${leadId}" wurde akzeptiert`);
    assert.equal(res.reason, "field_invalid:leadId");
  }
});

test("64 KiB sind die Grenze, gemessen am bereinigten Befehl", () => {
  const knapp = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { leadId: "lead_123", text: "x".repeat(7999) } });
  assert.equal(knapp.ok, true);
  const zuLang = parseCommandEnvelope({ ...PDF_BEISPIEL, payload: { leadId: "lead_123", text: "x".repeat(8001) } });
  assert.equal(zuLang.ok, false);
  assert.equal(zuLang.reason, "field_invalid:text");
  assert.equal(COMMAND_MAX_BYTES, 64 * 1024);
});

test("jedes Fachverb hat ein Schema, ein Ziel und eine bekannte Objektart", () => {
  // Genau die Verben der C1-Matrix, ohne das Leseverb.
  const erwartet = VERBS.filter((v) => v !== "context.read").sort();
  assert.deepEqual([...COMMAND_VERB_NAMES].sort(), erwartet);
  // 23 Fachverben: die 22 des Konzepts plus run.sourceCheck (Quellenpruefung
  // des Pruefers, C3a). Die Browser-Warteschlange kennt weiter nur ihre 22
  // Nutzerverben; waechst oder schrumpft der Umschlag, faellt es hier auf.
  assert.equal(COMMAND_VERB_NAMES.length, 23);

  for (const [verb, beschreibung] of Object.entries(COMMAND_VERBS)) {
    assert.ok(beschreibung.fields && Object.keys(beschreibung.fields).length, `${verb} hat kein Schema`);
    // Ressource: worauf das Verb wirkt.
    const res = beschreibung.resource;
    assert.ok(res && res.kind, `${verb} hat keine Ressource`);
    assert.ok(Object.prototype.hasOwnProperty.call(OBJECT_KIND_CATEGORY, res.kind),
      `${verb}: unbekannte Ressourcenart ${res.kind}`);
    if (res.idField) {
      assert.ok(Object.prototype.hasOwnProperty.call(beschreibung.fields, res.idField),
        `${verb}: das Ressourcenfeld ${res.idField} fehlt im Schema`);
    } else {
      // Ohne Id-Feld muss gesagt sein, woher die Ressource kommt.
      assert.ok(res.creates === true || res.fromJob === true || res.ensure === true,
        `${verb}: Ressource ohne Id-Feld und ohne Herkunft`);
    }
    // Anker: woran die Bindung hängt.
    const anker = beschreibung.anchor;
    assert.ok(anker && (anker.self === true || anker.kind), `${verb} hat keinen Anker`);
    if (anker.kind) {
      assert.ok(Object.prototype.hasOwnProperty.call(OBJECT_KIND_CATEGORY, anker.kind),
        `${verb}: unbekannte Ankerart ${anker.kind}`);
      if (anker.idField) {
        assert.ok(Object.prototype.hasOwnProperty.call(beschreibung.fields, anker.idField),
          `${verb}: das Ankerfeld ${anker.idField} fehlt im Schema`);
      }
    }
  }
});

test("Beispiele aus mehreren Verben laufen durch", () => {
  const faelle = [
    ["run.claim", { leaseSeconds: 120 }],
    ["run.finalize", { outcome: "complete" }],
    ["run.ensure", { slot: "09:00", date: "2026-09-20" }],
    ["worker.assign", { assignmentId: "a_1", executor: "claude", sourceVersion: 3, allowedContextIds: ["ctx_1"], dueAt: "2026-09-25T09:00:00Z", sourceType: "chatgptLead", sourceId: "lead_1", purpose: "Offerte pruefen", jobKind: "recherche" }],
    ["worker.return", { assignmentId: "a_1", resultRef: "r_1", summary: "fertig", sourceVersion: 3, resultHash: "d".repeat(64) }],
    ["lead.schedule", { leadId: "lead_1", waitUntil: "2026-09-25T09:00:00Z", counterparty: "Muster AG", nextAction: "Nachfassen", evidenceRefs: ["artifact_1"] }],
    ["document.register", { documentId: "doc_1", title: "Vertrag", attachmentRef: "attachment-text__chatgptLead__lead_123__vertrag.pdf", contentHash: "a".repeat(64), origin: "mail", mime: "application/pdf", size: 1234, leadId: "lead_1" }],
    ["briefing.answer", { briefingId: "b_1", questionId: "q_1", answer: "ja", answerId: "a_1" }],
    ["run.sourceCheck", { sourceId: "gmail-inbox", cursor: "c1", outcome: "ok" }],
    ["lead.transition", { leadId: "lead:1", toState: "done" }],
    ["run.renew", { leaseSeconds: 10 }],
    ["note.append", { noteId: "n_1", text: "Notiz", noteScope: "run" }],
  ];
  for (const [verb, payload] of faelle) {
    const res = parseCommandEnvelope({ schemaVersion: 3, verb, jobId: "job_1", expectedEntityVersion: 0, payload });
    assert.equal(res.ok, true, `${verb}: ${res.reason}`);
  }
  // Ungültige Aufzählungswerte und Grenzen.
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "run.ensure", jobId: "job_1", expectedEntityVersion: 0, payload: { slot: "05:00", date: "2026-09-20" } }).ok, false);
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "run.claim", jobId: "job_1", expectedEntityVersion: 0, payload: { leaseSeconds: 121 } }).ok, false);
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "run.claim", jobId: "job_1", expectedEntityVersion: 0, payload: { leaseSeconds: 9 } }).ok, false, "unter dem E1-Minimum");
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "document.register", jobId: "job_1", expectedEntityVersion: 0, payload: { documentId: "doc_1", title: "V", attachmentRef: "att_1", contentHash: "a".repeat(64), origin: "mail", mime: "a/b", size: 1, leadId: "l" } }).reason, "field_invalid:attachmentRef", "nur ein Anhangsschluessel");
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "lead.transition", jobId: "job_1", expectedEntityVersion: 0, payload: { leadId: "attachment-text__a", toState: "done" } }).ok, false, "__ bleibt verboten");
  // Der praesentierte Lease-Nachweis: nur Halter und Fence, beide geformt.
  const mitLease = (lease) => parseCommandEnvelope({ schemaVersion: 3, verb: "run.renew", jobId: "job_1", expectedEntityVersion: 0, payload: { leaseSeconds: 60 }, lease });
  assert.deepEqual(mitLease({ holder: "cloud-scheduler", fence: 3 }).command.lease, { holder: "cloud-scheduler", fence: 3 });
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "run.renew", jobId: "job_1", expectedEntityVersion: 0, payload: { leaseSeconds: 60 } }).command.lease, undefined, "ohne Angabe kein Feld — der kanonische Befehl bleibt unveraendert");
  for (const kaputt of [null, "x", { holder: "h" }, { fence: 1 }, { holder: "h", fence: 0 }, { holder: "h", fence: 1.5 }, { holder: "h", fence: 1, scope: "s" }, { holder: "attachment-text__x", fence: 1 }]) {
    assert.equal(mitLease(kaputt).reason, "lease_invalid", JSON.stringify(kaputt));
  }
  assert.equal(parseCommandEnvelope({ schemaVersion: 3, verb: "run.ensure", jobId: "job_1", expectedEntityVersion: 0, payload: { slot: "09:00", date: "20.09.2026" } }).ok, false);
});

test("der Idempotenz-Schlüssel kommt aus der Kopfzeile und hat eine Form", () => {
  assert.equal(parseIdempotencyKey("abc-123").idempotencyKey, "abc-123");
  assert.equal(parseIdempotencyKey("  abc  ").idempotencyKey, "abc");
  for (const kaputt of ["", null, undefined, "   ", "a".repeat(201), "mit leerzeichen", "mit/pfad", "\n"]) {
    const res = parseIdempotencyKey(kaputt);
    assert.equal(res.ok, false, `"${String(kaputt)}" wurde akzeptiert`);
    assert.equal(res.status, 400);
  }
});

test("die Kernvertragsfelder sind Pflicht — nichts wird erfunden", () => {
  const ohne = (verb, payload) => parseCommandEnvelope({ schemaVersion: 3, verb, jobId: "job_1", expectedEntityVersion: 0, payload });

  // Warten ohne Gegenpartei, nächste Handlung oder Belege gibt es nicht.
  assert.equal(ohne("lead.schedule", { leadId: "l_1", waitUntil: "2026-09-25T09:00:00Z" }).reason, "field_missing:counterparty");
  assert.equal(ohne("lead.schedule", { leadId: "l_1", waitUntil: "2026-09-25T09:00:00Z", counterparty: "X" }).reason, "field_missing:nextAction");
  assert.equal(ohne("lead.schedule", { leadId: "l_1", waitUntil: "2026-09-25T09:00:00Z", counterparty: "X", nextAction: "Y" }).reason, "field_missing:evidenceRefs");

  // Ein Dokument ohne Anhang, Abdruck oder Herkunft ist keine Registrierung.
  assert.equal(ohne("document.register", { documentId: "d_1", title: "T" }).reason, "field_missing:attachmentRef");
  assert.equal(ohne("document.register", { documentId: "d_1", title: "T", attachmentRef: "attachment-text__chatgptLead__lead_123__vertrag.pdf" }).reason, "field_missing:contentHash");
  assert.equal(ohne("document.register", { documentId: "d_1", title: "T", attachmentRef: "attachment-text__chatgptLead__lead_123__vertrag.pdf", contentHash: "kein-hash", origin: "mail" }).reason, "field_invalid:contentHash");
  assert.equal(ohne("document.register", { documentId: "d_1", title: "T", attachmentRef: "attachment-text__chatgptLead__lead_123__vertrag.pdf", contentHash: "a".repeat(64), origin: "mail" }).reason, "field_missing:mime");

  // Ein Worker-Auftrag ohne Quellversion oder erlaubte Kontexte ebenso.
  assert.equal(ohne("worker.assign", { assignmentId: "a_1", executor: "claude" }).reason, "field_missing:sourceVersion");
  assert.equal(ohne("worker.assign", { assignmentId: "a_1", executor: "claude", sourceVersion: 1 }).reason, "field_missing:allowedContextIds");
  assert.equal(ohne("worker.return", { assignmentId: "a_1", resultRef: "r_1", summary: "s" }).reason, "field_missing:sourceVersion");
  assert.equal(ohne("worker.return", { assignmentId: "a_1", resultRef: "r_1", summary: "s", sourceVersion: 1 }).reason, "field_missing:resultHash");
  assert.equal(ohne("worker.assign", { assignmentId: "a_1", executor: "claude", sourceVersion: 1, allowedContextIds: [] }).reason, "field_missing:dueAt");

  // Und die alten, lockereren Felder gibt es nicht mehr.
  assert.equal(ohne("worker.assign", { assignmentId: "a_1", workerKind: "claude", contextRef: "c_1" }).ok, false);
});
