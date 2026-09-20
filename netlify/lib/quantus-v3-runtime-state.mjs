/* ══ Quantus Tagesbriefing v3 — Laufzeitzustand im zentralen Kern (E1-A/B) ══
 *
 * Reine, SYNCHRONE Mutatoren auf dem bereits geparsten Bestand. Jede
 * Funktion hat die Form
 *
 *     mutator(data, input) -> { data, result, unchanged? }
 *
 * und darf in genau dieser Form in der CAS-Schleife wiederholt werden
 * (`mutateAppData` bzw. `applyIdempotentCommand`). Deshalb gilt hier
 * ausnahmslos:
 *
 *   · keine Uhr — `now` kommt als Millisekundenzahl von aussen
 *   · keine UUID, kein Zufall — jede Kennung wird vom Aufrufer gestellt
 *   · kein HTTP, kein Firebase, kein Modell, keine Mail, kein Upload
 *   · keine Hashes — Inhaltshashes werden serverseitig VOR dem CAS gebildet
 *   · unbekannte Felder und `_deleteLog` bleiben unangetastet
 *   · fehlender, kaputter oder noch nicht migrierter Kern => 503, niemals
 *     ein neuer Bestand aus `null`
 *
 * `unchanged: true` heisst: der zurueckgegebene Bestand ist BYTEIDENTISCH
 * mit dem hereingegebenen (es wird dieselbe Referenz zurueckgegeben), der
 * Schreibpfad darf also gar nichts schreiben. Fachliche Absagen
 * (Lease-Konflikt, Budget erschoepft, doppelte Zustellung) sind genau das:
 * ein Ergebnis mit `ok: false` und ohne Datenaenderung. Strukturelle Fehler
 * (ungueltiger Kern, ungueltige Eingabe, Ueberlauf) werfen einen
 * `RuntimeStateError` mit Code und Status — fail closed.
 *
 * Alles, was diese Datei anlegt, liegt unter `data.automation`:
 *
 *   automation.activeLease          der EINE fuehrende Besitz samt Fence
 *   automation.runtime.leaseFenceCounter  monoton, ueberlebt jedes Release
 *   automation.runtime.runsByKey    Laufabschnitte, Werkzeugschritte, Grenzen
 *   automation.runtime.continuationsById  Fortsetzungsabsichten (genau eine
 *                                   offene je Lauf, doppelte Zustellung
 *                                   erzeugt keine zweite Arbeit)
 *   automation.runtime.incidentsById  Vorfaelle, werden nie geloescht
 *   automation.runtime.cost         der EINZIGE Kostenbeleg-Bestand
 *   automation.runtime.monitor      Heartbeat und Tick-Dedupe
 *
 * Es gibt KEINE zweite Aufgaben-, Lead-, Status- oder Kostendatenbank. Eine
 * fachliche Aenderung und ihr Beleg gehen in denselben CAS.
 *
 * Schnittstelle zu Paket B (`assistant-*.mjs`): dessen `acquireLease`/
 * `releaseLease` samt Sechs-Stunden-Platzhalter wird hier NICHT verwendet
 * und nicht importiert. Die verbindliche Uebergabe steht in
 * docs/quantus-v3-runtime-state.md.
 * ═════════════════════════════════════════════════════════════════════════ */

import {
  lateWindow, parseSlotRunKey, slotRunKey, PLAN_SCHEMA, MINUTE_MS, LATE_WINDOW,
  localDate as zurichLocalDate, isLocalDate,
} from "./quantus-v3-runtime-plan.mjs";

export const RUNTIME_SCHEMA_VERSION = 1;
export const AUTOMATION_SCHEMA_VERSION = 3;

/* ── Grenzen ───────────────────────────────────────────────────────────── */

export const LEASE_TTL_MS = 120_000;          // 120 Sekunden
export const LEASE_RENEW_AFTER_MS = 60_000;   // spaetestens nach 60 Sekunden
export const LEASE_MIN_TTL_MS = 10_000;
export const LEASE_MAX_TTL_MS = LEASE_TTL_MS; // laengere TTL wird abgelehnt

export const RUN_MAX_ACTIVE_MS = 20 * MINUTE_MS;  // aktive Laufzeit je Hauptlauf
export const RUN_MAX_TOOL_STEPS = 30;             // Werkzeugschritte je Hauptlauf
export const HTTP_SECTION_MAX_MS = 90_000;        // HTTP-Abschnitt
export const SECTION_KINDS = Object.freeze(["work", "http", "late"]);
export const RUN_PHASES = Object.freeze(["active", "checkpointed", "exception_open", "finished"]);
export const RUN_OUTCOMES = Object.freeze(["dry_run", "completed", "no_work", "aborted"]);
export const ORIGINS = Object.freeze(["runner", "monitor", "user", "system"]);

export const MAX_STEP_DURATION_MS = RUN_MAX_ACTIVE_MS;
export const MAX_CURSOR_BYTES = 8 * 1024;

/* Kosten immer als ganzzahlige Mikrobetraege (1e-6 Waehrungseinheiten).
 * Gleitkomma hat in einem Ledger nichts verloren. */
export const MICRO = 1;
export const MAX_MICROS = 1_000_000_000_000;       // 1e12 Mikro = 1 Mio Einheiten
export const MAX_TOKENS_PER_CALL = 10_000_000;
export const MAX_MICROS_PER_MILLION_TOKENS = 100_000_000;
export const COST_POLICY_SCHEMA = "quantus-v3-cost-policy/1";
export const COST_CALL_STATES = Object.freeze(["reserved", "settled", "released", "unknown"]);
export const FEATURE_MODES = Object.freeze(["dry_run", "live"]);

/* ── Fehler ────────────────────────────────────────────────────────────── */

export class RuntimeStateError extends Error {
  constructor(code, status = 400, detail = null) {
    super(detail ? `${code}: ${JSON.stringify(detail)}` : code);
    this.name = "RuntimeStateError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function fail(code, status = 400, detail = null) { throw new RuntimeStateError(code, status, detail); }

/* ── Kleine Pruefer ────────────────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const HASH_RE = /^[A-Za-z0-9+/=_-]{16,200}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireId(value, name, re = ID_RE) {
  if (typeof value !== "string" || !re.test(value)) fail("invalid_identifier", 400, { name, value: typeof value === "string" ? value.slice(0, 40) : String(value) });
  return value;
}

function requireMs(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("invalid_timestamp", 400, { name, value: String(value) });
  }
  return value;
}

function requireInt(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_integer", 400, { name, value: String(value), min, max });
  }
  return value;
}

function safeAdd(a, b, name) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum > Number.MAX_SAFE_INTEGER) fail("micro_overflow", 500, { name });
  return sum;
}

function requireJsonRecord(value, name, maxBytes = MAX_CURSOR_BYTES) {
  if (!isRecord(value)) fail("invalid_record", 400, { name });
  let text;
  try { text = JSON.stringify(value); } catch { fail("invalid_record", 400, { name }); }
  if (typeof text !== "string") fail("invalid_record", 400, { name });
  if (Buffer.byteLength(text) > maxBytes) fail("record_too_large", 413, { name, maxBytes });
  return JSON.parse(text);
}

/* ── Kern lesen ────────────────────────────────────────────────────────── */

/* Fail closed: ohne gueltige, migrierte automation wird NICHTS geschrieben. */
export function assertCore(data) {
  if (!isRecord(data) || !isRecord(data.entities)) fail("core_invalid", 503);
  const automation = data.automation;
  if (!isRecord(automation)) fail("automation_not_ready", 503, { reason: "missing" });
  if (automation.schemaVersion !== AUTOMATION_SCHEMA_VERSION) fail("automation_not_ready", 503, { reason: "schema_version" });
  if (!Number.isSafeInteger(automation.dataRevision) || automation.dataRevision < 0) fail("automation_not_ready", 503, { reason: "data_revision" });
  if (!isRecord(automation.idempotencyByKey)) fail("automation_not_ready", 503, { reason: "idempotency_ledger" });
  return automation;
}

export function emptyRuntimeArea() {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    leaseFenceCounter: 0,
    runsByKey: {},
    continuationsById: {},
    incidentsById: {},
    cost: {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      policyRef: null,
      callsById: {},
      receiptIndex: {},
      providerRequestIndex: {},
      contentHashIndex: {},
      byDay: {},
      byRun: {},
      unresolved: { count: 0, micros: 0, callIds: [] },
      overrunMicros: 0,
      dryRunChargeCount: 0,
    },
    monitor: { lastTickAtMs: null, lastHeartbeatAtMs: null, warnFailures: 0, recentTickIds: [], ticksById: {}, lastTruncatedAtMs: null },
  };
}

/* ── Pruefung eines VORHANDENEN Laufzeitbereichs ────────────────────────
 * Gegenbeispiele 1-3 aus der unabhaengigen Pruefung: ein geloeschter
 * Tagesbeleg, eine negative Summe oder ein fehlender Fence-Zaehler wurden
 * stillschweigend als 0 gelesen — und damit war frueherer Verbrauch
 * vergessen und ein alter Fence wieder vergebbar.
 *
 * Seither gilt: NUR ein ganz neuer Laufzeitbereich (automation.runtime
 * fehlt vollstaendig) wird angelegt. Ist einer da, muss er vollstaendig
 * und in sich stimmig sein — sonst 503. Es wird nichts ergaenzt,
 * nichts genullt und nichts geraten. */

function requireCounter(value, reason) {
  if (!Number.isSafeInteger(value) || value < 0) fail("runtime_area_invalid", 503, { reason });
  return value;
}

/* Der hoechste Fence, der IRGENDWO im Bestand vorkommt. Der Zaehler darf
 * nie darunter liegen, sonst bekaeme ein alter Fence wieder Rechte. */
function observedMaxFence(automation, runtime) {
  let max = 0;
  const take = (v) => { if (Number.isSafeInteger(v) && v > max) max = v; };
  if (isRecord(automation.activeLease)) take(automation.activeLease.fence);
  for (const run of Object.values(runtime.runsByKey || {})) {
    if (!isRecord(run)) continue;
    for (const section of Object.values(run.sections || {})) if (isRecord(section)) take(section.fence);
    if (isRecord(run.checkpoint)) take(run.checkpoint.fence);
    if (isRecord(run.exception)) take(run.exception.fence);
    if (isRecord(run.outcome)) take(run.outcome.fence);
  }
  const cost = isRecord(runtime.cost) ? runtime.cost : null;
  if (cost) for (const call of Object.values(cost.callsById || {})) if (isRecord(call)) take(call.fence);
  return max;
}

export function validateRuntimeArea(automation, runtime) {
  if (!isRecord(runtime)) fail("runtime_area_invalid", 503, { found: typeof runtime });
  if (runtime.schemaVersion !== RUNTIME_SCHEMA_VERSION) fail("runtime_area_invalid", 503, { reason: "schema_version" });
  requireCounter(runtime.leaseFenceCounter, "lease_fence_counter");
  for (const field of ["runsByKey", "continuationsById", "incidentsById", "cost", "monitor"]) {
    if (!isRecord(runtime[field])) fail("runtime_area_invalid", 503, { reason: "missing_area", field });
  }
  const monitor = runtime.monitor;
  for (const field of ["lastTickAtMs", "lastHeartbeatAtMs"]) {
    const v = monitor[field];
    if (v !== null && !(Number.isSafeInteger(v) && v > 0)) fail("runtime_area_invalid", 503, { reason: "monitor_field", field });
  }
  requireCounter(monitor.warnFailures, "monitor_warn_failures");
  if (!Array.isArray(monitor.recentTickIds) || !isRecord(monitor.ticksById)) fail("runtime_area_invalid", 503, { reason: "monitor_history" });
  validateCostArea(runtime.cost);
  const observed = observedMaxFence(automation, runtime);
  if (runtime.leaseFenceCounter < observed) {
    fail("runtime_area_invalid", 503, { reason: "fence_counter_behind", counter: runtime.leaseFenceCounter, observed });
  }
  return runtime;
}

/* Gegenbeispiel R2-04: wer `automation.runtime` ganz loescht, bekam einen
 * frischen, leeren Bereich — Fence wieder 1, alle Kostenbelege vergessen.
 * "Bereich fehlt" darf deshalb nicht mehr automatisch "erste
 * Initialisierung" heissen.
 *
 * Der Nachweis der Initialisierung liegt NEBEN dem loeschbaren Bereich:
 *
 *     automation.runtimeInit = { schemaVersion, initializedAtMs, initializedBy }
 *
 * Fehlt der Bereich, obwohl der Nachweis da ist, ist das 503 und der Kern
 * bleibt unveraendert — es wird nichts rekonstruiert und nichts genullt.
 * Umgekehrt ist ein Bereich ohne Nachweis ebenfalls 503. Eine erste
 * Initialisierung bleibt moeglich: nur wenn BEIDES fehlt, entstehen
 * Bereich und Nachweis zusammen in derselben Mutation. */
export const RUNTIME_INIT_SCHEMA_VERSION = 1;

function readInitMarker(automation) {
  const marker = automation.runtimeInit;
  if (marker === undefined) return null;
  if (!isRecord(marker) || marker.schemaVersion !== RUNTIME_INIT_SCHEMA_VERSION
    || !Number.isSafeInteger(marker.initializedAtMs) || marker.initializedAtMs <= 0
    || typeof marker.initializedBy !== "string" || !marker.initializedBy) {
    fail("runtime_init_marker_invalid", 503, { reason: "shape" });
  }
  return marker;
}

/* Nur-Lese-Sicht. Legt NICHTS an. */
export function readRuntime(data) {
  const automation = assertCore(data);
  const marker = readInitMarker(automation);
  const runtime = automation.runtime;
  if (runtime === undefined) {
    if (marker !== null) {
      fail("runtime_missing_after_init", 503, { initializedAtMs: marker.initializedAtMs });
    }
    return emptyRuntimeArea();
  }
  if (marker === null) fail("runtime_init_marker_missing", 503);
  return validateRuntimeArea(automation, runtime);
}

/* Schreibsicht auf einer bereits geklonten Kopie. Ein vorhandener Bereich
 * wird geprueft, nicht ergaenzt. */
function runtimeForWrite(automation, now, initializedBy) {
  const marker = readInitMarker(automation);
  if (automation.runtime === undefined) {
    if (marker !== null) fail("runtime_missing_after_init", 503, { initializedAtMs: marker.initializedAtMs });
    automation.runtime = emptyRuntimeArea();
    automation.runtimeInit = {
      schemaVersion: RUNTIME_INIT_SCHEMA_VERSION,
      initializedAtMs: requireMs(now, "now"),
      initializedBy: typeof initializedBy === "string" && initializedBy ? initializedBy : "runtime",
    };
    return automation.runtime;
  }
  if (marker === null) fail("runtime_init_marker_missing", 503);
  return validateRuntimeArea(automation, automation.runtime);
}

function begin(data, now, initializedBy) {
  assertCore(data);
  const next = structuredClone(data);
  const automation = next.automation;
  const runtime = runtimeForWrite(automation, now, initializedBy);
  return { next, automation, runtime };
}

function commit(next, result) {
  next.automation.dataRevision = safeAdd(next.automation.dataRevision, 1, "dataRevision");
  return { data: next, result: { ok: true, ...result } };
}

/* Fachliche Absage: identischer Bestand, dieselbe Referenz. */
function reject(data, code, detail = null) {
  return { data, result: { ok: false, code, detail }, unchanged: true };
}

/* Fachlicher No-op (doppelte Zustellung, Wiederholung): ebenfalls ohne Schreiben. */
function noop(data, result) {
  return { data, result: { ok: true, ...result }, unchanged: true };
}

/* ═══ E1-A · Lease und Fencing ═══════════════════════════════════════════ */

const SCOPE_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function requireVerifiedScope(scope) {
  if (!isRecord(scope)) fail("invalid_verified_scope", 400, { reason: "shape" });
  const holder = requireId(scope.holder, "holder");
  const leaseScope = requireId(scope.scope, "scope", SCOPE_RE);
  const fence = scope.fence;
  if (!Number.isSafeInteger(fence) || fence < 1) fail("invalid_verified_scope", 400, { reason: "fence", fence: String(fence) });
  return { holder, scope: leaseScope, fence };
}

function requireTtl(ttlMs) {
  if (ttlMs === undefined || ttlMs === null) return LEASE_TTL_MS;
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs)) fail("invalid_ttl", 400, { ttlMs: String(ttlMs) });
  if (ttlMs < LEASE_MIN_TTL_MS) fail("invalid_ttl", 400, { reason: "too_short", ttlMs });
  if (ttlMs > LEASE_MAX_TTL_MS) fail("invalid_ttl", 400, { reason: "too_long", ttlMs, max: LEASE_MAX_TTL_MS });
  return ttlMs;
}

