/*
 * v3 C3b — die acht Gegenproben aus dem Review von a422670.
 *
 * Jeder Test hier ist zuerst FEHLGESCHLAGEN. Er steht als Fall, nicht als
 * Behauptung: die Kennung in der Überschrift ist der Befund, der Körper ist
 * die Schranke, die ihn jetzt abfängt.
 *
 *   G-1..3  Die Ablaufmarge galt nur dem alten Cache, nicht der frischen
 *           Antwort: expiresAt = now-1 / now / now+59999 (Marge 60 s) ergaben
 *           trotzdem ein Token.
 *   G-4     Ein Erwerb, der 121 s dauert, lieferte ein Token, das bis
 *           Start+120 s gültig war — geprüft wurde mit der Zeit vom Start.
 *   G-5     `expires_in: -60` wurde still zu einer Stunde.
 *   G-6     Zwei echte `buildRuntimeDeps` für dieselbe Konfiguration holten
 *           zwei Token: der Cache lag im Provider-Abschluss, die Handler
 *           bauen ihre Abhängigkeiten aber pro Request.
 *   G-7/8   Ein Port, der einen Fehler mit Zugangsdatum in `message`/`body`
 *           wirft, wurde unverändert weitergereicht (samt `cause`).
 *
 * Alles synthetisch: keine echten Token, keine Berechtigungen, keine
 * OAuth-Zustimmung, kein Netz.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccessTokenProvider, resetIdentityAccessCacheForTests, invalidateIdentityAccessCache,
  identityAccessCacheStats, IDENTITY_SCOPE, EXPIRY_MARGIN_MS, MAX_CACHE_ENTRIES,
  IDENTITY_ACCESS_ERRORS, FIREBASE_TOKEN_EXPORT,
} from "../netlify/lib/quantus-v3-identity-access.mjs";
import {
  buildRuntimeDeps, resetRuntimeCachesForTests, buildDomainAdapter, DOMAIN_FACTORY_REASONS,
} from "../netlify/lib/quantus-v3-runtime.mjs";

const PROJEKT = "quantus-test-projekt";
const MANDANT = "quantus-haushalt";
const T = 1_700_000_000_000;
const SYNTH = "SYNTHETIC-SECRET-NUR-IM-TEST";

/* Eine projektgleiche Konfiguration — Namen echt, Werte Attrappen. */
function projektgleich(over = {}) {
  const werte = {
    QUANTUS_V3_FIREBASE_PROJECT_ID: PROJEKT,
    QUANTUS_V3_FIREBASE_TENANT: MANDANT,
    FIREBASE_PROJECT_ID: PROJEKT,
    ...over,
  };
  return (name) => (werte[name] == null ? undefined : werte[name]);
}

function firebaseMitRefresh({ clientSecret = "attrappe-secret" } = {}) {
  return {
    userRefreshTokenFromEnv() {
      return { refreshToken: "attrappe-refresh", clientId: "attrappe-id", clientSecret, source: "firebase" };
    },
  };
}

function tokenAntwort(daten) {
  return { ok: true, status: 200, async json() { return daten; } };
}

/* ══ G-1..3: die Marge gilt für JEDES Token ═══════════════════════════════ */
test("G-1..3: ein Token, das (fast) abgelaufen ist, wird abgelehnt — nicht geliefert", async () => {
  resetIdentityAccessCacheForTests();
  const grenzfaelle = [
    ["schon abgelaufen", T - 1],
    ["genau jetzt", T],
    ["eine Millisekunde innerhalb der Marge", T + EXPIRY_MARGIN_MS - 1],
  ];
  for (const [name, expiresAt] of grenzfaelle) {
    resetIdentityAccessCacheForTests();
    const p = createAccessTokenProvider({
      read: projektgleich(), firebaseModule: {}, now: () => T,
      obtainAccessToken: async () => ({ token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt }),
    });
    assert.equal(typeof p, "function", name);
    await assert.rejects(() => p(), (err) => err.code === "identity_token_expired", name);
    // Und nichts davon bleibt liegen.
    assert.equal(identityAccessCacheStats(() => T).usable, 0, name);
  }

  // Genau EINE Millisekunde jenseits der Marge: gültig. Die Schranke ist eine
  // Grenze, keine Pauschalablehnung.
  resetIdentityAccessCacheForTests();
  const knappGut = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => T,
    obtainAccessToken: async () => ({ token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt: T + EXPIRY_MARGIN_MS + 1 }),
  });
  assert.equal(await knappGut(), "SYNTHETIC");
});

