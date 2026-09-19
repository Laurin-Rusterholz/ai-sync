/*
 * v3 C1 — die Gegenbeispiele aus der unabhängigen Prüfung von 5ac0bf7.
 *
 * Jeder Block hier ist ein Fall, der in 5ac0bf7 DURCHKAM. Die Tests stehen
 * bewusst in einer eigenen Datei und nennen ihre Nummer: sie sind der Beleg,
 * dass die Korrektur genau das trifft, was gemeldet wurde — und sie bleiben
 * stehen, damit es nicht zurückfällt.
 *
 * Alle Schlüssel entstehen zur Laufzeit; kein Netz, kein Anbieteraufruf.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  resolveAuthConfig, authorize, verifyFirebaseIdToken, verifyServiceCredential,
  mintJobToken, verifyJobToken, createGooglePublicKeySource,
  GOOGLE_SECURETOKEN_X509_URL, VERBS, ROLE_POLICY, JOB_TOKEN_ROLES,
  JOB_TOKEN_ISSUER, JOB_TOKEN_TYP, ISSUERS,
} from "../netlify/lib/quantus-v3-auth.mjs";
import {
  resolveCursorConfig, signCursor, verifyCursor, describePage, NAMED_QUERIES,
} from "../netlify/lib/quantus-v3-cursor.mjs";
import {
  makeEnv, makeSigningKey, makeIdToken, keySourceFor, userLookupFor,
  TENANT, POLICY_VERSION, randomSecret, sha256Hex,
} from "./fixtures/quantus-v3-auth-fixtures.mjs";

const key = makeSigningKey("gegenbeispiel-kid");
const env = makeEnv({ tenant: TENANT });
const { config } = resolveAuthConfig(env.read);
/* Für die Firebase-Fälle ein Stand OHNE konfigurierten Mandanten: sonst
   griffe die Mandantenprüfung vor dem Widerruf, und der Fall wäre nicht
   der gemeldete. */
const { config: configOhneMandant } = resolveAuthConfig(makeEnv({ workerSecrets: null }).read);
const { config: cursorConfig } = resolveCursorConfig(env.read);
const JETZT = Date.parse("2026-09-19T10:00:00Z");
const NOW_SEC = Math.floor(JETZT / 1000);
const now = () => JETZT;

const nutzer = { kind: "user", issuedBy: ISSUERS.firebase, id: "uid-laurin", role: "user", tenant: TENANT };

/* ══ (1) Widerruf hing an iat statt an auth_time ══════════════════════════
 *
 * Gemeldet: Token mit auth_time = jetzt−3600, iat = jetzt−30 und
 * user.validSince = jetzt−1800 wurde AKZEPTIERT. Ein nach dem Widerruf nur
 * frisch ausgestelltes Token trägt eine neue iat, aber die ALTE Anmeldezeit —
 * nur auth_time entlarvt es. Quelle: Firebase „Manage user sessions"
 * (https://firebase.google.com/docs/auth/admin/manage-sessions), Admin-SDK
 * `verifyIdToken(token, true)`.
 * ------------------------------------------------------------------------ */
test("(1) Widerruf wird an auth_time gemessen, nicht an iat", async () => {
  const deps = {
    config: configOhneMandant, keySource: keySourceFor(key),
    userLookup: userLookupFor({ validSince: NOW_SEC - 1800 }),
    now,
  };
  const token = makeIdToken({ key, now: JETZT, authTime: NOW_SEC - 3600, iat: NOW_SEC - 30 });
  const res = await verifyFirebaseIdToken(token, deps);
  assert.equal(res.ok, false, "das widerrufene Token wurde akzeptiert");
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_revoked");

  // Gegenprobe: nach einer NEUEN Anmeldung (auth_time nach validSince) gilt es.
  const frisch = makeIdToken({ key, now: JETZT, authTime: NOW_SEC - 600, iat: NOW_SEC - 30 });
  assert.equal((await verifyFirebaseIdToken(frisch, deps)).ok, true);

  // Genau auf der Grenze: validSince == auth_time gilt noch.
  const grenze = makeIdToken({ key, now: JETZT, authTime: NOW_SEC - 1800, iat: NOW_SEC - 30 });
  assert.equal((await verifyFirebaseIdToken(grenze, deps)).ok, true);
});

