/*
 * Tagesbriefing v3 — der serverseitige Datenkern, gegen eine gestellte Uhr.
 * ---------------------------------------------------------------------------
 * Paket B (Datenmodell, Migration, Ampel, Fragen/Antworten/Dokumente/Jobs,
 * Abschluss). Alles Aeussere (Uhr, Ids, Policy, Aufrufer) kommt als
 * Parameter herein — der Test faehrt die ECHTEN Funktionen, ohne Netz.
 *
 * Die Tests R1–R11 sind die adversarialen Regressionen aus dem Review vom
 * 19.09.2026 (590dc78, elf reproduzierte Luecken), jeweils mit dem dort
 * beschriebenen konkreten Ablauf. Dazu: Lease entfernt (Paket E1), Kern
 * ohne node:crypto (browserfaehig), Idempotenz nur im Transaktionsumschlag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as K from "../netlify/lib/assistant-core.mjs";
import { attSegEncode } from "../netlify/lib/blob-key-policy.mjs";

const T = (s) => Date.parse(s);
const MIN = 60 * 1000;
const STD = 60 * MIN;
const H64 = "a".repeat(64);
const ATT = (name) => "attachment-text__" + attSegEncode("chatgptLead") + "__" + attSegEncode("l1") + "__" + attSegEncode(name);

const POLICY = Object.freeze({
  ...K.POLICY_TEMPLATE,
  tenant: "laurin",
  requiredSources: [{ id: "quantus-core", kind: "quantus-core" }, { id: "gmail-inbox", kind: "mail" }],
});
const AGENT = { kind: "agent", id: "chatgpt-run" };
const USER = { kind: "user", id: "laurin" };
const ADAPTER = { kind: "adapter", id: "gmail-adapter" };
const WORKER = { kind: "worker", id: "gemini-worker" };
const SYSTEM = { kind: "system", id: "scheduler" };

function bestand() {
  const t0 = "2026-09-18T10:00:00.000Z";
  const lead = (id, extra) => ({
    id, title: "Kunden anlegen", rawInput: "…", status: "in_arbeit", readAt: t0, assignee: "chatgpt",
    interpretation: "Neue Organisation", research: "gesucht", plan: "anlegen", execution: "angelegt", result: "#/organizations/abc",
    assessment: { menge: "chatgpt", werkzeug: "chatgpt", kontext: "chatgpt", quantusNaehe: "chatgpt", recherche: "cowork", zuschnitt: "cowork" },
    assignmentReason: "klein", linkedOrganizations: ["abc"], createdAt: t0, updatedAt: t0, comments: [], ...extra,
  });
  return {
    entities: {
      tasks: {
        t1: { id: "t1", title: "Rechnung zahlen", status: "todo", dueDate: "2026-09-19", assignee: "Anna", createdAt: t0, updatedAt: t0, comments: [] },
        t2: { id: "t2", title: "Spaeter", status: "todo", dueDate: "2026-10-30", createdAt: t0, updatedAt: t0, comments: [] },
      },
      projects: { p1: { id: "p1", title: "Umzug", status: "active", deadlines: [{ id: "d1", title: "Kuendigung", date: "2026-09-10", done: true }], createdAt: t0, updatedAt: t0 } },
      notes: { nf1: { id: "nf1", title: "NoteFlow bleibt", content: "unberuehrt" } },
      chatgptNotes: {},
      chatgptLeads: {
        l1: lead("l1"),
        l2: lead("l2", { status: "abgeschlossen", closedAt: t0, closedBy: "assistant" }),
      },
      chatgptTasks: { c1: { id: "c1", text: "Namen ergaenzen", state: "offen", anchorKind: "organization", anchorId: "o1", createdAt: t0, updatedAt: t0 } },
    },
    journal: { documents: [{ id: "j1", content: "bleibt" }] },
    mobilePushes: [{ id: "mp1" }],
    dailyBriefing: { routines: [{ id: "r1", text: "Wasser" }], dailyLog: { "2026-09-18": { notes: "x" } } },
    _deleteLog: { tasks: { t9: 1758000000000 } },
    fremdesFeld: { a: 1 },
  };
}

const NOW = T("2026-09-19T08:00:00+02:00");
const migriert = (d = bestand()) => K.migrateCore(d, { now: NOW }).data;

let cmdN = 0;
const cmd = (type, payload, now) => ({ type, commandId: "cmd_" + String(++cmdN).padStart(8, "0"), now, payload });
const run = (data, type, payload, now, actor = AGENT) => K.applyCommand(data, cmd(type, payload, now), { policy: POLICY, actor });
function mussOk(r, was) { assert.equal(r.ok, true, `${was}: ${r.error} ${JSON.stringify(r.detail)}`); return r.data; }
const ver = (data, sourceType, id) => K.effektiverZustand(sourceType, K.quelleFinden(data, sourceType, id)).version;
const hatCode = (ev, code, id) => ev.reasons.some((r) => r.code === code && (id == null || r.sourceId === id));
const ampel = (data, date, now) => K.dailyAssistantTrafficLight(data.dailyBriefing.assistantRuns[date], data, now, POLICY);

/* Beleg vom Adapter + Abschluss ueber transitionState (mit Version). */
function erledigen(data, sourceType, id, now, actor = AGENT) {
  if (sourceType === "task") {
    return mussOk(run(data, "transitionState", { sourceType, sourceId: id, state: "done", expectedVersion: ver(data, sourceType, id) }, now, USER), "done " + id);
  }
  const evId = "ev_done_" + id;
  data = mussOk(run(data, "registerEvidence", { evidenceId: evId, kind: "message", ref: "msg_" + id, sourceType, sourceId: id, origin: { adapter: "gmail", ref: "thread_" + id }, observedAt: new Date(now - MIN).toISOString(), fingerprint: "fp_" + id + "_0123456789abcdef" }, now, ADAPTER), "evidence " + id);
  return mussOk(run(data, "transitionState", { sourceType, sourceId: id, state: "done", expectedVersion: ver(data, sourceType, id), evidence: { kind: "evidence", evidenceId: evId } }, now, actor), "done " + id);
}

/* Einen Tag aufbauen: Lauf, Startnotiz, Quittungen, Quellen frisch, offene
 * Elemente im Lauf. Danach optional alles erledigen. */
function tagAufbauen(data, { date = "2026-09-19", bis = "23:05", erledigt = false } = {}) {
  const [h, m] = bis.split(":").map(Number);
  const now = K.wandzeitZuMs(date, h, m);
  data = mussOk(run(data, "ensureRun", { date }, K.slotBeginnMs(date, "briefing04") + MIN), "ensureRun");
  data = mussOk(run(data, "ensureStartNote", { date, noteId: "note_start_" + date }, K.slotBeginnMs(date, "briefing04") + 2 * MIN), "start");
  for (const s of K.SLOT_KEYS) {
    const at = K.slotBeginnMs(date, s) + MIN;
    if (at > now) continue;
    data = mussOk(run(data, "recordSlotReceipt", { date, slot: s, receiptId: "rcpt_" + s + "_" + date }, at), "receipt " + s);
  }
  for (const s of POLICY.requiredSources) data = mussOk(run(data, "recordSourceCheck", { date, sourceId: s.id, cursor: "c1", outcome: "ok" }, now - 3 * MIN, ADAPTER), "source " + s.id);
  for (const [sourceType, q] of Object.entries(K.QUELLEN)) {
    for (const id of Object.keys(data.entities[q.store] || {})) {
      const z = K.effektiverZustand(sourceType, data.entities[q.store][id]);
      if (z.state === "done" || z.state === "cancelled") continue;
      data = mussOk(run(data, "addItemRef", { date, sourceType, sourceId: id }, now - 2 * MIN), "ref " + id);
    }
  }
  if (erledigt) {
    data = erledigen(data, "chatgptLead", "l1", now - 2 * MIN);
    data = erledigen(data, "chatgptTask", "c1", now - 2 * MIN);
    data = erledigen(data, "task", "t1", now - 2 * MIN);
  }
  return { data, now, date };
}

/* ══ Kern lesen ══════════════════════════════════════════════════════════ */
test("fehlender, kaputter oder falsch geformter Kern ist ein Fehler, kein leerer Bestand (R9)", () => {
  assert.throws(() => K.parseCoreDocument(null), (e) => e.code === "CORE_MISSING");
  assert.throws(() => K.parseCoreDocument({ exists: false, data: null }), (e) => e.code === "CORE_MISSING");
  assert.throws(() => K.parseCoreDocument({ exists: true, data: "{nicht json" }), (e) => e.code === "CORE_UNPARSEABLE");
  assert.throws(() => K.parseCoreDocument(JSON.stringify({ irgendwas: 1 })), (e) => e.code === "CORE_NO_ENTITIES");
  assert.throws(() => K.parseCoreDocument(JSON.stringify({ entities: [] })), (e) => e.code === "CORE_NO_ENTITIES", "entities als Array wurde akzeptiert");
  assert.throws(() => K.parseCoreDocument(JSON.stringify({ entities: { tasks: [] } })), (e) => e.code === "CORE_STORE_CORRUPT");
  assert.throws(() => K.parseCoreDocument(JSON.stringify({ entities: {}, automation: "x" })), (e) => e.code === "CORE_AUTOMATION_CORRUPT");
  assert.throws(() => K.parseCoreDocument("[]"), (e) => e.code === "CORE_SHAPE");
  assert.throws(() => K.requireCore(bestand()), (e) => e.code === "CORE_NOT_MIGRATED");
  // requireCore prueft alle Karten und Revisionszahlen — nichts wird geleert.
  const d = migriert();
  for (const [pfad, wert, code] of [
    ["automation.dataRevision", -1, "CORE_REVISION_CORRUPT"], ["automation.dataRevision", 1.5, "CORE_REVISION_CORRUPT"],
    ["automation.questionsById", [], "CORE_AUTOMATION_CORRUPT"], ["automation.evidenceById", null, "CORE_AUTOMATION_CORRUPT"],
    ["automation.migration", null, "CORE_NOT_MIGRATED"], ["dailyBriefing.assistantRuns", [], "CORE_RUNS_CORRUPT"],
    ["entities.chatgptLeads.l1", "kaputt", "CORE_STORE_CORRUPT"],
  ]) {
    const k = K.klon(d);
    const teile = pfad.split("."); let o = k; for (const t of teile.slice(0, -1)) o = o[t]; o[teile.at(-1)] = wert;
    assert.throws(() => K.requireCore(k), (e) => e.code === code, pfad + " → " + code);
    const r = K.applyCommand(k, cmd("ensureRun", { date: "2026-09-19" }, NOW), { policy: POLICY, actor: AGENT });
    assert.equal(r.ok, false, pfad); assert.equal(r.data, k, "bei Fehler bleibt die Eingabe unveraendert");
  }
  const kaputtRun = K.klon(d); kaputtRun.dailyBriefing.assistantRuns["2026-09-19"] = { date: "2026-09-19", phase: "sonstwas" };
  assert.throws(() => K.requireCore(kaputtRun), (e) => e.code === "CORE_RUN_CORRUPT");
  assert.throws(() => K.migrateCore(bestand(), {}), TypeError);
});

/* ══ R2 / T12: Migration ═════════════════════════════════════════════════ */
test("Migration ist idempotent, versioniert und einmalig; Fremdes und _deleteLog bleiben", () => {
  const original = bestand();
  const vorher = JSON.stringify(original);
  const m1 = K.migrateCore(original, { now: NOW });
  assert.equal(JSON.stringify(original), vorher, "die Eingabe wurde veraendert");
  assert.equal(m1.changed, true);
  assert.equal(m1.data.automation.schemaVersion, K.SCHEMA_VERSION);
  assert.equal(m1.data.automation.migration.stateModel, K.STATE_MODEL_VERSION);
  assert.deepEqual(m1.data.dailyBriefing.assistantRuns, {});
  for (const k of ["_deleteLog", "fremdesFeld", "journal", "mobilePushes"]) assert.deepEqual(m1.data[k], original[k], k);
  assert.deepEqual(m1.data.dailyBriefing.routines, original.dailyBriefing.routines);
  for (const k of K.AUTOMATION_KARTEN) assert.deepEqual(m1.data.automation[k], {}, k);
  assert.equal(m1.data.automation.activeLease, null);
  const m2 = K.migrateCore(m1.data, { now: NOW + 5 * STD });
  assert.equal(m2.changed, false);
  assert.equal(JSON.stringify(m2.data), JSON.stringify(m1.data));
  // Ein vollstaendiger v3-Kern mit fremden Zusatzfeldern bleibt bei erneuter Migration erhalten (nichts wird ersetzt).
  const voll = K.klon(m1.data); voll.automation.eigenes = true; voll.automation.dataRevision = 7;
  const m3 = K.migrateCore(voll, { now: NOW });
  assert.equal(m3.changed, false); assert.equal(m3.report.mode, "repeat");
  assert.equal(m3.data.automation.dataRevision, 7); assert.equal(m3.data.automation.eigenes, true);
  // Partielle v3-Spuren werden NICHT als Erstmigration geheilt (B3-01, siehe eigener Test).
  const partiell = bestand(); partiell.automation = { schemaVersion: 3, dataRevision: 7, intakeById: { i1: { id: "i1", status: "open", text: "x" } }, eigenes: true };
  assert.throws(() => K.migrateCore(partiell, { now: NOW }), (e) => e.code === "CORE_PARTIAL_V3" && e.status === 503);
});

test("R2: 'wartet' ohne Ursache wird nicht geraten; unbekannt/mehrdeutig sind Migrationskonflikte; Rollen explizit; nie erneut aus Altfeldern", () => {
  const d = bestand();
  const t0 = "2026-09-01T00:00:00Z";
  d.entities.chatgptLeads.l3 = { id: "l3", status: "irgendwas_altes", readAt: null, createdAt: t0, updatedAt: t0 };
  d.entities.chatgptLeads.l4 = { id: "l4", status: "in_arbeit", readAt: t0, assignee: "cowork", handoverAt: "2026-09-02T00:00:00Z", returnedAt: null, createdAt: t0, updatedAt: t0 };
  d.entities.chatgptLeads.l5 = { ...d.entities.chatgptLeads.l4, id: "l5", returnedAt: "2026-09-03T00:00:00Z" };
  d.entities.chatgptLeads.l6 = { id: "l6", status: "abgeschlossen", closedBy: "laurin", obsoleteReason: "hinfaellig", readAt: null, createdAt: t0, updatedAt: t0 };
  d.entities.chatgptLeads.l7 = { id: "l7", status: "wartet", blockedReason: "Antwort der Bank", readAt: t0, createdAt: t0, updatedAt: t0 };
  d.entities.tasks.t3 = { id: "t3", status: "waiting", title: "Antwort Amt", assignee: "Anna" };
  d.entities.tasks.t4 = { id: "t4", status: "bizarr", title: "?" };
  d.entities.chatgptTasks.c2 = { id: "c2", state: "wartet", blockedReason: "fehlt Name" };
  const m = K.migrateCore(d, { now: NOW });
  const L = m.data.entities.chatgptLeads;
  assert.equal(L.l1.operationalState, "doing"); assert.equal(L.l1.operationalStateVersion, 1);
  assert.equal(L.l2.operationalState, "done");
  assert.equal(L.l4.operationalState, "delegated");
  assert.equal(L.l5.operationalState, "review");
  assert.equal(L.l6.operationalState, "cancelled");
  // wartet / waiting: NICHT waiting_user/waiting_external, sondern sichtbar ungeloest.
  for (const [e, why] of [[L.l7, "ambiguous"], [m.data.entities.tasks.t3, "ambiguous"], [m.data.entities.chatgptTasks.c2, "ambiguous"], [L.l3, "unknown"], [m.data.entities.tasks.t4, "unknown"]]) {
    assert.equal(e.operationalState, null, e.id);
    assert.equal(e.operationalStateUnmapped, why, e.id);
  }
  assert.deepEqual(m.data.automation.migration.conflicts.map((c) => c.kind + ":" + c.sourceId).sort(), ["ambiguous:c2", "ambiguous:l7", "ambiguous:t3", "unknown:l3", "unknown:t4"]);
  assert.deepEqual(m.report.ambiguousStates.map((c) => c.sourceId).sort(), ["c2", "l7", "t3"]);
  // Altstatus und menschlicher Assignee unangetastet; Rollen explizit am Objekt.
  assert.equal(L.l4.status, "in_arbeit"); assert.equal(m.data.entities.tasks.t3.status, "waiting"); assert.equal(m.data.entities.tasks.t3.assignee, "Anna");
  assert.deepEqual(m.data.entities.tasks.t1.operationalRoles, { accountable: "user", executor: "user" });
  assert.deepEqual(L.l4.operationalRoles, { accountable: "chatgpt", executor: "claude" });
  assert.deepEqual(L.l1.operationalRoles, { accountable: "chatgpt", executor: "openai" });
  assert.deepEqual(L.l7.operationalRoles, { accountable: "chatgpt", executor: null });
  assert.equal(K.rollenFuer("chatgptLead", L.l4).explicit, true);
  // Ampel: Konflikte rot mit Quell-Id; setWaiting/transition aus dem Konflikt nur zur Klaerung.
  const ev = K.dailyAssistantTrafficLight(K.leererRun("2026-09-19", "3.0"), m.data, NOW, POLICY);
  assert.ok(hatCode(ev, "UNKNOWN_LEGACY_STATE", "l3")); assert.ok(hatCode(ev, "AMBIGUOUS_LEGACY_STATE", "l7")); assert.ok(hatCode(ev, "AMBIGUOUS_LEGACY_STATE", "t3"));
  assert.equal(run(m.data, "transitionState", { sourceType: "chatgptLead", sourceId: "l7", state: "review", expectedVersion: 1 }, NOW).error, "UNMAPPED_NEEDS_CLARIFICATION");
  const geklaert = mussOk(run(m.data, "transitionState", { sourceType: "chatgptLead", sourceId: "l7", state: "doing", expectedVersion: 1, reason: "geklaert: Bank hat geantwortet" }, NOW), "klaeren");
  assert.equal(geklaert.entities.chatgptLeads.l7.operationalState, "doing");
  assert.equal(geklaert.entities.chatgptLeads.l7.operationalStateUnmapped, undefined);
  const m4 = K.migrateCore(geklaert, { now: NOW + STD });
  assert.deepEqual(m4.data.automation.migration.conflicts.map((c) => c.sourceId).sort(), ["c2", "l3", "t3", "t4"], "geklaerter Konflikt verschwindet aus der Liste");
  // Eine spaetere Migration liest NIE wieder die Altfelder: Client aendert l3 auf in_arbeit → bleibt Konflikt.
  const geaendert = K.klon(m.data); geaendert.entities.chatgptLeads.l3.status = "in_arbeit";
  const m5 = K.migrateCore(geaendert, { now: NOW + STD });
  assert.equal(m5.data.entities.chatgptLeads.l3.operationalState, null);
  assert.equal(m5.data.entities.chatgptLeads.l3.operationalStateUnmapped, "unknown");
});

