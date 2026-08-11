/*
 * FlowerTech — das Projekt-Cockpit.
 * ---------------------------------------------------------------------------
 * Live-Befund: Die Projektseite zeigte zwei technische Waende ("PHASE 1 ·
 * FRAGEBOGEN", "PHASE 2 · KUNDENPORTAL"), lange Vorschau- und Promptbloecke —
 * und den Knopf „Fragebogen-Link erstellen“ auch dann noch, wenn der Link
 * laengst existierte und eigentlich KOPIERT werden sollte. Zwei Adressen in
 * der Sprache, eine in der Sache.
 *
 * Das Cockpit dreht das um. Bewiesen wird hier:
 *
 *   1. Der Knopf sagt, was dran ist: ohne Adresse „Kundenlink erstellen“,
 *      mit Adresse „Kundenlink kopieren“ — nie „erstellen“, wenn sie da ist.
 *   2. „Kundenansicht öffnen“ ist ohne Kundenlink deaktiviert, nicht tot.
 *   3. Der Vorschau-Link: exakte Beschriftung, HTTPS-Pruefung, Freigabe erst
 *      nach positiver Pruefung — und die Eingabe ueberlebt einen Re-Render.
 *   4. Vier Schritte mit genau einem Status und genau einem aktuellen Schritt.
 *   5. Vier Kacheln, immer alle vier; leere sind deaktiviert, nicht weg.
 *   6. Migration: ein Altprojekt mit bestaetigter Rueckgabe gilt als geprueft.
 *   7. Laufzeit gegen public/flowertech.js: Einfuegen, Pruefen, Freigeben.
 *   8. Mobil stapelbar, Desktop einzeilig.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = (await import(path.join(root, "public/flowertech-workflow-core.js"))).default;

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

const LINK = "https://example.test/fragebogen.html?e=" + "t".repeat(32);
const PREVIEW = "https://vorschau.example.test/lehner/";

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Die Beschriftungen sind exakt die verlangten ───────────────────────
{
  eq(CORE.COCKPIT_LABELS.linkCreate, "Kundenlink erstellen", "der Einstiegsknopf heisst anders");
  eq(CORE.COCKPIT_LABELS.linkCreateHint, "Kundendaten und Vision Room anfragen", "der Hilfetext stimmt nicht");
  eq(CORE.COCKPIT_LABELS.linkCopy, "Kundenlink kopieren", "der Kopierknopf heisst anders");
  eq(CORE.COCKPIT_LABELS.linkOpen, "Kundenlink öffnen", "der Oeffnen-Knopf heisst anders");
  // Wortwoertlich verlangt — der Nutzer sucht genau diese Zeile.
  eq(CORE.COCKPIT_LABELS.pasteLabel, "Vorschau-Link aus dem Claude-Code-Chat einfügen",
    "die Beschriftung der Einfuegezeile stimmt nicht");
  eq(CORE.COCKPIT_LABELS.pasteCheck, "Link prüfen", "die Pruefaktion heisst anders");
  eq(CORE.COCKPIT_LABELS.pasteRelease, "Für Kundschaft freigeben", "die Freigabe heisst anders");
  eq(CORE.COCKPIT_LABELS.customerView, "Kundenansicht öffnen", "die Kundenansicht heisst anders");
  // Die vier Schritte in der verlangten Reihenfolge.
  eq(CORE.COCKPIT_STEPS.map((s) => s.label),
    ["Kundenlink", "Kundschaft antwortet", "Vorschau-Link einfügen", "Kundenansicht freigeben"],
    "die vier Schritte stimmen nicht");
  eq(CORE.COCKPIT_TILES.map((t) => t.label),
    ["Offerte", "Website-Vorschau", "Verwaltung", "AGB & Kunde"],
    "die vier Kacheln stimmen nicht");
}

// ── 2. Ohne Kundenlink: erstellen, und sonst nichts ───────────────────────
{
  const st = CORE.projectCockpitState({ project: { id: "p1" }, area: null, intakeState: null });
  ok(!st.hasLink, "ein Projekt ohne Adresse meldet einen Kundenlink");
  eq(st.link.primary.label, "Kundenlink erstellen", "ohne Adresse steht nicht „erstellen“");
  eq(st.link.hint, "Kundendaten und Vision Room anfragen", "der Hilfetext fehlt");
  eq(st.link.secondary, [], "ohne Adresse gibt es etwas zu öffnen");
  ok(!st.customerView.enabled, "die Kundenansicht ist ohne Kundenlink bedienbar");
  ok(st.customerView.reason, "die deaktivierte Kundenansicht nennt keinen Grund");
  // Alle vier Kacheln sind trotzdem da — nur deaktiviert.
  eq(st.tiles.length, 4, "es stehen nicht vier Kacheln da");
  ok(st.tiles.every((t) => !t.available && t.reason), "eine leere Kachel nennt keinen Grund");
  ok(st.tiles.every((t) => !t.canOpen), "eine Kachel ohne Inhalt laesst sich öffnen");
}

// ── 3. Mit Kundenlink: kopieren — nie mehr „erstellen“ ────────────────────
{
  const st = CORE.projectCockpitState({
    project: { id: "p1" },
    area: { url: LINK, tiles: { terms: { version: "2026-1" } }, stages: [] },
    intakeState: { url: LINK },
  });
  ok(st.hasLink, "die vorhandene Adresse wird nicht erkannt");
  eq(st.link.primary.label, "Kundenlink kopieren", "mit Adresse steht nicht „kopieren“");
  ok(!/erstellen/i.test(JSON.stringify(st.link)), "die Aktionsleiste sagt weiter „erstellen“");
  eq(st.link.secondary[0].label, "Kundenlink öffnen", "der sekundäre Weg fehlt");
  ok(st.customerView.enabled, "die Kundenansicht bleibt trotz Kundenlink gesperrt");
  // Die AGB-Kachel haengt an keiner Freigabe: Sie ist da, sobald es den Link gibt.
  const terms = st.tiles.find((t) => t.key === "terms");
  ok(terms.available, "die AGB-Kachel fehlt trotz Kundenlink");
  ok(terms.canOpen && terms.url === LINK, "die AGB-Kachel zeigt nicht auf den Kundenlink");
}

// ── 4. Eine Adresse, die waechst — statt zweier konkurrierender Links ─────
{
  const st = CORE.projectCockpitState({ project: { id: "p1" }, area: { url: LINK, tiles: {}, stages: [] } });
  ok(/zuerst Fragebogen/.test(st.linkStory) && /später/.test(st.linkStory),
    "die wachsende Adresse wird nicht erklärt");
  ok(/Offerte/.test(st.linkStory) && /Vorschau/.test(st.linkStory) && /AGB/.test(st.linkStory),
    "die Erklärung nennt nicht, worum die Adresse wächst");
  ok(!/Kundenportal/.test(st.linkStory), "die alte Zwei-Link-Sprache steht wieder da");
}

// ── 5. Der Vorschau-Link: einfügen, prüfen, freigeben ─────────────────────
{
  const leer = CORE.previewLinkDraft({ project: {} });
  eq(leer.status, "empty", "ein leeres Feld meldet einen Zustand");
  ok(!leer.canCheck && !leer.canRelease, "ohne Adresse lässt sich prüfen oder freigeben");

  // Eingefügt, aber Unsinn: sichtbar bleiben, nicht stillschweigend schlucken.
  const falsch = CORE.previewLinkDraft({ project: { ftClaudeHandoff: { returnedUrl: "vorschau.example.test" } } });
  eq(falsch.status, "invalid", "eine unvollständige Adresse gilt als gültig");
  eq(falsch.entered, "vorschau.example.test", "die Fehleingabe verschwindet aus der Anzeige");
  ok(!falsch.valid && !falsch.canCheck && !falsch.canRelease, "eine ungültige Adresse ist freigebbar");
  // Auch http:// ist keine gültige Adresse.
  ok(!CORE.previewLinkDraft({ project: { ftClaudeHandoff: { returnedUrl: "http://x.example.test/" } } }).valid,
    "http:// gilt als gültige Vorschau-Adresse");

  const eingefuegt = CORE.previewLinkDraft({ project: { ftClaudeHandoff: { returnedUrl: PREVIEW } } });
  eq(eingefuegt.status, "pasted", "die eingefügte Adresse hat den falschen Zustand");
  ok(eingefuegt.canCheck, "die eingefügte Adresse lässt sich nicht prüfen");
  ok(!eingefuegt.canRelease, "eine ungeprüfte Adresse ist freigebbar — die Prüfung wäre wirkungslos");

  const geprueft = CORE.previewLinkDraft({
    project: { ftClaudeHandoff: { returnedUrl: PREVIEW, checkedAt: "2026-08-11T10:00:00.000Z" } },
  });
  eq(geprueft.status, "checked", "die geprüfte Adresse hat den falschen Zustand");
  ok(geprueft.canRelease, "nach der Prüfung lässt sich nicht freigeben");

  const frei = CORE.previewLinkDraft({
    project: {
      ftClaudeHandoff: { returnedUrl: PREVIEW, checkedAt: "2026-08-11T10:00:00.000Z" },
      previewUrl: PREVIEW,
      ftCustomerPreview: { released: true, releasedAt: "2026-08-11T11:00:00.000Z" },
    },
  });
  eq(frei.status, "released", "die freigegebene Adresse hat den falschen Zustand");
  ok(!frei.canRelease, "eine freigegebene Adresse lässt sich erneut freigeben");
  ok(frei.applied, "die freigegebene Adresse steht nicht als Vorschau am Projekt");
}

// ── 6. Migration: Altprojekte gelten als geprüft ──────────────────────────
{
  /* Vor dem Cockpit gab es kein `checkedAt`. Ein Projekt mit bestätigter
     Rückgabe war immer schon geprüft — ohne diese Migration stünde ein längst
     freigegebenes Projekt plötzlich wieder auf „ungeprüft“. */
  const alt = CORE.previewLinkDraft({
    project: {
      ftClaudeHandoff: { returnedUrl: PREVIEW, returnedAt: "2026-07-01T10:00:00.000Z", confirmedAt: "2026-07-01T11:00:00.000Z" },
      previewUrl: PREVIEW,
    },
  });
  ok(alt.checked, "ein Altprojekt mit bestätigter Rückgabe gilt als ungeprüft");
  ok(alt.canRelease, "ein Altprojekt lässt sich nicht mehr freigeben");
  eq(alt.checkedAt, "2026-07-01T11:00:00.000Z", "der Prüfzeitpunkt wird nicht aus der Bestätigung übernommen");
}

