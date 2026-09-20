/* ══ Paket E1-A: Lease, Fencing, Laufzeitgrenzen, Checkpoint ══════════════
 *
 * Produktionsbefund: im Domaenenkern (Paket B) stand ein Lease-Platzhalter
 * mit sechs Stunden Laufzeit, ohne Fence und ohne Ablaufsperre. Zwei Laeufer
 * mit demselben Namen haetten sich gegenseitig fuer gueltig gehalten, und
 * ein abgelaufener Besitzer haette weiter leitend geschrieben. Diese Datei
 * prueft den Ersatz mit echten Mutatoren, echten CAS-Schnappschuessen und
 * zwei gleichzeitigen Schreibern.
 *
 * Belegt (soweit ein Laufzeitpaket reichen kann): T19 (Ablauf und Fencing
 * weisen den alten Besitzer ab), T20 (doppelte Zustellung verliert und
 * verdoppelt keinen Auftrag), T24 (Zeit-/Schritterschoepfung fuehrt zu
 * Checkpoint und exception_open statt falschem Gruen), T07 (fehlender oder
 * unmigrierter Kern bricht vor jeder Mutation ab).
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../netlify/lib/quantus-v3-runtime-state.mjs";
import * as P from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { createCasStore, casMutate, casRace, baseCore, CasError } from "./quantus-v3-runtime-cas-harness.mjs";

const SCOPE = "quantus:mainrun";
const T0 = Date.parse("2026-09-19T08:00:00.000Z");
const RUNKEY = P.slotRunKey("quantus", "2026-09-19", "process09", "3.0");

function scope(holder, fence) { return { holder, fence, scope: SCOPE }; }

/* Nimmt einen Lauf in Besitz und liefert den Bestand samt Fence. */
function mitLease(data, holder = "runner-a", now = T0) {
  const out = S.acquireLease(data, { holder, scope: SCOPE, now });
  assert.equal(out.result.ok, true);
  return { data: out.data, fence: out.result.fence, verified: scope(holder, out.result.fence) };
}

/* ── Fail closed auf dem Kern ──────────────────────────────────────────── */

test("T07 fehlender, kaputter oder unmigrierter Kern wird nie aus null angelegt", () => {
  const faelle = [
    [null, "core_invalid"],
    [{}, "core_invalid"],
    [{ entities: {} }, "automation_not_ready"],
    [{ entities: {}, automation: { schemaVersion: 2, dataRevision: 0, idempotencyByKey: {} } }, "automation_not_ready"],
    [{ entities: {}, automation: { schemaVersion: 3, dataRevision: -1, idempotencyByKey: {} } }, "automation_not_ready"],
    [{ entities: {}, automation: { schemaVersion: 3, dataRevision: 0 } }, "automation_not_ready"],
  ];
  for (const [data, code] of faelle) {
    assert.throws(() => S.acquireLease(data, { holder: "r", scope: SCOPE, now: T0 }),
      (e) => e instanceof S.RuntimeStateError && e.code === code && e.status === 503, JSON.stringify(data));
  }
  // Ein CAS-Lauf ohne Dokument schreibt gar nichts.
  const leer = createCasStore(null);
  assert.throws(() => casMutate(leer, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })),
    (e) => e instanceof CasError && e.code === "core_unavailable");
  assert.equal(leer.stats.puts, 0);
});

test("unbekannte Felder und _deleteLog ueberleben jede Mutation", () => {
  const store = createCasStore(baseCore());
  const lauf = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const nachher = store.snapshot();
  assert.deepEqual(nachher.einUnbekanntesFeld, { bleibt: true });
  assert.deepEqual(nachher._deleteLog, { "tasks:t0": { deletedAt: "2026-01-01T00:00:00.000Z" } });
  assert.deepEqual(nachher.journal, { entries: [{ id: "j1", text: "unberuehrt" }] });
  assert.deepEqual(nachher.entities.tasks.t1, baseCore().entities.tasks.t1);
  assert.equal(nachher.automation.dataRevision, 8, "genau eine Revision weiter");
  assert.equal(nachher.automation.jobsById !== undefined, true, "fremde automation-Bereiche bleiben");
  assert.equal(lauf.wrote, true);
});

/* ── T19: Lease und Fencing ────────────────────────────────────────────── */

