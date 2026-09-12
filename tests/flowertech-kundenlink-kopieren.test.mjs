/*
 * Der Kundenlink bleibt derselbe — beliebig oft kopierbar.
 * ---------------------------------------------------------------------------
 * BEFUND (12.09.2026, gemeldet aus der laufenden Arbeit): Ein in der App
 * erstellter Kundenlink liess sich praktisch nur EINMAL kopieren. Danach half
 * scheinbar nur „neu".
 *
 * Zwei Ursachen, beide hier festgehalten:
 *
 *   1. An einer Anfrage stand gar kein Link, sondern nur der Knopf
 *      „Fragebogen-Link kopieren". Die Adresse war ausschliesslich in der
 *      Zwischenablage — ging die verloren, war sie nirgends mehr zu sehen und
 *      liess sich auch nicht von Hand markieren.
 *   2. Der Kopierknopf rief die ANLEGENDE Funktion (intakeForInquiry /
 *      intakeForOffer / intakeForProject). Wurde gerade kein Fragebogen
 *      gefunden, erzeugte ein Klick auf „kopieren" einen zweiten Fragebogen
 *      mit NEUEM Token — der bereits verschickte Link zeigte dann nicht mehr
 *      dorthin, wo die App hinsah.
 *
 * Geprueft wird gegen die ECHTEN Funktionen aus public/flowertech.js, mit
 * Doppeln fuer Zwischenablage, Firebase und Speicher. Keine echten Kundendaten,
 * kein Versand, keine Freigabe.
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

let seed = 1;
function sandbox({ zwischenablageScheitert = false, execCommand = true } = {}) {
  const data = { entities: { projects: {}, tasks: {}, notes: {}, persons: {}, organizations: {} },
    flowertech: {}, meta: {} };
  const kopiert = [];
  const win = {
    APP: { state: { data } }, FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() { win.__speichert++; }, render() {},
    toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __toasts: [], __opened: [], __speichert: 0, __execCommand: 0,
    createEntity: (kind, payload) => {
      const store = kind === "project" ? data.entities.projects : data.entities.tasks;
      const newId = kind + "_" + (Object.keys(store).length + 1) + "_" + (seed++);
      store[newId] = Object.assign({ id: newId }, payload);
      return newId;
    },
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    uuid: () => "u_" + (seed++), nowIso: () => "2026-09-12T10:00:00.000Z", todayYmd: () => "2026-09-12",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; }, clearTimeout() {},
    confirm: () => true, prompt: () => "",
    open: (url) => { win.__opened.push(url); return null; },
  };
  win.window = win;
  const ctx = {
    window: win,
    document: { readyState: "complete", getElementById: () => null, querySelector: () => null,
      addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {}, focus() {}, select() {} }),
      body: { appendChild() {}, removeChild() {}, classList: { toggle() {}, remove() {} } },
      /* Der Rueckfallweg: execCommand meldet einen Fehlschlag als false, ohne
         zu werfen — beide Faelle sind hier einstellbar. */
      execCommand: () => {
        win.__execCommand++;
        if (execCommand === "wirft") throw new Error("nicht erlaubt");
        return execCommand;
      } },
    location: win.location, setTimeout: win.setTimeout, clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: { clipboard: { writeText: (t) => {
      if (zwischenablageScheitert) return Promise.reject(new Error("verweigert"));
      kopiert.push(t); return Promise.resolve();
    } } },
    confirm: () => true, APP: win.APP,
    firebase: { app: () => ({ database: () => ({ ref: () => ({
      set: () => Promise.resolve(), remove: () => Promise.resolve() }) }) }) },
  };
  ctx.globalThis = ctx;
  win.document = ctx.document; win.firebase = ctx.firebase; win.navigator = ctx.navigator;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(ctx));
  win.viewFlowerTech();
  return { win, data, kopiert, ctx };
}

// Die Zwischenablage antwortet als Versprechen — die Bestaetigung kommt einen
// Mikrotakt spaeter. Hier wird darauf gewartet, nicht darauf gehofft.
const takt = () => new Promise((r) => setImmediate(r));

const tokens = (data) => Object.values((data.flowertech || {}).intakes || {})
  .map((i) => i.inviteToken).filter(Boolean);
const warnungen = (win) => win.__toasts.filter((t) => t.type === "warn").map((t) => t.message);

