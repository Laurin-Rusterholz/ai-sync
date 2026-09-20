/*
 * Tagesbriefing v3, Baustein D (Korrektur, F-27) — der geschuetzte
 * v3-Namensraum (automation, dailyBriefing.assistantRuns) am ECHTEN
 * Schreibpfad, nicht nur im Merge-Modell.
 *
 * tests/quantus-v3-desktop-boundary.test.mjs prueft bereits mergeData()
 * selbst gegen die vier Gegenproben. Dieser Test geht weiter, wie von der
 * Pruefung verlangt: er laesst die ECHTEN Funktionen `canonicalWrite()` und
 * `rtdbJsonPut()` aus public/index.html laufen (gleiche Ausschneidetechnik
 * wie sync-merge.test.mjs), mit injizierten Ersatzfunktionen nur fuer
 * Netzwerk-/Firebase-SDK-Blattabhaengigkeiten (Backoff, Auth-Zustand,
 * Provider-Verfuegbarkeit) — nie fuer die eigentliche Merge-/Schreiblogik.
 *
 * Geprueft wird:
 *  A) canonicalWrite(): wenn der frisch gelesene Serverstand den v3-Namens-
 *     raum nicht bestaetigt, waehrend die lokale Basis einen nicht-leeren
 *     traegt, wird NIE remotePutByKey() aufgerufen (kein Root-Upload) —
 *     canonicalWrite gibt stattdessen sichtbar `v3_protected_gap` zurueck.
 *  B) canonicalWrite(): wenn der Serverstand den Namensraum bestaetigt (auch
 *     einen archivierten/leeren), wird VERBATIM dessen Stand geschrieben —
 *     nicht der lokale, unabhaengig von jeder lokalen Revisionszahl.
 *  C) rtdbJsonPut(): der Abbruch wirkt bei JEDEM Aufruf des Transaktions-
 *     Callbacks — Firebase kann ihn bei Schreibkonkurrenz mehrfach mit
 *     wechselndem Serverstand aufrufen. Wird der Namensraum erst beim
 *     ZWEITEN Aufruf unbestaetigt, bricht GENAU DIESER Versuch ab; nichts
 *     wird committet.
 *  D) Die Aufbewahrung (retainV3ProtectedGapLocally, an
 *     openCommandQueue().retainLegacy() angebunden) wird bei jedem Abbruch
 *     tatsaechlich mit den betroffenen Namensraeumen aufgerufen — keine
 *     stillen Verluste.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

function sliceBetween(startMarker, afterStartOffset, endMarker) {
  const start = index.indexOf(startMarker);
  ok(start > 0, `Marker nicht gefunden: ${startMarker}`);
  const end = index.indexOf(endMarker, start + afterStartOffset);
  ok(end > start, `Endmarker nicht gefunden nach ${startMarker}: ${endMarker}`);
  return index.slice(start, end);
}

const sharedSrc = () => {
  const gapSrc = sliceBetween("function markV3ProtectedGap(merged, namespace) {", 10, "\n// ── Main merge function ──");
  const mdStart = index.indexOf("function mergeData(local, remote) {");
  const mdEnd = index.indexOf("\nfunction ", mdStart + 10);
  ok(mdStart > 0 && mdEnd > mdStart, "mergeData() wurde in index.html nicht gefunden");
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const atStart = index.indexOf("function applyTombstonesToList(list, tombstones) {");
  const atSrc = index.slice(atStart, index.indexOf("\n}\n", atStart) + 3);
  return transportSrc + "\n" + atSrc + "\n" + gapSrc + "\n" + index.slice(mdStart, mdEnd);
};

// ─── canonicalWrite() extrahieren ────────────────────────────────────────
function loadCanonicalWrite() {
  const cwMaxStart = index.indexOf("const CANONICAL_WRITE_MAX_ATTEMPTS = 2;");
  ok(cwMaxStart > 0, "CANONICAL_WRITE_MAX_ATTEMPTS wurde nicht gefunden");
  const cwMaxSrc = index.slice(cwMaxStart, index.indexOf(";", cwMaxStart) + 1);
  const cwStart = index.indexOf("async function canonicalWrite(quelle, options = {}) {");
  const cwEnd = index.indexOf("\nasync function remotePut(data, options = {}) {", cwStart);
  ok(cwStart > 0 && cwEnd > cwStart, "canonicalWrite() wurde nicht gefunden");
  const overrideRetain = "\nasync function retainV3ProtectedGapLocally(merged, gaps) { __retainCalls.push({ gaps: gaps.slice(), automation: merged.automation ? JSON.parse(JSON.stringify(merged.automation)) : null, assistantRuns: (merged.dailyBriefing && merged.dailyBriefing.assistantRuns) ? JSON.parse(JSON.stringify(merged.dailyBriefing.assistantRuns)) : null }); }\n";
  const src = sharedSrc() + "\n" + cwMaxSrc + "\n" + index.slice(cwStart, cwEnd) + overrideRetain
    + "\nreturn canonicalWrite;";
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "APP", "remoteGetByKey", "remotePutByKey",
    "primaryCloudProvider", "getOrCreateDeviceId", "__retainCalls",
    src
  );
  const retainCalls = [];
  const canonicalWrite = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    { state: { settings: { storage: { blobKey: "app-data.json" } } } },
    globalThis.__fakeRemoteGetByKey, (...a) => globalThis.__fakeRemotePutByKey(...a),
    () => "rtdb", () => "test-device", retainCalls
  );
  return { canonicalWrite, retainCalls };
}

// ─── rtdbJsonPut() extrahieren ───────────────────────────────────────────
function loadRtdbJsonPut() {
  const cwgStart = index.indexOf("function coreWriteGuard(fnName, key, options) {");
  const cwgSrc = index.slice(cwgStart, index.indexOf("\n}\n", cwgStart) + 3);
  const icdkStart = index.indexOf("function isCoreDataKey(key) {");
  const icdkSrc = index.slice(icdkStart, index.indexOf("\n}\n", icdkStart) + 3);
  const rjpStart = index.indexOf("async function rtdbJsonPut(key, data, options = {}) {");
  const rjpEnd = index.indexOf("\nfunction isCoreDataKey(key) {", rjpStart);
  ok(rjpStart > 0 && rjpEnd > rjpStart, "rtdbJsonPut() wurde nicht gefunden");
  const overrideRetain = "\nasync function retainV3ProtectedGapLocally(merged, gaps) { __retainCalls.push({ gaps: gaps.slice(), automation: merged.automation ? JSON.parse(JSON.stringify(merged.automation)) : null, assistantRuns: (merged.dailyBriefing && merged.dailyBriefing.assistantRuns) ? JSON.parse(JSON.stringify(merged.dailyBriefing.assistantRuns)) : null }); }\n";
  const src = sharedSrc() + "\n" + cwgSrc + "\n" + icdkSrc + "\n" + index.slice(rjpStart, rjpEnd) + overrideRetain
    + "\nreturn rtdbJsonPut;";
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "APP", "shouldTryCloudProvider", "coreAuthReady",
    "rememberCoreAuthRequired", "RTDB_NODE", "rtdbNodeKey", "rtdbDbRef", "getOrCreateDeviceId",
    "rememberCloudFailure", "rememberCloudSuccess", "isAuthDeniedError", "getDataTimestamp",
    "CORE_BLOB_KEY", "__retainCalls",
    src
  );
  const retainCalls = [];
  const rtdbJsonPut = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } },
    () => true, async () => ({ user: { uid: "test-uid" } }), () => {},
    "appStore", (k) => String(k).replace(/[.#$\[\]\/]/g, "_"), () => globalThis.__fakeRef,
    () => "test-device", () => {}, () => {}, () => false, (d) => Number(d?.meta?.updatedAt ? Date.parse(d.meta.updatedAt) : 0),
    "app-data.json", retainCalls
  );
  return { rtdbJsonPut, retainCalls };
}

function basisBestand(over = {}) {
  return { entities: { tasks: {} }, meta: {}, ...over };
}

// Fuer den Fake-Ref in Test C wird eine ECHTE, separat geladene mergeData()-
// Instanz gebraucht (dieselbe Ausschneidetechnik) — der Fake simuliert nur
// Firebase, nicht die Merge-/Luecken-Erkennung selbst.
{
  const gapSrc = sliceBetween("function markV3ProtectedGap(merged, namespace) {", 10, "\n// ── Main merge function ──");
  const mdStart = index.indexOf("function mergeData(local, remote) {");
  const mdEnd = index.indexOf("\nfunction ", mdStart + 10);
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const atStart = index.indexOf("function applyTombstonesToList(list, tombstones) {");
  const atSrc = index.slice(atStart, index.indexOf("\n}\n", atStart) + 3);
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console",
    atSrc + "\n" + transportSrc + "\n" + gapSrc + "\n" + index.slice(mdStart, mdEnd) + "\nreturn mergeData;"
  );
  globalThis.__mergeDataRef = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} }
  );
}

// ═══ A) canonicalWrite(): fehlender v3-Namensraum → NIE remotePutByKey, sichtbarer Abbruch ═══
{
  const local = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 42, activeLease: { holder: "alt" } },
    dailyBriefing: { assistantRuns: { "2026-09-19": { revision: 3, phase: "open" } } },
  });
  const remoteServerStand = basisBestand({}); // Server kennt weder automation noch assistantRuns
  let putCalled = false;
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async () => { putCalled = true; return { ok: true }; };
  const { canonicalWrite, retainCalls } = loadCanonicalWrite();
  const res = await canonicalWrite(local, {});
  ok(res.ok === false && res.reason === "v3_protected_gap",
    `canonicalWrite haette bei fehlendem v3-Namensraum ablehnen muessen, lieferte aber ${JSON.stringify(res)}`);
  ok(putCalled === false, "canonicalWrite darf bei einer Luecke NIEMALS remotePutByKey aufrufen (kein Root-Upload)");
  ok(retainCalls.length === 1 && retainCalls[0].gaps.includes("automation") && retainCalls[0].gaps.includes("assistantRuns"),
    `die Aufbewahrung haette fuer beide Namensraeume ausgeloest werden muessen: ${JSON.stringify(retainCalls)}`);
  ok(retainCalls[0].automation.dataRevision === 42, "die aufbewahrte Kopie muss den tatsaechlichen lokalen Stand tragen");
}

// ═══ B) canonicalWrite(): bestaetigter Serverstand → VERBATIM geschrieben, lokale Revision egal ═══
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 999, activeLease: { holder: "faelschung" } } });
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 5, activeLease: null } });
  let gesendet = null;
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async (key, data) => {
    gesendet = data;
    return { ok: true, data, casProof: { kind: "rtdb-transaction", committed: true, snapshot: {} } };
  };
  const { canonicalWrite, retainCalls } = loadCanonicalWrite();
  const res = await canonicalWrite(local, {});
  ok(res.ok === true, `canonicalWrite haette bei bestaetigtem Serverstand schreiben muessen: ${JSON.stringify(res)}`);
  ok(gesendet && gesendet.automation.dataRevision === 5,
    "der TATSAECHLICH gesendete Stand muss die Server-automation VERBATIM tragen, nicht die gefaelschte lokale Revision999");
  ok(retainCalls.length === 0, "ohne Luecke darf keine Aufbewahrung ausgeloest werden");
}

// ═══ C) rtdbJsonPut(): Abbruch bei JEDEM Transaktions-Neuversuch, nicht nur beim ersten ═══
{
  const local = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 1, activeLease: { holder: "lokal" } },
  });
  const remoteMitAutomation = basisBestand({ automation: { schemaVersion: 3, dataRevision: 9 } });
  const remoteOhneNamensraum = basisBestand({});
  let onCompleteArgs = null;
  let invocations = 0;
  globalThis.__fakeRef = {
    transaction(updateFn, onComplete) {
      invocations++;
      updateFn({ data: JSON.stringify(remoteMitAutomation) }); // 1. Aufruf: Server hat automation — kein Grund zum Abbruch
      const out2 = updateFn({ data: JSON.stringify(remoteOhneNamensraum) }); // 2. Aufruf (Firebase-interner Neuversuch): Server verliert den Namensraum
      invocations++;
      onCompleteArgs = out2 === undefined ? [null, false, null] : [null, true, { val: () => out2 }];
      onComplete(...onCompleteArgs);
    },
  };
  const { rtdbJsonPut, retainCalls } = loadRtdbJsonPut();
  const res = await rtdbJsonPut("app-data.json", local, { mergeFn: (l, r) => globalThis.__mergeDataRef(l, r), _viaCanonicalWrite: true });
  ok(invocations === 2, "der Fake-Ref muss den Callback zweimal aufgerufen haben (simulierter Neuversuch)");
  ok(res.ok === false && res.reason === "v3_protected_gap",
    `rtdbJsonPut haette beim ZWEITEN Aufruf abbrechen muessen (Server verlor automation), lieferte aber ${JSON.stringify(res)}`);
  ok(onCompleteArgs[1] === false, "die Transaktion darf NICHT als committet gemeldet werden");
  ok(retainCalls.length === 1 && retainCalls[0].gaps.includes("automation"),
    `die Aufbewahrung haette beim Abbruch ausgeloest werden muessen: ${JSON.stringify(retainCalls)}`);
}

console.log(`quantus-v3-protected-write-boundary: ${checks} checks passed`);
