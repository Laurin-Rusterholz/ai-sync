/* ══ Tagesbriefing v3 — die Ampel ═══════════════════════════════════════════
 *
 *     dailyAssistantTrafficLight(run, data, now, policy)
 *
 * Reine, browserfaehige Funktion (kein node:crypto). Prueft IMMER den
 * vollstaendigen Bestand — nicht die itemRefs des Laufs, nicht die Aussagen
 * eines Agenten. Zwei Achsen:
 *
 *   coverage    Arbeitsabdeckung: alle aktuell machbaren oder faelligen
 *               Schritte abgeschlossen ODER nachweislich in echtem Warten?
 *   operations  Betriebsstatus: Policy vollstaendig, Quellen frisch und ohne
 *               Stoerung, Slots quittiert, Startnotiz da, Lauf konsistent?
 *
 * Stufen: green | yellow | red. Gelb = offen, aber nicht faellig (z. B. ein
 * Lead in Arbeit ohne Frist, ein laufender Job). Rot = faellig, verletzt,
 * unbelegt, unbekannt oder widerspruechlich. Nur GRUEN erlaubt den
 * Abschluss. Fehlende oder unvollstaendige Daten sind nie gruen.
 *
 * Jede Bewertung traegt evaluatedRevision, evaluatedFingerprint,
 * evaluatedAt und validUntil; isEvaluationCurrent() sagt, ob eine
 * gespeicherte Bewertung noch gilt (Ablauf, Revision, Bestand).
 * ═════════════════════════════════════════════════════════════════════════ */
import {
  QUELLEN, WARTE_ZUSTAENDE, ABGESCHLOSSENE_ZUSTAENDE, KARTEN_ZUSTAENDE, effektiverZustand, rollenFuer,
  validatePolicy, sourceKey, stringFingerprint, canonicalJson,
} from "./assistant-schema.mjs";
import { pruefeKernStruktur } from "./assistant-migration.mjs";
import { pruefeWarteKarte, quelleFinden, abschlussBelegPruefen } from "./assistant-buchhaltung.mjs";
import {
  assistentenTag, faelligeSlots, naechsteSlotGrenzeMs, isoAus, msAus, ZEIT, istLokalDatum,
} from "./assistant-zeit.mjs";

const RANG = { green: 0, yellow: 1, red: 2 };
function schlechter(a, b) { return RANG[a] >= RANG[b] ? a : b; }

/* Signatur ueber ALLES, was die Bewertung liest — als kanonisches JSON der
 * vollstaendigen Projektion, nicht als Handauswahl von Feldern: der ganze
 * Lauf, die Policy, alle Quellsammlungen, Projekte, die referenzierten
 * ChatGPT Notes und alle Buchhaltungskarten (ausser Ledger und Lease, die
 * der Kern nie liest). Aendert sich irgendetwas davon, ist eine gespeicherte
 * Bewertung nicht mehr aktuell. */
export function bewertungsProjektion(run, data, policy) {
  const e = data && typeof data === "object" && data.entities && typeof data.entities === "object" ? data.entities : {};
  const a = data && typeof data === "object" && data.automation && typeof data.automation === "object" ? data.automation : {};
  const notes = e.chatgptNotes && typeof e.chatgptNotes === "object" ? e.chatgptNotes : {};
  const referenziert = {};
  for (const id of [run && run.startNoteId, run && run.finalNoteId]) if (id) referenziert[id] = notes[id] === undefined ? null : notes[id];
  const automation = {};
  for (const k of Object.keys(a)) if (k !== "idempotencyByKey" && k !== "activeLease") automation[k] = a[k];
  const stores = {};
  for (const q of Object.values(QUELLEN)) stores[q.store] = e[q.store];
  stores.projects = e.projects;
  return { run: run === undefined ? null : run, policy: policy === undefined ? null : policy, stores, notes: referenziert, automation, structure: pruefeKernStruktur(data) };
}

