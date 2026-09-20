/* ══ E2 — unabhaengiger Monitor, Vorabcheck, getrennter Watchdog ══════════
 *
 * Drei Einstiege in ZWEI Diensten:
 *   POST /v3/monitor/tick        alle fuenf Minuten   (Dienst: monitor)
 *   POST /v3/monitor/preflight   22:30 Ortszeit       (Dienst: monitor)
 *   POST /v3/watchdog/check      eigener Zeitplan     (Dienst: watchdog)
 *
 * Der Watchdog laeuft in einem EIGENEN Dienst mit eigenem Dienstkonto,
 * eigenem Scheduler-Job und ohne Task-Port. Er ruft den Monitor nicht auf —
 * sonst faellt er mit ihm zusammen aus. Die Portablage erzwingt das
 * (FORBIDDEN_PORTS.watchdog).
 *
 * Plan und Zustand kommen vollstaendig aus E1. Hier wird nichts geplant,
 * was E1 nicht geplant hat.
 * ═════════════════════════════════════════════════════════════════════════ */
import * as E1 from "../../../netlify/lib/quantus-v3-runtime-state.mjs";
import * as PLAN from "../../../netlify/lib/quantus-v3-runtime-plan.mjs";
import { HttpError, conflict } from "./errors.mjs";
import { requireSchema } from "./schema.mjs";
import { continuationTaskId } from "./task-names.mjs";

export const EMPTY_REQUEST = Object.freeze({ type: "object", required: [], properties: {} });

export const MONITOR_TICK_RESPONSE = Object.freeze({
  type: "object",
  required: ["tickId", "mode", "createdIncidents", "createdIntents", "dispatched"],
  properties: {
    tickId: { type: "string", maxLength: 200 },
    mode: { type: "string", enum: ["dry_run", "shadow", "live"] },
    duplicate: { type: "boolean" },
    truncated: { type: "boolean" },
    createdIncidents: { type: "integer", minimum: 0, maximum: 1000 },
    createdIntents: { type: "integer", minimum: 0, maximum: 1000 },
    resolved: { type: "integer", minimum: 0, maximum: 1000 },
    dispatched: { type: "integer", minimum: 0, maximum: 1000 },
    duplicateTasks: { type: "integer", minimum: 0, maximum: 1000 },
    enqueueFailures: { type: "integer", minimum: 0, maximum: 1000 },
  },
});

export const PREFLIGHT_RESPONSE = Object.freeze({
  type: "object",
  required: ["applicable", "mode", "repairs", "dispatched"],
  properties: {
    applicable: { type: "boolean" },
    reason: { type: "string", maxLength: 120 },
    mode: { type: "string", enum: ["dry_run", "shadow", "live"] },
    repairs: { type: "integer", minimum: 0, maximum: 1000 },
    dispatched: { type: "integer", minimum: 0, maximum: 1000 },
    duplicateTasks: { type: "integer", minimum: 0, maximum: 1000 },
    newMainRuns: { type: "integer", minimum: 0, maximum: 0 },
  },
});

export const WATCHDOG_RESPONSE = Object.freeze({
  type: "object",
  required: ["stale", "alerted", "mode"],
  properties: {
    stale: { type: "boolean" },
    alerted: { type: "boolean" },
    mode: { type: "string", enum: ["dry_run", "shadow", "live"] },
    ageMs: { type: "integer", minimum: 0, maximum: 9007199254740991 },
    missedTicks: { type: "integer", minimum: 0, maximum: 1000000 },
    escalatedToWatchdogChannel: { type: "boolean" },
  },
});

/* Der Monitor braucht den Startzeitraum aus der Konfiguration — ohne ihn
 * wuerde ein leerer Bestand eine Historienflut ausloesen. */
function monitorStartDate(ctx) {
  const value = ctx.config.monitorStartLocalDate;
  if (!PLAN.isLocalDate(value)) {
    throw new HttpError(503, "runtime_not_configured", { missing: ["QUANTUS_V3_MONITOR_START_LOCAL_DATE"] });
  }
  return value;
}

