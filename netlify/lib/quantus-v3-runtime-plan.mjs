/* ══ Quantus Tagesbriefing v3 — Sollplan, Monitor, Wiederholung (Paket E1-C) ══
 *
 * Diese Datei ist die UNTERE Schicht der v3-Laufzeit: sie rechnet, sie plant,
 * sie entscheidet — aber sie fasst keinen Bestand an. Kein Firebase, kein
 * Netz, kein Modell, keine Uhr (jedes `now` kommt von aussen als
 * Millisekundenzahl), kein Zufall. Zweimal mit denselben Eingaben aufgerufen
 * liefert sie exakt dasselbe Ergebnis, inklusive aller Kennungen.
 *
 * Wer schreibt, ist `quantus-v3-runtime-state.mjs`: es nimmt einen hier
 * gebauten Plan entgegen und legt Vorfaelle/Absichten idempotent im zentralen
 * Kern ab — in DEMSELBEN CAS wie die fachliche Aenderung. Die Abhaengigkeit
 * laeuft nur in diese eine Richtung (state → plan), damit es keinen
 * Modulkreis gibt.
 *
 * Inhalt:
 *   1. Zeit in Europe/Zurich (Sommer-/Winterzeit ueber Intl, keine feste
 *      Verschiebung, beide Umstellungstage 2026 in den Tests mit exakten
 *      UTC-Millisekunden belegt)
 *   2. Genau VIER Hauptslots und ihr stabiler Schluessel
 *      tenant:localDate:slot:policyVersion
 *   3. Unabhaengiger 5-Minuten-Monitor: fehlender Start nach 10 Minuten
 *      Toleranz ergibt Vorfall + idempotente Nachholabsicht fuer DENSELBEN
 *      Slot — auch wenn ueberhaupt kein Lauf existiert
 *   4. 22:30-Vorabcheck: repariert ausschliesslich BESTEHENDE Verpflichtungen
 *      und kann strukturell keinen fuenften Hauptauftrag erzeugen
 *   5. Zustellwiederholung: hoechstens 5 Zustellungen, Backoff 30 s … 10 min,
 *      429 mit Retry-After, 401/403/Schema/Budget nicht blind wiederholen,
 *      unklarer Ausgang wird abgeglichen statt erneut gesendet
 *   6. Tagesbetrieb 09–23, Nachtsammlung, Koaleszenz je Lead, harte Fristen,
 *      die weder Snooze noch Minimalmodus verdecken duerfen
 *   7. Monitor-Heartbeat und fehlgeschlagene Warnzustellung: Vertrag fuer
 *      einen UNABHAENGIGEN Watchdog, ohne Verfuegbarkeitsversprechen
 *
 * Nicht enthalten (bewusst): jede Cloud-Spezifik. Welcher Scheduler welchen
 * Slot ausloest, steht hier nicht — der Plan sagt nur, was faellig waere und
 * was fehlt. Ein nicht angebundener Laeufer kann damit keinen Erfolg
 * vortaeuschen, weil der Plan Erfolg gar nicht behaupten kann.
 * ═════════════════════════════════════════════════════════════════════════ */

export const PLAN_SCHEMA = "quantus-v3-runtime-plan/1";
export const TIMEZONE = "Europe/Zurich";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/* Genau vier. Ein fuenfter Eintrag hier waere die einzige Stelle, an der ein
 * fuenfter Hauptlauf entstehen koennte — deshalb ist die Liste eingefroren
 * und wird von den Tests auf Laenge und Inhalt geprueft. */
export const MAIN_SLOTS = Object.freeze([
  Object.freeze({ slot: "briefing04", hour: 4, minute: 0, purpose: "Tag eroeffnen" }),
  Object.freeze({ slot: "process09", hour: 9, minute: 0, purpose: "bearbeiten" }),
  Object.freeze({ slot: "continue14", hour: 14, minute: 0, purpose: "fortsetzen" }),
  Object.freeze({ slot: "close23", hour: 23, minute: 0, purpose: "abschliessen" }),
]);
export const SLOT_NAMES = Object.freeze(MAIN_SLOTS.map((s) => s.slot));
export const DAY_START_HOUR = 4;

export const START_TOLERANCE_MS = 10 * MINUTE_MS;
export const MONITOR_INTERVAL_MS = 5 * MINUTE_MS;
export const MONITOR_MAX_NEW_PER_TICK = 8;
export const MONITOR_WINDOW_DAYS = 2;

