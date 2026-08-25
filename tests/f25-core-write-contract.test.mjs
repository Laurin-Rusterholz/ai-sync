/*
 * F-25 M2a — der endgueltige Kernvertrag.
 *
 * Commit J hatte fuer den Kerndatensatz eine Erstanlage-Ausnahme eingebaut:
 * ifNoneMatch "*" schrieb, wenn nichts da war. Damit gab es ZWEI Schreibformen
 * fuer den Kern, und die zweite war von aussen ueber eine Kopfzeile ausloesbar
 * und hinterliess keine Spur. Ein geloeschter Kernknoten liess sich so per
 * HTTP neu befuellen.
 *
 * VERTRAGSAENDERUNG v6 -> final, 2026-08-25: es gibt GENAU EINE Schreibform,
 * mit gueltigem If-Match. Keine Erstanlage-Ausnahme, kein If-None-Match, auf
 * keinem Pfad. Ein fehlendes Kerndokument wird ueber den normalen Schreibweg
 * NIE erzeugt. Grund: ein Kern-Restore soll bewusst und auditiert geschehen —
 * dafuer gibt es scripts/restore-core.mjs, lokal, mit Bestaetigung und
 * Protokoll, ohne HTTP-Endpunkt.
 *
 * Geprueft wird gegen die ECHTEN Handler, und zwar BEIDE Wege in jeder Zelle:
 * weichen sie ab, gaebe es einen Weg an der Politik vorbei.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBlobKey, firebaseNodeKey, attSegEncode, BLOB_KEY_MAX_BYTES, RTDB_KEY_LIMIT_BYTES }
  from "../netlify/lib/blob-key-policy.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const blobPutSrc = fs.readFileSync(path.join(root, "netlify/functions/blob-put.mjs"), "utf8");
const adminSrc = fs.readFileSync(path.join(root, "netlify/lib/firebase-admin.mjs"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

// ── Der ECHTE HTTP-Handler ─────────────────────────────────────────────
// schreibweg: was der Handler als writeAppDataText bekommt. Fuer die
// Paritaetsmatrix wird dort die ECHTE Bibliothek eingehaengt — mit einer
// Attrappe koennte sie gar keinen Konflikt erzeugen, und die stale-Zelle waere
// gegenstandslos.
function handler({ schreibweg = null, schreiben = { ok: true, etag: "etag-neu" } } = {}) {
  const log = { writes: [] };
  const quelle = blobPutSrc
    .replace(/^import .*$/gm, "")
    .replace(/^export const config = .*$/m, "")
    .replace(/^export default /m, "const handler = ");
  const fn = new Function(
    "writeAppDataText", "classifyBlobKey", "BLOB_KEY_MAX_BYTES", "RTDB_KEY_LIMIT_BYTES",
    "Netlify", "Response", "URL", "TextEncoder", "String",
    quelle + "\nreturn handler;")(
    async (k, b, o) => {
      log.writes.push({ key: k, options: o });
      return schreibweg ? schreibweg(k, b, o) : schreiben;
    },
    classifyBlobKey, BLOB_KEY_MAX_BYTES, RTDB_KEY_LIMIT_BYTES,
    { env: { get: () => null } }, Response, URL, TextEncoder, String);
  return { fn, log };
}

// ── Die ECHTE writeAppDataText, nur der Transport ersetzt ──────────────
function bibliothek({ current = null, serverEtag = "srv-1" } = {}) {
  const log = { sets: 0 };
  const a = adminSrc.indexOf("export async function writeAppDataText(");
  const koerper = adminSrc.slice(a, adminSrc.indexOf("\n}\n", a) + 3).replace("export async function", "async function");
  const u = adminSrc.indexOf("function unwrapData(value) {");
  const unwrap = adminSrc.slice(u, adminSrc.indexOf("\n}\n", u) + 3);
  const fn = new Function("firebaseDbGetWithEtag", "firebaseDbSet", "appStorePath", "jsonEtag",
    "classifyBlobKey", "JSON", "Date", "Error",
    unwrap + "\n" + koerper + "\nreturn writeAppDataText;")(
    async () => ({ exists: current !== null, value: current, serverEtag }),
    async () => { log.sets++; return { ok: true }; },
    (k) => "appStore/" + firebaseNodeKey(k),
    (t) => "etag-" + t.length, classifyBlobKey, JSON, Date, Error);
  return { fn, log };
}

const KERN = "app-data.json";
const KOERPER = JSON.stringify({ entities: { notes: {} }, meta: { updatedAt: "2026-08-25T10:00:00.000Z" } });
const huelle = (text) => ({ data: text, etag: "etag-" + text.length });

const anfrage = (key, ifMatch, ifNoneMatch) => ({
  method: "PUT",
  url: "https://x/.netlify/functions/blob-put?key=" + encodeURIComponent(key),
  headers: { get: (h) => (h === "If-Match" ? ifMatch : h === "If-None-Match" ? ifNoneMatch : null) },
  text: async () => KOERPER,
});

// ── 1. PARITAETSMATRIX: Kern x fuenf Kopfzeilen-Lagen ──────────────────
// In jeder Zelle muessen HTTP und Bibliothek DASSELBE sagen.
const GUELTIGER_ETAG = "etag-" + KOERPER.length;
const LAGEN = [
  { name: "If-Match gueltig", ifMatch: GUELTIGER_ETAG, ifNoneMatch: null, current: huelle(KOERPER), erwartet: "ok" },
  { name: "If-Match stale", ifMatch: "etag-veraltet", ifNoneMatch: null, current: huelle(KOERPER), erwartet: "conflict" },
  { name: "ohne If-Match", ifMatch: null, ifNoneMatch: null, current: huelle(KOERPER), erwartet: "precondition" },
  { name: "If-None-Match:*", ifMatch: null, ifNoneMatch: "*", current: null, erwartet: "precondition" },
  { name: "beides gesetzt", ifMatch: GUELTIGER_ETAG, ifNoneMatch: "*", current: huelle(KOERPER), erwartet: "ok" },
];
for (const l of LAGEN) {
  const echt = bibliothek({ current: l.current });
  const hh = handler({ schreibweg: (k, b, o) => echt.fn(k, b, o) });
  const antwort = await hh.fn(anfrage(KERN, l.ifMatch, l.ifNoneMatch));
  const httpKlasse = antwort.status === 200 ? "ok"
    : antwort.status === 428 ? "precondition"
      : antwort.status === 412 ? "conflict"
        : antwort.status === 403 ? "denied" : "status_" + antwort.status;

  const b = bibliothek({ current: l.current });
  const r = await b.fn(KERN, KOERPER, { ifMatch: l.ifMatch, ifNoneMatch: l.ifNoneMatch });
  const libKlasse = r.preconditionRequired ? "precondition"
    : r.denied ? "denied"
      : r.conflict ? "conflict"
        : r.ok ? "ok" : "unbekannt";

  ok(httpKlasse === l.erwartet,
    `Kern / ${l.name}: HTTP sagt ${httpKlasse} (${antwort.status}) statt ${l.erwartet}`);
  ok(libKlasse === l.erwartet,
    `Kern / ${l.name}: die Bibliothek sagt ${libKlasse} statt ${l.erwartet}`);
  ok(httpKlasse === libKlasse,
    `Kern / ${l.name}: HTTP (${httpKlasse}) und Bibliothek (${libKlasse}) laufen auseinander — ` +
    "dann gaebe es einen Weg an der Politik vorbei");
  if (l.erwartet !== "ok") {
    ok(b.log.sets === 0, `Kern / ${l.name}: die Bibliothek schrieb trotz Ablehnung`);
  } else {
    ok(b.log.sets === 1, `Kern / ${l.name}: der erlaubte Schreibvorgang lief nicht`);
  }
}

// ── 2. If-None-Match:* erzeugt KEIN fehlendes Kerndokument ─────────────
// Genau der Bypass, den Commit J offen liess.
{
  const b = bibliothek({ current: null });
  const r = await b.fn(KERN, KOERPER, { ifNoneMatch: "*" });
  ok(r.ok !== true,
    "If-None-Match:* legt den fehlenden Kerndatensatz weiterhin an — der Bypass aus Commit J steht noch");
  ok(r.preconditionRequired === true,
    `If-None-Match:* liefert "${r.reason}" statt precondition_required`);
  ok(b.log.sets === 0, "If-None-Match:*: es ging ein Schreibvorgang hinaus");

  const h = handler();
  const a = await h.fn(anfrage(KERN, null, "*"));
  ok(a.status === 428, `If-None-Match:* ueber HTTP: ${a.status} statt 428`);
  ok(h.log.writes.length === 0, "If-None-Match:* ueber HTTP: es wurde geschrieben");

  // und mit gesetztem If-Match auf einem fehlenden Stand bleibt es 412
  const b2 = bibliothek({ current: null });
  const r2 = await b2.fn(KERN, KOERPER, { ifMatch: "etag-A" });
  ok(r2.conflict === true && r2.reason === "no_current",
    `fehlender Stand mit If-Match: "${r2.reason}" statt no_current`);
  ok(b2.log.sets === 0, "fehlender Stand mit If-Match: es wurde geschrieben");
}

// ── 3. Alle Kern-Varianten verhalten sich gleich ───────────────────────
for (const k of ["app-data_json", "app-data#json", "app-data/json"]) {
  const h = handler();
  ok((await h.fn(anfrage(k, null, "*"))).status === 428,
    `"${k}" mit If-None-Match:*: nicht 428`);
  const b = bibliothek({ current: null });
  const r = await b.fn(k, KOERPER, { ifNoneMatch: "*" });
  ok(r.preconditionRequired === true && b.log.sets === 0,
    `"${k}" mit If-None-Match:* in der Bibliothek: geschrieben oder falsch klassifiziert`);
}

// ── 4. Nebenschluessel bleiben unberuehrt ──────────────────────────────
{
  const h = handler();
  ok((await h.fn(anfrage("recalllab-mobile.json", null, null))).status === 200,
    "ein Nebenschluessel braucht jetzt If-Match");
  const b = bibliothek({ current: null });
  const r = await b.fn("recalllab-mobile.json", KOERPER, {});
  ok(r.ok === true && b.log.sets === 1, "ein Nebenschluessel wird nicht mehr geschrieben");
}

// ── 5. Quelltextregeln zur Vertragsaenderung ───────────────────────────
{
  const admin = ohneKommentare(adminSrc);
  const put = ohneKommentare(blobPutSrc);
  ok(!/ifNoneMatch/.test(admin),
    "writeAppDataText kennt weiterhin ifNoneMatch — die Erstanlage-Ausnahme steht noch");
  ok(!/already_exists/.test(admin), "der Erstanlage-Zweig hinterlaesst noch seinen Konfliktgrund");
  ok(!/ifNoneMatch/.test(put), "blob-put reicht weiterhin If-None-Match an den Schreibweg durch");
  ok(/politik\.kind === "core" && !ifMatch/.test(admin),
    "die Bibliothek prueft die If-Match-Pflicht nicht mehr");
  ok(/politik\.kind === "core" && !ifMatch/.test(put),
    "der HTTP-Handler prueft die If-Match-Pflicht nicht mehr");
  // blob-get darf If-None-Match weiterhin fuer bedingte LESEvorgaenge nutzen
  const get = fs.readFileSync(path.join(root, "netlify/functions/blob-get.mjs"), "utf8");
  ok(/If-None-Match/.test(get),
    "blob-get hat die bedingte Leseabfrage verloren — sie ist ein anderer Weg und gehoert nicht dazu");
}

// ── 6. Der Recovery-Pfad ist lokal, bewusst und protokolliert ──────────
{
  const skript = await import("../scripts/restore-core.mjs");
  const src = fs.readFileSync(path.join(root, "scripts/restore-core.mjs"), "utf8");

  // Ohne Flag passiert nichts.
  ok(skript.pruefeArgumente(skript.parseArgs(["--from", "b.json"])).ok === false,
    "der Restore laeuft ohne das Bestaetigungsflag");
  ok(skript.pruefeArgumente(skript.parseArgs(["--from", "b.json", skript.RESTORE_FLAG])).ok === true,
    "der Restore laeuft auch MIT Flag nicht");
  ok(skript.pruefeArgumente(skript.parseArgs([skript.RESTORE_FLAG])).ok === false,
    "der Restore laeuft ohne Backup-Datei");
  ok(skript.pruefeArgumente(skript.parseArgs(["--from", "b.json", "--key", "recalllab-mobile.json", skript.RESTORE_FLAG])).ok === false,
    "das Skript stellt auch Nebenschluessel wieder her — es ist fuer den Kern gedacht");

  // Die Zusammenfassung ist eine reine Funktion und wird direkt geprueft.
  const aktuell = { entities: { notes: { a: 1, b: 2 }, tasks: { t: 1 } }, meta: {}, journal: {} };
  const backup = { entities: { notes: { a: 1, b: 2, c: 3 }, tasks: {} }, meta: {}, weekPlan: {} };
  // Seit M2b nimmt diffZusammenfassung die BEWERTUNG des Ist-Standes entgegen,
  // nicht rohe Daten — damit "fehlt" und "unlesbar" nicht als leerer Stand
  // durchrutschen koennen. Der Datenvertrag selbst steht in
  // tests/f25-restore-core-contract.test.mjs.
  const d = skript.diffZusammenfassung(
    skript.bewerteAktuellenStand({ exists: true, data: JSON.stringify(aktuell), parsed: aktuell }),
    backup, {});
  ok(d.wurzelfelder.nurAktuell.join() === "journal",
    `verlorene Wurzelfelder: ${d.wurzelfelder.nurAktuell.join()}`);
  ok(d.wurzelfelder.nurBackup.join() === "weekPlan",
    `hinzukommende Wurzelfelder: ${d.wurzelfelder.nurBackup.join()}`);
  ok(d.summeAktuell === 3 && d.summeBackup === 3, "die Entitaetssummen stimmen nicht");
  ok(d.verlust.length === 1 && d.verlust[0].sammlung === "tasks",
    "der Verlust in tasks wird nicht als solcher gemeldet");
  const text = skript.formatiereZusammenfassung(d, "app-data.json");
  ok(/GEHEN VERLOREN: journal/.test(text), "die Zusammenfassung nennt die verlorenen Felder nicht");
  ok(/ACHTUNG/.test(text), "die Zusammenfassung warnt nicht vor dem Verlust");
  ok(skript.entitaetsZahlen(backup).notes === 3, "die Entitaetszaehlung stimmt nicht");
  ok(/\.restore\.json$/.test(skript.protokollName("app-data.json", new Date())),
    "der Protokollname passt nicht");

  // Und es ist KEIN Endpunkt.
  ok(!/export const config/.test(src) && !/Response\.json/.test(src),
    "das Restore-Skript sieht wie eine Netlify-Function aus");
  ok(!/netlify\/functions/.test(src), "das Restore-Skript liegt oder wirkt im Functions-Pfad");
  ok(/RESTORE_FLAG = "--i-know-what-i-am-doing"/.test(src), "das Bestaetigungsflag fehlt");
  ok(/readline/.test(src) && /Zum Bestaetigen den Schluesselnamen/.test(src),
    "es gibt keine interaktive Bestaetigung");
  ok(/firebaseDbSet\(/.test(src), "der Restore schreibt nicht direkt in die RTDB");
  ok(!/blob-put|writeAppDataText/.test(ohneKommentare(src)),
    "der Restore laeuft ueber die Fassade — dann traefe ihn die If-Match-Pflicht");
  // Seit M2b laeuft das Protokoll ueber schreibeIntent/aktualisiereIntent mit
  // fsync statt ueber ein einfaches writeFile; die Reihenfolge (Intent vor
  // Write) prueft tests/f25-restore-core-contract.test.mjs ausfuehrbar.
  ok(/restore-log/.test(src) && /schreibeIntent\(/.test(src) && /aktualisiereIntent\(/.test(src),
    "es wird kein Protokoll geschrieben");
  ok(/await fh\.sync\(\)/.test(src), "das Protokoll wird nicht gefsynct");
  ok(skript.LOG_DIR.startsWith("work/"), `das Protokoll landet in "${skript.LOG_DIR}" statt unter work/`);
  ok(/--dry-run/.test(src), "es gibt keinen Weg, die Zusammenfassung ohne Schreibvorgang zu sehen");
}

if (luecken.length) {
  console.error("F-25 CORE WRITE CONTRACT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 core write contract: ok (${checks} Pruefungen)`);
