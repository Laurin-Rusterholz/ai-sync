/* ══ E2 — echte Portanbindungen, soweit ohne Zugangsdaten moeglich ═══════
 *
 * Drei Ports, die hier wirklich gebaut sind und nicht bloss beschrieben:
 *
 *   core             der ECHTE Umschlag: `mutateAppData` aus
 *                    firebase-admin plus `prepareIdempotentCommand` /
 *                    `applyIdempotentCommand` aus dem Idempotenzpaket.
 *                    Beide Module gehoeren der Integration; dieses Paket
 *                    IMPORTIERT sie nur und aendert nichts daran. Fehlt
 *                    eines, bleibt der Port leer und nennt den Grund —
 *                    es wird nichts nachgebaut.
 *   tasks            baut die vollstaendige Cloud-Tasks-Anfrage
 *                    (`projects.locations.queues.tasks.create`) samt
 *                    stabilem Namen, OIDC-Angabe und Zustellfrist und
 *                    gibt sie einem Transport. Der Transport braucht
 *                    Zugangsdaten — die Anfrage selbst nicht, und genau
 *                    die ist hier geprueft.
 *   closureEvidence  komponiert ZWEI echte Leseantworten zu einem
 *                    Nachweis: `status.run` (Dienst-Zugangsdatum,
 *                    `state`/`blocked`/`openQuestions` aus Paket B) UND
 *                    `context.run` (laufgebundenes Job-Token, `sources`
 *                    je gefuehrter Quelle). Fehlt eine Seite — Werkzeug
 *                    abgeschaltet, Token-Aussteller nicht konfiguriert,
 *                    Transport fehlt —, bleibt der jeweilige Teil leer,
 *                    nie erfunden; siehe die ausfuehrliche Begruendung
 *                    weiter unten.
 *
 * Kein Port erfindet einen Erfolg. Wo eine Abhaengigkeit fehlt, ist die
 * Antwort `unavailablePort` mit Grund — und die Route antwortet mit 503.
 * ═════════════════════════════════════════════════════════════════════════ */
import { availablePort, unavailablePort } from "./ports.mjs";
import { HttpError } from "./errors.mjs";
import { taskName } from "./task-names.mjs";
import { runIdForRunKey, statusScopeIdForRunKey } from "./run-ids.mjs";

/* ── Kern: der echte CAS-/Idempotenzumschlag ──────────────────────────── */

export const DEFAULT_CORE_KEY = "app-data.json";

async function ladeUmschlag() {
  // Dynamisch, damit ein fehlendes Modul ein SAUBERER 503 wird statt
  // eines Absturzes beim Laden des Dienstes.
  const admin = await import("../../../netlify/lib/firebase-admin.mjs");
  const idem = await import("../../../netlify/lib/quantus-v3-idempotency.mjs");
  return { admin, idem };
}

/* Gilt fuer JEDEN Weg — auch fuer einen eingehaengten. Ein Umschlag, dem
 * eine Ausfuhr fehlt, wird benannt und nicht geraten. */
function pruefeUmschlag(module) {
  if (!module || typeof module !== "object") throw kennzeichne("missing_export:module");
  const { admin, idem } = module;
  for (const [modul, namen] of [
    [admin, ["mutateAppData", "readAppDataDocument"]],
    [idem, ["prepareIdempotentCommand", "applyIdempotentCommand"]],
  ]) {
    for (const name of namen) {
      if (!modul || typeof modul[name] !== "function") throw kennzeichne(`missing_export:${name}`);
    }
  }
  return module;
}

function kennzeichne(nachricht) {
  const fehler = new Error(nachricht);
  fehler.code = "missing_export";
  return fehler;
}

function isoAus(now) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new HttpError(500, "server_clock_invalid");
  return new Date(now).toISOString();
}

/**
 * @param options.tenantId     verifizierter Mandant (nicht aus einem Rumpf)
 * @param options.principalId  verifizierte Identitaet des Laeufers
 * @param options.key          Schluessel des Kerndokuments
 * @param options.loadModules  nur fuer Tests: liefert { admin, idem }
 */
