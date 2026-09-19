/*
 * Tagesbriefing v3 — der serverseitige Datenkern, gegen eine gestellte Uhr.
 * ---------------------------------------------------------------------------
 * AUFTRAG (19.09.2026, Paket 1): gemeinsamer Datenkern unter netlify/lib,
 * Migration, reine Ampel- und Abschlusslogik. Kein Netz, kein Firebase, kein
 * Provider, keine Client-Aenderung. Alles Aeussere (Uhr, Ids, Policy) kommt
 * als Parameter herein — der Test faehrt die ECHTEN Funktionen.
 *
 * Was hier festgenagelt wird (Auswahl aus T01–T40, soweit dieses Paket sie
 * traegt):
 *   · Migration idempotent, fremde Felder und _deleteLog bleiben, unbekannte
 *     Altstatus werden sichtbar markiert (nicht stumm "done")
 *   · fehlender/kaputter Kern ist ein Fehler, kein leerer Bestand
 *   · ein ausgelassener Lead oder eine nicht geprüfte Quelle kann nicht gruen werden
 *   · unvollstaendiges Warten (ohne Gegenpartei/nextAction/followUpAt/Evidenz)
 *     ist nicht gruen; Eigenarbeit ist kein waiting_external
 *   · drei Verschiebungen ohne anerkannten Fortschritt sind rot — auch wenn
 *     dazwischen Titel, Kommentare, Zuweisung geaendert wurden
 *   · eine Statusbehauptung des Agenten (overallGreen, operationalState:done)
 *     zaehlt nicht
 *   · Abschluss: erst ab 23:00 Zuerich, nur mit Quittungen 09 und 23, nur bei
 *     gruener Ampel; atomar mit GENAU EINER Finalnotiz; Wiederholung idempotent
 *   · Folge-Widerspruch invalidiert append-only, die Finalnotiz bleibt
 *     byteidentisch; neuer Eingang danach ist kein Widerspruch
 *   · Sommer-/Winterzeit: eindeutige Slots und stabile Slot-Schluessel
 *   · Antworten unveraenderlich und genau einmal konsumierbar
 *   · unlesbare Dokumente bleiben offen, nie "verarbeitet"
 *   · Spezialistenrueckgabe → review, nie done
 *   · Schutzfelder kommen durch kein Kommando in den Kern
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as K from "../netlify/lib/assistant-core.mjs";

const T = (s) => Date.parse(s);
const MIN = 60 * 1000;
const STD = 60 * MIN;

const POLICY = Object.freeze({
  ...K.POLICY_TEMPLATE,
  tenant: "laurin",
  requiredSources: [{ id: "gmail-inbox", kind: "mail" }, { id: "gcal-heute", kind: "calendar" }],
});

/* Ein kleiner, aber echter Quantus-Bestand: zwei Leads, eine ChatGPT-Aufgabe,
 * zwei Aufgaben, ein Projekt mit Frist, fremde Bereiche, ein Grabstein-Log. */
function bestand() {
  const t0 = "2026-09-18T10:00:00.000Z";
  return {
    entities: {
      tasks: {
        t1: { id: "t1", title: "Rechnung zahlen", status: "todo", dueDate: "2026-09-19", createdAt: t0, updatedAt: t0, comments: [] },
        t2: { id: "t2", title: "Spaeter", status: "todo", dueDate: "2026-10-30", createdAt: t0, updatedAt: t0, comments: [] },
      },
      projects: { p1: { id: "p1", title: "Umzug", status: "active", deadlines: [{ id: "d1", title: "Kuendigung", date: "2026-09-10", done: true }], createdAt: t0, updatedAt: t0 } },
      notes: {},
      chatgptLeads: {
        l1: { id: "l1", title: "Kunden anlegen", rawInput: "…", status: "in_arbeit", readAt: t0, assignee: "chatgpt", createdAt: t0, updatedAt: t0, comments: [] },
        l2: { id: "l2", title: "Alt", rawInput: "…", status: "abgeschlossen", readAt: t0, closedAt: t0, closedBy: "assistant", assignee: "chatgpt", createdAt: t0, updatedAt: t0, comments: [] },
      },
      chatgptTasks: {
        c1: { id: "c1", text: "Namen ergaenzen", state: "offen", anchorKind: "organization", anchorId: "o1", createdAt: t0, updatedAt: t0 },
      },
    },
    journal: { documents: [{ id: "j1", content: "bleibt" }] },
    mobilePushes: [{ id: "mp1" }],
    dailyBriefing: { routines: [{ id: "r1", text: "Wasser" }], dailyLog: { "2026-09-18": { notes: "x" } } },
    _deleteLog: { tasks: { t9: 1758000000000 } },
    fremdesFeld: { a: 1 },
  };
}

const NOW = T("2026-09-19T08:00:00+02:00");   // Samstag 08:00 Zuerich

function migriert(d = bestand()) {
  return K.migrateCore(d, { now: NOW }).data;
}

let cmdN = 0;
function cmd(type, payload, now) {
  return { type, commandId: "cmd_" + String(++cmdN).padStart(8, "0"), now, payload };
}
function run(data, type, payload, now) {
  const r = K.applyCommand(data, cmd(type, payload, now), { policy: POLICY });
  return r;
}
function mussOk(r, was) {
  assert.equal(r.ok, true, `${was}: ${r.error} ${JSON.stringify(r.detail)}`);
  return r.data;
}
const codes = (ev) => ev.reasons.map((r) => r.code);
const hatCode = (ev, code, id) => ev.reasons.some((r) => r.code === code && (id == null || r.sourceId === id));

/* Einen Tag bis kurz vor 23:00 fahren: Lauf, Startnotiz, Quittungen 04/09/14/23,
 * Quellen frisch, alle offenen Elemente im Lauf. Liefert Bestand + Zeit. */
function tagAufbauen(data, { date = "2026-09-19", bis = "23:05" } = {}) {
  const [h, m] = bis.split(":").map(Number);
  const now = K.wandzeitZuMs(date, h, m);
  data = mussOk(run(data, "ensureRun", { date }, K.slotBeginnMs(date, "briefing04") + MIN), "ensureRun");
  data = mussOk(run(data, "ensureStartNote", { date, noteId: "note_start_" + date }, K.slotBeginnMs(date, "briefing04") + 2 * MIN), "start");
  for (const s of K.SLOT_KEYS) {
    const at = K.slotBeginnMs(date, s) + MIN;
    if (at > now) continue;
    data = mussOk(run(data, "recordSlotReceipt", { date, slot: s, receiptId: "rcpt_" + s + "_" + date }, at), "receipt " + s);
  }
  for (const s of POLICY.requiredSources) {
    data = mussOk(run(data, "recordSourceCheck", { date, sourceId: s.id, cursor: "c1", outcome: "ok" }, now - 3 * MIN), "source " + s.id);
  }
  for (const [sourceType, q] of Object.entries(K.QUELLEN)) {
    for (const id of Object.keys(data.entities[q.store] || {})) {
      const z = K.effektiverZustand(sourceType, data.entities[q.store][id]);
      if (z.state === "done" || z.state === "cancelled") continue;
      data = mussOk(run(data, "addItemRef", { date, sourceType, sourceId: id }, now - 2 * MIN), "ref " + id);
    }
  }
  return { data, now, date };
}

/* Alle offenen Elemente "erledigen", so wie es die Oberflaeche taete (Altstatus). */
function allesErledigen(data, at) {
  data = K.klon(data);
  const iso = new Date(at).toISOString();
  for (const l of Object.values(data.entities.chatgptLeads)) if (l.status !== "abgeschlossen") { l.status = "abgeschlossen"; l.closedAt = iso; l.closedBy = "assistant"; l.updatedAt = iso; }
  for (const c of Object.values(data.entities.chatgptTasks)) if (c.state !== "erledigt") { c.state = "erledigt"; c.resolvedAt = iso; c.updatedAt = iso; }
  for (const t of Object.values(data.entities.tasks)) if (t.dueDate && t.dueDate <= "2026-09-19" && t.status !== "done") { t.status = "done"; t.updatedAt = iso; }
  return data;
}

