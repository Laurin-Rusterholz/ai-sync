/*
 * v3 C3b — der Zugriffstoken für die Widerrufsprüfung.
 *
 * BEFUND, aus dem dieses Paket folgt: C1 verlangt für jedes Nutzer-Token eine
 * Sperr- und Widerrufsprüfung über `accounts:lookup`. Dafür braucht der Server
 * ein OAuth-Token — und der bestehende Admin-Token aus firebase-admin.mjs ist
 * dafür UNGEEIGNET: seine Scopes sind `firebase.database`, `userinfo.email` und
 * `devstorage.full_control`, nicht `identitytoolkit`. Ausserdem ist er nicht
 * exportiert.
 *
 * Also: ein eigener, streng benannter Weg — der die bestehenden Zugangsdaten
 * NUR benutzt (über die exportierte Auflösung von firebase-admin) und ohne
 * gültigen Weg lieber nichts liefert. Alle Netzwege hier sind eingespeist;
 * kein echter Google-Aufruf, kein echtes Zugangsdatum.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAccessTokenProvider, resolveIdentityAccessConfig, identityAccessAvailability,
  firebaseProjectIdFrom, IDENTITY_SCOPE, CLOUD_PLATFORM_SCOPE, GOOGLE_TOKEN_URL,
  FIREBASE_TOKEN_EXPORT, EXPIRY_MARGIN_MS, IDENTITY_ACCESS_VARS,
} from "../netlify/lib/quantus-v3-identity-access.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJEKT = "quantus-test-projekt";

/* Eine Umgebung aus Namen und Attrappenwerten — nie ein echtes Zugangsdatum. */
function umgebung(over = {}) {
  const werte = {
    QUANTUS_V3_FIREBASE_PROJECT_ID: PROJEKT,
    FIREBASE_PROJECT_ID: PROJEKT,
    ...over,
  };
  return (name) => (werte[name] === null ? undefined : werte[name]);
}

/* Ein firebase-admin-Ersatz: NUR die Auflösung, die das echte Modul auch
   exportiert. Kein privater Schlüssel, keine Signatur. */
function firebaseMitRefresh({ wirft = false } = {}) {
  return {
    userRefreshTokenFromEnv() {
      if (wirft) throw new Error("halbe OAuth-Konfiguration");
      return { refreshToken: "attrappe-refresh", clientId: "attrappe-id", clientSecret: "attrappe-secret", source: "firebase" };
    },
  };
}

function tokenAntwort({ token = "attrappe-zugriffstoken", scope = IDENTITY_SCOPE, expiresIn = 3600, ok = true } = {}) {
  return {
    ok,
    status: ok ? 200 : 400,
    async json() { return ok ? { access_token: token, scope, expires_in: expiresIn } : { error: "invalid_grant" }; },
  };
}

test("Konfiguration: Projekt muss da sein und zu Firebase passen", () => {
  assert.equal(resolveIdentityAccessConfig(umgebung()).ok, true);

  const ohneProjekt = resolveIdentityAccessConfig(umgebung({ QUANTUS_V3_FIREBASE_PROJECT_ID: null }));
  assert.equal(ohneProjekt.ok, false);
  assert.equal(ohneProjekt.status, 503);
  assert.equal(ohneProjekt.reason, "identity_project_missing");

  const ohneFirebase = resolveIdentityAccessConfig(umgebung({ FIREBASE_PROJECT_ID: null }));
  assert.equal(ohneFirebase.reason, "firebase_project_unknown");

  // Der gefährlichste Fall: im FALSCHEN Verzeichnis nachsehen hiesse, jeden
  // für ungesperrt zu halten.
  const schief = resolveIdentityAccessConfig(umgebung({ FIREBASE_PROJECT_ID: "ein-anderes-projekt" }));
  assert.equal(schief.ok, false);
  assert.equal(schief.reason, "identity_project_mismatch");

  // Aus dem Dienstkonto-JSON wird AUSSCHLIESSLICH project_id gelesen.
  const ausJson = umgebung({
    FIREBASE_PROJECT_ID: null,
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: PROJEKT, client_email: "a@b.c", private_key: "-----BEGIN PRIVATE KEY-----attrappe" }),
  });
  assert.equal(firebaseProjectIdFrom(ausJson), PROJEKT);
  assert.equal(resolveIdentityAccessConfig(ausJson).ok, true);
  assert.equal(firebaseProjectIdFrom(umgebung({ FIREBASE_PROJECT_ID: null, FIREBASE_SERVICE_ACCOUNT_JSON: "{kein json" })), null);
});