export async function createIntegrationCorePort(options = {}) {
  const { tenantId, principalId, key = DEFAULT_CORE_KEY, savedBy = "quantus-v3-runtime" } = options;
  if (typeof tenantId !== "string" || !tenantId) return unavailablePort("core", "tenant_not_configured");
  if (typeof principalId !== "string" || !principalId) return unavailablePort("core", "principal_not_configured");

  let module;
  try {
    module = pruefeUmschlag(typeof options.loadModules === "function" ? await options.loadModules() : await ladeUmschlag());
  } catch (err) {
    const grund = err && err.code === "missing_export" ? err.message : "integration_cas_envelope_not_wired";
    return unavailablePort("core", grund);
  }
  const { admin, idem } = module;

  return availablePort("core", {
    async read() {
      const stored = await admin.readAppDataDocument(key);
      const text = stored && typeof stored.data === "string" ? stored.data : null;
      if (text === null) throw new HttpError(503, "core_unavailable", { key });
      let data;
      try { data = JSON.parse(text); } catch { throw new HttpError(503, "core_invalid", { key }); }
      return { data, etag: stored.etag ?? null };
    },

    async mutate({ commandKey, requestId, now, mutate }) {
      if (typeof commandKey !== "string" || !commandKey) throw new HttpError(500, "command_key_required");
      if (typeof mutate !== "function") throw new HttpError(500, "mutator_required");
      const prepared = idem.prepareIdempotentCommand({
        tenantId, principalId, key: commandKey,
        command: { commandKey }, requestId, now: isoAus(now),
      });
      const out = await admin.mutateAppData(key, (data) => idem.applyIdempotentCommand(data, prepared, (draft) => {
        const inner = mutate(draft);
        if (!inner || typeof inner !== "object" || !Object.hasOwn(inner, "data")) {
          throw new HttpError(500, "mutation_invalid", { commandKey });
        }
        // Der Umschlag verlangt ein Ergebnisobjekt ohne seine eigenen
        // Antwortfelder; das Laufzeitergebnis bekommt deshalb ein
        // eigenes Fach.
        return { data: inner.data, result: { runtime: inner.result } };
      }), { savedBy });
      const antwort = out && out.result ? out.result : null;
      if (!antwort || typeof antwort !== "object" || !Object.hasOwn(antwort, "runtime")) {
        throw new HttpError(502, "core_response_invalid", { commandKey });
      }
      const replayed = antwort.replayed === true;
      return {
        ok: true,
        result: antwort.runtime,
        replayed,
        // Eine Wiederholung schreibt nicht. Alles andere hat geschrieben,
        // sonst waere `mutateAppData` nicht zurueckgekehrt.
        wrote: !replayed,
        dataRevision: Number.isSafeInteger(antwort.dataRevision) ? antwort.dataRevision : null,
      };
    },
  });
}

/* ── Cloud Tasks ──────────────────────────────────────────────────────── */

export const TASK_DISPATCH_DEADLINE = "100s";

/* Der Transport bekommt eine fertige Anfrage. Er braucht Zugangsdaten;
 * der Inhalt der Anfrage nicht — und der ist hier das Wesentliche. */
