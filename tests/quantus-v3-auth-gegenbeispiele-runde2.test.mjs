/*
 * v3 C1 — die Gegenbeispiele der ZWEITEN unabhängigen Prüfung (zu 9ff3423).
 *
 * Wie in Runde eins: jeder Block ist ein Fall, der vorher DURCHKAM, mit der
 * gemeldeten Nummer. Die Fälle aus Runde eins bleiben unverändert in
 * tests/quantus-v3-auth-gegenbeispiele.test.mjs stehen.
 *
 * Gemeinsamer Nenner dieser fünf: eine Prüfung, die nicht zu Ende kam oder
 * einen Wert umgeformt statt geprüft hat, gab „in Ordnung" zurück. Ein
 * Netzfehler, ein NaN, eine 0, eine zu tiefe Struktur — jedes Mal entstand aus
 * „weiss nicht" ein „ja". Die Korrektur ist überall dieselbe Richtung: nicht
 * geprüft heisst nicht bestätigt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuthConfig, verifyFirebaseIdToken, createGooglePublicKeySource,
  createIdentityToolkitUserLookup, assertNoProviderSecrets,
  GOOGLE_SECURETOKEN_X509_URL, ISSUERS,
} from "../netlify/lib/quantus-v3-auth.mjs";
import {
  resolveCursorConfig, signCursor, verifyCursor, isDataRevision,
} from "../netlify/lib/quantus-v3-cursor.mjs";
import {
  makeEnv, makeSigningKey, makeIdToken, keySourceFor,
  TENANT, POLICY_VERSION,
} from "./fixtures/quantus-v3-auth-fixtures.mjs";

const key = makeSigningKey("runde2-kid");
const env = makeEnv();                                  // ohne Mandant
const { config } = resolveAuthConfig(env.read);
const { config: cursorConfig } = resolveCursorConfig(env.read);
const { config: authConfig } = resolveAuthConfig(makeEnv({ tenant: TENANT }).read);
const JETZT = Date.parse("2026-09-20T09:00:00Z");
const NOW_SEC = Math.floor(JETZT / 1000);
const now = () => JETZT;

/* ══ (1) Ausfall und abgelaufener Cache umgingen die Abkühlzeit ══════════
 *
 * Gemeldet: feste Uhr, `fetchImpl` wirft einen Netzfehler, fünf sequenzielle
 * `get("made-up-kid")` in derselben Minute ⇒ FÜNF Abrufe. Der Zweig
 * „kein/abgelaufener Cache" lief an der Abkühlzeit vorbei.
 * ------------------------------------------------------------------------ */
test("(1) ein Netzausfall kostet höchstens einen Abruf je Abkühlzeit", async () => {
  let aufrufe = 0;
  const fetchImpl = async () => { aufrufe++; throw new Error("Netz weg"); };
  const quelle = createGooglePublicKeySource({ fetchImpl, now, refreshCooldownMs: 60_000 });

  const ergebnisse = [];
  for (let i = 0; i < 5; i++) {
    try { ergebnisse.push(await quelle.get("made-up-kid")); }
    catch { ergebnisse.push("fehler"); }
  }
  assert.equal(aufrufe, 1, `fünf Aufrufe bei Netzausfall ergaben ${aufrufe} Abrufe`);
  // Und NICHTS davon ist ein Schlüssel.
  assert.ok(ergebnisse.every((e) => e === null || e === "fehler"), "ein Ausfall lieferte Schlüsselmaterial");
});

test("(1b) ein abgelaufener Cache wird nicht weiterbenutzt", async () => {
  let jetzt = JETZT;
  let aufrufe = 0;
  let antwort = { [key.kid]: key.publicPem };
  let kaputt = false;
  const fetchImpl = async () => {
    aufrufe++;
    if (kaputt) throw new Error("Netz weg");
    const body = antwort;
    return {
      ok: true,
      headers: { get: (n) => (n.toLowerCase() === "cache-control" ? "public, max-age=300" : null) },
      json: async () => body,
    };
  };
  const quelle = createGooglePublicKeySource({ fetchImpl, now: () => jetzt, refreshCooldownMs: 60_000 });

  assert.ok(await quelle.get(key.kid));
  assert.equal(aufrufe, 1);

  // max-age vorbei, Endpunkt ausgefallen: der alte Schlüssel gilt NICHT mehr.
  jetzt += 301_000;
  kaputt = true;
  await assert.rejects(() => quelle.get(key.kid), /Netz weg/);
  assert.equal(aufrufe, 2);

  // Weitere Versuche in derselben Minute kosten kein Netz — und liefern nichts.
  for (let i = 0; i < 4; i++) assert.equal(await quelle.get(key.kid), null);
  assert.equal(aufrufe, 2, `der Ausfall wurde ${aufrufe - 1}-mal wiederholt`);

  // Nach der Abkühlzeit genau ein neuer Versuch — und dann wieder gültig.
  jetzt += 61_000;
  kaputt = false;
  assert.ok(await quelle.get(key.kid));
  assert.equal(aufrufe, 3);
});

