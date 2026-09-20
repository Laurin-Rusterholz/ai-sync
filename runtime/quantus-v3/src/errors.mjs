/* ══ E2 — Fehler mit Status und festem Bezeichner ══════════════════════════
 *
 * Jede Absage dieses Dienstes hat einen STABILEN Bezeichner (`error`) und
 * einen Status. Nach aussen geht nur der Bezeichner plus so viel Detail,
 * wie ein Betreiber zur Fehlersuche braucht — nie ein Geheimnis, nie der
 * Grund einer Ausweispruefung, nie eine erlaubte Kennung.
 * ═════════════════════════════════════════════════════════════════════════ */

export class HttpError extends Error {
  constructor(status, error, detail = null, { logDetail = null } = {}) {
    super(detail ? `${error}: ${JSON.stringify(detail)}` : error);
    this.name = "HttpError";
    this.status = status;
    this.error = error;
    this.detail = detail;
    this.logDetail = logDetail;   // bleibt im Log, geht NICHT hinaus
  }
  toBody() {
    return this.detail === null ? { error: this.error } : { error: this.error, detail: this.detail };
  }
}

export function badRequest(error, detail = null) { return new HttpError(400, error, detail); }
export function unauthorized(error = "unauthenticated") { return new HttpError(401, error); }
export function forbidden(error, detail = null) { return new HttpError(403, error, detail); }
export function conflict(error, detail = null) { return new HttpError(409, error, detail); }
export function unavailable(error, detail = null) { return new HttpError(503, error, detail); }

/* Der Kernport und die E1-Mutatoren werfen kodierte Fehler mit `status`
 * und `code`. Sie werden hier in einen HttpError uebersetzt, statt als
 * "internal_error" zu verschwinden — ein 409 aus dem Lease-Fencing ist
 * eine Aussage, kein Serverfehler. */
export function asHttpError(err) {
  if (err instanceof HttpError) return err;
  const status = err && typeof err.status === "number" && err.status >= 400 && err.status <= 599 ? err.status : null;
  const code = err && (typeof err.error === "string" ? err.error : typeof err.code === "string" ? err.code : null);
  if (status === null || !code) return null;
  const mapped = new HttpError(status, code, null, { logDetail: err.detail ?? null });
  return mapped;
}
