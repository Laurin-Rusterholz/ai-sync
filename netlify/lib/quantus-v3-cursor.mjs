/* ══ Quantus v3 — signierte, seitenweise Kontext-Cursor ═══════════════════
 *
 * WOZU
 * ----
 * `quantus_context` und `quantus_read` liefern Kontext seitenweise. Der Cursor
 * ist das, was der Aufrufer zwischen zwei Seiten in der Hand hält — und damit
 * genau die Stelle, an der ein Aufrufer sich sonst mehr Rechte nehmen könnte,
 * als die erste Seite ihm gab: eine andere Abfrage, einen anderen Mandanten,
 * einen fremden Objektscope, eine grössere Seite.
 *
 * Deshalb ist ein Cursor hier KEIN Zeiger auf einen Datenbankpfad, sondern ein
 * SIGNIERTER, gebundener Beleg. Er trägt:
 *     Principal · Mandant · benannte Abfrage · Objektscope ·
 *     Policy-Version · Datenrevision · Ablaufzeit · Seitenposition
 * und wird gegen genau diese Werte geprüft. Stimmt einer nicht, gibt es keine
 * zweite Seite.
 *
 * WAS EIN CURSOR NIE ENTHÄLT
 * --------------------------
 * Keine Mailtexte, keine Lead-Inhalte, keine Geheimnisse, keine Firebase-Pfade
 * und keine Blob-Keys. Der Inhalt ist eine ABGESCHLOSSENE Feldliste
 * (`CURSOR_FIELDS`); ein unbekanntes Feld lässt `signCursor` scheitern, statt
 * es mitzunehmen. Wer also versucht, den Cursor als Transportmittel für Text
 * zu benutzen, bekommt beim Ausstellen eine Absage — nicht erst im Leck.
 * Der Beleg ist signiert, NICHT verschlüsselt: er ist lesbar, und genau darum
 * darf nichts Vertrauliches hinein.
 *
 * SCHLÜSSEL UND ROTATION
 * ----------------------
 * Eigene Serverschlüssel (`QUANTUS_V3_CURSOR_KEYS`), getrennt von den
 * Job-Token-Schlüsseln, mit eigener Domänentrennung in der Signatur: derselbe
 * Schlüsselwert könnte kein Job-Token signieren und umgekehrt. Rotation läuft
 * über mehrere Einträge — `active` stellt aus, `retiring` wird noch anerkannt,
 * `revoked` nie. Fehlen die Schlüssel, ist der Zustand 503, nicht „dann eben
 * ohne Cursor".
 *
 * EINE ABGEBROCHENE SEITE IST KEINE VOLLSTÄNDIGKEIT
 * -------------------------------------------------
 * `describePage()` unterscheidet drei Ausgänge: vollständig, weitere Seiten,
 * ABGEBROCHEN (Zeitbudget, Limit, Fehler). Nur der erste darf „vollständig"
 * heissen. Ein Agent, der aus einer abgebrochenen Seite „es gibt nichts
 * weiter" schliesst, zieht den falschen Schluss — deshalb trägt die Antwort
 * `complete: false` und einen Grund.
 * ═══════════════════════════════════════════════════════════════════════ */

import { createHmac, timingSafeEqual } from "node:crypto";
import { envRead, authError, authOk, MIN_SERVICE_SECRET_LENGTH } from "./quantus-v3-auth.mjs";

export const CURSOR_CONFIG_VARS = Object.freeze({
  cursorKeys: "QUANTUS_V3_CURSOR_KEYS",
});

const CURSOR_PREFIX = "qv3c1";
const CURSOR_DOMAIN = "qv3-context-cursor.v1";
const VALID_KEY_STATUS = new Set(["active", "retiring", "revoked"]);

/* Die erlaubten Abfragen. Ein Cursor kann nur auf eine dieser benannten
   Abfragen lauten — nicht auf einen Pfad, nicht auf einen Blob-Key, nicht auf
   „alles". Jede nennt die Objektart, auf die ihr Scope zeigt, und ihre
   Höchstseitengrösse. */
export const NAMED_QUERIES = Object.freeze({
  "job.context":   Object.freeze({ scopeKind: "job",  maxPageSize: 50,  dataCategory: "job_context" }),
  "lead.context":  Object.freeze({ scopeKind: "lead", maxPageSize: 50,  dataCategory: "lead" }),
  "job.queue":     Object.freeze({ scopeKind: "tenant", maxPageSize: 100, dataCategory: "job" }),
  "run.status":    Object.freeze({ scopeKind: "tenant", maxPageSize: 100, dataCategory: "run_status" }),
});

/* Die abgeschlossene Feldliste eines Cursors. Alles andere ist ein Fehler. */
export const CURSOR_FIELDS = Object.freeze([
  "v", "principal", "principalKind", "tenant", "query", "scopeKind", "scopeId",
  "policyVersion", "dataRevision", "pageSize", "pageIndex", "afterId", "exp",
]);

