/*
 * v3 C1 — signierte, seitenweise Kontextcursor.
 *
 * BEFUND, aus dem diese Tests folgen: Ein Cursor ist die Stelle, an der ein
 * Aufrufer sich mehr nehmen kann, als die erste Seite ihm gab. Ist er ein
 * blosser Zeiger („weiter ab Schlüssel X"), lässt sich X austauschen — und aus
 * „Kontext zu Job 1" wird „Kontext zu Job 2", ohne dass je eine Rechteprüfung
 * widerspricht. Genau dieselbe Klasse Fehler steckte in der Blob-Fassade, bis
 * die Schlüsselpolitik kam: ein beliebiger Schlüssel aus der URL wurde zum
 * Knotennamen.
 *
 * Deshalb wird hier geprüft, dass der Cursor GEBUNDEN ist: Principal, Mandant,
 * benannte Abfrage, Objektscope, Policy-Version, Datenrevision, Ablauf — und
 * dass er weder Mailtext noch Firebase-Pfade transportieren kann.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCursorConfig, signCursor, verifyCursor, describePage,
  assertScopeId, NAMED_QUERIES, CURSOR_FIELDS, MAX_PAGE_INDEX,
  MAX_CURSOR_LIFETIME_SECONDS,
} from "../netlify/lib/quantus-v3-cursor.mjs";
import { makeEnv, TENANT, POLICY_VERSION, randomSecret } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const env = makeEnv({ tenant: TENANT });
const { config } = resolveCursorConfig(env.read);
const JETZT = Date.parse("2026-09-19T10:00:00Z");
const now = () => JETZT;

const claude = { kind: "worker", id: "claude-spezialist", role: "specialist_claude", tenant: TENANT, jobId: "job-1" };
const nutzer = { kind: "user", id: "uid-laurin", role: "user", tenant: TENANT };

const REVISION = "rev-2026-09-19T09:58:00Z";

function cursor(over = {}) {
  const res = signCursor({
    config, principal: claude, query: "job.context", scopeId: "job-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, pageSize: 25, pageIndex: 0, now, ...over,
  });
  assert.equal(res.ok, true, `Ausstellen fehlgeschlagen: ${res.reason}`);
  return res.cursor;
}

function pruefe(c, over = {}) {
  return verifyCursor(c, {
    config, principal: claude, policyVersion: POLICY_VERSION, dataRevision: REVISION, now, ...over,
  });
}

test("ein gültiger Cursor beschreibt genau eine erlaubte Seite", () => {
  const res = pruefe(cursor({ pageIndex: 2, afterId: "eintrag-42" }));
  assert.equal(res.ok, true);
  assert.equal(res.page.query, "job.context");
  assert.equal(res.page.dataCategory, "job_context");
  assert.equal(res.page.scopeId, "job-1");
  assert.equal(res.page.pageIndex, 2);
  assert.equal(res.page.afterId, "eintrag-42");
});

test("manipulierter Cursor ⇒ 403 (echte Signaturprüfung)", () => {
  const c = cursor();
  const [prefix, kid, payloadB64, sig] = c.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

  for (const verbogen of [
    { ...payload, scopeId: "job-2" },                 // fremder Vorgang
    { ...payload, principal: "uid-laurin" },          // fremder Principal
    { ...payload, tenant: "anderer-haushalt" },       // fremder Mandant
    { ...payload, query: "lead.context" },            // andere Abfrage
    { ...payload, pageSize: 10_000 },                 // grössere Seite
    { ...payload, exp: payload.exp + 86_400 },        // längeres Leben
    { ...payload, dataRevision: "rev-egal" },         // anderer Datenstand
  ]) {
    const neu = Buffer.from(JSON.stringify(verbogen), "utf8").toString("base64url");
    const res = pruefe(`${prefix}.${kid}.${neu}.${sig}`);
    assert.equal(res.ok, false, `${JSON.stringify(verbogen).slice(0, 40)}… akzeptiert`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "cursor_signature_invalid");
  }

  // Auch eine abgeschnittene oder umgebaute Form kommt nicht durch.
  for (const kaputt of ["", "abc", "qv3c1.c1", `${prefix}.${kid}.${payloadB64}`, `fremd.${kid}.${payloadB64}.${sig}`]) {
    assert.equal(pruefe(kaputt).ok, false, `"${kaputt}" akzeptiert`);
  }
});

test("fremder Cursor: anderer Principal, andere Art, anderer Mandant", () => {
  const c = cursor();
  assert.equal(pruefe(c, { principal: { ...claude, id: "gemini-spezialist" } }).reason, "cursor_principal_mismatch");
  assert.equal(pruefe(c, { principal: { ...claude, kind: "user" } }).reason, "cursor_principal_mismatch");
  assert.equal(pruefe(c, { principal: { ...claude, tenant: "anderer-haushalt" } }).reason, "cursor_tenant_mismatch");
  assert.equal(pruefe(c, { principal: null }).reason, "principal_missing");

  // Der Cursor des Nutzers ist nicht der Cursor des Spezialisten.
  const nutzerCursor = cursor({ principal: nutzer, query: "job.queue", scopeId: "alle" });
  assert.equal(pruefe(nutzerCursor).ok, false);
  assert.equal(verifyCursor(nutzerCursor, {
    config, principal: nutzer, policyVersion: POLICY_VERSION, dataRevision: REVISION, now,
  }).ok, true);
});

test("Ablauf: ein abgelaufener Cursor ist kein Cursor", () => {
  const c = cursor({ lifetimeSeconds: 300 });
  assert.equal(pruefe(c, { now: () => JETZT + 299_000 }).ok, true);
  const res = pruefe(c, { now: () => JETZT + 301_000 });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "cursor_expired");

  assert.equal(signCursor({ config, principal: claude, query: "job.context", scopeId: "job-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION,
    lifetimeSeconds: MAX_CURSOR_LIFETIME_SECONDS + 1, now }).reason, "cursor_lifetime_invalid");
});

test("Versionswechsel: neue Policy oder neue Datenrevision entwerten den Cursor", () => {
  const c = cursor();
  const policy = pruefe(c, { policyVersion: "v3-2026-10-01" });
  assert.equal(policy.status, 403);
  assert.equal(policy.reason, "cursor_policy_changed");

  const revision = pruefe(c, { dataRevision: "rev-2026-09-19T10:05:00Z" });
  assert.equal(revision.status, 403);
  assert.equal(revision.reason, "cursor_revision_changed");

  // Ohne Angabe wird nicht wohlwollend geprüft.
  assert.equal(pruefe(c, { dataRevision: "" }).reason, "cursor_revision_changed");
  assert.equal(pruefe(c, { policyVersion: undefined }).reason, "cursor_policy_changed");
});

test("Schlüsselrotation: auslaufender Schlüssel gilt, zurückgezogener nicht", () => {
  const schluessel = JSON.parse(env.vars.QUANTUS_V3_CURSOR_KEYS);
  // Ein Cursor, der noch mit dem auslaufenden Schlüssel signiert wurde.
  const altConfig = resolveCursorConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_CURSOR_KEYS: JSON.stringify([{ ...schluessel[1], status: "active" }]) },
  }).read).config;
  const altCursor = signCursor({ config: altConfig, principal: claude, query: "job.context", scopeId: "job-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, now }).cursor;
  assert.equal(pruefe(altCursor).ok, true, "während der Rotation muss der alte Cursor noch gelten");
  assert.equal(cursor().split(".")[1], "c1", "ausgestellt wird mit dem aktiven Schlüssel");

  // Zurückgezogen ⇒ sofort ungültig.
  const widerrufen = resolveCursorConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_CURSOR_KEYS: JSON.stringify([
        { ...schluessel[1], status: "revoked" },
        { kid: "c2", secret: randomSecret(), status: "active" },
      ]),
    },
  }).read).config;
  assert.equal(verifyCursor(altCursor, { config: widerrufen, principal: claude,
    policyVersion: POLICY_VERSION, dataRevision: REVISION, now }).reason, "cursor_key_revoked");

  // Unbekannte kid (etwa nach vollständigem Austausch) ⇒ 403, nicht 500.
  const ganzNeu = resolveCursorConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_CURSOR_KEYS: JSON.stringify([{ kid: "c9", secret: randomSecret(), status: "active" }]) },
  }).read).config;
  assert.equal(verifyCursor(cursor(), { config: ganzNeu, principal: claude,
    policyVersion: POLICY_VERSION, dataRevision: REVISION, now }).reason, "cursor_unknown_key");

  // Ohne Schlüssel gar nichts.
  assert.equal(verifyCursor(cursor(), { principal: claude }).status, 503);
  assert.equal(signCursor({ principal: claude, query: "job.context", scopeId: "job-1" }).status, 503);
});

test("keine beliebigen Pfade, keine Blob-Keys, keine fremden Abfragen", () => {
  for (const scopeId of [
    "appStore/app-data_json", "../../etc/passwd", "app-data.json", "job 1", "job#1",
    "attachment-text__a__b__c", "", "x".repeat(200), "job/1",
  ]) {
    const res = signCursor({ config, principal: claude, query: "job.context", scopeId,
      dataRevision: REVISION, policyVersion: POLICY_VERSION, now });
    assert.equal(res.ok, false, `scopeId "${scopeId}" wurde akzeptiert`);
    assert.equal(res.status, 400);
  }
  assert.equal(assertScopeId("job-1").ok, true);

  for (const query of ["alles", "firebase:appStore", "", "job.context.extra", "__proto__", "constructor"]) {
    const res = signCursor({ config, principal: claude, query, scopeId: "job-1",
      dataRevision: REVISION, policyVersion: POLICY_VERSION, now });
    assert.equal(res.ok, false, `Abfrage "${query}" wurde akzeptiert`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "query_not_allowed");
  }
});

test("Bounds: Seitengrösse und Seitenzahl sind begrenzt", () => {
  for (const pageSize of [0, -1, 1.5, 51, 10_000, "25"]) {
    assert.equal(signCursor({ config, principal: claude, query: "job.context", scopeId: "job-1",
      dataRevision: REVISION, policyVersion: POLICY_VERSION, pageSize, now }).reason, "page_size_out_of_bounds");
  }
  // job.queue erlaubt grössere Seiten als job.context — die Grenze hängt an
  // der Abfrage, nicht am Aufrufer.
  assert.equal(signCursor({ config, principal: claude, query: "job.queue", scopeId: "alle",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, pageSize: 100, now }).ok, true);
  assert.equal(NAMED_QUERIES["job.context"].maxPageSize, 50);

  for (const pageIndex of [-1, 1.5, MAX_PAGE_INDEX + 1]) {
    assert.equal(signCursor({ config, principal: claude, query: "job.context", scopeId: "job-1",
      dataRevision: REVISION, policyVersion: POLICY_VERSION, pageIndex, now }).reason, "page_index_out_of_bounds");
  }
});

test("der Cursor transportiert keinen Inhalt — die Feldliste ist abgeschlossen", () => {
  const res = signCursor({
    config, principal: claude, query: "job.context", scopeId: "job-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, now,
    extra: { mailText: "Sehr geehrte Frau Muster, anbei die Offerte …" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "cursor_field_not_allowed");

  // Was tatsächlich drinsteht: genau die erlaubten Felder, kein Freitext.
  const payload = JSON.parse(Buffer.from(cursor().split(".")[2], "base64url").toString("utf8"));
  for (const k of Object.keys(payload)) assert.ok(CURSOR_FIELDS.includes(k), `Feld ${k} gehört nicht in den Cursor`);
  const text = JSON.stringify(payload);
  for (const geheim of [...Object.values(env.secrets.cursor), ...Object.values(env.secrets.service)]) {
    assert.ok(!text.includes(geheim), "ein Schlüssel steckt im Cursor");
  }
  assert.ok(!/@|Sehr geehrte|BEGIN|sk-/.test(text), "der Cursor trägt Inhalt");

  // Ein von Hand um ein Feld erweiterter Cursor scheitert doppelt: Signatur
  // und Feldliste.
  const [prefix, kid, , sig] = cursor().split(".");
  const erweitert = Buffer.from(JSON.stringify({ ...payload, mailText: "geheim" }), "utf8").toString("base64url");
  assert.equal(pruefe(`${prefix}.${kid}.${erweitert}.${sig}`).ok, false);
});

test("eine abgebrochene Seite ist keine Vollständigkeitsgarantie", () => {
  const fertig = describePage({ items: [1, 2] });
  assert.equal(fertig.complete, true);
  assert.equal(fertig.status, "done");
  assert.equal(fertig.nextCursor, null);

  const weiter = describePage({ items: [1, 2], hasMore: true, nextCursor: cursor({ pageIndex: 1 }) });
  assert.equal(weiter.complete, false);
  assert.equal(weiter.status, "more");
  assert.ok(weiter.nextCursor);

  const abbruch = describePage({ items: [1], aborted: true, abortReason: "zeitbudget" });
  assert.equal(abbruch.complete, false);
  assert.equal(abbruch.status, "aborted");
  assert.equal(abbruch.reason, "zeitbudget");
  assert.equal(abbruch.nextCursor, null, "nach einem Abbruch gibt es keine verlässliche Position");
  assert.match(abbruch.note, /kein Beweis/);

  // „Es gibt mehr" ohne Cursor ist ebenfalls ein Abbruch, nicht „fertig".
  const halb = describePage({ items: [1], hasMore: true });
  assert.equal(halb.complete, false);
  assert.equal(halb.status, "aborted");
  assert.equal(halb.reason, "next_cursor_missing");
});
