/* ══ E2 — Integrationsports zu den vier Quantus-Werkzeugen ════════════════
 *
 * KEIN Vollzugriffsport. Jeder Port ist eine einzelne, benannte Operation
 * mit festem Werkzeug, fester Route, festem Verb, fester Datenkategorie,
 * fester handelnder Rolle und festem Nutzlastschema. Was hier nicht steht,
 * kann dieser Dienst nicht aufrufen — auch nicht versehentlich.
 *
 * Route, Verb UND erlaubte Datenkategorie kommen NICHT aus einer eigenen
 * Abschrift, sondern direkt aus der echten Rollenmatrix `ROLE_POLICY`
 * (`quantus-v3-auth.mjs`, C1) — siehe die Selbstpruefung am Dateiende.
 *
 * BEFUND, DER DIESE UMSTELLUNG ERZWUNGEN HAT: eine fruehere Fassung hatte
 * hier eine SELBST GEFUEHRTE Verbliste ohne Datenkategorien. `context.read`
 * steht fuer mehrere Rollen — aber `ROLE_POLICY` erlaubt darin nur
 * BESTIMMTE Kategorien je Rolle: `run_context` (Belege je Quelle) duerfen
 * NUR `lead_agent` (Job-Token, `assigned`) und die Spezialisten
 * (Job-Token, `job`) lesen — kein Dienst-Zugangsdatum. Ein Port
 * `context.run` mit einem Dienst-Zugangsdatum haette nie funktioniert, war
 * aber nie aufgefallen, weil die eigene Liste das nicht unterschied.
 *
 * `context.run` bleibt deshalb ERHALTEN, ist aber korrekt an `lead_agent`
 * gebunden: er braucht einen Job-Token-Aussteller (`job-token-issuer.mjs`)
 * statt eines statischen Dienst-Zugangsdatums. Fehlt der Aussteller — er
 * braucht C1-eigene Zugangsdaten (`QUANTUS_V3_WORKER_TOKEN_KEYS`), die
 * dieses Paket nicht mitbringt —, scheitert der Aufruf mit 503 und einem
 * benannten Grund, nie mit einem erfundenen Ausweis oder einer leeren
 * `sources`-Liste, die als „nichts zu pruefen" durchgewunken wird.
 *
 * Absichtlich NICHT als Port vorhanden, obwohl C1 sie der Rolle
 * `backend_checker` erlaubt: `briefing.consumeAnswer`, `document.processed`,
 * `note.append`. Dieses Paket braucht sie nicht, also gibt es sie hier
 * nicht. Ein Port entsteht mit seinem Bedarf, nicht auf Vorrat.
 * ═════════════════════════════════════════════════════════════════════════ */
import { HttpError, badRequest } from "./errors.mjs";
import { requireSchema } from "./schema.mjs";
import { ROLE_POLICY, ISSUERS } from "../../../netlify/lib/quantus-v3-auth.mjs";

/* Die vier Werkzeuge und ihre Routen (C1, Abschnitt 2). */
export const QUANTUS_TOOLS = Object.freeze({
  quantus_context: Object.freeze({ route: "quantus-context", verbs: Object.freeze(["context.read"]) }),
  quantus_read: Object.freeze({ route: "quantus-read", verbs: Object.freeze(["context.read"]) }),
  quantus_command: Object.freeze({
    route: "quantus-ingest",
    verbs: Object.freeze(["run.ensure", "run.claim", "run.renew", "run.log", "run.checkpoint", "run.finalize"]),
  }),
  quantus_run_status: Object.freeze({ route: "quantus-run-status", verbs: Object.freeze(["context.read"]) }),
});

/* Die Rollen, die dieser Dienst tatsaechlich einnimmt. `scheduler` und
 * `backend_checker` haelt er als Dienst-Zugangsdatum; `lead_agent` nur
 * PUNKTUELL als selbst ausgestelltes, laufgebundenes Job-Token (siehe
 * `job-token-issuer.mjs`) — nie als Dauer-Zugangsdatum. Die Spezialisten
 * sind hier nicht vertreten. */
export const SERVICE_ROLES = Object.freeze(["scheduler", "backend_checker"]);
export const JOB_BOUND_ROLES = Object.freeze(["lead_agent"]);
for (const rolle of SERVICE_ROLES) {
  if (!ROLE_POLICY[rolle] || ROLE_POLICY[rolle].issuedBy !== ISSUERS.serviceCredential) {
    throw new Error(`Rolle ${rolle}: kein Dienst-Zugangsdatum in der echten Rollenmatrix`);
  }
}
for (const rolle of JOB_BOUND_ROLES) {
  if (!ROLE_POLICY[rolle] || ROLE_POLICY[rolle].issuedBy !== ISSUERS.jobToken) {
    throw new Error(`Rolle ${rolle}: kein Job-Token in der echten Rollenmatrix`);
  }
}

