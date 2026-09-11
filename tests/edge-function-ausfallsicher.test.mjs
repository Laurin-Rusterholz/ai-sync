/*
 * Die beiden Edge Functions duerfen die Seite nicht mitreissen.
 *
 * PRODUKTIONSBEFUND (11.09., Original-Edge-Log 22:00:09, Netlify-ID
 * 01M290VV023EPDBFS39SMES5S2):
 *   [quantus-universal-bootstrap] TypeError: error reading a body from
 *   connection
 *     at async readableStreamCollectIntoUint8Array (deno_web/06_streams.js)
 *     at consumeBody (deno_fetch/22_body.js:268)
 *     at quantusUniversalBootstrap (quantus-universal-bootstrap.js:23:16)
 *     at FunctionChain.runFunction
 *     at handler (quantus-app-registry.js:124:20)
 *   Zweiter, gleichlautender Eintrag fuer [quantus-app-registry].
 *
 *   Zeile 23 bzw. 124 war jeweils `await response.text()`. Der Rumpf der
 *   6,28 MB grossen Hauptapp brach mitten im Lesen ab. Die Ausnahme flog
 *   ungefangen nach oben — Netlify antwortet dann mit „This edge function has
 *   crashed", und die GANZE App ist nicht mehr erreichbar. Ein abgerissener
 *   Rumpf hat die komplette Seite gekostet.
 *
 * Dazu gemessen (selber Prozess, je drei Durchgaenge, echte 6,28-MB-Datei):
 *   Der Registry-Weg brauchte 212 ms CPU und 90,6 MB Heap pro Anfrage. Den
 *   groessten Teil davon verursachte insertBeforeFinalClosingTag: es schrieb
 *   fuer die Suche nach dem letzten </body> das GANZE Dokument klein — vier
 *   Mal, einmal pro Einfuegung. Je laenger eine Anfrage laeuft, desto laenger
 *   muss die Verbindung zum Ursprung offen bleiben, aus der gelesen wird.
 *   Nach der Korrektur: 62 ms und 49,9 MB, Ergebnis Byte fuer Byte gleich.
 *
 * Geprueft wird gegen die ECHTEN Edge Functions. Kein Netz, keine Datei wird
 * geschrieben.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registry, { injectQuantusApps, insertBeforeFinalClosingTag, readBuildTag }
  from "../netlify/edge-functions/quantus-app-registry.js";
import bootstrap, { injectUniversalAssets }
  from "../netlify/edge-functions/quantus-universal-bootstrap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ── Hilfen: eine Antwort, deren Rumpf beim Lesen abreisst ─────────────────
function antwortMitAbriss(contentType = "text/html; charset=utf-8") {
  return {
    ok: true, status: 200, statusText: "OK", body: {},
    headers: new Headers({ "content-type": contentType }),
    text() { return Promise.reject(new TypeError("error reading a body from connection")); },
  };
}
function antwortMit(html, contentType = "text/html; charset=utf-8") {
  return {
    ok: true, status: 200, statusText: "OK", body: {},
    headers: new Headers({ "content-type": contentType }),
    text() { return Promise.resolve(html); },
  };
}
const anfrage = { method: "GET" };

// ═══ 1. Abgerissener Rumpf: keine Ausnahme, keine Zwischenspeicherung ═════
for (const [name, fn] of [["app-registry", registry], ["universal-bootstrap", bootstrap]]) {
  let antwort = null, geflogen = null;
  try {
    antwort = await fn(anfrage, { next: () => Promise.resolve(antwortMitAbriss()) });
  } catch (e) { geflogen = e; }
  ok(!geflogen, `${name}: die Ausnahme fliegt weiterhin nach oben (${geflogen && geflogen.message}) — Netlify zeigt dann den Absturz und die App ist weg`);
  ok(antwort && antwort.status === 503, `${name}: statt 503 kommt ${antwort && antwort.status}`);
  const cc = antwort && antwort.headers.get("cache-control") || "";
  ok(/no-store/.test(cc), `${name}: die Fehlerantwort darf nicht zwischengespeichert werden (cache-control: ${cc})`);
  ok(antwort && antwort.headers.get("retry-after") === "1",
    `${name}: ohne Retry-After sieht ein Client den Ausfall als dauerhaft`);
  const text = antwort ? await antwort.text() : "";
  ok(/Nochmals versuchen/.test(text), `${name}: die Fehlerseite bietet keinen Weg zurueck`);
}

// ═══ 2. Bricht das Umschreiben, wird der Rumpf unveraendert ausgeliefert ══
{
  // Ein Dokument, das injectQuantusApps zum Werfen bringt, laesst sich nicht
  // erzwingen — geprueft wird deshalb die Absicherung im Quelltext und, dass
  // ein unauffaelliges Dokument unveraendert durchkommt.
  const quelle = fs.readFileSync(path.join(here, "..", "netlify/edge-functions/quantus-app-registry.js"), "utf8");
  ok(/catch \(err\) \{\s*transformed = original;/.test(quelle),
    "app-registry: ein Fehler beim Umschreiben nimmt weiterhin die Seite mit");
  const boot = fs.readFileSync(path.join(here, "..", "netlify/edge-functions/quantus-universal-bootstrap.js"), "utf8");
  ok(/catch \(err\) \{\s*transformed = html;/.test(boot),
    "bootstrap: ein Fehler beim Umschreiben nimmt weiterhin die Seite mit");
  ok(/try \{\s*original = await response\.text\(\);/.test(quelle),
    "app-registry: die Lesestelle aus dem Log ist nicht abgesichert");
  ok(/try \{\s*html = await response\.text\(\);/.test(boot),
    "bootstrap: die Lesestelle aus dem Log (Zeile 23) ist nicht abgesichert");
}

// ═══ 3. Der normale Weg bleibt unveraendert ═══════════════════════════════
{
  const doc = '<!doctype html><html><head><meta name="quantus-build" content="pruef-2026-09-11">'
    + '</head><body><script>var x = "</body>";</script>\n'
    + '<div>{key:"polaris", icon:"x"},</div>\n  case "ruhestand":\n</body></html>';
  const antwort = await registry(anfrage, { next: () => Promise.resolve(antwortMit(doc)) });
  ok(antwort.status === 200, `der normale Weg liefert ${antwort.status}`);
  ok(antwort.headers.get("x-quantus-build") === "pruef-2026-09-11",
    `die Bau-Kennung fehlt im Header (${antwort.headers.get("x-quantus-build")})`);
  ok(/no-store/.test(antwort.headers.get("cache-control") || ""), "cache-control ist nicht mehr no-store");
  const html = await antwort.text();
  ok(html.includes("quantusEnglishC1HubLink") && html.includes("quantusCareerModelRegistration"),
    "die nachgetragenen App-Verweise fehlen");
  // Der dokumentierte Fallstrick: die Einfuegung gehoert vor das LETZTE </body>,
  // nicht vor das im JavaScript-String.
  ok(html.indexOf('var x = "</body>"') < html.indexOf("quantusEnglishC1HubLink"),
    "die Verweise landen im JavaScript-String statt am Dokumentende");
  ok(html.lastIndexOf("quantusCareerModelRegistration") < html.lastIndexOf("</body>"),
    "die Verweise stehen hinter dem schliessenden body-Tag");
}

// ═══ 4. Die guenstige Suche nach dem letzten schliessenden Tag ════════════
{
  const kurz = "<html><body>A</body></html>";
  ok(insertBeforeFinalClosingTag(kurz, "body", "<x>") === "<html><body>A<x>\n</body></html>",
    "kurze Dokumente werden anders behandelt als bisher");
  ok(insertBeforeFinalClosingTag("<html><BODY>A</BODY></html>", "body", "<x>").includes("<x>\n</BODY>"),
    "Grossschreibung des Tags wird nicht mehr erkannt");
  ok(insertBeforeFinalClosingTag("kein tag", "body", "<x>") === "kein tag\n<x>",
    "ohne Tag wird nicht mehr angehaengt");
  // Rueckfall: steht das Tag weiter vorn als das Schlussfenster (256 KB),
  // muss trotzdem gefunden werden.
  const weitVorn = "<body>x</body>" + "y".repeat(300000);
  const r = insertBeforeFinalClosingTag(weitVorn, "body", "<x>");
  ok(r.includes("<x>\n</body>"), "ein Tag ausserhalb des Schlussfensters wird nicht mehr gefunden");
  ok(r.length === weitVorn.length + 4, "der Rueckfall haengt statt einzufuegen");
  // Und: das letzte Vorkommen gewinnt weiterhin.
  ok(insertBeforeFinalClosingTag("<body>1</body><body>2</body>", "body", "<x>")
      .endsWith("<body>1</body><body>2<x>\n</body>"),
    "nicht mehr das letzte Vorkommen gewinnt");
}

// ═══ 5. Nicht-HTML und Fehlerantworten laufen unberuehrt durch ════════════
{
  const js = antwortMit("var a=1;", "text/javascript");
  const antwort = await registry(anfrage, { next: () => Promise.resolve(js) });
  ok(antwort === js, "eine JavaScript-Antwort wird jetzt umgeschrieben");
  const bootJs = await bootstrap(anfrage, { next: () => Promise.resolve(js) });
  ok(bootJs === js, "bootstrap fasst jetzt auch JavaScript an");
  const post = await bootstrap({ method: "POST" }, { next: () => Promise.resolve(antwortMit("<html></html>")) });
  ok(post.status === 200 && !post.headers.get("x-quantus-universal"),
    "bootstrap schreibt jetzt auch POST-Antworten um");
}

// ═══ 6. Der teure Schritt ist raus ════════════════════════════════════════
{
  const quelle = fs.readFileSync(path.join(here, "..", "netlify/edge-functions/quantus-app-registry.js"), "utf8");
  ok(/SCHLUSS_FENSTER/.test(quelle) && /html\.slice\(ab\)\.toLowerCase\(\)/.test(quelle),
    "es wird wieder das ganze Dokument kleingeschrieben");
  const einfuegung = quelle.slice(quelle.indexOf("function injectRegistrationAssets"),
    quelle.indexOf("export function injectQuantusApps"));
  ok((einfuegung.match(/insertBeforeFinalClosingTag/g) || []).length === 1,
    "die Tags werden wieder einzeln eingesetzt statt in einem Durchgang");
}

if (luecken.length) {
  console.error(`edge function ausfallsicher: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
assert.ok(typeof injectUniversalAssets === "function");
assert.ok(typeof injectQuantusApps === "function");
assert.ok(typeof readBuildTag === "function");
console.log(`edge function ausfallsicher: ${checks} Pruefungen bestanden`);
