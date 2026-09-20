/* ══ E2 — Google-Strecken: JWKS und Cloud Tasks ═══════════════════════════
 *
 * Zwei Wege nach Google, beide mit der VORHANDENEN Identitaet:
 *
 *  1. JWKS — die oeffentlichen Schluessel, gegen die eingehende
 *     OIDC-Token von Scheduler und Tasks geprueft werden. Oeffentlich,
 *     also ohne jedes Zugangsdatum. Neue Rechte braucht das nicht.
 *
 *  2. Cloud Tasks — das Einreihen einer Fortsetzung. Das braucht ein
 *     Zugriffstoken. Es wird NICHT hier beschafft: `firebase-admin.mjs`
 *     des Integrationsstandes exportiert seit C3b (f39cad2)
 *     `getIdentityAccessToken({ scope })` und laesst ausdruecklich
 *     `cloud-platform` zu. Genau dieser Export wird benutzt — dynamisch,
 *     nur beim Namen genannt, nichts davon nachgebaut, keine zweite
 *     Zugangslogik, kein neues Dienstkonto.
 *
 * FAIL CLOSED, UEBERALL
 * ---------------------
 * Fehlt der Export, fehlen die Zugangsdaten, traegt das Token den noetigen
 * Scope nicht, oder ist die Aussenwirkung nicht freigegeben: dann gibt es
 * KEINEN Port, sondern einen benannten Grund — und die Route antwortet
 * 503. Es wird nichts eingereiht und nichts vorgetaeuscht.
 *
 * Kein Wert verlaesst diese Datei: kein Token, kein Zugangsdatum, kein
 * privater Schluessel. Nur Namen, Scopes und HTTP-Status.
 * ═════════════════════════════════════════════════════════════════════════ */
import { HttpError } from "./errors.mjs";

/* ── 1. JWKS ──────────────────────────────────────────────────────────── */

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const JWKS_MIN_TTL_MS = 60_000;
export const JWKS_MAX_TTL_MS = 6 * 60 * 60 * 1000;
export const JWKS_MAX_BYTES = 64 * 1024;

function pruefeJwks(dokument) {
  if (dokument === null || typeof dokument !== "object" || Array.isArray(dokument)) return null;
  if (!Array.isArray(dokument.keys) || dokument.keys.length === 0 || dokument.keys.length > 32) return null;
  const gesehen = new Set();
  for (const jwk of dokument.keys) {
    if (jwk === null || typeof jwk !== "object") return null;
    if (typeof jwk.kid !== "string" || !jwk.kid || gesehen.has(jwk.kid)) return null;
    gesehen.add(jwk.kid);
    if (jwk.kty !== "RSA") return null;
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") return null;
    if (jwk.use !== undefined && jwk.use !== "sig") return null;
  }
  return { keys: dokument.keys.map((k) => Object.freeze({ ...k })) };
}

function ttlAus(header, jetzt) {
  const raw = typeof header === "string" ? header : "";
  const treffer = /(?:^|,\s*)max-age=(\d{1,7})/i.exec(raw);
  if (!treffer) return jetzt + JWKS_MIN_TTL_MS;
  const sekunden = Number(treffer[1]);
  if (!Number.isSafeInteger(sekunden) || sekunden <= 0) return jetzt + JWKS_MIN_TTL_MS;
  return jetzt + Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, sekunden * 1000));
}

/**
 * Der JWKS-Port. Gecacht bis zum von Google genannten Ablauf, ein
 * gemeinsamer Abruf fuer parallele Anfragen, und KEIN Weiterreichen eines
 * abgelaufenen Standes: wer nicht frisch pruefen kann, prueft nicht.
 */
