/* ══ Tagesbriefing v3 — Buchhaltung: die reinen Mutationen ══════════════════
 *
 * Jede Funktion hat dieselbe Form:
 *
 *     f(data, payload, ctx) → { ok: true, data, ... } | { ok: false, error, detail? }
 *
 * "data" ist der geparste Vollbestand; das Ergebnis ist eine TIEFE KOPIE mit
 * der Aenderung, die Eingabe bleibt unberuehrt. ctx traegt now (ms), policy
 * und actor. Keine Uhr, kein Zufall, keine Kennungserzeugung, keine
 * Nebenwirkung: IDs und Zeit kommen herein, damit der CAS-Umschlag die
 * Mutation bei einem Konflikt wortgleich wiederholen kann.
 *
 * Jede erfolgreiche, veraendernde Mutation zaehlt automation.dataRevision
 * GENAU EINMAL hoch (auch carryOverRefs ueber mehrere Elemente). Der
 * Idempotenz-Ledger (idempotencyByKey) und die Lease (activeLease) gehoeren
 * nicht dem Kern: er liest und schreibt beides nie.
 * ═════════════════════════════════════════════════════════════════════════ */
import {
  OPERATIONAL_STATES, WARTE_ZUSTAENDE, ABGESCHLOSSENE_ZUSTAENDE, EXECUTORS, TRANSITIONS,
  QUELLEN, effektiverZustand, rollenFuer, leererRun, pruefeId, sourceKey, validatePolicy,
  KARTEN_ZUSTAENDE,
} from "./assistant-schema.mjs";
import { klon, requireCore } from "./assistant-migration.mjs";
import { classifyBlobKey } from "./blob-key-policy.mjs";
import {
  istLokalDatum, isoAus, msAus, slotBeginnMs, slotKey, slotDefinition, ZEIT,
} from "./assistant-zeit.mjs";

const fehler = (error, detail) => ({ ok: false, error, detail: detail == null ? null : detail });

