/* ══ E2 — Laufzeitkonfiguration, streng fail closed ═══════════════════════
 *
 * Ohne vollstaendige Konfiguration startet nichts und antwortet jede Route
 * mit 503. Die Absage nennt nur die NAMEN fehlender Variablen, nie Werte.
 *
 * Betriebsart:
 *   dry_run  (Standard)  nichts wirkt nach aussen, Kosten sind 0
 *   shadow               liest echte Quellen, schreibt nur Schattenbelege
 *   live                 nur mit ALLEN Freigabetoren UND ausdruecklicher
 *                        Erlaubnis; eine unvollstaendige Freigabe ist ein
 *                        Konfigurationsfehler, keine stille Rueckstufung
 *
 * In dieser Datei steht kein Geheimnis. Dienstzugangsdaten und Preisstand
 * kommen ueber Ports; die Konfiguration merkt sich nur, OB sie da sind.
 * ═════════════════════════════════════════════════════════════════════════ */

export const RUNTIME_ROLES = Object.freeze(["worker", "monitor", "watchdog"]);
export const RUNTIME_MODES = Object.freeze(["dry_run", "shadow", "live"]);
export const DEFAULT_MODE = "dry_run";

/* Der HTTP-Abschnitt endet spaetestens nach 90 Sekunden — danach gibt es
 * einen Checkpoint und eine Fortsetzung, nie eine Verlaengerung. */
export const SECTION_DEADLINE_MS = 90_000;
export const SECTION_RESERVE_MS = 10_000;   // Zeitpolster fuer Checkpoint + Einreihen
export const MAX_REQUEST_BYTES = 16 * 1024;

/* Freigabetore. ALLE muessen bestanden sein, bevor `live` erlaubt ist.
 * Jedes Tor braucht einen Nachweis (`ref`) — ein blosses true reicht nicht. */
export const ACTIVATION_GATES = Object.freeze([
  "allWriterMigration",     // Desktop/Tablet/Mobile schreiben ueber die Kommando-API
  "authPackageAccepted",    // C1/C2 abgenommen
  "costPolicyApproved",     // freigegebener Preis- und Budgetstand
  "restoreDrill",           // Restore-Uebung mit Replay-Fencing bestanden
  "monitorWatchdogProven",  // Monitor UND unabhaengiger Watchdog belegt
  "trial14Days",            // echter 14-Tage-Probebetrieb
]);

/* Die vier Werkzeuge aus C1 — hier nur als Namensliste, damit die
 * Freischaltung keine unbekannte Kennung annimmt. */
export const QUANTUS_TOOL_NAMES = Object.freeze([
  "quantus_context", "quantus_read", "quantus_command", "quantus_run_status",
]);

export const ENDPOINT_KEYS = Object.freeze({
  worker: ["slot.start", "run.continue"],
  monitor: ["monitor.tick", "monitor.preflight"],
  watchdog: ["watchdog.check"],
});

const SA_RE = /^[a-z0-9][-a-z0-9.]{0,61}@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const HTTPS_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\-/]*)?$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POLICY_RE = /^[A-Za-z0-9._-]{1,32}$/;
const QUEUE_RE = /^projects\/[a-z0-9-]{1,64}\/locations\/[a-z0-9-]{1,32}\/queues\/[A-Za-z0-9-]{1,100}$/;

function parseJson(raw) {
  try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false }; }
}
function isRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

/**
 * @param envRead (name) => string|undefined — nur diese Funktion liest Umgebung.
 * @returns { ok: true, config } | { ok: false, status: 503, body }
 */