/* ══ R1: operationalState fuehrend, Altstatus nur Ableitung ══════════════ */
test("R1: ein nach der Migration geaenderter Altstatus 'abgeschlossen' macht kein done — Drift ist sichtbar; Uebergaenge brauchen Version und Beleg", () => {
  let { data, now, date } = tagAufbauen(migriert());
  // Alter Client schreibt status=abgeschlossen an l1 (operationalState doing).
  const drift = K.klon(data);
  drift.entities.chatgptLeads.l1.status = "abgeschlossen"; drift.entities.chatgptLeads.l1.closedAt = new Date(now).toISOString();
  const z = K.effektiverZustand("chatgptLead", drift.entities.chatgptLeads.l1);
  assert.equal(z.state, "doing", "der Altstatus hat den Serverzustand veraendert");
  assert.deepEqual(z.drift, { legacyNow: "abgeschlossen", legacyAtMapping: "in_arbeit", expected: "in_arbeit" });
  let ev = ampel(drift, date, now);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "LEGACY_DRIFT", "l1")); assert.ok(hatCode(ev, "ITEM_OPEN", "l1"));
  // Umgekehrt: Altstatus zurueck auf in_arbeit nach done → Drift, aber done bleibt done.
  let fertig = erledigen(data, "chatgptLead", "l1", now);
  assert.equal(fertig.entities.chatgptLeads.l1.status, "in_arbeit", "der Altstatus wird in diesem Paket nicht zurueckgeschrieben");
  assert.equal(K.effektiverZustand("chatgptLead", fertig.entities.chatgptLeads.l1).drift, null, "der zur Migration gehoerende Altwert ist keine Drift");
  const zurueck = K.klon(fertig); zurueck.entities.chatgptLeads.l1.status = "neu";
  assert.equal(K.effektiverZustand("chatgptLead", zurueck.entities.chatgptLeads.l1).state, "done");
  assert.ok(hatCode(ampel(zurueck, date, now), "LEGACY_DRIFT", "l1"));
  // transitionState: Version Pflicht, Matrix, Beleg fuer done; ein gesetzter Altstatus ist keine Freigabe.
  assert.equal(run(drift, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done" }, now).error, "VERSION_REQUIRED");
  assert.equal(run(drift, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 99 }, now).error, "VERSION_MISMATCH");
  assert.equal(run(drift, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 1 }, now).error, "DONE_EVIDENCE_MISSING");
  assert.equal(run(drift, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 1, evidence: { kind: "evidence", evidenceId: "gibtsnicht" } }, now).error, "DONE_EVIDENCE_FOREIGN");
  assert.equal(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "waiting_external", expectedVersion: 1 }, now).error, "USE_SET_WAITING");
  assert.equal(run(fertig, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "review", expectedVersion: 2 }, now).error, "TRANSITION_NOT_ALLOWED");
  assert.equal(run(fertig, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: 2 }, now).error, "REOPEN_NEEDS_REASON");
  const wieder = mussOk(run(fertig, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: 2, reason: "Kunde meldet Fehler" }, now), "reopen");
  assert.equal(wieder.entities.chatgptLeads.l1.operationalStateVersion, 3);
  // Beleg eines FREMDEN Elements zaehlt nicht; unvollstaendiger Lead nicht; cancel eines Leads nur der Nutzer; Aufgabe schliesst der Nutzer.
  const evFremd = mussOk(run(data, "registerEvidence", { evidenceId: "ev_l2", kind: "mail", ref: "m", sourceType: "chatgptLead", sourceId: "l2", origin: { adapter: "gmail", ref: "x" }, observedAt: new Date(now - MIN).toISOString(), fingerprint: "0123456789abcdef0123" }, now, ADAPTER), "ev");
  assert.equal(run(evFremd, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 1, evidence: { kind: "evidence", evidenceId: "ev_l2" } }, now).error, "DONE_EVIDENCE_FOREIGN");
  const unvoll = K.klon(evFremd); unvoll.entities.chatgptLeads.l1.result = "";
  const u = run(mussOk(run(unvoll, "registerEvidence", { evidenceId: "ev_l1", kind: "mail", ref: "m", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "x" }, observedAt: new Date(now - MIN).toISOString(), fingerprint: "0123456789abcdef0123" }, now, ADAPTER), "ev"), "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 1, evidence: { kind: "evidence", evidenceId: "ev_l1" } }, now);
  assert.equal(u.error, "LEAD_INCOMPLETE"); assert.deepEqual(u.detail, ["result"]);
  assert.equal(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "cancelled", expectedVersion: 1, reason: "hinfaellig" }, now, AGENT).error, "CANCEL_REQUIRES_USER");
  assert.equal(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "cancelled", expectedVersion: 1, reason: "hinfaellig" }, now, USER).ok, true);
  assert.equal(run(data, "transitionState", { sourceType: "task", sourceId: "t1", state: "done", expectedVersion: 1 }, now, AGENT).error, "DONE_EVIDENCE_MISSING", "der Agent schliesst keine Nutzeraufgabe ohne Beleg");
  const tDone = mussOk(run(data, "transitionState", { sourceType: "task", sourceId: "t1", state: "done", expectedVersion: 1 }, now, USER), "user done");
  assert.equal(tDone.entities.tasks.t1.assignee, "Anna"); assert.equal(tDone.entities.tasks.t1.status, "todo");
});

/* ══ Policy: feste Sicherheitsvorgaben (R10) ═════════════════════════════ */
test("R10: Policy laesst 23:00, 09+23, 15 Minuten und die Quantus-Kernquelle nicht lockern", () => {
  assert.equal(K.validatePolicy(POLICY).ok, true);
  assert.equal(K.validatePolicy(K.POLICY_TEMPLATE).ok, false);
  const faelle = [
    [{ ...POLICY, sourceMaxAgeMinutes: 60 }, "POLICY_SOURCE_MAX_AGE_MINUTES_ABOVE_LIMIT"],
    [{ ...POLICY, closure: { earliestLocalTime: "08:00", requiredReceipts: ["process09", "close23"] } }, "POLICY_CLOSURE_TOO_EARLY"],
    [{ ...POLICY, closure: { earliestLocalTime: "23:00", requiredReceipts: ["briefing04"] } }, "POLICY_CLOSURE_RECEIPT_REQUIRED:process09"],
    [{ ...POLICY, closure: { earliestLocalTime: "23:00", requiredReceipts: ["process09", "close23", "mittag"] } }, "POLICY_CLOSURE_RECEIPTS_INVALID"],
    [{ ...POLICY, closure: { earliestLocalTime: "25:99", requiredReceipts: ["process09", "close23"] } }, "POLICY_CLOSURE_TIME_INVALID"],
    [{ ...POLICY, requiredSources: [{ id: "gmail-inbox", kind: "mail" }] }, "POLICY_CORE_SOURCE_REQUIRED"],
    [{ ...POLICY, requiredSources: [{ id: "quantus-core", kind: "quantus-core" }] }, "POLICY_SOURCES_NOT_CONFIGURED"],
    [{ ...POLICY, requiredSources: [], noExternalSources: true }, "POLICY_CORE_SOURCE_REQUIRED"],
    [{ ...POLICY, deferralLimit: 10 }, "POLICY_DEFERRAL_LIMIT_ABOVE_LIMIT"],
    [{ ...POLICY, featureFlags: { writes: "yolo", runner: "dry_run", providers: "dry_run" } }, "POLICY_FLAG_WRITES"],
    [{ ...POLICY, timezone: "UTC" }, "POLICY_TIMEZONE"],
  ];
  for (const [p, code] of faelle) {
    const v = K.validatePolicy(p);
    assert.equal(v.ok, false, code); assert.ok(v.errors.includes(code), code + ": " + v.errors);
    const ev = K.dailyAssistantTrafficLight(K.leererRun("2026-09-19", "3.0"), migriert(), NOW, p);
    assert.equal(ev.operations, "red"); assert.ok(hatCode(ev, "POLICY_INCOMPLETE"));
  }
  assert.equal(K.validatePolicy({ ...POLICY, requiredSources: [{ id: "quantus-core", kind: "quantus-core" }], noExternalSources: true }).ok, true, "nur der Kern, ausdruecklich ohne externe Quellen, ist gueltig");
  assert.equal(K.applyCommand(migriert(), cmd("ensureRun", { date: "2026-09-19" }, NOW), { policy: null, actor: AGENT }).error, "POLICY_INVALID");
  // Abschluss ohne Startnotiz, ohne Kernquelle und ausserhalb 23:00–04:00 blockiert.
  const s = tagAufbauen(migriert(), { erledigt: true });
  const ohneStart = K.klon(s.data); ohneStart.dailyBriefing.assistantRuns[s.date].startNoteId = null;
  let r = run(ohneStart, "closeRun", { date: s.date, finalNoteId: "n1" }, s.now);
  assert.equal(r.error, "CLOSURE_BLOCKED"); assert.ok(r.detail.some((b) => b.code === "START_NOTE_MISSING"));
  const ohneKern = K.klon(s.data); delete ohneKern.dailyBriefing.assistantRuns[s.date].sourceChecks["quantus-core"];
  r = run(ohneKern, "closeRun", { date: s.date, finalNoteId: "n1" }, s.now);
  assert.ok(r.detail.find((b) => b.code === "OPERATIONS_NOT_GREEN").detail.some((x) => x.code === "SOURCE_NOT_CHECKED" && x.sourceId === "quantus-core"));
  const frueh = tagAufbauen(migriert(), { erledigt: true, bis: "22:59" });
  r = run(frueh.data, "closeRun", { date: frueh.date, finalNoteId: "n1" }, frueh.now);
  assert.ok(r.detail.some((b) => b.code === "CLOSURE_TOO_EARLY"));
  assert.ok(r.detail.some((b) => b.code === "RECEIPT_MISSING" && b.detail === "close23"));
});

/* ══ T13: ausgelassener Lead / nicht geprüfte Seite ══════════════════════ */
test("ein ausgelassener Lead oder eine nicht geprüfte Quelle kann nicht gruen werden; gelb vor Faelligkeit, rot faellig (R5)", () => {
  let { data, now, date } = tagAufbauen(migriert(), { erledigt: true });
  let ev = ampel(data, date, now);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons)); assert.equal(ev.operations, "green", JSON.stringify(ev.reasons));
  // Nicht faellige Aufgabe t2 ist offen, aber nicht faellig → nicht rot, nicht im Lauf noetig.
  assert.ok(!ev.reasons.some((r) => r.sourceId === "t2"));
  // Ein migrierter Lead, den der Lauf nicht kennt: rot (nicht in itemRefs) + gelb offen.
  const mitLead = K.migrateCore({ ...K.klon(data), entities: { ...K.klon(data.entities), chatgptLeads: { ...data.entities.chatgptLeads, l9: { id: "l9", title: "Vergessen", status: "in_arbeit", readAt: "2026-09-19T10:00:00Z", assignee: "chatgpt", createdAt: "2026-09-19T10:00:00Z", updatedAt: "2026-09-19T10:00:00Z" } } } }, { now }).data;
  ev = ampel(mitLead, date, now);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "ITEM_NOT_IN_RUN", "l9")); assert.ok(ev.reasons.some((r) => r.code === "ITEM_OPEN" && r.sourceId === "l9" && r.severity === "yellow"));
  // Nicht migriert (kein operationalStateSource) → NOT_MIGRATED rot, nie uebersprungen.
  const roh = K.klon(data); roh.entities.chatgptLeads.l9 = { id: "l9", status: "in_arbeit", readAt: "x" };
  assert.ok(hatCode(ampel(roh, date, now), "NOT_MIGRATED", "l9"));
  // Ungelesener Lead = ungeklaerter Eingang.
  const ungelesen = K.klon(mitLead); ungelesen.entities.chatgptLeads.l9.readAt = null;
  assert.ok(hatCode(ampel(ungelesen, date, now), "INTAKE_UNCLARIFIED", "l9"));
  // Doing-Element MIT Faelligkeit ist rot: t1 wieder oeffnen (Nutzer).
  const offen = mussOk(run(data, "transitionState", { sourceType: "task", sourceId: "t1", state: "doing", expectedVersion: 2, reason: "doch nicht" }, now, USER), "reopen");
  ev = ampel(offen, date, now);
  assert.ok(ev.reasons.some((r) => r.code === "ITEM_DUE_OPEN" && r.sourceId === "t1" && r.severity === "red"));
  // Quellen: nicht geprueft, stale, Stoerungen — je mit Quell-Id.
  const ohneQuelle = K.klon(data); delete ohneQuelle.dailyBriefing.assistantRuns[date].sourceChecks["gmail-inbox"];
  ev = ampel(ohneQuelle, date, now); assert.equal(ev.operations, "red"); assert.ok(hatCode(ev, "SOURCE_NOT_CHECKED", "gmail-inbox"));
  assert.ok(hatCode(ampel(data, date, now + 20 * MIN), "SOURCE_STALE", "gmail-inbox"));
  for (const [outcome, code] of [["auth_error", "SOURCE_AUTH_ERROR"], ["budget_exceeded", "SOURCE_BUDGET_EXCEEDED"], ["unreachable", "SOURCE_UNREACHABLE"]]) {
    const g = mussOk(run(data, "recordSourceCheck", { date, sourceId: "gmail-inbox", cursor: "c2", outcome }, now, ADAPTER), outcome);
    assert.ok(hatCode(ampel(g, date, now), code, "gmail-inbox"), code);
  }
  assert.equal(run(data, "recordSourceCheck", { date, sourceId: "gmail-inbox", cursor: "c2", outcome: "ok" }, now, AGENT).error, "ACTOR_REJECTED", "ein Agent bestaetigt keine Quelle");
  const mitFrist = K.klon(data); mitFrist.entities.projects.p1.deadlines.push({ id: "d2", title: "Schluessel", date: "2026-09-19", done: false });
  assert.ok(hatCode(ampel(mitFrist, date, now), "PROJECT_DEADLINE_DUE", "p1"));
  ev = ampel(data, date, now);
  assert.equal(ev.evaluatedRevision, data.automation.dataRevision);
  assert.ok(Date.parse(ev.validUntil) > now && Date.parse(ev.validUntil) <= now + 15 * MIN);
  // Unbekannte Kartenzustaende werden nicht durch continue gruen (R9).
  for (const [karte, wert] of [["intakeById", { id: "x", status: "whatever" }], ["jobsById", { id: "x", state: "sonst" }], ["documentsById", { id: "x", status: 7 }], ["questionsById", { id: "x", status: "" }]]) {
    const k = K.klon(data); k.automation[karte].x = wert;
    const e2 = ampel(k, date, now);
    assert.equal(e2.coverage, "red", karte); assert.ok(hatCode(e2, "CARD_STATE_UNKNOWN", "x"), karte);
  }
});

