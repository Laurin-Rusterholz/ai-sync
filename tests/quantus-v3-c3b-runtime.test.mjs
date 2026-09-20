/*
 * v3 C3b — die TATSÄCHLICHE Laufzeitverdrahtung.
 *
 * Kein handgebauter Dienst: hier läuft `buildRuntimeDeps()`, und damit der
 * echte Weg — `readAppDataDocument`/`mutateAppData` des Integrationsstandes
 * mit echtem If-Match und geprüfter `unchanged`-Rückgabe, der echte
 * Idempotenz-Ledger desselben Standes, der CAS-Ratenzähler, der echte
 * Schlüsselbezug und der echte Zugriffstoken-Provider. Ersetzt ist nur der
 * TRANSPORT: `fetch` antwortet konditional wie Google und Firebase, mit
 * Attrappenwerten.
 *
 * Damit beantwortet diese Datei vier Fragen:
 *   1. Greift die Verdrahtung wirklich den echten CAS — oder ein Testmodell?
 *      (Der Fake-Transport zählt PUTs und prüft jedes If-Match.)
 *   2. Was passiert ohne Fachadapter, ohne Idempotenzmodul, ohne
 *      Zugriffstoken? (503 — und nichts geschieht.)
 *   3. Kommt ein Rohmodul als Fachadapter durch? (Nein, nur die benannte
 *      Fabrik.)
 *   4. Läuft die Widerrufsprüfung echt — gesperrt, widerrufen, fremder
 *      Mandant, zu enger Scope?
 *
 * Kein echter Netzaufruf, kein echtes Zugangsdatum, keine Kosten. Die
 * Firebase-Zugangslogik liest ihre Namen aus `process.env`; dieser Test setzt
 * dort ausschliesslich Attrappen und stellt den vorigen Stand wieder her.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeDeps, createCoreStore, buildDomainAdapter, toResponse,
  resetRuntimeCachesForTests, DOMAIN_FACTORY_EXPORT, DOMAIN_ADAPTER_METHODS,
} from "../netlify/lib/quantus-v3-runtime.mjs";
import { handleCommandRequest, handleReadRequest, CORE_KEY } from "../netlify/lib/quantus-v3-service.mjs";
import { makeSigningKey, makeIdToken, sha256Hex, randomSecret, PROJECT_ID, POLICY_VERSION, TENANT } from "./fixtures/quantus-v3-auth-fixtures.mjs";
import {
  makeRequest, commandBody, commandHeaders, makeCoreSnapshot, makeDomain,
  LEAD_ID, OWNER, INTEGRATION_COMMIT,
} from "./fixtures/quantus-v3-c2-fixtures.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = "https://management-xo2-pro.netlify.app";
const DB = "https://fake-rtdb.test";
const JETZT = Date.parse("2026-09-20T09:00:00Z");
const key = makeSigningKey("c3b-kid");
const etagVon = (text) => createHash("sha256").update(String(text)).digest("hex");

/* ══ Der Integrationsstand, kontrolliert geladen ═══════════════════════════
 *
 * Der echte CAS (mit der geprüften `unchanged`-Rückgabe) und der echte
 * Idempotenz-Ledger liegen im Integrationszweig, nicht in diesem Paket. Sie
 * werden aus genau dem geprüften Commit in ein temporäres Verzeichnis gelegt
 * und von dort geladen — nichts wird ins Paket kopiert, nichts nachgebaut.
 * Klappt das nicht, sagen die Tests das ausdrücklich und prüfen die echte
 * Kette NICHT als bestanden.
 * ─────────────────────────────────────────────────────────────────────── */
