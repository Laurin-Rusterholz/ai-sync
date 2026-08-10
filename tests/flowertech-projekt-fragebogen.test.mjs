/*
 * FlowerTech — der Fragebogen-Link gehört ins PROJEKT.
 * ---------------------------------------------------------------------------
 * Der Befund: In der FlowerTech-Karte einer Quantus-Projektseite stand allein
 * der Kundenportal-Link. Ein Projekt wie „Lehner“, das ohne Fragebogen
 * entstanden ist, hatte gar keinen Fragebogen-Link — wer Kundendaten einholen
 * wollte, griff zum einzigen sichtbaren Link, dem der Phase 2. Genau diese
 * Verwechslung schliesst dieser Test aus.
 *
 * Bewiesen wird:
 *
 *   1. Der Kern kennt den projektgebundenen Fragebogen-Link (Zustände,
 *      Beschriftungen, Trennung von kunde.html).
 *   2. Eine Antwort auf einen gebundenen Fragebogen ERGÄNZT das Projekt —
 *      Gepflegtes bleibt stehen, der Vision Room wird nachgeführt.
 *   3. Laufzeit: Projekt ohne Link → „Fragebogen-Link erstellen“ → sofort
 *      Kopieren/Öffnen. Kein zweites Projekt, keine Aufgabe, kein Portal.
 *   4. Reload und Doppelaufruf: derselbe Fragebogen, derselbe Token.
 *   5. Die Antwort auf den gebundenen Fragebogen erzeugt KEIN zweites Projekt
 *      und höchstens EINE Aufgabe „Offertenanfrage“ — auch beim zweiten Eingang.
 *   6. Der Weg über eine Offerte OHNE Projekt bleibt unverändert: genau ein
 *      Projekt, genau eine Aufgabe, dieselbe Offerte zugeordnet.
 *   7. Link-Trennung: Fragebogen-Link (fragebogen.html) und Kundenportal-Link
 *      (kunde.html) stehen getrennt beschriftet nebeneinander; der Portal-Link
 *      erscheint weiterhin erst nach ausdrücklicher Veröffentlichung.
 *   8. Der veröffentlichte Fragebogen trägt nie Vorschau, Vertrag, AGB, Kosten
 *      oder Kundenportal.
 *
 * Der Laufzeitteil lädt public/flowertech.js wirklich und ruft die echten
 * Funktionen auf.
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

const TOKEN = "p".repeat(32);

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Die Beschriftungen trennen die zwei Phasen ─────────────────────────
{
  ok(CORE.LINK_LABELS.intakeFull === "Fragebogen-Link – Kundendaten & Vision Room, keine Vorschau",
    `die vollständige Beschriftung stimmt nicht: ${CORE.LINK_LABELS.intakeFull}`);
  ok(/keine Vorschau/.test(CORE.LINK_LABELS.intakeFull),
    "die Beschriftung sagt nicht, dass es keine Vorschau gibt");
  ok(!/Kundenportal/.test(CORE.LINK_LABELS.intakeFull),
    "die Beschriftung des Fragebogen-Links nennt das Kundenportal");
  ok(CORE.LINK_LABELS.intakeOpen === "Fragebogen öffnen", "der Öffnen-Knopf ist nicht benannt");
  ok(/Fragebogen-Link kopiert/.test(CORE.LINK_LABELS.intakeCopied),
    "der Erfolgshinweis beim Kopieren nennt den Link nicht");
  ok(/Vision Room/.test(CORE.LINK_LABELS.intakeCopied),
    "der Erfolgshinweis sagt nicht, was der kopierte Link zeigt");
}

// ── 2. Die Zustände des projektgebundenen Links ───────────────────────────
{
  const project = { id: "prj_1", title: "Lehner" };

  const neu = CORE.projectIntakeLinkState({ project, intake: null });
  ok(neu.mode === "create", `ohne Fragebogen ist der Zustand nicht „create“: ${neu.mode}`);
  ok(neu.label === CORE.LINK_LABELS.intakeCreate, "der erste Knopf heisst nicht „Fragebogen-Link erstellen“");
  ok(neu.url === "", "ohne Fragebogen entsteht trotzdem ein Link");
  ok(!/kunde\.html/.test(neu.explain), "die Erklärung verweist auf das Kundenportal");

  const offen = CORE.projectIntakeLinkState({ project, intake: { boundProjectId: "prj_1", inviteToken: TOKEN } });
  ok(offen.mode === "copy", `mit Fragebogen ist der Zustand nicht „copy“: ${offen.mode}`);
  ok(offen.url === "https://flowertech.ch/fragebogen.html?e=" + TOKEN,
    `der Link zeigt nicht auf den Fragebogen: ${offen.url}`);
  ok(!offen.url.includes("kunde.html"), "der Fragebogen-Link zeigt auf das Kundenportal");
  ok(offen.copyLabel === CORE.LINK_LABELS.intakeCopy && offen.openLabel === CORE.LINK_LABELS.intakeOpen,
    "Kopieren- und Öffnen-Knopf sind am Zustand nicht benannt");
  ok(/kein zweites Projekt/.test(offen.explain),
    `die Erklärung verspricht nicht, dass kein zweites Projekt entsteht: ${offen.explain}`);

  const beantwortet = CORE.projectIntakeLinkState({
    project, intake: { boundProjectId: "prj_1", inviteToken: TOKEN, answeredAt: "2026-08-08T09:00:00.000Z" },
  });
  ok(beantwortet.mode === "answered", `nach der Antwort ist der Zustand nicht „answered“: ${beantwortet.mode}`);
  ok(beantwortet.url === offen.url, "der Link ändert sich nach der Antwort");

  // Ein unbrauchbarer Token ergibt keinen Link — es wird nichts erfunden.
  ok(CORE.projectIntakeLinkState({ project, intake: { inviteToken: "zu-kurz" } }).mode === "create",
    "ein unbrauchbarer Einladungstoken ergibt trotzdem einen Link");
  ok(CORE.projectIntakeLinkState({ project: null, intake: null }).mode === "none",
    "ohne Projekt entsteht trotzdem ein projektgebundener Zustand");
}

// ── 3. Die Bindung: gebunden ≠ entstanden ─────────────────────────────────
{
  ok(CORE.intakeBinding({ boundProjectId: "prj_1" }).mode === "bound",
    "ein gebundener Fragebogen wird nicht als gebunden erkannt");
  ok(CORE.intakeBinding({ boundProjectId: "prj_1" }).projectId === "prj_1",
    "die Bindung nennt das Projekt nicht");
  ok(CORE.intakeBinding({ projectId: "prj_2" }).mode === "created",
    "ein Fragebogen, aus dem ein Projekt entstand, gilt nicht als „created“");
  ok(CORE.intakeBinding({}).mode === "creates", "ein freier Fragebogen gilt nicht als „creates“");
  ok(CORE.intakeBinding(null).projectId === "", "aus dem Nichts entsteht eine Bindung");
}

// ── 4. Die Antwort ergänzt — sie überschreibt nicht ───────────────────────
{
  const answers = CORE.normalizeIntakeAnswers(CORE.DEFAULT_INTAKE_QUESTIONS, {
    projekt: "Lehner", company: "Lehner AG", name: "Rita Lehner", email: "rita@lehner.ch",
    phone: "079 000 00 00", adresse: "Dorfstrasse 1, 8000 Zürich",
    need: "Neue Website mit Shop", budget: "12000", deadline: "2026-11-01",
    "bisheriger-preis": "4200", "website-url": "https://alt.lehner.ch", anbieter: "Alte Agentur",
    "vision-idee": "Kundschaft bestellt direkt online",
    "vision-funktionen": "Warenkorb\nOnline-Zahlung",
  }).answers;

  const leer = CORE.intakeUpdateForProject({
    project: { id: "prj_1", title: "Lehner", client: {}, pipelineStage: "lead" }, answers,
    now: "2026-08-08T10:00:00.000Z",
  });
  ok(leer.client.company === "Lehner AG" && leer.client.email === "rita@lehner.ch",
    "leere Kundendaten werden nicht ergänzt");
  ok(leer.patch.budget === 12000, `das Budget wird nicht übernommen: ${leer.patch.budget}`);
  ok(leer.patch.dueDate === "2026-11-01", "der Wunschtermin wird nicht übernommen");
  ok(leer.patch.currentProviderPrice === 4200, "der bisherige Preis wird nicht übernommen");
  ok(leer.patch.ftCurrentUrl === "https://alt.lehner.ch", "die bisherige Website wird nicht übernommen");
  ok(leer.patch.pipelineStage === "intake",
    "die Phase bleibt bei „lead“, obwohl die Bestandesaufnahme erfolgt ist");
  ok(leer.patch.ftVision && leer.patch.ftVision.features.includes("Warenkorb"),
    "der Vision Room landet nicht am Projekt");
  ok(leer.patch.ftVision.source === "fragebogen", "der Vision Room bekommt eine falsche Quelle");

  // Gepflegtes bleibt stehen — eine späte Antwort wischt keine Arbeit weg.
  const gepflegt = CORE.intakeUpdateForProject({
    project: {
      id: "prj_1", title: "Lehner", pipelineStage: "build", budget: 30000, dueDate: "2026-09-01",
      client: { company: "Lehner GmbH", email: "buchhaltung@lehner.ch" },
    },
    answers, now: "2026-08-08T10:00:00.000Z",
  });
  ok(gepflegt.client.company === undefined, "eine gepflegte Firma wird überschrieben");
  ok(gepflegt.client.email === undefined, "eine gepflegte E-Mail wird überschrieben");
  ok(gepflegt.client.name === "Rita Lehner", "eine fehlende Ansprechperson wird nicht ergänzt");
  ok(gepflegt.patch.budget === undefined, "ein gepflegtes Budget wird überschrieben");
  ok(gepflegt.patch.dueDate === undefined, "ein gepflegter Termin wird überschrieben");
  ok(gepflegt.patch.pipelineStage === undefined, "eine fortgeschrittene Phase wird zurückgedreht");
  ok(gepflegt.kept.includes("Firma") && gepflegt.kept.includes("Budget"),
    "das Übernommene/Behaltene wird nicht benannt");
  ok(gepflegt.filled.includes("Ansprechperson"), "das Ergänzte wird nicht benannt");
  // Der Vision Room ist die jüngste Aussage der Kundschaft und wird nachgeführt.
  ok(gepflegt.patch.ftVision && gepflegt.patch.ftVision.idea.includes("bestellt"),
    "der Vision Room wird am bestehenden Projekt nicht nachgeführt");
}

/* ══ Teil 2 — Laufzeit ════════════════════════════════════════════════════ */

