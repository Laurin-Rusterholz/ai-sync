/*
 * Nutzeranforderung: die sechs nicht-geheimen Konfigurationswerte fuer die
 * E-Mail-Auswertung duerfen nicht still unbelegt bleiben — eine validierte,
 * kompakte Importvorlage muss mitgeliefert werden
 * (docs/quantus-v3-email-briefing.env.example). Dieser Test parst die
 * Datei wie Netlifys ".env"-Import und prueft die beiden Policy-JSONs
 * gegen die ECHTEN Schema-Validatoren dieses Repos — kein Vertrauen auf
 * "sieht gueltig aus", sondern derselbe Code, den `checkDailyBriefingConfig`
 * bzw. der Kosten-Adapter zur Laufzeit verwenden.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePolicy } from "../netlify/lib/assistant-schema.mjs";
import { validateCostPolicy } from "../netlify/lib/quantus-v3-runtime-state.mjs";
import { checkDailyBriefingConfig } from "../netlify/lib/quantus-v3-daily-briefing.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPfad = path.join(root, "docs/quantus-v3-email-briefing.env.example");

function parseEnvDatei(text) {
  const out = {};
  for (const zeileRoh of text.split("\n")) {
    const zeile = zeileRoh.trim();
    if (!zeile || zeile.startsWith("#")) continue;
    const gleich = zeile.indexOf("=");
    if (gleich < 0) continue;
    const key = zeile.slice(0, gleich).trim();
    let value = zeile.slice(gleich + 1).trim();
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

test("die Importvorlage existiert und ist mit '=' gueltig parsbar", () => {
  const text = fs.readFileSync(envPfad, "utf8");
  const env = parseEnvDatei(text);
  assert.ok(Object.keys(env).length >= 7, "es muessen mindestens sieben Variablen enthalten sein");
});

test("alle sechs nicht-geheimen Konfigurationswerte sind belegt (nicht leer, kein Platzhalter)", () => {
  const env = parseEnvDatei(fs.readFileSync(envPfad, "utf8"));
  const NAMEN = [
    "QUANTUS_V3_ANTHROPIC_MODEL",
    "QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK",
    "QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK",
    "QUANTUS_V3_TENANT",
    "QUANTUS_V3_TAGESBRIEFING_POLICY_JSON",
    "QUANTUS_V3_COST_POLICY_JSON",
  ];
  for (const name of NAMEN) {
    assert.ok(env[name] && env[name].trim().length > 0, `${name} darf in der Vorlage nicht leer/unbelegt sein`);
  }
  // Die Preise muessen strikt positive Ganzzahlen sein (dieselbe Regel wie
  // strengPositiveMicros() in quantus-v3-daily-briefing.mjs).
  assert.ok(Number.isSafeInteger(Number(env.QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK)) && Number(env.QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK) > 0);
  assert.ok(Number.isSafeInteger(Number(env.QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK)) && Number(env.QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK) > 0);
});

test("QUANTUS_EMAIL_AUTH_TOKEN ist als Platzhalter markiert (kein echtes Geheimnis in der Vorlage)", () => {
  const env = parseEnvDatei(fs.readFileSync(envPfad, "utf8"));
  assert.ok(env.QUANTUS_EMAIL_AUTH_TOKEN, "der Schluessel muss als Name vorhanden sein");
  assert.match(env.QUANTUS_EMAIL_AUTH_TOKEN, /ERSETZEN|PLACEHOLDER|CHANGE/i, "der Wert darf kein echtes Geheimnis sein, nur ein erkennbarer Platzhalter");
});

test("QUANTUS_V3_TAGESBRIEFING_POLICY_JSON besteht die ECHTE validatePolicy()-Pruefung", () => {
  const env = parseEnvDatei(fs.readFileSync(envPfad, "utf8"));
  const policy = JSON.parse(env.QUANTUS_V3_TAGESBRIEFING_POLICY_JSON);
  const verdict = validatePolicy(policy);
  assert.deepEqual(verdict, { ok: true, errors: [] }, `Policy ungueltig: ${JSON.stringify(verdict)}`);
  assert.equal(policy.tenant, env.QUANTUS_V3_TENANT, "tenant muss mit QUANTUS_V3_TENANT uebereinstimmen");
});

test("QUANTUS_V3_COST_POLICY_JSON besteht die ECHTE validateCostPolicy()-Pruefung", () => {
  const env = parseEnvDatei(fs.readFileSync(envPfad, "utf8"));
  const policy = JSON.parse(env.QUANTUS_V3_COST_POLICY_JSON);
  const verdict = validateCostPolicy(policy);
  assert.equal(verdict.ok, true, `Kostenrichtlinie ungueltig: ${JSON.stringify(verdict)}`);
});

test("mit dieser Vorlage (Platzhalter-Token durch echten Wert ersetzt gedacht) meldet checkDailyBriefingConfig() vollstaendige Konfiguration", () => {
  const env = parseEnvDatei(fs.readFileSync(envPfad, "utf8"));
  const envRead = (name) => env[name];
  const result = checkDailyBriefingConfig(envRead);
  assert.deepEqual(result, { ok: true, missing: [] }, `Preflight haette mit dieser Vorlage vollstaendig sein muessen: ${JSON.stringify(result)}`);
});