function istKarte(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function ctxPruefen(ctx) {
  if (!ctx || typeof ctx.now !== "number" || !Number.isFinite(ctx.now)) throw new TypeError("ctx.now (ms) fehlt");
  return ctx;
}

/* Genau eine Revision je aeusserer Aktion. */
export function bump(data, now) {
  data.automation.dataRevision = data.automation.dataRevision + 1;
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

/* Entitaet einer Quelle im Bestand finden. */
export function quelleFinden(data, sourceType, sourceId) {
  const q = QUELLEN[sourceType];
  if (q) {
    const store = data.entities[q.store];
    return istKarte(store) && istKarte(store[sourceId]) ? store[sourceId] : null;
  }
  if (sourceType === "project") return istKarte(data.entities.projects) && istKarte(data.entities.projects[sourceId]) ? data.entities.projects[sourceId] : null;
  const karte = {
    intake: data.automation.intakeById, question: data.automation.questionsById,
    document: data.automation.documentsById, job: data.automation.jobsById, evidence: data.automation.evidenceById,
  }[sourceType];
  return istKarte(karte) && istKarte(karte[sourceId]) ? karte[sourceId] : null;
}

/* Den fuehrenden Zustand setzen: Version hoch, Herkunft fortschreiben,
 * Konfliktmarke loeschen. Der Altstatus bleibt unangetastet. */
function setzeZustand(e, sourceType, state, now, note) {
  const z = effektiverZustand(sourceType, e);
  e.operationalState = state;
  e.operationalStateVersion = (z.version || 0) + 1;
  e.operationalStateSource = { ...(e.operationalStateSource || {}), changedAt: isoAus(now), note: note ? String(note).slice(0, 200) : null };
  delete e.operationalStateUnmapped;
  e.updatedAt = isoAus(now);
  return e.operationalStateVersion;
}

/* ── Serververifizierte Fortschrittsereignisse ─────────────────────────
 * Nur diese zaehlen als Fortschritt: registrierte Belege, angenommene
 * Job-Ergebnisse, konsumierte Nutzerantworten, behandelte Dokumente — alle
 * mit unveraenderlicher Kennung. Freitext, Kommentare, Umbenennen,
 * Zuweisung, Wechsel der Gegenpartei, Retry oder Statusrundreisen sind
 * KEIN Fortschritt. */
export function verifizierteEreignisse(data, sourceType, sourceId) {
  const a = data.automation;
  const passt = (o) => o && o.sourceType === sourceType && o.sourceId === sourceId;
  const ids = [];
  for (const [id, ev] of Object.entries(a.evidenceById)) if (passt(ev)) ids.push("evidence:" + id);
  for (const [id, j] of Object.entries(a.jobsById)) if (passt(j) && j.state === "returned" && j.review && j.review.verdict === "accepted") ids.push("job:" + id);
  for (const [id, ans] of Object.entries(a.answersById)) {
    const q = a.questionsById[ans.questionId];
    if (ans.consumedAt && passt(q)) ids.push("answer:" + id);
  }
  for (const [id, d] of Object.entries(a.documentsById)) if (d.status === "done" && passt(d.linkedTo)) ids.push("document:" + id);
  return ids.sort();
}

export function fristMarker(sourceType, e, waiting) {
  if (waiting && waiting.followUpAt) return msAus(waiting.followUpAt);
  if (sourceType === "task" && e.dueDate) return msAus(String(e.dueDate).slice(0, 10) + "T00:00:00Z");
  return null;
}

/* Fortschritts- und Verschiebungsbuchung fuer ein Element. Wird von
 * observeSource UND setWaiting benutzt, damit eine Verschiebung des
 * followUpAt atomar zaehlt. Gibt den neuen Eintrag und das Ereignis zurueck;
 * schreibt selbst nichts. */
export function fortschrittBuchen(data, sourceType, sourceId, e, waiting, now) {
  const key = sourceKey(sourceType, sourceId);
  const events = verifizierteEreignisse(data, sourceType, sourceId);
  const frist = fristMarker(sourceType, e, waiting);
  const bisher = data.automation.progressById[key] || null;
  const nowIso = isoAus(now);
  const bekannt = new Set(bisher ? bisher.events || [] : []);
  const neueEreignisse = events.filter((x) => !bekannt.has(x));
  let deferrals = bisher ? Number(bisher.deferrals) || 0 : 0;
  let lastProgressAt = bisher ? bisher.lastProgressAt : null;
  let ereignis = "unchanged";
  if (!bisher) ereignis = "first";
  else if (neueEreignisse.length) { ereignis = "progress"; deferrals = 0; lastProgressAt = nowIso; }
  else if (frist != null && (bisher.dueMarker == null || frist > bisher.dueMarker)) { ereignis = "deferral"; deferrals += 1; }
  const eintrag = {
    events, dueMarker: frist, deferrals, lastProgressAt, observedAt: nowIso,
    history: [...((bisher && bisher.history) || []).slice(-19), { at: nowIso, event: ereignis, dueMarker: frist, newEvents: neueEreignisse }],
  };
  const gleich = bisher && ereignis === "unchanged"
    && JSON.stringify({ e: bisher.events, d: bisher.dueMarker, n: bisher.deferrals }) === JSON.stringify({ e: events, d: frist, n: deferrals });
  return { key, eintrag, ereignis, changed: !gleich };
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

/* Genau EINE Startnotiz pro Tag, als ChatGPT Note (entities.chatgptNotes —
 * das Gedaechtnis des Assistenten, Konzept 7.1), nie in NoteFlow. Ein
 * zweiter Aufruf — auch mit anderer noteId — legt nichts an. */
export function ensureStartNote(input, { date, noteId, title, content }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const run = runVon(data, date);
  if (!run) return fehler("RUN_MISSING", date);
  if (run.startNoteId) {
    return { ok: true, data, noteId: run.startNoteId, created: false, noteExists: !!data.entities.chatgptNotes[run.startNoteId] };
  }
  pruefeId(noteId, "noteId");
  if (data.entities.chatgptNotes[noteId]) return fehler("NOTE_ID_TAKEN", noteId);
  data.entities.chatgptNotes[noteId] = chatgptNoteBauen(noteId, {
    title: title || `Tagesbriefing ${date} — Start`,
    content: content || `Tagesbriefing ${date}: Lauf ${run.id} eroeffnet.`,
    kind: "assistantStart", date, runRevision: run.revision, now: ctx.now,
  });
  run.startNoteId = noteId;
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, noteId, created: true, noteExists: true };
}

/* Eine ChatGPT Note in genau der Form, die normalizeData() fuer
 * entities.chatgptNotes erwartet (category, instruction, derived,
 * instructionDate, promptSection, tags, state, supersedes/supersededBy,
 * linked*, comments, files, externalLinks, createdAt/updatedAt). Das
 * versionierte Feld assistantNote traegt die Kern-Metadaten; der Normalizer
 * setzt nur Defaults und laesst es unangetastet. Eine ChatGPT Note wird nie
 * inhaltlich veraendert; eine Korrektur ist ein NEUER Eintrag mit
 * supersedes, der alte bleibt byteidentisch. */
export const ASSISTANT_NOTE_SCHEMA = "assistant-note/3";
const NOTE_META = Object.freeze({
  assistantStart: Object.freeze({ category: "auftrag", tag: "start" }),
  assistantFinal: Object.freeze({ category: "entscheid", tag: "final" }),
  assistantCorrection: Object.freeze({ category: "entscheid", tag: "korrektur" }),
});

export function chatgptNoteBauen(id, { title, content, kind, date, runRevision, now, supersedes = null }) {
  const iso = isoAus(now);
  const meta = NOTE_META[kind];
  if (!meta) throw new RangeError("unbekannte Notizart " + kind);
  return {
    id,
    category: meta.category,
    instruction: String(content || ""),
    derived: String(title),
    instructionDate: date,
    promptSection: "tagesbriefing",
    tags: ["tagesbriefing", meta.tag, date],
    state: "aktiv",
    supersedes, supersededBy: null,
    assistantNote: { schema: ASSISTANT_NOTE_SCHEMA, kind, runDate: date, runRevision: Number.isInteger(runRevision) ? runRevision : null },
    linkedTasks: [], linkedProjects: [], linkedNotes: [], linkedOrganizations: [],
    comments: [], files: [], externalLinks: [],
    createdAt: iso, updatedAt: iso,
  };
}

/* Slot-Quittung. Nur fuer einen Slot, der begonnen hat; dieselbe Quittung
 * zweimal ist ein No-op, eine ANDERE fuer denselben Slot ein Fehler. */
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
  const eintrag = { cursor, checkedAt: isoAus(ctx.now), outcome, detail: detail ? String(detail).slice(0, 500) : null, checkedBy: ctx.actor ? ctx.actor.id : null };
  run.sourceChecks[sourceId] = eintrag;
  data.automation.sourceCursors[sourceId] = { cursor, checkedAt: eintrag.checkedAt, outcome };
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, check: eintrag };
}

/* Verweis auf ein Element — NUR Typ, Id, Zeitpunkt, Herkunft. Keine Status-,
 * Evidenz- oder nextAction-Felder. Die Ampel und der Abschluss pruefen
 * ohnehin den ganzen Bestand; itemRefs sind Arbeitsliste, nicht Nachweis. */
function refHinzufuegen(run, { sourceType, sourceId, carriedFrom }, now) {
  if (run.itemRefs.some((r) => r.sourceType === sourceType && r.sourceId === sourceId)) return null;
  const ref = { sourceType, sourceId, includedAt: isoAus(now) };
  if (carriedFrom) ref.carriedFrom = carriedFrom;
  run.itemRefs.push(ref);
  return ref;
}

export function addItemRef(input, { date, sourceType, sourceId, carriedFrom }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const run = runVon(data, date);
  if (!run) return fehler("RUN_MISSING", date);
  let key;
  try { key = sourceKey(sourceType, sourceId); } catch (e) { return fehler("SOURCE_REF_INVALID", e.message); }
  if (!quelleFinden(data, sourceType, sourceId)) return fehler("SOURCE_NOT_FOUND", key);
  if (carriedFrom && !istLokalDatum(carriedFrom)) return fehler("DATE_INVALID", carriedFrom);
  const ref = refHinzufuegen(run, { sourceType, sourceId, carriedFrom }, ctx.now);
  if (!ref) return { ok: true, data, created: false };
  runAnfassen(run, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, created: true, ref };
}

/* Carry-over: offene Elemente des Vortages als VERWEISE in den neuen Lauf.
 * Keine neue Aufgabe, kein neuer Lead, eine Revision fuer alles. */
