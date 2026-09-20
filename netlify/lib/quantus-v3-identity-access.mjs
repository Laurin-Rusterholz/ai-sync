/* ══ Quantus v3 — C3b: Zugriffstoken für die Widerrufsprüfung ═════════════
 *
 * WOZU
 * ----
 * C1 prüft ein Firebase-ID-Token und fragt danach `accounts:lookup`, um
 * gesperrte Nutzer und widerrufene Sitzungen zu erkennen. Dafür braucht der
 * Server ein OAuth-Zugriffstoken. Fehlt es, antwortet C1 mit 503
 * `user_lookup_missing` — ein ID-Token OHNE Widerrufsprüfung wird nie
 * akzeptiert. Diese Datei beschafft genau dieses Token, und nur dieses.
 *
 * DER BEFUND, DER DAS DESIGN BESTIMMT
 * -----------------------------------
 * `netlify/lib/firebase-admin.mjs` hat bereits eine Zugangslogik — aber:
 *   • sie ist NICHT exportiert (`getAdminAccessToken` ist modulintern), und
 *   • ihre Scopes sind `firebase.database`, `userinfo.email` und
 *     `devstorage.full_control` — **kein** `identitytoolkit`.
 * Der vorhandene Admin-Token kann `accounts:lookup` also gar nicht
 * autorisieren. Ein zweiter, eigener Dienstkonto-Signaturweg wäre eine
 * zweite unkontrollierte Credentiallogik — genau das soll es nicht geben.
 *
 * Deshalb diese Reihenfolge, streng benannt und ohne Zwischentöne:
 *   1. `obtainAccessToken`  — ausdrücklich hereingegebener Port (Tests, und
 *                             später der Betrieb, wenn er einen hat).
 *   2. `getIdentityAccessToken` aus firebase-admin — wenn der Eigentümer
 *      dieser Datei einen scope-gebundenen Token EXPORTIERT. Nur der Name
 *      zählt, nichts wird nachgebaut.
 *   3. Refresh-Token-Weg — die EINZIGE Zugangsauflösung, die firebase-admin
 *      heute exportiert (`userRefreshTokenFromEnv`). Wir tauschen damit ein
 *      Zugriffstoken; die Zugangsdaten selbst werden nicht von uns gelesen,
 *      zusammengesetzt oder gespeichert.
 *   4. Sonst: **503**, mit Namen des fehlenden Gates. Kein Dienstkonto-JWT
 *      aus dieser Datei, kein Client-API-Key, kein „dann eben ohne Prüfung".
 *
 * WEITERE REGELN
 * --------------
 * • SCOPE-GEBUNDEN. Der Token muss `identitytoolkit` (oder das übergeordnete
 *   `cloud-platform`) tragen. Google nennt die gewährten Scopes in der
 *   Antwort; fehlt der nötige, ist das ein Fehler und kein Versuch wert.
 * • PROJEKTGEBUNDEN. Das v3-Projekt muss dasselbe sein wie das Firebase-
 *   Projekt. Sonst würde die Sperrprüfung im falschen Verzeichnis nachsehen
 *   und jeden für ungesperrt halten.
 * • CACHE MIT MARGE, EINMAL HOLEN. Ein Token wird bis kurz vor Ablauf
 *   wiederverwendet (Marge 60 s); parallele Anfragen teilen sich EINEN Abruf.
 * • NIE IN LOG ODER ANTWORT. Diese Datei schreibt nichts ins Log und gibt
 *   Fehler nur als feste Kennungen zurück. Der Token verlässt das Modul nur
 *   als Rückgabewert an den Aufrufer, der ihn in die Authorization-Kopfzeile
 *   setzt.
 * ═══════════════════════════════════════════════════════════════════════ */

import { envRead } from "./quantus-v3-auth.mjs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const IDENTITY_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const EXPIRY_MARGIN_MS = 60_000;

/* Nur Namen — hier steht nie ein Wert. */
export const IDENTITY_ACCESS_VARS = Object.freeze({
  projectId: "QUANTUS_V3_FIREBASE_PROJECT_ID",
  tenant: "QUANTUS_V3_FIREBASE_TENANT",
  firebaseProjectId: "FIREBASE_PROJECT_ID",
  serviceAccount: "FIREBASE_SERVICE_ACCOUNT_JSON",
  refreshToken: "FIREBASE_OAUTH_REFRESH_TOKEN",
});

/* Der einzige Export von firebase-admin, den wir für einen fertigen,
   scope-gebundenen Token akzeptieren. Er existiert heute NICHT — das ist das
   dokumentierte Gate. */
export const FIREBASE_TOKEN_EXPORT = "getIdentityAccessToken";

function fehler(code) {
  return Object.assign(new Error(code), { code });
}

