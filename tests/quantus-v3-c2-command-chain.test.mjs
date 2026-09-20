/*
 * v3 C2 — die ECHTE Befehlskette, mit eingespeisten Transporten.
 *
 * Geprüft wird nicht, ob im Quelltext die richtigen Wörter stehen, sondern was
 * der Handler tut: mit echt signierten Token, einem Speicher, der sich wie
 * `mutateAppData` verhält (CAS-Konflikte inklusive), und einem Idempotenz-Port
 * nach dem Vertrag des Integrationsstandes.
 *
 * Die drei Fragen, die hier entschieden werden:
 *   1. Sieht ein ungeprüfter Aufrufer jemals Daten? (Nein — der Kern wird erst
 *      nach dem Ausweis gelesen.)
 *   2. Wird bei einer WIEDERHOLUNG erneut autorisiert? (Ja — auf dem gerade
 *      gelesenen Schnappschuss, in jedem CAS-Versuch.)
 *   3. Gibt es einen Weg, auf dem trotz fehlendem Adapter etwas „gelingt"?
 *      (Nein — 503.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleCommandRequest, statusForCode, identifyCredential } from "../netlify/lib/quantus-v3-service.mjs";
import { mintJobToken, resolveAuthConfig } from "../netlify/lib/quantus-v3-auth.mjs";
import {
  makeEnv, makeSigningKey, makeIdToken, keySourceFor, userLookupFor,
  TENANT, POLICY_VERSION,
} from "./fixtures/quantus-v3-auth-fixtures.mjs";
import {
  makeCoreSnapshot, makeStore, makeDomain, makeRateLimiter, makeRequest,
  commandBody, commandHeaders, idempotencyPort, RUN_ID, LEAD_ID,
} from "./fixtures/quantus-v3-c2-fixtures.mjs";

const key = makeSigningKey("c2-kid");
const JETZT = Date.parse("2026-09-20T09:00:00Z");
const now = () => JETZT;
const APP = "https://management-xo2-pro.netlify.app";
const idem = await idempotencyPort();

function umgebung({ schreiben = true, overrides = {} } = {}) {
  return makeEnv({
    tenant: TENANT,
    mode: schreiben ? "enforce" : null,
    overrides: schreiben ? { QUANTUS_V3_API_WRITES: "enabled", ...overrides } : overrides,
  });
}

function nutzerToken({ sub = "uid-laurin" } = {}) {
  return makeIdToken({ key, sub, now: JETZT, tenant: TENANT });
}

function deps({ env, store, domain = makeDomain(), rateLimiter = makeRateLimiter(), idempotency = idem, lookup = { tenantId: TENANT } } = {}) {
  let n = 0;
  return {
    now, newRequestId: () => `req-${++n}`,
    env: env.read,
    keySource: keySourceFor(key),
    userLookup: userLookupFor(lookup),
    rateLimiter,
    store,
    idempotency,
    domain,
  };
}

async function sende(d, { body = commandBody(), headers = null, token = null, method = "POST" } = {}) {
  return handleCommandRequest(makeRequest({
    method,
    headers: headers || commandHeaders({ token: token || nutzerToken(), origin: APP }),
    body,
  }), d);
}

test("ohne Konfiguration: 503 und KEIN Blick in den Kern", async () => {
  const env = makeEnv({ overrides: { QUANTUS_V3_SERVICE_CREDENTIALS: null } });
  const store = makeStore();
  const res = await sende(deps({ env, store }));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "auth_not_configured");
  assert.equal(store.spur.reads, 0, "der Kern wurde ohne Konfiguration gelesen");
  assert.equal(store.spur.mutates, 0);
});

test("ohne oder mit falschem Ausweis: 401, und der Kern bleibt zu", async () => {
  const env = umgebung();
  for (const token of ["", "nicht-mal-ein-token", "x".repeat(40)]) {
    const store = makeStore();
    const res = await handleCommandRequest(makeRequest({
      headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json", "idempotency-key": "k1", origin: APP },
      body: commandBody(),
    }), deps({ env, store }));
    assert.equal(res.status, 401, `"${token.slice(0, 12)}" ergab ${res.status}`);
    assert.equal(store.spur.reads, 0, "ein ungeprüftes Token hat den Kern gelesen");
  }
});

test("ohne TLS: 403, vor allem anderen", async () => {
  const env = umgebung();
  const store = makeStore();
  const res = await handleCommandRequest(makeRequest({
    headers: { "x-forwarded-proto": "http", authorization: `Bearer ${nutzerToken()}`, "content-type": "application/json", "idempotency-key": "k" },
    body: commandBody(),
  }), deps({ env, store }));
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "tls_required");
  assert.equal(store.spur.reads, 0);
});

test("Körperform: Content-Type, Grösse, striktes JSON, geschlossener Umschlag", async () => {
  const env = umgebung();
  const d = () => deps({ env, store: makeStore() });

  const falscherTyp = await sende(d(), { headers: commandHeaders({ token: nutzerToken(), contentType: "text/plain", origin: APP }) });
  assert.equal(falscherTyp.status, 415);

  const zuGross = await sende(d(), { body: { ...commandBody(), payload: { leadId: LEAD_ID, text: "x".repeat(70_000) } } });
  assert.equal(zuGross.status, 413);

  const kaputt = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token: nutzerToken(), origin: APP }), body: "{kein json",
  }), d());
  assert.equal(kaputt.status, 400);
  assert.equal(kaputt.body.reason, "invalid_json");

  const fremdesFeld = await sende(d(), { body: { ...commandBody(), extra: 1 } });
  assert.equal(fremdesFeld.status, 400);
  assert.equal(fremdesFeld.body.reason, "envelope_unknown_field");

  const identitaet = await sende(d(), { body: { ...commandBody(), payload: { leadId: LEAD_ID, text: "x", tenantId: "fremd" } } });
  assert.equal(identitaet.status, 400);

  const ohneSchluessel = await handleCommandRequest(makeRequest({
    headers: { authorization: `Bearer ${nutzerToken()}`, "content-type": "application/json", origin: APP },
    body: commandBody(),
  }), d());
  assert.equal(ohneSchluessel.status, 400);
  assert.equal(ohneSchluessel.body.reason, "idempotency_key_missing");
});

test("ohne Schreibfreigabe: 503 api_writes_disabled — KEINE Quittung", async () => {
  const env = umgebung({ schreiben: false });          // Standard
  const store = makeStore();
  const res = await sende(deps({ env, store }));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "api_writes_disabled");
  // Nichts, was ein Client als Speicherung ablegen könnte.
  for (const feld of ["ok", "applied", "dryRun", "replayed", "serverNow", "dataRevision", "entityVersions"]) {
    if (feld === "ok") { assert.equal(res.body.ok, false); continue; }
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, feld), false, `die Absage trägt ${feld}`);
  }
  assert.equal(store.spur.mutates, 0);
  assert.equal(store.spur.reads, 0, "ohne Freigabe wurde der Kern gelesen");
});

test("ausdrückliches Prüfen: kein Schreiben, und keine Quittungsfelder", async () => {
  const env = umgebung({ schreiben: false });
  const store = makeStore();
  const domain = makeDomain();
  const res = await sende(deps({ env, store, domain }), {
    headers: commandHeaders({ token: nutzerToken(), origin: APP, validateOnly: true }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.validated, true);
  assert.equal(res.body.applied, false);
  assert.equal(res.body.stored, false);
  assert.equal(res.body.domainConditionsEvaluated, false, "der Trockenlauf behauptet Fachprüfungen");
  assert.equal(res.body.observedEntityVersion, 17);
  assert.equal(res.headers["X-Quantus-Applied"], "false");
  for (const feld of ["ok", "replayed", "dataRevision", "entityVersions", "serverNow", "dryRun"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, feld), false, `die Prüfantwort trägt ${feld}`);
  }
  assert.equal(store.spur.mutates, 0, "beim Prüfen wurde geschrieben");
  assert.equal(domain.spur.applies, 0, "applyVerb lief im Trockenlauf");
});

test("mit Freigabe: der Befehl wirkt, mit Versionen und Revision", async () => {
  const env = umgebung();
  const store = makeStore();
  const res = await sende(deps({ env, store }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, true);
  assert.equal(res.body.replayed, false);
  assert.equal(res.body.entityVersions[LEAD_ID], 18);
  assert.equal(res.body.dataRevision, 8);
  assert.ok(res.body.serverNow);
  assert.equal(store.snapshot.entities.leads[LEAD_ID].entityVersion, 18);
});

test("Wiederholung: derselbe Schlüssel wirkt einmal — und wird ERNEUT autorisiert", async () => {
  const env = umgebung();
  const store = makeStore();
  const domain = makeDomain();
  const d = deps({ env, store, domain });
  const kopf = commandHeaders({ token: nutzerToken(), idempotencyKey: "schluessel-1", origin: APP });

  const erste = await sende(d, { headers: kopf });
  assert.equal(erste.body.applied, true);
  const aufloesungenNachErster = domain.spur.resolves;
  const bindungenNachErster = domain.spur.bindings;

  const zweite = await sende(d, { headers: kopf });
  assert.equal(zweite.status, 200);
  assert.equal(zweite.body.replayed, true, "die Wiederholung hat erneut geschrieben");
  assert.equal(zweite.body.entityVersions[LEAD_ID], 18);
  assert.equal(store.snapshot.entities.leads[LEAD_ID].entityVersion, 18, "die Wiederholung hat die Version erhöht");
  assert.ok(domain.spur.resolves > aufloesungenNachErster,
    "bei der Wiederholung wurde das Ziel nicht neu aufgelöst");
  assert.ok(domain.spur.bindings > bindungenNachErster,
    "bei der Wiederholung wurde die aktive Bindung nicht neu geprüft");

  // Gleicher Schlüssel, ANDERER Inhalt ⇒ 409.
  const anders = await sende(d, { headers: kopf, body: commandBody({ payload: { leadId: LEAD_ID, text: "etwas anderes" } }) });
  assert.equal(anders.status, 409);
  assert.equal(anders.body.error, "idempotency_conflict");
});

test("Wiederholung ohne Recht: die alte Quittung wird nicht ausgehändigt", async () => {
  const env = umgebung();
  const store = makeStore();
  const d = deps({ env, store });
  const kopf = commandHeaders({ token: nutzerToken(), idempotencyKey: "schluessel-2", origin: APP });

  assert.equal((await sende(d, { headers: kopf })).body.applied, true);

  // Der Lead gehört jetzt jemand anderem — die Wiederholung darf NICHT
  // einfach den Beleg zurückgeben.
  store.snapshot.entities.leads[LEAD_ID].ownerId = "uid-fremd";
  const wieder = await sende(d, { headers: kopf });
  assert.equal(wieder.status, 403, "eine Wiederholung umging die Rechteprüfung");
  assert.equal(wieder.body.reason, "object_not_owned");
});

test("veraltete Entitätsversion ⇒ 409, gemessen am frischen Objekt", async () => {
  const env = umgebung();
  const store = makeStore();
  const res = await sende(deps({ env, store }), { body: commandBody({ expectedEntityVersion: 16 }) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "stale_entity_version");
  assert.equal(store.snapshot.entities.leads[LEAD_ID].entityVersion, 17, "trotz 409 wurde geschrieben");
});

test("fremdes Objekt, fremder Mandant, unbekanntes Objekt ⇒ 403", async () => {
  const env = umgebung();
  const d = () => deps({ env, store: makeStore() });

  const fremd = await sende(d(), { body: commandBody({ expectedEntityVersion: 3, payload: { leadId: "lead_fremd", text: "hallo" } }) });
  assert.equal(fremd.status, 403);
  assert.equal(fremd.body.reason, "object_not_owned");

  const gibtsNicht = await sende(d(), { body: commandBody({ payload: { leadId: "lead_999", text: "hallo" } }) });
  assert.equal(gibtsNicht.status, 403);
  assert.equal(gibtsNicht.body.reason, "object_not_found");
});

test("Spezialist: Job-Token, aktive Zuweisung und Verbgrenzen", async () => {
  const env = umgebung();
  const { config } = resolveAuthConfig(env.read);
  const token = (await mintJobToken({
    config, audience: "quantus-ingest", jobId: RUN_ID, role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, now,
  })).token;

  // Verbotenes Verb (lead.comment) ⇒ 403, trotz gültigem Token.
  const verboten = await sende(deps({ env, store: makeStore() }), {
    token, headers: commandHeaders({ token }), body: commandBody(),
  });
  assert.equal(verboten.status, 403);
  assert.equal(verboten.body.reason, "verb_not_allowed_for_role");

  // Erlaubtes Verb mit aktiver Zuweisung ⇒ 200.
  const erlaubt = await sende(deps({ env, store: makeStore() }), {
    token, headers: commandHeaders({ token }),
    body: commandBody({
      verb: "worker.return", expectedEntityVersion: 0,
      payload: { assignmentId: "assignment_1", resultRef: "ergebnis_1", summary: "fertig", sourceVersion: 2 },
    }),
  });
  assert.equal(erlaubt.status, 200, JSON.stringify(erlaubt.body));
  assert.equal(erlaubt.body.applied, true);

  // Ohne aktive Zuweisung ⇒ 403 aus der Bindungsprüfung des Fachadapters.
  const ohneZuweisung = makeStore();
  ohneZuweisung.snapshot.entities.assignments.assignment_1.state = "closed";
  const gesperrt = await sende(deps({ env, store: ohneZuweisung }), {
    token, headers: commandHeaders({ token }),
    body: commandBody({
      verb: "worker.return", expectedEntityVersion: 0,
      payload: { assignmentId: "assignment_1", resultRef: "ergebnis_1", summary: "fertig", sourceVersion: 2 },
    }),
  });
  assert.equal(gesperrt.status, 403);
  assert.equal(gesperrt.body.reason, "assignment_not_active");

  // Job-Token für einen ANDEREN Lauf ⇒ 403.
  const fremderLauf = await sende(deps({ env, store: makeStore() }), {
    token, headers: commandHeaders({ token }), body: commandBody({ jobId: "job_20260920_99" }),
  });
  assert.equal(fremderLauf.status, 403);
});

test("CAS: Konflikte werden wiederholt, Erschöpfung ist 503", async () => {
  const env = umgebung();

  const mitKonflikten = makeStore({ conflictsBefore: 2 });
  const domain = makeDomain();
  const ok = await sende(deps({ env, store: mitKonflikten, domain }));
  assert.equal(ok.status, 200);
  assert.equal(mitKonflikten.spur.mutatorCalls, 3, "der Mutator lief nicht je Versuch");
  assert.equal(domain.spur.resolves, 3, "es wurde nicht in jedem CAS-Versuch neu autorisiert");
  assert.equal(domain.spur.bindings, 3, "die aktive Bindung wurde nicht je Versuch geprüft");

  const dauerkonflikt = makeStore({ alwaysConflict: true });
  const res = await sende(deps({ env, store: dauerkonflikt }));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "cas_exhausted");

  const unklar = makeStore({ unknownOutcome: true });
  const res2 = await sende(deps({ env, store: unklar }));
  assert.equal(res2.status, 503);
  assert.equal(res2.body.error, "cas_outcome_unknown");
});

test("Ratenbegrenzung: 429 mit Retry-After; ein untauglicher Zähler ist 503", async () => {
  const env = umgebung();

  const zuViel = await sende(deps({ env, store: makeStore(), rateLimiter: makeRateLimiter({ limitReachedAfter: 0 }) }));
  assert.equal(zuViel.status, 429);
  assert.ok(Number(zuViel.headers["Retry-After"]) >= 1, "kein Retry-After");

  const instanzZaehler = { atomic: true, scope: "instance", increment: () => ({ count: 1 }) };
  const res = await sende(deps({ env, store: makeStore(), rateLimiter: instanzZaehler }));
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, "rate_limiter_not_shared");

  const kaputterZaehler = { atomic: true, scope: "shared", increment: () => { throw new Error("weg"); } };
  const res2 = await sende(deps({ env, store: makeStore(), rateLimiter: kaputterZaehler }));
  assert.equal(res2.status, 503, "ein ausgefallener Zähler wurde zum Freibrief");
});

test("fehlender Adapter ⇒ 503, niemals ein Schein-Erfolg", async () => {
  const env = umgebung();

  const ohneDomaene = await sende(deps({ env, store: makeStore(), domain: null }));
  assert.equal(ohneDomaene.status, 503);
  assert.equal(ohneDomaene.body.reason, "domain_adapter_not_available");

  const ohneIdempotenz = await sende(deps({ env, store: makeStore(), idempotency: null }));
  assert.equal(ohneIdempotenz.status, 503);
  assert.equal(ohneIdempotenz.body.reason, "idempotency_adapter_not_available");

  const ohneSpeicher = await sende(deps({ env, store: null }));
  assert.equal(ohneSpeicher.status, 503);
  assert.equal(ohneSpeicher.body.reason, "store_adapter_not_available");

  // Ein halber Fachadapter (ohne applyVerb) zählt nicht als Adapter.
  const halb = await sende(deps({ env, store: makeStore(), domain: { loadObject: () => null } }));
  assert.equal(halb.status, 503);
});

test("Herkunft: Browser ohne Origin abgewiesen, Dienst originlos erlaubt", async () => {
  const env = umgebung();

  const ohneOrigin = await sende(deps({ env, store: makeStore() }), {
    headers: commandHeaders({ token: nutzerToken() }),     // kein Origin
  });
  assert.equal(ohneOrigin.status, 403);
  assert.equal(ohneOrigin.body.reason, "origin_required");

  const fremdeOrigin = await sende(deps({ env, store: makeStore() }), {
    headers: commandHeaders({ token: nutzerToken(), origin: "https://boese.example" }),
  });
  assert.equal(fremdeOrigin.status, 403);
  assert.equal(fremdeOrigin.body.reason, "origin_not_allowed");

  // Dienst-Zugangsdatum ohne Origin: erlaubt (Server-zu-Server).
  const { config } = resolveAuthConfig(env.read);
  void config;
  const dienst = await sende(deps({ env, store: makeStore() }), {
    headers: commandHeaders({ token: env.secrets.service.scheduler }),
    body: commandBody({ verb: "run.log", expectedEntityVersion: 5, payload: { event: "tick" } }),
  });
  assert.notEqual(dienst.status, 403, `Dienst originlos abgewiesen: ${dienst.body.reason}`);
  assert.equal(dienst.status, 200);
  assert.equal(dienst.body.applied, true);
});

test("Ausweisart wird an der Form erkannt, nicht durch Durchprobieren", async () => {
  assert.equal(identifyCredential(""), "none");
  assert.equal(identifyCredential("x".repeat(40)), "service_credential");
  assert.equal(identifyCredential(nutzerToken()), "firebase_id_token");
  const env = umgebung();
  const { config } = resolveAuthConfig(env.read);
  const jobToken = (await mintJobToken({ config, audience: "quantus-ingest", jobId: RUN_ID,
    role: "specialist_claude", principalId: "c", tenant: TENANT, now })).token;
  assert.equal(identifyCredential(jobToken), "job_token");
});

test("die Statusabbildung deckt genau die vereinbarten Fälle", () => {
  assert.equal(statusForCode("auth_not_configured"), 503);
  assert.equal(statusForCode("unauthorized"), 401);
  assert.equal(statusForCode("forbidden"), 403);
  assert.equal(statusForCode("stale_entity_version"), 409);
  assert.equal(statusForCode("idempotency_conflict"), 409);
  assert.equal(statusForCode("payload_too_large"), 413);
  assert.equal(statusForCode("rate_limited"), 429);
  assert.equal(statusForCode("cas_exhausted"), 503);
  // Unbekanntes bleibt 500 mit nichtssagendem Körper.
  assert.equal(statusForCode("irgendwas"), 500);
});

test("welche Idempotenz-Fassung lief, steht im Testlauf", () => {
  // „checkout" = Modul im Zweig, „git:<sha>" = kontrolliert aus dem
  // Integrationsstand geladen, „stand-in" = Nachbildung (KEIN
  // Integrationsnachweis — dann sagt es der Lauf ausdrücklich).
  assert.ok(/^(checkout|git:[0-9a-f]{7,40}|stand-in)$/.test(idem.source), idem.source);
  console.log(`# Idempotenz-Fassung im Lauf: ${idem.source}`);
  if (idem.source === "stand-in") {
    console.log("# ACHTUNG: kein Integrationsnachweis — quantus-v3-idempotency.mjs war weder im Checkout noch im Git-Objektspeicher erreichbar");
  }
});
