/*
 * Speichern: was verloren ging und warum.
 *
 * Ausloeser war das Journal Booklet, der Befund reicht aber weiter. Drei Muster
 * haben Daten gekostet:
 *
 *  1. NUR IM DOM. Der Zukunftsbrief (Zeitkapsel) existierte ausschliesslich in
 *     den Eingabefeldern — „Senden" war der einzige Weg, ihn zu speichern. Wer
 *     den Editor schloss, die Ansicht wechselte oder neu lud, verlor alles.
 *     Dasselbe galt fuer den KI-Verlauf im Editor.
 *
 *  2. GEBUENDELT, ABER OHNE NETZ. Mehrere Module verzoegern ihren
 *     scheduleSave()-Aufruf beim Tippen (500–800 ms). Das Modell ist da schon
 *     geaendert — aber solange scheduleSave() nicht lief, ist NICHTS als
 *     geaendert markiert: flushLocalSave() schreibt dann nichts und der Server
 *     erfaehrt es nie. Tab schliessen innerhalb der Pause = letzte Eingabe weg.
 *     Deshalb gibt es jetzt eine zentrale Registry offener Speicherungen, die
 *     bei pagehide/visibilitychange nachgeholt werden.
 *
 *  3. MUTIERT, ABER NICHT GEMELDET. Einzelne Aktionen aenderten den Datenstand,
 *     ohne das Speichern anzustossen (Anhang aus einer Mail entfernen, den
 *     Einstellungsdialog sichern).
 *
 * Zusaetzlich: beforeunload feuert auf Mobilgeraeten oft gar nicht. Wo ein
 * Editor sein Zwischenergebnis erst beim Verlassen schreibt, muessen pagehide
 * UND visibilitychange mitgebunden sein.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const index = read("public/index.html");
const bm = read("public/bm.html");

// ── 1. Journal Booklet: nichts lebt mehr nur im DOM ───────────────────────
// Der Zukunftsbrief wird laufend als Entwurf gesichert und wiederhergestellt.
assert.match(index, /d\.journal\.selfLetterDraft = d\.journal\.selfLetterDraft \|\| null;/,
  "der Entwurf des Zukunftsbriefs fehlt im Datenstand");
assert.match(index, /function jbSaveSelfLetterDraft\(\)/, "jbSaveSelfLetterDraft\\(\\) fehlt");
assert.match(index, /function jbSLAutoSave\(\)/, "der Zukunftsbrief hat keine laufende Sicherung");
assert.match(index, /function jbApplySelfLetterDraft\(draft\)/, "der Entwurf wird nicht wiederhergestellt");
// Die Eingabefelder muessen die Sicherung tatsaechlich ausloesen.
for (const [id, attr] of [["jbSLTitle", "oninput"], ["jbSLArea", "oninput"], ["jbSLFont", "onchange"], ["jbSLCustomDate", "onchange"]]) {
  const row = index.split("\n").find((line) => line.includes(`id="${id}"`));
  assert.ok(row, `${id} nicht gefunden`);
  assert.ok(row.includes("jbSLAutoSave()"), `${id} sichert den Entwurf nicht (${attr} fehlt)`);
}
// „Neuer Brief" darf einen Entwurf nur nach Rueckfrage wegwerfen.
assert.match(index, /window\.jbDiscardSelfLetterDraft = function\(\)/, "der Entwurf laesst sich nicht bewusst verwerfen");
assert.match(index, /confirm\("Entwurf verwerfen und neu beginnen\?"\)/, "ein Entwurf wird ohne Rueckfrage verworfen");
// Nach dem Senden ist der Entwurf gegenstandslos.
assert.match(index, /jd\(\)\.selfLetterDraft = null;[\s\S]{0,120}?scheduleSave\(\);/,
  "nach dem Senden bleibt der Entwurf liegen");
// Schriftwahl im Dokument-Editor ging verloren, weil sie nichts ausloeste.
const fontRow = index.split("\n").find((line) => line.includes('id="jbEditorFont"'));
assert.ok(fontRow && fontRow.includes("jbAutoSave()"), "die Schriftwahl im Editor wird nicht gesichert");
// Formatierung (execCommand) loest nicht in jedem Browser input aus.
assert.match(index, /document\.getElementById\("jbEditorArea"\)\.focus\(\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*jbAutoSave\(\);/,
  "Formatierung im Editor wird nicht ausdruecklich gesichert");
// KI-Verlauf liegt im Datenstand, nicht im DOM.
assert.match(index, /d\.journal\.chat = Array\.isArray\(d\.journal\.chat\) \? d\.journal\.chat : \[\];/,
  "der KI-Verlauf fehlt im Datenstand");
assert.match(index, /function jbRenderChat\(\)/, "der KI-Verlauf wird nicht aus dem Datenstand aufgebaut");
assert.match(index, /function jbPushChat\(role, text\)/, "jbPushChat\\(\\) fehlt");
// Die Antwort der KI darf nicht als rohes HTML in die Seite.
assert.match(index, /<strong>Intelligence:<\/strong><br>\$\{jbEsc\(row\.text\)\}/,
  "die KI-Antwort wird ungefiltert als HTML eingesetzt");
// Notbremse beim Verlassen.
assert.match(index, /function jbFlush\(\)/, "jbFlush\\(\\) fehlt");
for (const ev of ["pagehide", "beforeunload"]) {
  assert.ok(index.includes(`window.addEventListener("${ev}", jbFlush)`), `jbFlush haengt nicht an ${ev}`);
}
assert.match(index, /document\.addEventListener\("visibilitychange", function\(\) \{ if \(document\.hidden\) jbFlush\(\); \}\)/,
  "jbFlush haengt nicht am Wechsel in den Hintergrund");

// ── 2. Zentrale Registry fuer gebuendelte Speicherungen ───────────────────
assert.match(index, /function scheduleSaveDebounced\(key, delay, fn\)/, "scheduleSaveDebounced\\(\\) fehlt");
assert.match(index, /function flushPendingSaves\(\)/, "flushPendingSaves\\(\\) fehlt");
// flushPendingSaves muss das lokale Schreiben selbst nachziehen, damit die
// Reihenfolge der Listener egal ist.
assert.match(index, /_pendingSaves\.clear\(\);\s*\n[\s\S]{0,240}?flushLocalSave\(\);/,
  "flushPendingSaves\\(\\) zieht das lokale Schreiben nicht nach");
for (const ev of ["pagehide", "beforeunload"]) {
  assert.ok(index.includes(`window.addEventListener("${ev}", flushPendingSaves)`),
    `flushPendingSaves haengt nicht an ${ev}`);
}
// Kein Modul darf wieder einen eigenen, unbeaufsichtigten Speicher-Timer halten.
for (const timer of ["_dcSummarySaveTimer", "_prjSummarySaveTimer", "_prjWeeklySaveTimer",
                     "_prjSgSaveTimer", "_pb88TopicSaveTimer", "_pb88FASaveTimer"]) {
  assert.ok(!index.includes(timer), `${timer} ist wieder ein eigener Timer statt der zentralen Registry`);
}
assert.doesNotMatch(index, /var _saveTimer = null;\s*\nfunction debouncedSave\(\)\{ clearTimeout\(_saveTimer\)/,
  "debouncedSave\\(\\) umgeht die zentrale Registry wieder");
// Die umgestellten Aufrufstellen.
for (const key of ["decision-matrix-summary:", "project-matrix-summary:", "project-weekly-target:",
                   "project-subgoal:", "pb88-topic:", "pb88-focusarea:", "nhi-panel"]) {
  assert.ok(index.includes(`scheduleSaveDebounced("${key}`), `Aufrufstelle ${key} nutzt die Registry nicht`);
}

// ── 3. Mutationen, die das Speichern nicht angestossen haben ──────────────
assert.match(index, /APP\.state\.data\.entities\.emails\[_mhEditing\]\.files = \[\.\.\._mhFiles\];[\s\S]{0,320}?scheduleSave\(\);/,
  "das Entfernen eines Mail-Anhangs wird nicht gespeichert");
assert.match(index, /saveSettings\(APP\.state\.settings\);[\s\S]{0,400}?scheduleSave\(\);\s*\n\s*closeModal\(\);/,
  "der Einstellungsdialog markiert seine Aenderungen am Datenstand nicht als zu speichern");

// ── 4. Mobil: beforeunload allein genuegt nicht ───────────────────────────
// Der Block-Editor (NoteFlow 2) schreibt beim Verlassen — und muss deshalb auch
// auf pagehide und den Wechsel in den Hintergrund hoeren.
assert.match(index, /window\.addEventListener\("pagehide", flushSave\);/,
  "der Block-Editor sichert bei pagehide nicht");
assert.match(index, /document\.addEventListener\("visibilitychange", function \(\) \{ if \(document\.hidden\) flushSave\(\); \}\);/,
  "der Block-Editor sichert beim Wechsel in den Hintergrund nicht");

// ── 5. BM-Vorbereitung: Notizen ───────────────────────────────────────────
// Auch hier lag die Notiz bis zum Ablauf der Buendelung nur im Textfeld.
assert.match(bm, /function flushNote\(\)/, "bm.html holt die offene Notiz-Speicherung nicht nach");
assert.match(bm, /window\.addEventListener\("pagehide", flushNote\);/, "bm.html sichert bei pagehide nicht");
assert.match(bm, /document\.addEventListener\("visibilitychange", function\(\)\{ if\(document\.hidden\) flushNote\(\); \}\);/,
  "bm.html sichert beim Wechsel in den Hintergrund nicht");
assert.doesNotMatch(bm, /noteTimer=setTimeout\(function\(\)\{ var fk=fbKey\(k\)/,
  "bm.html haelt wieder einen unbeaufsichtigten Notiz-Timer");

// ── 6. Weitere Module aus dem systematischen Durchgang ────────────────────
// Der Thesis-Editor ist eine Schreib-App: 1,5 s Buendelung ohne Netz sind dort
// schnell ein verlorener Satz. Und execCommand loest nicht ueberall input aus.
assert.match(index, /window\.scheduleSaveDebounced\("thesis:" \+ thId \+ ":" \+ chId, 1500, write\)/,
  "der Thesis-Editor haelt wieder einen eigenen, unbeaufsichtigten Timer");
assert.ok(!index.includes("_thsAutoSaveTimer"), "_thsAutoSaveTimer umgeht die zentrale Registry wieder");
assert.match(index, /if \(thId && chId\) window\.thsScheduleAutoSave\(thId, chId\);/,
  "Formatierung im Thesis-Editor wird nicht gesichert");
// Damit die Werkzeugleiste weiss, was sie speichern soll.
assert.match(index, /data-thesis-id="\$\{th\.id\}" data-chapter-id="\$\{chapter\.id\}"/,
  "die Thesis-Editoren tragen ihre Zugehoerigkeit nicht");
// NoteFlow: die Schriftwahl landete nur im Zwischenspeicher.
assert.match(index, /nfCurrentNote\._fontFamily = fontFamily; nfAutoSave\(\);/,
  "die Schriftwahl in NoteFlow wird nicht gespeichert");
assert.match(index, /nfCurrentNote\._fontSize = size; nfAutoSave\(\);/,
  "die Schriftgroesse in NoteFlow wird nicht gespeichert");

// ── 7. Doc Studio: das ausgefuellte Formular ueberlebt einen Neustart ─────
// S.gen lag ausschliesslich im Arbeitsspeicher — ein langer Beleg war beim
// Schliessen des Tabs weg, weil erst die Generierung daraus ein Dokument macht.
const ds = read("public/docstudio.html");
assert.match(ds, /var GEN_DRAFT_KEY = "quantus_docstudio_gen_draft_v1";/, "docstudio sichert das Formular nicht");
for (const fn of ["saveGenDraft", "scheduleGenDraft", "flushGenDraft", "clearGenDraft", "restoreGenDraft", "genIsEmpty"]) {
  assert.ok(ds.includes(`function ${fn}(`), `docstudio: ${fn}() fehlt`);
}
assert.match(ds, /window\.addEventListener\("pagehide", flushGenDraft\);/, "docstudio sichert bei pagehide nicht");
assert.match(ds, /document\.addEventListener\("visibilitychange", function\(\)\{ if \(document\.hidden\) flushGenDraft\(\); \}\);/,
  "docstudio sichert beim Wechsel in den Hintergrund nicht");
assert.match(ds, /var restored = restoreGenDraft\(\);/, "docstudio stellt den Entwurf beim Start nicht wieder her");
assert.match(ds, /S\.gen = emptyGen\(\);\s*\n\s*clearGenDraft\(\);/,
  "docstudio raeumt den Entwurf nach der Generierung nicht auf");

// ── 8. Schreibkomfort im Journal Booklet ──────────────────────────────────
// Rueckgaengig muss funktionieren: die Zeichenersetzung laeuft ueber die
// Auswahl und execCommand, nicht ueber direktes Setzen von textContent.
assert.match(index, /document\.execCommand\("insertText", false, replacement\);/,
  "die Zeichenersetzung zerstoert den Rueckgaengig-Verlauf");
assert.doesNotMatch(index, /node\.textContent = before\.slice/,
  "die Zeichenersetzung schreibt wieder direkt in den Textknoten");
for (const fn of ["jbWordCount", "jbUpdateWritingMeta", "jbMarkCurrentParagraph", "jbApplyTypography"]) {
  assert.ok(index.includes(`function ${fn}(`), `${fn}() fehlt`);
}
assert.match(index, /window\.jbToggleCalm = function\(\)/, "der Ruhe-Modus fehlt");
assert.match(index, /window\.jbOnWrite = function\(\)/, "jbOnWrite\(\) fehlt");
// Der Schreibbereich haengt am neuen Sammelaufruf.
const writeArea = index.split("\n").find((line) => line.includes('id="jbEditorArea"'));
assert.ok(writeArea && writeArea.includes("jbOnWrite()"), "der Schreibbereich ruft jbOnWrite\(\) nicht");
assert.ok(writeArea && writeArea.includes('spellcheck="true"'), "die Rechtschreibpruefung ist im Schreibbereich aus");
// Lesbare Zeilenlaenge und Platz unter dem Cursor.
assert.match(index, /\.jb-richtext\{[^}]*max-width:66ch/, "die Zeilenlaenge ist nicht begrenzt");
assert.match(index, /\.jb-richtext\{[^}]*padding-bottom:45vh/, "der Cursor klebt wieder am Fensterrand");
assert.match(index, /\.jb-editor\.jb-calm \.jb-richtext>\*\{opacity:\.32/, "der Ruhe-Modus dimmt die uebrigen Absaetze nicht");

console.log("persistence: ok");
