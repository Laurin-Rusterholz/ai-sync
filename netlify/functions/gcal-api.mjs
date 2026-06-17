// ============================================================================
//  GOOGLE CALENDAR — Authenticated API proxy (Calendar API v3)
//  ---------------------------------------------------------------------------
//  The frontend never holds a Google token. It POSTs a small RPC envelope and
//  this function attaches a valid (auto-refreshed) access token and forwards
//  the request to https://www.googleapis.com/calendar/v3.
//
//  Body: { method, path, query?, body? }
//    method : GET | POST | PUT | PATCH | DELETE
//    path   : e.g. "/users/me/calendarList"
//             "/calendars/<encodedId>/events"
//             "/calendars/<encodedId>/events/<encodedEventId>"
//             "/calendars/<encodedId>/events/<encodedEventId>/move"
//             "/calendars/<encodedId>/events/<encodedEventId>/instances"
//             "/calendars/<encodedId>/events/quickAdd"
//             "/freeBusy"   "/colors"
//    query  : object of query params (timeMin, timeMax, sendUpdates, destination, …)
//    body   : JSON body for POST/PUT/PATCH
// ============================================================================
import {
  CORS, json, requireAuth, getValidAccessToken, CALENDAR_API_BASE,
} from "../lib/gcal-shared.mjs";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// Whitelist of Calendar API paths we are willing to proxy (calendar ids and
// event ids are URL-encoded by the frontend, so they contain no raw slashes).
// Besides the basic calendarList/events/colors routes this also allows the
// per-event sub-actions move + instances (and the events/quickAdd shortcut,
// which matches the generic /events/<id> form) plus the top-level /freeBusy.
const ALLOWED_PATH = /^\/(users\/me\/calendarList(\/[^/?#]+)?|calendars\/[^/?#]+(\/events(\/[^/?#]+(\/(move|instances))?)?)?|freeBusy|colors)$/;

async function callGoogle(method, fullUrl, bodyObj, token) {
  const init = {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  };
  if (bodyObj !== undefined && bodyObj !== null && method !== "GET" && method !== "DELETE") {
    init.body = JSON.stringify(bodyObj);
  }
  return fetch(fullUrl, init);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = requireAuth(req);
  if (auth) return auth;

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const method = String(payload.method || "GET").toUpperCase();
  const path = String(payload.path || "");
  const query = payload.query && typeof payload.query === "object" ? payload.query : {};
  const body = payload.body;

  if (!ALLOWED_METHODS.has(method)) return json({ error: "Method not allowed: " + method }, 400);
  if (!ALLOWED_PATH.test(path)) return json({ error: "Path not allowed: " + path }, 400);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const fullUrl = CALENDAR_API_BASE + path + (qs.toString() ? "?" + qs.toString() : "");

  try {
    let { token } = await getValidAccessToken();
    let r = await callGoogle(method, fullUrl, body, token);

    // If Google rejects the token, force one refresh and retry.
    if (r.status === 401) {
      ({ token } = await getValidAccessToken({ forceRefresh: true }));
      r = await callGoogle(method, fullUrl, body, token);
    }

    // DELETE and some calls return empty bodies.
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }

    if (!r.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || ("HTTP " + r.status);
      return json({ error: msg, status: r.status, details: data }, r.status);
    }
    return json(data === null ? { ok: true } : data, 200);
  } catch (e) {
    if (e.message === "NOT_CONNECTED") {
      return json({ error: "NOT_CONNECTED", message: "Nicht mit Google verbunden." }, 401);
    }
    return json({ error: e.message || String(e) }, 500);
  }
};

export const config = { path: "/.netlify/functions/gcal-api" };