function scopeGenuegt(scopeText) {
  const teile = String(scopeText || "").split(/\s+/).filter(Boolean);
  return teile.includes(IDENTITY_SCOPE) || teile.includes(CLOUD_PLATFORM_SCOPE);
}

/*
 * Aus welchem Projekt spricht Firebase? `FIREBASE_PROJECT_ID` ist die
 * einfache Auskunft; liegt nur das Dienstkonto-JSON vor, wird daraus
 * AUSSCHLIESSLICH `project_id` gelesen — nichts anderes, und nichts davon
 * bleibt liegen. Der private Schlüssel wird hier nie angefasst.
 */
export function firebaseProjectIdFrom(read = envRead) {
  const direkt = String(read(IDENTITY_ACCESS_VARS.firebaseProjectId) || "").trim();
  if (direkt) return direkt;
  const rohJson = read(IDENTITY_ACCESS_VARS.serviceAccount);
  if (!rohJson) return null;
  try {
    const { project_id: projekt } = JSON.parse(String(rohJson));
    return projekt ? String(projekt).trim() : null;
  } catch {
    return null;
  }
}

/*
 * Konfiguration prüfen — ohne Netz, ohne Token.
 * Rückgabe: { ok: true, projectId, tenantId } oder { ok: false, status: 503, reason }.
 */
export function resolveIdentityAccessConfig(read = envRead) {
  const projectId = String(read(IDENTITY_ACCESS_VARS.projectId) || "").trim();
  if (!projectId) {
    return { ok: false, status: 503, error: "auth_not_configured", reason: "identity_project_missing" };
  }
  const firebaseProjekt = firebaseProjectIdFrom(read);
  if (!firebaseProjekt) {
    return { ok: false, status: 503, error: "auth_not_configured", reason: "firebase_project_unknown" };
  }
  if (firebaseProjekt !== projectId) {
    // Im falschen Verzeichnis nachsehen heisst: jeden für ungesperrt halten.
    return { ok: false, status: 503, error: "auth_not_configured", reason: "identity_project_mismatch" };
  }
  const tenantId = String(read(IDENTITY_ACCESS_VARS.tenant) || "").trim() || null;
  return { ok: true, projectId, tenantId };
}

/*
 * Der Provider. Rückgabe ist eine async Funktion, die ein Zugriffstoken
 * liefert oder mit einer festen Kennung scheitert:
 *   identity_access_not_configured  kein Weg vorhanden (Gate, siehe Kopf)
 *   identity_project_mismatch       v3- und Firebase-Projekt weichen ab
 *   identity_token_failed           der Tausch schlug fehl
 *   identity_scope_missing          der Token trägt den nötigen Scope nicht
 *
 * Fehlt die Konfiguration, ist das Ergebnis `null` — der Aufrufer (Laufzeit)
 * reicht dann KEINEN Lookup weiter, und C1 antwortet 503.
 */