test("eine gespeicherte Bewertung gilt nur bis validUntil und nur fuer denselben Bestand; kein node:crypto im Kern", async () => {
  const { data, now, date } = tagAufbauen(migriert(), { erledigt: true });
  const ev = ampel(data, date, now);
  assert.equal(ev.overall, "green");
  const ctxOf = (d, t) => ({ run: d.dailyBriefing.assistantRuns[date], data: d, now: t, policy: POLICY });
  assert.equal(K.isEvaluationCurrent(ev, ctxOf(data, now + MIN)).current, true);
  assert.equal(K.isEvaluationCurrent(ev, ctxOf(data, Date.parse(ev.validUntil))).reason, "EVALUATION_EXPIRED");
  const geaendert = K.klon(data); geaendert.entities.chatgptLeads.l1.updatedAt = new Date(now + MIN).toISOString();
  assert.equal(K.isEvaluationCurrent(ev, ctxOf(geaendert, now + MIN)).reason, "DATA_CHANGED");
  const mutiert = mussOk(run(data, "registerIntake", { intakeId: "in_1", text: "Neu", channel: "mobile" }, now + MIN, USER), "intake");
  assert.equal(K.isEvaluationCurrent(ev, ctxOf(mutiert, now + MIN)).reason, "REVISION_CHANGED");
  assert.equal(K.isEvaluationCurrent(ev, { ...ctxOf(data, now + MIN), policy: { ...POLICY, version: "3.1" } }).reason, "POLICY_CHANGED");
  assert.equal(K.isEvaluationCurrent(ev, { ...ctxOf(data, now + MIN), run: null }).reason, "CONTEXT_MISSING");
  assert.equal(K.stringFingerprint("abc").length, 32); assert.notEqual(K.stringFingerprint("abc"), K.stringFingerprint("abd"));
  const fs = await import("node:fs");
  for (const f of ["zeit", "schema", "migration", "buchhaltung", "ampel", "abschluss", "core"]) {
    const src = fs.readFileSync(new URL("../netlify/lib/assistant-" + f + ".mjs", import.meta.url), "utf8");
    assert.ok(!/from\s+["']node:/.test(src) && !/require\(/.test(src), f + " importiert Node-Module");
  }
});

/* ══ R4 / R5 / T14: Warten nur mit geprueftem Beleg ══════════════════════ */
test("R4: ein erfundener Beleg (mail/invented_nonexistent_mail) wird abgewiesen; Beleg nur ueber Adapter; fremde Frage/Job abgewiesen", () => {
  let { data, now, date } = tagAufbauen(migriert(), { erledigt: false });
  const basis = { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "waiting_external", counterparty: "Bank Muster AG", nextAction: "Antwort pruefen", followUpAt: new Date(now + 2 * 24 * STD).toISOString() };
  let r = run(data, "setWaiting", { ...basis, evidence: { kind: "mail", ref: "invented_nonexistent_mail" } }, now);
  assert.equal(r.error, "WAITING_INCOMPLETE"); assert.ok(r.detail.includes("WAIT_EVIDENCE_KIND_UNKNOWN"));
  r = run(data, "setWaiting", { ...basis, evidence: { kind: "evidence", evidenceId: "ev_invented" } }, now);
  assert.ok(r.detail.includes("WAIT_EVIDENCE_UNKNOWN"));
  r = run(data, "setWaiting", { ...basis, evidence: { kind: "url", ref: "https://bank.example/bestaetigung" } }, now);
  assert.ok(r.detail.includes("WAIT_EVIDENCE_KIND_UNKNOWN"), "eine URL im Text ist kein Beleg");
  // Der Agent kann keinen Beleg registrieren — nur ein Adapter.
  const beleg = { evidenceId: "ev_bank", kind: "mail", ref: "rfc822:<abc@bank.example>", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "msg_18f" }, observedAt: new Date(now - 5 * MIN).toISOString(), fingerprint: "sha256-0123456789abcdef" };
  assert.equal(run(data, "registerEvidence", beleg, now, AGENT).error, "ACTOR_REJECTED");
  assert.equal(run(data, "registerEvidence", beleg, now, USER).error, "ACTOR_REJECTED");
  assert.equal(K.applyCommand(data, cmd("registerEvidence", beleg, now), { policy: POLICY }).error, "ACTOR_REJECTED", "ohne Aufrufer laeuft nichts");
  assert.equal(run(data, "registerEvidence", { ...beleg, observedAt: new Date(now + STD).toISOString() }, now, ADAPTER).error, "EVIDENCE_OBSERVED_AT_INVALID");
  assert.equal(run(data, "registerEvidence", { ...beleg, fingerprint: "kurz" }, now, ADAPTER).error, "EVIDENCE_FINGERPRINT_INVALID");
  data = mussOk(run(data, "registerEvidence", beleg, now, ADAPTER), "beleg");
  assert.equal(run(data, "registerEvidence", { ...beleg, ref: "anderer" }, now, ADAPTER).error, "EVIDENCE_IMMUTABLE");
  // Beleg eines FREMDEN Leads (l2) hilft l1 nicht.
  data = mussOk(run(data, "registerEvidence", { ...beleg, evidenceId: "ev_l2", sourceId: "l2" }, now, ADAPTER), "beleg l2");
  r = run(data, "setWaiting", { ...basis, evidence: { kind: "evidence", evidenceId: "ev_l2" } }, now);
  assert.ok(r.detail.includes("WAIT_EVIDENCE_FOREIGN"));
  // Frage/Job eines fremden Elements ebenso (c1 und t1 werden zuvor erledigt, damit der Rest des Tages gruen werden kann).
  data = erledigen(data, "task", "t1", now);
  data = mussOk(run(data, "askQuestion", { questionId: "q_c1", sourceType: "chatgptTask", sourceId: "c1", text: "?" }, now), "q");
  r = run(data, "setWaiting", { ...basis, state: "waiting_user", counterparty: "user", evidence: { kind: "question", questionId: "q_c1" } }, now);
  assert.ok(r.detail.includes("WAIT_EVIDENCE_FOREIGN"));
  data = mussOk(run(data, "createJob", { jobId: "job_c1", kind: "recherche", purpose: "x", sourceType: "chatgptTask", sourceId: "c1", inputVersion: 1, executor: "gemini", contextRefs: [], expiresAt: new Date(now + STD).toISOString() }, now), "job c1");
  r = run(data, "setWaiting", { ...basis, state: "delegated", counterparty: "gemini", evidence: { kind: "job", jobId: "job_c1" } }, now);
  assert.ok(r.detail.includes("WAIT_EVIDENCE_FOREIGN"));
  data = mussOk(run(data, "cancelJob", { jobId: "job_c1", reason: "Test" }, now), "cancel");
  const nurQ = K.klon(data); nurQ.automation.questionsById.q_c1.status = "withdrawn";
  data = nurQ;
  // Passender Beleg → gruen, mit Beleg an der Karte; Kartenmanipulation faellt sofort auf (R5).
  data = mussOk(run(data, "setWaiting", { ...basis, evidence: { kind: "evidence", evidenceId: "ev_bank" } }, now), "wait");
  data = erledigen(data, "chatgptTask", "c1", now);
  let ev = ampel(data, date, now);
  assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  assert.deepEqual(data.automation.waitingById["chatgptLead:l1"].evidence, { kind: "evidence", evidenceId: "ev_bank", binding: "sha256-0123456789abcdef" });
  for (const [name, mut, code] of [
    ["waitingSince entfernt", (w) => { delete w.waitingSince; }, "WAIT_SINCE_INVALID"],
    ["waitingSince in der Zukunft", (w) => { w.waitingSince = new Date(now + STD).toISOString(); }, "WAIT_SINCE_INVALID"],
    ["nextAction entfernt", (w) => { delete w.nextAction; }, "WAIT_NEXT_ACTION_MISSING"],
    ["Gegenpartei entfernt", (w) => { w.counterparty = ""; }, "WAIT_COUNTERPARTY_MISSING"],
    ["Gegenpartei ist der Executor", (w) => { w.counterparty = "openai"; }, "WAIT_COUNTERPARTY_SELF"],
    ["Beleg gegen erfundenen getauscht", (w) => { w.evidence = { kind: "evidence", evidenceId: "ev_invented" }; }, "WAIT_EVIDENCE_UNKNOWN"],
    ["Beleg gegen fremden getauscht", (w) => { w.evidence = { kind: "evidence", evidenceId: "ev_l2" }; }, "WAIT_EVIDENCE_FOREIGN"],
    ["Bindung entfernt", (w) => { delete w.evidence.binding; }, "WAIT_EVIDENCE_CHANGED"],
    ["followUpAt vor waitingSince", (w) => { w.followUpAt = new Date(now - 2 * STD).toISOString(); w.waitingSince = new Date(now - STD).toISOString(); }, "WAIT_FOLLOWUP_BEFORE_SINCE"],
    ["followUpAt in 90 Tagen", (w) => { w.followUpAt = new Date(now + 90 * 24 * STD).toISOString(); }, "WAIT_FOLLOWUP_IMPLAUSIBLE"],
  ]) {
    const k = K.klon(data); mut(k.automation.waitingById["chatgptLead:l1"]);
    const e2 = ampel(k, date, now);
    assert.equal(e2.coverage, "red", name);
    assert.ok(e2.reasons.some((x) => x.code === "WAITING_INCOMPLETE" && x.sourceId === "l1" && x.detail.includes(code)), name + ": " + JSON.stringify(e2.reasons));
  }
  // Wartekarte geloescht → unbelegt; Element wartet laut Zustand → rot.
  const weg = K.klon(data); delete weg.automation.waitingById["chatgptLead:l1"];
  assert.ok(hatCode(ampel(weg, date, now), "WAITING_UNVERIFIED", "l1"));
  // Karte fuer ein Element, das gar nicht wartet → Leiche.
  const leiche = K.klon(data); leiche.automation.waitingById["chatgptLead:l2"] = K.klon(data.automation.waitingById["chatgptLead:l1"]);
  assert.ok(hatCode(ampel(leiche, date, now), "WAITING_CARD_ORPHAN", "l2"));
  // Harte Frist verschwindet nicht durch Warten: t1 wartet extern, ist aber heute faellig.
  let d2 = mussOk(run(data, "transitionState", { sourceType: "task", sourceId: "t1", state: "doing", expectedVersion: 2, reason: "offen" }, now, USER), "reopen");
  d2 = mussOk(run(d2, "registerEvidence", { ...beleg, evidenceId: "ev_t1", sourceType: "task", sourceId: "t1" }, now, ADAPTER), "ev t1");
  d2 = mussOk(run(d2, "setWaiting", { ...basis, sourceType: "task", sourceId: "t1", expectedVersion: 3, counterparty: "Vermieter", evidence: { kind: "evidence", evidenceId: "ev_t1" } }, now), "wait t1");
  ev = ampel(d2, date, now);
  assert.ok(ev.reasons.some((x) => x.code === "HARD_DEADLINE_DUE" && x.sourceId === "t1" && x.severity === "red"));
  // Nach followUpAt: Nachfassung faellig; Eigenarbeit ist kein Warten; Wartezustaende nur via setWaiting.
  assert.ok(hatCode(ampel(data, date, Date.parse(data.automation.waitingById["chatgptLead:l1"].followUpAt) + MIN), "FOLLOWUP_DUE", "l1"));
  r = run(data, "setWaiting", { ...basis, expectedVersion: 2, counterparty: "chatgpt", evidence: { kind: "evidence", evidenceId: "ev_bank" } }, now);
  assert.ok(r.detail.includes("WAIT_COUNTERPARTY_SELF"));
  for (const ref of data.dailyBriefing.assistantRuns[date].itemRefs) assert.deepEqual(Object.keys(ref).sort(), ["includedAt", "sourceId", "sourceType"]);
});

/* ══ R3 / T15: Deferrals ═════════════════════════════════════════════════ */
test("R3: drei Verschiebungen bleiben rot — Aenderung von execution/interpretation/…, Gegenparteiwechsel, Kommentar, Retry setzen nichts zurueck; nur ein neues verifiziertes Ereignis; setWaiting zaehlt atomar", () => {
  let { data, now, date } = tagAufbauen(migriert());
  const beleg = { evidenceId: "ev_bank", kind: "mail", ref: "rfc822:<abc@bank.example>", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "msg_18f" }, observedAt: new Date(now - 5 * MIN).toISOString(), fingerprint: "sha256-0123456789abcdef" };
  data = mussOk(run(data, "registerEvidence", beleg, now, ADAPTER), "beleg");
  const warte = (d, i, extra = {}) => mussOk(run(d, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: ver(d, "chatgptLead", "l1"), state: "waiting_external", counterparty: "Bank Muster AG", nextAction: "nachfragen (v" + i + ")", followUpAt: new Date(now + (i + 1) * 24 * STD).toISOString(), evidence: { kind: "evidence", evidenceId: "ev_bank" }, ...extra }, now + i * MIN), "wait " + i);
  data = warte(data, 0);
  assert.equal(data.automation.progressById["chatgptLead:l1"].deferrals, 0);
  // Drei Verschiebungen — ATOMAR in setWaiting, ohne observeSource — dazwischen Freitext-, Kommentar-, Titel-, Retry-Aenderungen.
  const fummel = (d, i) => { const k = K.klon(d); const l = k.entities.chatgptLeads.l1; l.execution = "Version " + i + " des Textes"; l.interpretation += " (neu)"; l.research += " (mehr)"; l.plan += " (anders)"; l.result += " (ergaenzt)"; l.title = "Umbenannt " + i; l.comments.push({ id: "k" + i, text: "dran" }); l.retryCount = i; l.updatedAt = new Date(now + i * MIN).toISOString(); return k; };
  for (let i = 1; i <= 3; i++) { data = fummel(data, i); data = warte(data, i, { counterparty: i === 2 ? "Bank Muster AG, Filiale Sued" : "Bank Muster AG" }); }
  assert.equal(data.automation.progressById["chatgptLead:l1"].deferrals, 3);
  let ev = ampel(data, date, now + 4 * MIN);
  assert.equal(ev.coverage, "red"); assert.ok(hatCode(ev, "DEFERRAL_LIMIT", "l1"));
  // observeSource nach weiterem Freitext: bleibt 3; Statusrundreise (doing → wieder warten) ebenfalls.
  data = fummel(data, 4);
  let o = run(data, "observeSource", { sourceType: "chatgptLead", sourceId: "l1" }, now + 5 * MIN);
  assert.equal(o.ok, true); assert.equal(o.data.automation.progressById["chatgptLead:l1"].deferrals, 3); data = o.data;
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: ver(data, "chatgptLead", "l1"), reason: "kurz selbst" }, now + 6 * MIN), "doing");
  data = warte(data, 6);
  assert.equal(data.automation.progressById["chatgptLead:l1"].deferrals, 4, "die Statusrundreise hat den Zaehler nicht zurueckgesetzt");
  // Der schon vorhandene Beleg ist kein neuer Fortschritt; ein zweiter Beleg desselben Inhalts unter neuer Id ist immutable-gleich, aber eine NEUE, vom Adapter registrierte Beobachtung setzt zurueck.
  o = run(data, "observeSource", { sourceType: "chatgptLead", sourceId: "l1" }, now + 7 * MIN);
  assert.equal(o.ok, true); assert.equal(o.noop, true, "der schon vorhandene Beleg ist kein neuer Fortschritt");
  data = mussOk(run(data, "registerEvidence", { ...beleg, evidenceId: "ev_bank_antwort", ref: "rfc822:<reply@bank.example>", fingerprint: "sha256-fedcba9876543210", observedAt: new Date(now + 7 * MIN).toISOString() }, now + 8 * MIN, ADAPTER), "antwort");
  o = run(data, "observeSource", { sourceType: "chatgptLead", sourceId: "l1" }, now + 9 * MIN);
  assert.equal(o.event, "progress"); assert.equal(o.data.automation.progressById["chatgptLead:l1"].deferrals, 0);
  assert.equal(data.entities.chatgptLeads.l1.deferrals, undefined, "der Zaehler lebt nur im Kern");
  // Aufgabe: dueDate dreimal nach hinten (Client), Titel/Kommentar/Assignee dazwischen → rot; Workflow-Text zaehlt NICHT als Fortschritt, eine konsumierte Nutzerantwort schon.
  data = mussOk(run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now), "t2 obs0");
  const schiebe = (d, tag, i) => { const k = K.klon(d); const t = k.entities.tasks.t2; t.dueDate = tag; t.title = "Spaeter " + i; t.comments.push({ id: "c" + i }); t.assignee = "Anna" + i; t.workflow = [{ id: "w" + i, done: true }]; return k; };
  let i = 0; for (const tag of ["2026-11-05", "2026-11-12", "2026-11-20"]) { data = schiebe(data, tag, ++i); data = mussOk(run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now + i * STD), "t2 obs" + i); }
  assert.equal(data.automation.progressById["task:t2"].deferrals, 3);
  assert.ok(hatCode(ampel(data, date, now + 3 * STD), "DEFERRAL_LIMIT", "t2"));
  data = mussOk(run(data, "askQuestion", { questionId: "q_t2", sourceType: "task", sourceId: "t2", text: "Bleibt der Termin?" }, now + 3 * STD), "q");
  data = mussOk(run(data, "recordAnswer", { answerId: "a_t2", questionId: "q_t2", text: "Ja, 20.11." }, now + 3 * STD + MIN, USER), "a");
  data = mussOk(run(data, "consumeAnswer", { answerId: "a_t2", consumer: "run" }, now + 3 * STD + 2 * MIN), "consume");
  o = run(data, "observeSource", { sourceType: "task", sourceId: "t2" }, now + 4 * STD);
  assert.equal(o.event, "progress"); assert.equal(o.data.automation.progressById["task:t2"].deferrals, 0);
});

