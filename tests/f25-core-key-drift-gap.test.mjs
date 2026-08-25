/*
 * F-25 v6 — der Kernschluessel darf nicht driften.
 *
 * Befund: Client UND Server erkannten den Kerndatensatz an der ZEICHENKETTE.
 *   Server: String(key) === "app-data.json"
 *   Client: key === (APP.state.settings?.storage?.blobKey || 'app-data.json')
 * Beide landen aber ueber firebaseNodeKey/rtdbNodeKey auf demselben KNOTEN:
 * . # $ [ ] / werden zu _. "app-data_json", "app-data#json", "app-data/json"
 * und weitere Varianten zeigen auf appStore/app-data_json — wurden aber weder
 * vom Trichter noch vom 428-Riegel als Kern erkannt. Ein Aufrufer haette den
 * Kerndatensatz unter einem leicht anderen Namen UNBEDINGT ueberschreiben
 * koennen, an jedem CAS-Riegel vorbei.
 *
 * Dazu war der Kernschluessel clientseitig ein frei editierbares Textfeld.
 *
 * Faellt etwas durch, meldet der Lauf "F-25 CORE KEY DRIFT".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Seit F-25 M2 bezieht blob-put die Schluesselpolitik aus einer eigenen Datei.
import * as POLITIK from "../netlify/lib/blob-key-policy.mjs";
import { firebaseNodeKey } from "../netlify/lib/firebase-admin.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const blobPut = fs.readFileSync(path.join(root, "netlify/functions/blob-put.mjs"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");
function funktion(name, praefix = "function ") {
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
// Auf einem aelteren Stand fehlt eine Funktion ganz. Ohne diese Nachsicht
// stuerbe die Gegenprobe am fehlenden NAMEN statt am Verhalten — durchgefallen
// aus dem falschen Grund, ohne die Luecke je zu zeigen.
function funktionOptional(name, praefix = "function ") {
  return index.indexOf("\n" + praefix + name + "(") > 0 ? funktion(name, praefix) : null;
}

// Jede Schreibweise, die auf denselben RTDB-Knoten zeigt.
const KERN_VARIANTEN = [
  "app-data.json", "app-data_json", "app-data#json", "app-data$json",
  "app-data[json", "app-data]json", "app-data/json",
];
// Echte Nebenschluessel dieser App — repoweit erhoben, nicht erfunden.
const NEBEN = [
  "recalllab-mobile.json", "readinghub-data.json", "_diagnose-test.json",
  // Seit F-25 M2 nur noch die KANONISCH kodierte Form; das rohe Altformat ist
  // lesbar, aber nicht mehr schreibbar (siehe f25-blob-key-policy).
  "attachment-text__" + POLITIK.attSegEncode("note") + "__" + POLITIK.attSegEncode("n1") + "__" + POLITIK.attSegEncode("f1"),
];

// ── 1. Der Knoten ist derselbe — das ist die Voraussetzung des Befunds ──
{
  const kern = firebaseNodeKey("app-data.json");
  for (const v of KERN_VARIANTEN) {
    ok(firebaseNodeKey(v) === kern, `"${v}" zeigt nicht auf denselben Knoten wie app-data.json`);
  }
  for (const n of NEBEN) {
    ok(firebaseNodeKey(n) !== kern, `der Nebenschluessel "${n}" kollidiert mit dem Kernknoten`);
  }
}

// ── 2. SERVER: jede Variante bekommt ohne If-Match 428 ─────────────────
{
  const quelle = blobPut
    .replace(/^import .*$/gm, "")   // blob-put importiert seit M2 aus zwei Dateien
    .replace(/^export const config = .*$/m, "")
    .replace(/^export default /m, "const handler = ");
  const handler = new Function("writeAppDataText", "firebaseNodeKey", "classifyBlobKey", "BLOB_KEY_MAX_BYTES", "RTDB_KEY_LIMIT_BYTES", "Netlify", "Response", "URL", "TextEncoder", "String",
    quelle + "\nreturn handler;")(
    async () => ({ ok: true, etag: "etag-neu" }), firebaseNodeKey, POLITIK.classifyBlobKey, POLITIK.BLOB_KEY_MAX_BYTES, POLITIK.RTDB_KEY_LIMIT_BYTES,
    { env: { get: () => null } }, Response, URL, TextEncoder, String);
  const anfrage = (key, ifMatch) => ({
    method: "PUT",
    url: "https://x/.netlify/functions/blob-put?key=" + encodeURIComponent(key),
    headers: { get: (h) => (h === "If-Match" ? ifMatch : null) },
    text: async () => JSON.stringify({ entities: {} }),
  });

  for (const v of KERN_VARIANTEN) {
    const r = await handler(anfrage(v, null));
    ok(r.status === 428,
      `Server: "${v}" zeigt auf den Kernknoten, kam ohne If-Match aber mit ${r.status} durch statt mit 428`);
    const mit = await handler(anfrage(v, "etag-1"));
    ok(mit.status === 200, `Server: "${v}" mit If-Match wurde mit ${mit.status} abgewiesen`);
  }
  // Nebenschluessel behalten ihre Semantik
  for (const n of NEBEN) {
    const r = await handler(anfrage(n, null));
    ok(r.status === 200,
      `Server: der legitime Nebenschluessel "${n}" wurde mit ${r.status} abgewiesen — er hat kein Mehrgeraeteproblem`);
  }
}

// ── 3. CLIENT: isCoreDataKey erkennt dieselben Varianten ───────────────
{
  const fn = new Function("APP", "rtdbNodeKey", "CORE_BLOB_KEY",
    funktion("isCoreDataKey") + "\nreturn isCoreDataKey;")(
    { state: { settings: { storage: { blobKey: "app-data.json" } } } },
    (k) => String(k || "app-data.json").replace(/[.#$[\]/]/g, "_"),
    "app-data.json");
  for (const v of KERN_VARIANTEN) {
    ok(fn(v) === true, `Client: "${v}" wird nicht als Kernschluessel erkannt — er laeuft am Trichter vorbei`);
  }
  for (const n of NEBEN) {
    ok(fn(n) === false, `Client: der Nebenschluessel "${n}" wird faelschlich als Kern behandelt`);
  }
  ok(fn("") === false && fn(null) === false && fn(undefined) === false,
    "Client: ein leerer Schluessel wird als Kern behandelt");
}

// ── 4. CLIENT: der Kernschluessel ist eine Konstante ───────────────────
{
  ok(/const CORE_BLOB_KEY = 'app-data\.json';/.test(index),
    "der Kernschluessel ist keine Konstante");
  const speichern = ohneKommentare(index.slice(index.indexOf("window.saveSettingsModal = function()"),
    index.indexOf("window.saveSettingsModal = function()") + 900));
  ok(!/blobKey = \$\("#setBlobKey"\)\?\.value/.test(speichern),
    "der Kernschluessel wird weiterhin aus dem Formular uebernommen");
  ok(/storage\.blobKey = CORE_BLOB_KEY;/.test(speichern),
    "der Kernschluessel wird beim Speichern nicht auf die Konstante gesetzt");
  const feld = index.slice(index.indexOf('id="setBlobKey"') - 60, index.indexOf('id="setBlobKey"') + 400);
  ok(/readonly/.test(feld) && /disabled/.test(feld), "das Blob-Key-Feld ist weiterhin editierbar");

  const migrateSrc = funktionOptional("migrateCoreBlobKey");
  ok(!!migrateSrc, "es gibt keine Migration eines gespeicherten Kernschluessels");
  const migrate = migrateSrc
    ? new Function("console", "CORE_BLOB_KEY", migrateSrc + "\nreturn migrateCoreBlobKey;")({ warn() {} }, "app-data.json")
    : (x) => x;
  ok(migrate({ storage: { blobKey: "app-data_json" } })?.storage?.blobKey === "app-data.json",
    "ein gespeicherter Altwert wird nicht auf den kanonischen Schluessel gehoben");
  ok(migrate({ storage: { blobKey: "quatsch.json" } })?.storage?.blobKey === "app-data.json",
    "ein beliebiger gespeicherter Wert bleibt stehen");
  ok(migrate({ storage: { blobKey: "app-data.json" } })?.storage?.blobKey === "app-data.json",
    "die Migration veraendert den gueltigen Wert");
  ok(migrate(undefined) === undefined, "die Migration wirft bei fehlenden Einstellungen");
  const laden = ohneKommentare(funktion("loadSettings"));
  ok((laden.match(/migrateCoreBlobKey\(/g) || []).length >= 3,
    "loadSettings migriert den Schluessel nicht auf allen Rueckgabewegen (inklusive catch)");
}

// ── 5. Quelltextregeln ─────────────────────────────────────────────────
{
  // Seit F-25 M2 liegt die Erkennung in netlify/lib/blob-key-policy.mjs — EINE
  // Quelle fuer blob-put UND writeAppDataText. Die Zusicherung gilt weiter, nur
  // eine Datei weiter.
  const politikSrc = ohneKommentare(fs.readFileSync(path.join(root, "netlify/lib/blob-key-policy.mjs"), "utf8"));
  const server = ohneKommentare(blobPut);
  ok(/firebaseNodeKey\(String\(key \|\| ""\)\) === CORE_NODE/.test(politikSrc),
    "der Kern wird weiterhin an der Zeichenkette statt am Knoten erkannt");
  ok(/classifyBlobKey\(key\)/.test(server),
    "blob-put bezieht die Politik nicht aus der gemeinsamen Datei");
  ok(/politik\.kind === "core" && !ifMatch/.test(server) && /status: 428/.test(server),
    "der Server laesst einen unbedingten Core-PUT weiterhin durch");
  const client = ohneKommentare(funktion("isCoreDataKey"));
  ok(/rtdbNodeKey\(key\) === rtdbNodeKey\(CORE_BLOB_KEY\)/.test(client),
    "der Client erkennt den Kern weiterhin an der Zeichenkette statt am Knoten");
  ok(!/APP\.state\.settings\?\.storage\?\.blobKey \|\| 'app-data\.json'/.test(client),
    "isCoreDataKey haengt weiterhin am frei setzbaren Einstellungswert");
}

if (luecken.length) {
  console.error("F-25 CORE KEY DRIFT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 core key drift: ok (${checks} Pruefungen)`);
