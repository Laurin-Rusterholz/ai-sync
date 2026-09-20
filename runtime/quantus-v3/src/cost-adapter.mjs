/* ══ E2 — Adaptervertrag fuer bezahlte Aufrufe ════════════════════════════
 *
 * Nach der unabhaengigen Pruefung gegen den ECHTEN Idempotenzumschlag neu
 * gefasst. Sechs Gegenbeispiele hingen an zwei Fehlern:
 *
 *   · Der Adapter hat `replayed`/`wrote` nicht angesehen. Eine
 *     WIEDERGEGEBENE erfolgreiche Buchung liefert die gespeicherte Antwort
 *     von damals — samt `dispatchAllowed: true`. Damit liess sich nach
 *     einer Abrechnung, nach einem unklaren Ausgang und sogar waehrend
 *     eines noch laufenden ersten Sendevorgangs ein zweites Mal senden.
 *   · Der Adapter hat ueberall `ctx.now` benutzt, also die Zeit vom
 *     Beginn der Anfrage. Ein langsamer `costPolicy.load` konnte damit
 *     zwei Minuten dauern, und der Aufruf ging trotz abgelaufener Lease
 *     und trotz Tageswechsel hinaus.
 *
 * Daraus die Regeln dieser Datei:
 *
 *  1. Die Zeit kommt bei JEDEM Schritt frisch aus dem Uhrport — und
 *     ausdruecklich NACH dem Laden des Preisstands, weil genau dort die
 *     Verzoegerung sitzt.
 *  2. Gesendet wird nur, wenn der Anspruch WIRKLICH GESCHRIEBEN wurde:
 *     `wrote === true` und `replayed !== true`. Ein Beleg ist keine
 *     Sendeberechtigung. Meldet der Port die beiden Angaben nicht, ist das
 *     ein Vertragsbruch (502) — keine Annahme zugunsten des Sendens.
 *  3. Danach wird der Bestand noch einmal gelesen: der Anspruch muss zu
 *     DIESEM Aufruf gehoeren, offen sein und aus DIESEM Augenblick
 *     stammen. Das faengt auch einen Port ab, der ueber `replayed` luegt.
 *  4. Vor der Sendung muss die Fuehrung noch lange genug reichen, um den
 *     Ausgang auch verbuchen zu koennen. Sonst wird gar nicht gesendet.
 *  5. Nach der Sendung gibt es genau zwei Ausgaenge: belegter Verbrauch
 *     oder ausdruecklich unklarer Ausgang. Laesst sich der Ausgang nicht
 *     mehr verbuchen, ist das ein lauter Fehler, kein stiller.
 *  6. Zwischen der LETZTEN Pruefung und dem Aufruf liegt kein `await`
 *     mehr. Jedes gewartete Kern-I/O — ein Lesen, ein CAS-Durchlauf mit
 *     Wiederholungen — kann Sekunden oder Minuten dauern. Deshalb wird
 *     unmittelbar vor dem Aufruf noch einmal mit FRISCHER Zeit geprueft:
 *     Fuehrung, Fence, Preisstand und Abrechnungstag. Den Zustand dazu
 *     liefert die Anspruchsmutation aus IHREM eigenen Schnappschuss mit,
 *     damit dafuer kein weiteres Lesen noetig ist.
 *
 * Der Adapter rechnet selbst nichts: Preis, Budget, Vertrag,
 * Tageszuordnung und die Genau-einmal-Regel liegen in E1.
 * ═════════════════════════════════════════════════════════════════════════ */
import * as E1 from "../../../netlify/lib/quantus-v3-runtime-state.mjs";
import { localDate as zurichLocalDate } from "../../../netlify/lib/quantus-v3-runtime-plan.mjs";
import { HttpError, conflict } from "./errors.mjs";
import { externalEffectsAllowed } from "./config.mjs";
import { reserveCostWithMonthlyCap } from "./monthly-cost-cap.mjs";

