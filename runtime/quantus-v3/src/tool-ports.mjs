/* ══ E2 — Integrationsports zu den vier Quantus-Werkzeugen ════════════════
 *
 * KEIN Vollzugriffsport. Jeder Port ist eine einzelne, benannte Operation
 * mit festem Werkzeug, fester Route, festem Verb, fester handelnder Rolle
 * und festem Nutzlastschema. Was hier nicht steht, kann dieser Dienst nicht
 * aufrufen — auch nicht versehentlich.
 *
 * Die Route- und Verbnamen stammen aus dem Sicherheitspaket C1
 * (`docs/quantus-v3-sicherheitspaket-c1.md`, Rollenmatrix). C1 ist noch im
 * Review und alle vier Werkzeuge stehen dort auf `enabled: false`; dieses
 * Paket importiert C1 NICHT und schaltet nichts frei. Solange der
 * Transportport fehlt oder das Werkzeug abgeschaltet ist, scheitert jeder
 * Aufruf mit 503 — er wird nicht uebersprungen und nicht vorgetaeuscht.
 *
 * Absichtlich NICHT als Port vorhanden, obwohl C1 sie der Rolle
 * `backend_checker` erlaubt: `briefing.consumeAnswer`, `document.processed`,
 * `note.append`. Dieses Paket braucht sie nicht, also gibt es sie hier
 * nicht. Ein Port entsteht mit seinem Bedarf, nicht auf Vorrat.
 * ═════════════════════════════════════════════════════════════════════════ */
import { HttpError, badRequest } from "./errors.mjs";
import { requireSchema } from "./schema.mjs";

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

/* Die zwei Dienstrollen aus C1 und genau ihre Verben. Mehr gibt es fuer
 * einen Serverdienst nicht — `lead_agent` und die Spezialisten arbeiten mit
 * kurzlebigen Job-Token und sind hier nicht vertreten. */
export const SERVICE_ROLE_VERBS = Object.freeze({
  scheduler: Object.freeze(["context.read", "run.ensure", "run.claim", "run.renew", "run.log"]),
  backend_checker: Object.freeze([
    "context.read", "briefing.consumeAnswer", "document.processed",
    "run.checkpoint", "run.finalize", "run.log", "note.append",
  ]),
});

const RUN_KEY = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}:\\d{4}-\\d{2}-\\d{2}:[a-z0-9]{1,24}:[A-Za-z0-9._-]{1,32}$", maxLength: 200 };
const ID = { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" };

/* Die acht Ports, die E2 wirklich braucht. */
export const TOOL_PORTS = Object.freeze({
  "context.run": Object.freeze({
    tool: "quantus_context", verb: "context.read", role: "scheduler", scopeKind: "run", method: "POST",
    request: { type: "object", required: ["query", "scopeId"], properties: { query: { type: "string", enum: ["run.context"] }, scopeId: RUN_KEY, cursor: { type: "string", maxLength: 4096 } } },
  }),
  "status.run": Object.freeze({
    tool: "quantus_run_status", verb: "context.read", role: "scheduler", scopeKind: "run_status", method: "POST",
    request: { type: "object", required: ["query", "scopeId"], properties: { query: { type: "string", enum: ["run.status"] }, scopeId: RUN_KEY } },
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

/* Jeder Port muss zu Werkzeug UND Rollenmatrix passen. Das wird nicht nur
 * dokumentiert, sondern beim Laden geprueft — ein Tippfehler faellt sofort
 * auf, nicht erst im Betrieb. */
for (const [name, port] of Object.entries(TOOL_PORTS)) {
  const tool = QUANTUS_TOOLS[port.tool];
  if (!tool) throw new Error(`Port ${name}: unbekanntes Werkzeug ${port.tool}`);
  if (!tool.verbs.includes(port.verb)) throw new Error(`Port ${name}: Verb ${port.verb} gehoert nicht zu ${port.tool}`);
  const roleVerbs = SERVICE_ROLE_VERBS[port.role];
  if (!roleVerbs) throw new Error(`Port ${name}: unbekannte Rolle ${port.role}`);
  if (!roleVerbs.includes(port.verb)) throw new Error(`Port ${name}: Rolle ${port.role} darf ${port.verb} nicht`);
}

/**
 * Baut den Aufruf eines Ports und uebergibt ihn dem Transportport.
 * Alles, was lokal entschieden werden kann, wird lokal entschieden —
 * ein nicht erlaubtes Verb verlaesst diesen Prozess gar nicht erst.
 */
export function createToolClient({ transport, credential, tenant, policyVersion, toolsEnabled = {} }) {
  return {
    ports: TOOL_PORT_NAMES,
    async call(portName, payload, { requestId, now, timeoutMs = 20_000 } = {}) {
      const port = TOOL_PORTS[portName];
      if (!port) throw badRequest("tool_port_unknown", { port: portName });
      const tool = QUANTUS_TOOLS[port.tool];

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
      if (!credential || typeof credential.get !== "function") {
        throw new HttpError(503, "port_unavailable", { port: "toolCredential", reason: "not_configured" });
      }
      const secret = await credential.get(port.role);
      if (typeof secret !== "string" || !secret) {
        throw new HttpError(503, "tool_credential_missing", { role: port.role });
      }
      return transport.send({
        route: tool.route,
        method: port.method,
        verb: port.verb,
        role: port.role,
        scopeKind: port.scopeKind,
        tenant, policyVersion, requestId, now, timeoutMs,
        // Das Geheimnis geht nur an den Transport — nie in ein Log, nie in
        // eine Antwort, nie in einen Fehler.
        credential: secret,
        payload,
      });
    },
  };
}
