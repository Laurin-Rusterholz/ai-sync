/*
 * FlowerTech — EIN Kundenlink, der mitwächst · und ein sichtbarer Prompt.
 * ---------------------------------------------------------------------------
 * Zwei Befunde, ein Test:
 *
 *   A) Die Kundschaft soll genau EINE Adresse lernen. Bisher war der
 *      projektgebundene Fragebogen-Link nur ein Formular: Wollte ich später
 *      eine Offerte oder eine Vorschau zeigen, brauchte es einen zweiten Link.
 *      Neu wächst derselbe Link in Stufen — und zeigt auf jeder Stufe genau
 *      das, was ausdrücklich freigegeben ist. Entwürfe nie.
 *
 *   B) Der Reiter „Claude-Prompt" war leer, wo kein internes Bedarfsformular
 *      ausgefüllt war: Er las ausschliesslich das Briefing. Neu zeigt er den
 *      vollständigen Projekt-Prompt aus ALLEN Daten — samt Quellen, Stand und
 *      fehlenden Angaben.
 *
 * Bewiesen wird:
 *
 *   1.  Die Stufen sind benannt; jede sagt, was sie zeigt und was nicht.
 *   2.  Eine Offerte ist erst nach echtem Versand öffentlich — ein Entwurf nie.
 *   3.  Die Offerten-Kachel trägt Dokument, Betrag, Gültigkeit und Status; das
 *       Dokument ist entschärft.
 *   4.  Vorschau und Verwaltung erscheinen nur nach ausdrücklicher Freigabe,
 *       die Verwaltung nie vor der Vorschau.
 *   5.  Der veröffentlichte Kundenbereich ist eine Positivliste — keine
 *       internen IDs, kein Vertrag, keine AGB, kein Kundenportal.
 *   6.  Laufzeit: Stufe 1 → Offerte versendet → Vorschau freigegeben. Immer
 *       dieselbe Adresse, derselbe Token.
 *   7.  Der Kundenlink steht in der Offertenmail.
 *   8.  Änderungswünsche über den Kundenlink zählen erst ab der Vorschau.
 *   9.  Widerruf wirkt sofort; der Link bleibt gültig.
 *   10. Der Prompt-Reiter ist nie leer, gliedert sich vollständig und trägt
 *       Fragebogen, Vision Room, Budget/Frist, Leistung und Offerte.
 *   11. Die fünf Knöpfe sind da; der Upload legt nur ab und veröffentlicht nie.
 *   12. Fragebogen-Reset, alte Portal-Links und die Offerte ohne Projekt
 *       bleiben unberührt.
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

const TOKEN = "k".repeat(32);
const PROJEKT = { id: "prj_1", title: "Lehner" };
const PROMPT_DA = { text: "# Auftrag: Lehner", updatedAt: "2026-08-08T10:00:00.000Z" };
const VERSENDET = {
  id: "of_1", number: "OF-2026-001", title: "Website Lehner", status: "sent",
  sentAt: "2026-08-08T09:00:00.000Z", validUntil: "2026-09-30",
  items: [{ description: "Website, 5 Seiten", detail: "inkl. Bildbearbeitung" }],
};

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Die Stufen sagen, was sie zeigen und was nicht ─────────────────────
{
  const keys = CORE.CUSTOMER_AREA_STAGES.map((s) => s.key);
  // Der Vertrag ist als eigene Stufe dazugekommen: Der eine Kundenlink zeigt
  // seit August 2026 die vollstaendige Kundensicht.
  ok(keys.join(",") === "intake,offer,preview,contract,admin",
    `die Stufen des Kundenbereichs stimmen nicht: ${keys.join(",")}`);
  CORE.CUSTOMER_AREA_STAGES.forEach((stage) => {
    ok(stage.label && stage.shows && stage.hides, `Stufe „${stage.key}“ ist nicht vollständig beschrieben`);
  });
  ok(/Entwürfe nie/.test(CORE.CUSTOMER_AREA_STAGES[1].hides),
    "die Offerten-Stufe sagt nicht, dass Entwürfe draussen bleiben");
  const stufe = (key) => CORE.CUSTOMER_AREA_STAGES.find((s) => s.key === key);
  ok(/Freigabe/.test(stufe("admin").hides),
    "die Verwaltungs-Stufe nennt die eigene Freigabe nicht");
  ok(/Freigabe/.test(stufe("contract").hides),
    "die Vertrags-Stufe nennt die eigene Freigabe nicht");
}

// ── 2. Entwurf ist keine Offerte ──────────────────────────────────────────
{
  ok(CORE.customerOfferIsPublic(VERSENDET), "eine versendete Offerte gilt nicht als öffentlich");
  ok(!CORE.customerOfferIsPublic({ status: "draft", sentAt: "2026-08-08T09:00:00.000Z" }),
    "ein Entwurf gilt als öffentlich — auch mit Versanddatum");
  ok(!CORE.customerOfferIsPublic({ status: "sent" }),
    "eine Offerte ohne echtes Versanddatum gilt als öffentlich");
  ok(!CORE.customerOfferIsPublic(null) && !CORE.customerOfferIsPublic({}),
    "aus dem Nichts entsteht eine öffentliche Offerte");
  ["accepted", "declined", "expired"].forEach((status) => {
    ok(CORE.customerOfferIsPublic(Object.assign({}, VERSENDET, { status })),
      `eine ${status}-Offerte verschwindet aus dem Kundenbereich`);
  });

  // Von mehreren zählt die jüngste — und Entwürfe zählen nie mit.
  const jüngste = CORE.customerAreaOffer([
    Object.assign({}, VERSENDET, { id: "of_alt", sentAt: "2026-07-01T09:00:00.000Z" }),
    Object.assign({}, VERSENDET, { id: "of_neu", sentAt: "2026-08-08T09:00:00.000Z" }),
    { id: "of_entwurf", status: "draft" },
  ]);
  ok(jüngste && jüngste.id === "of_neu", `es gilt die falsche Offerte: ${jüngste && jüngste.id}`);
  ok(CORE.customerAreaOffer([{ status: "draft" }]) === null, "ein Entwurf wird zur gültigen Offerte");
}

// ── 3. Die Offerten-Kachel: Dokument, Betrag, Gültigkeit, Status ──────────
{
  const tile = CORE.customerOfferTile({
    offer: VERSENDET, amount: 4500.5, today: "2026-08-10",
    documentHtml: "<html><body><h1>Offerte</h1><script>alert(1)</script></body></html>",
  });
  ok(tile.label === "Offerte", "die Kachel ist nicht als Offerte benannt");
  ok(tile.number === "OF-2026-001" && tile.title === "Website Lehner", "Nummer oder Titel fehlen");
  ok(tile.amount === 4500.5 && tile.currency === "CHF", `der Betrag stimmt nicht: ${tile.amount}`);
  ok(tile.validUntil === "2026-09-30", "die Gültigkeit fehlt");
  ok(tile.status === "sent" && tile.statusLabel === "Versendet", "der Status ist nicht benannt");
  ok(tile.sentAt === VERSENDET.sentAt, "der Versandzeitpunkt fehlt");
  ok(tile.expired === false, "eine gültige Offerte gilt als abgelaufen");
  ok(/<h1>Offerte<\/h1>/.test(tile.document.html), "das Dokument fehlt in der Kachel");
  ok(!/<script/i.test(tile.document.html), "das Offertendokument geht mit Skript hinaus");
  ok(tile.document.url === "", "aus dem Nichts entsteht eine Dokumentadresse");

  const abgelaufen = CORE.customerOfferTile({ offer: VERSENDET, amount: 10, today: "2026-10-01" });
  ok(abgelaufen.expired === true, "eine abgelaufene Offerte gilt weiterhin als gültig");
  ok(CORE.customerOfferTile({ offer: { status: "draft" } }) === null,
    "aus einem Entwurf entsteht eine Kachel");
}

// ── 4. Vorschau und Verwaltung: zwei getrennte, ausdrückliche Freigaben ───
{
  const ohneUrl = CORE.customerPreviewRelease({ project: PROJEKT, prompt: PROMPT_DA });
  ok(!ohneUrl.visible && /HTTPS-Vorschau-Adresse/.test(ohneUrl.reason),
    `ohne Adresse fehlt die Begründung: ${ohneUrl.reason}`);

  const mitUrl = { id: "prj_1", previewUrl: "https://vorschau.lehner.ch/entwurf" };
  ok(!CORE.customerPreviewRelease({ project: mitUrl, prompt: null }).visible,
    "ohne Prompt wird die Vorschau gezeigt");
  ok(/Prompt/.test(CORE.customerPreviewRelease({ project: mitUrl, prompt: null }).reason),
    "der fehlende Prompt wird nicht benannt");

  const bereit = CORE.customerPreviewRelease({ project: mitUrl, prompt: PROMPT_DA });
  ok(bereit.ready && !bereit.visible, "die blosse Adresse zeigt die Vorschau bereits");
  ok(/noch nicht freigegeben/.test(bereit.reason), `die Begründung fehlt: ${bereit.reason}`);

  const frei = CORE.customerPreviewRelease({
    project: Object.assign({}, mitUrl, { ftCustomerPreview: { released: true, releasedAt: "2026-08-09" } }),
    prompt: PROMPT_DA,
  });
  ok(frei.visible && frei.releasedAt === "2026-08-09", "die freigegebene Vorschau erscheint nicht");

  // Kein http, kein javascript:, nichts Erfundenes.
  ok(!CORE.customerPreviewRelease({
    project: { id: "prj_1", previewUrl: "http://vorschau.lehner.ch", ftCustomerPreview: { released: true } },
    prompt: PROMPT_DA,
  }).visible, "eine unverschlüsselte Adresse geht an die Kundschaft");

  const adminOhneVorschau = CORE.customerAdminRelease({
    project: { adminUrl: "https://admin.lehner.ch/login", ftCustomerAdmin: { released: true } },
    previewVisible: false,
  });
  ok(!adminOhneVorschau.visible && /Vorschau/.test(adminOhneVorschau.reason),
    "die Verwaltung erscheint vor der Vorschau");
  ok(CORE.customerAdminRelease({
    project: { adminUrl: "https://admin.lehner.ch/login", ftCustomerAdmin: { released: true } },
    previewVisible: true,
  }).visible, "die freigegebene Verwaltung erscheint nicht");
  ok(!CORE.customerAdminRelease({
    project: { adminUrl: "https://admin.lehner.ch/login" }, previewVisible: true,
  }).visible, "die Verwaltung erscheint ohne ausdrückliche Freigabe");
}

// ── 5. Der Zustand und der veröffentlichte Bereich ────────────────────────
{
  const intake = { inviteToken: TOKEN, boundProjectId: "prj_1", title: "Fragebogen", questions: [] };
  const stufe1 = CORE.customerAreaState({ project: PROJEKT, intake, offers: [{ status: "draft" }] });
  ok(stufe1.stage === "intake", `Stufe 1 heisst nicht „intake“: ${stufe1.stage}`);
  ok(stufe1.url === "https://flowertech.ch/fragebogen.html?e=" + TOKEN, "die Adresse stimmt nicht");
  ok(!stufe1.tiles.offer && !stufe1.tiles.preview && !stufe1.tiles.admin,
    "auf Stufe 1 steht bereits eine Kachel");
  ok(/Entwürfe/.test(stufe1.stages[1].reason), "der Entwurf wird nicht als Grund benannt");

  const stufe2 = CORE.customerAreaState({ project: PROJEKT, intake, offers: [VERSENDET], offerAmount: 4500 });
  ok(stufe2.stage === "offer" && stufe2.tiles.offer, "die versendete Offerte erreicht die Stufe 2 nicht");
  ok(stufe2.url === stufe1.url, "die Adresse ändert sich mit der Stufe");

  const stufe3 = CORE.customerAreaState({
    project: Object.assign({}, PROJEKT, {
      previewUrl: "https://vorschau.lehner.ch/entwurf", ftCustomerPreview: { released: true },
      adminUrl: "https://admin.lehner.ch/login", ftCustomerAdmin: { released: true },
    }),
    intake, offers: [VERSENDET], offerAmount: 4500, prompt: PROMPT_DA,
  });
  ok(stufe3.stage === "preview", `Stufe 3 heisst nicht „preview“: ${stufe3.stage}`);
  ok(stufe3.tiles.preview.url === "https://vorschau.lehner.ch/entwurf", "die Vorschau-Adresse fehlt");
  ok(stufe3.tiles.preview.feedback === true, "die Vorschau erlaubt keine Änderungswünsche");
  ok(stufe3.tiles.admin.url === "https://admin.lehner.ch/login", "die Verwaltungs-Adresse fehlt");
  ok(stufe3.url === stufe1.url, "die Adresse ändert sich auf der letzten Stufe");
  /* Vier von fuenf: Der Vertrag ist als eigene Stufe dazugekommen und hier
     bewusst nicht freigegeben — genau das soll man sehen. */
  ok(stufe3.visibleLabels.length === 4, `sichtbar sind ${stufe3.visibleLabels.length} Stufen statt vier`);
  ok(stufe3.hiddenLabels.join(",") === "Vertrag",
    `verborgen ist nicht nur der Vertrag: ${stufe3.hiddenLabels.join(",")}`);

  // Mit freigegebenem Vertrag ist wirklich alles sichtbar — auf derselben Adresse.
  const mitVertrag = CORE.customerAreaState({
    project: Object.assign({}, PROJEKT, {
      previewUrl: "https://vorschau.lehner.ch/entwurf", ftCustomerPreview: { released: true },
      adminUrl: "https://admin.lehner.ch/login", ftCustomerAdmin: { released: true },
      ftCustomerContract: { released: true },
    }),
    intake, offers: [VERSENDET], offerAmount: 4500, prompt: PROMPT_DA,
    contractHtml: "<h1>Projektauftrag</h1>", contractTitle: "Projektauftrag",
  });
  ok(mitVertrag.hiddenLabels.length === 0, "mit freigegebenem Vertrag bleibt etwas verborgen");
  ok(mitVertrag.url === stufe1.url, "die Adresse ändert sich mit dem Vertrag");

  ok(CORE.customerAreaState({ project: PROJEKT, intake: null }).stage === "none",
    "ohne Kundenlink entsteht trotzdem eine Stufe");

  // Der veröffentlichte Bereich ist eine Positivliste.
  const snapshot = CORE.customerAreaSnapshot({
    intake: Object.assign({}, intake, { questions: CORE.DEFAULT_INTAKE_QUESTIONS }),
    project: Object.assign({}, PROJEKT, {
      client: { company: "Lehner GmbH", email: "rita@lehner.ch" }, budget: 30000,
      ftIntakeDocument: { answers: [] }, ftContactLog: [{ text: "intern" }],
    }),
    offers: [VERSENDET, { status: "draft", title: "Geheimer Entwurf" }],
    offerAmount: 4500, company: { name: "FlowerTech" }, now: "2026-08-09T10:00:00.000Z",
  });
  const erlaubt = ["schema", "title", "intro", "questions", "status", "company", "generation",
    "stage", "tiles", "updatedAt"];
  Object.keys(snapshot).forEach((key) => {
    ok(erlaubt.includes(key), `der Kundenbereich trägt das Feld „${key}“`);
  });
  const roh = JSON.stringify(snapshot);
  ok(!roh.includes("prj_1"), "die Projekt-ID steht im Kundenbereich");
  ok(!roh.includes("Geheimer Entwurf"), "ein Offerten-ENTWURF steht im Kundenbereich");
  ok(!roh.includes("rita@lehner.ch"), "die Mailadresse der Kundschaft steht im Kundenbereich");
  ok(!roh.includes("intern"), "ein interner Verlaufseintrag steht im Kundenbereich");
  ok(!/portalToken|termsConsent|ftContract|kunde\.html/.test(roh),
    "Vertrag, AGB oder Kundenportal stehen im Kundenbereich");
  ok(snapshot.stage === "offer" && snapshot.tiles.offer.number === "OF-2026-001",
    "die versendete Offerte fehlt im veröffentlichten Kundenbereich");
  ok(snapshot.questions.length > 0, "der Fragebogen selbst fehlt im Kundenbereich");
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
    prompt: () => "",
    open: () => null,
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
        set: (v) => { written[p] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); },
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
  return { win, data, written, sandbox };
}