export const PREFLIGHT_LOCAL = Object.freeze({ hour: 22, minute: 30 });
export const PREFLIGHT_WINDOW_MS = 5 * MINUTE_MS;

/* Spaetfenster am 23-Uhr-Slot: hoechstens zwei weitere Abschnitte zu je
 * fuenf Minuten, harter Schluss um 23:30 Ortszeit. Danach gilt
 * exception_open — nie ein vorgetaeuschtes Gruen. */
export const LATE_WINDOW = Object.freeze({
  slot: "close23",
  maxExtraSections: 2,
  sectionMs: 5 * MINUTE_MS,
  hardStop: Object.freeze({ hour: 23, minute: 30 }),
});

export const DAY_WINDOW = Object.freeze({ fromHour: 9, toHour: 23 });

export const RETRY = Object.freeze({
  maxDeliveries: 5,
  baseMs: 30 * 1000,
  maxMs: 10 * MINUTE_MS,
  retryAfterCapMs: 30 * MINUTE_MS,
});

/* Fehlerklassen der Zustellung. `retryable` heisst: derselbe Versuch kann
 * spaeter gelingen. Alles andere wird sichtbar beendet statt blind wiederholt. */
export const ERROR_CLASSES = Object.freeze({
  transient: "retryable",
  rate_limited: "retryable",
  timeout: "retryable",
  auth: "terminal",
  forbidden: "terminal",
  schema: "terminal",
  budget: "terminal",
  policy: "terminal",
  not_found: "terminal",
  unknown_outcome: "reconcile",
});