test("(1b) auth_time ist Pflicht — auch `null` ist keine Anmeldezeit", async () => {
  const deps = { config: configOhneMandant, keySource: keySourceFor(key), userLookup: userLookupFor(), now };
  for (const token of [
    makeIdToken({ key, now: JETZT, omitAuthTime: true }),
    makeIdToken({ key, now: JETZT, omitAuthTime: true, extraPayload: { auth_time: null } }),
    makeIdToken({ key, now: JETZT, omitAuthTime: true, extraPayload: { auth_time: "1758276000" } }),
    makeIdToken({ key, now: JETZT, omitAuthTime: true, extraPayload: { auth_time: 0 } }),
  ]) {
    const res = await verifyFirebaseIdToken(token, deps);
    assert.equal(res.ok, false, "ein Token ohne brauchbare auth_time wurde akzeptiert");
    assert.equal(res.status, 401);
  }
});

/* ══ (2) authorize ohne Config / ohne Policy-Version ══════════════════════
 * Gemeldet: `task.create` für den eigenen Nutzer wurde ohne Serverkonfiguration
 * und ohne Policy-Version erlaubt.
 * ------------------------------------------------------------------------ */
test("(2) ohne Serverkonfiguration oder Policy-Version wird nicht entschieden", () => {
  const objekt = { kind: "task", id: "task-1", tenant: TENANT, ownerId: nutzer.id };

  const ohneBeides = authorize({ principal: nutzer, verb: "task.create", dataCategory: "task", object: objekt });
  assert.equal(ohneBeides.ok, false, "ohne Config und Policy-Version erlaubt");
  assert.equal(ohneBeides.status, 503);
  assert.equal(ohneBeides.error, "auth_not_configured");

  const ohneConfig = authorize({ principal: nutzer, verb: "task.create", dataCategory: "task", object: objekt, policyVersion: POLICY_VERSION });
  assert.equal(ohneConfig.status, 503);

  const ohnePolicy = authorize({ principal: nutzer, verb: "task.create", dataCategory: "task", object: objekt, config });
  assert.equal(ohnePolicy.ok, false, "ohne Policy-Version erlaubt");
  assert.equal(ohnePolicy.status, 403);
  assert.equal(ohnePolicy.reason, "policy_version_missing");

  // Auch eine halbe Config (ohne policyVersion) ist keine Config.
  assert.equal(authorize({ principal: nutzer, verb: "task.create", dataCategory: "task", object: objekt,
    policyVersion: POLICY_VERSION, config: { projectId: "x" } }).status, 503);

  // Gegenprobe.
  assert.equal(authorize({ principal: nutzer, verb: "task.create", dataCategory: "task", object: objekt,
    policyVersion: POLICY_VERSION, config }).ok, true);
});

/* ══ (3) principal.kind wurde ignoriert ═══════════════════════════════════
 * Gemeldet: `{kind:"worker", role:"user", …}` bekam Nutzerrechte.
 * ------------------------------------------------------------------------ */
test("(3) Art, Rolle und Ausstellweg müssen zusammenpassen", () => {
  const objekt = { kind: "task", id: "task-1", tenant: TENANT, ownerId: "uid-laurin" };
  const darf = (p) => authorize({ principal: p, verb: "task.create", dataCategory: "task", object: objekt, policyVersion: POLICY_VERSION, config });

  const alsWorker = darf({ ...nutzer, kind: "worker" });
  assert.equal(alsWorker.ok, false, "kind=worker mit role=user bekam Nutzerrechte");
  assert.equal(alsWorker.status, 403);
  assert.equal(alsWorker.reason, "principal_kind_mismatch");

  // Ausstellweg: ein „Nutzer", der über ein Job-Token gekommen wäre.
  assert.equal(darf({ ...nutzer, issuedBy: ISSUERS.jobToken }).reason, "principal_issuer_mismatch");
  assert.equal(darf({ ...nutzer, issuedBy: undefined }).reason, "principal_issuer_mismatch");

  // Und umgekehrt: ein Dienst, der sich als Worker ausgibt.
  const scheduler = { kind: "worker", issuedBy: ISSUERS.serviceCredential, id: "cloud-scheduler", role: "scheduler", tenant: TENANT };
  assert.equal(authorize({ principal: scheduler, verb: "run.claim", dataCategory: "run",
    object: { kind: "run", id: "run-1", tenant: TENANT }, policyVersion: POLICY_VERSION, config }).reason,
    "principal_kind_mismatch");

  // Die Id ist Pflicht.
  assert.equal(darf({ ...nutzer, id: "" }).reason, "principal_id_missing");
  assert.equal(darf({ ...nutzer, id: undefined }).reason, "principal_id_missing");
});

