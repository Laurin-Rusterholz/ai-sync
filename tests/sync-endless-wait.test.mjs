/*
 * Server nicht erreichbar / "Wird synchronisiert…" haengt dauerhaft.
 * ---------------------------------------------------------------------------
 * Befund (25.09.2026, live gemeldet): Der Kontrollbereich blieb nach einem
 * manuellen Pull/Push auf "Wird synchronisiert…" stehen — ohne Erfolgs- oder
 * Fehlermeldung. Zwei getrennte Ursachen, beide in der ECHTEN Funktion:
 *
 *   1. rtdbJsonGet()/rtdbJsonPut() riefen die Firebase-RTDB-SDK-Methoden
 *      ref.once('value') und ref.transaction() OHNE jedes Zeitlimit auf.
 *      Haengt die Websocket-Verbindung (Captive Portal, gestoertes Netz, ein
 *      Tab, der aufwacht, ohne dass der Socket es merkt), wartet der Aufrufer
 *      unbegrenzt — kein Fehler, keine Ablehnung. syncFreshness() haelt dabei
 *      _syncFreshnessPromise dauerhaft auf einem nie aufgeloesten Versprechen
 *      fest (die naechsten 30-Sekunden-Anlaeufe geben sofort dasselbe haengende
 *      Versprechen zurueck, ohne es neu zu versuchen) — und doSave() bleibt auf
 *      status "saving" stehen, denn _saving wird nirgends in einem finally
 *      zurueckgesetzt. Fix: withTimeout() begrenzt jeden SDK-Aufruf wie
 *      fetchWithTimeout() die Netzwerkanfragen.
 *   2. doSave() rief remotePut() OHNE try/catch auf. Ein unerwarteter Wurf
 *      (statt eines regulaeren { ok:false, ... }) lief ungefangen aus doSave()
 *      heraus — status blieb auf "saving" stehen, _saving blieb true, kein
 *      Codepfad danach kam noch zum Zug. Fix: der Aufruf ist jetzt in ein
 *      try/catch gefasst, ein Wurf wird wie ein regulaerer Fehlschlag behandelt
 *      (sichtbarer Fehlerzustand, keine Anmeldung wird umgangen, keine Daten
 *      gehen verloren — der lokale Stand wurde bereits zuvor gespeichert).
 *
 * Dieselbe Ursache (1) erklaert auch die zweite Meldung: "Mailauswertung
 * klickbar, danach kein erfolgreicher Lauf sichtbar". dbRunV3EmailBriefing()
 * wartet nach dem Server-Aufruf auf syncFreshness() INNERHALB seines eigenen
 * try/finally — haengt syncFreshness() (weil remoteGet() → rtdbJsonGet()
 * haengt), erreicht dieses finally nie, der Knopf bleibt auf "Läuft…" stehen.
 * Kein eigener Fix noetig: mit withTimeout() bricht syncFreshness() jetzt
 * rechtzeitig ab, das finally laeuft wie vorgesehen.
 *
 * Die Tests schneiden die ECHTEN Funktionen aus public/index.html heraus und
 * fuehren sie gegen Attrappen aus, die absichtlich "haengen" bzw. werfen.
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

function funktion(kopfzeile) {
  const a = index.indexOf(kopfzeile);
  ok(a > 0, `nicht gefunden: ${kopfzeile}`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}

// ── 1. withTimeout(): die echte Funktion loest bei Ablauf ab, statt zu haengen ─
{
  const src = funktion("function withTimeout(promise, timeoutMs, label) {");
  const withTimeout = new Function(src + "\nreturn withTimeout;")();

  const nieAufloesend = new Promise(() => {}); // haengt absichtlich fuer immer
  const p = withTimeout(nieAufloesend, 20, "test_op");
  await assert.rejects(p, /test_op_timeout/, "withTimeout loest eine haengende Zusage nicht rechtzeitig ab");

  // Eine schnell aufgeloeste Zusage gewinnt gegen den Timer.
  const schnell = await withTimeout(Promise.resolve("wert"), 5000, "x");
  eq(schnell, "wert", "withTimeout liefert das Ergebnis der schnelleren Zusage nicht durch");

  // Eine schnell ABGELEHNTE Zusage gewinnt ebenso — der eigentliche Fehler
  // darf nicht durch einen spaeteren Timeout verdeckt werden.
  const eigenerFehler = new Error("eigener_fehler");
  await assert.rejects(withTimeout(Promise.reject(eigenerFehler), 5000, "x"), /eigener_fehler/,
    "withTimeout ersetzt einen echten, schnellen Fehler durch einen Timeout");
}

// ── 2. rtdbJsonGet/rtdbJsonPut/das sekundaere ref.set() nutzen withTimeout
//      fuer JEDEN SDK-Aufruf — keiner der drei darf ungebremst haengen ──────
{
  ok(/const snap = await withTimeout\(ref\.once\('value'\), \d+, 'rtdb_once'\);/.test(index),
    "rtdbJsonGet() begrenzt ref.once('value') nicht mehr — ein haengender Lesevorgang blockiert den Abgleich wieder unbegrenzt");
  ok(/const txn = await withTimeout\(new Promise\(\(resolve, reject\) => \{\s*\n\s*ref\.transaction\(/.test(index),
    "rtdbJsonPut() begrenzt die ref.transaction()-Zusage nicht mehr");
  ok(/await withTimeout\(ref\.set\(wrap\), \d+, 'rtdb_set'\);/.test(index),
    "rtdbJsonPut() begrenzt den sekundaeren ref.set()-Schreibvorgang nicht mehr");
}

// ── 3. doSave(): ein Wurf aus remotePut() haengt den Kontrollbereich nicht
//      mehr auf "Wird synchronisiert…", sondern endet sichtbar ─────────────
{
  const src = funktion("async function doSave(silent = false) {");
  ok(/let result;\s*\n\s*try \{\s*\n\s*result = await remotePut\(payload\);/.test(src),
    "doSave() ruft remotePut() weiterhin ohne try/catch auf — ein Wurf haengt den Kontrollbereich auf 'saving' fest");

  const APP = { state: {
    storage: { _saving: false },
    data: { meta: {} },
    settings: {},
    ui: {},
  } };
  const protokoll = { toasts: [], saves: 0, rendered: 0 };
  const fn = new Function(
    "APP", "authResyncActive", "isManualTransferMode", "manualLocalSave", "saveLocalData",
    "isAutoSyncEnabled", "navigator", "toast", "getLang", "t", "pullAndMergeBeforeSave",
    "buildRemoteAppPayload", "remotePut", "mergeData", "normalizeData",
    "restoreReadingHubShadowFromData", "render", "remoteGet", "countEntities",
    "updateSyncChip", "_saveDirty", "_syncLockActive", "_coreReadOk",
    src + "\nreturn doSave;",
  )(
    APP,
    () => false,                          // authResyncActive
    () => false,                          // isManualTransferMode
    async () => ({ ok: true }),           // manualLocalSave (unbenutzt hier)
    () => { protokoll.saves++; },         // saveLocalData
    () => true,                           // isAutoSyncEnabled
    { onLine: true },                     // navigator
    (art, titel, text) => { protokoll.toasts.push(art + ":" + titel); }, // toast
    () => "de",                           // getLang
    (key) => key,                         // t
    async () => ({ merged: false }),      // pullAndMergeBeforeSave
    () => ({ entities: {} }),             // buildRemoteAppPayload
    // remotePut(): wirft UNERWARTET, statt { ok:false, ... } zurueckzugeben —
    // genau der gemeldete Fall.
    async () => { throw new Error("netzwerk_ausnahme_unerwartet"); },
    (a, b) => a,                          // mergeData (unbenutzt hier)
    (d) => d,                             // normalizeData (unbenutzt hier)
    () => {},                             // restoreReadingHubShadowFromData
    () => { protokoll.rendered++; },      // render
    async () => ({ ok: false }),          // remoteGet (unbenutzt hier)
    () => 0,                              // countEntities
    () => {},                             // updateSyncChip
    false, false, true,                   // _saveDirty, _syncLockActive, _coreReadOk
  );

  const ergebnis = await fn(false); // silent=false → forceRemote=true, erreicht remotePut()

  eq(APP.state.storage._saving, false,
    "nach einem Wurf aus remotePut() bleibt _saving haengen — der Kontrollbereich zeigt 'Wird synchronisiert…' fuer immer");
  ok(APP.state.storage.status !== "saving",
    `status bleibt nach dem Wurf auf 'saving' stehen: ${APP.state.storage.status}`);
  ok(ergebnis && ergebnis.ok === false,
    "doSave() muss nach einem Wurf aus remotePut() ehrlich ok:false zurueckgeben, nicht unbeobachtet durchreichen");
  ok(protokoll.toasts.some((t) => t.startsWith("warn:")),
    "nach einem Wurf aus remotePut() erscheint keine sichtbare Fehlermeldung (Toast)");
}

// ── 4. dbRunV3EmailBriefing(): der Knopf/Statustext wird nach syncFreshness()
//      innerhalb desselben try/finally zurueckgesetzt — ohne Bug (1) haette
//      ein haengendes syncFreshness() diesen finally-Block nie erreicht ─────
{
  const start = index.indexOf("async function dbRunV3EmailBriefing() {");
  ok(start > 0, "dbRunV3EmailBriefing() wurde nicht gefunden");
  const ende = index.indexOf("\nwindow.dbRunV3EmailBriefing = dbRunV3EmailBriefing;", start);
  ok(ende > start, "Ende von dbRunV3EmailBriefing() nicht bestimmbar");
  const src = index.slice(start, ende);
  const posSyncFreshness = src.indexOf("await syncFreshness(");
  const posFinally = src.indexOf("} finally {");
  ok(posSyncFreshness > 0 && posFinally > posSyncFreshness,
    "await syncFreshness(...) liegt nicht mehr VOR dem finally-Block — der Knopf koennte bei einem haengenden Aufruf nie zurueckgesetzt werden");
}

console.log(`sync-endless-wait: ok (${checks} Pruefungen)`);
