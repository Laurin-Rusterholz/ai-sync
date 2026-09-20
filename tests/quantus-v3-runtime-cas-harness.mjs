/* ══ CAS-Pruefstand fuer die v3-Laufzeitmutatoren ══════════════════════════
 *
 * Die produktive Schleife steht in netlify/lib/firebase-admin.mjs
 * (`mutateAppData`, acht Versuche, fail closed). Die gehaertete Fassung liegt
 * auf codex/quantus-v3-integration und NICHT auf diesem Zweig; ausserdem
 * haengt sie an Firebase-Zugangsdaten. Dieser Pruefstand bildet deshalb
 * GENAU deren dokumentierten Vertrag nach — mehr nicht:
 *
 *   · vor jedem Versuch wird der aktuelle Stand samt ETag gelesen
 *   · fehlender oder ungueltiger Kern bricht ab, BEVOR etwas geschrieben wird
 *   · der Mutator ist synchron; ein Promise ist ein Fehler
 *   · `unchanged: true` wird gegen den Eingangstext geprueft und schreibt NICHT
 *   · ein PUT gilt nur mit passendem If-Match; sonst neuer Versuch
 *   · nach acht Konflikten: cas_exhausted
 *
 * Damit laufen die Tests gegen die ECHTEN Mutatoren und gegen echte
 * konkurrierende Schnappschuesse — nicht gegen einen Mock, der immer ok sagt.
 * Was der Pruefstand NICHT beweist: dass der reale HTTP-/Firebase-Pfad sich
 * genauso verhaelt. Das gehoert in die Integration.
 * ═════════════════════════════════════════════════════════════════════════ */

export class CasError extends Error {
  constructor(code, status = 500) { super(code); this.code = code; this.status = status; }
}

export function createCasStore(initialData, { key = "app-data.json" } = {}) {
  let text = initialData === null ? null : JSON.stringify(initialData);
  let etag = 1;
  const stats = { reads: 0, puts: 0, conflicts: 0 };
  return {
    key,
    get stats() { return { ...stats }; },
    read() { stats.reads += 1; return { text, etag }; },
    snapshot() { return text === null ? null : JSON.parse(text); },
    /* Nur mit passendem ETag. Genau wie If-Match auf dem Serverknoten. */
    put(nextText, ifMatch) {
      if (ifMatch !== etag) { stats.conflicts += 1; return { ok: false, conflict: true }; }
      text = nextText; etag += 1; stats.puts += 1;
      return { ok: true, etag };
    },
    /* Ein fremder Schreibvorgang zwischen Lesen und Schreiben. */
    forceWrite(mutateFn) {
      const parsed = text === null ? null : JSON.parse(text);
      const updated = mutateFn(parsed);
      text = JSON.stringify(updated); etag += 1; stats.puts += 1;
      return etag;
    },
  };
}

export function casMutate(store, mutator, { attempts = 8, onAttempt = null } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = store.read();
    if (current.text == null) throw new CasError("core_unavailable", 503);
    let parsed;
    try { parsed = JSON.parse(current.text); } catch { throw new CasError("core_invalid", 503); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.entities !== "object" || parsed.entities === null) {
      throw new CasError("core_invalid", 503);
    }
    if (!current.etag) throw new CasError("cas_etag_missing", 503);
    const before = JSON.stringify(parsed);
    if (onAttempt) onAttempt(attempt, parsed);
    const mutation = mutator(parsed);
    if (mutation && typeof mutation.then === "function") {
      Promise.resolve(mutation).catch(() => {});
      throw new CasError("async_mutator", 500);
    }
    const data = mutation && Object.hasOwn(mutation, "data") ? mutation.data : mutation;
    if (data === null || typeof data !== "object" || typeof data.entities !== "object" || data.entities === null) {
      throw new CasError("mutation_invalid", 500);
    }
    const text = JSON.stringify(data);
    if (mutation.unchanged === true) {
      if (text !== before) throw new CasError("unchanged_mutation_invalid", 500);
      return { data, result: mutation.result ?? null, wrote: false, attempts: attempt + 1 };
    }
    const saved = store.put(text, current.etag);
    if (saved.ok) return { data, result: mutation.result ?? null, wrote: true, attempts: attempt + 1 };
  }
  throw new CasError("cas_exhausted", 503);
}

/* Zwei Laeufer lesen DENSELBEN Schnappschuss und wollen beide schreiben.
 * A kommt durch, B laeuft in den ETag-Konflikt und wiederholt gegen den
 * frischen Stand — genau die Situation, in der ein nicht wiederholbarer
 * Mutator doppelt arbeiten wuerde. */
export function casRace(store, mutatorA, mutatorB) {
  const shared = store.read();
  if (shared.text == null) throw new CasError("core_unavailable", 503);
  const snapshotA = JSON.parse(shared.text);
  const snapshotB = JSON.parse(shared.text);

  const outA = mutatorA(snapshotA);
  const outB = mutatorB(snapshotB);

  const commit = (out) => {
    if (out.unchanged === true) return { wrote: false, conflict: false };
    const saved = store.put(JSON.stringify(out.data), shared.etag);
    return { wrote: saved.ok === true, conflict: saved.conflict === true };
  };
  const commitA = commit(outA);
  const commitB = commit(outB);

  let retryB = null;
  if (commitB.conflict) retryB = casMutate(store, mutatorB);
  return {
    a: { result: outA.result, unchanged: outA.unchanged === true, ...commitA },
    b: { result: outB.result, unchanged: outB.unchanged === true, ...commitB },
    retryB,
    finalData: store.snapshot(),
  };
}

/* Ein minimaler, aber ECHTER Quantus-Kern: entities + migrierte automation.
 * Bewusst mit Fremdfeldern und _deleteLog, damit Tests belegen koennen, dass
 * nichts davon verloren geht. */
export function baseCore(overrides = {}) {
  return {
    meta: { updatedAt: "2026-03-01T00:00:00.000Z" },
    entities: {
      tasks: { t1: { id: "t1", status: "todo", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" } },
      chatgptLeads: {},
    },
    journal: { entries: [{ id: "j1", text: "unberuehrt" }] },
    _deleteLog: { "tasks:t0": { deletedAt: "2026-01-01T00:00:00.000Z" } },
    einUnbekanntesFeld: { bleibt: true },
    automation: {
      schemaVersion: 3,
      dataRevision: 7,
      idempotencyByKey: {},
      activeLease: null,
      jobsById: {},
      outboxById: {},
      ...(overrides.automation || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "automation")),
  };
}