/* Ein vorhandener Lease-Eintrag muss GENAU unsere Form haben. Ein fremder
 * oder alter Eintrag (etwa der Sechs-Stunden-Platzhalter aus Paket B) wird
 * nicht umgedeutet und nicht ueberschrieben: 503, bis er migriert ist. */
function readLease(automation, runtime) {
  const lease = automation.activeLease;
  if (lease === undefined || lease === null) return null;
  if (!isRecord(lease)) fail("lease_record_invalid", 503, { reason: "shape" });
  const feld = (bedingung, reason) => { if (!bedingung) fail("lease_record_invalid", 503, { reason }); };
  feld(lease.schemaVersion === RUNTIME_SCHEMA_VERSION, "schema_version");
  feld(typeof lease.holder === "string" && ID_RE.test(lease.holder), "holder");
  feld(typeof lease.scope === "string" && SCOPE_RE.test(lease.scope), "scope");
  feld(Number.isSafeInteger(lease.fence) && lease.fence >= 1, "fence");
  for (const field of ["acquiredAtMs", "renewedAtMs", "expiresAtMs", "renewByMs", "ttlMs"]) {
    feld(Number.isSafeInteger(lease[field]) && lease[field] > 0, field);
  }
  // Gegenbeispiel 4: eine Lease mit zehn Stunden TTL galt als gueltig, weil
  // nur auf "positive Zahl" geprueft wurde. Die Zeitinvarianten sind jetzt
  // vollstaendig und exakt — eine Lease, die nicht nach genau diesen Regeln
  // entstanden sein kann, ist ein kaputter Datensatz, kein Besitz.
  feld(lease.ttlMs >= LEASE_MIN_TTL_MS && lease.ttlMs <= LEASE_MAX_TTL_MS, "ttl_out_of_range");
  feld(lease.acquiredAtMs <= lease.renewedAtMs, "acquired_after_renewed");
  feld(lease.expiresAtMs === lease.renewedAtMs + lease.ttlMs, "expires_mismatch");
  feld(lease.renewByMs === lease.renewedAtMs + Math.min(LEASE_RENEW_AFTER_MS, lease.ttlMs), "renew_by_mismatch");
  feld(lease.renewByMs <= lease.expiresAtMs, "renew_by_after_expiry");
  // Der Besitz muss zum persistierten Zaehler passen.
  const counter = runtime && Number.isSafeInteger(runtime.leaseFenceCounter) ? runtime.leaseFenceCounter : null;
  feld(counter !== null && lease.fence <= counter, "fence_above_counter");
  return lease;
}

function nextFence(runtime) {
  // Der Zaehler ist beim Lesen geprueft: vorhanden, ganzzahlig und nicht
  // hinter irgendeinem tatsaechlich vergebenen Fence. Er ist damit die
  // einzige Quelle — ein fehlender Zaehler war Gegenbeispiel 3.
  const counter = runtime.leaseFenceCounter;
  if (!Number.isSafeInteger(counter) || counter < 0) fail("runtime_area_invalid", 503, { reason: "lease_fence_counter" });
  const fence = safeAdd(counter, 1, "leaseFenceCounter");
  if (fence > Number.MAX_SAFE_INTEGER - 1) fail("lease_fence_exhausted", 503);
  return fence;
}

function leaseRecord({ scope, holder, fence, now, ttlMs, acquiredAtMs }) {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    scope, holder, fence,
    acquiredAtMs: acquiredAtMs ?? now,
    renewedAtMs: now,
    expiresAtMs: safeAdd(now, ttlMs, "expiresAtMs"),
    renewByMs: safeAdd(now, Math.min(LEASE_RENEW_AFTER_MS, ttlMs), "renewByMs"),
    ttlMs,
  };
}

/* Neuer Besitz — auch derselbe Besitzer nach Ablauf — erhaelt einen STRENG
 * hoeheren Fence. Der Zaehler lebt ausserhalb von activeLease und ueberlebt
 * damit jedes Release. */
export function acquireLease(data, input = {}) {
  const now = requireMs(input.now, "now");
  const holder = requireId(input.holder, "holder");
  const scope = requireId(input.scope, "scope", SCOPE_RE);
  const ttlMs = requireTtl(input.ttlMs);
  assertCore(data);
  const runtimeBefore = readRuntime(data);   // vollstaendige Formpruefung
  const current = readLease(data.automation, runtimeBefore);

  if (current) {
    const expired = now >= current.expiresAtMs;
    if (!expired) {
      if (current.scope !== scope) {
        return reject(data, "lease_scope_busy", { heldScope: current.scope, holder: current.holder, expiresAtMs: current.expiresAtMs });
      }
      if (current.holder === holder) {
        // Doppelte Zustellung desselben Auftrags: kein zweiter Fence, keine
        // zweite Arbeit. Wer wirklich neu starten will, laesst ablaufen
        // oder gibt zuerst frei.
        return noop(data, { acquired: false, duplicate: true, lease: structuredClone(current), fence: current.fence });
      }
      return reject(data, "lease_held", { holder: current.holder, fence: current.fence, expiresAtMs: current.expiresAtMs });
    }
  }

  const { next, automation, runtime } = begin(data, now);
  const fence = nextFence(runtime);
  runtime.leaseFenceCounter = fence;
  automation.activeLease = leaseRecord({ scope, holder, fence, now, ttlMs });
  return commit(next, {
    acquired: true, duplicate: false, fence,
    lease: structuredClone(automation.activeLease),
    takeoverFrom: current ? { holder: current.holder, fence: current.fence, expiredAtMs: current.expiresAtMs } : null,
  });
}

/* Erneuern nur mit EXAKTEM holder + fence + scope. Nach Ablauf ist es keine
 * Erneuerung mehr, sondern eine Wiederbelebung — und die gibt es nicht. */
export function renewLease(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope({ holder: input.holder, fence: input.fence, scope: input.scope });
  const ttlMs = requireTtl(input.ttlMs);
  const runtimeBefore = readRuntime(data);
  const current = readLease(data.automation, runtimeBefore);
  if (!current) return reject(data, "lease_absent", null);
  if (current.scope !== verified.scope || current.holder !== verified.holder || current.fence !== verified.fence) {
    return reject(data, "lease_fenced", { currentHolder: current.holder, currentFence: current.fence });
  }
  if (now >= current.expiresAtMs) {
    return reject(data, "lease_expired", { expiresAtMs: current.expiresAtMs, now });
  }
  const { next, automation } = begin(data, now);
  const lease = automation.activeLease;
  const lateRenewal = Number.isSafeInteger(current.renewByMs) && now > current.renewByMs;
  lease.renewedAtMs = now;
  lease.ttlMs = ttlMs;
  lease.expiresAtMs = safeAdd(now, ttlMs, "expiresAtMs");
  lease.renewByMs = safeAdd(now, Math.min(LEASE_RENEW_AFTER_MS, ttlMs), "renewByMs");
  return commit(next, { renewed: true, lateRenewal, fence: lease.fence, lease: structuredClone(lease) });
}

/* Freigeben nur mit exaktem holder + fence. Der Fence-Zaehler bleibt. */
export function releaseLease(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope({ holder: input.holder, fence: input.fence, scope: input.scope });
  const runtimeBefore = readRuntime(data);
  const current = readLease(data.automation, runtimeBefore);
  if (!current) return noop(data, { released: false, reason: "absent" });
  if (current.scope !== verified.scope || current.holder !== verified.holder || current.fence !== verified.fence) {
    return reject(data, "lease_fenced", { currentHolder: current.holder, currentFence: current.fence });
  }
  const { next, automation, runtime } = begin(data, now);
  const wasExpired = now >= current.expiresAtMs;
  automation.activeLease = null;
  // Der Zaehler wird NICHT zurueckgesetzt: der naechste Besitz muss streng
  // hoeher liegen als jeder frueher vergebene Fence.
  if (!Number.isSafeInteger(runtime.leaseFenceCounter) || runtime.leaseFenceCounter < current.fence) {
    runtime.leaseFenceCounter = current.fence;
  }
  return commit(next, { released: true, wasExpired, fence: current.fence, fenceCounter: runtime.leaseFenceCounter });
}

/* Verdikt ohne Ausnahme — fuer Protokolle und Vorabpruefungen. */
export function checkLeadership(data, verifiedScope, now) {
  const at = requireMs(now, "now");
  const verified = requireVerifiedScope(verifiedScope);
  const runtime = readRuntime(data);
  const current = readLease(data.automation, runtime);
  if (!current) return { ok: false, code: "lease_absent", lease: null };
  if (current.scope !== verified.scope) return { ok: false, code: "lease_scope_mismatch", lease: current };
  if (current.holder !== verified.holder) return { ok: false, code: "lease_foreign_holder", lease: current };
  if (current.fence !== verified.fence) return { ok: false, code: "lease_fenced", lease: current, currentFence: current.fence };
  if (at >= current.expiresAtMs) return { ok: false, code: "lease_expired", lease: current };
  return {
    ok: true, code: null, lease: current, fence: current.fence,
    remainingMs: current.expiresAtMs - at,
    renewDueInMs: current.renewByMs - at,
    mustRenew: at >= current.renewByMs,
  };
}

/* Die EINE Pruefung, die jeder spaetere leitende CAS-Mutator als erstes
 * aufruft. Wirft — damit ein vergessener Rueckgabewert nicht still
 * durchrutscht. */
export function assertLeadership(data, verifiedScope, now) {
  const verdict = checkLeadership(data, verifiedScope, now);
  if (!verdict.ok) {
    fail(verdict.code, verdict.code === "lease_absent" ? 409 : 409, {
      currentHolder: verdict.lease ? verdict.lease.holder : null,
      currentFence: verdict.lease ? verdict.lease.fence : null,
    });
  }
  return verdict;
}

/* Nur der Laeufer fuehrt. Nutzeraktionen werden NICHT pauschal gesperrt:
 * sie laufen ohne Lease durch denselben CAS. */
export function requiresLeadership(origin) {
  if (!ORIGINS.includes(origin)) fail("unknown_origin", 400, { origin: String(origin) });
  return origin === "runner";
}

/* ═══ E1-A · Laufzeitgrenzen, Checkpoint, Fortsetzung ════════════════════ */

