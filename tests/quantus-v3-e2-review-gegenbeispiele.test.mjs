/* ══ E2 — die drei Gegenbeispiele der unabhaengigen Pruefung ══════════════
 *
 * Geprueft gegen die echten lokalen Dienste ueber HTTP, mit echten
 * RSA-signierten Token und der echten CAS-Schleife. Die Uhr ist eine
 * Testuhr — inklusive ihrer Zeitgeber; es wird nirgends mit dem echten
 * Wallclock gemischt.
 *
 *   1. Zwei gleichzeitige, gueltige Zustellungen desselben Slots liefen
 *      BEIDE in `sectionWork.next`.
 *   2. Ein Lauf wurde gruen, obwohl es keinen fachlichen Abschlussnachweis
 *      gab — die Nachweiskennung war selbst erfunden.
 *   3. Die Lease wurde erst nach 75 s erneuert statt spaetestens nach 60 s,
 *      und ein haengender Aufruf hatte weder Grenze noch Abbruchsignal.
 * ═════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import * as F from "./quantus-v3-e2-fixtures.mjs";
import * as PLAN from "../netlify/lib/quantus-v3-runtime-plan.mjs";
import { validateClosureEvidence, CLOSURE_EVIDENCE_MAX_AGE_MS, CLOSURE_FINAL_STATE } from "../runtime/quantus-v3/src/worker-handlers.mjs";

const T = PLAN.wallTimeToMs("2026-09-19", 9, 0) + 2_000;
const RUNKEY = PLAN.slotRunKey(F.TENANT, "2026-09-19", "process09", F.POLICY_VERSION);
const QUELLEN = ["gmail-inbox", "calendar-primary"];

async function dienst({ sectionWork, closureEvidence, live = false, startMs = T, corePort = null, clockOverride = null } = {}) {
  const key = F.createSigningKey();
  const clock = clockOverride ?? F.createClock(startMs);
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const tasks = F.createTasksPort();
  const ports = {
    clock: clock.port, jwks: F.jwksPort(key), core: corePort ?? core.port, tasks: tasks.port,
    sectionWork: sectionWork ?? F.createSectionWorkPort({ count: 1 }).port,
  };
  if (closureEvidence) ports.closureEvidence = closureEvidence;
  const configOverrides = live
    ? {
      QUANTUS_V3_RUNTIME_MODE: "live",
      QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: "true",
      QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed(),
      QUANTUS_V3_REQUIRED_SOURCES: JSON.stringify(QUELLEN),
    }
    : {};
  const service = await F.startService({ role: "worker", ports, configOverrides });
  return {
    key, clock, core, tasks, service,
    start: () => service.post("/v3/slot/start", {
      token: F.schedulerToken(key, { audience: F.AUD.slotStart, email: F.SA.schedulerStart, nowMs: clock.value }),
      body: { slot: "process09" },
    }),
  };
}

/* ── 1: zwei gleichzeitige Zustellungen ───────────────────────────────── */

test("P0-1 zwei gleichzeitige Zustellungen betreten NICHT beide die Arbeit", async (t) => {
  const arbeit = F.createGatedSectionWorkPort({ steps: 1 });
  const s = await dienst({ sectionWork: arbeit.port });
  t.after(() => s.service.close());

  // Erste Zustellung laeuft los und bleibt im externen Aufruf stehen.
  const erste = s.start();
  await arbeit.betreten;
  assert.equal(arbeit.calls, 1);

  // Zweite, genauso gueltige Zustellung waehrenddessen.
  const zweite = await s.start();
  assert.equal(zweite.status, 409, zweite.text);
  assert.equal(zweite.json.error, "already_running");
  assert.ok(Number.isSafeInteger(zweite.json.detail.retryAfterMs));
  assert.equal(arbeit.calls, 1, "die zweite Zustellung hat die Arbeit nicht betreten");

  arbeit.release();
  const ergebnis = await erste;
  assert.equal(ergebnis.status, 200, ergebnis.text);
  assert.equal(arbeit.calls, 2, "nur der EINE Versuch arbeitet weiter (zweiter Schritt: done)");
  const runtime = s.core.store.snapshot().automation.runtime;
  assert.equal(Object.keys(runtime.runsByKey[RUNKEY].sections).length, 1, "genau ein Abschnitt");
  assert.equal(runtime.leaseFenceCounter, 1, "es wurde nur ein Besitz vergeben");
});

