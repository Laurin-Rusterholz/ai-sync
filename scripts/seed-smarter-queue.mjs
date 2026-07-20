#!/usr/bin/env node
// Laedt die Smarter-Warteschlange (1 Thema/Tag) + das Build-Logbuch in die RTDB.
// Ausfuehren dort, wo die Firebase-RTDB erreichbar ist (nicht aus der
// Claude-Code-Umgebung — deren Egress ist fuer *.firebasedatabase.app gesperrt).
//
//   node scripts/seed-smarter-queue.mjs            # schreibt queue + buildLog
//   node scripts/seed-smarter-queue.mjs --dry-run  # nur zaehlen, nichts schreiben
//
// smarter/* faellt unter die offene RTDB-Regel ($andere) -> kein Credential noetig.
// PATCH (update) statt PUT -> vorhandene andere Kinder unter smarter/ bleiben.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RTDB = "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const queue = JSON.parse(readFileSync(join(root, "n8n/smarter-queue.seed.json"), "utf8"));
const buildLog = JSON.parse(readFileSync(join(root, "n8n/smarter-buildlog.seed.json"), "utf8"));
buildLog.builtAt = new Date().toISOString();
delete buildLog.builtAtNote;

const units = Object.keys(queue);
const chars = units.reduce((s, k) => s + String(queue[k].content || "").length, 0);
console.log(`Queue-Seed: ${units.length} Themen (pending), ${chars} Zeichen Inhalt.`);
console.log(`Reihenfolge (order): ${units.sort((a, b) => queue[a].order - queue[b].order).map((k) => queue[k].order + ":" + k).slice(0, 6).join(", ")} …`);

if (DRY) { console.log("--dry-run: es wird nichts geschrieben."); process.exit(0); }

async function patch(path, body) {
  const res = await fetch(`${RTDB}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function get(path) {
  const res = await fetch(`${RTDB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

try {
  console.log("→ schreibe smarter/queue …");
  await patch("smarter/queue", queue);
  console.log("→ schreibe smarter/buildLog/smarter-build-2026-07-15 …");
  await patch("smarter/buildLog/smarter-build-2026-07-15", buildLog);

  // Verifizieren
  const back = await get("smarter/queue");
  const pending = Object.values(back || {}).filter((u) => (u && (u.status || "pending")) === "pending").length;
  console.log(`✓ queue zurueckgelesen: ${Object.keys(back || {}).length} Units, davon ${pending} pending.`);
  console.log(`✓ fertig. Bei 1 Thema/Tag fuellt die Datei ${units.length} Tage.`);
} catch (e) {
  console.error("FEHLER:", e.message);
  process.exit(1);
}
