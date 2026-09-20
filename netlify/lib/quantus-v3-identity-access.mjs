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
 *   1. `obtainAccessToken`  — ausdrücklich hereingegebener Port.
 *   2. `getIdentityAccessToken` aus firebase-admin — wenn der Eigentümer
 *      dieser Datei einen scope-gebundenen Token EXPORTIERT. Nur der Name
 *      zählt, nichts wird nachgebaut.
 *   3. Refresh-Token-Weg — die EINZIGE Zugangsauflösung, die firebase-admin
 *      heute exportiert (`userRefreshTokenFromEnv`).
 *   4. Sonst: **503**, mit Namen des fehlenden Gates.
 *
 * ── WAS RUNDE 2 GEÄNDERT HAT (acht Gegenproben, Review a422670) ──────────
 *
 * G-1..3  DIE MARGE GILT FÜR JEDES TOKEN, nicht nur für den Cache.
 *         Befund: ein Port, der `expiresAt = now - 1`, `now` oder
 *         `now + 59999` liefert (Marge 60 s), wurde AKZEPTIERT — geprüft
 *         wurde nur der alte Cache-Eintrag, nie die frische Antwort. Jetzt
 *         läuft jedes Token, gleich woher, durch dieselbe Schranke:
 *         `expiresAt - MARGE > jetzt`. Sonst `identity_token_expired`.
 *
 * G-4     FRISCHE ZEIT NACH DEM AWAIT. Ein Erwerb kann dauern (121 s im
 *         Gegenbeispiel). Die Schranke wird deshalb NACH dem Erwerb mit
 *         neu abgefragter Zeit gezogen, nie mit der Zeit vom Start.
 *
 * G-5     KEINE ERFUNDENE LAUFZEIT. `expires_in: -60` wurde still zu einer
 *         Stunde. Eine fehlende, negative, nicht endliche oder nicht
 *         numerische Lebensdauer ist jetzt ein Fehler
 *         (`identity_token_lifetime_invalid`) — auf JEDEM Weg, auch beim
 *         hereingegebenen Port: wer ein Token liefert, nennt seine Frist.
 *
 * G-6     CACHE UND BÜNDELUNG WIRKEN ÜBER REQUESTS. Befund: die produktiven
 *         Handler bauen ihre Abhängigkeiten PRO REQUEST; ein Cache im
 *         Provider-Abschluss war damit je Aufruf neu, und zwei parallele
 *         Anfragen holten zwei Token. Der Cache liegt jetzt im Modul, streng
 *         gebunden an Projekt, Mandant, Scope, Tokenquelle (Portidentität)
 *         und die AKTUELLE Zugangskonfiguration (als Hash, siehe unten).
 *         Er ist begrenzt (`MAX_CACHE_ENTRIES`) und ausdrücklich
 *         ungültigmachbar (`invalidateIdentityAccessCache`). Ein Wechsel von
 *         Projekt, Mandant, Scope, Quelle oder Zugangsdaten ergibt einen
 *         anderen Schlüssel — der alte Token wird nie weiterverwendet.
 *         Der WIDERRUFSLOOKUP selbst wird NIE gecacht; das wäre genau die
 *         Prüfung, um die es geht (siehe C1, `createIdentityToolkitUserLookup`).
 *
 * G-7..8  FEHLER VERLASSEN DAS MODUL NUR ALS FESTE KENNUNG. Befund: wirft
 *         der Port (oder der firebase-Export) einen Fehler, dessen `message`
 *         oder `body` ein Zugangsdatum trägt, reichte der Provider das
 *         Original weiter — mitsamt `cause`. Jetzt wird jeder Fehler an der
 *         Modulgrenze in einen neuen Fehler mit einer der Kennungen unten
 *         übersetzt: keine fremde Nachricht, kein `cause`, kein `body`, kein
 *         Tokenwert. Das ist ein Grenznachweis am Modul, keine Aussage über
 *         irgendeine HTTP-Antwort.
 *
 * WEITERE REGELN
 * --------------
 * • SCOPE-GEBUNDEN. Der Token muss `identitytoolkit` (oder das übergeordnete
 *   `cloud-platform`) tragen. Google nennt die gewährten Scopes; fehlt der
 *   nötige, ist das ein Fehler und kein Versuch wert.
 * • PROJEKTGEBUNDEN. Das v3-Projekt muss dasselbe sein wie das Firebase-
 *   Projekt. Sonst würde die Sperrprüfung im falschen Verzeichnis nachsehen
 *   und jeden für ungesperrt halten.
 * • NIE IN LOG ODER ANTWORT. Diese Datei schreibt nichts ins Log. Der
 *   Zugangs-Hash ist ein Schlüssel im Arbeitsspeicher; er wird nirgends
 *   zurückgegeben und erscheint in keiner Diagnose.
 * ═══════════════════════════════════════════════════════════════════════ */

