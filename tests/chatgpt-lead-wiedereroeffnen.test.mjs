/*
 * Ein abgeschlossener Lead war eine Sackgasse.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026): Das Gmail-Briefing 01.08.–01.09.2026 wurde am 06.09.
 * abgeschlossen, obwohl die Anhaenge noch nicht geprueft waren. Am Lead
 * standen ein Korrekturkommentar und eine verknuepfte offene Aufgabe — aber
 * ein abgeschlossener Lead war nur noch lesbar: kein Statusfeld, kein Knopf,
 * kein Weg zurueck. Der Fehler liess sich dokumentieren, aber nicht beheben.
 *
 * Der Rueckweg ist jetzt da, sichtbar und begruendungspflichtig. Was dabei
 * NICHT passiert: Der bisherige Abschluss wird nicht geloescht. Er wandert
 * mit Zeitpunkt, Urheber und Hinfaelligkeitsgrund in die Abschluss-Historie
 * und steht dort sichtbar, zusammen mit Zeitpunkt und Begruendung der
 * Wiedereroeffnung.
 *
 * Geprueft wird der ECHTE Code aus index.html. Es werden keine echten Daten
 * angefasst.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quelle = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

/* ── Die echten Abschnitte ────────────────────────────────────────────── */
function schnitt(vonText, bisText, wasIst) {
  const von = quelle.indexOf(vonText);
  const bis = quelle.indexOf(bisText, von + 1);
  assert.ok(von > -1 && bis > von, `${wasIst} wurde in index.html nicht gefunden`);
  checks++;
  return quelle.slice(von, bis);
}
const meta = schnitt("const CGL_STATUS_META = {", "function chatgptLeadCard", "die Lead-Grunddaten");
const boxen = schnitt("function chatgptLeadCloseHistory(l) {", "// Bewertung & Zuweisung als eigener Schritt",
  "der Abschluss-Kasten");
const statusBox = schnitt("function chatgptLeadStatusBoxHtml(l) {", "function chatgptLeadCloseHistory(l) {",
  "der Status-Kasten");
const feldHandler = schnitt("  if (action === \"cgl-status\") {", "\n  return false;\n}",
  "der Statuswechsel");
const handler = schnitt("function chatgptModuleHandleAction(action, el, e) {",
  "function chatgptModuleHandleKeydown", "der Aktionsverteiler");

function bauen(lead) {
  const leads = { [lead.id]: lead };
  const meldungen = [];
  let gezeichnet = 0;
  const felder = new Map();
  const win = {};
  const scope = {
    window: win,
    APP: { state: { data: { entities: { chatgptLeads: leads, chatgptTasks: {} } } } },
    ownEntity: (map, id) => map[id] || null,
    nowIso: () => "2026-09-11T22:30:00.000Z",
    fmtDateTime: (v) => (v ? String(v).slice(0, 16).replace("T", " ") : "—"),
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    toast: (typ, titel, text) => meldungen.push({ typ, titel, text }),
    render: () => { gezeichnet++; },
    scheduleSave: () => {},
    navigate: () => {},
    // chatgptLeadMissing, chatgptLeadProgress, chatgptLeadLinkCount und
    // chatgptLeadAssignmentDone kommen ECHT aus index.html (sie stehen im
    // ausgeschnittenen Abschnitt und verdecken jeden Platzhalter) — die
    // Pflichtpruefung beim Abschliessen ist damit die wirkliche.
    chatgptLeadRefreshBoxes: () => {},
    chatgptLeadAssessmentSummary: () => "",
    chatgptLeadNormalizePermissions: () => ({}),
    createChatgptLead: () => null,
    $: () => null,
    confirm: () => { throw new Error("window.confirm blockiert die Bedienung"); },
    prompt: () => { throw new Error("window.prompt blockiert die Bedienung"); },
    document: { getElementById: (id) => felder.get(id) || null },
    CGL_ASSESSMENT: [], CGL_ASSIGNEES: {},
  };
  win.window = win;
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const zugriff = new Function(...namen,
    "with (window) {\n" + meta + "\n" + statusBox + "\n" + boxen + "\n" + handler +
    "\nfunction statusWechsel(el){ const action = \"cgl-status\"; const leads = window.__leads; "
    + feldHandler + "\n return false; }" +
    "\nreturn { closeBox: chatgptLeadCloseBoxHtml, statusBox: chatgptLeadStatusBoxHtml,"
    + " historie: chatgptLeadCloseHistoryHtml, handeln: chatgptModuleHandleAction,"
    + " statusWechsel: statusWechsel };\n}")(...namen.map((n) => scope[n]));
  const klick = (action, extra = {}) => {
    Object.entries(extra).forEach(([k, v]) => felder.set(k, { value: v }));
    zugriff.handeln(action, { dataset: { id: lead.id } }, { preventDefault() {}, stopPropagation() {} });
  };
  win.__leads = leads;
  return { win, lead, meldungen, klick, zugriff,
    statusBox: () => String(zugriff.statusBox(lead)),
    waehle: (wert) => zugriff.statusWechsel({ value: wert, dataset: { id: lead.id }, type: "select-one" }),
    box: () => String(zugriff.closeBox(lead)),
    hist: () => String(zugriff.historie(lead)),
    gezeichnet: () => gezeichnet };
}

