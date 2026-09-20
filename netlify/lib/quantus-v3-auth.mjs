/* ══ Quantus Tagesbriefing v3 — Sicherheitspaket C1: Tür, Ausweis, Rolle ════
 *
 * WAS DAS IST — und was es NICHT ist
 * ----------------------------------
 * Dieses Modul ist die Tür vor den vier geplanten v3-Werkzeugen
 *   quantus_context  → Route quantus-context   (Kontext lesen)
 *   quantus_read     → Route quantus-read      (Objekte lesen)
 *   quantus_command  → Route quantus-ingest    (Befehl/Ergebnis annehmen)
 *   quantus_run_status → Route quantus-run-status (Lauf-Status lesen)
 * Es enthält AUSSCHLIESSLICH die Prüfungen: Ausweis, Rolle, Objektrecht,
 * Transport. Keine Geschäftslogik, kein Schreibweg, kein Netlify-Handler.
 * Kein Endpunkt wird durch diese Datei erreichbar — Paketgrenze C1, in den
 * Tests festgehalten.
 *
 * QUANTUS IST DAMIT NICHT ABGESICHERT. Die bestehenden Endpunkte (blob-put,
 * gcal-*, gmail-api, flowertech-*) bleiben unverändert und hängen weiter am
 * OPTIONALEN `SYNC_AUTH_TOKEN` — der hier ausdrücklich KEIN Standard ist.
 *
 * DIE FÜNF TRAGENDEN ENTSCHEIDUNGEN
 * ---------------------------------
 * 1. FAIL CLOSED. Fehlende oder halbe Konfiguration ⇒ 503 auth_not_configured,
 *    bevor irgendetwas gelesen wird. Auch `authorize()` ohne Serverkonfiguration
 *    oder ohne Policy-Version entscheidet NICHT — es sperrt.
 * 2. IDENTITÄT KOMMT NIE AUS DEM INHALT. Rolle, Mandant, Jobbindung stammen
 *    aus dem geprüften Ausweis. Und der Ausweis bestimmt zusätzlich die ART:
 *    Rolle, Art (user/worker/service) und Ausstellweg müssen zusammenpassen,
 *    sonst 403. Ein Principal, der `{kind:"worker", role:"user"}` behauptet,
 *    bekommt keine Nutzerrechte.
 * 3. LESEN WIRD WIE SCHREIBEN GEPRÜFT — und die Datenkategorie wird aus dem
 *    serverseitig geladenen Objekt ABGELEITET, nicht vom Aufrufer geglaubt.
 * 4. ETABLIERTE KRYPTO. Firebase-ID-Token und eigene Job-Token werden mit
 *    `jose` geprüft (feste Algorithmenliste, keine Eigenbauprotokolle).
 * 5. NUR FACHVERBEN. Die Matrix kennt die Verben des Konzepts
 *    (intake.*, lead.*, briefing.*, question.*, document.*, worker.*, run.*,
 *    note.append) — keine generischen Sammelverben.
 *
 * PRIMÄRQUELLEN (geprüft 19.09.2026)
 * ----------------------------------
 * • Firebase Auth, „Verify ID tokens using a third-party JWT library":
 *   alg = RS256, kid aus dem X.509-Endpunkt; exp in der Zukunft, iat und
 *   auth_time in der Vergangenheit, aud = Projekt-Id,
 *   iss = https://securetoken.google.com/<PROJECT_ID>, sub = uid (≤ 128).
 *   Schlüssel:
 *   https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *   Auffrischung nach `max-age` der Cache-Control-Kopfzeile. Der Endpunkt
 *   wurde direkt abgefragt: `cache-control: public, max-age=…, must-revalidate`.
 * • Firebase Auth, „Manage user sessions"
 *   (https://firebase.google.com/docs/auth/admin/manage-sessions): Widerruf
 *   wird über **auth_time** gegen `tokensValidAfterTime`/`validSince` geprüft —
 *   NICHT über iat. Das Admin-SDK tut mit `verifyIdToken(token, true)`
 *   dasselbe. Ein Token, das nach dem Widerruf nur neu AUSGESTELLT (iat neu),
 *   aber nicht neu ANGEMELDET (auth_time alt) wurde, muss scheitern —
 *   deshalb ist auth_time hier Pflichtfeld.
 * • Identity Platform, Admin-API `accounts:lookup`: `disabled`, `validSince`,
 *   `tenantId`.
 * • Identity Platform Mandanten: Mandanten-Id in `firebase.tenant`
 *   (Client-SDKs zusätzlich `tenant_id`).
 *
 * WAS HIER BEWUSST FEHLT (Beweis erst im Command-Handler)
 * -------------------------------------------------------
 * • Die serverseitige, atomare Ratenbegrenzung pro Principal: hier steht nur
 *   der VERTRAG (`RATE_LIMIT_CONTRACT`).
 * • Die Anbindung an echte Daten. Objekte kommen als serverseitig geladene
 *   Datensätze herein; Cursor sprechen nur über benannte Abfragen.
 * ═══════════════════════════════════════════════════════════════════════ */

import {
  createHash, createPublicKey, timingSafeEqual,
  X509Certificate, randomUUID,
} from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

/* ── Umgebung lesen: exakt das Muster der übrigen Netlify-Bibliotheken ──── */
export function envRead(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch {
    // Fällt auf process.env zurück — Tests und lokale Werkzeuge.
  }
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

/* ══ 0. Namen, Konstanten, Fehlerform ════════════════════════════════════ */

export const GOOGLE_SECURETOKEN_X509_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
export const FIREBASE_ISSUER_PREFIX = "https://securetoken.google.com/";
export const IDENTITY_TOOLKIT_BASE = "https://identitytoolkit.googleapis.com/v1";

/* Die vier Werkzeuge und ihre Routen. `enabled: false` ist keine Deko: Paket
   C1 schaltet nichts frei, ein Test hält fest, dass es zu keiner dieser Routen
   eine Netlify-Funktion gibt. */
export const QUANTUS_V3_TOOLS = Object.freeze({
  quantus_context:    Object.freeze({ route: "quantus-context",    enabled: false }),
  quantus_read:       Object.freeze({ route: "quantus-read",       enabled: false }),
  quantus_command:    Object.freeze({ route: "quantus-ingest",     enabled: false }),
  quantus_run_status: Object.freeze({ route: "quantus-run-status", enabled: false }),
});

export const COMMAND_MAX_BYTES = 64 * 1024;
export const MAX_JOB_TOKEN_LIFETIME_SECONDS = 15 * 60;

/* Uhrenversatz: beim ABLAUF null (ein abgelaufenes Token ist abgelaufen),
   bei iat/auth_time 60 s, weil fremde Uhren vorgehen dürfen. */
export const CLOCK_SKEW_SECONDS = 60;
export const MIN_SERVICE_SECRET_LENGTH = 32;

/* Ausstellwege. Jede Rolle hat GENAU EINEN — daran hängt, welcher Ausweis
   sie überhaupt erzeugen darf. */
export const ISSUERS = Object.freeze({
  firebase: "firebase",
  jobToken: "job_token",
  serviceCredential: "service_credential",
});

/* Aussteller-/Zielbezeichner der eigenen Token (JWT-Felder iss/aud). */
export const JOB_TOKEN_ISSUER = "quantus-v3/job-token";
export const JOB_TOKEN_TYP = "quantus-v3-job+jwt";
export const JOB_TOKEN_ALGS = Object.freeze(["HS256"]);
export const FIREBASE_ID_TOKEN_ALGS = Object.freeze(["RS256"]);

const ERROR_STATUS = Object.freeze({
  auth_not_configured: 503,
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limiter_not_configured: 503,
});

/* Die EINZIGE Stelle, an der eine Absage entsteht. `reason` ist immer ein
   fester Bezeichner aus dem Code — nie ein Wert aus der Anfrage, nie ein
   Teil eines Tokens. */
export function authError(error, reason) {
  const status = ERROR_STATUS[error];
  if (!status) throw new Error(`authError: unbekannter Fehlercode ${error}`);
  return Object.freeze({
    ok: false,
    status,
    error,
    reason: String(reason || ""),
    body: Object.freeze({ error, reason: String(reason || "") }),
  });
}

export function authOk(extra = {}) {
  return { ok: true, ...extra };
}

/* Endliche, ganzzahlige Sekundenangabe? Ein `exp: "99999999999"`, ein
   `iat: NaN` oder ein `auth_time: 1.5e300` ist keine Zeit. */
export function isFiniteSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    && value > 0 && value < 4_102_444_800; // < 2100-01-01
}

