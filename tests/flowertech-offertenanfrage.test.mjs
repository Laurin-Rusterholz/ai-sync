/*
 * FlowerTech — Offertenanfrage statt leerer Offerte.
 * ---------------------------------------------------------------------------
 * Produktentscheidung, die hier abgesichert wird:
 *
 *   Eine leere, intern erzeugte Offerte ist falsch. FlowerTech schickt keinen
 *   Mail-Entwurf. Die Kundschaft fuellt ueber ihren eigenen flowertech.ch-Link
 *   aus, was sie braucht — erst dieses Absenden erzeugt eine echte
 *   Offertenanfrage und GENAU EINE Folgeaufgabe.
 *
 * Der im Screenshot sichtbare Zustand „Ohne Kunde / CHF 0.00 / Versendet" darf
 * fuer neue Faelle nicht mehr entstehen koennen. Geprueft wird deshalb nicht
 * die Anzeige, sondern der Versandpfad selbst: eine Anzeige liesse sich mit
 * einem Klick auf das Auswahlfeld umgehen.
 *
 * Der Laufzeitteil laedt public/flowertech.js wirklich und ruft die echten
 * Funktionen auf — kein Nachbau der Logik im Test.
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

/* ══ Teil 1 — Der Kern (reine Logik) ═══════════════════════════════════════ */

// ── 1. Die Anfrage nimmt auf, was die Kundschaft eintraegt ────────────────
{
  const q = CORE.normalizeQuoteRequest({
    company: "  Muster AG ", contactName: "Anna Muster", email: "ANNA@Muster.CH",
    phone: "079 000 00 00", address: "Bahnhofstrasse 1, 8000 Zürich",
    idea: "Website mit Terminbuchung\nund Speisekarte",
    features: ["Terminbuchung", "Speisekarte"],
    type: "Web-Programm",
    budget: "CHF 5'000", deadline: "2026-10-01", notes: "Wir starten im Herbst.",
  }, { now: "2026-08-08T10:00:00.000Z" });

  ok(q.company === "Muster AG", "die Firma wird nicht sauber uebernommen");
  ok(q.contactEmail === "anna@muster.ch", "die E-Mail wird nicht normalisiert");
  ok(q.contactPhone === "079 000 00 00", "die Telefonnummer fehlt");
  ok(q.address.includes("Bahnhofstrasse"), "die Adresse fehlt");
  ok(q.need.includes("Terminbuchung") && q.need.includes("Speisekarte"),
    "der Bedarf verliert Zeilen");
  ok(q.need.includes("\n"), "Zeilenumbrueche im Bedarf gehen verloren");
  ok(q.features.length === 2, "die freiwilligen Funktionen fehlen");
  ok(q.budget === 5000, `der Budgetrahmen wird nicht gelesen: ${q.budget}`);
  ok(q.deadline === "2026-10-01", "das Wunschdatum fehlt");
  ok(q.status === "new", "eine neue Anfrage steht nicht auf „Neu“");
  ok(q.submittedAt === "2026-08-08T10:00:00.000Z", "der Eingangszeitpunkt fehlt");
  // Die Art leitet sich aus dem Vision-Room-Typ ab, statt still „Website" zu sein.
  ok(q.deliveryType === "program", `die Art wird nicht abgeleitet: ${q.deliveryType}`);
}

// ── 2. „auf Anfrage" ist kein Betrag ──────────────────────────────────────
{
  const q = CORE.normalizeQuoteRequest({ need: "x", budget: "weiss ich noch nicht" });
  ok(q.budget === null, "eine Angabe ohne Ziffer wird zu CHF 0.00 statt zu „keine Angabe“");
}

