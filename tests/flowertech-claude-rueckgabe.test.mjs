/*
 * Die Veröffentlichung sagt die Wahrheit — und die Claude-Code-Rückgabe.
 * ---------------------------------------------------------------------------
 * Anlass ist ein Live-Befund am Projekt Lehner: `previewUrl` war gesetzt, die
 * Vorschau-Freigabe aktiv, Quantus meldete „sichtbar" — und auf der stabilen
 * Kundenadresse `flowertech.ch/fragebogen.html?e=<token>` fehlte die Vorschau.
 *
 * Die Ursache lag nicht in der Anzeige, sondern in einer Verwechslung: Eine
 * Freigabe in Quantus ist eine ABSICHT. Sichtbar wird sie erst, wenn der
 * Datensatz unter `flowertech/intakeForms/<token>` wirklich neu geschrieben
 * ist. Genau dieses Schreiben lief ins Leere, ohne dass es jemand erfuhr:
 *
 *   • `publishIntakeForm()` schrieb asynchron und meldete nichts zurück;
 *     ohne Firebase-Zugang setzte es still einen Vermerk.
 *   • `refreshCustomerArea()` gab „true" zurück, egal was passierte.
 *   • `setCustomerRelease()` las diesen Rückgabewert gar nicht erst und
 *     meldete in jedem Fall „ist jetzt im Kundenbereich sichtbar".
 *   • `contractHtml`/`contractTitle` wurden dem Kern nie übergeben — die
 *     Vertragskachel konnte auf dem Kundenlink gar nicht erscheinen.
 *
 * Dazu der künftige Standardablauf: Quantus erzeugt den Prompt → Codex übergibt
 * an Claude Code → Claude Code veröffentlicht und liefert EINE HTTPS-Adresse
 * zurück → sie wird bestätigt → erst dann ist die reguläre Vorschau-Freigabe
 * eine erledigte Claude-Vorschau. Eine von Hand eingetippte Adresse ist das
 * ausdrücklich NICHT — sie bleibt eine manuelle Testvorschau.
 *
 * Bewiesen wird:
 *
 *   1.  Der Nachweis der Veröffentlichung ist eine eigene Grösse (`publication`).
 *   2.  Die vier Stationen der Claude-Code-Rückgabe und ihre Übergänge.
 *   3.  Die Herkunft der Vorschau-Adresse: bestätigte Rückgabe oder manuell.
 *   4.  Laufzeit: Die Freigabe landet wirklich im veröffentlichten Datensatz —
 *       samt genau der Adresse aus dem Live-Befund.
 *   5.  Laufzeit: Scheitert das Schreiben, meldet Quantus den Fehlschlag und
 *       behauptet NICHT „sichtbar".
 *   6.  Laufzeit: Der ganze Claude-Weg bis zur erledigten Claude-Vorschau.
 *   7.  Laufzeit: Vertrag, AGB und TEST-Übersicht stehen im selben Datensatz.
 *   8.  Der veröffentlichte Datensatz trägt genau die Felder, die die
 *       öffentliche Seite liest — und weiterhin keine internen Daten.
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

/* Die Adresse aus dem Live-Befund — Zeichen für Zeichen. */
const LEHNER_URL = "https://beispiel-lehner.netlify.app/";
const PROMPT_DA = { text: "# Auftrag: Lehner", updatedAt: "2026-08-08T10:00:00.000Z" };

/* ══ Teil 1 — Der Kern ═════════════════════════════════════════════════════ */

