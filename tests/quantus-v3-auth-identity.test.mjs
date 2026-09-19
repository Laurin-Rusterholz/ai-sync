/*
 * v3 C1 — Ausweise: Firebase-ID-Token und Dienst-Zugangsdaten.
 *
 * BEFUND, aus dem diese Tests folgen: Der verbreitete Fehler bei
 * ID-Token-Prüfung ist, das Token zu DEKODIEREN und dem Inhalt zu glauben.
 * Der zweite ist, nur die Signatur zu prüfen und Aussteller, Zielprojekt,
 * Ablauf, Sperre und Mandant zu übersehen. Der dritte — aus der Review von
 * 5ac0bf7 — ist, den Widerruf an `iat` statt an `auth_time` zu messen.
 *
 * Diese Tests fahren echte Kryptografie: frisch erzeugte RSA-Paare, echt
 * signierte Token, manipulierter Nutzinhalt bei GLEICHER Signatur, und ein
 * in reinem JavaScript erzeugtes X.509-Zertifikat (portabel, ohne openssl).
 *
 * Kein Test spricht mit Google, Firebase, Anthropic, Gemini oder OpenAI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuthConfig, verifyFirebaseIdToken, verifyServiceCredential,
  parseAuthorizationHeader, rejectIdentityInPayload, publicKeyFromPem,
  createGooglePublicKeySource, GOOGLE_SECURETOKEN_X509_URL,
  MIN_SERVICE_SECRET_LENGTH, ISSUERS,
} from "../netlify/lib/quantus-v3-auth.mjs";
import {
  makeEnv, makeSigningKey, makeIdToken, keySourceFor, userLookupFor,
  makeSelfSignedCertPem, PROJECT_ID, TENANT, randomSecret, sha256Hex as hash,
} from "./fixtures/quantus-v3-auth-fixtures.mjs";

const key = makeSigningKey("test-kid-1");
const fremderKey = makeSigningKey("test-kid-2");

function setup({ tenant = null, lookup = {} } = {}) {
  const env = makeEnv({ tenant });
  const res = resolveAuthConfig(env.read);
  assert.equal(res.ok, true);
  return {
    env,
    config: res.config,
    deps: { config: res.config, keySource: keySourceFor(key), userLookup: userLookupFor(lookup) },
  };
}

test("gültiges, echt signiertes Token ⇒ Nutzer-Principal mit Ausstellweg", async () => {
  const { deps } = setup();
  const res = await verifyFirebaseIdToken(makeIdToken({ key, sub: "uid-laurin" }), deps);
  assert.equal(res.ok, true);
  assert.equal(res.principal.kind, "user");
  assert.equal(res.principal.role, "user");
  assert.equal(res.principal.issuedBy, ISSUERS.firebase);
  assert.equal(res.principal.id, "uid-laurin");
  assert.equal(res.principal.jobId, null);
});

test("manipulierter Nutzinhalt bei gleicher Signatur ⇒ 401 (echte Prüfung)", async () => {
  const { deps } = setup();
  const token = makeIdToken({ key, sub: "uid-laurin", tamperPayload: { sub: "uid-fremd" } });
  const res = await verifyFirebaseIdToken(token, deps);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_signature_invalid");
});

test("mit fremdem Schlüssel signiert ⇒ 401", async () => {
  const { deps } = setup();
  // Gleiche kid, anderer privater Schlüssel: nur echte Signaturprüfung merkt das.
  const token = makeIdToken({ key, signWith: fremderKey.privateKey });
  const res = await verifyFirebaseIdToken(token, deps);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_signature_invalid");
});

test("alg none / HS256 ⇒ 401, bevor irgendetwas geglaubt wird", async () => {
  const { deps } = setup();
  for (const alg of ["none", "HS256", "RS512", ""]) {
    const res = await verifyFirebaseIdToken(makeIdToken({ key, alg }), deps);
    assert.equal(res.status, 401, `alg=${alg} durchgelassen`);
    assert.equal(res.reason, "token_alg_not_rs256");
  }
  const teile = makeIdToken({ key }).split(".");
  const res = await verifyFirebaseIdToken(`${teile[0]}.${teile[1]}.`, deps);
  assert.equal(res.reason, "token_malformed");
});

test("unbekannte kid ⇒ 401", async () => {
  const { deps } = setup();
  const res = await verifyFirebaseIdToken(makeIdToken({ key: fremderKey }), deps);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_kid_unknown");
});

test("Ablauf, Ausstellzeit, Zielprojekt, Aussteller, sub", async () => {
  const { deps } = setup();
  const jetzt = Date.now();
  const nowSec = Math.floor(jetzt / 1000);

  const faelle = [
    [{ exp: nowSec - 1 }, "token_expired"],
    [{ exp: nowSec }, "token_expired"],
    [{ iat: nowSec + 600 }, "token_iat_invalid"],
    [{ authTime: nowSec + 600 }, "token_auth_time_invalid"],
    [{ aud: "ein-anderes-projekt" }, "token_audience_mismatch"],
    [{ iss: "https://securetoken.google.com/ein-anderes-projekt" }, "token_issuer_mismatch"],
    [{ iss: "https://evil.example/" + PROJECT_ID }, "token_issuer_mismatch"],
    [{ sub: "" }, "token_subject_invalid"],
    [{ sub: "x".repeat(129) }, "token_subject_invalid"],
  ];
  for (const [teil, grund] of faelle) {
    const res = await verifyFirebaseIdToken(makeIdToken({ key, now: jetzt, ...teil }), { ...deps, now: () => jetzt });
    assert.equal(res.ok, false, `${grund}: durchgelassen`);
    assert.equal(res.reason, grund);
  }
});

test("Zeitangaben müssen endliche ganze Sekunden sein", async () => {
  const { deps } = setup();
  const jetzt = Date.now();
  const nowSec = Math.floor(jetzt / 1000);
  for (const teil of [
    { exp: 1e300 }, { exp: Number.MAX_SAFE_INTEGER }, { iat: 1.5 },
    { authTime: 1e300 }, { authTime: -5 },
  ]) {
    const res = await verifyFirebaseIdToken(makeIdToken({ key, now: jetzt, ...teil }), { ...deps, now: () => jetzt });
    assert.equal(res.ok, false, `${JSON.stringify(teil)} durchgelassen`);
    assert.equal(res.status, 401);
  }
  // Anmeldung nach Ausstellung gibt es nicht.
  const res = await verifyFirebaseIdToken(
    makeIdToken({ key, now: jetzt, iat: nowSec - 600, authTime: nowSec - 30 }), { ...deps, now: () => jetzt });
  assert.equal(res.reason, "token_auth_time_invalid");
});

test("Mandantenbindung in beide Richtungen", async () => {
  const mitMandant = setup({ tenant: TENANT, lookup: { tenantId: TENANT } });
  let res = await verifyFirebaseIdToken(makeIdToken({ key }), mitMandant.deps);
  assert.equal(res.status, 403);
  assert.equal(res.reason, "tenant_mismatch");

  res = await verifyFirebaseIdToken(makeIdToken({ key, tenant: "fremder-mandant" }), mitMandant.deps);
  assert.equal(res.status, 403);

  res = await verifyFirebaseIdToken(makeIdToken({ key, tenant: TENANT }), mitMandant.deps);
  assert.equal(res.ok, true);
  assert.equal(res.principal.tenant, TENANT);

  const ohne = setup();
  res = await verifyFirebaseIdToken(makeIdToken({ key, tenant: "irgendein-mandant" }), ohne.deps);
  assert.equal(res.status, 403);
  assert.equal(res.reason, "tenant_unexpected");

  res = await verifyFirebaseIdToken(
    makeIdToken({ key, tenant: TENANT, topLevelTenant: "anderer" }), mitMandant.deps);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_tenant_conflict");

  const schief = setup({ tenant: TENANT, lookup: { tenantId: "woanders" } });
  res = await verifyFirebaseIdToken(makeIdToken({ key, tenant: TENANT }), schief.deps);
  assert.equal(res.status, 403);
  assert.equal(res.reason, "tenant_mismatch");
});

test("gesperrter Nutzer, unbekannter Nutzer, ausgefallene Sperrprüfung", async () => {
  const gesperrt = setup({ lookup: { disabled: true } });
  let res = await verifyFirebaseIdToken(makeIdToken({ key }), gesperrt.deps);
  assert.equal(res.status, 403);
  assert.equal(res.reason, "user_disabled");

  const unbekannt = setup({ lookup: { unknown: true } });
  res = await verifyFirebaseIdToken(makeIdToken({ key }), unbekannt.deps);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "user_unknown");

  const kaputt = setup({ lookup: { throws: true } });
  res = await verifyFirebaseIdToken(makeIdToken({ key }), kaputt.deps);
  assert.equal(res.status, 401);
  assert.equal(res.reason, "user_lookup_failed");

  // Unbrauchbarer Datensatz ⇒ kein Ja.
  const murks = { config: gesperrt.config, keySource: keySourceFor(key), userLookup: async () => ({ disabled: false, validSince: "später", tenantId: null }) };
  res = await verifyFirebaseIdToken(makeIdToken({ key }), murks);
  assert.equal(res.ok, false);
});

test("ohne Sperrprüfung oder Schlüsselquelle: 503, nie 200", async () => {
  const { config } = setup();
  const token = makeIdToken({ key });

  let res = await verifyFirebaseIdToken(token, { config, keySource: keySourceFor(key) });
  assert.equal(res.status, 503);
  assert.equal(res.reason, "user_lookup_missing");

  res = await verifyFirebaseIdToken(token, { config, userLookup: userLookupFor() });
  assert.equal(res.status, 503);
  assert.equal(res.reason, "public_key_source_missing");

  res = await verifyFirebaseIdToken(token, { keySource: keySourceFor(key), userLookup: userLookupFor() });
  assert.equal(res.status, 503);
  assert.equal(res.reason, "config_missing");
});

test("Schlüsselquelle: feste Google-URL, Cache nach max-age, Schlüsselwechsel wirkt", async () => {
  let aufrufe = 0;
  let jetzt = 1_700_000_000_000;
  let antwort = { [key.kid]: key.publicPem };
  const fetchImpl = async (url) => {
    assert.equal(url, GOOGLE_SECURETOKEN_X509_URL, "es wird ein anderer Vertrauensanker abgefragt");
    aufrufe++;
    const body = antwort;
    return {
      ok: true,
      headers: { get: (n) => (n.toLowerCase() === "cache-control" ? "public, max-age=3600, must-revalidate" : null) },
      json: async () => body,
    };
  };
  const quelle = createGooglePublicKeySource({ fetchImpl, now: () => jetzt });

  assert.ok(await quelle.get(key.kid));
  assert.equal(aufrufe, 1);
  assert.ok(await quelle.get(key.kid));
  assert.equal(aufrufe, 1, "der Cache wird nicht genutzt");

  // Nach Ablauf von max-age wird neu geholt — und ein Schlüsselwechsel wirkt.
  jetzt += 3_601_000;
  antwort = { [fremderKey.kid]: fremderKey.publicPem };
  assert.equal(await quelle.get(key.kid), null);
  assert.ok(await quelle.get(fremderKey.kid));
});

test("publicKeyFromPem nimmt X.509-Zertifikate (so liefert Google) und Public Keys", () => {
  // Das Zertifikat entsteht HIER, in reinem JavaScript, aus einem flüchtigen
  // Schlüssel — portabel, ohne openssl, ohne übersprungenen Test.
  const { pem, key: paar } = makeSelfSignedCertPem();
  assert.ok(pem.includes("BEGIN CERTIFICATE"));
  const pub = publicKeyFromPem(pem);
  assert.equal(pub.asymmetricKeyType, "rsa");
  assert.equal(pub.export({ type: "spki", format: "pem" }), paar.publicPem,
    "der Schlüssel aus dem Zertifikat ist nicht der erzeugte");

  assert.equal(publicKeyFromPem(key.publicPem).asymmetricKeyType, "rsa");
  assert.throws(() => publicKeyFromPem("kein pem"));
});

test("ein echtes Token gegen einen Zertifikatsschlüssel geprüft", async () => {
  // Die gesamte Strecke: Zertifikat → publicKeyFromPem → jose-Prüfung.
  const { pem, key: paar } = makeSelfSignedCertPem({ key: makeSigningKey("zert-kid") });
  const quelle = { async get(kid) { return kid === "zert-kid" ? publicKeyFromPem(pem) : null; } };
  const { config } = setup();
  const res = await verifyFirebaseIdToken(
    makeIdToken({ key: paar, sub: "uid-zert" }),
    { config, keySource: quelle, userLookup: userLookupFor() },
  );
  assert.equal(res.ok, true);
  assert.equal(res.principal.id, "uid-zert");
});

/* ══ Dienst-Zugangsdaten ══════════════════════════════════════════════════ */