export class PlanError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${JSON.stringify(detail)}` : code);
    this.name = "PlanError";
    this.code = code;
    this.status = 400;
    this.detail = detail;
  }
}

function fail(code, detail) { throw new PlanError(code, detail); }

function requireMs(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value))) {
    fail("invalid_timestamp", { name, value: String(value) });
  }
  return Math.trunc(value);
}

const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POLICY_RE = /^[A-Za-z0-9._-]{1,32}$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value) {
  if (typeof value !== "string" || !LOCAL_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function requireTenant(value) {
  if (typeof value !== "string" || !TENANT_RE.test(value)) fail("invalid_tenant", { value: String(value) });
  return value;
}
function requirePolicyVersion(value) {
  if (typeof value !== "string" || !POLICY_RE.test(value)) fail("invalid_policy_version", { value: String(value) });
  return value;
}
function requireLocalDate(value, name = "localDate") {
  if (!isLocalDate(value)) fail("invalid_local_date", { name, value: String(value) });
  return value;
}
export function requireSlot(value) {
  if (!SLOT_NAMES.includes(value)) fail("unknown_slot", { value: String(value) });
  return value;
}

/* ── 1. Zeit in Europe/Zurich ──────────────────────────────────────────── */

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/* Wandzeit-Bestandteile in Zuerich fuer einen UTC-Zeitpunkt. */
export function zurichParts(ms) {
  const t = requireMs(ms, "ms");
  const out = {};
  for (const part of partsFormatter.formatToParts(new Date(t))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  if (out.hour === 24) out.hour = 0; // manche ICU-Staende liefern 24 statt 0
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

const pad2 = (n) => String(n).padStart(2, "0");

export function partsToLocalDate(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/* Versatz der Zone zu UTC in Minuten fuer genau diesen Zeitpunkt. */
export function zurichOffsetMinutes(ms) {
  const t = requireMs(ms, "ms");
  const p = zurichParts(t);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / MINUTE_MS);
}

export function localDate(ms) { return partsToLocalDate(zurichParts(ms)); }
export function localTimeMinutes(ms) { const p = zurichParts(ms); return p.hour * 60 + p.minute; }
export function localHour(ms) { return zurichParts(ms).hour; }

export function addDays(date, days) {
  requireLocalDate(date);
  if (!Number.isSafeInteger(days)) fail("invalid_day_offset", { days: String(days) });
  const base = Date.parse(`${date}T00:00:00Z`);
  const moved = new Date(base + days * DAY_MS);
  return partsToLocalDate({ year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() });
}

/* Ortszeit → UTC-Millisekunden. Beide moeglichen Versaetze werden probiert
 * (zwoelf Stunden davor / danach decken jede Umstellung ab):
 *   · doppelte Wandzeit (Rueckstellung) → der FRUEHERE Zeitpunkt gilt
 *   · fehlende Wandzeit (Vorstellung)   → nach vorn geschoben, wie in JS ueblich
 * Die vier Slots liegen nie in Luecke oder Doppelung; die Regel ist trotzdem
 * festgeschrieben und geprueft, damit sie nicht zufaellig stimmt. */
export function wallTimeToMs(date, hour, minute = 0) {
  requireLocalDate(date);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail("invalid_wall_hour", { hour: String(hour) });
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) fail("invalid_wall_minute", { minute: String(minute) });
  const [y, m, d] = date.split("-").map(Number);
  const wish = Date.UTC(y, m - 1, d, hour, minute, 0);
  const offsets = new Set([
    zurichOffsetMinutes(wish - 12 * HOUR_MS),
    zurichOffsetMinutes(wish),
    zurichOffsetMinutes(wish + 12 * HOUR_MS),
  ]);
  const candidates = [...offsets].map((off) => wish - off * MINUTE_MS).sort((a, b) => a - b);
  const exact = candidates.filter((ms) => {
    const p = zurichParts(ms);
    return p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
  });
  if (exact.length) return exact[0];
  return candidates[candidates.length - 1];
}

/* Der Assistententag beginnt 04:00 Ortszeit: 02:30 am 20. gehoert zum 19. */
export function assistantDay(ms) {
  const p = zurichParts(ms);
  if (p.hour >= DAY_START_HOUR) return partsToLocalDate(p);
  return addDays(partsToLocalDate(p), -1);
}

export function assistantDayEndMs(date) {
  return wallTimeToMs(addDays(requireLocalDate(date), 1), DAY_START_HOUR, 0);
}

/* ── 2. Die vier Hauptslots und ihr stabiler Schluessel ────────────────── */

/* tenant:localDate:slot:policyVersion — keine Zeitstempel, keine Zufalls-
 * anteile. Derselbe Slot ergibt immer denselben Schluessel, egal welcher
 * Laeufer ihn bildet und wie oft er zugestellt wird. */
export function slotRunKey(tenant, date, slot, policyVersion) {
  return `${requireTenant(tenant)}:${requireLocalDate(date)}:${requireSlot(slot)}:${requirePolicyVersion(policyVersion)}`;
}

export function parseSlotRunKey(runKey) {
  if (typeof runKey !== "string") fail("invalid_run_key", { value: String(runKey) });
  const parts = runKey.split(":");
  if (parts.length !== 4) fail("invalid_run_key", { value: runKey });
  const [tenant, date, slot, policyVersion] = parts;
  requireTenant(tenant); requireLocalDate(date); requireSlot(slot); requirePolicyVersion(policyVersion);
  return { tenant, localDate: date, slot, policyVersion, runKey };
}

/* Der Sollplan eines Kalendertages: vier Eintraege, aufsteigend, mit
 * Toleranzgrenze. `dueByMs` ist der Zeitpunkt, ab dem ein fehlender Start
 * ein Vorfall ist. */
export function plannedSlots(tenant, date, policyVersion, { toleranceMs = START_TOLERANCE_MS } = {}) {
  requireTenant(tenant); requireLocalDate(date); requirePolicyVersion(policyVersion);
  if (!Number.isSafeInteger(toleranceMs) || toleranceMs < 0) fail("invalid_tolerance", { toleranceMs: String(toleranceMs) });
  return MAIN_SLOTS.map((def) => {
    const plannedAtMs = wallTimeToMs(date, def.hour, def.minute);
    return Object.freeze({
      runKey: slotRunKey(tenant, date, def.slot, policyVersion),
      tenant, localDate: date, policyVersion,
      slot: def.slot,
      purpose: def.purpose,
      localTime: `${pad2(def.hour)}:${pad2(def.minute)}`,
      plannedAtMs,
      dueByMs: plannedAtMs + toleranceMs,
    });
  });
}

export function currentSlot(ms) {
  const t = requireMs(ms, "now");
  const date = assistantDay(t);
  let active = null;
  for (const def of MAIN_SLOTS) {
    if (wallTimeToMs(date, def.hour, def.minute) <= t) active = def;
  }
  return { localDate: date, slot: active ? active.slot : null };
}

export function nextSlotStartMs(ms) {
  const t = requireMs(ms, "now");
  const date = assistantDay(t);
  for (const def of MAIN_SLOTS) {
    const start = wallTimeToMs(date, def.hour, def.minute);
    if (start > t) return start;
  }
  const next = addDays(date, 1);
  return wallTimeToMs(next, MAIN_SLOTS[0].hour, MAIN_SLOTS[0].minute);
}

/* Spaetfenster des 23-Uhr-Slots eines Tages, inklusive hartem Schluss. */
export function lateWindow(date) {
  requireLocalDate(date);
  return Object.freeze({
    slot: LATE_WINDOW.slot,
    startMs: wallTimeToMs(date, 23, 0),
    hardStopAtMs: wallTimeToMs(date, LATE_WINDOW.hardStop.hour, LATE_WINDOW.hardStop.minute),
    maxExtraSections: LATE_WINDOW.maxExtraSections,
    sectionMs: LATE_WINDOW.sectionMs,
  });
}

/* ── 3. Unabhaengiger Monitor ──────────────────────────────────────────── */

function indexRuns(view) {
  const map = new Map();
  const runs = view && view.runs;
  const list = Array.isArray(runs) ? runs : runs && typeof runs === "object" ? Object.values(runs) : [];
  for (const run of list) {
    if (run && typeof run.runKey === "string") map.set(run.runKey, run);
  }
  return map;
}

function indexById(list) {
  const map = new Map();
  const items = Array.isArray(list) ? list : list && typeof list === "object" ? Object.values(list) : [];
  for (const item of items) {
    if (item && typeof item.id === "string") map.set(item.id, item);
  }
  return map;
}

export function monitorTickId(tenant, policyVersion, now) {
  requireTenant(tenant); requirePolicyVersion(policyVersion);
  const t = requireMs(now, "now");
  const bucket = Math.floor(t / MONITOR_INTERVAL_MS) * MONITOR_INTERVAL_MS;
  return `tick:${tenant}:${policyVersion}:${bucket}`;
}

/* Der Monitor sieht NUR die Projektion `view` — er kennt den Bestand nicht
 * und ruft kein Modell. Zwei Ausfuehrungen im selben Fuenf-Minuten-Fenster
 * ergeben dieselbe `tickId` und dieselben Kennungen, damit der Schreibpfad
 * sie ohne Doppel ablegen kann.
 *
 * view = {
 *   runs:      [{ runKey, hasStarted, phase, startedAtMs }]
 *   incidents: [{ id, resolvedAtMs }]
 *   intents:   [{ id, state, runKey, notBeforeMs, deliveries }]
 *   monitor:   { lastHeartbeatAtMs }
 * }
 */
export function buildMonitorPlan(view, options = {}) {
  const now = requireMs(options.now, "now");
  const tenant = requireTenant(options.tenant);
  const policyVersion = requirePolicyVersion(options.policyVersion);
  const startLocalDate = requireLocalDate(options.startLocalDate, "startLocalDate");
  const windowDays = options.windowDays === undefined ? MONITOR_WINDOW_DAYS : options.windowDays;
  const toleranceMs = options.toleranceMs === undefined ? START_TOLERANCE_MS : options.toleranceMs;
  const maxNewPerTick = options.maxNewPerTick === undefined ? MONITOR_MAX_NEW_PER_TICK : options.maxNewPerTick;
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 14) fail("invalid_window_days", { windowDays: String(windowDays) });
  if (!Number.isSafeInteger(maxNewPerTick) || maxNewPerTick < 1) fail("invalid_max_new", { maxNewPerTick: String(maxNewPerTick) });

  const runs = indexRuns(view);
  const incidents = indexById(view && view.incidents);
  const intents = indexById(view && view.intents);

  const today = localDate(now);
  const dates = [];
  for (let back = windowDays - 1; back >= 0; back--) {
    const date = addDays(today, -back);
    if (date >= startLocalDate) dates.push(date);
  }

  const dueSlots = [];
  for (const date of dates) {
    for (const slot of plannedSlots(tenant, date, policyVersion, { toleranceMs })) {
      if (slot.dueByMs <= now) dueSlots.push(slot);
    }
  }
  dueSlots.sort((a, b) => a.plannedAtMs - b.plannedAtMs || (a.runKey < b.runKey ? -1 : 1));

  const newIncidents = [];
  const newIntents = [];
  const resolutions = [];
  let created = 0;
  let truncated = false;

  for (const slot of dueSlots) {
    const run = runs.get(slot.runKey);
    const started = Boolean(run && run.hasStarted);
    const incidentId = `inc:missed_start:${slot.runKey}`;
    if (started) {
      // Nachholen loescht den historischen Vorfall NICHT: er wird nur als
      // erledigt markiert und bleibt mit seinem Entdeckungszeitpunkt stehen.
      const known = incidents.get(incidentId);
      if (known && !known.resolvedAtMs) {
        resolutions.push({ incidentId, resolvedBy: "run_started", atMs: now, runKey: slot.runKey });
      }
      continue;
    }
    const intentId = `catchup:${slot.runKey}`;
    const pending = [];
    if (!incidents.has(incidentId)) {
      pending.push(["incident", {
        id: incidentId, kind: "missed_slot_start", severity: "high",
        runKey: slot.runKey, slot: slot.slot, localDate: slot.localDate,
        plannedAtMs: slot.plannedAtMs, dueByMs: slot.dueByMs, detectedAtMs: now,
        // Auch ohne jeden Lauf: der Vorfall haengt am Slot, nicht am Lauf.
        runExists: Boolean(run),
      }]);
    }
    if (!intents.has(intentId)) {
      pending.push(["intent", {
        id: intentId, kind: "slot_catchup", runKey: slot.runKey, slot: slot.slot,
        localDate: slot.localDate, notBeforeMs: now, reason: "missed_start",
        forIncidentId: incidentId,
      }]);
    }
    if (!pending.length) continue;
    if (created + pending.length > maxNewPerTick) { truncated = true; break; }
    created += pending.length;
    for (const [kind, record] of pending) (kind === "incident" ? newIncidents : newIntents).push(record);
  }

  const dispatch = [];
  for (const intent of intents.values()) {
    if (intent.state !== "pending") continue;
    const notBefore = Number.isSafeInteger(intent.notBeforeMs) ? intent.notBeforeMs : 0;
    if (notBefore > now) continue;
    dispatch.push({
      intentId: intent.id,
      runKey: typeof intent.runKey === "string" ? intent.runKey : null,
      deliveries: Number.isSafeInteger(intent.deliveries) ? intent.deliveries : 0,
    });
  }
  dispatch.sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));

  return Object.freeze({
    schema: PLAN_SCHEMA,
    kind: "monitor_tick",
    tickId: monitorTickId(tenant, policyVersion, now),
    atMs: now,
    tenant, policyVersion,
    windowFrom: dates[0] || null,
    windowTo: dates[dates.length - 1] || null,
    incidents: newIncidents,
    intents: newIntents,
    resolutions,
    dispatch,
    truncated,
    heartbeat: planHeartbeat({
      now,
      lastHeartbeatAtMs: view && view.monitor ? view.monitor.lastHeartbeatAtMs : null,
    }),
  });
}

/* ── 4. Vorabcheck 22:30 ───────────────────────────────────────────────── */

/* Repariert ausschliesslich, was schon als Verpflichtung im Bestand steht.
 * `intents` und `incidents` sind hier IMMER leer — der Vorabcheck kann
 * strukturell keinen fuenften Hauptauftrag erzeugen. */
export function buildPreflightPlan(view, options = {}) {
  const now = requireMs(options.now, "now");
  const tenant = requireTenant(options.tenant);
  const policyVersion = requirePolicyVersion(options.policyVersion);
  const windowMs = options.windowMs === undefined ? PREFLIGHT_WINDOW_MS : options.windowMs;
  if (!Number.isSafeInteger(windowMs) || windowMs < 0) fail("invalid_window", { windowMs: String(windowMs) });

  const date = localDate(now);
  const targetAtMs = wallTimeToMs(date, PREFLIGHT_LOCAL.hour, PREFLIGHT_LOCAL.minute);
  const base = {
    schema: PLAN_SCHEMA, kind: "preflight", atMs: now, tenant, policyVersion,
    localDate: date, targetAtMs,
    incidents: [], intents: [], newMainRuns: [],
  };
  if (Math.abs(now - targetAtMs) > windowMs) {
    return Object.freeze({ ...base, applicable: false, reason: "outside_preflight_window", repairs: [] });
  }

  const incidents = indexById(view && view.incidents);
  const intents = indexById(view && view.intents);
  const runs = indexRuns(view);
  const repairs = [];

  for (const intent of intents.values()) {
    if (intent.state !== "pending") continue;
    const notBefore = Number.isSafeInteger(intent.notBeforeMs) ? intent.notBeforeMs : 0;
    if (notBefore > now) continue;
    repairs.push({ kind: "redeliver_intent", intentId: intent.id, runKey: intent.runKey || null });
  }
  for (const incident of incidents.values()) {
    if (incident.resolvedAtMs) continue;
    repairs.push({ kind: "escalate_open_incident", incidentId: incident.id, runKey: incident.runKey || null });
  }
  for (const run of runs.values()) {
    if (run.phase !== "checkpointed" && run.phase !== "exception_open") continue;
    if (!run.pendingContinuationId) continue;
    repairs.push({ kind: "resume_checkpointed_run", runKey: run.runKey, continuationId: run.pendingContinuationId });
  }
  repairs.sort((a, b) => {
    const ka = `${a.kind}:${a.intentId || a.incidentId || a.runKey}`;
    const kb = `${b.kind}:${b.intentId || b.incidentId || b.runKey}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return Object.freeze({ ...base, applicable: true, reason: null, repairs });
}

