/*
 * v3 C2 — die Gegenbeispiele der unabhängigen Prüfung von 33a4b3d.
 *
 * Elf ausführbare Fälle in neun Gruppen (C2-01 … C2-09), je mit der Nummer aus
 * der Meldung. Gemeinsamer Nenner wie in C1: der Dienst hat an mehreren
 * Stellen GEGLAUBT, was ein Nachbarpaket lieferte — eine Seite, ein Flag, eine
 * Zeit, ein ETag — statt es zu prüfen. Und an einer Stelle hat er dem Client
 * etwas bestätigt, das nie passiert ist.
 *
 * Die Kette läuft hier echt: signierte Token, der Idempotenz-Ledger des
 * Integrationsstandes (kontrolliert geladen, siehe `idempotencyPort().source`),
 * ein Speicher mit CAS-Verhalten.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleCommandRequest, handleReadRequest, readBoundedBody, assertCoreSnapshot } from "../netlify/lib/quantus-v3-service.mjs";
import { mintJobToken, resolveAuthConfig, ROLE_POLICY } from "../netlify/lib/quantus-v3-auth.mjs";
import { COMMAND_VERBS, COMMAND_VERB_NAMES } from "../netlify/lib/quantus-v3-command-envelope.mjs";
import { createCasRateLimiter } from "../netlify/lib/quantus-v3-rate-limiter.mjs";
import {
  makeEnv, makeSigningKey, makeIdToken, keySourceFor, userLookupFor, TENANT,
} from "./fixtures/quantus-v3-auth-fixtures.mjs";
import {
  makeCoreSnapshot, makeStore, makeDomain, makeRateLimiter, makeRequest,
  commandBody, commandHeaders, idempotencyPort, RUN_ID, LEAD_ID, OWNER,
} from "./fixtures/quantus-v3-c2-fixtures.mjs";

const key = makeSigningKey("c2-gb-kid");
const JETZT = Date.parse("2026-09-20T09:00:00Z");
const APP = "https://management-xo2-pro.netlify.app";
const idem = await idempotencyPort();

const schreibendeUmgebung = () => makeEnv({
  tenant: TENANT, mode: "enforce", overrides: { QUANTUS_V3_API_WRITES: "enabled" },
});

/* EINE Umgebung für alle Aufrufe, die zusammengehören: jede neue erzeugt
   frische Cursor-Schlüssel, und ein Cursor aus Aufruf A wäre in Aufruf B
   dann zu Recht ungültig — was den eigentlichen Fall verdecken würde. */
const ENV = schreibendeUmgebung();

function nutzerToken(sub = OWNER) {
  return makeIdToken({ key, sub, now: JETZT, tenant: TENANT });
}

function deps({ env = ENV, store = makeStore(), domain = makeDomain(), rateLimiter = makeRateLimiter(), now = () => JETZT } = {}) {
  let n = 0;
  return {
    now, newRequestId: () => `req-${++n}`, env: env.read,
    keySource: keySourceFor(key), userLookup: userLookupFor({ tenantId: TENANT }),
    rateLimiter, store, domain, idempotency: idem,
  };
}

function leseAnfrage({ query = "notes.recent", scopeId = LEAD_ID, pageSize = null, cursor = null, token = null } = {}) {
  const url = new URL("https://management-xo2-pro.netlify.app/.netlify/functions/quantus-context");
  url.searchParams.set("query", query);
  url.searchParams.set("scopeId", scopeId);
  if (pageSize != null) url.searchParams.set("pageSize", String(pageSize));
  if (cursor) url.searchParams.set("cursor", cursor);
  return makeRequest({
    method: "GET", url: url.toString(),
    headers: { authorization: `Bearer ${token || nutzerToken()}`, origin: APP },
  });
}

const lies = (d, anfrage = leseAnfrage()) => handleReadRequest(anfrage, d, { route: "quantus-context" });

/* ══ C2-01 Ein fremder Eintrag in einer erlaubten Seite ═══════════════════
 * Gemeldet: Scope `lead_123` gehört uid-laurin, der Adapter liefert darin eine
 * Notiz eines fremden Eigentümers, aus einem fremden Mandanten, zu einem
 * fremden Lead — und der Handler gibt sie mit 200 aus.
 * ------------------------------------------------------------------------ */
