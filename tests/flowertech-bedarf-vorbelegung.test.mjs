/*
 * Der interne Bedarf und die Vorbelegung des Kundenlinks.
 * ---------------------------------------------------------------------------
 * Drei Befunde vom 07.09.2026 am laufenden Betrieb — alle drei mit derselben
 * Wirkung: Die Kundschaft tippt ab, was FlowerTech längst weiss.
 *
 *   1. Die intern erfasste E-Mail (#ftBrief_contactEmail) liess sich nicht
 *      speichern. Sie stand nach dem Übernehmen wieder leer da, obwohl die
 *      Vertriebsadresse vorhanden war. Ursache: applyBriefing verwarf den
 *      GANZEN Bedarf, solange nicht auch ein Ziel von mindestens zehn Zeichen
 *      dastand — die eben eingetippte E-Mail ging mit unter.
 *
 *   2. normalizeBriefing() baut jedes Feld neu auf. Ein Aufruf mit nur einem
 *      Teil der Felder löschte deshalb alle übrigen: ein Formularausschnitt
 *      räumte den gepflegten Rest ab.
 *
 *   3. Der Kundenlink kam trotz Vorbelegung leer an. Sie gibt es seit dem
 *      01.09.2026 (intakePrefill), sie rechnet aber aus Projekt, Person,
 *      Anfrage und Offerte — nicht aus dem intern erfassten Bedarf. Solange
 *      die Kundenakte leer war und der Bedarf (siehe 1.) gar nicht erst
 *      gespeichert wurde, gab es schlicht nichts vorzubelegen.
 *
 * Bewiesen wird hier:
 *   · Erfasstes wird gespeichert, sobald überhaupt etwas dasteht — und was
 *     schon dastand, bleibt stehen.
 *   · Aufgaben und Leistungsbeschreibung entstehen weiterhin erst, wenn der
 *     Bedarf reif ist (E-Mail und Ziel). Eine Preisofferte entsteht dabei nie.
 *   · Der erfasste Bedarf erreicht die Vorbelegung des Kundenlinks — als
 *     LETZTE Quelle, hinter allem Gepflegten. Unbekanntes (Telefon, Adresse)
 *     wird nicht erfunden, die Vorgabe des internen Formulars ("Website")
 *     gilt nicht als Auswahl der Kundschaft.
 *
 * Teil 1 prüft die reine Logik, Teil 2 führt flowertech.js wirklich aus.
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

const NOW = "2026-09-07T10:00:00.000Z";

/* ══ Teil 1 · Der Bedarf wird ergänzt, nicht ersetzt ═══════════════════════ */
{
  // Nur die E-Mail eintragen — genau der gemeldete Fall.
  const ersteEingabe = CORE.mergeBriefing(null, { contactEmail: "juledal19@gmail.com" }, { now: NOW });
  ok(ersteEingabe.contactEmail === "juledal19@gmail.com",
    `die eingetragene E-Mail überlebt das Zusammenführen nicht: ${ersteEingabe.contactEmail}`);
  ok(CORE.briefingHasContent(ersteEingabe), "eine eingetragene E-Mail gilt als leerer Bedarf");
  ok(!CORE.briefingIsUsable(ersteEingabe), "ein Bedarf ohne Ziel gilt bereits als reif");
  eq(CORE.briefingMissingFields(ersteEingabe), ["Ziel"],
    "es wird nicht benannt, was für den nächsten Schritt noch fehlt");

  // Ein leeres Formular ist kein Inhalt — auch nicht mit der Vorgabe "website".
  ok(!CORE.briefingHasContent(CORE.mergeBriefing(null, {}, { now: NOW })),
    "ein leeres Formular gilt als ausgefüllter Bedarf");

  // Der zweite Aufruf trägt nur einen Ausschnitt: alles Übrige bleibt stehen.
  const gepflegt = CORE.mergeBriefing(null, {
    contactName: "Jule Dal", contactEmail: "juledal19@gmail.com", company: "FlowerTech",
    deliveryType: "program", goal: "Ein Programm für die Auftragsverwaltung.",
    features: "Login\nAuswertung", budget: "8000",
  }, { now: NOW });
  const nurNotiz = CORE.mergeBriefing(gepflegt, { notes: "Rückruf am Montag" }, { now: NOW });
  ok(nurNotiz.contactEmail === "juledal19@gmail.com", "die E-Mail wird von einem Teilformular gelöscht");
  ok(nurNotiz.contactName === "Jule Dal" && nurNotiz.company === "FlowerTech",
    "Name oder Firma werden von einem Teilformular gelöscht");
  eq(nurNotiz.features, ["Login", "Auswertung"], "die Funktionen werden von einem Teilformular gelöscht");
  ok(nurNotiz.budget === 8000, "das Budget wird von einem Teilformular gelöscht");
  ok(nurNotiz.deliveryType === "program",
    `die Lieferart fällt auf die Vorgabe zurück: ${nurNotiz.deliveryType}`);
  ok(nurNotiz.notes === "Rückruf am Montag", "die neue Notiz kommt nicht an");

  // Was wirklich neu eingetragen wurde, gilt — Ergänzen heisst nicht Einfrieren.
  const korrigiert = CORE.mergeBriefing(gepflegt, { contactEmail: "neu@flowertech.ch" }, { now: NOW });
  ok(korrigiert.contactEmail === "neu@flowertech.ch", "eine Korrektur kommt nicht durch");
  ok(CORE.briefingIsUsable(korrigiert), "der zusammengeführte Bedarf gilt nicht mehr als reif");

  // Der Zeitpunkt der ersten Erfassung bleibt erhalten.
  ok(korrigiert.firstSeenAt === NOW, "die erste Erfassung wird nicht festgehalten");
}

