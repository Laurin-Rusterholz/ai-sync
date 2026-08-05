import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  injectEnglishC1,
  insertBeforeFinalClosingTag
} from "../netlify/edge-functions/quantus-app-registry.js";
import { injectUniversalAssets } from "../netlify/edge-functions/quantus-universal-bootstrap.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

function scriptBlocks(html) {
  return Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi), (match) => ({
    attributes: match[1] || "",
    source: match[2] || ""
  })).filter((block) => {
    if (/\bsrc\s*=/i.test(block.attributes)) return false;
    const type = block.attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    return !type || type === "text/javascript" || type === "application/javascript" || type === "module";
  });
}

function parseHtmlScripts(html, label) {
  const blocks = scriptBlocks(html);
  assert.ok(blocks.length > 10, `${label}: unexpectedly few inline scripts`);
  blocks.forEach((block, index) => {
    const filename = `${label}-script-${index + 1}.js`;
    new vm.Script(block.source, { filename });
  });
  console.log(`${label}: ${blocks.length} inline scripts parse`);
}

parseHtmlScripts(source, "raw-index");

const launcherMarker = '<script id="quantusEnglishC1HubLink">';
const registryOnly = injectEnglishC1(source);
const launcherIndex = registryOnly.indexOf(launcherMarker);
const finalBodyIndex = registryOnly.toLowerCase().lastIndexOf("</body>");
const previousBodyIndex = registryOnly.toLowerCase().lastIndexOf("</body>", launcherIndex - 1);
assert.ok(previousBodyIndex >= 0, "fixture must contain a generated-document body tag before the launcher");
assert.ok(launcherIndex > previousBodyIndex, "launcher must not be injected into a generated HTML string");
assert.ok(launcherIndex < finalBodyIndex, "launcher must be inserted before the real closing body tag");
assert.equal(registryOnly.indexOf(launcherMarker, launcherIndex + 1), -1, "launcher injection must be idempotent");
assert.equal(injectEnglishC1(registryOnly), registryOnly, "registry transform must be idempotent");
parseHtmlScripts(registryOnly, "registry-only");

const registryThenUniversal = injectUniversalAssets(registryOnly);
parseHtmlScripts(registryThenUniversal, "registry-then-universal");

const universalThenRegistry = injectEnglishC1(injectUniversalAssets(source));
parseHtmlScripts(universalThenRegistry, "universal-then-registry");

assert.equal(
  insertBeforeFinalClosingTag("<body>inside </body> text</body>", "body", "<script>safe</script>"),
  "<body>inside </body> text<script>safe</script>\n</body>",
  "helper must target the final closing tag"
);

console.log("quantus index parser regression: ok");
