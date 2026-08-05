import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, "..", file), "utf8");
const html = read("public/career-model.html");
const app = ["01", "02", "03", "04", "05"].map((part) => read(`public/quantus-bundles/career-app.${part}.txt`)).join("");
const core = ["01", "02", "03"].map((part) => read(`public/quantus-bundles/career-core.${part}.txt`)).join("");
const rules = JSON.parse(read("firebase/database.rules.json"));
const schema = JSON.parse(read("public/career-model.schema.json"));

assert.match(html, /career-model-core\.js/);
assert.match(html, /quantus-device-sync\.js/);
assert.match(app, /careerModel\/users\//);
assert.match(app, /reflections\//);
assert.match(app, /transaction\(/);
// Rückweg in die Hauptapp: Topbar-Button, Navigationseintrag und Handler.
assert.match(app, /data-cm-action="exit-app"/);
assert.match(app, /cm-nav-exit/);
assert.match(app, /action === "exit-app"/);
assert.match(app, /function exitToQuantus\(\)/);
assert.match(app, /sessionStorage\.setItem\("quantusAppExit", "career"\)/);
assert.match(html, /href="\/#\/dashboard"/);
assert.match(read("public/career-model.css"), /\.cm-back-button/);
assert.match(core, /quantus-career-model\/v1/);
assert.equal(schema.properties.schema.const, "quantus-career-model/v1");
assert.equal(rules.rules.careerModel.users.$uid[".read"], "auth != null && auth.uid === $uid");
assert.equal(rules.rules.quantusRealtime.workspaces.$uid[".write"], "auth != null && auth.uid === $uid");
assert.match(rules.rules.$andere[".read"], /careerModel/);
assert.match(rules.rules.$andere[".write"], /quantusRealtime/);
console.log("career model app structure: ok");