const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const panelOf = (win, projectId) => strip(win.ftProjectPanel(projectId));
const promptTab = (win, projectId) => {
  win._ftSetProjectTab(projectId, "prompt");
  return strip(win.ftWorkflowPanel(projectId));
};
const intakeTasks = (data) => Object.values(data.entities.tasks).filter((t) => t.source === "flowertech-intake");
const publiziert = (written, token) => written["flowertech/intakeForms/" + token];

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

/* Ein Projekt mit Kundenlink und beantwortetem Fragebogen — der Normalfall,
   aus dem heraus die Stufen 2 und 3 entstehen. */
function projektMitKundenlink(extra = {}) {
  const ctx = makeSandbox();
  ctx.data.entities.projects.prj_lehner = Object.assign({
    id: "prj_lehner", title: "Lehner", projectType: "flowertech", pipelineStage: "lead",
    client: { company: "Lehner GmbH" }, budget: 30000, dueDate: "2026-11-01",
    createdAt: "2026-07-01T10:00:00.000Z",
  }, extra);
  ctx.win._ftCreateProjectIntakeLink("prj_lehner");
  const intake = Object.values(ctx.data.flowertech.intakes)[0];
  ctx.win._ftIngestSubmissions({
    sub_1: {
      id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
      payload: {
        intakeTitle: intake.title,
        answers: vollstaendig(ctx.win, intake.id, {
          projekt: "Lehner", need: "Mehr Reservationen über die Seite",
          audience: "Stammgäste und Laufkundschaft",
          pages: "Startseite\nMenü\nKontakt",
          features: "Tischreservation\nNewsletter",
          design: "Warm, Holz, ruhig",
          content: "Fotos vorhanden, Texte fehlen",
          iststand: "WordPress von 2014, sehr langsam",
          "vision-idee": "Gäste reservieren direkt online",
          "vision-funktionen": "Warenkorb\nOnline-Zahlung",
        }),
      },
    },
  });
  return Object.assign(ctx, { project: ctx.data.entities.projects.prj_lehner, intake });
}

