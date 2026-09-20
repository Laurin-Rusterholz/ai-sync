/*
 * v3 C2 — der instanzübergreifende Ratenzähler.
 *
 * C1 hat den Vertrag festgehalten und einen In-Memory-Zähler abgelehnt. Hier
 * steht die Erfüllung auf dem Prüfstand: Zählt er unter Konflikten richtig?
 * Behauptet er bei unklarem Ausgang einen Erfolg? Trennt er die Zeitfenster?
 * Und steht der Principal im Klartext im Knotennamen?
 *
 * Der Verkehr ist eingespeist — kein Firebase, kein Netz.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCasRateLimiter, rateNodePath, RATE_NODE_PREFIX } from "../netlify/lib/quantus-v3-rate-limiter.mjs";
import { requireHandlerRateLimiter } from "../netlify/lib/quantus-v3-auth.mjs";

const FENSTER = 60_000;
const START = Math.floor(Date.parse("2026-09-20T09:00:00Z") / FENSTER) * FENSTER;

/* Ein winziger Knotenspeicher mit ETag-Semantik wie firebase-admin. */
function speicher({ conflictsBefore = 0, unknownOutcome = false } = {}) {
  const knoten = new Map();
  let konflikte = conflictsBefore;
  const spur = { gets: 0, sets: 0 };
  return {
    spur,
    knoten,
    async getWithEtag(path) {
      spur.gets++;
      const eintrag = knoten.get(path) || null;
      return { value: eintrag ? eintrag.value : null, serverEtag: eintrag ? eintrag.etag : "leer" };
    },
    async set(path, value, { ifMatch } = {}) {
      spur.sets++;
      if (unknownOutcome) return { ok: false };
      if (konflikte > 0) { konflikte--; return { conflict: true }; }
      const eintrag = knoten.get(path);
      const aktuell = eintrag ? eintrag.etag : "leer";
      if (ifMatch !== aktuell) return { conflict: true };
      knoten.set(path, { value, etag: `e${(eintrag?.n || 0) + 1}`, n: (eintrag?.n || 0) + 1 });
      return { ok: true };
    },
  };
}

test("der Zähler erfüllt den C1-Vertrag", () => {
  const s = speicher();
  const limiter = createCasRateLimiter({ getWithEtag: s.getWithEtag, set: s.set });
  assert.equal(limiter.atomic, true);
  assert.equal(limiter.scope, "shared");
  assert.equal(requireHandlerRateLimiter(limiter).ok, true);
  assert.throws(() => createCasRateLimiter({}), /getWithEtag/);
});

test("er zählt hoch — und trennt die Zeitfenster", async () => {
  const s = speicher();
  const limiter = createCasRateLimiter({ getWithEtag: s.getWithEtag, set: s.set });
  for (let i = 1; i <= 5; i++) {
    const { count } = await limiter.increment({ key: "qv3:t:user:uid-1:lead.comment", windowStartMs: START, windowMs: FENSTER });
    assert.equal(count, i);
  }
  // Neues Fenster, neuer Zählerstand.
  const neu = await limiter.increment({ key: "qv3:t:user:uid-1:lead.comment", windowStartMs: START + FENSTER, windowMs: FENSTER });
  assert.equal(neu.count, 1);
  // Anderer Principal, eigener Zähler.
  const anderer = await limiter.increment({ key: "qv3:t:user:uid-2:lead.comment", windowStartMs: START, windowMs: FENSTER });
  assert.equal(anderer.count, 1);
});

test("Konflikte werden wiederholt, nicht verschluckt", async () => {
  const s = speicher({ conflictsBefore: 3 });
  const limiter = createCasRateLimiter({ getWithEtag: s.getWithEtag, set: s.set });
  const { count } = await limiter.increment({ key: "k", windowStartMs: START, windowMs: FENSTER });
  assert.equal(count, 1);
  assert.equal(s.spur.sets, 4, "es wurde nicht je Konflikt neu versucht");

  // Dauerkonflikt: kein „hat schon geklappt".
  const dauernd = speicher({ conflictsBefore: 99 });
  const limiter2 = createCasRateLimiter({ getWithEtag: dauernd.getWithEtag, set: dauernd.set, attempts: 4 });
  await assert.rejects(() => limiter2.increment({ key: "k", windowStartMs: START, windowMs: FENSTER }),
    (err) => err.code === "rate_limiter_unavailable");
});

test("unklarer Ausgang ⇒ Fehler, niemals ein stiller Freibrief", async () => {
  const s = speicher({ unknownOutcome: true });
  const limiter = createCasRateLimiter({ getWithEtag: s.getWithEtag, set: s.set });
  await assert.rejects(() => limiter.increment({ key: "k", windowStartMs: START, windowMs: FENSTER }),
    (err) => err.code === "rate_limiter_unavailable");
});

test("ein Rest aus einem alten Fenster zählt nicht mit", async () => {
  const s = speicher();
  const limiter = createCasRateLimiter({ getWithEtag: s.getWithEtag, set: s.set });
  const pfad = rateNodePath("k", START);
  s.knoten.set(pfad, { value: { count: 500, windowStartMs: START - FENSTER, windowMs: FENSTER }, etag: "e1", n: 1 });
  const { count } = await limiter.increment({ key: "k", windowStartMs: START, windowMs: FENSTER });
  assert.equal(count, 1, "ein Stand aus einem anderen Fenster wurde fortgeschrieben");
});

test("der Knotenname verrät den Principal nicht", () => {
  const pfad = rateNodePath("qv3:quantus-haushalt:user:uid-laurin:lead.comment", START);
  assert.ok(pfad.startsWith(`${RATE_NODE_PREFIX}/`));
  assert.ok(!pfad.includes("uid-laurin"));
  assert.ok(!pfad.includes("quantus-haushalt"));
  assert.match(pfad, new RegExp(`^${RATE_NODE_PREFIX}/[0-9a-f]{32}/\\d+$`));
  // Der Zähler liegt NICHT im Kerndatensatz.
  assert.ok(!pfad.includes("app-data"));
});
