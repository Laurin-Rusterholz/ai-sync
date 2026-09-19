/*
 * v3 C2 — die vier Routen selbst: dünn, verdrahtet, fail closed.
 *
 * Hier wird die ECHTE Netlify-Funktion aufgerufen — nicht der Dienst dahinter.
 * Zwei Fragen:
 *   1. Ist die Hülle wirklich dünn? (Nur Dienst und Verdrahtung, keine
 *      Fachlogik, kein direkter Firebase-Zugriff.)
 *   2. Was passiert ohne Konfiguration und ohne Fachadapter? Es muss 503
 *      herauskommen — eine echte Response, kein Absturz und kein Erfolg.
 *
 * Damit ist auch festgehalten, was dieses Paket NICHT behauptet: die Routen
 * sind vorhanden und geschlossen, aber ohne Fachadapter liefern sie nichts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUANTUS_V3_TOOLS } from "../netlify/lib/quantus-v3-auth.mjs";
import { ROUTE_QUERIES } from "../netlify/lib/quantus-v3-service.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROUTEN = ["quantus-ingest", "quantus-context", "quantus-read", "quantus-run-status"];

function ohneKommentare(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("zu jedem Werkzeug gibt es genau eine Route — und jetzt auch eine Datei", () => {
  const routen = Object.values(QUANTUS_V3_TOOLS).map((t) => t.route);
  assert.deepEqual([...routen].sort(), [...ROUTEN].sort());
  for (const name of ROUTEN) {
    assert.ok(fs.existsSync(path.join(root, "netlify/functions", `${name}.mjs`)), `${name}.mjs fehlt`);
  }
});

test("die Hüllen sind dünn: nur Dienst und Verdrahtung", () => {
  for (const name of ROUTEN) {
    const quelle = fs.readFileSync(path.join(root, "netlify/functions", `${name}.mjs`), "utf8");
    const code = ohneKommentare(quelle);
    const importe = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(importe.sort(), ["../lib/quantus-v3-runtime.mjs", "../lib/quantus-v3-service.mjs"],
      `${name} importiert mehr als Dienst und Verdrahtung: ${importe.join(", ")}`);
    // Keine Fachlogik, kein direkter Datenzugriff in der Hülle.
    for (const v of ["firebase-admin", "entities", "mutateAppData", "jose"]) {
      assert.ok(!code.includes(v), `${name} enthält ${v}`);
    }
    assert.ok(code.includes("export const config"), `${name} deklariert keinen Pfad`);
    assert.ok(code.includes(`/.netlify/functions/${name}`), `${name} deklariert den falschen Pfad`);
    // Eine Hülle ist kurz.
    assert.ok(code.split("\n").filter((z) => z.trim()).length <= 12, `${name} ist keine Hülle mehr`);
  }
});

test("ohne Konfiguration antwortet jede Route 503 — als echte Response", async () => {
  // Die Umgebung dieses Testlaufs trägt keine v3-Variablen: genau der Zustand
  // der Produktion, solange nichts hinterlegt ist.
  for (const name of ROUTEN) {
    const modul = await import(path.join(root, "netlify/functions", `${name}.mjs`));
    assert.equal(typeof modul.default, "function", `${name} hat keinen Handler`);
    assert.equal(modul.config.path, `/.netlify/functions/${name}`);

    const anfrage = new Request(`https://management-xo2-pro.netlify.app/.netlify/functions/${name}?query=run.status&scopeId=run_1`, {
      method: name === "quantus-ingest" ? "POST" : "GET",
      headers: {
        "x-forwarded-proto": "https",
        "content-type": "application/json",
        "idempotency-key": "k1",
        authorization: "Bearer " + "x".repeat(40),
      },
      body: name === "quantus-ingest"
        ? JSON.stringify({ schemaVersion: 3, verb: "run.log", jobId: "job_1", expectedEntityVersion: 0, payload: { event: "tick" } })
        : undefined,
    });
    const antwort = await modul.default(anfrage);
    assert.ok(antwort instanceof Response, `${name} liefert keine Response`);
    assert.equal(antwort.status, 503, `${name} antwortete ${antwort.status}`);
    const koerper = await antwort.json();
    assert.equal(koerper.error, "auth_not_configured");
    assert.ok(Array.isArray(koerper.missing) && koerper.missing.length, "die Absage nennt nicht, was fehlt");
    // Kein Geheimnis, kein Datenbestand in der Absage.
    assert.ok(!JSON.stringify(koerper).includes("xxxxxxxx"));
  }
});

test("die Zuordnung Route → benannte Abfragen ist eng und vollständig", () => {
  assert.deepEqual(Object.keys(ROUTE_QUERIES).sort(), ["quantus-context", "quantus-read", "quantus-run-status"]);
  for (const [route, abfragen] of Object.entries(ROUTE_QUERIES)) {
    assert.ok(abfragen.length > 0 && abfragen.length <= 4, `${route} bedient zu viele Abfragen`);
  }
  // Der Befehlsweg hat keine Leseabfragen.
  assert.equal(Object.prototype.hasOwnProperty.call(ROUTE_QUERIES, "quantus-ingest"), false);
});

test("die Verdrahtung lädt fehlende Adapter, ohne zu sprengen", async () => {
  const { buildRuntimeDeps } = await import(path.join(root, "netlify/lib/quantus-v3-runtime.mjs"));
  const deps = await buildRuntimeDeps({ write: true, read: () => undefined });
  // Das Idempotenzmodul und der Fachadapter gehören anderen Paketen: in
  // diesem Zweig fehlen sie, und das muss sichtbar sein statt zu knallen.
  assert.equal(deps.idempotency, null, "ein Idempotenzadapter wurde erfunden");
  assert.equal(deps.domain, null, "ein Fachadapter wurde erfunden");
  assert.equal(typeof deps.now, "function");
  assert.equal(typeof deps.newRequestId, "function");
  // Ohne Zugriffstoken-Anbieter gibt es keine Sperrprüfung — und damit keine
  // Nutzer-Anmeldung. Das ist gewollt: lieber 503 als ein ID-Token ohne
  // Widerrufsprüfung.
  assert.equal(deps.userLookup, null);
});