/* Eine echte, versandfertige Offerte an diesem Projekt. */
function offerteAn(ctx, projectId) {
  ctx.win._ftNewDoc("offer", projectId);
  const offer = ctx.data.flowertech.offers.find((o) => o.projectId === projectId);
  offer.client = { company: "Lehner GmbH", name: "Rita Lehner" };
  offer.title = "Website Lehner";
  offer.items = [{ id: "it_1", description: "Website, 5 Seiten", qty: 1, unit: "Pauschal", price: 4500, discountPercent: 0 }];
  offer.validUntil = "2026-09-30";
  // Die Beilage gehört zum Weg „Offerte zuerst“ — ohne sie ist der Versand
  // blockiert, und genau das soll er auch bleiben.
  ctx.win._ftSetOfferAttachment(projectId, "vision");
  return offer;
}

// ── 6. Stufe 1: der Link zeigt ausschliesslich den Fragebogen ─────────────
{
  const { win, data, written, intake } = projektMitKundenlink();
  const bereich = win._ftCustomerArea("prj_lehner");
  ok(bereich.stage === "intake", `die frische Karte steht auf Stufe „${bereich.stage}“`);
  ok(bereich.url === CORE.intakeFormUrl(intake.inviteToken), "der Kundenlink stimmt nicht");

  const veröffentlicht = publiziert(written, intake.inviteToken);
  ok(veröffentlicht.stage === "intake", "der veröffentlichte Bereich steht nicht auf Stufe 1");
  ok(!veröffentlicht.tiles.offer && !veröffentlicht.tiles.preview && !veröffentlicht.tiles.admin,
    "auf Stufe 1 ist bereits eine Kachel veröffentlicht");

  // Die Karte sagt, was sichtbar ist — und was ausdrücklich nicht.
  const html = panelOf(win, "prj_lehner");
  ok(/Hinter diesem Link sichtbar/.test(html), "die Karte erklärt die Stufen nicht");
  ok(/Fragebogen – Kundendaten &amp; Vision Room/.test(html), "Stufe 1 fehlt in der Karte");
  ok(/Es ist noch keine Offerte versendet/.test(html),
    "die Karte sagt nicht, warum die Offerte noch nicht sichtbar ist");
  ok(/Vertrag, AGB und das Kundenportal bleiben ausserhalb dieses Links/.test(html),
    "die Karte sagt nicht, was ausserhalb dieses Links bleibt");
  ok(Object.keys(data.entities.projects).length === 1, "es entstand ein zweites Projekt");
}