/* ══ T16: Agentenbehauptung, Schutzfelder ════════════════════════════════ */
test("eine Behauptung des Agenten (overallGreen, operationalState:done, Schutzfelder) aendert das Urteil nicht", () => {
  const { data, now, date } = tagAufbauen(migriert());
  const runObj = K.klon(data.dailyBriefing.assistantRuns[date]);
  runObj.overallGreen = true; runObj.agentReport = { coverage: "green" }; runObj.userApproval = true;
  let ev = K.dailyAssistantTrafficLight(runObj, data, now, POLICY);
  assert.notEqual(ev.coverage, "green"); assert.ok(hatCode(ev, "ITEM_OPEN", "l1")); assert.ok(hatCode(ev, "AGENT_CLAIM_IGNORED"));
  // Direkt hingeschriebenes done am Element ohne Kommando (kein Abschlussbeleg in der Herkunft) → unbelegte Behauptung, rot; ohne Version zusaetzlich STATE_VERSION_INVALID.
  const beh = K.klon(data); beh.entities.chatgptLeads.l1.operationalState = "done"; delete beh.entities.chatgptLeads.l1.operationalStateVersion;
  ev = ampel(beh, date, now);
  assert.equal(ev.coverage, "red");
  assert.ok(hatCode(ev, "STATE_VERSION_INVALID", "l1")); assert.ok(hatCode(ev, "STATE_CLAIM_UNPROVEN", "l1"));
  const beh2 = K.klon(data); beh2.entities.chatgptLeads.l1.operationalState = "done"; beh2.entities.chatgptLeads.l1.operationalStateVersion = 2; beh2.entities.chatgptLeads.l1.operationalStateSource.changedAt = new Date(now).toISOString();
  assert.ok(hatCode(ampel(beh2, date, now), "STATE_CLAIM_UNPROVEN", "l1"));
  assert.ok(!hatCode(ampel(data, date, now), "STATE_CLAIM_UNPROVEN", "l2"), "ein in der Migration abgeschlossener Lead ist belegt");
  for (const [type, payload] of [
    ["recordSlotReceipt", { date, slot: "close23", receiptId: "r", finalAt: "2026-09-19T21:00:00Z" }],
    ["addItemRef", { date, sourceType: "chatgptLead", sourceId: "l1", overallGreen: true }],
    ["setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "waiting_external", counterparty: "x", nextAction: "y", followUpAt: "2026-09-20T10:00:00Z", evidence: { kind: "evidence", evidenceId: "e", userApproval: true } }],
    ["askQuestion", { questionId: "q_x", sourceType: "chatgptLead", sourceId: "l1", text: "?", phase: "final" }],
    ["transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 1, operationalStateVersion: 5 }],
    ["closeRun", { date, finalNoteId: "n", closureOutcomes: {} }],
    ["registerIntake", { intakeId: "i", text: "x", channel: "m", idempotencyByKey: {} }],
  ]) {
    const x = run(data, type, payload, now, type === "registerIntake" ? USER : AGENT);
    assert.equal(x.error, "COMMAND_REJECTED", type);
    assert.ok(x.detail.some((e) => e.startsWith("PAYLOAD_PROTECTED:") || e.startsWith("PAYLOAD_UNKNOWN:")), type + ": " + x.detail);
  }
  assert.equal(run(data, "nichtVorhanden", { date }, now).error, "COMMAND_REJECTED");
  assert.equal(K.applyCommand(data, { type: "ensureRun", commandId: "mit leerzeichen", now, payload: { date } }, { policy: POLICY, actor: AGENT }).error, "COMMAND_REJECTED");
  assert.equal(run(data, "recordAnswer", { answerId: "a", questionId: "q", text: "x" }, now, AGENT).error, "ACTOR_REJECTED", "der Agent schreibt keine Nutzerantwort");
  assert.equal(run(data, "recordJobReturn", { jobId: "j", outcome: "returned" }, now, AGENT).error, "ACTOR_REJECTED");
  assert.equal(run(data, "registerDocument", { documentId: "d", attachmentId: "x", name: "n", hash: H64, mime: "a/b", size: 1, origin: {}, linkedTo: {} }, now, AGENT).error, "ACTOR_REJECTED");
});

/* ══ R11: keine eigene Idempotenz, genau eine Revision, Umschlag-Adapter ══ */
test("R11: der Domain-Dispatcher fuehrt keinen Ledger; Revision genau einmal (auch carryOverRefs); commandReducer passt zum Umschlag", async () => {
  let { data, now, date } = tagAufbauen(migriert());
  // Kein idempotencyByKey-Eintrag durch den Kern, kein stilles Replay bei gleichem commandId + anderem Inhalt.
  const c = cmd("registerIntake", { intakeId: "in_a", text: "A", channel: "mobile" }, now);
  const a1 = K.applyCommand(data, c, { policy: POLICY, actor: USER });
  assert.deepEqual(a1.data.automation.idempotencyByKey, {});
  const a2 = K.applyCommand(a1.data, { ...c, payload: { intakeId: "in_b", text: "B", channel: "mobile" } }, { policy: POLICY, actor: USER });
  assert.equal(a2.ok, true); assert.equal(a2.replayed, undefined);
  assert.ok(a2.data.automation.intakeById.in_b, "gleiche commandId mit anderem Inhalt wurde still als Replay behandelt");
  assert.deepEqual(a2.data.automation.idempotencyByKey, {});
  // Genau eine Revision je aeusserer Aktion — carryOverRefs ueber mehrere Elemente.
  let d = mussOk(run(data, "ensureRun", { date: "2026-09-20" }, K.slotBeginnMs("2026-09-20", "briefing04")), "run2");
  const rev = d.automation.dataRevision;
  const co = run(d, "carryOverRefs", { fromDate: date, toDate: "2026-09-20" }, K.slotBeginnMs("2026-09-20", "briefing04"));
  assert.equal(co.ok, true); assert.equal(co.carried.length, 4, "l1, c1, t1, t2 — alle offen im Vortag");
  assert.equal(co.data.automation.dataRevision, rev + 1);
  // No-op-Aktionen erhoehen nichts und geben die Eingabe zurueck.
  const noop = run(co.data, "carryOverRefs", { fromDate: date, toDate: "2026-09-20" }, now);
  assert.equal(noop.noop, true); assert.equal(noop.data, co.data);
  // Ein fremder Ledger-Eintrag und eine fremde Lease bleiben byteidentisch, was auch immer der Kern tut.
  const mitLedger = K.klon(co.data);
  mitLedger.automation.idempotencyByKey.abc = { schemaVersion: 3, state: "committed", requestHash: "h" };
  mitLedger.automation.activeLease = { holder: "e1-runner", fence: 7, expiresAt: "2026-09-19T21:10:00.000Z" };
  const r3 = mussOk(run(mitLedger, "registerIntake", { intakeId: "in_c", text: "C", channel: "mobile" }, now, USER), "intake");
  assert.deepEqual(r3.automation.idempotencyByKey, mitLedger.automation.idempotencyByKey);
  assert.deepEqual(r3.automation.activeLease, mitLedger.automation.activeLease);
  // Der Adapter fuer applyIdempotentCommand: synchron, {data,result}, Fehler mit code, Revision +1.
  const reducer = K.commandReducer({ policy: POLICY, actor: USER });
  const prepared = { requestId: "req_1", now: new Date(now).toISOString() };
  const out = reducer(K.klon(co.data), { type: "registerIntake", payload: { intakeId: "in_d", text: "D", channel: "mobile" } }, prepared);
  assert.ok(out.data && out.result && !("data" in out.result) && !("ok" in out.result) && !("dataRevision" in out.result) && !("replayed" in out.result));
  assert.equal(out.data.automation.dataRevision, co.data.automation.dataRevision + 1);
  assert.equal(out.result.entry.id, "in_d");
  assert.throws(() => reducer(K.klon(co.data), { type: "registerIntake", payload: { intakeId: "in_d", text: "" , channel: "m" } }, prepared), (e) => e.code === "INTAKE_TEXT_MISSING" && e.status === 400);
  // Zusammensetzen mit dem echten Umschlag, sofern er im Arbeitsbaum liegt (codex-Branch); sonst nur der Adapter.
  try {
    const U = await import("../netlify/lib/quantus-v3-idempotency.mjs");
    const p = U.prepareIdempotentCommand({ tenantId: "laurin", principalId: "user:laurin", key: "k1", requestId: "req_2", now: new Date(now).toISOString(), command: { type: "registerIntake", payload: { intakeId: "in_e", text: "E", channel: "mobile" } } });
    const r1 = U.applyIdempotentCommand(co.data, p, reducer);
    assert.equal(r1.result.ok, true); assert.equal(r1.data.automation.intakeById.in_e.text, "E");
    const r2 = U.applyIdempotentCommand(r1.data, p, reducer);
    assert.equal(r2.unchanged, true); assert.equal(r2.result.replayed, true);
  } catch (e) { if (e.code !== "ERR_MODULE_NOT_FOUND") throw e; }
  // Lease-Kommandos gibt es im Kern nicht mehr (Paket E1).
  assert.equal(K.COMMAND_SCHEMAS.acquireLease, undefined); assert.equal(K.COMMAND_SCHEMAS.releaseLease, undefined);
  assert.equal(run(data, "acquireLease", { holder: "x", ttlMs: 1000 }, now).error, "COMMAND_REJECTED");
});

/* ══ R6 / T32: Jobs ══════════════════════════════════════════════════════ */
test("R6: cancelled → returned wird abgewiesen; Ruecklauf aendert den Lead nicht; erst geprueftes Review setzt review; stale Ergebnis nicht annehmbar; Outbox atomar, kein Versand", () => {
  let { data, now, date } = tagAufbauen(migriert());
  const jobP = { jobId: "job1", kind: "recherche", purpose: "Firmenregister pruefen", sourceType: "chatgptLead", sourceId: "l1", inputVersion: 1, executor: "gemini", contextRefs: [{ sourceType: "chatgptLead", sourceId: "l1" }], expiresAt: new Date(now + 4 * STD).toISOString() };
  assert.equal(run(data, "createJob", { ...jobP, inputVersion: 2 }, now).error, "VERSION_MISMATCH");
  assert.equal(run(data, "createJob", { ...jobP, contextRefs: [{ sourceType: "chatgptLead", sourceId: "gibtsnicht" }] }, now).error, "JOB_CONTEXT_REF_NOT_FOUND");
  assert.equal(run(data, "createJob", { ...jobP, expiresAt: new Date(now - MIN).toISOString() }, now).error, "JOB_EXPIRES_INVALID");
  assert.equal(run(data, "createJob", { ...jobP, purpose: " " }, now).error, "JOB_PURPOSE_MISSING");
  assert.equal(run(data, "createJob", { ...jobP, executor: "cowork" }, now).error, "EXECUTOR_UNKNOWN");
  const revVor = data.automation.dataRevision;
  data = mussOk(run(data, "createJob", jobP, now), "job");
  assert.equal(data.automation.dataRevision, revVor + 1, "Job + Outbox in einer Revision");
  assert.deepEqual(Object.keys(data.automation.outboxById), ["job:job1"]);
  assert.equal(data.automation.outboxById["job:job1"].mode, "dry_run"); assert.equal(data.automation.outboxById["job:job1"].dispatchedAt, null);
  assert.equal(data.automation.jobsById.job1.inputVersion, 1); assert.equal(data.automation.jobsById.job1.mode, "dry_run");
  // Abgebrochen → Ruecklauf abgewiesen, Lead unveraendert.
  const abgebrochen = mussOk(run(data, "cancelJob", { jobId: "job1", reason: "ersetzt" }, now + MIN), "cancel");
  assert.equal(abgebrochen.automation.outboxById["job:job1"].state, "cancelled");
  const rr = run(abgebrochen, "recordJobReturn", { jobId: "job1", outcome: "returned", resultRef: "notes/x", resultHash: H64 }, now + 2 * MIN, WORKER);
  assert.equal(rr.error, "JOB_NOT_ACTIVE");
  assert.equal(abgebrochen.entities.chatgptLeads.l1.operationalState, "doing");
  // Abgelaufen → abgewiesen; Ampel zeigt JOB_EXPIRED.
  assert.equal(run(data, "recordJobReturn", { jobId: "job1", outcome: "returned", resultRef: "notes/x", resultHash: H64 }, now + 5 * STD, WORKER).error, "JOB_EXPIRED");
  assert.ok(hatCode(ampel(data, date, now + 5 * STD), "JOB_EXPIRED", "job1"));
  // Warten mit Job-Beleg (delegated), Gegenpartei muss der Executor sein.
  let r = run(data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "delegated", counterparty: "claude", nextAction: "Rueckgabe pruefen", followUpAt: new Date(now + 3 * STD).toISOString(), evidence: { kind: "job", jobId: "job1" } }, now);
  assert.ok(r.detail.includes("WAIT_DELEGATED_COUNTERPARTY_MISMATCH"));
  data = mussOk(run(data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "delegated", counterparty: "gemini", nextAction: "Rueckgabe pruefen", followUpAt: new Date(now + 3 * STD).toISOString(), evidence: { kind: "job", jobId: "job1" } }, now), "delegated");
  assert.equal(ampel(data, date, now).reasons.find((x) => x.code === "JOB_PENDING").severity, "yellow");
  // Ruecklauf: nur Worker, mit Ergebnis-Hash; der Lead bleibt delegated, die Karte bleibt; Ampel verlangt Pruefung.
  assert.equal(run(data, "recordJobReturn", { jobId: "job1", outcome: "returned", resultRef: "notes/x" }, now + STD, WORKER).error, "JOB_RESULT_HASH_INVALID");
  data = mussOk(run(data, "recordJobReturn", { jobId: "job1", outcome: "returned", resultRef: "notes/x", resultHash: H64 }, now + STD, WORKER), "return");
  assert.equal(data.entities.chatgptLeads.l1.operationalState, "delegated", "der Ruecklauf hat den Lead veraendert");
  assert.equal(data.entities.chatgptLeads.l1.operationalStateVersion, 2);
  assert.equal(data.automation.jobsById.job1.result.stale, false);
  let ev = ampel(data, date, now + STD);
  assert.ok(hatCode(ev, "JOB_RETURN_UNREVIEWED", "job1"));
  assert.equal(run(data, "recordJobReturn", { jobId: "job1", outcome: "returned", resultRef: "notes/y", resultHash: H64 }, now + STD, WORKER).error, "JOB_ALREADY_FINISHED");
  // Lead-Abschluss setzt reviewedAt NICHT automatisch: done ist blockiert, solange die Rueckgabe ungeprueft ist.
  const beleg = mussOk(run(data, "registerEvidence", { evidenceId: "ev_l1", kind: "message", ref: "m", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "x", ref: "y" }, observedAt: new Date(now).toISOString(), fingerprint: "0123456789abcdef0123" }, now + STD, ADAPTER), "ev");
  assert.equal(run(beleg, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "review", expectedVersion: 2 }, now + STD).ok, true);
  assert.equal(run(mussOk(run(beleg, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "review", expectedVersion: 2 }, now + STD), "rev"), "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 3, evidence: { kind: "evidence", evidenceId: "ev_l1" } }, now + STD).error, "JOB_RETURN_UNREVIEWED");
  // Geprueftes Review (Agent oder Nutzer) → Lead auf review, Job-Ergebnis wird Fortschrittsereignis.
  data = mussOk(run(data, "reviewJobResult", { jobId: "job1", verdict: "accepted", reviewer: "laurin" }, now + 2 * STD, USER), "review");
  assert.equal(data.entities.chatgptLeads.l1.operationalState, "review");
  assert.equal(data.automation.jobsById.job1.review.verdict, "accepted");
  assert.equal(data.automation.waitingById["chatgptLead:l1"], undefined);
  assert.ok(K.verifizierteEreignisse(data, "chatgptLead", "l1").includes("job:job1"));
  assert.equal(run(data, "reviewJobResult", { jobId: "job1", verdict: "rejected", reviewer: "x" }, now, USER).error, "JOB_ALREADY_REVIEWED");
  // Stale: Eingangsversion aelter als das Element bei Rueckgabe → nicht annehmbar.
  let s2 = mussOk(run(data, "createJob", { ...jobP, jobId: "job2", inputVersion: 3 }, now + 2 * STD), "job2");
  s2 = mussOk(run(s2, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: 3, reason: "weiter" }, now + 2 * STD), "doing");
  s2 = mussOk(run(s2, "recordJobReturn", { jobId: "job2", outcome: "returned", resultRef: "notes/z", resultHash: H64 }, now + 3 * STD, WORKER), "return2");
  assert.equal(s2.automation.jobsById.job2.result.stale, true);
  assert.equal(run(s2, "reviewJobResult", { jobId: "job2", verdict: "accepted", reviewer: "x" }, now + 3 * STD).error, "JOB_RESULT_NOT_ACCEPTABLE");
  s2 = mussOk(run(s2, "reviewJobResult", { jobId: "job2", verdict: "rejected", reviewer: "x", note: "stale" }, now + 3 * STD), "reject");
  assert.equal(s2.entities.chatgptLeads.l1.operationalState, "doing");
  // Fehlgeschlagen sichtbar; cancelJob eines delegierten Wartens holt das Element zurueck nach doing.
  const f = mussOk(run(mussOk(run(s2, "createJob", { ...jobP, jobId: "job3", inputVersion: 4 }, now + 3 * STD), "job3"), "recordJobReturn", { jobId: "job3", outcome: "failed", error: "quota" }, now + 3 * STD + MIN, WORKER), "fail");
  assert.ok(hatCode(ampel(f, date, now + 3 * STD + MIN), "JOB_FAILED", "job3"));
});

