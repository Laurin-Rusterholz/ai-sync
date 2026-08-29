/*
 * Quantus Notes Core
 *
 * Pure, dependency-free domain helpers shared by the monolithic desktop UI and
 * its tests. The browser exposes them as window.QuantusNotesCore. Keeping the
 * rules here prevents ReadingHub, Newsroom, Ideas and NoteFlow from silently
 * inventing incompatible note objects.
 */
(function (root) {
  "use strict";

  const NOTE_CLASSES = Object.freeze({
    reading: "Lesenotiz",
    learning: "Lernnotiz",
    idea: "Idee",
    general: "Generelle Notiz",
    short: "Kurze Notiz",
    research: "Recherchenotiz",
  });

  const BOOK_STATUSES = Object.freeze({
    registered: "Registriert/ungelesen",
    reading: "Lese ich",
    paused: "Pausiert",
    completed: "Gelesen",
    abandoned: "Abgebrochen",
  });

  function asText(value) {
    return value == null ? "" : String(value);
  }

  function normalizeTags(input, preferredSpellings) {
    const source = Array.isArray(input) ? input : asText(input).split(",");
    const preferred = new Map();
    (preferredSpellings || []).forEach((tag) => {
      const clean = asText(tag).trim();
      if (clean && !preferred.has(clean.toLocaleLowerCase("de-CH"))) {
        preferred.set(clean.toLocaleLowerCase("de-CH"), clean);
      }
    });
    const seen = new Set();
    const result = [];
    source.forEach((tag) => {
      const clean = asText(tag).trim();
      if (!clean) return;
      const key = clean.toLocaleLowerCase("de-CH");
      if (seen.has(key)) return;
      seen.add(key);
      result.push(preferred.get(key) || clean);
    });
    return result;
  }

  function reconcileIdeaTags(input, category, options) {
    options = options && typeof options === "object" ? options : {};
    const preferred = options.preferredSpellings;
    const removedKey = asText(options.removedTag).trim().toLocaleLowerCase("de-CH");
    let tags = normalizeTags(input, preferred);
    let canonicalCategory = asText(category).trim() || tags[0] || asText(options.fallbackCategory).trim() || "Unkategorisiert";
    const categoryKey = canonicalCategory.toLocaleLowerCase("de-CH");

    // The category is the first mandatory tag. If a user explicitly removes
    // it, the next tag is promoted; a category-less idea is never persisted.
    if (removedKey && categoryKey === removedKey) {
      tags = tags.filter((tag) => tag.toLocaleLowerCase("de-CH") !== removedKey);
      canonicalCategory = tags[0] || asText(options.fallbackCategory).trim() || "Unkategorisiert";
    }
    const nextCategoryKey = canonicalCategory.toLocaleLowerCase("de-CH");
    tags = normalizeTags([
      canonicalCategory,
      ...tags.filter((tag) => tag.toLocaleLowerCase("de-CH") !== nextCategoryKey),
    ], preferred);
    return { category: tags[0], tags };
  }

  function normalizeEntityMap(input, prefix) {
    if (!Array.isArray(input)) return input && typeof input === "object" ? input : {};
    const out = {};
    Object.keys(input).forEach((key) => {
      const value = input[key];
      const objectValue = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
      const rawKey = String(key);
      const keyPart = /^(0|[1-9]\d*)$/.test(rawKey)
        ? rawKey
        : (rawKey.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "key");
      const fallback = `legacy_${prefix || "entity"}_${keyPart}`;
      const base = asText(objectValue.id).trim() || fallback;
      let id = base, suffix = 2;
      while (Object.prototype.hasOwnProperty.call(out, id)) id = `${base}_${suffix++}`;
      Object.defineProperty(out, id, {
        value: { ...objectValue, id }, enumerable: true, writable: true, configurable: true,
      });
    });
    return out;
  }

  function inferLegacySource(note) {
    note = note && typeof note === "object" ? note : {};
    const bookId = note.readingHubBookId || note.bookId || null;
    if (bookId) return { app:"readinghub", entityType:"book", entityId:asText(bookId), label:note.bookTitle || note.sourceLabel || note.title || "Reading Hub", route:"#/readinghub/" + asText(bookId) };
    if (note.ideaId) return { app:"ideas", entityType:"idea", entityId:asText(note.ideaId), label:note.sourceLabel || note.title || "Idee", route:"#/ideas/" + asText(note.ideaId) };
    const rawSource = typeof note.source === "string" ? note.source : note.source?.app;
    const haystack = [rawSource, note.learningKind, note.researchKind, ...(Array.isArray(note.tags) ? note.tags : [])].map(asText).join(" ").toLocaleLowerCase("de-CH");
    if (/smarter/.test(haystack)) return { app:"smarter", entityType:"learning", entityId:null, label:note.sourceLabel || "Smarter", route:"#/smarter" };
    if (/bmpruefung|bm-vorbereitung|bm vorbereitung|(^|\s)bm($|\s)/.test(haystack)) return { app:"bmpruefung", entityType:"learning", entityId:null, label:note.sourceLabel || "BM Vorbereitung", route:"/bm.html" };
    if (/recall/.test(haystack)) return { app:"recalllab", entityType:"learning", entityId:null, label:note.sourceLabel || "RecallLab", route:"#/recalllab" };
    if (/newsroom|articles?|research|recherche|browser|pdf|thesis/.test(haystack)) return { app:"articles", entityType:note.articleId ? "article" : "research", entityId:note.articleId ? asText(note.articleId) : null, label:note.sourceLabel || note.title || "Articles", route:"#/articles" };
    if (/quick|short|schnell/.test(haystack)) return { app:"shortnote", entityType:"shortnote", entityId:null, label:note.sourceLabel || "Shortnote", route:"#/dashboard" };
    return { app:"noteflow", entityType:"note", entityId:note.id ? asText(note.id) : null, label:note.sourceLabel || "NoteFlow", route:note.id ? "#/notes/" + asText(note.id) : "#/notes" };
  }

  function normalizeSource(source, fallback) {
    fallback = fallback && typeof fallback === "object" ? fallback : {};
    const canonicalApp = (value) => {
      const app = asText(value).trim() || "noteflow";
      const alias = app.toLocaleLowerCase("de-CH");
      if (["newsroom", "article", "articles-hub"].includes(alias)) return "articles";
      if (["reading-hub", "reading", "books"].includes(alias)) return "readinghub";
      if (["bm", "bm-vorbereitung", "bm preparation"].includes(alias)) return "bmpruefung";
      return app;
    };
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const rawApp = canonicalApp(source.app || fallback.app || "noteflow");
      return {
        // `newsroom` was emitted by older desktop versions. `articles` is the
        // shared cross-device identifier; accepting the alias here makes the
        // migration idempotent without perpetuating it in new writes.
        app: rawApp,
        entityType: asText(source.entityType || fallback.entityType || "note").trim() || "note",
        entityId: source.entityId == null || source.entityId === "" ? (fallback.entityId ?? null) : asText(source.entityId),
        label: asText(source.label || fallback.label || "NoteFlow").trim() || "NoteFlow",
        route: source.route == null || source.route === "" ? (fallback.route ?? null) : asText(source.route),
      };
    }
    const legacy = asText(source).trim();
    const lower = legacy.toLocaleLowerCase("de-CH");
    let app = canonicalApp(fallback.app || "noteflow");
    if (/reading|book|buch/.test(lower)) app = "readinghub";
    else if (/news|article|research|recherche|browser|pdf|thesis/.test(lower)) app = "articles";
    else if (/idea|idee/.test(lower)) app = "ideas";
    else if (/smarter|bm|recall|lern/.test(lower)) app = lower.includes("bm") ? "bmpruefung" : (lower.includes("smarter") ? "smarter" : "recalllab");
    else if (/quick|short|schnell/.test(lower)) app = "shortnote";
    return {
      app,
      entityType: fallback.entityType || "note",
      entityId: fallback.entityId ?? null,
      label: fallback.label || legacy || (app === "noteflow" ? "NoteFlow" : app),
      route: fallback.route ?? null,
    };
  }

  function isSafeNoteHref(value) {
    const href = asText(value).trim();
    if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return false;
    if (/^(?:https?:|mailto:)/i.test(href)) return true;
    // Fragment/query and same-origin relative links are allowed. Protocol
    // relative URLs, backslashes and any explicit non-allowlisted scheme are
    // rejected so browser URL normalisation cannot turn them executable.
    if (/^(?:#|\?)/.test(href)) return true;
    if (/^\/(?!\/)/.test(href) || /^\.\.?\//.test(href)) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^(?:\\|\/\/)/.test(href)) return false;
    return true;
  }

  function inferLegacyClass(note) {
    if (note && NOTE_CLASSES[note.noteClass]) return note.noteClass;
    const rawSource = typeof note?.source === "string" ? note.source : note?.source?.app;
    const haystack = [
      rawSource,
      note?.readingHubBookId,
      note?.bookId,
      note?.ideaId,
      note?.learningKind,
      note?.researchKind,
      ...(Array.isArray(note?.tags) ? note.tags : []),
    ].map(asText).join(" ").toLocaleLowerCase("de-CH");
    if (note?.readingHubBookId || note?.bookId || /reading|book|buch|lesenotiz/.test(haystack)) return "reading";
    if (note?.ideaId || /(^|\s)(idea|idee)(\s|$)/.test(haystack)) return "idea";
    if (/smarter|bmpruefung|bm[-\s]vorbereitung|recall|lernnotiz|leseplan/.test(haystack)) return "learning";
    if (/newsroom|research|recherche|article|artikel|browser|pdf|thesis/.test(haystack)) return "research";
    if (/quick-modal|quick-note|shortnote|schnellnotiz/.test(haystack)) return "short";
    return "general";
  }

  function normalizeBookStatus(status) {
    const value = asText(status).trim().toLocaleLowerCase("de-CH");
    if (["reading", "lese ich", "am lesen", "lesend"].includes(value)) return "reading";
    if (["paused", "pause", "pausiert"].includes(value)) return "paused";
    if (["completed", "read", "done", "gelesen", "fertig"].includes(value)) return "completed";
    if (["abandoned", "dropped", "abgebrochen"].includes(value)) return "abandoned";
    return "registered";
  }

  function createTitleOnlyBook(input, idFactory, nowFactory) {
    const title = asText(input?.title).trim();
    if (!title) throw new Error("Der Buchtitel ist erforderlich.");
    const now = (nowFactory || (() => new Date().toISOString()))();
    const text = asText(input?.fullText || input?.text).trim();
    const pages = Array.isArray(input?.pages) ? input.pages.slice() : [];
    return {
      id: asText(input?.id).trim() || (idFactory || (() => "book-" + Date.now()))(),
      title,
      author: asText(input?.author).trim(),
      isbn: asText(input?.isbn).trim(),
      coverUrl: asText(input?.coverUrl).trim(),
      targetDate: input?.targetDate || null,
      fileName: input?.fileName || null,
      pages,
      fullText: text,
      totalPages: Number.isFinite(Number(input?.totalPages)) ? Number(input.totalPages) : pages.length,
      currentPage: Math.max(0, Number(input?.currentPage) || 0),
      status: normalizeBookStatus(input?.status),
      progress: Math.max(0, Math.min(100, Number(input?.progress) || 0)),
      isManual: input?.isManual !== false,
      hasPdfFile: !!input?.hasPdfFile,
      createdAt: input?.createdAt || now,
      updatedAt: now,
    };
  }

  function normalizeNoteDraft(input, context) {
    context = context && typeof context === "object" ? context : {};
    const noteClass = NOTE_CLASSES[input?.noteClass] ? input.noteClass : inferLegacyClass(input || {});
    const source = normalizeSource(input?.source, { ...inferLegacySource(input), ...(context.source || {}) });
    const tags = normalizeTags(input?.tags, context.preferredTags);
    const now = context.now || new Date().toISOString();
    return {
      ...(input || {}),
      title: asText(input?.title).trim(),
      content: asText(input?.content),
      noteClass,
      tags,
      notebookId: input?.notebookId || null,
      source,
      createdAt: input?.createdAt || now,
      updatedAt: input?.updatedAt || now,
    };
  }

  function buildReadingNoteDraft(book, input) {
    if (!book || !book.id || !asText(book.title).trim()) throw new Error("Buchkontext fehlt.");
    input = input || {};
    const readingKind = ["note", "quote", "summary", "insight"].includes(input.readingKind) ? input.readingKind : "note";
    const content = asText(input.content || input.selectedText).trim();
    if (!content) throw new Error("Die Lesenotiz darf nicht leer sein.");
    return normalizeNoteDraft({
      ...input,
      title: asText(input.title).trim() || ({ quote: "Zitat", summary: "Zusammenfassung", insight: "Erkenntnis", note: "Lesenotiz" })[readingKind] + ": " + book.title,
      content,
      noteClass: "reading",
      readingKind,
      tags: [book.title, ...(Array.isArray(input.tags) ? input.tags : asText(input.tags).split(","))],
      notebookId: input.notebookId || null,
      source: {
        app: "readinghub",
        entityType: "book",
        entityId: book.id,
        label: book.title,
        route: "#/readinghub/" + book.id,
      },
      dedupeKey: input.dedupeKey || (input.originId ? "readinghub:annotation:" + input.originId : undefined),
    });
  }

  function noteMatchesFilter(note, filter) {
    filter = filter || "all";
    if (filter === "all" || filter === "recent") return true;
    if (filter === "_inbox") return !note?.notebookId;
    if (filter.startsWith("class:")) return note?.noteClass === filter.slice(6);
    if (filter.startsWith("tag:")) {
      const wanted = decodeURIComponent(filter.slice(4)).toLocaleLowerCase("de-CH");
      return (note?.tags || []).some((tag) => asText(tag).toLocaleLowerCase("de-CH") === wanted);
    }
    if (filter.startsWith("source:")) return note?.source?.app === filter.slice(7);
    return note?.notebookId === filter;
  }

  function tagSuggestions(notes, query, exclude) {
    const q = asText(query).trim().toLocaleLowerCase("de-CH");
    const blocked = new Set(normalizeTags(exclude).map((tag) => tag.toLocaleLowerCase("de-CH")));
    const all = [];
    (notes || []).forEach((note) => (note?.tags || []).forEach((tag) => all.push(tag)));
    return normalizeTags(all)
      .filter((tag) => !blocked.has(tag.toLocaleLowerCase("de-CH")))
      .filter((tag) => !q || tag.toLocaleLowerCase("de-CH").includes(q))
      .sort((a, b) => a.localeCompare(b, "de-CH"));
  }

  root.QuantusNotesCore = Object.freeze({
    NOTE_CLASSES,
    BOOK_STATUSES,
    normalizeTags,
    reconcileIdeaTags,
    normalizeEntityMap,
    normalizeSource,
    inferLegacySource,
    isSafeNoteHref,
    inferLegacyClass,
    normalizeBookStatus,
    normalizeNoteDraft,
    createTitleOnlyBook,
    buildReadingNoteDraft,
    noteMatchesFilter,
    tagSuggestions,
  });
})(typeof window !== "undefined" ? window : globalThis);