const RUN_KEY = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}:\\d{4}-\\d{2}-\\d{2}:[a-z0-9]{1,24}:[A-Za-z0-9._-]{1,32}$", maxLength: 200 };
const ID = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" };

/*
 * Die Id-Regel des LESEWEGS: `quantus-v3-service.mjs` nimmt fuer `scopeId`
 * und `jobId` genau `^[A-Za-z0-9_:-]{1,120}$`, kein `__`. Die B-Ids
 * (`run_YYYY-MM-DD`, `status_YYYY-MM-DD`, siehe `run-ids.mjs`) erfuellen
 * das ohnehin — hier steht dasselbe Muster, damit ein falsch gebauter
 * Aufruf schon lokal auffaellt, nicht erst als 400 `scope_id_invalid`.
 */
const C2_ID_PATTERN = "^[A-Za-z0-9_:-]{1,120}$";
const C2_ID = { type: "string", pattern: C2_ID_PATTERN, maxLength: 120 };
const CURSOR = { type: "string", maxLength: 4096, pattern: "^[A-Za-z0-9._-]{16,4096}$" };

/* Die neun Ports, die E2 wirklich braucht. */
export const TOOL_PORTS = Object.freeze({
  /*
   * DIE LESEPORTS SIND GET, NICHT POST.
   *
   * `handleReadRequest` weist alles ausser GET mit 400
   * `method_not_allowed` ab und liest `query`, `scopeId`, `pageSize`,
   * `cursor`, `jobId` aus dem QUERY-STRING — ein JSON-Rumpf wird nie
   * angesehen.
   */
  "context.run": Object.freeze({
    tool: "quantus_context", verb: "context.read", role: "lead_agent", scopeKind: "run_context", method: "GET",
    transport: "query",
    request: {
      type: "object", required: ["query", "scopeId", "jobId"],
      properties: {
        query: { type: "string", enum: ["run.context"] },
        // scopeId UND jobId sind fuer diesen Port dieselbe B-Lauf-Id: das
        // Scope-Objekt der Kategorie `run_context` IST der Lauf selbst,
        // `jobId` bindet den Job-Token an genau diesen Lauf.
        scopeId: C2_ID, jobId: C2_ID,
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
        cursor: CURSOR,
      },
    },
  }),
  "status.run": Object.freeze({
    tool: "quantus_run_status", verb: "context.read", role: "scheduler", scopeKind: "run_status", method: "GET",
    transport: "query",
    request: {
      type: "object", required: ["query", "scopeId"],
      properties: {
        query: { type: "string", enum: ["run.status"] },
        scopeId: C2_ID, jobId: C2_ID,
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        cursor: CURSOR,
      },
    },
  }),
  /*
   * Die enge Nachweisprojektion: tatsaechlich gespeicherte Quellen-
   * pruefungen (`run.sourceChecks`) — nicht `run.context` (Arbeitsliste,
   * kein Pruefnachweis). Das Scope-Objekt ist der Lauf selbst (Kategorie
   * `run`), die schon `scheduler` erlaubt ist — kein Job-Token noetig.
   */
  "sourceChecks.run": Object.freeze({
    tool: "quantus_run_status", verb: "context.read", role: "scheduler", scopeKind: "run", method: "GET",
    transport: "query",
    request: {
      type: "object", required: ["query", "scopeId"],
      properties: {
        query: { type: "string", enum: ["run.sourceChecks"] },
        scopeId: C2_ID, jobId: C2_ID,
        pageSize: { type: "integer", minimum: 1, maximum: 10 },
        cursor: CURSOR,
      },
    },
  }),
  "run.ensure": Object.freeze({
    tool: "quantus_command", verb: "run.ensure", role: "scheduler", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["runKey", "slot", "localDate"], properties: { runKey: RUN_KEY, slot: { type: "string", maxLength: 24 }, localDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } } },
  }),
  "run.claim": Object.freeze({
    tool: "quantus_command", verb: "run.claim", role: "scheduler", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["runKey", "holder", "ttlMs"], properties: { runKey: RUN_KEY, holder: ID, ttlMs: { type: "integer", minimum: 10000, maximum: 120000 } } },
  }),
  "run.renew": Object.freeze({
    tool: "quantus_command", verb: "run.renew", role: "scheduler", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["runKey", "holder", "leaseFence", "ttlMs"], properties: { runKey: RUN_KEY, holder: ID, leaseFence: { type: "integer", minimum: 1 }, ttlMs: { type: "integer", minimum: 10000, maximum: 120000 } } },
  }),
  "run.log": Object.freeze({
    tool: "quantus_command", verb: "run.log", role: "scheduler", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["runKey", "event"], properties: { runKey: RUN_KEY, event: { type: "string", maxLength: 64 }, detail: { type: "object", properties: {} } } },
  }),
  "run.checkpoint": Object.freeze({
    tool: "quantus_command", verb: "run.checkpoint", role: "backend_checker", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["runKey", "checkpointId", "continuationId", "reason"], properties: { runKey: RUN_KEY, checkpointId: ID, continuationId: ID, reason: { type: "string", maxLength: 64 } } },
  }),
  "run.finalize": Object.freeze({
    tool: "quantus_command", verb: "run.finalize", role: "backend_checker", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["runKey", "outcome"], properties: { runKey: RUN_KEY, outcome: { type: "string", enum: ["dry_run", "completed", "no_work", "aborted"] }, evidenceRef: ID } },
  }),
});