export function carryOverRefs(input, { fromDate, toDate }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const von = runVon(data, fromDate);
  const nach = runVon(data, toDate);
  if (!von) return fehler("RUN_MISSING", fromDate);
  if (!nach) return fehler("RUN_MISSING", toDate);
  const uebernommen = [];
  for (const ref of von.itemRefs) {
    const e = quelleFinden(data, ref.sourceType, ref.sourceId);
    if (!e) continue;
    if (QUELLEN[ref.sourceType]) {
      const z = effektiverZustand(ref.sourceType, e);
      if (!z.unmigrated && !z.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) continue;
    } else if (e.status === "done" || e.status === "cancelled" || e.consumedAt || ["cancelled", "expired"].includes(e.state)) continue;
    const r = refHinzufuegen(nach, { sourceType: ref.sourceType, sourceId: ref.sourceId, carriedFrom: ref.carriedFrom || fromDate }, ctx.now);
    if (r) uebernommen.push(r);
  }
  if (!uebernommen.length) return { ok: true, data, carried: [] };
  runAnfassen(nach, ctx.now);
  bump(data, ctx.now);
  return { ok: true, data, carried: uebernommen };
}

/* ── Beobachten: Fortschritt und Verschiebungen ────────────────────────── */
export function observeSource(input, { sourceType, sourceId }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  if (!QUELLEN[sourceType]) return fehler("SOURCE_TYPE_NOT_OBSERVABLE", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const key = sourceKey(sourceType, sourceId);
  const b = fortschrittBuchen(data, sourceType, sourceId, e, data.automation.waitingById[key] || null, ctx.now);
  if (!b.changed) return { ok: true, data, event: b.ereignis, progress: data.automation.progressById[key], changed: false };
  data.automation.progressById[key] = b.eintrag;
  bump(data, ctx.now);
  return { ok: true, data, event: b.ereignis, progress: b.eintrag, changed: true };
}

/* ── Belege (nur Adapter) ───────────────────────────────────────────────
 * Ein Beleg ist ein vom Backend-Adapter bestaetigter Verweis auf etwas
 * Aeusseres (Mail, Kalender, Ticket, Nachricht, URL, Dokument) — mit
 * Herkunft, Beobachtungszeit und Fingerabdruck. Er gehoert zu GENAU EINEM
 * Element. Agenten koennen keinen Beleg erfinden: der Dispatcher laesst
 * registerEvidence nur fuer actor.kind "adapter" zu. */
export const EVIDENZ_ARTEN = Object.freeze(["mail", "calendar", "ticket", "message", "url", "document"]);

export function registerEvidence(input, { evidenceId, kind, ref, sourceType, sourceId, origin, observedAt, fingerprint, summary }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(evidenceId, "evidenceId");
  if (!EVIDENZ_ARTEN.includes(kind)) return fehler("EVIDENCE_KIND_UNKNOWN", kind);
  if (!String(ref || "").trim()) return fehler("EVIDENCE_REF_MISSING");
  if (!QUELLEN[sourceType]) return fehler("EVIDENCE_SOURCE_TYPE", sourceType);
  if (!quelleFinden(data, sourceType, sourceId)) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  if (!istKarte(origin) || !String(origin.adapter || "").trim() || !String(origin.ref || "").trim()) return fehler("EVIDENCE_ORIGIN_MISSING");
  const beobachtet = msAus(observedAt);
  if (!Number.isFinite(beobachtet) || beobachtet > ctx.now) return fehler("EVIDENCE_OBSERVED_AT_INVALID", observedAt);
  if (typeof fingerprint !== "string" || !/^[A-Za-z0-9+/=_-]{16,128}$/.test(fingerprint)) return fehler("EVIDENCE_FINGERPRINT_INVALID");
  if (kind === "document" && !data.automation.documentsById[String(ref)]) return fehler("EVIDENCE_DOCUMENT_UNKNOWN", ref);
  const eintrag = {
    id: evidenceId, kind, ref: String(ref).trim(), sourceType, sourceId,
    origin: { adapter: String(origin.adapter).trim(), ref: String(origin.ref).trim() },
    observedAt: isoAus(beobachtet), fingerprint, summary: summary ? String(summary).slice(0, 300) : null,
    registeredAt: isoAus(ctx.now), verifiedBy: ctx.actor ? ctx.actor.id : null,
  };
  const vorhanden = data.automation.evidenceById[evidenceId];
  if (vorhanden) {
    const gleich = ["kind", "ref", "sourceType", "sourceId", "fingerprint"].every((k) => vorhanden[k] === eintrag[k]);
    if (gleich) return { ok: true, data, evidence: vorhanden, created: false };
    return fehler("EVIDENCE_IMMUTABLE", evidenceId);
  }
  data.automation.evidenceById[evidenceId] = eintrag;
  bump(data, ctx.now);
  return { ok: true, data, evidence: eintrag, created: true };
}

/* ── Warten mit Beleg ───────────────────────────────────────────────────
 * Warten ist nur echt mit: Gegenpartei, die nicht man selbst ist; einem
 * naechsten Schritt; einem plausiblen followUpAt; einem Beleg, der im
 * Bestand existiert UND zu genau diesem Element gehoert:
 *   { kind: "evidence", evidenceId }  registrierter Beleg (Adapter)
 *   { kind: "question", questionId }  eigene offene Frage an den Nutzer
 *   { kind: "job", jobId }            eigener laufender Job (delegated)
 * "Ich mache das spaeter" hat keine Gegenpartei und ist kein Warten. */
const SELBST = new Set(["self", "me", "ich", "assistant", "chatgpt", "openai", "quantus", "agent", "ki"]);

export function belegAufloesen(data, sourceType, sourceId, evidence) {
  if (!istKarte(evidence)) return { ok: false, code: "WAIT_EVIDENCE_MISSING" };
  const a = data.automation;
  if (evidence.kind === "evidence") {
    const ev = a.evidenceById[String(evidence.evidenceId || "")];
    if (!ev) return { ok: false, code: "WAIT_EVIDENCE_UNKNOWN" };
    if (ev.sourceType !== sourceType || ev.sourceId !== sourceId) return { ok: false, code: "WAIT_EVIDENCE_FOREIGN" };
    return { ok: true, ref: { kind: "evidence", evidenceId: ev.id, binding: ev.fingerprint }, kindDetail: ev.kind };
  }
  if (evidence.kind === "question") {
    const q = a.questionsById[String(evidence.questionId || "")];
    if (!q) return { ok: false, code: "WAIT_EVIDENCE_UNKNOWN" };
    if (q.sourceType !== sourceType || q.sourceId !== sourceId) return { ok: false, code: "WAIT_EVIDENCE_FOREIGN" };
    if (q.status !== "open") return { ok: false, code: "WAIT_QUESTION_NOT_OPEN" };
    return { ok: true, ref: { kind: "question", questionId: q.id, binding: "question:" + q.id + ":" + q.askedAt } };
  }
  if (evidence.kind === "job") {
    const j = a.jobsById[String(evidence.jobId || "")];
    if (!j) return { ok: false, code: "WAIT_EVIDENCE_UNKNOWN" };
    if (j.sourceType !== sourceType || j.sourceId !== sourceId) return { ok: false, code: "WAIT_EVIDENCE_FOREIGN" };
    if (!["queued", "running"].includes(j.state)) return { ok: false, code: "WAIT_JOB_NOT_ACTIVE" };
    return { ok: true, ref: { kind: "job", jobId: j.id, binding: "job:" + j.id + ":" + j.executor + ":" + j.inputVersion + ":" + j.createdAt }, executor: j.executor };
  }
  return { ok: false, code: "WAIT_EVIDENCE_KIND_UNKNOWN" };
}

/* Prueft eine Wartekarte vollstaendig — beim Setzen UND in der Ampel
 * (dieselbe Funktion, damit eine manipulierte Karte nicht anders bewertet
 * wird als eine frisch gesetzte). */
export function pruefeWarteKarte(data, sourceType, sourceId, karte, { now, policy, rollen, beimSetzen = false }) {
  const m = [];
  const w = istKarte(karte) ? karte : {};
  if (!WARTE_ZUSTAENDE.includes(w.state)) m.push("WAIT_STATE");
  const cp = String(w.counterparty || "").trim();
  const cpl = cp.toLowerCase();
  if (!cp) m.push("WAIT_COUNTERPARTY_MISSING");
  else {
    if (SELBST.has(cpl) || cpl === String(rollen?.executor || "").toLowerCase() || cpl === String(rollen?.accountable || "").toLowerCase()) m.push("WAIT_COUNTERPARTY_SELF");
    if (w.state === "waiting_user" && cpl !== "user") m.push("WAIT_COUNTERPARTY_NOT_USER");
    if (w.state === "waiting_external" && cpl === "user") m.push("WAIT_EXTERNAL_IS_USER");
    if (w.state === "delegated" && !EXECUTORS.includes(cpl)) m.push("WAIT_DELEGATED_NOT_EXECUTOR");
  }
  if (!String(w.nextAction || "").trim()) m.push("WAIT_NEXT_ACTION_MISSING");
  const since = beimSetzen ? now : msAus(w.waitingSince);
  if (!beimSetzen && (!Number.isFinite(since) || since > now)) m.push("WAIT_SINCE_INVALID");
  const fu = msAus(w.followUpAt);
  if (!Number.isFinite(fu)) m.push("WAIT_FOLLOWUP_MISSING");
  else {
    if (beimSetzen && fu <= now) m.push("WAIT_FOLLOWUP_PAST");
    if (Number.isFinite(since) && fu <= since) m.push("WAIT_FOLLOWUP_BEFORE_SINCE");
    if (policy && Number.isFinite(since) && fu > since + policy.maxWaitDays * ZEIT.TAG) m.push("WAIT_FOLLOWUP_IMPLAUSIBLE");
  }
  const beleg = belegAufloesen(data, sourceType, sourceId, w.evidence);
  if (!beleg.ok) m.push(beleg.code);
  else {
    // Bindung: die Karte traegt den Fingerabdruck des Belegs vom Zeitpunkt
    // des Setzens. Weicht der Beleg heute davon ab (anderer Inhalt, andere
    // Identitaet), ist die Karte nicht mehr belegt.
    if (!beimSetzen && (typeof w.evidence.binding !== "string" || w.evidence.binding !== beleg.ref.binding)) m.push("WAIT_EVIDENCE_CHANGED");
    if (w.state === "delegated" && beleg.ref.kind !== "job") m.push("WAIT_DELEGATED_NEEDS_JOB");
    if (w.state === "delegated" && beleg.ref.kind === "job" && cpl !== String(beleg.executor).toLowerCase()) m.push("WAIT_DELEGATED_COUNTERPARTY_MISMATCH");
    if (w.state === "waiting_user" && beleg.ref.kind !== "question") m.push("WAIT_USER_NEEDS_QUESTION");
    if (w.state === "waiting_external" && beleg.ref.kind !== "evidence") m.push("WAIT_EXTERNAL_NEEDS_EVIDENCE");
  }
  return { maengel: m, beleg: beleg.ok ? beleg.ref : null };
}

export function setWaiting(input, payload, ctx) {
  ctxPruefen(ctx);
  const p = validatePolicy(ctx.policy);
  if (!p.ok) return fehler("POLICY_INVALID", p.errors);
  const data = klon(requireCore(input));
  const { sourceType, sourceId, state, expectedVersion } = payload;
  if (!QUELLEN[sourceType]) return fehler("SOURCE_TYPE_NOT_STATEFUL", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const z = effektiverZustand(sourceType, e);
  if (z.unmigrated) return fehler("NOT_MIGRATED", sourceType + ":" + sourceId);
  if (z.version !== expectedVersion) return fehler("VERSION_MISMATCH", { expected: expectedVersion, current: z.version });
  if (!z.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) return fehler("SOURCE_CLOSED", z.state);
  if (!WARTE_ZUSTAENDE.includes(state)) return fehler("STATE_NOT_WAITING", state);
  const rollen = rollenFuer(sourceType, e);
  const pr = pruefeWarteKarte(data, sourceType, sourceId, payload, { now: ctx.now, policy: ctx.policy, rollen, beimSetzen: true });
  if (pr.maengel.length) return fehler("WAITING_INCOMPLETE", pr.maengel);
  const key = sourceKey(sourceType, sourceId);
  const bisher = data.automation.waitingById[key] || null;
  const karte = {
    state, counterparty: String(payload.counterparty).trim(),
    waitingSince: bisher && bisher.state === state ? bisher.waitingSince : isoAus(ctx.now),
    nextAction: String(payload.nextAction).trim(),
    followUpAt: isoAus(msAus(payload.followUpAt)),
    evidence: pr.beleg,
    setAt: isoAus(ctx.now), setBy: ctx.actor ? ctx.actor.id : null,
  };
  // Verschiebung ATOMAR zaehlen: das neue followUpAt ist die Frist.
  const b = fortschrittBuchen(data, sourceType, sourceId, e, karte, ctx.now);
  data.automation.progressById[key] = b.eintrag;
  data.automation.waitingById[key] = karte;
  const version = setzeZustand(e, sourceType, state, ctx.now, "setWaiting");
  if (karte.evidence.kind === "job") {
    // Die Delegation selbst aendert die Version des Elements — das macht das
    // spaetere Ergebnis nicht stale. Inhaltliche Aenderungen danach schon.
    const j = data.automation.jobsById[karte.evidence.jobId];
    j.acceptedVersions = [...new Set([...(j.acceptedVersions || [j.inputVersion]), version])];
  }
  bump(data, ctx.now);
  return { ok: true, data, waiting: karte, version, progressEvent: b.ereignis, deferrals: b.eintrag.deferrals };
}

/* ── Zustandswechsel ────────────────────────────────────────────────────
 * Erlaubte Uebergaenge nach TRANSITIONS, mit erwarteter Objektversion.
 * "done" verlangt einen passenden Beleg: einen serververifizierten Beleg,
 * ein angenommenes Job-Ergebnis oder eine konsumierte Nutzerantwort zu
 * GENAU diesem Element — plus (fuer KI-Leads) den vollstaendig
 * dokumentierten Ablauf. Ein bereits gesetzter Altstatus ist nie eine
 * Freigabe. "cancelled" eines Leads darf nur der Nutzer. */
const LEAD_PFLICHT = ["interpretation", "research", "plan", "execution", "result"];
const LEAD_RASTER = ["menge", "werkzeug", "kontext", "quantusNaehe", "recherche", "zuschnitt"];

export function leadUnvollstaendig(l) {
  const m = [];
  for (const f of LEAD_PFLICHT) if (!String(l[f] || "").trim()) m.push(f);
  const a = istKarte(l.assessment) ? l.assessment : {};
  if (!LEAD_RASTER.every((k) => a[k] === "chatgpt" || a[k] === "cowork")) m.push("assessment");
  if (l.assignee !== "chatgpt" && l.assignee !== "cowork") m.push("assignee");
  if (!String(l.assignmentReason || "").trim()) m.push("assignmentReason");
  const links = Object.keys(l).filter((k) => /^linked[A-Z]/.test(k) && Array.isArray(l[k]) && l[k].length).length
    + ((Array.isArray(l.externalLinks) ? l.externalLinks : []).filter((x) => x && (x.url || typeof x === "string")).length);
  if (!links) m.push("link");
  return m;
}

function abschlussBeleg(data, sourceType, sourceId, evidence) {
  if (!istKarte(evidence)) return { ok: false, code: "DONE_EVIDENCE_MISSING" };
  const a = data.automation;
  if (evidence.kind === "evidence") {
    const ev = a.evidenceById[String(evidence.evidenceId || "")];
    if (!ev || ev.sourceType !== sourceType || ev.sourceId !== sourceId) return { ok: false, code: "DONE_EVIDENCE_FOREIGN" };
    return { ok: true, ref: { kind: "evidence", evidenceId: ev.id } };
  }
  if (evidence.kind === "job") {
    const j = a.jobsById[String(evidence.jobId || "")];
    if (!j || j.sourceType !== sourceType || j.sourceId !== sourceId) return { ok: false, code: "DONE_EVIDENCE_FOREIGN" };
    if (j.state !== "returned" || !j.review || j.review.verdict !== "accepted") return { ok: false, code: "DONE_JOB_NOT_ACCEPTED" };
    return { ok: true, ref: { kind: "job", jobId: j.id } };
  }
  if (evidence.kind === "answer") {
    const ans = a.answersById[String(evidence.answerId || "")];
    const q = ans && a.questionsById[ans.questionId];
    if (!ans || !q || q.sourceType !== sourceType || q.sourceId !== sourceId) return { ok: false, code: "DONE_EVIDENCE_FOREIGN" };
    if (!ans.consumedAt) return { ok: false, code: "DONE_ANSWER_NOT_CONSUMED" };
    return { ok: true, ref: { kind: "answer", answerId: ans.id } };
  }
  return { ok: false, code: "DONE_EVIDENCE_KIND_UNKNOWN" };
}

export function transitionState(input, { sourceType, sourceId, state, expectedVersion, reason, evidence, linkTo, results }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  if (!OPERATIONAL_STATES.includes(state)) return fehler("STATE_UNKNOWN", state);
  if (WARTE_ZUSTAENDE.includes(state)) return fehler("USE_SET_WAITING", state);
  const nowIso = isoAus(ctx.now);

  if (sourceType === "intake" || sourceType === "document") {
    const karte = sourceType === "intake" ? data.automation.intakeById : data.automation.documentsById;
    const e = karte[sourceId];
    if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
    if (!["done", "cancelled", "doing"].includes(state)) return fehler("STATE_NOT_ALLOWED", state);
    if (state === "cancelled" && !String(reason || "").trim()) return fehler("REASON_MISSING");
    if (sourceType === "document" && state === "done") {
      if (e.parse?.outcome !== "parsed" || !e.parse.textRef || !e.parse.extractHash) return fehler("DOCUMENT_NOT_PARSED", e.parse?.outcome || null);
      if (!istKarte(e.linkedTo)) return fehler("DOCUMENT_NOT_LINKED");
      if (!Array.isArray(results) || !results.length) return fehler("DOCUMENT_RESULTS_MISSING");
      for (const r of results) {
        if (!istKarte(r) || !QUELLEN[r.sourceType] && !["evidence", "question"].includes(r.sourceType)) return fehler("DOCUMENT_RESULT_INVALID", r);
        if (!quelleFinden(data, r.sourceType, r.sourceId)) return fehler("DOCUMENT_RESULT_NOT_FOUND", r);
      }
      e.results = results.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId }));
    }
    if (state === "done" && sourceType === "intake" && !(istKarte(linkTo) && linkTo.sourceType && linkTo.sourceId) && !String(reason || "").trim()) return fehler("INTAKE_DONE_NEEDS_LINK_OR_REASON");
    if (linkTo) {
      if (!istKarte(linkTo) || !quelleFinden(data, linkTo.sourceType, linkTo.sourceId)) return fehler("LINK_TARGET_NOT_FOUND", linkTo);
      e.linkedTo = { sourceType: linkTo.sourceType, sourceId: linkTo.sourceId };
    }
    e.status = state === "done" ? "done" : state === "cancelled" ? "cancelled" : "open";
    e.handledAt = state === "done" ? nowIso : null;
    e.handledBy = state === "done" && ctx.actor ? ctx.actor.id : null;
    e.reason = reason ? String(reason).slice(0, 500) : e.reason || null;
    bump(data, ctx.now);
    return { ok: true, data, entry: e };
  }

  if (!QUELLEN[sourceType]) return fehler("SOURCE_TYPE_NOT_STATEFUL", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const z = effektiverZustand(sourceType, e);
  if (z.unmigrated) return fehler("NOT_MIGRATED", sourceType + ":" + sourceId);
  if (!Number.isInteger(expectedVersion)) return fehler("VERSION_REQUIRED");
  if (z.version !== expectedVersion) return fehler("VERSION_MISMATCH", { expected: expectedVersion, current: z.version });
  const key = sourceKey(sourceType, sourceId);

  // Aus einem Migrationskonflikt heraus: nur doing (Klaerung) oder cancelled mit Grund.
  if (z.unmapped) {
    if (state !== "doing" && state !== "cancelled") return fehler("UNMAPPED_NEEDS_CLARIFICATION", z.reason);
    if (!String(reason || "").trim()) return fehler("REASON_MISSING");
  } else if (!TRANSITIONS[z.state].includes(state)) {
    return fehler("TRANSITION_NOT_ALLOWED", { from: z.state, to: state });
  }
  if (ABGESCHLOSSENE_ZUSTAENDE.includes(z.state) && !String(reason || "").trim()) return fehler("REOPEN_NEEDS_REASON");

  let belegRef = null;
  if (state === "done") {
    const offeneFrage = Object.values(data.automation.questionsById).find((q) => q.sourceType === sourceType && q.sourceId === sourceId && q.status === "open");
    if (offeneFrage) return fehler("QUESTION_OPEN", offeneFrage.id);
    const unbewertet = Object.values(data.automation.jobsById).find((j) => j.sourceType === sourceType && j.sourceId === sourceId && j.state === "returned" && !j.review);
    if (unbewertet) return fehler("JOB_RETURN_UNREVIEWED", unbewertet.id);
    const laufend = Object.values(data.automation.jobsById).find((j) => j.sourceType === sourceType && j.sourceId === sourceId && ["queued", "running"].includes(j.state));
    if (laufend) return fehler("JOB_STILL_ACTIVE", laufend.id);
    if (sourceType === "chatgptLead") {
      const fehlt = leadUnvollstaendig(e);
      if (fehlt.length) return fehler("LEAD_INCOMPLETE", fehlt);
    }
    const rollen = rollenFuer(sourceType, e);
    const nutzerSelbst = rollen.accountable === "user" && ctx.actor && ctx.actor.kind === "user";
    if (!nutzerSelbst) {
      const b = abschlussBeleg(data, sourceType, sourceId, evidence);
      if (!b.ok) return fehler(b.code);
      belegRef = b.ref;
    } else belegRef = { kind: "user", actorId: ctx.actor.id };
  }
  if (state === "cancelled") {
    if (!String(reason || "").trim()) return fehler("REASON_MISSING");
    if (sourceType === "chatgptLead" && !(ctx.actor && ctx.actor.kind === "user")) return fehler("CANCEL_REQUIRES_USER");
  }
  const version = setzeZustand(e, sourceType, state, ctx.now, reason || "transitionState");
  e.operationalStateSource.closure = state === "done" ? belegRef : state === "cancelled" ? { kind: "cancel", actorId: ctx.actor ? ctx.actor.id : null, reason: String(reason).slice(0, 200) } : null;
  delete data.automation.waitingById[key];
  bump(data, ctx.now);
  return { ok: true, data, state, version };
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
    registeredAt: isoAus(ctx.now), registeredBy: ctx.actor ? ctx.actor.id : null,
    status: "open", linkedTo: null, handledAt: null,
    origin: sourceType && sourceId ? { sourceType, sourceId } : null,
  };
  data.automation.intakeById[intakeId] = eintrag;
  bump(data, ctx.now);
  return { ok: true, data, entry: eintrag, created: true };
}