/* ══ R7 / T31: Dokumente ═════════════════════════════════════════════════ */
test("R7: Dokument braucht bestaetigte Attachment-Id, Hash, Typ, Groesse, Herkunft, Verknuepfung; parsed mit erfundenem textRef und done ohne Ergebnisse scheitern; unlesbar bleibt offen", () => {
  let { data, now, date } = tagAufbauen(migriert(), { erledigt: true });
  const doc = { documentId: "doc1", attachmentId: ATT("vertrag.pdf"), name: "vertrag.pdf", hash: H64, mime: "application/pdf", size: 12345, origin: { channel: "mail", ref: "msg_18f" }, linkedTo: { sourceType: "chatgptLead", sourceId: "l1" } };
  for (const [name, kaputt, code] of [
    ["beliebiger storageRef", { ...doc, attachmentId: "uploads/vertrag.pdf" }, "DOCUMENT_ATTACHMENT_ID_INVALID"],
    ["Altformat-Schluessel", { ...doc, attachmentId: "attachment-text__a:b__c__d" }, "DOCUMENT_ATTACHMENT_ID_INVALID"],
    ["ohne Hash", { ...doc, hash: "abc" }, "DOCUMENT_HASH_INVALID"],
    ["ohne Typ", { ...doc, mime: "" }, "DOCUMENT_MIME_INVALID"],
    ["Groesse 0", { ...doc, size: 0 }, "DOCUMENT_SIZE_INVALID"],
    ["ohne Herkunft", { ...doc, origin: { channel: "mail" } }, "DOCUMENT_ORIGIN_MISSING"],
    ["Verknuepfung ins Leere", { ...doc, linkedTo: { sourceType: "chatgptLead", sourceId: "nope" } }, "DOCUMENT_LINK_TARGET_NOT_FOUND"],
  ]) { const r = run(data, "registerDocument", kaputt, now, ADAPTER); assert.equal(r.error, code, name); }
  assert.equal(run(data, "registerDocument", doc, now, AGENT).error, "ACTOR_REJECTED");
  data = mussOk(run(data, "registerDocument", doc, now, ADAPTER), "reg");
  assert.equal(run(data, "registerDocument", { ...doc, hash: "b".repeat(64) }, now, ADAPTER).error, "DOCUMENT_IMMUTABLE");
  let ev = ampel(data, date, now); assert.ok(hatCode(ev, "DOCUMENT_UNPROCESSED", "doc1"));
  // parsed mit unbelegtem textRef → abgewiesen; von einem Agenten → abgewiesen.
  assert.equal(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: "unverified-text", extractHash: H64 }, now, ADAPTER).error, "PARSE_TEXTREF_INVALID");
  assert.equal(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: ATT("vertrag.txt") }, now, ADAPTER).error, "PARSE_EXTRACT_HASH_INVALID");
  assert.equal(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: ATT("vertrag.txt"), extractHash: H64 }, now, AGENT).error, "ACTOR_REJECTED");
  // unlesbar → bleibt offen, done unmoeglich.
  data = mussOk(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "unreadable", error: "verschluesseltes PDF" }, now + MIN, ADAPTER), "parse");
  assert.equal(data.automation.documentsById.doc1.status, "open"); assert.equal(data.automation.documentsById.doc1.handledAt, null);
  ev = ampel(data, date, now + MIN); assert.equal(ev.coverage, "red");
  assert.ok(ev.reasons.some((r) => r.code === "DOCUMENT_UNREADABLE" && r.sourceId === "doc1" && r.detail === "verschluesseltes PDF"));
  assert.equal(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done", results: [{ sourceType: "chatgptLead", sourceId: "l1" }] }, now + 2 * MIN).error, "DOCUMENT_NOT_PARSED");
  // gelesen (geprueft) → immer noch offen; done nur mit konkreten, existierenden Ergebnissen.
  data = mussOk(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: ATT("vertrag.txt"), extractHash: "c".repeat(64) }, now + 3 * MIN, ADAPTER), "parsed");
  assert.equal(data.automation.documentsById.doc1.parse.attempts, 2);
  assert.ok(hatCode(ampel(data, date, now + 3 * MIN), "DOCUMENT_UNHANDLED", "doc1"));
  assert.equal(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done" }, now + 4 * MIN).error, "DOCUMENT_RESULTS_MISSING");
  assert.equal(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done", results: [{ sourceType: "chatgptLead", sourceId: "nope" }] }, now + 4 * MIN).error, "DOCUMENT_RESULT_NOT_FOUND");
  data = mussOk(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done", results: [{ sourceType: "chatgptLead", sourceId: "l1" }] }, now + 4 * MIN), "handled");
  assert.deepEqual(data.automation.documentsById.doc1.results, [{ sourceType: "chatgptLead", sourceId: "l1" }]);
  assert.ok(K.verifizierteEreignisse(data, "chatgptLead", "l1").includes("document:doc1"));
  ev = ampel(data, date, now + 4 * MIN); assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  // Eingang: ungeklaert sperrt, geklaert nur mit Link oder Grund.
  data = mussOk(run(data, "registerIntake", { intakeId: "in_1", text: "Bitte Zahnarzt anrufen", channel: "mobile" }, now + 5 * MIN, USER), "intake");
  assert.ok(hatCode(ampel(data, date, now + 5 * MIN), "INTAKE_UNCLARIFIED", "in_1"));
  assert.equal(run(data, "transitionState", { sourceType: "intake", sourceId: "in_1", state: "done" }, now + 6 * MIN).error, "INTAKE_DONE_NEEDS_LINK_OR_REASON");
  data = mussOk(run(data, "transitionState", { sourceType: "intake", sourceId: "in_1", state: "done", linkTo: { sourceType: "task", sourceId: "t1" } }, now + 6 * MIN), "geklaert");
  assert.equal(ampel(data, date, now + 6 * MIN).coverage, "green");
});

/* ══ T11: Antworten ══════════════════════════════════════════════════════ */
test("Fragen sind unveraenderlich, Antworten nur vom Nutzer, genau einmal konsumierbar, eine offene Frage ist nie eine Freigabe", () => {
  let { data, now, date } = tagAufbauen(migriert());
  data = mussOk(run(data, "askQuestion", { questionId: "q1", sourceType: "chatgptLead", sourceId: "l1", text: "Welche Firma?", date }, now), "ask");
  assert.equal(run(data, "askQuestion", { questionId: "q1", sourceType: "chatgptLead", sourceId: "l1", text: "Anderer Text" }, now).error, "QUESTION_IMMUTABLE");
  assert.equal(run(data, "askQuestion", { questionId: "q1", sourceType: "chatgptLead", sourceId: "l1", text: "Welche Firma?" }, now).created, false);
  const ev0 = mussOk(run(data, "registerEvidence", { evidenceId: "ev_l1", kind: "message", ref: "m", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "x", ref: "y" }, observedAt: new Date(now).toISOString(), fingerprint: "0123456789abcdef0123" }, now, ADAPTER), "ev");
  assert.equal(run(ev0, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 1, evidence: { kind: "evidence", evidenceId: "ev_l1" } }, now).error, "QUESTION_OPEN");
  assert.ok(hatCode(ampel(data, date, now), "QUESTION_OPEN", "l1"));
  data = mussOk(run(data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "waiting_user", counterparty: "user", nextAction: "Antwort einarbeiten", followUpAt: new Date(now + 3 * STD).toISOString(), evidence: { kind: "question", questionId: "q1" } }, now), "wait");
  data = erledigen(data, "chatgptTask", "c1", now); data = erledigen(data, "task", "t1", now);
  let ev = ampel(data, date, now); assert.equal(ev.coverage, "green", JSON.stringify(ev.reasons));
  assert.equal(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Muster AG" }, now + MIN, AGENT).error, "ACTOR_REJECTED");
  data = mussOk(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Muster AG" }, now + MIN, USER), "answer");
  assert.equal(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Doch anders" }, now + 2 * MIN, USER).error, "ANSWER_IMMUTABLE");
  assert.equal(run(data, "recordAnswer", { answerId: "a2", questionId: "q1", text: "Zweite" }, now + 2 * MIN, USER).error, "QUESTION_NOT_OPEN");
  assert.equal(run(data, "recordAnswer", { answerId: "a1", questionId: "q1", text: "Muster AG" }, now + 2 * MIN, USER).created, false);
  ev = ampel(data, date, now + MIN); assert.ok(hatCode(ev, "ANSWER_UNCONSUMED", "l1") || hatCode(ev, "ANSWER_UNCONSUMED", "a1"));
  data = mussOk(run(data, "consumeAnswer", { answerId: "a1", consumer: "run/process09" }, now + 3 * MIN), "consume");
  assert.equal(run(data, "consumeAnswer", { answerId: "a1", consumer: "run/continue14" }, now + 4 * MIN).error, "ANSWER_ALREADY_CONSUMED");
  assert.equal(data.automation.answersById.a1.text, "Muster AG");
  // Die konsumierte Antwort ist ein Abschlussbeleg fuer l1 — nach dem Ende des Wartens.
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: 2, reason: "Antwort da" }, now + 5 * MIN), "doing");
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "done", expectedVersion: 3, evidence: { kind: "answer", answerId: "a1" } }, now + 6 * MIN), "done");
  assert.equal(data.entities.chatgptLeads.l1.operationalState, "done");
});

/* ══ R8 / T17 / T18: Abschluss und Widerspruch ═══════════════════════════ */
test("R8: Abschlussnachweis erfasst die ganze Verpflichtungsmenge; ein Lead ohne itemRef, der wieder doing wird, ist ein Widerspruch; Warten-Widersprueche; Historie unveraendert", () => {
  const date = "2026-09-19";
  let s = tagAufbauen(migriert(), { erledigt: true });
  // l2 ist abgeschlossen und steht in KEINEM itemRef — der Abschluss erfasst ihn trotzdem.
  assert.ok(!s.data.dailyBriefing.assistantRuns[date].itemRefs.some((r) => r.sourceId === "l2"));
  const revVorher = s.data.automation.dataRevision;
  let r = run(s.data, "closeRun", { date, finalNoteId: "note_final_1" }, s.now);
  const d1 = mussOk(r, "closeRun");
  const runF = d1.dailyBriefing.assistantRuns[date];
  assert.equal(runF.phase, "final"); assert.equal(runF.closureRevision, revVorher + 1); assert.equal(runF.finalNoteId, "note_final_1");
  assert.equal(runF.closureOutcomes["chatgptLead:l2"].state, "done");
  assert.equal(runF.closureOutcomes["chatgptLead:l1"].state, "done");
  assert.equal(runF.closureOutcomes["task:t2"].state, "doing");
  assert.equal(Object.keys(runF.closureOutcomes).length, 6, "alle fuenf Elemente plus das Projekt, unabhaengig von itemRefs (Belege sind keine Verpflichtungen)");
  // Notes liegen als ChatGPT Notes (entities.chatgptNotes) im bestehenden Schema; NoteFlow (entities.notes) bleibt unberuehrt (B2-08).
  const note = d1.entities.chatgptNotes.note_final_1;
  assert.ok(note && note.category === "entscheid" && note.state === "aktiv" && note.instructionDate === date && note.promptSection === "tagesbriefing");
  assert.ok(Array.isArray(note.tags) && note.tags.includes("final") && Array.isArray(note.linkedTasks) && Array.isArray(note.files) && note.supersedes === null);
  assert.ok(note.instruction.includes("chatgptLead:l2 → done") && note.derived.includes("Abschluss"));
  assert.deepEqual(note.assistantNote, { schema: "assistant-note/3", kind: "assistantFinal", runDate: date, runRevision: runF.revision });
  assert.equal(Object.values(d1.entities.chatgptNotes).filter((n) => n.assistantNote?.kind === "assistantFinal").length, 1);
  assert.equal(d1.entities.chatgptNotes[runF.startNoteId].assistantNote.kind, "assistantStart");
  assert.equal(d1.entities.chatgptNotes[runF.startNoteId].category, "auftrag");
  assert.deepEqual(d1.entities.notes, bestand().entities.notes, "NoteFlow wurde angefasst");
  assert.equal(s.data.dailyBriefing.assistantRuns[date].phase, "active", "die Eingabe wurde mutiert");
  const finalnotizVorher = JSON.stringify(note);
  // Wiederholung: No-op, keine zweite Notiz.
  const r2 = run(d1, "closeRun", { date, finalNoteId: "note_final_2" }, s.now + 5 * MIN);
  assert.equal(r2.already, true); assert.equal(r2.noop, true); assert.equal(r2.data, d1);
  // Genau dieser l2 wird wieder doing (reopen mit Grund): Widerspruch.
  const t1 = s.now + 10 * MIN;
  let d2 = mussOk(run(d1, "transitionState", { sourceType: "chatgptLead", sourceId: "l2", state: "doing", expectedVersion: 1, reason: "Kunde reklamiert" }, t1), "reopen l2");
  let w = K.pruefeWiderspruch(d2, { date }, { now: t1, policy: POLICY });
  assert.deepEqual(w.contradictions, [{ sourceType: "chatgptLead", sourceId: "l2", was: "done", now: "doing", reason: "REOPENED" }]);
  // Neuer Eingang nach dem Cutoff: kein Widerspruch, naechster Lauf.
  d2 = mussOk(run(d2, "registerIntake", { intakeId: "in_neu", text: "Neu vom Handy", channel: "mobile" }, t1, USER), "intake");
  w = K.pruefeWiderspruch(d2, { date }, { now: t1, policy: POLICY });
  assert.deepEqual(w.newIntake, [{ sourceType: "intake", sourceId: "in_neu" }]); assert.equal(w.nextRunDate, "2026-09-20");
  assert.equal(run(d2, "invalidateClosure", { date, correctionId: "note_korr_x", reason: "neu", contradiction: { sourceType: "intake", sourceId: "in_neu" } }, t1).error, "NOT_A_CONTRADICTION");
  const inv = mussOk(run(d2, "invalidateClosure", { date, correctionId: "note_korr_1", reason: "Lead l2 wieder offen", contradiction: { sourceType: "chatgptLead", sourceId: "l2" } }, t1), "invalidate");
  const runI = inv.dailyBriefing.assistantRuns[date];
  assert.equal(runI.phase, "exception_open"); assert.equal(runI.finalNoteId, "note_final_1"); assert.equal(runI.closureRevision, runF.closureRevision);
  assert.equal(JSON.stringify(inv.entities.chatgptNotes.note_final_1), finalnotizVorher, "die historische Finalnote wurde veraendert");
  assert.equal(runI.corrections.length, 1); assert.equal(inv.entities.chatgptNotes.note_korr_1.assistantNote.kind, "assistantCorrection");
  assert.equal(inv.entities.chatgptNotes.note_korr_1.supersedes, "note_final_1");
  assert.equal(inv.entities.chatgptNotes.note_final_1.supersededBy, null, "die alte Note wird nicht angefasst, auch nicht mit supersededBy");
  assert.equal(run(inv, "invalidateClosure", { date, correctionId: "note_korr_1", reason: "nochmal", contradiction: { sourceType: "chatgptLead", sourceId: "l2" } }, t1 + MIN).already, true);
  assert.equal(run(inv, "closeRun", { date, finalNoteId: "note_final_3" }, t1).error, "RUN_EXCEPTION_OPEN");
  // Widerspruch zu geprueftem Warten: l1 wartet belegt beim Abschluss; danach Karte weg bzw. Beleg getauscht.
  let s2 = tagAufbauen(migriert());
  s2.data = mussOk(run(s2.data, "registerEvidence", { evidenceId: "ev_bank", kind: "mail", ref: "m", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "x" }, observedAt: new Date(s2.now - MIN).toISOString(), fingerprint: "0123456789abcdef0123" }, s2.now, ADAPTER), "ev");
  s2.data = mussOk(run(s2.data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "waiting_external", counterparty: "Bank", nextAction: "nachfragen", followUpAt: new Date(s2.now + 24 * STD).toISOString(), evidence: { kind: "evidence", evidenceId: "ev_bank" } }, s2.now), "wait");
  s2.data = erledigen(s2.data, "chatgptTask", "c1", s2.now); s2.data = erledigen(s2.data, "task", "t1", s2.now);
  const d3 = mussOk(run(s2.data, "closeRun", { date, finalNoteId: "note_final_w" }, s2.now), "close waiting");
  const co = d3.dailyBriefing.assistantRuns[date].closureOutcomes["chatgptLead:l1"];
  assert.equal(co.state, "waiting_external"); assert.equal(co.version, 2);
  assert.deepEqual(co.waiting.evidence, { kind: "evidence", evidenceId: "ev_bank", binding: "0123456789abcdef0123" });
  assert.equal(co.evidenceIdentity.fingerprint, "0123456789abcdef0123");
  const ohneKarte = K.klon(d3); delete ohneKarte.automation.waitingById["chatgptLead:l1"];
  assert.equal(K.pruefeWiderspruch(ohneKarte, { date }, { now: s2.now + MIN, policy: POLICY }).contradictions[0].reason, "WAITING_CARD_LOST");
  const wiederDoing = mussOk(run(d3, "transitionState", { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: 2, reason: "Antwort kam" }, s2.now + MIN), "doing");
  assert.deepEqual(K.pruefeWiderspruch(wiederDoing, { date }, { now: s2.now + MIN, policy: POLICY }).contradictions.map((c) => c.now), ["doing"]);
  // Nach 04:00 des Folgetages ist der Tag vorbei; ein offener Lead blockiert mit Quell-Id.
  s = tagAufbauen(migriert(), { erledigt: true });
  assert.ok(run(s.data, "closeRun", { date, finalNoteId: "n" }, K.tagesEndeMs(date) + MIN).detail.some((b) => b.code === "CLOSURE_DAY_OVER"));
  const offen = tagAufbauen(migriert());
  r = run(offen.data, "closeRun", { date, finalNoteId: "n" }, offen.now);
  assert.ok(r.detail.find((b) => b.code === "COVERAGE_NOT_GREEN").detail.some((x) => x.sourceId === "l1"));
  assert.equal(offen.data.entities.chatgptNotes.n, undefined, "kein Teil-Effekt");
});

