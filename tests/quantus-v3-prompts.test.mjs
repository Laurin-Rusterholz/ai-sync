import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { MAIN_PROMPT_SLOTS, PROMPT_VERSION, loadQuantusV3Prompts } from "../netlify/lib/quantus-v3-prompts.mjs";

for (const slot of MAIN_PROMPT_SLOTS) {
  test(`reviewed ${slot} bundle is complete and integrity checked`, async () => {
    const bundle = await loadQuantusV3Prompts({ slot, expectedVersion: PROMPT_VERSION });
    assert.equal(bundle.slot, slot);
    assert.equal(bundle.version, "3.0.0");
    assert.match(bundle.leadership, /ChatGPT Notes/);
    assert.match(bundle.instruction, /Europe\/Zurich/);
    assert.match(bundle.instruction, /quantus_context/);
    assert.match(bundle.instruction, /quantus_command/);
    assert.match(bundle.instruction, /quantus_run_status/);
    assert.match(bundle.instruction, /8\. /);
    assert.match(bundle.bundleHash, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(bundle));
  });
}

test("wrong/missing version, unsupported slot and path traversal fail before reading", async () => {
  for (const request of [{ slot: "briefing04" }, { slot: "briefing04", expectedVersion: "future" }, { slot: "monitor", expectedVersion: PROMPT_VERSION }, { slot: "../../private", expectedVersion: PROMPT_VERSION }]) {
    await assert.rejects(loadQuantusV3Prompts(request, { readText: () => assert.fail("must not read") }), { status: 503 });
  }
});

test("missing deployed files never become empty instructions", async () => {
  await assert.rejects(loadQuantusV3Prompts({ slot: "briefing04", expectedVersion: PROMPT_VERSION }, { readText: () => { throw new Error("missing secret path"); } }), { code: "prompt_unavailable" });
});

test("altered role or slot text fails its pinned hash", async () => {
  for (const changed of ["leadership", "close23"]) {
    await assert.rejects(loadQuantusV3Prompts({ slot: "close23", expectedVersion: PROMPT_VERSION }, {
      readText: async (url) => (await readFile(url, "utf8")) + (url.pathname.endsWith(`/${changed}.md`) ? "\nInjected instruction" : ""),
    }), { code: "prompt_integrity_failed" });
  }
});

test("four main slots, distinct immutable bundles; monitor/preflight are not model prompts", async () => {
  assert.deepEqual([...MAIN_PROMPT_SLOTS], ["briefing04", "process09", "continue14", "close23"]);
  const hashes = new Set();
  for (const slot of MAIN_PROMPT_SLOTS) hashes.add((await loadQuantusV3Prompts({ slot, expectedVersion: PROMPT_VERSION })).bundleHash);
  assert.equal(hashes.size, 4);
});