export const TOOL_PORT_NAMES = Object.freeze(Object.keys(TOOL_PORTS).sort());

/*
 * Welche benannte Abfrage welche Route bedient — die Liste steht so in
 * C2 (`ROUTE_QUERIES` in `quantus-v3-service.mjs`). Sie wird hier
 * gespiegelt, damit ein Leseport, der an der falschen Route haengt, beim
 * LADEN auffaellt und nicht erst als 403 `query_not_allowed` im Betrieb.
 */
export const C2_ROUTE_QUERIES = Object.freeze({
  "quantus-context": Object.freeze(["run.context", "lead.context", "notes.recent", "policy.current"]),
  "quantus-read": Object.freeze(["lead.context", "notes.recent", "policy.current", "run.queue"]),
  "quantus-run-status": Object.freeze(["run.status", "run.queue", "run.sourceChecks"]),
});

/*
 * Der Query-String eines Leseports. Nur einfache Werte, jeder als
 * Zeichenkette — genau so liest C2 sie (`url.searchParams.get`). Ein
 * Feld ohne Wert wird WEGGELASSEN, nicht als "undefined" gesendet.
 */
export function toSearchParams(payload) {
  const out = {};
  for (const [key, wert] of Object.entries(payload || {})) {
    if (wert === undefined || wert === null) continue;
    if (typeof wert === "string") { out[key] = wert; continue; }
    if (typeof wert === "number" && Number.isSafeInteger(wert)) { out[key] = String(wert); continue; }
    throw badRequest("tool_query_param_invalid", { field: key });
  }
  return Object.freeze(out);
}

/*
 * Jeder Port muss zu Werkzeug, echter Rollenmatrix UND Datenkategorie
 * passen. Das wird nicht nur dokumentiert, sondern beim LADEN gegen
 * `ROLE_POLICY` gegengeprueft — ein Tippfehler oder eine falsch
 * angenommene Berechtigung faellt sofort auf, nicht erst im Betrieb als
 * 403 `forbidden` (oder schlimmer: unbemerkt, weil der Aufruf gar nicht
 * erst zustande kam).
 */
for (const [name, port] of Object.entries(TOOL_PORTS)) {
  const tool = QUANTUS_TOOLS[port.tool];
  if (!tool) throw new Error(`Port ${name}: unbekanntes Werkzeug ${port.tool}`);
  if (!tool.verbs.includes(port.verb)) throw new Error(`Port ${name}: Verb ${port.verb} gehoert nicht zu ${port.tool}`);
  const policy = ROLE_POLICY[port.role];
  if (!policy) throw new Error(`Port ${name}: unbekannte Rolle ${port.role}`);
  const erlaubteKategorien = policy.verbs?.[port.verb];
  if (!Array.isArray(erlaubteKategorien) || !erlaubteKategorien.includes(port.scopeKind)) {
    throw new Error(`Port ${name}: Rolle ${port.role} darf ${port.verb} nicht auf Kategorie ${port.scopeKind}`);
  }
  if (!SERVICE_ROLES.includes(port.role) && !JOB_BOUND_ROLES.includes(port.role)) {
    throw new Error(`Port ${name}: Rolle ${port.role} ist hier nicht vertreten`);
  }
  if (port.transport === "query") {
    if (port.method !== "GET") throw new Error(`Port ${name}: Query-Transport verlangt GET`);
    const abfragen = port.request?.properties?.query?.enum || [];
    const erlaubteAbfragen = C2_ROUTE_QUERIES[tool.route] || [];
    for (const abfrage of abfragen) {
      if (!erlaubteAbfragen.includes(abfrage)) throw new Error(`Port ${name}: Route ${tool.route} bedient ${abfrage} nicht`);
    }
  } else if (port.method !== "POST") {
    throw new Error(`Port ${name}: Befehlsweg verlangt POST`);
  }
}