// ── 3. Pflicht ist allein der Bedarf ──────────────────────────────────────
{
  ok(!CORE.quoteRequestIsUsable(CORE.normalizeQuoteRequest({ need: "   " })),
    "eine leere Anfrage gilt als brauchbar");
  // Keine kuenstliche Mindestlaenge: ein getrimmtes Wort genuegt.
  ok(CORE.quoteRequestIsUsable(CORE.normalizeQuoteRequest({ need: "  Shop  " })),
    "eine kurze, sinnvolle Beschreibung wird abgewiesen");
  ok(CORE.quoteRequestIsUsable(CORE.normalizeQuoteRequest({ need: "Shop", features: [] })),
    "ohne gewaehlte Funktionen wird die Anfrage abgewiesen — Funktionen sind freiwillig");
  // Ohne Token kennt FlowerTech die Person nicht: dann ist die Mail der einzige Rueckkanal.
  ok(!CORE.quoteRequestIsUsable(CORE.normalizeQuoteRequest({ need: "Shop" }), { requireEmail: true }),
    "eine Anfrage ohne Rueckkanal wird angenommen");
  ok(CORE.quoteRequestIsUsable(
    CORE.normalizeQuoteRequest({ need: "Shop", email: "a@b.ch" }), { requireEmail: true }),
    "eine Anfrage mit gueltiger Mail wird abgewiesen");
}

// ── 4. Genau EINE Folgeaufgabe, und zwar eine ganz normale ────────────────
{
  const q = CORE.normalizeQuoteRequest({
    need: "Website für unser Restaurant", email: "a@b.ch", company: "Beiz AG",
    features: ["Speisekarte", "Reservation"], budget: "4200",
  }, { now: "2026-08-08T10:00:00.000Z" });
  const task = CORE.buildQuoteRequestTask(q, "prj_1", {
    now: "2026-08-08T10:00:00.000Z", project: { title: "Beiz-Website" },
  });

  ok(!Array.isArray(task), "aus einer Anfrage entsteht eine Liste von Aufgaben statt genau einer");
  ok(task.title === "Offertenanfrage bearbeiten: Beiz-Website",
    `der Aufgabentitel stimmt nicht: ${task.title}`);
  ok(task.projectId === "prj_1", "die Aufgabe ist nicht mit dem Projekt verknuepft");
  ok(task.status === "todo" && task.category === "flowertech",
    "es ist keine normale Quantus-Aufgabe");
  ok(task.description.includes("Website für unser Restaurant"), "der Bedarf fehlt in der Aufgabe");
  ok(task.description.includes("Speisekarte"), "die gewuenschten Funktionen fehlen");
  ok(task.description.includes("Beiz AG"), "die Firma fehlt in der Aufgabe");
  ok(task.description.includes("4200.00"), "der Budgetrahmen fehlt in der Aufgabe");
  ok((task.tags || []).includes("offertenanfrage"), "die Aufgabe ist nicht als Offertenanfrage erkennbar");

  // Ohne Projekttitel traegt die Aufgabe die Idee — nie eine rohe ID, nie leer.
  const ohne = CORE.buildQuoteRequestTask(q, null, { now: "2026-08-08T10:00:00.000Z" });
  ok(ohne.title.includes("Website für unser Restaurant"),
    `ohne Projekttitel fehlt die Idee im Aufgabentitel: ${ohne.title}`);
}

// ── 5. Wann darf eine Offerte „versendet" heissen? ────────────────────────
{
  const leer = CORE.offerSendableState({ doc: { client: {}, items: [] }, total: 0 });
  ok(!leer.ready, "eine leere Offerte darf versendet werden");
  ok(leer.missing.length === 3, `es werden nicht alle Luecken benannt: ${leer.missing.join(", ")}`);
  ok(/Kunde/.test(leer.reason) && /Leistung/.test(leer.reason) && /0\.00/.test(leer.reason),
    `die Meldung sagt nicht, was fehlt: ${leer.reason}`);
  ok(/Offertenanfrage/.test(leer.reason), "die Meldung nennt den Vorgang nicht beim Namen");

  ok(!CORE.offerSendableState({
    doc: { client: { company: "Muster AG" }, items: [{ description: "Website" }] }, total: 0,
  }).ready, "eine Offerte ueber CHF 0.00 darf versendet werden");

  ok(!CORE.offerSendableState({
    doc: { client: {}, items: [{ description: "Website" }] }, total: 900,
  }).ready, "eine Offerte ohne Kunde darf versendet werden");

  ok(!CORE.offerSendableState({
    doc: { client: { name: "Anna" }, items: [{ description: "   " }] }, total: 900,
  }).ready, "eine Offerte ohne Leistung darf versendet werden");

  const voll = CORE.offerSendableState({
    doc: { client: { company: "Muster AG" }, items: [{ description: "Website" }] }, total: 4500,
  });
  ok(voll.ready && voll.reason === "", "eine vollstaendige Offerte wird blockiert");
}

