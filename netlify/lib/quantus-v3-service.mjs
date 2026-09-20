/* ══ Quantus v3 — C2: der Dienst hinter den vier dünnen Routen ════════════
 *
 * Diese Datei ist die KETTE. Die vier Netlify-Funktionen
 * (quantus-ingest/context/read/run-status) sind nur Hüllen: sie bauen die
 * Abhängigkeiten zusammen und rufen hier hinein. Alles, was entscheidet,
 * steht hier — und ist damit ohne HTTP, ohne Firebase und ohne Anbieter
 * prüfbar.
 *
 * DIE REIHENFOLGE (und warum sie so ist)
 * --------------------------------------
 *   1. Konfiguration   fehlt sie ⇒ 503, bevor irgendetwas gelesen wird
 *   2. TLS             ohne https gar nichts
 *   3. Ausweis         Firebase-ID-Token, Dienst-Zugangsdatum oder Job-Token
 *   4. Herkunft        Origin-Allowlist; Browser originlos ⇒ Absage
 *   5. Körper          Content-Type, 64 KiB, striktes JSON, geschlossener
 *                      Umschlag, Idempotency-Key aus der KOPFZEILE
 *   6. Ratenbegrenzung atomar, instanzübergreifend, pro geprüftem Principal
 *   7. Adapter         fehlender Domänen-/Idempotenz-/Speicheradapter ⇒ 503.
 *                      Kein Ersatzpfad, kein Schein-Erfolg.
 *   8. Daten           erst JETZT wird der Kern gelesen. Ein ungeprüftes
 *                      Token sieht ihn nie.
 *
 * WAS BEIM SCHREIBEN GILT
 * -----------------------
 * `prepareIdempotentCommand` läuft EINMAL, ausserhalb der CAS-Schleife, nach
 * geprüfter Authentisierung. `applyIdempotentCommand` läuft INNERHALB von
 * `mutateAppData` — und davor, in JEDEM Versuch und auch bei einer
 * Wiederholung, die vollständige Autorisierung gegen den GERADE GELESENEN
 * Schnappschuss: Rolle, Mandant, Eigentum, Auftragsbindung, Lease und
 * `expectedEntityVersion`. Ein Beleg im Ledger ersetzt keine Rechteprüfung —
 * sonst könnte ein zurückgezogener Principal seine alte Quittung abholen.
 * Rechte werden nie aus einem vorher gelesenen Stand entschieden.
 *
 * WAS ES HIER NICHT GIBT
 * ----------------------
 * Keine Fachlogik (die kommt aus dem Domänen-Adapter), keine zweite
 * Idempotenz-Ledgerlogik (die kommt aus quantus-v3-idempotency.mjs des
 * Integrationsstandes), kein eigener Datenbestand, kein Provideraufruf.
 * Schreiben ist standardmässig AUS: ohne ausdrückliche Freigabe läuft jeder
 * Befehl vollständig durch alle Prüfungen und antwortet `applied: false`.
 * ═══════════════════════════════════════════════════════════════════════ */

import {
  resolveAuthConfig as defaultResolveAuthConfig, envRead,
  enforceTls, evaluateOrigin, enforceJsonCommand, rejectIdentityInPayload,
  verifyFirebaseIdToken, verifyServiceCredential, verifyJobToken,
  authorize, authError, authOk, parseAuthorizationHeader, readJwtHeader,
  requireHandlerRateLimiter, rateLimitKey, dataCategoryForObjectKind,
  ISSUERS, JOB_TOKEN_TYP, COMMAND_MAX_BYTES,
} from "./quantus-v3-auth.mjs";
import { parseCommandEnvelope, parseIdempotencyKey } from "./quantus-v3-command-envelope.mjs";
import { resolveCursorConfig, signCursor, verifyCursor, describePage, isDataRevision, NAMED_QUERIES, SCOPE_OBJECT_KINDS } from "./quantus-v3-cursor.mjs";
import { projectPage, pageSizeFor, entityVersionsOf, belongsToScope } from "./quantus-v3-read-helpers.mjs";

export const CORE_KEY = "app-data.json";

/* Welche benannte Abfrage an welcher Route bedient wird. Eine Route ist kein
   Selbstbedienungsladen: was hier nicht steht, gibt es dort nicht. */
export const ROUTE_QUERIES = Object.freeze({
  "quantus-context": Object.freeze(["run.context", "lead.context", "notes.recent", "policy.current"]),
  "quantus-read": Object.freeze(["lead.context", "notes.recent", "policy.current", "run.queue"]),
  "quantus-run-status": Object.freeze(["run.status", "run.queue", "run.sourceChecks"]),
});

/* Ratenbegrenzung je Rolle (Anfragen pro Minute). Der Zähler selbst muss
   atomar und instanzübergreifend sein — das prüft `requireHandlerRateLimiter`. */
export const RATE_LIMITS_PER_MINUTE = Object.freeze({
  user: 60,
  lead_agent: 120,
  specialist_claude: 60,
  specialist_gemini: 60,
  scheduler: 120,
  backend_checker: 120,
});
export const RATE_WINDOW_MS = 60_000;

/* Interne Fehlercodes → HTTP. Alles, was hier nicht steht, ist ein Fehler
   dieses Servers und wird zu 500 mit nichtssagendem Körper. */
