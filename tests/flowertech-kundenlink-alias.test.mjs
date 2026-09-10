/*
 * Zwei Kundenlinks an EINEM Projekt — welcher zaehlt?
 * ---------------------------------------------------------------------------
 * Befund (10.09.2026, Projekt e543fc2e-064a-4b93-a75e-2f543ef3263d):
 * Die Projektkarte zeigte
 *     https://flowertech.ch/fragebogen.html?e=YsJLRllvKkIT3f03O4WzrS49
 * die tatsaechlich am 02.09. versendete Mail dagegen
 *     https://flowertech.ch/fragebogen.html?e=pf-kXRwq0T1lOUcH7fsknz_b
 *
 * Erstens: Beide sind gewoehnliche Einladungstoken desselben Generators —
 * 24 Zeichen aus [A-Za-z0-9-_]. Ein fuehrendes "pf-" ist Zufall der
 * Zufallsauswahl, kein Praefix und keine zweite Tokenart. Das prueft dieser
 * Test am echten Generator-Alphabet, damit niemand weiter danach sucht.
 *
 * Zweitens — die eigentliche Frage: Aktualisieren beide Tokens dasselbe
 * Projekt? Das entscheidet NICHT der Status „Link verschickt" und auch nicht
 * „Wartet auf Antwort" (beides steht am Fragebogen und weiss nichts von einer
 * Mail), sondern allein die Bindung des Fragebogens:
 *
 *   · gebunden (boundProjectId) → die Antwort aktualisiert genau dieses Projekt
 *   · nicht gebunden, hat aber sein Projekt schon erzeugt (projectId)
 *                              → die Antwort wird VERWORFEN
 *   · weder noch               → die Antwort erzeugt ein NEUES Projekt
 *
 * Diese Regeln stehen in applyIntakeSubmission; intakeAliasReport() rechnet
 * sie fuer jeden Link des Projekts aus, und die Projektkarte zeigt das
 * Ergebnis. Dazu: Eine nicht uebernommene Antwort verschwindet nicht mehr
 * spurlos, und die Vorbelegung wird fuer JEDEN Link des Projekts nachgezogen —
 * nicht nur fuer den, den die Karte gerade anzeigt.
 *
 * Es wird nichts verschickt, nichts freigegeben und nichts ueberschrieben.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = (await import(path.join(root, "public/flowertech-workflow-core.js"))).default;
const quelle = fs.readFileSync(path.join(root, "public/flowertech.js"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const PROJEKT = "e543fc2e-064a-4b93-a75e-2f543ef3263d";
const TOKEN_KARTE = "YsJLRllvKkIT3f03O4WzrS49";
const TOKEN_MAIL = "pf-kXRwq0T1lOUcH7fsknz_b";
const NOW = "2026-09-10T21:00:00.000Z";

/* ══ 1. „pf-" ist kein Praefix ═════════════════════════════════════════════ */
{
  const alphabet = /var chars = "([^"]+)";/.exec(quelle);
  ok(alphabet, "der Token-Generator (makeToken) wurde nicht gefunden");
  const zeichen = alphabet[1];
  eq(zeichen, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
    "das Alphabet des Token-Generators hat sich geaendert");
  ok(/var bytes = new Uint8Array\(24\);/.test(quelle), "die Tokenlaenge ist nicht mehr 24");
  [TOKEN_KARTE, TOKEN_MAIL].forEach((t) => {
    eq(t.length, 24, `der Token ${t} hat nicht die Laenge des Generators`);
    ok(t.split("").every((c) => zeichen.includes(c)),
      `der Token ${t} enthaelt Zeichen, die der Generator nie erzeugt`);
  });
  ok(!/"pf-"|'pf-'/.test(quelle), "es gibt doch einen Sonderfall „pf-“ im Code");
}

/* ══ 2. Was eine Antwort auf jeden Token bewirkt ═══════════════════════════ */
const gibtProjekt = (id) => id === PROJEKT;
{
  const gebunden = { id: "in_a", inviteToken: TOKEN_MAIL, boundProjectId: PROJEKT, createdAt: "2026-09-02T06:00:00.000Z" };
  const erzeugte = { id: "in_b", inviteToken: TOKEN_KARTE, projectId: PROJEKT, createdAt: "2026-08-20T06:00:00.000Z" };
  const frisch = { id: "in_c", inviteToken: "cccccccccccccccccccccccc", createdAt: "2026-09-05T06:00:00.000Z" };

  eq(CORE.intakeAnswerRoute({ intake: gebunden, projectId: PROJEKT, projectExists: gibtProjekt }).route, "updates",
    "eine Antwort auf den gebundenen Bogen aktualisiert das Projekt nicht");
  eq(CORE.intakeAnswerRoute({ intake: erzeugte, projectId: PROJEKT, projectExists: gibtProjekt }).route, "dropped",
    "eine Antwort auf den Bogen, der das Projekt erzeugt hat, gilt faelschlich als wirksam");
  eq(CORE.intakeAnswerRoute({ intake: frisch, projectId: PROJEKT, projectExists: gibtProjekt }).route, "creates",
    "ein ungebundener Bogen ohne Projekt erzeugt kein neues Projekt mehr");

  const bericht = CORE.intakeAliasReport({
    intakes: { in_a: gebunden, in_b: erzeugte }, projectId: PROJEKT, projectExists: gibtProjekt, now: NOW,
  });
  eq(bericht.count, 2, "der Bericht findet nicht beide Kundenlinks");
  ok(bericht.ambiguous, "zwei Kundenlinks gelten nicht als mehrdeutig");
  ok(bericht.hasBlindLink, "der Link, der eine Antwort verwirft, faellt nicht auf");
  eq(bericht.effectiveToken, TOKEN_MAIL,
    `der wirksame Token stimmt nicht: ${bericht.effectiveToken}`);
  // Feste Reihenfolge (aelteste zuerst) — nicht die Schluesselreihenfolge.
  eq(bericht.links.map((l) => l.token), [TOKEN_KARTE, TOKEN_MAIL],
    "die Reihenfolge der Links haengt weiterhin an der Schluesselreihenfolge");
  eq(bericht.links.map((l) => l.route), ["dropped", "updates"], "die Zuordnung je Link stimmt nicht");

  // Ein einzelner Link ist kein Fall fuer die Warnung.
  const einer = CORE.intakeAliasReport({ intakes: { in_a: gebunden }, projectId: PROJEKT, projectExists: gibtProjekt });
  ok(!einer.ambiguous && !einer.hasBlindLink, "ein einzelner, gebundener Link gilt als Problem");

  // Zwei gebundene: beide wirksam, keiner ist DER eine.
  const zwei = CORE.intakeAliasReport({
    intakes: { in_a: gebunden, in_d: { id: "in_d", inviteToken: "dddddddddddddddddddddddd", boundProjectId: PROJEKT, createdAt: "2026-09-03T06:00:00.000Z" } },
    projectId: PROJEKT, projectExists: gibtProjekt,
  });
  eq(zwei.effectiveToken, "", "bei zwei wirksamen Links wird trotzdem einer als DER eine ausgegeben");
  ok(zwei.ambiguous, "zwei gebundene Links gelten nicht als mehrdeutig");
}

