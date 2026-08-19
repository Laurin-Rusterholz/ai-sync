/*
 * Journal Booklet — Schreibfluss: Cursor, Absaetze, Vollbild.
 *
 * Produktionsbefund: „ich kann nicht richtig schreiben, es bricht staendig ab,
 * ich kann nicht fluessig Absaetze springen, im Vollbild treten Probleme auf."
 * Dahinter steckten fuenf unabhaengige Fehler, die sich alle gleich anfuehlen:
 *
 *  1. Ging der Fokus kurz verloren — Werkzeugleiste, Schrift-Menue, Tab-Wechsel,
 *     Vollbild — setzte der naechste Anschlag den Cursor ans TEXTENDE. Wer im
 *     dritten Absatz arbeitete, schrieb ploetzlich unten weiter.
 *  2. Der Vollbild-Knopf nahm immer den Werk-Editor (`getElementById("jbEditor")`
 *     ist nie null). Im Zeitkapsel-Editor ging damit das ausgeblendete Overlay
 *     ins Vollbild: ein schwarzer Bildschirm ueber dem Brief.
 *  3. Escape im Vollbild schloss den Editor, statt nur das Vollbild zu beenden.
 *  4. Beim Absatzwechsel rutschte die Schreibstelle unter den unteren Rand —
 *     gemessen: bei 29 von 40 neuen Absaetzen nicht mehr sichtbar.
 *  5. Die Typografie-Ersetzung lief auch bei `insertCompositionText`, also
 *     mitten in der Wortzusammensetzung der Handy-Tastatur. Jeder Eingriff
 *     bricht die laufende Komposition ab: Wort doppelt, verschluckt, Cursor weg.
 *
 * Der Test schneidet die ECHTEN Funktionen aus index.html heraus und laesst sie
 * gegen ein Mini-DOM laufen; der Rest sind Quelltext-Pruefungen an den Stellen,
 * an denen die Fehler sassen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

const jbStart = index.indexOf("// JOURNAL BOOKLET - Complete Writing Environment Module");
const jbEnd = index.indexOf('id="researchHubContainer"', jbStart);
ok(jbStart > 0 && jbEnd > jbStart, "die Modulgrenzen des Journal Booklets wurden nicht gefunden");
const jbSource = index.slice(jbStart, jbEnd);

// ══ Mini-DOM ═══════════════════════════════════════════════════════════════
// Nur so viel, wie die Absatz- und Cursor-Funktionen anfassen.
class N {
  constructor(nodeType, nodeName, text) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this._text = text || "";
    this.childNodes = [];
    this.parentNode = null;
    this.rect = null;
  }
  get textContent() {
    return this.nodeType === 3 ? this._text : this.childNodes.map((c) => c.textContent).join("");
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get classList() {
    const set = (this._cls = this._cls || new Set());
    return {
      add: (n) => set.add(n), remove: (n) => set.delete(n), contains: (n) => set.has(n),
      toggle: (n, f) => { const want = f === undefined ? !set.has(n) : !!f; if (want) set.add(n); else set.delete(n); return want; }
    };
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
  }
  detach() {
    if (this.parentNode) {
      const i = this.parentNode.childNodes.indexOf(this);
      if (i >= 0) this.parentNode.childNodes.splice(i, 1);
      this.parentNode = null;
    }
  }
  appendChild(n) { n.detach(); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    n.detach(); n.parentNode = this;
    const i = this.childNodes.indexOf(ref);
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
    return n;
  }
  getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, height: 0 }; }
}
const el = (name, kids = []) => { const n = new N(1, name); kids.forEach((k) => n.appendChild(k)); return n; };
const txt = (t) => new N(3, "#text", t);

function loadParagraphTools(sel) {
  const start = index.indexOf("  // ══ Absaetze ═");
  const end = index.indexOf("  // ══ Notbremse:", start);
  ok(start > 0 && end > start, "der Absatz-Block wurde in index.html nicht gefunden");
  const source = index.slice(start, end);

  const document = {
    getElementById: () => null,                 // keine Listener im Test
    createElement: (name) => el(name.toUpperCase()),
    execCommand: () => true
  };
  const window = { getSelection: () => sel };
  const fn = new Function(
    "document", "window", "setTimeout", "jbAutoSave", "jbSLAutoSave", "jbFocusAreaAtEnd",
    source + "\nreturn { jbEnsureBlocks: jbEnsureBlocks, jbCaretBlock: jbCaretBlock, jbKeepCaretInView: jbKeepCaretInView };"
  );
  return fn(document, window, () => {}, () => {}, () => {}, () => {});
}

// ── 1. Lose Textknoten werden zu Absaetzen ─────────────────────────────────
// Ohne Bloecke zerlegt die Eingabetaste den Text nach Browser-Gutduenken.
{
  const { jbEnsureBlocks } = loadParagraphTools(null);
  const area = el("DIV", [txt("Hallo"), el("DIV", [txt("Welt")]), txt(" und"), txt(" mehr")]);
  jbEnsureBlocks(area);
  const shape = area.childNodes.map((c) => c.nodeName + ":" + c.textContent);
  ok(shape.length === 3, `aus losem Text wurden keine sauberen Absaetze: ${shape.join(" | ")}`);
  ok(shape[0] === "DIV:Hallo", `der erste lose Textknoten steckt nicht in einem Absatz: ${shape[0]}`);
  ok(shape[2] === "DIV: und mehr",
    `zwei zusammenhaengende Textknoten wurden auseinandergerissen: ${shape[2]}`);

  const leer = el("DIV");
  jbEnsureBlocks(leer);
  ok(leer.childNodes.length === 1 && leer.firstChild.nodeName === "DIV",
    "ein leerer Schreibbereich bekommt keinen ersten Absatz — der Cursor haette keinen Ort");
}

// ── 2. Der Cursor-Absatz ist ein Absatz, nicht das ganze Schreibfeld ───────
// Ein frisch angelegter, leerer Absatz hat kein eigenes Cursor-Rechteck. Der
// frueher naheliegende Rueckgriff auf parentElement lieferte dort das gesamte
// Schreibfeld — und das Nachscrollen rechnete mit einem 700px hohen „Cursor".
{
  const area = el("DIV");
  const p1 = el("DIV", [txt("Erster")]);
  const p2 = el("DIV", [txt("Zweiter")]);
  area.appendChild(p1); area.appendChild(p2);
  const caret = p2.firstChild;
  const sel = { rangeCount: 1, getRangeAt: () => ({ startContainer: caret, startOffset: 0 }) };
  const { jbCaretBlock } = loadParagraphTools(sel);
  ok(jbCaretBlock(area) === p2, "der Cursor-Absatz wird nicht gefunden");

  // Cursor direkt am Schreibbereich (leerer neuer Absatz): der Block ist das
  // Kind an dieser Stelle — niemals der Schreibbereich selbst.
  const selArea = { rangeCount: 1, getRangeAt: () => ({ startContainer: area, startOffset: 1 }) };
  const tools2 = loadParagraphTools(selArea);
  ok(tools2.jbCaretBlock(area) === p2,
    "steht der Cursor am Schreibbereich, wird nicht auf den betroffenen Absatz aufgeloest");
}

// ── 3. Beim Absatzwechsel bleibt die Schreibstelle sichtbar ───────────────
// Gescrollt wird nach der SCHREIBSTELLE, nicht nach dem ganzen Absatz: bei
// einem langen Absatz hiesse das sonst „Cursor oben, nachgescrollt bis zum
// Ende" — die Ansicht springt vom Text weg, obwohl alles sichtbar war.
{
  const area = el("DIV");
  const p = el("DIV", [txt("Neuer Absatz")]);
  area.appendChild(p);
  const box = el("DIV");
  box.rect = { top: 50, bottom: 700, height: 650 };
  box.scrollTop = 0;
  area.closest = () => box;
  let caretRect = null;                       // was der Browser fuer den Cursor meldet
  const sel = {
    rangeCount: 1,
    getRangeAt: () => ({
      startContainer: p.firstChild, startOffset: 0,
      getClientRects: () => (caretRect ? [caretRect] : []),
      getBoundingClientRect: () => caretRect || { top: 0, bottom: 0, width: 0, height: 0 }
    })
  };
  const { jbKeepCaretInView } = loadParagraphTools(sel);
  const pad = Math.min(180, 650 * 0.28);

  // a) Schreibstelle unter dem sichtbaren Bereich -> es wird nachgezogen.
  caretRect = { top: 690, bottom: 720, width: 0, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop > 0, "die Schreibstelle liegt unter dem Rand und es wird nicht nachgescrollt");
  ok(Math.round(box.scrollTop) === Math.round(720 - (700 - pad)),
    `es wird zu weit oder zu kurz gescrollt (scrollTop=${box.scrollTop})`);

  // b) Schreibstelle mitten im Blick -> nichts anfassen, kein Ruckeln.
  box.scrollTop = 0;
  caretRect = { top: 300, bottom: 330, width: 0, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop === 0, "eine sichtbare Schreibstelle loest trotzdem ein Scrollen aus");

  // c) Schreibstelle oberhalb des Rands (Rueckwaerts-Sprung) -> nachziehen.
  box.scrollTop = 400;
  caretRect = { top: 10, bottom: 40, width: 0, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop < 400, "eine Schreibstelle oberhalb des Rands wird nicht sichtbar gemacht");

  // d) Langer Absatz, Cursor OBEN darin: der Absatz reicht weit nach unten, die
  //    Schreibstelle steht aber bequem im Blick -> nicht scrollen.
  box.scrollTop = 0;
  p.rect = { top: 100, bottom: 2000, height: 1900 };
  caretRect = { top: 110, bottom: 140, width: 0, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop === 0,
    "bei einem langen Absatz wird bis zu dessen Ende gescrollt statt zur Schreibstelle — die Ansicht springt vom Text weg");

  // e) Leerer Absatz (kein Cursor-Rechteck) -> Rueckfall auf den Absatz.
  box.scrollTop = 0;
  caretRect = null;
  p.rect = { top: 690, bottom: 720, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop > 0,
    "in einem leeren Absatz gibt es kein Cursor-Rechteck — ohne Rueckfall auf den Absatz wird gar nicht mehr nachgescrollt");
}

// ── 4. Nur EIN Scroll-Behaelter ────────────────────────────────────────────
// Lagen zwei ineinander, scrollte der Browser mal den einen, mal den anderen.
{
  ok(/\.jb-editor-body\{[^}]*overflow:hidden/.test(index),
    ".jb-editor-body scrollt weiterhin selbst — zwei Scroll-Behaelter ineinander lassen die Schreibstelle springen");
  ok(/\.jb-editor-content\{[^}]*overflow-y:auto/.test(index),
    "der Schreibbereich hat keinen eigenen Scroll-Behaelter mehr");
}

// ── 5. Der Cursor kehrt an SEINE Stelle zurueck, nicht ans Textende ───────
{
  ok(jbSource.includes("function jbRestoreCaret(area)"), "die Cursor-Rueckkehr fehlt");
  ok(/_jbCaretRange = r\.cloneRange\(\)/.test(jbSource),
    "die zuletzt besuchte Schreibstelle wird nicht gemerkt");
  const rescue = jbSource.slice(jbSource.indexOf("function jbActiveWritingArea()"), jbSource.indexOf("// ══ Absaetze"));
  ok(/jbRestoreCaret\(area\);/.test(rescue),
    "die Fokus-Rettung setzt den Cursor weiterhin blind ans Textende — mitten im Text weiterzuschreiben ist damit unmoeglich");
  ok(/e\.key\.length !== 1/.test(rescue) && /isContentEditable/.test(rescue),
    "die Fokus-Rettung greift wieder ausserhalb druckbarer Zeichen bzw. aus fremden Feldern");
  // Der Rueckfall aufs Textende bleibt fuer den Fall, dass die Stelle weg ist.
  const restore = jbSource.slice(jbSource.indexOf("function jbRestoreCaret(area)"), jbSource.indexOf("// ══ Absaetze"));
  ok(/area\.contains\(r\.startContainer\)/.test(restore) && /jbFocusAreaAtEnd\(area\)/.test(restore),
    "eine inzwischen geloeschte Schreibstelle faellt nicht sauber auf das Textende zurueck");
}

// ── 6. Vollbild trifft das Overlay, das wirklich offen ist ────────────────
{
  ok(!/const c = document\.getElementById\("jbEditor"\) \|\| document\.getElementById\("jbSelfLetterEditor"\)/.test(jbSource),
    "der Vollbild-Knopf nimmt wieder pauschal den Werk-Editor — im Zeitkapsel-Editor geht damit das ausgeblendete Overlay ins Vollbild");
  ok(jbSource.includes("function jbFullscreenHost()"), "jbFullscreenHost() fehlt");
  const host = jbSource.slice(jbSource.indexOf("function jbFullscreenHost()"), jbSource.indexOf("function jbFullscreenEl()"));
  ok(/classList\.contains\("active"\)/.test(host),
    "jbFullscreenHost prueft nicht, welches Overlay ueberhaupt offen ist");
  ok(/webkitRequestFullscreen/.test(jbSource) && /webkitExitFullscreen/.test(jbSource),
    "ohne die webkit-Fassungen bleibt der Knopf auf Safari wirkungslos");
  ok(/document\.addEventListener\("fullscreenchange", jbOnFullscreenChange\)/.test(jbSource),
    "der Vollbildwechsel wird nicht beobachtet — Fokus und Meldungen bleiben draussen");
  const change = jbSource.slice(jbSource.indexOf("function jbOnFullscreenChange()"), jbSource.indexOf("function jbOnFullscreenChange()") + 900);
  ok(/jbRestoreCaret\(area\)/.test(change),
    "nach dem Vollbildwechsel kehrt der Cursor nicht in den Text zurueck — der naechste Anschlag verpufft");
  ok(/fs\.appendChild\(toast\)/.test(change),
    "die Meldungen bleiben im Vollbild unsichtbar (was ausserhalb des Vollbild-Elements liegt, zeichnet der Browser nicht)");
  ok(/\.jb-editor:fullscreen[^{]*\{[^}]*height:100dvh/.test(index),
    "im Vollbild bekommt das Editor-Overlay keine eigene Groesse — rundherum bleibt ein Rand stehen");
}

// ── 7. Escape beendet im Vollbild nur das Vollbild ────────────────────────
{
  const esc = jbSource.slice(jbSource.indexOf("  // Escape key handler"), jbSource.indexOf("  // Escape key handler") + 900);
  ok(esc.indexOf("jbFullscreenEl()") > 0 && esc.indexOf("jbFullscreenEl()") < esc.indexOf("jbCloseReadView()"),
    "Escape schliesst im Vollbild weiterhin den ganzen Editor — man wollte nur die Bildschirmfuellung verlassen");
  ok(/window\.jbExitFullscreen\(\);/.test(jbSource.slice(jbSource.indexOf("window.jbCloseEditor = function()"), jbSource.indexOf("window.jbCloseEditor = function()") + 1200)),
    "beim Schliessen des Editors bleibt das Vollbild stehen — dann steht das Archiv bildschirmfuellend da");
}

// ── 8. Handy-Tastatur: waehrend der Wortzusammensetzung nichts anfassen ───
{
  ok(!/insertCompositionText/.test(jbSource.slice(jbSource.indexOf("window.jbOnWrite = function"), jbSource.indexOf("window.jbOnWrite = function") + 700).replace(/\/\/[^\n]*/g, "")),
    "jbOnWrite schreibt weiterhin waehrend der Komposition in den Text — die Handy-Tastatur verliert dabei das Wort");
  ok(/var _jbComposing = false;/.test(jbSource) && /compositionstart/.test(jbSource) && /compositionend/.test(jbSource),
    "die Kompositions-Wache fehlt");
  ok(/if \(_jbComposing\) return false;/.test(jbSource),
    "jbApplyTypography ersetzt weiterhin mitten in der laufenden Komposition");
  const slRow = index.split("\n").find((l) => l.includes('id="jbSLArea"'));
  ok(slRow && !slRow.includes("insertCompositionText") && slRow.includes("isComposing"),
    "der Zukunftsbrief-Schreibbereich nimmt auf die Komposition keine Ruecksicht");
}

