/* ══ E2 — der kurze HTTP-Worker ═══════════════════════════════════════════
 *
 * Zwei Einstiege:
 *   POST /v3/slot/start     vom Cloud Scheduler (vier benannte Jobs)
 *   POST /v3/run/continue   von Cloud Tasks (Fortsetzung nach Checkpoint)
 *
 * Alle fachlichen Entscheidungen kommen aus E1
 * (`quantus-v3-runtime-state.mjs`). Hier steht nur der Umschlag — und drei
 * Dinge, die die unabhaengige E2-Pruefung erzwungen hat:
 *
 *  1. EXKLUSIVITAET VOR DEM EXTERNEN AUFRUF. Der Besitz wird je VERSUCH
 *     genommen, nicht je Dienst: der Besitzername traegt die Kennung
 *     dieser Anfrage. Zwei gleichzeitige, gleich gueltige Zustellungen
 *     bekommen damit verschiedene Besitzer, und die zweite erhaelt ehrlich
 *     409 `already_running` — statt in denselben Abschnitt zu laufen. Ein
 *     noch lebender Vorgaenger wird NIE uebernommen; eine Uebernahme gibt
 *     es erst, wenn seine Sperre abgelaufen ist, und sie setzt die Arbeit
 *     nicht fort, sondern oeffnet eine Ausnahme: was waehrend eines
 *     externen Aufrufs geschah, weiss dieser Prozess nicht.
 *
 *  2. KEIN ERFUNDENES GRUEN. `completed` verlangt einen streng geprueften
 *     Abschlussnachweis aus einem eigenen Port — mit Lauf, Mandant,
 *     Policy-Version, Fence, vollstaendigem Quellensatz und der
 *     Datenrevision, gegen die im selben CAS abgeglichen wird. Fehlt der
 *     Port oder der Nachweis, endet der Lauf ehrlich unvollstaendig.
 *
 *  3. ERNEUERUNG UND ABBRUCH WAEHREND DES AUFRUFS. Die Lease wird
 *     spaetestens zum `renewByMs` des Datensatzes erneuert (60 s), auch
 *     waehrend ein langer `sectionWork`-Aufruf laeuft. Der Aufruf bekommt
 *     ein Abbruchsignal und eine harte Frist; laeuft er darueber hinaus,
 *     gilt sein Ausgang als UNKLAR und wird nicht wiederholt.
 * ═════════════════════════════════════════════════════════════════════════ */
import * as E1 from "../../../netlify/lib/quantus-v3-runtime-state.mjs";
import { HttpError, badRequest, conflict } from "./errors.mjs";
import { requireSchema } from "./schema.mjs";
import { resolveSlotOccurrence, SLOT_NAMES } from "./slot-window.mjs";
import { continuationTaskId } from "./task-names.mjs";

export const SLOT_START_REQUEST = Object.freeze({
  type: "object",
  required: ["slot"],
  properties: { slot: { type: "string", enum: [...SLOT_NAMES] } },
});

export const RUN_CONTINUE_REQUEST = Object.freeze({
  type: "object",
  required: ["runKey", "continuationId"],
  properties: {
    runKey: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}:\\d{4}-\\d{2}-\\d{2}:[a-z0-9]{1,24}:[A-Za-z0-9._-]{1,32}$", maxLength: 200 },
    continuationId: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" },
  },
});

export const RUN_RESPONSE = Object.freeze({
  type: "object",
  required: ["outcome", "runKey", "mode", "sectionId"],
  properties: {
    outcome: { type: "string", enum: ["duplicate", "checkpointed", "finished", "exception_open"] },
    runKey: { type: "string", maxLength: 200 },
    sectionId: { type: "string", maxLength: 200 },
    mode: { type: "string", enum: ["dry_run", "shadow", "live"] },
    steps: { type: "integer", minimum: 0, maximum: 1000 },
    green: { type: "boolean" },
    continuationId: { type: "string", maxLength: 200 },
    taskId: { type: "string", maxLength: 500 },
    enqueued: { type: "boolean" },
    duplicateTask: { type: "boolean" },
    reason: { type: "string", maxLength: 120 },
    providerOutcome: { type: "string", enum: ["complete", "unknown"] },
    evidenceRef: { type: "string", maxLength: 200 },
  },
});

export const MAX_TASK_RETRIES = 5;
/* Erneuert wird spaetestens zum `renewByMs` des Datensatzes (60 s bei
 * 120 s Laufzeit). Das kleine Polster deckt nur die Laufzeit des
 * Schreibvorgangs selbst ab — es verschiebt die Frist nicht nach hinten. */
export const LEASE_RENEW_SAFETY_MS = 5_000;
/* Ein Abschlussnachweis, der aelter ist als das, gilt als veraltet. */
export const CLOSURE_EVIDENCE_MAX_AGE_MS = 60_000;

/* ── Kern ─────────────────────────────────────────────────────────────── */

