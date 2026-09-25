/*
 * Zwei Geraete delegieren dieselbe Aufgabe unabhaengig an ChatGPT — zwei Leads
 * statt einem, trotz task.delegatedLeadId. Review-Punkt (25.09.2026,
 * Rueckmeldung des App-Besitzers, zusaetzlich zu PR269):
 * ---------------------------------------------------------------------------
 * "task-delegate-chatgpt" erzeugte den Lead bisher mit
 * createChatgptLead(task.title, "Delegierte Aufgabe: " + task.title) — OHNE
 * forcedId, also mit einer ZUFALLS-ID (uuid() in createEntity). Delegieren
 * zwei offline Geraete dieselbe, noch nicht delegierte Aufgabe, BEVOR eines
 * vom anderen erfahren hat, erzeugt jedes Geraet einen eigenen Lead mit einer
 * ANDEREN Zufalls-ID und setzt task.delegatedLeadId auf seine eigene. Der
 * generische Entity-Merge fuehrt zwar die Aufgabe (per id) zusammen — aber
 * delegatedLeadId ist nur ein SKALARES Feld, kein Merge-Zweig mit eigener
 * Union-Logik: der Sieger (neuerer updatedAt-Zeitstempel der Aufgabe) behaelt
 * seine eigene delegatedLeadId, der VERLIERENDE Lead existiert als Entity
 * trotzdem weiter — eine Karteileiche, die keine Aufgabe mehr referenziert.
 * Exakt dieselbe Fehlerklasse wie bei "intake-to-lead" (siehe
 * chatgpt-intake-lead-race.test.mjs, dort bereits behoben).
 *
 * Fix: dieselbe deterministische-ID-Formel, jetzt fuer Aufgaben:
 * "chatgptLead_from_task_" + taskId statt einer Zufalls-ID. Beide Geraete
 * berechnen unabhaengig voneinander DIESELBE ID — der laengst vorhandene,
 * generische Entity-Merge (mergeEntity, nach id) fasst die beiden Fassungen
 * zu EINEM Datensatz zusammen. Existiert der Lead lokal schon (z. B. weil ein
 * Zwischen-Sync ihn brachte, oder aus einer frueheren Delegation derselben
 * Aufgabe), wird er nicht neu angelegt — sonst koennte ein spaet
 * nachziehendes Geraet echte, inzwischen begonnene Bearbeitung mit einem
 * leeren Neuanlage-Stand ueberschreiben.
 *
 * Die Tests schneiden die ECHTEN Funktionen (createEntity, createChatgptLead,
 * mergeEntity, entityTimestamp) sowie den echten case-"task-delegate-chatgpt"-
 * Quelltext aus public/index.html heraus.
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
// ECHTEN Funktionen — dasselbe schlanke Nachbau-Muster wie in
// chatgpt-intake-lead-race.test.mjs (Registry/Utility-Verdrahtung, nicht der
// gepruefte Fehler).
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

// ── 1. Zwei unabhaengige Geraete delegieren dieselbe Aufgabe ───────────────
// Simuliert exakt den gemeldeten Fall: beide starten mit derselben, noch
// nicht delegierten Aufgabe, keins hat vom anderen gehoert.
{
  const taskId = "task_xyz789";
  const titel = "Vertrag mit Firma X pruefen";
  const leadId = "chatgptLead_from_task_" + taskId; // exakt die Formel aus dem Fix

  const geraetA = geraet("2026-09-25T10:00:00.000Z");
  const idA = geraetA.api.createChatgptLead(titel, "Delegierte Aufgabe: " + titel, leadId);
  const geraetB = geraet("2026-09-25T10:00:05.000Z"); // 5s spaeter, aber genauso "unwissend"
  const idB = geraetB.api.createChatgptLead(titel, "Delegierte Aufgabe: " + titel, leadId);

  eq(idA, idB, "zwei unabhaengige Geraete erzeugen fuer dieselbe delegierte Aufgabe verschiedene Lead-IDs — das ist genau die gemeldete Karteileiche");
  eq(idA, leadId, "die Lead-ID entspricht nicht der deterministischen Formel chatgptLead_from_task_<taskId>");

  // ── 2. Der laengst vorhandene, generische Entity-Merge fasst beide zu
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
  eq(Object.keys(sammlung).length, 1, "nach dem Zusammenfuehren existiert mehr als ein Lead fuer dieselbe delegierte Aufgabe");
}

// ── 3. Der echte Handler-Quelltext: deterministische Formel, kein
//      unbedingtes Neuanlegen, forcedId wird tatsaechlich durchgereicht ────
{
  const start = index.indexOf('case "task-delegate-chatgpt": {');
  ok(start > 0, 'case "task-delegate-chatgpt" wurde nicht gefunden');
  const ende = index.indexOf('\ncase "intake-to-lead"', start);
  ok(ende > start, "Ende von case task-delegate-chatgpt nicht bestimmbar (naechster case-Marker verschoben)");
  const src = index.slice(start, ende);
  ok(/const leadId = "chatgptLead_from_task_" \+ taskId;/.test(src),
    "task-delegate-chatgpt berechnet die Lead-ID nicht mehr deterministisch aus der taskId");
  ok(/delegatedLeadId: leadId/.test(src), "task-delegate-chatgpt verknuepft die Aufgabe nicht mit der deterministischen leadId");
  ok(/lead = getEntity\("chatgptLead", leadId\);\s*\n\s*if \(!lead\) \{/.test(src),
    "task-delegate-chatgpt legt einen bereits vorhandenen Lead trotzdem neu an — riskiert das Ueberschreiben echter Bearbeitung");
  ok(/createChatgptLead\([^;]*, leadId\);/.test(src),
    "createChatgptLead wird nicht mit der deterministischen leadId als drittem Argument aufgerufen — die Zufalls-ID-Luecke besteht fort");
}

console.log(`chatgpt-task-delegation-lead-race: ok (${checks} Pruefungen)`);
