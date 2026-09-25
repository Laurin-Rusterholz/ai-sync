/*
 * Archivierung eines Habits fiel nach Reload/Pull zurueck, und die
 * No-Braine-Bruecke aktivierte bewusst archivierte Routinen wieder.
 * ---------------------------------------------------------------------------
 * Befund (24.09.2026, live reproduziert): Habits trugen fuer den Archiv-Status
 * bis dahin kein eigenes updatedAt — archiveHabit()/unarchiveHabit() setzten
 * nur h.archived. Zwei Folgefehler:
 *
 *   1. mergeRoutinesById() entscheidet den Merge-Gewinner per updatedAt (Fallback
 *      createdAt). Ohne updatedAt-Bump beim Archivieren hatten beide Seiten
 *      denselben (unveraenderten) createdAt-Zeitstempel — bei Gleichstand
 *      gewinnt in der Vereinigungsreihenfolge immer die zuerst eingelesene
 *      Seite. Ein Pull vom Server (oder ein Reload, der lokal/remote
 *      zusammenfuehrt) konnte die frische Archivierung so stillschweigend
 *      durch den aelteren, noch aktiven Stand ersetzen.
 *   2. reconcileHabits() (No-Braine-Bruecke) sitzt der Definition aus
 *      /nobraine/habitdefs unbedingt Vorrang: Ist die Definition dort noch
 *      aktiv, wurde eine lokal archivierte Routine bei jedem Sync wieder
 *      auf archived=false gesetzt — die bewusste Archivierung eines
 *      No-Braine-verknuepften Habits war so nie von Dauer.
 *
 * Der Fix: archiveHabit()/unarchiveHabit() setzen zusaetzlich ein eigenes Flag
 * (archivedByUser) und bumpen updatedAt. mergeRoutinesById() gewinnt jetzt
 * anhand des echten Zeitstempels. reconcileHabits() prueft archivedByUser VOR
 * jeder eigenen Entscheidung und laesst eine so markierte Routine unberuehrt —
 * in beide Richtungen (aktive wie deaktivierte Definition).
 *
 * Die Tests schneiden die ECHTEN Funktionen aus public/index.html heraus und
 * fuehren sie gegen Attrappen aus. Es werden keine echten Nutzerdaten angelegt
 * oder veraendert.
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

const HABIT = (extra = {}) => Object.assign({
  id: "rt_abc123", text: "Routine", icon: "✅", frequency: "daily", target: 1,
  archived: false, createdAt: "2026-01-05T08:00:00.000Z", completions: [],
}, extra);
const stand = (routinen, extra = {}) => Object.assign({
  entities: { tasks: {} },
  dailyBriefing: { routines: routinen, beliefs: [], sentItems: [], customRoutines: [] },
}, extra);

function archivierer() {
  const habits = { list: [] };
  const protokoll = { saves: 0, renders: 0 };
  const fn = (name, argnamen) => new Function("APP", "getHabits", "scheduleSave", "closeHabitEditor", "render", "toast", "window",
    fensterFunktion(name, argnamen) + `\nreturn window.${name};`,
  )({}, () => habits.list, () => { protokoll.saves++; }, () => {}, () => { protokoll.renders++; }, () => {}, {});
  return { habits, protokoll, archiveHabit: fn("archiveHabit", "habitId"), unarchiveHabit: fn("unarchiveHabit", "habitId") };
}

// ── 1. archiveHabit markiert die Archivierung als bewusst und bumpt updatedAt ──
{
  const { habits, archiveHabit, protokoll } = archivierer();
  habits.list.push(HABIT());
  const vor = Date.now();
  archiveHabit("rt_abc123");
  const h = habits.list[0];
  eq(h.archived, true, "archiveHabit setzt archived nicht");
  eq(h.archivedByUser, true, "archiveHabit setzt kein archivedByUser — die No-Braine-Bruecke kann die Archivierung nicht von einer blossen Definitions-Deaktivierung unterscheiden");
  ok(h.updatedAt && Date.parse(h.updatedAt) >= vor,
    "archiveHabit bumpt updatedAt nicht — ein Merge nach Zeitstempel kann die Archivierung nicht als neueste Aenderung erkennen");
  ok(protokoll.saves > 0, "archiveHabit stoesst kein Speichern an");
}

// ── 2. unarchiveHabit hebt die Markierung wieder auf und bumpt updatedAt ──────
{
  const { habits, unarchiveHabit } = archivierer();
  habits.list.push(HABIT({ archived: true, archivedByUser: true, updatedAt: "2026-01-06T08:00:00.000Z" }));
  const vor = Date.now();
  unarchiveHabit("rt_abc123");
  const h = habits.list[0];
  eq(h.archived, false, "unarchiveHabit hebt archived nicht auf");
  eq(h.archivedByUser, false, "unarchiveHabit hebt archivedByUser nicht auf — eine bewusste Reaktivierung bliebe fuer reconcileHabits unsichtbar markiert");
  ok(h.updatedAt && Date.parse(h.updatedAt) >= vor, "unarchiveHabit bumpt updatedAt nicht");
}

// ── 3. reconcileHabits laesst eine bewusst archivierte Routine unberuehrt,
//      auch wenn die No-Braine-Definition weiterhin aktiv ist ────────────────
// Das war der gemeldete Fall: No-Braine aktivierte alte Routinen wieder.
{
  const quelle = funktion("reconcileHabits", "  function ");
  const routinen = [HABIT({ id: "rt_nb_nb1", nbHabitId: "nb1", archived: true, archivedByUser: true, updatedAt: "2026-09-20T08:00:00.000Z" })];
  const b = { routines: routinen };
  const S = { defs: { nb1: { name: "Wasser trinken", icon: "💧", aktiv: true } }, log: {} };
  const fn = new Function("S", "brief", "window", "Date", "Number", "Object", "Array", "Math",
    quelle + "\nreturn reconcileHabits;",
  )(S, () => b, { getDeleteLog: () => ({}) }, Date, Number, Object, Array, Math);
  const changed = fn();
  eq(changed, false, "reconcileHabits meldet eine Aenderung, obwohl die Routine archivedByUser traegt");
  eq(routinen[0].archived, true,
    "reconcileHabits reaktiviert eine bewusst archivierte Routine, weil die No-Braine-Definition noch aktiv ist");
}

// ── 4. Dieselbe Sperre gilt, wenn die Definition inzwischen INAKTIV ist ──────
// (der andere Zweig von reconcileHabits — ohne die Sperre wuerde er nichts
// falsch machen, aber die Sperre muss vor BEIDEN Zweigen greifen, nicht nur
// vor dem Reaktivierungs-Zweig, sonst ist sie zufaellig statt strukturell.)
{
  const quelle = funktion("reconcileHabits", "  function ");
  const routinen = [HABIT({ id: "rt_nb_nb1", nbHabitId: "nb1", text: "Alter Name", archived: true, archivedByUser: true, updatedAt: "2026-09-20T08:00:00.000Z" })];
  const b = { routines: routinen };
  const S = { defs: { nb1: { name: "Neuer Name", icon: "💧", aktiv: false } }, log: {} };
  const fn = new Function("S", "brief", "window", "Date", "Number", "Object", "Array", "Math",
    quelle + "\nreturn reconcileHabits;",
  )(S, () => b, { getDeleteLog: () => ({}) }, Date, Number, Object, Array, Math);
  fn();
  eq(routinen[0].text, "Alter Name",
    "reconcileHabits schreibt trotz archivedByUser noch Feldaenderungen (name/icon) in die archivierte Routine");
}

// ── 5. Eine NICHT bewusst archivierte, aber deaktivierte Definition wird
//      weiterhin normal archiviert (die Sperre ist kein Freifahrtschein) ────
{
  const quelle = funktion("reconcileHabits", "  function ");
  const routinen = [HABIT({ id: "rt_nb_nb1", nbHabitId: "nb1", archived: false })];
  const b = { routines: routinen };
  const S = { defs: { nb1: { name: "Wasser trinken", icon: "💧", aktiv: false } }, log: {} };
  const fn = new Function("S", "brief", "window", "Date", "Number", "Object", "Array", "Math",
    quelle + "\nreturn reconcileHabits;",
  )(S, () => b, { getDeleteLog: () => ({}) }, Date, Number, Object, Array, Math);
  const changed = fn();
  eq(changed, true, "eine deaktivierte, nie bewusst archivierte Routine wird nicht mehr archiviert");
  eq(routinen[0].archived, true, "die Routine wurde nicht archiviert");
}

// ── 6. Merge: ein Pull vom Server darf eine frische Archivierung nicht
//      durch den aelteren, noch aktiven Stand eines alten Clients ersetzen ──
// "Alter Client" = kennt archivedByUser nicht, traegt kein updatedAt (genau
// der vor dem Fix bestehende Zustand).
{
  const ls = speicher();
  const mergeData = mergeMit(ls);
  const lokal = stand([HABIT({ archived: true, archivedByUser: true, updatedAt: "2026-09-24T07:00:00.000Z" })]);
  const serverAlterClient = stand([HABIT({ archived: false })]); // kein updatedAt, alter Client
  const m = mergeData(lokal, serverAlterClient);
  eq(m.dailyBriefing.routines[0].archived, true,
    "ein Pull vom Server (alter Client, kein updatedAt) macht die frische Archivierung rueckgaengig");
  eq(m.dailyBriefing.routines[0].archivedByUser, true,
    "das archivedByUser-Flag geht beim Merge verloren");
}

// ── 7. Umgekehrte Richtung: der Server traegt die frische Archivierung,
//      das lokale Geraet ist der alte Client — der Pull uebernimmt sie ──────
{
  const ls = speicher();
  const mergeData = mergeMit(ls);
  const lokalAlterClient = stand([HABIT({ archived: false })]); // kein updatedAt
  const serverNeu = stand([HABIT({ archived: true, archivedByUser: true, updatedAt: "2026-09-24T07:00:00.000Z" })]);
  const m = mergeData(lokalAlterClient, serverNeu);
  eq(m.dailyBriefing.routines[0].archived, true,
    "die auf dem anderen Geraet vorgenommene Archivierung kommt beim Pull nicht an");
}

// ── 8. Bewusste Reaktivierung nach Archivierung gewinnt (spaeterer Zeitstempel) ─
{
  const ls = speicher();
  const mergeData = mergeMit(ls);
  const lokal = stand([HABIT({ archived: true, archivedByUser: true, updatedAt: "2026-09-20T08:00:00.000Z" })]);
  const serverReaktiviert = stand([HABIT({ archived: false, archivedByUser: false, updatedAt: "2026-09-24T09:00:00.000Z" })]);
  const m = mergeData(lokal, serverReaktiviert);
  eq(m.dailyBriefing.routines[0].archived, false,
    "eine spaetere bewusste Reaktivierung auf einem anderen Geraet setzt sich beim Merge nicht durch");
  eq(m.dailyBriefing.routines[0].archivedByUser, false,
    "archivedByUser bleibt nach der Reaktivierung faelschlich gesetzt");
}

// ── 9. Completions beider Geraete bleiben trotz archivedByUser-Merge erhalten ─
{
  const ls = speicher();
  const mergeData = mergeMit(ls);
  const lokal = stand([HABIT({
    archived: true, archivedByUser: true, updatedAt: "2026-09-24T07:00:00.000Z",
    completions: [{ id: "hc_a", date: "2026-09-23", value: 1 }],
  })]);
  const server = stand([HABIT({
    archived: false, completions: [{ id: "hc_b", date: "2026-09-22", value: 1 }],
  })]);
  const m = mergeData(lokal, server);
  const daten = m.dailyBriefing.routines[0].completions.map((c) => c.date).sort().join(",");
  eq(daten, "2026-09-22,2026-09-23",
    `der Archivierungs-Fix verliert Abhak-Fortschritt beim Merge: [${daten}]`);
}

console.log(`habit-archivierung-nobraine: ok (${checks} Pruefungen)`);