test("P0-1b der Besitz gehoert dem VERSUCH, nicht dem Dienst", async (t) => {
  const arbeit = F.createGatedSectionWorkPort({ steps: 1 });
  const s = await dienst({ sectionWork: arbeit.port });
  t.after(() => s.service.close());
  const erste = s.start();
  await arbeit.betreten;
  const gehalten = s.core.store.snapshot().automation.activeLease;
  assert.match(gehalten.holder, /^worker-rev-0001:[0-9a-f-]{36}$/, "Besitzername traegt die Anfragekennung");
  assert.notEqual(gehalten.holder, "worker-rev-0001");
  arbeit.release();
  await erste;
});

test("P0-1c ein noch lebender Vorgaenger wird nicht uebernommen", async (t) => {
  const arbeit = F.createGatedSectionWorkPort({ steps: 3 });
  const s = await dienst({ sectionWork: arbeit.port });
  t.after(() => s.service.close());
  const erste = s.start();
  await arbeit.betreten;

  // Die Lease laeuft NICHT ab: der Vorgaenger lebt. Auch eine dritte und
  // vierte Zustellung prallen ab.
  for (let i = 0; i < 3; i++) {
    const weitere = await s.start();
    assert.equal(weitere.status, 409, weitere.text);
    assert.equal(weitere.json.error, "already_running");
  }
  assert.equal(arbeit.calls, 1);
  arbeit.release();
  await erste;
});

/* ── 2: kein erfundenes Gruen ──────────────────────────────────────────── */

function gueltigerNachweis(over = {}, now = T) {
  return {
    runKey: RUNKEY,
    tenant: F.TENANT,
    policyVersion: F.POLICY_VERSION,
    fence: 1,
    dataRevision: null,          // wird je Test gesetzt
    evidenceRef: "closure:2026-09-19:process09:abc123",
    verifiedAtMs: now,
    // Belegter B-Abschluss: Zustand UND Gesamturteil muessen zusammen
    // vorliegen (siehe validateClosureEvidence, worker-handlers.mjs).
    state: CLOSURE_FINAL_STATE,
    blocked: false,
    sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: now })),
    ...over,
  };
}

test("P0-2 ohne Nachweisport wird kein Lauf gruen", async (t) => {
  const s = await dienst({ sectionWork: F.createSectionWorkPort({ count: 0 }).port, live: true });
  t.after(() => s.service.close());
  const res = await s.start();
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "exception_open");
  assert.equal(res.json.green, false);
  assert.equal(res.json.evidenceRef, undefined);
  assert.match(res.json.reason, /^closure_evidence_invalid:closure_evidence_port_unavailable/);
  const run = s.core.store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.equal(run.green, false);
  assert.equal(run.phase, "exception_open");
  assert.equal(run.outcome, null, "es wurde kein Abschluss verbucht");
});

