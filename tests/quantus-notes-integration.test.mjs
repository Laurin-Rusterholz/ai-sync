import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

const coreScriptIndex = index.indexOf('<script src="/quantus-notes-core.js"></script>');
const noteIntegrationIndex = index.indexOf("const QUANTUS_NOTE_CLASSES");
assert.ok(coreScriptIndex >= 0, "desktop shell must load the shared Quantus Notes core");
assert.ok(noteIntegrationIndex > coreScriptIndex, "the core must load before desktop integrations use it");

assert.match(index, /<meta name="quantus-build" content="quantus-notes-v1\+/,
  "the visible build identifier must announce the note concept migration");
assert.match(index, /function createQuantusNote\(input, options = \{\}\)/,
  "all desktop apps need the central NoteFlow creation funnel");
assert.match(index, /function migrateQuantusNotes\(data\)/,
  "legacy notes and ideas need an idempotent migration entry point");
assert.match(index, /return migrateQuantusNotes\(d\);/,
  "normalization must run the note migration before exposing loaded data");
assert.match(index, /n\.notebookId = n\.notebookId \|\| null;/,
  "notes without an explicit notebook must stay in the Inbox");
assert.match(index, /books:\s*\{\},\s*\/\/ Kanonische ReadingHub-Bibliothek/,
  "ReadingHub books must have a canonical synced entity map");
assert.match(index, /noteClass === "general" && draft\.source\?\.app !== "noteflow"/,
  "general notes must remain a direct NoteFlow-only capture type");
assert.match(index, /\["idea", "short"\]\.includes\(draft\.noteClass\) && draft\.tags\.length === 0/,
  "idea and short-note capture must enforce a category/tag");
assert.match(index, /dedupeKey wird nur für echte Singleton-Spiegel/,
  "the integration must document and guard contextual-note dedupe semantics");
assert.match(index, /window\.openQuantusNoteComposer = openQuantusNoteComposer;/,
  "all apps need access to the common note composer");
assert.match(index, /<datalist id="qncTagList"><\/datalist>/,
  "the common composer must provide filtered existing-tag suggestions");
assert.match(index, /function quantusEnableTagAutocomplete\(root = document\)/,
  "existing tag fields across desktop apps must share filtered suggestions");
assert.match(index, /function quantusInjectAppNoteAction\(mainEl, route, id\)/,
  "every supported Quantus app needs a context-note entry point");
for (const route of ["programs", "goals", "decisions", "persons", "protocols", "workflows", "thesis", "leseplan", "smarter"]) {
  assert.match(index, new RegExp(`${route}:\\[`), `${route} must be represented in the context-note registry`);
}
assert.match(index, /tags:\[label\], lockedTags:\[label\]/,
  "context labels must survive autocomplete selection as locked tags");
assert.match(index, /id:ideaId,noteId,centralNoteId:noteId/,
  "idea projections must write both cross-device note reference aliases");

console.log("quantus notes integration: ok");