/* ══ T22: DST ════════════════════════════════════════════════════════════ */
test("Europe/Zurich: Sommer- und Winterzeit ergeben eindeutige Slots und stabile Schluessel", () => {
  assert.equal(new Date(K.slotBeginnMs("2026-03-28", "briefing04")).toISOString(), "2026-03-28T03:00:00.000Z");
  assert.equal(new Date(K.slotBeginnMs("2026-03-29", "briefing04")).toISOString(), "2026-03-29T02:00:00.000Z");
  assert.equal(new Date(K.slotBeginnMs("2026-10-24", "close23")).toISOString(), "2026-10-24T21:00:00.000Z");
  assert.equal(new Date(K.slotBeginnMs("2026-10-25", "briefing04")).toISOString(), "2026-10-25T03:00:00.000Z");
  assert.equal(new Date(K.slotBeginnMs("2026-10-25", "close23")).toISOString(), "2026-10-25T22:00:00.000Z");
  assert.equal((K.tagesEndeMs("2026-10-24") - K.slotBeginnMs("2026-10-24", "briefing04")) / STD, 25);
  assert.equal((K.tagesEndeMs("2026-03-28") - K.slotBeginnMs("2026-03-28", "briefing04")) / STD, 23);
  for (const tag of ["2026-03-28", "2026-03-29", "2026-10-24", "2026-10-25"]) {
    const ms = K.SLOT_KEYS.map((s) => K.slotBeginnMs(tag, s));
    for (let i = 1; i < ms.length; i++) assert.ok(ms[i] > ms[i - 1], tag);
    assert.equal(new Set(ms).size, 4);
    K.SLOTS.forEach((s, i) => { const p = K.zurichParts(ms[i]); assert.equal(p.hour, s.hour); assert.equal(K.ymd(p), tag); });
  }
  assert.equal(new Date(K.wandzeitZuMs("2026-10-25", 2, 30)).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(K.zurichParts(K.wandzeitZuMs("2026-03-29", 2, 30)).hour, 3);
  assert.equal(K.assistentenTag(T("2026-10-25T00:30:00Z")), "2026-10-24");
  assert.equal(K.assistentenTag(T("2026-10-25T01:30:00Z")), "2026-10-24");
  assert.equal(K.assistentenTag(T("2026-10-25T03:00:00Z")), "2026-10-25");
  assert.equal(K.assistentenTag(T("2026-03-29T01:59:00Z")), "2026-03-28");
  assert.equal(K.assistentenTag(T("2026-03-29T02:00:00Z")), "2026-03-29");
  assert.deepEqual([K.aktuellerSlot(T("2026-10-25T00:30:00Z")).date, K.aktuellerSlot(T("2026-10-25T00:30:00Z")).slot], ["2026-10-24", "close23"]);
  assert.equal(new Date(K.naechsteSlotGrenzeMs(T("2026-10-25T00:30:00Z"))).toISOString(), "2026-10-25T03:00:00.000Z");
  assert.equal(K.slotKey("laurin", "2026-10-25", "close23", "3.0"), "laurin:2026-10-25:close23:3.0");
  assert.throws(() => K.slotKey("laurin", "2026-10-25", "mittag", "3.0"), RangeError);
  let d = mussOk(run(migriert(), "ensureRun", { date: "2026-10-25" }, K.slotBeginnMs("2026-10-25", "briefing04")), "run");
  assert.equal(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "r09" }, K.slotBeginnMs("2026-10-25", "process09") - MIN).error, "SLOT_NOT_STARTED");
  d = mussOk(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "r09" }, K.slotBeginnMs("2026-10-25", "process09")), "r09");
  assert.equal(d.dailyBriefing.assistantRuns["2026-10-25"].slotReceipts.process09.slotKey, "laurin:2026-10-25:process09:3.0");
  assert.equal(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "r09" }, K.slotBeginnMs("2026-10-25", "process09") + MIN).noop, true);
  assert.equal(run(d, "recordSlotReceipt", { date: "2026-10-25", slot: "process09", receiptId: "anders" }, K.slotBeginnMs("2026-10-25", "process09") + MIN).error, "SLOT_ALREADY_RECEIPTED");
  const ev = ampel(d, "2026-10-25", K.slotBeginnMs("2026-10-25", "continue14") + MIN);
  assert.ok(ev.reasons.some((r) => r.code === "SLOT_RECEIPT_MISSING" && r.detail === "briefing04"));
  assert.ok(ev.reasons.some((r) => r.code === "SLOT_RECEIPT_MISSING" && r.detail === "continue14"));
  assert.ok(!ev.reasons.some((r) => r.code === "SLOT_RECEIPT_MISSING" && r.detail === "close23"));
  assert.ok(hatCode(ev, "RUN_START_NOTE_MISSING"));
});

/* ══ T23: Carry-over ═════════════════════════════════════════════════════ */
test("Carry-over uebernimmt Verweise, keine neuen Aufgaben; itemRefs tragen keine Statusfelder", () => {
  let { data, now } = tagAufbauen(migriert());
  data = erledigen(data, "task", "t1", now);
  const tasksVorher = JSON.stringify(data.entities.tasks), leadsVorher = JSON.stringify(data.entities.chatgptLeads);
  data = mussOk(run(data, "ensureRun", { date: "2026-09-20" }, K.slotBeginnMs("2026-09-20", "briefing04")), "run2");
  data = mussOk(run(data, "carryOverRefs", { fromDate: "2026-09-19", toDate: "2026-09-20" }, K.slotBeginnMs("2026-09-20", "briefing04")), "carry");
  const refs = data.dailyBriefing.assistantRuns["2026-09-20"].itemRefs;
  assert.deepEqual(refs.map((r) => r.sourceType + ":" + r.sourceId).sort(), ["chatgptLead:l1", "chatgptTask:c1", "task:t2"]);
  for (const ref of refs) { assert.equal(ref.carriedFrom, "2026-09-19"); assert.deepEqual(Object.keys(ref).sort(), ["carriedFrom", "includedAt", "sourceId", "sourceType"]); }
  assert.equal(JSON.stringify(data.entities.tasks), tasksVorher); assert.equal(JSON.stringify(data.entities.chatgptLeads), leadsVorher);
  assert.equal(run(data, "addItemRef", { date: "2026-09-20", sourceType: "chatgptLead", sourceId: "gibtsnicht" }, now).error, "SOURCE_NOT_FOUND");
  const text = K.serializeCore(data);
  assert.equal(JSON.stringify(K.requireCore(K.parseCoreDocument({ exists: true, data: text }))), text);
});

/* ══ Zweite Pruefung (B2-01 … B2-09): Gegenbeispiele auf der Basisfixture ═ */
function basisFixture() {
  return { entities: { tasks: {}, projects: {}, notes: {}, chatgptNotes: {}, chatgptLeads: {}, chatgptTasks: {} } };
}
/* Leerer Bestand, Tag komplett aufgebaut, Ausgangsampel beide gruen. */
function basisTag(extra = (d) => d) {
  const date = "2026-09-19";
  const now = K.wandzeitZuMs(date, 23, 5);
  let data = K.migrateCore(extra(basisFixture()), { now: NOW }).data;
  data = mussOk(run(data, "ensureRun", { date }, K.slotBeginnMs(date, "briefing04") + MIN), "ensureRun");
  data = mussOk(run(data, "ensureStartNote", { date, noteId: "note_start" }, K.slotBeginnMs(date, "briefing04") + 2 * MIN), "start");
  for (const sl of K.SLOT_KEYS) data = mussOk(run(data, "recordSlotReceipt", { date, slot: sl, receiptId: "r_" + sl }, K.slotBeginnMs(date, sl) + MIN), sl);
  for (const q of POLICY.requiredSources) data = mussOk(run(data, "recordSourceCheck", { date, sourceId: q.id, cursor: "c", outcome: "ok" }, now, ADAPTER), q.id);
  return { data, now, date };
}
/* Wartefall: l1 vor der Migration, addItemRef, Adapter-Beleg proof_review, setWaiting → voll gruen. */
function warteTag() {
  const s = basisTag((d) => { d.entities.chatgptLeads.l1 = { id: "l1", status: "in_arbeit", readAt: "2026-09-19T06:00:00Z", assignee: "chatgpt" }; return d; });
  let { data, now, date } = s;
  data = mussOk(run(data, "addItemRef", { date, sourceType: "chatgptLead", sourceId: "l1" }, now), "ref");
  data = mussOk(run(data, "registerEvidence", { evidenceId: "proof_review", kind: "mail", ref: "rfc822:<review@partner.example>", sourceType: "chatgptLead", sourceId: "l1", origin: { adapter: "gmail", ref: "msg_1" }, observedAt: new Date(now - MIN).toISOString(), fingerprint: "sha256-abcdef0123456789" }, now, ADAPTER), "beleg");
  data = mussOk(run(data, "setWaiting", { sourceType: "chatgptLead", sourceId: "l1", expectedVersion: 1, state: "waiting_external", counterparty: "External partner", nextAction: "Review reply", followUpAt: new Date(now + 24 * STD).toISOString(), evidence: { kind: "evidence", evidenceId: "proof_review" } }, now), "wait");
  return { data, now, date };
}
const gruen = (ev, was) => { assert.equal(ev.coverage, "green", was + ": " + JSON.stringify(ev.reasons)); assert.equal(ev.operations, "green", was + ": " + JSON.stringify(ev.reasons)); };

test("B2-01/02: korrupte oder fehlende Pflichtkarten, Stores und Revisionen sind in der Ampel rot — nicht uebersprungen, nicht geworfen", () => {
  const { data, now, date } = basisTag();
  gruen(ampel(data, date, now), "Ausgang");
  const faelle = [
    ["automation.questionsById", []], ["automation.documentsById", []], ["automation.jobsById", []], ["automation.evidenceById", "x"],
    ["automation.waitingById", null], ["automation.progressById", 3], ["automation.sourceCursors", []], ["automation.migration", null],
    ["automation.dataRevision", -1], ["automation.dataRevision", 1.5], ["automation.dataRevision", "7"], ["automation.dataRevision", Number.MAX_SAFE_INTEGER + 2],
    ["automation.schemaVersion", 2], ["dailyBriefing.assistantRuns", []],
    ["entities.chatgptLeads", undefined], ["entities.chatgptTasks", undefined], ["entities.tasks", undefined], ["entities.projects", []], ["entities.chatgptNotes", undefined],
    ["entities.chatgptLeads.l9", "kaputt"],
  ];
  for (const [pfad, wert] of faelle) {
    const k = K.klon(data);
    const teile = pfad.split("."); let o = k; for (const t of teile.slice(0, -1)) o = o[t];
    if (wert === undefined) delete o[teile.at(-1)]; else o[teile.at(-1)] = wert;
    let ev;
    assert.doesNotThrow(() => { ev = ampel(k, date, now); }, pfad + " wirft");
    assert.equal(ev.operations, "red", pfad + " ist nicht rot: " + JSON.stringify(ev.reasons));
    assert.ok(ev.reasons.some((r) => r.code === "CORE_INVALID" && r.sourceId === pfad), pfad + ": " + JSON.stringify(ev.reasons));
    assert.equal(ev.overall, "red");
  }
  // Kombination aus B2-02: Store weg UND Revision -1 → beides einzeln benannt.
  const k = K.klon(data); delete k.entities.chatgptLeads; k.automation.dataRevision = -1;
  const ev = ampel(k, date, now);
  assert.ok(ev.reasons.some((r) => r.code === "CORE_INVALID" && r.sourceId === "entities.chatgptLeads"));
  assert.ok(ev.reasons.some((r) => r.code === "CORE_INVALID" && r.sourceId === "automation.dataRevision"));
  assert.equal(ev.evaluatedRevision, null);
  // Ein kaputter Lauf ebenso (auch der uebergebene Lauf selbst wird per Struktur geprueft).
  const r = K.klon(data); r.dailyBriefing.assistantRuns[date].revision = "x";
  assert.ok(hatCode(ampel(r, date, now), "CORE_INVALID", "dailyBriefing.assistantRuns." + date));
});

test("B2-03/04: eine gespeicherte gruene Bewertung wird durch JEDE Aenderung an Wartekarte, Belegen, Lauf, Quellen, Policy oder Struktur ungueltig", () => {
  const { data, now, date } = warteTag();
  const ev = ampel(data, date, now);
  gruen(ev, "Wartetag");
  const ctx = (d, t = now + 1) => ({ run: d.dailyBriefing.assistantRuns[date], data: d, now: t, policy: POLICY });
  assert.equal(K.isEvaluationCurrent(ev, ctx(data)).current, true);
  const mutationen = [
    ["counterparty leer", (d) => { d.automation.waitingById["chatgptLead:l1"].counterparty = ""; }],
    ["nextAction weg", (d) => { delete d.automation.waitingById["chatgptLead:l1"].nextAction; }],
    ["waitingSince weg", (d) => { delete d.automation.waitingById["chatgptLead:l1"].waitingSince; }],
    ["Belegobjekt getauscht", (d) => { d.automation.waitingById["chatgptLead:l1"].evidence = { kind: "evidence", evidenceId: "anders" }; }],
    ["Beleg-Fingerabdruck geaendert", (d) => { d.automation.evidenceById.proof_review.fingerprint = "sha256-ffffffffffffffff"; }],
    ["Beleg an fremdes Element gebunden", (d) => { d.automation.evidenceById.proof_review.sourceId = "l2"; }],
    ["Beleg geloescht", (d) => { delete d.automation.evidenceById.proof_review; }],
    ["Kernquelle unreachable", (d) => { d.dailyBriefing.assistantRuns[date].sourceChecks["quantus-core"].outcome = "unreachable"; }],
    ["Quellzeit alt", (d) => { d.dailyBriefing.assistantRuns[date].sourceChecks["gmail-inbox"].checkedAt = "2026-09-19T10:00:00.000Z"; }],
    ["Startnote weg", (d) => { d.dailyBriefing.assistantRuns[date].startNoteId = null; }],
    ["Startnote-Eintrag weg", (d) => { delete d.entities.chatgptNotes.note_start; }],
    ["Quittung 23 weg", (d) => { d.dailyBriefing.assistantRuns[date].slotReceipts.close23 = null; }],
    ["Phase exception_open", (d) => { d.dailyBriefing.assistantRuns[date].phase = "exception_open"; }],
    ["itemRef entfernt", (d) => { d.dailyBriefing.assistantRuns[date].itemRefs = []; }],
    ["Lead-Version weg", (d) => { delete d.entities.chatgptLeads.l1.operationalStateVersion; }],
    ["Lead-Zustand direkt done", (d) => { d.entities.chatgptLeads.l1.operationalState = "done"; }],
    ["Altstatus abgeschlossen (Drift)", (d) => { d.entities.chatgptLeads.l1.status = "abgeschlossen"; }],
    ["progress deferrals 3", (d) => { d.automation.progressById["chatgptLead:l1"].deferrals = 3; }],
    ["neue offene Frage", (d) => { d.automation.questionsById.q9 = { id: "q9", sourceType: "chatgptLead", sourceId: "l1", text: "?", askedAt: "2026-09-19T21:00:00.000Z", status: "open", answerId: null }; }],
    ["neuer Eingang", (d) => { d.automation.intakeById.i9 = { id: "i9", text: "x", channel: "m", status: "open", registeredAt: "2026-09-19T21:00:00.000Z" }; }],
    ["Projektfrist faellig", (d) => { d.entities.projects.p9 = { id: "p9", status: "active", deadlines: [{ id: "d", date: "2026-09-19", done: false }] }; }],
    ["Struktur kaputt", (d) => { d.automation.jobsById = []; }],
  ];
  for (const [name, mut] of mutationen) {
    const k = K.klon(data); mut(k);
    const neu = ampel(k, date, now + 1);
    assert.notEqual(neu.overall, "green", name + ": Neuberechnung ist noch gruen: " + JSON.stringify(neu.reasons));
    const c = K.isEvaluationCurrent(ev, ctx(k));
    assert.equal(c.current, false, name + ": alte gruene Bewertung gilt noch (" + c.reason + ")");
  }
  // Policy-Aenderung, anderer Lauf, fehlender Kontext → nie aktuell.
  assert.equal(K.isEvaluationCurrent(ev, { ...ctx(data), policy: { ...POLICY, sourceMaxAgeMinutes: 10 } }).reason, "DATA_CHANGED");
  assert.equal(K.isEvaluationCurrent(ev, { ...ctx(data), policy: null }).reason, "CONTEXT_MISSING");
  assert.equal(K.isEvaluationCurrent(ev, { ...ctx(data), run: K.leererRun(date, "3.0") }).reason, "DATA_CHANGED");
  assert.equal(K.isEvaluationCurrent({ ...ev, overall: "green", validUntil: ev.validUntil }, { ...ctx(data), data: { entities: [] } }).reason, "CORE_INVALID");
  assert.equal(K.isEvaluationCurrent(ev, ctx(data, now - STD)).reason, "EVALUATION_EXPIRED", "eine Bewertung aus der Zukunft gilt nicht");
});