/* ══ 1. Rollenmodell ═════════════════════════════════════════════════════
 *
 * Die Verben sind die FACHVERBEN des Konzepts. Es gibt keine Sammelverben
 * („command.submit"), hinter denen sich beliebige Wirkung verstecken könnte.
 * Gelesen wird ausschliesslich über benannte Abfragen (`context.read`, siehe
 * quantus-v3-cursor.mjs) — es gibt kein freies Lesen.
 * ------------------------------------------------------------------------ */

export const VERBS = Object.freeze([
  "context.read",           // benannte Abfrage lesen (Notes/Policy/Run/Objektkontext)
  "intake.create", "intake.accept",
  "task.create",
  "lead.comment", "lead.transition", "lead.schedule",
  "briefing.answer",        // NUR Nutzer
  "briefing.consumeAnswer", // NUR Backend
  "question.create", "question.resolve",
  "document.register", "document.processed",
  "worker.assign", "worker.return", "worker.review",
  "run.ensure", "run.claim", "run.renew", "run.checkpoint", "run.finalize",
  "note.append", "run.log",
]);

export const DATA_CATEGORIES = Object.freeze([
  "intake", "task", "lead", "briefing", "briefing_answer", "question",
  "document", "assignment", "worker_result", "run", "run_context",
  "run_status", "note", "policy", "system_status",
]);

/* Objektart → Datenkategorie. Die Kategorie wird aus dem serverseitig
   GELADENEN Objekt abgeleitet; was der Aufrufer behauptet, muss dazu passen.
   Sonst liesse sich ein Policy-Datensatz als „task" lesen. */
export const OBJECT_KIND_CATEGORY = Object.freeze({
  intake: "intake",
  task: "task",
  lead: "lead",
  briefing: "briefing",
  briefing_answer: "briefing_answer",
  question: "question",
  document: "document",
  assignment: "assignment",
  worker_result: "worker_result",
  run: "run",
  run_context: "run_context",
  run_status: "run_status",
  note: "note",
  policy: "policy",
  system_status: "system_status",
});

export function dataCategoryForObjectKind(kind) {
  const k = String(kind || "");
  return Object.prototype.hasOwnProperty.call(OBJECT_KIND_CATEGORY, k) ? OBJECT_KIND_CATEGORY[k] : null;
}

const VERB_SET = new Set(VERBS);
const CATEGORY_SET = new Set(DATA_CATEGORIES);

/*
 * Objektbindung:
 *   "own"      Objekt gehört dem Principal (ownerId)
 *   "job"      Objekt gehört GENAU dem Job, auf den das Token lautet
 *   "assigned" Objekt ist dem Principal serverseitig zugewiesen
 *   "tenant"   Objekt liegt im Mandanten (schwächste Bindung, nur Dienste)
 */
export const ROLE_POLICY = Object.freeze({
  /* Der Mensch. Eigene Vorgänge, eigene Antworten, eigene Oberfläche.
     `briefing.answer` gibt es NUR hier. */
  user: Object.freeze({
    kind: "user",
    issuedBy: ISSUERS.firebase,
    binding: "own",
    verbs: Object.freeze({
      "context.read":      ["intake", "task", "lead", "briefing", "briefing_answer", "question", "document", "run", "run_status", "note", "policy"],
      "intake.create":     ["intake"],
      "intake.accept":     ["intake"],
      "task.create":       ["task"],
      "lead.comment":      ["lead"],
      "lead.transition":   ["lead"],
      "lead.schedule":     ["lead"],
      "briefing.answer":   ["briefing_answer"],
      "question.resolve":  ["question"],
      "document.register": ["document"],
      "note.append":       ["note"],
    }),
  }),

  /* Leitungsagent (OpenAI Lead API auf Cloud Run). Arbeitet NUR im
     serverseitig zugewiesenen Kontext: delegieren (worker.assign), eigene
     erlaubte Arbeit erledigen (lead.*, task.create, question.create),
     Ergebnisse prüfen (worker.review), Lauf fortschreiben (run.checkpoint,
     run.log). NIE Nutzerantworten, nie Rechte, nie Abschluss. */
  lead_agent: Object.freeze({
    kind: "worker",
    issuedBy: ISSUERS.jobToken,
    binding: "assigned",
    verbs: Object.freeze({
      "context.read":       ["run_context", "lead", "task", "document", "question", "note", "run", "policy"],
      "lead.comment":       ["lead"],
      "lead.transition":    ["lead"],
      "lead.schedule":      ["lead"],
      "task.create":        ["task"],
      "question.create":    ["question"],
      "document.processed": ["document"],
      "worker.assign":      ["assignment"],
      "worker.review":      ["worker_result"],
      "run.checkpoint":     ["run"],
      "run.log":            ["run"],
    }),
  }),

  /* Claude-Spezialist: den Kontext SEINES Auftrags lesen, das Ergebnis an
     diesen Auftrag zurückgeben. Sonst nichts. */
  specialist_claude: Object.freeze({
    kind: "worker",
    issuedBy: ISSUERS.jobToken,
    binding: "job",
    verbs: Object.freeze({
      "context.read":  ["run_context"],
      "worker.return": ["worker_result"],
    }),
  }),

  /* Gemini-Spezialist: identische Grenzen. */
  specialist_gemini: Object.freeze({
    kind: "worker",
    issuedBy: ISSUERS.jobToken,
    binding: "job",
    verbs: Object.freeze({
      "context.read":  ["run_context"],
      "worker.return": ["worker_result"],
    }),
  }),

  /* Scheduler (Cloud Scheduler/Tasks): Läufe anlegen, übernehmen, verlängern,
     protokollieren. Keine Inhalte, keine Freigaben, kein Abschluss. */
  scheduler: Object.freeze({
    kind: "service",
    issuedBy: ISSUERS.serviceCredential,
    binding: "tenant",
    verbs: Object.freeze({
      "context.read": ["run", "run_status"],
      "run.ensure":   ["run"],
      "run.claim":    ["run"],
      "run.renew":    ["run"],
      "run.log":      ["run"],
    }),
  }),

  /* Backend-Prüfer: rechnet den Tagesstatus, verbraucht Nutzerantworten,
     schreibt Start-/Finalnotizen und schliesst den Lauf ab. Keine freien
     externen Aktionen. */
  backend_checker: Object.freeze({
    kind: "service",
    issuedBy: ISSUERS.serviceCredential,
    binding: "tenant",
    verbs: Object.freeze({
      "context.read":           ["run", "run_status", "system_status", "note", "briefing", "briefing_answer", "policy"],
      "briefing.consumeAnswer": ["briefing_answer"],
      "document.processed":     ["document"],
      "run.checkpoint":         ["run"],
      "run.finalize":           ["run"],
      "run.log":                ["run"],
      "note.append":            ["note"],
    }),
  }),
});

