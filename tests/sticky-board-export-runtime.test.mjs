/*
 * Sticky Board — Export, Laufzeittest.
 *
 * Produktionsbefund: Im geoeffneten Board stand angeblich weiterhin
 * "CSV" auf dem Werkzeugleisten-Knopf statt des Export-Dialogs.
 *
 * Dieser Test schneidet die ECHTE toolbarHTML() aus index.html heraus und
 * fuehrt sie aus, statt nur nach Zeichenketten zu suchen. Damit ist belegbar,
 * was der Knopf im gerenderten Board wirklich anzeigt und ausloest — und eine
 * zweite, ungenutzte Renderstelle wuerde sofort auffallen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── Es darf genau EINE Board-Implementierung geben ─────────────────────────
const boardDefs = index.match(/window\.openStickyBoard\s*=/g) || [];
ok(boardDefs.length === 1,
  `es gibt ${boardDefs.length} Definitionen von openStickyBoard — eine zweite Renderstelle wuerde die andere ueberschreiben`);
const toolbarDefs = index.match(/function toolbarHTML\(\)/g) || [];
ok(toolbarDefs.length === 1, `es gibt ${toolbarDefs.length} Definitionen von toolbarHTML()`);

// ── Die echte Werkzeugleiste bauen ─────────────────────────────────────────
const start = index.indexOf("function toolbarHTML() {");
const end = index.indexOf("// ════════════════════════════ RENDERING", start);
ok(start > 0 && end > start, "toolbarHTML() wurde nicht gefunden");
const source = index.slice(start, end);

const COLORS = [
  { key: "yellow", label: "Gelb", bg: "#ffe066", text: "#3a2f00" },
  { key: "blue", label: "Blau", bg: "#a5d8ff", text: "#0a2e4d" },
];
const toolbarHTML = new Function("COLORS", source + "\nreturn toolbarHTML;")(COLORS);
const html = toolbarHTML();

// ── 1. Der gemeldete Fall: kein reiner CSV-Knopf mehr ──────────────────────
ok(!/⭳ CSV/.test(html),
  "die Werkzeugleiste zeigt weiterhin den nackten CSV-Knopf — der gemeldete Produktionsfehler");
ok(/⭳ Export/.test(html), "der Export-Knopf fehlt in der gerenderten Werkzeugleiste");

// ── 2. Der Knopf loest den Export-Dialog aus ───────────────────────────────
const button = /<button[^>]*data-sb="export"[^>]*>([^<]*)<\/button>/.exec(html);
ok(!!button, 'die Werkzeugleiste enthaelt keinen Knopf mit data-sb="export"');
ok(button[1].includes("Export"), `der Export-Knopf ist falsch beschriftet: ${button[1]}`);
ok(/title="[^"]*PNG[^"]*"/.test(button[0]) || /title="[^"]*PDF[^"]*"/.test(button[0]),
  "der Export-Knopf erklaert die Formate nicht");

// Die Aktion muss im Klick-Verteiler auf den Dialog zeigen, nicht auf den
// direkten CSV-Download.
ok(index.includes('case "export": openExportDialog(); break;'),
  'data-sb="export" ruft nicht openExportDialog() auf');
ok(!index.includes('case "export": exportCSV()'),
  'data-sb="export" laedt wieder direkt CSV herunter');

// ── 3. Import bleibt daneben erhalten ──────────────────────────────────────
ok(/data-sb="import"/.test(html), "der Import-Knopf ist aus der Werkzeugleiste verschwunden");
ok(/data-sb="filterToggle"/.test(html), "der Filter-Knopf ist aus der Werkzeugleiste verschwunden");

// ── 4. Der Dialog bietet die verlangten Formate an ─────────────────────────
const dialogStart = index.indexOf("function openExportDialog() {");
const dialogEnd = index.indexOf("function exportCSV(scope)", dialogStart);
ok(dialogStart > 0 && dialogEnd > dialogStart, "openExportDialog() wurde nicht gefunden");
const dialog = index.slice(dialogStart, dialogEnd);
for (const [value, label] of [["png", "PNG"], ["pdf", "PDF"], ["svg", "SVG"], ["csv", "CSV"]]) {
  ok(dialog.includes(`value="${value}"`), `Format ${label} fehlt im Export-Dialog`);
}
for (const scope of ["board", "selection", "viewport"]) {
  ok(dialog.includes(`value="${scope}"`), `Umfang ${scope} fehlt im Export-Dialog`);
}
ok(dialog.includes("sbExportStatus"), "der Dialog hat keinen Lade-/Fehlerbereich");

// ── 5. Bau-Kennung: macht den ausgelieferten Stand pruefbar ────────────────
// Die Edge Function reicht sie als x-quantus-build weiter, deshalb laesst sich
// mit einem HEAD-Request feststellen, ob ein Fix produktiv schon angekommen ist,
// ohne die mehrere Megabyte grosse Seite zu laden.
const build = /<meta\s+name="quantus-build"\s+content="([^"]*)"/.exec(index);
ok(!!build, "die Bau-Kennung fehlt");
ok(/sticky-export/.test(build[1]), `die Bau-Kennung nennt den Stand nicht: ${build[1]}`);
const edge = fs.readFileSync(path.join(root, "netlify/edge-functions/quantus-app-registry.js"), "utf8");
ok(edge.includes('headers.set("x-quantus-build"'), "die Bau-Kennung wird nicht als Header ausgeliefert");
ok(/no-store|no-cache/.test(edge), "die ausgelieferte Seite darf nicht zwischengespeichert werden");

console.log(`sticky board export runtime: ok (${checks} Pruefungen)`);
