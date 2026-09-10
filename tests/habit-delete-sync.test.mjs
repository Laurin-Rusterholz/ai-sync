/*
 * Geloeschte Habits kamen zurueck — auf Browser, Handy und Tablet.
 * ---------------------------------------------------------------------------
 * Befund (10.09.2026): Eine in der Habits-App geloeschte Routine stand nach dem
 * naechsten Herunterladen/Zusammenfuehren wieder da; auf einem zweiten Geraet
 * ohnehin. Drei Ursachen, die zusammenwirkten:
 *
 *   1. deleteHabit() loeschte nur aus dem lokalen Array — OHNE Grabstein.
 *      Ohne Grabstein liest mergeData eine fehlende id schlicht als „auf der
 *      Gegenseite neu" und nimmt sie wieder auf.
 *   2. mergeData() fragte die Grabsteine nur fuer die Entity-Sammlungen ab.
 *      Die Habits liegen in dailyBriefing.routines — einer LISTE, die per id
 *      vereinigt wurde. Selbst ein vorhandener Grabstein blieb dort wirkungslos.
 *   3. Die No-Braine-Bruecke legt zu jeder /nobraine/habitdefs-Definition eine
 *      Routine an, wenn keine mit dieser nbHabitId existiert. Fuer verknuepfte
 *      Habits war die Loeschung damit binnen 200 ms rueckgaengig gemacht —
 *      noch vor jedem Abgleich.
 *
 * Die Regel, die jetzt ueberall gilt (dieselbe wie bei den Entities):
 *   Der Grabstein gewinnt, wenn sein Zeitstempel ECHT NEUER ist als der des
 *   Eintrags. Damit kann ein aelterer Client- oder Serverstand eine Loeschung
 *   nicht rueckgaengig machen, eine spaetere bewusste Aenderung dagegen schon —
 *   und der Ausgang haengt nicht davon ab, wer zuerst synchronisiert.
 *
 * Die Tests schneiden die ECHTEN Funktionen aus public/index.html heraus und
 * fuehren sie gegen Attrappen aus. Es werden KEINE Habit-Inhalte angelegt oder
 * veraendert — die Testdaten leben nur im Speicher dieses Prozesses.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (bedingung, text) => { assert.ok(bedingung, text); checks++; };
const eq = (a, b, text) => { assert.equal(a, b, text); checks++; };

// ── Ausschnitte ───────────────────────────────────────────────────────────
function funktion(name, praefix = "function ") {
  const kopf = "\n" + praefix + name + "(";
  const a = index.indexOf(kopf);
  ok(a > 0, `${name}() wurde in public/index.html nicht gefunden`);
  const ende = praefix.startsWith("  ") ? "\n  }\n" : "\n}\n";
  return index.slice(a, index.indexOf(ende, a) + ende.length);
}
function fensterFunktion(name, argumente) {
  const kopf = "\nwindow." + name + " = function(" + argumente + ") {";
  const a = index.indexOf(kopf);
  ok(a > 0, `window.${name} wurde in public/index.html nicht gefunden`);
  const ende = "\n};\n";
  return index.slice(a, index.indexOf(ende, a) + ende.length);
}

// localStorage-Attrappe: der Grabsteinspeicher.
function speicher() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

const GRAB = ["getDeleteLog", "logDeletion", "mergeAndPersistDeleteLog", "unionDeleteLogs",
  "flattenDeleteLog", "entityTimestamp", "applyTombstonesToList"].map((n) => funktion(n)).join("\n");

function grabsteine(ls = speicher()) {
  const api = new Function("localStorage", "JSON", "Date", "Number", "Object", "Array",
    GRAB + "\nreturn { getDeleteLog, logDeletion, mergeAndPersistDeleteLog, unionDeleteLogs, flattenDeleteLog, entityTimestamp, applyTombstonesToList };",
  )(ls, JSON, Date, Number, Object, Array);
  return { api, ls };
}

// Die echte mergeData mit echten Grabstein-Funktionen dahinter.
function mergeMit(ls) {
  const start = index.indexOf("function mergeData(local, remote) {");
  ok(start > 0, "mergeData() wurde nicht gefunden");
  const ende = index.indexOf("\nfunction ", start + 10);
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const quelle = transportSrc + "\n" + GRAB + "\n" + index.slice(start, ende) + "\nreturn mergeData;";
  return new Function("idbBackup", "localStorage", "normalizeData", "mergeEntity", "console", "JSON", "Date", "Number", "Object", "Array", "Set",
    quelle,
  )(() => {}, ls, (d) => d, (a, b) => ((Number(new Date(b?.updatedAt || b?.createdAt || 0)) > Number(new Date(a?.updatedAt || a?.createdAt || 0))) ? b : a),
    { log() {}, warn() {} }, JSON, Date, Number, Object, Array, Set);
}

const T = (iso) => new Date(iso).getTime();
const HABIT = (extra = {}) => Object.assign({
  id: "rt_abc123", text: "Routine", icon: "✅", frequency: "daily", target: 1,
  archived: false, createdAt: "2026-01-05T08:00:00.000Z", completions: [],
}, extra);
const stand = (routinen, extra = {}) => Object.assign({
  entities: { tasks: {} },
  dailyBriefing: { routines: routinen, beliefs: [], sentItems: [], customRoutines: [] },
}, extra);

// ── 1. Loeschen setzt einen Grabstein ─────────────────────────────────────
{
  const ls = speicher();
  const { api } = grabsteine(ls);
  const routinen = [HABIT(), HABIT({ id: "rt_bleibt", text: "Bleibt" })];
  const APP = { state: { data: { dailyBriefing: { routines: routinen } } } };
  const protokoll = { toasts: 0, saves: 0 };
  // Der Ausschnitt weist sich selbst an window zu — deshalb bekommt er ein
  // eigenes window-Objekt und gibt die Funktion daraus zurueck.
  const fn = new Function("APP", "confirm", "getHabits", "scheduleSave", "closeHabitEditor", "render", "toast", "logDeletion", "window",
    fensterFunktion("deleteHabit", "habitId") + "\nreturn window.deleteHabit;",
  )(APP, () => true, () => APP.state.data.dailyBriefing.routines, () => { protokoll.saves++; },
    () => {}, () => {}, () => { protokoll.toasts++; }, api.logDeletion, {});
  fn("rt_abc123");

  eq(routinen.length, 1, "die Routine wurde gar nicht entfernt");
  eq(routinen[0].id, "rt_bleibt", "es wurde die falsche Routine entfernt");
  const log = api.getDeleteLog();
  ok(log.routine && log.routine.rt_abc123 > 0,
    "das Loeschen hinterlaesst keinen Grabstein — der naechste Abgleich holt die Routine zurueck");
  ok(protokoll.saves > 0, "das Loeschen stoesst kein Speichern an");
}

// ── 2. Der naechste Abgleich belebt sie nicht wieder ──────────────────────
{
  const ls = speicher();
  const { api } = grabsteine(ls);
  api.logDeletion("routine", "rt_abc123");
  const mergeData = mergeMit(ls);

  // Lokal geloescht, der Server kennt sie noch — genau der gemeldete Fall.
  const lokal = stand([HABIT({ id: "rt_bleibt", text: "Bleibt" })]);
  const server = stand([HABIT(), HABIT({ id: "rt_bleibt", text: "Bleibt" })]);
  const m = mergeData(lokal, server);
  const ids = m.dailyBriefing.routines.map((r) => r.id).sort().join(",");
  eq(ids, "rt_bleibt", `die geloeschte Routine ist zurueck: [${ids}]`);

  // Und beim naechsten Mal ebenso wenig (der Grabstein bleibt gespeichert).
  const m2 = mergeData(m, server);
  eq(m2.dailyBriefing.routines.map((r) => r.id).join(","), "rt_bleibt",
    "beim zweiten Abgleich kommt sie zurueck");
}

// ── 3. Das zweite Geraet lernt die Loeschung aus dem Datensatz ────────────
// Handy/Tablet haben die Routine lokal noch; der Grabstein reist im
// veroeffentlichten Stand (_deleteLog) mit.
{
  const ls = speicher();                         // dieses Geraet weiss nichts
  const mergeData = mergeMit(ls);
  const lokal = stand([HABIT()]);
  const server = stand([], { _deleteLog: { routine: { rt_abc123: T("2026-09-10T09:00:00.000Z") } } });
  const m = mergeData(lokal, server);
  eq(m.dailyBriefing.routines.length, 0,
    "das zweite Geraet behaelt die Routine, obwohl der Grabstein mitgeliefert wurde");
  const { api } = grabsteine(ls);
  ok(api.getDeleteLog().routine.rt_abc123 > 0,
    "der uebernommene Grabstein wird nicht gespeichert — beim naechsten Start waere er weg");
  ok(m._deleteLog && m._deleteLog.routine && m._deleteLog.routine.rt_abc123 > 0,
    "der gemergte Stand traegt den Grabstein nicht weiter");
}

// ── 4. Ein aelterer Serverstand kann nichts wiederbeleben ─────────────────
{
  const ls = speicher();
  const { api } = grabsteine(ls);
  api.logDeletion("routine", "rt_abc123");
  const mergeData = mergeMit(ls);
  // Ein Geraet, das lange offline war: alter Stand, alte Zeitstempel.
  const alterServer = stand([HABIT({
    createdAt: "2025-03-01T08:00:00.000Z",
    updatedAt: "2025-03-01T08:00:00.000Z",
    completions: [{ id: "hc_1", date: "2025-03-02", value: 1 }],
  })]);
  const m = mergeData(stand([]), alterServer);
  eq(m.dailyBriefing.routines.length, 0,
    "ein alter Serverstand belebt die geloeschte Routine wieder");
}

// ── 5. Ein Haken auf einem alten Geraet belebt sie ebenfalls nicht ────────
// Completions aendern updatedAt bewusst nicht: Wer auf einem Geraet abhakt,
// das die Loeschung noch nicht kennt, will die Routine nicht zurueckholen.
{
  const ls = speicher();
  const { api } = grabsteine(ls);
  api.logDeletion("routine", "rt_abc123");
  const mergeData = mergeMit(ls);
  const server = stand([HABIT({
    completions: [{ id: "hc_neu", date: "2026-09-10", value: 1 }],
  })]);
  eq(mergeData(stand([]), server).dailyBriefing.routines.length, 0,
    "ein frisch gesetzter Haken belebt die geloeschte Routine wieder");
}

// ── 6. Eine spaetere bewusste Aenderung gewinnt ───────────────────────────
// Die Umkehrung derselben Regel: Wer eine Routine NACH der Loeschung wieder
// bearbeitet, will sie behalten. Sonst waere der Grabstein eine Sackgasse.
{
  const ls = speicher();
  const { api } = grabsteine(ls);
  api.logDeletion("routine", "rt_abc123");
  const mergeData = mergeMit(ls);
  const spaeter = new Date(Date.now() + 60000).toISOString();
  const server = stand([HABIT({ updatedAt: spaeter, text: "Wieder aufgenommen" })]);
  const m = mergeData(stand([]), server);
  eq(m.dailyBriefing.routines.length, 1,
    "eine nach der Loeschung bearbeitete Routine wird trotzdem entfernt");
}

// ── 7. Nicht geloeschte Habits bleiben unangetastet ───────────────────────
// Der Abgleich darf keine Inhalte verlieren: Completions BEIDER Geraete bleiben.
{
  const ls = speicher();
  const mergeData = mergeMit(ls);
  const lokal = stand([HABIT({ completions: [{ id: "hc_a", date: "2026-09-08", value: 1 }] })]);
  const server = stand([HABIT({ completions: [{ id: "hc_b", date: "2026-09-09", value: 1 }] })]);
  const m = mergeData(lokal, server);
  eq(m.dailyBriefing.routines.length, 1, "die Routine verschwindet ohne jede Loeschung");
  const daten = m.dailyBriefing.routines[0].completions.map((c) => c.date).sort().join(",");
  eq(daten, "2026-09-08,2026-09-09",
    `der Abhak-Fortschritt eines Geraets geht verloren: [${daten}]`);
}

// ── 8. Die No-Braine-Bruecke legt eine geloeschte Routine nicht neu an ────
{
  const quelle = funktion("nbGeloescht", "  function ") + "\n" + funktion("reconcileHabits", "  function ");
  const ls = speicher();
  const { api } = grabsteine(ls);

  function bruecke(routinen, log) {
    const S = { defs: { nb1: { name: "Wasser trinken", icon: "💧", erstellt: "2026-01-01T08:00:00.000Z" } }, log: {} };
    const b = { routines: routinen };
    const fn = new Function("S", "brief", "window", "Date", "Number", "Object", "Array", "Math",
      quelle + "\nreturn reconcileHabits;",
    )(S, () => b, { getDeleteLog: () => log }, Date, Number, Object, Array, Math);
    fn();
    return routinen;
  }

  // Ohne Grabstein: Die Bruecke legt die Routine an (unveraendertes Verhalten).
  eq(bruecke([], {}).length, 1, "die Bruecke legt zu einer Definition gar keine Routine mehr an");

  // Mit Grabstein: Sie bleibt weg.
  api.logDeletion("routine", "rt_nb_nb1");
  const nachher = bruecke([], api.getDeleteLog());
  eq(nachher.length, 0,
    "die No-Braine-Bruecke legt die in Quantus geloeschte Routine sofort wieder an");

  // Eine Definition, die NACH der Loeschung entstanden ist, ist ein neuer
  // Vorsatz und darf erscheinen.
  const nbGeloescht = new Function("window", "Date", "Number", "Object", "Array",
    funktion("nbGeloescht", "  function ") + "\nreturn nbGeloescht;",
  )({ getDeleteLog: () => api.getDeleteLog() }, Date, Number, Object, Array);
  ok(nbGeloescht("rt_nb_nb1", "nb1", { erstellt: "2026-01-01T08:00:00.000Z" }) === true,
    "eine alte Definition ueberstimmt den Grabstein");
  ok(nbGeloescht("rt_nb_nb1", "nb1", { erstellt: new Date(Date.now() + 60000).toISOString() }) === false,
    "eine nach der Loeschung angelegte Definition bleibt gesperrt");
}

// ── 9. Alle Loeschwege setzen einen Grabstein ─────────────────────────────
// Sonst haette die Korrektur nur einen Knopf erreicht.
{
  ok(/window\.deleteHabit = function\(habitId\) \{[\s\S]*?logDeletion\('routine', habitId\);/.test(index),
    "deleteHabit setzt keinen Grabstein");
  ok(/idsToRemove\.forEach\(id => logDeletion\('routine', id\)\);/.test(index),
    "das Zusammenfuehren doppelter Routinen setzt keine Grabsteine — die Duplikate kommen zurueck");
  const dbRemove = index.split('case "db-remove-routine": {').slice(1);
  eq(dbRemove.length, 2, "die Zahl der „Routine entfernen“-Wege hat sich geaendert");
  dbRemove.forEach((teil, i) => {
    ok(/window\.logDeletion\("routine", el\.dataset\.id\)/.test(teil.slice(0, 800)),
      `der ${i + 1}. „Routine entfernen“-Weg setzt keinen Grabstein`);
  });
  ok(/window\.logDeletion\("routine", removed\.id\)/.test(index),
    "der KI-Befehl DELETE_HABIT setzt keinen Grabstein");
  ok(/window\.getDeleteLog = getDeleteLog;/.test(index),
    "getDeleteLog haengt nicht an window — die No-Braine-Bruecke kann die Grabsteine nicht lesen");
}

console.log(`habit-loeschsynchronisation: ok (${checks} Pruefungen)`);
