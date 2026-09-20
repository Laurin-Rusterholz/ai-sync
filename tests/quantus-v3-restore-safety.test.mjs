import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fuehreRestoreAus, pruefeLegacyRestoreGrenze } from "../scripts/restore-core.mjs";
import { firebaseNodeKey, jsonEtag } from "../netlify/lib/firebase-admin.mjs";

const legacy = () => ({ entities: { tasks: { t1: { title: "Current" } } }, meta: { updatedAt: "2026-09-19T10:00:00.000Z" } });
const backupData = () => ({ entities: { tasks: { t1: { title: "Backup" } } }, meta: { updatedAt: "2026-09-18T10:00:00.000Z" } });
const modern = () => ({ ...legacy(), automation: { schemaVersion: 3, dataRevision: 10,
  idempotencyByKey: { prior: { state: "committed" } }, outbox: { sent: { state: "sent" } } } });
const wrap = (data) => data === null ? null : ({ data: JSON.stringify(data), etag: jsonEtag(JSON.stringify(data)), extension: { keep: true } });

async function run(t, { backup = backupData(), current = legacy(), serverEtag = '"server-1"', duringConfirmation,
  dryRun = false, malformedDocument } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quantus-v3-restore-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let stored = wrap(current);
  let currentEtag = serverEtag;
  const attempts = [];
  let confirmations = 0;
  const result = await fuehreRestoreAus({ from: "fixture.json", key: "app-data.json", confirmed: true, dryRun }, {
    readFile: async () => JSON.stringify({ tool: "backup-blob", key: "app-data.json", data: backup }),
    readAppDataDocument: async () => malformedDocument || {
      exists: stored !== null, data: stored?.data ?? null, parsed: stored ? JSON.parse(stored.data) : null,
      etag: stored?.etag ?? null, wrap: structuredClone(stored), serverEtag: currentEtag,
    },
    firebaseDbSet: async (target, value, options) => {
      attempts.push({ target, value, options });
      if (!options?.ifMatch || options.ifMatch !== currentEtag) return { ok: false, conflict: true };
      stored = structuredClone(value);
      currentEtag = '"server-next"';
      return { ok: true, conflict: false };
    },
    firebaseNodeKey, jsonEtag, fsApi: fs, logDir: dir,
    frage: async () => {
      confirmations += 1;
      if (duringConfirmation) {
        stored = wrap(duringConfirmation());
        currentEtag = '"concurrent-writer"';
      }
      return "app-data.json";
    },
  });
  const files = await fs.readdir(dir);
  const audits = [];
  for (const name of files.filter((name) => name.endsWith(".restore.json"))) audits.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
  return { result, attempts, confirmations, stored, files, audits };
}

test("legacy restore remains available and preserves wrapper extension fields", async (t) => {
  const h = await run(t);
  assert.equal(h.result.ok, true);
  assert.equal(h.result.geschrieben, true);
  assert.equal(h.attempts.length, 1);
  assert.deepEqual(h.attempts[0].options, { ifMatch: '"server-1"' });
  assert.deepEqual(h.stored.extension, { keep: true });
  assert.deepEqual(JSON.parse(h.stored.data), backupData());
  assert.equal(h.audits[0].serverEtagVorher, '"server-1"');
  assert.equal(h.audits[0].status, "erfolgreich");
  assert.ok(!h.files.includes("restore-core.lock"));
});

test("legacy missing-core recovery uses the server's absent-node precondition", async (t) => {
  const h = await run(t, { current: null, serverEtag: '"null_etag"' });
  assert.equal(h.result.ok, true);
  assert.deepEqual(h.attempts[0].options, { ifMatch: '"null_etag"' });
});

test("v3 backup is rejected before reading the target or creating an intent", async (t) => {
  const h = await run(t, { backup: modern() });
  assert.equal(h.result.code, "v3_restore_requires_reconciliation");
  assert.equal(h.result.ok, false);
  assert.equal(h.confirmations, 0);
  assert.equal(h.attempts.length, 0);
  assert.deepEqual(h.files, []);
});

test("legacy backup cannot downgrade a currently migrated v3 core", async (t) => {
  const h = await run(t, { current: modern() });
  assert.equal(h.result.code, "v3_restore_requires_reconciliation");
  assert.equal(h.confirmations, 0);
  assert.equal(h.attempts.length, 0);
  assert.deepEqual(JSON.parse(h.stored.data), modern());
  assert.deepEqual(h.files, []);
});

