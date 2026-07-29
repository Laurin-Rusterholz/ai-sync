// ============================================================================
//  GOOGLE CALENDAR — OAuth 2.0 endpoint
//  ---------------------------------------------------------------------------
//   GET ?action=login    → 302 redirect to Google's consent screen
//   GET ?code=…&state=…   → OAuth callback: exchange code → store tokens
//   GET ?action=status    → { connected, email, expiresAt, scope }
//   GET/POST ?action=logout → revoke + delete stored tokens
//
//  Secrets (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are read from env only.
//  The browser never sees the client secret or the refresh token.
// ============================================================================
import {
  CORS, json, requireAuth, getOAuthConfig, getRedirectUri, getAppOrigin,
  GOOGLE_AUTH_URL, SCOPE, saveState, consumeState, exchangeCode,
  loadTokens, saveTokens, clearTokens, getValidAccessToken, revokeToken,
  CALENDAR_API_BASE,
} from "../lib/gcal-shared.mjs";
import { createHmac, timingSafeEqual } from "node:crypto";

function randomState() {
  // 32 hex chars of CSPRNG
  const arr = new Uint8Array(16);
  (globalThis.crypto || crypto).getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Where the browser is bounced back to after the OAuth dance. Whitelisted so a
// crafted ?return= value can never redirect into an arbitrary in-app route.
const RETURN_ROUTES = new Set(["googlecalendar", "gmail"]);
const FIREBASE_BOOTSTRAP_SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/devstorage.full_control",
].join(" ");
const FIREBASE_BOOTSTRAP_TARGET = "https://app.netlify.com/projects/management-xo2-pro/configuration/env";

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function firebaseBootstrapState() {
  const { clientSecret } = getOAuthConfig();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const payload = `firebase.${expiresAt}.${randomState()}`;
  const signature = base64url(createHmac("sha256", clientSecret).update(payload).digest());
  return `${payload}.${signature}`;
}

function isFirebaseBootstrapState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 4 || parts[0] !== "firebase") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + 11 * 60 * 1000) return false;
  const payload = parts.slice(0, 3).join(".");
  const { clientSecret } = getOAuthConfig();
  const expected = Buffer.from(base64url(createHmac("sha256", clientSecret).update(payload).digest()));
  const received = Buffer.from(parts[3]);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function sanitizeReturn(raw) {
  const r = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  return RETURN_ROUTES.has(r) ? r : "googlecalendar";
}
// The OAuth state carries the CSRF nonce AND the return route ("<nonce>.<route>")
// so the callback knows which app initiated the connect — no schema change to
// the stored state blob is needed and old "<nonce>" states still validate.
function returnFromState(state) {
  const route = String(state || "").split(".")[1];
  return RETURN_ROUTES.has(route) ? route : "googlecalendar";
}

function htmlError(message, appOrigin) {
  const safe = String(message).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Google Calendar</title>` +
    `<body style="font-family:system-ui;background:#1c1c1e;color:#f5f5f7;padding:40px;line-height:1.6">` +
    `<h2>⚠️ Google-Calendar-Verbindung fehlgeschlagen</h2>` +
    `<p style="color:#ff9f0a">${safe}</p>` +
    `<p><a style="color:#0a84ff" href="${appOrigin}/#/googlecalendar">Zurück zu Quantus</a></p>` +
    `</body>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } }
  );
}