/* ══ 3. Laufzeit: Karte, Vermerk und Vorbelegung ═══════════════════════════ */
let seed = 0;
function makeSandbox(draussen = {}) {
  const data = { entities: { projects: {}, tasks: {}, notes: {} }, flowertech: {}, meta: {} };
  const written = {};
  const win = {
    APP: { state: { data } },
    FlowerTechWorkflow: CORE,
    location: { hash: "#/flowertech", origin: "https://example.test", pathname: "/index.html" },
    addEventListener() {}, removeEventListener() {},
    scheduleSave() {}, render() {},
    toast(type, title, message) { win.__toasts.push({ type, title, message }); },
    __written: written, __toasts: [],
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
    todayYmd: () => "2026-09-10",
    crypto: { getRandomValues: (a) => { seed++; a.forEach((_, i) => { a[i] = (i * 37 + seed * 13) % 256; }); } },
    setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
    prompt: () => "",
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      readyState: "complete", getElementById: () => null, querySelector: () => null, addEventListener() {},
      createElement: () => ({ style: {}, remove() {}, click() {}, setAttribute() {}, focus() {}, select() {} }),
      body: { appendChild() {}, removeChild() {}, classList: { toggle() {}, remove() {} } },
      execCommand: () => true,
    },
    location: win.location, setTimeout: win.setTimeout, clearTimeout: () => {},
    console: { warn() {}, log() {}, error() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    confirm: () => true, APP: win.APP,
    firebase: { app: () => ({ database: () => ({ ref: (p) => ({
      set: (v) => { written[p] = v; (written.__order = written.__order || []).push(p); return Promise.resolve(); },
      remove: () => { delete written[p]; return Promise.resolve(); },
      // Lesen: der „draussen" veroeffentlichte Stand, den der Test vorgibt.
      once: () => Promise.resolve({ val: () => (draussen[p] === undefined ? null : draussen[p]) }),
      on: () => {}, off: () => {},
    }) }) }) },
  };
  sandbox.globalThis = sandbox;
  win.document = sandbox.document; win.firebase = sandbox.firebase;
  win.navigator = sandbox.navigator; win.confirm = sandbox.confirm;
  vm.runInContext(quelle, vm.createContext(sandbox));
  win.viewFlowerTech();
  return { win, data, written, draussen };
}