/* ── Fragen und Antworten ───────────────────────────────────────────────
 * Eine Antwort ist UNVERAENDERLICH (nur der Nutzer schreibt sie, actor
 * "user") und GENAU EINMAL konsumierbar. Eine offene Frage ist nie eine
 * Freigabe. */
export function askQuestion(input, { questionId, sourceType, sourceId, text, date }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(questionId, "questionId");
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  if (QUELLEN[sourceType]) {
    const z = effektiverZustand(sourceType, e);
    if (!z.unmigrated && !z.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) return fehler("SOURCE_CLOSED", z.state);
  }
  const t = String(text || "").trim();
  if (!t) return fehler("QUESTION_TEXT_MISSING");
  const vorhanden = data.automation.questionsById[questionId];
  if (vorhanden) {
    if (vorhanden.text === t && vorhanden.sourceType === sourceType && vorhanden.sourceId === sourceId) return { ok: true, data, question: vorhanden, created: false };
    return fehler("QUESTION_IMMUTABLE", questionId);
  }
  const q = { id: questionId, sourceType, sourceId, text: t, askedAt: isoAus(ctx.now), askedBy: ctx.actor ? ctx.actor.id : null, status: "open", answerId: null, runDate: date && istLokalDatum(date) ? date : null };
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
  if (q.status !== "open") return fehler("QUESTION_NOT_OPEN", q.status);
  const a = { id: answerId, questionId, text: t, answeredAt: isoAus(ctx.now), answeredBy: ctx.actor ? ctx.actor.id : null, consumedAt: null, consumedBy: null };
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

/* ── Dokumente (nur Adapter) ────────────────────────────────────────────
 * Ein Dokument braucht eine bestaetigte Attachment-Kennung (die
 * Schluesselpolitik der Blob-Fassade entscheidet, was gueltig ist), Hash,
 * Typ, Groesse, Herkunft und die urspruengliche Verknuepfung. Es bleibt
 * offen, bis eine geprueft extrahierte Fassung UND konkrete verknuepfte
 * Verarbeitungsergebnisse vorliegen (transitionState → done mit results).
 * Unlesbar, fremd oder unbelegt heisst: bleibt offen. */
export const PARSE_OUTCOMES = Object.freeze(["parsed", "unreadable", "failed"]);
const HASH_HEX = /^[a-f0-9]{64}$/;

function attachmentSchluesselGueltig(key) {
  const c = classifyBlobKey(String(key || ""));
  return c.kind === "side" && c.family === "attachment-text__*";
}

export function registerDocument(input, { documentId, attachmentId, name, hash, mime, size, origin, linkedTo }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  pruefeId(documentId, "documentId");
  if (!attachmentSchluesselGueltig(attachmentId)) return fehler("DOCUMENT_ATTACHMENT_ID_INVALID", attachmentId);
  if (!String(name || "").trim()) return fehler("DOCUMENT_NAME_MISSING");
  if (typeof hash !== "string" || !HASH_HEX.test(hash)) return fehler("DOCUMENT_HASH_INVALID");
  if (!String(mime || "").trim() || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(mime))) return fehler("DOCUMENT_MIME_INVALID", mime);
  if (!(Number.isInteger(size) && size > 0)) return fehler("DOCUMENT_SIZE_INVALID", size);
  if (!istKarte(origin) || !String(origin.channel || "").trim() || !String(origin.ref || "").trim()) return fehler("DOCUMENT_ORIGIN_MISSING");
  if (!istKarte(linkedTo) || !quelleFinden(data, linkedTo.sourceType, linkedTo.sourceId)) return fehler("DOCUMENT_LINK_TARGET_NOT_FOUND", linkedTo);
  const vorhanden = data.automation.documentsById[documentId];
  if (vorhanden) {
    if (vorhanden.hash === hash && vorhanden.attachmentId === attachmentId) return { ok: true, data, document: vorhanden, created: false };
    return fehler("DOCUMENT_IMMUTABLE", documentId);
  }
  const d = {
    id: documentId, attachmentId, name: String(name).trim(), hash, mime: String(mime), size,
    origin: { channel: String(origin.channel).trim(), ref: String(origin.ref).trim() },
    linkedTo: { sourceType: linkedTo.sourceType, sourceId: linkedTo.sourceId },
    uploadedAt: isoAus(ctx.now), registeredBy: ctx.actor ? ctx.actor.id : null,
    status: "open", handledAt: null, handledBy: null, results: [],
    parse: { outcome: "pending", checkedAt: null, error: null, textRef: null, extractHash: null, attempts: 0 },
  };
  data.automation.documentsById[documentId] = d;
  bump(data, ctx.now);
  return { ok: true, data, document: d, created: true };
}

