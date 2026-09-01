/*
 * FlowerTech — der Kundenlink ist vorbelegt, ohne etwas zu erfinden.
 * ---------------------------------------------------------------------------
 * Der Befund: Die Kundschaft bekam einen Bogen, auf dem selbst das leer
 * stand, was FlowerTech längst wusste. Beim Projekt „Reinigungsunternehmen
 * Aljia“ hiess das: Projektname, Ansprechperson „Herr Aljia“, E-Mail und die
 * Art „Website“ ein zweites Mal abtippen.
 *
 * Seither trägt der veröffentlichte Datensatz `prefill` (`version`, `values`
 * nach Frageschlüssel). Bewiesen wird:
 *
 *   1. Der Kern (intakePrefill) belegt nur Bekanntes vor — aus Projekt,
 *      Kundendaten, verknüpfter Person, Anfrage, Offerte — und lässt
 *      Unbekanntes leer. Der Aljia-Fall ergibt genau vier Werte.
 *   2. Nur, was ins Feld passt: Auswahl nur aus Optionen, Datum nur als
 *      Datum, keine Geheimnisse, keine Standard-Art als Kenntnis.
 *   3. Herkunft innen, Werte aussen: der Snapshot trägt `version` und
 *      `values` — keine Quelle, keine ID, keine Notiz.
 *   4. Änderungen der Kundschaft gewinnen: Korrigiert sie einen vorbelegten
 *      Wert, übernimmt das Projekt die Korrektur (intakeUpdateForProject);
 *      gepflegte, NICHT vorbelegte Angaben bleiben wie bisher stehen.
 *   5. Laufzeit: Erzeugen und erneutes Veröffentlichen schreiben `prefill`
 *      auf den Kundenlink; die Herkunft steht am Fragebogen in Quantus und in
 *      der Karte — nie im veröffentlichten Datensatz.
 *   6. Bestehende Links ohne Vorbelegung werden einmal neu veröffentlicht;
 *      Kundendaten-Änderungen ziehen nach; beantwortete Bögen bleiben in Ruhe.
 *
 * Der Laufzeitteil lädt public/flowertech.js wirklich.
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

const TOKEN = "a".repeat(32);
const FRAGEN = CORE.normalizeIntakeQuestions(CORE.DEFAULT_INTAKE_QUESTIONS);
const frage = (role) => FRAGEN.find((q) => q.role === role);
const ALJIA = {
  id: "prj_aljia", title: "Reinigungsunternehmen Aljia", projectType: "flowertech",
  pipelineStage: "lead", deliveryType: "website",
  client: { name: "Herr Aljia", email: "juledal19@gmail.com" },
  ftContactLog: [{ id: "log_1", at: "2026-08-30T10:00:00.000Z", channel: "note", text: "interne Notiz" }],
};

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Der Aljia-Fall: genau das Bekannte, sonst nichts ───────────────────
{
  const p = CORE.intakePrefill({ intake: { questions: FRAGEN, deliveryType: "website" }, project: ALJIA });
  ok(p.version === CORE.INTAKE_PREFILL_VERSION && p.version === 1, "die Fassung der Vorbelegung fehlt");
  ok(p.values.projekt === "Reinigungsunternehmen Aljia", `der Projektname fehlt: ${p.values.projekt}`);
  ok(p.values.name === "Herr Aljia", `die Ansprechperson fehlt: ${p.values.name}`);
  ok(p.values.email === "juledal19@gmail.com", `die E-Mail fehlt: ${p.values.email}`);
  ok(p.values.kind === "Website", `die Art fehlt: ${p.values.kind}`);
  ok(p.count === 4 && Object.keys(p.values).length === 4,
    `es wurden ${Object.keys(p.values).join(", ")} vorbelegt statt genau vier Angaben`);
  // Unbekannt bleibt leer: keine Firma, kein Telefon, keine Adresse, kein Termin, keine Idee.
  ["company", "phone", "adresse", "deadline", "budget", "website-url", "vision-idee", "vision-funktionen", "need"]
    .forEach((key) => ok(!(key in p.values), `„${key}“ wurde erfunden: ${p.values[key]}`));
  // Die Herkunft ist lesbar — und trägt keine ID.
  ok(p.sources.projekt === "project" && p.sources.name === "client" && p.sources.kind === "project",
    `die Herkunft stimmt nicht: ${JSON.stringify(p.sources)}`);
  ok(p.labels.some((l) => /Ansprechperson ← Kundendaten am Projekt/.test(l)), `die Herkunft ist nicht lesbar: ${p.labels}`);
  ok(!JSON.stringify(p).includes("prj_aljia"), "die Projekt-ID steckt in der Vorbelegung");
}

// ── 2. Verknüpfte Person, Anfrage und Offerte füllen, was das Projekt nicht hat ─
{
  const person = {
    id: "per_1", name: "Rita Lehner", emails: ["rita@lehner.ch"], phones: ["+41 44 000 00 00"],
    address: { street: "Dorfstrasse 1", zip: "8000", city: "Zürich" }, company: "Lehner GmbH",
    linkedProjects: ["prj_1"],
  };
  const p = CORE.intakePrefill({
    intake: { questions: FRAGEN }, project: { id: "prj_1", title: "Lehner", client: {} }, person,
  });
  ok(p.values.name === "Rita Lehner" && p.sources.name === "person", "die verknüpfte Person füllt die Ansprechperson nicht");
  ok(p.values.email === "rita@lehner.ch" && p.values.phone === "+41 44 000 00 00", "E-Mail/Telefon der Person fehlen");
  ok(p.values.adresse === "Dorfstrasse 1, 8000 Zürich", `die Adresse ist nicht lesbar: ${p.values.adresse}`);
  ok(p.values.company === "Lehner GmbH" && p.sources.company === "person", "die Firma der Person fehlt");
  ok(!("kind" in p.values), "ohne gepflegte Art wird eine Art erfunden");

  // Gepflegte Kundendaten am Projekt gehen der Person vor.
  const q = CORE.intakePrefill({
    intake: { questions: FRAGEN }, project: { id: "prj_1", title: "Lehner", client: { email: "buchhaltung@lehner.ch" } }, person,
  });
  ok(q.values.email === "buchhaltung@lehner.ch" && q.sources.email === "client", "die Person überstimmt die Kundendaten am Projekt");

  // Die Anfrage (Lead): Name, E-Mail und die Art, wie die Kundschaft sie nannte.
  const lead = CORE.intakePrefill({
    intake: { questions: FRAGEN, inquiryId: "ftq_1" },
    inquiry: { id: "ftq_1", name: "Anna Muster", email: "anna@beiz.ch", company: "Beiz Muster", service: "Web-App" },
  });
  ok(lead.values.name === "Anna Muster" && lead.values.email === "anna@beiz.ch", "die Anfrage füllt die Kontaktdaten nicht");
  ok(lead.values.projekt === "Beiz Muster" && lead.values.company === "Beiz Muster", "die Firma der Anfrage fehlt");
  ok(lead.values.kind === "Web-App" && lead.sources.kind === "inquiry", `die Art aus der Anfrage fehlt: ${lead.values.kind}`);
  ok(!JSON.stringify(lead.values).includes("ftq_1"), "die Anfrage-ID steckt in der Vorbelegung");

  // Die Offerte ohne Projekt: ihre Kundendaten.
  const offer = CORE.intakePrefill({
    intake: { questions: FRAGEN, offerId: "off_1" },
    offer: { id: "off_1", contactPerson: "Peter Muster", client: { company: "Muster AG", email: "p@muster.ch", street: "Weg 2", zip: "3000", city: "Bern" } },
  });
  ok(offer.values.name === "Peter Muster" && offer.values.company === "Muster AG" && offer.values.adresse === "Weg 2, 3000 Bern",
    `die Offerte füllt die Kundendaten nicht: ${JSON.stringify(offer.values)}`);

  // Bisherige Website, Budget, Termin, Vision Room — aus dem Projekt.
  const voll = CORE.intakePrefill({
    intake: { questions: FRAGEN },
    project: {
      id: "prj_2", title: "Beiz", ftCurrentUrl: "https://alt.beiz.ch", ftCurrentProvider: "Hostpoint",
      currentProviderPrice: 240, budget: 5000, dueDate: "2026-10-01T00:00:00.000Z",
      ftVision: { idea: "Reservation online", features: ["Tischreservation online", "Speisekarte"] },
    },
    briefing: { goal: "Mehr Reservationen" },
  });
  ok(voll.values["website-url"] === "https://alt.beiz.ch" && voll.values.anbieter === "Hostpoint", "Iststand fehlt");
  ok(voll.values["bisheriger-preis"] === "240" && voll.values.budget === "5000", "Preis/Budget fehlen");
  ok(voll.values.deadline === "2026-10-01", `der Termin ist kein Datum: ${voll.values.deadline}`);
  ok(voll.values["vision-idee"] === "Reservation online", "die Idee des Vision Rooms fehlt");
  ok(voll.values["vision-funktionen"] === "Tischreservation online\nSpeisekarte", "die Funktionen fehlen");
  ok(voll.values.need === "Mehr Reservationen" && voll.sources.need === "briefing", "das Ziel aus dem Briefing fehlt");
}

// ── 3. Nur, was ins Feld passt — und nie ein Geheimnis ───────────────────
{
  const p = CORE.intakePrefill({
    intake: { questions: FRAGEN },
    project: { id: "prj_3", title: "X", deliveryType: "program", dueDate: "bald", client: { email: "keine-adresse" } },
  });
  ok(p.values.kind === "Web-Programm", `die Art „program“ landet nicht in der Option: ${p.values.kind}`);
  ok(!("deadline" in p.values), "ein unbrauchbares Datum wurde vorbelegt");
  ok(!("email" in p.values), "eine unbrauchbare E-Mail wurde vorbelegt");

  // Eine Auswahl, die die Art nicht kennt: nichts erzwingen.
  const enge = CORE.intakePrefill({
    intake: { questions: [{ key: "kind", label: "Was brauchen Sie?", type: "select", options: ["Website", "Web-App"] }] },
    project: { id: "prj_3", title: "X", deliveryType: "program" },
  });
  ok(!("kind" in enge.values), "eine Art ohne passende Option wurde erzwungen");

  // Die Standard-Art eines Fragebogens ist keine Kenntnis.
  const standard = CORE.intakePrefill({ intake: { questions: FRAGEN, deliveryType: "website" }, project: { id: "prj_4", title: "Y" } });
  ok(!("kind" in standard.values), "die Standard-Art des Fragebogens wurde als Kenntnis ausgegeben");

  // Ein Geheimnis wird nie vorbelegt, auch wenn eine Rolle daran hängt.
  const geheim = CORE.intakePrefill({
    intake: { questions: [{ key: "zugang", label: "Passwort", type: "text", role: "contactName" }] },
    project: { id: "prj_5", title: "Z", client: { name: "Herr Aljia" } },
  });
  ok(Object.keys(geheim.values).length === 0, "ein Geheimnisfeld wurde vorbelegt");

  // Ohne alles: leer, aber gültig.
  const leer = CORE.intakePrefill({ intake: { questions: FRAGEN } });
  ok(leer.count === 0 && leer.version === 1, "eine leere Vorbelegung ist nicht leer");
}

// ── 4. Der Snapshot: Fassung und Werte, sonst nichts ─────────────────────
{
  const p = CORE.intakePrefill({ intake: { questions: FRAGEN }, project: ALJIA });
  const s = CORE.intakePrefillSnapshot(p);
  ok(Object.keys(s).sort().join(",") === "values,version", `der Snapshot trägt mehr als Fassung und Werte: ${Object.keys(s)}`);
  ok(JSON.stringify(s).indexOf("client") < 0 && JSON.stringify(s).indexOf("prj_") < 0, "Herkunft oder ID stehen im Snapshot");
  ok(CORE.intakePrefillSnapshot(null) === null && CORE.intakePrefillSnapshot({ version: 1, values: {} }) === null,
    "eine leere Vorbelegung wird veröffentlicht");

  const snapshot = CORE.customerAreaSnapshot({
    intake: { questions: FRAGEN, inviteToken: TOKEN, title: "Ihre Angaben" }, project: ALJIA,
    company: { name: "FlowerTech" }, now: "2026-09-01T10:00:00.000Z", prefill: p,
  });
  ok(snapshot.prefill && snapshot.prefill.values.name === "Herr Aljia", "der Kundenbereich trägt die Vorbelegung nicht");
  const roh = JSON.stringify(snapshot);
  ok(!roh.includes("prj_aljia") && !roh.includes("interne Notiz") && !roh.includes("sources"),
    "ID, Notiz oder Herkunft stehen im Kundenbereich");
  // Ohne Vorbelegung: derselbe Datensatz wie bisher.
  const ohne = CORE.customerAreaSnapshot({ intake: { questions: FRAGEN, inviteToken: TOKEN }, company: { name: "FlowerTech" } });
  ok(!("prefill" in ohne), "ein Datensatz ohne Vorbelegung trägt trotzdem das Feld");
}

// ── 5. Die Korrektur der Kundschaft gewinnt — Gepflegtes bleibt ──────────
{
  const prefill = CORE.intakePrefill({ intake: { questions: FRAGEN }, project: ALJIA });
  const answers = (values) => CORE.normalizeIntakeAnswers(FRAGEN, values).answers;
  const basis = { projekt: "Reinigungsunternehmen Aljia", name: "Herr Aljia", phone: "079 000 00 00", adresse: "Weg 1, 8000 Zürich", kind: "Website", need: "Mehr Anfragen" };

  // Korrigierte E-Mail: das Projekt übernimmt sie.
  const korrigiert = CORE.intakeUpdateForProject({
    project: ALJIA, prefill, answers: answers(Object.assign({}, basis, { email: "info@aljia-reinigung.ch" })),
  });
  ok(korrigiert.client.email === "info@aljia-reinigung.ch", `die Korrektur der Kundschaft wird verworfen: ${JSON.stringify(korrigiert.client)}`);
  ok(korrigiert.corrected.includes("E-Mail") && !korrigiert.kept.includes("E-Mail"), "die Korrektur wird nicht als solche benannt");
  ok(korrigiert.client.name === undefined && korrigiert.kept.includes("Ansprechperson"), "eine unveränderte Vorbelegung gilt als Korrektur");
  ok(korrigiert.client.phone === "079 000 00 00" && korrigiert.filled.includes("Telefon"), "eine neue Angabe wird nicht ergänzt");

  // Ohne Vorbelegung (alter Link): wie bisher — Gepflegtes bleibt stehen.
  const alt = CORE.intakeUpdateForProject({
    project: ALJIA, answers: answers(Object.assign({}, basis, { email: "info@aljia-reinigung.ch" })),
  });
  ok(alt.client.email === undefined && alt.kept.includes("E-Mail"), "ohne Vorbelegung wird Gepflegtes überschrieben");

  // Gepflegt, aber NICHT vorbelegt (etwa weil die Frage fehlt): bleibt stehen.
  const ohneFrage = CORE.intakeUpdateForProject({
    project: ALJIA, prefill: { version: 1, values: { projekt: "Reinigungsunternehmen Aljia" } },
    answers: answers(Object.assign({}, basis, { email: "info@aljia-reinigung.ch" })),
  });
  ok(ohneFrage.client.email === undefined, "ein gepflegter, nicht vorbelegter Wert wurde überschrieben");
}

/* ══ Teil 2 — Laufzeit ════════════════════════════════════════════════════ */

