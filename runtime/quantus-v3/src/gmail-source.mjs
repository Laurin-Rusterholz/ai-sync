/* ══ F — echter, gescopter Nur-Lese-Quellenzugriff: Gmail ═════════════════
 *
 * Liest NUR (list + get einzelner Nachrichten), schreibt nie an Gmail.
 * E-Mail-Inhalt ist DATEN, niemals Instruktion — dieses Modul wertet
 * Betreff/Text/Anhangsnamen an keiner Stelle als Befehl aus, es reicht sie
 * unveraendert (nur laengenbegrenzt) weiter. Die Trennung von Daten und
 * Anweisung geschieht dort, wo der Inhalt in eine Modellanfrage eingeht
 * (siehe anthropic-transport.mjs), nicht hier.
 *
 * Anhaenge: nur Metadaten (Name/Typ/Groesse/attachmentId), NIE die Bytes —
 * bewusst gescopt fuer dieses Paket. Fehlt einer Nachricht eine erwartete
 * attachmentId, gilt die Nachricht als `partial`, nicht als `ok`.
 * ═════════════════════════════════════════════════════════════════════════ */

export const DEFAULT_GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
export const DEFAULT_GMAIL_QUERY = "in:inbox -in:chats";
const MAX_PAGE_SIZE = 25;

function quellFehler(code, detail) {
  return Object.freeze({ code, detail: detail === undefined ? null : detail });
}

async function gmailGet(fetchImpl, apiBase, token, pfad, query, signal) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = `${apiBase}${pfad}${qs.toString() ? "?" + qs.toString() : ""}`;
  let antwort;
  try {
    antwort = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal });
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, error: quellFehler("aborted") };
    return { ok: false, error: quellFehler("unreachable", String((e && e.message) || e)) };
  }
  let body = null;
  try { body = await antwort.json(); } catch { body = null; }
  if (antwort.status === 401 || antwort.status === 403) return { ok: false, error: quellFehler("auth_error", body) };
  if (antwort.status === 429 || antwort.status >= 500) return { ok: false, error: quellFehler("unreachable", body) };
  if (!antwort.ok) return { ok: false, error: quellFehler("unreachable", body) };
  if (!body || typeof body !== "object") return { ok: false, error: quellFehler("unreachable", "empty_body") };
  return { ok: true, body };
}

/**
 * getAccessToken() -> { token } — echtes Zugangsdatum (z. B.
 * netlify/lib/gcal-shared.mjs `getValidAccessToken`), in Tests ersetzbar.
 * fetchImpl — echtes `fetch`, in Tests gegen einen lokalen HTTP-Server.
 */
export function createGmailSourceReader({
  getAccessToken, fetchImpl = fetch, apiBase = DEFAULT_GMAIL_API_BASE,
  query = DEFAULT_GMAIL_QUERY, pageSize = MAX_PAGE_SIZE,
} = {}) {
  if (typeof getAccessToken !== "function") throw new TypeError("getAccessToken erforderlich");
  const groesse = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.isSafeInteger(pageSize) ? pageSize : MAX_PAGE_SIZE));

  async function mitToken(signal) {
    let ergebnis;
    try { ergebnis = await getAccessToken(); } catch (e) { return { ok: false, error: quellFehler("auth_error", String((e && e.message) || e)) }; }
    if (!ergebnis || typeof ergebnis.token !== "string" || !ergebnis.token) return { ok: false, error: quellFehler("auth_error", "empty_token") };
    return { ok: true, token: ergebnis.token };
  }

  return Object.freeze({
    /* Eine Seite Nachrichten-Ids. `sinceMs` grenzt serverseitig auf Gmails
     * eigener Suche ein — das ist der Wasserzeichen-Schnitt zwischen zwei
     * Laeufen, keine eigene Datenbank. */
    async listPage({ pageToken = null, sinceMs = null, signal } = {}) {
      const auth = await mitToken(signal);
      if (!auth.ok) return auth;
      const q = Number.isSafeInteger(sinceMs) ? `${query} after:${Math.floor(sinceMs / 1000)}` : query;
      const res = await gmailGet(fetchImpl, apiBase, auth.token, "/users/me/messages",
        { q, maxResults: groesse, pageToken: pageToken || undefined }, signal);
      if (!res.ok) return res;
      const ids = Array.isArray(res.body.messages) ? res.body.messages.map((m) => String(m.id)) : [];
      return { ok: true, ids, nextPageToken: typeof res.body.nextPageToken === "string" ? res.body.nextPageToken : null };
    },

    /* Metadaten + Anhangsliste EINER Nachricht. Betreff/Snippet sind rohe,
     * ungeprueft weitergereichte Daten (laengenbegrenzt). */
    async getMessage({ id, signal } = {}) {
      if (typeof id !== "string" || !id) return { ok: false, error: quellFehler("unreachable", "id_missing") };
      const auth = await mitToken(signal);
      if (!auth.ok) return auth;
      const res = await gmailGet(fetchImpl, apiBase, auth.token, `/users/me/messages/${encodeURIComponent(id)}`,
        { format: "metadata", metadataHeaders: "Subject" }, signal);
      if (!res.ok) return res;
      const headers = Array.isArray(res.body.payload?.headers) ? res.body.payload.headers : [];
      const subject = headers.find((h) => h && h.name === "Subject")?.value ?? "";
      const parts = Array.isArray(res.body.payload?.parts) ? res.body.payload.parts : [];
      const attachments = parts.filter((p) => p && p.filename).map((p) => ({
        filename: String(p.filename).slice(0, 200),
        mimeType: String(p.mimeType || "").slice(0, 100),
        size: Number.isSafeInteger(p.body?.size) ? p.body.size : 0,
        attachmentId: p.body?.attachmentId ? String(p.body.attachmentId) : null,
      }));
      const unvollstaendig = attachments.some((a) => !a.attachmentId);
      return {
        ok: true,
        partial: unvollstaendig,
        message: {
          id: String(res.body.id),
          threadId: String(res.body.threadId || res.body.id),
          internalDate: Number.isSafeInteger(Number(res.body.internalDate)) ? Number(res.body.internalDate) : null,
          subject: String(subject).slice(0, 500),
          snippet: String(res.body.snippet || "").slice(0, 1000),
          attachments,
        },
      };
    },
  });
}