/* ══ (4) Datenkategorie wurde geglaubt statt abgeleitet ═══════════════════
 * Gemeldet: object.kind = "policy" mit dataCategory = "task" wurde akzeptiert.
 * ------------------------------------------------------------------------ */
test("(4) die Kategorie kommt aus dem geladenen Objekt, nicht aus dem Aufruf", () => {
  const policyDatensatz = { kind: "policy", id: "policy-1", tenant: TENANT, ownerId: nutzer.id };
  const res = authorize({
    principal: nutzer, verb: "context.read", dataCategory: "task",
    object: policyDatensatz, policyVersion: POLICY_VERSION, config,
  });
  assert.equal(res.ok, false, "ein Policy-Datensatz wurde als „task“ gelesen");
  assert.equal(res.status, 403);
  assert.equal(res.reason, "object_kind_mismatch");

  // Schreibend dasselbe: ein Policy-Datensatz ist keine Aufgabe.
  assert.equal(authorize({ principal: nutzer, verb: "task.create", dataCategory: "task",
    object: policyDatensatz, policyVersion: POLICY_VERSION, config }).reason, "object_kind_mismatch");

  // Objekt ohne Art oder mit erfundener Art: fail closed.
  for (const art of [undefined, "", "geheimakte", "__proto__", "constructor"]) {
    assert.equal(authorize({ principal: nutzer, verb: "context.read", dataCategory: "task",
      object: { kind: art, id: "x", tenant: TENANT, ownerId: nutzer.id }, policyVersion: POLICY_VERSION, config }).reason,
      "object_kind_unknown");
  }
  // Gegenprobe: passende Art.
  assert.equal(authorize({ principal: nutzer, verb: "context.read", dataCategory: "task",
    object: { kind: "task", id: "t1", tenant: TENANT, ownerId: nutzer.id }, policyVersion: POLICY_VERSION, config }).ok, true);
});

/* ══ (5) Backend-/Scheduler-Autorität als Job-Token ═══════════════════════
 * Gemeldet: `mintJobToken` stellte backend_checker aus; `verifyJobToken` gab
 * kind=worker zurück, und `authorize` erlaubte den Systemabschluss.
 * ------------------------------------------------------------------------ */
