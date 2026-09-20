/* ══ E2-Testwerkzeug ══════════════════════════════════════════════════════
 *
 * Alle Schluessel entstehen zur Laufzeit; im Repository steht kein
 * Geheimnis. Alle Projekt-, Konto- und Hostnamen sind erkennbar
 * synthetisch (`.invalid`, `test-invalid`) und existieren nicht.
 *
 * Die Attrappen bilden die dokumentierten Vertraege nach — sie sagen NICHT
 * immer ok:
 *   · Cloud Tasks weist einen bereits vergebenen Namen ab (ALREADY_EXISTS)
 *   · der Kernport laeuft ueber die echte CAS-Schleife aus dem E1-Pruefstand
 *     mit den echten E1-Mutatoren; Konflikte sind echte Konflikte
 *   · die Uhr ist steuerbar, damit die 90-Sekunden-Grenze pruefbar ist
 * ═════════════════════════════════════════════════════════════════════════ */
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createCasStore, casMutate, baseCore } from "./quantus-v3-runtime-cas-harness.mjs";
import { createNodeRequestListener } from "../runtime/quantus-v3/src/http.mjs";
import { availablePort, unavailablePort, createPortRegistry } from "../runtime/quantus-v3/src/ports.mjs";
import { createApp } from "../runtime/quantus-v3/src/app.mjs";
import { resolveRuntimeConfig } from "../runtime/quantus-v3/src/config.mjs";

export const TENANT = "quantus";
export const POLICY_VERSION = "3.0";
export const QUEUE = "projects/test-invalid/locations/europe-west6/queues/quantus-v3-continuations";
export const QUEUE_NAME = "quantus-v3-continuations";
export const SA = Object.freeze({
  schedulerStart: "quantus-v3-scheduler-start@test-invalid.iam.gserviceaccount.com",
  schedulerMonitor: "quantus-v3-scheduler-monitor@test-invalid.iam.gserviceaccount.com",
  schedulerWatchdog: "quantus-v3-scheduler-watchdog@test-invalid.iam.gserviceaccount.com",
  tasks: "quantus-v3-tasks@test-invalid.iam.gserviceaccount.com",
  fremd: "irgendwer@test-invalid.iam.gserviceaccount.com",
});
export const AUD = Object.freeze({
  slotStart: "https://worker.test.invalid/v3/slot/start",
  runContinue: "https://worker.test.invalid/v3/run/continue",
  monitorTick: "https://monitor.test.invalid/v3/monitor/tick",
  monitorPreflight: "https://monitor.test.invalid/v3/monitor/preflight",
  watchdogCheck: "https://watchdog.test.invalid/v3/watchdog/check",
});

/* ── Schluessel und Token ──────────────────────────────────────────────── */

export function createSigningKey(kid = "test-key-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { kid, privateKey, publicKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function mintIdToken(key, claims, { alg = "RS256", kid = key.kid, signWith = key.privateKey, tamper = null } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  if (alg === "none") return `${header}.${payload}.`;
  const input = Buffer.from(`${header}.${payload}`, "utf8");
  const signature = b64url(cryptoSign("RSA-SHA256", input, signWith));
  if (tamper) {
    const veraendert = b64url(JSON.stringify({ ...claims, ...tamper }));
    return `${header}.${veraendert}.${signature}`;   // gleiche Signatur, anderer Inhalt
  }
  return `${header}.${payload}.${signature}`;
}

export function schedulerToken(key, { audience, email, nowMs, ttlS = 600, overrides = {} } = {}) {
  const iat = Math.floor(nowMs / 1000);
  return mintIdToken(key, {
    iss: "https://accounts.google.com",
    aud: audience,
    sub: "1234567890",
    email,
    email_verified: true,
    iat,
    exp: iat + ttlS,
    ...overrides,
  });
}

export function jwksPort(...keys) {
  return availablePort("jwks", { async getKeys() { return { keys: keys.map((k) => k.jwk) }; } });
}

/* ── Steuerbare Uhr ────────────────────────────────────────────────────── */

/* Uhr UND Zeitgeber aus einer Quelle. Eine Testuhr mit echten
 * Wallclock-Timern zu mischen wuerde jede Aussage ueber Fristen wertlos
 * machen — deshalb feuern die Timer nur, wenn der Test die Uhr bewegt. */
