/*
 * Eine in NoteFlow geloeschte Seite kam nach dem naechsten Abgleich zurueck.
 *
 * NoteFlow.deleteNote loeschte direkt aus der Notizkarte (delete notesMap()[id])
 * statt ueber deleteEntity. Nur deleteEntity ruft logDeletion und legt damit
 * einen Grabstein in _delete_log an. Ohne Grabstein liest mergeData eine
 * fehlende id schlicht als "auf der Gegenseite neu" und nimmt sie wieder auf —
 * die Seite lebt wieder.
 *
 * Die Tests schneiden die ECHTEN Funktionen aus public/index.html heraus und
 * fuehren sie gegen Attrappen aus.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (bedingung, text) => { assert.ok(bedingung, text); checks++; };

// ── Ausschnitte ──────────────────────────────────────────────────────────
function funktion(name, praefix = "function ") {
  const kopf = "\n" + praefix + name + "(";
  const a = index.indexOf(kopf);
  ok(a > 0, `${name} wurde in public/index.html nicht gefunden`);
  const ende = praefix.startsWith("  ") ? "\n  }\n" : "\n}\n";
  return index.slice(a, index.indexOf(ende, a) + ende.length);
}
// Optional: auf einem aelteren Stand fehlt unionDeleteLogs noch. Ohne diese
// Nachsicht scheiterte die Gegenprobe am fehlenden NAMEN statt am Verhalten —
// durchgefallen aus dem falschen Grund. So laeuft der alte Code echt weiter und
// zeigt, was er mit dem Grabstein wirklich macht.
function funktionOptional(name) {
  return index.indexOf("\nfunction " + name + "(") > 0 ? funktion(name) : "";
}
const KERN = ["getDeleteLog", "logDeletion", "ownEntity", "getEntity", "deleteEntity"]
  .map((n) => funktion(n)).join("\n");
const NOTEFLOW = funktion("deleteNote", "  function ");

// ── localStorage-Attrappe ────────────────────────────────────────────────
function speicher() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

// Kern-CRUD mit echtem deleteEntity/logDeletion gegen Attrappen
function kern({ notes = {}, pinnedItems = [], localStorage: ls = speicher() } = {}) {
  const APP = { state: { data: { entities: { notes }, meta: {}, pinnedItems }, undoStack: [] } };
  const protokoll = { saves: 0, aktivitaet: [] };
  const api = new Function(
    "APP", "localStorage", "getEntityMap", "uuid", "nowIso", "logActivity", "scheduleSave",
    "deepClone", "updateUndoButton", "cleanupLinks", "JSON",
    KERN + "\nreturn { deleteEntity, logDeletion, getDeleteLog };")(
    APP, ls, (k) => (k === "note" ? APP.state.data.entities.notes : null), () => "uuid", () => "jetzt",
    (...a) => protokoll.aktivitaet.push(a), () => { protokoll.saves++; },
    (o) => JSON.parse(JSON.stringify(o)), () => {}, () => {}, JSON);
  return { api, APP, notes, ls, protokoll };
}

// NoteFlow.deleteNote mit dem echten Kern dahinter
function noteflow({ notes = {}, pinnedItems = [], bestaetigen = true, beiConfirm = null } = {}) {
  const k = kern({ notes, pinnedItems });
  const protokoll = { toasts: [], gerendert: 0, nbSync: [], saves: 0 };
  const S = { noteId: null };
  const win = { APP: k.APP, deleteEntity: k.api.deleteEntity };
  const api = new Function(
    "window", "APP", "S", "notesMap", "syncNbArrays", "pinnedKey", "save", "toastMsg",
    "renderSidebar", "renderPage", "confirm", "console", "Object", "Array",
    NOTEFLOW + "\nreturn { deleteNote };")(
    win, k.APP, S, () => k.APP.state.data.entities.notes,
    (...a) => protokoll.nbSync.push(a), (id) => "note:" + id,
    () => { protokoll.saves++; },
    (t) => protokoll.toasts.push(t),
    () => { protokoll.gerendert++; }, () => { protokoll.gerendert++; },
    () => { if (beiConfirm) beiConfirm(); return bestaetigen; },
    { error() {}, warn() {} }, Object, Array);
  return { api, kern: k, S, protokoll, win };
}

const notiz = (id, ueber = {}) => ({
  id, title: "Seite " + id, notebookId: "nb1",
  createdAt: "2026-08-23T10:00:00.000Z", updatedAt: "2026-08-23T10:00:00.000Z", ...ueber,
});

// ── 1. NoteFlow loescht ueber deleteEntity und hinterlaesst einen Grabstein ──
{
  const notes = { n1: notiz("n1"), n2: notiz("n2") };
  const h = noteflow({ notes, pinnedItems: ["note:n1", "task:t9"] });
  h.api.deleteNote("n1");

  ok(!Object.prototype.hasOwnProperty.call(h.kern.notes, "n1"), "die Seite wurde nicht geloescht");
  ok(Object.keys(h.kern.notes).length === 1, "es wurde mehr als die eine Seite geloescht");

  const log = JSON.parse(h.kern.ls.getItem("_delete_log") || "{}");
  ok(log.note && log.note.n1 > 0,
    `es entstand KEIN Grabstein — genau der Produktionsfehler. Log: ${JSON.stringify(log)}`);
  ok(!log.note.n2, "es entstand ein Grabstein fuer die falsche Seite");

  ok(h.kern.APP.state.data.pinnedItems.join() === "task:t9",
    "deleteEntity hat den Favoriten-Eintrag note:n1 nicht entfernt");
  ok(h.protokoll.nbSync.length === 1 && h.protokoll.nbSync[0][0] === "n1",
    "die Notizbuch-Liste wurde nicht nachgezogen");
  ok(h.protokoll.toasts.includes("Seite gelöscht"), "die Rueckmeldung fehlt");
}

// ── 2. Abbruch im Bestaetigungsdialog aendert nichts ─────────────────────
{
  const notes = { n1: notiz("n1") };
  const h = noteflow({ notes, bestaetigen: false });
  h.api.deleteNote("n1");
  ok(Object.prototype.hasOwnProperty.call(h.kern.notes, "n1"), "Abbruch hat trotzdem geloescht");
  ok(h.kern.ls.getItem("_delete_log") === null, "Abbruch hinterliess einen Grabstein");
  ok(h.protokoll.nbSync.length === 0, "Abbruch zog die Notizbuch-Liste nach");
}

// ── 3. Unbekannte Id: kein Grabstein, keine Notizbuch-Aenderung ──────────
{
  const h = noteflow({ notes: { n1: notiz("n1") } });
  h.api.deleteNote("gibtsnicht");
  ok(h.kern.ls.getItem("_delete_log") === null, "fuer eine unbekannte Id entstand ein Grabstein");
  ok(Object.keys(h.kern.notes).length === 1, "eine unbekannte Id veraenderte den Bestand");
}

// ── 4. Fehlender Export bricht hoerbar ab, statt still ohne Grabstein zu loeschen ──
{
  const notes = { n1: notiz("n1") };
  const h = noteflow({ notes });
  delete h.win.deleteEntity;
  h.api.deleteNote("n1");
  ok(Object.prototype.hasOwnProperty.call(h.kern.notes, "n1"),
    "ohne window.deleteEntity wurde still ohne Grabstein geloescht");
  ok(h.protokoll.toasts.includes("Löschen nicht möglich"), "der Abbruch blieb unbemerkt");
}

// ── 5. Quelltextregeln ───────────────────────────────────────────────────
{
  ok(!/delete notesMap\(\)\[/.test(NOTEFLOW),
    "deleteNote loescht weiterhin direkt aus der Notizkarte");
  ok(/window\.deleteEntity\("note", zielId\)/.test(NOTEFLOW),
    "deleteNote geht nicht ueber den generischen Pfad mit fester Id");
  ok(/const zielId = String\(id \|\| ""\);/.test(NOTEFLOW),
    "die Id wird nicht im Moment der Nutzeraktion fixiert");
  ok(!/syncNbArrays\(id,/.test(NOTEFLOW) && /syncNbArrays\(zielId, notizbuchId, null\)/.test(NOTEFLOW),
    "die Notizbuch-Liste laeuft nicht ueber die feste Id und den Stand nach dem Dialog");
  ok(/logDeletion\(kind, id\)/.test(KERN), "deleteEntity legt keinen Grabstein an");
}

// ── 6. C1: Loeschen waehrend eines spaeten Abgleichs ─────────────────────
// Der Nutzer dupliziert eine Seite und loescht die Kopie. Waehrend der
// Bestaetigungsdialog offen steht, landet ein Wolken-Abgleich und ERSETZT
// APP.state.data vollstaendig — neue Objekte, andere Reihenfolge, und die
// Kopie ist inzwischen in ein anderes Notizbuch gewandert.
// Erwartet: das Original bleibt, genau die Kopie ist weg, ein Grabstein steht,
// und die Notizbuch-Liste wird am AKTUELLEN Notizbuch nachgezogen.
{
  const ORIG = "n-orig", KOPIE = "n-kopie";
  const notes = {
    [ORIG]: notiz(ORIG, { title: "London", notebookId: "nb-alt" }),
    [KOPIE]: notiz(KOPIE, { title: "London (Kopie)", notebookId: "nb-alt" }),
  };
  const h = noteflow({
    notes, pinnedItems: ["note:" + KOPIE, "note:" + ORIG],
    beiConfirm: () => {
      // der Abgleich: ein KOMPLETT neues Datenobjekt, wie es mergeData liefert
      h.kern.APP.state.data = {
        entities: {
          notes: {
            [KOPIE]: notiz(KOPIE, { title: "London (Kopie)", notebookId: "nb-neu",
              updatedAt: "2026-08-23T21:00:00.000Z" }),
            [ORIG]: notiz(ORIG, { title: "London", notebookId: "nb-alt",
              updatedAt: "2026-08-23T21:00:00.000Z" }),
          },
        },
        meta: {}, pinnedItems: ["note:" + KOPIE, "note:" + ORIG],
      };
    },
  });
  h.api.deleteNote(KOPIE);

  const uebrig = h.kern.APP.state.data.entities.notes;
  ok(Object.prototype.hasOwnProperty.call(uebrig, ORIG),
    "das Original wurde geloescht — der Abgleich hat das Loeschziel verschoben");
  ok(!Object.prototype.hasOwnProperty.call(uebrig, KOPIE),
    "die beabsichtigte Kopie ist noch da");
  ok(Object.keys(uebrig).length === 1,
    `nach dem Loeschen ${Object.keys(uebrig).length} Seiten statt einer`);

  const log = JSON.parse(h.kern.ls.getItem("_delete_log") || "{}");
  ok(log.note && log.note[KOPIE] > 0, "fuer die Kopie entstand kein Grabstein");
  ok(!log.note[ORIG], "fuer das Original entstand ein Grabstein");

  ok(h.kern.APP.state.data.pinnedItems.join() === "note:" + ORIG,
    "der Favoriten-Eintrag wurde nicht am neuen Datenstand geraeumt");
  ok(h.protokoll.nbSync.length === 1 && h.protokoll.nbSync[0][0] === KOPIE,
    "die Notizbuch-Liste wurde fuer die falsche Seite nachgezogen");
  ok(h.protokoll.nbSync[0][1] === "nb-neu",
    `die Notizbuch-Liste lief gegen "${h.protokoll.nbSync[0][1]}" statt gegen das ` +
    "aktuelle Notizbuch — die Angabe stammt aus der Referenz von VOR dem Dialog");
}

// ── 7. Waehrend des Dialogs von anderer Seite geloescht: sauber aufgeben ──
{
  const notes = { n1: notiz("n1") };
  const h = noteflow({
    notes,
    beiConfirm: () => { h.kern.APP.state.data = { entities: { notes: {} }, meta: {}, pinnedItems: [] }; },
  });
  h.api.deleteNote("n1");
  ok(h.protokoll.nbSync.length === 0,
    "es wurde eine Notizbuch-Liste fuer eine bereits verschwundene Seite nachgezogen");
  ok(h.kern.ls.getItem("_delete_log") === null,
    "fuer eine bereits verschwundene Seite entstand ein Grabstein");
}

// ── Merge-Seite: die ECHTEN Grabstein-Funktionen laden ───────────────────
// Anders als tests/sync-merge.test.mjs werden mergeAndPersistDeleteLog und
// flattenDeleteLog hier NICHT ausgestubbt — sie sind der Gegenstand.
function mergeLader(ls) {
  const a = index.indexOf("function mergeData(local, remote) {");
  const b = index.indexOf("\nfunction ", a + 10);
  ok(a > 0 && b > a, "mergeData wurde in index.html nicht gefunden");
  const tr = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const hilfen = funktionOptional("unionDeleteLogs") + "\n" +
    ["getDeleteLog", "mergeAndPersistDeleteLog", "flattenDeleteLog",
      "entityTimestamp", "mergeEntity"].map((n) => funktion(n)).join("\n");
  return new Function(
    "idbBackup", "localStorage", "normalizeData", "console", "JSON", "Date", "Number", "Object",
    index.slice(tr, index.indexOf("]);", tr) + 3) + "\n" + hilfen + "\n" +
    index.slice(a, b) +
    "\nreturn { mergeData, getDeleteLog, unionDeleteLogs: typeof unionDeleteLogs === 'function' ? unionDeleteLogs : null };")(
    () => {}, ls, (d) => d, { log() {}, warn() {} }, JSON, Date, Number, Object);
}

// buildRemoteAppPayload samt buildLocalAppSnapshot — der Push-Weg
function pushLader(ls, APP) {
  const hilfen = funktionOptional("unionDeleteLogs") + "\n" +
    ["getDeleteLog", "buildLocalAppSnapshot", "buildRemoteAppPayload"]
      .map((n) => funktion(n)).join("\n");
  return new Function(
    "APP", "localStorage", "safeJsonParse", "collectExtraLocalKeys", "getReadingHubShadowCache",
    "getOrCreateDeviceId", "_cloudHealth", "console", "JSON", "Date", "Number", "Object",
    hilfen + "\nreturn buildRemoteAppPayload;")(
    APP, ls, () => null, () => ({}), () => null, () => "dev-test", {}, { log() {}, warn() {} },
    JSON, Date, Number, Object);
}

const JETZT = Date.now();
const TAG = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// ── 8. Voll-Push eines stale Clients entfernt keinen fremden Grabstein ───
// Geraet A loescht eine Notiz und legt den Grabstein an. Geraet B kennt ihn
// nicht (leerer lokaler Speicher) und schreibt seinen kompletten Stand.
{
  const ls = speicher();                       // Geraet B: kein eigener Grabstein
  const { mergeData } = mergeLader(ls);
  const fremderGrabstein = { note: { "n-weg": JETZT - TAG } };

  const lokal = { entities: { notes: { "n-bleibt": notiz("n-bleibt") } } };
  const fern = {
    entities: { notes: { "n-bleibt": notiz("n-bleibt") } },
    _deleteLog: fremderGrabstein,
  };
  const m = mergeData(lokal, fern);

  ok(m._deleteLog && m._deleteLog.note && m._deleteLog.note["n-weg"] === JETZT - TAG,
    `der fremde Grabstein fehlt im gemergten Stand: ${JSON.stringify(m._deleteLog)}`);
  ok(JSON.parse(ls.getItem("_delete_log") || "{}").note?.["n-weg"] === JETZT - TAG,
    "der fremde Grabstein wurde nicht lokal uebernommen");

  // und der Voll-Push von B traegt ihn weiter
  const APP = { state: { data: m, settings: null, ui: {} } };
  const payload = pushLader(ls, APP)();
  ok(payload._deleteLog?.note?.["n-weg"] === JETZT - TAG,
    `der Voll-Push hat den fremden Grabstein entfernt: ${JSON.stringify(payload._deleteLog)}`);
}

// ── 8b. Auch wenn die localStorage-Schreibung still fehlschlaegt ─────────
// Beide Setter schlucken den Fehler in einem leeren catch (privater Modus,
// volles Kontingent). Dann traegt allein der Grabsteinstand in den Daten.
{
  const ls = speicher();
  ls.setItem = () => { throw new Error("QuotaExceeded"); };
  const { mergeData } = mergeLader(ls);
  const m = mergeData(
    { entities: { notes: {} } },
    { entities: { notes: {} }, _deleteLog: { note: { "n-weg": JETZT - TAG } } });
  ok(m._deleteLog?.note?.["n-weg"] === JETZT - TAG,
    "ohne funktionierenden localStorage geht der Grabstein im Merge verloren");

  const APP = { state: { data: m, settings: null, ui: {} } };
  const payload = pushLader(ls, APP)();
  ok(payload._deleteLog?.note?.["n-weg"] === JETZT - TAG,
    "ohne funktionierenden localStorage traegt der Push den Grabstein nicht weiter");
}

// ── 8c. Union ist eine Einbahnstrasse: nichts geht weg, spaeter gewinnt ──
{
  const ls = speicher();
  const { unionDeleteLogs } = mergeLader(ls);
  ok(typeof unionDeleteLogs === "function", "unionDeleteLogs fehlt");
  if (typeof unionDeleteLogs !== "function") throw new Error("unionDeleteLogs fehlt");
  const u = unionDeleteLogs(
    { note: { a: 100, b: 500 } },
    { note: { b: 200, c: 300 }, task: { t1: 700 } });
  ok(u.note.a === 100 && u.note.c === 300, "der Union hat einseitige Eintraege verloren");
  ok(u.note.b === 500, `bei einer Kollision gewann ${u.note.b} statt des spaeteren 500`);
  ok(u.task.t1 === 700, "ein ganzer Eimer ging verloren");
  ok(Object.keys(unionDeleteLogs(null, undefined)).length === 0, "leere Eingaben werfen");
  ok(!("x" in (unionDeleteLogs({ note: { x: 0 } }, null).note || {})),
    "ein Zeitstempel 0 wurde als gueltiger Grabstein uebernommen");
}

// ── 9. Wiederbelebung: gueltiger Grabstein schlaegt den fernen Datensatz ──
{
  const ls = speicher();
  ls.setItem("_delete_log", JSON.stringify({ note: { "n-tot": JETZT - 1000 } }));
  const { mergeData } = mergeLader(ls);
  const m = mergeData(
    { entities: { notes: {} } },
    { entities: { notes: {
      // ferner Stand ist AELTER als die Loeschung -> darf nicht wiederkommen
      "n-tot": notiz("n-tot", { updatedAt: iso(JETZT - 5000), createdAt: iso(JETZT - 6000) }),
      "n-lebt": notiz("n-lebt", { updatedAt: iso(JETZT - 500) }),
    } } });

  ok(!Object.prototype.hasOwnProperty.call(m.entities.notes, "n-tot"),
    "eine geloeschte Notiz wurde wiederbelebt");
  ok(Object.prototype.hasOwnProperty.call(m.entities.notes, "n-lebt"),
    "eine nicht geloeschte Notiz ging beim Merge verloren");
}

// ── 9b. Der Grabstein gilt NICHT rueckwirkend fuer eine neuere Fassung ───
// Wurde die Notiz nach der Loeschung anderswo erneut bearbeitet, gewinnt die
// Bearbeitung — sonst waere jede Neuanlage unter derselben Id verloren.
{
  const ls = speicher();
  ls.setItem("_delete_log", JSON.stringify({ note: { "n-neu": JETZT - 5000 } }));
  const { mergeData } = mergeLader(ls);
  const m = mergeData(
    { entities: { notes: {} } },
    { entities: { notes: { "n-neu": notiz("n-neu", { updatedAt: iso(JETZT - 100) }) } } });
  ok(Object.prototype.hasOwnProperty.call(m.entities.notes, "n-neu"),
    "eine nach der Loeschung bearbeitete Notiz wurde vom alten Grabstein getilgt");
}

// ── 10. Quelltextregeln zum Merge ───────────────────────────────────────
{
  const mA = index.indexOf("function mergeData(local, remote) {");
  const mergeSrc = index.slice(mA, index.indexOf("\nfunction ", mA + 10));
  ok(/merged\._deleteLog = JSON\.parse\(JSON\.stringify\(combinedDeleteLog\)\)/.test(mergeSrc),
    "mergeData legt den vereinten Grabsteinstand nicht in die gemergten Daten");
  ok(/unionDeleteLogs\(getDeleteLog\(\), APP\.state\.data && APP\.state\.data\._deleteLog\)/.test(index),
    "der Push vereint die beiden Grabsteinquellen nicht");
  ok(/tombTs > 0 && itemTs > 0 && tombTs > itemTs/.test(mergeSrc),
    "die Wiederbelebungssperre fehlt");
}

console.log(`delete tombstone: ok (${checks} Pruefungen)`);
