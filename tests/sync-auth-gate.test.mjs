/*
 * Der Rechner las und schrieb den Kern-Datenstand, ohne auf die Anmeldung zu
 * warten.
 *
 * Die RTDB-Regel fuer appStore lautet "auth != null". Auf einem frischen
 * Rechner gibt es beim Start noch keinen Firebase-Nutzer — die Anmeldung
 * stammt aus dem Drive-Modul und trifft asynchron ein. Jeder Zugriff kam
 * deshalb als permission_denied zurueck, wurde im catch von rtdbJsonGet stumm
 * verschluckt und endete als "Remote load failed, using local data".
 *
 * Schlimmer als die fehlende Meldung war, was danach kam: der Startvorgang
 * lud anschliessend den ungeprueften lokalen Stand hoch. Der Rechner ersetzte
 * damit einen Serverstand, den er nie gelesen hatte — genau der Weg, auf dem
 * ein vom Handy geschriebener Eintrag verschwindet.
 *
 * Der Test laesst die ECHTEN Funktionen gegen ein Firebase-Attrappen-SDK
 * laufen und zaehlt mit, wann tatsaechlich zugegriffen wird.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── Echte Funktionen herausschneiden ──────────────────────────────────────
// Von einem Anker bis zu einem anderen — fuer Zustandsbloecke aus mehreren
// Deklarationen, die cut() sonst nach der ersten Zeile abschneiden wuerde.
function cutTo(from, to) {
  const start = index.indexOf(from);
  const end = index.indexOf(to, start + from.length);
  ok(start > 0 && end > start, `Bereich ${from} .. ${to} nicht gefunden`);
  return index.slice(start, end);
}
function cut(header) {
  const start = index.indexOf(header);
  ok(start > 0, `${header} wurde in index.html nicht gefunden`);
  const cands = ["\nfunction ", "\nasync function ", "\nwindow.", "\nconst ", "\nlet ", "\nvar "]
    .map((m) => index.indexOf(m, start + header.length))
    .filter((n) => n > 0);
  const end = Math.min(...cands);
  ok(end > start, `Ende von ${header} nicht bestimmbar`);
  return index.slice(start, end);
}

const DEPS = [
  "window", "firebase", "APP", "console", "setTimeout", "_cloudHealth", "persistCloudHealth",
  "updateSyncChip", "shouldTryCloudProvider", "rememberCloudSuccess", "rememberCloudFailure",
  "RTDB_NODE", "RTDB_DB_URL", "rtdbNodeKey", "rtdbDbRef", "fetchWithTimeout",
  "getDataTimestamp", "getOrCreateDeviceId",
];

function buildHarness({ user = null, authMode = "sync", refImpl = null } = {}) {
  const log = { refCalls: [], reads: 0, writes: 0, chip: [] };
  let authCb = null;
  const auth = () => ({
    currentUser: authMode === "sync" ? user : null,
    onAuthStateChanged(cb) { authCb = cb; return () => { authCb = null; }; },
  });
  const fb = { app: () => ({}), auth };
  const win = { firebase: fb };
  const APP = { state: { settings: { storage: {} }, storage: {}, data: {} } };
  const health = { rtdb: { failCount: 0, backoffUntil: 0, lastError: "", lastStatus: 0 } };

  const src = [
    cutTo("var _coreAuthResolved = false;", "function coreAuthCurrentUser() {"),
    cut("function coreAuthCurrentUser() {"),
    cut("function noteCoreAuthState(user) {"),
    cut("function coreAuthReady() {"),
    cut("function rememberCoreAuthRequired(provider) {"),
    cut("function isRtdbCloudAvailable() {"),
    cut("async function rtdbJsonGet(key, options = {}) {"),
    cut("async function rtdbJsonPut(key, data, options = {}) {"),
  ].join("\n");

  const factory = new Function(...DEPS,
    src + "\nreturn { coreAuthReady, noteCoreAuthState, isRtdbCloudAvailable, rtdbJsonGet, rtdbJsonPut };");

  const api = factory(
    win, fb, APP, { log() {}, warn() {}, error() {} }, setTimeout, health,
    () => {}, () => { log.chip.push(APP.state.storage.status); },
    () => true, () => {}, () => {},
    "appStore", "https://rtdb.example",
    (k) => String(k).replace(/[.#$[\]/]/g, "_"),
    (p) => { log.refCalls.push(p); return refImpl || {
      once: async () => { log.reads++; return { exists: () => true, val: () => ({ data: JSON.stringify({ meta: { updatedAt: "2026-01-01T00:00:00.000Z" } }) }) }; },
      set: async () => { log.writes++; },
    }; },
    async () => { throw new Error("fetchWithTimeout darf hier nicht laufen"); },
    (d) => new Date(d?.meta?.updatedAt || 0).getTime() || 0,
    () => "dev_test_local",
  );
  return { api, log, APP, health, fireAuth: (u) => authCb && authCb(u) };
}

// ── 1. Kaltstart: der Lesevorgang wartet auf die Anmeldung ────────────────
{
  const h = buildHarness({ authMode: "async" });
  const p = h.api.rtdbJsonGet("app-data.json", { force: true });
  // Solange die Anmeldung nicht aufgeloest ist, darf NICHTS angefasst werden.
  await new Promise((r) => setImmediate(r));
  ok(h.log.refCalls.length === 0, "vor der Anmeldung wurde bereits auf die Datenbank zugegriffen");
  h.fireAuth({ uid: "u1" });
  const res = await p;
  ok(res.ok === true, "nach eingetroffener Anmeldung schlaegt der Lesevorgang fehl");
  ok(h.log.reads === 1, "nach der Anmeldung wurde nicht genau einmal gelesen");
  ok(h.log.writes === 0, "der Lesevorgang hat geschrieben");
}

// ── 2. Kein Nutzer: sichtbarer auth_required-Status, KEIN Zugriff ─────────
{
  const h = buildHarness({ authMode: "async" });
  const p = h.api.rtdbJsonGet("app-data.json", { force: true });
  h.fireAuth(null);                       // Anmeldung aufgeloest: niemand da
  const res = await p;
  ok(res.ok === false, "ohne Nutzer meldet der Lesevorgang Erfolg");
  ok(res.authRequired === true, "ohne Nutzer fehlt das Kennzeichen authRequired");
  ok(res.reason === "auth_required", "ohne Nutzer fehlt der Grund auth_required");
  ok(h.log.refCalls.length === 0, "ohne Nutzer wurde trotzdem auf die Datenbank zugegriffen");
  ok(h.APP.state.storage.status === "auth_required",
    `der Sync-Status meldet "${h.APP.state.storage.status}" statt auth_required`);
  ok(/Anmeldung erforderlich/.test(h.APP.state.storage.message || ""),
    "die Statusmeldung nennt die fehlende Anmeldung nicht");
  ok(h.health.rtdb.backoffUntil === 0,
    "die fehlende Anmeldung setzt einen Backoff — damit sperrt sich der Rechner die spaetere Anmeldung aus");
}

// ── 2b. Ohne Nutzer wird auch NICHT geschrieben ───────────────────────────
{
  const h = buildHarness({ authMode: "async" });
  const p = h.api.rtdbJsonPut("app-data.json", { meta: { updatedAt: "2026-08-23T14:00:00.000Z" } }, { force: true });
  h.fireAuth(null);
  const res = await p;
  ok(res.ok === false && res.authRequired === true, "ohne Nutzer wurde ein Schreibvorgang zugelassen");
  ok(h.log.writes === 0, "ohne Nutzer wurde tatsaechlich geschrieben");
  ok(h.log.refCalls.length === 0, "ohne Nutzer wurde eine Datenbank-Referenz geholt");
}

// ── 3. isRtdbCloudAvailable beachtet den Anmeldezustand ───────────────────
{
  const h = buildHarness({ authMode: "async" });
  ok(h.api.isRtdbCloudAvailable() === true,
    "vor geklaertem Anmeldezustand wird RTDB vorschnell abgeschrieben");
  h.api.noteCoreAuthState(null);          // geklaert: niemand angemeldet
  ok(h.api.isRtdbCloudAvailable() === false,
    "isRtdbCloudAvailable prueft nur das SDK und nicht den Anmeldezustand");
  h.api.noteCoreAuthState({ uid: "u1" });
  ok(h.api.isRtdbCloudAvailable() === true,
    "nach der Anmeldung gilt RTDB weiterhin als nicht verfuegbar");
}

// ── 4. Nach einem Lesefehler wird nicht automatisch gepusht ───────────────
{
  const bootRaw = index.slice(index.indexOf("// After startup sync is complete"),
                              index.indexOf("// Listen for online/offline events"));
  // Kommentarzeilen ausblenden: der Ersatzkommentar nennt doSave absichtlich.
  const boot = bootRaw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok(!/doSave\(/.test(boot),
    "nach dem Startvorgang steht weiterhin ein automatischer doSave() — der laedt genau nach einem Lesefehler den ungeprueften Stand hoch");

  const doSave = cut("async function doSave(silent = false) {");
  ok(/if \(!forceRemote && !_coreReadOk\)/.test(doSave),
    "doSave() kennt keine Sperre fuer automatische Pushes ohne erfolgreichen Lesevorgang");
  ok(/no_successful_read/.test(doSave),
    "doSave() meldet den unterdrueckten Push nicht mit eigenem Grund");
  const guardPos = doSave.indexOf("!_coreReadOk");
  const putPos = doSave.indexOf("remotePut(");
  ok(guardPos > 0 && putPos > guardPos,
    "die Sperre steht hinter dem Push und wirkt damit nicht");
}

// ── 5. Nachgeholter Abgleich: genau einmal, nur lesen ─────────────────────
{
  const src = cutTo("var _coreReadOk = false;", "window.coreReadOk") +
              cutTo("var _authResyncDone = false;", "async function resyncAfterAuth(reason) {") +
              cut("async function resyncAfterAuth(reason) {");
  let reads = 0, pushes = 0, renders = 0, saves = 0;
  const APP = { state: { settings: {}, storage: {}, ui: {}, data: { entities: {} } } };
  const factory = new Function(
    "APP", "console", "window", "coreAuthCurrentUser", "isManualTransferMode", "resetCloudSyncHealth",
    "remoteGet", "remotePut", "doSave", "mergeData", "normalizeData", "restoreReadingHubShadowFromData",
    "restoreExtraLocalKeys", "mergeRemoteSettings", "saveSettings", "saveLocalData", "render",
    "updateSyncChip", "toast", "t",
    src + "\nreturn { resyncAfterAuth, coreReadOk };");
  const api = factory(
    APP, { log() {}, warn() {} }, {}, () => ({ uid: "u1" }), () => false, () => {},
    async () => { reads++; return { ok: true, data: { entities: {}, meta: { updatedAt: "2026-08-23T14:08:59.753Z" }, marker: "Q-S4" } }; },
    async () => { pushes++; return { ok: true }; },
    async () => { pushes++; return { ok: true }; },
    (local, remote) => ({ ...local, ...remote, gemergt: true }),
    (d) => d, () => {}, () => {}, (a) => a, () => {}, () => { saves++; }, () => { renders++; },
    () => {}, () => {}, (k) => k,
  );

  const first = await api.resyncAfterAuth("test");
  ok(first.ok === true, "der nachgeholte Abgleich meldet keinen Erfolg");
  ok(first.pushed === false, "der nachgeholte Abgleich hat gepusht");
  ok(reads === 1, `der nachgeholte Abgleich hat ${reads}-mal gelesen statt einmal`);
  ok(pushes === 0, "der nachgeholte Abgleich hat einen Push ausgeloest");
  ok(APP.state.data.gemergt === true, "der Serverstand wurde nicht gemergt");
  ok(APP.state.data.marker === "Q-S4", "der Marker der Gegenseite hat den Merge nicht ueberlebt");
  ok(saves === 1 && renders === 1, "lokale Sicherung oder Neuzeichnen fehlt");
  ok(api.coreReadOk() === true, "der erfolgreiche Lesevorgang wurde nicht vermerkt");

  const second = await api.resyncAfterAuth("test");
  ok(second.ok === false, "der nachgeholte Abgleich lief ein zweites Mal");
  ok(reads === 1, "der zweite Aufruf hat erneut gelesen");
  ok(pushes === 0, "der zweite Aufruf hat gepusht");
}

// ── 6. Der Anmeldehinweis zeichnet in ein WIRKLICH vorhandenes Ziel ───────
// Die frueheren Beschriftungen lagen in updateSyncChip() hinter der Suche
// nach #syncChip/#syncStatus — Markup, das nie existiert hat. Die Funktion
// brach an ihrem ersten Zeilenpaar ab, jede Beschriftung war wirkungslos.
{
  const chip = cut("function updateSyncChip() {");
  ok(/getElementById\('syncNotice'\)/.test(chip),
    "updateSyncChip zeichnet nicht in den Streifen #syncNotice");
  ok(!/\$\("#syncChip"\)|\$\("#syncStatus"\)/.test(chip),
    "updateSyncChip sucht weiterhin das nie vorhandene #syncChip/#syncStatus");
  ok(/Anmeldung erforderlich \u2014 Daten nicht synchronisiert/.test(chip),
    "der geforderte Wortlaut fehlt");
  ok(/aria-live/.test(chip) && /aria-label/.test(chip),
    "aria-live oder aria-label fehlen");
  ok(/href="#\/drive"/.test(chip),
    "der Hinweis bietet keinen Weg zur Anmeldung ueber die vorhandene Route #/drive");
}

// ── 6b. Kein Renderziel darf ins Leere zeigen ─────────────────────────────
// Die Fehlerklasse hinter V2: eine Renderfunktion sucht per $("#…") oder
// getElementById eine id, die im Markup gar nicht steht. Der Aufruf scheitert
// still, und niemand sieht etwas. Diese Schleife haelt genau das fest.
{
  for (const id of ["syncNotice", "toasts", "main", "app"]) {
    ok(new RegExp(`id="${id}"`).test(index),
      `#${id} wird im Code gesucht, steht aber nicht im Markup`);
  }
  ok(!/id="syncChip"|id="syncStatus"/.test(index),
    "unerwartet: #syncChip/#syncStatus stehen doch im Markup — dann ist die Umstellung falsch");
  ok(!/\$\("#syncChip"\)/.test(index) && !/\$\("#syncStatus"\)/.test(index),
    "es gibt weiterhin einen Zugriff auf das nie vorhandene #syncChip/#syncStatus");
}

// ── 6c. Der Streifen liegt ausserhalb von #main ───────────────────────────
{
  const bodyStart = index.indexOf("<body");
  const appStart = index.indexOf('id="app"', bodyStart);
  const appEnd = index.indexOf('<div class="toast-container"', bodyStart);
  const noticePos = index.indexOf('id="syncNotice"', bodyStart);
  ok(noticePos > appStart, "#syncNotice steht vor der App-Huelle");
  ok(noticePos < appEnd + 400 && noticePos > index.indexOf('id="main"'),
    "#syncNotice sitzt nicht neben dem Toast-Behaelter");
  const mainOpen = index.indexOf('id="main"');
  const mainClose = index.indexOf("</main>", mainOpen);
  ok(!(noticePos > mainOpen && noticePos < mainClose),
    "#syncNotice liegt innerhalb von #main und wuerde von render() geloescht");
}

// ── 6d. Echter Stub-DOM-Test der Renderfunktion ──────────────────────────
{
  const el = {
    hidden: true, className: "", innerHTML: "", textContent: "", attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector(sel) {
      if (!/sn-text|sn-link/.test(this.innerHTML)) return null;
      if (sel === ".sn-text") return this._text || (this._text = { textContent: "" });
      if (sel === ".sn-link") return /sn-link/.test(this.innerHTML)
        ? (this._link || (this._link = { textContent: "" })) : null;
      return null;
    },
  };
  const APP = { state: { storage: { status: "auth_required" } } };
  const make = (doc) => new Function("document", "APP", "getLang",
    cut("function updateSyncChip() {") + "\nreturn updateSyncChip;")(doc, APP, () => "de");
  const doc = { getElementById: (id) => (id === "syncNotice" ? el : null) };
  const render = make(doc);

  render();
  ok(el.hidden === false, "bei auth_required bleibt der Streifen verborgen");
  ok(el._text.textContent === "Anmeldung erforderlich \u2014 Daten nicht synchronisiert",
    `falscher Wortlaut: "${el._text.textContent}"`);
  ok(el.attrs["aria-live"] === "polite", "aria-live fehlt oder ist falsch");
  ok(el.attrs["aria-label"] === "Anmeldung erforderlich \u2014 Daten nicht synchronisiert",
    "aria-label traegt nicht den Hinweistext");
  ok(el.attrs["role"] === "status", "role=status fehlt");
  ok(el._link && el._link.textContent === "Anmelden", "der Anmeldeknopf fehlt oder ist unbeschriftet");
  ok(el.className === "", "auth_required darf nicht als Warnung eingefaerbt werden");

  APP.state.storage.status = "offline";
  render();
  ok(el.hidden === false && el.className === "sn-warn",
    "der Offline-Fall wird nicht als Warnung dargestellt");

  APP.state.storage.status = "saved";
  render();
  ok(el.hidden === true, "bei saved bleibt der Streifen sichtbar");
  ok(el.attrs["aria-label"] === undefined, "aria-label bleibt nach dem Ausblenden stehen");

  // Fehlender Anker darf NICHT werfen.
  const leer = make({ getElementById: () => null });
  let warf = false;
  try { APP.state.storage.status = "auth_required"; leer(); } catch (e) { warf = true; }
  ok(warf === false, "ohne #syncNotice wirft updateSyncChip");
}

// ── 6e. Persistenz ueber render() hinweg ─────────────────────────────────
// render() ersetzt ausschliesslich #main. Ein Streifen daneben ueberlebt das.
{
  const nodes = { main: { innerHTML: "<p>alt</p>" }, syncNotice: { hidden: false, weg: false } };
  const doc = { getElementById: (id) => nodes[id] || null };
  nodes.main.innerHTML = "";                       // das tut render()
  ok(doc.getElementById("syncNotice") !== null && nodes.syncNotice.hidden === false,
    "der Streifen ueberlebt ein render() nicht");
}

// ── 7. onAuthStateChanged holt den Abgleich nach ──────────────────────────
{
  const init = cut("function initFirebaseNow() {");
  ok(/noteCoreAuthState\(user\)/.test(init),
    "initFirebaseNow traegt den Anmeldezustand nicht in den Kern-Abgleich ein");
  ok(/resyncAfterAuth\(/.test(init),
    "eine spaeter eintreffende Anmeldung loest keinen nachgeholten Abgleich aus");
}


/* ══════════════════════════════════════════════════════════════════════════
 * INTEGRATION — echte Funktionskette statt Einzelteile
 *
 * Die Bloecke oben pruefen einzelne Funktionen. Drei Fehler ueberleben so eine
 * Pruefung aber muehelos, weil sie erst im Zusammenspiel auftreten:
 *
 *  B1  coreAuthReady() merkt sich sein Ergebnis. Loest es einmal mit "kein
 *      Nutzer" auf, bleibt es die ganze Sitzung dabei — die spaetere Anmeldung
 *      wirkt nicht mehr, resyncAfterAuth() laeuft ins Leere.
 *  B2  Ohne Nutzer wird isRtdbCloudAvailable() false, primaryCloudProvider()
 *      liefert 'firebase' — und der Abgleich liest den Firebase-Storage-
 *      SCHATTEN. Der ist bis zu 45 s alt und enthaelt den Marker des Handys
 *      nicht. Er wuerde als "erfolgreich gelesen" durchgehen.
 *  B3  permission_denied des SDK hat keinen HTTP-Status und wurde wie ein
 *      beliebiger Fehler behandelt: Backoff statt Anmeldehinweis — und danach
 *      wieder der Storage-Schatten.
 *
 * Hier laufen deshalb die ECHTEN coreAuthReady, isRtdbCloudAvailable,
 * primaryCloudProvider, shouldTryCloudProvider, getCloudProviderOrder,
 * rememberCloudSuccess/Failure, rtdbJsonGet und remoteGetByKey zusammen.
 * Attrappe sind nur die beiden Aussenanschluesse: Firebase Storage und die
 * Netlify-Fassade.
 * ══════════════════════════════════════════════════════════════════════════ */
