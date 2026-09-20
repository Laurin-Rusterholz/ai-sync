/* ══ Tagesbriefing v3 — Abschluss und Invalidierung ═════════════════════════
 *
 * closeRun() ist eine REINE Mutation fuer den CAS-Umschlag: finalNoteId und
 * now kommen von aussen, im Mutator gibt es keine Uhr, keine UUID, keinen
 * Nebeneffekt. Wiederholung ist ein No-op.
 *
 * Voraussetzungen, alle gegen den VOLLSTAENDIGEN Bestand geprueft:
 *   · Ortszeit ≥ 23:00 Europe/Zurich am Lauftag, vor 04:00 des Folgetages
 *   · Startnotiz vorhanden, Quittungen process09 und close23 vorhanden
 *   · Ampel beide Achsen gruen (alle Aktionen abgeschlossen oder belegt
 *     wartend; alle Quellen inkl. Quantus-Kern ≤ 15 Minuten alt)
 *
 * Der Abschlussnachweis (closureOutcomes) erfasst die GESAMTE
 * Verpflichtungsmenge zum Zeitpunkt des Abschlusses — jedes Element der
 * Quellsammlungen mit Zustand und Beleg, jede Karte —, nicht die vom
 * Agenten gewaehlten itemRefs. Ein spaeterer Widerspruch (ein abgeschlossenes
 * Element wieder offen, ein belegtes Warten ohne Beleg, eine erledigte Karte
 * wieder offen) oeffnet den Lauf als exception_open, append-only, mit
 * eigener Korrekturnotiz; die historische Finalnotiz bleibt unveraendert.
 * Neuer Eingang nach closureCutoff ist kein Widerspruch — er gehoert in den
 * naechsten Lauf.
 * ═════════════════════════════════════════════════════════════════════════ */
import { QUELLEN, WARTE_ZUSTAENDE, ABGESCHLOSSENE_ZUSTAENDE, effektiverZustand, rollenFuer, validatePolicy, pruefeId, canonicalJson } from "./assistant-schema.mjs";
import { klon, requireCore } from "./assistant-migration.mjs";
import { bump, chatgptNoteBauen, quelleFinden, pruefeWarteKarte, abschlussBelegPruefen } from "./assistant-buchhaltung.mjs";
import { dailyAssistantTrafficLight } from "./assistant-ampel.mjs";
import { istLokalDatum, isoAus, msAus, wandzeitZuMs, tagesEndeMs, datumPlusTage, assistentenTag } from "./assistant-zeit.mjs";

