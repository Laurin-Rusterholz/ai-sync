import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, "public", "quantus-notes-core.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "quantus-notes-core.js" });

const Core = context.QuantusNotesCore;
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.ok(Core, "QuantusNotesCore must register on the browser/global context");
assert.ok(Object.isFrozen(Core), "the exported core API must be immutable");

assert.deepEqual(plain(Core.NOTE_CLASSES), {
  reading: "Lesenotiz",
  learning: "Lernnotiz",
  idea: "Idee",
  general: "Generelle Notiz",
  short: "Kurze Notiz",
  research: "Recherchenotiz",
}, "the shared contract must expose exactly the six note classes");
assert.ok(Object.isFrozen(Core.NOTE_CLASSES));

assert.deepEqual(plain(Core.BOOK_STATUSES), {
  registered: "Registriert/ungelesen",
  reading: "Lese ich",
  paused: "Pausiert",
  completed: "Gelesen",
  abandoned: "Abgebrochen",
}, "ReadingHub must share the five canonical lifecycle states");

assert.deepEqual(
  plain(Core.normalizeTags(["  Bücher ", "bücher", "KI", "ki", "", null], ["BÜCHER", "Ki"])),
  ["BÜCHER", "Ki"],
  "tags must be trimmed, case-insensitively deduplicated and reuse preferred spellings",
);
assert.deepEqual(plain(Core.normalizeTags("Projekt, projekt, Lernen")), ["Projekt", "Lernen"]);

const tagNotes = [
  { tags: ["Bücher", "KI", "Quantus"] },
  { tags: ["ki", "Lernen", "Recherche"] },
  { tags: null },
];
assert.deepEqual(
  plain(Core.tagSuggestions(tagNotes, "LE", [])),
  ["Lernen"],
  "autocomplete must filter existing tags case-insensitively",
);
assert.deepEqual(
  plain(Core.tagSuggestions(tagNotes, "", ["ki", "Recherche"])),
  ["Bücher", "Lernen", "Quantus"],
  "autocomplete must suppress already selected tags and duplicate spellings",
);

const legacyArray = [
  { id: "dup", title: "Erste", custom: { keep: true } },
  { id: "dup", title: "Zweite" },
  { title: "Ohne ID" },
];
legacyArray.persisted = { id: "dup", title: "String-keyed Eintrag" };
legacyArray[8] = { title: "Sparse" };
legacyArray["custom tag"] = { title: "Custom key" };
legacyArray.push({ id: "__proto__", title: "Reserved" });
const rawLegacyMap = Core.normalizeEntityMap(legacyArray, "note");
const legacyMap = plain(rawLegacyMap);
assert.deepEqual(Object.keys(legacyMap), ["dup", "dup_2", "legacy_note_2", "legacy_note_8", "__proto__", "dup_3", "legacy_note_custom_tag"]);
assert.equal(legacyMap.dup.title, "Erste");
assert.equal(legacyMap.dup_2.title, "Zweite");
assert.deepEqual(legacyMap.dup.custom, { keep: true });
assert.equal(legacyMap.legacy_note_8.title, "Sparse");
assert.equal(legacyMap.legacy_note_custom_tag.title, "Custom key");
assert.equal(Object.prototype.hasOwnProperty.call(rawLegacyMap, "__proto__"), true);
assert.notEqual(Object.getPrototypeOf(rawLegacyMap), null, "normal object prototype must be retained");
assert.deepEqual(plain(Core.normalizeEntityMap(legacyMap, "note")), legacyMap,
  "array-to-map migration must be idempotent");

assert.deepEqual(plain(Core.normalizeSource({ app: "newsroom", entityId: "a-1" }, {
  entityType: "article",
  label: "Artikel",
  route: "#/newsroom/a-1",
})), {
  app: "articles",
  entityType: "article",
  entityId: "a-1",
  label: "Artikel",
  route: "#/newsroom/a-1",
});
assert.equal(Core.normalizeSource("Reading Hub – Buch").app, "readinghub");
assert.equal(Core.normalizeSource("Newsroom article").app, "articles");
assert.equal(Core.normalizeSource({ app:"reading-hub" }).app, "readinghub");
assert.equal(Core.normalizeSource({ app:"newsroom" }).app, "articles");
assert.equal(Core.normalizeSource("Idee").app, "ideas");
assert.equal(Core.normalizeSource("BM Vorbereitung").app, "bmpruefung");
assert.equal(Core.normalizeSource("Smarter Lernplan").app, "smarter");
assert.equal(Core.normalizeSource("Quick shortnote").app, "shortnote");
assert.equal(Core.normalizeSource("").app, "noteflow");