export function recordDocumentParse(input, { documentId, outcome, error, textRef, extractHash }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const d = data.automation.documentsById[documentId];
  if (!d) return fehler("DOCUMENT_NOT_FOUND", documentId);
  if (!PARSE_OUTCOMES.includes(outcome)) return fehler("PARSE_OUTCOME_UNKNOWN", outcome);
  if (d.status === "done") return fehler("DOCUMENT_ALREADY_HANDLED");
  if (outcome === "parsed") {
    if (!attachmentSchluesselGueltig(textRef)) return fehler("PARSE_TEXTREF_INVALID", textRef);
    if (typeof extractHash !== "string" || !HASH_HEX.test(extractHash)) return fehler("PARSE_EXTRACT_HASH_INVALID");
  }
  d.parse = {
    outcome, checkedAt: isoAus(ctx.now), checkedBy: ctx.actor ? ctx.actor.id : null,
    error: outcome === "parsed" ? null : String(error || outcome).slice(0, 500),
    textRef: outcome === "parsed" ? String(textRef) : null,
    extractHash: outcome === "parsed" ? extractHash : null,
    attempts: (Number(d.parse?.attempts) || 0) + 1,
  };
  d.status = "open";       // ein Parse-Ergebnis ist nie "verarbeitet"
  d.handledAt = null;
  bump(data, ctx.now);
  return { ok: true, data, document: d };
}