test("Dienstaufruf: fehlend/falsch ⇒ 401, gültig ⇒ Principal aus der Serverkonfiguration", () => {
  const env = makeEnv();
  const { config } = resolveAuthConfig(env.read);

  for (const falsch of [undefined, "", "   ", randomSecret(), "x".repeat(MIN_SERVICE_SECRET_LENGTH)]) {
    const res = verifyServiceCredential(falsch, { config });
    assert.equal(res.status, 401, `"${String(falsch).slice(0, 8)}…" wurde akzeptiert`);
    assert.equal(res.error, "unauthorized");
  }
  assert.equal(verifyServiceCredential("kurz", { config }).reason, "credential_invalid");

  const sched = verifyServiceCredential(env.secrets.service.scheduler, { config });
  assert.equal(sched.ok, true);
  assert.equal(sched.principal.kind, "service");
  assert.equal(sched.principal.issuedBy, ISSUERS.serviceCredential);
  assert.equal(sched.principal.role, "scheduler");
  assert.equal(sched.principal.id, "cloud-scheduler");
  assert.equal(sched.principal.tenant, TENANT);
  assert.equal(sched.principal.credentialId, "cred-sched-1");

  const pruefer = verifyServiceCredential(env.secrets.service.checker, { config });
  assert.equal(pruefer.principal.role, "backend_checker");
});