/* ── 5. Zustellwiederholung ────────────────────────────────────────────── */

export function classifyDeliveryError(errorClass) {
  if (typeof errorClass !== "string" || !Object.hasOwn(ERROR_CLASSES, errorClass)) {
    // Unbekannt heisst nicht harmlos: unbekannte Fehler werden wie ein
    // unklarer Ausgang behandelt und abgeglichen, nicht wiederholt.
    return "reconcile";
  }
  return ERROR_CLASSES[errorClass];
}

export function backoffMs(deliveries) {
  if (!Number.isSafeInteger(deliveries) || deliveries < 0) fail("invalid_deliveries", { deliveries: String(deliveries) });
  if (deliveries === 0) return 0;
  const raw = RETRY.baseMs * 2 ** Math.min(deliveries - 1, 20);
  return Math.min(raw, RETRY.maxMs);
}

/* deliveries = Zahl der bereits erfolgten Zustellversuche. */
export function planDeliveryRetry(input = {}) {
  const now = requireMs(input.now, "now");
  const deliveries = input.deliveries;
  if (!Number.isSafeInteger(deliveries) || deliveries < 0) fail("invalid_deliveries", { deliveries: String(deliveries) });
  const errorClass = input.errorClass;
  const behaviour = classifyDeliveryError(errorClass);
  const known = typeof errorClass === "string" && Object.hasOwn(ERROR_CLASSES, errorClass);

  if (behaviour === "terminal") {
    return Object.freeze({
      retry: false, terminal: true, nextAtMs: null, deliveries,
      reason: `non_retryable:${errorClass}`, incident: true,
      requiresReconciliation: false, checkpoint: true,
    });
  }
  if (behaviour === "reconcile") {
    // Unklarer Ausgang bei Mail/Provider: NICHT automatisch erneut senden.
    return Object.freeze({
      retry: false, terminal: false, nextAtMs: null, deliveries,
      reason: known ? "unknown_outcome" : `unknown_error_class:${String(errorClass)}`,
      incident: true, requiresReconciliation: true, checkpoint: true,
    });
  }
  if (deliveries >= RETRY.maxDeliveries) {
    return Object.freeze({
      retry: false, terminal: true, nextAtMs: null, deliveries,
      reason: "max_deliveries", incident: true, requiresReconciliation: false, checkpoint: true,
    });
  }
  let waitMs = backoffMs(deliveries);
  let honouredRetryAfter = false;
  if (errorClass === "rate_limited") {
    const retryAfter = input.retryAfterMs;
    if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) {
      waitMs = Math.min(Math.max(retryAfter, waitMs), RETRY.retryAfterCapMs);
      honouredRetryAfter = true;
    }
  }
  return Object.freeze({
    retry: true, terminal: false, deliveries,
    nextAtMs: now + waitMs, waitMs, honouredRetryAfter,
    reason: "backoff", incident: false, requiresReconciliation: false,
    checkpoint: true, // statt Endlosschleife: der Stand wird festgehalten
    remainingDeliveries: RETRY.maxDeliveries - deliveries,
  });
}