test("T19 ein neuer Besitz erhaelt einen streng hoeheren Fence — auch derselbe Besitzer nach Ablauf", () => {
  const store = createCasStore(baseCore());
  const erst = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  assert.equal(erst.result.fence, 1);
  const abgelaufen = T0 + S.LEASE_TTL_MS + 1;
  const zweit = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: abgelaufen }));
  assert.equal(zweit.result.fence, 2, "derselbe Name, aber ein neuer Besitz");
  assert.deepEqual(zweit.result.takeoverFrom, { holder: "runner-a", fence: 1, expiredAtMs: T0 + S.LEASE_TTL_MS });
  const dritt = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-b", scope: SCOPE, now: abgelaufen + S.LEASE_TTL_MS + 1 }));
  assert.equal(dritt.result.fence, 3);
});

test("T19 der Fence-Zaehler ueberlebt das Freigeben", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  casMutate(store, (d) => S.releaseLease(d, { holder: "runner-a", fence: a.result.fence, scope: SCOPE, now: T0 + 1000 }));
  assert.equal(store.snapshot().automation.activeLease, null);
  assert.equal(store.snapshot().automation.runtime.leaseFenceCounter, 1);
  const b = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 + 2000 }));
  assert.equal(b.result.fence, 2, "nach Release faengt der Zaehler NICHT wieder bei 1 an");
});

test("T19 ein fremder aktiver Besitzer ist ein Konflikt, kein Schreibvorgang", () => {
  const store = createCasStore(baseCore());
  casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const vorher = store.stats.puts;
  const konflikt = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-b", scope: SCOPE, now: T0 + 1000 }));
  assert.equal(konflikt.result.ok, false);
  assert.equal(konflikt.result.code, "lease_held");
  assert.equal(konflikt.wrote, false);
  assert.equal(store.stats.puts, vorher, "eine Absage schreibt nichts");
});

test("T19 duplicateClaim desselben Besitzers erzeugt keinen zweiten Fence", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const nochmal = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 + 5000 }));
  assert.equal(nochmal.result.ok, true);
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(nochmal.result.acquired, false);
  assert.equal(nochmal.result.fence, a.result.fence);
  assert.equal(nochmal.wrote, false, "kein PUT fuer eine doppelte Zustellung");
});

test("T19 Erneuern und Freigeben verlangen exakt holder UND fence, nicht nur den Namen", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const fence = a.result.fence;
  for (const falsch of [
    { holder: "runner-a", fence: fence + 1 },
    { holder: "runner-b", fence },
    { holder: "runner-a", fence, scope: "quantus:anderes" },
  ]) {
    const r = casMutate(store, (d) => S.renewLease(d, { scope: SCOPE, ...falsch, now: T0 + 1000 }));
    assert.equal(r.result.ok, false, JSON.stringify(falsch));
    assert.equal(r.result.code, "lease_fenced");
    const f = casMutate(store, (d) => S.releaseLease(d, { scope: SCOPE, ...falsch, now: T0 + 1000 }));
    assert.equal(f.result.code, "lease_fenced");
  }
  assert.equal(store.snapshot().automation.activeLease.fence, fence, "der echte Besitz blieb unangetastet");
});

test("T19 eine Erneuerung nach Ablauf ist keine Wiederbelebung", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const zuSpaet = T0 + S.LEASE_TTL_MS;
  const r = casMutate(store, (d) => S.renewLease(d, { holder: "runner-a", fence: a.result.fence, scope: SCOPE, now: zuSpaet }));
  assert.equal(r.result.ok, false);
  assert.equal(r.result.code, "lease_expired");
  assert.equal(r.wrote, false);
  assert.equal(store.snapshot().automation.activeLease.expiresAtMs, zuSpaet, "der Ablauf wurde nicht verschoben");
});

test("T19 eine spaete, aber noch gueltige Erneuerung wird als solche gemeldet", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const puenktlich = casMutate(store, (d) => S.renewLease(d, { holder: "runner-a", fence: a.result.fence, scope: SCOPE, now: T0 + 30_000 }));
  assert.equal(puenktlich.result.lateRenewal, false);
  const spaet = casMutate(store, (d) => S.renewLease(d, { holder: "runner-a", fence: a.result.fence, scope: SCOPE, now: T0 + 30_000 + S.LEASE_RENEW_AFTER_MS + 1 }));
  assert.equal(spaet.result.ok, true);
  assert.equal(spaet.result.lateRenewal, true);
  assert.equal(S.LEASE_TTL_MS, 120_000);
  assert.equal(S.LEASE_RENEW_AFTER_MS, 60_000);
});

