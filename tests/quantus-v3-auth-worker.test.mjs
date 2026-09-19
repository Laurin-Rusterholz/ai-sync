/*
 * v3 C1 — Worker-Token: kurzlebig, audience- und jobgebunden.
 *
 * BEFUND, aus dem diese Tests folgen: Ein Spezialist bekommt einen Auftrag und
 * damit ein Token. Ist dieses Token nicht an GENAU DIESEN Auftrag gebunden,
 * dann ist es ein Generalschlüssel für die Dauer seiner Gültigkeit — und der
 * Auftragstext, der durch dieselbe Leitung kommt, kann behaupten, was er will.
 *
 * Geprüft wird deshalb mit ECHTER Signatur (HMAC-SHA256 aus node:crypto,
 * Domänentrennung): verbogener Nutzinhalt, fremder Schlüssel, falsche
 * audience, fehlende oder fremde Jobbindung, Ablauf, überlange Laufzeit,
 * Rollen aus dem Body. Alle Schlüssel entstehen zur Laufzeit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuthConfig, mintJobToken, verifyJobToken, authorize,
  MAX_JOB_TOKEN_LIFETIME_SECONDS,
} from "../netlify/lib/quantus-v3-auth.mjs";
import { makeEnv, TENANT, POLICY_VERSION, randomSecret } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const env = makeEnv({ tenant: TENANT });
const { config } = resolveAuthConfig(env.read);
const JETZT = Date.parse("2026-09-19T10:00:00Z");
const now = () => JETZT;

function token(over = {}) {
  const res = mintJobToken({
    config, audience: "quantus-ingest", jobId: "job-1", role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, lifetimeSeconds: 300, now, ...over,
  });
  assert.equal(res.ok, true, `Ausstellen fehlgeschlagen: ${res.reason}`);
  return res.token;
}

test("gültiges Job-Token ⇒ Principal mit genau dieser Jobbindung", () => {
  const res = verifyJobToken(token(), { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(res.ok, true);
  assert.equal(res.principal.kind, "worker");
  assert.equal(res.principal.role, "specialist_claude");
  assert.equal(res.principal.jobId, "job-1");
  assert.equal(res.principal.tenant, TENANT);
  assert.ok(res.principal.jti);
});

test("verbogener Nutzinhalt ⇒ 401 (echte Signaturprüfung)", () => {
  const t = token();
  const [prefix, kid, payloadB64, sig] = t.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

  // Jede dieser Änderungen wäre ein Rechtezuwachs — und jede zerbricht die Signatur.
  for (const verbogen of [
    { ...payload, role: "user" },
    { ...payload, job: "job-2" },
    { ...payload, tenant: "anderer-haushalt" },
    { ...payload, exp: payload.exp + 86400 },
    { ...payload, aud: "quantus-read" },
  ]) {
    const neu = Buffer.from(JSON.stringify(verbogen), "utf8").toString("base64url");
    const res = verifyJobToken(`${prefix}.${kid}.${neu}.${sig}`,
      { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
    assert.equal(res.status, 401, `${JSON.stringify(verbogen).slice(0, 40)}… akzeptiert`);
    assert.equal(res.reason, "token_signature_invalid");
  }
});

test("fremder Schlüssel, unbekannte kid, zurückgezogener Schlüssel", () => {
  // Ein Token, das mit einem anderen Schlüsselbestand ausgestellt wurde.
  const fremd = makeEnv({ tenant: TENANT });
  const fremdConfig = resolveAuthConfig(fremd.read).config;
  const fremdToken = mintJobToken({
    config: fremdConfig, audience: "quantus-ingest", jobId: "job-1", role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, now,
  }).token;
  const res = verifyJobToken(fremdToken, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_signature_invalid");

  const t = token();
  const teile = t.split(".");
  assert.equal(verifyJobToken(`${teile[0]}.unbekannt.${teile[2]}.${teile[3]}`,
    { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now }).reason, "token_unknown_key");

  // Zurückgezogener Schlüssel: ausgestellte Token gelten sofort nicht mehr.
  const widerrufen = resolveAuthConfig(makeEnv({
    overrides: {
      ...env.vars,
      QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([
        { kid: "w1", secret: JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS)[0].secret, status: "revoked" },
        { kid: "w2", secret: randomSecret(), status: "active" },
      ]),
    },
  }).read).config;
  assert.equal(verifyJobToken(t, { config: widerrufen, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now }).reason,
    "token_key_revoked");
});

test("Ablauf: abgelaufen ist abgelaufen, und lange Laufzeiten entstehen nicht", () => {
  const t = token({ lifetimeSeconds: 300 });
  const spaeter = () => JETZT + 301_000;
  const res = verifyJobToken(t, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now: spaeter });
  assert.equal(res.status, 401);
  assert.equal(res.reason, "token_expired");

  // Überlange Laufzeit wird schon beim AUSSTELLEN verweigert.
  const zuLang = mintJobToken({
    config, audience: "quantus-ingest", jobId: "job-1", role: "specialist_claude",
    principalId: "c", tenant: TENANT, lifetimeSeconds: MAX_JOB_TOKEN_LIFETIME_SECONDS + 1, now,
  });
  assert.equal(zuLang.ok, false);
  assert.equal(zuLang.reason, "lifetime_too_long");
  assert.equal(mintJobToken({ config, audience: "a", jobId: "job-1", role: "specialist_claude",
    principalId: "c", tenant: TENANT, lifetimeSeconds: 0, now }).reason, "lifetime_invalid");
});

test("falsche audience ⇒ 403, auch bei gültiger Signatur", () => {
  const t = token({ audience: "quantus-ingest" });
  const res = verifyJobToken(t, { config, expectedAudience: "quantus-context", expectedJobId: "job-1", now });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "audience_mismatch");

  // Wer nicht sagt, wofür geprüft werden soll, bekommt kein Ja.
  assert.equal(verifyJobToken(t, { config, expectedJobId: "job-1", now }).reason, "expected_audience_missing");
  assert.equal(verifyJobToken(t, { config, expectedAudience: "quantus-ingest", now }).reason, "expected_job_missing");
});

test("Token eines FREMDEN Jobs ⇒ 403", () => {
  const t = token({ jobId: "job-1" });
  const res = verifyJobToken(t, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-2", now });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "job_mismatch");

  // Und der Principal aus dem Token kommt auch in der Rechteprüfung nicht an
  // ein fremdes Objekt heran.
  const gut = verifyJobToken(t, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  const fremd = authorize({
    principal: gut.principal, verb: "context.read", dataCategory: "job_context",
    object: { kind: "job_context", id: "ctx-2", tenant: TENANT, jobId: "job-2" },
    policyVersion: POLICY_VERSION, config,
  });
  assert.equal(fremd.status, 403);
  assert.equal(fremd.reason, "object_foreign_job");
});

test("fehlende Jobbindung ⇒ kein Token und kein Ja", () => {
  for (const jobId of [undefined, "", null, "job/1", "a".repeat(200)]) {
    const res = mintJobToken({ config, audience: "quantus-ingest", jobId, role: "specialist_claude",
      principalId: "c", tenant: TENANT, now });
    assert.equal(res.ok, false, `jobId=${String(jobId)} wurde ausgestellt`);
    assert.equal(res.reason, "job_id_invalid");
  }
  // Ein von Hand gebautes Token ohne job-Feld scheitert an der Signatur —
  // und selbst mit gültiger Signatur an der fehlenden Bindung.
  const teile = token().split(".");
  const payload = JSON.parse(Buffer.from(teile[2], "base64url").toString("utf8"));
  delete payload.job;
  const neu = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const res = verifyJobToken(`${teile[0]}.${teile[1]}.${neu}.${teile[3]}`,
    { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "token_signature_invalid");
});

test("Rollen kommen nie aus dem Auftrag: „user“ lässt sich nicht ausstellen", () => {
  for (const role of ["user", "admin", "", "superagent", "constructor"]) {
    const res = mintJobToken({ config, audience: "quantus-ingest", jobId: "job-1", role,
      principalId: "c", tenant: TENANT, now });
    assert.equal(res.ok, false, `Rolle ${role} wurde ausgestellt`);
    assert.equal(res.status, 403);
    assert.equal(res.reason, "role_not_allowed_for_job_token");
  }
});

test("Policy-Wechsel entwertet laufende Token", () => {
  const t = token();
  const andere = resolveAuthConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_POLICY_VERSION: "v3-2026-10-01" },
  }).read).config;
  const res = verifyJobToken(t, { config: andere, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "policy_version_mismatch");
});

test("Rotation: mit dem neuen Schlüssel ausstellen, den auslaufenden noch anerkennen", () => {
  const alt = JSON.parse(env.vars.QUANTUS_V3_WORKER_TOKEN_KEYS);
  // Token, das noch mit dem alten (jetzt „retiring") Schlüssel signiert wurde.
  const altConfig = resolveAuthConfig(makeEnv({
    overrides: { ...env.vars, QUANTUS_V3_WORKER_TOKEN_KEYS: JSON.stringify([{ ...alt[1], status: "active" }]) },
  }).read).config;
  const altToken = mintJobToken({ config: altConfig, audience: "quantus-ingest", jobId: "job-1",
    role: "specialist_claude", principalId: "c", tenant: TENANT, now }).token;

  // Der laufende Bestand kennt ihn als „retiring" — er gilt noch.
  const res = verifyJobToken(altToken, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
  assert.equal(res.ok, true);
  // Neu ausgestellt wird aber mit dem aktiven Schlüssel.
  assert.equal(token().split(".")[1], "w1");
});

test("kaputte Form ⇒ 401, ohne Blick in den Inhalt", () => {
  for (const t of ["", "abc", "qv3j1.w1", "qv3j1.w1.x.y.z", "andereform.w1.x.y", "qv3j1.w1.@@@.###"]) {
    const res = verifyJobToken(t, { config, expectedAudience: "quantus-ingest", expectedJobId: "job-1", now });
    assert.equal(res.ok, false, `"${t}" akzeptiert`);
    assert.ok(res.status === 401, `"${t}" ergab ${res.status}`);
  }
});
