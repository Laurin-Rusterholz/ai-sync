/* ══ Tagesbriefing v3 — Buchhaltung: die reinen Mutationen ══════════════════
 *
 * Jede Funktion hier hat dieselbe Form:
 *
 *     f(data, payload, ctx) → { ok: true, data, ... } | { ok: false, error, detail? }
 *
 * "data" ist der geparste Vollbestand; das Ergebnis ist eine TIEFE KOPIE mit
 * der Aenderung, die Eingabe bleibt unberuehrt. "ctx" traegt now (ms) und
 * policy. Keine Uhr, kein Zufall, keine Kennungserzeugung: IDs kommen von
 * aussen herein, damit der spaetere CAS-Schreibpfad die Mutation bei einem
 * Konflikt wortgleich wiederholen kann.
 *
 * Idempotenz gilt auf Ebene der Fachlichkeit (dieselbe Quittung noch einmal
 * → kein zweiter Eintrag) UND auf Ebene des Kommandos (commandId, siehe
 * assistant-core.mjs).
 * ═════════════════════════════════════════════════════════════════════════ */
import {
  OPERATIONAL_STATES, WARTE_ZUSTAENDE, ABGESCHLOSSENE_ZUSTAENDE, EXECUTORS,
  QUELLEN, MAPPER, effektiverZustand, rollenFuer, leererRun, pruefeId, sourceKey,
  validatePolicy,
} from "./assistant-schema.mjs";
import { klon, requireCore } from "./assistant-migration.mjs";
import {
  istLokalDatum, isoAus, msAus, slotBeginnMs, slotKey, slotDefinition, ZEIT,
} from "./assistant-zeit.mjs";

const fehler = (error, detail) => ({ ok: false, error, detail: detail == null ? null : detail });

function istKarte(v) { return v && typeof v === "object" && !Array.isArray(v); }

function ctxPruefen(ctx) {
  if (!ctx || typeof ctx.now !== "number" || !Number.isFinite(ctx.now)) throw new TypeError("ctx.now (ms) fehlt");
  return ctx;
}

/* Jede Mutation, die den Bestand veraendert, zaehlt dataRevision hoch. */
export function bump(data, now) {
  data.automation.dataRevision = (Number(data.automation.dataRevision) || 0) + 1;
  data.automation.updatedAt = isoAus(now);
  return data.automation.dataRevision;
}

function runVon(data, date) {
  return istKarte(data.dailyBriefing.assistantRuns[date]) ? data.dailyBriefing.assistantRuns[date] : null;
}

function runAnfassen(run, now) {
  run.revision = (Number(run.revision) || 0) + 1;
  run.updatedAt = isoAus(now);
}

/* Entitaet einer Quelle im Bestand finden — nur echte Sammlungen. */
export function quelleFinden(data, sourceType, sourceId) {
  const q = QUELLEN[sourceType];
  if (q) {
    const store = data.entities[q.store];
    return istKarte(store) && istKarte(store[sourceId]) ? store[sourceId] : null;
  }
  const karte = {
    intake: data.automation.intakeById, question: data.automation.questionsById,
    document: data.automation.documentsById, job: data.automation.jobsById,
  }[sourceType];
  if (sourceType === "project") return istKarte(data.entities.projects) && istKarte(data.entities.projects[sourceId]) ? data.entities.projects[sourceId] : null;
  return istKarte(karte) && istKarte(karte[sourceId]) ? karte[sourceId] : null;
}

/* ── Lauf ──────────────────────────────────────────────────────────────── */
export function ensureRun(input, { date }, ctx) {
  ctxPruefen(ctx);
  if (!istLokalDatum(date)) return fehler("DATE_INVALID", date);
  const p = validatePolicy(ctx.policy);
  if (!p.ok) return fehler("POLICY_INVALID", p.errors);
  const data = klon(requireCore(input));
  if (runVon(data, date)) return { ok: true, data, run: runVon(data, date), created: false };
  const run = leererRun(date, ctx.policy.version);
  run.createdAt = isoAus(ctx.now);
  run.updatedAt = run.createdAt;
  data.dailyBriefing.assistantRuns[date] = run;
  bump(data, ctx.now);
  return { ok: true, data, run, created: true };
}

