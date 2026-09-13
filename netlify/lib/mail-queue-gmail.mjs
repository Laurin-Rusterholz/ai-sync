/* Gmail-Zugriff fuer die Warteschlange — derselbe Weg wie gmail-api.mjs:
   der Token liegt serverseitig (Firebase RTDB, integrations/google/tokens) und
   deckt mit gmail.modify sowohl users.drafts.* als auch users.messages.send ab
   (Discovery v1, Revision 20260907). Kein neuer Scope, kein neues Secret. */
import { getValidAccessToken, GMAIL_API_BASE } from "./gcal-shared.mjs";

export async function gmailRuf(method, pfad, { query = {}, body } = {}) {
  const qs = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => { if (v != null && v !== "") qs.append(k, String(v)); });
  const url = GMAIL_API_BASE + pfad + (qs.toString() ? "?" + qs.toString() : "");
  const { token } = await getValidAccessToken();
  const init = { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } };
  if (body !== undefined && method !== "GET" && method !== "DELETE") init.body = JSON.stringify(body);
  const antwort = await fetch(url, init);
  const text = await antwort.text();
  let daten = null;
  try { daten = text ? JSON.parse(text) : null; } catch (e) { daten = null; }
  if (!antwort.ok) {
    const fehler = new Error((daten && daten.error && daten.error.message) || ("Gmail HTTP " + antwort.status));
    fehler.status = antwort.status;
    throw fehler;
  }
  return daten;
}
export default { gmailRuf };
