/*
 * F-25 v4 — Waechter ueber den Trichter selbst.
 *
 * Kernprinzip: ein Schreibvorgang auf app-data gilt NUR als Erfolg, wenn ein
 * Compare-and-Swap-Beweis vorliegt. Alles andere ist ein Fehler, auch wenn ein
 * Backend HTTP 200 meldet. Firebase Storage ist ausschliesslich
 * Post-Commit-Schatten: nie primaer, nie Schreib-Rueckfall, nie Quelle.
 *
 * Die acht Befunde, die v3 offen liess:
 *   B1  ein res.ok OHNE CAS-Beweis galt als Erfolg (Storage-Upload)
 *   B2  die Lesepflicht war ein Optionsflag — ohne es lief ein Write ohne Read
 *   B3  res.data war der VORAB GEBAUTE Stand, nicht der committete
 *   B4  der Schnappschuss der RTDB-Transaktion wurde weggeworfen
 *   B5  Netlify: fehlender ETag in der Antwort galt als Erfolg
 *   B6  Netlify: UNVERAENDERTER ETag galt als Erfolg
 *   B7  'netlify' fehlte in der Anbieterreihenfolge — der ETag-Pfad war
 *       unerreichbar, obwohl repariert
 *   B8  'firebase' (Storage) war Kern-Anbieter fuer Lesen UND Schreiben, und
 *       primaryProvider=firebase war waehlbar und wurde gespeichert
 *
 * Faellt etwas durch, meldet der Lauf "F-25 FUNNEL GAP" mit der Liste.
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
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde in public/index.html nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
const funktionAsync = (name) => funktion(name, "async function ");
const konstante = (name) => {
  const i = index.indexOf("const " + name + " = [");
  assert.ok(i > 0, `${name} wurde nicht gefunden`);
  return index.slice(i, index.indexOf("];", i) + 2);
};

const JETZT = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const stand = (notizen, extra) => ({
  entities: { notes: notizen || {} },
  meta: { updatedAt: iso(JETZT), lastSavedBy: "dev-A" }, ...extra,
});

// ── Trichter mit echten Abhaengigkeiten ─────────────────────────────────
function trichter({ leseErgebnis = { ok: true, data: stand({}) }, putErgebnisse = [] } = {}) {
  const log = { lesen: 0, puts: [] };
  const APP = { state: { settings: { storage: { blobKey: "app-data.json" } }, storage: {} } };
  let i = 0;
  const fn = new Function(
    "APP", "remoteGetByKey", "remotePutByKey", "normalizeData", "mergeData",
    "primaryCloudProvider", "getOrCreateDeviceId", "console", "Date",
    "const CANONICAL_WRITE_MAX_ATTEMPTS = " +
      (index.match(/const CANONICAL_WRITE_MAX_ATTEMPTS = (\d+)/) || [, "2"])[1] + ";\n" +
      funktionAsync("canonicalWrite") + "\nreturn canonicalWrite;")(
    APP,
    async () => { log.lesen++; return leseErgebnis; },
    async (k, d, o) => { log.puts.push({ key: k, data: d, options: o }); return putErgebnisse[Math.min(i++, putErgebnisse.length - 1)]; },
    (d) => d,
    (lokal, fern) => ({ ...fern, ...lokal, gemergt: true }),
    () => "rtdb", () => "dev-A",
    { log() {}, warn() {}, error() {}, info() {} }, Date);
  return { fn, log, APP };
}

// ── B1/B3: nur mit Beweis, und res.data ist der committete Stand ────────
{
  const committet = stand({ ausDerDatenbank: { id: "x" } }, { istCommittet: true });
  const t = trichter({ putErgebnisse: [{ ok: true, provider: "rtdb", data: committet, casProof: { kind: "rtdb-transaction", committed: true, snapshot: { val: () => ({}) } } }] });
  const res = await t.fn(stand({}));
  ok(res.ok === true, `B1: ein Schreibvorgang MIT Beweis wurde abgelehnt (${res.reason})`);
  ok(res.data === committet,
    "B3: res.data ist nicht der committete Stand, sondern der vorab gebaute — was wir schicken wollten, ist nicht, was gespeichert wurde");
  ok(res.casProof.kind === "rtdb-transaction", "B1: der Beweis wird nicht durchgereicht");
}
{
  // Storage-Upload: ok, aber per Bauart ohne Compare-and-Swap
  const t = trichter({ putErgebnisse: [{ ok: true, provider: "firebase", data: stand({}) }] });
  const res = await t.fn(stand({}));
  ok(res.ok === false && res.reason === "no_cas_proof",
    `B1: ein Erfolg OHNE CAS-Beweis wurde als Erfolg gewertet (${res.ok}/${res.reason}) — HTTP 200 ist kein Beweis`);
  ok(res.provider === "firebase", "B1: der Fehler nennt den Anbieter nicht");
}
{
  const t = trichter({ putErgebnisse: [{ ok: true, provider: "rtdb", data: stand({}), casProof: { kind: "irgendwas" } }] });
  const res = await t.fn(stand({}));
  ok(res.ok === false && res.reason === "no_cas_proof", "B1: ein unbekannter Beweistyp wird akzeptiert");
}
// ── B9 (v5): der Beweis muss an den GELESENEN Zustand gebunden sein ─────
// Ein Response-ETag ohne Request-If-Match beweist nur, DASS geschrieben wurde,
// nicht dass BEDINGT geschrieben wurde.
for (const [beweis, was] of [
  [{ kind: "netlify-etag", before: "gleich", after: "gleich" }, "before == after"],
  [{ kind: "netlify-etag", before: "", after: "neu" }, "leeres before"],
  [{ kind: "netlify-etag", before: null, after: "neu" }, "fehlendes before — genau die v4-Luecke"],
  [{ kind: "netlify-etag", before: "alt", after: "" }, "leeres after"],
  [{ kind: "netlify-etag", before: "alt" }, "fehlendes after"],
  [{ kind: "rtdb-transaction" }, "Transaktion ohne committed/snapshot"],
  [{ kind: "rtdb-transaction", committed: true }, "Transaktion ohne snapshot"],
]) {
  const t = trichter({ putErgebnisse: [{ ok: true, provider: "netlify", data: stand({}), casProof: beweis }] });
  const res = await t.fn(stand({}));
  ok(res.ok === false && res.reason === "no_cas_proof",
    `B9: ein Beweis mit ${was} wurde akzeptiert — er ist nicht an den gelesenen Zustand gebunden`);
}
{
  const t = trichter({ putErgebnisse: [{ ok: true, provider: "netlify", data: stand({}), casProof: { kind: "netlify-etag", before: "alt", after: "neu" } }] });
  ok((await t.fn(stand({}))).ok === true, "B9: ein vollstaendig gebundener Beweis wird abgelehnt");
}

// ── B2: Lesepflicht ohne Hintertuer ────────────────────────────────────
{
  const t = trichter({ leseErgebnis: { ok: false } });
  const res = await t.fn(stand({}));
  ok(res.ok === false && res.reason === "remote_read_failed",
    `B2: ohne lesbaren Serverstand kam "${res.reason}"`);
  ok(t.log.puts.length === 0, "B2: ohne Lesevorgang wurde geschrieben");
}
{
  // auch ein erfolgreicher Lesevorgang OHNE Daten zaehlt nicht
  const t = trichter({ leseErgebnis: { ok: true, data: null } });
  const res = await t.fn(stand({}));
  ok(res.ok === false && res.reason === "remote_read_failed", "B2: ein leerer Lesevorgang gilt als gelesen");
  ok(t.log.puts.length === 0, "B2: nach leerem Lesevorgang wurde geschrieben");
}
{
  const quelle = ohneKommentare(funktionAsync("canonicalWrite"));
  ok(!/requireRemoteRead/.test(quelle),
    "B2: die Lesepflicht haengt weiterhin an einem Optionsflag — jedes Flag ist eine Hintertuer");
  ok(!/options\.force/.test(quelle), "B2: der Trichter wertet weiterhin force aus");
}
function ohneKommentare(src) { return src.replace(/^\s*\/\/.*$/gm, ""); }

// ── B4: der Schnappschuss der Transaktion ist der Beweis ───────────────
{
  const src = ohneKommentare(funktionAsync("rtdbJsonPut"));
  ok(/\(error, committed, snapshot\)/.test(src),
    "B4: der Schnappschuss der Transaktion wird weiterhin weggeworfen");
  ok(/no_cas_snapshot/.test(src),
    "B4: ein Commit ohne verwertbaren Schnappschuss gilt weiterhin als Erfolg");
  ok(/kind: 'rtdb-transaction'/.test(src), "B4: der Beweis wird nicht ausgestellt");
  ok(/payload = committetStand;/.test(src),
    "B4: zurueckgegeben wird nicht der committete Stand aus dem Schnappschuss");
}

// ── B5/B6: der Netlify-ETag als Beweis ─────────────────────────────────
function netlify({ etagVorher = "alt", antwortEtag = "neu" } = {}) {
  const log = { puts: [] };
  const APP = { state: { settings: { storage: { blobKey: "app-data.json", putUrl: "https://x/{key}", getUrl: "https://x/{key}" } }, storage: { etag: etagVorher } } };
  const fn = new Function(
    "APP", "shouldTryCloudProvider", "buildStorageAuthHeaders", "rememberCloudFailure",
    "rememberCloudSuccess", "getDataTimestamp", "_remoteEtags", "fetchWithTimeout",
    "coreWriteGuard", "canonicalWrite", "isCoreDataKey", "console", "JSON", "Date", "encodeURIComponent",
    funktionAsync("netlifyBlobPut") + "\n" + funktionAsync("netlifyBlobGet") + "\nreturn netlifyBlobPut;")(
    APP, () => true, () => ({}), () => {}, () => {},
    (d) => Date.parse(d?.meta?.updatedAt) || 0, {},
    async (url, opt) => {
      log.puts.push({ ifMatch: opt.headers["If-Match"] || null });
      return { ok: true, status: 200, headers: { get: (h) => (h === "ETag" ? antwortEtag : null) } };
    },
    () => null, async () => { throw new Error("nicht hier"); }, (k) => k === "app-data.json",
    { log() {}, warn() {}, error() {} }, JSON, Date, encodeURIComponent);
  return { fn, log, APP };
}
{
  const n = netlify({ antwortEtag: null });
  const res = await n.fn("app-data.json", stand({}), { mergeFn: (a) => a, _viaCanonicalWrite: true });
  ok(res.ok === false && res.reason === "no_cas_proof_missing_etag",
    `B5: HTTP 200 ohne ETag gilt als Erfolg (${res.ok}/${res.reason}) — ohne ETag wissen wir nicht, ob unser Stand ankam`);
}
{
  const n = netlify({ etagVorher: "gleich", antwortEtag: "gleich" });
  const res = await n.fn("app-data.json", stand({}), { mergeFn: (a) => a, _viaCanonicalWrite: true });
  ok(res.ok === false && res.reason === "no_cas_proof_unchanged_etag",
    `B6: ein UNVERAENDERTER ETag gilt als Erfolg (${res.ok}/${res.reason}) — der Server hat keine neue Version bestaetigt`);
}
{
  const n = netlify({ etagVorher: "alt", antwortEtag: "neu" });
  const res = await n.fn("app-data.json", stand({}), { mergeFn: (a) => a, _viaCanonicalWrite: true });
  ok(res.ok === true && res.casProof?.kind === "netlify-etag"
      && res.casProof.before === "alt" && res.casProof.after === "neu",
    `B5/B6: der Beweis bindet nicht Vorher an Nachher: ${JSON.stringify(res.casProof)}`);
  ok(n.log.puts[0].ifMatch === "alt", "B5/B6: der Schreibvorgang lief ohne If-Match");
}
{
  // Nebenschluessel bleiben unberuehrt: dort gibt es keine CAS-Pflicht
  const n = netlify({ antwortEtag: null });
  const res = await n.fn("recalllab-mobile.json", { a: 1 }, {});
  ok(res.ok === true, "B5: ein Nebenschluessel wird faelschlich der CAS-Pflicht unterworfen");
}

// ── B7/B8: die Anbieterreihenfolge ─────────────────────────────────────
{
  const order = new Function("isCoreDataKey", "_cloudHealth",
    konstante("CORE_PROVIDER_ORDER") + "\n" + funktion("getCloudProviderOrder") + "\nreturn getCloudProviderOrder;")(
    (k) => k === "app-data.json", { lastGoodProvider: "firebase" });

  const kern = order(undefined, "app-data.json");
  ok(kern.includes("netlify"),
    "B7: 'netlify' fehlt in der Kern-Reihenfolge — der reparierte ETag-Pfad bleibt unerreichbar");
  ok(!kern.includes("firebase"),
    `B8: Firebase Storage steht weiterhin in der Kern-Reihenfolge: ${kern.join(", ")}`);
  ok(kern[0] === "rtdb", `B7: die Kern-Reihenfolge beginnt mit "${kern[0]}" statt rtdb`);
  ok(JSON.stringify(kern) === JSON.stringify(["rtdb", "netlify"]),
    `B7/B8: die Kern-Reihenfolge lautet ${JSON.stringify(kern)} statt ["rtdb","netlify"]`);
  // auch ein gespeicherter Wunsch nach firebase aendert daran nichts
  ok(!order("firebase", "app-data.json").includes("firebase"),
    "B8: ein bevorzugter Anbieter 'firebase' kommt fuer den Kern doch in die Reihenfolge");
  // Nebenschluessel unveraendert
  ok(order(undefined, "recalllab-mobile.json").includes("firebase"),
    "B8: Nebenschluessel haben ihren Storage-Weg verloren");
}
{
  const migrate = new Function("console", funktion("migratePrimaryProvider") + "\nreturn migratePrimaryProvider;")(
    { warn() {} });
  const s1 = migrate({ storage: { primaryProvider: "firebase" } });
  ok(s1.storage.primaryProvider === "rtdb",
    "B8: ein GESPEICHERTER Altwert firebase bleibt stehen und macht Storage wieder primaer");
  ok(migrate({ storage: { primaryProvider: "rtdb" } }).storage.primaryProvider === "rtdb",
    "B8: die Migration veraendert einen gueltigen Wert");
  ok(migrate(undefined) === undefined, "B8: die Migration wirft bei fehlenden Einstellungen");

  const geladen = ohneKommentare(funktion("loadSettings"));
  ok((geladen.match(/migratePrimaryProvider\(/g) || []).length >= 3,
    "B8: loadSettings hebt den Altwert nicht auf allen Rueckgabewegen (inklusive catch)");

  const prim = ohneKommentare(funktion("primaryCloudProvider"));
  ok(!/if \(p === 'firebase'\) return p;/.test(prim),
    "B8: primaryCloudProvider gibt weiterhin 'firebase' zurueck");
}
{
  const put = ohneKommentare(funktionAsync("remotePutByKey"));
  ok(/provider === 'firebase' && isCoreDataKey\(key\)/.test(put) && /storage_not_cas_capable/.test(put),
    "B8: remotePutByKey kann den Kernschluessel weiterhin nach Firebase Storage schreiben");
  ok(/getCloudProviderOrder\(options\.preferProvider, key\)/.test(put),
    "B7: remotePutByKey fragt die Reihenfolge ohne den Schluessel ab");
  const get = ohneKommentare(funktionAsync("remoteGetByKey"));
  ok(/getCloudProviderOrder\(options\.preferProvider, key\)/.test(get),
    "B8: remoteGetByKey liest weiterhin ueber die alte Reihenfolge — Storage bliebe Lesequelle");
}
{
  const schalter = ohneKommentare(index.slice(index.indexOf("window.fbStoreSetPrimary = function(cb)"),
    index.indexOf("window.fbStoreSetPrimary = function(cb)") + 1200));
  ok(!/primaryProvider = on \? "rtdb" : "firebase"/.test(schalter),
    "B8: der Schalter setzt weiterhin Firebase Storage als primaer");
  ok(/cb\.disabled = true/.test(schalter), "B8: der Schalter ist nicht ausgegraut");
  ok(/Backup-Schatten/.test(index.slice(index.indexOf("window.fbStoreSetPrimary"), index.indexOf("window.fbStoreSetPrimary") + 1500)),
    "B8: der Schalter erklaert nicht, dass Storage nur Backup-Schatten ist");
}

// ── Ausdrueckliche Lagen aus dem Auftrag ───────────────────────────────
// (1) gespeicherter primaryProvider=firebase + veralteter Client + fremder
//     Grabstein: kein Write ohne Read, kein Storage-Write vor dem Commit,
//     der Grabstein ueberlebt.
{
  const fremderGrabstein = { note: { "n-weg": JETZT - 1000 } };
  const fern = stand({}, { _deleteLog: fremderGrabstein });
  const veraltet = stand({ "n-weg": { id: "n-weg", title: "sollte tot sein" } });
  const committet = stand({}, { _deleteLog: fremderGrabstein });
  const t = trichter({
    leseErgebnis: { ok: true, data: fern },
    putErgebnisse: [{ ok: true, provider: "rtdb", data: committet, casProof: { kind: "rtdb-transaction", committed: true, snapshot: { val: () => ({}) } } }],
  });
  const res = await t.fn(veraltet);
  ok(t.log.lesen === 1, "Lage 1: es wurde nicht vor dem Schreiben gelesen");
  ok(t.log.puts[0].options._viaCanonicalWrite === true, "Lage 1: der Schreibvorgang lief am Trichter vorbei");
  ok(res.ok === true && res.data._deleteLog?.note?.["n-weg"] === JETZT - 1000,
    "Lage 1: der fremde Grabstein hat den Schreibvorgang des veralteten Clients nicht ueberlebt");
  // Der Schatten haengt am Beweis — vor dem Commit gibt es keinen Storage-Write.
  const rp = ohneKommentare(funktionAsync("remotePutByKey"));
  ok(/const kanonisch = !!\(res\.casProof && res\.casProof\.kind === 'rtdb-transaction' && res\.data\);/.test(rp),
    "Lage 1: der Storage-Schatten haengt nicht am CAS-Beweis — er koennte vor dem Commit schreiben");
  ok(rp.indexOf("const kanonisch") < rp.indexOf("shadowToOthers"),
    "Lage 1: der Beweis wird erst nach der Schatten-Entscheidung geprueft");
}

// (2) RTDB nicht verfuegbar -> Netlify-CAS uebernimmt, sonst sichtbarer Fehler;
//     nie ein Storage-Direktwrite.
{
  const committet = stand({}, { ueberNetlify: true });
  const t = trichter({ putErgebnisse: [{ ok: true, provider: "netlify", data: committet, casProof: { kind: "netlify-etag", before: "alt", after: "neu" } }] });
  const res = await t.fn(stand({}));
  ok(res.ok === true && res.provider === "netlify" && res.data === committet,
    "Lage 2: der Netlify-CAS-Weg wird nicht als vollwertiger Erfolg akzeptiert");
}
{
  const t = trichter({ putErgebnisse: [{ ok: false, reason: "storage_not_cas_capable", provider: "firebase" }] });
  const res = await t.fn(stand({}));
  ok(res.ok === false, "Lage 2: ein abgewiesener Storage-Schreibvorgang gilt als Erfolg");
  ok(t.log.puts.length === 1, "Lage 2: ein echter Fehler wurde wiederholt statt gemeldet");
}

if (luecken.length) {
  console.error("F-25 FUNNEL GAP — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 canonical funnel gaps: ok (${checks} Pruefungen)`);