test("T19 TTL-Eingaben werden streng geprueft: NaN, negativ, zu lang", () => {
  const data = baseCore();
  for (const ttl of [NaN, -1, 0, 1.5, "120000", S.LEASE_MAX_TTL_MS + 1, 6 * 60 * 60 * 1000]) {
    assert.throws(() => S.acquireLease(data, { holder: "r", scope: SCOPE, now: T0, ttlMs: ttl }),
      (e) => e.code === "invalid_ttl", `ttl ${String(ttl)}`);
  }
  assert.throws(() => S.acquireLease(data, { holder: "r", scope: SCOPE, now: -1 }), /invalid_timestamp/);
  assert.throws(() => S.acquireLease(data, { holder: "r", scope: SCOPE, now: NaN }), /invalid_timestamp/);
  assert.throws(() => S.acquireLease(data, { holder: "hat leerzeichen", scope: SCOPE, now: T0 }), /invalid_identifier/);
});

test("T19 ein abgelaufener Besitzer darf keine leitende Mutation mehr machen", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const verified = scope("runner-a", a.result.fence);
  const nachAblauf = T0 + S.LEASE_TTL_MS + 1;
  assert.equal(S.checkLeadership(store.snapshot(), verified, T0 + 1000).ok, true);
  assert.equal(S.checkLeadership(store.snapshot(), verified, nachAblauf).code, "lease_expired");
  assert.throws(() => S.assertLeadership(store.snapshot(), verified, nachAblauf), (e) => e.code === "lease_expired" && e.status === 409);
  assert.throws(() => S.startRunSection(store.snapshot(), {
    runKey: RUNKEY, sectionId: "s1", now: nachAblauf, verifiedScope: verified,
  }), (e) => e.code === "lease_expired");
});

test("T19 ein alter Lease-Eintrag ohne Fence wird nicht umgedeutet, sondern gesperrt", () => {
  // Der Sechs-Stunden-Platzhalter aus Paket B in seiner alten Form.
  const alt = baseCore({ automation: {
    schemaVersion: 3, dataRevision: 7, idempotencyByKey: {},
    activeLease: { holder: "codex", acquiredAt: "2026-09-19T08:00:00.000Z", expiresAt: "2026-09-19T14:00:00.000Z", revision: 3 },
  } });
  assert.throws(() => S.acquireLease(alt, { holder: "runner-a", scope: SCOPE, now: T0 }),
    (e) => e.code === "lease_record_invalid" && e.status === 503);
  assert.throws(() => S.checkLeadership(alt, scope("codex", 1), T0), (e) => e.code === "lease_record_invalid");
});

test("Nutzeraktionen werden nicht pauschal gesperrt, waehrend ein Laeufer fuehrt", () => {
  assert.equal(S.requiresLeadership("runner"), true);
  assert.equal(S.requiresLeadership("user"), false);
  assert.equal(S.requiresLeadership("monitor"), false);
  assert.throws(() => S.requiresLeadership("wer-auch-immer"), /unknown_origin/);

  const store = createCasStore(baseCore());
  casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  // Eine gewoehnliche Nutzeraenderung am Bestand laeuft durch denselben CAS.
  const nutzer = casMutate(store, (d) => {
    d.entities.tasks.t2 = { id: "t2", status: "todo", createdAt: "x", updatedAt: "x" };
    return { data: d, result: { ok: true } };
  });
  assert.equal(nutzer.wrote, true);
  assert.equal(store.snapshot().entities.tasks.t2.id, "t2");
  assert.equal(store.snapshot().automation.activeLease.holder, "runner-a", "der Besitz blieb unberuehrt");
});

/* ── Echte Konkurrenz auf demselben Schnappschuss ──────────────────────── */

test("T19 zwei Laeufer auf DEMSELBEN Schnappschuss: nur einer bekommt den Besitz", () => {
  const store = createCasStore(baseCore());
  const rennen = casRace(
    store,
    (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }),
    (d) => S.acquireLease(d, { holder: "runner-b", scope: SCOPE, now: T0 }),
  );
  assert.equal(rennen.a.result.ok, true);
  assert.equal(rennen.a.wrote, true);
  assert.equal(rennen.b.conflict, true, "B lief in den ETag-Konflikt");
  // Nach der Wiederholung gegen den frischen Stand sieht B den fremden Besitz.
  assert.equal(rennen.retryB.result.ok, false);
  assert.equal(rennen.retryB.result.code, "lease_held");
  assert.equal(rennen.retryB.wrote, false);
  assert.equal(rennen.finalData.automation.activeLease.holder, "runner-a");
  assert.equal(rennen.finalData.automation.activeLease.fence, 1);
  assert.equal(store.stats.puts, 1, "genau ein Schreibvorgang");
});

