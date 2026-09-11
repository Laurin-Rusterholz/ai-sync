const APP_DEFINITIONS = [
  {
    key: "englishc1",
    icon: "🇬🇧",
    label: "English C1",
    descriptionDe: "C1-Leseverständnis mit 12 Modulen, Aufgaben, Wortschatz, Wiederholung und Lernfortschritt",
    descriptionEn: "C1 reading comprehension with 12 modules, exercises, vocabulary, review and progress",
    path: "/english-c1.html",
    markerId: "quantusEnglishC1HubLink",
    markerGlobal: "__quantusEnglishC1HubLink",
    registrationId: "quantusEnglishC1Registration",
    registrationScript: "/quantus-english-c1-entry.js"
  },
  {
    key: "career",
    icon: "🧭",
    label: "Career Model",
    descriptionDe: "Berufliche Weiterbildung in 30-Minuten-Modulen mit Lernfortschritt und Reflecta",
    descriptionEn: "Professional development in 30-minute modules with progress tracking and Reflecta",
    path: "/career-model.html",
    markerId: "quantusCareerModelHubLink",
    markerGlobal: "__quantusCareerModelHubLink",
    registrationId: "quantusCareerModelRegistration",
    registrationScript: "/quantus-career-model-entry.js"
  }
];

// The Quantus single-file app contains strings that themselves build complete
// HTML documents, including literal </body> tags. A first-match replacement
// therefore corrupts JavaScript by injecting assets inside such a string.
// The document's real closing body tag is the final occurrence in the response.
//
// Das schliessende Tag steht am Dokumentende. Es dafuer im GANZEN Dokument zu
// suchen, hiess bisher: das ganze Dokument kleinschreiben. Auf der 6,28 MB
// grossen Hauptapp kostet allein das 53 ms und 12,4 MB Speicher — und es lief
// bei JEDEM der vier Einfuegevorgaenge. Gesucht wird jetzt zuerst im Schluss;
// nur wenn dort nichts steht, wird wie bisher das ganze Dokument geprueft.
const SCHLUSS_FENSTER = 262144;
function findeLetztesSchlussTag(html, closeTag) {
  const ab = Math.max(0, html.length - SCHLUSS_FENSTER);
  const treffer = html.slice(ab).toLowerCase().lastIndexOf(closeTag);
  if (treffer >= 0) return ab + treffer;
  return html.toLowerCase().lastIndexOf(closeTag);
}
export function insertBeforeFinalClosingTag(source, tagName, insertion) {
  const html = String(source || "");
  const closeTag = `</${String(tagName || "").toLowerCase()}>`;
  const index = findeLetztesSchlussTag(html, closeTag);
  if (index < 0) return `${html}\n${insertion}`;
  return `${html.slice(0, index)}${insertion}\n${html.slice(index)}`;
}

function inlineAppEntry(app) {
  return `{key:${JSON.stringify(app.key)}, icon:${JSON.stringify(app.icon)}, label:${JSON.stringify(app.label)}, desc:getLang()==="de"?${JSON.stringify(app.descriptionDe)}:${JSON.stringify(app.descriptionEn)}},`;
}

