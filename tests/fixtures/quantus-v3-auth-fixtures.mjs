/*
 * Prüfmittel für das v3-Sicherheitspaket C1.
 *
 * Grundregel: JEDER Schlüssel und jedes Zugangsdatum wird HIER, zur Laufzeit,
 * frisch erzeugt (randomBytes / generateKeyPair). Im Repo steht kein einziger
 * Credentialwert, und kein Test greift auf ein echtes Projekt zu — weder
 * Firebase noch Anthropic, Gemini oder OpenAI. Alle Netzwege sind Attrappen.
 *
 * Die RSA-Schlüssel sind echt, und die Signaturen darüber sind echt: die
 * Firebase-Prüfstrecke wird mit tatsächlich signierten Token gefahren, nicht
 * mit einem „Mock, der ja sagt".
 */
import { randomBytes, generateKeyPairSync, createSign, createHash } from "node:crypto";

export const PROJECT_ID = "quantus-test-project";
export const POLICY_VERSION = "v3-2026-09-19";
export const TENANT = "quantus-haushalt";

export function randomSecret() {
  // 64 Hex-Zeichen — deutlich über MIN_SERVICE_SECRET_LENGTH, und flüchtig.
  return randomBytes(32).toString("hex");
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/* Ein frisches RSA-Paar plus kid, wie es der Google-Endpunkt hätte. */
export function makeSigningKey(kid = "kid-" + randomBytes(4).toString("hex")) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function b64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/*
 * Ein echt signiertes Firebase-artiges ID-Token. `tamper` erlaubt es, den
 * Nutzinhalt NACH dem Signieren zu verbiegen — damit lässt sich beweisen, dass
 * die Signaturprüfung wirklich greift.
 */
export function makeIdToken({
  key, projectId = PROJECT_ID, sub = "user-abc", iat, exp, authTime,
  aud = null, iss = null, alg = "RS256", tenant = null, topLevelTenant = null,
  signWith = null, extraPayload = null, tamperPayload = null, now = Date.now(),
} = {}) {
  const nowSec = Math.floor(now / 1000);
  const header = { alg, kid: key.kid, typ: "JWT" };
  const payload = {
    iss: iss == null ? `https://securetoken.google.com/${projectId}` : iss,
    aud: aud == null ? projectId : aud,
    sub,
    auth_time: authTime == null ? nowSec - 60 : authTime,
    iat: iat == null ? nowSec - 30 : iat,
    exp: exp == null ? nowSec + 3600 : exp,
    user_id: sub,
    firebase: { sign_in_provider: "password", identities: {}, ...(tenant ? { tenant } : {}) },
    ...(topLevelTenant ? { tenant_id: topLevelTenant } : {}),
    ...(extraPayload || {}),
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerB64}.${payloadB64}`);
  const signature = b64url(signer.sign(signWith || key.privateKey));

  if (tamperPayload) {
    // Signatur bleibt, Inhalt wird ausgetauscht: der klassische Angriff.
    const changed = b64url(JSON.stringify({ ...payload, ...tamperPayload }));
    return `${headerB64}.${changed}.${signature}`;
  }
  return `${headerB64}.${payloadB64}.${signature}`;
}

/* Ein Schlüsselbezug ohne Netz: liefert genau die übergebenen Schlüssel. */
export function keySourceFor(...keys) {
  const map = new Map(keys.map((k) => [k.kid, k.publicKey]));
  return { async get(kid) { return map.get(kid) || null; }, size: map.size };
}

/* Ein Nutzerdatensatz, wie ihn accounts:lookup liefert. */
export function userLookupFor(record = {}) {
  return async function lookup(uid) {
    if (record.unknown) return null;
    if (record.throws) throw new Error("lookup kaputt");
    return {
      disabled: record.disabled === true,
      validSince: Number(record.validSince || 0),
      tenantId: record.tenantId === undefined ? null : record.tenantId,
      uid,
    };
  };
}

/*
 * Eine vollständige, gültige Serverkonfiguration als Umgebungsleser.
 * `overrides` ersetzt einzelne Variablen (oder löscht sie mit null), damit
 * die Fail-Closed-Fälle geprüft werden können.
 */
export function makeEnv({
  serviceSecrets = null, workerSecrets = null, cursorSecrets = null,
  tenant = null, mode = null, origins = "https://management-xo2-pro.netlify.app",
  overrides = {},
} = {}) {
  const svc = serviceSecrets || {
    lead: randomSecret(),
    scheduler: randomSecret(),
    checker: randomSecret(),
  };
  const worker = workerSecrets || { primary: randomSecret(), old: randomSecret() };
  const cursor = cursorSecrets || { primary: randomSecret(), old: randomSecret() };

  const base = {
    QUANTUS_V3_FIREBASE_PROJECT_ID: PROJECT_ID,
    QUANTUS_V3_POLICY_VERSION: POLICY_VERSION,
    QUANTUS_V3_ALLOWED_ORIGINS: origins,
    QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
      { id: "cred-lead-1", principal: "lead-agent-cloudrun", role: "lead_agent", tenant: TENANT, secretSha256: sha256Hex(svc.lead), status: "active" },
      { id: "cred-sched-1", principal: "cloud-scheduler", role: "scheduler", tenant: TENANT, secretSha256: sha256Hex(svc.scheduler), status: "active" },
      { id: "cred-check-1", principal: "backend-pruefer", role: "backend_checker", tenant: TENANT, secretSha256: sha256Hex(svc.checker), status: "active" },
    ]),
    QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([
      { kid: "w1", secret: worker.primary, status: "active" },
      { kid: "w0", secret: worker.old, status: "retiring" },
    ]),
    QUANTUS_V3_CURSOR_KEYS: JSON.stringify([
      { kid: "c1", secret: cursor.primary, status: "active" },
      { kid: "c0", secret: cursor.old, status: "retiring" },
    ]),
  };
  if (tenant) base.QUANTUS_V3_FIREBASE_TENANT = tenant;
  if (mode) base.QUANTUS_V3_MODE = mode;

  const merged = { ...base, ...overrides };
  const read = (name) => (merged[name] === null ? undefined : merged[name]);
  return { read, secrets: { service: svc, worker, cursor }, vars: merged };
}
