/*
 * FlowerTech — Kundenanfrage (Fragebogen) → Kundenprojekt → Kundenportal.
 * ---------------------------------------------------------------------------
 * Der verbindliche Ablauf, den dieser Test absichert:
 *
 *   1. Ich lege in Quantus eine Kundenanfrage an — kein Projekt, keine Offerte.
 *      Ich bearbeite die Fragen, die ich stellen will.
 *   2. Ich kopiere den oeffentlichen Link und gebe ihn der Kundschaft.
 *   3. Die Kundschaft beantwortet den Fragebogen. Diese erste Eingabe ist das
 *      „erste Dokument".
 *   4. Erst das erfolgreiche Absenden erzeugt — idempotent — GENAU EIN
 *      Kundenprojekt mit Kontakt, Anfrage-Dokument und einer Aufgabe.
 *   5. Zum Projekt gehoert ein geschuetztes Kundenportal: Vorschau,
 *      Aenderungswuensche, AGB mit Zustimmung, Rueckfragen, Fortschritt.
 *   6. Vorlage und Prompt sind Dateien: herunterladen, ersetzen, hochladen.
 *   7. Der Prompt enthaelt ALLE Antworten, Aenderungswuensche und Rueckfragen.
 *
 * Der Laufzeitteil laedt public/flowertech.js wirklich und ruft die echten
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

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Fragen sind Daten, keine fest verdrahtete Maske ────────────────────
{
  const qs = CORE.normalizeIntakeQuestions([
    { label: "  Firma  ", type: "text", role: "company" },
    { label: "Ziel", type: "textarea", role: "need", required: true },
    { label: "", type: "text" },                        // ohne Frage keine Frage
    { label: "Art", type: "select", options: [" Website ", "Programm", ""] },
    { label: "Erfunden", type: "gibtsnicht", role: "gibtsauchnicht" },
  ]);
  ok(qs.length === 4, `es entstanden ${qs.length} Fragen statt vier`);
  ok(qs[0].key === "firma", `der Schluessel wird nicht abgeleitet: ${qs[0].key}`);
  ok(qs[1].required === true, "die Pflichtmarkierung geht verloren");
  // Die leere Frage faellt weg, danach: Firma, Ziel, Art, Erfunden.
  ok(qs[2].options.length === 2, "leere Auswahlmoeglichkeiten werden uebernommen");
  ok(qs[2].type === "select", "der Fragetyp geht verloren");
  ok(qs[3].type === "text" && qs[3].role === "",
    "ein erfundener Typ oder eine erfundene Rolle wird uebernommen");

  // Doppelte Schluessel duerfen sich nicht ueberschreiben.
  const doppelt = CORE.normalizeIntakeQuestions([{ label: "Ziel" }, { label: "Ziel" }]);
  ok(doppelt[0].key !== doppelt[1].key, "zwei gleiche Fragen teilen sich einen Schluessel");
}

// ── 2. Antworten werden gegen die Fragen geprueft ─────────────────────────
{
  const questions = CORE.normalizeIntakeQuestions([
    { key: "name", label: "Name", type: "text", role: "contactName", required: true },
    { key: "email", label: "E-Mail", type: "email", role: "contactEmail", required: true },
    { key: "art", label: "Art", type: "select", options: ["Website", "Programm"] },
    { key: "ziel", label: "Ziel", type: "textarea", role: "need", required: true },
    { key: "termin", label: "Termin", type: "date", role: "deadline" },
  ]);
  const { answers } = CORE.normalizeIntakeAnswers(questions, {
    name: "  Anna Muster ", email: "ANNA@Muster.CH", art: "Erfunden",
    ziel: "Mehr Anfragen\nund weniger Papierkram", termin: "morgen",
    heimlich: "<script>alert(1)</script>",             // nicht gefragt
  }, { now: "2026-08-08T10:00:00.000Z" });

  ok(answers.length === 5, "es kommen mehr oder weniger Antworten zurueck als Fragen");
  ok(!JSON.stringify(answers).includes("heimlich"),
    "eine nicht gestellte Frage kommt durch — der Fragebogen waere keine Grenze");
  ok(CORE.answerByRole(answers, "contactName") === "Anna Muster", "der Name wird nicht getrimmt");
  ok(CORE.answerByRole(answers, "contactEmail") === "anna@muster.ch", "die E-Mail wird nicht normalisiert");
  ok(answers.find((a) => a.key === "art").answer === "",
    "eine erfundene Auswahl wird uebernommen");
  ok(answers.find((a) => a.key === "termin").answer === "",
    "ein unbrauchbares Datum wird uebernommen");
  ok(CORE.answerByRole(answers, "need").includes("\n"), "Zeilenumbrueche im Ziel gehen verloren");

  // Pflichtfragen und Rueckkanal.
  const gut = CORE.intakeAnswersUsable(questions, answers);
  ok(gut.usable, `eine vollstaendige Antwort gilt als unbrauchbar: ${gut.missing.join(", ")}`);
  const ohneZiel = CORE.normalizeIntakeAnswers(questions, { name: "A", email: "a@b.ch" }).answers;
  const schlecht = CORE.intakeAnswersUsable(questions, ohneZiel);
  ok(!schlecht.usable && schlecht.missing.includes("Ziel"),
    "eine fehlende Pflichtantwort wird nicht benannt");
  const ohneMail = CORE.normalizeIntakeAnswers(questions, { name: "A", ziel: "X" }).answers;
  ok(!CORE.intakeAnswersUsable(questions, ohneMail).usable,
    "ohne Rueckkanal gilt die Antwort als brauchbar");
  // Keine kuenstliche Mindestlaenge: ein Wort genuegt.
  const kurz = CORE.normalizeIntakeAnswers(questions, { name: "A", email: "a@b.ch", ziel: "Shop" }).answers;
  ok(CORE.intakeAnswersUsable(questions, kurz).usable, "eine kurze, sinnvolle Antwort wird abgewiesen");
}

// ── 3. Aus den Antworten entsteht ein Projekt mit Kontakt ─────────────────
{
  const intake = { id: "in_1", title: "Ihre Angaben", deliveryType: "website" };
  const questions = CORE.normalizeIntakeQuestions(CORE.DEFAULT_INTAKE_QUESTIONS);
  const { answers } = CORE.normalizeIntakeAnswers(questions, {
    company: "Beiz AG", name: "Anna Muster", email: "anna@beiz.ch", phone: "079 000 00 00",
    kind: "Website", need: "Website mit Speisekarte und Reservation",
    features: "Speisekarte\nReservation", budget: "CHF 4'200", deadline: "2026-10-01",
  }, { now: "2026-08-08T10:00:00.000Z" });

  const project = CORE.projectFromIntake({ intake, answers, now: "2026-08-08T10:00:00.000Z" });
  ok(project.title === "Beiz AG", `der Projektname stimmt nicht: ${project.title}`);
  ok(project.client.email === "anna@beiz.ch", "der Kontakt fehlt am Projekt");
  ok(project.client.phone === "079 000 00 00", "die Telefonnummer fehlt");
  ok(project.budget === 4200, `der Budgetrahmen fehlt: ${project.budget}`);
  ok(project.dueDate === "2026-10-01", "der Wunschtermin fehlt");
  ok(project.pipelineStage === "intake", "die Bestandesaufnahme gilt nicht als erfolgt");
  ok((project.tags || []).includes("kundenanfrage"), "der Vorgang ist nicht als Kundenanfrage erkennbar");
  // Kontaktdaten stehen im Kontaktfeld — nicht zusaetzlich in der Beschreibung.
  ok(!project.description.includes("anna@beiz.ch"),
    "die Mailadresse steht doppelt in der Projektbeschreibung");
  ok(project.description.includes("Speisekarte"), "die freien Antworten fehlen in der Beschreibung");

  // Das erste Dokument haelt ALLES fest — auch die Kontaktantworten.
  const doc = CORE.buildIntakeDocument({ intake, answers, now: "2026-08-08T10:00:00.000Z" });
  ok(doc.answers.length === questions.length, "das Anfrage-Dokument ist unvollstaendig");
  ok(doc.answers.some((a) => a.answer === "anna@beiz.ch"),
    "das Anfrage-Dokument verliert die Kontaktangabe");

  // GENAU eine Aufgabe.
  const task = CORE.buildIntakeTask({ project, document: doc, projectId: "prj_1", now: "2026-08-08T10:00:00.000Z" });
  ok(!Array.isArray(task), "aus einem Fragebogen entsteht eine Liste von Aufgaben");
  ok(task.title === "Offertenanfrage bearbeiten: Beiz AG", `der Aufgabentitel stimmt nicht: ${task.title}`);
  ok(task.projectId === "prj_1", "die Aufgabe ist nicht verknuepft");
  ok(task.status === "todo" && task.category === "flowertech", "es ist keine normale Quantus-Aufgabe");
  ok(task.description.includes("Speisekarte"), "die Antworten fehlen in der Aufgabe");
}

// ── 4. Der Prompt enthaelt wirklich alles ─────────────────────────────────
{
  const intake = { id: "in_1", title: "Mein eigener Fragebogen" };
  const questions = CORE.normalizeIntakeQuestions([
    { key: "email", label: "E-Mail", type: "email", role: "contactEmail", required: true },
    { key: "ziel", label: "Was soll erreicht werden?", type: "textarea", role: "need", required: true },
    { key: "lieblingsfarbe", label: "Lieblingsfarbe", type: "text" },   // selbst definiert
  ]);
  const { answers } = CORE.normalizeIntakeAnswers(questions, {
    email: "anna@beiz.ch", ziel: "Mehr Reservationen", lieblingsfarbe: "Tannengrün",
  });
  const doc = CORE.buildIntakeDocument({ intake, answers, now: "2026-08-08T10:00:00.000Z" });
  const prompt = CORE.buildProjectPrompt({
    project: { title: "Beiz-Website", deliveryType: "website", pipelineStage: "intake", budget: 4200, dueDate: "2026-10-01" },
    document: doc,
    changes: [{ title: "Anderes Bild auf der Startseite", status: "new", detail: "Aussenaufnahme" },
      { title: "Verworfen", status: "rejected" }],
    questions: [{ question: "Haben Sie ein Logo als Datei?", answer: "Ja, als SVG." },
      { question: "Noch offen", answer: "" }],
    templateName: "beiz.html", company: { name: "FlowerTech" }, now: "2026-08-08T10:00:00.000Z",
  });

  ok(prompt.includes("Mein eigener Fragebogen"), "der Fragebogen wird im Prompt nicht benannt");
  ok(prompt.includes("Lieblingsfarbe") && prompt.includes("Tannengrün"),
    "eine selbst definierte Frage fehlt im Prompt — genau darum geht es");
  ok(prompt.includes("Mehr Reservationen"), "das Ziel fehlt im Prompt");
  ok(prompt.includes("Anderes Bild auf der Startseite"), "die Änderungswünsche fehlen im Prompt");
  ok(prompt.includes("Aussenaufnahme"), "die Details der Änderung fehlen");
  ok(!prompt.includes("Verworfen"), "ein abgelehnter Änderungswunsch steht im Prompt");
  ok(prompt.includes("Haben Sie ein Logo als Datei?") && prompt.includes("Ja, als SVG."),
    "die Rückfragen fehlen im Prompt");
  ok(!prompt.includes("Noch offen"), "eine unbeantwortete Rückfrage steht als Vorgabe im Prompt");
  ok(prompt.includes("beiz.html"), "die gewählte Vorlage fehlt im Prompt");
  ok(prompt.includes("CHF 4200.00") && prompt.includes("2026-10-01"), "der Projektkontext fehlt");
  // Kontaktdaten gehoeren nicht in einen Prompt, der eine Website baut.
  ok(!prompt.includes("anna@beiz.ch"), "die Mailadresse der Kundschaft steht im Prompt");
  ok(prompt.startsWith("# Auftrag:"), "der Prompt ist kein Markdown-Dokument");
}

// ── 5. Vorlage: brauchbarer Standard, entschaerfter Upload ────────────────
{
  const html = CORE.defaultTemplateHtml({
    project: { title: "Beiz-Website" },
    document: { answers: [
      { label: "Ziel", answer: "Mehr Reservationen", role: "need" },
      { label: "Funktionen", answer: "Speisekarte", role: "" },
      { label: "E-Mail", answer: "anna@beiz.ch", role: "contactEmail" },
    ] },
    company: { name: "FlowerTech" },
  });
  ok(/<!doctype html>/i.test(html), "die Standardvorlage ist kein vollstaendiges HTML-Dokument");
  ok(/viewport/.test(html) && /@media \(prefers-color-scheme:light\)/.test(html),
    "die Standardvorlage ist nicht responsive und kennt kein helles Schema");
  ok(html.includes("Beiz-Website") && html.includes("Mehr Reservationen"),
    "die Standardvorlage nutzt die Antworten nicht");
  ok(!html.includes("anna@beiz.ch"), "die Standardvorlage stellt Kontaktdaten aus");
  ok(!/Sämi|saemi/i.test(html), "in der Standardvorlage steht fremder Beispielinhalt");
  ok(!/<script/i.test(html), "die Standardvorlage bringt eigenes JavaScript mit");

  const clean = CORE.sanitizeTemplateHtml(
    '<h1 onclick="steal()">Hallo</h1><script>böse()</script><a href="javascript:x">L</a><iframe src="x"></iframe>');
  ok(!/<script/i.test(clean.html), "ein Skript ueberlebt den Upload");
  ok(!/onclick/i.test(clean.html), "ein Ereignis-Attribut ueberlebt den Upload");
  ok(!/javascript:/i.test(clean.html), "eine javascript:-Adresse ueberlebt den Upload");
  ok(!/<iframe/i.test(clean.html), "eine eingebettete Seite ueberlebt den Upload");
  ok(clean.html.includes("Hallo"), "der eigentliche Inhalt wird mitgeloescht");
  ok(clean.removed.length >= 3, "es wird nicht benannt, was entfernt wurde");
  const gross = CORE.sanitizeTemplateHtml("x".repeat(CORE.MAX_TEMPLATE_BYTES + 100));
  ok(gross.truncated && gross.html.length === CORE.MAX_TEMPLATE_BYTES, "die Groessengrenze greift nicht");
}

// ── 6. Portalfortschritt und AGB-Zustimmung ──────────────────────────────
{
  const leer = CORE.portalProgress({});
  ok(leer.label === "Fragebogen erhalten", `der Anfangszustand stimmt nicht: ${leer.label}`);
  ok(CORE.portalProgress({ hasPreview: true }).label === "Vorschau", "die Vorschau bewegt den Stand nicht");
  ok(CORE.portalProgress({ hasPreview: true, changes: [{ status: "new" }] }).label === "Änderungen",
    "Änderungswünsche bewegen den Stand nicht");
  const fertig = CORE.portalProgress({ hasPreview: true, changes: [{ status: "done" }], versions: [{ approved: true }] });
  ok(fertig.label === "Freigabe", "die Freigabe bewegt den Stand nicht");
  ok(fertig.steps.length === 4 && fertig.steps[3].current, "der Stepper stimmt nicht");
  ok(CORE.portalProgress({ hasPreview: true, changes: [{ status: "new" }] }).openChanges === 1,
    "offene Änderungswünsche werden nicht gezaehlt");

  const terms = { version: "2-2026-08-08", title: "AGB", body: "Text" };
  ok(!CORE.termsState({ terms }).accepted, "ohne Zustimmung gilt zugestimmt");
  ok(CORE.termsState({ terms, consent: { version: "2-2026-08-08", acceptedAt: "x" } }).accepted,
    "eine erteilte Zustimmung wird nicht erkannt");
  const alt = CORE.termsState({ terms, consent: { version: "1-2026-01-01", acceptedAt: "x" } });
  ok(!alt.accepted && alt.outdated,
    "eine Zustimmung zu einer alten Fassung gilt weiterhin — der Text hat sich geaendert");
}

// ── 7. Der Kundensnapshot bleibt datensparsam ────────────────────────────
{
  const snap = CORE.buildClientSnapshot({
    project: {
      id: "prj_1", title: "Beiz-Website", pipelineStage: "build",
      client: { company: "Beiz AG", email: "anna@beiz.ch", phone: "079 000 00 00" },
      ftContactLog: [{ text: "intern" }],
    },
    previewHtml: "<h1>Vorschau</h1><script>x()</script>",
    previewUpdatedAt: "2026-08-08T10:00:00.000Z",
    terms: { title: "AGB", body: "Bedingungen", version: "1-2026-08-08" },
    consent: null,
    questions: [{ id: "q1", question: "Logo als Datei?", answer: "", askedAt: "2026-08-08T09:00:00.000Z" }],
    intakeDocument: {
      intakeTitle: "Ihre Angaben", submittedAt: "2026-08-08T08:00:00.000Z",
      answers: [
        { label: "Ziel", answer: "Mehr Reservationen", role: "need" },
        { label: "E-Mail", answer: "anna@beiz.ch", role: "contactEmail" },
        { label: "Firma", answer: "Beiz AG", role: "company" },
      ],
    },
    now: "2026-08-08T12:00:00.000Z",
  });

  ok(snap.preview.html === "<h1>Vorschau</h1>", "die Vorschau wird nicht entschaerft");
  ok(snap.preview.sanitized.includes("Skripte"), "es wird nicht benannt, was entfernt wurde");
  ok(snap.portal.label === "Vorschau", "der Portalfortschritt fehlt");
  ok(snap.terms.body === "Bedingungen" && snap.terms.accepted === false, "die AGB fehlen im Portal");
  ok(snap.terms.notice.includes("ENTWURF"), "der Prüfhinweis zum Rechtstext fehlt");
  ok(snap.questions.length === 1 && snap.questions[0].question === "Logo als Datei?",
    "die Rückfragen fehlen im Portal");
  ok(snap.intake.answers.length === 1 && snap.intake.answers[0].label === "Ziel",
    "die eigenen Angaben fehlen — oder es sind zu viele");

  const text = JSON.stringify(snap);
  ok(!text.includes("anna@beiz.ch"), "die Mailadresse wandert ins Kundenportal");
  ok(!text.includes("079 000 00 00"), "die Telefonnummer wandert ins Kundenportal");
  ok(!text.includes("Beiz AG"), "die Firma wandert ins Kundenportal");
  ok(!text.includes("prj_1"), "die interne Projekt-ID wandert ins Kundenportal");
  for (const key of CORE.CLIENT_SNAPSHOT_FORBIDDEN_KEYS) {
    ok(!Object.prototype.hasOwnProperty.call(snap, key), `verbotenes Feld im Snapshot: ${key}`);
  }
}

// ── 8. Der Einladungslink ist ein eigener Kreis ──────────────────────────
{
  const token = "e".repeat(30);
  ok(CORE.intakeFormUrl(token) === "https://flowertech.ch/fragebogen.html?e=" + token,
    "der Einladungslink stimmt nicht");
  ok(CORE.intakeFormUrl("zu-kurz") === "", "ein unbrauchbarer Token ergibt trotzdem einen Link");
  ok(CORE.intakeFormUrl(token) !== CORE.clientPortalUrl(token),
    "Einladung und Portalzugang sind derselbe Link");
}

/* ══ Teil 2 — Laufzeit ════════════════════════════════════════════════════ */