test("(C2-01) jeder gelieferte Eintrag wird frisch geprüft, nicht nur der Scope", async () => {
  const fremderEintrag = {
    kind: "note", id: "private_note", ownerId: "uid-foreign", tenant: "other-tenant",
    leadId: "foreign_lead", jobId: RUN_ID, entityVersion: 1, text: "Private synthetic content",
  };
  const res = await lies(deps({ domain: makeDomain({ listResult: { items: [fremderEintrag], hasMore: false } }) }));
  assert.equal(res.status, 403, `ein fremder Eintrag ging mit ${res.status} hinaus`);
  assert.equal(res.body.reason, "item_not_authorized");
  assert.ok(!JSON.stringify(res.body).includes("Private synthetic content"), "der fremde Inhalt steht in der Antwort");

  // Auch die einzelnen Verstösse getrennt:
  const faelle = [
    [{ ...fremderEintrag, tenant: TENANT, ownerId: OWNER }, "item_outside_scope"],   // fremder Lead
    [{ ...fremderEintrag, tenant: TENANT, leadId: LEAD_ID }, "item_not_authorized"],  // fremder Eigentümer
    [{ ...fremderEintrag, ownerId: OWNER, leadId: LEAD_ID }, "item_not_authorized"],  // fremder Mandant
    [{ ...fremderEintrag, kind: "lead", tenant: TENANT, ownerId: OWNER, leadId: LEAD_ID }, "item_kind_mismatch"],
  ];
  for (const [eintrag, grund] of faelle) {
    const r = await lies(deps({ domain: makeDomain({ listResult: { items: [eintrag], hasMore: false } }) }));
    assert.equal(r.status, 403, `${grund}: kam mit ${r.status} durch`);
    assert.equal(r.body.reason, grund);
  }

  // Gegenprobe: eigene Notizen des eigenen Leads gehen hinaus.
  const gut = await lies(deps());
  assert.equal(gut.status, 200);
  assert.equal(gut.body.items.length > 0, true);
});