/* Genau EINE Startnotiz pro Tag. Ein zweiter Aufruf — auch mit anderer
 * noteId — legt nichts an und meldet die bestehende. */
export function ensureStartNote(input, { date, noteId, title, content }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const run = runVon(data, date);
  if (!run) return fehler("RUN_MISSING", date);
  if (run.startNoteId) {
    const vorhanden = data.entities.notes && data.entities.notes[run.startNoteId];
    return { ok: true, data, noteId: run.startNoteId, created: false, noteExists: !!vorhanden };
  }
  pruefeId(noteId, "noteId");
  data.entities.notes = istKarte(data.entities.notes) ? data.entities.notes : {};
  if (data.entities.notes[noteId]) return fehler("NOTE_ID_TAKEN", noteId);
  data.entities.notes[noteId] = notizBauen(noteId, {
    title: title || `Tagesbriefing ${date} — Start`,
    content: content || "",
    kind: "assistantStart", date, now: ctx.now,
  });
  run.startNoteId = noteId;
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, noteId, created: true, noteExists: true };
}

export function notizBauen(id, { title, content, kind, date, now }) {
  const iso = isoAus(now);
  return {
    id, title: String(title), content: String(content || ""),
    tags: ["tagesbriefing", kind === "assistantFinal" ? "final" : kind === "assistantCorrection" ? "korrektur" : "start"],
    assistantNote: { kind, runDate: date },
    comments: [], externalLinks: [],
    linkedTasks: [], linkedProjects: [], linkedOrganizations: [], linkedIdeas: [], linkedMeetings: [],
    linkedGoals: [], linkedStrategies: [], linkedNotes: [], linkedCalendarEvents: [],
    notebookId: null, order: 0,
    createdAt: iso, updatedAt: iso,
  };
}

/* Slot-Quittung. Nur fuer einen Slot, der bereits begonnen hat; dieselbe
 * Quittung zweimal ist ein No-op, eine ANDERE Quittung fuer denselben Slot
 * ein Fehler (ein Slot laeuft genau einmal). */
export function recordSlotReceipt(input, { date, slot, receiptId, note }, ctx) {
  ctxPruefen(ctx);
  const p = validatePolicy(ctx.policy);
  if (!p.ok) return fehler("POLICY_INVALID", p.errors);
  const data = klon(requireCore(input));
  const run = runVon(data, date);
  if (!run) return fehler("RUN_MISSING", date);
  try { slotDefinition(slot); } catch { return fehler("SLOT_UNKNOWN", slot); }
  pruefeId(receiptId, "receiptId");
  if (run.phase === "final") return fehler("RUN_FINAL", date);
  if (slotBeginnMs(date, slot) > ctx.now) return fehler("SLOT_NOT_STARTED", { slot, startsAt: isoAus(slotBeginnMs(date, slot)) });
  const vorhanden = run.slotReceipts[slot];
  if (vorhanden && vorhanden.receiptId === receiptId) return { ok: true, data, receipt: vorhanden, created: false };
  if (vorhanden) return fehler("SLOT_ALREADY_RECEIPTED", { slot, receiptId: vorhanden.receiptId });
  const key = slotKey(ctx.policy.tenant, date, slot, ctx.policy.version);
  run.slotReceipts[slot] = { receiptId, slotKey: key, at: isoAus(ctx.now), note: note ? String(note).slice(0, 500) : null };
  if (run.phase === "created") run.phase = "active";
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, receipt: run.slotReceipts[slot], created: true };
}

export const SOURCE_OUTCOMES = Object.freeze(["ok", "partial", "auth_error", "budget_exceeded", "unreachable"]);

export function recordSourceCheck(input, { date, sourceId, cursor, outcome, detail }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const run = runVon(data, date);
  if (!run) return fehler("RUN_MISSING", date);
  pruefeId(sourceId, "sourceId");
  if (!SOURCE_OUTCOMES.includes(outcome)) return fehler("SOURCE_OUTCOME_UNKNOWN", outcome);
  if (typeof cursor !== "string" && typeof cursor !== "number") return fehler("SOURCE_CURSOR_MISSING");
  const eintrag = { cursor, checkedAt: isoAus(ctx.now), outcome, detail: detail ? String(detail).slice(0, 500) : null };
  run.sourceChecks[sourceId] = eintrag;
  data.automation.sourceCursors[sourceId] = { cursor, checkedAt: eintrag.checkedAt, outcome };
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, check: eintrag };
}