// ── 7. Vier Schritte, genau ein aktueller ─────────────────────────────────
{
  const ohne = CORE.projectCockpitState({ project: { id: "p1" } });
  eq(ohne.steps.map((s) => s.status), ["todo", "blocked", "todo", "blocked"], "die Startzustände stimmen nicht");
  eq(ohne.steps.filter((s) => s.current).length, 1, "es ist nicht genau ein Schritt der aktuelle");
  eq(ohne.steps.find((s) => s.current).key, "link", "der erste Schritt ist nicht der aktuelle");
  ok(ohne.steps.every((s) => s.statusLabel), "ein Schritt hat keinen lesbaren Status");

  const mitLink = CORE.projectCockpitState({
    project: { id: "p1" }, area: { url: LINK, tiles: {}, stages: [] }, intakeState: { url: LINK },
  });
  eq(mitLink.steps[0].status, "done", "der Kundenlink gilt nicht als erledigt");
  eq(mitLink.steps[1].status, "waiting", "die offene Antwort wird nicht als Warten geführt");
  eq(mitLink.steps.find((s) => s.current).key, "answer", "der aktuelle Schritt springt nicht weiter");

  const fertig = CORE.projectCockpitState({
    project: {
      id: "p1",
      ftClaudeHandoff: { returnedUrl: PREVIEW, checkedAt: "2026-08-11T10:00:00.000Z" },
      previewUrl: PREVIEW,
      ftCustomerPreview: { released: true, releasedAt: "2026-08-11T11:00:00.000Z" },
    },
    area: { url: LINK, tiles: {}, stages: [] },
    intakeState: { url: LINK, answeredAt: "2026-08-10T10:00:00.000Z" },
  });
  eq(fertig.steps.map((s) => s.status), ["done", "done", "done", "done"], "der fertige Ablauf ist nicht erledigt");
  eq(fertig.steps.filter((s) => s.current).length, 0, "im fertigen Ablauf ist noch ein Schritt offen");
}

