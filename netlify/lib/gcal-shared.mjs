// ============================================================================
//  GOOGLE CALENDAR — Shared helpers for the OAuth + API-proxy functions
//  ---------------------------------------------------------------------------
//  Lives OUTSIDE netlify/functions so Netlify does NOT expose it as its own
//  endpoint. esbuild bundles it into each importing function automatically.
//
//  Security model (mirrors blob-get / blob-put):
//   • Client-ID / Client-Secret come from env vars, never from the frontend.
//   • Refresh-Token + Access-Token are stored server-side in Netlify Blobs.
//   • Frontend calls are authorised with the same optional SYNC_AUTH_TOKEN
//     bearer that the existing sync endpoints use.
// ============================================================================
import { getStore } from "@netlify/blobs";

export const TOKEN_KEY = "gcal-tokens";
export const STATE_KEY = "gcal-oauth-state";
export const STORE_NAME = "app-sync";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
// Only the Calendar scope is requested (per spec). The user's account e-mail is
// read from the primary calendar instead of asking for extra openid/email scopes.
export const SCOPE = "https://www.googleapis.com/auth/calendar";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extraHeaders },
  });
}

function env(name) {
  // Works both in the Netlify runtime (Netlify.env) and plain Node (process.env).
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch (e) { /* ignore */ }
  return (typeof process !== "undefined" && process.env) ? process.env[name] : undefined;
}

// ── Authorisation: identical bearer-token logic to blob-get / blob-put ──
export function requireAuth(req) {
  const expected = env("SYNC_AUTH_TOKEN");
  if (!expected) return null; // no token configured → open (same as existing endpoints)
  const provided = req.headers.get("Authorization") || "";
  if (provided === expected || provided === "Bearer " + expected) return null;
  return json({ error: "Unauthorized" }, 401);
}

export function getOAuthConfig() {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET sind nicht gesetzt. Bitte als Netlify-Umgebungsvariablen hinterlegen."
    );
  }
  return { clientId, clientSecret };
}

// Redirect-URI must match Google Cloud Console exactly. Prefer the explicit env
// var; otherwise derive it from the incoming request (proxy-aware).
export function getRedirectUri(req) {
  const explicit = env("GCAL_REDIRECT_URI");
  if (explicit) return explicit;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const origin = host ? `${proto}://${host}` : new URL(req.url).origin;
  return `${origin}/.netlify/functions/gcal-auth`;
}

// App origin to bounce the browser back to after the OAuth dance.
export function getAppOrigin(req) {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

function store() {
  return getStore(STORE_NAME);
}

export async function loadTokens() {
  try {
    const raw = await store().get(TOKEN_KEY, { type: "text" });
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export async function saveTokens(tokens) {
  await store().set(TOKEN_KEY, JSON.stringify(tokens));
}

export async function clearTokens() {
  try { await store().delete(TOKEN_KEY); } catch (e) { /* ignore */ }
}

export async function saveState(state) {
  await store().set(STATE_KEY, JSON.stringify({ state, ts: Date.now() }));
}

export async function consumeState(state) {
  try {
    const raw = await store().get(STATE_KEY, { type: "text" });
    try { await store().delete(STATE_KEY); } catch (e) { /* ignore */ }
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    // 10-minute validity window
    if (!parsed || parsed.state !== state) return false;
    if (Date.now() - (parsed.ts || 0) > 10 * 60 * 1000) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// Exchange an authorization code for tokens.
export async function exchangeCode(code, req) {
  const { clientId, clientSecret } = getOAuthConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(req),
    grant_type: "authorization_code",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error("Token-Exchange fehlgeschlagen: " + (data.error_description || data.error || r.status));
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expiry: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope || SCOPE,
    connectedAt: new Date().toISOString(),
    email: null,
  };
}

// Refresh the access token using the stored refresh token.
async function refreshAccessToken(tokens) {
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Kein Refresh-Token vorhanden – bitte neu mit Google verbinden.");
  }
  const { clientId, clientSecret } = getOAuthConfig();
  const body = new URLSearchParams({
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error("Token-Refresh fehlgeschlagen: " + (data.error_description || data.error || r.status));
  }
  const updated = {
    ...tokens,
    access_token: data.access_token,
    expiry: Date.now() + (data.expires_in || 3600) * 1000,
    // Google usually does NOT return a new refresh_token on refresh → keep old.
    refresh_token: data.refresh_token || tokens.refresh_token,
    scope: data.scope || tokens.scope,
  };
  await saveTokens(updated);
  return updated;
}

// Returns a valid (non-expired) access token, refreshing transparently.
export async function getValidAccessToken({ forceRefresh = false } = {}) {
  let tokens = await loadTokens();
  if (!tokens) throw new Error("NOT_CONNECTED");
  const needsRefresh = forceRefresh || !tokens.access_token || Date.now() > (tokens.expiry || 0) - 60 * 1000;
  if (needsRefresh) tokens = await refreshAccessToken(tokens);
  return { token: tokens.access_token, tokens };
}

export async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch (e) { /* best effort */ }
}
