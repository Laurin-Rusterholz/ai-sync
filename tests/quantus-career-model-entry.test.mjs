import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import {
  injectEnglishC1,
  injectQuantusApps
} from "../netlify/edge-functions/quantus-app-registry.js";

const sample = `<!doctype html>
<html>
<body>
<script>
const preview = "<html><body>preview</body></html>";
const apps = [
  {key:"polaris", icon:"✦", label:"Polaris"}
];
switch (route) {
  case "ruhestand": openRetirement(); break;
}
</script>
</body>
</html>`;

const transformed = injectQuantusApps(sample);
assert.match(transformed, /key:"englishc1"/);
assert.match(transformed, /key:"career"/);
assert.match(transformed, /label:"Career Model"/);
assert.match(transformed, /Berufliche Weiterbildung/);
assert.match(transformed, /case "englishc1": \{ try \{ if \(sessionStorage\.getItem\("quantusAppExit"\) === "englishc1"\)/);
assert.match(transformed, /case "career": \{ try \{ if \(sessionStorage\.getItem\("quantusAppExit"\) === "career"\)/);
assert.match(transformed, /window\.location\.replace\("\/career-model\.html"\); return; \}/);
assert.match(transformed, /sessionStorage\.removeItem\("quantusAppExit"\); window\.location\.replace\("#\/dashboard"\)/);
assert.match(transformed, /id="quantusCareerModelHubLink"/);
assert.match(transformed, /id="quantusCareerModelRegistration"/);
assert.match(transformed, /src="\/quantus-career-model-entry\.js"/);

const registrationIndex = transformed.indexOf('id="quantusCareerModelRegistration"');
const embeddedBodyIndex = transformed.indexOf("</body>");
const finalBodyIndex = transformed.lastIndexOf("</body>");
assert.ok(registrationIndex > embeddedBodyIndex, "Career registration must not be injected into an embedded HTML string");
assert.ok(registrationIndex < finalBodyIndex, "Career registration must be before the real closing body tag");

const twice = injectQuantusApps(transformed);
assert.equal(twice, transformed, "Quantus app injection must be idempotent");
assert.equal((twice.match(/key:"career"/g) || []).length, 1);
assert.equal((twice.match(/case "career"/g) || []).length, 1);
assert.equal((twice.match(/id="quantusCareerModelHubLink"/g) || []).length, 1);
assert.equal((twice.match(/id="quantusCareerModelRegistration"/g) || []).length, 1);
assert.equal(injectEnglishC1(sample), transformed, "legacy export must retain the complete app registry");

const browserScript = await readFile(new URL("../public/quantus-career-model-entry.js", import.meta.url), "utf8");
new vm.Script(browserScript, { filename: "quantus-career-model-entry.js" });
assert.match(browserScript, /quantusCareerModelAppCard/);
assert.match(browserScript, /quantusCareerModelSidebarLink/);
assert.match(browserScript, /meine apps/i);
assert.match(browserScript, /location\.assign\(APP_URL\)/);
assert.match(browserScript, /quantusAppExit/);
assert.match(browserScript, /consumeExitMarker/);
assert.match(browserScript, /MutationObserver/);

console.log("Career Model Quantus registration: all checks passed");
