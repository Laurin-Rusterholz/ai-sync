/* ══ Paket E2 — die Infrastrukturpruefung ═════════════════════════════════
 *
 * Geprueft wird die echte CLI gegen echte Dateien: ein unkonfiguriertes
 * Deployment muss verweigert werden, ein Platzhalter ebenso, ein
 * Geheimniswert ebenso, ein fuenfter Hauptauftrag ebenso.
 *
 * Es wird nichts angewendet, kein Terraform aufgerufen, keine API
 * angesprochen. Alle Projekt- und Kontonamen in dieser Datei sind
 * synthetisch.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateDeployment, validateIacDirectory, runValidation, EXPECTED, ACTIVATION_GATES,
} from "../infra/quantus-v3/validate.mjs";

const INFRA = join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "quantus-v3");
const PROJEKT = "quantus-test-invalid";
const REGION = "europe-west6";
const sa = (name) => `${name}@${PROJEKT}.iam.gserviceaccount.com`;
const WORKER = "https://quantus-v3-worker-abc.a.run.app";
const MONITOR = "https://quantus-v3-monitor-abc.a.run.app";
const WATCHDOG = "https://quantus-v3-watchdog-abc.a.run.app";

const codes = (findings) => findings.map((f) => f.code);

function gutesDeployment(over = {}) {
  const konten = {
    worker: sa("quantus-v3-worker"),
    monitor: sa("quantus-v3-monitor"),
    watchdog: sa("quantus-v3-watchdog"),
    schedulerStart: sa("quantus-v3-sched-start"),
    schedulerMonitor: sa("quantus-v3-sched-monitor"),
    schedulerWatchdog: sa("quantus-v3-sched-watchdog"),
    tasks: sa("quantus-v3-tasks"),
  };
  return {
    projectId: PROJEKT,
    region: REGION,
    tenant: "quantus",
    policyVersion: "3.0",
    monitorStartLocalDate: "2026-09-19",
    image: "europe-west6-docker.pkg.dev/quantus-test-invalid/runtime/quantus-v3@sha256:" + "a".repeat(64),
    runtimeMode: "dry_run",
    allowExternalEffects: false,
    activationGates: Object.fromEntries(ACTIVATION_GATES.map((g) => [g, { passed: false, ref: "" }])),
    secrets: { toolCredentialSecretId: "quantus-v3-tool-credential", costPolicySecretId: "quantus-v3-cost-policy", version: "latest" },
    serviceAccounts: konten,
    endpoints: {
      "slot.start": { audience: `${WORKER}/v3/slot/start`, allowedServiceAccounts: [konten.schedulerStart] },
      "run.continue": { audience: `${WORKER}/v3/run/continue`, allowedServiceAccounts: [konten.tasks] },
      "monitor.tick": { audience: `${MONITOR}/v3/monitor/tick`, allowedServiceAccounts: [konten.schedulerMonitor] },
      "monitor.preflight": { audience: `${MONITOR}/v3/monitor/preflight`, allowedServiceAccounts: [konten.schedulerMonitor] },
      "watchdog.check": { audience: `${WATCHDOG}/v3/watchdog/check`, allowedServiceAccounts: [konten.schedulerWatchdog] },
    },
    tasksQueue: `projects/${PROJEKT}/locations/${REGION}/queues/quantus-v3-continuations`,
    schedulerJobs: [
      { key: "slot-briefing04", schedule: "0 4 * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "100s", targetPath: "/v3/slot/start", oidcServiceAccount: konten.schedulerStart },
      { key: "slot-process09", schedule: "0 9 * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "100s", targetPath: "/v3/slot/start", oidcServiceAccount: konten.schedulerStart },
      { key: "slot-continue14", schedule: "0 14 * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "100s", targetPath: "/v3/slot/start", oidcServiceAccount: konten.schedulerStart },
      { key: "slot-close23", schedule: "0 23 * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "100s", targetPath: "/v3/slot/start", oidcServiceAccount: konten.schedulerStart },
      { key: "monitor-tick", schedule: "*/5 * * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "60s", targetPath: "/v3/monitor/tick", oidcServiceAccount: konten.schedulerMonitor },
      { key: "monitor-preflight", schedule: "30 22 * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "60s", targetPath: "/v3/monitor/preflight", oidcServiceAccount: konten.schedulerMonitor },
      { key: "watchdog", schedule: "7-59/15 * * * *", timeZone: "Europe/Zurich", paused: true, attemptDeadline: "60s", targetPath: "/v3/watchdog/check", oidcServiceAccount: konten.schedulerWatchdog },
    ],
    ...over,
  };
}

