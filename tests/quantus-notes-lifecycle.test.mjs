// Produktionsbefund (Review PR #220, P1-1 und P3/D6):
//
// 1) deleteEntity("note") kannte das Idea-Aggregat nicht. Wer die NOTE-Seite
//    einer Idee in NoteFlow loeschte, liess die Board-Projektion in
//    entities.ideas stehen — und migrateQuantusNotes baute die geloeschte
//    Note beim naechsten Start daraus wieder auf. Composer-Ideen kehrten
//    unter einer frischen, nie tombstonten id ("idea-note-idea-<noteId>")
//    dauerhaft zurueck; Legacy-Ideen flip-floppten mit ihrem Grabstein.
//
// 2) Das generische undo() stellte item.backup mit dem ALTEN updatedAt
//    wieder her und liess den Loesch-Grabstein stehen. Der Grabstein war
//    juenger als die Entitaet — die naechste Normalisierung entfernte die
//    gerade wiederhergestellte Note sofort wieder.
//
// Dieser Test schneidet die echten Funktionen aus index.html heraus und
// spielt beide Szenarien nach; er scheitert, sobald eine der beiden
// Symmetrien wieder verloren geht.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const core = fs.readFileSync(path.join(root, "public", "quantus-notes-core.js"), "utf8");

const cut = (from, to) => {
  const a = index.indexOf(from);
  const b = index.indexOf(to, a);
  assert.ok(a > 0 && b > a, `Extraktionsmarker fehlt: ${from.slice(0, 40)}`);
  return index.slice(a, b);
};
const noteModel = cut("// QUANTUS-WEITES NOTIZMODELL", "// Week start (Monday)");
const flattenIdx = index.indexOf("function flattenDeleteLog(log)");
const src = [
  cut("function ownEntity(map, id)", "function getEntityMap"),
  cut("function getEntityMap(kind)", "function getEntity(kind, id)"),
  cut("function getDeleteLog()", "function mergeAndPersistDeleteLog"),
  cut("function unionDeleteLogs(a, b)", "function flattenDeleteLog"),
  index.slice(flattenIdx, index.indexOf("\n}", flattenIdx) + 2),
  noteModel,
  cut("function deleteEntity(kind, id)", "function cleanupLinks"),
  cut("function undo() {", "function updateUndoButton"),
].join("\n\n");

const storage = new Map();
const sandbox = {
  console,
  window: {},
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  document: {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, querySelectorAll: () => [], querySelector: () => null, remove() {}, addEventListener() {} }),
    getElementById: () => null,
    body: { appendChild() {} },
  },
  APP: { state: { data: null, undoStack: [], ui: {} } },
  scheduleSave: () => {},
  nowIso: () => new Date().toISOString(),
  uuid: () => "u" + Math.random().toString(36).slice(2, 10),
  logActivity: () => {},
  updateUndoButton: () => {},
  cleanupLinks: () => {},
  deepClone: (o) => JSON.parse(JSON.stringify(o)),
  toast: () => {},
  render: () => {},
  navigate: () => {},
  getEntity: () => null,
  getEntityDisplayName: () => "",
  $: () => null,
  esc: (s) => String(s ?? ""),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(core, sandbox, { filename: "quantus-notes-core.js" });
vm.runInContext(src, sandbox, { filename: "index-extract.js" });

const fresh = () => ({
  meta: { updatedAt: "" },
  pinnedItems: [],
  entities: { notes: {}, notebooks: {}, ideas: {}, books: {}, tasks: {}, projects: {}, organizations: {} },
});
const reset = () => {
  storage.clear();
  sandbox.APP.state.data = fresh();
  sandbox.APP.state.undoStack = [];
};
const run = (code) => vm.runInContext(code, sandbox);
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks++; };