let seed = 0;
function makeSandbox(seedData = null) {
  const data = seedData || { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  data.entities = data.entities || { projects: {}, tasks: {}, notes: {} };
  const written = {};
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __written: written, __toasts: [], __copied: [],
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1) + "_" + (seed++);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (seed++),
    nowIso: () => "2026-08-08T10:00:00.000Z",
    todayYmd: () => "2026-08-08",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    confirm: () => true, prompt: () => "",
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      getElementById: () => null,
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
  return { win, data, written };
}

const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const intakeTasks = (data) => Object.values(data.entities.tasks).filter((t) => t.source === "flowertech-intake");
const panelOf = (win, projectId) => strip(win.ftProjectPanel(projectId));

/* Ein bestehendes Projekt, wie „Lehner“: von Hand angelegt, ohne Fragebogen. */
function projektLehner(data, extra = {}) {
  data.entities.projects.prj_lehner = Object.assign({
    id: "prj_lehner", title: "Lehner", projectType: "flowertech",
    pipelineStage: "lead", client: {}, createdAt: "2026-07-01T10:00:00.000Z",
  }, extra);
  return data.entities.projects.prj_lehner;
}

/* Alle Pflichtfragen beantwortet — sonst prüft der Test die Pflichtprüfung. */
const vollstaendig = (win, intakeId, overrides = {}) => {
  const intake = win.APP.state.data.flowertech.intakes[intakeId];
  const values = {};
  intake.questions.forEach((q) => {
    values[q.key] = q.type === "date" ? "2026-10-01"
      : q.type === "email" ? "rita@lehner.ch"
      : q.type === "select" ? (q.options || [""])[0]
      : "Antwort " + q.key;
  });
  return CORE.normalizeIntakeAnswers(intake.questions, Object.assign(values, overrides)).answers;
};