/* ══ Kern lesen: fehlend oder kaputt ist ein Fehler ══════════════════════ */
test("fehlender oder kaputter Kern ist ein Fehler, kein leerer Bestand", () => {
  assert.throws(() => K.parseCoreDocument(null), /CORE_MISSING|Kernbestand fehlt/);
  assert.throws(() => K.parseCoreDocument({ exists: false, data: null }), (e) => e.code === "CORE_MISSING");
  assert.throws(() => K.parseCoreDocument({ exists: true, data: "{nicht json" }), (e) => e.code === "CORE_UNPARSEABLE");
  assert.throws(() => K.parseCoreDocument({ exists: true, data: JSON.stringify({ irgendwas: 1 }) }), (e) => e.code === "CORE_NO_ENTITIES");
  assert.throws(() => K.parseCoreDocument("[]"), (e) => e.code === "CORE_SHAPE");
  const p = K.parseCoreDocument({ exists: true, data: JSON.stringify(bestand()) });
  assert.equal(Object.keys(p.entities.chatgptLeads).length, 2);
  assert.throws(() => K.requireCore(bestand()), (e) => e.code === "CORE_NOT_MIGRATED");
  assert.throws(() => K.migrateCore(bestand(), {}), TypeError);
});

/* ══ T: Migration idempotent, fremde Felder und _deleteLog bleiben ═══════ */
test("Migration ist idempotent und laesst Fremdes und _deleteLog unberuehrt", () => {
  const original = bestand();
  const vorher = JSON.stringify(original);
  const m1 = K.migrateCore(original, { now: NOW });
  assert.equal(JSON.stringify(original), vorher, "die Eingabe wurde veraendert");
  assert.equal(m1.changed, true);
  assert.equal(m1.data.automation.schemaVersion, K.SCHEMA_VERSION);
  assert.deepEqual(m1.data.dailyBriefing.assistantRuns, {});
  assert.deepEqual(m1.data._deleteLog, original._deleteLog);
  assert.deepEqual(m1.data.fremdesFeld, original.fremdesFeld);
  assert.deepEqual(m1.data.journal, original.journal);
  assert.deepEqual(m1.data.mobilePushes, original.mobilePushes);
  assert.deepEqual(m1.data.dailyBriefing.routines, original.dailyBriefing.routines);
  assert.deepEqual(m1.data.dailyBriefing.dailyLog, original.dailyBriefing.dailyLog);
  for (const k of ["intakeById", "questionsById", "answersById", "documentsById", "jobsById", "outboxById", "idempotencyByKey", "sourceCursors"]) {
    assert.deepEqual(m1.data.automation[k], {}, k);
  }
  assert.equal(m1.data.automation.activeLease, null);
  assert.equal(m1.data.automation.policyRef, null);

  // Zweiter Lauf, andere Uhr: byteidentisch.
  const m2 = K.migrateCore(m1.data, { now: NOW + 5 * STD });
  assert.equal(m2.changed, false);
  assert.equal(JSON.stringify(m2.data), JSON.stringify(m1.data));

  // Vorhandene, gleichwertige Struktur wird wiederverwendet, nicht ersetzt.
  const mitAutomation = bestand();
  mitAutomation.automation = { schemaVersion: 3, dataRevision: 7, intakeById: { i1: { id: "i1", status: "open", text: "x" } }, eigenes: true };
  const m3 = K.migrateCore(mitAutomation, { now: NOW });
  assert.equal(m3.data.automation.dataRevision, 7);
  assert.equal(m3.data.automation.intakeById.i1.text, "x");
  assert.equal(m3.data.automation.eigenes, true);
  assert.ok(m3.data.automation.questionsById);
});

