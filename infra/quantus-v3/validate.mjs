#!/usr/bin/env node
/* ══ Quantus v3 Infrastruktur — Abnahmepruefung vor dem Anwenden ══════════
 *
 *     node infra/quantus-v3/validate.mjs [pfad/zur/deployment.json]
 *
 * Diese Pruefung verweigert ein unkonfiguriertes oder halb ausgefuelltes
 * Deployment ausdruecklich. Sie ersetzt kein `terraform plan` und beweist
 * nichts ueber die echte Cloud — sie stellt nur sicher, dass gar nicht
 * erst etwas angewendet wird, das Platzhalter, Geheimniswerte, einen
 * fuenften Hauptauftrag, ein geteiltes Dienstkonto oder ein
 * unvollstaendiges Freigabetor enthaelt.
 *
 * Exitcode 0 = keine Beanstandung, 1 = Beanstandungen, 2 = Aufrufproblem.
 * ═════════════════════════════════════════════════════════════════════════ */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = dirname(fileURLToPath(import.meta.url));

export const PLACEHOLDER_RE = /(?:replace[\s_-]*me|example|changeme|todo|xxxx|<[a-z-]+>)/i;
export const SECRET_LOOKING_RE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,})/;
const SA_RE = /^[a-z0-9][-a-z0-9.]{0,61}@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/;
const HTTPS_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\-/]*)?$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUEUE_RE = /^projects\/([a-z0-9-]{1,64})\/locations\/([a-z0-9-]{1,32})\/queues\/([A-Za-z0-9-]{1,100})$/;
const DIGEST_RE = /@sha256:[a-f0-9]{64}$/;

export const ACTIVATION_GATES = Object.freeze([
  "allWriterMigration", "authPackageAccepted", "costPolicyApproved",
  "restoreDrill", "monitorWatchdogProven", "trial14Days",
]);

/* Was das Deployment enthalten MUSS — daran wird gemessen. */
export const EXPECTED = Object.freeze({
  serviceAccountKeys: Object.freeze(["worker", "monitor", "watchdog", "schedulerStart", "schedulerMonitor", "schedulerWatchdog", "tasks"]),
  endpoints: Object.freeze({
    "slot.start": { path: "/v3/slot/start", caller: "schedulerStart" },
    "run.continue": { path: "/v3/run/continue", caller: "tasks" },
    "monitor.tick": { path: "/v3/monitor/tick", caller: "schedulerMonitor" },
    "monitor.preflight": { path: "/v3/monitor/preflight", caller: "schedulerMonitor" },
    "watchdog.check": { path: "/v3/watchdog/check", caller: "schedulerWatchdog" },
  }),
  slotJobs: Object.freeze({
    "slot-briefing04": "0 4 * * *",
    "slot-process09": "0 9 * * *",
    "slot-continue14": "0 14 * * *",
    "slot-close23": "0 23 * * *",
  }),
  supportJobs: Object.freeze({
    "monitor-tick": { schedule: "*/5 * * * *", path: "/v3/monitor/tick", caller: "schedulerMonitor" },
    "monitor-preflight": { schedule: "30 22 * * *", path: "/v3/monitor/preflight", caller: "schedulerMonitor" },
    "watchdog": { schedule: "7-59/15 * * * *", path: "/v3/watchdog/check", caller: "schedulerWatchdog" },
  }),
  timeZone: "Europe/Zurich",
  forbiddenInIac: Object.freeze(["google_secret_manager_secret_version", "google_project_service", "allUsers", "allAuthenticatedUsers"]),
});

function deepStrings(value, path = "", out = []) {
  if (typeof value === "string") { out.push([path, value]); return out; }
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) deepStrings(v, path ? `${path}.${k}` : k, out);
  return out;
}

/* ── Die Konfiguration selbst ─────────────────────────────────────────── */

