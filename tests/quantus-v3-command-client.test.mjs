import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { openCommandQueue, createCommandTransport, serializeCommand, COMMAND_VERBS } from "../public/quantus-v3-command-client.mjs";
import { prepareIdempotentCommand, applyIdempotentCommand } from "../netlify/lib/quantus-v3-idempotency.mjs";

const ORIGIN = "https://quantus.example";
const accountKey = "firebase-user-1";
const command = () => ({ schemaVersion: 3, verb: "lead.comment", jobId: "job_20260920_42", expectedEntityVersion: 17,
  payload: { leadId: "lead_123", text: "Ergebnis verknuepft.", evidenceRefs: ["artifact_456"] } });
const input = (operationId = "q3-comment-1") => ({ accountKey, operationId, command: command() });
const receipt = (extra = {}) => ({ ok: true, replayed: false, serverNow: "2026-09-19T10:00:00.000Z", dataRevision: 4,
  requestId: "server-request-1", entityVersions: { lead_123: 18 }, ...extra });
const response = (body = receipt(), status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

async function setup(t, { indexedDB = new IDBFactory(), databaseName = "queue", writesEnabled = true,
  fetchImpl = async () => response(), getAuth = async () => ({ accountKey, idToken: "fresh-user-id-token" }) } = {}) {
  let now = Date.parse("2026-09-19T10:00:00.000Z");
  const queue = await openCommandQueue({ indexedDB, databaseName, now: () => now });
  t.after(() => queue.close());
  const transport = createCommandTransport({ origin: ORIGIN, getAuth, writesEnabled, fetchImpl, now: () => now });
  return { queue, transport, indexedDB, advance: (ms) => { now += ms; }, now: () => now };
}

test("the public envelope preserves the exact PDF example and all 22 verbs", () => {
  assert.equal(COMMAND_VERBS.length, 22);
  assert.deepEqual(JSON.parse(serializeCommand(command())), command());
  for (const verb of COMMAND_VERBS) assert.equal(JSON.parse(serializeCommand({ ...command(), verb })).verb, verb);
});

for (const change of [
  { actor: "admin" }, { tenant: "another-tenant" }, { now: 17 }, { path: "appStore/core" },
  { schemaVersion: 2 }, { verb: "root.patch" }, { expectedEntityVersion: -1 },
  { expectedEntityVersion: "17" }, { jobId: "" }, { payload: [] },
]) {
  test(`invalid envelope rejected before persistence: ${JSON.stringify(change)}`, () => {
    assert.throws(() => serializeCommand({ ...command(), ...change }));
  });
}

test("ambiguous JSON, accessors and oversized multibyte payloads are rejected", () => {
  for (const value of [undefined, NaN, Infinity, new Date(), () => {}, { constructor: "x" }, [undefined]]) {
    assert.throws(() => serializeCommand({ ...command(), payload: { value } }));
  }
  const getter = { get text() { throw new Error("must-not-run"); } };
  assert.throws(() => serializeCommand({ ...command(), payload: getter }), { code: "invalid_json" });
  assert.throws(() => serializeCommand({ ...command(), payload: { text: "\u00fc".repeat(40_000) } }), { code: "payload_too_large" });
});

test("operation is durable across connections and does not keep a live object reference", async (t) => {
  const h = await setup(t);
  const original = input();
  await h.queue.enqueue(original);
  original.command.payload.text = "changed after enqueue";
  h.queue.close();
  const reopened = await openCommandQueue({ indexedDB: h.indexedDB, databaseName: "queue", now: h.now });
  t.after(() => reopened.close());
  assert.equal((await reopened.list(accountKey))[0].command.payload.text, command().payload.text);
  assert.equal((await reopened.list(accountKey))[0].status, "pending");
});

test("concurrent enqueue is atomic and changed-body key reuse never overwrites intent", async (t) => {
  const h = await setup(t);
  const other = await openCommandQueue({ indexedDB: h.indexedDB, databaseName: "queue", now: h.now });
  t.after(() => other.close());
  const results = await Promise.all([h.queue.enqueue(input()), other.enqueue(input())]);
  assert.equal(results[0].canonical, results[1].canonical);
  assert.equal((await other.list(accountKey)).length, 1);
  await assert.rejects(other.enqueue({ ...input(), command: { ...command(), expectedEntityVersion: 18 } }), { code: "operation_id_conflict" });
  assert.equal((await other.list(accountKey))[0].command.expectedEntityVersion, 17);
});

test("default writes-disabled state does not authenticate, send or consume attempts", async (t) => {
  let called = false;
  const h = await setup(t, { writesEnabled: false, getAuth: async () => { called = true; throw new Error(); } });
  await h.queue.enqueue(input());
  const result = await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal(result.paused, true);
  assert.equal(called, false);
  assert.equal((await h.queue.list(accountKey))[0].attempts, 0);
  const unconfigured = createCommandTransport({ origin: ORIGIN, getAuth: async () => { throw new Error(); } });
  assert.equal((await unconfigured.send(input())).code, "writes_disabled");
});

test("send uses only user token, fixed endpoint and unchanged operation id", async (t) => {
  let sent;
  const h = await setup(t, { fetchImpl: async (url, options) => { sent = { url, options }; return response(); } });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal(sent.url, ORIGIN + "/.netlify/functions/quantus-ingest");
  assert.equal(sent.options.headers["Idempotency-Key"], input().operationId);
  assert.equal(sent.options.redirect, "error");
  assert.equal(sent.options.credentials, "omit");
  assert.deepEqual(JSON.parse(sent.options.body), command());
  assert.deepEqual(await h.queue.list(accountKey), []);
  const saved = (await h.queue.list(accountKey, { includeAcknowledged: true }))[0];
  assert.equal(saved.status, "acknowledged");
  assert.equal(saved.receipt.requestId, "server-request-1");
  assert.ok(!JSON.stringify(saved).includes("fresh-user-id-token"), "tokens are never persisted with intents or receipts");
});

test("logout/account switch cannot dispatch another user's pending operation", async (t) => {
  let sends = 0;
  const h = await setup(t, { getAuth: async () => ({ accountKey: "other-user", idToken: "another-token" }),
    fetchImpl: async () => { sends += 1; return response(); } });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal(sends, 0);
  assert.equal((await h.queue.list(accountKey))[0].status, "needs_sign_in");
  assert.deepEqual(await h.queue.list("other-user"), []);
});

for (const [name, body, status] of [
  ["dry-run receipt", receipt({ applied: false, dryRun: true }), 200],
  ["explicit not-applied receipt", receipt({ applied: false }), 200],
  ["server write gate", { ok: false, error: "api_writes_disabled" }, 503],
]) {
  test(`${name} retains durable pending intent until a real commit`, async (t) => {
    let enabled = false;
    const sentIds = [];
    const h = await setup(t, { fetchImpl: async (_, options) => {
      sentIds.push(options.headers["Idempotency-Key"]);
      return enabled ? response(receipt({ applied: true, dryRun: false })) : response(body, status);
    } });
    await h.queue.enqueue(input());
    const result = await h.queue.drain(accountKey, { transport: h.transport });
    assert.equal(result.paused, true);
    const pending = (await h.queue.list(accountKey))[0];
    assert.equal(pending.status, "pending");
    assert.equal(pending.attempts, 0);
    assert.equal(pending.receipt, undefined);
    h.queue.close();
    const reopened = await openCommandQueue({ indexedDB: h.indexedDB, databaseName: "queue", now: h.now });
    t.after(() => reopened.close());
    assert.deepEqual((await reopened.list(accountKey))[0], pending);
    enabled = true;
    await reopened.drain(accountKey, { transport: h.transport });
    assert.equal((await reopened.list(accountKey, { includeAcknowledged: true }))[0].status, "acknowledged");
    assert.deepEqual(sentIds, [input().operationId, input().operationId]);
  });
}

test("a custom transport cannot save a dry-run as a receipt, and malformed flags are rejected", async (t) => {
  const h = await setup(t, { fetchImpl: async () => response(receipt({ applied: "true", dryRun: "false" })) });
  assert.equal((await h.transport.send(input())).code, "receipt_invalid");
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: { send: async () => ({ ok: true, receipt: receipt({ applied: false, dryRun: true }) }) } });
  assert.equal((await h.queue.list(accountKey))[0].status, "needs_review");
});