test("T19 zwei gleichzeitige Uebernahmen nach Ablauf ergeben nie denselben Fence", () => {
  const store = createCasStore(baseCore());
  casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const spaeter = T0 + S.LEASE_TTL_MS + 1;
  const rennen = casRace(
    store,
    (d) => S.acquireLease(d, { holder: "runner-b", scope: SCOPE, now: spaeter }),
    (d) => S.acquireLease(d, { holder: "runner-c", scope: SCOPE, now: spaeter }),
  );
  assert.equal(rennen.a.result.fence, 2);
  assert.equal(rennen.b.conflict, true);
  assert.equal(rennen.retryB.result.ok, false, "B sieht den frischen Besitz von runner-b");
  assert.equal(rennen.retryB.result.code, "lease_held");
  assert.equal(rennen.finalData.automation.runtime.leaseFenceCounter, 2);
});

test("eine unveraenderte Wiederholung erzeugt keinen PUT, auch im Rennen nicht", () => {
  const store = createCasStore(baseCore());
  const a = casMutate(store, (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 }));
  const vorher = store.stats.puts;
  const rennen = casRace(
    store,
    (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 + 1000 }),
    (d) => S.acquireLease(d, { holder: "runner-a", scope: SCOPE, now: T0 + 1001 }),
  );
  assert.equal(rennen.a.unchanged, true);
  assert.equal(rennen.b.unchanged, true);
  assert.equal(store.stats.puts, vorher, "zwei doppelte Zustellungen, null Schreibvorgaenge");
  assert.equal(a.result.fence, 1);
});

/* ── T24: Laufzeitgrenzen ──────────────────────────────────────────────── */

test("T24 20 Minuten aktive Laufzeit und 30 Werkzeugschritte sind harte Grenzen", () => {
  assert.equal(S.RUN_MAX_ACTIVE_MS, 20 * 60_000);
  assert.equal(S.RUN_MAX_TOOL_STEPS, 30);
  assert.equal(S.HTTP_SECTION_MAX_MS, 90_000);

  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const verified = scope("r", fence);
  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s1", kind: "work", now: T0, verifiedScope: verified }));

  let letzte = null;
  for (let i = 1; i <= 30; i++) {
    letzte = casMutate(store, (d) => S.recordToolStep(d, {
      runKey: RUNKEY, sectionId: "s1", stepId: `step-${i}`, now: T0 + i * 1000,
      durationMs: 30_000, verifiedScope: verified,
    })).result;
  }
  assert.equal(letzte.toolSteps, 30);
  assert.equal(letzte.activeMs, 900_000);
  assert.equal(letzte.budget.remainingToolSteps, 0);
  assert.equal(letzte.mustCheckpoint, true);
  assert.deepEqual([...letzte.budget.reasons], ["run_tool_steps_exhausted"]);

  // Solange s1 offen ist, entsteht gar kein zweiter Abschnitt.
  const parallel = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s2", now: T0 + 60_000, verifiedScope: verified }));
  assert.equal(parallel.result.code, "section_already_open");
  assert.equal(parallel.result.detail.openSectionId, "s1");
  assert.equal(parallel.wrote, false);

  // Und nach einem geordneten Checkpoint ist das Schrittbudget aufgebraucht.
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: RUNKEY, sectionId: "s1", checkpointId: "cp-30", continuationId: "cont-30",
    reason: "budget", cursor: {}, now: T0 + 61_000, verifiedScope: verified,
  }));
  const abgelehnt = casMutate(store, (d) => S.startRunSection(d, {
    runKey: RUNKEY, sectionId: "s2", now: T0 + 62_000, verifiedScope: verified, resumeFrom: "cont-30",
  }));
  assert.equal(abgelehnt.result.ok, false);
  assert.equal(abgelehnt.result.code, "budget_exhausted");
  assert.deepEqual(abgelehnt.result.detail.reasons, ["run_tool_steps_exhausted"]);
  assert.equal(abgelehnt.wrote, false);
});