export function bestandsFingerabdruck(run, data, policy) {
  return stringFingerprint(canonicalJson(bewertungsProjektion(run, data, policy)));
}

export function dailyAssistantTrafficLight(run, data, now, policy) {
  if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError("now (ms) fehlt");
  const reasons = [];
  let coverage = "green";
  let operations = "green";
  const grenzen = [];
  const grund = (achse, code, sourceType, sourceId, detail, stufe = "red") => {
    reasons.push({ axis: achse, code, sourceType: sourceType || null, sourceId: sourceId || null, detail: detail == null ? null : detail, severity: stufe });
    if (achse === "coverage") coverage = schlechter(coverage, stufe); else operations = schlechter(operations, stufe);
  };
  const gezaehlt = { chatgptLeads: 0, chatgptTasks: 0, tasks: 0, projects: 0, intake: 0, questions: 0, answers: 0, documents: 0, jobs: 0, evidence: 0, sources: 0 };

  // Struktur: jede fehlende oder korrupte Pflichtkarte, Revision oder jeder
  // kaputte Lauf ist ein eigener roter Befund — nichts wird uebersprungen,
  // nichts geworfen. Ein solcher Bestand ist nie gruen.
  const struktur = pruefeKernStruktur(data);
  for (const f of struktur) grund("operations", "CORE_INVALID", "core", f.path || null, f.code);
  const bestandOk = !struktur.some((f) => ["CORE_SHAPE", "CORE_NO_ENTITIES"].includes(f.code));
  const pv = validatePolicy(policy);
  if (!pv.ok) grund("operations", "POLICY_INCOMPLETE", null, null, pv.errors);
  const automation = bestandOk && data.automation && typeof data.automation === "object" && !Array.isArray(data.automation) ? data.automation : null;
  if (!run || typeof run !== "object" || !istLokalDatum(run.date)) grund("operations", "RUN_MISSING", null, null, "kein Lauf uebergeben");

  const heute = assistentenTag(now);
  const runDate = run && istLokalDatum(run.date) ? run.date : heute;
  if (run && istLokalDatum(run.date) && run.date !== heute) grund("operations", "RUN_DATE_MISMATCH", "run", run.id || run.date, { runDate: run.date, today: heute }, "yellow");

  if (run && typeof run === "object") {
    const behauptet = ["overallGreen", "agentReport", "claimedCoverage", "claimedOperations", "userApproval"].filter((k) => k in run);
    if (behauptet.length) grund("operations", "AGENT_CLAIM_IGNORED", "run", run.id || run.date, behauptet, "yellow");
    if (run.policyVersion && policy && policy.version && run.policyVersion !== policy.version) grund("operations", "RUN_POLICY_MISMATCH", "run", run.id || run.date, { run: run.policyVersion, policy: policy.version });
    if (run.phase === "exception_open") grund("operations", "RUN_EXCEPTION_OPEN", "run", run.id || run.date, run.invalidatedAt || null);
    if (istLokalDatum(run.date) && bestandOk) {
      const slots = faelligeSlots(run.date, now);
      const notes = data.entities.chatgptNotes && typeof data.entities.chatgptNotes === "object" ? data.entities.chatgptNotes : {};
      if (slots.includes("briefing04") && !(run.startNoteId && notes[run.startNoteId] && typeof notes[run.startNoteId] === "object")) grund("operations", "RUN_START_NOTE_MISSING", "run", run.id || run.date, run.startNoteId || null);
      for (const s of slots) {
        const r = run.slotReceipts && run.slotReceipts[s];
        if (!r || !r.receiptId) grund("operations", "SLOT_RECEIPT_MISSING", "run", run.id || run.date, s);
      }
    }
  }
  if (!bestandOk || !automation || struktur.length) return abschluss();
  grenzen.push(naechsteSlotGrenzeMs(now));

  // ── Quellen: jede erforderliche Quelle (inkl. Quantus-Kern) geprueft, frisch, ohne Stoerung ──
  const maxAlter = (pv.ok ? policy.sourceMaxAgeMinutes : 15) * ZEIT.MINUTE;
  const sourceChecks = run && run.sourceChecks && typeof run.sourceChecks === "object" ? run.sourceChecks : {};
  if (pv.ok) {
    for (const s of policy.requiredSources) {
      gezaehlt.sources++;
      const c = sourceChecks[s.id] || null;
      if (!c || !c.checkedAt) { grund("operations", "SOURCE_NOT_CHECKED", "source", s.id, s.kind); continue; }
      const t = msAus(c.checkedAt);
      if (!Number.isFinite(t) || t > now) { grund("operations", "SOURCE_CHECK_INVALID", "source", s.id, c.checkedAt); continue; }
      if (c.outcome === "auth_error") grund("operations", "SOURCE_AUTH_ERROR", "source", s.id, c.detail || null);
      else if (c.outcome === "budget_exceeded") grund("operations", "SOURCE_BUDGET_EXCEEDED", "source", s.id, c.detail || null);
      else if (c.outcome === "unreachable") grund("operations", "SOURCE_UNREACHABLE", "source", s.id, c.detail || null);
      else if (c.outcome === "partial") grund("operations", "SOURCE_PARTIAL", "source", s.id, c.detail || null, "yellow");
      else if (c.outcome !== "ok") grund("operations", "SOURCE_OUTCOME_UNKNOWN", "source", s.id, c.outcome);
      if (now - t > maxAlter) grund("operations", "SOURCE_STALE", "source", s.id, { checkedAt: c.checkedAt, maxAgeMinutes: maxAlter / ZEIT.MINUTE });
      else grenzen.push(t + maxAlter);
    }
  }

  // ── Elemente: vollstaendiger Bestand ──
  const refs = new Set((run && Array.isArray(run.itemRefs) ? run.itemRefs : []).map((r) => r.sourceType + ":" + r.sourceId));
  const maxDeferrals = pv.ok ? policy.deferralLimit : 3;
  const offeneFragen = new Map();
  for (const [qid, q] of Object.entries(automation.questionsById || {})) if (q && q.status === "open") offeneFragen.set(q.sourceType + ":" + q.sourceId, qid);

  const pruefeElement = (sourceType, id, e) => {
    const key = sourceKey(sourceType, id);
    const z = effektiverZustand(sourceType, e);
    if (z.unmigrated) { grund("coverage", "NOT_MIGRATED", sourceType, id, z.legacyNow); return; }
    if (z.unmapped) { grund("coverage", z.reason === "unknown" ? "UNKNOWN_LEGACY_STATE" : "AMBIGUOUS_LEGACY_STATE", sourceType, id, z.legacyNow); return; }
    if (z.versionInvalid) grund("coverage", "STATE_VERSION_INVALID", sourceType, id, null);
    if (z.drift) grund("coverage", "LEGACY_DRIFT", sourceType, id, z.drift);
    if (ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) {
      // Abgeschlossen ist nur gruen, wenn der gebundene Abschlussbeleg LIVE
      // im Bestand steht und unveraendert ist (Migration und Nutzer-
      // Selbsterledigung sind eigene, klar benannte Herkuenfte).
      const ab = abschlussBelegPruefen(data, sourceType, id, e);
      if (!ab.ok) grund("coverage", ab.code === "CLOSURE_UNPROVEN" ? "STATE_CLAIM_UNPROVEN" : ab.code, sourceType, id, { origin: ab.origin, detail: ab.detail || null });
      return;
    }

    // Faelligkeit: harte Frist einer Aufgabe; KI-Leads und ChatGPT-Aufgaben sind stets Arbeit des Assistenten.
    const due = sourceType === "task" && e.dueDate ? String(e.dueDate).slice(0, 10) : null;
    const faellig = !!due && due <= runDate;
    if (due && !faellig) grenzen.push(msAus(due + "T00:00:00Z"));
    const assistentenArbeit = sourceType !== "task";
    if (sourceType === "chatgptLead" && !e.readAt) grund("coverage", "INTAKE_UNCLARIFIED", sourceType, id, "Lead ungelesen");

    const progress = automation.progressById?.[key];
    if (progress && Number(progress.deferrals) >= maxDeferrals) grund("coverage", "DEFERRAL_LIMIT", sourceType, id, { deferrals: progress.deferrals, limit: maxDeferrals });
    // Eine Nutzeraufgabe, die noch nicht faellig ist, ist heute kein
    // machbarer Schritt des Assistenten: kein Befund (Grenze fuer validUntil
    // ist gesetzt). Alles Weitere gilt fuer Assistentenarbeit und Faelliges.
    if (!assistentenArbeit && !faellig) return;
    if (!refs.has(key)) grund("coverage", "ITEM_NOT_IN_RUN", sourceType, id, z.state);

    const frage = offeneFragen.get(key);
    const rollen = rollenFuer(sourceType, e);
    if (!rollen.explicit) grund("coverage", "ROLES_MISSING", sourceType, id, null);
    if (sourceType === "chatgptLead" && !rollen.executor) grund("coverage", "LEAD_UNASSIGNED", sourceType, id, null, "yellow");

    if (WARTE_ZUSTAENDE.includes(z.state)) {
      const w = automation.waitingById?.[key];
      if (!w) { grund("coverage", "WAITING_UNVERIFIED", sourceType, id, z.state); return; }
      if (w.state !== z.state) { grund("coverage", "WAITING_STATE_MISMATCH", sourceType, id, { waiting: w.state, item: z.state }); return; }
      const pr = pruefeWarteKarte(data, sourceType, id, w, { now, policy: pv.ok ? policy : null, rollen });
      if (pr.maengel.length) { grund("coverage", "WAITING_INCOMPLETE", sourceType, id, pr.maengel); return; }
      // Eine offene Frage sperrt auch ein wartendes Element — ausser sie IST der Beleg des Wartens auf den Nutzer.
      if (frage && !(w.evidence.kind === "question" && w.evidence.questionId === frage)) grund("coverage", "QUESTION_OPEN", sourceType, id, frage);
      if (faellig) grund("coverage", "HARD_DEADLINE_DUE", sourceType, id, due);
      const fu = msAus(w.followUpAt);
      if (fu <= now) { grund("coverage", "FOLLOWUP_DUE", sourceType, id, w.followUpAt); return; }
      grenzen.push(fu);
      if (w.evidence.kind === "question") {
        const q = automation.questionsById[w.evidence.questionId];
        if (q.status === "answered") grund("coverage", "ANSWER_UNCONSUMED", sourceType, id, q.answerId);
      }
      if (w.evidence.kind === "job") {
        const j = automation.jobsById[w.evidence.jobId];
        if (msAus(j.expiresAt) <= now) grund("coverage", "JOB_EXPIRED", sourceType, id, j.id);
        else grenzen.push(msAus(j.expiresAt));
      }
      return;
    }
    if (frage) grund("coverage", "QUESTION_OPEN", sourceType, id, frage);
    const stufe = faellig ? "red" : "yellow";
    if (z.state === "review") { grund("coverage", faellig ? "REVIEW_DUE" : "REVIEW_PENDING", sourceType, id, due, stufe); return; }
    grund("coverage", faellig ? "ITEM_DUE_OPEN" : "ITEM_OPEN", sourceType, id, due || z.state, stufe);
  };

  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    const store = data.entities[q.store];
    if (!store || typeof store !== "object") continue;
    for (const [id, e] of Object.entries(store)) {
      gezaehlt[q.store]++;
      if (!e || typeof e !== "object") { grund("coverage", "ENTITY_CORRUPT", sourceType, id, null); continue; }
      pruefeElement(sourceType, id, e);
    }
  }

  for (const [id, p] of Object.entries(data.entities.projects || {})) {
    if (!p || typeof p !== "object") continue;
    gezaehlt.projects++;
    if (["done", "archived"].includes(p.status)) continue;
    for (const d of Array.isArray(p.deadlines) ? p.deadlines : []) {
      if (!d || d.done || !d.date) continue;
      const tag = String(d.date).slice(0, 10);
      if (tag <= runDate) grund("coverage", "PROJECT_DEADLINE_DUE", "project", id, { deadlineId: d.id || null, date: tag });
      else grenzen.push(msAus(tag + "T00:00:00Z"));
    }
  }

  // ── Buchhaltungskarten: unbekannte Zustaende sind rot, nie uebersprungen ──
  const karteOk = (art, v) => v && typeof v === "object" && KARTEN_ZUSTAENDE[art].includes(v.status ?? v.state);
  for (const [id, it] of Object.entries(automation.intakeById || {})) {
    gezaehlt.intake++;
    if (!karteOk("intake", it)) { grund("coverage", "CARD_STATE_UNKNOWN", "intake", id, it && it.status); continue; }
    if (it.status === "open") grund("coverage", "INTAKE_UNCLARIFIED", "intake", id, it.channel || null);
  }
  for (const [id, q] of Object.entries(automation.questionsById || {})) {
    gezaehlt.questions++;
    if (!karteOk("question", q)) { grund("coverage", "CARD_STATE_UNKNOWN", "question", id, q && q.status); continue; }
    if (q.status !== "open") continue;
    const e = quelleFinden(data, q.sourceType, q.sourceId);
    const zu = e && QUELLEN[q.sourceType] ? effektiverZustand(q.sourceType, e) : null;
    if (!e || (zu && !zu.unmigrated && !zu.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(zu.state))) grund("coverage", "QUESTION_OPEN", "question", id, q.sourceType + ":" + q.sourceId);
  }
  for (const [id, a] of Object.entries(automation.answersById || {})) {
    gezaehlt.answers++;
    if (!a || typeof a !== "object" || typeof a.text !== "string") { grund("coverage", "CARD_STATE_UNKNOWN", "answer", id, null); continue; }
    if (!a.consumedAt) grund("coverage", "ANSWER_UNCONSUMED", "answer", id, a.questionId);
  }
  for (const [id, d] of Object.entries(automation.documentsById || {})) {
    gezaehlt.documents++;
    if (!karteOk("document", d)) { grund("coverage", "CARD_STATE_UNKNOWN", "document", id, d && d.status); continue; }
    if (d.status !== "open") continue;
    const o = d.parse?.outcome;
    if (o === "parsed") grund("coverage", "DOCUMENT_UNHANDLED", "document", id, d.name || null);
    else if (o === "unreadable" || o === "failed") grund("coverage", "DOCUMENT_UNREADABLE", "document", id, d.parse?.error || o);
    else grund("coverage", "DOCUMENT_UNPROCESSED", "document", id, o || "pending");
  }
  for (const [id, j] of Object.entries(automation.jobsById || {})) {
    gezaehlt.jobs++;
    if (!karteOk("job", j)) { grund("coverage", "CARD_STATE_UNKNOWN", "job", id, j && j.state); continue; }
    if (j.state === "returned" && !j.review) grund("coverage", "JOB_RETURN_UNREVIEWED", "job", id, j.sourceType + ":" + j.sourceId);
    else if (j.state === "failed" && !j.review) grund("coverage", "JOB_FAILED", "job", id, j.error || null);
    else if (["queued", "running"].includes(j.state)) {
      if (msAus(j.expiresAt) <= now) grund("coverage", "JOB_EXPIRED", "job", id, j.expiresAt);
      else { grund("coverage", "JOB_PENDING", "job", id, j.state, "yellow"); grenzen.push(msAus(j.expiresAt)); }
    }
  }
  for (const [id, ev] of Object.entries(automation.evidenceById || {})) {
    gezaehlt.evidence++;
    if (!ev || typeof ev !== "object" || !ev.sourceType || !ev.sourceId || !ev.fingerprint) grund("coverage", "CARD_STATE_UNKNOWN", "evidence", id, null);
  }
  // Wartekarten ohne passendes Element oder ohne Wartezustand am Element sind Leichen.
  for (const [key, w] of Object.entries(automation.waitingById || {})) {
    const [sourceType, sourceId] = key.split(/:(.+)/);
    const e = QUELLEN[sourceType] ? quelleFinden(data, sourceType, sourceId) : null;
    const z = e ? effektiverZustand(sourceType, e) : null;
    if (!e || !z || !WARTE_ZUSTAENDE.includes(z.state) || !w || w.state !== z.state) grund("coverage", "WAITING_CARD_ORPHAN", sourceType, sourceId, w && w.state);
  }

  return abschluss();

  function abschluss() {
    const ttl = (pv.ok ? policy.evaluationTtlMinutes : 5) * ZEIT.MINUTE;
    const kandidaten = grenzen.filter((g) => Number.isFinite(g) && g > now);
    const validUntil = Math.min(now + ttl, ...kandidaten);
    return {
      coverage, operations,
      overall: schlechter(coverage, operations),
      reasons,
      counted: gezaehlt,
      runDate: run && istLokalDatum(run.date) ? run.date : null,
      runPhase: run && run.phase ? run.phase : null,
      evaluatedRevision: automation && Number.isSafeInteger(automation.dataRevision) && automation.dataRevision >= 0 ? automation.dataRevision : null,
      evaluatedFingerprint: bestandsFingerabdruck(run, data, policy),
      structureErrors: struktur,
      evaluatedAt: isoAus(now),
      validUntil: isoAus(validUntil),
      policyVersion: pv.ok ? policy.version : null,
    };
  }
}