// ── Loeschen der NOTE-Seite einer Legacy-Idee: Bundle, kein Wiedergaenger ──
reset();
{
  const d = sandbox.APP.state.data;
  d.entities.ideas.i1 = { id: "i1", title: "Alte Idee", text: "Inhalt", tags: ["Politik"], status: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
  run("migrateQuantusNotes(APP.state.data)");
  eq(Object.keys(d.entities.notes).join(","), "idea-note-i1", "Migration erzeugt genau eine zentrale Note");
  eq(run("deleteEntity('note','idea-note-i1')"), true, "Loeschen der Note-Seite meldet Erfolg");
  eq(d.entities.notes["idea-note-i1"], undefined, "Note ist entfernt");
  eq(d.entities.ideas.i1, undefined, "Board-Projektion wird als Bundle mitgeloescht");
  const log = JSON.parse(storage.get("_delete_log") || "{}");
  ok(log.idea?.i1 && log.note?.["idea-note-i1"], "beide Grabsteine geschrieben");
  run("migrateQuantusNotes(APP.state.data)");
  run("migrateQuantusNotes(APP.state.data)");
  eq(Object.keys(d.entities.notes).length, 0, "keine Wiederauferstehung der Note");
  eq(Object.keys(d.entities.ideas).length, 0, "keine Wiederauferstehung der Projektion");
}

// ── Loeschen der NOTE-Seite einer Composer-Idee (uuid-Note, idea-<noteId>) ──
reset();
{
  const d = sandbox.APP.state.data;
  const noteId = "u_note_1";
  d.entities.notes[noteId] = { id: noteId, title: "Neue Idee", content: "X", noteClass: "idea", tags: ["Kat"], notebookId: null, source: { app: "ideas", entityType: "idea", entityId: "idea-" + noteId, label: "Neue Idee", route: "#/ideas/idea-" + noteId }, createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
  d.entities.ideas["idea-" + noteId] = { id: "idea-" + noteId, noteId, centralNoteId: noteId, title: "Neue Idee", text: "X", content: "X", category: "Kat", tags: ["Kat"], status: "open", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
  run("deleteEntity('note','u_note_1')");
  run("migrateQuantusNotes(APP.state.data)");
  eq(Object.keys(d.entities.notes).length, 0, "Composer-Idee: Note kehrt nicht unter neuer id zurueck");
  eq(Object.keys(d.entities.ideas).length, 0, "Composer-Idee: Projektion bleibt geloescht");
}

// ── Das Bundle-Undo stellt beides wieder her und raeumt die Grabsteine ──
reset();
{
  const d = sandbox.APP.state.data;
  d.entities.ideas.i1 = { id: "i1", title: "Idee", text: "T", tags: ["K"], status: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  run("migrateQuantusNotes(APP.state.data)");
  run("deleteEntity('note','idea-note-i1')");
  eq(sandbox.APP.state.undoStack.at(-1)?.action, "deleteIdeaBundle", "Note-seitiges Loeschen erzeugt Bundle-Undo");
  run("undo()");
  ok(d.entities.ideas.i1 && d.entities.notes["idea-note-i1"], "Undo stellt Idee UND Note wieder her");
  const log = JSON.parse(storage.get("_delete_log") || "{}");
  ok(!log.idea?.i1 && !log.note?.["idea-note-i1"], "Undo raeumt beide Grabsteine");
  run("migrateQuantusNotes(APP.state.data)");
  ok(d.entities.ideas.i1 && d.entities.notes["idea-note-i1"], "Wiederhergestelltes ueberlebt die Normalisierung");
}

// ── Generisches Undo (normale Notiz): Grabstein weg, frisches updatedAt ──
reset();
{
  const d = sandbox.APP.state.data;
  d.entities.notes.n1 = { id: "n1", title: "T", content: "c", noteClass: "general", notebookId: null, tags: [], source: { app: "noteflow", entityType: "note", entityId: "n1", label: "NoteFlow", route: "#/notes/n1" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  run("deleteEntity('note','n1')");
  eq(d.entities.notes.n1, undefined, "Note geloescht");
  run("undo()");
  ok(d.entities.notes.n1, "Undo stellt die Note wieder her");
  ok(new Date(d.entities.notes.n1.updatedAt).getTime() > new Date("2026-01-01T00:00:00Z").getTime(), "Undo vergibt frisches updatedAt");
  const log = JSON.parse(storage.get("_delete_log") || "{}");
  ok(!log.note?.n1, "Undo raeumt den Grabstein");
  run("migrateQuantusNotes(APP.state.data)");
  ok(d.entities.notes.n1, "Wiederhergestellte Note ueberlebt die naechste Normalisierung");
}

// ── Zeitstempel entscheidet die Sync-Richtung; Status wandert als ideaStatus ──
// (Review D9/P2-4: eine aeltere Note darf frischere Board-Aenderungen nicht
// ueberschreiben; der Bearbeitungsstatus muss die Geraete ueberleben.)
reset();
{
  const d = sandbox.APP.state.data;
  d.entities.notes["idea-note-i1"] = { id: "idea-note-i1", title: "Alt", content: "alter Text", noteClass: "idea", tags: ["Kat"], notebookId: null, dedupeKey: "ideas:i1", source: { app: "ideas", entityType: "idea", entityId: "i1", label: "Alt", route: "#/ideas/i1" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  d.entities.ideas.i1 = { id: "i1", noteId: "idea-note-i1", centralNoteId: "idea-note-i1", title: "Neu vom Board", text: "frischer Text", content: "frischer Text", category: "Kat", tags: ["Kat"], status: "processed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  run("migrateQuantusNotes(APP.state.data)");
  eq(d.entities.notes["idea-note-i1"].content, "frischer Text", "juengere Idea-Aenderung gewinnt gegen aeltere Note");
  eq(d.entities.notes["idea-note-i1"].ideaStatus, "processed", "Status wandert in die Note (ideaStatus)");
  run("migrateQuantusNotes(APP.state.data)");
  eq(d.entities.notes["idea-note-i1"].content, "frischer Text", "idempotent");
}
reset();
{
  const d = sandbox.APP.state.data;
  d.entities.notes["idea-note-i1"] = { id: "idea-note-i1", title: "Neu von Mobile", content: "mobiler Text", noteClass: "idea", tags: ["Kat"], ideaStatus: "archived", notebookId: null, dedupeKey: "ideas:i1", source: { app: "ideas", entityType: "idea", entityId: "i1", label: "Neu", route: "#/ideas/i1" }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  d.entities.ideas.i1 = { id: "i1", noteId: "idea-note-i1", centralNoteId: "idea-note-i1", title: "Alt", text: "alter Text", content: "alter Text", category: "Kat", tags: ["Kat"], status: "open", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  run("migrateQuantusNotes(APP.state.data)");
  eq(d.entities.ideas.i1.text, "mobiler Text", "juengere Note gewinnt gegen aeltere Projektion");
  eq(d.entities.ideas.i1.status, "archived", "note.ideaStatus setzt den Board-Status");
}

// ── Buchstatus-Paritaet: in_progress ist "lese ich" (wie auf dem Tablet) ──
eq(vm.runInContext("window.QuantusNotesCore.normalizeBookStatus('in_progress')", sandbox), "reading",
  "in_progress wird geraeteuebergreifend als reading gelesen");

console.log(`Notiz-Lebenszyklus (Bundle-Delete/Undo/Grabsteine/Status-Sync): ok (${checks} Pruefungen)`);
