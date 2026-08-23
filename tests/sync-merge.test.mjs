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


/* ══════════════════════════════════════════════════════════════════════════
 * Leere Wurzelfelder ueberleben den Abgleich
 *
 * Bereiche MIT eigenem Merge-Zweig sind vom Auffangzweig ausgenommen (sie
 * stehen im handled-Set). Prueft so ein Zweig auf ein UNTERfeld — weekPlan auf
 * .days — oder schlicht auf Wahrheit — dayEnded —, faellt ein leerer bzw.
 * falsy Remote-Wert doppelt durch: der eigene Zweig greift nicht, und der
 * Auffangzweig sieht ihn nicht.
 *
 * Live gemessen: der Rechner schrieb den kanonischen Datensatz mit 54 statt 55
 * Wurzelfeldern zurueck. Verloren ging weekPlan — exakt {}, zwei JSON-Bytes.
 * ══════════════════════════════════════════════════════════════════════════ */

// Das kanonische Wurzelschema kommt aus emptyData() selbst, damit der Test
// mitwaechst, wenn ein Bereich dazukommt.
function ladeEmptyData() {
  const start = index.indexOf("function emptyData() {");
  const end = index.indexOf("\nfunction ", start + 10);
  ok(start > 0 && end > start, "emptyData() wurde in index.html nicht gefunden");
  return new Function("SCHEMA_VERSION", "nowIso",
    index.slice(start, end) + "\nreturn emptyData;")(2, () => "2026-01-01T00:00:00.000Z")();
}

// Der leere bzw. falsy Schemawert zu einem Musterwert.
function leerWie(wert) {
  if (Array.isArray(wert)) return [];
  if (wert && typeof wert === "object") return {};
  if (typeof wert === "boolean") return false;
  if (typeof wert === "number") return 0;
  if (typeof wert === "string") return "";
  return null;
}

// ── 1. weekPlan = {} ueberlebt, auch wenn es lokal fehlt ──────────────────
{
  const local = { entities: { tasks: {} } };                    // KEIN weekPlan
  const remote = { entities: { tasks: {} }, weekPlan: {} };
  const m = mergeData(local, remote);
  ok(Object.prototype.hasOwnProperty.call(m, "weekPlan"),
    "ein leeres weekPlan der Gegenseite verschwindet — genau der 55->54-Verlust");
  ok(JSON.stringify(m.weekPlan) === "{}", `weekPlan wurde veraendert: ${JSON.stringify(m.weekPlan)}`);
}

// ── 2. falsy dayEnded ueberlebt den Zyklus ────────────────────────────────
{
  for (const wert of [false, 0, ""]) {
    const local = { entities: { tasks: {} } };                  // KEIN dayEnded
    const remote = { entities: { tasks: {} }, dayEnded: wert };
    const m = mergeData(local, remote);
    ok(Object.prototype.hasOwnProperty.call(m, "dayEnded"),
      `dayEnded = ${JSON.stringify(wert)} ueberlebt den Abgleich nicht`);
    ok(m.dayEnded === wert,
      `dayEnded wurde von ${JSON.stringify(wert)} auf ${JSON.stringify(m.dayEnded)} veraendert`);
  }
  // Ein wahrer Wert wird weiterhin vom eigenen Zweig uebernommen.
  const m2 = mergeData({ entities: { tasks: {} } },
                       { entities: { tasks: {} }, dayEnded: "2026-08-23" });
  ok(m2.dayEnded === "2026-08-23", "der bestehende dayEnded-Zweig wurde veraendert");
}

