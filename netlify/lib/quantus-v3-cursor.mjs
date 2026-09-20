/* ══ Quantus v3 — signierte, seitenweise Kontext-Cursor ═══════════════════
 *
 * WOZU
 * ----
 * `quantus_context` und `quantus_read` liefern Kontext seitenweise. Der Cursor
 * ist das, was der Aufrufer zwischen zwei Seiten in der Hand hält — und damit
 * die Stelle, an der er sich sonst mehr nehmen könnte, als die erste Seite ihm
 * gab: eine andere Abfrage, einen anderen Mandanten, einen fremden Scope,
 * eine grössere Seite.
 *
 * Deshalb ist ein Cursor KEIN Zeiger auf einen Datenbankpfad, sondern ein
 * signiertes, gebundenes JWT (jose, feste Algorithmenliste, eigener Aussteller
 * und eigener Schlüsselsatz). Er trägt:
 *     Principal · Principal-Art · Mandant · benannte Abfrage · Objektscope ·
 *     Policy-Version · Datenrevision · Seitenposition · Ablauf
 *
 * ZWEI BEFUNDE AUS DER REVIEW VON 5ac0bf7
 * ---------------------------------------
 * 1. `verifyCursor` prüfte den Cursor gegen SICH SELBST: ein Cursor auf
 *    `lead-1` wurde auch dann angenommen, wenn der Aufruf `lead-2` lesen
 *    wollte. Die Bindung war damit wertlos. Jetzt sind `expectedQuery`,
 *    `expectedScopeKind` und `expectedScopeId` PFLICHT, und zusätzlich wird
 *    die Seite NEU AUTORISIERT: `authorize()` läuft mit dem serverseitig
 *    geladenen Scope-Objekt, auf jeder Seite, mit Rolle und Jobbindung.
 * 2. `describePage` nannte eine Lieferung „vollständig", die gar keine Liste
 *    war (`{error:"source-unavailable"}`), und liess `hasMore` weg. Jetzt
 *    müssen die Daten eine echte Liste ohne Fehlermarke sein und `hasMore`
 *    ausdrücklich gesetzt sein — sonst gilt die Seite als abgebrochen.
 *
 * WAS EIN CURSOR NIE ENTHÄLT
 * --------------------------
 * Keine Mailtexte, keine Lead-Inhalte, keine Geheimnisse, keine Firebase-Pfade
 * und keine Blob-Keys. Die Feldliste ist abgeschlossen; der Beleg ist signiert,
 * NICHT verschlüsselt — darum darf nichts Vertrauliches hinein.
 * ═══════════════════════════════════════════════════════════════════════ */

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import {
  envRead, authError, authOk, authorize,
  MIN_SERVICE_SECRET_LENGTH, CLOCK_SKEW_SECONDS, isFiniteSeconds,
} from "./quantus-v3-auth.mjs";

export const CURSOR_CONFIG_VARS = Object.freeze({
  cursorKeys: "QUANTUS_V3_CURSOR_KEYS",
});

export const CURSOR_ISSUER = "quantus-v3/context-cursor";
export const CURSOR_TYP = "quantus-v3-cursor+jwt";
export const CURSOR_ALGS = Object.freeze(["HS256"]);
const VALID_KEY_STATUS = new Set(["active", "retiring", "revoked"]);

/*
 * Die erlaubten Abfragen. Ein Cursor kann nur auf eine dieser benannten
 * Abfragen lauten — nicht auf einen Pfad, nicht auf einen Blob-Key, nicht auf
 * „alles". Jede nennt die Art ihres Scopes, die Datenkategorie, das Verb, mit
 * dem jede Seite autorisiert wird, und ihre Höchstseitengrösse.
 */