export const DISPATCH_OUTCOMES = Object.freeze(["settled", "unknown"]);
/* So viel Fuehrung muss nach dem Anspruch noch uebrig sein, damit der
 * Ausgang danach auch verbucht werden kann. */
export const DISPATCH_LEASE_RESERVE_MS = 30_000;

function clockOf(ctx) {
  const clock = ctx.ports.require("clock");
  if (typeof clock.now !== "function") {
    throw new HttpError(503, "port_unavailable", { port: "clock", reason: "now_missing" });
  }
  return clock;
}

async function leseKern(ctx) {
  const core = ctx.ports.require("core");
  const snapshot = await core.read();
  if (!snapshot || typeof snapshot !== "object" || !snapshot.data) {
    throw new HttpError(502, "core_response_invalid", { call: "read" });
  }
  return snapshot.data;
}

/* Freigabetore und Initialisierungsnachweis bei JEDEM Schritt frisch —
 * nicht einmal beim Start. Eine als Beleg wiederholte Mutation fuehrt den
 * Mutator gar nicht aus; diese Pruefung laeuft trotzdem. */
async function pruefeFrisch(ctx, schritt) {
  if (!externalEffectsAllowed(ctx.config)) {
    throw new HttpError(409, "external_effects_not_allowed", { step: schritt, mode: ctx.config.mode });
  }
  const data = await leseKern(ctx);
  E1.readRuntime(data);   // wirft bei fehlendem oder kaputtem Nachweis
  return data;
}

async function ladePolicy(ctx, schritt) {
  const port = ctx.ports.require("costPolicy");
  if (typeof port.load !== "function") {
    throw new HttpError(503, "port_unavailable", { port: "costPolicy", reason: "load_missing" });
  }
  const policy = await port.load({ now: clockOf(ctx).now(), step: schritt });
  if (policy === null || typeof policy !== "object") {
    throw new HttpError(503, "cost_policy_unavailable", { step: schritt });
  }
  return policy;
}

async function mutiere(ctx, commandKey, mutator) {
  const core = ctx.ports.require("core");
  const out = await core.mutate({ commandKey, requestId: ctx.requestId, now: ctx.now, mutate: mutator });
  if (!out || typeof out !== "object" || !Object.hasOwn(out, "result")) {
    throw new HttpError(502, "core_response_invalid", { commandKey });
  }
  return out;
}

/* Wie lange traegt die Fuehrung dieses Versuchs noch? */
function leaseRest(data, verifiedScope, now) {
  const lease = data.automation ? data.automation.activeLease : null;
  if (lease === null || typeof lease !== "object") return { ok: false, code: "lease_absent", remainingMs: 0 };
  if (lease.scope !== verifiedScope.scope || lease.holder !== verifiedScope.holder || lease.fence !== verifiedScope.fence) {
    return { ok: false, code: "lease_fenced", remainingMs: 0 };
  }
  const rest = lease.expiresAtMs - now;
  if (rest <= 0) return { ok: false, code: "lease_expired", remainingMs: 0 };
  return { ok: true, code: null, remainingMs: rest };
}

/* Der Zustand, den die Anspruchsmutation aus ihrem eigenen Schnappschuss
 * mitgibt. Reine Werte, damit der Idempotenzumschlag sie speichern kann. */
