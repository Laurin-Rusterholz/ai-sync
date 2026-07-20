# Smarter — Daily: Node „Dokument bauen" (kopierbarer Code)

Dieser Code gehört in den n8n-Code-Node **„Dokument bauen"** des Workflows
**„Smarter — Daily (1 Thema/Tag, HTML)"** (Workflow-ID `SDltMnCLXjvAsrBv`),
Mode **Run Once for All Items**.

Er ist die 1:1-Kopie der kanonischen Logik aus
`n8n/smarter-daily.workflow.json` (Parser getestet in `scripts/parse-model-json.mjs`,
der komplette Node in `scripts/smarter-daily-node.test.mjs`).
Falls du den Workflow neu aus dem Repo importierst, ist der Fix bereits
enthalten — dann ist **kein** manuelles Einfügen nötig. Nur wenn der Node
ausschliesslich in n8n gepflegt wird, ersetze seinen kompletten Inhalt durch
den Block unten.

## Was der Fix ändert

### Runtime-Fix (Abbruchsicherheit)

- **Problem:** Der Node warf `Code doesn't return items properly`
  (`validateRunCodeAllItems` im JsTaskRunnerSandbox), obwohl bei reiner Prosa
  der Fallback greifen sollte. Ursache: (a) `$("Thema auswaehlen").first()`
  stand vor jedem try/catch und konnte den Node killen; (b) der Fallback nutzte
  einen **bedingten Top-Level-`return`** in der Mitte des Codes, den der n8n
  JS Task Runner nicht zuverlässig als Node-Output honoriert.
- **Fix:** Alle Helfer-Funktionen stehen **oben**; die gesamte Ausführung ist in
  ein **Top-Level-`try/catch`** gekapselt; es gibt **genau ein `return output;`**
  am Ende. Jeder unerwartete Fehler (inkl. werfendem `first()`) landet in einem
  Notfall-Fallback, der trotzdem ein valides
  `[{ json: { dateKey, docObject, queueUpdate } }]` liefert.

### Parser-Fix (robustes JSON + Fallback-Dokument)

- **Vorher:** `JSON.parse` mit reinem Fence-Stripping; bei Prosa statt JSON
  warf der Node `Unexpected token … is not valid JSON`.
- **Nachher:** `parseModelJson(text)` extrahiert robust (Fence → sonst erstes
  `{` bis letztes `}`), repariert trailing commas und parst erneut. Schlägt
  alles fehl (oder ist die Antwort leer), wird **NICHT geworfen**, sondern ein
  minimales, schema-konformes **Fallback-Dokument** (`generationError:true`,
  `errorMessage`, Rohtext als escaped `theoryHtml`, leere `questions`/
  `flashcards`, `done:false`) gebaut. → RTDB-Write und Queue-Status-Update
  laufen **immer**.

## Node-Code (komplett einfügen)