test("(1c) parallele Aufrufe im Ausfall teilen sich einen Abruf", async () => {
  let aufrufe = 0;
  const fetchImpl = async () => {
    aufrufe++;
    await new Promise((r) => setTimeout(r, 5));
    throw new Error("Netz weg");
  };
  const quelle = createGooglePublicKeySource({ fetchImpl, now, refreshCooldownMs: 60_000 });
  const ergebnisse = await Promise.allSettled([1, 2, 3, 4, 5].map(() => quelle.get("kid-x")));
  assert.equal(aufrufe, 1, `paralleler Ausfall ergab ${aufrufe} Abrufe`);
  assert.ok(ergebnisse.every((e) => e.status === "rejected" || e.value === null));
});

/* ══ (2) NaN in validSince wurde zu 0 umgedeutet ══════════════════════════
 *
 * Gemeldet: echtes, korrekt signiertes Token; `userLookup` liefert
 * `{disabled:false, validSince:NaN, tenantId:null}` ⇒ akzeptiert, weil
 * `Number(record.validSince || 0)` aus NaN eine 0 machte. Genau das kann die
 * echte Lookup-Funktion aus einer beschädigten Antwort erzeugen.
 * ------------------------------------------------------------------------ */
test("(2) ein unbrauchbarer Widerrufswert lässt niemanden ein", async () => {
  const token = makeIdToken({ key, now: JETZT, sub: "uid-laurin" });
  const pruefe = (record) => verifyFirebaseIdToken(token, {
    config, keySource: keySourceFor(key), userLookup: async () => record, now,
  });

  for (const validSince of [NaN, -1, 1.5, Infinity, -Infinity, "1758276000", "", {}, [], true, 1e300]) {
    const res = await pruefe({ disabled: false, validSince, tenantId: null });
    assert.equal(res.ok, false, `validSince=${String(validSince)} wurde akzeptiert`);
    assert.equal(res.status, 401);
    assert.equal(res.reason, "user_lookup_invalid");
  }

  // Grundfall: 0 heisst „nie widerrufen" und ist gültig.
  assert.equal((await pruefe({ disabled: false, validSince: 0, tenantId: null })).ok, true);
  // Fehlend ebenfalls.
  assert.equal((await pruefe({ disabled: false, tenantId: null })).ok, true);
  // Und ein echter Widerruf greift weiterhin.
  assert.equal((await pruefe({ disabled: false, validSince: NOW_SEC, tenantId: null })).reason, "token_revoked");

  // `disabled` muss ein echtes false sein — „false" als Zeichenkette sperrt.
  const alsText = await pruefe({ disabled: "false", validSince: 0, tenantId: null });
  assert.equal(alsText.status, 403);
  assert.equal(alsText.reason, "user_disabled");
});

test("(2b) schon die Lookup-Funktion erzeugt kein NaN", async () => {
  const antworten = new Map([
    ["kaputt", { users: [{ localId: "u1", disabled: false, validSince: "keine-zahl" }] }],
    ["leer", { users: [{ localId: "u1", disabled: false, validSince: "" }] }],
    ["gut", { users: [{ localId: "u1", disabled: false, validSince: "1758276000" }] }],
    ["ohne", { users: [{ localId: "u1", disabled: false }] }],
  ]);
  const bauen = (fall) => createIdentityToolkitUserLookup({
    getAccessToken: async () => "zugriffstoken-attrappe",
    projectId: "projekt",
    fetchImpl: async () => ({ ok: true, json: async () => antworten.get(fall) }),
  });

  await assert.rejects(() => bauen("kaputt")("u1"), /user_lookup_invalid/);
  await assert.rejects(() => bauen("leer")("u1"), /user_lookup_invalid/);
  assert.equal((await bauen("gut")("u1")).validSince, 1758276000);
  assert.equal((await bauen("ohne")("u1")).validSince, 0);
});