// ── 7. Stufe 2: erst der wirkliche Versand zeigt die Offerte ──────────────
{
  const ctx = projektMitKundenlink();
  const { win, data, written, intake } = ctx;
  const offer = offerteAn(ctx, "prj_lehner");
  const token = intake.inviteToken;
  const link = CORE.intakeFormUrl(token);

  // Der Entwurf allein zeigt nichts.
  win._ftRefreshCustomerArea("prj_lehner");
  ok(!publiziert(written, token).tiles.offer, "ein Offerten-Entwurf steht im Kundenbereich");
  ok(win._ftCustomerArea("prj_lehner").stage === "intake", "ein Entwurf hebt die Stufe an");

  // Der Versand — und genau der zeigt sie.
  win._ftDocStatus("offer", offer.id, "sent");
  const bereich = win._ftCustomerArea("prj_lehner");
  ok(bereich.stage === "offer", `nach dem Versand steht der Bereich auf „${bereich.stage}“`);
  ok(bereich.url === link, "die Adresse hat sich mit dem Versand geändert");

  const kachel = publiziert(written, token).tiles.offer;
  ok(kachel, "die Offerte fehlt im veröffentlichten Kundenbereich");
  // Der Betrag ist der, den die Kundschaft zahlt: inklusive MWST.
  ok(kachel.amount === 4864.5, `der Betrag stimmt nicht: ${kachel.amount}`);
  ok(kachel.currency === "CHF", "die Währung fehlt");
  ok(kachel.validUntil === "2026-09-30", "die Gültigkeit fehlt");
  ok(kachel.statusLabel === "Versendet", "der Status fehlt");
  ok(kachel.number && /Website, 5 Seiten/.test(kachel.document.html),
    "das Offertendokument fehlt in der Kachel");
  ok(!/<script/i.test(kachel.document.html), "das Offertendokument trägt ein Skript");

  // Der Link ist derselbe geblieben, der Fragebogen steht weiterhin drin.
  ok(publiziert(written, token).questions.length > 0, "der Fragebogen verschwand mit der Offerte");
  ok(Object.keys(data.flowertech.intakes).length === 1, "es entstand ein zweiter Fragebogen");
  ok(intake.inviteToken === token, "der Token wurde getauscht");
  ok(!publiziert(written, token).tiles.preview, "die Vorschau erscheint mit der Offerte");

  // Und die Karte sagt es auch.
  const html = panelOf(win, "prj_lehner");
  ok(/✓<\/span><span class="ft-stage-body"><b>Offerte/.test(html.replace(/\s+/g, " "))
    || /Offerte<\/b> — Die versendete Offerte/.test(html),
    "die Karte zeigt die Offerten-Stufe nicht als sichtbar");
}

