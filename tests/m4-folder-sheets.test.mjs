/*
 * M4 — die Ordner-Wege ohne nativen prompt().
 *
 * BEFUND: window._createFileFolder rief prompt('Ordnername:'),
 * window._renameFileFolder rief prompt('Neuer Ordnername:', folder.name).
 * Derselbe Blocker wie beim Datei-Umbenennen: ein nativer Dialog haelt den
 * gesamten Renderer an, ist auf Telefon und Tablet nicht bedienbar und
 * blockiert jede Fernsteuerung. Die Ordner sassen im selben Anhangbereich
 * direkt neben der bereits umgestellten Datei-Aktion — halb umgestellt waere
 * schlechter als gar nicht, weil derselbe Handgriff mal geht und mal nicht.
 *
 * Zweiter Befund im Anlegen-Pfad: er fragte ZUERST nach dem Namen und merkte
 * erst danach, dass es die Entitaet gar nicht gibt — ein Dialog in die
 * Sackgasse.
 *
 * Beide gehen jetzt durch dasselbe Blatt (openRenameSheet). Geprueft wird
 * gegen die ECHTEN Funktionen gegen DOM-Attrappen; die nativen Dialoge sind
 * verdrahtet und werden PROTOKOLLIERT, nicht geworfen — so laeuft ein alter
 * Stand echt weiter und zeigt sein Verhalten, statt den Lauf zu beenden.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };
const klick = (k, was) => {
  if (!k || typeof k.onclick !== "function") { ok(false, `${was}: es gibt kein Bedienelement`); return false; }
  k.onclick(); return true;
};

// ═══ Die echten Funktionen gegen DOM-Attrappen ══════════════════════════
function welt({ ordner = null, entitaetDa = true, zeitEingefroren = false } = {}) {
  const protokoll = { scheduleSave: 0, render: 0, toasts: [], fokus: [], nativ: [] };
  const knoten = {};
  const mach = (id) => ({
    id, value: "", textContent: "", hidden: false, onclick: null,
    focus() { protokoll.fokus.push(this.id); welt._aktiv = this; }, select() {},
  });
  for (const id of ["qsRenameInput", "qsRenameErr", "qsRenameCancel", "qsRenameSave",
    "qsConfirmOk", "qsConfirmCancel"]) knoten[id] = mach(id);
  const ausloeser = mach("ausloeser");

  let hoerer = [], blatt = null;
  const dokument = {
    createElement() {
      const el = {
        className: "", id: "", onclick: null,
        set innerHTML(html) {
          this._html = html;
          const m = /id="qsRenameInput"[\s\S]*?value="([^"]*)"/.exec(html);
          knoten.qsRenameInput.value = m ? m[1] : "";
        },
        get innerHTML() { return this._html || ""; },
        classList: { k: new Set(), add(x) { this.k.add(x); }, remove(x) { this.k.delete(x); }, contains(x) { return this.k.has(x); } },
        querySelector(sel) { return knoten[String(sel).replace("#", "")] || null; },
        remove() { if (blatt === el) blatt = null; },
      };
      return el;
    },
    body: { appendChild(el) { blatt = el; } },
    getElementById(id) { return (id === "qsRenameSheet" || id === "qsConfirmSheet") ? blatt : (knoten[id] || null); },
    addEventListener(t, fn) { if (t === "keydown") hoerer.push(fn); },
    removeEventListener(t, fn) { hoerer = hoerer.filter((h) => h !== fn); },
  };
  Object.defineProperty(dokument, "activeElement", { get() { return welt._aktiv || ausloeser; }, configurable: true });
  welt._aktiv = ausloeser;

  const entity = {
    id: "b2d07c59",
    fileFolders: ordner === null ? [{ id: "ff_alt", name: "Vertraege", createdAt: "2026-08-01T00:00:00.000Z" }] : ordner,
    files: [{ id: "f_1", name: "a.txt", folderId: "ff_alt" }],
    updatedAt: "2026-08-25T23:57:00.000Z",
  };
  const APP = { state: { data: { entities: { tasks: entitaetDa ? { b2d07c59: entity } : {} } } } };

  const schnitt = (kopf) => {
    const a = index.indexOf(kopf);
    if (a < 0) return "";
    const e = index.indexOf("\n};\n", a);
    return e > a ? index.slice(a, e + 4) : "";
  };
  const blattQuelle = (() => {
    const a = index.indexOf("function openRenameSheet(opt) {");
    if (a < 0) return "";
    const e = index.indexOf("\n}\nwindow.openRenameSheet", a);
    return e > a ? index.slice(a, e + 3) : "";
  })();
  const bestaetigenQuelle = (() => {
    const a = index.indexOf("function openConfirmSheet(opt) {");
    if (a < 0) return "";
    const e = index.indexOf("\n}\nwindow.openConfirmSheet", a);
    return e > a ? index.slice(a, e + 3) : "";
  })();
  const quelle = blattQuelle + "\n" + bestaetigenQuelle +
    "\n" + schnitt("window._deleteFileFolder = function(kind, entityId, folderId) {") +
    "\n" + schnitt("window._createFileFolder = function(kind, entityId) {") +
    "\n" + schnitt("window._renameFileFolder = function(kind, entityId, folderId) {") +
    "\nreturn { openRenameSheet: typeof openRenameSheet === 'function' ? openRenameSheet : null," +
    " openConfirmSheet: typeof openConfirmSheet === 'function' ? openConfirmSheet : null," +
    " _createFileFolder: window._createFileFolder || null," +
    " _renameFileFolder: window._renameFileFolder || null," +
    " _deleteFileFolder: window._deleteFileFolder || null };";

  const nativ = (name) => (nachricht, vorgabe) => {
    protokoll.nativ.push(name);
    if (name !== "prompt") return true;
    const v = knoten.qsRenameInput.value;
    return v === "" ? (vorgabe === undefined ? null : vorgabe) : v;
  };
  const api = new Function(
    "document", "APP", "ATTACHMENT_KIND_STORES", "esc", "toast", "scheduleSave", "render",
    "window", "prompt", "alert", "confirm", "Date", "String", "Array", "Object", "console",
    quelle)(
    dokument, APP, { task: "tasks" }, (x) => String(x == null ? "" : x),
    (a, b, c) => protokoll.toasts.push([a, b, c].join("|")),
    () => { protokoll.scheduleSave++; }, () => { protokoll.render++; },
    {}, nativ("prompt"), nativ("alert"), nativ("confirm"),
    // Eingefrorene Zeit: nur so laesst sich pruefen, ob zwei Ordner in DERSELBEN
    // Millisekunde verschiedene Ids bekommen. Mit der echten Uhr ginge der Test
    // zufaellig durch.
    zeitEingefroren
      ? Object.assign(function () { return new Date(1787738501400); },
          { now: () => 1787738501400 })
      : Date,
    String, Array, Object, { log() {}, warn() {}, error() {} });

  const taste = (key) => hoerer.forEach((h) => h({
    key, target: knoten.qsRenameInput, preventDefault() {}, stopPropagation() {},
  }));
  const vorZustand = JSON.parse(JSON.stringify(APP.state.data));
  return { api, protokoll, knoten, entity, APP, taste, ausloeser, vorZustand,
    blattOffen: () => !!blatt, hoererZahl: () => hoerer.length };
}

// ═══ 1. ORDNER ANLEGEN ═════════════════════════════════════════════════
{
  const w = welt();
  ok(!!w.api._createFileFolder, "_createFileFolder wurde nicht geladen");
  ok(!!w.api.openRenameSheet, "openRenameSheet existiert nicht");
  if (w.api._createFileFolder) {
    w.api._createFileFolder("task", "b2d07c59");
    ok(w.protokoll.nativ.length === 0,
      `DER BEFUND: das Anlegen rief einen nativen Dialog (${w.protokoll.nativ.join(",")})`);
    ok(w.blattOffen(), "das Blatt wurde nicht geoeffnet");
    ok(w.knoten.qsRenameInput.value === "", `das Feld ist mit "${w.knoten.qsRenameInput.value}" vorbelegt statt leer`);
    ok(w.protokoll.fokus[0] === "qsRenameInput", "das Feld bekam beim Oeffnen nicht den Fokus");
    ok(w.protokoll.scheduleSave === 0, "das blosse Oeffnen schrieb bereits");

    w.knoten.qsRenameInput.value = "  Rechnungen  ";
    w.taste("Enter");
    ok(w.entity.fileFolders.length === 2, `es liegen ${w.entity.fileFolders.length} Ordner statt 2`);
    // Auf einem Stand ohne Blatt entsteht hier gar kein Ordner. Ohne diesen
    // Riegel stuerzte die Gegenprobe an neu.name ab — rot aus dem falschen
    // Grund, und alles Folgende waere nie gelaufen.
    const neu = w.entity.fileFolders[1];
    ok(!!neu, "es wurde kein zweiter Ordner angelegt — das Blatt hat den Namen nicht zugestellt");
    if (neu) {
      ok(neu.name === "Rechnungen", `der Ordner heisst "${neu.name}" — die Leerzeichen wurden nicht abgeschnitten`);
      ok(typeof neu.id === "string" && neu.id.indexOf("ff_") === 0, `die Ordner-Id ist "${neu.id}"`);
      ok(typeof neu.createdAt === "string", "createdAt fehlt");
    }
    ok(w.protokoll.scheduleSave === 1, `scheduleSave lief ${w.protokoll.scheduleSave}x statt genau einmal`);
    ok(w.protokoll.render === 1, `render lief ${w.protokoll.render}x`);
    ok(!w.blattOffen(), "das Blatt blieb offen");
    ok(w.hoererZahl() === 0, "der Tastatur-Hoerer blieb angemeldet");
    ok(w.protokoll.fokus[w.protokoll.fokus.length - 1] === "ausloeser", "der Fokus kam nicht zurueck");
    // Der bestehende Ordner und die Dateizuordnung bleiben unberuehrt.
    ok(w.entity.fileFolders[0].name === "Vertraege", "der bestehende Ordner wurde veraendert");
    ok(w.entity.files[0].folderId === "ff_alt", "die Dateizuordnung wurde veraendert");
  }
}

// Ohne Entitaet gar kein Dialog — kein Fragen in die Sackgasse.
{
  const w = welt({ entitaetDa: false });
  if (w.api._createFileFolder) {
    w.api._createFileFolder("task", "b2d07c59");
    ok(!w.blattOffen(),
      "fuer eine nicht vorhandene Entitaet wurde ein Dialog geoeffnet — der Nutzer tippt einen Namen ins Leere");
    ok(w.protokoll.nativ.length === 0, "es lief ein nativer Dialog");
    ok(w.protokoll.scheduleSave === 0, "es wurde geschrieben");
  }
}

// Leer und nur Leerzeichen: blockieren, Blatt bleibt offen.
for (const wert of ["", "   "]) {
  const w = welt();
  if (!w.api._createFileFolder) break;
  w.api._createFileFolder("task", "b2d07c59");
  w.knoten.qsRenameInput.value = wert;
  w.taste("Enter");
  ok(w.entity.fileFolders.length === 1, `"${wert}": es wurde ein Ordner angelegt`);
  ok(w.protokoll.scheduleSave === 0, `"${wert}": es wurde geschrieben`);
  ok(w.blattOffen(), `"${wert}": das Blatt schloss sich`);
  ok(w.knoten.qsRenameErr.hidden === false, `"${wert}": es wurde kein Grund angezeigt`);
  ok(/Ordnername/.test(w.knoten.qsRenameErr.textContent),
    `"${wert}": die Meldung nennt nicht den Ordnernamen ("${w.knoten.qsRenameErr.textContent}")`);
}

// Abbrechen und Escape legen nichts an.
for (const [was, tu] of [
  ["Abbrechen", (w) => klick(w.knoten.qsRenameCancel, "Abbrechen")],
  ["Escape", (w) => w.taste("Escape")],
]) {
  const w = welt();
  if (!w.api._createFileFolder) break;
  w.api._createFileFolder("task", "b2d07c59");
  w.knoten.qsRenameInput.value = "Wird-nicht-angelegt";
  tu(w);
  ok(w.entity.fileFolders.length === 1, `${was}: es wurde trotzdem ein Ordner angelegt`);
  ok(w.protokoll.scheduleSave === 0, `${was}: es wurde geschrieben`);
  ok(!w.blattOffen(), `${was}: das Blatt blieb offen`);
}

// ═══ 2. ORDNER UMBENENNEN ══════════════════════════════════════════════
{
  const w = welt();
  ok(!!w.api._renameFileFolder, "_renameFileFolder wurde nicht geladen");
  if (w.api._renameFileFolder) {
    w.api._renameFileFolder("task", "b2d07c59", "ff_alt");
    ok(w.protokoll.nativ.length === 0,
      `DER BEFUND: das Umbenennen rief einen nativen Dialog (${w.protokoll.nativ.join(",")})`);
    ok(w.blattOffen(), "das Blatt wurde nicht geoeffnet");
    ok(w.knoten.qsRenameInput.value === "Vertraege",
      `das Feld ist mit "${w.knoten.qsRenameInput.value}" vorbelegt statt mit dem bisherigen Namen`);

    w.knoten.qsRenameInput.value = "Vertraege-2026";
    w.taste("Enter");
    ok(w.entity.fileFolders[0].name === "Vertraege-2026",
      `der Ordner heisst "${w.entity.fileFolders[0].name}"`);
    ok(w.entity.fileFolders[0].id === "ff_alt", "die Ordner-Id hat sich geaendert");
    ok(w.entity.fileFolders[0].createdAt === "2026-08-01T00:00:00.000Z", "createdAt wurde ueberschrieben");
    ok(w.entity.files[0].folderId === "ff_alt", "die Dateizuordnung ging verloren");
    ok(w.entity.fileFolders.length === 1, `es liegen ${w.entity.fileFolders.length} Ordner statt 1 — ein Duplikat`);
    ok(w.protokoll.scheduleSave === 1, `scheduleSave lief ${w.protokoll.scheduleSave}x statt genau einmal`);

    // Keine zweite Mutation: der GANZE Baum wird verglichen.
    const abw = [];
    (function v(a, b, pfad) {
      for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        const va = a ? a[k] : undefined, vb = b ? b[k] : undefined, pf = pfad + "." + k;
        if (va && vb && typeof va === "object" && typeof vb === "object") { v(va, vb, pf); continue; }
        if (va !== vb) abw.push(pf);
      }
    })(w.vorZustand, JSON.parse(JSON.stringify(w.APP.state.data)), "data");
    abw.sort();
    ok(abw.join(",") === "data.entities.tasks.b2d07c59.fileFolders.0.name,data.entities.tasks.b2d07c59.updatedAt",
      `geaendert wurden: ${abw.join(", ")} — erwartet genau Name und updatedAt`);
  }
}

// Unveraenderter Name schreibt nicht.
{
  const w = welt();
  if (w.api._renameFileFolder) {
    w.api._renameFileFolder("task", "b2d07c59", "ff_alt");
    w.taste("Enter");
    ok(w.protokoll.scheduleSave === 0, "ein unveraenderter Ordnername loeste einen Schreibvorgang aus");
  }
}

// Das Ziel haelt ueber den Dialog: Liste waehrend des Blatts umsortiert.
{
  const w = welt({ ordner: [
    { id: "ff_a", name: "Alpha" },
    { id: "ff_alt", name: "Vertraege" },
  ] });
  if (w.api._renameFileFolder) {
    w.api._renameFileFolder("task", "b2d07c59", "ff_alt");
    w.entity.fileFolders.reverse();
    w.knoten.qsRenameInput.value = "Vertraege-2026";
    w.taste("Enter");
    ok(w.entity.fileFolders.find((f) => f.id === "ff_alt").name === "Vertraege-2026",
      "die Zieldatei wurde nach dem Umsortieren nicht getroffen");
    ok(w.entity.fileFolders.find((f) => f.id === "ff_a").name === "Alpha",
      "DER FALSCHE ORDNER wurde umbenannt — das Ziel haengt an der Position statt an der Id");
  }
}

// Ordner waehrend des Dialogs verschwunden: sauber aufgeben.
{
  const w = welt();
  if (w.api._renameFileFolder) {
    w.api._renameFileFolder("task", "b2d07c59", "ff_alt");
    w.entity.fileFolders.length = 0;
    w.knoten.qsRenameInput.value = "egal";
    w.taste("Enter");
    ok(w.protokoll.scheduleSave === 0, "fuer einen verschwundenen Ordner wurde geschrieben");
    ok(w.entity.fileFolders.length === 0, "es wurde ein Ordner wiederhergestellt");
  }
}

// Ein unbekannter Ordner oeffnet gar kein Blatt.
{
  const w = welt();
  if (w.api._renameFileFolder) {
    w.api._renameFileFolder("task", "b2d07c59", "ff_gibtsnicht");
    ok(!w.blattOffen(), "fuer einen unbekannten Ordner wurde ein Dialog geoeffnet");
    ok(w.protokoll.nativ.length === 0, "es lief ein nativer Dialog");
  }
}

// ═══ 2b. ORDNER-ID: kollisionsfest ═════════════════════════════════════
// 'ff_' + Date.now().toString(36) allein reicht nicht: zwei Ordner in DERSELBEN
// Millisekunde bekaemen dieselbe Id, und find(f => f.id === folderId) traefe
// danach den falschen — beim Umbenennen wie beim Loeschen.
{
  const w = welt({ zeitEingefroren: true });
  if (w.api._createFileFolder) {
    w.api._createFileFolder("task", "b2d07c59");
    w.knoten.qsRenameInput.value = "Erster";
    w.taste("Enter");
    w.api._createFileFolder("task", "b2d07c59");
    w.knoten.qsRenameInput.value = "Zweiter";
    w.taste("Enter");
    const ids = w.entity.fileFolders.map((f) => f.id);
    ok(w.entity.fileFolders.length === 3, `es liegen ${w.entity.fileFolders.length} Ordner statt 3`);
    ok(new Set(ids).size === ids.length,
      `zwei Ordner in derselben Millisekunde teilen sich eine Id: ${ids.join(", ")}`);
  }
}

// ═══ 2c. BESTAETIGUNGS-BLATT ═══════════════════════════════════════════
{
  const w = welt();
  ok(!!w.api.openConfirmSheet, "openConfirmSheet existiert nicht — confirm() bleibt der einzige Weg");
  if (w.api.openConfirmSheet) {
    let gerufen = 0;
    w.api.openConfirmSheet({ titel: "Test", text: "Zeile eins\nZeile zwei",
      jaLabel: "Löschen", gefahr: true, onBestaetigen: () => { gerufen++; } });
    ok(w.blattOffen(), "das Bestaetigungsblatt wurde nicht geoeffnet");
    ok(w.protokoll.nativ.length === 0, `es lief ein nativer Dialog (${w.protokoll.nativ.join(",")})`);
    // Der Fokus liegt auf ABBRECHEN — wer eine Loeschfrage wegtippt, verliert nichts.
    ok(w.protokoll.fokus[0] === "qsConfirmCancel",
      `beim Oeffnen bekam "${w.protokoll.fokus[0]}" den Fokus statt Abbrechen`);
    ok(gerufen === 0, "die Aktion lief schon beim blossen Oeffnen");

    klick(w.knoten.qsConfirmOk, "Ja-Knopf");
    ok(gerufen === 1, `nach Ja lief die Aktion ${gerufen}x`);
    ok(!w.blattOffen(), "das Blatt blieb nach Ja offen");
    ok(w.protokoll.fokus[w.protokoll.fokus.length - 1] === "ausloeser", "der Fokus kam nicht zurueck");
    ok(w.hoererZahl() === 0, "der Tastatur-Hoerer blieb angemeldet");
  }
}
for (const [was, tu] of [
  ["Abbrechen", (w) => klick(w.knoten.qsConfirmCancel, "Abbrechen")],
  ["Escape", (w) => w.taste("Escape")],
]) {
  const w = welt();
  if (!w.api.openConfirmSheet) break;
  let gerufen = 0;
  w.api.openConfirmSheet({ titel: "Test", text: "x", onBestaetigen: () => { gerufen++; } });
  tu(w);
  ok(gerufen === 0, `${was}: die Aktion lief trotzdem`);
  ok(!w.blattOffen(), `${was}: das Blatt blieb offen`);
  ok(w.hoererZahl() === 0, `${was}: der Tastatur-Hoerer blieb angemeldet`);
}

// ═══ 2d. ORDNER LOESCHEN (Anhangbereich) ═══════════════════════════════
{
  const w = welt();
  ok(!!w.api._deleteFileFolder, "_deleteFileFolder wurde nicht geladen");
  if (w.api._deleteFileFolder) {
    w.api._deleteFileFolder("task", "b2d07c59", "ff_alt");
    ok(w.protokoll.nativ.length === 0,
      `DER BEFUND: das Loeschen rief einen nativen Dialog (${w.protokoll.nativ.join(",")})`);
    ok(w.blattOffen(), "das Bestaetigungsblatt wurde nicht geoeffnet");
    ok(w.entity.fileFolders.length === 1, "der Ordner verschwand schon vor der Bestaetigung");
    ok(w.protokoll.scheduleSave === 0, "es wurde vor der Bestaetigung geschrieben");

    klick(w.knoten.qsConfirmOk, "Ja-Knopf");
    ok(w.entity.fileFolders.length === 0, "der Ordner wurde nicht geloescht");
    // Die Dateien bleiben — sie wandern nur nach "Unsortiert".
    ok(w.entity.files.length === 1, `es sind ${w.entity.files.length} Dateien uebrig statt 1`);
    ok(w.entity.files[0].folderId === undefined,
      `die Datei traegt weiterhin folderId "${w.entity.files[0].folderId}"`);
    ok(w.entity.files[0].id === "f_1", "die Datei-Id hat sich geaendert");
    ok(w.protokoll.scheduleSave === 1, `scheduleSave lief ${w.protokoll.scheduleSave}x statt genau einmal`);
  }
}
// Abbrechen loescht nichts.
{
  const w = welt();
  if (w.api._deleteFileFolder) {
    w.api._deleteFileFolder("task", "b2d07c59", "ff_alt");
    klick(w.knoten.qsConfirmCancel, "Abbrechen");
    ok(w.entity.fileFolders.length === 1, "Abbrechen loeschte den Ordner trotzdem");
    ok(w.entity.files[0].folderId === "ff_alt", "Abbrechen loeste die Dateizuordnung");
    ok(w.protokoll.scheduleSave === 0, "Abbrechen schrieb");
  }
}
// Waehrend des Blatts verschwunden: sauber aufgeben.
{
  const w = welt();
  if (w.api._deleteFileFolder) {
    w.api._deleteFileFolder("task", "b2d07c59", "ff_alt");
    w.entity.fileFolders.length = 0;
    klick(w.knoten.qsConfirmOk, "Ja-Knopf");
    ok(w.protokoll.scheduleSave === 0, "fuer einen verschwundenen Ordner wurde geschrieben");
    ok(w.entity.files[0].folderId === "ff_alt", "die Dateizuordnung wurde trotzdem geloest");
  }
}
// Ein unbekannter Ordner oeffnet gar kein Blatt.
{
  const w = welt();
  if (w.api._deleteFileFolder) {
    w.api._deleteFileFolder("task", "b2d07c59", "ff_gibtsnicht");
    ok(!w.blattOffen(), "fuer einen unbekannten Ordner wurde eine Loeschfrage gestellt");
  }
}

// ═══ 3. QUELLTEXT ══════════════════════════════════════════════════════
// Jede Stelle bekommt IHREN Vertrag: welches Blatt sie oeffnet und ueber
// welchen Speicherweg sie schreibt. Die kv-Wege benutzen _kvSave(pid), nicht
// scheduleSave() — eine Sammelregel haette hier das Falsche behauptet.
for (const { name, kopf, blatt, speichern } of [
  { name: "_createFileFolder", kopf: "window._createFileFolder = function(kind, entityId) {",
    blatt: "openRenameSheet", speichern: "scheduleSave()" },
  { name: "_renameFileFolder", kopf: "window._renameFileFolder = function(kind, entityId, folderId) {",
    blatt: "openRenameSheet", speichern: "scheduleSave()" },
  { name: "_deleteFileFolder", kopf: "window._deleteFileFolder = function(kind, entityId, folderId) {",
    blatt: "openConfirmSheet", speichern: "scheduleSave()" },
  { name: "_kvAddFolder", kopf: "window._kvAddFolder = function(pid, area, parentId) {",
    blatt: "openRenameSheet", speichern: "_kvSave(pid)" },
  { name: "_kvDeleteFolder", kopf: "window._kvDeleteFolder = function(pid, area, folderId) {",
    blatt: "openConfirmSheet", speichern: "_kvSave(pid)" },
  { name: "_kvAssignFolderFile", kopf: "window._kvAssignFolderFile = function(pid, area, fileId) {",
    blatt: "openConfirmSheet", speichern: null },
]) {
  const a = index.indexOf(kopf);
  ok(a > 0, `${name} wurde nicht gefunden`);
  if (a < 0) continue;
  const koerper = index.slice(a, index.indexOf("\n};\n", a)).replace(/^\s*\/\/.*$/gm, "");
  for (const nativ of ["prompt(", "alert(", "confirm("]) {
    ok(!koerper.includes(nativ), `${name} enthaelt weiterhin ${nativ}`);
  }
  ok(koerper.includes(blatt + "("), `${name} oeffnet nicht ${blatt}`);
  if (speichern) {
    const n = koerper.split(speichern).length - 1;
    ok(n === 1, `${name} ruft ${speichern} ${n}x — erwartet genau einmal`);
  }
  ok(!/canonicalWrite|remotePutByKey|doSave\(/.test(koerper),
    `${name} umgeht den bestehenden Speicherweg`);
}

{
  const a = index.indexOf("function deleteProgramFolder(folderId) {");
  ok(a > 0, "deleteProgramFolder wurde nicht gefunden");
  if (a > 0) {
    const koerper = index.slice(a, index.indexOf("\n}\n", a)).replace(/^\s*\/\/.*$/gm, "");
    for (const nativ of ["prompt(", "alert(", "confirm("]) {
      ok(!koerper.includes(nativ), `deleteProgramFolder enthaelt weiterhin ${nativ}`);
    }
    ok(/openConfirmSheet\(/.test(koerper), "deleteProgramFolder fragt nicht ueber das Blatt");
  }
}
// Es darf im gesamten Ordner-Umfeld kein nativer Dialog mehr uebrig sein.
for (const rest of ["prompt('Ordnername:')", `confirm('Ordner löschen?`,
  "Keine Ordner vorhanden. Jetzt einen erstellen?", 'confirm("Ordner und alle enthaltenen Links']) {
  ok(!index.includes(rest), `im Quelltext steht noch: ${rest}`);
}
// Das Bestaetigungsblatt selbst ist barrierearm und benutzt keinen nativen Weg.
{
  const a = index.indexOf("function openConfirmSheet(opt) {");
  ok(a > 0, "openConfirmSheet wurde nicht gefunden");
  if (a > 0) {
    const b = index.slice(a, index.indexOf("\n}\nwindow.openConfirmSheet", a));
    ok(/role="alertdialog"/.test(b), "das Bestaetigungsblatt ist kein alertdialog");
    ok(/aria-modal="true"/.test(b), "aria-modal fehlt");
    ok(/aria-describedby="qsConfirmText"/.test(b), "der Text ist dem Dialog nicht zugeordnet");
    ok(/neinBtn\.focus\(\)/.test(b), "der Fokus liegt nicht auf Abbrechen");
    for (const nativ of ["prompt(", "alert(", "confirm("]) {
      ok(!b.replace(/^\s*\/\/.*$/gm, "").includes(nativ), `openConfirmSheet enthaelt ${nativ}`);
    }
  }
}

// ═══ 4. Fremde Bereiche unberuehrt ════════════════════════════════════
for (const anker of [
  "async function canonicalWrite(quelle, options = {})",
  "if (typeof logDeletion === 'function') logDeletion(kind, id);",
  "window._renameFile = function(kind, entityId, idx) {",
  "function openRenameSheet(opt) {",
  'window._deleteFileFolder = function(kind, entityId, folderId) {',
]) {
  ok(index.includes(anker), `ein fremder Bereich wurde beruehrt: "${anker}" fehlt`);
}
// Das Datei-Umbenennen aus dem Vorgaenger-Commit bleibt, wie es war.
ok(/const zielId = file\.id \|\| null;/.test(index), "der Datei-Umbenennen-Pfad wurde veraendert");

if (luecken.length) {
  console.error("M4 FOLDER SHEETS — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`m4 folder sheets: ok (${checks} Pruefungen)`);