export const NAMED_QUERIES = Object.freeze({
  // dataCategory  = Kategorie des SCOPE-Objekts, gegen das autorisiert wird
  // itemCategory  = Kategorie der Einträge, die die Seite liefert
  // Beides fällt oft zusammen — bei `notes.recent` nicht: dort hängen Notizen
  // an einem Lead, und wer die Notizen lesen darf, entscheidet der LEAD.
  "run.context":   Object.freeze({ scopeKind: "run",    dataCategory: "run_context", itemCategory: "run_context", verb: "context.read", maxPageSize: 50 }),
  "lead.context":  Object.freeze({ scopeKind: "lead",   dataCategory: "lead",        itemCategory: "lead",        verb: "context.read", maxPageSize: 50 }),
  "run.queue":     Object.freeze({ scopeKind: "tenant", dataCategory: "run",         itemCategory: "run",         verb: "context.read", maxPageSize: 100 }),
  "run.status":    Object.freeze({ scopeKind: "tenant", dataCategory: "run_status",  itemCategory: "run_status",  verb: "context.read", maxPageSize: 100 }),
  "notes.recent":  Object.freeze({ scopeKind: "lead",   dataCategory: "lead",        itemCategory: "note",        verb: "context.read", maxPageSize: 50 }),
  "policy.current":Object.freeze({ scopeKind: "tenant", dataCategory: "policy",      itemCategory: "policy",      verb: "context.read", maxPageSize: 10 }),
});

/* Welche Objektart der serverseitig geladene Scope-Datensatz haben muss,
   damit er zur Abfrage passt. Die Datenkategorie leitet `authorize()` selbst
   aus der Objektart ab — hier steht nur, was zusammengehört. */
export const SCOPE_OBJECT_KINDS = Object.freeze({
  "run.context": "run_context",
  "lead.context": "lead",
  "run.queue": "run",
  "run.status": "run_status",
  "notes.recent": "lead",
  "policy.current": "policy",
});

/* Die abgeschlossene Feldliste des Nutzinhalts (zusätzlich zu den
   JWT-Standardfeldern iss/sub/aud/iat/exp/jti). */
export const CURSOR_FIELDS = Object.freeze([
  "principalKind", "tenant", "query", "scopeKind", "scopeId",
  "policyVersion", "dataRevision", "pageSize", "pageIndex", "afterId",
]);
const JWT_STANDARD_FIELDS = Object.freeze(["iss", "sub", "aud", "iat", "exp", "jti", "nbf"]);

/*
 * Der Revisionsvertrag — EINE Stelle, für Ausstellen wie Prüfen.
 *
 * BEFUND (Review 9ff3423): `String(dataRevision || "")` verwarf die gültige
 * Revision 0 („data_revision_missing") und nahm gleichzeitig -1, 1.5, {} und
 * "not-a-revision" an, weil daraus per Umwandlung irgendeine Zeichenkette
 * wurde. Beides ist derselbe Fehler: der Wert wurde nie geprüft, nur
 * umgeformt.
 *
 * Eine Datenrevision ist eine NICHT NEGATIVE, SICHERE GANZE ZAHL — 0
 * eingeschlossen, denn der frische Kernstand beginnt dort.
 */
export function isDataRevision(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export const MAX_PAGE_INDEX = 500;
export const MAX_CURSOR_LIFETIME_SECONDS = 15 * 60;

function secretKey(secret) {
  return new TextEncoder().encode(secret);
}

export function resolveCursorConfig(read = envRead) {
  const raw = String(read(CURSOR_CONFIG_VARS.cursorKeys) || "").trim();
  if (!raw) {
    const denial = authError("auth_not_configured", "missing_configuration");
    return { ok: false, status: denial.status, error: denial.error, reason: denial.reason,
      missing: Object.freeze([CURSOR_CONFIG_VARS.cursorKeys]),
      body: Object.freeze({ ...denial.body, missing: Object.freeze([CURSOR_CONFIG_VARS.cursorKeys]) }) };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return cursorConfigFail("cursor_keys_unparsable"); }
  if (!Array.isArray(parsed) || !parsed.length) return cursorConfigFail("cursor_keys_shape");

  const keys = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return cursorConfigFail("cursor_keys_shape");
    const kid = String(entry.kid || "").trim();
    const secret = String(entry.secret || "");
    const status = String(entry.status || "active").trim();
    if (!kid || seen.has(kid) || !/^[A-Za-z0-9_-]{1,64}$/.test(kid)) return cursorConfigFail("cursor_keys_kid");
    seen.add(kid);
    if (secret.length < MIN_SERVICE_SECRET_LENGTH) return cursorConfigFail("cursor_keys_secret_too_short");
    if (!VALID_KEY_STATUS.has(status)) return cursorConfigFail("cursor_keys_status");
    keys.push(Object.freeze({ kid, secret, status }));
  }
  if (!keys.some((k) => k.status === "active")) return cursorConfigFail("cursor_keys_no_active");
  return { ok: true, config: Object.freeze({ cursorKeys: Object.freeze(keys) }) };
}