// ── 8. Der Kundenlink steht in der Offertenmail ───────────────────────────
{
  const ctx = projektMitKundenlink();
  const { win, intake } = ctx;
  const offer = offerteAn(ctx, "prj_lehner");
  win._ftDocStatus("offer", offer.id, "sent");
  const link = CORE.intakeFormUrl(intake.inviteToken);

  win._ftComposeTemplate("prj_lehner", "offer");
  const entwurf = win.__copied[win.__copied.length - 1];
  ok(entwurf.includes(link), `die Offertenmail enthält den Kundenlink nicht:\n${entwurf}`);
  ok(!/kunde\.html/.test(entwurf), "die Offertenmail enthält den Kundenportal-Link");
  ok(/derselbe Link wie beim Fragebogen/.test(entwurf),
    "die Mail sagt nicht, dass es derselbe Link ist");

  // Die Vorlage kennt die Variable — und sie ist gefüllt.
  ok(CORE.MESSAGE_TEMPLATES.find((m) => m.key === "offer").body.includes("{{kundenbereichLink}}"),
    "die Offertenvorlage kennt den Kundenbereich-Link nicht");
}

// ── 9. Stufe 3: Vorschau und Verwaltung, jede mit eigener Freigabe ────────
{
  const ctx = projektMitKundenlink();
  const { win, data, written, intake } = ctx;
  const token = intake.inviteToken;
  const link = CORE.intakeFormUrl(token);

  // Ohne Adresse lässt sich nichts freigeben.
  ok(win._ftReleaseCustomerPreview("prj_lehner", true) === false,
    "die Vorschau liess sich ohne Adresse freigeben");
  ok(!publiziert(written, token).tiles.preview, "die Vorschau wurde trotzdem veröffentlicht");

  // Die blosse Adresse zeigt noch nichts — das ist der ganze Punkt.
  win._ftSetProjectField("prj_lehner", "previewUrl", "https://vorschau.lehner.ch/entwurf");
  win._ftRefreshCustomerArea("prj_lehner");
  ok(!publiziert(written, token).tiles.preview,
    "die blosse Vorschau-Adresse erscheint ohne Freigabe im Kundenbereich");

  // Die Verwaltung geht nie vor der Vorschau.
  win._ftSetProjectField("prj_lehner", "adminUrl", "https://admin.lehner.ch/login");
  ok(win._ftReleaseCustomerAdmin("prj_lehner", true) === false,
    "die Verwaltung liess sich vor der Vorschau freigeben");

  // Freigabe der Vorschau: jetzt erscheint genau diese Adresse.
  ok(win._ftReleaseCustomerPreview("prj_lehner", true) === true, "die Vorschau liess sich nicht freigeben");
  const mitVorschau = publiziert(written, token);
  ok(mitVorschau.stage === "preview", `die Stufe stimmt nicht: ${mitVorschau.stage}`);
  ok(mitVorschau.tiles.preview.url === "https://vorschau.lehner.ch/entwurf",
    "im Kundenbereich steht eine andere Vorschau-Adresse");
  ok(mitVorschau.tiles.preview.feedback === true, "die Kundschaft kann keine Änderungswünsche melden");
  ok(!mitVorschau.tiles.admin, "die Verwaltung erschien mit der Vorschau von selbst");

  // Erst jetzt die Verwaltung — und nur mit eigener Freigabe.
  ok(win._ftReleaseCustomerAdmin("prj_lehner", true) === true, "die Verwaltung liess sich nicht freigeben");
  ok(publiziert(written, token).tiles.admin.url === "https://admin.lehner.ch/login",
    "im Kundenbereich steht eine andere Verwaltungsadresse");

  // Der Link ist über alle drei Stufen derselbe geblieben.
  ok(win._ftProjectIntakeLink("prj_lehner") === link, "der Kundenlink hat sich über die Stufen geändert");
  ok(Object.keys(data.flowertech.intakes).length === 1, "es entstand ein zweiter Fragebogen");
  ok(publiziert(written, token).questions.length > 0, "der Fragebogen verschwand auf Stufe 3");

  // Widerruf wirkt sofort — der Link bleibt.
  ok(win._ftReleaseCustomerPreview("prj_lehner", false) === true, "die Vorschau liess sich nicht zurückziehen");
  ok(!publiziert(written, token).tiles.preview, "die zurückgezogene Vorschau steht weiterhin draussen");
  ok(!publiziert(written, token).tiles.admin,
    "die Verwaltung bleibt sichtbar, obwohl die Vorschau zurückgezogen wurde");
  ok(win._ftProjectIntakeLink("prj_lehner") === link, "der Widerruf hat den Link geändert");
}