// ── 8. Kacheln: Kosten dürfen ausdrücklich offen sein ─────────────────────
{
  const st = CORE.projectCockpitState({
    project: { id: "p1" },
    area: {
      url: LINK,
      tiles: { offer: { label: "Offerte", amount: null }, terms: { version: "1" } },
      stages: [{ key: "offer", reason: "" }],
    },
    intakeState: { url: LINK },
  });
  const offer = st.tiles.find((t) => t.key === "offer");
  ok(offer.available, "die versendete Offerte erscheint nicht");
  eq(offer.note, "Kosten noch offen", "ein offener Preis wird nicht als solcher benannt");

  const mitPreis = CORE.projectCockpitState({
    project: { id: "p1" },
    area: { url: LINK, tiles: { offer: { label: "Offerte", amount: 4500 } }, stages: [] },
    intakeState: { url: LINK },
  });
  eq(mitPreis.tiles.find((t) => t.key === "offer").note, "", "bei bekanntem Preis steht „Kosten noch offen“");
}

// ── 9. Kacheln nennen den Grund, wenn sie leer sind ───────────────────────
{
  const st = CORE.projectCockpitState({
    project: { id: "p1" },
    area: {
      url: LINK, tiles: {},
      stages: [
        { key: "preview", reason: "Die Vorschau ist bereit, aber noch nicht freigegeben." },
        { key: "admin", reason: "Die Verwaltung erscheint erst mit der freigegebenen Vorschau." },
      ],
    },
    intakeState: { url: LINK },
  });
  eq(st.tiles.find((t) => t.key === "preview").reason,
    "Die Vorschau ist bereit, aber noch nicht freigegeben.", "die Vorschau-Kachel nennt den Grund nicht");
  eq(st.tiles.find((t) => t.key === "admin").reason,
    "Die Verwaltung erscheint erst mit der freigegebenen Vorschau.", "die Verwaltungs-Kachel nennt den Grund nicht");
  // Und keine der beiden laesst sich oeffnen — ein aktiver Knopf wuerde eine
  // Freigabe behaupten, die es nicht gibt.
  ok(st.tiles.filter((t) => !t.available).every((t) => !t.canOpen),
    "eine nicht freigegebene Kachel lässt sich öffnen");
}

