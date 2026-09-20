/*
 * v3 C1 — signierte, seitenweise Kontextcursor.
 *
 * BEFUND: Ein Cursor ist die Stelle, an der ein Aufrufer sich mehr nehmen
 * kann, als die erste Seite ihm gab. Ist er ein blosser Zeiger („weiter ab
 * Schlüssel X"), lässt sich X austauschen.
 *
 * REVIEW-BEFUND (5ac0bf7): Der Cursor wurde gegen SICH SELBST geprüft — ein
 * Cursor auf `lead-1` kam auch dann durch, wenn der Aufruf `lead-2` lesen
 * wollte. Jetzt sind die erwartete Abfrage, Scope-Art und Scope-Id PFLICHT,
 * das serverseitig geladene Scope-Objekt muss dazu passen, und jede Seite
 * wird über `authorize()` neu autorisiert.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  resolveCursorConfig, signCursor, verifyCursor, describePage,
  assertScopeId, NAMED_QUERIES, CURSOR_FIELDS, MAX_PAGE_INDEX,
  MAX_CURSOR_LIFETIME_SECONDS, CURSOR_ISSUER, CURSOR_TYP,
} from "../netlify/lib/quantus-v3-cursor.mjs";
import { resolveAuthConfig, ISSUERS } from "../netlify/lib/quantus-v3-auth.mjs";
import { makeEnv, TENANT, POLICY_VERSION, randomSecret } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const env = makeEnv({ tenant: TENANT });
const { config } = resolveCursorConfig(env.read);
const { config: authConfig } = resolveAuthConfig(env.read);
const JETZT = Date.parse("2026-09-19T10:00:00Z");
const now = () => JETZT;

const claude = { kind: "worker", issuedBy: ISSUERS.jobToken, id: "claude-spezialist", role: "specialist_claude", tenant: TENANT, jobId: "run-1" };
const nutzer = { kind: "user", issuedBy: ISSUERS.firebase, id: "uid-laurin", role: "user", tenant: TENANT };

const REVISION = 41;   // eine Revision ist eine Zahl, nicht eine Zeichenkette

/* Der serverseitig geladene Scope-Datensatz, den jede Seite neu autorisiert. */
const runKontext = (over = {}) => ({ kind: "run_context", id: "run-1", tenant: TENANT, jobId: "run-1", ...over });

async function cursor(over = {}) {
  const res = await signCursor({
    config, principal: claude, query: "run.context", scopeId: "run-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, pageSize: 25, pageIndex: 0, now, ...over,
  });
  assert.equal(res.ok, true, `Ausstellen fehlgeschlagen: ${res.reason}`);
  return res.cursor;
}

const pruefe = (c, over = {}) => verifyCursor(c, {
  config, authConfig, principal: claude,
  expectedQuery: "run.context", expectedScopeKind: "run", expectedScopeId: "run-1",
  policyVersion: POLICY_VERSION, dataRevision: REVISION, scopeObject: runKontext(), now, ...over,
});

test("ein gültiger Cursor beschreibt genau eine erlaubte Seite", async () => {
  const res = await pruefe(await cursor({ pageIndex: 2, afterId: "eintrag-42" }));
  assert.equal(res.ok, true);
  assert.equal(res.page.query, "run.context");
  assert.equal(res.page.dataCategory, "run_context");
  assert.equal(res.page.scopeId, "run-1");
  assert.equal(res.page.pageIndex, 2);
  assert.equal(res.page.afterId, "eintrag-42");
});

test("der Cursor ist ein JWT mit eigenem Aussteller und eigenem typ", async () => {
  const c = await cursor();
  const kopf = JSON.parse(Buffer.from(c.split(".")[0], "base64url").toString("utf8"));
  assert.equal(kopf.alg, "HS256");
  assert.equal(kopf.typ, CURSOR_TYP);
  const koerper = JSON.parse(Buffer.from(c.split(".")[1], "base64url").toString("utf8"));
  assert.equal(koerper.iss, CURSOR_ISSUER);
  assert.equal(koerper.aud, `${CURSOR_ISSUER}#run.context`);

  // Ein Job-Token-Schlüssel signiert keinen Cursor: getrennte Schlüsselsätze.
  const jobSecret = JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret;
  const nowSec = Math.floor(JETZT / 1000);
  const fremd = await new SignJWT({
    principalKind: claude.kind, tenant: TENANT, query: "run.context", scopeKind: "run",
    scopeId: "run-1", policyVersion: POLICY_VERSION, dataRevision: REVISION, pageSize: 25, pageIndex: 0, afterId: null,
  })
    .setProtectedHeader({ alg: "HS256", kid: "c1", typ: CURSOR_TYP })
    .setIssuer(CURSOR_ISSUER).setAudience(`${CURSOR_ISSUER}#run.context`).setSubject(claude.id)
    .setIssuedAt(nowSec).setExpirationTime(nowSec + 300)
    .sign(new TextEncoder().encode(jobSecret));
  assert.equal((await pruefe(fremd)).reason, "cursor_signature_invalid");
});

