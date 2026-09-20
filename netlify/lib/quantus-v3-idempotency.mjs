import { createHash } from "node:crypto";

export const IDEMPOTENCY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 64 * 1024;
const preparedCommands = new WeakSet();
const reservedResponseKeys = new Set(["ok", "replayed", "serverNow", "dataRevision", "requestId"]);

function fail(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// JSON.stringify alone silently drops undefined and converts non-finite numbers.
// Reject those ambiguous requests rather than assigning the same hash to them.
export function canonicalCommandJson(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 20_000 || depth > 32) fail("command_too_complex");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || ancestors.has(item)) fail("invalid_json_value");
    if (!Array.isArray(item) && !record(item)) fail("invalid_json_value");
    if (Object.getOwnPropertySymbols(item).length) fail("invalid_json_value");
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail("invalid_json_value");
      result = `[${Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !("value" in descriptor)) fail("invalid_json_value");
        return visit(descriptor.value, depth + 1);
      }).join(",")}]`;
    } else {
      result = `{${Object.keys(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) fail("invalid_json_value");
        if (["__proto__", "prototype", "constructor"].includes(key)) fail("invalid_json_key");
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    }
    ancestors.delete(item);
    if (Buffer.byteLength(result) > MAX_JSON_BYTES) fail("payload_too_large", 413);
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > MAX_JSON_BYTES) fail("payload_too_large", 413);
  return result;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function freeze(value) {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function identifier(value, name, max = 256) {
  if (typeof value !== "string" || !value.length || value.length > max || /[\s\u0000-\u001f\u007f]/u.test(value)) fail(`invalid_${name}`);
  return value;
}

/** Prepare once OUTSIDE the retrying CAS mutator, after verified authentication. */
export function prepareIdempotentCommand({ tenantId, principalId, key, command, requestId, now }) {
  identifier(tenantId, "tenant");
  identifier(principalId, "principal");
  identifier(key, "idempotency_key", 200);
  identifier(requestId, "request_id");
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) fail("invalid_server_time", 500);
  if (!record(command)) fail("invalid_command");
  const canonical = canonicalCommandJson(command);
  const prepared = freeze({
    tenantId, principalId, requestId, now,
    ledgerKey: hash(JSON.stringify([tenantId, principalId, key])),
    requestHash: hash(canonical),
    command: JSON.parse(canonical),
  });
  preparedCommands.add(prepared);
  return prepared;
}

function assertCore(data) {
  if (!record(data) || !record(data.entities)) fail("core_invalid", 503);
  const automation = data.automation;
  if (!record(automation) || automation.schemaVersion !== 3
    || !Number.isSafeInteger(automation.dataRevision) || automation.dataRevision < 0
    || !record(automation.idempotencyByKey)) fail("automation_not_ready", 503);
  return automation;
}

function replayReceipt(receipt, prepared) {
  if (!record(receipt) || receipt.schemaVersion !== 3 || receipt.tenantId !== prepared.tenantId
    || receipt.principalId !== prepared.principalId || typeof receipt.requestHash !== "string") fail("idempotency_ledger_invalid", 503);
  if (receipt.requestHash !== prepared.requestHash) fail("idempotency_conflict", 409);
  // A compact archive marker must remain discoverable. Never prune a key and
  // reinterpret an old operation as new. Archive lookup may replace this denial.
  if (receipt.state === "archived") fail("replay_too_old", 409);
  const recordedAt = Date.parse(receipt.recordedAt);
  const age = Date.parse(prepared.now) - recordedAt;
  if (!Number.isFinite(recordedAt) || age < 0 || receipt.state !== "committed"
    || !record(receipt.response) || receipt.response.ok !== true
    || receipt.response.replayed !== false || receipt.response.serverNow !== receipt.recordedAt
    || !Number.isSafeInteger(receipt.response.dataRevision) || receipt.response.dataRevision < 1
    || typeof receipt.response.requestId !== "string") fail("idempotency_ledger_invalid", 503);
  if (age >= IDEMPOTENCY_RETENTION_MS) fail("replay_too_old", 409);
  return { ...structuredClone(receipt.response), replayed: true };
}

/**
 * Synchronous, no I/O. Authentication, current object authorization, schema,
 * policy and lease checks remain mandatory in the command service on EVERY call.
 * applyCommand receives a private snapshot and stable context. It returns
 * { data, result }. Domain versions belong to the domain reducer; the global
 * revision and immutable receipt are committed here together with its mutation.
 */
export function applyIdempotentCommand(current, prepared, applyCommand) {
  if (!preparedCommands.has(prepared) || typeof applyCommand !== "function") fail("invalid_transaction_context", 500);
  const automation = assertCore(current);
  const ledger = automation.idempotencyByKey;
  if (Object.hasOwn(ledger, prepared.ledgerKey)) {
    return { data: current, result: replayReceipt(ledger[prepared.ledgerKey], prepared), unchanged: true };
  }
  if (automation.dataRevision === Number.MAX_SAFE_INTEGER) fail("revision_exhausted", 503);
  const beforeLedger = JSON.stringify(ledger);
  const reduced = applyCommand(structuredClone(current), prepared.command, prepared);
  if (reduced && typeof reduced.then === "function") {
    // An accidentally async reducer still must not create an unhandled rejection.
    Promise.resolve(reduced).catch(() => {});
    fail("async_command_reducer", 500);
  }
  if (!record(reduced) || !record(reduced.result)) fail("command_result_invalid", 500);
  const next = assertCore(reduced.data);
  if (![automation.dataRevision, automation.dataRevision + 1].includes(next.dataRevision)
    || JSON.stringify(next.idempotencyByKey) !== beforeLedger) fail("command_ledger_modified", 500);
  if (Object.keys(reduced.result).some((key) => reservedResponseKeys.has(key))) fail("command_result_reserved_field", 500);
  canonicalCommandJson(reduced.result);
  next.dataRevision = automation.dataRevision + 1;
  const response = {
    ...structuredClone(reduced.result),
    ok: true, replayed: false, serverNow: prepared.now,
    dataRevision: next.dataRevision, requestId: prepared.requestId,
  };
  next.idempotencyByKey[prepared.ledgerKey] = {
    schemaVersion: 3, state: "committed", tenantId: prepared.tenantId,
    principalId: prepared.principalId, requestHash: prepared.requestHash,
    recordedAt: prepared.now, response: structuredClone(response),
  };
  return { data: reduced.data, result: response };
}
