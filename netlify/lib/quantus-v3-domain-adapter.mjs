/* ══ Quantus v3 — Paket C3a: der kanonische Domaenen-Adapter fuer C2 ═════════
 *
 * C2 (quantus-v3-service.mjs) kennt Verben, Ressourcen, Anker, Rechte und
 * Versionen — aber keinen Bestand. Dieser Adapter ist die EINZIGE Bruecke
 * zwischen der C2-Kette und dem echten Kern aus Paket B:
 *
 *     entities.chatgptLeads / chatgptTasks / tasks     → lead / task
 *     automation.intakeById / questionsById /
 *       answersById / documentsById / jobsById        → intake / question /
 *                                                        briefing_answer /
 *                                                        document / assignment
 *     dailyBriefing.assistantRuns[date]               → run / run_context /
 *                                                        run_status / briefing
 *     chatgptLeads[*].comments, tasks[*].comments     → note
 *     serverseitige Tagesbriefing-Policy              → policy
 *
 * Es gibt KEINEN Ersatzbestand. Was nicht aus dem Kern kommt, kommt aus der
 * serverseitigen Konfiguration (Mandant, Eigentuemer, Policy) — nie aus dem
 * Anfragetext.
 *
 * Vertrag (C3b, 4379061): genau eine benannte Fabrik
 *
 *     createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now })
 *       → { resolveTarget, assertActiveBinding, applyVerb, loadObject, listPage }
 *
 * Die Fabrik braucht ausserdem die ECHTE Tagesbriefing-Policy (Paket B) und
 * den Eigentuemer des Haushalts — ueber `ports` (Integration, Tests) oder
 * Umgebungsvariablen (DOMAIN_PORT_VARS). Fehlt eines, wirft die Fabrik einen
 * Fehler mit Status 503 und benanntem Grund. Die E1-Laufzeit
 * (quantus-v3-runtime-state.mjs) ist statisch gebunden: Lease und Fencing
 * werden hier nur BENUTZT, nie nachgebaut.
 *
 * Grundsaetze:
 *   • Jede Wirkung ist genau EIN Kern-Kommando (B.commandReducer → applyCommand
 *     mit allen Kern-Invarianten) oder ein E1-Aufruf. Zeit und Kennung kommen
 *     ausschliesslich aus dem vorbereiteten Umschlag (prepared).
 *   • Bindung je CAS-Versuch: resolveTarget/assertActiveBinding werden vom
 *     Dienst in jedem Versuch neu aufgerufen — auch vor einer Wiederholung.
 *     Die Leitung muss ihre Lease MITFUEHREN (Umschlagfeld lease{holder,
 *     fence}); geprueft wird sie durch E1.checkLeadership, nie aus der
 *     gespeicherten Lease „ersetzt".
 *   • Ein Spezialist ist an GENAU EINEN Auftrag gebunden (Ausweis-jobId =
 *     Auftragskennung): aktiv, nicht abgelaufen, sein Executor, Quellversion
 *     akzeptiert — beim Schreiben UND beim Lesen. Keine Vereinigung aller
 *     Auftraege seines Executors.
 *   • Lesen liefert Projektionen, nie den Rohbestand; Seiten sind stabil
 *     sortiert, hasMore ist wahr, eine unbekannte Fortsetzungsmarke bricht ab.
 *     GET schreibt nie. Ein kaputter Kern ist eine kontrollierte 503.
 *   • Kennungen werden nicht umcodiert: das Kennungsalphabet von C2 ist das
 *     des Kerns (mit Doppelpunkt); nur Punkt und `__` bleiben draussen.
 * ═══════════════════════════════════════════════════════════════════════ */

import * as B from "./assistant-core.mjs";
import * as E1 from "./quantus-v3-runtime-state.mjs";

export const ADAPTER_VERSION = "quantus-v3-domain-adapter/2.0.0";

export const DOMAIN_PORT_VARS = Object.freeze({
  policyJson: "QUANTUS_V3_TAGESBRIEFING_POLICY_JSON",   // die B-Policy (tagesbriefing-policy/3) als JSON
  ownerUid: "QUANTUS_V3_OWNER_UID",                    // Firebase-UID des Haushaltseigentuemers
});

/* C2-Rollen → B-Akteure. Rollen kommen aus dem gepruefeten Ausweis (C1). */
export const ROLE_ACTOR_KIND = Object.freeze({
  user: "user", lead_agent: "agent", specialist_claude: "worker", specialist_gemini: "worker",
  scheduler: "system", backend_checker: "system",
});
const ROLE_EXECUTOR = Object.freeze({ specialist_claude: "claude", specialist_gemini: "gemini" });
const SLOT_VON_C2 = Object.freeze({ "04:00": "briefing04", "09:00": "process09", "14:00": "continue14", "23:00": "close23" });

/* Die 23 Verben und ihr Kern-/E1-Kommando. Keine Luecken. */
export const VERB_BINDINGS = Object.freeze({
  "intake.create":          "registerIntake",
  "intake.accept":          "transitionState",
  "task.create":            "createTask",
  "lead.comment":           "addComment",
  "lead.transition":        "transitionState",
  "lead.schedule":          "setWaiting",
  "briefing.answer":        "recordAnswer",
  "briefing.consumeAnswer": "consumeAnswer",
  "question.create":        "askQuestion",
  "question.resolve":       "recordAnswer",
  "document.register":      "registerDocument",
  "document.processed":     "recordDocumentParse",
  "worker.assign":          "createJob",
  "worker.return":          "recordJobReturn",
  "worker.review":          "reviewJobResult",
  "run.ensure":             "ensureRunSlot",
  "run.claim":              "E1.acquireLease",
  "run.renew":              "E1.renewLease",
  "run.checkpoint":         "recordRunCheckpoint",
  "run.finalize":           "closeRun | recordRunEvent",
  "note.append":            "appendRunNote",
  "run.log":                "recordRunEvent",
  "run.sourceCheck":        "recordSourceCheck",
});

