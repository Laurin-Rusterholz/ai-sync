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
 *   closureEvidence  liest den Abschlussnachweis ueber den Werkzeugport
 *                    `status.run` (Route `quantus-run-status`) und bildet
 *                    ihn streng ab. Das Werkzeug ist in C1 abgeschaltet,
 *                    also endet der Aufruf dort ehrlich mit 503.
 *
 * Kein Port erfindet einen Erfolg. Wo eine Abhaengigkeit fehlt, ist die
 * Antwort `unavailablePort` mit Grund — und die Route antwortet mit 503.
 * ═════════════════════════════════════════════════════════════════════════ */
import { availablePort, unavailablePort } from "./ports.mjs";
import { HttpError } from "./errors.mjs";
import { taskName } from "./task-names.mjs";

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

/* ── Abschlussnachweis ueber das Werkzeug `quantus_run_status` ────────── */

/* Bildet die Antwort des Statuswerkzeugs streng auf die Nachweisform ab.
 * Was nicht vollstaendig und eindeutig ist, wird zu `null` — der Worker
 * beendet den Lauf dann ehrlich unvollstaendig statt gruen. */
export function mapRunStatusToEvidence(antwort, { runKey, tenant, policyVersion }) {
  if (antwort === null || typeof antwort !== "object") return null;
  const status = antwort.runStatus && typeof antwort.runStatus === "object" ? antwort.runStatus : antwort;
  if (status.runKey !== runKey) return null;
  if (status.closure === null || typeof status.closure !== "object") return null;
  const closure = status.closure;
  if (closure.state !== "final") return null;
  const quellen = Array.isArray(closure.sources) ? closure.sources : null;
  if (!quellen) return null;
  return {
    runKey,
    tenant: typeof status.tenant === "string" ? status.tenant : tenant,
    policyVersion: typeof status.policyVersion === "string" ? status.policyVersion : policyVersion,
    fence: Number.isSafeInteger(closure.fence) ? closure.fence : null,
    dataRevision: Number.isSafeInteger(status.dataRevision) ? status.dataRevision : null,
    evidenceRef: typeof closure.evidenceRef === "string" ? closure.evidenceRef : null,
    verifiedAtMs: Number.isSafeInteger(closure.verifiedAtMs) ? closure.verifiedAtMs : null,
    sources: quellen.map((q) => (q && typeof q === "object"
      ? { id: q.id, status: q.status, checkedAtMs: Number.isSafeInteger(q.checkedAtMs) ? q.checkedAtMs : null }
      : { id: null, status: null, checkedAtMs: null })),
  };
}

export function createRunStatusClosureEvidencePort({ toolClient, tenant, policyVersion } = {}) {
  if (!toolClient || typeof toolClient.call !== "function") {
    return unavailablePort("closureEvidence", "run_status_tool_not_wired");
  }
  return availablePort("closureEvidence", {
    async load({ runKey, now }) {
      // Wirft, solange das Werkzeug abgeschaltet ist (C1: ueberall false).
      const antwort = await toolClient.call("status.run", { query: "run.status", scopeId: runKey }, { now });
      return mapRunStatusToEvidence(antwort, { runKey, tenant, policyVersion });
    },
  });
}
