import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  injectEnglishC1,
  repairQuantusInlineScriptLineBreaks
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
    try {
      new vm.Script(block.source, { filename });
    } catch (error) {
      const lineMatch = String(error.stack || "").match(new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`));
      const line = Number(lineMatch?.[1] || 0);
      const lines = block.source.split(/\r?\n/);
      const from = Math.max(0, line - 4);
      const to = Math.min(lines.length, line + 3);
      const context = lines.slice(from, to).map((text, offset) => ({
        line: from + offset + 1,
        json: JSON.stringify(text),
        codePoints: Array.from(text, (character) => character.codePointAt(0))
      }));
      console.error(`${label}: parser failure in inline script ${index + 1}`, JSON.stringify(context));
      throw error;
    }
  });
  console.log(`${label}: ${blocks.length} inline scripts parse`);
}

parseHtmlScripts(source, "raw-index");

const registryThenUniversal = injectUniversalAssets(
  injectEnglishC1(repairQuantusInlineScriptLineBreaks(source))
);
parseHtmlScripts(registryThenUniversal, "registry-then-universal");

const universalThenRegistry = injectEnglishC1(
  repairQuantusInlineScriptLineBreaks(injectUniversalAssets(source))
);
parseHtmlScripts(universalThenRegistry, "universal-then-registry");

console.log("quantus index parser diagnostics: ok");