export function createGoogleJwksPort({ fetchImpl = globalThis.fetch, now = () => Date.now(), url = GOOGLE_JWKS_URL, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== "function") return { available: false, reason: "google_jwks_fetch_not_available", impl: null };
  let stand = null;          // { keys, expiresAtMs }
  let laufend = null;

  async function hole() {
    const abbruch = new AbortController();
    const frist = setTimeout(() => abbruch.abort(), Math.max(1, timeoutMs));
    let antwort;
    try {
      antwort = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: abbruch.signal });
    } catch {
      throw new HttpError(503, "jwks_unavailable");
    } finally {
      clearTimeout(frist);
    }
    if (!antwort || antwort.status !== 200) throw new HttpError(503, "jwks_unavailable");
    let text;
    try { text = await antwort.text(); } catch { throw new HttpError(503, "jwks_unavailable"); }
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > JWKS_MAX_BYTES) throw new HttpError(503, "jwks_unavailable");
    let dokument;
    try { dokument = JSON.parse(text); } catch { throw new HttpError(503, "jwks_unavailable"); }
    const geprueft = pruefeJwks(dokument);
    if (!geprueft) throw new HttpError(503, "jwks_invalid");
    const cacheControl = antwort.headers && typeof antwort.headers.get === "function" ? antwort.headers.get("cache-control") : null;
    return { keys: Object.freeze(geprueft.keys), expiresAtMs: ttlAus(cacheControl, now()) };
  }

  return {
    available: true,
    reason: null,
    impl: {
      async getKeys() {
        const jetzt = now();
        if (stand && stand.expiresAtMs > jetzt) return { keys: stand.keys };
        if (laufend) return laufend;
        laufend = hole().then(
          (frisch) => { stand = frisch; laufend = null; return { keys: frisch.keys }; },
          (err) => { laufend = null; stand = null; throw err; },
        );
        return laufend;
      },
      /* Nur Diagnose, nie ein Wert. */
      state(nowMs = now()) {
        return { cached: Boolean(stand), fresh: Boolean(stand && stand.expiresAtMs > nowMs) };
      },
    },
  };
}

/* ── 2. Zugriffstoken aus der vorhandenen Google-Identitaet ───────────── */

export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const FIREBASE_TOKEN_EXPORT = "getIdentityAccessToken";
export const FIREBASE_CREDENTIALS_EXPORT = "firebaseAccessCredentialsConfigured";
export const TOKEN_MARGIN_MS = 60_000;

async function ladeFirebaseAdmin() {
  return import("../../../netlify/lib/firebase-admin.mjs");
}

/**
 * Eine Tokenquelle fuer `cloud-platform` — aus dem vorhandenen Export von
 * `firebase-admin.mjs`. Kein neues Dienstkonto, kein zweiter Signaturweg.
 *
 * @returns { ok: true, get } | { ok: false, reason }
 */
export async function createGoogleAccessTokenSource({ loadFirebaseAdmin = ladeFirebaseAdmin, now = () => Date.now(), scope = CLOUD_PLATFORM_SCOPE } = {}) {
  let admin;
  try { admin = await loadFirebaseAdmin(); } catch { return { ok: false, reason: "firebase_admin_not_available" }; }
  if (!admin || typeof admin[FIREBASE_TOKEN_EXPORT] !== "function") {
    return { ok: false, reason: `missing_export:${FIREBASE_TOKEN_EXPORT}` };
  }
  // Ein Weg, der bei jedem Aufruf nur scheitern kann, ist kein Weg.
  const pruefung = admin[FIREBASE_CREDENTIALS_EXPORT];
  if (typeof pruefung === "function") {
    let konfiguriert = false;
    try { konfiguriert = pruefung() === true; } catch { konfiguriert = false; }
    if (!konfiguriert) return { ok: false, reason: "google_credentials_not_configured" };
  }

  let token = null;
  let bis = 0;
  let laufend = null;

  async function frisch() {
    let erworben;
    try {
      erworben = await admin[FIREBASE_TOKEN_EXPORT]({ scope });
    } catch {
      // Die Modulgrenze: kein fremder Text, kein Wert, kein `cause`.
      throw new HttpError(503, "google_token_failed");
    }
    if (!erworben || typeof erworben.token !== "string" || !erworben.token) throw new HttpError(503, "google_token_failed");
    if (typeof erworben.scope === "string" && !erworben.scope.split(/\s+/).includes(scope)) {
      throw new HttpError(503, "google_token_scope_missing");
    }
    const ablauf = Number(erworben.expiresAt);
    if (!Number.isFinite(ablauf)) throw new HttpError(503, "google_token_lifetime_invalid");
    // Die Marge gilt fuer JEDES Token, auch fuer ein eben erworbenes —
    // ein Erwerb kann dauern, deshalb frische Zeit NACH dem await.
    if (ablauf - TOKEN_MARGIN_MS <= now()) throw new HttpError(503, "google_token_expired");
    return { token: erworben.token, expiresAt: ablauf };
  }

  return {
    ok: true,
    reason: null,
    scope,
    async get() {
      const jetzt = now();
      if (token && bis - TOKEN_MARGIN_MS > jetzt) return token;
      if (laufend) return laufend;
      laufend = frisch().then(
        (neu) => { token = neu.token; bis = neu.expiresAt; laufend = null; return token; },
        (err) => { laufend = null; token = null; bis = 0; throw err; },
      );
      return laufend;
    },
  };
}