test("Altstatus werden semantisch gemappt; Unbekanntes bleibt sichtbar unmapped", () => {
  const d = bestand();
  d.entities.chatgptLeads.l3 = { id: "l3", status: "irgendwas_altes", readAt: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
  d.entities.chatgptLeads.l4 = { id: "l4", status: "in_arbeit", readAt: "2026-09-01T00:00:00Z", assignee: "cowork", handoverAt: "2026-09-02T00:00:00Z", returnedAt: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
  d.entities.chatgptLeads.l5 = { ...d.entities.chatgptLeads.l4, id: "l5", returnedAt: "2026-09-03T00:00:00Z" };
  d.entities.chatgptLeads.l6 = { id: "l6", status: "abgeschlossen", closedBy: "laurin", obsoleteReason: "hinfaellig", readAt: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
  d.entities.tasks.t3 = { id: "t3", status: "waiting", title: "Antwort Amt" };
  d.entities.tasks.t4 = { id: "t4", status: "bizarr", title: "?" };
  d.entities.chatgptTasks.c2 = { id: "c2", state: "wartet", blockedReason: "fehlt Name" };
  const m = K.migrateCore(d, { now: NOW });
  const L = m.data.entities.chatgptLeads;
  assert.equal(L.l1.operationalState, "doing");
  assert.equal(L.l2.operationalState, "done");
  assert.equal(L.l3.operationalState, null);
  assert.equal(L.l3.operationalStateUnmapped, true);
  assert.equal(L.l4.operationalState, "delegated");
  assert.equal(L.l5.operationalState, "review");
  assert.equal(L.l6.operationalState, "cancelled");
  assert.equal(m.data.entities.tasks.t1.operationalState, "doing");
  assert.equal(m.data.entities.tasks.t3.operationalState, "waiting_external");
  assert.equal(m.data.entities.tasks.t4.operationalState, null);
  assert.equal(m.data.entities.chatgptTasks.c2.operationalState, "waiting_user");
  assert.deepEqual(m.data.automation.migration.unknownStates.map((u) => u.sourceId).sort(), ["l3", "t4"]);
  assert.deepEqual(m.report.unknownStates.map((u) => u.legacyValue).sort(), ["bizarr", "irgendwas_altes"]);
  // Der Altstatus bleibt das Feld der Oberflaeche: nichts wurde umbenannt.
  assert.equal(L.l4.status, "in_arbeit");
  assert.equal(m.data.entities.tasks.t3.status, "waiting");
  // Regulaere Aufgaben behalten ihren Assignee, KI-Leads bekommen Rollen.
  assert.deepEqual(K.rollenFuer("task", { assignee: "Anna" }), { accountable: "user", executor: "user" });
  assert.deepEqual(K.rollenFuer("chatgptLead", { assignee: "cowork" }), { accountable: "chatgpt", executor: "claude" });
  assert.deepEqual(K.rollenFuer("chatgptLead", { assignee: "chatgpt" }), { accountable: "chatgpt", executor: "openai" });
  // Unbekannter Altstatus: Ampel rot mit Quell-Id, Zustandswechsel verweigert.
  const ev = K.dailyAssistantTrafficLight(K.leererRun("2026-09-19", "3.0"), m.data, NOW, POLICY);
  assert.ok(hatCode(ev, "UNKNOWN_LEGACY_STATE", "l3"));
  assert.ok(hatCode(ev, "UNKNOWN_LEGACY_STATE", "t4"));
  const r = run(m.data, "transitionState", { sourceType: "chatgptLead", sourceId: "l3", state: "review" }, NOW);
  assert.equal(r.ok, false); assert.equal(r.error, "UNKNOWN_LEGACY_STATE");
  // Client aendert den Altstatus nachtraeglich → Altstatus gewinnt, nicht das alte Mapping.
  const geaendert = K.klon(m.data);
  geaendert.entities.chatgptLeads.l3.status = "in_arbeit";
  assert.equal(K.effektiverZustand("chatgptLead", geaendert.entities.chatgptLeads.l3).state, "doing");
  const m2 = K.migrateCore(geaendert, { now: NOW + STD });
  assert.equal(m2.data.entities.chatgptLeads.l3.operationalState, "doing");
  assert.equal(m2.data.entities.chatgptLeads.l3.operationalStateUnmapped, undefined);
  assert.deepEqual(m2.data.automation.migration.unknownStates.map((u) => u.sourceId), ["t4"]);
});

/* ══ Policy: vollstaendig oder gar nicht ═════════════════════════════════ */
test("fehlende Policy oder Quellenkonfiguration ist nie gruen", () => {
  const d = migriert(allesErledigen(bestand(), NOW));
  const r = K.leererRun("2026-09-19", "3.0");
  assert.equal(K.validatePolicy(K.POLICY_TEMPLATE).ok, false, "die Vorlage ohne Quellen darf nicht gueltig sein");
  assert.ok(K.validatePolicy(K.POLICY_TEMPLATE).errors.includes("POLICY_SOURCES_NOT_CONFIGURED"));
  assert.equal(K.validatePolicy(POLICY).ok, true);
  for (const p of [null, {}, { ...POLICY, requiredSources: undefined }, { ...POLICY, timezone: "UTC" }, { ...POLICY, featureFlags: { writes: "yolo", runner: "dry_run", providers: "dry_run" } }]) {
    const ev = K.dailyAssistantTrafficLight(r, d, NOW, p);
    assert.equal(ev.operations, "red");
    assert.ok(hatCode(ev, "POLICY_INCOMPLETE"));
  }
  const ev = K.dailyAssistantTrafficLight(null, d, NOW, POLICY);
  assert.ok(hatCode(ev, "RUN_MISSING"));
  assert.equal(ev.overall, "red");
  assert.equal(K.applyCommand(d, cmd("ensureRun", { date: "2026-09-19" }, NOW), { policy: null }).error, "POLICY_INVALID");
  assert.equal(POLICY.featureFlags.writes, "dry_run");
  assert.equal(POLICY.featureFlags.runner, "dry_run");
  assert.equal(POLICY.featureFlags.providers, "dry_run");
});

/* ══ T: ausgelassener Lead / nicht geprüfte Seite ═══════════════════════ */
test("ein ausgelassener Lead oder eine nicht geprüfte Quelle kann nicht gruen werden", () => {
  let { data, now, date } = tagAufbauen(migriert(allesErledigen(bestand(), NOW)));
  let ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  assert.equal(ev.operations, "green", JSON.stringify(ev.reasons));

  // Ein Lead taucht auf, den der Lauf nicht kennt (nicht in itemRefs) — der volle Bestand zaehlt.
  const mitLead = K.klon(data);
  mitLead.entities.chatgptLeads.l7 = { id: "l7", title: "Vergessen", rawInput: "…", status: "in_arbeit", readAt: "2026-09-19T10:00:00Z", assignee: "chatgpt", createdAt: "2026-09-19T10:00:00Z", updatedAt: "2026-09-19T10:00:00Z" };
  ev = K.dailyAssistantTrafficLight(mitLead.dailyBriefing.assistantRuns[date], mitLead, now, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "ITEM_NOT_IN_RUN", "l7"));
  assert.ok(hatCode(ev, "ITEM_OPEN", "l7"));
  // Ein ungelesener Lead ist ungeklaerter Eingang.
  mitLead.entities.chatgptLeads.l7.readAt = null;
  ev = K.dailyAssistantTrafficLight(mitLead.dailyBriefing.assistantRuns[date], mitLead, now, POLICY);
  assert.ok(hatCode(ev, "INTAKE_UNCLARIFIED", "l7"));

  // Eine erforderliche Quelle ohne Pruefung → Betrieb rot, mit Quell-Id.
  const ohneQuelle = K.klon(data);
  delete ohneQuelle.dailyBriefing.assistantRuns[date].sourceChecks["gcal-heute"];
  delete ohneQuelle.automation.sourceCursors["gcal-heute"];
  ev = K.dailyAssistantTrafficLight(ohneQuelle.dailyBriefing.assistantRuns[date], ohneQuelle, now, POLICY);
  assert.equal(ev.operations, "red");
  assert.ok(hatCode(ev, "SOURCE_NOT_CHECKED", "gcal-heute"));

  // Eine Quelle, die aelter als 15 Minuten ist → rot; Stoerungen sind benannt.
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 20 * MIN, POLICY);
  assert.ok(hatCode(ev, "SOURCE_STALE", "gmail-inbox"));
  for (const [outcome, code] of [["auth_error", "SOURCE_AUTH_ERROR"], ["budget_exceeded", "SOURCE_BUDGET_EXCEEDED"], ["unreachable", "SOURCE_UNREACHABLE"]]) {
    const g = mussOk(run(data, "recordSourceCheck", { date, sourceId: "gmail-inbox", cursor: "c2", outcome }, now), outcome);
    const e2 = K.dailyAssistantTrafficLight(g.dailyBriefing.assistantRuns[date], g, now, POLICY);
    assert.equal(e2.operations, "red");
    assert.ok(hatCode(e2, code, "gmail-inbox"), code);
  }
  // Eine faellige Projektfrist zaehlt ebenfalls.
  const mitFrist = K.klon(data);
  mitFrist.entities.projects.p1.deadlines.push({ id: "d2", title: "Schluessel abgeben", date: "2026-09-19", done: false });
  ev = K.dailyAssistantTrafficLight(mitFrist.dailyBriefing.assistantRuns[date], mitFrist, now, POLICY);
  assert.ok(hatCode(ev, "PROJECT_DEADLINE_DUE", "p1"));
  // Die Bewertung nennt Revision, Zeitpunkt und Gueltigkeit.
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.equal(ev.evaluatedRevision, data.automation.dataRevision);
  assert.equal(ev.evaluatedAt, new Date(now).toISOString());
  const bis = Date.parse(ev.validUntil);
  assert.ok(bis > now && bis <= now + 15 * MIN, "validUntil nicht laenger als die frischeste Quelle");
});

/* ══ Alte Offlineansicht ist nicht aktuell gruen ═════════════════════════ */
test("eine gespeicherte Bewertung gilt nur bis validUntil und nur fuer denselben Bestand", () => {
  const { data, now, date } = tagAufbauen(migriert(allesErledigen(bestand(), NOW)));
  const ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.equal(ev.overall, "green");
  assert.equal(K.isEvaluationCurrent(ev, data, now + MIN).current, true);
  assert.equal(K.isEvaluationCurrent(ev, data, Date.parse(ev.validUntil)).reason, "EVALUATION_EXPIRED");
  const geaendert = K.klon(data);
  geaendert.entities.chatgptLeads.l1.status = "in_arbeit";
  geaendert.entities.chatgptLeads.l1.updatedAt = new Date(now + MIN).toISOString();
  assert.equal(K.isEvaluationCurrent(ev, geaendert, now + MIN).reason, "DATA_CHANGED");
  const mutiert = mussOk(run(data, "registerIntake", { intakeId: "in_1", text: "Neu vom Handy", channel: "mobile" }, now + MIN), "intake");
  assert.equal(K.isEvaluationCurrent(ev, mutiert, now + MIN).reason, "REVISION_CHANGED");
});

/* ══ T: unvollstaendiges Warten nicht gruen ══════════════════════════════ */
test("Warten ohne Gegenpartei, nextAction, followUpAt oder Evidenz ist nicht gruen — Eigenarbeit ist kein waiting_external", () => {
  const d0 = allesErledigen(bestand(), NOW);
  d0.entities.chatgptLeads.l1 = { ...bestand().entities.chatgptLeads.l1, status: "wartet", blockedReason: "Antwort der Bank" };
  let { data, now, date } = tagAufbauen(migriert(d0));
  let ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "WAITING_UNVERIFIED", "l1"), "Altstatus 'wartet' ohne Evidenz darf nicht gruen sein");

  const gut = { sourceType: "chatgptLead", sourceId: "l1", state: "waiting_external", counterparty: "Bank Muster AG", nextAction: "Antwort pruefen, sonst nachfassen", followUpAt: new Date(now + 2 * 24 * STD).toISOString(), evidence: { kind: "mail", ref: "msg_abc123" } };
  for (const [name, kaputt, code] of [
    ["ohne Gegenpartei", { ...gut, counterparty: "" }, "WAIT_COUNTERPARTY_MISSING"],
    ["Gegenpartei ist man selbst", { ...gut, counterparty: "chatgpt" }, "WAIT_COUNTERPARTY_SELF"],
    ["Gegenpartei ist der eigene Executor", { ...gut, counterparty: "openai" }, "WAIT_COUNTERPARTY_SELF"],
    ["ohne nextAction", { ...gut, nextAction: " " }, "WAIT_NEXT_ACTION_MISSING"],
    ["ohne followUpAt", { ...gut, followUpAt: null }, "WAIT_FOLLOWUP_MISSING"],
    ["followUpAt in der Vergangenheit", { ...gut, followUpAt: new Date(now - STD).toISOString() }, "WAIT_FOLLOWUP_PAST"],
    ["followUpAt in 90 Tagen", { ...gut, followUpAt: new Date(now + 90 * 24 * STD).toISOString() }, "WAIT_FOLLOWUP_IMPLAUSIBLE"],
    ["ohne Evidenz", { ...gut, evidence: { kind: "mail", ref: "" } }, "WAIT_EVIDENCE_MISSING"],
    ["waiting_external auf den Nutzer", { ...gut, counterparty: "user" }, "WAIT_EXTERNAL_IS_USER"],
    ["waiting_user auf Dritte", { ...gut, state: "waiting_user" }, "WAIT_COUNTERPARTY_NOT_USER"],
  ]) {
    const r = run(data, "setWaiting", kaputt, now);
    assert.equal(r.ok, false, name);
    assert.equal(r.error, "WAITING_INCOMPLETE", name);
    assert.ok(r.detail.includes(code), `${name}: ${r.detail}`);
  }
  // "Ich mache das spaeter" ist kein Warten: Selbst als Gegenpartei faellt durch (oben) —
  // und ein direktes transitionState in einen Wartezustand ist verboten.
  const t = run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "waiting_external" }, now);
  assert.equal(t.error, "USE_SET_WAITING");

  // Vollstaendiges Warten → gruen, mit Evidenz am Element sichtbar.
  data = mussOk(run(data, "setWaiting", gut, now), "setWaiting");
  assert.equal(data.entities.chatgptLeads.l1.operationalState, "waiting_external");
  assert.equal(data.entities.chatgptLeads.l1.status, "wartet", "der Altstatus bleibt das Feld der Oberflaeche");
  const w = data.automation.waitingById["chatgptLead:l1"];
  assert.equal(w.waitingSince, new Date(now).toISOString());
  assert.equal(w.evidence.ref, "msg_abc123");
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  assert.ok(Date.parse(ev.validUntil) <= Date.parse(w.followUpAt), "validUntil respektiert followUpAt");
  // Nach followUpAt ist die Nachfassung faellig → nicht mehr gruen (Zeitablauf).
  const spaeter = Date.parse(w.followUpAt) + MIN;
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, spaeter, POLICY);
  assert.ok(hatCode(ev, "FOLLOWUP_DUE", "l1"));
  // Die Warte-Evidenz eines Elements wird niemals in itemRefs kopiert.
  for (const ref of data.dailyBriefing.assistantRuns[date].itemRefs) {
    assert.deepEqual(Object.keys(ref).sort(), ["includedAt", "sourceId", "sourceType"]);
  }
});

