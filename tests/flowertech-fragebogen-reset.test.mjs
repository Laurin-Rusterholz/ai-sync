/*
 * FlowerTech — „Fragebogen zurücksetzen“ am projektgebundenen Link.
 * ---------------------------------------------------------------------------
 * Der Befund: Eine Test- oder Fehleingabe schliesst den Fragebogen. Der
 * öffentliche Link gilt als beantwortet, die Kundschaft kommt nicht mehr
 * hinein — und der einzige bisherige Ausweg („Neu“) tauscht den Token und
 * macht damit genau den Link ungültig, der schon verschickt wurde.
 *
 * Dieser Test hält den sicheren Rückweg fest. Bewiesen wird:
 *
 *   1. Der Kern kennt den Rücksetz-Plan: erlaubt nur am beantworteten
 *      Fragebogen des eigenen Projekts, mit klarer Bestätigung, die Folgen
 *      UND Nicht-Folgen benennt.
 *   2. Der Knopf steht nur da, wenn der Fragebogen beantwortet ist — vorher
 *      nicht, und nach dem Zurücksetzen wieder nicht.
 *   3. Ohne Bestätigung geschieht nichts.
 *   4. Zurückgesetzt werden NUR Antwortstatus, Antwortzeitpunkt und der
 *      Fragebogen-Payload. Link, Token, Projekt, Kundendaten, Budget,
 *      Offerten, Kundenportal und Aufgaben bleiben unberührt.
 *   5. Die Aufgabe „Offertenanfrage“ bleibt bestehen; eine erneute Einreichung
 *      erzeugt kein Duplikat und kein zweites Projekt.
 *   6. Der öffentliche Link zeigt wieder eine leere, offene Form — mit
 *      derselben Adresse und einer neuen Fassung, damit der Eingang die neue
 *      Einreichung nicht als Wiederholung verwirft.
 *   7. Auch ein Projekt, das AUS einem Fragebogen entstanden ist, lässt sich
 *      zurücksetzen — und die nächste Einreichung findet wieder dasselbe
 *      Projekt statt ein zweites anzulegen.
 *   8. Die öffentliche Kundenseite kennt kein Zurücksetzen.
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

const TOKEN = "r".repeat(32);

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Der Knopf heisst überall gleich ────────────────────────────────────
{
  ok(CORE.LINK_LABELS.intakeReset === "Fragebogen zurücksetzen",
    `der Knopf ist nicht benannt: ${CORE.LINK_LABELS.intakeReset}`);
  ok(/derselbe Link/.test(CORE.LINK_LABELS.intakeResetDone),
    "die Erfolgsmeldung sagt nicht, dass der Link derselbe bleibt");
  ok(!/Kundenportal|löschen|gelöscht/i.test(CORE.LINK_LABELS.intakeReset + CORE.LINK_LABELS.intakeResetDone),
    "die Beschriftung klingt nach Löschen oder nennt das Kundenportal");
}

// ── 2. Der Zustand: „zurücksetzen“ nur am beantworteten Fragebogen ────────
{
  const project = { id: "prj_1", title: "Lehner" };
  const offen = CORE.projectIntakeLinkState({ project, intake: { boundProjectId: "prj_1", inviteToken: TOKEN } });
  ok(offen.canReset === false, "ein unbeantworteter Fragebogen bietet das Zurücksetzen an");

  const beantwortet = CORE.projectIntakeLinkState({
    project, intake: { boundProjectId: "prj_1", inviteToken: TOKEN, answeredAt: "2026-08-08T09:00:00.000Z" },
  });
  ok(beantwortet.canReset === true, "ein beantworteter Fragebogen bietet das Zurücksetzen nicht an");
  ok(beantwortet.resetLabel === CORE.LINK_LABELS.intakeReset, "der Zustand benennt den Knopf nicht");
  ok(CORE.projectIntakeLinkState({ project, intake: null }).canReset === false,
    "ohne Fragebogen wird ein Zurücksetzen angeboten");
}

// ── 3. Der Plan: erlaubt, verboten, und was er anfasst ────────────────────
{
  const project = { id: "prj_1", title: "Lehner" };
  const intake = {
    id: "int_1", boundProjectId: "prj_1", inviteToken: TOKEN,
    answeredAt: "2026-08-08T09:00:00.000Z", projectId: "prj_1", submissionId: "sub_1", status: "answered",
  };

  // Verboten: kein Projekt, kein Fragebogen, fremdes Projekt, unbeantwortet.
  ok(!CORE.intakeResetPlan({}).allowed, "ohne Projekt und Fragebogen ist ein Zurücksetzen erlaubt");
  ok(!CORE.intakeResetPlan({ project, intake: null }).allowed, "ohne Fragebogen ist ein Zurücksetzen erlaubt");
  const fremd = CORE.intakeResetPlan({ project: { id: "prj_2" }, intake });
  ok(!fremd.allowed, "ein fremdes Projekt darf diesen Fragebogen zurücksetzen");
  ok(/gehört nicht zu diesem Projekt/.test(fremd.reason), `die Begründung fehlt: ${fremd.reason}`);
  const frisch = CORE.intakeResetPlan({ project, intake: { boundProjectId: "prj_1", inviteToken: TOKEN } });
  ok(!frisch.allowed, "ein unbeantworteter Fragebogen lässt sich zurücksetzen");
  ok(/noch nicht beantwortet/.test(frisch.reason), `die Begründung fehlt: ${frisch.reason}`);
  ok(!CORE.intakeResetPlan({ project, intake: { boundProjectId: "prj_1", inviteToken: "zu-kurz", answeredAt: "x" } }).allowed,
    "ein Fragebogen ohne brauchbaren Token lässt sich zurücksetzen");

  // Erlaubt: der beantwortete Fragebogen dieses Projekts.
  const plan = CORE.intakeResetPlan({ project, intake, now: "2026-08-09T08:00:00.000Z" });
  ok(plan.allowed, `der beantwortete Fragebogen lässt sich nicht zurücksetzen: ${plan.reason}`);

  // Der Patch fasst genau drei Dinge an — und den Token nicht.
  ok(plan.intakePatch.answeredAt === "" && plan.intakePatch.submissionId === "",
    "Antwortzeitpunkt oder Einreichungsvermerk bleiben stehen");
  ok(plan.intakePatch.status === "open", "der Fragebogen gilt nach dem Plan nicht wieder als offen");
  ok(plan.intakePatch.projectId === "", "der Fragebogen gilt weiterhin als beantwortet");
  ok(plan.intakePatch.boundProjectId === "prj_1",
    "die Bindung an dieses Projekt wird nicht ausdrücklich gesetzt — eine neue Antwort fände es nicht");
  ok(!("inviteToken" in plan.intakePatch), "der Plan fasst den Einladungstoken an");
  ok(!("questions" in plan.intakePatch), "der Plan fasst die Fragen an");
  ok(plan.projectClears.join(",") === "ftIntakeDocument",
    `am Projekt wird mehr als der Fragebogen-Payload entfernt: ${plan.projectClears.join(",")}`);
  ok(plan.generation === 2, `die Fassung zählt nicht hoch: ${plan.generation}`);
  ok(plan.intakePatch.formGeneration === 2, "die neue Fassung steht nicht am Fragebogen");
  ok(plan.intakePatch.resetAt === "2026-08-09T08:00:00.000Z" && plan.intakePatch.resetCount === 1,
    "das Zurücksetzen wird nicht festgehalten");

  // Die Bestätigung nennt beide Seiten: was verschwindet und was bleibt.
  const text = plan.confirmText;
  ok(/wirklich zurücksetzen\?/.test(text), "die Bestätigung fragt nicht nach");
  ["Antwortstatus", "Antwortzeitpunkt", "Fragebogen-Payload"].forEach((wort) => {
    ok(text.includes(wort), `die Bestätigung nennt „${wort}“ nicht als Folge`);
  });
  ["Link", "Kundendaten", "Budget", "Offerten", "Kundenportal", "Offertenanfrage"].forEach((wort) => {
    ok(text.includes(wort), `die Bestätigung sagt nicht, dass „${wort}“ erhalten bleibt`);
  });
  ok(/Erhalten bleiben/.test(text), "die Bestätigung trennt Folgen und Nicht-Folgen nicht");
  ok(/keine zweite Aufgabe/.test(text), "die Bestätigung verspricht keine Aufgaben-Idempotenz");

  // Zweimal zurücksetzen zählt weiter hoch.
  const zweite = CORE.intakeResetPlan({
    project, intake: Object.assign({}, intake, { formGeneration: 2, resetCount: 1 }),
  });
  ok(zweite.generation === 3 && zweite.intakePatch.resetCount === 2,
    "ein zweites Zurücksetzen zählt nicht weiter");

  // Der Plan rechnet nur — er schreibt nicht.
  ok(intake.answeredAt === "2026-08-08T09:00:00.000Z" && intake.status === "answered",
    "der Plan hat den Fragebogen bereits verändert");
  ok(CORE.intakeFormGeneration({}) === 1 && CORE.intakeFormGeneration({ formGeneration: 4 }) === 4,
    "die Fassung eines Fragebogens wird falsch gelesen");
}

/* ══ Teil 2 — Laufzeit ════════════════════════════════════════════════════ */

