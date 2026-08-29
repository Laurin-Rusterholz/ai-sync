import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

// DOM security contract for synchronized note HTML. The implementation builds
// an inert template and copies only allowlisted nodes/attributes into a second
// tree, so fixture payloads such as <img onerror> and javascript: links never
// reach a live innerHTML sink.
assert.match(index, /function sanitizeNoteHtml\(html, inlineOnly\)/);
assert.match(index, /document\.createElement\("template"\)/);
assert.match(index, /NF2_DROP_TAGS = new Set\(\[[^\]]*"IFRAME"[^\]]*"IMG"[^\]]*"SCRIPT"[^\]]*"SVG"/s);
assert.match(index, /QuantusNotesCore\?\.isSafeNoteHref\(href\)/);
assert.match(index, /clean\.setAttribute\("rel", "noopener noreferrer"\)/);
assert.match(index, /clean\.setAttribute\("target", "_blank"\)/);
assert.match(index, /tmp\.innerHTML = sanitizeNoteHtml\(n\.content \|\| ""\)/,
  "preview/search must parse only sanitized note HTML");
assert.match(index, /tmp\.innerHTML = sanitizeNoteHtml\(html \|\| ""\)/,
  "block parser must parse only sanitized note HTML");
assert.match(index, /sanitizeNoteInlineHtml\(bc\.innerHTML\.replace/,
  "serialized editor blocks must be sanitized again before storage");
assert.doesNotMatch(index, /const nfStrip = html => \{ const d = document\.createElement\("div"\); d\.innerHTML = html/,
  "legacy NoteFlow previews must not parse synced HTML in a normal div");

// Idea deletion is one aggregate: shadow + canonical note + both tombstones,
// with one undo record. Otherwise migration recreates a supposedly deleted idea.
assert.match(index, /if \(kind === "idea"\) \{[\s\S]*noteBackups[\s\S]*logDeletion\("idea", id\)[\s\S]*logDeletion\("note", note\.id\)[\s\S]*action:"deleteIdeaBundle"/);
assert.match(index, /item\.action === "deleteIdeaBundle"[\s\S]*clearDeletion\("idea", item\.id\)[\s\S]*clearDeletion\("note", note\.id\)/);
assert.match(index, /Apply current tombstones before projecting either representation/);
assert.match(index, /quantusIsDeletedEntity\(note\)[\s\S]*markDeleted\(idea, note\)/,
  "an idea-note tombstone must suppress its board projection");
assert.match(index, /quantusIsDeletedEntity\(idea\)[\s\S]*markDeleted\(note, idea\)/,
  "a board tombstone must suppress its canonical note");
assert.match(index, /var safeBody=htmlToPlainText\(String\(note\.content\|\|""\)\)/,
  "text and Markdown downloads must export sanitized plain note content");

// Learning Mode may retain an explicitly linked notebook, but must never
// create one. Its captures are canonical learning notes and default to Inbox.
const ensureStart = index.indexOf("function _kvEnsureLearningNotebook(project)");
const ensureEnd = index.indexOf("function _kvLearningEsc", ensureStart);
const ensureBody = index.slice(ensureStart, ensureEnd);
assert.ok(ensureStart > 0 && ensureEnd > ensureStart);
assert.doesNotMatch(ensureBody, /createEntity\s*\(\s*["']notebook|entities\.notebooks\s*\[/);
assert.match(index, /function _kvLearningCreateKeywordNote[\s\S]*createQuantusNote\(\{[\s\S]*noteClass: "learning"/);
assert.match(index, /if \(action === "note-create"\)[\s\S]{0,300}notebookId:null/,
  "workspace note composer must default to Inbox, not the first notebook");

// New Newsroom writes use the cross-device app id. The old id appears only in
// compatibility normalization/tests, never in a desktop source object.
assert.doesNotMatch(index, /source:\s*\{\s*app:\s*["']newsroom["']/);
assert.match(index, /source:\s*\{\s*app:\s*["']articles["']/);

console.log("quantus notes DOM security and lifecycle: ok");
