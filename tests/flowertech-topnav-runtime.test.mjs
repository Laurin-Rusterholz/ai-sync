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
  "Kundenanfragen", "Projekte", "Planung", "Aufgaben", "Offerten", "Rechnungen", "KI",
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
    // Aufgezeichnete Mailentwuerfe — damit der Mailpfad pruefbar ist.
    __mails: [],
    __portals: {},
    gmailCompose(opts) { win.__mails.push(opts); },
    createEntity: (kind, payload) => {
      // Echte Ablage, damit Ingest- und Versandpfade wirklich pruefbar sind.
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + Math.random().toString(36).slice(2),
    nowIso: () => "2026-08-06T12:00:00.000Z",
    todayYmd: () => "2026-08-06",
    crypto: { getRandomValues: (a) => a.fill(7) },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
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
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: {},
    // flowertech.js greift an einzelnen Stellen auf bare Globals zu.
    APP: win.APP,
    // Firebase-Doppel: zeichnet auf, was unter clientPortals landet — damit
    // ist die automatische Veroeffentlichung wirklich pruefbar.
    firebase: {
      app: () => ({
        database: () => ({
          ref: (path) => ({
            set: (value) => { win.__portals[path] = value; return Promise.resolve(); },
            remove: () => { delete win.__portals[path]; return Promise.resolve(); },
          }),
        }),
      }),
    },
  };
  sandbox.globalThis = sandbox;
  // Dasselbe document-Objekt auch am window — Tests koennen so Formularfelder
  // stellen, die flowertech.js ueber das bare `document` liest.
  win.document = sandbox.document;
  win.firebase = sandbox.firebase;
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
    ["intakes", "Kundenanfragen"],
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
    // Aus dem „Senden" wird eine echte Offertenanfrage — kein Mail-Entwurf.
    ok(/kind: 'quote'/.test(page), "der Vision Room sendet die falsche Art");
    ok(/source: 'vision-room'/.test(page), "die Herkunft der Anfrage fehlt");
    ok(!/vrSend\.dataset\.mailto/.test(page), "der Vision Room faellt weiterhin auf ein Mailprogramm zurueck");
    ok(!/Direktversand nicht möglich/.test(page), "der Mail-Rueckfalltext steht weiterhin auf der Seite");
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

// ── 12. Vision-Token findet seinen Vorgang (Korrektur 1) ──────────────────
// Vorher fehlte visionToken in byToken: Eine Ausarbeitung mit ?v= konnte nie
// zugeordnet werden und lief ins Leere.
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  const projects = data.entities.projects;

  projects.prj_1 = { id: "prj_1", title: "Bestehender Vorgang", projectType: "flowertech",
    pipelineStage: "proposal", ftRoute: "offer_first" };
  ft.shares = { prj_1: { formToken: "f".repeat(28), portalToken: "p".repeat(28), visionToken: "v".repeat(28) } };
  ft.briefings = { prj_1: { goal: "Ursprüngliches Ziel", features: ["Kontaktformular"] } };
  const before = Object.keys(projects).length;

  const handled = win._ftIngestSubmissions({
    sub_v: {
      id: "sub_v", kind: "vision", token: "v".repeat(28),
      payload: { type: "Website", idea: "Neue Startseite mit Buchung",
                 features: ["Terminbuchung", "Kontaktformular"], email: "kundin@muster.ch" },
    },
  });
  ok(handled === 1, "die Vision-Ausarbeitung wurde nicht zugeordnet — genau der Fehler");
  ok(Object.keys(projects).length === before,
    "die Vision-Ausarbeitung hat ein zweites Projekt angelegt");
  ok(!!projects.prj_1.ftVision, "die Ausarbeitung ist nicht am Vorgang hinterlegt");
  ok(ft.briefings.prj_1.features.includes("Terminbuchung"),
    "die neue Funktion wurde nicht in den Bedarf übernommen");
  ok(ft.briefings.prj_1.features.filter((f) => f === "Kontaktformular").length === 1,
    "eine bereits bekannte Funktion wurde doppelt eingetragen");
  ok(ft.briefings.prj_1.goal === "Ursprüngliches Ziel", "der gepflegte Bedarf wurde überschrieben");
}

