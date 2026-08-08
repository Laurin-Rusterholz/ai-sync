/*
 * FlowerTech: keine App-Navigation im Inhalt — Laufzeittest gegen #/flowertech.
 *
 * Produktionsbefund: Nach dem Oeffnen von #/flowertech stand ueber dem Inhalt
 * weiterhin eine eigene Bereichsleiste ("Dashboard, Projekte, Planung,
 * Aufgaben, Offerten, Rechnungen, KI, Leads / Anfragen, Pipeline, Finanzen,
 * Notizen, Links, Instagram-Videos, Firma") — also eine zweite App-Navigation
 * direkt unter der globalen.
 *
 * Der Test laedt flowertech.js WIRKLICH, setzt den Hash auf #/flowertech und
 * ruft die echte Renderfunktion window.viewFlowerTech() auf. Geprueft wird das
 * gerenderte HTML, nicht der Quelltext.
 *
 * Wichtig ist beides: Die Leiste muss weg UND kein Bereich darf verloren gehen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Denselben Workflow-Kern bereitstellen, den der Browser als Modul laedt —
// sonst faellt der Prozessblock still aus.
const CORE = (await import(path.join(root, "public/flowertech-workflow-core.js"))).default;
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// Die Bereiche, die der Nutzer in der alten Leiste gesehen hat.
const SECTION_LABELS = [
  "Projekte", "Planung", "Aufgaben", "Offerten", "Rechnungen", "KI",
  "Leads / Anfragen", "Pipeline", "Finanzen", "Notizen", "Links",
  "Instagram-Videos", "Firma",
];

// ── Minimale Quantus-Umgebung, damit flowertech.js laeuft ──────────────────
function makeSandbox(hash) {
  const data = {
    entities: { projects: {}, tasks: {}, notes: {} },
    flowertech: {},
    meta: {},
  };
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash, origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {},
    removeEventListener() {},
    scheduleSave() {},
    render() {},
    toast() {},
    createEntity: () => "id_1",
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + Math.random().toString(36).slice(2),
    nowIso: () => "2026-08-06T12:00:00.000Z",
    todayYmd: () => "2026-08-06",
    crypto: { getRandomValues: (a) => a.fill(7) },
    setTimeout: () => 0,
    confirm: () => true,
    prompt: () => "",
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {} }),
      body: { appendChild() {}, classList: { toggle() {}, remove() {} } },
    },
    location: win.location,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: {},
    // flowertech.js greift an einzelnen Stellen auf bare Globals zu.
    APP: win.APP,
    firebase: undefined,
  };
  sandbox.globalThis = sandbox;
  return { sandbox, win };
}

function renderAt(hash) {
  const { sandbox, win } = makeSandbox(hash);
  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  vm.runInContext(code, context);
  ok(typeof win.viewFlowerTech === "function", "viewFlowerTech() wird nicht exportiert");
  // Das eingebettete <style> traegt Klassennamen, die sonst falsche Treffer
  // erzeugen — geprueft wird nur das gerenderte Markup.
  const full = win.viewFlowerTech();
  const html = full.replace(/<style>[\s\S]*?<\/style>/g, "");
  return { html, full, win };
}

// ── 1. Übersicht: keine Bereichsleiste über dem Inhalt ─────────────────────
{
  const { html, win } = renderAt("#/flowertech");
  ok(html.length > 500, "die FlowerTech-Ansicht rendert nichts");

  // Die alte Leiste bestand aus <button class="ft-tab …" onclick="_ftSetTab(…)">.
  const tabButtons = html.match(/class="ft-tab /g) || [];
  ok(tabButtons.length === 0,
    `die FlowerTech-Bereichsleiste ist wieder da (${tabButtons.length} Reiter im gerenderten HTML)`);
  ok(!/<div class="ft-tabs">/.test(html), "der Container der Bereichsleiste wird wieder gerendert");

  // Kein Leerraum-Rest: der Kontextstreifen erscheint auf der Übersicht nicht.
  ok(!/ft-context/.test(html), "auf der Übersicht steht ein leerer Kontextstreifen");

  // 2. Kein Bereich ist verloren: jeder hat einen echten Deep Link.
  for (const [key, label] of [
    ["projects", "Projekte"], ["planung", "Planung"], ["tasks", "Aufgaben"],
    ["offers", "Offerten"], ["invoices", "Rechnungen"], ["ai", "KI"],
    ["leads", "Leads / Anfragen"], ["pipeline", "Pipeline"], ["finances", "Finanzen"],
    ["notes", "Notizen"], ["links", "Links"], ["videos", "Instagram-Videos"], ["settings", "Firma"],
  ]) {
    ok(html.includes('href="#/flowertech/' + key + '"'), `Bereich ohne Deep Link: ${key} (${label})`);
    ok(html.includes(">" + label.replace(/&/g, "&amp;") + "</strong>"),
      `Bereich fehlt im Kontextzugang: ${label}`);
  }

  // 3. Die globale Suche kann die Bereiche anbieten.
  ok(typeof win.flowerTechSearchSections === "function",
    "die Bereiche werden der globalen Suche nicht angeboten");
  const sections = win.flowerTechSearchSections();
  ok(sections.length === SECTION_LABELS.length,
    `die Suche kennt ${sections.length} Bereiche statt ${SECTION_LABELS.length}`);
  for (const label of SECTION_LABELS) {
    ok(sections.some((s) => s.title === "FlowerTech: " + label), `Suche kennt Bereich nicht: ${label}`);
  }
  ok(sections.every((s) => s.key && s.icon && s.sub), "ein Sucheintrag ist unvollständig");
}

// ── 4. Geöffneter Bereich: schmale Kontextzeile statt Leiste ───────────────
{
  const { html } = renderAt("#/flowertech/offers");
  const tabButtons = html.match(/class="ft-tab /g) || [];
  ok(tabButtons.length === 0, "im geöffneten Bereich erscheint wieder die Bereichsleiste");
  ok(/ft-context/.test(html), "im geöffneten Bereich fehlt der Rückweg zur Übersicht");
  ok(/FlowerTech-Übersicht/.test(html), "der Rückweg ist nicht beschriftet");
  ok(/ft-context-title/.test(html), "der geöffnete Bereich wird nicht benannt");
  ok(/Offerten/.test(html), "der Bereich Offerten wird nicht gerendert");
  // Die Einstiegskarten stehen NUR auf der Übersicht.
  ok(!/ft-entries/.test(html), "die Einstiegskarten drängen sich in den geöffneten Bereich");
}

// ── 5. Der Deep Link bestimmt den Bereich ──────────────────────────────────
{
  const invoices = renderAt("#/flowertech/invoices").html;
  ok(/ft-context-title[^>]*>[^<]*Rechnungen/.test(invoices),
    "der Deep Link #/flowertech/invoices öffnet nicht den Bereich Rechnungen");
  // Unbekannter Bereich faellt sauber auf die Uebersicht zurueck.
  const bogus = renderAt("#/flowertech/gibtesnicht").html;
  ok(!/ft-context/.test(bogus), "ein unbekannter Bereich erzeugt einen leeren Kontextstreifen");
  ok(/ft-entries/.test(bogus), "ein unbekannter Bereich landet nicht auf der Übersicht");
}

// ── 6. Der Projekt-Workspace behält seine eigene Gliederung ────────────────
// Sie gehört zum Projekt, nicht zur App-Navigation — sie darf bleiben.
{
  const source = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  ok(/var nav = '<div class="ft-tabs ft-subtabs">'/.test(source),
    "die Gliederung innerhalb eines Projekts ist mit entfernt worden");
  ok(/function ftWorkflowPanel\(projectId\)/.test(source), "der Projekt-Workspace fehlt");
}

// ── 7. Die globale Suche speist die Bereiche wirklich ein ──────────────────
{
  const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  ok(/window\.flowerTechSearchSections === 'function'/.test(index),
    "die globale Suche fragt die FlowerTech-Bereiche nicht ab");
  ok(index.includes("'#/flowertech/' + section.key"),
    "ein Suchtreffer öffnet den Bereich nicht per Deep Link");
  const build = /<meta\s+name="quantus-build"\s+content="([^"]*)"/.exec(index);
  ok(build && /flowertech-topnav-removed/.test(build[1]),
    `die Bau-Kennung wurde nicht hochgezogen: ${build && build[1]}`);
}

// ── 8. Der Prozess steht auf der Übersicht, vor den Bereichen ─────────────
// "Eine Anfrage wird zum Projekt" soll nicht gesucht werden muessen, sondern
// als naechster Schritt auftauchen.
{
  const { html } = renderAt("#/flowertech");
  const prozess = html.indexOf("Nächster Schritt");
  const bereiche = html.indexOf(">Bereiche<");
  ok(prozess > 0, "der Prozessblock fehlt auf der Übersicht");
  ok(bereiche > 0 && prozess < bereiche, "der Prozess steht nicht vor den Bereichen");
  // Ohne Daten ein ruhiger, erklaerender Leerzustand statt einer leeren Karte.
  ok(/Nichts offen/.test(html), "der Leerzustand des Prozessblocks fehlt");

  const source = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  ok(/function processHtml\(\)/.test(source), "processHtml() fehlt");
  ok(/core\.nextProcessSteps\(/.test(source),
    "der Prozessblock rechnet nicht mit der gemeinsamen Logik aus dem Kern");
  // Anfrage -> Projekt ist ein vollstaendiger Schritt, kein blosser Knopf.
  ok(/core\.projectFromInquiry\(/.test(source),
    "_ftInquiryToProject baut das Projekt nicht ueber den geteilten Kern");
  ok(/ensureToken\(projectId, "formToken"\)/.test(source),
    "beim Umwandeln entsteht kein teilbarer Formularlink");
  ok(/inquiry\.projectId = projectId;/.test(source),
    "die Anfrage wird nicht als umgewandelt markiert — sie liesse sich zweimal umwandeln");
  ok(/projects\(\)\.find\(function \(p\) \{ return p\.sourceInquiryId === inquiryId; \}\)/.test(source),
    "eine bereits umgewandelte Anfrage erzeugt ein zweites Projekt");
  ok(/window\._ftOpenProjectAt = function/.test(source),
    "ein Prozessschritt landet nicht im passenden Projektbereich");
}

// ── 9. Der Start ist eindeutig: genau zwei Wege ───────────────────────────
{
  const { html } = renderAt("#/flowertech");
  ok(/Neue Zusammenarbeit starten/.test(html), "der eindeutige Einstieg fehlt auf der Übersicht");
  ok(/Offerte zuerst/.test(html) && /Direktprojekt/.test(html), "die zwei Wege stehen nicht zur Wahl");
  const routeButtons = (html.match(/class="ft-route[ "]/g) || []).length;
  ok(routeButtons === 2, `es stehen ${routeButtons} Wege zur Wahl statt genau 2`);
  ok(/_ftPickNewRoute\('offer_first'\)/.test(html) && /_ftPickNewRoute\('direct'\)/.test(html),
    "die Wegwahl ist nicht verdrahtet");
  // Der Start steht vor dem Prozess und damit ganz oben.
  ok(html.indexOf("Neue Zusammenarbeit starten") < html.indexOf("Nächster Schritt"),
    "der Einstieg steht nicht zuoberst");
}

// ── 10. Anfrage → Projekt wählt nicht mehr still ──────────────────────────
{
  const source = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  ok(/ft\.ui\.routeChoice = \{ inquiryId: inquiryId \};/.test(source),
    "ein Klick auf die Anfrage legt weiterhin ohne Wahl ein Projekt an");
  ok(/core\.ROUTES\.some\(function \(r\) \{ return r\.key === route; \}\)/.test(source),
    "die Route wird nicht gegen die erlaubten Wege geprüft");
  ok(/window\._ftCancelRouteChoice/.test(source), "die Wegwahl lässt sich nicht abbrechen");

  // Offerte: Beilage, Vision-Link und Entscheid.
  ok(/window\._ftSetOfferAttachment = function/.test(source), "die Beilagen-Wahl fehlt");
  ok(/window\._ftSetExampleUrl = function/.test(source), "die Beispiel-URL lässt sich nicht pflegen");
  ok(/function visionLinkFor\(projectId\)/.test(source), "der persönliche Vision-Link fehlt");
  ok(/\/\?v=" \+ token \+ "#vision/.test(source), "der Vision-Link zeigt nicht auf den Vision Room");
  ok(/sharesOf\(projectId\)\.visionToken = /.test(source),
    "der Vision-Token hängt nicht am Vorgang — die Ausarbeitung fände nicht zurück");
  ok(/window\._ftOfferDecision = function/.test(source), "Annahme/Ablehnung fehlt");
  ok(/project\.ftOutcome = "lost"/.test(source), "die Ablehnung schliesst den Vorgang nicht als verloren");
  ok(!/createEntity\("project"[\s\S]{0,400}?ftOutcome/.test(source),
    "bei der Entscheidung entsteht ein zweites Projekt");

  // Vision Room → Direktprojekt, genau einmal.
  ok(/function createProjectFromVision\(entry\)/.test(source), "der Vision-Room-Trigger fehlt");
  ok(/p\.sourceVisionId === entry\.id/.test(source),
    "derselbe Vision-Eingang könnte zwei Projekte anlegen");
  ok(/entry\.kind === "vision" && !entry\.token/.test(source),
    "eine Vision ohne Token wird nicht als neuer Vorgang behandelt");
  ok(/function applyVision\(projectId, payload\)/.test(source),
    "eine Vision mit Token ergänzt kein bestehendes Projekt");
}

// ── 11. Der Vision Room sendet wirklich an Quantus ────────────────────────
// Zweites Repo, aber derselbe Vertrag — deshalb hier mitgeprüft, sofern der
// Klon vorhanden ist.
{
  const visionPage = "/workspace/flowertech/index.html";
  if (fs.existsSync(visionPage)) {
    const page = fs.readFileSync(visionPage, "utf8");
    ok(/flowertech-portal/.test(page), "der Vision Room ruft die Quantus-Funktion nicht auf");
    ok(/kind: 'vision'/.test(page), "der Vision Room sendet die falsche Art");
    ok(/idempotencyKey/.test(page), "der Vision Room sichert nicht gegen Doppeleinreichung");
    ok(/id="vrHp"/.test(page), "dem Vision Room fehlt der Honeypot");
    ok(/URLSearchParams\(location\.search\)\.get\('v'\)/.test(page),
      "der Vision Room liest den Zuordnungs-Token nicht");
    ok(/\{24,64\}/.test(page), "der Token wird nicht auf Form geprüft");
    const toml = fs.readFileSync("/workspace/flowertech/netlify.toml", "utf8");
    ok(/connect-src[^;]*management-xo2-pro/.test(toml),
      "die CSP verbietet den Aufruf an Quantus — der Versand würde im Browser blockiert");
  }
}

console.log(`flowertech topnav runtime: ok (${checks} Pruefungen)`);