function gateAus(data, callId) {
  const lease = data.automation ? data.automation.activeLease : null;
  const call = leseAufruf(data, callId);
  return {
    leaseHolder: lease && typeof lease.holder === "string" ? lease.holder : null,
    leaseScope: lease && typeof lease.scope === "string" ? lease.scope : null,
    leaseFence: lease && Number.isSafeInteger(lease.fence) ? lease.fence : null,
    leaseExpiresAtMs: lease && Number.isSafeInteger(lease.expiresAtMs) ? lease.expiresAtMs : null,
    callState: call ? call.state : null,
    claimed: Boolean(call && call.dispatch && call.dispatch.claimed === true),
    claimId: call && call.dispatch && typeof call.dispatch.claimId === "string" ? call.dispatch.claimId : null,
    claimedAtMs: call && call.dispatch && Number.isSafeInteger(call.dispatch.claimedAtMs) ? call.dispatch.claimedAtMs : null,
    billingLocalDate: call && typeof call.billingLocalDate === "string" ? call.billingLocalDate : null,
    maxMicros: call && Number.isSafeInteger(call.maxMicros) ? call.maxMicros : null,
  };
}

/* Die letzte Pruefung vor dem externen Aufruf. Rein, ohne I/O — genau
 * deshalb kann zwischen ihr und dem Aufruf keine Zeit mehr vergehen. */
export function pruefeUnmittelbarVorSendung({ gate, policy, verifiedScope, sendeZeit, leaseReserveMs, allowFixture = false }) {
  if (!Number.isSafeInteger(sendeZeit) || sendeZeit <= 0) return { ok: false, code: "server_clock_invalid" };
  // Fuehrung: noch dieselbe, noch derselbe Fence, noch lange genug.
  if (gate.leaseHolder !== verifiedScope.holder || gate.leaseScope !== verifiedScope.scope) {
    return { ok: false, code: "lease_lost", detail: { holder: gate.leaseHolder } };
  }
  if (gate.leaseFence !== verifiedScope.fence) {
    return { ok: false, code: "lease_fenced", detail: { fence: gate.leaseFence } };
  }
  if (!Number.isSafeInteger(gate.leaseExpiresAtMs) || gate.leaseExpiresAtMs <= sendeZeit) {
    return { ok: false, code: "lease_expired", detail: { expiresAtMs: gate.leaseExpiresAtMs, sendeZeit } };
  }
  const rest = gate.leaseExpiresAtMs - sendeZeit;
  if (rest < leaseReserveMs) {
    return { ok: false, code: "lease_too_short_for_dispatch", detail: { remainingMs: rest, requiredMs: leaseReserveMs } };
  }
  // Abrechnungstag: immer noch derselbe?
  const heute = zurichLocalDate(sendeZeit);
  if (heute !== gate.billingLocalDate) {
    return { ok: false, code: "billing_day_rolled_over", detail: { reservedFor: gate.billingLocalDate, today: heute } };
  }
  // Preisstand: jetzt immer noch freigegeben und gueltig?
  const verdict = E1.validateCostPolicy(policy, { now: sendeZeit, allowFixture });
  if (!verdict.ok) return { ok: false, code: "cost_policy_invalid", detail: { errors: verdict.errors.slice(0, 4) } };
  if (verdict.providers !== "live") return { ok: false, code: "providers_not_live", detail: { providers: verdict.providers } };
  return { ok: true, code: null };
}

function leseAufruf(data, callId) {
  const runtime = E1.readRuntime(data);
  const cost = runtime.cost && typeof runtime.cost === "object" ? runtime.cost : { callsById: {} };
  const call = cost.callsById ? cost.callsById[callId] : undefined;
  return call && typeof call === "object" ? call : null;
}

