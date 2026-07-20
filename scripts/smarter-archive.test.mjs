#!/usr/bin/env node
// ============================================================================
// Unit-Test für die Archiv-Helfer smarterArchiveEntries / smarterDocTitle.
//
//   node scripts/smarter-archive.test.mjs
//
// Extrahiert die reinen Funktionen direkt aus public/index.html (bleibt so mit
// dem echten Code synchron) und prüft Sortierung (Datum absteigend), Titel-
// Heuristik, Status-Flags (generationError/done/answered) und Robustheit gegen
// leere/fehlerhafte Dokumente.
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");

function extract(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) throw new Error("Funktion nicht gefunden: " + name);
  let depth = 0, started = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error("Unbalanced: " + name);
}

// In lebende Funktionen verwandeln.
const smarterDocTitle = new Function("return (" + extract("smarterDocTitle") + ")")();
const smarterArchiveEntries = new Function(
  "smarterDocTitle",
  "return (" + extract("smarterArchiveEntries") + ")"
)(smarterDocTitle);

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (detail ? "  → " + detail : "")); }
}

console.log("Smarter Archiv-Helfer — Tests\n");

// Titel-Heuristik
{
  check("title: explizites title gewinnt", smarterDocTitle({ title: "Mein Titel", theoryHtml: "<h2>X</h2>" }) === "Mein Titel");
  check("title: unitTitle als 2. Wahl", smarterDocTitle({ unitTitle: "Unit T" }) === "Unit T");
  check("title: erstes <h2> aus theoryHtml", smarterDocTitle({ theoryHtml: "<p>a</p><h2>Photosynthese</h2><h2>Zweitens</h2>" }) === "Photosynthese");
  check("title: <h2> mit Attributen + inner tags", smarterDocTitle({ theoryHtml: '<h2 class="x">Die <strong>ALV</strong></h2>' }) === "Die ALV");
  check("title: Fallback auf dayKey", smarterDocTitle({}, "2026-07-20") === "Lerndokument 2026-07-20");
  check("title: leeres theoryHtml -> dayKey", smarterDocTitle({ theoryHtml: "" }, "2026-01-01") === "Lerndokument 2026-01-01");
}

// Sortierung + Flags
{
  const docs = {
    "2026-07-18": { theoryHtml: "<h2>Thema A</h2>", questions: [{ id: "q1" }, { id: "q2" }], answers: { q1: { text: "hi" } }, done: false },
    "2026-07-20": { theoryHtml: "<h2>Thema C</h2>", questions: [{ id: "q1" }], answers: { q1: { text: "x" } }, done: true },
    "2026-07-19": { generationError: true, errorMessage: "kaputt", theoryHtml: "<h2>Fallback B</h2>", questions: [] }
  };
  const e = smarterArchiveEntries(docs);
  check("sort: 3 Einträge", e.length === 3, "len=" + e.length);
  check("sort: absteigend nach Datum", e[0].dayKey === "2026-07-20" && e[1].dayKey === "2026-07-19" && e[2].dayKey === "2026-07-18",
    e.map(function(x){return x.dayKey;}).join(","));
  check("flags: done korrekt (2026-07-20)", e[0].done === true);
  check("flags: generationError (2026-07-19)", e[1].generationError === true);
  check("flags: answered zählt nur gefüllte Antworten", e[2].answered === 1 && e[2].questionCount === 2);
  check("title: aus theoryHtml übernommen", e[0].title === "Thema C");
}

// Robustheit
{
  check("robust: undefined -> []", Array.isArray(smarterArchiveEntries(undefined)) && smarterArchiveEntries(undefined).length === 0);
  check("robust: leeres Objekt -> []", smarterArchiveEntries({}).length === 0);
  const bad = { "2026-05-01": null, "2026-05-02": "kaputt", "2026-05-03": { documentHtml: "<b>x</b>" } };
  const e = smarterArchiveEntries(bad);
  check("robust: kaputte Einträge werfen nicht", e.length === 3);
  const may1 = e.find(function(x){ return x.dayKey === "2026-05-01"; });
  check("robust: null-Doc als empty markiert", may1 && may1.empty === true);
  const may3 = e.find(function(x){ return x.dayKey === "2026-05-03"; });
  check("robust: documentHtml zählt als nicht-leer", may3 && may3.empty === false);
  check("robust: kaputtes Doc bekommt Titel", may1 && typeof may1.title === "string" && may1.title.length > 0);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