let seed = 0;
function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {}, persons: {}, organizations: {} }, flowertech: {}, meta: {} };
  const written = {};
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {}, toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __toasts: [], __copied: [],
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1) + "_" + (seed++);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (seed++),
    nowIso: () => "2026-09-01T10:00:00.000Z",
    todayYmd: () => "2026-09-01",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    clearTimeout() {},
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
    setTimeout: win.setTimeout,
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
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written };
}
const strip = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 6. Erzeugen: der Kundenlink von Aljia ist vorbelegt ───────────────────
{
  const { win, data, written } = makeSandbox();
  data.entities.projects.prj_aljia = JSON.parse(JSON.stringify(ALJIA));

  win._ftCreateProjectIntakeLink("prj_aljia");
  await tick();
  const intake = Object.values(data.flowertech.intakes)[0];
  const pfad = "flowertech/intakeForms/" + intake.inviteToken;
  ok(written[pfad], "der Kundenlink wurde nicht veröffentlicht");
  const p = written[pfad].prefill;
  ok(p && p.version === 1, "der veröffentlichte Kundenlink trägt keine Vorbelegung");
  ok(p.values.projekt === "Reinigungsunternehmen Aljia" && p.values.name === "Herr Aljia"
    && p.values.email === "juledal19@gmail.com" && p.values.kind === "Website",
    `die Vorbelegung von Aljia stimmt nicht: ${JSON.stringify(p.values)}`);
  ok(Object.keys(p.values).length === 4, "es wurde mehr vorbelegt als bekannt ist");
  ok(Object.keys(p).sort().join(",") === "values,version", `der Kundenlink trägt Herkunft oder Internes: ${Object.keys(p)}`);
  const roh = JSON.stringify(written[pfad]);
  ok(!roh.includes("prj_aljia") && !roh.includes(intake.id) && !roh.includes("interne Notiz"),
    "ID oder Notiz stehen im veröffentlichten Kundenlink");
  // Innen bleibt die Herkunft nachvollziehbar.
  ok(intake.prefill && intake.prefill.sources.name === "client" && intake.prefill.version === 1,
    "die Herkunft der Vorbelegung steht nicht am Fragebogen");
  const karte = strip(win.ftProjectPanel("prj_aljia"));
  ok(/Vorbelegt für die Kundschaft/.test(karte) && /Ansprechperson ← Kundendaten am Projekt/.test(karte),
    "die Karte nennt die Vorbelegung und ihre Herkunft nicht");
  ok(/bleibt für die Kundschaft editierbar/.test(karte), "die Karte sagt nicht, dass alles editierbar bleibt");
}