test("T24 der HTTP-Abschnitt ist auf 90 Sekunden begrenzt und die Ueberschreitung wird sichtbar", () => {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const verified = scope("r", fence);
  const zuGross = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "h0", kind: "http", budgetMs: 120_000, now: T0, verifiedScope: verified }));
  assert.equal(zuGross.result.code, "http_budget_too_large");

  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "h1", kind: "http", now: T0, verifiedScope: verified }));
  const drin = casMutate(store, (d) => S.recordToolStep(d, { runKey: RUNKEY, sectionId: "h1", stepId: "x1", now: T0 + 80_000, durationMs: 80_000, verifiedScope: verified }));
  assert.equal(drin.result.violations.length, 0);
  const drueber = casMutate(store, (d) => S.recordToolStep(d, { runKey: RUNKEY, sectionId: "h1", stepId: "x2", now: T0 + 95_000, durationMs: 1000, verifiedScope: verified }));
  assert.deepEqual(drueber.result.violations, ["http_section_exceeded"]);
  assert.equal(drueber.result.mustCheckpoint, true);
  assert.deepEqual(store.snapshot().automation.runtime.runsByKey[RUNKEY].violations, ["http_section_exceeded"]);
});

/* ── T20: Checkpoint und doppelte Zustellung ───────────────────────────── */

function laufMitCheckpoint(now = T0) {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now })).result;
  const verified = scope("r", fence);
  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s1", now, verifiedScope: verified }));
  const cp = casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: RUNKEY, sectionId: "s1", checkpointId: "cp-1", continuationId: "cont-1",
    reason: "time_budget", cursor: { lastLeadId: "L7", page: 3 }, now: now + 1000, verifiedScope: verified,
  }));
  return { store, verified, cp };
}

test("T24 vor dem Ende steht ein dauerhafter Checkpoint mit genau EINER Fortsetzungsabsicht", () => {
  const { store, cp } = laufMitCheckpoint();
  assert.equal(cp.result.ok, true);
  const run = store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.equal(run.phase, "checkpointed");
  assert.equal(run.green, false);
  assert.deepEqual(run.checkpoint.cursor, { lastLeadId: "L7", page: 3 });
  assert.equal(run.pendingContinuationId, "cont-1");
  const intent = store.snapshot().automation.runtime.continuationsById["cont-1"];
  assert.equal(intent.state, "pending");
  assert.equal(intent.runKey, RUNKEY);
  assert.equal(intent.deliveries, 0);
});

test("T20 derselbe Checkpoint doppelt zugestellt schreibt kein zweites Mal", () => {
  const { store, verified } = laufMitCheckpoint();
  const vorher = store.stats.puts;
  const nochmal = casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: RUNKEY, sectionId: "s1", checkpointId: "cp-1", continuationId: "cont-1",
    reason: "time_budget", cursor: { lastLeadId: "L7", page: 3 }, now: T0 + 9999, verifiedScope: verified,
  }));
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(nochmal.wrote, false);
  assert.equal(store.stats.puts, vorher);
});

test("T20 eine zweite, ANDERE Fortsetzungsabsicht fuer denselben Lauf ist ein Konflikt", () => {
  const { store, verified } = laufMitCheckpoint();
  const zweit = casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: RUNKEY, sectionId: "s1", checkpointId: "cp-2", continuationId: "cont-2",
    reason: "time_budget", cursor: {}, now: T0 + 2000, verifiedScope: verified,
  }));
  assert.equal(zweit.result.ok, false);
  assert.equal(zweit.result.code, "continuation_conflict");
  assert.equal(zweit.wrote, false);
});

test("T20 derselbe Job doppelt zugestellt erzeugt keine zweite Arbeit", () => {
  const { store, verified } = laufMitCheckpoint();
  const erst = casMutate(store, (d) => S.recordContinuationDelivery(d, { continuationId: "cont-1", deliveryId: "dlv-1", now: T0 + 3000 }));
  assert.equal(erst.result.work, true);
  assert.equal(erst.result.deliveries, 1);
  // Exakt dieselbe Zustellung noch einmal (Netz-Wiederholung).
  const gleich = casMutate(store, (d) => S.recordContinuationDelivery(d, { continuationId: "cont-1", deliveryId: "dlv-1", now: T0 + 3100 }));
  assert.equal(gleich.result.duplicate, true);
  assert.equal(gleich.result.work, false);
  assert.equal(gleich.wrote, false);
  // Eine zweite Zustellung desselben Jobs (anderer Zustellversuch).
  const zweit = casMutate(store, (d) => S.recordContinuationDelivery(d, { continuationId: "cont-1", deliveryId: "dlv-2", now: T0 + 3200 }));
  assert.equal(zweit.result.duplicate, true);
  assert.equal(zweit.result.deliveries, 2);

  // Erst der Abschnitt verbraucht die Absicht — und zwar genau einmal.
  const fort = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s2", now: T0 + 4000, verifiedScope: verified, resumeFrom: "cont-1" }));
  assert.equal(fort.result.started, true);
  assert.equal(store.snapshot().automation.runtime.continuationsById["cont-1"].state, "consumed");

  const zweiterVersuch = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s3", now: T0 + 5000, verifiedScope: verified, resumeFrom: "cont-1" }));
  assert.equal(zweiterVersuch.result.duplicate, true);
  assert.equal(zweiterVersuch.result.alreadyConsumed, true);
  assert.equal(zweiterVersuch.wrote, false, "kein zweiter Abschnitt aus derselben Absicht");
  assert.equal(Object.keys(store.snapshot().automation.runtime.runsByKey[RUNKEY].sections).length, 2);
});