function cursorConfigFail(reason) {
  const denial = authError("auth_not_configured", reason);
  return { ok: false, status: denial.status, error: denial.error, reason: denial.reason,
    missing: Object.freeze([]), body: denial.body };
}

/* Ein Scope-Bezeichner ist eine Id, kein Pfad. */
export function assertScopeId(scopeId) {
  const s = String(scopeId == null ? "" : scopeId);
  if (!s) return authError("invalid_request", "scope_id_missing");
  if (s.length > 120) return authError("invalid_request", "scope_id_too_long");
  if (!/^[A-Za-z0-9_:-]+$/.test(s)) return authError("invalid_request", "scope_id_invalid");
  // `__` ist der Segmenttrenner der Blob-Schlüssel (blob-key-policy.mjs).
  if (s.includes("__")) return authError("invalid_request", "scope_id_invalid");
  return authOk({ scopeId: s });
}

function readHeader(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[2]) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
  const pad = parts[0].length % 4 === 0 ? "" : "=".repeat(4 - (parts[0].length % 4));
  try {
    const json = Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
    const header = JSON.parse(json);
    return header && typeof header === "object" ? header : null;
  } catch { return null; }
}

/*
 * Ausstellen. `principal` kommt aus der geprüften Identität, `query` aus
 * NAMED_QUERIES, `dataRevision` ist der Stand, auf dem die Seite beruhte.
 */
export async function signCursor({
  config, principal, query, scopeId, dataRevision, policyVersion,
  pageSize = 25, pageIndex = 0, afterId = null,
  lifetimeSeconds = 300, now = () => Date.now(), extra = null, jti = null,
} = {}) {
  if (!config || !Array.isArray(config.cursorKeys)) return authError("auth_not_configured", "cursor_config_missing");
  const key = config.cursorKeys.find((k) => k.status === "active");
  if (!key) return authError("auth_not_configured", "cursor_keys_no_active");

  // Kein Schlupfloch für Freitext: die Feldliste ist abgeschlossen.
  if (extra != null && (typeof extra !== "object" || Object.keys(extra).length)) {
    return authError("invalid_request", "cursor_field_not_allowed");
  }

  const principalId = String(principal?.id || "");
  const tenant = String(principal?.tenant || "");
  const principalKind = String(principal?.kind || "");
  if (!principalId || !tenant || !principalKind) return authError("invalid_request", "principal_incomplete");

  const q = String(query || "");
  const named = Object.prototype.hasOwnProperty.call(NAMED_QUERIES, q) ? NAMED_QUERIES[q] : null;
  if (!named) return authError("forbidden", "query_not_allowed");

  const scope = assertScopeId(scopeId);
  if (!scope.ok) return scope;

  // Streng typisiert, ohne Umwandlung: "25" ist keine Zahl.
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > named.maxPageSize) {
    return authError("invalid_request", "page_size_out_of_bounds");
  }
  if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > MAX_PAGE_INDEX) {
    return authError("invalid_request", "page_index_out_of_bounds");
  }

  if (!isDataRevision(dataRevision)) return authError("invalid_request", "data_revision_invalid");
  const revision = dataRevision;
  const policy = String(policyVersion || "");
  if (!policy) return authError("invalid_request", "policy_version_missing");

  if (afterId != null && !assertScopeId(afterId).ok) return authError("invalid_request", "after_id_invalid");

  const life = Number(lifetimeSeconds);
  if (!Number.isFinite(life) || life <= 0 || life > MAX_CURSOR_LIFETIME_SECONDS) {
    return authError("invalid_request", "cursor_lifetime_invalid");
  }

  const nowSec = Math.floor(now() / 1000);
  const cursor = await new SignJWT({
    principalKind,
    tenant,
    query: q,
    scopeKind: named.scopeKind,
    scopeId: scope.scopeId,
    policyVersion: policy,
    dataRevision: revision,
    pageSize,
    pageIndex,
    afterId: afterId == null ? null : String(afterId),
  })
    .setProtectedHeader({ alg: "HS256", kid: key.kid, typ: CURSOR_TYP })
    .setIssuer(CURSOR_ISSUER)
    .setAudience(`${CURSOR_ISSUER}#${q}`)
    .setSubject(principalId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + Math.floor(life))
    .setJti(String(jti || `${principalId}:${q}:${pageIndex}`))
    .sign(secretKey(key.secret));

  return authOk({ cursor, expiresAt: nowSec + Math.floor(life) });
}