{
  const { win, data, written } = makeSandbox();
  data.entities.projects[PROJEKT] = {
    id: PROJEKT, title: "Aljia", projectType: "flowertech", pipelineStage: "intake",
    client: { name: "Jule Dal", company: "Aljia", email: "juledal19@gmail.com" },
    createdAt: "2026-08-20T06:00:00.000Z",
  };
  const ft = data.flowertech;
  ft.intakes = {
    in_alt: {
      id: "in_alt", title: "Ihre Angaben", inviteToken: TOKEN_KARTE, projectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "answered", answeredAt: "2026-08-25T10:00:00.000Z",
      createdAt: "2026-08-20T06:00:00.000Z",
    },
    in_mail: {
      id: "in_mail", title: "Ihre Angaben", inviteToken: TOKEN_MAIL, boundProjectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open",
      createdAt: "2026-09-02T06:00:00.000Z",
    },
  };

  // 3a) Die Auskunft gibt es zur Laufzeit — mit den echten Projektdaten.
  const bericht = win._ftIntakeAliasReport(PROJEKT);
  eq(bericht.count, 2, "die Laufzeit findet nicht beide Kundenlinks");
  eq(bericht.effectiveToken, TOKEN_MAIL, "die Laufzeit nennt den falschen wirksamen Token");

  // 3b) Die Projektkarte verschweigt den zweiten Link nicht mehr.
  const karte = String(win._ftProjectIntakeRow(PROJEKT));
  ok(karte.includes(TOKEN_MAIL) && karte.includes(TOKEN_KARTE),
    "die Projektkarte nennt nicht beide Tokens");
  ok(/2 Fragebogen-Links an diesem Projekt/.test(karte), "die Karte warnt nicht vor der Mehrdeutigkeit");
  ok(/verworfen/.test(karte), "die Karte sagt nicht, dass ein Link Antworten verwirft");

  // 3c) Die Vorbelegung wird fuer JEDEN offenen Link nachgezogen — auch fuer
  //     den, den die Karte nicht als ersten zeigt.
  const vorher = Object.keys(written).length;
  win._ftRefreshIntakePrefills(PROJEKT);
  ok(written["flowertech/intakeForms/" + TOKEN_MAIL],
    "der tatsaechlich versendete Link bekommt die Vorbelegung nicht");
  const vorbelegt = (written["flowertech/intakeForms/" + TOKEN_MAIL].prefill || {}).values || {};
  eq(vorbelegt.email, "juledal19@gmail.com",
    `die hinterlegte E-Mail fehlt in der Vorbelegung des versendeten Links: ${JSON.stringify(vorbelegt)}`);
  ok(!written["flowertech/intakeForms/" + TOKEN_KARTE],
    "ein beantworteter Bogen wird unnoetig neu veroeffentlicht");
  ok(Object.keys(written).length > vorher, "es wurde gar nichts veroeffentlicht");

  // 3d) Eine Antwort auf den Bogen, der sein Projekt schon erzeugt hat, wird
  //     nicht uebernommen — aber sie verschwindet auch nicht mehr spurlos.
  const vorherProjekte = Object.keys(data.entities.projects).length;
  win._ftIngestSubmissions({
    sub_spaet: {
      id: "sub_spaet", kind: "intake", token: TOKEN_KARTE, createdAt: "2026-09-10T20:00:00.000Z",
      payload: { answers: [{ key: "email", answer: "jemand@example.test" }] },
    },
  });
  eq(Object.keys(data.entities.projects).length, vorherProjekte,
    "aus der verworfenen Antwort entsteht ein zweites Projekt");
  const vermerk = (ft.intakes.in_alt.unhandledAnswers || [])[0];
  ok(vermerk && vermerk.token === TOKEN_KARTE,
    "die nicht uebernommene Antwort wird nicht am Fragebogen vermerkt");
  ok(/erzeugt/.test(vermerk.reason || ""), `der Vermerk nennt den Grund nicht: ${vermerk && vermerk.reason}`);
  ok(win.__toasts.some((t) => t.type === "warn" && /nicht uebernommen/.test(t.message || "")),
    "es wird nicht gemeldet, dass eine Antwort liegen blieb");
  // Und die Kundendaten des Projekts bleiben, wie sie waren.
  eq(data.entities.projects[PROJEKT].client.email, "juledal19@gmail.com",
    "die verworfene Antwort hat Kundendaten ueberschrieben");
}

/* ══ 4. Auskunft zu GENAU EINEM Token ══════════════════════════════════════
   Die Frage aus der Abnahme lautet nicht „welche Links hat das Projekt",
   sondern „was passiert, wenn auf den tatsaechlich versendeten Link
   geantwortet wird". Genau darauf antwortet _ftIntakeByToken — lesend. */
{
  const { win, data } = makeSandbox();
  data.entities.projects[PROJEKT] = {
    id: PROJEKT, title: "Aljia", projectType: "flowertech", client: {},
    createdAt: "2026-08-20T06:00:00.000Z",
  };
  data.flowertech.intakes = {
    in_mail: {
      id: "in_mail", title: "Ihre Angaben", inviteToken: TOKEN_MAIL, boundProjectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open", createdAt: "2026-09-02T06:00:00.000Z",
    },
    in_frei: {
      id: "in_frei", title: "Ohne Projekt", inviteToken: "ffffffffffffffffffffffff",
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open", createdAt: "2026-09-04T06:00:00.000Z",
    },
  };

  const gemailt = win._ftIntakeByToken(TOKEN_MAIL);
  eq(gemailt.known, true, "der versendete Token wird nicht gefunden");
  eq(gemailt.route, "updates", "eine Antwort auf den versendeten Token gilt nicht dem Projekt");
  eq(gemailt.projectId, PROJEKT, "der versendete Token zeigt auf ein anderes Projekt");
  eq(gemailt.projectTitle, "Aljia", "der Projektname fehlt in der Auskunft");

  const frei = win._ftIntakeByToken("ffffffffffffffffffffffff");
  eq(frei.route, "creates", "ein ungebundener Bogen erzeugt laut Auskunft kein neues Projekt");

  const fremd = win._ftIntakeByToken("zzzzzzzzzzzzzzzzzzzzzzzz");
  eq(fremd.known, false, "ein unbekannter Token gilt als bekannt");
  ok(/bleibt liegen/.test(fremd.routeLabel), "die Auskunft sagt nicht, was mit einer Antwort passiert");

  // Der Statuswert allein beweist nichts — er steht am Bogen, nicht an der Mail.
  eq(gemailt.status, "open", "der Status des versendeten Bogens stimmt nicht");
  eq(gemailt.answeredAt, "", "der Bogen gilt faelschlich als beantwortet");
}

