/* ══ E2 — der echte Transport zu den vier C2-Routen ═══════════════════════
 *
 * Bis hierher war der Werkzeugport eine Beschreibung. Das hier ist der
 * Weg: eine HTTPS-Anfrage an genau die Route, die der Port nennt, in
 * genau der Form, die `handleReadRequest` / `handleCommandRequest` des
 * Integrationsstandes liest.
 *
 * WAS DIE INTEGRATION (48dc1fe) WIRKLICH VERLANGT
 * -----------------------------------------------
 *  Leseweg  GET, `query`, `scopeId`, optional `pageSize`, `cursor`,
 *           `jobId` — alles im QUERY-STRING. Ein anderes Verb ist 400
 *           `method_not_allowed`; ein Rumpf wird nie gelesen.
 *  Befehl   POST, JSON-Rumpf, `Content-Type: application/json`,
 *           `Idempotency-Key` in der KOPFZEILE (nie im Rumpf), hoechstens
 *           64 KiB.
 *  Beide    `Authorization: Bearer <Zugangsdatum>`, TLS erzwungen
 *           (`x-forwarded-proto`/https), Herkunft nur fuer Browser noetig —
 *           ein Serverdienst ruft ohne `Origin` an.
 *
 * WAS HIER NICHT PASSIERT
 * -----------------------
 * Kein Nachbau der Kette, keine zweite Autorisierung, keine Auswertung
 * des Inhalts. Dieser Transport spricht, er entscheidet nicht. Und er
 * erfindet nichts: eine Antwort, die kein JSON-Objekt ist, ist ein
 * Fehler — kein leeres Ergebnis.
 *
 * Das Zugangsdatum geht ausschliesslich in die Kopfzeile. Es steht in
 * keinem Log, keinem Fehler und keiner Rueckgabe.
 * ═════════════════════════════════════════════════════════════════════════ */
import { HttpError } from "./errors.mjs";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const FUNCTION_PATH = "/.netlify/functions/";

const HTTPS_BASE_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
const ROUTE_RE = /^quantus-(?:ingest|context|read|run-status)$/;

/**
 * @param baseUrl        Ursprung der Netlify-Funktionen, https, ohne Pfad
 * @param fetchImpl      `fetch`-vertraegliche Funktion (Tests reichen die
 *                       echte C2-Kette hinein, ohne Netz)
 * @param userAgent      fester Bezeichner, keine Version aus der Umgebung
 */
export function createC2HttpTransport({
  baseUrl, fetchImpl = globalThis.fetch, userAgent = "quantus-v3-runtime",
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof baseUrl !== "string" || !HTTPS_BASE_RE.test(baseUrl)) {
    throw new HttpError(503, "c2_base_url_invalid");
  }
  if (typeof fetchImpl !== "function") throw new HttpError(503, "c2_fetch_not_available");

  return {
    baseUrl,
    async send({ route, method, searchParams = null, payload = null, credential, idempotencyKey = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (!ROUTE_RE.test(String(route))) throw new HttpError(500, "c2_route_unknown", { route: String(route) });
      if (typeof credential !== "string" || !credential) throw new HttpError(503, "tool_credential_missing");

      const url = new URL(`${baseUrl}${FUNCTION_PATH}${route}`);
      const headers = {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        "user-agent": userAgent,
      };
      let body;

      if (method === "GET") {
        if (payload !== null) throw new HttpError(500, "c2_get_with_body");
        for (const [key, wert] of Object.entries(searchParams || {})) {
          if (typeof wert !== "string") throw new HttpError(500, "c2_query_param_invalid", { field: key });
          url.searchParams.set(key, wert);
        }
      } else if (method === "POST") {
        if (searchParams !== null) throw new HttpError(500, "c2_post_with_query");
        // Der Idempotenz-Schluessel wird NICHT erfunden. Ein selbst
        // gewuerfelter Schluessel machte jede Wiederholung zu einem
        // zweiten Befehl — genau das, was er verhindern soll.
        if (typeof idempotencyKey !== "string" || !idempotencyKey) {
          throw new HttpError(500, "c2_idempotency_key_required", { route: String(route) });
        }
        body = JSON.stringify(payload ?? {});
        if (Buffer.byteLength(body, "utf8") > 64 * 1024) throw new HttpError(413, "c2_payload_too_large");
        headers["content-type"] = "application/json";
        headers["idempotency-key"] = idempotencyKey;
      } else {
        throw new HttpError(500, "c2_method_unsupported", { method: String(method) });
      }

      const abbruch = new AbortController();
      const frist = setTimeout(() => abbruch.abort(), Math.max(1, timeoutMs));
      let antwort;
      try {
        antwort = await fetchImpl(url.toString(), { method, headers, body, signal: abbruch.signal });
      } catch {
        // Kein Grund nach aussen: ein Netzfehler ist kein Orakel.
        throw new HttpError(502, "c2_request_failed", { route: String(route) });
      } finally {
        clearTimeout(frist);
      }

      if (!antwort || typeof antwort.status !== "number") throw new HttpError(502, "c2_response_invalid", { route: String(route) });
      let text;
      try { text = await antwort.text(); } catch { throw new HttpError(502, "c2_response_unreadable", { route: String(route) }); }
      if (typeof text !== "string") throw new HttpError(502, "c2_response_unreadable", { route: String(route) });
      if (Buffer.byteLength(text, "utf8") > maxResponseBytes) throw new HttpError(502, "c2_response_too_large", { route: String(route) });

      let json = null;
      if (text.length) {
        try { json = JSON.parse(text); } catch { throw new HttpError(502, "c2_response_not_json", { route: String(route), status: antwort.status }); }
      }
      if (json !== null && (typeof json !== "object" || Array.isArray(json))) {
        throw new HttpError(502, "c2_response_not_json", { route: String(route), status: antwort.status });
      }
      // Status UND Rumpf gehen zurueck. Ob 200 genuegt, entscheidet der
      // Aufrufer — hier wird kein Fehlschlag zu einem leeren Erfolg.
      return { status: antwort.status, body: json };
    },
  };
}

export default { createC2HttpTransport, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, FUNCTION_PATH };
