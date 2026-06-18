// ============================================================================
//  GMAIL — Authenticated API proxy (Gmail API v1)
//  ---------------------------------------------------------------------------
//  Mirrors gcal-api.mjs: the frontend never holds a Google token. It POSTs a
//  small RPC envelope and this function attaches a valid (auto-refreshed)
//  access token and forwards the request to https://gmail.googleapis.com.
//
//  Auth is SHARED with the calendar app — both use the single refresh token in
//  Netlify Blobs (key "gcal-tokens"), whose scope list now also contains
//  gmail.modify (see netlify/lib/gcal-shared.mjs → SCOPES).
//
//  Body: { method, path, query?, body? }
//    method : GET | POST | PUT | PATCH | DELETE
//    path   : e.g. "/users/me/profile"
//             "/users/me/labels"            "/users/me/labels/<id>"
//             "/users/me/messages"          (list)
//             "/users/me/messages/<id>"     (get)
//             "/users/me/messages/send"     (send)
//             "/users/me/messages/<id>/modify"  (labels / read-unread)
//             "/users/me/threads"           "/users/me/threads/<id>"
//    query  : object of query params (q, labelIds, maxResults, format, …)
//    body   : JSON body for POST/PATCH (e.g. { raw } or { addLabelIds, … })
// ============================================================================
import {
  CORS, json, requireAuth, getValidAccessToken, GMAIL_API_BASE,
} from "../lib/gcal-shared.mjs";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Whitelist of Gmail API paths we are willing to proxy. Message / thread / label
// ids are URL-encoded by the frontend, so a single path segment never contains a
// raw slash ("[^/?#]+"). Covered (exactly the endpoints the Gmail app needs):
//   users.getProfile         GET    /users/me/profile
//   users.labels.list/get    GET    /users/me/labels[/<id>]
//   users.messages.list      GET    /users/me/messages
//   users.messages.get       GET    /users/me/messages/<id>
//   users.messages.send      POST   /users/me/messages/send
//   users.messages.modify    POST   /users/me/messages/<id>/modify
//   users.threads.list/get   GET    /users/me/threads[/<id>]
//   users.threads.modify     POST   /users/me/threads/<id>/modify
// The "(?!send\/)" guard keeps the literal send endpoint from also matching the
// "<id>/modify" shape, so a bogus "/messages/send/modify" is rejected up front.
const ALLOWED_PATH = /^\/users\/me\/(profile|labels(\/[^/?#]+)?|messages(\/(?!send\/)[^/?#]+(\/modify)?)?|threads(\/[^/?#]+(\/modify)?)?)$/;

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
    if (v === undefined || v === null || v === "") continue;
    // labelIds / metadataHeaders may be arrays → repeat the key per value.
    if (Array.isArray(v)) {
      for (const item of v) { if (item !== undefined && item !== null && item !== "") qs.append(k, String(item)); }
    } else {
      qs.append(k, String(v));
    }
  }
  const fullUrl = GMAIL_API_BASE + path + (qs.toString() ? "?" + qs.toString() : "");

  try {
    let { token } = await getValidAccessToken();
    let r = await callGoogle(method, fullUrl, body, token);

    // If Google rejects the token, force one refresh and retry.
    if (r.status === 401) {
      ({ token } = await getValidAccessToken({ forceRefresh: true }));
      r = await callGoogle(method, fullUrl, body, token);
    }

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

export const config = { path: "/.netlify/functions/gmail-api" };
