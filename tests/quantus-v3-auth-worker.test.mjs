/*
 * v3 C1 — Worker-Token: kurzlebige, audience- und auftragsgebundene JWT.
 *
 * BEFUND: Ein Spezialist bekommt einen Auftrag und dazu ein Token. Ist dieses
 * Token nicht an GENAU DIESEN Auftrag gebunden, ist es ein Generalschlüssel
 * für die Dauer seiner Gültigkeit — und der Auftragstext, der durch dieselbe
 * Leitung kommt, kann behaupten, was er will.
 *
 * REVIEW-BEFUND (5ac0bf7): (a) Das erste Format war ein Eigenbau; jetzt sind
 * es JWT über `jose` mit fester Algorithmenliste, festem Aussteller und
 * `typ`. (b) `mintJobToken` stellte auch backend_checker aus — damit hätte ein
 * kurzlebiges Auftragstoken Abschlussrechte gehabt. Jetzt sind Scheduler- und
 * Backend-Rollen hier gar nicht ausstellbar.
 *
 * Alle Schlüssel entstehen zur Laufzeit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  resolveAuthConfig, mintJobToken, verifyJobToken, authorize,
  MAX_JOB_TOKEN_LIFETIME_SECONDS, JOB_TOKEN_ISSUER, JOB_TOKEN_TYP, ISSUERS,
} from "../netlify/lib/quantus-v3-auth.mjs";
import { makeEnv, TENANT, POLICY_VERSION, randomSecret } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const env = makeEnv({ tenant: TENANT });
const { config } = resolveAuthConfig(env.read);
const JETZT = Date.parse("2026-09-19T10:00:00Z");
const now = () => JETZT;

async function token(over = {}) {
  const res = await mintJobToken({
    config, audience: "quantus-ingest", jobId: "job-1", role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, lifetimeSeconds: 300, now, ...over,
  });
  assert.equal(res.ok, true, `Ausstellen fehlgeschlagen: ${res.reason}`);
  return res.token;
}

const pruefe = (t, over = {}) => verifyJobToken(t, {
  config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now, ...over,
});

test("gültiges Job-Token ⇒ Principal mit genau dieser Auftragsbindung", async () => {
  const res = await pruefe(await token());
  assert.equal(res.ok, true);
  assert.equal(res.principal.kind, "worker");
  assert.equal(res.principal.issuedBy, ISSUERS.jobToken);
  assert.equal(res.principal.role, "specialist_claude");
  assert.equal(res.principal.jobId, "job-1");
  assert.equal(res.principal.tenant, TENANT);
  assert.ok(res.principal.jti);
});

test("es ist ein JWT mit fester Algorithmenliste, Aussteller und typ", async () => {
  const t = await token();
  const kopf = JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8"));
  assert.equal(kopf.alg, "HS256");
  assert.equal(kopf.typ, JOB_TOKEN_TYP);
  assert.equal(kopf.kid, "w1");
  const koerper = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
  assert.equal(koerper.iss, JOB_TOKEN_ISSUER);
  assert.equal(koerper.aud, "quantus-ingest");
  assert.equal(koerper.sub, "claude-spezialist");

  // Ein Token mit anderem Aussteller oder anderem typ wird nicht anerkannt —
  // selbst wenn es mit UNSEREM Schlüssel signiert ist.
  const schluessel = new TextEncoder().encode(JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret);
  const nowSec = Math.floor(JETZT / 1000);
  const fremderAussteller = await new SignJWT({ job: "job-1", role: "specialist_claude", tenant: TENANT, policyVersion: POLICY_VERSION })
    .setProtectedHeader({ alg: "HS256", kid: "w1", typ: JOB_TOKEN_TYP })
    .setIssuer("irgendwer").setAudience("quantus-ingest").setSubject("claude-spezialist")
    .setIssuedAt(nowSec).setExpirationTime(nowSec + 300).setJti("x").sign(schluessel);
  assert.equal((await pruefe(fremderAussteller)).ok, false);

  const falscherTyp = await new SignJWT({ job: "job-1", role: "specialist_claude", tenant: TENANT, policyVersion: POLICY_VERSION })
    .setProtectedHeader({ alg: "HS256", kid: "w1", typ: "JWT" })
    .setIssuer(JOB_TOKEN_ISSUER).setAudience("quantus-ingest").setSubject("claude-spezialist")
    .setIssuedAt(nowSec).setExpirationTime(nowSec + 300).setJti("x").sign(schluessel);
  assert.equal((await pruefe(falscherTyp)).reason, "token_typ_mismatch");
});

test("verbogener Nutzinhalt ⇒ 401 (echte Signaturprüfung)", async () => {
  const t = await token();
  const [kopf, koerperB64, sig] = t.split(".");
  const koerper = JSON.parse(Buffer.from(koerperB64, "base64url").toString("utf8"));

  for (const verbogen of [
    { ...koerper, role: "backend_checker" },
    { ...koerper, job: "job-2" },
    { ...koerper, tenant: "anderer-haushalt" },
    { ...koerper, exp: koerper.exp + 86400 },
    { ...koerper, aud: "quantus-read" },
    { ...koerper, sub: "jemand-anderes" },
  ]) {
    const neu = Buffer.from(JSON.stringify(verbogen), "utf8").toString("base64url");
    const res = await pruefe(`${kopf}.${neu}.${sig}`);
    assert.equal(res.status, 401, `${JSON.stringify(verbogen).slice(0, 40)}… akzeptiert`);
    assert.equal(res.reason, "token_signature_invalid");
  }
});

test("fremder Schlüssel, unbekannte kid, zurückgezogener Schlüssel", async () => {
  const fremd = makeEnv({ tenant: TENANT });
  const fremdConfig = resolveAuthConfig(fremd.read).config;
  const fremdToken = (await mintJobToken({
    config: fremdConfig, audience: "quantus-ingest", jobId: "job-1", role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, now,
  })).token;
  assert.equal((await pruefe(fremdToken)).reason, "token_signature_invalid");

  const t = await token();
  const [kopfB64, rest, sig] = t.split(".");
  const kopf = JSON.parse(Buffer.from(kopfB64, "base64url").toString("utf8"));
  const andereKid = Buffer.from(JSON.stringify({ ...kopf, kid: "unbekannt" }), "utf8").toString("base64url");
  assert.equal((await pruefe(`${andereKid}.${rest}.${sig}`)).reason, "token_unknown_key");

  const widerrufen = resolveAuthConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([
        { kid: "w1", secret: JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret, status: "revoked" },
        { kid: "w2", secret: randomSecret(), status: "active" },
      ]),
    },
  }).read).config;
  assert.equal((await pruefe(t, { config: widerrufen })).reason, "token_key_revoked");
});

test("Ablauf: abgelaufen ist abgelaufen, und lange Laufzeiten entstehen nicht", async () => {
  const t = await token({ lifetimeSeconds: 300 });
  const res = await pruefe(t, { now: () => JETZT + 301_000 });
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_expired");

  const zuLang = await mintJobToken({
    config, audience: "quantus-ingest", jobId: "job-1", role: "specialist_claude",
    principalId: "c", tenant: TENANT, lifetimeSeconds: MAX_JOB_TOKEN_LIFETIME_SECONDS + 1, now,
  });
  assert.equal(zuLang.reason, "lifetime_too_long");
  assert.equal((await mintJobToken({ config, audience: "a", jobId: "job-1", role: "specialist_claude",
    principalId: "c", tenant: TENANT, lifetimeSeconds: 0, now })).reason, "lifetime_invalid");
});

test("falsche audience ⇒ 403, auch bei gültiger Signatur", async () => {
  const t = await token({ audience: "quantus-ingest" });
  const res = await pruefe(t, { expectedAudience: "quantus-context" });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "audience_mismatch");

  assert.equal((await verifyJobToken(t, { config, expectedJobId: "job-1", now })).reason, "expected_audience_missing");
  assert.equal((await verifyJobToken(t, { config, expectedAudience: "quantus-ingest", now })).reason, "expected_job_missing");
});

test("Token eines FREMDEN Auftrags ⇒ 403 — und auch die Rechteprüfung hält", async () => {
  const t = await token({ jobId: "job-1" });
  const res = await pruefe(t, { expectedJobId: "job-2" });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "job_mismatch");

  const gut = await pruefe(t);
  const fremd = authorize({
    principal: gut.principal, verb: "context.read", dataCategory: "run_context",
    object: { kind: "run_context", id: "ctx-2", tenant: TENANT, jobId: "job-2" },
    policyVersion: POLICY_VERSION, config,
  });
  assert.equal(fremd.status, 403);
  assert.equal(fremd.reason, "object_foreign_job");
});

test("fehlende Auftragsbindung ⇒ kein Token und kein Ja", async () => {
  for (const jobId of [undefined, "", null, "job/1", "a".repeat(200)]) {
    const res = await mintJobToken({ config, audience: "quantus-ingest", jobId, role: "specialist_claude",
      principalId: "c", tenant: TENANT, now });
    assert.equal(res.ok, false, `jobId=${String(jobId)} wurde ausgestellt`);
    assert.equal(res.reason, "job_id_invalid");
  }
  // Ein Token ohne `job`-Anspruch — mit unserem Schlüssel echt signiert.
  const schluessel = new TextEncoder().encode(JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret);
  const nowSec = Math.floor(JETZT / 1000);
  const ohneJob = await new SignJWT({ role: "specialist_claude", tenant: TENANT, policyVersion: POLICY_VERSION })
    .setProtectedHeader({ alg: "HS256", kid: "w1", typ: JOB_TOKEN_TYP })
    .setIssuer(JOB_TOKEN_ISSUER).setAudience("quantus-ingest").setSubject("claude-spezialist")
    .setIssuedAt(nowSec).setExpirationTime(nowSec + 300).setJti("x").sign(schluessel);
  const res = await pruefe(ohneJob);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "job_binding_missing");
});

test("Rollen kommen nie aus dem Auftrag — und nie aus dem Dienstbereich", async () => {
  for (const role of ["user", "admin", "", "superagent", "constructor",
    "scheduler", "backend_checker"]) {
    const res = await mintJobToken({ config, audience: "quantus-ingest", jobId: "job-1", role,
      principalId: "c", tenant: TENANT, now });
    assert.equal(res.ok, false, `Rolle ${role} wurde als Job-Token ausgestellt`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "role_not_allowed_for_job_token");
  }
  // Auch ein echt signiertes Token mit Backend-Rolle wird nicht anerkannt.
  const schluessel = new TextEncoder().encode(JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret);
  const nowSec = Math.floor(JETZT / 1000);
  const gefaelscht = await new SignJWT({ job: "job-1", role: "backend_checker", tenant: TENANT, policyVersion: POLICY_VERSION })
    .setProtectedHeader({ alg: "HS256", kid: "w1", typ: JOB_TOKEN_TYP })
    .setIssuer(JOB_TOKEN_ISSUER).setAudience("quantus-ingest").setSubject("wer-auch-immer")
    .setIssuedAt(nowSec).setExpirationTime(nowSec + 300).setJti("x").sign(schluessel);
  assert.equal((await pruefe(gefaelscht)).reason, "role_not_allowed_for_job_token");
});

test("Policy-Wechsel entwertet laufende Token", async () => {
  const t = await token();
  const andere = resolveAuthConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_POLICY_VERSION: "v3-2026-10-01" },
  }).read).config;
  const res = await pruefe(t, { config: andere });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "policy_version_mismatch");
});

test("Rotation: mit dem neuen Schlüssel ausstellen, den auslaufenden anerkennen", async () => {
  const alt = JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS);
  const altConfig = resolveAuthConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([{ ...alt[1], status: "active" }]) },
  }).read).config;
  const altToken = (await mintJobToken({ config: altConfig, audience: "quantus-ingest", jobId: "job-1",
    role: "specialist_claude", principalId: "c", tenant: TENANT, now })).token;

  assert.equal((await pruefe(altToken)).ok, true);
  const kopf = JSON.parse(Buffer.from((await token()).split(".")[0], "base64url").toString("utf8"));
  assert.equal(kopf.kid, "w1", "ausgestellt wird mit dem aktiven Schlüssel");
});

test("kaputte Form ⇒ 401, ohne Blick in den Inhalt", async () => {
  for (const t of ["", "abc", "a.b", "a.b.c.d", "...", "@@@.###.$$$"]) {
    const res = await pruefe(t);
    assert.equal(res.ok, false, `"${t}" akzeptiert`);
    assert.equal(res.status, 401, `"${t}" ergab ${res.status}`);
  }
});
