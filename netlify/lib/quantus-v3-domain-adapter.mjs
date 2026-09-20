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
 *     chatgptLeads[*].comments                        → note
 *     serverseitige Tagesbriefing-Policy              → policy
 *
 * Es gibt KEINEN Ersatzbestand: keine entities.leads, keine entities.runs.
 * Was hier nicht aus dem Kern kommt, kommt aus der serverseitigen Policy
 * (Mandant, Eigentuemer, Policy-Version) — nie aus dem Anfragetext.
 *
 * Vertrag (C3b, a422670): genau eine benannte Fabrik
 *
 *     createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now })
 *       → { resolveTarget, assertActiveBinding, applyVerb, loadObject, listPage }
 *
 * Die Fabrik braucht ausserdem die ECHTE Tagesbriefing-Policy (Paket B),
 * den Eigentuemer des Haushalts und die E1-Laufzeit (Lease/Fencing). Diese
 * Ports kommen entweder ueber `ports` (Integration, Tests) oder ueber
 * Umgebungsvariablen (siehe DOMAIN_PORT_VARS). Fehlt einer, wirft die Fabrik
 * einen Fehler mit Status 503 und benanntem Grund — es wird nichts
 * simuliert, nichts geraten, nichts „vorlaeufig" erlaubt.
 *
 * Grundsaetze:
 *   • Alle Schreibwirkungen laufen ueber B.applyCommand (commandReducer):
 *     Zeit und Kennung ausschliesslich aus dem vorbereiteten Umschlag
 *     (prepared), nie aus dem Anfragetext. Lease-Verben laufen ueber den
 *     E1-Port — der Adapter implementiert keine Lease, keine Kosten, keine
 *     Idempotenz.
 *   • Jede Bindung (Objekt, Lauf, Lease, Auftrag) wird im CAS-Mutator frisch
 *     gegen den aktuellen Bestand geprueft (resolveTarget/assertActiveBinding
 *     werden je Versuch aufgerufen), auch vor einer Wiederholungsquittung.
 *   • Der Lesepfad liefert nur Projektionen, nie den Rohbestand; Seiten sind
 *     stabil sortiert, `hasMore` ist wahrheitsgemaess, eine unbekannte
 *     Fortsetzungsmarke bricht die Seite ab (aborted), statt still bei 0 zu
 *     beginnen. GET schreibt nie — auch keine Migration, keine Bewertung
 *     wird zurueckgeschrieben.
 *   • Kennungen mit Doppelpunkten (B erlaubt sie, C2 nicht) werden NICHT
 *     umcodiert: Objekte behalten ihre Kennung; adressierbar ueber C2 sind
 *     sie nicht. Das ist ein gemeldetes Vertragsproblem, keine stille
 *     Loesung (docs/quantus-v3-domain-adapter.md, Abschnitt „Luecken").
 *   • Verben, fuer die B kein sicheres Kommando hat, sind BENANNT unbound:
 *     resolveTarget/assertActiveBinding laufen normal (Rechte und Bindung
 *     werden geprueft), applyVerb lehnt strukturiert ab
 *     (`verb_not_bound:<verb>:<luecke>`), nichts wird geschrieben.
 * ═══════════════════════════════════════════════════════════════════════ */

import * as B from "./assistant-core.mjs";

/* ── E1 (Lease/Fencing): optional beim Laden, PFLICHT beim Bauen ─────────
 * Die Laufzeit liegt im Integrationsstand (quantus-v3-runtime-state.mjs).
 * Fehlt sie im Checkout, ist E1_MODUL null; die Fabrik verlangt dann den
 * Port `ports.runtimeState` — sonst 503. */
let E1_MODUL = null;
try { E1_MODUL = await import("./quantus-v3-runtime-state.mjs"); } catch { E1_MODUL = null; }

export const ADAPTER_VERSION = "quantus-v3-domain-adapter/1.0.0";

export const DOMAIN_PORT_VARS = Object.freeze({
  policyJson: "QUANTUS_V3_TAGESBRIEFING_POLICY_JSON",   // die B-Policy (tagesbriefing-policy/3) als JSON
  ownerUid: "QUANTUS_V3_OWNER_UID",                    // Firebase-UID des Haushaltseigentuemers
});

const E1_METHODEN = Object.freeze(["acquireLease", "renewLease", "checkLeadership", "readRuntime"]);

/* C2-Rollen → B-Akteure. Rollen kommen aus dem gepruefeten Ausweis (C1),
 * nie aus dem Text. */
export const ROLE_ACTOR_KIND = Object.freeze({
  user: "user", lead_agent: "agent", specialist_claude: "worker", specialist_gemini: "worker",
  scheduler: "system", backend_checker: "system",
});
const ROLE_EXECUTOR = Object.freeze({ specialist_claude: "claude", specialist_gemini: "gemini" });

/* C2-Slot-Namen → B-Slots. */
const SLOT_VON_C2 = Object.freeze({ "04:00": "briefing04", "09:00": "process09", "14:00": "continue14", "23:00": "close23" });

/* ── Die 22 Verben: gebunden oder benannte Luecke ────────────────────────
 * `command`: das B-Kommando, `gap`: warum es keines gibt (Schluessel in
 * docs/quantus-v3-domain-adapter.md). Beides zugleich gibt es nicht. */
export const VERB_BINDINGS = Object.freeze({
  "intake.create":          Object.freeze({ command: "registerIntake",      gap: null }),
  "intake.accept":          Object.freeze({ command: "transitionState",     gap: null }),
  "task.create":            Object.freeze({ command: null, gap: "B_HAS_NO_TASK_CREATE" }),
  "lead.comment":           Object.freeze({ command: null, gap: "B_HAS_NO_COMMENT_COMMAND" }),
  "lead.transition":        Object.freeze({ command: "transitionState",     gap: null }),
  "lead.schedule":          Object.freeze({ command: "setWaiting",          gap: null }),
  "briefing.answer":        Object.freeze({ command: "recordAnswer",        gap: null }),
  "briefing.consumeAnswer": Object.freeze({ command: "consumeAnswer",       gap: null }),
  "question.create":        Object.freeze({ command: "askQuestion",         gap: null }),
  "question.resolve":       Object.freeze({ command: "recordAnswer",        gap: null }),
  "document.register":      Object.freeze({ command: null, gap: "ATTACHMENT_KEY_NOT_EXPRESSIBLE_IN_C2_ID" }),
  "document.processed":     Object.freeze({ command: null, gap: "ATTACHMENT_KEY_NOT_EXPRESSIBLE_IN_C2_ID" }),
  "worker.assign":          Object.freeze({ command: null, gap: "C2_PAYLOAD_LACKS_SOURCE_AND_PURPOSE" }),
  "worker.return":          Object.freeze({ command: null, gap: "C2_PAYLOAD_LACKS_RESULT_HASH" }),
  "worker.review":          Object.freeze({ command: "reviewJobResult",     gap: null }),
  "run.ensure":             Object.freeze({ command: "ensureRun",           gap: null }),
  "run.claim":              Object.freeze({ command: "E1.acquireLease",     gap: null }),
  "run.renew":              Object.freeze({ command: "E1.renewLease",       gap: null }),
  "run.checkpoint":         Object.freeze({ command: null, gap: "C2_PAYLOAD_LACKS_E1_CHECKPOINT_INPUTS" }),
  "run.finalize":           Object.freeze({ command: "closeRun",            gap: null }),
  "note.append":            Object.freeze({ command: null, gap: "B_HAS_NO_FREE_NOTE_COMMAND" }),
  "run.log":                Object.freeze({ command: null, gap: "B_HAS_NO_RUN_LOG_COMMAND" }),
});

/* ── Kleinkram ─────────────────────────────────────────────────────────── */
const CODE_RE = /^[A-Za-z0-9_:.,\-]{1,160}$/;

function istKarte(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
/* Deterministische Ordnung nach Codepunkten — unabhaengig von der Locale des Servers. */
const nachId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const nachText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* Fehler in der Form, die C2 (fehlerAntwort/STATUS_BY_CODE) versteht:
 * code ist ein C2-Code, reason traegt den fachlichen Grund. */
function fail(code, reason, status) {
  const err = new Error(reason || code);
  err.code = code;
  err.reason = reason || code;
  err.status = status;
  return err;
}
const port503 = (reason) => fail("auth_not_configured", reason, 503);

/* B-Ablehnung (aus commandReducer) → C2-Code. Der B-Code steht in reason;
 * Details nur, wenn sie selbst Codes sind (nie Nutzertext). */
function uebersetzeB(err) {
  const code = String(err?.code || "");
  const detail = err?.detail;
  let zusatz = "";
  if (typeof detail === "string" && CODE_RE.test(detail)) zusatz = ":" + detail;
  else if (Array.isArray(detail) && detail.length && detail.every((d) => typeof d === "string" && CODE_RE.test(d))) zusatz = ":" + detail.slice(0, 8).join(",");
  const reason = (code || "domain_rejected") + zusatz;
  if (err?.status === 503 || code.startsWith("CORE_")) return fail("core_invalid", reason, 503);
  if (err?.status === 409) return fail("stale_entity_version", reason, 409);
  if (err?.status === 500 || code === "invalid_transaction_context") return fail("core_invalid", reason, 503);
  return fail("invalid_request", reason, 400);
}

/* E1-Ausnahme (RuntimeStateError) → C2-Code. */
function uebersetzeE1(err) {
  const code = "runtime:" + String(err?.code || "runtime_error");
  const status = Number(err?.status) || 500;
  if (status >= 500) return fail("core_invalid", code, 503);
  if (status === 409) return fail("stale_entity_version", code, 409);
  return fail("invalid_request", code, 400);
}

/* Kartenversion: Buchhaltungskarten (Intake, Frage, Antwort, Dokument,
 * Auftrag, Kommentar) tragen keinen Zaehler. Ihre Version ist die
 * Projektion ihres Inhalts (32-Bit-Fingerabdruck → 48-Bit-Ganzzahl):
 * jede Aenderung der Karte aendert die Version, dieselbe Karte hat auf
 * jedem Geraet dieselbe Version. Kein Zaehler wird erfunden. */
function kartenVersion(karte) {
  return 1 + parseInt(B.stringFingerprint(B.canonicalJson(karte)).slice(0, 12), 16);
}

/* Abgeleitete Kennung fuer Ressourcen, die C2 ohne Kennung anlegt
 * (intake.create, question.create, briefing.answer, question.resolve):
 * deterministisch aus Mandant, Auftraggeber, Lauf, Verb und Nutzlast —
 * identische Wiederholung trifft dieselbe Karte (B ist dort idempotent). */
function abgeleiteteId(praefix, { tenant, principal, command }) {
  return praefix + "_" + B.stringFingerprint(B.canonicalJson({ tenant, principal: principal.id, jobId: command.jobId, verb: command.verb, payload: command.payload }));
}

function kernLesen(snapshot) {
  try { return B.requireCore(snapshot); } catch (e) { return null; }
}

function laeufe(data) {
  return Object.values(data.dailyBriefing.assistantRuns).filter(istKarte).sort((a, b) => nachText(String(b.date), String(a.date)));
}
function laufNachId(data, id) {
  return laeufe(data).find((r) => r.id === id) || null;
}
function laufNachDatum(data, date) {
  const r = data.dailyBriefing.assistantRuns[date];
  return istKarte(r) ? r : null;
}
/* Der Lauf, in dem eine Quelle gefuehrt wird (juengster zuerst). */
function laufFuerQuelle(data, sourceType, sourceId) {
  const r = laeufe(data).find((x) => Array.isArray(x.itemRefs) && x.itemRefs.some((ref) => ref && ref.sourceType === sourceType && ref.sourceId === sourceId));
  return r ? r.id : null;
}
/* Der Lauf eines Auftrags: der Assistententag seiner Erstellung. */
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

/* ══ Die Fabrik ══════════════════════════════════════════════════════════ */
export function createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now, ports = {} } = {}) {
  /* ── Ports: serverseitig, vollstaendig oder 503 ────────────────────── */
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
  // Die C2-Policy-Version ist NICHT die Policy: sie muss zur echten B-Policy passen.
  if (policy.version !== pv) throw port503("domain_policy_version_mismatch");
  if (policy.tenant !== tenant) throw port503("domain_policy_tenant_mismatch");

  const ownerId = String(ports.ownerId !== undefined ? ports.ownerId : (read(DOMAIN_PORT_VARS.ownerUid) || "")).trim();
  if (!ownerId) throw port503("domain_owner_missing:" + DOMAIN_PORT_VARS.ownerUid);

  const E1 = ports.runtimeState !== undefined ? ports.runtimeState : E1_MODUL;
  if (!E1 || !E1_METHODEN.every((m) => typeof E1[m] === "function")) throw port503("domain_runtime_state_port_missing");

  const POLICY = Object.freeze(structuredClone(policy));
  const basis = (kind, id, extra) => ({ kind, id, tenant, ownerId, ...extra });

  /* ── Projektionen (Lesen) ──────────────────────────────────────────── */
  function leaseFuerLauf(data, run) {
    // Nur zur Anzeige: die Lease-Form prueft E1; eine kaputte Lease ist
    // hier "keine Anzeige", die Bindung (unten) meldet sie als 503.
    try {
      E1.readRuntime(data);
      const l = data.automation.activeLease;
      if (!istKarte(l) || typeof l.scope !== "string") return null;
      const teile = l.scope.split(":");
      if (teile.length !== 4 || teile[0] !== tenant || teile[1] !== run.date) return null;
      return { holder: l.holder, expiresAt: Number.isSafeInteger(l.expiresAtMs) ? B.isoAus(l.expiresAtMs) : null, expiresAtMs: l.expiresAtMs, fence: l.fence, scope: l.scope, slot: teile[2] };
    } catch { return null; }
  }

  function laufObjekt(data, run) {
    const lease = leaseFuerLauf(data, run);
    return basis("run", run.id, {
      jobId: run.id, date: run.date, slot: letzterSlot(run), state: run.phase,
      entityVersion: Number.isInteger(run.revision) ? run.revision : 0,
      createdAt: run.createdAt || null, updatedAt: run.updatedAt || null,
      leaseExpiresAt: lease ? lease.expiresAt : null,
    });
  }
  function briefingObjekt(data, run) {
    return basis("briefing", run.id, { jobId: run.id, date: run.date, state: run.phase, entityVersion: Number.isInteger(run.revision) ? run.revision : 0, updatedAt: run.updatedAt || null });
  }
  function laufKontextScope(data, run) {
    return basis("run_context", run.id, { runId: run.id, jobId: run.id, entityVersion: Number.isInteger(run.revision) ? run.revision : 0 });
  }
  function laufStatusObjekt(data, run) {
    // Der echte gemeinsame B-Status ueber den GANZEN Bestand: die Ampel
    // (bzw. ihre Zwischenspeicherung, nur bei passender Revision).
    const jetzt = now();
    let bewertung = null;
    const cache = istKarte(run.finalEvaluation) ? run.finalEvaluation : null;
    if (cache && B.isEvaluationCurrent(cache, { run, data, now: jetzt, policy: POLICY }).current === true) bewertung = { coverage: cache.coverage, operations: cache.operations, cached: true };
    else {
      const e = B.dailyAssistantTrafficLight(run, data, jetzt, POLICY);
      bewertung = { coverage: e.coverage, operations: e.operations, cached: false };
    }
    const offeneFragen = Object.values(data.automation.questionsById).filter((q) => istKarte(q) && q.status === "open"
      && (q.runDate === run.date || (Array.isArray(run.itemRefs) && run.itemRefs.some((r) => r && r.sourceType === q.sourceType && r.sourceId === q.sourceId)))).length;
    return basis("run_status", "status_" + run.date, {
      runId: run.id, jobId: run.id, state: run.phase, stage: letzterSlot(run),
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
    const version = z.unmigrated || z.versionInvalid ? null : z.version;
    const warte = data.automation.waitingById[sourceType + ":" + id] || null;
    const offeneFrage = Object.values(data.automation.questionsById).find((q) => istKarte(q) && q.status === "open" && q.sourceType === sourceType && q.sourceId === id) || null;
    return basis(kind, id, {
      sourceType, jobId: laufFuerQuelle(data, sourceType, id),
      title: sourceType === "chatgptTask" ? String(e.text || "") : String(e.title || ""),
      state: z.unmigrated ? "unmigrated" : z.unmapped ? "unmapped" : z.state,
      entityVersion: version, updatedAt: e.updatedAt || null,
      waitUntil: warte ? warte.followUpAt : null, openQuestionId: offeneFrage ? offeneFrage.id : null,
      dueAt: sourceType === "task" && e.dueDate ? String(e.dueDate).slice(0, 10) : null,
      leadId: sourceType === "chatgptLead" ? id : null,
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
  function auftragObjekt(data, id) {
    const j = data.automation.jobsById[id];
    if (!istKarte(j)) return null;
    return basis("assignment", id, { jobId: laufFuerJob(data, j), runId: laufFuerJob(data, j), workerKind: j.executor, state: j.state, entityVersion: kartenVersion(j), dueAt: j.expiresAt || null, sourceType: j.sourceType, sourceId: j.sourceId });
  }
  function ergebnisObjekt(data, resultRef) {
    const treffer = Object.values(data.automation.jobsById).filter((j) => istKarte(j) && istKarte(j.result) && j.result.ref === resultRef);
    if (treffer.length !== 1) return null;
    const j = treffer[0];
    return basis("worker_result", resultRef, { jobId: laufFuerJob(data, j), assignmentId: j.id, state: j.review ? "reviewed:" + j.review.verdict : j.state, entityVersion: kartenVersion(j), updatedAt: (j.review && j.review.reviewedAt) || j.returnedAt || null });
  }
  function kommentare(data, leadId) {
    const l = data.entities.chatgptLeads[leadId];
    if (!istKarte(l) || !Array.isArray(l.comments)) return [];
    return l.comments.filter((c) => istKarte(c) && typeof c.id === "string" && c.id).map((c) => basis("note", c.id, {
      jobId: laufFuerQuelle(data, "chatgptLead", leadId), leadId, runId: laufFuerQuelle(data, "chatgptLead", leadId),
      text: String(c.text || ""), createdAt: c.createdAt || null, author: typeof c.author === "string" ? c.author : (typeof c.by === "string" ? c.by : null),
      entityVersion: kartenVersion(c),
    })).sort((a, b) => nachText(String(b.createdAt || ""), String(a.createdAt || "")) || nachId(a, b));
  }
  function notizObjekt(data, id) {
    for (const leadId of Object.keys(data.entities.chatgptLeads)) {
      const n = kommentare(data, leadId).find((c) => c.id === id);
      if (n) return n;
    }
    return null;
  }
  function policyObjekt() {
    return basis("policy", "policy_" + POLICY.version, { jobId: null, policyVersion: POLICY.version, mode: modus, entityVersion: 1, updatedAt: null, limits: { maxWaitDays: POLICY.maxWaitDays } });
  }
  function laufKontextEintraege(data, run) {
    const out = [];
    for (const ref of Array.isArray(run.itemRefs) ? run.itemRefs : []) {
      if (!istKarte(ref) || !B.QUELLEN[ref.sourceType]) continue;
      const e = B.quelleFinden(data, ref.sourceType, ref.sourceId);
      if (!e) continue;
      const z = B.effektiverZustand(ref.sourceType, e);
      const belege = Object.values(data.automation.evidenceById).filter((ev) => istKarte(ev) && ev.sourceType === ref.sourceType && ev.sourceId === ref.sourceId).map((ev) => ev.id).sort();
      out.push(basis("run_context", "ctx_" + ref.sourceType + "_" + ref.sourceId, {
        runId: run.id, jobId: run.id, sourceType: ref.sourceType, sourceId: ref.sourceId,
        title: ref.sourceType === "chatgptTask" ? String(e.text || "") : String(e.title || ""),
        text: ref.sourceType === "chatgptLead" ? String(e.rawInput || "") : "",
        entityVersion: z.unmigrated || z.versionInvalid ? null : z.version, updatedAt: e.updatedAt || null, evidenceRefs: belege,
      }));
    }
    return out.sort(nachId);
  }

  function objektLaden(data, kind, id) {
    switch (kind) {
      case "run": { const r = laufNachId(data, id); return r ? laufObjekt(data, r) : null; }
      case "briefing": { const r = laufNachId(data, id); return r ? briefingObjekt(data, r) : null; }
      case "run_context": { const r = laufNachId(data, id); return r ? laufKontextScope(data, r) : null; }
      case "run_status": {
        const m = /^status_(\d{4}-\d{2}-\d{2})$/.exec(String(id));
        const r = m ? laufNachDatum(data, m[1]) : null;
        return r ? laufStatusObjekt(data, r) : null;
      }
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
  function loadObject(snapshot, { kind, id } = {}) {
    if (typeof id !== "string" || !id) return null;
    const data = kernLesen(snapshot);
    if (!data) return null;   // siehe Doku: der Dienst faengt loadObject nicht — ein kaputter Kern ist hier "nicht gefunden"
    return objektLaden(data, String(kind || ""), id);
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
    const data = B.requireCore(snapshot);   // wirft CORE_* → der Dienst antwortet 503 domain_adapter_failed
    if (!Number.isInteger(pageSize) || pageSize < 1) throw fail("invalid_request", "page_size_invalid", 400);
    const rolle = String(principal?.role || "");
    switch (query) {
      case "run.context": {
        const run = laufNachId(data, scopeId);
        if (!run) return { items: [], hasMore: false, nextAfterId: null, aborted: true, abortReason: "scope_not_found" };
        let eintraege = laufKontextEintraege(data, run);
        if (ROLE_EXECUTOR[rolle]) {
          // Spezialisten sehen NUR den Kontext ihrer aktiven Auftraege dieses Laufs.
          const erlaubt = new Set();
          for (const j of Object.values(data.automation.jobsById)) {
            if (!istKarte(j) || j.executor !== ROLE_EXECUTOR[rolle] || !["queued", "running"].includes(j.state) || laufFuerJob(data, j) !== run.id) continue;
            erlaubt.add(j.sourceType + ":" + j.sourceId);
            for (const r of Array.isArray(j.contextRefs) ? j.contextRefs : []) if (istKarte(r)) erlaubt.add(r.sourceType + ":" + r.sourceId);
          }
          eintraege = eintraege.filter((x) => erlaubt.has(x.sourceType + ":" + x.sourceId));
        }
        return seite(eintraege, { pageSize, afterId });
      }
      case "lead.context": {
        const l = leadObjekt(data, scopeId);
        return seite(l ? [l] : [], { pageSize, afterId });
      }
      case "notes.recent": return seite(kommentare(data, scopeId), { pageSize, afterId });
      case "run.queue": return seite(laeufe(data).map((r) => laufObjekt(data, r)), { pageSize, afterId });
      case "run.status": return seite(laeufe(data).map((r) => laufStatusObjekt(data, r)), { pageSize, afterId });
      case "policy.current": return seite([policyObjekt()], { pageSize, afterId });
      default: throw fail("invalid_request", "query_unknown:" + String(query), 400);
    }
  }

  /* ── Ziel aufloesen (je CAS-Versuch, frisch) ────────────────────────── */
  function resolveTarget(snapshot, { verb, command, principal, descriptor } = {}) {
    const data = kernLesen(snapshot);
    if (!data) throw fail("core_invalid", "core_invalid", 503);
    if (!VERB_BINDINGS[verb] || !descriptor) return null;
    const p = command.payload || {};
    const res = descriptor.resource;
    const ankerArt = descriptor.anchor.self ? res.kind : descriptor.anchor.kind;
    const ankerId = descriptor.anchor.self ? null : (descriptor.anchor.idField ? String(p[descriptor.anchor.idField] || "") : String(command.jobId || ""));
    const ctxId = { tenant, principal, command };

    let ressource = null;
    if (res.idField) {
      ressource = objektLaden(data, res.kind, String(p[res.idField] || ""));
    } else if (res.creates) {
      const neu = (id, extra = {}) => basis(res.kind, id, { jobId: command.jobId, isNew: true, entityVersion: 0, ...extra });
      switch (verb) {
        case "intake.create": ressource = neu(abgeleiteteId("intake", ctxId)); break;
        case "task.create": ressource = neu(abgeleiteteId("task", ctxId), { leadId: p.leadId }); break;
        case "briefing.answer": ressource = neu(abgeleiteteId("answer", ctxId), { briefingId: p.briefingId, questionId: p.questionId }); break;
        case "question.create": ressource = neu(abgeleiteteId("question", ctxId), { leadId: p.leadId }); break;
        case "document.register": ressource = neu(String(p.documentId || "")); break;
        case "worker.assign": ressource = neu(String(p.assignmentId || "")); break;
        case "worker.return": ressource = neu(String(p.resultRef || ""), { assignmentId: p.assignmentId }); break;
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
      anker = objektLaden(data, ankerArt, ankerId);
      if (!anker) return null;
    }
    return { resource: ressource, anchor: anker };
  }

  /* ── Aktive Bindung (E1-Lease bzw. Auftrag), je CAS-Versuch ─────────── */
  function assertActiveBinding({ snapshot, principal, resource, anchor, jobId, nowMs } = {}) {
    const data = kernLesen(snapshot);
    if (!data) return { ok: false, reason: "core_invalid" };
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return { ok: false, reason: "now_missing" };
    if (String(principal?.tenant || "") !== tenant) return { ok: false, reason: "tenant_mismatch" };
    const rolle = String(principal?.role || "");
    switch (rolle) {
      case "user":
        return String(principal.id) === ownerId ? { ok: true } : { ok: false, reason: "not_household_owner" };
      case "scheduler":
      case "backend_checker":
        return { ok: true };
      case "lead_agent": {
        // Leitung nur mit aktiver E1-Lease fuer diesen Lauf — durch E1 geprueft.
        const run = laufNachId(data, String(jobId || ""));
        if (!run) return { ok: false, reason: "run_not_found" };
        let lease;
        try { E1.readRuntime(data); lease = data.automation.activeLease; } catch (e) { throw uebersetzeE1(e); }
        if (!istKarte(lease)) return { ok: false, reason: "lease_absent" };
        let urteil;
        try { urteil = E1.checkLeadership(data, { holder: String(principal.id), scope: String(lease.scope), fence: lease.fence }, nowMs); } catch (e) { throw uebersetzeE1(e); }
        if (!urteil.ok) return { ok: false, reason: String(urteil.code || "lease_not_held") };
        const teile = String(lease.scope).split(":");
        if (teile.length !== 4 || teile[0] !== tenant || teile[1] !== run.date || teile[3] !== POLICY.version) return { ok: false, reason: "lease_scope_mismatch" };
        return { ok: true };
      }
      case "specialist_claude":
      case "specialist_gemini": {
        const auftragId = anchor && anchor.kind === "assignment" ? anchor.id : (resource && resource.kind === "assignment" ? resource.id : null);
        const j = auftragId ? data.automation.jobsById[auftragId] : null;
        if (!istKarte(j)) return { ok: false, reason: "assignment_not_found" };
        if (j.executor !== ROLE_EXECUTOR[rolle]) return { ok: false, reason: "assignment_foreign_executor" };
        if (!["queued", "running"].includes(j.state)) return { ok: false, reason: "assignment_not_active:" + String(j.state) };
        const ablauf = B.msAus(j.expiresAt);
        if (!Number.isFinite(ablauf) || ablauf <= nowMs) return { ok: false, reason: "assignment_expired" };
        if (laufFuerJob(data, j) !== String(jobId || "")) return { ok: false, reason: "assignment_run_mismatch" };
        return { ok: true };
      }
      default:
        return { ok: false, reason: "unknown_role" };
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

  /* ── Wirkung (im CAS-Mutator, ueber den Idempotenz-Umschlag) ────────── */
  function applyVerb(snapshot, befehl, kontext, ziel = {}) {
    const verb = String(befehl?.verb || "");
    const bindung = VERB_BINDINGS[verb];
    if (!bindung) throw fail("invalid_request", "verb_unknown", 400);
    if (bindung.gap) throw fail("invalid_request", "verb_not_bound:" + verb + ":" + bindung.gap, 400);
    const { principal, resource, anchor } = ziel;
    const nowMs = Date.parse(String(kontext?.now || ""));
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || typeof kontext?.requestId !== "string" || !kontext.requestId) throw fail("core_invalid", "prepared_context_invalid", 503);
    const data = B.requireCore(snapshot);
    const p = befehl.payload || {};
    const rolle = String(principal?.role || "");
    const actor = { kind: ROLE_ACTOR_KIND[rolle], id: String(principal?.id || "") };
    if (!actor.kind || !actor.id) throw fail("forbidden", "principal_role_unknown", 403);
    const reducer = B.commandReducer({ policy: POLICY, actor });
    const ausfuehren = (type, payload) => {
      try { return reducer(data, { type, payload }, kontext); } catch (e) { throw uebersetzeB(e); }
    };
    const verbiete = (feld, grund) => { if (p[feld] !== undefined && p[feld] !== null) throw fail("invalid_request", grund, 400); };

    let r;            // { data, result }
    let ids = [];     // Objekte, deren Versionen zurueckgemeldet werden: [kind, id]
    switch (verb) {
      case "intake.create": {
        verbiete("evidenceRefs", "field_not_bound:evidenceRefs:registerIntake_has_no_evidence");
        const text = p.text ? String(p.title) + "\n" + String(p.text) : String(p.title);
        r = ausfuehren("registerIntake", { intakeId: resource.id, text, channel: String(p.source) });
        ids = [["intake", resource.id]];
        break;
      }
      case "intake.accept": {
        const payload = { sourceType: "intake", sourceId: String(p.intakeId), state: "done" };
        if (p.leadId) payload.linkTo = { sourceType: "chatgptLead", sourceId: String(p.leadId) };
        else payload.reason = "intake.accept";
        r = ausfuehren("transitionState", payload);
        ids = [["intake", String(p.intakeId)]];
        break;
      }
      case "lead.transition": {
        if (!B.OPERATIONAL_STATES.includes(p.toState)) throw fail("invalid_request", "to_state_unknown", 400);
        if (B.WARTE_ZUSTAENDE.includes(p.toState)) throw fail("invalid_request", "use_lead_schedule_for_waiting", 400);
        const payload = { sourceType: "chatgptLead", sourceId: String(p.leadId), state: p.toState, expectedVersion: befehl.expectedEntityVersion };
        if (p.reason) payload.reason = String(p.reason);
        const beleg = belegAus(data, p.evidenceRefs, { pflicht: false });
        if (beleg) { if (beleg.kind === "question") throw fail("invalid_request", "evidence_ref_kind_not_closing:question", 400); payload.evidence = beleg; }
        r = ausfuehren("transitionState", payload);
        ids = [["lead", String(p.leadId)]];
        break;
      }
      case "lead.schedule": {
        verbiete("reason", "field_not_bound:reason:setWaiting_has_no_reason");
        const beleg = belegAus(data, p.evidenceRefs, { pflicht: true });
        if (beleg.kind === "answer") throw fail("invalid_request", "evidence_ref_kind_not_waiting:answer", 400);
        const state = beleg.kind === "job" ? "delegated" : beleg.kind === "question" ? "waiting_user" : "waiting_external";
        if (p.followUpAt && p.followUpAt !== p.waitUntil) throw fail("invalid_request", "wait_until_follow_up_conflict", 400);
        r = ausfuehren("setWaiting", {
          sourceType: "chatgptLead", sourceId: String(p.leadId), expectedVersion: befehl.expectedEntityVersion, state,
          counterparty: String(p.counterparty), nextAction: String(p.nextAction), followUpAt: String(p.waitUntil), evidence: beleg,
        });
        ids = [["lead", String(p.leadId)]];
        break;
      }
      case "briefing.answer": {
        verbiete("decision", "field_not_bound:decision:recordAnswer_has_no_decision");
        const q = data.automation.questionsById[String(p.questionId)];
        if (!istKarte(q)) throw fail("invalid_request", "QUESTION_NOT_FOUND", 400);
        if (q.runDate && "run_" + q.runDate !== String(p.briefingId)) throw fail("invalid_request", "briefing_question_mismatch", 400);
        r = ausfuehren("recordAnswer", { answerId: resource.id, questionId: String(p.questionId), text: String(p.answer) });
        ids = [["briefing_answer", resource.id], ["question", String(p.questionId)]];
        break;
      }
      case "briefing.consumeAnswer": {
        const a = data.automation.answersById[String(p.answerId)];
        const q = istKarte(a) ? data.automation.questionsById[a.questionId] : null;
        if (istKarte(q) && q.runDate && "run_" + q.runDate !== String(p.briefingId)) throw fail("invalid_request", "briefing_answer_mismatch", 400);
        r = ausfuehren("consumeAnswer", { answerId: String(p.answerId), consumer: actor.id });
        ids = [["briefing_answer", String(p.answerId)]];
        break;
      }
      case "question.create": {
        verbiete("options", "field_not_bound:options:askQuestion_has_no_options");
        const run = laufNachId(data, String(befehl.jobId || ""));
        r = ausfuehren("askQuestion", { questionId: resource.id, sourceType: "chatgptLead", sourceId: String(p.leadId), text: String(p.text), date: run ? run.date : undefined });
        ids = [["question", resource.id], ["lead", String(p.leadId)]];
        break;
      }
      case "question.resolve": {
        const answerId = abgeleiteteId("answer", { tenant, principal, command: befehl });
        r = ausfuehren("recordAnswer", { answerId, questionId: String(p.questionId), text: String(p.answer) });
        ids = [["question", String(p.questionId)], ["briefing_answer", answerId]];
        break;
      }
      case "worker.review": {
        if (p.verdict === "revise") throw fail("invalid_request", "verdict_not_bound:revise:reviewJobResult_knows_accepted_rejected", 400);
        const erg = ergebnisObjekt(data, String(p.resultId));
        if (!erg) throw fail("invalid_request", "worker_result_not_found", 400);
        const payload = { jobId: erg.assignmentId, verdict: p.verdict, reviewer: actor.id };
        if (p.notes) payload.note = String(p.notes);
        r = ausfuehren("reviewJobResult", payload);
        ids = [["worker_result", String(p.resultId)], ["assignment", erg.assignmentId]];
        break;
      }
      case "run.ensure": {
        if (!SLOT_VON_C2[p.slot]) throw fail("invalid_request", "slot_unknown", 400);
        if ("run_" + String(p.date) !== String(befehl.jobId)) throw fail("invalid_request", "run_id_date_mismatch", 400);
        r = ausfuehren("ensureRun", { date: String(p.date) });
        ids = [["run", "run_" + String(p.date)]];
        break;
      }
      case "run.claim":
      case "run.renew": {
        const run = laufNachId(data, String(befehl.jobId || ""));
        if (!run) throw fail("invalid_request", "RUN_MISSING", 400);
        const ttlMs = Number(p.leaseSeconds) * 1000;
        let e1;
        try {
          if (verb === "run.claim") {
            const slot = B.aktuellerSlot(nowMs);
            if (slot.date !== run.date) throw fail("stale_entity_version", "run_not_current_day", 409);
            e1 = E1.acquireLease(data, { holder: actor.id, scope: B.slotKey(tenant, run.date, slot.slot, POLICY.version), ttlMs, now: nowMs });
          } else {
            E1.readRuntime(data);
            const lease = data.automation.activeLease;
            if (!istKarte(lease)) throw fail("stale_entity_version", "lease:lease_absent", 409);
            if (String(lease.holder) !== actor.id) throw fail("stale_entity_version", "lease:lease_foreign_holder", 409);
            // Der Fence wird hier aus dem gespeicherten Lease gelesen — C2 traegt keinen (Luecke FENCE_NOT_PRESENTED_BY_C2).
            e1 = E1.renewLease(data, { holder: actor.id, fence: lease.fence, scope: String(lease.scope), ttlMs, now: nowMs });
          }
        } catch (e) { throw typeof e?.reason === "string" ? e : uebersetzeE1(e); }   // eigene fail()-Fehler durchreichen, E1-Fehler uebersetzen
        if (!e1 || !e1.result || e1.result.ok !== true) throw fail("stale_entity_version", "lease:" + String(e1?.result?.code || "rejected"), 409);
        r = { data: e1.data, result: { fence: e1.result.fence ?? null, acquired: e1.result.acquired ?? null, renewed: e1.result.renewed ?? null, expiresAtMs: e1.result.lease ? e1.result.lease.expiresAtMs : null, duplicate: e1.result.duplicate ?? false, noop: e1.unchanged === true } };
        ids = [["run", run.id]];
        break;
      }
      case "run.finalize": {
        if (p.outcome !== "complete") throw fail("invalid_request", "outcome_not_bound:" + String(p.outcome) + ":closeRun_only_closes_green_runs", 400);
        const run = laufNachId(data, String(befehl.jobId || ""));
        if (!run) throw fail("invalid_request", "RUN_MISSING", 400);
        r = ausfuehren("closeRun", { date: run.date, finalNoteId: p.summaryRef ? String(p.summaryRef) : "note_final_" + run.date });
        ids = [["run", run.id]];
        break;
      }
      default:
        throw fail("invalid_request", "verb_not_bound:" + verb + ":unexpected", 400);
    }

    // Versionen NACH der Wirkung, aus dem Ergebnisbestand gelesen — nichts geschaetzt.
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
    return { data: r.data, result: { entityVersions, verb, command: bindung.command, effect } };
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
  const e1 = ports.runtimeState !== undefined ? ports.runtimeState : E1_MODUL;
  if (!e1 || !E1_METHODEN.every((m) => typeof e1[m] === "function")) fehlend.push("quantus-v3-runtime-state.mjs");
  return { ok: fehlend.length === 0, missing: fehlend };
}

export default { createQuantusV3DomainAdapter, describeDomainPorts, VERB_BINDINGS, DOMAIN_PORT_VARS, ADAPTER_VERSION };
