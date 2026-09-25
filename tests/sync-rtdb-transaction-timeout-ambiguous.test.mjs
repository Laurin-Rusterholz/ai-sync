/*
 * Review PR269 (25.09.2026): ein Zeitlimit auf ref.transaction() allein reicht
 * nicht. Zwei getrennte Luecken, wenn die Transaktion lokal aufgegeben wird,
 * aber beim Firebase-SDK WEITERLEBT (Reconnect, langsame Antwort):
 *
 *   1. Der Timeout-Fehler war ein GEWOEHNLICHER Fehlschlag, keine Kennzeichnung
 *      als "Ausgang unbekannt" (__ambiguous). Der bestehende Ruecklese-/
 *      Verifikationsweg (F-26, siehe tests/f26-ambiguous-rtdb-commit-gap.test.mjs)
 *      lief fuer einen Timeout also NIE — ein tatsaechlich doch noch
 *      durchgekommener Commit waere als Fehlschlag gemeldet worden.
 *   2. Noch wichtiger: die Aktualisierungsfunktion der Transaktion lebt beim
 *      SDK weiter, auch nachdem der Aufrufer lokal aufgegeben hat. Ruft
 *      Firebase sie SPAETER erneut auf (eigener Retry bei Schreibkonkurrenz,
 *      verzoegerter Reconnect), haette sie ohne Gegenmassnahme das damals
 *      noch aktuelle (inzwischen VERALTETE) `data` gegen den DANN aktuellen
 *      Serverstand gemergt und committet — und damit einen zwischenzeitlich
 *      dort gelandeten, neueren Stand (paralleler lokaler Edit + Retry
 *      dieses oder eines anderen Geraets) stillschweigend ueberschrieben.
 *
 * Fix: der Timeout wird ueber withTimeout()s neuen onTimeout-Parameter als
 * __ambiguous markiert (derselbe Rueckleseweg wie bei "disconnect" entscheidet
 * danach), UND eine "abgelaufen"-Sperre laesst jeden WEITEREN Aufruf der
 * Aktualisierungsfunktion sofort abbrechen (return undefined) — ein spaeter
 * Aufruf committet nie mehr etwas, unabhaengig davon, was inzwischen auf dem
 * Server steht.
 *
 * Der Test schneidet die ECHTEN Funktionen (withTimeout, rtdbJsonPut) aus
 * public/index.html heraus und treibt eine Attrappen-Transaktion von Hand:
 * sie "haengt" absichtlich (ruft weder Erfolg noch Fehler zurueck), bis der
 * Test selbst spaeter — NACH dem Timeout — die Aktualisierungsfunktion ein
 * zweites Mal aufruft, mit einem simulierten NEUEREN Serverstand.
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

const WITH_TIMEOUT = funktion("function withTimeout(promise, timeoutMs, label, onTimeout) {");
const RTDB_DIV_CONST = (() => {
  const a = index.indexOf("const RTDB_DIVERGENCE_MAX_ATTEMPTS = ");
  ok(a > 0, "RTDB_DIVERGENCE_MAX_ATTEMPTS wurde nicht gefunden");
  return index.slice(a, index.indexOf(";", a) + 1);
})();
// Fuer den Test auf Millisekunden statt Sekunden verkuerzt — dieselbe Logik,
// nur schneller. Beide echten Vorkommen (Transaktion + Ruecklese-Timeout).
const RTDB_JSON_PUT = funktion("async function rtdbJsonPut(key, data, options = {}) {")
  .replace("}), 15000, 'rtdb_transaction'", "}), 30, 'rtdb_transaction'")
  .replace("withTimeout(ref2.once('value'), 12000, 'rtdb_ambiguous_readback')", "withTimeout(ref2.once('value'), 30, 'rtdb_ambiguous_readback')");
ok(/}\), 30, 'rtdb_transaction'/.test(RTDB_JSON_PUT), "die Zeitlimit-Ersetzung (Transaktion) griff nicht — Test liefe 15s echt");
ok(/withTimeout\(ref2\.once\('value'\), 30, 'rtdb_ambiguous_readback'\)/.test(RTDB_JSON_PUT), "die Zeitlimit-Ersetzung (Ruecklese) griff nicht");

// ── Attrappen-Transaktion: haengt absichtlich, bis der Test sie manuell bedient ─
function makeControllableRef() {
  const state = { updateFn: null, onComplete: null, calls: 0, onceResult: { val: () => null } };
  return {
    state,
    ref: {
      transaction(updateFn, onComplete) {
        state.calls++;
        state.updateFn = updateFn;
        state.onComplete = onComplete;
        // Bewusst KEIN synchroner/naher Ruecklauf — simuliert eine Transaktion,
        // die beim SDK haengt (Reconnect), waehrend der Aufrufer laengst
        // lokal aufgegeben hat.
      },
      once: async () => state.onceResult,
    },
  };
}

function bauen(refBundle) {
  const APP = { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } };
  const fn = new Function(
    "APP", "coreWriteGuard", "shouldTryCloudProvider", "coreAuthReady", "rememberCoreAuthRequired",
    "RTDB_NODE", "rtdbNodeKey", "rtdbDbRef", "getOrCreateDeviceId", "rememberCloudFailure",
    "rememberCloudSuccess", "isAuthDeniedError", "getDataTimestamp", "fetchWithTimeout",
    "detectV3ProtectedGap", "detectV3LocalDivergence", "retainV3ProtectedGapLocally", "retainV3LocalDivergenceSecurely",
    "console",
    WITH_TIMEOUT + "\n" + RTDB_DIV_CONST + "\n" + RTDB_JSON_PUT + "\nreturn rtdbJsonPut;",
  )(
    APP, () => null, () => true, async () => ({ user: { uid: "u1" } }), () => {},
    "appStore", (k) => k, () => refBundle.ref, () => "dev1", () => {},
    () => {}, () => false, (d) => Date.parse(d?.meta?.updatedAt || 0) || 0,
    async () => { throw new Error("REST darf hier nicht laufen"); },
    () => null, () => null, async () => true, async () => true,
    { log() {}, warn() {}, error() {} },
  );
  return { fn, APP };
}

const wrapOf = (payload, attemptId, savedBy) => ({
  data: JSON.stringify(payload), updatedAt: payload?.meta?.updatedAt, savedAt: 1, savedBy, attemptId,
});

// ── 1. Timeout wird als __ambiguous behandelt (nicht als blosser Fehlschlag) ──
{
  const rb = makeControllableRef();
  const { fn } = bauen(rb);
  const local = { entities: { tasks: {} }, meta: { updatedAt: "2026-09-25T08:00:00.000Z" } };
  const mergeFn = (l, r) => ({ ...r, ...l, entities: { ...(r.entities || {}), ...(l.entities || {}) } });

  // Zum Zeitpunkt der Ausgang-unbekannt-Klaerung ist unsere attemptId NOCH
  // NICHT auf dem "Server" — die Transaktion haengt ja noch (Praemisse).
  rb.state.onceResult = { val: () => wrapOf({ entities: { tasks: {} }, meta: { updatedAt: "2026-09-25T07:00:00.000Z" } }, "eine-andere-id", "anderes-geraet") };

  const res = await fn("app-data.json", local, { mergeFn });
  eq(rb.state.calls, 1, "die Transaktion wurde nicht genau einmal gestartet");
  ok(res.ok === false, "ein Timeout ohne nachweisbaren eigenen Commit meldet faelschlich Erfolg");
  eq(res.reason, "ambiguous_not_applied",
    `der Timeout wird nicht ueber den F-26-Ausgang-unbekannt-Weg behandelt (reason: ${res.reason}) — ohne __ambiguous waere er ein gewoehnlicher Fehlschlag ohne Rueckleseversuch`);

  // ── 2. Ein SPAETERER Aufruf derselben Aktualisierungsfunktion (Firebase-
  //      interner Retry NACH unserem lokalen Aufgeben) darf NIE mehr committen
  //      — auch nicht, wenn inzwischen ein neuerer, paralleler Stand da ist ──
  ok(typeof rb.state.updateFn === "function", "die Aktualisierungsfunktion wurde nicht eingefangen");
  const neuererParallelerStand = {
    data: JSON.stringify({ entities: { tasks: { "von-anderem-geraet": { id: "von-anderem-geraet" } } }, meta: { updatedAt: "2026-09-25T08:30:00.000Z" } }),
  };
  const spaeterAufruf = rb.state.updateFn(neuererParallelerStand);
  eq(spaeterAufruf, undefined,
    "ein Aufruf der Aktualisierungsfunktion NACH dem Timeout committet trotzdem — das koennte einen neueren, parallelen Stand ueberschreiben");
}

// ── 3. Kommt unsere eigene attemptId beim Nachlesen doch zum Vorschein
//      (die Transaktion war tatsaechlich schon durch), wird das als echter
//      Erfolg mit dem TATSAECHLICHEN Serverstand gemeldet — kein Datenverlust ─
{
  const rb = makeControllableRef();
  const { fn } = bauen(rb);
  const local = { entities: { tasks: {} }, meta: { updatedAt: "2026-09-25T08:00:00.000Z" } };
  const mergeFn = (l, r) => ({ ...r, ...l, entities: { ...(r.entities || {}), ...(l.entities || {}) } });

  // Die Aktualisierungsfunktion "haengt" aus Sicht des Aufrufers (kein
  // onComplete), hat aber intern (SDK-seitig) doch committet — wir stellen das
  // hier ueber den Rueckleseweg fest, indem onceResult unsere eigene attemptId
  // traegt. Der Test kann die versuchsId nicht direkt lesen (modulintern),
  // daher: den ECHTEN Aufruf einmal ausfuehren lassen und ueber das erste
  // Transaktions-Ergebnis (finalPayload/attemptId im geschriebenen Datensatz)
  // pruefen, dass GENAU dieser Versuch als Erfolg erkannt wird, sobald sein
  // Ergebnis nachlesbar ist. Dazu simulieren wir: die Aktualisierungsfunktion
  // wird VOR dem Timeout ein einziges Mal regulaer aufgerufen (liefert die
  // committete Huelle), und genau diese Huelle liegt beim Nachlesen vor.
  let committeteHuelle = null;
  const originalTransaction = rb.ref.transaction.bind(rb.ref);
  rb.ref.transaction = (updateFn, onComplete) => {
    rb.state.calls++;
    rb.state.updateFn = updateFn;
    rb.state.onComplete = onComplete;
    const ergebnis = updateFn(null); // leerer Server — unser Stand gewinnt unbedingt
    if (ergebnis !== undefined) committeteHuelle = ergebnis;
    // onComplete bewusst NICHT aufrufen — der Aufrufer erfaehrt es nur ueber
    // den Timeout + Rueckleseweg, exakt wie im gemeldeten Produktionsfall.
  };

  const resPromise = fn("app-data.json", local, { mergeFn });
  // Sobald der Commit "geschehen" ist (synchron oben), traegt der Rueckleseweg
  // ihn nach — inklusive der echten attemptId, die der Test selbst nicht kennt.
  await new Promise((r) => setTimeout(r, 5));
  rb.state.onceResult = { val: () => committeteHuelle };
  const res = await resPromise;

  ok(res.ok === true, `ein tatsaechlich doch committeter Versuch wird nach Timeout nicht als Erfolg erkannt: ${JSON.stringify(res)}`);
  ok(res.committedByTransaction === true, "der verifizierte Ausgang traegt keinen CAS-Beweis");
  eq(res.casProof?.kind, "rtdb-ambiguous-verified", "der CAS-Beweis-Typ fehlt/weicht ab");
}

console.log(`sync-rtdb-transaction-timeout-ambiguous: ok (${checks} Pruefungen)`);
