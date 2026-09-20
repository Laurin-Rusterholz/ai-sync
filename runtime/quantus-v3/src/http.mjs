/* ══ E2 — HTTP-Rand ═══════════════════════════════════════════════════════
 *
 * Ein Router mit EXAKTEN Pfaden und Methoden. Es gibt keine offene Route:
 * jede verlangt ein von Google signiertes OIDC-Token mit der fuer genau
 * diese Route konfigurierten Kennung und einem fuer genau diese Route
 * zugelassenen Dienstkonto. Auch keine Gesundheitsroute — die Startpruefung
 * von Cloud Run laeuft als TCP-Pruefung, nicht als HTTP-Aufruf.
 *
 * Reihenfolge je Anfrage (nichts davon ist optional):
 *   1. Methode und Pfad muessen exakt passen
 *   2. TLS an der Grenze (`x-forwarded-proto: https`)
 *   3. Serverzeit EINMAL holen — alles Weitere rechnet mit diesem Wert
 *   4. OIDC pruefen: Aussteller, Kennung, Dienstkonto
 *   5. Rumpf lesen (Groessengrenze), strikt als JSON deuten
 *   6. jede Identitaets-, Zeit- oder Rechtebehauptung im Rumpf abweisen
 *   7. erst danach der Handler
 *
 * Fehler gehen als `{ error, detail? }` hinaus. Der Grund einer
 * gescheiterten Ausweispruefung bleibt im Log.
 * ═════════════════════════════════════════════════════════════════════════ */
import { randomUUID } from "node:crypto";
import { HttpError, badRequest, forbidden, asHttpError } from "./errors.mjs";
import { assertNoServerControlledFields } from "./schema.mjs";
import { verifyGoogleIdToken, readBearerToken } from "./oidc.mjs";

export function createRouter({ config, ports, routes, logger = null }) {
  const table = new Map();
  for (const route of routes) {
    table.set(`${route.method} ${route.path}`, route);
    if (!config.endpoints[route.endpointKey]) {
      throw new Error(`Route ${route.path}: keine Konfiguration fuer ${route.endpointKey}`);
    }
  }

  async function handle(request) {
    const started = Date.now();
    const requestId = randomUUID();
    try {
      const route = table.get(`${request.method} ${request.path}`);
      if (!route) throw new HttpError(404, "not_found");

      // 2. TLS an der Grenze. Cloud Run setzt diese Kopfzeile immer.
      const proto = request.headers["x-forwarded-proto"];
      if (proto !== "https") throw forbidden("tls_required");

      // 3. Serverzeit — einmal, an der vertrauenswuerdigen Grenze.
      const clock = ports.require("clock");
      const now = clock.now();
      if (!Number.isSafeInteger(now) || now <= 0) throw new HttpError(500, "server_clock_invalid");

      // 4. Ausweis.
      const endpoint = config.endpoints[route.endpointKey];
      const jwks = await ports.require("jwks").getKeys();
      const token = readBearerToken(request.headers);
      const verified = verifyGoogleIdToken(token, {
        audience: endpoint.audience,
        allowedServiceAccounts: endpoint.allowedServiceAccounts,
        jwks, now,
      });

      // 5. Rumpf.
      let body = {};
      if (request.bodyText !== undefined && request.bodyText !== null && request.bodyText !== "") {
        if (Buffer.byteLength(request.bodyText, "utf8") > config.maxRequestBytes) {
          throw new HttpError(413, "payload_too_large", { maxBytes: config.maxRequestBytes });
        }
        const contentType = String(request.headers["content-type"] || "").split(";")[0].trim();
        if (contentType !== "application/json") throw badRequest("content_type_invalid");
        try { body = JSON.parse(request.bodyText); } catch { throw badRequest("json_invalid"); }
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw badRequest("json_object_required");
      }
      // 6. Nichts aus dem Rumpf wird geglaubt, was der Server bestimmt.
      assertNoServerControlledFields(body);

      const ctx = {
        config, ports, requestId, now, body,
        headers: request.headers,
        principal: verified.principal,
        route: route.endpointKey,
      };
      const result = await route.handler(ctx);
      return respond(result.status ?? 200, result.body, requestId);
    } catch (raw) {
      const err = asHttpError(raw) ?? raw;
      const status = err instanceof HttpError ? err.status : 500;
      const body = err instanceof HttpError ? err.toBody() : { error: "internal_error" };
      if (logger) {
        logger({
          severity: status >= 500 ? "ERROR" : "WARNING",
          requestId, path: request.path, method: request.method,
          status, error: body.error,
          // Der Grund einer Ausweispruefung NUR hier.
          logDetail: err instanceof HttpError ? err.logDetail : { message: String(err && err.message).slice(0, 200) },
          durationMs: Date.now() - started,
        });
      }
      return respond(status, body, requestId);
    }
  }

  return { handle, routes: [...table.keys()].sort() };
}

function respond(status, body, requestId) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-quantus-request-id": requestId,
    },
    body: JSON.stringify({ ...body, requestId }),
  };
}

/* Bruecke zu node:http. Der Router selbst kennt kein node:http und laesst
 * sich damit ohne Netz testen. */
export function createNodeRequestListener(router, { maxBytes }) {
  return async function listener(req, res) {
    const chunks = [];
    let size = 0;
    let aborted = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) { aborted = true; break; }
      chunks.push(chunk);
    }
    if (aborted) {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
    const response = await router.handle({
      method: req.method,
      path: url.pathname,
      headers,
      bodyText: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  };
}