/* ══ 1. Am Projekt: einmal erstellen, beliebig oft kopieren ═══════════════ */
{
  const { win, data, kopiert } = sandbox();
  data.entities.projects.prj_1 = { id: "prj_1", title: "Beispielprojekt", projectType: "flowertech",
    pipelineStage: "lead", client: { company: "Beispielkunde AG", email: "kontakt@example.com" } };

  // Vor dem Erstellen: Kopieren legt NICHTS an und sagt, was zu tun ist.
  win._ftCopyProjectIntakeLink("prj_1");
  ok(tokens(data).length === 0, `Kopieren hat einen Fragebogen erzeugt: ${JSON.stringify(tokens(data))}`);
  ok(kopiert.length === 0, "Kopieren hat etwas in die Zwischenablage gelegt, obwohl es keinen Link gibt");
  ok(warnungen(win).some((m) => /noch keinen Kundenlink/.test(m)),
    `die Auskunft fehlt: ${JSON.stringify(warnungen(win))}`);
  // Kundentext: verstaendlich, ohne Innereien.
  ok(!warnungen(win).some((m) => /Token|rotier/i.test(m)),
    `die Auskunft spricht von Innereien: ${JSON.stringify(warnungen(win))}`);

  // Der bewusste Schritt.
  win._ftCreateProjectIntakeLink("prj_1");
  const token = tokens(data)[0];
  ok(tokens(data).length === 1 && token, `es entstand kein einziger Kundenlink: ${JSON.stringify(tokens(data))}`);
  const url = win._ftProjectIntakeLink("prj_1");
  ok(url && url.includes(token), `der Link traegt den Token nicht: ${url}`);

  // Zehnmal kopieren: derselbe Link, kein zweiter Fragebogen, kein neuer Token.
  for (let i = 0; i < 10; i++) win._ftCopyProjectIntakeLink("prj_1");
  await takt();
  ok(kopiert.length === 10, `es wurden ${kopiert.length} Kopien gemacht statt zehn`);
  ok(kopiert.every((t) => t === url), `die Kopien unterscheiden sich: ${JSON.stringify([...new Set(kopiert)])}`);
  ok(tokens(data).length === 1 && tokens(data)[0] === token,
    `das Kopieren hat den Bestand veraendert: ${JSON.stringify(tokens(data))}`);
  ok(win.__toasts.filter((t) => t.type === "ok").length >= 10, "das Kopieren bestaetigt nicht jedes Mal");

  // Die Zeile am Projekt zeigt den Link — sichtbar und markierbar.
  const zeile = win._ftProjectIntakeRow("prj_1");
  ok(zeile.includes('readonly value="' + url + '"'), "die Adresse steht nicht als markierbares Feld da");
  ok(/_ftCopyProjectIntakeLink/.test(zeile), "der Kopierknopf fehlt an der Zeile");
  ok(zeile.includes('href="' + url + '"'), "der Link laesst sich nicht oeffnen");

  /* „Schliessen und wieder oeffnen" bzw. Reload: dieselben Daten, ein frisch
     geladenes Modul. Der Link muss wieder dastehen — derselbe. */
  const zweite = sandbox();
  zweite.data.entities.projects.prj_1 = data.entities.projects.prj_1;
  zweite.data.flowertech = JSON.parse(JSON.stringify(data.flowertech));
  const nachReload = zweite.win._ftProjectIntakeLink("prj_1");
  ok(nachReload === url, `nach dem Neuladen steht ein anderer Link da: ${nachReload}`);
  zweite.win._ftCopyProjectIntakeLink("prj_1");
  await takt();
  ok(zweite.kopiert.length === 1 && zweite.kopiert[0] === url, "nach dem Neuladen wird etwas anderes kopiert");
  ok(tokens(zweite.data).length === 1 && tokens(zweite.data)[0] === token,
    "nach dem Neuladen entstand ein zweiter Kundenlink");

  // Neu erzeugen bleibt der getrennte, ausdrueckliche Weg.
  const vorRotation = tokens(data)[0];
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  win._ftRotateIntakeToken(intakeId);
  ok(tokens(data)[0] !== vorRotation, "der ausdrueckliche Weg erneuert den Token nicht");
  ok(tokens(data).length === 1, "die Erneuerung hat einen zweiten Fragebogen erzeugt");
}

/* ══ 2. An der Anfrage: der Link steht da, statt nur in der Zwischenablage ═ */
{
  const { win, data, kopiert } = sandbox();
  const ft = data.flowertech;
  ft.inquiries = ft.inquiries || {};
  ft.inquiries.inq_1 = { id: "inq_1", name: "Beispielperson", company: "Beispielkunde AG",
    email: "kontakt@example.com", message: "Beispielanfrage", status: "new",
    createdAt: "2026-09-12T09:00:00.000Z" };

  // Ohne Link: nur der eine bewusste Knopf, und Kopieren legt nichts an.
  const leer = win._ftInquiryLinkHtml("inq_1");
  ok(/_ftCreateInquiryIntakeLink/.test(leer) && !/readonly/.test(leer),
    `ohne Link steht die falsche Zeile da: ${leer}`);
  win._ftCopyInquiryIntakeLink("inq_1");
  ok(tokens(data).length === 0, "Kopieren hat an der Anfrage einen Fragebogen erzeugt");
  ok(warnungen(win).some((m) => /noch keinen Kundenlink/.test(m)), "die Auskunft an der Anfrage fehlt");

  win._ftCreateInquiryIntakeLink("inq_1");
  const token = tokens(data)[0];
  const url = win._ftInquiryIntakeLink("inq_1");
  ok(token && url.includes(token), `der Link der Anfrage fehlt: ${url}`);

  const zeile = win._ftInquiryLinkHtml("inq_1");
  ok(zeile.includes('readonly value="' + url + '"'), "die Adresse der Anfrage ist nicht markierbar");
  ok(/_ftCopyInquiryIntakeLink/.test(zeile) && zeile.includes('href="' + url + '"'),
    "Kopieren oder Oeffnen fehlt an der Anfrage");

  for (let i = 0; i < 5; i++) win._ftCopyInquiryIntakeLink("inq_1");
  await takt();
  ok(kopiert.length === 5 && kopiert.every((t) => t === url), "die Anfrage kopiert nicht immer denselben Link");
  ok(tokens(data).length === 1 && tokens(data)[0] === token,
    `das Kopieren an der Anfrage hat den Bestand veraendert: ${JSON.stringify(tokens(data))}`);
}

