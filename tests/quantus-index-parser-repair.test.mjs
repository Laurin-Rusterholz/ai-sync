import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { repairQuantusInlineScriptLineBreaks } from "../netlify/edge-functions/quantus-app-registry.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

const brokenJoinSeparator = /\.join\("([^"\r\n]*)\\[ \t]*(?:\r\n|\n|\r)"\)/g;
const brokenBefore = source.match(brokenJoinSeparator) || [];
assert.ok(brokenBefore.length >= 3, "Expected the known damaged join separators in the current index fixture");

const repaired = repairQuantusInlineScriptLineBreaks(source);
assert.equal((repaired.match(brokenJoinSeparator) || []).length, 0, "physical join continuations must be normalized");
assert.match(repaired, /SMARTER_IFRAME_ANSWER_CSS[\s\S]*?\.join\("\\n"\)/, "Smarter CSS must use an explicit newline separator");
assert.match(repaired, /HIER DEINEN TEXT EINFUEGEN[\s\S]*?\.join\("\\n"\)/, "Leseplan prompt must use an explicit newline separator");
assert.match(repaired, /rows\.join\("\\r\\n"\)/, "CSV export must use an explicit CRLF separator");

// Parse the same large inline block that contains Smarter and Leseplan. This
// catches the exact class of failure that previously removed the dashboard.
const inlineScripts = Array.from(repaired.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), (match) => match[1]);
const quantusCore = inlineScripts.find((script) => script.includes("SMARTER_IFRAME_ANSWER_CSS") && script.includes("LESEPLAN_DEFAULT_CONFIG"));
assert.ok(quantusCore, "Quantus core inline script was not found");
assert.doesNotThrow(
  () => new vm.Script(quantusCore, { filename: "public/index.html:quantus-core" }),
  "The repaired Quantus core inline script must parse completely"
);

console.log(`quantus index parser repair: ok (${brokenBefore.length} damaged separators repaired)`);