/* ── Jobs (Spezialisten, Laeufer) ───────────────────────────────────────
 * Ein Job traegt Eingangsversion, erlaubte Kontextverweise, Zweck,
 * Zuweisung und Ablauf. Sein Anlegen schreibt ATOMAR einen Ausgangseintrag
 * (outboxById, dry_run) — es wird nichts versandt. Ein Ruecklauf (nur
 * Worker) speichert NUR das Ergebnis zur Pruefung; erst reviewJobResult
 * (accepted) setzt das Element auf review. Abgebrochene, abgelaufene oder
 * fremde Rueckgaben werden abgewiesen; ein Ergebnis zu einer aelteren
 * Eingangsversion ist stale und kann nicht angenommen werden. */
export const JOB_MAX_LAUFZEIT_MS = 7 * ZEIT.TAG;

export function createJob(input, { jobId, kind, purpose, sourceType, sourceId, inputVersion, executor, contextRefs, expiresAt }, ctx) {
  ctxPruefen(ctx);
  const p = validatePolicy(ctx.policy);
  if (!p.ok) return fehler("POLICY_INVALID", p.errors);
  const data = klon(requireCore(input));
  pruefeId(jobId, "jobId");
  if (!EXECUTORS.includes(executor)) return fehler("EXECUTOR_UNKNOWN", executor);
  if (!String(kind || "").trim() || !String(purpose || "").trim()) return fehler("JOB_PURPOSE_MISSING");
  if (!QUELLEN[sourceType]) return fehler("JOB_SOURCE_TYPE", sourceType);
  const e = quelleFinden(data, sourceType, sourceId);
  if (!e) return fehler("SOURCE_NOT_FOUND", sourceType + ":" + sourceId);
  const z = effektiverZustand(sourceType, e);
  if (z.unmigrated) return fehler("NOT_MIGRATED");
  if (z.version !== inputVersion) return fehler("VERSION_MISMATCH", { expected: inputVersion, current: z.version });
  if (!z.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) return fehler("SOURCE_CLOSED", z.state);
  if (!Array.isArray(contextRefs)) return fehler("JOB_CONTEXT_REFS_INVALID");
  for (const r of contextRefs) {
    if (!istKarte(r) || !["chatgptLead", "chatgptTask", "task", "document", "evidence", "question"].includes(r.sourceType) || !quelleFinden(data, r.sourceType, r.sourceId)) return fehler("JOB_CONTEXT_REF_NOT_FOUND", r);
  }
  const ablauf = msAus(expiresAt);
  if (!Number.isFinite(ablauf) || ablauf <= ctx.now || ablauf > ctx.now + JOB_MAX_LAUFZEIT_MS) return fehler("JOB_EXPIRES_INVALID", expiresAt);
  const vorhanden = data.automation.jobsById[jobId];
  if (vorhanden) {
    if (vorhanden.sourceType === sourceType && vorhanden.sourceId === sourceId && vorhanden.inputVersion === inputVersion && vorhanden.purpose === String(purpose).trim()) return { ok: true, data, job: vorhanden, created: false };
    return fehler("JOB_IMMUTABLE", jobId);
  }
  const j = {
    id: jobId, version: 1, kind: String(kind).trim(), purpose: String(purpose).trim().slice(0, 1000),
    sourceType, sourceId, inputVersion, executor,
    contextRefs: contextRefs.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
    state: "queued", createdAt: isoAus(ctx.now), createdBy: ctx.actor ? ctx.actor.id : null,
    acceptedVersions: [inputVersion],
    expiresAt: isoAus(ablauf), returnedAt: null, result: null, error: null, review: null,
    mode: ctx.policy.featureFlags.runner,
  };
  data.automation.jobsById[jobId] = j;
  data.automation.outboxById["job:" + jobId] = { id: "job:" + jobId, kind: "job-dispatch", jobId, executor, mode: ctx.policy.featureFlags.providers, state: "pending", createdAt: j.createdAt, dispatchedAt: null };
  bump(data, ctx.now);
  return { ok: true, data, job: j, created: true };
}