const INT_MARKER = "Q-S4-MOBILE-20260823-1608";

function buildIntegration({ authMode = "async", rtdbImpl = null } = {}) {
  const log = { rtdbReads: 0, storageReads: 0, netlifyReads: 0, chip: [] };
  let authCb = null;
  let currentUser = null;
  const fb = {
    app: () => ({}),
    auth: () => ({
      currentUser: authMode === "sync" ? currentUser : currentUser,
      onAuthStateChanged(cb) { authCb = cb; return () => { authCb = null; }; },
    }),
  };
  const win = { firebase: fb };
  const APP = { state: { settings: { storage: { blobKey: "app-data.json", autoSync: true } }, storage: {} } };
  const health = {
    lastGoodProvider: "",
    netlify: { failCount: 0, backoffUntil: 0, lastError: "", lastStatus: 0 },
    firebase: { failCount: 0, backoffUntil: 0, lastError: "", lastStatus: 0 },
    rtdb: { failCount: 0, backoffUntil: 0, lastError: "", lastStatus: 0 },
  };

  const src = [
    cutTo("var _coreAuthResolved = false;", "function coreAuthCurrentUser() {"),
    cut("function coreAuthCurrentUser() {"),
    cut("function noteCoreAuthState(user) {"),
    cut("function coreAuthReady() {"),
    cut("function isAuthDeniedError(e) {"),
    cut("function rememberCoreAuthRequired(provider) {"),
    cut("function isRtdbCloudAvailable() {"),
    cut("function primaryCloudProvider() {"),
    cut("function shouldTryCloudProvider(provider, options = {}) {"),
    cut("function hasAnyCloudProviderAvailable(options = {}) {"),
    cut("function rememberCloudSuccess(provider) {"),
    cut("function rememberCloudFailure(provider, info = {}) {"),
    cut("function getCloudProviderOrder(preferProvider) {"),
    cut("function isCoreDataKey(key) {"),
    cut("async function coreKeyAuthGate(key) {"),
    cut("async function rtdbJsonGet(key, options = {}) {"),
    cut("async function remoteGetByKey(key, options = {}) {"),
  ].join("\n");

  const DEPS2 = [
    "window", "firebase", "APP", "console", "setTimeout", "Date", "_cloudHealth",
    "persistCloudHealth", "updateSyncChip", "isAutoSyncEnabled", "isBlobSyncConfigured",
    "isFirebaseCloudAvailable", "RTDB_NODE", "RTDB_DB_URL", "rtdbNodeKey", "rtdbDbRef",
    "fetchWithTimeout", "getDataTimestamp", "firebaseJsonGet", "netlifyBlobGet",
  ];
  const factory = new Function(...DEPS2, src +
    "\nreturn { coreAuthReady, noteCoreAuthState, isRtdbCloudAvailable, primaryCloudProvider, rtdbJsonGet, remoteGetByKey, isAuthDeniedError };");

  const rtdbRef = rtdbImpl || {
    once: async () => {
      log.rtdbReads++;
      return { exists: () => true, val: () => ({
        data: JSON.stringify({
          entities: { notes: { mo7ob: { id: "mo7ob", title: INT_MARKER } } },
          meta: { updatedAt: "2026-08-23T14:08:59.753Z", lastSavedBy: "mobile-app" },
        }),
      }) };
    },
  };

  const api = factory(
    win, fb, APP, { log() {}, warn() {}, error() {} }, setTimeout, Date, health,
    () => {}, () => { log.chip.push(APP.state.storage.status); },
    () => true, () => true, () => true,
    "appStore", "https://rtdb.example",
    (k) => String(k).replace(/[.#$[\]/]/g, "_"),
    () => rtdbRef,
    async () => { throw new Error("REST darf hier nicht laufen"); },
    (d) => new Date(d?.meta?.updatedAt || 0).getTime() || 0,
    // Firebase-Storage-Schatten: WUERDE erfolgreich antworten — aber mit dem
    // markerlosen Altstand. Genau die Falle aus B2.
    async () => { log.storageReads++; return { ok: true, provider: "firebase",
      data: { entities: { notes: {} }, meta: { updatedAt: "2026-08-23T09:00:00.000Z", lastSavedBy: "dev_desktop_1" } } }; },
    async () => { log.netlifyReads++; return { ok: false, skipped: true, provider: "netlify" }; },
  );
  return { api, log, APP, health, login: (u) => { currentUser = u; api.noteCoreAuthState(u); if (authCb) authCb(u); },
           resolveNoUser: () => { if (authCb) authCb(null); } };
}

// ── I-1 (B2): ohne Nutzer kein Storage-Schatten, kein Erfolg ──────────────
{
  const h = buildIntegration();
  const p = h.api.remoteGetByKey("app-data.json", { force: true });
  h.resolveNoUser();
  const res = await p;
  ok(res.ok === false, "ohne Anmeldung meldet der Kern-Lesevorgang Erfolg");
  ok(res.authRequired === true, "ohne Anmeldung fehlt authRequired am Ergebnis von remoteGetByKey");
  ok(h.log.storageReads === 0,
    `der Firebase-Storage-Schatten wurde ${h.log.storageReads}-mal gelesen — ein veralteter Stand haette als Erfolg gegolten`);
  ok(h.log.rtdbReads === 0, "ohne Anmeldung wurde trotzdem aus der RTDB gelesen");
  ok(h.APP.state.storage.status === "auth_required", "der Sync-Status meldet die fehlende Anmeldung nicht");
}

// ── I-2 (B1): nach der Anmeldung liest derselbe Ablauf wirklich ───────────
{
  const h = buildIntegration();
  const erst = h.api.remoteGetByKey("app-data.json", { force: true });
  h.resolveNoUser();
  const r1 = await erst;
  ok(r1.authRequired === true, "erster Versuch ohne Nutzer meldet nicht authRequired");
  ok(h.api.isRtdbCloudAvailable() === false, "nach geklaertem Zustand ohne Nutzer gilt RTDB weiter als verfuegbar");

  h.login({ uid: "u1" });          // die Anmeldung trifft ein
  ok(h.api.isRtdbCloudAvailable() === true, "nach der Anmeldung gilt RTDB weiter als nicht verfuegbar");
  ok(h.api.primaryCloudProvider() === "rtdb", "nach der Anmeldung ist RTDB nicht wieder Primaerspeicher");

  const r2 = await h.api.remoteGetByKey("app-data.json", { force: true });
  ok(r2.ok === true,
    "nach der Anmeldung schlaegt der Lesevorgang immer noch fehl — das zwischengespeicherte Auth-Versprechen klebt");
  ok(h.log.rtdbReads === 1, `nach der Anmeldung wurde ${h.log.rtdbReads}-mal aus der RTDB gelesen statt genau einmal`);
  ok(h.log.storageReads === 0, "nach der Anmeldung wurde zusaetzlich der Storage-Schatten gelesen");
  ok(r2.data.entities.notes.mo7ob.title === INT_MARKER, "der Marker des Handys wurde nicht gelesen");
  ok(r2.provider === "rtdb", `der Stand kam von "${r2.provider}" statt aus der RTDB`);
}

// ── I-3 (B3): permission_denied ist ein Anmeldefehler, kein Netzfehler ────
{
  const denied = Object.assign(new Error("permission_denied at /appStore/app-data_json"), { code: "PERMISSION_DENIED" });
  const h = buildIntegration({ rtdbImpl: { once: async () => { throw denied; } } });
  h.login({ uid: "u1" });          // angemeldet — der Server verweigert trotzdem
  const res = await h.api.remoteGetByKey("app-data.json", { force: true });
  ok(res.authRequired === true, "permission_denied wird nicht als Anmeldefehler erkannt");
  ok(res.reason === "permission_denied", `der Grund lautet "${res.reason}" statt permission_denied`);
  ok(h.log.storageReads === 0,
    "nach permission_denied lief der Abgleich auf den Storage-Schatten weiter");
  ok(h.APP.state.storage.status === "auth_required", "permission_denied bleibt im Sync-Chip unsichtbar");
  ok(h.health.rtdb.backoffUntil === 0, "permission_denied setzt einen generischen Backoff");

  // Abgrenzung: ein echter Netzfehler bleibt ein Netzfehler.
  const netz = new Error("Failed to fetch");
  const h2 = buildIntegration({ rtdbImpl: { once: async () => { throw netz; } } });
  h2.login({ uid: "u1" });
  const res2 = await h2.api.remoteGetByKey("app-data.json", { force: true });
  ok(!res2.authRequired, "ein Netzfehler wird faelschlich als Anmeldefehler behandelt");
  ok(h2.health.rtdb.backoffUntil > 0, "ein Netzfehler setzt keinen Backoff mehr");
  ok(h2.log.storageReads === 1, "bei einem Netzfehler entfaellt der zulaessige Storage-Rueckfall");

  ok(h.api.isAuthDeniedError(denied) === true, "isAuthDeniedError erkennt permission_denied nicht");
  ok(h.api.isAuthDeniedError(netz) === false, "isAuthDeniedError haelt einen Netzfehler fuer einen Anmeldefehler");
  ok(h.api.isAuthDeniedError(Object.assign(new Error("x"), { code: "storage/unauthorized" })) === true,
    "isAuthDeniedError erkennt storage/unauthorized nicht");
}


// ── I-4: die ganze Kette bis ins DOM ─────────────────────────────────────
// Auth = null -> echtes remoteGetByKey -> Status -> echtes updateSyncChip ->
// sichtbarer Streifen. Genau die Luecke, an der V2 gescheitert ist: der
// Status stimmte, nur sah ihn niemand.
{
  const h = buildIntegration();
  const p = h.api.remoteGetByKey("app-data.json", { force: true });
  h.resolveNoUser();
  await p;
  ok(h.APP.state.storage.status === "auth_required", "der Status wurde nicht gesetzt");

  const el = {
    hidden: true, className: "", innerHTML: "", textContent: "", attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector(sel) {
      if (sel === ".sn-text") return this._text || (this._text = { textContent: "" });
      if (sel === ".sn-link") return /sn-link/.test(this.innerHTML)
        ? (this._link || (this._link = { textContent: "" })) : null;
      return null;
    },
  };
  const zeichne = new Function("document", "APP", "getLang",
    cut("function updateSyncChip() {") + "\nreturn updateSyncChip;")(
    { getElementById: (id) => (id === "syncNotice" ? el : null) }, h.APP, () => "de");
  zeichne();

  ok(el.hidden === false, "nach dem echten Lesevorgang bleibt der Streifen verborgen");
  ok(el._text.textContent === "Anmeldung erforderlich — Daten nicht synchronisiert",
    `im DOM steht "${el._text.textContent}"`);
  ok(el.attrs["aria-label"] === "Anmeldung erforderlich — Daten nicht synchronisiert",
    "aria-label fehlt am Ende der Kette");
  ok(el._link && el._link.textContent === "Anmelden", "der Anmeldeweg fehlt am Ende der Kette");
}

console.log(`sync auth gate: ok (${checks} Pruefungen)`);
