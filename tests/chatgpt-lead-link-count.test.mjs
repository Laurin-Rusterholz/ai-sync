/*
 * P0: Verknuepfung sichtbar, Abschluss meldet trotzdem "mindestens eine
 * Verknuepfung" (Lead "Gesamten Chat in ChatGPT Notes nachfuehren",
 * Fortschritt 6/7, Chip "Quantus ChatGPT Notes — Ergebnis des vol…").
 *
 * Der Chip ist ein EXTERNER Link (die Anzeige kuerzt Labels auf 40 Zeichen —
 * genau die Laenge des sichtbaren Textes). chatgptLeadLinkCount() zaehlte nur
 * linked<Typ>s-Arrays am Lead: externe Links nicht, von Firebase als Objekt
 * gelieferte Arrays nicht, und einseitige Alt-Verknuepfungen (Gegenseite
 * fuehrt den Lead in linkedChatgptLeads, der Lead kennt sie nicht — Stand vor
 * dem linkFieldForKind-Rueckfall) auch nicht. Fortschritt und Sperre lasen
 * folgerichtig 0.
 *
 * Der Test fuehrt die ECHTE Zaehlung samt Sperre und Fortschritt aus.
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
  return index.slice(start, end).replace(/^window\.\w+ = .*$/gm, "");
}
function sliceConst(name) {
  const start = index.indexOf(name);
  ok(start > 0, `${name} nicht gefunden`);
  return index.slice(start, index.indexOf("\n];", start) + 3);
}
function load(APP) {
  return new Function("APP", "window",
    sliceConst("const CGL_STEPS = [") + "\n" + sliceConst("const CGL_ASSESSMENT = [") + "\n" +
    'const CGL_ASSIGNEES = { chatgpt:"ChatGPT", cowork:"Claude Cowork" };\n' +
    sliceFn("function chatgptLeadIdList(v) {") + "\n" + sliceFn("function chatgptLeadBacklinkCount(lead) {") + "\n" +
    sliceFn("function chatgptLeadLinkCount(lead) {") + "\n" + sliceFn("function chatgptLeadAssessmentTally(a) {") + "\n" +
    sliceFn("function chatgptLeadMissing(lead) {") + "\n" + sliceFn("function chatgptLeadAssignmentDone(lead) {") + "\n" +
    sliceFn("function chatgptLeadProgress(lead) {") + "\nreturn { chatgptLeadLinkCount, chatgptLeadMissing, chatgptLeadProgress };"
  )(APP, {});
}
const voll = () => ({
  id: "l1", title: "Gesamten Chat in ChatGPT Notes nachführen", rawInput: "…", status: "in_arbeit",
  interpretation: "a", research: "b", plan: "c", execution: "d", result: "e", workflowNote: "f",
  assessment: { menge: "chatgpt", werkzeug: "chatgpt", kontext: "chatgpt", quantusNaehe: "chatgpt", recherche: "chatgpt", zuschnitt: "chatgpt" },
  assignee: "chatgpt", assignmentReason: "selbst",
});

// ── 1. DER BEFUND: nur ein externer Link ──────────────────────────────────
{
  const fns = load({ state: { data: { entities: { chatgptLeads: {} } } } });
  const l = { ...voll(), externalLinks: [{ id: "x1", url: "#/chatgptnotes", label: "Quantus ChatGPT Notes — Ergebnis des vollständigen Nachtrags" }] };
  ok(fns.chatgptLeadLinkCount(l) === 1, "ein sichtbarer externer Link wird nicht als Verknuepfung gezaehlt");
  const p = fns.chatgptLeadProgress(l);
  ok(p.done === 7 && p.total === 7, `Fortschritt ${p.done}/${p.total} statt 7/7`);
  ok(fns.chatgptLeadMissing(l).length === 0, `Abschluss bleibt gesperrt: ${fns.chatgptLeadMissing(l).join(", ")}`);
  // Ein externer Link ohne URL zaehlt nicht (leere Eingabe ist keine Verknuepfung).
  ok(fns.chatgptLeadLinkCount({ ...voll(), externalLinks: [{ id: "x2", url: "  ", label: "leer" }] }) === 0, "ein externer Link ohne URL zaehlt");
}
// ── 2. Firebase liefert Arrays als Objekt ──────────────────────────────────
{
  const fns = load({ state: { data: { entities: { chatgptLeads: {} } } } });
  ok(fns.chatgptLeadLinkCount({ ...voll(), linkedOrganizations: { 0: "o1" } }) === 1, "ein als Objekt gespeichertes linked-Feld zaehlt nicht");
  ok(fns.chatgptLeadLinkCount({ ...voll(), linkedOrganizations: ["o1"], linkedChatgptNotes: ["n1", "n2"] }) === 3, "mehrere linked-Felder werden nicht summiert");
}
// ── 3. Einseitige Alt-Verknuepfung von der Gegenseite ─────────────────────
{
  const APP = { state: { data: { entities: {
    chatgptLeads: { l1: voll() },
    chatgptNotes: { n1: { id: "n1", instruction: "Quantus ChatGPT Notes — Ergebnis", linkedChatgptLeads: ["l1"] } },
    tasks: { t1: { id: "t1", linkedChatgptLeads: { 0: "l1" } } },
    organizations: { o1: { id: "o1", linkedChatgptLeads: ["anderer"] } },
  } } } };
  const fns = load(APP);
  ok(fns.chatgptLeadLinkCount(APP.state.data.entities.chatgptLeads.l1) === 2, "Rueckverweise anderer Elemente (linkedChatgptLeads) werden nicht gezaehlt");
  ok(fns.chatgptLeadMissing(APP.state.data.entities.chatgptLeads.l1).length === 0, "trotz Rueckverweis bleibt der Abschluss gesperrt");
  // Ohne jede Verknuepfung bleibt die Sperre — die Lockerung darf nichts durchwinken.
  const leer = load({ state: { data: { entities: { chatgptLeads: {}, organizations: { o1: { id: "o1", linkedChatgptLeads: ["anderer"] } } } } } });
  ok(leer.chatgptLeadLinkCount(voll()) === 0 && leer.chatgptLeadMissing(voll()).includes("mindestens eine Verknüpfung"), "ohne Verknuepfung ist der Lead abschliessbar");
  // Auch ohne APP (reine Funktion, z.B. in anderen Tests) faellt nichts um.
  ok(load(undefined).chatgptLeadLinkCount(voll()) === 0, "ohne APP wirft die Zaehlung");
}
console.log(`chatgpt lead link count: ok (${checks} Pruefungen)`);