test("P0-2b fehlender, falscher oder veralteter Nachweis ergibt nie Gruen", async (t) => {
  const faelle = [
    ["fehlt", () => null],
    ["falscher Lauf", (rev) => gueltigerNachweis({ runKey: PLAN.slotRunKey(F.TENANT, "2026-09-19", "close23", F.POLICY_VERSION), dataRevision: rev })],
    ["fremder Mandant", (rev) => gueltigerNachweis({ tenant: "fremd", dataRevision: rev })],
    ["andere Policy", (rev) => gueltigerNachweis({ policyVersion: "9.9", dataRevision: rev })],
    ["falscher Fence", (rev) => gueltigerNachweis({ fence: 99, dataRevision: rev })],
    ["veraltet", (rev) => gueltigerNachweis({ dataRevision: rev, verifiedAtMs: T - CLOSURE_EVIDENCE_MAX_AGE_MS - 1 })],
    ["Quelle fehlt", (rev) => gueltigerNachweis({ dataRevision: rev, sources: [{ id: QUELLEN[0], status: "ok", checkedAtMs: T }] })],
    ["Quelle nicht ok", (rev) => gueltigerNachweis({ dataRevision: rev, sources: QUELLEN.map((id) => ({ id, status: "error", checkedAtMs: T })) })],
    ["selbst erfundene Kennung", (rev) => gueltigerNachweis({ dataRevision: rev, evidenceRef: `run-evidence:${RUNKEY}` })],
    ["falsche Datenrevision", (rev) => gueltigerNachweis({ dataRevision: rev + 100 })],
  ];
  for (const [name, bauen] of faelle) {
    const nachweis = F.createClosureEvidencePort(() => bauen(revisionVon(s)));
    const s = await dienst({
      sectionWork: F.createSectionWorkPort({ count: 0 }).port,
      closureEvidence: nachweis.port, live: true,
    });
    t.after(() => s.service.close());
    const res = await s.start();
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.equal(res.json.outcome, "exception_open", name);
    assert.equal(res.json.green, false, name);
    assert.equal(res.json.evidenceRef, undefined, name);
    assert.equal(s.core.store.snapshot().automation.runtime.runsByKey[RUNKEY].green, false, name);
  }
});

function revisionVon(s) {
  return s && s.core ? s.core.store.snapshot().automation.dataRevision : 0;
}

test("P0-2c ein vollstaendiger, frischer Nachweis macht den Lauf gruen", async (t) => {
  let aufrufe = 0;
  let laufzeit = null;
  const nachweis = F.createClosureEvidencePort(() => {
    aufrufe += 1;
    return gueltigerNachweis({ dataRevision: laufzeit.core.store.snapshot().automation.dataRevision });
  });
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    closureEvidence: nachweis.port, live: true,
  });
  laufzeit = s;
  t.after(() => s.service.close());
  const res = await s.start();
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "finished");
  assert.equal(res.json.green, true);
  assert.equal(res.json.evidenceRef, "closure:2026-09-19:process09:abc123");
  assert.equal(aufrufe, 1);
  const run = s.core.store.snapshot().automation.runtime.runsByKey[RUNKEY];
  assert.equal(run.green, true);
  assert.equal(run.outcome.kind, "completed");
  assert.equal(run.outcome.evidenceRef, "closure:2026-09-19:process09:abc123");
  assert.notEqual(run.outcome.evidenceRef, `run-evidence:${RUNKEY}`);
});

test("P0-2d im dry_run gibt es weder Nachweis noch Gruen", async (t) => {
  const nachweis = F.createClosureEvidencePort(() => gueltigerNachweis());
  const s = await dienst({ sectionWork: F.createSectionWorkPort({ count: 0 }).port, closureEvidence: nachweis.port });
  t.after(() => s.service.close());
  const res = await s.start();
  assert.equal(res.json.outcome, "finished");
  assert.equal(res.json.green, false);
  assert.deepEqual(nachweis.aufrufe, [], "im dry_run wird gar nicht erst nach einem Nachweis gefragt");
});