/* ── 3. Cloud-Tasks-Transport ─────────────────────────────────────────── */

/**
 * Der Transport, den `createCloudTasksPort` erwartet: er nimmt die fertig
 * gebaute Anfrage und setzt sie ab. Er entscheidet nichts ueber ihren
 * Inhalt — und er reiht nur ein, wenn die Aussenwirkung freigegeben ist.
 *
 * @param allowExternalEffects  `externalEffectsAllowed(config)` — ohne das
 *                              wird NICHTS abgesetzt (Trockenlauf/Schatten).
 */
export function createCloudTasksHttpTransport({ accessTokenSource, fetchImpl = globalThis.fetch, allowExternalEffects = false, timeoutMs = 15_000 } = {}) {
  if (!accessTokenSource || typeof accessTokenSource.get !== "function") {
    return { ok: false, reason: "google_access_token_not_available", transport: null };
  }
  if (typeof fetchImpl !== "function") return { ok: false, reason: "google_fetch_not_available", transport: null };
  if (allowExternalEffects !== true) return { ok: false, reason: "external_effects_not_allowed", transport: null };

  return {
    ok: true,
    reason: null,
    transport: {
      async createTask({ url, method, payload }) {
        if (typeof url !== "string" || !url.startsWith("https://cloudtasks.googleapis.com/")) {
          throw new HttpError(500, "cloud_tasks_url_invalid");
        }
        if (method !== "POST") throw new HttpError(500, "cloud_tasks_method_invalid");
        const token = await accessTokenSource.get();
        const abbruch = new AbortController();
        const frist = setTimeout(() => abbruch.abort(), Math.max(1, timeoutMs));
        let antwort;
        try {
          antwort = await fetchImpl(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(payload),
            signal: abbruch.signal,
          });
        } catch {
          throw new HttpError(502, "cloud_tasks_request_failed");
        } finally {
          clearTimeout(frist);
        }
        if (!antwort || typeof antwort.status !== "number") throw new HttpError(502, "cloud_tasks_response_invalid");
        let rumpf = null;
        try {
          const text = await antwort.text();
          if (text) rumpf = JSON.parse(text);
        } catch { rumpf = null; }
        // Google nennt den Grund im Statusfeld; `ALREADY_EXISTS` ist die
        // erwartete Antwort auf einen stabilen Namen und kein Fehler.
        const kennung = rumpf && rumpf.error && typeof rumpf.error.status === "string" ? rumpf.error.status : null;
        return { status: antwort.status, error: kennung, name: rumpf && typeof rumpf.name === "string" ? rumpf.name : null };
      },
    },
  };
}

export default {
  createGoogleJwksPort, createGoogleAccessTokenSource, createCloudTasksHttpTransport,
  GOOGLE_JWKS_URL, CLOUD_PLATFORM_SCOPE, FIREBASE_TOKEN_EXPORT, JWKS_MIN_TTL_MS, JWKS_MAX_TTL_MS,
};