/* ══ C2-02 Fehlendes hasMore wurde zu „vollständig" ══════════════════════ */
test("(C2-02) ohne ausdrückliches hasMore ist keine Seite vollständig", async () => {
  const eintrag = { kind: "note", id: "note_1", tenant: TENANT, ownerId: OWNER, jobId: RUN_ID, leadId: LEAD_ID, entityVersion: 1, text: "Notiz" };
  for (const hasMore of [undefined, null, "false", 0, 1, "true"]) {
    const listResult = { items: [eintrag] };
    if (hasMore !== undefined) listResult.hasMore = hasMore;
    const res = await lies(deps({ domain: makeDomain({ listResult }) }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.complete, false, `hasMore=${JSON.stringify(hasMore)} galt als vollständig`);
    assert.equal(res.body.pageStatus, "aborted");
    assert.equal(res.body.cursor, null);
  }

  // Und `hasMore: true` ohne brauchbaren Weiterzeiger ist ebenfalls nichts.
  for (const zeiger of [undefined, null, "", "note_1/x", "attachment__x", "note_2"]) {
    const listResult = { items: [eintrag], hasMore: true };
    if (zeiger !== undefined) listResult.nextAfterId = zeiger;
    const res = await lies(deps({ domain: makeDomain({ listResult }) }));
    assert.equal(res.status, 503, `Weiterzeiger ${JSON.stringify(zeiger)} wurde akzeptiert`);
    assert.equal(res.body.reason, "page_cursor_unusable");
  }

  // Ein Weiterzeiger, der auf denselben Stand zeigt wie zuvor, ist Stillstand.
  const erste = await lies(deps(), leseAnfrage({ pageSize: 2 }));
  assert.equal(erste.status, 200);
  assert.ok(erste.body.cursor, "die erste Seite lieferte keinen Cursor");
  const stagnierend = makeDomain({
    listResult: { items: [{ ...eintrag, id: "note_2" }], hasMore: true, nextAfterId: "note_2" },
  });
  const zweite = await lies(deps({ domain: stagnierend }),
    leseAnfrage({ cursor: erste.body.cursor, pageSize: 2 }));
  assert.equal(zweite.status, 503, `ein stillstehender Weiterzeiger wurde akzeptiert: ${JSON.stringify(zweite.body)}`);
  assert.equal(zweite.body.reason, "page_cursor_unusable");
});

/* ══ C2-03 Übervolle Seite ═══════════════════════════════════════════════ */
test("(C2-03) mehr Einträge als angefordert: kein Ausliefern, kein „vollständig“", async () => {
  const note = (id) => ({ kind: "note", id, tenant: TENANT, ownerId: OWNER, jobId: RUN_ID, leadId: LEAD_ID, entityVersion: 1, text: id });
  const res = await lies(
    deps({ domain: makeDomain({ listResult: { items: [note("note_1"), note("note_2")], hasMore: false } }) }),
    leseAnfrage({ pageSize: 1 }),
  );
  assert.equal(res.status, 503, `eine übervolle Seite kam mit ${res.status} durch`);
  assert.equal(res.body.reason, "page_overfull");
  assert.equal(res.body.items, undefined, "eine übervolle Seite lieferte trotzdem Daten");

  // Genau die angeforderte Zahl ist in Ordnung.
  const genau = await lies(
    deps({ domain: makeDomain({ listResult: { items: [note("note_1")], hasMore: false } }) }),
    leseAnfrage({ pageSize: 1 }),
  );
  assert.equal(genau.status, 200);
  assert.equal(genau.body.complete, true);
});

/* ══ C2-04 Erfundene Revision im Trockenlauf ═════════════════════════════ */
test("(C2-04) ein Kern ohne brauchbare Revision ist auf JEDEM Weg 503", async () => {
  const ohneRevision = makeCoreSnapshot();
  delete ohneRevision.automation.dataRevision;
  assert.equal(assertCoreSnapshot(ohneRevision).ok, false);

  // Prüflauf (ausdrücklich verlangt):
  const pruefen = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token: nutzerToken(), origin: APP, validateOnly: true }),
    body: commandBody(),
  }), deps({ store: makeStore({ snapshot: ohneRevision }) }));
  assert.equal(pruefen.status, 503, `Trockenlauf antwortete ${pruefen.status}`);
  assert.equal(pruefen.body.error, "auth_not_configured");
  assert.equal(pruefen.body.reason, "core_invalid");
  assert.equal(JSON.stringify(pruefen.body).includes('"dataRevision"'), false, "eine Revision wurde erfunden");

  // Schreibweg:
  const schreiben = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token: nutzerToken(), origin: APP }), body: commandBody(),
  }), deps({ store: makeStore({ snapshot: ohneRevision }) }));
  assert.equal(schreiben.status, 503);

  // Leseweg:
  const lesen = await lies(deps({ store: makeStore({ snapshot: ohneRevision }) }));
  assert.equal(lesen.status, 503);
  assert.equal(lesen.body.reason, "core_invalid");

  // Und die weiteren Kernmängel ebenso.
  for (const kaputt of [
    (k) => { k.automation.dataRevision = -1; },
    (k) => { k.automation.dataRevision = 1.5; },
    (k) => { k.automation.schemaVersion = 2; },
    (k) => { delete k.automation.idempotencyByKey; },
    (k) => { delete k.entities; },
  ]) {
    const kern = makeCoreSnapshot();
    kaputt(kern);
    assert.equal(assertCoreSnapshot(kern).ok, false);
  }
});

/* ══ C2-05 Der ausgeschaltete Schreibweg sah aus wie eine Quittung ═══════ */
test("(C2-05) ohne Freigabe: 503 api_writes_disabled, ohne jedes Quittungsfeld", async () => {
  const env = makeEnv({ tenant: TENANT });                 // Standard: aus
  const store = makeStore();
  const res = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token: nutzerToken(), origin: APP }), body: commandBody(),
  }), deps({ env, store }));

  assert.equal(res.status, 503);
  assert.equal(res.body.error, "api_writes_disabled");
  const text = JSON.stringify(res.body);
  for (const quittungsfeld of ["serverNow", "dataRevision", "replayed", "entityVersions", "applied", "dryRun"]) {
    assert.ok(!text.includes(quittungsfeld), `die Absage trägt ${quittungsfeld}`);
  }
  assert.notEqual(res.body.ok, true);
  assert.equal(store.spur.mutates, 0);

  // Auch `enforce` allein oder die Freigabe allein genügen nicht.
  for (const teilweise of [
    makeEnv({ tenant: TENANT, mode: "enforce" }),
    makeEnv({ tenant: TENANT, overrides: { QUANTUS_V3_API_WRITES: "enabled" } }),
  ]) {
    const r = await handleCommandRequest(makeRequest({
      headers: commandHeaders({ token: nutzerToken(), origin: APP }), body: commandBody(),
    }), deps({ env: teilweise, store: makeStore() }));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "api_writes_disabled");
  }
});

