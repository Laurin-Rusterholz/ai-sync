/*
 * FlowerTech — Offerte OHNE Projekt: vollwertiger Startpunkt mit optionalem
 * Fragebogen-Link.
 * ---------------------------------------------------------------------------
 * Die fachliche Korrektur, die dieser Test festhält: Der Satz „Eine Offerte
 * ohne Projekt erfindet keinen Link" war falsch. Eine Offerte ohne Projekt ist
 * der häufige Normalfall und darf ohne jeden Projektzwang versendet werden —
 * und sie trägt einen klar benannten, FREIWILLIGEN Fragebogen-Link, mit dem
 * die fehlenden Kundendaten eingeholt werden.
 *
 * Bewiesen wird der ganze Datenfluss, nicht nur der Text:
 *
 *   1. Offerte ohne Projekt anlegen — kein Zwang, ein Projekt zu wählen.
 *   2. „Fragebogen-Link erstellen" → danach „Fragebogen-Link kopieren".
 *      Der Link zeigt auf fragebogen.html, NIE auf kunde.html.
 *   3. Die Offerte lässt sich in diesem Zustand speichern UND versenden.
 *   4. Die Kundschaft sendet den Fragebogen ab:
 *        genau 1 Projekt · genau 1 Aufgabe · dieselbe Offerte zugeordnet.
 *   5. Reload/Doppelklick erzeugen nichts davon ein zweites Mal.
 *   6. Die Antworten stehen danach an der verknüpften Offerte und im Prompt;
 *      ein Kundenportal entsteht dabei ausdrücklich NICHT.
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

const TOKEN = "e".repeat(32);

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Die Beschriftungen des Knopfes sind Daten ──────────────────────────
{
  ok(CORE.LINK_LABELS.intakeCreate === "Fragebogen-Link erstellen",
    "der Knopf „Fragebogen-Link erstellen“ ist nicht benannt");
  ok(CORE.LINK_LABELS.intakeCopy === "Fragebogen-Link kopieren",
    "der Knopf „Fragebogen-Link kopieren“ ist nicht benannt");
  ok(CORE.LINK_LABELS.intakeHint === "Kundendaten & Vision Room – noch keine Vorschau",
    "der Hilfetext des Fragebogen-Links stimmt nicht");
}

// ── 2. Der Zustand des Knopfes an der Offerte ─────────────────────────────
{
  const offer = { id: "of_1", projectId: null };

  const neu = CORE.offerBriefingLinkState({ offer, intake: null });
  ok(neu.mode === "create", `ohne Fragebogen ist der Zustand nicht „create“: ${neu.mode}`);
  ok(neu.label === CORE.LINK_LABELS.intakeCreate, "der erste Knopf heisst nicht „Fragebogen-Link erstellen“");
  ok(neu.url === "", "ohne Fragebogen entsteht trotzdem ein Link");
  ok(neu.hint === CORE.LINK_LABELS.intakeHint, "der Hilfetext fehlt am Zustand");
  ok(!/kein Link erfunden/.test(neu.explain), "der widerrufene Satz steht weiterhin im Kern");
  ok(/freiwillig|optional/i.test(neu.explain) || /nichts/.test(neu.explain),
    `die Erklärung benennt die Option nicht: ${neu.explain}`);

  const offen = CORE.offerBriefingLinkState({ offer, intake: { inviteToken: TOKEN } });
  ok(offen.mode === "copy", `mit Fragebogen ist der Zustand nicht „copy“: ${offen.mode}`);
  ok(offen.label === CORE.LINK_LABELS.intakeCopy, "der zweite Knopf heisst nicht „Fragebogen-Link kopieren“");
  ok(offen.url === "https://flowertech.ch/fragebogen.html?e=" + TOKEN,
    `der Link zeigt nicht auf den Fragebogen: ${offen.url}`);
  ok(!offen.url.includes("kunde.html"), "der Fragebogen-Link zeigt auf das Kundenportal");

  // Ein unbrauchbarer Token ergibt keinen Link — es wird nichts erfunden.
  const kaputt = CORE.offerBriefingLinkState({ offer, intake: { inviteToken: "zu-kurz" } });
  ok(kaputt.mode === "create" && kaputt.url === "",
    "ein unbrauchbarer Einladungstoken ergibt trotzdem einen Link");

  const beantwortet = CORE.offerBriefingLinkState({
    offer, intake: { inviteToken: TOKEN, projectId: "prj_9" },
  });
  ok(beantwortet.mode === "answered", `nach der Antwort ist der Zustand nicht „answered“: ${beantwortet.mode}`);
  ok(beantwortet.projectId === "prj_9", "das entstandene Projekt wird nicht benannt");

  const mitProjekt = CORE.offerBriefingLinkState({ offer: { id: "of_2", projectId: "prj_1" }, intake: null });
  ok(mitProjekt.mode === "project", "eine Offerte mit Projekt wird wie eine ohne behandelt");
  ok(!mitProjekt.explain.includes("kunde.html"), "die Erklärung verweist auf das Kundenportal");
}

// ── 3. Die Zuordnung ist idempotent und hängt nichts um ───────────────────
{
  const frei = { id: "of_1", projectId: null };
  const neu = CORE.offerProjectLinkPlan({ offer: frei, projectId: "prj_1" });
  ok(neu.link === true && neu.state === "new", "eine freie Offerte wird nicht zugeordnet");

  const schon = CORE.offerProjectLinkPlan({ offer: { id: "of_1", projectId: "prj_1" }, projectId: "prj_1" });
  ok(schon.link === false && schon.state === "already",
    "dieselbe Zuordnung wirkt ein zweites Mal — Reload/Doppelklick wären nicht abgesichert");

  const fremd = CORE.offerProjectLinkPlan({ offer: { id: "of_1", projectId: "prj_2" }, projectId: "prj_1" });
  ok(fremd.link === false && fremd.state === "foreign",
    "eine Offerte eines anderen Vorgangs wird umgehängt");

  ok(CORE.offerProjectLinkPlan({ offer: frei, projectId: "" }).state === "missing",
    "ohne Projekt wird trotzdem zugeordnet");
  ok(CORE.offerProjectLinkPlan({ offer: null, projectId: "prj_1" }).state === "missing",
    "ohne Offerte wird trotzdem zugeordnet");
}

// ── 4. Der Versand hängt NICHT am Projekt ─────────────────────────────────
{
  const doc = {
    client: { company: "Beiz AG" },
    items: [{ description: "Website", qty: 1, price: 4500 }],
    projectId: null,
  };
  const state = CORE.offerSendableState({ doc, total: 4500 });
  ok(state.ready, `eine vollständige Offerte ohne Projekt gilt als nicht versandfertig: ${state.reason}`);
  ok(!JSON.stringify(state.missing).includes("Projekt"),
    "ein Projekt wird als Pflichtangabe der Offerte verlangt");
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
    uuid: () => "u_" + (seed++) + "_" + Math.random().toString(36).slice(2),
    nowIso: () => "2026-08-08T10:00:00.000Z",
    todayYmd: () => "2026-08-08",
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

const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const intakeTasks = (data) => Object.values(data.entities.tasks).filter((t) => t.source === "flowertech-intake");

/* Eine vollständige, versandfertige Offerte OHNE Projekt. */
function offerteOhneProjekt(win, data) {
  win._ftNewDoc("offer");
  const doc = data.flowertech.offers.find((o) => !o.projectId);
  doc.client = { company: "Beiz AG", name: "" };
  doc.items = [{ id: "it_1", description: "Website", qty: 1, unit: "Pauschal", price: 4500, discountPercent: 0 }];
  data.flowertech.activeTab = "offers";
  data.flowertech.ui = { docId: doc.id, docKind: "offer" };
  return doc;
}