export function validateDeployment(config) {
  const findings = [];
  const melde = (code, detail) => findings.push({ code, detail });
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return [{ code: "deployment_not_an_object", detail: null }];
  }

  // Platzhalter und Geheimniswerte — ueberall, in jeder Tiefe.
  for (const [pfad, wert] of deepStrings(config)) {
    if (PLACEHOLDER_RE.test(wert)) melde("placeholder_value", { path: pfad });
    if (SECRET_LOOKING_RE.test(wert)) melde("secret_value_in_config", { path: pfad });
  }

  const req = (name, pruefung, code) => {
    const wert = config[name];
    if (wert === undefined || wert === null || wert === "") { melde("missing_field", { field: name }); return false; }
    if (pruefung && !pruefung(wert)) { melde(code || "invalid_field", { field: name }); return false; }
    return true;
  };

  req("projectId", (v) => /^[a-z][a-z0-9-]{5,29}$/.test(v));
  req("region", (v) => /^[a-z]+-[a-z]+[0-9]$/.test(v));
  req("tenant", (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v));
  req("policyVersion", (v) => /^[A-Za-z0-9._-]{1,32}$/.test(v));
  req("monitorStartLocalDate", (v) => LOCAL_DATE_RE.test(v));
  if (req("image", (v) => typeof v === "string" && v.length > 0) && !DIGEST_RE.test(String(config.image))) {
    melde("image_without_digest", { hint: "Ein beweglicher Tag ist nicht zulaessig." });
  }

  // Betriebsart und Freigabetore
  const mode = config.runtimeMode ?? "dry_run";
  if (!["dry_run", "shadow", "live"].includes(mode)) melde("invalid_runtime_mode", { mode: String(mode) });
  const gates = config.activationGates;
  let gatesComplete = false;
  if (gates === null || typeof gates !== "object" || Array.isArray(gates)) {
    melde("activation_gates_missing", null);
  } else {
    const fehlend = ACTIVATION_GATES.filter((g) => !Object.hasOwn(gates, g));
    if (fehlend.length) melde("activation_gates_incomplete", { missing: fehlend });
    const offen = ACTIVATION_GATES.filter((g) => {
      const e = gates[g];
      return !(e && e.passed === true && typeof e.ref === "string" && e.ref.length >= 4);
    });
    gatesComplete = fehlend.length === 0 && offen.length === 0;
    if (mode === "live" && offen.length) melde("live_without_activation_gates", { open: offen });
  }
  if (mode === "live" && config.allowExternalEffects !== true) melde("live_without_explicit_permission", null);
  if (mode !== "live" && config.allowExternalEffects === true) melde("external_effects_without_live", { mode });

  // Geheimnisse: nur Namen
  const secrets = config.secrets;
  if (secrets === null || typeof secrets !== "object") melde("secrets_section_missing", null);
  else {
    for (const feld of ["toolCredentialSecretId", "costPolicySecretId"]) {
      const wert = secrets[feld];
      if (typeof wert !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(wert)) melde("secret_reference_invalid", { field: feld });
    }
    if (secrets.version !== undefined && !/^(latest|[0-9]{1,9})$/.test(String(secrets.version))) melde("secret_version_invalid", null);
    for (const [k, v] of Object.entries(secrets)) {
      if (typeof v === "string" && v.length > 255) melde("secret_value_in_config", { path: `secrets.${k}` });
    }
  }

  // Dienstkonten: sieben, verschieden, im selben Projekt
  const sas = config.serviceAccounts;
  if (sas === null || typeof sas !== "object") melde("service_accounts_missing", null);
  else {
    const gesehen = new Map();
    for (const key of EXPECTED.serviceAccountKeys) {
      const wert = sas[key];
      const treffer = typeof wert === "string" ? SA_RE.exec(wert) : null;
      if (!treffer) { melde("service_account_invalid", { key }); continue; }
      if (config.projectId && treffer[1] !== config.projectId) melde("service_account_foreign_project", { key });
      if (gesehen.has(wert)) melde("service_account_shared", { keys: [gesehen.get(wert), key] });
      gesehen.set(wert, key);
    }
    for (const key of Object.keys(sas)) {
      if (!EXPECTED.serviceAccountKeys.includes(key)) melde("service_account_unexpected", { key });
    }
  }

  // Routen: je eine eigene Kennung und genau ein zugelassenes Konto
  const endpoints = config.endpoints;
  if (endpoints === null || typeof endpoints !== "object") melde("endpoints_missing", null);
  else {
    const kennungen = new Set();
    for (const [key, erwartet] of Object.entries(EXPECTED.endpoints)) {
      const eintrag = endpoints[key];
      if (eintrag === null || typeof eintrag !== "object") { melde("endpoint_missing", { endpoint: key }); continue; }
      if (typeof eintrag.audience !== "string" || !HTTPS_RE.test(eintrag.audience)) melde("endpoint_audience_invalid", { endpoint: key });
      else {
        if (!eintrag.audience.endsWith(erwartet.path)) melde("endpoint_audience_path_mismatch", { endpoint: key, expected: erwartet.path });
        if (kennungen.has(eintrag.audience)) melde("endpoint_audience_shared", { endpoint: key });
        kennungen.add(eintrag.audience);
      }
      const konten = eintrag.allowedServiceAccounts;
      if (!Array.isArray(konten) || konten.length !== 1) melde("endpoint_caller_not_single", { endpoint: key });
      else if (sas && konten[0] !== sas[erwartet.caller]) melde("endpoint_caller_mismatch", { endpoint: key, expected: erwartet.caller });
    }
    for (const key of Object.keys(endpoints)) {
      if (!Object.hasOwn(EXPECTED.endpoints, key)) melde("endpoint_unexpected", { endpoint: key });
    }
  }

  // Warteschlange
  const queue = config.tasksQueue;
  const queueTreffer = typeof queue === "string" ? QUEUE_RE.exec(queue) : null;
  if (!queueTreffer) melde("tasks_queue_invalid", null);
  else {
    if (config.projectId && queueTreffer[1] !== config.projectId) melde("tasks_queue_foreign_project", null);
    if (config.region && queueTreffer[2] !== config.region) melde("tasks_queue_foreign_region", null);
  }

  // Zeitplaene
  const jobs = config.schedulerJobs;
  if (!Array.isArray(jobs)) melde("scheduler_jobs_missing", null);
  else {
    const nachName = new Map();
    for (const job of jobs) {
      if (job === null || typeof job !== "object" || typeof job.key !== "string") { melde("scheduler_job_shape", null); continue; }
      if (nachName.has(job.key)) melde("scheduler_job_duplicate", { key: job.key });
      nachName.set(job.key, job);
      if (job.timeZone !== EXPECTED.timeZone) melde("scheduler_job_timezone", { key: job.key, timeZone: String(job.timeZone) });
      const frist = String(job.attemptDeadline ?? "");
      const sekunden = /^([0-9]+)s$/.exec(frist);
      if (!sekunden || Number(sekunden[1]) < 15 || Number(sekunden[1]) > 1800) melde("scheduler_attempt_deadline", { key: job.key });
      // Nichts feuert, solange die Freigabetore offen sind.
      if (job.paused !== true && !(gatesComplete && mode === "live")) melde("scheduler_job_not_paused", { key: job.key });
      if (sas && job.oidcServiceAccount && !Object.values(sas).includes(job.oidcServiceAccount)) {
        melde("scheduler_job_unknown_caller", { key: job.key });
      }
    }
    // Genau vier Hauptlaeufe — kein fuenfter.
    const hauptlaeufe = jobs.filter((j) => j && j.targetPath === "/v3/slot/start");
    if (hauptlaeufe.length !== 4) melde("main_run_count", { found: hauptlaeufe.length, expected: 4 });
    for (const [key, cron] of Object.entries(EXPECTED.slotJobs)) {
      const job = nachName.get(key);
      if (!job) { melde("slot_job_missing", { key }); continue; }
      if (job.schedule !== cron) melde("slot_job_schedule", { key, expected: cron, found: String(job.schedule) });
      if (job.targetPath !== "/v3/slot/start") melde("slot_job_target", { key });
      if (sas && job.oidcServiceAccount !== sas.schedulerStart) melde("slot_job_caller", { key });
    }
    for (const [key, erwartet] of Object.entries(EXPECTED.supportJobs)) {
      const job = nachName.get(key);
      if (!job) { melde("support_job_missing", { key }); continue; }
      if (job.schedule !== erwartet.schedule) melde("support_job_schedule", { key, expected: erwartet.schedule });
      if (job.targetPath !== erwartet.path) melde("support_job_target", { key });
      if (sas && job.oidcServiceAccount !== sas[erwartet.caller]) melde("support_job_caller", { key });
    }
    // Der Watchdog muss ein anderes Konto und einen anderen Takt haben als
    // der Monitor — sonst faellt er mit ihm zusammen aus.
    const monitorJob = nachName.get("monitor-tick");
    const watchdogJob = nachName.get("watchdog");
    if (monitorJob && watchdogJob) {
      if (monitorJob.oidcServiceAccount === watchdogJob.oidcServiceAccount) melde("watchdog_shares_identity", null);
      if (monitorJob.schedule === watchdogJob.schedule) melde("watchdog_shares_schedule", null);
      if (String(watchdogJob.targetPath).startsWith("/v3/monitor/")) melde("watchdog_calls_monitor", null);
    }
  }

  return findings;
}

