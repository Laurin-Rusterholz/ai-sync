/*
 * Sticky Board — Export.
 *
 * Der nackte CSV-Download ist einem verständlichen Export-Flow gewichen:
 * Umfang wählbar (Auswahl / gesamtes Board / sichtbarer Ausschnitt), Format
 * PNG, druckbares PDF, SVG oder CSV. Das Bild wird als eigene SVG-Zeichnung
 * gebaut — dadurch ist die Werkzeugleiste garantiert nicht im Export, und der
 * sichtbare Zustand (Farben, Tags, Verbindungen, Zeichnungen) stimmt.
 *
 * Keine bestehende Board-Funktion darf dabei verschwinden.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── 1. Der Export-Flow ersetzt den nackten CSV-Button ──────────────────────
ok(index.includes('case "export": openExportDialog(); break;'),
  "der Export-Knopf lädt wieder direkt CSV herunter statt den Export-Flow zu öffnen");
ok(!index.includes('fmtBtn("export", "⭳ CSV"'), "die Werkzeugleiste bietet wieder nur CSV an");
ok(index.includes('fmtBtn("export", "⭳ Export"'), "der Export-Knopf fehlt in der Werkzeugleiste");
ok(/function openExportDialog\(\)/.test(index), "openExportDialog() fehlt");

// ── 2. Umfang und Formate ──────────────────────────────────────────────────
ok(/function exportNotes\(scope\)/.test(index), "die Umfangsauswahl (exportNotes) fehlt");
for (const scope of ["selection", "viewport", "board"]) {
  ok(index.includes(`"${scope}"`), `der Umfang ${scope} fehlt`);
}
for (const format of ['value="png"', 'value="pdf"', 'value="svg"', 'value="csv"']) {
  ok(index.includes(format), `das Format ${format} fehlt im Export-Dialog`);
}
ok(/function runExport\(opts\)/.test(index), "runExport() fehlt");
ok(/function printBoardImage\(dataUrl, landscape\)/.test(index), "der druckbare PDF-Weg fehlt");
ok(/function svgToPngBlob\(svgText, width, height, scale\)/.test(index), "die PNG-Rasterung fehlt");
// CSV bleibt als Datenexport erhalten und respektiert denselben Umfang.
ok(/function exportCSV\(scope\)/.test(index), "der CSV-Datenexport ist verschwunden");
ok(index.includes('exportCSV(opts.scope)'), "CSV ignoriert die Umfangsauswahl");

// ── 3. Inhalt des Exports ──────────────────────────────────────────────────
const svgBuilder = index.slice(index.indexOf("function buildBoardSVG(opts)"), index.indexOf("function svgToPngBlob"));
ok(svgBuilder.length > 2000, "buildBoardSVG() nicht gefunden");
ok(svgBuilder.includes("boardTitle()"), "der Titel fehlt im Export");
ok(svgBuilder.includes("exportDateLabel()"), "das Datum fehlt im Export");
ok(svgBuilder.includes("colorByKey(n.color)"), "die Post-it-Farben fehlen im Export");
ok(svgBuilder.includes("n.tags"), "die Tags fehlen im Export");
ok(svgBuilder.includes("connPath(a, b, cn.style)"), "die Verbindungen fehlen im Export");
ok(svgBuilder.includes("if (o.grid)"), "das optionale Raster fehlt");
ok(svgBuilder.includes("usedColors"), "die optionale Legende fehlt");
ok(svgBuilder.includes("drawings.forEach"), "die Zeichnungen fehlen im Export");
// Der Export ist eine eigene Zeichnung — also KEIN Screenshot des Editors.
ok(!svgBuilder.includes("sbToolbar") && !svgBuilder.includes("sb-topbar"),
  "die Werkzeugleiste wandert wieder mit in den Export");

// ── 4. Robuste Grenzen, Lade- und Fehlerzustand ────────────────────────────
const boundsStart = index.indexOf("function exportBounds(notes, drawings)");
const bounds = index.slice(boundsStart, index.indexOf("function wrapText(text, maxChars, maxLines)", boundsStart));
ok(bounds.includes("!isFinite(minX)"), "leere/kaputte Boards würden NaN-Koordinaten ins SVG schreiben");
ok(index.includes('id="sbExportStatus"'), "es gibt keinen Statusbereich im Export-Dialog");
ok(/function setExportBusy\(busy, message\)/.test(index), "der Ladezustand fehlt");
ok(/function setExportError\(message\)/.test(index), "der Fehlerzustand fehlt");
ok(index.includes('setExportBusy(true, "Board wird gerendert…")'), "beim Rendern wird kein Ladezustand gezeigt");
ok(index.includes("catch (err)") && index.includes("[StickyBoard] Export:"), "Exportfehler werden nicht abgefangen");
ok(index.includes('aria-live="polite"'), "der Exportstatus wird nicht angesagt");

// ── 5. Keine Regression bestehender Board-Funktionen ───────────────────────
for (const fn of [
  "window.openStickyBoard", "window.renderStickyBoardBlock", "function openImport(",
  "function importLines(", "function toggleFilterbar(", "function renderConnections(",
  "function renderNotes(", "function undo(", "function redo(", "function fitToContent(",
]) {
  ok(index.includes(fn), `bestehende Board-Funktion fehlt: ${fn}`);
}

console.log(`sticky board export: ok (${checks} Pruefungen)`);