// ── 6. Vision Room: Funktionen sind freiwillig ────────────────────────────
{
  const v = CORE.normalizeVisionSubmission({ idea: "Familien-Organizer", email: "a@b.ch", features: [] });
  ok(CORE.visionIsUsable(v),
    "eine Idee ohne gewaehlte Funktionen wird abgewiesen — Funktionen sind freiwillig");
  ok(!CORE.visionIsUsable(CORE.normalizeVisionSubmission({ idea: "   ", email: "a@b.ch" })),
    "eine leere Idee gilt als brauchbar");
  ok(!CORE.visionIsUsable(CORE.normalizeVisionSubmission({ idea: "App", email: "keine-mail" })),
    "ohne gueltigen Rueckkanal wird angenommen");
}

// ── 7. Kundenseite: Formular vorbelegt, aber ohne Kontaktdaten ────────────
{
  const snap = CORE.buildClientSnapshot({
    project: {
      id: "prj_1", title: "Beiz-Website", pipelineStage: "lead", deliveryType: "website",
      client: { company: "Beiz AG", email: "anna@beiz.ch", phone: "079 000 00 00" },
      ftContactLog: [{ text: "intern" }],
    },
    prefill: { need: "Website mit Speisekarte", deliveryType: "website", budget: 4200, deadline: "2026-10-01" },
    quote: null,
    now: "2026-08-08T10:00:00.000Z",
  });

  ok(snap.quote, "der Snapshot kennt das Offertenformular nicht");
  ok(snap.quote.open === true, "ein Vorgang ohne Anfrage gilt als erledigt");
  ok(snap.quote.prefill.need === "Website mit Speisekarte", "der bekannte Bedarf wird nicht vorbelegt");
  ok(snap.quote.prefill.budget === 4200, "der bekannte Budgetrahmen wird nicht vorbelegt");
  ok(snap.quote.prefill.deadline === "2026-10-01", "das bekannte Wunschdatum wird nicht vorbelegt");

  // Datensparsamkeit: Der Link ist ein Bearer-Link. Kontaktdaten haben dort
  // nichts verloren — die Kundschaft kennt ihre eigenen Angaben.
  const text = JSON.stringify(snap);
  ok(!text.includes("anna@beiz.ch"), "die Mailadresse der Kundschaft wandert auf die Kundenseite");
  ok(!text.includes("079 000 00 00"), "die Telefonnummer wandert auf die Kundenseite");
  ok(!text.includes("Beiz AG"), "die Firma wandert in die Vorbelegung");
  ok(!text.includes("prj_1"), "die interne Projekt-ID wandert auf die Kundenseite");
  for (const key of CORE.CLIENT_SNAPSHOT_FORBIDDEN_KEYS) {
    ok(!Object.prototype.hasOwnProperty.call(snap, key), `verbotenes Feld im Snapshot: ${key}`);
  }

  const mit = CORE.buildClientSnapshot({
    project: { title: "X", pipelineStage: "lead" },
    quote: { status: "new", submittedAt: "2026-08-08T11:00:00.000Z", need: "…" },
    now: "2026-08-08T12:00:00.000Z",
  });
  ok(mit.quote.open === false, "eine eingegangene Anfrage wird nicht als eingegangen gezeigt");
  ok(mit.quote.statusLabel === "Neu", "der Status wird nicht benannt");
  ok(!JSON.stringify(mit.quote).includes("\"need\":\"…\""),
    "der Snapshot spiegelt den eingereichten Bedarf unnoetig zurueck");
}

