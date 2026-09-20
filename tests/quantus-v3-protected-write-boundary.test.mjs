/*
 * Tagesbriefing v3, Baustein D (F-27, Runde 2) — der geschuetzte v3-
 * Namensraum am ECHTEN Schreibpfad, nach der zweiten unabhaengigen Ablehnung
 * von ada9665.
 *
 * ada9665 fuehrte guardV3ProtectedWrite() ein (Erkennung + Aufbewahrung in
 * einem Aufruf) und rief es SYNCHRON aus dem RTDB-Transaktions-Callback auf.
 * Fuenf Befunde:
 *   A) retainV3ProtectedGapLocally() meldete den Toast "getrennt aufbewahrt"
 *      UNABHAENGIG davon, ob die Warteschlange den Eintrag tatsaechlich
 *      committet hat — mit fehlendem Modul/Storage (der reale Zustand in
 *      jeder Umgebung ohne Browser-Kontext) blieb der Erfolg trotzdem
 *      behauptet.
 *   B) guardV3ProtectedWrite() ist ASYNC und wurde dennoch direkt im
 *      wiederholbaren CAS-Callback aufgerufen — der Rueckgabewert (ein
 *      Promise) ist IMMER wahr, `if (v3Luecke)` haette also JEDEN Aufruf
 *      als Luecke behandelt, ob echt oder nicht, und Firebase kann diesen
 *      Callback mehrfach mit wechselndem Serverstand aufrufen.
 *   C) remote.automation === {} bei lokal initialisiertem v3-Kern
 *      (schemaVersion vorhanden) wurde als gueltiger leerer Zustand
 *      VERBATIM uebernommen statt als Luecke behandelt.
 *   D) ein vorhandener, gueltiger Serverstand mit abweichender lokaler
 *      Kopie ueberschrieb lokal wortlos — nur der komplett fehlende
 *      Namensraum loeste retainLegacy() aus.
 *   E) die operationId wurde aus dem reinen Datenanteil gehasht, aber
 *      `capturedAt` (ein frischer Zeitstempel) stand im TATSAECHLICH
 *      kanonisierten legacyOperation-Objekt — ein identischer Wieder-
 *      holungsversuch loeste deshalb operation_id_conflict aus. Dazu ein
 *      kollidierbarer 32-Bit-Streuwert statt einer kollisionsarmen Kennung.
 *
 * Korrigiert in public/index.html:
 *  - mergeData(): automation braucht jetzt schemaVersion+dataRevision, um
 *    als gueltiger Serverstand zu zaehlen; jede Abweichung zwischen
 *    uebernommenem Serverstand und lokaler Kopie wird zusaetzlich markiert
 *    (`_v3LocalDivergence`, unabhaengig von einer Luecke).
 *  - Erkennung (detectV3ProtectedGap/detectV3LocalDivergence) ist jetzt
 *    REIN synchron ohne jede Seitenwirkung; die eigentliche Aufbewahrung
 *    (retainV3ProtectedGapLocally/retainV3LocalDivergenceQuietly) laeuft in
 *    rtdbJsonPut() ERST NACH der Transaktion, nie im Callback selbst.
 *  - retainV3DataLocally() meldet nur bei einem tatsaechlichen
 *    queue.retainLegacy()-Commit true; der Toast unterscheidet Erfolg von
 *    Fehlschlag, ein Fehlschlag wird NIE gedrosselt.
 *  - stableV3RetentionId() hasht per SHA-256 (statt eines 32-Bit-Streuwerts)
 *    ausschliesslich den kanonisierten legacyOperation-INHALT — kein
 *    capturedAt mehr darin, das "wann zuerst gesehen" liefert der
 *    Queue-Eintrag selbst (createdAt).
 *
 * Testtechnik: dieselbe Ausschneidetechnik wie tests/sync-merge.test.mjs.
 * Fuer den echten dynamischen `import('/quantus-v3-command-client.mjs')`
 * (ein root-relativer Pfad, der nur unter Netlify/im Browser aufloest) gilt:
 * ausserhalb dieser Umgebung schlaegt er REGULAER fehl (ERR_MODULE_NOT_FOUND)
 * — das ist exakt der Zustand, mit dem der Befund A reproduziert wurde
 * ("mit fehlendem Modul/Storage"), und Test A nutzt genau diesen echten,
 * unveraenderten Fehlschlag. Fuer den Erfolgsfall (Test E) wird die
 * Stabilitaet der Kennung UND die Wiederholungsvertraeglichkeit der echten
 * `openCommandQueue()/retainLegacy()` (fake-indexeddb, echtes Modul, echter
 * Import) direkt gegen exakt die Nutzlastform gepruft, die
 * retainV3DataLocally() tatsaechlich baut.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { openCommandQueue } from "../public/quantus-v3-command-client.mjs";

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
// Der gesamte Schutz-Helferblock: markV3ProtectedGap .. guardV3ProtectedWrite.
const helferBlockSrc = () => sliceBetween("function markV3ProtectedGap(merged, namespace) {", 10, "\n// ── Main merge function ──");
const mergeDataSrc = () => {
  const mdStart = index.indexOf("function mergeData(local, remote) {");
  const mdEnd = index.indexOf("\nfunction ", mdStart + 10);
  ok(mdStart > 0 && mdEnd > mdStart, "mergeData() wurde nicht gefunden");
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const atStart = index.indexOf("function applyTombstonesToList(list, tombstones) {");
  const atSrc = index.slice(atStart, index.indexOf("\n}\n", atStart) + 3);
  return transportSrc + "\n" + atSrc + "\n" + index.slice(mdStart, mdEnd);
};
const sharedSrc = () => helferBlockSrc() + "\n" + mergeDataSrc();
// Ueberschreibt NUR die beiden seiteneffektbehafteten Aufbewahrungsfunktionen
// (spaeter deklariert gewinnt in JS bei mehreren function-Deklarationen mit
// gleichem Namen im selben Scope) — Erkennung, guardV3ProtectedWrite und
// mergeData() bleiben die ECHTEN, unveraenderten Funktionen.
const spySrc = () => (
  "\nasync function retainV3ProtectedGapLocally(merged, gaps) { __calls.push({ art: 'gap', gaps: gaps.slice(), automation: merged.automation ? JSON.parse(JSON.stringify(merged.automation)) : null, assistantRuns: (merged.dailyBriefing && merged.dailyBriefing.assistantRuns) ? JSON.parse(JSON.stringify(merged.dailyBriefing.assistantRuns)) : null }); return true; }\n" +
  "async function retainV3LocalDivergenceQuietly(liste) { __calls.push({ art: 'divergenz', eintraege: JSON.parse(JSON.stringify(liste)) }); }\n"
);

// ─── canonicalWrite() extrahieren ────────────────────────────────────────
function loadCanonicalWrite() {
  const cwMaxSrc = index.slice(index.indexOf("const CANONICAL_WRITE_MAX_ATTEMPTS = 2;"), index.indexOf(";", index.indexOf("const CANONICAL_WRITE_MAX_ATTEMPTS = 2;")) + 1);
  const cwStart = index.indexOf("async function canonicalWrite(quelle, options = {}) {");
  const cwEnd = index.indexOf("\nasync function remotePut(data, options = {}) {", cwStart);
  ok(cwStart > 0 && cwEnd > cwStart, "canonicalWrite() wurde nicht gefunden");
  const src = sharedSrc() + "\n" + cwMaxSrc + "\n" + index.slice(cwStart, cwEnd) + spySrc() + "\nreturn canonicalWrite;";
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "APP", "remoteGetByKey", "remotePutByKey",
    "primaryCloudProvider", "getOrCreateDeviceId", "__calls",
    src
  );
  const calls = [];
  const canonicalWrite = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    { state: { settings: { storage: { blobKey: "app-data.json" } } } },
    globalThis.__fakeRemoteGetByKey, (...a) => globalThis.__fakeRemotePutByKey(...a),
    () => "rtdb", () => "test-device", calls
  );
  return { canonicalWrite, calls };
}

// ─── rtdbJsonPut() extrahieren ───────────────────────────────────────────
function loadRtdbJsonPut() {
  const cwgSrc = index.slice(index.indexOf("function coreWriteGuard(fnName, key, options) {"), index.indexOf("\n}\n", index.indexOf("function coreWriteGuard(fnName, key, options) {")) + 3);
  const icdkSrc = index.slice(index.indexOf("function isCoreDataKey(key) {"), index.indexOf("\n}\n", index.indexOf("function isCoreDataKey(key) {")) + 3);
  const rjpStart = index.indexOf("async function rtdbJsonPut(key, data, options = {}) {");
  const rjpEnd = index.indexOf("\nfunction isCoreDataKey(key) {", rjpStart);
  ok(rjpStart > 0 && rjpEnd > rjpStart, "rtdbJsonPut() wurde nicht gefunden");
  const callbackSrc = index.slice(index.indexOf("ref.transaction((current) => {", rjpStart), index.indexOf("}, false);", rjpStart));
  const src = sharedSrc() + "\n" + cwgSrc + "\n" + icdkSrc + "\n" + index.slice(rjpStart, rjpEnd) + spySrc() + "\nreturn rtdbJsonPut;";
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "APP", "shouldTryCloudProvider", "coreAuthReady",
    "rememberCoreAuthRequired", "RTDB_NODE", "rtdbNodeKey", "rtdbDbRef", "getOrCreateDeviceId",
    "rememberCloudFailure", "rememberCloudSuccess", "isAuthDeniedError", "getDataTimestamp",
    "CORE_BLOB_KEY", "__calls",
    src
  );
  const calls = [];
  const rtdbJsonPut = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } },
    () => true, async () => ({ user: { uid: "test-uid" } }), () => {},
    "appStore", (k) => String(k).replace(/[.#$\[\]\/]/g, "_"), () => globalThis.__fakeRef,
    () => "test-device", () => {}, () => {}, () => false, (d) => Number(d?.meta?.updatedAt ? Date.parse(d.meta.updatedAt) : 0),
    "app-data.json", calls
  );
  return { rtdbJsonPut, calls, callbackSrc };
}

function basisBestand(over = {}) {
  return { entities: { tasks: {} }, meta: {}, ...over };
}

// Echte, separat geladene mergeData()-Instanz fuer den Fake-Ref in Test B —
// der Fake simuliert nur Firebase, nicht die Merge-/Luecken-Erkennung.
const echteMergeData = new Function(
  "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
  "mergeEntity", "entityTimestamp", "console",
  sharedSrc() + "\nreturn mergeData;"
)(
  () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
  (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} }
);

// ═══ A) retainV3ProtectedGapLocally(): ECHTER Fehlschlag (fehlendes Modul) meldet NIE Erfolg ═══
{
  const src = sharedSrc() + "\nreturn { retainV3ProtectedGapLocally };";
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "coreAuthReady", "getOrCreateDeviceId", "toast",
    src
  );
  const toasts = [];
  const konsole = [];
  const api = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error: (...a) => konsole.push(a.join(" ")) },
    async () => ({ user: { uid: "u" } }), () => "dev", (...a) => toasts.push(a),
  );
  const original = { automation: { schemaVersion: 3, dataRevision: 7, activeLease: { holder: "original" } } };
  const originalKopie = JSON.parse(JSON.stringify(original));
  // Kein globalThis.indexedDB gesetzt und der root-relative Importpfad
  // aufloest ausserhalb von Netlify/Browser NICHT — echter Fehlschlag, keine
  // Attrappe.
  const result = await api.retainV3ProtectedGapLocally(original, ["automation"]);
  ok(result === false, `A: ein echter Fehlschlag (fehlendes Modul) haette false liefern muessen, lieferte ${result}`);
  ok(konsole.some((z) => /fehlgeschlagen/.test(z)), "A: der Fehlschlag wird nicht sichtbar geloggt");
  const [toastArt, toastTitel, toastText] = toasts[0] || [];
  ok(toasts.length === 1 && toastArt === "error",
    `A: bei einem echten Fehlschlag muss ein Fehler-Toast erscheinen, nicht Erfolg: ${JSON.stringify(toasts)}`);
  ok(!/getrennt aufbewahrt/.test(toastText || ""),
    "A: der Toast darf bei einem Fehlschlag NICHT behaupten, die Kopie sei aufbewahrt");
  ok(/NICHT aufbewahrt/.test(toastTitel || "") && /fehlgeschlagen/.test(toastText || ""),
    "A: der Toast muss den Fehlschlag explizit benennen");
  ok(JSON.stringify(original) === JSON.stringify(originalKopie),
    "A: das Original darf durch den Fehlschlag nicht veraendert werden");
}

// ═══ B) rtdbJsonPut(): der CAS-Callback bleibt rein — Sicherung erst danach, genau einmal ═══
{
  const { callbackSrc } = loadRtdbJsonPut();
  ok(!/\bawait\b/.test(callbackSrc),
    "B: der Transaktions-Callback enthaelt ein await — er muss rein synchron bleiben");
  ok(!/retainV3ProtectedGapLocally\(|retainV3LocalDivergenceQuietly\(|guardV3ProtectedWrite\(/.test(callbackSrc),
    "B: der Transaktions-Callback ruft eine seiteneffektbehaftete Aufbewahrungsfunktion direkt auf");
  ok(/detectV3ProtectedGap\(/.test(callbackSrc),
    "B: der Callback muss die reine Erkennung nutzen");

  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1, activeLease: { holder: "lokal" } } });
  const remoteMitAutomation = basisBestand({ automation: { schemaVersion: 3, dataRevision: 9 } });
  const remoteOhneNamensraum = basisBestand({});
  let invocations = 0;
  let committed = null;
  globalThis.__fakeRef = {
    transaction(updateFn, onComplete) {
      invocations++; updateFn({ data: JSON.stringify(remoteMitAutomation) }); // 1. Aufruf: kein Grund zum Abbruch
      invocations++;
      const out2 = updateFn({ data: JSON.stringify(remoteOhneNamensraum) }); // 2. Aufruf (Firebase-interner Neuversuch): Luecke
      committed = out2 !== undefined;
      onComplete(null, committed, committed ? { val: () => out2 } : null);
    },
  };
  const { rtdbJsonPut, calls } = loadRtdbJsonPut();
  const res = await rtdbJsonPut("app-data.json", local, { mergeFn: (l, r) => echteMergeData(l, r), _viaCanonicalWrite: true });
  ok(invocations === 2, "B: der Fake-Ref muss den Callback zweimal aufgerufen haben");
  ok(res.ok === false && res.reason === "v3_protected_gap", `B: rtdbJsonPut haette abbrechen muessen: ${JSON.stringify(res)}`);
  ok(committed === false, "B: die Transaktion darf NICHT committet werden");
  ok(calls.length === 1 && calls[0].art === "gap" && calls[0].gaps.includes("automation"),
    `B: die Aufbewahrung darf genau EINMAL laufen, erst nach der Transaktion: ${JSON.stringify(calls)}`);
}

// ═══ C) canonicalWrite(): leeres Server-automation bei initialisiertem lokalen Kern → Luecke, kein Upload ═══
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 42, activeLease: { holder: "alt" } } });
  const remoteServerStand = basisBestand({ automation: {} }); // leer — kein gueltiger v3-Kern
  let putCalled = false;
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async () => { putCalled = true; return { ok: true }; };
  const { canonicalWrite, calls } = loadCanonicalWrite();
  const res = await canonicalWrite(local, {});
  ok(res.ok === false && res.reason === "v3_protected_gap",
    `C: ein leerer Server-automation-Stand haette eine Luecke sein muessen: ${JSON.stringify(res)}`);
  ok(putCalled === false, "C: canonicalWrite darf bei einer Luecke NIEMALS remotePutByKey aufrufen");
  ok(calls.length === 1 && calls[0].art === "gap" && calls[0].automation.dataRevision === 42,
    `C: die Aufbewahrung haette den echten lokalen Kern tragen muessen: ${JSON.stringify(calls)}`);
}

// ═══ D) canonicalWrite(): gueltiger Serverstand + abweichende lokale Antwort → Server gewinnt, Divergenz separat erhalten ═══
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 8, questionsById: { q1: { status: "nur-lokal-beantwortet" } } } });
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 9, questionsById: {} } });
  let gesendet = null;
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async (key, data) => {
    gesendet = data;
    return { ok: true, data, casProof: { kind: "rtdb-transaction", committed: true, snapshot: {} } };
  };
  const { canonicalWrite, calls } = loadCanonicalWrite();
  const res = await canonicalWrite(local, {});
  ok(res.ok === true, `D: ein gueltiger Serverstand haette den Schreibvorgang nicht blockieren duerfen: ${JSON.stringify(res)}`);
  ok(gesendet && gesendet.automation.dataRevision === 9 && Object.keys(gesendet.automation.questionsById).length === 0,
    "D: der TATSAECHLICH gesendete Stand muss die Server-automation VERBATIM tragen");
  ok(calls.length === 1 && calls[0].art === "divergenz",
    `D: die abweichende lokale Antwort haette separat aufbewahrt werden muessen, nicht nur bei fehlendem Namensraum: ${JSON.stringify(calls)}`);
  const bewahrt = calls[0].eintraege.find((e) => e.namespace === "automation");
  ok(bewahrt && bewahrt.snapshot.questionsById.q1.status === "nur-lokal-beantwortet",
    "D: die aufbewahrte Kopie muss die echte lokale Absicht tragen, nicht nur behaupten, es gebe nur die Serverkopie");
}

// ═══ E) Kennung: stabil bei Wiederholung, kollisionsarm, keine beliebigen Duplikate ═══
{
  const src = helferBlockSrc() + "\nreturn { stableV3RetentionId };";
  const { stableV3RetentionId } = new Function(src)();

  const a1 = await stableV3RetentionId("v3_protected_gap", JSON.stringify({ kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 5 } } }));
  const a2 = await stableV3RetentionId("v3_protected_gap", JSON.stringify({ kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 5 } } }));
  ok(a1 === a2, "E: identischer Inhalt muss dieselbe Kennung liefern (Voraussetzung fuer retainLegacy()s Wiederholungsschutz)");

  const b1 = await stableV3RetentionId("v3_protected_gap", JSON.stringify({ kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 6 } } }));
  ok(a1 !== b1, "E: unterschiedlicher Inhalt darf nicht dieselbe Kennung liefern");

  // Die reale Nutzlastform, die retainV3DataLocally() baut — OHNE capturedAt.
  const legacyOperation = { kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 5, activeLease: null } } };
  const operationId = await stableV3RetentionId("v3_v3_protected_gap", JSON.stringify(legacyOperation));

  const indexedDB = new IDBFactory();
  const accountKey = "test-account";
  const queue = await openCommandQueue({ indexedDB, databaseName: "v3-retention-test" });
  await queue.retainLegacy({ accountKey, operationId, legacyOperation });
  // Wiederholter, INHALTLICH IDENTISCHER Versuch — darf NICHT operation_id_conflict werfen.
  await assert.doesNotReject(
    queue.retainLegacy({ accountKey, operationId, legacyOperation }),
    "E: ein identischer Wiederholungsversuch mit derselben Kennung darf keinen Konflikt ausloesen"
  );
  checks++;
  const eintraege = await queue.list(accountKey, { includeAcknowledged: true });
  ok(eintraege.length === 1, `E: zwei identische Versuche haetten genau EINEN Eintrag ergeben muessen, es sind ${eintraege.length}`);

  // Gegenprobe: dieselbe Kennung mit ANDEREM Inhalt bleibt ein echter Konflikt
  // (die Korrektur darf die Kollisionspruefung nicht abschalten).
  await assert.rejects(
    queue.retainLegacy({ accountKey, operationId, legacyOperation: { ...legacyOperation, data: { automation: { dataRevision: 999 } } } }),
    (e) => e.code === "operation_id_conflict",
    "E: dieselbe Kennung mit ANDEREM Inhalt muss weiterhin als Konflikt erkannt werden"
  );
  checks++;
  queue.close();
}

console.log(`quantus-v3-protected-write-boundary: ${checks} checks passed`);
