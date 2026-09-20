/*
 * Tagesbriefing v3, Baustein D — die echte Desktop-Grenze fuer geschuetzte
 * v3-Laufdaten.
 *
 * BEFUND: `mergeData()` hatte fuer `automation` (E1-Lease/Fenz, Idempotenz-
 * Ledger, Kostenbuchhaltung, B-Koordination: questionsById/answersById/
 * jobsById/evidenceById/sourceCursors/dataRevision) und
 * `dailyBriefing.assistantRuns` (Paket B: EIN Lauf je Kalendertag,
 * `revision`, `phase`, `finalEvaluation`, `sourceChecks`, `slotReceipts`)
 * KEINEN eigenen Zweig. Beide Wurzelschluessel existieren immer schon im
 * lokalen Klon, also griff auch der Auffangzweig am Ende von mergeData()
 * nie (er ergaenzt nur FEHLENDE Wurzelschluessel). Ein Desktop-Tab, der
 * laenger offen war als ein v3-Programmlauf dauert — die vier taeglichen
 * Termine liegen Stunden auseinander —, schrieb bei JEDER naechsten
 * Speicherung (ein abgehaktes Habit genuegt) seine VERALTETE Kopie zurueck:
 * eine Lease, die der Server laengst freigegeben hat, ein zurueckgesetzter
 * Fenz-Zaehler, ein Idempotenz-Ledger ohne die inzwischen verbuchten
 * Eintraege, ein bereits abgeschlossener Tag (`closeRun`), der wieder
 * offen erscheint.
 *
 * Dieser Test laesst die ECHTE Funktion aus `public/index.html` laufen —
 * exakt dieselbe Ausschneidetechnik wie `tests/sync-merge.test.mjs`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

function loadMergeData() {
  const start = index.indexOf("function mergeData(local, remote) {");
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, "mergeData() wurde in index.html nicht gefunden");
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  ok(trStart > 0, "TRANSPORT_ROOTS wurde in index.html nicht gefunden");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const atStart = index.indexOf("function applyTombstonesToList(list, tombstones) {");
  ok(atStart > 0, "applyTombstonesToList() wurde in index.html nicht gefunden");
  const atSrc = index.slice(atStart, index.indexOf("\n}\n", atStart) + 3);
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog",
    "flattenDeleteLog", "mergeEntity", "entityTimestamp", "console",
    atSrc + "\n" + transportSrc + "\n" + index.slice(start, end) + "\nreturn mergeData;"
  );
  return fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {} }
  );
}
const mergeData = loadMergeData();

function basisBestand(over = {}) {
  return { entities: { tasks: {} }, ...over };
}

// ── 1. automation: der Server-Stand mit der hoeheren dataRevision gewinnt GANZ ──
{
  const local = basisBestand({
    automation: {
      schemaVersion: 3, dataRevision: 5,
      activeLease: { holder: "alter-scheduler", fence: 3, expiresAtMs: 1000 },
      idempotencyByKey: { "alt": { state: "committed" } },
      questionsById: {}, answersById: {}, jobsById: {}, evidenceById: {},
    },
  });
  const remote = basisBestand({
    automation: {
      schemaVersion: 3, dataRevision: 12,
      activeLease: null,
      idempotencyByKey: { "alt": { state: "committed" }, "neu": { state: "committed" } },
      questionsById: { q1: { id: "q1", status: "open" } }, answersById: {}, jobsById: {}, evidenceById: {},
    },
  });
  const m = mergeData(local, remote);
  ok(m.automation.dataRevision === 12,
    `Server-automation (dataRevision 12) haette gewinnen muessen, blieb aber bei ${m.automation.dataRevision}`);
  ok(m.automation.activeLease === null,
    "eine veraltete lokale Lease ueberlebte den Merge — genau der gemeldete Befund");
  ok(Object.keys(m.automation.idempotencyByKey).length === 2,
    "der neuere Idempotenz-Ledger-Eintrag fehlt nach dem Merge");
  ok(m.automation.questionsById.q1?.id === "q1", "die neuere Frage aus automation fehlt nach dem Merge");
}

// ── 2. automation: eine NIEDRIGERE Server-Revision darf lokal nicht verdraengen ──
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 20, activeLease: { holder: "ich", fence: 9 } } });
  const remote = basisBestand({ automation: { schemaVersion: 3, dataRevision: 7, activeLease: null } });
  const m = mergeData(local, remote);
  ok(m.automation.dataRevision === 20, "eine juengere lokale automation-Revision wurde durch eine aeltere Server-Kopie ersetzt");
  ok(m.automation.activeLease?.holder === "ich", "die aktuelle lokale Lease ging verloren");
}

// ── 3. automation: fehlt sie lokal, wird die Server-Kopie GANZ uebernommen ──
{
  const local = basisBestand({});
  const remote = basisBestand({ automation: { schemaVersion: 3, dataRevision: 3, activeLease: { holder: "server", fence: 1 } } });
  const m = mergeData(local, remote);
  ok(m.automation?.dataRevision === 3 && m.automation?.activeLease?.holder === "server",
    "eine Server-automation ohne lokales Gegenstueck wurde nicht uebernommen");
}

// ── 4. automation: kein Feld-fuer-Feld-Merge — die gewinnende Seite bleibt IN SICH KONSISTENT ──
{
  // Waere automation feld-fuer-Feld gemergt, koennte die lokale (aeltere)
  // Lease neben dem neueren Fenz-Zaehler des Servers landen — ein Zustand,
  // den keine Seite je hatte.
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 4, activeLease: { holder: "alt", fence: 1 }, runtime: { leaseFenceCounter: 1 } } });
  const remote = basisBestand({ automation: { schemaVersion: 3, dataRevision: 9, activeLease: { holder: "neu", fence: 4 }, runtime: { leaseFenceCounter: 4 } } });
  const m = mergeData(local, remote);
  ok(m.automation.activeLease.holder === "neu" && m.automation.runtime.leaseFenceCounter === 4,
    "Lease und Fenz-Zaehler stammen nicht konsistent von derselben (gewinnenden) Seite");
}

// ── 5. assistantRuns: je Kalendertag gewinnt die hoehere `revision` GANZ ──
{
  const local = basisBestand({
    dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: {
      "2026-09-20": { id: "run_2026-09-20", date: "2026-09-20", phase: "active", revision: 3, sourceChecks: {} },
    } },
  });
  const remote = basisBestand({
    dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: {
      "2026-09-20": { id: "run_2026-09-20", date: "2026-09-20", phase: "final", revision: 11,
        finalEvaluation: { coverage: "green", operations: "green" },
        sourceChecks: { "quantus-core": { outcome: "ok", checkedAt: "2026-09-20T22:00:00Z" } } },
    } },
  });
  const m = mergeData(local, remote);
  const run = m.dailyBriefing.assistantRuns["2026-09-20"];
  ok(run.revision === 11 && run.phase === "final",
    `ein bereits abgeschlossener Tag (revision 11) wurde durch die aeltere lokale Kopie (revision 3, phase active) ersetzt — actual: revision=${run.revision} phase=${run.phase}`);
  ok(run.finalEvaluation?.coverage === "green", "die Abschlussbewertung des Servers fehlt nach dem Merge");
  ok(run.sourceChecks["quantus-core"]?.outcome === "ok", "die Quellenpruefung des Servers fehlt nach dem Merge");
}

// ── 6. assistantRuns: eine juengere lokale Revision bleibt gegen einen aelteren Server-Stand stehen ──
{
  const local = basisBestand({ dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: {
    "2026-09-20": { id: "run_2026-09-20", date: "2026-09-20", phase: "final", revision: 15 },
  } } });
  const remote = basisBestand({ dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: {
    "2026-09-20": { id: "run_2026-09-20", date: "2026-09-20", phase: "active", revision: 6 },
  } } });
  const m = mergeData(local, remote);
  ok(m.dailyBriefing.assistantRuns["2026-09-20"].revision === 15,
    "eine aeltere Server-Kopie hat eine neuere lokale Kopie verdraengt");
}

// ── 7. assistantRuns: ein Tag, den nur der Server kennt, geht nicht verloren ──
{
  const local = basisBestand({ dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: {} } });
  const remote = basisBestand({ dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: {
    "2026-09-19": { id: "run_2026-09-19", date: "2026-09-19", phase: "final", revision: 8 },
  } } });
  const m = mergeData(local, remote);
  ok(m.dailyBriefing.assistantRuns["2026-09-19"]?.revision === 8, "ein nur serverseitig bekannter Lauf fehlt nach dem Merge");
}

// ── 8. Offline-Gegenprobe: ohne (gueltigen) Server-Stand bleibt lokal unveraendert ──
{
  const local = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 42, activeLease: { holder: "ich", fence: 2 } },
    dailyBriefing: { routines: [], dailyLog: {}, assistantRuns: { "2026-09-20": { id: "run_2026-09-20", revision: 7 } } },
  });
  for (const kaputterRemote of [null, undefined, {}, { entities: undefined }]) {
    const m = mergeData(local, kaputterRemote);
    ok(m === local || (m.automation?.dataRevision === 42 && m.dailyBriefing?.assistantRuns?.["2026-09-20"]?.revision === 7),
      "ein ungueltiger/fehlender Serverstand (offline) hat lokale v3-Daten veraendert");
  }
}

// ── 9. Reload-Gegenprobe: das Merge-Ergebnis ist das, was nach einem
//      Neuladen als lokaler Stand persistiert wuerde — nicht die alte
//      lokale Kopie, die vor dem Merge in localStorage lag. ────────────
{
  // Simuliert loadLocalData() -> (veraltete automation aus localStorage),
  // dann syncFreshness()/canonicalWrite() -> mergeData gegen den frischen
  // Serverstand. Das Ergebnis MUSS die Server-Revision tragen — sonst
  // wuerde ein Reload (das exakt diesen localStorage-Stand laedt) den
  // Server-Fortschritt erneut zuruecksetzen, sobald das Geraet das
  // naechste Mal speichert.
  const ausLocalStorageGeladen = basisBestand({ automation: { schemaVersion: 3, dataRevision: 2, activeLease: { holder: "vor-dem-neuladen", fence: 1 } } });
  const vomServerGelesen = basisBestand({ automation: { schemaVersion: 3, dataRevision: 30, activeLease: null } });
  const nachDemMerge = mergeData(ausLocalStorageGeladen, vomServerGelesen);
  ok(nachDemMerge.automation.dataRevision === 30 && nachDemMerge.automation.activeLease === null,
    "der Stand, der nach einem Neuladen erneut gespeichert wuerde, traegt noch die veraltete automation");
}

console.log(`quantus-v3-desktop-boundary: ${checks} Pruefungen bestanden.`);