async function readView(ctx) {
  const core = ctx.ports.require("core");
  const snapshot = await core.read();
  if (!snapshot || typeof snapshot !== "object" || !snapshot.data) {
    throw new HttpError(502, "core_response_invalid", { call: "read" });
  }
  return E1.projectMonitorView(snapshot.data);
}

/* Faellige Absichten einreihen. Ein bereits vorhandener Task ist KEIN
 * Fehler — der Name dedupliziert, und E1 entscheidet ohnehin verbindlich. */
async function dispatchIntents(ctx, entries) {
  if (!entries.length) return { dispatched: 0, duplicateTasks: 0, enqueueFailures: 0 };
  const tasks = ctx.ports.require("tasks");
  let dispatched = 0, duplicateTasks = 0, enqueueFailures = 0;
  for (const entry of entries) {
    if (!entry.runKey || !entry.intentId) { enqueueFailures += 1; continue; }
    let taskId;
    try { taskId = continuationTaskId(entry.runKey, entry.intentId); } catch { enqueueFailures += 1; continue; }
    let result;
    try {
      result = await tasks.enqueueContinuation({
        taskId, runKey: entry.runKey, continuationId: entry.intentId,
        scheduleAtMs: ctx.now,
        queue: ctx.config.tasks.queue,
        targetUrl: ctx.config.tasks.targetUrl,
        oidcServiceAccount: ctx.config.tasks.oidcServiceAccount,
        audience: ctx.config.tasks.audience,
      });
    } catch {
      // Kein stiller Verlust: die Absicht bleibt offen und kommt im
      // naechsten Tick wieder.
      enqueueFailures += 1;
      continue;
    }
    if (result && result.duplicate === true) duplicateTasks += 1;
    else if (result && result.enqueued === true) dispatched += 1;
    else enqueueFailures += 1;
  }
  return { dispatched, duplicateTasks, enqueueFailures };
}

export async function handleMonitorTick(ctx) {
  requireSchema(ctx.body ?? {}, EMPTY_REQUEST, "monitor_tick_invalid");
  const view = await readView(ctx);
  const plan = PLAN.buildMonitorPlan(view, {
    now: ctx.now,
    tenant: ctx.config.tenant,
    policyVersion: ctx.config.policyVersion,
    startLocalDate: monitorStartDate(ctx),
  });
  const core = ctx.ports.require("core");
  const applied = await core.mutate({
    commandKey: plan.tickId, requestId: ctx.requestId, now: ctx.now,
    mutate: (data) => E1.applyMonitorPlan(data, { plan, now: ctx.now }),
  });
  if (!applied || !applied.result || applied.result.ok !== true) {
    throw conflict("monitor_tick_rejected", { code: applied?.result?.code ?? null });
  }
  // Die in DIESEM Tick angelegten Absichten werden sofort mit zugestellt —
  // sonst wartet ein Nachholauftrag bis zum naechsten Fuenf-Minuten-Fenster.
  // Die Tasknamen sind stabil, ein Doppel ist damit ausgeschlossen.
  // Eine Wiederholung derselben Zustellung hat NICHTS angelegt — auch wenn
  // der Beleg die Liste der urspruenglich angelegten Eintraege enthaelt.
  const wiederholung = applied.replayed === true || applied.result.duplicate === true;
  const angelegteVorfaelle = wiederholung ? [] : (applied.result.createdIncidents || []);
  const angelegteAbsichten = wiederholung ? [] : (applied.result.createdIntents || []);
  const erledigteVorfaelle = wiederholung ? [] : (applied.result.resolved || []);
  const neueAbsichten = new Set(angelegteAbsichten);
  const einzureihen = [
    ...plan.dispatch,
    ...plan.intents
      .filter((intent) => neueAbsichten.has(intent.id))
      .map((intent) => ({ intentId: intent.id, runKey: intent.runKey, deliveries: 0 })),
  ];
  const gesehen = new Set();
  const dispatch = await dispatchIntents(ctx, einzureihen.filter((e) => {
    if (gesehen.has(e.intentId)) return false;
    gesehen.add(e.intentId);
    return true;
  }));
  return {
    status: 200,
    body: {
      tickId: plan.tickId,
      mode: ctx.config.mode,
      duplicate: wiederholung,
      truncated: plan.truncated === true,
      createdIncidents: angelegteVorfaelle.length,
      createdIntents: angelegteAbsichten.length,
      resolved: erledigteVorfaelle.length,
      ...dispatch,
    },
  };
}

