#!/usr/bin/env node
// ============================================================================
// Unit-Tests für parseModelJson / extractJsonCandidate / buildFallbackDoc.
//
//   node scripts/parse-model-json.test.mjs
//
// Deckt die geforderten Fälle ab: reines JSON, json-Fence, Prosa+JSON gemischt,
// reine Prosa (Fallback), trailing-comma-Reparatur. Kein Framework — reine
// Assertions, Exit-Code 1 bei Fehler (gleiche Konvention wie die übrigen
// scripts/*.test.mjs).
// ============================================================================
import {
  parseModelJson,
  extractJsonCandidate,
  buildFallbackDoc,
  escapeHtml
} from "./parse-model-json.mjs";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (detail ? "  → " + detail : "")); }
}
function eq(name, a, b) {
  check(name, JSON.stringify(a) === JSON.stringify(b), "got " + JSON.stringify(a) + " expected " + JSON.stringify(b));
}

console.log("parseModelJson — Tests\n");

// 1) Reines JSON parsed korrekt
{
  const r = parseModelJson('{"theoryHtml":"<p>Hallo</p>","questions":[{"q":"Was?","a":"Das."}]}');
  check("reines JSON: ok", r.ok === true, JSON.stringify(r));
  eq("reines JSON: theoryHtml", r.value && r.value.theoryHtml, "<p>Hallo</p>");
  eq("reines JSON: questions[0].q", r.value && r.value.questions[0].q, "Was?");
}

// 2) json-Codefence parsed korrekt
{
  const txt = "```json\n{\n  \"theoryHtml\": \"<p>X</p>\",\n  \"flashcards\": [{\"front\":\"A\",\"back\":\"B\"}]\n}\n```";
  const r = parseModelJson(txt);
  check("json-Fence: ok", r.ok === true, JSON.stringify(r));
  eq("json-Fence: theoryHtml", r.value && r.value.theoryHtml, "<p>X</p>");
  eq("json-Fence: flashcards[0].front", r.value && r.value.flashcards[0].front, "A");
}

// 2b) Nackter Codefence ohne "json"-Sprachtag
{
  const txt = "```\n{\"theoryHtml\":\"<p>Y</p>\"}\n```";
  const r = parseModelJson(txt);
  check("nackter Fence: ok", r.ok === true, JSON.stringify(r));
  eq("nackter Fence: theoryHtml", r.value && r.value.theoryHtml, "<p>Y</p>");
}

// 3) Prosa + JSON gemischt → JSON extrahiert (Prosa davor/danach ignoriert)
{
  const txt =
    "Gerne! Hier ist das Lerndokument als JSON:\n" +
    '{"theoryHtml":"<p>Mitte</p>","questions":[]}\n' +
    "Ich hoffe, das hilft dir weiter!";
  const r = parseModelJson(txt);
  check("Prosa+JSON: ok", r.ok === true, JSON.stringify(r));
  eq("Prosa+JSON: theoryHtml", r.value && r.value.theoryHtml, "<p>Mitte</p>");
}

// 3b) Verschachtelte Objekte — letztes "}" muss das äußere sein
{
  const txt = 'Text vorher {"a":{"b":{"c":1}},"d":2} Text nachher.';
  const r = parseModelJson(txt);
  check("verschachtelt: ok", r.ok === true, JSON.stringify(r));
  eq("verschachtelt: d", r.value && r.value.d, 2);
  eq("verschachtelt: a.b.c", r.value && r.value.a.b.c, 1);
}

// 4) Reine Prosa ohne JSON → parseModelJson meldet ok:false; Fallback baut valides Doc
{
  const txt = "Entschuldige, ich kann dazu leider kein Dokument erstellen.";
  const r = parseModelJson(txt);
  check("reine Prosa: ok:false", r.ok === false, JSON.stringify(r));

  const doc = buildFallbackDoc({
    dateKey: "2026-07-20",
    unitTitle: "Photosynthese",
    unitIds: ["u1"],
    rawText: txt,
    errorMessage: r.error
  });
  check("Fallback: generationError true", doc.generationError === true);
  eq("Fallback: questions leer", doc.questions, []);
  eq("Fallback: flashcards leer", doc.flashcards, []);
  eq("Fallback: pdfUrl leer", doc.pdfUrl, "");
  check("Fallback: done false", doc.done === false);
  eq("Fallback: unitIds erhalten", doc.unitIds, ["u1"]);
  check("Fallback: errorMessage gesetzt", typeof doc.errorMessage === "string" && doc.errorMessage.length > 0);
  check("Fallback: Titel im theoryHtml", doc.theoryHtml.indexOf("Photosynthese") >= 0);
  check("Fallback: Hinweis im theoryHtml", doc.theoryHtml.indexOf("Automatische Aufbereitung fehlgeschlagen") >= 0);
  check("Fallback: Rohtext im theoryHtml", doc.theoryHtml.indexOf("kein Dokument erstellen") >= 0);
  // Schema-Vollständigkeit: alle Pflichtfelder vorhanden
  ["unitIds", "theoryHtml", "questions", "flashcards", "pdfUrl", "done", "documentHtml"].forEach(function (k) {
    check("Fallback: Feld '" + k + "' vorhanden", Object.prototype.hasOwnProperty.call(doc, k));
  });
}

// 4b) Rohtext mit HTML/Script wird escaped (kein XSS im Fallback-Dokument)
{
  const doc = buildFallbackDoc({ rawText: '<script>alert(1)</script>', errorMessage: "x" });
  check("Fallback: Rohtext escaped", doc.theoryHtml.indexOf("<script>alert(1)") < 0);
  check("Fallback: Rohtext escaped (&lt;script&gt;)", doc.theoryHtml.indexOf("&lt;script&gt;") >= 0);
}

// 5) JSON mit trailing comma wird repariert
{
  const txt = '{"theoryHtml":"<p>T</p>","questions":[{"q":"A","a":"B"},],}';
  const r = parseModelJson(txt);
  check("trailing comma: ok", r.ok === true, JSON.stringify(r));
  eq("trailing comma: theoryHtml", r.value && r.value.theoryHtml, "<p>T</p>");
  eq("trailing comma: questions len", r.value && r.value.questions.length, 1);
}

// 5b) trailing comma innerhalb Codefence + umgebender Prosa
{
  const txt = "Hier:\n```json\n{\"a\":[1,2,3,],}\n```\nFertig.";
  const r = parseModelJson(txt);
  check("Fence+trailing comma: ok", r.ok === true, JSON.stringify(r));
  eq("Fence+trailing comma: a", r.value && r.value.a, [1, 2, 3]);
}

// 6) extractJsonCandidate Randfälle
{
  eq("extract: leerer String → null", extractJsonCandidate(""), null);
  eq("extract: null → null", extractJsonCandidate(null), null);
  eq("extract: reine Prosa → null", extractJsonCandidate("nur text hier"), null);
}

// 7) escapeHtml Basics
{
  eq("escapeHtml: &<>", escapeHtml('a & b < c > d'), "a &amp; b &lt; c &gt; d");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
