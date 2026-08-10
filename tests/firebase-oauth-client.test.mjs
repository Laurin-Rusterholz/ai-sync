/*
 * Firebase-Versand — welche OAuth-Zugangsdaten erneuern den Refresh-Token?
 * ---------------------------------------------------------------------------
 * Der Befund: FIREBASE_OAUTH_REFRESH_TOKEN konnte nur mit GOOGLE_CLIENT_ID und
 * GOOGLE_CLIENT_SECRET erneuert werden. Gehört der Refresh-Token zu einer
 * anderen OAuth-Anwendung als der Kalender-/Mail-Zugang, antwortet Google mit
 * „invalid_client" — und der ganze Firebase-Versand steht still.
 *
 * Bewiesen wird hier die Auswahl- und Fallback-Logik, nicht der Netzverkehr:
 *
 *   1. Beide Firebase-Variablen gesetzt → sie haben Vorrang.
 *   2. Beide fehlen → exakt der bisherige Google-Weg, samt alter Fehlermeldung.
 *   3. Genau eine gesetzt → Fehler, der die fehlende Variable benennt. Es wird
 *      NIE die client_id der einen mit dem client_secret der anderen Anwendung
 *      gemischt.
 *   4. Ohne Refresh-Token bleibt es beim Dienstkonto (null).
 *   5. Der Weg über die Umgebungsvariablen liefert dieselben Ergebnisse.
 *
 * In dieser Datei stehen ausschliesslich offensichtliche Platzhalter — keine
 * echten Zugangsdaten, weder hier noch sonst im Repository.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(root, "netlify/lib/firebase-admin.mjs");
const { resolveOAuthClient, userRefreshTokenFromEnv } = await import(modulePath);

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

/* Platzhalter — bewusst als solche erkennbar. */
const TOKEN = "platzhalter-refresh-token";
const FT_ID = "platzhalter-firebase-client-id";
const FT_SECRET = "platzhalter-firebase-client-secret";
const G_ID = "platzhalter-google-client-id";
const G_SECRET = "platzhalter-google-client-secret";

/* ── 1. Vorrang: das eigene Firebase-Paar gewinnt ─────────────────────────── */
{
  const picked = resolveOAuthClient({
    refreshToken: TOKEN,
    firebaseClientId: FT_ID, firebaseClientSecret: FT_SECRET,
    googleClientId: G_ID, googleClientSecret: G_SECRET,
  });
  ok(picked.source === "firebase", `das Firebase-Paar hat keinen Vorrang: ${picked.source}`);
  ok(picked.clientId === FT_ID, "es wird nicht die Firebase-client_id benutzt");
  ok(picked.clientSecret === FT_SECRET, "es wird nicht das Firebase-client_secret benutzt");
  ok(picked.refreshToken === TOKEN, "der Refresh-Token wurde verändert");

  // Auch ganz ohne Google-Variablen — das ist der eigentliche Zweck.
  const allein = resolveOAuthClient({
    refreshToken: TOKEN, firebaseClientId: FT_ID, firebaseClientSecret: FT_SECRET,
  });
  ok(allein.source === "firebase" && allein.clientId === FT_ID,
    "ohne GOOGLE_CLIENT_ID/SECRET funktioniert das eigene Firebase-Paar nicht");
}

/* ── 2. Fallback: ohne Firebase-Paar bleibt alles wie bisher ──────────────── */
{
  const picked = resolveOAuthClient({
    refreshToken: TOKEN, googleClientId: G_ID, googleClientSecret: G_SECRET,
  });
  ok(picked.source === "google", `der Google-Fallback greift nicht: ${picked.source}`);
  ok(picked.clientId === G_ID && picked.clientSecret === G_SECRET,
    "der Google-Fallback benutzt andere Zugangsdaten als bisher");

  // Die bisherige Fehlermeldung bleibt wortgleich — sie steht in Anleitungen.
  assert.throws(
    () => resolveOAuthClient({ refreshToken: TOKEN }),
    /FIREBASE_OAUTH_REFRESH_TOKEN benötigt GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET\./,
    "ohne jede Client-Angabe kommt nicht mehr die bisherige Fehlermeldung"
  );
  checks++;
  assert.throws(
    () => resolveOAuthClient({ refreshToken: TOKEN, googleClientId: G_ID }),
    /GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET/,
    "ein halbes Google-Paar wird stillschweigend akzeptiert"
  );
  checks++;
}