// ── 10. Änderungswünsche über den Kundenlink — erst ab der Vorschau ───────
{
  const ctx = projektMitKundenlink();
  const { win, data, intake } = ctx;
  const wunsch = {
    id: "sub_c1", kind: "change", token: intake.inviteToken, createdAt: "2026-08-09T09:00:00.000Z",
    payload: { title: "Anderes Bild auf der Startseite", detail: "Bitte eine Aussenaufnahme." },
  };

  win._ftIngestSubmissions({ sub_c1: wunsch });
  ok(data.flowertech.changeRequests.length === 0,
    "ein Änderungswunsch wurde angenommen, bevor die Vorschau freigegeben war");

  win._ftSetProjectField("prj_lehner", "previewUrl", "https://vorschau.lehner.ch/entwurf");
  win._ftReleaseCustomerPreview("prj_lehner", true);
  ok(win._ftIngestSubmissions({ sub_c2: Object.assign({}, wunsch, { id: "sub_c2" }) }) === 1,
    "der Änderungswunsch aus dem Kundenbereich wurde nicht verarbeitet");
  const cr = data.flowertech.changeRequests[0];
  ok(cr && cr.projectId === "prj_lehner", "der Änderungswunsch hängt nicht am Projekt");
  ok(cr.title === "Anderes Bild auf der Startseite", "der Änderungswunsch kam unvollständig an");
  ok(cr.origin === "client", "der Änderungswunsch gilt nicht als Kundeneingabe");
  ok(cr.taskId && data.entities.tasks[cr.taskId], "aus dem Änderungswunsch entstand keine Aufgabe");
  ok(Object.keys(data.entities.projects).length === 1, "der Änderungswunsch legte ein Projekt an");
}

