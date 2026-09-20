/*
 * Tagesbriefing v3 im DESKTOP-Briefing sichtbar machen — der Nutzer sah
 * bisher keine Spur eines automatischen Laufs in der eigentlichen App,
 * obwohl `dailyBriefing.assistantRuns`/`automation` (geschuetzt seit
 * Baustein D, F-27) laengst der reale, synchronisierte Datenbestand ist.
 *
 * Dieser Test prueft die ECHTE Funktion aus public/index.html
 * (`renderV3AutomationStatus`), UND dass sie tatsaechlich aus der
 * bestehenden `viewDailyBriefing()`-Route heraus aufgerufen wird — kein
 * neues, ungenutztes Modul.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

// ── 0) Echte Verdrahtung: viewDailyBriefing() ruft die Funktion wirklich auf ──
{
  const vdbStart = index.indexOf("function viewDailyBriefing() {");
  ok(vdbStart > 0, "viewDailyBriefing() wurde nicht gefunden");
  const vdbEnd = index.indexOf("\nfunction ", vdbStart + 10);
  const vdbSrc = index.slice(vdbStart, vdbEnd);
  ok(/renderV3AutomationStatus\(selectedDate\)/.test(vdbSrc),
    "viewDailyBriefing() ruft renderV3AutomationStatus() nicht auf — es waere nur ein ungenutztes neues Modul");
  ok(!/onclick="[^"]*(startRun|triggerRun|activateApi|runNow)/i.test(index.slice(vdbStart, vdbStart + index.slice(vdbStart).indexOf("renderV3AutomationStatus"))),
    "die neue Anzeige darf keinen Knopf zum Auslösen eines kostenpflichtigen Laufs enthalten");
}

// ── Extraktion der echten Funktion ────────────────────────────────────────
function loadRenderer() {
  const start = index.indexOf("function renderV3AutomationStatus(selectedDate) {");
  ok(start > 0, "renderV3AutomationStatus() wurde nicht gefunden");
  const end = index.indexOf("\nfunction viewDailyBriefing() {", start);
  ok(end > start, "Ende von renderV3AutomationStatus() nicht bestimmbar");
  const escStart = index.indexOf("\nfunction esc(s){");
  ok(escStart > 0, "die top-level esc()-Funktion wurde nicht gefunden");
  const escSrc = index.slice(escStart, index.indexOf("}\n", escStart) + 1);
  const fn = new Function("APP", escSrc + "\n" + index.slice(start, end) + "\nreturn renderV3AutomationStatus;");
  return fn;
}

function appWith(data) {
  return { state: { data } };
}

// ── 1) Kein Lauf fuer den Tag: ehrlicher Hinweis, keine leere Seite, nichts erfunden ──
{
  const render = loadRenderer()(appWith({ entities: {}, dailyBriefing: {} }));
  const html = render("2026-09-21");
  ok(/noch kein automatischer Lauf/i.test(html), `ohne Lauf fehlt der ehrliche Hinweis: ${html}`);
  ok(!/✅|⚠️|🔒|📡|💸/.test(html), "ohne echten Lauf duerfen keine Status-Symbole erscheinen");
}
{
  // Auch ganz ohne automation/dailyBriefing (frischer, nie synchronisierter Client).
  const render = loadRenderer()(appWith({ entities: {} }));
  const html = render("2026-09-21");
  ok(/noch kein automatischer Lauf/i.test(html), "fehlendes dailyBriefing darf nicht abstuerzen oder leer bleiben");
}

// ── 2) Echter Lauf: Quellenstand, letzte Pruefung und Fehler sichtbar ─────
{
  const data = appWith({
    entities: { chatgptNotes: {} },
    dailyBriefing: { assistantRuns: { "2026-09-21": {
      sourceChecks: {
        gmail: { outcome: "ok", checkedAt: "2026-09-21T04:02:00.000Z", detail: "pages=2" },
        drive: { outcome: "auth_error", checkedAt: "2026-09-21T04:03:00.000Z" },
      },
    } } },
  });
  const html = loadRenderer()(data)("2026-09-21");
  ok(html.includes("gmail") && /zuletzt gepr.ft/i.test(html), `Quelle gmail mit letzter Pruefung fehlt: ${html}`);
  ok(/Anmeldefehler/.test(html), `der Fehler der Quelle drive muss sichtbar sein: ${html}`);
  ok(/pages=2/.test(html), "das Detail (Seitenzahl) der Quellenpruefung muss sichtbar sein");
}

// ── 3) Persistierter Entwurf wird unveraendert angezeigt, referenziert die Quelle ──
{
  const data = appWith({
    entities: { chatgptNotes: { "v3-draft:x": { kind: "assistantEntry", content: "Quelle gmail (ok), 2 Beleg(e): Zusammenfassung des Tages.", assistantNote: { runDate: "2026-09-21" } } } },
    dailyBriefing: { assistantRuns: { "2026-09-21": { sourceChecks: { gmail: { outcome: "ok", checkedAt: "2026-09-21T04:02:00.000Z" } } } } },
  });
  const html = loadRenderer()(data)("2026-09-21");
  ok(html.includes("Zusammenfassung des Tages."), `der echte Entwurfstext muss unveraendert erscheinen: ${html}`);
}
{
  // Ohne Entwurf: ehrlich "noch kein Entwurf", kein erfundener Text.
  const data = appWith({ entities: { chatgptNotes: {} }, dailyBriefing: { assistantRuns: { "2026-09-21": { sourceChecks: {} } } } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(/noch kein Entwurf/i.test(html), "ohne Entwurf muss das ehrlich sichtbar sein");
}

// ── 4) HTML-Escaping: eine Quellen-Id/Detail mit Markup wird nicht ausgefuehrt ──
{
  const data = appWith({
    entities: { chatgptNotes: {} },
    dailyBriefing: { assistantRuns: { "2026-09-21": { sourceChecks: { "<img src=x onerror=alert(1)>": { outcome: "ok", checkedAt: "2026-09-21T04:00:00.000Z" } } } } },
  });
  const html = loadRenderer()(data)("2026-09-21");
  ok(!html.includes("<img src=x"), "eine boesartige Quellen-Id darf nicht ungeprueft ins HTML gelangen");
}

console.log(`quantus-v3-briefing-status-ui: ${checks} checks passed`);