// ── 3. Der nichtleere weekPlan-Merge bleibt unveraendert ──────────────────
{
  const local = {
    entities: { tasks: {} },
    weekPlan: { days: { mo: { tasks: ["a"] } }, generatedAt: "2026-08-01" },
  };
  const remote = {
    entities: { tasks: {} },
    weekPlan: { days: { mo: { tasks: ["b"] }, di: { tasks: ["c"] } }, generatedAt: "2026-08-20" },
  };
  const m = mergeData(local, remote);
  ok(m.weekPlan.days.mo.tasks.sort().join(",") === "a,b",
    `die Aufgaben eines Tages werden nicht mehr vereinigt: ${JSON.stringify(m.weekPlan.days.mo.tasks)}`);
  ok(m.weekPlan.days.di.tasks.join(",") === "c", "ein nur remote vorhandener Tag geht verloren");
  ok(m.weekPlan.generatedAt === "2026-08-20", "der neuere generatedAt-Zeitstempel gewinnt nicht mehr");
}

// ── 4. Schemaweit: JEDES Wurzelfeld ueberlebt seinen leeren Schemawert ────
// Prueft die Klasse, nicht nur die zwei bekannten Faelle.
{
  const schema = ladeEmptyData();
  const wurzeln = Object.keys(schema).filter((k) => !k.startsWith("_"));
  ok(wurzeln.length > 20, `das Wurzelschema wirkt zu klein (${wurzeln.length} Felder)`);

  const remote = { entities: { tasks: {} } };
  for (const k of wurzeln) {
    if (k === "entities") continue;                 // bleibt der Traeger des Merges
    const leer = leerWie(schema[k]);
    if (leer === null) continue;                    // kein sinnvoller Leerwert
    remote[k] = leer;
  }
  const local = { entities: { tasks: {} } };        // lokal existiert KEINES davon
  const m = mergeData(local, remote);

  const fehlend = Object.keys(remote).filter(
    (k) => !Object.prototype.hasOwnProperty.call(m, k));
  ok(fehlend.length === 0,
    `diese Wurzelfelder ueberleben ihren leeren Schemawert nicht: ${fehlend.join(", ")}`);

  const remoteWurzeln = Object.keys(remote).filter((k) => !k.startsWith("_")).length;
  const mergedWurzeln = Object.keys(m).filter((k) => !k.startsWith("_")).length;
  ok(mergedWurzeln >= remoteWurzeln,
    `die Zahl der Wurzelfelder ist gesunken: ${remoteWurzeln} -> ${mergedWurzeln}`);
}

// ── 5. Das Netz ueberschreibt nie einen bereits gemergten Wert ────────────
{
  const local = { entities: { tasks: {} }, weekPlan: { days: { mo: { tasks: ["lokal"] } } } };
  const remote = { entities: { tasks: {} }, weekPlan: {} };
  const m = mergeData(local, remote);
  ok(m.weekPlan.days.mo.tasks.join(",") === "lokal",
    "ein leerer Remote-Wert ueberschreibt den lokalen Stand");
}

// ── 6. Quelltextregeln ───────────────────────────────────────────────────
{
  const src = index.slice(index.indexOf("function mergeData(local, remote) {"),
                          index.indexOf("\nfunction ", index.indexOf("function mergeData(local, remote) {") + 10));
  ok(/Sicherheitsnetz: kein Wurzelfeld darf still verschwinden/.test(src),
    "das Sicherheitsnetz fehlt");
  ok(src.indexOf("Sicherheitsnetz: kein Wurzelfeld") > src.indexOf("// ── Meta ──"),
    "das Sicherheitsnetz steht vor dem Meta-Block und wuerde ueberschrieben");
  ok(/hasOwnProperty\.call\(merged, key\)/.test(src),
    "das Netz prueft nicht auf einen bereits vorhandenen Schluessel");
  ok(/if \(remote\.weekPlan && remote\.weekPlan\.days\)/.test(src),
    "der bestehende weekPlan-Zweig wurde veraendert");
  ok(/'weekPlanningMatrix', 'dailyBriefing', 'dayEnded', 'recallLabData',/.test(src),
    "das handled-Set wurde veraendert");
}

console.log(`sync merge: ok (${checks} Pruefungen)`);