function ausCommit(dateien) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qv3-c3b-"));
  for (const name of dateien) {
    const quelle = execFileSync("git", ["show", `${INTEGRATION_COMMIT}:netlify/lib/${name}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!quelle) throw new Error(`leer: ${name}`);
    fs.writeFileSync(path.join(dir, name), quelle);
  }
  return dir;
}

async function integrationsModule() {
  try {
    const dir = ausCommit(["blob-key-policy.mjs", "firebase-admin.mjs", "quantus-v3-idempotency.mjs"]);
    const firebase = await import(path.join(dir, "firebase-admin.mjs"));
    const idem = await import(path.join(dir, "quantus-v3-idempotency.mjs"));
    const quelltext = fs.readFileSync(path.join(dir, "firebase-admin.mjs"), "utf8");
    if (typeof firebase.mutateAppData !== "function" || typeof firebase.readAppDataDocument !== "function") {
      throw new Error("firebase-admin unvollständig");
    }
    if (typeof idem.prepareIdempotentCommand !== "function" || typeof idem.applyIdempotentCommand !== "function") {
      throw new Error("Idempotenz unvollständig");
    }
    return {
      ok: true, source: `git:${INTEGRATION_COMMIT}`, firebase, idem,
      // Ohne geprüfte `unchanged`-Rückgabe würde eine Wiederholung erneut
      // schreiben. Das ist eine Eigenschaft des Standes, keine Annahme.
      unchanged: quelltext.includes("unchanged_mutation_invalid"),
    };
  } catch (err) {
    return { ok: false, source: "unavailable", reason: String(err && err.message || err) };
  }
}

const INTEGRATION = await integrationsModule();
const OHNE_INTEGRATION = INTEGRATION.ok
  ? false
  : `Integrationsstand ${INTEGRATION_COMMIT} nicht ladbar (${INTEGRATION.reason}) — kein Integrationsnachweis`;

test("welcher Stand im Lauf steckt", () => {
  console.log(`# C3b: firebase-admin + Idempotenz aus ${INTEGRATION.source}`
    + (INTEGRATION.ok ? `, unchanged geprüft: ${INTEGRATION.unchanged}` : ""));
  assert.ok(true);
});

/* ══ Serverkonfiguration: echte Namen, Attrappenwerte ═════════════════════ */
function konfiguration({ schreiben = true, overrides = {} } = {}) {
  const dienst = randomSecret();
  const v3 = {
    QUANTUS_V3_FIREBASE_PROJECT_ID: PROJECT_ID,
    QUANTUS_V3_FIREBASE_TENANT: TENANT,
    QUANTUS_V3_POLICY_VERSION: POLICY_VERSION,
    QUANTUS_V3_ALLOWED_ORIGINS: APP,
    QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
      { id: "cred-sched", principal: "cloud-scheduler", role: "scheduler", tenant: TENANT, secretSha256: sha256Hex(dienst), status: "active" },
    ]),
    QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([{ kid: "w1", secret: randomSecret(), status: "active" }]),
    QUANTUS_V3_CURSOR_KEYS: JSON.stringify([{ kid: "c1", secret: randomSecret(), status: "active" }]),
    QUANTUS_V3_MODE: schreiben ? "enforce" : "dry_run",
    ...(schreiben ? { QUANTUS_V3_API_WRITES: "enabled" } : {}),
  };
  /* Diese Namen liest die BESTEHENDE Firebase-Zugangslogik selbst, aus
     process.env. Wir setzen sie für den Lauf und nehmen sie danach zurück. */
  const fb = {
    FIREBASE_PROJECT_ID: PROJECT_ID,
    FIREBASE_DATABASE_URL: DB,
    FIREBASE_OAUTH_REFRESH_TOKEN: "attrappe-refresh-token",
    FIREBASE_OAUTH_CLIENT_ID: "attrappe-client-id",
    FIREBASE_OAUTH_CLIENT_SECRET: "attrappe-client-secret",
    GOOGLE_CLIENT_ID: null,
    GOOGLE_CLIENT_SECRET: null,
    FIREBASE_SERVICE_ACCOUNT_JSON: null,
    FIREBASE_CLIENT_EMAIL: null,
    FIREBASE_PRIVATE_KEY: null,
  };
  const alle = { ...v3, ...fb, ...overrides };
  const read = (name) => (alle[name] == null ? undefined : alle[name]);
  const prozessNamen = Object.keys({ ...fb, ...overrides }).filter((n) => n.startsWith("FIREBASE_") || n.startsWith("GOOGLE_"));
  return { read, prozessNamen, alle };
}

/*
 * Ein Lauf: Prozessumgebung und `fetch` sind für die Dauer des Blocks
 * Attrappen — danach steht beides wieder wie vorher.
 */