// Try to enrich stored tokens with the account e-mail (= primary calendar id).
async function ensureEmail(tokens) {
  if (tokens.email) return tokens;
  try {
    const { token } = await getValidAccessToken();
    const r = await fetch(CALENDAR_API_BASE + "/calendars/primary", {
      headers: { Authorization: "Bearer " + token },
    });
    if (r.ok) {
      const cal = await r.json();
      if (cal && cal.id) {
        const fresh = await loadTokens();
        if (fresh) { fresh.email = cal.id; await saveTokens(fresh); return fresh; }
      }
    }
  } catch (e) { /* ignore – email is cosmetic */ }
  return tokens;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  const appOrigin = getAppOrigin(req);

  // ── OAuth callback (Google redirects here with ?code=… or ?error=…) ──
  if (code || oauthError) {
    if (oauthError) return htmlError("Google meldete: " + oauthError, appOrigin);
    try {
      const state = url.searchParams.get("state") || "";
      if (isFirebaseBootstrapState(state)) {
        const tokens = await exchangeCode(code, req);
        if (!tokens.refresh_token) {
          return htmlError("Google hat kein Refresh-Token geliefert. Bitte den Zugriff erneut bestätigen.", appOrigin);
        }
        const handoff = base64url(tokens.refresh_token);
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${FIREBASE_BOOTSTRAP_TARGET}#firebase-oauth-refresh=${encodeURIComponent(handoff)}`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            ...CORS,
          },
        });
      }
      const ok = await consumeState(state);
      if (!ok) return htmlError("Ungültiger oder abgelaufener State (CSRF-Schutz). Bitte erneut verbinden.", appOrigin);

      const tokens = await exchangeCode(code, req);
      if (!tokens.refresh_token) {
        // Keep any previously stored refresh token if Google didn't return one.
        const prev = await loadTokens();
        if (prev && prev.refresh_token) tokens.refresh_token = prev.refresh_token;
      }
      await saveTokens(tokens);
      await ensureEmail(tokens);

      // Bounce back into the app, onto whichever app started the connect. The
      // query stays BEFORE the hash so the app's parseHash() (which splits the
      // hash on "/") sees a clean route.
      const ret = returnFromState(state);
      return new Response(null, {
        status: 302,
        headers: { Location: `${appOrigin}/?gcal=connected#/${ret}`, ...CORS },
      });
    } catch (e) {
      return htmlError(e.message || String(e), appOrigin);
    }
  }

  // ── Start login: redirect to Google consent screen ──
  if (action === "login") {
    try {
      const { clientId } = getOAuthConfig();
      // Fold the desired return route into the CSRF state so the callback can
      // send the user back to the app that initiated the connect.
      const state = randomState() + "." + sanitizeReturn(url.searchParams.get("return"));
      await saveState(state);
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: getRedirectUri(req),
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",       // → refresh token for durable access
        prompt: "consent",            // → always issue a refresh token
        include_granted_scopes: "true",
        state,
      });
      return new Response(null, {
        status: 302,
        headers: { Location: `${GOOGLE_AUTH_URL}?${params.toString()}`, ...CORS },
      });
    } catch (e) {
      return htmlError(e.message || String(e), appOrigin);
    }
  }

  // A short-lived, state-signed bootstrap path for Firebase when organisation
  // policy forbids service-account private keys. The token is handed directly
  // to Netlify's environment editor and is never written to RTDB or a browser
  // cache. Remove this route after the one-time setup has completed.
  if (action === "firebase-bootstrap") {
    try {
      const { clientId } = getOAuthConfig();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: getRedirectUri(req),
        response_type: "code",
        scope: FIREBASE_BOOTSTRAP_SCOPES,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: firebaseBootstrapState(),
      });
      return new Response(null, {
        status: 302,
        headers: { Location: `${GOOGLE_AUTH_URL}?${params.toString()}`, ...CORS },
      });
    } catch (e) {
      return htmlError(e.message || String(e), appOrigin);
    }
  }

  // The remaining actions are data endpoints → honour the optional bearer.
  const auth = requireAuth(req);
  if (auth) return auth;

  // ── Connection status ──
  if (action === "status") {
    let tokens = await loadTokens();
    if (!tokens) return json({ connected: false });
    tokens = await ensureEmail(tokens);
    return json({
      connected: true,
      email: tokens.email || null,
      scope: tokens.scope || SCOPE,
      connectedAt: tokens.connectedAt || null,
      expiresAt: tokens.expiry || null,
      hasRefreshToken: !!tokens.refresh_token,
    });
  }

  // ── Logout / disconnect ──
  if (action === "logout") {
    const tokens = await loadTokens();
    if (tokens) await revokeToken(tokens.refresh_token || tokens.access_token);
    await clearTokens();
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};

export const config = { path: "/.netlify/functions/gcal-auth" };
