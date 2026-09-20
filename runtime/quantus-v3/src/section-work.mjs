/* ══ F/G — sectionWork: echte, gescopte Quellenverarbeitung + Sonnet-Draft ═
 *
 * Fuellt den seit E2 offenen `sectionWork`-Port (`runtime/quantus-v3/src/
 * ports.mjs`) mit einem echten, aber bewusst schmalen vertikalen Pfad:
 *
 *   Schritte "gmail-page-N"   eine Gmail-Seite lesen (Nur-Lese, paginiert,
 *                             ueber `gmail-source.mjs`), Nachrichten-
 *                             Metadaten sammeln. Jede Seite ist ein
 *                             eigener, vom Aufrufer (worker-handlers.mjs
 *                             `recordToolStep`) idempotent verbuchter
 *                             Schritt — ein Nachschlag desselben
 *                             `stepId` fuehrt dort NICHT zu einem zweiten
 *                             Aufruf hier.
 *   Schritt "gmail-finalize"  EIN `recordSourceCheck`-Kommando ueber den
 *                             echten Domain-Kern (`assistant-core.
 *                             applyCommand`, Akteur `adapter`) fasst den
 *                             ganzen Lauf-Scan zusammen — `ok`/`partial`/
 *                             `auth_error`/`unreachable`, nie erfunden.
 *                             Nur bei vollstaendiger Abdeckung (kein
 *                             Seitenrest) wandert das Wasserzeichen
 *                             (`sourceCursors.gmail`) weiter; sonst deckt
 *                             der naechste Lauf dasselbe Fenster erneut ab
 *                             — kein stiller Verlust.
 *   Schritt "draft-dispatch"  NUR wenn mindestens eine Quelle gelesen
 *                             wurde: echte Kostenreservierung + Sendung
 *                             (`cost-adapter.mjs`, wiederverwendet, nicht
 *                             nachgebaut) an den echten Sonnet-Transport
 *                             (`anthropic-transport.mjs`); das Ergebnis
 *                             wird per `appendRunNote` (Akteur `system`)
 *                             mit Verweis auf den Quellenbeleg persistiert.
 *                             Ohne freigegebene, `live` geschaltete
 *                             Kostenrichtlinie sendet `cost-adapter.mjs`
 *                             nichts — das ist Absicht, kein Fehler dieses
 *                             Moduls.
 *
 * Andere in `requiredSources` genannte Quellen (nicht "gmail") werden HIER
 * NICHT verarbeitet — es gibt fuer sie keinen Schritt und keinen
 * `recordSourceCheck`-Aufruf. `validateClosureEvidence` (worker-handlers.mjs)
 * verlangt den VOLLSTAENDIGEN Quellensatz; eine fehlende Quelle bleibt damit
 * ehrlich `sources_missing` statt eines erfundenen Erfolgs.
 * ═════════════════════════════════════════════════════════════════════════ */
import { applyCommand } from "../../../netlify/lib/assistant-core.mjs";
import { validatePolicy } from "../../../netlify/lib/assistant-schema.mjs";
import { DOMAIN_PORT_VARS } from "../../../netlify/lib/quantus-v3-domain-adapter.mjs";
import { createCostAdapter } from "./cost-adapter.mjs";
import { availablePort, unavailablePort } from "./ports.mjs";
import { HttpError } from "./errors.mjs";

export const SOURCE_ID = "gmail";
const DEFAULT_MAX_PAGES = 50;

/* Der einzige Akteur, der Quellenpruefungen buchen darf, ist der Adapter
 * selbst — s. assistant-schema.mjs `recordSourceCheck.actors`. */
const ADAPTER_ACTOR = Object.freeze({ kind: "adapter", id: "quantus-v3-gmail-source" });
const SYSTEM_ACTOR = Object.freeze({ kind: "system", id: "quantus-v3-sectionwork" });

function localDateOfRunKey(runKey) {
  const teile = String(runKey || "").split(":");
  return teile.length >= 2 ? teile[1] : null;
}

/* Dieselbe Tagesbriefing-Policy (Paket B, `tagesbriefing-policy/3`), die
 * auch der C2-Domain-Adapter laedt — SELBE Umgebungsvariable, SELBE
 * Pruefung (`validatePolicy`). Es wird keine zweite Policy-Quelle erfunden. */
export function loadAssistantPolicy(envRead = (n) => process.env[n]) {
  const roh = String(envRead(DOMAIN_PORT_VARS.policyJson) || "").trim();
  if (!roh) return { ok: false, reason: "policy_not_configured" };
  let policy;
  try { policy = JSON.parse(roh); } catch { return { ok: false, reason: "policy_json_invalid" }; }
  const verdict = validatePolicy(policy);
  if (!verdict.ok) return { ok: false, reason: "policy_invalid:" + verdict.errors.slice(0, 4).join(",") };
  return { ok: true, policy };
}

async function coreMutate(corePort, commandKey, now, mutator) {
  const out = await corePort.mutate({ commandKey, requestId: commandKey, now, mutate: mutator });
  if (!out || typeof out !== "object" || !Object.hasOwn(out, "result")) {
    throw new HttpError(502, "core_response_invalid", { commandKey });
  }
  return out;
}