test("manipulierter Cursor ⇒ 403 (echte Signaturprüfung)", async () => {
  const c = await cursor();
  const [kopf, koerperB64, sig] = c.split(".");
  const koerper = JSON.parse(Buffer.from(koerperB64, "base64url").toString("utf8"));

  for (const verbogen of [
    { ...koerper, scopeId: "run-2" },
    { ...koerper, sub: "uid-laurin" },
    { ...koerper, tenant: "anderer-haushalt" },
    { ...koerper, query: "lead.context" },
    { ...koerper, pageSize: 10_000 },
    { ...koerper, exp: koerper.exp + 86_400 },
    { ...koerper, dataRevision: 999 },
  ]) {
    const neu = Buffer.from(JSON.stringify(verbogen), "utf8").toString("base64url");
    const res = await pruefe(`${kopf}.${neu}.${sig}`);
    assert.equal(res.ok, false, `${JSON.stringify(verbogen).slice(0, 40)}… akzeptiert`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "cursor_signature_invalid");
  }

  for (const kaputt of ["", "abc", "a.b", `${kopf}.${koerperB64}`, `${kopf}.${koerperB64}.`]) {
    assert.equal((await pruefe(kaputt)).ok, false, `"${kaputt}" akzeptiert`);
  }
});

test("fremder Cursor: anderer Principal, andere Art, anderer Mandant", async () => {
  const c = await cursor();
  assert.equal((await pruefe(c, { principal: { ...claude, id: "gemini-spezialist" } })).reason, "cursor_principal_mismatch");
  assert.equal((await pruefe(c, { principal: { ...claude, kind: "user" } })).reason, "cursor_principal_mismatch");
  assert.equal((await pruefe(c, { principal: { ...claude, tenant: "anderer-haushalt" } })).reason, "cursor_tenant_mismatch");
  assert.equal((await pruefe(c, { principal: null })).reason, "principal_missing");
});

test("Ablauf: ein abgelaufener Cursor ist kein Cursor", async () => {
  const c = await cursor({ lifetimeSeconds: 300 });
  assert.equal((await pruefe(c, { now: () => JETZT + 299_000 })).ok, true);
  const res = await pruefe(c, { now: () => JETZT + 301_000 });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "cursor_expired");

  assert.equal((await signCursor({ config, principal: claude, query: "run.context", scopeId: "run-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION,
    lifetimeSeconds: MAX_CURSOR_LIFETIME_SECONDS + 1, now })).reason, "cursor_lifetime_invalid");
});

test("Versionswechsel: neue Policy oder neue Datenrevision entwerten den Cursor", async () => {
  const c = await cursor();
  const policy = await pruefe(c, { policyVersion: "v3-2026-10-01" });
  assert.equal(policy.status, 403);
  assert.equal(policy.reason, "cursor_policy_changed");

  const revision = await pruefe(c, { dataRevision: 42 });
  assert.equal(revision.status, 403);
  assert.equal(revision.reason, "cursor_revision_changed");

  // Ohne Angabe wird nicht wohlwollend geprüft, sondern gesperrt.
  assert.equal((await pruefe(c, { dataRevision: "" })).reason, "data_revision_invalid");
  assert.equal((await pruefe(c, { policyVersion: undefined })).reason, "policy_version_missing");
});

test("Schlüsselrotation: auslaufender Schlüssel gilt, zurückgezogener nicht", async () => {
  const schluessel = JSON.parse(env.vars.QUANTUS_V3_CURSOR_KEYS);
  const altConfig = resolveCursorConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_CURSOR_KEYS: JSON.stringify([{ ...schluessel[1], status: "active" }]) },
  }).read).config;
  const altCursor = (await signCursor({ config: altConfig, principal: claude, query: "run.context", scopeId: "run-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, now })).cursor;
  assert.equal((await pruefe(altCursor)).ok, true, "während der Rotation muss der alte Cursor noch gelten");

  const widerrufen = resolveCursorConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_CURSOR_KEYS: JSON.stringify([
        { ...schluessel[1], status: "revoked" },
        { kid: "c2", secret: randomSecret(), status: "active" },
      ]),
    },
  }).read).config;
  assert.equal((await pruefe(altCursor, { config: widerrufen })).reason, "cursor_key_revoked");

  const ganzNeu = resolveCursorConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_CURSOR_KEYS: JSON.stringify([{ kid: "c9", secret: randomSecret(), status: "active" }]) },
  }).read).config;
  assert.equal((await pruefe(await cursor(), { config: ganzNeu })).reason, "cursor_unknown_key");

  assert.equal((await verifyCursor(await cursor(), { principal: claude })).status, 503);
  assert.equal((await signCursor({ principal: claude, query: "run.context", scopeId: "run-1" })).status, 503);
});