/* ══ G-4: frische Zeit NACH dem Erwerb ═══════════════════════════════════ */
test("G-4: ein langsamer Erwerb wird mit der Zeit DANACH geprüft", async () => {
  resetIdentityAccessCacheForTests();
  let jetzt = T;
  const langsam = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => jetzt,
    obtainAccessToken: async () => {
      jetzt = T + 121_000;                       // der Erwerb dauerte 121 s
      return { token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt: T + 120_000 };
    },
  });
  await assert.rejects(() => langsam(), (err) => err.code === "identity_token_expired");

  // Derselbe langsame Erwerb mit einer Frist, die auch DANACH noch reicht:
  // gültig. Nicht die Dauer ist das Problem, sondern die Frist.
  resetIdentityAccessCacheForTests();
  jetzt = T;
  const langsamAberGut = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => jetzt,
    obtainAccessToken: async () => {
      jetzt = T + 121_000;
      return { token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt: T + 900_000 };
    },
  });
  assert.equal(await langsamAberGut(), "SYNTHETIC");
});

/* ══ G-5: keine erfundene Laufzeit ═══════════════════════════════════════ */
test("G-5: eine ungültige oder fehlende Lebensdauer wird nie zu einer Stunde", async () => {
  const unbrauchbar = [
    ["negativ", { access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: -60 }],
    ["null Sekunden", { access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: 0 }],
    ["fehlt", { access_token: "SYNTHETIC", scope: IDENTITY_SCOPE }],
    ["keine Zahl", { access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: "bald" }],
    ["nicht endlich", { access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: Infinity }],
    ["NaN", { access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: Number.NaN }],
  ];
  for (const [name, daten] of unbrauchbar) {
    resetIdentityAccessCacheForTests();
    const p = createAccessTokenProvider({
      read: projektgleich(), firebaseModule: firebaseMitRefresh(), now: () => T,
      fetchImpl: async () => tokenAntwort(daten),
    });
    await assert.rejects(() => p(), (err) => err.code === "identity_token_lifetime_invalid", name);
  }

  // Auch ein hereingegebener Port muss seine Frist NENNEN: eine nackte
  // Zeichenkette ist keine Zusicherung.
  for (const [name, antwort] of [
    ["nackte Zeichenkette", "SYNTHETIC"],
    ["ohne expiresAt", { token: "SYNTHETIC", scope: IDENTITY_SCOPE }],
    ["expiresAt nicht endlich", { token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt: Infinity }],
    ["expiresAt keine Zahl", { token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt: "morgen" }],
  ]) {
    resetIdentityAccessCacheForTests();
    const p = createAccessTokenProvider({
      read: projektgleich(), firebaseModule: {}, now: () => T,
      obtainAccessToken: async () => antwort,
    });
    await assert.rejects(() => p(), (err) => err.code === "identity_token_lifetime_invalid", name);
  }

  // Eine echte Frist wird übernommen, nicht überschrieben.
  resetIdentityAccessCacheForTests();
  const gut = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: firebaseMitRefresh(), now: () => T,
    fetchImpl: async () => tokenAntwort({ access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: 3600 }),
  });
  assert.equal(await gut(), "SYNTHETIC");
});

/* ══ G-6: Cache und Bündelung wirken über Requests ═══════════════════════ */
function lookupVerkehr() {
  const spur = { token: 0, lookups: 0 };
  const fetchImpl = async (url, init = {}) => {
    const adresse = String(url);
    if (adresse.startsWith("https://oauth2.googleapis.com/token")) {
      spur.token++;
      await new Promise((r) => setTimeout(r, 5));   // ein Abruf braucht Zeit
      return tokenAntwort({ access_token: "SYNTHETIC", scope: IDENTITY_SCOPE, expires_in: 3600 });
    }
    if (adresse.includes("accounts:lookup")) {
      spur.lookups++;
      if (!String(init.headers?.Authorization || "").startsWith("Bearer ")) {
        return { ok: false, status: 401, async json() { return {}; } };
      }
      return { ok: true, status: 200, async json() { return { users: [{ localId: "uid-1", disabled: false, validSince: "0" }] }; } };
    }
    throw new Error(`unerwartet: ${adresse}`);
  };
  return { spur, fetchImpl };
}