for (const [input, app, entityType, entityId] of [
  [{ bookId:"book-a", source:{} }, "readinghub", "book", "book-a"],
  [{ readingHubBookId:"book-b" }, "readinghub", "book", "book-b"],
  [{ ideaId:"idea-a", source:{} }, "ideas", "idea", "idea-a"],
  [{ source:"Smarter Lernplan" }, "smarter", "learning", null],
  [{ source:"BM Vorbereitung" }, "bmpruefung", "learning", null],
  [{ source:"RecallLab" }, "recalllab", "learning", null],
  [{ source:"Newsroom Artikel" }, "articles", "research", null],
  [{ source:"quick shortnote" }, "shortnote", "shortnote", null],
]) {
  const inferred = plain(Core.normalizeNoteDraft({ title:"Legacy", content:"Text", ...input }, { now:"2026-08-29T10:00:00.000Z" }));
  assert.deepEqual([inferred.source.app, inferred.source.entityType, inferred.source.entityId], [app, entityType, entityId]);
}

for (const href of ["https://quantus.example/a", "http://example.test", "mailto:test@example.test", "#/notes/1", "/notes/1", "../notes/1", "notes/1", "?note=1"]) {
  assert.equal(Core.isSafeNoteHref(href), true, `${href} must remain an allowed note link`);
}
for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:msgbox(1)", "//evil.example/x", "\\\\evil.example\\x", "java\nscript:alert(1)"]) {
  assert.equal(Core.isSafeNoteHref(href), false, `${href} must be rejected as an unsafe note link`);
}

assert.equal(Core.inferLegacyClass({ readingHubBookId: "book-1" }), "reading");
assert.equal(Core.inferLegacyClass({ bookId: "b1", source: {} }), "reading");
assert.equal(Core.inferLegacyClass({ ideaId: "idea-1" }), "idea");
assert.equal(Core.inferLegacyClass({ source: "BM-Vorbereitung" }), "learning");
assert.equal(Core.inferLegacyClass({ source: "BM Vorbereitung" }), "learning");
assert.equal(Core.inferLegacyClass({ tags: ["Newsroom"] }), "research");
assert.equal(Core.inferLegacyClass({ source: "quick-note" }), "short");
assert.equal(Core.inferLegacyClass({ title: "Freie Notiz" }), "general");
assert.equal(Core.inferLegacyClass({ noteClass: "reading", source: "Newsroom" }), "reading");

const normalizedNote = plain(Core.normalizeNoteDraft({
  id: "note-1",
  title: "  Recherchetitel  ",
  content: 42,
  noteClass: "research",
  tags: ["KI", "ki"],
  notebookId: "",
  source: { app: "newsroom" },
  createdAt: "2026-08-01T08:00:00.000Z",
  customExtension: { preserved: true },
}, {
  now: "2026-08-29T10:00:00.000Z",
  preferredTags: ["Ki"],
  source: {
    entityType: "article",
    entityId: "article-1",
    label: "Artikel",
    route: "#/newsroom/article-1",
  },
}));
assert.equal(normalizedNote.title, "Recherchetitel");
assert.equal(normalizedNote.content, "42");
assert.equal(normalizedNote.noteClass, "research");
assert.deepEqual(normalizedNote.tags, ["Ki"]);
assert.equal(normalizedNote.notebookId, null, "missing notebook selection must mean Inbox");
assert.deepEqual(normalizedNote.source, {
  app: "articles",
  entityType: "article",
  entityId: "article-1",
  label: "Artikel",
  route: "#/newsroom/article-1",
});
assert.equal(normalizedNote.createdAt, "2026-08-01T08:00:00.000Z");
assert.equal(normalizedNote.updatedAt, "2026-08-29T10:00:00.000Z");
assert.deepEqual(normalizedNote.customExtension, { preserved: true }, "unknown schema fields must survive normalization");

for (const [legacy, canonical] of [
  ["registered", "registered"],
  ["am lesen", "reading"],
  ["pause", "paused"],
  ["done", "completed"],
  ["dropped", "abandoned"],
  ["unbekannt", "registered"],
]) {
  assert.equal(Core.normalizeBookStatus(legacy), canonical, `book status ${legacy} must normalize to ${canonical}`);
}

