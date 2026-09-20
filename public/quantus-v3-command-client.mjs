export const COMMAND_VERBS = Object.freeze([
  "intake.create", "intake.accept", "task.create", "lead.comment", "lead.transition", "lead.schedule",
  "briefing.answer", "briefing.consumeAnswer", "question.create", "question.resolve",
  "document.register", "document.processed", "worker.assign", "worker.return", "worker.review",
  "run.ensure", "run.claim", "run.renew", "run.checkpoint", "run.finalize", "note.append", "run.log",
]);

const COMMAND_FIELDS = new Set(["schemaVersion", "verb", "jobId", "expectedEntityVersion", "payload"]);
const STORE = "operations";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max
  && !/[\s\u0000-\u001f\u007f]/u.test(value);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

// Stable serialization detects reused operation IDs and never silently drops a
// field (undefined, accessors and non-JSON values would change the real request).
function json(value, maxBytes = 65_536) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 20_000 || depth > 32) fail("operation_too_complex");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || ancestors.has(item) || (!Array.isArray(item) && !record(item))) fail("invalid_json");
    if (Object.getOwnPropertySymbols(item).length) fail("invalid_json");
    ancestors.add(item);
    const keys = Object.keys(item);
    if (Array.isArray(item) && keys.length !== item.length) fail("invalid_json");
    const entries = (Array.isArray(item) ? Array.from({ length: item.length }, (_, i) => String(i)) : keys.sort()).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor) || ["__proto__", "constructor", "prototype"].includes(key)) fail("invalid_json");
      return `${Array.isArray(item) ? "" : `${JSON.stringify(key)}:`}${visit(descriptor.value, depth + 1)}`;
    });
    ancestors.delete(item);
    const result = Array.isArray(item) ? `[${entries.join(",")}]` : `{${entries.join(",")}}`;
    if (new TextEncoder().encode(result).length > maxBytes) fail("payload_too_large");
    return result;
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(result).length > maxBytes) fail("payload_too_large");
  return result;
}

export function serializeCommand(command) {
  const serialized = json(command);
  const safe = JSON.parse(serialized);
  if (!record(safe) || safe.schemaVersion !== 3 || !COMMAND_VERBS.includes(safe.verb)
    || Object.keys(safe).some((key) => !COMMAND_FIELDS.has(key)) || !record(safe.payload)) fail("invalid_command");
  if (Object.hasOwn(safe, "jobId") && !validId(safe.jobId, 128)) fail("invalid_job_id");
  if (Object.hasOwn(safe, "expectedEntityVersion")
    && (!Number.isSafeInteger(safe.expectedEntityVersion) || safe.expectedEntityVersion < 0)) fail("invalid_entity_version");
  return serialized;
}

function validReceipt(receipt) {
  return record(receipt) && receipt.ok === true && typeof receipt.replayed === "boolean"
    && (!Object.hasOwn(receipt, "applied") || receipt.applied === true)
    && (!Object.hasOwn(receipt, "dryRun") || receipt.dryRun === false)
    && typeof receipt.serverNow === "string" && Number.isFinite(Date.parse(receipt.serverNow))
    && new Date(receipt.serverNow).toISOString() === receipt.serverNow
    && Number.isSafeInteger(receipt.dataRevision) && receipt.dataRevision >= 0
    && validId(receipt.requestId) && record(receipt.entityVersions)
    && Object.values(receipt.entityVersions).every((v) => Number.isSafeInteger(v) && v >= 0);
}

