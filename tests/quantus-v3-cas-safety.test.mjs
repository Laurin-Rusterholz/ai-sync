import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { classifyBlobKey, firebaseNodeKey } from "../netlify/lib/blob-key-policy.mjs";
import { applyInvite, sanitizeInvite, validateInvite } from "../netlify/lib/date-invite-core.mjs";
import { mergeInquiryTasks } from "../netlify/lib/flowertech-core.mjs";

// Execute the production function with only the Firebase transport replaced.
const source = readFileSync(new URL("../netlify/lib/firebase-admin.mjs", import.meta.url), "utf8");
function functionSource(start) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1);
  return source.slice(from, source.indexOf("\n}\n", from) + 3).replace(/^export /, "");
}
const makeMutator = new Function(
  "firebaseDbGetWithEtag", "firebaseDbSet", "classifyBlobKey", "appStorePath", "jsonEtag",
  `${functionSource("function unwrapData(")}\n${functionSource("export async function mutateAppData(")}\nreturn mutateAppData;`,
);
const core = () => ({ entities: { tasks: {}, chatgptLeads: {} }, customArea: { preserved: true }, _deleteLog: { gone: "2026-09-19" } });
const wrap = (data) => ({ data: JSON.stringify(data), etag: "old-logical", extension: { keep: true } });
function harness(value = wrap(core()), { serverEtag = '"srv-1"', conflicts = 0, unknown = false, transportError = false, onConflict } = {}) {
  const log = { reads: 0, writes: [] };
  let stored = structuredClone(value);
  const mutate = makeMutator(
    async () => { log.reads++; return { value: structuredClone(stored), serverEtag: serverEtag && `${serverEtag}:${log.reads}` }; },
    async (path, data, options) => {
      log.writes.push({ path, data: structuredClone(data), options });
      if (transportError) throw new Error("response lost");
      if (unknown) return { ok: false };
      if (log.writes.length <= conflicts) {
        if (onConflict) stored = onConflict(stored);
        return { ok: false, conflict: true };
      }
      stored = structuredClone(data);
      return { ok: true };
    },
    classifyBlobKey,
    (key) => `appStore/${firebaseNodeKey(key)}`,
    (text) => createHash("sha256").update(text).digest("hex"),
  );
  return { mutate, log, stored: () => stored };
}

for (const [name, value] of [
  ["missing wrapper", null], ["unreadable wrapper", { unexpected: true }],
  ["invalid JSON", { data: "{broken" }], ["empty text", { data: "" }],
  ["JSON null", wrap(null)], ["array root", wrap([])], ["scalar root", wrap("old")],
  ["missing entities", wrap({ meta: {} })], ["array entities", wrap({ entities: [] })],
]) {
  test(`T07: ${name} never reaches a mutator or write`, async () => {
    const h = harness(value);
    let calls = 0;
    await assert.rejects(h.mutate("app-data.json", () => { calls++; return core(); }), { status: 503 });
    assert.equal(calls, 0);
    assert.equal(h.log.writes.length, 0);
  });
}

test("core aliases cannot create a missing core", async () => {
  for (const key of ["app-data_json", "app-data#json", "app-data/json"]) {
    const h = harness(null);
    await assert.rejects(h.mutate(key, () => core()), { code: "core_unavailable" });
    assert.equal(h.log.writes.length, 0);
  }
});

test("a denied key is rejected before any transport", async () => {
  const h = harness();
  await assert.rejects(h.mutate("arbitrary-private-key", () => core()), { code: "key_denied", status: 403 });
  assert.equal(h.log.reads, 0);
});

test("missing server ETag cannot become an unconditional PUT", async () => {
  const h = harness(wrap(core()), { serverEtag: null });
  await assert.rejects(h.mutate("app-data.json", (d) => d), { code: "cas_etag_missing" });
  assert.equal(h.log.writes.length, 0);
});

