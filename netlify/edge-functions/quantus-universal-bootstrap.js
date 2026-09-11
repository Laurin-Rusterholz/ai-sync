const UNIVERSAL_MARKER = "data-quantus-universal";
const UNIVERSAL_ASSETS = [
  '<link rel="stylesheet" href="/quantus-universal.css" data-quantus-universal>',
  '<script src="/quantus-bundle-loader.js" data-quantus-universal></script>',
  '<script src="/quantus-device-sync.js" data-quantus-universal></script>',
  '<script src="/quantus-universal-ui.js" data-quantus-universal></script>'
].join("\n");

export function injectUniversalAssets(html) {
  const source = String(html == null ? "" : html);
  if (!source || source.includes(UNIVERSAL_MARKER) || source.includes("/quantus-device-sync.js")) return source;
  if (/<\/head\s*>/i.test(source)) return source.replace(/<\/head\s*>/i, `${UNIVERSAL_ASSETS}\n</head>`);
  if (/<\/body\s*>/i.test(source)) return source.replace(/<\/body\s*>/i, `${UNIVERSAL_ASSETS}\n</body>`);
  return `${UNIVERSAL_ASSETS}\n${source}`;
}

// Diese Funktion steht im Original-Edge-Log vom 11.09. 22:00:09 an der Spitze:
//   [quantus-universal-bootstrap] TypeError: error reading a body from
//   connection … consumeBody … quantusUniversalBootstrap(…:23:16)
// Zeile 23 war das Lesen des Rumpfes. Der Rumpf der 6,28 MB grossen Hauptapp
// brach mitten im Lesen ab; die Ausnahme flog ungefangen nach oben, Netlify
// meldete „This edge function has crashed" und die ganze App war weg.
// Ein abgerissener Rumpf darf die Seite nicht mitnehmen — und ein Fehler beim
// Umschreiben erst recht nicht.
// Siehe Begruendung in quantus-app-registry.js: ein gefangener Fehler ohne
// Spur ist ein verlorener Beleg. Nur Funktion, Phase, Fehlerart und -text —
// keine Adressen, keine Inhalte, keine Nutz- oder Maildaten.
function edgeLog(phase, err) {
  try {
    console.error(JSON.stringify({
      fn: "quantus-universal-bootstrap",
      phase: phase,
      error: (err && err.name) || "Error",
      message: String((err && err.message) || err || "").slice(0, 300)
    }));
  } catch (_e) { /* Logging darf nie selbst zum Problem werden */ }
}

function bootstrapAusfall(grund) {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><title>Quantus – kurz nicht erreichbar</title>"
      + "<p style=\"font:16px system-ui;margin:3rem auto;max-width:28rem\">Die Seite konnte gerade nicht vollständig geladen werden ("
      + grund + "). <a href=\"\" onclick=\"location.reload();return false\">Nochmals versuchen</a>.</p>",
    { status: 503, headers: { "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate", "retry-after": "1" } }
  );
}

export default async function quantusUniversalBootstrap(request, context) {
  const response = await context.next();
  if (request.method !== "GET" || [204, 205, 304].includes(response.status) || !response.body) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return response;

  let html;
  try {
    html = await response.text();
  } catch (err) {
    edgeLog("body-read", err);
    return bootstrapAusfall("Rumpf abgerissen");
  }
  let transformed;
  try {
    transformed = injectUniversalAssets(html);
  } catch (err) {
    edgeLog("transform", err);
    transformed = html;                          // lieber ohne Zusatz als gar nicht
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  // Der Rumpf wird hier immer neu ausgeliefert und der ETag faellt weg — dann
  // darf auch nie eine zwischengespeicherte Fassung durchgereicht werden,
  // unabhaengig davon, ob diese Funktion etwas eingefuegt hat.
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  if (transformed !== html) {
    headers.set("x-quantus-universal", "device-sync-v2");
  }
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export const config = { path: "/*" };