/* ── Die Terraform-Dateien ────────────────────────────────────────────── */

export function validateIacDirectory(dir) {
  const findings = [];
  const melde = (code, detail) => findings.push({ code, detail });
  let dateien;
  try {
    dateien = readdirSync(dir).filter((f) => f.endsWith(".tf"));
  } catch {
    return [{ code: "iac_directory_unreadable", detail: { dir } }];
  }
  if (!dateien.length) return [{ code: "iac_directory_empty", detail: { dir } }];

  const deklariert = new Set();
  const benutzt = new Map();
  for (const datei of dateien) {
    const text = readFileSync(join(dir, datei), "utf8");
    for (const verboten of EXPECTED.forbiddenInIac) {
      // Erwaehnungen in Kommentaren zaehlen nicht — nur echter Code.
      const zeilen = text.split("\n").filter((z) => !z.trim().startsWith("#") && z.includes(verboten));
      if (zeilen.length) melde("forbidden_iac_construct", { file: datei, construct: verboten });
    }
    if (SECRET_LOOKING_RE.test(text)) melde("secret_value_in_iac", { file: datei });
    for (const treffer of text.matchAll(/variable\s+"([A-Za-z0-9_]+)"/g)) deklariert.add(treffer[1]);
    for (const treffer of text.matchAll(/\bvar\.([A-Za-z0-9_]+)/g)) {
      if (!benutzt.has(treffer[1])) benutzt.set(treffer[1], datei);
    }
  }
  for (const [name, datei] of benutzt) {
    if (!deklariert.has(name)) melde("undeclared_variable", { variable: name, file: datei });
  }
  const scheduler = existsSync(join(dir, "scheduler.tf")) ? readFileSync(join(dir, "scheduler.tf"), "utf8") : "";
  const jobs = [...scheduler.matchAll(/resource\s+"google_cloud_scheduler_job"/g)].length;
  const pausiert = [...scheduler.matchAll(/^\s*paused\s*=\s*true\s*$/gm)].length;
  if (jobs === 0) melde("no_scheduler_jobs", null);
  if (pausiert < jobs) melde("scheduler_job_not_paused_in_iac", { jobs, paused: pausiert });
  return findings;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

export function runValidation({ configPath, iacDir }) {
  const findings = [];
  if (!existsSync(configPath)) {
    findings.push({ code: "deployment_config_missing", detail: { path: configPath } });
  } else {
    let raw;
    try { raw = readFileSync(configPath, "utf8"); } catch { raw = null; }
    if (raw === null || !raw.trim()) findings.push({ code: "deployment_config_unreadable", detail: { path: configPath } });
    else {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { findings.push({ code: "deployment_config_not_json", detail: { path: configPath } }); }
      if (parsed !== null) findings.push(...validateDeployment(parsed));
    }
  }
  findings.push(...validateIacDirectory(iacDir));
  return findings;
}

function istDirekterAufruf() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (istDirekterAufruf()) {
  const configPath = resolve(process.argv[2] || join(HIER, "deployment.json"));
  const findings = runValidation({ configPath, iacDir: HIER });
  if (!findings.length) {
    process.stdout.write("quantus-v3 infra: keine Beanstandung.\nHinweis: das ist KEIN terraform plan und kein Nachweis ueber die echte Cloud.\n");
    process.exit(0);
  }
  process.stderr.write(`quantus-v3 infra: ${findings.length} Beanstandung(en) — es wird nichts angewendet.\n`);
  for (const f of findings) {
    process.stderr.write(`  · ${f.code}${f.detail ? ` ${JSON.stringify(f.detail)}` : ""}\n`);
  }
  process.exit(1);
}