test("(5) Dienstautorität wird nie als Auftragstoken ausgestellt", async () => {
  for (const role of ["backend_checker", "scheduler"]) {
    const res = await mintJobToken({ config, audience: "quantus-ingest", jobId: "job-1",
      role, principalId: "wer-auch-immer", tenant: TENANT, now });
    assert.equal(res.ok, false, `${role} wurde als Job-Token ausgestellt`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "role_not_allowed_for_job_token");
  }

  // Selbst ein mit unserem Schlüssel ECHT signiertes Token mit Backend-Rolle
  // wird bei der Prüfung abgewiesen.
  const secret = new TextEncoder().encode(JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret);
  const gefaelscht = await new SignJWT({ job: "job-1", role: "backend_checker", tenant: TENANT, policyVersion: POLICY_VERSION })
    .setProtectedHeader({ alg: "HS256", kid: "w1", typ: JOB_TOKEN_TYP })
    .setIssuer(JOB_TOKEN_ISSUER).setAudience("quantus-ingest").setSubject("backend-pruefer")
    .setIssuedAt(NOW_SEC).setExpirationTime(NOW_SEC + 300).setJti("x").sign(secret);
  const geprueft = await verifyJobToken(gefaelscht, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(geprueft.ok, false, "ein Job-Token mit Backend-Rolle wurde anerkannt");
  assert.equal(geprueft.reason, "role_not_allowed_for_job_token");

  // Und die Rechteprüfung hält die Trennung ebenfalls: Backend-Rolle mit
  // Worker-Herkunft bekommt keinen Abschluss.
  const alsWorker = authorize({
    principal: { kind: "worker", issuedBy: ISSUERS.jobToken, id: "x", role: "backend_checker", tenant: TENANT },
    verb: "run.finalize", dataCategory: "run",
    object: { kind: "run", id: "run-1", tenant: TENANT },
    policyVersion: POLICY_VERSION, config,
  });
  assert.equal(alsWorker.ok, false);
  assert.equal(alsWorker.reason, "principal_kind_mismatch");

  assert.deepEqual([...JOB_TOKEN_ROLES].sort(), ["lead_agent", "specialist_claude", "specialist_gemini"]);
});

/* ══ (6) notAfter galt nur für „retiring" ═════════════════════════════════
 * Gemeldet: ein `active`-Zugangsdatum mit notAfter in der Vergangenheit wurde
 * akzeptiert.
 * ------------------------------------------------------------------------ */
test("(6) der Stichtag gilt in jedem Status", () => {
  const geheim = randomSecret();
  const abgelaufen = resolveAuthConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
        { id: "abgelaufen", principal: "cloud-scheduler", role: "scheduler", tenant: TENANT,
          secretSha256: sha256Hex(geheim), status: "active", notAfter: "2026-09-18T00:00:00Z" },
      ]),
    },
  }).read);
  assert.equal(abgelaufen.ok, true, "die Konfiguration selbst ist gültig");
  const res = verifyServiceCredential(geheim, { config: abgelaufen.config, now });
  assert.equal(res.ok, false, "ein abgelaufenes active-Zugangsdatum wurde akzeptiert");
  assert.equal(res.status, 401);
  assert.equal(res.reason, "credential_expired");

  // Ungültige Zeitangabe sperrt schon die Konfiguration …
  const kaputt = resolveAuthConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
        { id: "a", principal: "p", role: "scheduler", tenant: TENANT, secretSha256: sha256Hex(geheim), status: "active", notAfter: "demnächst" },
      ]),
    },
  }).read);
  assert.equal(kaputt.ok, false);
  assert.equal(kaputt.status, 503);

  // … und ein „retiring" ohne Stichtag liefe sonst unbegrenzt weiter.
  const ohneStichtag = resolveAuthConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
        { id: "a", principal: "p", role: "scheduler", tenant: TENANT, secretSha256: sha256Hex(geheim), status: "active" },
        { id: "b", principal: "p", role: "scheduler", tenant: TENANT, secretSha256: sha256Hex(randomSecret()), status: "retiring" },
      ]),
    },
  }).read);
  assert.equal(ohneStichtag.ok, false);
  assert.equal(ohneStichtag.status, 503);
});

/* ══ (7) Jede unbekannte kid löste einen Netzabruf aus ════════════════════
 * Gemeldet: 1 bekannte + 5 erfundene kids ergaben 6 Abrufe — ein
 * unauthentifizierter Hebel auf den Google-Endpunkt.
 * ------------------------------------------------------------------------ */