export const ROLES = Object.freeze(Object.keys(ROLE_POLICY));

/* Rollen nach Ausstellweg. Ein Job-Token kann NUR eine Job-Token-Rolle
   tragen: Scheduler- und Backend-Autorität wird nie an einen Worker
   ausgestellt (sonst hätte ein kurzlebiges Auftragstoken Abschlussrechte). */
export const JOB_TOKEN_ROLES = Object.freeze(ROLES.filter((r) => ROLE_POLICY[r].issuedBy === ISSUERS.jobToken));
export const SERVICE_CREDENTIAL_ROLES = Object.freeze(ROLES.filter((r) => ROLE_POLICY[r].issuedBy === ISSUERS.serviceCredential));
export const FIREBASE_ROLES = Object.freeze(ROLES.filter((r) => ROLE_POLICY[r].issuedBy === ISSUERS.firebase));

/* ══ 2. Konfiguration — fail closed, ohne je einen Wert zu nennen ═════════ */

export const AUTH_CONFIG_VARS = Object.freeze({
  projectId: "QUANTUS_V3_FIREBASE_PROJECT_ID",
  tenant: "QUANTUS_V3_FIREBASE_TENANT",
  origins: "QUANTUS_V3_ALLOWED_ORIGINS",
  serviceCredentials: "QUANTUS_V3_SERVICE_CREDENTIALS",
  workerKeys: "QUANTUS_V3_WORKER_TOKEN_KEYS",
  policyVersion: "QUANTUS_V3_POLICY_VERSION",
  mode: "QUANTUS_V3_MODE",
});

const VALID_KEY_STATUS = new Set(["active", "retiring", "revoked"]);

function parseJsonVar(read, name) {
  const raw = String(read(name) || "").trim();
  if (!raw) return { missing: true };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    // Der Inhalt wird NICHT in den Fehler übernommen — er kann ein Geheimnis
    // sein. Nur der Name der Variable wird genannt.
    return { broken: true };
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/* Zeitgleicher Vergleich zweier Hex-Digests. */
function equalHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function normalizeOrigins(raw) {
  const list = String(raw || "").split(",").map((v) => v.trim()).filter(Boolean);
  const out = [];
  for (const entry of list) {
    if (entry === "*" || entry.includes("*")) return { wildcard: true };
    let url;
    try { url = new URL(entry); } catch { return { invalid: true }; }
    if (url.protocol !== "https:") return { insecure: true };
    if (url.pathname !== "/" || url.search || url.hash) return { invalid: true };
    out.push(url.origin);
  }
  if (!out.length) return { empty: true };
  return { origins: Object.freeze(out) };
}

function normalizeServiceCredentials(value) {
  if (!Array.isArray(value) || !value.length) return { invalid: "service_credentials_shape" };
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { invalid: "service_credentials_shape" };
    const id = String(entry.id || "").trim();
    const principal = String(entry.principal || "").trim();
    const role = String(entry.role || "").trim();
    const tenant = String(entry.tenant || "").trim();
    const secretSha256 = String(entry.secretSha256 || "").trim().toLowerCase();
    const status = String(entry.status || "active").trim();
    if (!id || seen.has(id)) return { invalid: "service_credentials_id" };
    seen.add(id);
    if (!principal || !role || !tenant) return { invalid: "service_credentials_principal" };
    if (!/^[0-9a-f]{64}$/.test(secretSha256)) return { invalid: "service_credentials_hash" };
    if (!VALID_KEY_STATUS.has(status)) return { invalid: "service_credentials_status" };
    // NUR Rollen, deren Ausstellweg das Dienst-Zugangsdatum IST. Ein
    // Leitungsagent oder Spezialist bekommt kein Dauer-Zugangsdatum; er
    // arbeitet mit kurzlebigen, auftragsgebundenen Token.
    if (!SERVICE_CREDENTIAL_ROLES.includes(role)) return { invalid: "service_credentials_role" };

    // Ablauf gilt in JEDEM Status — auch bei „active". Ein Zugangsdatum mit
    // abgelaufenem Stichtag ist abgelaufen, egal wie es beschriftet ist.
    let notAfter = null;
    if (entry.notAfter != null && String(entry.notAfter).trim() !== "") {
      const parsed = Date.parse(String(entry.notAfter));
      if (!Number.isFinite(parsed)) return { invalid: "service_credentials_not_after" };
      notAfter = parsed;
    }
    // Ein auslaufendes Zugangsdatum OHNE Stichtag liefe unbegrenzt weiter.
    if (status === "retiring" && notAfter == null) return { invalid: "service_credentials_not_after_required" };

    out.push(Object.freeze({ id, principal, role, tenant, secretSha256, status, notAfter }));
  }
  if (!out.some((c) => c.status === "active")) return { invalid: "service_credentials_no_active" };
  return { credentials: Object.freeze(out) };
}

function normalizeSigningKeys(value, varName) {
  if (!Array.isArray(value) || !value.length) return { invalid: `${varName}_shape` };
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { invalid: `${varName}_shape` };
    const kid = String(entry.kid || "").trim();
    const secret = String(entry.secret || "");
    const status = String(entry.status || "active").trim();
    if (!kid || seen.has(kid) || !/^[A-Za-z0-9_-]{1,64}$/.test(kid)) return { invalid: `${varName}_kid` };
    seen.add(kid);
    if (secret.length < MIN_SERVICE_SECRET_LENGTH) return { invalid: `${varName}_secret_too_short` };
    if (!VALID_KEY_STATUS.has(status)) return { invalid: `${varName}_status` };
    out.push(Object.freeze({ kid, secret, status }));
  }
  if (!out.some((k) => k.status === "active")) return { invalid: `${varName}_no_active` };
  return { keys: Object.freeze(out) };
}

export function resolveAuthConfig(read = envRead) {
  const V = AUTH_CONFIG_VARS;
  const missing = [];

  const projectId = String(read(V.projectId) || "").trim();
  if (!projectId) missing.push(V.projectId);

  const policyVersion = String(read(V.policyVersion) || "").trim();
  if (!policyVersion) missing.push(V.policyVersion);

  const originsRaw = String(read(V.origins) || "").trim();
  if (!originsRaw) missing.push(V.origins);

  const creds = parseJsonVar(read, V.serviceCredentials);
  if (creds.missing) missing.push(V.serviceCredentials);

  const workerKeys = parseJsonVar(read, V.workerKeys);
  if (workerKeys.missing) missing.push(V.workerKeys);

  if (missing.length) {
    const denial = authError("auth_not_configured", "missing_configuration");
    return { ok: false, status: denial.status, error: denial.error, reason: denial.reason,
      missing: Object.freeze(missing), body: Object.freeze({ ...denial.body, missing: Object.freeze(missing) }) };
  }
  if (creds.broken) return failConfig("service_credentials_unparsable");
  if (workerKeys.broken) return failConfig("worker_keys_unparsable");

  const origins = normalizeOrigins(originsRaw);
  if (origins.wildcard) return failConfig("origin_wildcard_forbidden");
  if (origins.insecure) return failConfig("origin_requires_https");
  if (origins.invalid || origins.empty) return failConfig("origin_list_invalid");

  const service = normalizeServiceCredentials(creds.value);
  if (service.invalid) return failConfig(service.invalid);

  const worker = normalizeSigningKeys(workerKeys.value, "worker_keys");
  if (worker.invalid) return failConfig(worker.invalid);

  const tenant = String(read(V.tenant) || "").trim();

  const modeRaw = String(read(V.mode) || "").trim().toLowerCase();
  if (modeRaw && modeRaw !== "dry_run" && modeRaw !== "enforce") return failConfig("mode_invalid");
  const mode = modeRaw || "dry_run";

  return {
    ok: true,
    config: Object.freeze({
      projectId,
      issuer: FIREBASE_ISSUER_PREFIX + projectId,
      tenant: tenant || null,
      allowedOrigins: origins.origins,
      serviceCredentials: service.credentials,
      workerKeys: worker.keys,
      policyVersion,
      mode,
      dryRun: mode !== "enforce",
    }),
  };
}