/* ══ (3)+(4) Die Datenrevision wurde umgeformt statt geprüft ══════════════
 *
 * Gemeldet: `dataRevision: 0` — der gültige frische Kernstand — wurde mit
 * `data_revision_missing` abgelehnt, während -1, 1.5, {} und
 * "not-a-revision" durch die Zeichenkettenumwandlung durchkamen.
 * ------------------------------------------------------------------------ */
const nutzer = { kind: "user", issuedBy: ISSUERS.firebase, id: "uid-laurin", role: "user", tenant: TENANT };
const lead = { kind: "lead", id: "lead_1", tenant: TENANT, ownerId: nutzer.id, entityVersion: 3 };

async function cursorMit(revision) {
  return signCursor({
    config: cursorConfig, principal: nutzer, query: "lead.context", scopeId: "lead_1",
    dataRevision: revision, policyVersion: POLICY_VERSION, now,
  });
}

test("(3) Revision 0 ist gültig — ausstellen und prüfen", async () => {
  const ausgestellt = await cursorMit(0);
  assert.equal(ausgestellt.ok, true, `Revision 0 abgelehnt: ${ausgestellt.reason}`);

  const geprueft = await verifyCursor(ausgestellt.cursor, {
    config: cursorConfig, authConfig, principal: nutzer,
    expectedQuery: "lead.context", expectedScopeKind: "lead", expectedScopeId: "lead_1",
    policyVersion: POLICY_VERSION, dataRevision: 0, scopeObject: lead, now,
  });
  assert.equal(geprueft.ok, true, `Revision 0 beim Prüfen abgelehnt: ${geprueft.reason}`);
  assert.equal(geprueft.page.scopeId, "lead_1");

  // Und ein Wechsel von 0 auf 1 entwertet den Cursor weiterhin.
  const gewechselt = await verifyCursor(ausgestellt.cursor, {
    config: cursorConfig, authConfig, principal: nutzer,
    expectedQuery: "lead.context", expectedScopeKind: "lead", expectedScopeId: "lead_1",
    policyVersion: POLICY_VERSION, dataRevision: 1, scopeObject: lead, now,
  });
  assert.equal(gewechselt.reason, "cursor_revision_changed");
});

test("(4) alles, was keine Revision ist, wird abgelehnt — beim Ausstellen wie beim Prüfen", async () => {
  for (const murks of [-1, 1.5, {}, [], "not-a-revision", "0", "41", NaN, Infinity, null, undefined, true, Number.MAX_VALUE]) {
    const res = await cursorMit(murks);
    assert.equal(res.ok, false, `dataRevision=${JSON.stringify(murks)} wurde ausgestellt`);
    assert.equal(res.reason, "data_revision_invalid");
  }

  const gueltig = await cursorMit(41);
  for (const murks of [-1, 1.5, "41", {}, NaN, null, undefined]) {
    const res = await verifyCursor(gueltig.cursor, {
      config: cursorConfig, authConfig, principal: nutzer,
      expectedQuery: "lead.context", expectedScopeKind: "lead", expectedScopeId: "lead_1",
      policyVersion: POLICY_VERSION, dataRevision: murks, scopeObject: lead, now,
    });
    assert.equal(res.ok, false, `dataRevision=${JSON.stringify(murks)} wurde beim Prüfen akzeptiert`);
    assert.equal(res.reason, "data_revision_invalid");
  }

  // Der Vertrag selbst, an einer Stelle nachlesbar.
  for (const gut of [0, 1, 41, Number.MAX_SAFE_INTEGER]) assert.equal(isDataRevision(gut), true, String(gut));
  for (const schlecht of [-1, 1.5, "0", NaN, Infinity, null, undefined, {}, Number.MAX_VALUE]) {
    assert.equal(isDataRevision(schlecht), false, JSON.stringify(schlecht));
  }

  // Im Cursor steht die Revision als ZAHL, nicht als Zeichenkette.
  const koerper = JSON.parse(Buffer.from(gueltig.cursor.split(".")[1], "base64url").toString("utf8"));
  assert.equal(typeof koerper.dataRevision, "number");
  assert.equal(koerper.dataRevision, 41);
});

