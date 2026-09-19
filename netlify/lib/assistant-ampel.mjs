/* ══ Tagesbriefing v3 — die Ampel ═══════════════════════════════════════════
 *
 *     dailyAssistantTrafficLight(run, data, now, policy)
 *
 * Reine Funktion. Prueft IMMER den vollstaendigen Bestand — nicht die
 * itemRefs des Laufs, nicht die Aussagen eines Agenten. Zwei Achsen:
 *
 *   coverage    Arbeitsabdeckung: sind alle aktuell machbaren oder faelligen
 *               Schritte abgeschlossen ODER nachweislich in echtem Warten?
 *   operations  Betriebsstatus: Policy vollstaendig, Quellen frisch und
 *               ohne Stoerung, Slots quittiert, Lauf konsistent?
 *
 * Jede Achse ist "green" | "yellow" | "red". Jeder nicht-gruene Befund
 * traegt einen Reason-Code mit Quell-Id. Fehlende oder unvollstaendige
 * Daten ergeben NIE gruen: fehlt der Lauf, die Policy oder eine Quelle, ist
 * die Ampel rot und sagt, was fehlt.
 *
 * Die Bewertung traegt evaluatedRevision, evaluatedFingerprint,
 * evaluatedAt und validUntil. validUntil ist der frueheste Zeitpunkt, an
 * dem sich das Urteil von selbst aendern kann: Ablauf einer Quelle, eine
 * Frist, ein followUpAt, die naechste Slotgrenze oder der Policy-TTL. Eine
 * Bewertung nach validUntil oder mit anderer Revision/anderem Fingerabdruck
 * ist ALT — isEvaluationCurrent() sagt das, eine alte Offlineansicht ist
 * deshalb nicht "aktuell gruen".
 * ═════════════════════════════════════════════════════════════════════════ */
import { createHash } from "node:crypto";
import {
  QUELLEN, WARTE_ZUSTAENDE, ABGESCHLOSSENE_ZUSTAENDE, effektiverZustand, rollenFuer,
  validatePolicy, sourceKey,
} from "./assistant-schema.mjs";
import { pruefeWarteEvidenz, quelleFinden } from "./assistant-buchhaltung.mjs";
import {
  assistentenTag, faelligeSlots, naechsteSlotGrenzeMs, isoAus, msAus, ZEIT, istLokalDatum,
} from "./assistant-zeit.mjs";

const RANG = { green: 0, yellow: 1, red: 2 };
function schlechter(a, b) { return RANG[a] >= RANG[b] ? a : b; }

/* Fingerabdruck des Bestands, soweit er das Urteil beeinflusst: Quell-
 * elemente mit Altstatus und updatedAt, Buchhaltungskarten mit Status.
 * Aendert ein Client irgendetwas daran, ist die alte Bewertung nicht mehr
 * aktuell — auch wenn dataRevision (nur Kernmutationen) gleich blieb. */
export function bestandsFingerabdruck(data) {
  const teile = [];
  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    const store = data.entities?.[q.store];
    if (!store || typeof store !== "object") continue;
    for (const id of Object.keys(store).sort()) {
      const e = store[id];
      if (!e || typeof e !== "object") continue;
      teile.push(sourceType, id, String(e[q.statusField] ?? ""), String(e.operationalState ?? ""), String(e.updatedAt ?? ""), String(e.dueDate ?? ""), String(e.readAt ?? ""));
    }
  }
  const p = data.entities?.projects;
  if (p && typeof p === "object") for (const id of Object.keys(p).sort()) {
    const pr = p[id];
    if (!pr || typeof pr !== "object") continue;
    teile.push("project", id, String(pr.status ?? ""), JSON.stringify((pr.deadlines || []).map((d) => [d.id, d.date, !!d.done])));
  }
  const a = data.automation || {};
  for (const k of ["intakeById", "questionsById", "answersById", "documentsById", "jobsById", "waitingById", "progressById", "sourceCursors"]) {
    const karte = a[k] || {};
    for (const id of Object.keys(karte).sort()) {
      const v = karte[id] || {};
      teile.push(k, id, String(v.status ?? v.state ?? v.outcome ?? ""), String(v.consumedAt ?? v.handledAt ?? v.checkedAt ?? v.followUpAt ?? ""), String(v.deferrals ?? ""), String(v.parse?.outcome ?? ""));
    }
  }
  return createHash("sha256").update(teile.join("\u0001")).digest("hex").slice(0, 32);
}

