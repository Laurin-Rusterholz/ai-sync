/*
 * ChatGPT-Modul, Teil B (Leads) und Teil C (ChatGPT-Aufgaben) — was schiefgehen
 * kann, wenn die Regeln nur im Kopf statt im Code stehen.
 *
 * Drei Befunde aus dem Auftrag, die dieser Test festnagelt:
 *
 *  1. Leads und ChatGPT-Aufgaben sind normale Entity-Sammlungen und muessen den
 *     generischen Pull-Merge-Push ueberleben: "Eintrag auf Geraet A, anderer
 *     Eintrag auf Geraet B, dann Merge" darf nichts verlieren (CLAUDE.md,
 *     Fallstrick 2). Geprueft mit der ECHTEN mergeData().
 *  2. Der erzwungene Abschluss eines Leads hat GENAU EINE Quelle:
 *     chatgptLeadMissing(). Fehlt ein Pflichtschritt, das Bewertungsraster,
 *     die Zuweisung, die Begruendung oder die Verknuepfung, nennt sie den Punkt
 *     beim Namen — und nur eine leere Liste erlaubt den Abschluss. Der Test
 *     schneidet die echte Funktion samt ihrer Konstanten aus index.html.
 *  3. ChatGPT-Aufgaben sind Buchfuehrung fuer den Assistenten, nicht Arbeit
 *     fuer Laurin: ohne Anker nicht anlegbar, und die Aufgabenzahlen (offen,
 *     ueberfaellig, demnaechst) lesen ausschliesslich entities.tasks.
 *
 * Dazu die Entity-Kind-Registry, ueber die alle drei Typen verknuepfbar und
 * ankerfaehig werden: eine Sammlung, die spaeter unter entities dazukommt,
 * muss ohne Codeaenderung als Typ auftauchen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

function sliceFn(name) {
  const start = index.indexOf(name);
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, `${name} wurde in index.html nicht gefunden`);
  return index.slice(start, end);
}
function sliceConst(name) {
  const start = index.indexOf(name);
  ok(start > 0, `${name} wurde in index.html nicht gefunden`);
  const end = index.indexOf("\n];", start) + 3;
  return index.slice(start, end);
}

// ── mergeData, echt (wie in sync-chatgptnotes-merge.test.mjs) ──────────────
function loadMergeData() {
  const mergeEntitySrc = sliceFn("function mergeEntity(local, remote) {");
  const entityTsSrc = sliceFn("function entityTimestamp(item) {");
  const start = index.indexOf("function mergeData(local, remote) {");
  const end = index.indexOf("\nfunction ", start + 10);
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog", "flattenDeleteLog", "console",
    transportSrc + "\n" + entityTsSrc + "\n" + mergeEntitySrc + "\n" + index.slice(start, end) + "\nreturn mergeData;"
  );
  return fn(() => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}), { log() {}, warn() {} });
}
const mergeData = loadMergeData();
const base = (entities, extra) => ({ entities: { tasks: {}, chatgptLeads: {}, chatgptTasks: {}, ...entities }, ...(extra || {}) });

// ── 1. Geraet A und Geraet B legen je einen Lead und eine Aufgabe an ─────────
{
  const local = base({
    chatgptLeads: { la: { id: "la", createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z", title: "Am Rechner", rawInput: "…", status: "neu" } },
    chatgptTasks: { ta: { id: "ta", createdAt: "2026-09-01T08:01:00.000Z", updatedAt: "2026-09-01T08:01:00.000Z", text: "Namen ergänzen", state: "offen", anchorKind: "organization", anchorId: "o1" } },
  });
  const remote = base({
    chatgptLeads: { lb: { id: "lb", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z", title: "Am Handy", rawInput: "…", status: "neu" } },
    chatgptTasks: { tb: { id: "tb", createdAt: "2026-09-01T09:01:00.000Z", updatedAt: "2026-09-01T09:01:00.000Z", text: "Kunden erfassen", state: "offen", anchorKind: "email", anchorId: "m1" } },
  });
  const m = mergeData(local, remote);
  ok(Object.keys(m.entities.chatgptLeads).sort().join(",") === "la,lb", "Leads beider Geraete ueberleben den Merge nicht");
  ok(Object.keys(m.entities.chatgptTasks).sort().join(",") === "ta,tb", "ChatGPT-Aufgaben beider Geraete ueberleben den Merge nicht");
  ok(m.entities.chatgptTasks.tb.anchorKind === "email" && m.entities.chatgptTasks.tb.anchorId === "m1", "der Anker der Aufgabe von Geraet B kommt nicht mit");
}
// Gleiche Id, zwei Staende: der neuere gewinnt (Lead auf A abgeschlossen, B hat noch "in_arbeit").
{
  const local = base({ chatgptLeads: { l1: { id: "l1", createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z", status: "abgeschlossen", closedAt: "2026-09-02T10:00:00.000Z" } } });
  const remote = base({ chatgptLeads: { l1: { id: "l1", createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T12:00:00.000Z", status: "in_arbeit", closedAt: null } } });
  ok(mergeData(local, remote).entities.chatgptLeads.l1.status === "abgeschlossen", "der aeltere Remote-Stand ueberschreibt den Abschluss");
  ok(mergeData(remote, local).entities.chatgptLeads.l1.status === "abgeschlossen", "umgekehrt: der neuere Remote-Abschluss kommt nicht an");
}
// Eine auf Geraet B erledigte Aufgabe bleibt erledigt, wenn A sie noch offen hat.
{
  const local = base({ chatgptTasks: { t1: { id: "t1", createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z", state: "offen", anchorKind: "task", anchorId: "x" } } });
  const remote = base({ chatgptTasks: { t1: { id: "t1", createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z", state: "erledigt", resolvedAt: "2026-09-01T09:00:00.000Z", anchorKind: "task", anchorId: "x" } } });
  ok(mergeData(local, remote).entities.chatgptTasks.t1.state === "erledigt", "die Erledigung von Geraet B geht verloren");
}

// ── 2. Der erzwungene Abschluss: chatgptLeadMissing() ──────────────────────
const leadRules = new Function("window",
  sliceConst("const CGL_STEPS = [") + "\n" +
  sliceConst("const CGL_ASSESSMENT = [") + "\n" +
  'const CGL_ASSIGNEES = { chatgpt:"ChatGPT", cowork:"Claude Cowork" };\n' +
  sliceFn("function chatgptLeadAssessmentTally(a) {") + "\n" +
  sliceFn("function chatgptLeadLinkCount(lead) {") + "\n" +
  sliceFn("function chatgptLeadMissing(lead) {") + "\n" +
  sliceFn("function chatgptLeadDefaultPermissions() {") + "\n" +
  sliceFn("function chatgptLeadNormalizePermissions(p) {") + "\n" +
  "return { chatgptLeadMissing, chatgptLeadAssessmentTally, chatgptLeadDefaultPermissions, chatgptLeadNormalizePermissions, CGL_STEPS, CGL_ASSESSMENT };"
)({});
const { chatgptLeadMissing, chatgptLeadAssessmentTally } = leadRules;
const fullAssessment = { menge: "cowork", werkzeug: "cowork", kontext: "chatgpt", quantusNaehe: "chatgpt", recherche: "cowork", zuschnitt: "cowork" };
const complete = () => ({
  title: "Kunden anlegen", rawInput: "Bitte die Firma X als Kunde erfassen",
  interpretation: "Neue Organisation + Kontakt", research: "Firma X existiert noch nicht in Organisationen; im Mail Hub eine Mail gefunden.",
  plan: "1. Organisation anlegen 2. Mail verknuepfen", execution: "Beides gemacht", result: "Organisation 'Firma X' unter #/organizations/abc",
  assessment: { ...fullAssessment }, assignee: "cowork", assignmentReason: "Viel Text, klar abgegrenzt, wenig Quantus-Schritte.",
  linkedOrganizations: ["abc"],
});

ok(chatgptLeadMissing(complete()).length === 0, `ein vollstaendiger Lead gilt als nicht abschliessbar: ${chatgptLeadMissing(complete()).join(", ")}`);

// Frisch angelegter Lead: nur Titel + Wortlaut. Die Meldung nennt jeden Punkt.
{
  const missing = chatgptLeadMissing({ title: "Nur Titel", rawInput: "Nur Wortlaut" });
  for (const name of ["Interpretation", "Recherche", "Plan", "Ausführung", "Ergebnis", "Bewertungsraster", "Zuweisung (ChatGPT oder Cowork)", "Begründung der Zuweisung", "mindestens eine Verknüpfung"]) {
    ok(missing.includes(name), `die Fehlmeldung nennt "${name}" nicht: [${missing.join(", ")}]`);
  }
  ok(!missing.includes("Offene Fragen") && !missing.includes("Workflow-Notiz"), "optionale Schritte werden faelschlich verlangt");
}
// Genau ein Punkt fehlt → genau dieser Punkt wird genannt.
{
  const l = complete(); l.research = "   ";
  ok(chatgptLeadMissing(l).join("|") === "Recherche", `leere Recherche: erwartet [Recherche], erhalten [${chatgptLeadMissing(l).join(", ")}]`);
  const l2 = complete(); delete l2.linkedOrganizations;
  ok(chatgptLeadMissing(l2).join("|") === "mindestens eine Verknüpfung", "ohne Verknuepfung ist der Lead abschliessbar");
  const l3 = complete(); l3.linkedOrganizations = []; l3.linkedChatgptNotes = ["n1"];
  ok(chatgptLeadMissing(l3).length === 0, "eine Verknuepfung zu einem beliebigen Typ (hier ChatGPT Note) zaehlt nicht");
}
// B.3: Raster, Zuweisung, Begruendung — auch bei Eigenbearbeitung (assignee: chatgpt).
{
  const l = complete(); l.assessment = { ...fullAssessment, zuschnitt: null };
  const m = chatgptLeadMissing(l);
  ok(m.length === 1 && /^Bewertungsraster \(1 von 6 Kriterien offen\)$/.test(m[0]), `ein offenes Kriterium: erhalten [${m.join(", ")}]`);
  const l2 = complete(); l2.assignee = "chatgpt"; l2.assignmentReason = "";
  ok(chatgptLeadMissing(l2).join("|") === "Begründung der Zuweisung", "selbst bearbeitet (chatgpt) ohne Begruendung darf nicht abschliessbar sein");
  const l3 = complete(); l3.assignee = "chatgpt"; l3.assessment = {};
  ok(chatgptLeadMissing(l3).includes("Bewertungsraster"), "selbst bearbeitet (chatgpt) ohne Raster darf nicht abschliessbar sein");
  const l4 = complete(); l4.assignee = "irgendwer";
  ok(chatgptLeadMissing(l4).includes("Zuweisung (ChatGPT oder Cowork)"), "eine unbekannte Zuweisung wird akzeptiert");
  const t = chatgptLeadAssessmentTally(fullAssessment);
  ok(t.chatgpt === 2 && t.cowork === 4 && t.complete && t.suggested === "cowork", `Raster-Ergebnis falsch: ${JSON.stringify(t)}`);
}
// Berechtigungen: Standard ueberall "nein"/leer, keine Abkuerzung.
{
  const d = leadRules.chatgptLeadDefaultPermissions();
  ok(d.websuche === false && d.dateienErstellen.erlaubt === false && d.dateienErstellen.formate.length === 0
     && d.externeTools.length === 0 && d.verboten.length === 0, "Standard-Berechtigungen sind nicht ueberall 'nicht erteilt'");
  const n = leadRules.chatgptLeadNormalizePermissions({ websuche: "ja", dateienErstellen: true, externeTools: "alle" });
  ok(n.websuche === false, "ein Nicht-Boolean gilt als erteilt");
  ok(n.dateienErstellen.erlaubt === true && n.dateienErstellen.formate.length === 0, "dateienErstellen:true ohne Formate wird nicht sauber normalisiert");
  ok(Array.isArray(n.externeTools) && n.externeTools.length === 0, "externeTools als Zeichenkette wird nicht verworfen");
  ok(!/alles erlauben|allowAll|grantAll/i.test(index.slice(index.indexOf("function chatgptLeadDefaultPermissions"), index.indexOf("function chatgptLeadDefaultPermissions") + 4000)),
     "es gibt eine 'alles erlauben'-Abkuerzung");
}
// Kein Umgehen: der Klick-Handler liest dieselbe Funktion, und es gibt keine Massenaktion.
{
  const handler = index.slice(index.indexOf('case "cgl-close": {'), index.indexOf('case "cgl-obsolete": {'));
  ok(/const missing = chatgptLeadMissing\(l\);\s*if \(missing\.length\) \{/.test(handler), "der Abschluss-Handler prueft nicht ueber chatgptLeadMissing()");
  ok(!/cgl-close-all|cgl-bulk|cgl-force/.test(index), "es gibt eine Massen- oder Zwangs-Abschlussaktion");
  const statusSelect = index.slice(index.indexOf('<select data-action="cgl-status"'), index.indexOf('<select data-action="cgl-status"') + 400);
  ok(!/"abgeschlossen"/.test(statusSelect), "der Status-Wechsler bietet 'abgeschlossen' als Umweg an");
}
// Anzeige ohne Klick: Raster, Zuweisung und Berechtigungen stehen auf der Lead-Karte.
{
  const card = sliceFn("function chatgptLeadCard(l) {");
  ok(/chatgptLeadAssessmentSummary\(l/.test(card), "die Lead-Karte zeigt das Bewertungsraster nicht ohne Klick");
  const summary = sliceFn("function chatgptLeadAssessmentSummary(l, opts) {");
  ok(/chatgptLeadPermissionsLine\(l\)/.test(summary), "die Zusammenfassung zeigt die Berechtigungen nicht");
}

// ── 3. ChatGPT-Aufgaben: ohne Anker nichts, nie in Laurins Zahlen ──────────
{
  const created = [];
  const toasts = [];
  const createTask = new Function(
    "getEntity", "createEntity", "toast", "entityKindInfo", "entityDisplayLabel", "QUANTUS_VIRTUAL_KINDS",
    sliceFn("function chatgptAnchorInfo(kind, id, fallbackLabel) {") + "\n" + sliceFn("function createChatgptTask(anchorKind, anchorId, text, opts) {") + "\nreturn createChatgptTask;"
  )(
    (kind, id) => (kind === "organization" && id === "o1") ? { id: "o1", name: "Firma X" } : null,
    (kind, data) => { created.push({ kind, data }); return "neu-1"; },
    (t, a, b) => toasts.push(a),
    (kind) => ({ organization: { kind: "organization", store: "organizations", icon: "🏛️", label: "Organisation" } })[kind] || null,
    (kind, e) => e.name,
    { gmailMessage: { label: "Gmail-Nachricht", icon: "📧" } }
  );
  ok(createTask(null, null, "Namen ergänzen") === null && created.length === 0, "ohne Anker wurde eine ChatGPT-Aufgabe angelegt");
  ok(createTask("organization", "gibt-es-nicht", "Namen ergänzen") === null && created.length === 0, "mit nicht aufloesbarem Anker wurde eine Aufgabe angelegt");
  ok(createTask("organization", "o1", "   ") === null && created.length === 0, "ohne Text wurde eine Aufgabe angelegt");
  ok(createTask("organization", "o1", "Namen ergänzen") === "neu-1" && created.length === 1, "mit gueltigem Anker wird keine Aufgabe angelegt");
  const d = created[0].data;
  ok(created[0].kind === "chatgptTask" && d.anchorKind === "organization" && d.anchorId === "o1" && d.state === "offen" && d.anchorLabel === "Firma X",
     `die Aufgabe traegt Anker/Status nicht korrekt: ${JSON.stringify(d)}`);
  ok(createTask("gmailMessage", "18f2", "Kunden erfassen", { anchorLabel: "Re: Offerte" }) === "neu-1" && created[1].data.anchorLabel === "Re: Offerte",
     "eine Gmail-Nachricht (virtueller Anker, nicht in entities) ist nicht ankerfaehig");
}
{
  for (const name of ["function getTaskStats() {", "function getOverdueTasks() {", "function getUpcomingTasks(days = 3) {"]) {
    const src = sliceFn(name);
    ok(/entities\.tasks\b/.test(src) && !/chatgptTasks/.test(src), `${name} liest ChatGPT-Aufgaben mit — sie gehoeren nicht in Laurins Zahlen`);
  }
  // Die Sammlung heisst nicht "tasks" und liegt nicht darin: kein Listen-Renderer sieht sie.
  ok(/chatgptTasks: \{\},/.test(index), "chatgptTasks fehlt in emptyData");
  ok(!/entities\.tasks\[[^\]]*\]\s*=\s*[^;]*chatgptTask/.test(index), "eine ChatGPT-Aufgabe wird in entities.tasks geschrieben");
}

// ── 4. Registry: alle Sammlungen verknuepfbar, neue automatisch ─────────────
{
  const reg = new Function("APP", "navigate", "window",
    sliceConst("const QUANTUS_ENTITY_KINDS = [") + "\n" +
    index.slice(index.indexOf("const QUANTUS_ENTITY_STORES_EXCLUDED = "), index.indexOf("\n", index.indexOf("const QUANTUS_ENTITY_STORES_EXCLUDED = "))) + "\n" +
    "const QUANTUS_VIRTUAL_KINDS = {};\n" +
    sliceFn("function entityKindRegistry() {") + "\n" + sliceFn("function entityKindInfo(kind) {") + "\n" +
    sliceFn("function linkFieldForKindName(kind) {") + "\nreturn { entityKindRegistry, entityKindInfo, linkFieldForKindName };"
  );
  const entities = { tasks: {}, organizations: {}, emails: {}, persons: {}, theses: {}, chatgptLeads: {}, passwords: {}, habits: { h1: { id: "h1" } } };
  const r = reg({ state: { data: { entities } } }, () => {}, {}).entityKindRegistry();
  const kinds = new Set(r.map(k => k.kind));
  for (const k of ["task", "project", "organization", "note", "email", "person", "protocol", "workflow", "concept", "thesis", "decision", "meeting", "calendarEvent", "idea", "chatgptNote", "chatgptLead"]) {
    ok(kinds.has(k), `Registry kennt den Typ ${k} nicht`);
  }
  ok(kinds.has("habit") && r.find(k => k.kind === "habit").auto === true, "eine unbekannte Sammlung (habits) wird nicht automatisch als Typ aufgenommen");
  ok(!kinds.has("password"), "Passwoerter sind verknuepfbar — das duerfen sie nicht sein");
  ok(r.find(k => k.kind === "chatgptTask").linkable === false, "ChatGPT-Aufgaben sind als Verknuepfungsziel waehlbar");
  ok(reg({ state: { data: { entities } } }, () => {}, {}).linkFieldForKindName("chatgptLead") === "linkedChatgptLeads", "Feldname fuer Leads stimmt nicht");
  // Und die Stellen, die frueher eigene Listen hatten, lesen jetzt die Registry.
  for (const fn of ["function getEntityMap(kind) {", "function cleanupLinks(deletedKind, deletedId) {", "function renderLinkedEntitiesSection(kind, id) {", "function openLinkModal(srcKind, srcId) {"]) {
    ok(/entityKind(Registry|Info)\(/.test(sliceFn(fn)), `${fn} liest die Registry nicht`);
  }
  ok(/chatgptLead:'chatgptLeads'/.test(index), "Anhaenge kennen chatgptLead nicht (ATTACHMENT_KIND_STORES)");
  // Der spaetere v5-Override von linkEntities lieferte fuer unbekannte Typ-Paare
  // still null (verknuepfte nichts, gab aber true zurueck). Jetzt Rueckfall auf
  // die Konvention linked<Typ>s fuer jeden registrierten Typ.
  const lf = new Function("entityKindInfo", "linkFieldForKindName", sliceFn("function linkFieldForKind(kind, targetKind){") + "\nreturn linkFieldForKind;")(
    (k) => k === "chatgptLead" ? { kind: "chatgptLead", linkable: true } : (k === "chatgptTask" ? { kind: "chatgptTask", linkable: false } : null),
    (k) => "linked" + k.charAt(0).toUpperCase() + k.slice(1) + "s");
  ok(lf("task", "project") === "linkedProjects", "die bestehende Tabelle gilt nicht mehr");
  ok(lf("organization", "chatgptLead") === "linkedChatgptLeads", "ein Lead laesst sich nicht mit einer Organisation verknuepfen (Override liefert null)");
  ok(lf("chatgptLead", "chatgptTask") === null, "ChatGPT-Aufgaben werden als Verknuepfungsziel akzeptiert");
  ok(!/cleanupLinks = function\(deletedKind, deletedId\)\{/.test(index), "cleanupLinks wird noch von der alten Sieben-Typen-Liste ueberschrieben");
}

// ── 5. Zaehler getrennt, Einblendung generisch ─────────────────────────────
{
  const badges = sliceFn("function chatgptModuleBadges() {");
  ok(/chatgptNotesUnreadCount\(\)/.test(badges) && /chatgptLeadsUnreadCount\(\)/.test(badges) && /chatgptTasksOpenCount\(\)/.test(badges), "die Seitenleiste zeigt nicht drei getrennte Zaehler");
  ok(!/n1 \+ n2|n2 \+ n3|n1 \+ n3/.test(badges), "die Zaehler werden summiert");
  ok(/quantusInjectChatgptSections\(mainEl, route, id\);/.test(index), "der ChatGPT-Abschnitt wird nicht generisch in Detailansichten eingeblendet");
  ok(/renderChatgptTaskSection\("gmailMessage", o\.id/.test(index), "Gmail-Nachrichten haben keinen ChatGPT-Abschnitt");
  ok(/renderChatgptTaskSection\("email", id\)/.test(index), "Mail-Hub-Mails haben keinen ChatGPT-Abschnitt");
  ok(/renderChatgptTaskSection\("note", openNote\.id\)/.test(index), "NoteFlow-Notizen haben keinen ChatGPT-Abschnitt");
}

console.log(`sync chatgpt leads+tasks: ok (${checks} Pruefungen)`);