function failConfig(reason) {
  const denial = authError("auth_not_configured", reason);
  return { ok: false, status: denial.status, error: denial.error, reason: denial.reason,
    missing: Object.freeze([]), body: denial.body };
}

/* ══ 3. Die zentrale Rechteprüfung ═══════════════════════════════════════
 *
 *   principal { kind, id, role, tenant, issuedBy, jobId?, assignedJobIds? }
 *   verb, dataCategory
 *   object    serverseitig GELADENER Datensatz
 *             { kind, id, tenant, ownerId?, jobId?, assignedTo? }
 *
 * Fehlt die Serverkonfiguration oder die Policy-Version, wird NICHT
 * entschieden — das ist kein Randfall, sondern der Normalfall eines halb
 * ausgerollten Systems.
 * ------------------------------------------------------------------------ */
export function authorize({ principal, verb, dataCategory, object, policyVersion, config } = {}) {
  // (a) Ohne geprüfte Serverkonfiguration gibt es keine Entscheidung.
  if (!config || typeof config !== "object" || !config.policyVersion) {
    return authError("auth_not_configured", "config_missing");
  }
  if (!policyVersion) return authError("forbidden", "policy_version_missing");
  if (String(policyVersion) !== String(config.policyVersion)) {
    return authError("forbidden", "policy_version_mismatch");
  }

  // (b) Rolle, Art und Ausstellweg müssen zusammenpassen.
  if (!principal || typeof principal !== "object") return authError("forbidden", "principal_missing");
  const role = String(principal.role || "");
  const policy = Object.prototype.hasOwnProperty.call(ROLE_POLICY, role) ? ROLE_POLICY[role] : null;
  if (!policy) return authError("forbidden", "unknown_role");
  if (String(principal.kind || "") !== policy.kind) return authError("forbidden", "principal_kind_mismatch");
  if (String(principal.issuedBy || "") !== policy.issuedBy) return authError("forbidden", "principal_issuer_mismatch");
  const principalId = String(principal.id || "");
  if (!principalId) return authError("forbidden", "principal_id_missing");
  const principalTenant = String(principal.tenant || "");
  if (!principalTenant) return authError("forbidden", "tenant_missing");

  // (c) Verb und Kategorie müssen bekannt und für die Rolle erlaubt sein.
  if (!VERB_SET.has(verb)) return authError("forbidden", "unknown_verb");
  if (!CATEGORY_SET.has(dataCategory)) return authError("forbidden", "unknown_data_category");
  const allowedCategories = Object.prototype.hasOwnProperty.call(policy.verbs, verb) ? policy.verbs[verb] : null;
  if (!allowedCategories) return authError("forbidden", "verb_not_allowed_for_role");
  if (!allowedCategories.includes(dataCategory)) return authError("forbidden", "data_category_not_allowed_for_role");

  // (d) Das Objekt. Die Kategorie wird aus seiner ART abgeleitet — was der
  // Aufrufer behauptet, muss dazu passen, sonst liesse sich ein
  // Policy-Datensatz als „task" lesen.
  if (!object || typeof object !== "object") return authError("forbidden", "object_missing");
  const objectCategory = dataCategoryForObjectKind(object.kind);
  if (!objectCategory) return authError("forbidden", "object_kind_unknown");
  if (objectCategory !== dataCategory) return authError("forbidden", "object_kind_mismatch");
  const objectId = String(object.id || "");
  if (!objectId) return authError("forbidden", "object_id_missing");
  const objectTenant = String(object.tenant || "");
  if (!objectTenant) return authError("forbidden", "tenant_missing");
  if (principalTenant !== objectTenant) return authError("forbidden", "tenant_mismatch");

  // (e) Bindung.
  switch (policy.binding) {
    case "own": {
      const owner = String(object.ownerId || "");
      if (!owner) return authError("forbidden", "object_owner_missing");
      if (owner !== principalId) return authError("forbidden", "object_not_owned");
      break;
    }
    case "job": {
      const boundJob = String(principal.jobId || "");
      if (!boundJob) return authError("forbidden", "job_binding_missing");
      const objectJob = String(object.jobId || "");
      if (!objectJob) return authError("forbidden", "object_job_missing");
      if (objectJob !== boundJob) return authError("forbidden", "object_foreign_job");
      break;
    }
    case "assigned": {
      const assigned = Array.isArray(principal.assignedJobIds) ? principal.assignedJobIds.map(String) : [];
      const objectJob = String(object.jobId || "");
      const assignedTo = String(object.assignedTo || "");
      const okByJob = objectJob && assigned.includes(objectJob);
      const okByAssignment = assignedTo && assignedTo === principalId;
      if (!okByJob && !okByAssignment) return authError("forbidden", "object_not_assigned");
      break;
    }
    case "tenant":
      break;
    default:
      return authError("forbidden", "unknown_binding");
  }

  return authOk({ role, verb, dataCategory, objectId });
}

/* ── Identität darf nie aus dem Inhalt kommen ──────────────────────────── */
export const IDENTITY_FIELDS = Object.freeze([
  "role", "roles", "principal", "principalId", "tenant", "tenantId",
  "scope", "scopes", "grants", "permissions", "capabilities", "uid",
  "impersonate", "act_as", "actAs", "issuedBy", "kind",
]);

export function rejectIdentityInPayload(body, { depth = 2 } = {}) {
  const found = findIdentityField(body, depth);
  if (found) return authError("invalid_request", "identity_in_payload");
  return authOk();
}

function findIdentityField(value, depth) {
  if (!value || typeof value !== "object" || depth < 0) return null;
  if (Array.isArray(value)) {
    for (const entry of value) { const hit = findIdentityField(entry, depth - 1); if (hit) return hit; }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (IDENTITY_FIELDS.includes(key)) return key;
    const hit = findIdentityField(value[key], depth - 1);
    if (hit) return hit;
  }
  return null;
}

/* ══ 4. Firebase-ID-Token ════════════════════════════════════════════════ */

function b64urlToBuffer(segment) {
  const s = String(segment || "");
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/* Nur die Kopfzeile lesen, um kid/alg zu finden. Das Ergebnis ist KEINE
   Identität — die Prüfung macht `jose`. */
export function readJwtHeader(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[2]) return null;
  const buf = b64urlToBuffer(parts[0]);
  if (!buf) return null;
  try {
    const header = JSON.parse(buf.toString("utf8"));
    return header && typeof header === "object" ? header : null;
  } catch { return null; }
}

/* Aus dem X.509-Zertifikat (so liefert Google die Schlüssel) wird der
   öffentliche Schlüssel — mit node:crypto, nicht von Hand. Ein reiner
   Public-Key im PEM wird ebenfalls akzeptiert. */
export function publicKeyFromPem(pem) {
  const text = String(pem || "");
  if (text.includes("BEGIN CERTIFICATE")) return new X509Certificate(text).publicKey;
  return createPublicKey(text);
}

