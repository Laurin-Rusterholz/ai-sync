/* ══ Tagesbriefing v3 — Abschluss und Invalidierung ═════════════════════════
 *
 * closeRun() ist eine REINE Mutation, die spaeter innerhalb des CAS-Schreib-
 * pfads laeuft: Bestand lesen (mit ETag) → closeRun(data, …) → Ergebnis mit
 * If-Match zurueckschreiben; bei 412 von vorn. Damit die Wiederholung
 * wortgleich ist, kommen finalNoteId und "now" von AUSSEN herein — im
 * Mutator gibt es kein Date.now(), keine UUID, keinen Nebeneffekt.
 *
 * Voraussetzungen (alle geprueft gegen den VOLLSTAENDIGEN Bestand):
 *   · Ortszeit ≥ 23:00 Europe/Zurich am Lauftag (und vor 04:00 des Folgetages)
 *   · Quittungen process09 und close23 (Policy: closure.requiredReceipts)
 *   · Ampel: beide Achsen gruen — das schliesst ein: alle erforderlichen
 *     Aktionen abgeschlossen oder in echtem Warten, erforderliche Quellen
 *     hoechstens sourceMaxAgeMinutes (15) alt
 *
 * Atomar gesetzt: phase=final, finalAt, closureRevision, closureCutoff,
 * finalNoteId und GENAU EINE Finalnotiz in entities.notes. Ein zweiter
 * Aufruf fuer denselben Tag ist ein No-op (auch mit anderer finalNoteId).
 *
 * Invalidierung: ein Widerspruch NACH dem Abschluss (ein bei Abschluss als
 * erledigt gezaehltes Element ist wieder offen) oeffnet den Lauf als
 * exception_open, haengt eine Korrektur append-only an run.corrections und
 * legt eine NEUE Korrekturnotiz an. Die historische Finalnotiz bleibt
 * unveraendert. Neuer Eingang nach dem Abschluss ist KEIN Widerspruch —
 * er gehoert in den naechsten Lauf.
 * ═════════════════════════════════════════════════════════════════════════ */
import { QUELLEN, ABGESCHLOSSENE_ZUSTAENDE, effektiverZustand, validatePolicy, pruefeId } from "./assistant-schema.mjs";
import { klon, requireCore } from "./assistant-migration.mjs";
import { bump, notizBauen, quelleFinden } from "./assistant-buchhaltung.mjs";
import { dailyAssistantTrafficLight } from "./assistant-ampel.mjs";
import { istLokalDatum, isoAus, msAus, wandzeitZuMs, tagesEndeMs, datumPlusTage, assistentenTag } from "./assistant-zeit.mjs";

const fehler = (error, detail) => ({ ok: false, error, detail: detail == null ? null : detail });

function istKarte(v) { return v && typeof v === "object" && !Array.isArray(v); }

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

  for (const s of policy.closure.requiredReceipts) {
    const r = run.slotReceipts && run.slotReceipts[s];
    if (!r || !r.receiptId) maengel.push({ code: "RECEIPT_MISSING", detail: s });
  }

  const evaluation = dailyAssistantTrafficLight(run, data, now, policy);
  if (evaluation.coverage !== "green") maengel.push({ code: "COVERAGE_NOT_GREEN", detail: evaluation.reasons.filter((r) => r.axis === "coverage") });
  if (evaluation.operations !== "green") maengel.push({ code: "OPERATIONS_NOT_GREEN", detail: evaluation.reasons.filter((r) => r.axis === "operations") });

  return { ok: maengel.length === 0, blockers: maengel, evaluation, run };
}