async function imLauf({ schreiben = true, overrides = {}, transportOptionen = {} }, ablauf) {
  const cfg = konfiguration({ schreiben, overrides });
  const vorher = {};
  for (const name of cfg.prozessNamen) {
    vorher[name] = process.env[name];
    if (cfg.alle[name] == null) delete process.env[name];
    else process.env[name] = String(cfg.alle[name]);
  }
  const alterFetch = globalThis.fetch;
  const t = fakeTransport(transportOptionen);
  globalThis.fetch = t.transport;
  try {
    return await ablauf({ read: cfg.read, t });
  } finally {
    globalThis.fetch = alterFetch;
    for (const [name, wert] of Object.entries(vorher)) {
      if (wert === undefined) delete process.env[name];
      else process.env[name] = wert;
    }
  }
}

/* ══ Der konditionale Fake-Transport ══════════════════════════════════════ */
function fakeTransport({
  kern = makeCoreSnapshot(),
  lookup = { disabled: false, validSince: 0, tenantId: TENANT },
  identityScope = "https://www.googleapis.com/auth/identitytoolkit",
} = {}) {
  const spur = { identityToken: 0, adminToken: 0, dbGets: 0, dbPuts: 0, ifMatches: [], lookups: 0, zertAbrufe: 0, ratePuts: 0 };
  let kernText = JSON.stringify(kern);
  let kernEtag = etagVon(kernText);
  const rateKnoten = new Map();

  const antwort = (daten, { status = 200, headers = {} } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    async json() { return daten; },
    async text() { return JSON.stringify(daten); },
  });

  const transport = async (url, init = {}) => {
    const adresse = String(url);
    const methode = String(init.method || "GET").toUpperCase();

    // 1. OAuth — dieselbe Gegenstelle für die Firebase-Zugangslogik und für
    //    den Identity-Access-Provider. Die Antwort nennt die Scopes.
    if (adresse.startsWith("https://oauth2.googleapis.com/token")) {
      const body = String(init.body || "");
      const fuerIdentity = body.includes("identitytoolkit");
      if (fuerIdentity) spur.identityToken++; else spur.adminToken++;
      return antwort({
        access_token: fuerIdentity ? "attrappe-identity-token" : "attrappe-admin-token",
        expires_in: 3600,
        scope: fuerIdentity ? identityScope : "https://www.googleapis.com/auth/firebase.database",
      });
    }

    // 2. Googles öffentliche Schlüssel für die Signaturprüfung
    if (adresse.includes("securetoken@system.gserviceaccount.com")) {
      spur.zertAbrufe++;
      return antwort({ [key.kid]: key.publicPem }, { headers: { "cache-control": "public, max-age=3600" } });
    }

    // 3. accounts:lookup — Sperre und Widerruf
    if (adresse.includes("identitytoolkit.googleapis.com") && adresse.includes("accounts:lookup")) {
      spur.lookups++;
      if (!String(init.headers?.Authorization || "").startsWith("Bearer ")) return antwort({ error: "unauthorized" }, { status: 401 });
      return antwort({ users: [{ localId: OWNER, disabled: lookup.disabled, validSince: String(lookup.validSince), tenantId: lookup.tenantId }] });
    }

    // 4. Der Kerndatensatz — mit echtem If-Match
    if (adresse.startsWith(`${DB}/appStore/`)) {
      if (methode === "GET") {
        spur.dbGets++;
        return antwort({ data: kernText, etag: kernEtag, savedBy: "test" }, { headers: { etag: kernEtag } });
      }
      if (methode === "PUT") {
        spur.dbPuts++;
        const ifMatch = init.headers?.["if-match"] ?? null;
        spur.ifMatches.push(ifMatch);
        if (ifMatch !== kernEtag) return antwort({ error: "conflict" }, { status: 412 });
        const wrap = JSON.parse(String(init.body));
        kernText = wrap.data;
        kernEtag = etagVon(kernText);
        return antwort({ ok: true }, { headers: { etag: kernEtag } });
      }
    }

    // 5. Der Schutzknoten der Ratenbegrenzung (kein Fachbestand)
    if (adresse.startsWith(`${DB}/quantusV3RateLimits/`)) {
      const eintrag = rateKnoten.get(adresse);
      if (methode === "GET") {
        // Auch ein leerer Knoten hat einen Stempel — sonst gäbe es kein CAS.
        return antwort(eintrag ? eintrag.value : null, { headers: { etag: eintrag ? eintrag.etag : "leerer-knoten" } });
      }
      if (methode === "PUT") {
        spur.ratePuts++;
        const erwartet = eintrag ? eintrag.etag : "leerer-knoten";
        if ((init.headers?.["if-match"] ?? null) !== erwartet) return antwort({ error: "conflict" }, { status: 412 });
        const n = (eintrag?.n || 0) + 1;
        rateKnoten.set(adresse, { value: JSON.parse(String(init.body)), etag: `rate-e${n}`, n });
        return antwort({ ok: true });
      }
    }

    throw new Error(`unerwarteter Aufruf: ${methode} ${adresse}`);
  };

  return { spur, transport, get kern() { return JSON.parse(kernText); } };
}