/* Echtes Kern-Kommando ueber `assistant-core.applyCommand` — dieselbe
 * Funktion, die B/C3a fuer jede andere Wirkung nutzen. Kein Nachbau der
 * Aktor-/Policy-/Schutzfeldpruefung. */
function applyDomainCommand(type, payload, actor, now, commandId, policy) {
  return (draft) => {
    const result = applyCommand(draft, { type, commandId, now, payload }, { policy, actor });
    return { data: result.ok ? result.data : draft, result };
  };
}

function verifiedScopeAus(data, leaseScope) {
  const lease = data.automation ? data.automation.activeLease : null;
  if (!lease || typeof lease !== "object" || lease.scope !== leaseScope) return null;
  if (!Number.isSafeInteger(lease.fence) || typeof lease.holder !== "string" || !lease.holder) return null;
  return { holder: lease.holder, scope: lease.scope, fence: lease.fence };
}

/**
 * @param corePort        derselbe `core`-Port, der schon dem Trichter dient.
 * @param costPolicyPort  echter oder Testport mit `.load()`.
 * @param clockPort       `{ now() }`.
 * @param gmailSource     `createGmailSourceReader(...)`.
 * @param anthropic       `createAnthropicTransport(...)`.
 * @param leaseScope      MUSS mit `config.leaseScope` uebereinstimmen.
 * @param maxPages        Testhaken; Produktion laesst die 90-s-Frist des
 *                         Aufrufers ohnehin natuerlich abschneiden.
 */