export function createCloudTasksPort({ transport, dispatchDeadline = TASK_DISPATCH_DEADLINE } = {}) {
  if (!transport || typeof transport.createTask !== "function") {
    return unavailablePort("tasks", "cloud_tasks_transport_not_wired");
  }
  return availablePort("tasks", {
    async enqueueContinuation({ taskId, runKey, continuationId, scheduleAtMs, queue, targetUrl, oidcServiceAccount, audience }) {
      const name = taskName(queue, taskId);   // prueft Queue-Pfad und Namen
      const body = Buffer.from(JSON.stringify({ runKey, continuationId }), "utf8").toString("base64");
      const anfrage = {
        url: `https://cloudtasks.googleapis.com/v2/${queue}/tasks`,
        method: "POST",
        payload: {
          task: {
            name,
            dispatchDeadline,
            ...(Number.isSafeInteger(scheduleAtMs) ? { scheduleTime: new Date(scheduleAtMs).toISOString() } : {}),
            httpRequest: {
              url: targetUrl,
              httpMethod: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              oidcToken: { serviceAccountEmail: oidcServiceAccount, audience: audience || targetUrl },
            },
          },
        },
      };
      const antwort = await transport.createTask(anfrage);
      if (!antwort || typeof antwort !== "object" || !Number.isSafeInteger(antwort.status)) {
        throw new HttpError(502, "task_enqueue_response_invalid", { taskId });
      }
      if (antwort.status === 409 || antwort.error === "ALREADY_EXISTS") {
        // Der Name ist vergeben — genau dafuer ist er stabil. Kein Fehler.
        return { enqueued: false, duplicate: true, reason: "ALREADY_EXISTS" };
      }
      if (antwort.status >= 200 && antwort.status < 300) {
        return { enqueued: true, duplicate: false, name };
      }
      throw new HttpError(502, "task_enqueue_failed", { taskId, status: antwort.status });
    },
  });
}

/* ── Abschlussnachweis: run.status (scheduler) + run.context (lead_agent) ─
 *
 * Vier Dinge muessen fuer ein Gruen ZUSAMMEN belegt sein
 * (`validateClosureEvidence`, `worker-handlers.mjs`): aktueller Fence,
 * vollstaendiger Quellensatz, belegter B-Abschluss, aktuelle Version.
 * Dieser Port liefert dafuer die drei Stuecke, die C2 tatsaechlich
 * bezeugen kann — kein Fence (den kennt nur E1, der Aufrufer setzt ihn):
 *
 *   run.status   (Kategorie `run_status`, `scheduler` ODER `backend_checker`
 *                erlaubt) — `state`, `blocked`, `openQuestions`: B's eigenes,
 *                durch `closeRun`/`dailyAssistantTrafficLight` berechnetes
 *                Urteil ueber DIESEN Kalendertag.
 *   run.context  (Kategorie `run_context`, NUR `lead_agent`/Spezialisten
 *                erlaubt) — je Quelle im Lauf ein Eintrag mit
 *                `entityVersion`; daraus wird `sources` gebildet. Dieser
 *                Dienst haelt dafuer KEIN Dauer-Zugangsdatum, sondern
 *                mintet sich per Aufruf ein laufgebundenes Job-Token
 *                (`job-token-issuer.mjs`, echter C1-Signaturweg). Fehlt
 *                dessen Konfiguration, bleibt `sources` leer — der Lauf
 *                wird dann NICHT gruen (`sources_missing`), es wird
 *                nichts erfunden und keine Rolle stillschweigend erweitert.
 *
 * Beide Seiten muessen VOLLSTAENDIG sein (`complete: true`) und dieselbe
 * Datenrevision tragen — sonst waeren Status und Quellen aus zwei
 * verschiedenen Kernstaenden zusammengewuerfelt.
 * ═════════════════════════════════════════════════════════════════════════ */

export const RUN_STATUS_QUERY = "run.status";
export const RUN_CONTEXT_QUERY = "run.context";
export const CONTEXT_PAGE_SIZE = 50;   // NAMED_QUERIES["run.context"].maxPageSize in C2

/* B's einziger echter Abschlusszustand (`assistant-abschluss.mjs`,
 * `run.phase = "final"`). Die anderen moeglichen Werte ("created",
 * "active", "exception_open") sind KEIN Abschluss. */
export const CLOSURE_FINAL_STATE = "final";

function fehlschlag(code, detail = null) {
  return { ok: false, code, detail, evidence: null };
}

/*
 * Strukturpruefung einer Leseseite gegen den echten C2-Umschlag: Echo,
 * Vollstaendigkeit, Datenrevision. Die INHALTLICHE Abschlusspruefung
 * (final/blocked/Quellen vollstaendig) liegt bewusst NICHT hier, sondern
 * an EINER Stelle in `validateClosureEvidence` — zwei Stellen, die
 * dieselbe Frage beantworten, laufen sonst leicht auseinander.
 */