// ── 9. Einfuegen wie in einem Textfeld ────────────────────────────────────
{
  const paste = jbSource.slice(jbSource.indexOf('area.addEventListener("paste"'), jbSource.indexOf('["jbEditor", "jbSelfLetterEditor"]'));
  ok(paste.includes('cb.getData("text/plain")') && paste.includes("e.preventDefault()"),
    "eingefuegter Inhalt bringt weiterhin fremdes HTML mit — Schriftgroessen, Farben und Bilder als Daten-URL landen im Werk und in jeder Sicherung");
  ok(paste.includes('document.execCommand("insertText"'),
    "beim Einfuegen bleibt der Rueckgaengig-Verlauf des Browsers nicht erhalten");
  ok(paste.includes("jbEnsureBlocks(area)"),
    "eingefuegter Text landet als loser Knoten im Schreibbereich statt in Absaetzen");
}

// ── 10. Der Voll-Snapshot faellt nicht mehr in den Satz ───────────────────
// JSON.stringify des GESAMTEN Datenbestands + localStorage-Write laufen synchron
// auf demselben Faden wie die Anschlaege.
{
  const start = index.indexOf("var _localSaveTimer = null;");
  const local = index.slice(start, index.indexOf("function flushLocalSave()", start));
  ok(/remoteSaveOnHold\(\)/.test(local),
    "das lokale Sichern nimmt beim Schreiben keine Ruecksicht — der Voll-Snapshot faellt weiterhin mitten in den Satz");
  ok(/LOCAL_SAVE_WRITING_MS/.test(local) && /LOCAL_SAVE_IDLE_MS/.test(local),
    "die beiden Takte (schreibend / ruhend) sind nicht getrennt benannt");
  ok(index.includes("var LOCAL_SAVE_WRITING_MS = 5000;"),
    "der Schreib-Takt fehlt oder wurde veraendert, ohne den Test anzupassen");
  ok(/window\.addEventListener\("pagehide", flushLocalSave\)/.test(index),
    "ohne die Notbremse waere der ruhigere Takt ein Datenverlust-Risiko");
}