test("(7) unbekannte kids kosten höchstens einen Abruf je Abkühlzeit", async () => {
  let aufrufe = 0;
  let jetzt = JETZT;
  let antwort = { [key.kid]: key.publicPem };
  const fetchImpl = async (url) => {
    assert.equal(url, GOOGLE_SECURETOKEN_X509_URL);
    aufrufe++;
    const body = antwort;
    return {
      ok: true,
      headers: { get: (n) => (n.toLowerCase() === "cache-control" ? "public, max-age=3600, must-revalidate" : null) },
      json: async () => body,
    };
  };
  const quelle = createGooglePublicKeySource({ fetchImpl, now: () => jetzt, refreshCooldownMs: 60_000 });

  assert.ok(await quelle.get(key.kid));
  assert.equal(aufrufe, 1);
  for (const erfunden of ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5"]) {
    assert.equal(await quelle.get(erfunden), null);
  }
  assert.equal(aufrufe, 1, `fünf erfundene kids ergaben ${aufrufe} Abrufe`);

  // Ein echter Schlüsselwechsel wirkt trotzdem: nach der Abkühlzeit wird
  // genau einmal neu geholt — ohne auf max-age zu warten.
  const neuerKey = makeSigningKey("rotiert-kid");
  antwort = { [neuerKey.kid]: neuerKey.publicPem };
  jetzt += 61_000;
  assert.ok(await quelle.get(neuerKey.kid), "der rotierte Schlüssel wurde nicht gefunden");
  assert.equal(aufrufe, 2);

  // Und parallele Aufrufe teilen sich EINEN Abruf (singleflight).
  let parallelAufrufe = 0;
  const parallelQuelle = createGooglePublicKeySource({
    fetchImpl: async () => {
      parallelAufrufe++;
      await new Promise((r) => setTimeout(r, 5));
      return {
        ok: true,
        headers: { get: () => "public, max-age=3600" },
        json: async () => ({ [key.kid]: key.publicPem }),
      };
    },
    now: () => jetzt,
  });
  const ergebnisse = await Promise.all([1, 2, 3, 4, 5].map(() => parallelQuelle.get(key.kid)));
  assert.equal(ergebnisse.filter(Boolean).length, 5);
  assert.equal(parallelAufrufe, 1, `paralleler Zugriff ergab ${parallelAufrufe} Abrufe`);
});

/* ══ (8) Der Cursor wurde gegen sich selbst geprüft ═══════════════════════
 * Gemeldet: Cursor auf lead-1 wurde mit expectedScopeId = lead-2 akzeptiert.
 * ------------------------------------------------------------------------ */
test("(8) der Cursor wird gegen die erwartete Bindung geprüft — und neu autorisiert", async () => {
  const nutzerPrincipal = { ...nutzer };
  const leadEins = { kind: "lead", id: "lead-1", tenant: TENANT, ownerId: nutzer.id };
  const leadZwei = { kind: "lead", id: "lead-2", tenant: TENANT, ownerId: nutzer.id };

  const c = (await signCursor({
    config: cursorConfig, principal: nutzerPrincipal, query: "lead.context", scopeId: "lead-1",
    dataRevision: "rev-1", policyVersion: POLICY_VERSION, now,
  })).cursor;

  const basis = {
    config: cursorConfig, authConfig: config, principal: nutzerPrincipal,
    policyVersion: POLICY_VERSION, dataRevision: "rev-1", now,
  };

  // Der gemeldete Fall: anderer Scope im Aufruf.
  const fremd = await verifyCursor(c, {
    ...basis, expectedQuery: "lead.context", expectedScopeKind: "lead",
    expectedScopeId: "lead-2", scopeObject: leadZwei,
  });
  assert.equal(fremd.ok, false, "ein Cursor auf lead-1 diente als Cursor für lead-2");
  assert.equal(fremd.status, 403);
  assert.equal(fremd.reason, "cursor_scope_mismatch");

  // Fehlende Erwartung ⇒ gesperrt, nicht wohlwollend geprüft.
  for (const fehlt of ["expectedQuery", "expectedScopeKind", "expectedScopeId", "scopeObject"]) {
    const args = {
      ...basis, expectedQuery: "lead.context", expectedScopeKind: "lead",
      expectedScopeId: "lead-1", scopeObject: leadEins,
    };
    delete args[fehlt];
    const res = await verifyCursor(c, args);
    assert.equal(res.ok, false, `ohne ${fehlt} wurde geprüft`);
    assert.equal(res.status, 403);
  }

  // Das geladene Objekt muss zum Scope passen (nicht nur der Cursor).
  const schief = await verifyCursor(c, {
    ...basis, expectedQuery: "lead.context", expectedScopeKind: "lead",
    expectedScopeId: "lead-1", scopeObject: leadZwei,
  });
  assert.equal(schief.reason, "scope_object_mismatch");

  // Jede Seite wird NEU autorisiert: fremder Eigentümer ⇒ 403, obwohl der
  // Cursor gültig signiert ist.
  const fremderEigentuemer = await verifyCursor(c, {
    ...basis, expectedQuery: "lead.context", expectedScopeKind: "lead",
    expectedScopeId: "lead-1", scopeObject: { ...leadEins, ownerId: "uid-fremd" },
  });
  assert.equal(fremderEigentuemer.ok, false, "die Seite wurde nicht neu autorisiert");
  assert.equal(fremderEigentuemer.reason, "object_not_owned");

  // Und ein Spezialist, dessen Auftrag ein anderer ist, blättert nicht weiter.
  const claude = { kind: "worker", issuedBy: ISSUERS.jobToken, id: "claude-spezialist", role: "specialist_claude", tenant: TENANT, jobId: "run-1" };
  const runCursor = (await signCursor({
    config: cursorConfig, principal: claude, query: "run.context", scopeId: "run-1",
    dataRevision: "rev-1", policyVersion: POLICY_VERSION, now,
  })).cursor;
  const andererAuftrag = await verifyCursor(runCursor, {
    config: cursorConfig, authConfig: config, principal: { ...claude, jobId: "run-9" },
    expectedQuery: "run.context", expectedScopeKind: "run", expectedScopeId: "run-1",
    policyVersion: POLICY_VERSION, dataRevision: "rev-1",
    scopeObject: { kind: "run_context", id: "run-1", tenant: TENANT, jobId: "run-1" }, now,
  });
  assert.equal(andererAuftrag.ok, false);
  assert.equal(andererAuftrag.reason, "object_foreign_job");

  // Gegenprobe: passende Erwartung, passendes Objekt, eigener Lead.
  const gut = await verifyCursor(c, {
    ...basis, expectedQuery: "lead.context", expectedScopeKind: "lead",
    expectedScopeId: "lead-1", scopeObject: leadEins,
  });
  assert.equal(gut.ok, true);
  assert.equal(gut.page.scopeId, "lead-1");
});