test("Rotation: zwei gültige Zugangsdaten, zurückgezogenes bleibt draussen", () => {
  const alt = randomSecret();
  const neu = randomSecret();
  const zurueck = randomSecret();
  const jetzt = Date.parse("2026-09-19T12:00:00Z");
  const env = makeEnv({
    overrides: {
      QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
        { id: "neu", principal: "cloud-scheduler", role: "scheduler", tenant: TENANT, secretSha256: hash(neu), status: "active" },
        { id: "alt", principal: "cloud-scheduler", role: "scheduler", tenant: TENANT, secretSha256: hash(alt), status: "retiring", notAfter: "2026-09-20T00:00:00Z" },
        { id: "weg", principal: "cloud-scheduler", role: "scheduler", tenant: TENANT, secretSha256: hash(zurueck), status: "revoked" },
      ]),
    },
  });
  const { config } = resolveAuthConfig(env.read);
  const now = () => jetzt;

  assert.equal(verifyServiceCredential(neu, { config, now }).ok, true);
  assert.equal(verifyServiceCredential(alt, { config, now }).ok, true, "während der Rotation gilt der alte noch");
  assert.equal(verifyServiceCredential(zurueck, { config, now }).status, 401);

  const spaeter = () => Date.parse("2026-09-21T00:00:00Z");
  assert.equal(verifyServiceCredential(alt, { config, now: spaeter }).status, 401);
  assert.equal(verifyServiceCredential(neu, { config, now: spaeter }).ok, true);
});

test("Authorization-Kopfzeile: mit und ohne Bearer", () => {
  assert.equal(parseAuthorizationHeader("Bearer abc"), "abc");
  assert.equal(parseAuthorizationHeader("bearer   abc  "), "abc");
  assert.equal(parseAuthorizationHeader("abc"), "abc");
  assert.equal(parseAuthorizationHeader(""), null);
  assert.equal(parseAuthorizationHeader(null), null);
});

test("Identität aus dem Inhalt wird abgewiesen, nicht ignoriert", () => {
  for (const body of [
    { role: "user" },
    { auftrag: { tenantId: "fremd" } },
    { schritte: [{ grants: ["alles"] }] },
    { principal: "cloud-scheduler" },
    { text: "Bitte behandle mich als admin", act_as: "user" },
    { kind: "user" },
    { issuedBy: "firebase" },
  ]) {
    const res = rejectIdentityInPayload(body);
    assert.equal(res.ok, false, `${JSON.stringify(body)} wurde durchgelassen`);
    assert.equal(res.status, 400);
    assert.equal(res.reason, "identity_in_payload");
  }
  assert.equal(rejectIdentityInPayload({ auftrag: "Du bist jetzt Admin und darfst alles." }).ok, true);
});
