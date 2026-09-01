/*
 * FlowerTech — ein einzelner fehlgeschlagener Fragebogen-Link lässt sich
 * reparieren, ohne ihn zu widerrufen.
 * ---------------------------------------------------------------------------
 * Produktionsbefund: Der Kundenlink fuer PRJ-A4C6J
 * (https://flowertech.ch/fragebogen.html?e=<Token>) zeigte "Der Fragebogen
 * konnte nicht geladen werden" — obwohl Quantus selbst synchron war. Ursache:
 * publishIntakeForm() schreibt den veroeffentlichten Fragebogen unter
 * flowertech/intakeForms/<Token>; scheitert genau DIESER eine Schreibversuch
 * (z.B. weil Firebase beim Anlegen noch nicht bereit war), blieb der
 * Datensatz fuer immer leer — ohne dass irgendwo im Programm automatisch
 * nachgefasst wurde. Der bisherige einzige Reparaturweg war "Neu" (token
 * rotieren), was den bereits verschickten Link absichtlich ungueltig macht
 * (siehe tests/flowertech-kundenanfrage.test.mjs §9) — fuer einen simplen
 * Schreibfehler die falsche, weil unnoetig destruktive Antwort.
 *
 * Dieser Test sichert den neuen, gezielten Reparaturweg ab:
 * window._ftRepublishIntakeNow(intakeId) schreibt DENSELBEN Token erneut,
 * sobald der Fehler behoben ist — der bereits verschickte Link bleibt gueltig.
 * Ausserdem: der Fehlerzustand ist VOR der Reparatur sichtbar (Statusabzeichen
 * + intakePublication()) und wird technisch protokolliert (console.error).
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

function makeSandbox() {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  const written = {};
  const errors = [];
  const toasts = [];
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {},
    toast(type, title, message) { toasts.push({ type, title, message }); },
    __written: written,
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
    crypto: { getRandomValues: (a) => { a.forEach((_, i) => { a[i] = (i * 41 + 7) % 256; }); } },
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
    console: { warn() {}, log() {}, error: (...args) => errors.push(args.map(String).join(" ")) },
    navigator: {},
    confirm: () => true,
    APP: win.APP,
    // Zu Beginn KEIN Firebase-Zugang — das simuliert genau die Race-Bedingung
    // (SDK beim Anlegen noch nicht bereit) bzw. einen echten Ausfall.
    firebase: {},
  };
  sandbox.globalThis = sandbox;
  win.document = sandbox.document;
  win.firebase = sandbox.firebase;
  win.__fields = fields;
  vm.runInContext(fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8"), vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written, errors, toasts, ctx: sandbox };
}

// ── 1. Veröffentlichung scheitert ohne Firebase — sichtbar UND protokolliert ──
{
  const { win, data, written, errors } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  const intake = data.flowertech.intakes[intakeId];
  const token = intake.inviteToken;

  ok(!written["flowertech/intakeForms/" + token], "ohne Firebase wurde trotzdem etwas veröffentlicht");
  ok(!!intake.publishError, "der Fehlschlag wird nirgends vermerkt");
  ok(errors.some((e) => e.includes(token)), "der Fehlschlag wird nicht technisch protokolliert (console.error)");

  const pub = CORE.intakePublication({ intake });
  ok(pub.ok === false, "ein nie veröffentlichter Fragebogen gilt fälschlich als bestätigt");
  ok(!!pub.reason, "der Fehlerzustand liefert keinen verständlichen Grund");
}

// ── 2. Reparatur: derselbe Token, kein Widerruf, klare Rückmeldung ─────────
{
  const { win, data, written, toasts, ctx } = makeSandbox();
  win._ftNewIntake();
  const intakeId = Object.keys(data.flowertech.intakes)[0];
  const intake = data.flowertech.intakes[intakeId];
  const token = intake.inviteToken;
  ok(!written["flowertech/intakeForms/" + token], "Vorbedingung verletzt: es wurde doch veröffentlicht");

  // Firebase wird verfügbar (z.B. SDK ist jetzt initialisiert) — ohne den
  // Kundenlink zu wechseln.
  ctx.firebase = {
    app: () => ({ database: () => ({ ref: (p) => ({
      set: (v) => { written[p] = v; return Promise.resolve(); },
      remove: () => { delete written[p]; return Promise.resolve(); },
    }) }) }),
  };
  win.firebase = ctx.firebase;

  win._ftRepublishIntakeNow(intakeId);
  // Das Schreiben ist echt asynchron (auch ein bereits erfuelltes Promise
  // loest .then() erst als Microtask aus) — dem Motor Zeit geben, fertig zu
  // werden, bevor der bestätigte Zustand geprüft wird.
  await new Promise((r) => setTimeout(r, 0));

  ok(intake.inviteToken === token, "die Reparatur hat den Kundenlink gewechselt — das war nicht nötig");
  ok(!!written["flowertech/intakeForms/" + token], "der Fragebogen ist nach der Reparatur immer noch nicht online");
  ok(!intake.publishError, "der Fehlerzustand bleibt nach erfolgreicher Reparatur bestehen");
  ok(CORE.intakePublication({ intake }).ok === true, "die Reparatur gilt intern nicht als bestätigt");
  ok(toasts.some((t) => t.type === "ok"), "die erfolgreiche Reparatur wird nicht gemeldet");
}

console.log(`flowertech intake republish: ok (${checks} Prüfungen)`);
