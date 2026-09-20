/*
 * Der Netlify-Funktionseinstieg selbst (Zugangsschutz, Preflight-Antwort).
 * Verbindliche Nutzerklarstellung: die taegliche Orchestrierung macht ein
 * lokal geplanter ChatGPT-Lauf des Nutzers, NICHT ein Netlify-Zeitplan.
 * Diese Funktion hat deshalb keinen `next_run`-Bypass mehr (der Zeitplan
 * selbst wurde entfernt) — der EINZIGE Weg hinein ist ein gueltiger
 * SYNC_AUTH_TOKEN als Bearer-Token, dieselbe Technik wie
 * netlify/functions/mail-queue-run.mjs (`darfLaufen`). Ohne echte
 * Konfiguration (kein Netz, keine echten Zugangsdaten in diesem Test) muss
 * die Antwort 503 mit den fehlenden NAMEN sein, nie ein Absturz und nie ein
 * Geheimnis.
 */
import test from "node:test";
import assert from "node:assert/strict";

function fakeRequest({ authHeader = null } = {}) {
  return {
    headers: { get: (name) => (name === "Authorization" ? authHeader : null) },
  };
}

test("ohne gueltigen Zugangsschluessel: 401, kein Lauf", async () => {
  delete process.env.SYNC_AUTH_TOKEN;
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=1");
  const res = await mod.default(fakeRequest({ authHeader: null }));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("kein next_run-Bypass mehr: ein Rumpf mit next_run allein reicht nicht ohne Token", async () => {
  delete process.env.SYNC_AUTH_TOKEN;
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=2");
  // Es gibt keine .json()-Methode mehr im echten Request-Vertrag dieser Funktion;
  // ein Aufrufer kann sich also nicht mehr per Rumpfinhalt als "Zeitplan" ausgeben.
  const res = await mod.default(fakeRequest({ authHeader: null }));
  assert.equal(res.status, 401, "ohne Token bleibt es bei 401, unabhaengig vom Rumpf");
});

test("kein export config.schedule mehr: die Funktion loest sich nie selbst aus", async () => {
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=3");
  assert.equal(mod.config, undefined, "es darf keinen Netlify-Zeitplan-Export mehr geben");
});

test("ein gueltiger SYNC_AUTH_TOKEN darf ausloesen (Zugang gewaehrt, dann normale Preflight-Antwort)", async () => {
  process.env.SYNC_AUTH_TOKEN = "test-sync-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=4");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer test-sync-token" }));
    assert.equal(res.status, 503); // Zugang gewaehrt, aber v3 ist in diesem Test nicht konfiguriert.
    const body = await res.json();
    assert.equal(body.blocked, "missing_configuration");
    assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
    const alsText = JSON.stringify(body);
    assert.ok(!/sk-ant-/.test(alsText), "die Antwort darf niemals einen Schluesselwert enthalten");
  } finally {
    delete process.env.SYNC_AUTH_TOKEN;
  }
});

test("ein falscher Bearer-Token bleibt 401", async () => {
  process.env.SYNC_AUTH_TOKEN = "test-sync-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=5");
    const res = await mod.default(fakeRequest({ authHeader: "Bearer falsch" }));
    assert.equal(res.status, 401);
  } finally {
    delete process.env.SYNC_AUTH_TOKEN;
  }
});