for (const [status, expected] of [[400, "needs_review"], [401, "needs_sign_in"], [403, "needs_review"], [409, "conflict"], [426, "upgrade_required"]]) {
  test(`HTTP ${status} retains original action as ${expected}, never rebases`, async (t) => {
    let calls = 0;
    const h = await setup(t, { fetchImpl: async () => { calls += 1; return response({ error: "server_rejection" }, status); } });
    await h.queue.enqueue(input());
    await h.queue.drain(accountKey, { transport: h.transport });
    await h.queue.drain(accountKey, { transport: h.transport });
    const saved = (await h.queue.list(accountKey))[0];
    assert.equal(saved.status, expected);
    assert.deepEqual(saved.command, command());
    assert.equal(calls, 1);
  });
}

test("429 respects Retry-After and repeated transient failure stops after five attempts", async (t) => {
  let calls = 0;
  const h = await setup(t, { fetchImpl: async () => { calls += 1; return response({ error: "rate_limited" }, 429, { "Retry-After": "120" }); } });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  h.advance(60_000);
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal(calls, 1);
  for (let n = 0; n < 10; n += 1) { h.advance(600_000); await h.queue.drain(accountKey, { transport: h.transport }); }
  assert.equal(calls, 5);
  assert.equal((await h.queue.list(accountKey))[0].status, "needs_review");
});

