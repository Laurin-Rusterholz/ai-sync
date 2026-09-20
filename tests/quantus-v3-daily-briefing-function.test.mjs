/*
 * Der Netlify-Funktionseinstieg selbst (Zugangsschutz, Preflight-Antwort)
 * — dieselbe Zugangstechnik wie netlify/functions/mail-queue-run.mjs
 * (`darfLaufen`): der Zeitplan (`next_run` im Rumpf) oder ein vorhandener
 * SYNC_AUTH_TOKEN duerfen ausloesen, sonst 401. Ohne echte Konfiguration
 * (kein Netz, keine echten Zugangsdaten in diesem Test) muss die Antwort
 * 503 mit den fehlenden NAMEN sein, nie ein Absturz und nie ein Geheimnis.
 */
import test from "node:test";
import assert from "node:assert/strict";

function fakeRequest({ body = null, authHeader = null } = {}) {
  return {
    async json() { if (body === null) throw new Error("no body"); return body; },
    headers: { get: (name) => (name === "Authorization" ? authHeader : null) },
  };
}

test("ohne Zeitplan-Kennzeichen und ohne gueltigen Zugangsschluessel: 401, kein Lauf", async () => {
  delete process.env.SYNC_AUTH_TOKEN;
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=1");
  const res = await mod.default(fakeRequest({ body: {}, authHeader: null }));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("mit dem Zeitplan-Kennzeichen (next_run) und ohne v3-Konfiguration: 503 mit NUR den fehlenden Namen", async () => {
  const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=2");
  const res = await mod.default(fakeRequest({ body: { next_run: "2026-09-22T02:00:00.000Z" } }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.blocked, "missing_configuration");
  assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
  const alsText = JSON.stringify(body);
  assert.ok(!/sk-ant-/.test(alsText), "die Antwort darf niemals einen Schluesselwert enthalten");
});

test("ein gueltiger SYNC_AUTH_TOKEN darf ausloesen (Zugang gewaehrt, dann normale Preflight-Antwort)", async () => {
  process.env.SYNC_AUTH_TOKEN = "test-sync-token";
  try {
    const mod = await import("../netlify/functions/quantus-v3-daily-briefing-run.mjs?case=3");
    const res = await mod.default(fakeRequest({ body: {}, authHeader: "Bearer test-sync-token" }));
    assert.equal(res.status, 503); // Zugang gewaehrt, aber v3 ist in diesem Test nicht konfiguriert.
    const body = await res.json();
    assert.equal(body.blocked, "missing_configuration");
  } finally {
    delete process.env.SYNC_AUTH_TOKEN;
  }
});
