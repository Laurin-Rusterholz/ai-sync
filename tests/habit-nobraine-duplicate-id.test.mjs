/*
 * No-Braine-Bruecke erzeugte fuer verschiedene Definitionen dieselbe
 * Routine-Id — jede Habit-Karte oeffnete dieselbe (falsche) Routine.
 * ---------------------------------------------------------------------------
 * Befund (25.09.2026, live reproduziert): "Bewegung", "Lesen" und "Früh
 * schlafen" zeigten im DOM alle onclick="openHabitEditor('rt_nb_-Own62y4VzfB')"
 * — derselben Id wie "Wasser trinken". Ursache: reconcileHabits() kuerzte die
 * Routine-Id auf "rt_nb_"+String(nbHabitId).slice(0,12). Mehrere No-Braine-
 * Definitionen mit gemeinsamem 12-Zeichen-Praefix (z. B. Firebase-Push-Ids,
 * deren fuehrende Zeichen den Zeitstempel codieren) kollabierten dadurch auf
 * dasselbe .id-Feld — die ZUORDNUNG ueber nbHabitId blieb dabei korrekt
 * getrennt (jede Routine behielt ihren eigenen Text/eigene completions), nur
 * die sichtbare, anklickbare Id war identisch. openHabitEditor(h.id) (Zeile
 * "onclick=\"openHabitEditor('${h.id}')\"") oeffnete deshalb bei jedem Klick
 * dieselbe Routine.
 *
 * Fix: die vollstaendige nbHabitId fliesst ungekuerzt in die Id ein (kuenftig
 * kollisionsfrei, da nbHabitId je Definition eindeutig ist). Bestehende,
 * bereits kollidierende Datensaetze werden beim naechsten Lauf von
 * reconcileHabits() verlustfrei IN PLACE umbenannt (keine Neuanlage, kein
 * Verlust von completions/Text/archiviert-Status) — sowohl fuer aktive als
 * auch fuer bereits archivierte Routinen.
 *
 * Die Tests schneiden die ECHTE reconcileHabits() aus public/index.html heraus
 * und fuehren sie gegen Attrappen aus.
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

function funktion(name, praefix = "function ") {
  const kopf = "\n" + praefix + name + "(";
  const a = index.indexOf(kopf);
  ok(a > 0, `${name}() wurde in public/index.html nicht gefunden`);
  const ende = praefix.startsWith("  ") ? "\n  }\n" : "\n}\n";
  return index.slice(a, index.indexOf(ende, a) + ende.length);
}

function lauf(S, routinen) {
  const quelle = funktion("reconcileHabits", "  function ");
  const b = { routines: routinen };
  const fn = new Function("S", "brief", "window", "Date", "Number", "Object", "Array", "Math", "nbGeloescht",
    quelle + "\nreturn reconcileHabits;",
  )(S, () => b, { getDeleteLog: () => ({}) }, Date, Number, Object, Array, Math, () => false);
  return fn();
}

const ROUTINE = (extra = {}) => Object.assign({
  text: "Routine", icon: "🔁", color: "#3e8e87", frequency: "daily", customDays: [],
  target: 1, unit: "", subUnits: [], archived: false, createdAt: "2026-01-05T08:00:00.000Z",
  completions: [], subCompletions: [],
}, extra);

// ── 1. Drei aktive Routinen mit unterschiedlicher nbHabitId, aber (wie im
//      gemeldeten Fall) identischer, auf 12 Zeichen gekuerzter Alt-Id werden
//      verlustfrei auf ihre je eigene, vollstaendige Id umbenannt ──────────
{
  const geteilteAltId = "rt_nb_-Own62y4VzfB";
  const routinen = [
    ROUTINE({ id: geteilteAltId, nbHabitId: "-Own62y4VzfBbewegung01", text: "Bewegung", completions: [{ id: "hc1", date: "2026-09-20", value: 1 }] }),
    ROUTINE({ id: geteilteAltId, nbHabitId: "-Own62y4VzfBlesenxx02", text: "Lesen", completions: [{ id: "hc2", date: "2026-09-21", value: 1 }] }),
    ROUTINE({ id: geteilteAltId, nbHabitId: "-Own62y4VzfBschlafen3", text: "Früh schlafen", completions: [] }),
    ROUTINE({ id: geteilteAltId, nbHabitId: "-Own62y4VzfBwassertr4", text: "Wasser trinken", archived: true, archivedByUser: true, completions: [{ id: "hc4", date: "2026-09-19", value: 1 }] }),
  ];
  const S = {
    defs: {
      "-Own62y4VzfBbewegung01": { name: "Bewegung", icon: "🏃", aktiv: true },
      "-Own62y4VzfBlesenxx02": { name: "Lesen", icon: "📖", aktiv: true },
      "-Own62y4VzfBschlafen3": { name: "Früh schlafen", icon: "😴", aktiv: true },
      "-Own62y4VzfBwassertr4": { name: "Wasser trinken", icon: "💧", aktiv: true },
    },
    // /nobraine/habits gilt reconcileHabits() als Autoritaet fuer completions
    // (separater Abgleichs-Schritt, unabhaengig von der Id-Migration) — damit
    // dieser Test wirklich nur die Id-Migration prueft, muessen die hier
    // gesetzten completions auch dort als geschehen gefuehrt sein, sonst
    // wuerden sie vom Autoritaets-Abgleich (zu Recht) entfernt.
    log: {
      "2026-09-20": { "-Own62y4VzfBbewegung01": true },
      "2026-09-21": { "-Own62y4VzfBlesenxx02": true },
      "2026-09-19": { "-Own62y4VzfBwassertr4": true },
    },
  };
  const changed = lauf(S, routinen);
  ok(changed, "reconcileHabits meldet keine Aenderung, obwohl kollidierende Ids vorlagen");

  const ids = routinen.map((r) => r.id);
  eq(new Set(ids).size, 4, `nach der Migration muessen alle vier Routinen eine EIGENE Id tragen: ${JSON.stringify(ids)}`);
  ok(ids.every((id) => id !== geteilteAltId || ids.filter((x) => x === geteilteAltId).length <= 1),
    "die alte, kollidierende Id darf hoechstens noch einmal vorkommen");

  // Verlust pruefen: Text, completions UND der Archiv-Status muessen exakt
  // demselben Objekt zugeordnet bleiben wie vor der Migration — keine
  // Neuanlage, kein Vertauschen.
  const bewegung = routinen.find((r) => r.nbHabitId === "-Own62y4VzfBbewegung01");
  eq(bewegung.text, "Bewegung", "Bewegung verliert ihren Text bei der Migration");
  eq(bewegung.completions.length, 1, "Bewegung verliert ihre completions bei der Migration");
  eq(bewegung.id, "rt_nb_-Own62y4VzfBbewegung01", "Bewegung traegt nicht die vollstaendige, korrekte Id");

  const lesen = routinen.find((r) => r.nbHabitId === "-Own62y4VzfBlesenxx02");
  eq(lesen.id, "rt_nb_-Own62y4VzfBlesenxx02", "Lesen traegt nicht die vollstaendige, korrekte Id");
  eq(lesen.completions[0].id, "hc2", "Lesens completion wurde bei der Migration ausgetauscht");

  const wasser = routinen.find((r) => r.nbHabitId === "-Own62y4VzfBwassertr4");
  eq(wasser.archived, true, "Wasser trinken verliert seinen Archiv-Status bei der Migration (auch archivierte Routinen muessen migriert werden)");
  eq(wasser.id, "rt_nb_-Own62y4VzfBwassertr4", "Wasser trinken traegt nicht die vollstaendige, korrekte Id");
}

// ── 2. Idempotenz: ein zweiter Lauf nach erfolgreicher Migration aendert
//      nichts mehr (keine staendige Neu-Umbenennung, keine Endlosschleife) ──
{
  const routinen = [
    ROUTINE({ id: "rt_nb_abc123def456xyz", nbHabitId: "abc123def456xyz", text: "Bewegung" }),
  ];
  const S = { defs: { "abc123def456xyz": { name: "Bewegung", icon: "🏃", aktiv: true } }, log: {} };
  lauf(S, routinen); // erster Lauf: bereits korrekt, keine Migration noetig
  const idVorher = routinen[0].id;
  const changed = lauf(S, routinen); // zweiter Lauf
  eq(changed, false, "ein Lauf ohne echte Aenderung meldet faelschlich changed:true");
  eq(routinen[0].id, idVorher, "die Id aendert sich bei einem wiederholten Lauf ohne Anlass");
}

// ── 3. Eine neu angelegte Routine (noch keine bestehende) bekommt sofort die
//      vollstaendige, ungekuerzte Id — nicht erst nach einer spaeteren
//      Migration ─────────────────────────────────────────────────────────
{
  const routinen = [];
  const S = { defs: { "ganzLangeEindeutigeId9999": { name: "Neue Routine", icon: "🆕", aktiv: true } }, log: {} };
  lauf(S, routinen);
  eq(routinen.length, 1, "es wurde nicht genau eine neue Routine angelegt");
  eq(routinen[0].id, "rt_nb_ganzLangeEindeutigeId9999",
    `eine neu angelegte Routine traegt weiterhin eine gekuerzte Id: ${routinen[0].id}`);
}

// ── 4. Struktur-Beleg: die tatsaechlich VERGEBENE Id kuerzt nicht mehr auf
//      12 Zeichen — die alte, kuerzende Form darf NUR NOCH als zusaetzlicher
//      Grabstein-Kandidat (Rueckwaertskompatibilitaet, siehe Test 6) benutzt
//      werden, nie mehr fuer die Id selbst ─────────────────────────────────
{
  const quelle = funktion("reconcileHabits", "  function ");
  ok(/korrekteId\s*=\s*"rt_nb_"\s*\+\s*String\(id\)/.test(quelle),
    "reconcileHabits berechnet die vollstaendige Id nicht mehr ueber eine einzige, konsistente Formel (korrekteId)");
  ok(!/id\s*:\s*korrekteId[\s\S]{0,20}\.slice/.test(quelle) && !/r\.id\s*=\s*korrekteId\.slice/.test(quelle),
    "die tatsaechlich vergebene Id (korrekteId) wird noch irgendwo gekuerzt");
}

// ── 5. Merge-Beleg (Review vor Merge): zwei Geraete melden dieselbe
//      No-Braine-Definition mit VERSCHIEDENEN Ids — Geraet A hat bereits auf
//      die vollstaendige Id migriert, Geraet B sendet noch die alte,
//      gekuerzte Id. Der echte mergeRoutinesById() (aus mergeData()
//      herausgeschnitten) darf daraus NICHT zwei Routinen machen, und
//      Archiv-Status/Verlauf duerfen nicht verloren gehen oder vertauscht
//      werden ───────────────────────────────────────────────────────────
{
  function mergeRoutinesByIdFn() {
    const start = index.indexOf("const mergeRoutinesById = (localArr, remoteArr) => {");
    ok(start > 0, "mergeRoutinesById wurde nicht gefunden");
    const ende = index.indexOf("\n    };\n", start) + 6;
    const quelle = index.slice(start, ende);
    return new Function(quelle + "\nreturn mergeRoutinesById;")();
  }
  const mergeRoutinesById = mergeRoutinesByIdFn();

  const nbHabitId = "-Own62y4VzfBbewegung01";
  // Geraet A: bereits migriert (dieser Fix lief dort schon einmal durch),
  // neuerer Zeitstempel (Archivierung durch den Nutzer NACH der Migration).
  const geraetA = [{
    id: "rt_nb_" + nbHabitId, nbHabitId, text: "Bewegung", icon: "🏃",
    archived: true, archivedByUser: true, updatedAt: "2026-09-25T09:00:00.000Z", createdAt: "2026-01-05T08:00:00.000Z",
    completions: [{ id: "hcA", date: "2026-09-24", value: 1 }], subCompletions: [],
  }];
  // Geraet B: noch NICHT migriert — alte, gekuerzte Id, kein archivedByUser,
  // aber eine ANDERE completion (vor dem naechsten Sync auf diesem Geraet
  // eingetragen) — die muss trotz unterschiedlicher .id erhalten bleiben.
  const geraetB = [{
    id: "rt_nb_-Own62y4VzfB", nbHabitId, text: "Bewegung", icon: "🏃",
    archived: false, createdAt: "2026-01-05T08:00:00.000Z",
    completions: [{ id: "hcB", date: "2026-09-23", value: 1 }], subCompletions: [],
  }];

  const gemergt = mergeRoutinesById(geraetA, geraetB);
  eq(gemergt.length, 1, `zwei Geraete mit unterschiedlicher Id fuer dieselbe nbHabitId ergeben nach dem Merge mehr als EINE Routine — genau die vom Review befuerchtete Doppel-Routine: ${JSON.stringify(gemergt.map((r) => ({ id: r.id, nbHabitId: r.nbHabitId })))}`);
  const r = gemergt[0];
  eq(r.archived, true, "der Merge verliert den (neueren) Archiv-Status von Geraet A");
  eq(r.archivedByUser, true, "der Merge verliert das archivedByUser-Flag von Geraet A");
  const completionIds = r.completions.map((c) => c.id).sort();
  eq(completionIds.join(","), "hcA,hcB", `der Merge verliert completions eines der beiden Geraete: ${completionIds.join(",")}`);
}

// ── 6. Legacy-Grabstein-Beleg: eine Loeschung, die (vor diesem Fix) NUR unter
//      der damaligen, gekuerzten Id dokumentiert wurde (kein "nb:"-Schluessel,
//      z. B. ein sehr alter Grabstein), verhindert weiterhin die Neuanlage
//      nach dem Wechsel auf die vollstaendige Id ───────────────────────────
{
  const quelle = funktion("reconcileHabits", "  function ");
  const nbHabitId = "-Own62y4VzfBwassertr4";
  const alteKurzId = "rt_nb_" + nbHabitId.slice(0, 12); // exakt die frueher vergebene Id
  // Der Log enthaelt AUSSCHLIESSLICH die alte, kurze Id — kein "nb:"-Eintrag —
  // simuliert einen Grabstein aus der Zeit vor der Formel-Aenderung.
  const grabsteinLog = { routine: { [alteKurzId]: Date.now() } };
  const b = { routines: [] };
  const S = { defs: { [nbHabitId]: { name: "Wasser trinken", icon: "💧", aktiv: true, erstellt: "2020-01-01T00:00:00.000Z" } }, log: {} };
  const fn = new Function("S", "brief", "window", "Date", "Number", "Object", "Array", "Math", "nbGeloescht",
    // nbGeloescht() bewusst NICHT gestubbt — die ECHTE Funktion soll gegen
    // den simulierten Alt-Grabstein laufen.
    funktion("nbGeloescht", "  function ") + "\n" + quelle + "\nreturn reconcileHabits;",
  )(S, () => b, { getDeleteLog: () => grabsteinLog }, Date, Number, Object, Array, Math, undefined);
  fn();
  eq(b.routines.length, 0,
    "eine Loeschung, die nur unter der alten, gekuerzten Id dokumentiert ist, wird nach dem Formel-Wechsel ignoriert — die geloeschte Routine kommt zurueck");
}

console.log(`habit-nobraine-duplicate-id: ok (${checks} Pruefungen)`);
