# Smarter — Daily: Node „Dokument bauen" (kopierbarer Code)

Dieser Code gehört in den n8n-Code-Node **„Dokument bauen"** des Workflows
**„Smarter — Daily (1 Thema/Tag, HTML)"** (Workflow-ID `SDltMnCLXjvAsrBv`).

Er ist die 1:1-Kopie der kanonischen, getesteten Logik aus
`n8n/smarter-daily.workflow.json` bzw. `scripts/parse-model-json.mjs`.
Falls du den Workflow neu aus dem Repo importierst, ist der Fix bereits
enthalten — dann ist **kein** manuelles Einfügen nötig. Nur wenn der Node
ausschliesslich in n8n gepflegt wird, ersetze seinen kompletten Inhalt durch
den Block unten.

## Was der Fix ändert

- **Vorher:** `JSON.parse` mit reinem Fence-Stripping; bei Prosa statt JSON
  warf der Node `Unexpected token … is not valid JSON` → **ganzer Lauf brach
  ab, kein Dokument geschrieben**.
- **Nachher:** `parseModelJson(text)` extrahiert robust (Fence → sonst erstes
  `{` bis letztes `}`), repariert trailing commas und parst erneut. Schlägt
  alles fehl, wird **NICHT geworfen**, sondern ein minimales, schema-konformes
  **Fallback-Dokument** (`generationError:true`, `errorMessage`, Rohtext als
  escaped `theoryHtml`, leere `questions`/`flashcards`, `done:false`) gebaut.
  → RTDB-Write und Queue-Status-Update laufen **immer**.

## Node-Code (komplett einfügen)

```javascript
// Canonical Smarter document-HTML builder.
// This exact logic goes into the n8n "Finalize / Build HTML" Code node.
// Self-contained (inline CSS, no external requests), print-friendly,
// Quantus-Design Schiefer/Leinen. Each question card carries data-qid="qN"
// so the Quantus app can dock an answer field under it.
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



// ---- Anthropic-Antwort verarbeiten + Tagesdokument zusammenbauen ----
const meta = ($("Thema auswaehlen").first() || {}).json || {};
const resp = $json || {};
// Antwort ROBUST auslesen: content[] kann einen thinking-Block VOR dem text-Block
// enthalten (content=[{type:"thinking",...},{type:"text",text:"..."}]). Nimm den
// ERSTEN type==="text"-Block; sonst alle text-Bloecke joinen; thinking/leer ignorieren.
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
if (!text || !String(text).trim()) throw new Error("Anthropic: leere Antwort");
// ---- Robuster JSON-Parser + Fallback ------------------------------------
// Kanonische, getestete Quelle: scripts/parse-model-json.mjs im Repo
// (Laurin-Rusterholz/ai-sync). Diese Node-Kopie 1:1 synchron halten.
// Ziel: reines JSON, ```json-Fence ODER Prosa+JSON gemischt robust einlesen;
// bei Nicht-JSON NICHT werfen, sondern ein Fallback-Dokument bauen, damit der
// RTDB-Write und das Queue-Update trotzdem laufen.
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

const parseResult = parseModelJson(text);

// Fallback: KI-Antwort nicht als JSON gewinnbar -> Lauf NICHT abbrechen. Minimales,
// schema-konformes Dokument mit Rohtext + generationError erzeugen, damit die App
// etwas anzeigt und der Nutzer manuell nachbereiten kann.
if (!parseResult.ok) {
  const errMsg = parseResult.error || "JSON konnte nicht geparst werden";
  const fbTitle = meta.unitTitle ? meta.unitTitle : "Tageslernstoff";
  const fbTheory =
    '<h2>' + esc(fbTitle) + '</h2>' +
    '<p><strong>Automatische Aufbereitung fehlgeschlagen — Rohtext unten.</strong></p>' +
    '<p>Die KI-Antwort konnte nicht als strukturiertes Dokument gelesen werden (' + esc(errMsg) + '). ' +
    'Der unveraenderte Rohtext des Modells ist zur manuellen Nachbereitung erhalten:</p>' +
    '<pre style="white-space:pre-wrap;word-break:break-word">' + esc(text) + '</pre>';
  const fbDoc = {
    unitIds: meta.unitIds || [],
    theoryHtml: fbTheory,
    questions: [],
    flashcards: [],
    pdfUrl: "",
    done: false,
    documentHtml: buildDocumentHtml(meta.dateKey, fbTheory, []),
    generationError: true,
    errorMessage: errMsg,
    createdAt: new Date().toISOString(),
    generatedBy: "smarter-daily"
  };
  return [{ json: { dateKey: meta.dateKey, docObject: fbDoc, queueUpdate: meta.queueUpdate || {} } }];
}

const parsed = parseResult.value || {};
const theoryHtml = String(parsed.theoryHtml || "");
const rawQ = Array.isArray(parsed.questions) ? parsed.questions : [];
const questions = rawQ.map(function(q, i){ return { id: "q" + (i + 1), q: String((q && (q.q || q.question || q.frage)) || ""), a: String((q && (q.a || q.answer || q.antwort)) || "") }; });
const flashcards = Array.isArray(parsed.flashcards) ? parsed.flashcards.map(function(c){ return { front: String((c && c.front) || ""), back: String((c && c.back) || "") }; }) : [];

const documentHtml = buildDocumentHtml(meta.dateKey, theoryHtml, questions);
const docObject = {
  unitIds: meta.unitIds || [],
  theoryHtml: theoryHtml,
  questions: questions,
  flashcards: flashcards,
  pdfUrl: "",
  done: false,
  documentHtml: documentHtml,
  createdAt: new Date().toISOString(),
  generatedBy: "smarter-daily"
};
return [{ json: { dateKey: meta.dateKey, docObject: docObject, queueUpdate: meta.queueUpdate || {} } }];```