/* ── 6. Tagesbetrieb, Nachtsammlung, harte Fristen ─────────────────────── */

export const ITEM_KINDS = Object.freeze(["answer", "confirmed_return", "followup", "intake", "deadline"]);

function requireItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_item");
  if (typeof item.id !== "string" || !item.id) fail("invalid_item_id");
  if (!ITEM_KINDS.includes(item.kind)) fail("unknown_item_kind", { kind: String(item.kind) });
  return item;
}

function optionalMs(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) fail("invalid_timestamp", { name, value: String(value) });
  return value;
}

/* Eine Entscheidung je Arbeitsstueck. Reihenfolge der Pruefungen ist
 * Absicht: eine belegte harte Frist wird ZUERST geprueft, damit weder Snooze
 * noch Minimalmodus sie verdecken koennen. */
export function planItemHandling(item, context = {}) {
  requireItem(item);
  const now = requireMs(context.now, "now");
  const minimal = context.minimalMode === true;
  const budgetAvailable = context.budgetAvailable === true;
  const nextSlotMs = Number.isSafeInteger(context.nextSlotStartMs) ? context.nextSlotStartMs : nextSlotStartMs(now);
  const hardDeadline = optionalMs(item.hardDeadlineAtMs, "hardDeadlineAtMs");
  const snoozedUntil = optionalMs(item.snoozedUntilMs, "snoozedUntilMs");
  const dueAt = optionalMs(item.dueAtMs, "dueAtMs");
  const mandateOk = Boolean(item.mandate && item.mandate.ok === true && typeof item.mandate.ref === "string" && item.mandate.ref);
  const hour = localHour(now);
  const daytime = hour >= DAY_WINDOW.fromHour && hour < DAY_WINDOW.toHour;
  const common = { itemId: item.id, leadId: item.leadId || null, kind: item.kind, atMs: now, nextSlotStartMs: nextSlotMs, daytime };

  if (hardDeadline !== null && hardDeadline < nextSlotMs) {
    // Ausnahme vom Slot-Rhythmus — aber nur mit Mandat UND Budget.
    if (mandateOk && budgetAvailable) {
      return Object.freeze({ ...common, action: "handle_now", exception: true, hidden: false, reason: "hard_deadline_before_next_slot", hardDeadlineAtMs: hardDeadline });
    }
    return Object.freeze({
      ...common, action: "escalate", exception: true, hidden: false,
      reason: mandateOk ? "hard_deadline_without_budget" : "hard_deadline_without_mandate",
      hardDeadlineAtMs: hardDeadline, requiresIncident: true,
    });
  }

  if (snoozedUntil !== null && snoozedUntil > now) {
    return Object.freeze({ ...common, action: "collect", exception: false, hidden: false, reason: "snoozed", resumeAtMs: snoozedUntil });
  }

  if (!daytime) {
    // Nachts wird gesammelt, nicht bearbeitet.
    return Object.freeze({ ...common, action: "collect", exception: false, hidden: false, reason: "night_window", resumeAtMs: nextSlotMs });
  }

  if (item.kind === "answer" || item.kind === "confirmed_return") {
    if (minimal && item.kind === "confirmed_return") {
      return Object.freeze({ ...common, action: "defer_to_slot", exception: false, hidden: false, reason: "minimal_mode", resumeAtMs: nextSlotMs });
    }
    return Object.freeze({ ...common, action: "handle_now", exception: false, hidden: false, reason: `daytime_${item.kind}` });
  }

  if (minimal) {
    return Object.freeze({ ...common, action: "defer_to_slot", exception: false, hidden: false, reason: "minimal_mode", resumeAtMs: nextSlotMs });
  }

  if (item.kind === "followup") {
    if (dueAt !== null && dueAt > now) {
      return Object.freeze({ ...common, action: "collect", exception: false, hidden: false, reason: "followup_not_due", resumeAtMs: dueAt });
    }
    return Object.freeze({ ...common, action: "handle_now", exception: false, hidden: false, reason: "followup_due", coalesceBy: item.leadId || item.id });
  }

  // intake / deadline ohne belegte Frist
  if (item.urgent === true) {
    if (mandateOk && budgetAvailable) {
      return Object.freeze({ ...common, action: "handle_now", exception: true, hidden: false, reason: "urgent_with_mandate" });
    }
    return Object.freeze({ ...common, action: "defer_to_slot", exception: false, hidden: false, reason: mandateOk ? "urgent_without_budget" : "urgent_without_mandate", resumeAtMs: nextSlotMs, requiresIncident: false });
  }
  return Object.freeze({ ...common, action: "defer_to_slot", exception: false, hidden: false, reason: "non_urgent_intake", resumeAtMs: nextSlotMs });
}

