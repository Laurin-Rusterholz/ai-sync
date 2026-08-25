// Firebase Admin access without a browser SDK. Netlify Functions authenticate
// with a service account and call the official RTDB / Cloud Storage REST APIs.
import { createHash, createSign } from "node:crypto";

const DEFAULT_PROJECT_ID = "jupidu-36804";
const DEFAULT_DATABASE_URL = "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app";
const DEFAULT_STORAGE_BUCKET = "jupidu-36804.firebasestorage.app";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADMIN_SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/devstorage.full_control",
].join(" ");

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

export function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    // Fall through to process.env for tests and local tooling.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}
function serviceAccountFromEnv() {
  const encoded = env("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (encoded) {
    try {
      const parsed = JSON.parse(encoded);
      if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      return parsed;
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON enthält kein gültiges JSON.");
    }
  }
  const projectId = env("FIREBASE_PROJECT_ID") || DEFAULT_PROJECT_ID;
  const clientEmail = env("FIREBASE_CLIENT_EMAIL");
  const privateKey = env("FIREBASE_PRIVATE_KEY")?.replace(/\\n/g, "\n");
  if (clientEmail && privateKey) return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
  throw new Error(
    "Firebase Admin ist nicht konfiguriert. FIREBASE_SERVICE_ACCOUNT_JSON oder FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY fehlen."
  );
}

/* ── Welche OAuth-Zugangsdaten erneuern den Firebase-Refresh? ─────────────
 * Der Firebase-Versand hing bisher an GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.
 * Das ist genau dann falsch, wenn der Refresh-Token zu einer ANDEREN
 * OAuth-Anwendung gehört als der Kalender-/Mail-Zugang: Google gibt dann
 * „invalid_client" oder „invalid_grant" zurück, und der Versand steht still.
 *
 * Deshalb gibt es ein eigenes Paar, FIREBASE_OAUTH_CLIENT_ID und
 * FIREBASE_OAUTH_CLIENT_SECRET. Die Regeln sind bewusst schlicht:
 *
 *   • Beide gesetzt  → sie haben Vorrang (Quelle „firebase").
 *   • Beide fehlen   → exakt der bisherige Google-Fallback (Quelle „google"),
 *                      samt der bisherigen Fehlermeldung.
 *   • Genau eines    → Fehler mit Namen der fehlenden Variable. Ein halbes
 *                      Paar wird NIE mit der anderen Anwendung gemischt —
 *                      client_id der einen und client_secret der anderen
 *                      ergeben ein Zugangsdatum, das es nirgends gibt.
 *
 * Reine Funktion, damit die Auswahl geprüft werden kann, ohne dass irgendwo
 * ein echtes Zugangsdatum liegen muss.
 * --------------------------------------------------------------------- */
const FIREBASE_OAUTH_VARS = { id: "FIREBASE_OAUTH_CLIENT_ID", secret: "FIREBASE_OAUTH_CLIENT_SECRET" };

export function resolveOAuthClient({
  refreshToken = "",
  firebaseClientId = "",
  firebaseClientSecret = "",
  googleClientId = "",
  googleClientSecret = "",
} = {}) {
  const clean = (value) => String(value == null ? "" : value).trim();
  const token = clean(refreshToken);
  if (!token) return null;

  const ftId = clean(firebaseClientId);
  const ftSecret = clean(firebaseClientSecret);
  if (ftId && ftSecret) {
    return { refreshToken: token, clientId: ftId, clientSecret: ftSecret, source: "firebase" };
  }
  if (ftId || ftSecret) {
    const missing = ftId ? FIREBASE_OAUTH_VARS.secret : FIREBASE_OAUTH_VARS.id;
    throw new Error(
      `${missing} fehlt. ${FIREBASE_OAUTH_VARS.id} und ${FIREBASE_OAUTH_VARS.secret} gehören zusammen — ` +
      "ein halbes Paar wird nicht mit GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET gemischt."
    );
  }

  const googleId = clean(googleClientId);
  const googleSecret = clean(googleClientSecret);
  if (!googleId || !googleSecret) {
    throw new Error("FIREBASE_OAUTH_REFRESH_TOKEN benötigt GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET.");
  }
  return { refreshToken: token, clientId: googleId, clientSecret: googleSecret, source: "google" };
}