export function dailyAssistantTrafficLight(run, data, now, policy) {
  if (typeof now !== "number" || !Number.isFinite(now)) throw new TypeError("now (ms) fehlt");
  const reasons = [];
  let coverage = "green";
  let operations = "green";
  const grenzen = [];   // Kandidaten fuer validUntil
  const grund = (achse, code, sourceType, sourceId, detail, stufe = "red") => {
    reasons.push({ axis: achse, code, sourceType: sourceType || null, sourceId: sourceId || null, detail: detail == null ? null : detail, severity: stufe });
    if (achse === "coverage") coverage = schlechter(coverage, stufe); else operations = schlechter(operations, stufe);
  };
  const gezaehlt = { chatgptLeads: 0, chatgptTasks: 0, tasks: 0, projects: 0, intake: 0, questions: 0, answers: 0, documents: 0, jobs: 0, sources: 0 };

  // ── Grundlagen: Bestand, Policy, Lauf ──────────────────────────────────
  const bestandOk = data && typeof data === "object" && data.entities && typeof data.entities === "object";
  if (!bestandOk) grund("operations", "CORE_MISSING", null, null, "kein Bestand");
  const pv = validatePolicy(policy);
  if (!pv.ok) grund("operations", "POLICY_INCOMPLETE", null, null, pv.errors);
  const automation = bestandOk && data.automation && typeof data.automation === "object" ? data.automation : null;
  if (bestandOk && !automation) grund("operations", "CORE_NOT_MIGRATED", null, null, "automation fehlt");
  if (!run || typeof run !== "object" || !istLokalDatum(run.date)) grund("operations", "RUN_MISSING", null, null, "kein Lauf uebergeben");

  const heute = assistentenTag(now);
  const runDate = run && istLokalDatum(run.date) ? run.date : heute;
  if (run && istLokalDatum(run.date) && run.date !== heute) grund("operations", "RUN_DATE_MISMATCH", "run", run.id || run.date, { runDate: run.date, today: heute }, "yellow");

  // Behauptungen des Agenten am Lauf werden NICHT beruecksichtigt — nur sichtbar gemacht.
  if (run && typeof run === "object") {
    const behauptet = ["overallGreen", "agentReport", "claimedCoverage", "claimedOperations", "userApproval"].filter((k) => k in run);
    if (behauptet.length) grund("operations", "AGENT_CLAIM_IGNORED", "run", run.id || run.date, behauptet, "yellow");
    if (run.policyVersion && policy && policy.version && run.policyVersion !== policy.version) grund("operations", "RUN_POLICY_MISMATCH", "run", run.id || run.date, { run: run.policyVersion, policy: policy.version });
    if (run.phase === "exception_open") grund("operations", "RUN_EXCEPTION_OPEN", "run", run.id || run.date, run.invalidatedAt || null);
  }

  if (!bestandOk || !automation) {
    return abschluss();
  }

  // ── Slots: alle Slots, die heute bereits begonnen haben, brauchen eine Quittung ──
  if (run && istLokalDatum(run.date)) {
    for (const s of faelligeSlots(run.date, now)) {
      const r = run.slotReceipts && run.slotReceipts[s];
      if (!r || !r.receiptId) grund("operations", "SLOT_RECEIPT_MISSING", "run", run.id || run.date, s);
    }
  }
  grenzen.push(naechsteSlotGrenzeMs(now));

  // ── Quellen: alle erforderlichen Quellen geprueft, frisch, ohne Stoerung ──
  const maxAlter = (pv.ok ? policy.sourceMaxAgeMinutes : 15) * ZEIT.MINUTE;
  const sourceChecks = (run && run.sourceChecks && typeof run.sourceChecks === "object") ? run.sourceChecks : {};
  if (pv.ok) {
    for (const s of policy.requiredSources) {
      gezaehlt.sources++;
      const c = sourceChecks[s.id] || automation.sourceCursors?.[s.id] || null;
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

  // ── Lease ──
  const lease = automation.activeLease;
  if (lease && Number.isFinite(msAus(lease.expiresAt)) && msAus(lease.expiresAt) < now && run && run.phase === "active") {
    grund("operations", "LEASE_EXPIRED", "lease", lease.holder, lease.expiresAt, "yellow");
  }

  // ── Elemente: vollstaendiger Bestand ──
  const refs = new Set((run && Array.isArray(run.itemRefs) ? run.itemRefs : []).map((r) => r.sourceType + ":" + r.sourceId));
  const maxDeferrals = pv.ok ? policy.deferralLimit : 3;
  const offeneFragenJeQuelle = new Map();
  for (const q of Object.values(automation.questionsById || {})) {
    if (q && q.status === "open") offeneFragenJeQuelle.set(q.sourceType + ":" + q.sourceId, q.id);
  }

  const pruefeElement = (sourceType, id, e) => {
    const key = sourceKey(sourceType, id);
    const z = effektiverZustand(sourceType, e);
    if (z.unmapped) { grund("coverage", "UNKNOWN_LEGACY_STATE", sourceType, id, z.legacy.legacyValue); return; }
    if (z.inconsistent) grund("coverage", "STATE_CLAIM_INCONSISTENT", sourceType, id, { stored: z.stored, legacy: z.legacy.legacyValue });
    if (ABGESCHLOSSENE_ZUSTAENDE.includes(z.state)) return;

    // Faelligkeit / Zustaendigkeit: KI-Leads und ChatGPT-Aufgaben sind immer
    // Arbeit des Assistenten; regulaere Aufgaben nur, wenn sie faellig sind.
    let relevant = true;
    if (sourceType === "task") {
      const due = e.dueDate ? String(e.dueDate).slice(0, 10) : null;
      relevant = !!due && due <= runDate;
      if (due && due > runDate) grenzen.push(msAus(due + "T00:00:00Z"));
    }
    if (sourceType === "chatgptLead" && !e.readAt) grund("coverage", "INTAKE_UNCLARIFIED", sourceType, id, "Lead ungelesen");
    // Verschiebungen zaehlen unabhaengig von der Faelligkeit: wer eine Frist
    // dreimal nach hinten schiebt, ist damit nicht "noch nicht faellig".
    const progress = automation.progressById?.[key];
    if (progress && Number(progress.deferrals) >= maxDeferrals) grund("coverage", "DEFERRAL_LIMIT", sourceType, id, { deferrals: progress.deferrals, limit: maxDeferrals });
    if (!relevant) return;

    if (!refs.has(key)) grund("coverage", "ITEM_NOT_IN_RUN", sourceType, id, z.state, "red");

    const frage = offeneFragenJeQuelle.get(key);
    const rollen = rollenFuer(sourceType, e);
    if (sourceType === "chatgptLead" && !rollen.executor) grund("coverage", "LEAD_UNASSIGNED", sourceType, id, null);

    if (WARTE_ZUSTAENDE.includes(z.state)) {
      const w = automation.waitingById?.[key];
      if (!w) { grund("coverage", "WAITING_UNVERIFIED", sourceType, id, z.state); return; }
      if (w.state !== z.state) { grund("coverage", "WAITING_STATE_MISMATCH", sourceType, id, { waiting: w.state, item: z.state }); return; }
      const maengel = pruefeWarteEvidenz({ ...w, followUpAt: w.followUpAt }, { now: msAus(w.setAt) || now, policy: pv.ok ? policy : null, rollen });
      // Ein followUpAt in der Vergangenheit ist keine Unvollstaendigkeit, sondern eine faellige Nachfassung.
      const ohneFrist = maengel.filter((m) => m !== "WAIT_FOLLOWUP_PAST");
      if (ohneFrist.length) { grund("coverage", "WAITING_INCOMPLETE", sourceType, id, ohneFrist); return; }
      const fu = msAus(w.followUpAt);
      if (fu <= now) { grund("coverage", "FOLLOWUP_DUE", sourceType, id, w.followUpAt); return; }
      grenzen.push(fu);
      if (w.evidence.kind === "question") {
        const q = automation.questionsById?.[w.evidence.ref];
        if (!q) grund("coverage", "WAITING_EVIDENCE_MISSING", sourceType, id, w.evidence.ref);
        else if (q.status === "answered") grund("coverage", "ANSWER_UNCONSUMED", sourceType, id, q.answerId);
      }
      if (w.evidence.kind === "job") {
        const j = automation.jobsById?.[w.evidence.ref];
        if (!j) grund("coverage", "WAITING_EVIDENCE_MISSING", sourceType, id, w.evidence.ref);
        else if (j.state === "returned") grund("coverage", "JOB_RETURN_UNREVIEWED", sourceType, id, j.id);
        else if (j.state === "failed") grund("coverage", "JOB_FAILED", sourceType, id, j.error || j.id);
      }
      return;
    }
    if (z.state === "review") {
      if (frage) grund("coverage", "QUESTION_OPEN", sourceType, id, frage);
      else grund("coverage", "REVIEW_PENDING", sourceType, id, null);
      return;
    }
    // doing: aktuell machbar und nicht abgeschlossen → nicht gruen.
    if (frage) grund("coverage", "QUESTION_OPEN", sourceType, id, frage);
    grund("coverage", sourceType === "task" ? "TASK_DUE_OPEN" : "ITEM_OPEN", sourceType, id, z.state);
  };

  for (const [sourceType, q] of Object.entries(QUELLEN)) {
    const store = data.entities[q.store];
    if (!store || typeof store !== "object") continue;
    for (const [id, e] of Object.entries(store)) {
      if (!e || typeof e !== "object") continue;
      gezaehlt[q.store]++;
      pruefeElement(sourceType, id, e);
    }
  }

  // Projekte: faellige, nicht erledigte Fristen aktiver Projekte.
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

  // Eingang, Fragen, Antworten, Dokumente, Jobs — die Buchhaltungskarten.
  for (const [id, it] of Object.entries(automation.intakeById || {})) {
    gezaehlt.intake++;
    if (it && it.status === "open") grund("coverage", "INTAKE_UNCLARIFIED", "intake", id, it.channel || null);
  }
  for (const [id, q] of Object.entries(automation.questionsById || {})) {
    gezaehlt.questions++;
    if (!q) continue;
    if (q.status === "open") {
      // Fragen zu offenen Elementen meldet pruefeElement; hier bleiben die
      // Fragen zu abgeschlossenen oder verschwundenen Elementen — auch die
      // sind offen und sperren.
      const e = quelleFinden(data, q.sourceType, q.sourceId);
      const zu = e && QUELLEN[q.sourceType] ? effektiverZustand(q.sourceType, e) : null;
      if (!e || (zu && !zu.unmapped && ABGESCHLOSSENE_ZUSTAENDE.includes(zu.state))) grund("coverage", "QUESTION_OPEN", "question", id, q.sourceType + ":" + q.sourceId);
    }
  }
  for (const [id, a] of Object.entries(automation.answersById || {})) {
    gezaehlt.answers++;
    if (a && !a.consumedAt) grund("coverage", "ANSWER_UNCONSUMED", "answer", id, a.questionId);
  }
  for (const [id, d] of Object.entries(automation.documentsById || {})) {
    gezaehlt.documents++;
    if (!d || d.status !== "open") continue;
    const o = d.parse?.outcome;
    if (o === "parsed") grund("coverage", "DOCUMENT_UNHANDLED", "document", id, d.name || null);
    else if (o === "unreadable" || o === "failed") grund("coverage", "DOCUMENT_UNREADABLE", "document", id, d.parse?.error || o);
    else grund("coverage", "DOCUMENT_UNPROCESSED", "document", id, o || "pending");
  }
  for (const [id, j] of Object.entries(automation.jobsById || {})) {
    gezaehlt.jobs++;
    if (!j) continue;
    if (j.state === "returned" && !j.reviewedAt) grund("coverage", "JOB_RETURN_UNREVIEWED", "job", id, j.sourceType + ":" + j.sourceId);
    else if (j.state === "failed" && !j.reviewedAt) grund("coverage", "JOB_FAILED", "job", id, j.error || null);
    else if (j.state === "queued" || j.state === "running") grund("coverage", "JOB_PENDING", "job", id, j.state, "yellow");
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
      evaluatedRevision: automation ? (Number(automation.dataRevision) || 0) : null,
      evaluatedFingerprint: bestandOk ? bestandsFingerabdruck(data) : null,
      evaluatedAt: isoAus(now),
      validUntil: isoAus(validUntil),
      policyVersion: pv.ok ? policy.version : null,
    };
  }
}

/* Ist eine gespeicherte Bewertung noch aktuell? Nur dann darf eine
 * Oberflaeche sie als "jetzt gruen" zeigen. */
export function isEvaluationCurrent(evaluation, data, now) {
  if (!evaluation || typeof evaluation !== "object") return { current: false, reason: "EVALUATION_MISSING" };
  const bis = msAus(evaluation.validUntil);
  if (!Number.isFinite(bis) || bis <= now) return { current: false, reason: "EVALUATION_EXPIRED" };
  const rev = Number(data?.automation?.dataRevision) || 0;
  if (evaluation.evaluatedRevision !== rev) return { current: false, reason: "REVISION_CHANGED" };
  if (evaluation.evaluatedFingerprint !== bestandsFingerabdruck(data)) return { current: false, reason: "DATA_CHANGED" };
  return { current: true, reason: null };
}