function injectNativeRegistry(source) {
  let html = source;
  for (const app of APP_DEFINITIONS) {
    const present = new RegExp(`key\\s*:\\s*["']${app.key}["']`).test(html);
    if (present) continue;
    html = html.replace(
      /(\r?\n[ \t]*)\{[ \t]*key[ \t]*:[ \t]*["']polaris["'][ \t]*,/,
      (match, indent) => `${indent}${inlineAppEntry(app)}${match}`
    );
  }
  return html;
}

// Die eigenständigen Apps liegen auf eigenen Seiten. Ein einfaches
// `location.href = pfad` sperrt Nutzer dort ein: der Zurück-Schritt landet
// wieder auf #/<key>, der Router leitet sofort erneut weiter. Deshalb
// (a) `replace`, damit die Route #/<key> keinen eigenen History-Eintrag behält,
// und (b) ein Session-Marker, den die App beim Verlassen setzt und der hier
// einmalig zum Dashboard zurückführt, statt erneut umzuleiten.
function routerCase(app) {
  return `case ${JSON.stringify(app.key)}: { try { if (sessionStorage.getItem("quantusAppExit") === ${JSON.stringify(app.key)}) { sessionStorage.removeItem("quantusAppExit"); window.location.replace("#/dashboard"); return; } } catch (_e) {} window.location.replace(${JSON.stringify(app.path)}); return; }`;
}

function injectNativeRouter(source) {
  let html = source;
  for (const app of APP_DEFINITIONS) {
    const present = new RegExp(`case\\s+["']${app.key}["']\\s*:`).test(html);
    if (present) continue;
    html = html.replace(
      /(\r?\n[ \t]*)case\s+["']ruhestand["']\s*:/,
      (match, indent) => `${indent}${routerCase(app)}${match}`
    );
  }
  return html;
}

function markerTag(app) {
  return `<script id="${app.markerId}">window.${app.markerGlobal}=true;</script>`;
}

function registrationTag(app) {
  return `<script id="${app.registrationId}" src="${app.registrationScript}" defer></script>`;
}

// Alle fehlenden Tags werden gesammelt und in EINEM Durchgang eingesetzt.
// Vorher schnitt und verband jede einzelne Einfuegung das ganze Dokument neu —
// vier Mal 6,28 MB kopieren, wo einmal genuegt. Die Reihenfolge bleibt
// dieselbe: jede Einfuegung landete vor dem letzten </body>, also
// hintereinander.
function injectRegistrationAssets(source) {
  const html = String(source || "");
  const tags = [];
  for (const app of APP_DEFINITIONS) {
    if (!html.includes(`id="${app.markerId}"`)) tags.push(markerTag(app));
    if (!html.includes(`id="${app.registrationId}"`) && !html.includes(app.registrationScript)) {
      tags.push(registrationTag(app));
    }
  }
  if (!tags.length) return html;
  return insertBeforeFinalClosingTag(html, "body", tags.join("\n"));
}

export function injectQuantusApps(source) {
  let html = String(source || "");
  html = injectNativeRegistry(html);
  html = injectNativeRouter(html);
  html = injectRegistrationAssets(html);
  return html;
}

// Backwards-compatible export used by the existing regression suite.
export function injectEnglishC1(source) {
  return injectQuantusApps(source);
}

// Bau-Kennung aus <meta name="quantus-build"> lesen. Sie wandert als Header
// mit, damit sich der ausgelieferte Stand mit einem HEAD-Request pruefen
// laesst — ohne die mehrere Megabyte grosse Seite herunterzuladen. Genau das
// fehlte, als unklar war, ob ein Fix live schon angekommen ist.
export function readBuildTag(source) {
  const match = /<meta\s+name=["']quantus-build["']\s+content=["']([^"']*)["']/i.exec(String(source || ""));
  return match ? match[1] : "unknown";
}

// Aus dem Original-Edge-Log vom 11.09. 22:00:09:
//   [quantus-universal-bootstrap] TypeError: error reading a body from
//   connection … consumeBody … quantusUniversalBootstrap(…:23:16)
//   … handler(quantus-app-registry.js:124:20)
// Genau an dieser Lesestelle ist die Seite gestorben. Der Rumpf der 6,28 MB
// grossen Hauptapp brach mitten im Lesen ab, die Ausnahme flog ungefangen nach
// oben — Netlify zeigt dann „This edge function has crashed", und die GANZE
// App ist nicht mehr erreichbar. Ein abgerissener Rumpf darf nie wieder die
// Seite mitnehmen:
//   · Bricht das Umschreiben, wird der unveraenderte Rumpf ausgeliefert.
//     Die App laeuft dann vollstaendig, nur die beiden nachgetragenen
//     App-Verweise fehlen.
//   · Bricht das Lesen selbst, ist nichts mehr da, was man ausliefern koennte.
//     Dann eine kurze, NICHT zwischengespeicherte 503 mit Retry-After statt
//     eines Absturzes — ein erneuter Versuch trifft sofort wieder auf die
//     normale Auslieferung.
// Ein gefangener Fehler ohne Spur ist ein verlorener Beleg: ohne Meldung im
// Edge-Log liesse sich nicht mehr sehen, ob Abrisse weiterhin auftreten — die
// Seite bliebe still bedienbar und das Problem unsichtbar. Geloggt wird nur,
// was zur Einordnung noetig ist: Funktion, Phase, Fehlerart und -text. KEINE
// Adressen, keine Inhalte, keine Nutz- oder Maildaten.
function edgeLog(phase, err) {
  try {
    console.error(JSON.stringify({
      fn: "quantus-app-registry",
      phase: phase,
      error: (err && err.name) || "Error",
      message: String((err && err.message) || err || "").slice(0, 300)
    }));
  } catch (_e) { /* Logging darf nie selbst zum Problem werden */ }
}

function edgeAusfall(grund) {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><title>Quantus – kurz nicht erreichbar</title>"
      + "<p style=\"font:16px system-ui;margin:3rem auto;max-width:28rem\">Die Seite konnte gerade nicht vollständig geladen werden ("
      + grund + "). <a href=\"\" onclick=\"location.reload();return false\">Nochmals versuchen</a>.</p>",
    { status: 503, headers: { "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate", "retry-after": "1" } }
  );
}

export default async function handler(request, context) {
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return response;

  let original;
  try {
    original = await response.text();
  } catch (err) {
    edgeLog("body-read", err);
    return edgeAusfall("Rumpf abgerissen");
  }
  let transformed;
  try {
    transformed = injectQuantusApps(original);
  } catch (err) {
    edgeLog("transform", err);
    transformed = original;                      // lieber ohne Verweise als gar nicht
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  // Ohne ETag kann nichts revalidiert werden — deshalb muss hier ausdruecklich
  // stehen, dass weder Browser noch CDN eine alte Fassung weiterreichen duerfen.
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  headers.set("x-quantus-app-registry", "english-c1,career-model");
  headers.set("x-quantus-build", readBuildTag(transformed));
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