/*
 * Prüfen — gegen das, was der AUFRUF will, nicht gegen den Cursor selbst.
 *
 * Pflicht: `expectedQuery`, `expectedScopeKind`, `expectedScopeId`,
 * `policyVersion`, `dataRevision`, `principal`, `authConfig` und das
 * serverseitig geladene `scopeObject`. Fehlt eines, wird nicht geprüft,
 * sondern gesperrt — sonst wäre die Bindung wieder nur eine Selbstauskunft.
 *
 * Am Ende läuft `authorize()` erneut: Rolle, Art, Ausstellweg, Mandant und
 * Jobbindung werden auf JEDER Seite neu geprüft. Ein Spezialist, dessen
 * Auftrag inzwischen ein anderer ist, blättert nicht weiter.
 */
export async function verifyCursor(cursor, {
  config, authConfig, principal,
  expectedQuery, expectedScopeKind, expectedScopeId,
  policyVersion, dataRevision, scopeObject,
  now = () => Date.now(),
} = {}) {
  if (!config || !Array.isArray(config.cursorKeys)) return authError("auth_not_configured", "cursor_config_missing");
  if (!authConfig || !authConfig.policyVersion) return authError("auth_not_configured", "config_missing");

  const wantQuery = String(expectedQuery || "");
  const wantScopeKind = String(expectedScopeKind || "");
  const wantScopeId = String(expectedScopeId || "");
  if (!wantQuery) return authError("forbidden", "expected_query_missing");
  if (!wantScopeKind) return authError("forbidden", "expected_scope_kind_missing");
  if (!wantScopeId) return authError("forbidden", "expected_scope_id_missing");
  if (!policyVersion) return authError("forbidden", "policy_version_missing");
  // 0 ist eine gültige Revision — aber „irgendwas" ist keine.
  if (!isDataRevision(dataRevision)) return authError("forbidden", "data_revision_invalid");
  if (!principal || typeof principal !== "object") return authError("forbidden", "principal_missing");
  if (!scopeObject || typeof scopeObject !== "object") return authError("forbidden", "scope_object_missing");

  const named = Object.prototype.hasOwnProperty.call(NAMED_QUERIES, wantQuery) ? NAMED_QUERIES[wantQuery] : null;
  if (!named) return authError("forbidden", "query_not_allowed");

  const header = readHeader(cursor);
  if (!header) return authError("invalid_request", "cursor_malformed");
  if (String(header.alg || "") !== "HS256") return authError("forbidden", "cursor_alg_not_allowed");
  if (String(header.typ || "") !== CURSOR_TYP) return authError("invalid_request", "cursor_typ_mismatch");
  const kid = String(header.kid || "");
  const key = config.cursorKeys.find((k) => k.kid === kid);
  if (!key) return authError("forbidden", "cursor_unknown_key");
  if (key.status === "revoked") return authError("forbidden", "cursor_key_revoked");

  let payload;
  try {
    const verified = await jwtVerify(cursor, secretKey(key.secret), {
      algorithms: [...CURSOR_ALGS],
      issuer: CURSOR_ISSUER,
      audience: `${CURSOR_ISSUER}#${wantQuery}`,
      typ: CURSOR_TYP,
      clockTolerance: 0,
      currentDate: new Date(now()),
      requiredClaims: ["sub", "iat", "exp", "tenant", "query", "scopeKind", "scopeId", "policyVersion", "dataRevision", "pageSize", "pageIndex"],
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return authError("forbidden", "cursor_expired");
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) return authError("forbidden", "cursor_signature_invalid");
    if (err instanceof joseErrors.JOSEAlgNotAllowed) return authError("forbidden", "cursor_alg_not_allowed");
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = String(err.claim || "");
      if (claim === "aud") return authError("forbidden", "cursor_query_mismatch");
      if (claim === "iss") return authError("forbidden", "cursor_issuer_mismatch");
      return authError("forbidden", `cursor_claim_invalid_${claim || "unknown"}`);
    }
    return authError("invalid_request", "cursor_malformed");
  }

  // Abgeschlossene Feldliste — auch beim Prüfen, auch bei gültiger Signatur.
  for (const k of Object.keys(payload)) {
    if (!CURSOR_FIELDS.includes(k) && !JWT_STANDARD_FIELDS.includes(k)) {
      return authError("invalid_request", "cursor_field_not_allowed");
    }
  }

  const nowSec = Math.floor(now() / 1000);
  if (!isFiniteSeconds(payload.exp)) return authError("forbidden", "cursor_expired");
  if (!isFiniteSeconds(payload.iat) || payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
    return authError("invalid_request", "cursor_malformed");
  }

  // Principal: Id, Art und Mandant.
  if (String(payload.sub) !== String(principal.id || "")) return authError("forbidden", "cursor_principal_mismatch");
  if (String(payload.principalKind) !== String(principal.kind || "")) return authError("forbidden", "cursor_principal_mismatch");
  if (String(payload.tenant) !== String(principal.tenant || "")) return authError("forbidden", "cursor_tenant_mismatch");

  // Abfrage und Scope gegen den AUFRUF (der Befund der Review).
  if (String(payload.query) !== wantQuery) return authError("forbidden", "cursor_query_mismatch");
  if (String(payload.scopeKind) !== named.scopeKind) return authError("forbidden", "cursor_scope_mismatch");
  if (String(payload.scopeKind) !== wantScopeKind) return authError("forbidden", "cursor_scope_mismatch");
  if (String(payload.scopeId) !== wantScopeId) return authError("forbidden", "cursor_scope_mismatch");
  const scope = assertScopeId(payload.scopeId);
  if (!scope.ok) return authError("invalid_request", "cursor_scope_invalid");

  if (String(payload.policyVersion || "") !== String(policyVersion)) return authError("forbidden", "cursor_policy_changed");
  if (!isDataRevision(payload.dataRevision)) return authError("invalid_request", "cursor_revision_invalid");
  if (payload.dataRevision !== dataRevision) return authError("forbidden", "cursor_revision_changed");

  if (!Number.isInteger(payload.pageSize) || payload.pageSize < 1 || payload.pageSize > named.maxPageSize) {
    return authError("invalid_request", "page_size_out_of_bounds");
  }
  if (!Number.isInteger(payload.pageIndex) || payload.pageIndex < 0 || payload.pageIndex > MAX_PAGE_INDEX) {
    return authError("invalid_request", "page_index_out_of_bounds");
  }
  if (payload.afterId != null && !assertScopeId(payload.afterId).ok) return authError("invalid_request", "after_id_invalid");

  // Das serverseitig geladene Objekt muss zur Abfrage und zum Scope passen …
  const erwarteteArt = SCOPE_OBJECT_KINDS[wantQuery];
  if (String(scopeObject.kind || "") !== erwarteteArt) return authError("forbidden", "scope_object_kind_mismatch");
  if (String(scopeObject.id || "") !== wantScopeId) return authError("forbidden", "scope_object_mismatch");

  // … und die Seite wird NEU autorisiert: Rolle, Art, Ausstellweg, Mandant,
  // Jobbindung — auf jeder einzelnen Seite.
  const erlaubt = authorize({
    principal,
    verb: named.verb,
    dataCategory: named.dataCategory,
    object: scopeObject,
    policyVersion,
    config: authConfig,
  });
  if (!erlaubt.ok) return erlaubt;

  return authOk({
    page: Object.freeze({
      query: wantQuery,
      dataCategory: named.dataCategory,
      scopeKind: named.scopeKind,
      scopeId: scope.scopeId,
      pageSize: payload.pageSize,
      pageIndex: payload.pageIndex,
      afterId: payload.afterId == null ? null : String(payload.afterId),
      expiresAt: payload.exp,
    }),
  });
}