export function userRefreshTokenFromEnv() {
  return resolveOAuthClient({
    refreshToken: env("FIREBASE_OAUTH_REFRESH_TOKEN"),
    firebaseClientId: env(FIREBASE_OAUTH_VARS.id),
    firebaseClientSecret: env(FIREBASE_OAUTH_VARS.secret),
    googleClientId: env("GOOGLE_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_CLIENT_SECRET"),
  });
}

function base64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAdminAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60_000) return cachedAccessToken;
  const userOAuth = userRefreshTokenFromEnv();
  if (userOAuth) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: userOAuth.refreshToken,
        client_id: userOAuth.clientId,
        client_secret: userOAuth.clientSecret,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error("Firebase OAuth-Refresh fehlgeschlagen: " + (data.error_description || data.error || response.status));
    }
    cachedAccessToken = data.access_token;
    cachedAccessTokenExpiry = Date.now() + Number(data.expires_in || 3600) * 1000;
    return cachedAccessToken;
  }
  const account = serviceAccountFromEnv();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    sub: account.client_email,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
    scope: ADMIN_SCOPES,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64url(signer.sign(account.private_key))}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error("Firebase Admin OAuth fehlgeschlagen: " + (data.error_description || data.error || response.status));
  }
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function adminFetch(url, init = {}) {
  const token = await getAdminAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    cachedAccessToken = null;
    cachedAccessTokenExpiry = 0;
  }
  return response;
}

function databaseUrl(path) {
  const base = env("FIREBASE_DATABASE_URL") || DEFAULT_DATABASE_URL;
  const safePath = String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${base.replace(/\/+$/, "")}/${safePath}.json`;
}

async function firebaseDbGetWithEtag(path) {
  const response = await adminFetch(databaseUrl(path), {
    headers: { "X-Firebase-ETag": "true", "Cache-Control": "no-store" },
  });
  if (!response.ok) throw new Error(`Firebase RTDB GET fehlgeschlagen (HTTP ${response.status}).`);
  const value = await response.json();
  return { exists: value !== null, value, serverEtag: response.headers.get("ETag") };
}

export async function firebaseDbGet(path) {
  return (await firebaseDbGetWithEtag(path)).value;
}

export async function firebaseDbSet(path, value, { ifMatch = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (ifMatch) headers["if-match"] = ifMatch;
  const response = await adminFetch(databaseUrl(path), {
    method: "PUT",
    headers,
    body: JSON.stringify(value),
  });
  if (response.status === 412) return { ok: false, conflict: true };
  if (!response.ok) throw new Error(`Firebase RTDB PUT fehlgeschlagen (HTTP ${response.status}).`);
  return { ok: true, conflict: false };
}

export async function firebaseDbRemove(path) {
  const response = await adminFetch(databaseUrl(path), { method: "DELETE" });
  if (!response.ok) throw new Error(`Firebase RTDB DELETE fehlgeschlagen (HTTP ${response.status}).`);
}

export async function firebaseStorageUpload(path, data, { contentType = "application/octet-stream", metadata = {} } = {}) {
  const bucket = env("FIREBASE_STORAGE_BUCKET") || DEFAULT_STORAGE_BUCKET;
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`;
  const headers = { "Content-Type": contentType };
  for (const [key, value] of Object.entries(metadata)) headers[`X-Goog-Meta-${key}`] = String(value);
  const response = await adminFetch(url, { method: "POST", headers, body: data });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Firebase Storage Upload fehlgeschlagen (HTTP ${response.status}): ${details.slice(0, 200)}`);
  }
  return response.json();
}

export async function firebaseStorageDownload(path) {
  const bucket = env("FIREBASE_STORAGE_BUCKET") || DEFAULT_STORAGE_BUCKET;
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media`;
  const response = await adminFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firebase Storage Download fehlgeschlagen (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

export async function firebaseStorageDelete(path) {
  const bucket = env("FIREBASE_STORAGE_BUCKET") || DEFAULT_STORAGE_BUCKET;
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`;
  const response = await adminFetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Firebase Storage DELETE fehlgeschlagen (HTTP ${response.status}).`);
  }
}