// ── 7. Verknüpfte Person: nur eine eindeutige ─────────────────────────────
{
  const { win, data, written } = makeSandbox();
  data.entities.projects.prj_1 = { id: "prj_1", title: "Lehner", projectType: "flowertech", pipelineStage: "lead", client: {} };
  data.entities.persons.per_1 = { id: "per_1", name: "Rita Lehner", emails: ["rita@lehner.ch"], linkedProjects: ["prj_1"] };
  data.entities.persons.per_2 = { id: "per_2", name: "Fremde Person", emails: ["x@y.ch"], linkedProjects: ["prj_9"] };
  win._ftCreateProjectIntakeLink("prj_1");
  await tick();
  const intake = Object.values(data.flowertech.intakes)[0];
  const p = written["flowertech/intakeForms/" + intake.inviteToken].prefill;
  ok(p.values.name === "Rita Lehner" && p.values.email === "rita@lehner.ch", `die verknüpfte Person füllt nicht: ${JSON.stringify(p.values)}`);
  ok(!JSON.stringify(p).includes("per_1"), "die Personen-ID steht im Kundenlink");

  // Zwei verknüpfte Personen ohne Anhaltspunkt: keine — raten wäre erfinden.
  data.entities.persons.per_3 = { id: "per_3", name: "Zweite Person", emails: ["z@lehner.ch"], linkedProjects: ["prj_1"] };
  win._ftRefreshCustomerArea("prj_1");
  await tick();
  const q = written["flowertech/intakeForms/" + intake.inviteToken].prefill;
  ok(!q || !("name" in q.values), `bei zwei Personen wurde geraten: ${q && q.values.name}`);
}

