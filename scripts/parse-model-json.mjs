// ============================================================================
// parseModelJson — robuste Extraktion von JSON aus einer Modell-Antwort.
// ============================================================================
// Kanonische, getestete Quelle für die Smarter-Tagesdokument-Generierung.
// Dieselbe Logik ist in den n8n-Code-Node "Dokument bauen" eingebettet
// (siehe docs/smarter-daily-dokument-bauen.node.md). n8n-Code-Nodes müssen
// selbstständig laufen (kein import), daher ist der Node-Code eine 1:1-Kopie
// dieser Funktion — Änderungen hier UND dort nachziehen.
//
// Ziel: Liefert das Modell reines JSON, json-Fence oder Prosa+JSON gemischt,
// wird der JSON-Kandidat robust extrahiert und geparst. Ist der Text gar kein
// JSON, wird NICHT geworfen — der Aufrufer erhält ein Fallback-Signal und baut
// ein minimales, schema-konformes Dokument (generationError:true), sodass der
// RTDB-Write und das Queue-Status-Update trotzdem laufen.
//
//   node scripts/parse-model-json.test.mjs   # Unit-Tests
// ============================================================================

// HTML-Escaping (für Rohtext im Fallback-theoryHtml). Bewusst identisch zur
// esc()-Funktion im n8n-Node, damit Repo und Node gleich escapen.
export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Entfernt trailing commas vor } oder ] — häufigster reparierbarer JSON-Fehler
// von LLM-Ausgaben. Konservativ: nur Kommas, die direkt (evtl. mit Whitespace)
// vor einer schließenden Klammer stehen.
function repairJsonCandidate(t) {
  return String(t).replace(/,(\s*[}\]])/g, "$1");
}

// Extrahiert den JSON-Kandidaten aus einem Modelltext:
//   1. ```json … ``` oder ``` … ```-Codefence-Inhalt, falls vorhanden;
//   2. sonst vom ERSTEN "{" bis zum LETZTEN "}" (Prosa davor/danach ignoriert).
// Gibt null zurück, wenn kein Kandidat gefunden wird.
export function extractJsonCandidate(text) {
  let t = String(text == null ? "" : text).trim();
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] && fence[1].trim()) return fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) return t.slice(first, last + 1).trim();
  return null;
}

// Kernfunktion. Rückgabe: { ok:true, value } bei Erfolg,
// { ok:false, error } wenn kein valides JSON gewonnen werden konnte.
// Wirft NIE — der Aufrufer entscheidet über das Fallback.
export function parseModelJson(text) {
  const candidate = extractJsonCandidate(text);
  if (candidate == null) {
    return { ok: false, error: "Kein JSON-Kandidat im Text gefunden" };
  }
  // 1. Direkter Parse
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (e1) {
    // 2. Leichte Reparatur (trailing commas) + erneuter Parse
    try {
      return { ok: true, value: JSON.parse(repairJsonCandidate(candidate)) };
    } catch (e2) {
      return { ok: false, error: (e2 && e2.message) || String(e2) };
    }
  }
}

// Baut ein minimales, schema-konformes Fallback-Dokument, wenn die Modell-
// Antwort nicht als JSON gewonnen werden konnte. Erfüllt dasselbe Schema wie
// das reguläre Dokument (unitIds, theoryHtml, questions, flashcards, pdfUrl,
// done, documentHtml) plus generationError/errorMessage, sodass der Lauf NIE
// abbricht und die App das Dokument (inkl. Rohtext) anzeigen kann.
export function buildFallbackDoc(opts) {
  opts = opts || {};
  const dateKey = opts.dateKey || "";
  const unitTitle = opts.unitTitle || "";
  const unitIds = Array.isArray(opts.unitIds) ? opts.unitIds : [];
  const rawText = String(opts.rawText == null ? "" : opts.rawText);
  const errorMessage = String(opts.errorMessage || "JSON konnte nicht geparst werden");
  const nowIso = opts.nowIso || "";

  const title = unitTitle ? unitTitle : "Tageslernstoff";
  const theoryHtml =
    '<h2>' + escapeHtml(title) + '</h2>' +
    '<p><strong>Automatische Aufbereitung fehlgeschlagen — Rohtext unten.</strong></p>' +
    '<p>Die KI-Antwort konnte nicht als strukturiertes Dokument gelesen werden ' +
    '(' + escapeHtml(errorMessage) + '). Der unveränderte Rohtext des Modells ist zur ' +
    'manuellen Nachbereitung erhalten:</p>' +
    '<pre style="white-space:pre-wrap;word-break:break-word">' + escapeHtml(rawText) + '</pre>';

  return {
    unitIds: unitIds,
    theoryHtml: theoryHtml,
    questions: [],
    flashcards: [],
    pdfUrl: "",
    done: false,
    documentHtml: "",
    generationError: true,
    errorMessage: errorMessage,
    createdAt: nowIso,
    generatedBy: "smarter-daily"
  };
}