/* Verweis auf ein Element — NUR Typ, Id, Zeitpunkt, Herkunft. Es werden
 * ausdruecklich keine Status-, Evidenz- oder nextAction-Felder kopiert:
 * die Wahrheit steht am Element, der Lauf zeigt nur darauf. */
export function addItemRef(input, { date, sourceType, sourceId, carriedFrom }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const run = runVon(data, date);
  if (!run) return fehler("RUN_MISSING", date);
  let key;
  try { key = sourceKey(sourceType, sourceId); } catch (e) { return fehler("SOURCE_REF_INVALID", e.message); }
  if (!quelleFinden(data, sourceType, sourceId)) return fehler("SOURCE_NOT_FOUND", key);
  if (run.itemRefs.some((r) => r.sourceType === sourceType && r.sourceId === sourceId)) return { ok: true, data, created: false };
  const ref = { sourceType, sourceId, includedAt: isoAus(ctx.now) };
  if (carriedFrom) { if (!istLokalDatum(carriedFrom)) return fehler("DATE_INVALID", carriedFrom); ref.carriedFrom = carriedFrom; }
  run.itemRefs.push(ref);
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, created: true, ref };
}

/* Carry-over: offene Elemente des Vortages als VERWEISE in den neuen Lauf
 * uebernehmen. Es entsteht keine neue Aufgabe, kein neuer Lead — nur ein
 * itemRef mit carriedFrom. */
export function carryOverRefs(input, { fromDate, toDate }, ctx) {
  ctxPruefen(ctx);
  let data = klon(requireCore(input));
  const von = runVon(data, fromDate);
  if (!von) return fehler("RUN_MISSING", fromDate);
  if (!runVon(data, toDate)) return fehler("RUN_MISSING", toDate);
  const uebernommen = [];
  for (const ref of von.itemRefs) {
    if (!QUELLEN[ref.sourceType] && !["intake", "document", "job", "question"].includes(ref.sourceType)) continue;
    const e = quelleFinden(data, ref.sourceType, ref.sourceId);
    if (!e) continue;
    if (QUELLEN[ref.sourceType]) {
      const z = effektiverZustand(ref.sourceType, e);
      if (!z.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) continue;
    } else if (e.status === "done" || e.state === "done" || e.consumedAt) continue;
    const r = addItemRef(data, { date: toDate, sourceType: ref.sourceType, sourceId: ref.sourceId, carriedFrom: ref.carriedFrom || fromDate }, ctx);
    if (r.ok) { data = r.data; if (r.created) uebernommen.push(r.ref); }
  }
  return { ok: true, data, carried: uebernommen };
}

/* ── Fortschritt und Verschiebungen ─────────────────────────────────────
 * Der Zaehler lebt ausschliesslich hier (serverseitig). Ein Fingerabdruck
 * aus den SUBSTANZIELLEN Feldern entscheidet, ob Fortschritt anerkannt
 * wird; Titel, Kommentare, Zuweisung, Tags und Wiederholungszaehler sind
 * ausdruecklich NICHT Teil davon. Eine Frist (dueDate / followUpAt), die
 * nach hinten wandert, ohne dass sich der Fingerabdruck aendert, ist eine
 * Verschiebung. */
export function fortschrittsFingerabdruck(sourceType, e, waiting) {
  const z = effektiverZustand(sourceType, e);
  const teile = [z.state || "unmapped"];
  if (sourceType === "chatgptLead") {
    for (const f of ["interpretation", "research", "plan", "execution", "result"]) teile.push(String(e[f] || "").trim());
    teile.push(e.handoverAt || "", e.returnedAt || "", e.closedAt || "");
  } else if (sourceType === "chatgptTask") {
    teile.push(e.resolvedAt || "");
  } else if (sourceType === "task") {
    const wf = Array.isArray(e.workflow) ? e.workflow.filter((s) => s && (s.done || s.completed)).length : 0;
    const ms = Array.isArray(e.measures) ? e.measures.filter((m) => m && m.status === "done").length : 0;
    teile.push(String(wf), String(ms), e.completedAt || "");
  }
  if (waiting) teile.push("waiting:" + waiting.state + ":" + waiting.counterparty + ":" + waiting.evidence.kind + "/" + waiting.evidence.ref);
  return teile.join("\u0001");
}