export function createCommandTransport({ origin, getAuth, fetchImpl = globalThis.fetch, writesEnabled = false, now = Date.now } = {}) {
  let url;
  try { url = new URL(origin); } catch { fail("invalid_api_origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("invalid_api_origin");
  if (typeof getAuth !== "function" || typeof fetchImpl !== "function") fail("client_not_configured");
  const endpoint = `${url.origin}/.netlify/functions/quantus-ingest`;
  return Object.freeze({
    async send({ accountKey, operationId, command }, { signal } = {}) {
      if ((typeof writesEnabled === "function" ? writesEnabled() : writesEnabled) !== true) return { ok: false, status: 0, code: "writes_disabled", paused: true };
      if (!validId(accountKey) || !validId(operationId)) fail("invalid_operation_identity");
      const body = serializeCommand(command);
      let auth;
      try { auth = await getAuth(); } catch { return { ok: false, status: 401, code: "sign_in_required" }; }
      if (!auth || auth.accountKey !== accountKey || !validId(auth.idToken, 16_384)) return { ok: false, status: 401, code: "account_mismatch" };
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
          headers: { Authorization: `Bearer ${auth.idToken}`, "Content-Type": "application/json", "Idempotency-Key": operationId },
          body,
        });
      } catch {
        // The server may already have committed. Keep the same key for recovery.
        return { ok: false, status: 0, code: "outcome_unknown", retryable: true, uncertain: true };
      }
      let result;
      try { result = JSON.parse(await response.text()); } catch { result = null; }
      if (response.ok) {
        if (result?.applied === false || result?.dryRun === true) {
          return { ok: false, status: 0, code: "writes_disabled", paused: true };
        }
        if (!validReceipt(result)) return { ok: false, status: 0, code: "receipt_invalid", retryable: true, uncertain: true };
        return { ok: true, receipt: result };
      }
      const status = response.status;
      const suppliedCode = result?.error || result?.code;
      const code = typeof suppliedCode === "string" && /^[a-zA-Z0-9_:-]{1,80}$/.test(suppliedCode) ? suppliedCode : `http_${status}`;
      if (status === 503 && code === "api_writes_disabled") return { ok: false, status, code: "writes_disabled", paused: true };
      const retry = response.headers?.get?.("Retry-After");
      const retryDate = retry ? Date.parse(retry) : NaN;
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry)
        : Number.isFinite(retryDate) ? Math.max(0, Math.ceil((retryDate - validClock(now)) / 1000)) : null;
      if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds > (Number.MAX_SAFE_INTEGER - validClock(now)) / 1000)) {
        return { ok: false, status, code: "retry_after_out_of_range", retryable: false };
      }
      return { ok: false, status, code, retryable: RETRYABLE.has(status), retryAfterSeconds: seconds };
    },
  });
}

function validClock(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_local_clock");
  return value;
}

