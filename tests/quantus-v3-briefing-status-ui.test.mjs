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
  const start = index.indexOf("const V3_MONTHLY_CAP_MICROS = 50_000_000;");
  ok(start > 0, "die Betriebs-Kostenfreigabe (V3_MONTHLY_CAP_MICROS) wurde nicht gefunden");
  // Endet VOR dem Kontrollbereich/Schlusspruefung-Block und dem manuellen
  // Auslöser-Knopf (beide referenzieren `window`, das hier nicht bereitgestellt
  // wird) — die werden eigenstaendig in tests/quantus-v3-daily-briefing-controlpanel.test.mjs
  // bzw. tests/quantus-v3-email-briefing-button.test.mjs geprueft.
  const end = index.indexOf("\n/* ══ Kontrollbereich, Ausnahmen/Freigaben, Schlussprüfung", start);
  ok(end > start, "Ende von renderV3AutomationStatus() nicht bestimmbar");
  const escStart = index.indexOf("\nfunction esc(s){");
  ok(escStart > 0, "die top-level esc()-Funktion wurde nicht gefunden");
  const escSrc = index.slice(escStart, index.indexOf("}\n", escStart) + 1);
  const todayStart = index.indexOf("const todayYmd = () => {");
  ok(todayStart > 0, "die top-level todayYmd()-Funktion wurde nicht gefunden");
  const todaySrc = index.slice(todayStart, index.indexOf("};\n", todayStart) + 2);
  const fn = new Function("APP", escSrc + "\n" + todaySrc + "\n" + index.slice(start, end) + "\nreturn renderV3AutomationStatus;");
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
  // Quellen-spezifische Symbole (echter Lauf) duerfen ohne Lauf nicht
  // erscheinen. Das Budget-Symbol (💰/⚠️/🔒) ist davon ausgenommen: die
  // Betriebs-Kostenfreigabe muss read-only sichtbar bleiben, AUCH ohne
  // Lauf des Tages und selbst wenn das Monatslimit einen Modell-Stopp
  // ausloest.
  ok(!/✅|📡|💸/.test(html), "ohne echten Lauf duerfen keine QUELLEN-Status-Symbole erscheinen");
  ok(/\$0\.00 \/ \$50\.00/.test(html), `die Budget-Anzeige muss auch ohne Lauf sichtbar sein: ${html}`);
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
// Echtes Id-Schema aus section-work.mjs: "v3-draft:<tenant>:<date>:<slot>:<policyVersion>"
// (chatgptNoteBauen-Form, kein erfundenes Fixture) — s. Review-Befund F/G #8.
const REAL_RUN_KEY = "quantus:2026-09-21:briefing04:3";
{
  const data = appWith({
    entities: { chatgptNotes: { ["v3-draft:" + REAL_RUN_KEY]: {
      id: "v3-draft:" + REAL_RUN_KEY, kind: "assistantEntry",
      instruction: "Quelle gmail (ok), 2 Beleg(e): Zusammenfassung des Tages.",
      assistantNote: { runDate: "2026-09-21" }, createdAt: "2026-09-21T04:02:05.000Z", updatedAt: "2026-09-21T04:02:05.000Z",
    } } },
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
{
  // Review-Befund F/G #8: eine ANDERE assistantEntry-Notiz desselben Tages
  // (z. B. eine Startnotiz, nicht vom v3-Lauf erzeugt) darf NICHT als
  // Entwurf erscheinen — nur die exakte "v3-draft:"-Notiz mit passendem
  // Datum im Id-Schema zaehlt.
  const data = appWith({
    entities: { chatgptNotes: {
      "manual-start-note-2026-09-21": { id: "manual-start-note-2026-09-21", kind: "assistantEntry", instruction: "Falscher Treffer: das ist keine Entwurfsnotiz.", assistantNote: { runDate: "2026-09-21" } },
    } },
    dailyBriefing: { assistantRuns: { "2026-09-21": { sourceChecks: { gmail: { outcome: "ok", checkedAt: "2026-09-21T04:02:00.000Z" } } } } },
  });
  const html = loadRenderer()(data)("2026-09-21");
  ok(!html.includes("Falscher Treffer"), `eine fremde assistantEntry-Notiz darf nicht als Entwurf erscheinen: ${html}`);
  ok(/noch kein Entwurf/i.test(html), "ohne echte v3-draft-Notiz muss ehrlich 'noch kein Entwurf' stehen");
}
{
  // Mehrere Slots desselben Tages: die NEUESTE (hoechstes updatedAt) wird gezeigt.
  const data = appWith({
    entities: { chatgptNotes: {
      "v3-draft:quantus:2026-09-21:briefing04:3": { id: "v3-draft:quantus:2026-09-21:briefing04:3", kind: "assistantEntry", instruction: "Alter Entwurf 04 Uhr.", assistantNote: { runDate: "2026-09-21" }, updatedAt: "2026-09-21T04:02:00.000Z" },
      "v3-draft:quantus:2026-09-21:briefing14:3": { id: "v3-draft:quantus:2026-09-21:briefing14:3", kind: "assistantEntry", instruction: "Neuerer Entwurf 14 Uhr.", assistantNote: { runDate: "2026-09-21" }, updatedAt: "2026-09-21T14:02:00.000Z" },
    } },
    dailyBriefing: { assistantRuns: { "2026-09-21": { sourceChecks: {} } } },
  });
  const html = loadRenderer()(data)("2026-09-21");
  ok(html.includes("Neuerer Entwurf 14 Uhr."), `der neueste Entwurf haette gezeigt werden muessen: ${html}`);
  ok(!html.includes("Alter Entwurf 04 Uhr."), "nur EIN Entwurf darf angezeigt werden, nicht beide");
}

// ── 3b) Die Anzeige behauptet keine bestaetigte Serverfrische ────────────
{
  const data = appWith({ entities: { chatgptNotes: {} }, dailyBriefing: { assistantRuns: { "2026-09-21": { sourceChecks: {} } } } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(!/bestätigt.*server|server.*bestätigt/i.test(html), "die Anzeige darf keine bestaetigte Serverfrische behaupten");
  ok(/letzten Synchronisierung/i.test(html), "ein ehrlicher Hinweis auf den Sync-Stand muss sichtbar sein");
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

// ── 5) Betriebs-Kostenfreigabe: $30-Warnung / $50-Sperre, IMMER sichtbar ──
// (Nutzeranfrage: explizite globale $50/Monat-Grenze, $30-Warnung, read-only
// sichtbar auch bei aktivem Modell-Stopp.)
const AKTUELLER_MONAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date()).slice(0, 7);
function kostenBestand(callsById) {
  return appWith({ entities: {}, automation: { runtime: { cost: { callsById } } }, dailyBriefing: {} });
}
{
  const data = kostenBestand({});
  const html = loadRenderer()(data)("2026-09-21");
  ok(/\$0\.00 \/ \$50\.00/.test(html), `ohne Kosten muss $0.00 von $50.00 stehen: ${html}`);
  ok(!/Warnschwelle erreicht/i.test(html) && !/Monatslimit erreicht/i.test(html), "ohne Kosten darf weder gewarnt noch gesperrt werden");
}
{
  // $32 settled — ueber der $30-Warnschwelle, unter der $50-Grenze.
  const data = kostenBestand({ c1: { billingLocalDate: `${AKTUELLER_MONAT}-05`, state: "settled", maxMicros: 32_000_000, settledMicros: 32_000_000 } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(/\$32\.00 \/ \$50\.00/.test(html), `die Summe muss $32.00 zeigen: ${html}`);
  ok(/Warnschwelle erreicht/i.test(html), "ab $30 muss die Warnung sichtbar sein");
  ok(!/Monatslimit erreicht/i.test(html), "unter $50 darf nicht gesperrt sein");
}
{
  // $52 (reserved, worst case) — ueber der $50-Grenze: gesperrt.
  const data = kostenBestand({ c1: { billingLocalDate: `${AKTUELLER_MONAT}-05`, state: "reserved", maxMicros: 52_000_000, settledMicros: 0 } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(/\$52\.00 \/ \$50\.00/.test(html), `die Summe muss $52.00 (worst case, reserviert) zeigen: ${html}`);
  ok(/Monatslimit erreicht/i.test(html), "ab $50 muss die Sperre sichtbar sein");
}
{
  // Ein Anspruch aus einem ANDEREN Kalendermonat zaehlt NICHT zum aktuellen Monat.
  const data = kostenBestand({ alt: { billingLocalDate: "2000-01-05", state: "settled", maxMicros: 45_000_000, settledMicros: 45_000_000 } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(/\$0\.00 \/ \$50\.00/.test(html), `ein Anspruch aus einem anderen Kalendermonat darf nicht mitzaehlen: ${html}`);
}
{
  // "released" zaehlt nicht.
  const data = kostenBestand({ c1: { billingLocalDate: `${AKTUELLER_MONAT}-05`, state: "released", maxMicros: 45_000_000, settledMicros: 0 } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(/\$0\.00 \/ \$50\.00/.test(html), `ein freigegebener (nicht abgerechneter) Anspruch darf nicht mitzaehlen: ${html}`);
}
{
  // Read-only trotz Sperre: die Budgetanzeige bleibt sichtbar, auch OHNE
  // Lauf des Tages und waehrend die Sperre aktiv ist.
  const data = kostenBestand({ c1: { billingLocalDate: `${AKTUELLER_MONAT}-05`, state: "settled", maxMicros: 60_000_000, settledMicros: 60_000_000 } });
  const html = loadRenderer()(data)("2026-09-21");
  ok(/noch kein automatischer Lauf/i.test(html), "auch bei aktiver Sperre bleibt der ehrliche Hinweis ohne Lauf sichtbar");
  ok(/Monatslimit erreicht/i.test(html), "die Sperre bleibt trotzdem sichtbar (read-only)");
}

console.log(`quantus-v3-briefing-status-ui: ${checks} checks passed`);