async function mutate(ctx, commandKey, mutator) {
  const core = ctx.ports.require("core");
  const out = await core.mutate({ commandKey, requestId: ctx.requestId, now: ctx.now, mutate: mutator });
  if (!out || typeof out !== "object" || !Object.hasOwn(out, "result")) {
    throw new HttpError(502, "core_response_invalid", { commandKey });
  }
  return out;
}

async function readRunState(ctx, runKey) {
  const core = ctx.ports.require("core");
  const snapshot = await core.read();
  if (!snapshot || typeof snapshot !== "object" || !snapshot.data) {
    throw new HttpError(502, "core_response_invalid", { call: "read" });
  }
  const runtime = E1.readRuntime(snapshot.data);
  const run = runtime.runsByKey ? runtime.runsByKey[runKey] : undefined;
  const base = { dataRevision: snapshot.data.automation.dataRevision };
  if (!run || typeof run !== "object") {
    return { ...base, phase: null, pendingContinuationId: null, green: false, openSection: null, checkpointCursor: null };
  }
  const sections = run.sections && typeof run.sections === "object" ? run.sections : {};
  const offen = run.currentSectionId ? sections[run.currentSectionId] : null;
  return {
    ...base,
    phase: run.phase,
    pendingContinuationId: run.pendingContinuationId || null,
    green: run.green === true,
    checkpointCursor: run.checkpoint && run.checkpoint.cursor ? run.checkpoint.cursor : null,
    openSection: offen && offen.closed !== true
      ? { id: offen.id, fence: offen.fence, holder: offen.holder, startedAtMs: offen.startedAtMs, toolSteps: offen.toolSteps || 0 }
      : null,
  };
}

/* ── Besitz: je VERSUCH, nicht je Dienst ──────────────────────────────── */

/* Zwei gleichzeitige Zustellungen desselben Slots sind zwei Versuche. Sie
 * duerfen sich nicht denselben Besitz teilen, sonst laufen beide in
 * denselben Abschnitt. Der Besitzername traegt deshalb die Kennung dieser
 * Anfrage. */
export function attemptHolder(ctx) {
  const holder = `${ctx.config.leaseHolder}:${ctx.requestId}`;
  if (holder.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(holder)) {
    throw new HttpError(500, "lease_holder_invalid", { length: holder.length });
  }
  return holder;
}

function verifiedScopeOf(ctx, fence) {
  return { holder: attemptHolder(ctx), fence, scope: ctx.config.leaseScope };
}

async function renewLease(ctx, commandKey, fence) {
  const clock = ctx.ports.require("clock");
  const out = await mutate(ctx, commandKey, (data) => E1.renewLease(data, {
    holder: attemptHolder(ctx), scope: ctx.config.leaseScope,
    fence, ttlMs: E1.LEASE_TTL_MS, now: clock.now(),
  }));
  if (!out.result.ok) return { ok: false, code: out.result.code };
  return { ok: true, expiresAtMs: out.result.lease.expiresAtMs, renewByMs: out.result.lease.renewByMs };
}

/* Exklusiv beanspruchen — VOR jedem externen Aufruf. Ein fremder, noch
 * lebender Besitzer ist kein Konflikt zum Aufloesen, sondern die ehrliche
 * Antwort "laeuft gerade". */
async function acquireAttemptLease(ctx) {
  const holder = attemptHolder(ctx);
  const out = await mutate(ctx, `attempt-lease:${holder}`, (data) => E1.acquireLease(data, {
    holder, scope: ctx.config.leaseScope, ttlMs: E1.LEASE_TTL_MS, now: ctx.now,
  }));
  if (!out.result.ok) {
    if (out.result.code === "lease_held" || out.result.code === "lease_scope_busy") {
      const bis = out.result.detail && out.result.detail.expiresAtMs;
      throw new HttpError(409, "already_running", {
        retryAfterMs: Number.isSafeInteger(bis) ? Math.max(0, bis - ctx.now) : E1.LEASE_TTL_MS,
        hint: "Ein anderer Versuch haelt den Besitz. Spaeter erneut zustellen.",
      });
    }
    throw conflict("lease_conflict", { code: out.result.code, detail: out.result.detail ?? null });
  }
  const lease = out.result.lease;
  return {
    fence: out.result.fence,
    expiresAtMs: lease.expiresAtMs,
    renewByMs: lease.renewByMs,
    takeoverFrom: out.result.takeoverFrom ?? null,
  };
}

async function releaseAttemptLease(ctx, fence) {
  try {
    await mutate(ctx, `attempt-release:${attemptHolder(ctx)}:${fence}`, (data) => E1.releaseLease(data, {
      holder: attemptHolder(ctx), scope: ctx.config.leaseScope, fence, now: ctx.ports.require("clock").now(),
    }));
  } catch {
    // Der Besitz laeuft ohnehin ab. Ein gescheitertes Freigeben darf die
    // schon geschriebene Arbeit nicht zunichtemachen.
  }
}