export function createCostAdapter(ctx, { __allowFixturePolicy = false, leaseReserveMs = DISPATCH_LEASE_RESERVE_MS, monthlyCap = null } = {}) {
  const fixture = __allowFixturePolicy === true;

  return {
    /* Reservierung vor dem Aufruf. Sendet nichts. Mit `monthlyCap` (additiv,
     * Standard: aus) wird DIESELBE CAS-Mutation zusaetzlich gegen die
     * globale Monatsgrenze geprueft (`monthly-cost-cap.mjs`) — atomar, weil
     * die Pruefung innerhalb desselben, bei einem Konflikt wiederholten
     * Mutators laeuft wie `E1.reserveCost` selbst. */
    async reserve({ callId, runKey, provider, model, contentHash, inputTokens, outputTokens }) {
      const clock = clockOf(ctx);
      await pruefeFrisch(ctx, "reserve");
      const policy = await ladePolicy(ctx, "reserve");
      // NACH dem Laden: das Laden selbst kann gedauert haben.
      const now = clock.now();
      const out = await mutiere(ctx, `cost-reserve:${callId}`, (data) => (monthlyCap
        ? reserveCostWithMonthlyCap(data, {
          callId, runKey, provider, model, contentHash,
          inputTokens, outputTokens,
          now, verifiedScope: ctx.verifiedScope, policy,
          __allowFixturePolicy: fixture,
        }, monthlyCap)
        : E1.reserveCost(data, {
          callId, runKey, provider, model, contentHash,
          inputTokens, outputTokens,
          now, verifiedScope: ctx.verifiedScope, policy,
          __allowFixturePolicy: fixture,
        })));
      if (!out.result.ok) throw conflict("cost_reserve_rejected", { code: out.result.code, detail: out.result.detail ?? null });
      return { callId, maxMicros: out.result.maxMicros, mode: out.result.mode, dispatchAllowed: false };
    },

    /* Anspruch, Sendung, Ausgang — in dieser Reihenfolge und nur so. */
    async claimAndDispatch({ callId, claimId, send }) {
      if (typeof send !== "function") throw new HttpError(500, "dispatch_function_required");
      const clock = clockOf(ctx);
      await pruefeFrisch(ctx, "claim");
      const policy = await ladePolicy(ctx, "claim");

      // Erst NACH allem gewarteten I/O die Zeit nehmen. Ein langsamer
      // Preisstand oder ein langsames Lesen darf nicht dazu fuehren, dass
      // mit einer alten Zeit gerechnet wird.
      const vorher = await leseKern(ctx);
      const now = clock.now();
      const fuehrung = leaseRest(vorher, ctx.verifiedScope, now);
      if (!fuehrung.ok) {
        throw conflict("dispatch_not_allowed", { callId, code: fuehrung.code });
      }
      if (fuehrung.remainingMs < leaseReserveMs) {
        // Reicht die Fuehrung nicht mehr, um den Ausgang zu verbuchen,
        // wird gar nicht erst gesendet.
        throw conflict("dispatch_not_allowed", {
          callId, code: "lease_too_short_for_dispatch",
          remainingMs: fuehrung.remainingMs, requiredMs: leaseReserveMs,
        });
      }

      const claim = await mutiere(ctx, `cost-claim:${callId}:${claimId}`, (data) => E1.claimCostDispatch(data, {
        callId, claimId, now, verifiedScope: ctx.verifiedScope, policy,
        __allowFixturePolicy: fixture,
      }));

      // Der Port MUSS sagen, ob wirklich geschrieben wurde. Schweigen ist
      // kein Ja.
      if (typeof claim.wrote !== "boolean" || typeof claim.replayed !== "boolean") {
        throw new HttpError(502, "core_response_invalid", {
          commandKey: `cost-claim:${callId}:${claimId}`, reason: "wrote_or_replayed_missing",
        });
      }
      // Eine Absage ist eine Absage — mit ihrem eigenen Grund. Sie
      // schreibt nichts, darf aber nicht als "Wiederholung" erscheinen.
      if (!claim.result.ok) {
        throw conflict("dispatch_not_allowed", { callId, code: claim.result.code ?? "not_allowed", detail: claim.result.detail ?? null });
      }
      // Eine wiedergegebene ERFOLGREICHE Buchung ist keine neue
      // Sendeberechtigung: sie liefert die Antwort von damals.
      if (claim.replayed === true || claim.wrote === false) {
        throw conflict("dispatch_not_allowed", { callId, code: "claim_receipt_replayed", blocksRetry: true });
      }
      if (claim.result.dispatchAllowed !== true) {
        throw conflict("dispatch_not_allowed", { callId, code: "not_allowed" });
      }

      // ── Letztes gewartetes I/O: der Bestand, wie er JETZT ist. ──────
      // Er ist zugleich die Nachpruefung gegen einen Port, der ueber
      // `replayed` oder `wrote` falsch berichtet.
      const gate = gateAus(await leseKern(ctx), callId);
      if (gate.callState !== "reserved" || gate.claimed !== true
        || gate.claimId !== claimId || gate.claimedAtMs !== now) {
        throw conflict("dispatch_not_allowed", {
          callId, code: "claim_state_mismatch", state: gate.callState, blocksRetry: true,
        });
      }

      // ── Endkontrolle mit FRISCHER Zeit, NACH allem gewarteten I/O. ──
      // Ab hier bis zum `send` gibt es kein `await` mehr: Fuehrung,
      // Fence, Abrechnungstag und Preisstand koennen sich danach nicht
      // mehr unbemerkt geaendert haben.
      const sendeZeit = clock.now();
      const endkontrolle = pruefeUnmittelbarVorSendung({
        gate, policy, verifiedScope: ctx.verifiedScope,
        sendeZeit, leaseReserveMs, allowFixture: fixture,
      });
      if (!endkontrolle.ok) {
        // Der Anspruch steht schon. Er bleibt als beansprucht und
        // unaufgeloest stehen — das sperrt jede Wiederholung desselben
        // Inhalts, bis jemand ihn belegt aufloest.
        throw conflict("dispatch_aborted_before_send", {
          callId, code: endkontrolle.code, detail: endkontrolle.detail ?? null, blocksRetry: true,
        });
      }

      let antwort;
      try {
        antwort = await send({ callId, claimId, maxMicros: claim.result.maxMicros });
      } catch {
        await verbucheUnklar(ctx, callId, "dispatch_failed", null, clock);
        throw new HttpError(502, "provider_outcome_unknown", { callId, retryAllowed: false });
      }

      if (!antwort || typeof antwort !== "object" || !DISPATCH_OUTCOMES.includes(antwort.outcome)) {
        await verbucheUnklar(ctx, callId, "dispatch_response_invalid", null, clock);
        throw new HttpError(502, "provider_outcome_unknown", { callId, retryAllowed: false });
      }

      if (antwort.outcome === "unknown") {
        const markiert = await verbucheUnklar(ctx, callId, "provider_outcome_unknown", antwort.providerRequestId ?? null, clock);
        return { callId, outcome: "unknown", retryAllowed: false, blocksRetry: markiert.blocksRetry === true };
      }

      const settled = await mutiere(ctx, `cost-settle:${callId}`, (data) => E1.settleCost(data, {
        callId, actualMicros: antwort.actualMicros,
        usageReceiptId: antwort.usageReceiptId ?? null,
        providerRequestId: antwort.providerRequestId ?? null,
        now: clock.now(), verifiedScope: ctx.verifiedScope,
      }));
      if (!settled.result.ok) {
        // Gesendet, aber nicht verbucht: das ist laut, nicht still.
        throw new HttpError(502, "dispatch_outcome_unrecorded", { callId, code: settled.result.code });
      }
      return {
        callId, outcome: "settled",
        settledMicros: settled.result.settledMicros,
        releasedMicros: settled.result.releasedMicros,
        violations: settled.result.violations ?? [],
      };
    },
  };
}

async function verbucheUnklar(ctx, callId, grund, providerRequestId, clock) {
  const out = await mutiere(ctx, `cost-unknown:${callId}`, (data) => E1.markCostOutcomeUnknown(data, {
    callId, reason: grund, providerRequestId,
    now: clock.now(), verifiedScope: ctx.verifiedScope,
  }));
  if (!out.result.ok) {
    throw new HttpError(502, "dispatch_outcome_unrecorded", { callId, code: out.result.code });
  }
  return out.result;
}