/* Ein vollstaendig dokumentierter Lead — so, wie er am 06.09. abgeschlossen
   wurde. Die Pflichtpruefung (chatgptLeadMissing) ist die echte aus
   index.html, also muss auch der Testfall echt aussehen. */
const BRIEFING = () => ({
  id: "cgl_briefing", title: "Gmail-Briefing 01.08.–01.09.2026",
  rawInput: "Anhänge prüfen", status: "abgeschlossen",
  interpretation: "Mails des Zeitraums sichten und zusammenfassen.",
  research: "Gmail-Index gelesen.", plan: "Briefing schreiben.",
  execution: "Briefing erstellt.", result: "Liegt als Notiz in Quantus.",
  assessment: { menge: "chatgpt", werkzeug: "chatgpt", kontext: "chatgpt",
    quantusNaehe: "chatgpt", recherche: "chatgpt", zuschnitt: "chatgpt" },
  assignee: "chatgpt", assignmentReason: "Nahe an Quantus, kein externes Werkzeug nötig.",
  readAt: "2026-09-05T08:00:00.000Z",
  closedAt: "2026-09-06T09:12:00.000Z", closedBy: "assistant",
  createdAt: "2026-09-01T07:00:00.000Z", updatedAt: "2026-09-06T09:12:00.000Z",
  comments: [{ id: "c1", createdAt: "2026-09-07T10:00:00.000Z", text: "Korrektur: Anhänge waren nicht geprüft." }],
  linkedTasks: ["300e886b-9794-4875-a4c0-f1f90f66d7fb"],
});

/* ══ 1. Der Rückweg ist sichtbar — und geschieht nicht von selbst ═════════ */
{
  const t = bauen(BRIEFING());
  const zu = t.box();
  ok(/cgl-reopen-ask/.test(zu), "am abgeschlossenen Lead gibt es keinen Weg zurück");
  ok(/Lead wieder öffnen/.test(zu), "der Rückweg ist nicht beschriftet");
  ok(/Historie/.test(zu), "es steht nicht da, dass der Abschluss erhalten bleibt");

  t.klick("cgl-reopen-ask");
  eq(t.lead.status, "abgeschlossen", "die blosse Rückfrage hat den Lead schon geöffnet");
  const gefragt = t.box();
  ok(/role="alertdialog"/.test(gefragt), "die Rückfrage ist für Bedienhilfen nicht erkennbar");
  ok(/id="cglReopenStatus"/.test(gefragt), "es fehlt die Wahl des regulären Status");
  ["neu", "verstanden", "in_arbeit", "wartet"].forEach((st) => {
    ok(gefragt.includes(`value="${st}"`), `der Status ${st} steht nicht zur Wahl`);
  });
  ok(!/value="abgeschlossen"/.test(gefragt), "„abgeschlossen“ steht als Ziel zur Wahl");
  ok(/id="cglReopenGrund"/.test(gefragt), "es fehlt die Begründung");
  ok(/06\.09|2026-09-06/.test(gefragt), "die Rückfrage nennt den bisherigen Abschluss nicht");
  ok(/cgl-reopen-do/.test(gefragt) && /cgl-reopen-cancel/.test(gefragt),
    "der Rückfrage fehlen die zwei Knöpfe");

  // Abbrechen: folgenlos.
  t.klick("cgl-reopen-cancel");
  eq(t.lead.status, "abgeschlossen", "das Abbrechen hat den Lead geöffnet");
  ok(/cgl-reopen-ask/.test(t.box()), "die Rückfrage bleibt nach dem Abbrechen stehen");
}

