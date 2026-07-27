// Selbsttest fuer die reinen Helfer des Backup-CLIs:
//   node scripts/backup-blob.test.mjs
import assert from "node:assert/strict";
import { parseArgs, buildBackupName } from "./backup-blob.mjs";

{
  const args = parseArgs([]);
  assert.equal(args.key, "app-data.json");
  assert.equal(args.out, "backups");
  assert.equal(args.restore, null);
  assert.equal(args.force, false);
  assert.ok(args.base.startsWith("https://"));
}

{
  const args = parseArgs(["--base", "https://example.netlify.app/", "--key", "test.json", "--out", "sicherungen"]);
  assert.equal(args.base, "https://example.netlify.app");
  assert.equal(args.key, "test.json");
  assert.equal(args.out, "sicherungen");
}

{
  const args = parseArgs(["--restore", "backups/x.backup.json", "--force"]);
  assert.equal(args.restore, "backups/x.backup.json");
  assert.equal(args.force, true);
}

{
  const name = buildBackupName("app-data.json", new Date("2026-07-27T09:30:15.123Z"));
  assert.equal(name, "app-data.json.2026-07-27T09-30-15.backup.json");
  assert.ok(!/[\/\\:]/.test(name));
  assert.ok(buildBackupName("../boese/../pfad.json", new Date()).startsWith(".._boese_.._pfad.json."));
}

console.log("backup-blob: 4 Testbloecke bestanden");