/* ══ T: dreimal Deferral trotz Textaenderung rot ═════════════════════════ */
test("drei Verschiebungen ohne anerkannten Fortschritt sind rot — Titel, Kommentar, Zuweisung, Retry setzen nichts zurueck", () => {
  let { data, now, date } = tagAufbauen(migriert(allesErledigen(bestand(), NOW)));
  // t2 (faellig 30.10.) wird beobachtet …
  data = mussOk(run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now), "obs0");
  assert.equal(data.automation.progressById["task:t2"].deferrals, 0);
  const schiebe = (d, tag, aenderung) => {
    const c = K.klon(d);
    const t = c.entities.tasks.t2;
    t.dueDate = tag;
    aenderung(t);
    t.updatedAt = new Date(now).toISOString();
    return c;
  };
  data = schiebe(data, "2026-11-05", (t) => { t.title = "Spaeter (umbenannt)"; });
  data = mussOk(run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now + STD), "obs1");
  assert.equal(data.automation.progressById["task:t2"].deferrals, 1);
  data = schiebe(data, "2026-11-12", (t) => { t.comments.push({ id: "k1", text: "Bin dran", createdAt: "x" }); t.assignee = "Anna"; });
  data = mussOk(run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now + 2 * STD), "obs2");
  assert.equal(data.automation.progressById["task:t2"].deferrals, 2);
  data = schiebe(data, "2026-11-20", (t) => { t.retryCount = 4; t.tags = ["neu"]; });
  data = mussOk(run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now + 3 * STD), "obs3");
  assert.equal(data.automation.progressById["task:t2"].deferrals, 3);
  let ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 3 * STD, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "DEFERRAL_LIMIT", "t2"));
  // Der Zaehler lebt nur im Kern: am Element steht nichts davon.
  assert.equal(data.entities.tasks.t2.deferrals, undefined);
  // Echter Fortschritt (ein Workflow-Schritt erledigt) setzt zurueck.
  const fortschritt = K.klon(data);
  fortschritt.entities.tasks.t2.workflow = [{ id: "w1", text: "Angebot einholen", done: true }];
  data = mussOk(run(fortschritt, "observeSource", { sourceType: "task", sourceId: "t2" }, now + 4 * STD), "obs4");
  assert.equal(data.automation.progressById["task:t2"].deferrals, 0);
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 4 * STD, POLICY);
  assert.ok(!hatCode(ev, "DEFERRAL_LIMIT", "t2"));
  // Dasselbe fuer ein Warten, dessen followUpAt dreimal wandert.
  const d0 = allesErledigen(bestand(), NOW);
  d0.entities.chatgptLeads.l1.status = "in_arbeit";
  let s = tagAufbauen(migriert(d0));
  let w = { sourceType: "chatgptLead", sourceId: "l1", state: "waiting_external", counterparty: "Amt", nextAction: "nachfragen", followUpAt: new Date(s.now + 24 * STD).toISOString(), evidence: { kind: "mail", ref: "m1" } };
  let dd = mussOk(run(s.data, "setWaiting", w, s.now), "w0");
  dd = mussOk(run(dd, "observeSource", { sourceType: "chatgptLead", sourceId: "l1" }, s.now), "o0");
  for (let i = 1; i <= 3; i++) {
    dd = mussOk(run(dd, "setWaiting", { ...w, followUpAt: new Date(s.now + (24 + i * 24) * STD).toISOString(), nextAction: "nachfragen (v" + i + ")" }, s.now + i * MIN), "w" + i);
    dd = mussOk(run(dd, "observeSource", { sourceType: "chatgptLead", sourceId: "l1" }, s.now + i * MIN), "o" + i);
  }
  assert.equal(dd.automation.progressById["chatgptLead:l1"].deferrals, 3);
  ev = K.dailyAssistantTrafficLight(dd.dailyBriefing.assistantRuns[s.date], dd, s.now + 4 * MIN, POLICY);
  assert.ok(hatCode(ev, "DEFERRAL_LIMIT", "l1"));
});

/* ══ T: Agenten-Statusbehauptung zaehlt nicht ════════════════════════════ */
test("eine Behauptung des Agenten (overallGreen, operationalState:done) aendert das Urteil nicht", () => {
  const d0 = allesErledigen(bestand(), NOW);
  d0.entities.chatgptLeads.l1.status = "in_arbeit";
  let { data, now, date } = tagAufbauen(migriert(d0));
  const runObj = K.klon(data.dailyBriefing.assistantRuns[date]);
  runObj.overallGreen = true;
  runObj.agentReport = { coverage: "green", operations: "green" };
  runObj.userApproval = true;
  let ev = K.dailyAssistantTrafficLight(runObj, data, now, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "ITEM_OPEN", "l1"));
  assert.ok(hatCode(ev, "AGENT_CLAIM_IGNORED"));
  // Direkt am Element hingeschriebenes done ohne Altstatus-Abschluss: Behauptung, rot.
  const beh = K.klon(data);
  beh.entities.chatgptLeads.l1.operationalState = "done";
  beh.entities.chatgptLeads.l1.operationalStateSource = { legacyField: "status", legacyValue: "in_arbeit", mappedAt: "x" };
  ev = K.dailyAssistantTrafficLight(beh.dailyBriefing.assistantRuns[date], beh, now, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "STATE_CLAIM_INCONSISTENT", "l1"));
  assert.ok(hatCode(ev, "ITEM_OPEN", "l1"));
  // Ueber ein Kommando: done verlangt den Altstatus-Abschluss.
  const r = run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done" }, now);
  assert.equal(r.error, "DONE_REQUIRES_LEGACY_CLOSE");
  // Schutzfelder kommen durch kein Kommando hinein — auch nicht verschachtelt.
  for (const [type, payload] of [
    ["recordSlotReceipt", { date, slot: "close23", receiptId: "r", finalAt: "2026-09-19T21:00:00Z" }],
    ["addItemRef", { date, sourceType: "chatgptLead", sourceId: "l1", overallGreen: true }],
    ["setWaiting", { sourceType: "chatgptLead", sourceId: "l1", state: "waiting_external", counterparty: "x", nextAction: "y", followUpAt: "2026-09-20T10:00:00Z", evidence: { kind: "mail", ref: "m", userApproval: true } }],
    ["askQuestion", { questionId: "q_x", sourceType: "chatgptLead", sourceId: "l1", text: "?", phase: "final" }],
  ]) {
    const x = run(data, type, payload, now);
    assert.equal(x.ok, false, type);
    assert.equal(x.error, "COMMAND_REJECTED", type);
    assert.ok(x.detail.some((e) => e.startsWith("PAYLOAD_PROTECTED:") || e.startsWith("PAYLOAD_UNKNOWN:")), type + ": " + x.detail);
  }
  assert.equal(run(data, "closeRun", { date, finalNoteId: "n", phase: "final" }, now).error, "COMMAND_REJECTED");
  assert.equal(run(data, "nichtVorhanden", { date }, now).error, "COMMAND_REJECTED");
  assert.equal(K.applyCommand(data, { type: "ensureRun", commandId: "kurz", now, payload: { date } }, { policy: POLICY }).error, "COMMAND_REJECTED");
});