/* ══ Teil 2 — Die echte Laufzeit ═══════════════════════════════════════════ */

let seed = 1;
function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  const written = {};
  const fields = {};
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/projects/prj_lehner", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    open: (url) => { win.__opened.push(url); },
    __written: written, __toasts: [], __copied: [], __opened: [], __fields: fields,
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1) + "_" + (seed++);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (seed++),
    nowIso: () => "2026-08-11T10:00:00.000Z",
    todayYmd: () => "2026-08-11",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    confirm: () => true, prompt: () => "",
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      // Das Eingabefeld des Cockpits — echte Werte, damit „Link prüfen“
      // wirklich etwas zu lesen hat.
      getElementById: (id) => (Object.prototype.hasOwnProperty.call(fields, id) ? fields[id] : null),
      querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {}, focus() {}, select() {} }),
      body: { appendChild() {}, removeChild() {}, classList: { toggle() {}, remove() {} } },
      execCommand: () => true,
    },
    location: win.location,
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: { clipboard: { writeText: (t) => { win.__copied.push(t); return Promise.resolve(); } } },
    confirm: () => true,
    APP: win.APP,
    firebase: {
      app: () => ({ database: () => ({ ref: (p) => ({
        set: (v) => { written[p] = v; return Promise.resolve(); },
        remove: () => { delete written[p]; return Promise.resolve(); },
      }) }) }),
    },
  };
  sandbox.globalThis = sandbox;
  win.document = sandbox.document;
  win.firebase = sandbox.firebase;
  win.navigator = sandbox.navigator;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  data.entities.projects.prj_lehner = {
    id: "prj_lehner", title: "Lehner – Testprojekt Website", projectType: "flowertech",
    pipelineStage: "lead", client: {}, createdAt: "2026-07-01T10:00:00.000Z",
  };
  return { win, data, written, fields };
}
const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const panelOf = (win) => strip(win.ftProjectPanel("prj_lehner"));

