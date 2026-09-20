/* ══ Paket E2 — Ausweis an der vertrauenswuerdigen Grenze ═════════════════
 *
 * Geprueft wird gegen den ECHTEN lokalen Dienst mit ECHTEN RSA-Schluesseln,
 * die zur Laufzeit entstehen. Es gibt keinen Mock, der "ok" sagt: jedes
 * Token wird wirklich signiert und wirklich geprueft.
 *
 * Der wichtigste Fall steht weiter unten: ein gueltiges Token des
 * Task-Dienstkontos oeffnet NICHT den Scheduler-Einstieg. Jede Route hat
 * ihre eigene Kennung und ihre eigene Aufruferliste — kein Vollzugriff,
 * nur weil jemand irgendein zugelassenes Konto besitzt.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { verifyGoogleIdToken, readBearerToken, ALLOWED_ALGORITHMS } from "../runtime/quantus-v3/src/oidc.mjs";

const T = PLAN.wallTimeToMs("2026-09-19", 9, 0) + 2_000;

async function service(extraKeys = []) {
  const key = F.createSigningKey();
  const clock = F.createClock(T);
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const logs = [];
  const svc = await F.startService({
    role: "worker", logs,
    ports: {
      clock: clock.port, jwks: F.jwksPort(key, ...extraKeys), core: core.port,
      tasks: F.createTasksPort().port, sectionWork: F.createSectionWorkPort({ count: 1 }).port,
    },
  });
  return { key, clock, core, svc, logs };
}

const gut = (key, over = {}) => F.schedulerToken(key, { audience: F.AUD.slotStart, email: F.SA.schedulerStart, nowMs: T, ...over });

test("ein gueltiges Token des zugelassenen Kontos kommt durch", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  const res = await s.svc.post("/v3/slot/start", { token: gut(s.key), body: { slot: "process09" } });
  assert.equal(res.status, 200, res.text);
});

test("ein Token des FALSCHEN Dienstkontos oeffnet die Route nicht", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  // Das Task-Konto darf die Fortsetzung ausloesen — aber nicht den Start.
  const taskKonto = F.schedulerToken(s.key, { audience: F.AUD.slotStart, email: F.SA.tasks, nowMs: T });
  const res = await s.svc.post("/v3/slot/start", { token: taskKonto, body: { slot: "process09" } });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, "unauthenticated");
  const fremd = F.schedulerToken(s.key, { audience: F.AUD.slotStart, email: F.SA.fremd, nowMs: T });
  assert.equal((await s.svc.post("/v3/slot/start", { token: fremd, body: { slot: "process09" } })).status, 401);
});

test("ein Token fuer die falsche Kennung oeffnet die Route nicht", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  // Richtiges Konto, aber die Kennung der Fortsetzungsroute.
  const falscheAud = F.schedulerToken(s.key, { audience: F.AUD.runContinue, email: F.SA.schedulerStart, nowMs: T });
  const res = await s.svc.post("/v3/slot/start", { token: falscheAud, body: { slot: "process09" } });
  assert.equal(res.status, 401);
});

test("kein Token, kaputtes Token, fremder Aussteller, alg none, verbogener Inhalt", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  const faelle = {
    keins: undefined,
    leer: "",
    kaputt: "aaa.bbb.ccc",
    zweiTeile: "aaa.bbb",
    none: F.mintIdToken(s.key, { iss: "https://accounts.google.com", aud: F.AUD.slotStart, sub: "1", email: F.SA.schedulerStart, email_verified: true, iat: Math.floor(T / 1000), exp: Math.floor(T / 1000) + 600 }, { alg: "none" }),
    fremderAussteller: gut(s.key, { overrides: { iss: "https://evil.test.invalid" } }),
    abgelaufen: gut(s.key, { ttlS: -10 }),
    nichtVerifiziert: gut(s.key, { overrides: { email_verified: false } }),
    ohneEmail: gut(s.key, { overrides: { email: undefined } }),
    iatInDerZukunft: F.schedulerToken(s.key, { audience: F.AUD.slotStart, email: F.SA.schedulerStart, nowMs: T + 10 * 60_000 }),
    unbekannteKid: F.mintIdToken(s.key, { iss: "https://accounts.google.com", aud: F.AUD.slotStart, sub: "1", email: F.SA.schedulerStart, email_verified: true, iat: Math.floor(T / 1000), exp: Math.floor(T / 1000) + 600 }, { kid: "gibt-es-nicht" }),
  };
  for (const [name, token] of Object.entries(faelle)) {
    const res = await s.svc.post("/v3/slot/start", { token, body: { slot: "process09" } });
    assert.equal(res.status, 401, `${name}: ${res.text}`);
    assert.equal(res.json.error, "unauthenticated", name);
    assert.equal(res.json.detail, undefined, `${name}: die Absage darf keinen Grund verraten`);
  }
});

test("ein am Inhalt verbogenes Token mit gueltiger Signatur wird abgewiesen", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  const iat = Math.floor(T / 1000);
  const verbogen = F.mintIdToken(s.key, {
    iss: "https://accounts.google.com", aud: F.AUD.slotStart, sub: "1",
    email: F.SA.fremd, email_verified: true, iat, exp: iat + 600,
  }, { tamper: { email: F.SA.schedulerStart } });
  const res = await s.svc.post("/v3/slot/start", { token: verbogen, body: { slot: "process09" } });
  assert.equal(res.status, 401);
});

test("ein Token, das mit einem FREMDEN Schluessel unter bekannter kid signiert ist, faellt durch", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  const fremderSchluessel = F.createSigningKey(s.key.kid); // gleiche kid, anderes Schluesselpaar
  const iat = Math.floor(T / 1000);
  const token = F.mintIdToken(fremderSchluessel, {
    iss: "https://accounts.google.com", aud: F.AUD.slotStart, sub: "1",
    email: F.SA.schedulerStart, email_verified: true, iat, exp: iat + 600,
  }, { kid: s.key.kid });
  const res = await s.svc.post("/v3/slot/start", { token, body: { slot: "process09" } });
  assert.equal(res.status, 401);
});

test("eine mehrdeutige kid im Schluesselsatz wird nicht geraten", async (t) => {
  const zweiter = F.createSigningKey("test-key-1");   // dieselbe kid wie der erste
  const s = await service([zweiter]);
  t.after(() => s.svc.close());
  const res = await s.svc.post("/v3/slot/start", { token: gut(s.key), body: { slot: "process09" } });
  assert.equal(res.status, 401);
});

test("der Grund der Absage steht im Log, nicht in der Antwort", async (t) => {
  const s = await service();
  t.after(() => s.svc.close());
  await s.svc.post("/v3/slot/start", { token: gut(s.key, { overrides: { email_verified: false } }), body: { slot: "process09" } });
  const eintrag = s.logs.find((l) => l.status === 401);
  assert.ok(eintrag, "es gibt einen Logeintrag");
  assert.equal(eintrag.logDetail.reason, "email_not_verified");
});

/* ── Die reine Pruefung, ohne HTTP ─────────────────────────────────────── */

