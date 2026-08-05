import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = ["01", "02", "03", "04", "05"].map((part) => read(`public/quantus-bundles/career-app.${part}.txt`)).join("");
const core = ["01", "02", "03"].map((part) => read(`public/quantus-bundles/career-core.${part}.txt`)).join("");
new vm.Script(app, { filename: "career-app.bundle.js" });
new vm.Script(core, { filename: "career-core.bundle.js" });
for (const file of ["public/quantus-device-sync.js", "public/quantus-universal-ui.js", "public/quantus-universal.css", "public/career-model.css"]) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
  assert.ok(read(file).length > 500, `${file} is unexpectedly short`);
}
assert.match(read("public/quantus-device-sync.js"), /sendToDevice/);
assert.match(read("public/quantus-universal-ui.js"), /PENDING_CONTEXT_KEY/);
console.log("quantus bundles: ok");