// ── 11. Eine Denkpause ist kein Sync-Signal ───────────────────────────────
{
  ok(/var JB_TYPING_WINDOW_MS = 6000;/.test(jbSource),
    "das Tippfenster fehlt — nach 2,5 s Nachdenken lief wieder mitten in der Pause der volle Pull-Merge-Push");
  ok(/Date\.now\(\) - _jbLastKeystroke < JB_TYPING_WINDOW_MS/.test(jbSource),
    "jbIsTyping rechnet nicht mit dem Tippfenster");
}

// ── 12. Keine unsichtbare Wortzahl-Schleife mehr ──────────────────────────
// Sie lief alle 1,5 s durch den gesamten Schreibtext und las offsetParent (das
// erzwingt ein Layout) — sichtbar war sie nie: z-index 100 unter einem Overlay
// mit z-index 10050.
{
  ok(!/counter\.id = 'editorWordCounter'/.test(index),
    "die verdeckte Wortzahl-Schleife laeuft wieder mit");
  ok(/function jbUpdateWritingMeta\(\)/.test(jbSource),
    "die Wortzahl im Editor-Kopf fehlt — dann waere die Anzeige ersatzlos weg");
}

// ── 13. Ein Klick neben die Zeile landet IN der Zeile ─────────────────────
// Die Textspalte ist schmaler als die Schreibflaeche. Ein Klick rechts neben
// einen frueheren Absatz — die natuerlichste Bewegung beim Zurueckarbeiten —
// warf den Cursor ans Ende des ganzen Werks. Nachgemessen in Chromium: vorher
// „Absatz 0 (Element DIV)" = Textende, jetzt „Absatz 2 @12".
{
  const click = jbSource.slice(jbSource.indexOf('content.addEventListener("mousedown"'), jbSource.indexOf('  // ══ Notbremse:'));
  ok(jbSource.includes("function jbCaretFromPoint(x, y, area)"),
    "jbCaretFromPoint fehlt — ohne sie gibt es nur ‚ans Textende'");
  ok(/jbCaretFromPoint\(e\.clientX, e\.clientY, area\)/.test(click),
    "der Klick in die freie Flaeche setzt den Cursor weiterhin blind ans Textende");
  ok(/lastElementChild/.test(click) && /below/.test(click),
    "es wird nicht unterschieden, ob unter den Text oder neben eine Zeile geklickt wurde");
  ok(/jbFocusAreaAtEnd\(area\)/.test(click),
    "unter dem letzten Absatz (und wenn keine Stelle bestimmbar ist) fehlt der Rueckfall aufs Textende");
  const fromPoint = jbSource.slice(jbSource.indexOf("function jbCaretFromPoint(x, y, area)"), jbSource.indexOf('["jbEditor", "jbSelfLetterEditor"]'));
  ok(/Math\.min\(Math\.max\(x, b\.left \+ 1\), b\.right - 1\)/.test(fromPoint),
    "die Klickstelle wird nicht in die Textspalte hineingezogen — seitlich daneben findet der Browser keine Textstelle");
  ok(/caretRangeFromPoint/.test(fromPoint) && /caretPositionFromPoint/.test(fromPoint),
    "nur eine der beiden Browser-Fassungen wird genutzt");
}