// ── 8. Die Anfrage taucht im Prozess auf ──────────────────────────────────
{
  const steps = CORE.nextProcessSteps({
    projects: [{ id: "prj_1", title: "Beiz-Website", pipelineStage: "lead",
      ftQuoteRequest: { status: "new", need: "Website" } }],
    briefings: {}, offers: [], inquiries: [], changeRequests: [],
  });
  const step = steps.find((s) => s.key === "quote");
  ok(step, "eine offene Offertenanfrage steht nicht in „Nächster Schritt“");
  ok(step.items[0].sub.includes("Neu"), "der Status „Neu“ fehlt in der Liste");
  ok(step.items[0].title === "Beiz-Website", "der Projektbezug fehlt in der Liste");

  const erledigt = CORE.nextProcessSteps({
    projects: [{ id: "prj_1", pipelineStage: "lead", ftQuoteRequest: { status: "quoted" } }],
    briefings: {}, offers: [], inquiries: [], changeRequests: [],
  });
  ok(!erledigt.find((s) => s.key === "quote"), "eine beantwortete Anfrage steht weiter offen");
}

/* ══ Teil 2 — Laufzeit: flowertech.js wirklich ausfuehren ══════════════════ */

function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast() {},
    __mails: [], __portals: [],
    gmailCompose(opts) { win.__mails.push(opts); },
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + Math.random().toString(36).slice(2),
    nowIso: () => "2026-08-08T10:00:00.000Z",
    todayYmd: () => "2026-08-08",
    crypto: { getRandomValues: (a) => a.fill(7) },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    confirm: () => true, prompt: () => "",
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      getElementById: () => null, querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {} }),
      body: { appendChild() {}, classList: { toggle() {}, remove() {} } },
    },
    location: win.location,
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: {},
    APP: win.APP,
    firebase: {
      app: () => ({ database: () => ({ ref: () => ({
        set: () => Promise.resolve(), remove: () => Promise.resolve(),
      }) }) }),
    },
  };
  sandbox.globalThis = sandbox;
  win.document = sandbox.document;
  win.firebase = sandbox.firebase;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), context);
  return { win, data };
}

const TOKEN = "p".repeat(28);
const tasksOf = (data) => Object.values(data.entities.tasks);
const quoteTasks = (data) => tasksOf(data).filter((t) => t.source === "flowertech-quote");

// ── 9. Eingang ueber den Kundenlink: Anfrage + genau eine Aufgabe ─────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech", pipelineStage: "lead", client: {},
  };
  win.viewFlowerTech();
  data.flowertech.shares = { prj_1: { portalToken: TOKEN } };

  const eingang = {
    sub_1: {
      id: "sub_1", token: TOKEN, kind: "quote", createdAt: "2026-08-08T10:00:00.000Z",
      payload: {
        company: "Beiz AG", contactName: "Anna Muster", contactEmail: "anna@beiz.ch",
        need: "Website mit Speisekarte und Reservation", budget: "4200", deadline: "2026-10-01",
      },
    },
  };
  const handled = win._ftIngestSubmissions(eingang);
  ok(handled === 1, `der Eingang wurde nicht verarbeitet (${handled})`);

  const project = data.entities.projects.prj_1;
  ok(project.ftQuoteRequest, "am Projekt haengt keine Offertenanfrage");
  ok(project.ftQuoteRequest.status === "new", "die Anfrage steht nicht auf „Neu“");
  ok(project.ftQuoteRequest.need.includes("Speisekarte"), "die Angaben sind unvollstaendig");
  ok(project.ftQuoteRequest.source === "portal", "die Herkunft der Anfrage fehlt");
  ok(project.client.company === "Beiz AG", "die Firma wurde nicht ins Projekt uebernommen");
  ok(project.client.email === "anna@beiz.ch", "die Mailadresse wurde nicht uebernommen");
  ok(project.budget === 4200, "der Budgetrahmen wurde nicht uebernommen");
  ok(project.dueDate === "2026-10-01", "das Wunschdatum wurde nicht uebernommen");

  const tasks = quoteTasks(data);
  ok(tasks.length === 1, `es entstanden ${tasks.length} Aufgaben statt genau einer`);
  ok(tasks[0].title === "Offertenanfrage bearbeiten: Beiz-Website",
    `der Aufgabentitel stimmt nicht: ${tasks[0].title}`);
  ok(tasks[0].projectId === "prj_1", "die Aufgabe ist nicht mit dem Projekt verknuepft");
  ok(project.ftQuoteRequest.taskId === tasks[0].id, "Anfrage und Aufgabe sind nicht verknuepft");

  // Wiederholung: derselbe Eingang darf nichts verdoppeln.
  win._ftIngestSubmissions(eingang);
  ok(quoteTasks(data).length === 1, "eine Wiederholung erzeugt eine zweite Aufgabe");
  ok(project.ftQuoteRequests.length === 1, "eine Wiederholung erzeugt eine zweite Anfrage");

  // Auch ein zweiter Import mit anderem Schluessel, aber derselben Einreichung.
  win._ftIngestSubmissions({ sub_1b: Object.assign({}, eingang.sub_1) });
  ok(quoteTasks(data).length === 1, "derselbe Eingang unter anderem Schluessel verdoppelt die Aufgabe");
}