export function fristMarker(sourceType, e, waiting) {
  if (waiting && waiting.followUpAt) return msAus(waiting.followUpAt);
  if (sourceType === "task" && e.dueDate) return msAus(String(e.dueDate).slice(0, 10) + "T00:00:00Z");
  return null;
}

export function observeSource(input, { sourceType, sourceId }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  if (!QUELLEN[sourceType]) return fehler("SOURCE_TYPE_NOT_OBSERVABLE", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const key = sourceKey(sourceType, sourceId);
  const waiting = data.automation.waitingById[key] || null;
  const fp = fortschrittsFingerabdruck(sourceType, e, waiting);
  const frist = fristMarker(sourceType, e, waiting);
  const bisher = data.automation.progressById[key] || null;
  const nowIso = isoAus(ctx.now);
  let deferrals = bisher ? Number(bisher.deferrals) || 0 : 0;
  let lastProgressAt = bisher ? bisher.lastProgressAt : nowIso;
  let ereignis = "unchanged";
  if (!bisher) ereignis = "first";
  else if (bisher.fingerprint !== fp) { ereignis = "progress"; deferrals = 0; lastProgressAt = nowIso; }
  else if (frist != null && bisher.dueMarker != null && frist > bisher.dueMarker) { ereignis = "deferral"; deferrals += 1; }
  else if (frist != null && bisher.dueMarker == null) { ereignis = "deferral"; deferrals += 1; }
  const eintrag = {
    fingerprint: fp, dueMarker: frist, deferrals, lastProgressAt, observedAt: nowIso,
    history: [...((bisher && bisher.history) || []).slice(-19), { at: nowIso, event: ereignis, dueMarker: frist }],
  };
  if (bisher && ereignis === "unchanged" && JSON.stringify({ ...bisher, history: null, observedAt: null }) === JSON.stringify({ ...eintrag, history: null, observedAt: null })) {
    return { ok: true, data: klon(requireCore(input)), event: ereignis, progress: bisher, changed: false };
  }
  data.automation.progressById[key] = eintrag;
  bump(data, ctx.now);
  return { ok: true, data, event: ereignis, progress: eintrag, changed: true };
}

/* ── Warten mit Evidenz ─────────────────────────────────────────────────
 * Warten ist nur echt, wenn es eine Gegenpartei gibt, die NICHT man selbst
 * ist, einen naechsten Schritt, ein plausibles followUpAt und eine
 * ueberpruefbare Evidenz (Mail-Id, Frage-Id, Job-Id, Kalendereintrag …).
 * "Ich mache das spaeter" hat keine Gegenpartei und ist deshalb kein
 * waiting_external. */
const SELBST = new Set(["self", "me", "ich", "assistant", "chatgpt", "openai", "quantus", "agent", "ki"]);
export const EVIDENZ_ARTEN = Object.freeze(["mail", "question", "job", "calendar", "document", "ticket", "message", "url"]);

export function pruefeWarteEvidenz({ state, counterparty, nextAction, followUpAt, evidence }, { now, policy, rollen }) {
  const maengel = [];
  if (!WARTE_ZUSTAENDE.includes(state)) maengel.push("WAIT_STATE");
  const cp = String(counterparty || "").trim();
  if (!cp) maengel.push("WAIT_COUNTERPARTY_MISSING");
  else {
    const cpl = cp.toLowerCase();
    if (SELBST.has(cpl) || cpl === String(rollen?.executor || "").toLowerCase() || cpl === String(rollen?.accountable || "").toLowerCase()) maengel.push("WAIT_COUNTERPARTY_SELF");
    if (state === "waiting_user" && cpl !== "user" && cpl !== "laurin") maengel.push("WAIT_COUNTERPARTY_NOT_USER");
    if (state === "waiting_external" && (cpl === "user" || cpl === "laurin")) maengel.push("WAIT_EXTERNAL_IS_USER");
    if (state === "delegated" && !EXECUTORS.includes(cpl)) maengel.push("WAIT_DELEGATED_NOT_EXECUTOR");
  }
  if (!String(nextAction || "").trim()) maengel.push("WAIT_NEXT_ACTION_MISSING");
  const fu = msAus(followUpAt);
  if (!Number.isFinite(fu)) maengel.push("WAIT_FOLLOWUP_MISSING");
  else if (fu <= now) maengel.push("WAIT_FOLLOWUP_PAST");
  else if (policy && fu > now + policy.maxWaitDays * ZEIT.TAG) maengel.push("WAIT_FOLLOWUP_IMPLAUSIBLE");
  if (!evidence || typeof evidence !== "object" || !EVIDENZ_ARTEN.includes(evidence.kind) || !String(evidence.ref || "").trim()) maengel.push("WAIT_EVIDENCE_MISSING");
  return maengel;
}

export function setWaiting(input, payload, ctx) {
  ctxPruefen(ctx);
  const p = validatePolicy(ctx.policy);
  if (!p.ok) return fehler("POLICY_INVALID", p.errors);
  const data = klon(requireCore(input));
  const { sourceType, sourceId, state } = payload;
  if (!QUELLEN[sourceType]) return fehler("SOURCE_TYPE_NOT_STATEFUL", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const z = effektiverZustand(sourceType, e);
  if (z.unmapped) return fehler("UNKNOWN_LEGACY_STATE", z.legacy.legacyValue);
  if (ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) return fehler("SOURCE_CLOSED", z.state);
  const rollen = rollenFuer(sourceType, e);
  const maengel = pruefeWarteEvidenz(payload, { now: ctx.now, policy: ctx.policy, rollen });
  if (maengel.length) return fehler("WAITING_INCOMPLETE", maengel);
  const key = sourceKey(sourceType, sourceId);
  const bisher = data.automation.waitingById[key] || null;
  const eintrag = {
    state, counterparty: String(payload.counterparty).trim(),
    waitingSince: bisher && bisher.state === state ? bisher.waitingSince : isoAus(ctx.now),
    nextAction: String(payload.nextAction).trim(),
    followUpAt: isoAus(msAus(payload.followUpAt)),
    evidence: { kind: payload.evidence.kind, ref: String(payload.evidence.ref).trim() },
    setAt: isoAus(ctx.now),
  };
  data.automation.waitingById[key] = eintrag;
  e.operationalState = state;
  e.operationalStateSource = { legacyField: z.legacy.legacyField, legacyValue: z.legacy.legacyValue, mappedAt: isoAus(ctx.now), note: "setWaiting" };
  e.updatedAt = isoAus(ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, waiting: eintrag };
}

/* Zustandswechsel ausserhalb des Wartens. "done" verlangt, dass der
 * Altstatus (die Wahrheit der Oberflaeche) den Abschluss bestaetigt — der
 * Kern fuehrt keine zweite Statusdatenbank und laesst sich nichts
 * behaupten. Wartezustaende gehen NUR ueber setWaiting. */
export function transitionState(input, { sourceType, sourceId, state, reason, linkTo }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  if (!OPERATIONAL_STATES.includes(state)) return fehler("STATE_UNKNOWN", state);
  if (WARTE_ZUSTAENDE.includes(state)) return fehler("USE_SET_WAITING", state);
  const nowIso = isoAus(ctx.now);

  if (sourceType === "intake" || sourceType === "document") {
    const karte = sourceType === "intake" ? data.automation.intakeById : data.automation.documentsById;
    const e = karte[sourceId];
    if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
    if (state !== "done" && state !== "cancelled" && state !== "doing") return fehler("STATE_NOT_ALLOWED", state);
    if (sourceType === "document" && state === "done" && e.parse?.outcome !== "parsed") return fehler("DOCUMENT_NOT_PARSED", e.parse?.outcome || null);
    if (state === "done" && sourceType === "intake" && !(linkTo && linkTo.sourceType && linkTo.sourceId) && !reason) return fehler("INTAKE_DONE_NEEDS_LINK_OR_REASON");
    if (linkTo) {
      if (!quelleFinden(data, linkTo.sourceType, linkTo.sourceId)) return fehler("LINK_TARGET_NOT_FOUND", linkTo);
      e.linkedTo = { sourceType: linkTo.sourceType, sourceId: linkTo.sourceId };
    }
    e.status = state === "done" ? "done" : state === "cancelled" ? "cancelled" : "open";
    e.handledAt = state === "done" ? nowIso : null;
    e.reason = reason ? String(reason).slice(0, 500) : e.reason || null;
    bump(data, ctx.now);
    return { ok: true, data, entry: e };
  }

  if (!QUELLEN[sourceType]) return fehler("SOURCE_TYPE_NOT_STATEFUL", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const z = effektiverZustand(sourceType, e);
  if (z.unmapped) return fehler("UNKNOWN_LEGACY_STATE", z.legacy.legacyValue);
  const key = sourceKey(sourceType, sourceId);

  if (ABGESCHLOSSENE_ZUSTAENDE.includes(state)) {
    const legacyAbgeschlossen = ABGESCHLOSSENE_ZUSTAENDE.includes(z.legacy.operationalState);
    if (!legacyAbgeschlossen) return fehler("DONE_REQUIRES_LEGACY_CLOSE", { legacy: z.legacy.legacyValue });
    const offeneFrage = Object.values(data.automation.questionsById).find((q) => q.sourceType === sourceType && q.sourceId === sourceId && q.status === "open");
    if (offeneFrage) return fehler("QUESTION_OPEN", offeneFrage.id);
    // Eine zurueckgegebene Rueckgabe gilt mit dem Abschluss als gesichtet —
    // der Abschluss selbst ist ja nur mit bestaetigtem Altstatus moeglich.
  }
  e.operationalState = state;
  e.operationalStateSource = { legacyField: z.legacy.legacyField, legacyValue: z.legacy.legacyValue, mappedAt: nowIso, note: reason ? String(reason).slice(0, 200) : "transitionState" };
  e.updatedAt = nowIso;
  if (state === "doing" || state === "review" || ABGESCHLOSSENE_ZUSTAENDE.includes(state)) delete data.automation.waitingById[key];
  if (ABGESCHLOSSENE_ZUSTAENDE.includes(state)) {
    for (const j of Object.values(data.automation.jobsById)) if (j.sourceType === sourceType && j.sourceId === sourceId && j.state === "returned") j.reviewedAt = j.reviewedAt || nowIso;
  }
  bump(data, ctx.now);
  return { ok: true, data, state };
}

/* ── Eingang ────────────────────────────────────────────────────────────── */
export function registerIntake(input, { intakeId, text, channel, receivedAt, sourceType, sourceId }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(intakeId, "intakeId");
  if (!String(text || "").trim()) return fehler("INTAKE_TEXT_MISSING");
  const vorhanden = data.automation.intakeById[intakeId];
  if (vorhanden) {
    if (vorhanden.text === String(text).trim()) return { ok: true, data, entry: vorhanden, created: false };
    return fehler("INTAKE_IMMUTABLE", intakeId);
  }
  const eintrag = {
    id: intakeId, text: String(text).trim(), channel: String(channel || "unknown"),
    receivedAt: Number.isFinite(msAus(receivedAt)) ? isoAus(msAus(receivedAt)) : isoAus(ctx.now),
    registeredAt: isoAus(ctx.now), status: "open", linkedTo: null, handledAt: null,
    origin: sourceType && sourceId ? { sourceType, sourceId } : null,
  };
  data.automation.intakeById[intakeId] = eintrag;
  bump(data, ctx.now);
  return { ok: true, data, entry: eintrag, created: true };
}

/* ── Fragen und Antworten ───────────────────────────────────────────────
 * Eine Frage ist ein Eintrag mit Quelle; eine Antwort ist UNVERAENDERLICH
 * und GENAU EINMAL konsumierbar. Eine unbeantwortete Frage ist nie eine
 * Freigabe: transitionState → done lehnt ab, solange sie offen ist. */
export function askQuestion(input, { questionId, sourceType, sourceId, text, date }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(questionId, "questionId");
  if (!quelleFinden(data, sourceType, sourceId)) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const t = String(text || "").trim();
  if (!t) return fehler("QUESTION_TEXT_MISSING");
  const vorhanden = data.automation.questionsById[questionId];
  if (vorhanden) {
    if (vorhanden.text === t) return { ok: true, data, question: vorhanden, created: false };
    return fehler("QUESTION_IMMUTABLE", questionId);
  }
  const q = { id: questionId, sourceType, sourceId, text: t, askedAt: isoAus(ctx.now), status: "open", answerId: null, runDate: date && istLokalDatum(date) ? date : null };
  data.automation.questionsById[questionId] = q;
  bump(data, ctx.now);
  return { ok: true, data, question: q, created: true };
}

export function recordAnswer(input, { answerId, questionId, text }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(answerId, "answerId");
  const q = data.automation.questionsById[questionId];
  if (!q) return fehler("QUESTION_NOT_FOUND", questionId);
  const t = String(text == null ? "" : text);
  if (!t.trim()) return fehler("ANSWER_TEXT_MISSING");
  const vorhanden = data.automation.answersById[answerId];
  if (vorhanden) {
    if (vorhanden.questionId === questionId && vorhanden.text === t) return { ok: true, data, answer: vorhanden, created: false };
    return fehler("ANSWER_IMMUTABLE", answerId);
  }
  if (q.answerId && q.answerId !== answerId) return fehler("QUESTION_ALREADY_ANSWERED", q.answerId);
  const a = { id: answerId, questionId, text: t, answeredAt: isoAus(ctx.now), consumedAt: null, consumedBy: null };
  data.automation.answersById[answerId] = a;
  q.status = "answered";
  q.answerId = answerId;
  q.answeredAt = a.answeredAt;
  bump(data, ctx.now);
  return { ok: true, data, answer: a, created: true };
}

export function consumeAnswer(input, { answerId, consumer }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const a = data.automation.answersById[answerId];
  if (!a) return fehler("ANSWER_NOT_FOUND", answerId);
  if (a.consumedAt) return fehler("ANSWER_ALREADY_CONSUMED", { consumedAt: a.consumedAt, consumedBy: a.consumedBy });
  if (!String(consumer || "").trim()) return fehler("CONSUMER_MISSING");
  a.consumedAt = isoAus(ctx.now);
  a.consumedBy = String(consumer).trim();
  bump(data, ctx.now);
  return { ok: true, data, answer: a };
}

/* ── Dokumente ──────────────────────────────────────────────────────────
 * Ein Dokument ist offen, bis es GELESEN (parsed) und dann BEHANDELT
 * (transitionState → done) wurde. Unlesbar heisst: bleibt offen, mit
 * sichtbarem Befund — nie "verarbeitet". */
export const PARSE_OUTCOMES = Object.freeze(["parsed", "unreadable", "failed"]);

export function registerDocument(input, { documentId, name, storageRef, mime, size, sourceType, sourceId }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(documentId, "documentId");
  if (!String(name || "").trim() || !String(storageRef || "").trim()) return fehler("DOCUMENT_FIELDS_MISSING");
  const vorhanden = data.automation.documentsById[documentId];
  if (vorhanden) return { ok: true, data, document: vorhanden, created: false };
  const d = {
    id: documentId, name: String(name).trim(), storageRef: String(storageRef).trim(),
    mime: mime ? String(mime) : null, size: Number.isFinite(size) ? size : null,
    uploadedAt: isoAus(ctx.now), status: "open", handledAt: null,
    parse: { outcome: "pending", checkedAt: null, error: null, textRef: null, attempts: 0 },
    linkedTo: sourceType && sourceId ? { sourceType, sourceId } : null,
  };
  data.automation.documentsById[documentId] = d;
  bump(data, ctx.now);
  return { ok: true, data, document: d, created: true };
}

export function recordDocumentParse(input, { documentId, outcome, error, textRef }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const d = data.automation.documentsById[documentId];
  if (!d) return fehler("DOCUMENT_NOT_FOUND", documentId);
  if (!PARSE_OUTCOMES.includes(outcome)) return fehler("PARSE_OUTCOME_UNKNOWN", outcome);
  if (outcome === "parsed" && !String(textRef || "").trim()) return fehler("PARSE_TEXTREF_MISSING");
  d.parse = {
    outcome, checkedAt: isoAus(ctx.now),
    error: outcome === "parsed" ? null : String(error || outcome).slice(0, 500),
    textRef: outcome === "parsed" ? String(textRef).trim() : null,
    attempts: (Number(d.parse?.attempts) || 0) + 1,
  };
  // Ein Parse-Ergebnis aendert den Status NICHT auf "verarbeitet": das
  // Dokument bleibt offen, bis jemand es ausdruecklich behandelt.
  d.status = "open";
  d.handledAt = null;
  bump(data, ctx.now);
  return { ok: true, data, document: d };
}

/* ── Jobs (Spezialisten, Laeufer) ───────────────────────────────────────
 * Eine Rueckgabe setzt das Quellelement auf REVIEW — nie auf done. */
export const JOB_STATES = Object.freeze(["queued", "running", "returned", "failed", "cancelled"]);

export function createJob(input, { jobId, kind, sourceType, sourceId, executor }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(jobId, "jobId");
  if (!EXECUTORS.includes(executor)) return fehler("EXECUTOR_UNKNOWN", executor);
  if (!quelleFinden(data, sourceType, sourceId)) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const vorhanden = data.automation.jobsById[jobId];
  if (vorhanden) return { ok: true, data, job: vorhanden, created: false };
  const j = { id: jobId, kind: String(kind || "specialist"), sourceType, sourceId, executor, state: "queued", createdAt: isoAus(ctx.now), returnedAt: null, reviewedAt: null, resultRef: null, error: null, mode: ctx.policy?.featureFlags?.runner || "dry_run" };
  data.automation.jobsById[jobId] = j;
  bump(data, ctx.now);
  return { ok: true, data, job: j, created: true };
}

export function recordJobReturn(input, { jobId, outcome, resultRef, error }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const j = data.automation.jobsById[jobId];
  if (!j) return fehler("JOB_NOT_FOUND", jobId);
  if (outcome !== "returned" && outcome !== "failed") return fehler("JOB_OUTCOME_UNKNOWN", outcome);
  if (j.state === "returned" || j.state === "failed") {
    if (j.state === outcome) return { ok: true, data, job: j, created: false };
    return fehler("JOB_ALREADY_FINISHED", j.state);
  }
  const nowIso = isoAus(ctx.now);
  j.state = outcome;
  j.returnedAt = nowIso;
  j.resultRef = outcome === "returned" ? String(resultRef || "").trim() || null : null;
  j.error = outcome === "failed" ? String(error || "failed").slice(0, 500) : null;
  if (outcome === "returned" && QUELLEN[j.sourceType]) {
    const e = quelleFinden(data, j.sourceType, j.sourceId);
    if (e) {
      const z = effektiverZustand(j.sourceType, e);
      if (!z.unmapped && !ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) {
        e.operationalState = "review";
        e.operationalStateSource = { legacyField: z.legacy.legacyField, legacyValue: z.legacy.legacyValue, mappedAt: nowIso, note: "job " + jobId + " returned" };
        e.updatedAt = nowIso;
        delete data.automation.waitingById[sourceKey(j.sourceType, j.sourceId)];
      }
    }
  }
  bump(data, ctx.now);
  return { ok: true, data, job: j, created: true };
}

/* ── Lease ─────────────────────────────────────────────────────────────── */
export function acquireLease(input, { holder, ttlMs }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const h = String(holder || "").trim();
  if (!h) return fehler("LEASE_HOLDER_MISSING");
  if (!(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 6 * ZEIT.STUNDE)) return fehler("LEASE_TTL_INVALID", ttlMs);
  const l = data.automation.activeLease;
  if (l && l.holder !== h && msAus(l.expiresAt) > ctx.now) return fehler("LEASE_HELD", { holder: l.holder, expiresAt: l.expiresAt });
  data.automation.activeLease = { holder: h, acquiredAt: l && l.holder === h ? l.acquiredAt : isoAus(ctx.now), renewedAt: isoAus(ctx.now), expiresAt: isoAus(ctx.now + ttlMs), revision: data.automation.dataRevision + 1 };
  bump(data, ctx.now);
  return { ok: true, data, lease: data.automation.activeLease };
}

export function releaseLease(input, { holder }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const l = data.automation.activeLease;
  if (!l) return { ok: true, data, released: false };
  if (l.holder !== String(holder || "").trim()) return fehler("LEASE_NOT_HOLDER", l.holder);
  data.automation.activeLease = null;
  bump(data, ctx.now);
  return { ok: true, data, released: true };
}