let seed = 0;
function makeSandbox(seedData = null) {
  const data = seedData || { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  data.entities = data.entities || { projects: {}, tasks: {}, notes: {} };
  const written = {};
  const asked = [];
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __written: written, __toasts: [], __copied: [], __asked: asked,
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
    prompt: () => "",
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
    // Die Bestätigung ist steuerbar — genau darum geht es hier.
    __answer: true,
    confirm: (message) => { asked.push(message); return sandbox.__answer; },
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
  win.confirm = sandbox.confirm;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written, sandbox, asked };
}

const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const intakeTasks = (data) => Object.values(data.entities.tasks).filter((t) => t.source === "flowertech-intake");
const panelOf = (win, projectId) => strip(win.ftProjectPanel(projectId));

function projektLehner(data, extra = {}) {
  data.entities.projects.prj_lehner = Object.assign({
    id: "prj_lehner", title: "Lehner", projectType: "flowertech",
    pipelineStage: "lead", client: {}, createdAt: "2026-07-01T10:00:00.000Z",
  }, extra);
  return data.entities.projects.prj_lehner;
}

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

/* Ein Projekt mit beantwortetem, projektgebundenem Fragebogen — der Zustand,
   aus dem heraus zurückgesetzt wird. Die „Fehleingabe“ ist hier eine Antwort
   mit Testdaten. */
