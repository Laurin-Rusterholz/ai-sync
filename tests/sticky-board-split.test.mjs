/*
 * Regressionen im Sticky Board.
 *
 * 1) Post-its liessen sich nicht bearbeiten. onCanvasPointerDown rief bei jedem
 *    Klick auf ein Post-it renderNotes() auf und ersetzte damit den kompletten
 *    Inhalt von #sbNotes. Das Element, das gerade pointerdown bekommen hatte,
 *    war danach weg — der Browser braucht fuer click (und damit dblclick) aber
 *    dasselbe Ziel bei down UND up, also kam auf einem Post-it nie ein dblclick
 *    an und onCanvasDblClick lief nie. Uebrig blieb der Ersatzpfad "zweiter
 *    Klick auf ein bereits ausgewaehltes Post-it oeffnet den Editor" — und der
 *    kaempfte bei einem echten Doppelklick gegen sich selbst: Klick 1 oeffnete
 *    den Editor, Klick 2 nahm ihm ueber cv.focus() den Fokus, onBlur schloss
 *    ihn sofort wieder. Ergebnis: Doppelklick tat sichtbar nichts.
 *
 * 2) Die Breite der Split-Ansicht wird als absoluter px-Wert unter "sbSplitPx"
 *    gespeichert. Beim Oeffnen wurde sie ungeprueft uebernommen: auf einem
 *    schmaleren Fenster (anderer Monitor, verkleinertes Fenster, Tablet
 *    quer→hoch) war das Overlay dann breiter als der Viewport und ragte nach
 *    LINKS heraus — Titel und die Zoom-/Schliessen-Knoepfe waren nicht mehr
 *    erreichbar und die Werkzeugleiste begann mitten in einem Knopf.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

// ── 1. Zeigergesten duerfen das Post-it-DOM nicht wegreissen ────────────────
assert.match(index, /function updateSelectionDOM\s*\(/, "updateSelectionDOM() fehlt");
// In onCanvasPointerDown darf die Auswahl nur noch in-place aktualisiert werden.
const pointerDown = index.slice(
  index.indexOf("function onCanvasPointerDown"),
  index.indexOf("function computeSnap"),
);
assert.ok(pointerDown.length > 500, "onCanvasPointerDown nicht gefunden");
assert.match(pointerDown, /updateSelectionDOM\(\);/, "onCanvasPointerDown aktualisiert die Auswahl nicht in-place");
assert.doesNotMatch(
  pointerDown,
  /^\s*renderNotes\(\);\s*$/m,
  "onCanvasPointerDown baut das Post-it-DOM wieder mitten in der Zeigergeste neu — dblclick geht dann verloren",
);
// Klick im offenen Editor darf ihn nicht ueber cv.focus()/onBlur schliessen.
assert.match(
  pointerDown,
  /if \(B\.editingId\)[\s\S]{0,400}?e\.target\.closest\("\.sb-note-body"\)\) return;/,
  "Klicks im offenen Text-Editor werden nicht durchgelassen — der Editor schliesst sich beim zweiten Klick sofort wieder",
);
// Die Wache muss VOR dem cv.focus()-Aufruf stehen, sonst ist der Fokus des
// contenteditable schon weg, bevor die Wache greift. Auf die Anweisung am
// Zeilenanfang pruefen, nicht auf den blossen Text — "cv.focus()" kommt auch im
// erklaerenden Kommentar darueber vor.
const guardAt = pointerDown.search(/^\s*if \(B\.editingId\) \{$/m);
const focusAt = pointerDown.search(/^\s*cv\.focus\(\);$/m);
assert.ok(guardAt >= 0, "Editor-Wache nicht gefunden");
assert.ok(focusAt >= 0, "cv.focus()-Aufruf nicht gefunden");
assert.ok(guardAt < focusAt, "die Editor-Wache steht hinter cv.focus() und wirkt damit nicht");
// Auch Resize und Marquee fassen das DOM mitten in der Geste nicht mehr an.
assert.match(index, /B\.sel = new Set\(\[id\]\); updateSelectionDOM\(\);/, "startResize() rendert weiterhin komplett neu");
assert.match(index, /\{ B\.sel = new Set\(\); updateSelectionDOM\(\); \}/, "startMarquee() rendert weiterhin komplett neu");

// ── 2. Die Split-Breite wird zentral geklemmt ───────────────────────────────
assert.match(index, /function clampSplitPx\s*\(/, "clampSplitPx() fehlt");
assert.match(index, /function applyStoredSplit\s*\(/, "applyStoredSplit() fehlt");
assert.doesNotMatch(
  index,
  /localStorage\.getItem\("sbSplitPx"\);\s*if \(sp\) document\.body\.style\.setProperty/,
  "die gespeicherte Split-Breite wird wieder ungeprueft uebernommen",
);
assert.match(index, /window\.addEventListener\("resize", onWindowResize\)/, "Split-Breite wird bei Fenster-Aenderung nicht neu geklemmt");
assert.match(index, /window\.removeEventListener\("resize", onWindowResize\)/, "resize-Listener wird beim Schliessen nicht abgeraeumt");
assert.match(index, /\.sb-overlay\.sb-side\{[^}]*max-width:100vw/, "CSS-Notbremse max-width:100vw fehlt");

console.log("sticky board split width: ok");