// ── 13. Kein Cross-Match zwischen den Token-Arten (Korrektur 1) ───────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  data.entities.projects.prj_1 = { id: "prj_1", title: "X", projectType: "flowertech", pipelineStage: "proposal" };
  ft.shares = { prj_1: { formToken: "f".repeat(28), portalToken: "p".repeat(28), visionToken: "v".repeat(28) } };
  const before = Object.keys(data.entities.projects).length;

  // Ein Formular-Token darf keine Vision einschleusen …
  ok(win._ftIngestSubmissions({
    s1: { id: "s1", kind: "vision", token: "f".repeat(28),
          payload: { type: "Website", idea: "Untergeschoben", features: ["X"], email: "a@b.ch" } },
  }) === 0, "ein Formular-Token nimmt eine Vision-Ausarbeitung an");
  // … und ein Vision-Token keinen Änderungswunsch.
  ok(win._ftIngestSubmissions({
    s2: { id: "s2", kind: "change", token: "v".repeat(28), payload: { title: "Untergeschoben" } },
  }) === 0, "ein Vision-Token nimmt einen Änderungswunsch an");
  ok(!data.entities.projects.prj_1.ftVision, "die untergeschobene Vision wurde übernommen");
  ok(Object.keys(data.entities.projects).length === before, "der Cross-Match hat ein Projekt angelegt");

  // Ein völlig fremder Token bleibt wirkungslos.
  ok(win._ftIngestSubmissions({
    s3: { id: "s3", kind: "vision", token: "z".repeat(28),
          payload: { type: "Website", idea: "Fremd", features: ["X"], email: "a@b.ch" } },
  }) === 0, "ein fremder Token wird angenommen");
}

// ── 14. Vision ohne Token legt genau EINEN Vorgang an ─────────────────────
// Seit der Zusammenfuehrung muendet der Vision Room in den Kundenanfrage-Weg:
// Es entsteht ein Anfrage-Dokument und genau eine Aufgabe — kein Sonderweg.
{
  const { win } = renderAt("#/flowertech");
  const projects = win.APP.state.data.entities.projects;
  const entry = {
    id: "sub_neu", kind: "vision", token: null,
    payload: { type: "Web-App", idea: "Mitgliederverwaltung",
               features: ["Login", "Beitragsliste"], email: "verein@muster.ch" },
  };
  ok(win._ftIngestSubmissions({ sub_neu: entry }) === 1, "die Vision erzeugt kein Direktprojekt");
  const created = Object.values(projects).filter((p) => p.sourceVisionId === "sub_neu");
  ok(created.length === 1, `es entstanden ${created.length} Projekte statt genau eines`);
  ok(created[0].ftRouteSource === "vision-room", "die Herkunft „Vision Room“ fehlt am Vorgang");
  ok(created[0].ftIntakeDocument && created[0].ftIntakeDocument.answers.length,
    "der Vision-Eingang erzeugt kein Anfrage-Dokument");
  ok(created[0].deliveryType === "program", "Web-App wurde nicht als Programm erkannt");
  const visionTasks = Object.values(win.APP.state.data.entities.tasks)
    .filter((t) => t.source === "flowertech-intake");
  ok(visionTasks.length === 1, `es entstanden ${visionTasks.length} Aufgaben statt genau einer`);

  // Derselbe Eingang ein zweites Mal: kein zweites Projekt.
  win._ftIngestSubmissions({ sub_neu: entry });
  ok(Object.values(projects).filter((p) => p.sourceVisionId === "sub_neu").length === 1,
    "derselbe Vision-Eingang hat ein zweites Projekt angelegt");
}