// ── 5. Projekt ohne Link: der Knopf „Fragebogen-Link erstellen“ ───────────
{
  const { win, data } = makeSandbox();
  projektLehner(data);

  const html = panelOf(win, "prj_lehner");
  ok(/Fragebogen-Link erstellen/.test(html),
    "die FlowerTech-Karte von „Lehner“ bietet keinen Fragebogen-Link an");
  ok(/_ftCreateProjectIntakeLink\('prj_lehner'\)/.test(html), "der Knopf ist nicht verdrahtet");
  ok(/Kundendaten &amp; Vision Room, keine Vorschau/.test(html),
    "die Karte sagt nicht, was der Fragebogen-Link zeigt");
  // Der zweite Link bleibt, was er war: unveröffentlicht und getrennt benannt.
  ok(/Kundenportal – noch nicht veröffentlicht/.test(html),
    "der Kundenportal-Link ist ohne Veröffentlichung nicht als solcher gekennzeichnet");
  ok(!/kunde\.html/.test(html), "ohne Veröffentlichung steht ein Kundenportal-Link in der Karte");
  ok(/Phase 1 · Fragebogen/.test(html) && /Phase 2 · Kundenportal/.test(html),
    "die zwei Phasen sind in der Karte nicht getrennt beschriftet");

  // Der Knopf allein legt nichts an.
  ok(Object.keys(data.flowertech.intakes || {}).length === 0,
    "das blosse Anzeigen der Karte legt einen Fragebogen an");
}