test("a synchronous mutation preserves wrappers, unknown data and tombstones", async () => {
  const h = harness();
  const result = await h.mutate("app-data.json", (d) => {
    d.entities.tasks.fixed = { id: "fixed" };
    return { data: d, result: { taskId: "fixed" } };
  }, { savedBy: "test-worker" });
  assert.deepEqual(result.result, { taskId: "fixed" });
  assert.deepEqual(result.data.customArea, { preserved: true });
  assert.deepEqual(result.data._deleteLog, { gone: "2026-09-19" });
  assert.deepEqual(h.stored().extension, { keep: true });
  assert.equal(typeof h.stored().data, "string");
  assert.equal(h.stored().savedBy, "test-worker");
  assert.equal(h.log.writes[0].path, "appStore/app-data_json");
  assert.equal(h.log.writes[0].options.ifMatch, '"srv-1":1');
});

test("CAS conflict rereads and preserves a concurrent user answer", async () => {
  const h = harness(wrap(core()), {
    conflicts: 1,
    onConflict: (previous) => {
      const d = JSON.parse(previous.data);
      d.automation = { answersById: { answer1: { id: "answer1", text: "user answer" } } };
      return { ...previous, data: JSON.stringify(d), concurrentWrapperField: "keep" };
    },
  });
  let calls = 0;
  await h.mutate("app-data.json", (d) => {
    calls++;
    d.entities.tasks.fixed = { id: "fixed" };
    return d;
  });
  assert.equal(calls, 2);
  assert.equal(h.log.reads, 2);
  assert.equal(h.log.writes[1].options.ifMatch, '"srv-1":2');
  const saved = JSON.parse(h.stored().data);
  assert.equal(saved.automation.answersById.answer1.text, "user answer");
  assert.deepEqual(Object.keys(saved.entities.tasks), ["fixed"]);
  assert.equal(h.stored().concurrentWrapperField, "keep");
  assert.equal(h.log.writes[0].data.savedAt, h.log.writes[1].data.savedAt);
  assert.equal(h.log.writes[0].data.updatedAt, h.log.writes[1].data.updatedAt);
});

test("core becoming corrupt during CAS aborts instead of rebuilding", async () => {
  const h = harness(wrap(core()), { conflicts: 1, onConflict: () => ({ data: "{bad" }) });
  let calls = 0;
  await assert.rejects(h.mutate("app-data.json", (d) => { calls++; return d; }), { code: "core_invalid" });
  assert.equal(calls, 1);
  assert.equal(h.log.writes.length, 1);
});

test("T06 storage portion: eight conflicts return a visible 503", async () => {
  const h = harness(wrap(core()), { conflicts: 20 });
  await assert.rejects(h.mutate("app-data.json", (d) => d), { code: "cas_exhausted", status: 503 });
  assert.equal(h.log.reads, 8);
  assert.equal(h.log.writes.length, 8);
  assert.ok(h.log.writes.every((w) => w.options.ifMatch));
});

for (const options of [{ unknown: true }, { transportError: true }]) {
  test(`ambiguous write outcome is not automatically retried: ${JSON.stringify(options)}`, async () => {
    const h = harness(wrap(core()), options);
    await assert.rejects(h.mutate("app-data.json", (d) => d));
    assert.equal(h.log.writes.length, 1);
  });
}

test("async mutators cannot accidentally persist a Promise as an empty core", async () => {
  const h = harness();
  await assert.rejects(h.mutate("app-data.json", async (d) => d), { code: "async_mutator" });
  assert.equal(h.log.writes.length, 0);
});

for (const result of [null, [], {}, { entities: [] }, { data: null }, { data: {} }]) {
  test(`invalid mutation output is rejected: ${JSON.stringify(result)}`, async () => {
    const h = harness();
    await assert.rejects(h.mutate("app-data.json", () => result), { code: "mutation_invalid" });
    assert.equal(h.log.writes.length, 0);
  });
}

