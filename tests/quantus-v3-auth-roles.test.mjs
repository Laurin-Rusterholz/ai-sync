/*
 * v3 C1 — das Rollenmodell mit den FACHVERBEN, beim Lesen wie beim Schreiben.
 *
 * BEFUND: In Systemen dieser Bauart entsteht der Schaden selten beim
 * offensichtlichen Schreibzugriff. Er entsteht, wenn ein Spezialist, der „nur
 * liest", den Kontext eines fremden Vorgangs mitliest — oder wenn generische
 * Sammelverben („command.submit") verdecken, was eine Rolle tatsächlich
 * auslösen darf.
 *
 * Deshalb kennt die Matrix genau die Verben des Konzepts, und `authorize()`
 * verlangt für jedes von ihnen Datenkategorie UND serverseitig geladenes
 * Objekt — dessen ART die Kategorie bestimmt (Review-Befund 4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  authorize, ROLE_POLICY, ROLES, JOB_TOKEN_ROLES, SERVICE_CREDENTIAL_ROLES,
  VERBS, DATA_CATEGORIES, OBJECT_KIND_CATEGORY, ISSUERS,
  assertNoProviderSecrets, resolveAuthConfig,
} from "../netlify/lib/quantus-v3-auth.mjs";
import { makeEnv, TENANT, POLICY_VERSION } from "./fixtures/quantus-v3-auth-fixtures.mjs";

const { config } = resolveAuthConfig(makeEnv({ tenant: TENANT }).read);

const nutzer = { kind: "user", issuedBy: ISSUERS.firebase, id: "uid-laurin", role: "user", tenant: TENANT };
const fremderNutzer = { ...nutzer, id: "uid-fremd" };
const leitung = { kind: "worker", issuedBy: ISSUERS.jobToken, id: "lead-agent-cloudrun", role: "lead_agent", tenant: TENANT, jobId: "job-1", assignedJobIds: ["job-1"] };
const claude = { kind: "worker", issuedBy: ISSUERS.jobToken, id: "claude-spezialist", role: "specialist_claude", tenant: TENANT, jobId: "job-1" };
const gemini = { kind: "worker", issuedBy: ISSUERS.jobToken, id: "gemini-spezialist", role: "specialist_gemini", tenant: TENANT, jobId: "job-2" };
const scheduler = { kind: "service", issuedBy: ISSUERS.serviceCredential, id: "cloud-scheduler", role: "scheduler", tenant: TENANT };
const pruefer = { kind: "service", issuedBy: ISSUERS.serviceCredential, id: "backend-pruefer", role: "backend_checker", tenant: TENANT };

/* Ein serverseitig geladener Datensatz. `kind` bestimmt die Kategorie. */
const obj = (kind, over = {}) => ({ kind, id: `${kind}-1`, tenant: TENANT, ...over });

function darf(principal, verb, dataCategory, object) {
  return authorize({ principal, verb, dataCategory, object, policyVersion: POLICY_VERSION, config });
}