export const MAX_PAGE_INDEX = 500;
export const MAX_CURSOR_LIFETIME_SECONDS = 15 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlToBuffer(segment) {
  const s = String(segment || "");
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(secret, kid, payloadB64) {
  return b64url(createHmac("sha256", secret).update(`${CURSOR_DOMAIN}|${kid}|${payloadB64}`, "utf8").digest());
}

/*
 * Konfiguration. Fehlt sie oder ist sie unbrauchbar: 503, fail closed.
 * Genannt wird nur der Name der Variable.
 */
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

/* Ein Scope-Bezeichner ist eine Id, kein Pfad. Schrägstriche, Punkte,
   „appStore", „.json" und alles ausserhalb von [A-Za-z0-9_-] fallen durch —
   damit kann ein Cursor nie zu einem beliebigen Firebase-Knoten oder Blob-Key
   werden. */
export function assertScopeId(scopeId) {
  const s = String(scopeId == null ? "" : scopeId);
  if (!s) return authError("invalid_request", "scope_id_missing");
  if (s.length > 128) return authError("invalid_request", "scope_id_too_long");
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return authError("invalid_request", "scope_id_invalid");
  // `__` ist der Segmenttrenner der Blob-Schlüssel (blob-key-policy.mjs). Eine
  // Scope-Id, die so aussieht, könnte später als Schlüssel missverstanden
  // werden — sie wird hier gar nicht erst zugelassen.
  if (s.includes("__")) return authError("invalid_request", "scope_id_invalid");
  return authOk({ scopeId: s });
}

/*
 * Ausstellen.
 *
 * `principal` kommt aus der geprüften Identität (nie aus dem Body), `query`
 * aus NAMED_QUERIES, `dataRevision` ist der Stand der Daten, auf dem Seite 1
 * beruhte. Alles, was nicht in CURSOR_FIELDS steht, führt zur Absage.
 */
export function signCursor({
  config, principal, query, scopeId, dataRevision, policyVersion,
  pageSize = 25, pageIndex = 0, afterId = null,
  lifetimeSeconds = 300, now = () => Date.now(), extra = null,
} = {}) {
  if (!config || !Array.isArray(config.cursorKeys)) return authError("auth_not_configured", "cursor_config_missing");
  const key = config.cursorKeys.find((k) => k.status === "active");
  if (!key) return authError("auth_not_configured", "cursor_keys_no_active");

  // Kein Schlupfloch für Freitext: der Cursor hat eine abgeschlossene
  // Feldliste, also gibt es kein „und dazu noch". Jedes zusätzliche Feld —
  // bekannt oder nicht — ist eine Absage, nicht ein stilles Weglassen.
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

  // Streng typisiert, ohne Umwandlung: "25" ist keine Zahl. Wo stillschweigend
  // umgewandelt wird, kommen irgendwann `true`, `[]` und `"25e9"` durch.
  const size = pageSize;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > named.maxPageSize) {
    return authError("invalid_request", "page_size_out_of_bounds");
  }
  const index = pageIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > MAX_PAGE_INDEX) {
    return authError("invalid_request", "page_index_out_of_bounds");
  }

  const revision = String(dataRevision || "");
  if (!revision) return authError("invalid_request", "data_revision_missing");
  const policy = String(policyVersion || "");
  if (!policy) return authError("invalid_request", "policy_version_missing");

  if (afterId != null) {
    const after = assertScopeId(afterId);
    if (!after.ok) return authError("invalid_request", "after_id_invalid");
  }

  const life = Number(lifetimeSeconds);
  if (!Number.isFinite(life) || life <= 0 || life > MAX_CURSOR_LIFETIME_SECONDS) return authError("invalid_request", "cursor_lifetime_invalid");

  const payload = {
    v: 1,
    principal: principalId,
    principalKind,
    tenant,
    query: q,
    scopeKind: named.scopeKind,
    scopeId: scope.scopeId,
    policyVersion: policy,
    dataRevision: revision,
    pageSize: size,
    pageIndex: index,
    afterId: afterId == null ? null : String(afterId),
    exp: Math.floor(now() / 1000) + Math.floor(life),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return authOk({
    cursor: `${CURSOR_PREFIX}.${key.kid}.${payloadB64}.${sign(key.secret, key.kid, payloadB64)}`,
    expiresAt: payload.exp,
  });
}

/*
 * Prüfen. Der Aufrufer muss sagen, WOGEGEN geprüft wird: Principal, Policy-
 * Version und aktuelle Datenrevision sind Pflicht. Ein Cursor, dessen
 * Revision nicht mehr stimmt, ist ungültig — die Seite beruhte auf einem
 * anderen Datenstand, und stillschweigend weiterzublättern hiesse, Einträge
 * zu überspringen oder doppelt zu liefern.
 */
