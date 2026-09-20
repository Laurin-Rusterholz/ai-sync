/*
 * Tagesbriefing v3, Baustein D — die echte Desktop-Grenze fuer geschuetzte
 * v3-Laufdaten. ZWEITE KORREKTUR (F-27, Runde 2).
 *
 * Runde 1 (Commit 5a90b01) liess die Seite mit der hoeheren Revision
 * gewinnen — vier Gegenproben zeigten, dass eine lokale Revisionszahl kein
 * Beleg fuer einen Servercommit ist. Runde 2 (ada9665, VERBATIM-Uebernahme
 * + Luecken-Markierung) wurde unabhaengig geprueft und mit fuenf weiteren
 * Befunden zurueckgewiesen — zwei davon betreffen mergeData() selbst:
 *
 *   C) remote.automation === {} bei lokal bereits initialisiertem v3-Kern
 *      (schemaVersion) wurde als gueltiger, leerer Serverstand VERBATIM
 *      uebernommen. Anders als assistantRuns (wo ein leeres {} eine echte
 *      Archivierung ist) hat automation IMMER schemaVersion+dataRevision,
 *      sobald v3 einmal geschrieben hat — ein {} oder ein Fragment ohne
 *      beide Felder ist strukturell dieselbe Luecke wie ein ganz fehlender
 *      Namensraum, keine gueltige Archivierung.
 *   D) ein vorhandener, GUELTIGER Serverstand mit abweichender lokaler
 *      Kopie fuehrte zum stillen Ueberschreiben — nur ein komplett
 *      fehlender Namensraum wurde markiert. Eine abweichende lokale Kopie
 *      neben einem gueltigen Serverstand ist aber potenziell echte, nie
 *      uebertragene Absicht und darf nicht wortlos verschwinden.
 *
 * Korrigiert: automation braucht jetzt schemaVersion+dataRevision, um als
 * gueltiger Serverstand zu zaehlen (assistantRuns bleibt bei "leer ist
 * gueltig"); und jede Abweichung zwischen einem tatsaechlich uebernommenen
 * Serverstand und der lokalen Kopie wird zusaetzlich markiert
 * (`_v3LocalDivergence`) — unabhaengig davon, ob es eine Luecke gibt.
 *
 * Dieser Test laesst die ECHTEN Funktionen aus `public/index.html` laufen —
 * dieselbe Ausschneidetechnik wie `tests/sync-merge.test.mjs`.
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
  // Der ganze Schutz-Helferblock (markV3ProtectedGap .. guardV3ProtectedWrite)
  // wird mitgeschnitten, auch wenn mergeData() selbst nur die beiden
  // mark*-Funktionen aufruft — die uebrigen (async, Netz-/IDB-Abhaengigkeiten)
  // muessen nur PARSEN, nie ausgefuehrt werden.
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
function slice(marker, endMarker) {
  const start = index.indexOf(marker);
  ok(start > 0, `Marker nicht gefunden: ${marker}`);
  const end = index.indexOf(endMarker, start + marker.length);
  ok(end > start, `Endmarker nicht gefunden nach ${marker}: ${endMarker}`);
  return index.slice(start, end);
}
const mergeData = loadMergeData();

function basisBestand(over = {}) {
  return { entities: { tasks: {} }, ...over };
}
const gapsOf = (m) => (Array.isArray(m._v3ProtectedGap) ? m._v3ProtectedGap.slice() : null);
const divergenceOf = (m) => (Array.isArray(m._v3LocalDivergence) ? m._v3LocalDivergence.slice() : null);
const namespacesOf = (div) => (div || []).map((e) => e.namespace);

// ── Gegenprobe 1: gleiche dataRevision, lokal veraendert → Server gewinnt VERBATIM, keine Luecke, aber Divergenz erhalten ──
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
  ok(namespacesOf(divergenceOf(m)).includes("automation"),
    "Gegenprobe 1 (D): die abweichende lokale automation-Kopie muss trotz Server-Sieg markiert werden, sonst verschwindet sie wortlos");
  const div = divergenceOf(m).find((e) => e.namespace === "automation");
  ok(div.snapshot.activeLease.holder === "lokaler-tab", "Gegenprobe 1 (D): die markierte Divergenz traegt nicht den echten lokalen Stand");
}

// ── Gegenprobe 2: lokal hochgesetzte Revision999 gegen Server5 → Server gewinnt trotzdem VERBATIM, Divergenz erhalten ──
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 999, activeLease: { holder: "faelschung" } } });
  const remote = basisBestand({ automation: { schemaVersion: 3, dataRevision: 5, activeLease: null } });
  const m = mergeData(local, remote);
  ok(m.automation.dataRevision === 5,
    `Gegenprobe 2: eine lokale Revisionszahl ist kein Beleg — der Server-Stand (dataRevision5) haette gelten muessen, blieb aber bei ${m.automation.dataRevision}`);
  ok(m.automation.activeLease === null, "Gegenprobe 2: die gefaelschte lokale Lease haette nicht gewinnen duerfen");
  ok(gapsOf(m) === null, "Gegenprobe 2: bei vorhandenem Serverstand darf keine Luecke markiert werden");
  ok(namespacesOf(divergenceOf(m)).includes("automation"),
    "Gegenprobe 2 (D): die gefaelschte, abweichende lokale Kopie muss dennoch separat erhalten bleiben");
}

// ── Gegenprobe 3: Server assistantRuns={} nach Archivierung → NICHT aus lokal wiederbeleben, aber Divergenz erhalten ──
{
  const local = basisBestand({
    dailyBriefing: { assistantRuns: { "2026-09-18": { revision: 7, phase: "closed", finalEvaluation: "alt-und-archiviert" } } },
  });
  const remote = basisBestand({ dailyBriefing: { assistantRuns: {} } });
  const m = mergeData(local, remote);
  ok(Object.keys(m.dailyBriefing.assistantRuns).length === 0,
    "Gegenprobe 3: ein archivierter, jetzt leerer Serverstand darf den entfernten Lauf NICHT wiederbeleben");
  ok(gapsOf(m) === null, "Gegenprobe 3: ein leeres {} vom Server ist ein gueltiger, kein fehlender Stand — keine Luecke");
  ok(namespacesOf(divergenceOf(m)).includes("assistantRuns"),
    "Gegenprobe 3 (D): der archivierte lokale Lauf muss separat erhalten bleiben, nicht spurlos verschwinden");
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
  ok(m.automation.dataRevision === 42, "Gegenprobe 4: die lokale Kopie bleibt im Merge-Ergebnis fuer die Aufbewahrung erhalten");
  ok(divergenceOf(m) === null, "Gegenprobe 4: ein reiner Luecken-Fall ist keine Divergenz — es gibt ja keinen uebernommenen Serverstand");
}

// ── Gegenprobe C: leeres/unvollstaendiges Server-automation ist KEINE gueltige Archivierung ──
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 12, activeLease: { holder: "lokal" }, idempotencyByKey: { a: 1 } } });
  const remote = basisBestand({ automation: {} }); // leer — anders als assistantRuns KEIN gueltiger v3-Kern
  const m = mergeData(local, remote);
  ok(gapsOf(m)?.includes("automation"),
    `Gegenprobe C: ein leerer Server-automation-Stand bei initialisiertem lokalen Kern haette eine Luecke sein muessen, war aber ${JSON.stringify(gapsOf(m))}`);
  ok(m.automation.dataRevision === 12, "Gegenprobe C: die lokale Kopie bleibt zur Aufbewahrung erhalten, nicht durch {} ersetzt");
}
{
  // Auch ein Fragment ohne dataRevision (nur schemaVersion) ist kein gueltiger Kern.
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 12 } });
  const remote = basisBestand({ automation: { schemaVersion: 3 } }); // dataRevision fehlt
  const m = mergeData(local, remote);
  ok(gapsOf(m)?.includes("automation"), "Gegenprobe C: ein automation-Fragment ohne dataRevision haette eine Luecke sein muessen");
}
{
  // assistantRuns bleibt bei "leer ist gueltig" — die C-Korrektur gilt NICHT dort.
  const local = basisBestand({ dailyBriefing: { assistantRuns: { "2026-09-18": { revision: 1 } } } });
  const remote = basisBestand({ dailyBriefing: { assistantRuns: {} } });
  const m = mergeData(local, remote);
  ok(gapsOf(m) === null, "Gegenprobe C (Kontrast): ein leeres assistantRuns bleibt weiterhin eine gueltige Archivierung, keine Luecke");
}

// ── Gegenprobe D: gueltiger Serverstand + abweichende lokale Antwort → Server gewinnt, lokale Abweichung separat erhalten ──
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 8, questionsById: { q1: { status: "answered-locally-only" } } } });
  const remote = basisBestand({ automation: { schemaVersion: 3, dataRevision: 9, questionsById: {} } });
  const m = mergeData(local, remote);
  ok(m.automation.dataRevision === 9 && Object.keys(m.automation.questionsById).length === 0,
    "Gegenprobe D: der gueltige Serverstand muss verbatim gelten");
  const div = divergenceOf(m);
  ok(namespacesOf(div).includes("automation"), "Gegenprobe D: die abweichende lokale Antwort muss separat markiert werden");
  ok(div.find((e) => e.namespace === "automation").snapshot.questionsById.q1.status === "answered-locally-only",
    "Gegenprobe D: die tatsaechliche lokale Absicht muss unverfaelscht in der Markierung stehen");
}
{
  // Identischer Inhalt (nur Objekt-Referenz unterschiedlich) darf KEINE Divergenz ausloesen.
  const gemeinsam = { schemaVersion: 3, dataRevision: 3, activeLease: null };
  const local = basisBestand({ automation: JSON.parse(JSON.stringify(gemeinsam)) });
  const remote = basisBestand({ automation: JSON.parse(JSON.stringify(gemeinsam)) });
  const m = mergeData(local, remote);
  ok(divergenceOf(m) === null, "Gegenprobe D (Kontrast): identischer Inhalt darf keine Divergenz ausloesen");
}

// ── Randfaelle, die weiterhin gelten muessen ──
{
  const local = basisBestand({ automation: {} });
  const remote = basisBestand({});
  const m = mergeData(local, remote);
  ok(gapsOf(m) === null, "Ein leerer lokaler automation-Stand darf bei fehlendem Server keine Luecke ausloesen");
}
{
  const local = basisBestand({});
  const remote = basisBestand({});
  const m = mergeData(local, remote);
  ok(gapsOf(m) === null, "Ohne lokalen oder fernen v3-Stand gibt es keine Luecke");
  ok(!("automation" in m), "Ohne jeden v3-Stand bleibt automation unberuehrt");
}
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1 } });
  const m = mergeData(local, { entities: null });
  ok(m === local, "Offline-Gegenprobe: ein ungueltiger Fernstand muss local unveraendert zurueckgeben");
}

console.log(`quantus-v3-desktop-boundary: ${checks} checks passed`);