test("B2-05/06/07: nach dem Abschluss sind verlorener Beleg, veraenderte Wartekarte, verlorene Dokument-/Job-Nachweise und wieder offene Projektfristen Widersprueche; neuer Eingang nicht", () => {
  // Wartetag mit geprueftem Projekt (d1 erledigt), Dokument done, Job reviewed — gruen finalisiert.
  const s = warteTag();
  let { data, now, date } = s;
  const p = K.klon(data); p.entities.projects.p1 = { id: "p1", status: "active", deadlines: [{ id: "d1", date: "2026-09-19", done: true }] }; data = p;
  data = mussOk(run(data, "registerDocument", { documentId: "doc1", attachmentId: ATT("a.pdf"), name: "a.pdf", hash: H64, mime: "application/pdf", size: 10, origin: { channel: "mail", ref: "m" }, linkedTo: { sourceType: "chatgptLead", sourceId: "l1" } }, now, ADAPTER), "doc");
  data = mussOk(run(data, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: ATT("a.txt"), extractHash: "c".repeat(64) }, now, ADAPTER), "parse");
  data = mussOk(run(data, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done", results: [{ sourceType: "chatgptLead", sourceId: "l1" }] }, now), "doc done");
  const d0 = K.klon(data); d0.entities.chatgptTasks.c1 = { id: "c1", text: "x", state: "offen", createdAt: "2026-09-18T00:00:00Z" };
  data = K.migrateCore(d0, { now }).data;
  data = mussOk(run(data, "addItemRef", { date, sourceType: "chatgptTask", sourceId: "c1" }, now), "ref c1");
  data = mussOk(run(data, "createJob", { jobId: "j1", kind: "x", purpose: "y", sourceType: "chatgptTask", sourceId: "c1", inputVersion: 1, executor: "gemini", contextRefs: [], expiresAt: new Date(now + STD).toISOString() }, now), "job");
  data = mussOk(run(data, "recordJobReturn", { jobId: "j1", outcome: "returned", resultRef: "r", resultHash: H64 }, now, WORKER), "ret");
  data = mussOk(run(data, "reviewJobResult", { jobId: "j1", verdict: "accepted", reviewer: "laurin" }, now, USER), "review");
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptTask", sourceId: "c1", state: "done", expectedVersion: 2, evidence: { kind: "job", jobId: "j1" } }, now), "c1 done");
  data = mussOk(run(data, "recordSourceCheck", { date, sourceId: "quantus-core", cursor: "c2", outcome: "ok" }, now, ADAPTER), "core");
  gruen(ampel(data, date, now), "vor Abschluss");
  const d1 = mussOk(run(data, "closeRun", { date, finalNoteId: "note_final" }, now), "close");
  assert.ok(d1.dailyBriefing.assistantRuns[date].closureOutcomes["project:p1"].deadlines.d1.done);
  const t1 = now + 10 * MIN;
  const widerspruch = (name, mut, reason) => {
    const k = K.klon(d1); mut(k);
    const w = K.pruefeWiderspruch(k, { date }, { now: t1, policy: POLICY });
    assert.ok(w.contradictions.length, name + ": kein Widerspruch obwohl live " + ampel(k, date, t1).coverage);
    assert.ok(w.contradictions.some((c) => c.reason === reason), name + ": " + JSON.stringify(w.contradictions));
    const c = w.contradictions.find((c) => c.reason === reason);
    const inv = run(k, "invalidateClosure", { date, correctionId: "korr_" + reason, reason: name, contradiction: { sourceType: c.sourceType, sourceId: c.sourceId } }, t1);
    assert.equal(inv.ok, true, name + ": " + inv.error);
    assert.equal(inv.data.dailyBriefing.assistantRuns[date].phase, "exception_open");
    assert.equal(JSON.stringify(inv.data.entities.chatgptNotes.note_final), JSON.stringify(d1.entities.chatgptNotes.note_final));
  };
  widerspruch("B2-05 Beleg geloescht", (k) => { delete k.automation.evidenceById.proof_review; }, "WAITING_EVIDENCE_LOST");
  widerspruch("Beleg-Fingerabdruck veraendert", (k) => { k.automation.evidenceById.proof_review.fingerprint = "sha256-0000000000000000"; }, "WAITING_EVIDENCE_LOST");
  widerspruch("B2-06 nextAction geloescht", (k) => { delete k.automation.waitingById["chatgptLead:l1"].nextAction; }, "WAITING_CARD_CHANGED");
  widerspruch("waitingSince geloescht", (k) => { delete k.automation.waitingById["chatgptLead:l1"].waitingSince; }, "WAITING_CARD_CHANGED");
  widerspruch("counterparty geloescht", (k) => { delete k.automation.waitingById["chatgptLead:l1"].counterparty; }, "WAITING_CARD_CHANGED");
  widerspruch("Wartekarte weg", (k) => { delete k.automation.waitingById["chatgptLead:l1"]; }, "WAITING_CARD_LOST");
  widerspruch("Dokument-Ergebnisse weg", (k) => { k.automation.documentsById.doc1.results = []; }, "DOCUMENT_PROOF_LOST");
  widerspruch("Dokument-Extraktion weg", (k) => { k.automation.documentsById.doc1.parse.extractHash = null; }, "DOCUMENT_PROOF_LOST");
  widerspruch("Dokument wieder offen", (k) => { k.automation.documentsById.doc1.status = "open"; }, "REOPENED");
  widerspruch("Job-Review weg", (k) => { k.automation.jobsById.j1.review = null; }, "JOB_REVIEW_LOST");
  widerspruch("B2-07 Projektfrist wieder offen", (k) => { k.entities.projects.p1.deadlines[0].done = false; }, "PROJECT_DEADLINE_REOPENED");
  widerspruch("neue faellige offene Projektfrist", (k) => { k.entities.projects.p1.deadlines.push({ id: "d2", date: "2026-09-19", done: false }); }, "PROJECT_DEADLINE_DUE_AFTER_CLOSE");
  widerspruch("erledigte ChatGPT-Aufgabe wieder doing", (k) => { k.entities.chatgptTasks.c1.operationalState = "doing"; }, "REOPENED");
  // Unabhaengige neue Eingaenge nach dem Cutoff invalidieren NICHT.
  let d2 = mussOk(run(d1, "registerIntake", { intakeId: "in_neu", text: "neu", channel: "mobile" }, t1, USER), "intake");
  const n0 = K.klon(d2); n0.entities.chatgptLeads.l7 = { id: "l7", status: "neu", readAt: null, createdAt: new Date(t1).toISOString() }; d2 = K.migrateCore(n0, { now: t1 }).data;
  const w = K.pruefeWiderspruch(d2, { date }, { now: t1, policy: POLICY });
  assert.deepEqual(w.contradictions, []);
  assert.deepEqual(w.newIntake.map((x) => x.sourceId).sort(), ["in_neu", "l7"]);
  assert.equal(run(d2, "invalidateClosure", { date, correctionId: "k", reason: "x", contradiction: { sourceType: "intake", sourceId: "in_neu" } }, t1).error, "NOT_A_CONTRADICTION");
  // Ein followUpAt, das nach dem Abschluss verstreicht, ist kein Widerspruch (Nachfassung ist Arbeit des naechsten Laufs).
  assert.deepEqual(K.pruefeWiderspruch(d1, { date }, { now: now + 25 * STD, policy: POLICY }).contradictions, []);
});

test("B2-08: Start-, Final- und Korrekturnoten sind ChatGPT Notes im bestehenden Schema; NoteFlow bleibt leer; alte Notes werden nie veraendert", () => {
  const { data, now, date } = warteTag();
  const start = data.entities.chatgptNotes.note_start;
  assert.deepEqual(Object.keys(start).sort(), ["assistantNote", "category", "comments", "createdAt", "derived", "externalLinks", "files", "id", "instruction", "instructionDate", "linkedNotes", "linkedOrganizations", "linkedProjects", "linkedTasks", "promptSection", "state", "supersededBy", "supersedes", "tags", "updatedAt"]);
  assert.equal(start.category, "auftrag"); assert.equal(start.state, "aktiv"); assert.equal(start.assistantNote.schema, "assistant-note/3");
  assert.deepEqual(data.entities.notes, {}, "NoteFlow wurde beschrieben");
  assert.equal(run(data, "ensureStartNote", { date, noteId: "note_start_2" }, now).noop, true);
  const d1 = mussOk(run(data, "closeRun", { date, finalNoteId: "note_final" }, now), "close");
  assert.deepEqual(d1.entities.notes, {});
  assert.equal(d1.entities.chatgptNotes.note_final.category, "entscheid");
  const vorher = JSON.stringify(d1.entities.chatgptNotes.note_final);
  const k = K.klon(d1); delete k.automation.evidenceById.proof_review;
  const inv = mussOk(run(k, "invalidateClosure", { date, correctionId: "note_korr", reason: "Beleg weg", contradiction: { sourceType: "chatgptLead", sourceId: "l1" } }, now + MIN), "inv");
  assert.equal(JSON.stringify(inv.entities.chatgptNotes.note_final), vorher);
  assert.equal(inv.entities.chatgptNotes.note_korr.supersedes, "note_final");
  assert.equal(inv.entities.chatgptNotes.note_korr.assistantNote.kind, "assistantCorrection");
  assert.deepEqual(inv.entities.notes, {});
  // Ein kaputter/fehlender Startnote-Eintrag ist rot, obwohl startNoteId gesetzt ist.
  const ohne = K.klon(data); delete ohne.entities.chatgptNotes.note_start;
  assert.ok(hatCode(ampel(ohne, date, now), "RUN_START_NOTE_MISSING"));
});

test("B2-09: der Umschlag-Adapter nimmt Zeit und Kennung nur aus prepared; Body-Zeit wird abgelehnt; ungueltiges prepared fail-closed; Versionskonflikte 409", () => {
  const { data, now, date } = basisTag();
  const reducer = K.commandReducer({ policy: POLICY, actor: AGENT });
  const prepared = (t, requestId = "req_9") => ({ requestId, now: new Date(t).toISOString() });
  // Serverzeit 10:00 UTC, Body behauptet 23:05 lokal → Body-Zeit abgelehnt; ohne Body-Zeit gilt die Serverzeit → CLOSURE_TOO_EARLY.
  assert.throws(() => reducer(K.klon(data), { type: "closeRun", now, payload: { date, finalNoteId: "n" } }, prepared(T("2026-09-19T10:00:00.000Z"))), (e) => e.code === "COMMAND_BODY_TIME_FORBIDDEN" && e.status === 400);
  assert.throws(() => reducer(K.klon(data), { type: "closeRun", commandId: "cmd_x", payload: { date, finalNoteId: "n" } }, prepared(now)), (e) => e.code === "COMMAND_BODY_TIME_FORBIDDEN");
  assert.throws(() => reducer(K.klon(data), { type: "closeRun", payload: { date, finalNoteId: "n" } }, prepared(T("2026-09-19T10:00:00.000Z"))), (e) => e.code === "CLOSURE_BLOCKED" && e.status === 409 && e.detail.some((b) => b.code === "CLOSURE_TOO_EARLY"));
  const out = reducer(K.klon(data), { type: "closeRun", payload: { date, finalNoteId: "n" } }, prepared(now));
  assert.equal(out.data.dailyBriefing.assistantRuns[date].finalAt, new Date(now).toISOString());
  assert.equal(out.result.finalNoteId, "n");
  for (const bad of [undefined, null, {}, { requestId: "r" }, { requestId: "r", now: 123 }, { requestId: "r", now: "2026-09-19T21:05:00+02:00" }, { requestId: "", now: new Date(now).toISOString() }]) {
    assert.throws(() => reducer(K.klon(data), { type: "ensureRun", payload: { date } }, bad), (e) => e.code === "invalid_transaction_context" && e.status === 500, JSON.stringify(bad));
  }
  // Versions-/Zustandskonflikte 409, Kernfehler 503, Formfehler 400.
  const w = warteTag();
  assert.throws(() => reducer(K.klon(w.data), { type: "transitionState", payload: { sourceType: "chatgptLead", sourceId: "l1", state: "doing", expectedVersion: 1, reason: "x" } }, prepared(now)), (e) => e.code === "VERSION_MISMATCH" && e.status === 409);
  assert.throws(() => reducer(K.klon(w.data), { type: "recordSlotReceipt", payload: { date, slot: "close23", receiptId: "anders" } }, prepared(now)), (e) => e.code === "SLOT_ALREADY_RECEIPTED" && e.status === 409);
  const kaputt = K.klon(w.data); kaputt.automation.dataRevision = -1;
  assert.throws(() => reducer(kaputt, { type: "ensureRun", payload: { date } }, prepared(now)), (e) => e.status === 503);
  assert.throws(() => reducer(K.klon(w.data), { type: "ensureRun", payload: { date, extra: 1 } }, prepared(now)), (e) => e.code === "COMMAND_REJECTED" && e.status === 400);
  // Lokale Domain-Tests duerfen now stellen (applyCommand), der Adapter nicht — die Kennung ist die requestId.
  assert.equal(K.applyCommand(data, { type: "ensureRun", commandId: "lokal", now, payload: { date } }, { policy: POLICY, actor: AGENT }).ok, true);
});

/* ══ Dritte Pruefung (B3-01 … B3-04, Konzept 12.2) ═══════════════════════ */
test("B3-01: v3-Spuren in einem unvollstaendigen Kern sind fail-closed (503); erste Legacy-Migration und wiederholte intakte Migration bleiben erlaubt", () => {
  // Gueltiger, bereits migrierter Kern: erneute Migration ist unveraendert.
  const { data } = basisTag();
  const wieder = K.migrateCore(data, { now: NOW + STD });
  assert.equal(wieder.changed, false); assert.equal(wieder.report.mode, "repeat");
  // Loeschungen von Ledger, Outbox, Revision: kein stilles {} / 0.
  for (const [pfad, loeschen] of [
    ["automation.idempotencyByKey", (k) => { delete k.automation.idempotencyByKey; }],
    ["automation.outboxById", (k) => { delete k.automation.outboxById; }],
    ["automation.dataRevision", (k) => { delete k.automation.dataRevision; }],
    ["automation.evidenceById", (k) => { delete k.automation.evidenceById; }],
    ["automation.migration", (k) => { delete k.automation.migration; }],
    ["automation.activeLease", (k) => { k.automation.activeLease = "runner"; }],
    ["automation.schemaVersion", (k) => { delete k.automation.schemaVersion; }],
    ["dailyBriefing.assistantRuns", (k) => { delete k.dailyBriefing.assistantRuns; }],
    ["dailyBriefing.assistantRuns.<date>.phase", (k) => { k.dailyBriefing.assistantRuns["2026-09-19"].phase = "closed"; }],
    ["dailyBriefing.assistantRuns.<date>.revision", (k) => { delete k.dailyBriefing.assistantRuns["2026-09-19"].revision; }],
    ["entities.chatgptLeads", (k) => { delete k.entities.chatgptLeads; }],
    ["entities.chatgptNotes", (k) => { delete k.entities.chatgptNotes; }],
    ["entities.projects", (k) => { k.entities.projects = []; }],
  ]) {
    const k = K.klon(data); loeschen(k);
    const vorher = JSON.stringify(k);
    assert.throws(() => K.migrateCore(k, { now: NOW + STD }), (e) => (e.code === "CORE_PARTIAL_V3" || e.code === "CORE_STORE_CORRUPT") && e.status === 503, pfad + " wurde still geheilt");
    assert.equal(JSON.stringify(k), vorher, pfad + ": Eingabe veraendert");
  }
  // Nur automation geloescht, aber Laeufe/Objekte tragen v3-Spuren → ebenfalls partiell.
  const ohneAutomation = K.klon(data); delete ohneAutomation.automation;
  assert.throws(() => K.migrateCore(ohneAutomation, { now: NOW }), (e) => e.code === "CORE_PARTIAL_V3");
  const nurObjekt = bestand(); nurObjekt.entities.chatgptLeads.l1.operationalStateSource = { legacyValue: "in_arbeit" };
  assert.throws(() => K.migrateCore(nurObjekt, { now: NOW }), (e) => e.code === "CORE_PARTIAL_V3");
  assert.deepEqual(K.v3Spuren(nurObjekt), ["entities.chatgptLeads.l1"]);
  // Echte Erstmigration: keine Spuren → erlaubt, fehlende Pflichtsammlungen werden leer angelegt, Fremdes und Grabsteine bleiben.
  const legacy = { entities: { tasks: { t1: { id: "t1", status: "todo" } }, chatgptLeads: {} }, _deleteLog: { tasks: { t9: 1 } }, fremd: 1, dailyBriefing: { routines: [] } };
  const m = K.migrateCore(legacy, { now: NOW });
  assert.equal(m.report.mode, "initial");
  assert.deepEqual(m.data._deleteLog, legacy._deleteLog); assert.equal(m.data.fremd, 1);
  assert.deepEqual(m.data.entities.chatgptNotes, {}); assert.deepEqual(m.data.entities.projects, {});
  assert.deepEqual(m.data.dailyBriefing.routines, []);
  assert.equal(m.data.automation.dataRevision, 0);
  // Wiederholte intakte Migration nimmt neue Client-Objekte ohne v3-Felder mit, ohne den Rest anzufassen.
  const neu = K.klon(m.data); neu.entities.chatgptLeads.l2 = { id: "l2", status: "neu", readAt: null };
  const m2 = K.migrateCore(neu, { now: NOW + STD });
  assert.equal(m2.report.mode, "repeat"); assert.equal(m2.data.entities.chatgptLeads.l2.operationalState, "doing");
  assert.equal(m2.data.automation.migration.migratedAt, m.data.automation.migration.migratedAt);
});

/* Gemeinsame Basis fuer B3-02…04: ChatGPT-Aufgabe t1 (v1) am gruenen Tag. */
function aufgabenTag() {
  const s = basisTag((d) => { d.entities.chatgptTasks.t1 = { id: "t1", text: "Review", state: "offen", createdAt: "2026-09-18T00:00:00Z" }; return d; });
  s.data = mussOk(run(s.data, "addItemRef", { date: s.date, sourceType: "chatgptTask", sourceId: "t1" }, s.now), "ref");
  return s;
}
const JOB = (now) => ({ jobId: "job_review", kind: "review", purpose: "Ergebnis pruefen", sourceType: "chatgptTask", sourceId: "t1", inputVersion: 1, executor: "claude", contextRefs: [{ sourceType: "chatgptTask", sourceId: "t1" }], expiresAt: new Date(now + STD).toISOString() });

test("B3-02: ein Ruecklauf zu v1 kann nach einem legalen Zustandswechsel auf v2 nicht mehr angenommen werden — Review prueft live, nicht das gespeicherte stale-Flag", () => {
  let { data, now } = aufgabenTag();
  data = mussOk(run(data, "createJob", JOB(now), now), "job");
  data = mussOk(run(data, "recordJobReturn", { jobId: "job_review", outcome: "returned", resultRef: "review_result", resultHash: "a".repeat(64) }, now + MIN, WORKER), "return");
  assert.equal(data.automation.jobsById.job_review.result.stale, false);
  // Ohne weitere Aenderung: accepted korrekt (Kontrolle, auf einer Kopie).
  const direkt = run(data, "reviewJobResult", { jobId: "job_review", verdict: "accepted", reviewer: "laurin" }, now + 2 * MIN, USER);
  assert.equal(direkt.ok, true); assert.equal(direkt.data.automation.jobsById.job_review.review.sourceVersion, 1);
  // Legaler Zustandswechsel durch den Nutzer → v2.
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptTask", sourceId: "t1", state: "review", expectedVersion: 1 }, now + 2 * MIN, USER), "review v2");
  assert.equal(ver(data, "chatgptTask", "t1"), 2);
  const spaet = run(data, "reviewJobResult", { jobId: "job_review", verdict: "accepted", reviewer: "laurin" }, now + 3 * MIN, USER);
  assert.equal(spaet.error, "JOB_RESULT_NOT_ACCEPTABLE"); assert.equal(spaet.detail.reason, "stale"); assert.equal(spaet.detail.sourceVersion, 2);
  assert.equal(data.entities.chatgptTasks.t1.operationalStateVersion, 2, "neuere Arbeit wurde veraendert");
  assert.equal(data.automation.jobsById.job_review.review, null);
  // Abgelehnt bleibt moeglich; der abgelehnte Job ist kein Abschlussbeleg.
  const rej = mussOk(run(data, "reviewJobResult", { jobId: "job_review", verdict: "rejected", reviewer: "laurin", note: "stale" }, now + 3 * MIN, USER), "reject");
  assert.equal(run(rej, "transitionState", { sourceType: "chatgptTask", sourceId: "t1", state: "done", expectedVersion: 2, evidence: { kind: "job", jobId: "job_review" } }, now + 4 * MIN).error, "DONE_JOB_NOT_ACCEPTED");
  // Solange die Rueckgabe ungeprueft ist, ist done blockiert; nach der Ablehnung ist der Beleg ein anderer, und ein zweites Review gibt es nicht.
  let d2 = mussOk(run(data, "registerEvidence", { evidenceId: "ev_t1", kind: "message", ref: "m", sourceType: "chatgptTask", sourceId: "t1", origin: { adapter: "x", ref: "y" }, observedAt: new Date(now).toISOString(), fingerprint: "0123456789abcdef0123" }, now + 3 * MIN, ADAPTER), "ev");
  assert.equal(run(d2, "transitionState", { sourceType: "chatgptTask", sourceId: "t1", state: "done", expectedVersion: 2, evidence: { kind: "evidence", evidenceId: "ev_t1" } }, now + 4 * MIN).error, "JOB_RETURN_UNREVIEWED");
  d2 = mussOk(run(d2, "reviewJobResult", { jobId: "job_review", verdict: "rejected", reviewer: "laurin" }, now + 4 * MIN, USER), "reject");
  d2 = mussOk(run(d2, "transitionState", { sourceType: "chatgptTask", sourceId: "t1", state: "done", expectedVersion: 2, evidence: { kind: "evidence", evidenceId: "ev_t1" } }, now + 5 * MIN), "done");
  assert.equal(run(d2, "reviewJobResult", { jobId: "job_review", verdict: "accepted", reviewer: "x" }, now + 6 * MIN, USER).error, "JOB_ALREADY_REVIEWED");
  assert.equal(d2.entities.chatgptTasks.t1.operationalState, "done");
});

test("B3-03: ein done ist an seinen Beleg gebunden — verschwindet oder aendert sich der Beleg, ist die Ampel rot und der Abschluss widerlegt; Migration und Nutzer-Selbsterledigung sind unterscheidbar", () => {
  let { data, now, date } = aufgabenTag();
  data = mussOk(run(data, "registerEvidence", { evidenceId: "proof_review", kind: "mail", ref: "rfc822:<r@p.example>", sourceType: "chatgptTask", sourceId: "t1", origin: { adapter: "gmail", ref: "m1" }, observedAt: new Date(now - MIN).toISOString(), fingerprint: "sha256-abcdef0123456789" }, now, ADAPTER), "beleg");
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptTask", sourceId: "t1", state: "done", expectedVersion: 1, evidence: { kind: "evidence", evidenceId: "proof_review" } }, now, AGENT), "done");
  const closure = data.entities.chatgptTasks.t1.operationalStateSource.closure;
  assert.equal(closure.kind, "evidence"); assert.ok(closure.binding.includes("sha256-abcdef0123456789"));
  gruen(ampel(data, date, now), "vor Abschluss");
  data = mussOk(run(data, "recordSourceCheck", { date, sourceId: "quantus-core", cursor: "c2", outcome: "ok" }, now, ADAPTER), "core");
  const d1 = mussOk(run(data, "closeRun", { date, finalNoteId: "note_final" }, now), "close");
  assert.equal(d1.dailyBriefing.assistantRuns[date].closureOutcomes["chatgptTask:t1"].closure.origin, "evidence");
  const t1 = now + 5 * MIN;
  for (const [name, mut, code] of [
    ["Beleg geloescht", (k) => { delete k.automation.evidenceById.proof_review; }, "CLOSURE_EVIDENCE_LOST"],
    ["Beleg-Fingerabdruck getauscht", (k) => { k.automation.evidenceById.proof_review.fingerprint = "sha256-0000000000000000"; }, "CLOSURE_EVIDENCE_CHANGED"],
    ["Beleg an fremdes Element gebunden", (k) => { k.automation.evidenceById.proof_review.sourceId = "t2"; }, "CLOSURE_EVIDENCE_LOST"],
    ["Bindung am Zustand entfernt", (k) => { delete k.entities.chatgptTasks.t1.operationalStateSource.closure.binding; }, "CLOSURE_EVIDENCE_UNBOUND"],
    ["closure auf anderen Beleg umgebogen", (k) => { k.entities.chatgptTasks.t1.operationalStateSource.closure.evidenceId = "anderer"; }, "CLOSURE_EVIDENCE_LOST"],
  ]) {
    const k = K.klon(d1); mut(k);
    const ev = ampel(k, date, t1);
    assert.equal(ev.coverage, "red", name + ": " + JSON.stringify(ev.reasons));
    assert.ok(hatCode(ev, code, "t1"), name + ": " + JSON.stringify(ev.reasons));
    const w = K.pruefeWiderspruch(k, { date }, { now: t1, policy: POLICY });
    assert.ok(w.contradictions.some((c) => c.sourceId === "t1" && c.reason === "CLOSURE_EVIDENCE_LOST"), name + ": " + JSON.stringify(w.contradictions));
    const inv = run(k, "invalidateClosure", { date, correctionId: "korr_" + name.replace(/\W+/g, "_"), reason: name, contradiction: { sourceType: "chatgptTask", sourceId: "t1" } }, t1);
    assert.equal(inv.ok, true, name + ": " + inv.error);
  }
  // Historische Alt-done-Migration: kein Beleg noetig, klar als "migration" gefuehrt.
  const alt = K.migrateCore({ entities: { tasks: {}, projects: {}, notes: {}, chatgptNotes: {}, chatgptLeads: {}, chatgptTasks: { c9: { id: "c9", text: "alt", state: "erledigt", resolvedAt: "2026-09-01T00:00:00Z" } } } }, { now: NOW }).data;
  assert.deepEqual(K.abschlussBelegPruefen(alt, "chatgptTask", "c9", alt.entities.chatgptTasks.c9), { ok: true, origin: "migration" });
  assert.ok(!hatCode(K.dailyAssistantTrafficLight(K.leererRun(date, "3.0"), alt, now, POLICY), "STATE_CLAIM_UNPROVEN", "c9"));
  // Nutzer-Selbsterledigung einer Nutzeraufgabe: Herkunft "user", ohne externen Beleg, bleibt gruen.
  const u0 = basisTag((d) => { d.entities.tasks.u1 = { id: "u1", title: "meins", status: "todo", dueDate: "2026-09-19" }; return d; });
  let u = mussOk(run(u0.data, "addItemRef", { date, sourceType: "task", sourceId: "u1" }, u0.now), "ref");
  u = mussOk(run(u, "transitionState", { sourceType: "task", sourceId: "u1", state: "done", expectedVersion: 1 }, u0.now, USER), "user done");
  assert.equal(K.abschlussBelegPruefen(u, "task", "u1", u.entities.tasks.u1).origin, "user");
  gruen(ampel(u, date, u0.now), "user done");
  // Ein von Hand hingeschriebenes closure {kind:"user"} ohne actorId ist unbelegt.
  const f = K.klon(u); f.entities.tasks.u1.operationalStateSource.closure = { kind: "user" };
  assert.ok(hatCode(ampel(f, date, u0.now), "STATE_CLAIM_UNPROVEN", "u1"));
});

test("B3-04: ein done ueber ein angenommenes Job-Ergebnis bindet Ergebnis-Hash, -Referenz und Review — Tausch nach dem Abschluss ist rot und ein Widerspruch", () => {
  let { data, now, date } = aufgabenTag();
  data = mussOk(run(data, "createJob", JOB(now), now), "job");
  data = mussOk(run(data, "recordJobReturn", { jobId: "job_review", outcome: "returned", resultRef: "review_result", resultHash: "a".repeat(64) }, now + MIN, WORKER), "return");
  data = mussOk(run(data, "reviewJobResult", { jobId: "job_review", verdict: "accepted", reviewer: "laurin" }, now + 2 * MIN, USER), "review");
  assert.equal(ver(data, "chatgptTask", "t1"), 2);
  data = mussOk(run(data, "transitionState", { sourceType: "chatgptTask", sourceId: "t1", state: "done", expectedVersion: 2, evidence: { kind: "job", jobId: "job_review" } }, now + 3 * MIN), "done");
  assert.ok(data.entities.chatgptTasks.t1.operationalStateSource.closure.binding.includes("a".repeat(64)));
  data = mussOk(run(data, "recordSourceCheck", { date, sourceId: "quantus-core", cursor: "c2", outcome: "ok" }, now + 3 * MIN, ADAPTER), "core");
  gruen(ampel(data, date, now + 3 * MIN), "vor Abschluss");
  const d1 = mussOk(run(data, "closeRun", { date, finalNoteId: "note_final" }, now + 3 * MIN), "close");
  const t1 = now + 10 * MIN;
  for (const [name, mut, ampelCode, wCodes] of [
    ["result.hash getauscht", (k) => { k.automation.jobsById.job_review.result.hash = "b".repeat(64); }, "CLOSURE_EVIDENCE_LOST", ["CLOSURE_EVIDENCE_LOST", "JOB_RESULT_CHANGED"]],
    ["result.ref getauscht", (k) => { k.automation.jobsById.job_review.result.ref = "other_result"; }, "CLOSURE_EVIDENCE_LOST", ["CLOSURE_EVIDENCE_LOST", "JOB_RESULT_CHANGED"]],
    ["reviewedAt entfernt", (k) => { delete k.automation.jobsById.job_review.review.reviewedAt; }, "CLOSURE_EVIDENCE_CHANGED", ["CLOSURE_EVIDENCE_LOST", "JOB_REVIEW_LOST"]],
    ["Review entfernt", (k) => { k.automation.jobsById.job_review.review = null; }, "CLOSURE_EVIDENCE_LOST", ["CLOSURE_EVIDENCE_LOST", "JOB_REVIEW_LOST"]],
    ["Verdict getauscht", (k) => { k.automation.jobsById.job_review.review.verdict = "rejected"; }, "CLOSURE_EVIDENCE_LOST", ["CLOSURE_EVIDENCE_LOST", "JOB_REVIEW_LOST"]],
    ["Job geloescht", (k) => { delete k.automation.jobsById.job_review; }, "CLOSURE_EVIDENCE_LOST", ["CLOSURE_EVIDENCE_LOST", "OBLIGATION_MISSING"]],
  ]) {
    const k = K.klon(d1); mut(k);
    const ev = ampel(k, date, t1);
    assert.equal(ev.coverage, "red", name + ": " + JSON.stringify(ev.reasons));
    assert.ok(hatCode(ev, ampelCode, "t1"), name + ": " + JSON.stringify(ev.reasons));
    const w = K.pruefeWiderspruch(k, { date }, { now: t1, policy: POLICY });
    for (const c of wCodes) assert.ok(w.contradictions.some((x) => x.reason === c), name + " erwartet " + c + ": " + JSON.stringify(w.contradictions));
  }
  // Dokument-Ergebnisse, die auf verschwundene Elemente zeigen, sind ein Widerspruch.
  let d2 = mussOk(run(d1, "registerDocument", { documentId: "doc1", attachmentId: ATT("a.pdf"), name: "a.pdf", hash: H64, mime: "application/pdf", size: 10, origin: { channel: "mail", ref: "m" }, linkedTo: { sourceType: "chatgptTask", sourceId: "t1" } }, t1, ADAPTER), "doc");
  d2 = mussOk(run(d2, "recordDocumentParse", { documentId: "doc1", outcome: "parsed", textRef: ATT("a.txt"), extractHash: "c".repeat(64) }, t1, ADAPTER), "parse");
  d2 = mussOk(run(d2, "transitionState", { sourceType: "document", sourceId: "doc1", state: "done", results: [{ sourceType: "chatgptTask", sourceId: "t1" }] }, t1), "doc done");
  const m = K.verpflichtungsmenge(d2, date);
  assert.equal(m["document:doc1"].resultsExist, true);
  const weg = K.klon(d2); delete weg.entities.chatgptTasks.t1;
  assert.equal(K.verpflichtungsmenge(weg, date)["document:doc1"].resultsExist, false);
});

test("Konzept 12.2: das Sechs-Kriterien-Raster ist keine Pflicht mehr; Ergebnis, explizite Rollen und ein vorhandener Routingnachweis werden geprueft; Altfelder bleiben", () => {
  const t0 = "2026-09-18T00:00:00Z";
  const s = basisTag((d) => { d.entities.chatgptLeads.k1 = { id: "k1", title: "klein", rawInput: "x", status: "in_arbeit", readAt: t0, assignee: "chatgpt", result: "#/organizations/abc", createdAt: t0 }; return d; });
  let { data, now, date } = s;
  data = mussOk(run(data, "addItemRef", { date, sourceType: "chatgptLead", sourceId: "k1" }, now), "ref");
  assert.deepEqual(K.leadUnvollstaendig(data.entities.chatgptLeads.k1), [], "ein kleiner Lead ohne Raster, Begruendung oder Verknuepfung ist vollstaendig");
  data = mussOk(run(data, "registerEvidence", { evidenceId: "ev_k1", kind: "message", ref: "m", sourceType: "chatgptLead", sourceId: "k1", origin: { adapter: "x", ref: "y" }, observedAt: new Date(now).toISOString(), fingerprint: "0123456789abcdef0123" }, now, ADAPTER), "ev");
  const fertig = mussOk(run(data, "transitionState", { sourceType: "chatgptLead", sourceId: "k1", state: "done", expectedVersion: 1, evidence: { kind: "evidence", evidenceId: "ev_k1" } }, now), "done");
  assert.equal(fertig.entities.chatgptLeads.k1.assessment, undefined, "es werden keine Rasterdaten erfunden");
  // Ohne Ergebnis, ohne Executor, mit ungueltigem oder widerspruechlichem Routingnachweis: unvollstaendig.
  const ohneErgebnis = K.klon(data.entities.chatgptLeads.k1); ohneErgebnis.result = " ";
  assert.deepEqual(K.leadUnvollstaendig(ohneErgebnis), ["result"]);
  const ohneExecutor = K.klon(data.entities.chatgptLeads.k1); ohneExecutor.operationalRoles = { accountable: "chatgpt", executor: null };
  assert.deepEqual(K.leadUnvollstaendig(ohneExecutor), ["executor"]);
  const kaputt = K.klon(data.entities.chatgptLeads.k1); kaputt.routing = { decision: "irgendwas" };
  assert.deepEqual(K.leadUnvollstaendig(kaputt), ["routing"]);
  const widerspruch = K.klon(data.entities.chatgptLeads.k1); widerspruch.routing = { schema: "lead-routing/3", routerVersion: "1.0", executor: "claude", decidedAt: "2026-09-19T08:00:00Z", fingerprint: "0123456789abcdef" };
  assert.deepEqual(K.leadUnvollstaendig(widerspruch), ["routing_executor_mismatch"]);
  const passt = K.klon(widerspruch); passt.routing.executor = "openai";
  assert.deepEqual(K.leadUnvollstaendig(passt), []);
  // Legacy-Rasterfelder bleiben unangetastet und werden weder verlangt noch veraendert.
  const alt = K.klon(data.entities.chatgptLeads.k1); alt.assessment = { menge: "cowork", werkzeug: null }; alt.assignmentReason = ""; alt.linkedOrganizations = [];
  assert.deepEqual(K.leadUnvollstaendig(alt), []);
  assert.deepEqual(alt.assessment, { menge: "cowork", werkzeug: null });
});