export function cancelJob(input, { jobId, reason }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const j = data.automation.jobsById[jobId];
  if (!j) return fehler("JOB_NOT_FOUND", jobId);
  if (!String(reason || "").trim()) return fehler("REASON_MISSING");
  if (j.state === "cancelled") return { ok: true, data, job: j, created: false };
  if (!["queued", "running"].includes(j.state)) return fehler("JOB_NOT_ACTIVE", j.state);
  j.state = "cancelled";
  j.cancelledAt = isoAus(ctx.now);
  j.cancelReason = String(reason).slice(0, 500);
  const o = data.automation.outboxById["job:" + jobId];
  if (o && o.state === "pending") o.state = "cancelled";
  const key = sourceKey(j.sourceType, j.sourceId);
  const w = data.automation.waitingById[key];
  if (w && w.evidence && w.evidence.kind === "job" && w.evidence.jobId === jobId) {
    // Das Warten hat seinen Beleg verloren: zurueck nach doing.
    delete data.automation.waitingById[key];
    const e = quelleFinden(data, j.sourceType, j.sourceId);
    if (e) setzeZustand(e, j.sourceType, "doing", ctx.now, "job " + jobId + " cancelled");
  }
  bump(data, ctx.now);
  return { ok: true, data, job: j, created: true };
}