/* Faellige Nachfassungen werden JE LEAD zu einer Absicht zusammengefasst —
 * sonst schickt der Lauf fuenf Nachrichten an dieselbe Gegenpartei. */
export function coalesceFollowUps(items, context = {}) {
  if (!Array.isArray(items)) fail("invalid_items");
  const decisions = items.map((item) => planItemHandling(item, context));
  const groups = new Map();
  const other = [];
  for (const decision of decisions) {
    if (decision.action !== "handle_now" || decision.kind !== "followup") { other.push(decision); continue; }
    const key = decision.coalesceBy || decision.itemId;
    if (!groups.has(key)) groups.set(key, { coalesceKey: key, leadId: decision.leadId, itemIds: [], atMs: decision.atMs });
    groups.get(key).itemIds.push(decision.itemId);
  }
  const coalesced = [...groups.values()]
    .map((g) => ({ ...g, itemIds: g.itemIds.slice().sort() }))
    .sort((a, b) => (a.coalesceKey < b.coalesceKey ? -1 : a.coalesceKey > b.coalesceKey ? 1 : 0));
  return Object.freeze({ decisions, coalesced, other });
}

/* ── 7. Heartbeat und Warnzustellung ───────────────────────────────────── */

/* Der Monitor ueberwacht sich nicht selbst — er stellt nur fest, ob sein
 * eigener Herzschlag alt ist. Der VERTRAG fuer den unabhaengigen Watchdog
 * steht im Ergebnis; ein Verfuegbarkeitsversprechen gibt es hier nicht. */
