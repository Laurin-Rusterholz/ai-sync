/*
 * Der manuelle "E-Mails auswerten"-Knopf im DailyBriefing (public/index.html,
 * `dbRunV3EmailBriefing` + der Knopf in `renderV3AutomationStatus`).
 *
 * Nutzeranforderung: ein wirklich ausfuehrbarer UI-Weg, kein reines Doku-
 * Versprechen — authentifizierter POST an denselben Endpunkt wie der lokale
 * ChatGPT-Agent, sichtbare Ergebnisse/Fehler, und danach ein SICHERER
 * Refresh (syncFreshness = Pull-Merge-Render), der nie lokale, noch
 * ungesicherte Aenderungen ueberschreibt.
 *
 * Diese Tests extrahieren die ECHTEN Funktionen aus index.html (kein
 * Duplikat) und fuehren sie gegen ein Stub-DOM/Stub-fetch aus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

function extract(startMarker, endMarker, startFrom = 0) {
  const start = index.indexOf(startMarker, startFrom);
  assert.ok(start > 0, `Marker nicht gefunden: ${startMarker}`);
  const end = index.indexOf(endMarker, start);
  assert.ok(end > start, `Endmarker nicht gefunden nach ${startMarker}: ${endMarker}`);
  return index.slice(start, end + endMarker.length);
}

// ── Extraktion: renderV3AutomationStatus (fuer den Knopf) ──────────────────
function loadRenderer() {
  const escSrc = extract("\nfunction esc(s){", "}\n");
  const todaySrc = extract("const todayYmd = () => {", "};\n");
  const capSrc = extract("const V3_MONTHLY_CAP_MICROS", ";\n");
  const warnSrc = extract("const V3_MONTHLY_WARN_MICROS", ";\n");
  const yearMonthFnSrc = extract("function v3ZurichYearMonth(ms) {", "\n}\n");
  const monthFnSrc = extract("function v3MonthToDateMicros() {", "\n}\n");
  const usdFnSrc = extract("function v3Usd(micros)", "\n");
  const budgetSrc = extract("function renderV3BudgetStatus() {", "\n}\n");
  const rendererSrc = extract("function renderV3AutomationStatus(selectedDate) {", "\n}\n");
  const fn = new Function("APP", "window",
    escSrc + "\n" + todaySrc + "\n" + capSrc + "\n" + warnSrc + "\n" + yearMonthFnSrc + "\n" + monthFnSrc + "\n" + usdFnSrc + "\n" + budgetSrc + "\n" + rendererSrc
    + "\nreturn renderV3AutomationStatus;");
  return fn;
}

function appWith(data) { return { state: { data } }; }

test("Knopf 'E-Mails auswerten' erscheint fuer HEUTE, mit Status-Bereich", () => {
  const heute = new Date().toISOString().slice(0, 10);
  const render = loadRenderer()(appWith({ entities: {}, dailyBriefing: {} }), {});
  const html = render(heute);
  assert.match(html, /id="dbV3EmailRunBtn"/, "der Knopf muss vorhanden sein");
  assert.match(html, /dbRunV3EmailBriefing\(\)/, "der Knopf muss die echte Funktion aufrufen");
  assert.match(html, /id="dbV3EmailRunStatus"/, "der Status-Bereich fuer Ergebnisse/Fehler muss vorhanden sein");
});

test("fuer einen ANDEREN Tag als heute erscheint kein Knopf (der Server wertet immer 'heute' aus)", () => {
  const render = loadRenderer()(appWith({ entities: {}, dailyBriefing: {} }), {});
  const html = render("2000-01-01");
  assert.doesNotMatch(html, /id="dbV3EmailRunBtn"/, "ohne 'heute' darf kein irrefuehrender Knopf erscheinen");
  assert.match(html, /nur für heute verfügbar/, "der Hinweis muss ehrlich erklaeren, warum kein Knopf da ist");
});

// ── Extraktion: dbRunV3EmailBriefing (fuer das Verhalten des Knopfs) ───────
const HANDLER_SRC = extract("async function dbRunV3EmailBriefing() {", "\nwindow.dbRunV3EmailBriefing = dbRunV3EmailBriefing;");
function loadHandler({ window: win = {}, document, APP, fetch: fetchImpl, syncFreshness: syncImpl }) {
  return new Function(
    "window", "document", "APP", "fetch", "sanitizeApiKey", "syncFreshness", "esc",
    HANDLER_SRC + "\nreturn dbRunV3EmailBriefing;"
  )(win, document, APP, fetchImpl,
    (k) => String(k || "").trim(),
    syncImpl || (async () => {}),
    (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
}

function stubDom() {
  const els = {
    dbV3EmailRunBtn: { disabled: false, textContent: "" },
    dbV3EmailRunStatus: { innerHTML: "" },
  };
  return { document: { getElementById: (id) => els[id] || null }, els };
}

test("ohne Zugangsschlüssel: sichtbarer Fehler, kein fetch-Aufruf", async () => {
  let fetchCalled = false;
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "" } } };
  const fn = loadHandler({ document, APP, fetch: async () => { fetchCalled = true; return { status: 200, json: async () => ({ ok: true }) }; } });
  await fn();
  assert.equal(fetchCalled, false, "ohne Token darf niemals ein Aufruf gesendet werden");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /Zugangsschlüssel/, "der fehlende Zugangsschlüssel muss sichtbar erklaert werden");
});

test("mit Zugangsschlüssel: sendet POST mit korrektem Bearer-Header an den echten Endpunkt", async () => {
  let gesehen = null;
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "  mein-token  " } } };
  const fn = loadHandler({
    document, APP,
    fetch: async (url, opts) => { gesehen = { url, opts }; return { status: 200, json: async () => ({ ok: true, drafted: true, sourceOutcome: "ok" }) }; },
  });
  await fn();
  assert.ok(gesehen, "fetch haette aufgerufen werden muessen");
  assert.equal(gesehen.url, "/.netlify/functions/quantus-v3-daily-briefing-run");
  assert.equal(gesehen.opts.method, "POST");
  assert.equal(gesehen.opts.headers.Authorization, "Bearer mein-token");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /Entwurf erstellt/, "ein erfolgreicher Lauf muss sichtbar bestaetigt werden");
});

test("bei Erfolg (Status 200) wird syncFreshness() aufgerufen — sicherer Refresh, kein Ueberschreiben", async () => {
  let syncAufgerufenMit = null;
  const { document } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "tok" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, drafted: false, sourceOutcome: "ok" }) }),
    syncFreshness: async (reason) => { syncAufgerufenMit = reason; },
  });
  await fn();
  assert.equal(syncAufgerufenMit, "v3-email-run", "syncFreshness() (Pull-Merge-Render) muss nach einem echten Lauf aufgerufen werden");
});

test("bei 401 wird der Zugriff als verweigert angezeigt und syncFreshness() NICHT aufgerufen", async () => {
  let syncCalled = false;
  const { document, els } = stubDom();
  const APP = { state: { settings: { v3EmailAuthToken: "falsch" } } };
  const fn = loadHandler({
    document, APP,
    fetch: async () => ({ status: 401, json: async () => ({ ok: false, error: "KEIN_ZUGANG" }) }),
    syncFreshness: async () => { syncCalled = true; },
  });
  await fn();
  assert.equal(syncCalled, false, "bei abgelehntem Zugriff wurde nichts persistiert — kein Refresh noetig");
  assert.match(els.dbV3EmailRunStatus.innerHTML, /Zugang verweigert/, "eine 401-Antwort muss verstaendlich sichtbar sein");
});

console.log("quantus-v3-email-briefing-button: alle Pruefungen bestanden");
