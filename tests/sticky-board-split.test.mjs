/*
 * Regression: Sticky Board haengt links aus dem Bild.
 *
 * Die Breite der Split-Ansicht wird als absoluter px-Wert unter "sbSplitPx"
 * gespeichert. Beim Oeffnen wurde sie ungeprueft uebernommen: auf einem
 * schmaleren Fenster (anderer Monitor, verkleinertes Fenster, Tablet quer→hoch)
 * war das Overlay dann breiter als der Viewport und ragte nach LINKS heraus —
 * Titel und die Zoom-/Schliessen-Knoepfe waren nicht mehr erreichbar und die
 * Werkzeugleiste begann mitten in einem Knopf.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

// ── Die Breite wird zentral geklemmt ─────────────────────────────────────────: Split-Breite darf das Overlay nie aus dem Bild schieben ─
// "sbSplitPx" ist ein absoluter px-Wert. Ungeprueft uebernommen war das Board
// auf einem schmaleren Fenster breiter als der Viewport und ragte nach links
// heraus — Titel, Zoom und Schliessen-Knopf waren nicht mehr erreichbar.
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