let seed = 0;
function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  const written = {};
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast() {},
    __written: written, __mails: [], __downloads: [],
    gmailCompose(opts) { win.__mails.push(opts); },
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (Math.random().toString(36).slice(2)),
    nowIso: () => "2026-08-08T10:00:00.000Z",
    todayYmd: () => "2026-08-08",
    // Deterministisch, aber bei jedem Aufruf anders — sonst waere ein
    // „erneuerter" Token derselbe wie der alte und der Test truege.
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    confirm: () => true, prompt: () => "",
  };
  win.window = win;
  const fields = {};
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      getElementById: (id) => fields[id] || null,
      querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {} }),
      body: { appendChild() {}, classList: { toggle() {}, remove() {} } },
    },
    location: win.location,
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: {},
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
  win.__fields = fields;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written, fields };
}

const intakeTasks = (data) => Object.values(data.entities.tasks).filter((t) => t.source === "flowertech-intake");
const answersFor = (win, intakeId, values) => {
  const intake = win.APP.state.data.flowertech.intakes[intakeId];
  return CORE.normalizeIntakeAnswers(intake.questions, values).answers;
};

// ── 9. Anlegen: ein Fragebogen, kein Projekt ─────────────────────────────
{
  const { win, data, written } = makeSandbox();
  win._ftNewIntake();
  const ids = Object.keys(data.flowertech.intakes);
  ok(ids.length === 1, "es wurde kein Fragebogen angelegt");
  const intake = data.flowertech.intakes[ids[0]];

  ok(Object.keys(data.entities.projects).length === 0,
    "beim Anlegen des Fragebogens entstand bereits ein Projekt");
  ok(Object.keys(data.entities.tasks).length === 0, "beim Anlegen entstand bereits eine Aufgabe");
  ok((data.flowertech.offers || []).length === 0, "beim Anlegen entstand bereits eine Offerte");
  ok(intake.questions.length > 5, "der Fragebogen startet ohne brauchbare Fragen");
  ok(/^[A-Za-z0-9_-]{24,64}$/.test(intake.inviteToken || ""), "es gibt keinen brauchbaren Einladungstoken");

  const link = win._ftIntakeLink(intake.id);
  ok(link === "https://flowertech.ch/fragebogen.html?e=" + intake.inviteToken,
    `der öffentliche Link stimmt nicht: ${link}`);
  ok(!/management-xo2-pro/.test(link), "der Link zeigt auf die interne Verwaltung");

  // Der veröffentlichte Fragebogen trägt nichts Internes.
  const key = "flowertech/intakeForms/" + intake.inviteToken;
  ok(written[key], "der Fragebogen wurde nicht veröffentlicht");
  const published = JSON.stringify(written[key]);
  ok(!published.includes(intake.id), "die interne Fragebogen-ID steht im öffentlichen Snapshot");
  ok(!published.includes("portalToken"), "ein Portaltoken steht im öffentlichen Snapshot");
  ok(written[key].questions.length === intake.questions.length, "die Fragen fehlen im Snapshot");
  ok(written[key].status === "open", "der Fragebogen ist nicht offen");

  // Fragen bearbeiten wirkt sofort auf den veröffentlichten Stand.
  win._ftAddIntakeQuestion(intake.id);
  win._ftSetIntakeQuestion(intake.id, intake.questions.length - 1, "label", "Lieblingsfarbe");
  ok(intake.questions[intake.questions.length - 1].label === "Lieblingsfarbe",
    "eine eigene Frage lässt sich nicht anlegen");
  ok(written[key].questions.some((q) => q.label === "Lieblingsfarbe"),
    "die eigene Frage steht nicht im veröffentlichten Fragebogen");

  // „Neu" widerruft den alten Link samt Inhalt.
  const alt = intake.inviteToken;
  win._ftRotateIntakeToken(intake.id);
  ok(!written["flowertech/intakeForms/" + alt], "der alte Fragebogen bleibt öffentlich lesbar");
  ok(intake.inviteToken !== alt, "der Token wurde nicht erneuert");
}

