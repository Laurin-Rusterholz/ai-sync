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
 * Transport. Es enthält KEINE Geschäftslogik, KEINEN Schreibweg und KEINEN
 * Netlify-Handler. Kein einziger Endpunkt wird durch diese Datei erreichbar —
 * das ist Absicht (Paketgrenze C1) und wird in den Tests festgehalten.
 *
 * QUANTUS IST DAMIT NICHT ABGESICHERT. Die bestehenden Endpunkte (blob-put,
 * gcal-*, gmail-api, flowertech-*) bleiben unverändert und hängen weiter am
 * OPTIONALEN `SYNC_AUTH_TOKEN`. Dieser Token ist hier ausdrücklich KEIN
 * Sicherheitsstandard: er ist optional (fehlt er, lässt die alte Fassade
 * durch), er ist für alle Endpunkte derselbe, und er wurde im Browser
 * ausgeliefert. Nichts davon darf in v3 wiederholt werden.
 *
 * DIE VIER TRAGENDEN ENTSCHEIDUNGEN
 * ---------------------------------
 * 1. FAIL CLOSED. Fehlende oder halbe Konfiguration ⇒ 503 auth_not_configured,
 *    bevor irgendetwas gelesen wird. Kein „nicht konfiguriert = offen".
 * 2. IDENTITÄT KOMMT NIE AUS DEM INHALT. Rolle, Mandant und Objektrechte
 *    stammen aus dem geprüften Ausweis (Firebase-ID-Token, Dienst-Zugangsdatum,
 *    Job-Token) — niemals aus dem Request-Body, niemals aus Modelltext.
 *    `rejectIdentityInPayload()` weist einen Body, der so etwas behauptet,
 *    aktiv ab, statt ihn still zu ignorieren.
 * 3. LESEN WIRD WIE SCHREIBEN GEPRÜFT. `authorize()` verlangt für jedes Verb
 *    — auch für `context.read` — Datenkategorie UND Objekt. Ein Spezialist,
 *    der einen fremden Lead liest, ist derselbe Fehler wie einer, der ihn
 *    schreibt.
 * 4. ECHTE SIGNATURPRÜFUNG. Das Firebase-ID-Token wird gegen Googles
 *    öffentliche Schlüssel mit node:crypto (RS256) geprüft — nicht dekodiert.
 *    Job-Token tragen ein HMAC-SHA256 aus node:crypto mit Domänentrennung.
 *    Ein „Dekodieren und glauben" gibt es an keiner Stelle.
 *
 * PRIMÄRQUELLEN (geprüft am 19.09.2026)
 * -------------------------------------
 * • Firebase Auth, „Verify ID tokens using a third-party JWT library":
 *   Header alg = RS256, kid aus dem X.509-Endpunkt; Payload exp in der
 *   Zukunft, iat/auth_time in der Vergangenheit, aud = Projekt-ID,
 *   iss = https://securetoken.google.com/<PROJECT_ID>, sub = uid (nicht leer,
 *   ≤ 128 Zeichen). Schlüssel von
 *   https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *   — Auffrischung nach `max-age` der Cache-Control-Kopfzeile. Der Endpunkt
 *   wurde direkt abgefragt und liefert genau das:
 *   `cache-control: public, max-age=…, must-revalidate`.
 * • Identity Platform, Admin-API `accounts:lookup`: liefert `disabled`,
 *   `validSince`/`tokensValidAfterTime` und `tenantId` — damit werden
 *   gesperrte Nutzer und widerrufene Token erkannt. Das ist der Grund, warum
 *   die Signaturprüfung allein hier NICHT genügt.
 * • Identity Platform Mandanten: ein Token aus einem Mandanten trägt die
 *   Mandanten-Id (`firebase.tenant`, bei Client-SDKs zusätzlich `tenant_id`).
 *   Beide werden gelesen, müssen übereinstimmen und werden gegen die
 *   Serverkonfiguration UND gegen `accounts:lookup` gehalten.
 *
 * WAS HIER BEWUSST FEHLT (und im Command-Handler bewiesen werden muss)
 * -------------------------------------------------------------------
 * • Die serverseitige, atomare Ratenbegrenzung pro Principal. Dieses Modul
 *   definiert nur den VERTRAG (`RATE_LIMIT_CONTRACT`) und weigert sich, einen
 *   In-Memory-Zähler als mehrinstanzsicher durchgehen zu lassen.
 * • Die Anbindung an echte Daten (Firebase-Pfade, Blob-Keys). Cursor und
 *   Objektscope sprechen nur über benannte Abfragen — siehe
 *   quantus-v3-cursor.mjs.
 * ═══════════════════════════════════════════════════════════════════════ */