import { createHash } from "node:crypto";
import { envRead } from "./quantus-v3-auth.mjs";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const IDENTITY_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const EXPIRY_MARGIN_MS = 60_000;
export const MAX_CACHE_ENTRIES = 8;

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

/* Die einzigen Kennungen, die dieses Modul nach aussen gibt. */
export const IDENTITY_ACCESS_ERRORS = Object.freeze([
  "identity_access_not_configured",   // kein Weg vorhanden (Gate, siehe Kopf)
  "identity_project_mismatch",        // v3- und Firebase-Projekt weichen ab
  "identity_token_failed",            // der Erwerb schlug fehl (auch: Port wirft)
  "identity_scope_missing",           // der Token trägt den nötigen Scope nicht
  "identity_token_lifetime_invalid",  // Frist fehlt, ist negativ oder nicht endlich
  "identity_token_expired",           // Frist liegt (fast) in der Vergangenheit
  "identity_access_busy",             // Ressourcengrenze erreicht (Admission, siehe unten)
]);
const EIGENE_KENNUNGEN = new Set(IDENTITY_ACCESS_ERRORS);

/*
 * Ein Fehler ohne Erbe: Nachricht = Kennung, kein `cause`, kein `body`,
 * nichts aus einer fremden Bibliothek.
 */