// ── 15. Die Beilage blockiert den Versand wirklich (Korrektur 2) ──────────
// Vorher war sie nur Anzeige: _ftDocStatus('offer', id, 'sent') ging trotzdem.
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  const project = { id: "prj_1", title: "Angebotsvorgang", projectType: "flowertech",
    pipelineStage: "proposal", ftRoute: "offer_first" };
  data.entities.projects.prj_1 = project;
  ft.shares = { prj_1: {} };
  const offer = { id: "of_1", projectId: "prj_1", status: "draft", history: [],
    client: { company: "Muster AG" }, items: [{ id: "it_1", description: "Website", qty: 1, price: 4500 }] };
  ft.offers = [offer];

  // Ohne Beilage: blockiert.
  win._ftDocStatus("offer", "of_1", "sent");
  ok(offer.status === "draft", "die Offerte ging ohne Beilage raus");
  ok(!win._ftOfferReadyToSend(offer).ready, "der Versand gilt ohne Beilage als bereit");

  // Beispiel-URL, aber unbrauchbar: weiterhin blockiert.
  project.ftOfferAttachment = { kind: "example", exampleUrl: "muster.ch" };
  win._ftDocStatus("offer", "of_1", "sent");
  ok(offer.status === "draft", "eine URL ohne Schema liess den Versand zu");
  project.ftOfferAttachment = { kind: "example", exampleUrl: "javascript:alert(1)" };
  win._ftDocStatus("offer", "of_1", "sent");
  ok(offer.status === "draft", "eine javascript:-URL liess den Versand zu");

  // Echte Beispiel-URL: geht raus UND steht im Dokument.
  project.ftOfferAttachment = { kind: "example", exampleUrl: "https://muster.ch/vorschau" };
  win._ftDocStatus("offer", "of_1", "sent");
  ok(offer.status === "sent", "eine gültige Beilage blockiert den Versand");
  ok(offer.attachment && offer.attachment.url === "https://muster.ch/vorschau",
    "die Beilage steht nicht im Dokument, sondern nur am Projekt");
  ok(offer.attachment.kind === "example", "die Art der Beilage fehlt im Dokument");
}

// ── 16. Vision-Beilage landet als echter Link im Dokument ─────────────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  data.entities.projects.prj_1 = { id: "prj_1", title: "V", projectType: "flowertech",
    pipelineStage: "proposal", ftRoute: "offer_first" };
  ft.shares = { prj_1: {} };
  const offer = { id: "of_2", projectId: "prj_1", status: "draft", history: [],
    client: { company: "Muster AG" }, items: [{ id: "it_1", description: "Website", qty: 1, price: 4500 }] };
  ft.offers = [offer];

  win._ftSetOfferAttachment("prj_1", "vision");
  const token = data.entities.projects.prj_1.ftOfferAttachment.visionToken;
  ok(/^[A-Za-z0-9_-]{24,64}$/.test(token), "der Vision-Token hat keine brauchbare Form");
  ok(ft.shares.prj_1.visionToken === token,
    "der Vision-Token hängt nicht am Vorgang — die Ausarbeitung fände nicht zurück");

  win._ftDocStatus("offer", "of_2", "sent");
  ok(offer.status === "sent", "die Vision-Beilage blockiert den Versand");
  ok(offer.attachment && offer.attachment.kind === "vision", "die Vision-Beilage fehlt im Dokument");
  ok(offer.attachment.url.includes("?v=" + token) && offer.attachment.url.includes("#vision"),
    `der Vision-Link im Dokument stimmt nicht: ${offer.attachment.url}`);
  // Kein erfundener Link: die URL enthält genau den Token dieses Vorgangs.
  ok(!/undefined|null/.test(offer.attachment.url), "der Vision-Link enthält Platzhalter");
}

// ── 17. Direktprojekte bleiben unbehelligt ────────────────────────────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  data.entities.projects.prj_d = { id: "prj_d", title: "D", projectType: "flowertech",
    pipelineStage: "build", ftRoute: "direct" };
  const offer = { id: "of_3", projectId: "prj_d", status: "draft", history: [],
    client: { company: "Muster AG" }, items: [{ id: "it_1", description: "Website", qty: 1, price: 4500 }] };
  data.flowertech.offers = [offer];
  win._ftDocStatus("offer", "of_3", "sent");
  ok(offer.status === "sent", "ein Direktprojekt wird von der Beilagenpflicht blockiert");
}