export function createAccessTokenProvider({
  read = envRead,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  obtainAccessToken = null,
  firebaseModule = null,
} = {}) {
  const config = resolveIdentityAccessConfig(read);
  if (!config.ok) return null;
  /* Und: gibt es überhaupt einen Weg? Ein Provider, der bei jedem Aufruf nur
     scheitern kann, wäre eine Zusicherung, die niemand einhält — die Laufzeit
     soll dann gar keinen Lookup verdrahten. */
  const wege = identityAccessAvailability({ read, firebaseModule, obtainAccessToken });
  if (!wege.available) return null;

  let cache = null;              // { token, expiresAt }
  let inFlight = null;

  const ausFirebaseExport = typeof firebaseModule?.[FIREBASE_TOKEN_EXPORT] === "function"
    ? firebaseModule[FIREBASE_TOKEN_EXPORT]
    : null;

  async function refreshTokenTausch() {
    if (typeof firebaseModule?.userRefreshTokenFromEnv !== "function") throw fehler("identity_access_not_configured");
    let zugang = null;
    try {
      zugang = firebaseModule.userRefreshTokenFromEnv();
    } catch {
      // Eine halbe OAuth-Konfiguration ist keine.
      throw fehler("identity_access_not_configured");
    }
    if (!zugang) throw fehler("identity_access_not_configured");
    if (typeof fetchImpl !== "function") throw fehler("identity_token_failed");

    const antwort = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: zugang.refreshToken,
        client_id: zugang.clientId,
        client_secret: zugang.clientSecret,
        // Der Tausch kann Scopes nur EINSCHRÄNKEN, nicht hinzufügen. Wir
        // nennen den nötigen ausdrücklich und prüfen die Antwort.
        scope: IDENTITY_SCOPE,
      }),
    }).catch(() => null);

    if (!antwort || !antwort.ok) throw fehler("identity_token_failed");
    const daten = await antwort.json().catch(() => null);
    const token = daten && typeof daten.access_token === "string" ? daten.access_token : "";
    if (!token) throw fehler("identity_token_failed");
    // Google nennt die tatsächlich gewährten Scopes. Fehlt der nötige, ist
    // die Zustimmung zu eng — dann lieber gar kein Token als einer, der bei
    // jedem Lookup 403 erzeugt.
    if (daten.scope != null && !scopeGenuegt(daten.scope)) throw fehler("identity_scope_missing");
    const lebt = Number(daten.expires_in);
    const dauerMs = Number.isFinite(lebt) && lebt > 0 ? lebt * 1000 : 3_600_000;
    return { token, expiresAt: now() + dauerMs };
  }

  async function hole() {
    if (typeof obtainAccessToken === "function") {
      const ergebnis = await obtainAccessToken({ projectId: config.projectId, tenantId: config.tenantId, scope: IDENTITY_SCOPE });
      if (!ergebnis) throw fehler("identity_token_failed");
      if (typeof ergebnis === "string") return { token: ergebnis, expiresAt: now() + 300_000 };
      const token = typeof ergebnis.token === "string" ? ergebnis.token : "";
      if (!token) throw fehler("identity_token_failed");
      if (ergebnis.scope != null && !scopeGenuegt(ergebnis.scope)) throw fehler("identity_scope_missing");
      const bis = Number(ergebnis.expiresAt);
      return { token, expiresAt: Number.isFinite(bis) ? bis : now() + 300_000 };
    }
    if (ausFirebaseExport) {
      const ergebnis = await ausFirebaseExport({ scope: IDENTITY_SCOPE, projectId: config.projectId });
      const token = typeof ergebnis === "string" ? ergebnis : (ergebnis && typeof ergebnis.token === "string" ? ergebnis.token : "");
      if (!token) throw fehler("identity_token_failed");
      if (ergebnis && ergebnis.scope != null && !scopeGenuegt(ergebnis.scope)) throw fehler("identity_scope_missing");
      const bis = ergebnis && Number(ergebnis.expiresAt);
      return { token, expiresAt: Number.isFinite(bis) ? bis : now() + 300_000 };
    }
    return refreshTokenTausch();
  }

  const provider = async function getAccessToken() {
    if (cache && cache.expiresAt - EXPIRY_MARGIN_MS > now()) return cache.token;
    // Parallele Anfragen teilen sich EINEN Abruf. Der Fehlerfall wird nicht
    // gecacht: der nächste Aufruf darf es erneut versuchen.
    if (!inFlight) {
      inFlight = hole()
        .then((frisch) => { cache = frisch; return frisch.token; })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  provider.projectId = config.projectId;
  provider.tenantId = config.tenantId;
  provider.scope = IDENTITY_SCOPE;
  /* Für Diagnose: WELCHER Weg gilt — ohne je einen Wert zu nennen. */
  provider.source = typeof obtainAccessToken === "function"
    ? "injected"
    : (ausFirebaseExport ? `firebase:${FIREBASE_TOKEN_EXPORT}` : "oauth_refresh_exchange");
  return provider;
}

/*
 * Für die Laufzeit: sagt, ob ein Weg überhaupt besteht — ohne Netzaufruf.
 * Die Laufzeit entscheidet damit, ob sie einen Lookup verdrahtet oder nicht
 * (und C1 antwortet dann 503, statt ohne Widerrufsprüfung durchzulassen).
 */
export function identityAccessAvailability({ read = envRead, firebaseModule = null, obtainAccessToken = null } = {}) {
  const config = resolveIdentityAccessConfig(read);
  if (!config.ok) return { available: false, reason: config.reason };
  if (typeof obtainAccessToken === "function") return { available: true, source: "injected", ...config };
  if (typeof firebaseModule?.[FIREBASE_TOKEN_EXPORT] === "function") {
    return { available: true, source: `firebase:${FIREBASE_TOKEN_EXPORT}`, ...config };
  }
  let zugang = null;
  try {
    zugang = typeof firebaseModule?.userRefreshTokenFromEnv === "function" ? firebaseModule.userRefreshTokenFromEnv() : null;
  } catch {
    zugang = null;
  }
  if (zugang) return { available: true, source: "oauth_refresh_exchange", ...config };
  return { available: false, reason: "identity_access_not_configured", ...config };
}

export default {
  createAccessTokenProvider, resolveIdentityAccessConfig, identityAccessAvailability,
  firebaseProjectIdFrom, IDENTITY_ACCESS_VARS, IDENTITY_SCOPE, FIREBASE_TOKEN_EXPORT, EXPIRY_MARGIN_MS,
};
