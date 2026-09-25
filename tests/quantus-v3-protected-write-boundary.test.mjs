/*
 * Tagesbriefing v3, Baustein D (F-27, Runde 3) — der geschuetzte v3-
 * Namensraum am ECHTEN Schreibpfad, nach der dritten unabhaengigen Ablehnung
 * von 042deae.
 *
 * Runde 2 machte eine erkannte Abweichung vom (gueltigen) Serverstand
 * NICHT-BLOCKIEREND: der ersetzende Schreibvorgang lief sofort weiter,
 * retainV3LocalDivergenceQuietly() sicherte "nebenbei" (fire-and-forget,
 * bei RTDB sogar erst NACH dem Commit). Befund: schlaegt die Sicherung fehl
 * (IndexedDB-Kontingent, fehlendes Modul ausserhalb des Browsers, ein
 * werfender Aufruf), ist die abweichende lokale Kopie in genau dem Moment
 * verloren, in dem der erfolgreiche Schreibvorgang sie durch den
 * Serverstand ersetzt — nirgends gesichert, nirgends mehr vorhanden.
 *
 * Korrigiert in public/index.html:
 *  - guardV3ProtectedWrite() (canonicalWrite/netlifyBlobPut/firebaseJsonPut):
 *    wartet jetzt auf retainV3LocalDivergenceSecurely() und BLOCKIERT den
 *    Schreibvorgang, wenn die Sicherung nicht bestaetigt ist — genau wie bei
 *    einer Luecke. Ein Wurf waehrend der Sicherung zaehlt als Fehlschlag
 *    (fail-closed), nie als unbehandelte Ausnahme.
 *  - rtdbJsonPut(): der CAS-Callback bleibt rein; eine NEU erkannte, noch
 *    nicht gesicherte Abweichung bricht ab (return undefined), NIEMALS
 *    committen und danach sichern. Erst nach bestaetigter Sicherung
 *    AUSSERHALB der Transaktion wird GENAU EIN weiterer Versuch mit
 *    unveraendertem Original unternommen (RTDB_DIVERGENCE_MAX_ATTEMPTS = 2);
 *    eine dabei neu auftauchende, ANDERE Abweichung wird nicht endlos
 *    verfolgt, sondern fuehrt zu einem sichtbaren, aber niemals schreibenden
 *    Fehlschlag.
 *
 * Testtechnik: dieselbe Ausschneidetechnik wie tests/sync-merge.test.mjs.
 * `spy: false` laedt die ECHTEN retainV3DataLocally()/retainV3Protected-
 * GapLocally()/retainV3LocalDivergenceSecurely() unveraendert (ihr
 * `import('/quantus-v3-command-client.mjs')` schlaegt ausserhalb von
 * Netlify/Browser reguär fehl — das ist der reale Zustand, mit dem der
 * Befund entdeckt wurde, kein Mock). `spy: true` ersetzt nur die beiden
 * seiteneffektbehafteten Sicherungsfunktionen durch injizierte Test-
 * Implementierungen (verzoegert/false/werfend), um deren Handhabung gezielt
 * zu pruefen, OHNE die echte Erkennungs-/Blockade-/Schleifenlogik zu ersetzen.
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
function sliceConst(marker) {
  const start = index.indexOf(marker);
  ok(start > 0, `Marker nicht gefunden: ${marker}`);
  return index.slice(start, index.indexOf(";", start) + 1);
}
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
// Ersetzt NUR die beiden seiteneffektbehafteten Sicherungsfunktionen durch
// vom Test injizierte Implementierungen (spaeter deklariert gewinnt bei
// mehreren function-Deklarationen mit gleichem Namen im selben Scope) —
// Erkennung, guardV3ProtectedWrite, mergeData() und die Schleife in
// rtdbJsonPut() bleiben die ECHTEN, unveraenderten Funktionen.
const spySrc = () => (
  "\nasync function retainV3ProtectedGapLocally(merged, gaps) { return __retainGapImpl(merged, gaps); }\n" +
  "async function retainV3LocalDivergenceSecurely(liste) { return __retainDivImpl(liste); }\n"
);

function loadCanonicalWrite({ spy = true } = {}) {
  const cwMaxSrc = sliceConst("const CANONICAL_WRITE_MAX_ATTEMPTS = 2;");
  const cwStart = index.indexOf("async function canonicalWrite(quelle, options = {}) {");
  const cwEnd = index.indexOf("\nasync function remotePut(data, options = {}) {", cwStart);
  ok(cwStart > 0 && cwEnd > cwStart, "canonicalWrite() wurde nicht gefunden");
  let src = sharedSrc() + "\n" + cwMaxSrc + "\n" + index.slice(cwStart, cwEnd);
  const params = [
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "APP", "remoteGetByKey", "remotePutByKey",
    "primaryCloudProvider", "getOrCreateDeviceId",
  ];
  const args = [
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    { state: { settings: { storage: { blobKey: "app-data.json" } } } },
    globalThis.__fakeRemoteGetByKey, (...a) => globalThis.__fakeRemotePutByKey(...a),
    () => "rtdb", () => "test-device",
  ];
  if (spy) {
    src += spySrc() + "\nreturn canonicalWrite;";
    params.push("__retainGapImpl", "__retainDivImpl");
    args.push((...a) => globalThis.__retainGapImpl(...a), (...a) => globalThis.__retainDivImpl(...a));
  } else {
    src += "\nreturn canonicalWrite;";
    params.push("coreAuthReady", "toast");
    args.push(async () => ({ user: { uid: "u" } }), (...a) => globalThis.__toasts.push(a));
  }
  return new Function(...params, src)(...args);
}

function loadRtdbJsonPut({ spy = true } = {}) {
  const rtdbDivMaxSrc = sliceConst("const RTDB_DIVERGENCE_MAX_ATTEMPTS = 2;");
  const cwgSrc = index.slice(index.indexOf("function coreWriteGuard(fnName, key, options) {"), index.indexOf("\n}\n", index.indexOf("function coreWriteGuard(fnName, key, options) {")) + 3);
  const icdkSrc = index.slice(index.indexOf("function isCoreDataKey(key) {"), index.indexOf("\n}\n", index.indexOf("function isCoreDataKey(key) {")) + 3);
  const rjpStart = index.indexOf("async function rtdbJsonPut(key, data, options = {}) {");
  const rjpEnd = index.indexOf("\nfunction isCoreDataKey(key) {", rjpStart);
  ok(rjpStart > 0 && rjpEnd > rjpStart, "rtdbJsonPut() wurde nicht gefunden");
  const callbackSrc = index.slice(index.indexOf("ref.transaction((current) => {", rjpStart), index.indexOf("}, false);", rjpStart));
  let src = sharedSrc() + "\n" + rtdbDivMaxSrc + "\n" + cwgSrc + "\n" + icdkSrc + "\n" + index.slice(rjpStart, rjpEnd);
  const params = [
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "APP", "shouldTryCloudProvider", "coreAuthReady",
    "rememberCoreAuthRequired", "RTDB_NODE", "rtdbNodeKey", "rtdbDbRef", "getOrCreateDeviceId",
    "rememberCloudFailure", "rememberCloudSuccess", "isAuthDeniedError", "getDataTimestamp", "CORE_BLOB_KEY",
    "withTimeout",
  ];
  const args = [
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } },
    () => true, async () => ({ user: { uid: "test-uid" } }), () => {},
    "appStore", (k) => String(k).replace(/[.#$\[\]\/]/g, "_"), () => globalThis.__fakeRef,
    () => "test-device", () => {}, () => {}, () => false, (d) => Number(d?.meta?.updatedAt ? Date.parse(d.meta.updatedAt) : 0),
    "app-data.json",
    // withTimeout: reine Durchreichung — das Zeitlimit selbst prueft
    // tests/sync-endless-wait.test.mjs.
    (p) => p,
  ];
  if (spy) {
    src += spySrc() + "\nreturn rtdbJsonPut;";
    params.push("__retainGapImpl", "__retainDivImpl");
    args.push((...a) => globalThis.__retainGapImpl(...a), (...a) => globalThis.__retainDivImpl(...a));
  } else {
    src += "\nreturn rtdbJsonPut;";
    params.push("toast");
    args.push((...a) => globalThis.__toasts.push(a));
  }
  return { rtdbJsonPut: new Function(...params, src)(...args), callbackSrc };
}

function basisBestand(over = {}) {
  return { entities: { tasks: {} }, meta: {}, ...over };
}
globalThis.__toasts = [];

const echteMergeData = new Function(
  "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
  "mergeEntity", "entityTimestamp", "console",
  sharedSrc() + "\nreturn mergeData;"
)(
  () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
  (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} }
);

// ═══ 1) Reale Luecke (unveraendert): fehlendes Modul meldet NIE Erfolg ═══
{
  const src = sharedSrc() + "\nreturn { retainV3ProtectedGapLocally };";
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "mergeEntity", "entityTimestamp", "console", "coreAuthReady", "getOrCreateDeviceId", "toast",
    src
  );
  const toasts = [];
  const api = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {}, error() {} },
    async () => ({ user: { uid: "u" } }), () => "dev", (...a) => toasts.push(a),
  );
  const original = { automation: { schemaVersion: 3, dataRevision: 7, activeLease: { holder: "original" } } };
  const originalKopie = JSON.parse(JSON.stringify(original));
  const result = await api.retainV3ProtectedGapLocally(original, ["automation"]);
  ok(result === false, `1: ein echter Fehlschlag (fehlendes Modul) haette false liefern muessen, lieferte ${result}`);
  ok(toasts.length === 1 && toasts[0][0] === "error", `1: bei einem echten Fehlschlag muss ein Fehler-Toast erscheinen: ${JSON.stringify(toasts)}`);
  ok(JSON.stringify(original) === JSON.stringify(originalKopie), "1: das Original darf durch den Fehlschlag nicht veraendert werden");
}

// ═══ 2) ECHTE Blockade: eine abweichende Kopie, deren Sicherung real fehlschlaegt, darf NIE geschrieben werden ═══
{
  globalThis.__toasts = [];
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 8, questionsById: { q1: { status: "nur-lokal-beantwortet" } } } });
  const localKopie = JSON.parse(JSON.stringify(local));
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 9, questionsById: {} } });
  let putCalled = false;
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async () => { putCalled = true; return { ok: true }; };
  const canonicalWrite = loadCanonicalWrite({ spy: false }); // ECHTE Sicherungskette, kein Mock
  const res = await canonicalWrite(local, {});
  ok(res.ok === false && res.reason === "v3_divergence_retention_failed",
    `2: eine real fehlgeschlagene Sicherung haette den Schreibvorgang blockieren muessen: ${JSON.stringify(res)}`);
  ok(putCalled === false, "2: canonicalWrite darf bei ungesicherter Abweichung NIEMALS remotePutByKey aufrufen — das waere der Datenverlust");
  ok(JSON.stringify(local) === JSON.stringify(localKopie), "2: die lokalen Eingabedaten duerfen durch den Fehlschlag nicht veraendert werden");
  ok(globalThis.__toasts.some((t) => t[0] === "error"), "2: ein Fehlschlag muss sichtbar sein");
}

// ═══ 3) Verzoegerte Sicherung: der Schreibvorgang wartet WIRKLICH ab ═══
{
  let putCalled = false;
  let sicherungAufgeloest = false;
  globalThis.__retainGapImpl = async () => true;
  globalThis.__retainDivImpl = async () => {
    await new Promise((r) => setTimeout(r, 20));
    sicherungAufgeloest = true;
    return true;
  };
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1, questionsById: { q1: {} } } });
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 2, questionsById: {} } });
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async (key, gesendet) => {
    putCalled = true;
    ok(sicherungAufgeloest === true, "3: der Schreibvorgang lief los, BEVOR die verzoegerte Sicherung sich aufgeloest hat");
    return { ok: true, data: gesendet, casProof: { kind: "rtdb-transaction", committed: true, snapshot: {} } };
  };
  const canonicalWrite = loadCanonicalWrite({ spy: true });
  const res = await canonicalWrite(local, {});
  ok(res.ok === true, `3: nach erfolgreicher (verzoegerter) Sicherung haette geschrieben werden muessen: ${JSON.stringify(res)}`);
  ok(putCalled === true, "3: der Schreibvorgang haette nach der Sicherung stattfinden muessen");
}

// ═══ 4) Sicherung liefert false → Blockade (Spy-Kontrolle) ═══
{
  let putCalled = false;
  globalThis.__retainGapImpl = async () => true;
  globalThis.__retainDivImpl = async () => false;
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1, questionsById: { q1: {} } } });
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 2, questionsById: {} } });
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async () => { putCalled = true; return { ok: true }; };
  const canonicalWrite = loadCanonicalWrite({ spy: true });
  const res = await canonicalWrite(local, {});
  ok(res.ok === false && res.reason === "v3_divergence_retention_failed", `4: false haette blockieren muessen: ${JSON.stringify(res)}`);
  ok(putCalled === false, "4: bei false darf niemals geschrieben werden");
}

// ═══ 5) Sicherung wirft → gilt als Fehlschlag, kein unbehandelter Absturz ═══
{
  let putCalled = false;
  globalThis.__retainGapImpl = async () => true;
  globalThis.__retainDivImpl = async () => { throw new Error("IndexedDB-Kontingent erschoepft"); };
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1, questionsById: { q1: {} } } });
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 2, questionsById: {} } });
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async () => { putCalled = true; return { ok: true }; };
  const canonicalWrite = loadCanonicalWrite({ spy: true });
  const res = await canonicalWrite(local, {});
  ok(res.ok === false && res.reason === "v3_divergence_retention_failed", `5: ein Wurf haette als Fehlschlag gelten muessen: ${JSON.stringify(res)}`);
  ok(putCalled === false, "5: bei einem Wurf darf niemals geschrieben werden");
}

// ═══ 6) CAS bleibt rein: der Transaktions-Callback enthaelt kein await/keinen direkten Sicherungsaufruf ═══
{
  const { callbackSrc } = loadRtdbJsonPut({ spy: true });
  ok(!/\bawait\b/.test(callbackSrc), "6: der Transaktions-Callback enthaelt ein await — er muss rein synchron bleiben");
  ok(!/retainV3ProtectedGapLocally\(|retainV3LocalDivergenceSecurely\(|guardV3ProtectedWrite\(/.test(callbackSrc),
    "6: der Transaktions-Callback ruft eine seiteneffektbehaftete Sicherungsfunktion direkt auf");
  ok(/detectV3ProtectedGap\(/.test(callbackSrc) && /detectV3LocalDivergence\(/.test(callbackSrc),
    "6: der Callback muss die reine Erkennung fuer beide Faelle nutzen");
}

// ═══ 7) rtdbJsonPut: neue Abweichung bricht ab, wird AUSSERHALB gesichert, dann GENAU EIN Versuch mit unveraendertem Original ═══
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1, questionsById: { q1: { status: "lokal" } } } });
  const remoteA = basisBestand({ automation: { schemaVersion: 3, dataRevision: 5, questionsById: {} } });
  let txnCalls = 0;
  let secureCalls = 0;
  let committedWrapper = null;
  globalThis.__retainGapImpl = async () => true;
  globalThis.__retainDivImpl = async (liste) => { secureCalls++; return true; };
  globalThis.__fakeRef = {
    transaction(updateFn, onComplete) {
      txnCalls++;
      const strom = txnCalls === 1 ? remoteA : remoteA; // beim 2. Versuch weiterhin derselbe, bereits gesicherte Stand
      const out = updateFn({ data: JSON.stringify(strom) });
      committedWrapper = out;
      onComplete(null, out !== undefined, out !== undefined ? { val: () => out } : null);
    },
  };
  const { rtdbJsonPut } = loadRtdbJsonPut({ spy: true });
  const res = await rtdbJsonPut("app-data.json", local, { mergeFn: (l, r) => echteMergeData(l, r), _viaCanonicalWrite: true });
  ok(txnCalls === 2, `7: genau EIN Wiederholungsversuch nach bestaetigter Sicherung erwartet, es waren ${txnCalls}`);
  ok(secureCalls === 1, `7: die Sicherung darf nur EINMAL laufen (fuer denselben Inhalt), lief aber ${secureCalls}x`);
  ok(res.ok === true, `7: nach gesicherter, unveraenderter Abweichung haette der zweite Versuch committen muessen: ${JSON.stringify(res)}`);
  ok(committedWrapper && JSON.parse(committedWrapper.data).automation.dataRevision === 5,
    "7: committet werden muss der SERVERSTAND, nicht die lokale Abweichung");
}

// ═══ 8) rtdbJsonPut: eine beim Wiederholungsversuch ZUSAETZLICH auftauchende Abweichung bleibt begrenzt, schreibt nie ═══
// Die gesicherte Abweichung ist inhaltlich an die LOKALE Seite gebunden (sie
// aendert sich nicht, solange `data` unveraendert bleibt) — "neu" heisst hier
// also: ein WEITERER Namensraum geraet zusaetzlich in Abweichung (ein
// anderes Geraet hat zwischen den beiden Versuchen z. B. assistantRuns
// veraendert), nicht ein anderer Inhalt DERSELBEN bereits gesicherten.
{
  const local = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 1, questionsById: { q1: { status: "lokal" } } },
    dailyBriefing: { assistantRuns: { "2026-09-20": { revision: 1 } } },
  });
  const remoteA = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 5, questionsById: {} },
    dailyBriefing: { assistantRuns: { "2026-09-20": { revision: 1 } } }, // deckt sich noch mit lokal — keine Abweichung hier
  });
  const remoteB = basisBestand({
    automation: { schemaVersion: 3, dataRevision: 5, questionsById: {} }, // automation unveraendert ggue. remoteA
    dailyBriefing: { assistantRuns: { "2026-09-20": { revision: 2 } } }, // ein anderes Geraet hat inzwischen weitergeschrieben
  });
  let txnCalls = 0;
  let secureCalls = 0;
  let committed = false;
  globalThis.__retainDivImpl = async () => { secureCalls++; return true; };
  globalThis.__fakeRef = {
    transaction(updateFn, onComplete) {
      txnCalls++;
      const strom = txnCalls === 1 ? remoteA : remoteB; // 2. Versuch: ein zusaetzlicher Namensraum weicht jetzt ab
      const out = updateFn({ data: JSON.stringify(strom) });
      if (out !== undefined) committed = true;
      onComplete(null, out !== undefined, out !== undefined ? { val: () => out } : null);
    },
  };
  const { rtdbJsonPut } = loadRtdbJsonPut({ spy: true });
  const res = await rtdbJsonPut("app-data.json", local, { mergeFn: (l, r) => echteMergeData(l, r), _viaCanonicalWrite: true });
  ok(txnCalls === 2, `8: begrenzt auf zwei Versuche (RTDB_DIVERGENCE_MAX_ATTEMPTS), es waren ${txnCalls}`);
  ok(secureCalls === 1, `8: nur die ERSTE Abweichung (automation) wurde gesichert, die erweiterte (mit assistantRuns) fuehrt zum Abbruch: ${secureCalls}`);
  ok(committed === false, "8: bei einer beim Wiederholungsversuch ZUSAETZLICH aufgetauchten Abweichung darf nie committet werden");
  ok(res.ok === false, `8: das Ergebnis muss sichtbar ein Fehlschlag sein: ${JSON.stringify(res)}`);
}

// ═══ 9) Reload nach Fehlschlag/Erfolg: ein fehlgeschlagener Versuch beschaedigt nichts, ein Folgeversuch gelingt ═══
{
  const local = basisBestand({ automation: { schemaVersion: 3, dataRevision: 1, questionsById: { q1: { status: "lokal" } } } });
  const localKopie = JSON.parse(JSON.stringify(local));
  const remoteServerStand = basisBestand({ automation: { schemaVersion: 3, dataRevision: 2, questionsById: {} } });
  let putCalled = false;
  globalThis.__fakeRemoteGetByKey = async () => ({ ok: true, data: remoteServerStand });
  globalThis.__fakeRemotePutByKey = async (key, gesendet) => { putCalled = true; return { ok: true, data: gesendet, casProof: { kind: "rtdb-transaction", committed: true, snapshot: {} } }; };

  globalThis.__retainGapImpl = async () => true;
  globalThis.__retainDivImpl = async () => false;   // Speicher noch nicht erholt
  let canonicalWrite = loadCanonicalWrite({ spy: true });
  const ersterVersuch = await canonicalWrite(local, {});
  ok(ersterVersuch.ok === false, "9: der erste Versuch (Speicher nicht erholt) haette scheitern muessen");
  ok(putCalled === false, "9: der erste, fehlgeschlagene Versuch darf nicht geschrieben haben");
  ok(JSON.stringify(local) === JSON.stringify(localKopie), "9: die lokalen Daten muessen nach dem Fehlschlag unveraendert sein ('Reload' faende denselben Stand vor)");

  globalThis.__retainDivImpl = async () => true;    // Speicher jetzt erholt — derselbe lokale Stand, neuer Versuch
  canonicalWrite = loadCanonicalWrite({ spy: true });
  const zweiterVersuch = await canonicalWrite(local, {});
  ok(zweiterVersuch.ok === true, `9: nach Erholung haette der Folgeversuch mit demselben lokalen Stand gelingen muessen: ${JSON.stringify(zweiterVersuch)}`);
  ok(putCalled === true, "9: der zweite, erfolgreiche Versuch haette schreiben muessen");
}

// ═══ 10) Kennung: stabil bei Wiederholung, kollisionsarm, keine beliebigen Duplikate ═══
{
  const src = helferBlockSrc() + "\nreturn { stableV3RetentionId };";
  const { stableV3RetentionId } = new Function(src)();

  const a1 = await stableV3RetentionId("v3_protected_gap", JSON.stringify({ kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 5 } } }));
  const a2 = await stableV3RetentionId("v3_protected_gap", JSON.stringify({ kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 5 } } }));
  ok(a1 === a2, "10: identischer Inhalt muss dieselbe Kennung liefern");
  const b1 = await stableV3RetentionId("v3_protected_gap", JSON.stringify({ kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 6 } } }));
  ok(a1 !== b1, "10: unterschiedlicher Inhalt darf nicht dieselbe Kennung liefern");

  const legacyOperation = { kind: "v3_protected_gap", namespaces: ["automation"], data: { automation: { dataRevision: 5, activeLease: null } } };
  const operationId = await stableV3RetentionId("v3_v3_protected_gap", JSON.stringify(legacyOperation));
  const indexedDB = new IDBFactory();
  const accountKey = "test-account";
  const queue = await openCommandQueue({ indexedDB, databaseName: "v3-retention-test" });
  await queue.retainLegacy({ accountKey, operationId, legacyOperation });
  await assert.doesNotReject(queue.retainLegacy({ accountKey, operationId, legacyOperation }),
    "10: ein identischer Wiederholungsversuch darf keinen Konflikt ausloesen");
  checks++;
  const eintraege = await queue.list(accountKey, { includeAcknowledged: true });
  ok(eintraege.length === 1, `10: zwei identische Versuche haetten genau EINEN Eintrag ergeben muessen, es sind ${eintraege.length}`);
  await assert.rejects(
    queue.retainLegacy({ accountKey, operationId, legacyOperation: { ...legacyOperation, data: { automation: { dataRevision: 999 } } } }),
    (e) => e.code === "operation_id_conflict",
    "10: dieselbe Kennung mit ANDEREM Inhalt muss weiterhin als Konflikt erkannt werden"
  );
  checks++;
  queue.close();
}

console.log(`quantus-v3-protected-write-boundary: ${checks} checks passed`);