/*
 * Der Schlüsselbezug von Google.
 *
 * BEFUND (Review 5ac0bf7): Die erste Fassung holte bei JEDER unbekannten kid
 * neu — fünf gefälschte Token mit fünf erfundenen kids ergaben fünf
 * Netzabrufe. Das ist ein unauthentifizierter Hebel auf Googles Endpunkt
 * (und auf das eigene Funktionsbudget).
 *
 * Jetzt: gebündelte Auffrischung (singleflight), Abkühlzeit zwischen zwei
 * Auffrischungen, und ein begrenztes Negativgedächtnis für kids, die es
 * gerade nicht gibt. Ein echter Schlüsselwechsel wirkt weiterhin — spätestens
 * nach der Abkühlzeit, und ohnehin beim Ablauf von `max-age`.
 */
export function createGooglePublicKeySource({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  refreshCooldownMs = 60_000,
  defaultTtlMs = 300_000,
} = {}) {
  let cache = null;              // { pems: Map<kid,string>, keys: Map<kid,KeyObject>, expiresAt }
  let lastRefreshAt = -Infinity; // auch ein FEHLGESCHLAGENER Versuch zählt
  let inFlight = null;

  async function doRefresh() {
    if (typeof fetchImpl !== "function") throw new Error("public_key_source_unavailable");
    const res = await fetchImpl(GOOGLE_SECURETOKEN_X509_URL, { headers: { Accept: "application/json" } });
    if (!res || !res.ok) throw new Error("public_key_fetch_failed");
    const body = await res.json();
    if (!body || typeof body !== "object") throw new Error("public_key_fetch_failed");
    const cc = String(res.headers?.get?.("cache-control") || "");
    const m = /max-age\s*=\s*(\d+)/i.exec(cc);
    const ttlMs = m ? Number(m[1]) * 1000 : defaultTtlMs;
    cache = { pems: new Map(Object.entries(body)), keys: new Map(), expiresAt: now() + ttlMs };
    return cache;
  }

  /* Singleflight: parallele Aufrufe teilen sich EINEN Abruf. `lastRefreshAt`
     wird auch bei einem Fehlschlag gesetzt — sonst fragte ein ausgefallener
     Endpunkt in einer Schleife weiter. */
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = doRefresh().finally(() => { lastRefreshAt = now(); inFlight = null; });
    return inFlight;
  }

  const abkuehlzeitVorbei = () => (now() - lastRefreshAt) >= refreshCooldownMs;
  const frisch = () => Boolean(cache) && cache.expiresAt > now();

  function fromCache(kid) {
    if (!frisch() || !cache.pems.has(kid)) return null;
    if (!cache.keys.has(kid)) cache.keys.set(kid, publicKeyFromPem(cache.pems.get(kid)));
    return cache.keys.get(kid);
  }

  return {
    /*
     * BEFUND (Review 9ff3423): Die Abkühlzeit galt nur für die unbekannte kid.
     * War der Cache LEER oder ABGELAUFEN — etwa weil der Endpunkt gerade
     * ausfällt —, lief jeder Aufruf erneut ins Netz: fünf Aufrufe mit
     * erfundenen kids in derselben Minute ergaben fünf Abrufe.
     *
     * Jetzt gilt dieselbe Schranke für BEIDE Wege: ein Abruf je Abkühlzeit,
     * gebündelt (Singleflight). Und ohne frisches Schlüsselmaterial gibt es
     * kein Ja: ein abgelaufener Cache wird NICHT weiterbenutzt, auch nicht
     * „nur diesmal".
     */
    async get(kid) {
      const id = String(kid || "");
      if (!id) return null;

      if (!frisch()) {
        if (!abkuehlzeitVorbei()) return null;      // fail closed, ohne Netz
        await refresh();                            // wirft bei Ausfall
        if (!frisch()) return null;
      }

      const treffer = fromCache(id);
      if (treffer) return treffer;

      // Unbekannte kid kann ein Schlüsselwechsel sein — höchstens EIN Abruf
      // je Abkühlzeit, damit erfundene kids kein Netz kosten.
      if (!abkuehlzeitVorbei()) return null;
      await refresh();
      return fromCache(id);
    },
  };
}

/*
 * Widerruf und Sperre über die offizielle Admin-API `accounts:lookup`.
 * Der Zugriffstoken kommt als Abhängigkeit herein — dieses Modul hält kein
 * Dienstkonto und liest keines.
 */
export function createIdentityToolkitUserLookup({ fetchImpl = globalThis.fetch, getAccessToken, projectId, tenantId = null } = {}) {
  if (typeof getAccessToken !== "function") return null;
  const base = tenantId
    ? `${IDENTITY_TOOLKIT_BASE}/projects/${encodeURIComponent(projectId)}/tenants/${encodeURIComponent(tenantId)}/accounts:lookup`
    : `${IDENTITY_TOOLKIT_BASE}/projects/${encodeURIComponent(projectId)}/accounts:lookup`;
  return async function lookup(uid) {
    const token = await getAccessToken();
    if (!token) throw new Error("user_lookup_unavailable");
    const res = await fetchImpl(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ localId: [uid] }),
    });
    if (!res || !res.ok) throw new Error("user_lookup_failed");
    const body = await res.json();
    const user = Array.isArray(body?.users) ? body.users[0] : null;
    if (!user) return null;
    // `validSince` kommt als Sekunden-ZEICHENKETTE. Eine beschädigte Antwort
    // darf daraus kein NaN machen, das später als „0" durchgeht: was nicht
    // rein aus Ziffern besteht, ist ein Fehler.
    let validSince = 0;
    if (user.validSince != null) {
      const roh = String(user.validSince).trim();
      if (!/^\d{1,12}$/.test(roh)) throw new Error("user_lookup_invalid");
      validSince = Number(roh);
      if (!Number.isSafeInteger(validSince)) throw new Error("user_lookup_invalid");
    }
    return {
      disabled: user.disabled === true,
      validSince,
      tenantId: user.tenantId ? String(user.tenantId) : null,
    };
  };
}

export function tenantFromClaims(payload) {
  const nested = payload?.firebase && typeof payload.firebase === "object" ? payload.firebase.tenant : undefined;
  const top = payload?.tenant_id;
  const a = nested == null ? null : String(nested);
  const b = top == null ? null : String(top);
  if (a && b && a !== b) return { conflict: true };
  return { tenant: a || b || null };
}

/* jose-Fehler → fester Grund. Kein Fehlertext aus der Bibliothek wandert in
   eine Antwort; nur unsere eigenen Bezeichner. */
function joseReason(err, { claimReasons = {} } = {}) {
  if (err instanceof joseErrors.JWTExpired) return "token_expired";
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "token_signature_invalid";
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return "token_alg_not_allowed";
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = String(err.claim || "");
    return claimReasons[claim] || `token_claim_invalid_${claim || "unknown"}`;
  }
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return "token_malformed";
  if (err && err.code === "QV3_KID_UNKNOWN") return "token_kid_unknown";
  if (err && err.code === "QV3_KEY_UNAVAILABLE") return "token_key_unavailable";
  return "token_invalid";
}

/*
 * Die echte Prüfung eines Firebase-ID-Tokens.
 *
 * Reihenfolge: Form und Kopfzeile, Signatur samt Standardansprüchen (jose,
 * feste Algorithmenliste), eigene Zusatzansprüche, Mandant, zuletzt Widerruf
 * und Sperre — der einzige Schritt, der das Netz braucht.
 *
 * ACHTUNG (Review 5ac0bf7): Ein gefälschtes Token mit ERFUNDENER kid kann
 * einen Schlüsselabruf auslösen. Deshalb hat die Schlüsselquelle Abkühlzeit
 * und Negativgedächtnis (siehe oben) — nicht, weil es nie passiert.
 */