// ── 6. Erstellen: genau ein Fragebogen, sofort kopier- und öffenbar ───────
{
  const { win, data, written } = makeSandbox();
  projektLehner(data);

  win._ftCreateProjectIntakeLink("prj_lehner");
  const ids = Object.keys(data.flowertech.intakes);
  ok(ids.length === 1, `es entstanden ${ids.length} Fragebögen statt genau eines`);
  const intake = data.flowertech.intakes[ids[0]];
  ok(intake.boundProjectId === "prj_lehner", "der Fragebogen hängt nicht an diesem Projekt");
  ok(!intake.projectId, "der neue Fragebogen behauptet, aus ihm sei ein Projekt entstanden");
  ok(CORE.isShareToken(intake.inviteToken), "der Fragebogen hat keinen brauchbaren Einladungstoken");

  // Weder Projekt noch Aufgabe noch Kundenportal — der Link erzeugt nichts.
  ok(Object.keys(data.entities.projects).length === 1, "der Fragebogen-Link legt ein zweites Projekt an");
  ok(Object.keys(data.entities.tasks).length === 0, "der Fragebogen-Link legt eine Aufgabe an");
  ok(!Object.keys(written).some((k) => k.startsWith("flowertech/clientPortals/")),
    "der Fragebogen-Link veröffentlicht ein Kundenportal");

  // Der veröffentlichte Fragebogen trägt nichts aus Phase 2.
  const pfad = "flowertech/intakeForms/" + intake.inviteToken;
  ok(written[pfad], "der Fragebogen wurde nicht veröffentlicht");
  const veroeffentlicht = JSON.stringify(written[pfad]);
  ok(written[pfad].status === "open", "der frische Fragebogen ist nicht offen");
  ok(!veroeffentlicht.includes("prj_lehner"), "die Projekt-ID steht im öffentlichen Fragebogen");
  ok(!veroeffentlicht.includes(intake.id), "die interne Fragebogen-ID steht im öffentlichen Fragebogen");
  // Positivliste: veröffentlicht wird ausschliesslich, was die Kundschaft zum
  // Ausfüllen braucht. Alles aus Phase 2 hat hier nichts verloren.
  // „generation" ist die Fassung des Fragebogens — eine blosse Zahl, damit der
  // Eingang eine Antwort nach einem Zurücksetzen nicht für eine Wiederholung
  // der alten hält. „stage" und „tiles" tragen den mitwachsenden Kundenbereich;
  // auf Stufe 1 sind alle Kacheln leer. Nichts davon ist intern.
  const erlaubt = ["schema", "title", "intro", "questions", "status", "company", "generation",
    "stage", "tiles", "updatedAt"];
  Object.keys(written[pfad]).forEach((key) => {
    ok(erlaubt.includes(key), `der öffentliche Fragebogen trägt das Feld „${key}“`);
  });
  // Stufe 1 heisst Stufe 1: keine Offerte, keine Vorschau, keine Verwaltung.
  ok(written[pfad].stage === "intake", `der frische Fragebogen steht auf Stufe „${written[pfad].stage}“`);
  ok(!written[pfad].tiles.offer && !written[pfad].tiles.preview && !written[pfad].tiles.admin,
    "auf Stufe 1 steht bereits eine Kachel im Kundenbereich");
  ok(!/kunde\.html|portalToken|previewUrl|adminUrl|ftTemplate|ftContract|termsConsent/.test(veroeffentlicht),
    "der öffentliche Fragebogen trägt Vorschau, Vertrag, AGB oder Kundenportal");
  // Der Vision Room gehört dazu — als zwei ganz normale Fragen dieses Bogens.
  ok(written[pfad].questions.some((q) => q.vision === "idea")
    && written[pfad].questions.some((q) => q.vision === "features"),
    "der Vision Room fehlt im veröffentlichten Fragebogen");

  // Danach: Kopieren und Öffnen, beides eindeutig beschriftet.
  const link = CORE.intakeFormUrl(intake.inviteToken);
  const html = panelOf(win, "prj_lehner");
  ok(html.includes(link), "der Fragebogen-Link steht nicht in der Karte");
  ok(link.startsWith("https://flowertech.ch/fragebogen.html?e="),
    `der Link zeigt nicht auf den Fragebogen: ${link}`);
  ok(/Fragebogen-Link kopieren/.test(html), "der Kopieren-Knopf fehlt");
  ok(/_ftCopyProjectIntakeLink\('prj_lehner'\)/.test(html), "der Kopieren-Knopf ist nicht verdrahtet");
  ok(/Fragebogen öffnen/.test(html), "der Öffnen-Knopf fehlt");
  ok(new RegExp('href="' + link.replace(/[?]/g, "\\?") + '" target="_blank"').test(html),
    "der Öffnen-Knopf zeigt nicht auf den Fragebogen-Link");
  ok(!/Fragebogen-Link erstellen/.test(html), "der Erstellen-Knopf steht weiterhin da");

  // Der Erfolgshinweis beim Kopieren nennt den Link beim Namen.
  win._ftCopyProjectIntakeLink("prj_lehner");
  ok(win.__copied[win.__copied.length - 1] === link, "kopiert wurde nicht der Fragebogen-Link");
  // Die Zwischenablage antwortet über ein Promise — der Hinweis kommt danach.
  await new Promise((resolve) => setImmediate(resolve));
  const hinweis = win.__toasts[win.__toasts.length - 1];
  ok(hinweis && hinweis.type === "ok", "das Kopieren meldet keinen Erfolg");
  ok(/Fragebogen-Link kopiert/.test(hinweis.message),
    `der Erfolgshinweis ist nicht verständlich: ${hinweis && hinweis.message}`);
  ok(!/Kundenportal/.test(hinweis.message), "der Erfolgshinweis nennt das Kundenportal");
}