/* Der Fachadapter kommt über die BENANNTE Fabrik — so wird C3a ihn liefern. */
function domainFabrik(optionen = {}) {
  return () => makeDomain(optionen);
}

async function laufzeit({ read, schreiben = true, domainFactory = domainFabrik(), idempotencyModule = INTEGRATION.idem, firebaseModule = INTEGRATION.firebase } = {}) {
  resetRuntimeCachesForTests();
  return buildRuntimeDeps({
    write: schreiben, read, firebaseModule, idempotencyModule, domainFactory,
    fetchImpl: globalThis.fetch, now: () => JETZT,
  });
}

function befehl({ token, idempotencyKey = null, text = "Über die echte Laufzeit" }) {
  return makeRequest({
    headers: commandHeaders({ token, origin: APP, idempotencyKey }),
    body: commandBody({ verb: "lead.comment", expectedEntityVersion: 17, payload: { leadId: LEAD_ID, text } }),
  });
}

const nutzerToken = () => makeIdToken({ key, sub: OWNER, now: JETZT, tenant: TENANT });

/* ══ 1. Was fehlt, wird benannt — nicht ersetzt ═══════════════════════════ */
test("die Verdrahtung sagt ehrlich, was fehlt", { skip: OHNE_INTEGRATION }, async () => {
  await imLauf({}, async ({ read }) => {
    const ohneFabrik = await laufzeit({ read, domainFactory: null });
    assert.equal(ohneFabrik.domain, null);
    assert.equal(ohneFabrik.wiring.domain, false);
    assert.equal(ohneFabrik.wiring.domainReason, "domain_factory_missing");

    const ohneIdem = await laufzeit({ read, idempotencyModule: {} });
    assert.equal(ohneIdem.idempotency, null);
    assert.equal(ohneIdem.wiring.idempotency, false);

    const vollstaendig = await laufzeit({ read });
    assert.equal(vollstaendig.wiring.firebase, true);
    assert.equal(vollstaendig.wiring.store, true);
    assert.equal(vollstaendig.wiring.idempotency, true);
    assert.equal(vollstaendig.wiring.rateLimiter, true);
    assert.equal(vollstaendig.wiring.domain, true);
    assert.equal(vollstaendig.wiring.identityAccess, true);
    assert.equal(vollstaendig.wiring.identityAccessSource, "oauth_refresh_exchange");
    assert.equal(typeof vollstaendig.store.mutate, "function");
    assert.equal(typeof vollstaendig.userLookup, "function");
    // Die Diagnose nennt Namen und Gründe — niemals Werte.
    const diagnose = JSON.stringify(vollstaendig.wiring);
    for (const wert of ["attrappe-refresh-token", "attrappe-client-secret", "attrappe-identity-token"]) {
      assert.ok(!diagnose.includes(wert), "die Diagnose trägt einen Zugangswert");
    }
  });

  // Falsches Projekt: die Sperrprüfung würde im falschen Verzeichnis
  // nachsehen — also wird sie NICHT verdrahtet.
  await imLauf({ overrides: { FIREBASE_PROJECT_ID: "ein-anderes-projekt" } }, async ({ read }) => {
    const deps = await laufzeit({ read });
    assert.equal(deps.userLookup, null);
    assert.equal(deps.wiring.identityAccess, false);
    assert.equal(deps.wiring.identityAccessReason, "identity_project_mismatch");
  });

  // Ohne v3-Projektnamen gibt es gar keine Zuordnung.
  await imLauf({ overrides: { QUANTUS_V3_FIREBASE_PROJECT_ID: null } }, async ({ read }) => {
    const deps = await laufzeit({ read });
    assert.equal(deps.wiring.identityAccessReason, "identity_project_missing");
  });
});