// ── 1. Der Nachweis der Veröffentlichung ist eine eigene Grösse ───────────
{
  const nie = CORE.intakePublication({ intake: {} });
  ok(!nie.ok && /noch nie veröffentlicht/.test(nie.reason),
    `ein nie veröffentlichter Link gilt als veröffentlicht: ${nie.reason}`);

  const laeuft = CORE.intakePublication({
    intake: { publishPending: true, publishRequestedAt: "2026-08-10T10:00:00.000Z" },
  });
  ok(!laeuft.ok && laeuft.pending, "ein laufender Versuch gilt bereits als bestätigt");

  const kaputt = CORE.intakePublication({
    intake: { publishedAt: "2026-08-10T09:00:00.000Z", publishError: "Kein Firebase-Zugang" },
  });
  ok(!kaputt.ok && /Firebase/.test(kaputt.reason),
    "ein Fehlschlag gilt als erfolgreiche Veröffentlichung");

  // Ein Versuch NACH der letzten Bestätigung heisst: veralteter Stand.
  const alt = CORE.intakePublication({
    intake: { publishedAt: "2026-08-10T09:00:00.000Z", publishRequestedAt: "2026-08-10T10:00:00.000Z" },
  });
  ok(!alt.ok && alt.stale, "ein veralteter Stand gilt als aktuell");

  const gut = CORE.intakePublication({
    intake: { publishedAt: "2026-08-10T10:00:00.000Z", publishRequestedAt: "2026-08-10T09:59:00.000Z" },
  });
  ok(gut.ok && !gut.reason, `eine bestätigte Veröffentlichung gilt nicht: ${gut.reason}`);
}

// ── 2. Die vier Stationen der Claude-Code-Rückgabe ────────────────────────
{
  const keys = CORE.CLAUDE_HANDOFF_STEPS.map((s) => s.key);
  ok(keys.join(",") === "open,waiting,review,confirmed",
    `die Stationen stimmen nicht: ${keys.join(",")}`);
  const label = (key) => CORE.CLAUDE_HANDOFF_STEPS.find((s) => s.key === key).label;
  ok(label("waiting") === "Warte auf Claude Code", "die Wartestation heisst anders");
  ok(label("review") === "Rückgabe-Link prüfen", "die Prüfstation heisst anders");
  ok(label("confirmed") === "freigegeben", "die Schlussstation heisst anders");
  CORE.CLAUDE_HANDOFF_STEPS.forEach((s) => {
    ok(s.label && s.hint, `die Station „${s.key}“ ist nicht erklärt`);
  });

  const leer = CORE.claudeHandoffState({ project: { id: "p1" } });
  ok(leer.status === "open" && !leer.confirmed, "ein leeres Projekt gilt als übergeben");

  const wartet = CORE.claudeHandoffState({
    project: { id: "p1", ftClaudeHandoff: { requestedAt: "2026-08-10T08:00:00.000Z" } },
  });
  ok(wartet.status === "waiting" && wartet.statusLabel === "Warte auf Claude Code",
    `nach der Übergabe steht der Status auf „${wartet.status}“`);
  ok(!wartet.returnedUrl, "aus dem Nichts entsteht eine Rückgabe-Adresse");

  const prueft = CORE.claudeHandoffState({
    project: {
      id: "p1",
      ftClaudeHandoff: { requestedAt: "2026-08-10T08:00:00.000Z", returnedUrl: LEHNER_URL, returnedAt: "2026-08-10T09:00:00.000Z" },
    },
  });
  ok(prueft.status === "review", `eine eingetragene Rückgabe steht auf „${prueft.status}“`);
  ok(!prueft.confirmed && !prueft.regularReady,
    "eine bloss eingetragene Rückgabe gilt schon als bestätigt");

  const fertig = CORE.claudeHandoffState({
    project: {
      id: "p1", previewUrl: LEHNER_URL,
      ftClaudeHandoff: {
        requestedAt: "2026-08-10T08:00:00.000Z", returnedUrl: LEHNER_URL,
        returnedAt: "2026-08-10T09:00:00.000Z", confirmedAt: "2026-08-10T09:30:00.000Z",
      },
    },
  });
  ok(fertig.status === "confirmed" && fertig.confirmed, "die Bestätigung greift nicht");
  ok(fertig.regularReady && fertig.matchesPreview,
    "die bestätigte Rückgabe gilt nicht als reguläre Grundlage");
  ok(fertig.steps.filter((s) => s.done).length === 3 && fertig.steps[3].current,
    "der Fortschritt der Stationen stimmt nicht");

  // Eine unsichere Rückgabe ist keine Rückgabe.
  const unsicher = CORE.claudeHandoffState({
    project: { id: "p1", ftClaudeHandoff: { requestedAt: "x", returnedUrl: "http://beispiel-lehner.netlify.app/" } },
  });
  ok(unsicher.status === "waiting" && !unsicher.returnedUrl,
    "eine http-Adresse zählt als Claude-Code-Rückgabe");
}