// ── 10. Absenden: genau EIN Projekt, idempotent ──────────────────────────
{
  const { win, data, written } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  const intake = data.flowertech.intakes[intakeId];

  const entry = {
    id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
    payload: {
      intakeTitle: intake.title,
      answers: answersFor(win, intakeId, {
        company: "Beiz AG", name: "Anna Muster", email: "anna@beiz.ch", phone: "079 000 00 00",
        kind: "Website", need: "Website mit Speisekarte und Reservation",
        features: "Speisekarte\nReservation", budget: "4200", deadline: "2026-10-01",
      }),
    },
  };

  ok(win._ftIngestSubmissions({ sub_1: entry }) === 1, "der Fragebogen wurde nicht verarbeitet");
  const projects = Object.values(data.entities.projects);
  ok(projects.length === 1, `es entstanden ${projects.length} Projekte statt genau eines`);
  const project = projects[0];

  ok(project.title === "Beiz AG", `der Projektname stimmt nicht: ${project.title}`);
  ok(project.client.email === "anna@beiz.ch", "der Kontakt fehlt am Projekt");
  ok(project.budget === 4200, "der Budgetrahmen fehlt am Projekt");
  ok(project.ftIntakeDocument, "es gibt kein Anfrage-Dokument");
  ok(project.ftIntakeDocument.answers.some((a) => a.answer.includes("Speisekarte")),
    "das Anfrage-Dokument ist unvollständig");
  ok(project.sourceIntakeId === intakeId, "Projekt und Fragebogen sind nicht verknüpft");
  ok(intake.projectId === project.id, "der Fragebogen kennt sein Projekt nicht");
  ok(intake.status === "answered", "der Fragebogen steht weiter auf offen");

  const tasks = intakeTasks(data);
  ok(tasks.length === 1, `es entstanden ${tasks.length} Aufgaben statt genau einer`);
  ok(tasks[0].title === "Offertenanfrage bearbeiten: Beiz AG", `der Aufgabentitel stimmt nicht: ${tasks[0].title}`);
  ok(tasks[0].projectId === project.id, "die Aufgabe ist nicht mit dem Projekt verknüpft");

  // Keine Offerte, keine Nummer.
  ok((data.flowertech.offers || []).length === 0, "es entstand eine Offerte");

  // Vorlage und Prompt stehen sofort bereit.
  ok((project.ftTemplate.html || "").includes("<!doctype html>"), "es gibt keine Standardvorlage");
  ok(project.ftPrompt.text.includes("Speisekarte"), "der Prompt enthält die Antworten nicht");

  // Das Kundenportal ist veröffentlicht.
  const portalToken = data.flowertech.shares[project.id].portalToken;
  ok(written["flowertech/clientPortals/" + portalToken], "das Kundenportal wurde nicht veröffentlicht");
  ok(written["flowertech/intakeForms/" + intake.inviteToken].status === "answered",
    "der öffentliche Fragebogen zeigt weiterhin ein offenes Formular");

  // Reload / zweites Senden: nichts Zweites.
  win._ftIngestSubmissions({ sub_1: entry });
  win._ftIngestSubmissions({ sub_2: Object.assign({}, entry, { id: "sub_2" }) });
  ok(Object.keys(data.entities.projects).length === 1, "ein zweites Absenden erzeugt ein zweites Projekt");
  ok(intakeTasks(data).length === 1, "ein zweites Absenden erzeugt eine zweite Aufgabe");
}

