/* ══ E2 — JWKS und Cloud Tasks mit der vorhandenen Google-Identitaet ══════
 *
 * Zwei Strecken, beide ohne neue Zugangsdaten:
 *
 *  · JWKS ist oeffentlich. Geprueft wird, dass ein unbrauchbares Dokument
 *    NICHT angenommen wird, dass ein abgelaufener Stand nicht
 *    weitergereicht wird, und dass parallele Anfragen einen Abruf teilen.
 *  · Cloud Tasks braucht ein Token. Es kommt aus dem vorhandenen Export
 *    `getIdentityAccessToken` von firebase-admin (C3b f39cad2), Scope
 *    `cloud-platform`. Hier wird nichts nachgebaut: fehlt der Export oder
 *    die Zugangsaufloesung, gibt es keinen Transport, sondern einen Grund.
 *
 * Kein Netz, kein echtes Projekt, kein echtes Token: `fetch` und der
 * Export sind eingespeist, alle Werte sind synthetisch. Die Uhr ist eine
 * Testuhr und wird nirgends mit der Wanduhr gemischt.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createGoogleJwksPort, createGoogleAccessTokenSource, createCloudTasksHttpTransport,
  GOOGLE_JWKS_URL, CLOUD_PLATFORM_SCOPE, JWKS_MIN_TTL_MS, JWKS_MAX_TTL_MS, TOKEN_MARGIN_MS,
} from "../runtime/quantus-v3/src/google-transport.mjs";
import { createCloudTasksPort } from "../runtime/quantus-v3/src/integration-ports.mjs";

const T0 = Date.parse("2026-09-19T09:00:00Z");
const QUEUE = "projects/test-invalid/locations/europe-west6/queues/quantus-v3-continuations";

function uhr(start = T0) {
  let jetzt = start;
  return { now: () => jetzt, advance(ms) { jetzt += ms; }, set(v) { jetzt = v; } };
}

function jwksDoc(over = {}) {
  return { keys: [{ kid: "k1", kty: "RSA", alg: "RS256", use: "sig", n: "abc", e: "AQAB", ...over }] };
}

function antwort(body, { status = 200, cacheControl = null } = {}) {
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "cache-control" ? cacheControl : null) },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

/* ── JWKS ─────────────────────────────────────────────────────────────── */

test("JWKS: gueltige Schluessel, gecacht bis zu dem von Google genannten Ablauf", async () => {
  const c = uhr();
  const rufe = [];
  const port = createGoogleJwksPort({
    now: c.now,
    fetchImpl: async (url) => { rufe.push(url); return antwort(jwksDoc(), { cacheControl: "public, max-age=3600" }); },
  });
  assert.equal(port.available, true);
  const erst = await port.impl.getKeys();
  assert.equal(erst.keys.length, 1);
  assert.equal(erst.keys[0].kid, "k1");
  assert.equal(rufe[0], GOOGLE_JWKS_URL);

  c.advance(3_599_000);
  await port.impl.getKeys();
  assert.equal(rufe.length, 1, "innerhalb der Frist wird nicht neu geholt");

  c.advance(2_000);
  await port.impl.getKeys();
  assert.equal(rufe.length, 2, "nach Ablauf wird neu geholt");
});

test("JWKS: die Frist wird begrenzt, nicht geglaubt", async () => {
  const c = uhr();
  const rufe = [];
  const port = createGoogleJwksPort({
    now: c.now,
    fetchImpl: async () => { rufe.push(1); return antwort(jwksDoc(), { cacheControl: "max-age=999999" }); },
  });
  await port.impl.getKeys();
  c.advance(JWKS_MAX_TTL_MS + 1);
  await port.impl.getKeys();
  assert.equal(rufe.length, 2);

  const c2 = uhr();
  const rufe2 = [];
  const ohne = createGoogleJwksPort({
    now: c2.now,
    fetchImpl: async () => { rufe2.push(1); return antwort(jwksDoc()); },
  });
  await ohne.impl.getKeys();
  c2.advance(JWKS_MIN_TTL_MS + 1);
  await ohne.impl.getKeys();
  assert.equal(rufe2.length, 2, "ohne Angabe gilt die kurze Mindestfrist");
});

test("JWKS: ein unbrauchbares Dokument wird nicht angenommen und nicht gemerkt", async () => {
  const faelle = [
    [{ keys: [] }, "jwks_invalid"],
    [{ keys: [{ kid: "k1", kty: "EC", n: "a", e: "b" }] }, "jwks_invalid"],
    [{ keys: [{ kid: "k1", kty: "RSA", n: "a", e: "b", alg: "RS512" }] }, "jwks_invalid"],
    [{ keys: [{ kid: "k1", kty: "RSA", n: "a", e: "b" }, { kid: "k1", kty: "RSA", n: "c", e: "d" }] }, "jwks_invalid"],
    [{ keys: [{ kty: "RSA", n: "a", e: "b" }] }, "jwks_invalid"],
    ["kein json", "jwks_unavailable"],
  ];
  for (const [doc, error] of faelle) {
    const port = createGoogleJwksPort({ now: uhr().now, fetchImpl: async () => antwort(doc) });
    await assert.rejects(() => port.impl.getKeys(), (e) => e.status === 503 && e.error === error, JSON.stringify(doc));
    assert.equal(port.impl.state().cached, false, "ein Fehlschlag hinterlaesst keinen Stand");
  }
});