/* Der Abschluss. Gibt bei Erfolg den neuen Bestand zurueck. */
export function closeRun(input, { date, finalNoteId }, ctx) {
  if (!ctx || typeof ctx.now !== "number") throw new TypeError("ctx.now (ms) fehlt");
  const data = klon(requireCore(input));
  const run = istKarte(data.dailyBriefing.assistantRuns[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return fehler("RUN_MISSING", date);

  // Idempotenz: bereits final → nichts tun, bestehende Notiz melden.
  if (run.phase === "final" && run.finalNoteId) {
    return { ok: true, data, already: true, finalNoteId: run.finalNoteId, run };
  }
  if (run.phase === "exception_open") return fehler("RUN_EXCEPTION_OPEN", { invalidatedAt: run.invalidatedAt });
  pruefeId(finalNoteId, "finalNoteId");

  const p = pruefeAbschluss(data, { date }, ctx);
  if (!p.ok) return { ok: false, error: "CLOSURE_BLOCKED", detail: p.blockers, evaluation: p.evaluation };

  data.entities.notes = istKarte(data.entities.notes) ? data.entities.notes : {};
  if (data.entities.notes[finalNoteId]) return fehler("NOTE_ID_TAKEN", finalNoteId);

  const nowIso = isoAus(ctx.now);
  const revision = bump(data, ctx.now);   // die Revision, die den Abschluss traegt

  // Ergebnis je Element zum Zeitpunkt des Abschlusses — das ist die
  // Vergleichsbasis fuer spaetere Widersprueche. Es werden nur
  // Zustandsnamen festgehalten, keine Kopien der Elemente.
  run.closureOutcomes = {};
  for (const ref of run.itemRefs) {
    const e = quelleFinden(data, ref.sourceType, ref.sourceId);
    if (!e) { run.closureOutcomes[ref.sourceType + ":" + ref.sourceId] = "missing"; continue; }
    if (QUELLEN[ref.sourceType]) {
      const z = effektiverZustand(ref.sourceType, e);
      run.closureOutcomes[ref.sourceType + ":" + ref.sourceId] = z.state || "unmapped";
    } else {
      run.closureOutcomes[ref.sourceType + ":" + ref.sourceId] = e.status || e.state || "open";
    }
  }

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
    `Elemente im Lauf: ${run.itemRefs.length}.`,
  ];
  for (const ref of run.itemRefs) zeilen.push(`- ${ref.sourceType}:${ref.sourceId} → ${run.closureOutcomes[ref.sourceType + ":" + ref.sourceId]}`);
  return zeilen.join("\n");
}

/* Widerspruch pruefen — ohne zu veraendern. Liefert die Elemente, die beim
 * Abschluss als abgeschlossen galten und es jetzt nicht mehr sind, sowie
 * den Eingang, der NACH dem Abschluss entstand (der gehoert in den
 * naechsten Lauf, nicht in diesen). */
export function pruefeWiderspruch(data, { date }, { now }) {
  const run = istKarte(data.dailyBriefing?.assistantRuns?.[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return { ok: false, error: "RUN_MISSING" };
  if (run.phase !== "final") return { ok: true, contradictions: [], newIntake: [], nextRunDate: null, final: false };
  const cutoff = msAus(run.closureCutoff);
  const widersprueche = [];
  for (const [key, outcome] of Object.entries(run.closureOutcomes || {})) {
    if (!ABGESCHLOSSENE_ZUSTAENDE.includes(outcome)) continue;
    const [sourceType, sourceId] = key.split(/:(.+)/);
    const e = quelleFinden(data, sourceType, sourceId);
    if (!e) { widersprueche.push({ sourceType, sourceId, was: outcome, now: "missing" }); continue; }
    const jetzt = QUELLEN[sourceType] ? (effektiverZustand(sourceType, e).state || "unmapped") : (e.status || "open");
    if (!ABGESCHLOSSENE_ZUSTAENDE.includes(jetzt)) widersprueche.push({ sourceType, sourceId, was: outcome, now: jetzt });
  }
  const neu = [];
  const a = data.automation || {};
  for (const [id, it] of Object.entries(a.intakeById || {})) {
    if (it && it.status === "open" && msAus(it.registeredAt) > cutoff) neu.push({ sourceType: "intake", sourceId: id });
  }
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    for (const [id, e] of Object.entries(data.entities[q.store] || {})) {
      if (!istKarte(e)) continue;
      const created = msAus(e.createdAt);
      if (Number.isFinite(created) && created > cutoff && !ABGESCHLOSSENE_ZUSTAENDE.includes(effektiverZustand(sourceType, e).state)) neu.push({ sourceType, sourceId: id });
    }
  }
  const nextRunDate = assistentenTag(Math.max(now, tagesEndeMs(date)));
  return { ok: true, final: true, contradictions: widersprueche, newIntake: neu, nextRunDate: nextRunDate === date ? datumPlusTage(date, 1) : nextRunDate };
}

/* Invalidierung: append-only, historische Finalnotiz bleibt. */
export function invalidateClosure(input, { date, correctionId, reason, contradiction }, ctx) {
  if (!ctx || typeof ctx.now !== "number") throw new TypeError("ctx.now (ms) fehlt");
  const data = klon(requireCore(input));
  const run = istKarte(data.dailyBriefing.assistantRuns[date]) ? data.dailyBriefing.assistantRuns[date] : null;
  if (!run) return fehler("RUN_MISSING", date);
  if (run.phase !== "final") return fehler("RUN_NOT_FINAL", run.phase);
  pruefeId(correctionId, "correctionId");
  if (!String(reason || "").trim()) return fehler("REASON_MISSING");
  if (!contradiction || !contradiction.sourceType || !contradiction.sourceId) return fehler("CONTRADICTION_MISSING");
  // Nur ein ECHTER Widerspruch invalidiert; neuer Eingang gehoert in den naechsten Lauf.
  const w = pruefeWiderspruch(data, { date }, ctx);
  const passt = w.contradictions.some((c) => c.sourceType === contradiction.sourceType && c.sourceId === contradiction.sourceId);
  if (!passt) return fehler("NOT_A_CONTRADICTION", { given: contradiction, found: w.contradictions, nextRunDate: w.nextRunDate });
  if ((run.corrections || []).some((c) => c.id === correctionId)) return { ok: true, data, already: true };

  data.entities.notes = istKarte(data.entities.notes) ? data.entities.notes : {};
  if (data.entities.notes[correctionId]) return fehler("NOTE_ID_TAKEN", correctionId);

  const nowIso = isoAus(ctx.now);
  const revision = bump(data, ctx.now);
  const korrektur = {
    id: correctionId, at: nowIso, revision, reason: String(reason).trim().slice(0, 500),
    contradiction: { sourceType: contradiction.sourceType, sourceId: contradiction.sourceId },
    invalidatedFinalNoteId: run.finalNoteId, invalidatedClosureRevision: run.closureRevision, invalidatedFinalAt: run.finalAt,
    correctionNoteId: correctionId,
  };
  run.corrections = [...(run.corrections || []), korrektur];
  run.phase = "exception_open";
  run.invalidatedAt = nowIso;
  run.revision = (Number(run.revision) || 0) + 1;
  run.updatedAt = nowIso;
  // finalNoteId, finalAt, closureRevision, closureCutoff bleiben als Historie stehen.
  data.entities.notes[correctionId] = notizBauen(correctionId, {
    title: `Tagesbriefing ${date} — Korrektur`,
    content: `Abschluss vom ${korrektur.invalidatedFinalAt} (Notiz ${korrektur.invalidatedFinalNoteId}, Revision ${korrektur.invalidatedClosureRevision}) widerrufen: ${korrektur.reason}\nWiderspruch: ${contradiction.sourceType}:${contradiction.sourceId}`,
    kind: "assistantCorrection", date, now: ctx.now,
  });
  return { ok: true, data, already: false, correction: korrektur };
}