export function createClock(startMs, stepMs = 0) {
  let current = startMs;
  let seq = 0;
  const timers = new Map();
  function fireDue() {
    for (let schutz = 0; schutz < 1000; schutz++) {
      let naechster = null;
      for (const [id, t] of timers) {
        if (t.at <= current && (naechster === null || t.at < timers.get(naechster).at)) naechster = id;
      }
      if (naechster === null) return;
      const t = timers.get(naechster);
      timers.delete(naechster);
      t.cb();
    }
    throw new Error("createClock: zu viele faellige Timer");
  }
  return {
    port: availablePort("clock", {
      now: () => { const v = current; current += stepMs; return v; },
      setTimer: (delayMs, cb) => {
        const id = ++seq;
        timers.set(id, { at: current + Math.max(0, delayMs), cb });
        return () => timers.delete(id);
      },
    }),
    set(v) { current = v; fireDue(); },
    advance(ms) { current += ms; fireDue(); },
    get value() { return current; },
    get pendingTimers() { return timers.size; },
  };
}

/* ── Kernport ueber die echte CAS-Schleife ─────────────────────────────── */

/* Bildet den Umschlag der Integration nach: ein Ergebnis je commandKey
 * (Wiederholung liest den Beleg), sonst die echte CAS-Schleife mit den
 * echten E1-Mutatoren. KEIN always-ok. */
export function createCorePort(store) {
  const receipts = new Map();
  const calls = [];
  return {
    store, calls,
    get receiptCount() { return receipts.size; },
    port: availablePort("core", {
      async read() { return { data: store.snapshot() }; },
      async mutate({ commandKey, mutate }) {
        calls.push(commandKey);
        if (receipts.has(commandKey)) return { ...receipts.get(commandKey), replayed: true };
        let out;
        try {
          out = casMutate(store, mutate);
        } catch (err) {
          // Der Umschlag reicht kodierte Fehler mit Status durch.
          if (err && typeof err.status === "number") {
            const e = new Error(err.code || "core_error");
            e.status = err.status; e.error = err.code || "core_error"; e.detail = err.detail ?? null;
            e.toBody = () => ({ error: e.error, detail: e.detail });
            throw e;
          }
          throw err;
        }
        const receipt = { ok: true, result: out.result, replayed: false, wrote: out.wrote };
        receipts.set(commandKey, receipt);
        return receipt;
      },
    }),
  };
}

/* ── Cloud Tasks: Namensdeduplizierung wie echt ────────────────────────── */

export function createTasksPort() {
  const created = new Map();
  const attempts = [];
  let failNext = null;
  return {
    created, attempts,
    failOnce(error) { failNext = error; },
    port: availablePort("tasks", {
      async enqueueContinuation(task) {
        attempts.push(task);
        if (failNext) { const e = failNext; failNext = null; throw new Error(e); }
        if (created.has(task.taskId)) return { enqueued: false, duplicate: true, reason: "ALREADY_EXISTS" };
        created.set(task.taskId, task);
        return { enqueued: true, duplicate: false };
      },
    }),
  };
}

/* ── Abschnittsarbeit ──────────────────────────────────────────────────── */

/* Liefert `count` Schritte; jeder Schritt laesst die Uhr um `clockStepMs`
 * altern, damit die 90-Sekunden-Grenze ohne echtes Warten pruefbar ist. */
export function createSectionWorkPort({ count = 2, clock = null, clockStepMs = 0, durationMs = 100 } = {}) {
  let handed = 0;
  return {
    get handed() { return handed; },
    port: availablePort("sectionWork", {
      async next({ cursor }) {
        const position = (cursor && cursor.position) || 0;
        if (position >= count) return { done: true };
        handed += 1;
        if (clock && clockStepMs) clock.advance(clockStepMs);
        return { done: false, stepId: `s${position + 1}`, durationMs, cursor: { position: position + 1 } };
      },
    }),
  };
}

/* Ein Abschnittsanbieter, dessen Aufruf der Test von aussen haelt und
 * freigibt — damit laesst sich eine zweite, gleichzeitige Zustellung
 * genau waehrend des externen Aufrufs einschleusen. */
export function createGatedSectionWorkPort({ steps = 1, durationMs = 100 } = {}) {
  let calls = 0;
  let betretenAusloesen = null;
  const betreten = new Promise((resolve) => { betretenAusloesen = resolve; });
  let freigeben = null;
  const gehalten = new Promise((resolve) => { freigeben = resolve; });
  const signale = [];
  return {
    betreten,
    get calls() { return calls; },
    get signals() { return signale; },
    release() { freigeben(); },
    port: availablePort("sectionWork", {
      async next({ cursor, signal }) {
        calls += 1;
        signale.push(signal ?? null);
        betretenAusloesen();
        await gehalten;
        const position = (cursor && cursor.position) || 0;
        if (position >= steps) return { done: true };
        return { done: false, stepId: `s${position + 1}`, durationMs, cursor: { position: position + 1 } };
      },
    }),
  };
}