for (const [name, change] of [
  ["new v3 state", modern],
  ["new legacy edit", () => ({ ...legacy(), extra: "newer work" })],
]) {
  test(`concurrent ${name} during operator confirmation is not overwritten`, async (t) => {
    const h = await run(t, { duringConfirmation: change });
    assert.equal(h.result.ok, false);
    assert.equal(h.result.geschrieben, false);
    assert.equal(h.result.schritt, "konflikt");
    assert.equal(h.attempts.length, 1, "a conflict must not retry a previously approved full snapshot");
    assert.deepEqual(JSON.parse(h.stored.data), change());
    assert.equal(h.audits[0].status, "fehlgeschlagen");
    assert.equal(h.audits[0].ergebnis.conflict, true);
    assert.equal(h.audits[0].ergebnis.etagNachher, null);
    assert.ok(!h.files.includes("restore-core.lock"));
  });
}

test("a missing core recreated during confirmation is not overwritten", async (t) => {
  const h = await run(t, { current: null, serverEtag: '"null_etag"', duringConfirmation: modern });
  assert.equal(h.result.schritt, "konflikt");
  assert.equal(h.result.geschrieben, false);
  assert.deepEqual(JSON.parse(h.stored.data), modern());
});

for (const serverEtag of [null, 0, "", " ", "*", " * "]) {
  test(`missing, non-string or wildcard server precondition ${JSON.stringify(serverEtag)} is denied`, async (t) => {
    const h = await run(t, { serverEtag });
    assert.equal(h.result.code, "restore_precondition_missing");
    assert.equal(h.confirmations, 0);
    assert.equal(h.attempts.length, 0);
    assert.deepEqual(h.files, []);
  });
}

for (const partial of [
  { automation: { schemaVersion: 4 } },
  { automation: { schemaVersion: "3" } },
  { automation: { dataRevision: 5 } },
  { automation: { idempotencyByKey: {} } },
  { automation: { activeLease: null } },
  { automation: [] },
  { automation: null },
  { dailyBriefing: { assistantRuns: {} } },
]) {
  test(`partial or future v3 state stays protected: ${JSON.stringify(partial)}`, () => {
    assert.equal(pruefeLegacyRestoreGrenze({ ...legacy(), ...partial }).ok, false);
  });
}

for (const field of [
  "intakeById", "questionsById", "answersById", "documentsById", "jobsById",
  "outboxById", "evidenceById", "progressById", "waitingById", "sourceCursors",
  "policyRef", "runtime",
]) {
  for (const side of ["backup", "current"]) {
    test(`partial ${field} in ${side} refuses the whole restore before confirmation`, async (t) => {
      // A missing schema marker does not make surviving v3 evidence disposable.
      const partial = { ...legacy(), automation: { [field]: null } };
      const h = await run(t, { [side]: partial });
      assert.equal(h.result.code, "v3_restore_requires_reconciliation");
      assert.equal(h.result.ok, false);
      assert.equal(h.confirmations, 0);
      assert.equal(h.attempts.length, 0);
      assert.deepEqual(h.files, []);
      assert.deepEqual(JSON.parse(h.stored.data), side === "current" ? partial : legacy());
    });
  }
}

test("an existing unreadable wrapper is not treated as an absent core", async (t) => {
  const h = await run(t, { malformedDocument: { exists: false, data: null, parsed: null,
    wrap: { malformed: true }, serverEtag: '"srv"' } });
  assert.equal(h.result.schritt, "ist-stand");
  assert.equal(h.result.ok, false);
  assert.equal(h.attempts.length, 0);
});

for (const parsed of [[], { entities: [] }, { unrelated: true }]) {
  test(`malformed current core is not eligible for full replacement: ${JSON.stringify(parsed)}`, async (t) => {
    const h = await run(t, { malformedDocument: { exists: true, data: JSON.stringify(parsed), parsed, serverEtag: '"srv"' } });
    assert.equal(h.result.schritt, "ist-stand");
    assert.equal(h.result.ok, false);
    assert.equal(h.attempts.length, 0);
  });
}

test("dry run retains inspection without confirmation or remote writes", async (t) => {
  const h = await run(t, { dryRun: true });
  assert.equal(h.result.schritt, "dry-run");
  assert.equal(h.result.geschrieben, false);
  assert.equal(h.confirmations, 0);
  assert.equal(h.attempts.length, 0);
  assert.deepEqual(h.audits, []);
});

test("ordinary legacy automation metadata is not mistaken for a v3 ledger", () => {
  assert.equal(pruefeLegacyRestoreGrenze({ ...legacy(), automation: { schemaVersion: 2, legacySetting: true } }).ok, true);
});