/* ══ Teil 2 · Der erfasste Bedarf erreicht die Vorbelegung ════════════════
   Die Vorbelegung des Kundenlinks (intakePrefill) rechnet aus Projekt, Person,
   Anfrage und Offerte. Was FlowerTech eben erst intern aufgenommen hat, stand
   in keiner dieser Quellen — solange die Kundenakte leer ist, blieb der Bogen
   leer. Der Bedarf steht deshalb ZULETZT in der Reihe: Gepflegtes gewinnt. */
{
  const fragen = CORE.DEFAULT_INTAKE_QUESTIONS;
  const bedarf = CORE.mergeBriefing(null, {
    contactName: "Jule Dal", contactEmail: "juledal19@gmail.com", company: "FlowerTech",
  }, { now: NOW });

  const ausBedarf = CORE.intakePrefill({
    intake: { questions: fragen }, project: { id: "prj_1", client: {} }, briefing: bedarf,
  });
  ok(ausBedarf.values.email === "juledal19@gmail.com",
    "die intern erfasste E-Mail erreicht die Vorbelegung nicht");
  ok(ausBedarf.values.name === "Jule Dal" && ausBedarf.values.company === "FlowerTech",
    "Name oder Firma aus dem Bedarf erreichen die Vorbelegung nicht");

  // Unbekanntes wird nicht erfunden.
  ok(!("phone" in ausBedarf.values), "ein Telefon wird erfunden, obwohl keines hinterlegt ist");
  ok(!("adresse" in ausBedarf.values), "eine Adresse wird erfunden, obwohl keine hinterlegt ist");
  // Und die Art des Vorhabens nicht aus der Vorgabe des internen Formulars.
  ok(!("kind" in ausBedarf.values),
    "die Vorgabe des Bedarfsformulars wird als Auswahl der Kundschaft ausgegeben");

  // Die gepflegte Kundenakte hat Vorrang vor dem Bedarf.
  const vorrang = CORE.intakePrefill({
    intake: { questions: fragen },
    project: { id: "prj_2", client: { email: "akte@flowertech.ch" } },
    briefing: CORE.mergeBriefing(null, { contactEmail: "bedarf@flowertech.ch" }, { now: NOW }),
  });
  ok(vorrang.values.email === "akte@flowertech.ch", "der Bedarf überstimmt die gepflegte Kundenakte");
}

/* ══ Teil 3 · Eine halbe Bedingung ist keine Bedingung ═════════════════════
   Eine bedingte Frage ohne Wert hiess bisher „sichtbar, solange die andere
   Frage LEER ist". Die Frage verschwand also genau dann, wenn die vorige
   beantwortet war — und fiel damit still aus der Pflichtfeldprüfung. Genau so
   nannte die Statusanzeige auf Blatt 2 nur die Adresse als fehlend. */
{
  const fragen = CORE.normalizeIntakeQuestions([
    { key: "kind", label: "Was brauchen Sie?", type: "select", options: ["Website", "Web-App"] },
    { key: "email", label: "E-Mail", type: "email", required: true, showIf: { key: "kind" } },
    { key: "phone", label: "Telefon", type: "tel", required: true, showIf: { key: "kind", value: "" } },
    { key: "domain", label: "Domainname", type: "text", showIf: { key: "kind", value: "Website" } },
  ]);
  ok(fragen[1].showIf === null, "eine Bedingung ohne Wert versteckt die Pflichtfrage weiterhin");
  ok(fragen[2].showIf === null, "eine Bedingung mit leerem Wert versteckt die Pflichtfrage weiterhin");
  ok(fragen[3].showIf && fragen[3].showIf.value === "Website",
    "eine vollständige Bedingung geht verloren");
}