/* ══ (9)+(10) describePage nannte Unbrauchbares „vollständig" ═════════════
 * Gemeldet: `{items:{error:"source-unavailable"}, hasMore:false}` ergab
 * complete=true; und `hasMore` war gar nicht verpflichtend.
 * ------------------------------------------------------------------------ */
test("(9) unbrauchbare Lieferdaten sind nie vollständig", () => {
  const gemeldet = describePage({ items: { error: "source-unavailable" }, hasMore: false });
  assert.equal(gemeldet.complete, false, "eine Fehlermeldung galt als vollständige Seite");
  assert.equal(gemeldet.status, "aborted");
  assert.equal(gemeldet.reason, "invalid_items");

  for (const items of [undefined, null, "nichts", 42, { länge: 0 }]) {
    const res = describePage({ items, hasMore: false });
    assert.equal(res.complete, false, `${JSON.stringify(items)} galt als vollständig`);
  }
  // Auch EIN fehlerhafter Eintrag in einer sonst gültigen Liste.
  const mitFehler = describePage({ items: [{ id: 1 }, { error: "kaputt" }], hasMore: false });
  assert.equal(mitFehler.complete, false);
  assert.equal(mitFehler.reason, "item_error");
});

test("(10) ohne ausdrückliches hasMore gilt eine Seite als abgebrochen", () => {
  const ohne = describePage({ items: [{ id: 1 }] });
  assert.equal(ohne.complete, false, "fehlendes hasMore galt als „nichts mehr da“");
  assert.equal(ohne.status, "aborted");
  assert.equal(ohne.reason, "has_more_missing");

  for (const hasMore of [undefined, null, "false", 0, 1]) {
    assert.equal(describePage({ items: [{ id: 1 }], hasMore }).complete, false,
      `hasMore=${JSON.stringify(hasMore)} galt als vollständig`);
  }
  // Nur ein echtes `false` mit brauchbaren Daten ist „vollständig".
  assert.equal(describePage({ items: [{ id: 1 }], hasMore: false }).complete, true);
  // Eine gedeckelte Seite ist nie vollständig.
  assert.equal(describePage({ items: [{ id: 1 }], hasMore: false, aborted: true, abortReason: "seitenlimit" }).complete, false);
});