export async function verifyFirebaseIdToken(idToken, {
  config, keySource, userLookup, now = () => Date.now(),
} = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  if (!keySource || typeof keySource.get !== "function") return authError("auth_not_configured", "public_key_source_missing");
  // Ohne Widerrufsprüfung wird NICHT durchgelassen.
  if (typeof userLookup !== "function") return authError("auth_not_configured", "user_lookup_missing");

  const header = readJwtHeader(idToken);
  if (!header) return authError("unauthorized", "token_malformed");
  if (String(header.alg || "") !== "RS256") return authError("unauthorized", "token_alg_not_rs256");
  const kid = String(header.kid || "");
  if (!kid) return authError("unauthorized", "token_kid_missing");

  const currentDate = new Date(now());
  let payload;
  try {
    const verified = await jwtVerify(
      idToken,
      async (protectedHeader) => {
        const key = await keySource.get(String(protectedHeader.kid || ""));
        if (!key) {
          const err = new Error("kid unbekannt");
          err.code = "QV3_KID_UNKNOWN";
          throw err;
        }
        return key;
      },
      {
        algorithms: [...FIREBASE_ID_TOKEN_ALGS],
        issuer: config.issuer,
        audience: config.projectId,
        clockTolerance: 0,
        currentDate,
        requiredClaims: ["sub", "iat", "exp", "auth_time"],
      },
    );
    payload = verified.payload;
  } catch (err) {
    const reason = joseReason(err, {
      claimReasons: {
        aud: "token_audience_mismatch",
        iss: "token_issuer_mismatch",
        sub: "token_subject_invalid",
        iat: "token_iat_invalid",
        exp: "token_expired",
        auth_time: "token_auth_time_invalid",
      },
    });
    return authError("unauthorized", reason);
  }

  const nowSec = Math.floor(now() / 1000);

  // Endliche, ganzzahlige Zeitangaben — „1e999" ist keine Sekunde.
  if (!isFiniteSeconds(payload.exp)) return authError("unauthorized", "token_expired");
  if (!isFiniteSeconds(payload.iat) || payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
    return authError("unauthorized", "token_iat_invalid");
  }
  // auth_time ist PFLICHT: der Widerruf hängt daran (Firebase, Manage user
  // sessions). Fehlt sie oder ist sie unbrauchbar, wird nicht geprüft werden
  // können — also wird nicht durchgelassen.
  if (!isFiniteSeconds(payload.auth_time) || payload.auth_time > nowSec + CLOCK_SKEW_SECONDS) {
    return authError("unauthorized", "token_auth_time_invalid");
  }
  if (payload.auth_time > payload.iat + CLOCK_SKEW_SECONDS) {
    // Anmeldung nach Ausstellung gibt es nicht.
    return authError("unauthorized", "token_auth_time_invalid");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub || sub.length > 128) return authError("unauthorized", "token_subject_invalid");

  const tenantClaim = tenantFromClaims(payload);
  if (tenantClaim.conflict) return authError("unauthorized", "token_tenant_conflict");
  const expectedTenant = config.tenant || null;
  if (expectedTenant && tenantClaim.tenant !== expectedTenant) return authError("forbidden", "tenant_mismatch");
  if (!expectedTenant && tenantClaim.tenant) return authError("forbidden", "tenant_unexpected");

  let record = null;
  try {
    record = await userLookup(sub);
  } catch {
    return authError("unauthorized", "user_lookup_failed");
  }
  if (!record || typeof record !== "object") return authError("unauthorized", "user_unknown");
  // `disabled` darf nur ein echtes `false` (oder gar nichts) sein. Ein
  // "false" als Zeichenkette, eine 0 oder irgendein anderer Wert ist ein
  // unbrauchbarer Datensatz — und der öffnet hier nichts.
  if (record.disabled !== false && record.disabled != null) return authError("forbidden", "user_disabled");

  /*
   * BEFUND (Review 9ff3423): `Number(record.validSince || 0)` deutete NaN zu 0
   * um — aus einer beschädigten `validSince`-Antwort wurde „nie widerrufen".
   * Genau das kann die echte Lookup-Funktion aus einer kaputten Antwort
   * erzeugen. Jetzt: 0 ist gültig (nie widerrufen), fehlend ist 0, alles
   * andere muss eine endliche, nicht negative GANZE Sekundenzahl sein —
   * sonst wird nicht durchgelassen. Kein truthy-Rückfall.
   */
  const rohValidSince = record.validSince;
  let validSince = 0;
  if (rohValidSince != null) {
    if (typeof rohValidSince !== "number") return authError("unauthorized", "user_lookup_invalid");
    validSince = rohValidSince;
  }
  if (!Number.isFinite(validSince) || !Number.isInteger(validSince)
    || validSince < 0 || validSince > 4_102_444_800) {
    return authError("unauthorized", "user_lookup_invalid");
  }
  // WIDERRUF: gemessen an auth_time, nicht an iat. Ein nach dem Widerruf
  // frisch AUSGESTELLTES Token (neues iat) trägt weiterhin die ALTE
  // Anmeldezeit — nur auth_time entlarvt es.
  if (validSince > payload.auth_time) return authError("unauthorized", "token_revoked");

  const recordTenant = record.tenantId || null;
  if ((expectedTenant || null) !== (recordTenant || null)) return authError("forbidden", "tenant_mismatch");

  return authOk({
    principal: Object.freeze({
      kind: "user",
      issuedBy: ISSUERS.firebase,
      id: sub,
      role: "user",
      tenant: expectedTenant || config.projectId,
      credentialId: null,
      jobId: null,
      authTime: payload.auth_time,
    }),
  });
}

/* ══ 5. Dienstaufrufe — eigene, rotierbare Pflicht-Zugangsdaten ═══════════ */

export function parseAuthorizationHeader(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : raw;
}

export function verifyServiceCredential(presented, { config, now = () => Date.now() } = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  const secret = String(presented || "");
  if (!secret) return authError("unauthorized", "credential_missing");
  if (secret.length < MIN_SERVICE_SECRET_LENGTH) return authError("unauthorized", "credential_invalid");

  const digest = sha256Hex(secret);
  const nowMs = now();
  let matched = null;
  for (const cred of config.serviceCredentials) {
    if (equalHex(digest, cred.secretSha256)) matched = matched || cred;
  }
  if (!matched) return authError("unauthorized", "credential_invalid");
  if (matched.status === "revoked") return authError("unauthorized", "credential_revoked");
  // Der Stichtag gilt in JEDEM Status (Review 5ac0bf7: ein „active" mit
  // abgelaufenem notAfter kam vorher durch).
  if (matched.notAfter != null && matched.notAfter <= nowMs) return authError("unauthorized", "credential_expired");

  const policy = ROLE_POLICY[matched.role];
  if (!policy || policy.issuedBy !== ISSUERS.serviceCredential) return authError("forbidden", "unknown_role");

  return authOk({
    principal: Object.freeze({
      kind: policy.kind,
      issuedBy: ISSUERS.serviceCredential,
      id: matched.principal,
      role: matched.role,
      tenant: matched.tenant,
      credentialId: matched.id,
      jobId: null,
    }),
  });
}

/* ══ 6. Job-Token für Worker — kurzlebige, gebundene JWT ══════════════════
 *
 * BEFUND (Review 5ac0bf7): Die erste Fassung hatte ein eigenes Tokenformat.
 * Ein selbst erfundenes Protokoll ist auch dann eine Eigenentwicklung, wenn
 * die Primitive stimmen — und es ist für niemanden prüfbar. Jetzt: JWT (JWS
 * compact) über `jose`, feste Algorithmenliste (HS256), fester Aussteller,
 * audience = Route, `job` als Pflichtanspruch, kid im Kopf für die Rotation.
 *
 * Scheduler- und Backend-Rollen sind hier NICHT ausstellbar: ihre Autorität
 * hängt am Dienst-Zugangsdatum, nicht an einem Auftragstoken.
 * ------------------------------------------------------------------------ */