```javascript
// Canonical Smarter document-HTML builder + robuster JSON-Parser mit Fallback.
// Läuft im n8n-Code-Node "Dokument bauen" (Mode: Run Once for All Items).
// ABBRUCHSICHER: ALLE Helfer-Funktionen stehen oben, die gesamte Ausführung ist
// in ein Top-Level-try/catch gekapselt und es gibt GENAU EIN "return output;" am
// Ende. Dadurch kann der Node nie "Code doesn't return items properly" werfen —
// selbst wenn $("Thema auswaehlen").first() wirft oder die KI reine Prosa liefert,
// wird immer ein valides [{ json: { dateKey, docObject, queueUpdate } }] geliefert.
// Kanonische, getestete Parser-Logik: scripts/parse-model-json.mjs im Repo.

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function buildDocumentHtml(dateStr, theoryHtml, questions) {
  var qs = Array.isArray(questions) ? questions : [];
  var qCards = qs.map(function (q, i) {
    var qid = (q && q.id) ? q.id : ("q" + (i + 1));
    var text = (q && (q.q || q.question || q.frage)) || "";
    return '' +
      '<section class="q" data-qid="' + esc(qid) + '">' +
        '<div class="q-head"><span class="q-num">' + (i + 1) + '</span>' +
        '<h3 class="q-text">' + esc(text) + '</h3></div>' +
      '</section>';
  }).join("\n");

  return '' +
'<!doctype html>\n<html lang="de"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Smarter — ' + esc(dateStr) + '</title>\n<style>\n' +
'*{box-sizing:border-box}' +
'body{margin:0;background:#EFEAE1;color:#2B3134;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px 20px}' +
'.wrap{max-width:780px;margin:0 auto}' +
'.doc-head{border-bottom:3px solid #D96B5B;padding-bottom:14px;margin-bottom:26px}' +
'.doc-kicker{font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#2F8C80;margin:0 0 4px}' +
'.doc-title{font-size:30px;font-weight:800;margin:0;color:#2B3134;letter-spacing:-.5px}' +
'.doc-date{font-size:14px;color:#6b6357;margin-top:4px}' +
'.section-label{display:inline-block;font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#2F8C80;background:rgba(47,140,128,.12);border:1px solid rgba(47,140,128,.3);padding:3px 10px;border-radius:20px;margin:0 0 12px}' +
'.theory{background:#fff;border:1px solid #C9A96E;border-radius:14px;padding:20px 22px;margin-bottom:30px;box-shadow:0 1px 2px rgba(43,49,52,.06)}' +
'.theory h1,.theory h2,.theory h3{color:#2B3134;line-height:1.3}.theory h2{border-bottom:1px solid #e4dccb;padding-bottom:5px}' +
'.theory a{color:#2F8C80}.theory code{background:#EFEAE1;padding:1px 5px;border-radius:5px;font-size:.9em}' +
'.theory blockquote{border-left:3px solid #C9A96E;margin:12px 0;padding:4px 14px;color:#5a5347;background:rgba(201,169,110,.1)}' +
'.q{background:rgba(255,255,255,.55);border:1px solid #C9A96E;border-left:4px solid #D96B5B;border-radius:12px;padding:16px 18px;margin:0 0 16px}' +
'.q-head{display:flex;gap:12px;align-items:flex-start}' +
'.q-num{flex:none;width:28px;height:28px;border-radius:50%;background:#C9A96E;color:#2B3134;font-weight:800;font-size:14px;display:flex;align-items:center;justify-content:center;margin-top:1px}' +
'.q-text{margin:2px 0 0;font-size:17px;font-weight:700;color:#2B3134;line-height:1.4}' +
'.foot{margin-top:30px;padding-top:14px;border-top:1px solid #d8cfbc;font-size:12px;color:#8a8272;text-align:center}' +
'@media print{body{background:#fff;padding:0}.q{background:transparent;break-inside:avoid}.theory{box-shadow:none}}' +
'\n</style></head>\n<body><div class="wrap">' +
'<header class="doc-head"><p class="doc-kicker">Smarter · Tageslernstoff</p>' +
'<h1 class="doc-title">Lerndokument</h1><div class="doc-date">' + esc(dateStr) + '</div></header>' +
'<span class="section-label">Theorie</span>' +
'<div class="theory">' + (theoryHtml || "<p>Keine Theorie vorhanden.</p>") + '</div>' +
'<span class="section-label">Fragen</span>\n' + qCards +
'<div class="foot">Erstellt von Smarter · Antworten werden in Quantus gespeichert</div>' +
'</div></body></html>';
}

// Sicherer Heute-Key (unabhängig von anderen Nodes) für den Notfall-Fallback.
function safeTodayKey() {
  try { return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}

// ---- Robuster JSON-Parser (kanonisch: scripts/parse-model-json.mjs) ----
function repairJsonCandidate(t) {
  return String(t).replace(/,(\s*[}\]])/g, "$1");
}
function extractJsonCandidate(raw) {
  let t = String(raw == null ? "" : raw).trim();
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] && fence[1].trim()) return fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) return t.slice(first, last + 1).trim();
  return null;
}
function parseModelJson(raw) {
  const candidate = extractJsonCandidate(raw);
  if (candidate == null) return { ok: false, error: "Kein JSON-Kandidat im Text gefunden" };
  try { return { ok: true, value: JSON.parse(candidate) }; }
  catch (e1) {
    try { return { ok: true, value: JSON.parse(repairJsonCandidate(candidate)) }; }
    catch (e2) { return { ok: false, error: (e2 && e2.message) || String(e2) }; }
  }
}

// Baut ein minimales, schema-konformes Fallback-Dokument (generationError:true).
// Wird sowohl bei "Antwort ist keine JSON" als auch im Notfall-catch verwendet.
function buildFallbackDocObject(dateKey, unitTitle, unitIds, rawText, errorMessage) {
  const errMsg = String(errorMessage || "JSON konnte nicht geparst werden");
  const title = unitTitle ? unitTitle : "Tageslernstoff";
  const fbTheory =
    '<h2>' + esc(title) + '</h2>' +
    '<p><strong>Automatische Aufbereitung fehlgeschlagen — Rohtext unten.</strong></p>' +
    '<p>Die KI-Antwort konnte nicht als strukturiertes Dokument gelesen werden (' + esc(errMsg) + '). ' +
    'Der unveraenderte Rohtext des Modells ist zur manuellen Nachbereitung erhalten:</p>' +
    '<pre style="white-space:pre-wrap;word-break:break-word">' + esc(rawText) + '</pre>';
  return {
    unitIds: Array.isArray(unitIds) ? unitIds : [],
    theoryHtml: fbTheory,
    questions: [],
    flashcards: [],
    pdfUrl: "",
    done: false,
    documentHtml: buildDocumentHtml(dateKey, fbTheory, []),
    generationError: true,
    errorMessage: errMsg,
    createdAt: new Date().toISOString(),
    generatedBy: "smarter-daily"
  };
}


// ---- Ausführung: alles gekapselt, genau EIN return am Ende ----------------
let output;
try {
  const meta = ($("Thema auswaehlen").first() || {}).json || {};
  const resp = $json || {};

  // Antwort ROBUST auslesen: content[] kann einen thinking-Block VOR dem text-Block
  // enthalten. Nimm den ERSTEN type==="text"-Block; sonst alle text-Bloecke joinen.
  let text = "";
  try {
    const parts = (resp && Array.isArray(resp.content)) ? resp.content : [];
    const textBlocks = parts.filter(function (b) { return b && b.type === "text" && typeof b.text === "string" && b.text.trim(); });
    if (textBlocks.length) text = textBlocks.map(function (b) { return b.text; }).join("\n").trim();
    if (!text) { // Fallback: irgendein nicht-leeres .text-Feld (thinking/leer ignoriert)
      text = parts.map(function (b) { return (b && typeof b.text === "string") ? b.text : ""; }).filter(function (s) { return s && s.trim(); }).join("\n").trim();
    }
    if (!text && typeof resp === "string") text = resp;                    // Fallback: reiner String
    if (!text && resp && typeof resp.text === "string") text = resp.text;  // Fallback: flaches .text
  } catch (e) {}

  // Leere Antwort NICHT mehr werfen -> Fallback, damit trotzdem geschrieben wird.
  const parseResult = (text && String(text).trim())
    ? parseModelJson(text)
    : { ok: false, error: "Anthropic: leere Antwort" };

  const dateKey = meta.dateKey || safeTodayKey();
  let docObject;
  if (parseResult.ok) {
    const parsed = parseResult.value || {};
    const theoryHtml = String(parsed.theoryHtml || "");
    const rawQ = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = rawQ.map(function(q, i){ return { id: "q" + (i + 1), q: String((q && (q.q || q.question || q.frage)) || ""), a: String((q && (q.a || q.answer || q.antwort)) || "") }; });
    const flashcards = Array.isArray(parsed.flashcards) ? parsed.flashcards.map(function(c){ return { front: String((c && c.front) || ""), back: String((c && c.back) || "") }; }) : [];
    docObject = {
      unitIds: meta.unitIds || [],
      theoryHtml: theoryHtml,
      questions: questions,
      flashcards: flashcards,
      pdfUrl: "",
      done: false,
      documentHtml: buildDocumentHtml(dateKey, theoryHtml, questions),
      createdAt: new Date().toISOString(),
      generatedBy: "smarter-daily"
    };
  } else {
    docObject = buildFallbackDocObject(dateKey, meta.unitTitle, meta.unitIds, text, parseResult.error);
  }
  output = [{ json: { dateKey: dateKey, docObject: docObject, queueUpdate: meta.queueUpdate || {} } }];
} catch (err) {
  // Letzte Absicherung: egal was oben schiefgeht (auch ein werfendes
  // $("Thema auswaehlen").first()), IMMER ein valides Item zurückgeben, damit
  // der Node nie "Code doesn't return items properly" wirft.
  const emsg = (err && err.message) ? err.message : String(err);
  const dk = safeTodayKey();
  output = [{ json: { dateKey: dk, docObject: buildFallbackDocObject(dk, "", [], "", "Unerwarteter Fehler in 'Dokument bauen': " + emsg), queueUpdate: {} } }];
}
return output;
```