// ── 8. Bestehende Links werden einmal nachgezogen; Änderungen ziehen nach ─
{
  const { win, data, written } = makeSandbox();
  data.entities.projects.prj_aljia = JSON.parse(JSON.stringify(ALJIA));
  // Ein Fragebogen aus der Zeit vor der Vorbelegung: Token da, kein prefill.
  data.flowertech.intakes = { in_alt: {
    id: "in_alt", boundProjectId: "prj_aljia", title: "Ihre Angaben", questions: FRAGEN,
    inviteToken: TOKEN, status: "open", publishedAt: "2026-08-01T10:00:00.000Z",
  } };
  const pfad = "flowertech/intakeForms/" + TOKEN;
  ok(CORE.intakePrefillStale({ intake: data.flowertech.intakes.in_alt }), "ein Link ohne Vorbelegung gilt nicht als nachzuziehen");

  const n = win._ftRefreshIntakePrefills();
  await tick();
  ok(n === 1, `es wurden ${n} Links nachgezogen statt genau einer`);
  ok(written[pfad] && written[pfad].prefill && written[pfad].prefill.values.name === "Herr Aljia",
    "der bestehende Link ist nach dem Nachziehen nicht vorbelegt");
  ok(data.flowertech.intakes.in_alt.inviteToken === TOKEN, "der Token hat sich beim Nachziehen geändert");

  // Ein zweiter Durchlauf tut nichts — der Stand stimmt.
  delete written[pfad];
  ok(win._ftRefreshIntakePrefills() === 0 && !written[pfad], "ein aktueller Link wird erneut veröffentlicht");

  // Kundendaten ändern: der Link zieht nach (gebündelt, im Test sofort).
  win._ftSetClientField("prj_aljia", "company", "Aljia Reinigung GmbH");
  await tick();
  ok(written[pfad] && written[pfad].prefill.values.company === "Aljia Reinigung GmbH",
    "eine geänderte Kundenangabe erreicht den Kundenlink nicht");

  // Beantwortet: in Ruhe lassen — dort zeigt der Link kein Formular mehr.
  data.flowertech.intakes.in_alt.answeredAt = "2026-09-01T09:00:00.000Z";
  delete data.flowertech.intakes.in_alt.prefill;
  delete written[pfad];
  ok(win._ftRefreshIntakePrefills() === 0 && !written[pfad], "ein beantworteter Fragebogen wird nachgezogen");
}

