/*
 * v3 C2 — der ECHTE Leseweg: benannte Abfragen, Seiten, Sichtbarkeit.
 *
 * Lesen ist der stillere Teil des Risikos. Geprüft wird deshalb:
 *   • dass eine Route nur ihre eigenen Abfragen bedient,
 *   • dass ein Feld, das nicht in der Sichtliste steht, NICHT hinausgeht
 *     (der Prüfbestand enthält absichtlich einen Mailtext),
 *   • dass jede Folgeseite neu autorisiert wird und ein Cursor nicht auf einen
 *     anderen Scope umgebogen werden kann,
 *   • dass eine abgebrochene oder unbrauchbare Seite nie „vollständig" heisst,
 *   • und dass beim Lesen NICHTS geschrieben wird — auch nicht beim Start.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleReadRequest, ROUTE_QUERIES } from "../netlify/lib/quantus-v3-service.mjs";
import { mintJobToken, resolveAuthConfig } from "../netlify/lib/quantus-v3-auth.mjs";
import { VISIBLE_FIELDS } from "../netlify/lib/quantus-v3-read-helpers.mjs";
import {
  makeEnv, makeSigningKey, makeIdToken, keySourceFor, userLookupFor, TENANT,
} from "./fixtures/quantus-v3-auth-fixtures.mjs";
import {
  makeCoreSnapshot, makeStore, makeDomain, makeRateLimiter, makeRequest,
  RUN_ID, LEAD_ID,
} from "./fixtures/quantus-v3-c2-fixtures.mjs";

const key = makeSigningKey("c2-read-kid");
const JETZT = Date.parse("2026-09-20T09:00:00Z");
const now = () => JETZT;
const APP = "https://management-xo2-pro.netlify.app";
const env = makeEnv({ tenant: TENANT });

function nutzerToken({ sub = "uid-laurin" } = {}) {
  return makeIdToken({ key, sub, now: JETZT, tenant: TENANT });
}

function deps({ store = makeStore(), domain = makeDomain(), rateLimiter = makeRateLimiter() } = {}) {
  let n = 0;
  return {
    now, newRequestId: () => `r-${++n}`, env: env.read,
    keySource: keySourceFor(key), userLookup: userLookupFor({ tenantId: TENANT }),
    rateLimiter, store, domain,
  };
}

function leseAnfrage({ route = "quantus-context", query = "notes.recent", scopeId = LEAD_ID, pageSize = null, cursor = null, token = null, origin = APP, extra = {} } = {}) {
  const url = new URL(`https://management-xo2-pro.netlify.app/.netlify/functions/${route}`);
  if (query) url.searchParams.set("query", query);
  if (scopeId) url.searchParams.set("scopeId", scopeId);
  if (pageSize != null) url.searchParams.set("pageSize", String(pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const headers = { authorization: `Bearer ${token || nutzerToken()}` };
  if (origin) headers.origin = origin;
  return makeRequest({ method: "GET", url: url.toString(), headers });
}

test("eine Route bedient nur ihre eigenen Abfragen", async () => {
  const d = deps();
  const erlaubt = await handleReadRequest(leseAnfrage({ route: "quantus-context", query: "notes.recent" }), d, { route: "quantus-context" });
  assert.equal(erlaubt.status, 200, JSON.stringify(erlaubt.body));

  const fremd = await handleReadRequest(leseAnfrage({ route: "quantus-run-status", query: "notes.recent" }), d, { route: "quantus-run-status" });
  assert.equal(fremd.status, 403);
  assert.equal(fremd.body.reason, "query_not_allowed");

  const unbekannt = await handleReadRequest(leseAnfrage({ query: "alles" }), d, { route: "quantus-context" });
  assert.equal(unbekannt.status, 403);

  // Und die Zuordnung selbst ist eng.
  assert.deepEqual([...ROUTE_QUERIES["quantus-run-status"]], ["run.status", "run.queue"]);
});

test("die Seite zeigt nur Felder aus der Sichtliste — der Mailtext bleibt drin", async () => {
  const store = makeStore();
  const res = await handleReadRequest(leseAnfrage({ pageSize: 2 }), deps({ store }), { route: "quantus-context" });
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("Sehr geehrte Frau Muster"), "ein interner Mailtext ist nach aussen gegangen");
  assert.ok(!text.includes("internalMailBody"));
  for (const eintrag of res.body.items) {
    for (const feld of Object.keys(eintrag)) {
      assert.ok(VISIBLE_FIELDS.note.includes(feld), `Feld ${feld} steht nicht in der Sichtliste`);
    }
  }
  assert.ok(res.body.serverNow && res.body.requestId);
  assert.equal(res.body.dataRevision, 7);
  assert.equal(res.body.entityVersions.note_1, 2);
  assert.equal(res.body.hasMore, true);
  assert.equal(res.body.complete, false);
  assert.ok(res.body.cursor, "kein Folgecursor");
  assert.equal(store.spur.mutates, 0, "beim Lesen wurde geschrieben");
});

test("Folgeseite: der Cursor trägt, wird aber neu autorisiert", async () => {
  const domain = makeDomain();
  const d = deps({ domain });
  const erste = await handleReadRequest(leseAnfrage({ pageSize: 2 }), d, { route: "quantus-context" });
  const ladenNachErster = domain.spur.loads.length;

  const zweite = await handleReadRequest(leseAnfrage({ pageSize: 2, cursor: erste.body.cursor }), d, { route: "quantus-context" });
  assert.equal(zweite.status, 200, JSON.stringify(zweite.body));
  assert.equal(zweite.body.items[0].id, "note_3");
  assert.equal(zweite.body.hasMore, false);
  assert.equal(zweite.body.complete, true);
  assert.equal(zweite.body.cursor, null);
  assert.ok(domain.spur.loads.length > ladenNachErster, "die Folgeseite wurde nicht neu autorisiert");
});

test("ein Cursor lässt sich nicht auf einen anderen Scope umbiegen", async () => {
  const d = deps();
  const erste = await handleReadRequest(leseAnfrage({ pageSize: 2 }), d, { route: "quantus-context" });
  const cursor = erste.body.cursor;

  const andererScope = await handleReadRequest(
    leseAnfrage({ pageSize: 2, cursor, scopeId: "lead_fremd" }), d, { route: "quantus-context" });
  assert.equal(andererScope.status, 403);
  assert.ok(["cursor_scope_mismatch", "object_not_owned"].includes(andererScope.body.reason), andererScope.body.reason);

  const andereAbfrage = await handleReadRequest(
    leseAnfrage({ pageSize: 2, cursor, query: "lead.context" }), d, { route: "quantus-context" });
  assert.equal(andereAbfrage.status, 403);

  // Anderer Principal ⇒ fremder Cursor.
  const fremderNutzer = await handleReadRequest(
    leseAnfrage({ pageSize: 2, cursor, token: makeIdToken({ key, sub: "uid-fremd", now: JETZT, tenant: TENANT }) }),
    d, { route: "quantus-context" });
  assert.equal(fremderNutzer.status, 403);
});

test("Revisionswechsel entwertet den Cursor", async () => {
  const store = makeStore();
  const d = deps({ store });
  const erste = await handleReadRequest(leseAnfrage({ pageSize: 2 }), d, { route: "quantus-context" });

  store.snapshot.automation.dataRevision = 8;     // jemand hat geschrieben
  const zweite = await handleReadRequest(leseAnfrage({ pageSize: 2, cursor: erste.body.cursor }), d, { route: "quantus-context" });
  assert.equal(zweite.status, 403);
  assert.equal(zweite.body.reason, "cursor_revision_changed");
});

test("abgebrochene und unbrauchbare Seiten sind nie vollständig", async () => {
  const abgebrochen = makeDomain({ listResult: { items: [], hasMore: false, aborted: true, abortReason: "zeitbudget" } });
  const res = await handleReadRequest(leseAnfrage(), deps({ domain: abgebrochen }), { route: "quantus-context" });
  assert.equal(res.status, 200);
  assert.equal(res.body.complete, false, "eine abgebrochene Seite galt als vollständig");
  assert.equal(res.body.pageStatus, "aborted");
  assert.equal(res.body.cursor, null);

  // Ein Eintrag ohne Art und Id ist kein Datensatz: das ist ein Vertragsbruch
  // des Fachadapters, kein „unvollständige Seite" — 403, ohne Daten.
  const unbrauchbar = makeDomain({ listResult: { items: [{ text: "ohne Id" }], hasMore: false } });
  const res2 = await handleReadRequest(leseAnfrage(), deps({ domain: unbrauchbar }), { route: "quantus-context" });
  assert.equal(res2.status, 403);
  assert.equal(res2.body.reason, "item_kind_mismatch");

  // Und eine Lieferung, die gar keine Liste ist, ebenfalls.
  const keineListe = makeDomain({ listResult: { items: { error: "source-unavailable" }, hasMore: false } });
  const res3 = await handleReadRequest(leseAnfrage(), deps({ domain: keineListe }), { route: "quantus-context" });
  assert.equal(res3.status, 400);
  assert.equal(res3.body.reason, "items_not_a_list");
});

test("Spezialist: nur der Kontext seines Laufs", async () => {
  const { config } = resolveAuthConfig(env.read);
  const token = (await mintJobToken({
    config, audience: "quantus-context", jobId: RUN_ID, role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, now,
  })).token;
  // Die Einträge kommen aus dem autoritativen Bestand und tragen deshalb
  // Mandant und Auftragsbindung — ohne sie werden sie nicht ausgeliefert.
  const domain = makeDomain({ listResult: { items: [{
    kind: "run_context", id: "ctx_1", runId: RUN_ID, jobId: RUN_ID, tenant: TENANT,
    entityVersion: 1, title: "Kontext", text: "Inhalt",
  }], hasMore: false } });

  const eigener = await handleReadRequest(
    leseAnfrage({ query: "run.context", scopeId: RUN_ID, token, origin: null }),
    deps({ domain }), { route: "quantus-context" });
  assert.equal(eigener.status, 200, JSON.stringify(eigener.body));
  assert.equal(eigener.body.items[0].id, "ctx_1");

  // Ein Lead ist für ihn keine erlaubte Kategorie.
  const lead = await handleReadRequest(
    leseAnfrage({ query: "notes.recent", scopeId: LEAD_ID, token, origin: null }),
    deps({ domain }), { route: "quantus-context" });
  assert.equal(lead.status, 403);

  // Und ein fremder Lauf schon gar nicht: das Token gilt nur für seinen.
  const fremderLauf = await handleReadRequest(
    leseAnfrage({ query: "run.context", scopeId: "job_20260920_99", token, origin: null }),
    deps({ domain }), { route: "quantus-context" });
  assert.equal(fremderLauf.status, 403);
});

test("Seitengrösse, Scope-Form und fehlende Adapter", async () => {
  const d = deps();
  const zuGross = await handleReadRequest(leseAnfrage({ pageSize: 500 }), d, { route: "quantus-context" });
  assert.equal(zuGross.status, 400);
  assert.equal(zuGross.body.reason, "page_size_out_of_bounds");

  for (const scopeId of ["appStore/app-data_json", "lead..1", "attachment-text__a", ""]) {
    const res = await handleReadRequest(leseAnfrage({ scopeId }), d, { route: "quantus-context" });
    assert.equal(res.status, 400, `scopeId "${scopeId}" wurde akzeptiert`);
  }

  const ohneDomaene = await handleReadRequest(leseAnfrage(), deps({ domain: null }), { route: "quantus-context" });
  assert.equal(ohneDomaene.status, 503);
  assert.equal(ohneDomaene.body.reason, "domain_adapter_not_available");

  const ohneSpeicher = await handleReadRequest(leseAnfrage(), deps({ store: null }), { route: "quantus-context" });
  assert.equal(ohneSpeicher.status, 503);
});

test("ohne Ausweis wird nicht gelesen", async () => {
  const store = makeStore();
  const url = new URL("https://management-xo2-pro.netlify.app/.netlify/functions/quantus-context?query=notes.recent&scopeId=" + LEAD_ID);
  const res = await handleReadRequest(makeRequest({ method: "GET", url: url.toString(), headers: { origin: APP } }),
    deps({ store }), { route: "quantus-context" });
  assert.equal(res.status, 401);
  assert.equal(store.spur.reads, 0, "ein ungeprüfter Aufrufer hat den Kern gelesen");
});

test("fremder Lead: 403, auch lesend", async () => {
  const res = await handleReadRequest(leseAnfrage({ scopeId: "lead_fremd" }), deps(), { route: "quantus-context" });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "object_not_owned");
});