const fehler = (error, detail) => ({ ok: false, error, detail: detail == null ? null : detail });
function istKarte(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

/* Die Verpflichtungsmenge: fuer JEDES Element und JEDE Karte das, was der
 * Abschluss geprueft hat — Zustand, Version, bei Warten die vollstaendige
 * Wartekarte samt Identitaet des Belegs (Kennung, Art, Fingerabdruck), bei
 * Dokumenten die Extraktion und die Ergebnisse, bei Jobs das Review, bei
 * Projekten die Fristen. Keine inhaltlichen Kopien: nur Kennungen, Zustaende,
 * Zeitpunkte und Fingerabdruecke. */
function belegIdentitaet(data, ev) {
  const a = data.automation;
  if (!ev || typeof ev !== "object") return null;
  if (ev.kind === "evidence") { const e = a.evidenceById[ev.evidenceId]; return e ? { kind: "evidence", id: e.id, evidenceKind: e.kind, ref: e.ref, fingerprint: e.fingerprint, sourceType: e.sourceType, sourceId: e.sourceId } : null; }
  if (ev.kind === "question") { const q = a.questionsById[ev.questionId]; return q ? { kind: "question", id: q.id, status: q.status, sourceType: q.sourceType, sourceId: q.sourceId } : null; }
  if (ev.kind === "job") { const j = a.jobsById[ev.jobId]; return j ? { kind: "job", id: j.id, state: j.state, executor: j.executor, sourceType: j.sourceType, sourceId: j.sourceId } : null; }
  return null;
}

export function verpflichtungsmenge(data, runDate) {
  const out = {};
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    for (const [id, e] of Object.entries(data.entities[q.store] || {})) {
      if (!istKarte(e)) { out[sourceType + ":" + id] = { state: "corrupt" }; continue; }
      const z = effektiverZustand(sourceType, e);
      const eintrag = { state: z.unmigrated ? "unmigrated" : z.unmapped ? "unmapped" : z.state, version: z.version };
      const w = data.automation.waitingById[sourceType + ":" + id];
      if (WARTE_ZUSTAENDE.includes(z.state)) {
        eintrag.waiting = w ? { state: w.state, counterparty: w.counterparty, waitingSince: w.waitingSince, nextAction: w.nextAction, followUpAt: w.followUpAt, evidence: w.evidence } : null;
        eintrag.evidenceIdentity = w ? belegIdentitaet(data, w.evidence) : null;
      }
      if (ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) {
        const ab = abschlussBelegPruefen(data, sourceType, id, e);
        const c = e.operationalStateSource && e.operationalStateSource.closure;
        eintrag.closure = { origin: ab.origin, ok: ab.ok, code: ab.ok ? null : ab.code, binding: c && typeof c.binding === "string" ? c.binding : null, ref: c ? { kind: c.kind, evidenceId: c.evidenceId || null, jobId: c.jobId || null, answerId: c.answerId || null } : null };
      }
      if (sourceType === "task" && e.dueDate) eintrag.dueDate = String(e.dueDate).slice(0, 10);
      out[sourceType + ":" + id] = eintrag;
    }
  }
  for (const [id, p] of Object.entries(data.entities.projects || {})) {
    if (!istKarte(p)) { out["project:" + id] = { state: "corrupt" }; continue; }
    const fristen = {};
    for (const d of Array.isArray(p.deadlines) ? p.deadlines : []) {
      if (!d || !d.id) continue;
      fristen[d.id] = { date: d.date ? String(d.date).slice(0, 10) : null, done: !!d.done };
    }
    out["project:" + id] = { state: String(p.status || ""), deadlines: fristen };
  }
  const a = data.automation;
  for (const [id, it] of Object.entries(a.intakeById)) out["intake:" + id] = { state: it && it.status, linkedTo: it && it.linkedTo ? it.linkedTo : null };
  for (const [id, d] of Object.entries(a.documentsById)) {
    const results = d && Array.isArray(d.results) ? d.results : [];
    out["document:" + id] = { state: d && d.status, parse: d && d.parse ? { outcome: d.parse.outcome, textRef: d.parse.textRef, extractHash: d.parse.extractHash } : null, results, resultsExist: results.every((r) => r && quelleFinden(data, r.sourceType, r.sourceId)), hash: d && d.hash, attachmentId: d && d.attachmentId };
  }
  for (const [id, j] of Object.entries(a.jobsById)) out["job:" + id] = {
    state: j && j.state,
    review: j && j.review ? { verdict: j.review.verdict, reviewedAt: j.review.reviewedAt, resultRef: j.review.resultRef, resultHash: j.review.resultHash, sourceVersion: j.review.sourceVersion } : null,
    result: j && j.result ? { ref: j.result.ref, hash: j.result.hash, receivedAt: j.result.receivedAt } : null,
    inputVersion: j && j.inputVersion, executor: j && j.executor,
  };
  for (const [id, q] of Object.entries(a.questionsById)) out["question:" + id] = { state: q && q.status, answerId: q && q.answerId };
  for (const [id, ans] of Object.entries(a.answersById)) out["answer:" + id] = { state: ans && ans.consumedAt ? "consumed" : "open", consumedBy: ans && ans.consumedBy };
  return out;
}