test("T20 zwei Laeufer verbrauchen dieselbe Fortsetzung auf demselben Schnappschuss nur einmal", () => {
  const { store, verified } = laufMitCheckpoint();
  const rennen = casRace(
    store,
    (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "sA", now: T0 + 4000, verifiedScope: verified, resumeFrom: "cont-1" }),
    (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "sB", now: T0 + 4000, verifiedScope: verified, resumeFrom: "cont-1" }),
  );
  assert.equal(rennen.a.result.started, true);
  assert.equal(rennen.b.conflict, true);
  assert.equal(rennen.retryB.result.ok, true);
  assert.equal(rennen.retryB.result.alreadyConsumed, true, "B arbeitet nicht ein zweites Mal");
  assert.equal(rennen.retryB.wrote, false);
  const run = store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.deepEqual(Object.keys(run.sections).sort(), ["s1", "sA"]);
  assert.deepEqual(run.consumedContinuationIds, ["cont-1"]);
});

test("nach einem Checkpoint kann kein Abschnitt ohne Fortsetzungsnachweis starten", () => {
  const { store, verified } = laufMitCheckpoint();
  const ohne = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "sX", now: T0 + 4000, verifiedScope: verified }));
  assert.equal(ohne.result.code, "continuation_required");
  const fremd = casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "sX", now: T0 + 4000, verifiedScope: verified, resumeFrom: "cont-unbekannt" }));
  assert.equal(fremd.result.code, "continuation_conflict", "der Lauf wartet auf cont-1, nicht auf irgendetwas");
  assert.equal(fremd.wrote, false);

  // Ohne offene Fortsetzung ist eine unbekannte Kennung schlicht unbekannt.
  const frischerStore = createCasStore(baseCore());
  const f = casMutate(frischerStore, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const unbekannt = casMutate(frischerStore, (d) => S.startRunSection(d, {
    runKey: RUNKEY, sectionId: "sY", now: T0, verifiedScope: scope("r", f.fence), resumeFrom: "gibt-es-nicht",
  }));
  assert.equal(unbekannt.result.code, "continuation_unknown");
  assert.equal(unbekannt.wrote, false);
});

/* ── Spaetfenster 23:00 / 23:30 ────────────────────────────────────────── */

const SPAET_KEY = P.slotRunKey("quantus", "2026-09-19", "close23", "3.0");
const SPAET_START = P.wallTimeToMs("2026-09-19", 23, 0);

/* Ein echter Lauf muss seinen Besitz erneuern — 120 Sekunden sind schnell um. */
function erneuere(store, verified, now) {
  const r = casMutate(store, (d) => S.renewLease(d, { holder: verified.holder, fence: verified.fence, scope: verified.scope, now }));
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  return r;
}

function spaetLauf(now = SPAET_START) {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now })).result;
  const verified = scope("r", fence);
  casMutate(store, (d) => S.startRunSection(d, { runKey: SPAET_KEY, sectionId: "c0", now, verifiedScope: verified }));
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c0", checkpointId: "cp0", continuationId: "k0",
    reason: "slot_budget", cursor: {}, now: now + 1000, verifiedScope: verified,
  }));
  return { store, verified };
}