function emptyRun(parsed, now) {
  return {
    runKey: parsed.runKey,
    tenant: parsed.tenant,
    localDate: parsed.localDate,
    slot: parsed.slot,
    policyVersion: parsed.policyVersion,
    createdAtMs: now,
    updatedAtMs: now,
    phase: "active",
    // Wandzeit abgeschlossener Abschnitte. Sie zaehlt auch Arbeit, die
    // KEIN Werkzeugschritt war — sonst liesse sich das 20-Minuten-Budget
    // mit Nicht-Werkzeug-Arbeit umgehen (Gegenbeispiel 7).
    closedSectionsMs: 0,
    toolMs: 0,
    toolSteps: 0,
    lateSections: 0,
    // Hauptbudget und Zusatzfenster sind GETRENNT: jedes bewilligte
    // 5-Minuten-Spaetfenster kommt oben drauf (Gegenbeispiel 8).
    grantedExtraMs: 0,
    sections: {},
    currentSectionId: null,
    checkpoint: null,
    pendingContinuationId: null,
    consumedContinuationIds: [],
    outcome: null,
    green: false,
  };
}

/* Einen Abschnitt schliessen und seine WANDZEIT dem Lauf gutschreiben.
 * Nur hier waechst closedSectionsMs — damit gibt es genau einen Weg. */
function closeSection(run, section, now, reason) {
  if (!isRecord(section) || section.closed === true) return section;
  section.closed = true;
  section.endedAtMs = now;
  section.closeReason = String(reason).slice(0, 64);
  const wall = Math.max(0, now - section.startedAtMs);
  section.wallMs = wall;
  run.closedSectionsMs = safeAdd(run.closedSectionsMs || 0, wall, "closedSectionsMs");
  return section;
}

function requireRun(runtime, runKey) {
  const run = runtime.runsByKey[runKey];
  if (!isRecord(run)) fail("run_unknown", 409, { runKey });
  return run;
}

/* Die tatsaechlich verbrauchte aktive Zeit: Wandzeit aller abgeschlossenen
 * Abschnitte, plus die des offenen, mindestens aber die gemeldete
 * Werkzeugzeit. So faellt weder Nicht-Werkzeug-Arbeit unter den Tisch noch
 * ein Werkzeugschritt, der laenger dauert als die gemessene Wandzeit. */
export function effectiveActiveMs(run, now) {
  const sections = isRecord(run.sections) ? run.sections : {};
  let open = 0;
  const current = run.currentSectionId ? sections[run.currentSectionId] : null;
  if (isRecord(current) && !current.closed && Number.isSafeInteger(current.startedAtMs)) {
    open = Math.max(0, now - current.startedAtMs);
  }
  return Math.max(safeAdd(run.closedSectionsMs || 0, open, "activeMs"), run.toolMs || 0);
}

/* Reine Auswertung — keine Daten, kein Schreiben.
 * `extraAllowanceMs` erlaubt es, ein noch nicht bewilligtes Spaetfenster
 * probeweise mitzurechnen. */
export function evaluateRuntimeBudget(run, input = {}) {
  if (!isRecord(run)) fail("invalid_run", 400);
  const now = requireMs(input.now, "now");
  const sections = isRecord(run.sections) ? run.sections : {};
  const wantedSectionId = input.sectionId || run.currentSectionId || null;
  const section = wantedSectionId ? sections[wantedSectionId] : null;
  const reasons = [];
  const extraAllowanceMs = input.extraAllowanceMs === undefined
    ? (run.grantedExtraMs || 0)
    : requireInt(input.extraAllowanceMs, "extraAllowanceMs", { min: 0, max: LATE_WINDOW.maxExtraSections * LATE_WINDOW.sectionMs });
  const allowedActiveMs = safeAdd(RUN_MAX_ACTIVE_MS, extraAllowanceMs, "allowedActiveMs");
  const activeMs = effectiveActiveMs(run, now);
  const remainingActiveMs = allowedActiveMs - activeMs;
  const remainingToolSteps = RUN_MAX_TOOL_STEPS - (run.toolSteps || 0);
  if (remainingActiveMs <= 0) reasons.push("run_active_ms_exhausted");
  if (remainingToolSteps <= 0) reasons.push("run_tool_steps_exhausted");

  let remainingSectionMs = null;
  if (isRecord(section) && !section.closed) {
    const elapsed = now - section.startedAtMs;
    if (elapsed < 0) fail("invalid_timestamp", 400, { name: "now", reason: "before_section_start" });
    remainingSectionMs = section.budgetMs - elapsed;
    if (remainingSectionMs <= 0) reasons.push(section.kind === "http" ? "http_section_exhausted" : "section_budget_exhausted");
  }

  let hardStopAtMs = null;
  if (run.slot === LATE_WINDOW.slot) {
    hardStopAtMs = lateWindow(run.localDate).hardStopAtMs;
    if (now >= hardStopAtMs) reasons.push("late_hard_stop");
  }

  return Object.freeze({
    mustStop: reasons.length > 0,
    reasons: Object.freeze(reasons),
    activeMs, remainingActiveMs, remainingToolSteps, remainingSectionMs, hardStopAtMs,
    allowedActiveMs, extraAllowanceMs,
    maxActiveMs: RUN_MAX_ACTIVE_MS, maxToolSteps: RUN_MAX_TOOL_STEPS, maxHttpSectionMs: HTTP_SECTION_MAX_MS,
    maxExtraSections: LATE_WINDOW.maxExtraSections, extraSectionMs: LATE_WINDOW.sectionMs,
  });
}

function defaultSectionBudget(kind, run, localDate, now) {
  if (kind === "http") return HTTP_SECTION_MAX_MS;
  if (kind === "late") return lateWindow(localDate).sectionMs;
  return Math.max(0, RUN_MAX_ACTIVE_MS + (run.grantedExtraMs || 0) - effectiveActiveMs(run, now));
}

/* Startet einen Abschnitt. Doppelte Zustellung derselben sectionId ist ein
 * Nulldurchlauf; eine Fortsetzung verbraucht ihre Absicht in DERSELBEN
 * Mutation (genau einmal). */
export function startRunSection(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const parsed = parseSlotRunKey(input.runKey);
  const sectionId = requireId(input.sectionId, "sectionId");
  const kind = input.kind === undefined ? "work" : input.kind;
  if (!SECTION_KINDS.includes(kind)) fail("unknown_section_kind", 400, { kind: String(kind) });
  const resumeFrom = input.resumeFrom === undefined || input.resumeFrom === null ? null : requireId(input.resumeFrom, "resumeFrom");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const existingRun = runtimeBefore.runsByKey[parsed.runKey];
  if (isRecord(existingRun) && isRecord(existingRun.sections) && isRecord(existingRun.sections[sectionId])) {
    return noop(data, { duplicate: true, runKey: parsed.runKey, sectionId, section: structuredClone(existingRun.sections[sectionId]) });
  }
  if (isRecord(existingRun) && existingRun.phase === "finished") {
    return reject(data, "run_finished", { runKey: parsed.runKey });
  }
  if (isRecord(existingRun) && existingRun.pendingContinuationId && resumeFrom === null) {
    return reject(data, "continuation_required", { runKey: parsed.runKey, pendingContinuationId: existingRun.pendingContinuationId });
  }
  if (resumeFrom !== null) {
    // Eine Nachholabsicht des Monitors kann es geben, OHNE dass je ein Lauf
    // existierte — genau das ist der Fall "Slot gar nicht erst gestartet".
    // Der Lauf wird dann unten angelegt.
    if (isRecord(existingRun) && existingRun.pendingContinuationId && existingRun.pendingContinuationId !== resumeFrom) {
      // Der Lauf wartet auf eine ANDERE Absicht — die falsche zu verbrauchen
      // wuerde die offene Fortsetzung verlieren.
      return reject(data, "continuation_conflict", { pending: existingRun.pendingContinuationId, requested: resumeFrom });
    }
    const intent = runtimeBefore.continuationsById[resumeFrom];
    if (!isRecord(intent)) return reject(data, "continuation_unknown", { continuationId: resumeFrom });
    if (intent.runKey !== parsed.runKey) return reject(data, "continuation_run_mismatch", { continuationId: resumeFrom, runKey: intent.runKey });
    if (intent.state === "consumed") {
      // Zweite Zustellung derselben Fortsetzung: KEINE zweite Arbeit.
      return noop(data, { duplicate: true, alreadyConsumed: true, continuationId: resumeFrom, runKey: parsed.runKey });
    }
    if (intent.state !== "pending") return reject(data, "continuation_not_pending", { continuationId: resumeFrom, state: intent.state });
    if (Number.isSafeInteger(intent.notBeforeMs) && now < intent.notBeforeMs) {
      return reject(data, "continuation_not_due", { continuationId: resumeFrom, notBeforeMs: intent.notBeforeMs });
    }
  }

  // Gegenbeispiel 7: zwei offene Abschnitte nebeneinander haben die
  // 90-Sekunden- und die 20-Minuten-Grenze ausgehebelt, weil
  // currentSectionId einfach ersetzt wurde. Ein neuer Abschnitt entsteht
  // jetzt nur nach einem geordneten Checkpoint (bzw. Abschluss/Ausnahme)
  // oder nach einer AUSDRUECKLICH protokollierten Wiederaufnahme.
  const crashRecovery = input.crashRecovery === undefined || input.crashRecovery === null ? null : input.crashRecovery;
  if (isRecord(existingRun) && existingRun.currentSectionId) {
    const offen = isRecord(existingRun.sections) ? existingRun.sections[existingRun.currentSectionId] : null;
    if (isRecord(offen) && offen.closed !== true) {
      if (!isRecord(crashRecovery)) {
        return reject(data, "section_already_open", { runKey: parsed.runKey, openSectionId: offen.id });
      }
      if (crashRecovery.previousSectionId !== offen.id
        || typeof crashRecovery.reason !== "string" || !ID_RE.test(crashRecovery.reason)) {
        return reject(data, "crash_recovery_invalid", { openSectionId: offen.id });
      }
    }
  } else if (isRecord(crashRecovery)) {
    return reject(data, "crash_recovery_without_open_section", { runKey: parsed.runKey });
  }

  const { next, runtime } = begin(data, now);
  const run = isRecord(runtime.runsByKey[parsed.runKey]) ? runtime.runsByKey[parsed.runKey] : (runtime.runsByKey[parsed.runKey] = emptyRun(parsed, now));

  // Spaetfenster am 23-Uhr-Slot: hoechstens zwei weitere Abschnitte a 5 min,
  // spaetestens 23:30. Danach gibt es nur noch exception_open. Der harte
  // Schluss wird ZUERST geprueft, damit er als eigener Grund sichtbar ist
  // und nicht unter "budget_exhausted" verschwindet.
  const late = lateWindow(parsed.localDate);
  const isLateSlot = parsed.slot === late.slot;
  if (isLateSlot && now >= late.hardStopAtMs) {
    return reject(data, "late_hard_stop", { hardStopAtMs: late.hardStopAtMs, runKey: parsed.runKey });
  }

  // Erst klaeren, ob ein Zusatzfenster bewilligt wird — es bringt sein
  // EIGENES Budget mit und darf nicht am aufgebrauchten Hauptbudget
  // scheitern (Gegenbeispiel 8). Die 30 Schritte, der harte Schluss um
  // 23:30 und das Finanzbudget gelten unveraendert weiter.
  let grantExtraMs = 0;
  if (kind === "late") {
    if (!isLateSlot) return reject(data, "late_section_wrong_slot", { slot: parsed.slot });
    if ((run.lateSections || 0) >= late.maxExtraSections) {
      return reject(data, "late_sections_exhausted", { lateSections: run.lateSections, max: late.maxExtraSections });
    }
    if (input.budgetAvailable !== true) return reject(data, "late_section_without_budget", { runKey: parsed.runKey });
    grantExtraMs = late.sectionMs;
  }

  const prospectiveExtraMs = safeAdd(run.grantedExtraMs || 0, grantExtraMs, "grantedExtraMs");
  const budget = evaluateRuntimeBudget(run, { now, extraAllowanceMs: prospectiveExtraMs });
  if (budget.mustStop) {
    return reject(data, "budget_exhausted", {
      reasons: [...budget.reasons], runKey: parsed.runKey,
      allowedActiveMs: budget.allowedActiveMs, activeMs: budget.activeMs,
      maxActiveMs: budget.maxActiveMs, extraAllowanceMs: budget.extraAllowanceMs,
      maxExtraSections: budget.maxExtraSections, extraSectionMs: budget.extraSectionMs,
    });
  }

  let budgetMs = input.budgetMs === undefined ? defaultSectionBudget(kind, run, parsed.localDate, now) : requireInt(input.budgetMs, "budgetMs", { min: 1, max: RUN_MAX_ACTIVE_MS });
  if (kind === "http" && budgetMs > HTTP_SECTION_MAX_MS) return reject(data, "http_budget_too_large", { budgetMs, max: HTTP_SECTION_MAX_MS });
  if (kind === "late" && budgetMs > late.sectionMs) return reject(data, "late_budget_too_large", { budgetMs, max: late.sectionMs });
  if (budgetMs <= 0) return reject(data, "budget_exhausted", { reasons: ["no_section_budget"] });

  if (resumeFrom !== null) {
    const intent = runtime.continuationsById[resumeFrom];
    intent.state = "consumed";
    intent.consumedAtMs = now;
    intent.consumedBySectionId = sectionId;
    run.pendingContinuationId = null;
    if (!Array.isArray(run.consumedContinuationIds)) run.consumedContinuationIds = [];
    run.consumedContinuationIds.push(resumeFrom);
  }

  // Eine protokollierte Wiederaufnahme schliesst den haengengebliebenen
  // Abschnitt — sichtbar, mit seiner tatsaechlich verbrauchten Wandzeit.
  let recovered = null;
  if (isRecord(crashRecovery) && run.currentSectionId && isRecord(run.sections[run.currentSectionId])) {
    const offen = run.sections[run.currentSectionId];
    if (offen.closed !== true) {
      recovered = closeSection(run, offen, now, `crash_recovery:${crashRecovery.reason}`);
      run.recoveries = [...(Array.isArray(run.recoveries) ? run.recoveries : []),
        { sectionId: offen.id, reason: crashRecovery.reason, atMs: now, byFence: verified.fence }];
    }
  }

  run.sections[sectionId] = {
    id: sectionId, kind, startedAtMs: now, endedAtMs: null, budgetMs,
    toolSteps: 0, toolMs: 0, closed: false, closeReason: null,
    fence: verified.fence, holder: verified.holder,
    resumedFrom: resumeFrom,
  };
  run.currentSectionId = sectionId;
  run.phase = "active";
  run.updatedAtMs = now;
  if (kind === "late") {
    run.lateSections = (run.lateSections || 0) + 1;
    run.grantedExtraMs = prospectiveExtraMs;
  }

  return commit(next, {
    started: true, runKey: parsed.runKey, sectionId, kind, budgetMs,
    lateSections: run.lateSections, grantedExtraMs: run.grantedExtraMs || 0,
    recoveredSectionId: recovered ? recovered.id : null,
    budget: evaluateRuntimeBudget(run, { now, sectionId }),
  });
}