/* ── Erneuerung und Abbruch waehrend eines langen Aufrufs ──────────────── */

function requireTimers(ctx) {
  const clock = ctx.ports.require("clock");
  if (typeof clock.setTimer !== "function") {
    throw new HttpError(503, "port_unavailable", { port: "clock", reason: "set_timer_missing" });
  }
  return clock;
}

/* Erneuert die Lease waehrend eines laufenden Aufrufs — spaetestens zum
 * `renewByMs` des Datensatzes, nicht erst kurz vor Ablauf. */
function startRenewalPump(ctx, lease, sectionId) {
  const clock = requireTimers(ctx);
  let gestoppt = false;
  let abbrechen = null;
  let laufend = Promise.resolve();
  let runde = 0;

  const planen = () => {
    if (gestoppt) return;
    const faellig = lease.renewByMs - LEASE_RENEW_SAFETY_MS;
    const warten = Math.max(0, faellig - clock.now());
    abbrechen = clock.setTimer(warten, () => {
      laufend = laufend.then(async () => {
        if (gestoppt || lease.lost) return;
        const r = await renewLease(ctx, `renew:${sectionId}:${runde++}`, lease.fence);
        if (!r.ok) { lease.lost = r.code; return; }
        lease.expiresAtMs = r.expiresAtMs;
        lease.renewByMs = r.renewByMs;
        lease.renewals = (lease.renewals || 0) + 1;
        planen();
      }).catch(() => { lease.lost = "renew_failed"; });
    });
  };
  planen();

  return {
    async stop() {
      gestoppt = true;
      if (abbrechen) abbrechen();
      await laufend;
    },
  };
}

const ABGEBROCHEN = Symbol("sectionWorkAborted");

/* Ruft `sectionWork.next` mit Abbruchsignal und harter Frist auf. Laeuft
 * der Aufruf darueber hinaus, wird nicht gewartet: sein Ausgang ist
 * unklar und wird NICHT wiederholt. */
async function callSectionWork(ctx, { runKey, sectionId, cursor, resumedFrom, deadlineAtMs, hardStopAtMs, lease }) {
  const clock = requireTimers(ctx);
  const sectionWork = ctx.ports.require("sectionWork");
  const controller = new AbortController();
  let abbruchGrund = null;
  let abbruchAusloesen = null;
  const abbruch = new Promise((resolve) => { abbruchAusloesen = resolve; });

  const jetzt = clock.now();
  const abbruchTimer = clock.setTimer(Math.max(0, (hardStopAtMs ?? deadlineAtMs) - jetzt), () => {
    abbruchGrund = "section_deadline";
    try { controller.abort(new Error("section_deadline")); } catch { /* AbortController ohne Grund */ }
    abbruchAusloesen(ABGEBROCHEN);
  });
  const pumpe = startRenewalPump(ctx, lease, sectionId);

  let fertig = false;
  let wert = null;
  let fehler = null;
  let arbeit;
  try {
    // Der Aufruf bekommt seine eigene Frist mit — und ein Signal, das er
    // beachten MUSS. Beachtet er es nicht, wird er aufgegeben.
    arbeit = Promise.resolve(sectionWork.next({
      runKey, sectionId, cursor, mode: ctx.config.mode,
      deadlineAtMs, now: jetzt, resumedFrom: resumedFrom ?? null,
      signal: controller.signal,
    })).then(
      (v) => { fertig = true; wert = v; },
      (e) => { fertig = true; fehler = e; },
    );
  } catch (err) {
    abbruchTimer();
    await pumpe.stop();
    throw err;
  }

  try {
    await Promise.race([arbeit, abbruch]);
    if (!fertig) {
      // Abbruch und Rueckkehr koennen im selben Moment liegen. Ein Aufruf,
      // der tatsaechlich zurueckgekommen ist, wird nicht verworfen — nur
      // ein wirklich haengender gilt als unklar.
      for (let runde = 0; runde < 8 && !fertig; runde++) await Promise.resolve();
    }
    if (fertig) {
      if (fehler) throw fehler;
      return { aborted: null, value: wert };
    }
    return { aborted: abbruchGrund || "section_deadline", value: null };
  } finally {
    abbruchTimer();
    await pumpe.stop();
  }
}

/* ── Der Abschnitt ────────────────────────────────────────────────────── */

