import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { injectEnglishC1 } from "../netlify/edge-functions/quantus-app-registry.js";

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

const transformed = injectEnglishC1(sample);
assert.match(transformed, /key:"englishc1"/);
assert.match(transformed, /case "englishc1": \{ try \{ if \(sessionStorage\.getItem\("quantusAppExit"\) === "englishc1"\)/);
assert.match(transformed, /window\.location\.replace\("\/english-c1\.html"\); return; \}/);
assert.match(transformed, /id="quantusEnglishC1HubLink"/);
assert.match(transformed, /id="quantusEnglishC1Registration"/);
assert.match(transformed, /src="\/quantus-english-c1-entry\.js"/);

const registrationIndex = transformed.indexOf('id="quantusEnglishC1Registration"');
const embeddedBodyIndex = transformed.indexOf("</body>");
const finalBodyIndex = transformed.lastIndexOf("</body>");
assert.ok(registrationIndex > embeddedBodyIndex, "registration must not be injected into an HTML string");
assert.ok(registrationIndex < finalBodyIndex, "registration must be before the real closing body tag");

const twice = injectEnglishC1(transformed);
assert.equal(twice, transformed, "English C1 injection must be idempotent");
assert.equal((twice.match(/key:"englishc1"/g) || []).length, 1);
assert.equal((twice.match(/case "englishc1"/g) || []).length, 1);
assert.equal((twice.match(/id="quantusEnglishC1HubLink"/g) || []).length, 1);
assert.equal((twice.match(/id="quantusEnglishC1Registration"/g) || []).length, 1);

const browserScript = await readFile(new URL("../public/quantus-english-c1-entry.js", import.meta.url), "utf8");
new vm.Script(browserScript, { filename: "quantus-english-c1-entry.js" });
assert.match(browserScript, /quantusEnglishC1AppCard/);
assert.match(browserScript, /quantusEnglishC1SidebarLink/);
assert.match(browserScript, /meine apps/i);
assert.match(browserScript, /location\.assign\(APP_URL\)/);
assert.match(browserScript, /MutationObserver/);

console.log("English C1 Quantus registration: all checks passed");