/* ══ C2-06 Der Ratenzähler schrieb ohne echten Versionsstempel ═══════════ */
test("(C2-06) ohne echten ETag wird nicht gezählt und nicht geschrieben", async () => {
  for (const etag of [null, undefined, "", "   ", "*", 42, {}]) {
    const geschrieben = [];
    const limiter = createCasRateLimiter({
      getWithEtag: async () => ({ value: null, serverEtag: etag }),
      set: async (...args) => { geschrieben.push(args); return { ok: true }; },
    });
    await assert.rejects(() => limiter.increment({ key: "k", windowStartMs: 0, windowMs: 60_000 }),
      (err) => err.code === "rate_limiter_unavailable", `ETag ${JSON.stringify(etag)} wurde akzeptiert`);
    assert.equal(geschrieben.length, 0, `ETag ${JSON.stringify(etag)} führte zu einem Schreibvorgang`);
  }

  // Ein echter Stempel des LEEREN Knotens genügt — und wird unverändert
  // als Vorbedingung mitgegeben.
  const gesehen = [];
  const limiter = createCasRateLimiter({
    getWithEtag: async () => ({ value: null, serverEtag: "leerer-knoten-etag" }),
    set: async (path, wert, opt) => { gesehen.push(opt.ifMatch); return { ok: true }; },
  });
  assert.equal((await limiter.increment({ key: "k", windowStartMs: 0, windowMs: 60_000 })).count, 1);
  assert.deepEqual(gesehen, ["leerer-knoten-etag"]);
});

/* ══ C2-07 Ein kaputter Zählerstand wurde fortgeschrieben ════════════════ */
test("(C2-07) ein unbrauchbarer Zählerstand ist ein Fehler, keine Reparatur", async () => {
  const fenster = 1_758_351_600_000;
  const baue = (stand) => {
    const geschrieben = [];
    const limiter = createCasRateLimiter({
      getWithEtag: async () => ({ value: stand, serverEtag: "e1" }),
      set: async (p, wert) => { geschrieben.push(wert); return { ok: true }; },
    });
    return { limiter, geschrieben };
  };

  // Der gemeldete Fall: -1000 im passenden Fenster.
  const { limiter, geschrieben } = baue({ count: -1000, windowStartMs: fenster, windowMs: 60_000 });
  await assert.rejects(() => limiter.increment({ key: "k", windowStartMs: fenster, windowMs: 60_000 }),
    (err) => err.code === "rate_limiter_unavailable", "ein negativer Zähler wurde fortgeschrieben");
  assert.equal(geschrieben.length, 0);

  for (const stand of [
    { count: 1.5, windowStartMs: fenster },
    { count: "5", windowStartMs: fenster },
    { count: Number.MAX_SAFE_INTEGER, windowStartMs: fenster },
    { count: NaN, windowStartMs: fenster },
    { count: 3, windowStartMs: "irgendwann" },
    [1, 2, 3],
  ]) {
    const { limiter: l } = baue(stand);
    await assert.rejects(() => l.increment({ key: "k", windowStartMs: fenster, windowMs: 60_000 }),
      (err) => err.code === "rate_limiter_unavailable", `${JSON.stringify(stand)} wurde akzeptiert`);
  }

  // Ein brauchbarer Stand zählt normal weiter, mit EINER Zeitmarke.
  let zeit = Date.parse("2026-09-20T09:00:00Z");
  const marken = [];
  const okLimiter = createCasRateLimiter({
    getWithEtag: async () => { zeit += 1000; return { value: { count: 4, windowStartMs: fenster }, serverEtag: `e${zeit}` }; },
    set: async (p, wert, opt) => { marken.push(wert.updatedAt); return marken.length < 3 ? { conflict: true } : { ok: true }; },
    now: () => zeit,
  });
  const ergebnis = await okLimiter.increment({ key: "k", windowStartMs: fenster, windowMs: 60_000 });
  assert.equal(ergebnis.count, 5);
  assert.equal(new Set(marken).size, 1, "die Zeitmarke wanderte zwischen den Versuchen");
});

