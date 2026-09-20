/* ══ F/G — sectionWork: echte, gescopte Quellenverarbeitung + Sonnet-Draft ═
 *
 * Fuellt den seit E2 offenen `sectionWork`-Port (`runtime/quantus-v3/src/
 * ports.mjs`) mit einem echten, aber bewusst schmalen vertikalen Pfad:
 *
 *   Schritte "gmail-page-N"   eine Gmail-Seite lesen (Nur-Lese, paginiert,
 *                             ueber `gmail-source.mjs`), Nachrichten-
 *                             Metadaten+Volltext sammeln, bis zu
 *                             `MAX_MESSAGES_PER_RUN`. Jede Seite ist ein
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
 *                             Nur bei vollstaendiger, FEHLERFREIER Abdeckung
 *                             (kein Seitenrest, keine Nachricht uebersprungen
 *                             oder verworfen) wandert das Wasserzeichen
 *                             (`sourceCursors.gmail`) weiter; sonst deckt
 *                             der naechste Lauf dasselbe (ueberlappende)
 *                             Fenster erneut ab — kein stiller Verlust,
 *                             hoechstens redundante Wiederholung.
 *   Schritt "draft-dispatch"  NUR wenn mindestens eine Quelle gelesen
 *                             wurde: echte Kostenreservierung + Sendung
 *                             (`cost-adapter.mjs`, wiederverwendet, nicht
 *                             nachgebaut) an den echten Sonnet-Transport
 *                             (`anthropic-transport.mjs`). Die Notiz wird
 *                             INNERHALB des `send()`-Aufrufs geschrieben,
 *                             BEVOR die Kosten abgerechnet werden — ein
 *                             Absturz danach verliert weder die Ausgabe
 *                             (die Notiz steht schon) noch zahlt er ein
 *                             zweites Mal (`claimCostDispatch` sperrt einen
 *                             zweiten Anspruch auf denselben `callId`).
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
 *
 * Fuehrung/Fence: die urspruengliche Pacht-Fence wird EINMAL beim ersten
 * Aufruf eines Laufs gelesen und ueber den gesamten Cursor (`state.fence`)
 * mitgefuehrt. JEDE spaetere schreibende Stufe (Quellenbeleg, Notiz, Kosten)
 * prueft diese EXAKTE Fence erneut gegen den dann aktuellen Bestand — ein
 * alter Arbeiter, dessen Pacht laengst an einen neueren Halter uebergegangen
 * ist, kann so nicht dessen Identitaet uebernehmen (Review-Befund F/G #7).
 * ═════════════════════════════════════════════════════════════════════════ */
import { applyCommand } from "../../../netlify/lib/assistant-core.mjs";
import { validatePolicy } from "../../../netlify/lib/assistant-schema.mjs";
import { DOMAIN_PORT_VARS } from "../../../netlify/lib/quantus-v3-domain-adapter.mjs";
import { createCostAdapter } from "./cost-adapter.mjs";
import { estimateRequestChars, MAX_SOURCE_BLOCKS } from "./anthropic-transport.mjs";
import { availablePort, unavailablePort } from "./ports.mjs";
import { HttpError } from "./errors.mjs";

export const SOURCE_ID = "gmail";
const DEFAULT_MAX_PAGES = 50;
// MUSS mit anthropic-transport.mjs `MAX_SOURCE_BLOCKS` uebereinstimmen —
// sonst zaehlt dieses Modul mehr Nachrichten als tatsaechlich gesendet
// werden (stiller Verlust zwischen Zaehlung und Sendung).
const MAX_MESSAGES_PER_RUN = MAX_SOURCE_BLOCKS;
// Kleines Ueberlappungsfenster: der naechste Lauf fragt Gmail etwas VOR dem
// zuletzt gesetzten Wasserzeichen erneut ab, damit eine Nachricht, die durch
// Uhren-/Indexierungsverzug knapp am Schnitt vorbeirutscht, nicht fuer immer
// uebersehen wird. `priorRecentIds` dedupliziert das Ueberlappungsfenster,
// damit dieselbe Nachricht nicht zweimal in einen Entwurf gelangt.
const WATERMARK_OVERLAP_MS = 3 * 60 * 1000;
const RECENT_IDS_MAX = 300;

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
 * Aktor-/Policy-/Schutzfeldpruefung. Zusaetzlich zur normalen Kommando-
 * pruefung: die Pacht-Fence wird INNERHALB des CAS-Mutators (also gegen den
 * dann aktuellsten Bestand, nicht gegen einen fruehen Schnappschuss) noch
 * einmal exakt gegen die beim Laufstart erfasste Fence geprueft. */
