import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectUniversalAssets } from "../netlify/edge-functions/quantus-universal-bootstrap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, "..", file), "utf8");
const ui = read("public/quantus-universal-ui.js");
const deviceSync = read("public/quantus-device-sync.js");

const html = "<!doctype html><html><head><title>Quantus</title></head><body>OK</body></html>";
const first = injectUniversalAssets(html);
assert.match(first, /quantus-device-sync\.js/);
assert.match(first, /quantus-universal-ui\.js/);
assert.match(first, /quantus-universal\.css/);
assert.ok(first.indexOf("quantus-device-sync.js") < first.indexOf("</head>"));
assert.equal((first.match(/quantus-device-sync\.js/g) || []).length, 1);
assert.equal(injectUniversalAssets(first), first, "Injection must be idempotent");
assert.equal(injectUniversalAssets(""), "");
assert.match(injectUniversalAssets("<body>Hallo</body>"), /quantus-device-sync\.js/);

assert.match(ui, /appStore\/app-data_json/, "main Quantus data must receive push-based refreshes");
assert.match(ui, /PENDING_CONTEXT_KEY/, "device handoffs must survive page changes");
assert.match(ui, /data-project-id/, "project handoffs must target exact entities");
assert.match(deviceSync, /user\.isAnonymous/, "anonymous browser sessions must not be treated as a shared device account");
assert.match(deviceSync, /quantusRealtime\/workspaces\//, "device state must be scoped to the signed-in account");
console.log("quantus universal bootstrap and live handoff: ok");