/* Ein Werkzeugschritt wird als TATSACHE verbucht — auch wenn er eine Grenze
 * reisst. Die Verletzung wird sichtbar gemacht, nicht weggeraeumt. */
export function recordToolStep(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const parsed = parseSlotRunKey(input.runKey);
  const sectionId = requireId(input.sectionId, "sectionId");
  const stepId = requireId(input.stepId, "stepId");
  const durationMs = requireInt(input.durationMs === undefined ? 0 : input.durationMs, "durationMs", { min: 0, max: MAX_STEP_DURATION_MS });
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const runBefore = runtimeBefore.runsByKey[parsed.runKey];
  if (!isRecord(runBefore)) return reject(data, "run_unknown", { runKey: parsed.runKey });
  const sectionBefore = isRecord(runBefore.sections) ? runBefore.sections[sectionId] : undefined;
  if (!isRecord(sectionBefore)) return reject(data, "section_unknown", { sectionId });
  if (sectionBefore.closed) return reject(data, "section_closed", { sectionId, closeReason: sectionBefore.closeReason });
  if (isRecord(sectionBefore.steps) && Object.hasOwn(sectionBefore.steps, stepId)) {
    return noop(data, { duplicate: true, stepId, budget: evaluateRuntimeBudget(runBefore, { now, sectionId }) });
  }

  const { next, runtime } = begin(data, now);
  const run = requireRun(runtime, parsed.runKey);
  const section = run.sections[sectionId];
  if (!isRecord(section.steps)) section.steps = {};
  section.steps[stepId] = { id: stepId, atMs: now, durationMs, kind: section.kind };
  section.toolSteps = (section.toolSteps || 0) + 1;
  section.toolMs = safeAdd(section.toolMs || 0, durationMs, "section.toolMs");
  run.toolSteps = (run.toolSteps || 0) + 1;
  run.toolMs = safeAdd(run.toolMs || 0, durationMs, "run.toolMs");
  run.updatedAtMs = now;

  const budget = evaluateRuntimeBudget(run, { now, sectionId });
  const violations = [];
  if (run.toolSteps > RUN_MAX_TOOL_STEPS) violations.push("tool_steps_exceeded");
  if (budget.activeMs > budget.allowedActiveMs) violations.push("active_ms_exceeded");
  if (section.kind === "http" && (now - section.startedAtMs) > HTTP_SECTION_MAX_MS) violations.push("http_section_exceeded");
  if (violations.length) run.violations = [...new Set([...(run.violations || []), ...violations])];

  return commit(next, {
    recorded: true, stepId, sectionId, runKey: parsed.runKey,
    toolSteps: run.toolSteps, toolMs: run.toolMs, activeMs: budget.activeMs,
    budget, violations,
    mustCheckpoint: budget.mustStop || violations.length > 0,
  });
}

/* Dauerhafter Checkpoint + GENAU EINE Fortsetzungsabsicht je Lauf. */
export function checkpointRunSection(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const parsed = parseSlotRunKey(input.runKey);
  const sectionId = requireId(input.sectionId, "sectionId");
  const checkpointId = requireId(input.checkpointId, "checkpointId");
  const continuationId = requireId(input.continuationId, "continuationId");
  const reason = requireId(input.reason, "reason");
  const cursor = requireJsonRecord(input.cursor === undefined ? {} : input.cursor, "cursor");
  const notBeforeMs = input.notBeforeMs === undefined || input.notBeforeMs === null ? now : requireMs(input.notBeforeMs, "notBeforeMs");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const runBefore = runtimeBefore.runsByKey[parsed.runKey];
  if (!isRecord(runBefore)) return reject(data, "run_unknown", { runKey: parsed.runKey });
  if (isRecord(runBefore.checkpoint) && runBefore.checkpoint.id === checkpointId) {
    return noop(data, {
      duplicate: true, checkpointId,
      continuationId: runBefore.pendingContinuationId || runBefore.checkpoint.continuationId,
      runKey: parsed.runKey,
    });
  }
  const existingIntent = runtimeBefore.continuationsById[continuationId];
  if (isRecord(existingIntent) && existingIntent.runKey !== parsed.runKey) {
    return reject(data, "continuation_id_reused", { continuationId, runKey: existingIntent.runKey });
  }
  if (runBefore.pendingContinuationId && runBefore.pendingContinuationId !== continuationId) {
    return reject(data, "continuation_conflict", { pending: runBefore.pendingContinuationId, requested: continuationId });
  }
  if (!isRecord(runBefore.sections) || !isRecord(runBefore.sections[sectionId])) return reject(data, "section_unknown", { sectionId });

  const { next, runtime } = begin(data, now);
  const run = requireRun(runtime, parsed.runKey);
  closeSection(run, run.sections[sectionId], now, reason);
  run.currentSectionId = null;
  run.phase = "checkpointed";
  run.updatedAtMs = now;
  run.checkpoint = { id: checkpointId, atMs: now, reason, cursor, sectionId, continuationId, fence: verified.fence };
  run.pendingContinuationId = continuationId;
  run.green = false;
  if (!isRecord(runtime.continuationsById[continuationId])) {
    runtime.continuationsById[continuationId] = {
      id: continuationId, runKey: parsed.runKey, slot: parsed.slot, localDate: parsed.localDate,
      kind: "run_continuation", state: "pending", createdAtMs: now, notBeforeMs,
      fromCheckpointId: checkpointId, reason,
      deliveries: 0, deliveryIds: [], lastDeliveryAtMs: null, consumedAtMs: null,
    };
  }
  return commit(next, {
    checkpointed: true, checkpointId, continuationId, runKey: parsed.runKey, sectionId,
    notBeforeMs, phase: run.phase,
  });
}

/* Doppelte Zustellung derselben Fortsetzung: gezaehlt, aber nie zweite Arbeit. */
export function recordContinuationDelivery(data, input = {}) {
  const now = requireMs(input.now, "now");
  const continuationId = requireId(input.continuationId, "continuationId");
  const deliveryId = requireId(input.deliveryId, "deliveryId");
  assertCore(data);
  const runtimeBefore = readRuntime(data);
  const intentBefore = runtimeBefore.continuationsById[continuationId];
  if (!isRecord(intentBefore)) return reject(data, "continuation_unknown", { continuationId });
  if (Array.isArray(intentBefore.deliveryIds) && intentBefore.deliveryIds.includes(deliveryId)) {
    return noop(data, {
      duplicate: true, work: false, continuationId, deliveryId,
      deliveries: intentBefore.deliveries, state: intentBefore.state,
    });
  }
  if (intentBefore.state === "consumed") {
    // Sie ist schon abgearbeitet. Die Zustellung wird verbucht, die Arbeit nicht.
    const { next, runtime } = begin(data, now);
    const intent = runtime.continuationsById[continuationId];
    intent.deliveries = (intent.deliveries || 0) + 1;
    intent.deliveryIds = [...(intent.deliveryIds || []), deliveryId];
    intent.lastDeliveryAtMs = now;
    return commit(next, { duplicate: true, work: false, alreadyConsumed: true, continuationId, deliveryId, deliveries: intent.deliveries });
  }
  const { next, runtime } = begin(data, now);
  const intent = runtime.continuationsById[continuationId];
  intent.deliveries = (intent.deliveries || 0) + 1;
  intent.deliveryIds = [...(intent.deliveryIds || []), deliveryId];
  intent.lastDeliveryAtMs = now;
  return commit(next, {
    duplicate: intent.deliveries > 1, work: true, continuationId, deliveryId,
    deliveries: intent.deliveries, state: intent.state,
  });
}

/* Zeit oder Budget aus, 23:30 erreicht, Fehler nicht behebbar: exception_open
 * plus SICHERE naechste Fortsetzung. Niemals ein Erfolg. */
export function openException(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const parsed = parseSlotRunKey(input.runKey);
  const exceptionId = requireId(input.exceptionId, "exceptionId");
  const reason = requireId(input.reason, "reason");
  const continuationId = input.continuationId === undefined || input.continuationId === null ? null : requireId(input.continuationId, "continuationId");
  const notBeforeMs = input.notBeforeMs === undefined || input.notBeforeMs === null ? null : requireMs(input.notBeforeMs, "notBeforeMs");
  const cursor = requireJsonRecord(input.cursor === undefined ? {} : input.cursor, "cursor");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const incidentId = `inc:run_exception:${parsed.runKey}:${exceptionId}`;
  if (isRecord(runtimeBefore.incidentsById[incidentId])) {
    return noop(data, { duplicate: true, incidentId, runKey: parsed.runKey, continuationId });
  }
  const runBefore = runtimeBefore.runsByKey[parsed.runKey];
  if (!isRecord(runBefore)) return reject(data, "run_unknown", { runKey: parsed.runKey });
  if (runBefore.pendingContinuationId && continuationId && runBefore.pendingContinuationId !== continuationId) {
    return reject(data, "continuation_conflict", { pending: runBefore.pendingContinuationId, requested: continuationId });
  }

  const { next, runtime } = begin(data, now);
  const run = requireRun(runtime, parsed.runKey);
  if (run.currentSectionId && isRecord(run.sections) && isRecord(run.sections[run.currentSectionId])) {
    closeSection(run, run.sections[run.currentSectionId], now, reason);
  }
  run.currentSectionId = null;
  run.phase = "exception_open";
  run.green = false;
  run.updatedAtMs = now;
  run.exception = { id: exceptionId, atMs: now, reason, cursor, fence: verified.fence };
  runtime.incidentsById[incidentId] = {
    id: incidentId, kind: "run_exception", severity: "high", runKey: parsed.runKey,
    slot: parsed.slot, localDate: parsed.localDate, reason, detectedAtMs: now,
    resolvedAtMs: null, resolvedBy: null, source: "runner",
  };
  if (continuationId) {
    run.pendingContinuationId = continuationId;
    if (!isRecord(runtime.continuationsById[continuationId])) {
      runtime.continuationsById[continuationId] = {
        id: continuationId, runKey: parsed.runKey, slot: parsed.slot, localDate: parsed.localDate,
        kind: "exception_continuation", state: "pending", createdAtMs: now,
        notBeforeMs: notBeforeMs === null ? now : notBeforeMs,
        fromCheckpointId: run.checkpoint ? run.checkpoint.id : null, reason,
        deliveries: 0, deliveryIds: [], lastDeliveryAtMs: null, consumedAtMs: null,
      };
    }
  }
  return commit(next, { exceptionOpen: true, incidentId, runKey: parsed.runKey, continuationId, green: false, phase: run.phase });
}

/* Abschluss eines Laufs. `completed` ist NUR im Live-Modus mit Beleg, ohne
 * offene Fortsetzung und ohne ungeklaerte Kosten moeglich. Ein nicht
 * angebundener Laeufer kann hier kein Gruen erzeugen. */
export function finishRun(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const parsed = parseSlotRunKey(input.runKey);
  const outcome = input.outcome;
  if (!RUN_OUTCOMES.includes(outcome)) fail("unknown_outcome", 400, { outcome: String(outcome) });
  const runnerMode = input.runnerMode === undefined ? "dry_run" : input.runnerMode;
  if (!FEATURE_MODES.includes(runnerMode)) fail("invalid_feature_mode", 400, { runnerMode: String(runnerMode) });
  const evidenceRef = input.evidenceRef === undefined || input.evidenceRef === null ? null : requireId(input.evidenceRef, "evidenceRef");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const runBefore = runtimeBefore.runsByKey[parsed.runKey];
  if (!isRecord(runBefore)) return reject(data, "run_unknown", { runKey: parsed.runKey });
  if (runBefore.phase === "finished") {
    return noop(data, { duplicate: true, runKey: parsed.runKey, outcome: runBefore.outcome, green: runBefore.green === true });
  }
  if (outcome === "completed") {
    const blockers = [];
    if (runnerMode !== "live") blockers.push("runner_dry_run");
    if (!evidenceRef) blockers.push("missing_evidence");
    if (runBefore.pendingContinuationId) blockers.push("pending_continuation");
    const openCost = openCostCallsForRun(runtimeBefore, parsed.runKey);
    if (openCost.length) blockers.push("open_cost_calls");
    if (blockers.length) return reject(data, "false_green_blocked", { blockers, runKey: parsed.runKey });
  }

  const { next, runtime } = begin(data, now);
  const run = requireRun(runtime, parsed.runKey);
  if (run.currentSectionId && isRecord(run.sections) && isRecord(run.sections[run.currentSectionId])) {
    closeSection(run, run.sections[run.currentSectionId], now, outcome);
  }
  run.currentSectionId = null;
  run.phase = "finished";
  run.updatedAtMs = now;
  run.outcome = { kind: outcome, atMs: now, evidenceRef, runnerMode, fence: verified.fence };
  run.green = outcome === "completed";
  return commit(next, { finished: true, runKey: parsed.runKey, outcome, green: run.green, runnerMode });
}

