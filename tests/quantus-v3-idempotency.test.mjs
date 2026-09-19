import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { classifyBlobKey, firebaseNodeKey } from "../netlify/lib/blob-key-policy.mjs";
import {
  canonicalCommandJson, prepareIdempotentCommand, applyIdempotentCommand,
  IDEMPOTENCY_RETENTION_MS,
} from "../netlify/lib/quantus-v3-idempotency.mjs";

const NOW = "2026-09-19T21:00:00.000Z";
const command = () => ({ schemaVersion: 3, verb: "lead.comment", expectedEntityVersion: 5, payload: { leadId: "lead_1", text: "Checked", evidenceRefs: ["proof_1"] } });
const core = () => ({
  entities: { chatgptLeads: { lead_1: { id: "lead_1", version: 5, comments: [] } } },
  automation: { schemaVersion: 3, dataRevision: 10, idempotencyByKey: {}, outboxById: {} },
  futureArea: { preserve: true }, _deleteLog: { removed: "2026-09-18" },
});
const prepare = (overrides = {}) => prepareIdempotentCommand({ tenantId: "tenant_1", principalId: "lead-agent", key: "q3-comment-1", requestId: "req_1", now: NOW, command: command(), ...overrides });
function reducer(data, body, context) {
  const lead = data.entities.chatgptLeads[body.payload.leadId];
  if (lead.version !== body.expectedEntityVersion) throw Object.assign(new Error("stale"), { code: "stale_entity", status: 409 });
  lead.comments.push({ id: `comment_${context.ledgerKey}`, text: body.payload.text, createdAt: context.now });
  lead.version++;
  data.automation.outboxById[`outbox_${context.ledgerKey}`] = { state: "pending", leadId: lead.id };
  return { data, result: { entityId: lead.id, entityVersion: lead.version, entityVersions: { [lead.id]: lead.version } } };
}

// Real production CAS loop with a versioned in-memory transport. Two concurrent
// requests can read the same revision and only one conditional write succeeds.
const source = readFileSync(new URL("../netlify/lib/firebase-admin.mjs", import.meta.url), "utf8");
function functionSource(start) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1);
  return source.slice(from, source.indexOf("\n}\n", from) + 3).replace(/^export /, "");
}
const makeMutator = new Function("firebaseDbGetWithEtag", "firebaseDbSet", "classifyBlobKey", "appStorePath", "jsonEtag",
  `${functionSource("function unwrapData(")}\n${functionSource("export async function mutateAppData(")}\nreturn mutateAppData;`);
function database({ loseReply = false, alwaysConflict = false, value = core() } = {}) {
  let wrapper = value === null ? null : { data: JSON.stringify(value), etag: "initial", futureWrapper: "preserve" };
  let revision = 1;
  const stats = { reads: 0, attempts: 0, commits: 0 };
  const mutate = makeMutator(
    async () => { stats.reads++; return { value: structuredClone(wrapper), serverEtag: `"${revision}"` }; },
    async (_path, next, { ifMatch }) => {
      stats.attempts++;
      if (alwaysConflict || ifMatch !== `"${revision}"`) return { ok: false, conflict: true };
      wrapper = structuredClone(next); revision++; stats.commits++;
      if (loseReply) { loseReply = false; throw new Error("committed, reply lost"); }
      return { ok: true };
    }, classifyBlobKey, (key) => `appStore/${firebaseNodeKey(key)}`,
    (text) => createHash("sha256").update(text).digest("hex"),
  );
  return {
    stats, data: () => wrapper && JSON.parse(wrapper.data), wrapper: () => structuredClone(wrapper),
    mutate,
    run: (prepared, reduce = reducer) => mutate("app-data.json", (d) => applyIdempotentCommand(d, prepared, reduce)),
  };
}

test("canonical hash ignores object ordering, but never array ordering or content", () => {
  assert.equal(canonicalCommandJson({ b: 1, a: { y: 2, x: 3 } }), canonicalCommandJson({ a: { x: 3, y: 2 }, b: 1 }));
  assert.notEqual(canonicalCommandJson([1, 2]), canonicalCommandJson([2, 1]));
  assert.notEqual(prepare().requestHash, prepare({ command: { ...command(), payload: { ...command().payload, text: "Other" } } }).requestHash);
});

for (const [label, invalid] of [
  ["undefined", { x: undefined }], ["NaN", { x: NaN }], ["Infinity", { x: Infinity }],
  ["function", { x: () => 1 }], ["Date", { x: new Date(NOW) }], ["BigInt", { x: 1n }],
  ["sparse array", Array(2)], ["prototype key", JSON.parse('{"__proto__":{}}')],
  ["symbol", { [Symbol("hidden")]: 1 }], ["accessor", { get x() { throw new Error("must not execute"); } }],
]) {
  test(`non-JSON ${label} cannot acquire an ambiguous idempotency hash`, () => {
    assert.throws(() => canonicalCommandJson(invalid), { status: 400 });
  });
}

