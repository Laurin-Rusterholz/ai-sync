/*
 * v3 C1 — Konfiguration: fehlt etwas, ist zu.
 *
 * BEFUND, aus dem diese Tests folgen: Die bestehenden Endpunkte lesen ein
 * OPTIONALES `SYNC_AUTH_TOKEN`. Fehlt es, lassen sie durch (`requireAuth`
 * gibt null zurück = „weiter"). Genau diese Richtung hat beim Mail-Ausgang
 * schon einmal gefehlt und wurde dort auf 503 umgestellt. Für v3 gilt sie von
 * Anfang an: OHNE vollständige Serverkonfiguration antwortet nichts mit 200.
 *
 * Zweitens: eine Absage darf nie ein Geheimnis verraten. Geprüft wird deshalb
 * nicht nur der Status, sondern auch, dass in keiner Antwort ein Schlüssel,
 * Hash oder Zugangsdatum auftaucht — auch nicht in Bruchstücken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuthConfig, QUANTUS_V3_TOOLS, AUTH_CONFIG_VARS } from "../netlify/lib/quantus-v3-auth.mjs";
import { resolveCursorConfig, CURSOR_CONFIG_VARS } from "../netlify/lib/quantus-v3-cursor.mjs";
import { makeEnv, PROJECT_ID, POLICY_VERSION, TENANT } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("vollständige Konfiguration ergibt eine geschlossene Config", () => {
  const { read } = makeEnv({ tenant: TENANT });
  const res = resolveAuthConfig(read);
  assert.equal(res.ok, true);
  assert.equal(res.config.projectId, PROJECT_ID);
  assert.equal(res.config.issuer, `https://securetoken.google.com/${PROJECT_ID}`);
  assert.equal(res.config.policyVersion, POLICY_VERSION);
  assert.equal(res.config.tenant, TENANT);
  assert.deepEqual([...res.config.allowedOrigins], ["https://management-xo2-pro.netlify.app"]);
});

test("Standard ist dry_run — ein Produktivrecht entsteht nur bewusst", () => {
  const { read } = makeEnv();
  const res = resolveAuthConfig(read);
  assert.equal(res.config.mode, "dry_run");
  assert.equal(res.config.dryRun, true);

  const enforced = resolveAuthConfig(makeEnv({ mode: "enforce" }).read);
  assert.equal(enforced.config.dryRun, false);

  const bogus = resolveAuthConfig(makeEnv({ mode: "vielleicht" }).read);
  assert.equal(bogus.ok, false);
  assert.equal(bogus.status, 503);
});

test("jede fehlende Pflichtvariable ⇒ 503 auth_not_configured, mit Namen", () => {
  for (const name of [
    AUTH_CONFIG_VARS.projectId, AUTH_CONFIG_VARS.policyVersion, AUTH_CONFIG_VARS.origins,
    AUTH_CONFIG_VARS.serviceCredentials, AUTH_CONFIG_VARS.workerKeys,
  ]) {
    const { read } = makeEnv({ overrides: { [name]: null } });
    const res = resolveAuthConfig(read);
    assert.equal(res.ok, false, `${name} fehlt und wird trotzdem durchgelassen`);
    assert.equal(res.status, 503);
    assert.equal(res.error, "auth_not_configured");
    assert.ok(res.missing.includes(name), `die Absage nennt ${name} nicht`);
  }
});

test("halbe oder kaputte Konfiguration ist keine halbe Tür", () => {
  const faelle = [
    [AUTH_CONFIG_VARS.serviceCredentials, "{kein json"],
    [AUTH_CONFIG_VARS.serviceCredentials, "[]"],
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "scheduler", tenant: "t", secretSha256: "kurz", status: "active" }])],
    // Eine Dienstkennung darf niemals die Nutzerrolle tragen.
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "user", tenant: "t", secretSha256: "a".repeat(64), status: "active" }])],
    // … und auch keine Worker-Rolle: Leitungsagent und Spezialisten arbeiten
    // mit kurzlebigen Auftragstoken, nicht mit einem Dauer-Zugangsdatum.
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "lead_agent", tenant: "t", secretSha256: "a".repeat(64), status: "active" }])],
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "specialist_claude", tenant: "t", secretSha256: "a".repeat(64), status: "active" }])],
    // Unbrauchbarer oder fehlender Stichtag.
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "scheduler", tenant: "t", secretSha256: "a".repeat(64), status: "active", notAfter: "irgendwann" }])],
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "scheduler", tenant: "t", secretSha256: "a".repeat(64), status: "retiring" }])],
    // Unbekannte Rolle ⇒ Konfiguration ungültig, nicht „dann eben ohne Rechte".
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "superadmin", tenant: "t", secretSha256: "a".repeat(64), status: "active" }])],
    // Nur zurückgezogene Zugangsdaten = keine gültigen.
    [AUTH_CONFIG_VARS.serviceCredentials, JSON.stringify([{ id: "a", principal: "p", role: "scheduler", tenant: "t", secretSha256: "a".repeat(64), status: "revoked" }])],
    [AUTH_CONFIG_VARS.workerKeys, JSON.stringify([{ kid: "w1", secret: "zu-kurz", status: "active" }])],
    [AUTH_CONFIG_VARS.workerKeys, JSON.stringify([{ kid: "w1", secret: "x".repeat(40), status: "retiring" }])],
  ];
  for (const [name, value] of faelle) {
    const res = resolveAuthConfig(makeEnv({ overrides: { [name]: value } }).read);
    assert.equal(res.ok, false, `${name}=${value.slice(0, 24)}… wurde akzeptiert`);
    assert.equal(res.status, 503);
  }
});

test("Origin-Allowlist: kein Wildcard, kein http, keine leere Liste", () => {
  for (const value of ["*", "https://*.example.com", "http://management-xo2-pro.netlify.app", "nicht-mal-eine-url", " , "]) {
    const res = resolveAuthConfig(makeEnv({ overrides: { QUANTUS_V3_ALLOWED_ORIGINS: value } }).read);
    assert.equal(res.ok, false, `Origin-Liste "${value}" wurde akzeptiert`);
    assert.equal(res.status, 503);
  }
  const ok = resolveAuthConfig(makeEnv({ origins: "https://a.example,https://b.example" }).read);
  assert.deepEqual([...ok.config.allowedOrigins], ["https://a.example", "https://b.example"]);
});

test("Cursor-Schlüssel fehlen ⇒ 503, nicht „dann eben ohne Cursor“", () => {
  const res = resolveCursorConfig(makeEnv({ overrides: { QUANTUS_V3_CURSOR_KEYS: null } }).read);
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.error, "auth_not_configured");
  assert.ok(res.missing.includes(CURSOR_CONFIG_VARS.cursorKeys));

  for (const value of ["[]", "{}", "kein json", JSON.stringify([{ kid: "c1", secret: "kurz", status: "active" }])]) {
    const bad = resolveCursorConfig(makeEnv({ overrides: { QUANTUS_V3_CURSOR_KEYS: value } }).read);
    assert.equal(bad.ok, false, `Cursor-Schlüssel "${value}" wurden akzeptiert`);
    assert.equal(bad.status, 503);
  }
});

test("keine Absage enthält ein Geheimnis — auch nicht in Bruchstücken", () => {
  const env = makeEnv({ tenant: TENANT });
  const geheimnisse = [
    ...Object.values(env.secrets.service),
    ...Object.values(env.secrets.worker),
    ...Object.values(env.secrets.cursor),
  ];
  const alle = [];
  for (const name of Object.values(AUTH_CONFIG_VARS)) {
    alle.push(resolveAuthConfig(makeEnv({ overrides: { ...env.vars, [name]: "kaputt" } }).read));
    alle.push(resolveAuthConfig(makeEnv({ overrides: { ...env.vars, [name]: null } }).read));
  }
  alle.push(resolveCursorConfig(makeEnv({ overrides: { ...env.vars, QUANTUS_V3_CURSOR_KEYS: "kaputt" } }).read));

  // Geprüft werden die ABSAGEN — sie verlassen den Server.
  const absagen = alle.filter((a) => a.ok === false);
  assert.ok(absagen.length >= 6, "zu wenige Absagen geprüft");
  const text = JSON.stringify(absagen.map((a) => ({ ...a, body: a.body })));
  for (const geheim of geheimnisse) {
    assert.ok(!text.includes(geheim), "eine Absage enthält ein Zugangsdatum");
    assert.ok(!text.includes(geheim.slice(0, 16)), "eine Absage enthält den Anfang eines Zugangsdatums");
  }
  // Auch der Hash gehört nicht in eine Antwort.
  assert.ok(!/[0-9a-f]{64}/.test(text), "eine Absage enthält einen SHA-256-Abdruck");
});

test("C1 schaltet nichts frei: kein Handler zu den vier Routen", () => {
  const namen = Object.keys(QUANTUS_V3_TOOLS);
  assert.deepEqual(namen, ["quantus_context", "quantus_read", "quantus_command", "quantus_run_status"]);
  assert.deepEqual(namen.map((n) => QUANTUS_V3_TOOLS[n].route),
    ["quantus-context", "quantus-read", "quantus-ingest", "quantus-run-status"]);

  for (const name of namen) {
    assert.equal(QUANTUS_V3_TOOLS[name].enabled, false, `${name} ist als freigeschaltet markiert`);
    const datei = path.join(root, "netlify/functions", `${QUANTUS_V3_TOOLS[name].route}.mjs`);
    assert.equal(fs.existsSync(datei), false, `es gibt bereits einen Handler ${datei}`);
  }

  // Und das Sicherheitsmodul selbst schreibt nichts: kein Firebase, kein Blob.
  // Gemessen wird am CODE, nicht an den Kommentaren — dort dürfen die Namen
  // zur Erklärung vorkommen.
  for (const datei of ["netlify/lib/quantus-v3-auth.mjs", "netlify/lib/quantus-v3-cursor.mjs"]) {
    const code = ohneKommentare(fs.readFileSync(path.join(root, datei), "utf8"));
    for (const verboten of ["firebase-admin", "writeAppDataText", "readAppDataText", "@netlify/blobs", "quantus-v3-idempotency"]) {
      assert.ok(!code.includes(verboten), `${datei} greift auf ${verboten} zu`);
    }
    // Ausser node:, dem eigenen Paket und der geprüften JOSE-Bibliothek wird
    // nichts importiert — insbesondere kein Datenzugriff.
    for (const [, spec] of code.matchAll(/from\s+"([^"]+)"/g)) {
      assert.ok(spec.startsWith("node:") || spec.startsWith("./quantus-v3-") || spec === "jose",
        `${datei} importiert ${spec}`);
    }
  }
});

test("die bestehenden Endpunkte bleiben unangetastet (Paketgrenze)", () => {
  // SYNC_AUTH_TOKEN ist kein v3-Standard: das neue Modul kennt ihn nicht.
  const quelle = fs.readFileSync(path.join(root, "netlify/lib/quantus-v3-auth.mjs"), "utf8");
  const cursor = fs.readFileSync(path.join(root, "netlify/lib/quantus-v3-cursor.mjs"), "utf8");
  assert.ok(!ohneKommentare(quelle).includes("SYNC_AUTH_TOKEN"),
    "der alte gemeinsame Token wird im v3-Code gelesen");
  assert.ok(!ohneKommentare(cursor).includes("SYNC_AUTH_TOKEN"));
});

/* Kommentare entfernen — die Quelltextprüfungen sollen den CODE messen. */
function ohneKommentare(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("die einzige neue Abhängigkeit ist die JOSE-Bibliothek", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.dependencies.jose, "jose ist nicht als Abhängigkeit erklärt");
  // jose bringt selbst nichts mit — das ist der Grund für die Wahl.
  const joseMeta = JSON.parse(fs.readFileSync(path.join(root, "node_modules/jose/package.json"), "utf8"));
  assert.deepEqual(joseMeta.dependencies || {}, {});
  // Und das Testskript läuft über den Dateinamen-Glob, damit neue
  // Gegenbeispieldateien nicht vergessen werden können.
  assert.match(pkg.scripts["test:quantus-v3"], /quantus-v3-auth-\*\.test\.mjs/);
  assert.match(pkg.scripts.test, /test:quantus-v3/);
});