// ── 10. Ohne Adresse: genau ein Einstieg, kein zweiter Knopf ──────────────
{
  const { win } = makeSandbox();
  const html = panelOf(win);
  ok(/<section class="ft-cockpit">/.test(html), "das Cockpit fehlt auf der Projektseite");
  ok(/Kundenlink erstellen/.test(html), "der Einstieg fehlt");
  // Genau EIN Einstieg — der doppelte Knopf war der Kern der Beschwerde.
  eq((html.match(/Kundenlink erstellen/g) || []).length, 1, "„Kundenlink erstellen“ steht mehrfach da");
  ok(!/Fragebogen-Link erstellen/.test(html), "der alte Knopf steht weiterhin daneben");
  ok(!/Phase 1 · Fragebogen/.test(html) && !/Phase 2 · Kundenportal/.test(html),
    "die technischen Phasenwaende stehen wieder da");
  // Die Einfuegezeile ist von Anfang an sichtbar.
  ok(/Vorschau-Link aus dem Claude-Code-Chat einfügen/.test(html), "die Einfügezeile fehlt");
  ok(/id="ftCkPreview"/.test(html), "es gibt kein Eingabefeld für den Vorschau-Link");
  // Kundenansicht ist deaktiviert, nicht verschwunden.
  ok(/Kundenansicht öffnen/.test(html), "die Kundenansicht fehlt ganz");
  ok(/disabled[^>]*>Kundenansicht öffnen|Kundenansicht öffnen<\/button>/.test(html.replace(/\n/g, "")),
    "die Kundenansicht ist ohne Kundenlink nicht deaktiviert");
}

// ── 11. Mit Adresse: kopieren statt erstellen, und wirklich kopiert ───────
{
  const { win } = makeSandbox();
  win._ftCreateProjectIntakeLink("prj_lehner");
  const html = panelOf(win);
  ok(/Kundenlink kopieren/.test(html), "mit Adresse fehlt der Kopierknopf");
  ok(!/Kundenlink erstellen/.test(html), "mit Adresse steht weiter „erstellen“ da");
  ok(/Kundenlink öffnen/.test(html), "der sekundäre Weg fehlt");

  win.__copied.length = 0;
  win._ftCopyProjectIntakeLink("prj_lehner");
  eq(win.__copied.length, 1, "es wurde nichts in die Zwischenablage gelegt");
  ok(/fragebogen\.html\?e=/.test(win.__copied[0]), `kopiert wurde die falsche Adresse: ${win.__copied[0]}`);
  // Und der Nutzer erfaehrt es.
  ok(win.__toasts.some((t) => t.type === "ok"), "das Kopieren wird nicht bestätigt");
}