test("G-6: zwei pro Request gebaute Deps teilen EINEN Tokenabruf", async () => {
  resetRuntimeCachesForTests();
  const { spur, fetchImpl } = lookupVerkehr();
  const gemeinsameOptionen = {
    write: false,
    read: projektgleich(),
    firebaseModule: firebaseMitRefresh(),
    fetchImpl,
    now: () => T,
  };

  // Genau wie im Betrieb: jede Anfrage baut ihre eigenen Abhängigkeiten.
  const [a, b] = await Promise.all([buildRuntimeDeps(gemeinsameOptionen), buildRuntimeDeps(gemeinsameOptionen)]);
  assert.equal(typeof a.userLookup, "function");
  assert.equal(typeof b.userLookup, "function");
  assert.notEqual(a, b, "es wurden nicht zwei Deps gebaut");

  const [r1, r2] = await Promise.all([a.userLookup("uid-1"), b.userLookup("uid-1")]);
  assert.equal(r1.disabled, false);
  assert.equal(r2.disabled, false);
  assert.equal(spur.token, 1, `es gab ${spur.token} Tokenabrufe statt einem`);
  // Der WIDERRUFSLOOKUP selbst wird NIE gecacht — er ist die Prüfung.
  assert.equal(spur.lookups, 2, "der Widerrufslookup wurde gecacht");

  // Eine dritte, spätere Anfrage nimmt denselben Token — und prüft erneut.
  const c = await buildRuntimeDeps(gemeinsameOptionen);
  await c.userLookup("uid-1");
  assert.equal(spur.token, 1);
  assert.equal(spur.lookups, 3);
});

test("G-6: der Speicher ist gebunden, begrenzt und ungültigmachbar", async () => {
  resetIdentityAccessCacheForTests();
  const bauen = ({ read = projektgleich(), firebase = firebaseMitRefresh(), fetchImpl }) =>
    createAccessTokenProvider({ read, firebaseModule: firebase, now: () => T, fetchImpl });

  let abrufe = 0;
  const verkehr = async () => { abrufe++; return tokenAntwort({ access_token: `SYNTH-${abrufe}`, scope: IDENTITY_SCOPE, expires_in: 3600 }); };

  // Gleiche Konfiguration, gleiche Quelle ⇒ ein Abruf.
  assert.equal(await bauen({ fetchImpl: verkehr })(), "SYNTH-1");
  assert.equal(await bauen({ fetchImpl: verkehr })(), "SYNTH-1");
  assert.equal(abrufe, 1);

  // ZUGANGSWECHSEL: anderer client_secret ⇒ anderer Schlüssel, neuer Abruf.
  assert.equal(await bauen({ firebase: firebaseMitRefresh({ clientSecret: "attrappe-neu" }), fetchImpl: verkehr })(), "SYNTH-2");

  // PROJEKTWECHSEL ⇒ ebenfalls ein eigener Schlüssel.
  const anderesProjekt = (name) => (name === "QUANTUS_V3_FIREBASE_PROJECT_ID" || name === "FIREBASE_PROJECT_ID"
    ? "zweites-projekt" : projektgleich()(name));
  assert.equal(await bauen({ read: anderesProjekt, fetchImpl: verkehr })(), "SYNTH-3");

  // MANDANTENWECHSEL ⇒ eigener Schlüssel.
  assert.equal(await bauen({ read: projektgleich({ QUANTUS_V3_FIREBASE_TENANT: "anderer-mandant" }), fetchImpl: verkehr })(), "SYNTH-4");

  // ANDERE TOKENQUELLE (injizierter Port) ⇒ eigener Schlüssel.
  const ausPort = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: firebaseMitRefresh(), now: () => T,
    obtainAccessToken: async () => ({ token: "SYNTH-PORT", scope: IDENTITY_SCOPE, expiresAt: T + 3_600_000 }),
  });
  assert.equal(await ausPort(), "SYNTH-PORT");

  // BEGRENZT: viele verschiedene Quellen sprengen den Speicher nicht.
  for (let i = 0; i < MAX_CACHE_ENTRIES * 3; i++) {
    const p = createAccessTokenProvider({
      read: projektgleich(), firebaseModule: firebaseMitRefresh(), now: () => T,
      obtainAccessToken: async () => ({ token: `SYNTH-${i}`, scope: IDENTITY_SCOPE, expiresAt: T + 3_600_000 }),
    });
    await p();
  }
  const stand = identityAccessCacheStats(() => T);
  assert.ok(stand.entries <= MAX_CACHE_ENTRIES, `der Speicher hält ${stand.entries} Einträge`);

  // UNGÜLTIGMACHBAR: nach dem Verwerfen wird neu geholt.
  invalidateIdentityAccessCache();
  assert.equal(identityAccessCacheStats(() => T).entries, 0);
  const vorher = abrufe;
  await bauen({ fetchImpl: verkehr })();
  assert.equal(abrufe, vorher + 1, "nach dem Verwerfen wurde der alte Token weiterbenutzt");
});

