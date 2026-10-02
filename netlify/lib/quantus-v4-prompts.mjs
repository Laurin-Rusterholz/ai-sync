import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PROMPT_VERSION = "4.0.0";
export const MAIN_PROMPT_SLOTS = Object.freeze(["briefing04", "process09", "continue14", "close23"]);
const hashes = Object.freeze({
  leadership: "53bd651ee72f4630ce7fa2ed71ecc4c32eff4b83f3931ae72a6aef2dfbb4114e",
  briefing04: "e644b698c01dbda525501f54adc1af4f0face5ddbf6c08918589b7de9e1b8dd3",
  process09: "5c9d926acb055a854d734f8e239952fd6f328db20db013811bec7eb15fe111b0",
  continue14: "35132bc2777281d4253c3e58393fb57a11057cc0a207eab62715ccfd29f83de9",
  close23: "2d11a5eddfa0f5330ade1663c2fad8def4e57128b21a78719af44ca4a5b06ea2",
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
function fail(code) { throw Object.assign(new Error(code), { code, status: 503 }); }

/** Trusted worker configuration only; never a prompt path supplied by a model. */
export async function loadQuantusV4Prompts({ slot, expectedVersion }, { readText = (url) => readFile(url, "utf8") } = {}) {
  if (expectedVersion !== PROMPT_VERSION) fail("prompt_version_unavailable");
  if (!MAIN_PROMPT_SLOTS.includes(slot)) fail("prompt_slot_invalid");
  const texts = {};
  for (const name of ["leadership", slot]) {
    let text;
    try { text = await readText(new URL(`../../prompts/quantus-v4/${name}.md`, import.meta.url)); }
    catch { fail("prompt_unavailable"); }
    if (typeof text !== "string" || digest(text) !== hashes[name]) fail("prompt_integrity_failed");
    texts[name] = text;
  }
  return Object.freeze({
    version: PROMPT_VERSION, slot,
    leadership: texts.leadership, instruction: texts[slot],
    leadershipHash: hashes.leadership, instructionHash: hashes[slot],
    bundleHash: digest(JSON.stringify([PROMPT_VERSION, slot, hashes.leadership, hashes[slot]])),
  });
}