/* ══ T: Abschluss atomar, idempotent, mit echter Notiz und 09/23 ═════════ */
test("Abschluss: erst ab 23:00 Zuerich, nur mit Quittungen 09 und 23, nur gruen — atomar mit genau einer Finalnotiz, Wiederholung idempotent", () => {
  const date = "2026-09-19";
  // Vor 23:00: zu frueh, auch wenn alles andere stimmt.
  let s = tagAufbauen(migriert(allesErledigen(bestand(), NOW)), { bis: "22:30" });
  let r = run(s.data, "closeRun", { date, finalNoteId: "note_final_1" }, s.now);
  assert.equal(r.ok, false);
  assert.equal(r.error, "CLOSURE_BLOCKED");
  assert.ok(r.detail.some((b) => b.code === "CLOSURE_TOO_EARLY"));
  assert.ok(r.detail.some((b) => b.code === "RECEIPT_MISSING" && b.detail === "close23"));
  assert.equal(s.data.entities.notes.note_final_1, undefined, "kein Teil-Effekt bei Ablehnung");
  assert.equal(s.data.dailyBriefing.assistantRuns[date].phase, "active");

  // Ab 23:05, aber ohne Quittung 09 → blockiert und nichts geschrieben.
  s = tagAufbauen(migriert(allesErledigen(bestand(), NOW)));
  const ohne09 = K.klon(s.data);
  ohne09.dailyBriefing.assistantRuns[date].slotReceipts.process09 = null;
  r = run(ohne09, "closeRun", { date, finalNoteId: "note_final_1" }, s.now);
  assert.equal(r.error, "CLOSURE_BLOCKED");
  assert.ok(r.detail.some((b) => b.code === "RECEIPT_MISSING" && b.detail === "process09"));
  assert.ok(r.detail.some((b) => b.code === "OPERATIONS_NOT_GREEN"));

  // Ein offener Lead → Abschluss blockiert, mit Quell-Id im Befund.
  const offen = K.klon(s.data);
  offen.entities.chatgptLeads.l1.status = "in_arbeit"; offen.entities.chatgptLeads.l1.closedAt = null;
  r = run(offen, "closeRun", { date, finalNoteId: "note_final_1" }, s.now);
  assert.equal(r.error, "CLOSURE_BLOCKED");
  const cov = r.detail.find((b) => b.code === "COVERAGE_NOT_GREEN");
  assert.ok(cov && cov.detail.some((x) => x.sourceId === "l1"));

  // Quelle 20 Minuten alt → blockiert.
  r = run(s.data, "closeRun", { date, finalNoteId: "note_final_1" }, s.now + 20 * MIN);
  assert.equal(r.error, "CLOSURE_BLOCKED");
  assert.ok(r.detail.find((b) => b.code === "OPERATIONS_NOT_GREEN").detail.some((x) => x.code === "SOURCE_STALE"));

  // Alles erfuellt → Abschluss. Atomar: phase, finalAt, closureRevision, closureCutoff, finalNoteId, Notiz.
  // Der Tag wurde mit OFFENEN Elementen aufgebaut (Verweise im Lauf) und dann ueber die Oberflaeche erledigt.
  s = tagAufbauen(migriert(bestand()));
  s.data = allesErledigen(s.data, s.now - MIN);
  const revVorher = s.data.automation.dataRevision;
  r = run(s.data, "closeRun", { date, finalNoteId: "note_final_1" }, s.now);
  const d1 = mussOk(r, "closeRun");
  const runF = d1.dailyBriefing.assistantRuns[date];
  assert.equal(runF.phase, "final");
  assert.equal(runF.finalAt, new Date(s.now).toISOString());
  assert.equal(runF.closureCutoff, runF.finalAt);
  assert.equal(runF.closureRevision, revVorher + 1);
  assert.equal(runF.finalNoteId, "note_final_1");
  assert.equal(runF.startNoteId, "note_start_" + date);
  const note = d1.entities.notes.note_final_1;
  assert.ok(note && note.title.includes("Abschluss") && note.content.includes("chatgptLead:l1 → done"));
  assert.deepEqual(note.assistantNote, { kind: "assistantFinal", runDate: date });
  assert.equal(Object.values(d1.entities.notes).filter((n) => n.assistantNote?.kind === "assistantFinal").length, 1);
  assert.equal(Object.values(d1.entities.notes).filter((n) => n.assistantNote?.kind === "assistantStart").length, 1);
  assert.equal(s.data.dailyBriefing.assistantRuns[date].phase, "active", "die Eingabe darf nicht mutiert werden");

  // Wiederholung — anderer Zeitpunkt, andere Notiz-Id, andere commandId: idempotent, keine zweite Notiz.
  const r2 = run(d1, "closeRun", { date, finalNoteId: "note_final_2" }, s.now + 5 * MIN);
  assert.equal(r2.ok, true);
  assert.equal(r2.already, true);
  assert.equal(r2.finalNoteId, "note_final_1");
  assert.equal(JSON.stringify(r2.data), JSON.stringify(d1));
  assert.equal(r2.data.entities.notes.note_final_2, undefined);
  // Ein fachlicher No-op hinterlaesst keine Spur (auch keinen Idempotenz-Eintrag) …
  assert.equal(r2.noop, true);
  assert.equal(Object.keys(r2.data.automation.idempotencyByKey).length, Object.keys(d1.automation.idempotencyByKey).length);
  // … und eine schreibende commandId ein zweites Mal ist Wiedergabe, kein zweites Schreiben.
  const c = cmd("registerIntake", { intakeId: "in_replay", text: "spaet", channel: "mobile" }, s.now);
  const a1 = K.applyCommand(r2.data, c, { policy: POLICY });
  const a2 = K.applyCommand(a1.data, c, { policy: POLICY });
  assert.equal(a1.replayed, false); assert.equal(a2.replayed, true);
  assert.equal(JSON.stringify(a2.data), JSON.stringify(a1.data));
  assert.equal(K.applyCommand(a1.data, { ...c, type: "acquireLease", payload: { holder: "x", ttlMs: 60000 } }, { policy: POLICY }).error, "COMMAND_ID_REUSED");
  // Startnotiz: eine pro Tag, auch bei anderer Id.
  const st = run(d1, "ensureStartNote", { date, noteId: "note_start_zwei" }, s.now);
  assert.equal(st.ok, true); assert.equal(st.created, false); assert.equal(st.noteId, "note_start_" + date);
  assert.equal(st.data.entities.notes.note_start_zwei, undefined);
  // Nach 04:00 des Folgetages ist der Tag vorbei.
  const s2 = tagAufbauen(migriert(allesErledigen(bestand(), NOW)));
  r = run(s2.data, "closeRun", { date, finalNoteId: "n" }, K.tagesEndeMs(date) + MIN);
  assert.ok(r.detail.some((b) => b.code === "CLOSURE_DAY_OVER"));
});

