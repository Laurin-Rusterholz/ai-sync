/*
 * v3 C1 — das Rollenmodell, beim LESEN wie beim SCHREIBEN.
 *
 * BEFUND, aus dem diese Tests folgen: In Systemen dieser Bauart entsteht der
 * Schaden selten beim offensichtlichen Schreibzugriff. Er entsteht, wenn ein
 * Spezialist, der „nur liest", den Kontext eines FREMDEN Vorgangs mitliest —
 * und ihn in seinem Ergebnis weiterträgt. Deshalb verlangt `authorize()` für
 * jedes Verb Datenkategorie UND Objekt, auch für context.read.
 *
 * Zweiter Befund: Rollen dürfen nie aus dem Auftragstext stammen. Ein Modell,
 * das „ich bin jetzt der Nutzer" schreibt, ist ein Modell, das das schreibt —
 * mehr nicht. Geprüft wird das hier an der Matrix, im Ausweis-Test an
 * `rejectIdentityInPayload` und im Worker-Test am Job-Token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  authorize, ROLE_POLICY, WORKER_ROLES, VERBS, DATA_CATEGORIES,
  assertNoProviderSecrets, resolveAuthConfig,
} from "../netlify/lib/quantus-v3-auth.mjs";
import { makeEnv, TENANT, POLICY_VERSION } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const { config } = resolveAuthConfig(makeEnv({ tenant: TENANT }).read);

const nutzer = { kind: "user", id: "uid-laurin", role: "user", tenant: TENANT };
const fremderNutzer = { kind: "user", id: "uid-fremd", role: "user", tenant: TENANT };
const leitung = { kind: "worker", id: "lead-agent-cloudrun", role: "lead_agent", tenant: TENANT, assignedJobIds: ["job-1"] };
const claude = { kind: "worker", id: "claude-spezialist", role: "specialist_claude", tenant: TENANT, jobId: "job-1" };
const gemini = { kind: "worker", id: "gemini-spezialist", role: "specialist_gemini", tenant: TENANT, jobId: "job-2" };
const scheduler = { kind: "worker", id: "cloud-scheduler", role: "scheduler", tenant: TENANT };
const pruefer = { kind: "service", id: "backend-pruefer", role: "backend_checker", tenant: TENANT };

const obj = (over = {}) => ({ kind: "job", id: "o-1", tenant: TENANT, ...over });

function darf(principal, verb, dataCategory, object) {
  return authorize({ principal, verb, dataCategory, object, policyVersion: POLICY_VERSION, config });
}

test("Nutzer: eigene Aufträge, Antworten, Freigaben — fremde nicht", () => {
  assert.equal(darf(nutzer, "object.read", "job", obj({ ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "answer.write", "user_answer", obj({ kind: "user_answer", ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "approval.write", "approval", obj({ kind: "approval", ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "job.create", "job", obj({ ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "lead.finalize", "lead", obj({ kind: "lead", ownerId: nutzer.id })).ok, true);

  // Fremdes Objekt: 403 — auch beim blossen Lesen.
  const fremd = darf(nutzer, "object.read", "job", obj({ ownerId: fremderNutzer.id }));
  assert.equal(fremd.status, 403);
  assert.equal(fremd.reason, "object_not_owned");

  // Objekt ohne Eigentümer ist für den Nutzerweg unerreichbar, nicht „frei".
  assert.equal(darf(nutzer, "object.read", "job", obj()).reason, "object_owner_missing");

  // Anderer Mandant: 403, egal wem es gehört.
  const fremderMandant = darf(nutzer, "object.read", "job", obj({ ownerId: nutzer.id, tenant: "anderer-haushalt" }));
  assert.equal(fremderMandant.status, 403);
  assert.equal(fremderMandant.reason, "tenant_mismatch");

  // Nutzer dürfen keine Policy schreiben und sich nichts selbst zuteilen.
  assert.equal(darf(nutzer, "policy.write", "policy", obj({ ownerId: nutzer.id })).status, 403);
  assert.equal(darf(nutzer, "grant.write", "grant", obj({ ownerId: nutzer.id })).status, 403);
});

test("Spezialist: NUR Kontext des eigenen Jobs, NUR Ergebnis an diesen Job", () => {
  const eigenerKontext = obj({ kind: "job_context", id: "ctx-1", jobId: "job-1" });
  assert.equal(darf(claude, "context.read", "job_context", eigenerKontext).ok, true);
  assert.equal(darf(claude, "job.result.write", "job_result", obj({ kind: "job_result", id: "res-1", jobId: "job-1" })).ok, true);

  // Fremder Job — lesend wie schreibend.
  const fremderKontext = obj({ kind: "job_context", id: "ctx-2", jobId: "job-2" });
  assert.equal(darf(claude, "context.read", "job_context", fremderKontext).reason, "object_foreign_job");
  assert.equal(darf(claude, "job.result.write", "job_result", obj({ kind: "job_result", id: "res-2", jobId: "job-2" })).reason, "object_foreign_job");

  // Ein fremder LEAD ist für ihn keine erlaubte Datenkategorie — schon gar
  // nicht zum Lesen.
  const lead = darf(claude, "context.read", "lead", obj({ kind: "lead", id: "lead-9", jobId: "job-1" }));
  assert.equal(lead.status, 403);
  assert.equal(lead.reason, "data_category_not_allowed_for_role");
  assert.equal(darf(claude, "object.read", "lead", obj({ kind: "lead", id: "lead-9", jobId: "job-1" })).reason, "verb_not_allowed_for_role");

  // Keine Aufgabe, keine Mail, kein Abschluss, keine Freigabe, keine Antwort.
  for (const [verb, kategorie] of [
    ["task.create", "task"], ["mail.send", "mail"], ["lead.close", "lead"],
    ["lead.finalize", "lead"], ["approval.write", "approval"], ["answer.write", "user_answer"],
    ["job.create", "job"], ["job.advance", "job"], ["grant.write", "grant"], ["policy.write", "policy"],
  ]) {
    const res = darf(claude, verb, kategorie, obj({ kind: kategorie, jobId: "job-1", ownerId: nutzer.id }));
    assert.equal(res.status, 403, `specialist darf ${verb}`);
    assert.equal(res.reason, "verb_not_allowed_for_role");
  }

  // Ein Spezialist ohne Jobbindung kommt an gar nichts.
  const ohneJob = { ...claude, jobId: null };
  assert.equal(darf(ohneJob, "context.read", "job_context", eigenerKontext).reason, "job_binding_missing");

  // Gemini ist an seinen Job gebunden, nicht an Claudes.
  assert.equal(darf(gemini, "context.read", "job_context", fremderKontext).ok, true);
  assert.equal(darf(gemini, "context.read", "job_context", eigenerKontext).reason, "object_foreign_job");
});

test("Leitungsagent: zugewiesener Kontext, keine Nutzerantwort, keine Selbstberechtigung", () => {
  assert.equal(darf(leitung, "context.read", "job_context", obj({ kind: "job_context", jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "job.advance", "job", obj({ jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "task.create", "task", obj({ kind: "task", jobId: "job-1" })).ok, true);

  // Nicht zugewiesen ⇒ 403, auch lesend.
  assert.equal(darf(leitung, "context.read", "job_context", obj({ kind: "job_context", jobId: "job-77" })).reason, "object_not_assigned");
  assert.equal(darf(leitung, "job.advance", "job", obj({ jobId: "job-77" })).reason, "object_not_assigned");

  // Nutzerantworten, Freigaben, Policy, Rechtevergabe, Mail, Lead-Abschluss:
  // alles Sache des Menschen.
  for (const [verb, kategorie] of [
    ["answer.write", "user_answer"], ["approval.write", "approval"],
    ["policy.write", "policy"], ["grant.write", "grant"],
    ["mail.send", "mail"], ["lead.close", "lead"], ["lead.finalize", "lead"],
    ["job.create", "job"], ["system_status.compute", "system_status"],
  ]) {
    const res = darf(leitung, verb, kategorie, obj({ kind: kategorie, jobId: "job-1", assignedTo: leitung.id }));
    assert.equal(res.status, 403, `lead_agent darf ${verb}`);
    assert.equal(res.reason, "verb_not_allowed_for_role");
  }
});

test("Nutzer- gegen Assistenzantwort: dieselbe Kategorie, andere Rechte", () => {
  const antwort = obj({ kind: "user_answer", id: "ans-1", ownerId: nutzer.id, jobId: "job-1", assignedTo: leitung.id });
  assert.equal(darf(nutzer, "answer.write", "user_answer", antwort).ok, true);
  for (const p of [leitung, claude, gemini, scheduler, pruefer]) {
    assert.equal(darf(p, "answer.write", "user_answer", antwort).status, 403,
      `${p.role} darf im Namen des Nutzers antworten`);
  }
  // Auch LESEN einer Nutzerantwort ist nicht für alle da.
  assert.equal(darf(nutzer, "object.read", "user_answer", antwort).ok, true);
  for (const p of [leitung, claude, scheduler, pruefer]) {
    assert.equal(darf(p, "object.read", "user_answer", antwort).status, 403,
      `${p.role} darf Nutzerantworten lesen`);
  }
});

test("Scheduler: fällige Jobs und Betriebsstatus — keine Inhaltsfreigabe", () => {
  assert.equal(darf(scheduler, "job.advance", "job", obj({ id: "job-1" })).ok, true);
  assert.equal(darf(scheduler, "run_status.read", "run_status", obj({ kind: "run_status", id: "lauf-1" })).ok, true);
  for (const [verb, kategorie] of [
    ["approval.write", "approval"], ["answer.write", "user_answer"],
    ["lead.close", "lead"], ["lead.finalize", "lead"], ["mail.send", "mail"],
    ["task.create", "task"], ["context.read", "job_context"], ["job.result.write", "job_result"],
  ]) {
    assert.equal(darf(scheduler, verb, kategorie, obj({ kind: kategorie })).status, 403, `scheduler darf ${verb}`);
  }
});

test("Backend-Prüfer: rechnet Status, handelt nicht nach aussen", () => {
  assert.equal(darf(pruefer, "system_status.compute", "system_status", obj({ kind: "system_status", id: "stand-1" })).ok, true);
  assert.equal(darf(pruefer, "object.read", "run_status", obj({ kind: "run_status", id: "lauf-1" })).ok, true);
  for (const [verb, kategorie] of [
    ["mail.send", "mail"], ["task.create", "task"], ["lead.finalize", "lead"],
    ["approval.write", "approval"], ["job.create", "job"], ["job.result.write", "job_result"],
    ["command.submit", "job"],
  ]) {
    assert.equal(darf(pruefer, verb, kategorie, obj({ kind: kategorie })).status, 403, `backend_checker darf ${verb}`);
  }
});

test("Unbekannte Rolle, unbekanntes Verb, unbekannte Kategorie ⇒ fail closed", () => {
  assert.equal(darf({ ...nutzer, role: "admin" }, "object.read", "job", obj({ ownerId: nutzer.id })).reason, "unknown_role");
  assert.equal(darf({ ...nutzer, role: "" }, "object.read", "job", obj({ ownerId: nutzer.id })).reason, "unknown_role");
  // Prototypen-Namen sind keine Rollen.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(darf({ ...nutzer, role: name }, "object.read", "job", obj({ ownerId: nutzer.id })).reason, "unknown_role");
  }
  assert.equal(darf(nutzer, "alles.machen", "job", obj({ ownerId: nutzer.id })).reason, "unknown_verb");
  assert.equal(darf(nutzer, "object.read", "geheimakte", obj({ ownerId: nutzer.id })).reason, "unknown_data_category");
  assert.equal(authorize({}).status, 403);
  assert.equal(authorize({ principal: nutzer, verb: "object.read", dataCategory: "job" }).reason, "object_missing");
  assert.equal(darf(nutzer, "object.read", "job", obj({ id: "", ownerId: nutzer.id })).reason, "object_id_missing");
  assert.equal(darf({ ...nutzer, tenant: "" }, "object.read", "job", obj({ ownerId: nutzer.id })).reason, "tenant_missing");
});

test("veraltete Policy-Version ⇒ 403", () => {
  const res = authorize({
    principal: nutzer, verb: "object.read", dataCategory: "job",
    object: obj({ ownerId: nutzer.id }), policyVersion: "v3-alt", config,
  });
  assert.equal(res.status, 403);
  assert.equal(res.reason, "policy_version_mismatch");
});

test("die Matrix selbst: keine Rolle bekommt versehentlich zu viel", () => {
  // „user" ist keine Worker-Rolle — ein Job-Token kann sie nie tragen.
  assert.equal(WORKER_ROLES.includes("user"), false);
  assert.deepEqual([...WORKER_ROLES].sort(),
    ["backend_checker", "lead_agent", "scheduler", "specialist_claude", "specialist_gemini"]);

  for (const [rolle, policy] of Object.entries(ROLE_POLICY)) {
    for (const [verb, kategorien] of Object.entries(policy.verbs)) {
      assert.ok(VERBS.includes(verb), `${rolle}: unbekanntes Verb ${verb} in der Matrix`);
      for (const k of kategorien) {
        assert.ok(DATA_CATEGORIES.includes(k), `${rolle}: unbekannte Kategorie ${k} in der Matrix`);
      }
    }
  }
  // Nur der Mensch darf Policy oder Rechte schreiben — und auch er nicht.
  for (const [rolle, policy] of Object.entries(ROLE_POLICY)) {
    assert.equal(policy.verbs["policy.write"], undefined, `${rolle} darf Policy schreiben`);
    assert.equal(policy.verbs["grant.write"], undefined, `${rolle} darf Rechte vergeben`);
  }
  // Spezialisten haben genau zwei Verben.
  for (const rolle of ["specialist_claude", "specialist_gemini"]) {
    assert.deepEqual(Object.keys(ROLE_POLICY[rolle].verbs), ["context.read", "job.result.write"]);
    assert.equal(ROLE_POLICY[rolle].binding, "job");
  }
});

test("Anbieterschlüssel gehören nicht in einen Job-Kontext", () => {
  const sauber = { jobId: "job-1", frage: "Welche Aufgaben sind heute fällig?", eintraege: [{ id: "t1", titel: "Steuern" }] };
  assert.equal(assertNoProviderSecrets(sauber).ok, true);

  for (const kontext of [
    { jobId: "job-1", ANTHROPIC_API_KEY: "sk-ant-beispielwert-0000" },
    { jobId: "job-1", provider: { api_key: "egal" } },
    { jobId: "job-1", auftrag: { authorization: "Bearer irgendwas" } },
    { jobId: "job-1", text: "Nimm AIzaSyA0000000000000000000000000000000" },
    { jobId: "job-1", notiz: "-----BEGIN RSA PRIVATE KEY-----" },
  ]) {
    const res = assertNoProviderSecrets(kontext);
    assert.equal(res.ok, false, `${JSON.stringify(kontext).slice(0, 40)}… wurde durchgelassen`);
    assert.equal(res.status, 400);
    assert.ok(res.reason.startsWith("provider_secret_in_context"));
  }
});