test("date invitation retries use caller-allocated identity and time", async () => {
  const h = harness(wrap(core()), { conflicts: 1 });
  const opts = { id: "stable-invite", now: "2026-09-19T21:00:00.000Z" };
  const invite = { name: "Example", date: "2026-10-10", time: "14:00", note: "" };
  await h.mutate("app-data.json", (d) => {
    const applied = applyInvite(d, invite, opts);
    return { data: applied.data, result: applied.task };
  });
  for (const write of h.log.writes) {
    const data = JSON.parse(write.data.data);
    assert.deepEqual(Object.keys(data.entities.tasks), [opts.id]);
    assert.equal(data.meta.updatedAt, opts.now);
    assert.equal(data.entities.tasks[opts.id].createdAt, opts.now);
  }
});

test("known side documents retain their separate creation contract", async () => {
  const h = harness(null);
  await h.mutate("recalllab-mobile.json", () => ({ cards: [] }));
  assert.equal(h.log.writes.length, 1);
  assert.deepEqual(JSON.parse(h.stored().data), { cards: [] });
});

function productionHandler(file, dependencies) {
  const handlerSource = readFileSync(new URL(`../netlify/functions/${file}`, import.meta.url), "utf8")
    .replace(/^import .*$/gm, "")
    .replace(/^export const config = .*$/gm, "")
    .replace(/^export default /m, "const handler = ");
  return new Function(...Object.keys(dependencies), `${handlerSource}\nreturn handler;`)(...Object.values(dependencies));
}

test("date-invite HTTP handler fixes identity/time outside the retried mutator", async () => {
  let allocations = 0;
  const attempts = [];
  const handler = productionHandler("date-invite.mjs", {
    sanitizeInvite, validateInvite, applyInvite,
    randomUUID: () => `id-${++allocations}`,
    Netlify: { env: { get: () => null } },
    mutateAppData: async (_key, mutate) => {
      attempts.push(mutate(core()));
      attempts.push(mutate(core()));
      return attempts[1];
    },
  });
  const response = await handler(new Request("https://example.invalid/date-invite", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Example", date: "2026-10-10", time: "14:00", note: "" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(allocations, 1);
  assert.deepEqual(attempts[0], attempts[1]);
});

test("FlowerTech reports the committed attempt, not abandoned retry work", async () => {
  const results = [];
  const inquiry = { id: "inq1", name: "Example", createdAt: "2026-09-19T10:00:00.000Z" };
  const handler = productionHandler("flowertech-sync.mjs", {
    mergeInquiryTasks,
    Netlify: { env: { get: () => null } },
    firebaseDbGet: async (path) => path.endsWith("inquiries") ? { inq1: inquiry } : {},
    mutateAppData: async (_key, mutate) => {
      results.push(mutate(core()));
      const concurrent = core();
      concurrent.entities.tasks.existing = { id: "existing", sourceInquiryId: "inq1" };
      results.push(mutate(concurrent));
      return results[1];
    },
  });
  const response = await handler(new Request("https://example.invalid/flowertech-sync", { method: "POST" }));
  assert.equal(response.status, 200);
  assert.equal(results[0].result, 1);
  assert.equal(results[1].result, 0);
  assert.equal((await response.json()).createdTasks, 0);
  assert.equal(results[0].data.meta.updatedAt, results[1].data.meta.updatedAt);
});

test("legacy HTTP mutators surface storage unavailability as 503", async () => {
  const unavailable = async () => { throw Object.assign(new Error("Unavailable"), { code: "core_invalid", status: 503 }); };
  const dependencies = {
    sanitizeInvite, validateInvite, applyInvite, mergeInquiryTasks,
    randomUUID: () => "fixed", Netlify: { env: { get: () => null } },
    firebaseDbGet: async () => ({}), mutateAppData: unavailable,
  };
  for (const file of ["date-invite.mjs", "flowertech-sync.mjs"]) {
    const handler = productionHandler(file, dependencies);
    const response = await handler(new Request("https://example.invalid/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Example", date: "2026-10-10", time: "14:00", note: "" }),
    }));
    assert.equal(response.status, 503, file);
    assert.equal((await response.json()).code, "core_invalid");
  }
});