function beantwortetesProjekt(extra = {}, antworten = {}) {
  const ctx = makeSandbox();
  const project = projektLehner(ctx.data, Object.assign({ client: { company: "Lehner GmbH" }, budget: 30000 }, extra));
  ctx.win._ftCreateProjectIntakeLink("prj_lehner");
  const intake = Object.values(ctx.data.flowertech.intakes)[0];
  ctx.win._ftIngestSubmissions({
    sub_test: {
      id: "sub_test", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
      payload: {
        intakeTitle: intake.title,
        // Die Firma stand VORBELEGT auf dem Bogen; die Kundschaft lässt sie so
        // (eine Änderung wäre eine Korrektur und gewinnt, 4g-3).
        answers: vollstaendig(ctx.win, intake.id, Object.assign({ company: "Lehner GmbH" }, {
          projekt: "TESTEINGABE", need: "Test test test", "vision-idee": "Test",
        }, antworten)),
      },
    },
  });
  return Object.assign(ctx, { project, intake });
}

// ── 4. Der Knopf steht nur am beantworteten Fragebogen ────────────────────
{
  const { win, data } = makeSandbox();
  projektLehner(data);

  ok(!/Fragebogen zurücksetzen/.test(panelOf(win, "prj_lehner")),
    "ohne Fragebogen-Link steht der Rücksetz-Knopf in der Karte");

  win._ftCreateProjectIntakeLink("prj_lehner");
  ok(!/Fragebogen zurücksetzen/.test(panelOf(win, "prj_lehner")),
    "vor der Antwort steht der Rücksetz-Knopf in der Karte");

  const beantwortet = beantwortetesProjekt();
  const html = panelOf(beantwortet.win, "prj_lehner");
  ok(/Fragebogen zurücksetzen/.test(html), "nach der Antwort fehlt der Rücksetz-Knopf");
  ok(/_ftResetProjectIntake\('prj_lehner'\)/.test(html), "der Rücksetz-Knopf ist nicht verdrahtet");
  // Die Zeile sagt selbst, was sie tut und was sie nicht tut.
  ok(/Setzt ausschliesslich Antwortstatus, Antwortzeitpunkt und Fragebogen-Payload zurück/.test(html),
    "die Karte sagt nicht, was zurückgesetzt wird");
  ok(/Aufgaben bleiben unverändert/.test(html), "die Karte sagt nicht, dass die Aufgaben bleiben");
}