/* ══ 2. Ein Rohmodul ist kein Fachadapter ═════════════════════════════════ */
test("nur die benannte Fabrik gilt — ein Rohmodul wird nicht übernommen", () => {
  const politik = { policyVersion: POLICY_VERSION, tenantId: TENANT, mode: "enforce" };

  // Ein Objekt, das die Methoden zufällig trägt, ist kein Rechtegeber.
  const roh = buildDomainAdapter({ factory: makeDomain(), policy: politik, now: () => JETZT });
  assert.equal(roh.ok, false);
  assert.equal(roh.reason, "domain_factory_missing");

  const unvollstaendig = buildDomainAdapter({
    factory: () => ({ resolveTarget() {}, applyVerb() {} }), policy: politik, now: () => JETZT,
  });
  assert.equal(unvollstaendig.reason, "domain_adapter_incomplete");

  const kaputt = buildDomainAdapter({
    factory: () => { throw new Error("Fabrik kaputt"); }, policy: politik, now: () => JETZT,
  });
  assert.equal(kaputt.reason, "domain_factory_failed");

  // Die Fabrik bekommt serverseitige Politik und Mandant — nicht den Request.
  let gesehen = null;
  const gut = buildDomainAdapter({
    factory: (kontext) => { gesehen = kontext; return makeDomain(); }, policy: politik, now: () => JETZT,
  });
  assert.equal(gut.ok, true);
  assert.deepEqual(Object.keys(gesehen).sort(), ["mode", "now", "policyVersion", "tenantId"]);
  assert.equal(gesehen.policyVersion, POLICY_VERSION);
  assert.equal(gesehen.tenantId, TENANT);
  assert.equal(gesehen.mode, "enforce");

  // Der Port ist genau benannt, damit C3a nichts raten muss.
  assert.equal(DOMAIN_FACTORY_EXPORT, "createQuantusV3DomainAdapter");
  assert.deepEqual([...DOMAIN_ADAPTER_METHODS].sort(),
    ["applyVerb", "assertActiveBinding", "listPage", "loadObject", "resolveTarget"]);
});

/* ══ 3. Der Speicher schreibt nur den Kern ════════════════════════════════ */
test("der Speicherport ist festgenagelt", { skip: OHNE_INTEGRATION }, async () => {
  const store = createCoreStore(INTEGRATION.firebase, { write: true });
  await assert.rejects(() => store.mutate("readinghub-data.json", (d) => d), (err) => err.code === "key_denied");
  await assert.rejects(() => store.mutate(CORE_KEY, "kein Mutator"), (err) => err.code === "mutation_invalid");

  assert.equal(createCoreStore({}, { write: true }), null);
  assert.equal(createCoreStore({ readAppDataDocument() {} }, { write: true }), null, "ohne mutateAppData ein Schreibspeicher");
  assert.equal(typeof createCoreStore({ readAppDataDocument() {} }, { write: false }).readSnapshot, "function");

  // Ein leerer oder unlesbarer Kern ist ein Restore-Fall, keine Grundlage.
  const leer = createCoreStore({ async readAppDataDocument() { return { exists: false, parsed: null }; } }, { write: false });
  await assert.rejects(() => leer.readSnapshot(), (err) => err.code === "core_unavailable");
  const kaputt = createCoreStore({ async readAppDataDocument() { return { exists: true, parsed: null }; } }, { write: false });
  await assert.rejects(() => kaputt.readSnapshot(), (err) => err.code === "core_unavailable");
});