/* ══ 5. Die Auskunft ist BEDIENBAR — ohne Konsole ══════════════════════════
   Abnahme-Vorgabe (10.09.2026): Interne window-Funktionen und versteckte
   Anwendungsdaten duerfen nicht ueber die Konsole ausgelesen werden. Die
   Auskunft muss in der Oberflaeche stehen und ueber Knoepfe bedienbar sein. */
{
  const { win, data } = makeSandbox();
  data.entities.projects[PROJEKT] = {
    id: PROJEKT, title: "Aljia", projectType: "flowertech", client: {},
    createdAt: "2026-08-20T06:00:00.000Z",
  };
  data.flowertech.intakes = {
    in_alt: {
      id: "in_alt", title: "Ihre Angaben", inviteToken: TOKEN_KARTE, projectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "answered",
      answeredAt: "2026-08-25T10:00:00.000Z", createdAt: "2026-08-20T06:00:00.000Z",
      unhandledAnswers: [{ at: "2026-09-10T20:00:00.000Z", reason: "dieser Bogen hat sein Projekt bereits erzeugt", token: TOKEN_KARTE }],
    },
    in_mail: {
      id: "in_mail", title: "Ihre Angaben", inviteToken: TOKEN_MAIL, boundProjectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open", createdAt: "2026-09-02T06:00:00.000Z",
    },
  };

  // 5a) Der Block am Projekt zeigt Status, Bindung, Wirkung und Antworten.
  const karte = String(win._ftProjectIntakeRow(PROJEKT));
  ok(karte.includes(TOKEN_KARTE) && karte.includes(TOKEN_MAIL), "die Karte zeigt nicht beide Tokens");
  ok(/aktualisiert dieses Projekt/.test(karte), "die Wirkung einer Antwort fehlt");
  ok(/wird verworfen/.test(karte), "der Link, der Antworten verwirft, ist nicht als solcher zu sehen");
  ok(/an dieses Projekt gebunden/.test(karte) && /hat dieses Projekt erzeugt/.test(karte),
    "die Bindung je Link fehlt");
  ok(/Status: answered/.test(karte) && /Status: open/.test(karte), "der Status je Link fehlt");
  ok(/Antwort eingegangen am/.test(karte), "eine vorhandene Antwort wird nicht angezeigt");
  ok(/NICHT übernommen/.test(karte), "eine liegengebliebene Antwort wird nicht angezeigt");
  ok(/keine Antwort eingegangen/.test(karte), "beim offenen Bogen fehlt die Aussage zur Antwort");
  ok(/_ftCopyText/.test(karte), "die Links lassen sich nicht kopieren");

  // 5a2) Und im Problemfall steht sie OBEN — nicht in einem eingeklappten
  //      Bereich, den niemand aufmacht. Genau daran scheiterte die Abnahme.
  const panel = String(win.ftProjectPanel(PROJEKT));
  const details = panel.indexOf('<details class="ft-more"');
  ok(details > 0, "der eingeklappte Detailbereich der Projektseite wurde nicht gefunden");
  // Der Token allein beweist nichts — er steht oben ohnehin als Kundenadresse.
  // Entscheidend ist der Auskunftsblock (ft-alias) mit beiden Tokens.
  ok(panel.indexOf('class="ft-alias') < details,
    "die Warnung zur Zuordnung steht erst im eingeklappten Bereich");
  const oben = panel.slice(0, details);
  ok(oben.includes(TOKEN_MAIL) && oben.includes(TOKEN_KARTE),
    "die Warnung ganz oben nennt nicht beide Tokens");
  ok(/wird verworfen/.test(oben), "oben fehlt die Aussage, dass ein Link Antworten verwirft");

  // 5b) Auch mit nur EINEM Link steht die Auskunft da (nicht nur im Fehlerfall).
  delete data.flowertech.intakes.in_alt;
  ok(/Der Fragebogen-Link dieses Projekts/.test(String(win._ftProjectIntakeRow(PROJEKT))),
    "bei einem einzigen Link verschwindet die Auskunft wieder");
  // Im ruhigen Fall bleibt oben aber Ruhe: keine Warnung ueber dem Detailbereich.
  const ruhig = String(win.ftProjectPanel(PROJEKT));
  ok(ruhig.indexOf('class="ft-alias') > ruhig.indexOf('<details class="ft-more"'),
    "ohne Problem steht die Auskunft trotzdem als Warnung ganz oben");
}

/* ══ 6. Die Token-Suche in „Kundenanfragen" ════════════════════════════════ */
{
  const { win, data } = makeSandbox();
  data.entities.projects[PROJEKT] = {
    id: PROJEKT, title: "Aljia", projectType: "flowertech", client: {}, createdAt: "2026-08-20T06:00:00.000Z",
  };
  data.flowertech.intakes = {
    in_mail: {
      id: "in_mail", title: "Ihre Angaben", inviteToken: TOKEN_MAIL, boundProjectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open", createdAt: "2026-09-02T06:00:00.000Z",
    },
  };
  data.flowertech.activeTab = "intakes";

  // Das Eingabefeld und der Knopf stehen in der Ansicht.
  const ansicht = () => String(win.viewFlowerTech()).replace(/<style>[\s\S]*?<\/style>/g, "");
  const leer = ansicht();
  ok(/id="ftTokenSuche"/.test(leer), "das Eingabefeld für die Token-Auskunft fehlt");
  ok(/window\._ftLookupToken\(\)/.test(leer), "der Knopf „Auskunft anzeigen“ fehlt");
  ok(/Fragebogen-Link prüfen/.test(leer), "die Auskunft hat keine sichtbare Überschrift");

  // Der Knopf liest das sichtbare Feld — hier die Attrappe dafür.
  const feld = { value: "" };
  win.document.getElementById = (id) => (id === "ftTokenSuche" ? feld : null);

  feld.value = TOKEN_MAIL;
  win._ftLookupToken();
  const gefunden = ansicht();
  ok(gefunden.includes(TOKEN_MAIL), "der gesuchte Token steht nicht in der Auskunft");
  ok(/aktualisiert dieses Projekt/.test(gefunden), "die Wirkung einer Antwort fehlt in der Auskunft");
  ok(/Projekt: Aljia/.test(gefunden), "das zugehörige Projekt wird nicht genannt");
  ok(/_ftOpenProject/.test(gefunden), "das Projekt lässt sich aus der Auskunft nicht öffnen");

  // Auch die ganze Kundenadresse ist erlaubt.
  feld.value = "https://flowertech.ch/fragebogen.html?e=" + TOKEN_MAIL;
  win._ftLookupToken();
  ok(ansicht().includes(TOKEN_MAIL), "eine ganze Adresse wird nicht auf den Token zurückgeführt");

  // Ein Token, den diese Fassung nicht kennt.
  feld.value = TOKEN_KARTE;
  win._ftLookupToken();
  const unbekannt = ansicht();
  ok(/keinen Fragebogen/.test(unbekannt), "ein unbekannter Token wird nicht als solcher benannt");
  ok(/bleibt liegen/.test(unbekannt), "es fehlt die Aussage, was mit einer Antwort darauf geschieht");

  // Und das Wichtigste: Die Auskunft SCHREIBT NICHTS.
  const vorher = JSON.stringify(data);
  win._ftLookupToken();
  win._ftClearTokenLookup();
  eq(JSON.stringify(data), vorher, "die Token-Auskunft verändert den Datenstand");
}