// ── 12. Vorschau-Link: einfügen, prüfen, freigeben ────────────────────────
{
  const { win, data, fields } = makeSandbox();
  win._ftCreateProjectIntakeLink("prj_lehner");
  const project = data.entities.projects.prj_lehner;

  // (a) Unsinn wird abgewiesen — und bleibt trotzdem sichtbar stehen.
  fields.ftCkPreview = { value: "vorschau.example.test" };
  ok(win._ftCockpitCheckPreview("prj_lehner") === false, "eine unvollständige Adresse gilt als geprüft");
  eq(project.ftClaudeHandoff.returnedUrl, "vorschau.example.test", "die Fehleingabe wurde verworfen");
  ok(!project.ftClaudeHandoff.checkedAt, "die Fehleingabe gilt als geprüft");
  ok(win.__toasts.some((t) => t.type === "warn"), "die Fehleingabe wird nicht gemeldet");
  // Sie steht auch nach dem Neuzeichnen noch da.
  ok(panelOf(win).includes("vorschau.example.test"), "die Fehleingabe verschwindet beim Neuzeichnen");

  // (b) Die echte Adresse aus dem Claude-Code-Chat.
  fields.ftCkPreview = { value: PREVIEW };
  ok(win._ftCockpitCheckPreview("prj_lehner") === true, "die gültige Adresse wurde nicht angenommen");
  eq(project.ftClaudeHandoff.returnedUrl, PREVIEW, "die Adresse wurde nicht projektbezogen gespeichert");
  ok(project.ftClaudeHandoff.checkedAt, "die Prüfung wurde nicht vermerkt");
  // Geprüft heisst noch nicht freigegeben.
  ok(!project.previewUrl, "die Prüfung hat die Adresse ungefragt zur Vorschau gemacht");
  const nachPruefung = panelOf(win);
  ok(nachPruefung.includes(PREVIEW), "die geprüfte Adresse steht nicht im Feld");
  ok(/Für Kundschaft freigeben/.test(nachPruefung), "die Freigabe wird nicht angeboten");

  // (c) Ohne projektspezifischen Prompt bleibt die bestehende Schutzregel
  //     bestehen — das Cockpit umgeht sie nicht, sondern nennt den Grund.
  ok(win._ftCockpitReleasePreview("prj_lehner") === false,
    "die Freigabe umgeht die Prompt-Schutzregel");
  ok(win.__toasts.some((t) => t.type === "warn" && /Prompt/i.test(t.message || "")),
    "der Grund für die verweigerte Freigabe wird nicht genannt");

  // (d) Mit Prompt: freigeben — jetzt sieht die Kundschaft sie.
  project.ftPrompt = { text: "Projektspezifischer Prompt für Lehner", source: "generiert" };
  ok(win._ftCockpitReleasePreview("prj_lehner") === true, "die Freigabe schlug fehl");
  eq(project.previewUrl, PREVIEW, "die freigegebene Adresse steht nicht als Vorschau am Projekt");
  ok(project.ftClaudeHandoff.confirmedAt, "die Rückgabe wurde nicht bestätigt");
  ok(project.ftCustomerPreview && project.ftCustomerPreview.released,
    "die Vorschau-Kachel wurde nicht freigegeben");
  const frei = panelOf(win);
  ok(/Website-Vorschau/.test(frei), "die Vorschau-Kachel fehlt");
}

// ── 13. Ohne Prüfung keine Freigabe ───────────────────────────────────────
{
  const { win, data, fields } = makeSandbox();
  win._ftCreateProjectIntakeLink("prj_lehner");
  fields.ftCkPreview = { value: PREVIEW };
  win._ftCockpitStorePreview("prj_lehner", PREVIEW);
  ok(win._ftCockpitReleasePreview("prj_lehner") === false,
    "eine ungeprüfte Adresse liess sich freigeben — die Prüfung wäre wirkungslos");
  ok(!data.entities.projects.prj_lehner.previewUrl, "die ungeprüfte Adresse wurde zur Vorschau");
}

