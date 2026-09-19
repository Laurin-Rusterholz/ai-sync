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
 *
 * PORTABEL (Review-Befund): Das X.509-Zertifikat für die Zertifikatsstrecke
 * entsteht hier in reinem JavaScript (ASN.1/DER + node:crypto). Die frühere
 * Fassung rief `openssl req -x509` auf — das scheiterte auf macOS, und ein
 * Test, der je nach Rechner übersprungen wird, prüft nichts.
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
 * Ein echt signiertes Firebase-artiges ID-Token. `tamperPayload` verbiegt den
 * Nutzinhalt NACH dem Signieren — damit lässt sich beweisen, dass die
 * Signaturprüfung wirklich greift.
 */
export function makeIdToken({
  key, projectId = PROJECT_ID, sub = "user-abc", iat, exp, authTime,
  aud = null, iss = null, alg = "RS256", tenant = null, topLevelTenant = null,
  signWith = null, extraPayload = null, tamperPayload = null, now = Date.now(),
  omitAuthTime = false,
} = {}) {
  const nowSec = Math.floor(now / 1000);
  const header = { alg, kid: key.kid, typ: "JWT" };
  const payload = {
    iss: iss == null ? `https://securetoken.google.com/${projectId}` : iss,
    aud: aud == null ? projectId : aud,
    sub,
    iat: iat == null ? nowSec - 30 : iat,
    exp: exp == null ? nowSec + 3600 : exp,
    user_id: sub,
    firebase: { sign_in_provider: "password", identities: {}, ...(tenant ? { tenant } : {}) },
    ...(topLevelTenant ? { tenant_id: topLevelTenant } : {}),
    ...(extraPayload || {}),
  };
  if (!omitAuthTime) payload.auth_time = authTime == null ? nowSec - 60 : authTime;

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerB64}.${payloadB64}`);
  const signature = b64url(signer.sign(signWith || key.privateKey));

  if (tamperPayload) {
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
 *
 * Dienst-Zugangsdaten gibt es nur für die Rollen, deren Ausstellweg das
 * Zugangsdatum IST: Scheduler und Backend-Prüfer. Leitungsagent und
 * Spezialisten arbeiten mit kurzlebigen, auftragsgebundenen Job-Token.
 */
export function makeEnv({
  serviceSecrets = null, workerSecrets = null, cursorSecrets = null,
  tenant = null, mode = null, origins = "https://management-xo2-pro.netlify.app",
  overrides = {},
} = {}) {
  const svc = serviceSecrets || { scheduler: randomSecret(), checker: randomSecret() };
  const worker = workerSecrets || { primary: randomSecret(), old: randomSecret() };
  const cursor = cursorSecrets || { primary: randomSecret(), old: randomSecret() };

  const base = {
    QUANTUS_V3_FIREBASE_PROJECT_ID: PROJECT_ID,
    QUANTUS_V3_POLICY_VERSION: POLICY_VERSION,
    QUANTUS_V3_ALLOWED_ORIGINS: origins,
    QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
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

/* ══ Ein selbstsigniertes X.509-Zertifikat, in reinem JavaScript ══════════
 *
 * Nur so viel ASN.1/DER, wie ein Zertifikat braucht. Damit läuft die
 * Zertifikatsstrecke (X509Certificate → publicKey) auf JEDEM Rechner, ohne
 * openssl, ohne Abhängigkeit, ohne übersprungenen Test.
 * ------------------------------------------------------------------------ */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let rest = n;
  while (rest > 0) { bytes.unshift(rest & 0xff); rest >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const SEQUENCE = 0x30, SET = 0x31, INTEGER = 0x02, BIT_STRING = 0x03,
      NULL = 0x05, OID = 0x06, UTF8STRING = 0x0c, UTCTIME = 0x17, CONTEXT0 = 0xa0;

function derInteger(value) {
  let bytes = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  // Führendes 0x00, damit die Zahl nicht negativ gelesen wird.
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return tlv(INTEGER, bytes);
}

// 1.2.840.113549.1.1.11 — sha256WithRSAEncryption
const OID_SHA256_RSA = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
// 2.5.4.3 — commonName
const OID_COMMON_NAME = Buffer.from([0x55, 0x04, 0x03]);

function algorithmIdentifier() {
  return tlv(SEQUENCE, Buffer.concat([tlv(OID, OID_SHA256_RSA), tlv(NULL, Buffer.alloc(0))]));
}

function nameWithCommonName(cn) {
  const atv = tlv(SEQUENCE, Buffer.concat([tlv(OID, OID_COMMON_NAME), tlv(UTF8STRING, Buffer.from(cn, "utf8"))]));
  return tlv(SEQUENCE, tlv(SET, atv));
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(UTCTIME, Buffer.from(text, "ascii"));
}

export function makeSelfSignedCertPem({ key = null, commonName = "quantus-v3-test", now = Date.now() } = {}) {
  const paar = key || makeSigningKey();
  const spki = paar.publicKey.export({ type: "spki", format: "der" });

  const tbs = tlv(SEQUENCE, Buffer.concat([
    tlv(CONTEXT0, derInteger(2)),                       // Version v3
    derInteger(randomBytes(8)),                          // Seriennummer
    algorithmIdentifier(),
    nameWithCommonName(commonName),                      // Aussteller
    tlv(SEQUENCE, Buffer.concat([                        // Gültigkeit
      utcTime(new Date(now - 60_000)),
      utcTime(new Date(now + 86_400_000)),
    ])),
    nameWithCommonName(commonName),                      // Inhaber
    spki,
  ]));

  const signer = createSign("RSA-SHA256");
  signer.update(tbs);
  const signature = signer.sign(paar.privateKey);

  const cert = tlv(SEQUENCE, Buffer.concat([
    tbs,
    algorithmIdentifier(),
    tlv(BIT_STRING, Buffer.concat([Buffer.from([0x00]), signature])),
  ]));

  const b64 = cert.toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return { pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, key: paar };
}