/* ══ (11) Vertrag: JWT statt Eigenbauprotokoll ════════════════════════════ */
test("(11) Job-Token und Cursor sind JWT mit fester Algorithmenliste", async () => {
  const t = (await mintJobToken({ config, audience: "quantus-ingest", jobId: "job-1",
    role: "specialist_claude", principalId: "claude-spezialist", tenant: TENANT, now })).token;
  assert.equal(t.split(".").length, 3, "kein JWS-Compact-Format");
  assert.ok(!t.startsWith("qv3j1."), "das alte Eigenbauformat lebt weiter");

  const secret = new TextEncoder().encode(JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret);
  // „alg: none" — das klassische Gegenbeispiel.
  const kopf = Buffer.from(JSON.stringify({ alg: "none", kid: "w1", typ: JOB_TOKEN_TYP }), "utf8").toString("base64url");
  const koerper = Buffer.from(JSON.stringify({
    iss: JOB_TOKEN_ISSUER, aud: "quantus-ingest", sub: "x", job: "job-1", role: "specialist_claude",
    tenant: TENANT, policyVersion: POLICY_VERSION, iat: NOW_SEC, exp: NOW_SEC + 300, jti: "x",
  }), "utf8").toString("base64url");
  // Signaturteil bewusst NICHT leer: sonst greift die Formprüfung, und der
  // Fall „alg: none" wäre gar nicht geprüft.
  const ohneAlg = `${kopf}.${koerper}.AAAA`;
  const res = await verifyJobToken(ohneAlg, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "token_alg_not_allowed");

  // Ein RS256-signiertes Token gegen den HMAC-Schlüsselsatz: keine
  // Algorithmus-Verwechslung.
  const rs = makeIdToken({ key, sub: "x" });
  assert.equal((await verifyJobToken(rs, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now })).reason,
    "token_alg_not_allowed");

  // Der Cursor benutzt einen EIGENEN Schlüsselsatz: ein Job-Token-Schlüssel
  // signiert keinen gültigen Cursor (in der Cursor-Testdatei ausführlich).
  const c = (await signCursor({ config: cursorConfig, principal: nutzer, query: "run.queue", scopeId: "alle",
    dataRevision: "rev-1", policyVersion: POLICY_VERSION, now })).cursor;
  assert.equal(c.split(".").length, 3);
  assert.ok(!c.startsWith("qv3c1."), "das alte Cursorformat lebt weiter");
  void secret;
});

/* ══ (12) Vertrag: exakte Fachverben, enge Lesepfade ══════════════════════ */
test("(12) die Matrix trägt die Fachverben des Konzepts, nicht Sammelverben", () => {
  const konzept = [
    "intake.create", "intake.accept", "task.create",
    "lead.comment", "lead.transition", "lead.schedule",
    "briefing.answer", "briefing.consumeAnswer",
    "question.create", "question.resolve",
    "document.register", "document.processed",
    "worker.assign", "worker.return", "worker.review",
    "run.ensure", "run.claim", "run.renew", "run.checkpoint", "run.finalize",
    "note.append", "run.log",
  ];
  for (const verb of konzept) assert.ok(VERBS.includes(verb), `${verb} fehlt in der Matrix`);
  for (const sammelverb of ["command.submit", "job.advance", "job.create", "object.read", "mail.send", "lead.finalize"]) {
    assert.equal(VERBS.includes(sammelverb), false, `Sammelverb ${sammelverb} ist noch da`);
  }
  // Gelesen wird nur über benannte Abfragen.
  assert.ok(VERBS.includes("context.read"));
  for (const [name, q] of Object.entries(NAMED_QUERIES)) {
    assert.equal(q.verb, "context.read", `${name} liest mit einem anderen Verb`);
    assert.ok(q.maxPageSize > 0 && q.maxPageSize <= 100);
  }
  // Spezialist: nur sein Auftrag, nur worker.return.
  for (const rolle of ["specialist_claude", "specialist_gemini"]) {
    assert.deepEqual(Object.keys(ROLE_POLICY[rolle].verbs), ["context.read", "worker.return"]);
  }
  // Leitung delegiert und prüft, antwortet aber nie für den Nutzer.
  const leitung = ROLE_POLICY.lead_agent.verbs;
  assert.ok(leitung["worker.assign"] && leitung["worker.review"]);
  assert.equal(leitung["briefing.answer"], undefined);
  assert.equal(leitung["question.resolve"], undefined);
  assert.equal(leitung["run.finalize"], undefined);
  assert.equal(leitung["note.append"], undefined, "Startnotizen bleiben beim Backend");
});