const STATUS_BY_CODE = Object.freeze({
  auth_not_configured: 503,
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  rate_limited: 429,
  rate_limiter_not_configured: 503,
  api_writes_disabled: 503,
  stale_entity_version: 409,
  idempotency_conflict: 409,
  replay_too_old: 409,
  domain_conflict: 409,        // fachlicher Konflikt des Kerns (Zustand, Uebergang, Beleg); der Kern-Code steht in reason
  // aus mutateAppData / firebase-admin
  cas_exhausted: 503,
  cas_outcome_unknown: 503,
  cas_etag_missing: 503,
  core_unavailable: 503,
  core_invalid: 503,
  key_denied: 403,
  // aus quantus-v3-idempotency
  automation_not_ready: 503,
  revision_exhausted: 503,
  idempotency_ledger_invalid: 503,
  command_too_complex: 400,
  invalid_json_value: 400,
  invalid_json_key: 400,
});

export function statusForCode(code) {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : 500;
}

/* Eine Absage mit einem Code, den C1 nicht kennt (429 etwa gibt es dort
   nicht). Dieselbe Form wie authError — damit die Kette nur eine Form kennt. */
export function serviceDenial(code, reason, extra = {}) {
  const status = statusForCode(code);
  return { ok: false, status, error: code, reason: String(reason || code), ...extra,
    body: Object.freeze({ error: code, reason: String(reason || code) }) };
}

function fail(code, reason, extra = {}) {
  const err = new Error(reason || code);
  err.code = code;
  err.reason = reason || code;
  err.status = statusForCode(code);
  Object.assign(err, extra);
  return err;
}

/* Eine Antwort. Der Körper trägt nie einen Wert aus der Anfrage und nie einen
   Fehlertext einer Bibliothek — nur feste Bezeichner und die eigene
   Anfragekennung. */
export function jsonResponse(body, { status = 200, corsHeaders = null, extraHeaders = null } = {}) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", ...(corsHeaders || {}), ...(extraHeaders || {}) };
  return { status, headers, body };
}

function denial(res, { requestId, corsHeaders = null, extraHeaders = null } = {}) {
  return jsonResponse({ ok: false, error: res.error, reason: res.reason, requestId }, {
    status: res.status, corsHeaders, extraHeaders,
  });
}

/* ── Welchen Ausweis hält der Aufrufer in der Hand? ──────────────────────
 * Deterministisch an der Form, ohne Durchprobieren: ein JWT mit unserem
 * eigenen `typ` ist ein Job-Token, ein RS256-JWT ein Firebase-ID-Token, alles
 * andere ein Dienst-Zugangsdatum. Ein Durchprobieren würde jeden falschen
 * Ausweis gegen alle Prüfstrecken laufen lassen — und dabei verraten, welche
 * davon wie lange braucht. */
export function identifyCredential(raw) {
  const wert = String(raw || "");
  if (!wert) return "none";
  const header = readJwtHeader(wert);
  if (!header) return "service_credential";
  if (String(header.typ || "") === JOB_TOKEN_TYP) return "job_token";
  if (String(header.alg || "") === "RS256") return "firebase_id_token";
  return "unknown";
}

/*
 * Ausweis prüfen. `expectedAudience` ist die Route — ein Job-Token für
 * `quantus-ingest` gilt nicht an `quantus-context`.
 */
export async function authenticate({ rawCredential, config, route, jobId = null, deps }) {
  const art = identifyCredential(rawCredential);
  if (art === "none") return authError("unauthorized", "credential_missing");
  if (art === "unknown") return authError("unauthorized", "credential_unsupported");

  if (art === "firebase_id_token") {
    return verifyFirebaseIdToken(rawCredential, {
      config, keySource: deps.keySource, userLookup: deps.userLookup, now: deps.now,
    });
  }
  if (art === "job_token") {
    if (!jobId) return authError("forbidden", "job_binding_missing");
    return verifyJobToken(rawCredential, {
      config, expectedAudience: route, expectedJobId: jobId, now: deps.now,
    });
  }
  return verifyServiceCredential(rawCredential, { config, now: deps.now });
}

/* ── Ratenbegrenzung: atomar, geteilt, pro Principal ─────────────────────
 *
 * BEFUND (Review 33a4b3d): Gezählt wurde nur je VERB. Wer zwanzig Verben
 * benutzt, hatte zwanzig Budgets. Jetzt gibt es zwei Zähler: das Gesamtbudget
 * des Principals und zusätzlich eines je Verb — beide müssen halten.
 * ----------------------------------------------------------------------- */