test("P0-2e die Nachweispruefung selbst ist streng", () => {
  const erwartet = { runKey: RUNKEY, tenant: F.TENANT, policyVersion: F.POLICY_VERSION, fence: 1, now: T, requiredSources: QUELLEN };
  assert.deepEqual(validateClosureEvidence(gueltigerNachweis({ dataRevision: 7 }), erwartet), { ok: true, errors: [] });
  const fehlerVon = (over) => validateClosureEvidence(gueltigerNachweis({ dataRevision: 7, ...over }), erwartet).errors;
  assert.ok(fehlerVon({ evidenceRef: `run-evidence:${RUNKEY}` }).includes("evidence_ref_self_invented"));
  assert.ok(fehlerVon({ evidenceRef: "kurz" }).includes("evidence_ref_invalid"));
  assert.ok(fehlerVon({ evidenceRef: "closure/mit/schraegstrich" }).includes("evidence_ref_invalid"),
    "eine Kennung, die der Kern ablehnen wuerde, faellt schon hier durch");
  assert.ok(fehlerVon({ verifiedAtMs: T + 1 }).includes("verified_in_future"));
  assert.ok(fehlerVon({ dataRevision: "sieben" }).includes("data_revision_invalid"));
  assert.ok(fehlerVon({ sources: [...gueltigerNachweis().sources, { id: "fremd", status: "ok", checkedAtMs: T }] })
    .some((e) => e.startsWith("sources_unexpected")));
  assert.deepEqual(validateClosureEvidence(null, erwartet).errors, ["closure_evidence_missing"]);

  // BEFUND: `expected.now - checkedAtMs` wird bei einer Pruefzeit in der
  // ZUKUNFT negativ und faellt dann nie unter die Altersgrenze — egal wie
  // weit in der Zukunft sie liegt. Eine solche Pruefzeit ist falsch, nicht
  // "besonders frisch", und muss abgewiesen werden.
  const zukunft = fehlerVon({ sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: T + 10_000_000 })) });
  assert.ok(zukunft.some((e) => e.startsWith("source_checked_in_future")), zukunft.join(","));
  assert.ok(!zukunft.some((e) => e.startsWith("source_stale")), zukunft.join(","));
});

/*
 * BEFUND (Review-Auftrag): `loadClosureEvidence` prüfte NACH dem
 * (potenziell langen) Netzaufruf noch gegen die Zeit von VOR diesem
 * Aufruf; `finishSection` reichte dieselbe alte Zeit in den CAS. Ein
 * echtes, spaeter geschriebenes `serverNow` konnte dadurch faelschlich
 * "verified_in_future" ausloesen, und eine waehrend des Aufrufs
 * tatsaechlich abgelaufene Lease wurde mit der alten Zeit noch als
 * gueltig akzeptiert. Die Uhr hier ist eine Testuhr — der Nachweisport
 * rueckt sie waehrend `load()` vor, um genau diese Verzoegerung
 * nachzubilden, ohne je den echten Wallclock zu beruehren.
 */
test("P0-2f eine Uhr, die waehrend des Nachweis-Lesens um 1s vorrueckt, verhindert kein echtes Gruen", async (t) => {
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    closureEvidence: F.createClosureEvidencePort((input) => {
      // Die Verzoegerung passiert HIER, waehrend des simulierten
      // Netzaufrufs — der Nachweis traegt die Zeit NACH der Verzoegerung,
      // genau wie eine echte, etwas spaetere Serverantwort es taete.
      s.clock.advance(1_000);
      return gueltigerNachweis({ dataRevision: revisionVon(s), verifiedAtMs: s.clock.value,
        sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: s.clock.value })) });
    }).port,
    live: true,
  });
  t.after(() => s.service.close());
  const res = await s.start();
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "finished", JSON.stringify(res.json));
  assert.equal(res.json.green, true);
});

test("P0-2g eine Uhr, die waehrend des Nachweis-Lesens um 121s vorrueckt, darf NIE gruen liefern", async (t) => {
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    closureEvidence: F.createClosureEvidencePort((input) => {
      // 121s > die 120s-Frist der Versuchs-Sperre UND > die 60s-Frist des
      // Nachweises — beides muss mit FRISCHER Zeit erkannt werden.
      s.clock.advance(121_000);
      return gueltigerNachweis({ dataRevision: revisionVon(s), verifiedAtMs: s.clock.value,
        sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: s.clock.value })) });
    }).port,
    live: true,
  });
  t.after(() => s.service.close());
  const res = await s.start();
  // 121s > die 120s-TTL der Versuchs-Sperre: die Sperre ist bei der
  // FRISCH gelesenen Zeit im CAS tatsaechlich abgelaufen, und
  // E1.finishRun weist das folgerichtig als 409 `lease_expired` ab — mit
  // der alten, vor dem Nachweis-I/O gelesenen Zeit waere das UNBEMERKT
  // als 200 "finished"/gruen durchgegangen. Egal welcher der beiden
  // Wege (Nachweis veraltet ODER Sperre abgelaufen) zuerst greift: in
  // KEINEM Fall wird dieser Lauf gruen.
  assert.notEqual(res.status, 200, JSON.stringify(res.json ?? res.text));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, "lease_expired");
});