test("ein vollstaendiges, pausiertes dry_run-Deployment ist beanstandungsfrei", () => {
  assert.deepEqual(validateDeployment(gutesDeployment()), []);
});

test("ohne Konfigurationsdatei wird ausdruecklich verweigert", () => {
  const leer = mkdtempSync(join(tmpdir(), "quantus-infra-"));
  const findings = runValidation({ configPath: join(leer, "deployment.json"), iacDir: INFRA });
  assert.ok(codes(findings).includes("deployment_config_missing"));
  // Eine leere oder kaputte Datei ebenfalls.
  const kaputt = join(leer, "kaputt.json");
  writeFileSync(kaputt, "{ das ist kein json");
  assert.ok(codes(runValidation({ configPath: kaputt, iacDir: INFRA })).includes("deployment_config_not_json"));
  writeFileSync(kaputt, "   ");
  assert.ok(codes(runValidation({ configPath: kaputt, iacDir: INFRA })).includes("deployment_config_unreadable"));
});

test("die mitgelieferte Beispieldatei ist absichtlich unbrauchbar", () => {
  const beispiel = readFileSync(join(INFRA, "terraform.tfvars.example"), "utf8");
  assert.match(beispiel, /REPLACE/);
  // Und sie enthaelt kein Geheimnis.
  assert.doesNotMatch(beispiel, /-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\./);
  // Gegenprobe: dieselben Platzhalter in einer Konfiguration werden erkannt.
  const mitPlatzhalter = gutesDeployment({ projectId: "replace-me-project" });
  assert.ok(codes(validateDeployment(mitPlatzhalter)).includes("placeholder_value"));
});