async function enforceRateLimit({ principal, verb, deps }) {
  const geprueft = requireHandlerRateLimiter(deps.rateLimiter);
  if (!geprueft.ok) return geprueft;
  const gesamtKey = rateLimitKey({ principal, verb: "*" });
  const verbKey = rateLimitKey({ principal, verb });
  if (!gesamtKey || !verbKey) return authError("forbidden", "principal_incomplete");
  const limit = RATE_LIMITS_PER_MINUTE[principal.role];
  if (!limit) return authError("forbidden", "unknown_role");

  const nowMs = deps.now();
  const windowStartMs = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const zaehle = async (key) => {
    const ergebnis = await geprueft.store.increment({ key, windowStartMs, windowMs: RATE_WINDOW_MS });
    const count = Number(ergebnis?.count);
    if (!Number.isFinite(count) || !Number.isSafeInteger(count) || count < 1) throw new Error("rate_limiter_unavailable");
    return count;
  };

  let gesamt;
  let proVerb;
  try {
    gesamt = await zaehle(gesamtKey);
    proVerb = await zaehle(verbKey);
  } catch {
    // Ein ausgefallener oder unbrauchbarer Zähler ist kein Freibrief.
    return serviceDenial("rate_limiter_not_configured", "rate_limiter_unavailable");
  }
  if (gesamt > limit || proVerb > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStartMs + RATE_WINDOW_MS - nowMs) / 1000));
    return { ...serviceDenial("rate_limited", "rate_limit_exceeded"), retryAfter };
  }
  return authOk({ count: proVerb, total: gesamt, limit });
}

/* ── Adapter: vorhanden oder 503. Kein halber Betrieb. ───────────────────
 *
 * Der Fachadapter bringt drei Dinge mit, die C2 NICHT selbst erfindet:
 *   resolveTarget       welches Objekt ein Verb betrifft (Ressource) und
 *                       woran seine Bindung hängt (Anker) — aus dem
 *                       autoritativen Bestand, nie aus dem Request.
 *   assertActiveBinding ob die Bindung JETZT trägt: die gemeinsame aktive
 *                       Leitungs-Lease (Paket E1) bzw. die aktuelle
 *                       Auftragszuweisung eines Spezialisten. C2 erfindet
 *                       dafür keine eigenen Lease-Felder.
 *   applyVerb           die Wirkung.
 * Fehlt eines davon, antwortet die Kette 503.
 * ----------------------------------------------------------------------- */
function requireAdapters(deps, { write }) {
  if (!deps.domain) return authError("auth_not_configured", "domain_adapter_not_available");
  if (write) {
    for (const name of ["resolveTarget", "assertActiveBinding", "applyVerb"]) {
      if (typeof deps.domain[name] !== "function") return authError("auth_not_configured", "domain_adapter_not_available");
    }
    if (!deps.idempotency || typeof deps.idempotency.prepare !== "function" || typeof deps.idempotency.apply !== "function") {
      return authError("auth_not_configured", "idempotency_adapter_not_available");
    }
    if (!deps.store || typeof deps.store.mutate !== "function") return authError("auth_not_configured", "store_adapter_not_available");
  } else {
    for (const name of ["loadObject", "listPage"]) {
      if (typeof deps.domain[name] !== "function") return authError("auth_not_configured", "domain_adapter_not_available");
    }
    if (!deps.store || typeof deps.store.readSnapshot !== "function") return authError("auth_not_configured", "store_adapter_not_available");
  }
  return authOk();
}

/* Schreiben ist standardmässig aus. `QUANTUS_V3_API_WRITES=enabled` UND
   `QUANTUS_V3_MODE=enforce` — beides, bewusst. */
export function writesEnabled(config, read = envRead) {
  const flag = String(read("QUANTUS_V3_API_WRITES") || "").trim().toLowerCase();
  return flag === "enabled" && config.mode === "enforce";
}

/* ── Der Kern, streng geprüft ────────────────────────────────────────────
 *
 * BEFUND (Review 33a4b3d): Im Trockenlauf wurde eine fehlende
 * `automation.dataRevision` zu einer erfundenen 0. Jetzt gilt auf JEDEM Weg
 * dieselbe Prüfung — auch ohne Schreiben. */
export function assertCoreSnapshot(snapshot) {
  const istRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!istRecord(snapshot) || !istRecord(snapshot.entities)) return authError("auth_not_configured", "core_invalid");
  const automation = snapshot.automation;
  if (!istRecord(automation) || automation.schemaVersion !== 3
    || !istRecord(automation.idempotencyByKey)
    || !isDataRevision(automation.dataRevision)) {
    return authError("auth_not_configured", "core_invalid");
  }
  return authOk({ dataRevision: automation.dataRevision });
}

/* ── Der Körper, begrenzt gelesen ────────────────────────────────────────
 *
 * BEFUND (Review 33a4b3d): `req.text()` las erst alles und prüfte dann die
 * 64 KiB — ein Aufrufer ohne Ausweis konnte also beliebig viel Speicher
 * belegen. Jetzt wird der Strom gelesen und beim Überschreiten ABGEBROCHEN;
 * eine zu grosse `Content-Length` genügt schon vorher. */
export async function readBoundedBody(req, maxBytes = COMMAND_MAX_BYTES) {
  const angekuendigt = Number(req?.headers?.get?.("content-length"));
  if (Number.isFinite(angekuendigt) && angekuendigt > maxBytes) {
    return serviceDenial("payload_too_large", "command_too_large");
  }

  const koerper = req?.body;
  if (koerper && typeof koerper.getReader === "function") {
    const leser = koerper.getReader();
    const teile = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await leser.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        if (bytes > maxBytes) {
          try { await leser.cancel(); } catch { /* der Strom ist ohnehin zu Ende */ }
          return serviceDenial("payload_too_large", "command_too_large");
        }
        teile.push(value);
      }
    } catch {
      return serviceDenial("invalid_request", "body_unreadable");
    }
    return authOk({ text: Buffer.concat(teile.map((t) => Buffer.from(t))).toString("utf8"), bytes });
  }

  // Kein Strom (etwa in Tests): dann wenigstens nach dem Lesen messen.
  let text = "";
  try { text = await req.text(); } catch { return serviceDenial("invalid_request", "body_unreadable"); }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) return serviceDenial("payload_too_large", "command_too_large");
  return authOk({ text, bytes });
}

