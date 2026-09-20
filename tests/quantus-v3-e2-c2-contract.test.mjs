/* ══ E2 ⇄ C2 — der Vertragstest an der ECHTEN Lesekette ═══════════════════
 *
 * BEFUND, DER DIESE DATEI AUSGELOEST HAT
 * --------------------------------------
 * Der Statusnachweis dieses Pakets war gegen eine ERFUNDENE Antwort
 * gebaut: ein Objekt `{ runStatus: { closure: … } }`, einen POST und einen
 * Laufschluessel als `scopeId`. Keines davon existiert. Die Integration
 * 48dc1fe antwortet auf `quantus-run-status` nur auf GET, liest alles aus
 * dem Query-String, verlangt fuer `scopeId` `[A-Za-z0-9_-]{1,128}` ohne
 * `__` und liefert eine SEITE mit `items`, beschnitten auf
 * `VISIBLE_FIELDS.run_status`.
 *
 * Deshalb wird hier nicht gegen eine Nachbildung geprueft, sondern gegen
 * die echte Kette: `handleReadRequest` und ihre vier Module werden
 * KONTROLLIERT aus dem Git-Objektspeicher in ein temporaeres Verzeichnis
 * gelegt (kein Kopieren ins Paket, keine Aenderung an C2) und von dort
 * geladen. Welche Fassung lief, schreibt der Lauf.
 *
 * Kein Netz: der Transport bekommt ein `fetch`, das die Anfrage in die
 * echte Kette gibt und deren Antwort als echte `Response` zurueckreicht.
 * Alle Geheimnisse entstehen zur Laufzeit; kein Projekt, kein Anbieter,
 * keine Produktivkonfiguration.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createC2HttpTransport } from "../runtime/quantus-v3/src/c2-transport.mjs";
import { createToolClient } from "../runtime/quantus-v3/src/tool-ports.mjs";
import { createRunStatusClosureEvidencePort, mapRunStatusPageToEvidence } from "../runtime/quantus-v3/src/integration-ports.mjs";
import { runIdForRunKey, statusScopeIdForRunKey } from "../runtime/quantus-v3/src/run-ids.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const C2_COMMIT = "48dc1fe";
const C2_MODULE = [
  "quantus-v3-service.mjs", "quantus-v3-auth.mjs", "quantus-v3-cursor.mjs",
  "quantus-v3-read-helpers.mjs", "quantus-v3-command-envelope.mjs",
];

const TENANT = "quantus";
const POLICY_VERSION = "3.0";
const PROJECT_ID = "quantus-test-project";
const BASE = "https://management-xo2-pro.netlify.app";
const T0 = PLAN.wallTimeToMs("2026-09-19", 9, 0);
const RUNKEY = PLAN.slotRunKey(TENANT, "2026-09-19", "process09", POLICY_VERSION);
const SCOPE_ID = statusScopeIdForRunKey(RUNKEY);
const RUN_ID = runIdForRunKey(RUNKEY);

const sha256Hex = (v) => createHash("sha256").update(String(v), "utf8").digest("hex");

/* ── Die echte C2-Kette, kontrolliert geladen ─────────────────────────── */
let geladen = null;
async function ladeC2() {
  if (geladen) return geladen;
  let quellen;
  try {
    quellen = C2_MODULE.map((datei) => execFileSync("git", ["show", `${C2_COMMIT}:netlify/lib/${datei}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    geladen = { ok: false, reason: `git_object_missing:${C2_COMMIT}` };
    return geladen;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qv3-c2-"));
  C2_MODULE.forEach((datei, i) => fs.writeFileSync(path.join(dir, datei), quellen[i]));
  // Damit der blosse Bezeichner `jose` aufloest, ohne etwas zu kopieren.
  try { fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir"); } catch { /* schon da */ }
  try {
    const service = await import(path.join(dir, "quantus-v3-service.mjs"));
    geladen = { ok: true, source: `git:${C2_COMMIT}`, service };
  } catch (err) {
    geladen = { ok: false, reason: `import_failed:${err?.code || err?.message || "unknown"}` };
  }
  return geladen;
}

/* ── Serverkonfiguration und Bestand, beides synthetisch ──────────────── */
function makeEnv(secret) {
  const vars = {
    QUANTUS_V3_FIREBASE_PROJECT_ID: PROJECT_ID,
    QUANTUS_V3_POLICY_VERSION: POLICY_VERSION,
    QUANTUS_V3_ALLOWED_ORIGINS: BASE,
    QUANTUS_V3_SERVICE_CREDENTIALS: JSON.stringify([
      { id: "cred-sched-1", principal: "cloud-run-worker", role: "scheduler", tenant: TENANT, secretSha256: sha256Hex(secret), status: "active" },
    ]),
    QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([{ kid: "w1", secret: randomBytes(32).toString("hex"), status: "active" }]),
    QUANTUS_V3_CURSOR_KEYS: JSON.stringify([{ kid: "c1", secret: randomBytes(32).toString("hex"), status: "active" }]),
  };
  return (name) => vars[name];
}

/* Ein Statusdatensatz genau so, wie der Fachadapter ihn fuehren muesste,
   wenn er die Zuordnung dieses Pakets einhaelt. */
function statusEintrag(over = {}) {
  return {
    kind: "run_status", id: SCOPE_ID, tenant: TENANT, ownerId: "uid-laurin",
    runId: RUN_ID, jobId: RUN_ID, entityVersion: 4,
    state: "completed", stage: "abschluss", updatedAt: "2026-09-19T08:59:00Z",
    openQuestions: [], blocked: false,
    // Ein Feld, das die Sichtliste NICHT kennt — es darf nicht hinausgehen.
    internerVermerk: "nicht fuer Agenten",
    ...over,
  };
}

function makeDeps(env, { eintraege = [statusEintrag()], dataRevision = 42, hasMore = false } = {}) {
  let n = 0;
  const spur = { reads: 0, pages: 0 };
  return {
    now: () => T0,
    newRequestId: () => `r-${++n}`,
    env,
    keySource: { async get() { return null; } },
    userLookup: async () => null,
    rateLimiter: {
      atomic: true, scope: "shared", multiInstanceSafe: true,
      async increment() { return { count: 1 }; },
    },
    store: {
      async readSnapshot() {
        spur.reads++;
        return { entities: { runStatus: Object.fromEntries(eintraege.map((e) => [e.id, e])) },
          automation: { schemaVersion: 3, dataRevision, idempotencyByKey: {} } };
      },
    },
    domain: {
      loadObject(snapshot, { kind, id }) {
        if (kind !== "run_status") return null;
        return snapshot?.entities?.runStatus?.[id] || null;
      },
      listPage(snapshot, { pageSize }) {
        spur.pages++;
        const alle = Object.values(snapshot?.entities?.runStatus || {});
        const teil = alle.slice(0, pageSize);
        return { items: teil, hasMore, nextAfterId: hasMore ? teil[teil.length - 1]?.id : null };
      },
    },
    spur,
  };
}

/* ── Der Transport spricht mit der echten Kette, ohne Netz ────────────── */
function fetchGegenKette(service, deps, aufzeichnung) {
  return async function fetchImpl(url, init = {}) {
    const headerMap = new Map(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    headerMap.set("x-forwarded-proto", "https");
    aufzeichnung.push({ url, method: init.method, headers: [...headerMap.keys()].sort() });
    const req = {
      method: init.method,
      url,
      headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
      async text() { return init.body == null ? "" : String(init.body); },
    };
    const antwort = await service.handleReadRequest(req, deps, { route: "quantus-run-status" });
    return new Response(antwort.body === null ? null : JSON.stringify(antwort.body), {
      status: antwort.status,
      headers: { "content-type": "application/json" },
    });
  };
}

async function aufbau(optionen = {}) {
  const c2 = await ladeC2();
  const secret = randomBytes(32).toString("hex");
  const env = makeEnv(secret);
  const deps = makeDeps(env, optionen);
  const aufzeichnung = [];
  const transport = createC2HttpTransport({
    baseUrl: BASE,
    fetchImpl: c2.ok ? fetchGegenKette(c2.service, deps, aufzeichnung) : async () => new Response("", { status: 503 }),
  });
  const toolClient = createToolClient({
    transport, credential: { async get() { return secret; } },
    tenant: TENANT, policyVersion: POLICY_VERSION,
    toolsEnabled: { quantus_run_status: true },
  });
  return { c2, deps, transport, toolClient, aufzeichnung, secret };
}

test(`die gepruefte C2-Fassung ist ladbar (Integrationsnachweis)`, async () => {
  const c2 = await ladeC2();
  assert.equal(c2.ok, true, `C2 nicht ladbar: ${c2.reason} — ohne sie ist dieser Lauf KEIN Integrationsnachweis`);
  assert.equal(typeof c2.service.handleReadRequest, "function");
  console.log(`# C2-Fassung im Lauf: ${c2.source}`);
});

test("der Leseport erreicht die echte Route und bekommt die echte Seite", async () => {
  const { c2, toolClient, aufzeichnung } = await aufbau();
  assert.equal(c2.ok, true);
  const antwort = await toolClient.call("status.run",
    { query: "run.status", scopeId: SCOPE_ID, jobId: RUN_ID, pageSize: 100 }, { now: T0 });

  assert.equal(antwort.status, 200, JSON.stringify(antwort.body));
  // Der echte Umschlag — keine erfundenen Felder.
  assert.equal(antwort.body.ok, true);
  assert.equal(antwort.body.query, "run.status");
  assert.equal(antwort.body.scopeId, SCOPE_ID);
  assert.equal(antwort.body.complete, true);
  assert.equal(antwort.body.pageStatus, "done");
  assert.equal(antwort.body.hasMore, false);
  assert.equal(antwort.body.dataRevision, 42);
  assert.equal(antwort.body.items.length, 1);
  assert.deepEqual(antwort.body.entityVersions, { [SCOPE_ID]: 4 });

  // Beschnitten auf die Sichtliste — der interne Vermerk geht NICHT hinaus.
  const eintrag = antwort.body.items[0];
  assert.equal(eintrag.runId, RUN_ID);
  assert.equal(eintrag.state, "completed");
  assert.ok(!Object.hasOwn(eintrag, "internerVermerk"));
  assert.ok(!Object.hasOwn(eintrag, "tenant"));

  // Und es war wirklich ein GET mit Query-String.
  assert.equal(aufzeichnung.length, 1);
  assert.equal(aufzeichnung[0].method, "GET");
  const url = new URL(aufzeichnung[0].url);
  assert.equal(url.pathname, "/.netlify/functions/quantus-run-status");
  assert.equal(url.searchParams.get("query"), "run.status");
  assert.equal(url.searchParams.get("scopeId"), SCOPE_ID);
  assert.equal(url.searchParams.get("jobId"), RUN_ID);
  assert.equal(url.searchParams.get("pageSize"), "100");
  assert.ok(aufzeichnung[0].headers.includes("authorization"));
});

test("aus der echten Antwort entsteht ein Nachweis — gebunden an Datensatz, Version und Serverzeit", async () => {
  const { toolClient } = await aufbau();
  const port = createRunStatusClosureEvidencePort({ toolClient, tenant: TENANT, policyVersion: POLICY_VERSION });
  const nachweis = await port.impl.load({ runKey: RUNKEY, fence: 3, now: T0 });
  assert.notEqual(nachweis, null, `kein Nachweis: ${port.impl.lastFailure}`);
  assert.equal(nachweis.evidenceRef, `runstatus:${SCOPE_ID}:v4`);
  assert.equal(nachweis.dataRevision, 42);
  assert.equal(nachweis.verifiedAtMs, T0);
  assert.equal(nachweis.green, true);
  assert.equal(nachweis.fence, 3);
  assert.equal(nachweis.fenceAttestedByC2, false);
  // C2 bezeugt keinen Quellensatz — das bleibt sichtbar offen.
  assert.equal(nachweis.sources, null);
});

test("ein Laufschluessel als scopeId wird von der echten Kette abgewiesen", async () => {
  const { c2, transport, secret } = await aufbau();
  assert.equal(c2.ok, true);
  // Genau das schickte die fruehere Fassung dieses Pakets.
  const antwort = await transport.send({
    route: "quantus-run-status", method: "GET",
    searchParams: { query: "run.status", scopeId: RUNKEY },
    credential: secret,
  });
  assert.equal(antwort.status, 400);
  assert.equal(antwort.body.reason, "scope_id_invalid");
});

test("ein POST auf die Leseroute wird von der echten Kette abgewiesen", async () => {
  const { c2, transport, secret } = await aufbau();
  assert.equal(c2.ok, true);
  const antwort = await transport.send({
    route: "quantus-run-status", method: "POST",
    payload: { query: "run.status", scopeId: SCOPE_ID },
    idempotencyKey: "k-1", credential: secret,
  });
  assert.equal(antwort.status, 400);
  assert.equal(antwort.body.reason, "method_not_allowed");
});

test("eine fortgesetzte Seite ist kein Nachweis — auch nicht fuer den gefundenen Eintrag", async () => {
  const { toolClient } = await aufbau({
    eintraege: [statusEintrag(), statusEintrag({ id: "s-anderer", runId: "r-anderer", entityVersion: 1 })],
    hasMore: true,
  });
  const antwort = await toolClient.call("status.run",
    { query: "run.status", scopeId: SCOPE_ID, jobId: RUN_ID, pageSize: 1 }, { now: T0 });
  // Die echte Kette liefert entweder eine Fortsetzung oder bricht ab —
  // beides ist kein vollstaendiger Beweis.
  assert.ok(antwort.status !== 200 || antwort.body.complete === false, JSON.stringify(antwort.body));
  const out = mapRunStatusPageToEvidence(antwort, {
    runKey: RUNKEY, runId: RUN_ID, scopeId: SCOPE_ID, tenant: TENANT, policyVersion: POLICY_VERSION,
  });
  assert.equal(out.ok, false);
});

test("ohne freigeschaltetes Werkzeug kommt die Anfrage gar nicht erst hinaus", async () => {
  const { transport, secret } = await aufbau();
  const aus = createToolClient({
    transport, credential: { async get() { return secret; } },
    tenant: TENANT, policyVersion: POLICY_VERSION, toolsEnabled: {},
  });
  await assert.rejects(() => aus.call("status.run", { query: "run.status", scopeId: SCOPE_ID }, { now: T0 }),
    (e) => e.status === 503 && e.error === "tool_disabled");
});
