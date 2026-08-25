/*
 * F-25 M1c — was angezeigt wird, muss auch loeschbar sein.
 *
 * Befund: renderFileAttachments kannte invoice:'invoices', der delete-file-Zweig
 * nicht. Ein Rechnungsanhang liess sich anzeigen, aber nicht loeschen — und der
 * Handler kehrte STILL zurueck, vor confirm, vor der Firebase-Loeschung, vor dem
 * kanonischen Grabstein, vor splice, scheduleSave und render. Kein Toast, keine
 * Konsolenzeile, nichts.
 *
 * Ursache ist die Bauweise: jeder Zweig fuehrte seine EIGENE Kind->Collection-
 * Liste. Zwei Listen fuer dieselbe Frage gehen irgendwann auseinander. Seit M1c
 * gibt es genau eine (ATTACHMENT_KIND_STORES), und beide Zweige lesen sie.
 *
 * Getestet wird am ECHTEN Loeschzweig aus public/index.html.
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
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

function schnipsel(name, praefix = "function ") {
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
const BAUER = ["_attSegEncode", "_attSegDecode", "_textBlobKey", "_textBlobKeyLegacyRaw",
  "_textBlobKeyLegacyColon", "attachmentReadKeys", "_attKeyByteLength"];
const GLOBALE = ["TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error"];
const GLOBALE_WERTE = [TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error];
const { _textBlobKey, _attKeyByteLength } = new Function(...GLOBALE,
  BAUER.map((n) => schnipsel(n)).join("\n") + "\nreturn { " + BAUER.join(", ") + " };")(...GLOBALE_WERTE);

// Die ECHTE gemeinsame Konstante aus dem Quelltext.
const STORES = new Function(
  (index.match(/^const ATTACHMENT_KIND_STORES = .*$/m) || [])[0] + "\nreturn ATTACHMENT_KIND_STORES;")();
const MAX = Number((index.match(/const ATTACHMENT_KEY_MAX_BYTES = (\d+);/) || [, "700"])[1]);
const KINDS = Object.keys(STORES);

// ── Der ECHTE Loeschzweig, ausfuehrbar ─────────────────────────────────
function loeschzweig() {
  const a = index.indexOf('if (action === "delete-file")');
  assert.ok(a > 0, "der delete-file-Zweig wurde nicht gefunden");
  // bis zur SCHLIESSENDEN Klammer des if-Blocks, sonst ist das Fragment kaputt
  const nachReturn = index.indexOf("\n    return;", index.indexOf("toast('ok', 'Gelöscht'", a));
  const ende = index.indexOf("\n  }", nachReturn);
  assert.ok(nachReturn > a && ende > nachReturn, "das Ende des delete-file-Zweigs wurde nicht gefunden");
  return index.slice(a, ende + 4);
}
const ZWEIG = loeschzweig();

// ── 1. Es gibt genau EINE Liste, und beide Zweige lesen sie ────────────
{
  ok(KINDS.length >= 14, `die gemeinsame Liste kennt nur ${KINDS.length} Typen`);
  ok(STORES.invoice === "invoices",
    "invoice fehlt in der gemeinsamen Liste — genau der Typ, an dem es aufflog");

  const render = ohneKommentare(schnipsel("renderFileAttachments"));
  ok(/ATTACHMENT_KIND_STORES\[kind\]/.test(render),
    "renderFileAttachments liest nicht die gemeinsame Liste");
  ok(!/const kindMap = \{ task:/.test(render),
    "renderFileAttachments fuehrt weiterhin eine eigene Liste");

  const a = index.indexOf('if (action === "delete-file")');
  const zweig = ohneKommentare(loeschzweig());
  ok(/window\.ATTACHMENT_KIND_STORES/.test(zweig),
    "der Loeschzweig liest nicht die gemeinsame Liste");
  ok(!/const _km3 = \{/.test(zweig), "der Loeschzweig fuehrt weiterhin eine eigene Liste");
  ok(/window\.ATTACHMENT_KIND_STORES = ATTACHMENT_KIND_STORES;/.test(index),
    "die Liste ist nicht nach window exportiert — der Loeschzweig liegt in einem anderen Skript-Block");
}

function loeschen({ kind = "invoice", entityId = "inv-1", fileIdx = 0, bestaetigen = true,
  storesDa = true, dateiFehlt = false } = {}) {
  const log = { firebaseDeletes: [], puts: [], toasts: [], warn: [], error: [], info: [], saves: 0, renders: 0, confirms: 0 };
  const fileObj = { id: "f_abc_1234", name: "Rechnung.pdf", storagePath: "att/inv-1/f1",
    textExtracted: true, textKey: "attachment-text__invoice__inv-1__f_abc_1234" };
  const entity = { id: entityId, files: dateiFehlt ? [] : [fileObj], updatedAt: "alt" };
  const entities = {};
  if (STORES[kind]) entities[STORES[kind]] = { [entityId]: entity };
  const APP = { state: { data: { entities } } };
  const win = storesDa
    ? { ATTACHMENT_KIND_STORES: STORES, netlifyBlobPut: async (k, v) => { log.puts.push({ key: k, wert: v }); return { ok: true }; },
        _textBlobKey, _attKeyByteLength, ATTACHMENT_KEY_MAX_BYTES: MAX }
    : { netlifyBlobPut: async () => ({ ok: true }), _textBlobKey, _attKeyByteLength, ATTACHMENT_KEY_MAX_BYTES: MAX };

  const fn = new Function("action", "el", "APP", "window", "confirm", "console", "Date",
    "deleteFromFirebase", "scheduleSave", "render", "toast", "parseInt",
    "(function(){ " + ZWEIG + " })();")
  ;
  fn("delete-file", { dataset: { kind, id: entityId, fileIdx: String(fileIdx) } }, APP, win,
    () => { log.confirms++; return bestaetigen; },
    { log: (...a) => log.info.push(a.join(" ")), warn: (...a) => log.warn.push(a.join(" ")), error: (...a) => log.error.push(a.join(" ")) },
    Date,
    (p) => log.firebaseDeletes.push(p),
    () => { log.saves++; },
    () => { log.renders++; },
    (...a) => log.toasts.push(a.join(" ")),
    parseInt);
  return { log, entity, fileObj };
}

// ── 2. Invoice-Regression: die ganze Kette laeuft ──────────────────────
{
  const h = loeschen({ kind: "invoice", entityId: "inv-1" });
  await new Promise((r) => setTimeout(r, 5));
  ok(h.log.confirms === 1, "der Bestaetigungsdialog kam nicht — der Handler kehrte vorher zurueck");
  ok(h.log.firebaseDeletes.length === 1 && h.log.firebaseDeletes[0] === "att/inv-1/f1",
    `die Firebase-Loeschung lief nicht: ${JSON.stringify(h.log.firebaseDeletes)}`);
  ok(h.log.puts.length === 1, `es gab ${h.log.puts.length} Grabstein-Schreibvorgaenge statt einem`);
  ok(h.log.puts[0]?.key === _textBlobKey("invoice", "inv-1", "f_abc_1234"),
    `der Grabstein ging auf ${JSON.stringify(h.log.puts[0]?.key)} statt auf den kanonischen Schluessel`);
  ok(h.log.puts[0]?.wert?.deleted === true, "der Grabstein traegt kein deleted:true");
  ok(h.entity.files.length === 0, "die Datei-Referenz wurde nicht entfernt (splice)");
  ok(h.entity.updatedAt !== "alt", "updatedAt wurde nicht nachgezogen");
  ok(h.log.saves === 1, "scheduleSave lief nicht");
  ok(h.log.renders === 1, "render lief nicht");
  ok(h.log.toasts.some((t) => /Gelöscht/.test(t)), "es gab keine Rueckmeldung");
}

// ── 3. Klassenpruefung: JEDES gerenderte kind ist loeschbar ────────────
for (const kind of KINDS) {
  const h = loeschen({ kind, entityId: "e-1" });
  await new Promise((r) => setTimeout(r, 2));
  ok(h.log.confirms === 1,
    `"${kind}" wird von renderFileAttachments unterstuetzt, hat aber keinen funktionierenden delete-file-Zweig ` +
    "— der Handler kehrt vor dem Bestaetigungsdialog zurueck");
  ok(h.entity.files.length === 0, `"${kind}": die Datei-Referenz wurde nicht entfernt`);
  ok(h.log.saves === 1 && h.log.renders === 1, `"${kind}": scheduleSave/render liefen nicht`);
  ok(h.log.error.length === 0, `"${kind}": es gab einen Fehler: ${JSON.stringify(h.log.error)}`);
}

// ── 4. Unbekanntes kind bricht SICHTBAR ab ─────────────────────────────
{
  const h = loeschen({ kind: "gibtsnicht", entityId: "x" });
  await new Promise((r) => setTimeout(r, 2));
  ok(h.log.error.some((z) => /Anhangtyp gibtsnicht nicht löschbar/.test(z) && /Mapping fehlt/.test(z)),
    `ein unbekanntes kind kehrt still zurueck: ${JSON.stringify(h.log.error)}`);
  ok(h.log.confirms === 0, "bei unbekanntem kind wurde trotzdem gefragt");
  ok(h.log.firebaseDeletes.length === 0 && h.log.puts.length === 0,
    "bei unbekanntem kind wurde trotzdem geschrieben oder geloescht");
}
{
  // fehlender Export ist dieselbe Klasse und faellt ebenso auf
  const h = loeschen({ kind: "invoice", storesDa: false });
  await new Promise((r) => setTimeout(r, 2));
  ok(h.log.error.some((z) => /nicht löschbar/.test(z) && /Mapping fehlt/.test(z)),
    `ein fehlender Export bleibt still: ${JSON.stringify(h.log.error)}`);
  ok(h.log.confirms === 0, "ohne Export wurde trotzdem gefragt");
}

// ── 5. Abbruch und fehlende Datei aendern nichts ───────────────────────
{
  const h = loeschen({ kind: "invoice", bestaetigen: false });
  await new Promise((r) => setTimeout(r, 2));
  ok(h.entity.files.length === 1, "Abbruch im Dialog loeschte trotzdem");
  ok(h.log.puts.length === 0 && h.log.firebaseDeletes.length === 0, "Abbruch schrieb trotzdem");

  const h2 = loeschen({ kind: "invoice", dateiFehlt: true });
  await new Promise((r) => setTimeout(r, 2));
  ok(h2.log.confirms === 0, "fuer eine nicht vorhandene Datei wurde gefragt");
  ok(h2.log.error.length === 0, "eine nicht vorhandene Datei wird als Mapping-Fehler gemeldet");
}

if (luecken.length) {
  console.error("F-25 ATTACHMENT KIND PARITY — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 attachment kind parity: ok (${checks} Pruefungen)`);