test("cycles, excessive nesting, and oversize payloads are rejected", () => {
  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get() { assert.fail("array accessor executed"); } });
  assert.throws(() => canonicalCommandJson(arrayAccessor), { code: "invalid_json_value" });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalCommandJson(cycle), { code: "invalid_json_value" });
  let deep = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.throws(() => canonicalCommandJson(deep), { code: "command_too_complex" });
  assert.throws(() => prepare({ command: { text: "x".repeat(65536) } }), { status: 413 });
});

test("prepared request is an immutable private snapshot with caller-allocated time", () => {
  const body = command();
  const prepared = prepare({ command: body });
  body.payload.text = "changed afterwards";
  assert.equal(prepared.command.payload.text, "Checked");
  assert.throws(() => { prepared.command.payload.text = "mutated"; }, TypeError);
  assert.equal(prepared.now, NOW);
  assert.throws(() => applyIdempotentCommand(core(), { ...prepared }, reducer), { code: "invalid_transaction_context" });
});

for (const overrides of [
  { key: "" }, { key: "has newline\n" }, { key: "x".repeat(201) }, { principalId: "" },
  { tenantId: "" }, { requestId: "" }, { now: "today" }, { now: "2026-09-19T21:00:00Z" },
]) {
  test(`invalid envelope ${Object.keys(overrides)} fails before a transaction`, () => {
    assert.throws(() => prepare(overrides));
  });
}

test("T04: mutation, dispatch intent and receipt share one atomic write", async () => {
  const db = database();
  const result = await db.run(prepare());
  const saved = db.data();
  assert.equal(db.stats.commits, 1);
  assert.equal(saved.entities.chatgptLeads.lead_1.comments.length, 1);
  assert.equal(Object.keys(saved.automation.outboxById).length, 1);
  assert.equal(Object.keys(saved.automation.idempotencyByKey).length, 1);
  assert.equal(saved.automation.dataRevision, 11);
  assert.equal(result.result.entityVersion, 6);
  assert.equal(result.result.serverNow, NOW);
  assert.equal(result.result.replayed, false);
  assert.deepEqual(saved.futureArea, core().futureArea);
  assert.deepEqual(saved._deleteLog, core()._deleteLog);
  assert.equal(db.wrapper().futureWrapper, "preserve");
});

test("T04: replay performs no reducer, outbox addition or Firebase PUT", async () => {
  const db = database();
  const first = await db.run(prepare());
  const wrapper = db.wrapper();
  const again = await db.run(prepare({ requestId: "new_http_request" }), () => assert.fail("reducer called again"));
  assert.deepEqual(again.result, { ...first.result, replayed: true });
  assert.equal(again.result.requestId, "req_1");
  assert.equal(db.stats.commits, 1);
  assert.equal(db.stats.attempts, 1);
  assert.deepEqual(db.wrapper(), wrapper);
});

test("T05: changed body with the same scoped key is a conflict, not a replay", async () => {
  const db = database(); await db.run(prepare());
  const body = command(); body.payload.text = "different";
  await assert.rejects(db.run(prepare({ command: body })), { status: 409, code: "idempotency_conflict" });
  assert.equal(db.stats.commits, 1);
});

test("T05: lost response after the write recovers the confirmed receipt without another write", async () => {
  const db = database({ loseReply: true });
  await assert.rejects(db.run(prepare()), /reply lost/);
  assert.equal(db.stats.commits, 1);
  const result = await db.run(prepare({ requestId: "retry_after_timeout" }));
  assert.equal(result.result.replayed, true);
  assert.equal(db.stats.commits, 1);
});

test("T04/T06: concurrent duplicate requests converge on one comment, receipt and outbox item", async () => {
  const db = database();
  const [a, b] = await Promise.all([db.run(prepare()), db.run(prepare({ requestId: "req_2" }))]);
  assert.equal(db.stats.commits, 1);
  assert.equal(db.stats.attempts, 2);
  assert.deepEqual([a.result.replayed, b.result.replayed].sort(), [false, true]);
  assert.equal(db.data().entities.chatgptLeads.lead_1.comments.length, 1);
  assert.equal(Object.keys(db.data().automation.outboxById).length, 1);
  assert.equal(db.data().automation.dataRevision, 11);
});

test("concurrent different keys still enforce domain expectedEntityVersion", async () => {
  const db = database();
  const results = await Promise.allSettled([db.run(prepare()), db.run(prepare({ key: "different" }))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "stale_entity");
  assert.equal(db.stats.commits, 1);
  assert.equal(Object.keys(db.data().automation.idempotencyByKey).length, 1);
});

test("a stale entity error does not reserve the key or advance global revision", async () => {
  const db = database(); const body = command(); body.expectedEntityVersion = 4;
  await assert.rejects(db.run(prepare({ command: body })), { status: 409, code: "stale_entity" });
  assert.equal(db.stats.commits, 0);
  assert.deepEqual(db.data(), core());
});

test("scope includes tenant and principal, so another identity cannot replay a result", () => {
  const first = prepare();
  assert.notEqual(first.ledgerKey, prepare({ tenantId: "other" }).ledgerKey);
  assert.notEqual(first.ledgerKey, prepare({ principalId: "other" }).ledgerKey);
  const committed = applyIdempotentCommand(core(), first, reducer).data;
  assert.throws(() => applyIdempotentCommand(committed, prepare({ principalId: "other" }), reducer), { code: "stale_entity" });
});

test("T06: eight CAS conflicts leave no committed receipt or action", async () => {
  const db = database({ alwaysConflict: true });
  const seen = [];
  await assert.rejects(db.run(prepare(), (d, c, p) => { seen.push([p.now, p.ledgerKey]); return reducer(d, c, p); }), { status: 503, code: "cas_exhausted" });
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen.map(JSON.stringify)).size, 1);
  assert.equal(db.stats.commits, 0);
  assert.deepEqual(db.data(), core());
});