// ── 5. Ohne Bestätigung geschieht nichts ──────────────────────────────────
{
  const ctx = beantwortetesProjekt();
  ctx.sandbox.__answer = false;

  const vorher = JSON.stringify({ p: ctx.data.entities.projects, i: ctx.data.flowertech.intakes });
  ok(ctx.win._ftResetProjectIntake("prj_lehner") === false, "das Zurücksetzen lief trotz Ablehnung durch");
  ok(ctx.asked.length === 1, `es wurde ${ctx.asked.length}-mal nachgefragt statt genau einmal`);
  ok(/wirklich zurücksetzen\?/.test(ctx.asked[0]), "die Nachfrage nennt nicht, worum es geht");
  ok(/Erhalten bleiben/.test(ctx.asked[0]), "die Nachfrage nennt die Nicht-Folgen nicht");
  ok(JSON.stringify({ p: ctx.data.entities.projects, i: ctx.data.flowertech.intakes }) === vorher,
    "die Ablehnung hat trotzdem etwas verändert");
}

// ── 6. Das Zurücksetzen: nur die Antwort, sonst nichts ────────────────────
{
  const { win, data, written, project, intake } = beantwortetesProjekt({}, { email: "test@test.ch" });
  const token = intake.inviteToken;
  const link = CORE.intakeFormUrl(token);

  // Ein vollständiger Vorgang der Phase 2 — damit sichtbar wird, dass davon
  // nichts angefasst wird.
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
  win._ftReleaseClientPortal("prj_lehner");
  const portalLink = win._ftClientPortalLink("prj_lehner");
  ok(portalLink, "das Kundenportal liess sich nicht veröffentlichen");

  const aufgabeVorher = intakeTasks(data)[0];
  ok(aufgabeVorher && /Offertenanfrage/.test(aufgabeVorher.title), "die Aufgabe „Offertenanfrage“ fehlt vorher");
  const shareVorher = JSON.stringify(data.flowertech.shares.prj_lehner);
  const offertenVorher = JSON.stringify(data.flowertech.offers);

  ok(win._ftResetProjectIntake("prj_lehner") === true, "das Zurücksetzen lief nicht durch");

  // Zurückgesetzt: Status, Zeitpunkt, Payload.
  ok(!intake.answeredAt, `der Antwortzeitpunkt steht noch da: ${intake.answeredAt}`);
  ok(!intake.projectId, "der Fragebogen gilt weiterhin als beantwortet");
  ok(!intake.submissionId, "der Einreichungsvermerk steht noch da");
  ok(intake.status === "open", `der Fragebogen ist nicht wieder offen: ${intake.status}`);
  ok(intake.boundProjectId === "prj_lehner", "die Bindung an das Projekt ging verloren");
  ok(!project.ftIntakeDocument, "der Fragebogen-Payload steht noch am Projekt");

  // Erhalten: Link, Token, Projekt, Kundendaten, Budget, Offerten, Portal, Aufgaben.
  ok(intake.inviteToken === token, "der Einladungstoken wurde getauscht — der verschickte Link wäre tot");
  ok(win._ftProjectIntakeLink("prj_lehner") === link, "der Fragebogen-Link hat sich geändert");
  ok(data.entities.projects.prj_lehner === project, "das Projekt wurde ersetzt");
  ok(project.title === "Lehner", "der Projekttitel wurde verändert");
  ok(project.client.company === "Lehner GmbH", "die Kundendaten wurden verändert");
  ok(project.client.email === "test@test.ch",
    "die aus dem Fragebogen ergänzten Kundendaten wurden entfernt — sie bleiben ausdrücklich stehen");
  ok(project.budget === 30000, "das Budget wurde verändert");
  ok(JSON.stringify(data.flowertech.offers) === offertenVorher, "die Offerten wurden verändert");
  ok(JSON.stringify(data.flowertech.shares.prj_lehner) === shareVorher,
    "die Freigabe-Token des Projekts wurden verändert");
  ok(win._ftClientPortalLink("prj_lehner") === portalLink, "der Kundenportal-Link hat sich geändert");
  ok(win._ftPortalRelease("prj_lehner").published, "das Kundenportal wurde zurückgezogen");
  ok(intakeTasks(data).length === 1, `es gibt jetzt ${intakeTasks(data).length} Aufgaben statt genau einer`);
  ok(intakeTasks(data)[0] === aufgabeVorher, "die Aufgabe „Offertenanfrage“ wurde ersetzt");
  ok(Object.keys(data.entities.projects).length === 1, "es entstand ein zweites Projekt");

  // Der Verlauf hält das Zurücksetzen fest — und sagt, was NICHT geschah.
  const eintrag = (project.ftContactLog || [])[0];
  ok(eintrag && /zurückgesetzt/.test(eintrag.text), "das Zurücksetzen steht nicht im Verlauf");
  ok(/Aufgaben unverändert/.test(eintrag.text), "der Verlauf sagt nicht, dass die Aufgaben bleiben");

  // Die Karte zeigt wieder die unbeantwortete Zeile.
  const html = panelOf(win, "prj_lehner");
  ok(/Kundenadresse – Fragebogen &amp; Vision Room, Standard-AGB/.test(html),
    "die Karte trägt nicht wieder die vollständige Beschriftung");
  ok(!/Fragebogen beantwortet/.test(html), "die Karte behauptet weiterhin, der Fragebogen sei beantwortet");
  ok(!/Fragebogen zurücksetzen/.test(html), "der Rücksetz-Knopf steht nach dem Zurücksetzen weiterhin da");
  ok(html.includes(link), "der Fragebogen-Link fehlt nach dem Zurücksetzen in der Karte");
  ok(/Fragebogen-Link kopieren/.test(html) && /Fragebogen öffnen/.test(html),
    "Kopieren und Öffnen fehlen nach dem Zurücksetzen");
  ok(!/Fragebogen-Link erstellen/.test(html), "die Karte bietet einen zweiten Fragebogen-Link an");

  // Der öffentliche Fragebogen ist wieder offen — dieselbe Adresse, neue Fassung.
  const pfad = "flowertech/intakeForms/" + token;
  ok(written[pfad] && written[pfad].status === "open",
    `der öffentliche Fragebogen ist nicht wieder offen: ${written[pfad] && written[pfad].status}`);
  ok(written[pfad].generation === 2, `die Fassung wurde nicht hochgezählt: ${written[pfad].generation}`);
  ok(written[pfad].questions.length > 0, "der öffentliche Fragebogen hat keine Fragen mehr");
  const veroeffentlicht = JSON.stringify(written[pfad]);
  ok(!veroeffentlicht.includes("prj_lehner") && !veroeffentlicht.includes(intake.id),
    "der öffentliche Fragebogen trägt nach dem Zurücksetzen interne IDs");
  /* Die alten ANTWORTEN sind weg. Was aus ihnen ins Projekt ergänzt wurde
     (E-Mail, bisherige Website …), bleibt ausdrücklich Projektdatum — und steht
     deshalb als Vorbelegung wieder auf dem Bogen (4g-3), nirgends sonst. */
  const ohneVorbelegung = JSON.stringify(Object.assign({}, written[pfad], { prefill: null }));
  ok(!/Antwort |TESTEINGABE|test@test\.ch/.test(ohneVorbelegung),
    "der öffentliche Fragebogen trägt die alten Antworten — er ist nicht leer");
  ok(!/TESTEINGABE/.test(veroeffentlicht),
    "der Projektname aus der Testeingabe wurde als Vorbelegung ausgegeben — er steht nicht am Projekt");
  ok(written[pfad].prefill && written[pfad].prefill.values.email === "test@test.ch",
    "die am Projekt verbliebene E-Mail ist nach dem Zurücksetzen nicht vorbelegt");
  ok(!/kunde\.html|portalToken|ftTemplate|ftContract|termsConsent/.test(veroeffentlicht),
    "der öffentliche Fragebogen trägt Vorschau, Vertrag, AGB oder Kundenportal");
}