function fencedDomainCommand(type, payload, actor, now, commandId, policy, leaseScope, expectedFence) {
  return (draft) => {
    const lease = draft.automation ? draft.automation.activeLease : null;
    const fenceOk = lease && typeof lease === "object" && lease.scope === leaseScope
      && Number.isSafeInteger(lease.fence) && lease.fence === expectedFence;
    if (!fenceOk) {
      return { data: draft, result: { ok: false, code: "lease_fenced_out" } };
    }
    const result = applyCommand(draft, { type, commandId, now, payload }, { policy, actor });
    return { data: result.ok ? result.data : draft, result };
  };
}

function verifiedScopeAus(data, leaseScope, expectedFence) {
  const lease = data.automation ? data.automation.activeLease : null;
  if (!lease || typeof lease !== "object" || lease.scope !== leaseScope) return null;
  if (!Number.isSafeInteger(lease.fence) || typeof lease.holder !== "string" || !lease.holder) return null;
  if (Number.isSafeInteger(expectedFence) && lease.fence !== expectedFence) return null;
  return { holder: lease.holder, scope: lease.scope, fence: lease.fence };
}

/* Bestmuehliches, NIE werfendes Protokollieren eines Fehlschlags ueber den
 * echten Domain-Kern (`recordRunEvent`) — sichtbar/dauerhaft statt
 * stillschweigend verschluckt (Review-Befund F/G #6). Ein Fehlschlag DIESES
 * Protokolliervorgangs selbst darf den eigentlichen Ablauf nicht stoeren. */
