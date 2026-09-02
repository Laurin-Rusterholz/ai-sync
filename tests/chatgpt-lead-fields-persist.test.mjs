/*
 * P0: Die Freitextfelder eines Leads gingen beim Neuladen verloren.
 *
 * Live-Reproduktion (Lead "Gesamten Chat in ChatGPT Notes nachfuehren"):
 * Interpretation, Recherche, Plan, Begruendung, Ausfuehrung, Ergebnis und
 * Workflow-Notiz ausfuellen, Seite hart neu laden — alle Felder leer,
 * Fortschritt 0/7, "Lead abschliessen" gesperrt.
 *
 * Ursache im Persistenzpfad: der Wert kam NUR ueber das change-Ereignis
 * (Fokusverlust) ins Lead-Objekt. Wer mit fokussiertem Feld neu lud, wessen
 * Browser-Agent .value programmgesteuert setzte, oder wem syncFreshness()
 * die Ansicht im Hintergrund neu zeichnete, verlor den Text — im Modell
 * stand nie etwas, also lasen Fortschritt und Abschluss korrekt "leer".
 *
 * Der Test fuehrt die ECHTEN Funktionen aus: Eingabe (input) → Modell,
 * Commit aus dem DOM ohne Ereignis, "Reload" als JSON-Roundtrip des
 * gespeicherten Stands, danach Fortschritt und Abschluss aus genau diesem
 * Stand. Dazu Quelltextpruefungen fuer die Verdrahtung (input-Listener,
 * pagehide-Flush, Commit vor dem Render).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
function sliceFn(name) {
  const start = index.indexOf(name);
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, `${name} nicht gefunden`);
  // window.-Exporte hinter der Funktion gehoeren nicht zum Testobjekt.
  return index.slice(start, end).replace(/^window\.\w+ = .*$/gm, "");
}
function sliceConst(name) {
  const start = index.indexOf(name);
  ok(start > 0, `${name} nicht gefunden`);
  return index.slice(start, index.indexOf("\n];", start) + 3);
}

// ── Die echten Funktionen ────────────────────────────────────────────────
const saves = [];
const lead = {
  id: "l1", title: "Gesamten Chat nachführen", rawInput: "Bitte alles nachführen.", status: "neu", readAt: null,
  interpretation: "", openQuestions: "", research: "", plan: "", execution: "", result: "", workflowNote: "",
  assignmentReason: "", blockedReason: null, handoverPacket: null,
  assessment: { menge: "chatgpt", werkzeug: "chatgpt", kontext: "chatgpt", quantusNaehe: "chatgpt", recherche: "chatgpt", zuschnitt: "chatgpt" },
  assignee: "chatgpt", linkedOrganizations: ["o1"], createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
};
const APP = { state: { data: { entities: { chatgptLeads: { l1: lead } } } } };
const fns = new Function("APP", "window", "document", "nowIso", "scheduleSaveDebounced", "ownEntity", "CSS",
  sliceConst("const CGL_STEPS = [") + "\n" +
  sliceConst("const CGL_ASSESSMENT = [") + "\n" +
  'const CGL_ASSIGNEES = { chatgpt:"ChatGPT", cowork:"Claude Cowork" };\n' +
  "const CGL_TEXT_FIELDS = " + /const CGL_TEXT_FIELDS = (new Set\(\[[^\]]*\]\));/.exec(index)[1] + ";\n" +
  sliceFn("function chatgptLeadIsTextField(field) {") + "\n" +
  sliceFn("function chatgptLeadApplyField(l, field, value, final) {") + "\n" +
  sliceFn("function chatgptLeadCommitDom(root) {") + "\n" +
  sliceFn("function chatgptLeadAssessmentTally(a) {") + "\n" +
  sliceFn("function chatgptLeadLinkCount(lead) {") + "\n" +
  sliceFn("function chatgptLeadMissing(lead) {") + "\n" +
  sliceFn("function chatgptLeadAssignmentDone(lead) {") + "\n" +
  sliceFn("function chatgptLeadProgress(lead) {") + "\n" +
  "return { chatgptLeadApplyField, chatgptLeadCommitDom, chatgptLeadMissing, chatgptLeadProgress, chatgptLeadIsTextField };"
)(APP, {}, { querySelectorAll: () => [] }, () => "2026-09-02T10:00:00.000Z",
  (key, delay) => saves.push({ key, delay }), (map, id) => map[id] || null, { escape: (s) => s });

// ── 1. Eingabe (input) landet sofort im Lead, gebuendelt gespeichert ──────
{
  const FIELDS = { interpretation: "Alles aus dem Chat übernehmen", research: "Chat-Verlauf durchsucht, nichts fehlt",
    plan: "1. lesen 2. eintragen", assignmentReason: "Wenig Text, viel Quantus — selbst.", execution: "Eingetragen",
    result: "Notes unter #/chatgptnotes", workflowNote: "Immer zuerst Chat lesen", openQuestions: "", blockedReason: "", handoverPacket: "" };
  for (const [f, v] of Object.entries(FIELDS)) {
    if (!v) continue;
    ok(fns.chatgptLeadApplyField(lead, f, v + " ", false) === true, `Eingabe in ${f} wird nicht uebernommen`);
    ok(lead[f] === v + " ", `${f}: waehrend des Tippens wird der Text veraendert (Trim zu frueh)`);
  }
  ok(saves.length >= 7 && saves.every(s => s.key === "cgl-field:l1" && s.delay === 500), "das Speichern beim Tippen ist nicht gebuendelt (scheduleSaveDebounced, 500 ms, ein Schluessel je Lead)");
  ok(lead.readAt === "2026-09-02T10:00:00.000Z" && lead.status === "verstanden", "Lesen/Status werden bei der Eingabe nicht nachgezogen");
  ok(fns.chatgptLeadApplyField(lead, "interpretation", lead.interpretation, false) === false, "ein unveraenderter Wert loest trotzdem eine Speicherung aus");
  ok(fns.chatgptLeadApplyField(lead, "title", "Hack", false) === false && lead.title !== "Hack", "ein fremdes Feld laesst sich ueber cgl-field beschreiben");
  // change = finaler Commit: trimmt und speichert sofort
  const n = saves.length;
  ok(fns.chatgptLeadApplyField(lead, "result", "Notes unter #/chatgptnotes  ", true) === true && lead.result === "Notes unter #/chatgptnotes", "der finale Commit trimmt nicht");
  ok(saves[n] && saves[n].delay === 0, "der finale Commit speichert nicht sofort");
  Object.keys(FIELDS).forEach(f => { if (FIELDS[f]) fns.chatgptLeadApplyField(lead, f, FIELDS[f], true); });
}

// ── 2. Wert ohne jedes Ereignis (.value = …) wird aus dem DOM uebernommen ──
{
  lead.workflowNote = "";
  const dom = { querySelectorAll: (sel) => sel === '[data-action="cgl-field"]'
    ? [{ dataset: { action: "cgl-field", id: "l1", field: "workflowNote" }, value: "Per Skript gesetzt" },
       { dataset: { action: "cgl-field", id: "gibt-es-nicht", field: "plan" }, value: "verloren" },
       { dataset: { action: "cgl-field", id: "l1", field: "plan" }, value: lead.plan }]
    : [] };
  ok(fns.chatgptLeadCommitDom(dom) === 1, "der DOM-Commit uebernimmt nicht genau den einen geaenderten Wert");
  ok(lead.workflowNote === "Per Skript gesetzt", "ein programmgesteuert gesetzter Wert geht beim Commit verloren");
}

// ── 3. "Reload": nur der gespeicherte Stand zaehlt ────────────────────────
{
  const gespeichert = JSON.parse(JSON.stringify(APP.state.data));
  const wieder = gespeichert.entities.chatgptLeads.l1;
  for (const f of ["interpretation", "research", "plan", "assignmentReason", "execution", "result", "workflowNote"]) {
    ok(String(wieder[f] || "").trim().length > 0, `nach dem Reload ist ${f} leer`);
  }
  const p = fns.chatgptLeadProgress(wieder);
  ok(p.done === p.total && p.total === 7, `Fortschritt nach Reload ${p.done}/${p.total} statt 7/7`);
  ok(fns.chatgptLeadMissing(wieder).length === 0, `der Abschluss bleibt gesperrt: ${fns.chatgptLeadMissing(wieder).join(", ")}`);
  // Und ohne die Texte: 0 Schritte, Sperre mit Namen — die Rechnung liest den Datensatz, nichts anderes.
  const leer = { ...wieder, interpretation: "", research: "", plan: "", execution: "", result: "", assignmentReason: "" };
  const q = fns.chatgptLeadProgress(leer);
  ok(q.done === 1, `ohne Texte zaehlt der Fortschritt ${q.done} statt 1 (nur die Verknuepfung)`);
  ok(fns.chatgptLeadMissing(leer).includes("Interpretation") && fns.chatgptLeadMissing(leer).includes("Begründung der Zuweisung"), "die Sperre nennt die leeren Felder nicht");
}

// ── 4. Verdrahtung im Quelltext ───────────────────────────────────────────
{
  ok(/document\.addEventListener\("input", \(e\) => \{\s*const el = e\.target;\s*if \(!el \|\| !el\.dataset \|\| el\.dataset\.action !== "cgl-field"\) return;/.test(index), "es gibt keinen input-Listener fuer cgl-field");
  ok(/window\.addEventListener\("pagehide", chatgptLeadFlushAll\);/.test(index) && /window\.addEventListener\("beforeunload", chatgptLeadFlushAll\);/.test(index) && /if \(document\.hidden\) chatgptLeadFlushAll\(\);/.test(index), "pagehide/beforeunload/visibilitychange flushen die Lead-Eingaben nicht");
  const flush = sliceFn("function chatgptLeadFlushAll() {");
  ok(/chatgptLeadCommitDom\(document\)/.test(flush) && /flushPendingSaves\(\)/.test(flush), "der Flush uebernimmt nicht erst das DOM und holt dann die gebuendelten Speicherungen nach");
  const render = index.slice(index.indexOf("function renderMain() {"), index.indexOf("function quantusInjectAppNoteAction"));
  // Der Commit muss VOR dem Aufbau des HTML laufen (switch (route)), nicht
  // erst vor dem Einsetzen: sonst zeigt die Ansicht den alten Stand, und der
  // naechste Commit (pagehide) schreibt genau diesen alten Stand zurueck.
  const commitPos = render.indexOf("chatgptLeadCommitDom(document.getElementById(\"main\"))"), switchPos = render.indexOf("switch (route) {");
  ok(commitPos > 0 && switchPos > commitPos, "die Lead-Felder werden nicht VOR dem Aufbau der Ansicht aus dem DOM uebernommen");
  ok(/chatgptLeadRestoreFocus\(_cglFocus\)/.test(render), "nach dem Render kehrt der Fokus nicht ins Feld zurueck");
  const change = index.slice(index.indexOf("function chatgptModuleHandleChange(el) {"), index.indexOf('if (action === "cgl-assignee") {'));
  ok(/chatgptLeadApplyField\(l, el\.dataset\.field, el\.value, true\)/.test(change), "change ist nicht mehr der finale Commit ueber denselben Schreibweg");
  ok(/^var _pendingSaves = new Map\(\);/m.test(index) && /function flushPendingSaves\(\)/.test(index), "scheduleSaveDebounced/flushPendingSaves fehlen — die Buendelung haette kein Sicherheitsnetz");
}

console.log(`chatgpt lead fields persist: ok (${checks} Pruefungen)`);