function seitePruefen(antwort, { query, scopeId }) {
  if (antwort === null || typeof antwort !== "object") return fehlschlag("response_invalid");
  if (antwort.status !== 200) return fehlschlag("status_not_ok", { status: antwort.status });
  const body = antwort.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fehlschlag("body_invalid");
  if (body.ok !== true) return fehlschlag("body_not_ok");
  if (body.query !== query) return fehlschlag("query_echo_mismatch");
  if (body.scopeId !== scopeId) return fehlschlag("scope_echo_mismatch");
  if (body.complete !== true || body.pageStatus !== "done" || body.hasMore !== false) {
    return fehlschlag("page_not_complete", { pageStatus: body.pageStatus ?? null, reason: body.pageReason ?? null });
  }
  if (!Array.isArray(body.items)) return fehlschlag("items_not_a_list");
  if (!Number.isSafeInteger(body.dataRevision) || body.dataRevision < 0) return fehlschlag("data_revision_invalid");
  const serverNowMs = Date.parse(String(body.serverNow || ""));
  if (!Number.isSafeInteger(serverNowMs)) return fehlschlag("server_now_invalid");
  return { ok: true, code: null, body, serverNowMs };
}

/**
 * Bildet die `run.status`-Seite auf {state, blocked, openQuestions,
 * entityVersion, dataRevision, verifiedAtMs} ab — noch OHNE Urteil.
 */
export function mapRunStatusPage(antwort, { runId, scopeId }) {
  const seite = seitePruefen(antwort, { query: RUN_STATUS_QUERY, scopeId });
  if (!seite.ok) return seite;
  const { body, serverNowMs } = seite;

  const treffer = body.items.filter((e) => e && typeof e === "object" && e.runId === runId);
  if (treffer.length === 0) return fehlschlag("run_status_not_found", { runId });
  if (treffer.length > 1) return fehlschlag("run_status_ambiguous", { count: treffer.length });
  const eintrag = treffer[0];
  if (typeof eintrag.id !== "string" || !eintrag.id) return fehlschlag("item_id_missing");
  if (!Number.isSafeInteger(eintrag.entityVersion)) return fehlschlag("entity_version_invalid");
  const versionen = body.entityVersions;
  if (versionen === null || typeof versionen !== "object") return fehlschlag("entity_versions_missing");
  if (versionen[eintrag.id] !== eintrag.entityVersion) return fehlschlag("entity_version_mismatch");

  return {
    ok: true, code: null,
    page: {
      dataRevision: body.dataRevision, verifiedAtMs: serverNowMs,
      evidenceRef: `runstatus:${eintrag.id}:v${eintrag.entityVersion}`,
      state: typeof eintrag.state === "string" ? eintrag.state : null,
      stage: typeof eintrag.stage === "string" ? eintrag.stage : null,
      blocked: eintrag.blocked === true,
      openQuestions: Number.isSafeInteger(eintrag.openQuestions) ? eintrag.openQuestions : null,
    },
  };
}

/**
 * Bildet die `run.context`-Seite auf ein `sources`-Array ab: ein Eintrag
 * je Quelle, die B tatsaechlich im Lauf fuehrt. `id` ist der PROJIZIERTE
 * C2-Eintrag (`ctx_<sourceType>_<sourceId>`) — die einzige stabile,
 * unveraenderte Kennung, die diese Rolle zu sehen bekommt; ein Betreiber
 * konfiguriert `QUANTUS_V3_REQUIRED_SOURCES` damit 1:1 gegen das, was C2
 * tatsaechlich zurueckgibt.
 */
export function mapRunContextPage(antwort, { runId, scopeId }) {
  const seite = seitePruefen(antwort, { query: RUN_CONTEXT_QUERY, scopeId });
  if (!seite.ok) return seite;
  const { body, serverNowMs } = seite;

  const sources = [];
  for (const eintrag of body.items) {
    if (!eintrag || typeof eintrag !== "object") return fehlschlag("items_not_a_list");
    if (typeof eintrag.id !== "string" || !eintrag.id) return fehlschlag("item_id_missing");
    if (eintrag.runId !== runId) return fehlschlag("item_outside_run", { id: eintrag.id });
    sources.push({
      id: eintrag.id,
      status: Number.isSafeInteger(eintrag.entityVersion) ? "ok" : "not_ok",
      checkedAtMs: serverNowMs,
    });
  }
  return { ok: true, code: null, page: { dataRevision: body.dataRevision, verifiedAtMs: serverNowMs, sources } };
}