/* ══ T: Folgeinvalidierung, unveraenderliche Historie ═══════════════════ */
test("ein Widerspruch nach dem Abschluss invalidiert append-only; die Finalnotiz bleibt byteidentisch; neuer Eingang geht in den naechsten Lauf", () => {
  const date = "2026-09-19";
  const s = tagAufbauen(migriert(bestand()));
  s.data = allesErledigen(s.data, s.now - MIN);
  const d1 = mussOk(run(s.data, "closeRun", { date, finalNoteId: "note_final_1" }, s.now), "closeRun");
  const finalnotizVorher = JSON.stringify(d1.entities.notes.note_final_1);
  const t1 = s.now + 10 * MIN;

  // Neuer Eingang NACH dem Abschluss: kein Widerspruch, gehoert in den naechsten Lauf.
  let d2 = mussOk(run(d1, "registerIntake", { intakeId: "in_neu", text: "Neue Idee vom Handy", channel: "mobile" }, t1), "intake");
  let w = K.pruefeWiderspruch(d2, { date }, { now: t1 });
  assert.equal(w.contradictions.length, 0);
  assert.deepEqual(w.newIntake, [{ sourceType: "intake", sourceId: "in_neu" }]);
  assert.equal(w.nextRunDate, "2026-09-20");
  let inv = run(d2, "invalidateClosure", { date, correctionId: "note_korr_1", reason: "neuer Eingang", contradiction: { sourceType: "intake", sourceId: "in_neu" } }, t1);
  assert.equal(inv.error, "NOT_A_CONTRADICTION");
  assert.equal(inv.detail.nextRunDate, "2026-09-20");
  assert.equal(d2.dailyBriefing.assistantRuns[date].phase, "final");

  // Echter Widerspruch: ein bei Abschluss als done gezaehlter Lead wird wieder geoeffnet.
  d2 = K.klon(d2);
  d2.entities.chatgptLeads.l1.status = "in_arbeit"; d2.entities.chatgptLeads.l1.closedAt = null; d2.entities.chatgptLeads.l1.updatedAt = new Date(t1).toISOString();
  w = K.pruefeWiderspruch(d2, { date }, { now: t1 });
  assert.deepEqual(w.contradictions, [{ sourceType: "chatgptLead", sourceId: "l1", was: "done", now: "doing" }]);
  inv = run(d2, "invalidateClosure", { date, correctionId: "note_korr_1", reason: "Lead l1 wieder offen", contradiction: { sourceType: "chatgptLead", sourceId: "l1" } }, t1);
  const d3 = mussOk(inv, "invalidateClosure");
  const runI = d3.dailyBriefing.assistantRuns[date];
  assert.equal(runI.phase, "exception_open");
  assert.equal(runI.invalidatedAt, new Date(t1).toISOString());
  assert.equal(runI.finalNoteId, "note_final_1", "die Referenz auf die historische Finalnotiz bleibt");
  assert.equal(runI.finalAt, d1.dailyBriefing.assistantRuns[date].finalAt);
  assert.equal(runI.closureRevision, d1.dailyBriefing.assistantRuns[date].closureRevision);
  assert.equal(JSON.stringify(d3.entities.notes.note_final_1), finalnotizVorher, "die historische Finalnotiz wurde veraendert");
  assert.equal(runI.corrections.length, 1);
  assert.equal(runI.corrections[0].invalidatedFinalNoteId, "note_final_1");
  assert.ok(d3.entities.notes.note_korr_1 && d3.entities.notes.note_korr_1.assistantNote.kind === "assistantCorrection");
  // Wiederholung derselben Korrektur: No-op.
  const inv2 = run(d3, "invalidateClosure", { date, correctionId: "note_korr_1", reason: "nochmal", contradiction: { sourceType: "chatgptLead", sourceId: "l1" } }, t1 + MIN);
  assert.equal(inv2.error, "RUN_NOT_FINAL");
  assert.equal(inv2.data.dailyBriefing.assistantRuns[date].corrections.length, 1);
  // Ampel: exception_open ist rot, ein erneuter Abschluss ist nicht moeglich.
  const ev = K.dailyAssistantTrafficLight(runI, d3, t1, POLICY);
  assert.ok(hatCode(ev, "RUN_EXCEPTION_OPEN"));
  assert.equal(run(d3, "closeRun", { date, finalNoteId: "note_final_3" }, t1).error, "RUN_EXCEPTION_OPEN");
});

/* ══ T: DST eindeutige Slots ═════════════════════════════════════════════ */
test("Europe/Zurich: Sommer- und Winterzeit ergeben eindeutige Slots und stabile Schluessel", () => {
  // Fruehjahr 2026: 29.03. 02:00 → 03:00. Herbst 2026: 25.10. 03:00 → 02:00.
  assert.equal(new Date(K.slotBeginnMs("2026-03-28", "briefing04")).toISOString(), "2026-03-28T03:00:00.000Z"); // CET
  assert.equal(new Date(K.slotBeginnMs("2026-03-29", "briefing04")).toISOString(), "2026-03-29T02:00:00.000Z"); // CEST
  assert.equal(new Date(K.slotBeginnMs("2026-10-24", "close23")).toISOString(), "2026-10-24T21:00:00.000Z");   // CEST
  assert.equal(new Date(K.slotBeginnMs("2026-10-25", "briefing04")).toISOString(), "2026-10-25T03:00:00.000Z"); // CET
  assert.equal(new Date(K.slotBeginnMs("2026-10-25", "close23")).toISOString(), "2026-10-25T22:00:00.000Z");
  // Der Assistententag, der in die Umstellungsnacht hineinreicht, ist 25 bzw. 23 Stunden lang.
  assert.equal((K.tagesEndeMs("2026-10-24") - K.slotBeginnMs("2026-10-24", "briefing04")) / STD, 25);
  assert.equal((K.tagesEndeMs("2026-03-28") - K.slotBeginnMs("2026-03-28", "briefing04")) / STD, 23);
  assert.equal((K.tagesEndeMs("2026-10-25") - K.slotBeginnMs("2026-10-25", "briefing04")) / STD, 24);
  // Alle Slotzeitpunkte beider Umstellungstage sind paarweise verschieden und streng steigend.
  for (const tag of ["2026-03-28", "2026-03-29", "2026-10-24", "2026-10-25"]) {
    const ms = K.SLOT_KEYS.map((s) => K.slotBeginnMs(tag, s));
    for (let i = 1; i < ms.length; i++) assert.ok(ms[i] > ms[i - 1], tag + " " + K.SLOT_KEYS[i]);
    assert.equal(new Set(ms).size, 4);
    // Jede Wandzeit kommt wieder als dieselbe Wandzeit heraus.
    K.SLOTS.forEach((s, i) => { const p = K.zurichParts(ms[i]); assert.equal(p.hour, s.hour); assert.equal(K.ymd(p), tag); });
  }
  // Doppelte Stunde 02:xx am 25.10.: der fruehere Zeitpunkt; Luecke am 29.03.: nach vorn geschoben.
  assert.equal(new Date(K.wandzeitZuMs("2026-10-25", 2, 30)).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(K.zurichParts(K.wandzeitZuMs("2026-03-29", 2, 30)).hour, 3);
  // 04:00-Regel: 02:30 Ortszeit gehoert zum Vortag — auch ueber die Umstellung hinweg.
  assert.equal(K.assistentenTag(T("2026-10-25T00:30:00Z")), "2026-10-24");   // 02:30 CEST
  assert.equal(K.assistentenTag(T("2026-10-25T01:30:00Z")), "2026-10-24");   // 02:30 CET (zweites Mal)
  assert.equal(K.assistentenTag(T("2026-10-25T03:00:00Z")), "2026-10-25");   // 04:00 CET
  assert.equal(K.assistentenTag(T("2026-03-29T01:59:00Z")), "2026-03-28");   // 03:59 CEST
  assert.equal(K.assistentenTag(T("2026-03-29T02:00:00Z")), "2026-03-29");   // 04:00 CEST
  // aktuellerSlot und naechste Grenze um die Umstellung.
  assert.deepEqual([K.aktuellerSlot(T("2026-10-25T00:30:00Z")).date, K.aktuellerSlot(T("2026-10-25T00:30:00Z")).slot], ["2026-10-24", "close23"]);
  assert.equal(new Date(K.naechsteSlotGrenzeMs(T("2026-10-25T00:30:00Z"))).toISOString(), "2026-10-25T03:00:00.000Z");
  assert.deepEqual(K.faelligeSlots("2026-10-25", T("2026-10-25T13:30:00Z")), ["briefing04", "process09", "continue14"]);
  // Slot-Schluessel: stabil, ohne Zeitanteil, mit Mandant und Policy-Version.
  assert.equal(K.slotKey("laurin", "2026-10-25", "close23", "3.0"), "laurin:2026-10-25:close23:3.0");
  assert.equal(K.slotKey("laurin", "2026-10-25", "close23", "3.0"), K.slotKey("laurin", "2026-10-25", "close23", "3.0"));
  assert.notEqual(K.slotKey("laurin", "2026-10-25", "close23", "3.0"), K.slotKey("laurin", "2026-10-25", "close23", "3.1"));
  assert.throws(() => K.slotKey("laurin", "2026-10-25", "mittag", "3.0"), RangeError);
  assert.throws(() => K.slotKey("", "2026-10-25", "close23", "3.0"), TypeError);
  // Eine Quittung fuer einen Slot, der noch nicht begonnen hat, wird abgelehnt; die Quittung traegt den Schluessel.
  let d = mussOk(run(migriert(), "ensureRun", { date: "2026-10-25" }, K.slotBeginnMs("2026-10-25", "briefing04")), "run");
  const zuFrueh = run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "r09" }, K.slotBeginnMs("2026-10-25", "process09") - MIN);
  assert.equal(zuFrueh.error, "SLOT_NOT_STARTED");
  d = mussOk(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "r09" }, K.slotBeginnMs("2026-10-25", "process09")), "r09");
  assert.equal(d.dailyBriefing.assistantRuns["2026-10-25"].slotReceipts.process09.slotKey, "laurin:2026-10-25:process09:3.0");
  assert.equal(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "r09" }, K.slotBeginnMs("2026-10-25", "process09") + MIN).created, false);
  assert.equal(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "anders" }, K.slotBeginnMs("2026-10-25", "process09") + MIN).error, "SLOT_ALREADY_RECEIPTED");
  // Fehlende Quittung eines begonnenen Slots ist in der Ampel sichtbar.
  const ev = K.dailyAssistantTrafficLight(d.dailyBriefing.assistantRuns["2026-10-25"], d, K.slotBeginnMs("2026-10-25", "continue14") + MIN, POLICY);
  assert.ok(ev.reasons.some((r) => r.code === "SLOT_RECEIPT_MISSING" && r.detail === "briefing04"));
  assert.ok(ev.reasons.some((r) => r.code === "SLOT_RECEIPT_MISSING" && r.detail === "continue14"));
  assert.ok(!ev.reasons.some((r) => r.code === "SLOT_RECEIPT_MISSING" && r.detail === "close23"));
});

