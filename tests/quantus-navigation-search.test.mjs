/*
 * Navigation und Suche.
 *
 * 1) Die horizontale App-Leiste unter dem Header ist ersatzlos entfernt.
 *    Navigiert wird nur noch über die linke Sidebar und die Commandbar.
 * 2) Apps sind gleichwertige Suchresultate — dieselbe Registry versorgt
 *    Spotlight (⌘K) und die universale Suche.
 * 3) Spotlight ist per Tastatur bedienbar und für Screenreader beschriftet.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── 1. Keine horizontale App-Leiste mehr ───────────────────────────────────
ok(!/<nav[^>]*class="app-nav"/.test(index), "die horizontale App-Leiste steht wieder im Markup");
ok(!index.includes('id="appNav"'), "der Container der App-Leiste ist wieder da");
ok(!/function renderAppNav\s*\(/.test(index), "renderAppNav() ist wieder da");
ok(!/[^.\w]renderAppNav\(\)/.test(index), "renderAppNav() wird wieder aufgerufen");
// Die linke Navigation und die Commandbar bleiben.
ok(/function renderSidebar\(\)/.test(index), "die linke Sidebar-Navigation fehlt");
ok(index.includes('id="sidebarNav"'), "der Sidebar-Container fehlt");
ok(index.includes('id="globalSearch"'), "die globale Suche in der Commandbar fehlt");
ok(index.includes('id="btnBack"') && index.includes('id="btnForward"'), "Zurück/Vor in der Commandbar fehlen");
// Sicherheitsnetz + Workspace-Fokus.
ok(index.includes(".app-nav{display:none !important}"), "das Sicherheitsnetz gegen Alt-App-Leisten fehlt");
ok(/function applyWorkspaceFocus\(\)/.test(index), "applyWorkspaceFocus() fehlt");
ok(index.includes("body.workspace-focus .main .app-nav"),
  "im geöffneten Projekt wird nicht gegen doppeltes App-Navigieren im Inhalt geschützt");
ok(/applyWorkspaceFocus\(\);/.test(index), "applyWorkspaceFocus() wird im Render nicht aufgerufen");

// ── 2. Apps als gleichwertige Suchresultate ────────────────────────────────
ok(/const SPOTLIGHT_APPS = \[/.test(index), "die App-Registry für die Suche fehlt");
ok(/function buildAppSearchItems\(\)/.test(index), "buildAppSearchItems() fehlt");
ok(index.includes("window.buildAppSearchItems = buildAppSearchItems;"),
  "die App-Registry wird nicht exportiert — die universale Suche kann sie nicht nutzen");
ok(/items\.push\(\.\.\.buildAppSearchItems\(\)\);/.test(index),
  "Spotlight indexiert die Apps nicht mehr über die gemeinsame Registry");
// Universale Suche zieht dieselbe Registry und listet Apps zuerst.
ok(/kind: "app",\s*\n\s*id: app\.id,/.test(index), "die universale Suche indexiert keine Apps");
ok(index.includes('const order = ["app","task","note","mail"'), "Apps werden in der universalen Suche nicht gelistet");
ok(index.includes('<option value="app">📱 Apps</option>'), "der Typfilter kennt keine Apps");
ok(/window\._openAppSearchResult = function\(appId\)/.test(index),
  "ein App-Treffer der universalen Suche lässt sich nicht öffnen");
// Icon und Kategorie am Treffer.
ok(index.includes("spotlight-result-cat"), "die Kategorie fehlt am Suchtreffer");
ok(index.includes("category: 'App'"), "Apps tragen keine Kategorie");
ok(index.includes("spotlight-result-icon"), "das Icon fehlt am Suchtreffer");

// ── 3. Tastatur, Zustände und ARIA ─────────────────────────────────────────
const spotlight = index.slice(index.indexOf('id="spotlightOverlay"'), index.indexOf('id="spotlightOverlay"') + 1600);
ok(spotlight.includes('role="dialog"') && spotlight.includes('aria-modal="true"'), "der Suchdialog ist nicht als Dialog ausgezeichnet");
ok(spotlight.includes('role="listbox"'), "die Trefferliste ist nicht als Listbox ausgezeichnet");
ok(spotlight.includes('role="combobox"'), "das Suchfeld ist nicht als Combobox ausgezeichnet");
ok(spotlight.includes('aria-live="polite"'), "es gibt keine Live-Region für die Trefferzahl");
ok(index.includes('role="option" aria-selected='), "Treffer sind nicht als Optionen ausgezeichnet");
ok(index.includes("aria-activedescendant"), "die Tastaturauswahl wird nicht an Screenreader gemeldet");
// Enter öffnet, Escape schliesst, Pfeile navigieren.
ok(/if \(e\.key === 'Enter'\) \{ activateSpotlightItem\(\)/.test(index), "Enter öffnet den Treffer nicht");
ok(/if \(e\.key === 'Escape'\) \{ hideSpotlight\(\)/.test(index), "Escape schliesst die Suche nicht");
ok(index.includes("e.key === 'ArrowDown'") && index.includes("e.key === 'ArrowUp'"), "Pfeiltasten navigieren nicht");
ok(index.includes("_spotlightReturnFocus"), "der Fokus kehrt nach dem Schliessen nicht zurück");
// Leer- und Kein-Treffer-Zustand.
ok(index.includes("Keine Treffer für"), "es fehlt ein aussagekräftiger Kein-Treffer-Zustand");
ok(/const apps = items\.filter\(it => it\.kind === 'app'\)\.slice\(0, 8\);/.test(index),
  "der leere Zustand zeigt die Apps nicht als schnellsten Einstieg");
// Escape auch in der universalen Suche.
ok(/if \(e\.key === "Escape"\)\{ e\.preventDefault\(\); closeModal\(\); return; \}/.test(index),
  "Escape schliesst die universale Suche nicht");

console.log(`navigation & search: ok (${checks} Pruefungen)`);