// ── 14. Ruhe-Modus: es ist immer ein Absatz hervorgehoben ─────────────────
// Steht der Cursor direkt am Schreibfeld (nach einem Klick neben den Text,
// nach Alles-Loeschen), fand die Absatzsuche nichts — im Ruhe-Modus lag damit
// der GESAMTE Text bei 32 % Deckkraft. Genau das ist „Ruhe-Modus kaputt".
{
  const start = index.indexOf("  function jbWordCount(text) {");
  const end = index.indexOf("  function jbToast(msg) {", start);
  ok(start > 0 && end > start, "der Schreibkomfort-Block wurde nicht gefunden");

  const area = el("DIV", [el("DIV", [txt("eins")]), el("DIV", [txt("zwei")]), el("DIV", [txt("drei")])]);
  const editor = el("DIV");
  editor.classList.add("jb-calm");
  let range = { startContainer: area, startOffset: 3 };     // Cursor am Feld, hinter allem
  const doc = {
    getElementById: (id) => ({ jbEditorArea: area, jbEditor: editor }[id] || null),
    addEventListener: () => {},
    createElement: () => el("DIV"),
    createRange: () => ({ setStart() {}, setEnd() {} }),
    execCommand: () => true
  };
  const win = {
    getSelection: () => ({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range, removeAllRanges() {}, addRange() {} }),
    matchMedia: () => ({ matches: false })
  };
  const fn = new Function(
    "document", "window", "localStorage", "requestAnimationFrame", "setTimeout", "clearTimeout",
    "jbAutoSave", "jbSaveCurrentDoc", "_jbAutoSaveTimer",
    index.slice(start, end) + "\nreturn jbMarkCurrentParagraph;"
  );
  const mark = fn(doc, win, { getItem: () => null, setItem() {} }, (f) => f(), () => 0, () => {}, () => {}, () => {}, null);

  mark();
  ok(area.childNodes[2].classList.contains("jb-here"),
    "steht der Cursor am Schreibfeld statt in einem Absatz, wird gar kein Absatz hervorgehoben — im Ruhe-Modus verdunkelt sich dann der ganze Text");
  range = { startContainer: area, startOffset: 1 };
  mark();
  ok(area.childNodes[1].classList.contains("jb-here") && !area.childNodes[2].classList.contains("jb-here"),
    "die Hervorhebung folgt der Cursorstelle am Schreibfeld nicht");
}