// ── 7. Reload und Doppelaufruf: derselbe Fragebogen, derselbe Token ───────
{
  const { win, data } = makeSandbox();
  projektLehner(data);
  win._ftCreateProjectIntakeLink("prj_lehner");
  const intake = Object.values(data.flowertech.intakes)[0];

  win._ftCreateProjectIntakeLink("prj_lehner");
  win._ftCreateProjectIntakeLink("prj_lehner");
  ok(Object.keys(data.flowertech.intakes).length === 1,
    "ein zweiter Klick erzeugt einen zweiten Fragebogen");
  ok(Object.values(data.flowertech.intakes)[0].inviteToken === intake.inviteToken,
    "ein zweiter Klick erneuert den Token und macht den verschickten Link ungültig");

  // Reload: derselbe Datenstand, frisch geladene App.
  const nachReload = makeSandbox(JSON.parse(JSON.stringify(data)));
  const html = panelOf(nachReload.win, "prj_lehner");
  ok(!/Fragebogen-Link erstellen/.test(html), "nach dem Reload steht wieder der Erstellen-Knopf da");
  ok(html.includes(CORE.intakeFormUrl(intake.inviteToken)),
    "nach dem Reload fehlt der Fragebogen-Link in der Karte");
  ok(/Fragebogen-Link kopieren/.test(html) && /Fragebogen öffnen/.test(html),
    "nach dem Reload fehlen Kopieren- und Öffnen-Knopf");
  ok(Object.keys(nachReload.data.flowertech.intakes).length === 1,
    "der Reload erzeugt einen zweiten Fragebogen");
}