/*
 * BEFUND (Review 5bcdb41): `atMs`/die erneute Nachweispruefung lagen VOR
 * `core.mutate(...)` — aber `core.mutate` selbst kann die Verzoegerung
 * SEIN (eigener Lesevorgang, Netz, CAS-Konflikt). Ein Kernport, der die
 * Uhr direkt vor `impl.mutate(...)` vorstellt, deckt genau das auf: mit
 * der alten Fassung blieb das Ergebnis 200/gruen, obwohl die Uhr beim
 * TATSAECHLICHEN Schreiben laengst weiter war. Der Nachweis wird deshalb
 * jetzt ERST INNERHALB des Mutators — mit den gerade gelesenen CAS-Daten —
 * ein zweites Mal gegen eine dort frisch gelesene Uhr geprueft.
 */
function verzoegerterKernPort(core, clock, { praefix = "finish:", verzoegerungMs, nurVersuch = null } = {}) {
  const echtesImpl = core.port.impl;
  // Zaehlt NUR Aufrufe mit dem gesuchten Praefix (z. B. "finish:") — ein
  // vorheriger, andersartiger CAS-Aufruf (Versuchs-Sperre, Checkpoints)
  // darf `nurVersuch` nicht verschieben.
  let passendeAufrufe = 0;
  return {
    ...core.port,
    impl: {
      ...echtesImpl,
      async mutate(input) {
        const passtPraefix = String(input.commandKey || "").startsWith(praefix);
        if (passtPraefix) {
          passendeAufrufe += 1;
          if (nurVersuch === null || passendeAufrufe === nurVersuch) clock.advance(verzoegerungMs);
        }
        return echtesImpl.mutate(input);
      },
    },
  };
}

test("P0-2h Kontrolle: keine Verzoegerung im CAS-Aufruf selbst — echter Abschluss bleibt gruen", async (t) => {
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    closureEvidence: F.createClosureEvidencePort(() => gueltigerNachweis({ dataRevision: core.store.snapshot().automation.dataRevision })).port,
    live: true,
    corePort: verzoegerterKernPort(core, F.createClock(T), { verzoegerungMs: 0 }),
  });
  t.after(() => s.service.close());
  const res = await s.start();
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "finished");
  assert.equal(res.json.green, true);
});

test("P0-2i eine Uhr, die ERST INNERHALB von core.mutate (nicht davor) um 121s vorrueckt, darf NIE gruen liefern", async (t) => {
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const clock = F.createClock(T);
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    // Der Nachweis wird OHNE Verzoegerung geladen — frisch, gueltig,
    // genau wie im Repro-Fall. Erst der SCHREIBAUFRUF selbst ist langsam.
    closureEvidence: F.createClosureEvidencePort(() => gueltigerNachweis({ dataRevision: core.store.snapshot().automation.dataRevision, verifiedAtMs: clock.value,
      sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: clock.value })) })).port,
    live: true,
    clockOverride: clock,
    corePort: verzoegerterKernPort(core, clock, { verzoegerungMs: 121_000 }),
  });
  t.after(() => s.service.close());
  const res = await s.start();
  // Egal ob die erneute Nachweispruefung IM CAS oder die Lease/Fence-
  // Pruefung von E1.finishRun zuerst greift: in KEINEM Fall gruen.
  // Reproduktion des Befunds: mit der alten Fassung (Uhr VOR core.mutate
  // gelesen) blieb dies 200/"finished"/gruen.
  if (res.status === 200) {
    assert.notEqual(res.json.outcome, "finished", JSON.stringify(res.json));
    assert.equal(res.json.green, false);
  } else {
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "lease_expired");
  }
});