// ── 11. Der Prompt-Reiter ist nie leer und vollständig gegliedert ─────────
{
  const ctx = projektMitKundenlink();
  const { win, data } = ctx;
  const offer = offerteAn(ctx, "prj_lehner");
  win._ftDocStatus("offer", offer.id, "sent");
  win._ftRegeneratePrompt("prj_lehner");

  const text = data.entities.projects.prj_lehner.ftPrompt.text;
  [
    "## Projektkontext", "## Ziel und Zielgruppe", "## Bestehende Seite (Iststand)",
    "## Inhalte", "## Funktionen", "## Design", "## Daten, SEO und Barrierefreiheit",
    "## Budget und Termin", "## Lieferumfang", "## Nicht erfinden",
    "## Konkrete nächste Schritte",
  ].forEach((abschnitt) => {
    ok(text.includes(abschnitt), `im Prompt fehlt der Abschnitt „${abschnitt}“`);
  });

  // Er trägt wirklich ALLE bisherigen Daten.
  [
    "Mehr Reservationen über die Seite",     // Ziel aus dem Fragebogen
    "Stammgäste und Laufkundschaft",         // Zielgruppe
    "WordPress von 2014",                    // Iststand
    "Tischreservation",                      // Funktionen
    "Warm, Holz, ruhig",                     // Design
    "Fotos vorhanden",                       // Inhalte
    "CHF 30000.00",                          // Budget
    "2026-11-01",                            // Termin
    "Warenkorb",                             // Vision Room
    "Website, 5 Seiten",                     // Lieferumfang aus der Offerte
    "CHF 4864.50",                           // Offertenbetrag inkl. MWST
    "2026-09-30",                            // Gültigkeit
  ].forEach((teil) => ok(text.includes(teil), `im Prompt fehlt: ${teil}`));

  // Kontaktdaten bleiben ohne ausdrückliche Wahl draussen.
  ok(!text.includes("rita@lehner.ch"), "die Mailadresse steht ungefragt im Prompt");

  const html = promptTab(win, "prj_lehner");
  ok(/Projektspezifischer Prompt/.test(html), "der Reiter zeigt keinen Projekt-Prompt");
  ok(html.includes("## Konkrete nächste Schritte"), "der Reiter zeigt den Prompt nicht wirklich an");
  ok(html.replace(/\s+/g, " ").includes("Mehr Reservationen über die Seite"),
    "der angezeigte Prompt ist leer oder unvollständig");
  ok(/Quellen und Stand/.test(html), "der Reiter nennt die Quellen nicht");
  ok(/Fragebogen<\/span>|Fragebogen<small>/.test(html) || /Fragebogen/.test(html),
    "der Fragebogen fehlt in der Quellenliste");
  ok(/Offerte/.test(html) && /Vision Room/.test(html), "Offerte oder Vision Room fehlen in der Quellenliste");
  ok(/Stand /.test(html), "der Reiter zeigt keinen Stand");

  // Die fünf Knöpfe.
  [
    ["Prompt kopieren", "_ftCopyPrompt"],
    [".md herunterladen", "_ftDownloadPrompt"],
    ["HTML-Vorlage herunterladen", "_ftDownloadTemplate"],
    ["HTML-Vorlage hochladen", "_ftUploadTemplate"],
    ["Prompt für Claude Code kopieren", "_ftCopyClaudePrompt"],
  ].forEach(([label, fn]) => {
    ok(html.includes(label), `im Reiter fehlt der Knopf „${label}“`);
    ok(html.includes(fn), `der Knopf „${label}“ ist nicht verdrahtet`);
  });
  ok(/veröffentlicht nichts/.test(html), "der Reiter sagt nicht, dass der Upload nichts veröffentlicht");
}