// ── 14. Kundenansicht öffnet genau den Kundenlink ─────────────────────────
{
  const { win } = makeSandbox();
  ok(win._ftCockpitOpenCustomerView("prj_lehner") === false, "ohne Kundenlink öffnet die Kundenansicht etwas");
  win._ftCreateProjectIntakeLink("prj_lehner");
  ok(win._ftCockpitOpenCustomerView("prj_lehner") === true, "mit Kundenlink öffnet die Kundenansicht nichts");
  eq(win.__opened.length, 1, "es wurde nicht genau ein Fenster geöffnet");
  ok(/fragebogen\.html\?e=/.test(win.__opened[0]), `geöffnet wurde die falsche Adresse: ${win.__opened[0]}`);
}

// ── 15. Vier Kacheln und vier Schritte stehen wirklich da ─────────────────
{
  const { win } = makeSandbox();
  win._ftCreateProjectIntakeLink("prj_lehner");
  const html = panelOf(win);
  // `&` steht im Markup korrekt als `&amp;` — genau so soll es sein.
  for (const label of ["Offerte", "Website-Vorschau", "Verwaltung", "AGB &amp; Kunde"]) {
    ok(html.includes(label), `die Kachel „${label}“ fehlt`);
  }
  ok(!html.includes("AGB & Kunde"), "der Kachelname ist nicht HTML-escaped");
  for (const label of ["Kundenlink", "Kundschaft antwortet", "Vorschau-Link einfügen", "Kundenansicht freigeben"]) {
    ok(html.includes(label), `der Schritt „${label}“ fehlt`);
  }
  // Genau vier — `data-tile`/`<li` sind je Kachel bzw. Schritt einmalig.
  eq((html.match(/data-tile="/g) || []).length, 4, "es stehen nicht genau vier Kacheln da");
  eq((html.match(/<li class="ft-ck-step/g) || []).length, 4, "es stehen nicht genau vier Schritte da");
}

// ── 16. Interne Blöcke sind eingeklappt ───────────────────────────────────
{
  const { win } = makeSandbox();
  const html = panelOf(win);
  ok(/<details class="ft-more"/.test(html), "der interne Bereich ist nicht eingeklappt");
  ok(!/<details class="ft-more" open/.test(html), "der interne Bereich ist standardmäßig offen");
  const vorDetails = html.slice(0, html.indexOf('<details class="ft-more"'));
  // Der erste sichtbare Bereich bleibt der Weg — keine Promptwände davor.
  ok(!/Claude-Code-Prompt/.test(vorDetails), "der Promptblock steht wieder im ersten Bereich");
  ok(vorDetails.includes("Vorschau-Link aus dem Claude-Code-Chat einfügen"),
    "die Einfügezeile steht nicht im ersten Bereich");
}

// ── 17. Mobil stapelbar, Desktop einzeilig ────────────────────────────────
{
  const { win } = makeSandbox();
  const css = win.ftProjectPanel("prj_lehner");
  ok(/\.ft-ck-tiles\{[^}]*grid-template-columns:repeat\(4,1fr\)/.test(css),
    "die vier Kacheln stehen auf dem Desktop nicht in einer Zeile");
  ok(/\.ft-ck-steps\{[^}]*grid-template-columns:repeat\(4,1fr\)/.test(css),
    "die vier Schritte stehen auf dem Desktop nicht in einer Zeile");
  const eng = css.replace(/\s+/g, "");
  ok(/@media\(max-width:620px\)\{[\s\S]{0,200}?\.ft-ck-tiles\{grid-template-columns:1fr\}/.test(eng),
    "die Kacheln stapeln sich auf schmalen Fenstern nicht");
  ok(/@media\(max-width:620px\)\{[\s\S]{0,200}?\.ft-ck-steps\{grid-template-columns:1fr\}/.test(eng),
    "die Schritte stapeln sich auf schmalen Fenstern nicht");
  ok(/@media\(max-width:900px\)/.test(css), "es fehlt der Zwischenschritt für Tablets");
}

console.log(`flowertech projekt-cockpit: ok (${checks} Pruefungen)`);