// ── 18. Keine stille Default-Route (Korrektur 3) ──────────────────────────
{
  const source = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  ok(!/\|\| "offer_first"/.test(source), "die stille Default-Route ist zurück");
  ok(/if \(ft\) ft\.ui\.newRoute = null;/.test(source), "die Wahl wird nach der Anlage nicht zurückgesetzt");
  ok(/Bitte zuerst den Weg wählen/.test(source), "ohne Wahl fehlt der Hinweis");
  ok(/function routeNoticeHtml\(\)/.test(source), "der Hinweis unter dem Formular ist nicht routenabhängig");
  ok(!/Das Projekt startet in der Phase .Lead/.test(source), "der veraltete Lead-Hinweis steht noch da");

  const { win } = renderAt("#/flowertech");
  const before = Object.keys(win.APP.state.data.entities.projects).length;
  win.APP.state.data.flowertech.ui = { newRoute: null };
  win._ftCreateWorkflowProject();
  ok(Object.keys(win.APP.state.data.entities.projects).length === before,
    "ohne Wegwahl entstand trotzdem ein Projekt");
  win.APP.state.data.flowertech.ui = { newRoute: "quatsch" };
  win._ftCreateWorkflowProject();
  ok(Object.keys(win.APP.state.data.entities.projects).length === before,
    "eine erfundene Route legt ein Projekt an");
}

// ── 19. „Per Mail senden" geht durch dieselbe Schranke ────────────────────
// Zweiter Bypass: _ftMailDoc() rief gmailCompose(docMailBody(...)) direkt auf,
// ohne offerReadyToSend() und ohne attachToOfferDoc(). Damit liess sich eine
// Offerte ohne Beilage verschicken, und selbst mit Beilage fehlte der Link.
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  data.entities.projects.prj_1 = { id: "prj_1", title: "Angebotsvorgang", projectType: "flowertech",
    pipelineStage: "proposal", ftRoute: "offer_first", client: { email: "kundin@muster.ch" } };
  ft.shares = { prj_1: {} };
  const offer = { id: "of_m", projectId: "prj_1", status: "draft", history: [],
    items: [{ id: "it_1", description: "Website", qty: 1, price: 4500 }],
    client: { company: "Muster AG", email: "kundin@muster.ch" }, number: "OF-2026-0001" };
  ft.offers = [offer];

  // Ohne Beilage: kein Entwurf, kein Verlaufseintrag, Status unveraendert.
  win._ftMailDoc("offer", "of_m");
  ok(win.__mails.length === 0, "der Mailentwurf ging ohne Beilage auf");
  ok(offer.status === "draft", "der Mailpfad hat den Status verändert");
  ok((offer.history || []).length === 0, "ohne Versand wurde ein Verlaufseintrag geschrieben");

  // Unbrauchbare Beispiel-URL: weiterhin blockiert.
  data.entities.projects.prj_1.ftOfferAttachment = { kind: "example", exampleUrl: "muster.ch" };
  win._ftMailDoc("offer", "of_m");
  ok(win.__mails.length === 0, "eine URL ohne Schema liess den Mailversand zu");

  // Echte Beispiel-URL: Entwurf geht auf UND der Link steht im Text.
  data.entities.projects.prj_1.ftOfferAttachment = { kind: "example", exampleUrl: "https://muster.ch/vorschau" };
  win._ftMailDoc("offer", "of_m");
  ok(win.__mails.length === 1, "der Mailentwurf ging mit gültiger Beilage nicht auf");
  const mail = win.__mails[0];
  ok(mail.body.includes("https://muster.ch/vorschau"),
    "die Beispiel-URL fehlt im Gmail-Text — genau der gemeldete Fehler");
  ok(/Beispiel/.test(mail.body), "der Link im Mailtext ist nicht eingeordnet");
  ok(mail.to === "kundin@muster.ch", "der Entwurf geht an die falsche Adresse");
  ok(offer.attachment && offer.attachment.url === "https://muster.ch/vorschau",
    "die Beilage steht nicht im Dokument");
  // Der Status wird erst beim wirklichen Senden gesetzt.
  ok(offer.status === "draft", "der Mailentwurf hat die Offerte bereits auf 'versendet' gesetzt");
  ok((offer.history || []).some((h) => h.event === "mail"), "der Verlaufseintrag zum Entwurf fehlt");
}