const titleOnlyBook = plain(Core.createTitleOnlyBook({ title: "  Der Prozess  ", author: "Franz Kafka" },
  () => "book-fixed",
  () => "2026-08-29T11:00:00.000Z"));
assert.deepEqual(titleOnlyBook, {
  id: "book-fixed",
  title: "Der Prozess",
  author: "Franz Kafka",
  isbn: "",
  coverUrl: "",
  targetDate: null,
  fileName: null,
  pages: [],
  fullText: "",
  totalPages: 0,
  currentPage: 0,
  status: "registered",
  progress: 0,
  isManual: true,
  hasPdfFile: false,
  createdAt: "2026-08-29T11:00:00.000Z",
  updatedAt: "2026-08-29T11:00:00.000Z",
}, "a book title alone must be enough to register a complete canonical book");
assert.throws(() => Core.createTitleOnlyBook({ title: "   " }), /Buchtitel.*erforderlich/);
const clampedBook = Core.createTitleOnlyBook({ title: "Grenzen", progress: 120, currentPage: -4, status: "gelesen" });
assert.equal(clampedBook.progress, 100);
assert.equal(clampedBook.currentPage, 0);
assert.equal(clampedBook.status, "completed");

const book = { id: "book-1", title: "Der Prozess" };
const quote = plain(Core.buildReadingNoteDraft(book, {
  content: "Jemand musste Josef K. verleumdet haben.",
  readingKind: "quote",
  tags: ["Klassiker", "der prozess"],
  originId: "annotation-1",
  page: 12,
}));
assert.equal(quote.noteClass, "reading");
assert.equal(quote.readingKind, "quote");
assert.equal(quote.title, "Zitat: Der Prozess");
assert.deepEqual(quote.tags, ["Der Prozess", "Klassiker"]);
assert.equal(quote.notebookId, null);
assert.deepEqual(quote.source, {
  app: "readinghub",
  entityType: "book",
  entityId: "book-1",
  label: "Der Prozess",
  route: "#/readinghub/book-1",
});
assert.equal(quote.dedupeKey, "readinghub:annotation:annotation-1");
assert.equal(quote.page, 12, "annotation metadata must survive the shared draft builder");

const freeReadingNoteA = Core.buildReadingNoteDraft(book, { content: "Erste Beobachtung" });
const freeReadingNoteB = Core.buildReadingNoteDraft(book, { content: "Zweite Beobachtung" });
assert.equal(freeReadingNoteA.dedupeKey, undefined);
assert.equal(freeReadingNoteB.dedupeKey, undefined, "multiple contextual notes for one book must not collapse into a singleton");
assert.notEqual(
  Core.buildReadingNoteDraft(book, { content: "A", originId: "a" }).dedupeKey,
  Core.buildReadingNoteDraft(book, { content: "B", originId: "b" }).dedupeKey,
  "only the same explicit origin may be deduplicated",
);
assert.throws(() => Core.buildReadingNoteDraft(null, { content: "Text" }), /Buchkontext fehlt/);
assert.throws(() => Core.buildReadingNoteDraft(book, { content: "  " }), /nicht leer/);

const filterNote = {
  notebookId: null,
  noteClass: "reading",
  tags: ["Der Prozess", "Klassiker"],
  source: { app: "readinghub" },
};
assert.equal(Core.noteMatchesFilter(filterNote, "all"), true);
assert.equal(Core.noteMatchesFilter(filterNote, "recent"), true);
assert.equal(Core.noteMatchesFilter(filterNote, "_inbox"), true);
assert.equal(Core.noteMatchesFilter(filterNote, "class:reading"), true);
assert.equal(Core.noteMatchesFilter(filterNote, "class:research"), false);
assert.equal(Core.noteMatchesFilter(filterNote, "tag:der%20prozess"), true);
assert.equal(Core.noteMatchesFilter(filterNote, "source:readinghub"), true);
assert.equal(Core.noteMatchesFilter(filterNote, "source:newsroom"), false);
assert.equal(Core.noteMatchesFilter({ ...filterNote, notebookId: "nb-1" }, "nb-1"), true);
assert.equal(Core.noteMatchesFilter({ ...filterNote, notebookId: "nb-1" }, "_inbox"), false);

console.log("quantus notes core: ok");
