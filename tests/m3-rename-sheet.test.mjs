/*
 * M3 — Datei umbenennen ohne nativen prompt().
 *
 * PRODUKTIONSBEFUND (live, https://management-xo2-pro.netlify.app/, Task
 * b2d07c59-…, Anhang f_mtaby02w_ijv0): window._renameFile rief
 * prompt('Neuer Dateiname (ohne Endung):', baseName). Ein nativer Dialog haelt
 * den gesamten Renderer an — auf Telefon und Tablet ist er weder gestaltbar
 * noch zuverlaessig bedienbar, und er blockiert jede Fernsteuerung
 * vollstaendig. Genau daran ist die Live-Bedienung haengengeblieben.
 *
 * Zweitens war das Ziel eine POSITION (idx). Waehrend ein Dialog offen ist,
 * kann ein Abgleich APP.state.data komplett ersetzen; die Position zeigt dann
 * auf eine andere Datei. Dieselbe Klasse Fehler wie im Loeschpfad (F-25).
 *
 * Geprueft wird gegen die ECHTEN Artefakte: splitDateiname, openRenameSheet und
 * _renameFile laufen als echte Funktionen gegen DOM-Attrappen; das
 * Blatt-CSS wird aus den ausgelieferten <style>-Bloecken geparst.
 *
 * Die nativen Dialoge sind in der Attrappe VERMINT: prompt, alert und confirm
 * werfen. Ruft der Pfad sie doch, faellt der Test — nicht der Quelltext wird
 * gelesen, sondern das Verhalten gemessen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ═══ CSS aus den <style>-Bloecken ════════════════════════════════════════
const CSS = (index.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
  .map((b) => b.replace(/^<style[^>]*>/i, "").replace(/<\/style>$/i, "")).join("\n");
ok(CSS.length > 10000, `die <style>-Bloecke wurden nicht gelesen (${CSS.length} Zeichen)`);

function regelnLesen(css) {
  const regeln = []; let ordnung = 0;
  (function block(text, medienBreite) {
    let j = 0;
    while (j < text.length) {
      const auf = text.indexOf("{", j);
      if (auf < 0) break;
      const kopf = text.slice(j, auf).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      let tiefe = 1, k = auf + 1;
      while (k < text.length && tiefe > 0) { if (text[k] === "{") tiefe++; else if (text[k] === "}") tiefe--; k++; }
      const inhalt = text.slice(auf + 1, k - 1);
      if (kopf.startsWith("@media")) {
        const mm = /max-width\s*:\s*(\d+)px/.exec(kopf);
        block(inhalt, mm ? Number(mm[1]) : medienBreite);
      } else if (!kopf.startsWith("@") && kopf) {
        for (const sel of kopf.split(",")) {
          const t = sel.trim();
          if (t) regeln.push({ selektor: t, deklarationen: inhalt, medienBreite: medienBreite ?? null, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  })(css, null);
  return regeln;
}
const REGELN = regelnLesen(CSS);
function eigenschaft(dekl, name) {
  const m = new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([^;]+)", "i")
    .exec(dekl.replace(/\/\*[\s\S]*?\*\//g, ""));
  return m ? m[1].trim() : null;
}
// Der Selektor wird hier EXAKT verglichen — die Blatt-Klassen sind eindeutig
// und kommen nirgends sonst vor, eine Kaskadensimulation waere Zierrat.
function aufloesen(selektor, name, breite) {
  let sieger = null;
  for (const r of REGELN) {
    if (r.selektor !== selektor) continue;
    if (r.medienBreite !== null && breite > r.medienBreite) continue;
    const wert = eigenschaft(r.deklarationen, name);
    if (wert === null) continue;
    if (!sieger || r.ordnung > sieger.ordnung) sieger = { wert, ordnung: r.ordnung, media: r.medienBreite };
  }
  return sieger;
}
const zahl = (v) => (v == null ? NaN : parseFloat(String(v)));
// Auf einem Stand ohne Blatt gibt es die Knoepfe nicht. Ein direkter Aufruf
// beendete den ganzen Lauf mit einer TypeError — rot aus dem falschen Grund.
const klick = (knoten, was) => {
  if (!knoten || typeof knoten.onclick !== "function") { ok(false, `${was}: es gibt kein Bedienelement`); return false; }
  knoten.onclick();
  return true;
};

// ═══ 1. CSS-VERTRAG ═════════════════════════════════════════════════════
for (const breite of [390, 820, 1180, 1440]) {
  const schmal = breite <= 900;

  // Touch-Ziele
  const bh = zahl(aufloesen(".qs-sheet-actions button", "min-height", breite)?.wert);
  ok(bh >= 44, `${breite}: die Blatt-Knoepfe sind ${bh} px hoch — unter dem Mindestmass 44`);
  const ih = zahl(aufloesen(".qs-sheet-row input", "height", breite)?.wert);
  ok(ih >= 44, `${breite}: das Eingabefeld ist ${ih} px hoch — unter dem Mindestmass 44`);

  // Kein horizontaler Ueberlauf: begrenzte Breite, box-sizing, schrumpfbares Feld
  const w = aufloesen(".qs-sheet", "width", breite);
  ok(w && /min\(\s*520px\s*,\s*100%\s*\)/.test(w.wert),
    `${breite}: .qs-sheet ist "${w && w.wert}" statt min(520px,100%) — es kann breiter werden als der Viewport`);
  ok(aufloesen(".qs-sheet", "box-sizing", breite)?.wert === "border-box",
    `${breite}: .qs-sheet rechnet das Polster nicht in die Breite ein`);
  ok(aufloesen(".qs-sheet-row input", "min-width", breite)?.wert === "0",
    `${breite}: das Eingabefeld hat kein min-width:0 — ein langer Name sprengt die Zeile`);
  ok(aufloesen(".qs-sheet-row input", "box-sizing", breite)?.wert === "border-box",
    `${breite}: das Eingabefeld rechnet sein Polster nicht ein`);

  // Die Tastatur kommt von UNTEN. Das Blatt wird oben angedockt, nie zentriert
  // oder unten — sonst verdeckt sie Speichern und Abbrechen.
  ok(aufloesen(".qs-sheet-back", "align-items", breite)?.wert === "flex-start",
    `${breite}: das Blatt ist nicht oben angedockt — die Bildschirmtastatur verdeckt die Knoepfe`);
  ok(aufloesen(".qs-sheet-back", "overflow-y", breite)?.wert === "auto",
    `${breite}: das Blatt kann bei kleiner Hoehe nicht gescrollt werden`);

  const mt = aufloesen(".qs-sheet", "margin-top", breite);
  if (schmal) {
    ok(mt && /^\d+px$/.test(mt.wert) && zahl(mt.wert) <= 24,
      `${breite}: der Abstand von oben ist "${mt && mt.wert}" — schmal muss das Blatt weit oben stehen`);
    ok(aufloesen(".qs-sheet-actions button", "width", breite)?.wert === "100%",
      `${breite}: die Knoepfe sind schmal nicht ueber die volle Breite gezogen`);
  } else {
    ok(aufloesen(".qs-sheet-actions button", "width", breite) === null,
      `${breite}: eine Breitenregel fuer die Knoepfe wirkt bis auf den Desktop`);
  }
  // Sichtbarkeit wird ueber .open geschaltet, nie ueber !important.
  ok(aufloesen(".qs-sheet-back", "display", breite)?.wert === "none",
    `${breite}: das Blatt ist ohne .open sichtbar`);
  ok(aufloesen(".qs-sheet-back.open", "display", breite)?.wert === "flex",
    `${breite}: .open oeffnet das Blatt nicht`);
}
{
  const eigene = REGELN.filter((r) => r.selektor.indexOf(".qs-sheet") === 0);
  ok(eigene.length >= 8, `nur ${eigene.length} Blatt-Regeln gefunden`);
  for (const r of eigene) {
    ok(!/!important/.test(r.deklarationen.replace(/\/\*[\s\S]*?\*\//g, "")),
      `die Blatt-Regel "${r.selektor}" arbeitet mit !important`);
  }
  // Der gemeinsame Modal-Behaelter bleibt unangetastet.
  ok(!eigene.some((r) => /modal/.test(r.selektor)),
    "das Blatt haengt sich in die gemeinsamen Modal-Regeln");
}

// ═══ 1b. DIE AKTIONSKNOEPFE SELBST (Codex-Live-Gegencheck) ═════════════
// Live gemessen: [title="Umbenennen"] misst 28,5 x 24,7 px — bei 390, bei 820
// und auf dem Desktop. Das Blatt nuetzt nichts, wenn der Daumen den Knopf
// nicht trifft, der es oeffnet. Schmal also >=44 px, Desktop unveraendert.
for (const breite of [390, 820]) {
  for (const sel of [".file-item .file-actions button", ".file-actions button"]) {
    const w = zahl(aufloesen(sel, "min-width", breite)?.wert);
    const h = zahl(aufloesen(sel, "min-height", breite)?.wert);
    ok(w >= 44, `${breite}: "${sel}" ist ${w} px breit — der Umbenennen-Knopf bleibt untreffbar`);
    ok(h >= 44, `${breite}: "${sel}" ist ${h} px hoch — der Umbenennen-Knopf bleibt untreffbar`);
  }
  ok(zahl(aufloesen(".file-item .file-actions select", "min-height", breite)?.wert) >= 44,
    `${breite}: die Ordner-Auswahl in derselben Reihe ist niedriger als 44 px`);

  // Fuenf Knoepfe a 44 px passen bei 390 nicht in eine Zeile. Sie MUESSEN
  // umbrechen duerfen, sonst waechst die Zeile ueber den Rand und die Wurzel
  // bekommt genau die horizontale Kante, die live nicht auftreten darf.
  ok(aufloesen(".file-item", "flex-wrap", breite)?.wert === "wrap",
    `${breite}: .file-item darf nicht umbrechen — die Aktionsreihe sprengt die Breite`);
  ok(aufloesen(".file-item .file-actions", "flex-wrap", breite)?.wert === "wrap",
    `${breite}: .file-actions darf nicht umbrechen`);
  const fs = aufloesen(".file-item .file-actions", "flex-shrink", breite);
  ok(fs && fs.wert !== "0",
    `${breite}: .file-actions steht auf flex-shrink:${fs && fs.wert} — die Gruppe kann nicht nachgeben`);
  ok(aufloesen(".file-item .file-actions", "min-width", breite)?.wert === "0",
    `${breite}: .file-actions hat kein min-width:0`);
}
for (const breite of [1180, 1440]) {
  for (const sel of [".file-item .file-actions button", ".file-actions button"]) {
    ok(aufloesen(sel, "min-width", breite) === null,
      `${breite}: "${sel}" bekommt eine Mindestbreite — Desktopregression gegenueber den gemessenen 28,5 px`);
    ok(aufloesen(sel, "min-height", breite) === null,
      `${breite}: "${sel}" bekommt eine Mindesthoehe — Desktopregression`);
  }
  ok(aufloesen(".file-item", "flex-wrap", breite) === null,
    `${breite}: .file-item bricht auf dem Desktop um — die Zeile war einzeilig`);
  ok(aufloesen(".file-item .file-actions", "flex-wrap", breite) === null,
    `${breite}: .file-actions bricht auf dem Desktop um`);
}

// ═══ 2. splitDateiname — die echte Funktion ═════════════════════════════
{
  const a = index.indexOf("function splitDateiname(name) {");
  ok(a > 0, "splitDateiname wurde nicht gefunden");
  if (a > 0) {
    const split = new Function("String",
      index.slice(a, index.indexOf("\n}\n", a) + 3) + "\nreturn splitDateiname;")(String);
    const F = [
      ["s3-attachment-20260825-2357.txt", "s3-attachment-20260825-2357", ".txt"],
      ["ohne-endung", "ohne-endung", ""],
      [".gitignore", ".gitignore", ""],          // fuehrender Punkt ist keine Endung
      ["a.b.c.pdf", "a.b.c", ".pdf"],
      ["", "", ""],
      [null, "", ""],
    ];
    for (const [ein, basis, endung] of F) {
      const r = split(ein);
      ok(r.basis === basis && r.endung === endung,
        `splitDateiname(${JSON.stringify(ein)}) = ${JSON.stringify(r)} statt {basis:"${basis}",endung:"${endung}"}`);
    }
  }
}

// ═══ 3. DIE ECHTEN FUNKTIONEN GEGEN DOM-ATTRAPPEN ══════════════════════
const DATEI_ID = "f_mtaby02w_ijv0";
const START_NAME = "s3-attachment-20260825-2357.txt";
const ZIEL_NAME = "s3-attachment-20260825-2357-RENAMED.txt";

function welt({ dateien = null } = {}) {
  const protokoll = { scheduleSave: 0, render: 0, toasts: [], fokus: [], nativ: [] };
  const knoten = {};
  const machKnoten = (id) => ({
    id, value: "", textContent: "", hidden: false, onclick: null,
    focus() { protokoll.fokus.push(this.id); welt._aktiv = this; },
    select() {},
  });
  for (const id of ["qsRenameInput", "qsRenameErr", "qsRenameCancel", "qsRenameSave"]) knoten[id] = machKnoten(id);
  const ausloeser = machKnoten("ausloeser");

  const koerper = { kinder: [] };
  let hoerer = [];
  let blatt = null;
  const dokument = {
    activeElement: ausloeser,
    createElement() {
      const el = {
        className: "", id: "", onclick: null,
        // Der Browser parst das Markup und traegt value=".." ins Feld ein.
        // Die Attrappe muss dasselbe tun, sonst pruefte der Test eine
        // Vorbelegung, die er selbst nie zugestellt hat.
        set innerHTML(html) {
          this._html = html;
          const m = /id="qsRenameInput"[\s\S]*?value="([^"]*)"/.exec(html);
          if (m) knoten.qsRenameInput.value = m[1];
          const t = /class="qs-sheet-ext"[^>]*>([^<]*)</.exec(html);
          el._suffixText = t ? t[1] : "";
        },
        get innerHTML() { return this._html || ""; },
        classList: { klassen: new Set(), add(k) { this.klassen.add(k); }, remove(k) { this.klassen.delete(k); },
          contains(k) { return this.klassen.has(k); } },
        querySelector(sel) { return knoten[String(sel).replace("#", "")] || null; },
        remove() { koerper.kinder = koerper.kinder.filter((k) => k !== el); if (blatt === el) blatt = null; },
      };
      return el;
    },
    body: { appendChild(el) { koerper.kinder.push(el); blatt = el; } },
    getElementById(id) { return id === "qsRenameSheet" ? blatt : (knoten[id] || null); },
    addEventListener(typ, fn, capture) { if (typ === "keydown") hoerer.push(fn); },
    removeEventListener(typ, fn) { hoerer = hoerer.filter((h) => h !== fn); },
  };
  Object.defineProperty(dokument, "activeElement", {
    get() { return welt._aktiv || ausloeser; }, configurable: true,
  });
  welt._aktiv = ausloeser;

  const datei = dateien || [{
    id: DATEI_ID, name: START_NAME, size: 42, type: "text/plain",
    textKey: "attachment-text__tasks__b2d07c59__" + DATEI_ID,
    textExtractStatus: "done", textExtracted: true, textChars: 17,
    storagePath: "uploads/tasks/b2d07c59/" + DATEI_ID + ".txt",
    url: "https://firebasestorage/…", uploadedAt: "2026-08-25T23:57:00.000Z",
  }];
  const entity = { id: "b2d07c59", files: datei, updatedAt: "2026-08-25T23:57:00.000Z" };
  const APP = { state: { data: { entities: { tasks: { b2d07c59: entity } } } } };

  // Die echten Funktionen — nur der Transport ist Attrappe.
  const holen = (kopf) => {
    const a = index.indexOf(kopf);
    if (a < 0) return "";
    const e = index.indexOf("\n};\n", a);
    return e > a ? index.slice(a, e + 4) : index.slice(a, index.indexOf("\n}\n", a) + 3);
  };
  const quelle = index.slice(index.indexOf("function splitDateiname(name) {"),
      index.indexOf("\n}\n", index.indexOf("function splitDateiname(name) {")) + 3) +
    "\n" + holen("function openRenameSheet(opt) {") +
    "\n" + holen("window._renameFile = function(kind, entityId, idx) {") +
    "\nreturn { openRenameSheet: typeof openRenameSheet === 'function' ? openRenameSheet : null," +
    " _renameFile: (typeof window !== 'undefined' && window._renameFile) || null," +
    " splitDateiname: typeof splitDateiname === 'function' ? splitDateiname : null };";

  // Die nativen Dialoge werden PROTOKOLLIERT, nicht geworfen. Ein Wurf haette
  // den ganzen Lauf beendet — der alte Stand waere rot gewesen, ohne je sein
  // Verhalten zu zeigen. So laeuft er echt weiter, und protokoll.nativ ist der
  // Beweis. prompt gibt zurueck, was im Feld steht: der Nutzer, der tippt.
  const nativ = (name) => (nachricht, vorgabe) => {
    protokoll.nativ.push(name);
    if (name !== "prompt") return true;
    const v = knoten.qsRenameInput.value;
    return v === "" ? (vorgabe === undefined ? null : vorgabe) : v;
  };
  const api = new Function(
    "document", "APP", "ATTACHMENT_KIND_STORES", "esc", "toast", "scheduleSave", "render",
    "window", "prompt", "alert", "confirm", "Date", "String", "Array", "Object", "Error", "console",
    quelle)(
    dokument, APP, { task: "tasks" }, (x) => String(x == null ? "" : x), (a, b, c) => protokoll.toasts.push([a, b, c].join("|")),
    () => { protokoll.scheduleSave++; }, () => { protokoll.render++; },
    (() => { const w = {}; return w; })(),
    nativ("prompt"), nativ("alert"), nativ("confirm"),
    Date, String, Array, Object, Error, { log() {}, warn() {}, error() {} });

  const taste = (key, ziel) => hoerer.forEach((h) => h({
    key, target: ziel || knoten.qsRenameInput,
    preventDefault() {}, stopPropagation() {},
  }));
  const vorZustand = JSON.parse(JSON.stringify(APP.state.data));
  return { api, protokoll, knoten, entity, APP, taste, ausloeser, vorZustand,
    blattOffen: () => !!blatt, hoererZahl: () => hoerer.length };
}

// ── 3a. Oeffnen: Vorbelegung, Endung, Fokus, kein nativer Dialog ────────
{
  const w = welt();
  ok(!!w.api._renameFile, "window._renameFile wurde nicht geladen");
  ok(!!w.api.openRenameSheet, "openRenameSheet existiert nicht — es gibt kein app-eigenes Blatt");
  // NUR auf _renameFile pruefen. Haenge ich den Block zusaetzlich an
  // openRenameSheet, ueberspringt der alte Stand — wo es das Blatt nicht gibt —
  // ausgerechnet den wichtigsten Nachweis: dass er prompt() ruft.
  if (w.api._renameFile) {
    w.api._renameFile("task", "b2d07c59", 0);
    ok(w.protokoll.nativ.length === 0,
      `DER BEFUND: der Pfad rief einen nativen Dialog (${w.protokoll.nativ.join(",")})`);
    ok(w.blattOffen(), "das Blatt wurde nicht geoeffnet");
    ok(w.knoten.qsRenameInput.value === "s3-attachment-20260825-2357",
      `das Feld ist mit "${w.knoten.qsRenameInput.value}" vorbelegt — erwartet der Basisname OHNE Endung`);
    ok(w.protokoll.fokus[0] === "qsRenameInput",
      `beim Oeffnen bekam "${w.protokoll.fokus[0]}" den Fokus statt des Eingabefelds`);
    ok(w.protokoll.scheduleSave === 0, "das blosse Oeffnen loeste einen Schreibvorgang aus");
  }
}

// ── 3b. Speichern per Enter: genau diese Datei, genau ein Schreibweg ────
{
  const w = welt();
  if (w.api._renameFile) {
    const vorher = JSON.parse(JSON.stringify(w.entity.files[0]));
    w.api._renameFile("task", "b2d07c59", 0);
    w.knoten.qsRenameInput.value = "s3-attachment-20260825-2357-RENAMED";
    w.taste("Enter");

    const f = w.entity.files[0];
    ok(f.name === ZIEL_NAME, `der Name ist "${f.name}" statt "${ZIEL_NAME}"`);
    ok(w.entity.files.length === 1, `es liegen ${w.entity.files.length} Anhaenge statt genau einem`);
    for (const feld of ["id", "textKey", "textExtractStatus", "textExtracted", "textChars",
      "storagePath", "url", "size", "type", "uploadedAt"]) {
      ok(f[feld] === vorher[feld],
        `${feld} wurde veraendert: ${JSON.stringify(vorher[feld])} -> ${JSON.stringify(f[feld])}`);
    }
    ok(w.entity.updatedAt !== vorher.uploadedAt && typeof w.entity.updatedAt === "string",
      "updatedAt der Entitaet wurde nicht nachgezogen");
    ok(w.protokoll.scheduleSave === 1,
      `scheduleSave lief ${w.protokoll.scheduleSave}x — erwartet genau einmal (ein Trichter, kein Duplikat)`);
    ok(w.protokoll.render === 1, `render lief ${w.protokoll.render}x`);
    ok(!w.blattOffen(), "das Blatt blieb nach dem Speichern offen");
    ok(w.protokoll.fokus[w.protokoll.fokus.length - 1] === "ausloeser",
      "der Fokus kam nicht zum Ausloeser zurueck");
    ok(w.hoererZahl() === 0, "der Tastatur-Hoerer wurde nicht abgemeldet — er wirkt in der ganzen App weiter");
    ok(w.protokoll.nativ.length === 0, "es lief ein nativer Dialog");

    // Reload-Persistenz: der Stand muss den JSON-Umlauf ueberstehen.
    const nachReload = JSON.parse(JSON.stringify(w.APP.state.data));
    const gf = nachReload.entities.tasks.b2d07c59.files;
    ok(gf.length === 1 && gf[0].name === ZIEL_NAME && gf[0].id === DATEI_ID,
      `nach dem Neuladen: ${gf.length} Datei(en), Name "${gf[0] && gf[0].name}", Id "${gf[0] && gf[0].id}"`);
    ok(gf[0].textKey === vorher.textKey, "der Indexierungsschluessel ueberlebt das Neuladen nicht");

    // KEINE ZWEITE MUTATION. scheduleSave faehrt einen Vollschnappschuss samt
    // Pull-vor-Push und CAS — was hier sonst noch am Baum haengt, ginge mit.
    // Verglichen wird deshalb der GANZE Baum, nicht nur die Datei.
    const abweichungen = [];
    (function vergleiche(a, b, pfad) {
      const schluessel = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      for (const k of schluessel) {
        const va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
        const pf = pfad + "." + k;
        if (va && vb && typeof va === "object" && typeof vb === "object") { vergleiche(va, vb, pf); continue; }
        if (va !== vb) abweichungen.push(pf);
      }
    })(w.vorZustand, JSON.parse(JSON.stringify(w.APP.state.data)), "data");
    abweichungen.sort();
    ok(abweichungen.length === 2,
      `${abweichungen.length} Felder haben sich geaendert (${abweichungen.join(", ")}) — erwartet genau zwei`);
    ok(abweichungen.join(",") === "data.entities.tasks.b2d07c59.files.0.name,data.entities.tasks.b2d07c59.updatedAt",
      `geaendert wurden: ${abweichungen.join(", ")}`);
  }
}

// ── 3c. Speichern per Knopf ────────────────────────────────────────────
{
  const w = welt();
  if (w.api._renameFile) {
    w.api._renameFile("task", "b2d07c59", 0);
    w.knoten.qsRenameInput.value = "s3-attachment-20260825-2357-RENAMED";
    if (klick(w.knoten.qsRenameSave, "Speichern-Knopf")) {
      ok(w.entity.files[0].name === ZIEL_NAME, `Knopf: der Name ist "${w.entity.files[0].name}"`);
      ok(w.protokoll.scheduleSave === 1, `Knopf: scheduleSave lief ${w.protokoll.scheduleSave}x`);
    }
  }
}

// ── 3d. Abbrechen und Escape aendern NICHTS ────────────────────────────
for (const [was, tu] of [
  ["Abbrechen-Knopf", (w) => klick(w.knoten.qsRenameCancel, "Abbrechen-Knopf")],
  ["Escape", (w) => w.taste("Escape")],
]) {
  const w = welt();
  if (!w.api._renameFile) break;
  w.api._renameFile("task", "b2d07c59", 0);
  w.knoten.qsRenameInput.value = "voellig-anderer-name";
  tu(w);
  ok(w.entity.files[0].name === START_NAME, `${was}: der Name wurde auf "${w.entity.files[0].name}" geaendert`);
  ok(w.protokoll.scheduleSave === 0, `${was}: es lief ein Schreibvorgang`);
  ok(!w.blattOffen(), `${was}: das Blatt blieb offen`);
  ok(w.protokoll.fokus[w.protokoll.fokus.length - 1] === "ausloeser", `${was}: der Fokus kam nicht zurueck`);
  ok(w.hoererZahl() === 0, `${was}: der Tastatur-Hoerer blieb angemeldet`);
}

// ── 3e. Leer und nur Leerzeichen: blockieren, NICHT schliessen ─────────
for (const wert of ["", "   ", "\t \n"]) {
  const w = welt();
  if (!w.api._renameFile) break;
  w.api._renameFile("task", "b2d07c59", 0);
  w.knoten.qsRenameInput.value = wert;
  w.taste("Enter");
  ok(w.entity.files[0].name === START_NAME, `"${wert}": der Name wurde geaendert`);
  ok(w.protokoll.scheduleSave === 0, `"${wert}": es lief ein Schreibvorgang`);
  ok(w.blattOffen(), `"${wert}": das Blatt schloss sich — der Nutzer muesste von vorn anfangen`);
  ok(w.knoten.qsRenameErr.hidden === false, `"${wert}": es wurde kein Grund angezeigt`);
  ok(/nicht leer/.test(w.knoten.qsRenameErr.textContent), `"${wert}": die Meldung nennt den Grund nicht`);
  ok(w.protokoll.fokus[w.protokoll.fokus.length - 1] === "qsRenameInput",
    `"${wert}": der Fokus steht nicht wieder im Feld`);
}

// ── 3f. Unveraenderter Name schreibt nicht ─────────────────────────────
{
  const w = welt();
  if (w.api._renameFile) {
    w.api._renameFile("task", "b2d07c59", 0);
    w.taste("Enter");   // Feldwert unveraendert
    ok(w.protokoll.scheduleSave === 0,
      "ein unveraenderter Name loeste trotzdem einen Schreibvorgang aus");
    ok(w.entity.files[0].name === START_NAME, "der Name aenderte sich ohne Zutun");
  }
}

// ── 3g. Das Ziel haelt ueber den Dialog hinweg — per ID, nicht Position ─
{
  const w = welt({ dateien: [
    { id: "f_andere", name: "andere.txt" },
    { id: DATEI_ID, name: START_NAME, textKey: "tk" },
  ] });
  if (w.api._renameFile) {
    w.api._renameFile("task", "b2d07c59", 1);
    // Waehrend das Blatt offen ist, ordnet ein Abgleich die Liste um.
    w.entity.files.reverse();
    w.knoten.qsRenameInput.value = "s3-attachment-20260825-2357-RENAMED";
    w.taste("Enter");
    const ziel = w.entity.files.find((f) => f.id === DATEI_ID);
    const andere = w.entity.files.find((f) => f.id === "f_andere");
    ok(ziel.name === ZIEL_NAME, `nach dem Umsortieren heisst die Zieldatei "${ziel.name}"`);
    ok(andere.name === "andere.txt",
      `DIE FALSCHE DATEI wurde umbenannt: "${andere.name}" — das Ziel haengt an der Position statt an der Id`);
  }
}

// ── 3h. Datei waehrend des Dialogs verschwunden: sauber aufgeben ───────
{
  const w = welt();
  if (w.api._renameFile) {
    w.api._renameFile("task", "b2d07c59", 0);
    w.entity.files.length = 0;
    w.knoten.qsRenameInput.value = "egal";
    w.taste("Enter");
    ok(w.protokoll.scheduleSave === 0, "fuer eine verschwundene Datei wurde geschrieben");
    ok(w.entity.files.length === 0, "es wurde eine Datei wiederhergestellt");
  }
}

// ═══ 4. QUELLTEXT: kein nativer Dialog mehr im Umbenennen-Pfad ═════════
{
  const a = index.indexOf("window._renameFile = function(kind, entityId, idx) {");
  ok(a > 0, "_renameFile wurde nicht gefunden");
  const koerper = index.slice(a, index.indexOf("\n};\n", a));
  const ohneKommentare = koerper.replace(/^\s*\/\/.*$/gm, "");
  for (const nativ of ["prompt(", "alert(", "confirm("]) {
    ok(!ohneKommentare.includes(nativ), `_renameFile enthaelt weiterhin ${nativ}`);
  }
  ok(/openRenameSheet\(/.test(ohneKommentare), "_renameFile oeffnet nicht das app-eigene Blatt");
  const anzahl = (ohneKommentare.match(/scheduleSave\(\)/g) || []).length;
  ok(anzahl === 1, `_renameFile ruft scheduleSave ${anzahl}x — erwartet genau einmal`);
  ok(!/canonicalWrite|remotePutByKey|doSave\(/.test(ohneKommentare),
    "_renameFile umgeht den bestehenden Speicherweg mit einem eigenen");

  const blatt = index.slice(index.indexOf("function openRenameSheet(opt) {"),
    index.indexOf("\n}\nwindow.openRenameSheet"));
  for (const nativ of ["prompt(", "alert(", "confirm("]) {
    ok(!blatt.replace(/^\s*\/\/.*$/gm, "").includes(nativ), `openRenameSheet enthaelt ${nativ}`);
  }
  ok(/role="dialog"/.test(blatt) && /aria-modal="true"/.test(blatt),
    "das Blatt ist fuer Hilfsmittel kein Dialog");
  ok(/aria-labelledby="qsRenameTitle"/.test(blatt), "das Blatt hat keinen zugeordneten Titel");
  ok(/role="alert"/.test(blatt), "die Fehlermeldung wird Hilfsmitteln nicht angesagt");
  ok(/<label for="qsRenameInput">/.test(blatt), "das Eingabefeld hat keine verknuepfte Beschriftung");
  ok(!/#modalBackdrop|openModal\(/.test(blatt), "das Blatt haengt sich an den gemeinsamen Modal-Behaelter");
}

// ═══ 5. Fremde Bereiche unberuehrt ════════════════════════════════════
for (const anker of [
  "async function canonicalWrite(quelle, options = {})",
  "if (typeof logDeletion === 'function') logDeletion(kind, id);",
  "const ATTACHMENT_KIND_STORES = { task:'tasks'",
  'window._deleteFileFolder = function(kind, entityId, folderId) {',
  'case "bmpruefung": window.location.href = "bm.html"; return;',
]) {
  ok(index.includes(anker), `ein fremder Bereich wurde beruehrt: "${anker}" fehlt`);
}
ok(/\.app,\n      \.app\.sidebar-collapsed\{grid-template-columns:minmax\(0,1fr\)\}/.test(index),
  "die M1-Regel wurde veraendert");

// ── Bericht ────────────────────────────────────────────────────────────
if (luecken.length) {
  console.error("M3 RENAME SHEET — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`m3 rename sheet: ok (${checks} Pruefungen)`);
