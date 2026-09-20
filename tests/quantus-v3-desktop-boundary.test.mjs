/*
 * Tagesbriefing v3, Baustein D — die echte Desktop-Grenze fuer geschuetzte
 * v3-Laufdaten. KORRIGIERTE FASSUNG (F-27).
 *
 * BEFUND an der vorigen Fassung dieses Zwecks (Commit 5a90b01, unabhaengig
 * geprueft, NICHT freigegeben): der damalige Zweig liess bei Gleichstand
 * oder hoeherer LOKALER `dataRevision`/`revision` die lokale Kopie gewinnen.
 * Vier Gegenproben mit der echten, extrahierten mergeData() zeigten, dass
 * das falsch ist, weil eine lokale Revisionszahl KEIN Beleg fuer einen
 * Servercommit ist — sie laesst sich mutieren, beliebig hochsetzen oder ist
 * nach einer Archivierung schlicht veraltet:
 *   (1) gleiche dataRevision, lokal veraendert  → lokal gewann (falsch)
 *   (2) lokal hochgesetzte Revision999 ggn. Server5 → lokal gewann (falsch)
 *   (3) Server assistantRuns={} nach Archivierung → alter lokaler Lauf kam
 *       zurueck (falsch, Wiederauferstehung eines entfernten Laufs)
 *   (4) Server ganz ohne v3-Namensraum → alte lokale automation/Laeufe
 *       blieben fuer einen Root-Upload erhalten (falsch, stiller Verlust
 *       fremder Aenderungen beim naechsten Push)
 *
 * KORREKTUR: kein Revisionsvergleich mehr. automation und
 * dailyBriefing.assistantRuns werden VERBATIM vom frisch gelesenen
 * Serverstand uebernommen, wenn er strukturell gueltig ist — auch ein
 * leerer/archivierter Stand zaehlt als gueltig und wird NICHT mit der
 * lokalen Kopie vereinigt. Fehlt der Serverstand komplett, waehrend lokal
 * ein nicht-leerer Namensraum existiert, markiert mergeData() das als
 * Luecke (`_v3ProtectedGap`) statt die lokale Kopie zu behalten — das
 * eigentliche Blockieren/Aufbewahren am Schreibpfad ist NICHT Sache dieser
 * Datei, siehe dazu tests/quantus-v3-protected-write-boundary.test.mjs
 * (echte canonicalWrite()/rtdbJsonPut()-Neuversuche).
 *
 * Dieser Test laesst die ECHTE Funktion aus `public/index.html` laufen —
 * dieselbe Ausschneidetechnik wie `tests/sync-merge.test.mjs`, erweitert um
 * die drei neuen Hilfsfunktionen, die mergeData() jetzt aufruft.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

function slice(marker, endMarker) {
  const start = index.indexOf(marker);
  ok(start > 0, `Marker nicht gefunden: ${marker}`);
  const end = index.indexOf(endMarker, start + marker.length);
  ok(end > start, `Endmarker nicht gefunden nach ${marker}: ${endMarker}`);
  return index.slice(start, end);
}

function loadMergeData() {
  const gapSrc = slice("function markV3ProtectedGap(merged, namespace) {", "\n// ── Main merge function ──");
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
    atSrc + "\n" + transportSrc + "\n" + gapSrc + "\n" + index.slice(start, end) + "\nreturn mergeData;"
  );
  return fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} }
  );
}
const mergeData = loadMergeData();

function basisBestand(over = {}) {
  return { entities: { tasks: {} }, ...over };
}
const gapsOf = (m) => (Array.isArray(m._v3ProtectedGap) ? m._v3ProtectedGap.slice() : null);

// ── Gegenprobe 1: gleiche dataRevision, lokal veraendert → Server gewinnt VERBATIM, keine Luecke ──
{
  const local = basisBestand({
    automation: {
      schemaVersion: 3, dataRevision: 5,
      activeLease: { holder: "lokaler-tab", fence: 99, expiresAtMs: 999999999 },
      idempotencyByKey: { alt: { state: "committed" }, geistereintrag: { state: "committed" } },
    },
  });
  const remote = basisBestand({
    automation: {
      schemaVersion: 3, dataRevision: 5,
      activeLease: null,
      idempotencyByKey: { alt: { state: "committed" } },
    },
  });
  const m = mergeData(local, remote);
  ok(m.automation.activeLease === null,
    "Gegenprobe 1: bei gleicher dataRevision haette der Server-Stand (activeLease:null) VERBATIM gelten muessen");
  ok(!("geistereintrag" in m.automation.idempotencyByKey),
    "Gegenprobe 1: der lokale Ledger-Eintrag haette NICHT ins Ergebnis gelangen duerfen");
  ok(gapsOf(m) === null, "Gegenprobe 1: bei vorhandenem Serverstand darf keine Luecke markiert werden");
}

// ── Gegenprobe 2: lokal hochgesetzte Revision999 gegen Server5 → Server gewinnt trotzdem VERBATIM ──
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 999, activeLease: { holder: "faelschung" } } });
  const remote = basisBestand({ automation: { schemaVersion: 3, dataRevision: 5, activeLease: null } });
  const m = mergeData(local, remote);
  ok(m.automation.dataRevision === 5,
    `Gegenprobe 2: eine lokale Revisionszahl ist kein Beleg — der Server-Stand (dataRevision5) haette gelten muessen, blieb aber bei ${m.automation.dataRevision}`);
  ok(m.automation.activeLease === null, "Gegenprobe 2: die gefaelschte lokale Lease haette nicht gewinnen duerfen");
  ok(gapsOf(m) === null, "Gegenprobe 2: bei vorhandenem Serverstand darf keine Luecke markiert werden");
}

// ── Gegenprobe 3: Server assistantRuns={} nach Archivierung → NICHT aus lokal wiederbeleben ──
{
  const local = basisBestand({
    dailyBriefing: { assistantRuns: { "2026-09-18": { revision: 7, phase: "closed", finalEvaluation: "alt-und-archiviert" } } },
  });
  const remote = basisBestand({ dailyBriefing: { assistantRuns: {} } });
  const m = mergeData(local, remote);
  ok(Object.keys(m.dailyBriefing.assistantRuns).length === 0,
    "Gegenprobe 3: ein archivierter, jetzt leerer Serverstand darf den entfernten Lauf NICHT wiederbeleben");
  ok(gapsOf(m) === null, "Gegenprobe 3: ein leeres {} vom Server ist ein gueltiger, kein fehlender Stand — keine Luecke");
}

// ── Gegenprobe 4: Server ganz ohne v3-Namensraum → Luecke, NICHT die lokale Kopie behalten/hochladen ──
{
  const local = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 42, activeLease: { holder: "alt" } },
    dailyBriefing: { assistantRuns: { "2026-09-19": { revision: 3, phase: "open" } } },
  });
  const remote = basisBestand({}); // altes Server-Backend, kennt weder automation noch dailyBriefing
  const m = mergeData(local, remote);
  const gaps = gapsOf(m);
  ok(Array.isArray(gaps) && gaps.includes("automation") && gaps.includes("assistantRuns"),
    `Gegenprobe 4: fehlender v3-Namensraum bei nicht-leerem lokalen Stand haette eine Luecke markieren muessen, war aber ${JSON.stringify(gaps)}`);
  // Die lokale Kopie bleibt im Rueckgabewert NUR zur Aufbewahrung/Anzeige
  // stehen — ob daraus tatsaechlich NICHT geschrieben wird, entscheidet der
  // Schreibpfad (guardV3ProtectedWrite), nicht mergeData() selbst.
  ok(m.automation.dataRevision === 42, "Gegenprobe 4: die lokale Kopie bleibt im Merge-Ergebnis fuer die Aufbewahrung erhalten");
}

// ── Randfaelle, die weiterhin gelten muessen ──
{
  // Ein leerer lokaler automation-Stand ({}) ist NICHT "nicht-leer" — bei
  // fehlendem Serverstand darf dafuer keine Luecke markiert werden (nichts
  // Bedeutsames stuende sonst zur Aufbewahrung an).
  const local = basisBestand({ automation: {} });
  const remote = basisBestand({});
  const m = mergeData(local, remote);
  ok(gapsOf(m) === null, "Ein leerer lokaler automation-Stand darf bei fehlendem Server keine Luecke ausloesen");
}
{
  // Kein lokaler Namensraum + kein Server-Namensraum: unveraendert, keine Luecke.
  const local = basisBestand({});
  const remote = basisBestand({});
  const m = mergeData(local, remote);
  ok(gapsOf(m) === null, "Ohne lokalen oder fernen v3-Stand gibt es keine Luecke");
  ok(!("automation" in m), "Ohne jeden v3-Stand bleibt automation unberuehrt");
}
{
  // Offline-Gegenprobe: ein remote ohne entities laesst local unangetastet
  // zurueckgeben (mergeData()s eigene Fruehsperre) — automation/assistantRuns
  // werden dabei erst gar nicht angefasst.
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1 } });
  const m = mergeData(local, { entities: null });
  ok(m === local, "Offline-Gegenprobe: ein ungueltiger Fernstand muss local unveraendert zurueckgeben");
}

console.log(`quantus-v3-desktop-boundary: ${checks} checks passed`);
