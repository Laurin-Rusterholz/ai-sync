/*
 * ChatGPT Notes — Merge zweier Geraete darf keinen Eintrag verlieren.
 *
 * Das Modul "ChatGPT Notes" (Gedaechtnis des Assistenten ueber Sitzungen
 * hinweg) lebt als normale Entity-Sammlung unter entities.chatgptNotes und
 * durchlaeuft denselben generischen Pull-Merge-Push wie tasks/notes/updates
 * (siehe CLAUDE.md, Fallstrick 2: mergeData() vergisst, was es nicht kennt).
 * Weil der Auftrag ausdruecklich den Fall "Eintrag auf Geraet A, anderer
 * Eintrag auf Geraet B, dann Merge" verlangt, prueft dieser Test genau das —
 * plus den einen Bereich, der eine eigene Merge-Regel braucht:
 * chatgptNotesMeta.lastSessionReadAt ist ein reiner Zeitstempel-Marker (kein
 * per-Id-Objekt), den der generische Auffangzweig ueber unionMap()/stamp()
 * nicht erkennen wuerde (stamp() liest .updatedAt VOM WERT — ein String hat
 * das nicht), und der deshalb einen eigenen kleinen Merge-Zweig bekam.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

function sliceFn(name) {
  const start = index.indexOf(name);
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, `${name} wurde in index.html nicht gefunden`);
  return index.slice(start, end);
}

// ── Die echten Funktionen herausschneiden — mergeData MIT der echten
// mergeEntity/entityTimestamp-Logik, damit auch der Konfliktfall (gleiche Id,
// unterschiedlicher updatedAt) echt geprueft wird statt gegen einen Stub. ──
function loadMergeData() {
  const mergeEntitySrc = sliceFn("function mergeEntity(local, remote) {");
  const entityTsSrc = sliceFn("function entityTimestamp(item) {");
  const start = index.indexOf("function mergeData(local, remote) {");
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, "mergeData() wurde in index.html nicht gefunden");
  const trStart = index.indexOf("const TRANSPORT_ROOTS = new Set([");
  ok(trStart > 0, "TRANSPORT_ROOTS wurde in index.html nicht gefunden");
  const transportSrc = index.slice(trStart, index.indexOf("]);", trStart) + 3);
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog",
    "flattenDeleteLog", "console",
    transportSrc + "\n" + entityTsSrc + "\n" + mergeEntitySrc + "\n" +
    index.slice(start, end) + "\nreturn mergeData;"
  );
  return fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    { log() {}, warn() {} }
  );
}
const mergeData = loadMergeData();

function baseData(extra) {
  return { entities: { tasks: {}, chatgptNotes: {} }, ...extra };
}

// ── 1. Eintrag auf Geraet A, anderer Eintrag auf Geraet B → beide bleiben ──
{
  const local = baseData({
    entities: { tasks: {}, chatgptNotes: {
      a1: { id: "a1", createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
            category: "auftrag", instruction: "Am Rechner erfasst", derived: "…", state: "aktiv" },
    } },
  });
  const remote = baseData({
    entities: { tasks: {}, chatgptNotes: {
      b1: { id: "b1", createdAt: "2026-08-21T09:00:00.000Z", updatedAt: "2026-08-21T09:00:00.000Z",
            category: "feedback", instruction: "Auf dem Handy erfasst", derived: "…", state: "aktiv" },
    } },
  });
  const m = mergeData(local, remote);
  const ids = Object.keys(m.entities.chatgptNotes).sort().join(",");
  ok(ids === "a1,b1", `Eintraege beider Geraete gehen beim Merge verloren: uebrig blieb [${ids}] statt [a1,b1]`);
  ok(m.entities.chatgptNotes.a1.instruction === "Am Rechner erfasst", "der Eintrag von Geraet A wurde veraendert");
  ok(m.entities.chatgptNotes.b1.instruction === "Auf dem Handy erfasst", "der Eintrag von Geraet B kommt nicht an");
}

// ── 2. Gleiche Id auf beiden Geraeten → der neuere Stand gewinnt ──────────
// (z.B. eine Ablösung, die auf Geraet A den alten Eintrag auf "ueberholt"
// gesetzt hat, waehrend Geraet B noch den alten, unveraenderten Stand hat.)
{
  const local = baseData({
    entities: { tasks: {}, chatgptNotes: {
      c1: { id: "c1", createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z",
            category: "auftrag", instruction: "Alt", derived: "…", state: "ueberholt", supersededBy: "c2" },
    } },
  });
  const remote = baseData({
    entities: { tasks: {}, chatgptNotes: {
      c1: { id: "c1", createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
            category: "auftrag", instruction: "Alt", derived: "…", state: "aktiv", supersededBy: null },
    } },
  });
  const m = mergeData(local, remote);
  ok(m.entities.chatgptNotes.c1.state === "ueberholt",
    "die Abloesung (neuerer Stand) wird vom aelteren Remote-Stand ueberschrieben");
}

// ── 3. lastSessionReadAt: der neuere Zeitstempel gewinnt, unabhaengig davon,
//     auf welchem Geraet zuerst "Als gelesen markieren" gedrueckt wurde ──────
{
  // Geraet B (remote) hat spaeter als gelesen markiert als Geraet A (local).
  let m = mergeData(
    baseData({ chatgptNotesMeta: { lastSessionReadAt: "2026-08-20T08:00:00.000Z" } }),
    baseData({ chatgptNotesMeta: { lastSessionReadAt: "2026-08-25T18:00:00.000Z" } })
  );
  ok(m.chatgptNotesMeta.lastSessionReadAt === "2026-08-25T18:00:00.000Z",
    "der neuere lastSessionReadAt von der Gegenseite geht beim Merge verloren — das Badge zeigt danach faelschlich weiter alte Eintraege als neu an");

  // Umgekehrt: lokal ist neuer als remote → lokal bleibt bestehen.
  m = mergeData(
    baseData({ chatgptNotesMeta: { lastSessionReadAt: "2026-08-25T18:00:00.000Z" } }),
    baseData({ chatgptNotesMeta: { lastSessionReadAt: "2026-08-20T08:00:00.000Z" } })
  );
  ok(m.chatgptNotesMeta.lastSessionReadAt === "2026-08-25T18:00:00.000Z",
    "ein aelterer lastSessionReadAt von der Gegenseite ueberschreibt faelschlich den neueren lokalen Stand");

  // Nur eine Seite kennt das Feld ueberhaupt (frisch ausgeliefertes Geraet).
  m = mergeData(baseData({}), baseData({ chatgptNotesMeta: { lastSessionReadAt: "2026-08-22T00:00:00.000Z" } }));
  ok(m.chatgptNotesMeta.lastSessionReadAt === "2026-08-22T00:00:00.000Z",
    "lastSessionReadAt eines frischen lokalen Geraets ohne eigenen Wert wird nicht von der Gegenseite uebernommen");
}

console.log(`sync chatgptNotes merge: ok (${checks} Pruefungen)`);