/* ── Kleinkram ─────────────────────────────────────────────────────────── */
const CODE_RE = /^[A-Za-z0-9_:.,\-]{1,160}$/;
function istKarte(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
const nachId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const nachText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* Fehler in der Form, die C2 (fehlerAntwort/STATUS_BY_CODE) versteht. */
function fail(code, reason, status) {
  const err = new Error(reason || code);
  err.code = code; err.reason = reason || code; err.status = status;
  return err;
}
const port503 = (reason) => fail("auth_not_configured", reason, 503);

/* B-Ablehnung (aus commandReducer) → C2-Code; der B-Code steht in reason,
 * Details nur, wenn sie selbst Codes sind (nie Nutzertext). */
function uebersetzeB(err) {
  const code = String(err?.code || "");
  const detail = err?.detail;
  let zusatz = "";
  if (typeof detail === "string" && CODE_RE.test(detail)) zusatz = ":" + detail;
  else if (Array.isArray(detail) && detail.length && detail.every((d) => typeof d === "string" && CODE_RE.test(d))) zusatz = ":" + detail.slice(0, 8).join(",");
  const reason = (code || "domain_rejected") + zusatz;
  if (err?.status === 503 || code.startsWith("CORE_")) return fail("core_invalid", reason, 503);
  if (err?.status === 409) return fail("domain_conflict", reason, 409);
  if (err?.status === 500 || code === "invalid_transaction_context") return fail("core_invalid", reason, 503);
  return fail("invalid_request", reason, 400);
}
/* E1-Ausnahme (RuntimeStateError) → C2-Code. */
function uebersetzeE1(err) {
  const code = "runtime:" + String(err?.code || "runtime_error");
  const status = Number(err?.status) || 500;
  if (status >= 500) return fail("core_invalid", code, 503);
  if (status === 409) return fail("domain_conflict", code, 409);
  return fail("invalid_request", code, 400);
}
/* Kern-Fehler beim Lesen → kontrollierte 503. */
function kernLesen(snapshot) {
  try { return B.requireCore(snapshot); } catch (e) { throw fail("core_invalid", String(e?.code || "CORE_INVALID"), 503); }
}

/* Kartenversion: Buchhaltungskarten tragen keinen Zaehler; ihre Version ist
 * die Projektion ihres Inhalts (48-Bit-Ganzzahl aus dem Fingerabdruck). */
function kartenVersion(karte) {
  return 1 + parseInt(B.stringFingerprint(B.canonicalJson(karte)).slice(0, 12), 16);
}
/* Kennung fuer eine neue Karte, wenn der Umschlag keine mitbringt:
 * deterministisch aus Mandant, Ausweis, Lauf, Verb und Nutzlast. */
function abgeleiteteId(praefix, { tenant, principal, command }) {
  return praefix + "_" + B.stringFingerprint(B.canonicalJson({ tenant, principal: principal.id, jobId: command.jobId, verb: command.verb, payload: command.payload }));
}

function laeufe(data) {
  return Object.values(data.dailyBriefing.assistantRuns).filter(istKarte).sort((a, b) => nachText(String(b.date), String(a.date)));
}
function laufNachId(data, id) { return laeufe(data).find((r) => r.id === id) || null; }
function laufNachDatum(data, date) { const r = data.dailyBriefing.assistantRuns[date]; return istKarte(r) ? r : null; }
function laufFuerQuelle(data, sourceType, sourceId) {
  const r = laeufe(data).find((x) => Array.isArray(x.itemRefs) && x.itemRefs.some((ref) => ref && ref.sourceType === sourceType && ref.sourceId === sourceId));
  return r ? r.id : null;
}
function laufFuerJob(data, job) {
  const ms = B.msAus(job && job.createdAt);
  if (!Number.isFinite(ms)) return null;
  const r = laufNachDatum(data, B.assistentenTag(ms));
  return r ? r.id : null;
}
function letzterSlot(run) {
  let slot = null;
  for (const k of B.SLOT_KEYS) if (run.slotReceipts && run.slotReceipts[k] && run.slotReceipts[k].receiptId) slot = k;
  return slot;
}
/* Aktiver Auftrag eines Executors: existiert, sein Executor, aktiv, nicht
 * abgelaufen, Quellversion noch akzeptiert. Sonst der Grund. */
function auftragPruefen(data, jobId, executor, nowMs) {
  const j = data.automation.jobsById[String(jobId || "")];
  if (!istKarte(j)) return { ok: false, reason: "assignment_not_found" };
  if (j.executor !== executor) return { ok: false, reason: "assignment_foreign_executor" };
  if (!["queued", "running"].includes(j.state)) return { ok: false, reason: "assignment_not_active:" + String(j.state) };
  const ablauf = B.msAus(j.expiresAt);
  if (!Number.isFinite(ablauf) || ablauf <= nowMs) return { ok: false, reason: "assignment_expired" };
  const e = B.quelleFinden(data, j.sourceType, j.sourceId);
  if (!e) return { ok: false, reason: "assignment_source_missing" };
  const z = B.effektiverZustand(j.sourceType, e);
  if (!(j.acceptedVersions || [j.inputVersion]).includes(z.version)) return { ok: false, reason: "assignment_stale_source" };
  return { ok: true, job: j };
}

/* ══ Die Fabrik ══════════════════════════════════════════════════════════ */
export function createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now, ports = {} } = {}) {
  const read = typeof ports.read === "function" ? ports.read : (name) => (typeof process !== "undefined" && process.env ? process.env[name] : undefined);
  const pv = String(policyVersion || "").trim();
  if (!pv) throw port503("domain_policy_version_missing");
  const tenant = String(tenantId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw port503("domain_tenant_missing");
  const modus = String(mode || "").trim();
  if (modus !== "dry_run" && modus !== "enforce") throw port503("domain_mode_invalid");
  if (typeof now !== "function") throw port503("domain_clock_missing");

  let policy = ports.policy;
  if (policy === undefined) {
    const roh = String(read(DOMAIN_PORT_VARS.policyJson) || "").trim();
    if (!roh) throw port503("domain_policy_missing:" + DOMAIN_PORT_VARS.policyJson);
    try { policy = JSON.parse(roh); } catch { throw port503("domain_policy_unparsable:" + DOMAIN_PORT_VARS.policyJson); }
  }
  const pvCheck = B.validatePolicy(policy);
  if (!pvCheck.ok) throw port503("domain_policy_invalid:" + pvCheck.errors.slice(0, 6).join(","));
  if (policy.version !== pv) throw port503("domain_policy_version_mismatch");
  if (policy.tenant !== tenant) throw port503("domain_policy_tenant_mismatch");
  const ownerId = String(ports.ownerId !== undefined ? ports.ownerId : (read(DOMAIN_PORT_VARS.ownerUid) || "")).trim();
  if (!ownerId) throw port503("domain_owner_missing:" + DOMAIN_PORT_VARS.ownerUid);
  for (const m of ["acquireLease", "renewLease", "checkLeadership", "readRuntime"]) if (typeof E1[m] !== "function") throw port503("domain_runtime_state_port_missing");

  const POLICY = Object.freeze(structuredClone(policy));
  const basis = (kind, id, extra) => ({ kind, id, tenant, ownerId, ...extra });

  /* ── Projektionen ─────────────────────────────────────────────────── */
  function leaseFuerLauf(data, run) {
    try {
      E1.readRuntime(data);
      const l = data.automation.activeLease;
      if (!istKarte(l) || typeof l.scope !== "string") return null;
      const teile = l.scope.split(":");
      if (teile.length !== 4 || teile[0] !== tenant || teile[1] !== run.date) return null;
      return { holder: l.holder, expiresAt: Number.isSafeInteger(l.expiresAtMs) ? B.isoAus(l.expiresAtMs) : null, fence: l.fence, scope: l.scope };
    } catch { return null; }
  }
  const laufObjekt = (data, run) => basis("run", run.id, {
    jobId: run.id, date: run.date, slot: letzterSlot(run), state: run.phase,
    entityVersion: Number.isInteger(run.revision) ? run.revision : 0,
    createdAt: run.createdAt || null, updatedAt: run.updatedAt || null,
    leaseExpiresAt: (leaseFuerLauf(data, run) || {}).expiresAt || null,
  });
  const briefingObjekt = (data, run) => basis("briefing", run.id, { jobId: run.id, date: run.date, state: run.phase, entityVersion: Number.isInteger(run.revision) ? run.revision : 0, updatedAt: run.updatedAt || null });
  const laufKontextScope = (data, run, jobId) => basis("run_context", run.id, { runId: run.id, jobId, entityVersion: Number.isInteger(run.revision) ? run.revision : 0 });
  function laufStatusObjekt(data, run) {
    const jetzt = now();
    let bewertung;
    const cache = istKarte(run.finalEvaluation) ? run.finalEvaluation : null;
    if (cache && B.isEvaluationCurrent(cache, { run, data, now: jetzt, policy: POLICY }).current === true) bewertung = { coverage: cache.coverage, operations: cache.operations, cached: true };
    else { const e = B.dailyAssistantTrafficLight(run, data, jetzt, POLICY); bewertung = { coverage: e.coverage, operations: e.operations, cached: false }; }
    const offeneFragen = Object.values(data.automation.questionsById).filter((q) => istKarte(q) && q.status === "open"
      && (q.runDate === run.date || (Array.isArray(run.itemRefs) && run.itemRefs.some((r) => r && r.sourceType === q.sourceType && r.sourceId === q.sourceId)))).length;
    return basis("run_status", "status_" + run.date, {
      runId: run.id, jobId: run.id, state: run.phase, stage: run.lastCheckpoint ? run.lastCheckpoint.stage : letzterSlot(run),
      entityVersion: Number.isInteger(run.revision) ? run.revision : 0, updatedAt: run.updatedAt || null,
      openQuestions: offeneFragen,
      blocked: run.phase === "exception_open" || bewertung.coverage !== "green" || bewertung.operations !== "green",
      coverage: bewertung.coverage, operations: bewertung.operations, evaluationCached: bewertung.cached,
    });
  }
  function quellObjekt(data, kind, sourceType, id) {
    const e = B.quelleFinden(data, sourceType, id);
    if (!e) return null;
    const z = B.effektiverZustand(sourceType, e);
    const warte = data.automation.waitingById[sourceType + ":" + id] || null;
    const offeneFrage = Object.values(data.automation.questionsById).find((q) => istKarte(q) && q.status === "open" && q.sourceType === sourceType && q.sourceId === id) || null;
    return basis(kind, id, {
      sourceType, jobId: laufFuerQuelle(data, sourceType, id),
      title: sourceType === "chatgptTask" ? String(e.text || "") : String(e.title || ""),
      state: z.unmigrated ? "unmigrated" : z.unmapped ? "unmapped" : z.state,
      entityVersion: z.unmigrated || z.versionInvalid ? null : z.version, updatedAt: e.updatedAt || null,
      waitUntil: warte ? warte.followUpAt : null, openQuestionId: offeneFrage ? offeneFrage.id : null,
      dueAt: sourceType === "task" && e.dueDate ? String(e.dueDate).slice(0, 10) : null,
      leadId: sourceType === "chatgptLead" ? id : (Array.isArray(e.linkedChatgptLeads) && e.linkedChatgptLeads.length ? String(e.linkedChatgptLeads[0]) : null),
    });
  }
  const leadObjekt = (data, id) => quellObjekt(data, "lead", "chatgptLead", id);
  const taskObjekt = (data, id) => quellObjekt(data, "task", "task", id) || quellObjekt(data, "task", "chatgptTask", id);
  function intakeObjekt(data, id) {
    const it = data.automation.intakeById[id];
    if (!istKarte(it)) return null;
    return basis("intake", id, { jobId: laufFuerQuelle(data, "intake", id), source: it.channel || null, title: String(it.text || "").split("\n")[0].slice(0, 200), state: it.status, entityVersion: kartenVersion(it), createdAt: it.registeredAt || it.receivedAt || null });
  }
  function frageObjekt(data, id) {
    const q = data.automation.questionsById[id];
    if (!istKarte(q)) return null;
    const jobId = q.runDate && laufNachDatum(data, q.runDate) ? "run_" + q.runDate : laufFuerQuelle(data, q.sourceType, q.sourceId);
    return basis("question", id, { jobId, leadId: q.sourceType === "chatgptLead" ? q.sourceId : null, sourceType: q.sourceType, sourceId: q.sourceId, text: q.text, state: q.status, entityVersion: kartenVersion(q), updatedAt: q.answeredAt || q.askedAt || null });
  }
  function antwortObjekt(data, id) {
    const a = data.automation.answersById[id];
    if (!istKarte(a)) return null;
    const q = data.automation.questionsById[a.questionId];
    const briefingId = istKarte(q) && q.runDate && laufNachDatum(data, q.runDate) ? "run_" + q.runDate : (istKarte(q) ? laufFuerQuelle(data, q.sourceType, q.sourceId) : null);
    return basis("briefing_answer", id, { jobId: briefingId, briefingId, questionId: a.questionId, state: a.consumedAt ? "consumed" : "open", entityVersion: kartenVersion(a), updatedAt: a.consumedAt || a.answeredAt || null });
  }
  function dokumentObjekt(data, id) {
    const d = data.automation.documentsById[id];
    if (!istKarte(d)) return null;
    return basis("document", id, { jobId: istKarte(d.linkedTo) ? laufFuerQuelle(data, d.linkedTo.sourceType, d.linkedTo.sourceId) : null, title: d.name || null, state: d.status, parseOutcome: d.parse ? d.parse.outcome : null, entityVersion: kartenVersion(d), updatedAt: d.handledAt || (d.parse && d.parse.checkedAt) || d.uploadedAt || null });
  }
  /* Auftrag: jobId = seine EIGENE Kennung — daran haengt der Ausweis des Spezialisten (C1 binding "job"). */
  function auftragObjekt(data, id) {
    const j = data.automation.jobsById[id];
    if (!istKarte(j)) return null;
    return basis("assignment", id, { jobId: id, runId: laufFuerJob(data, j), workerKind: j.executor, state: j.state, entityVersion: kartenVersion(j), dueAt: j.expiresAt || null, sourceType: j.sourceType, sourceId: j.sourceId });
  }
  /* Ergebnis: jobId = Lauf des Auftrags — daran haengt die Leitung (assignedJobIds). */
  function ergebnisObjekt(data, resultRef) {
    const treffer = Object.values(data.automation.jobsById).filter((j) => istKarte(j) && istKarte(j.result) && j.result.ref === resultRef);
    if (treffer.length !== 1) return null;
    const j = treffer[0];
    return basis("worker_result", resultRef, { jobId: laufFuerJob(data, j), assignmentId: j.id, state: j.review ? "reviewed:" + j.review.verdict : j.state, summary: j.result.summary || null, entityVersion: kartenVersion(j), updatedAt: (j.review && j.review.reviewedAt) || j.returnedAt || null });
  }
  function kommentare(data, sourceType, sourceId) {
    const e = B.quelleFinden(data, sourceType, sourceId);
    if (!e || !Array.isArray(e.comments)) return [];
    const runId = laufFuerQuelle(data, sourceType, sourceId);
    return e.comments.filter((c) => istKarte(c) && typeof c.id === "string" && c.id).map((c) => basis("note", c.id, {
      jobId: runId, runId, leadId: sourceType === "chatgptLead" ? sourceId : null, sourceType, sourceId,
      text: String(c.text || ""), createdAt: c.createdAt || null, author: typeof c.author === "string" ? c.author : (typeof c.by === "string" ? c.by : null),
      entityVersion: kartenVersion(c),
    })).sort((a, b) => nachText(String(b.createdAt || ""), String(a.createdAt || "")) || nachId(a, b));
  }
  function notizObjekt(data, id) {
    for (const leadId of Object.keys(data.entities.chatgptLeads)) { const n = kommentare(data, "chatgptLead", leadId).find((c) => c.id === id); if (n) return n; }
    const note = data.entities.chatgptNotes[id];
    if (istKarte(note) && istKarte(note.assistantNote)) {
      const runId = note.assistantNote.runDate ? "run_" + note.assistantNote.runDate : null;
      return basis("note", id, { jobId: runId, runId, leadId: Array.isArray(note.linkedChatgptLeads) && note.linkedChatgptLeads.length ? String(note.linkedChatgptLeads[0]) : null, text: String(note.instruction || ""), createdAt: note.createdAt || null, author: note.author || null, entityVersion: kartenVersion(note) });
    }
    return null;
  }
  const policyObjekt = () => basis("policy", "policy_" + POLICY.version, { jobId: null, policyVersion: POLICY.version, mode: modus, entityVersion: 1, updatedAt: null, limits: { maxWaitDays: POLICY.maxWaitDays } });
  function laufKontextEintraege(data, run, jobId, filter) {
    const out = [];
    for (const ref of Array.isArray(run.itemRefs) ? run.itemRefs : []) {
      if (!istKarte(ref) || !B.QUELLEN[ref.sourceType]) continue;
      if (filter && !filter.has(ref.sourceType + ":" + ref.sourceId)) continue;
      const e = B.quelleFinden(data, ref.sourceType, ref.sourceId);
      if (!e) continue;
      const z = B.effektiverZustand(ref.sourceType, e);
      const belege = Object.values(data.automation.evidenceById).filter((ev) => istKarte(ev) && ev.sourceType === ref.sourceType && ev.sourceId === ref.sourceId).map((ev) => ev.id).sort();
      out.push(basis("run_context", "ctx_" + ref.sourceType + "_" + ref.sourceId, {
        runId: run.id, jobId, sourceType: ref.sourceType, sourceId: ref.sourceId,
        title: ref.sourceType === "chatgptTask" ? String(e.text || "") : String(e.title || ""),
        text: ref.sourceType === "chatgptLead" ? String(e.rawInput || "") : "",
        entityVersion: z.unmigrated || z.versionInvalid ? null : z.version, updatedAt: e.updatedAt || null, evidenceRefs: belege,
      }));
    }
    return out.sort(nachId);
  }
  /* Der Kontext eines Spezialisten: Quelle und contextRefs SEINES aktiven Auftrags — sonst nichts. */
  function spezialistenFilter(data, principal, nowMs) {
    const pr = auftragPruefen(data, principal.jobId, ROLE_EXECUTOR[principal.role], nowMs);
    if (!pr.ok) throw fail("forbidden", pr.reason, 403);
    const erlaubt = new Set([pr.job.sourceType + ":" + pr.job.sourceId]);
    for (const r of Array.isArray(pr.job.contextRefs) ? pr.job.contextRefs : []) if (istKarte(r)) erlaubt.add(r.sourceType + ":" + r.sourceId);
    return { filter: erlaubt, job: pr.job };
  }

  function objektLaden(data, kind, id, { runId = null } = {}) {
    switch (kind) {
      case "run": { const r = laufNachId(data, id); return r ? laufObjekt(data, r) : null; }
      case "briefing": { const r = laufNachId(data, id); return r ? briefingObjekt(data, r) : null; }
      case "run_context": {
        const r = laufNachId(data, id);
        if (!r) return null;
        // runId = das Bindungsobjekt des Ausweises: Lauf (Leitung/Nutzer) oder Auftrag (Spezialist).
        if (runId && runId !== r.id) {
          const j = data.automation.jobsById[runId];
          if (!istKarte(j)) return null;
          const pr = auftragPruefen(data, runId, j.executor, now());
          if (!pr.ok) throw fail("forbidden", pr.reason, 403);
          if (laufFuerJob(data, j) !== r.id) throw fail("forbidden", "assignment_run_mismatch", 403);
          return laufKontextScope(data, r, runId);
        }
        return laufKontextScope(data, r, r.id);
      }
      case "run_status": { const m = /^status_(\d{4}-\d{2}-\d{2})$/.exec(String(id)); const r = m ? laufNachDatum(data, m[1]) : null; return r ? laufStatusObjekt(data, r) : null; }
      case "lead": return leadObjekt(data, id);
      case "task": return taskObjekt(data, id);
      case "intake": return intakeObjekt(data, id);
      case "question": return frageObjekt(data, id);
      case "briefing_answer": return antwortObjekt(data, id);
      case "document": return dokumentObjekt(data, id);
      case "assignment": return auftragObjekt(data, id);
      case "worker_result": return ergebnisObjekt(data, id);
      case "note": return notizObjekt(data, id);
      case "policy": return id === "policy_" + POLICY.version ? policyObjekt() : null;
      default: return null;
    }
  }

  /* ── Lesen ─────────────────────────────────────────────────────────── */
  function loadObject(snapshot, { kind, id, runId = null } = {}) {
    if (typeof id !== "string" || !id) return null;
    return objektLaden(kernLesen(snapshot), String(kind || ""), id, { runId: runId ? String(runId) : null });
  }
  function seite(alle, { pageSize, afterId }) {
    let start = 0;
    if (afterId != null && afterId !== "") {
      const i = alle.findIndex((x) => x.id === afterId);
      if (i < 0) return { items: [], hasMore: false, nextAfterId: null, aborted: true, abortReason: "after_id_unknown" };
      start = i + 1;
    }
    const items = alle.slice(start, start + pageSize);
    const hasMore = start + pageSize < alle.length;
    return { items, hasMore, nextAfterId: hasMore && items.length ? items[items.length - 1].id : null, total: alle.length };
  }
  function listPage(snapshot, { query, scopeId, pageSize, afterId, principal } = {}) {
    const data = kernLesen(snapshot);
    if (!Number.isInteger(pageSize) || pageSize < 1) throw fail("invalid_request", "page_size_invalid", 400);
    const rolle = String(principal?.role || "");
    switch (query) {
      case "run.context": {
        const run = laufNachId(data, scopeId);
        if (!run) return { items: [], hasMore: false, nextAfterId: null, aborted: true, abortReason: "scope_not_found" };
        if (ROLE_EXECUTOR[rolle]) {
          const { filter, job } = spezialistenFilter(data, principal, now());
          if (laufFuerJob(data, job) !== run.id) throw fail("forbidden", "assignment_run_mismatch", 403);
          return seite(laufKontextEintraege(data, run, job.id, filter), { pageSize, afterId });
        }
        return seite(laufKontextEintraege(data, run, run.id, null), { pageSize, afterId });
      }
      case "lead.context": { const l = leadObjekt(data, scopeId); return seite(l ? [l] : [], { pageSize, afterId }); }
      case "notes.recent": return seite(kommentare(data, "chatgptLead", scopeId), { pageSize, afterId });
      case "run.queue": return seite(laeufe(data).map((r) => laufObjekt(data, r)), { pageSize, afterId });
      case "run.status": return seite(laeufe(data).map((r) => laufStatusObjekt(data, r)), { pageSize, afterId });
      case "policy.current": return seite([policyObjekt()], { pageSize, afterId });
      default: throw fail("invalid_request", "query_unknown:" + String(query), 400);
    }
  }

  /* ── Ziel aufloesen (je CAS-Versuch, frisch) ────────────────────────── */
  function resolveTarget(snapshot, { verb, command, principal, descriptor } = {}) {
    const data = kernLesen(snapshot);
    if (!VERB_BINDINGS[verb] || !descriptor) return null;
    const p = command.payload || {};
    const res = descriptor.resource;
    const ctxId = { tenant, principal, command };
    let ressource = null;
    if (res.idField) {
      ressource = objektLaden(data, res.kind, String(p[res.idField] || ""));
    } else if (res.creates) {
      const neu = (id, extra = {}) => basis(res.kind, id, { jobId: command.jobId, isNew: true, entityVersion: 0, ...extra });
      switch (verb) {
        case "intake.create": ressource = neu(p.intakeId || abgeleiteteId("intake", ctxId)); break;
        case "task.create": ressource = neu(p.taskId || abgeleiteteId("task", ctxId), { leadId: p.leadId }); break;
        case "briefing.answer": ressource = neu(p.answerId || abgeleiteteId("answer", ctxId), { briefingId: p.briefingId, questionId: p.questionId }); break;
        case "question.create": ressource = neu(p.questionId || abgeleiteteId("question", ctxId), { leadId: p.leadId }); break;
        case "document.register": ressource = neu(String(p.documentId || "")); break;
        case "worker.assign": ressource = neu(String(p.assignmentId || "")); break;
        case "worker.return": ressource = neu(String(p.resultRef || ""), { assignmentId: p.assignmentId, jobId: String(p.assignmentId || "") }); break;
        case "note.append": ressource = neu(String(p.noteId || ""), { leadId: p.leadId || null, runId: command.jobId }); break;
        default: ressource = null;
      }
    } else if (res.ensure) {
      const vorhanden = laufNachId(data, String(command.jobId || ""));
      ressource = vorhanden ? laufObjekt(data, vorhanden) : basis("run", String(command.jobId || ""), { jobId: command.jobId, isNew: true, entityVersion: 0, date: p.date });
    } else if (res.fromJob) {
      const r = laufNachId(data, String(command.jobId || ""));
      ressource = r ? laufObjekt(data, r) : null;
    }
    if (!ressource) return null;
    let anker = ressource;
    if (!descriptor.anchor.self) {
      const ankerId = descriptor.anchor.idField ? String(p[descriptor.anchor.idField] || "") : String(command.jobId || "");
      anker = objektLaden(data, descriptor.anchor.kind, ankerId);
      if (!anker) return null;
    }
    return { resource: ressource, anchor: anker };
  }

  /* ── Aktive Bindung, je CAS-Versuch ─────────────────────────────────── */
  function leitungsBindung(data, principal, run, command, nowMs) {
    const lease = command && istKarte(command.lease) ? command.lease : null;
    if (!lease) return { ok: false, reason: "lease_not_presented" };
    if (typeof lease.holder !== "string" || !lease.holder || !Number.isSafeInteger(lease.fence) || lease.fence < 1) return { ok: false, reason: "lease_invalid" };
    let gespeichert;
    try { E1.readRuntime(data); gespeichert = data.automation.activeLease; } catch (e) { throw uebersetzeE1(e); }
    if (!istKarte(gespeichert)) return { ok: false, reason: "lease_absent" };
    // Halter und Fence kommen vom Claimenden; E1 prueft sie gegen die Lease
    // (Halter, Fence, Ablauf). Der Scope der Lease gehoert zu diesem Lauf.
    let urteil;
    try { urteil = E1.checkLeadership(data, { holder: String(lease.holder), scope: String(gespeichert.scope), fence: lease.fence }, nowMs); } catch (e) { throw uebersetzeE1(e); }
    if (!urteil.ok) return { ok: false, reason: String(urteil.code || "lease_not_held") };
    const teile = String(gespeichert.scope).split(":");
    if (teile.length !== 4 || teile[0] !== tenant || teile[1] !== run.date || teile[3] !== POLICY.version) return { ok: false, reason: "lease_scope_mismatch" };
    return { ok: true, fence: urteil.fence, scope: gespeichert.scope };
  }
  function assertActiveBinding({ snapshot, principal, resource, anchor, command, jobId, nowMs } = {}) {
    const data = kernLesen(snapshot);
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return { ok: false, reason: "now_missing" };
    if (String(principal?.tenant || "") !== tenant) return { ok: false, reason: "tenant_mismatch" };
    const rolle = String(principal?.role || "");
    switch (rolle) {
      case "user": return String(principal.id) === ownerId ? { ok: true } : { ok: false, reason: "not_household_owner" };
      case "scheduler": case "backend_checker": return { ok: true };
      case "lead_agent": {
        const run = laufNachId(data, String(jobId || ""));
        if (!run) return { ok: false, reason: "run_not_found" };
        const b = leitungsBindung(data, principal, run, command, nowMs);
        return b.ok ? { ok: true } : b;
      }
      case "specialist_claude": case "specialist_gemini": {
        const auftragId = String(jobId || "");
        if (anchor && anchor.kind === "assignment" && String(anchor.id) !== auftragId) return { ok: false, reason: "assignment_mismatch" };
        const pr = auftragPruefen(data, auftragId, ROLE_EXECUTOR[rolle], nowMs);
        return pr.ok ? { ok: true } : { ok: false, reason: pr.reason };
      }
      default: return { ok: false, reason: "unknown_role" };
    }
  }

  /* ── Belege aus C2-Referenzen: eindeutig im Kern aufloesen ─────────── */
  function belegAus(data, evidenceRefs, { pflicht }) {
    const refs = Array.isArray(evidenceRefs) ? evidenceRefs : [];
    if (!refs.length) { if (pflicht) throw fail("invalid_request", "evidence_ref_required", 400); return undefined; }
    if (refs.length > 1) throw fail("invalid_request", "evidence_refs_multiple_unsupported", 400);
    const id = String(refs[0]);
    const a = data.automation;
    const treffer = [];
    if (istKarte(a.evidenceById[id])) treffer.push({ kind: "evidence", evidenceId: id });
    if (istKarte(a.jobsById[id])) treffer.push({ kind: "job", jobId: id });
    if (istKarte(a.answersById[id])) treffer.push({ kind: "answer", answerId: id });
    if (istKarte(a.questionsById[id])) treffer.push({ kind: "question", questionId: id });
    if (!treffer.length) throw fail("invalid_request", "evidence_ref_unknown", 400);
    if (treffer.length > 1) throw fail("invalid_request", "evidence_ref_ambiguous", 400);
    return treffer[0];
  }
  /* Kontextreferenzen eines Auftrags: jede Kennung genau einer Quelle zuordnen. */
  function kontextRefs(data, ids) {
    const out = [];
    for (const raw of ids) {
      const id = String(raw);
      const treffer = [];
      for (const st of ["chatgptLead", "chatgptTask", "task"]) if (B.quelleFinden(data, st, id)) treffer.push({ sourceType: st, sourceId: id });
      for (const [st, karte] of [["document", data.automation.documentsById], ["evidence", data.automation.evidenceById], ["question", data.automation.questionsById]]) if (istKarte(karte[id])) treffer.push({ sourceType: st, sourceId: id });
      if (!treffer.length) throw fail("invalid_request", "context_ref_unknown", 400);
      if (treffer.length > 1) throw fail("invalid_request", "context_ref_ambiguous", 400);
      out.push(treffer[0]);
    }
    return out;
  }

  /* ── Wirkung (im CAS-Mutator, ueber den Idempotenz-Umschlag) ────────── */
  function applyVerb(snapshot, befehl, kontext, ziel = {}) {
    const verb = String(befehl?.verb || "");
    if (!VERB_BINDINGS[verb]) throw fail("invalid_request", "verb_unknown", 400);
    const { principal, resource, anchor } = ziel;
    const nowMs = Date.parse(String(kontext?.now || ""));
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || typeof kontext?.requestId !== "string" || !kontext.requestId) throw fail("core_invalid", "prepared_context_invalid", 503);
    const data = kernLesen(snapshot);
    const p = befehl.payload || {};
    const rolle = String(principal?.role || "");
    const actor = { kind: ROLE_ACTOR_KIND[rolle], id: String(principal?.id || "") };
    if (!actor.kind || !actor.id) throw fail("forbidden", "principal_role_unknown", 403);
    const reducer = B.commandReducer({ policy: POLICY, actor });
    const ausfuehren = (type, payload) => { try { return reducer(data, { type, payload }, kontext); } catch (e) { throw uebersetzeB(e); } };
    const ctxId = { tenant, principal, command: befehl };
    const lauf = () => { const r = laufNachId(data, String(befehl.jobId || "")); if (!r) throw fail("invalid_request", "RUN_MISSING", 400); return r; };

    let r; let ids = [];
    switch (verb) {
      case "intake.create": {
        r = ausfuehren("registerIntake", { intakeId: resource.id, text: p.text ? String(p.title) + "\n" + String(p.text) : String(p.title), channel: String(p.source) });
        ids = [["intake", resource.id]]; break;
      }
      case "intake.accept": {
        const payload = { sourceType: "intake", sourceId: String(p.intakeId), state: "done" };
        if (p.leadId) payload.linkTo = { sourceType: "chatgptLead", sourceId: String(p.leadId) }; else payload.reason = "intake.accept";
        r = ausfuehren("transitionState", payload); ids = [["intake", String(p.intakeId)]]; break;
      }
      case "task.create": {
        const payload = { taskId: resource.id, title: String(p.title), linkedLeadId: String(p.leadId) };
        if (p.dueAt) payload.dueDate = B.lokalDatum(B.msAus(p.dueAt));
        if (p.notes) payload.notes = String(p.notes);
        r = ausfuehren("createTask", payload); ids = [["task", resource.id], ["lead", String(p.leadId)]]; break;
      }
      case "lead.comment": {
        const commentId = p.commentId || abgeleiteteId("comment", ctxId);
        const payload = { sourceType: "chatgptLead", sourceId: String(p.leadId), commentId, text: String(p.text) };
        if (p.evidenceRefs) payload.evidenceRefs = p.evidenceRefs.map(String);
        r = ausfuehren("addComment", payload); ids = [["lead", String(p.leadId)], ["note", commentId]]; break;
      }
      case "lead.transition": {
        if (!B.OPERATIONAL_STATES.includes(p.toState)) throw fail("invalid_request", "to_state_unknown", 400);
        if (B.WARTE_ZUSTAENDE.includes(p.toState)) throw fail("invalid_request", "use_lead_schedule_for_waiting", 400);
        const payload = { sourceType: "chatgptLead", sourceId: String(p.leadId), state: p.toState, expectedVersion: befehl.expectedEntityVersion };
        if (p.reason) payload.reason = String(p.reason);
        const beleg = belegAus(data, p.evidenceRefs, { pflicht: false });
        if (beleg) { if (beleg.kind === "question") throw fail("invalid_request", "evidence_ref_kind_not_closing:question", 400); payload.evidence = beleg; }
        r = ausfuehren("transitionState", payload); ids = [["lead", String(p.leadId)]]; break;
      }
      case "lead.schedule": {
        const beleg = belegAus(data, p.evidenceRefs, { pflicht: true });
        if (beleg.kind === "answer") throw fail("invalid_request", "evidence_ref_kind_not_waiting:answer", 400);
        const state = beleg.kind === "job" ? "delegated" : beleg.kind === "question" ? "waiting_user" : "waiting_external";
        r = ausfuehren("setWaiting", { sourceType: "chatgptLead", sourceId: String(p.leadId), expectedVersion: befehl.expectedEntityVersion, state, counterparty: String(p.counterparty), nextAction: String(p.nextAction), followUpAt: String(p.waitUntil), evidence: beleg });
        ids = [["lead", String(p.leadId)]]; break;
      }
      case "briefing.answer": {
        const q = data.automation.questionsById[String(p.questionId)];
        if (!istKarte(q)) throw fail("invalid_request", "QUESTION_NOT_FOUND", 400);
        if (q.runDate && "run_" + q.runDate !== String(p.briefingId)) throw fail("invalid_request", "briefing_question_mismatch", 400);
        r = ausfuehren("recordAnswer", { answerId: resource.id, questionId: String(p.questionId), text: String(p.answer) });
        ids = [["briefing_answer", resource.id], ["question", String(p.questionId)]]; break;
      }
      case "briefing.consumeAnswer": {
        const a = data.automation.answersById[String(p.answerId)];
        const q = istKarte(a) ? data.automation.questionsById[a.questionId] : null;
        if (istKarte(q) && q.runDate && "run_" + q.runDate !== String(p.briefingId)) throw fail("invalid_request", "briefing_answer_mismatch", 400);
        r = ausfuehren("consumeAnswer", { answerId: String(p.answerId), consumer: actor.id }); ids = [["briefing_answer", String(p.answerId)]]; break;
      }
      case "question.create": {
        const run = laufNachId(data, String(befehl.jobId || ""));
        const payload = { questionId: resource.id, sourceType: "chatgptLead", sourceId: String(p.leadId), text: String(p.text), date: run ? run.date : undefined };
        if (p.options) payload.options = p.options.map(String);
        r = ausfuehren("askQuestion", payload); ids = [["question", resource.id], ["lead", String(p.leadId)]]; break;
      }
      case "question.resolve": {
        const answerId = p.answerId || abgeleiteteId("answer", ctxId);
        r = ausfuehren("recordAnswer", { answerId, questionId: String(p.questionId), text: String(p.answer) });
        ids = [["question", String(p.questionId)], ["briefing_answer", answerId]]; break;
      }
      case "document.register": {
        r = ausfuehren("registerDocument", { documentId: resource.id, attachmentId: String(p.attachmentRef), name: String(p.title), hash: String(p.contentHash), mime: String(p.mime), size: p.size, origin: { channel: String(p.origin), ref: kontext.requestId }, linkedTo: { sourceType: "chatgptLead", sourceId: String(p.leadId) } });
        ids = [["document", resource.id], ["lead", String(p.leadId)]]; break;
      }
      case "document.processed": {
        r = ausfuehren("recordDocumentParse", { documentId: String(p.documentId), outcome: "parsed", textRef: String(p.extractionRef), extractHash: String(p.contentHash) });
        ids = [["document", String(p.documentId)]]; break;
      }
      case "worker.assign": {
        r = ausfuehren("createJob", { jobId: resource.id, kind: String(p.jobKind), purpose: String(p.purpose), sourceType: String(p.sourceType), sourceId: String(p.sourceId), inputVersion: p.sourceVersion, executor: String(p.executor), contextRefs: kontextRefs(data, p.allowedContextIds), expiresAt: String(p.dueAt) });
        ids = [["assignment", resource.id]]; break;
      }
      case "worker.return": {
        const j = data.automation.jobsById[String(p.assignmentId)];
        if (istKarte(j) && !(j.acceptedVersions || [j.inputVersion]).includes(p.sourceVersion)) throw fail("domain_conflict", "source_version_not_accepted", 409);
        r = ausfuehren("recordJobReturn", { jobId: String(p.assignmentId), outcome: "returned", resultRef: String(p.resultRef), resultHash: String(p.resultHash), summary: String(p.summary) });
        ids = [["worker_result", String(p.resultRef)], ["assignment", String(p.assignmentId)]]; break;
      }
      case "worker.review": {
        const erg = ergebnisObjekt(data, String(p.resultId));
        if (!erg) throw fail("invalid_request", "worker_result_not_found", 400);
        const payload = { jobId: erg.assignmentId, verdict: p.verdict, reviewer: actor.id };
        if (p.notes) payload.note = String(p.notes);
        r = ausfuehren("reviewJobResult", payload); ids = [["worker_result", String(p.resultId)], ["assignment", erg.assignmentId]]; break;
      }
      case "run.ensure": {
        if (!SLOT_VON_C2[p.slot]) throw fail("invalid_request", "slot_unknown", 400);
        if ("run_" + String(p.date) !== String(befehl.jobId)) throw fail("invalid_request", "run_id_date_mismatch", 400);
        r = ausfuehren("ensureRunSlot", { date: String(p.date), slot: SLOT_VON_C2[p.slot], receiptId: p.receiptId || "rcpt_" + String(p.date) + "_" + SLOT_VON_C2[p.slot] });
        ids = [["run", "run_" + String(p.date)]]; break;
      }
      case "run.claim": {
        const run = lauf();
        const slot = B.aktuellerSlot(nowMs);
        if (slot.date !== run.date) throw fail("domain_conflict", "run_not_current_day", 409);
        let e1;
        try { e1 = E1.acquireLease(data, { holder: actor.id, scope: B.slotKey(tenant, run.date, slot.slot, POLICY.version), ttlMs: Number(p.leaseSeconds) * 1000, now: nowMs }); } catch (e) { throw uebersetzeE1(e); }
        if (!e1 || !e1.result || e1.result.ok !== true) throw fail("domain_conflict", "lease:" + String(e1?.result?.code || "rejected"), 409);
        r = { data: e1.data, result: { fence: e1.result.fence ?? null, scope: e1.result.lease ? e1.result.lease.scope : null, acquired: e1.result.acquired ?? null, duplicate: e1.result.duplicate ?? false, expiresAtMs: e1.result.lease ? e1.result.lease.expiresAtMs : null, noop: e1.unchanged === true } };
        ids = [["run", run.id]]; break;
      }
      case "run.renew": {
        const run = lauf();
        const lease = istKarte(befehl.lease) ? befehl.lease : null;
        if (!lease) throw fail("forbidden", "lease_not_presented", 403);
        if (String(lease.holder) !== actor.id) throw fail("forbidden", "lease_holder_mismatch", 403);
        let gespeichert;
        try { E1.readRuntime(data); gespeichert = data.automation.activeLease; } catch (e) { throw uebersetzeE1(e); }
        if (!istKarte(gespeichert)) throw fail("domain_conflict", "lease:lease_absent", 409);
        let e1;
        try { e1 = E1.renewLease(data, { holder: actor.id, fence: lease.fence, scope: String(gespeichert.scope), ttlMs: Number(p.leaseSeconds) * 1000, now: nowMs }); } catch (e) { throw uebersetzeE1(e); }
        if (!e1 || !e1.result || e1.result.ok !== true) throw fail("domain_conflict", "lease:" + String(e1?.result?.code || "rejected"), 409);
        r = { data: e1.data, result: { fence: e1.result.fence ?? null, renewed: e1.result.renewed ?? null, lateRenewal: e1.result.lateRenewal ?? null, expiresAtMs: e1.result.lease ? e1.result.lease.expiresAtMs : null, noop: false } };
        ids = [["run", run.id]]; break;
      }
      case "run.checkpoint": {
        const run = lauf();
        const payload = { date: run.date, checkpointId: p.checkpointId || abgeleiteteId("cp", ctxId), stage: String(p.stage) };
        if (p.note) payload.note = String(p.note);
        r = ausfuehren("recordRunCheckpoint", payload); ids = [["run", run.id]]; break;
      }
      case "run.finalize": {
        const run = lauf();
        if (p.outcome === "complete") r = ausfuehren("closeRun", { date: run.date, finalNoteId: p.summaryRef ? String(p.summaryRef) : "note_final_" + run.date });
        else {
          // partial/failed: der Kern schliesst nur gruene Laeufe (kein done ohne Nachweis).
          // Der Befund des Pruefers wird als Laufereignis festgehalten; der Lauf bleibt offen.
          const payload = { date: run.date, eventId: abgeleiteteId("fin", ctxId), event: "finalize:" + String(p.outcome) };
          if (p.summaryRef) payload.detail = "summaryRef:" + String(p.summaryRef);
          r = ausfuehren("recordRunEvent", payload);
        }
        ids = [["run", run.id]]; break;
      }
      case "note.append": {
        const run = lauf();
        if (p.noteScope === "lead" && !p.leadId) throw fail("invalid_request", "lead_id_required_for_lead_scope", 400);
        const payload = { date: run.date, noteId: resource.id, text: String(p.text) };
        if (p.leadId) payload.linkedLeadId = String(p.leadId);
        r = ausfuehren("appendRunNote", payload); ids = [["note", resource.id], ["run", run.id]]; break;
      }
      case "run.log": {
        const run = lauf();
        const payload = { date: run.date, eventId: p.eventId || abgeleiteteId("ev", ctxId), event: String(p.event) };
        if (p.detail) payload.detail = String(p.detail);
        r = ausfuehren("recordRunEvent", payload); ids = [["run", run.id]]; break;
      }
      case "run.sourceCheck": {
        const run = lauf();
        const payload = { date: run.date, sourceId: String(p.sourceId), cursor: String(p.cursor), outcome: String(p.outcome) };
        if (p.detail) payload.detail = String(p.detail);
        r = ausfuehren("recordSourceCheck", payload); ids = [["run", run.id]]; break;
      }
      default: throw fail("invalid_request", "verb_unknown", 400);
    }

    // Versionen NACH der Wirkung, aus dem Ergebnisbestand gelesen.
    const entityVersions = {};
    for (const [kind, id] of ids) {
      const o = objektLaden(r.data, kind, id);
      if (o && Number.isInteger(o.entityVersion)) entityVersions[id] = o.entityVersion;
    }
    if (anchor && anchor.id && !(anchor.id in entityVersions)) {
      const o = objektLaden(r.data, anchor.kind, anchor.id);
      if (o && Number.isInteger(o.entityVersion)) entityVersions[anchor.id] = o.entityVersion;
    }
    const effect = {};
    for (const [k, v] of Object.entries(r.result || {})) {
      if (["ok", "replayed", "serverNow", "dataRevision", "requestId", "data"].includes(k)) continue;
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) effect[k] = v;
    }
    return { data: r.data, result: { entityVersions, verb, command: VERB_BINDINGS[verb], effect } };
  }

  return Object.freeze({
    adapterVersion: ADAPTER_VERSION, tenant, ownerId, policyVersion: POLICY.version, mode: modus,
    resolveTarget, assertActiveBinding, applyVerb, loadObject, listPage,
  });
}

/* Diagnose fuer die Verdrahtung: WAS fehlt (Namen), nie Werte. */
export function describeDomainPorts({ read = (n) => process.env[n], ports = {} } = {}) {
  const fehlend = [];
  if (ports.policy === undefined && !String(read(DOMAIN_PORT_VARS.policyJson) || "").trim()) fehlend.push(DOMAIN_PORT_VARS.policyJson);
  if (ports.ownerId === undefined && !String(read(DOMAIN_PORT_VARS.ownerUid) || "").trim()) fehlend.push(DOMAIN_PORT_VARS.ownerUid);
  return { ok: fehlend.length === 0, missing: fehlend };
}

export default { createQuantusV3DomainAdapter, describeDomainPorts, VERB_BINDINGS, DOMAIN_PORT_VARS, ADAPTER_VERSION };