// ── 11. Fremde und fehlende Tokens ───────────────────────────────────────
{
  const { win, data } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  const answers = answersFor(win, intakeId, { name: "A", email: "a@b.ch", need: "Shop", kind: "Website" });

  // Fremder Token.
  win._ftIngestSubmissions({
    s1: { id: "s1", kind: "intake", token: "z".repeat(30), payload: { answers } },
  });
  ok(Object.keys(data.entities.projects).length === 0, "ein fremder Einladungstoken legt ein Projekt an");

  // Ohne Token.
  win._ftIngestSubmissions({ s2: { id: "s2", kind: "intake", payload: { answers } } });
  ok(Object.keys(data.entities.projects).length === 0, "ein Fragebogen ohne Token legt ein Projekt an");

  // Der Einladungstoken öffnet NUR den Fragebogen.
  const token = data.flowertech.intakes[intakeId].inviteToken;
  win._ftIngestSubmissions({
    s3: { id: "s3", kind: "change", token, payload: { title: "Untergeschoben" } },
  });
  ok((data.flowertech.changeRequests || []).length === 0,
    "ein Einladungstoken schleust einen Änderungswunsch ein");

  // Pflichtantworten fehlen: kein Projekt.
  win._ftIngestSubmissions({
    s4: { id: "s4", kind: "intake", token,
      payload: { answers: answersFor(win, intakeId, { name: "A", email: "a@b.ch" }) } },
  });
  ok(Object.keys(data.entities.projects).length === 0,
    "ein unvollständig beantworteter Fragebogen legt ein Projekt an");
}

