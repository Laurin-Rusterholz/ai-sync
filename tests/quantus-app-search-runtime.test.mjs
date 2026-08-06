/*
 * App-Suche — Laufzeittest.
 *
 * Produktionsbefund: Cmd+K mit "flower" fand nur Mails, aber nicht die App
 * FlowerTech. Ursache war KEINE fehlende Verdrahtung, sondern eine zweite,
 * eingefrorene App-Liste (`SPOTLIGHT_APPS`) neben der echten Registry
 * `getAllApps()`. Neu hinzugekommene Apps fehlten dort schlicht.
 *
 * Dieser Test prüft deshalb nicht mehr, ob bestimmte Zeichenketten im Quelltext
 * stehen — er SCHNEIDET die echten Funktionen aus index.html heraus und FÜHRT
 * SIE AUS, gegen eine nachgebaute Registry. Ein erneutes Einfrieren der Liste
 * fällt damit sofort auf.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── Die echten Funktionen aus der Seite holen und ausführen ────────────────
const from = index.indexOf("const SPOTLIGHT_APP_ACTIONS = [");
const to = index.indexOf("window.buildAppSearchItems = buildAppSearchItems;");
ok(from > 0 && to > from, "die App-Registry der Suche wurde nicht gefunden");
const source = index.slice(from, to);
ok(!/const SPOTLIGHT_APPS\s*=\s*\[/.test(index),
  "die eingefrorene zweite App-Liste (SPOTLIGHT_APPS) ist zurück — genau der Fehler, der FlowerTech unauffindbar machte");

// Registry-Doppel: dieselbe Form wie getAllApps() liefert.
const REGISTRY = [
  { key: "dashboard", icon: "🏠", label: "Dashboard", desc: "Übersicht über alles" },
  { key: "flowertech", icon: "🌸", label: "FlowerTech", desc: "Projekte, Offerten, Rechnungen, KI & Content" },
  { key: "tasks", icon: "✅", label: "Aufgaben", desc: "Aufgabenverwaltung" },
  { key: "meineseite", icon: "📄", label: "Meine Seite", desc: "", isCustomPage: true },
];

const navigated = [];
const opened = [];
const sandbox = {
  getAllApps: () => REGISTRY,
  navigate: (key) => navigated.push(key),
  console: { warn() {} },
  window: { location: { hash: "" } },
  openResearchHub: () => opened.push("research"),
  openReadingHub: () => opened.push("reading"),
  openReadlist: () => opened.push("readlist"),
  openTranslator: () => opened.push("translator"),
  openDailyWrap: () => opened.push("dailywrap"),
};
sandbox.window.openResearchHub = sandbox.openResearchHub;
sandbox.window.openReadingHub = sandbox.openReadingHub;
sandbox.window.openReadlist = sandbox.openReadlist;
sandbox.window.openTranslator = sandbox.openTranslator;
sandbox.window.openDailyWrap = sandbox.openDailyWrap;
sandbox.window.APP = { state: { data: { entities: { projects: {} } } } };

const factory = new Function(
  ...Object.keys(sandbox),
  source + "\nreturn buildAppSearchItems;"
);
const buildAppSearchItems = factory(...Object.values(sandbox));
const items = buildAppSearchItems();

// ── 1. Jede App der Registry ist ein Suchresultat ──────────────────────────
ok(items.length >= REGISTRY.length, `zu wenige App-Treffer: ${items.length}`);
for (const app of REGISTRY) {
  const hit = items.find((it) => it.id === "app-" + app.key);
  ok(!!hit, `App aus der Registry fehlt in der Suche: ${app.key}`);
  ok(hit.kind === "app", `${app.key} ist kein App-Treffer`);
  ok(hit.category === "App", `${app.key} hat keine Kategorie`);
  ok(!!hit.icon, `${app.key} hat kein Icon`);
}
// Auch eigene Seiten des Nutzers sind auffindbar — das war mit der festen Liste
// grundsätzlich unmöglich.
ok(items.some((it) => it.id === "app-meineseite"), "eigene Seiten sind nicht durchsuchbar");

// -- 2. Der gemeldete Fall: Eingabe "flower" findet FlowerTech --------------
const flower = items.find((it) => it.title === "FlowerTech");
ok(!!flower, "FlowerTech ist kein App-Suchresultat — der gemeldete Produktionsfehler");
ok(/flower/i.test(flower.keywords), "FlowerTech ist ueber \u201eflower\u201c nicht auffindbar");
ok(/flower/i.test(flower.title), "der Titel trägt den Suchbegriff nicht");

// ── 3. Enter öffnet die App wirklich ───────────────────────────────────────
flower.open();
ok(navigated.includes("flowertech"),
  "Öffnen eines App-Treffers navigiert nicht zur App");

// ── 4. Aktionen ohne eigene Route bleiben erhalten ─────────────────────────
for (const title of ["Newsroom", "ReadingHub", "Leseliste", "Übersetzer", "Editor", "Daily Wrap", "KV-Cockpit"]) {
  ok(items.some((it) => it.title === title), `Aktions-Eintrag verloren: ${title}`);
}
const translator = items.find((it) => it.title === "Übersetzer");
translator.open();
ok(opened.includes("translator"), "der Aktions-Eintrag Übersetzer öffnet nichts");

// ── 5. Keine Duplikate ─────────────────────────────────────────────────────
const ids = items.map((it) => it.id);
ok(new Set(ids).size === ids.length, "die App-Suche liefert doppelte Einträge");

// ── 6. Robust ohne Registry (frühe Ladephase) ──────────────────────────────
{
  const noRegistry = new Function(
    ...Object.keys(sandbox),
    source + "\nreturn buildAppSearchItems;"
  )(...Object.keys(sandbox).map((k) => (k === "getAllApps" ? undefined : sandbox[k])));
  const fallback = noRegistry();
  ok(Array.isArray(fallback) && fallback.length > 0,
    "ohne Registry bricht die Suche zusammen, statt wenigstens die Aktionen zu liefern");
}

// ── 7. Die Suche wird auch tatsächlich damit gespeist ──────────────────────
ok(/items\.push\(\.\.\.buildAppSearchItems\(\)\);/.test(index),
  "Spotlight speist die App-Registry nicht mehr ein");
ok(/kind: "app",\s*\n\s*id: app\.id,/.test(index),
  "die universale Suche speist die App-Registry nicht mehr ein");

// ── 8. Bau-Kennung mitgezogen ──────────────────────────────────────────────
// Sie wandert als x-quantus-build-Header mit und macht per HEAD-Request
// pruefbar, welcher Stand wirklich ausgeliefert wird.
const build = /<meta\s+name="quantus-build"\s+content="([^"]*)"/.exec(index);
ok(!!build, "die Bau-Kennung fehlt");
ok(/app-search-registry/.test(build[1]), `die Bau-Kennung wurde nicht hochgezogen: ${build[1]}`);

console.log(`app search runtime: ok (${checks} Pruefungen)`);