/* ═══ E1-B · Kostenbelege ════════════════════════════════════════════════
 *
 * Nach der unabhaengigen Pruefung neu gefasst. Die vier Befunde, die hier
 * haengen, standen alle im selben Muster: der Ledger hat seinen eigenen
 * Summen geglaubt.
 *
 *  1/2  Ein geloeschter oder negativer Tagesbeleg wurde als 0 gelesen —
 *       frueherer Verbrauch war damit vergessen. Die Summen werden jetzt
 *       IMMER aus den Belegen abgeleitet und beim Lesen gegen die
 *       gespeicherten Aggregate geprueft. Weicht etwas ab, ist der Ledger
 *       kaputt (503), nicht leer.
 *  5    Eine wiederholte Reservierung gab erneut `dispatchAllowed: true`.
 *       Ein Absturz nach dem Provideraufruf haette damit ein zweites Mal
 *       gesendet. Die Sendefreigabe ist jetzt ein EIGENER, genau einmal
 *       moeglicher Anspruch (`claimCostDispatch`).
 *  6    Dieselbe callId mit anderem Modell oder anderem Lauf galt als
 *       Wiederholung. Gebunden wird jetzt der vollstaendige, unveraender-
 *       liche Aufrufvertrag; jede Abweichung ist ein Konflikt.
 *  9    Ein Nachholauf vom Vortag belastete den Vortag und umging damit
 *       das heutige Tageslimit. Der Abrechnungstag kommt jetzt aus der
 *       vertrauenswuerdigen Serverzeit in Europe/Zurich; das Datum im
 *       Laufschluessel ist nur noch Laufidentitaet.
 * ═════════════════════════════════════════════════════════════════════════ */

function costArea(runtime) {
  const cost = runtime.cost;
  if (!isRecord(cost)) fail("cost_area_invalid", 503, { reason: "shape" });
  return cost;
}

function openCostCallsForRun(runtime, runKey) {
  const cost = isRecord(runtime.cost) ? runtime.cost : { callsById: {} };
  const calls = isRecord(cost.callsById) ? cost.callsById : {};
  return Object.values(calls).filter((c) => isRecord(c) && c.runKey === runKey && (c.state === "reserved" || c.state === "unknown"));
}

const EMPTY_DAY = Object.freeze({ openMicros: 0, settledMicros: 0, releasedMicros: 0, unknownMicros: 0, calls: 0 });
const EMPTY_RUN = Object.freeze({ openMicros: 0, settledMicros: 0, releasedMicros: 0, calls: 0 });

/* Die WAHRHEIT ueber den Stand: immer aus den Belegen gerechnet, nie aus
 * einem gespeicherten Zaehler geglaubt. */
export function deriveCostTotals(cost) {
  const byDay = new Map();
  const byRun = new Map();
  const unresolvedCallIds = [];
  let unresolvedMicros = 0;
  let overrunMicros = 0;

  const day = (k) => { if (!byDay.has(k)) byDay.set(k, { ...EMPTY_DAY, localDate: k }); return byDay.get(k); };
  const run = (k) => { if (!byRun.has(k)) byRun.set(k, { ...EMPTY_RUN, runKey: k }); return byRun.get(k); };

  for (const call of Object.values(cost.callsById || {})) {
    if (!isRecord(call)) continue;
    const d = day(call.billingLocalDate);
    const r = run(call.runKey);
    d.calls += 1; r.calls += 1;
    overrunMicros = safeAdd(overrunMicros, call.overrunMicros || 0, "overrunMicros");
    if (call.state === "reserved" || call.state === "unknown") {
      d.openMicros = safeAdd(d.openMicros, call.maxMicros, "day.openMicros");
      r.openMicros = safeAdd(r.openMicros, call.maxMicros, "run.openMicros");
    }
    if (call.state === "unknown") {
      d.unknownMicros = safeAdd(d.unknownMicros, call.maxMicros, "day.unknownMicros");
      unresolvedMicros = safeAdd(unresolvedMicros, call.maxMicros, "unresolved.micros");
      unresolvedCallIds.push(call.callId);
    }
    if (call.state === "settled") {
      d.settledMicros = safeAdd(d.settledMicros, call.settledMicros, "day.settledMicros");
      r.settledMicros = safeAdd(r.settledMicros, call.settledMicros, "run.settledMicros");
    }
    if (call.state === "settled" || call.state === "released") {
      d.releasedMicros = safeAdd(d.releasedMicros, call.releasedMicros, "day.releasedMicros");
      r.releasedMicros = safeAdd(r.releasedMicros, call.releasedMicros, "run.releasedMicros");
    }
  }
  unresolvedCallIds.sort();
  return { byDay, byRun, unresolved: { count: unresolvedCallIds.length, micros: unresolvedMicros, callIds: unresolvedCallIds }, overrunMicros };
}

const CALL_CONTRACT_FIELDS = Object.freeze([
  "contentHash", "provider", "model", "runKey", "runLocalDate", "billingLocalDate",
  "inputTokens", "outputTokens", "policyVersion", "mode", "maxMicros", "callLimitMicros",
]);

function contractOf(values) {
  const out = {};
  for (const field of CALL_CONTRACT_FIELDS) out[field] = values[field] ?? null;
  return out;
}
function contractEquals(a, b) {
  if (!isRecord(a) || !isRecord(b)) return false;
  return CALL_CONTRACT_FIELDS.every((field) => a[field] === b[field]);
}
function contractDifferences(a, b) {
  if (!isRecord(a)) return ["<kein gespeicherter Vertrag>"];
  return CALL_CONTRACT_FIELDS.filter((field) => a[field] !== b[field]);
}

function requireMicros(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MICROS) {
    fail("cost_ledger_inconsistent", 503, { reason: name });
  }
  return value;
}

/* Vollstaendige Pruefung eines VORHANDENEN Kostenbereichs. */
export function validateCostArea(cost) {
  if (!isRecord(cost)) fail("cost_area_invalid", 503, { reason: "shape" });
  if (cost.schemaVersion !== RUNTIME_SCHEMA_VERSION) fail("cost_area_invalid", 503, { reason: "schema_version" });
  for (const field of ["callsById", "receiptIndex", "providerRequestIndex", "contentHashIndex", "byDay", "byRun", "unresolved"]) {
    if (!isRecord(cost[field])) fail("cost_area_invalid", 503, { reason: "missing_field", field });
  }
  requireMicros(cost.overrunMicros, "overrunMicros");
  if (!Number.isSafeInteger(cost.dryRunChargeCount) || cost.dryRunChargeCount < 0) fail("cost_area_invalid", 503, { reason: "dryRunChargeCount" });

  for (const [key, call] of Object.entries(cost.callsById)) {
    if (!isRecord(call)) fail("cost_ledger_inconsistent", 503, { reason: "call_shape", callId: key });
    if (call.callId !== key) fail("cost_ledger_inconsistent", 503, { reason: "call_key_mismatch", callId: key });
    if (!COST_CALL_STATES.includes(call.state)) fail("cost_ledger_inconsistent", 503, { reason: "call_state", callId: key });
    for (const field of ["maxMicros", "settledMicros", "releasedMicros", "overrunMicros"]) requireMicros(call[field], `call.${field}`);
    if (!isLocalDate(call.billingLocalDate)) fail("cost_ledger_inconsistent", 503, { reason: "billing_date", callId: key });
    if (typeof call.runKey !== "string" || !call.runKey) fail("cost_ledger_inconsistent", 503, { reason: "run_key", callId: key });
    if (!isRecord(call.contract) || !contractEquals(call.contract, contractOf(call.contract))) {
      fail("cost_ledger_inconsistent", 503, { reason: "call_contract", callId: key });
    }
    if (!isRecord(call.dispatch) || typeof call.dispatch.claimed !== "boolean") {
      fail("cost_ledger_inconsistent", 503, { reason: "dispatch_record", callId: key });
    }
    const hashList = cost.contentHashIndex[call.contentHash];
    if (!Array.isArray(hashList) || !hashList.includes(call.callId)) {
      fail("cost_ledger_inconsistent", 503, { reason: "content_hash_index", callId: key });
    }
    for (const [field, index] of [["usageReceiptId", "receiptIndex"], ["providerRequestId", "providerRequestIndex"]]) {
      if (typeof call[field] === "string" && call[field] && cost[index][call[field]] !== call.callId) {
        fail("cost_ledger_inconsistent", 503, { reason: index, callId: key });
      }
    }
  }
  for (const [hash, list] of Object.entries(cost.contentHashIndex)) {
    if (!Array.isArray(list)) fail("cost_ledger_inconsistent", 503, { reason: "content_hash_index_shape", hash });
    for (const id of list) {
      if (!isRecord(cost.callsById[id]) || cost.callsById[id].contentHash !== hash) {
        fail("cost_ledger_inconsistent", 503, { reason: "content_hash_index_dangling", hash });
      }
    }
  }
  for (const [index, field] of [["receiptIndex", "usageReceiptId"], ["providerRequestIndex", "providerRequestId"]]) {
    for (const [value, callId] of Object.entries(cost[index])) {
      if (!isRecord(cost.callsById[callId]) || cost.callsById[callId][field] !== value) {
        fail("cost_ledger_inconsistent", 503, { reason: `${index}_dangling`, value });
      }
    }
  }

  // Die gespeicherten Aggregate muessen den Belegen ENTSPRECHEN. Ein
  // geloeschter Tagesbeleg oder eine negative Summe faellt genau hier auf,
  // statt als 0 durchzugehen.
  const derived = deriveCostTotals(cost);
  const vergleiche = (gespeichert, erwartet, felder, kennung) => {
    for (const field of felder) {
      requireMicros(gespeichert[field] ?? -1, `${kennung}.${field}`);
      if (gespeichert[field] !== erwartet[field]) {
        fail("cost_ledger_inconsistent", 503, { reason: "aggregate_mismatch", bucket: kennung, field, stored: gespeichert[field], derived: erwartet[field] });
      }
    }
  };
  for (const [key, erwartet] of derived.byDay) {
    const gespeichert = cost.byDay[key];
    if (!isRecord(gespeichert)) fail("cost_ledger_inconsistent", 503, { reason: "day_bucket_missing", localDate: key });
    vergleiche(gespeichert, erwartet, ["openMicros", "settledMicros", "releasedMicros", "unknownMicros"], `byDay.${key}`);
    if (gespeichert.calls !== erwartet.calls) fail("cost_ledger_inconsistent", 503, { reason: "day_call_count", localDate: key });
  }
  for (const key of Object.keys(cost.byDay)) {
    if (!derived.byDay.has(key)) fail("cost_ledger_inconsistent", 503, { reason: "day_bucket_orphan", localDate: key });
  }
  for (const [key, erwartet] of derived.byRun) {
    const gespeichert = cost.byRun[key];
    if (!isRecord(gespeichert)) fail("cost_ledger_inconsistent", 503, { reason: "run_bucket_missing", runKey: key });
    vergleiche(gespeichert, erwartet, ["openMicros", "settledMicros", "releasedMicros"], `byRun.${key}`);
  }
  for (const key of Object.keys(cost.byRun)) {
    if (!derived.byRun.has(key)) fail("cost_ledger_inconsistent", 503, { reason: "run_bucket_orphan", runKey: key });
  }
  const u = cost.unresolved;
  requireMicros(u.micros ?? -1, "unresolved.micros");
  if (u.count !== derived.unresolved.count || u.micros !== derived.unresolved.micros
    || !Array.isArray(u.callIds) || JSON.stringify([...u.callIds].sort()) !== JSON.stringify(derived.unresolved.callIds)) {
    fail("cost_ledger_inconsistent", 503, { reason: "unresolved_mismatch" });
  }
  if (cost.overrunMicros !== derived.overrunMicros) {
    fail("cost_ledger_inconsistent", 503, { reason: "overrun_mismatch", stored: cost.overrunMicros, derived: derived.overrunMicros });
  }
  return cost;
}

/* Nach JEDER Kostenaenderung werden die Aggregate neu aus den Belegen
 * geschrieben. Es gibt keine inkrementelle Buchhaltung mehr, die
 * auseinanderlaufen koennte. */
function rebuildCostAggregates(cost) {
  const derived = deriveCostTotals(cost);
  cost.byDay = {};
  for (const [key, value] of derived.byDay) cost.byDay[key] = value;
  cost.byRun = {};
  for (const [key, value] of derived.byRun) cost.byRun[key] = value;
  cost.unresolved = { count: derived.unresolved.count, micros: derived.unresolved.micros, callIds: derived.unresolved.callIds };
  cost.overrunMicros = derived.overrunMicros;
  return cost;
}