/* ══ 3. Wenn die Zwischenablage verweigert ════════════════════════════════
   BEFUND aus der Durchsicht von PR257: Der Rueckfallweg rief
   document.execCommand("copy") und meldete danach unbesehen Erfolg.
   execCommand gibt einen Fehlschlag aber als false zurueck, ohne zu werfen —
   die Meldung "kopiert" stand dann ueber einer leeren Zwischenablage, und die
   Adresse galt als weitergegeben, die niemand hatte.
   Geprueft werden alle drei Ausgaenge des Rueckfalls, jedes Mal mit
   verweigerter Zwischenablage (navigator.clipboard lehnt ab). */
async function mitRueckfall(execCommand) {
  const { win, data } = sandbox({ zwischenablageScheitert: true, execCommand });
  data.entities.projects.prj_1 = { id: "prj_1", title: "Beispielprojekt", projectType: "flowertech",
    pipelineStage: "lead", client: { company: "Beispielkunde AG", email: "kontakt@example.com" } };
  win._ftCreateProjectIntakeLink("prj_1");
  const vorher = tokens(data).slice();
  win.__toasts.length = 0;
  win._ftCopyProjectIntakeLink("prj_1");
  await takt();
  return { win, data, vorher, nachher: tokens(data) };
}
{
  // a) execCommand meldet false: kein Erfolg behaupten.
  const { win, vorher, nachher } = await mitRueckfall(false);
  const erfolg = win.__toasts.filter((t) => t.type === "ok");
  const warnung = win.__toasts.filter((t) => t.type === "warn");
  ok(win.__execCommand === 1, `der Rueckfallweg lief nicht (${win.__execCommand})`);
  ok(erfolg.length === 0, `es wurde Erfolg gemeldet, obwohl execCommand false lieferte: ${JSON.stringify(erfolg)}`);
  ok(warnung.length === 1 && /Feld daneben/.test(warnung[0].message),
    `der Hinweis auf das Adressfeld fehlt: ${JSON.stringify(warnung)}`);
  ok(JSON.stringify(vorher) === JSON.stringify(nachher), "der Fehlschlag hat den Token veraendert");
}
{
  // b) execCommand wirft: dasselbe Ergebnis.
  const { win, vorher, nachher } = await mitRueckfall("wirft");
  ok(win.__toasts.filter((t) => t.type === "ok").length === 0, "eine Ausnahme wurde als Erfolg gemeldet");
  ok(win.__toasts.some((t) => t.type === "warn" && /Feld daneben/.test(t.message)),
    "nach der Ausnahme fehlt der Hinweis auf das Adressfeld");
  ok(JSON.stringify(vorher) === JSON.stringify(nachher), "die Ausnahme hat den Token veraendert");
}
{
  // c) execCommand gelingt: genau eine Bestaetigung, kein Warnhinweis.
  const { win, vorher, nachher } = await mitRueckfall(true);
  ok(win.__toasts.filter((t) => t.type === "ok").length === 1,
    `der gelungene Rueckfall bestaetigt nicht genau einmal: ${JSON.stringify(win.__toasts)}`);
  ok(!win.__toasts.some((t) => t.type === "warn"), "der gelungene Rueckfall warnt trotzdem");
  ok(JSON.stringify(vorher) === JSON.stringify(nachher), "der Rueckfall hat den Token veraendert");
}

/* ══ 4. Quelltext: kein Kopierweg ruft eine anlegende Funktion ════════════ */
{
  const quelle = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");
  [["Projekt", "_ftCopyProjectIntakeLink"], ["Anfrage", "_ftCopyInquiryIntakeLink"], ["Offerte", "_ftCopyOfferIntakeLink"]]
    .forEach(([was, name]) => {
      const start = quelle.indexOf("window." + name + " = function");
      ok(start > 0, `${name} wurde nicht gefunden`);
      // Ohne Kommentare: dort steht der Name absichtlich (als Begruendung).
      const koerper = quelle.slice(start, quelle.indexOf("\n  };", start))
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      ok(!/intakeFor(Project|Inquiry|Offer)\(/.test(koerper),
        `der Kopierweg ${was} ruft eine anlegende Funktion — genau das erzeugte zweite Tokens`);
      ok(!/makeToken\(|rotate/i.test(koerper), `der Kopierweg ${was} erzeugt oder dreht einen Token`);
    });
}

console.log(`flowertech kundenlink kopieren: ok (${checks} Pruefungen)`);