// ── 3. Herkunft: bestätigte Rückgabe oder manuell — nie verwechselt ───────
{
  // Der Lehner-Stand von heute: eine Adresse ohne jede Rückgabe.
  const manuell = { id: "p1", previewUrl: LEHNER_URL, ftCustomerPreview: { released: true, releasedAt: "2026-08-09T08:00:00.000Z" } };
  const state = CORE.claudeHandoffState({ project: manuell });
  ok(state.previewSource === CORE.PREVIEW_SOURCE_MANUAL,
    `die manuelle Adresse gilt als „${state.previewSource}“`);
  ok(!state.regularReady, "eine manuelle Adresse gilt als erledigte Claude-Vorschau");

  const rel = CORE.customerPreviewRelease({ project: manuell, prompt: PROMPT_DA });
  // Teil A bleibt unberührt: Die Kachel erscheint, sie wird nur ehrlich benannt.
  ok(rel.visible, "die freigegebene Vorschau verschwindet wegen der Herkunft");
  ok(rel.source === CORE.PREVIEW_SOURCE_MANUAL && rel.provisional && !rel.claudeConfirmed,
    "die manuelle Vorschau wird nicht als Testvorschau gekennzeichnet");
  ok(/manuelle Testvorschau/.test(rel.sourceReason),
    `die Herkunft wird nicht benannt: ${rel.sourceReason}`);

  // Dieselbe Adresse, aber als bestätigte Rückgabe: jetzt ist sie fertig.
  const claude = Object.assign({}, manuell, {
    ftClaudeHandoff: {
      requestedAt: "2026-08-10T08:00:00.000Z", returnedUrl: LEHNER_URL,
      returnedAt: "2026-08-10T09:00:00.000Z", confirmedAt: "2026-08-10T09:30:00.000Z",
    },
  });
  const relC = CORE.customerPreviewRelease({ project: claude, prompt: PROMPT_DA });
  ok(relC.claudeConfirmed && !relC.provisional && relC.source === CORE.CLAUDE_HANDOFF_SOURCE,
    "die bestätigte Rückgabe gilt nicht als Claude-Vorschau");

  // Und eine ANDERE Adresse neben der Bestätigung bleibt manuell — genau das
  // verhindert, dass irgendeine eingetippte URL als Claude-Ergebnis durchgeht.
  const getauscht = Object.assign({}, claude, { previewUrl: "https://etwas-anderes.example.ch/" });
  const relT = CORE.customerPreviewRelease({ project: getauscht, prompt: PROMPT_DA });
  ok(relT.source === CORE.PREVIEW_SOURCE_MANUAL && relT.provisional,
    "eine ausgetauschte Adresse erbt die Bestätigung von Claude Code");
}

/* ══ Teil 2 — Laufzeit ════════════════════════════════════════════════════ */