test("keine beliebigen Pfade, keine Blob-Keys, keine fremden Abfragen", async () => {
  for (const scopeId of [
    "appStore/app-data_json", "../../etc/passwd", "app-data.json", "run 1", "run#1",
    "attachment-text__a__b__c", "", "x".repeat(200), "run/1",
  ]) {
    const res = await signCursor({ config, principal: claude, query: "run.context", scopeId,
      dataRevision: REVISION, policyVersion: POLICY_VERSION, now });
    assert.equal(res.ok, false, `scopeId "${scopeId}" wurde akzeptiert`);
    assert.equal(res.status, 400);
  }
  assert.equal(assertScopeId("run-1").ok, true);

  for (const query of ["alles", "firebase:appStore", "", "run.context.extra", "__proto__", "constructor", "job.context"]) {
    const res = await signCursor({ config, principal: claude, query, scopeId: "run-1",
      dataRevision: REVISION, policyVersion: POLICY_VERSION, now });
    assert.equal(res.ok, false, `Abfrage "${query}" wurde akzeptiert`);
    assert.equal(res.reason, "query_not_allowed");
  }
});

test("Bounds: Seitengrösse und Seitenzahl sind begrenzt", async () => {
  for (const pageSize of [0, -1, 1.5, 51, 10_000, "25", true]) {
    assert.equal((await signCursor({ config, principal: claude, query: "run.context", scopeId: "run-1",
      dataRevision: REVISION, policyVersion: POLICY_VERSION, pageSize, now })).reason, "page_size_out_of_bounds");
  }
  assert.equal((await signCursor({ config, principal: nutzer, query: "run.queue", scopeId: "alle",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, pageSize: 100, now })).ok, true);
  assert.equal(NAMED_QUERIES["run.context"].maxPageSize, 50);

  for (const pageIndex of [-1, 1.5, MAX_PAGE_INDEX + 1, "0"]) {
    assert.equal((await signCursor({ config, principal: claude, query: "run.context", scopeId: "run-1",
      dataRevision: REVISION, policyVersion: POLICY_VERSION, pageIndex, now })).reason, "page_index_out_of_bounds");
  }
});

test("der Cursor transportiert keinen Inhalt — die Feldliste ist abgeschlossen", async () => {
  const res = await signCursor({
    config, principal: claude, query: "run.context", scopeId: "run-1",
    dataRevision: REVISION, policyVersion: POLICY_VERSION, now,
    extra: { mailText: "Sehr geehrte Frau Muster, anbei die Offerte …" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "cursor_field_not_allowed");

  const payload = JSON.parse(Buffer.from((await cursor()).split(".")[1], "base64url").toString("utf8"));
  const erlaubt = [...CURSOR_FIELDS, "iss", "sub", "aud", "iat", "exp", "jti", "nbf"];
  for (const k of Object.keys(payload)) assert.ok(erlaubt.includes(k), `Feld ${k} gehört nicht in den Cursor`);
  const text = JSON.stringify(payload);
  for (const geheim of [...Object.values(env.secrets.cursor), ...Object.values(env.secrets.service)]) {
    assert.ok(!text.includes(geheim), "ein Schlüssel steckt im Cursor");
  }
  assert.ok(!/Sehr geehrte|BEGIN|sk-/.test(text), "der Cursor trägt Inhalt");

  // Ein echt signierter Cursor MIT Zusatzfeld wird ebenfalls abgewiesen.
  const cursorSecret = JSON.parse(env.vars.QUANTUS_V3_CURSOR_KEYS)[0].secret;
  const nowSec = Math.floor(JETZT / 1000);
  const mitFeld = await new SignJWT({ ...payload, mailText: "geheim", iss: undefined, aud: undefined, sub: undefined, iat: undefined, exp: undefined })
    .setProtectedHeader({ alg: "HS256", kid: "c1", typ: CURSOR_TYP })
    .setIssuer(CURSOR_ISSUER).setAudience(`${CURSOR_ISSUER}#run.context`).setSubject(claude.id)
    .setIssuedAt(nowSec).setExpirationTime(nowSec + 300)
    .sign(new TextEncoder().encode(cursorSecret));
  assert.equal((await pruefe(mitFeld)).reason, "cursor_field_not_allowed");
});

test("eine abgebrochene oder unbrauchbare Seite ist keine Vollständigkeit", async () => {
  const fertig = describePage({ items: [{ id: 1 }, { id: 2 }], hasMore: false });
  assert.equal(fertig.complete, true);
  assert.equal(fertig.status, "done");
  assert.equal(fertig.nextCursor, null);

  const weiter = describePage({ items: [{ id: 1 }], hasMore: true, nextCursor: await cursor({ pageIndex: 1 }) });
  assert.equal(weiter.complete, false);
  assert.equal(weiter.status, "more");
  assert.ok(weiter.nextCursor);

  const abbruch = describePage({ items: [{ id: 1 }], hasMore: false, aborted: true, abortReason: "zeitbudget" });
  assert.equal(abbruch.complete, false);
  assert.equal(abbruch.status, "aborted");
  assert.equal(abbruch.reason, "zeitbudget");
  assert.equal(abbruch.nextCursor, null);

  const halb = describePage({ items: [{ id: 1 }], hasMore: true });
  assert.equal(halb.complete, false);
  assert.equal(halb.reason, "next_cursor_missing");
});