// ── 8. Die Antwort: KEIN zweites Projekt, genau eine Aufgabe ──────────────
{
  const { win, data, written } = makeSandbox();
  const project = projektLehner(data, { client: { company: "Lehner GmbH" }, budget: 30000 });
  win._ftCreateProjectIntakeLink("prj_lehner");
  const intake = Object.values(data.flowertech.intakes)[0];

  const entry = {
    id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
    payload: {
      intakeTitle: intake.title,
      answers: vollstaendig(win, intake.id, {
        projekt: "Lehner", company: "Lehner AG", name: "Rita Lehner", email: "rita@lehner.ch",
        need: "Neue Website mit Shop",
        "vision-idee": "Kundschaft bestellt direkt online",
        "vision-funktionen": "Warenkorb\nOnline-Zahlung",
      }),
    },
  };

  ok(win._ftIngestSubmissions({ sub_1: entry }) === 1, "der Fragebogen wurde nicht verarbeitet");

  ok(Object.keys(data.entities.projects).length === 1,
    `es gibt jetzt ${Object.keys(data.entities.projects).length} Projekte — die Antwort hat eines angelegt`);
  ok(data.entities.projects.prj_lehner, "das bestehende Projekt ist verschwunden");
  ok(intakeTasks(data).length === 1,
    `es entstanden ${intakeTasks(data).length} Aufgaben statt genau einer`);
  ok(/Offertenanfrage/.test(intakeTasks(data)[0].title),
    `die Aufgabe heisst nicht „Offertenanfrage“: ${intakeTasks(data)[0].title}`);
  ok(intakeTasks(data)[0].projectId === "prj_lehner", "die Aufgabe hängt nicht an diesem Projekt");

  // Das Projekt wurde ergänzt, nicht überschrieben.
  ok(project.ftIntakeDocument, "das Anfrage-Dokument fehlt am Projekt");
  ok(project.client.company === "Lehner GmbH", "die gepflegte Firma wurde überschrieben");
  ok(project.client.name === "Rita Lehner", "die Ansprechperson wurde nicht ergänzt");
  ok(project.client.email === "rita@lehner.ch", "die E-Mail wurde nicht ergänzt");
  ok(project.budget === 30000, "das gepflegte Budget wurde überschrieben");
  ok(project.ftVision && project.ftVision.features.includes("Warenkorb"),
    "der Vision Room steht nicht am Projekt");
  ok(project.pipelineStage === "intake", "die Phase wurde nicht auf die Bestandesaufnahme gesetzt");
  ok((project.ftPrompt || {}).text && project.ftPrompt.text.includes("Warenkorb"),
    "der Vision Room fehlt im Projekt-Prompt");

  // Phase 1 endet hier: kein Kundenportal.
  ok(!Object.keys(written).some((k) => k.startsWith("flowertech/clientPortals/")),
    "die Antwort der Kundschaft veröffentlicht ein Kundenportal");
  ok(win._ftClientPortalLink("prj_lehner") === "",
    "nach dem Fragebogen gibt es bereits einen Kundenportal-Link");

  // Der Fragebogen ist jetzt beantwortet — der Link bleibt derselbe.
  ok(intake.answeredAt === "2026-08-08T09:00:00.000Z", "die Antwortzeit wurde nicht festgehalten");
  ok(intake.projectId === "prj_lehner", "der Fragebogen zeigt nicht auf sein Projekt");
  const html = panelOf(win, "prj_lehner");
  ok(/Fragebogen beantwortet/.test(html), "die Karte zeigt nicht, dass der Fragebogen beantwortet ist");
  ok(html.includes(CORE.intakeFormUrl(intake.inviteToken)), "der Fragebogen-Link fehlt nach der Antwort");

  // ── Reload/Doppelaufruf: nichts davon ein zweites Mal ──────────────────
  win._ftIngestSubmissions({ sub_1: entry });
  win._ftIngestSubmissions({ sub_2: Object.assign({}, entry, { id: "sub_2" }) });
  win._ftApplyIntakeSubmission(intake.id, entry);
  ok(Object.keys(data.entities.projects).length === 1,
    "ein zweiter Eingang erzeugte ein zweites Projekt");
  ok(intakeTasks(data).length === 1, "ein zweiter Eingang erzeugte eine zweite Aufgabe");
}