import {
  createHash, createHmac, timingSafeEqual, createPublicKey,
  X509Certificate, verify as cryptoVerify, randomUUID,
} from "node:crypto";

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
  quantus_context:    Object.freeze({ route: "quantus-context",    verb: "context.read",       enabled: false }),
  quantus_read:       Object.freeze({ route: "quantus-read",       verb: "object.read",        enabled: false }),
  quantus_command:    Object.freeze({ route: "quantus-ingest",     verb: "command.submit",     enabled: false }),
  quantus_run_status: Object.freeze({ route: "quantus-run-status", verb: "run_status.read",    enabled: false }),
});

/* Höchstgrösse eines Kommandos: 64 KiB, gemessen in UTF-8-Bytes. */
export const COMMAND_MAX_BYTES = 64 * 1024;

/* Ein Job-Token ist kurzlebig. 15 Minuten ist die Obergrenze, die beim
   Ausstellen erzwungen wird — nicht nur beim Prüfen. */
export const MAX_JOB_TOKEN_LIFETIME_SECONDS = 15 * 60;

/* Uhrenversatz: beim ABLAUF null (ein abgelaufenes Token ist abgelaufen),
   bei iat/auth_time 60 s, weil fremde Uhren vorgehen dürfen. */
export const CLOCK_SKEW_SECONDS = 60;

/* Ein Dienst-Zugangsdatum unter dieser Länge wird gar nicht erst geprüft —
   ein kurzes „Geheimnis" ist keines. */
export const MIN_SERVICE_SECRET_LENGTH = 32;

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
   Teil eines Tokens, nie ein Schlüsselname mit Inhalt. Damit kann keine
   Absage ein Geheimnis oder einen fremden Datenbestand verraten. */
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

/* ══ 1. Konfiguration — fail closed, ohne je einen Wert zu nennen ═════════
 *
 * Alle geschützten Auth-/Policy-Werte kommen aus GEPRÜFTER Serverkonfiguration.
 * Fehlt eine Variable oder ist sie unlesbar, nennt die Absage NUR den NAMEN
 * der Variable — niemals ihren Inhalt und niemals einen Teil davon.
 * ------------------------------------------------------------------------ */

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

/* Zeitgleicher Vergleich zweier Hex-Digests. Ein Vergleich, der beim ersten
   abweichenden Zeichen abbricht, verrät über die Dauer, wie viel schon stimmte
   (dieselbe Begründung wie in mail-queue-endpunkt.mjs). */
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
    // Kein Wildcard, nie. Auch nicht „https://*.example.com".
    if (entry === "*" || entry.includes("*")) return { wildcard: true };
    let url;
    try { url = new URL(entry); } catch { return { invalid: true }; }
    // Eine Origin-Allowlist ohne TLS wäre ein offenes Fenster neben der Tür.
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
    if (!ROLE_POLICY[role]) return { invalid: "service_credentials_role" };
    // Ein Dienst-Zugangsdatum darf NIE eine Nutzerrolle tragen: Dienste sind
    // keine Menschen, und die Rechte des Menschen hängen an seinem ID-Token.
    if (role === "user") return { invalid: "service_credentials_role" };
    out.push(Object.freeze({
      id, principal, role, tenant, secretSha256, status,
      notAfter: entry.notAfter ? String(entry.notAfter) : null,
    }));
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

/*
 * Ergebnis: { ok: true, config } oder eine fertige 503-Absage mit `missing`
 * (Namen fehlender Variablen) bzw. `reason` (Form-Fehler). Nie ein Wert.
 */
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

  // Mandantenbindung: ist ein Mandant konfiguriert, MUSS jedes Nutzer-Token
  // ihn tragen. Ist keiner konfiguriert, darf auch keiner im Token stehen —
  // sonst wäre ein Token aus einem beliebigen Mandanten des Projekts gültig.
  const tenant = String(read(V.tenant) || "").trim();

  // Standard ist dry_run. Ein Produktivrecht entsteht nur, wenn jemand die
  // Variable BEWUSST auf "enforce" setzt — und auch dann erst, wenn ein
  // Handler existiert, den es in diesem Paket nicht gibt.
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

/* ══ 2. Rollenmodell — was wer darf, und zwar beim Lesen wie beim Schreiben ═
 *
 * Die Matrix ist die einzige Quelle. Unbekannte Rolle, unbekanntes Verb,
 * unbekannte Datenkategorie ⇒ 403. Kein Default-Allow, nirgends.
 * ------------------------------------------------------------------------ */

export const VERBS = Object.freeze([
  "context.read",        // zugewiesenen Kontext lesen
  "object.read",         // ein konkretes Objekt lesen
  "run_status.read",     // Lauf-/Betriebsstatus lesen
  "command.submit",      // Kommando einreichen (Hülle; Inhalt prüft der Handler)
  "job.create",          // neuen Auftrag anlegen
  "job.advance",         // fälligen Auftrag weiterschalten
  "job.result.write",    // Ergebnis AN DEN EIGENEN Auftrag liefern
  "answer.write",        // Nutzerantwort auf eine Rückfrage
  "approval.write",      // Freigabe erteilen
  "task.create",         // Quantus-Aufgabe anlegen
  "mail.send",           // Mail verschicken
  "lead.close",          // Lead schliessen
  "lead.finalize",       // Lead endgültig abschliessen
  "policy.write",        // Policy ändern
  "grant.write",         // Rechte vergeben (Selbstberechtigung)
  "system_status.compute", // Systemstatus/Abschluss berechnen
]);

