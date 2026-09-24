/*
 * Zwei Geraete verknuepfen denselben Intake-Eintrag unabhaengig — zwei Leads
 * statt einem. Review PR268 (24.09.2026, Rueckmeldung des App-Besitzers):
 * ---------------------------------------------------------------------------
 * "intake-to-lead" erzeugte den Lead bisher mit createChatgptLead(title,text)
 * → createEntity(...) → uuid() — einer ZUFALLS-ID. Wenn zwei Geraete denselben
 * noch unverknuepften dailyBriefing.intakeQueue-Eintrag verknuepfen, BEVOR
 * eines vom anderen erfahren hat (typischer Offline-Fall), erzeugt jedes
 * Geraet einen eigenen Lead mit einer ANDEREN Zufalls-ID und setzt
 * item.linkedLeadId auf seine eigene. Der intakeQueue-Merge (mergeIntakeById)
 * entscheidet den Sieger nur ueber updatedAt — der VERLIERENDE Lead existiert
 * als Entity trotzdem weiter (Entities werden per id vereinigt, nicht per
 * Verweis darauf, wer "gewonnen" hat): eine Karteileiche, die kein
 * intakeQueue-Eintrag mehr referenziert.
 *
 * Fix: die Lead-ID wird jetzt DETERMINISTISCH aus der intakeId abgeleitet
 * ("chatgptLead_from_" + intakeId) statt zufaellig. Beide Geraete berechnen
 * unabhaengig voneinander DIESELBE ID — der generische, laengst vorhandene
 * Entity-Merge (mergeEntity, nach id) fasst die beiden Fassungen danach zu
 * EINEM Datensatz zusammen, es entsteht nie eine zweite. Existiert der Lead
 * lokal schon (weil ein Zwischen-Sync ihn brachte), wird er nicht neu
 * angelegt — sonst koennte ein spaet nachziehendes Geraet echte, inzwischen
 * begonnene Bearbeitung mit einem leeren Neuanlage-Stand ueberschreiben.
 *
 * Die Tests schneiden die ECHTEN Funktionen (createEntity, createChatgptLead,
 * mergeEntity, entityTimestamp) aus public/index.html heraus und fuehren sie
 * gegen zwei unabhaengige, simulierte Geraete-Zustaende aus.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (bedingung, text) => { assert.ok(bedingung, text); checks++; };
const eq = (a, b, text) => { assert.equal(a, b, text); checks++; };

function funktion(kopfzeile) {
  const a = index.indexOf(kopfzeile);
  ok(a > 0, `nicht gefunden: ${kopfzeile}`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}

const CREATE_ENTITY = funktion("function createEntity(kind, data, forcedId) {");
const CREATE_LEAD = funktion("function createChatgptLead(title, rawInput, forcedId) {");
const DEFAULT_PERMS = funktion("function chatgptLeadDefaultPermissions() {");
const MERGE_ENTITY = funktion("function mergeEntity(local, remote) {");
const ENTITY_TS = funktion("function entityTimestamp(item) {");

// Ein "Geraet": eigener APP-Zustand, eigene chatgptLeads-Map, aber dieselben
// ECHTEN Funktionen. getEntityMap/getEntity/setOwnEntity/uuid/nowIso werden
// bewusst schlank nachgebaut (reine Registry-/Utility-Verdrahtung, nicht der
// gepruefte Fehler) statt der vollen Entity-Registry aus Block 1.
function geraet(uhrzeit) {
  const APP = { state: { data: { entities: { chatgptLeads: {} }, meta: {} } } };
  let zaehler = 0;
  const fn = new Function(
    "APP", "getEntityMap", "setOwnEntity", "getEntity", "uuid", "nowIso", "logActivity", "scheduleSave", "window",
    CREATE_ENTITY + "\n" + CREATE_LEAD + "\n" + DEFAULT_PERMS +
    "\nreturn { createEntity, createChatgptLead };",
  )(
    APP,
    () => APP.state.data.entities.chatgptLeads,
    (map, id, entity) => { map[id] = entity; return entity; },
    (kind, id) => APP.state.data.entities.chatgptLeads[id] || null,
    () => "uuid_zufall_" + (++zaehler),
    () => uhrzeit,
    () => {},
    () => {},
    {},
  );
  return { APP, api: fn };
}

// ── 1. createChatgptLead nutzt eine gegebene forcedId statt Zufall ─────────
{
  const g = geraet("2026-09-24T10:00:00.000Z");
  const id = g.api.createChatgptLead("Titel", "Text", "chatgptLead_from_intake_x");
  eq(id, "chatgptLead_from_intake_x", "createChatgptLead ignoriert die uebergebene forcedId");
  ok(!/uuid_zufall_/.test(id), "createChatgptLead nutzt trotz forcedId eine Zufalls-ID");
  eq(g.APP.state.data.entities.chatgptLeads[id].id, id, "der angelegte Lead traegt nicht die forcedId");
}
// Ohne forcedId bleibt das alte Verhalten (Zufalls-ID) unveraendert.
{
  const g = geraet("2026-09-24T10:00:00.000Z");
  const id = g.api.createChatgptLead("Titel", "Text");
  ok(/^uuid_zufall_/.test(id), "ohne forcedId erzeugt createChatgptLead keine Zufalls-ID mehr — bricht bestehende Aufrufer (Delegation)");
}

// ── 2. Zwei unabhaengige Geraete verknuepfen denselben Intake-Eintrag ──────
// Simuliert exakt den gemeldeten Fall: beide starten mit demselben, noch
// unverknuepften intakeQueue-Eintrag, keins hat vom anderen gehoert.
{
  const intakeId = "intake_abc123";
  const text = "Bitte pruefen: Vertrag XY";
  const leadId = "chatgptLead_from_" + intakeId; // exakt die Formel aus dem Fix

  const geraetA = geraet("2026-09-24T10:00:00.000Z");
  const idA = geraetA.api.createChatgptLead(text.split("\n")[0].slice(0, 80), text, leadId);
  const geraetB = geraet("2026-09-24T10:00:05.000Z"); // 5s spaeter, aber genauso "unwissend"
  const idB = geraetB.api.createChatgptLead(text.split("\n")[0].slice(0, 80), text, leadId);

  eq(idA, idB, "zwei unabhaengige Geraete erzeugen fuer denselben Intake-Eintrag verschiedene Lead-IDs — das ist genau die gemeldete Karteileiche");
  eq(idA, leadId, "die Lead-ID entspricht nicht der deterministischen Formel chatgptLead_from_<intakeId>");

  // ── 3. Der laengst vorhandene, generische Entity-Merge fasst beide zu
  //      EINEM Datensatz zusammen (kein zweiter Lead nach dem Sync) ────────
  const mergeFn = new Function(ENTITY_TS + "\n" + MERGE_ENTITY + "\nreturn mergeEntity;")();
  const leadA = geraetA.APP.state.data.entities.chatgptLeads[idA];
  const leadB = geraetB.APP.state.data.entities.chatgptLeads[idB];
  const gemergt = mergeFn(leadA, leadB);
  eq(gemergt.id, leadId, "der gemergte Lead traegt nicht mehr die gemeinsame id");
  ok(gemergt.updatedAt === leadB.updatedAt, "der zeitlich neuere Stand (Geraet B) haette gewinnen muessen");

  // Ohne den Fix (zwei verschiedene ids) gaebe es hier zwei EINTRAEGE in der
  // Sammlung statt eines gemergten — genau die Karteileiche aus dem Befund.
  const sammlung = {};
  [leadA, leadB].forEach((l) => { sammlung[l.id] = sammlung[l.id] ? mergeFn(sammlung[l.id], l) : l; });
  eq(Object.keys(sammlung).length, 1, "nach dem Zusammenfuehren existiert mehr als ein Lead fuer denselben Intake-Eintrag");
}

// ── 4./5. Der echte Handler-Quelltext: deterministische Formel, kein
// unbedingtes Neuanlegen, forcedId wird tatsaechlich durchgereicht ─────────
{
  const start = index.indexOf('case "intake-to-lead": {');
  ok(start > 0, 'case "intake-to-lead" wurde nicht gefunden');
  const ende = index.indexOf('\ncase "slide-delete-task"', start);
  ok(ende > start, "Ende von case intake-to-lead nicht bestimmbar (naechster case-Marker verschoben)");
  const src = index.slice(start, ende);
  ok(/const leadId = "chatgptLead_from_" \+ intakeId;/.test(src),
    "intake-to-lead berechnet die Lead-ID nicht mehr deterministisch aus der intakeId");
  ok(/item\.linkedLeadId = leadId;/.test(src), "intake-to-lead verknuepft nicht die deterministische leadId");
  ok(/if \(!getEntity\("chatgptLead", leadId\)\)/.test(src),
    "intake-to-lead legt einen bereits vorhandenen Lead trotzdem neu an — riskiert das Ueberschreiben echter Bearbeitung");
  ok(/createChatgptLead\([^;]*, leadId\);/.test(src),
    "createChatgptLead wird nicht mit der deterministischen leadId als drittem Argument aufgerufen — die Zufalls-ID-Luecke besteht fort");
}

console.log(`chatgpt-intake-lead-race: ok (${checks} Pruefungen)`);