export function firebaseNodeKey(key) {
  return String(key || "app-data.json").replace(/[.#$\[\]\/]/g, "_");
}

function appStorePath(key = "app-data.json") {
  return `appStore/${firebaseNodeKey(key)}`;
}

export function jsonEtag(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function unwrapData(value) {
  if (!value) return null;
  if (typeof value.data === "string") return value.data;
  if (typeof value === "string") return value;
  if (value.data && typeof value.data === "object") return JSON.stringify(value.data);
  return null;
}

export async function readAppDataDocument(key = "app-data.json") {
  const record = await firebaseDbGetWithEtag(appStorePath(key));
  const wrap = record.value;
  const data = unwrapData(wrap);
  if (data == null) return { exists: false, data: null, parsed: null, etag: null, wrap };
  let parsed = null;
  try {
    parsed = JSON.parse(data);
  } catch {
    // Compatibility endpoints return the stored bytes even if an old record is malformed.
  }
  return { exists: true, data, parsed, etag: wrap?.etag || jsonEtag(data), wrap };
}

// Der Server ersetzt eine Client-Vorbedingung NIE stillschweigend durch eine
// eigene. Frueher stand hier
//     if (ifMatch && currentData != null && currentLogicalEtag !== ifMatch)
// — die Bedingung `currentData != null` liess den Vergleich AUSFALLEN, sobald
// der Knoten fehlte oder nicht auspackbar war. Der Client sagte "schreibe nur,
// wenn der Stand noch A ist", der Server fand gar keinen Stand, uebersprang die
// Pruefung und rekonstruierte das Dokument aus der Client-Nutzlast. Wurde der
// Knoten zwischendurch geloescht, kam so der ganze alte Stand zurueck — samt
// der Eintraege, die die Loeschung gerade entfernt hatte (F-25).
// Ein fehlender aktueller Stand ist ein KONFLIKT, kein Freibrief.
//
// Eine bewusste Erstanlage gibt es weiterhin, aber nur als eigener, expliziter
// Weg: ifNoneMatch: "*" schreibt ausschliesslich dann, wenn NICHTS da ist. Ein
// normaler PUT legt nie an.
export async function writeAppDataText(key, text, { ifMatch = null, ifNoneMatch = null, savedBy = "netlify-function" } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
  const etag = jsonEtag(text);
  const path = appStorePath(key);

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await firebaseDbGetWithEtag(path);
    const currentData = unwrapData(current.value);
    const currentLogicalEtag = current.value?.etag || (currentData != null ? jsonEtag(currentData) : null);

    // 1) LOGISCHER VERGLEICH — immer, wenn der Client eine Vorbedingung nennt.
    //    Er steht VOR jedem Schreibvorgang; faellt er durch, gibt es NULL
    //    Firebase-PUTs, keinen Nebenschreibvorgang, keinen Schatten.
    if (ifMatch) {
      if (currentData == null || !currentLogicalEtag) {
        return { ok: false, conflict: true, reason: "no_current", etag: null, parsed };
      }
      if (currentLogicalEtag !== ifMatch) {
        return { ok: false, conflict: true, reason: "etag_mismatch", etag: null, parsed };
      }
    }
    // Erstanlage: nur wenn ausdruecklich verlangt UND wirklich nichts da ist.
    if (ifNoneMatch === "*" && currentData != null) {
      return { ok: false, conflict: true, reason: "already_exists", etag: null, parsed };
    }

    // 2) Erst JETZT der innere Server-ETag-CAS gegen ein Wettrennen zwischen
    //    Lesen und Schreiben. Er sichert nur diese kurze Luecke ab und ist NIE
    //    ein Ersatz fuer den logischen Vergleich oben.
    const wrap = {
      data: text,
      etag,
      updatedAt: parsed?.meta?.updatedAt || new Date().toISOString(),
      savedAt: Date.now(),
      savedBy,
    };
    const saved = await firebaseDbSet(path, wrap, { ifMatch: current.serverEtag });
    if (saved.ok) return { ok: true, conflict: false, etag, parsed };
  }
  return { ok: false, conflict: true, etag: null, parsed };
}

export async function mutateAppData(key, mutator, { savedBy = "netlify-function" } = {}) {
  const path = appStorePath(key);
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await firebaseDbGetWithEtag(path);
    const raw = unwrapData(current.value);
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const mutation = mutator(parsed);
    const data = mutation?.data ?? mutation;
    const mutationResult = mutation?.result ?? null;
    const text = JSON.stringify(data);
    const wrap = {
      data: text,
      etag: jsonEtag(text),
      updatedAt: data?.meta?.updatedAt || new Date().toISOString(),
      savedAt: Date.now(),
      savedBy,
    };
    const saved = await firebaseDbSet(path, wrap, { ifMatch: current.serverEtag });
    if (saved.ok) return { data, result: mutationResult };
  }
  throw new Error("Firebase-Transaktion ist nach mehreren Parallelkonflikten fehlgeschlagen.");
}