async function runSection(ctx, { runKey, sectionId, lease, resumedFrom, cursor: startCursor = null }) {
  const clock = requireTimers(ctx);
  const scope = verifiedScopeOf(ctx, lease.fence);
  const deadlineAtMs = ctx.now + ctx.config.sectionDeadlineMs - ctx.config.sectionReserveMs;
  const hartAtMs = ctx.now + ctx.config.sectionDeadlineMs;

  let cursor = (startCursor && typeof startCursor === "object") ? startCursor : { position: 0 };
  let steps = 0;
  let stopReason = null;
  let providerOutcome = "complete";

  for (;;) {
    if (lease.lost) { stopReason = `lease_lost:${lease.lost}`; break; }
    const at = clock.now();
    if (at >= deadlineAtMs) { stopReason = "section_deadline"; break; }

    const aufruf = await callSectionWork(ctx, { runKey, sectionId, cursor, resumedFrom, deadlineAtMs, hardStopAtMs: hartAtMs, lease });
    if (aufruf.aborted) {
      // Der Aufruf lief ueber die Frist. Ob er etwas bewirkt hat, weiss
      // dieser Prozess nicht — also wird er nicht wiederholt.
      stopReason = aufruf.aborted;
      providerOutcome = "unknown";
      break;
    }
    if (lease.lost) { stopReason = `lease_lost:${lease.lost}`; providerOutcome = "unknown"; break; }

    const next = aufruf.value;
    if (!next || typeof next !== "object" || typeof next.done !== "boolean") {
      throw new HttpError(502, "section_work_response_invalid", { sectionId });
    }
    if (next.done) { stopReason = "work_done"; break; }
    if (typeof next.stepId !== "string" || !next.stepId) {
      throw new HttpError(502, "section_work_response_invalid", { sectionId, reason: "step_id" });
    }

    const recorded = await mutate(ctx, `step:${sectionId}:${next.stepId}`, (data) => E1.recordToolStep(data, {
      runKey, sectionId, stepId: next.stepId,
      durationMs: Number.isSafeInteger(next.durationMs) ? next.durationMs : 0,
      now: clock.now(), verifiedScope: scope,
    }));
    if (!recorded.result.ok) { stopReason = `step_rejected:${recorded.result.code}`; break; }
    if (recorded.result.duplicate === true) {
      // Derselbe Schritt noch einmal: sein Ausgang ist nicht belegt. Er
      // wird nicht ein zweites Mal ausgefuehrt.
      stopReason = "step_outcome_unknown";
      providerOutcome = "unknown";
      break;
    }
    steps += 1;
    cursor = next.cursor && typeof next.cursor === "object" ? next.cursor : cursor;
    if (recorded.result.mustCheckpoint) { stopReason = "budget"; break; }
    if (clock.now() >= hartAtMs) { stopReason = "section_deadline"; break; }
  }
  return { steps, stopReason, cursor, providerOutcome };
}

/* ── Abschlussnachweis ────────────────────────────────────────────────── */

/* Dieselbe Zeichenmenge und Laenge, die E1 fuer Kennungen zulaesst — eine
 * Referenz, die dort durchfaellt, soll hier schon mit klarem Grund
 * abgewiesen werden, nicht erst als `invalid_identifier`. */
const EVIDENCE_REF_RE = /^[A-Za-z0-9_.:-]{8,120}$/;

/* Streng, und ausdruecklich nicht aus etwas ableitbar, das dieser Prozess
 * selbst kennt. Die frueher hier erzeugte Kennung `run-evidence:<runKey>`
 * wird namentlich abgewiesen. */
export function validateClosureEvidence(evidence, expected) {
  const fehler = [];
  const record = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence);
  if (!record) return { ok: false, errors: ["closure_evidence_missing"] };
  if (evidence.runKey !== expected.runKey) fehler.push("run_key_mismatch");
  if (evidence.tenant !== expected.tenant) fehler.push("tenant_mismatch");
  if (evidence.policyVersion !== expected.policyVersion) fehler.push("policy_version_mismatch");
  if (evidence.fence !== expected.fence) fehler.push("fence_mismatch");
  if (!Number.isSafeInteger(evidence.dataRevision) || evidence.dataRevision < 0) fehler.push("data_revision_invalid");
  if (typeof evidence.evidenceRef !== "string" || !EVIDENCE_REF_RE.test(evidence.evidenceRef)) fehler.push("evidence_ref_invalid");
  else if (evidence.evidenceRef === `run-evidence:${expected.runKey}`) fehler.push("evidence_ref_self_invented");
  if (!Number.isSafeInteger(evidence.verifiedAtMs)) fehler.push("verified_at_invalid");
  else if (evidence.verifiedAtMs > expected.now) fehler.push("verified_in_future");
  else if (expected.now - evidence.verifiedAtMs > CLOSURE_EVIDENCE_MAX_AGE_MS) fehler.push("evidence_stale");

  const verlangt = expected.requiredSources;
  const gesehen = Array.isArray(evidence.sources) ? evidence.sources : null;
  if (!gesehen) fehler.push("sources_missing");
  else {
    const ok = new Set();
    for (const quelle of gesehen) {
      if (quelle === null || typeof quelle !== "object") { fehler.push("source_shape"); break; }
      if (typeof quelle.id !== "string" || !quelle.id) { fehler.push("source_shape"); break; }
      if (quelle.status !== "ok") { fehler.push(`source_not_ok:${quelle.id}`); continue; }
      if (!Number.isSafeInteger(quelle.checkedAtMs) || expected.now - quelle.checkedAtMs > CLOSURE_EVIDENCE_MAX_AGE_MS) {
        fehler.push(`source_stale:${quelle.id}`); continue;
      }
      ok.add(quelle.id);
    }
    const fehlend = verlangt.filter((id) => !ok.has(id));
    if (fehlend.length) fehler.push(`sources_incomplete:${fehlend.join(",")}`);
    const fremd = [...ok].filter((id) => !verlangt.includes(id));
    if (fremd.length) fehler.push(`sources_unexpected:${fremd.join(",")}`);
  }
  return { ok: fehler.length === 0, errors: fehler };
}