/* Alle Pflichtfragen beantwortet — sonst prüft der Test die Pflichtprüfung. */
const vollstaendig = (win, intakeId, overrides = {}) => {
  const intake = win.APP.state.data.flowertech.intakes[intakeId];
  const values = {};
  intake.questions.forEach((q) => {
    values[q.key] = q.type === "date" ? "2026-10-01"
      : q.type === "email" ? "anna@beiz.ch"
      : q.type === "select" ? (q.options || [""])[0]
      : "Antwort " + q.key;
  });
  return CORE.normalizeIntakeAnswers(intake.questions, Object.assign(values, overrides)).answers;
};

// ── 5. Anlegen: kein Projektzwang, kein Projekt, keine Aufgabe ────────────
{
  const { win, data } = makeSandbox();
  const doc = offerteOhneProjekt(win, data);

  ok(!doc.projectId, "die neue Offerte hängt bereits an einem Projekt");
  ok(Object.keys(data.entities.projects).length === 0,
    "das Anlegen einer Offerte erzeugt ein Projekt");
  ok(Object.keys(data.entities.tasks).length === 0, "das Anlegen einer Offerte erzeugt eine Aufgabe");

  const html = strip(win.viewFlowerTech());
  ok(/Fragebogen-Link erstellen/.test(html), "der Knopf „Fragebogen-Link erstellen“ fehlt an der Offerte");
  ok(/_ftCreateOfferIntakeLink\('/.test(html), "der Knopf ist nicht verdrahtet");
  ok(/Kundendaten &amp; Vision Room – noch keine Vorschau/.test(html),
    "der Hilfetext fehlt an der Offerte ohne Projekt");
  ok(!/kein Link erfunden/.test(html), "der widerrufene Satz steht weiterhin in der Oberfläche");
  ok(!/Ordne sie unten einem Projekt zu/.test(html), "die Offerte verlangt weiterhin eine Projektzuordnung");
  // Der zweite Link bleibt draussen: kein Kundenportal in Phase 1.
  ok(!/kunde\.html/.test(html), "die Offerte ohne Projekt zeigt ein Kundenportal");
  ok(!/🔗 Kundenportal-Link/.test(html), "die Offerte ohne Projekt bietet einen Kundenportal-Link an");
  // „Ohne Projekt" bleibt eine gültige Wahl im Auswahlfeld.
  ok(/<option value="">Ohne Projekt<\/option>/.test(html), "„Ohne Projekt“ ist keine Wahl mehr");
}

// ── 6. Der Knopf erzeugt genau einen Fragebogen — auch bei Doppelklick ────
{
  const { win, data, written } = makeSandbox();
  const doc = offerteOhneProjekt(win, data);

  win._ftCreateOfferIntakeLink(doc.id);
  const ids = Object.keys(data.flowertech.intakes);
  ok(ids.length === 1, `es entstanden ${ids.length} Fragebögen statt genau eines`);
  const intake = data.flowertech.intakes[ids[0]];
  ok(intake.offerId === doc.id, "der Fragebogen hängt nicht an dieser Offerte");
  ok(CORE.isShareToken(intake.inviteToken), "der Fragebogen hat keinen brauchbaren Einladungstoken");

  // Der Fragebogen ist veröffentlicht — und trägt nichts Internes.
  const pfad = "flowertech/intakeForms/" + intake.inviteToken;
  ok(written[pfad], "der Fragebogen wurde nicht veröffentlicht");
  const veroeffentlicht = JSON.stringify(written[pfad]);
  ok(!veroeffentlicht.includes(doc.id), "die Offerten-ID steht im öffentlichen Fragebogen");
  ok(!veroeffentlicht.includes("Beiz AG"), "Kontaktdaten stehen im öffentlichen Fragebogen");
  ok(!veroeffentlicht.includes(intake.id), "die interne Fragebogen-ID steht im öffentlichen Fragebogen");

  // Weder Projekt noch Aufgabe noch Kundenportal — der Link erzeugt nichts.
  ok(Object.keys(data.entities.projects).length === 0, "der Fragebogen-Link legt ein Projekt an");
  ok(Object.keys(data.entities.tasks).length === 0, "der Fragebogen-Link legt eine Aufgabe an");
  ok(!Object.keys(written).some((k) => k.startsWith("flowertech/clientPortals/")),
    "der Fragebogen-Link veröffentlicht ein Kundenportal");

  // Doppelklick: derselbe Fragebogen, derselbe Token.
  win._ftCreateOfferIntakeLink(doc.id);
  win._ftCreateOfferIntakeLink(doc.id);
  ok(Object.keys(data.flowertech.intakes).length === 1,
    "ein zweiter Klick erzeugt einen zweiten Fragebogen");
  ok(data.flowertech.intakes[ids[0]].inviteToken === intake.inviteToken,
    "ein zweiter Klick erneuert den Token und macht den verschickten Link ungültig");

  // Danach heisst der Knopf „kopieren" und der Link ist der Fragebogen.
  const html = strip(win.viewFlowerTech());
  const link = CORE.intakeFormUrl(intake.inviteToken);
  ok(/Fragebogen-Link kopieren/.test(html), "der Knopf wechselt nicht auf „Fragebogen-Link kopieren“");
  ok(html.includes(link), "der Fragebogen-Link steht nicht an der Offerte");
  ok(link.startsWith("https://flowertech.ch/fragebogen.html?e="),
    `der Link zeigt nicht auf den Fragebogen: ${link}`);
  ok(!/kunde\.html/.test(html), "an der Offerte steht ein Kundenportal-Link");
}

// ── 7. Die Offerte bleibt eine Offerte: Speichern und Versenden ───────────
{
  const { win, data } = makeSandbox();
  const doc = offerteOhneProjekt(win, data);
  win._ftCreateOfferIntakeLink(doc.id);

  // Speichern: ein ganz normales Feld lässt sich weiterhin ändern.
  win._ftDocSet("offer", doc.id, "title", "Website Beiz AG");
  ok(data.flowertech.offers.find((o) => o.id === doc.id).title === "Website Beiz AG",
    "die Offerte ohne Projekt lässt sich nicht mehr speichern");

  // Versenden: der Fragebogen-Link sperrt den Versand nicht.
  ok(win._ftOfferReadyToSend(doc).ready === true,
    `die Offerte ohne Projekt gilt als nicht versandfertig: ${win._ftOfferReadyToSend(doc).reason}`);
  win._ftDocStatus("offer", doc.id, "sent");
  const gesendet = data.flowertech.offers.find((o) => o.id === doc.id);
  ok(gesendet.status === "sent", "die Offerte ohne Projekt liess sich nicht versenden");
  ok(gesendet.number, "die versendete Offerte bekam keine Offertennummer");
  ok(!gesendet.projectId, "der Versand hat der Offerte heimlich ein Projekt gegeben");
  ok(Object.keys(data.entities.projects).length === 0, "der Versand hat ein Projekt angelegt");
}

// ── 8. Die Antwort: 1 Projekt, 1 Aufgabe, DIESELBE Offerte ────────────────
{
  const { win, data, written } = makeSandbox();
  const doc = offerteOhneProjekt(win, data);
  win._ftCreateOfferIntakeLink(doc.id);
  const intake = Object.values(data.flowertech.intakes)[0];
  const nummerVorher = doc.number || null;
  const positionenVorher = JSON.stringify(doc.items);

  const entry = {
    id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
    payload: {
      intakeTitle: intake.title,
      answers: vollstaendig(win, intake.id, {
        projekt: "Beiz AG", company: "Beiz AG", name: "Anna Muster", email: "anna@beiz.ch",
        need: "Website mit Speisekarte und Reservation",
        "vision-idee": "Gäste sollen direkt einen Tisch reservieren",
        "vision-funktionen": "Tischreservation\nSpeisekarte digital",
      }),
    },
  };

  ok(win._ftIngestSubmissions({ sub_1: entry }) === 1, "der Fragebogen wurde nicht verarbeitet");

  const projekte = Object.values(data.entities.projects);
  ok(projekte.length === 1, `es entstanden ${projekte.length} Projekte statt genau eines`);
  ok(intakeTasks(data).length === 1,
    `es entstanden ${intakeTasks(data).length} Aufgaben statt genau einer`);
  ok(/Offertenanfrage/.test(intakeTasks(data)[0].title),
    `die Aufgabe heisst nicht „Offertenanfrage“: ${intakeTasks(data)[0].title}`);

  // Die Offerte wurde ZUGEORDNET — nicht kopiert, nicht verändert.
  const offerten = data.flowertech.offers.filter((o) => o.id === doc.id);
  ok(offerten.length === 1, "es gibt die Offerte plötzlich zweimal");
  ok(data.flowertech.offers.length === 1, "es entstand eine zweite Offerte");
  const verknuepft = offerten[0];
  ok(verknuepft.projectId === projekte[0].id,
    "die bestehende Offerte wurde dem neuen Projekt nicht zugeordnet");
  ok(JSON.stringify(verknuepft.items) === positionenVorher, "die Positionen der Offerte wurden verändert");
  ok((verknuepft.number || null) === nummerVorher, "die Offertennummer wurde verändert");
  ok(verknuepft.client.company === "Beiz AG", "die Kundendaten der Offerte wurden überschrieben");

  // Die Kundendaten stehen an der Offerte und im Projekt.
  ok(projekte[0].ftIntakeDocument, "das Anfrage-Dokument fehlt am Projekt");
  ok(projekte[0].client.email === "anna@beiz.ch", "die Kundendaten fehlen am Projekt");
  data.flowertech.ui = { docId: doc.id, docKind: "offer" };
  const html = strip(win.viewFlowerTech());
  ok(/Kundendaten aus dem Fragebogen/.test(html), "die Kundendaten fehlen an der verknüpften Offerte");
  ok(html.includes("Tischreservation"), "die Vision-Antworten fehlen an der verknüpften Offerte");

  // Der Prompt trägt die website-relevanten Antworten und den Vision Room.
  const prompt = projekte[0].ftPrompt.text;
  ok(prompt.includes("Website mit Speisekarte"), "der Bedarf fehlt im Projekt-Prompt");
  ok(prompt.includes("Tischreservation"), "der Vision Room fehlt im Projekt-Prompt");
  ok(projekte[0].ftVision && projekte[0].ftVision.idea.includes("Tisch"),
    "der Vision Room steht nicht am Projekt");

  // Phase 1 endet hier: kein Kundenportal.
  ok(!Object.keys(written).some((k) => k.startsWith("flowertech/clientPortals/")),
    "die Antwort der Kundschaft veröffentlicht ein Kundenportal");
  ok(win._ftClientPortalLink(projekte[0].id) === "",
    "nach dem Fragebogen gibt es bereits einen Kundenportal-Link");

  // ── Reload/Doppelklick: nichts davon ein zweites Mal ───────────────────
  win._ftIngestSubmissions({ sub_1: entry });
  win._ftIngestSubmissions({ sub_2: Object.assign({}, entry, { id: "sub_2" }) });
  win._ftApplyIntakeSubmission(intake.id, entry);
  ok(Object.keys(data.entities.projects).length === 1,
    "ein zweiter Eingang erzeugte ein zweites Projekt");
  ok(intakeTasks(data).length === 1, "ein zweiter Eingang erzeugte eine zweite Aufgabe");
  ok(data.flowertech.offers.length === 1, "ein zweiter Eingang erzeugte eine zweite Offerte");
  ok(data.flowertech.offers[0].projectId === projekte[0].id,
    "die Zuordnung der Offerte wurde beim zweiten Eingang verändert");
  const zuordnungen = (data.flowertech.offers[0].history || [])
    .filter((h) => h.event === "linked");
  ok(zuordnungen.length === 1,
    `die Offerte wurde ${zuordnungen.length}-mal zugeordnet statt genau einmal`);
}

// ── 9. Eine fremde Offerte wird nicht umgehängt ───────────────────────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_alt = {
    id: "prj_alt", title: "Projekt Sämi", projectType: "flowertech", pipelineStage: "lead", client: {},
  };
  const doc = offerteOhneProjekt(win, data);
  win._ftCreateOfferIntakeLink(doc.id);
  const intake = Object.values(data.flowertech.intakes)[0];

  // Zwischenzeitlich von Hand einem bestehenden Vorgang zugeordnet.
  win._ftDocSet("offer", doc.id, "projectId", "prj_alt");

  win._ftIngestSubmissions({
    sub_1: {
      id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
      payload: { intakeTitle: intake.title, answers: vollstaendig(win, intake.id) },
    },
  });

  const neu = Object.values(data.entities.projects).find((p) => p.id !== "prj_alt");
  ok(neu, "aus dem Fragebogen entstand kein Projekt");
  ok(data.flowertech.offers.find((o) => o.id === doc.id).projectId === "prj_alt",
    "die Offerte wurde einem anderen Vorgang weggenommen");
  ok(data.flowertech.offers.length === 1, "es entstand eine zweite Offerte");
}

// ── 10. Bestehende Offerten und Portale bleiben unberührt ─────────────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech", pipelineStage: "proposal", client: {},
  };
  // Altbestand: Offerte am Projekt, Portal bereits verschickt.
  data.flowertech.shares = {
    prj_1: { portalToken: "p".repeat(32), publishedAt: "2026-01-01T10:00:00.000Z" },
  };
  win._ftNewDoc("offer", "prj_1");
  const doc = data.flowertech.offers.find((o) => o.projectId === "prj_1");
  ok(doc, "die Offerte am Projekt fehlt");

  data.flowertech.activeTab = "offers";
  data.flowertech.ui = { docId: doc.id, docKind: "offer" };
  const html = strip(win.viewFlowerTech());
  ok(!/Fragebogen-Link erstellen/.test(html),
    "eine Offerte MIT Projekt bekommt den Knopf der Offerte ohne Projekt");
  ok(/Kundenportal/.test(html), "der Stand des Kundenportals fehlt an der Offerte mit Projekt");
  ok(Object.keys(data.flowertech.intakes || {}).length === 0,
    "eine Offerte mit Projekt legt einen Fragebogen an");
}

console.log(`flowertech offerte ohne projekt: ok (${checks} Pruefungen)`);