/* ══ Teil 4 · Laufzeit: die E-Mail bleibt stehen ═══════════════════════════ */
let seed = 0;
function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  const written = {};
  const felder = {};                      // die Eingabefelder des Bedarfsformulars
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {},
    toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __written: written, __toasts: [], __felder: felder,
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1) + "_" + (seed++);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (seed++),
    nowIso: () => NOW,
    todayYmd: () => "2026-09-07",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    prompt: () => "",
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      getElementById: (id) => felder[id] || null,
      querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {}, focus() {}, select() {} }),
      body: { appendChild() {}, removeChild() {}, classList: { toggle() {}, remove() {} } },
      execCommand: () => true,
    },
    location: win.location,
    setTimeout: win.setTimeout,
    clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
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
  win.confirm = sandbox.confirm;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written, felder };
}

// Das Bedarfsformular so ausfüllen, wie es intern geschieht: in die Felder
// tippen und "Bedarf übernehmen" drücken.
const tippen = (felder, werte) => {
  Object.keys(werte).forEach((key) => { felder["ftBrief_" + key] = { value: werte[key] }; });
};

{
  const { win, data, felder } = makeSandbox();
  data.entities.projects.prj_1 = {
    id: "prj_1", title: "FlowerTech Vertrieb", projectType: "flowertech", pipelineStage: "lead",
    client: {}, createdAt: "2026-09-01T10:00:00.000Z",
  };

  // 1. Nur die E-Mail — der gemeldete Fall.
  tippen(felder, { contactEmail: "juledal19@gmail.com" });
  win._ftSaveBriefing("prj_1");
  const gespeichert = data.flowertech.briefings.prj_1;
  ok(gespeichert && gespeichert.contactEmail === "juledal19@gmail.com",
    "die intern erfasste E-Mail wird weiterhin verworfen");
  ok(data.entities.projects.prj_1.client.email === "juledal19@gmail.com",
    "die erfasste E-Mail erreicht die Kundenakte nicht");
  ok(Object.keys(data.entities.tasks).length === 0,
    "aus einem unfertigen Bedarf entstehen bereits Aufgaben");
  ok(!data.flowertech.contentDocs.prj_1,
    "aus einem unfertigen Bedarf entsteht bereits eine Leistungsbeschreibung");
  const letzte = win.__toasts[win.__toasts.length - 1];
  ok(/Ziel/.test(letzte.message) && /Gespeichert/.test(letzte.message),
    `die Meldung sagt nicht, was gespeichert wurde und was fehlt: ${letzte.message}`);

  // 2. Nach dem Neuaufbau steht die E-Mail wieder im Feld — genau das ging
  //    verloren ("fällt nach der Eingabe wieder auf leer zurück").
  win._ftSetProjectTab("prj_1", "bedarf");
  const html = String(win.ftWorkflowPanel("prj_1"));
  ok(/id="ftBrief_contactEmail"[^>]*value="juledal19@gmail\.com"/.test(html),
    "das Bedarfsformular zeigt die gespeicherte E-Mail nicht wieder an");

  // 3. Das Ziel nachtragen: erst jetzt entstehen Aufgaben — und nichts geht
  //    dabei verloren. Eine Preisofferte entsteht dabei nie.
  tippen(felder, { contactEmail: "juledal19@gmail.com", goal: "Mehr Anfragen über die Website erhalten." });
  win._ftSaveBriefing("prj_1");
  ok(data.flowertech.briefings.prj_1.contactEmail === "juledal19@gmail.com",
    "die E-Mail geht beim Nachtragen des Ziels verloren");
  ok(Object.keys(data.entities.tasks).length > 0, "aus dem reifen Bedarf entstehen keine Aufgaben");
  ok(!Object.values(data.flowertech.offers || {}).length, "es entsteht ungefragt eine Offerte");

  // 4. Der Kundenlink trägt die Angaben — ohne dass jemand sie abtippt.
  data.entities.projects.prj_1.client.name = "Jule Dal";
  data.entities.projects.prj_1.client.company = "FlowerTech";
  win._ftCreateProjectIntakeLink("prj_1");
  const intake = Object.values(data.flowertech.intakes)[0];
  const pfad = "flowertech/intakeForms/" + intake.inviteToken;
  const veroeffentlicht = win.__written[pfad];
  ok(veroeffentlicht, "der Kundenlink wurde gar nicht veröffentlicht");
  const vorbelegt = (veroeffentlicht.prefill || {}).values || {};
  ok(vorbelegt.email === "juledal19@gmail.com", "die E-Mail fehlt im veröffentlichten Kundenlink");
  ok(vorbelegt.name === "Jule Dal" && vorbelegt.company === "FlowerTech",
    "Name oder Firma fehlen im veröffentlichten Kundenlink");
  ok(vorbelegt.kind === "Website", `die Lieferart fehlt im Kundenlink: ${vorbelegt.kind}`);
  ok(!("phone" in vorbelegt) && !("adresse" in vorbelegt),
    "Telefon oder Adresse werden im Kundenlink erfunden");
  ok(!JSON.stringify(veroeffentlicht).includes("prj_1"),
    "die Projekt-ID steht im veröffentlichten Kundenlink");
}

console.log(`flowertech bedarf & vorbelegung: ok (${checks} Pruefungen)`);