async function loadClosureEvidence(ctx, { runKey, fence }) {
  let port;
  try {
    port = ctx.ports.require("closureEvidence");
  } catch (err) {
    // Fehlender Nachweisport heisst nicht "dann eben gruen", sondern
    // "unvollstaendig" — der Lauf wird ehrlich als Ausnahme beendet.
    if (err instanceof HttpError && err.error === "port_unavailable") {
      return { evidence: null, verdict: { ok: false, errors: ["closure_evidence_port_unavailable"] } };
    }
    throw err;
  }
  if (typeof port.load !== "function") {
    return { evidence: null, verdict: { ok: false, errors: ["closure_evidence_port_unavailable"] } };
  }
  let evidence;
  try {
    evidence = await port.load({ runKey, fence, now: ctx.now, tenant: ctx.config.tenant });
  } catch {
    return { evidence: null, verdict: { ok: false, errors: ["closure_evidence_load_failed"] } };
  }
  const verdict = validateClosureEvidence(evidence, {
    runKey, fence, now: ctx.now,
    tenant: ctx.config.tenant,
    policyVersion: ctx.config.policyVersion,
    requiredSources: ctx.config.requiredSources,
  });
  return { evidence, verdict };
}

/* ── Checkpoint, Ausnahme, Abschluss ──────────────────────────────────── */

async function checkpointAndEnqueue(ctx, { runKey, sectionId, cursor, fence, reason }) {
  const scope = verifiedScopeOf(ctx, fence);
  const atMs = ctx.ports.require("clock").now();
  const checkpointId = `cp:${sectionId}`;
  const continuationId = `cont:${sectionId}`;
  const out = await mutate(ctx, `checkpoint:${checkpointId}`, (data) => E1.checkpointRunSection(data, {
    runKey, sectionId, checkpointId, continuationId,
    reason: reason.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "-"),
    cursor: cursor && typeof cursor === "object" ? cursor : {},
    now: atMs, verifiedScope: scope, notBeforeMs: atMs,
  }));
  if (!out.result.ok) throw conflict("checkpoint_rejected", { code: out.result.code });
  const enq = await enqueue(ctx, { runKey, continuationId, atMs });
  return { checkpointId, continuationId, ...enq };
}

async function enqueue(ctx, { runKey, continuationId, atMs }) {
  const taskId = continuationTaskId(runKey, continuationId);
  const tasks = ctx.ports.require("tasks");
  const enq = await tasks.enqueueContinuation({
    taskId, runKey, continuationId,
    scheduleAtMs: atMs ?? ctx.now,
    queue: ctx.config.tasks.queue,
    targetUrl: ctx.config.tasks.targetUrl,
    oidcServiceAccount: ctx.config.tasks.oidcServiceAccount,
    audience: ctx.config.tasks.audience,
  });
  if (!enq || typeof enq !== "object" || typeof enq.enqueued !== "boolean") {
    throw new HttpError(502, "task_enqueue_response_invalid", { taskId });
  }
  return { taskId, enqueued: enq.enqueued, duplicate: enq.duplicate === true };
}

async function openException(ctx, { runKey, sectionId, fence, exceptionId, reason, cursor }) {
  const scope = verifiedScopeOf(ctx, fence);
  const atMs = ctx.ports.require("clock").now();
  // Es gibt hoechstens EINE offene Fortsetzung je Lauf. Ist schon eine da,
  // wird sie weiterverwendet statt eine zweite anzulegen.
  const zustand = await readRunState(ctx, runKey);
  const continuationId = zustand.pendingContinuationId || `cont:${sectionId}`;
  const out = await mutate(ctx, `exception:${exceptionId}`, (data) => E1.openException(data, {
    runKey, exceptionId, reason: reason.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "-"),
    now: atMs, verifiedScope: scope, continuationId, notBeforeMs: atMs,
    cursor: cursor && typeof cursor === "object" ? cursor : {},
  }));
  if (!out.result.ok) throw conflict("exception_rejected", { code: out.result.code });
  let zustellung = { taskId: null, enqueued: false, duplicate: false };
  try { zustellung = await enqueue(ctx, { runKey, continuationId, atMs }); } catch { /* der Monitor stellt zu */ }
  return { continuationId, ...zustellung };
}