export const DATA_CATEGORIES = Object.freeze([
  "job", "job_context", "job_result", "lead", "task", "mail",
  "user_answer", "approval", "run_status", "system_status", "policy", "grant",
]);

const VERB_SET = new Set(VERBS);
const CATEGORY_SET = new Set(DATA_CATEGORIES);

/* Objektbindung — wie eng ein Principal an ein Objekt gebunden ist:
 *   "own"    Objekt gehört dem Principal (ownerId)
 *   "job"    Objekt gehört GENAU dem Job, auf den das Token lautet
 *   "assigned" Objekt ist dem Principal zugewiesen
 *   "tenant" Objekt liegt im Mandanten des Principals (schwächste Bindung)
 */
export const ROLE_POLICY = Object.freeze({
  /* Der Mensch. Seine eigenen Aufträge, Antworten, Freigaben, seine Oberfläche. */
  user: Object.freeze({
    kind: "user",
    binding: "own",
    verbs: Object.freeze({
      "context.read":      ["job_context", "lead", "task", "run_status"],
      "object.read":       ["job", "lead", "task", "mail", "user_answer", "approval", "run_status"],
      "run_status.read":   ["run_status"],
      "command.submit":    ["job", "user_answer", "approval"],
      "job.create":        ["job"],
      "answer.write":      ["user_answer"],
      "approval.write":    ["approval"],
      "task.create":       ["task"],
      "mail.send":         ["mail"],
      "lead.close":        ["lead"],
      "lead.finalize":     ["lead"],
    }),
  }),

  /* Leitungsagent (OpenAI Lead API auf Cloud Run): nur ZUGEWIESENER Kontext
     und nur BESTEHENDE, erlaubte Aufträge. Keine Nutzerantworten, keine
     Policy, keine Selbstberechtigung — und ausdrücklich kein job.create. */
  lead_agent: Object.freeze({
    kind: "worker",
    binding: "assigned",
    verbs: Object.freeze({
      "context.read":    ["job_context", "lead"],
      "object.read":     ["job", "lead", "task"],
      "run_status.read": ["run_status"],
      "job.advance":     ["job"],
      "job.result.write": ["job_result"],
      "task.create":     ["task"],
    }),
  }),

  /* Claude-Spezialist: NUR den Kontext SEINES Jobs lesen und ein Ergebnis an
     genau diesen Job liefern. Keine Aufgabe, keine Mail, kein Abschluss. */
  specialist_claude: Object.freeze({
    kind: "worker",
    binding: "job",
    verbs: Object.freeze({
      "context.read":     ["job_context"],
      "job.result.write": ["job_result"],
    }),
  }),

  /* Gemini-Spezialist: identische Grenzen. */
  specialist_gemini: Object.freeze({
    kind: "worker",
    binding: "job",
    verbs: Object.freeze({
      "context.read":     ["job_context"],
      "job.result.write": ["job_result"],
    }),
  }),

  /* Scheduler (Cloud Scheduler/Tasks): fällige Jobs und Betriebsereignisse.
     Keine Inhaltsfreigabe, keine Nutzerantwort, kein Lead-Abschluss. */
  scheduler: Object.freeze({
    kind: "worker",
    binding: "tenant",
    verbs: Object.freeze({
      "job.advance":     ["job"],
      "run_status.read": ["run_status"],
    }),
  }),

  /* Backend-Prüfer: rechnet Systemstatus/Abschluss aus. Liest Status, schreibt
     Status — und sonst nichts nach aussen. */
  backend_checker: Object.freeze({
    kind: "service",
    binding: "tenant",
    verbs: Object.freeze({
      "object.read":           ["job", "run_status"],
      "run_status.read":       ["run_status"],
      "system_status.compute": ["system_status"],
    }),
  }),
});

/* Rollen, die ein Job-Token tragen DARF. Ein Token, das „user" behauptet,
   wird abgewiesen: Nutzerrechte hängen am Firebase-ID-Token, nicht an einem
   Auftragstoken. */
export const WORKER_ROLES = Object.freeze(
  Object.keys(ROLE_POLICY).filter((r) => ROLE_POLICY[r].kind !== "user")
);

/*
 * Die zentrale Rechteprüfung.
 *
 *   principal { kind, id, role, tenant, jobId?, assignedJobIds? }
 *   verb, dataCategory
 *   object { kind, id, tenant, ownerId?, jobId?, assignedTo? }
 *
 * Rückgabe: { ok: true } oder eine 403-Absage mit festem Grund.
 */