/* Prueft alle Voraussetzungen, ohne etwas zu veraendern. */
export function pruefeAbschluss(data, { date }, { now, policy }) {
  const maengel = [];
  const pv = validatePolicy(policy);
  if (!pv.ok) return { ok: false, blockers: [{ code: "POLICY_INCOMPLETE", detail: pv.errors }], evaluation: null };
  if (!istLokalDatum(date)) return { ok: false, blockers: [{ code: "DATE_INVALID", detail: date }], evaluation: null };
  const run = istKarte(data.dailyBriefing?.assistantRuns?.[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return { ok: false, blockers: [{ code: "RUN_MISSING", detail: date }], evaluation: null };

  const [hh, mm] = String(policy.closure.earliestLocalTime).split(":").map(Number);
  const fruehestens = wandzeitZuMs(date, hh, mm);
  const spaetestens = tagesEndeMs(date);
  if (now < fruehestens) maengel.push({ code: "CLOSURE_TOO_EARLY", detail: { earliest: isoAus(fruehestens) } });
  if (now >= spaetestens) maengel.push({ code: "CLOSURE_DAY_OVER", detail: { dayEnd: isoAus(spaetestens) } });
  if (!run.startNoteId || !istKarte(data.entities.chatgptNotes[run.startNoteId])) maengel.push({ code: "START_NOTE_MISSING", detail: run.startNoteId || null });
  for (const s of policy.closure.requiredReceipts) {
    const r = run.slotReceipts && run.slotReceipts[s];
    if (!r || !r.receiptId) maengel.push({ code: "RECEIPT_MISSING", detail: s });
  }
  const evaluation = dailyAssistantTrafficLight(run, data, now, policy);
  if (evaluation.coverage !== "green") maengel.push({ code: "COVERAGE_NOT_GREEN", detail: evaluation.reasons.filter((r) => r.axis === "coverage") });
  if (evaluation.operations !== "green") maengel.push({ code: "OPERATIONS_NOT_GREEN", detail: evaluation.reasons.filter((r) => r.axis === "operations") });
  return { ok: maengel.length === 0, blockers: maengel, evaluation, run };
}

export function closeRun(input, { date, finalNoteId }, ctx) {
  if (!ctx || typeof ctx.now !== "number") throw new TypeError("ctx.now (ms) fehlt");
  const data = klon(requireCore(input));
  const run = istKarte(data.dailyBriefing.assistantRuns[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return fehler("RUN_MISSING", date);
  if (run.phase === "final" && run.finalNoteId) return { ok: true, data, already: true, finalNoteId: run.finalNoteId, run };
  if (run.phase === "exception_open") return fehler("RUN_EXCEPTION_OPEN", { invalidatedAt: run.invalidatedAt });
  pruefeId(finalNoteId, "finalNoteId");
  const p = pruefeAbschluss(data, { date }, ctx);
  if (!p.ok) return { ok: false, error: "CLOSURE_BLOCKED", detail: p.blockers, evaluation: p.evaluation };
  if (data.entities.chatgptNotes[finalNoteId]) return fehler("NOTE_ID_TAKEN", finalNoteId);

  const nowIso = isoAus(ctx.now);
  const revision = bump(data, ctx.now);
  run.closureOutcomes = verpflichtungsmenge(data, date);
  run.phase = "final";
  run.finalAt = nowIso;
  run.closureRevision = revision;
  run.closureCutoff = nowIso;
  run.finalNoteId = finalNoteId;
  run.finalEvaluation = { coverage: p.evaluation.coverage, operations: p.evaluation.operations, evaluatedRevision: p.evaluation.evaluatedRevision, evaluatedFingerprint: p.evaluation.evaluatedFingerprint, evaluatedAt: p.evaluation.evaluatedAt };
  run.revision = (Number(run.revision) || 0) + 1;
  run.updatedAt = nowIso;
  data.entities.chatgptNotes[finalNoteId] = chatgptNoteBauen(finalNoteId, {
    title: `Tagesbriefing ${date} — Abschluss`,
    content: finalnotizText(run, p.evaluation),
    kind: "assistantFinal", date, runRevision: run.revision, now: ctx.now,
  });
  return { ok: true, data, already: false, finalNoteId, run, evaluation: p.evaluation };
}

function finalnotizText(run, evaluation) {
  const zeilen = [
    `Abschluss ${run.date} um ${run.finalAt} (Revision ${run.closureRevision}).`,
    `Ampel: Arbeitsabdeckung ${evaluation.coverage}, Betrieb ${evaluation.operations}.`,
    `Quittungen: ${Object.entries(run.slotReceipts).filter(([, r]) => r && r.receiptId).map(([k]) => k).join(", ") || "keine"}.`,
    `Verpflichtungen geprueft: ${Object.keys(run.closureOutcomes).length}, davon im Lauf gefuehrt: ${run.itemRefs.length}.`,
  ];
  for (const [key, o] of Object.entries(run.closureOutcomes)) zeilen.push(`- ${key} → ${o.state}${o.evidenceIdentity ? " (Beleg " + o.evidenceIdentity.kind + ":" + o.evidenceIdentity.id + ")" : ""}`);
  return zeilen.join("\n");
}

/* Widerspruch pruefen — ohne zu veraendern. Verglichen wird die GESAMTE
 * beim Abschluss geprueft Verpflichtung, nicht nur Zustandsnamen:
 *   · abgeschlossen → nicht mehr abgeschlossen
 *   · belegtes Warten → Karte weg, Feld der Karte veraendert oder ungueltig,
 *     Beleg fehlt / anders / fremd, Element nicht mehr wartend
 *   · behandeltes Dokument → Extraktion oder Ergebnisse verloren
 *   · geprueftes Job-Ergebnis → Review verloren oder anders
 *   · Projektfrist erledigt → wieder offen; neue faellige offene Frist
 *   · geklaerter Eingang / konsumierte Antwort → wieder offen
 * Neuer Eingang und neue Elemente nach closureCutoff sind KEIN Widerspruch. */
export function pruefeWiderspruch(data, { date }, { now, policy }) {
  const run = istKarte(data.dailyBriefing?.assistantRuns?.[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return { ok: false, error: "RUN_MISSING" };
  if (run.phase !== "final") return { ok: true, contradictions: [], newIntake: [], nextRunDate: null, final: false };
  const pv = validatePolicy(policy);
  const cutoff = msAus(run.closureCutoff);
  const jetzt = verpflichtungsmenge(data, date);
  const widersprueche = [];
  const melden = (key, was, nowState, grund, extra) => {
    const [sourceType, sourceId] = key.split(/:(.+)/);
    widersprueche.push({ sourceType, sourceId, was, now: nowState, reason: grund, ...(extra || {}) });
  };
  const geschlossen = (st) => ABGESCHLOSSENE_ZUSTAENDE.includes(st) || ["done", "consumed", "cancelled", "answered", "withdrawn", "expired", "failed"].includes(st);
  for (const [key, damals] of Object.entries(run.closureOutcomes || {})) {
    const heute = jetzt[key];
    const [sourceType, sourceId] = key.split(/:(.+)/);
    if (!heute) { melden(key, damals.state, "missing", "OBLIGATION_MISSING"); continue; }
    if (sourceType === "project") {
      for (const [did, f] of Object.entries(damals.deadlines || {})) {
        const h = heute.deadlines?.[did];
        if (f.done && (!h || !h.done)) melden(key, "deadline done", h ? "deadline open" : "deadline missing", "PROJECT_DEADLINE_REOPENED", { deadlineId: did });
      }
      for (const [did, h] of Object.entries(heute.deadlines || {})) {
        const f = damals.deadlines?.[did];
        const faelligOffen = h.date && h.date <= date && !h.done;
        const warFaelligOffen = f && f.date && f.date <= date && !f.done;
        if (faelligOffen && !warFaelligOffen) melden(key, f ? "deadline " + f.date : "no deadline", "deadline due open", "PROJECT_DEADLINE_DUE_AFTER_CLOSE", { deadlineId: did });
      }
      continue;
    }
    if (geschlossen(damals.state) && !geschlossen(heute.state)) { melden(key, damals.state, heute.state, "REOPENED"); continue; }
    if (damals.closure && ABGESCHLOSSENE_ZUSTAENDE.includes(heute.state)) {
      // Der gebundene Abschlussbeleg muss heute noch existieren, unveraendert
      // sein und zum selben Beleg zeigen — nicht nur "closure vorhanden".
      const h = heute.closure || {};
      if (!h.ok || h.binding !== damals.closure.binding || canonicalJson(h.ref) !== canonicalJson(damals.closure.ref) || h.origin !== damals.closure.origin) { melden(key, damals.state, heute.state, "CLOSURE_EVIDENCE_LOST", { code: h.code || null }); continue; }
    }
    if (sourceType === "job" && damals.review) {
      if (heute.state !== damals.state || !heute.review || canonicalJson(heute.review) !== canonicalJson(damals.review)) { melden(key, "reviewed " + damals.review.verdict, heute.review ? heute.review.verdict : "unreviewed", "JOB_REVIEW_LOST"); continue; }
      if (canonicalJson(heute.result) !== canonicalJson(damals.result) || heute.inputVersion !== damals.inputVersion || heute.executor !== damals.executor) { melden(key, "result " + (damals.result && damals.result.hash), "result " + (heute.result && heute.result.hash), "JOB_RESULT_CHANGED"); continue; }
    }
    if (sourceType === "document" && damals.state === "done") {
      if (canonicalJson(heute.parse) !== canonicalJson(damals.parse) || canonicalJson(heute.results) !== canonicalJson(damals.results) || heute.hash !== damals.hash || heute.attachmentId !== damals.attachmentId || !heute.resultsExist) melden(key, "done", "processing changed", "DOCUMENT_PROOF_LOST");
      continue;
    }
    if (WARTE_ZUSTAENDE.includes(damals.state)) {
      if (!WARTE_ZUSTAENDE.includes(heute.state)) { melden(key, damals.state, heute.state, "WAITING_ENDED"); continue; }
      if (!heute.waiting) { melden(key, damals.state, heute.state, "WAITING_CARD_LOST"); continue; }
      if (canonicalJson(heute.waiting) !== canonicalJson(damals.waiting)) { melden(key, damals.state, heute.state, "WAITING_CARD_CHANGED"); continue; }
      if (canonicalJson(heute.evidenceIdentity) !== canonicalJson(damals.evidenceIdentity) || !heute.evidenceIdentity) { melden(key, damals.state, heute.state, "WAITING_EVIDENCE_LOST"); continue; }
      const e = quelleFinden(data, sourceType, sourceId);
      const pr = e ? pruefeWarteKarte(data, sourceType, sourceId, data.automation.waitingById[key], { now, policy: pv.ok ? policy : null, rollen: rollenFuer(sourceType, e) }) : { maengel: ["SOURCE_MISSING"] };
      if (pr.maengel.length) melden(key, damals.state, heute.state, "WAITING_INVALID", { defects: pr.maengel });
    }
  }
  const neu = [];
  const a = data.automation;
  for (const [id, it] of Object.entries(a.intakeById || {})) {
    if (it && it.status === "open" && msAus(it.registeredAt) > cutoff && !run.closureOutcomes["intake:" + id]) neu.push({ sourceType: "intake", sourceId: id });
  }
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    for (const [id, e] of Object.entries(data.entities[q.store] || {})) {
      if (!istKarte(e) || run.closureOutcomes[sourceType + ":" + id]) continue;
      const created = msAus(e.createdAt);
      if (Number.isFinite(created) && created > cutoff) neu.push({ sourceType, sourceId: id });
    }
  }
  const nextRunDate = assistentenTag(Math.max(now, tagesEndeMs(date)));
  return { ok: true, final: true, contradictions: widersprueche, newIntake: neu, nextRunDate: nextRunDate === date ? datumPlusTage(date, 1) : nextRunDate };
}

export function invalidateClosure(input, { date, correctionId, reason, contradiction }, ctx) {
  if (!ctx || typeof ctx.now !== "number") throw new TypeError("ctx.now (ms) fehlt");
  const data = klon(requireCore(input));
  const run = istKarte(data.dailyBriefing.assistantRuns[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return fehler("RUN_MISSING", date);
  if ((run.corrections || []).some((c) => c.id === correctionId)) return { ok: true, data, already: true };
  if (run.phase !== "final") return fehler("RUN_NOT_FINAL", run.phase);
  pruefeId(correctionId, "correctionId");
  if (!String(reason || "").trim()) return fehler("REASON_MISSING");
  if (!istKarte(contradiction) || !contradiction.sourceType || !contradiction.sourceId) return fehler("CONTRADICTION_MISSING");
  const w = pruefeWiderspruch(data, { date }, ctx);
  const passt = w.contradictions.some((c) => c.sourceType === contradiction.sourceType && c.sourceId === contradiction.sourceId);
  if (!passt) return fehler("NOT_A_CONTRADICTION", { given: contradiction, found: w.contradictions, nextRunDate: w.nextRunDate });
  if (data.entities.chatgptNotes[correctionId]) return fehler("NOTE_ID_TAKEN", correctionId);

  const nowIso = isoAus(ctx.now);
  const revision = bump(data, ctx.now);
  const korrektur = {
    id: correctionId, at: nowIso, revision, reason: String(reason).trim().slice(0, 500),
    contradiction: { sourceType: contradiction.sourceType, sourceId: contradiction.sourceId },
    invalidatedFinalNoteId: run.finalNoteId, invalidatedClosureRevision: run.closureRevision, invalidatedFinalAt: run.finalAt,
    correctionNoteId: correctionId, by: ctx.actor ? ctx.actor.id : null,
    matched: w.contradictions.find((c) => c.sourceType === contradiction.sourceType && c.sourceId === contradiction.sourceId) || null,
  };
  run.corrections = [...(run.corrections || []), korrektur];
  run.phase = "exception_open";
  run.invalidatedAt = nowIso;
  run.revision = (Number(run.revision) || 0) + 1;
  run.updatedAt = nowIso;
  // Neuer Eintrag mit supersedes; die historische Finalnotiz bleibt byteidentisch
  // (kein supersededBy, kein "ueberholt" — eine ChatGPT Note wird nie veraendert).
  data.entities.chatgptNotes[correctionId] = chatgptNoteBauen(correctionId, {
    title: `Tagesbriefing ${date} — Korrektur`,
    content: `Abschluss vom ${korrektur.invalidatedFinalAt} (Note ${korrektur.invalidatedFinalNoteId}, Revision ${korrektur.invalidatedClosureRevision}) widerrufen: ${korrektur.reason}\nWiderspruch: ${contradiction.sourceType}:${contradiction.sourceId}`,
    kind: "assistantCorrection", date, runRevision: run.revision, now: ctx.now, supersedes: run.finalNoteId,
  });
  return { ok: true, data, already: false, correction: korrektur };
}