function fehler(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/* Die Modulgrenze: was auch kommt, hinaus geht nur eine eigene Kennung. */
function sichererFehler(ursache) {
  const code = ursache && typeof ursache.code === "string" && EIGENE_KENNUNGEN.has(ursache.code)
    ? ursache.code
    : "identity_token_failed";
  return fehler(code);
}

function scopeGenuegt(scopeText) {
  const teile = String(scopeText || "").split(/\s+/).filter(Boolean);
  return teile.includes(IDENTITY_SCOPE) || teile.includes(CLOUD_PLATFORM_SCOPE);
}

function digest(teile) {
  return createHash("sha256").update(teile.map((t) => String(t == null ? "" : t)).join("\u0000"), "utf8").digest("hex");
}

/* ══ Der geteilte Tokenspeicher ════════════════════════════════════════════
 *
 * Er liegt im MODUL, nicht im Provider — sonst wirkte er nur innerhalb eines
 * Requests (G-6). Schlüssel ist ein Abdruck über Projekt, Mandant, Scope,
 * Quelle und Zugangskonfiguration; Wert ist Token, Frist und der laufende
 * Abruf (für die Bündelung paralleler Anfragen).
 * ─────────────────────────────────────────────────────────────────────── */
const tokenCache = new Map();
const portKennungen = new WeakMap();
let portZaehler = 0;

/* Eine stabile Kennung je Funktionsobjekt — dieselbe Funktion (also dieselbe
   Tokenquelle) ergibt denselben Cache-Schlüssel, eine andere nicht. */
function portKennung(fn) {
  if (typeof fn !== "function") return "kein-port";
  if (!portKennungen.has(fn)) portKennungen.set(fn, `port-${++portZaehler}`);
  return portKennungen.get(fn);
}

/*
 * Der Abdruck der AKTUELLEN Zugangskonfiguration. Er ist ein Hash — die
 * Werte selbst werden nicht gespeichert, nicht zurückgegeben und nicht
 * protokolliert. Ändern sich die Zugangsdaten, ändert sich der Schlüssel, und
 * ein Token aus der alten Konfiguration wird nie weiterverwendet.
 */
function zugangsAbdruck(firebaseModule) {
  let zugang = null;
  try {
    zugang = typeof firebaseModule?.userRefreshTokenFromEnv === "function"
      ? firebaseModule.userRefreshTokenFromEnv()
      : null;
  } catch {
    return "zugang-unbrauchbar";
  }
  if (!zugang) return "zugang-fehlt";
  return digest(["refresh", zugang.source, zugang.clientId, zugang.clientSecret, zugang.refreshToken]);
}

/* ══ STRENGE ADMISSION — die Grenze gilt auch für laufende Abrufe ═════════
 *
 * BEFUND (Release-Review 4379061, C3B-07): `eintragFuer` legte den Eintrag
 * BEDINGUNGSLOS an, und die Verdrängung übersprang jeden Eintrag mit
 * laufendem Abruf. Sechzehn gleichzeitige, verschiedene Quellen ergaben
 * deshalb 16 Einträge bei einer angekündigten Grenze von 8 — während des
 * Abrufs und, weil niemand nachträglich begrenzte, auch danach.
 *
 * Jetzt entscheidet eine Admission VOR dem Anlegen:
 *   1. Gibt es den Eintrag schon? Dann ist nichts anzulegen — die Bündelung
 *      derselben Quelle bleibt unberührt (kein Platzbedarf, keine Ablehnung).
 *   2. Ist Platz frei? Anlegen.
 *   3. Sonst: erst unbrauchbare, dann die ältesten Einträge OHNE laufenden
 *      Abruf verdrängen (ein laufender Abruf wird nie weggeworfen — der
 *      Aufrufer wartet darauf).
 *   4. Bleibt kein Platz, weil alle Plätze in Arbeit sind: KONTROLLIERTE
 *      ABLEHNUNG mit `identity_access_busy`. Kein Eintrag, kein Token, keine
 *      stille Überschreitung. Fail closed — der Aufrufer bekommt keinen
 *      Ausweis, nicht einen ungeprüften.
 *
 * Damit gilt `tokenCache.size <= MAX_CACHE_ENTRIES` zu JEDEM Zeitpunkt, nicht
 * erst nach dem Abschluss.
 * ─────────────────────────────────────────────────────────────────────── */
let abgewiesen = 0;

function platzSchaffen(abdruck, jetzt) {
  if (tokenCache.has(abdruck)) return true;                  // Bündelung, kein neuer Platz
  if (tokenCache.size < MAX_CACHE_ENTRIES) return true;

  // (a) Was nichts mehr taugt, geht zuerst.
  for (const [schluessel, eintrag] of [...tokenCache]) {
    if (eintrag.inFlight) continue;
    if (!eintrag.token || !nochBrauchbar(eintrag.expiresAt, jetzt)) tokenCache.delete(schluessel);
    if (tokenCache.size < MAX_CACHE_ENTRIES) return true;
  }
  // (b) Dann der älteste brauchbare Eintrag ohne laufenden Abruf
  //     (Map hält die Einfügereihenfolge).
  for (const [schluessel, eintrag] of [...tokenCache]) {
    if (eintrag.inFlight) continue;
    tokenCache.delete(schluessel);
    if (tokenCache.size < MAX_CACHE_ENTRIES) return true;
  }
  // (c) Alle Plätze sind in Arbeit: ablehnen, nicht überschreiten.
  abgewiesen++;
  return false;
}

/* Dieselbe Schranke für jedes Token — Cache oder frisch erworben. */
function nochBrauchbar(expiresAt, jetzt) {
  const bis = Number(expiresAt);
  return Number.isFinite(bis) && bis - EXPIRY_MARGIN_MS > jetzt;
}

/* Betrieb: einen Token ausdrücklich verwerfen (Zugangswechsel, Vorfall). */
export function invalidateIdentityAccessCache() {
  tokenCache.clear();
}

/* Nur für Tests — damit ein Lauf nicht den Speicher des vorigen erbt. */
export function resetIdentityAccessCacheForTests() {
  tokenCache.clear();
  abgewiesen = 0;
}

/* Diagnose ohne Werte: wie viele Einträge liegen da, und wie viele leben. */
export function identityAccessCacheStats(now = () => Date.now()) {
  const jetzt = now();
  let brauchbar = 0;
  let laufend = 0;
  for (const eintrag of tokenCache.values()) {
    if (eintrag.token && nochBrauchbar(eintrag.expiresAt, jetzt)) brauchbar++;
    if (eintrag.inFlight) laufend++;
  }
  return {
    entries: tokenCache.size, usable: brauchbar, inFlight: laufend,
    limit: MAX_CACHE_ENTRIES, rejected: abgewiesen,
  };
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
 * liefert oder mit einer der Kennungen aus `IDENTITY_ACCESS_ERRORS`
 * scheitert. Fehlt die Konfiguration oder gibt es überhaupt keinen Weg, ist
 * das Ergebnis `null` — die Laufzeit verdrahtet dann KEINEN Lookup, und C1
 * antwortet 503.
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

  const ausFirebaseExport = typeof firebaseModule?.[FIREBASE_TOKEN_EXPORT] === "function"
    ? firebaseModule[FIREBASE_TOKEN_EXPORT]
    : null;
  const quelle = typeof obtainAccessToken === "function"
    ? "injected"
    : (ausFirebaseExport ? `firebase:${FIREBASE_TOKEN_EXPORT}` : "oauth_refresh_exchange");

  /* Der Cache-Schlüssel. Alles, was einen anderen Token bedeuten würde,
     steht darin — Projekt, Mandant, Scope, Quelle, Portidentität, Verkehr und
     die aktuelle Zugangskonfiguration. */
  const abdruck = digest([
    "quantus-v3-identity-access/1",
    config.projectId, config.tenantId, IDENTITY_SCOPE, quelle,
    portKennung(obtainAccessToken), portKennung(ausFirebaseExport), portKennung(fetchImpl),
    zugangsAbdruck(firebaseModule),
  ]);

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
    // KEINE erfundene Laufzeit (G-5): `expires_in` muss eine positive, endliche
    // Zahl sein. Fehlt sie oder ist sie unbrauchbar, gilt der Token nicht.
    const lebt = typeof daten.expires_in === "number" ? daten.expires_in : Number(daten.expires_in);
    if (!Number.isFinite(lebt) || lebt <= 0) throw fehler("identity_token_lifetime_invalid");
    return { token, expiresAt: now() + lebt * 1000 };
  }

  /* Eine Portantwort, die eine Frist NENNT — oder keine ist. */
  function ausPortAntwort(ergebnis) {
    if (!ergebnis || typeof ergebnis !== "object") throw fehler("identity_token_lifetime_invalid");
    const token = typeof ergebnis.token === "string" ? ergebnis.token : "";
    if (!token) throw fehler("identity_token_failed");
    if (ergebnis.scope != null && !scopeGenuegt(ergebnis.scope)) throw fehler("identity_scope_missing");
    const bis = typeof ergebnis.expiresAt === "number" ? ergebnis.expiresAt : Number(ergebnis.expiresAt);
    if (!Number.isFinite(bis)) throw fehler("identity_token_lifetime_invalid");
    return { token, expiresAt: bis };
  }

  async function hole() {
    if (typeof obtainAccessToken === "function") {
      return ausPortAntwort(await obtainAccessToken({
        projectId: config.projectId, tenantId: config.tenantId, scope: IDENTITY_SCOPE,
      }));
    }
    if (ausFirebaseExport) {
      return ausPortAntwort(await ausFirebaseExport({ scope: IDENTITY_SCOPE, projectId: config.projectId }));
    }
    return refreshTokenTausch();
  }

  /*
   * Erwerb und Prüfung in einem. Die Schranke wird NACH dem Erwerb mit
   * FRISCHER Zeit gezogen (G-4): ein Erwerb, der zwei Minuten dauert, darf
   * kein Token liefern, das inzwischen abgelaufen ist.
   */
  async function holeGeprueft() {
    let frisch;
    try {
      frisch = await hole();
    } catch (ursache) {
      throw sichererFehler(ursache);       // Modulgrenze (G-7/G-8)
    }
    if (!nochBrauchbar(frisch.expiresAt, now())) throw fehler("identity_token_expired");
    return frisch;
  }

  const provider = async function getAccessToken() {
    const jetzt = now();
    let eintrag = tokenCache.get(abdruck);
    if (eintrag) {
      if (eintrag.token && nochBrauchbar(eintrag.expiresAt, jetzt)) return eintrag.token;
      // Parallele Anfragen — auch aus verschiedenen Requests — teilen EINEN
      // Abruf. Das ist die Bündelung, und sie braucht keinen neuen Platz.
      if (eintrag.inFlight) return eintrag.inFlight;
    } else {
      // Erst die Grenze, dann der Eintrag. Nie umgekehrt.
      if (!platzSchaffen(abdruck, jetzt)) throw fehler("identity_access_busy");
      eintrag = { token: null, expiresAt: 0, inFlight: null };
      tokenCache.set(abdruck, eintrag);
    }

    // Ein abgelaufener Stand wird NICHT weiterbenutzt, auch nicht „nur diesmal".
    eintrag.token = null;
    eintrag.expiresAt = 0;
    eintrag.inFlight = holeGeprueft().then(
      (frisch) => {
        eintrag.token = frisch.token;
        eintrag.expiresAt = frisch.expiresAt;
        eintrag.inFlight = null;
        return frisch.token;
      },
      (err) => {
        // Der Fehlerfall wird nicht gecacht — und er gibt seinen Platz zurück,
        // statt einen leeren Eintrag zu behalten.
        eintrag.inFlight = null;
        if (tokenCache.get(abdruck) === eintrag) tokenCache.delete(abdruck);
        throw sichererFehler(err);
      },
    );
    // Das Versprechen wird zurückgegeben — es bleibt nie unbehandelt liegen.
    return eintrag.inFlight;
  };

  provider.projectId = config.projectId;
  provider.tenantId = config.tenantId;
  provider.scope = IDENTITY_SCOPE;
  /* Für Diagnose: WELCHER Weg gilt — ohne je einen Wert zu nennen. Der
     Cache-Abdruck wird bewusst NICHT nach aussen gegeben. */
  provider.source = quelle;
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
    /* Der Export allein ist kein Weg: ohne Zugangsauflösung könnte er bei
       jedem Aufruf nur scheitern, und C1 soll dann ehrlich 503 antworten,
       statt 401 aus einem Erwerb, der nie klappen kann. Nennt firebase-admin
       eine Prüfung (`firebaseAccessCredentialsConfigured`), gilt sie. */
    const pruefung = firebaseModule.firebaseAccessCredentialsConfigured;
    let zugangsdaten = true;
    if (typeof pruefung === "function") {
      try {
        zugangsdaten = pruefung() === true;
      } catch {
        zugangsdaten = false;
      }
    }
    if (zugangsdaten) return { available: true, source: `firebase:${FIREBASE_TOKEN_EXPORT}`, ...config };
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
  firebaseProjectIdFrom, invalidateIdentityAccessCache, resetIdentityAccessCacheForTests,
  identityAccessCacheStats, IDENTITY_ACCESS_VARS, IDENTITY_SCOPE, FIREBASE_TOKEN_EXPORT,
  EXPIRY_MARGIN_MS, MAX_CACHE_ENTRIES, IDENTITY_ACCESS_ERRORS,
};