/* ══ Der Befehlsweg ══════════════════════════════════════════════════════ */

export async function handleCommandRequest(req, deps = {}) {
  const requestId = typeof deps.newRequestId === "function" ? String(deps.newRequestId()) : "";
  const route = "quantus-ingest";
  const header = (name) => req?.headers?.get?.(name) ?? null;

  if (!requestId) return jsonResponse({ ok: false, error: "auth_not_configured", reason: "request_id_missing" }, { status: 503 });

  // 1. Konfiguration
  const cfg = (deps.resolveAuthConfig || defaultResolveAuthConfig)(deps.env || envRead);
  if (!cfg.ok) return jsonResponse({ ok: false, error: cfg.error, reason: cfg.reason, missing: cfg.missing, requestId }, { status: cfg.status });
  const config = cfg.config;

  if (req.method === "OPTIONS") {
    const vor = evaluateOrigin({ origin: header("origin"), principalKind: "user", config });
    if (!vor.ok) return denial(vor, { requestId });
    return { status: 204, headers: { ...vor.corsHeaders }, body: null };
  }
  if (req.method !== "POST") return denial(authError("invalid_request", "method_not_allowed"), { requestId });

  // 2. TLS
  const tls = enforceTls(req);
  if (!tls.ok) return denial(tls, { requestId });

  // 3. Der Körper — BEGRENZT gelesen, bevor irgendetwas davon geglaubt wird.
  const roh = await readBoundedBody(req, COMMAND_MAX_BYTES);
  if (!roh.ok) return denial(roh, { requestId });
  const koerper = enforceJsonCommand({ contentType: header("content-type"), rawBody: roh.text, maxBytes: COMMAND_MAX_BYTES });
  if (!koerper.ok) return denial(koerper, { requestId });

  const identitaet = rejectIdentityInPayload(koerper.value);
  if (!identitaet.ok) return denial(identitaet, { requestId });

  const umschlag = parseCommandEnvelope(koerper.value);
  if (!umschlag.ok) return denial(umschlag, { requestId });
  const { command, descriptor } = umschlag;

  const idem = parseIdempotencyKey(header("idempotency-key"));
  if (!idem.ok) return denial(idem, { requestId });

  // 4. Ausweis
  const ausweis = await authenticate({
    rawCredential: parseAuthorizationHeader(header("authorization")),
    config, route, jobId: command.jobId, deps,
  });
  if (!ausweis.ok) return denial(ausweis, { requestId });
  const principal = ausweis.principal;

  // 5. Herkunft — erst jetzt, weil die Art des Principals sie bestimmt.
  const herkunft = evaluateOrigin({ origin: header("origin"), principalKind: principal.kind, config });
  if (!herkunft.ok) return denial(herkunft, { requestId });
  const cors = herkunft.corsHeaders;

  // 6. Ratenbegrenzung
  const rate = await enforceRateLimit({ principal, verb: command.verb, deps });
  if (!rate.ok) {
    const extra = rate.retryAfter ? { "Retry-After": String(rate.retryAfter) } : null;
    return denial(rate, { requestId, corsHeaders: cors, extraHeaders: extra });
  }

  /*
   * 7. Schreibfreigabe.
   *
   * BEFUND (Review 33a4b3d): Ohne Freigabe antwortete der Dienst 200 mit
   * `ok:true`, `serverNow`, `replayed` und einer Revision — das sieht aus wie
   * eine Commit-Quittung, und ein Client legte es als bestätigt ab, obwohl
   * nichts geschrieben wurde. Ein ausgeschalteter Schreibweg antwortet jetzt
   * 503 `api_writes_disabled`, ohne jedes Quittungsfeld.
   *
   * Prüfen ohne Schreiben gibt es weiterhin — aber nur AUSDRÜCKLICH, über die
   * Kopfzeile `X-Quantus-Validate-Only`, und die Antwort trägt kein einziges
   * Feld einer Quittung. Sie sagt ausserdem, was sie NICHT geprüft hat:
   * die Fachbedingungen, denn `applyVerb` lief nicht.
   */
  const nurPruefen = /^(1|true|yes)$/i.test(String(header("x-quantus-validate-only") || "").trim());
  const darfSchreiben = writesEnabled(config, deps.env || envRead);
  if (!darfSchreiben && !nurPruefen) {
    return denial(serviceDenial("api_writes_disabled", "api_writes_disabled"), { requestId, corsHeaders: cors });
  }

  // 8. Adapter
  const adapter = requireAdapters(deps, { write: true });
  if (!adapter.ok) return denial(adapter, { requestId, corsHeaders: cors });
  if (nurPruefen && typeof deps.store?.readSnapshot !== "function") {
    return denial(authError("auth_not_configured", "store_adapter_not_available"), { requestId, corsHeaders: cors });
  }

  // Die DOKUMENTZEIT steht einmal fest (sie landet im Beleg). Die
  // GÜLTIGKEITSPRÜFUNG benutzt sie NICHT — die fragt bei jedem Versuch neu.
  const serverNow = new Date(deps.now()).toISOString();

  /*
   * Die Autorisierung gegen einen konkreten Schnappschuss. Sie läuft in JEDEM
   * CAS-Versuch und auch vor einer Wiederholung — mit der Zeit DIESES
   * Versuchs, nicht mit einer vorher gemerkten.
   */
  const autorisiereGegen = (snapshot, { pruefeVersion = true } = {}) => {
    const kern = assertCoreSnapshot(snapshot);
    if (!kern.ok) throw fail("core_invalid", "core_invalid");

    const jetztMs = deps.now();          // frisch, je Versuch
    const aufloesung = deps.domain.resolveTarget(snapshot, {
      verb: command.verb, command, principal, descriptor, nowMs: jetztMs,
    });
    if (!aufloesung || typeof aufloesung !== "object" || !aufloesung.resource) {
      throw fail("forbidden", "object_not_found");
    }
    const ressource = aufloesung.resource;
    const anker = aufloesung.anchor && typeof aufloesung.anchor === "object" ? aufloesung.anchor : ressource;

    // Was der Adapter geliefert hat, muss zum Umschlag passen — sonst hätte
    // ein Fachadapter die Rechteprüfung im Griff statt umgekehrt.
    if (String(ressource.kind || "") !== descriptor.resource.kind) throw fail("forbidden", "resource_kind_mismatch");
    const erwarteteAnkerArt = descriptor.anchor.self ? descriptor.resource.kind : descriptor.anchor.kind;
    if (String(anker.kind || "") !== erwarteteAnkerArt) throw fail("forbidden", "anchor_kind_mismatch");
    if (descriptor.resource.idField) {
      if (String(ressource.id || "") !== String(command.payload[descriptor.resource.idField] || "")) {
        throw fail("forbidden", "resource_id_mismatch");
      }
    }
    // Anlegen, Lauf-aus-jobId oder Sicherstellen — der Umschlag sagt es, und
    // der Adapter muss sich daran halten.
    if (descriptor.resource.creates === true && ressource.isNew !== true) throw fail("forbidden", "resource_not_new");
    if (descriptor.resource.fromJob === true) {
      if (ressource.isNew === true) throw fail("forbidden", "run_not_found");
      if (String(ressource.id || "") !== command.jobId) throw fail("forbidden", "resource_id_mismatch");
    }
    if (descriptor.resource.ensure === true && String(ressource.id || "") !== command.jobId) {
      throw fail("forbidden", "resource_id_mismatch");
    }
    if (!descriptor.anchor.self) {
      const erwarteteAnkerId = descriptor.anchor.idField
        ? String(command.payload[descriptor.anchor.idField] || "")
        : command.jobId;
      if (String(anker.id || "") !== erwarteteAnkerId) throw fail("forbidden", "anchor_id_mismatch");
    }

    const kategorie = dataCategoryForObjectKind(ressource.kind);
    if (!kategorie) throw fail("forbidden", "object_kind_unknown");

    const erlaubt = authorize({
      principal, verb: command.verb, dataCategory: kategorie,
      object: ressource, anchor: anker,
      policyVersion: config.policyVersion, config,
    });
    if (!erlaubt.ok) throw fail(erlaubt.error, erlaubt.reason);

    // Auftragsbindung des Tokens — unabhängig davon, was der Adapter sagt.
    if (principal.issuedBy === ISSUERS.jobToken && String(principal.jobId || "") !== command.jobId) {
      throw fail("forbidden", "job_mismatch");
    }

    /*
     * Die AKTIVE Bindung: gemeinsame Leitungs-Lease bzw. aktuelle
     * Auftragszuweisung. Sie kommt aus dem Fachadapter (Paket E1) — C2
     * erfindet dafür keine eigenen Felder — und wird mit der Zeit DIESES
     * Versuchs geprüft, auch bei einer Wiederholung.
     */
    const bindung = deps.domain.assertActiveBinding({
      snapshot, principal, resource: ressource, anchor: anker,
      verb: command.verb, jobId: command.jobId, command, nowMs: jetztMs,
    });
    if (!bindung || bindung.ok !== true) {
      throw fail("forbidden", String(bindung?.reason || "binding_not_active"));
    }

    // Erwartete Entitätsversion — gemessen am FRISCHEN Objekt.
    //
    // Ausnahme, und nur diese eine: eine WIEDERHOLUNG. Der erste Anlauf hat
    // die Version bereits erhöht; verlangte man sie erneut, könnte eine
    // Netzwiederholung nie ihre Quittung abholen. Die RECHTE werden trotzdem
    // frisch geprüft.
    const neu = ressource.isNew === true;
    const version = neu ? 0 : ressource.entityVersion;
    if (!Number.isInteger(version) || version < 0) throw fail("core_invalid", "entity_version_missing");
    if (pruefeVersion && version !== command.expectedEntityVersion) {
      throw fail("stale_entity_version", "entity_version_stale");
    }

    return { resource: ressource, anchor: anker, dataCategory: kategorie, isNew: neu, version };
  };

  // 9. Nur prüfen (ausdrücklich verlangt): keine Wirkung, KEINE Quittung.
  if (nurPruefen) {
    let snapshot;
    try {
      snapshot = await deps.store.readSnapshot();
    } catch {
      return denial(authError("auth_not_configured", "core_unavailable"), { requestId, corsHeaders: cors });
    }
    const kern = assertCoreSnapshot(snapshot);
    if (!kern.ok) return denial(kern, { requestId, corsHeaders: cors });
    try {
      const ziel = autorisiereGegen(snapshot);
      return jsonResponse({
        validated: true,
        applied: false,
        stored: false,
        domainConditionsEvaluated: false,
        verb: command.verb,
        observedEntityVersion: ziel.version,
        resourceIsNew: ziel.isNew,
        checkedAt: serverNow,
        requestId,
        note: "Nur geprüft: Umschlag, Ausweis, Rechte, Bindung und Version. Nichts gespeichert, Fachbedingungen nicht ausgewertet.",
      }, { corsHeaders: cors, extraHeaders: { "X-Quantus-Applied": "false" } });
    } catch (err) {
      return fehlerAntwort(err, { requestId, corsHeaders: cors });
    }
  }

  // 10. Schreiben: prepare EINMAL, ausserhalb der CAS-Schleife.
  let prepared;
  try {
    prepared = deps.idempotency.prepare({
      tenantId: principal.tenant,
      principalId: principal.id,
      key: idem.idempotencyKey,
      command,
      requestId,
      now: serverNow,
    });
  } catch (err) {
    return fehlerAntwort(err, { requestId, corsHeaders: cors });
  }

  try {
    const { result } = await deps.store.mutate(CORE_KEY, (current) => {
      // In JEDEM Versuch und auch vor einer Wiederholung: frisch autorisieren.
      // Ob es eine Wiederholung ist, sagt der bereits vorhandene Beleg — der
      // Ledger wird dabei nur GELESEN; geschrieben wird er allein vom
      // Idempotenzmodul.
      const istWiederholung = Boolean(current?.automation?.idempotencyByKey
        && Object.prototype.hasOwnProperty.call(current.automation.idempotencyByKey, prepared.ledgerKey));
      const ziel = autorisiereGegen(current, { pruefeVersion: !istWiederholung });
      return deps.idempotency.apply(current, prepared, (snapshot, befehl, kontext) => {
        const ergebnis = deps.domain.applyVerb(snapshot, befehl, kontext, {
          principal, resource: ziel.resource, anchor: ziel.anchor,
          dataCategory: ziel.dataCategory, isNew: ziel.isNew,
        });
        if (!ergebnis || typeof ergebnis !== "object" || !ergebnis.data || !ergebnis.result) {
          throw fail("core_invalid", "domain_result_invalid");
        }
        if (!ergebnis.result.entityVersions || typeof ergebnis.result.entityVersions !== "object") {
          throw fail("core_invalid", "domain_result_without_entity_versions");
        }
        return ergebnis;
      });
    }, { savedBy: "quantus-v3-ingest" });

    return jsonResponse({ ...result, applied: true, dryRun: false }, { corsHeaders: cors });
  } catch (err) {
    return fehlerAntwort(err, { requestId, corsHeaders: cors });
  }
}