/* ══ G-7/8: die Modulgrenze ══════════════════════════════════════════════ */
test("G-7/8: ein werfender Port verlässt das Modul nur als feste Kennung", async () => {
  const werfen = () => {
    const err = new Error(`Zugriff verweigert: refresh_token=${SYNTH}`);
    err.body = { error: "invalid_grant", access_token: SYNTH };
    err.cause = new Error(`client_secret=${SYNTH}`);
    err.response = { headers: { authorization: `Bearer ${SYNTH}` } };
    return err;
  };

  const faelle = [
    ["injizierter Port", { obtainAccessToken: async () => { throw werfen(); } }],
    ["injizierter Port, synchron", { obtainAccessToken: () => { throw werfen(); } }],
    [`firebase:${FIREBASE_TOKEN_EXPORT}`, {
      firebaseModule: { ...firebaseMitRefresh(), [FIREBASE_TOKEN_EXPORT]: async () => { throw werfen(); } },
    }],
    ["Refresh-Tausch (Verkehr wirft)", { firebaseModule: firebaseMitRefresh(), fetchImpl: async () => { throw werfen(); } }],
    ["Refresh-Tausch (Antwort trägt das Geheimnis)", {
      firebaseModule: firebaseMitRefresh(),
      fetchImpl: async () => ({
        ok: false, status: 400,
        async json() { return { error: "invalid_grant", error_description: `refresh_token=${SYNTH}` }; },
      }),
    }],
  ];

  for (const [name, optionen] of faelle) {
    resetIdentityAccessCacheForTests();
    const p = createAccessTokenProvider({
      read: projektgleich(), firebaseModule: firebaseMitRefresh(), now: () => T, ...optionen,
    });
    assert.equal(typeof p, "function", name);
    let gefangen = null;
    try {
      await p();
    } catch (err) {
      gefangen = err;
    }
    assert.ok(gefangen, `${name}: es wurde ein Token geliefert`);
    assert.ok(IDENTITY_ACCESS_ERRORS.includes(gefangen.code), `${name}: fremde Kennung ${gefangen.code}`);
    assert.equal(gefangen.message, gefangen.code, `${name}: fremde Nachricht`);
    assert.equal(gefangen.cause, undefined, `${name}: der Fehler trägt ein cause`);
    assert.equal(gefangen.body, undefined, `${name}: der Fehler trägt ein body`);
    assert.equal(gefangen.response, undefined, `${name}: der Fehler trägt eine Antwort`);
    assert.deepEqual(Object.getOwnPropertyNames(gefangen).filter((n) => n !== "stack" && n !== "message"), ["code"], name);

    // Nichts Synthetisches, nirgends — Nachricht, eigene Felder, Serialisierung.
    const alles = [gefangen.message, gefangen.code, JSON.stringify(gefangen),
      ...Object.getOwnPropertyNames(gefangen).map((n) => String(gefangen[n]))].join(" ");
    assert.ok(!alles.includes(SYNTH), `${name}: das Geheimnis steht im Fehler`);
  }

  // Und ein Fehlschlag wird nicht gecacht: der nächste Versuch darf es erneut.
  resetIdentityAccessCacheForTests();
  let versuche = 0;
  const nachFehler = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => T,
    obtainAccessToken: async () => {
      versuche++;
      if (versuche === 1) throw werfen();
      return { token: "SYNTHETIC", scope: IDENTITY_SCOPE, expiresAt: T + 3_600_000 };
    },
  });
  await assert.rejects(() => nachFehler(), (err) => err.code === "identity_token_failed");
  assert.equal(await nachFehler(), "SYNTHETIC");
  assert.equal(versuche, 2);
});

