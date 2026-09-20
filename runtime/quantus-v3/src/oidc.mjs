/* ══ E2 — Identitaet an der vertrauenswuerdigen Grenze ════════════════════
 *
 * Cloud Scheduler und Cloud Tasks rufen mit einem von Google ausgestellten
 * OIDC-ID-Token auf (`Authorization: Bearer …`). Geprueft werden hier
 *
 *   · Kopf: `alg` aus einer festen Liste (RS256), `kid` vorhanden,
 *           `alg: none` und Algorithmusverwirrung ausgeschlossen
 *   · Signatur gegen den oeffentlichen Schluessel zu genau dieser `kid`
 *   · `iss` aus einer festen Liste
 *   · `aud` EXAKT die fuer DIESE Route konfigurierte Kennung
 *   · `exp` ohne Toleranz, `iat` hoechstens 60 s in der Zukunft
 *   · `email_verified === true` und `email` in der Liste der fuer DIESE
 *     Route zugelassenen Dienstkonten
 *
 * Es wird NICHTS aus dem Rumpf geglaubt: weder Rolle noch Mandant, weder
 * IAM-Bindung noch Fence. Was der Aufrufer behauptet, interessiert nicht —
 * es zaehlt, was Google signiert hat und was die Serverkonfiguration
 * fuer diese Route zulaesst.
 *
 * Jede fehlgeschlagene Pruefung ergibt DENSELBEN Aussenwert (401
 * `unauthenticated`); der Grund bleibt im Log. Sonst wird die Pruefung zum
 * Orakel.
 * ═════════════════════════════════════════════════════════════════════════ */
import { createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.mjs";

export const ALLOWED_ALGORITHMS = Object.freeze(["RS256"]);
export const GOOGLE_ISSUERS = Object.freeze(["https://accounts.google.com", "accounts.google.com"]);
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const IAT_FUTURE_TOLERANCE_MS = 60_000;
export const MAX_TOKEN_BYTES = 8 * 1024;

class TokenRejected extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function b64urlToBuffer(part) {
  if (typeof part !== "string" || !/^[A-Za-z0-9_-]*$/.test(part)) throw new TokenRejected("base64url_invalid");
  return Buffer.from(part, "base64url");
}

function decodeJsonSegment(part, what) {
  const buf = b64urlToBuffer(part);
  if (buf.length === 0 || buf.length > 8192) throw new TokenRejected(`${what}_size`);
  let value;
  try { value = JSON.parse(buf.toString("utf8")); } catch { throw new TokenRejected(`${what}_json`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TokenRejected(`${what}_shape`);
  return value;
}

function selectKey(jwks, kid) {
  if (!jwks || !Array.isArray(jwks.keys)) throw new TokenRejected("jwks_shape");
  const candidates = jwks.keys.filter((k) => k && k.kid === kid);
  if (candidates.length !== 1) throw new TokenRejected("kid_unknown");
  const jwk = candidates[0];
  if (jwk.kty !== "RSA") throw new TokenRejected("kty_unsupported");
  if (jwk.alg !== undefined && jwk.alg !== "RS256") throw new TokenRejected("key_alg_mismatch");
  if (jwk.use !== undefined && jwk.use !== "sig") throw new TokenRejected("key_use_mismatch");
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new TokenRejected("jwk_incomplete");
  try {
    return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch { throw new TokenRejected("jwk_unusable"); }
}

function equalsConstantTime(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * @param token      das rohe Bearer-Token
 * @param options    { audience, allowedServiceAccounts, jwks, now, issuers? }
 * @returns { ok: true, principal } — wirft sonst HttpError 401 ohne Grund.
 */
export function verifyGoogleIdToken(token, options = {}) {
  const { audience, allowedServiceAccounts, jwks, now } = options;
  const issuers = options.issuers || GOOGLE_ISSUERS;
  if (typeof audience !== "string" || !audience) throw new HttpError(503, "oidc_audience_not_configured");
  if (!Array.isArray(allowedServiceAccounts) || allowedServiceAccounts.length === 0) {
    throw new HttpError(503, "oidc_callers_not_configured");
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw new HttpError(500, "server_clock_invalid");

  try {
    if (typeof token !== "string" || !token) throw new TokenRejected("token_missing");
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new TokenRejected("token_too_large");
    const parts = token.split(".");
    if (parts.length !== 3) throw new TokenRejected("token_parts");

    const header = decodeJsonSegment(parts[0], "header");
    if (!ALLOWED_ALGORITHMS.includes(header.alg)) throw new TokenRejected("alg_not_allowed");
    if (typeof header.kid !== "string" || !header.kid) throw new TokenRejected("kid_missing");
    if (header.typ !== undefined && header.typ !== "JWT") throw new TokenRejected("typ_mismatch");
    if (header.crit !== undefined) throw new TokenRejected("crit_unsupported");

    const key = selectKey(jwks, header.kid);
    const signature = b64urlToBuffer(parts[2]);
    if (signature.length === 0) throw new TokenRejected("signature_empty");
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    if (!cryptoVerify("RSA-SHA256", signingInput, key, signature)) throw new TokenRejected("signature_invalid");

    const claims = decodeJsonSegment(parts[1], "payload");
    if (typeof claims.iss !== "string" || !issuers.includes(claims.iss)) throw new TokenRejected("iss_mismatch");
    if (typeof claims.aud !== "string") throw new TokenRejected("aud_type");     // Google stellt aud als String aus
    if (!equalsConstantTime(claims.aud, audience)) throw new TokenRejected("aud_mismatch");
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw new TokenRejected("sub_invalid");

    for (const field of ["exp", "iat"]) {
      if (!Number.isSafeInteger(claims[field]) || claims[field] <= 0) throw new TokenRejected(`${field}_invalid`);
    }
    if (claims.exp * 1000 <= now) throw new TokenRejected("expired");
    if (claims.iat * 1000 > now + IAT_FUTURE_TOLERANCE_MS) throw new TokenRejected("iat_future");
    if (claims.nbf !== undefined) {
      if (!Number.isSafeInteger(claims.nbf)) throw new TokenRejected("nbf_invalid");
      if (claims.nbf * 1000 > now + IAT_FUTURE_TOLERANCE_MS) throw new TokenRejected("not_yet_valid");
    }

    if (claims.email_verified !== true) throw new TokenRejected("email_not_verified");
    if (typeof claims.email !== "string" || !claims.email) throw new TokenRejected("email_missing");
    const email = claims.email.toLowerCase();
    if (!allowedServiceAccounts.some((allowed) => equalsConstantTime(email, allowed.toLowerCase()))) {
      throw new TokenRejected("caller_not_allowed");
    }

    return {
      ok: true,
      principal: Object.freeze({
        kind: "service",
        issuedVia: "google_oidc",
        email,
        subject: claims.sub,
        audience,
        expiresAtMs: claims.exp * 1000,
      }),
    };
  } catch (err) {
    if (err instanceof TokenRejected) {
      // Aussen immer derselbe Wert — der Grund nur ins Log.
      throw new HttpError(401, "unauthenticated", null, { logDetail: { reason: err.reason } });
    }
    throw err;
  }
}

/* Bearer-Token aus der Kopfzeile holen — ohne Vermutungen. */
export function readBearerToken(headers) {
  const raw = headers && (headers.authorization ?? headers.Authorization);
  if (typeof raw !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(raw.trim());
  return match ? match[1] : null;
}
