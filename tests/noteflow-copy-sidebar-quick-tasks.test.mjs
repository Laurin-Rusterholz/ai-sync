/*
 * Drei Befunde aus dem Alltag, nachdem das ChatGPT-Modul live war:
 *
 *  1. "Ich kann in NoteFlow nicht den ganzen Text ueber Ctrl+A kopieren."
 *     Strg+A markierte seit noteflow-selectall-fix zwar Titel + alle Bloecke,
 *     aber jeder Block ist ein eigener contenteditable-Host — beim Kopieren
 *     nahm der Browser nur den Teil im fokussierten Host. Jetzt faengt ein
 *     copy-Handler die Markierung ab, sobald sie mindestens zwei Hosts
 *     ueberspannt, und schreibt Text + HTML der ganzen Notiz selbst.
 *  2. "Ich moechte die Notizbuecher in NoteFlow in der Sidebar sehen."
 *     noteflow-pinned-sidebar zeigte nur ANGEPINNTE Notizbuecher; ohne
 *     Anpinnen war der Baum leer. Jetzt stehen alle da, angepinnte zuoberst.
 *  3. "Aufgaben von ChatGPT sollen einfacher zu erfassen sein."
 *     Das Feld am Element lag im zugeklappten Teil (erst Kopf anklicken,
 *     dann tippen). Jetzt ist es immer sichtbar; dazu eine Schnellerfassung
 *     mit Element-Suche in der Sammelansicht und ein Eintrag im Kontextmenue.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
// NoteFlow-Funktionen stehen in einer IIFE (zwei Leerzeichen eingerueckt),
// die Modulfunktionen von Block 1 in Spalte 0.
function sliceFn(name, indent = "  ") {
  const start = index.indexOf(name);
  const end = index.indexOf("\n" + indent + "function ", start + 10);
  ok(start > 0 && end > start, `${name} nicht gefunden`);
  return index.slice(start, end);
}

// ── 1. Kopieren der ganzen Notiz ─────────────────────────────────────────
{
  ok(/document\.addEventListener\("copy", onNoteCopy, true\);/.test(index), "NoteFlow registriert keinen copy-Handler");
  const copy = sliceFn("function noteSelectionClipboard(sel) {");
  ok(/range\.cloneContents\(\)/.test(copy), "der Handler liest nicht die echte Markierung (cloneContents)");
  ok(/\.nf2-gutter,\.nf2-gbtn/.test(copy), "Gutter-Knoepfe (＋ ⠿) landen im kopierten Text");
  ok(/units\.length < 2\) return null/.test(copy), "innerhalb eines Hosts wird dem Browser das Kopieren nicht ueberlassen");
  ok(/\.nf2-title, \.nf2-block/.test(copy), "Titel und Bloecke werden nicht als Einheiten kopiert");
  const onCopy = sliceFn("function onNoteCopy(e) {");
  ok(/setData\("text\/plain", data\.text\)/.test(onCopy) && /setData\("text\/html", data\.html\)/.test(onCopy), "Zwischenablage bekommt nicht Text UND HTML");
  ok(/isNoteflowEditableTarget\(document\.activeElement\)/.test(onCopy), "der Handler greift auch ausserhalb des Editors ein");

  // Die Textbildung wirklich ausfuehren, gegen einen Mini-DOM.
  const mk = (cls, html, text) => ({ classList: { contains: (c) => cls.includes(c) }, innerHTML: html, textContent: text, querySelector: () => null });
  const box = { children: [], appendChild() {}, querySelectorAll: (sel) => sel === ".nf2-title, .nf2-block" ? [mk(["nf2-title"], "Titel", "Titel"), mk(["nf2-block"], "<b>A</b>", "A"), mk(["nf2-block"], "B", "B")] : [] };
  const fn = new Function("document", sliceFn("function noteSelectionClipboard(sel) {") + "\nreturn noteSelectionClipboard;")({ createElement: () => box });
  const r = fn({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ cloneContents: () => ({}) }) });
  ok(r && r.text === "Titel\nA\nB", `kopierter Text: ${JSON.stringify(r && r.text)}`);
  ok(r && /<h1>Titel<\/h1>/.test(r.html) && /<p><b>A<\/b><\/p>/.test(r.html), "kopiertes HTML stimmt nicht");
}

// ── 2. Alle Notizbuecher in der Sidebar ──────────────────────────────────
{
  const sb = index.slice(index.indexOf("function renderSidebar() {"), index.indexOf("tree.onclick = (e) => {"));
  ok(!/filter\(\(nb\) => isNbPinned\(nb\.id\)\)/.test(sb), "die Sidebar zeigt weiterhin nur angepinnte Notizbuecher");
  ok(/const pa = isNbPinned\(a\.id\) \? 0 : 1/.test(sb), "angepinnte Notizbuecher stehen nicht zuoberst");
  ok(/📓 Notizbücher/.test(sb) && !/Keine angepinnten Notizbücher/.test(sb), "die Ueberschrift/Leermeldung spricht noch von Anpinnen");
  ok(/isNbPinned\(nb\.id\) \? "📌" : "📓"/.test(sb), "angepinnte Notizbuecher sind nicht markiert");
}

// ── 3. ChatGPT-Aufgaben leichter erfassen ────────────────────────────────
{
  const sec = index.slice(index.indexOf("function renderChatgptTaskSection(kind, id, opts) {"), index.indexOf("function renderChatgptBacklinks(kind, id) {"));
  const inputPos = sec.indexOf('data-action="cgt-inline-input"'), bodyPos = sec.indexOf('<div class="cgt-body"');
  ok(inputPos > 0 && bodyPos > 0 && inputPos < bodyPos, "das Feld am Element liegt weiterhin im zugeklappten Teil");
  ok(/function chatgptAnchorSearch\(query, limit\)/.test(index), "es gibt keine Element-Suche fuer die Schnellerfassung");
  ok(/id="cgtQuickAnchor"/.test(index) && /id="cgtQuickText"/.test(index), "die Sammelansicht hat keine Schnellerfassung");
  ok(/case "cgt-quick-pick":/.test(index) && /action === "cgt-quick-text" && e\.key === "Enter"/.test(index), "Auswahl oder Enter der Schnellerfassung ist nicht verdrahtet");
  ok(/createChatgptTask\(anchor\.kind, anchor\.id, el\.value/.test(index), "die Schnellerfassung legt nicht ueber createChatgptTask (Anker-Pflicht) an");
  ok(/label:"ChatGPT-Aufgabe", onClick/.test(index) && /window\.createChatgptTask\(kind, id, t/.test(index), "das Kontextmenue hat keinen Eintrag ChatGPT-Aufgabe");
  // Die Suche wirklich ausfuehren.
  const reg = [{ kind: "organization", store: "organizations", icon: "🏛️", label: "Organisation" }, { kind: "chatgptTask", store: "chatgptTasks", icon: "🪶", label: "ChatGPT-Aufgabe", linkable: false }];
  const search = new Function("APP", "entityKindRegistry", "entityDisplayLabel", sliceFn("function chatgptAnchorSearch(query, limit) {", "") + "\nreturn chatgptAnchorSearch;")(
    { state: { data: { entities: { organizations: { o1: { id: "o1", name: "Firma X AG" }, o2: { id: "o2", name: "Andere" } }, chatgptTasks: { t1: { id: "t1", text: "Firma nachtragen" } } } } } },
    () => reg, (k, e) => e.name || e.text);
  const hits = search("firma");
  ok(hits.length === 1 && hits[0].kind === "organization" && hits[0].id === "o1", `Element-Suche liefert ${JSON.stringify(hits)}`);
  ok(search("").length === 0, "leere Suche liefert Treffer");
}

console.log(`noteflow copy/sidebar + chatgpt quick tasks: ok (${checks} Pruefungen)`);