/** Local intent journal only. Never a second copy of the authoritative run. */
export async function openCommandQueue({ indexedDB = globalThis.indexedDB, databaseName = "quantus-v3-intents", now = Date.now } = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") fail("durable_storage_unavailable");
  const db = await new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ["accountKey", "operationId"] });
      store.createIndex("accountKey", "accountKey");
    };
    request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(Object.assign(new Error("durable_storage_unavailable"), { code: "durable_storage_unavailable" }));
    request.onblocked = () => { abandoned = true; reject(Object.assign(new Error("storage_upgrade_blocked"), { code: "storage_upgrade_blocked" })); };
  });
  db.onversionchange = () => db.close();
  let draining = false;

  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      let output, error;
      let tx;
      try { tx = db.transaction(STORE, mode); } catch { reject(Object.assign(new Error("durable_storage_unavailable"), { code: "durable_storage_unavailable" })); return; }
      const abort = (code) => { error = Object.assign(new Error(code), { code }); tx.abort(); };
      tx.oncomplete = () => resolve(output);
      tx.onabort = () => reject(error || Object.assign(new Error("durable_storage_write_failed"), { code: "durable_storage_write_failed" }));
      tx.onerror = () => {};
      try { action(tx.objectStore(STORE), (value) => { output = value; }, abort); } catch (e) { error = e; tx.abort(); }
    });
  }

  async function list(accountKey, { includeAcknowledged = false } = {}) {
    if (!validId(accountKey)) fail("invalid_account");
    return transaction("readonly", (store, done) => {
      const request = store.index("accountKey").getAll(accountKey);
      request.onsuccess = () => done(request.result.filter((entry) => includeAcknowledged || entry.status !== "acknowledged")
        .sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId)));
    });
  }

  async function putIntent({ accountKey, operationId, command, legacyOperation }, legacy = false) {
    if (!validId(accountKey) || !validId(operationId)) fail("invalid_operation_identity");
    const canonical = legacy ? json(legacyOperation, 2 * 1024 * 1024) : serializeCommand(command);
    const createdAt = validClock(now);
    return transaction("readwrite", (store, done, abort) => {
      const request = store.get([accountKey, operationId]);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing) {
          if (existing.canonical !== canonical || existing.kind !== (legacy ? "legacy" : "command")) return abort("operation_id_conflict");
          done(existing);
          return;
        }
        const entry = { accountKey, operationId, kind: legacy ? "legacy" : "command", canonical,
          ...(legacy ? { legacyOperation: JSON.parse(canonical) } : { command: JSON.parse(canonical) }),
          createdAt, status: legacy ? "legacy_unmapped" : "pending", attempts: 0, nextAttemptAt: 0, lastError: null };
        store.add(entry);
        done(entry);
      };
    });
  }

  async function saveOutcome(snapshot, outcome) {
    const receivedAt = validClock(now);
    return transaction("readwrite", (store, done, abort) => {
      const request = store.get([snapshot.accountKey, snapshot.operationId]);
      request.onsuccess = () => {
        const entry = request.result;
        if (!entry || entry.canonical !== snapshot.canonical) return abort("operation_changed");
        // A late failed request from another tab cannot undo a stored receipt.
        if (entry.status === "acknowledged" || outcome.paused) { done(entry); return; }
        const attempts = entry.attempts + 1;
        let status;
        if (outcome.ok && validReceipt(outcome.receipt)) status = "acknowledged";
        else if (outcome.status === 401) status = "needs_sign_in";
        else if (outcome.status === 409) status = "conflict";
        else if (outcome.status === 426) status = "upgrade_required";
        else if (outcome.retryable && attempts < 5) status = "retry_wait";
        else status = "needs_review";
        const backoff = Math.min(600_000, 30_000 * (2 ** Math.min(attempts - 1, 5)));
        const suppliedDelay = Number.isFinite(outcome.retryAfterSeconds) ? Math.max(0, outcome.retryAfterSeconds * 1000) : 0;
        const next = { ...entry, attempts, status, receivedAt,
          nextAttemptAt: status === "retry_wait" ? receivedAt + Math.max(backoff, suppliedDelay) : 0,
          lastError: status === "acknowledged" ? null : { code: outcome.code || "receipt_invalid", status: outcome.status || 0, uncertain: outcome.uncertain === true },
          ...(status === "acknowledged" ? { receipt: outcome.receipt } : {}) };
        store.put(next);
        done(next);
      };
    });
  }

  return Object.freeze({
    enqueue: (input) => putIntent(input),
    retainLegacy: (input) => putIntent(input, true),
    list,
    close: () => db.close(),
    async resumeAfterSignIn(accountKey) {
      if (!validId(accountKey)) fail("invalid_account");
      return transaction("readwrite", (store, done) => {
        let count = 0;
        const request = store.index("accountKey").openCursor(accountKey);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { done(count); return; }
          if (cursor.value.status === "needs_sign_in") {
            cursor.update({ ...cursor.value, status: "pending", nextAttemptAt: 0 });
            count += 1;
          }
          cursor.continue();
        };
      });
    },
    async drain(accountKey, { transport, limit = 20, signal } = {}) {
      if (!transport || typeof transport.send !== "function" || !Number.isInteger(limit) || limit < 1 || limit > 30) fail("invalid_drain");
      if (draining) return { busy: true, outcomes: [] };
      draining = true;
      try {
        const pending = (await list(accountKey)).filter((entry) => entry.kind === "command"
          && ["pending", "retry_wait"].includes(entry.status) && entry.nextAttemptAt <= validClock(now)).slice(0, limit);
        const outcomes = [];
        for (const entry of pending) {
          if (signal?.aborted) break;
          if (serializeCommand(entry.command) !== entry.canonical) fail("stored_operation_corrupt");
          let outcome;
          try { outcome = await transport.send(entry, { signal }); }
          catch { outcome = { ok: false, status: 0, code: "outcome_unknown", retryable: true, uncertain: true }; }
          if (outcome.paused) return { paused: true, code: outcome.code, outcomes };
          const saved = await saveOutcome(entry, outcome);
          outcomes.push({ operationId: saved.operationId, status: saved.status, error: saved.lastError });
          if (["needs_sign_in", "upgrade_required"].includes(saved.status)) break;
        }
        return { outcomes };
      } finally { draining = false; }
    },
  });
}