// ── 12. Kundenportal: Vorschau, Änderung, AGB, Rückfrage ─────────────────
{
  const { win, data, written, fields } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  const intake = data.flowertech.intakes[intakeId];
  win._ftIngestSubmissions({
    sub_1: { id: "sub_1", kind: "intake", token: intake.inviteToken,
      payload: { answers: answersFor(win, intakeId, {
        name: "Anna", email: "anna@beiz.ch", kind: "Website", need: "Website mit Speisekarte" }) } },
  });
  const project = Object.values(data.entities.projects)[0];
  const portalToken = data.flowertech.shares[project.id].portalToken;
  const key = "flowertech/clientPortals/" + portalToken;

  ok(written[key].preview.html.includes("<!doctype html>"), "die Vorschau fehlt im Portal");
  ok(written[key].portal.label === "Vorschau", "der Portalfortschritt stimmt nicht");
  ok(written[key].intake.answers.length, "die eigenen Angaben fehlen im Portal");
  ok(!JSON.stringify(written[key]).includes("anna@beiz.ch"),
    "die Mailadresse der Kundschaft wandert ins Portal");

  // Änderungswunsch aus dem Portal.
  win._ftIngestSubmissions({
    c1: { id: "c1", kind: "change", token: portalToken,
      payload: { title: "Anderes Bild auf der Startseite", detail: "Aussenaufnahme" } },
  });
  ok((data.flowertech.changeRequests || []).length === 1, "der Änderungswunsch kam nicht an");
  ok(written[key].changes.some((c) => c.title.includes("Anderes Bild")),
    "der Änderungswunsch steht nicht im Portal");
  ok(written[key].portal.label === "Änderungen", "der Fortschritt bewegt sich nicht");

  // AGB-Zustimmung.
  win._ftBuildLegal(project.id, "agb", true);
  const version = win._ftTermsForProject(project.id).version;
  ok(version, "es gibt keine AGB-Fassung");
  ok(written[key].terms.body.length > 50, "die AGB stehen nicht im Portal");
  ok(written[key].terms.accepted === false, "die AGB gelten ungefragt als zugestimmt");

  win._ftIngestSubmissions({
    t1: { id: "t1", kind: "terms", token: portalToken,
      payload: { version, accepted: true, acceptedAt: "2026-08-08T11:00:00.000Z" } },
  });
  ok(project.ftTermsConsent && project.ftTermsConsent.version === version, "die Zustimmung wurde nicht erfasst");
  ok(written[key].terms.accepted === true, "die Zustimmung steht nicht im Portal");
  ok((project.ftContactLog || []).some((l) => /AGB/.test(l.text)), "die Zustimmung fehlt im Verlauf");

  // Eine Zustimmung ohne ausdrückliches Ja wirkt nicht.
  ok(win._ftApplyTermsConsent(project.id, { version: "andere", accepted: false }) === false,
    "eine Zustimmung ohne ausdrückliches Ja wird angenommen");

  // Rückfrage stellen und beantworten.
  fields.ftPortalQuestion = { value: "Haben Sie ein Logo als Datei?" };
  win._ftAskPortalQuestion(project.id);
  const question = project.ftPortalQuestions[0];
  ok(question && question.question.includes("Logo"), "die Rückfrage wurde nicht angelegt");
  ok(written[key].questions.length === 1, "die Rückfrage steht nicht im Portal");

  win._ftIngestSubmissions({
    a1: { id: "a1", kind: "answer", token: portalToken,
      payload: { questionId: question.id, answer: "Ja, als SVG." } },
  });
  ok(project.ftPortalQuestions[0].answer === "Ja, als SVG.", "die Antwort kam nicht an");
  ok(written[key].questions[0].answer === "Ja, als SVG.", "die Antwort steht nicht im Portal");
  // Eine beantwortete Frage wird nicht überschrieben.
  ok(win._ftApplyPortalAnswer(project.id, { questionId: question.id, answer: "Doch nicht" }) === false,
    "eine bereits beantwortete Rückfrage lässt sich überschreiben");

  // Der Prompt zieht Änderungen und Antworten nach.
  win._ftRegeneratePrompt(project.id);
  const prompt = project.ftPrompt.text;
  ok(prompt.includes("Anderes Bild auf der Startseite"), "der Änderungswunsch fehlt im neuen Prompt");
  ok(prompt.includes("Ja, als SVG."), "die Rückantwort fehlt im neuen Prompt");
  ok(prompt.includes("Website mit Speisekarte"), "die ursprünglichen Antworten fehlen im neuen Prompt");
}

