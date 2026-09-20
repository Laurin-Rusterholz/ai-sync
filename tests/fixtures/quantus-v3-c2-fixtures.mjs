/*
 * Prüfmittel für C2: die echte Handler-Kette mit eingespeisten Transporten.
 *
 * Hier stehen KEINE Prüfungen, nur Attrappen — und zwar solche, die sich wie
 * das Original verhalten:
 *
 *  • `makeStore()` bildet `mutateAppData` nach: synchroner Mutator, bis zu
 *    acht CAS-Versuche, Konflikte, unklarer Ausgang, `unchanged`.
 *  • `idempotencyPort()` nimmt das ECHTE Modul des Integrationsstandes. Liegt
 *    es nicht im Checkout, wird der Stand `52b0641` KONTROLLIERT aus dem
 *    Git-Objektspeicher in ein temporäres Verzeichnis gelegt und von dort
 *    geladen — kein Kopieren ins Paket, keine zweite Ledgerlogik. Erst wenn
 *    auch das nicht geht, tritt eine vertragstreue Nachbildung an seine
 *    Stelle. Welche Fassung lief, sagt `idempotencyPort().source`; die Tests
 *    schreiben es in den Lauf.
 *  • `makeDomain()` ist der Fachadapter-Ersatz. Er liefert die drei Ports, die
 *    C2 verlangt: `resolveTarget` (Ressource und Anker aus dem autoritativen
 *    Bestand), `assertActiveBinding` (die aktive Leitungs-Lease bzw. die
 *    aktuelle Auftragszuweisung — im echten Betrieb Paket E1) und `applyVerb`.
 *
 * Alle Schlüssel entstehen zur Laufzeit; kein Netz, kein Anbieteraufruf.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TENANT, POLICY_VERSION } from "./quantus-v3-auth-fixtures.mjs";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const RUN_ID = "job_20260920_42";
export const LEAD_ID = "lead_123";
export const OWNER = "uid-laurin";
export const INTEGRATION_COMMIT = "52b0641";

/* ── Ein Kerndatensatz in der Form, die die Kette erwartet ──────────────── */
export function makeCoreSnapshot({
  dataRevision = 7, leaseOwner = null, leaseExpiresAt = null,
  leadOwner = OWNER, ohneRun = false,
} = {}) {
  const basis = (kind, id, over = {}) => ({
    kind, id, tenant: TENANT, ownerId: OWNER, jobId: RUN_ID, entityVersion: 1, ...over,
  });
  const snapshot = {
    entities: {
      leads: {
        [LEAD_ID]: basis("lead", LEAD_ID, {
          ownerId: leadOwner, entityVersion: 17, title: "Offerte Muster AG",
          state: "open", updatedAt: "2026-09-19T09:00:00Z",
          // Ein Feld, das NIE nach aussen darf:
          internalMailBody: "Sehr geehrte Frau Muster, anbei die Offerte …",
        }),
        lead_fremd: basis("lead", "lead_fremd", { ownerId: "uid-fremd", entityVersion: 3, title: "Fremd", state: "open" }),
      },
      runs: {},
      notes: {
        note_1: basis("note", "note_1", { leadId: LEAD_ID, entityVersion: 2, text: "Notiz", createdAt: "2026-09-19T08:00:00Z" }),
        note_2: basis("note", "note_2", { leadId: LEAD_ID, entityVersion: 1, text: "Zweite Notiz", createdAt: "2026-09-19T08:05:00Z" }),
        note_3: basis("note", "note_3", { leadId: LEAD_ID, entityVersion: 1, text: "Dritte Notiz", createdAt: "2026-09-19T08:10:00Z" }),
      },
      intakes: { intake_1: basis("intake", "intake_1", { entityVersion: 4, source: "mail", title: "Eingang", state: "open" }) },
      tasks: { task_1: basis("task", "task_1", { leadId: LEAD_ID, entityVersion: 2, title: "Aufgabe", state: "open" }) },
      questions: { question_1: basis("question", "question_1", { leadId: LEAD_ID, entityVersion: 2, text: "Frage?", state: "open" }) },
      briefings: { briefing_1: basis("briefing", "briefing_1", { entityVersion: 6, date: "2026-09-20", state: "open" }) },
      briefingAnswers: { answer_1: basis("briefing_answer", "answer_1", { briefingId: "briefing_1", questionId: "question_1", entityVersion: 2, state: "open" }) },
      documents: { document_1: basis("document", "document_1", { entityVersion: 3, title: "Vertrag", state: "registered" }) },
      assignments: { assignment_1: basis("assignment", "assignment_1", { runId: RUN_ID, entityVersion: 2, executor: "claude", state: "open", assignedTo: "claude-spezialist" }) },
      workerResults: { result_1: basis("worker_result", "result_1", { assignmentId: "assignment_1", entityVersion: 2, state: "returned", summary: "fertig" }) },
      runStatus: { status_1: basis("run_status", "status_1", { runId: RUN_ID, entityVersion: 1, state: "running", stage: "lesen" }) },
      policies: { policy_1: basis("policy", "policy_1", { entityVersion: 1, policyVersion: POLICY_VERSION, mode: "dry_run" }) },
    },
    automation: { schemaVersion: 3, dataRevision, idempotencyByKey: {} },
  };
  if (!ohneRun) {
    snapshot.entities.runs[RUN_ID] = basis("run", RUN_ID, {
      entityVersion: 5, slot: "09:00", date: "2026-09-20", state: "running",
      // Die aktive Bindung gehört dem Fachadapter (E1) — hier als Testdatum.
      activeLease: leaseOwner ? { holder: leaseOwner, expiresAt: leaseExpiresAt } : null,
    });
  }
  return snapshot;
}