async function finishSection(ctx, { runKey, sectionId, fence, steps, cursor }) {
  const scope = verifiedScopeOf(ctx, fence);
  const atMs = ctx.ports.require("clock").now();
  const live = ctx.config.mode === "live";

  if (!live) {
    const out = await mutate(ctx, `finish:${runKey}`, (data) => E1.finishRun(data, {
      runKey, outcome: "dry_run", evidenceRef: null, runnerMode: "dry_run",
      now: atMs, verifiedScope: scope,
    }));
    if (!out.result.ok) throw conflict("finish_rejected", { code: out.result.code, detail: out.result.detail ?? null });
    return { status: 200, body: { outcome: "finished", runKey, sectionId, mode: ctx.config.mode, steps, green: false } };
  }

  // Live: ohne streng geprueften Nachweis gibt es kein Gruen. Die
  // Datenrevision wird IM SELBEN CAS abgeglichen — ein Nachweis fuer einen
  // aelteren Stand zaehlt nicht.
  for (let versuch = 0; versuch < 2; versuch++) {
    const { evidence, verdict } = await loadClosureEvidence(ctx, { runKey, fence });
    if (!verdict.ok) {
      const aus = await openException(ctx, {
        runKey, sectionId, fence, exceptionId: `closure:${sectionId}`,
        reason: "closure_evidence_invalid", cursor: { errors: verdict.errors.slice(0, 8) },
      });
      return {
        status: 200,
        body: {
          outcome: "exception_open", runKey, sectionId, mode: ctx.config.mode, steps, green: false,
          reason: `closure_evidence_invalid:${verdict.errors[0]}`.slice(0, 120),
          continuationId: aus.continuationId, taskId: aus.taskId ?? undefined,
          enqueued: aus.enqueued, duplicateTask: aus.duplicate,
        },
      };
    }
    const out = await mutate(ctx, `finish:${runKey}:${evidence.evidenceRef}`, (data) => {
      if (data.automation.dataRevision !== evidence.dataRevision) {
        return { data, result: { ok: false, code: "closure_evidence_stale_revision", detail: { expected: evidence.dataRevision, actual: data.automation.dataRevision } }, unchanged: true };
      }
      return E1.finishRun(data, {
        runKey, outcome: "completed", evidenceRef: evidence.evidenceRef, runnerMode: "live",
        now: atMs, verifiedScope: scope,
      });
    });
    if (out.result.ok) {
      return {
        status: 200,
        body: {
          outcome: "finished", runKey, sectionId, mode: ctx.config.mode, steps,
          green: out.result.green === true, evidenceRef: evidence.evidenceRef,
        },
      };
    }
    if (out.result.code !== "closure_evidence_stale_revision") {
      throw conflict("finish_rejected", { code: out.result.code, detail: out.result.detail ?? null });
    }
    // Der Stand hat sich bewegt: Nachweis einmal frisch holen.
  }
  const aus = await openException(ctx, {
    runKey, sectionId, fence, exceptionId: `closure-revision:${sectionId}`,
    reason: "closure_evidence_stale_revision", cursor: { steps },
  });
  return {
    status: 200,
    body: {
      outcome: "exception_open", runKey, sectionId, mode: ctx.config.mode, steps, green: false,
      reason: "closure_evidence_stale_revision",
      continuationId: aus.continuationId, taskId: aus.taskId ?? undefined,
      enqueued: aus.enqueued, duplicateTask: aus.duplicate,
    },
  };
}

/* ── Einstiege ────────────────────────────────────────────────────────── */

export async function handleSlotStart(ctx) {
  const body = requireSchema(ctx.body, SLOT_START_REQUEST, "slot_start_invalid");
  const occurrence = resolveSlotOccurrence(body.slot, ctx.now, {
    tenant: ctx.config.tenant,
    policyVersion: ctx.config.policyVersion,
    maxLatenessMs: ctx.config.slotMaxLatenessMs,
  });
  const runKey = occurrence.runKey;
  const sectionId = `start:${runKey}`;

  const vorher = await readRunState(ctx, runKey);
  const fertig = abgeschlossenerZustand(ctx, { runKey, sectionId, state: vorher, reason: "slot_start_replay" });
  if (fertig) return fertig;
  if (vorher.phase === "checkpointed" && vorher.pendingContinuationId) {
    return reenqueue(ctx, { runKey, sectionId, continuationId: vorher.pendingContinuationId, reason: "slot_start_replay" });
  }

  const lease = await acquireAttemptLease(ctx);
  try {
    const uebernahme = await uebernahmePruefen(ctx, { runKey, sectionId, lease, state: vorher });
    if (uebernahme) return uebernahme;

    const started = await mutate(ctx, `section:${sectionId}`, (data) => E1.startRunSection(data, {
      runKey, sectionId, kind: "http", budgetMs: ctx.config.sectionDeadlineMs,
      now: ctx.now, verifiedScope: verifiedScopeOf(ctx, lease.fence),
    }));
    if (!started.result.ok) return abschnittsAbsage(started.result, runKey);
    if (started.result.duplicate === true) {
      // Derselbe Abschnitt existiert schon und war nicht offen: es gibt
      // nichts mehr zu tun.
      return { status: 200, body: { outcome: "duplicate", runKey, sectionId, mode: ctx.config.mode, reason: "slot_start_replay" } };
    }
    return await advance(ctx, { runKey, sectionId, lease, resumedFrom: null });
  } finally {
    await releaseAttemptLease(ctx, lease.fence);
  }
}

