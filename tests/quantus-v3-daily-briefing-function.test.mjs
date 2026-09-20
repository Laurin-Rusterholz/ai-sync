/*
 * Der Netlify-Funktionseinstieg selbst (Zugangsschutz, Preflight-Antwort).
 * Verbindliche Nutzerklarstellung: die taegliche Orchestrierung macht ein
 * lokal geplanter ChatGPT-Lauf des Nutzers, NICHT ein Netlify-Zeitplan.
 * Diese Funktion hat deshalb keinen `next_run`-Bypass mehr (der Zeitplan
 * selbst wurde entfernt).
 *
 * ZUGANGSSCHLUESSEL, getrennt von den Alt-Endpunkten: `SYNC_AUTH_TOKEN` ist
 * in Netlify aktuell NICHT gesetzt. Ihn jetzt neu zu setzen wuerde alle
 * bestehenden Gmail/gcal/blob-Endpunkte (die ueber gcal-shared.mjs
 * `requireAuth` OHNE Token als "offen" behandeln) ploetzlich sperren — eine
 * echte Regression. Deshalb bevorzugt dieser Endpunkt einen EIGENEN
 * `QUANTUS_EMAIL_AUTH_TOKEN` und akzeptiert `SYNC_AUTH_TOKEN` nur als
 * Ruckfall, falls der ohnehin schon gesetzt ist. Ohne echte Konfiguration
 * (kein Netz, keine echten Zugangsdaten in diesem Test) muss die Antwort
 * 503 mit den fehlenden NAMEN sein, nie ein Absturz und nie ein Geheimnis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth } from "../netlify/lib/gcal-shared.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FUNKTIONSDATEI = path.join(root, "netlify/functions/quantus-v3-daily-briefing-run.mjs");

function fakeRequest({ authHeader = null } = {}) {
  return {
    headers: { get: (name) => (name === "Authorization" ? authHeader : null) },
  };
}

function clearEnv() {
  delete process.env.SYNC_AUTH_TOKEN;
  delete process.env.QUANTUS_EMAIL_AUTH_TOKEN;
}

test("ohne jede Konfiguration: 503 GESPERRT (fail closed), kein 'offen ohne Token' wie bei den Alt-Endpunkten", async () => {
  clearEnv();
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=1");
  const res = await mod.default(fakeRequest({ authHeader: null }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "GESPERRT");
});

test("ein falscher Bearer-Token bleibt 401 (QUANTUS_EMAIL_AUTH_TOKEN gesetzt)", async () => {
  clearEnv();
  process.env.QUANTUS_EMAIL_AUTH_TOKEN = "email-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=2");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer falsch" }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "KEIN_ZUGANG");
  } finally { clearEnv(); }
});

test("QUANTUS_EMAIL_AUTH_TOKEN (bevorzugt) darf ausloesen, dann normale Preflight-Antwort", async () => {
  clearEnv();
  process.env.QUANTUS_EMAIL_AUTH_TOKEN = "email-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=3");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer email-token" }));
    assert.equal(res.status, 503); // Zugang gewaehrt, aber v3 ist in diesem Test nicht konfiguriert.
    const body = await res.json();
    assert.equal(body.blocked, "missing_configuration");
    assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
    const alsText = JSON.stringify(body);
    assert.ok(!/sk-ant-/.test(alsText), "die Antwort darf niemals einen Schluesselwert enthalten");
  } finally { clearEnv(); }
});

test("SYNC_AUTH_TOKEN als Ruckfall darf ausloesen, NUR wenn kein QUANTUS_EMAIL_AUTH_TOKEN gesetzt ist", async () => {
  clearEnv();
  process.env.SYNC_AUTH_TOKEN = "sync-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=4");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer sync-token" }));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.blocked, "missing_configuration");
  } finally { clearEnv(); }
});

test("ist QUANTUS_EMAIL_AUTH_TOKEN gesetzt, zaehlt der alte SYNC_AUTH_TOKEN-Wert allein nicht mehr", async () => {
  clearEnv();
  process.env.QUANTUS_EMAIL_AUTH_TOKEN = "email-token";
  process.env.SYNC_AUTH_TOKEN = "sync-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=5");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer sync-token" }));
    assert.equal(res.status, 401, "QUANTUS_EMAIL_AUTH_TOKEN hat Vorrang — der SYNC-Wert allein reicht dann nicht mehr");
  } finally { clearEnv(); }
});

test("kein export config.schedule mehr: die Funktion loest sich nie selbst aus", async () => {
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=6");
  assert.equal(mod.config, undefined, "es darf keinen Netlify-Zeitplan-Export mehr geben");
});

// ── Keine Regression an den Alt-Endpunkten: QUANTUS_EMAIL_AUTH_TOKEN ist ein
// eigener Name und wird von requireAuth() (gcal-shared.mjs, Basis von
// Gmail/gcal/blob-put) nicht gelesen — dessen "offen ohne Token"-Verhalten
// bleibt unveraendert, auch wenn der neue Schluessel gesetzt ist. ──────────
test("keine neue globale Zugangssperre: QUANTUS_EMAIL_AUTH_TOKEN beeinflusst requireAuth() (Alt-Endpunkte) nicht", () => {
  clearEnv();
  process.env.QUANTUS_EMAIL_AUTH_TOKEN = "email-token";
  try {
    const req = { headers: { get: () => null } }; // kein Authorization-Header
    const res = requireAuth(req);
    assert.equal(res, null, "requireAuth() muss ohne SYNC_AUTH_TOKEN weiterhin durchlassen (offen), unabhaengig vom neuen Schluessel");
  } finally { clearEnv(); }
});

// ── Kein DB-/Provider-Zugriff vor bestandener Tuer: strukturell (Reihenfolge
// im Quelltext) UND verhaltensbasiert (ein absichtlich werfendes fetch darf
// bei 401/503 nie ausgeloest werden). ───────────────────────────────────────
test("Quelltext-Reihenfolge: die Zugangspruefung steht vor Preflight und vor runDailyBriefing()", () => {
  const src = fs.readFileSync(FUNKTIONSDATEI, "utf8");
  const posZugang = src.indexOf("const zugang = pruefeZugang(req);");
  const posConfig = src.indexOf("checkDailyBriefingConfig()");
  const posRun = src.indexOf("runDailyBriefing(");
  assert.ok(posZugang > 0 && posConfig > posZugang && posRun > posConfig,
    "die Reihenfolge muss Zugang -> Preflight -> Lauf sein, sonst koennte ein unautorisierter Aufruf Provider/DB erreichen");
});

test("ein abgelehnter Zugriff (401) ruft niemals fetch auf (kein Provider-/DB-Kontakt)", async () => {
  clearEnv();
  process.env.QUANTUS_EMAIL_AUTH_TOKEN = "email-token";
  const echtesFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fetch haette hier NIE aufgerufen werden duerfen"); };
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=7");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer falsch" }));
    assert.equal(res.status, 401);
  } finally {
    globalThis.fetch = echtesFetch;
    clearEnv();
  }
});