/* ══ 2. Ohne Begründung nicht — und „Wartet“ verlangt, was fehlt ══════════ */
{
  const t = bauen(BRIEFING());
  t.klick("cgl-reopen-ask");
  t.klick("cgl-reopen-do", { cglReopenStatus: "in_arbeit", cglReopenGrund: "  ", cglReopenBlocked: "" });
  eq(t.lead.status, "abgeschlossen", "ohne Begründung wurde trotzdem geöffnet");
  ok(/role="alert"/.test(t.box()), "der fehlende Grund steht nicht sichtbar am Feld");
  ok(/begründen/i.test(t.box()), "der Fehler sagt nicht, was fehlt");
  ok(t.meldungen.some((m) => m.typ === "warn"), "es wird nicht gemeldet, dass nichts geschah");

  t.klick("cgl-reopen-do", { cglReopenStatus: "wartet", cglReopenGrund: "Anhänge offen", cglReopenBlocked: "" });
  eq(t.lead.status, "abgeschlossen", "„Wartet“ ohne Angabe wurde trotzdem gesetzt");
  ok(/Wartet/.test(t.box()), "der Hinweis zu „Wartet“ fehlt");
}

/* ══ 3. Wieder geöffnet — und der Abschluss ist erhalten ══════════════════ */
{
  const t = bauen(BRIEFING());
  const vorherKommentare = JSON.stringify(t.lead.comments);
  const vorherLinks = JSON.stringify(t.lead.linkedTasks);
  t.klick("cgl-reopen-ask");
  t.klick("cgl-reopen-do", {
    cglReopenStatus: "in_arbeit",
    cglReopenGrund: "Anhänge waren noch nicht geprüft",
    cglReopenBlocked: "",
  });
  eq(t.lead.status, "in_arbeit", "der Lead steht nicht im gewählten regulären Status");
  eq(t.lead.closedAt, null, "der Lead gilt weiterhin als abgeschlossen");
  eq(t.lead.closedBy, null, "der Abschliessende steht weiterhin als aktuell da");

  // Die Historie: nichts ist verloren.
  eq(t.lead.closeHistory.length, 1, "der bisherige Abschluss wurde nicht archiviert");
  const h = t.lead.closeHistory[0];
  eq(h.closedAt, "2026-09-06T09:12:00.000Z", "der Zeitpunkt des Abschlusses ging verloren");
  eq(h.closedBy, "assistant", "der Urheber des Abschlusses ging verloren");
  eq(h.reopenedTo, "in_arbeit", "der neue Status steht nicht in der Historie");
  eq(h.reason, "Anhänge waren noch nicht geprüft", "die Begründung ging verloren");
  ok(h.reopenedAt, "der Zeitpunkt der Wiedereröffnung fehlt");

  // Und sie ist sichtbar.
  const hist = t.hist();
  ok(/Abschluss-Historie \(1\)/.test(hist), "die Historie wird nicht angezeigt");
  ok(/Anhänge waren noch nicht geprüft/.test(hist), "die Begründung steht nicht in der Anzeige");
  ok(/2026-09-06/.test(hist), "der bisherige Abschluss steht nicht in der Anzeige");

  // Alles andere am Lead bleibt, wie es war.
  eq(JSON.stringify(t.lead.comments), vorherKommentare, "der Korrekturkommentar wurde verändert");
  eq(JSON.stringify(t.lead.linkedTasks), vorherLinks, "die verknüpfte Aufgabe wurde verändert");
  eq(t.lead.readAt, "2026-09-05T08:00:00.000Z", "der Lesezeitpunkt wurde verändert");
  eq(t.lead.title, "Gmail-Briefing 01.08.–01.09.2026", "der Titel wurde verändert");

  // Und der Lead lässt sich erneut abschliessen und erneut öffnen — reversibel.
  t.klick("cgl-close");
  eq(t.lead.status, "abgeschlossen", "der wieder geöffnete Lead liess sich nicht erneut abschliessen");
  t.klick("cgl-reopen-ask");
  t.klick("cgl-reopen-do", { cglReopenStatus: "wartet", cglReopenGrund: "Nochmals offen", cglReopenBlocked: "Antwort der Bank" });
  eq(t.lead.status, "wartet", "die zweite Wiedereröffnung schlug fehl");
  eq(t.lead.blockedReason, "Antwort der Bank", "„Wartet“ hat nicht festgehalten, was fehlt");
  eq(t.lead.closeHistory.length, 2, "die Historie sammelt nicht");
}