/* Die Preis- und Budgetliste kommt AUSSCHLIESSLICH vom Backend. Diese Datei
 * enthaelt keinen einzigen Modellnamen und keinen einzigen Preis. Eine
 * Testvorlage muss sich mit `fixture: true` ausweisen und wird ausserhalb
 * der Tests abgelehnt. */
export function validateCostPolicy(policy, options = {}) {
  const now = options.now === undefined ? null : requireMs(options.now, "now");
  const allowFixture = options.allowFixture === true;
  const errors = [];
  if (!isRecord(policy)) return { ok: false, errors: ["cost_policy_missing"], policy: null };
  if (policy.schema !== COST_POLICY_SCHEMA) errors.push("cost_policy_schema");
  if (typeof policy.version !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(policy.version)) errors.push("cost_policy_version");
  if (typeof policy.currency !== "string" || !/^[A-Z]{3}$/.test(policy.currency)) errors.push("cost_policy_currency");
  if (policy.fixture === true && !allowFixture) errors.push("cost_policy_fixture_rejected");

  const approval = policy.approval;
  if (!isRecord(approval)
    || typeof approval.approvedBy !== "string" || !approval.approvedBy
    || typeof approval.approvalRef !== "string" || !approval.approvalRef
    || !Number.isSafeInteger(approval.approvedAtMs) || approval.approvedAtMs <= 0) {
    errors.push("cost_policy_not_approved");
  }
  const from = policy.effectiveFromMs;
  const until = policy.effectiveUntilMs;
  if (!Number.isSafeInteger(from) || from <= 0) errors.push("cost_policy_effective_from");
  if (!Number.isSafeInteger(until) || until <= 0 || (Number.isSafeInteger(from) && until <= from)) errors.push("cost_policy_effective_until");
  if (now !== null && Number.isSafeInteger(from) && Number.isSafeInteger(until)) {
    if (now < from) errors.push("cost_policy_not_yet_effective");
    if (now >= until) errors.push("cost_policy_expired");
  }
  for (const key of ["dayLimitMicros", "runLimitMicros", "callLimitMicros"]) {
    const v = policy[key];
    if (!Number.isSafeInteger(v) || v < 0 || v > MAX_MICROS) errors.push(`cost_policy_${key}`);
  }
  if (Number.isSafeInteger(policy.dayLimitMicros) && Number.isSafeInteger(policy.runLimitMicros)
    && policy.runLimitMicros > policy.dayLimitMicros) errors.push("cost_policy_run_above_day");
  if (Number.isSafeInteger(policy.runLimitMicros) && Number.isSafeInteger(policy.callLimitMicros)
    && policy.callLimitMicros > policy.runLimitMicros) errors.push("cost_policy_call_above_run");
  const unresolvedBlock = policy.unresolvedBlockMicros;
  if (!Number.isSafeInteger(unresolvedBlock) || unresolvedBlock < 0 || unresolvedBlock > MAX_MICROS) errors.push("cost_policy_unresolved_block");

  let providers = "dry_run";
  const flags = policy.featureFlags;
  let flagsDefaulted = false;
  if (flags === undefined || flags === null) flagsDefaulted = true;        // Default ist dry_run
  else if (!isRecord(flags)) errors.push("cost_policy_feature_flags");
  else if (flags.providers === undefined) flagsDefaulted = true;
  else if (!FEATURE_MODES.includes(flags.providers)) errors.push("cost_policy_feature_flags");
  else providers = flags.providers;

  const models = policy.models;
  if (!isRecord(models) || Object.keys(models).length === 0) errors.push("cost_policy_models");
  else {
    for (const [key, entry] of Object.entries(models)) {
      if (!/^[A-Za-z0-9_.:-]{3,120}$/.test(key)) { errors.push("cost_policy_model_key"); break; }
      if (!isRecord(entry)) { errors.push("cost_policy_model_entry"); break; }
      const ok = ["inputMicrosPerMillionTokens", "outputMicrosPerMillionTokens"].every((f) =>
        Number.isSafeInteger(entry[f]) && entry[f] >= 0 && entry[f] <= MAX_MICROS_PER_MILLION_TOKENS);
      const capOk = Number.isSafeInteger(entry.maxCallMicros) && entry.maxCallMicros > 0 && entry.maxCallMicros <= MAX_MICROS;
      if (!ok || !capOk) { errors.push("cost_policy_model_entry"); break; }
    }
  }
  return { ok: errors.length === 0, errors, providers, flagsDefaulted };
}

/* Wirft, solange bezahlte Aufrufe nicht ausdruecklich freigegeben sind. */
export function assertPaidCallAllowed(policy, options = {}) {
  const verdict = validateCostPolicy(policy, options);
  if (!verdict.ok) fail("cost_policy_invalid", 503, { errors: verdict.errors });
  if (verdict.providers !== "live") fail("providers_not_live", 409, { providers: verdict.providers, defaulted: verdict.flagsDefaulted });
  return verdict;
}

export function priceKey(provider, model) {
  return `${requireId(provider, "provider")}:${requireId(model, "model")}`;
}

/* Ganzzahlig, aufgerundet, mit Ueberlaufpruefung. */
export function estimateCostMicros(policy, input = {}) {
  const verdict = validateCostPolicy(policy, { allowFixture: input.__allowFixturePolicy === true });
  if (!verdict.ok) fail("cost_policy_invalid", 503, { errors: verdict.errors });
  const key = priceKey(input.provider, input.model);
  const entry = policy.models[key];
  if (!isRecord(entry)) fail("model_not_priced", 409, { key });
  const inputTokens = requireInt(input.inputTokens === undefined ? 0 : input.inputTokens, "inputTokens", { min: 0, max: MAX_TOKENS_PER_CALL });
  const outputTokens = requireInt(input.outputTokens === undefined ? 0 : input.outputTokens, "outputTokens", { min: 0, max: MAX_TOKENS_PER_CALL });
  const inProduct = inputTokens * entry.inputMicrosPerMillionTokens;
  const outProduct = outputTokens * entry.outputMicrosPerMillionTokens;
  if (!Number.isSafeInteger(inProduct) || !Number.isSafeInteger(outProduct)) fail("micro_overflow", 500, { key });
  const micros = safeAdd(Math.ceil(inProduct / 1_000_000), Math.ceil(outProduct / 1_000_000), "estimate");
  if (micros > entry.maxCallMicros) fail("call_price_above_model_cap", 409, { micros, cap: entry.maxCallMicros });
  if (micros > policy.callLimitMicros) fail("call_price_above_policy_cap", 409, { micros, cap: policy.callLimitMicros });
  return micros;
}

function readDerivedBucket(map, key, leer) {
  const bucket = map.get(key);
  return bucket || { ...leer };
}

/* Ein Aufruf, dessen Ausgang offen ist, sperrt jede Wiederholung desselben
 * Inhalts — auch wenn er noch als `reserved` gefuehrt wird, die Sendung
 * aber schon beansprucht war. */
function blockingCallForHash(cost, contentHash, exceptCallId = null) {
  const ids = Array.isArray(cost.contentHashIndex?.[contentHash]) ? cost.contentHashIndex[contentHash] : [];
  for (const id of ids) {
    if (id === exceptCallId) continue;
    const call = cost.callsById[id];
    if (!isRecord(call)) continue;
    if (call.state === "unknown") return { callId: id, reason: "unknown_outcome" };
    if (call.state === "reserved" && isRecord(call.dispatch) && call.dispatch.claimed === true) {
      return { callId: id, reason: "dispatch_claimed_unresolved" };
    }
  }
  return null;
}

/* VERBINDLICHE Reservierung vor jedem bezahlten Modellaufruf. Sie allein
 * erlaubt noch KEINE Sendung — dafuer gibt es claimCostDispatch. */
export function reserveCost(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const callId = requireId(input.callId, "callId");
  const parsed = parseSlotRunKey(input.runKey);
  const contentHash = requireId(input.contentHash, "contentHash", HASH_RE);
  const provider = requireId(input.provider, "provider");
  const model = requireId(input.model, "model");
  // Gegenbeispiel 9: der Abrechnungstag kommt aus der vertrauenswuerdigen
  // Serverzeit, NICHT aus dem Datum im Laufschluessel. Ein Nachholauf vom
  // Vortag belastet damit das heutige Tagesbudget.
  const billingLocalDate = zurichLocalDate(now);
  if (input.localDate !== undefined && input.localDate !== billingLocalDate) {
    fail("billing_date_mismatch", 400, { given: String(input.localDate), billingLocalDate });
  }
  const allowFixture = input.__allowFixturePolicy === true;
  const policy = input.policy;
  const verdict = validateCostPolicy(policy, { now, allowFixture });
  if (!verdict.ok) fail("cost_policy_invalid", 503, { errors: verdict.errors });
  assertLeadership(data, verified, now);

  const mode = verdict.providers;          // dry_run ist der Default
  const chargeable = mode === "live";
  const inputTokens = requireInt(input.inputTokens === undefined ? 0 : input.inputTokens, "inputTokens", { min: 0, max: MAX_TOKENS_PER_CALL });
  const outputTokens = requireInt(input.outputTokens === undefined ? 0 : input.outputTokens, "outputTokens", { min: 0, max: MAX_TOKENS_PER_CALL });
  // Auch im dry_run muss das Modell im freigegebenen Preisstand stehen.
  const estimated = estimateCostMicros(policy, { provider, model, inputTokens, outputTokens, __allowFixturePolicy: allowFixture });
  const estimateMicros = chargeable ? estimated : 0;

  const contract = contractOf({
    contentHash, provider, model, runKey: parsed.runKey,
    runLocalDate: parsed.localDate, billingLocalDate,
    inputTokens, outputTokens, policyVersion: policy.version, mode,
    maxMicros: estimateMicros, callLimitMicros: policy.callLimitMicros,
  });

  const runtimeBefore = readRuntime(data);
  const costBefore = isRecord(runtimeBefore.cost) ? runtimeBefore.cost : emptyRuntimeArea().cost;
  const known = isRecord(costBefore.callsById) ? costBefore.callsById[callId] : undefined;
  if (isRecord(known)) {
    // Gegenbeispiel 6: gebunden wird der GANZE Vertrag, nicht nur der Hash.
    if (!contractEquals(known.contract, contract)) {
      return reject(data, "cost_call_conflict", { callId, differs: contractDifferences(known.contract, contract) });
    }
    return noop(data, {
      duplicate: true, callId, state: known.state, maxMicros: known.maxMicros, mode: known.mode,
      // Gegenbeispiel 5: eine Wiederholung ist NIE eine neue Sendefreigabe.
      dispatchAllowed: false,
      dispatchClaimed: known.dispatch.claimed === true,
    });
  }

  const blocking = blockingCallForHash(costBefore, contentHash);
  if (blocking) {
    return reject(data, "unknown_outcome_blocks_retry", { callId, blockingCallId: blocking.callId, reason: blocking.reason, contentHash });
  }
  if (costBefore.overrunMicros > 0) {
    return reject(data, "cost_overrun_blocks_reservation", { overrunMicros: costBefore.overrunMicros });
  }
  const derivedBefore = deriveCostTotals(costBefore);
  if (derivedBefore.unresolved.micros > policy.unresolvedBlockMicros) {
    return reject(data, "unresolved_cost_blocking", { unresolvedMicros: derivedBefore.unresolved.micros, limit: policy.unresolvedBlockMicros });
  }

  if (chargeable) {
    const day = readDerivedBucket(derivedBefore.byDay, billingLocalDate, EMPTY_DAY);
    const run = readDerivedBucket(derivedBefore.byRun, parsed.runKey, EMPTY_RUN);
    const dayAfter = safeAdd(safeAdd(day.openMicros, day.settledMicros, "day"), estimateMicros, "day");
    if (dayAfter > policy.dayLimitMicros) {
      return reject(data, "day_budget_exceeded", { wouldBe: dayAfter, limit: policy.dayLimitMicros, localDate: billingLocalDate });
    }
    const runAfter = safeAdd(safeAdd(run.openMicros, run.settledMicros, "run"), estimateMicros, "run");
    if (runAfter > policy.runLimitMicros) {
      return reject(data, "run_budget_exceeded", { wouldBe: runAfter, limit: policy.runLimitMicros, runKey: parsed.runKey });
    }
  }

  const { next, runtime } = begin(data, now);
  const cost = costArea(runtime);
  cost.policyRef = { version: policy.version, approvalRef: policy.approval.approvalRef, currency: policy.currency, providers: mode };
  cost.callsById[callId] = {
    callId, runKey: parsed.runKey, runLocalDate: parsed.localDate, billingLocalDate,
    provider, model, priceKey: priceKey(provider, model),
    mode, chargeable, state: "reserved",
    contentHash, contract,
    maxMicros: estimateMicros, estimatedMicros: estimated,
    settledMicros: 0, releasedMicros: 0, overrunMicros: 0,
    reservedAtMs: now, resolvedAtMs: null, unknownSinceMs: null,
    dispatch: { claimed: false, claimId: null, claimedAtMs: null },
    providerRequestId: null, usageReceiptId: null,
    policyVersion: policy.version, fence: verified.fence, holder: verified.holder,
  };
  if (!Array.isArray(cost.contentHashIndex[contentHash])) cost.contentHashIndex[contentHash] = [];
  cost.contentHashIndex[contentHash].push(callId);
  rebuildCostAggregates(cost);

  return commit(next, {
    reserved: true, callId, runKey: parsed.runKey, mode, chargeable,
    maxMicros: estimateMicros, estimatedMicros: estimated, currency: policy.currency,
    billingLocalDate,
    // Die Reservierung allein sendet nichts. Erst claimCostDispatch.
    dispatchAllowed: false, dispatchClaimed: false,
    dayOpenMicros: cost.byDay[billingLocalDate].openMicros,
    runOpenMicros: cost.byRun[parsed.runKey].openMicros,
  });
}