/* Gilt eine gespeicherte Bewertung noch? Nur wenn sie nicht abgelaufen ist,
 * die Revision gleich blieb, der Bestand strukturell gueltig ist UND die
 * vollstaendige Projektion (Lauf, Policy, Sammlungen, Karten, Notes)
 * byteidentisch signiert. Ohne Lauf oder Policy: nie aktuell. */
export function isEvaluationCurrent(evaluation, { run, data, now, policy } = {}) {
  if (!evaluation || typeof evaluation !== "object") return { current: false, reason: "EVALUATION_MISSING" };
  if (typeof now !== "number" || !Number.isFinite(now)) return { current: false, reason: "NOW_MISSING" };
  if (!run || typeof run !== "object" || !validatePolicy(policy).ok) return { current: false, reason: "CONTEXT_MISSING" };
  if (evaluation.overall !== "green" && evaluation.overall !== "yellow" && evaluation.overall !== "red") return { current: false, reason: "EVALUATION_INVALID" };
  const bis = msAus(evaluation.validUntil);
  const seit = msAus(evaluation.evaluatedAt);
  if (!Number.isFinite(bis) || !Number.isFinite(seit) || bis <= now || seit > now) return { current: false, reason: "EVALUATION_EXPIRED" };
  if (pruefeKernStruktur(data).length) return { current: false, reason: "CORE_INVALID" };
  if (!Number.isSafeInteger(evaluation.evaluatedRevision) || evaluation.evaluatedRevision !== data.automation.dataRevision) return { current: false, reason: "REVISION_CHANGED" };
  if (evaluation.policyVersion !== policy.version) return { current: false, reason: "POLICY_CHANGED" };
  if (evaluation.evaluatedFingerprint !== bestandsFingerabdruck(run, data, policy)) return { current: false, reason: "DATA_CHANGED" };
  return { current: true, reason: null };
}