test("P0-2j eine Uhr, die ERST INNERHALB von core.mutate um 61s vorrueckt, lehnt wegen des 60s-Nachweisalters ab — trotz noch gueltiger 120s-Sperre", async (t) => {
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const clock = F.createClock(T);
  let ladeNr = 0;
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    // Der Nachweis selbst bleibt bewusst bei der URSPRUENGLICHEN Zeit T —
    // simuliert eine Quelle, die sich waehrend der Verzoegerung nicht
    // erholt (z. B. dieselbe langsame Aussenverbindung). Nur `evidenceRef`
    // variiert, damit ein zweiter Ladevorgang nicht am Beleg-Cache des
    // ERSTEN CAS-Versuchs vorbeireplayt statt neu geprueft zu werden.
    closureEvidence: F.createClosureEvidencePort(() => {
      ladeNr += 1;
      return gueltigerNachweis({
        dataRevision: core.store.snapshot().automation.dataRevision,
        evidenceRef: `closure:2026-09-19:process09:alt-${ladeNr}`,
        verifiedAtMs: T, sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: T })),
      });
    }).port,
    live: true,
    clockOverride: clock,
    // NUR der erste Schreibversuch ist langsam — die Versuchs-Sperre bleibt
    // ueber den gesamten Test unter ihrer 120s-Frist (nur EINMAL 61s).
    corePort: verzoegerterKernPort(core, clock, { verzoegerungMs: 61_000, nurVersuch: 1 }),
  });
  t.after(() => s.service.close());
  const res = await s.start();
  // Die 120s-Versuchs-Sperre bleibt bei insgesamt 61s Verzoegerung gueltig
  // (409 lease_expired waere ein anderer Befund) — abgewiesen wird HIER
  // wegen des Nachweisalters: der erste Versuch scheitert im CAS selbst
  // (`closure_evidence_stale_in_cas`), der zweite scheitert schon beim
  // erneuten Laden (derselbe, weiterhin veraltete Nachweis).
  assert.equal(res.status, 200, res.text);
  assert.notEqual(res.json.outcome, "finished", JSON.stringify(res.json));
  assert.equal(res.json.green, false);
  assert.match(res.json.reason, /evidence_stale|closure_evidence_stale_in_cas/);
  assert.equal(ladeNr, 2, "der Nachweis wurde fuer beide Versuche geladen, nicht nur einmal");
});

test("P0-2k Gegenprobe: nach einer Verzoegerung im ERSTEN CAS-Versuch erholt sich der ZWEITE mit frisch geladenem Nachweis", async (t) => {
  const core = F.createCorePort(F.createCasStore(F.baseCore()));
  const clock = F.createClock(T);
  let ladeNr = 0;
  const s = await dienst({
    sectionWork: F.createSectionWorkPort({ count: 0 }).port,
    // Jeder Ladevorgang liefert einen FRISCHEN Nachweis mit der Uhrzeit
    // VON DEM MOMENT — ein zweiter Versuch nach einer Verzoegerung ist
    // also ein echter, neuer Blick, keine Wiederholung desselben Standes.
    closureEvidence: F.createClosureEvidencePort(() => {
      ladeNr += 1;
      return gueltigerNachweis({
        dataRevision: core.store.snapshot().automation.dataRevision,
        evidenceRef: `closure:2026-09-19:process09:versuch-${ladeNr}`,
        verifiedAtMs: clock.value,
        sources: QUELLEN.map((id) => ({ id, status: "ok", checkedAtMs: clock.value })),
      });
    }).port,
    live: true,
    clockOverride: clock,
    // Nur der ERSTE finish-Schreibversuch ist langsam — 90s: laenger als
    // die 60s-Nachweisfrist (der Nachweis MUSS im ersten Versuch veralten),
    // aber kuerzer als die 120s-Versuchs-Sperre (die Erholung im zweiten
    // Versuch soll an der Sperre nicht scheitern). Danach holt
    // `finishSection` den Nachweis erneut — mit einer Uhr, die durch die
    // erste Verzoegerung bereits vorgerueckt ist, aber diesmal OHNE eine
    // zweite Verzoegerung im Schreibaufruf selbst.
    corePort: verzoegerterKernPort(core, clock, { verzoegerungMs: 90_000, nurVersuch: 1 }),
  });
  t.after(() => s.service.close());
  const res = await s.start();
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "finished", JSON.stringify(res.json));
  assert.equal(res.json.green, true);
  assert.equal(ladeNr, 2, "der Nachweis wurde fuer beide Versuche frisch geladen");
});