/* ══ 4. Der Ausnahmeweg „hinfällig“ hält den Browser nicht mehr an ════════
   Er fragte mit prompt() und confirm() — dieselbe Sackgasse. Und weil ein
   hinfaellig geschlossener Lead denselben Rueckweg bekommt, ist auch diese
   Ausnahme nicht mehr endgueltig. */
{
  const offen = Object.assign(BRIEFING(), { status: "in_arbeit", closedAt: null, closedBy: null });
  const t = bauen(offen);
  t.klick("cgl-obsolete-ask");                 // haette frueher blockiert
  eq(t.lead.status, "in_arbeit", "die blosse Rückfrage hat den Lead schon geschlossen");
  t.klick("cgl-obsolete", { cglObsoleteGrund: "" });
  eq(t.lead.status, "in_arbeit", "ohne Begründung wurde als hinfällig geschlossen");
  t.klick("cgl-obsolete", { cglObsoleteGrund: "Anfrage hat sich erledigt" });
  eq(t.lead.status, "abgeschlossen", "der Ausnahmeweg schliesst nicht mehr");
  eq(t.lead.closedBy, "laurin", "die Ausnahme wird nicht als Laurins vermerkt");
  eq(t.lead.obsoleteReason, "Anfrage hat sich erledigt", "der Grund wurde nicht vermerkt");
  // Auch das ist umkehrbar — und der Grund bleibt in der Historie.
  t.klick("cgl-reopen-ask");
  t.klick("cgl-reopen-do", { cglReopenStatus: "neu", cglReopenGrund: "doch noch aktuell", cglReopenBlocked: "" });
  eq(t.lead.status, "neu", "ein hinfällig geschlossener Lead liess sich nicht wieder öffnen");
  eq(t.lead.obsoleteReason, null, "der Hinfälligkeitsgrund steht weiterhin als aktuell da");
  eq(t.lead.closeHistory[0].obsoleteReason, "Anfrage hat sich erledigt",
    "der Hinfälligkeitsgrund ging verloren statt in die Historie zu wandern");
}