test("JWKS: ein Ausfall reicht keinen alten Stand weiter", async () => {
  const c = uhr();
  let kaputt = false;
  const port = createGoogleJwksPort({
    now: c.now,
    fetchImpl: async () => { if (kaputt) throw new Error("netz"); return antwort(jwksDoc(), { cacheControl: "max-age=60" }); },
  });
  await port.impl.getKeys();
  kaputt = true;
  c.advance(120_000);
  await assert.rejects(() => port.impl.getKeys(), (e) => e.error === "jwks_unavailable");
  assert.equal(port.impl.state().cached, false);
});

test("JWKS: parallele Anfragen teilen einen Abruf", async () => {
  let rufe = 0;
  let loese;
  const port = createGoogleJwksPort({
    now: uhr().now,
    fetchImpl: async () => { rufe++; await new Promise((r) => { loese = r; }); return antwort(jwksDoc()); },
  });
  const a = port.impl.getKeys();
  const b = port.impl.getKeys();
  loese();
  await Promise.all([a, b]);
  assert.equal(rufe, 1);
});

test("JWKS: ohne fetch gibt es den Port nicht", () => {
  const port = createGoogleJwksPort({ fetchImpl: null });
  assert.equal(port.available, false);
  assert.equal(port.reason, "google_jwks_fetch_not_available");
});

/* ── Zugriffstoken aus der vorhandenen Identitaet ─────────────────────── */

function adminModul({ token = "synthetisches-testtoken", scope = CLOUD_PLATFORM_SCOPE, expiresAt = T0 + 3600_000, konfiguriert = true, wirft = false, ohneExport = false } = {}) {
  const modul = { firebaseAccessCredentialsConfigured: () => konfiguriert };
  if (!ohneExport) {
    modul.getIdentityAccessToken = async (opts) => {
      modul.letzterScope = opts?.scope ?? null;
      if (wirft) throw Object.assign(new Error("geheimnis-im-text-xyz"), { code: "credentials_missing" });
      return { token, scope, expiresAt: typeof expiresAt === "function" ? expiresAt() : expiresAt, projectId: "p", source: "service_account" };
    };
  }
  return modul;
}

test("Token: ohne den Export oder ohne Zugangsdaten gibt es keine Quelle", async () => {
  assert.equal((await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => adminModul({ ohneExport: true }) })).reason,
    "missing_export:getIdentityAccessToken");
  assert.equal((await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => adminModul({ konfiguriert: false }) })).reason,
    "google_credentials_not_configured");
  assert.equal((await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => { throw new Error("weg"); } })).reason,
    "firebase_admin_not_available");
});

test("Token: der vorhandene Export wird mit cloud-platform gerufen und gecacht", async () => {
  const c = uhr();
  // Die Frist haengt an der TESTUHR, nicht an einer festen Zahl.
  const modul = adminModul({ expiresAt: () => c.now() + 3600_000 });
  let rufe = 0;
  const original = modul.getIdentityAccessToken;
  modul.getIdentityAccessToken = async (o) => { rufe++; return original(o); };
  const quelle = await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => modul, now: c.now });
  assert.equal(quelle.ok, true);
  assert.equal(quelle.scope, CLOUD_PLATFORM_SCOPE);
  assert.equal(await quelle.get(), "synthetisches-testtoken");
  assert.equal(modul.letzterScope, CLOUD_PLATFORM_SCOPE);
  assert.equal(await quelle.get(), "synthetisches-testtoken");
  assert.equal(rufe, 1, "innerhalb der Frist wird nicht neu erworben");
  c.advance(3600_000 - TOKEN_MARGIN_MS + 1);
  await quelle.get();
  assert.equal(rufe, 2, "vor Ablauf der Marge wird erneuert");
});

test("Token: falscher Scope, fehlende Frist und abgelaufenes Token werden abgewiesen", async () => {
  const faelle = [
    [{ scope: "https://www.googleapis.com/auth/identitytoolkit" }, "google_token_scope_missing"],
    [{ expiresAt: "bald" }, "google_token_lifetime_invalid"],
    [{ expiresAt: T0 + TOKEN_MARGIN_MS - 1 }, "google_token_expired"],
    [{ token: "" }, "google_token_failed"],
    [{ wirft: true }, "google_token_failed"],
  ];
  for (const [over, error] of faelle) {
    const quelle = await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => adminModul(over), now: uhr().now });
    await assert.rejects(() => quelle.get(), (e) => {
      assert.equal(e.status, 503);
      assert.equal(e.error, error);
      // Kein fremder Text nach aussen.
      assert.ok(!String(e.message).includes("geheimnis-im-text-xyz"));
      return true;
    }, error);
  }
});

