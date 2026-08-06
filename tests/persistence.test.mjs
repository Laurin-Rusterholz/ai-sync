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

console.log("persistence: ok");