/* ══ 5. Quelltext: kein natives confirm/prompt mehr auf diesen Wegen ══════ */
{
  ["cgl-reopen-ask", "cgl-reopen-do", "cgl-reopen-cancel", "cgl-obsolete-ask", "cgl-obsolete-cancel"]
    .forEach((a) => ok(handler.includes(`case "${a}"`), `die Aktion ${a} fehlt`));
  const obsolete = handler.slice(handler.indexOf('case "cgl-obsolete-ask"'),
    handler.indexOf('case "cgl-assess"'));
  ok(!/(^|[^.\w])(confirm|prompt)\s*\(/.test(obsolete),
    "der Ausnahmeweg hält den Browser weiterhin mit einem nativen Dialog an");
  ok(!/(^|[^.\w])(confirm|prompt)\s*\(/.test(boxen),
    "der Abschluss-Kasten hält den Browser weiterhin mit einem nativen Dialog an");
  // Und nichts geschieht von selbst: keine Wiedereröffnung ohne Klick.
  ok(!/closeHistory\s*=\s*\[\]/.test(quelle),
    "die Historie wird beim Laden in jeden Lead geschrieben — echte Daten würden sich von selbst ändern");
}

/* ══ 7. „Wartet" fragt sichtbar — der letzte native Dialog ist weg ═══════
   Befund (11.09.2026, FlowerTech-Designlead): Status „In Arbeit" → „Wartet"
   oeffnete ein natives prompt(). Es hielt den ganzen Tab an; bei gesperrtem
   Rechner liess es sich weder ausfuellen noch wegklicken
   (getJsDialog().dismiss() scheitert an Emulation.setFocusEmulationEnabled).
   Derselbe Blocker wie zuvor beim Wiederherstellen, beim Dokumentindex und
   beim Hinfaellig-Weg. */
{
  const t = bauen(Object.assign(BRIEFING(), { status: "in_arbeit", closedAt: null, closedBy: null }));
  const feld = { value: "wartet", dataset: { id: t.lead.id }, type: "select-one" };
  // Der Wechsel selbst darf NICHTS aendern, solange kein Grund dasteht.
  t.zugriff.statusWechsel(feld);
  eq(t.lead.status, "in_arbeit", "der Status springt auf „Wartet“, bevor ein Grund dasteht");
  eq(feld.value, "in_arbeit", "das Auswahlfeld bleibt auf „Wartet“ stehen, obwohl nichts geschah");
  ok(!t.lead.blockedReason, "es wurde ein Grund erfunden");

  const gefragt = t.statusBox();
  ok(/role="alertdialog"/.test(gefragt), "die Rückfrage ist für Bedienhilfen nicht erkennbar");
  ok(/Auf „Wartet“ setzen\?/.test(gefragt), "die Rückfrage ist nicht beschriftet");
  ok(/id="cglWartenGrund"/.test(gefragt), "es fehlt das Feld für den Grund");
  ok(/In Arbeit/.test(gefragt), "es steht nicht da, welcher Status bis dahin gilt");
  ok(/cgl-warten-do/.test(gefragt) && /cgl-warten-cancel/.test(gefragt),
    "der Rückfrage fehlen die zwei Knöpfe");

  // Ohne Grund geschieht nichts — und es wird gesagt, warum.
  t.klick("cgl-warten-do", { cglWartenGrund: "  " });
  eq(t.lead.status, "in_arbeit", "ohne Grund wurde trotzdem auf „Wartet“ gesetzt");
  ok(/role="alert"/.test(t.statusBox()), "der fehlende Grund steht nicht sichtbar am Feld");

  // Abbrechen: folgenlos.
  t.klick("cgl-warten-cancel");
  eq(t.lead.status, "in_arbeit", "das Abbrechen hat den Status gewechselt");
  ok(!/Auf „Wartet“ setzen\?/.test(t.statusBox()), "die Rückfrage bleibt nach dem Abbrechen stehen");

  // Mit Grund: jetzt wechselt er.
  t.zugriff.statusWechsel({ value: "wartet", dataset: { id: t.lead.id }, type: "select-one" });
  t.klick("cgl-warten-do", { cglWartenGrund: "Antwort der Gemeinde fehlt" });
  eq(t.lead.status, "wartet", "mit Grund wechselt der Status nicht");
  eq(t.lead.blockedReason, "Antwort der Gemeinde fehlt", "der Grund wurde nicht festgehalten");
  ok(t.meldungen.some((m) => m.typ === "ok"), "der Wechsel wird nicht gemeldet");

  // Ein anderer Status geht weiterhin ohne Rückfrage durch.
  const u = bauen(Object.assign(BRIEFING(), { status: "neu", closedAt: null, closedBy: null }));
  u.zugriff.statusWechsel({ value: "in_arbeit", dataset: { id: u.lead.id }, type: "select-one" });
  eq(u.lead.status, "in_arbeit", "ein gewöhnlicher Statuswechsel wird blockiert");
}

/* ══ 8. Quelltext: kein natives prompt/confirm mehr im ganzen Lead ════════ */
{
  // Kommentare duerfen die alten Dialoge beim Namen nennen — geprueft wird,
  // was WIRKLICH laeuft.
  const ohneKommentar = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const alles = ohneKommentar(meta + statusBox + boxen + handler + feldHandler);
  ok(!/(^|[^.\w])(prompt|confirm)\s*\(/.test(alles),
    "im Lead hält weiterhin ein nativer Dialog den Browser an");
  // Und die ChatGPT-Aufgabe am Element, derselbe Weg, dieselbe Falle.
  const aufgabe = ohneKommentar(schnitt("function chatgptTaskRow(t, withAnchor) {",
    "// Der Abschnitt am Element", "die Aufgabenzeile"));
  ok(/cgt-warten-do/.test(aufgabe) && /cgt-warten-cancel/.test(aufgabe),
    "die Aufgabenzeile hat keine sichtbare Rückfrage für „Wartet“");
  ok(!/(^|[^.\w])(prompt|confirm)\s*\(/.test(aufgabe),
    "die Aufgabenzeile hält weiterhin den Browser an");
  ["cgl-warten-do", "cgl-warten-cancel"].forEach((a) =>
    ok(handler.includes(`case "${a}"`), `die Aktion ${a} fehlt`));
  ok(/el\.value = l\.status;\s*\/\/ nichts aendern/.test(feldHandler),
    "das Auswahlfeld wird nicht auf den bisherigen Stand zurückgesetzt");
}

console.log(`chatgpt lead wiedereroeffnen: ok (${checks} Pruefungen)`);