test("(C2-07b) das Gesamtbudget eines Principals gilt über alle Verben", async () => {
  // Zwei verschiedene Verben, aber ein Principal: der Gesamtzähler bindet.
  let gesamt = 0;
  const rateLimiter = {
    atomic: true, scope: "shared", multiInstanceSafe: true,
    async increment({ key }) {
      // Der Gesamtschlüssel endet auf ":*"; er zählt schnell hoch.
      if (key.endsWith(":*")) { gesamt += 1; return { count: 1000 + gesamt }; }
      return { count: 1 };
    },
  };
  const res = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token: nutzerToken(), origin: APP }), body: commandBody(),
  }), deps({ rateLimiter }));
  assert.equal(res.status, 429, "das Gesamtbudget wurde nicht geprüft");
  assert.ok(Number(res.headers["Retry-After"]) >= 1);
  assert.equal(gesamt, 1);
});

/* ══ C2-08 Die Lease wurde mit einer gemerkten Zeit geprüft ══════════════ */
test("(C2-08) Bindung und Zeit werden bei JEDEM CAS-Versuch frisch geprüft", async () => {
  const env = schreibendeUmgebung();
  const { config } = resolveAuthConfig(env.read);
  const token = (await mintJobToken({
    config, audience: "quantus-ingest", jobId: RUN_ID, role: "lead_agent",
    principalId: "review-agent", tenant: TENANT, assignedJobIds: [RUN_ID], now: () => JETZT,
  })).token;

  const snapshot = makeCoreSnapshot({
    leaseOwner: "review-agent", leaseExpiresAt: new Date(JETZT + 30_000).toISOString(),
  });
  const befehl = commandBody({
    verb: "lead.comment", expectedEntityVersion: 17,
    payload: { leadId: LEAD_ID, text: "Prüfnotiz" },
  });

  // Positivkontrolle: zur gültigen Zeit wirkt der Befehl genau einmal.
  const store = makeStore({ snapshot });
  const domain = makeDomain();
  const positiv = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token }), body: befehl,
  }), deps({ env, store, domain, now: () => JETZT }));
  assert.equal(positiv.status, 200, JSON.stringify(positiv.body));
  assert.equal(store.snapshot.entities.leads[LEAD_ID].entityVersion, 18);

  /*
   * Der gemeldete Fall: die Uhr springt um 31 s VOR dem eigentlichen
   * Mutatorversuch. Die Lease ist damit abgelaufen — geprüft wurde früher
   * aber mit der Zeit, die der Handler VOR `store.mutate` gemerkt hatte.
   */
  let jetzt = JETZT;
  const store2 = makeStore({
    snapshot: {
      ...structuredClone(snapshot),
      entities: {
        ...structuredClone(snapshot.entities),
        leads: { ...structuredClone(snapshot.entities.leads) },
      },
    },
  });
  store2.snapshot.entities.leads[LEAD_ID].entityVersion = 18;
  const verzoegernderSpeicher = {
    spur: store2.spur,
    get snapshot() { return store2.snapshot; },
    readSnapshot: () => store2.readSnapshot(),
    async mutate(key, mutator, opts) {
      jetzt += 31_000;                 // die Zeit vergeht VOR dem Versuch
      return store2.mutate(key, mutator, opts);
    },
  };
  const res = await handleCommandRequest(makeRequest({
    headers: commandHeaders({ token }),
    body: commandBody({ verb: "lead.comment", expectedEntityVersion: 18, payload: { leadId: LEAD_ID, text: "Zu spät" } }),
  }), deps({ env, store: verzoegernderSpeicher, now: () => jetzt }));

  assert.equal(res.status, 403, `abgelaufene Lease ergab ${res.status}`);
  assert.equal(res.body.reason, "lease_expired");
  assert.equal(store2.snapshot.entities.leads[LEAD_ID].entityVersion, 18, "trotz abgelaufener Lease wurde geschrieben");
});

