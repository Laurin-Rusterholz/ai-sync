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

/* ── Abschlussnachweis ueber das Werkzeug `quantus_run_status` ────────── */

/*
 * BEFUND AN DER INTEGRATION 48dc1fe — die fruehere Fassung war erfunden.
 *
 * Sie erwartete `{ runStatus: { runKey, closure: { state, fence,
 * evidenceRef, verifiedAtMs, sources } } }`. Nichts davon gibt es.
 * `handleReadRequest` antwortet mit einer SEITE:
 *
 *   { ok, requestId, serverNow, dataRevision, query, scopeId,
 *     items, count, hasMore, complete, pageStatus, pageReason,
 *     cursor, entityVersions }
 *
 * und die Eintraege sind auf `VISIBLE_FIELDS.run_status` beschnitten:
 * `id, runId, state, stage, entityVersion, updatedAt, openQuestions,
 * blocked`. Alles andere schneidet `projectItem` weg — auch ein Feld,
 * das der Fachadapter mitgaebe.
 *
 * Daraus folgt, was C2 bezeugen KANN und was nicht:
 *
 *   bezeugt   der Statusdatensatz dieses Laufs, sein Zustand, seine
 *             Entitaetsversion, die Datenrevision des Kerns und die
 *             SERVERZEIT der Auskunft
 *   bezeugt   dass die Seite VOLLSTAENDIG war (`complete: true`) — eine
 *             abgebrochene oder fortgesetzte Seite ist kein Beweis, dass
 *             es nichts weiteres gibt
 *   NICHT     der Lease-Fence (den kennt nur E1) und der Quellensatz
 *             (`requiredSources`) — beide stehen nicht in der Sichtliste
 *
 * Deshalb liefert diese Abbildung `sources: null`, wenn der Quellensatz
 * nicht bezeugt ist. Der Lauf wird dann NICHT gruen; `validateClosureEvidence`
 * meldet `sources_missing`. Das ist der ehrliche Stand und kein Mangel
 * dieser Datei — siehe `docs/quantus-v3-runtime-cloud.md`.
 */

export const RUN_STATUS_QUERY = "run.status";

/* Welcher Zustand eines Statusdatensatzes ein ABSCHLUSS ist. Streng und
 * abgeschlossen: was nicht hier steht, ist kein Abschluss. */
export const FINAL_RUN_STATES = Object.freeze(["completed", "closed", "finalized", "no_work", "aborted"]);
export const GREEN_RUN_STATES = Object.freeze(["completed", "closed", "finalized", "no_work"]);

function fehlschlag(code, detail = null) {
  return { ok: false, code, detail, evidence: null };
}

/**
 * Bildet EINE echte Leseantwort auf die Nachweisform ab.
 *
 * @param antwort   `{ status, body }` des Transports (nicht der Rumpf allein)
 * @param erwartet  { runKey, runId, scopeId, tenant, policyVersion }
 * @returns { ok: true, evidence } | { ok: false, code }
 */