export function resolveRuntimeConfig(envRead) {
  if (typeof envRead !== "function") {
    return fail(["QUANTUS_V3_*"], "runtime_not_configured");
  }
  const read = (name) => {
    const raw = envRead(name);
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const missing = [];
  const invalid = [];
  const need = (name) => { const v = read(name); if (v === undefined) missing.push(name); return v; };

  const role = need("QUANTUS_V3_RUNTIME_ROLE");
  if (role !== undefined && !RUNTIME_ROLES.includes(role)) invalid.push("QUANTUS_V3_RUNTIME_ROLE");
  const tenant = need("QUANTUS_V3_TENANT");
  if (tenant !== undefined && !TENANT_RE.test(tenant)) invalid.push("QUANTUS_V3_TENANT");
  const policyVersion = need("QUANTUS_V3_POLICY_VERSION");
  if (policyVersion !== undefined && !POLICY_RE.test(policyVersion)) invalid.push("QUANTUS_V3_POLICY_VERSION");

  const modeRaw = read("QUANTUS_V3_RUNTIME_MODE");
  const mode = modeRaw === undefined ? DEFAULT_MODE : modeRaw;
  if (!RUNTIME_MODES.includes(mode)) invalid.push("QUANTUS_V3_RUNTIME_MODE");

  const endpointsRaw = need("QUANTUS_V3_ENDPOINTS");
  let endpoints = null;
  if (endpointsRaw !== undefined) {
    const parsed = parseJson(endpointsRaw);
    if (!parsed.ok || !isRecord(parsed.value)) invalid.push("QUANTUS_V3_ENDPOINTS");
    else {
      endpoints = {};
      const wanted = RUNTIME_ROLES.includes(role) ? ENDPOINT_KEYS[role] : [];
      for (const key of wanted) {
        const entry = parsed.value[key];
        if (!isRecord(entry) || typeof entry.audience !== "string" || !HTTPS_RE.test(entry.audience)
          || !Array.isArray(entry.allowedServiceAccounts) || entry.allowedServiceAccounts.length === 0
          || !entry.allowedServiceAccounts.every((s) => typeof s === "string" && SA_RE.test(s))) {
          invalid.push(`QUANTUS_V3_ENDPOINTS:${key}`);
          continue;
        }
        // Jede Route hat ihre EIGENE Aufruferliste. Ein Scheduler-Konto, das
        // den Start ausloest, darf damit keine Fortsetzung einwerfen.
        endpoints[key] = Object.freeze({
          audience: entry.audience,
          allowedServiceAccounts: Object.freeze([...new Set(entry.allowedServiceAccounts)].sort()),
        });
      }
      const unbekannt = Object.keys(parsed.value).filter((k) => !wanted.includes(k));
      if (unbekannt.length) invalid.push("QUANTUS_V3_ENDPOINTS:unexpected_keys");
    }
  }

  const gatesRaw = read("QUANTUS_V3_ACTIVATION_GATES");
  const gates = {};
  let gatesComplete = true;
  if (gatesRaw !== undefined) {
    const parsed = parseJson(gatesRaw);
    if (!parsed.ok || !isRecord(parsed.value)) invalid.push("QUANTUS_V3_ACTIVATION_GATES");
    else {
      for (const name of ACTIVATION_GATES) {
        const entry = parsed.value[name];
        const passed = isRecord(entry) && entry.passed === true
          && typeof entry.ref === "string" && entry.ref.length >= 4;
        gates[name] = { passed, ref: passed ? entry.ref : null };
        if (!passed) gatesComplete = false;
      }
      if (Object.keys(parsed.value).some((k) => !ACTIVATION_GATES.includes(k))) invalid.push("QUANTUS_V3_ACTIVATION_GATES:unexpected_keys");
    }
  } else {
    for (const name of ACTIVATION_GATES) gates[name] = { passed: false, ref: null };
    gatesComplete = false;
  }

  const allowExternal = read("QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS") === "true";
  if (mode === "live" && !gatesComplete) invalid.push("QUANTUS_V3_RUNTIME_MODE:activation_gate_not_passed");
  if (mode === "live" && !allowExternal) invalid.push("QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS");

  let tasks = null;
  if (role === "worker" || role === "monitor") {
    const queue = need("QUANTUS_V3_TASKS_QUEUE");
    const targetUrl = need("QUANTUS_V3_TASKS_TARGET_URL");
    const oidcSa = need("QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT");
    const audience = read("QUANTUS_V3_TASKS_OIDC_AUDIENCE") ?? targetUrl;
    if (queue !== undefined && !QUEUE_RE.test(queue)) invalid.push("QUANTUS_V3_TASKS_QUEUE");
    if (targetUrl !== undefined && !HTTPS_RE.test(targetUrl)) invalid.push("QUANTUS_V3_TASKS_TARGET_URL");
    if (oidcSa !== undefined && !SA_RE.test(oidcSa)) invalid.push("QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT");
    if (audience !== undefined && !HTTPS_RE.test(audience)) invalid.push("QUANTUS_V3_TASKS_OIDC_AUDIENCE");
    tasks = { queue, targetUrl, oidcServiceAccount: oidcSa, audience };
  }

  let monitorStartLocalDate = null;
  if (role === "monitor") {
    monitorStartLocalDate = need("QUANTUS_V3_MONITOR_START_LOCAL_DATE");
    if (monitorStartLocalDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(monitorStartLocalDate)) {
      invalid.push("QUANTUS_V3_MONITOR_START_LOCAL_DATE");
    }
  }

  const holder = read("QUANTUS_V3_LEASE_HOLDER");
  if (role === "worker" && holder === undefined) missing.push("QUANTUS_V3_LEASE_HOLDER");
  if (holder !== undefined && !/^[A-Za-z0-9_.:-]{1,120}$/.test(holder)) invalid.push("QUANTUS_V3_LEASE_HOLDER");

  const deadlineRaw = read("QUANTUS_V3_SECTION_DEADLINE_MS");
  let sectionDeadlineMs = SECTION_DEADLINE_MS;
  if (deadlineRaw !== undefined) {
    const n = Number(deadlineRaw);
    if (!Number.isSafeInteger(n) || n < 5_000 || n > SECTION_DEADLINE_MS) invalid.push("QUANTUS_V3_SECTION_DEADLINE_MS");
    else sectionDeadlineMs = n;
  }

  // Der Quellensatz, der fuer einen Abschluss vollstaendig belegt sein
  // muss. Er kommt aus der Serverkonfiguration, nicht aus dem Nachweis
  // selbst — sonst koennte der Nachweis sich seine Anforderungen selbst
  // aussuchen.
  let requiredSources = [];
  const sourcesRaw = read("QUANTUS_V3_REQUIRED_SOURCES");
  if (sourcesRaw !== undefined) {
    const parsed = parseJson(sourcesRaw);
    if (!parsed.ok || !Array.isArray(parsed.value)
      || !parsed.value.every((id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(id))
      || new Set(parsed.value).size !== parsed.value.length) {
      invalid.push("QUANTUS_V3_REQUIRED_SOURCES");
    } else {
      requiredSources = [...parsed.value].sort();
    }
  }
  if (mode === "live" && role === "worker" && requiredSources.length === 0) {
    // Im Live-Betrieb ohne einen einzigen belegpflichtigen Quellensatz
    // waere jeder Abschluss trivial gruen.
    invalid.push("QUANTUS_V3_REQUIRED_SOURCES:empty_in_live");
  }

  /*
   * Der Ursprung der vier C2-Routen und die Freischaltung der Werkzeuge.
   * Beides ist OPTIONAL und standardmaessig AUS: ohne Ursprung gibt es
   * keinen Transport, ohne Freischaltung kein Werkzeug — der Aufruf endet
   * dann mit 503, nicht mit einem uebersprungenen Schritt. C1 fuehrt alle
   * vier Werkzeuge auf `false`; dieses Paket schaltet nichts frei, es
   * liest nur, was der Betreiber ausdruecklich gesetzt hat.
   */
  const c2BaseUrl = read("QUANTUS_V3_C2_BASE_URL") ?? null;
  if (c2BaseUrl !== null && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(c2BaseUrl)) invalid.push("QUANTUS_V3_C2_BASE_URL");

  const toolsEnabled = {};
  for (const name of QUANTUS_TOOL_NAMES) toolsEnabled[name] = false;
  const toolsRaw = read("QUANTUS_V3_TOOLS_ENABLED");
  if (toolsRaw !== undefined) {
    const parsed = parseJson(toolsRaw);
    if (!parsed.ok || !isRecord(parsed.value)) invalid.push("QUANTUS_V3_TOOLS_ENABLED");
    else if (Object.keys(parsed.value).some((k) => !QUANTUS_TOOL_NAMES.includes(k))) invalid.push("QUANTUS_V3_TOOLS_ENABLED:unexpected_keys");
    else if (Object.values(parsed.value).some((v) => typeof v !== "boolean")) invalid.push("QUANTUS_V3_TOOLS_ENABLED:not_boolean");
    else for (const [k, v] of Object.entries(parsed.value)) toolsEnabled[k] = v;
  }

  const maxLatenessRaw = read("QUANTUS_V3_SLOT_MAX_LATENESS_MS");
  let slotMaxLatenessMs = 6 * 60 * 60 * 1000;
  if (maxLatenessRaw !== undefined) {
    const n = Number(maxLatenessRaw);
    if (!Number.isSafeInteger(n) || n < 60_000 || n > 12 * 60 * 60 * 1000) invalid.push("QUANTUS_V3_SLOT_MAX_LATENESS_MS");
    else slotMaxLatenessMs = n;
  }

  if (missing.length || invalid.length) return fail(missing, "runtime_not_configured", invalid);

  return {
    ok: true,
    config: Object.freeze({
      role, mode, tenant, policyVersion,
      endpoints: Object.freeze(endpoints),
      gates: Object.freeze(gates),
      gatesComplete,
      allowExternalEffects: mode === "live" && allowExternal && gatesComplete,
      tasks: tasks ? Object.freeze(tasks) : null,
      leaseHolder: holder ?? null,
      monitorStartLocalDate: monitorStartLocalDate ?? null,
      leaseScope: `${tenant}:mainrun`,
      sectionDeadlineMs,
      sectionReserveMs: Math.min(SECTION_RESERVE_MS, Math.floor(sectionDeadlineMs / 3)),
      slotMaxLatenessMs,
      requiredSources: Object.freeze(requiredSources),
      c2BaseUrl,
      toolsEnabled: Object.freeze(toolsEnabled),
      maxRequestBytes: MAX_REQUEST_BYTES,
    }),
  };
}

function fail(missing, error, invalid = []) {
  return {
    ok: false,
    status: 503,
    body: {
      error,
      // Nur Namen. Niemals Werte.
      missing: [...new Set(missing)].sort(),
      invalid: [...new Set(invalid)].sort(),
    },
  };
}

/* Darf diese Betriebsart ueberhaupt nach aussen wirken? */
export function externalEffectsAllowed(config) {
  return config.mode === "live" && config.allowExternalEffects === true && config.gatesComplete === true;
}