test("(C2-08b) auch eine Wiederholung prüft die Bindung erneut", async () => {
  const env = schreibendeUmgebung();
  const { config } = resolveAuthConfig(env.read);
  const token = (await mintJobToken({
    config, audience: "quantus-ingest", jobId: RUN_ID, role: "lead_agent",
    principalId: "review-agent", tenant: TENANT, assignedJobIds: [RUN_ID], now: () => JETZT,
  })).token;
  const store = makeStore({
    snapshot: makeCoreSnapshot({ leaseOwner: "review-agent", leaseExpiresAt: new Date(JETZT + 300_000).toISOString() }),
  });
  const d = deps({ env, store, now: () => JETZT });
  const kopf = commandHeaders({ token, idempotencyKey: "wiederholung-1" });
  const befehl = commandBody({ verb: "lead.comment", expectedEntityVersion: 17, payload: { leadId: LEAD_ID, text: "Notiz" } });

  const erste = await handleCommandRequest(makeRequest({ headers: kopf, body: befehl }), d);
  assert.equal(erste.status, 200, JSON.stringify(erste.body));

  // Lease entzogen — die Wiederholung darf die Quittung nicht bekommen.
  store.snapshot.entities.runs[RUN_ID].activeLease = null;
  const wieder = await handleCommandRequest(makeRequest({ headers: kopf, body: befehl }), d);
  assert.equal(wieder.status, 403, "die Wiederholung umging die Bindungsprüfung");
  assert.equal(wieder.body.reason, "lease_not_held");
});

/* ══ C2-09 Anlegen war unmöglich, weil Ressource und Anker verwechselt waren ═
 *
 * Gemeldet: `intake.create` (Anker Lauf, Rolle darf „intake"), `task.create`
 * (Anker Lead, Rolle darf „task"), `note.append` (Anker Lauf, Rolle darf
 * „note") scheiterten mit `data_category_not_allowed_for_role`; ebenso
 * `briefing.answer` sowie `question.create`/`worker.assign` der Leitung. Und
 * `run.ensure` konnte einen fehlenden Lauf nicht anlegen.
 * ------------------------------------------------------------------------ */
const NUTZER_VERBEN = [
  ["intake.create", { source: "manual", title: "Neuer Eingang" }, 0],
  ["intake.accept", { intakeId: "intake_1" }, 4],
  ["task.create", { leadId: LEAD_ID, title: "Aufgabe" }, 0],
  ["lead.comment", { leadId: LEAD_ID, text: "Kommentar" }, 17],
  ["lead.transition", { leadId: LEAD_ID, toState: "waiting" }, 17],
  ["lead.schedule", { leadId: LEAD_ID, waitUntil: "2026-09-25T09:00:00Z", counterparty: "Muster AG", nextAction: "Nachfassen", evidenceRefs: ["artifact_1"] }, 17],
  ["briefing.answer", { briefingId: "briefing_1", questionId: "question_1", answer: "ja" }, 0],
  ["question.resolve", { questionId: "question_1", answer: "ja" }, 2],
  ["document.register", { documentId: "document_2", title: "Vertrag", attachmentRef: "att_1", contentHash: "b".repeat(64), origin: "upload" }, 0],
  ["note.append", { noteId: "note_neu", text: "Notiz", noteScope: "run" }, 0],
];

const LEITUNG_VERBEN = [
  ["question.create", { leadId: LEAD_ID, text: "Rückfrage?" }, 0],
  ["worker.assign", { assignmentId: "assignment_2", executor: "claude", sourceVersion: 5, allowedContextIds: ["ctx_1"] }, 0],
  ["worker.review", { resultId: "result_1", verdict: "accepted" }, 2],
  ["document.processed", { documentId: "document_1", extractionRef: "extract_1", contentHash: "c".repeat(64) }, 3],
  ["run.checkpoint", { stage: "lesen" }, 5],
  ["run.log", { event: "tick" }, 5],
];

const SCHEDULER_VERBEN = [
  ["run.ensure", { slot: "09:00", date: "2026-09-20" }, 5],
  ["run.claim", { leaseSeconds: 300 }, 5],
  ["run.renew", { leaseSeconds: 300 }, 5],
];

const BACKEND_VERBEN = [
  ["run.finalize", { outcome: "complete" }, 5],
  ["briefing.consumeAnswer", { briefingId: "briefing_1", answerId: "answer_1" }, 2],
];

const SPEZIALIST_VERBEN = [
  ["worker.return", { assignmentId: "assignment_1", resultRef: "ergebnis_1", summary: "fertig", sourceVersion: 2 }, 0],
];