export async function handleRunContinue(ctx) {
  const body = requireSchema(ctx.body, RUN_CONTINUE_REQUEST, "run_continue_invalid");
  const { runKey, continuationId } = body;

  const expectedTaskId = continuationTaskId(runKey, continuationId);
  const taskName = ctx.headers["x-cloudtasks-taskname"];
  if (typeof taskName !== "string" || taskName !== expectedTaskId) {
    throw badRequest("task_name_mismatch", { expected: expectedTaskId });
  }
  const queueName = ctx.headers["x-cloudtasks-queuename"];
  const expectedQueue = ctx.config.tasks.queue.split("/").pop();
  if (typeof queueName !== "string" || queueName !== expectedQueue) {
    throw badRequest("task_queue_mismatch", { expected: expectedQueue });
  }
  const retryCount = Number(ctx.headers["x-cloudtasks-taskretrycount"] ?? 0);
  if (!Number.isSafeInteger(retryCount) || retryCount < 0) throw badRequest("task_retry_count_invalid");

  // Der Initialisierungsnachweis und die Form des Kerns werden geprueft,
  // BEVOR irgendetwas geschrieben wird — auch auf diesem Weg.
  await readRunState(ctx, runKey);

  const delivered = await mutate(ctx, `delivery:${continuationId}:${retryCount}`, (data) => E1.recordContinuationDelivery(data, {
    continuationId, deliveryId: `${continuationId}:attempt-${retryCount}`, now: ctx.now,
  }));
  if (!delivered.result.ok) throw conflict("continuation_unknown", { code: delivered.result.code });
  if (delivered.result.work === false) {
    return { status: 200, body: { outcome: "duplicate", runKey, sectionId: `resume:${continuationId}`, mode: ctx.config.mode, reason: "continuation_already_consumed" } };
  }

  const sectionId = `resume:${continuationId}`;
  const lease = await acquireAttemptLease(ctx);
  try {
    if (retryCount >= MAX_TASK_RETRIES) {
      const aus = await openException(ctx, {
        runKey, sectionId, fence: lease.fence, exceptionId: `retries:${continuationId}`,
        reason: "task_retries_exhausted", cursor: { retryCount },
      });
      return { status: 200, body: { outcome: "exception_open", runKey, sectionId, mode: ctx.config.mode, green: false, reason: "task_retries_exhausted", continuationId: aus.continuationId } };
    }

    const zustand = await readRunState(ctx, runKey);
    const uebernahme = await uebernahmePruefen(ctx, { runKey, sectionId, lease, state: zustand });
    if (uebernahme) return uebernahme;

    const started = await mutate(ctx, `section:${sectionId}`, (data) => E1.startRunSection(data, {
      runKey, sectionId, kind: "http", budgetMs: ctx.config.sectionDeadlineMs,
      now: ctx.now, verifiedScope: verifiedScopeOf(ctx, lease.fence), resumeFrom: continuationId,
    }));
    if (!started.result.ok) return abschnittsAbsage(started.result, runKey);
    if (started.result.alreadyConsumed === true || started.result.duplicate === true) {
      return { status: 200, body: { outcome: "duplicate", runKey, sectionId, mode: ctx.config.mode, reason: "continuation_already_consumed" } };
    }
    return await advance(ctx, { runKey, sectionId, lease, resumedFrom: continuationId, cursor: zustand.checkpointCursor });
  } finally {
    await releaseAttemptLease(ctx, lease.fence);
  }
}

/* ── Gemeinsames ──────────────────────────────────────────────────────── */

function abgeschlossenerZustand(ctx, { runKey, sectionId, state, reason }) {
  if (state.phase === "finished") {
    return { status: 200, body: { outcome: "duplicate", runKey, sectionId, mode: ctx.config.mode, green: state.green, reason } };
  }
  if (state.phase === "exception_open") {
    return { status: 200, body: { outcome: "exception_open", runKey, sectionId, mode: ctx.config.mode, green: false, reason } };
  }
  return null;
}