/* ══ 4. Die echte Kette: Befehl ═══════════════════════════════════════════ */
test("ECHTE Kette: ein Befehl über die gebaute Laufzeit, echtes CAS, echter Ledger",
  { skip: OHNE_INTEGRATION }, async () => {
    await imLauf({}, async ({ read, t }) => {
      const deps = await laufzeit({ read });
      const token = nutzerToken();

      const res = await handleCommandRequest(befehl({ token, idempotencyKey: "c3b-1" }), deps);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.applied, true);
      assert.equal(res.body.replayed, false);
      assert.equal(res.body.entityVersions[LEAD_ID], 18);
      assert.equal(res.body.dataRevision, 8);
      assert.ok(res.body.serverNow);

      // Der Transport belegt: echter Schlüsselbezug, echte Widerrufsprüfung,
      // echtes CAS, echter Ratenzähler.
      assert.ok(t.spur.zertAbrufe >= 1, "die Signaturprüfung holte keine Schlüssel");
      assert.ok(t.spur.lookups >= 1, "die Widerrufsprüfung lief nicht");
      assert.ok(t.spur.dbGets >= 1, "der Kern wurde nicht gelesen");
      assert.equal(t.spur.dbPuts, 1, `es gab ${t.spur.dbPuts} Schreibvorgänge`);
      assert.ok(t.spur.ifMatches.every((w) => typeof w === "string" && w.length > 0), "geschrieben wurde ohne If-Match");
      assert.ok(t.spur.ratePuts >= 2, "der Ratenzähler zählte nicht (Gesamt und Verb)");

      // Und im geschriebenen Kern liegt ein echter Beleg.
      const kern = t.kern;
      assert.equal(kern.entities.leads[LEAD_ID].entityVersion, 18);
      assert.equal(kern.automation.dataRevision, 8);
      const belege = Object.values(kern.automation.idempotencyByKey);
      assert.equal(belege.length, 1);
      assert.equal(belege[0].state, "committed");
      assert.equal(belege[0].tenantId, TENANT);
      // Der Beleg trägt keinen Schlüsselwert im Klartext.
      assert.ok(!JSON.stringify(kern.automation.idempotencyByKey).includes("c3b-1"));

      // Wiederholung mit demselben Schlüssel: genau EIN Effekt, kein zweiter
      // Schreibvorgang (die geprüfte `unchanged`-Rückgabe des CAS).
      const wieder = await handleCommandRequest(befehl({ token, idempotencyKey: "c3b-1" }), deps);
      assert.equal(wieder.status, 200, JSON.stringify(wieder.body));
      assert.equal(wieder.body.replayed, true);
      assert.equal(wieder.body.entityVersions[LEAD_ID], 18);
      assert.equal(t.spur.dbPuts, 1, "die Wiederholung hat erneut geschrieben");
      assert.equal(t.kern.entities.leads[LEAD_ID].entityVersion, 18);

      // Ein anderer Schlüssel auf derselben erwarteten Version: 409, und der
      // Bestand bleibt, wie er ist.
      const veraltet = await handleCommandRequest(befehl({ token, idempotencyKey: "c3b-2" }), deps);
      assert.equal(veraltet.status, 409);
      assert.equal(veraltet.body.error, "stale_entity_version");
      assert.equal(t.spur.dbPuts, 1);
    });
  });

/* ══ 5. Die echte Kette: Lesen ════════════════════════════════════════════ */
test("ECHTE Kette: Lesen über die gebaute Laufzeit — ohne jeden Kernschreibvorgang",
  { skip: OHNE_INTEGRATION }, async () => {
    await imLauf({ schreiben: false }, async ({ read, t }) => {
      const deps = await laufzeit({ read, schreiben: false });
      assert.equal(deps.store.mutate, undefined, "der Leseweg hat einen Schreibport");

      const url = new URL(`${APP}/.netlify/functions/quantus-context`);
      url.searchParams.set("query", "notes.recent");
      url.searchParams.set("scopeId", LEAD_ID);
      url.searchParams.set("pageSize", "2");

      const anfrage = () => handleReadRequest(makeRequest({
        method: "GET", url: url.toString(),
        headers: { authorization: `Bearer ${nutzerToken()}`, origin: APP },
      }), deps, { route: "quantus-context" });

      const res = await anfrage();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.items.length, 2);
      assert.equal(res.body.dataRevision, 7);
      assert.ok(res.body.cursor, "kein Folgecursor");
      // Ein internes Feld bleibt drin — auch auf dem echten Weg.
      assert.ok(!JSON.stringify(res.body).includes("Sehr geehrte Frau Muster"));
      assert.equal(t.spur.dbPuts, 0, "beim Lesen wurde in den Kern geschrieben");

      // Zwei gleichzeitige Anfragen holen EIN Zugriffstoken (Singleflight und
      // Cache mit Marge) — nicht zwei.
      const vorher = t.spur.identityToken;
      const [a, b] = await Promise.all([anfrage(), anfrage()]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(t.spur.identityToken, vorher, "der Token wurde erneut geholt");
      assert.equal(t.spur.dbPuts, 0);
    });
  });