/* Die EINE Sendefreigabe. Genau einmal, atomar im selben CAS.
 *
 * Die zweite Pruefungsrunde hat gezeigt, dass eine Reservierung allein
 * keine Freigabe traegt: der Claim hat die Policy gar nicht angesehen.
 * Damit war ein Dispatch moeglich, obwohl der freigegebene Preisstand
 * inzwischen abgelaufen war, auf dry_run stand oder ganz fehlte (R2-01),
 * obwohl inzwischen ein neuer Tag begonnen hatte und das Tagesbudget ein
 * anderes war (R2-02), und obwohl ein zweiter, gleich lautender Aufruf
 * schon unterwegs war (R2-03).
 *
 * Der Claim prueft deshalb im selben CAS:
 *   1. eine FRISCH vom Server geladene, freigegebene, gueltige Policy mit
 *      providers=live — nie eine Freigabe aus dem Rumpf und nie eine aus
 *      dem alten Reservierungsbeleg
 *   2. dass Modell, Preis und Tokenumfang noch genau den Vertrag der
 *      Reservierung ergeben
 *   3. dass der Abrechnungstag noch derselbe ist
 *   4. dass kein gleich lautender Aufruf mit offenem Ausgang existiert
 *   5. dass die verbleibenden Tages-, Lauf- und Aufrufgrenzen halten
 */
export function claimCostDispatch(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const callId = requireId(input.callId, "callId");
  const claimId = requireId(input.claimId, "claimId");
  const allowFixture = input.__allowFixturePolicy === true;
  // 1. Ohne frischen, freigegebenen Preisstand gibt es keine Freigabe.
  const policy = input.policy;
  const verdict = validateCostPolicy(policy, { now, allowFixture });
  if (!verdict.ok) fail("cost_policy_invalid", 503, { errors: verdict.errors, at: "claim" });
  if (verdict.providers !== "live") {
    fail("providers_not_live", 409, { providers: verdict.providers, defaulted: verdict.flagsDefaulted, at: "claim" });
  }
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const costBefore = isRecord(runtimeBefore.cost) ? runtimeBefore.cost : emptyRuntimeArea().cost;
  const call = isRecord(costBefore.callsById) ? costBefore.callsById[callId] : undefined;
  if (!isRecord(call)) return reject(data, "cost_call_unknown", { callId });
  if (call.state !== "reserved") return reject(data, "cost_state_invalid", { callId, state: call.state });
  if (call.dispatch.claimed === true) {
    return reject(data, "dispatch_already_claimed", {
      callId, claimId: call.dispatch.claimId, claimedAtMs: call.dispatch.claimedAtMs,
      dispatchAllowed: false, blocksRetry: true,
      hint: "Ausgang zuerst belegt aufloesen (settleCost / markCostOutcomeUnknown).",
    });
  }
  if (!call.chargeable) {
    return reject(data, "dispatch_not_allowed_in_dry_run", { callId, mode: call.mode });
  }

  // 3. Abrechnungstag. Ein Tageswechsel zwischen Reservierung und Sendung
  //    wuerde sonst das Budget von gestern gegen die Ausgabe von heute
  //    halten. Fail closed: die Reservierung muss belegt freigegeben und
  //    neu gestellt werden (Beleg `day_rollover`).
  const heute = zurichLocalDate(now);
  if (heute !== call.billingLocalDate) {
    return reject(data, "billing_day_rolled_over", {
      callId, reservedFor: call.billingLocalDate, today: heute,
      hint: "releaseCostReservation mit evidence.kind=day_rollover und neu reservieren.",
    });
  }

  // 2. Modell-, Preis- und Tokenbindung gegen den frischen Preisstand.
  //    Die gesenkte Aufrufgrenze zuerst, damit sie ihren eigenen Grund
  //    bekommt und nicht als "Preis nicht ermittelbar" erscheint.
  const contract = call.contract;
  if (policy.callLimitMicros < call.maxMicros) {
    return reject(data, "call_limit_lowered", { callId, maxMicros: call.maxMicros, limit: policy.callLimitMicros });
  }
  let frischerPreis;
  try {
    frischerPreis = estimateCostMicros(policy, {
      provider: call.provider, model: call.model,
      inputTokens: contract.inputTokens, outputTokens: contract.outputTokens,
      __allowFixturePolicy: allowFixture,
    });
  } catch (err) {
    return reject(data, "policy_price_unavailable", { callId, code: err.code || "unknown" });
  }
  if (frischerPreis !== call.maxMicros) {
    return reject(data, "policy_price_changed", { callId, reserved: call.maxMicros, current: frischerPreis });
  }

  // 4. Kein gleich lautender Aufruf mit offenem Ausgang — auch keiner, der
  //    erst vorbereitet und dann beansprucht wurde.
  const blocking = blockingCallForHash(costBefore, call.contentHash, callId);
  if (blocking) {
    return reject(data, "unknown_outcome_blocks_retry", {
      callId, blockingCallId: blocking.callId, reason: blocking.reason, contentHash: call.contentHash,
    });
  }

  // 5. Verbleibende Grenzen. Die Reservierung steckt bereits in den
  //    offenen Betraegen; eine inzwischen gesenkte Grenze faellt hier auf.
  const derived = deriveCostTotals(costBefore);
  if (derived.overrunMicros > 0) {
    return reject(data, "cost_overrun_blocks_dispatch", { overrunMicros: derived.overrunMicros });
  }
  const andereUngeklaerte = derived.unresolved.micros;
  if (andereUngeklaerte > policy.unresolvedBlockMicros) {
    return reject(data, "unresolved_cost_blocking", { unresolvedMicros: andereUngeklaerte, limit: policy.unresolvedBlockMicros });
  }
  const day = readDerivedBucket(derived.byDay, call.billingLocalDate, EMPTY_DAY);
  const run = readDerivedBucket(derived.byRun, call.runKey, EMPTY_RUN);
  const dayTotal = safeAdd(day.openMicros, day.settledMicros, "day");
  if (dayTotal > policy.dayLimitMicros) {
    return reject(data, "day_budget_exceeded", { wouldBe: dayTotal, limit: policy.dayLimitMicros, localDate: call.billingLocalDate, at: "claim" });
  }
  const runTotal = safeAdd(run.openMicros, run.settledMicros, "run");
  if (runTotal > policy.runLimitMicros) {
    return reject(data, "run_budget_exceeded", { wouldBe: runTotal, limit: policy.runLimitMicros, runKey: call.runKey, at: "claim" });
  }

  const { next, runtime } = begin(data, now);
  const entry = costArea(runtime).callsById[callId];
  entry.dispatch = {
    claimed: true, claimId, claimedAtMs: now, fence: verified.fence,
    policyVersion: policy.version, approvalRef: policy.approval.approvalRef,
    billingLocalDate: heute,
  };
  return commit(next, {
    callId, claimId, dispatchAllowed: true, dispatchClaimed: true,
    maxMicros: entry.maxMicros, billingLocalDate: heute, policyVersion: policy.version,
  });
}

function indexReceipt(cost, field, value, callId) {
  if (value === null) return;
  cost[field][value] = callId;
}

/* Bestaetigter Verbrauch. Der ungenutzte Rest der Reservierung wird dabei
 * freigegeben. Belegkennungen werden dedupliziert: keine doppelte Belastung
 * und keine doppelte Erstattung. */
export function settleCost(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const callId = requireId(input.callId, "callId");
  const actualMicros = requireInt(input.actualMicros, "actualMicros", { min: 0, max: MAX_MICROS });
  const usageReceiptId = input.usageReceiptId === undefined || input.usageReceiptId === null ? null : requireId(input.usageReceiptId, "usageReceiptId");
  const providerRequestId = input.providerRequestId === undefined || input.providerRequestId === null ? null : requireId(input.providerRequestId, "providerRequestId");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const costBefore = isRecord(runtimeBefore.cost) ? runtimeBefore.cost : emptyRuntimeArea().cost;
  const call = isRecord(costBefore.callsById) ? costBefore.callsById[callId] : undefined;
  if (!isRecord(call)) return reject(data, "cost_call_unknown", { callId });

  if (call.state === "settled") {
    const sameReceipt = usageReceiptId === null || call.usageReceiptId === usageReceiptId;
    const sameRequest = providerRequestId === null || call.providerRequestId === providerRequestId;
    if (sameReceipt && sameRequest && call.settledMicros === actualMicros) {
      return noop(data, { duplicate: true, callId, settledMicros: call.settledMicros });
    }
    return reject(data, "cost_already_settled", { callId, settledMicros: call.settledMicros });
  }
  if (call.state === "released") return reject(data, "cost_already_released", { callId });
  if (call.state === "unknown") return reject(data, "unknown_requires_resolution", { callId });
  if (call.state !== "reserved") return reject(data, "cost_state_invalid", { callId, state: call.state });

  for (const [field, value] of [["receiptIndex", usageReceiptId], ["providerRequestIndex", providerRequestId]]) {
    if (value === null) continue;
    const owner = costBefore[field][value];
    if (owner !== undefined && owner !== callId) {
      return reject(data, field === "receiptIndex" ? "usage_receipt_conflict" : "provider_request_conflict", { value, ownedBy: owner });
    }
  }

  const { next, runtime } = begin(data, now);
  const cost = costArea(runtime);
  const entry = cost.callsById[callId];
  const overrun = Math.max(0, actualMicros - entry.maxMicros);
  const released = Math.max(0, entry.maxMicros - actualMicros);
  entry.state = "settled";
  entry.settledMicros = actualMicros;
  entry.releasedMicros = released;
  entry.overrunMicros = overrun;
  entry.resolvedAtMs = now;
  entry.usageReceiptId = usageReceiptId;
  entry.providerRequestId = providerRequestId;
  indexReceipt(cost, "receiptIndex", usageReceiptId, callId);
  indexReceipt(cost, "providerRequestIndex", providerRequestId, callId);

  const violations = [];
  if (overrun > 0) violations.push("settled_overrun");
  if (!entry.chargeable && actualMicros > 0) {
    cost.dryRunChargeCount = (cost.dryRunChargeCount || 0) + 1;
    violations.push("charge_in_dry_run");
  }
  rebuildCostAggregates(cost);
  const day = cost.byDay[entry.billingLocalDate];
  return commit(next, {
    settled: true, callId, settledMicros: actualMicros, releasedMicros: released,
    overrunMicros: overrun, violations,
    daySettledMicros: day.settledMicros, dayOpenMicros: day.openMicros,
  });
}

/* Bestaetigte Freigabe einer NICHT verwendeten Reservierung. Nur mit Beleg
 * — und nur, wenn nie eine Sendefreigabe beansprucht wurde oder der
 * Provider die Sendung nachweislich abgelehnt hat. */
export const RELEASE_EVIDENCE_KINDS = Object.freeze(["provider_rejected", "not_dispatched", "cancelled_before_send", "day_rollover"]);

export function releaseCostReservation(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const callId = requireId(input.callId, "callId");
  const evidence = input.evidence;
  if (!isRecord(evidence) || !RELEASE_EVIDENCE_KINDS.includes(evidence.kind) || typeof evidence.ref !== "string" || !evidence.ref) {
    fail("release_evidence_required", 400, { allowed: [...RELEASE_EVIDENCE_KINDS] });
  }
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const costBefore = isRecord(runtimeBefore.cost) ? runtimeBefore.cost : emptyRuntimeArea().cost;
  const call = isRecord(costBefore.callsById) ? costBefore.callsById[callId] : undefined;
  if (!isRecord(call)) return reject(data, "cost_call_unknown", { callId });
  if (call.state === "released") {
    if (isRecord(call.releaseEvidence) && call.releaseEvidence.ref === evidence.ref) {
      return noop(data, { duplicate: true, callId, releasedMicros: call.releasedMicros });
    }
    return reject(data, "cost_already_released", { callId });
  }
  if (call.state === "unknown") return reject(data, "unknown_requires_resolution", { callId });
  if (call.state !== "reserved") return reject(data, "cost_state_invalid", { callId, state: call.state });
  if (call.dispatch.claimed === true && evidence.kind !== "provider_rejected") {
    // Die Sendung war schon freigegeben — "nie abgeschickt" ist dann keine
    // zulaessige Begruendung mehr.
    return reject(data, "dispatch_claimed_requires_provider_evidence", { callId, claimedAtMs: call.dispatch.claimedAtMs });
  }

  const { next, runtime } = begin(data, now);
  const cost = costArea(runtime);
  const entry = cost.callsById[callId];
  entry.state = "released";
  entry.releasedMicros = entry.maxMicros;
  entry.resolvedAtMs = now;
  entry.releaseEvidence = { kind: evidence.kind, ref: evidence.ref, atMs: now };
  rebuildCostAggregates(cost);
  return commit(next, { released: true, callId, releasedMicros: entry.releasedMicros });
}

/* Unklarer Provider-Ausgang: bleibt reserviert, bleibt sichtbar, sperrt die
 * blinde Wiederholung desselben Inhalts. */