// ── 7. Ein zweites Zurücksetzen ist nicht möglich, ohne Antwort erst recht ─
{
  const ctx = beantwortetesProjekt();
  ok(ctx.win._ftResetProjectIntake("prj_lehner") === true, "das Zurücksetzen lief nicht durch");
  const fragen = ctx.asked.length;
  ok(ctx.win._ftResetProjectIntake("prj_lehner") === false,
    "ein bereits zurückgesetzter Fragebogen liess sich erneut zurücksetzen");
  ok(ctx.asked.length === fragen, "es wurde nachgefragt, obwohl es nichts zurückzusetzen gibt");
  const hinweis = ctx.win.__toasts[ctx.win.__toasts.length - 1];
  ok(hinweis && hinweis.type === "warn" && /noch nicht beantwortet/.test(hinweis.message),
    `der abgelehnte Versuch wird nicht erklärt: ${hinweis && hinweis.message}`);

  // Ein Projekt ohne Fragebogen: kein Absturz, eine verständliche Meldung.
  projektLehner(ctx.data, { id: "prj_neu" });
  ctx.data.entities.projects.prj_neu = Object.assign({}, ctx.data.entities.projects.prj_lehner, {
    id: "prj_neu", title: "Neu",
  });
  ok(ctx.win._ftResetProjectIntake("prj_neu") === false, "ein Projekt ohne Fragebogen liess sich zurücksetzen");
  ok(ctx.win._ftResetProjectIntake("gibt-es-nicht") === false, "ein unbekanntes Projekt liess sich zurücksetzen");
}