async function sendeAls({ token, verb, payload, version, env, store, domain, now = () => JETZT, origin = null }) {
  return handleCommandRequest(makeRequest({
    headers: commandHeaders({ token, origin }),
    body: commandBody({ verb, expectedEntityVersion: version, payload }),
  }), deps({ env, store, domain, now }));
}

test("(C2-09) alle 22 Verben: der vorgesehene Weg funktioniert", async () => {
  const env = schreibendeUmgebung();
  const { config } = resolveAuthConfig(env.read);
  const leaseAktiv = () => makeCoreSnapshot({ leaseOwner: "lead-agent-cloudrun", leaseExpiresAt: new Date(JETZT + 300_000).toISOString() });

  const leitungsToken = (await mintJobToken({
    config, audience: "quantus-ingest", jobId: RUN_ID, role: "lead_agent",
    principalId: "lead-agent-cloudrun", tenant: TENANT, assignedJobIds: [RUN_ID], now: () => JETZT,
  })).token;
  const spezialistToken = (await mintJobToken({
    config, audience: "quantus-ingest", jobId: RUN_ID, role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, now: () => JETZT,
  })).token;

  const gruppen = [
    // Der Mensch kommt aus dem Browser und braucht eine erlaubte Origin;
    // Dienste und Worker kommen originlos.
    ["user", NUTZER_VERBEN, () => nutzerToken(), () => makeStore(), APP],
    ["lead_agent", LEITUNG_VERBEN, () => leitungsToken, () => makeStore({ snapshot: leaseAktiv() }), null],
    ["scheduler", SCHEDULER_VERBEN, () => env.secrets.service.scheduler, () => makeStore(), null],
    ["backend_checker", BACKEND_VERBEN, () => env.secrets.service.checker, () => makeStore(), null],
    ["specialist_claude", SPEZIALIST_VERBEN, () => spezialistToken, () => makeStore(), null],
  ];

  const geprueft = new Set();
  for (const [rolle, verben, tokenFn, storeFn, origin] of gruppen) {
    for (const [verb, payload, version] of verben) {
      const res = await sendeAls({ token: tokenFn(), verb, payload, version, env, store: storeFn(), origin });
      assert.equal(res.status, 200, `${rolle}/${verb} ergab ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.applied, true, `${rolle}/${verb} hat nicht gewirkt`);
      assert.ok(res.body.entityVersions && Object.keys(res.body.entityVersions).length, `${rolle}/${verb} ohne entityVersions`);
      geprueft.add(verb);
    }
  }
  assert.equal(geprueft.size, 22, `nur ${geprueft.size} von 22 Verben positiv geprüft`);
  assert.deepEqual([...geprueft].sort(), [...COMMAND_VERB_NAMES].sort());
});

test("(C2-09b) run.ensure legt einen fehlenden Lauf an", async () => {
  const env = schreibendeUmgebung();
  const store = makeStore({ snapshot: makeCoreSnapshot({ ohneRun: true }) });
  assert.equal(store.snapshot.entities.runs[RUN_ID], undefined);

  const res = await sendeAls({
    token: env.secrets.service.scheduler, verb: "run.ensure",
    payload: { slot: "09:00", date: "2026-09-20" }, version: 0, env, store,
  });
  assert.equal(res.status, 200, `run.ensure ergab ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.applied, true);
  assert.ok(store.snapshot.entities.runs[RUN_ID], "der Lauf wurde nicht angelegt");

  // Aber die übrigen Lauf-Verben brauchen einen vorhandenen Lauf.
  const ohneLauf = makeStore({ snapshot: makeCoreSnapshot({ ohneRun: true }) });
  const claim = await sendeAls({
    token: env.secrets.service.scheduler, verb: "run.claim",
    payload: { leaseSeconds: 300 }, version: 5, env, store: ohneLauf,
  });
  assert.equal(claim.status, 403);
  assert.equal(claim.body.reason, "object_not_found");
});

test("(C2-09c) zu jedem erlaubten Weg gehört ein verbotener", async () => {
  const env = schreibendeUmgebung();
  const { config } = resolveAuthConfig(env.read);
  const spezialistToken = (await mintJobToken({
    config, audience: "quantus-ingest", jobId: RUN_ID, role: "specialist_claude",
    principalId: "claude-spezialist", tenant: TENANT, now: () => JETZT,
  })).token;

  // Der Nutzer darf keine Backend- oder Agentenverben.
  for (const [verb, payload, version] of [
    ["run.finalize", { outcome: "complete" }, 5],
    ["briefing.consumeAnswer", { briefingId: "briefing_1", answerId: "answer_1" }, 2],
    ["worker.assign", { assignmentId: "assignment_3", executor: "gemini", sourceVersion: 5, allowedContextIds: ["ctx_1"] }, 0],
    ["run.claim", { leaseSeconds: 300 }, 5],
  ]) {
    const res = await sendeAls({ token: nutzerToken(), verb, payload, version, env, store: makeStore(), origin: APP });
    assert.equal(res.status, 403, `user/${verb} ergab ${res.status}`);
    assert.equal(res.body.reason, "verb_not_allowed_for_role");
  }

  // Der Spezialist darf nur sein Ergebnis zurückgeben.
  for (const [verb, payload, version] of [
    ["lead.comment", { leadId: LEAD_ID, text: "x" }, 17],
    ["task.create", { leadId: LEAD_ID, title: "x" }, 0],
    ["note.append", { noteId: "note_x", text: "x", noteScope: "run" }, 0],
    ["run.finalize", { outcome: "complete" }, 5],
  ]) {
    const res = await sendeAls({ token: spezialistToken, verb, payload, version, env, store: makeStore() });
    assert.equal(res.status, 403, `specialist/${verb} ergab ${res.status}`);
    assert.equal(res.body.reason, "verb_not_allowed_for_role");
  }

  // Und der Scheduler schreibt keine Inhalte.
  const scheduler = await sendeAls({
    token: env.secrets.service.scheduler, verb: "lead.transition",
    payload: { leadId: LEAD_ID, toState: "done" }, version: 17, env, store: makeStore(),
  });
  assert.equal(scheduler.status, 403);

  // Die Matrix selbst deckt jedes Verb mindestens einmal ab.
  const ausMatrix = new Set();
  for (const policy of Object.values(ROLE_POLICY)) {
    for (const verb of Object.keys(policy.verbs)) if (verb !== "context.read") ausMatrix.add(verb);
  }
  assert.deepEqual([...ausMatrix].sort(), [...COMMAND_VERB_NAMES].sort(),
    "Matrix und Umschlag kennen nicht dieselben Verben");
});

/* ══ Der Körper wird begrenzt gelesen ════════════════════════════════════ */
test("(Körper) grosse Anfragen werden beim Lesen abgebrochen, nicht danach", async () => {
  // Ein Strom, der weit mehr liefert, als erlaubt ist: die Prüfung darf ihn
  // nicht erst vollständig einsammeln.
  let gelesen = 0;
  const brocken = Buffer.alloc(16 * 1024, 0x61);
  const req = {
    method: "POST",
    url: "https://x.test/y",
    headers: { get: () => null },
    body: {
      getReader() {
        let abgebrochen = false;
        return {
          async read() {
            if (abgebrochen) return { done: true };
            gelesen += brocken.byteLength;
            if (gelesen > 4 * 1024 * 1024) return { done: true };   // Notbremse im Test
            return { done: false, value: new Uint8Array(brocken) };
          },
          async cancel() { abgebrochen = true; },
        };
      },
    },
    async text() { throw new Error("text() darf hier nicht gebraucht werden"); },
  };
  const res = await readBoundedBody(req, 64 * 1024);
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
  assert.ok(gelesen <= 80 * 1024, `es wurden ${gelesen} Bytes gelesen, bevor abgebrochen wurde`);

  // Eine angekündigte Überlänge genügt schon vor dem ersten Byte.
  let angefasst = false;
  const mitLaenge = {
    method: "POST", url: "https://x.test/y",
    headers: { get: (n) => (String(n).toLowerCase() === "content-length" ? "999999" : null) },
    get body() { angefasst = true; return null; },
    async text() { angefasst = true; return ""; },
  };
  const res2 = await readBoundedBody(mitLaenge, 64 * 1024);
  assert.equal(res2.status, 413);
  assert.equal(angefasst, false, "der Körper wurde trotz angekündigter Überlänge angefasst");
});
