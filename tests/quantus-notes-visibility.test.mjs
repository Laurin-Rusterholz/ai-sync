// Produktionsbefund (Review PR #220, P2-1):
//
// Mobile und Tablet loeschen Notizen als Entity-Tombstone (deleted:true,
// status:"deleted", deletedAt) und lassen die Entitaet im gemeinsamen
// Datensatz stehen; markDeleted in migrateQuantusNotes erzeugt dieselbe Form.
// Der Desktop zeigte solche Grabsteine trotzdem ueberall an: NoteFlow-Home
// und -Sidebar (samt Zaehlern), viewNotes, searchAllData und die
// Kontextnotiz-Sektionen von Projekt/Strategie/Konzept. Im Chromium-Test war
// die geloeschte Note sichtbar und weiter editierbar.
//
// Der Fix fuehrt quantusIsTombstonedNote/quantusLiveNotes ein und haengt sie
// an alle Listen-Sinks. `archived` zaehlt bewusst NICHT als Grabstein.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

// ── Verhalten der echten Helfer ──
const start = index.indexOf("function quantusIsTombstonedNote");
const end = index.indexOf("\n}", index.indexOf("function quantusLiveNotes")) + 2;
assert.ok(start > 0 && end > start, "Helfer muessen existieren");
const sandbox = { APP: { state: { data: null } } };
vm.createContext(sandbox);
vm.runInContext(index.slice(start, end), sandbox);

const data = { entities: { notes: {
  ok1: { id: "ok1", title: "lebt" },
  arch: { id: "arch", title: "archiviert", archived: true },
  d1: { id: "d1", title: "soft", deleted: true },
  d2: { id: "d2", title: "status", status: "deleted" },
  d3: { id: "d3", title: "stamp", deletedAt: "2026-01-01T00:00:00Z" },
} } };
const live = vm.runInContext("quantusLiveNotes", sandbox)(data).map(n => n.id).sort();
// join statt deepEqual: das Array stammt aus dem vm-Realm (anderes Array.prototype).
assert.equal(live.join(","), "arch,ok1",
  "Grabsteine (deleted/status/deletedAt) raus, archivierte Notizen bleiben");
assert.equal(vm.runInContext("quantusIsTombstonedNote", sandbox)({ archived: true }), false);

// ── Alle Listen-Sinks haengen am Filter ──
assert.match(index, /function viewNotes\(\) \{[\s\S]{0,220}let notes = quantusLiveNotes\(\);/,
  "viewNotes listet nur lebende Notizen");
assert.match(index, /quantusLiveNotes\(\)\.forEach\(n => \{\s*\n\s*if \(searchIn\(n\.title\)/,
  "searchAllData durchsucht nur lebende Notizen");
const contextual = index.match(/const contextualNotes = quantusLiveNotes\(\)/g) || [];
assert.equal(contextual.length, 4,
  "alle vier Kontextnotiz-Sektionen (Projekt/Strategie/Konzept/Lernprojekt) filtern");
assert.match(index, /const liveNotes = \(\) => Object\.values\(notesMap\(\)\)\.filter/,
  "NoteFlow definiert seinen lokalen Sichtbarkeitsfilter");
assert.doesNotMatch(index, /Object\.values\(notesMap\(\)\)(?!\.filter\(\(n\) => n && !noteTombstoned)/,
  "kein NoteFlow-Listenpfad liest mehr ungefiltert aus notesMap()");
assert.match(index, /window\.quantusIsTombstonedNote = quantusIsTombstonedNote;/,
  "der Filter ist fuer andere Bloecke ueber window erreichbar (CLAUDE.md Fallstrick 1)");

console.log("Tombstone-Sichtbarkeit (Listen/Suche/Zaehler): ok");
