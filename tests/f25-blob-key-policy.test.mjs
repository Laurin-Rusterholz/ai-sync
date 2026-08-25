/*
 * F-25 M2 — die Schluesselpolitik der Blob-Fassade.
 *
 * blob-put nahm einen beliebigen key aus der URL entgegen und schrieb darunter
 * nach appStore/<sanitizedKey>. Jeder Aufrufer konnte damit einen beliebigen
 * Knoten anlegen. Seit K ist der KERN geriegelt (If-Match-Pflicht, 428); alles
 * uebrige stand offen.
 *
 * Jetzt gilt Default DENY: genau vier Nebenschluessel-Familien sind erlaubt,
 * alles andere 403. Die Attachment-Familie wird STRENG geprueft — vier
 * Segmente, Alphabet [A-Za-z0-9~-], jedes Segment kanonisch (derselbe Codec wie
 * im Client, F-25 M1a). Ein startsWith-Match waere kein Schutz.
 *
 * Geprueft werden BEIDE Schreibwege: der HTTP-Handler blob-put und die
 * Bibliotheksfunktion writeAppDataText. Sie muessen fuer jeden Schluessel
 * dasselbe sagen — sonst gaebe es einen Weg an der Politik vorbei.
 *
 * blob-get bleibt unangetastet: ein Altstand muss lesbar bleiben, auch wenn er
 * unter einem heute unzulaessigen Schluessel liegt.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyBlobKey, isCoreKey, firebaseNodeKey, attSegEncode, attSegDecode,
  BLOB_KEY_MAX_BYTES, RTDB_KEY_LIMIT_BYTES, blobKeyByteLength,
} from "../netlify/lib/blob-key-policy.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const blobPutSrc = fs.readFileSync(path.join(root, "netlify/functions/blob-put.mjs"), "utf8");
const adminSrc = fs.readFileSync(path.join(root, "netlify/lib/firebase-admin.mjs"), "utf8");
const indexSrc = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ── Der ECHTE HTTP-Handler gegen Attrappen ─────────────────────────────
function handler({ schreibenErgebnis = { ok: true, etag: "etag-neu" } } = {}) {
  const log = { writes: [] };
  const quelle = blobPutSrc
    .replace(/^import .*$/gm, "")
    .replace(/^export const config = .*$/m, "")
    .replace(/^export default /m, "const handler = ");
  const fn = new Function(
    "writeAppDataText", "classifyBlobKey", "BLOB_KEY_MAX_BYTES", "RTDB_KEY_LIMIT_BYTES",
    "Netlify", "Response", "URL", "TextEncoder", "String",
    quelle + "\nreturn handler;")(
    async (k, b, o) => { log.writes.push({ key: k, options: o }); return schreibenErgebnis; },
    classifyBlobKey, BLOB_KEY_MAX_BYTES, RTDB_KEY_LIMIT_BYTES,
    { env: { get: () => null } }, Response, URL, TextEncoder, String);
  return { fn, log };
}
const anfrage = (key, ifMatch = null, ifNoneMatch = null) => ({
  method: "PUT",
  url: "https://x/.netlify/functions/blob-put?key=" + encodeURIComponent(key),
  headers: { get: (h) => (h === "If-Match" ? ifMatch : h === "If-None-Match" ? ifNoneMatch : null) },
  text: async () => JSON.stringify({ a: 1 }),
});
async function httpStatus(key, ifMatch = null) {
  const h = handler();
  const r = await h.fn(anfrage(key, ifMatch));
  return { status: r.status, body: await r.json(), writes: h.log.writes.length };
}

// ── Die ECHTE writeAppDataText, nur der Transport ersetzt ──────────────
function bibliothek() {
  const log = { sets: 0 };
  const a = adminSrc.indexOf("export async function writeAppDataText(");
  const koerper = adminSrc.slice(a, adminSrc.indexOf("\n}\n", a) + 3).replace("export async function", "async function");
  const u = adminSrc.indexOf("function unwrapData(value) {");
  const unwrap = adminSrc.slice(u, adminSrc.indexOf("\n}\n", u) + 3);
  const fn = new Function("firebaseDbGetWithEtag", "firebaseDbSet", "appStorePath", "jsonEtag",
    "classifyBlobKey", "JSON", "Date", "Error",
    unwrap + "\n" + koerper + "\nreturn writeAppDataText;")(
    async () => ({ exists: false, value: null, serverEtag: "srv" }),
    async () => { log.sets++; return { ok: true }; },
    (k) => "appStore/" + firebaseNodeKey(k),
    (t) => "etag-" + t.length, classifyBlobKey, JSON, Date, Error);
  return { fn, log };
}
async function libErgebnis(key, ifMatch = null) {
  const b = bibliothek();
  const r = await b.fn(key, JSON.stringify({ a: 1 }), { ifMatch });
  return { denied: !!r.denied, precondition: !!r.preconditionRequired, ok: !!r.ok, sets: b.log.sets };
}

// Beide Wege muessen dasselbe sagen.
async function beide(key, ifMatch = null) {
  const h = await httpStatus(key, ifMatch);
  const l = await libErgebnis(key, ifMatch);
  const httpKlasse = h.status === 403 ? "denied" : h.status === 428 ? "precondition" : "ok";
  const libKlasse = l.denied ? "denied" : l.precondition ? "precondition" : "ok";
  ok(httpKlasse === libKlasse,
    `"${key}": HTTP sagt ${httpKlasse} (${h.status}), die Bibliothek sagt ${libKlasse} — ` +
    "die beiden Schreibwege laufen auseinander");
  if (httpKlasse !== "ok") ok(l.sets === 0, `"${key}": die Bibliothek schrieb trotz Ablehnung`);
  return h;
}

// ── 1. KERN: ohne If-Match 428, mit If-Match regulaerer CAS ────────────
const KERN_VARIANTEN = ["app-data.json", "app-data_json", "app-data#json", "app-data$json",
  "app-data[json", "app-data]json", "app-data/json"];
for (const k of KERN_VARIANTEN) {
  ok(isCoreKey(k), `"${k}" wird nicht als Kernschluessel erkannt`);
  ok(classifyBlobKey(k).kind === "core", `"${k}" wird nicht als core klassifiziert`);
  const ohne = await beide(k);
  ok(ohne.status === 428, `"${k}" ohne If-Match: ${ohne.status} statt 428`);
  const mit = await beide(k, "etag-1");
  ok(mit.status === 200, `"${k}" mit If-Match: ${mit.status} statt 200`);
  ok(mit.writes === 1, `"${k}" mit If-Match: der CAS-Schreibvorgang lief nicht`);
}

// ── 2. Die vier erlaubten Familien: 200 ────────────────────────────────
const GUELTIG = [
  ["recalllab-mobile.json", "exakt a"],
  ["readinghub-data.json", "exakt b"],
  ["_diagnose-test.json", "_diagnose-*"],
  ["_diagnose-x", "_diagnose-* minimal"],
  ["_diagnose-A_b-9.json", "_diagnose-* volles Alphabet"],
  ["attachment-text__" + attSegEncode("meeting") + "__" + attSegEncode("n8n:2026:08") + "__" + attSegEncode("f_abc_1234"), "attachment kanonisch"],
  ["attachment-text__" + attSegEncode("note") + "__" + attSegEncode("Besprechung 2026-08-25") + "__" + attSegEncode("f1"), "attachment mit Leerzeichen"],
  ["attachment-text__" + attSegEncode("note") + "__" + attSegEncode("Übergabe") + "__" + attSegEncode("f1"), "attachment mit Unicode"],
  ["attachment-text__" + attSegEncode("note") + "__" + attSegEncode("a__b") + "__" + attSegEncode("f1"), "attachment mit __ in der Id"],
];
for (const [key, was] of GUELTIG) {
  const r = await beide(key);
  ok(r.status === 200, `${was} ("${key.slice(0, 60)}"): ${r.status} statt 200 (${r.body?.reason || ""})`);
  ok(classifyBlobKey(key).kind === "side", `${was}: nicht als side klassifiziert`);
}

// ── 3. Alles andere: 403 ───────────────────────────────────────────────
const ENC = (s) => attSegEncode(s);
const ABGELEHNT = [
  ["quantus-core-custom.json", "Fantasie-Key"],
  ["recalllab-mobile2.json", "Verwechsler"],
  ["recalllab-mobile.jsonx", "Verwechsler mit Anhaengsel"],
  ["Xrecalllab-mobile.json", "Verwechsler mit Praefix"],
  ["readinghub-data.json.bak", "Verwechsler mit Endung"],
  ["_diagnose/../x", "Slash im Diagnose-Key"],
  ["_diagnose-", "Diagnose ohne Rest"],
  ["_diagnose", "Diagnose ohne Trenner"],
  ["_diagnose-a/b", "Slash im Diagnose-Rest"],
  ["_diagnose-a b", "Leerzeichen im Diagnose-Rest"],
  // Altformate: lesbar, aber nicht mehr beschreibbar
  ["attachment-text__meeting__Besprechung 2026-08-25__f_abc", "rohes Altformat"],
  ["attachment-text__note__n1__f1", "rohes Altformat, harmlos aussehend"],
  ["attachment-text:note:n1:f1", "Doppelpunkt-Altformat"],
  // malformed
  ["attachment-text__" + ENC("a") + "__" + ENC("b"), "nur drei Teile"],
  ["attachment-text__" + ENC("a") + "__" + ENC("b") + "__" + ENC("c") + "__" + ENC("d"), "fuenf Teile"],
  ["attachment-text____" + ENC("b") + "__" + ENC("c"), "leeres Segment"],
  ["attachment-text__" + ENC("a") + "____" + ENC("c"), "leeres Segment in der Mitte"],
  ["attachment-text__" + ENC("a") + "__" + ENC("b") + "__", "leeres Segment am Ende"],
  ["__" + ENC("a") + "__" + ENC("b") + "__" + ENC("c"), "fuehrender Trenner"],
  ["attachment-text__" + ENC("a") + "__x/y__" + ENC("c"), "Slash im Segment"],
  ["attachment-text__" + ENC("a") + "__x_y__" + ENC("c"), "Unterstrich im Segment"],
  ["attachment-text__" + ENC("a") + "__x+y__" + ENC("c"), "Plus im Segment"],
  ["attachment-text__" + ENC("a") + "__x=__" + ENC("c"), "Padding im Segment"],
  ["attachment-text__" + ENC("a") + "__~~~~__" + ENC("c"), "~-Missbrauch"],
  ["attachment-text__" + ENC("a") + "__AB__" + ENC("c"), "Base64-Alias AB statt AA"],
  ["attachment-text__" + ENC("a") + "__gA__" + ENC("c"), "fatal UTF-8"],
  ["attachment_text__" + ENC("a") + "__" + ENC("b") + "__" + ENC("c"), "Praefix mit Unterstrich"],
  ["attachment-textX__" + ENC("a") + "__" + ENC("b") + "__" + ENC("c"), "Praefix mit Anhaengsel"],
  ["polaris/inbox/note/x", "fremder Pfad"],
  ["appStore/app-data_json2", "Nachbarknoten"],
  ["../../etc/passwd", "Pfadausbruch"],
];
for (const [key, was] of ABGELEHNT) {
  const r = await beide(key);
  ok(r.status === 403, `${was} ("${key.slice(0, 60)}"): ${r.status} statt 403`);
  ok(r.writes === 0, `${was}: es wurde trotz Ablehnung geschrieben`);
}

// ── 3b. Fehlender Schluessel: 400, nicht 403 ───────────────────────────
// Ein fehlender key-Parameter ist eine kaputte Anfrage, kein verbotener
// Schluessel. blob-put weist ihn vor der Politik ab; das ist richtig so und
// keine Divergenz zwischen den beiden Schreibwegen — die Bibliothek bekommt in
// diesem Fall gar keinen Aufruf.
{
  const r = await httpStatus("");
  ok(r.status === 400, `ein fehlender Schluessel: ${r.status} statt 400`);
  ok(r.writes === 0, "bei fehlendem Schluessel wurde geschrieben");
  ok(classifyBlobKey("").kind === "denied",
    "die Politik selbst laesst einen leeren Schluessel durch");
  const l = await libErgebnis("");
  ok(l.denied === true && l.sets === 0,
    "die Bibliothek nimmt einen leeren Schluessel an");
}

// ── 4. Ueberlaenge ─────────────────────────────────────────────────────
{
  // Der laengste noch erlaubte Schluessel und der erste zu lange.
  let passend = null, zuLang = null;
  for (let n = 1; n < 900; n++) {
    const k = "attachment-text__" + ENC("n") + "__" + ENC("x".repeat(n)) + "__" + ENC("f");
    const b = blobKeyByteLength(k);
    if (b <= BLOB_KEY_MAX_BYTES) passend = k;
    else { zuLang = k; break; }
  }
  ok(!!passend && !!zuLang, "es liess sich kein Paar knapp unter/ueber der Grenze bauen");
  ok(blobKeyByteLength(passend) <= BLOB_KEY_MAX_BYTES, "der passende Schluessel ist zu lang");
  const a = await beide(passend);
  ok(a.status === 200, `knapp unter der Grenze: ${a.status} statt 200`);
  const b = await beide(zuLang);
  ok(b.status === 403, `ueber der Grenze: ${b.status} statt 403`);
  ok(b.body?.reason === "key_too_long", `Grund "${b.body?.reason}" statt key_too_long`);

  ok(BLOB_KEY_MAX_BYTES < RTDB_KEY_LIMIT_BYTES,
    "die Grenze liegt nicht unter dem RTDB-Limit — dann waere die Reserve keine");
  ok(RTDB_KEY_LIMIT_BYTES === 768, "das RTDB-Limit ist nicht als 768 Bytes hinterlegt");
  // Bytes, nicht Zeichen
  ok(blobKeyByteLength("ä") === 2 && blobKeyByteLength("\u{1F642}") === 4,
    "die Laenge wird in JS-Zeichen statt in UTF-8-Bytes gemessen");
}

// ── 5. Der Codec ist zeichengleich mit dem des Clients ─────────────────
{
  const cut = (n) => {
    const a = indexSrc.indexOf("\nfunction " + n + "(");
    return indexSrc.slice(a, indexSrc.indexOf("\n}\n", a) + 3);
  };
  const klient = new Function("TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error",
    cut("_attSegEncode") + cut("_attSegDecode") + "\nreturn { _attSegEncode, _attSegDecode };")(
    TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error);
  for (const f of ["note", "Besprechung 2026-08-25", "Übergabe", "kick-off@kunde", "n8n:2026:08",
    "a__b", "__vorn", "hinten__", "f_abc_1234", "\u{1F642} Emoji", " "]) {
    ok(klient._attSegEncode(f) === attSegEncode(f),
      `der Server kodiert ${JSON.stringify(f)} anders als der Client — dann lehnt er gueltige Schluessel ab`);
    ok(attSegDecode(attSegEncode(f)) === f, `Roundtrip verloren fuer ${JSON.stringify(f)}`);
  }
  for (const alias of ["AB", "AC", "AP"]) {
    let geworfen = false;
    try { attSegDecode(alias); } catch (e) { geworfen = true; }
    ok(geworfen, `der Server akzeptiert den Alias ${alias}`);
  }
}

// ── 6. Eine Sanitizing-Logik, kein Duplikat ────────────────────────────
{
  ok(/^export \{ firebaseNodeKey \};$/m.test(adminSrc),
    "firebase-admin fuehrt weiterhin eine eigene firebaseNodeKey-Implementierung");
  ok(/import \{ firebaseNodeKey, classifyBlobKey \} from "\.\/blob-key-policy\.mjs";/.test(adminSrc),
    "firebase-admin bezieht Sanitizer und Politik nicht aus der gemeinsamen Datei");
  ok(/import \{ classifyBlobKey/.test(blobPutSrc),
    "blob-put bezieht die Politik nicht aus der gemeinsamen Datei");
  ok(!/replace\(\/\[\.#\$\\\[\\\]\\\/\]\/g/.test(blobPutSrc),
    "blob-put sanitisiert selbst");
  // der Codec steht genau einmal serverseitig
  const policySrc = fs.readFileSync(path.join(root, "netlify/lib/blob-key-policy.mjs"), "utf8");
  ok(/function attSegEncode/.test(policySrc), "der Codec fehlt in der Policy-Datei");
  ok(!/function attSegEncode/.test(adminSrc) && !/function attSegEncode/.test(blobPutSrc),
    "der Codec ist serverseitig dupliziert");
}

// ── 7. blob-get bleibt unangetastet ────────────────────────────────────
{
  const getSrc = fs.readFileSync(path.join(root, "netlify/functions/blob-get.mjs"), "utf8");
  ok(!/classifyBlobKey|blob-key-policy/.test(getSrc),
    "blob-get wendet die Schreibpolitik an — ein Altstand muss lesbar bleiben");
}

if (luecken.length) {
  console.error("F-25 BLOB KEY POLICY — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 blob key policy: ok (${checks} Pruefungen)`);