test("T07: no missing, unmigrated or corrupt core is silently rebuilt", async () => {
  const db = database({ value: null });
  await assert.rejects(db.run(prepare()), { status: 503, code: "core_unavailable" });
  assert.equal(db.stats.attempts, 0);
  for (const value of [null, {}, { entities: {} }, { ...core(), automation: { schemaVersion: 2 } }, { ...core(), automation: { ...core().automation, idempotencyByKey: [] } }]) {
    assert.throws(() => applyIdempotentCommand(value, prepare(), reducer), { status: 503 });
  }
});

test("older than 60 days and archived records fail closed, never execute as new", () => {
  const prepared = prepare();
  const saved = applyIdempotentCommand(core(), prepared, reducer).data;
  const later = prepare({ now: new Date(Date.parse(NOW) + IDEMPOTENCY_RETENTION_MS).toISOString() });
  assert.throws(() => applyIdempotentCommand(saved, later, () => assert.fail("old replay executed")), { status: 409, code: "replay_too_old" });
  saved.automation.idempotencyByKey[prepared.ledgerKey].state = "archived";
  delete saved.automation.idempotencyByKey[prepared.ledgerKey].response;
  assert.throws(() => applyIdempotentCommand(saved, prepared, () => assert.fail("archive replay executed")), { code: "replay_too_old" });
});

test("corrupt receipt or a future receipt cannot masquerade as success", () => {
  const prepared = prepare();
  const saved = applyIdempotentCommand(core(), prepared, reducer).data;
  for (const patch of [{ response: null }, { principalId: "other" }, { state: "pending" }, { recordedAt: "invalid" }, { recordedAt: "2026-09-20T21:00:00.000Z" }]) {
    const copy = structuredClone(saved);
    Object.assign(copy.automation.idempotencyByKey[prepared.ledgerKey], patch);
    assert.throws(() => applyIdempotentCommand(copy, prepared, reducer), { status: 503, code: "idempotency_ledger_invalid" });
  }
});

test("returned responses cannot mutate the stored receipt", () => {
  const prepared = prepare();
  const first = applyIdempotentCommand(core(), prepared, reducer);
  first.result.entityVersions.lead_1 = 99;
  const replay = applyIdempotentCommand(first.data, prepared, reducer);
  assert.equal(replay.result.entityVersions.lead_1, 6);
  replay.result.entityVersions.lead_1 = 98;
  assert.equal(first.data.automation.idempotencyByKey[prepared.ledgerKey].response.entityVersions.lead_1, 6);
});

test("async reducers, response spoofing and ledger tampering cannot persist", () => {
  const prepared = prepare();
  assert.throws(() => applyIdempotentCommand(core(), prepared, async () => { throw new Error("async reducer"); }), { code: "async_command_reducer" });
  assert.throws(() => applyIdempotentCommand(core(), prepared, (data) => ({ data, result: { ok: true } })), { code: "command_result_reserved_field" });
  assert.throws(() => applyIdempotentCommand(core(), prepared, (data) => { data.automation.idempotencyByKey.fake = {}; return { data, result: {} }; }), { code: "command_ledger_modified" });
  assert.throws(() => applyIdempotentCommand(core(), prepared, (data) => { data.automation.dataRevision += 2; return { data, result: {} }; }), { code: "command_ledger_modified" });
  assert.throws(() => applyIdempotentCommand(core(), prepared, () => null), { code: "command_result_invalid" });
});

test("a reducer advancing global revision once does not cause a double increment", () => {
  const result = applyIdempotentCommand(core(), prepare(), (d, c, p) => { const r = reducer(d, c, p); r.data.automation.dataRevision++; return r; });
  assert.equal(result.data.automation.dataRevision, 11);
});

test("unchanged CAS result cannot conceal an in-place mutation", async () => {
  const db = database();
  await assert.rejects(db.mutate("app-data.json", (data) => { data.entities.hacked = {}; return { data, unchanged: true }; }), { status: 500, code: "unchanged_mutation_invalid" });
  assert.equal(db.stats.attempts, 0);
  assert.deepEqual(db.data(), core());
});

test("an async throwing storage mutator is rejected without an unhandled rejection or write", async () => {
  const db = database();
  await assert.rejects(db.mutate("app-data.json", async () => { throw new Error("async failure"); }), { code: "async_mutator" });
  assert.equal(db.stats.attempts, 0);
});