export function authorize({ principal, verb, dataCategory, object, policyVersion, config } = {}) {
  if (!principal || typeof principal !== "object") return authError("forbidden", "principal_missing");
  const role = String(principal.role || "");
  const policy = Object.prototype.hasOwnProperty.call(ROLE_POLICY, role) ? ROLE_POLICY[role] : null;
  if (!policy) return authError("forbidden", "unknown_role");

  if (!VERB_SET.has(verb)) return authError("forbidden", "unknown_verb");
  if (!CATEGORY_SET.has(dataCategory)) return authError("forbidden", "unknown_data_category");

  const allowedCategories = Object.prototype.hasOwnProperty.call(policy.verbs, verb) ? policy.verbs[verb] : null;
  if (!allowedCategories) return authError("forbidden", "verb_not_allowed_for_role");
  if (!allowedCategories.includes(dataCategory)) return authError("forbidden", "data_category_not_allowed_for_role");

  // Die Policy-Version ist Teil der Entscheidung: läuft der Aufrufer auf einer
  // anderen Fassung, ist seine Annahme über seine Rechte veraltet.
  if (config && policyVersion && String(policyVersion) !== String(config.policyVersion)) {
    return authError("forbidden", "policy_version_mismatch");
  }

  if (!object || typeof object !== "object") return authError("forbidden", "object_missing");
  const objectId = String(object.id || "");
  if (!objectId) return authError("forbidden", "object_id_missing");

  // Mandant: immer, für jede Rolle, beim Lesen wie beim Schreiben.
  const principalTenant = String(principal.tenant || "");
  const objectTenant = String(object.tenant || "");
  if (!principalTenant || !objectTenant) return authError("forbidden", "tenant_missing");
  if (principalTenant !== objectTenant) return authError("forbidden", "tenant_mismatch");

  switch (policy.binding) {
    case "own": {
      const owner = String(object.ownerId || "");
      if (!owner) return authError("forbidden", "object_owner_missing");
      if (owner !== String(principal.id)) return authError("forbidden", "object_not_owned");
      break;
    }
    case "job": {
      // Der Spezialist ist an GENAU EINEN Job gebunden — aus dem Token, nicht
      // aus dem Body. Ein Objekt ohne Jobbindung ist für ihn unerreichbar.
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
      const okByAssignment = assignedTo && assignedTo === String(principal.id);
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

/* ── Identität darf nie aus dem Inhalt kommen ────────────────────────────
 * Ein Body, der Rolle, Principal, Mandant, Scopes oder Rechte BEHAUPTET, wird
 * abgewiesen — nicht still ignoriert. Still ignorieren hiesse: ein Aufrufer
 * probiert es, bekommt 200 und glaubt, es habe gewirkt; und der nächste
 * Umbau übernimmt das Feld dann vielleicht doch.
 * Geprüft wird auch EINE Ebene tiefer, weil Auftragstexte gern verschachtelt
 * sind ({ auftrag: { role: "user" } }). */
export const IDENTITY_FIELDS = Object.freeze([
  "role", "roles", "principal", "principalId", "tenant", "tenantId",
  "scope", "scopes", "grants", "permissions", "capabilities", "uid",
  "impersonate", "act_as", "actAs",
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

/* ══ 3. Firebase-ID-Token — echte Prüfung, keine Dekodierung ══════════════ */

function b64urlToBuffer(segment) {
  const s = String(segment || "");
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/* Struktur-Zerlegung. ACHTUNG: Das Ergebnis ist KEINE Identität. Es wird
   ausschliesslich benutzt, um kid/alg zu finden und die Signatur zu prüfen.
   Wer diese Funktion für eine Entscheidung benutzt, hat den Fehler gemacht,
   den dieses Paket verhindern soll. */
export function decodeJwtStructure(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const headerBuf = b64urlToBuffer(parts[0]);
  const payloadBuf = b64urlToBuffer(parts[1]);
  const signature = b64urlToBuffer(parts[2]);
  if (!headerBuf || !payloadBuf || !signature || !signature.length) return null;
  let header, payload;
  try {
    header = JSON.parse(headerBuf.toString("utf8"));
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch { return null; }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
  return { header, payload, signature, signingInput: `${parts[0]}.${parts[1]}` };
}

/* Aus dem X.509-Zertifikat (so liefert Google die Schlüssel) wird der
   öffentliche Schlüssel — mit node:crypto, nicht von Hand. Ein reiner
   Public-Key im PEM wird ebenfalls akzeptiert, damit Tests mit frisch
   erzeugten, flüchtigen Schlüsseln gegen DIESELBE Prüfstrecke laufen. */
export function publicKeyFromPem(pem) {
  const text = String(pem || "");
  if (text.includes("BEGIN CERTIFICATE")) return new X509Certificate(text).publicKey;
  return createPublicKey(text);
}

/*
 * Der Schlüsselbezug von Google — mit Cache nach `max-age`, wie die
 * Primärdoku es verlangt. Die URL ist fest; ein Aufrufer kann sie nicht
 * umbiegen (sonst wäre der Vertrauensanker austauschbar).
 */
export function createGooglePublicKeySource({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cache = null;          // { keys: Map<kid, pem>, expiresAt }
  async function refresh() {
    if (typeof fetchImpl !== "function") throw new Error("public_key_source_unavailable");
    const res = await fetchImpl(GOOGLE_SECURETOKEN_X509_URL, { headers: { Accept: "application/json" } });
    if (!res || !res.ok) throw new Error("public_key_fetch_failed");
    const body = await res.json();
    if (!body || typeof body !== "object") throw new Error("public_key_fetch_failed");
    const cc = String(res.headers?.get?.("cache-control") || "");
    const m = /max-age\s*=\s*(\d+)/i.exec(cc);
    // Ohne max-age: kurz halten statt lange raten.
    const ttlMs = (m ? Number(m[1]) : 300) * 1000;
    cache = { keys: new Map(Object.entries(body)), expiresAt: now() + ttlMs };
    return cache;
  }
  return {
    async get(kid) {
      if (!cache || cache.expiresAt <= now()) await refresh();
      if (!cache.keys.has(kid)) {
        // Unbekannte kid kann ein Schlüsselwechsel sein — EINMAL auffrischen.
        await refresh();
      }
      const pem = cache.keys.get(kid);
      return pem ? publicKeyFromPem(pem) : null;
    },
  };
}

/*
 * Widerruf und Sperre: ohne diesen Schritt ist ein gestohlenes, noch nicht
 * abgelaufenes Token eine Stunde lang gültig, auch wenn der Nutzer gesperrt
 * wurde. Offizieller Weg: Identity Toolkit `accounts:lookup`.
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
    return {
      disabled: user.disabled === true,
      validSince: user.validSince != null ? Number(user.validSince) : 0,
      tenantId: user.tenantId ? String(user.tenantId) : null,
    };
  };
}

/* Die Mandanten-Id eines Tokens: Identity Platform legt sie unter
   `firebase.tenant` ab, Client-SDKs setzen zusätzlich `tenant_id`. Stehen
   beide da und widersprechen sich, ist das Token nicht auswertbar. */
export function tenantFromClaims(payload) {
  const nested = payload?.firebase && typeof payload.firebase === "object" ? payload.firebase.tenant : undefined;
  const top = payload?.tenant_id;
  const a = nested == null ? null : String(nested);
  const b = top == null ? null : String(top);
  if (a && b && a !== b) return { conflict: true };
  return { tenant: a || b || null };
}

/*
 * Die echte Prüfung eines Firebase-ID-Tokens.
 *
 * Reihenfolge ist Absicht: erst Form, dann Signatur, dann Ansprüche, dann
 * Mandant, zuletzt Widerruf/Sperre (der einzige Schritt, der das Netz braucht).
 * So kostet ein gefälschtes Token keinen Netzaufruf.
 */
export async function verifyFirebaseIdToken(idToken, {
  config, keySource, userLookup, now = () => Date.now(),
} = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  if (!keySource || typeof keySource.get !== "function") return authError("auth_not_configured", "public_key_source_missing");
  // Ohne Widerrufsprüfung wird NICHT durchgelassen. Ein „geht halt gerade
  // nicht" wäre genau der stille Öffner, den dieses Paket ausschliesst.
  if (typeof userLookup !== "function") return authError("auth_not_configured", "user_lookup_missing");

  const parsed = decodeJwtStructure(idToken);
  if (!parsed) return authError("unauthorized", "token_malformed");

  const alg = String(parsed.header.alg || "");
  // RS256 und nichts anderes: „none" und HS256 sind die beiden klassischen
  // Verwechslungsangriffe (HS256 würde den öffentlichen Schlüssel zum
  // Geheimnis machen).
  if (alg !== "RS256") return authError("unauthorized", "token_alg_not_rs256");
  const kid = String(parsed.header.kid || "");
  if (!kid) return authError("unauthorized", "token_kid_missing");

  let publicKey = null;
  try {
    publicKey = await keySource.get(kid);
  } catch {
    return authError("unauthorized", "token_key_unavailable");
  }
  if (!publicKey) return authError("unauthorized", "token_kid_unknown");

  let signatureOk = false;
  try {
    signatureOk = cryptoVerify("RSA-SHA256", Buffer.from(parsed.signingInput, "utf8"), publicKey, parsed.signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return authError("unauthorized", "token_signature_invalid");

  const p = parsed.payload;
  const nowSec = Math.floor(now() / 1000);

  if (typeof p.exp !== "number" || !(p.exp > nowSec)) return authError("unauthorized", "token_expired");
  if (typeof p.iat !== "number" || p.iat > nowSec + CLOCK_SKEW_SECONDS) return authError("unauthorized", "token_iat_invalid");
  if (p.auth_time != null && (typeof p.auth_time !== "number" || p.auth_time > nowSec + CLOCK_SKEW_SECONDS)) {
    return authError("unauthorized", "token_auth_time_invalid");
  }
  if (String(p.aud || "") !== config.projectId) return authError("unauthorized", "token_audience_mismatch");
  if (String(p.iss || "") !== config.issuer) return authError("unauthorized", "token_issuer_mismatch");
  const sub = typeof p.sub === "string" ? p.sub : "";
  if (!sub || sub.length > 128) return authError("unauthorized", "token_subject_invalid");

  const tenantClaim = tenantFromClaims(p);
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
  if (!record) return authError("unauthorized", "user_unknown");
  if (record.disabled) return authError("forbidden", "user_disabled");
  if (Number(record.validSince || 0) > Number(p.iat)) return authError("unauthorized", "token_revoked");
  // Auch der Datensatz muss zum Mandanten passen — ein Token kann aus einem
  // Mandanten stammen, dessen Nutzer inzwischen woanders liegt.
  const recordTenant = record.tenantId || null;
  if ((expectedTenant || null) !== (recordTenant || null)) return authError("forbidden", "tenant_mismatch");

  return authOk({
    principal: Object.freeze({
      kind: "user",
      id: sub,
      role: "user",
      tenant: expectedTenant || config.projectId,
      credentialId: null,
      jobId: null,
    }),
  });
}

/* ══ 4. Dienstaufrufe — eigene, rotierbare Pflicht-Zugangsdaten ═══════════
 *
 * Getrennt vom Nutzerweg und getrennt von SYNC_AUTH_TOKEN. Der Server hält
 * nur den SHA-256-Abdruck; der Wert selbst steht in der Serverkonfiguration
 * des Aufrufers und nie im Browser, nie im Repo, nie in einem Test.
 * Rotation: mehrere Einträge gleichzeitig; `retiring` gilt noch bis `notAfter`,
 * `revoked` nie.
 * ------------------------------------------------------------------------ */

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
  // Zu kurz ⇒ dieselbe Absage wie „falsch". Die Länge eines gültigen
  // Zugangsdatums wird dadurch nicht ausgeplaudert.
  if (secret.length < MIN_SERVICE_SECRET_LENGTH) return authError("unauthorized", "credential_invalid");

  const digest = sha256Hex(secret);
  const nowMs = now();
  let matched = null;
  // Kein frühes Verlassen der Schleife: alle Einträge werden gleich behandelt.
  for (const cred of config.serviceCredentials) {
    if (equalHex(digest, cred.secretSha256)) matched = matched || cred;
  }
  if (!matched) return authError("unauthorized", "credential_invalid");
  if (matched.status === "revoked") return authError("unauthorized", "credential_revoked");
  if (matched.status === "retiring") {
    const until = matched.notAfter ? Date.parse(matched.notAfter) : NaN;
    if (!Number.isFinite(until) || until <= nowMs) return authError("unauthorized", "credential_retired");
  }
  const policy = ROLE_POLICY[matched.role];
  if (!policy) return authError("forbidden", "unknown_role");

  return authOk({
    principal: Object.freeze({
      kind: policy.kind === "worker" ? "worker" : "service",
      id: matched.principal,
      role: matched.role,
      tenant: matched.tenant,
      credentialId: matched.id,
      jobId: null,
    }),
  });
}

/* ══ 5. Job-Token für Worker — kurzlebig, audience- und jobgebunden ═══════
 *
 * Bewusst KEIN JWT: ein eigenes, minimales Format ohne `alg`-Feld kann keine
 * Algorithmus-Verwechslung erleiden. Signiert wird mit HMAC-SHA256 aus
 * node:crypto über eine Zeichenkette MIT Domänentrennung
 * (`qv3-job-token.v1|<kid>|<payload>`): derselbe Schlüssel könnte damit keinen
 * Cursor und kein anderes Token signieren.
 * ------------------------------------------------------------------------ */

const JOB_TOKEN_PREFIX = "qv3j1";
const JOB_TOKEN_DOMAIN = "qv3-job-token.v1";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signDomain(secret, domain, kid, payloadB64) {
  return b64url(createHmac("sha256", secret).update(`${domain}|${kid}|${payloadB64}`, "utf8").digest());
}

function pickKey(keys, kid) {
  return keys.find((k) => k.kid === kid) || null;
}

function activeKey(keys) {
  return keys.find((k) => k.status === "active") || null;
}

/*
 * Ausstellen. Die Lebensdauer wird HIER begrenzt, nicht erst beim Prüfen —
 * ein Token mit acht Stunden Laufzeit darf gar nicht erst entstehen.
 * `role` muss eine Worker-Rolle sein und kommt vom Aussteller, niemals aus
 * einem Auftragstext.
 */
export function mintJobToken({
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
  if (!WORKER_ROLES.includes(r)) return authError("forbidden", "role_not_allowed_for_job_token");
  if (!principal || !tnt) return authError("invalid_request", "principal_or_tenant_missing");
  const life = Number(lifetimeSeconds);
  if (!Number.isFinite(life) || life <= 0) return authError("invalid_request", "lifetime_invalid");
  if (life > MAX_JOB_TOKEN_LIFETIME_SECONDS) return authError("invalid_request", "lifetime_too_long");

  const nowSec = Math.floor(now() / 1000);
  const payload = {
    v: 1, aud, job, role: r, principal, tenant: tnt,
    assigned: Array.isArray(assignedJobIds) ? assignedJobIds.map(String).slice(0, 64) : null,
    policyVersion: config.policyVersion,
    iat: nowSec, exp: nowSec + Math.floor(life),
    jti: String(jti || randomUUID()),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = signDomain(key.secret, JOB_TOKEN_DOMAIN, key.kid, payloadB64);
  return authOk({ token: `${JOB_TOKEN_PREFIX}.${key.kid}.${payloadB64}.${sig}`, expiresAt: payload.exp, jti: payload.jti });
}

/*
 * Prüfen. `expectedAudience` und `expectedJobId` sind PFLICHT: ein Aufrufer,
 * der nicht sagt, wofür das Token gelten soll, bekommt kein Ja.
 */
export function verifyJobToken(token, {
  config, expectedAudience, expectedJobId, now = () => Date.now(),
} = {}) {
  if (!config) return authError("auth_not_configured", "config_missing");
  const aud = String(expectedAudience || "");
  if (!aud) return authError("invalid_request", "expected_audience_missing");
  const wantJob = String(expectedJobId || "");
  if (!wantJob) return authError("invalid_request", "expected_job_missing");

  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== JOB_TOKEN_PREFIX) return authError("unauthorized", "token_malformed");
  const [, kid, payloadB64, sig] = parts;
  const key = pickKey(config.workerKeys, kid);
  if (!key) return authError("unauthorized", "token_unknown_key");
  if (key.status === "revoked") return authError("unauthorized", "token_key_revoked");

  const expected = signDomain(key.secret, JOB_TOKEN_DOMAIN, kid, payloadB64);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(sig || ""), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return authError("unauthorized", "token_signature_invalid");

  const buf = b64urlToBuffer(payloadB64);
  if (!buf) return authError("unauthorized", "token_malformed");
  let payload;
  try { payload = JSON.parse(buf.toString("utf8")); } catch { return authError("unauthorized", "token_malformed"); }
  if (!payload || typeof payload !== "object" || payload.v !== 1) return authError("unauthorized", "token_malformed");

  const nowSec = Math.floor(now() / 1000);
  if (typeof payload.exp !== "number" || !(payload.exp > nowSec)) return authError("unauthorized", "token_expired");
  if (typeof payload.iat !== "number" || payload.iat > nowSec + CLOCK_SKEW_SECONDS) return authError("unauthorized", "token_iat_invalid");
  if (payload.exp - payload.iat > MAX_JOB_TOKEN_LIFETIME_SECONDS) return authError("unauthorized", "token_lifetime_too_long");
  if (String(payload.aud || "") !== aud) return authError("forbidden", "audience_mismatch");
  if (!payload.job) return authError("forbidden", "job_binding_missing");
  if (String(payload.job) !== wantJob) return authError("forbidden", "job_mismatch");
  if (String(payload.policyVersion || "") !== String(config.policyVersion)) return authError("forbidden", "policy_version_mismatch");
  const role = String(payload.role || "");
  if (!WORKER_ROLES.includes(role)) return authError("forbidden", "role_not_allowed_for_job_token");
  const tenant = String(payload.tenant || "");
  const principalId = String(payload.principal || "");
  if (!tenant || !principalId) return authError("unauthorized", "token_malformed");

  return authOk({
    principal: Object.freeze({
      kind: "worker",
      id: principalId,
      role,
      tenant,
      jobId: String(payload.job),
      assignedJobIds: Array.isArray(payload.assigned) ? Object.freeze(payload.assigned.map(String)) : Object.freeze([]),
      credentialId: null,
      jti: String(payload.jti || ""),
    }),
  });
}

/* ── Anbieterschlüssel gehören nicht in einen Job-Kontext ────────────────
 * Ein Job-Kontext geht an einen Spezialisten. Läge dort ein Anbieter-Schlüssel
 * (Anthropic, Gemini, OpenAI), wäre er genau dort, wo Modelltext entsteht.
 * Deshalb: aktiv suchen und ablehnen, statt sich darauf zu verlassen, dass
 * niemand ihn hineinschreibt. */
const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwort|private[_-]?key|credential|authorization)/i;
// Die Wortgrenze steht je Alternative — ein PEM-Block beginnt mit „-----",
// davor gibt es keine, und eine gemeinsame Grenze vorn hätte ihn durchgelassen.
const SECRET_VALUE_PATTERN =
  /(\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9]{20,}|\bAIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function assertNoProviderSecrets(value, { depth = 6 } = {}) {
  const hit = scanForSecrets(value, depth);
  if (hit) return authError("invalid_request", `provider_secret_in_context:${hit}`);
  return authOk();
}

function scanForSecrets(value, depth) {
  if (depth < 0) return null;
  if (typeof value === "string") return SECRET_VALUE_PATTERN.test(value) ? "value" : null;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) { const hit = scanForSecrets(entry, depth - 1); if (hit) return hit; }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_PATTERN.test(key)) return "key";
    const hit = scanForSecrets(value[key], depth - 1);
    if (hit) return hit;
  }
  return null;
}

/* ══ 6. Transport — TLS, Herkunft, Grösse, striktes JSON ══════════════════ */

/*
 * TLS. Hinter Netlify/Cloud Run steht der Beweis in `x-forwarded-proto`;
 * ohne Angabe wird die URL herangezogen. Kein „localhost ist auch okay":
 * dieses Paket schaltet nichts frei, ein Entwicklungsloch wäre reine Schuld
 * auf Vorrat.
 */
export function enforceTls(req) {
  const proto = String(req?.headers?.get?.("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (proto) return proto === "https" ? authOk() : authError("forbidden", "tls_required");
  let url = null;
  try { url = new URL(String(req?.url || "")); } catch { return authError("forbidden", "tls_required"); }
  return url.protocol === "https:" ? authOk() : authError("forbidden", "tls_required");
}

/*
 * Herkunft. Zwei Welten, sauber getrennt:
 *
 *   BROWSER  — schickt `Origin`. Der Wert muss exakt in der Allowlist stehen.
 *              Ein Nutzer-Principal (Firebase-ID-Token) OHNE Origin wird
 *              abgelehnt: Browser schicken bei fremd-originierten Anfragen
 *              immer eine Origin; ihr Fehlen ist bei einem Nutzer-Token ein
 *              Hinweis auf etwas anderes als die App.
 *   DIENST   — Server-zu-Server (Cloud Run, Scheduler, Worker) hat keine
 *              Origin. Das ist legitim und wird NICHT pauschal ausgeschlossen.
 *              Schickt ein Dienst dennoch eine Origin, muss auch sie passen.
 *
 * Die Absage nennt die abgelehnte Origin NICHT und setzt keine
 * CORS-Kopfzeile — sie verrät damit auch nicht, welche Origins es gäbe.
 * Und: das hier ersetzt keine Authentisierung. CORS ist eine Browser-Regel;
 * die Tür ist der Ausweis.
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

/*
 * Der Körper: strikt JSON, höchstens 64 KiB (in UTF-8-Bytes, nicht in
 * JS-Zeichen), und ein Objekt — kein Array, keine nackte Zahl. `__proto__`
 * wird abgewiesen, statt still verschluckt zu werden.
 */
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

/* ══ 7. Ratenbegrenzung — der Vertrag, nicht die Illusion ═════════════════
 *
 * Netlify-Funktionen und Cloud Run laufen in MEHREREN Instanzen. Ein Zähler
 * im Arbeitsspeicher zählt deshalb pro Instanz — wer 10 Anfragen pro Minute
 * erlauben will, erlaubt bei 5 Instanzen 50. Das ist kein Schutz, und es als
 * Schutz auszugeben wäre schlimmer als keiner.
 *
 * Darum: Der Handler VERLANGT einen Speicher, der atomar hoch- und zurückzählt
 * und sich als instanzübergreifend ausweist. Fehlt er, gibt es 503 —
 * keinen stillen Erfolgspfad.
 * ------------------------------------------------------------------------ */

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

/* Der Schlüssel eines Zählers: Principal + Mandant + Verb. Nie die blosse IP —
   ein Principal darf sich nicht hinter wechselnden Adressen verstecken. */
export function rateLimitKey({ principal, verb } = {}) {
  const id = String(principal?.id || "");
  const tenant = String(principal?.tenant || "");
  const role = String(principal?.role || "");
  if (!id || !tenant || !role) return null;
  return `qv3:${tenant}:${role}:${id}:${String(verb || "*")}`;
}

/* Ausdrücklich NICHT mehrinstanzsicher — und sagt das selbst. `requireHandlerRateLimiter`
   weist ihn ab; er existiert für lokale Versuche und für den Test, der beweist,
   dass er abgewiesen wird. */
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
  QUANTUS_V3_TOOLS, ROLE_POLICY, WORKER_ROLES, RATE_LIMIT_CONTRACT,
};