// ── 9. Die Antwort: Korrektur gewinnt, Verlauf benennt sie ────────────────
{
  const { win, data } = makeSandbox();
  data.entities.projects.prj_aljia = JSON.parse(JSON.stringify(ALJIA));
  win._ftCreateProjectIntakeLink("prj_aljia");
  await tick();
  const intake = Object.values(data.flowertech.intakes)[0];
  const answers = CORE.normalizeIntakeAnswers(FRAGEN, {
    projekt: "Reinigungsunternehmen Aljia", name: "Herr Aljia", email: "info@aljia-reinigung.ch",
    phone: "079 000 00 00", adresse: "Weg 1, 8000 Zürich", kind: "Website", need: "Mehr Anfragen",
  }).answers;
  win._ftApplyIntakeToProject("prj_aljia", intake, answers, {});
  const project = data.entities.projects.prj_aljia;
  ok(project.client.email === "info@aljia-reinigung.ch", `die Korrektur der Kundschaft kam nicht am Projekt an: ${project.client.email}`);
  ok(project.client.phone === "079 000 00 00", "die neue Angabe wurde nicht ergänzt");
  ok(project.ftContactLog.some((e) => /korrigiert/.test(e.text) && /E-Mail/.test(e.text)),
    "der Verlauf benennt die Korrektur nicht");
}

console.log(`flowertech kundenlink vorbelegung: ok (${checks} Pruefungen)`);
