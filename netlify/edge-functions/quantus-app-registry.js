const APP_KEY = "englishc1";
const APP_ENTRY = '{key:"englishc1", icon:"🇬🇧", label:"English C1", desc:getLang()==="de"?"C1-Leseverständnis mit 12 Modulen, Aufgaben, Wortschatz, Wiederholung und Lernfortschritt":"C1 reading comprehension with 12 modules, exercises, vocabulary, review and progress"},';
const HUB_MARKER = '<script id="quantusEnglishC1HubLink">window.__quantusEnglishC1HubLink=true;</script>';
const REGISTRATION_SCRIPT = '<script id="quantusEnglishC1Registration" src="/quantus-english-c1-entry.js" defer></script>';

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

function injectNativeRegistry(html) {
  if (/key\s*:\s*["']englishc1["']/.test(html)) return html;
  return html.replace(
    /(\r?\n[ \t]*)\{[ \t]*key[ \t]*:[ \t]*["']polaris["'][ \t]*,/,
    function (match, indent) {
      return indent + APP_ENTRY + match;
    }
  );
}

function injectNativeRouter(html) {
  if (/case\s+["']englishc1["']\s*:/.test(html)) return html;
  return html.replace(
    /(\r?\n[ \t]*)case\s+["']ruhestand["']\s*:/,
    function (match, indent) {
      return indent + 'case "englishc1": window.location.href = "/english-c1.html"; return;' + match;
    }
  );
}

export function injectEnglishC1(source) {
  let html = String(source || "");
  html = injectNativeRegistry(html);
  html = injectNativeRouter(html);

  // Keep the parser-regression marker introduced in PR #164, but move the
  // dynamic UI behavior into a normal external browser script.
  if (!html.includes('id="quantusEnglishC1HubLink"')) {
    html = insertBeforeFinalClosingTag(html, "body", HUB_MARKER);
  }
  if (!html.includes('id="quantusEnglishC1Registration"') && !html.includes("/quantus-english-c1-entry.js")) {
    html = insertBeforeFinalClosingTag(html, "body", REGISTRATION_SCRIPT);
  }
  return html;
}

export default async function handler(request, context) {
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return response;

  const original = await response.text();
  const transformed = injectEnglishC1(original);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.set("cache-control", "no-cache, must-revalidate");
  headers.set("x-quantus-app-registry", "english-c1");
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