/* ══ 6. Ohne Zugriffstoken: kein Nutzer-Token gilt ════════════════════════ */
test("ohne Zugriffstoken lässt die Laufzeit kein Nutzer-Token durch", { skip: OHNE_INTEGRATION }, async () => {
  await imLauf({ overrides: { FIREBASE_OAUTH_REFRESH_TOKEN: null, FIREBASE_OAUTH_CLIENT_ID: null, FIREBASE_OAUTH_CLIENT_SECRET: null } },
    async ({ read, t }) => {
      const deps = await laufzeit({ read });
      assert.equal(deps.userLookup, null);
      assert.equal(deps.wiring.identityAccessReason, "identity_access_not_configured");

      const res = await handleCommandRequest(befehl({ token: nutzerToken() }), deps);
      assert.equal(res.status, 503);
      assert.equal(res.body.reason, "user_lookup_missing");
      assert.equal(t.spur.dbPuts, 0);
      assert.equal(t.spur.dbGets, 0, "ohne Ausweis wurde der Kern gelesen");
    });
});

/* ══ 7. Zu enger Scope: sperren, nicht erlauben ═══════════════════════════ */
test("ein zu enger Token-Scope sperrt die Anmeldung", { skip: OHNE_INTEGRATION }, async () => {
  await imLauf({ transportOptionen: { identityScope: "https://www.googleapis.com/auth/firebase.database" } },
    async ({ read, t }) => {
      const deps = await laufzeit({ read });
      assert.equal(typeof deps.userLookup, "function");
      const res = await handleCommandRequest(befehl({ token: nutzerToken() }), deps);
      assert.equal(res.status, 401, JSON.stringify(res.body));
      assert.equal(res.body.reason, "user_lookup_failed");
      assert.equal(t.spur.lookups, 0, "es wurde mit zu engem Scope nachgefragt");
      assert.equal(t.spur.dbPuts, 0);
    });
});

/* ══ 8. Sperre, Widerruf, fremder Mandant ═════════════════════════════════ */
test("die echte Sperrprüfung greift: gesperrt, widerrufen, fremder Mandant", { skip: OHNE_INTEGRATION }, async () => {
  const faelle = [
    { name: "gesperrt", lookup: { disabled: true, validSince: 0, tenantId: TENANT }, status: 403, reason: "user_disabled" },
    { name: "widerrufen", lookup: { disabled: false, validSince: Math.floor(JETZT / 1000), tenantId: TENANT }, status: 401, reason: "token_revoked" },
    { name: "fremder Mandant", lookup: { disabled: false, validSince: 0, tenantId: "anderer-mandant" }, status: 403, reason: "tenant_mismatch" },
    { name: "kaputtes validSince", lookup: { disabled: false, validSince: "vorgestern", tenantId: TENANT }, status: 401, reason: "user_lookup_failed" },
  ];
  for (const fall of faelle) {
    await imLauf({ transportOptionen: { lookup: fall.lookup } }, async ({ read, t }) => {
      const deps = await laufzeit({ read });
      const res = await handleCommandRequest(befehl({ token: nutzerToken() }), deps);
      assert.equal(res.status, fall.status, `${fall.name}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.reason, fall.reason, fall.name);
      assert.equal(t.spur.dbPuts, 0, `${fall.name}: es wurde geschrieben`);
    });
  }
});

/* ══ 9. Die Hülle gibt eine echte Response ════════════════════════════════ */
test("toResponse liefert eine echte Response", async () => {
  const mitKoerper = toResponse({ status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true } });
  assert.ok(mitKoerper instanceof Response);
  assert.equal(mitKoerper.status, 200);
  assert.deepEqual(await mitKoerper.json(), { ok: true });
  const ohne = toResponse({ status: 204, headers: {}, body: null });
  assert.equal(ohne.status, 204);
});