// ── 12. Auch ohne Fragebogen ist der Prompt-Reiter nicht leer ─────────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_neu = {
    id: "prj_neu", title: "Neues Projekt", projectType: "flowertech", pipelineStage: "lead", client: {},
  };
  const html = promptTab(win, "prj_neu");
  ok(html.length > 500, "der Reiter ist für ein frisches Projekt leer");
  ok(/# Auftrag: Neues Projekt/.test(html), "der Prompt nennt das Projekt nicht");
  ok(/## Konkrete nächste Schritte/.test(html), "der Prompt ist unvollständig");
  ok(/Fehlende Angaben/.test(html), "der Reiter nennt die fehlenden Angaben nicht");
  ["Ziel des Vorhabens", "Zielgruppe", "Budgetrahmen", "Wunschtermin"].forEach((teil) => {
    ok(html.includes(teil), `in den fehlenden Angaben fehlt „${teil}“`);
  });
  ok(win._ftBuildPrompt("prj_neu").includes("Offen und deshalb nicht zu erfinden"),
    "der Prompt benennt die offenen Punkte nicht");
}

// ── 13. Der Upload legt nur ab — er veröffentlicht nie ────────────────────
{
  const ctx = projektMitKundenlink();
  const { win, data, written, intake } = ctx;
  const html = "<html><body><h1>Meine Vorlage</h1></body></html>";
  win._ftSetProjectField("prj_lehner", "previewUrl", "https://vorschau.lehner.ch/entwurf");

  // Derselbe Weg, den der Knopf geht — nur ohne Datei-Dialog.
  win.FileReader = function () {
    const self = this;
    self.readAsText = (file) => { self.result = file.__text; self.onload(); };
  };
  win._ftUploadTemplate("prj_lehner", { files: [{ name: "vorlage.html", size: html.length, __text: html }] });
  const project = data.entities.projects.prj_lehner;
  ok(project.ftTemplate && project.ftTemplate.html.includes("Meine Vorlage"),
    "die hochgeladene Vorlage liegt nicht am Projekt");
  ok(project.ftTemplate.source === "hochgeladen", "die Herkunft der Vorlage fehlt");
  ok(!publiziert(written, intake.inviteToken).tiles.preview,
    "der Upload hat die Vorschau veröffentlicht");
  ok(!Object.keys(written).some((k) => k.startsWith("flowertech/clientPortals/")),
    "der Upload hat ein Kundenportal veröffentlicht");
  ok(win._ftCustomerArea("prj_lehner").stage === "intake",
    "der Upload allein hat die Stufe angehoben");
}

// ── 14. Zurücksetzen, altes Kundenportal und Offerte ohne Projekt ─────────
{
  const ctx = projektMitKundenlink();
  const { win, data, written, intake } = ctx;
  const token = intake.inviteToken;
  const offer = offerteAn(ctx, "prj_lehner");
  win._ftDocStatus("offer", offer.id, "sent");
  const aufgaben = intakeTasks(data).length;

  // Der Reset bleibt konservativ: Er nimmt die Antwort zurück, nicht die Stufe.
  ok(win._ftResetProjectIntake("prj_lehner") === true, "das Zurücksetzen lief nicht durch");
  ok(win._ftProjectIntakeLink("prj_lehner") === CORE.intakeFormUrl(token),
    "das Zurücksetzen hat den Kundenlink geändert");
  const nachReset = publiziert(written, token);
  ok(nachReset.status === "open", "der Fragebogen ist nach dem Zurücksetzen nicht wieder offen");
  ok(nachReset.tiles.offer, "das Zurücksetzen hat die versendete Offerte aus dem Kundenbereich entfernt");
  ok(intakeTasks(data).length === aufgaben, "das Zurücksetzen hat die Aufgabenlage verändert");
  ok(data.flowertech.offers.length === 1, "das Zurücksetzen hat die Offerte angefasst");

  // Das Kundenportal bleibt ein eigener Weg mit eigener Freigabe.
  ok(win._ftClientPortalLink("prj_lehner") === "",
    "der Kundenbereich hat nebenbei ein Kundenportal veröffentlicht");
  ok(!Object.keys(written).some((k) => k.startsWith("flowertech/clientPortals/")),
    "es wurde ein Kundenportal-Snapshot geschrieben");
}

// ── 15. Eine Offerte OHNE Projekt behält ihren Link, wenn ein Projekt entsteht ─
{
  const { win, data, written } = makeSandbox();
  win._ftNewDoc("offer");
  const doc = data.flowertech.offers.find((o) => !o.projectId);
  doc.client = { company: "Beiz AG" };
  doc.items = [{ id: "it_1", description: "Website", qty: 1, unit: "Pauschal", price: 4500, discountPercent: 0 }];

  win._ftCreateOfferIntakeLink(doc.id);
  const intake = Object.values(data.flowertech.intakes)[0];
  const token = intake.inviteToken;
  ok(publiziert(written, token).stage === "intake",
    "eine Offerte ohne Projekt startet nicht auf Stufe 1");
  ok(!publiziert(written, token).tiles.offer,
    "eine Offerte ohne Projekt zeigt bereits eine Offerten-Kachel");

  win._ftIngestSubmissions({
    sub_1: {
      id: "sub_1", kind: "intake", token, createdAt: "2026-08-08T09:00:00.000Z",
      payload: { intakeTitle: intake.title, answers: vollstaendig(win, intake.id) },
    },
  });
  const projectId = Object.keys(data.entities.projects)[0];
  ok(projectId, "aus dem Fragebogen entstand kein Projekt");
  ok(win._ftProjectIntakeLink(projectId) === CORE.intakeFormUrl(token),
    "das neue Projekt hat den bereits verschickten Link nicht übernommen");

  // Und die zugeordnete Offerte wird nach ihrem Versand auf demselben Link sichtbar.
  const offer = data.flowertech.offers[0];
  ok(offer.projectId === projectId, "die Offerte wurde dem Projekt nicht zugeordnet");
  win._ftSetOfferAttachment(projectId, "vision");
  win._ftDocStatus("offer", offer.id, "sent");
  ok(offer.status === "sent", "die Offerte liess sich nicht versenden");
  ok(publiziert(written, token).tiles.offer, "die versendete Offerte erscheint nicht am übernommenen Link");
  ok(Object.keys(data.flowertech.intakes).length === 1, "es entstand ein zweiter Fragebogen");
}

/* ══ Teil 3 — Die öffentlichen Wege ═══════════════════════════════════════ */

// ── 16. Nichts davon kommt aus der Kundenseite ───────────────────────────
{
  const kunde = fs.readFileSync(path.join(root, "public/flowertech-kunde.html"), "utf8");
  ok(!/_ftRelease|customerAreaSnapshot|ftCustomerPreview|ftCustomerAdmin/.test(kunde),
    "die Kundenseite entscheidet über Freigaben");
  // Der Eingang kennt keine Freigabe-Art: Freigeben ist eine Handlung in
  // Quantus, keine Kundeneingabe.
  const portal = fs.readFileSync(path.join(root, "netlify/functions/flowertech-portal.mjs"), "utf8");
  const kinds = portal.match(/const kind = \[([^\]]*)\]/);
  ok(kinds && !/release|preview|admin/.test(kinds[1]),
    "der öffentliche Eingang lässt eine Freigabe-Art zu");
  ok(/"change"/.test(kinds[1]), "der Eingang nimmt keine Änderungswünsche entgegen");
}

console.log(`flowertech kundenbereich & prompt: ok (${checks} Pruefungen)`);
