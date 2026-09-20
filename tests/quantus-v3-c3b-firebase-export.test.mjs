/*
 * v3 C3b — Gate G1: der scope-gebundene Token, und die Regression der
 * bestehenden Admin-Funktionen.
 *
 * WARUM DIESE DATEI: Die Widerrufs- und Sperrprüfung (`accounts:lookup`)
 * braucht einen Token mit `identitytoolkit`. Der Admin-Token von
 * firebase-admin trägt das nicht (`firebase.database`, `userinfo.email`,
 * `devstorage.full_control`) — solange es keinen zweiten, eng gebundenen Weg
 * gab, blieb jeder Nutzer-Ausweis 503. Dieses Gate ist jetzt geschlossen:
 * `getIdentityAccessToken` benutzt DIESELBE Zugangsauflösung und DENSELBEN
 * Tausch, nur mit anderem Scope — und prüft Scope, Projekt und Frist echt.
 *
 * Weil dafür `getAdminAccessToken` in einen gemeinsamen Tausch zerlegt wurde,
 * prüft die zweite Hälfte dieser Datei die bestehenden Wege nach: derselbe
 * Antragskörper (der Admin-Weg nennt WEITERHIN keinen Scope), dieselben
 * Fehlermeldungen, derselbe Cache, dieselbe 401-Räumung, dieselben
 * RTDB-Funktionen.
 *
 * Alles synthetisch: die „Dienstkonto"-Schlüssel entstehen zur Laufzeit,
 * jeder Netzweg ist eine Attrappe. Kein echtes Zugangsdatum, keine
 * Berechtigung, keine OAuth-Zustimmung, kein Netz, keine Kosten.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { buildRuntimeDeps, resetRuntimeCachesForTests } from "../netlify/lib/quantus-v3-runtime.mjs";
import { resetIdentityAccessCacheForTests, IDENTITY_SCOPE } from "../netlify/lib/quantus-v3-identity-access.mjs";
import { makeDomain, OWNER, TENANT } from "./fixtures/quantus-v3-c2-fixtures.mjs";
import { PROJECT_ID, POLICY_VERSION } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const IDENTITY = "https://www.googleapis.com/auth/identitytoolkit";
const CLOUD = "https://www.googleapis.com/auth/cloud-platform";
const ADMIN_SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/devstorage.full_control",
].join(" ");
const DB = "https://fake-rtdb.test";
const GEHEIM = "SYNTHETIC-SECRET-NUR-IM-TEST";

/* Ein „Dienstkonto" aus einem frisch erzeugten Schlüssel — nie ein echtes. */
const dienstkonto = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    json: JSON.stringify({
      project_id: PROJECT_ID,
      client_email: "attrappe@test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
    publicKey,
  };
})();

/* Jeder Fall bekommt eine FRISCHE Modulinstanz: der Tokencache von
   firebase-admin liegt im Modul, und ein Test darf nicht den Stand des
   vorigen erben. */
let instanz = 0;
async function frischesFirebase() {
  return import(`../netlify/lib/firebase-admin.mjs?fall=${++instanz}`);
}

const OAUTH_REFRESH = {
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_DATABASE_URL: DB,
  FIREBASE_OAUTH_REFRESH_TOKEN: "attrappe-refresh-token",
  FIREBASE_OAUTH_CLIENT_ID: "attrappe-client-id",
  FIREBASE_OAUTH_CLIENT_SECRET: "attrappe-client-secret",
  FIREBASE_SERVICE_ACCOUNT_JSON: null,
  FIREBASE_CLIENT_EMAIL: null,
  FIREBASE_PRIVATE_KEY: null,
  GOOGLE_CLIENT_ID: null,
  GOOGLE_CLIENT_SECRET: null,
};
const DIENSTKONTO = { ...OAUTH_REFRESH, FIREBASE_OAUTH_REFRESH_TOKEN: null, FIREBASE_OAUTH_CLIENT_ID: null, FIREBASE_OAUTH_CLIENT_SECRET: null, FIREBASE_SERVICE_ACCOUNT_JSON: dienstkonto.json };

/* Prozessumgebung und `fetch` für die Dauer eines Falls — danach wie vorher. */
async function imLauf(werte, transport, ablauf) {
  const vorher = {};
  for (const [name, wert] of Object.entries(werte)) {
    vorher[name] = process.env[name];
    if (wert == null) delete process.env[name];
    else process.env[name] = String(wert);
  }
  const alterFetch = globalThis.fetch;
  globalThis.fetch = transport;
  try {
    return await ablauf(await frischesFirebase());
  } finally {
    globalThis.fetch = alterFetch;
    for (const [name, wert] of Object.entries(vorher)) {
      if (wert === undefined) delete process.env[name];
      else process.env[name] = wert;
    }
  }
}