/* Ein Anbieter, der NIE zurueckkehrt — fuer die harte Fristpruefung. */
export function createHangingSectionWorkPort() {
  let calls = 0;
  const signale = [];
  let betretenAusloesen = null;
  const betreten = new Promise((resolve) => { betretenAusloesen = resolve; });
  return {
    betreten,
    get calls() { return calls; },
    get signals() { return signale; },
    get aborted() { return signale.some((s) => s && s.aborted === true); },
    port: availablePort("sectionWork", {
      next({ signal }) {
        calls += 1;
        signale.push(signal ?? null);
        betretenAusloesen();
        return new Promise(() => {});   // kehrt nie zurueck
      },
    }),
  };
}

/* Ein streng geprueftes Abschlussnachweis-Portal. Die Vorlage ist
 * vollstaendig und gueltig; jeder Test verbiegt genau ein Feld. */
export function createClosureEvidencePort(bauen) {
  const aufrufe = [];
  return {
    aufrufe,
    port: availablePort("closureEvidence", {
      async load(input) {
        aufrufe.push(input);
        return typeof bauen === "function" ? bauen(input, aufrufe.length) : bauen;
      },
    }),
  };
}

export function createAlertPort({ delivered = true, throws = false } = {}) {
  const sent = [];
  return {
    sent,
    port: availablePort("alert", {
      async send(payload) {
        sent.push(payload);
        if (throws) throw new Error("alert_transport_failed");
        return { delivered };
      },
    }),
  };
}

/* ── Konfiguration ─────────────────────────────────────────────────────── */

export function envFor(role, overrides = {}) {
  const endpoints = {
    worker: { "slot.start": { audience: AUD.slotStart, allowedServiceAccounts: [SA.schedulerStart] },
              "run.continue": { audience: AUD.runContinue, allowedServiceAccounts: [SA.tasks] } },
    monitor: { "monitor.tick": { audience: AUD.monitorTick, allowedServiceAccounts: [SA.schedulerMonitor] },
               "monitor.preflight": { audience: AUD.monitorPreflight, allowedServiceAccounts: [SA.schedulerMonitor] } },
    watchdog: { "watchdog.check": { audience: AUD.watchdogCheck, allowedServiceAccounts: [SA.schedulerWatchdog] } },
  }[role];
  const base = {
    QUANTUS_V3_RUNTIME_ROLE: role,
    QUANTUS_V3_TENANT: TENANT,
    QUANTUS_V3_POLICY_VERSION: POLICY_VERSION,
    QUANTUS_V3_ENDPOINTS: JSON.stringify(endpoints),
    QUANTUS_V3_LEASE_HOLDER: `${role}-rev-0001`,
  };
  if (role === "worker" || role === "monitor") {
    base.QUANTUS_V3_TASKS_QUEUE = QUEUE;
    base.QUANTUS_V3_TASKS_TARGET_URL = AUD.runContinue;
    base.QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT = SA.tasks;
  }
  if (role === "monitor") base.QUANTUS_V3_MONITOR_START_LOCAL_DATE = "2026-09-19";
  const merged = { ...base, ...overrides };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return merged;
}

export function configFor(role, overrides = {}) {
  const env = envFor(role, overrides);
  const resolved = resolveRuntimeConfig((name) => env[name]);
  if (!resolved.ok) throw new Error(`Testkonfiguration ungueltig: ${JSON.stringify(resolved.body)}`);
  return resolved.config;
}

export function allGatesPassed() {
  return JSON.stringify(Object.fromEntries(
    ["allWriterMigration", "authPackageAccepted", "costPolicyApproved", "restoreDrill", "monitorWatchdogProven", "trial14Days"]
      .map((g) => [g, { passed: true, ref: `SYNTHETIC-${g}` }]),
  ));
}

/* ── Echter lokaler HTTP-Dienst ────────────────────────────────────────── */

export async function startService({ role, ports, configOverrides = {}, logs = [] }) {
  const config = configFor(role, configOverrides);
  const registry = createPortRegistry(role, ports);
  const app = createApp({ config, ports: registry, logger: (e) => logs.push(e) });
  const server = createServer(createNodeRequestListener(app.router, { maxBytes: config.maxRequestBytes }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    config, app, logs,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async post(path, { token, body, headers = {} } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          "x-forwarded-proto": "https",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? "{}" : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* absichtlich: Antwort muss JSON sein */ }
      return { status: response.status, json, text, headers: Object.fromEntries(response.headers) };
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

export { createCasStore, casMutate, baseCore, unavailablePort, availablePort, createPortRegistry };