test("T24 am 23-Uhr-Slot gibt es hoechstens zwei weitere Abschnitte zu je 5 Minuten — nur mit Budget", () => {
  const { store, verified } = spaetLauf();
  const ohneBudget = casMutate(store, (d) => S.startRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c1", kind: "late", now: SPAET_START + 2000, verifiedScope: verified, resumeFrom: "k0",
  }));
  assert.equal(ohneBudget.result.code, "late_section_without_budget");

  const zuLang = casMutate(store, (d) => S.startRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c1", kind: "late", budgetMs: 10 * 60_000,
    now: SPAET_START + 2000, verifiedScope: verified, resumeFrom: "k0", budgetAvailable: true,
  }));
  assert.equal(zuLang.result.code, "late_budget_too_large");

  const eins = casMutate(store, (d) => S.startRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c1", kind: "late", now: SPAET_START + 2000, verifiedScope: verified, resumeFrom: "k0", budgetAvailable: true,
  }));
  assert.equal(eins.result.budgetMs, 5 * 60_000);
  assert.equal(eins.result.lateSections, 1);

  for (let t = 60_000; t <= 5 * 60_000; t += 60_000) erneuere(store, verified, SPAET_START + t);
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c1", checkpointId: "cp1", continuationId: "k1", reason: "late", cursor: {},
    now: SPAET_START + 5 * 60_000, verifiedScope: verified,
  }));
  const zwei = casMutate(store, (d) => S.startRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c2", kind: "late", now: SPAET_START + 5 * 60_000 + 1000, verifiedScope: verified, resumeFrom: "k1", budgetAvailable: true,
  }));
  assert.equal(zwei.result.lateSections, 2);

  for (let t = 6 * 60_000; t <= 11 * 60_000; t += 60_000) erneuere(store, verified, SPAET_START + t);
  casMutate(store, (d) => S.checkpointRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c2", checkpointId: "cp2", continuationId: "k2", reason: "late", cursor: {},
    now: SPAET_START + 10 * 60_000, verifiedScope: verified,
  }));
  const drei = casMutate(store, (d) => S.startRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c3", kind: "late", now: SPAET_START + 11 * 60_000, verifiedScope: verified, resumeFrom: "k2", budgetAvailable: true,
  }));
  assert.equal(drei.result.ok, false);
  assert.equal(drei.result.code, "late_sections_exhausted");
});

test("T24 um 23:30 ist Schluss: exception_open statt falschem Gruen", () => {
  const { store, verified } = spaetLauf();
  const hartStop = P.lateWindow("2026-09-19").hardStopAtMs;
  for (let t = 60_000; t <= 30 * 60_000; t += 60_000) erneuere(store, verified, SPAET_START + t);
  const zuSpaet = casMutate(store, (d) => S.startRunSection(d, {
    runKey: SPAET_KEY, sectionId: "c9", kind: "late", now: hartStop, verifiedScope: verified, resumeFrom: "k0", budgetAvailable: true,
  }));
  assert.equal(zuSpaet.result.code, "late_hard_stop");

  const aus = casMutate(store, (d) => S.openException(d, {
    runKey: SPAET_KEY, exceptionId: "ex1", reason: "late_hard_stop", now: hartStop,
    verifiedScope: verified, continuationId: "k0", notBeforeMs: P.wallTimeToMs("2026-09-20", 4, 0), cursor: { rest: 4 },
  }));
  assert.equal(aus.result.exceptionOpen, true);
  assert.equal(aus.result.green, false);
  const snap = store.snapshot().automation.runtime;
  assert.equal(snap.runsByKey[SPAET_KEY].phase, "exception_open");
  assert.equal(snap.runsByKey[SPAET_KEY].green, false);
  assert.equal(snap.incidentsById[aus.result.incidentId].kind, "run_exception");
  // Die sichere naechste Fortsetzung steht bereit, ohne sofort zu laufen.
  assert.equal(snap.continuationsById["k0"].state, "pending");
  assert.equal(snap.runsByKey[SPAET_KEY].pendingContinuationId, "k0");

  const nochmal = casMutate(store, (d) => S.openException(d, {
    runKey: SPAET_KEY, exceptionId: "ex1", reason: "late_hard_stop", now: hartStop + 5000,
    verifiedScope: verified, continuationId: "k0",
  }));
  assert.equal(nochmal.result.duplicate, true);
  assert.equal(nochmal.wrote, false);
});

