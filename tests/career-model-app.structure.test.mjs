import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../public/career-model.html");
const app = read("../public/career-model.js");
const core = read("../public/career-model-core.js");
const rules = JSON.parse(read("../firebase/database.rules.json"));
const schema = JSON.parse(read("../public/career-model.schema.json"));

assert.match(html, /career-model-core\.js/);
assert.match(html, /quantus-device-sync\.js/);
assert.match(app, /careerModel\/users\//);
assert.match(app, /reflections\//);
assert.match(app, /transaction\(/);
assert.match(core, /quantus-career-model\/v1/);
assert.equal(schema.properties.schema.const, "quantus-career-model/v1");
assert.equal(rules.rules.careerModel.users.$uid[".read"], "auth != null && auth.uid === $uid");
assert.equal(rules.rules.quantusRealtime.workspaces.$uid[".write"], "auth != null && auth.uid === $uid");
assert.match(rules.rules.$andere[".read"], /careerModel/);
assert.match(rules.rules.$andere[".write"], /quantusRealtime/);
console.log("career model app structure: ok");