export function verifyCursor(cursor, {
  config, principal, policyVersion, dataRevision, query = null, now = () => Date.now(),
} = {}) {
  if (!config || !Array.isArray(config.cursorKeys)) return authError("auth_not_configured", "cursor_config_missing");

  const parts = String(cursor || "").split(".");
  if (parts.length !== 4 || parts[0] !== CURSOR_PREFIX) return authError("invalid_request", "cursor_malformed");
  const [, kid, payloadB64, sig] = parts;
  const key = config.cursorKeys.find((k) => k.kid === kid);
  if (!key) return authError("forbidden", "cursor_unknown_key");
  if (key.status === "revoked") return authError("forbidden", "cursor_key_revoked");

  const expected = sign(key.secret, kid, payloadB64);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(sig || ""), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return authError("forbidden", "cursor_signature_invalid");

  const buf = b64urlToBuffer(payloadB64);
  if (!buf) return authError("invalid_request", "cursor_malformed");
  let payload;
  try { payload = JSON.parse(buf.toString("utf8")); } catch { return authError("invalid_request", "cursor_malformed"); }
  if (!payload || typeof payload !== "object" || payload.v !== 1) return authError("invalid_request", "cursor_malformed");

  // Die Feldliste ist abgeschlossen — auch beim Prüfen. Ein Cursor mit einem
  // zusätzlichen Feld ist keiner von uns, selbst wenn die Signatur stimmte
  // (etwa nach einem künftigen Formatwechsel).
  const keys = Object.keys(payload);
  if (keys.some((k) => !CURSOR_FIELDS.includes(k))) return authError("invalid_request", "cursor_field_not_allowed");

  const nowSec = Math.floor(now() / 1000);
  if (typeof payload.exp !== "number" || !(payload.exp > nowSec)) return authError("forbidden", "cursor_expired");

  if (!principal || typeof principal !== "object") return authError("forbidden", "principal_missing");
  if (String(payload.principal) !== String(principal.id || "")) return authError("forbidden", "cursor_principal_mismatch");
  if (String(payload.principalKind) !== String(principal.kind || "")) return authError("forbidden", "cursor_principal_mismatch");
  if (String(payload.tenant) !== String(principal.tenant || "")) return authError("forbidden", "cursor_tenant_mismatch");

  const named = Object.prototype.hasOwnProperty.call(NAMED_QUERIES, payload.query) ? NAMED_QUERIES[payload.query] : null;
  if (!named) return authError("forbidden", "query_not_allowed");
  if (query && String(query) !== String(payload.query)) return authError("forbidden", "cursor_query_mismatch");
  if (String(payload.scopeKind) !== named.scopeKind) return authError("forbidden", "cursor_scope_mismatch");
  const scope = assertScopeId(payload.scopeId);
  if (!scope.ok) return authError("invalid_request", "cursor_scope_invalid");

  if (String(payload.policyVersion || "") !== String(policyVersion || "")) return authError("forbidden", "cursor_policy_changed");
  if (String(payload.dataRevision || "") !== String(dataRevision || "")) return authError("forbidden", "cursor_revision_changed");

  if (!Number.isInteger(payload.pageSize) || payload.pageSize < 1 || payload.pageSize > named.maxPageSize) {
    return authError("invalid_request", "page_size_out_of_bounds");
  }
  if (!Number.isInteger(payload.pageIndex) || payload.pageIndex < 0 || payload.pageIndex > MAX_PAGE_INDEX) {
    return authError("invalid_request", "page_index_out_of_bounds");
  }
  if (payload.afterId != null && !assertScopeId(payload.afterId).ok) return authError("invalid_request", "after_id_invalid");

  return authOk({
    page: Object.freeze({
      query: String(payload.query),
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
 *   aborted   abgebrochen (Zeit, Limit, Fehler) — `complete: false`, und der
 *             Grund steht dabei. Ein weiterer Cursor wird NICHT ausgegeben,
 *             weil die Position nach einem Abbruch nicht verlässlich ist.
 */
export function describePage({ items = [], hasMore = false, aborted = false, abortReason = null, nextCursor = null } = {}) {
  const count = Array.isArray(items) ? items.length : 0;
  if (aborted) {
    return Object.freeze({
      items, count, complete: false, status: "aborted",
      reason: String(abortReason || "unknown"),
      nextCursor: null,
      note: "Abgebrochene Seite: kein Beweis, dass es nichts weiteres gibt.",
    });
  }
  if (hasMore) {
    if (!nextCursor) {
      return Object.freeze({
        items, count, complete: false, status: "aborted", reason: "next_cursor_missing",
        nextCursor: null,
        note: "Weitere Seiten angekündigt, aber kein Cursor — das gilt als Abbruch.",
      });
    }
    return Object.freeze({ items, count, complete: false, status: "more", reason: null, nextCursor });
  }
  return Object.freeze({ items, count, complete: true, status: "done", reason: null, nextCursor: null });
}

export default {
  resolveCursorConfig, signCursor, verifyCursor, describePage, assertScopeId,
  NAMED_QUERIES, CURSOR_FIELDS, CURSOR_CONFIG_VARS,
};
