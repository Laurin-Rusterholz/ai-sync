import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PROMPT_VERSION = "3.0.0";
export const MAIN_PROMPT_SLOTS = Object.freeze(["briefing04", "process09", "continue14", "close23"]);
const hashes = Object.freeze({
  leadership: "ed7769869bdaa800bb0798cd1b3c5c5bc3934defdc1e2045139930fa9c6f1782",
  briefing04: "099b04be41199f64bd1b3ba697cb671d0a7cc31416bdf9d6c77348db595a2c22",
  process09: "f24eba7e515cf270bb56348c72e0f6da0ddb0b401ea3deeff22ac442b3a5d9f8",
  continue14: "5f8c022bc337093653facd692fa169720b31ab6083b58200cbb034828cbe25b4",
  close23: "0d3050f32d9cdde31db3ccd56452071155bcd8ff52ef7aeabf92567421c67137",
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
function fail(code) { throw Object.assign(new Error(code), { code, status: 503 }); }

/** Trusted worker configuration only; never a prompt path supplied by a model. */
export async function loadQuantusV3Prompts({ slot, expectedVersion }, { readText = (url) => readFile(url, "utf8") } = {}) {
  if (expectedVersion !== PROMPT_VERSION) fail("prompt_version_unavailable");
  if (!MAIN_PROMPT_SLOTS.includes(slot)) fail("prompt_slot_invalid");
  const texts = {};
  for (const name of ["leadership", slot]) {
    let text;
    try { text = await readText(new URL(`../../prompts/quantus-v3/${name}.md`, import.meta.url)); }
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