/* ══ C3B-07 (Release-Review 4379061): die Grenze gilt auch unter Last ═════
 *
 * Befund: 16 gleichzeitige, verschiedene synthetische Quellen ergaben 16
 * Cache-Einträge bei MAX_CACHE_ENTRIES 8 — während des Abrufs und, weil
 * niemand nachträglich begrenzte, auch nach dem Abschluss. Die Verdrängung
 * übersprang jeden Eintrag mit laufendem Abruf.
 * ─────────────────────────────────────────────────────────────────────── */
test("C3B-07: sechzehn gleichzeitige Quellen sprengen die Grenze nicht", async () => {
  resetIdentityAccessCacheForTests();

  // Kein Versprechen darf unbehandelt liegenbleiben — auch keine Ablehnung.
  const verloren = [];
  const wache = (grund) => verloren.push(grund);
  process.on("unhandledRejection", wache);

  let oeffne;
  const gate = new Promise((r) => { oeffne = r; });
  const quellen = [];
  for (let i = 0; i < 16; i++) {
    // Jede Quelle ist eine EIGENE Funktion ⇒ eigener Cache-Schlüssel.
    quellen.push(createAccessTokenProvider({
      read: projektgleich(), firebaseModule: {}, now: () => T,
      obtainAccessToken: async () => {
        await gate;
        return { token: `SYNTH-${i}`, scope: IDENTITY_SCOPE, expiresAt: T + 3_600_000 };
      },
    }));
  }
  assert.equal(quellen.filter((p) => typeof p === "function").length, 16);

  const laeufe = quellen.map((p) => p().then(
    (token) => ({ ok: true, token }),
    (err) => ({ ok: false, code: err.code }),
  ));

  // WÄHREND alle warten: die Grenze hält — inklusive der laufenden Abrufe.
  const waehrend = identityAccessCacheStats(() => T);
  assert.ok(waehrend.entries <= MAX_CACHE_ENTRIES,
    `während des Abrufs lagen ${waehrend.entries} Einträge bei Grenze ${MAX_CACHE_ENTRIES}`);
  assert.equal(waehrend.inFlight, MAX_CACHE_ENTRIES);

  oeffne();
  const ergebnisse = await Promise.all(laeufe);

  // NACH dem Abschluss ebenfalls — und ohne nachträgliche Verdrängung.
  const nachher = identityAccessCacheStats(() => T);
  assert.ok(nachher.entries <= MAX_CACHE_ENTRIES,
    `nach dem Abschluss lagen ${nachher.entries} Einträge bei Grenze ${MAX_CACHE_ENTRIES}`);
  assert.equal(nachher.inFlight, 0);

  // Was keinen Platz bekam, wurde KONTROLLIERT abgelehnt — kein Token ohne
  // Platz, keine stille Überschreitung.
  const erfolge = ergebnisse.filter((r) => r.ok);
  const abgelehnt = ergebnisse.filter((r) => !r.ok);
  assert.equal(erfolge.length, MAX_CACHE_ENTRIES);
  assert.equal(abgelehnt.length, 16 - MAX_CACHE_ENTRIES);
  assert.ok(abgelehnt.every((r) => r.code === "identity_access_busy"), "fremde Kennung in der Ablehnung");
  assert.ok(IDENTITY_ACCESS_ERRORS.includes("identity_access_busy"));
  assert.equal(nachher.rejected, 16 - MAX_CACHE_ENTRIES);

  // Nach dem Abschluss ist wieder Platz: eine neue Quelle wird aufgenommen,
  // indem ein untätiger Eintrag verdrängt wird — und die Grenze hält.
  const neu = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => T,
    obtainAccessToken: async () => ({ token: "SYNTH-NEU", scope: IDENTITY_SCOPE, expiresAt: T + 3_600_000 }),
  });
  assert.equal(await neu(), "SYNTH-NEU");
  assert.ok(identityAccessCacheStats(() => T).entries <= MAX_CACHE_ENTRIES);

  process.off("unhandledRejection", wache);
  assert.deepEqual(verloren, [], "es blieb ein Versprechen unbehandelt");
});