function secretKey(secret) {
  return new TextEncoder().encode(secret);
}

function pickKey(keys, kid) {
  return keys.find((k) => k.kid === kid) || null;
}

function activeKey(keys) {
  return keys.find((k) => k.status === "active") || null;
}

export async function mintJobToken({
  config, audience, jobId, role, principalId, tenant,
  assignedJobIds = null, lifetimeSeconds = 300, now = () => Date.now(), jti = null,
} = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  const key = activeKey(config.workerKeys);
  if (!key) return authError("auth_not_configured", "worker_keys_no_active");

  const aud = String(audience || "");
  const job = String(jobId || "");
  const r = String(role || "");
  const principal = String(principalId || "");
  const tnt = String(tenant || "");
  if (!aud || !/^[A-Za-z0-9_.:-]{1,128}$/.test(aud)) return authError("invalid_request", "audience_invalid");
  if (!job || !/^[A-Za-z0-9_-]{1,128}$/.test(job)) return authError("invalid_request", "job_id_invalid");
  if (!JOB_TOKEN_ROLES.includes(r)) return authError("forbidden", "role_not_allowed_for_job_token");
  if (!principal || !tnt) return authError("invalid_request", "principal_or_tenant_missing");
  const life = Number(lifetimeSeconds);
  if (!Number.isFinite(life) || life <= 0) return authError("invalid_request", "lifetime_invalid");
  if (life > MAX_JOB_TOKEN_LIFETIME_SECONDS) return authError("invalid_request", "lifetime_too_long");

  const nowSec = Math.floor(now() / 1000);
  const token = await new SignJWT({
    job,
    role: r,
    tenant: tnt,
    assigned: Array.isArray(assignedJobIds) ? assignedJobIds.map(String).slice(0, 64) : [],
    policyVersion: config.policyVersion,
  })
    .setProtectedHeader({ alg: "HS256", kid: key.kid, typ: JOB_TOKEN_TYP })
    .setIssuer(JOB_TOKEN_ISSUER)
    .setAudience(aud)
    .setSubject(principal)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + Math.floor(life))
    .setJti(String(jti || randomUUID()))
    .sign(secretKey(key.secret));

  return authOk({ token, expiresAt: nowSec + Math.floor(life) });
}

export async function verifyJobToken(token, {
  config, expectedAudience, expectedJobId, now = () => Date.now(),
} = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  const aud = String(expectedAudience || "");
  if (!aud) return authError("invalid_request", "expected_audience_missing");
  const wantJob = String(expectedJobId || "");
  if (!wantJob) return authError("invalid_request", "expected_job_missing");

  const header = readJwtHeader(token);
  if (!header) return authError("unauthorized", "token_malformed");
  if (String(header.alg || "") !== "HS256") return authError("unauthorized", "token_alg_not_allowed");
  if (String(header.typ || "") !== JOB_TOKEN_TYP) return authError("unauthorized", "token_typ_mismatch");
  const kid = String(header.kid || "");
  const key = pickKey(config.workerKeys, kid);
  if (!key) return authError("unauthorized", "token_unknown_key");
  if (key.status === "revoked") return authError("unauthorized", "token_key_revoked");

  let payload;
  try {
    const verified = await jwtVerify(token, secretKey(key.secret), {
      algorithms: [...JOB_TOKEN_ALGS],
      issuer: JOB_TOKEN_ISSUER,
      audience: aud,
      clockTolerance: 0,
      currentDate: new Date(now()),
      typ: JOB_TOKEN_TYP,
      requiredClaims: ["sub", "iat", "exp", "jti", "job", "role", "tenant", "policyVersion"],
      maxTokenAge: MAX_JOB_TOKEN_LIFETIME_SECONDS,
    });
    payload = verified.payload;
  } catch (err) {
    const reason = joseReason(err, {
      claimReasons: {
        aud: "audience_mismatch",
        iss: "token_issuer_mismatch",
        job: "job_binding_missing",
        role: "role_not_allowed_for_job_token",
        tenant: "token_malformed",
        policyVersion: "policy_version_mismatch",
        iat: "token_iat_invalid",
        exp: "token_expired",
      },
    });
    // Eine falsche audience ist eine Rechtefrage, kein Formfehler.
    if (reason === "audience_mismatch") return authError("forbidden", "audience_mismatch");
    return authError("unauthorized", reason);
  }

  const nowSec = Math.floor(now() / 1000);
  if (!isFiniteSeconds(payload.exp)) return authError("unauthorized", "token_expired");
  if (!isFiniteSeconds(payload.iat) || payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
    return authError("unauthorized", "token_iat_invalid");
  }
  if (payload.exp - payload.iat > MAX_JOB_TOKEN_LIFETIME_SECONDS) return authError("unauthorized", "token_lifetime_too_long");

  const job = String(payload.job || "");
  if (!job) return authError("forbidden", "job_binding_missing");
  if (job !== wantJob) return authError("forbidden", "job_mismatch");
  if (String(payload.policyVersion || "") !== String(config.policyVersion)) {
    return authError("forbidden", "policy_version_mismatch");
  }
  const role = String(payload.role || "");
  if (!JOB_TOKEN_ROLES.includes(role)) return authError("forbidden", "role_not_allowed_for_job_token");
  const tenant = String(payload.tenant || "");
  const principalId = String(payload.sub || "");
  if (!tenant || !principalId) return authError("unauthorized", "token_malformed");

  return authOk({
    principal: Object.freeze({
      kind: ROLE_POLICY[role].kind,
      issuedBy: ISSUERS.jobToken,
      id: principalId,
      role,
      tenant,
      jobId: job,
      assignedJobIds: Array.isArray(payload.assigned) ? Object.freeze(payload.assigned.map(String)) : Object.freeze([]),
      credentialId: null,
      jti: String(payload.jti || ""),
    }),
  });
}

/* ── Anbieterschlüssel gehören nicht in einen Job-Kontext ────────────────
 *
 * Ein Job-Kontext geht an einen Spezialisten. Läge dort ein Anbieter-Schlüssel
 * (Anthropic, Gemini, OpenAI), wäre er genau dort, wo Modelltext entsteht.
 *
 * BEFUND (Review 9ff3423): Die Suche brach bei Erreichen der Tiefengrenze ab
 * und meldete „sauber". Acht Ebenen `{nested:{…}}` um einen Schlüssel herum
 * genügten also, um an ihr vorbeizukommen. Eine Prüfung, die nicht fertig
 * wurde, darf nichts bestätigen: erreicht die Suche eine ihrer Grenzen
 * (Tiefe, Knotenzahl, Zyklus, Getter, Symbolschlüssel), ist das Ergebnis
 * NICHT „sauber", sondern „nicht prüfbar" — und damit eine Absage.
 *
 * Getter werden nicht aufgerufen (ein Getter könnte bei jedem Blick etwas
 * anderes liefern und Nebenwirkungen haben); ein Objekt mit Gettern ist
 * deshalb nicht prüfbar. Zyklen ebenso. Im Fehler steht nur, WORAN es lag —
 * nie der gefundene Wert.
 * ----------------------------------------------------------------------- */
const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwort|private[_-]?key|credential|authorization)/i;
// Die Wortgrenze steht je Alternative — ein PEM-Block beginnt mit „-----",
// davor gibt es keine, und eine gemeinsame Grenze vorn hätte ihn durchgelassen.
const SECRET_VALUE_PATTERN =
  /(\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9]{20,}|\bAIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export const SECRET_SCAN_LIMITS = Object.freeze({ depth: 12, maxNodes: 20_000, maxStringLength: 1_000_000 });