// ── 8. Erneute Einreichung: dasselbe Projekt, keine zweite Aufgabe ────────
{
  const { win, data, project, intake } = beantwortetesProjekt();
  const token = intake.inviteToken;
  const aufgabeVorher = intakeTasks(data)[0];
  win._ftResetProjectIntake("prj_lehner");

  // Die Kundschaft reicht neu ein — derselbe Link, neue Einreichung.
  ok(win._ftIngestSubmissions({
    sub_neu: {
      id: "sub_neu", kind: "intake", token: token, createdAt: "2026-08-09T09:00:00.000Z",
      payload: {
        intakeTitle: intake.title,
        answers: vollstaendig(win, intake.id, {
          projekt: "Lehner", company: "Lehner AG", name: "Rita Lehner", email: "rita@lehner.ch",
          need: "Neue Website mit Shop",
          "vision-idee": "Kundschaft bestellt direkt online",
          "vision-funktionen": "Warenkorb\nOnline-Zahlung",
        }),
      },
    },
  }) === 1, "die erneute Einreichung wurde nicht verarbeitet");

  ok(Object.keys(data.entities.projects).length === 1,
    `nach der erneuten Einreichung gibt es ${Object.keys(data.entities.projects).length} Projekte`);
  ok(data.entities.projects.prj_lehner === project, "die erneute Einreichung legte ein anderes Projekt an");
  ok(intakeTasks(data).length === 1, `es entstanden ${intakeTasks(data).length} Aufgaben statt genau einer`);
  ok(intakeTasks(data)[0] === aufgabeVorher,
    "die bestehende Aufgabe „Offertenanfrage“ wurde durch eine zweite ersetzt");
  ok(project.ftIntakeDocument, "der Fragebogen-Payload wurde nicht neu abgelegt");
  ok(JSON.stringify(project.ftIntakeDocument).includes("Warenkorb"),
    "der neue Fragebogen-Payload trägt die neuen Antworten nicht");
  ok(!JSON.stringify(project.ftIntakeDocument).includes("TESTEINGABE"),
    "der alte Fragebogen-Payload steht noch am Projekt");
  ok(intake.answeredAt === "2026-08-09T09:00:00.000Z", "die neue Antwortzeit wurde nicht festgehalten");
  ok(intake.inviteToken === token, "der Link hat sich über den ganzen Weg geändert");
  ok(project.ftVision && project.ftVision.features.includes("Warenkorb"),
    "der Vision Room wurde nicht nachgeführt");
  ok(/Fragebogen beantwortet/.test(panelOf(win, "prj_lehner")),
    "die Karte zeigt die erneute Antwort nicht");

  // Und der alte Eingang wirkt nicht noch einmal.
  win._ftIngestSubmissions({
    sub_test: {
      id: "sub_test", kind: "intake", token: token, createdAt: "2026-08-08T09:00:00.000Z",
      payload: { intakeTitle: intake.title, answers: vollstaendig(win, intake.id) },
    },
  });
  ok(intakeTasks(data).length === 1, "ein nachgereichter alter Eingang erzeugte eine zweite Aufgabe");
  ok(Object.keys(data.entities.projects).length === 1, "ein nachgereichter alter Eingang erzeugte ein zweites Projekt");
}

