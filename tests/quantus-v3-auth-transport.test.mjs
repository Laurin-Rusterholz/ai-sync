/*
 * v3 C1 — Transport: TLS, Herkunft, Grösse, striktes JSON, Ratenbegrenzung.
 *
 * BEFUND, aus dem diese Tests folgen: Die bestehende Blob-Fassade antwortet
 * mit `Access-Control-Allow-Origin: *`. Für einen öffentlichen Lesepfad mag
 * das hinnehmbar sein; für einen Befehlsweg, der Aufträge annimmt, ist es das
 * nicht. Gleichzeitig darf die Gegenbewegung nicht dazu führen, dass legitime
 * Server-Jobs — Cloud Run, Scheduler, Worker, die gar keine Origin senden —
 * pauschal ausgeschlossen werden.
 *
 * Deshalb wird hier beides geprüft: dass ein Browser ohne erlaubte Origin
 * abgewiesen wird, UND dass ein originloser Dienstaufruf durchkommt — und dass
 * CORS dabei nie die Authentisierung ersetzt.
 *
 * Und die Ratenbegrenzung: ein Zähler im Arbeitsspeicher zählt pro Instanz.
 * Ihn als Schutz auszugeben wäre eine Zusicherung, die niemand einhält.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuthConfig, enforceTls, evaluateOrigin, enforceJsonCommand,
  requireHandlerRateLimiter, rateLimitKey, createInMemoryRateLimiter,
  COMMAND_MAX_BYTES, RATE_LIMIT_CONTRACT, verifyServiceCredential,
} from "../netlify/lib/quantus-v3-auth.mjs";
import { makeEnv, TENANT } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const APP = "https://management-xo2-pro.netlify.app";
const env = makeEnv({ tenant: TENANT, origins: `${APP},https://quantus.example` });
const { config } = resolveAuthConfig(env.read);

function req({ url = "https://example.netlify.app/.netlify/functions/quantus-ingest", proto = null } = {}) {
  const kopf = new Map();
  if (proto) kopf.set("x-forwarded-proto", proto);
  return { url, headers: { get: (n) => kopf.get(String(n).toLowerCase()) ?? null } };
}

test("TLS ist Pflicht", () => {
  assert.equal(enforceTls(req({ proto: "https" })).ok, true);
  assert.equal(enforceTls(req({ proto: "https,http" })).ok, true, "die erste Angabe zählt");
  assert.equal(enforceTls(req()).ok, true, "https-URL ohne Kopfzeile");

  for (const r of [req({ proto: "http" }), req({ url: "http://example.test/x" }), req({ url: "kaputt" })]) {
    const res = enforceTls(r);
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "tls_required");
  }
  // Eine http-Weiterleitung hinter https-URL zählt NICHT als TLS.
  assert.equal(enforceTls(req({ proto: "http" })).reason, "tls_required");
});

test("Browser: nur erlaubte Origin, und die Absage verrät nichts", () => {
  const ok = evaluateOrigin({ origin: APP, principalKind: "user", config });
  assert.equal(ok.ok, true);
  assert.equal(ok.corsHeaders["Access-Control-Allow-Origin"], APP);
  assert.equal(ok.corsHeaders.Vary, "Origin");
  assert.notEqual(ok.corsHeaders["Access-Control-Allow-Origin"], "*");

  for (const origin of [
    "https://boese.example",
    "https://management-xo2-pro.netlify.app.boese.example",
    "http://management-xo2-pro.netlify.app",
    `${APP}/`,
    "null",
  ]) {
    const res = evaluateOrigin({ origin, principalKind: "user", config });
    assert.equal(res.ok, false, `${origin} wurde erlaubt`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "origin_not_allowed");
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(origin), "die Absage spiegelt die Origin zurück");
    assert.ok(!text.includes("netlify.app"), "die Absage verrät die erlaubten Origins");
    assert.equal(res.corsHeaders, undefined, "eine abgelehnte Anfrage bekommt CORS-Kopfzeilen");
  }
});

test("originlos: Nutzer nein, Dienst ja — beides bewusst", () => {
  // Ein Nutzer-Token ohne Origin kommt nicht aus der App.
  const nutzer = evaluateOrigin({ origin: "", principalKind: "user", config });
  assert.equal(nutzer.status, 403);
  assert.equal(nutzer.reason, "origin_required");

  // Server-zu-Server hat keine Origin. Das ist der Normalfall, kein Verdacht.
  for (const kind of ["service", "worker"]) {
    const res = evaluateOrigin({ origin: undefined, principalKind: kind, config });
    assert.equal(res.ok, true, `${kind} wurde pauschal ausgeschlossen`);
    assert.equal(res.originless, true);
    assert.equal(res.corsHeaders, null, "ein originloser Dienst bekommt keine CORS-Kopfzeile");
  }

  // Schickt ein Dienst DOCH eine Origin, muss auch sie passen.
  assert.equal(evaluateOrigin({ origin: "https://boese.example", principalKind: "service", config }).status, 403);
  assert.equal(evaluateOrigin({ origin: APP, principalKind: "service", config }).ok, true);

  // Unbekannte Principal-Art ⇒ zu.
  assert.equal(evaluateOrigin({ origin: "", principalKind: "irgendwas", config }).status, 403);
  assert.equal(evaluateOrigin({ origin: APP, principalKind: "user" }).status, 503, "ohne Config kein Ja");
});

test("CORS ersetzt keine Authentisierung", () => {
  // Erlaubte Origin, aber kein gültiges Zugangsdatum ⇒ 401.
  const origin = evaluateOrigin({ origin: APP, principalKind: "user", config });
  assert.equal(origin.ok, true);
  const ausweis = verifyServiceCredential("", { config });
  assert.equal(ausweis.status, 401);
  // Und umgekehrt: gültiges Zugangsdatum von falscher Origin ⇒ 403.
  const gut = verifyServiceCredential(env.secrets.service.scheduler, { config });
  assert.equal(gut.ok, true);
  assert.equal(evaluateOrigin({ origin: "https://boese.example", principalKind: gut.principal.kind, config }).status, 403);
});

test("Kommando: striktes JSON, 64 KiB, Objekt", () => {
  const ok = enforceJsonCommand({ contentType: "application/json; charset=utf-8", rawBody: '{"aktion":"lesen"}' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { aktion: "lesen" });

  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "", "multipart/form-data", "application/json5"]) {
    const res = enforceJsonCommand({ contentType: ct, rawBody: "{}" });
    assert.equal(res.status, 415, `Content-Type ${ct} akzeptiert`);
  }
  for (const body of ["", "nicht json", "{unquoted:1}", "{\"a\":1,}"]) {
    assert.equal(enforceJsonCommand({ contentType: "application/json", rawBody: body }).reason, "invalid_json");
  }
  for (const body of ["[1,2,3]", '"text"', "42", "null", "true"]) {
    assert.equal(enforceJsonCommand({ contentType: "application/json", rawBody: body }).reason, "json_must_be_object");
  }
  assert.equal(enforceJsonCommand({ contentType: "application/json", rawBody: '{"__proto__":{"role":"user"}}' }).reason,
    "prototype_key_forbidden");

  // Genau an der Grenze: 64 KiB gehen, ein Byte mehr nicht — gemessen in
  // UTF-8-Bytes, nicht in JS-Zeichen.
  const fuellung = (n) => JSON.stringify({ t: "x".repeat(n) });
  const grenze = COMMAND_MAX_BYTES - Buffer.byteLength(fuellung(0), "utf8");
  assert.equal(enforceJsonCommand({ contentType: "application/json", rawBody: fuellung(grenze) }).bytes, COMMAND_MAX_BYTES);
  assert.equal(enforceJsonCommand({ contentType: "application/json", rawBody: fuellung(grenze) }).ok, true);
  const zuGross = enforceJsonCommand({ contentType: "application/json", rawBody: fuellung(grenze + 1) });
  assert.equal(zuGross.status, 413);
  assert.equal(zuGross.reason, "command_too_large");

  // Umlaute zählen doppelt: 33'000 Zeichen sind 66'000 Bytes.
  const umlaute = JSON.stringify({ t: "ä".repeat(33_000) });
  assert.ok(umlaute.length < COMMAND_MAX_BYTES, "der Test misst sonst gar nichts");
  assert.equal(enforceJsonCommand({ contentType: "application/json", rawBody: umlaute }).status, 413);
});

test("Ratenbegrenzung: In-Memory zählt nicht als Schutz", () => {
  const speicher = createInMemoryRateLimiter();
  assert.equal(speicher.multiInstanceSafe, false);
  assert.equal(speicher.scope, "instance");

  const res = requireHandlerRateLimiter(speicher);
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.reason, "rate_limiter_not_shared");

  assert.equal(requireHandlerRateLimiter(null).reason, "rate_limiter_missing");
  assert.equal(requireHandlerRateLimiter({}).reason, "rate_limiter_missing");
  assert.equal(requireHandlerRateLimiter({ increment() {}, scope: "shared" }).reason, "rate_limiter_not_atomic");
  assert.equal(requireHandlerRateLimiter({ increment() {}, atomic: true, scope: "shared" }).ok, true);

  // Der Vertrag steht im Code und nennt das Wesentliche.
  assert.ok(RATE_LIMIT_CONTRACT.required.some((z) => /atomar|unteilbar/i.test(z)));
  assert.ok(RATE_LIMIT_CONTRACT.required.some((z) => /Instanzen/i.test(z)));
});

test("Zählerschlüssel hängt am Principal, nicht an der Adresse", () => {
  const principal = { id: "uid-laurin", tenant: TENANT, role: "user" };
  const key = rateLimitKey({ principal, verb: "command.submit" });
  assert.ok(key.includes("uid-laurin"));
  assert.ok(key.includes(TENANT));
  assert.notEqual(key, rateLimitKey({ principal: { ...principal, id: "uid-fremd" }, verb: "command.submit" }));
  assert.notEqual(key, rateLimitKey({ principal, verb: "context.read" }));
  // Unvollständiger Principal ⇒ kein Schlüssel, also auch kein stiller Erfolg.
  assert.equal(rateLimitKey({ principal: { id: "x" }, verb: "a" }), null);
  assert.equal(rateLimitKey({}), null);
});
