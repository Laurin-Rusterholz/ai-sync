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
import { QUELLEN, WARTE_ZUSTAENDE, ABGESCHLOSSENE_ZUSTAENDE, effektiverZustand, validatePolicy, pruefeId } from "./assistant-schema.mjs";
import { klon, requireCore } from "./assistant-migration.mjs";
import { bump, notizBauen, quelleFinden } from "./assistant-buchhaltung.mjs";
import { dailyAssistantTrafficLight } from "./assistant-ampel.mjs";
import { istLokalDatum, isoAus, msAus, wandzeitZuMs, tagesEndeMs, datumPlusTage, assistentenTag } from "./assistant-zeit.mjs";

const fehler = (error, detail) => ({ ok: false, error, detail: detail == null ? null : detail });
function istKarte(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

/* Die Verpflichtungsmenge: Zustand jedes Elements und jeder Karte. Nur
 * Zustandsnamen und Belegkennungen, keine Kopien. */
export function verpflichtungsmenge(data) {
  const out = {};
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    for (const [id, e] of Object.entries(data.entities[q.store] || {})) {
      if (!istKarte(e)) { out[sourceType + ":" + id] = { state: "corrupt" }; continue; }
      const z = effektiverZustand(sourceType, e);
      const eintrag = { state: z.unmigrated ? "unmigrated" : z.unmapped ? "unmapped" : z.state, version: z.version };
      const w = data.automation.waitingById[sourceType + ":" + id];
      if (w && WARTE_ZUSTAENDE.includes(z.state)) eintrag.evidence = w.evidence;
      out[sourceType + ":" + id] = eintrag;
    }
  }
  const a = data.automation;
  for (const [id, it] of Object.entries(a.intakeById)) out["intake:" + id] = { state: it && it.status };
  for (const [id, d] of Object.entries(a.documentsById)) out["document:" + id] = { state: d && d.status };
  for (const [id, j] of Object.entries(a.jobsById)) out["job:" + id] = { state: j && j.state, reviewed: !!(j && j.review) };
  for (const [id, q] of Object.entries(a.questionsById)) out["question:" + id] = { state: q && q.status };
  for (const [id, ans] of Object.entries(a.answersById)) out["answer:" + id] = { state: ans && ans.consumedAt ? "consumed" : "open" };
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
  if (!run.startNoteId || !data.entities.notes || !data.entities.notes[run.startNoteId]) maengel.push({ code: "START_NOTE_MISSING", detail: run.startNoteId || null });
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
  data.entities.notes = istKarte(data.entities.notes) ? data.entities.notes : {};
  if (data.entities.notes[finalNoteId]) return fehler("NOTE_ID_TAKEN", finalNoteId);

  const nowIso = isoAus(ctx.now);
  const revision = bump(data, ctx.now);
  run.closureOutcomes = verpflichtungsmenge(data);
  run.phase = "final";
  run.finalAt = nowIso;
  run.closureRevision = revision;
  run.closureCutoff = nowIso;
  run.finalNoteId = finalNoteId;
  run.finalEvaluation = { coverage: p.evaluation.coverage, operations: p.evaluation.operations, evaluatedRevision: p.evaluation.evaluatedRevision, evaluatedFingerprint: p.evaluation.evaluatedFingerprint, evaluatedAt: p.evaluation.evaluatedAt };
  run.revision = (Number(run.revision) || 0) + 1;
  run.updatedAt = nowIso;
  data.entities.notes[finalNoteId] = notizBauen(finalNoteId, {
    title: `Tagesbriefing ${date} — Abschluss`,
    content: finalnotizText(run, p.evaluation),
    kind: "assistantFinal", date, now: ctx.now,
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
  for (const [key, o] of Object.entries(run.closureOutcomes)) zeilen.push(`- ${key} → ${o.state}${o.evidence ? " (Beleg " + JSON.stringify(o.evidence) + ")" : ""}`);
  return zeilen.join("\n");
}

/* Widerspruch pruefen — ohne zu veraendern. */
export function pruefeWiderspruch(data, { date }, { now }) {
  const run = istKarte(data.dailyBriefing?.assistantRuns?.[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return { ok: false, error: "RUN_MISSING" };
  if (run.phase !== "final") return { ok: true, contradictions: [], newIntake: [], nextRunDate: null, final: false };
  const cutoff = msAus(run.closureCutoff);
  const jetzt = verpflichtungsmenge(data);
  const widersprueche = [];
  for (const [key, damals] of Object.entries(run.closureOutcomes || {})) {
    const [sourceType, sourceId] = key.split(/:(.+)/);
    const heute = jetzt[key];
    if (!heute) { widersprueche.push({ sourceType, sourceId, was: damals.state, now: "missing" }); continue; }
    const geschlossenDamals = ABGESCHLOSSENE_ZUSTAENDE.includes(damals.state) || ["done", "consumed", "cancelled", "answered", "withdrawn", "expired", "failed"].includes(damals.state) || (damals.state === "returned" && damals.reviewed);
    if (geschlossenDamals && heute.state !== damals.state && !ABGESCHLOSSENE_ZUSTAENDE.includes(heute.state) && !["done", "consumed", "cancelled"].includes(heute.state)) {
      widersprueche.push({ sourceType, sourceId, was: damals.state, now: heute.state });
      continue;
    }
    if (WARTE_ZUSTAENDE.includes(damals.state)) {
      const belegWeg = !heute.evidence || JSON.stringify(heute.evidence) !== JSON.stringify(damals.evidence);
      if (heute.state === "doing" || heute.state === "unmapped" || heute.state === "unmigrated" || (WARTE_ZUSTAENDE.includes(heute.state) && belegWeg)) {
        widersprueche.push({ sourceType, sourceId, was: damals.state, now: heute.state, evidenceLost: belegWeg });
      }
    }
  }
  const neu = [];
  const a = data.automation;
  for (const [id, it] of Object.entries(a.intakeById || {})) {
    if (it && it.status === "open" && msAus(it.registeredAt) > cutoff) neu.push({ sourceType: "intake", sourceId: id });
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
  data.entities.notes = istKarte(data.entities.notes) ? data.entities.notes : {};
  if (data.entities.notes[correctionId]) return fehler("NOTE_ID_TAKEN", correctionId);

  const nowIso = isoAus(ctx.now);
  const revision = bump(data, ctx.now);
  const korrektur = {
    id: correctionId, at: nowIso, revision, reason: String(reason).trim().slice(0, 500),
    contradiction: { sourceType: contradiction.sourceType, sourceId: contradiction.sourceId },
    invalidatedFinalNoteId: run.finalNoteId, invalidatedClosureRevision: run.closureRevision, invalidatedFinalAt: run.finalAt,
    correctionNoteId: correctionId, by: ctx.actor ? ctx.actor.id : null,
  };
  run.corrections = [...(run.corrections || []), korrektur];
  run.phase = "exception_open";
  run.invalidatedAt = nowIso;
  run.revision = (Number(run.revision) || 0) + 1;
  run.updatedAt = nowIso;
  data.entities.notes[correctionId] = notizBauen(correctionId, {
    title: `Tagesbriefing ${date} — Korrektur`,
    content: `Abschluss vom ${korrektur.invalidatedFinalAt} (Notiz ${korrektur.invalidatedFinalNoteId}, Revision ${korrektur.invalidatedClosureRevision}) widerrufen: ${korrektur.reason}\nWiderspruch: ${contradiction.sourceType}:${contradiction.sourceId}`,
    kind: "assistantCorrection", date, now: ctx.now,
  });
  return { ok: true, data, already: false, correction: korrektur };
}