test("ein nicht angebundener Laeufer kann kein Gruen erzeugen", () => {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const verified = scope("r", fence);
  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s1", now: T0, verifiedScope: verified }));

  const dryRun = casMutate(store, (d) => S.finishRun(d, { runKey: RUNKEY, outcome: "completed", now: T0 + 1000, verifiedScope: verified, evidenceRef: "beleg-1" }));
  assert.equal(dryRun.result.ok, false);
  assert.equal(dryRun.result.code, "false_green_blocked");
  assert.deepEqual(dryRun.result.detail.blockers, ["runner_dry_run"]);

  const ohneBeleg = casMutate(store, (d) => S.finishRun(d, { runKey: RUNKEY, outcome: "completed", now: T0 + 1000, verifiedScope: verified, runnerMode: "live" }));
  assert.deepEqual(ohneBeleg.result.detail.blockers, ["missing_evidence"]);

  const echt = casMutate(store, (d) => S.finishRun(d, { runKey: RUNKEY, outcome: "dry_run", now: T0 + 2000, verifiedScope: verified }));
  assert.equal(echt.result.green, false);
  assert.equal(store.snapshot().automation.runtime.runsByKey[RUNKEY].green, false);
  assert.equal(store.snapshot().automation.runtime.runsByKey[RUNKEY].phase, "finished");

  const wieder = casMutate(store, (d) => S.finishRun(d, { runKey: RUNKEY, outcome: "dry_run", now: T0 + 3000, verifiedScope: verified }));
  assert.equal(wieder.result.duplicate, true);
  assert.equal(wieder.wrote, false);
});

test("ein Lauf mit offener Fortsetzung kann nicht abgeschlossen werden", () => {
  const { store, verified } = laufMitCheckpoint();
  const r = casMutate(store, (d) => S.finishRun(d, {
    runKey: RUNKEY, outcome: "completed", now: T0 + 5000, verifiedScope: verified,
    runnerMode: "live", evidenceRef: "beleg-9",
  }));
  assert.equal(r.result.code, "false_green_blocked");
  assert.deepEqual(r.result.detail.blockers, ["pending_continuation"]);
});

/* ── Eingabepruefung ───────────────────────────────────────────────────── */

test("Laufschluessel und Kennungen werden streng geprueft", () => {
  const store = createCasStore(baseCore());
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const verified = scope("r", fence);
  const data = store.snapshot();
  assert.throws(() => S.startRunSection(data, { runKey: "quantus:2026-09-19:kein-slot:3.0", sectionId: "s", now: T0, verifiedScope: verified }), /unknown_slot/);
  assert.throws(() => S.startRunSection(data, { runKey: RUNKEY, sectionId: "s", kind: "fantasie", now: T0, verifiedScope: verified }), /unknown_section_kind/);
  assert.throws(() => S.startRunSection(data, { runKey: RUNKEY, sectionId: "s", now: T0, verifiedScope: { holder: "r", fence: 0, scope: SCOPE } }), /invalid_verified_scope/);
  assert.throws(() => S.startRunSection(data, { runKey: RUNKEY, sectionId: "s", now: T0, verifiedScope: { holder: "r", fence: 1.5, scope: SCOPE } }), /invalid_verified_scope/);
  assert.throws(() => S.checkpointRunSection(data, {
    runKey: RUNKEY, sectionId: "s1", checkpointId: "c", continuationId: "k", reason: "r",
    cursor: { gross: "x".repeat(9000) }, now: T0, verifiedScope: verified,
  }), (e) => e.code === "record_too_large" && e.status === 413);
});

test("der gesamte Laufzeitzustand liegt unter automation.runtime — kein zweiter Bestand", () => {
  const vorher = baseCore();
  const store = createCasStore(vorher);
  const { fence } = casMutate(store, (d) => S.acquireLease(d, { holder: "r", scope: SCOPE, now: T0 })).result;
  const verified = scope("r", fence);
  casMutate(store, (d) => S.startRunSection(d, { runKey: RUNKEY, sectionId: "s1", now: T0, verifiedScope: verified }));
  const nachher = store.snapshot();
  assert.deepEqual(Object.keys(nachher).sort(), Object.keys(vorher).sort(), "keine neuen Wurzelbereiche");
  const neueAutomation = Object.keys(nachher.automation).filter((k) => !Object.hasOwn(vorher.automation, k)).sort();
  assert.deepEqual(neueAutomation, ["runtime", "runtimeInit"], "Bereich und sein Initialisierungsnachweis");
  assert.equal(nachher.automation.runtimeInit.schemaVersion, 1);
  assert.deepEqual(Object.keys(nachher.automation.runtime).sort(),
    ["cost", "continuationsById", "incidentsById", "leaseFenceCounter", "monitor", "runsByKey", "schemaVersion"].sort());
});
