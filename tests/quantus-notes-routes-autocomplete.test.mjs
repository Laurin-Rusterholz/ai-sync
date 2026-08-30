// Produktionsbefunde (Review PR #220, P2-2/P2-5/D5/D7):
//
// 1) Mobile schrieb Quellrouten als "#/readinghub?id=<id>" und "#/ideen",
//    das Tablet "#/reading" und "#/bm" — der Desktop-Router matcht keinen
//    dieser Werte, der Quellsprung lief ins Leere. quantusResolveNoteRoute
//    bildet die Fremdformen tolerant auf die kanonische Route ab, und
//    openNoteSource behandelt Pfad-Routen (bm.html) als href statt hash.
// 2) quantusEnableTagAutocomplete matchte camelCase-Feld-Ids (newNoteTags,
//    quickNoteTag, dashShortTag) nicht — das Mehrfach-Tag-Feld der
//    klassischen Notiz-Erstellansicht blieb ohne gefilterte Vorschlaege.
// 3) bm.html baute Datalist-Optionen ohne Praefix: ab dem ersten Komma war
//    die Vorschlagsliste unsichtbar, eine Auswahl haette alle Tags ersetzt.
// 4) Die Route "briefings" fehlte im Kontextnotiz-Registry.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const bm = fs.readFileSync(path.join(root, "public", "bm.html"), "utf8");

// ── Verhalten der echten Routen-Aufloesung ──
const start = index.indexOf("function quantusResolveNoteRoute(route)");
const end = index.indexOf("\n}", start) + 2;
assert.ok(start > 0, "quantusResolveNoteRoute muss existieren");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(index.slice(start, end), sandbox);
const resolve = vm.runInContext("quantusResolveNoteRoute", sandbox);

assert.equal(resolve("#/readinghub?id=b1"), "#/readinghub/b1", "mobile Buchroute");
assert.equal(resolve("#/readinghub?id=b%201"), "#/readinghub/b 1", "URL-dekodiert");
assert.equal(resolve("#/readinghub/b1"), "#/readinghub/b1", "kanonische Form bleibt");
assert.equal(resolve("#/ideen"), "#/ideas", "mobile Ideenroute");
assert.equal(resolve("#/ideen/i1"), "#/ideas/i1");
assert.equal(resolve("#/reading"), "#/readinghub", "Tablet-Lesehub");
assert.equal(resolve("#/readinghub"), "#/readinghub", "readinghub faellt nicht auf #/reading");
assert.equal(resolve("#/bm"), "/bm.html", "Tablet-BM als Satellitenpfad");
assert.equal(resolve("#/projects/p1"), "#/projects/p1", "fremde Routen unveraendert");

// ── openNoteSource nutzt die Aufloesung und kann Pfade oeffnen ──
assert.match(index, /openNoteSource[\s\S]{0,600}quantusResolveNoteRoute/,
  "openNoteSource loest die Route ueber die Toleranz-Abbildung auf");
assert.match(index, /route\.startsWith\("#"\) \? location\.hash = route[\s\S]{0,40}location\.href = route|if \(route\.startsWith\("#"\)\) location\.hash = route;\s*\n\s*else location\.href = route;/,
  "Pfad-Routen (bm.html) werden als href geoeffnet, nicht als hash");

// ── camelCase-Feld-Erkennung ──
assert.match(index, /replace\(\/\(\[a-z0-9\]\)\(\[A-Z\]\)\/g, "\$1-\$2"\)/,
  "looksLikeTagField bricht camelCase-Grenzen auf (newNoteTags, dashShortTag …)");

// ── bm.html: Praefix-Optionen ──
assert.match(bm, /complete\.concat\(\[tag\]\)\.join\(", "\)/,
  "bm.html-Datalist traegt die bereits gewaehlten Tags als Praefix im Optionswert");
assert.match(bm, /tagSuggestions\(notes,query,complete\)/,
  "Vorschlaege schliessen bereits gewaehlte Tags aus");

// ── Briefings im Kontextnotiz-Registry ──
assert.match(index, /briefings:\["briefings","briefing","Briefing","research"\]/,
  "die Briefings-Route bekommt einen Kontextnotiz-Einstieg");

console.log("Quellrouten-Toleranz & Autocomplete-Breite: ok");