// ── 10. Fremder Token oeffnet den Weg nicht ───────────────────────────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = { id: "prj_1", title: "P", projectType: "flowertech", pipelineStage: "lead" };
  win.viewFlowerTech();
  // Der Bedarfsformular-Token traegt ausdruecklich KEINE Offertenanfrage.
  data.flowertech.shares = { prj_1: { formToken: TOKEN } };
  win._ftIngestSubmissions({
    sub_1: { id: "sub_1", token: TOKEN, kind: "quote", payload: { need: "Shop" } },
  });
  ok(quoteTasks(data).length === 0, "ein Formular-Token schleust eine Offertenanfrage ein");

  win._ftIngestSubmissions({
    sub_2: { id: "sub_2", token: "x".repeat(28), kind: "quote", payload: { need: "Shop" } },
  });
  ok(quoteTasks(data).length === 0, "ein unbekannter Token wird geraten statt ignoriert");
}

// ── 11. Vision Room ohne Einladung: ANFRAGE, kein Projekt ────────────────
// Die zentrale Trennung: Ohne abgesendeten Fragebogen entsteht KEIN Projekt.
// Der oeffentliche Vision Room erzeugt eine Anfrage, deren naechster Schritt
// der Fragebogen-Link ist.
{
  const { win, data } = makeSandbox();
  win.viewFlowerTech();
  const eingang = {
    sub_v: {
      id: "sub_v", kind: "inquiry", createdAt: "2026-08-08T10:00:00.000Z",
      payload: {
        need: "Eine App, mit der Familien Aufgaben und Termine gemeinsam organisieren.",
        email: "familie@muster.ch", type: "Web-App", features: ["Erinnerungen"], source: "vision-room",
      },
    },
  };
  ok(win._ftIngestSubmissions(eingang) === 1, "die Vision-Room-Anfrage wurde nicht verarbeitet");

  const projects = Object.values(data.entities.projects);
  ok(projects.length === 0,
    `aus dem Vision Room entstanden ${projects.length} Projekte — es darf keines entstehen`);
  const inquiries = Object.values(data.flowertech.inquiries || {});
  ok(inquiries.length === 1, `es entstand keine Anfrage (${inquiries.length})`);
  ok(inquiries[0].email === "familie@muster.ch", "der Rueckkanal fehlt an der Anfrage");
  ok(inquiries[0].message.includes("Familien"), "die Idee fehlt an der Anfrage");
  ok(inquiries[0].message.includes("Erinnerungen"), "die Vision-Funktionen fehlen an der Anfrage");
  ok(inquiries[0].source === "vision-room", "die Herkunft fehlt");

  // Es entsteht auch keine Offertenanfrage-Aufgabe und kein Anfrage-Dokument.
  ok(tasksOf(data).filter((t) => t.source === "flowertech-intake").length === 0,
    "der Vision Room erzeugt eine Fragebogen-Aufgabe, obwohl niemand geantwortet hat");

  // Ohne Rueckkanal keine Anfrage — sonst waere sie nicht beantwortbar.
  win._ftIngestSubmissions({
    sub_w: { id: "sub_w", kind: "inquiry", payload: { need: "Etwas", source: "vision-room" } },
  });
  ok(Object.values(data.flowertech.inquiries || {}).length === 1,
    "eine Anfrage ohne Rueckkanal wird trotzdem angelegt");

  // Wiederholung derselben Einreichung: keine zweite Anfrage.
  win._ftIngestSubmissions({ sub_v2: Object.assign({}, eingang.sub_v) });
  ok(Object.values(data.flowertech.inquiries || {}).length === 1,
    "eine Wiederholung legt eine zweite Anfrage an");
  ok(Object.values(data.entities.projects).length === 0,
    "eine Wiederholung legt doch ein Projekt an");

  // Der naechste Schritt ist der Fragebogen-Link — und er legt kein Projekt an.
  const inquiryId = inquiries[0].id;
  const intake = win._ftIntakeForInquiry(inquiryId);
  ok(intake && intake.inviteToken, "an der Anfrage entsteht kein Fragebogen mit Einladungstoken");
  ok(intake.inquiryId === inquiryId, "der Fragebogen haengt nicht an der Anfrage");
  ok(Object.values(data.entities.projects).length === 0,
    "das Erzeugen des Fragebogen-Links legt bereits ein Projekt an");
  // Zweiter Klick: derselbe Fragebogen, kein zweiter.
  ok(win._ftIntakeForInquiry(inquiryId).id === intake.id,
    "ein zweiter Klick erzeugt einen zweiten Fragebogen");
  ok(Object.keys(data.flowertech.intakes).length === 1, "es entstanden mehrere Fragebogen");
}