/* ══ T: Antworten nur einmal ═════════════════════════════════════════════ */
test("Fragen sind unveraenderlich, Antworten genau einmal konsumierbar, eine offene Frage ist nie eine Freigabe", () => {
  const d0 = allesErledigen(bestand(), NOW);
  d0.entities.chatgptLeads.l1.status = "in_arbeit";
  let { data, now, date } = tagAufbauen(migriert(d0));
  data = mussOk(run(data, "askQuestion", { questionId: "q1", sourceType: "chatgptLead", sourceId: "l1", text: "Welche Firma?", date }, now), "ask");
  assert.equal(run(data, "askQuestion", { questionId: "q1", sourceType: "chatgptLead", sourceId: "l1", text: "Anderer Text" }, now).error, "QUESTION_IMMUTABLE");
  assert.equal(run(data, "askQuestion", { questionId: "q1", sourceType: "chatgptLead", sourceId: "l1", text: "Welche Firma?" }, now).created, false);
  // Offene Frage: Element nicht abschliessbar, auch wenn der Altstatus abgeschlossen waere.
  const geschlossen = K.klon(data);
  geschlossen.entities.chatgptLeads.l1.status = "abgeschlossen"; geschlossen.entities.chatgptLeads.l1.closedAt = "2026-09-19T20:00:00Z";
  assert.equal(run(geschlossen, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done" }, now).error, "QUESTION_OPEN");
  let ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.ok(hatCode(ev, "QUESTION_OPEN", "l1"));
  // Warten auf den Nutzer mit der Frage als Evidenz: gruen, bis die Antwort da ist.
  data = mussOk(run(data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", state: "waiting_user", counterparty: "user", nextAction: "Antwort einarbeiten", followUpAt: new Date(now + 3 * STD).toISOString(), evidence: { kind: "question", ref: "q1" } }, now), "wait");
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  // Antwort: unveraenderlich.
  data = mussOk(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Muster AG" }, now + MIN), "answer");
  assert.equal(data.automation.questionsById.q1.status, "answered");
  assert.equal(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Doch eine andere" }, now + 2 * MIN).error, "ANSWER_IMMUTABLE");
  assert.equal(run(data, "recordAnswer", { answerId: "a2", questionId: "q1", text: "Zweite Antwort" }, now + 2 * MIN).error, "QUESTION_ALREADY_ANSWERED");
  assert.equal(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Muster AG" }, now + 2 * MIN).created, false);
  // Unkonsumierte Antwort: nicht gruen (der Assistent muss sie einarbeiten).
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + MIN, POLICY);
  assert.ok(hatCode(ev, "ANSWER_UNCONSUMED", "l1") || hatCode(ev, "ANSWER_UNCONSUMED", "a1"));
  // Genau einmal konsumierbar — auch mit anderer commandId und anderem Konsumenten.
  data = mussOk(run(data, "consumeAnswer", { answerId: "a1", consumer: "run_2026-09-19/process09" }, now + 3 * MIN), "consume");
  assert.equal(data.automation.answersById.a1.consumedBy, "run_2026-09-19/process09");
  const zweite = run(data, "consumeAnswer", { answerId: "a1", consumer: "run_2026-09-19/continue14" }, now + 4 * MIN);
  assert.equal(zweite.error, "ANSWER_ALREADY_CONSUMED");
  assert.equal(data.automation.answersById.a1.text, "Muster AG");
  // Dieselbe commandId wiederholt: Wiedergabe, nicht "already consumed".
  const c = cmd("consumeAnswer", { answerId: "a1", consumer: "x" }, now + 5 * MIN);
  const frisch = mussOk(run(data, "askQuestion", { questionId: "q2", sourceType: "chatgptLead", sourceId: "l1", text: "Noch was?" }, now), "q2");
  const mitA2 = mussOk(run(frisch, "recordAnswer", { answerId: "a9", questionId: "q2", text: "Nein" }, now), "a9");
  const c9 = cmd("consumeAnswer", { answerId: "a9", consumer: "x" }, now + 5 * MIN);
  const k1 = K.applyCommand(mitA2, c9, { policy: POLICY });
  const k2 = K.applyCommand(k1.data, c9, { policy: POLICY });
  assert.equal(k1.ok, true); assert.equal(k2.ok, true); assert.equal(k2.replayed, true);
  void c;
});

/* ══ T: unlesbare Dokumente offen statt verarbeitet ══════════════════════ */
test("ein unlesbares Dokument bleibt offen und sichtbar — nie verarbeitet", () => {
  let { data, now, date } = tagAufbauen(migriert(allesErledigen(bestand(), NOW)));
  data = mussOk(run(data, "registerDocument", { documentId: "doc1", name: "vertrag.pdf", storageRef: "uploads/vertrag.pdf", mime: "application/pdf" }, now), "reg");
  let ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.ok(hatCode(ev, "DOCUMENT_UNPROCESSED", "doc1"));
  data = mussOk(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "unreadable", error: "verschluesseltes PDF" }, now + MIN), "parse");
  assert.equal(data.automation.documentsById.doc1.status, "open");
  assert.equal(data.automation.documentsById.doc1.parse.outcome, "unreadable");
  assert.equal(data.automation.documentsById.doc1.handledAt, null);
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + MIN, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(ev.reasons.some((r) => r.code === "DOCUMENT_UNREADABLE" && r.sourceId === "doc1" && r.detail === "verschluesseltes PDF"));
  // Unlesbar kann nicht "behandelt" werden.
  assert.equal(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done" }, now + 2 * MIN).error, "DOCUMENT_NOT_PARSED");
  assert.equal(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed" }, now + 2 * MIN).error, "PARSE_TEXTREF_MISSING");
  // Gelesen → immer noch offen (unbehandelt), erst transitionState → done schliesst.
  data = mussOk(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: "attachment-text__x__y__z" }, now + 3 * MIN), "parsed");
  assert.equal(data.automation.documentsById.doc1.parse.attempts, 2);
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 3 * MIN, POLICY);
  assert.ok(hatCode(ev, "DOCUMENT_UNHANDLED", "doc1"));
  data = mussOk(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done", linkTo: { sourceType: "chatgptLead", sourceId: "l1" } }, now + 4 * MIN), "handled");
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 4 * MIN, POLICY);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  // Ungeklaerter Eingang sperrt, bis er verknuepft oder begruendet geklaert ist.
  data = mussOk(run(data, "registerIntake", { intakeId: "in_1", text: "Bitte Zahnarzt anrufen", channel: "mobile" }, now + 5 * MIN), "intake");
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 5 * MIN, POLICY);
  assert.ok(hatCode(ev, "INTAKE_UNCLARIFIED", "in_1"));
  assert.equal(run(data, "transitionState", { sourceType: "intake", sourceId: "in_1", state: "done" }, now + 6 * MIN).error, "INTAKE_DONE_NEEDS_LINK_OR_REASON");
  data = mussOk(run(data, "transitionState", { sourceType: "intake", sourceId: "in_1", state: "done", linkTo: { sourceType: "task", sourceId: "t1" } }, now + 6 * MIN), "geklaert");
  assert.deepEqual(data.automation.intakeById.in_1.linkedTo, { sourceType: "task", sourceId: "t1" });
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + 6 * MIN, POLICY);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
});

/* ══ Spezialistenrueckgabe ist review, nicht done ════════════════════════ */
test("eine Spezialistenrueckgabe setzt das Element auf review — nie auf done", () => {
  const d0 = allesErledigen(bestand(), NOW);
  d0.entities.chatgptLeads.l1.status = "in_arbeit";
  let { data, now, date } = tagAufbauen(migriert(d0));
  data = mussOk(run(data, "createJob", { jobId: "job1", kind: "recherche", sourceType: "chatgptLead", sourceId: "l1", executor: "gemini" }, now), "job");
  assert.equal(data.automation.jobsById.job1.mode, "dry_run");
  data = mussOk(run(data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", state: "delegated", counterparty: "gemini", nextAction: "Rueckgabe pruefen", followUpAt: new Date(now + 4 * STD).toISOString(), evidence: { kind: "job", ref: "job1" } }, now), "delegated");
  let ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);
  assert.ok(hatCode(ev, "JOB_PENDING", "job1"));
  assert.equal(ev.coverage, "yellow");
  data = mussOk(run(data, "recordJobReturn", { jobId: "job1", outcome: "returned", resultRef: "notes/xyz" }, now + STD), "return");
  assert.equal(data.entities.chatgptLeads.l1.operationalState, "review");
  assert.equal(data.entities.chatgptLeads.l1.status, "in_arbeit");
  assert.equal(data.automation.waitingById["chatgptLead:l1"], undefined);
  ev = K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now + STD, POLICY);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "REVIEW_PENDING", "l1"));
  assert.ok(hatCode(ev, "JOB_RETURN_UNREVIEWED", "job1"));
  // Erst der Abschluss ueber die Oberflaeche (Altstatus) und dann transitionState → done schliessen ab.
  const geschlossen = K.klon(data);
  geschlossen.entities.chatgptLeads.l1.status = "abgeschlossen"; geschlossen.entities.chatgptLeads.l1.closedAt = new Date(now + 2 * STD).toISOString();
  const fertig = mussOk(run(geschlossen, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done" }, now + 2 * STD), "done");
  assert.ok(fertig.automation.jobsById.job1.reviewedAt);
  ev = K.dailyAssistantTrafficLight(fertig.dailyBriefing.assistantRuns[date], fertig, now + 2 * STD, POLICY);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  // Ein fehlgeschlagener Job ist sichtbar rot.
  const f = mussOk(run(mussOk(run(data, "createJob", { jobId: "job2", kind: "x", sourceType: "chatgptLead", sourceId: "l1", executor: "claude" }, now), "j2"), "recordJobReturn", { jobId: "job2", outcome: "failed", error: "quota" }, now + MIN), "fail");
  assert.ok(hatCode(K.dailyAssistantTrafficLight(f.dailyBriefing.assistantRuns[date], f, now + MIN, POLICY), "JOB_FAILED", "job2"));
  assert.equal(run(data, "createJob", { jobId: "job3", kind: "x", sourceType: "chatgptLead", sourceId: "l1", executor: "cowork" }, now).error, "EXECUTOR_UNKNOWN");
});

/* ══ Carry-over ohne Kopien, itemRefs ohne Statusfelder ══════════════════ */
test("Carry-over uebernimmt Verweise, keine neuen Aufgaben; itemRefs tragen keine Statusfelder", () => {
  const d0 = allesErledigen(bestand(), NOW);
  d0.entities.chatgptLeads.l1.status = "in_arbeit";
  let { data, now } = tagAufbauen(migriert(d0));
  const tasksVorher = JSON.stringify(data.entities.tasks);
  const leadsVorher = JSON.stringify(data.entities.chatgptLeads);
  data = mussOk(run(data, "ensureRun", { date: "2026-09-20" }, K.slotBeginnMs("2026-09-20", "briefing04")), "run2");
  data = mussOk(run(data, "carryOverRefs", { fromDate: "2026-09-19", toDate: "2026-09-20" }, K.slotBeginnMs("2026-09-20", "briefing04")), "carry");
  const refs = data.dailyBriefing.assistantRuns["2026-09-20"].itemRefs;
  // Offen geblieben: der Lead l1 und die noch nicht faellige Aufgabe t2; t1 und c1 sind erledigt.
  assert.deepEqual(refs.map((r) => r.sourceType + ":" + r.sourceId).sort(), ["chatgptLead:l1", "task:t2"]);
  for (const ref of refs) {
    assert.equal(ref.carriedFrom, "2026-09-19");
    assert.deepEqual(Object.keys(ref).sort(), ["carriedFrom", "includedAt", "sourceId", "sourceType"]);
  }
  assert.equal(JSON.stringify(data.entities.tasks), tasksVorher);
  assert.equal(JSON.stringify(data.entities.chatgptLeads), leadsVorher);
  assert.equal(run(data, "addItemRef", { date: "2026-09-20", sourceType: "chatgptLead", sourceId: "gibtsnicht" }, now).error, "SOURCE_NOT_FOUND");
  assert.equal(run(data, "addItemRef", { date: "2026-09-20", sourceType: "chatgptLead", sourceId: "l1" }, now).created, false);
});

/* ══ Lease ═══════════════════════════════════════════════════════════════ */
test("Lease: nur ein Halter, Ablauf sichtbar", () => {
  let d = migriert();
  d = mussOk(run(d, "acquireLease", { holder: "runner-a", ttlMs: 10 * MIN }, NOW), "a");
  assert.equal(run(d, "acquireLease", { holder: "runner-b", ttlMs: 10 * MIN }, NOW + MIN).error, "LEASE_HELD");
  d = mussOk(run(d, "acquireLease", { holder: "runner-b", ttlMs: 10 * MIN }, NOW + 11 * MIN), "b nach Ablauf");
  assert.equal(run(d, "releaseLease", { holder: "runner-a" }, NOW + 12 * MIN).error, "LEASE_NOT_HOLDER");
  d = mussOk(run(d, "releaseLease", { holder: "runner-b" }, NOW + 12 * MIN), "release");
  assert.equal(d.automation.activeLease, null);
  // Serialisierung: wieder ein JSON-String des Vollbestands, parse → gleicher Kern.
  const text = K.serializeCore(d);
  const zurueck = K.parseCoreDocument({ exists: true, data: text });
  assert.equal(JSON.stringify(K.requireCore(zurueck)), text);
});