// ── 13. Vorlage und Prompt sind Dateien ──────────────────────────────────
{
  const { win, data, written } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  const intake = data.flowertech.intakes[intakeId];
  win._ftIngestSubmissions({
    sub_1: { id: "sub_1", kind: "intake", token: intake.inviteToken,
      payload: { answers: answersFor(win, intakeId, {
        name: "Anna", email: "a@b.ch", kind: "Website", need: "Ein Hofladen im Netz" }) } },
  });
  const project = Object.values(data.entities.projects)[0];
  const portalKey = "flowertech/clientPortals/" + data.flowertech.shares[project.id].portalToken;

  // Ersetzen (Upload) — der Reader wird direkt getrieben.
  const reads = [];
  win.FileReader = function () {
    const self = this;
    self.readAsText = (file) => { reads.push(file); self.result = file.__text; self.onload(); };
  };
  const upload = (fn, name, text, size) => fn(project.id, {
    files: [{ name, size: size == null ? text.length : size, __text: text }],
  });

  upload(win._ftUploadTemplate, "eigene.html", "<h1>Eigen</h1><script>x()</script>");
  ok(project.ftTemplate.name === "eigene.html", "die hochgeladene Vorlage wurde nicht übernommen");
  ok(project.ftTemplate.source === "hochgeladen", "die Herkunft der Vorlage fehlt");
  ok(!/<script/i.test(project.ftTemplate.html), "das Skript aus der Vorlage überlebt");
  ok(written[portalKey].preview.html.includes("Eigen"), "die Vorschau im Portal wurde nicht aktualisiert");

  // Falsche Art und zu gross werden abgewiesen.
  const vorher = project.ftTemplate.html;
  upload(win._ftUploadTemplate, "böse.exe", "MZ");
  ok(project.ftTemplate.html === vorher, "eine .exe wird als Vorlage übernommen");
  upload(win._ftUploadTemplate, "riesig.html", "<p>x</p>", CORE.MAX_TEMPLATE_BYTES + 1);
  ok(project.ftTemplate.html === vorher, "eine zu grosse Datei wird übernommen");

  // Zurück auf die Standardvorlage.
  win._ftResetTemplate(project.id);
  ok(project.ftTemplate.source === "standard", "die Standardvorlage lässt sich nicht wiederherstellen");
  ok(project.ftTemplate.html.includes("Hofladen"), "die Standardvorlage nutzt die Antworten nicht");

  // Prompt ersetzen.
  upload(win._ftUploadPrompt, "eigener-prompt.md", "# Mein eigener Prompt");
  ok(project.ftPrompt.text === "# Mein eigener Prompt", "der hochgeladene Prompt wurde nicht übernommen");
  ok(project.ftPrompt.source === "hochgeladen", "die Herkunft des Prompts fehlt");
  upload(win._ftUploadPrompt, "prompt.exe", "MZ");
  ok(project.ftPrompt.text === "# Mein eigener Prompt", "eine .exe wird als Prompt übernommen");

  // Neu erzeugen holt den vollständigen Stand zurück.
  win._ftRegeneratePrompt(project.id);
  ok(project.ftPrompt.text.includes("Hofladen"), "der neu erzeugte Prompt ist unvollständig");
  ok(win._ftBuildPrompt(project.id).startsWith("# Auftrag:"), "der Prompt ist kein Markdown-Dokument");

  // Der Prompt ist im Projekt sichtbar.
  data.flowertech.ui = { projectTab: "vorschau" };
  const html = win.ftProjectPanel(project.id).replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(html.includes("Claude-Code-Prompt"), "der Prompt ist im Projekt nicht sichtbar");
  ok(html.includes("Hofladen"), "der Prompt-Inhalt wird nicht angezeigt");
  ok(/⭳ Prompt \(\.md\)/.test(html), "der Prompt lässt sich nicht herunterladen");
  ok(/⭳ Vorlage \(\.html\)/.test(html), "die Vorlage lässt sich nicht herunterladen");
  ok(/Prompt ersetzen/.test(html) && /Vorlage ersetzen/.test(html), "es gibt keinen Upload");
  // Die Vorschau läuft abgeschottet — die Vorlage ist fremdes HTML.
  ok(/<iframe class="ft-preview"[^>]*sandbox/.test(html), "die Vorschau läuft nicht in einem sandboxed iframe");
}

