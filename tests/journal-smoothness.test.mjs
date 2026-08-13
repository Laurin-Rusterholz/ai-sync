/*
 * Journal Booklet — Fluessigkeit und Speicherverhalten.
 *
 * Diese Pruefungen sichern die Runde „alles fluessiger, Speicherungen usw."
 * ab. Die wichtigsten Befunde dahinter:
 *
 *  1. jbFlush() — die Notbremse, die beim Tab-Schliessen die letzten
 *     Anschlaege sichert — lag in der IIFE des Newsroom-Moduls. Dort existieren
 *     _jbCurrentDocId, die Autosave-Timer und die Save-Funktionen nicht: jeder
 *     Aufruf warf einen ReferenceError, den das try/catch verschluckte. Die
 *     Notbremse griff also NIE. Der alte Test prueft nur, DASS jbFlush
 *     existiert — dieser hier prueft, WO.
 *
 *  2. Die Autosave-Buendelung (2 s) setzt sich mit jedem Anschlag zurueck.
 *     Wer minutenlang ohne Pause schrieb, hatte keinen einzigen Speicherstand.
 *     Jetzt wird spaetestens alle 10 s gesichert, auch mitten im Tippen.
 *
 *  3. Der Ruhe-Modus-Marker (jb-here) wanderte in den gespeicherten Inhalt —
 *     und liess jede Cursorbewegung wie eine Textaenderung aussehen.
 *
 *  4. Der Zukunftsbrief-Editor umging die Tippsperre (jbIsTyping): beim
 *     Briefschreiben lief alle paar Sekunden der volle Pull-Merge-Push.
 *
 *  5. Wortzahlen fuer Start-/Archiv-Ansicht strippten bei jedem Rendern das
 *     HTML ALLER Werke neu.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── Modulgrenzen: Journal-IIFE und Newsroom-Beginn ─────────────────────────
const jbStart = index.indexOf("// JOURNAL BOOKLET - Complete Writing Environment Module");
const jbEnd = index.indexOf('id="researchHubContainer"', jbStart);
ok(jbStart > 0 && jbEnd > jbStart, "die Modulgrenzen des Journal Booklets wurden nicht gefunden");
const jbSource = index.slice(jbStart, jbEnd);

// ── 1. jbFlush lebt im Journal-Modul, nicht in einer fremden IIFE ──────────
{
  ok(jbSource.includes("function jbFlush()"),
    "jbFlush() steht nicht im Journal-Modul — ausserhalb sind _jbCurrentDocId und die Save-Funktionen nicht erreichbar, jeder Aufruf wirft und die Notbremse greift nie");
  const after = index.slice(jbEnd);
  ok(!after.includes("function jbFlush()"),
    "jbFlush() existiert (auch) ausserhalb des Journal-Moduls — dort wirft es einen ReferenceError ins Leere");
  for (const ev of ['window.addEventListener("pagehide", jbFlush)',
                    'window.addEventListener("beforeunload", jbFlush)']) {
    ok(jbSource.includes(ev), `die Notbremse haengt nicht im Journal-Modul an: ${ev}`);
  }
  // Alles, was jbFlush anfasst, muss im selben Modul deklariert sein.
  for (const name of ["let _jbCurrentDocId", "let _jbAutoSaveTimer", "let _jbSLAutoSaveTimer",
                      "function jbSaveCurrentDoc(", "function jbSaveSelfLetterDraft("]) {
    ok(jbSource.includes(name), `${name} fehlt im Journal-Modul — jbFlush wuerde ins Leere greifen`);
  }
}

// ── Laufzeit-Umgebung fuer den Speicherpfad ────────────────────────────────
// Schneidet die ECHTEN Funktionen (Status, jbAutoSave, jbSaveCurrentDoc) aus
// und laesst sie gegen ein Stub-DOM mit steuerbarer Uhr laufen.
function loadSavePath() {
  const start = index.indexOf("  // Statuszeile links im Kopf");
  const end = index.indexOf("  // Send current entry to Mobile", start);
  ok(start > 0 && end > start, "der Speicherpfad-Block wurde in index.html nicht gefunden");
  const source = index.slice(start, end);

  const doc = { id: "d1", type: "diary", title: "", content: "", recipientId: "", font: "jb-font-inter", createdAt: 0, updatedAt: 0 };
  const els = {
    jbEditorTitle: { value: "Titel" },
    jbEditorArea: { innerHTML: "<div>Hallo</div>" },
    jbEditorRecipient: null,
    jbEditorFont: { value: "jb-font-inter" },
    jbEditorStatus: { textContent: "Bereit" }
  };
  const state = { now: 1_000_000, saves: 0, timers: [] };
  function FakeDate() { return { toLocaleTimeString: () => "12:00" }; }
  FakeDate.now = () => state.now;

  const fn = new Function(
    "window", "document", "Date", "setTimeout", "clearTimeout",
    "jd", "scheduleSave", "jbToast", "jbScheduleWritingMeta", "jbUpdateWritingMeta",
    "var _jbCurrentDocId = 'd1'; var _jbLastDocSaveAt = " + state.now + "; var _jbAutoSaveTimer = null;\n"
    + source
    + "\nreturn { jbAutoSave: jbAutoSave, jbSaveCurrentDoc: jbSaveCurrentDoc };"
  );
  const jb = fn(
    {},
    { getElementById: (id) => (id in els ? els[id] : null) },
    FakeDate,
    (cb) => { state.timers.push(cb); return state.timers.length; },
    () => {},
    () => ({ documents: [doc] }),
    () => { state.saves++; },
    () => {}, () => {}, () => {}
  );
  return { jb, doc, els, state };
}

// ── 2. Dauerschreiben ohne Pause: spaetestens nach 10 s ist gesichert ──────
{
  const { jb, doc, els, state } = loadSavePath();
  // 40 Anschlaege im 400-ms-Takt = 16 s Dauerschreiben. Die 2-s-Buendelung
  // kommt nie zum Zug (der Timer wird nie ausgeloest, wie beim echten Tippen).
  for (let i = 0; i < 40; i++) {
    state.now += 400;
    els.jbEditorArea.innerHTML += "x";
    jb.jbAutoSave();
  }
  ok(state.saves >= 1,
    "16 s Dauerschreiben ohne Tipppause und kein einziger Speicherstand — die 10-s-Obergrenze fehlt");
  ok(doc.content.includes("x"),
    "der Zwangsspeicher hat den getippten Inhalt nicht uebernommen");
  // Und die Anzeige sagt die Wahrheit: offen -> „Speichert", danach „Gespeichert".
  els.jbEditorArea.innerHTML += "y";
  jb.jbAutoSave();
  const pending = els.jbEditorStatus.textContent;
  jb.jbSaveCurrentDoc(true);
  ok(/^Speichert/.test(pending),
    `waehrend Aenderungen offen sind, zeigt der Status "${pending}" statt "Speichert …"`);
  ok(/^Gespeichert/.test(els.jbEditorStatus.textContent),
    `nach dem Sichern zeigt der Status "${els.jbEditorStatus.textContent}" statt "Gespeichert …"`);
}

// ── 3. Der Ruhe-Modus-Marker gehoert nicht in den Inhalt ───────────────────
{
  const { jb, doc, els, state } = loadSavePath();
  els.jbEditorArea.innerHTML = '<div>Erster</div><div class="jb-here">Zweiter</div>';
  jb.jbSaveCurrentDoc(true);
  ok(!doc.content.includes("jb-here"),
    `der Ruhe-Modus-Marker wird mitgespeichert: ${doc.content}`);
  // Auch neben anderen Klassen (z. B. aus eingefuegtem Inhalt).
  els.jbEditorArea.innerHTML = '<div class="foo jb-here">Drittens</div>';
  jb.jbSaveCurrentDoc(true);
  ok(!doc.content.includes("jb-here") && doc.content.includes('class="foo"'),
    `der Marker neben fremden Klassen bleibt haengen: ${doc.content}`);
  // Wandert nur der Marker (Cursorbewegung im Ruhe-Modus), ist das KEINE
  // Aenderung — sonst loest jede Cursorbewegung einen Voll-Snapshot aus.
  const savesBefore = state.saves;
  els.jbEditorArea.innerHTML = '<div class="foo jb-here">Drittens</div>';
  jb.jbSaveCurrentDoc(true);
  ok(state.saves === savesBefore,
    "eine reine Cursorbewegung im Ruhe-Modus zaehlt wieder als Textaenderung");
}

// ── 4. Beim Laden werden alte Marker abgestreift ───────────────────────────
ok(/Ruhe-Modus-Marker beim Laden abstreifen/.test(jbSource)
  && /loadContent = loadContent\.replace\(\/ class="jb-here"\/g, ""\)/.test(jbSource),
  "jbOpenDocument reinigt frueher gespeicherte jb-here-Marker nicht");

// ── 5. Auch der Zukunftsbrief-Editor haelt den Voll-Sync zurueck ───────────
{
  const typing = jbSource.slice(jbSource.indexOf("window.jbIsTyping"), jbSource.indexOf("window.jbIsTyping") + 600);
  ok(typing.includes("jbSelfLetterEditor"),
    "jbIsTyping kennt den Zukunftsbrief-Editor nicht — beim Briefschreiben laeuft alle paar Sekunden der volle Pull-Merge-Push");
  const slAuto = jbSource.slice(jbSource.indexOf("function jbSLAutoSave()"), jbSource.indexOf("function jbSLAutoSave()") + 700);
  ok(slAuto.includes("_jbLastKeystroke = Date.now()"),
    "jbSLAutoSave meldet keine Schreibaktivitaet — die Tippsperre bliebe wirkungslos");
  ok(slAuto.includes("JB_MAX_UNSAVED_MS"),
    "der Zukunftsbrief kennt die 10-s-Obergrenze fuer Dauerschreiben nicht");
}

// ── 6. Wortzahl-Cache: HTML wird pro Werk nur einmal gestrippt ─────────────
{
  const start = index.indexOf("  const _jbWcCache = new Map();");
  const end = index.indexOf("  // ====== OPEN / CLOSE ======", start);
  ok(start > 0 && end > start, "der Wortzahl-Cache wurde nicht gefunden");
  const fn = new Function(index.slice(start, end) + "\nreturn jbDocWordCount;");
  const jbDocWordCount = fn();

  let contentReads = 0;
  const doc = { id: "a", updatedAt: 5 };
  Object.defineProperty(doc, "content", { get() { contentReads++; return "<div>eins zwei drei</div>"; } });
  ok(jbDocWordCount(doc) === 3, "die Wortzahl stimmt nicht");
  const readsAfterFirst = contentReads;
  jbDocWordCount(doc); jbDocWordCount(doc);
  ok(contentReads === readsAfterFirst,
    "unveraenderte Werke werden bei jedem Rendern neu gestrippt — der Cache greift nicht");
  doc.updatedAt = 6;
  jbDocWordCount(doc);
  ok(contentReads > readsAfterFirst, "nach einer Aenderung wird die Wortzahl nicht neu berechnet");

  // Die Ansichten nutzen den Cache tatsaechlich.
  ok(jbSource.includes("acc + jbDocWordCount(d)"), "die Startansicht rechnet weiterhin selbst");
  ok(!/const wordCount = \(html\) =>/.test(jbSource), "die Archiv-Ansicht strippt weiterhin pro Rendern");
}

// ── 7. Nie beschriebene Werke verlassen das Archiv beim Schliessen ─────────
{
  const close = jbSource.slice(jbSource.indexOf("window.jbCloseEditor = function() {"), jbSource.indexOf("window.jbCloseEditor = function() {") + 900);
  ok(close.includes("jbEntryIsEmpty(doc)"),
    "jbCloseEditor laesst leere Unbenannt-Werke im Archiv stehen");
  ok(close.indexOf("jbSaveCurrentDoc(true)") < close.indexOf("jbEntryIsEmpty(doc)"),
    "die Leerheitspruefung laeuft vor dem Sichern — dann fehlt der letzte Stand");
  ok(jbSource.includes("function jbEntryIsEmpty(entry)"), "jbEntryIsEmpty() fehlt");
}

// ── 8. Rueckgaengig bleibt intakt: Ersetzung nur beim Zeichen-Tippen ───────
{
  const onWrite = jbSource.slice(jbSource.indexOf("window.jbOnWrite = function"), jbSource.indexOf("window.jbOnWrite = function") + 800);
  ok(/inputType/.test(onWrite) && /insertText/.test(onWrite),
    "jbOnWrite ersetzt auch bei Loeschen/Einfuegen/Rueckgaengig — Strg+Z stellt -- wieder her und die Regel macht sofort erneut einen Gedankenstrich daraus");
  const areaRow = index.split("\n").find((l) => l.includes('id="jbEditorArea"'));
  ok(areaRow && areaRow.includes("jbOnWrite(event)"),
    "der Schreibbereich reicht das Ereignis nicht weiter — ohne inputType keine Undo-Ruecksicht");
  const slRow = index.split("\n").find((l) => l.includes('id="jbSLArea"'));
  ok(slRow && slRow.includes("inputType") && slRow.includes("jbSLAutoSave()"),
    "der Zukunftsbrief-Schreibbereich prueft den inputType nicht");
}

// ── 9. Escape im Ruhe-Modus schliesst nicht zusaetzlich den Editor ─────────
{
  const esc = jbSource.slice(jbSource.indexOf('if (e.key === "Escape")'), jbSource.indexOf('if (e.key === "Escape")') + 500);
  ok(esc.includes("stopImmediatePropagation"),
    "Escape verlaesst den Ruhe-Modus und schliesst im selben Tastendruck den Editor — der spaeter registrierte Escape-Handler laeuft ungebremst weiter");
}

// ── 10. Tastatur im Zukunftsbrief-Editor ───────────────────────────────────
{
  const slKeys = jbSource.indexOf('var editor = document.getElementById("jbSelfLetterEditor");');
  ok(slKeys > 0, "der Zukunftsbrief-Editor hat keinen eigenen Tastatur-Handler");
  const block = jbSource.slice(slKeys, slKeys + 900);
  ok(block.includes("jbFormatSL"), "⌘/Strg+B/I/U formatieren im Zukunftsbrief nicht");
  ok(block.includes('key === "s"') && block.includes("jbSaveSelfLetterDraft()"),
    "⌘/Strg+S landet im Zukunftsbrief weiterhin im Seite-speichern-Dialog des Browsers");
}

// ── 11. Webfonts: was das Menue anbietet, wird auch geladen ────────────────
{
  ok(jbSource.includes("function jbEnsureFonts(font)"), "jbEnsureFonts() fehlt — Lora/Mono fallen still auf Systemschriften zurueck");
  ok(/jbEnsureFonts\(font\);/.test(jbSource), "die Schriftwahl laedt die Webfonts nicht nach");
  ok(/family=Lora[^"]*family=Inconsolata/.test(jbSource), "der Font-Link enthaelt Lora/Inconsolata nicht");
  ok(jbSource.includes("jbEnsureFonts(letter.font)"), "die Briefansicht laedt die Schrift des Briefs nicht nach");
}

// ── 12. Ruhige Rueckmeldungen ──────────────────────────────────────────────
{
  const toast = jbSource.slice(jbSource.indexOf("function jbToast(msg)"), jbSource.indexOf("function jbToast(msg)") + 400);
  ok(toast.includes("clearTimeout(_jbToastTimer)"),
    "zwei schnelle Meldungen: der Timer der ersten blendet die zweite vorzeitig aus");
  ok(/\.jb-editor\.active\{display:flex;animation:jbOverlayIn/.test(index),
    "der Editor erscheint weiterhin schlagartig statt mit kurzer Ueberblendung");
  ok(/@keyframes jbOverlayIn\{from\{opacity:0\}to\{opacity:1\}\}/.test(index),
    "die Overlay-Ueberblendung ist nicht rein per Deckkraft definiert (Versatz wuerde den Caret verschieben)");
}

// ── 13. Kein innerText im Chat- und Oeffnungspfad ──────────────────────────
{
  ok(!/getElementById\("jbEditorArea"\)\.innerText/.test(jbSource),
    "innerText auf dem Schreibbereich erzwingt ein Layout des gesamten Texts");
  ok(jbSource.includes("jbEditorPlainText(document.getElementById(\"jbEditorArea\"))"),
    "der Chat liest den Text nicht ueber jbEditorPlainText");
}

// ── 14. Zukunftsbrief: sparsamer Modus auch dort ───────────────────────────
{
  const slSave = jbSource.slice(jbSource.indexOf("function jbSaveSelfLetterDraft()"), jbSource.indexOf("function jbSLAutoSave()"));
  ok(slSave.includes("jbTuneEditorForLength("),
    "ein langer Zukunftsbrief laesst Rechtschreibpruefung und Feinsatz an — dieselbe Bremse, die im Werk-Editor behoben wurde");
  ok(/jbTuneEditorForLength\(len, areaOverride\)/.test(jbSource),
    "jbTuneEditorForLength kennt keinen zweiten Schreibbereich");
}

// ── 15. Tippen trifft immer den Text ───────────────────────────────────────
// Produktionsbefund: Editor offen, Status "Gespeichert", aber kein Anschlag
// kam an — der Fokus lag nach Tab-Wechsel/Klick ins Leere auf dem Dokument.
{
  ok(jbSource.includes("function jbFocusAreaAtEnd(area)"), "die Fokus-Rettung fehlt");
  ok(jbSource.includes("function jbActiveWritingArea()"), "jbActiveWritingArea() fehlt");
  const rec = jbSource.slice(jbSource.indexOf("function jbActiveWritingArea()"), jbSource.indexOf("function jbFlush()"));
  ok(rec.length > 0 && /e\.key\.length !== 1/.test(rec),
    "die Fokus-Rettung beschraenkt sich nicht auf druckbare Zeichen — Pfeiltasten und Escape wuerden den Fokus stehlen");
  ok(/isContentEditable/.test(rec),
    "die Fokus-Rettung wuerde auch aus fokussierten Eingabefeldern stehlen");
  ok(/mousedown/.test(rec) && /jb-editor-wrap/.test(rec),
    "ein Klick in die freie Schreibflaeche setzt den Cursor nicht in den Text");
}

// ── 16. Der Quick-Assistent hat im Journal Pause ───────────────────────────
{
  ok(/body\.jb-open #qc-fab,body\.jb-open #qc-panel\{display:none!important\}/.test(index),
    "der schwebende KI-Knopf (hoechster z-index der Seite) liegt weiterhin ueber der Schreibumgebung");
  ok(/body:has\(#jbEditor\.active\) #qc-fab/.test(index),
    "ohne jb-open-Klasse (Router-Randfall) bleibt der KI-Knopf im Editor sichtbar");
}

console.log(`journal smoothness: ok (${checks} Pruefungen)`);