test("HTTP-date Retry-After is respected without using device date as conflict authority", async (t) => {
  let calls = 0;
  const h = await setup(t, { fetchImpl: async () => { calls += 1; return response({}, 429, { "Retry-After": "Sat, 19 Sep 2026 10:02:00 GMT" }); } });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  h.advance(119_000);
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal(calls, 1);
  h.advance(1000);
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal(calls, 2);
});

test("overflowing Retry-After holds for review instead of retrying before the server permits", async (t) => {
  const h = await setup(t, { fetchImpl: async () => response({}, 429, { "Retry-After": "99999999999999999999999999" }) });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal((await h.queue.list(accountKey))[0].status, "needs_review");
});

test("sign-in recovery resumes only that account's auth-held operations with the same key", async (t) => {
  let signedIn = false;
  const h = await setup(t, { getAuth: async () => signedIn ? { accountKey, idToken: "new-token" } : null });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal((await h.queue.list(accountKey))[0].status, "needs_sign_in");
  assert.equal(await h.queue.resumeAfterSignIn("other-user"), 0);
  signedIn = true;
  assert.equal(await h.queue.resumeAfterSignIn(accountKey), 1);
  await h.queue.drain(accountKey, { transport: h.transport });
  const saved = (await h.queue.list(accountKey, { includeAcknowledged: true }))[0];
  assert.equal(saved.status, "acknowledged");
  assert.equal(saved.operationId, input().operationId);
  assert.deepEqual(saved.command, command());
});

