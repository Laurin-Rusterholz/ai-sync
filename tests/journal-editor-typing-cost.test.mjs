/*
 * Journal Booklet — Schreibkosten pro Anschlag, Laufzeittest.
 *
 * Produktionsbefund: "wenn ich im Journal mobile viel schreibe, stuerzt der
 * Browser ab". Die Ursache lag nicht an einer Stelle, sondern darin, dass die
 * Arbeit pro Tastendruck mit der Textlaenge wuchs:
 *
 *   - jbUpdateWritingMeta() las area.innerText — das zwingt den Browser, den
 *     gesamten Schreibbereich neu zu vermessen, und zwar bei jedem Zeichen.
 *   - jbMarkCurrentParagraph() setzte bei jedem Zeichen eine Klasse auf ALLEN
 *     Absaetzen, auch wenn der Ruhe-Modus gar nicht an war.
 *   - Danach zog scheduleSave() im Hintergrund den kompletten Datenbestand
 *     vom Server, merged ihn und schickte ihn wieder hoch — alle paar Sekunden.
 *
 * Der Test schneidet die ECHTEN Funktionen aus index.html heraus und fuehrt
 * sie gegen ein aufgezeichnetes DOM aus. innerText ist dabei eine Falle: wer
 * es anfasst, laesst den Test scheitern.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── Den echten Schreibkomfort-Block herausschneiden ────────────────────────
const start = index.indexOf("  function jbWordCount(text) {");
const end = index.indexOf("  function jbToast(msg) {", start);
ok(start > 0 && end > start, "der Schreibkomfort-Block wurde in index.html nicht gefunden");
const source = index.slice(start, end);

ok(!/function jbWordCount\(text\)[\s\S]*?\n  \}[\s\S]*?function jbWordCount\(/.test(source),
  "jbWordCount ist mehrfach definiert — dann prueft der Test die falsche Fassung");

// ── Ein DOM, das jede Vermessung meldet ────────────────────────────────────
let classOps = 0;      // wie oft eine Klasse an einem Absatz angefasst wurde
let innerTextReads = 0;

function makeClassList(owner) {
  const set = new Set();
  return {
    add(n) { if (owner.counted) classOps++; set.add(n); },
    remove(n) { if (owner.counted) classOps++; set.delete(n); },
    contains(n) { return set.has(n); },
    toggle(n, force) {
      if (owner.counted) classOps++;
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      return want;
    }
  };
}

function makeEl(opts = {}) {
  const el = {
    children: [],
    style: {},
    attributes: {},
    innerHTML: "",
    textContent: opts.text || "",
    parentNode: null,
    counted: !!opts.counted,
    setAttribute(n, v) { this.attributes[n] = String(v); },
    getAttribute(n) { return this.attributes[n]; }
  };
  el.classList = makeClassList(el);
  // innerText ist die teure Fassung: sie erzwingt ein Layout. Wer sie liest,
  // faellt hier auf — genau das war der Fehler.
  Object.defineProperty(el, "innerText", {
    get() { innerTextReads++; return el.textContent; }
  });
  return el;
}

// Schreibbereich mit vielen Absaetzen — so sieht ein laengerer Eintrag aus.
function buildEditorArea(paragraphs, wordsPerParagraph) {
  const area = makeEl();
  for (let i = 0; i < paragraphs; i++) {
    const p = makeEl({ counted: true, text: ("Wort" + i + " ").repeat(wordsPerParagraph).trim() });
    p.parentNode = area;
    area.children.push(p);
  }
  return area;
}

function makeEnv(area) {
  const meta = makeEl();
  const editor = makeEl();
  const caretText = { nodeType: 3, textContent: "Hallo Welt", parentNode: area.children[0] || area };

  const byId = {
    jbEditorArea: area,
    jbWritingMeta: meta,
    jbEditor: editor,
    jbCalmBtn: null
  };

  const listeners = {};
  const document = {
    getElementById: (id) => (id in byId ? byId[id] : null),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    createElement: () => makeEl(),
    createRange: () => ({ setStart() {}, setEnd() {} }),
    execCommand: () => true
  };

  const selection = {
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: caretText, startOffset: caretText.textContent.length }),
    removeAllRanges() {},
    addRange() {}
  };

  const win = {
    getSelection: () => selection,
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0)
  };

  return { document, window: win, meta, editor, byId, listeners, caretText, selection };
}

function load(env) {
  const fn = new Function(
    "document", "window", "localStorage", "requestAnimationFrame",
    "setTimeout", "clearTimeout", "jbAutoSave", "jbSaveCurrentDoc", "_jbAutoSaveTimer",
    // Fehlt eine Funktion, soll die zugehoerige Pruefung sprechen — nicht ein
    // ReferenceError beim Laden.
    source + "\nvar opt = function(n) { try { return eval(n); } catch (e) { return null; } };" +
    "\nreturn { jbOnWrite: window.jbOnWrite, jbIsTyping: window.jbIsTyping," +
    " jbUpdateWritingMeta: window.jbUpdateWritingMeta, jbToggleCalm: window.jbToggleCalm," +
    " jbMarkCurrentParagraph: opt('jbMarkCurrentParagraph'), jbTuneEditorForLength: opt('jbTuneEditorForLength') };"
  );
  return fn(
    env.document, env.window, env.window.localStorage, env.window.requestAnimationFrame,
    setTimeout, clearTimeout, () => {}, () => {}, null
  );
}

// ── 1. Kein innerText im Schreibpfad ───────────────────────────────────────
{
  const area = buildEditorArea(200, 12);
  const env = makeEnv(area);
  const jb = load(env);
  jb.jbUpdateWritingMeta();
  ok(innerTextReads === 0,
    `jbUpdateWritingMeta liest innerText (${innerTextReads}x) — das erzwingt bei jedem Zeichen ein Layout des ganzen Textes`);
  ok(/\d/.test(env.meta.innerHTML) && /Wörter/.test(env.meta.innerHTML),
    `die Wortzahl wird nicht mehr angezeigt: ${env.meta.innerHTML}`);
}

// ── 2. Die Wortzahl laeuft nicht pro Anschlag ──────────────────────────────
{
  const area = buildEditorArea(200, 12);
  const env = makeEnv(area);
  const jb = load(env);
  env.editor.classList.add("active");
  env.meta.innerHTML = "";
  for (let i = 0; i < 40; i++) jb.jbOnWrite();
  ok(env.meta.innerHTML === "",
    "die Wortzahl wird weiterhin synchron bei jedem Anschlag neu gebaut");
  await new Promise((r) => setTimeout(r, 900));
  ok(/Wörter/.test(env.meta.innerHTML),
    `nach der Tipppause fehlt die Wortzahl: ${env.meta.innerHTML}`);
}

// ── 3. Ohne Ruhe-Modus werden keine Absaetze angefasst ─────────────────────
{
  const area = buildEditorArea(200, 12);
  const env = makeEnv(area);
  const jb = load(env);
  env.editor.classList.add("active");
  classOps = 0;
  for (let i = 0; i < 40; i++) jb.jbOnWrite();
  ok(classOps === 0,
    `ohne Ruhe-Modus wurden ${classOps} Absatz-Klassen gesetzt — 200 Absaetze mal 40 Anschlaege war die Bremse`);
}

// ── 4. Mit Ruhe-Modus nur die zwei betroffenen Absaetze ────────────────────
{
  const area = buildEditorArea(200, 12);
  const env = makeEnv(area);
  const jb = load(env);
  env.editor.classList.add("active");
  env.editor.classList.add("jb-calm");
  classOps = 0;
  for (let i = 0; i < 40; i++) jb.jbOnWrite();
  ok(classOps <= 2,
    `im Ruhe-Modus wurden bei 40 Anschlaegen ${classOps} Absatz-Klassen gesetzt — erwartet hoechstens 2 (alter Absatz aus, neuer an)`);
  ok(area.children[0].classList.contains("jb-here"),
    "der Absatz mit dem Cursor ist im Ruhe-Modus nicht markiert");

  // Cursor in einen anderen Absatz: genau ein Wechsel, nicht 200 Umschaltungen.
  env.caretText.parentNode = area.children[7];
  classOps = 0;
  jb.jbMarkCurrentParagraph();
  ok(classOps === 2, `ein Absatzwechsel kostet ${classOps} Klassen-Operationen statt 2`);
  ok(area.children[7].classList.contains("jb-here") && !area.children[0].classList.contains("jb-here"),
    "die Markierung ist beim Absatzwechsel nicht mitgewandert");
}

// ── 5. Lange Eintraege: Rechtschreibpruefung und Feinsatz aus ──────────────
{
  const kurz = buildEditorArea(3, 10);
  const envK = makeEnv(kurz);
  const jbK = load(envK);
  jbK.jbUpdateWritingMeta();
  ok(!kurz.classList.contains("jb-long"),
    "ein kurzer Eintrag laeuft unnoetig im Sparmodus — die Rechtschreibpruefung soll dort erhalten bleiben");

  const lang = buildEditorArea(400, 20);
  const envL = makeEnv(lang);
  const jbL = load(envL);
  jbL.jbUpdateWritingMeta();
  ok(lang.classList.contains("jb-long"),
    "ein langer Eintrag schaltet nicht in den Sparmodus");
  ok(lang.getAttribute("spellcheck") === "false",
    `bei langem Text bleibt die Rechtschreibpruefung an (spellcheck=${lang.getAttribute("spellcheck")}) — der Browser prueft dann bei jeder Aenderung den ganzen Text`);
}

// ── 6. Auf Mobilgeraeten sofort sparsam ────────────────────────────────────
{
  const area = buildEditorArea(3, 10);
  const env = makeEnv(area);
  env.window.matchMedia = () => ({ matches: true });   // (hover:none) and (pointer:coarse)
  const jb = load(env);
  jb.jbUpdateWritingMeta();
  ok(area.classList.contains("jb-long"),
    "auf dem Handy bleibt der teure Modus aktiv, obwohl dort die Tastatur ohnehin korrigiert");
}

// ── 7. Waehrend des Tippens keinen Voll-Sync ───────────────────────────────
{
  const area = buildEditorArea(10, 10);
  const env = makeEnv(area);
  const jb = load(env);
  ok(jb.jbIsTyping() === false, "jbIsTyping meldet Schreibbetrieb, obwohl der Editor gar nicht offen ist");
  env.editor.classList.add("active");
  ok(jb.jbIsTyping() === false, "jbIsTyping meldet Schreibbetrieb ohne einen einzigen Anschlag");
  jb.jbOnWrite();
  ok(jb.jbIsTyping() === true, "nach einem Anschlag meldet jbIsTyping keinen Schreibbetrieb");
  env.editor.classList.remove("active");
  ok(jb.jbIsTyping() === false,
    "nach dem Schliessen des Editors meldet jbIsTyping weiterhin Schreibbetrieb — der Push bliebe liegen");
}

// ── 8. scheduleSave haelt den Remote-Weg tatsaechlich zurueck ──────────────
{
  const saveStart = index.indexOf("function scheduleSave() {");
  const saveEnd = index.indexOf("function remoteSaveOnHold() {", saveStart);
  ok(saveStart > 0 && saveEnd > saveStart, "scheduleSave() wurde nicht gefunden");
  const save = index.slice(saveStart, saveEnd);
  ok(/if \(remoteSaveOnHold\(\)\) return;/.test(save),
    "scheduleSave() drueckt beim Tippen weiterhin den kompletten Datenbestand durch Pull-Merge-Push");
  ok(save.indexOf("scheduleLocalSave();") < save.indexOf("if (remoteSaveOnHold()) return;"),
    "die Sperre liegt vor dem lokalen Sichern — dann ginge beim Tippen alles verloren");

  const netStart = index.indexOf("// Safety net: check every 5s if dirty");
  const net = index.slice(netStart, netStart + 400);
  ok(/if \(remoteSaveOnHold\(\)\) return;/.test(net),
    "das 5-Sekunden-Sicherheitsnetz umgeht die Sperre — dann bringt sie beim Tippen nichts");
  ok(/_saveDirty/.test(net),
    "das Sicherheitsnetz prueft nicht mehr auf ausstehende Aenderungen — der zurueckgehaltene Push wuerde nie nachgeholt");

  ok(/window\.jbIsTyping\s*=/.test(index), "jbIsTyping wird nicht global bereitgestellt");
}

// ── 9. Der Editor sichert beim Schliessen ausserhalb der Tippsperre ────────
{
  const closeStart = index.indexOf("window.jbCloseEditor = function() {");
  const close = index.slice(closeStart, closeStart + 700);
  ok(close.indexOf('classList.remove("active")') < close.indexOf("jbSaveCurrentDoc(true)"),
    "jbCloseEditor sichert noch bevor der Editor als geschlossen gilt — der Remote-Push bliebe von der Tippsperre blockiert");
  ok(close.indexOf("jbSaveCurrentDoc(true)") < close.indexOf("_jbCurrentDocId = null"),
    "jbCloseEditor loescht die Dokument-Id vor dem Sichern — dann findet jbSaveCurrentDoc nichts mehr");
}

// ── 10. CSS: der Sparmodus existiert und greift ────────────────────────────
{
  ok(/\.jb-richtext\.jb-long\{[^}]*text-wrap:wrap/.test(index),
    "der Sparmodus hebt text-wrap:pretty nicht auf — der Browser bricht dann bei jedem Zeichen den ganzen Text neu um");
  ok(/\.jb-richtext\.jb-long\{[^}]*hyphens:manual/.test(index),
    "der Sparmodus laesst die automatische Silbentrennung an");
  ok(/\.jb-editor\.jb-calm \.jb-richtext\.jb-long>\*\{transition:none\}/.test(index),
    "im Ruhe-Modus laufen bei langen Texten weiterhin Ueberblendungen auf jedem Absatz");
}

console.log(`journal editor typing cost: ok (${checks} Pruefungen)`);