test("C3B-07: die Bündelung DERSELBEN Quelle bleibt unberührt", async () => {
  resetIdentityAccessCacheForTests();
  let oeffne;
  const gate = new Promise((r) => { oeffne = r; });
  let erwerbe = 0;
  const eineQuelle = async () => {
    erwerbe++;
    await gate;
    return { token: "SYNTH-EINE", scope: IDENTITY_SCOPE, expiresAt: T + 3_600_000 };
  };
  const provider = createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => T, obtainAccessToken: eineQuelle,
  });

  // Sechzehn gleichzeitige Anfragen an dieselbe Quelle: ein Eintrag, ein
  // Erwerb, keine Ablehnung — die Grenze darf die Bündelung nicht bestrafen.
  const laeufe = Array.from({ length: 16 }, () => provider());
  const waehrend = identityAccessCacheStats(() => T);
  assert.equal(waehrend.entries, 1);
  assert.equal(waehrend.inFlight, 1);
  oeffne();
  const ergebnisse = await Promise.all(laeufe);
  assert.deepEqual(ergebnisse, Array(16).fill("SYNTH-EINE"));
  assert.equal(erwerbe, 1, `dieselbe Quelle wurde ${erwerbe}-mal erworben`);
  assert.equal(identityAccessCacheStats(() => T).rejected, 0, "die Bündelung wurde abgelehnt");

  // Auch viele Provider-Objekte über DERSELBEN Quellfunktion teilen den Platz.
  resetIdentityAccessCacheForTests();
  const viele = Array.from({ length: 16 }, () => createAccessTokenProvider({
    read: projektgleich(), firebaseModule: {}, now: () => T, obtainAccessToken: eineQuelle,
  }));
  const zweiteRunde = await Promise.all(viele.map((p) => p()));
  assert.deepEqual(zweiteRunde, Array(16).fill("SYNTH-EINE"));
  assert.equal(identityAccessCacheStats(() => T).entries, 1);
  assert.equal(identityAccessCacheStats(() => T).rejected, 0);
});

/* ══ Fachadapter-Gründe: nur die Liste, nie ein fremder Fehler ═══════════ */
test("der Grund eines Fachadapter-Ports kommt aus der Allowlist", () => {
  const politik = { policyVersion: "v", tenantId: null, mode: "enforce" };
  const geheim = "FREMDER-TEXT-MIT-SYNTHETIC-SECRET";

  const werfend = buildDomainAdapter({
    factory: () => {
      const err = new Error(geheim);
      err.code = geheim;
      err.reason = geheim;
      throw err;
    },
    policy: politik, now: () => T,
  });
  assert.equal(werfend.ok, false);
  assert.equal(werfend.reason, "domain_factory_failed");
  assert.ok(DOMAIN_FACTORY_REASONS.includes(werfend.reason));
  assert.ok(!JSON.stringify(werfend).includes("SYNTHETIC"), "fremder Text im Grund");

  // Auch eine Fabrik, die selbst einen „Grund" behauptet, bestimmt ihn nicht.
  const behauptet = buildDomainAdapter({
    factory: () => ({ reason: geheim, resolveTarget() {} }), policy: politik, now: () => T,
  });
  assert.equal(behauptet.reason, "domain_adapter_incomplete");

  for (const grund of DOMAIN_FACTORY_REASONS) {
    assert.match(grund, /^domain_(factory|adapter)_[a-z_]+$/);
  }
  assert.equal(DOMAIN_FACTORY_REASONS.length, 3);
});
