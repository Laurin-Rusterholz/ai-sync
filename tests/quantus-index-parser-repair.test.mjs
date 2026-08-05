import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { repairQuantusInlineScriptLineBreaks } from "../netlify/edge-functions/quantus-app-registry.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

const physicalJoinBodies = Array.from(source.matchAll(/\.join\("([^"\r\n]{0,16}(?:\r\n|\n|\r)[^"\r\n]{0,16})"\)/g), (match) => match[1]);
const diagnostics = physicalJoinBodies.map((body) => ({
  json: JSON.stringify(body),
  codePoints: Array.from(body, (character) => character.codePointAt(0))
}));
console.log("physical join diagnostics", JSON.stringify(diagnostics));
assert.ok(physicalJoinBodies.length >= 3, `Expected damaged join separators; found ${physicalJoinBodies.length}: ${JSON.stringify(diagnostics)}`);

const repaired = repairQuantusInlineScriptLineBreaks(source);
const physicalAfter = Array.from(repaired.matchAll(/\.join\("([^"\r\n]{0,16}(?:\r\n|\n|\r)[^"\r\n]{0,16})"\)/g));
assert.equal(physicalAfter.length, 0, "physical join continuations must be normalized");
assert.match(repaired, /SMARTER_IFRAME_ANSWER_CSS[\s\S]*?\.join\("\\n"\)/, "Smarter CSS must use an explicit newline separator");
assert.match(repaired, /HIER DEINEN TEXT EINFUEGEN[\s\S]*?\.join\("\\n"\)/, "Leseplan prompt must use an explicit newline separator");
assert.match(repaired, /rows\.join\("\\r\\n"\)/, "CSV export must use an explicit CRLF separator");

const inlineScripts = Array.from(repaired.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), (match) => match[1]);
const quantusCore = inlineScripts.find((script) => script.includes("SMARTER_IFRAME_ANSWER_CSS") && script.includes("LESEPLAN_DEFAULT_CONFIG"));
assert.ok(quantusCore, "Quantus core inline script was not found");
assert.doesNotThrow(
  () => new vm.Script(quantusCore, { filename: "public/index.html:quantus-core" }),
  "The repaired Quantus core inline script must parse completely"
);

console.log(`quantus index parser repair: ok (${physicalJoinBodies.length} damaged separators repaired)`);