// ── 15. Ruhe-Modus bleibt ohne Mauszeiger bedienbar ───────────────────────
{
  ok(/@media \(hover:none\)\{\.jb-editor\.jb-calm \.jb-editor-header\{opacity:\.55\}\}/.test(index),
    "auf dem Handy (kein :hover) bleibt die Werkzeugleiste im Ruhe-Modus bei 12 % — unsichtbar und unauffindbar");
  ok(/\.jb-editor\.jb-calm \.jb-editor-header:hover,\.jb-editor\.jb-calm \.jb-editor-header:focus-within\{opacity:1\}/.test(index),
    "die Werkzeugleiste kommt bei Hover/Beruehrung nicht mehr zurueck");
}

// ── 16. Globale Tastenkuerzel schweigen, solange jemand schreibt ──────────
// Strg+Z war im Editor tot: preventDefault nahm dem Browser das Rueckgaengig
// weg und stattdessen lief der App-weite Schritt. Strg+1..5 sprang mitten im
// Satz in eine andere Ansicht.
{
  const hStart = index.indexOf("  // Global shortcuts – dynamisch aus Settings");
  const h = index.slice(hStart, index.indexOf('  // Escape: Modal oder SlidePanel schließen', hStart));
  ok(hStart > 0 && h.length > 0, "der globale Kuerzel-Handler wurde nicht gefunden");
  ok(/var _inField =/.test(h) && /isContentEditable/.test(h),
    "der globale Kuerzel-Handler prueft nicht, ob gerade in ein Feld geschrieben wird");
  ok(h.indexOf("if (_inField)") < h.indexOf('_matchSC("undo", e)'),
    "die Feld-Pruefung liegt hinter dem Rueckgaengig-Kuerzel — Strg+Z bliebe im Editor tot");
  ok(h.indexOf("if (_inField)") < h.indexOf('_matchSC("gotoDash", e)'),
    "die Navigations-Kuerzel greifen weiterhin mitten im Satz");
}

// ── 17. Absaetze zusammenfuehren hinterlaesst keine Aussehens-Spans ───────
// Chrome konserviert beim Verschmelzen das Aussehen des verschobenen Textes in
// einem <span style="…"> — text-wrap-mode beim Feinsatz, font-size beim
// Zusammenfuehren mit einer Ueberschrift. Beides landete im gespeicherten Werk.
{
  ok(!/\.jb-richtext\{[^}]*text-wrap:pretty/.test(index),
    "text-wrap:pretty steht wieder im Schreibbereich — jedes Zusammenfuehren zweier Absaetze hinterlaesst dann ein <span style=\"text-wrap-mode:initial\">");
  ok(/var JB_MERGE_PROP = \/\^\(font-size/.test(jbSource),
    "die Aufraeum-Liste kennt font-size nicht — Text, den man in eine Ueberschrift zieht, behaelt seine alte Groesse");
  ok(/jbStripWrapSpans\(block \|\| area, true\)/.test(jbSource),
    "beim Zusammenfuehren wird die weite Aufraeum-Liste nicht benutzt");
  ok(/jbStripWrapSpans\(area\);/.test(jbSource) || /jbStripWrapSpans\(area\)/.test(jbSource),
    "beim Oeffnen eines Werks wird gar nicht mehr aufgeraeumt");
  ok(!/jbStripWrapSpans\(area, true\)/.test(jbSource),
    "beim Oeffnen wird die weite Liste benutzt — eine gewollte Schriftgroesse aus einem alten Werk ginge dabei verloren");
  ok(/function jbStripWrapSpans\(root, wide\)/.test(jbSource) && /sp\.className \|\| !jbIsArtifactStyle/.test(jbSource),
    "es werden Spans mit eigenen Formatierungen mit entfernt — das waere Datenverlust");
  const afterDel = jbSource.slice(jbSource.indexOf("function jbAfterDelete(area)"), jbSource.indexOf("function jbAfterDelete(area)") + 1600);
  ok(/jbStripWrapSpans\(block \|\| area, true\)/.test(afterDel),
    "nach dem Loeschen wird der betroffene Absatz nicht aufgeraeumt");
  ok(/function jbEnsureTypingBlock\(area\)/.test(jbSource) && /it\.indexOf\("insert"\) === 0\) jbEnsureTypingBlock/.test(jbSource),
    "ein leergeraeumter Schreibbereich (Alles markieren + Loeschen) bekommt beim Weiterschreiben keinen Absatz zurueck");
  ok(!/area\.innerHTML = "<div><br><\/div>"/.test(afterDel),
    "beim Loeschen wird weiterhin innerHTML neu geschrieben — das kostet einen zusaetzlichen Rueckgaengig-Schritt");
  ok(/it\.indexOf\("delete"\) === 0\) jbAfterDelete\(area\)/.test(jbSource),
    "der Aufraeumer haengt nicht am Loesch-Ereignis");
}