test("Token: ein langsamer Erwerb wird gegen FRISCHE Zeit geprueft", async () => {
  const c = uhr();
  const modul = adminModul({ expiresAt: T0 + 120_000 });
  const original = modul.getIdentityAccessToken;
  modul.getIdentityAccessToken = async (o) => { c.advance(121_000); return original(o); };
  const quelle = await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => modul, now: c.now });
  await assert.rejects(() => quelle.get(), (e) => e.error === "google_token_expired");
});

/* ── Cloud-Tasks-Transport ────────────────────────────────────────────── */

async function transportAufbau({ allow = true, antwortStatus = 200, rumpf = { name: "x" } } = {}) {
  const gesendet = [];
  const quelle = await createGoogleAccessTokenSource({ loadFirebaseAdmin: async () => adminModul(), now: uhr().now });
  const gebaut = createCloudTasksHttpTransport({
    accessTokenSource: quelle,
    allowExternalEffects: allow,
    fetchImpl: async (url, init) => {
      gesendet.push({ url, init });
      return { status: antwortStatus, async text() { return JSON.stringify(rumpf); } };
    },
  });
  return { gebaut, gesendet };
}

test("Tasks: ohne freigegebene Aussenwirkung gibt es keinen Transport", async () => {
  const { gebaut } = await transportAufbau({ allow: false });
  assert.equal(gebaut.ok, false);
  assert.equal(gebaut.reason, "external_effects_not_allowed");
  assert.equal(gebaut.transport, null);
  // Und der Port daraus ist leer, nicht still erfolgreich.
  assert.equal(createCloudTasksPort({ transport: gebaut.transport }).available, false);
});

test("Tasks: ohne Tokenquelle gibt es keinen Transport", () => {
  assert.equal(createCloudTasksHttpTransport({ allowExternalEffects: true }).reason, "google_access_token_not_available");
});

test("Tasks: die Anfrage geht mit Bearer an Cloud Tasks, Antwort wird nicht geschoent", async () => {
  const { gebaut, gesendet } = await transportAufbau({ antwortStatus: 200, rumpf: { name: `${QUEUE}/tasks/t1` } });
  assert.equal(gebaut.ok, true);
  const port = createCloudTasksPort({ transport: gebaut.transport });
  const out = await port.impl.enqueueContinuation({
    taskId: "c-test", runKey: "quantus:2026-09-19:process09:3.0", continuationId: "cont:1",
    scheduleAtMs: T0, queue: QUEUE, targetUrl: "https://worker.run.app/run",
    oidcServiceAccount: "runner@test-invalid.iam.gserviceaccount.com", audience: "https://worker.run.app/run",
  });
  assert.equal(out.enqueued, true);
  assert.equal(gesendet.length, 1);
  assert.equal(gesendet[0].url, `https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
  assert.equal(gesendet[0].init.headers.authorization, "Bearer synthetisches-testtoken");
  const payload = JSON.parse(gesendet[0].init.body);
  assert.equal(payload.task.name, `${QUEUE}/tasks/c-test`);
  assert.equal(payload.task.httpRequest.oidcToken.serviceAccountEmail, "runner@test-invalid.iam.gserviceaccount.com");
});

test("Tasks: ALREADY_EXISTS ist eine Dublette, alles andere ein Fehler", async () => {
  const dublette = await transportAufbau({ antwortStatus: 409, rumpf: { error: { status: "ALREADY_EXISTS" } } });
  const portA = createCloudTasksPort({ transport: dublette.gebaut.transport });
  const out = await portA.impl.enqueueContinuation({
    taskId: "c-test", runKey: "quantus:2026-09-19:process09:3.0", continuationId: "cont:1",
    queue: QUEUE, targetUrl: "https://worker.run.app/run",
    oidcServiceAccount: "runner@test-invalid.iam.gserviceaccount.com",
  });
  assert.equal(out.duplicate, true);
  assert.equal(out.enqueued, false);

  const fehler = await transportAufbau({ antwortStatus: 403, rumpf: { error: { status: "PERMISSION_DENIED" } } });
  const portB = createCloudTasksPort({ transport: fehler.gebaut.transport });
  await assert.rejects(() => portB.impl.enqueueContinuation({
    taskId: "c-test", runKey: "quantus:2026-09-19:process09:3.0", continuationId: "cont:1",
    queue: QUEUE, targetUrl: "https://worker.run.app/run",
    oidcServiceAccount: "runner@test-invalid.iam.gserviceaccount.com",
  }), (e) => e.status === 502 && e.error === "task_enqueue_failed");
});

test("Tasks: eine fremde Ziel-Adresse verlaesst den Prozess nicht", async () => {
  const { gebaut, gesendet } = await transportAufbau();
  await assert.rejects(() => gebaut.transport.createTask({ url: "https://anderswo.example/v2/x", method: "POST", payload: {} }),
    (e) => e.status === 500 && e.error === "cloud_tasks_url_invalid");
  await assert.rejects(() => gebaut.transport.createTask({ url: "https://cloudtasks.googleapis.com/v2/x", method: "GET", payload: {} }),
    (e) => e.error === "cloud_tasks_method_invalid");
  assert.equal(gesendet.length, 0);
});