/**
 * Der Nachweisport. Ruft `status.run` (Dienst-Zugangsdatum) UND
 * `context.run` (laufgebundenes Job-Token) und fuegt beides zu EINEM
 * Nachweis zusammen. Jeder der beiden Aufrufe kann fuer sich mit 503
 * scheitern (Werkzeug abgeschaltet, Token-Aussteller nicht konfiguriert,
 * Transport fehlt) — dann bleibt der jeweilige Teil des Nachweises leer,
 * und `validateClosureEvidence` weist ihn zurueck, statt ihn zu erfinden.
 */
export function createRunStatusClosureEvidencePort({ toolClient, tenant, policyVersion, contextPageSize = CONTEXT_PAGE_SIZE } = {}) {
  if (!toolClient || typeof toolClient.call !== "function") {
    return unavailablePort("closureEvidence", "run_status_tool_not_wired");
  }
  return availablePort("closureEvidence", {
    lastFailure: null,
    async load({ runKey, fence, now, requestId = null }) {
      let scopeId; let runId;
      try {
        scopeId = statusScopeIdForRunKey(runKey);
        runId = runIdForRunKey(runKey);
      } catch (err) {
        this.lastFailure = err?.code || "run_id_unusable";
        return null;
      }

      // 1. run.status — Dienst-Zugangsdatum, immer versucht.
      const statusAntwort = await toolClient.call(
        "status.run", { query: RUN_STATUS_QUERY, scopeId, jobId: runId, pageSize: 100 }, { now, requestId },
      );
      const statusAbbildung = mapRunStatusPage(statusAntwort, { runId, scopeId });
      if (!statusAbbildung.ok) { this.lastFailure = statusAbbildung.code; return null; }

      // 2. run.context — laufgebundenes Job-Token. Scheitert dieser
      //    Aufruf (Werkzeug abgeschaltet, Token-Aussteller fehlt,
      //    Transport fehlt), bleibt `sources` leer statt geraten.
      let sources = null;
      try {
        const contextAntwort = await toolClient.call(
          "context.run", { query: RUN_CONTEXT_QUERY, scopeId: runId, jobId: runId, pageSize: contextPageSize },
          { now, requestId },
        );
        const contextAbbildung = mapRunContextPage(contextAntwort, { runId, scopeId: runId });
        if (!contextAbbildung.ok) {
          this.lastFailure = contextAbbildung.code;
        } else if (contextAbbildung.page.dataRevision !== statusAbbildung.page.dataRevision) {
          // Zwei getrennte Leseanfragen duerfen keine verschiedenen
          // Kernstaende zusammenwuerfeln — sonst waere die Version nicht
          // mehr AKTUELL fuer beide Teile des Nachweises.
          this.lastFailure = "data_revision_inconsistent";
        } else {
          sources = contextAbbildung.page.sources;
          this.lastFailure = null;
        }
      } catch (err) {
        this.lastFailure = err instanceof HttpError ? err.error : "run_context_load_failed";
      }

      return Object.freeze({
        runKey, runId, tenant, policyVersion,
        // Der Fence kommt NICHT von C2 — er gehoert E1, der Aufrufer setzt ihn.
        fence: Number.isSafeInteger(fence) ? fence : null,
        fenceAttestedByC2: false,
        dataRevision: statusAbbildung.page.dataRevision,
        evidenceRef: statusAbbildung.page.evidenceRef,
        verifiedAtMs: statusAbbildung.page.verifiedAtMs,
        state: statusAbbildung.page.state,
        stage: statusAbbildung.page.stage,
        blocked: statusAbbildung.page.blocked,
        openQuestions: statusAbbildung.page.openQuestions,
        sources,
      });
    },
  });
}