/* ── 3. Ein halbes Firebase-Paar wird nie gemischt ────────────────────────── */
{
  assert.throws(
    () => resolveOAuthClient({
      refreshToken: TOKEN, firebaseClientId: FT_ID,
      googleClientId: G_ID, googleClientSecret: G_SECRET,
    }),
    /FIREBASE_OAUTH_CLIENT_SECRET fehlt/,
    "eine Firebase-client_id ohne Geheimnis wird mit dem Google-Geheimnis gemischt"
  );
  checks++;
  assert.throws(
    () => resolveOAuthClient({
      refreshToken: TOKEN, firebaseClientSecret: FT_SECRET,
      googleClientId: G_ID, googleClientSecret: G_SECRET,
    }),
    /FIREBASE_OAUTH_CLIENT_ID fehlt/,
    "ein Firebase-Geheimnis ohne client_id wird mit der Google-client_id gemischt"
  );
  checks++;

  // Leerzeichen sind keine Konfiguration: „gesetzt, aber leer" zählt als fehlend.
  const leer = resolveOAuthClient({
    refreshToken: TOKEN, firebaseClientId: "   ", firebaseClientSecret: "",
    googleClientId: G_ID, googleClientSecret: G_SECRET,
  });
  ok(leer.source === "google", "eine leere Firebase-Variable verhindert den Google-Fallback");
}

/* ── 4. Ohne Refresh-Token bleibt es beim Dienstkonto ─────────────────────── */
{
  ok(resolveOAuthClient({ firebaseClientId: FT_ID, firebaseClientSecret: FT_SECRET }) === null,
    "ohne FIREBASE_OAUTH_REFRESH_TOKEN wird trotzdem ein OAuth-Weg gewählt");
  ok(resolveOAuthClient({ refreshToken: "   " }) === null,
    "ein leerer Refresh-Token gilt als gesetzt");
  ok(resolveOAuthClient() === null, "ohne Angaben entsteht ein Zugang aus dem Nichts");
}

/* ── 5. Derselbe Weg über die Umgebungsvariablen ──────────────────────────── */
{
  const KEYS = ["FIREBASE_OAUTH_REFRESH_TOKEN", "FIREBASE_OAUTH_CLIENT_ID",
    "FIREBASE_OAUTH_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
  const backup = {};
  KEYS.forEach((key) => { backup[key] = process.env[key]; });
  const setEnv = (values) => {
    KEYS.forEach((key) => {
      if (values[key] == null) delete process.env[key];
      else process.env[key] = values[key];
    });
  };

  try {
    setEnv({
      FIREBASE_OAUTH_REFRESH_TOKEN: TOKEN,
      FIREBASE_OAUTH_CLIENT_ID: FT_ID, FIREBASE_OAUTH_CLIENT_SECRET: FT_SECRET,
      GOOGLE_CLIENT_ID: G_ID, GOOGLE_CLIENT_SECRET: G_SECRET,
    });
    const vorrang = userRefreshTokenFromEnv();
    ok(vorrang.source === "firebase" && vorrang.clientId === FT_ID,
      "über die Umgebung hat das Firebase-Paar keinen Vorrang");

    setEnv({
      FIREBASE_OAUTH_REFRESH_TOKEN: TOKEN,
      GOOGLE_CLIENT_ID: G_ID, GOOGLE_CLIENT_SECRET: G_SECRET,
    });
    const fallback = userRefreshTokenFromEnv();
    ok(fallback.source === "google" && fallback.clientId === G_ID,
      "über die Umgebung greift der Google-Fallback nicht");

    setEnv({ GOOGLE_CLIENT_ID: G_ID, GOOGLE_CLIENT_SECRET: G_SECRET });
    ok(userRefreshTokenFromEnv() === null,
      "ohne Refresh-Token in der Umgebung entsteht trotzdem ein OAuth-Weg");

    setEnv({ FIREBASE_OAUTH_REFRESH_TOKEN: TOKEN, FIREBASE_OAUTH_CLIENT_ID: FT_ID });
    assert.throws(() => userRefreshTokenFromEnv(), /FIREBASE_OAUTH_CLIENT_SECRET fehlt/,
      "ein halbes Paar in der Umgebung bleibt unbemerkt");
    checks++;
  } finally {
    setEnv(backup);
  }
}

/* ── 6. Im Repository liegt kein Zugangsdatum ─────────────────────────────── */
{
  const source = fs.readFileSync(modulePath, "utf8");
  const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  [["firebase-admin.mjs", source], ["dieser Test", self]].forEach(([name, text]) => {
    ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${name} enthält einen privaten Schlüssel`);
    ok(!/\b1\/\/[0-9A-Za-z_-]{20,}/.test(text), `${name} enthält einen echten Google-Refresh-Token`);
    ok(!/GOCSPX-[0-9A-Za-z_-]{10,}/.test(text), `${name} enthält ein echtes Google-client_secret`);
    ok(!/[0-9]{10,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com/.test(text),
      `${name} enthält eine echte OAuth-client_id`);
  });
}

console.log(`firebase oauth client: ok (${checks} Pruefungen)`);