export function mapRunStatusPageToEvidence(antwort, erwartet) {
  if (antwort === null || typeof antwort !== "object") return fehlschlag("response_invalid");
  if (antwort.status !== 200) return fehlschlag("status_not_ok", { status: antwort.status });
  const body = antwort.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fehlschlag("body_invalid");
  if (body.ok !== true) return fehlschlag("body_not_ok");

  // Die Antwort muss zu DIESER Frage gehoeren. Ein Echo, das abweicht,
  // ist keine Auskunft ueber unseren Lauf.
  if (body.query !== RUN_STATUS_QUERY) return fehlschlag("query_echo_mismatch");
  if (body.scopeId !== erwartet.scopeId) return fehlschlag("scope_echo_mismatch");

  // Eine abgebrochene oder gedeckelte Seite beweist nichts — auch nicht,
  // dass der Eintrag fehlt.
  if (body.complete !== true || body.pageStatus !== "done") {
    return fehlschlag("page_not_complete", { pageStatus: body.pageStatus ?? null, reason: body.pageReason ?? null });
  }
  if (body.hasMore !== false) return fehlschlag("page_not_complete");
  if (!Array.isArray(body.items)) return fehlschlag("items_not_a_list");
  if (!Number.isSafeInteger(body.dataRevision) || body.dataRevision < 0) return fehlschlag("data_revision_invalid");

  const serverNowMs = Date.parse(String(body.serverNow || ""));
  if (!Number.isSafeInteger(serverNowMs)) return fehlschlag("server_now_invalid");

  const treffer = body.items.filter((eintrag) => eintrag && typeof eintrag === "object" && eintrag.runId === erwartet.runId);
  if (treffer.length === 0) return fehlschlag("run_status_not_found", { runId: erwartet.runId });
  if (treffer.length > 1) return fehlschlag("run_status_ambiguous", { count: treffer.length });
  const eintrag = treffer[0];
  if (typeof eintrag.id !== "string" || !eintrag.id) return fehlschlag("item_id_missing");
  if (!Number.isSafeInteger(eintrag.entityVersion)) return fehlschlag("entity_version_invalid");

  // Die Entitaetsversion muss zur mitgelieferten Liste passen — sonst
  // widerspricht sich die Antwort selbst.
  const versionen = body.entityVersions;
  if (versionen === null || typeof versionen !== "object") return fehlschlag("entity_versions_missing");
  if (versionen[eintrag.id] !== eintrag.entityVersion) return fehlschlag("entity_version_mismatch");

  if (!FINAL_RUN_STATES.includes(eintrag.state)) return fehlschlag("run_not_final", { state: eintrag.state ?? null });
  if (eintrag.blocked === true) return fehlschlag("run_blocked");
  if (Array.isArray(eintrag.openQuestions) && eintrag.openQuestions.length > 0) {
    return fehlschlag("open_questions", { count: eintrag.openQuestions.length });
  }

  return {
    ok: true,
    code: null,
    evidence: Object.freeze({
      runKey: erwartet.runKey,
      runId: erwartet.runId,
      tenant: erwartet.tenant,
      policyVersion: erwartet.policyVersion,
      // Der Fence kommt NICHT von aussen — er gehoert E1. Der Aufrufer
      // setzt ihn; hier steht ausdruecklich, dass C2 ihn nicht bezeugt.
      fence: null,
      fenceAttestedByC2: false,
      dataRevision: body.dataRevision,
      // Ein Bezug auf einen ECHTEN Serverdatensatz samt seiner Version,
      // nicht auf den Laufschluessel, den wir selbst mitgebracht haben.
      evidenceRef: `runstatus:${eintrag.id}:v${eintrag.entityVersion}`,
      verifiedAtMs: serverNowMs,
      state: eintrag.state,
      stage: typeof eintrag.stage === "string" ? eintrag.stage : null,
      green: GREEN_RUN_STATES.includes(eintrag.state),
      // C2 bezeugt keinen Quellensatz. `null` heisst hier: nicht bezeugt.
      sources: null,
    }),
  };
}

/**
 * Der Nachweisport. Er ruft das Werkzeug `status.run` ueber den
 * Werkzeugklienten (GET, Query-String, C2-Ids) und rechnet die Antwort
 * gegen den erwarteten Lauf gegen.
 */
export function createRunStatusClosureEvidencePort({ toolClient, tenant, policyVersion, pageSize = 100 } = {}) {
  if (!toolClient || typeof toolClient.call !== "function") {
    return unavailablePort("closureEvidence", "run_status_tool_not_wired");
  }
  return availablePort("closureEvidence", {
    lastFailure: null,
    async load({ runKey, fence, now, requestId = null }) {
      // Die Umrechnung kann scheitern (zu langer Schluessel) — dann gibt
      // es keinen Nachweis, keine geratene Id.
      let scopeId; let runId;
      try {
        scopeId = statusScopeIdForRunKey(runKey);
        runId = runIdForRunKey(runKey);
      } catch (err) {
        this.lastFailure = err?.code || "run_id_unusable";
        return null;
      }
      // Wirft, solange das Werkzeug abgeschaltet ist (C1: ueberall false)
      // oder der Transport fehlt — das ist ein 503, kein leerer Nachweis.
      const antwort = await toolClient.call(
        "status.run",
        { query: RUN_STATUS_QUERY, scopeId, jobId: runId, pageSize },
        { now, requestId },
      );
      const abbildung = mapRunStatusPageToEvidence(antwort, { runKey, runId, scopeId, tenant, policyVersion });
      if (!abbildung.ok) {
        this.lastFailure = abbildung.code;
        return null;
      }
      this.lastFailure = null;
      // Der Fence bleibt der des Aufrufers — ausdruecklich und sichtbar,
      // damit niemand ihn fuer eine Fremdbestaetigung haelt.
      return { ...abbildung.evidence, fence: Number.isSafeInteger(fence) ? fence : null };
    },
  });
}