test("ein Geheimniswert in der Konfiguration wird erkannt, egal wo", () => {
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(30)}.${"b".repeat(30)}`;
  for (const over of [
    { secrets: { toolCredentialSecretId: jwt, costPolicySecretId: "quantus-v3-cost-policy" } },
    { tenant: "quantus", notizen: { hinweis: "-----BEGIN PRIVATE KEY-----" } },
  ]) {
    assert.ok(codes(validateDeployment(gutesDeployment(over))).includes("secret_value_in_config"), JSON.stringify(over).slice(0, 60));
  }
  // Ein Secret-NAME ist dagegen in Ordnung.
  assert.deepEqual(validateDeployment(gutesDeployment()), []);
});

test("ein bewegliches Abbild ohne Digest wird abgelehnt", () => {
  assert.ok(codes(validateDeployment(gutesDeployment({ image: "europe-west6-docker.pkg.dev/p/r/i:latest" }))).includes("image_without_digest"));
});

test("live gibt es nur mit allen Toren UND ausdruecklicher Erlaubnis", () => {
  const halb = gutesDeployment({ runtimeMode: "live", allowExternalEffects: true });
  const f = codes(validateDeployment(halb));
  assert.ok(f.includes("live_without_activation_gates"));

  const alleTore = Object.fromEntries(ACTIVATION_GATES.map((g) => [g, { passed: true, ref: `SYNTHETIC-${g}` }]));
  const ohneErlaubnis = gutesDeployment({ runtimeMode: "live", activationGates: alleTore, allowExternalEffects: false });
  assert.ok(codes(validateDeployment(ohneErlaubnis)).includes("live_without_explicit_permission"));

  const dryRunMitWirkung = gutesDeployment({ allowExternalEffects: true });
  assert.ok(codes(validateDeployment(dryRunMitWirkung)).includes("external_effects_without_live"));

  // Vollstaendig freigegeben: dann duerfen die Jobs auch laufen.
  const fertig = gutesDeployment({
    runtimeMode: "live", activationGates: alleTore, allowExternalEffects: true,
    schedulerJobs: gutesDeployment().schedulerJobs.map((j) => ({ ...j, paused: false })),
  });
  assert.deepEqual(validateDeployment(fertig), []);
});

test("solange ein Tor offen ist, muss jeder Zeitplan pausiert sein", () => {
  const laufend = gutesDeployment({
    schedulerJobs: gutesDeployment().schedulerJobs.map((j) => (j.key === "slot-close23" ? { ...j, paused: false } : j)),
  });
  const f = validateDeployment(laufend);
  assert.deepEqual(codes(f), ["scheduler_job_not_paused"]);
  assert.equal(f[0].detail.key, "slot-close23");
});

test("es gibt genau vier Hauptlaeufe — ein fuenfter faellt auf", () => {
  const fuenf = gutesDeployment();
  fuenf.schedulerJobs.push({
    key: "slot-extra1830", schedule: "30 18 * * *", timeZone: "Europe/Zurich", paused: true,
    attemptDeadline: "100s", targetPath: "/v3/slot/start", oidcServiceAccount: sa("quantus-v3-sched-start"),
  });
  const f = codes(validateDeployment(fuenf));
  assert.ok(f.includes("main_run_count"));

  // Auch ein fehlender Hauptlauf faellt auf.
  const drei = gutesDeployment({ schedulerJobs: gutesDeployment().schedulerJobs.filter((j) => j.key !== "slot-close23") });
  const g = codes(validateDeployment(drei));
  assert.ok(g.includes("main_run_count") && g.includes("slot_job_missing"));
});

test("die vier Slotzeiten und die Zeitzone sind festgeschrieben", () => {
  const verschoben = gutesDeployment({
    schedulerJobs: gutesDeployment().schedulerJobs.map((j) => (j.key === "slot-process09" ? { ...j, schedule: "0 10 * * *" } : j)),
  });
  assert.ok(codes(validateDeployment(verschoben)).includes("slot_job_schedule"));

  const utc = gutesDeployment({
    schedulerJobs: gutesDeployment().schedulerJobs.map((j) => ({ ...j, timeZone: "UTC" })),
  });
  const f = validateDeployment(utc);
  assert.equal(f.filter((x) => x.code === "scheduler_job_timezone").length, 7);
});

test("jede Route hat ihr eigenes Konto und ihre eigene Kennung", () => {
  const konten = gutesDeployment().serviceAccounts;
  const geteilt = gutesDeployment();
  geteilt.endpoints["slot.start"].allowedServiceAccounts = [konten.tasks];
  assert.ok(codes(validateDeployment(geteilt)).includes("endpoint_caller_mismatch"));

  const zweiKonten = gutesDeployment();
  zweiKonten.endpoints["slot.start"].allowedServiceAccounts = [konten.schedulerStart, konten.tasks];
  assert.ok(codes(validateDeployment(zweiKonten)).includes("endpoint_caller_not_single"));

  const gleicheKennung = gutesDeployment();
  gleicheKennung.endpoints["run.continue"].audience = `${WORKER}/v3/slot/start`;
  const f = codes(validateDeployment(gleicheKennung));
  assert.ok(f.includes("endpoint_audience_shared") || f.includes("endpoint_audience_path_mismatch"));
});

test("ein Dienstkonto fuer zwei Aufgaben ist eine Beanstandung", () => {
  const konten = gutesDeployment().serviceAccounts;
  const geteilt = gutesDeployment({ serviceAccounts: { ...konten, schedulerWatchdog: konten.schedulerMonitor } });
  const f = codes(validateDeployment(geteilt));
  assert.ok(f.includes("service_account_shared"));
});

test("der Watchdog darf weder Takt noch Konto mit dem Monitor teilen und ihn nicht aufrufen", () => {
  const konten = gutesDeployment().serviceAccounts;
  const gleich = gutesDeployment({
    schedulerJobs: gutesDeployment().schedulerJobs.map((j) => (j.key === "watchdog"
      ? { ...j, schedule: "*/5 * * * *", oidcServiceAccount: konten.schedulerMonitor, targetPath: "/v3/monitor/tick" }
      : j)),
  });
  const f = codes(validateDeployment(gleich));
  assert.ok(f.includes("watchdog_shares_identity"));
  assert.ok(f.includes("watchdog_shares_schedule"));
  assert.ok(f.includes("watchdog_calls_monitor"));
});

test("die Zustellfrist bleibt im erlaubten Bereich", () => {
  for (const frist of ["5s", "3600s", "abc", ""]) {
    const j = gutesDeployment({ schedulerJobs: gutesDeployment().schedulerJobs.map((x) => ({ ...x, attemptDeadline: frist })) });
    assert.ok(codes(validateDeployment(j)).includes("scheduler_attempt_deadline"), frist);
  }
});

/* ── Die Terraform-Dateien selbst ──────────────────────────────────────── */

test("die IaC enthaelt keine Geheimnisversion, keine API-Aktivierung und keinen offenen Zugriff", () => {
  const findings = validateIacDirectory(INFRA);
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test("jede benutzte Terraform-Variable ist auch deklariert", () => {
  // validateIacDirectory prueft das; hier wird der Mechanismus selbst belegt.
  const tmp = mkdtempSync(join(tmpdir(), "quantus-iac-"));
  writeFileSync(join(tmp, "scheduler.tf"), 'resource "google_cloud_scheduler_job" "x" {\n  paused = true\n  name = var.gibt_es_nicht\n}\n');
  const f = codes(validateIacDirectory(tmp));
  assert.ok(f.includes("undeclared_variable"));
});

test("ein nicht pausierter Zeitplan in der IaC faellt auf", () => {
  const tmp = mkdtempSync(join(tmpdir(), "quantus-iac-"));
  writeFileSync(join(tmp, "scheduler.tf"), 'resource "google_cloud_scheduler_job" "x" {\n  schedule = "0 4 * * *"\n}\n');
  assert.ok(codes(validateIacDirectory(tmp)).includes("scheduler_job_not_paused_in_iac"));
});

test("eine Geheimnisversion oder ein offener Zugriff in der IaC faellt auf", () => {
  const tmp = mkdtempSync(join(tmpdir(), "quantus-iac-"));
  writeFileSync(join(tmp, "scheduler.tf"), 'resource "google_cloud_scheduler_job" "x" {\n  paused = true\n}\n');
  writeFileSync(join(tmp, "boese.tf"), [
    'resource "google_secret_manager_secret_version" "v" { secret_data = "geheim" }',
    'resource "google_cloud_run_v2_service_iam_member" "offen" { member = "allUsers" }',
    'resource "google_project_service" "api" { service = "run.googleapis.com" }',
  ].join("\n"));
  const f = codes(validateIacDirectory(tmp));
  assert.equal(f.filter((c) => c === "forbidden_iac_construct").length, 3);
});

/* ── Manifest und Validator muessen dasselbe sagen ─────────────────────── */

test("das Manifest beschreibt genau das, was der Validator verlangt", () => {
  const manifest = JSON.parse(readFileSync(join(INFRA, "manifest.json"), "utf8"));
  assert.equal(manifest.deployed, false);
  assert.deepEqual(manifest.activationGates, [...ACTIVATION_GATES]);
  assert.deepEqual(manifest.forbiddenInIac.sort(), [...EXPECTED.forbiddenInIac].sort());
  assert.deepEqual(
    manifest.serviceAccounts.map((s) => s.key).sort(),
    [...EXPECTED.serviceAccountKeys].sort(),
  );
  const hauptlaeufe = manifest.schedulerJobs.filter((j) => j.mainRun);
  assert.equal(hauptlaeufe.length, 4, "genau vier Hauptlaeufe im Manifest");
  for (const job of manifest.schedulerJobs) {
    assert.equal(job.timeZone, EXPECTED.timeZone, job.key);
    const erwartet = EXPECTED.slotJobs[job.key] ?? EXPECTED.supportJobs[job.key]?.schedule;
    assert.equal(job.schedule, erwartet, job.key);
  }
  const routen = manifest.services.flatMap((s) => s.routes).sort();
  assert.deepEqual(routen, Object.values(EXPECTED.endpoints).map((e) => e.path).sort());
});

test("es gibt keine eingecheckte deployment.json", () => {
  assert.equal(existsSync(join(INFRA, "deployment.json")), false,
    "eine echte Deployment-Konfiguration gehoert nicht ins Repository");
});