/* Ein Transport, der mitschreibt, was verlangt wurde. */
function transportMit({ tokenAntwort = { access_token: "attrappe-token", expires_in: 3600, scope: IDENTITY }, tokenStatus = 200, rtdb = null } = {}) {
  const spur = { tokenAnfragen: [], dbAnfragen: [] };
  const antwort = (daten, { status = 200, headers = {} } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    async json() { return daten; },
    async text() { return JSON.stringify(daten); },
  });
  const transport = async (url, init = {}) => {
    const adresse = String(url);
    if (adresse.startsWith("https://oauth2.googleapis.com/token")) {
      const form = new URLSearchParams(String(init.body || ""));
      spur.tokenAnfragen.push(Object.fromEntries(form.entries()));
      return antwort(tokenStatus === 200 ? tokenAntwort : { error: "invalid_grant", error_description: `refresh_token=${GEHEIM}` }, { status: tokenStatus });
    }
    if (adresse.includes("accounts:lookup")) {
      return antwort({ users: [{ localId: OWNER, disabled: false, validSince: "0", tenantId: TENANT }] });
    }
    if (rtdb) return rtdb(adresse, init, antwort, spur);
    throw new Error(`unerwarteter Aufruf: ${adresse}`);
  };
  return { spur, transport };
}

/* ══ Teil 1: der neue, scope-gebundene Weg ════════════════════════════════ */

test("G1: der Token ist scope- und projektgebunden — echt geprüft", async () => {
  const { spur, transport } = transportMit();
  await imLauf(OAUTH_REFRESH, transport, async (fb) => {
    // Projekt: ein anderes als das konfigurierte ⇒ kein Token, kein Netz.
    await assert.rejects(() => fb.getIdentityAccessToken({ projectId: "ein-anderes-projekt" }),
      (err) => err.code === "project_mismatch");
    assert.equal(spur.tokenAnfragen.length, 0, "es wurde trotz Projektfehler getauscht");

    // Scope: diese Funktion ist keine allgemeine Tokenausgabe.
    await assert.rejects(() => fb.getIdentityAccessToken({ scope: "https://www.googleapis.com/auth/devstorage.full_control" }),
      (err) => err.code === "scope_not_supported");
    assert.equal(spur.tokenAnfragen.length, 0);

    // Der gute Fall: der Tausch nennt den nötigen Scope ausdrücklich.
    const ergebnis = await fb.getIdentityAccessToken({ projectId: PROJECT_ID });
    assert.equal(ergebnis.token, "attrappe-token");
    assert.equal(ergebnis.scope, IDENTITY);
    assert.equal(ergebnis.projectId, PROJECT_ID);
    assert.equal(ergebnis.source, "oauth_refresh");
    assert.ok(ergebnis.expiresAt > Date.now() + 3_500_000, "die Frist kommt nicht aus expires_in");
    assert.equal(spur.tokenAnfragen.length, 1);
    assert.equal(spur.tokenAnfragen[0].scope, IDENTITY, "der Tausch verlangte den Scope nicht");
    assert.equal(spur.tokenAnfragen[0].grant_type, "refresh_token");

    // KEIN Cache an dieser Stelle: der Aufrufer hält den begrenzten Speicher.
    await fb.getIdentityAccessToken({});
    assert.equal(spur.tokenAnfragen.length, 2, "firebase-admin cacht den Identity-Token doch");
  });
});