/* ── 3: Erneuerungsfrist, harte Grenze, Abbruchsignal ─────────────────── */

test("P0-3 die Lease wird spaetestens nach 60 Sekunden erneuert, nicht erst nach 75", async (t) => {
  const beobachtet = [];
  let laufzeit = null;
  const port = F.availablePort("sectionWork", {
    async next({ cursor, signal }) {
      const lease = laufzeit.core.store.snapshot().automation.activeLease;
      beobachtet.push({ signal: Boolean(signal), renewedAtMs: lease ? lease.renewedAtMs : null });
      const position = (cursor && cursor.position) || 0;
      if (position >= 2) return { done: true };
      // Der Schritt dauert 61 Sekunden.
      laufzeit.clock.advance(61_000);
      return { done: false, stepId: `step-${position + 1}`, durationMs: 61_000, cursor: { position: position + 1 } };
    },
  });
  const s = await dienst({ sectionWork: port });
  laufzeit = s;
  t.after(() => s.service.close());
  await s.start();

  assert.ok(beobachtet.length >= 2, JSON.stringify(beobachtet));
  assert.equal(beobachtet[0].renewedAtMs, T, "zu Beginn frisch genommen");
  assert.ok(beobachtet[0].signal, "der Aufruf bekommt ein Abbruchsignal");
  const zweite = beobachtet[1].renewedAtMs;
  assert.notEqual(zweite, T, "beim zweiten Aufruf ist die Lease erneuert");
  assert.ok(zweite - T <= 61_000, `Erneuerung nach ${(zweite - T) / 1000}s`);
  assert.ok(zweite - T >= 55_000, "und nicht unnoetig frueh");
});

test("P0-3b ein haengender Aufruf wird an der harten Grenze abgebrochen und gilt als unklar", async (t) => {
  const arbeit = F.createHangingSectionWorkPort();
  const s = await dienst({ sectionWork: arbeit.port });
  t.after(() => s.service.close());

  const laeuft = s.start();
  await arbeit.betreten;
  assert.equal(arbeit.calls, 1);
  assert.equal(arbeit.aborted, false);

  // Die Testuhr treibt alles — kein echter Wallclock.
  s.clock.advance(90_000);
  const res = await laeuft;

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.outcome, "exception_open");
  assert.equal(res.json.providerOutcome, "unknown");
  assert.equal(res.json.green, false);
  assert.equal(arbeit.calls, 1, "der haengende Aufruf wird NICHT wiederholt");
  assert.equal(arbeit.aborted, true, "das Abbruchsignal wurde gesetzt");

  const runtime = s.core.store.snapshot().automation.runtime;
  const run = runtime.runsByKey[RUNKEY];
  assert.equal(run.phase, "exception_open");
  assert.equal(run.green, false);
  assert.ok(Object.values(runtime.incidentsById).some((i) => i.kind === "run_exception"));
  assert.ok(run.pendingContinuationId, "es gibt eine sichere naechste Fortsetzung");
});

test("P0-3c der Abbruch haengt an der Testuhr, nicht am Wallclock", async (t) => {
  const arbeit = F.createHangingSectionWorkPort();
  const s = await dienst({ sectionWork: arbeit.port });
  t.after(() => s.service.close());
  const laeuft = s.start();
  await arbeit.betreten;

  // Ohne Uhrbewegung passiert nichts — auch nicht nach echten Millisekunden.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(arbeit.aborted, false, "die echte Uhr loest nichts aus");

  s.clock.advance(89_999);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(arbeit.aborted, false, "eine Millisekunde vor der Grenze noch nicht");

  s.clock.advance(1);
  const res = await laeuft;
  assert.equal(arbeit.aborted, true);
  assert.equal(res.json.outcome, "exception_open");
});
