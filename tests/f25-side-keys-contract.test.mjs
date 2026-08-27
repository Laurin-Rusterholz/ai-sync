/*
 * F-25 v6 — der Vertrag ueber die Nebenschluessel.
 *
 * Der Kerndatensatz ist seit v5/v6 hart abgeriegelt (If-Match-Pflicht, 428,
 * CAS-Beweis). Damit dieser Riegel nicht versehentlich mehr trifft als gemeint,
 * haelt diese Datei fest, WELCHE Nebenschluessel es wirklich gibt und dass ihre
 * Semantik unveraendert bleibt.
 *
 * Die Liste ist nicht erfunden, sondern aus dem Quelltext erhoben. Kommt ein
 * neuer Schluessel dazu, faellt dieser Test durch — das ist der Zweck: ein
 * kuenftiger Riegel auf "alles ausser einer Whitelist" darf nicht still eine
 * Familie zerbrechen, die niemand auf dem Schirm hatte.
 *
 * Ausserdem der n8n-Nachweis: date-invite und flowertech-* schreiben ueber
 * mutateAppData, einen eigenen serverseitig-frischen Transaktionspfad. Er darf
 * durch die blob-put-Riegel nicht beruehrt werden.
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
const admin = fs.readFileSync(path.join(root, "netlify/lib/firebase-admin.mjs"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ── Die vier realen Nebenschluessel-Familien ───────────────────────────
const FAMILIEN = [
  { name: "recalllab-mobile.json", muster: /'recalllab-mobile\.json'/, beispiel: "recalllab-mobile.json",
    zweck: "Lern-Delta fuers Handy" },
  { name: "readinghub-data.json", muster: /'readinghub-data\.json'/, beispiel: "readinghub-data.json",
    zweck: "ReadingHub-Nebenstand" },
  { name: "_diagnose-test.json", muster: /'_diagnose-test\.json'/, beispiel: "_diagnose-test.json",
    zweck: "Selbsttest der Speicherstrecke" },
  { name: "attachment-text__*", muster: /attachment-text__\$\{kind\}__\$\{entityId\}__\$\{fileId\}/,
    // Seit F-25 M2 ist nur die KANONISCH kodierte Form beschreibbar; das rohe
    // Altformat bleibt LESBAR, aber nicht mehr schreibbar — es ist nicht
    // eindeutig zerlegbar (eine Id mit "__" sprengt die Segmentzahl).
    beispiel: "attachment-text__" + POLITIK.attSegEncode("note") + "__" + POLITIK.attSegEncode("n1") + "__" + POLITIK.attSegEncode("f1"),
    altBeispiel: "attachment-text__note__n1__f1",
    zweck: "extrahierter Text von Anhaengen — DYNAMISCH und unbegrenzt" },
];

// ── 1. Jede Familie existiert noch im Quelltext ────────────────────────
{
  for (const f of FAMILIEN) {
    ok(f.muster.test(index), `die Nebenschluessel-Familie "${f.name}" (${f.zweck}) ist verschwunden`);
    ok(firebaseNodeKey(f.beispiel) !== firebaseNodeKey("app-data.json"),
      `"${f.beispiel}" kollidiert mit dem Kernknoten und wuerde als Kern behandelt`);
  }
}

// ── 2. Es gibt keine FUENFTE Familie ───────────────────────────────────
// Alle Zeichenketten-Schluessel und alle Schluesselbauer einsammeln. Taucht
// etwas Neues auf, muss der Vertrag nachgezogen werden, bevor irgendein
// Whitelist-Riegel scharfgeschaltet wird.
{
  const wortlaut = new Set();
  const re = /\b(netlifyBlobPut|netlifyBlobGet|remotePutByKey|remoteGetByKey)\s*\(\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(index))) wortlaut.add(m[3]);
  const bekannt = new Set(FAMILIEN.map((f) => f.name).concat(["app-data.json"]));
  const unbekannt = [...wortlaut].filter((k) => !bekannt.has(k));
  ok(unbekannt.length === 0,
    `neue Schluessel im Quelltext, die der Vertrag nicht kennt: ${unbekannt.join(", ")} — ` +
    "vor einem Whitelist-Riegel klaeren, sonst bricht er sie still");

  // Schluesselbauer namentlich, nicht gezaehlt: ein neuer NAME ist die Meldung
  // wert, eine geaenderte Zahl allein nicht. Seit M1 gibt es neben dem
  // kanonischen Bauplan zwei reine LESE-Helfer fuer die Altformate — sie
  // erzeugen keine neue Familie, sie lesen die bestehende.
  const BEKANNTE_BAUER = new Set([
    "migrateCoreBlobKey",        // Einstellungsmigration, kein Schluesselbau
    "_textBlobKey",              // kanonisch, kodiert (M1)
    "_textBlobKeyLegacyRaw",     // nur lesen: Altformat mit rohen Segmenten
    "_textBlobKeyLegacyColon",   // nur lesen: Altformat mit Doppelpunkten
    // F-28: liest den KONFIGURIERTEN Kernschluessel und faellt auf
    // CORE_BLOB_KEY zurueck, wenn APP.state.settings noch null ist (Bootlauf).
    // Er baut nichts: der Rueckgabewert ist entweder der gespeicherte Wert oder
    // dieselbe Konstante, die der Vertrag ohnehin kennt. Ohne ihn stand an
    // dreizehn Stellen eine ungesicherte Kette, die im Startfenster warf.
    "coreBlobKey",
  ]);
  const bauer = (index.match(/^\s*(?:function|const)\s+(_?\w*[Bb]lobKey\w*)\s*[=(]/gm) || [])
    .map((z) => (z.match(/(_?\w*[Bb]lobKey\w*)\s*[=(]/) || [])[1])
    .filter(Boolean);
  const neueBauer = bauer.filter((n) => !BEKANNTE_BAUER.has(n));
  ok(neueBauer.length === 0,
    `neue Schluesselbauer, die der Vertrag nicht kennt: ${neueBauer.join(", ")} — ` +
    "jeder erzeugt potenziell eine eigene Familie");
}

// ── 3. SERVER: die Nebenschluessel behalten ihre Semantik ──────────────
{
  const quelle = blobPut
    .replace(/^import .*$/gm, "")   // blob-put importiert seit M2 aus zwei Dateien
    .replace(/^export const config = .*$/m, "")
    .replace(/^export default /m, "const handler = ");
  const handler = new Function("writeAppDataText", "firebaseNodeKey", "classifyBlobKey", "BLOB_KEY_MAX_BYTES", "RTDB_KEY_LIMIT_BYTES", "Netlify", "Response", "URL", "TextEncoder", "String",
    quelle + "\nreturn handler;")(
    async () => ({ ok: true, etag: "e2" }), firebaseNodeKey, POLITIK.classifyBlobKey, POLITIK.BLOB_KEY_MAX_BYTES, POLITIK.RTDB_KEY_LIMIT_BYTES,
    { env: { get: () => null } }, Response, URL, TextEncoder, String);
  const anfrage = (key, ifMatch) => ({
    method: "PUT",
    url: "https://x/.netlify/functions/blob-put?key=" + encodeURIComponent(key),
    headers: { get: (h) => (h === "If-Match" ? ifMatch : null) },
    text: async () => JSON.stringify({ a: 1 }),
  });

  // Das rohe Altformat ist seit M2 nicht mehr BESCHREIBBAR.
  {
    const alt = FAMILIEN.find((f) => f.altBeispiel);
    const r = await handler(anfrage(alt.altBeispiel, null));
    ok(r.status === 403,
      `das rohe Altformat "${alt.altBeispiel}" ist weiterhin beschreibbar (${r.status}) — ` +
      "es ist nicht eindeutig zerlegbar und darf nur noch gelesen werden");
  }
  for (const f of FAMILIEN) {
    const ohne = await handler(anfrage(f.beispiel, null));
    ok(ohne.status === 200,
      `Server: "${f.beispiel}" (${f.zweck}) wurde ohne If-Match mit ${ohne.status} abgewiesen — ` +
      "Nebenschluessel haben kein Mehrgeraeteproblem und brauchen keinen CAS");
    const mit = await handler(anfrage(f.beispiel, "e1"));
    ok(mit.status === 200, `Server: "${f.beispiel}" mit If-Match wurde mit ${mit.status} abgewiesen`);
  }
  // und der Kern bleibt geriegelt
  ok((await handler(anfrage("app-data.json", null))).status === 428,
    "Server: der Kernschluessel ist nicht mehr geriegelt");
}

// ── 4. CLIENT: kein Nebenschluessel laeuft in den Trichter ─────────────
{
  const a = index.indexOf("\nfunction isCoreDataKey(");
  const fn = new Function("APP", "rtdbNodeKey", "CORE_BLOB_KEY",
    index.slice(a, index.indexOf("\n}\n", a) + 3) + "\nreturn isCoreDataKey;")(
    {}, (k) => String(k || "app-data.json").replace(/[.#$[\]/]/g, "_"), "app-data.json");
  for (const f of FAMILIEN) {
    ok(fn(f.beispiel) === false,
      `Client: "${f.beispiel}" wird als Kern behandelt und liefe durch canonicalWrite`);
  }
}

// ── 5. n8n-Pfad: mutateAppData bleibt unberuehrt ───────────────────────
{
  const m = admin.slice(admin.indexOf("export async function mutateAppData("));
  const koerper = m.slice(0, m.indexOf("\n}\n") + 3);
  ok(/const current = await firebaseDbGetWithEtag\(path\);/.test(koerper),
    "mutateAppData liest nicht mehr serverseitig frisch");
  ok(/ifMatch: current\.serverEtag/.test(koerper),
    "mutateAppData schreibt nicht mehr per Server-ETag-CAS");
  ok(!/writeAppDataText/.test(koerper),
    "mutateAppData laeuft jetzt ueber writeAppDataText — es haette damit einen anderen Vertrag");
  ok(/for \(let attempt = 0; attempt < 8; attempt\+\+\)/.test(koerper),
    "die Wiederholungsschleife von mutateAppData wurde veraendert");

  // die drei Aufrufer schreiben ueber mutateAppData, nicht ueber blob-put
  for (const datei of ["date-invite.mjs", "flowertech-inquiry.mjs", "flowertech-sync.mjs"]) {
    const q = fs.readFileSync(path.join(root, "netlify/functions", datei), "utf8");
    // Kommentare abstreifen: date-invite ERWAEHNT blob-put in einer Begruendung
    // ("bewusst eine eigene Function, kein direkter blob-put von aussen").
    // Die Regel gilt dem Code, nicht der Prosa.
    const code = q.replace(/^\s*\/\/.*$/gm, "");
    ok(/mutateAppData\(/.test(code), `${datei} schreibt nicht mehr ueber mutateAppData`);
    ok(!/blob-put/.test(code), `${datei} spricht jetzt blob-put an — anderer Vertrag, anderer Riegel`);
  }
}

// ── 6. Kein n8n-Workflow spricht blob-put an ───────────────────────────
{
  const n8n = path.join(root, "n8n");
  const dateien = fs.existsSync(n8n) ? fs.readdirSync(n8n) : [];
  ok(dateien.length > 0, "das Verzeichnis n8n/ ist leer oder fehlt — der Nachweis waere gegenstandslos");
  const treffer = dateien.filter((d) => /blob-put/.test(fs.readFileSync(path.join(n8n, d), "utf8")));
  ok(treffer.length === 0,
    `n8n-Workflows sprechen blob-put an und faellen damit unter die neuen Riegel: ${treffer.join(", ")}`);
}

if (luecken.length) {
  console.error("F-25 SIDE KEY CONTRACT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 side keys contract: ok (${checks} Pruefungen)`);