test("G1: ein zu enger, fristloser oder fehlender Token gilt nicht", async () => {
  const faelle = [
    ["zu enger Scope", { access_token: "t", expires_in: 3600, scope: "https://www.googleapis.com/auth/firebase.database" }, "scope_missing"],
    ["Frist fehlt", { access_token: "t", scope: IDENTITY }, "lifetime_invalid"],
    ["Frist negativ", { access_token: "t", expires_in: -60, scope: IDENTITY }, "lifetime_invalid"],
    ["Frist keine Zahl", { access_token: "t", expires_in: "bald", scope: IDENTITY }, "lifetime_invalid"],
  ];
  for (const [name, tokenAntwort, code] of faelle) {
    const { transport } = transportMit({ tokenAntwort });
    await imLauf(OAUTH_REFRESH, transport, async (fb) => {
      await assert.rejects(() => fb.getIdentityAccessToken({}), (err) => err.code === code, name);
    });
  }

  // `cloud-platform` ist übergeordnet und genügt.
  const { transport } = transportMit({ tokenAntwort: { access_token: "t", expires_in: 600, scope: `${CLOUD} openid` } });
  await imLauf(OAUTH_REFRESH, transport, async (fb) => {
    assert.equal((await fb.getIdentityAccessToken({})).token, "t");
  });

  // Ohne Zugangsdaten: kein Versuch, keine erfundene Ausnahme.
  const leer = transportMit();
  await imLauf({ ...OAUTH_REFRESH, FIREBASE_OAUTH_REFRESH_TOKEN: null, FIREBASE_OAUTH_CLIENT_ID: null, FIREBASE_OAUTH_CLIENT_SECRET: null }, leer.transport, async (fb) => {
    assert.equal(fb.firebaseAccessCredentialsConfigured(), false);
    await assert.rejects(() => fb.getIdentityAccessToken({}), (err) => err.code === "credentials_missing");
    assert.equal(leer.spur.tokenAnfragen.length, 0);
  });

  // Und ein Fehlschlag des Tausches trägt kein Zugangsdatum weiter.
  const kaputt = transportMit({ tokenStatus: 400 });
  await imLauf(OAUTH_REFRESH, kaputt.transport, async (fb) => {
    try {
      await fb.getIdentityAccessToken({});
      assert.fail("ein fehlgeschlagener Tausch lieferte einen Token");
    } catch (err) {
      assert.match(err.message, /Firebase OAuth-Refresh fehlgeschlagen/);
      // Google nennt hier eine Beschreibung; das Modul, das sie weitergibt,
      // ist firebase-admin — die v3-Grenze sanitisiert sie (G-7/8).
      assert.equal(typeof err.message, "string");
    }
  });
});