async function logFehler(corePort, clockPort, policy, runKey, code, detail) {
  try {
    const jetzt = clockPort.now();
    const datum = localDateOfRunKey(runKey);
    if (!datum) return;
    const eventId = `${runKey}:err:${code}`;
    await coreMutate(corePort, eventId, jetzt, (draft) => {
      const result = applyCommand(draft, {
        type: "recordRunEvent", commandId: eventId, now: jetzt,
        payload: { date: datum, eventId, event: code.slice(0, 64), detail: detail == null ? null : String(detail).slice(0, 2000) },
      }, { policy, actor: SYSTEM_ACTOR });
      return { data: result.ok ? result.data : draft, result };
    });
  } catch { /* Protokollieren ist bestmuehlich; ein Fehler hier eskaliert nicht. */ }
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
        const lease0 = verifiedScopeAus(snap.data, leaseScope, null);
        if (!lease0) throw new HttpError(409, "lease_lost", { runKey });
        let sinceMs = null;
        let priorRecentIds = [];
        const prevCursor = snap.data?.automation?.sourceCursors?.[SOURCE_ID]?.cursor;
        if (typeof prevCursor === "string") {
          try {
            const parsed = JSON.parse(prevCursor);
            sinceMs = Number.isSafeInteger(parsed?.sinceMs) ? parsed.sinceMs : null;
            priorRecentIds = Array.isArray(parsed?.recentIds) ? parsed.recentIds.filter((x) => typeof x === "string").slice(-RECENT_IDS_MAX) : [];
          } catch { sinceMs = null; }
        }
        const effectiveSinceMs = Number.isSafeInteger(sinceMs) ? Math.max(0, sinceMs - WATERMARK_OVERLAP_MS) : null;
        state = {
          phase: "gmail", pageToken: null, sinceMs: effectiveSinceMs, pagesSeen: 0, outcome: "ok",
          messages: [], seenIds: [], priorRecentIds, fence: lease0.fence,
        };
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
        const neueIds = [];
        let seitenAusgang = "ok";
        let gesamtNachDieserSeite = state.messages.length;
        for (const id of seite.ids) {
          if (state.priorRecentIds.includes(id)) continue; // Ueberlappungsfenster: schon im vorigen Lauf verarbeitet
          const nachricht = await gmailSource.getMessage({ id, signal });
          if (!nachricht.ok) { seitenAusgang = worseOutcome(seitenAusgang, nachricht.error.code === "auth_error" ? "auth_error" : "partial"); continue; }
          if (nachricht.partial) seitenAusgang = worseOutcome(seitenAusgang, "partial");
          neueIds.push(id);
          if (gesamtNachDieserSeite >= MAX_MESSAGES_PER_RUN) {
            // Echtes Mengenlimit erreicht: ehrlich `partial` statt die
            // Nachricht stillschweigend zu verwerfen, waehrend der Ausgang
            // weiter "ok" behauptet (Review-Befund F/G #3). Das Wasserzeichen
            // wandert dadurch (s. u.) NICHT weiter — der naechste Lauf holt
            // das Fenster erneut, statt die Nachricht fuer immer zu verlieren.
            seitenAusgang = worseOutcome(seitenAusgang, "partial");
            continue;
          }
          gesamtNachDieserSeite += 1;
          gelesen.push({ evidenceRef: nachricht.message.id, subject: nachricht.message.subject, snippet: nachricht.message.snippet, body: nachricht.message.body, attachments: nachricht.message.attachments });
        }
        const naechster = {
          ...state, pageToken: seite.nextPageToken, pagesSeen: state.pagesSeen + 1,
          outcome: worseOutcome(state.outcome, seitenAusgang),
          messages: [...state.messages, ...gelesen],
          seenIds: [...state.seenIds, ...neueIds],
        };
        if (!seite.nextPageToken) return { done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0, cursor: { ...naechster, phase: "finalize", vollstaendig: true } };
        return { done: false, stepId: `gmail-page:${runKey}:${state.pagesSeen}`, durationMs: 0, cursor: naechster };
      }

      if (state.phase === "finalize") {
        const jetzt = clockPort.now();
        const datum = localDateOfRunKey(runKey);
        if (!datum) throw new HttpError(500, "run_key_invalid", { runKey });
        // Das Wasserzeichen wandert NUR bei vollstaendiger UND fehlerfreier
        // Abdeckung weiter — `vollstaendig` allein (kein Seitenrest) sagt
        // nichts darueber, ob innerhalb der Seiten Nachrichten fehlschlugen
        // oder wegen des Mengenlimits verworfen wurden (Review-Befund F/G #4).
        const wirklichVollstaendig = state.vollstaendig === true && state.outcome === "ok";
        const wasserzeichen = wirklichVollstaendig
          ? { sinceMs: jetzt, recentIds: state.seenIds.slice(-RECENT_IDS_MAX) }
          : { sinceMs: state.sinceMs, recentIds: state.priorRecentIds };
        const commandId = `source-check:${runKey}:${SOURCE_ID}`;
        const out = await coreMutate(corePort, commandId, jetzt, fencedDomainCommand(
          "recordSourceCheck",
          { date: datum, sourceId: SOURCE_ID, cursor: JSON.stringify(wasserzeichen), outcome: state.outcome, detail: `pages=${state.pagesSeen}` },
          ADAPTER_ACTOR, jetzt, commandId, policy, leaseScope, state.fence,
        ));
        if (!out.result.ok) {
          if (out.result.code === "lease_fenced_out") throw new HttpError(409, "lease_lost", { runKey });
          await logFehler(corePort, clockPort, policy, runKey, "source_check_failed", out.result.code);
          return { done: true, stepId: `gmail-finalize:${runKey}`, durationMs: 0 };
        }
        return { done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0, cursor: { phase: "draft", messages: state.messages, sourceOutcome: state.outcome, fence: state.fence } };
      }

      if (state.phase === "draft") {
        if (state.messages.length === 0) return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        const jetzt0 = clockPort.now();
        const datum = localDateOfRunKey(runKey);
        if (!datum) throw new HttpError(500, "run_key_invalid", { runKey });
        const snap = await corePort.read();
        const verifiedScope = verifiedScopeAus(snap.data, leaseScope, state.fence);
        if (!verifiedScope) throw new HttpError(409, "lease_lost", { runKey });
        const ctx = kostenCtx(jetzt0, verifiedScope, `draft:${runKey}`);
        const adapter = createCostAdapter(ctx);
        const callId = `draft:${runKey}`;
        // Dieselbe Zeichenkette (System + Nutzerinhalt), die der Transport
        // TATSAECHLICH sendet — keine separate, driftende Schaetzung mehr
        // (Review-Befund F/G #5). Konservativ auf 3 Zeichen/Token gerundet
        // (statt 4): eine Unterschaetzung darf die Reservierung nie
        // unterschreiten, was tatsaechlich gesendet wird.
        const gesendeterInhalt = estimateRequestChars(state.messages);
        let contentHash;
        try {
          contentHash = await stableHash(gesendeterInhalt + "|" + JSON.stringify(state.messages));
          await adapter.reserve({
            callId, runKey, provider: "anthropic", model: anthropic.model, contentHash,
            inputTokens: Math.ceil(gesendeterInhalt / 3),
            outputTokens: anthropic.maxOutputTokens,
          });
        } catch (e) {
          // Abgelehnte Reservierung (Preisstand fehlt/ungueltig, ueber der
          // Preis-/Richtliniengrenze, Fuehrung verloren, Tageswechsel, …)
          // ist kein Fehler DIESES Schritts — der Lauf endet ehrlich ohne
          // Entwurf statt eines erzwungenen Sendeversuchs. Sichtbar bleibt
          // das trotzdem: kein stilles `done:true` ohne Spur.
          await logFehler(corePort, clockPort, policy, runKey, "reserve_failed", (e && (e.code || e.message)) || String(e));
          return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        }

        const noteCommandId = `draft-note:${runKey}`;
        let ausgang;
        try {
          ausgang = await adapter.claimAndDispatch({
            callId, claimId: `${callId}:1`,
            send: async () => {
              const antwort = await anthropic.dispatch({ sourceMessages: state.messages, requestId: callId, signal });
              if (antwort.outcome === "settled") {
                // Die Notiz wird HIER geschrieben — VOR der Kostenabrechnung
                // (die erst nach Rueckkehr aus `send()` passiert). Ein
                // Absturz danach verliert die Ausgabe nicht mehr: sie steht
                // schon dauerhaft, unabhaengig davon, ob die Abrechnung noch
                // folgt (Review-Befund F/G #1).
                const jetztNote = clockPort.now();
                const text = `Quelle ${SOURCE_ID} (${state.sourceOutcome}), ${state.messages.length} Beleg(e): ` + antwort.draftText;
                const noteOut = await coreMutate(corePort, noteCommandId, jetztNote, fencedDomainCommand(
                  "appendRunNote", { date: datum, noteId: `v3-draft:${runKey}`, text: text.slice(0, 4000) },
                  SYSTEM_ACTOR, jetztNote, noteCommandId, policy, leaseScope, state.fence,
                ));
                if (!noteOut.result.ok) {
                  // Nicht geschrieben: `send()` wirft, `cost-adapter.mjs`
                  // verbucht den Anspruch selbst als `unknown` (bezahlt/
                  // unklar, nie "erfolgreich ohne Spur") und sperrt eine
                  // Wiederholung desselben Inhalts, statt ihn zu verlieren.
                  throw new HttpError(502, "note_persist_failed", { code: noteOut.result.code });
                }
              }
              return antwort;
            },
          });
        } catch (e) {
          // Kein freigegebener Sendezustand (dry_run, Fence weg, Budget)
          // ODER die Notiz konnte nicht geschrieben werden — beides ist kein
          // Fehler DIESES Schritts (cost-adapter.mjs hat den Anspruch bereits
          // sicher verbucht), aber es bleibt sichtbar statt still.
          await logFehler(corePort, clockPort, policy, runKey, "dispatch_failed", (e && (e.code || e.message)) || String(e));
          return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        }
        if (ausgang.outcome !== "settled") return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        // Die Notiz wurde bereits innerhalb von send() geschrieben, BEVOR
        // hier abgerechnet wurde.
        return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: clockPort.now() - jetzt0 };
      }

      throw new HttpError(500, "section_work_state_invalid", { phase: state.phase });
    },
  });
}

function worseOutcome(a, b) {
  const rang = { ok: 0, partial: 1, unreachable: 2, budget_exceeded: 2, auth_error: 3 };
  return (rang[b] ?? 1) > (rang[a] ?? 0) ? b : a;
}
async function stableHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64);
}

export function createUnavailableSectionWorkPort(reason) { return unavailablePort("sectionWork", reason); }