// ── 18. Aus dem leeren Zitat fuehrt die Eingabetaste heraus ───────────────
{
  const enter = jbSource.slice(jbSource.indexOf('area.addEventListener("keydown"'), jbSource.indexOf('area.addEventListener("paste"'));
  ok(/nodeName === "BLOCKQUOTE"/.test(enter) && /textContent \|\| ""\)\.trim\(\)/.test(enter),
    "ein leeres Zitat haengt beim Enter das naechste Zitat an — aus dem Zitat kommt man nur noch ueber die Werkzeugleiste heraus");
  ok(/e\.shiftKey/.test(enter),
    "Shift+Enter (Zeilenumbruch) wird mitbehandelt, obwohl es das Zitat nicht verlassen soll");
}

// ── 19. Der Abgleich darf keine Journal-Einträge verlieren ────────────────
// mergeData() baut sein Ergebnis aus einer Kopie des LOKALEN Standes und ergaenzt
// nur die Bereiche, fuer die es einen Zweig gibt. Fuer das Journal gab es keinen:
// ein auf dem Handy geschriebener Eintrag verschwand beim naechsten Abgleich des
// Rechners — und dessen Push loeschte ihn auch auf dem Server. Der Test laesst
// die ECHTE Funktion gegen zwei Datenstaende laufen.
{
  const start = index.indexOf("function mergeData(local, remote) {");
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, "mergeData() wurde in index.html nicht gefunden");
  const source = index.slice(start, end);

  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog",
    "flattenDeleteLog", "mergeEntity", "entityTimestamp", "console",
    source + "\nreturn mergeData;"
  );
  const mergeData = fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {} }
  );

  const doc = (id, t, ts) => ({ id, type: "diary", title: t, content: "<div>" + t + "</div>", createdAt: ts, updatedAt: ts });
  const local = {
    entities: { tasks: {} },
    journal: { documents: [doc("a", "Am Rechner", 1000)], selfLetters: [], topics: [], contacts: [], settings: { name: "Ich" } }
  };
  const remote = {
    entities: { tasks: {} },
    journal: {
      documents: [doc("b", "Am Handy", 2000), doc("a", "Am Rechner (aelter)", 500)],
      selfLetters: [{ id: "L1", title: "Brief", updatedAt: 10, delivered: true }],
      topics: [{ id: "t1", text: "Idee", createdAt: 5 }], contacts: [], settings: { street: "Hauptstrasse" }
    }
  };
  const merged = mergeData(local, remote);
  const ids = (merged.journal.documents || []).map((d) => d.id).sort();
  ok(ids.join(",") === "a,b",
    `der Abgleich verliert Journal-Werke: uebrig blieben [${ids.join(", ")}] statt [a, b]`);
  const a = merged.journal.documents.find((d) => d.id === "a");
  ok(a.title === "Am Rechner",
    `bei gleicher Id gewinnt der aeltere Stand: "${a.title}"`);
  ok((merged.journal.selfLetters || []).length === 1 && merged.journal.selfLetters[0].delivered === true,
    "Zeitkapsel-Briefe der Gegenseite gehen verloren oder verlieren ihren Zustellvermerk");
  ok((merged.journal.topics || []).length === 1, "Ideen der Gegenseite gehen verloren");
  ok(merged.journal.settings.name === "Ich" && merged.journal.settings.street === "Hauptstrasse",
    "die Absenderangaben werden nicht zusammengefuehrt");

  // Geraet ohne eigenes Journal: der Bestand der Gegenseite muss ankommen.
  const leer = mergeData({ entities: { tasks: {} } }, remote);
  ok((leer.journal?.documents || []).length === 2,
    "auf einem Geraet ohne eigenes Journal loescht der Abgleich den gesamten Bestand");
}