test("lost HTTP response replays the existing server receipt and cannot duplicate the domain action", async (t) => {
  let data = { entities: { chatgptLeads: { lead_123: { version: 17, comments: [] } } },
    automation: { schemaVersion: 3, dataRevision: 1, idempotencyByKey: {} } };
  let calls = 0;
  const keys = [];
  const h = await setup(t, { fetchImpl: async (_, options) => {
    calls += 1;
    keys.push(options.headers["Idempotency-Key"]);
    const prepared = prepareIdempotentCommand({ tenantId: "tenant-1", principalId: accountKey, key: keys.at(-1),
      command: JSON.parse(options.body), requestId: `server-${calls}`, now: "2026-09-19T10:00:00.000Z" });
    const committed = applyIdempotentCommand(data, prepared, (snapshot, action) => {
      const lead = snapshot.entities.chatgptLeads.lead_123;
      assert.equal(lead.version, action.expectedEntityVersion);
      lead.comments.push(action.payload.text);
      lead.version += 1;
      return { data: snapshot, result: { entityVersions: { lead_123: lead.version } } };
    });
    data = committed.data;
    if (calls === 1) throw new Error("response lost after commit");
    return response(committed.result);
  } });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  const first = (await h.queue.list(accountKey))[0];
  assert.equal(first.lastError.uncertain, true);
  assert.equal(first.status, "retry_wait");
  h.advance(30_000);
  await h.queue.drain(accountKey, { transport: h.transport });
  const saved = (await h.queue.list(accountKey, { includeAcknowledged: true }))[0];
  assert.equal(saved.receipt.replayed, true);
  assert.equal(saved.receipt.requestId, "server-1");
  assert.equal(data.entities.chatgptLeads.lead_123.comments.length, 1);
  assert.deepEqual(keys, [input().operationId, input().operationId]);
});

test("late failure from another tab cannot downgrade an acknowledged intent", async (t) => {
  const h = await setup(t);
  const other = await openCommandQueue({ indexedDB: h.indexedDB, databaseName: "queue", now: h.now });
  t.after(() => other.close());
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const delayed = createCommandTransport({ origin: ORIGIN, writesEnabled: true, getAuth: async () => ({ accountKey, idToken: "token" }),
    fetchImpl: async () => { entered(); await new Promise((resolve) => { release = resolve; }); throw new Error("network lost"); } });
  await h.queue.enqueue(input());
  const first = other.drain(accountKey, { transport: delayed });
  await started;
  await h.queue.drain(accountKey, { transport: h.transport });
  release();
  await first;
  assert.equal((await other.list(accountKey, { includeAcknowledged: true }))[0].status, "acknowledged");
});

test("unmapped legacy operations stay visible and are never sent as root snapshots", async (t) => {
  let calls = 0;
  const h = await setup(t, { fetchImpl: async () => { calls += 1; return response(); } });
  const legacyOperation = { type: "old-edit", unknown: { text: "keep", _deleteLog: { task: { old: 42 } } } };
  await h.queue.retainLegacy({ accountKey, operationId: "legacy-1", legacyOperation });
  await h.queue.drain(accountKey, { transport: h.transport });
  const entry = (await h.queue.list(accountKey))[0];
  assert.equal(calls, 0);
  assert.equal(entry.status, "legacy_unmapped");
  assert.deepEqual(entry.legacyOperation, legacyOperation);
});

test("missing receipt metadata is not treated as confirmed persistence", async (t) => {
  const h = await setup(t, { fetchImpl: async () => response({ ok: true }) });
  await h.queue.enqueue(input());
  await h.queue.drain(accountKey, { transport: h.transport });
  assert.equal((await h.queue.list(accountKey))[0].status, "retry_wait");
  assert.equal((await h.queue.list(accountKey))[0].lastError.code, "receipt_invalid");
});

test("closed or missing IndexedDB never falls back to lossy memory/localStorage", async (t) => {
  const h = await setup(t);
  await h.queue.enqueue(input());
  h.queue.close();
  await assert.rejects(h.queue.enqueue(input("second")), { code: "durable_storage_unavailable" });
  await assert.rejects(openCommandQueue({ indexedDB: null }), { code: "durable_storage_unavailable" });
});

test("API origin cannot select arbitrary paths, plaintext transport or credentials", () => {
  for (const origin of ["http://quantus.example", "https://quantus.example/other", "https://user:pass@quantus.example", "https://quantus.example?x=1"]) {
    assert.throws(() => createCommandTransport({ origin, getAuth: () => {} }), { code: "invalid_api_origin" });
  }
});