/* Fehler aus Adaptern tragen `code`/`status`. Was wir nicht kennen, wird 500
   mit nichtssagendem Körper — ein Bibliothekstext gehört nicht nach draussen. */
function fehlerAntwort(err, { requestId, corsHeaders = null }) {
  const code = String(err?.code || "");
  if (code && Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code)) {
    const status = statusForCode(code);
    const reason = String(err?.reason || code);
    return jsonResponse({ ok: false, error: code, reason, requestId }, { status, corsHeaders });
  }
  return jsonResponse({ ok: false, error: "internal_error", reason: "unexpected", requestId }, { status: 500, corsHeaders });
}

/* ══ Der Leseweg ═════════════════════════════════════════════════════════ */

export async function handleReadRequest(req, deps = {}, { route } = {}) {
  const requestId = typeof deps.newRequestId === "function" ? String(deps.newRequestId()) : "";
  const header = (name) => req?.headers?.get?.(name) ?? null;
  if (!requestId) return jsonResponse({ ok: false, error: "auth_not_configured", reason: "request_id_missing" }, { status: 503 });

  const erlaubteAbfragen = Object.prototype.hasOwnProperty.call(ROUTE_QUERIES, route) ? ROUTE_QUERIES[route] : null;
  if (!erlaubteAbfragen) return denial(authError("forbidden", "unknown_route"), { requestId });

  const cfg = (deps.resolveAuthConfig || defaultResolveAuthConfig)(deps.env || envRead);
  if (!cfg.ok) return jsonResponse({ ok: false, error: cfg.error, reason: cfg.reason, missing: cfg.missing, requestId }, { status: cfg.status });
  const config = cfg.config;

  if (req.method === "OPTIONS") {
    const vor = evaluateOrigin({ origin: header("origin"), principalKind: "user", config });
    if (!vor.ok) return denial(vor, { requestId });
    return { status: 204, headers: { ...vor.corsHeaders }, body: null };
  }
  if (req.method !== "GET") return denial(authError("invalid_request", "method_not_allowed"), { requestId });

  const tls = enforceTls(req);
  if (!tls.ok) return denial(tls, { requestId });

  let url;
  try { url = new URL(String(req.url || "")); } catch { return denial(authError("invalid_request", "url_invalid"), { requestId }); }
  const query = String(url.searchParams.get("query") || "");
  if (!erlaubteAbfragen.includes(query)) return denial(authError("forbidden", "query_not_allowed"), { requestId });
  const named = NAMED_QUERIES[query];

  const scopeId = String(url.searchParams.get("scopeId") || "");
  if (!/^[A-Za-z0-9_:-]{1,120}$/.test(scopeId) || scopeId.includes("__")) {
    return denial(authError("invalid_request", "scope_id_invalid"), { requestId });
  }
  const jobId = String(url.searchParams.get("jobId") || "") || (named.scopeKind === "run" ? scopeId : "");
  const cursorParam = url.searchParams.get("cursor");

  const groesse = pageSizeFor(query, url.searchParams.get("pageSize"));
  if (!groesse.ok) return denial(groesse, { requestId });

  const ausweis = await authenticate({
    rawCredential: parseAuthorizationHeader(header("authorization")),
    config, route, jobId: jobId || null, deps,
  });
  if (!ausweis.ok) return denial(ausweis, { requestId });
  const principal = ausweis.principal;

  const herkunft = evaluateOrigin({ origin: header("origin"), principalKind: principal.kind, config });
  if (!herkunft.ok) return denial(herkunft, { requestId });
  const cors = herkunft.corsHeaders;

  const rate = await enforceRateLimit({ principal, verb: "context.read", deps });
  if (!rate.ok) {
    const extra = rate.retryAfter ? { "Retry-After": String(rate.retryAfter) } : null;
    return denial(rate, { requestId, corsHeaders: cors, extraHeaders: extra });
  }

  const adapter = requireAdapters(deps, { write: false });
  if (!adapter.ok) return denial(adapter, { requestId, corsHeaders: cors });

  const cursorCfg = (deps.resolveCursorConfig || resolveCursorConfig)(deps.env || envRead);
  if (!cursorCfg.ok) return jsonResponse({ ok: false, error: cursorCfg.error, reason: cursorCfg.reason, requestId }, { status: cursorCfg.status, corsHeaders: cors });

  // Erst JETZT wird gelesen — und nur gelesen. Kein Schreiben beim Lesen,
  // keine Migration beim Start.
  let snapshot;
  try {
    snapshot = await deps.store.readSnapshot();
  } catch {
    return denial(authError("auth_not_configured", "core_unavailable"), { requestId, corsHeaders: cors });
  }
  // Dieselbe strenge Kernprüfung wie auf dem Befehlsweg.
  const kern = assertCoreSnapshot(snapshot);
  if (!kern.ok) return denial(kern, { requestId, corsHeaders: cors });
  const dataRevision = kern.dataRevision;

  // Das Scope-Objekt kommt frisch aus dem autoritativen Bestand.
  /* Ein kaputter Kern ist kein „nicht gefunden": wirft der Fachadapter, ist
     das eine kontrollierte 503 (bzw. der Status seines Codes), nie ein 500. */
  let scopeObject;
  try {
    scopeObject = deps.domain.loadObject(snapshot, {
      kind: SCOPE_OBJECT_KINDS[query], id: scopeId, runId: jobId || null,
    });
  } catch (err) {
    if (err && err.code && Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, err.code)) return fehlerAntwort(err, { requestId, corsHeaders: cors });
    return denial(authError("auth_not_configured", "domain_adapter_failed"), { requestId, corsHeaders: cors });
  }
  if (!scopeObject) return denial(authError("forbidden", "object_not_found"), { requestId, corsHeaders: cors });

  let seite;
  if (cursorParam) {
    seite = await verifyCursor(cursorParam, {
      config: cursorCfg.config, authConfig: config, principal,
      expectedQuery: query, expectedScopeKind: named.scopeKind, expectedScopeId: scopeId,
      policyVersion: config.policyVersion, dataRevision,
      scopeObject, now: deps.now,
    });
    if (!seite.ok) return denial(seite, { requestId, corsHeaders: cors });
  } else {
    // Erste Seite: dieselbe Prüfung, nur ohne Cursor.
    const kategorie = dataCategoryForObjectKind(scopeObject.kind);
    if (!kategorie) return denial(authError("forbidden", "object_kind_unknown"), { requestId, corsHeaders: cors });
    const erlaubt = authorize({
      principal, verb: named.verb, dataCategory: kategorie, object: scopeObject,
      policyVersion: config.policyVersion, config,
    });
    if (!erlaubt.ok) return denial(erlaubt, { requestId, corsHeaders: cors });
    if (principal.issuedBy === ISSUERS.jobToken && jobId && String(principal.jobId || "") !== jobId) {
      return denial(authError("forbidden", "job_mismatch"), { requestId, corsHeaders: cors });
    }
    seite = authOk({ page: { query, dataCategory: named.dataCategory, scopeKind: named.scopeKind, scopeId, pageSize: groesse.pageSize, pageIndex: 0, afterId: null } });
  }

  const page = seite.page;
  let rohdaten;
  try {
    rohdaten = deps.domain.listPage(snapshot, {
      query, scopeId, pageSize: page.pageSize, afterId: page.afterId, principal,
    });
  } catch (err) {
    // Ein Fachadapter, der mit bekanntem Code ablehnt (z. B. forbidden: kein
    // aktiver Auftrag), antwortet mit dessen Status; alles andere ist 503.
    if (err && err.code && Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, err.code)) return fehlerAntwort(err, { requestId, corsHeaders: cors });
    return denial(authError("auth_not_configured", "domain_adapter_failed"), { requestId, corsHeaders: cors });
  }

  const eintraege = rohdaten?.items;
  if (!Array.isArray(eintraege)) return denial(authError("invalid_request", "items_not_a_list"), { requestId, corsHeaders: cors });

  /*
   * Eine übervolle Seite ist ein Vertragsbruch des Fachadapters: sie einfach
   * zu beschneiden wäre eine heimliche Auslassung, sie auszuliefern eine
   * Überschreitung. Also gar nichts — und sagen, dass es der Server war.
   */
  if (eintraege.length > page.pageSize) {
    return denial(serviceDenial("auth_not_configured", "page_overfull"), { requestId, corsHeaders: cors });
  }

  /*
   * JEDER Eintrag wird frisch autorisiert — Mandant, Eigentum bzw.
   * Auftragsbindung, erlaubte Kategorie — und muss zum Scope gehören. Ein
   * fremder Eintrag in einer erlaubten Seite wird NICHT still weggelassen
   * (das wäre eine Seite, die sich vollständig nennt, ohne es zu sein):
   * die Antwort ist 403, ohne Daten.
   */
  for (const eintrag of eintraege) {
    if (!eintrag || typeof eintrag !== "object") {
      return denial(authError("invalid_request", "items_not_a_list"), { requestId, corsHeaders: cors });
    }
    const kategorie = dataCategoryForObjectKind(eintrag.kind);
    if (!kategorie || kategorie !== named.itemCategory) {
      return denial(authError("forbidden", "item_kind_mismatch"), { requestId, corsHeaders: cors });
    }
    const erlaubt = authorize({
      principal, verb: named.verb, dataCategory: kategorie,
      object: eintrag, anchor: eintrag,
      policyVersion: config.policyVersion, config,
    });
    if (!erlaubt.ok) return denial(authError("forbidden", "item_not_authorized"), { requestId, corsHeaders: cors });
    if (String(eintrag.tenant || "") !== String(scopeObject.tenant || "")) {
      return denial(authError("forbidden", "item_not_authorized"), { requestId, corsHeaders: cors });
    }
    if (!belongsToScope(query, eintrag, scopeId)) {
      return denial(authError("forbidden", "item_outside_scope"), { requestId, corsHeaders: cors });
    }
  }

  const beschnitten = projectPage(query, eintraege);
  if (!beschnitten.ok) return denial(beschnitten, { requestId, corsHeaders: cors });

  /*
   * `hasMore` muss ein echtes Boolesches sein — fehlend, null oder eine
   * Zeichenkette werden NICHT zu „false" umgedeutet (Review 33a4b3d).
   * `describePage` entscheidet daraus; hier wird nur durchgereicht.
   */
  const weiter = rohdaten?.hasMore;
  const abgebrochen = rohdaten?.aborted === true || beschnitten.usable === false;

  let naechster = null;
  if (weiter === true && !abgebrochen) {
    // Ein Weiterzeiger muss WEITER zeigen: gültige Id, nicht dieselbe wie
    // zuvor, und der letzte gelieferte Eintrag. Sonst stünde die Seite still
    // oder übersprünge etwas.
    const zeiger = rohdaten?.nextAfterId;
    const letzter = String(eintraege[eintraege.length - 1]?.id || "");
    const gueltig = typeof zeiger === "string" && /^[A-Za-z0-9_:-]{1,120}$/.test(zeiger) && !zeiger.includes("__");
    if (!gueltig || zeiger === String(page.afterId || "") || zeiger !== letzter || !eintraege.length) {
      return denial(serviceDenial("auth_not_configured", "page_cursor_unusable"), { requestId, corsHeaders: cors });
    }
    const neuerCursor = await signCursor({
      config: cursorCfg.config, principal, query, scopeId,
      dataRevision, policyVersion: config.policyVersion,
      pageSize: page.pageSize, pageIndex: page.pageIndex + 1,
      afterId: zeiger, now: deps.now,
    });
    if (!neuerCursor.ok) return denial(neuerCursor, { requestId, corsHeaders: cors });
    naechster = neuerCursor.cursor;
  }

  const ergebnis = describePage({
    items: beschnitten.items,
    hasMore: abgebrochen ? false : weiter,
    aborted: abgebrochen,
    abortReason: rohdaten?.abortReason || (beschnitten.usable === false ? "item_unusable" : null),
    nextCursor: naechster,
  });

  return jsonResponse({
    ok: true,
    requestId,
    serverNow: new Date(deps.now()).toISOString(),
    dataRevision,
    query,
    scopeId,
    items: ergebnis.items,
    count: ergebnis.count,
    hasMore: ergebnis.status === "more",
    complete: ergebnis.complete,
    pageStatus: ergebnis.status,
    pageReason: ergebnis.reason,
    cursor: ergebnis.nextCursor,
    entityVersions: entityVersionsOf(ergebnis.items),
  }, { corsHeaders: cors });
}

export default { handleCommandRequest, handleReadRequest, identifyCredential, authenticate, statusForCode, ROUTE_QUERIES, CORE_KEY };