export function recordJobReturn(input, { jobId, outcome, resultRef, resultHash, error }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const j = data.automation.jobsById[jobId];
  if (!j) return fehler("JOB_NOT_FOUND", jobId);
  if (outcome !== "returned" && outcome !== "failed") return fehler("JOB_OUTCOME_UNKNOWN", outcome);
  if (j.state === "returned" || j.state === "failed") {
    if (j.state === outcome && (outcome === "failed" || (j.result && j.result.ref === String(resultRef || "").trim() && j.result.hash === resultHash))) return { ok: true, data, job: j, created: false };
    return fehler("JOB_ALREADY_FINISHED", j.state);
  }
  if (!["queued", "running"].includes(j.state)) return fehler("JOB_NOT_ACTIVE", j.state);
  if (msAus(j.expiresAt) <= ctx.now) return fehler("JOB_EXPIRED", j.expiresAt);
  const e = quelleFinden(data, j.sourceType, j.sourceId);
  const z = e ? effektiverZustand(j.sourceType, e) : null;
  if (outcome === "returned") {
    if (!String(resultRef || "").trim()) return fehler("JOB_RESULT_REF_MISSING");
    if (typeof resultHash !== "string" || !HASH_HEX.test(resultHash)) return fehler("JOB_RESULT_HASH_INVALID");
    j.result = { ref: String(resultRef).trim(), hash: resultHash, receivedAt: isoAus(ctx.now), receivedFrom: ctx.actor ? ctx.actor.id : null, stale: !z || !(j.acceptedVersions || [j.inputVersion]).includes(z.version), sourceVersionAtReturn: z ? z.version : null };
  } else {
    j.error = String(error || "failed").slice(0, 500);
  }
  j.state = outcome;
  j.returnedAt = isoAus(ctx.now);
  // Das Quellelement bleibt UNVERAENDERT — erst die Pruefung (reviewJobResult) wirkt.
  bump(data, ctx.now);
  return { ok: true, data, job: j, created: true };
}

export function reviewJobResult(input, { jobId, verdict, reviewer, note }, ctx) {
  ctxPruefen(ctx);
  const data = klon(requireCore(input));
  const j = data.automation.jobsById[jobId];
  if (!j) return fehler("JOB_NOT_FOUND", jobId);
  if (!["accepted", "rejected"].includes(verdict)) return fehler("VERDICT_UNKNOWN", verdict);
  if (!String(reviewer || "").trim()) return fehler("REVIEWER_MISSING");
  if (j.review) return j.review.verdict === verdict ? { ok: true, data, job: j, created: false } : fehler("JOB_ALREADY_REVIEWED", j.review.verdict);
  if (j.state !== "returned" && j.state !== "failed") return fehler("JOB_NOT_RETURNED", j.state);
  if (verdict === "accepted" && (j.state !== "returned" || !j.result || j.result.stale)) return fehler("JOB_RESULT_NOT_ACCEPTABLE", j.result ? "stale" : j.state);
  j.review = { verdict, reviewer: String(reviewer).trim(), reviewedAt: isoAus(ctx.now), reviewedBy: ctx.actor ? ctx.actor.id : null, note: note ? String(note).slice(0, 500) : null };
  j.reviewedAt = j.review.reviewedAt;
  if (verdict === "accepted") {
    const e = quelleFinden(data, j.sourceType, j.sourceId);
    const z = e ? effektiverZustand(j.sourceType, e) : null;
    if (e && z && !z.unmigrated && !z.unmapped && !ABGESCHLOSSENE_ZUSTAENDE.includes(z.state) && z.state !== "review") {
      setzeZustand(e, j.sourceType, "review", ctx.now, "job " + jobId + " accepted");
      delete data.automation.waitingById[sourceKey(j.sourceType, j.sourceId)];
    }
  }
  bump(data, ctx.now);
  return { ok: true, data, job: j, created: true };
}

export { KARTEN_ZUSTAENDE };