// ── 9. Auch ein aus dem Fragebogen ENTSTANDENES Projekt lässt sich zurücksetzen ─
{
  const { win, data } = makeSandbox();
  win._ftNewDoc("offer");
  const doc = data.flowertech.offers.find((o) => !o.projectId);
  doc.client = { company: "Beiz AG" };
  doc.items = [{ id: "it_1", description: "Website", qty: 1, unit: "Pauschal", price: 4500, discountPercent: 0 }];
  win._ftCreateOfferIntakeLink(doc.id);
  const intake = Object.values(data.flowertech.intakes)[0];
  const token = intake.inviteToken;

  win._ftIngestSubmissions({
    sub_1: {
      id: "sub_1", kind: "intake", token: token, createdAt: "2026-08-08T09:00:00.000Z",
      payload: { intakeTitle: intake.title, answers: vollstaendig(win, intake.id) },
    },
  });
  const projectId = Object.keys(data.entities.projects)[0];
  ok(projectId && intake.projectId === projectId, "aus dem Fragebogen entstand kein Projekt");
  const aufgabe = intakeTasks(data)[0];

  ok(win._ftResetProjectIntake(projectId) === true,
    "das aus dem Fragebogen entstandene Projekt liess sich nicht zurücksetzen");
  ok(intake.boundProjectId === projectId,
    "der Fragebogen ist nach dem Zurücksetzen nicht an dieses Projekt gebunden");
  ok(!intake.projectId && !intake.answeredAt, "der Fragebogen gilt weiterhin als beantwortet");
  ok(data.flowertech.offers.length === 1 && data.flowertech.offers[0].projectId === projectId,
    "die zugeordnete Offerte wurde verändert");

  // Die erneute Einreichung findet DASSELBE Projekt — kein zweites.
  ok(win._ftIngestSubmissions({
    sub_2: {
      id: "sub_2", kind: "intake", token: token, createdAt: "2026-08-09T09:00:00.000Z",
      payload: { intakeTitle: intake.title, answers: vollstaendig(win, intake.id, { projekt: "Beiz" }) },
    },
  }) === 1, "die erneute Einreichung wurde nicht verarbeitet");
  ok(Object.keys(data.entities.projects).length === 1,
    `es entstand ein zweites Projekt: ${Object.keys(data.entities.projects).join(", ")}`);
  ok(intakeTasks(data).length === 1 && intakeTasks(data)[0] === aufgabe,
    "es entstand eine zweite Aufgabe „Offertenanfrage“");
  ok(data.flowertech.offers.length === 1, "es entstand eine zweite Offerte");
}

/* ══ Teil 3 — Die öffentlichen Seiten und der Eingang ═════════════════════ */

// ── 10. Kein Zurücksetzen in der öffentlichen Kundenseite ─────────────────
{
  ["public/flowertech-kunde.html", "public/flowertech-formular.html"].forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    ok(!/zurücksetzen|zuruecksetzen|_ftResetProjectIntake|intakeResetPlan/i.test(source),
      `${file} bietet ein Zurücksetzen an — das gehört ausschliesslich in die App`);
  });
  // Auch der Eingang kennt keine Art „reset“: Das Zurücksetzen ist eine
  // administrative Handlung in Quantus, keine Kundeneingabe.
  const portal = fs.readFileSync(path.join(root, "netlify/functions/flowertech-portal.mjs"), "utf8");
  const kinds = portal.match(/const kind = \[([^\]]*)\]/);
  ok(kinds && !/reset/.test(kinds[1]), "der öffentliche Eingang lässt eine Art „reset“ zu");
}

// ── 11. Der Eingang verwirft die Antwort nach dem Zurücksetzen nicht ──────
{
  const portal = fs.readFileSync(path.join(root, "netlify/functions/flowertech-portal.mjs"), "utf8");
  ok(/ft_intake_\$\{token\}\$\{intakeGeneration > 1 \? `_g\$\{intakeGeneration\}` : ""\}/.test(portal),
    "der Idempotenz-Schlüssel des Fragebogens kennt die Fassung nicht — die erste Antwort nach "
    + "einem Zurücksetzen würde als Wiederholung verworfen");
  ok(/published\.generation/.test(portal),
    "die Fassung wird nicht aus dem veröffentlichten Fragebogen gelesen");
  ok(/let intakeGeneration = 1/.test(portal),
    "ohne Fassung gilt nicht der bisherige Schlüssel — bereits verschickte Fragebogen verlören ihre Idempotenz");
}

console.log(`flowertech fragebogen-reset: ok (${checks} Pruefungen)`);
