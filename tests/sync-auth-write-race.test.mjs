/*
 * Der stille Schreibvorgang wenige Sekunden nach der Anmeldung.
 *
 * Beobachtet in Produktion: auth=null, kein Write. Anmeldung im Drive-Fenster.
 * 3,688 s spaeter stand ein neuer kanonischer Datensatz in der RTDB — ohne ein
 * einziges Save-, PUT- oder Transaktions-Log. Die Kette:
 *
 *   1. Das Anmeldefenster schliesst -> focus -> _syncLockActive = true ->
 *      syncFreshness('window_focus')
 *   2. parallel resyncAfterAuth: erfolgreicher GET, Merge, markCoreReadOk()
 *      -> die Push-Sperre faellt; der Erfolgspfad schwieg dabei
 *   3. syncFreshness nimmt den local-newer-Zweig und ruft doSave(true); der
 *      Sperr-Riegel dort kehrt um, setzt aber _saveDirty = true
 *   4. das freie 5-Sekunden-Sicherheitsnetz sieht _saveDirty, ruft doSave
 *      erneut — und jetzt laeuft der Schreibvorgang durch
 *
 * Der Riegel _authResyncRunning schliesst dieses Fenster. Weil ein haengender
 * Abgleich das finally nie erreicht, traegt er ein Maximalalter: danach loest
 * er sich selbst, meldet das sichtbar, und _coreReadOk bleibt konservativ
 * false — die Push-Sperre unterdrueckt weiterhin jeden Schreibvorgang.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

function cut(header) {
  const start = index.indexOf(header);
  ok(start > 0, `${header} wurde in index.html nicht gefunden`);
  const cands = ["\nfunction ", "\nasync function ", "\nwindow.", "\nconst ", "\nlet ", "\nvar ", "\nsetInterval"]
    .map((m) => index.indexOf(m, start + header.length)).filter((n) => n > 0);
  return index.slice(start, Math.min(...cands));
}
function cutTo(from, to) {
  const a = index.indexOf(from);
  const b = index.indexOf(to, a + from.length);
  ok(a > 0 && b > a, `Bereich ${from} .. ${to} nicht gefunden`);
  return index.slice(a, b);
}

// Der Rumpf des 5-Sekunden-Sicherheitsnetzes, als aufrufbare Funktion.
function cutSafetyNet() {
  const a = index.indexOf("// Safety net: check every 5s if dirty");
  const open = index.indexOf("{", index.indexOf("setInterval(function()", a));
  const close = index.indexOf("}, 5000);", a);
  ok(a > 0 && open > a && close > open, "das 5-Sekunden-Sicherheitsnetz wurde nicht gefunden");
  return "function safetyNetTick() {" + index.slice(index.indexOf("\n", open) + 1, index.lastIndexOf("}", close)) + "}";
}

const PRELUDE = `
  var window = {};   // Exporte der Bloecke laufen ins Leere statt zu werfen
  var log = [], spy = { remoteGet: 0, remotePut: 0, writes: 0 };
  var console = { log: function(){ log.push([].join.call(arguments," ")); },
                  warn: function(){ log.push([].join.call(arguments," ")); },
                  error: function(){ log.push([].join.call(arguments," ")); } };
  var navigator = { onLine: true };
  var _syncLockActive = false, _saveDirty = false, _syncFreshnessPromise = null;
  var _lastRemoteCheckAt = 0, saveTimer = null, _lastSaveTime = 0;
  var _authRequiredSticky = false;
  var remoteGetImpl = null;
  function isManualTransferMode(){ return false; }
  function isAutoSyncEnabled(){ return true; }
  function remoteSaveOnHold(){ return false; }
  function hasAnyCloudProviderAvailable(){ return true; }
  function getDataTimestamp(d){ return new Date((d && d.meta && d.meta.updatedAt) || 0).getTime() || 0; }
  function countEntities(){ return 10; }
  function updateSyncChip(){}
  function saveLocalData(){}
  function render(){}
  function toast(){}
  function t(k){ return k; }
  function getLang(){ return "de"; }
  function resetCloudSyncHealth(){}
  function normalizeData(d){ return d; }
  function mergeData(l, r){ var o = {}; for (var k in l) o[k] = l[k]; for (var k2 in r) o[k2] = r[k2]; return o; }
  function restoreReadingHubShadowFromData(){}
  function restoreExtraLocalKeys(){}
  function mergeRemoteSettings(a){ return a; }
  function saveSettings(){}
  function idbBackup(){}
  function createEntity(){}
  function nowIso(){ return new Date().toISOString(); }
  function buildRemoteAppPayload(){ return { meta: { updatedAt: new Date().toISOString() } }; }
  async function remoteGet(o){ spy.remoteGet++; return remoteGetImpl(o); }
  async function remotePut(){ spy.remotePut++; spy.writes++; return { ok: true, status: 200 }; }
  async function pullAndMergeBeforeSave(){ return { ok: true, merged: false }; }
`;

function harness() {
  const src = [
    PRELUDE,
    cutTo("var AUTH_RESYNC_MAX_MS = 30000;", "window.authResyncActive"),
    cutTo("var _coreReadOk = false;", "window.coreReadOk"),
    cutTo("var _authResyncDone = false;", "async function resyncAfterAuth(reason) {"),
    cut("async function resyncAfterAuth(reason) {"),
    cut("async function syncFreshness(reason) {"),
    cutSafetyNet(),
    cut("async function doSave(silent = false) {"),
  ].join("\n")
    + `\nreturn {
         APP: APP, log: log, spy: spy,
         authResyncActive: authResyncActive,
         resyncAfterAuth: resyncAfterAuth,
         syncFreshness: syncFreshness,
         safetyNetTick: safetyNetTick,
         doSave: doSave,
         coreReadOk: function(){ return _coreReadOk; },
         dirty: function(){ return _saveDirty; },
         setDirty: function(v){ _saveDirty = v; },
         setLock: function(v){ _syncLockActive = v; },
         setRemoteGet: function(fn){ remoteGetImpl = fn; },
         setCoreReadOk: function(v){ _coreReadOk = v; },
         forceRunning: function(startedAt){ _authResyncRunning = true; _authResyncStartedAt = startedAt; },
       };`;
  const APP = { state: { storage: {}, settings: { storage: { autoSave: true } }, ui: {}, data: { entities: {}, meta: {} } } };
  return new Function("APP", "coreAuthCurrentUser", src)(APP, () => ({ uid: "u1" }));
}

// ── 1. Der exakte Livelauf: kein Write vor bestaetigtem GET+Merge ─────────
{
  const h = harness();
  let aufloesen;
  h.setRemoteGet(() => new Promise((res) => { aufloesen = res; }));   // GET haengt noch

  const resync = h.resyncAfterAuth("auth_state_changed");
  ok(h.authResyncActive() === true, "der Riegel greift waehrend des Abgleichs nicht");

  // Das Anmeldefenster schliesst: focus -> Lock -> syncFreshness
  h.setLock(true);
  const frisch = await h.syncFreshness("window_focus");
  ok(frisch === false, "syncFreshness laeuft waehrend des Abgleichs weiter");
  ok(h.spy.remoteGet === 1, `syncFreshness hat zusaetzlich gelesen (${h.spy.remoteGet} statt 1)`);

  // doSave — muss SOFORT umkehren und darf _saveDirty NICHT setzen
  const ds = await h.doSave(true);
  ok(ds && ds.reason === "auth_resync_running", "doSave kehrt waehrend des Abgleichs nicht mit eigenem Grund um");
  ok(h.dirty() === false, "doSave hat _saveDirty gesetzt — das 5-Sekunden-Netz wuerde es spaeter hochladen");

  // das freie 5-Sekunden-Netz
  h.setDirty(true);                       // wie es der Sperr-Riegel frueher hinterliess
  h.safetyNetTick();
  ok(h.spy.writes === 0, "das 5-Sekunden-Sicherheitsnetz hat waehrend des Abgleichs geschrieben");
  ok(h.spy.remotePut === 0, "es lief ein remotePut vor dem bestaetigten Lesevorgang");

  // Jetzt kommt der Serverstand an
  aufloesen({ ok: true, data: { entities: {}, meta: { updatedAt: "2026-08-23T14:08:59.753Z" }, marker: "Q-S4" } });
  const r = await resync;
  ok(r.ok === true && r.pushed === false, "der nachgeholte Abgleich meldet keinen lesenden Erfolg");
  ok(h.coreReadOk() === true, "markCoreReadOk wurde nicht gesetzt");
  ok(h.authResyncActive() === false, "der Riegel ist nach dem Abgleich nicht geloest");
  ok(h.spy.writes === 0, "der Abgleich selbst hat geschrieben");
  ok(h.APP.state.data.marker === "Q-S4", "der Serverstand wurde nicht gemergt");
}

// ── 2. Der Riegel loest sich bei Erfolg UND bei Fehler (try/finally) ──────
{
  const h = harness();
  h.setRemoteGet(async () => ({ ok: false, reason: "read_failed" }));
  const r = await h.resyncAfterAuth("test");
  ok(r.ok === false && r.reason === "read_failed", "der Fehlerfall meldet sich nicht");
  ok(h.authResyncActive() === false, "nach einem Fehlschlag bleibt der Riegel haengen");
  ok(h.coreReadOk() === false, "ein Fehlschlag setzt faelschlich _coreReadOk");
  ok(h.log.some((l) => /fehlgeschlagen/.test(l)), "der Misserfolg wird nicht protokolliert");

  const h2 = harness();
  h2.setRemoteGet(async () => { throw new Error("Netz weg"); });
  const r2 = await h2.resyncAfterAuth("test");
  ok(r2.reason === "threw", "ein geworfener Abgleich meldet sich nicht");
  ok(h2.authResyncActive() === false, "nach einem Wurf bleibt der Riegel haengen");
}

// ── 3. Erfolg UND Misserfolg werden ausdruecklich protokolliert ───────────
{
  const h = harness();
  h.setRemoteGet(async () => ({ ok: true, data: { entities: {}, meta: { updatedAt: "2026-08-23T14:08:59.753Z" } } }));
  await h.resyncAfterAuth("test");
  ok(h.log.some((l) => /Anmeldung nachgetragen/.test(l)), "der Start wird nicht protokolliert");
  ok(h.log.some((l) => /erfolgreich/.test(l)), "der Erfolg wird nicht protokolliert — erneute Log-Stille");
}

// ── 4. Haengender Abgleich: Maximalalter loest den Riegel, KEIN Write ─────
{
  const h = harness();
  h.setRemoteGet(() => new Promise(() => {}));          // settelt nie
  h.resyncAfterAuth("haenger");
  ok(h.authResyncActive() === true, "der Riegel greift beim haengenden Abgleich nicht");

  // Alter kuenstlich ueber die Grenze schieben
  h.forceRunning(Date.now() - 31000);
  ok(h.authResyncActive() === false, "das Maximalalter loest den Riegel nicht");
  ok(h.log.some((l) => /Auth-Resync-Timeout/.test(l)), "der Ablauf wird nicht sichtbar protokolliert");
  ok(h.APP.state.storage.status === "offline", "der Ablauf hinterlaesst keinen sichtbaren Status");
  ok(/kein Upload/.test(h.APP.state.storage.message || ""), "die Statusmeldung nennt den fehlenden Upload nicht");
  ok(h.coreReadOk() === false, "_coreReadOk wurde trotz haengendem Abgleich gesetzt");

  // Und trotz geloestem Riegel darf nichts geschrieben werden.
  h.setDirty(true);
  h.safetyNetTick();
  ok(h.spy.writes === 0, "nach dem Ablauf wurde geschrieben, obwohl kein Serverstand gelesen wurde");
  const ds = await h.doSave(true);
  ok(ds && ds.reason === "no_successful_read",
    `doSave laesst nach dem Ablauf durch (Grund "${ds && ds.reason}")`);
  ok(h.spy.remotePut === 0, "es lief ein remotePut nach dem Ablauf");
}

// ── 5. Ohne laufenden Abgleich bleibt alles wie bisher ────────────────────
{
  const h = harness();
  ok(h.authResyncActive() === false, "der Riegel greift ohne laufenden Abgleich");
  h.setLock(true);
  const ds = await h.doSave(true);
  ok(ds === undefined, "der bisherige Sperr-Riegel in doSave verhaelt sich anders");
  ok(h.dirty() === true, "der bisherige Sperr-Riegel setzt _saveDirty nicht mehr");
}

// ── 6. Quelltextregeln ───────────────────────────────────────────────────
{
  const ds = cut("async function doSave(silent = false) {");
  const riegel = ds.indexOf("authResyncActive()");
  const ersterDirty = ds.indexOf("_saveDirty = true");
  ok(riegel > 0, "doSave kennt den Riegel nicht");
  ok(ersterDirty > riegel, "der Riegel steht hinter dem ersten _saveDirty = true");
  ok(/reason: 'auth_resync_running'/.test(ds), "doSave meldet den Riegel nicht mit eigenem Grund");

  const rs = cut("async function resyncAfterAuth(reason) {");
  ok(/finally \{/.test(rs), "resyncAfterAuth loest den Riegel nicht per finally");
  ok(/_authResyncRunning = false;/.test(rs), "das finally loest den Riegel nicht");
  ok(/_authResyncStartedAt = Date\.now\(\)/.test(rs), "der Zeitstempel des Riegels wird nicht gesetzt");

  const sf = cut("async function syncFreshness(reason) {");
  ok(/if \(authResyncActive\(\)\) return false;/.test(sf), "syncFreshness ist nicht gesperrt");

  const netz = cutSafetyNet();
  ok(/if \(authResyncActive\(\)\) return;/.test(netz), "das 5-Sekunden-Sicherheitsnetz ist nicht gesperrt");

  const aktiv = cut("function authResyncActive() {");
  ok(/AUTH_RESYNC_MAX_MS/.test(aktiv), "der Riegel kennt kein Maximalalter");
  ok(/Auth-Resync-Timeout/.test(aktiv), "der Ablauf meldet sich nicht sichtbar");
  ok(!/_coreReadOk = true/.test(aktiv), "der Ablauf setzt faelschlich _coreReadOk");
}

// ── 7. Nicht angefasster Bestand (Commit 2/3 und F-20 bleiben offen) ─────
{
  // Commit 2/B hat diesen Pfad eingereiht — der Riegel prueft jetzt das
  // Gegenteil: es darf KEIN direkter remotePut in syncFreshness zurueckkehren.
  ok(!/await remotePut\(buildRemoteAppPayload\(\)\);\s*\}\s*catch/.test(index),
    "der direkte remotePut-Pfad in syncFreshness ist zurueckgekehrt");
  ok(/if \(remote\.weekPlan && remote\.weekPlan\.days\)/.test(index),
    "der weekPlan-Zweig wurde veraendert — das ist Commit 3");
  ok(/const snap = await ref\.once\('value'\);/.test(index),
    "die SDK-Zeitgrenze wurde angefasst — das ist F-20/P1.2");
  ok(/if \(_authResyncDone\) return \{ ok: false, reason: 'already_done' \};/.test(index),
    "die _authResyncDone-Semantik wurde veraendert — das ist F-20/P1.2");
}


/* ══════════════════════════════════════════════════════════════════════════
 * COMMIT 2/B — der Remote-neuer-Zweig schreibt nicht mehr an doSave vorbei
 *
 * syncFreshness rief in diesem Zweig frueher direkt remotePut(). Das umging
 * doSave vollstaendig — und damit die Push-Sperre _coreReadOk, den Sync-Lock
 * und den Riegel des Auth-Resyncs. Nach einem Auth-Resync-Timeout mit
 * _coreReadOk === false haette dieser Weg trotzdem geschrieben.
 * ══════════════════════════════════════════════════════════════════════════ */

