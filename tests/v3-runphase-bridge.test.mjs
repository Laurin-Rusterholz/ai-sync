/*
 * Runphasen-Bruecke — Vorbereitung, KEINE aktivierte Funktion (25.09.2026).
 * ---------------------------------------------------------------------------
 * Rechercheergebnis (PR268): ensureRun/ensureStartNote/closeRun sind laut
 * COMMAND_SCHEMAS ausschliesslich fuer die Akteure agent/system autorisiert.
 * Es gibt dafuer aber schon einen unveraenderten, produktiv genutzten Weg:
 * die C2-Verb-Schicht kennt Dienst-Zugangsdaten-Rollen — "backend_checker"
 * darf u. a. run.checkpoint und run.finalize aufrufen, ueber denselben
 * QUANTUS_V3_SERVICE_CREDENTIALS-Mechanismus wie die bestehende geplante
 * Automatisierung. Der App-Besitzer hat ausdruecklich NUR eine vorbereitete
 * Code-Bruecke verlangt — KEINE neue Dienstberechtigung provisionieren.
 *
 * Diese Tests pruefen zwei getrennte Dinge:
 *   1. Das clientseitige Verhalten (dbV3RunPhaseCommand & Co, aus
 *      public/index.html extrahiert): kein Zugangsschluessel -> kein
 *      Netzwerkaufruf, ehrliche Meldung; Laufversion nicht lesbar -> kein
 *      Ingest-Aufruf, kein Ratewert; ein Server, der "geprueft, aber nicht
 *      geschrieben" meldet (applied:false, weil QUANTUS_V3_API_WRITES/MODE
 *      serverseitig aus sind), wird NICHT als Erfolg verkauft; nur ein
 *      echtes { ok:true, applied:true } loest syncFreshness() aus.
 *   2. Dass der von diesem Client gesendete Befehlsumschlag die ECHTE,
 *      unveraenderte Serverpruefung besteht (netlify/lib/
 *      quantus-v3-command-envelope.mjs, direkt importiert — keine Attrappe).
 *      Das beweist Vertragskonformitaet, ohne einen echten Server zu brauchen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommandEnvelope } from "../netlify/lib/quantus-v3-command-envelope.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (bedingung, text) => { assert.ok(bedingung, text); checks++; };
const eq = (a, b, text) => { assert.equal(a, b, text); checks++; };

function funktion(kopfzeile) {
  const a = index.indexOf(kopfzeile);
  ok(a > 0, `nicht gefunden: ${kopfzeile}`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}

// ── 1. Der echte Umschlag, den run.checkpoint/run.finalize senden wuerden,
//      besteht die ECHTE, unveraenderte Serverpruefung ──────────────────────
{
  const checkpointCommand = {
    schemaVersion: 3, verb: "run.checkpoint", jobId: "run_2026-09-25",
    expectedEntityVersion: 7, payload: { stage: "cu-manual-checkpoint", note: "Testlauf" },
  };
  const r1 = parseCommandEnvelope(checkpointCommand);
  ok(r1.ok, `run.checkpoint-Umschlag besteht die echte Serverpruefung nicht: ${JSON.stringify(r1)}`);

  const checkpointOhneNotiz = {
    schemaVersion: 3, verb: "run.checkpoint", jobId: "run_2026-09-25",
    expectedEntityVersion: 0, payload: { stage: "cu-manual-checkpoint" },
  };
  ok(parseCommandEnvelope(checkpointOhneNotiz).ok, "run.checkpoint ohne Notiz (note ist optional) wird abgelehnt");

  const finalizeCommand = {
    schemaVersion: 3, verb: "run.finalize", jobId: "run_2026-09-25",
    expectedEntityVersion: 3, payload: { outcome: "complete" },
  };
  const r2 = parseCommandEnvelope(finalizeCommand);
  ok(r2.ok, `run.finalize-Umschlag besteht die echte Serverpruefung nicht: ${JSON.stringify(r2)}`);
}

// ── 2. Der clientseitige Aufbau (echte Funktionen, gegen Attrappen) ─────────
const FETCH_TIMEOUT = funktion("async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {");
const VERSION_FN = funktion("async function dbV3RunPhaseFetchVersion(jobId, token) {");
const COMMAND_FN = funktion("async function dbV3RunPhaseCommand(verb, jobId, payload, statusEl) {");

function harness({ fetchImpl, settings = {}, syncFreshnessSpy = null } = {}) {
  const APP = { state: { settings: { v3RunPhaseAuthToken: "", ...settings } } };
  const calls = { syncFreshness: [] };
  const fn = new Function(
    "APP", "fetch", "sanitizeApiKey", "esc", "syncFreshness", "AbortController", "setTimeout", "clearTimeout",
    FETCH_TIMEOUT + "\n" + VERSION_FN + "\n" + COMMAND_FN +
      "\nreturn { dbV3RunPhaseFetchVersion, dbV3RunPhaseCommand };",
  )(
    APP, fetchImpl, (v) => String(v || "").trim(), (s) => String(s == null ? "" : s),
    async (reason) => { calls.syncFreshness.push(reason); if (syncFreshnessSpy) return syncFreshnessSpy(reason); },
    typeof AbortController !== "undefined" ? AbortController : undefined, setTimeout, clearTimeout,
  );
  return { APP, calls, ...fn };
}
function statusStub() { const el = { html: "" }; Object.defineProperty(el, "innerHTML", { get: () => el.html, set: (v) => { el.html = v; } }); return el; }

// ── 2a. Kein Zugangsschluessel -> kein Netzwerkaufruf, ehrliche Meldung ─────
{
  let fetchCalls = 0;
  const h = harness({ fetchImpl: async () => { fetchCalls++; throw new Error("darf nicht aufgerufen werden"); } });
  const statusEl = statusStub();
  const res = await h.dbV3RunPhaseCommand("run.checkpoint", "run_2026-09-25", { stage: "x" }, statusEl);
  eq(res.ok, false, "ohne Zugangsschluessel meldet dbV3RunPhaseCommand faelschlich Erfolg");
  eq(fetchCalls, 0, "ohne Zugangsschluessel wird trotzdem ein Netzwerkaufruf ausgeloest");
  ok(/Zugangsschlüssel/.test(statusEl.innerHTML), "die fehlende Zugangsschluessel-Meldung fehlt");
}

// ── 2b. Laufversion nicht lesbar (kein entityVersions[jobId]) -> kein
//        Ingest-Aufruf, kein Ratewert (z. B. faelschlich 0) ─────────────────
{
  let ingestCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("quantus-context")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, entityVersions: {} }) }; // KEINE Version fuer den Job
    }
    ingestCalls++;
    return { ok: true, status: 200, json: async () => ({ ok: true, applied: true }) };
  };
  const h = harness({ fetchImpl, settings: { v3RunPhaseAuthToken: "geheim" } });
  const statusEl = statusStub();
  const res = await h.dbV3RunPhaseCommand("run.checkpoint", "run_2026-09-25", { stage: "x" }, statusEl);
  eq(res.ok, false, "ohne lesbare Laufversion meldet dbV3RunPhaseCommand faelschlich Erfolg");
  eq(ingestCalls, 0, "ohne lesbare Laufversion wird trotzdem ein Schreibversuch unternommen");
  ok(/Laufversion/.test(statusEl.innerHTML), "die Laufversion-nicht-lesbar-Meldung fehlt");
}

// ── 2c. Server meldet ok:true, applied:false (Schreiben serverseitig aus) —
//        das ist KEIN Erfolg, syncFreshness darf nicht laufen ──────────────
{
  const fetchImpl = async (url) => {
    if (String(url).includes("quantus-context")) return { ok: true, status: 200, json: async () => ({ ok: true, entityVersions: { "run_2026-09-25": 4 } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, applied: false }) };
  };
  const h = harness({ fetchImpl, settings: { v3RunPhaseAuthToken: "geheim" } });
  const statusEl = statusStub();
  const res = await h.dbV3RunPhaseCommand("run.checkpoint", "run_2026-09-25", { stage: "x" }, statusEl);
  eq(res.applied, false, "applied:false vom Server wird als applied:true durchgereicht");
  eq(h.calls.syncFreshness.length, 0, "obwohl applied:false, wird syncFreshness() trotzdem angestossen");
  ok(!/✅/.test(statusEl.innerHTML), "applied:false wird trotzdem mit dem Erfolgs-Haekchen angezeigt");
}

// ── 2d. Echter Erfolg: korrekter Umschlag, syncFreshness laeuft ─────────────
{
  let gesendet = null;
  const fetchImpl = async (url, opts) => {
    if (String(url).includes("quantus-context")) return { ok: true, status: 200, json: async () => ({ ok: true, entityVersions: { "run_2026-09-25": 9 } }) };
    gesendet = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, applied: true }) };
  };
  const h = harness({ fetchImpl, settings: { v3RunPhaseAuthToken: "geheim-token" } });
  const statusEl = statusStub();
  const res = await h.dbV3RunPhaseCommand("run.finalize", "run_2026-09-25", { outcome: "complete" }, statusEl);
  eq(res.applied, true, "ein echter Erfolg wird nicht als applied:true gemeldet");
  eq(h.calls.syncFreshness.length, 1, "nach echtem Erfolg laeuft syncFreshness() nicht genau einmal");
  ok(gesendet.opts.headers.Authorization === "Bearer geheim-token", "der Zugangsschluessel wird nicht als Bearer-Token gesendet");
  ok(!!gesendet.opts.headers["Idempotency-Key"], "es wird kein Idempotency-Key mitgeschickt");
  eq(gesendet.body.schemaVersion, 3, "schemaVersion fehlt/weicht ab");
  eq(gesendet.body.verb, "run.finalize", "verb fehlt/weicht ab");
  eq(gesendet.body.jobId, "run_2026-09-25", "jobId fehlt/weicht ab");
  eq(gesendet.body.expectedEntityVersion, 9, "expectedEntityVersion kommt nicht aus dem Lesevorgang");
  // Der tatsaechlich gesendete Umschlag besteht die ECHTE Serverpruefung.
  ok(parseCommandEnvelope(gesendet.body).ok, "der tatsaechlich gesendete Umschlag besteht die echte Serverpruefung nicht");
}

// ── 3. Die Buttons rufen echte, existierende Funktionen auf ─────────────────
{
  ok(/window\.dbV3RunCheckpoint = dbV3RunCheckpoint;/.test(index), "dbV3RunCheckpoint haengt nicht an window — der Knopf liefe ins Leere");
  ok(/window\.dbV3RunFinalize = dbV3RunFinalize;/.test(index), "dbV3RunFinalize haengt nicht an window — der Knopf liefe ins Leere");
  ok(/onclick="dbV3RunCheckpoint\(\)"/.test(index), "der Checkpoint-Knopf ruft die Funktion nicht auf");
  ok(/onclick="dbV3RunFinalize\(\)"/.test(index), "der Abschliessen-Knopf ruft die Funktion nicht auf");
}

console.log(`v3-runphase-bridge: ok (${checks} Pruefungen)`);