export function markCostOutcomeUnknown(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const callId = requireId(input.callId, "callId");
  const reason = requireId(input.reason, "reason");
  const providerRequestId = input.providerRequestId === undefined || input.providerRequestId === null ? null : requireId(input.providerRequestId, "providerRequestId");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const costBefore = isRecord(runtimeBefore.cost) ? runtimeBefore.cost : emptyRuntimeArea().cost;
  const call = isRecord(costBefore.callsById) ? costBefore.callsById[callId] : undefined;
  if (!isRecord(call)) return reject(data, "cost_call_unknown", { callId });
  if (call.state === "unknown") {
    return noop(data, { duplicate: true, callId, state: "unknown", retryAllowed: false, blocksRetry: true });
  }
  if (call.state !== "reserved") return reject(data, "cost_state_invalid", { callId, state: call.state });
  if (providerRequestId) {
    const owner = costBefore.providerRequestIndex[providerRequestId];
    if (owner !== undefined && owner !== callId) {
      return reject(data, "provider_request_conflict", { providerRequestId, ownedBy: owner });
    }
  }

  const { next, runtime } = begin(data, now);
  const cost = costArea(runtime);
  const entry = cost.callsById[callId];
  entry.state = "unknown";
  entry.unknownSinceMs = now;
  entry.unknownReason = reason;
  if (providerRequestId) {
    entry.providerRequestId = providerRequestId;
    indexReceipt(cost, "providerRequestIndex", providerRequestId, callId);
  }
  rebuildCostAggregates(cost);
  return commit(next, {
    callId, state: "unknown", retryAllowed: false, blocksRetry: true,
    unresolvedMicros: cost.unresolved.micros, unresolvedCount: cost.unresolved.count,
  });
}

export const UNKNOWN_RESOLUTIONS = Object.freeze(["charged", "not_charged"]);

/* Nur hier kann ein ungeklaerter Aufruf aufgeloest werden — mit Beleg. */
export function resolveUnknownCost(data, input = {}) {
  const now = requireMs(input.now, "now");
  const verified = requireVerifiedScope(input.verifiedScope);
  const callId = requireId(input.callId, "callId");
  const resolution = input.resolution;
  if (!UNKNOWN_RESOLUTIONS.includes(resolution)) fail("unknown_resolution", 400, { resolution: String(resolution) });
  const evidence = input.evidence;
  if (!isRecord(evidence) || typeof evidence.kind !== "string" || !evidence.kind || typeof evidence.ref !== "string" || !evidence.ref) {
    fail("resolution_evidence_required", 400);
  }
  const providerRequestId = input.providerRequestId === undefined || input.providerRequestId === null ? null : requireId(input.providerRequestId, "providerRequestId");
  const usageReceiptId = input.usageReceiptId === undefined || input.usageReceiptId === null ? null : requireId(input.usageReceiptId, "usageReceiptId");
  assertLeadership(data, verified, now);

  const runtimeBefore = readRuntime(data);
  const costBefore = isRecord(runtimeBefore.cost) ? runtimeBefore.cost : emptyRuntimeArea().cost;
  const call = isRecord(costBefore.callsById) ? costBefore.callsById[callId] : undefined;
  if (!isRecord(call)) return reject(data, "cost_call_unknown", { callId });
  if (call.state !== "unknown") {
    if (call.state === "settled" || call.state === "released") {
      return noop(data, { duplicate: true, callId, state: call.state });
    }
    return reject(data, "cost_state_invalid", { callId, state: call.state });
  }
  if (resolution === "not_charged" && !providerRequestId) {
    return reject(data, "resolution_requires_provider_request", { callId });
  }
  const actualMicros = resolution === "charged"
    ? requireInt(input.actualMicros, "actualMicros", { min: 0, max: MAX_MICROS })
    : 0;
  for (const [field, value] of [["receiptIndex", usageReceiptId], ["providerRequestIndex", providerRequestId]]) {
    if (value === null) continue;
    const owner = costBefore[field][value];
    if (owner !== undefined && owner !== callId) {
      return reject(data, field === "receiptIndex" ? "usage_receipt_conflict" : "provider_request_conflict", { value, ownedBy: owner });
    }
  }

  const { next, runtime } = begin(data, now);
  const cost = costArea(runtime);
  const entry = cost.callsById[callId];
  entry.resolvedAtMs = now;
  entry.resolution = { kind: resolution, evidence: { kind: evidence.kind, ref: evidence.ref }, atMs: now };
  if (providerRequestId) { entry.providerRequestId = providerRequestId; indexReceipt(cost, "providerRequestIndex", providerRequestId, callId); }
  if (usageReceiptId) { entry.usageReceiptId = usageReceiptId; indexReceipt(cost, "receiptIndex", usageReceiptId, callId); }
  const violations = [];
  if (resolution === "charged") {
    const overrun = Math.max(0, actualMicros - entry.maxMicros);
    entry.state = "settled";
    entry.settledMicros = actualMicros;
    entry.releasedMicros = Math.max(0, entry.maxMicros - actualMicros);
    entry.overrunMicros = overrun;
    if (overrun > 0) violations.push("settled_overrun");
  } else {
    entry.state = "released";
    entry.releasedMicros = entry.maxMicros;
  }
  rebuildCostAggregates(cost);
  return commit(next, { resolved: true, callId, resolution, state: entry.state, settledMicros: entry.settledMicros, violations });
}

/* Nur-Lese-Sicht auf den Kostenstand — immer aus den Belegen gerechnet. */
export function costSnapshot(data, input = {}) {
  const runtime = readRuntime(data);
  const cost = isRecord(runtime.cost) ? runtime.cost : emptyRuntimeArea().cost;
  const derived = deriveCostTotals(cost);
  const localDate = input.localDate === undefined ? null : input.localDate;
  const runKey = input.runKey === undefined ? null : input.runKey;
  return {
    policyRef: cost.policyRef || null,
    day: localDate ? { ...readDerivedBucket(derived.byDay, localDate, EMPTY_DAY), localDate } : null,
    run: runKey ? { ...readDerivedBucket(derived.byRun, runKey, EMPTY_RUN), runKey } : null,
    unresolved: { ...derived.unresolved, callIds: [...derived.unresolved.callIds] },
    overrunMicros: derived.overrunMicros,
    dryRunChargeCount: cost.dryRunChargeCount || 0,
    calls: Object.keys(cost.callsById || {}).length,
  };
}

export function isBlindRetryBlocked(data, contentHash) {
  requireId(contentHash, "contentHash", HASH_RE);
  const runtime = readRuntime(data);
  const cost = isRecord(runtime.cost) ? runtime.cost : emptyRuntimeArea().cost;
  return blockingCallForHash(cost, contentHash) !== null;
}

/* ═══ E1-C · Monitorplan in den Kern schreiben ═══════════════════════════ */

/* Projektion fuer buildMonitorPlan / buildPreflightPlan. Nur lesen. */
export function projectMonitorView(data) {
  const runtime = readRuntime(data);
  const runs = Object.values(runtime.runsByKey || {}).filter(isRecord).map((run) => ({
    runKey: run.runKey,
    slot: run.slot,
    localDate: run.localDate,
    phase: run.phase,
    hasStarted: Object.keys(run.sections || {}).length > 0,
    startedAtMs: run.createdAtMs || null,
    pendingContinuationId: run.pendingContinuationId || null,
    lateSections: run.lateSections || 0,
    green: run.green === true,
  }));
  const incidents = Object.values(runtime.incidentsById || {}).filter(isRecord).map((inc) => ({
    id: inc.id, kind: inc.kind, runKey: inc.runKey || null,
    detectedAtMs: inc.detectedAtMs || null, resolvedAtMs: inc.resolvedAtMs || null,
  }));
  const intents = Object.values(runtime.continuationsById || {}).filter(isRecord).map((it) => ({
    id: it.id, kind: it.kind, runKey: it.runKey || null, state: it.state,
    notBeforeMs: Number.isSafeInteger(it.notBeforeMs) ? it.notBeforeMs : null,
    deliveries: it.deliveries || 0,
  }));
  const monitor = isRecord(runtime.monitor) ? runtime.monitor : {};
  return {
    runs, incidents, intents,
    monitor: {
      lastTickAtMs: Number.isSafeInteger(monitor.lastTickAtMs) ? monitor.lastTickAtMs : null,
      lastHeartbeatAtMs: Number.isSafeInteger(monitor.lastHeartbeatAtMs) ? monitor.lastHeartbeatAtMs : null,
      warnFailures: monitor.warnFailures || 0,
    },
  };
}

export const MONITOR_TICK_HISTORY = 24;

/* Legt den Plan idempotent ab. Derselbe Tick (gleiches Fuenf-Minuten-
 * Fenster) schreibt kein zweites Mal; vorhandene Vorfaelle werden nie
 * ueberschrieben und nie geloescht. */
export function applyMonitorPlan(data, input = {}) {
  const plan = input.plan;
  if (!isRecord(plan) || plan.schema !== PLAN_SCHEMA || plan.kind !== "monitor_tick") {
    fail("invalid_monitor_plan", 400, { schema: isRecord(plan) ? String(plan.schema) : null });
  }
  const now = requireMs(input.now, "now");
  if (plan.atMs !== now) fail("monitor_plan_time_mismatch", 400, { planAtMs: plan.atMs, now });
  const tickId = requireId(plan.tickId, "tickId");
  assertCore(data);
  const runtimeBefore = readRuntime(data);
  const monitorBefore = isRecord(runtimeBefore.monitor) ? runtimeBefore.monitor : {};
  const seen = isRecord(monitorBefore.ticksById) ? monitorBefore.ticksById[tickId] : undefined;
  if (isRecord(seen)) {
    return noop(data, { duplicate: true, tickId, createdIncidents: seen.createdIncidents || 0, createdIntents: seen.createdIntents || 0 });
  }

  const { next, runtime } = begin(data, now);
  const createdIncidents = [];
  const createdIntents = [];
  const resolved = [];

  for (const incident of Array.isArray(plan.incidents) ? plan.incidents : []) {
    const id = requireId(incident.id, "incidentId");
    if (isRecord(runtime.incidentsById[id])) continue;   // nie doppelt
    runtime.incidentsById[id] = {
      ...structuredClone(incident), id,
      resolvedAtMs: null, resolvedBy: null, source: "monitor",
    };
    createdIncidents.push(id);
  }
  for (const intent of Array.isArray(plan.intents) ? plan.intents : []) {
    const id = requireId(intent.id, "continuationId");
    if (isRecord(runtime.continuationsById[id])) continue; // nie doppelt
    runtime.continuationsById[id] = {
      ...structuredClone(intent), id, state: "pending", createdAtMs: now,
      deliveries: 0, deliveryIds: [], lastDeliveryAtMs: null, consumedAtMs: null,
      source: "monitor",
    };
    createdIntents.push(id);
    const run = runtime.runsByKey[intent.runKey];
    if (isRecord(run) && !run.pendingContinuationId) run.pendingContinuationId = id;
  }
  for (const resolution of Array.isArray(plan.resolutions) ? plan.resolutions : []) {
    const id = requireId(resolution.incidentId, "incidentId");
    const incident = runtime.incidentsById[id];
    // Nachholen loescht den Vorfall NICHT — er wird nur als erledigt vermerkt.
    if (!isRecord(incident) || incident.resolvedAtMs) continue;
    incident.resolvedAtMs = now;
    incident.resolvedBy = requireId(resolution.resolvedBy, "resolvedBy");
    resolved.push(id);
  }

  const monitor = runtime.monitor;
  monitor.lastTickAtMs = now;
  monitor.lastHeartbeatAtMs = now;
  if (plan.truncated === true) monitor.lastTruncatedAtMs = now;
  monitor.ticksById[tickId] = { tickId, atMs: now, createdIncidents: createdIncidents.length, createdIntents: createdIntents.length, resolved: resolved.length };
  const history = [...(Array.isArray(monitor.recentTickIds) ? monitor.recentTickIds : []), tickId];
  monitor.recentTickIds = history.slice(-MONITOR_TICK_HISTORY);
  for (const old of history.slice(0, Math.max(0, history.length - MONITOR_TICK_HISTORY))) {
    delete monitor.ticksById[old];
  }
  return commit(next, {
    tickId, createdIncidents, createdIntents, resolved,
    truncated: plan.truncated === true,
    heartbeatAtMs: now,
  });
}

/* Fehlgeschlagene Warnzustellung wird verbucht — sie gilt nie als zugestellt. */
export function recordWarningFailure(data, input = {}) {
  const now = requireMs(input.now, "now");
  const channel = requireId(input.channel, "channel");
  const failureId = requireId(input.failureId, "failureId");
  assertCore(data);
  const runtimeBefore = readRuntime(data);
  const monitorBefore = isRecord(runtimeBefore.monitor) ? runtimeBefore.monitor : {};
  if (Array.isArray(monitorBefore.warnFailureIds) && monitorBefore.warnFailureIds.includes(failureId)) {
    return noop(data, { duplicate: true, failureId, warnFailures: monitorBefore.warnFailures || 0 });
  }
  const { next, runtime } = begin(data, now);
  const monitor = runtime.monitor;
  monitor.warnFailures = (monitor.warnFailures || 0) + 1;
  monitor.warnFailureIds = [...(Array.isArray(monitor.warnFailureIds) ? monitor.warnFailureIds : []), failureId].slice(-50);
  monitor.lastWarnFailureAtMs = now;
  monitor.lastWarnFailureChannel = channel;
  return commit(next, { failureId, channel, warnFailures: monitor.warnFailures, assumeDelivered: false });
}

export { slotRunKey };