// ── 20. Vision-Beilage steht im Gmail-Text ────────────────────────────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  data.entities.projects.prj_1 = { id: "prj_1", title: "V", projectType: "flowertech",
    pipelineStage: "proposal", ftRoute: "offer_first", client: { email: "k@muster.ch" } };
  ft.shares = { prj_1: {} };
  const offer = { id: "of_v", projectId: "prj_1", status: "draft", history: [],
    items: [{ id: "it_1", description: "Website", qty: 1, price: 4500 }],
    client: { company: "Muster AG", email: "k@muster.ch" } };
  ft.offers = [offer];

  win._ftSetOfferAttachment("prj_1", "vision");
  const token = data.entities.projects.prj_1.ftOfferAttachment.visionToken;
  win._ftMailDoc("offer", "of_v");
  ok(win.__mails.length === 1, "der Mailentwurf mit Vision-Beilage ging nicht auf");
  const body = win.__mails[0].body;
  ok(body.includes("?v=" + token) && body.includes("#vision"),
    "der persönliche Vision-Link fehlt im Gmail-Text");
  ok(/Vision Room/.test(body), "der Vision-Link ist im Mailtext nicht eingeordnet");
  ok(!/undefined|null/.test(body.split("\n").find((l) => l.includes("?v=")) || ""),
    "der Vision-Link im Mailtext enthält Platzhalter");
  ok(offer.status === "draft", "der Vision-Mailentwurf hat den Status gesetzt");
}

// ── 21. Direktprojekte und Rechnungen bleiben unbehelligt ─────────────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  const ft = data.flowertech;
  data.entities.projects.prj_d = { id: "prj_d", title: "D", projectType: "flowertech",
    pipelineStage: "build", ftRoute: "direct", client: { email: "d@muster.ch" } };
  ft.offers = [{ id: "of_d", projectId: "prj_d", status: "draft", history: [],
    items: [{ id: "it_1", description: "Website", qty: 1, price: 4500 }],
    client: { company: "Muster AG", email: "d@muster.ch" } }];
  ft.invoices = [{ id: "in_1", projectId: "prj_d", status: "draft", items: [], history: [],
    client: { email: "d@muster.ch" } }];

  win._ftMailDoc("offer", "of_d");
  ok(win.__mails.length === 1, "ein Direktprojekt wird von der Beilagenpflicht blockiert");
  win._ftMailDoc("invoice", "in_1");
  ok(win.__mails.length === 2, "eine Rechnung wird von der Beilagenpflicht blockiert");
}

// ── 22. Kundenseite entsteht bei JEDEM Anlageweg automatisch ──────────────
{
  const portalKeys = (win) => Object.keys(win.__portals);

  // a) Manuell mit gewaehltem Weg
  {
    const { win } = renderAt("#/flowertech");
    win.APP.state.data.flowertech.ui = { newRoute: "offer_first" };
    win.document.getElementById = (id) => (id === "ftWfTitle" ? { value: "Manuell" } : { value: "" });
    win._ftCreateWorkflowProject();
    const keys = portalKeys(win);
    ok(keys.length === 1, `manueller Weg legte ${keys.length} Kundenseiten an statt genau einer`);
    ok(/^flowertech\/clientPortals\/[A-Za-z0-9_-]{24,64}$/.test(keys[0]),
      `der Snapshot-Pfad stimmt nicht: ${keys[0]}`);
    ok(win.__portals[keys[0]].title === "Manuell", "der Snapshot trägt nicht den Projektnamen");
    ok(!JSON.stringify(win.__portals[keys[0]]).includes("project_"),
      "eine interne Projekt-ID steht im Snapshot");
  }

  // b) Anfrage → Projekt (mit ausdruecklicher Wegwahl)
  {
    const { win } = renderAt("#/flowertech");
    win.APP.state.data.flowertech.inquiries = {
      inq_1: { name: "Anna", company: "Muster AG", email: "a@muster.ch",
               message: "Wir hätten gerne eine neue Website mit Buchung." },
    };
    win._ftInquiryToProject("inq_1", "direct");
    ok(portalKeys(win).length === 1, "aus einer Anfrage entsteht keine Kundenseite");
    // Zweiter Klick: kein zweites Projekt, keine zweite Seite.
    win._ftInquiryToProject("inq_1", "direct");
    ok(portalKeys(win).length === 1, "der zweite Klick legte eine zweite Kundenseite an");
  }

  // c) Vision Room → Direktprojekt
  {
    const { win } = renderAt("#/flowertech");
    const entry = { id: "sub_v", kind: "vision", token: null,
      payload: { type: "Website", idea: "Neue Seite", features: ["Kontakt"], email: "v@muster.ch" } };
    win._ftIngestSubmissions({ sub_v: entry });
    ok(portalKeys(win).length === 1, "das Vision-Direktprojekt bekommt keine Kundenseite");
    win._ftIngestSubmissions({ sub_v: entry });
    ok(portalKeys(win).length === 1, "derselbe Vision-Eingang legte eine zweite Kundenseite an");
  }
}