// ── 12. Keine leere OF-Nummer, kein „Versendet" ohne Pflichtdaten ─────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech", pipelineStage: "proposal",
    ftRoute: "direct", client: {},
  };
  win.viewFlowerTech();

  win._ftNewDoc("offer", "prj_1");
  const doc = data.flowertech.offers[0];
  ok(doc, "es wurde keine Offerte angelegt");
  ok(!doc.number, `eine leere Offerte bekommt sofort eine Nummer: ${doc.number}`);
  ok(!data.flowertech.counters.offer_2026, "der Nummernkreis wird fuer einen leeren Entwurf verbraucht");

  // Genau die Kombination aus dem Screenshot: ohne Kunde, CHF 0.00 — „Versendet".
  win._ftDocStatus("offer", doc.id, "sent");
  ok(doc.status === "draft", "eine leere Offerte laesst sich als versendet markieren");
  ok(!doc.sentAt, "es entstand eine falsche Versandhistorie");
  ok(!doc.number, "es wurde eine Nummer fuer eine leere Offerte vergeben");
  ok(!(doc.history || []).some((h) => h.event === "status"),
    "der blockierte Versand steht trotzdem im Verlauf");

  // Mailweg fuehrt an derselben Schranke vorbei? Darf er nicht.
  win._ftMailDoc("offer", doc.id);
  ok(win.__mails.length === 0, "der Mailversand umgeht die Sperre");

  // Teilweise ausgefuellt reicht ebenfalls nicht.
  doc.client.company = "Beiz AG";
  win._ftDocStatus("offer", doc.id, "sent");
  ok(doc.status === "draft", "eine Offerte ueber CHF 0.00 laesst sich versenden");

  // Vollstaendig: jetzt entsteht eine echte Offerte mit Nummer.
  doc.items[0].description = "Website inkl. Reservation";
  doc.items[0].price = 4500;
  win._ftDocStatus("offer", doc.id, "sent");
  ok(doc.status === "sent", "eine vollstaendige Offerte laesst sich nicht versenden");
  ok(/^OF-\d{4}-\d{4}$/.test(doc.number || ""), `die Offertennummer fehlt: ${doc.number}`);
  ok(doc.sentAt, "der Versandzeitpunkt fehlt");
}