/**
 * Baut den Aufruf eines Ports und uebergibt ihn dem Transportport.
 * Alles, was lokal entschieden werden kann, wird lokal entschieden —
 * ein nicht erlaubtes Verb verlaesst diesen Prozess gar nicht erst.
 *
 * @param credential      liefert das STATISCHE Dienst-Zugangsdatum
 *                        (`get(role)`) fuer `scheduler`/`backend_checker`.
 * @param jobTokenIssuer  liefert ein LAUFGEBUNDENES Job-Token
 *                        (`mint({audience,jobId,tenant,now})`) fuer
 *                        `lead_agent`. Fehlt er, scheitert ein Aufruf
 *                        dieser Rolle mit 503 — es wird kein Ausweis
 *                        erfunden und keine Rolle stillschweigend
 *                        uebersprungen.
 */
export function createToolClient({ transport, credential, jobTokenIssuer = null, tenant, policyVersion, toolsEnabled = {} }) {
  return {
    ports: TOOL_PORT_NAMES,
    async call(portName, payload, { requestId, now, timeoutMs = 20_000 } = {}) {
      const port = TOOL_PORTS[portName];
      if (!port) throw badRequest("tool_port_unknown", { port: portName });
      const tool = QUANTUS_TOOLS[port.tool];
      const policy = ROLE_POLICY[port.role];

      // 1. Ist das Werkzeug ueberhaupt freigeschaltet? (C1: ueberall false)
      if (toolsEnabled[port.tool] !== true) {
        throw new HttpError(503, "tool_disabled", { tool: port.tool, route: tool.route });
      }
      // 2. Nutzlast streng pruefen und jede Identitaetsbehauptung abweisen.
      requireSchema(payload, port.request, "tool_payload_invalid");
      // 3. Erst danach der Transport.
      if (!transport || typeof transport.send !== "function") {
        throw new HttpError(503, "port_unavailable", { port: "toolTransport", reason: "not_configured" });
      }

      // 4. Der Ausweis — je nach echter Ausstellart der Rolle.
      let ausweis;
      if (policy.issuedBy === ISSUERS.serviceCredential) {
        if (!credential || typeof credential.get !== "function") {
          throw new HttpError(503, "port_unavailable", { port: "toolCredential", reason: "not_configured" });
        }
        const secret = await credential.get(port.role);
        if (typeof secret !== "string" || !secret) throw new HttpError(503, "tool_credential_missing", { role: port.role });
        ausweis = secret;
      } else if (policy.issuedBy === ISSUERS.jobToken) {
        if (!jobTokenIssuer || typeof jobTokenIssuer.mint !== "function") {
          throw new HttpError(503, "port_unavailable", { port: "jobTokenIssuer", reason: "not_configured" });
        }
        const jobId = payload && typeof payload.jobId === "string" ? payload.jobId : null;
        if (!jobId) throw new HttpError(500, "job_id_required_for_job_token", { port: portName });
        ausweis = await jobTokenIssuer.mint({ audience: tool.route, jobId, tenant, now });
        if (typeof ausweis !== "string" || !ausweis) throw new HttpError(503, "job_token_mint_failed", { port: portName });
      } else {
        throw new HttpError(500, "port_issuer_unknown", { port: portName });
      }

      /*
       * Leseweg und Befehlsweg sind VERSCHIEDENE Transporte, und der
       * Unterschied wird hier entschieden, nicht im Transport:
       *   · GET  — alles steht im Query-String, es gibt keinen Rumpf und
       *            keinen Idempotenz-Schluessel.
       *   · POST — der Rumpf ist der Umschlag, der Schluessel steht in der
       *            Kopfzeile (C2 liest ihn nie aus dem Rumpf).
       */
      const gemeinsam = {
        route: tool.route,
        method: port.method,
        verb: port.verb,
        role: port.role,
        scopeKind: port.scopeKind,
        tenant, policyVersion, requestId, now, timeoutMs,
        // Das Geheimnis/Token geht nur an den Transport — nie in ein Log,
        // nie in eine Antwort, nie in einen Fehler.
        credential: ausweis,
      };
      if (port.transport === "query") {
        return transport.send({ ...gemeinsam, searchParams: toSearchParams(payload), payload: null });
      }
      return transport.send({ ...gemeinsam, payload });
    },
  };
}

export default { QUANTUS_TOOLS, SERVICE_ROLES, JOB_BOUND_ROLES, TOOL_PORTS, TOOL_PORT_NAMES, C2_ROUTE_QUERIES, toSearchParams, createToolClient };