/* ══ 7. Wiederherstellung aus dem veroeffentlichten Fragebogen ═════════════
   Belegter Live-Befund (11.09.2026): Der am 02.09. versendete Link
   pf-kXRwq0T1lOUcH7fsknz_b laedt oeffentlich einwandfrei — mit Fragen und
   Aljia-Vorbelegung —, in Quantus gibt es zu diesem Token aber KEINEN
   Fragebogen. Eine Antwort darauf faende ihren Vorgang nicht.

   Der Weg zurueck ist bewusst eng: lesen, sehen, ausdruecklich zuordnen.
   Kein neuer Token, keine erfundenen Fragen, keine Veroeffentlichung, keine
   Freigabe, kein Versand — und die eingegangene Antwort geht nicht verloren. */
{
  const VEROEFFENTLICHT = {
    schema: 1, title: "Ihre Angaben für FlowerTech", intro: "Kurz ein paar Fragen.",
    questions: CORE.normalizeIntakeQuestions(CORE.DEFAULT_INTAKE_QUESTIONS),
    prefill: { version: 1, values: { name: "Jule Dal", company: "Aljia", email: "juledal19@gmail.com" } },
    status: "open", generation: 2, company: { name: "FlowerTech" }, updatedAt: "2026-09-02T07:05:00.000Z",
  };

  // 7a) Der Kern rechnet — eng und ohne zu raten.
  const gerechnet = CORE.intakeFromPublished({
    token: TOKEN_MAIL, published: VEROEFFENTLICHT, projectId: PROJEKT, now: NOW,
  });
  ok(gerechnet.ok, "aus dem veröffentlichten Stand entsteht kein Datensatz");
  eq(gerechnet.intake.inviteToken, TOKEN_MAIL, "der Token wird verändert — der Link der Kundschaft bricht");
  eq(gerechnet.intake.questions.length, VEROEFFENTLICHT.questions.length,
    "die Fragen werden nicht unverändert übernommen");
  eq(gerechnet.intake.questions.map((q) => q.key).join(","),
    VEROEFFENTLICHT.questions.map((q) => q.key).join(","), "die Fragen kommen in anderer Form zurück");
  eq(gerechnet.intake.boundProjectId, PROJEKT, "der Bogen wird nicht an das gewählte Projekt gebunden");
  eq(gerechnet.intake.formGeneration, 2, "die veröffentlichte Fassung geht verloren");
  eq(gerechnet.intake.restoredFrom, "published-intake-form", "die Herkunft wird nicht festgehalten");
  ok(gerechnet.intake.prefill && gerechnet.intake.prefill.values.email === "juledal19@gmail.com",
    "die veröffentlichte Vorbelegung geht verloren");

  // Nie blind: ohne Veröffentlichung und ohne Fragen entsteht nichts.
  ok(!CORE.intakeFromPublished({ token: TOKEN_MAIL, published: null }).ok,
    "ohne veröffentlichten Stand wird trotzdem etwas angelegt");
  ok(!CORE.intakeFromPublished({ token: TOKEN_MAIL, published: { title: "leer", questions: [] } }).ok,
    "ein Bogen ohne Fragen wird trotzdem angelegt");
  // Ohne ausdrückliche Wahl bleibt die Bindung leer — sie wird nie geraten.
  ok(!CORE.intakeFromPublished({ token: TOKEN_MAIL, published: VEROEFFENTLICHT }).intake.boundProjectId,
    "die Projektbindung wird geraten");

  // 7b) Laufzeit: lesen → sehen → zuordnen.
  const pfad = "flowertech/intakeForms/" + TOKEN_MAIL;
  const eingang = {
    id: "sub_aljia", kind: "intake", token: TOKEN_MAIL, createdAt: "2026-09-08T09:00:00.000Z",
    payload: { answers: [
      { key: "projekt", answer: "Website Reinigungsunternehmen Aljia" },
      { key: "name", answer: "Jule Dal" }, { key: "email", answer: "juledal19@gmail.com" },
      { key: "phone", answer: "079 000 00 00" }, { key: "adresse", answer: "Musterweg 1, 8000 Zürich" },
      { key: "kind", answer: "Website" }, { key: "need", answer: "Mehr Anfragen über die Website erhalten." },
    ] },
  };
  const { win, data, written } = makeSandbox({
    [pfad]: VEROEFFENTLICHT,
    "flowertech/submissions": { sub_aljia: eingang },
  });
  data.entities.projects[PROJEKT] = {
    id: PROJEKT, title: "Website Reinigungsunternehmen Aljia", projectType: "flowertech",
    pipelineStage: "intake", client: { name: "Jule Dal", company: "Aljia", email: "juledal19@gmail.com" },
    createdAt: "2026-08-20T06:00:00.000Z",
  };
  data.flowertech.intakes = {
    in_karte: {
      id: "in_karte", title: "Ihre Angaben", inviteToken: TOKEN_KARTE, boundProjectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open", createdAt: "2026-09-07T05:50:00.000Z",
      publishedAt: "2026-09-07T05:50:00.000Z",
    },
  };
  data.flowertech.activeTab = "intakes";
  const ansicht = () => String(win.viewFlowerTech()).replace(/<style>[\s\S]*?<\/style>/g, "");
  const feld = { value: TOKEN_MAIL };
  const gewaehltesProjekt = { value: "" };
  win.document.getElementById = (id) => (id === "ftTokenSuche" ? feld
    : (id === "ftRestoreProjekt" ? gewaehltesProjekt : null));

  win._ftLookupToken();
  const unbekannt = ansicht();
  ok(/keinen Fragebogen/.test(unbekannt), "der Token gilt nicht als unbekannt");
  ok(/Veröffentlichten Fragebogen laden \(nur lesen\)/.test(unbekannt),
    "es gibt keinen sichtbaren Weg, den veröffentlichten Stand zu lesen");

  // Lesen — und nichts sonst.
  const vorherGeschrieben = JSON.stringify(written);
  const vorherDaten = JSON.stringify(data);
  win._ftLoadPublishedIntake();
  await new Promise((r) => setTimeout(r, 0));
  const gelesen = ansicht();
  eq(JSON.stringify(written), vorherGeschrieben, "das Lesen schreibt nach draussen");
  eq(JSON.stringify(data), vorherDaten, "das Lesen verändert den Datenstand");
  ok(/Veröffentlicht draussen/.test(gelesen), "der veröffentlichte Stand wird nicht angezeigt");
  ok(/28 Fragen/.test(gelesen), `die Zahl der Fragen fehlt in der Anzeige`);
  ok(/vorbelegt: company, email, name/.test(gelesen), "die veröffentlichte Vorbelegung wird nicht gezeigt");
  ok(/liegt noch/.test(gelesen), "die liegengebliebene Antwort zu diesem Token wird nicht angezeigt");
  ok(/id="ftRestoreProjekt"/.test(gelesen), "es fehlt die Auswahl, zu welchem Projekt der Bogen gehört");

  // Ohne Projektwahl passiert nichts — und es kommt auch keine Rueckfrage.
  win._ftRestoreIntakeFromPublished();
  eq(Object.keys(data.flowertech.intakes).length, 1, "ohne Projektwahl wird trotzdem etwas angelegt");
  ok(!/wirklich wiederherstellen/i.test(ansicht()),
    "ohne gewähltes Projekt erscheint trotzdem eine Rückfrage");

  /* 7b') Mit Wahl: erst die SICHTBARE Rueckfrage — geschrieben wird noch nicht.
     Live-Befund (11.09.2026): Hier stand ein window.confirm. Der native
     Dialog haelt den ganzen Browser an; per Fernsteuerung liess er sich
     weder anklicken (Zeitueberschreitung) noch annehmen. Die Rueckfrage ist
     jetzt gewoehnliches HTML in der Karte. */
  gewaehltesProjekt.value = PROJEKT;
  win._ftRestoreIntakeFromPublished();
  const gefragt = ansicht();
  eq(Object.keys(data.flowertech.intakes).length, 1,
    "die Rückfrage hat den Fragebogen schon geschrieben — sie muss folgenlos sein");
  ok(/wirklich wiederherstellen/i.test(gefragt), "es erscheint keine sichtbare Rückfrage");
  ok(/role="alertdialog"/.test(gefragt), "die Rückfrage ist für Bedienhilfen nicht als solche erkennbar");
  ok(gefragt.includes(TOKEN_MAIL), "die Rückfrage nennt den Token nicht");
  ok(/28 Fragen/.test(gefragt), "die Rückfrage nennt die Zahl der Fragen nicht");
  ok(/Website Reinigungsunternehmen Aljia/.test(gefragt), "die Rückfrage nennt das Zielprojekt nicht");
  ok(/_ftConfirmRestoreIntake\(\)/.test(gefragt) && /Ja, wiederherstellen/.test(gefragt),
    "der Rückfrage fehlt der zustimmende Knopf");
  ok(/_ftCancelRestore\(\)/.test(gefragt) && /Abbrechen/.test(gefragt),
    "der Rückfrage fehlt der ablehnende Knopf");

  // Abbrechen aendert nichts — und fuehrt zurueck auf den gelesenen Stand.
  const vorAbbruch = JSON.stringify(data);
  win._ftCancelRestore();
  eq(JSON.stringify(data), vorAbbruch, "das Abbrechen verändert den Datenstand");
  const abgebrochen = ansicht();
  ok(!/wirklich wiederherstellen/i.test(abgebrochen), "die Rückfrage bleibt nach dem Abbrechen stehen");
  ok(/Veröffentlicht draussen/.test(abgebrochen), "nach dem Abbrechen ist der gelesene Stand verschwunden");

  /* Die gewaehlte Zuordnung haelt ein Neuzeichnen aus. Befund am Handy
     (11.09.2026): Zwischen Auswahl und Klick zeichnete die App neu, das
     <select> stand wieder auf „— Projekt wählen“, und der Klick lief ins
     Leere — wer langsamer klickt oder fernsteuert, traf den Knopf nie. Die
     Wahl gehoert deshalb in den Zustand, nicht nur ins DOM. */
  win._ftRestoreProjektWahl(PROJEKT);
  gewaehltesProjekt.value = "";              // so, als haette die App neu gezeichnet
  ok(ansicht().includes('value="' + PROJEKT + '" selected'),
    "die gewählte Zuordnung wird beim Neuzeichnen nicht wieder gesetzt");
  win._ftRestoreIntakeFromPublished();
  ok(/wirklich wiederherstellen/i.test(ansicht()),
    "nach dem Neuzeichnen läuft der Knopf wieder ins Leere");
  win._ftCancelRestore();

  // Und nun ausdruecklich zustimmen.
  gewaehltesProjekt.value = PROJEKT;
  win._ftRestoreIntakeFromPublished();
  win._ftConfirmRestoreIntake();
  const neuer = Object.values(data.flowertech.intakes).find((i) => i.inviteToken === TOKEN_MAIL);
  ok(neuer, "der Fragebogen wurde nicht wiederhergestellt");
  eq(neuer.inviteToken, TOKEN_MAIL, "der Token wurde verändert");
  eq(neuer.boundProjectId, PROJEKT, "der wiederhergestellte Bogen ist nicht an das Projekt gebunden");
  eq(neuer.questions.length, VEROEFFENTLICHT.questions.length, "die Originalfragen fehlen");
  eq(JSON.stringify(written), vorherGeschrieben,
    "die Wiederherstellung veröffentlicht etwas — die Kundenseite muss unangetastet bleiben");
  // Der andere Bogen bleibt, wie er war.
  eq(data.flowertech.intakes.in_karte.inviteToken, TOKEN_KARTE, "der bestehende Fragebogen wurde verändert");

  // 7c) Jetzt findet die liegengebliebene Antwort ihren Vorgang.
  const projekteVorher = Object.keys(data.entities.projects).length;
  win._ftIngestSubmissions({ sub_aljia: eingang });
  eq(Object.keys(data.entities.projects).length, projekteVorher,
    "aus der nachgereichten Antwort entsteht ein zweites Projekt");
  const projekt = data.entities.projects[PROJEKT];
  ok(projekt.ftIntakeDocument && (projekt.ftIntakeDocument.answers || []).length,
    "die Antwort erreicht das belegte Projekt nicht");
  eq(projekt.client.email, "juledal19@gmail.com", "gepflegte Kundendaten wurden überschrieben");
  eq(data.flowertech.intakes[neuer.id].status, "answered", "der Bogen gilt nach der Antwort nicht als beantwortet");

  // 7d) Der Rückweg: nur eine Wiederherstellung OHNE Antwort lässt sich zurücknehmen.
  win._ftAskUndoRestoredIntake(neuer.id);
  win._ftUndoRestoredIntake(neuer.id);
  ok(data.flowertech.intakes[neuer.id], "ein beantworteter Bogen liess sich zurücknehmen");

  // 7e) Und der Rückweg selbst fragt ebenfalls sichtbar — am Projekt.
  const b = makeSandbox();
  b.data.entities.projects[PROJEKT] = {
    id: PROJEKT, title: "Website Reinigungsunternehmen Aljia", projectType: "flowertech",
    pipelineStage: "intake", createdAt: "2026-08-20T06:00:00.000Z",
  };
  b.data.flowertech.intakes = {
    in_wh: {
      id: "in_wh", title: "Ihre Angaben", inviteToken: TOKEN_MAIL, boundProjectId: PROJEKT,
      questions: CORE.DEFAULT_INTAKE_QUESTIONS, status: "open", restoredFrom: "published-intake-form",
      createdAt: NOW, publishedAt: "2026-09-02T06:59:00.000Z",
    },
  };
  const projektAnsicht = () => String(b.win._ftProjectIntakeRow(PROJEKT));
  ok(/_ftAskUndoRestoredIntake\(/.test(projektAnsicht()), "der Rückweg ist am Projekt nicht sichtbar");
  b.win._ftAskUndoRestoredIntake("in_wh");
  const rueckfrage = projektAnsicht();
  ok(/Wirklich zurücknehmen\?/.test(rueckfrage), "der Rückweg fragt nicht sichtbar nach");
  ok(b.data.flowertech.intakes.in_wh, "die blosse Rückfrage hat schon gelöscht");
  b.win._ftCancelUndoRestored();
  ok(b.data.flowertech.intakes.in_wh, "das Abbrechen hat gelöscht");
  ok(!/Wirklich zurücknehmen\?/.test(projektAnsicht()), "die Rückfrage bleibt nach dem Abbrechen stehen");
  b.win._ftAskUndoRestoredIntake("in_wh");
  b.win._ftUndoRestoredIntake("in_wh");
  ok(!b.data.flowertech.intakes.in_wh, "die Wiederherstellung liess sich nicht zurücknehmen");
}

/* ══ 9. Kein window.confirm auf dem Reparaturweg ═══════════════════════════
   Live-Befund (11.09.2026, Fernsteuerung): Nach „Wiederherstellen" blieb ein
   nativer confirm-Dialog stehen. Input.dispatchMouseEvent lief in eine
   Zeitueberschreitung, getJsDialog meldete „confirm", das Annehmen scheiterte
   an Emulation.setFocusEmulationEnabled — der gesperrte Rechner kam nicht
   mehr an den Dialog heran. Ein Dialog, den man nicht wegklicken kann, ist
   kein Schutz. Die Rueckfragen dieses Weges sind deshalb HTML.
   (Andere, aeltere confirm-Aufrufe im Modul bleiben unangetastet — hier geht
   es allein um den Reparaturweg.) */
{
  const funktion = (name) => {
    const start = quelle.indexOf("window." + name + " = function");
    assert.ok(start > -1, `${name} wurde nicht gefunden`);
    const ende = quelle.indexOf("\n  };", start);
    return quelle.slice(start, ende > -1 ? ende : start + 4000);
  };
  ["_ftRestoreIntakeFromPublished", "_ftConfirmRestoreIntake", "_ftCancelRestore",
   "_ftAskUndoRestoredIntake", "_ftUndoRestoredIntake"].forEach((n) => {
    ok(!/(^|[^.\w])confirm\s*\(/.test(funktion(n)),
      `${n} haelt den Browser weiterhin mit einem nativen confirm an`);
  });
  // Die zweite Stufe muss es wirklich geben — sonst waere die Rueckfrage nur Zierde.
  ok(/tokenAuskunft\.bestaetigen = \{/.test(quelle), "die Rückfrage merkt sich nichts");
  ok(/if \(a\.bestaetigen\)/.test(quelle), "die Rückfrage wird nicht gezeichnet");
}

/* ══ 10. Der Sync-Kopf zeigt DIESES Geraet ════════════════════════════════
   Live-Befund (11.09.2026): Der Kopf stand dauerhaft auf „Synchronisiert… ·
   Zuletzt 22:19" — auch nach einem Reload, auch wenn nichts lief. Kein
   Stillstand des Abgleichs, sondern ein Anzeigefehler mit echter Ursache:
   syncStatus/lastSyncAt lagen in data.flowertech, also im synchronisierten
   Datenstand. Ein „syncing" wurde gespeichert, reiste in die Wolke und kam
   ueberall zurueck; „Zuletzt" konnte die Uhrzeit eines fremden Geraets sein.
   Laufzeitzustand gehoert nicht in die Daten. */
{
  ok(!/data\.flowertech\.syncStatus = |ft\.syncStatus = "/.test(quelle),
    "der Sync-Stand wird weiterhin in den Datenstand geschrieben");
  ok(/delete ft\.syncStatus;/.test(quelle) && /delete ft\.lastSyncAt;/.test(quelle),
    "die Altlast im Datenstand wird nicht abgeräumt");
  const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  ok(/delete d\.flowertech\.syncStatus;/.test(index),
    "der Startzustand legt syncStatus weiterhin im Datenstand an");
  ok(!/^\s+syncStatus: "idle",$/m.test(index), "syncStatus steht weiterhin im Grunddatenstand");

  const { win, data } = makeSandbox();
  data.flowertech.activeTab = "projects";
  // Ein alter, mitsynchronisierter Stand darf die Anzeige nicht mehr faerben.
  data.flowertech.syncStatus = "syncing";
  data.flowertech.lastSyncAt = "2026-09-10T22:19:00.000Z";
  const kopf = String(win.viewFlowerTech()).replace(/<style>[\s\S]*?<\/style>/g, "");
  ok(!/22:19/.test(kopf), "die Anzeige zeigt weiterhin die mitgereiste Uhrzeit eines anderen Geräts");
  ok(/noch keine Daten angekommen/.test(kopf),
    "ohne Abgleich in dieser Sitzung behauptet der Kopf trotzdem etwas");
  ok(win._ftSyncStand().status !== "syncing",
    "der Anzeigestand übernimmt den mitsynchronisierten Wert „syncing“");
  eq(win._ftSyncStand().zuletzt, null, "der Anzeigestand übernimmt die mitsynchronisierte Uhrzeit");
  // Und der alte Ballast verschwindet aus den Daten, sobald sie angefasst werden.
  ok(!("syncStatus" in data.flowertech), "syncStatus bleibt im Datenstand liegen");
  ok(!("lastSyncAt" in data.flowertech), "lastSyncAt bleibt im Datenstand liegen");
}

/* ══ 8. Kein Textwiderspruch mehr ══════════════════════════════════════════
   Befund (11.09.2026): Oben „Kundenadresse – Fragebogen & Vision Room,
   Standard-AGB … waechst mit Vorschau, Offerte, AGB und Vertrag", unten
   „Nie Vorschau, Angebot, Vertrag oder AGB; die stehen erst im Kundenportal
   der Phase 2". Beides zusammen ergab keinen Sinn. */
{
  // Kommentare erreichen niemanden und duerfen den alten Satz benennen —
  // geprueft wird, was WIRKLICH ausgeliefert wird.
  const lieferbar = quelle
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  ok(!/Nie Vorschau, Angebot, Vertrag oder AGB/.test(lieferbar),
    "der widersprüchliche Satz steht weiterhin in der Oberfläche");
  ok(/core\.intakeLinkExplain\(linkFreigaben\(binding\.projectId\)\)/.test(quelle),
    "der erklärende Satz kommt nicht aus der einen Stelle im Kern");
  // Und der Satz aus dem Kern passt zur Überschrift: dieselbe Aufzählung.
  const ohneFreigabe = CORE.intakeLinkExplain({});
  ok(/Fragebogen samt Vision Room/.test(ohneFreigabe) && /Standard-AGB/.test(ohneFreigabe),
    "der Satz nennt nicht, was die Adresse von Anfang an zeigt");
  ok(!/nie eine Vorschau|Nie Vorschau/.test(ohneFreigabe), "der Satz behauptet weiterhin „nie eine Vorschau“");
  const mitFreigabe = CORE.intakeLinkExplain({ previewVisible: true, contractVisible: true });
  ok(/freigegebene Vorschau/.test(mitFreigabe) && /freigegebenen Vertrag/.test(mitFreigabe),
    "nach der Freigabe nennt der Satz Vorschau und Vertrag nicht");
}

console.log(`flowertech kundenlink-alias: ok (${checks} Pruefungen)`);
