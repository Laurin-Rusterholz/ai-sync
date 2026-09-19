/*
 * Prüfmittel für C2: die echte Handler-Kette mit eingespeisten Transporten.
 *
 * Hier stehen KEINE Prüfungen, nur Attrappen — und zwar solche, die sich wie
 * das Original verhalten:
 *
 *  • `makeStore()` bildet `mutateAppData` nach: synchroner Mutator, bis zu
 *    acht CAS-Versuche, Konflikte, unklarer Ausgang, `unchanged`. Damit lässt
 *    sich ein 409/503 aus dem Speicherweg erzeugen, ohne Firebase.
 *  • `idempotencyPort()` nimmt das ECHTE Modul des Integrationsstandes, wenn
 *    es im Checkout liegt (`netlify/lib/quantus-v3-idempotency.mjs`). Fehlt es
 *    — wie in diesem Paketzweig —, tritt eine Nachbildung an seine Stelle, die
 *    denselben Vertrag erfüllt: ein Beleg je (Mandant, Principal, Schlüssel),
 *    Wiederholung nur bei gleichem Anfrage-Hash, sonst 409, und die
 *    Revision wird zusammen mit dem Beleg fortgeschrieben.
 *    Welche Fassung lief, sagt `idempotencyPort().source`.
 *  • `makeDomain()` ist ein Fachadapter-Ersatz für Tests. Der echte gehört in
 *    ein anderes Paket; ohne ihn antwortet die Kette 503 — auch das wird
 *    geprüft.
 *
 * Alle Schlüssel entstehen zur Laufzeit; kein Netz, kein Anbieteraufruf.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TENANT, POLICY_VERSION } from "./quantus-v3-auth-fixtures.mjs";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const RUN_ID = "job_20260920_42";
export const LEAD_ID = "lead_123";

/* ── Ein Kerndatensatz in der Form, die die Kette erwartet ──────────────── */
export function makeCoreSnapshot({ dataRevision = 7, leaseOwner = null, leaseExpiresAt = null, leadOwner = "uid-laurin" } = {}) {
  return {
    entities: {
      leads: {
        [LEAD_ID]: {
          kind: "lead", id: LEAD_ID, tenant: TENANT, ownerId: leadOwner,
          jobId: RUN_ID, assignedTo: null, entityVersion: 17,
          title: "Offerte Muster AG", state: "open", updatedAt: "2026-09-19T09:00:00Z",
          // Ein Feld, das NIE nach aussen darf:
          internalMailBody: "Sehr geehrte Frau Muster, anbei die Offerte …",
        },
        lead_fremd: {
          kind: "lead", id: "lead_fremd", tenant: TENANT, ownerId: "uid-fremd",
          jobId: RUN_ID, entityVersion: 3, title: "Fremd", state: "open",
        },
      },
      runs: {
        [RUN_ID]: {
          kind: "run", id: RUN_ID, tenant: TENANT, ownerId: "uid-laurin",
          jobId: RUN_ID, entityVersion: 5, slot: "09:00", date: "2026-09-20",
          state: "running", leaseOwner, leaseExpiresAt,
        },
      },
      notes: {
        note_1: { kind: "note", id: "note_1", tenant: TENANT, ownerId: "uid-laurin", jobId: RUN_ID, leadId: LEAD_ID, entityVersion: 2, text: "Notiz", createdAt: "2026-09-19T08:00:00Z" },
        note_2: { kind: "note", id: "note_2", tenant: TENANT, ownerId: "uid-laurin", jobId: RUN_ID, leadId: LEAD_ID, entityVersion: 1, text: "Zweite Notiz", createdAt: "2026-09-19T08:05:00Z" },
        note_3: { kind: "note", id: "note_3", tenant: TENANT, ownerId: "uid-laurin", jobId: RUN_ID, leadId: LEAD_ID, entityVersion: 1, text: "Dritte Notiz", createdAt: "2026-09-19T08:10:00Z" },
      },
    },
    automation: { schemaVersion: 3, dataRevision, idempotencyByKey: {} },
  };
}

/*
 * Ein Speicher mit CAS-Verhalten wie `mutateAppData`:
 *   conflictsBefore  so viele Versuche kollidieren, bevor einer gelingt
 *   alwaysConflict   jeder Versuch kollidiert ⇒ nach acht Versuchen 503
 *   unknownOutcome   der Schreibvorgang endet unklar ⇒ 503, nichts gilt
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

/* ── Idempotenz: echtes Modul, sonst vertragstreue Nachbildung ──────────── */
export async function idempotencyPort() {
  try {
    const echt = await import(path.join(root, "netlify/lib/quantus-v3-idempotency.mjs"));
    if (echt?.prepareIdempotentCommand && echt?.applyIdempotentCommand) {
      return { source: "integration", prepare: echt.prepareIdempotentCommand, apply: echt.applyIdempotentCommand };
    }
  } catch {
    // In diesem Paketzweig liegt das Modul nicht — Nachbildung.
  }
  return { source: "stand-in", prepare: nachbauPrepare, apply: nachbauApply };
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
export function makeDomain({ listResult = null } = {}) {
  const spur = { loads: [], applies: 0, pages: 0 };
  const sammlung = (kind) => ({ lead: "leads", run: "runs", note: "notes", run_context: "runs" }[kind] || null);
  return {
    spur,
    loadObject(snapshot, { kind, id }) {
      spur.loads.push({ kind, id });
      const name = sammlung(kind);
      if (!name) return null;
      const eintrag = snapshot?.entities?.[name]?.[id] || null;
      if (!eintrag) return null;
      if (kind === "run_context") return { ...eintrag, kind: "run_context" };
      return eintrag;
    },
    applyVerb(snapshot, command, ctx, { target }) {
      spur.applies++;
      const name = sammlung(target.kind);
      const kopie = structuredClone(snapshot);
      const eintrag = kopie.entities[name][target.id];
      eintrag.entityVersion += 1;
      eintrag.updatedAt = ctx.now;
      return { data: kopie, result: { entityVersions: { [target.id]: eintrag.entityVersion }, verb: command.verb } };
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

export function commandHeaders({ token, idempotencyKey = null, contentType = "application/json", origin = null } = {}) {
  const kopf = {
    authorization: `Bearer ${token}`,
    "content-type": contentType,
    "idempotency-key": idempotencyKey || `test-${randomUUID()}`,
  };
  if (origin) kopf.origin = origin;
  return kopf;
}

export { TENANT, POLICY_VERSION };
