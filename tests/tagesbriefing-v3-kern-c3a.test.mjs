/*
 * Tagesbriefing v3, Kern-Erweiterung fuer Paket C3a — fuenf Kommandos, die
 * die C2-Fachverben brauchen und die es im Kern bisher nicht gab:
 * createTask, addComment, appendRunNote, recordRunEvent, recordRunCheckpoint;
 * dazu die erweiterten Akteure fuer registerDocument (user) und
 * recordDocumentParse (agent, system).
 *
 * Befund: task.create, lead.comment, note.append, run.log und run.checkpoint
 * waren im Adapter 7bbbd42 benannte Luecken, weil der Kern kein sicheres
 * Kommando dafuer hatte. Diese Tests sichern, dass die neuen Kommandos die
 * Kern-Invarianten halten (Klon, Revision +1, Idempotenz bei gleicher
 * Kennung und gleichem Inhalt, Konflikt bei anderem Inhalt), dass eine neu
 * angelegte Aufgabe MIGRIERT ist (fuehrender Zustand, Version 1, Rollen) und
 * dass die Ampel sie nicht als unmigriert meldet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as K from "../netlify/lib/assistant-core.mjs";
import { attSegEncode } from "../netlify/lib/blob-key-policy.mjs";

const T = (s) => Date.parse(s);
const MIN = 60 * 1000;
const POLICY = Object.freeze({ ...K.POLICY_TEMPLATE, tenant: "laurin", requiredSources: [{ id: "quantus-core", kind: "quantus-core" }, { id: "gmail-inbox", kind: "mail" }] });
const AGENT = { kind: "agent", id: "chatgpt-run" }, USER = { kind: "user", id: "laurin" }, SYSTEM = { kind: "system", id: "pruefer" }, WORKER = { kind: "worker", id: "claude-w" }, ADAPTER = { kind: "adapter", id: "gmail" };
const NOW = T("2026-09-20T09:00:00Z");
const DATE = "2026-09-20";

function bestand() {
  const t0 = "2026-09-18T10:00:00.000Z";
  return {
    entities: {
      tasks: { t1: { id: "t1", title: "Rechnung zahlen", status: "todo", createdAt: t0, updatedAt: t0, comments: [] } },
      projects: {}, notes: {}, chatgptNotes: {},
      chatgptLeads: { l1: { id: "l1", title: "Kunden anlegen", status: "in_arbeit", assignee: "chatgpt", result: "#/organizations/abc", createdAt: t0, updatedAt: t0, comments: [] } },
      chatgptTasks: {},
    },
    dailyBriefing: {},
  };
}
let n = 0;
const cmd = (type, payload, now = NOW) => ({ type, commandId: "c3a_" + String(++n).padStart(5, "0"), now, payload });
const run = (data, type, payload, actor = AGENT, now = NOW) => K.applyCommand(data, cmd(type, payload, now), { policy: POLICY, actor });
const mussOk = (r, was) => { assert.equal(r.ok, true, `${was}: ${r.error} ${JSON.stringify(r.detail)}`); return r.data; };
function basis() {
  let d = K.migrateCore(bestand(), { now: NOW - 60 * MIN }).data;
  d = mussOk(run(d, "ensureRun", { date: DATE }, AGENT, K.slotBeginnMs(DATE, "briefing04") + MIN), "ensureRun");
  return d;
}

test("createTask legt eine MIGRIERTE Aufgabe an: fuehrender Zustand, Version 1, Rollen, Lead-Verknuepfung; Ampel meldet sie nicht als unmigriert", () => {
  const d0 = basis();
  const rev = d0.automation.dataRevision;
  const r = run(d0, "createTask", { taskId: "t_neu", title: "Offerte nachfassen", dueDate: "2026-09-25", notes: "bis Freitag", linkedLeadId: "l1" }, USER);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.created, true);
  const d = r.data;
  assert.equal(d.automation.dataRevision, rev + 1);
  assert.equal(d0.entities.tasks.t_neu, undefined, "die Eingabe bleibt unveraendert");
  const t = d.entities.tasks.t_neu;
  assert.equal(t.status, "todo"); assert.equal(t.dueDate, "2026-09-25"); assert.deepEqual(t.linkedChatgptLeads, ["l1"]); assert.equal(t.createdBy, "laurin");
  const z = K.effektiverZustand("task", t);
  assert.deepEqual([z.state, z.version, z.unmigrated, z.unmapped, z.drift], ["doing", 1, false, false, null]);
  assert.deepEqual(K.rollenFuer("task", t), { accountable: "user", executor: "user", explicit: true });
  const ev = K.dailyAssistantTrafficLight(d.dailyBriefing.assistantRuns[DATE], d, NOW, POLICY);
  assert.ok(!ev.reasons.some((x) => x.code === "NOT_MIGRATED" && x.sourceId === "t_neu"), JSON.stringify(ev.reasons));
  // Idempotent bei gleicher Kennung, gleichem Titel und gleichem Urheber; sonst Konflikt.
  const wieder = run(d, "createTask", { taskId: "t_neu", title: "Offerte nachfassen" }, USER);
  assert.equal(wieder.ok, true); assert.equal(wieder.created, false); assert.equal(wieder.noop, true);
  assert.equal(run(d, "createTask", { taskId: "t_neu", title: "anders" }, USER).error, "TASK_ID_TAKEN");
  assert.equal(run(d, "createTask", { taskId: "t_neu", title: "Offerte nachfassen" }, AGENT).error, "TASK_ID_TAKEN", "anderer Urheber ist ein anderer Anspruch");
  // Formfehler: leerer Titel, ungueltiges Datum, unbekannter Lead, falscher Akteur, Schutzfeld.
  assert.equal(run(d, "createTask", { taskId: "t2", title: " " }, USER).error, "TASK_TITLE_MISSING");
  assert.equal(run(d, "createTask", { taskId: "t2", title: "x", dueDate: "25.09.2026" }, USER).error, "DATE_INVALID");
  assert.equal(run(d, "createTask", { taskId: "t2", title: "x", linkedLeadId: "l_fremd" }, USER).error, "LINK_TARGET_NOT_FOUND");
  assert.equal(run(d, "createTask", { taskId: "t2", title: "x" }, SYSTEM).error, "ACTOR_REJECTED");
  assert.equal(run(d, "createTask", { taskId: "t2", title: "x", operationalState: "done" }, USER).error, "COMMAND_REJECTED");
  // Die neue Aufgabe laesst sich mit den bestehenden Kommandos weiterfuehren (Nutzer-Selbstabschluss).
  const done = run(d, "transitionState", { sourceType: "task", sourceId: "t_neu", state: "done", expectedVersion: 1 }, USER);
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(K.effektiverZustand("task", done.data.entities.tasks.t_neu).state, "done");
});

test("addComment haengt einen Kommentar an Lead oder Aufgabe: Wortlaut, Zeit, Urheber — keine Zustandswirkung, keine Umdeutung", () => {
  const d0 = basis();
  const v = K.effektiverZustand("chatgptLead", d0.entities.chatgptLeads.l1).version;
  const r = run(d0, "addComment", { sourceType: "chatgptLead", sourceId: "l1", commentId: "c1", text: "Kunde hat angerufen" }, USER);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.created, true);
  const d = r.data;
  assert.deepEqual(d.entities.chatgptLeads.l1.comments.map((c) => [c.id, c.text, c.author, c.authorKind]), [["c1", "Kunde hat angerufen", "laurin", "user"]]);
  assert.equal(d.entities.chatgptLeads.l1.comments[0].createdAt, new Date(NOW).toISOString());
  assert.equal(K.effektiverZustand("chatgptLead", d.entities.chatgptLeads.l1).version, v, "kein Zustandswechsel");
  assert.equal(d.automation.dataRevision, d0.automation.dataRevision + 1);
  assert.equal(run(d, "addComment", { sourceType: "chatgptLead", sourceId: "l1", commentId: "c1", text: "Kunde hat angerufen" }, USER).created, false);
  assert.equal(run(d, "addComment", { sourceType: "chatgptLead", sourceId: "l1", commentId: "c1", text: "anders" }, USER).error, "COMMENT_IMMUTABLE");
  assert.equal(run(d, "addComment", { sourceType: "chatgptLead", sourceId: "l_fremd", commentId: "c2", text: "x" }, USER).error, "SOURCE_NOT_FOUND");
  assert.equal(run(d, "addComment", { sourceType: "intake", sourceId: "x", commentId: "c2", text: "x" }, USER).error, "SOURCE_TYPE_NOT_STATEFUL");
  assert.equal(run(d, "addComment", { sourceType: "chatgptLead", sourceId: "l1", commentId: "c2", text: "  " }, USER).error, "COMMENT_TEXT_MISSING");
  assert.equal(run(d, "addComment", { sourceType: "chatgptLead", sourceId: "l1", commentId: "c2", text: "x" }, WORKER).error, "ACTOR_REJECTED");
  // Aufgaben ohne comments-Feld bekommen eines; ein Kommentar des Agenten traegt seine Art.
  const ohne = structuredClone(d); delete ohne.entities.tasks.t1.comments;
  const t = run(ohne, "addComment", { sourceType: "task", sourceId: "t1", commentId: "c9", text: "erledigt?" }, AGENT);
  assert.equal(t.ok, true); assert.equal(t.data.entities.tasks.t1.comments[0].authorKind, "agent");
});

test("appendRunNote schreibt eine ChatGPT-Notiz (assistantEntry) zum Lauf; recordRunEvent und recordRunCheckpoint fuehren den Lauf fort", () => {
  let d = basis();
  const rev0 = d.dailyBriefing.assistantRuns[DATE].revision;
  const r = run(d, "appendRunNote", { date: DATE, noteId: "note_1", text: "Bank Muster AG hat bestaetigt.", linkedLeadId: "l1" }, SYSTEM);
  assert.equal(r.ok, true, JSON.stringify(r)); d = r.data;
  const note = d.entities.chatgptNotes.note_1;
  assert.equal(note.instruction, "Bank Muster AG hat bestaetigt."); assert.equal(note.category, "auftrag"); assert.deepEqual(note.tags, ["tagesbriefing", "eintrag", DATE]);
  assert.deepEqual(note.assistantNote, { schema: K.ASSISTANT_NOTE_SCHEMA, kind: "assistantEntry", runDate: DATE, runRevision: rev0 });
  assert.deepEqual(note.linkedChatgptLeads, ["l1"]); assert.equal(note.author, "pruefer");
  assert.deepEqual(d.dailyBriefing.assistantRuns[DATE].noteIds, ["note_1"]);
  assert.equal(d.dailyBriefing.assistantRuns[DATE].revision, rev0 + 1);
  assert.equal(run(d, "appendRunNote", { date: DATE, noteId: "note_1", text: "Bank Muster AG hat bestaetigt." }, SYSTEM).created, false);
  assert.equal(run(d, "appendRunNote", { date: DATE, noteId: "note_1", text: "anders" }, SYSTEM).error, "NOTE_ID_TAKEN");
  assert.equal(run(d, "appendRunNote", { date: "2026-09-21", noteId: "note_2", text: "x" }, SYSTEM).error, "RUN_MISSING");
  assert.equal(run(d, "appendRunNote", { date: DATE, noteId: "note_2", text: "x", linkedLeadId: "l_fremd" }, SYSTEM).error, "LINK_TARGET_NOT_FOUND");
  assert.equal(run(d, "appendRunNote", { date: DATE, noteId: "note_2", text: "x" }, WORKER).error, "ACTOR_REJECTED");
  // Start-/Finalnotizen bleiben eigene Arten: die Startnotiz-Kennung ist fuer appendRunNote vergeben.
  d = mussOk(run(d, "ensureStartNote", { date: DATE, noteId: "note_start" }), "start");
  assert.equal(run(d, "appendRunNote", { date: DATE, noteId: "note_start", text: "x" }, SYSTEM).error, "NOTE_ID_TAKEN");

  // Ereignisse: begrenztes Protokoll, idempotent je Kennung.
  const e = run(d, "recordRunEvent", { date: DATE, eventId: "ev_1", event: "tick", detail: "Scheduler 09:00" }, SYSTEM);
  assert.equal(e.ok, true, JSON.stringify(e)); d = e.data;
  assert.deepEqual(d.dailyBriefing.assistantRuns[DATE].events.map((x) => [x.id, x.event, x.detail, x.by, x.byKind]), [["ev_1", "tick", "Scheduler 09:00", "pruefer", "system"]]);
  assert.equal(run(d, "recordRunEvent", { date: DATE, eventId: "ev_1", event: "tick" }, SYSTEM).created, false);
  assert.equal(run(d, "recordRunEvent", { date: DATE, eventId: "ev_1", event: "anders" }, SYSTEM).error, "RUN_EVENT_IMMUTABLE");
  assert.equal(run(d, "recordRunEvent", { date: DATE, eventId: "ev_2", event: "x".repeat(65) }, SYSTEM).error, "RUN_EVENT_INVALID");
  assert.equal(run(d, "recordRunEvent", { date: DATE, eventId: "ev_2", event: "x" }, USER).error, "ACTOR_REJECTED");
  let voll = d;
  for (let i = 0; i < 505; i++) voll = mussOk(run(voll, "recordRunEvent", { date: DATE, eventId: "ev_f" + i, event: "f" }, AGENT, NOW + i), "ev " + i);
  assert.equal(voll.dailyBriefing.assistantRuns[DATE].events.length, 500, "das Protokoll ist begrenzt");
  assert.equal(voll.dailyBriefing.assistantRuns[DATE].events[0].id, "ev_f5", "die aeltesten fallen weg");

  // Fortschrittsmarker: Stufe, Zeit, Urheber; nicht auf einem finalen Lauf.
  const c = run(d, "recordRunCheckpoint", { date: DATE, checkpointId: "cp_1", stage: "lesen", note: "Posteingang gesichtet" }, AGENT);
  assert.equal(c.ok, true, JSON.stringify(c)); d = c.data;
  assert.deepEqual(d.dailyBriefing.assistantRuns[DATE].lastCheckpoint, { id: "cp_1", stage: "lesen", at: new Date(NOW).toISOString() });
  assert.equal(run(d, "recordRunCheckpoint", { date: DATE, checkpointId: "cp_1", stage: "lesen" }, AGENT).created, false);
  assert.equal(run(d, "recordRunCheckpoint", { date: DATE, checkpointId: "cp_1", stage: "anders" }, AGENT).error, "CHECKPOINT_IMMUTABLE");
  assert.equal(run(d, "recordRunCheckpoint", { date: DATE, checkpointId: "cp_2", stage: "" }, AGENT).error, "CHECKPOINT_STAGE_INVALID");
  const final = structuredClone(d); final.dailyBriefing.assistantRuns[DATE].phase = "final";
  assert.equal(run(final, "recordRunCheckpoint", { date: DATE, checkpointId: "cp_2", stage: "x" }, AGENT).error, "RUN_FINAL");
  // Der Kern bleibt strukturell gueltig, die Ampel rechnet weiter.
  assert.deepEqual(K.pruefeKernStruktur(d), []);
  assert.equal(typeof K.dailyAssistantTrafficLight(d.dailyBriefing.assistantRuns[DATE], d, NOW, POLICY).coverage, "string");
});

test("Dokumente: registerDocument auch durch den Nutzer, recordDocumentParse auch durch Leitung und System — mit unveraenderten Pruefungen", () => {
  let d = basis();
  const ATT = "attachment-text__" + attSegEncode("chatgptLead") + "__" + attSegEncode("l1") + "__" + attSegEncode("vertrag.pdf");
  const doc = { documentId: "doc_1", attachmentId: ATT, name: "Vertrag", hash: "a".repeat(64), mime: "application/pdf", size: 1234, origin: { channel: "upload", ref: "browser" }, linkedTo: { sourceType: "chatgptLead", sourceId: "l1" } };
  const r = run(d, "registerDocument", doc, USER);
  assert.equal(r.ok, true, JSON.stringify(r)); d = r.data;
  assert.equal(d.automation.documentsById.doc_1.registeredBy, "laurin"); assert.equal(d.automation.documentsById.doc_1.status, "open");
  assert.equal(run(d, "registerDocument", { ...doc, documentId: "doc_2", attachmentId: "kein_anhangsschluessel" }, USER).error, "DOCUMENT_ATTACHMENT_ID_INVALID", "der Anhangsschluessel wird weiter geprueft");
  assert.equal(run(d, "registerDocument", { ...doc, documentId: "doc_2" }, AGENT).error, "ACTOR_REJECTED", "die Leitung registriert keine Dokumente");
  const p = run(d, "recordDocumentParse", { documentId: "doc_1", outcome: "parsed", textRef: ATT, extractHash: "b".repeat(64) }, AGENT);
  assert.equal(p.ok, true, JSON.stringify(p)); d = p.data;
  assert.equal(d.automation.documentsById.doc_1.parse.checkedBy, "chatgpt-run"); assert.equal(d.automation.documentsById.doc_1.parse.outcome, "parsed");
  assert.equal(run(d, "recordDocumentParse", { documentId: "doc_1", outcome: "parsed", textRef: "x", extractHash: "b".repeat(64) }, SYSTEM).error, "PARSE_TEXTREF_INVALID");
  assert.equal(run(d, "recordDocumentParse", { documentId: "doc_1", outcome: "parsed", textRef: ATT, extractHash: "b".repeat(64) }, USER).error, "ACTOR_REJECTED", "der Nutzer parst nicht");
  assert.equal(run(d, "recordDocumentParse", { documentId: "doc_1", outcome: "parsed", textRef: ATT, extractHash: "b".repeat(64) }, WORKER).error, "ACTOR_REJECTED");
});

test("Kern-Invarianten: jedes neue Kommando hat Schema und Handler, bewegt die Revision genau um eins und laesst Ledger und Lease unberuehrt", () => {
  for (const k of ["createTask", "addComment", "appendRunNote", "recordRunEvent", "recordRunCheckpoint"]) assert.ok(K.COMMAND_SCHEMAS[k], k);
  let d = basis();
  d.automation.idempotencyByKey = { x: { state: "committed" } };
  const rev = d.automation.dataRevision;
  for (const [type, payload, actor] of [
    ["createTask", { taskId: "t9", title: "x" }, USER],
    ["addComment", { sourceType: "chatgptLead", sourceId: "l1", commentId: "c9", text: "x" }, USER],
    ["appendRunNote", { date: DATE, noteId: "n9", text: "x" }, AGENT],
    ["recordRunEvent", { date: DATE, eventId: "e9", event: "x" }, AGENT],
    ["recordRunCheckpoint", { date: DATE, checkpointId: "k9", stage: "x" }, AGENT],
  ]) {
    const vorher = JSON.stringify(d);
    const r = run(d, type, payload, actor);
    assert.equal(r.ok, true, type + ": " + JSON.stringify(r));
    assert.equal(r.data.automation.dataRevision, d.automation.dataRevision + 1, type);
    assert.deepEqual(r.data.automation.idempotencyByKey, { x: { state: "committed" } }, type);
    assert.equal(r.data.automation.activeLease, null, type);
    assert.equal(JSON.stringify(d), vorher, type + " hat die Eingabe veraendert");
    d = r.data;
  }
  assert.equal(d.automation.dataRevision, rev + 5);
  assert.deepEqual(K.pruefeKernStruktur(d), []);
});