// ── 9. Aus einer projektlosen Offerte bleibt der Weg unverändert ──────────
{
  const { win, data } = makeSandbox();
  win._ftNewDoc("offer");
  const doc = data.flowertech.offers.find((o) => !o.projectId);
  doc.client = { company: "Beiz AG" };
  doc.items = [{ id: "it_1", description: "Website", qty: 1, unit: "Pauschal", price: 4500, discountPercent: 0 }];

  win._ftCreateOfferIntakeLink(doc.id);
  const intake = Object.values(data.flowertech.intakes)[0];
  ok(intake.offerId === doc.id, "der Fragebogen hängt nicht an dieser Offerte");
  ok(!intake.boundProjectId, "eine projektlose Offerte bindet einen Fragebogen an ein Projekt");

  win._ftIngestSubmissions({
    sub_1: {
      id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
      payload: { intakeTitle: intake.title, answers: vollstaendig(win, intake.id) },
    },
  });

  const projekte = Object.values(data.entities.projects);
  ok(projekte.length === 1, `es entstanden ${projekte.length} Projekte statt genau eines`);
  ok(intakeTasks(data).length === 1, `es entstanden ${intakeTasks(data).length} Aufgaben statt genau einer`);
  ok(data.flowertech.offers.length === 1, "es entstand eine zweite Offerte");
  ok(data.flowertech.offers[0].projectId === projekte[0].id,
    "die bestehende Offerte wurde dem neuen Projekt nicht zugeordnet");

  // Das so entstandene Projekt zeigt genau DIESEN Fragebogen — keinen zweiten.
  const html = panelOf(win, projekte[0].id);
  ok(html.includes(CORE.intakeFormUrl(intake.inviteToken)),
    "das entstandene Projekt zeigt nicht den Fragebogen, aus dem es entstand");
  ok(!/Fragebogen-Link erstellen/.test(html),
    "das entstandene Projekt bietet einen zweiten Fragebogen-Link an");
  ok(Object.keys(data.flowertech.intakes).length === 1,
    "das Anzeigen der Karte legte einen zweiten Fragebogen an");
}