// ── 13. Kundenportal: der ZWEITE Link — erst nach der Freigabe ───────────
// Vorher gibt es bewusst keinen kopierbaren Link, sondern den internen Stand
// „Kundenportal – noch nicht veröffentlicht" samt Liste des Fehlenden.
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech", pipelineStage: "lead", client: {},
  };
  data.flowertech = { shares: { prj_1: { portalToken: TOKEN } }, ui: { projectTab: "kunde" } };
  win.viewFlowerTech();

  // Ohne Freigabe: kein Link, nirgends.
  ok(win._ftClientPortalLink("prj_1") === "",
    "vor der Freigabe existiert bereits ein versendbarer Kundenportal-Link");
  const vorher = win.ftProjectPanel("prj_1").replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(vorher.includes("Kundenportal – noch nicht veröffentlicht"),
    "der Zustand „noch nicht veröffentlicht“ steht nicht im Projekt");
  ok(!vorher.includes("https://flowertech.ch/kunde.html?t=" + TOKEN),
    "der Portallink steht im Projekt, obwohl nichts veröffentlicht ist");
  ok(/Website-Vorschau/.test(vorher) && /AGB/.test(vorher),
    "es wird nicht benannt, was für die Veröffentlichung noch fehlt");

  // Eine Freigabe ohne Inhalt wird verweigert — die Prüfung liegt im Pfad,
  // nicht nur in der Anzeige.
  win._ftReleaseClientPortal("prj_1");
  ok(data.flowertech.shares.prj_1.portalReleased !== true,
    "ein leeres Kundenportal liess sich veröffentlichen");
  ok(win._ftClientPortalLink("prj_1") === "", "nach der verweigerten Freigabe gibt es doch einen Link");

  // Vollständig: Vorschau, Leistungsbeschreibung, Offerte, Vertrag, AGB.
  const p = data.entities.projects.prj_1;
  p.ftTemplate = { html: "<h1>Entwurf</h1>", updatedAt: "2026-08-08T10:00:00.000Z" };
  data.flowertech.contentDocs = { prj_1: { blocks: [{ title: "Leistung", body: "Wir bauen.", enabled: true }] } };
  data.flowertech.contracts = { prj_1: { sections: [{ key: "parteien", title: "1", body: "Text", enabled: true }] } };
  data.flowertech.legalDocs = { prj_1: { agb: { sections: [{ key: "k", title: "AGB", body: "Text", enabled: true }] } } };
  win._ftNewDoc("offer", "prj_1");
  const offer = data.flowertech.offers[0];
  offer.client = { company: "Beiz AG" };
  offer.items[0].description = "Website inkl. Reservation";
  offer.items[0].price = 4500;
  win._ftRefreshTotals ? win._ftRefreshTotals("offer", offer.id) : null;

  ok(win._ftPortalRelease("prj_1").ready,
    "trotz vollständiger Angaben gilt das Kundenportal als unvollständig: " +
      win._ftPortalRelease("prj_1").missing.join(", "));
  win._ftReleaseClientPortal("prj_1");
  ok(data.flowertech.shares.prj_1.portalReleased === true, "die Freigabe wurde nicht festgehalten");

  const clientLink = win._ftClientPortalLink("prj_1");
  ok(clientLink === "https://flowertech.ch/kunde.html?t=" + TOKEN,
    `der Portallink stimmt nicht: ${clientLink}`);
  ok(!/management-xo2-pro/.test(clientLink), "der kopierte Link zeigt auf die interne Verwaltung");
  ok(!/^mailto:/.test(clientLink), "der Kundenportal-Link ist eine Mailadresse");

  const html = win.ftProjectPanel("prj_1").replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(html.includes("Kundenportal"), "die Sektion „Kundenportal“ fehlt in der Projektansicht");
  ok(html.includes(clientLink), "der Kundenportal-Link steht nicht in der Sektion");
  ok(/>Öffnen</.test(html), "der Knopf „Öffnen“ fehlt");
  /* „Kundenlink" war einmal verboten, weil er die zwei Links vermischte. Das
     Cockpit loest dasselbe Problem an der Wurzel: Es gibt oben genau EINE
     Kundenadresse, und der Kundenportal-Link — der interne Sonderweg — steht
     nicht mehr gleichrangig daneben, sondern im eingeklappten Bereich. Der
     Begriff ist damit eindeutig und ausdruecklich gewuenscht; gepruefft wird
     jetzt die Eindeutigkeit statt eines Wortverbots. */
  ok(/Kundenlink kopieren|Kundenlink erstellen/.test(html),
    "das Cockpit benennt die eine Kundenadresse nicht");
  ok(!/Phase 1 · Fragebogen/.test(html) && !/Phase 2 · Kundenportal/.test(html),
    "die zwei technischen Phasenwaende stehen wieder oben auf der Projektseite");
  // Der Portallink ist nicht verschwunden, aber er konkurriert nicht mehr:
  // er steht hinter dem eingeklappten „Mehr / intern".
  const intern = html.slice(html.indexOf('<details class="ft-more"'));
  ok(intern.includes(clientLink),
    "der Kundenportal-Link steht nicht im eingeklappten internen Bereich");
  // Und die zwei Begriffe bleiben unterscheidbar.
  ok(/Vorschau-Link aus dem Claude-Code-Chat einfügen/.test(html),
    "die Eingabe für den Vorschau-Link fehlt");
}

