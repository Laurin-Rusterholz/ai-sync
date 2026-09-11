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
    "with (window) {\n" + meta + "\n" + boxen + "\n" + handler +
    "\nreturn { closeBox: chatgptLeadCloseBoxHtml, historie: chatgptLeadCloseHistoryHtml,"
    + " handeln: chatgptModuleHandleAction };\n}")(...namen.map((n) => scope[n]));
  const klick = (action, extra = {}) => {
    Object.entries(extra).forEach(([k, v]) => felder.set(k, { value: v }));
    zugriff.handeln(action, { dataset: { id: lead.id } }, { preventDefault() {}, stopPropagation() {} });
  };
  return { win, lead, meldungen, klick, zugriff,
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

console.log(`chatgpt lead wiedereroeffnen: ok (${checks} Pruefungen)`);
