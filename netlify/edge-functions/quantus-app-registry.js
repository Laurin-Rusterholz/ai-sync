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
export function insertBeforeFinalClosingTag(source, tagName, insertion) {
  const html = String(source || "");
  const closeTag = `</${String(tagName || "").toLowerCase()}>`;
  const index = html.toLowerCase().lastIndexOf(closeTag);
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

function injectRegistrationAssets(source) {
  let html = source;
  for (const app of APP_DEFINITIONS) {
    if (!html.includes(`id="${app.markerId}"`)) {
      html = insertBeforeFinalClosingTag(html, "body", markerTag(app));
    }
    if (!html.includes(`id="${app.registrationId}"`) && !html.includes(app.registrationScript)) {
      html = insertBeforeFinalClosingTag(html, "body", registrationTag(app));
    }
  }
  return html;
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

export default async function handler(request, context) {
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return response;

  const original = await response.text();
  const transformed = injectQuantusApps(original);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.set("cache-control", "no-cache, must-revalidate");
  headers.set("x-quantus-app-registry", "english-c1,career-model");
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
