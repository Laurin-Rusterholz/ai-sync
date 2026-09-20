/*
 * Unabhaengiges Review, Zusatzbefund (Baustein A, Betriebs-Kostenfreigabe):
 * `createEnvCostPolicyPort` behauptete eine "frische, bei jedem Aufruf neu
 * gelesene" Richtlinie, las die Umgebungsvariable aber nur EINMAL beim Bau
 * des Ports und fror das Ergebnis ein. `server.mjs` ist ein langlebiger
 * Prozess (kein Netlify-Function-Aufruf pro Anfrage) — ein Widerruf oder
 * eine Preisaenderung waere bis zum naechsten Neustart unsichtbar geblieben,
 * genau das Gegenteil dessen, was `cost-adapter.mjs`s `ladePolicy()` vor
 * JEDEM Reservieren/Senden erwartet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createEnvCostPolicyPort } from "../runtime/quantus-v3/src/cost-policy-port.mjs";

function envFrom(store) {
  return (name) => store[name];
}

test("costPolicy.load() liest die Umgebungsvariable bei JEDEM Aufruf frisch, nicht nur beim Bau des Ports", async () => {
  const env = { QUANTUS_V3_COST_POLICY_JSON: JSON.stringify({ version: "1", tenant: "quantus" }) };
  const port = createEnvCostPolicyPort(envFrom(env));
  const erste = await port.impl.load();
  assert.equal(erste.version, "1");

  // Widerruf zwischen zwei Aufrufen desselben Ports — OHNE den Port neu zu bauen.
  env.QUANTUS_V3_COST_POLICY_JSON = "";
  const zweite = await port.impl.load();
  assert.equal(zweite, null, "ein Widerruf muss beim naechsten Aufruf sofort sichtbar sein, nicht erst nach einem Neustart");

  // Eine Aenderung (neue Version) wird ebenso sofort sichtbar.
  env.QUANTUS_V3_COST_POLICY_JSON = JSON.stringify({ version: "2", tenant: "quantus" });
  const dritte = await port.impl.load();
  assert.equal(dritte.version, "2", "eine Aenderung muss beim naechsten Aufruf sofort sichtbar sein");
});

test("costPolicy-Port ist immer verfuegbar, auch wenn beim Start noch keine gueltige Richtlinie gesetzt ist (spaetere Konfiguration bleibt wirksam)", async () => {
  const env = {}; // beim Start: nichts konfiguriert
  const port = createEnvCostPolicyPort(envFrom(env));
  assert.equal(port.available, true, "ein always-unavailable-Port haette eine spaeter (im selben warmen Prozess) gesetzte Variable nie mehr gesehen");
  assert.equal(await port.impl.load(), null, "ohne konfigurierte Variable liefert load() ehrlich null, kein erfundener Ersatzwert");

  // Der Betreiber setzt die Variable NACH dem Start des Prozesses.
  env.QUANTUS_V3_COST_POLICY_JSON = JSON.stringify({ version: "1", tenant: "quantus" });
  const nachher = await port.impl.load();
  assert.ok(nachher && nachher.version === "1", "eine spaeter gesetzte Variable muss ohne Prozessneustart wirksam werden");
});

test("costPolicy.load() liefert null bei ungueltigem JSON, ohne den Port als unavailable einzufrieren", async () => {
  const env = { QUANTUS_V3_COST_POLICY_JSON: "{kaputt" };
  const port = createEnvCostPolicyPort(envFrom(env));
  assert.equal(await port.impl.load(), null);
  env.QUANTUS_V3_COST_POLICY_JSON = JSON.stringify({ version: "1" });
  assert.equal((await port.impl.load()).version, "1");
});