export function createSectionWorkProvider({
  corePort, costPolicyPort, clockPort, gmailSource, anthropic, leaseScope, policy, runtimeConfig,
  maxPages = DEFAULT_MAX_PAGES,
} = {}) {
  if (!corePort || typeof corePort.read !== "function" || typeof corePort.mutate !== "function") {
    throw new TypeError("corePort erforderlich");
  }
  if (!costPolicyPort || typeof costPolicyPort.load !== "function") throw new TypeError("costPolicyPort erforderlich");
  if (!clockPort || typeof clockPort.now !== "function") throw new TypeError("clockPort erforderlich");
  if (!gmailSource) throw new TypeError("gmailSource erforderlich");
  if (!anthropic) throw new TypeError("anthropic erforderlich");
  if (typeof leaseScope !== "string" || !leaseScope) throw new TypeError("leaseScope erforderlich");
  if (!validatePolicy(policy).ok) throw new TypeError("policy erforderlich (tagesbriefing-policy/3)");
  // Dieselbe echte Betriebsart-/Freigabepruefung wie der Rest des Dienstes
  // (config.mjs `externalEffectsAllowed`) — NIE hier fest auf "live"
  // gesetzt. Ohne die echte, vom Server aufgeloeste Konfiguration bleibt
  // die Aussenwirkung gesperrt, so wie es sein soll.
  if (!runtimeConfig || typeof runtimeConfig.mode !== "string") throw new TypeError("runtimeConfig erforderlich");

  // Minimaler ctx fuer cost-adapter.mjs: derselbe Vertrag wie im echten
  // Worker, nur mit den drei Ports zusammengestellt, die dieses Modul
  // ohnehin schon haelt. `verifiedScope` kommt frisch aus dem Kern, NICHT
  // vom Aufrufer — cost-adapter.mjs prueft selbst noch einmal per CAS
  // gegen den dann aktuellen Bestand, ein optimistischer Kandidat hier
  // ersetzt diese Pruefung nicht.
  function kostenCtx(now, verifiedScope, requestId) {
    return {
      now, verifiedScope, requestId, config: runtimeConfig,
      ports: {
        require(name) {
          if (name === "core") return corePort;
          if (name === "costPolicy") return costPolicyPort;
          if (name === "clock") return clockPort;
          throw new HttpError(503, "port_unavailable", { port: name });
        },
      },
    };
  }

  return availablePort("sectionWork", {
    async next({ runKey, sectionId, cursor, now, resumedFrom, signal }) {
      let state = cursor && typeof cursor === "object" && typeof cursor.phase === "string" ? cursor : null;
      if (!state) {
        const snap = await corePort.read();
        let sinceMs = null;
        const prevCursor = snap.data?.automation?.sourceCursors?.[SOURCE_ID]?.cursor;
        if (typeof prevCursor === "string") {
          try { sinceMs = JSON.parse(prevCursor)?.sinceMs ?? null; } catch { sinceMs = null; }
        }
        state = { phase: "gmail", pageToken: null, sinceMs, pagesSeen: 0, outcome: "ok", messages: [] };
      }

      if (state.phase === "gmail") {
        if (state.pagesSeen >= maxPages) {
          return { done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0, cursor: { ...state, phase: "finalize", outcome: worseOutcome(state.outcome, "partial") } };
        }
        const seite = await gmailSource.listPage({ pageToken: state.pageToken, sinceMs: state.sinceMs, signal });
        if (!seite.ok) {
          return { done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0, cursor: { ...state, phase: "finalize", outcome: seite.error.code, pageToken: null } };
        }
        const gelesen = [];
        let seitenAusgang = "ok";
        for (const id of seite.ids) {
          const nachricht = await gmailSource.getMessage({ id, signal });
          if (!nachricht.ok) { seitenAusgang = worseOutcome(seitenAusgang, nachricht.error.code === "auth_error" ? "auth_error" : "partial"); continue; }
          if (nachricht.partial) seitenAusgang = worseOutcome(seitenAusgang, "partial");
          if (state.messages.length < 10) {
            gelesen.push({ evidenceRef: nachricht.message.id, subject: nachricht.message.subject, snippet: nachricht.message.snippet });
          }
        }
        const naechster = { ...state, pageToken: seite.nextPageToken, pagesSeen: state.pagesSeen + 1, outcome: worseOutcome(state.outcome, seitenAusgang), messages: [...state.messages, ...gelesen] };
        if (!seite.nextPageToken) return { done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0, cursor: { ...naechster, phase: "finalize", vollstaendig: true } };
        return { done: false, stepId: `gmail-page:${runKey}:${state.pagesSeen}`, durationMs: 0, cursor: naechster };
      }

      if (state.phase === "finalize") {
        const jetzt = clockPort.now();
        const datum = localDateOfRunKey(runKey);
        if (!datum) throw new HttpError(500, "run_key_invalid", { runKey });
        const wasserzeichen = state.vollstaendig === true ? { sinceMs: jetzt } : { sinceMs: state.sinceMs };
        const commandId = `source-check:${runKey}:${SOURCE_ID}`;
        const out = await coreMutate(corePort, commandId, jetzt, applyDomainCommand(
          "recordSourceCheck",
          { date: datum, sourceId: SOURCE_ID, cursor: JSON.stringify(wasserzeichen), outcome: state.outcome, detail: `pages=${state.pagesSeen}` },
          ADAPTER_ACTOR, jetzt, commandId, policy,
        ));
        if (!out.result.ok) return { done: true, stepId: `gmail-finalize:${runKey}`, durationMs: 0 };
        return { done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0, cursor: { phase: "draft", messages: state.messages, sourceOutcome: state.outcome } };
      }

      if (state.phase === "draft") {
        if (state.messages.length === 0) return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        const jetzt0 = clockPort.now();
        const snap = await corePort.read();
        const verifiedScope = verifiedScopeAus(snap.data, leaseScope);
        if (!verifiedScope) throw new HttpError(409, "lease_lost", { runKey });
        const ctx = kostenCtx(jetzt0, verifiedScope, `draft:${runKey}`);
        const adapter = createCostAdapter(ctx);
        const callId = `draft:${runKey}`;
        const inhalt = JSON.stringify(state.messages);
        let contentHash;
        try {
          contentHash = await stableHash(inhalt);
          await adapter.reserve({ callId, runKey, provider: "anthropic", model: anthropic.model, contentHash, inputTokens: schaetzeTokens(inhalt), outputTokens: 400 });
        } catch (e) {
          // Abgelehnte Reservierung (Preisstand fehlt/ungueltig, ueber der
          // Preis-/Richtliniengrenze, Fuehrung verloren, Tageswechsel, …)
          // ist kein Fehler DIESES Schritts — der Lauf endet ehrlich ohne
          // Entwurf statt eines erzwungenen Sendeversuchs.
          return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        }
        let ausgang;
        try {
          ausgang = await adapter.claimAndDispatch({
            callId, claimId: `${callId}:1`,
            send: () => anthropic.dispatch({ sourceMessages: state.messages, requestId: callId, signal }),
          });
        } catch (e) {
          // Kein freigegebener Sendezustand (dry_run, Fence weg, Budget) ist
          // hier kein Fehler dieses Schritts — der Lauf endet ehrlich ohne
          // Entwurf statt gruen ohne echten Aufruf.
          return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        }
        if (ausgang.outcome !== "settled") return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };

        const jetzt1 = clockPort.now();
        const datum = localDateOfRunKey(runKey);
        const text = `Quelle ${SOURCE_ID} (${state.sourceOutcome}), ${state.messages.length} Beleg(e): ` + (await anthropicText(ausgang));
        const noteCommandId = `draft-note:${runKey}`;
        await coreMutate(corePort, noteCommandId, jetzt1, applyDomainCommand(
          "appendRunNote", { date: datum, noteId: `v3-draft:${runKey}`, text: text.slice(0, 4000) }, SYSTEM_ACTOR, jetzt1, noteCommandId, policy,
        ));
        return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: jetzt1 - jetzt0 };
      }

      throw new HttpError(500, "section_work_state_invalid", { phase: state.phase });
    },
  });
}

function worseOutcome(a, b) {
  const rang = { ok: 0, partial: 1, unreachable: 2, budget_exceeded: 2, auth_error: 3 };
  return (rang[b] ?? 1) > (rang[a] ?? 0) ? b : a;
}
function schaetzeTokens(text) { return Math.ceil(text.length / 4); }
async function anthropicText(ausgang) { return ausgang.draftText || ""; }
async function stableHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64);
}

export function createUnavailableSectionWorkPort(reason) { return unavailablePort("sectionWork", reason); }