// Ein Serverstand, der NEUER ist als der lokale — der Zweig, um den es geht.
function remoteNeuer() {
  const jetzt = Date.now();
  return {
    local:  new Date(jetzt - 20000).toISOString(),
    remote: new Date(jetzt).toISOString(),
  };
}
async function laufRemoteNeuer(h, { lock = false, coreReadOk = true, resyncStartedAt = null } = {}) {
  const ts = remoteNeuer();
  h.APP.state.data.meta = { updatedAt: ts.local };
  h.setRemoteGet(async () => ({
    ok: true,
    data: { entities: {}, meta: { updatedAt: ts.remote }, vomServer: true },
  }));
  h.setCoreReadOk(coreReadOk);
  h.setLock(lock);
  if (resyncStartedAt !== null) h.forceRunning(resyncStartedAt);
  return h.syncFreshness("test_remote_newer");
}

// ── B-1: kein direkter remotePut mehr in syncFreshness ───────────────────
{
  const sf = cut("async function syncFreshness(reason) {");
  ok(!/await remotePut\(/.test(sf),
    "syncFreshness ruft weiterhin direkt remotePut() und umgeht damit alle Riegel");
  ok(/await doSave\(true\)/.test(sf),
    "der Remote-neuer-Zweig geht nicht ueber doSave");
  const zweigRoh = sf.slice(sf.indexOf("Remote was"), sf.indexOf("} else if (localTs"));
  // Kommentarzeilen ausblenden: der Ersatzkommentar nennt remotePut absichtlich.
  const zweig = zweigRoh.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok(/doSave\(true\)/.test(zweig), "der Remote-neuer-Zweig selbst ruft doSave nicht");
  ok(!/remotePut\(/.test(zweig), "im Remote-neuer-Zweig steht noch ein remotePut");
}

// ── B-2: unter _authResyncRunning schreibt der Zweig nicht ───────────────
{
  const h = harness();
  const r = await laufRemoteNeuer(h, { resyncStartedAt: Date.now() });
  ok(r === false, "syncFreshness laeuft trotz laufendem Auth-Resync weiter");
  ok(h.spy.writes === 0, "der Remote-neuer-Zweig hat waehrend des Auth-Resyncs geschrieben");
}

// ── B-3: nach Auth-Resync-Maximalalter, _coreReadOk=false ────────────────
// Der Riegel hat sich selbst geloest, ein Serverstand wurde nie bestaetigt.
// Die tragende Regel ist "kein Write OHNE bestaetigten Lesevorgang" — nicht
// "nie ein Write". Beide Faelle werden deshalb getrennt festgehalten.
{
  // a) Der eigene Lesevorgang von syncFreshness scheitert ebenfalls
  //    -> nichts wird geschrieben, _coreReadOk bleibt false.
  const h = harness();
  h.forceRunning(Date.now() - 31000);          // Maximalalter ueberschritten
  ok(h.authResyncActive() === false, "das Maximalalter loest den Riegel nicht");
  h.setCoreReadOk(false);
  h.setRemoteGet(async () => ({ ok: false, reason: "read_failed" }));
  const r = await h.syncFreshness("nach_timeout");
  ok(r === false, "syncFreshness meldet Erfolg trotz gescheitertem Lesevorgang");
  ok(h.spy.writes === 0,
    "nach dem Auth-Resync-Timeout wurde geschrieben, obwohl kein Serverstand bestaetigt war");
  ok(h.spy.remotePut === 0, "es lief ein remotePut ohne bestaetigten Lesevorgang");
  ok(h.coreReadOk() === false, "ein gescheiterter Lesevorgang setzt faelschlich _coreReadOk");
}
{
  // b) Der eigene Lesevorgang gelingt: DANN ist der Stand bestaetigt
  //    (markCoreReadOk in syncFreshness), und der Push ist zulaessig.
  //    Ohne diesen Zweig waere jede Sitzung nach einem einzigen Timeout
  //    dauerhaft schreibblind — das waere kein Schutz, sondern ein Ausfall.
  const h = harness();
  h.forceRunning(Date.now() - 31000);
  h.setCoreReadOk(false);
  const r = await laufRemoteNeuer(h, { coreReadOk: false });
  ok(r === true, "der Zweig hat den Serverstand nicht gemergt");
  ok(h.APP.state.data.vomServer === true, "der neuere Serverstand wurde nicht uebernommen");
  ok(h.coreReadOk() === true,
    "der bestaetigte Lesevorgang von syncFreshness setzt _coreReadOk nicht");
  ok(h.spy.writes === 1,
    "nach einem bestaetigten Lesevorgang wird der gemergte Stand nicht hochgeladen");
}

// ── B-4: unter Sync-Lock schreibt der Zweig nicht sofort ─────────────────
{
  const h = harness();
  await laufRemoteNeuer(h, { lock: true, coreReadOk: true });
  ok(h.spy.writes === 0, "der Remote-neuer-Zweig hat trotz Sync-Lock sofort geschrieben");
  ok(h.dirty() === true, "der zurueckgestellte Push wurde nicht ueber _saveDirty vorgemerkt");
}

// ── B-5: der regulaer erlaubte Fall schreibt weiterhin ───────────────────
{
  const h = harness();
  const r = await laufRemoteNeuer(h, { lock: false, coreReadOk: true });
  ok(r === true, "der Remote-neuer-Zweig meldet keinen Durchlauf");
  ok(h.APP.state.data.vomServer === true, "der Serverstand wurde nicht gemergt");
  ok(h.spy.writes === 1, `im erlaubten Fall wurde ${h.spy.writes}-mal geschrieben statt einmal`);
  ok(h.spy.remotePut === 1, "der Schreibvorgang lief nicht ueber remotePut");
}

// ── B-6: der Zweig endet in doSave und erbt dessen Push-Sperre ───────────
// Der frueher direkte remotePut kannte diese Sperre nicht. Der Nachweis, dass
// sie jetzt greift, gehoert an doSave selbst: ohne bestaetigten Lesevorgang
// und ohne Sperr-Lock kehrt es mit eigenem Grund um und schreibt nicht.
{
  const h = harness();
  h.setCoreReadOk(false);
  h.setLock(false);
  const ds = await h.doSave(true);
  ok(ds && ds.reason === "no_successful_read",
    `doSave laesst ohne bestaetigten Lesevorgang durch (Grund "${ds && ds.reason}")`);
  ok(h.spy.writes === 0, "ohne bestaetigten Lesevorgang wurde geschrieben");
  ok(h.spy.remotePut === 0, "es lief ein remotePut ohne bestaetigten Lesevorgang");
}

// ── B-7: der local-newer-Zweig bleibt unveraendert ───────────────────────
{
  const sf = cut("async function syncFreshness(reason) {");
  ok(/Local is newer, pushing to remote\.\.\.[\s\S]{0,80}await doSave\(true\)/.test(sf),
    "der local-newer-Zweig wurde veraendert");
}

console.log(`sync auth write race: ok (${checks} Pruefungen)`);