// ── 14. Die Admin-Oberfläche ist wirklich da ─────────────────────────────
{
  const { win, data } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  data.flowertech.activeTab = "intakes";
  data.flowertech.ui = { intakeId };

  const html = win.viewFlowerTech().replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(html.includes("Kundenanfragen"), "der Bereich Kundenanfragen fehlt");
  ok(html.includes("Link kopieren"), "der Link lässt sich nicht kopieren");
  ok(html.includes(win._ftIntakeLink(intakeId)), "der öffentliche Link steht nicht in der Oberfläche");
  ok(/＋ Frage/.test(html), "Fragen lassen sich nicht ergänzen");
  ok(/_ftRemoveIntakeQuestion/.test(html), "Fragen lassen sich nicht entfernen");
  ok(/_ftMoveIntakeQuestion/.test(html), "Fragen lassen sich nicht umsortieren");
  ok(html.includes("Wartet auf Antwort"), "der Status des Fragebogens fehlt");
  ok(/entsteht genau ein Projekt/.test(html), "der Ablauf wird nicht erklärt");
}

// ── 15. Der Kundenlink ist dort, wo man ihn sucht ────────────────────────
// Produktions-Rueckmeldung: „Ich kann in Quantus von einer Offerte oder einem
// Projekt aus den Link nicht kopieren." Er lag nur im Reiter „Kundenportal" —
// dort sucht ihn niemand, der gerade an einer Offerte sitzt.
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech",
    pipelineStage: "proposal", client: {},
  };
  data.flowertech.shares = {};
  const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");

  // a) Am Projekt — auf JEDEM Reiter, nicht nur im Kundenportal.
  for (const tab of ["workflow", "angebot", "vertrag", "vorschau", "kunde"]) {
    data.flowertech.ui = { projectTab: tab };
    const html = strip(win.ftProjectPanel("prj_1"));
    const token = data.flowertech.shares.prj_1.portalToken;
    ok(/^[A-Za-z0-9_-]{24,64}$/.test(token || ""), `Reiter ${tab}: es entstand kein Kundenlink`);
    const link = "https://flowertech.ch/kunde.html?t=" + token;
    ok(html.includes(link), `Reiter ${tab}: der Kundenlink steht nicht auf der Projektseite`);
    ok(html.includes("_ftCopyLink('" + link + "')"), `Reiter ${tab}: der Link lässt sich nicht kopieren`);
    ok(/>Öffnen</.test(html), `Reiter ${tab}: der Link lässt sich nicht öffnen`);
  }

  // b) In der Offerte — ohne den Vorgang zu wechseln.
  win._ftNewDoc("offer", "prj_1");
  const doc = data.flowertech.offers[0];
  data.flowertech.activeTab = "offers";
  data.flowertech.ui = { docId: doc.id, docKind: "offer" };
  const offerHtml = strip(win.viewFlowerTech());
  const token = data.flowertech.shares.prj_1.portalToken;
  const link = "https://flowertech.ch/kunde.html?t=" + token;
  ok(offerHtml.includes(link), "in der Offerte fehlt der Kundenlink");
  ok(/🔗 Kundenlink/.test(offerHtml), "in der Aktionszeile der Offerte fehlt der Kundenlink");
  ok(offerHtml.includes("_ftCopyLink('" + link + "')"), "der Kundenlink der Offerte lässt sich nicht kopieren");

  // c) Eine Offerte ohne Projekt erfindet keinen Link, sondern sagt, was fehlt.
  win._ftNewDoc("offer");
  const frei = data.flowertech.offers[0];
  ok(!frei.projectId, "die neue Offerte hängt bereits an einem Projekt");
  data.flowertech.ui = { docId: frei.id, docKind: "offer" };
  const freiHtml = strip(win.viewFlowerTech());
  ok(/gehört noch zu keinem Projekt/.test(freiHtml),
    "eine Offerte ohne Projekt erklärt den fehlenden Kundenlink nicht");
  ok(!/🔗 Kundenlink/.test(freiHtml), "eine Offerte ohne Projekt bietet einen erfundenen Link an");
}