test("ohne Weg gibt es keinen Provider — und damit keine Anmeldung", () => {
  // Kein injizierter Port, kein Export, kein Refresh-Token: nichts.
  const zustand = identityAccessAvailability({ read: umgebung(), firebaseModule: {} });
  assert.equal(zustand.available, false);
  assert.equal(zustand.reason, "identity_access_not_configured");
  assert.equal(createAccessTokenProvider({ read: umgebung(), firebaseModule: {} }), null);

  // Auch bei schiefer Projektbindung: kein Provider.
  assert.equal(createAccessTokenProvider({
    read: umgebung({ FIREBASE_PROJECT_ID: "anderes" }), firebaseModule: firebaseMitRefresh(),
  }), null);

  // Eine halbe OAuth-Konfiguration (firebase-admin wirft) ist keine.
  const halb = identityAccessAvailability({ read: umgebung(), firebaseModule: firebaseMitRefresh({ wirft: true }) });
  assert.equal(halb.available, false);
});

test("die Reihenfolge der Wege ist fest: injiziert, Export, Refresh-Tausch", async () => {
  const spur = [];
  const injiziert = createAccessTokenProvider({
    read: umgebung(),
    firebaseModule: { ...firebaseMitRefresh(), [FIREBASE_TOKEN_EXPORT]: async () => { spur.push("export"); return "x"; } },
    obtainAccessToken: async ({ scope, projectId }) => {
      spur.push(`injiziert:${scope}:${projectId}`);
      return { token: "token-injiziert", scope: IDENTITY_SCOPE, expiresAt: Date.now() + 600_000 };
    },
    fetchImpl: async () => { spur.push("netz"); return tokenAntwort(); },
  });
  assert.equal(injiziert.source, "injected");
  assert.equal(await injiziert(), "token-injiziert");
  assert.deepEqual(spur, [`injiziert:${IDENTITY_SCOPE}:${PROJEKT}`]);

  // Ohne Port, aber mit benanntem Export aus firebase-admin.
  const spur2 = [];
  const ausExport = createAccessTokenProvider({
    read: umgebung(),
    firebaseModule: {
      ...firebaseMitRefresh(),
      [FIREBASE_TOKEN_EXPORT]: async ({ scope }) => { spur2.push(`export:${scope}`); return { token: "token-export", scope: CLOUD_PLATFORM_SCOPE }; },
    },
    fetchImpl: async () => { spur2.push("netz"); return tokenAntwort(); },
  });
  assert.equal(ausExport.source, `firebase:${FIREBASE_TOKEN_EXPORT}`);
  assert.equal(await ausExport(), "token-export");
  assert.deepEqual(spur2, [`export:${IDENTITY_SCOPE}`]);

  // Nur Refresh-Token: der Tausch, mit ausdrücklich genanntem Scope.
  let gesehen = null;
  const ausTausch = createAccessTokenProvider({
    read: umgebung(),
    firebaseModule: firebaseMitRefresh(),
    fetchImpl: async (url, init) => {
      gesehen = { url, body: String(init.body) };
      return tokenAntwort({ token: "token-tausch" });
    },
  });
  assert.equal(ausTausch.source, "oauth_refresh_exchange");
  assert.equal(await ausTausch(), "token-tausch");
  assert.equal(gesehen.url, GOOGLE_TOKEN_URL);
  assert.match(gesehen.body, /grant_type=refresh_token/);
  assert.ok(gesehen.body.includes(encodeURIComponent(IDENTITY_SCOPE)), "der nötige Scope wurde nicht verlangt");
});

test("der Scope wird geprüft — ein zu enger Token ist keiner", async () => {
  const zuEng = createAccessTokenProvider({
    read: umgebung(), firebaseModule: firebaseMitRefresh(),
    fetchImpl: async () => tokenAntwort({ scope: "https://www.googleapis.com/auth/firebase.database" }),
  });
  await assert.rejects(() => zuEng(), (err) => err.code === "identity_scope_missing");

  // `cloud-platform` ist der übergeordnete Scope und genügt.
  const weit = createAccessTokenProvider({
    read: umgebung(), firebaseModule: firebaseMitRefresh(),
    fetchImpl: async () => tokenAntwort({ scope: `${CLOUD_PLATFORM_SCOPE} openid` }),
  });
  assert.equal(await weit(), "attrappe-zugriffstoken");

  // Fehlgeschlagener Tausch, unbrauchbare Antwort, Netzfehler: je ein Fehler.
  for (const antwort of [
    async () => tokenAntwort({ ok: false }),
    async () => ({ ok: true, async json() { return {}; } }),
    async () => { throw new Error("Netz weg"); },
  ]) {
    const p = createAccessTokenProvider({ read: umgebung(), firebaseModule: firebaseMitRefresh(), fetchImpl: antwort });
    await assert.rejects(() => p(), (err) => err.code === "identity_token_failed");
  }
});

