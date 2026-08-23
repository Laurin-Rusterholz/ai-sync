/*
 * Das Mobile-Delta wurde geleert, auch wenn der Push abgelehnt wurde.
 *
 * Der 60-Sekunden-Wecker holt die auf dem Handy gelernten RecallLab-Karten
 * ueber recalllab-mobile.json, merged sie lokal und schiebt den Stand mit
 * doSave(true) in die Cloud. Danach wurde das Delta als konsumiert markiert —
 * unabhaengig davon, ob der Push ueberhaupt stattgefunden hat. Seit der
 * Push-Sperre (kein automatischer Upload ohne erfolgreichen Lesevorgang)
 * trifft genau das zu: doSave meldet no_successful_read, das Delta wird
 * trotzdem geleert, und der gemergte Stand steht nur noch lokal.
 *
 * Der Test schneidet den echten Wecker-Rumpf aus index.html und laesst ihn
 * gegen Attrappen laufen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// Den Rumpf des Weckers herausschneiden und als eigene Funktion ausfuehrbar machen.
const start = index.indexOf("// Mobile-Delta-Polling für RecallLab");
ok(start > 0, "der RecallLab-Wecker wurde in index.html nicht gefunden");
const bodyStart = index.indexOf("{", index.indexOf("setInterval(async () => {", start) + 20);
const bodyEnd = index.indexOf("}, 60000);", start);
ok(bodyEnd > bodyStart, "das Ende des Weckers ist nicht bestimmbar");
const koerper = index.slice(index.indexOf("\n", bodyStart) + 1, index.lastIndexOf("}", bodyEnd));

function lauf({ saveResult, applied = 3 }) {
  const log = { saves: 0, clears: 0, renders: 0, warn: [] };
  const fn = new Function(
    "document", "navigator", "isBlobSyncConfigured", "isFirebaseCloudAvailable",
    "_syncLockActive", "mergeMobileRecallLabDelta", "doSave", "clearMobileRecallLabDelta",
    "scheduleSave", "render", "console",
    "return (async () => {" + koerper + "})();");
  return fn(
    { hidden: false }, { onLine: true }, () => true, () => true, false,
    async () => ({ applied }),
    async () => { log.saves++; return saveResult; },
    async () => { log.clears++; },
    () => {}, () => { log.renders++; },
    { log() {}, warn: (...a) => log.warn.push(a.join(" ")) },
  ).then(() => log);
}

// ── 1. Save abgelehnt: das Delta bleibt stehen ────────────────────────────
{
  const log = await lauf({ saveResult: { ok: false, reason: "no_successful_read" } });
  ok(log.saves === 1, "es wurde kein Save versucht");
  ok(log.clears === 0,
    "das Delta wurde geleert, obwohl der Push abgelehnt wurde — die Karten vom Handy waeren nur noch lokal");
  ok(log.warn.some((w) => /bleibt stehen/.test(w)),
    "der unterdrueckte Clear wird nicht protokolliert");
}

// ── 2. Save erfolgreich: das Delta wird geleert ───────────────────────────
{
  const log = await lauf({ saveResult: { ok: true, status: "saved" } });
  ok(log.saves === 1, "es wurde kein Save versucht");
  ok(log.clears === 1, "nach erfolgreichem Save wurde das Delta nicht geleert");
  ok(log.warn.length === 0, "nach erfolgreichem Save wird unnoetig gewarnt");
}

// ── 3. Save wirft: das Delta bleibt stehen ────────────────────────────────
{
  const log = { saves: 0, clears: 0, warn: [] };
  const fn = new Function(
    "document", "navigator", "isBlobSyncConfigured", "isFirebaseCloudAvailable",
    "_syncLockActive", "mergeMobileRecallLabDelta", "doSave", "clearMobileRecallLabDelta",
    "scheduleSave", "render", "console",
    "return (async () => {" + koerper + "})();");
  await fn(
    { hidden: false }, { onLine: true }, () => true, () => true, false,
    async () => ({ applied: 2 }),
    async () => { log.saves++; throw new Error("Netz weg"); },
    async () => { log.clears++; },
    () => {}, () => {}, { log() {}, warn: (...a) => log.warn.push(a.join(" ")) },
  );
  ok(log.clears === 0, "nach einem geworfenen Save wurde das Delta trotzdem geleert");
}

// ── 4. Kein Delta: gar nichts passiert ────────────────────────────────────
{
  const log = await lauf({ saveResult: { ok: true }, applied: 0 });
  ok(log.saves === 0 && log.clears === 0, "ohne Delta wird gespeichert oder geleert");
}

// ── 5. doSave meldet sein Ergebnis ueberhaupt ─────────────────────────────
// Der Erfolgspfad gab bisher undefined zurueck — dann waere jede Pruefung des
// Ergebnisses wirkungslos und das Delta bliebe fuer immer liegen.
{
  const a = index.indexOf("async function doSave(silent = false) {");
  const d = index.slice(a, index.indexOf("\nfunction updateSyncChip", a));
  ok(/return \{ ok: APP\.state\.storage\.status === "saved"/.test(d),
    "doSave meldet auf dem Erfolgspfad kein Ergebnis — die Delta-Pruefung liefe ins Leere");
}

console.log(`recalllab delta clear: ok (${checks} Pruefungen)`);
