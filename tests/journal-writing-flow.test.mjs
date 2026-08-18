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
{
  const area = el("DIV");
  const p = el("DIV", [txt("Neuer Absatz")]);
  area.appendChild(p);
  const box = el("DIV");
  box.rect = { top: 50, bottom: 700, height: 650 };
  box.scrollTop = 0;
  area.closest = () => box;
  const sel = { rangeCount: 1, getRangeAt: () => ({ startContainer: p.firstChild, startOffset: 0 }) };
  const { jbKeepCaretInView } = loadParagraphTools(sel);

  // a) Absatz unter dem sichtbaren Bereich → es wird nachgezogen.
  p.rect = { top: 690, bottom: 720, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop > 0, "der neue Absatz liegt unter dem Rand und es wird nicht nachgescrollt");
  const pad = Math.min(180, 650 * 0.28);
  ok(Math.round(box.scrollTop) === Math.round(720 - (700 - pad)),
    `es wird zu weit oder zu kurz gescrollt (scrollTop=${box.scrollTop})`);

  // b) Absatz mitten im Blick → nichts anfassen, kein Ruckeln.
  box.scrollTop = 0;
  p.rect = { top: 300, bottom: 330, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop === 0, "ein sichtbarer Absatz loest trotzdem ein Scrollen aus");

  // c) Absatz ueber dem Rand (Rueckwaerts-Sprung) → nach oben nachziehen.
  box.scrollTop = 400;
  p.rect = { top: 10, bottom: 40, height: 30 };
  jbKeepCaretInView(area);
  ok(box.scrollTop < 400, "ein Absatz oberhalb des Rands wird nicht sichtbar gemacht");
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

console.log(`journal writing flow: ok (${checks} Pruefungen)`);