// ── 13b. Ein aelterer Vorgang bekommt NICHT still ein Portal ──────────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_alt = {
    id: "prj_alt", title: "Vor der Kundenseite angelegt", projectType: "flowertech",
    pipelineStage: "proposal", client: {},
  };
  data.flowertech = { shares: {}, ui: { projectTab: "kunde" } };
  win.viewFlowerTech();

  const html = win.ftProjectPanel("prj_alt").replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(!(data.flowertech.shares.prj_alt || {}).portalToken,
    "beim blossen Ansehen entsteht ein Portaltoken — ein Schreibvorgang pro Neuzeichnen");
  ok(!/https:\/\/flowertech\.ch\/kunde\.html/.test(html),
    "ein aelterer Vorgang zeigt einen Kundenportal-Link, obwohl nie veröffentlicht wurde");
  ok(html.includes("Kundenportal – noch nicht veröffentlicht"),
    "der interne Zustand des Portals fehlt bei einem aelteren Vorgang");
}

// ── 14. Unvollstaendige Offerte sagt, was fehlt — und wie es weitergeht ───
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "Beiz-Website", projectType: "flowertech", pipelineStage: "proposal",
    ftRoute: "direct", client: {},
  };
  data.flowertech = { shares: { prj_1: { portalToken: TOKEN } } };
  win.viewFlowerTech();
  win._ftNewDoc("offer", "prj_1");
  const doc = data.flowertech.offers[0];
  data.flowertech.activeTab = "offers";
  data.flowertech.ui = { docId: doc.id, docKind: "offer" };

  const html = win.viewFlowerTech().replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(html.includes("Noch keine Offerte"), "die unvollstaendige Offerte wird als Offerte ausgegeben");
  ok(html.includes("Offertenanfrage"), "der Vorgang wird nicht als Offertenanfrage benannt");
  ok(html.includes("Fragebogen-Link"),
    "es wird kein Weg angeboten, die Luecke zu schliessen");
  ok(!/Kundenlink/.test(html),
    "die unvollstaendige Offerte erfindet weiterhin einen „Kundenlink“");
  ok(html.includes("Entwurf (Offertenanfrage)"),
    "eine Offerte ohne Nummer erscheint als „—“ statt als Entwurf");
}

// ── 15. Quelltext: kein Mail-Entwurf als Offertenweg ──────────────────────
{
  const source = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  ok(/function applyQuoteRequest\(/.test(source), "der Eingang der Offertenanfrage fehlt");
  ok(/function createQuoteTask\(/.test(source), "die einzelne Folgeaufgabe fehlt");
  ok(/sourceQuoteKey/.test(source), "die Aufgabe traegt keinen Schluessel gegen Doppel");
  // Der Kundenlink wird nie automatisch verschickt.
  ok(!/gmailCompose[\s\S]{0,200}clientQuoteLink/.test(source),
    "der Kundenlink wird automatisch per Mail verschickt");
}

console.log(`flowertech offertenanfrage: ok (${checks} Pruefungen)`);
