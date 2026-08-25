/*
 * F-25 Gegenbeweis: kanonische Schreibpfade OHNE unmittelbar vorherigen Merge.
 *
 * Commit 3 hat die Grabstein-Union in mergeData verankert. Das nuetzt nichts,
 * solange ein Schreibpfad den Merge ueberspringen kann — dann ersetzt ein
 * veralteter Voll-Stand den Serverstand samt der Grabsteine darin, und die
 * geloeschte Entitaet kommt beim naechsten Abgleich zurueck.
 *
 * Drei Teilfaelle:
 *   1  Haupt-RTDB-Transaktion: gleiche Geraete-Id, zweiter (veralteter) Tab
 *   2  Netlify 412: Force-Wiederholung ohne If-Match mit unveraendertem Koerper
 *   3  Shadow-Write: spiegelt einen Stand, den keine Transaktion committet hat
 *
 * Faellt einer durch, meldet der Lauf "F-25 GAP REPRODUCED" mit der Liste.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

function funktion(name, praefix = "function ") {
  const kopf = "\n" + (praefix === "function " ? "" : praefix.trimStart() && "") + praefix + name + "(";
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde in public/index.html nicht gefunden`);
  const ende = praefix.trim().startsWith("async") || praefix === "function " ? "\n}\n" : "\n}\n";
  return index.slice(a, index.indexOf(ende, a) + ende.length);
}
const funktionAsync = (name) => funktion(name, "async function ");
// Quelltextregeln pruefen CODE, nicht Prosa: ein Kommentar, der die entfernte
// Zeile zitiert, darf die Regel nicht ausloesen.
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

// ── RTDB-Attrappe: ein Knoten, transaction() wie bei Firebase ────────────
function rtdb(startWrapper) {
  const zustand = { knoten: startWrapper || null, schreibvorgaenge: 0 };
  return {
    zustand,
    ref: () => ({
      transaction(updater, cb) {
        const neu = updater(zustand.knoten);
        if (neu === undefined) { setTimeout(() => cb(null, false, null), 0); return; }
        zustand.knoten = neu;
        zustand.schreibvorgaenge++;
        setTimeout(() => cb(null, true, { val: () => zustand.knoten }), 0);
      },
      set(w) { zustand.knoten = w; zustand.schreibvorgaenge++; return Promise.resolve(); },
    }),
  };
}

// echtes mergeData samt Grabstein-Union
function echterMerge(ls) {
  const a = index.indexOf("function mergeData(local, remote) {");
  const b = index.indexOf("\nfunction ", a + 10);
  const tr = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const namen = ["unionDeleteLogs", "getDeleteLog", "mergeAndPersistDeleteLog", "flattenDeleteLog",
    "entityTimestamp", "mergeEntity"].filter((n) => index.indexOf("\nfunction " + n + "(") > 0);
  return new Function(
    "idbBackup", "localStorage", "normalizeData", "console", "JSON", "Date", "Number", "Object",
    index.slice(tr, index.indexOf("]);", tr) + 3) + "\n" +
    namen.map((n) => funktion(n)).join("\n") + "\n" +
    index.slice(a, b) + "\nreturn mergeData;")(
    () => {}, ls, (d) => d, { log() {}, warn() {} }, JSON, Date, Number, Object);
}

function speicher(start) {
  const m = new Map(Object.entries(start || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => m.delete(k) };
}

const JETZT = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const stand = (notizen, meta) => ({
  entities: { notes: notizen }, meta: { updatedAt: iso(JETZT), lastSavedBy: "dev-A", ...meta },
});

// ── Teilfall 1: gleiche Geraete-Id, veralteter zweiter Tab ───────────────
// Tab A loescht die Notiz (Grabstein) und schreibt. Tab B desselben Rechners
// haelt noch den Stand VON VORHER, hat die Notiz also noch, und speichert.
// Beide tragen dieselbe lastSavedBy — der alte Torwaechter sah kein fremdes
// Geraet, und der Zeitstempel von B ist der SPAETERE (B speichert ja gerade).
{
  const ls = speicher();
  const mergeData = echterMerge(ls);
  const db = rtdb();

  // Serverstand nach dem Loeschen durch Tab A
  const nachA = {
    entities: { notes: {} }, meta: { updatedAt: iso(JETZT - 1000), lastSavedBy: "dev-A" },
    _deleteLog: { note: { "n-weg": JETZT - 1000 } },
  };
  db.zustand.knoten = { data: JSON.stringify(nachA), updatedAt: nachA.meta.updatedAt, savedAt: JETZT - 1000, savedBy: "dev-A" };

  // Tab B: gleiches Geraet, kennt den Grabstein nicht, hat die Notiz noch
  const vonB = stand({ "n-weg": { id: "n-weg", title: "Sollte tot sein", updatedAt: iso(JETZT - 5000) } },
    { updatedAt: iso(JETZT), lastSavedBy: "dev-A" });

  const put = new Function(
    "APP", "shouldTryCloudProvider", "coreAuthReady", "rememberCoreAuthRequired", "rememberCloudFailure",
    "rememberCloudSuccess", "getOrCreateDeviceId", "getDataTimestamp", "rtdbDbRef", "rtdbNodeKey",
    "RTDB_NODE", "RTDB_DB_URL", "fetchWithTimeout", "coreWriteGuard", "canonicalWrite",
    "console", "JSON", "Date", "Promise", "Error",
    funktionAsync("rtdbJsonPut") + "\nreturn rtdbJsonPut;")(
    { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } },
    () => true, async () => ({ user: { uid: "u" } }), () => {}, () => {}, () => {},
    () => "dev-A", (d) => Date.parse(d?.meta?.updatedAt) || 0, db.ref, (k) => k.replace(/\./g, "_"),
    "appStore", "https://x", async () => ({ ok: false, status: 500 }),
    () => null,   // Waechter: hier wird der Trichter-Weg selbst geprueft
    async () => { throw new Error("canonicalWrite darf hier nicht greifen"); },
    { log() {}, warn() {}, error() {} }, JSON, Date, Promise, Error);

  const res = await put("app-data.json", vonB, { mergeFn: mergeData, _viaCanonicalWrite: true });
  const geschrieben = JSON.parse(db.zustand.knoten.data);

  ok(res.ok === true, "Teilfall 1: der Schreibvorgang schlug fehl");
  ok(res.merged === true,
    "Teilfall 1: der Merge wurde UEBERSPRUNGEN — gleiche Geraete-Id und spaeterer " +
    "Zeitstempel liessen den veralteten Tab den Serverstand ersetzen");
  ok(geschrieben._deleteLog?.note?.["n-weg"] === JETZT - 1000,
    `Teilfall 1: der Grabstein wurde vom Voll-Push ueberschrieben: ${JSON.stringify(geschrieben._deleteLog)}`);
  ok(!Object.prototype.hasOwnProperty.call(geschrieben.entities.notes, "n-weg"),
    "Teilfall 1: die geloeschte Notiz wurde durch den veralteten Tab wiederbelebt");
}

// ── Teilfall 2: Netlify 412 ─────────────────────────────────────────────
// 412 heisst: seit unserem ETag hat jemand anders geschrieben. Frueher lief
// dann eine Wiederholung OHNE If-Match mit UNVERAENDERTEM Koerper — der fremde
// Stand samt seiner Grabsteine wurde weggeworfen.
{
  const ls = speicher();
  const mergeData = echterMerge(ls);

  // Der fremde Stand auf dem Server: Notiz geloescht, Grabstein gesetzt
  const fremd = {
    entities: { notes: {} }, meta: { updatedAt: iso(JETZT - 1000), lastSavedBy: "dev-B" },
    _deleteLog: { note: { "n-weg": JETZT - 1000 } },
  };
  // Unser Stand: kennt den Grabstein nicht, hat die Notiz noch
  const unser = stand({ "n-weg": { id: "n-weg", title: "Sollte tot sein", updatedAt: iso(JETZT - 5000) } });

  const log = { puts: [], gets: 0 };
  let serverEtag = "etag-neu";
  const APP = { state: { settings: { storage: { blobKey: "app-data.json", putUrl: "https://x/{key}", getUrl: "https://x/{key}" } }, storage: { etag: "etag-alt" } } };

  const src = funktionAsync("netlifyBlobPut") + "\n" + funktionAsync("netlifyBlobGet");
  const put = new Function(
    "APP", "shouldTryCloudProvider", "buildStorageAuthHeaders", "rememberCloudFailure",
    "rememberCloudSuccess", "getDataTimestamp", "_remoteEtags", "fetchWithTimeout",
    "coreWriteGuard", "canonicalWrite", "isCoreDataKey", "console", "JSON", "Date", "encodeURIComponent",
    src + "\nreturn netlifyBlobPut;")(
    APP, () => true, () => ({}), () => {}, () => {},
    (d) => Date.parse(d?.meta?.updatedAt) || 0, {},
    async (url, opt) => {
      if (opt.method === "PUT") {
        log.puts.push({ ifMatch: opt.headers["If-Match"] || null, body: JSON.parse(opt.body) });
        // Konflikt nur, solange der ALTE ETag mitgeschickt wird
        if (opt.headers["If-Match"] !== serverEtag) {
          return { ok: false, status: 412, headers: { get: () => null } };
        }
        return { ok: true, status: 200, headers: { get: (h) => (h === "ETag" ? "etag-danach" : null) } };
      }
      log.gets++;
      return { ok: true, status: 200, headers: { get: (h) => (h === "ETag" ? serverEtag : null) },
        json: async () => fremd };
    },
    () => null,
    async () => { throw new Error("canonicalWrite darf hier nicht greifen"); },
    (k) => k === "app-data.json",
    { log() {}, warn() {}, error() {} }, JSON, Date, encodeURIComponent);

  const res = await put("app-data.json", unser, { mergeFn: mergeData, _viaCanonicalWrite: true });

  ok(res.ok === true, `Teilfall 2: der Schreibvorgang endete nicht erfolgreich (${res.reason || res.status})`);
  ok(log.gets === 1, `Teilfall 2: der Serverstand wurde nicht gelesen (${log.gets} Lesevorgaenge)`);
  ok(log.puts.length === 2, `Teilfall 2: ${log.puts.length} Schreibversuche statt zwei`);
  const zweiter = log.puts[1] || { ifMatch: null, body: {} };
  ok(res.casProof && res.casProof.kind === "netlify-etag" && res.casProof.etag === "etag-danach",
    `Teilfall 2: der Erfolg traegt keinen CAS-Beweis: ${JSON.stringify(res.casProof)}`);
  ok(zweiter.ifMatch === serverEtag,
    `Teilfall 2: die Wiederholung lief mit If-Match "${zweiter.ifMatch}" statt mit dem frischen ETag — ` +
    "eine Wiederholung ohne If-Match ersetzt den fremden Stand blind");
  ok(zweiter.body._deleteLog?.note?.["n-weg"] === JETZT - 1000,
    `Teilfall 2: der Koerper der Wiederholung trug den fremden Grabstein nicht: ${JSON.stringify(zweiter.body._deleteLog)}`);
  ok(!Object.prototype.hasOwnProperty.call(zweiter.body.entities?.notes || {}, "n-weg"),
    "Teilfall 2: die Wiederholung hat die vom anderen Geraet geloeschte Notiz wiederbelebt");
  const putSrc = ohneKommentare(funktionAsync("netlifyBlobPut"));
  ok(!/retrying without If-Match/.test(putSrc) && !/APP\.state\.storage\.etag = null;\s*\n\s*else delete _remoteEtags/.test(putSrc),
    "Teilfall 2: der Force-Zweig ohne If-Match steht noch im Quelltext");
  ok(!/options\.force && options\._retry412/.test(putSrc),
    "Teilfall 2: der ETag wird bei der Wiederholung weiterhin unterdrueckt");
  ok(/etag_conflict_persists/.test(putSrc),
    "Teilfall 2: nach der Merge-Wiederholung fehlt das sichtbare Aufgeben");
}

// ── Teilfall 3: Shadow-Write ────────────────────────────────────────────
// Der Schatten wird zurueckgelesen (remoteGetByKey als zweiter Anbieter,
// fetchRemoteCandidates ohnehin). Spiegelt er einen Stand, den keine
// Transaktion committet hat, kommt dieser Stand spaeter als Wahrheit zurueck.
{
  const geschattet = [];
  const bauen = (res) => new Function(
    "coreKeyAuthGate", "hasAnyCloudProviderAvailable", "getCloudProviderOrder", "shouldTryCloudProvider",
    "rtdbJsonPut", "firebaseJsonPut", "netlifyBlobPut", "isAutoSyncEnabled", "isCoreDataKey",
    "coreWriteGuard", "canonicalWrite", "_lastShadowWriteAt", "console", "Date", "Promise",
    funktionAsync("remotePutByKey") + "\nreturn remotePutByKey;")(
    async () => null, () => true, () => ["rtdb", "firebase"], () => true,
    async () => res, async (k, d) => { geschattet.push(d); return { ok: true }; },
    async () => ({ ok: false }), () => true, () => true,
    () => null, async () => { throw new Error("canonicalWrite darf hier nicht greifen"); }, 0,
    { log() {}, warn() {}, info() {}, error() {} }, Date, Promise);

  const lokal = stand({ "n-weg": { id: "n-weg", title: "nicht committet" } });
  const committet = stand({});

  // a) kanonische Transaktion hat committet -> Schatten spiegelt GENAU DAS
  geschattet.length = 0;
  await bauen({ ok: true, provider: "rtdb", data: committet, casProof: { kind: "rtdb-transaction" } })(
    "app-data.json", lokal, { shadowToOthers: true, _viaCanonicalWrite: true });
  await new Promise((r) => setTimeout(r, 5));
  ok(geschattet.length === 1, `Teilfall 3a: ${geschattet.length} Schattenschreibvorgaenge statt einem`);
  ok(geschattet[0] === committet,
    "Teilfall 3a: der Schatten spiegelt nicht exakt den committeten Stand");

  // b) Erfolg OHNE Kennzeichnung -> gar kein Schatten
  geschattet.length = 0;
  await bauen({ ok: true, provider: "rtdb", data: committet, committedByTransaction: true })(
    "app-data.json", lokal, { shadowToOthers: true, _viaCanonicalWrite: true });
  await new Promise((r) => setTimeout(r, 5));
  ok(geschattet.length === 0,
    "Teilfall 3b: ohne CAS-Beweis wurde trotzdem geschattet (committedByTransaction allein genuegt nicht)");

  // c) Erfolg ohne res.data -> kein Rueckfall auf den ungepruefen lokalen Stand
  geschattet.length = 0;
  await bauen({ ok: true, provider: "rtdb", casProof: { kind: "rtdb-transaction" } })(
    "app-data.json", lokal, { shadowToOthers: true, _viaCanonicalWrite: true });
  await new Promise((r) => setTimeout(r, 5));
  ok(geschattet.length === 0,
    "Teilfall 3c: ohne res.data wurde der ungeprueffte lokale Stand geschattet — " +
    "genau der Rueckfall res.data || data");

  const putSrc = ohneKommentare(funktionAsync("remotePutByKey"));
  ok(!/res\.data \|\| data/.test(putSrc),
    "Teilfall 3: der Rueckfall res.data || data steht noch im Quelltext");
  ok(/casProof && res\.casProof\.kind === 'rtdb-transaction'/.test(putSrc),
    "Teilfall 3: der Schatten haengt nicht am CAS-Beweis der kanonischen Transaktion");
  ok(/if \(other === 'rtdb'\) return;/.test(putSrc),
    "Teilfall 3: der Schatten darf weiterhin in den kanonischen Knoten schreiben");
}

if (luecken.length) {
  console.error("F-25 GAP REPRODUCED — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 stale push gap: ok (${checks} Pruefungen)`);