// ── 16. In der Projektliste: kopieren, ohne zu öffnen ────────────────────
{
  const { win, data, written } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech", pipelineStage: "lead", client: {},
  };
  data.flowertech.activeTab = "projects";
  const html = win.viewFlowerTech().replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(/_ftCopyProjectLink\('prj_1'\)/.test(html), "in der Projektliste fehlt der Kopierknopf");
  ok(/event\.stopPropagation\(\)/.test(html), "der Kopierknopf öffnet zugleich das Projekt");

  // Beim Rendern der Liste entsteht noch KEIN Zugang — sonst waere jedes
  // Neuzeichnen ein Schreibvorgang pro Zeile.
  ok(!(data.flowertech.shares || {}).prj_1, "das blosse Anzeigen der Liste legt Kundenlinks an");
  ok(Object.keys(written).length === 0, "das blosse Anzeigen der Liste schreibt Snapshots");

  // Erst der Klick erzeugt ihn.
  // Der Rueckfallweg der Zwischenablage braucht ein Textfeld — hier genuegt
  // ein Doppel, geprueft wird der Zugang, nicht die Zwischenablage.
  const area = { value: "", style: {}, select() {}, focus() {}, remove() {} };
  win.document.createElement = () => area;
  win._ftCopyProjectLink("prj_1");
  const token = data.flowertech.shares.prj_1.portalToken;
  ok(/^[A-Za-z0-9_-]{24,64}$/.test(token || ""), "beim Klick entsteht kein Kundenlink");
  ok(written["flowertech/clientPortals/" + token], "beim Klick wird die Kundenseite nicht veröffentlicht");
}

console.log(`flowertech kundenanfrage: ok (${checks} Pruefungen)`);