// ── 23. Snapshot wird bei relevanten Änderungen nachgezogen ───────────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  data.entities.projects.prj_1 = { id: "prj_1", title: "Laufend", projectType: "flowertech",
    pipelineStage: "intake", ftRoute: "direct" };
  data.flowertech.shares = { prj_1: { portalToken: "p".repeat(28) } };
  const key = "flowertech/clientPortals/" + "p".repeat(28);

  win._ftSetProjectStage("prj_1", "build");
  ok(win.__portals[key], "nach dem Phasenwechsel wurde kein Snapshot geschrieben");
  ok(win.__portals[key].stageLabel === "Umsetzung", "die neue Phase steht nicht im Snapshot");

  win._ftSetProjectField("prj_1", "previewUrl", "https://vorschau.muster.ch");
  ok(win.__portals[key].previewUrl.startsWith("https://vorschau.muster.ch"),
    "die Vorschau-URL wird nicht nachgezogen");

  // Ungültige URL erscheint gar nicht erst.
  win._ftSetProjectField("prj_1", "previewUrl", "http://unsicher.ch");
  ok(win.__portals[key].previewUrl === "", "eine http-URL landet auf der Kundenseite");

  // Version und Freigabe
  win.document.getElementById = (id) => (id === "ftVersionLabel" ? { value: "Entwurf 1" } : { value: "" });
  win._ftAddVersion("prj_1");
  ok((win.__portals[key].versions || []).length === 1, "die neue Version fehlt im Snapshot");
  ok(win.__portals[key].versions[0].approved === false, "der Freigabestatus stimmt nicht");
}

// ── 24. Link erneuern widerruft den alten Snapshot ────────────────────────
{
  const { win } = renderAt("#/flowertech");
  const data = win.APP.state.data;
  data.entities.projects.prj_1 = { id: "prj_1", title: "R", projectType: "flowertech", pipelineStage: "build" };
  const alt = "a".repeat(28);
  data.flowertech.shares = { prj_1: { portalToken: alt } };
  win._ftPublishClientPortal("prj_1");
  const altKey = "flowertech/clientPortals/" + alt;
  ok(win.__portals[altKey], "der erste Snapshot wurde nicht geschrieben");

  win._ftRotateToken("prj_1", "portalToken");
  ok(!win.__portals[altKey], "der alte Snapshot bleibt nach dem Erneuern lesbar — der Link wäre nicht widerrufen");
  const neu = data.flowertech.shares.prj_1.portalToken;
  ok(neu !== alt && /^[A-Za-z0-9_-]{24,64}$/.test(neu), "es entstand kein brauchbarer neuer Token");
  ok(win.__portals["flowertech/clientPortals/" + neu], "unter dem neuen Token liegt kein Snapshot");
}

// ── 25. UI: Kundenseite statt „veröffentlichen" ───────────────────────────
{
  const source = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  ok(/function publishClientPortal\(projectId\)/.test(source), "die zentrale Veröffentlichung fehlt");
  ok(/function refreshClientPortal\(projectId\)/.test(source), "die automatische Aktualisierung fehlt");
  ok(/core\.buildClientSnapshot\(/.test(source),
    "der Snapshot wird nicht mehr über die geprüfte Positivliste im Kern gebaut");
  ok(!/projectId: projectId,\s*\n\s*title: project\.title/.test(source),
    "der alte Snapshot mit interner Projekt-ID ist zurück");
  ok(/_ftClientPortalLink/.test(source), "der Kundenlink ist nicht abrufbar");
  // Der Link wird nie automatisch verschickt.
  ok(!/gmailCompose[\s\S]{0,200}clientPortalUrl/.test(source),
    "der Kundenlink wird automatisch per Mail verschickt");
}

console.log(`flowertech topnav runtime: ok (${checks} Pruefungen)`);
