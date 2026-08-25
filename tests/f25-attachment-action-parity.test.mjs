/*
 * F-25 M1d — was angezeigt wird, muss auch bedienbar sein.
 *
 * M1c hat delete-file auf die gemeinsame Liste gehoben. Die anderen Bereiche
 * fuehrten weiter ihre eigenen:
 *   rename-file    _km   9 Typen  — ohne message, email, concept, thesis, invoice
 *   download-file  _km2  9 Typen  — dieselbe Luecke, und der Zweig meldete dann
 *                                   "Datei nicht gefunden": irrefuehrend, denn
 *                                   die Datei war da, nur der Typ fehlte
 *   openFilePreview      14 Typen — vollstaendig, aber ein Duplikat
 *   Upload/Extraktion    14 Typen — NEUNfach dupliziert
 *
 * Ein Rechnungsanhang liess sich also anzeigen und ansehen, aber nicht
 * umbenennen und nicht herunterladen. Seit M1d beziehen alle fuenf Bereiche
 * Kind->Collection aus ATTACHMENT_KIND_STORES, ueber EINEN Aufloeser
 * (attachmentEntity), der bei unbekanntem Typ sichtbar meldet statt still
 * zurueckzukehren.
 *
 * Getestet wird an den ECHTEN Codepfaden aus public/index.html.
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

function funktion(name) {
  const a = index.indexOf("\nfunction " + name + "(");
  assert.ok(a > 0, `${name} wurde nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
// Einen if(action === "x"){…} -Zweig samt schliessender Klammer herausschneiden.
function zweig(name) {
  const a = index.indexOf('if (action === "' + name + '")');
  assert.ok(a > 0, `der Zweig ${name} wurde nicht gefunden`);
  let tiefe = 0, i = index.indexOf("{", a);
  for (let j = i; j < index.length; j++) {
    if (index[j] === "{") tiefe++;
    else if (index[j] === "}") { tiefe--; if (tiefe === 0) return index.slice(a, j + 1); }
  }
  assert.fail(`das Ende von ${name} wurde nicht gefunden`);
}

const STORES = new Function(
  (index.match(/^const ATTACHMENT_KIND_STORES = .*$/m) || [])[0] + "\nreturn ATTACHMENT_KIND_STORES;")();
const KINDS = Object.keys(STORES);
const AUFLOESER = funktion("attachmentStoreFor") + "\n" + funktion("attachmentEntity");

const BAUER = ["_attSegEncode", "_attSegDecode", "_textBlobKey", "_attKeyByteLength"];
const GLOBALE = ["TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error"];
const GLOBALE_WERTE = [TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error];
const { _textBlobKey, _attKeyByteLength } = new Function(...GLOBALE,
  BAUER.map((n) => {
    const a = index.indexOf("\nfunction " + n + "(");
    return index.slice(a, index.indexOf("\n}\n", a) + 3);
  }).join("\n") + "\nreturn { " + BAUER.join(", ") + " };")(...GLOBALE_WERTE);
const MAX = Number((index.match(/const ATTACHMENT_KEY_MAX_BYTES = (\d+);/) || [, "700"])[1]);

// ── Eine Welt: Entitaet mit genau einer Datei, alle Wirkungen protokolliert ──
function welt({ kind = "invoice", entityId = "e-1", auflosungDa = true, neuerName = "Neu" } = {}) {
  const log = { fbDeletes: [], puts: [], toasts: [], error: [], info: [], warn: [],
    saves: 0, renders: 0, confirms: 0, prompts: 0, downloads: [], previews: 0 };
  const fileObj = { id: "f_abc_1234", name: "Rechnung.pdf", url: "https://x/r.pdf",
    storagePath: "att/e-1/f1", textExtracted: true, textKey: "alt" };
  const entity = { id: entityId, files: [fileObj], updatedAt: "alt" };
  const entities = {};
  if (STORES[kind]) entities[STORES[kind]] = { [entityId]: entity };
  const APP = { state: { data: { entities } } };
  const konsole = {
    log: (...a) => log.info.push(a.join(" ")),
    warn: (...a) => log.warn.push(a.join(" ")),
    error: (...a) => log.error.push(a.join(" ")),
  };
  // Der ECHTE Aufloeser, in derselben Welt.
  const aufloeser = new Function("APP", "ATTACHMENT_KIND_STORES", "console",
    AUFLOESER + "\nreturn { attachmentStoreFor, attachmentEntity };")(APP, STORES, konsole);
  const win = auflosungDa
    ? { ...aufloeser, ATTACHMENT_KIND_STORES: STORES,
        netlifyBlobPut: async (k, v) => { log.puts.push({ key: k, wert: v }); return { ok: true }; },
        _textBlobKey, _attKeyByteLength, ATTACHMENT_KEY_MAX_BYTES: MAX }
    : { netlifyBlobPut: async () => ({ ok: true }), _textBlobKey, _attKeyByteLength, ATTACHMENT_KEY_MAX_BYTES: MAX };

  const el = { dataset: { kind, id: entityId, fileIdx: "0" } };
  const lauf = (quelle, extraNamen = [], extraWerte = []) => {
    // e ist das Klick-Ereignis des echten Handlers (preventDefault/stopPropagation).
    const fn = new Function("action", "el", "e", "APP", "window", "confirm", "prompt", "console", "Date",
      "deleteFromFirebase", "scheduleSave", "render", "toast", "parseInt", "firebaseStorage",
      "openFilePreview", "fetch", "document", "setTimeout", ...extraNamen,
      "(function(){ " + quelle + " })();");
    fn("__", el, { preventDefault() {}, stopPropagation() {} }, APP, win,
      () => { log.confirms++; return true; },
      () => { log.prompts++; return neuerName; },
      konsole, Date,
      (p) => log.fbDeletes.push(p),
      () => { log.saves++; }, () => { log.renders++; },
      (...a) => log.toasts.push(a.join(" ")), parseInt,
      null,
      (k, i, f) => { log.previews++; },
      async () => { throw new Error("kein Netz im Test"); },
      { getElementById: () => null, createElement: () => ({ style: {}, click() {} }), body: { appendChild() {} } },
      (f) => f(), ...extraWerte);
  };
  return { log, entity, fileObj, APP, win, el, lauf, aufloeser, konsole };
}

// Die vier Zweige, jeweils mit dem passenden action-Wert scharfgeschaltet.
const ZWEIGE = {
  preview: zweig("preview-file"),
  rename: zweig("rename-file"),
  download: zweig("download-file"),
  delete: zweig("delete-file"),
};
const alsAktion = (name, quelle) => quelle.replace('if (action === "' + name + '")', "if (true)");

// ── 1. AKTIONSMATRIX: 14 Kinds x 4 Aktionen ────────────────────────────
for (const kind of KINDS) {
  // Vorschau
  {
    const w = welt({ kind });
    w.lauf(alsAktion("preview-file", ZWEIGE.preview));
    ok(w.log.previews === 1, `${kind}/preview: openFilePreview wurde nicht erreicht`);
  }
  // Umbenennen
  {
    const w = welt({ kind, neuerName: "Umbenannt" });
    w.lauf(alsAktion("rename-file", ZWEIGE.rename));
    ok(w.log.prompts === 1,
      `${kind}/rename: der Handler kehrte vor dem Dialog zurueck — das Mapping fehlt`);
    ok(w.entity.files[0].name === "Umbenannt.pdf",
      `${kind}/rename: der Name wurde nicht geaendert (${w.entity.files[0].name})`);
    ok(w.entity.updatedAt !== "alt", `${kind}/rename: updatedAt wurde nicht nachgezogen`);
    ok(w.log.saves === 1 && w.log.renders === 1, `${kind}/rename: scheduleSave/render liefen nicht`);
    ok(w.log.error.length === 0, `${kind}/rename: Fehler ${JSON.stringify(w.log.error)}`);
  }
  // Herunterladen
  {
    const w = welt({ kind });
    w.lauf(alsAktion("download-file", ZWEIGE.download));
    ok(!w.log.toasts.some((t) => /Datei nicht gefunden/.test(t)),
      `${kind}/download: "Datei nicht gefunden" — die Datei ist da, das Mapping fehlt`);
    ok(w.log.toasts.some((t) => /Download startet/.test(t)),
      `${kind}/download: der Downloadpfad wurde nicht erreicht: ${JSON.stringify(w.log.toasts)}`);
    ok(w.log.error.length === 0, `${kind}/download: Fehler ${JSON.stringify(w.log.error)}`);
  }
  // Loeschen
  {
    const w = welt({ kind });
    w.lauf(alsAktion("delete-file", ZWEIGE.delete));
    await new Promise((r) => setTimeout(r, 2));
    ok(w.log.confirms === 1, `${kind}/delete: der Handler kehrte vor dem Dialog zurueck`);
    ok(w.entity.files.length === 0, `${kind}/delete: die Datei-Referenz blieb stehen`);
    ok(w.log.saves === 1 && w.log.renders === 1, `${kind}/delete: scheduleSave/render liefen nicht`);
  }
}

// ── 2. Invoice end-to-end, jede Aktion einzeln nachgemessen ────────────
{
  // umbenennen
  const w1 = welt({ kind: "invoice", neuerName: "Rechnung 2026-08" });
  w1.lauf(alsAktion("rename-file", ZWEIGE.rename));
  ok(w1.entity.files[0].name === "Rechnung 2026-08.pdf",
    `invoice/rename: ${w1.entity.files[0].name}`);
  ok(w1.log.saves === 1 && w1.log.renders === 1, "invoice/rename: save/render fehlten");
  ok(w1.log.toasts.some((t) => /Umbenannt/.test(t)), "invoice/rename: keine Rueckmeldung");

  // herunterladen
  const w2 = welt({ kind: "invoice" });
  w2.lauf(alsAktion("download-file", ZWEIGE.download));
  ok(w2.log.toasts.some((t) => /Download startet/.test(t)),
    `invoice/download: ${JSON.stringify(w2.log.toasts)}`);

  // loeschen
  const w3 = welt({ kind: "invoice" });
  w3.lauf(alsAktion("delete-file", ZWEIGE.delete));
  await new Promise((r) => setTimeout(r, 5));
  ok(w3.log.confirms === 1, "invoice/delete: kein Bestaetigungsdialog");
  ok(w3.log.fbDeletes.length === 1 && w3.log.fbDeletes[0] === "att/e-1/f1",
    `invoice/delete: Firebase-Loeschung ${JSON.stringify(w3.log.fbDeletes)}`);
  ok(w3.log.puts.length === 1 && w3.log.puts[0].key === _textBlobKey("invoice", "e-1", "f_abc_1234"),
    `invoice/delete: der Grabstein ging auf ${JSON.stringify(w3.log.puts[0]?.key)}`);
  ok(w3.log.puts[0]?.wert?.deleted === true, "invoice/delete: kein deleted:true im Grabstein");
  ok(w3.entity.files.length === 0, "invoice/delete: kein splice");
  ok(w3.log.saves === 1 && w3.log.renders === 1, "invoice/delete: save/render fehlten");

  // Vorschau
  const w4 = welt({ kind: "invoice" });
  w4.lauf(alsAktion("preview-file", ZWEIGE.preview));
  ok(w4.log.previews === 1, "invoice/preview: openFilePreview wurde nicht erreicht");
}

// ── 3. Unbekanntes kind: sichtbar in ALLEN Bereichen ───────────────────
{
  const meldung = /Anhangtyp gibtsnicht nicht unterstützt — Mapping fehlt/;
  for (const [name, quelle] of [["rename", ZWEIGE.rename], ["download", ZWEIGE.download], ["delete", ZWEIGE.delete]]) {
    const w = welt({ kind: "gibtsnicht" });
    w.lauf(alsAktion(name + "-file", quelle));
    await new Promise((r) => setTimeout(r, 2));
    ok(w.log.error.some((z) => meldung.test(z)),
      `${name}: ein unbekanntes kind kehrt still zurueck: ${JSON.stringify(w.log.error)}`);
    ok(!w.log.toasts.some((t) => /Datei nicht gefunden/.test(t)),
      `${name}: es wird weiterhin irrefuehrend "Datei nicht gefunden" gemeldet`);
  }
  // Aufloeser selbst, und damit renderFileAttachments und openFilePreview
  const w = welt({ kind: "invoice" });
  ok(w.aufloeser.attachmentEntity("gibtsnicht", "x", "anzeigen") === null,
    "der Aufloeser meldet ein unbekanntes kind nicht als null");
  ok(w.log.error.some((z) => meldung.test(z)),
    `der Aufloeser schweigt bei unbekanntem kind: ${JSON.stringify(w.log.error)}`);
  ok(w.aufloeser.attachmentStoreFor("invoice") === "invoices",
    "der Aufloeser findet einen bekannten Typ nicht");

  // fehlender Export faellt ebenfalls auf
  for (const [name, quelle] of [["rename", ZWEIGE.rename], ["download", ZWEIGE.download], ["delete", ZWEIGE.delete]]) {
    const w2 = welt({ kind: "invoice", auflosungDa: false });
    w2.lauf(alsAktion(name + "-file", quelle));
    ok(w2.log.error.some((z) => /nicht unterstützt — Mapping fehlt/.test(z)),
      `${name}: ein fehlender Export bleibt still`);
  }
}

// ── 4. Ein-Quellen-Waechter ────────────────────────────────────────────
{
  // Alle fuenf Bereiche lesen die gemeinsame Liste, keiner baut eine eigene.
  const bereiche = {
    renderFileAttachments: ohneKommentare(funktion("renderFileAttachments")),
    openFilePreview: ohneKommentare(funktion("openFilePreview")),
    "rename-file": ohneKommentare(ZWEIGE.rename),
    "download-file": ohneKommentare(ZWEIGE.download),
    "delete-file": ohneKommentare(ZWEIGE.delete),
  };
  for (const [name, src] of Object.entries(bereiche)) {
    ok(/attachmentEntity\(/.test(src), `${name} geht nicht ueber den gemeinsamen Aufloeser`);
    ok(!/task\s*:\s*['"]tasks['"]/.test(src), `${name} baut weiterhin eine eigene Kind-Liste`);
  }
  ok(!/\b_km\b|\b_km2\b|\b_km3\b/.test(index),
    "es gibt weiterhin eine private _km/_km2/_km3-Karte");

  // Der Waechter deckt die ANHANG-Codepfade ab, nicht jede Liste im Repo.
  // Fachfremde Mappings duerfen bleiben — _DRV_KINDMAP (Drive), ENT_PLURAL
  // (Verweise), Agent-Routing. Sie werden namentlich zugelassen; alles andere
  // mit Anhangs-Signatur ist ein neues Duplikat und muss auffallen.
  const ERLAUBTE_FREMDE = ["_DRV_KINDMAP"];
  const anhangSignatur = /message\s*:\s*['"]scheduledMessages['"][\s\S]{0,160}?email\s*:\s*['"]emails['"]/;
  const treffer = index.split("\n")
    .map((z, i) => [i + 1, z.trim()])
    .filter(([, z]) => anhangSignatur.test(z))
    .filter(([, z]) => !/^const ATTACHMENT_KIND_STORES = /.test(z))
    .filter(([, z]) => !ERLAUBTE_FREMDE.some((n) => z.includes(n)));
  ok(treffer.length === 0,
    "Attachment-Kind-Listen ausserhalb von ATTACHMENT_KIND_STORES: " +
    treffer.map(([n, z]) => `${n}: ${z.slice(0, 70)}`).join(" | "));
  // Und die zugelassenen Fremden sind wirklich fachfremd: keine von ihnen darf
  // in einem der fuenf Anhang-Bereiche auftauchen.
  for (const name of ERLAUBTE_FREMDE) {
    for (const [bereich, src] of Object.entries(bereiche)) {
      ok(!src.includes(name), `${name} wird im Anhang-Bereich ${bereich} benutzt`);
    }
  }

  // Die acht mechanisch ersetzten Stellen sind reine Referenzen
  const aliase = (index.match(/^ +const kindMap = ATTACHMENT_KIND_STORES;/gm) || []).length;
  ok(aliase === 8, `es gibt ${aliase} Alias-Zeilen statt acht`);
  ok(!/const kindMap = \{ task:/.test(index), "es gibt weiterhin eine kindMap-Kopie mit Literal");

  // Fachfremde Mappings sind ausdruecklich NICHT verboten
  ok(/_DRV_KINDMAP/.test(index), "das Drive-Mapping wurde faelschlich mitentfernt");
  ok(/ENT_PLURAL/.test(index), "ein fachfremdes Routing-Mapping wurde faelschlich mitentfernt");
}

if (luecken.length) {
  console.error("F-25 ATTACHMENT ACTION PARITY — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 attachment action parity: ok (${checks} Pruefungen)`);