test("Nutzer: eigene Vorgänge, eigene Antworten — fremde nicht", () => {
  assert.equal(darf(nutzer, "context.read", "lead", obj("lead", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "intake.create", "intake", obj("intake", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "intake.accept", "intake", obj("intake", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "task.create", "task", obj("task", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "lead.comment", "lead", obj("lead", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "lead.transition", "lead", obj("lead", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "lead.schedule", "lead", obj("lead", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "briefing.answer", "briefing_answer", obj("briefing_answer", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "question.resolve", "question", obj("question", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "document.register", "document", obj("document", { ownerId: nutzer.id })).ok, true);
  assert.equal(darf(nutzer, "note.append", "note", obj("note", { ownerId: nutzer.id })).ok, true);

  // Fremdes Objekt: 403 — auch beim blossen Lesen.
  const fremd = darf(nutzer, "context.read", "lead", obj("lead", { ownerId: fremderNutzer.id }));
  assert.equal(fremd.status, 403);
  assert.equal(fremd.reason, "object_not_owned");
  assert.equal(darf(nutzer, "context.read", "lead", obj("lead")).reason, "object_owner_missing");

  const fremderMandant = darf(nutzer, "context.read", "lead", obj("lead", { ownerId: nutzer.id, tenant: "anderer-haushalt" }));
  assert.equal(fremderMandant.reason, "tenant_mismatch");

  // Was der Nutzer NICHT darf: Backend- und Agentenverben.
  for (const [verb, kategorie, art] of [
    ["briefing.consumeAnswer", "briefing_answer", "briefing_answer"],
    ["worker.assign", "assignment", "assignment"],
    ["worker.return", "worker_result", "worker_result"],
    ["worker.review", "worker_result", "worker_result"],
    ["run.ensure", "run", "run"], ["run.claim", "run", "run"], ["run.renew", "run", "run"],
    ["run.checkpoint", "run", "run"], ["run.finalize", "run", "run"], ["run.log", "run", "run"],
    ["question.create", "question", "question"],
    ["document.processed", "document", "document"],
  ]) {
    const res = darf(nutzer, verb, kategorie, obj(art, { ownerId: nutzer.id }));
    assert.equal(res.status, 403, `user darf ${verb}`);
    assert.equal(res.reason, "verb_not_allowed_for_role");
  }
});

test("Spezialist: NUR Kontext des eigenen Auftrags, NUR worker.return", () => {
  const eigenerKontext = obj("run_context", { id: "ctx-1", jobId: "job-1" });
  assert.equal(darf(claude, "context.read", "run_context", eigenerKontext).ok, true);
  assert.equal(darf(claude, "worker.return", "worker_result", obj("worker_result", { jobId: "job-1" })).ok, true);

  // Fremder Auftrag — lesend wie schreibend.
  const fremderKontext = obj("run_context", { id: "ctx-2", jobId: "job-2" });
  assert.equal(darf(claude, "context.read", "run_context", fremderKontext).reason, "object_foreign_job");
  assert.equal(darf(claude, "worker.return", "worker_result", obj("worker_result", { jobId: "job-2" })).reason, "object_foreign_job");

  // Ein fremder LEAD ist für ihn keine erlaubte Kategorie — schon gar nicht lesend.
  const lead = darf(claude, "context.read", "lead", obj("lead", { jobId: "job-1" }));
  assert.equal(lead.reason, "data_category_not_allowed_for_role");

  // Kein Aufgabenanlegen, kein Abschluss, keine Nutzerantwort, keine Mail-Autorität
  // (das Verb gibt es gar nicht mehr).
  for (const [verb, kategorie, art] of [
    ["task.create", "task", "task"],
    ["lead.comment", "lead", "lead"], ["lead.transition", "lead", "lead"],
    ["briefing.answer", "briefing_answer", "briefing_answer"],
    ["run.finalize", "run", "run"], ["run.checkpoint", "run", "run"],
    ["worker.assign", "assignment", "assignment"], ["worker.review", "worker_result", "worker_result"],
    ["question.create", "question", "question"], ["note.append", "note", "note"],
    ["document.register", "document", "document"], ["intake.create", "intake", "intake"],
  ]) {
    const res = darf(claude, verb, kategorie, obj(art, { jobId: "job-1", ownerId: nutzer.id }));
    assert.equal(res.status, 403, `specialist darf ${verb}`);
    assert.equal(res.reason, "verb_not_allowed_for_role");
  }

  // Ohne Jobbindung kommt er an gar nichts.
  assert.equal(darf({ ...claude, jobId: null }, "context.read", "run_context", eigenerKontext).reason, "job_binding_missing");

  // Gemini ist an seinen Auftrag gebunden, nicht an Claudes.
  assert.equal(darf(gemini, "context.read", "run_context", fremderKontext).ok, true);
  assert.equal(darf(gemini, "context.read", "run_context", eigenerKontext).reason, "object_foreign_job");
});

test("Leitungsagent: delegieren, eigene Arbeit, Ergebnisse prüfen — nie Nutzerantwort", () => {
  assert.equal(darf(leitung, "context.read", "run_context", obj("run_context", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "lead.comment", "lead", obj("lead", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "lead.transition", "lead", obj("lead", { assignedTo: leitung.id })).ok, true);
  assert.equal(darf(leitung, "task.create", "task", obj("task", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "question.create", "question", obj("question", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "worker.assign", "assignment", obj("assignment", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "worker.review", "worker_result", obj("worker_result", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "run.checkpoint", "run", obj("run", { jobId: "job-1" })).ok, true);
  assert.equal(darf(leitung, "run.log", "run", obj("run", { jobId: "job-1" })).ok, true);

  // Nicht zugewiesen ⇒ 403, auch lesend.
  assert.equal(darf(leitung, "context.read", "run_context", obj("run_context", { jobId: "job-77" })).reason, "object_not_assigned");
  assert.equal(darf(leitung, "lead.comment", "lead", obj("lead", { jobId: "job-77" })).reason, "object_not_assigned");

  // Nutzerantworten, Abschluss, Startnotizen, eigene Aufträge: alles nicht seins.
  for (const [verb, kategorie, art] of [
    ["briefing.answer", "briefing_answer", "briefing_answer"],
    ["briefing.consumeAnswer", "briefing_answer", "briefing_answer"],
    ["question.resolve", "question", "question"],
    ["note.append", "note", "note"],
    ["run.finalize", "run", "run"], ["run.ensure", "run", "run"], ["run.claim", "run", "run"],
    ["run.renew", "run", "run"],
    ["worker.return", "worker_result", "worker_result"],
    ["intake.create", "intake", "intake"], ["intake.accept", "intake", "intake"],
    ["document.register", "document", "document"],
  ]) {
    const res = darf(leitung, verb, kategorie, obj(art, { jobId: "job-1", assignedTo: leitung.id }));
    assert.equal(res.status, 403, `lead_agent darf ${verb}`);
    assert.equal(res.reason, "verb_not_allowed_for_role");
  }
});

test("Nutzerantwort: nur der Mensch antwortet, nur das Backend verbraucht", () => {
  const antwort = obj("briefing_answer", { ownerId: nutzer.id, jobId: "job-1", assignedTo: leitung.id });
  assert.equal(darf(nutzer, "briefing.answer", "briefing_answer", antwort).ok, true);
  for (const p of [leitung, claude, gemini, scheduler, pruefer]) {
    assert.equal(darf(p, "briefing.answer", "briefing_answer", antwort).status, 403,
      `${p.role} darf im Namen des Nutzers antworten`);
  }
  // Verbrauchen darf nur das Backend.
  assert.equal(darf(pruefer, "briefing.consumeAnswer", "briefing_answer", antwort).ok, true);
  for (const p of [nutzer, leitung, claude, scheduler]) {
    assert.equal(darf(p, "briefing.consumeAnswer", "briefing_answer", antwort).status, 403,
      `${p.role} darf Nutzerantworten verbrauchen`);
  }
  // Und lesen darf sie nicht jeder.
  for (const p of [leitung, claude, scheduler]) {
    assert.equal(darf(p, "context.read", "briefing_answer", antwort).status, 403,
      `${p.role} darf Nutzerantworten lesen`);
  }
});

test("Scheduler: Läufe sicherstellen, übernehmen, verlängern — keine Inhalte", () => {
  assert.equal(darf(scheduler, "run.ensure", "run", obj("run")).ok, true);
  assert.equal(darf(scheduler, "run.claim", "run", obj("run")).ok, true);
  assert.equal(darf(scheduler, "run.renew", "run", obj("run")).ok, true);
  assert.equal(darf(scheduler, "context.read", "run_status", obj("run_status")).ok, true);
  for (const [verb, kategorie, art] of [
    ["run.finalize", "run", "run"], ["run.checkpoint", "run", "run"],
    ["briefing.answer", "briefing_answer", "briefing_answer"],
    ["briefing.consumeAnswer", "briefing_answer", "briefing_answer"],
    ["lead.transition", "lead", "lead"], ["task.create", "task", "task"],
    ["worker.assign", "assignment", "assignment"], ["note.append", "note", "note"],
    ["question.resolve", "question", "question"],
  ]) {
    assert.equal(darf(scheduler, verb, kategorie, obj(art)).status, 403, `scheduler darf ${verb}`);
  }
});

test("Backend-Prüfer: Abschluss, Antwortverbrauch, Finalnotizen — nichts nach aussen", () => {
  assert.equal(darf(pruefer, "run.finalize", "run", obj("run")).ok, true);
  assert.equal(darf(pruefer, "run.checkpoint", "run", obj("run")).ok, true);
  assert.equal(darf(pruefer, "note.append", "note", obj("note")).ok, true);
  assert.equal(darf(pruefer, "document.processed", "document", obj("document")).ok, true);
  assert.equal(darf(pruefer, "context.read", "system_status", obj("system_status")).ok, true);
  for (const [verb, kategorie, art] of [
    ["task.create", "task", "task"], ["lead.transition", "lead", "lead"],
    ["worker.assign", "assignment", "assignment"], ["worker.return", "worker_result", "worker_result"],
    ["briefing.answer", "briefing_answer", "briefing_answer"],
    ["intake.create", "intake", "intake"], ["run.claim", "run", "run"],
  ]) {
    assert.equal(darf(pruefer, verb, kategorie, obj(art)).status, 403, `backend_checker darf ${verb}`);
  }
});

test("Unbekannte Rolle, Verb, Kategorie, Objektart ⇒ fail closed", () => {
  assert.equal(darf({ ...nutzer, role: "admin" }, "context.read", "lead", obj("lead", { ownerId: nutzer.id })).reason, "unknown_role");
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", ""]) {
    assert.equal(darf({ ...nutzer, role: name }, "context.read", "lead", obj("lead", { ownerId: nutzer.id })).reason, "unknown_role");
  }
  assert.equal(darf(nutzer, "alles.machen", "lead", obj("lead", { ownerId: nutzer.id })).reason, "unknown_verb");
  assert.equal(darf(nutzer, "context.read", "geheimakte", obj("lead", { ownerId: nutzer.id })).reason, "unknown_data_category");
  assert.equal(darf(nutzer, "context.read", "lead", { kind: "geheimakte", id: "x", tenant: TENANT, ownerId: nutzer.id }).reason, "object_kind_unknown");
  assert.equal(authorize({ principal: nutzer, verb: "context.read", dataCategory: "lead", policyVersion: POLICY_VERSION, config }).reason, "object_missing");
  assert.equal(darf(nutzer, "context.read", "lead", obj("lead", { id: "", ownerId: nutzer.id })).reason, "object_id_missing");
  assert.equal(darf({ ...nutzer, tenant: "" }, "context.read", "lead", obj("lead", { ownerId: nutzer.id })).reason, "tenant_missing");
});

test("die Matrix selbst: Verben, Kategorien und Ausstellwege sind konsistent", () => {
  // Genau die Fachverben des Konzepts — keine Sammelverben.
  for (const generisch of ["command.submit", "job.advance", "job.create", "job.result.write",
    "answer.write", "approval.write", "mail.send", "lead.close", "lead.finalize",
    "policy.write", "grant.write", "object.read", "run_status.read", "system_status.compute"]) {
    assert.equal(VERBS.includes(generisch), false, `Sammelverb ${generisch} steht noch in der Matrix`);
  }
  for (const fachverb of [
    "intake.create", "intake.accept", "task.create",
    "lead.comment", "lead.transition", "lead.schedule",
    "briefing.answer", "briefing.consumeAnswer",
    "question.create", "question.resolve",
    "document.register", "document.processed",
    "worker.assign", "worker.return", "worker.review",
    "run.ensure", "run.claim", "run.renew", "run.checkpoint", "run.finalize",
    "note.append", "run.log",
  ]) {
    assert.ok(VERBS.includes(fachverb), `Fachverb ${fachverb} fehlt`);
  }

  for (const [rolle, policy] of Object.entries(ROLE_POLICY)) {
    for (const [verb, kategorien] of Object.entries(policy.verbs)) {
      assert.ok(VERBS.includes(verb), `${rolle}: unbekanntes Verb ${verb}`);
      for (const k of kategorien) assert.ok(DATA_CATEGORIES.includes(k), `${rolle}: unbekannte Kategorie ${k}`);
    }
    assert.ok(["user", "worker", "service"].includes(policy.kind));
    assert.ok(Object.values(ISSUERS).includes(policy.issuedBy));
  }
  // Jede Kategorie hat genau eine Objektart.
  for (const kategorie of DATA_CATEGORIES) {
    assert.ok(Object.values(OBJECT_KIND_CATEGORY).includes(kategorie), `Kategorie ${kategorie} hat keine Objektart`);
  }

  // briefing.answer gibt es NUR beim Nutzer, briefing.consumeAnswer NUR beim Backend.
  for (const rolle of ROLES) {
    const darfAntworten = Boolean(ROLE_POLICY[rolle].verbs["briefing.answer"]);
    assert.equal(darfAntworten, rolle === "user", `${rolle}: briefing.answer falsch verteilt`);
    const darfVerbrauchen = Boolean(ROLE_POLICY[rolle].verbs["briefing.consumeAnswer"]);
    assert.equal(darfVerbrauchen, rolle === "backend_checker", `${rolle}: briefing.consumeAnswer falsch verteilt`);
    const darfAbschliessen = Boolean(ROLE_POLICY[rolle].verbs["run.finalize"]);
    assert.equal(darfAbschliessen, rolle === "backend_checker", `${rolle}: run.finalize falsch verteilt`);
  }

  // Spezialisten haben genau zwei Verben.
  for (const rolle of ["specialist_claude", "specialist_gemini"]) {
    assert.deepEqual(Object.keys(ROLE_POLICY[rolle].verbs), ["context.read", "worker.return"]);
    assert.equal(ROLE_POLICY[rolle].binding, "job");
  }

  // Ausstellwege sind getrennt: Worker-Token ≠ Dienst-Zugangsdatum.
  assert.deepEqual([...JOB_TOKEN_ROLES].sort(), ["lead_agent", "specialist_claude", "specialist_gemini"]);
  assert.deepEqual([...SERVICE_CREDENTIAL_ROLES].sort(), ["backend_checker", "scheduler"]);
  assert.equal(JOB_TOKEN_ROLES.includes("user"), false);
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