/*
 * Ein Speicher mit CAS-Verhalten wie `mutateAppData`.
 */
export function makeStore({ snapshot = makeCoreSnapshot(), conflictsBefore = 0, alwaysConflict = false, unknownOutcome = false, attempts = 8 } = {}) {
  const spur = { reads: 0, mutates: 0, mutatorCalls: 0 };
  let stand = structuredClone(snapshot);
  return {
    spur,
    get snapshot() { return stand; },
    async readSnapshot() { spur.reads++; return structuredClone(stand); },
    async mutate(key, mutator, opts = {}) {
      spur.mutates++;
      for (let versuch = 0; versuch < attempts; versuch++) {
        const aktuell = structuredClone(stand);
        spur.mutatorCalls++;
        const ergebnis = mutator(aktuell);
        if (ergebnis && typeof ergebnis.then === "function") {
          throw Object.assign(new Error("async_mutator"), { code: "async_mutator", status: 500 });
        }
        const data = ergebnis && Object.hasOwn(ergebnis, "data") ? ergebnis.data : ergebnis;
        if (ergebnis?.unchanged === true) return { data, result: ergebnis.result ?? null };
        if (unknownOutcome) throw Object.assign(new Error("cas_outcome_unknown"), { code: "cas_outcome_unknown", status: 503 });
        if (alwaysConflict || versuch < conflictsBefore) continue;   // CAS-Konflikt
        stand = structuredClone(data);
        return { data, result: ergebnis?.result ?? null };
      }
      throw Object.assign(new Error("cas_exhausted"), { code: "cas_exhausted", status: 503 });
    },
  };
}