export function planHeartbeat(input = {}) {
  const now = requireMs(input.now, "now");
  const intervalMs = input.intervalMs === undefined ? MONITOR_INTERVAL_MS : input.intervalMs;
  const missTolerance = input.missTolerance === undefined ? 2 : input.missTolerance;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) fail("invalid_interval", { intervalMs: String(intervalMs) });
  if (!Number.isSafeInteger(missTolerance) || missTolerance < 1) fail("invalid_miss_tolerance", { missTolerance: String(missTolerance) });
  const last = optionalMs(input.lastHeartbeatAtMs, "lastHeartbeatAtMs");
  const ageMs = last === null ? null : now - last;
  const missedTicks = ageMs === null ? null : Math.max(0, Math.floor(ageMs / intervalMs) - 1);
  const stale = ageMs === null ? true : ageMs > intervalMs * (missTolerance + 1);
  return Object.freeze({
    atMs: now, lastHeartbeatAtMs: last, ageMs, missedTicks, stale,
    escalate: stale,
    // Der Watchdog laeuft ausserhalb dieses Prozesses. Er darf sich NICHT
    // auf denselben Scheduler, dieselbe Laufzeit und dieselben Zugaenge
    // stuetzen, sonst faellt er mit dem Monitor zusammen aus.
    watchdog: Object.freeze({
      contract: "external_independent",
      expectsHeartbeatEveryMs: intervalMs,
      escalateAfterMs: intervalMs * (missTolerance + 1),
      mustNotShare: Object.freeze(["scheduler", "runtime", "credentials"]),
    }),
    availabilityClaim: null, // kein absoluter Verfuegbarkeitsanspruch
  });
}

/* Wenn schon die WARNUNG nicht zugestellt werden kann, darf sie nicht als
 * zugestellt gelten. Es gibt keinen stillen Verlust. */
export function planWarningEscalation(input = {}) {
  const now = requireMs(input.now, "now");
  const failures = input.failures;
  if (!Number.isSafeInteger(failures) || failures < 0) fail("invalid_failures", { failures: String(failures) });
  const channelsTried = Array.isArray(input.channelsTried) ? input.channelsTried.filter((c) => typeof c === "string") : [];
  const remaining = Array.isArray(input.channels)
    ? input.channels.filter((c) => typeof c === "string" && !channelsTried.includes(c))
    : [];
  return Object.freeze({
    atMs: now,
    assumeDelivered: false,
    nextChannel: remaining[0] || null,
    escalateToWatchdog: remaining.length === 0,
    recordFailure: true,
    failures: failures + 1,
    channelsTried: Object.freeze([...channelsTried]),
    reason: remaining.length === 0 ? "all_warning_channels_failed" : "warning_delivery_failed",
  });
}