test("die Algorithmenliste ist fest und enthaelt kein none", () => {
  assert.deepEqual([...ALLOWED_ALGORITHMS], ["RS256"]);
  assert.equal(readBearerToken({ authorization: "Bearer abc.def.ghi" }), "abc.def.ghi");
  assert.equal(readBearerToken({ authorization: "bearer abc.def.ghi" }), null);
  assert.equal(readBearerToken({ authorization: "Basic abc" }), null);
  assert.equal(readBearerToken({}), null);
});

test("ohne konfigurierte Kennung oder Aufruferliste wird gar nicht erst geprueft", () => {
  const key = F.createSigningKey();
  const jwks = { keys: [key.jwk] };
  const token = gut(key);
  assert.throws(() => verifyGoogleIdToken(token, { audience: "", allowedServiceAccounts: [F.SA.schedulerStart], jwks, now: T }),
    (e) => e.status === 503 && e.error === "oidc_audience_not_configured");
  assert.throws(() => verifyGoogleIdToken(token, { audience: F.AUD.slotStart, allowedServiceAccounts: [], jwks, now: T }),
    (e) => e.status === 503 && e.error === "oidc_callers_not_configured");
  const ok = verifyGoogleIdToken(token, { audience: F.AUD.slotStart, allowedServiceAccounts: [F.SA.schedulerStart], jwks, now: T });
  assert.equal(ok.principal.email, F.SA.schedulerStart);
  assert.equal(ok.principal.kind, "service");
  assert.equal(ok.principal.issuedVia, "google_oidc");
});

test("die Rolle steht NICHT im Token — sie kommt aus der Routenkonfiguration", () => {
  const key = F.createSigningKey();
  const jwks = { keys: [key.jwk] };
  // Ein Token, das eine Rolle behauptet, bekommt sie dadurch nicht.
  const token = gut(key, { overrides: { role: "admin", roles: ["owner"], tenant: "fremd", scopes: ["*"] } });
  const ok = verifyGoogleIdToken(token, { audience: F.AUD.slotStart, allowedServiceAccounts: [F.SA.schedulerStart], jwks, now: T });
  assert.deepEqual(Object.keys(ok.principal).sort(), ["audience", "email", "expiresAtMs", "issuedVia", "kind", "subject"]);
  assert.equal(ok.principal.role, undefined);
  assert.equal(ok.principal.tenant, undefined);
});