export function assertNoProviderSecrets(value, { depth = SECRET_SCAN_LIMITS.depth, maxNodes = SECRET_SCAN_LIMITS.maxNodes } = {}) {
  const zustand = { nodes: 0, maxNodes, gesehen: new WeakSet() };
  const befund = scanForSecrets(value, depth, zustand);
  if (befund === "clean") return authOk({ scanned: zustand.nodes });
  if (["key", "value"].includes(befund)) return authError("invalid_request", `provider_secret_in_context:${befund}`);
  // Nicht zu Ende geprüft ⇒ nicht bestätigt.
  return authError("invalid_request", `provider_secret_scan_incomplete:${befund}`);
}

/* Rückgabe: "clean" | "key" | "value" | "depth" | "nodes" | "cycle"
 *          | "accessor" | "symbol" | "exotic" | "oversized_string" */
function scanForSecrets(value, depth, zustand) {
  if (++zustand.nodes > zustand.maxNodes) return "nodes";
  if (depth < 0) return "depth";

  if (typeof value === "string") {
    if (value.length > SECRET_SCAN_LIMITS.maxStringLength) return "oversized_string";
    return SECRET_VALUE_PATTERN.test(value) ? "value" : "clean";
  }
  if (value === null || typeof value !== "object") {
    // Zahlen, Boolesche, undefined: nichts zu holen. Funktionen dagegen sind
    // undurchsichtig.
    return typeof value === "function" ? "exotic" : "clean";
  }
  if (zustand.gesehen.has(value)) return "cycle";
  zustand.gesehen.add(value);

  if (Object.getOwnPropertySymbols(value).length) return "symbol";

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const beschreibung = Object.getOwnPropertyDescriptor(value, i);
      if (!beschreibung) continue;                       // Lücke in einem dünnen Array
      if (!("value" in beschreibung)) return "accessor"; // Getter: nicht aufrufen
      const befund = scanForSecrets(beschreibung.value, depth - 1, zustand);
      if (befund !== "clean") return befund;
    }
    return "clean";
  }

  // Map/Set/Date/RegExp & Co. lassen sich nicht über Eigenschaften prüfen.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "exotic";

  for (const key of Object.getOwnPropertyNames(value)) {
    if (SECRET_KEY_PATTERN.test(key)) return "key";
    const beschreibung = Object.getOwnPropertyDescriptor(value, key);
    if (!beschreibung) continue;
    if (!("value" in beschreibung)) return "accessor";
    const befund = scanForSecrets(beschreibung.value, depth - 1, zustand);
    if (befund !== "clean") return befund;
  }
  return "clean";
}

/* ══ 7. Transport — TLS, Herkunft, Grösse, striktes JSON ══════════════════ */

export function enforceTls(req) {
  const proto = String(req?.headers?.get?.("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (proto) return proto === "https" ? authOk() : authError("forbidden", "tls_required");
  let url = null;
  try { url = new URL(String(req?.url || "")); } catch { return authError("forbidden", "tls_required"); }
  return url.protocol === "https:" ? authOk() : authError("forbidden", "tls_required");
}

/*
 * Herkunft. Zwei Welten, sauber getrennt:
 *   BROWSER  — schickt `Origin`; der Wert muss exakt in der Allowlist stehen.
 *              Ein Nutzer-Principal OHNE Origin wird abgelehnt.
 *   DIENST   — Server-zu-Server hat keine Origin. Legitim, wird nicht pauschal
 *              ausgeschlossen. Schickt er doch eine, muss sie passen.
 * Die Absage nennt die Origin nicht und setzt keine CORS-Kopfzeile. Und sie
 * ersetzt keine Authentisierung.
 */
export function evaluateOrigin({ origin, principalKind, config } = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  const value = String(origin || "").trim();
  const allowed = config.allowedOrigins;

  if (!value) {
    if (principalKind === "user") return authError("forbidden", "origin_required");
    if (principalKind === "service" || principalKind === "worker") return authOk({ corsHeaders: null, originless: true });
    return authError("forbidden", "origin_required");
  }
  if (!allowed.includes(value)) return authError("forbidden", "origin_not_allowed");
  return authOk({
    corsHeaders: Object.freeze({
      "Access-Control-Allow-Origin": value,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
      "Cache-Control": "no-store",
    }),
    originless: false,
  });
}

export function enforceJsonCommand({ contentType, rawBody, maxBytes = COMMAND_MAX_BYTES } = {}) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return authError("unsupported_media_type", "content_type_must_be_json");
  const text = typeof rawBody === "string" ? rawBody : "";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) return authError("payload_too_large", "command_too_large");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return authError("invalid_request", "invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return authError("invalid_request", "json_must_be_object");
  if (Object.prototype.hasOwnProperty.call(parsed, "__proto__")) return authError("invalid_request", "prototype_key_forbidden");
  return authOk({ value: parsed, bytes });
}

/* ══ 8. Ratenbegrenzung — der Vertrag, nicht die Illusion ═════════════════ */

export const RATE_LIMIT_CONTRACT = Object.freeze({
  required: Object.freeze([
    "atomic === true: increment und Ablesen sind EIN unteilbarer Schritt",
    "scope === 'shared': derselbe Zähler für alle Instanzen (RTDB-Transaktion, Firestore, Redis)",
    "increment({ key, windowStartMs, windowMs }) → { count } — der Zähler NACH dem Hochzählen",
    "key enthält den Principal (und den Mandanten), nie nur die IP",
  ]),
  windowMs: 60_000,
});

export function requireHandlerRateLimiter(store) {
  if (!store || typeof store.increment !== "function") {
    return authError("rate_limiter_not_configured", "rate_limiter_missing");
  }
  if (store.atomic !== true) return authError("rate_limiter_not_configured", "rate_limiter_not_atomic");
  if (store.scope !== "shared") return authError("rate_limiter_not_configured", "rate_limiter_not_shared");
  return authOk({ store });
}

export function rateLimitKey({ principal, verb } = {}) {
  const id = String(principal?.id || "");
  const tenant = String(principal?.tenant || "");
  const role = String(principal?.role || "");
  if (!id || !tenant || !role) return null;
  return `qv3:${tenant}:${role}:${id}:${String(verb || "*")}`;
}

/* Ausdrücklich NICHT mehrinstanzsicher — und sagt das selbst. */
export function createInMemoryRateLimiter() {
  const counters = new Map();
  return {
    atomic: true,
    scope: "instance",
    multiInstanceSafe: false,
    increment({ key, windowStartMs }) {
      const k = `${key}@${windowStartMs}`;
      const next = (counters.get(k) || 0) + 1;
      counters.set(k, next);
      return { count: next };
    },
  };
}

export default {
  resolveAuthConfig, authorize, rejectIdentityInPayload,
  verifyFirebaseIdToken, createGooglePublicKeySource, createIdentityToolkitUserLookup,
  verifyServiceCredential, mintJobToken, verifyJobToken, assertNoProviderSecrets,
  enforceTls, evaluateOrigin, enforceJsonCommand,
  requireHandlerRateLimiter, rateLimitKey, createInMemoryRateLimiter,
  QUANTUS_V3_TOOLS, ROLE_POLICY, ROLES, JOB_TOKEN_ROLES, SERVICE_CREDENTIAL_ROLES,
  RATE_LIMIT_CONTRACT, VERBS, DATA_CATEGORIES, OBJECT_KIND_CATEGORY,
};