/* ── Idempotenz: echtes Modul, kontrolliert geladener Stand, sonst Nachbau ─ */
let geladen = null;
export async function idempotencyPort() {
  if (geladen) return geladen;

  // (a) Liegt das Modul im Checkout (Integrationszweig)?
  try {
    const echt = await import(path.join(root, "netlify/lib/quantus-v3-idempotency.mjs"));
    if (echt?.prepareIdempotentCommand && echt?.applyIdempotentCommand) {
      geladen = { source: "checkout", prepare: echt.prepareIdempotentCommand, apply: echt.applyIdempotentCommand };
      return geladen;
    }
  } catch { /* nicht vorhanden — weiter */ }

  // (b) Kontrolliert aus dem Git-Objektspeicher: genau der geprüfte Stand,
  //     in ein temporäres Verzeichnis, nicht ins Paket.
  try {
    const quelle = execFileSync("git", ["show", `${INTEGRATION_COMMIT}:netlify/lib/quantus-v3-idempotency.mjs`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (quelle && quelle.includes("applyIdempotentCommand")) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qv3-idem-"));
      const datei = path.join(dir, "quantus-v3-idempotency.mjs");
      fs.writeFileSync(datei, quelle);
      const echt = await import(datei);
      if (echt?.prepareIdempotentCommand && echt?.applyIdempotentCommand) {
        geladen = { source: `git:${INTEGRATION_COMMIT}`, prepare: echt.prepareIdempotentCommand, apply: echt.applyIdempotentCommand };
        return geladen;
      }
    }
  } catch { /* kein git, kein Objekt — weiter */ }

  // (c) Nachbildung. Sie erfüllt denselben Vertrag, ist aber KEIN
  //     Integrationsnachweis — die Tests sagen das ausdrücklich.
  geladen = { source: "stand-in", prepare: nachbauPrepare, apply: nachbauApply };
  return geladen;
}

const vorbereitet = new WeakSet();
function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function nachbauPrepare({ tenantId, principalId, key, command, requestId, now }) {
  for (const [wert, name] of [[tenantId, "tenant"], [principalId, "principal"], [key, "idempotency_key"], [requestId, "request_id"]]) {
    if (typeof wert !== "string" || !wert.length) throw Object.assign(new Error(`invalid_${name}`), { code: `invalid_${name}`, status: 400 });
  }
  if (typeof now !== "string" || new Date(now).toISOString() !== now) {
    throw Object.assign(new Error("invalid_server_time"), { code: "invalid_server_time", status: 500 });
  }
  const canonical = JSON.stringify(command);
  const prepared = Object.freeze({
    tenantId, principalId, requestId, now,
    ledgerKey: hash(JSON.stringify([tenantId, principalId, key])),
    requestHash: hash(canonical),
    command: JSON.parse(canonical),
  });
  vorbereitet.add(prepared);
  return prepared;
}

function nachbauApply(current, prepared, applyCommand) {
  if (!vorbereitet.has(prepared) || typeof applyCommand !== "function") {
    throw Object.assign(new Error("invalid_transaction_context"), { code: "invalid_transaction_context", status: 500 });
  }
  const automation = current?.automation;
  if (!automation || automation.schemaVersion !== 3 || !Number.isSafeInteger(automation.dataRevision) || !automation.idempotencyByKey) {
    throw Object.assign(new Error("automation_not_ready"), { code: "automation_not_ready", status: 503 });
  }
  const ledger = automation.idempotencyByKey;
  if (Object.hasOwn(ledger, prepared.ledgerKey)) {
    const beleg = ledger[prepared.ledgerKey];
    if (beleg.requestHash !== prepared.requestHash) {
      throw Object.assign(new Error("idempotency_conflict"), { code: "idempotency_conflict", status: 409 });
    }
    return { data: current, result: { ...structuredClone(beleg.response), replayed: true }, unchanged: true };
  }
  const reduziert = applyCommand(structuredClone(current), prepared.command, prepared);
  if (!reduziert?.data || !reduziert?.result) {
    throw Object.assign(new Error("command_result_invalid"), { code: "command_result_invalid", status: 500 });
  }
  const next = reduziert.data.automation;
  next.dataRevision = automation.dataRevision + 1;
  const response = {
    ...structuredClone(reduziert.result),
    ok: true, replayed: false, serverNow: prepared.now,
    dataRevision: next.dataRevision, requestId: prepared.requestId,
  };
  next.idempotencyByKey[prepared.ledgerKey] = {
    schemaVersion: 3, state: "committed", tenantId: prepared.tenantId,
    principalId: prepared.principalId, requestHash: prepared.requestHash,
    recordedAt: prepared.now, response: structuredClone(response),
  };
  return { data: reduziert.data, result: response };
}

/* ── Fachadapter-Ersatz ─────────────────────────────────────────────────── */
const SAMMLUNG = Object.freeze({
  lead: "leads", run: "runs", note: "notes", intake: "intakes", task: "tasks",
  question: "questions", briefing: "briefings", briefing_answer: "briefingAnswers",
  document: "documents", assignment: "assignments", worker_result: "workerResults",
  run_status: "runStatus", policy: "policies", run_context: "runs",
});

/* Welches Payload-Feld die Id einer NEUEN Ressource trägt (sonst wird eine
   vergeben). Der Adapter bestimmt das, nicht der Umschlag. */
const NEUE_ID_FELD = Object.freeze({
  "note.append": "noteId", "document.register": "documentId",
  "worker.assign": "assignmentId", "worker.return": "resultRef",
});

export function makeDomain({ listResult = null, binding = null, fehlendeRun = false } = {}) {
  const spur = { loads: [], resolves: 0, bindings: 0, applies: 0, pages: 0, bindingZeiten: [] };

  const laden = (snapshot, kind, id) => {
    const name = SAMMLUNG[kind];
    if (!name || !id) return null;
    const eintrag = snapshot?.entities?.[name]?.[id] || null;
    if (!eintrag) return null;
    return kind === "run_context" ? { ...eintrag, kind: "run_context" } : eintrag;
  };

  return {
    spur,
    loadObject(snapshot, { kind, id }) {
      spur.loads.push({ kind, id });
      return laden(snapshot, kind, id);
    },

    resolveTarget(snapshot, { verb, command, principal, descriptor }) {
      spur.resolves++;
      const p = command.payload;
      const res = descriptor.resource;
      const neu = (kind, id) => ({
        kind, id, tenant: principal.tenant, ownerId: principal.id,
        jobId: command.jobId, runId: command.jobId, leadId: p.leadId || null,
        assignedTo: principal.id, isNew: true, entityVersion: 0,
      });

      let ressource = null;
      if (res.idField) {
        ressource = laden(snapshot, res.kind, p[res.idField]);
      } else if (res.creates) {
        const feld = NEUE_ID_FELD[verb];
        ressource = neu(res.kind, feld ? p[feld] : `${res.kind}_neu`);
      } else if (res.ensure) {
        ressource = laden(snapshot, "run", command.jobId) || neu("run", command.jobId);
      } else {
        ressource = laden(snapshot, "run", command.jobId);
      }
      if (!ressource) return null;

      let anker = ressource;
      if (!descriptor.anchor.self) {
        anker = descriptor.anchor.idField
          ? laden(snapshot, descriptor.anchor.kind, p[descriptor.anchor.idField])
          : laden(snapshot, descriptor.anchor.kind, command.jobId);
      }
      if (!anker) return null;
      return { resource: ressource, anchor: anker };
    },

    /* Die aktive Bindung. Im echten Betrieb ist das die gemeinsame
       Leitungs-Lease (E1) bzw. die aktuelle Auftragszuweisung des
       Spezialisten; hier eine Attrappe, die mit `nowMs` rechnet. */
    assertActiveBinding({ snapshot, principal, jobId, nowMs, resource }) {
      spur.bindings++;
      spur.bindingZeiten.push(nowMs);
      if (typeof binding === "function") return binding({ snapshot, principal, jobId, nowMs, resource });
      if (principal.issuedBy !== "job_token") return { ok: true };
      const lauf = laden(snapshot, "run", jobId);
      if (!lauf) return { ok: false, reason: "run_not_found" };
      if (principal.role === "lead_agent") {
        const lease = lauf.activeLease;
        if (!lease || String(lease.holder || "") !== String(principal.id)) return { ok: false, reason: "lease_not_held" };
        const bis = Date.parse(String(lease.expiresAt || ""));
        if (!Number.isFinite(bis) || bis <= nowMs) return { ok: false, reason: "lease_expired" };
        return { ok: true };
      }
      // Spezialisten hängen nicht an der Leitungs-Lease, sondern an ihrer
      // aktuellen Zuweisung.
      const zuweisung = Object.values(snapshot?.entities?.assignments || {})
        .find((a) => String(a.assignedTo || "") === String(principal.id) && String(a.runId || "") === String(jobId));
      if (!zuweisung || zuweisung.state !== "open") return { ok: false, reason: "assignment_not_active" };
      return { ok: true };
    },

    applyVerb(snapshot, command, ctx, { resource }) {
      spur.applies++;
      const name = SAMMLUNG[resource.kind];
      const kopie = structuredClone(snapshot);
      kopie.entities[name] = kopie.entities[name] || {};
      const vorhanden = kopie.entities[name][resource.id];
      const eintrag = vorhanden || { ...resource, isNew: undefined, entityVersion: 0 };
      eintrag.entityVersion = (Number(eintrag.entityVersion) || 0) + 1;
      eintrag.updatedAt = ctx.now;
      kopie.entities[name][resource.id] = eintrag;
      return { data: kopie, result: { entityVersions: { [resource.id]: eintrag.entityVersion }, verb: command.verb } };
    },

    listPage(snapshot, { query, scopeId, pageSize, afterId }) {
      spur.pages++;
      if (listResult) return typeof listResult === "function" ? listResult({ query, scopeId, pageSize, afterId }) : listResult;
      const alle = Object.values(snapshot?.entities?.notes || {});
      const start = afterId ? alle.findIndex((n) => n.id === afterId) + 1 : 0;
      const teil = alle.slice(start, start + pageSize);
      const weiter = start + pageSize < alle.length;
      return { items: teil, hasMore: weiter, nextAfterId: weiter ? teil[teil.length - 1]?.id : null };
    },
  };
}

/* ── Ein atomarer, geteilter Zähler für Tests ───────────────────────────── */
export function makeRateLimiter({ limitReachedAfter = Infinity } = {}) {
  const zaehler = new Map();
  return {
    atomic: true,
    scope: "shared",
    multiInstanceSafe: true,
    async increment({ key, windowStartMs }) {
      const k = `${key}@${windowStartMs}`;
      const naechster = (zaehler.get(k) || 0) + 1;
      zaehler.set(k, naechster);
      return { count: naechster > limitReachedAfter ? 10_000 : naechster };
    },
  };
}

/* ── Eine Anfrage, wie sie der Dienst erwartet ──────────────────────────── */
export function makeRequest({
  method = "POST", url = "https://management-xo2-pro.netlify.app/.netlify/functions/quantus-ingest",
  headers = {}, body = null,
} = {}) {
  const map = new Map(Object.entries({ "x-forwarded-proto": "https", ...headers })
    .map(([k, v]) => [k.toLowerCase(), v]));
  const text = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return {
    method, url,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async text() { return text; },
  };
}

export function commandBody({ verb = "lead.comment", jobId = RUN_ID, expectedEntityVersion = 17, payload = null } = {}) {
  return {
    schemaVersion: 3, verb, jobId, expectedEntityVersion,
    payload: payload || { leadId: LEAD_ID, text: "...", evidenceRefs: ["artifact_456"] },
  };
}

export function commandHeaders({ token, idempotencyKey = null, contentType = "application/json", origin = null, validateOnly = false } = {}) {
  const kopf = {
    authorization: `Bearer ${token}`,
    "content-type": contentType,
    "idempotency-key": idempotencyKey || `test-${randomUUID()}`,
  };
  if (origin) kopf.origin = origin;
  if (validateOnly) kopf["x-quantus-validate-only"] = "1";
  return kopf;
}

export { TENANT, POLICY_VERSION };
