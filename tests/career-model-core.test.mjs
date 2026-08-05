import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import("../public/career-model-core.js");
const Core = globalThis.CareerModelCore;
assert.ok(Core, "CareerModelCore must register globally");

const sample = JSON.parse(fs.readFileSync(path.join(here, "../public/career-model-sample.json"), "utf8"));
const validation = Core.validatePackage(sample);
assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
assert.equal(validation.metrics.days, 2);
assert.equal(validation.metrics.totalMinutes, 60);

const first = Core.mergePackage({}, sample, "2026-08-04T12:30:00.000Z");
assert.equal(Object.keys(first.areas).length, 1);
assert.equal(Object.keys(first.modules).length, 1);
assert.equal(Core.nextSession(first).day.id, "day-01");

first.progress[sample.module.id].completedDays["day-01"] = {
  completedAt: "2026-08-04T18:00:00.000Z",
  actualMinutes: 31
};
const reimport = structuredClone(sample);
reimport.module.description = "Aktualisierte Beschreibung";
const second = Core.mergePackage(first, reimport, "2026-08-05T08:00:00.000Z");
assert.equal(second.progress[sample.module.id].completedDays["day-01"].actualMinutes, 31, "Progress must survive reimport");
assert.equal(Core.nextSession(second).day.id, "day-02");
assert.equal(Core.moduleProgress(second, sample.module.id).percent, 50);

const invalid = structuredClone(sample);
invalid.module.days[0].estimatedMinutes = 5;
invalid.module.days[1].day = 1;
const bad = Core.validatePackage(invalid);
assert.equal(bad.ok, false);
assert.ok(bad.errors.some((entry) => entry.path.includes("estimatedMinutes")));
assert.ok(bad.errors.some((entry) => entry.message.includes("doppelt")));

const prompt = Core.buildClaudePrompt({
  areaName: "Versicherungen",
  moduleTitle: "Fahrzeugversicherung",
  dailyMinutes: 30,
  notes: "Nutze meine internen Produkteunterlagen."
});
assert.match(prompt, /quantus-career-model\/v1/);
assert.match(prompt, /NUR mit einem einzigen gültigen JSON-Objekt/);
assert.match(prompt, /25–35 Minuten/);
assert.match(prompt, /Fahrzeugversicherung/);

console.log("career model core: ok");