// ── 20. Der Fokus bleibt dort, wo geschrieben wird ────────────────────────
// focus() auf einem contenteditable setzt den Cursor an den TEXTANFANG. Und ein
// Auswahlfeld behaelt nach der Wahl mit der Maus die Tastatur: getippte Zeichen
// landeten in seiner Schnellsuche, die still Schrift bzw. Empfaenger umstellte.
{
  const titleRow = index.split("\n").find((l) => l.includes('id="jbEditorTitle"'));
  ok(titleRow && /jbFocusText\('jbEditorArea'\)/.test(titleRow),
    "die Eingabetaste im Titel springt weiterhin per focus() in den Text — und damit an dessen Anfang statt an die Schreibstelle");
  const slRow = index.split("\n").find((l) => l.includes('id="jbSLTitle"'));
  ok(slRow && /jbFocusText\('jbSLArea'\)/.test(slRow), "dasselbe fehlt im Zeitkapsel-Editor");

  const restore = jbSource.slice(jbSource.indexOf("function jbRestoreCaret(area)"), jbSource.indexOf("function jbRestoreCaret(area)") + 1200);
  ok(restore.indexOf("var had =") < restore.indexOf("area.focus()"),
    "jbRestoreCaret fragt die Auswahl erst NACH dem Fokussieren ab — dann sieht es den Cursor, den der Browser gerade an den Textanfang gesetzt hat");

  const font = jbSource.slice(jbSource.indexOf("window.jbUpdateFont = function()"), jbSource.indexOf("window.jbUpdateFont = function()") + 900);
  ok(/jbRestoreCaret\(ed\)/.test(font),
    "nach der Schriftwahl behaelt das Auswahlfeld die Tastatur — Getipptes landet in seiner Schnellsuche statt im Text");
  const slFont = jbSource.slice(jbSource.indexOf("window.jbUpdateSLFont = function()"), jbSource.indexOf("window.jbUpdateSLFont = function()") + 700);
  ok(/jbRestoreCaret\(ed\)/.test(slFont), "dasselbe fehlt bei der Schriftwahl im Zeitkapsel-Editor");
  const recipientRow = index.split("\n").find((l) => l.includes('id="jbEditorRecipient"'));
  ok(recipientRow && /jbFocusText\('jbEditorArea'\)/.test(recipientRow),
    "nach der Empfaengerwahl bleibt die Tastatur im Auswahlfeld — die Schnellsuche verstellt dort still den Empfaenger");

  // Auswahlfelder duerfen weder den Schirm noch die Fokus-Rettung blockieren.
  const shield = jbSource.slice(jbSource.indexOf("function jbKeyShield(e)"), jbSource.indexOf("function jbKeyShield(e)") + 700);
  ok(!/tagName === "SELECT"/.test(shield),
    "der Tastatur-Schirm behandelt Auswahlfelder wie Schreibfelder und haelt die Tasten dort fest");
  const rescue = jbSource.slice(jbSource.indexOf("function jbActiveWritingArea()"), jbSource.indexOf("// ══ Absaetze"));
  ok(!/a\.tagName === "SELECT"/.test(rescue),
    "die Fokus-Rettung ueberspringt Auswahlfelder — dort getippte Zeichen kommen nie im Text an");

  for (const fnName of ["window.jbFormat = function(cmd, val)", "window.jbFormatSL = function(cmd, val)"]) {
    const body = jbSource.slice(jbSource.indexOf(fnName), jbSource.indexOf(fnName) + 600);
    ok(/tagName === "INPUT" \|\| _act/.test(body) || /tagName === "INPUT"/.test(body),
      `${fnName}: Fett/Kursiv aus dem Titel heraus reisst den Cursor weiterhin in den Fliesstext`);
  }
}