/*
 * Das Ergebnis einer Seite — samt ehrlicher Aussage über Vollständigkeit.
 *
 *   done      alles geliefert, kein weiterer Cursor
 *   more      weitere Seiten, Cursor liegt bei
 *   aborted   abgebrochen (Zeitbudget, Limit, Fehler, unbrauchbare Daten):
 *             `complete: false`, kein Folgecursor, Grund dabei.
 *
 * `items` MUSS eine Liste brauchbarer Einträge sein und `hasMore` ausdrücklich
 * gesetzt — beides Befunde der Review von 5ac0bf7. Eine Fehlermeldung anstelle
 * von Daten ist keine vollständige Seite, und eine fehlende
 * Fortsetzungsangabe ist keine Zusicherung, dass nichts mehr kommt.
 */
export function describePage({ items, hasMore, aborted = false, abortReason = null, nextCursor = null } = {}) {
  const abbruch = (reason, note, liste = []) => Object.freeze({
    items: liste, count: Array.isArray(liste) ? liste.length : 0,
    complete: false, status: "aborted", reason: String(reason), nextCursor: null,
    note: note || "Abgebrochene Seite: kein Beweis, dass es nichts weiteres gibt.",
  });

  if (!Array.isArray(items)) {
    return abbruch("invalid_items", "Keine Liste geliefert — das ist keine vollständige Seite, sondern ein Ausfall.");
  }
  for (const eintrag of items) {
    if (!eintrag || typeof eintrag !== "object" || Array.isArray(eintrag)) {
      return abbruch("invalid_item", "Ein Eintrag ist kein Datensatz.", items);
    }
    if (Object.prototype.hasOwnProperty.call(eintrag, "error")) {
      return abbruch("item_error", "Ein Eintrag trägt eine Fehlermarke.", items);
    }
  }
  if (aborted) return abbruch(abortReason || "unknown", null, items);
  // `hasMore` ist Pflicht: „nicht gesagt" heisst nicht „nichts mehr da".
  if (typeof hasMore !== "boolean") {
    return abbruch("has_more_missing", "Ohne ausdrückliches hasMore gilt die Seite als abgebrochen.", items);
  }
  if (hasMore) {
    if (!nextCursor) return abbruch("next_cursor_missing", "Weitere Seiten angekündigt, aber kein Cursor.", items);
    return Object.freeze({ items, count: items.length, complete: false, status: "more", reason: null, nextCursor });
  }
  return Object.freeze({ items, count: items.length, complete: true, status: "done", reason: null, nextCursor: null });
}

export default {
  resolveCursorConfig, signCursor, verifyCursor, describePage, assertScopeId,
  NAMED_QUERIES, SCOPE_OBJECT_KINDS, CURSOR_FIELDS, CURSOR_CONFIG_VARS,
};