let seed = 0;
function makeSandbox({ firebase = "ok" } = {}) {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
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
  // Drei Lagen: alles gut, das Schreiben scheitert, oder es gibt gar keinen
  // Zugang. Die zweite und die dritte sind die, die bisher stillschweigend
  // als Erfolg durchgingen.
  const refFor = (p) => ({
    set: (v) => {
      if (firebase === "fail") return Promise.reject(new Error("Netz weg"));
      written[p] = JSON.parse(JSON.stringify(v));
      return Promise.resolve();
    },
    remove: () => { delete written[p]; return Promise.resolve(); },
  });
  const sandbox = {
    window: win,
    document: {
      readyState: "complete",
      getElementById: (id) => win.__fields && win.__fields[id] ? win.__fields[id] : null,
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
    firebase: firebase === "none" ? {} : { app: () => ({ database: () => ({ ref: refFor }) }) },
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

/* Das Projekt Lehner mit Kundenlink und beantwortetem Fragebogen. */
function lehner(options = {}) {
  const ctx = makeSandbox(options);
  ctx.data.entities.projects.prj_lehner = {
    id: "prj_lehner", title: "Lehner", projectType: "flowertech", pipelineStage: "lead",
    client: { company: "Lehner GmbH" }, budget: 30000, dueDate: "2026-11-01",
    createdAt: "2026-07-01T10:00:00.000Z",
  };
  ctx.win._ftCreateProjectIntakeLink("prj_lehner");
  const intake = Object.values(ctx.data.flowertech.intakes)[0];
  ctx.win._ftIngestSubmissions({
    sub_1: {
      id: "sub_1", kind: "intake", token: intake.inviteToken, createdAt: "2026-08-08T09:00:00.000Z",
      payload: {
        intakeTitle: intake.title,
        answers: vollstaendig(ctx.win, intake.id, {
          projekt: "Lehner", need: "Mehr Reservationen über die Seite",
          "vision-idee": "Gäste reservieren direkt online",
        }),
      },
    },
  });
  return Object.assign(ctx, { project: ctx.data.entities.projects.prj_lehner, intake });
}

const publiziert = (written, token) => written["flowertech/intakeForms/" + token];
const letzterToast = (win) => win.__toasts[win.__toasts.length - 1] || {};

// ── 4. Der Live-Befund: die Freigabe landet wirklich im Datensatz ─────────
{
  const { win, written, intake } = lehner();
  const token = intake.inviteToken;
  win._ftSetProjectField("prj_lehner", "previewUrl", LEHNER_URL);
  ok(win._ftReleaseCustomerPreview("prj_lehner", true) === true,
    "die Vorschau liess sich nicht freigeben");

  const snapshot = publiziert(written, token);
  ok(snapshot, "es wurde überhaupt nichts veröffentlicht");
  ok(snapshot.tiles.preview, "die freigegebene Vorschau fehlt im veröffentlichten Datensatz");
  ok(snapshot.tiles.preview.url === LEHNER_URL,
    `die veröffentlichte Adresse stimmt nicht: ${snapshot.tiles.preview.url}`);
  ok(snapshot.tiles.preview.feedback === true,
    "ohne dieses Feld gibt es auf der Seite keinen Änderungswunsch");
  ok(snapshot.stage === "preview", `die Stufe stimmt nicht: ${snapshot.stage}`);

  // Der Lehner-Link ist eine MANUELLE Testvorschau — kein Claude-Ergebnis.
  ok(snapshot.tiles.preview.source === CORE.PREVIEW_SOURCE_MANUAL,
    `die Herkunft ist falsch veröffentlicht: ${snapshot.tiles.preview.source}`);
  ok(snapshot.tiles.preview.provisional === true,
    "die manuelle Testvorschau geht als fertige Fassung hinaus");

  // Und Quantus darf jetzt „sichtbar" sagen — weil es geschrieben wurde. Die
  // Bestätigung ist echt asynchron: Sie kommt, wenn das Schreiben durch ist.
  await new Promise((r) => setTimeout(r, 0));
  const area = win._ftCustomerArea("prj_lehner");
  ok(area.publication.ok, `die Veröffentlichung gilt nicht als bestätigt: ${area.publication.reason}`);
  ok(area.stages.find((s) => s.key === "preview").live === true,
    "die Vorschau gilt nicht als wirklich sichtbar");
  ok(area.liveLabels.some((l) => /Website-Vorschau/.test(l)),
    "die Vorschau fehlt in der Liste dessen, was die Kundschaft wirklich sieht");
  ok(letzterToast(win).type === "ok", "der Erfolg wurde nicht gemeldet");
}

// ── 5. Scheitert das Schreiben, wird NICHT „sichtbar" behauptet ───────────
{
  // (a) Gar kein Firebase-Zugang — der stille Fall aus dem Befund.
  const ohne = lehner({ firebase: "none" });
  ohne.win._ftSetProjectField("prj_lehner", "previewUrl", LEHNER_URL);
  ohne.win._ftReleaseCustomerPreview("prj_lehner", true);

  ok(!publiziert(ohne.written, ohne.intake.inviteToken),
    "ohne Zugang wurde trotzdem etwas veröffentlicht");
  const areaO = ohne.win._ftCustomerArea("prj_lehner");
  ok(areaO.preview.visible, "die Freigabe selbst ist verlorengegangen");
  ok(!areaO.publication.ok, "ohne Veröffentlichung gilt der Stand als bestätigt");
  ok(areaO.stages.find((s) => s.key === "preview").live === false,
    "Quantus meldet die Vorschau als sichtbar, obwohl nichts geschrieben wurde");
  ok(areaO.liveLabels.length === 0, "es wird behauptet, die Kundschaft sehe etwas");
  ok(letzterToast(ohne.win).type === "err",
    `der Fehlschlag wurde als „${letzterToast(ohne.win).type}“ gemeldet`);
  ok(/Nicht veröffentlicht/.test(letzterToast(ohne.win).message),
    `der Fehlschlag wird nicht benannt: ${letzterToast(ohne.win).message}`);
  ok(/Freigabe steht/.test(letzterToast(ohne.win).message),
    "es wird nicht gesagt, dass die Freigabe steht, die Adresse sie aber nicht zeigt");

  // (b) Der Zugang ist da, das Schreiben scheitert.
  const kaputt = lehner({ firebase: "fail" });
  kaputt.win._ftSetProjectField("prj_lehner", "previewUrl", LEHNER_URL);
  kaputt.win._ftReleaseCustomerPreview("prj_lehner", true);
  await new Promise((r) => setTimeout(r, 0));

  ok(!publiziert(kaputt.written, kaputt.intake.inviteToken),
    "trotz Fehlschlag steht ein Datensatz da");
  const areaK = kaputt.win._ftCustomerArea("prj_lehner");
  ok(!areaK.publication.ok && /Netz weg/.test(areaK.publication.reason),
    `der Fehler wird nicht durchgereicht: ${areaK.publication.reason}`);
  ok(areaK.stages.find((s) => s.key === "preview").live === false,
    "nach einem Fehlschlag gilt die Vorschau als sichtbar");
  ok(kaputt.win.__toasts.some((t) => t.type === "err" && /fehlgeschlagen/.test(t.message)),
    "der fehlgeschlagene Schreibversuch wurde nie gemeldet");

  // Und der Rückgabewert sagt es auch — er wird nicht mehr verschluckt.
  const ergebnis = ohne.win._ftRefreshCustomerArea("prj_lehner");
  ok(ergebnis && ergebnis.ok === false && !!ergebnis.error,
    "refreshCustomerArea meldet weiterhin Erfolg bei Fehlschlag");
  const ohneLink = ohne.win._ftRefreshCustomerArea("gibt_es_nicht");
  ok(ohneLink && ohneLink.ok === false, "ein Projekt ohne Kundenlink meldet Erfolg");
}

// ── 6. Der ganze Claude-Weg bis zur erledigten Claude-Vorschau ────────────
{
  const { win, written, data, intake } = lehner();
  const token = intake.inviteToken;
  const project = data.entities.projects.prj_lehner;
  const stand = () => win._ftCustomerArea("prj_lehner").claude;

  ok(stand().status === "open", "der frische Vorgang wartet schon auf Claude Code");

  // Übergeben — ab hier wird gewartet.
  ok(win._ftClaudeHandoffRequest("prj_lehner") === true, "die Übergabe war nicht möglich");
  ok(stand().status === "waiting" && stand().statusLabel === "Warte auf Claude Code",
    `nach der Übergabe steht der Status auf „${stand().status}“`);

  // Eine ausgedachte Adresse ist keine Rückgabe.
  ok(win._ftClaudeHandoffReturn("prj_lehner", "beispiel-lehner.netlify.app") === false,
    "eine Adresse ohne HTTPS wurde als Rückgabe angenommen");
  ok(win._ftClaudeHandoffReturn("prj_lehner", "http://beispiel-lehner.netlify.app/") === false,
    "eine http-Adresse wurde als Rückgabe angenommen");
  ok(stand().status === "waiting", "eine abgelehnte Rückgabe hat den Status verschoben");

  // Die echte Rückgabe — eingetragen, aber noch nicht bestätigt.
  ok(win._ftClaudeHandoffReturn("prj_lehner", LEHNER_URL) === true, "die Rückgabe wurde abgelehnt");
  ok(stand().status === "review" && stand().statusLabel === "Rückgabe-Link prüfen",
    `die Rückgabe steht auf „${stand().status}“ statt zur Prüfung`);
  ok(!project.previewUrl,
    "die bloss eingetragene Rückgabe wurde schon als Vorschau-Adresse übernommen");

  // Bestätigen — und genau diese Adresse wird zur Vorschau.
  ok(win._ftClaudeHandoffConfirm("prj_lehner") === true, "die Bestätigung schlug fehl");
  ok(stand().status === "confirmed" && stand().statusLabel === "freigegeben",
    `nach der Bestätigung steht der Status auf „${stand().status}“`);
  ok(project.previewUrl === LEHNER_URL,
    `die bestätigte Adresse wurde nicht übernommen: ${project.previewUrl}`);
  ok(stand().returnedAt && stand().confirmedAt, "Stand und Bestätigung fehlen");

  // Jetzt ist die Freigabe eine erledigte Claude-Vorschau.
  ok(win._ftReleaseCustomerPreview("prj_lehner", true) === true, "die Freigabe war nicht möglich");
  const kachel = publiziert(written, token).tiles.preview;
  ok(kachel.source === CORE.CLAUDE_HANDOFF_SOURCE,
    `die Herkunft der Vorschau stimmt nicht: ${kachel.source}`);
  ok(kachel.provisional === false, "die bestätigte Vorschau geht als Zwischenstand hinaus");
  ok(project.ftCustomerPreview.mode === CORE.CLAUDE_HANDOFF_SOURCE,
    "die Freigabe hält die Herkunft nicht fest");
  ok(project.ftContactLog.some((e) => /Claude-Code-Rückgabe bestätigt/.test(e.text)),
    "die Bestätigung steht nicht im Verlauf");

  // Wird die Adresse danach von Hand ausgetauscht, ist sie wieder manuell.
  win._ftSetProjectField("prj_lehner", "previewUrl", "https://etwas-anderes.example.ch/");
  win._ftReleaseCustomerPreview("prj_lehner", false);
  win._ftReleaseCustomerPreview("prj_lehner", true);
  const getauscht = publiziert(written, token).tiles.preview;
  ok(getauscht.source === CORE.PREVIEW_SOURCE_MANUAL && getauscht.provisional === true,
    "eine ausgetauschte Adresse geht als Claude-Ergebnis hinaus");
  ok(project.ftCustomerPreview.mode === "manuell", "die manuelle Freigabe wird nicht so vermerkt");
  ok(project.ftContactLog.some((e) => /MANUELLE Testvorschau/.test(e.text)),
    "die manuelle Freigabe steht nicht als solche im Verlauf");

  // Ein neuer Auftrag hebt die alte Bestätigung auf.
  win._ftClaudeHandoffRequest("prj_lehner");
  ok(stand().status === "waiting" && !stand().returnedUrl,
    "ein neuer Auftrag erbt die alte Rückgabe");
}

// ── 7. Vertrag, AGB und TEST-Übersicht im selben Datensatz ────────────────
{
  const { win, written, data, intake } = lehner();
  const token = intake.inviteToken;
  const project = data.entities.projects.prj_lehner;

  // Die AGB hängen an keiner Freigabe — sie sind von Anfang an dabei.
  const start = publiziert(written, token);
  ok(start.tiles.terms && start.tiles.terms.sections.length > 0,
    "die zentrale Standard-AGB fehlt im veröffentlichten Datensatz");
  ok(start.tiles.terms.version === CORE.STANDARD_TERMS_VERSION,
    "die AGB tragen nicht die zentrale Fassung");

  // Die TEST-Übersicht: erst mit Freigabe, nie mit Betrag.
  win._ftSetTestServiceTile("prj_lehner", "title", "Website-Neukonzept Lehner");
  win._ftSetTestServiceTile("prj_lehner", "previewUrl", LEHNER_URL);
  ok(!publiziert(written, token).tiles.testService,
    "die TEST-Übersicht erscheint ohne Freigabe");
  ok(win._ftReleaseTestService("prj_lehner", true) === true, "die TEST-Übersicht liess sich nicht freigeben");
  const test = publiziert(written, token).tiles.testService;
  ok(test && test.title === "Website-Neukonzept Lehner", "die TEST-Übersicht fehlt");
  CORE.TEST_SERVICE_FORBIDDEN_KEYS.forEach((key) => {
    ok(!(key in test), `die TEST-Übersicht trägt „${key}“`);
  });

  // Der Vertrag: er wurde dem Kern bisher nie übergeben — das ist der Kern
  // dieses Befunds. Entwurf bleibt innen, freigegeben geht er hinaus.
  win._ftBuildContract("prj_lehner", true);
  const vertrag = data.flowertech.contracts.prj_lehner;
  ok(vertrag, "es entstand kein Vertragsentwurf");
  vertrag.title = "Projektauftrag Lehner";
  ok(win._ftReleaseCustomerContract("prj_lehner", true) === false,
    "ein Vertragsentwurf liess sich freigeben");
  ok(!publiziert(written, token).tiles.contract, "der Entwurf steht im Kundenbereich");

  win._ftDocStatusSet("prj_lehner", "contract", "released");
  ok(win._ftReleaseCustomerContract("prj_lehner", true) === true,
    "der freigegebene Vertrag liess sich nicht auf den Kundenlink stellen");
  const contract = publiziert(written, token).tiles.contract;
  ok(contract, "der freigegebene Vertrag fehlt auf dem Kundenlink");
  ok(/Projektauftrag Lehner/.test(contract.title + " " + contract.document.html),
    "der Vertrag trägt seinen Titel nicht");
  ok(/<h2>/.test(contract.document.html), "der Vertrag hat keine Abschnitte");
  ok(!/<script/i.test(contract.document.html), "der Vertrag geht mit Skript hinaus");
  ok(project.ftCustomerContract.released === true, "die Vertragsfreigabe wurde nicht festgehalten");

  // Widerruf wirkt sofort.
  win._ftReleaseCustomerContract("prj_lehner", false);
  ok(!publiziert(written, token).tiles.contract, "der Widerruf des Vertrags wirkt nicht");
}

// ── 8. Der Datensatz trägt genau das, was die öffentliche Seite liest ─────
{
  const { win, written, intake } = lehner();
  const token = intake.inviteToken;
  win._ftSetProjectField("prj_lehner", "previewUrl", LEHNER_URL);
  win._ftReleaseCustomerPreview("prj_lehner", true);
  const snapshot = publiziert(written, token);

  // Die Felder, die `fragebogen.html` wirklich anfasst.
  ["schema", "title", "intro", "questions", "status", "company", "stage", "tiles", "updatedAt"]
    .forEach((key) => ok(key in snapshot, `dem Datensatz fehlt „${key}“`));
  ["testService", "offer", "preview", "contract", "admin", "terms"]
    .forEach((key) => ok(key in snapshot.tiles, `den Kacheln fehlt „${key}“`));

  // Und weiterhin nichts Internes — die Positivliste bleibt eine.
  const roh = JSON.stringify(snapshot);
  ok(!roh.includes("prj_lehner"), "die Projekt-ID steht im veröffentlichten Datensatz");
  ok(!roh.includes("rita@lehner.ch"), "die Mailadresse der Kundschaft steht im Datensatz");
  ok(!/portalToken|ftContactLog|ftClaudeHandoff|kunde\.html/.test(roh),
    "interne Felder stehen im veröffentlichten Datensatz");
  // Die Rückgabe-Adresse selbst darf hinaus — sie IST die Vorschau. Der Weg
  // dorthin (Auftrag, Prüfung, Bestätigung) bleibt drinnen.
  ok(!/requestedAt|confirmedAt/.test(roh), "der interne Ablauf der Rückgabe steht im Datensatz");
}

// ── 9. Die Oberfläche zeigt den Schritt — und behauptet nichts Falsches ───
{
  const tab = (win, projectId, key) => {
    win._ftSetProjectTab(projectId, key);
    return String(win.ftWorkflowPanel(projectId)).replace(/<style>[\s\S]*?<\/style>/g, "");
  };

  // (a) Ohne Zugang: freigegeben, aber nicht veröffentlicht — und es steht da.
  const ohne = lehner({ firebase: "none" });
  ohne.win._ftSetProjectField("prj_lehner", "previewUrl", LEHNER_URL);
  ohne.win._ftReleaseCustomerPreview("prj_lehner", true);
  const promptOhne = tab(ohne.win, "prj_lehner", "prompt");
  ok(!/<strong>sichtbar<\/strong>/.test(promptOhne),
    "die Oberfläche meldet „sichtbar“, obwohl nichts veröffentlicht wurde");
  ok(/freigegeben, nicht veröffentlicht/.test(promptOhne),
    "der Unterschied zwischen Freigabe und Veröffentlichung steht nicht da");
  ok(/alten Stand/.test(promptOhne), "es wird nicht gesagt, was die Kundschaft stattdessen sieht");

  // (b) Mit Zugang: jetzt darf „sichtbar“ dastehen.
  const ctx = lehner();
  ctx.win._ftSetProjectField("prj_lehner", "previewUrl", LEHNER_URL);
  ctx.win._ftReleaseCustomerPreview("prj_lehner", true);
  await new Promise((r) => setTimeout(r, 0));
  const promptDa = tab(ctx.win, "prj_lehner", "prompt");
  ok(/<strong>sichtbar<\/strong>/.test(promptDa),
    "nach bestätigter Veröffentlichung fehlt die Meldung „sichtbar“");
  // Und die Herkunft steht dabei — als Test/Manuell, nicht als Claude-Ergebnis.
  ok(/Test-\/Manuell-Vorschau/.test(promptDa),
    "die manuelle Herkunft der Vorschau wird nicht benannt");
  ok(!/Quelle: Claude Code/.test(promptDa),
    "eine manuelle Adresse wird als Claude-Code-Ergebnis ausgegeben");

  // (c) Der Schritt selbst — in „Vorschau & Prompt“ UND im „Kundenportal“.
  const vorschau = tab(ctx.win, "prj_lehner", "vorschau");
  ok(/Claude-Code-Rückgabe/.test(vorschau),
    "der Schritt fehlt im Reiter „Vorschau & Prompt“");
  ok(/_ftClaudeHandoffRequest|_ftClaudeHandoffConfirm|ftClaudeReturnUrl/.test(vorschau),
    "der Schritt in „Vorschau & Prompt“ lässt sich nicht bedienen");
  const portal = tab(ctx.win, "prj_lehner", "kunde");
  ok(/Claude-Code-Rückgabe/.test(portal), "der Schritt fehlt in der Oberfläche");
  ["Warte auf Claude Code", "Rückgabe-Link prüfen", "freigegeben"].forEach((label) => {
    ok(portal.includes(label), `die Station „${label}“ fehlt in der Oberfläche`);
  });
  ok(/_ftClaudeHandoffRequest/.test(portal), "der Weg zur Übergabe fehlt");
  ok(/Vertrag/.test(portal), "der Vertrag hat keinen erreichbaren Schalter");

  // (d) Nach der Bestätigung: die Oberfläche nennt Claude Code als Quelle.
  ctx.win._ftClaudeHandoffRequest("prj_lehner");
  ctx.win._ftClaudeHandoffReturn("prj_lehner", LEHNER_URL);
  const zurPruefung = tab(ctx.win, "prj_lehner", "kunde");
  ok(/ftClaudeReturnUrl/.test(zurPruefung), "das Feld für die Rückgabe-Adresse fehlt");
  ok(/_ftClaudeHandoffConfirm/.test(zurPruefung), "der Weg zur Bestätigung fehlt");

  ctx.win._ftClaudeHandoffConfirm("prj_lehner");
  ctx.win._ftReleaseCustomerPreview("prj_lehner", true);
  await new Promise((r) => setTimeout(r, 0));
  ok(/Quelle: Claude Code/.test(tab(ctx.win, "prj_lehner", "prompt")),
    "die bestätigte Rückgabe wird nicht als Claude-Code-Quelle ausgewiesen");

  // (e) Und das Feld-Ablesen funktioniert wirklich.
  const feld = lehner();
  feld.win.__fields = { ftClaudeReturnUrl: { value: LEHNER_URL } };
  feld.win._ftClaudeHandoffRequest("prj_lehner");
  ok(feld.win._ftClaudeHandoffReturnFromField("prj_lehner") === true,
    "die Rückgabe liess sich nicht aus dem Feld übernehmen");
  ok(feld.win._ftCustomerArea("prj_lehner").claude.status === "review",
    "die aus dem Feld übernommene Rückgabe steht nicht zur Prüfung");
}

console.log(`Claude-Code-Rückgabe & Veröffentlichungsnachweis: ${checks} Prüfungen.`);
console.log("  Freigabe und Veröffentlichung sind zwei Dinge; „sichtbar\" verlangt den Nachweis.");
console.log("  Warte auf Claude Code → Rückgabe-Link prüfen → freigegeben; manuelle Adressen");
console.log("  bleiben Test-/Manuell-Vorschau und werden nie als Claude-Ergebnis ausgegeben.");