export async function handleMonitorPreflight(ctx) {
  requireSchema(ctx.body ?? {}, EMPTY_REQUEST, "monitor_preflight_invalid");
  const view = await readView(ctx);
  const plan = PLAN.buildPreflightPlan(view, {
    now: ctx.now, tenant: ctx.config.tenant, policyVersion: ctx.config.policyVersion,
  });
  // Doppelt gesichert: der Vorabcheck darf keinen fuenften Hauptauftrag
  // erzeugen. E1 liefert diese Listen strukturell leer; sollte das je
  // anders sein, bricht der Dienst ab, statt es durchzulassen.
  if (plan.intents.length || plan.incidents.length || plan.newMainRuns.length) {
    throw new HttpError(500, "preflight_would_create_work", {
      intents: plan.intents.length, incidents: plan.incidents.length, newMainRuns: plan.newMainRuns.length,
    });
  }
  if (!plan.applicable) {
    return { status: 200, body: { applicable: false, reason: plan.reason || "not_applicable", mode: ctx.config.mode, repairs: 0, dispatched: 0, duplicateTasks: 0, newMainRuns: 0 } };
  }
  const entries = plan.repairs
    .filter((r) => r.kind === "redeliver_intent" || r.kind === "resume_checkpointed_run")
    .map((r) => ({ runKey: r.runKey, intentId: r.intentId || r.continuationId }))
    .filter((r) => r.runKey && r.intentId);
  const dispatch = await dispatchIntents(ctx, entries);
  return {
    status: 200,
    body: {
      applicable: true, mode: ctx.config.mode, repairs: plan.repairs.length,
      dispatched: dispatch.dispatched, duplicateTasks: dispatch.duplicateTasks, newMainRuns: 0,
    },
  };
}

export async function handleWatchdogCheck(ctx) {
  requireSchema(ctx.body ?? {}, EMPTY_REQUEST, "watchdog_check_invalid");
  const view = await readView(ctx);
  const heartbeat = PLAN.planHeartbeat({ now: ctx.now, lastHeartbeatAtMs: view.monitor.lastHeartbeatAtMs });
  if (!heartbeat.stale) {
    return { status: 200, body: { stale: false, alerted: false, mode: ctx.config.mode, ageMs: heartbeat.ageMs ?? 0, missedTicks: heartbeat.missedTicks ?? 0, escalatedToWatchdogChannel: false } };
  }

  const alert = ctx.ports.require("alert");
  let delivered = false;
  let failure = null;
  try {
    const out = await alert.send({
      kind: "monitor_heartbeat_stale",
      ageMs: heartbeat.ageMs, missedTicks: heartbeat.missedTicks,
      tenant: ctx.config.tenant, atMs: ctx.now, mode: ctx.config.mode,
    });
    delivered = out && out.delivered === true;
    if (!delivered) failure = "not_delivered";
  } catch (err) {
    failure = "send_failed";
  }

  if (delivered) {
    return { status: 200, body: { stale: true, alerted: true, mode: ctx.config.mode, ageMs: heartbeat.ageMs ?? 0, missedTicks: heartbeat.missedTicks ?? 0, escalatedToWatchdogChannel: false } };
  }

  // Die Warnung gilt NICHT als zugestellt. Sie wird verbucht und der
  // Aufruf schlaegt fehl, damit der Zeitplan es erneut versucht.
  const core = ctx.ports.require("core");
  const failureId = `warn:${ctx.config.tenant}:${Math.floor(ctx.now / PLAN.MONITOR_INTERVAL_MS) * PLAN.MONITOR_INTERVAL_MS}`;
  await core.mutate({
    commandKey: `warn-failure:${failureId}`, requestId: ctx.requestId, now: ctx.now,
    mutate: (data) => E1.recordWarningFailure(data, { channel: "watchdog_primary", failureId, now: ctx.now }),
  });
  throw new HttpError(503, "warning_delivery_failed", { reason: failure, recorded: true });
}