test("Cache mit Marge, und parallele Anfragen holen EINMAL", async () => {
  let abrufe = 0;
  let jetzt = 1_700_000_000_000;
  const provider = createAccessTokenProvider({
    read: umgebung(), firebaseModule: firebaseMitRefresh(), now: () => jetzt,
    fetchImpl: async () => { abrufe++; return tokenAntwort({ token: `token-${abrufe}`, expiresIn: 600 }); },
  });

  assert.equal(await provider(), "token-1");
  assert.equal(await provider(), "token-1");
  assert.equal(abrufe, 1, "der Cache wurde nicht benutzt");

  // Knapp vor Ablauf, aber innerhalb der Marge: neu holen.
  jetzt += 600_000 - EXPIRY_MARGIN_MS + 1_000;
  assert.equal(await provider(), "token-2");
  assert.equal(abrufe, 2);

  // Parallel: ein Abruf für alle.
  jetzt += 600_000;
  let langsameAbrufe = 0;
  const parallel = createAccessTokenProvider({
    read: umgebung(), firebaseModule: firebaseMitRefresh(), now: () => jetzt,
    fetchImpl: async () => {
      langsameAbrufe++;
      await new Promise((r) => setTimeout(r, 5));
      return tokenAntwort({ token: "token-parallel" });
    },
  });
  const ergebnisse = await Promise.all([1, 2, 3, 4, 5].map(() => parallel()));
  assert.deepEqual(ergebnisse, Array(5).fill("token-parallel"));
  assert.equal(langsameAbrufe, 1, `paralleler Zugriff ergab ${langsameAbrufe} Abrufe`);

  // Ein Fehlschlag wird NICHT gecacht: der nächste Versuch darf es erneut.
  let versuche = 0;
  const nachFehler = createAccessTokenProvider({
    read: umgebung(), firebaseModule: firebaseMitRefresh(), now: () => jetzt,
    fetchImpl: async () => {
      versuche++;
      return versuche === 1 ? tokenAntwort({ ok: false }) : tokenAntwort({ token: "endlich" });
    },
  });
  await assert.rejects(() => nachFehler());
  assert.equal(await nachFehler(), "endlich");
});

test("kein Token in Fehlern, kein Log, keine zweite Credentiallogik", async () => {
  const geheim = "ACCESS-TOKEN-NUR-IM-TEST";
  const provider = createAccessTokenProvider({
    read: umgebung(), firebaseModule: firebaseMitRefresh(),
    fetchImpl: async () => tokenAntwort({ token: geheim, scope: "zu-eng" }),
  });
  try {
    await provider();
    assert.fail("ein Token mit zu engem Scope wurde geliefert");
  } catch (err) {
    const text = `${err.message} ${err.code} ${JSON.stringify(err)}`;
    assert.ok(!text.includes(geheim), "der Token steht im Fehler");
  }

  const quelle = fs.readFileSync(path.join(root, "netlify/lib/quantus-v3-identity-access.mjs"), "utf8");
  const code = quelle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/console\.(log|warn|error|info|debug)/.test(code), "das Modul schreibt ins Log");

  // Keine eigene Dienstkonto-Signatur, kein privater Schlüssel, kein
  // Client-API-Key: die Zugangsauflösung bleibt in firebase-admin.
  for (const v of ["createSign", "private_key", "jwt-bearer", "assertion", "?key=", "apiKey"]) {
    assert.ok(!code.includes(v), `das Modul enthält ${v}`);
  }
  // Und es importiert nichts ausser dem eigenen Paket.
  for (const [, spec] of code.matchAll(/from\s+"([^"]+)"/g)) {
    assert.ok(spec.startsWith("./quantus-v3-"), `unerwarteter Import ${spec}`);
  }
  assert.ok(code.includes(IDENTITY_ACCESS_VARS.projectId));
});