/* ══ (5) Die Geheimnissuche bestätigte, was sie nie angesehen hatte ═══════
 *
 * Gemeldet: achtmal `{nested: …}` um `{apiKey:"…"}` ⇒ `ok: true`. Beim
 * Erreichen der Tiefengrenze gab die Suche „sauber" zurück.
 * ------------------------------------------------------------------------ */
function verschachteln(tiefe, kern) {
  let wert = kern;
  for (let i = 0; i < tiefe; i++) wert = { nested: wert };
  return wert;
}

test("(5) was die Suche nicht zu Ende geprüft hat, gilt nicht als sauber", () => {
  const kern = { apiKey: "synthetic-secret-never-real" };

  // Der gemeldete Fall: acht Ebenen, kleines Tiefenbudget.
  const gemeldet = assertNoProviderSecrets(verschachteln(8, kern), { depth: 6 });
  assert.equal(gemeldet.ok, false, "eine abgebrochene Suche meldete „sauber“");
  assert.equal(gemeldet.status, 400);
  assert.match(gemeldet.reason, /^provider_secret_scan_incomplete:depth$/);

  // Tief genug: der Schlüssel wird tatsächlich gefunden.
  const gefunden = assertNoProviderSecrets(verschachteln(8, kern));
  assert.equal(gefunden.ok, false);
  assert.equal(gefunden.reason, "provider_secret_in_context:key");

  // Sehr tief: wieder „nicht prüfbar", nicht „sauber".
  const sehrTief = assertNoProviderSecrets(verschachteln(40, kern));
  assert.equal(sehrTief.ok, false);
  assert.match(sehrTief.reason, /scan_incomplete/);

  // Auch durch Listen hindurch.
  const inListe = assertNoProviderSecrets([[[[[[[[kern]]]]]]]], { depth: 4 });
  assert.equal(inListe.ok, false);
  assert.match(inListe.reason, /scan_incomplete/);

  // Kein einziger Fehler nennt den Wert.
  for (const res of [gemeldet, gefunden, sehrTief, inListe]) {
    assert.ok(!JSON.stringify(res).includes("synthetic-secret-never-real"),
      "der gefundene Wert steht im Fehler");
  }
});

test("(5b) Zyklen, Getter, Symbole, Knotenbudget: fail closed", () => {
  const zyklus = { a: 1 };
  zyklus.self = zyklus;
  assert.match(assertNoProviderSecrets(zyklus).reason, /scan_incomplete:cycle/);

  // Ein Getter wird NICHT aufgerufen — und deshalb ist das Objekt nicht prüfbar.
  let aufgerufen = 0;
  const mitGetter = {};
  Object.defineProperty(mitGetter, "harmlos", {
    enumerable: true,
    get() { aufgerufen++; return "sk-ant-verborgen-0000"; },
  });
  assert.match(assertNoProviderSecrets(mitGetter).reason, /scan_incomplete:accessor/);
  assert.equal(aufgerufen, 0, "ein Getter wurde aufgerufen");

  const mitSymbol = { a: 1, [Symbol("s")]: { apiKey: "x" } };
  assert.match(assertNoProviderSecrets(mitSymbol).reason, /scan_incomplete:symbol/);

  const breit = {};
  for (let i = 0; i < 100; i++) breit[`f${i}`] = i;
  assert.match(assertNoProviderSecrets(breit, { maxNodes: 10 }).reason, /scan_incomplete:nodes/);

  // Fremde Objektarten (Map, Set, Date, Funktionen) sind nicht durchsuchbar.
  for (const exotisch of [{ m: new Map([["apiKey", "x"]]) }, { s: new Set(["x"]) }, { f: () => "sk-ant-x" }]) {
    assert.match(assertNoProviderSecrets(exotisch).reason, /scan_incomplete/);
  }

  // Und der Normalfall bleibt ein Ja.
  assert.equal(assertNoProviderSecrets({
    jobId: "job_1", frage: "Was ist heute fällig?",
    eintraege: [{ id: "t1", titel: "Steuern" }, { id: "t2", titel: "Mail" }],
    zahlen: [1, 2, 3], datum: "2026-09-20",
  }).ok, true);
});