// ── 21. Datenwege: Import, reiner Text, leerer Brief, Geist-Eintraege ─────
{
  ok(/return d\.innerHTML\.replace\(\/"\/g, "&quot;"\)/.test(jbSource),
    "jbEsc schuetzt das Anfuehrungszeichen nicht — ein Name mit Anfuehrungszeichen bricht aus dem value-Attribut aus und wird still abgeschnitten");

  const imp = jbSource.slice(jbSource.indexOf("window.jbImportData = function(e)"), jbSource.indexOf("window.jbImportData = function(e)") + 2200);
  ok(/Object\.assign\(\{\}, imported, \{/.test(imp),
    "der Import baut das Journal aus einem festen Bauplan — alles Weitere (z. B. der KI-Verlauf) faellt dabei weg");
  ok(/Array\.isArray\(imported\.documents\)/.test(imp),
    "der Import prueft nicht mehr, ob die Datei ueberhaupt ein Journal ist");

  const open = jbSource.slice(jbSource.indexOf("function jbOpenDocument(id)"), jbSource.indexOf("function jbOpenDocument(id)") + 1600);
  ok(/loadContent\.indexOf\("<"\) === -1/.test(open),
    "ein Werk aus reinem Text verliert beim Oeffnen alle Zeilenumbrueche — und der naechste Anschlag sichert diesen Verlust");

  const send = jbSource.slice(jbSource.indexOf("window.jbSendSelfLetter = function()"), jbSource.indexOf("window.jbSendSelfLetter = function()") + 900);
  ok(/textContent \|\| ""\)\.replace\(\/\\u00A0\/g, " "\)\.trim\(\)/.test(send),
    "ein Brief aus lauter Leerzeichen reist weiterhin in die Zukunft");

  const openBooklet = jbSource.slice(jbSource.indexOf("function openJournalBooklet()"), jbSource.indexOf("function openJournalBooklet()") + 900);
  ok(/!jbEntryIsEmpty\(d\)/.test(openBooklet),
    "nie beschriebene Werke bleiben nach einem Neuladen als Unbenannt im Archiv stehen");
}

// ── 22. Exporte stehen auf weissem Papier ─────────────────────────────────
// Die Oberflaechen-Variablen richten sich nach dem Erscheinungsbild der App —
// auf einer weissen Seite ergibt das im hellen Bild hellgrauen Text auf Weiss.
{
  const pdf = jbSource.slice(jbSource.indexOf("function _jbDoPDF(doc)"), jbSource.indexOf("function _jbDoPDF(doc)") + 3000);
  ok(!/color:var\(--panel\)/.test(pdf) && !/background:var\(--text\)/.test(pdf),
    "der PDF-Export malt weiterhin mit den Farben der Oberflaeche auf weisses Papier");
  ok(/jbEditorTitle"\)\?\.value/.test(pdf),
    "der PDF-Export nimmt den zuletzt gesicherten Titel, waehrend der Text live aus dem Schreibbereich kommt");
  const htmlExp = jbSource.slice(jbSource.indexOf("window.jbExportHTML = function()"), jbSource.indexOf("window.jbExportHTML = function()") + 2600);
  ok(!/var\(--/.test(htmlExp),
    "der HTML-Export nutzt Farb-Variablen, die es ausserhalb der App gar nicht gibt");
  ok(/\.jb-read-view \.jb-richtext\{padding-bottom:0/.test(index),
    "die Leseansicht erbt weiterhin den Fussraum des Schreibbereichs — hinter einem kurzen Brief steht eine halbe leere Seite");
}

// ── 23. „An Mobile senden" sagt, warum es nicht ging ──────────────────────
// Produktionsbefund: der Knopf zeigte „⚠ Local only" — und sonst nichts. Der
// Grund stand bestenfalls in der Konsole. Dazu kamen zwei echte Fehler: die
// Anfrage ging OHNE Auth-Kopfzeile hinaus (der uebrige Abgleich schickt sie
// mit; ist SYNC_AUTH_TOKEN gesetzt, antwortet der Server mit 401), und sie
// sprach ausschliesslich den Netlify-Endpunkt an, waehrend der regulaere
// Abgleich ueber Firebase/RTDB laeuft.
{
  const send = jbSource.slice(jbSource.indexOf("window.jbSendToMobile = async function()"),
    jbSource.indexOf("window.jbCloseEditor = function()"));
  ok(send.length > 500, "jbSendToMobile wurde nicht gefunden");

  ok(/function jbAuthHeaders\(\)/.test(jbSource),
    "die Auth-Kopfzeile fehlt — buildStorageAuthHeaders() der Hauptapp liegt in einer fremden Kapsel und ist hier NICHT erreichbar");
  ok(!/buildStorageAuthHeaders\(/.test(send),
    "es wird weiterhin buildStorageAuthHeaders() aufgerufen — die Funktion liegt in einer fremden Kapsel, der Aufruf lief ins Leere");
  ok(/const _authHdrs = jbAuthHeaders\(\);/.test(send) && /headers: _authHdrs/.test(send),
    "das Holen geht weiterhin ohne Auth-Kopfzeile hinaus");
  ok(/'Content-Type': 'application\/json' \}, jbAuthHeaders\(\)\)/.test(send),
    "das Senden geht weiterhin ohne Auth-Kopfzeile hinaus");

  ok(/window\.remotePutByKey\(blobKey, payload, \{ force: true/.test(send),
    "scheitert der eine Endpunkt, gibt es keinen Rueckfall auf den regulaeren Abgleich");
  ok(!/await remotePut\(/.test(send),
    "der Rueckfall ruft remotePut() auf — die Funktion liegt in einer fremden Kapsel, die Bedingung davor ist immer falsch und der Rueckfall lief nie");
  ok(/pushError = jbPushReason\(putResp\.status, hint\)/.test(send),
    "der Statuscode wird nicht in einen Satz uebersetzt");
  ok(/btn\.title = 'Nicht gesendet: '/.test(send),
    "der Knopf verraet den Grund nicht");
  ok(/navigator\.onLine/.test(send),
    "ein Abbruch ohne Verbindung meldet weiterhin nur „Failed to fetch\"");

  // Die Uebersetzung selbst laeuft als ECHTE Funktion.
  const start = jbSource.indexOf("function jbPushReason(status, hint)");
  const end = jbSource.indexOf("\n  }", start) + 4;
  const jbPushReason = new Function(jbSource.slice(start, end) + "\nreturn jbPushReason;")();
  ok(/401/.test(jbPushReason(401, "")) && /Auth-Token/.test(jbPushReason(401, "")),
    "401 wird nicht als Zugangsproblem erklaert");
  ok(/404/.test(jbPushReason(404, "")) && /blob-put/.test(jbPushReason(404, "")),
    "404 nennt nicht den fehlenden Endpunkt");
  ok(/gross/.test(jbPushReason(413, "")), "413 wird nicht als zu grosser Datenstand erklaert");
  ok(/Server-Fehler/.test(jbPushReason(500, "Datenbank kaputt")) && /Datenbank kaputt/.test(jbPushReason(500, "Datenbank kaputt")),
    "bei 500 fehlt die Begruendung des Servers");
  // Der haeufigste 500er ist ein abgelaufener Server-Zugang — der bekommt eine
  // Handlungsanweisung statt einer Google-Fehlernummer.
  for (const echt of ["Firebase OAuth-Refresh fehlgeschlagen: reauth related error (invalid_rapt)",
                      "Firebase Admin ist nicht konfiguriert."]) {
    ok(/FIREBASE_SERVICE_ACCOUNT_JSON/.test(jbPushReason(500, echt)),
      `der abgelaufene Server-Zugang wird nicht erklaert: ${jbPushReason(500, echt)}`);
  }
}

console.log(`journal writing flow: ok (${checks} Pruefungen)`);