test("G1: der Dienstkonto-Weg signiert MIT dem verlangten Scope", async () => {
  const { spur, transport } = transportMit({ tokenAntwort: { access_token: "sa-token", expires_in: 3600, scope: IDENTITY } });
  await imLauf(DIENSTKONTO, transport, async (fb) => {
    assert.equal(fb.firebaseAccessCredentialsConfigured(), true);
    const ergebnis = await fb.getIdentityAccessToken({ projectId: PROJECT_ID });
    assert.equal(ergebnis.token, "sa-token");
    assert.equal(ergebnis.source, "service_account");

    const anfrage = spur.tokenAnfragen[0];
    assert.equal(anfrage.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [kopf, inhalt, signatur] = String(anfrage.assertion).split(".");
    const claim = JSON.parse(Buffer.from(inhalt, "base64url").toString("utf8"));
    assert.equal(claim.scope, IDENTITY, "das JWT verlangt nicht den Identity-Scope");
    assert.equal(claim.aud, "https://oauth2.googleapis.com/token");
    assert.equal(claim.iss, "attrappe@test.iam.gserviceaccount.com");
    // Die Signatur ist echt — sie prüft gegen den erzeugten Schlüssel.
    const pruefer = createVerify("RSA-SHA256");
    pruefer.update(`${kopf}.${inhalt}`);
    assert.ok(pruefer.verify(dienstkonto.publicKey, Buffer.from(signatur, "base64url")), "die Signatur stimmt nicht");
  });
});

test("G1 geschlossen: die Laufzeit prüft den Widerruf über den Export", async () => {
  resetRuntimeCachesForTests();
  resetIdentityAccessCacheForTests();
  const { spur, transport } = transportMit();
  await imLauf(OAUTH_REFRESH, transport, async (fb) => {
    const read = (name) => ({
      QUANTUS_V3_FIREBASE_PROJECT_ID: PROJECT_ID,
      QUANTUS_V3_FIREBASE_TENANT: TENANT,
      QUANTUS_V3_POLICY_VERSION: POLICY_VERSION,
      QUANTUS_V3_MODE: "dry_run",
    }[name] ?? process.env[name]);

    const deps = await buildRuntimeDeps({
      write: false, read, firebaseModule: fb, idempotencyModule: null,
      domainFactory: () => makeDomain(), fetchImpl: transport, now: () => Date.now(),
    });
    assert.equal(deps.wiring.identityAccess, true);
    assert.equal(deps.wiring.identityAccessSource, "firebase:getIdentityAccessToken",
      "die Laufzeit nimmt den scope-gebundenen Export nicht");
    assert.equal(typeof deps.userLookup, "function");

    const datensatz = await deps.userLookup(OWNER);
    assert.equal(datensatz.disabled, false);
    assert.equal(datensatz.tenantId, TENANT);
    assert.equal(spur.tokenAnfragen.length, 1);
    assert.equal(spur.tokenAnfragen[0].scope, IDENTITY);

    // Ein zweiter Lookup nimmt den gecachten Token — prüft aber ERNEUT.
    await deps.userLookup(OWNER);
    assert.equal(spur.tokenAnfragen.length, 1, "der Token wurde erneut geholt");
  });
});

/* ══ Teil 2: Regression der bestehenden Admin-Funktionen ══════════════════ */

function rtdbAttrappe({ kern = { data: JSON.stringify({ entities: { leads: {} }, automation: { schemaVersion: 3, dataRevision: 1, idempotencyByKey: {} } }), etag: "logisch-1" }, erstes401 = false } = {}) {
  let einmal401 = erstes401;
  let stand = kern;
  return (adresse, init, antwort, spur) => {
    const methode = String(init.method || "GET").toUpperCase();
    spur.dbAnfragen.push({ adresse, methode, headers: init.headers || {}, ifMatch: init.headers?.["if-match"] ?? null });
    if (einmal401) { einmal401 = false; return antwort({ error: "unauthorized" }, { status: 401 }); }
    if (methode === "GET") return antwort(stand, { headers: { etag: "server-1" } });
    if (methode === "PUT") {
      if ((init.headers?.["if-match"] ?? null) !== "server-1") return antwort({ error: "conflict" }, { status: 412 });
      stand = JSON.parse(String(init.body));
      return antwort({ ok: true });
    }
    return antwort({ ok: true });
  };
}

test("Regression: der Admin-Tausch nennt WEITERHIN keinen Scope", async () => {
  const { spur, transport } = transportMit({ tokenAntwort: { access_token: "admin-token", expires_in: 3600 }, rtdb: rtdbAttrappe() });
  await imLauf(OAUTH_REFRESH, transport, async (fb) => {
    const gelesen = await fb.firebaseDbGetWithEtag("appStore/app-data_json");
    assert.equal(gelesen.exists, true);
    assert.equal(gelesen.serverEtag, "server-1");

    assert.equal(spur.tokenAnfragen.length, 1);
    assert.equal(spur.tokenAnfragen[0].grant_type, "refresh_token");
    assert.equal(spur.tokenAnfragen[0].scope, undefined,
      "der Admin-Weg verlangt jetzt einen Scope — das ändert den bestehenden Zugang");
    // Der Lesevorgang trägt weiterhin die ETag-Bitte und kein Zwischenlager.
    assert.equal(spur.dbAnfragen[0].headers["X-Firebase-ETag"], "true");
    assert.equal(spur.dbAnfragen[0].headers["Cache-Control"], "no-store");
    assert.ok(spur.dbAnfragen[0].adresse.startsWith(`${DB}/appStore/`));
  });
});

test("Regression: der Dienstkonto-Admin-Token trägt genau die ADMIN_SCOPES", async () => {
  const { spur, transport } = transportMit({ tokenAntwort: { access_token: "admin-sa", expires_in: 3600 }, rtdb: rtdbAttrappe() });
  await imLauf(DIENSTKONTO, transport, async (fb) => {
    await fb.firebaseDbGet("appStore/app-data_json");
    const claim = JSON.parse(Buffer.from(String(spur.tokenAnfragen[0].assertion).split(".")[1], "base64url").toString("utf8"));
    assert.equal(claim.scope, ADMIN_SCOPES, "die Admin-Scopes haben sich verändert");
  });
});

test("Regression: Cache, 401-Räumung, Fehlermeldungen, CAS-Wege", async () => {
  // (a) Cache: zwei Zugriffe, ein Tokentausch.
  const a = transportMit({ tokenAntwort: { access_token: "admin-token", expires_in: 3600 }, rtdb: rtdbAttrappe() });
  await imLauf(OAUTH_REFRESH, a.transport, async (fb) => {
    await fb.firebaseDbGet("appStore/app-data_json");
    await fb.firebaseDbGet("appStore/app-data_json");
    assert.equal(a.spur.tokenAnfragen.length, 1, "der Admin-Token wird nicht mehr gecacht");
  });

  // (b) 401 räumt den Cache: der nächste Zugriff holt einen neuen Token.
  const b = transportMit({ tokenAntwort: { access_token: "admin-token", expires_in: 3600 }, rtdb: rtdbAttrappe({ erstes401: true }) });
  await imLauf(OAUTH_REFRESH, b.transport, async (fb) => {
    await assert.rejects(() => fb.firebaseDbGet("appStore/app-data_json"));
    await fb.firebaseDbGet("appStore/app-data_json");
    assert.equal(b.spur.tokenAnfragen.length, 2, "nach 401 wurde der alte Token weiterbenutzt");
  });

  // (c) Die Fehlermeldungen der beiden Zugangswege sind unverändert.
  const c1 = transportMit({ tokenStatus: 400 });
  await imLauf(OAUTH_REFRESH, c1.transport, async (fb) => {
    await assert.rejects(() => fb.firebaseDbGet("x"), /Firebase OAuth-Refresh fehlgeschlagen/);
  });
  const c2 = transportMit({ tokenStatus: 400 });
  await imLauf(DIENSTKONTO, c2.transport, async (fb) => {
    await assert.rejects(() => fb.firebaseDbGet("x"), /Firebase Admin OAuth fehlgeschlagen/);
  });

  // (d) Die CAS-Wege selbst: if-match, Konflikt, Wrapper, Kernpolitik.
  const d = transportMit({ tokenAntwort: { access_token: "admin-token", expires_in: 3600 }, rtdb: rtdbAttrappe() });
  await imLauf(OAUTH_REFRESH, d.transport, async (fb) => {
    const doc = await fb.readAppDataDocument("app-data.json");
    assert.equal(doc.exists, true);
    assert.equal(doc.etag, "logisch-1");
    assert.equal(typeof doc.parsed, "object");

    const gesetzt = await fb.firebaseDbSet("appStore/app-data_json", { data: JSON.stringify({ entities: {} }) }, { ifMatch: "server-1" });
    assert.deepEqual(gesetzt, { ok: true, conflict: false });
    const konflikt = await fb.firebaseDbSet("appStore/app-data_json", { data: "{}" }, { ifMatch: "falsch" });
    assert.deepEqual(konflikt, { ok: false, conflict: true });

    // Der Kerndatensatz wird NIE ohne Vorbedingung geschrieben.
    const ohneBedingung = await fb.writeAppDataText("app-data.json", JSON.stringify({ entities: {} }), {});
    assert.equal(ohneBedingung.ok, false);
    assert.equal(ohneBedingung.reason, "precondition_required");

    // Und der Mutator läuft mit echtem If-Match.
    const ergebnis = await fb.mutateAppData("app-data.json", (aktuell) => ({
      data: { ...aktuell, entities: { ...aktuell.entities, leads: { l1: { id: "l1" } } } },
      result: { ok: true },
    }));
    assert.deepEqual(ergebnis.result, { ok: true });
    const puts = d.spur.dbAnfragen.filter((r) => r.methode === "PUT" && r.ifMatch === "server-1");
    assert.ok(puts.length >= 1, "es wurde ohne If-Match geschrieben");
  });
});

test("Regression: die Zugangsprüfung und die Projektauskunft sind ehrlich", async () => {
  const { transport } = transportMit();
  await imLauf(OAUTH_REFRESH, transport, async (fb) => {
    assert.equal(fb.firebaseAccessCredentialsConfigured(), true);
    assert.equal(fb.firebaseConfiguredProjectId(), PROJECT_ID);
  });
  // Ein HALBES OAuth-Paar ist keine Konfiguration (fail closed).
  await imLauf({ ...OAUTH_REFRESH, FIREBASE_OAUTH_CLIENT_SECRET: null }, transport, async (fb) => {
    assert.equal(fb.firebaseAccessCredentialsConfigured(), false);
  });
  // Das Projekt kommt auch aus dem Dienstkonto-JSON — nur `project_id`.
  await imLauf({ ...DIENSTKONTO, FIREBASE_PROJECT_ID: null }, transport, async (fb) => {
    assert.equal(fb.firebaseConfiguredProjectId(), PROJECT_ID);
  });
  // Und der Identity-Scope, den die v3-Seite verlangt, ist derselbe.
  await imLauf(OAUTH_REFRESH, transport, async (fb) => {
    assert.equal(fb.IDENTITY_TOOLKIT_SCOPE, IDENTITY_SCOPE);
  });
});
