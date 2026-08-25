/*
 * F-25 v5 — der initiale ETag.
 *
 * Befund (v4): der Netlify-CAS-Beweis prueft nur den ANTWORT-ETag. Lag lokal
 * kein ETag vor, ging das PUT OHNE If-Match hinaus — also unbedingt — und der
 * Antwort-ETag stufte es danach zum CAS-Beweis hoch. Ein Response-ETag ohne
 * Request-If-Match beweist nur, DASS geschrieben wurde, nicht dass BEDINGT
 * geschrieben wurde.
 *
 * Ausgeloest wurde das durch einen Lesevorgang, der Daten lieferte, aber keinen
 * ETag (Proxy entfernt ihn, Fassade setzt ihn nicht). Der Client hielt den
 * Lesevorgang fuer erfolgreich, merkte sich etag=null und schrieb unbedingt.
 *
 * Diese Datei spielt die SEQUENZ nach — mit den echten Funktionen und, fuer den
 * Server-Riegel, mit dem echten Handler aus netlify/functions/blob-put.mjs.
 * Faellt etwas durch, meldet der Lauf "F-25 INITIAL ETAG GAP".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const blobPut = fs.readFileSync(path.join(root, "netlify/functions/blob-put.mjs"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

function funktionAsync(name) {
  const a = index.indexOf("\nasync function " + name + "(");
  assert.ok(a > 0, `${name} wurde in public/index.html nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

// ── Netlify-Client mit protokollierendem Netz ───────────────────────────
function client({ getEtag = "etag-1", getStatus = 200, putEtag = "etag-2", startEtag = null } = {}) {
  const log = { gets: 0, puts: [] };
  const APP = { state: {
    settings: { storage: { blobKey: "app-data.json", getUrl: "https://x/{key}", putUrl: "https://x/{key}" } },
    storage: { etag: startEtag },
  } };
  const api = new Function(
    "APP", "shouldTryCloudProvider", "buildStorageAuthHeaders", "rememberCloudFailure",
    "rememberCloudSuccess", "getDataTimestamp", "_remoteEtags", "fetchWithTimeout",
    "coreWriteGuard", "canonicalWrite", "isCoreDataKey", "console", "JSON", "Date", "encodeURIComponent",
    funktionAsync("netlifyBlobPut") + "\n" + funktionAsync("netlifyBlobGet") +
    "\nreturn { netlifyBlobPut, netlifyBlobGet };")(
    APP, () => true, () => ({}), () => {}, () => {},
    (d) => Date.parse(d?.meta?.updatedAt) || 0, {},
    async (url, opt) => {
      if (opt && opt.method === "PUT") {
        log.puts.push({ ifMatch: (opt.headers || {})["If-Match"] || null });
        return { ok: true, status: 200, headers: { get: (h) => (h === "ETag" ? putEtag : null) } };
      }
      log.gets++;
      return {
        ok: getStatus === 200, status: getStatus,
        headers: { get: (h) => (h === "ETag" ? getEtag : null) },
        json: async () => ({ entities: {}, meta: { updatedAt: "2026-08-25T10:00:00.000Z" } }),
      };
    },
    () => null, async () => { throw new Error("canonicalWrite darf hier nicht greifen"); },
    (k) => k === "app-data.json",
    { log() {}, warn() {}, error() {} }, JSON, Date, encodeURIComponent);
  return { api, log, APP };
}

// ── 1. DIE SEQUENZ: GET mit Daten, ohne ETag ────────────────────────────
{
  const c = client({ getEtag: null });
  const gelesen = await c.api.netlifyBlobGet("app-data.json", { force: true });
  ok(gelesen.ok === false && gelesen.reason === "read_without_etag",
    `Sequenz 1: ein Lesevorgang OHNE ETag gilt als erfolgreich (${gelesen.ok}/${gelesen.reason}) — ` +
    "danach merkt sich der Client etag=null und schreibt unbedingt");
  ok(c.APP.state.storage.etag === null, "Sequenz 1: es wurde ein leerer ETag gemerkt");

  // und der darauf folgende Schreibvorgang darf gar nicht erst stattfinden
  const geschrieben = await c.api.netlifyBlobPut("app-data.json", { a: 1 }, { _viaCanonicalWrite: true });
  ok(geschrieben.ok === false && geschrieben.reason === "missing_if_match",
    `Sequenz 1: der Schreibvorgang lief trotz fehlendem ETag (${geschrieben.reason})`);
  ok(c.log.puts.length === 0,
    "Sequenz 1: es ging ein NETZWERKAUFRUF hinaus — der Riegel muss VOR dem Request greifen");
}

// ── 2. Das v4-Gap-Szenario selbst ───────────────────────────────────────
// Kein lokaler ETag, PUT geht raus, Antwort traegt einen ETag. In v4 wurde
// daraus ein CAS-Beweis. Jetzt: kein Request, kein Beweis.
{
  const c = client({ startEtag: null, putEtag: "frisch-vom-server" });
  const res = await c.api.netlifyBlobPut("app-data.json", { a: 1 }, { _viaCanonicalWrite: true });
  ok(res.ok === false,
    "v4-Gap: ein unbedingter Schreibvorgang wurde aus dem Antwort-ETag zum Erfolg hochgestuft");
  ok(!res.casProof, `v4-Gap: es wurde ein CAS-Beweis ausgestellt: ${JSON.stringify(res.casProof)}`);
  ok(c.log.puts.length === 0, "v4-Gap: der unbedingte PUT ging tatsaechlich hinaus");
}

// ── 3. Mit ETag laeuft alles, und der Beweis bindet Vorher an Nachher ───
{
  const c = client({ getEtag: "etag-A", putEtag: "etag-B" });
  const gelesen = await c.api.netlifyBlobGet("app-data.json", { force: true });
  ok(gelesen.ok === true && gelesen.etag === "etag-A", "Sequenz 3: der gute Lesevorgang schlaegt fehl");
  const res = await c.api.netlifyBlobPut("app-data.json", { a: 1 }, { _viaCanonicalWrite: true });
  ok(res.ok === true, `Sequenz 3: der bedingte Schreibvorgang schlaegt fehl (${res.reason})`);
  ok(c.log.puts[0].ifMatch === "etag-A", "Sequenz 3: der Schreibvorgang ging ohne If-Match hinaus");
  ok(res.casProof?.before === "etag-A" && res.casProof?.after === "etag-B",
    `Sequenz 3: der Beweis bindet nicht Vorher an Nachher: ${JSON.stringify(res.casProof)}`);
}

// ── 4. Nebenschluessel bleiben unberuehrt ───────────────────────────────
{
  const c = client({ getEtag: null, putEtag: null });
  const gelesen = await c.api.netlifyBlobGet("recalllab-mobile.json", { force: true });
  ok(gelesen.ok === true, "Nebenschluessel: ein Lesevorgang ohne ETag wird faelschlich abgelehnt");
  const res = await c.api.netlifyBlobPut("recalllab-mobile.json", { a: 1 }, {});
  ok(res.ok === true, "Nebenschluessel: ein Schreibvorgang ohne ETag wird faelschlich abgelehnt");
  ok(c.log.puts.length === 1, "Nebenschluessel: der Schreibvorgang fand nicht statt");
}

// ── 5. canonicalWrite verwirft einen ungebundenen Beweis ────────────────
{
  const log = { puts: [] };
  let ergebnis = null;
  const mach = (beweis) => new Function(
    "APP", "remoteGetByKey", "remotePutByKey", "normalizeData", "mergeData",
    "primaryCloudProvider", "getOrCreateDeviceId", "console", "Date",
    "const CANONICAL_WRITE_MAX_ATTEMPTS = 2;\n" + funktionAsync("canonicalWrite") + "\nreturn canonicalWrite;")(
    { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } },
    async () => ({ ok: true, data: { entities: {}, meta: {} } }),
    async (k, d, o) => { log.puts.push(o); return { ok: true, provider: "netlify", data: d, casProof: beweis }; },
    (d) => d, (a, b) => ({ ...b, ...a }), () => "netlify", () => "dev",
    { log() {}, warn() {}, error() {}, info() {} }, Date);

  for (const [beweis, was] of [
    [{ kind: "netlify-etag", before: "gleich", after: "gleich" }, "before == after"],
    [{ kind: "netlify-etag", before: "", after: "neu" }, "leeres before"],
    [{ kind: "netlify-etag", before: null, after: "neu" }, "fehlendes before (die v4-Luecke)"],
    [{ kind: "netlify-etag", before: "alt", after: "" }, "leeres after"],
    [{ kind: "netlify-etag", after: "neu" }, "before fehlt ganz"],
  ]) {
    ergebnis = await mach(beweis)({ entities: {}, meta: {} });
    ok(ergebnis.ok === false && ergebnis.reason === "no_cas_proof",
      `Beweis mit ${was} wurde akzeptiert — er ist nicht an den gelesenen Zustand gebunden`);
  }
  ergebnis = await mach({ kind: "netlify-etag", before: "alt", after: "neu" })({ entities: {}, meta: {} });
  ok(ergebnis.ok === true, "ein vollstaendig gebundener Beweis wird abgelehnt");
}

// ── 6. SERVERSEITIG: PUT ohne If-Match auf den Kernschluessel -> 428 ────
// Der echte Handler aus netlify/functions/blob-put.mjs, gegen Attrappen.
{
  const quelle = blobPut
    .replace(/^import .*$/m, "")
    .replace(/^export const config = .*$/m, "")
    .replace(/^export default /m, "const handler = ");
  // firebaseNodeKey seit F-25 v6: der Kern wird am KNOTEN erkannt, nicht an der
  // Zeichenkette. Die echte Funktion mitgeben, keine nachgebaute.
  const { firebaseNodeKey } = await import("../netlify/lib/firebase-admin.mjs");
  const handler = new Function("writeAppDataText", "firebaseNodeKey", "Netlify", "Response", "URL", "TextEncoder", "String",
    quelle + "\nreturn handler;")(
    async () => ({ ok: true, etag: "etag-neu" }), firebaseNodeKey,
    { env: { get: () => null } }, Response, URL, TextEncoder, String);

  const anfrage = (key, ifMatch) => ({
    method: "PUT",
    url: "https://x/.netlify/functions/blob-put?key=" + encodeURIComponent(key),
    headers: { get: (h) => (h === "If-Match" ? ifMatch : null) },
    text: async () => JSON.stringify({ entities: {} }),
  });

  const ohne = await handler(anfrage("app-data.json", null));
  ok(ohne.status === 428,
    `Server: ein PUT auf den Kerndatensatz OHNE If-Match kam mit ${ohne.status} durch statt mit 428 — ` +
    "damit koennte ein alter, zwischengespeicherter Client weiterhin unbedingt schreiben");
  const koerper = await ohne.json();
  ok(/Precondition/i.test(koerper.error || ""), "Server: der 428 nennt den Grund nicht");

  const mit = await handler(anfrage("app-data.json", "etag-1"));
  ok(mit.status === 200, `Server: ein PUT MIT If-Match wurde mit ${mit.status} abgewiesen`);
  ok(mit.headers.get("ETag") === "etag-neu", "Server: die Antwort traegt keinen neuen ETag");

  const neben = await handler(anfrage("recalllab-mobile.json", null));
  ok(neben.status === 200,
    `Server: ein Nebenschluessel ohne If-Match wurde mit ${neben.status} abgewiesen — ` +
    "Nebenschluessel haben kein Mehrgeraeteproblem");
}

// ── 7. Quelltextregeln ─────────────────────────────────────────────────
{
  const put = ohneKommentare(funktionAsync("netlifyBlobPut"));
  const get = ohneKommentare(funktionAsync("netlifyBlobGet"));
  ok(/isCoreDataKey\(key\) && !etag/.test(put) && /missing_if_match/.test(put),
    "der Riegel vor dem Netzwerkaufruf fehlt");
  ok(put.indexOf("missing_if_match") < put.indexOf("fetchWithTimeout"),
    "der Riegel steht NACH dem Netzwerkaufruf — dann ist der Request schon draussen");
  ok(/isCoreDataKey\(key\) && !etag/.test(get) && /read_without_etag/.test(get),
    "ein Lesevorgang ohne ETag gilt weiterhin als erfolgreich");
  ok(/before: etag, after: newEtag/.test(put), "der Beweis bindet Vorher nicht an Nachher");
  ok(/precondition_required/.test(put), "ein 428 vom Server wird nicht benannt");
  const server = ohneKommentare(blobPut);
  ok(/isCoreKey\(key\) && !ifMatch/.test(server) && /status: 428/.test(server),
    "der Server laesst einen unbedingten Core-PUT weiterhin durch");
}

if (luecken.length) {
  console.error("F-25 INITIAL ETAG GAP — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 initial etag gap: ok (${checks} Pruefungen)`);
