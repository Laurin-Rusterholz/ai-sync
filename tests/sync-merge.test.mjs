/*
 * Abgleich zweier Geraete — was dabei verloren ging.
 *
 * mergeData() baut sein Ergebnis aus einer KOPIE DES LOKALEN Standes und
 * ergaenzt daraus nur die Bereiche, fuer die es einen eigenen Zweig gibt. Jeder
 * Bereich ohne Zweig behielt damit stumm den lokalen Wert: der Stand der
 * Gegenseite fiel weg — und weil direkt danach gepusht wird, loeschte der
 * Rechner ihn auch auf dem Server.
 *
 * Aufgefallen ist es am Journal Booklet (ein auf dem Handy geschriebener
 * Eintrag verschwand beim naechsten Abgleich des Rechners). Die Luecke war aber
 * nicht auf das Journal beschraenkt: 21 weitere Bereiche hatten sie ebenfalls,
 * darunter eigene Seiten, Leseliste, Mail-Vorlagen und das Handbuch.
 *
 * Der Test laesst die ECHTE Funktion gegen zwei Datenstaende laufen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── Die echte Funktion herausschneiden und ausfuehrbar machen ──────────────
function loadMergeData() {
  const start = index.indexOf("function mergeData(local, remote) {");
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, "mergeData() wurde in index.html nicht gefunden");
  const fn = new Function(
    "idbBackup", "localStorage", "normalizeData", "mergeAndPersistDeleteLog",
    "flattenDeleteLog", "mergeEntity", "entityTimestamp", "console",
    index.slice(start, end) + "\nreturn mergeData;"
  );
  return fn(
    () => {}, { getItem: () => null, setItem() {} }, (d) => d, () => ({}), () => ({}),
    (a, b) => b, (e) => Number(e && (e.updatedAt || e.createdAt)) || 0, { log() {}, warn() {} }
  );
}
const mergeData = loadMergeData();

// ── 1. Kein Bereich faellt still unter den Tisch ───────────────────────────
{
  const local = {
    entities: { tasks: {} },
    customPages: [{ id: "p1", title: "Am Rechner", updatedAt: 100 }],
    readingList: [{ id: "r1", url: "a", updatedAt: 10 }],
    mailTemplates: { t1: { id: "t1", body: "lokal", updatedAt: 5 } },
  };
  const remote = {
    entities: { tasks: {} },
    customPages: [{ id: "p2", title: "Am Handy", updatedAt: 200 },
                  { id: "p1", title: "aelter", updatedAt: 50 }],
    readingList: [{ id: "r2", url: "b", updatedAt: 20 }],
    mailTemplates: { t1: { id: "t1", body: "remote-neuer", updatedAt: 9 },
                     t2: { id: "t2", body: "nur remote" } },
    handbook: { apps: { journal: "Notiz vom Handy" } },
  };
  const m = mergeData(local, remote);

  const pages = (m.customPages || []).map((p) => p.id).sort().join(",");
  ok(pages === "p1,p2",
    `eigene Seiten der Gegenseite gehen verloren: uebrig blieb [${pages}] statt [p1,p2]`);
  ok(m.customPages.find((p) => p.id === "p1").title === "Am Rechner",
    "bei gleicher Id gewinnt der aeltere Stand");
  ok((m.readingList || []).map((r) => r.id).sort().join(",") === "r1,r2",
    "die Leseliste der Gegenseite geht verloren");
  ok(m.mailTemplates.t1.body === "remote-neuer",
    "bei Zuordnungen gewinnt nicht der neuere Eintrag");
  ok(m.mailTemplates.t2 && m.mailTemplates.t2.body === "nur remote",
    "ein nur auf der Gegenseite vorhandener Eintrag kommt nicht an");
  ok(m.handbook && m.handbook.apps.journal === "Notiz vom Handy",
    "ein lokal unbekannter Bereich wird gar nicht uebernommen");
}

// ── 2. Was nach Reihenfolge oder Einstellung aussieht, bleibt lokal ────────
// Eine Vereinigung wuerde hier die vom Nutzer gewaehlte Reihenfolge zerwuerfeln
// bzw. eine Einstellung vom anderen Geraet ueberstuelpen.
{
  const local = { entities: { tasks: {} }, sidebarOrder: ["tasks", "notes"], workloadCapacityWeekly: 40 };
  const remote = { entities: { tasks: {} }, sidebarOrder: ["notes", "tasks", "budget"], workloadCapacityWeekly: 20 };
  const m = mergeData(local, remote);
  ok(JSON.stringify(m.sidebarOrder) === JSON.stringify(["tasks", "notes"]),
    `die Reihenfolge der Seitenleiste wird durcheinandergebracht: ${JSON.stringify(m.sidebarOrder)}`);
  ok(m.workloadCapacityWeekly === 40, "eine lokale Zahl wird vom anderen Geraet ueberschrieben");
}

// ── 3. Transportfelder gehoeren nicht in den Datenstand ────────────────────
// _deleteLog, _settings & Co. reisen im Payload mit und werden an anderer
// Stelle ausgewertet — im gemergten Datenbestand haben sie nichts verloren.
{
  const m = mergeData({ entities: { tasks: {} } }, { entities: { tasks: {} }, _deleteLog: { x: 1 }, _settings: { a: 1 } });
  ok(!("_deleteLog" in m) && !("_settings" in m),
    "Transportfelder werden in den Datenstand uebernommen");
}

// ── 4. Das Journal hat weiterhin seinen eigenen, genaueren Zweig ───────────
// (Vereinigung nach Id, Zustellvermerk der Zeitkapsel bleibt erhalten.)
{
  const m = mergeData(
    { entities: { tasks: {} }, journal: { documents: [{ id: "a", title: "Rechner", updatedAt: 1000 }], selfLetters: [] } },
    { entities: { tasks: {} }, journal: {
        documents: [{ id: "b", title: "Handy", updatedAt: 2000 }],
        selfLetters: [{ id: "L1", title: "Brief", updatedAt: 10, delivered: true }] } }
  );
  ok((m.journal.documents || []).map((d) => d.id).sort().join(",") === "a,b",
    "der Journal-Zweig vereinigt die Werke nicht mehr");
  ok(m.journal.selfLetters.length === 1 && m.journal.selfLetters[0].delivered === true,
    "der Zustellvermerk eines Zeitkapsel-Briefs geht verloren");
}

// ── 5. Ein Geraet ohne eigenen Bestand loescht nichts ──────────────────────
{
  const remote = {
    entities: { tasks: {} },
    journal: { documents: [{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 2 }] },
    customPages: [{ id: "p1", updatedAt: 1 }],
  };
  const m = mergeData({ entities: { tasks: {} } }, remote);
  ok((m.journal?.documents || []).length === 2, "auf einem frischen Geraet loescht der Abgleich das Journal");
  ok((m.customPages || []).length === 1, "auf einem frischen Geraet loescht der Abgleich die eigenen Seiten");
}

// ── 6. Quelltext: der Auffangzweig steht VOR dem Meta-Block ────────────────
// Danach wird nur noch der Zeitstempel gesetzt; stuende er spaeter, liefe er
// gegen ein bereits fertiges Ergebnis.
{
  const src = index.slice(index.indexOf("function mergeData(local, remote) {"),
                          index.indexOf("\nfunction ", index.indexOf("function mergeData(local, remote) {") + 10));
  ok(/Alle uebrigen Bereiche/.test(src), "der Auffangzweig fuer die uebrigen Bereiche fehlt");
  ok(src.indexOf("Alle uebrigen Bereiche") < src.indexOf("// ── Meta ──"),
    "der Auffangzweig steht hinter dem Meta-Block");
  ok(/key\.startsWith\('_'\)/.test(src), "Transportfelder werden im Auffangzweig nicht ausgenommen");
}

console.log(`sync merge: ok (${checks} Pruefungen)`);