function abschnittsAbsage(result, runKey) {
  if (result.code === "late_hard_stop") throw conflict("slot_window_closed", { runKey, code: result.code });
  if (result.code === "section_already_open") {
    // Wir halten den Besitz, und trotzdem ist ein Abschnitt offen: das
    // kann nur ein Vorgaenger sein, dessen Sperre noch nicht abgelaufen
    // war, als er starb. Ehrlich als "laeuft" melden statt uebernehmen.
    throw new HttpError(409, "already_running", { runKey, openSectionId: result.detail?.openSectionId ?? null });
  }
  throw conflict("section_rejected", { code: result.code, detail: result.detail ?? null });
}

/* Ein offener Abschnitt eines FRUEHEREN Besitzers. Weil wir den Besitz nur
 * bekommen haben, nachdem dessen Sperre abgelaufen war, ist er tot — aber
 * was waehrend seines externen Aufrufs geschah, weiss niemand. Also wird
 * er protokolliert geschlossen und eine Ausnahme geoeffnet, nicht
 * fortgesetzt. */
async function uebernahmePruefen(ctx, { runKey, sectionId, lease, state }) {
  const offen = state.openSection;
  if (!offen) return null;
  if (Number.isSafeInteger(offen.fence) && offen.fence >= lease.fence) {
    throw new HttpError(409, "already_running", { runKey, openSectionId: offen.id });
  }
  const scope = verifiedScopeOf(ctx, lease.fence);
  const atMs = ctx.ports.require("clock").now();
  const wiederaufnahme = `takeover:${offen.id}`;
  const geschlossen = await mutate(ctx, `takeover:${sectionId}:${offen.id}`, (data) => E1.startRunSection(data, {
    runKey, sectionId: wiederaufnahme, kind: "http", budgetMs: 1000,
    now: atMs, verifiedScope: scope,
    crashRecovery: { previousSectionId: offen.id, reason: "lease_expired_takeover" },
  }));
  if (!geschlossen.result.ok && geschlossen.result.code !== "budget_exhausted") {
    throw conflict("takeover_rejected", { code: geschlossen.result.code });
  }
  const aus = await openException(ctx, {
    runKey, sectionId: wiederaufnahme, fence: lease.fence,
    exceptionId: `lost:${offen.id}`, reason: "previous_attempt_lost",
    cursor: { previousSectionId: offen.id, previousFence: offen.fence ?? null, toolSteps: offen.toolSteps },
  });
  return {
    status: 200,
    body: {
      outcome: "exception_open", runKey, sectionId: wiederaufnahme, mode: ctx.config.mode, green: false,
      reason: "previous_attempt_lost", providerOutcome: "unknown",
      continuationId: aus.continuationId, taskId: aus.taskId ?? undefined,
      enqueued: aus.enqueued, duplicateTask: aus.duplicate,
    },
  };
}

async function reenqueue(ctx, { runKey, sectionId, continuationId, reason }) {
  const zustellung = await enqueue(ctx, { runKey, continuationId, atMs: ctx.now });
  return {
    status: 200,
    body: {
      outcome: "checkpointed", runKey, sectionId, mode: ctx.config.mode, green: false,
      continuationId, taskId: zustellung.taskId,
      enqueued: zustellung.enqueued, duplicateTask: zustellung.duplicate, reason,
    },
  };
}

async function advance(ctx, { runKey, sectionId, lease, resumedFrom, cursor = null }) {
  const run = await runSection(ctx, { runKey, sectionId, lease, resumedFrom, cursor });

  if (run.stopReason === "work_done") {
    return finishSection(ctx, { runKey, sectionId, fence: lease.fence, steps: run.steps, cursor: run.cursor });
  }
  if (run.providerOutcome === "unknown") {
    // Unklarer externer Ausgang: Checkpoint schreiben, aber sichtbar als
    // Ausnahme — der naechste Versuch darf nicht einfach weiterlaufen.
    const aus = await openException(ctx, {
      runKey, sectionId, fence: lease.fence, exceptionId: `unknown:${sectionId}`,
      reason: run.stopReason || "provider_outcome_unknown", cursor: run.cursor,
    });
    return {
      status: 200,
      body: {
        outcome: "exception_open", runKey, sectionId, mode: ctx.config.mode, steps: run.steps, green: false,
        reason: (run.stopReason || "provider_outcome_unknown").slice(0, 120), providerOutcome: "unknown",
        continuationId: aus.continuationId, taskId: aus.taskId ?? undefined,
        enqueued: aus.enqueued, duplicateTask: aus.duplicate,
      },
    };
  }
  const cp = await checkpointAndEnqueue(ctx, {
    runKey, sectionId, cursor: run.cursor, fence: lease.fence, reason: run.stopReason || "section_deadline",
  });
  return {
    status: 200,
    body: {
      outcome: "checkpointed", runKey, sectionId, mode: ctx.config.mode, steps: run.steps, green: false,
      continuationId: cp.continuationId, taskId: cp.taskId,
      enqueued: cp.enqueued, duplicateTask: cp.duplicate,
      reason: (run.stopReason || "section_deadline").slice(0, 120),
      providerOutcome: "complete",
    },
  };
}