// ── 10. Link-Trennung: zwei Links, zwei Phasen, nie verwechselt ───────────
{
  const { win, data } = makeSandbox();
  projektLehner(data, { pipelineStage: "proposal" });
  win._ftCreateProjectIntakeLink("prj_lehner");
  const intake = Object.values(data.flowertech.intakes)[0];
  const fragebogen = CORE.intakeFormUrl(intake.inviteToken);

  // Ein vollständiges Projekt der Phase 2 — erst dann lässt sich das
  // Kundenportal überhaupt veröffentlichen (die Zweiphasen-Sicherheit bleibt).
  const project = data.entities.projects.prj_lehner;
  project.ftTemplate = { name: "vorschau.html", html: "<html><body>Vorschau</body></html>" };
  data.flowertech.contentDocs = { prj_lehner: { sections: [{ key: "a", body: "Leistung", enabled: true }] } };
  data.flowertech.contracts = { prj_lehner: { sections: [{ key: "a", body: "Vertrag" }] } };
  data.flowertech.legalDocs = {
    prj_lehner: { agb: { sections: [{ title: "AGB", body: "Text" }], version: 1, updatedAt: "2026-08-01" } },
  };
  win._ftNewDoc("offer", "prj_lehner");
  const offerte = data.flowertech.offers.find((o) => o.projectId === "prj_lehner");
  offerte.client = { company: "Lehner GmbH" };
  offerte.items = [{ id: "it_1", description: "Website", qty: 1, unit: "Pauschal", price: 4500, discountPercent: 0 }];

  ok(!win._ftPortalRelease("prj_lehner").published,
    "das Kundenportal gilt schon vor der Veröffentlichung als online");
  ok(!/kunde\.html/.test(panelOf(win, "prj_lehner")),
    "der Kundenportal-Link steht vor der ausdrücklichen Veröffentlichung in der Karte");

  win._ftReleaseClientPortal("prj_lehner");
  ok(win._ftPortalRelease("prj_lehner").published, "das Kundenportal liess sich nicht veröffentlichen");
  const html = panelOf(win, "prj_lehner");
  const portal = win._ftClientPortalLink("prj_lehner");

  ok(html.includes(fragebogen), "der Fragebogen-Link fehlt, sobald ein Kundenportal existiert");
  ok(html.includes(portal), "der veröffentlichte Kundenportal-Link fehlt");
  ok(fragebogen !== portal, "die beiden Links sind derselbe");
  ok(/fragebogen\.html/.test(fragebogen) && /kunde\.html/.test(portal),
    "die beiden Links zeigen nicht auf getrennte Seiten");

  // Jede Zeile trägt ihre eigene, unverwechselbare Beschriftung.
  const fragebogenZeile = html.slice(html.indexOf("Phase 1 · Fragebogen"), html.indexOf("Phase 2 · Kundenportal"));
  ok(fragebogenZeile.includes(fragebogen), "die Fragebogen-Zeile enthält den Fragebogen-Link nicht");
  ok(!fragebogenZeile.includes(portal), "in der Fragebogen-Zeile steht der Kundenportal-Link");
  ok(!/kunde\.html/.test(fragebogenZeile), "die Fragebogen-Zeile verweist auf das Kundenportal");
  ok(/Kundendaten &amp; Vision Room, keine Vorschau/.test(fragebogenZeile),
    "die Fragebogen-Zeile ist nicht vollständig beschriftet");

  const portalZeile = html.slice(html.indexOf("Phase 2 · Kundenportal"));
  ok(!portalZeile.includes(fragebogen), "in der Kundenportal-Zeile steht der Fragebogen-Link");
  ok(/Kundenportal-Link/.test(portalZeile), "die Kundenportal-Zeile ist nicht beschriftet");
}

console.log(`flowertech projekt-fragebogen: ok (${checks} Pruefungen)`);
