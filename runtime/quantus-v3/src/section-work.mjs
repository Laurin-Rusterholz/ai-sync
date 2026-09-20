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
 *                             Das WASSERZEICHEN wird hier NUR vorgezogen,
 *                             wenn es nichts zu entwerfen gibt; sonst bleibt
 *                             es unveraendert, bis der Entwurf TATSAECHLICH
 *                             gelingt (s. u., Review-Befund F/G-2 #3).
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
 *                             zweiten Anspruch auf denselben `callId`). ERST
 *                             wenn dieser Entwurf wirklich gelingt
 *                             (`settled` + Notiz geschrieben), wird das
 *                             Wasserzeichen NACHTRAEGLICH bestaetigt — ein
 *                             Kostenfehler oder Absturz zwischen Quellen-
 *                             beleg und Entwurf ueberspringt damit keine
 *                             unverarbeitete Mail beim naechsten Lauf
 *                             (Review-Befund F/G-2 #3+#4).
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
 * Fuehrung/Fence: `next()` bekommt die verifizierte Fuehrung (`holder`,
 * `fence`, `scope`) vom AUFRUFER (worker-handlers.mjs `runSection`), der sie
 * selbst gerade erst per `acquireAttemptLease` erhalten hat — dieses Modul
 * LIEST sie nicht mehr selbst aus dem aktuellen Bestand (das haette, schon
 * beim ALLERERSTEN Aufruf, irgendeine gerade aktive Pacht uebernehmen
 * koennen, nicht zwingend die des eigenen Auftrags — Review-Befund F/G-2
 * #5). Sie wird einmal in den Cursor uebernommen (`state.fence`) und bei
 * JEDER spaeteren schreibenden Stufe (Quellenbeleg, Notiz, Fehlerprotokoll)
 * innerhalb der CAS-Mutation erneut EXAKT gegen den dann aktuellen Bestand
 * UND eine frisch gelesene Uhr (Ablaufzeit) geprueft — ein alter Arbeiter,
 * dessen Pacht laengst an einen neueren Halter uebergegangen oder schlicht
 * abgelaufen ist, kann so nicht mehr schreiben (Review-Befund F/G #7,
 * F/G-2 #6).
 * ═════════════════════════════════════════════════════════════════════════ */
import { applyCommand } from "../../../netlify/lib/assistant-core.mjs";
import { validatePolicy } from "../../../netlify/lib/assistant-schema.mjs";
import { DOMAIN_PORT_VARS } from "../../../netlify/lib/quantus-v3-domain-adapter.mjs";
import { createCostAdapter } from "./cost-adapter.mjs";
import { MONTHLY_CAP_MICROS } from "./monthly-cost-cap.mjs";
import { estimateRequestTokenCap, MAX_SOURCE_BLOCKS } from "./anthropic-transport.mjs";
import { availablePort, unavailablePort } from "./ports.mjs";
import { HttpError } from "./errors.mjs";

export const SOURCE_ID = "gmail";
const DEFAULT_MAX_PAGES = 50;
// MUSS mit anthropic-transport.mjs `MAX_SOURCE_BLOCKS` uebereinstimmen —
// sonst zaehlt dieses Modul mehr Nachrichten als tatsaechlich gesendet
// werden (stiller Verlust zwischen Zaehlung und Sendung).
const MAX_MESSAGES_PER_RUN = MAX_SOURCE_BLOCKS;
// Kleines Ueberlappungsfenster: der naechste Lauf fragt Gmail etwas VOR dem
// zuletzt bestaetigten Wasserzeichen erneut ab, damit eine Nachricht, die
// durch Uhren-/Indexierungsverzug knapp am Schnitt vorbeirutscht, nicht fuer
// immer uebersehen wird. `priorRecentIds` dedupliziert dieses Fenster UND
// jede bereits ERFOLGREICH entworfene Nachricht, damit weder eine Luecke
// noch eine Doppelverarbeitung entsteht.
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

function gueltigeVerifiedScope(verifiedScope, leaseScope) {
  return verifiedScope && typeof verifiedScope === "object"
    && verifiedScope.scope === leaseScope
    && Number.isSafeInteger(verifiedScope.fence)
    && typeof verifiedScope.holder === "string" && verifiedScope.holder.length > 0;
}

/* Echtes Kern-Kommando ueber `assistant-core.applyCommand` — dieselbe
 * Funktion, die B/C3a fuer jede andere Wirkung nutzen. Kein Nachbau der
 * Aktor-/Policy-/Schutzfeldpruefung. Zusaetzlich zur normalen Kommando-
 * pruefung: die Pacht-Fence wird INNERHALB des CAS-Mutators (also gegen den
 * dann aktuellsten Bestand, NICHT gegen einen fruehen Schnappschuss) noch
 * einmal exakt gegen die vom Aufrufer verifizierte Fence geprueft — UND
 * gegen eine bei JEDEM CAS-Versuch frisch gelesene Uhr, damit eine
 * inzwischen abgelaufene (aber noch nicht formell abgeloeste) Pacht nicht
 * mehr als gueltig gilt (Review-Befund F/G-2 #6). */
function fencedDomainCommand(type, payload, actor, now, commandId, policy, leaseScope, expectedFence, clockPort) {
  return (draft) => {
    const lease = draft.automation ? draft.automation.activeLease : null;
    const frischeZeit = clockPort.now();
    const fenceOk = lease && typeof lease === "object" && lease.scope === leaseScope
      && Number.isSafeInteger(lease.fence) && lease.fence === expectedFence
      && Number.isSafeInteger(lease.expiresAtMs) && lease.expiresAtMs > frischeZeit;
    if (!fenceOk) {
      return { data: draft, result: { ok: false, code: "lease_fenced_out" } };
    }
    const result = applyCommand(draft, { type, commandId, now, payload }, { policy, actor });
    return { data: result.ok ? result.data : draft, result };
  };
}

/* Bestmuehliches, NIE werfendes Protokollieren eines Fehlschlags ueber den
 * echten Domain-Kern (`recordRunEvent`) — sichtbar/dauerhaft statt
 * stillschweigend verschluckt (Review-Befund F/G #6), UND selbst
 * fence-gebunden: ein bereits abgeloester/abgelaufener Arbeiter darf auch
 * kein Protokollereignis mehr schreiben (Review-Befund F/G-2 #6). */
async function logFehler(corePort, clockPort, policy, leaseScope, expectedFence, runKey, code, detail) {
  try {
    const jetzt = clockPort.now();
    const datum = localDateOfRunKey(runKey);
    if (!datum) return;
    const eventId = `${runKey}:err:${code}`;
    await coreMutate(corePort, eventId, jetzt, fencedDomainCommand(
      "recordRunEvent",
      { date: datum, eventId, event: code.slice(0, 64), detail: detail == null ? null : String(detail).slice(0, 2000) },
      SYSTEM_ACTOR, jetzt, eventId, policy, leaseScope, expectedFence, clockPort,
    ));
  } catch { /* Protokollieren ist bestmuehlich; ein Fehler hier eskaliert nicht. */ }
}

function mergeRecentIds(prior, neu) {
  const kombiniert = [...prior, ...neu];
  return kombiniert.slice(-RECENT_IDS_MAX);
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
  // ohnehin schon haelt. `verifiedScope` kommt vom Aufrufer (s. o.) —
  // cost-adapter.mjs prueft selbst noch einmal per CAS mit frischer Zeit
  // gegen den dann aktuellen Bestand, das ersetzt diese Pruefung nicht.
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
    async next({ runKey, sectionId, cursor, now, resumedFrom, signal, verifiedScope }) {
      if (!gueltigeVerifiedScope(verifiedScope, leaseScope)) {
        throw new HttpError(409, "lease_lost", { runKey, reason: "verified_scope_missing" });
      }
      let state = cursor && typeof cursor === "object" && typeof cursor.phase === "string" ? cursor : null;
      if (state && Number.isSafeInteger(state.fence) && state.fence !== verifiedScope.fence) {
        // Derselbe Fortsetzungslauf darf nicht mit einer ANDEREN Fence
        // weitergefuehrt werden, als er begonnen hat.
        throw new HttpError(409, "lease_fenced", { runKey });
      }
      const fence = state ? state.fence : verifiedScope.fence;

      if (!state) {
        const snap = await corePort.read();
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
        // VOR jedem Lesen erfasst: der Massstab fuer ein spaeter bestaetigtes
        // Wasserzeichen ist der SCAN-BEGINN, nicht der (spaetere, ggf. viel
        // juengere) Zeitpunkt des Abschlusses — sonst koennten Mails, die
        // WAEHREND des Scans eintreffen, unbemerkt vor das neue Wasserzeichen
        // rutschen (Review-Befund F/G-2 #3).
        const scanStartMs = clockPort.now();
        state = {
          phase: "gmail", pageToken: null, sinceMs: effectiveSinceMs, pagesSeen: 0, outcome: "ok",
          messages: [], seenIds: [], priorRecentIds, fence, scanStartMs,
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
          if (state.priorRecentIds.includes(id)) continue; // Ueberlappungsfenster ODER bereits erfolgreich entworfen
          const nachricht = await gmailSource.getMessage({ id, signal });
          if (!nachricht.ok) { seitenAusgang = worseOutcome(seitenAusgang, nachricht.error.code === "auth_error" ? "auth_error" : "partial"); continue; }
          if (nachricht.partial) seitenAusgang = worseOutcome(seitenAusgang, "partial");
          if (gesamtNachDieserSeite >= MAX_MESSAGES_PER_RUN) {
            // Echtes Mengenlimit erreicht: ehrlich `partial` statt die
            // Nachricht stillschweigend zu verwerfen, waehrend der Ausgang
            // weiter "ok" behauptet (Review-Befund F/G #3). WICHTIG: diese
            // Id gilt NICHT als "gesehen" (`neueIds`) — sie wurde ja nicht in
            // den Entwurf aufgenommen. Wuerde sie trotzdem in `recentIds`
            // landen, waere sie fuer immer uebersprungen, OHNE je entworfen
            // worden zu sein — der Fehler, den dieser Umbau gerade beheben
            // soll. Das Wasserzeichen wandert dadurch NICHT weiter; sobald
            // der Entwurf fuer die HIER eingeschlossenen Nachrichten gelingt,
            // werden GENAU SIE (per `recentIds`) beim naechsten Lauf
            // uebersprungen — die uebrigen ruecken dann nach, statt fuer
            // immer im selben Stapel zu verharren (Review-Befund F/G-2 #4).
            seitenAusgang = worseOutcome(seitenAusgang, "partial");
            continue;
          }
          gesamtNachDieserSeite += 1;
          neueIds.push(id);
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
        const wirklichVollstaendig = state.vollstaendig === true && state.outcome === "ok";
        // Nichts zu entwerfen: sofort sicher bestaetigen, wenn die
        // Abdeckung selbst sauber war. Gibt es Nachrichten, bleibt das
        // Wasserzeichen UNVERAENDERT — die Bestaetigung folgt erst nach
        // einem WIRKLICH gelungenen Entwurf (s. u., "draft"-Zweig).
        const wasserzeichen = state.messages.length === 0
          ? (wirklichVollstaendig ? { sinceMs: state.scanStartMs, recentIds: mergeRecentIds(state.priorRecentIds, state.seenIds) } : { sinceMs: state.sinceMs, recentIds: state.priorRecentIds })
          : { sinceMs: state.sinceMs, recentIds: state.priorRecentIds };
        const commandId = `source-check:${runKey}:${SOURCE_ID}`;
        const out = await coreMutate(corePort, commandId, jetzt, fencedDomainCommand(
          "recordSourceCheck",
          { date: datum, sourceId: SOURCE_ID, cursor: JSON.stringify(wasserzeichen), outcome: state.outcome, detail: `pages=${state.pagesSeen}` },
          ADAPTER_ACTOR, jetzt, commandId, policy, leaseScope, state.fence, clockPort,
        ));
        if (!out.result.ok) {
          if (out.result.code === "lease_fenced_out") throw new HttpError(409, "lease_lost", { runKey });
          await logFehler(corePort, clockPort, policy, leaseScope, state.fence, runKey, "source_check_failed", out.result.code);
          return { done: true, stepId: `gmail-finalize:${runKey}`, durationMs: 0 };
        }
        return {
          done: false, stepId: `gmail-finalize:${runKey}`, durationMs: 0,
          cursor: {
            phase: "draft", messages: state.messages, sourceOutcome: state.outcome, fence: state.fence,
            scanStartMs: state.scanStartMs, sinceMs: state.sinceMs, priorRecentIds: state.priorRecentIds,
            seenIds: state.seenIds, wirklichVollstaendig, pagesSeen: state.pagesSeen,
          },
        };
      }

      if (state.phase === "draft") {
        if (state.messages.length === 0) return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        const jetzt0 = clockPort.now();
        const datum = localDateOfRunKey(runKey);
        if (!datum) throw new HttpError(500, "run_key_invalid", { runKey });
        const ctx = kostenCtx(jetzt0, verifiedScope, `draft:${runKey}`);
        // Explizite, vom Nutzer beauftragte globale $50/Kalendermonat-
        // Betriebs-Kostengrenze — getrennt von jeder Cost-Policy-Grenze,
        // atomar geprueft innerhalb derselben CAS-Mutation wie die
        // Reservierung selbst (monthly-cost-cap.mjs). Nicht ueber Umgebung/
        // UI/Modelltext veraenderbar.
        const adapter = createCostAdapter(ctx, { monthlyCap: { capMicros: MONTHLY_CAP_MICROS } });
        const callId = `draft:${runKey}`;
        // Dieselbe Anfrage (System + Nutzerinhalt), die der Transport
        // TATSAECHLICH sendet — keine separate, driftende Schaetzung
        // (Review-Befund F/G #5). Die Obergrenze selbst ist jetzt eine
        // BEWIESEN konservative Byte-Obergrenze, kein "Zeichen/3"-Schaetzwert
        // (Review-Befund F/G-2 #1, s. anthropic-transport.mjs).
        const tokenObergrenze = estimateRequestTokenCap(state.messages);
        let contentHash;
        try {
          contentHash = await stableHash(tokenObergrenze + "|" + JSON.stringify(state.messages));
          await adapter.reserve({
            callId, runKey, provider: "anthropic", model: anthropic.model, contentHash,
            inputTokens: tokenObergrenze,
            outputTokens: anthropic.maxOutputTokens,
          });
        } catch (e) {
          // Abgelehnte Reservierung (Preisstand fehlt/ungueltig, ueber der
          // Preis-/Richtliniengrenze, Fuehrung verloren, Tageswechsel, …)
          // ist kein Fehler DIESES Schritts — der Lauf endet ehrlich ohne
          // Entwurf statt eines erzwungenen Sendeversuchs. Sichtbar bleibt
          // das trotzdem: kein stilles `done:true` ohne Spur. Das
          // Wasserzeichen bleibt unveraendert (s. o.) — dieselben
          // Nachrichten werden beim naechsten Lauf erneut versucht.
          await logFehler(corePort, clockPort, policy, leaseScope, state.fence, runKey, "reserve_failed", (e && (e.code || e.message)) || String(e));
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
                  SYSTEM_ACTOR, jetztNote, noteCommandId, policy, leaseScope, state.fence, clockPort,
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
          await logFehler(corePort, clockPort, policy, leaseScope, state.fence, runKey, "dispatch_failed", (e && (e.code || e.message)) || String(e));
          return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };
        }
        if (ausgang.outcome !== "settled") return { done: true, stepId: `draft-dispatch:${runKey}`, durationMs: 0 };

        // ERST JETZT, nach einem WIRKLICH gelungenen, dauerhaft
        // gespeicherten Entwurf, wird das Wasserzeichen bestaetigt — nie
        // vorher (Review-Befund F/G-2 #3). Die soeben entworfenen
        // Nachrichten werden dabei IMMER in `recentIds` aufgenommen, auch
        // wenn die Abdeckung insgesamt `partial` war: genau das verhindert,
        // dass ein Mengenlimit-Ueberlauf denselben Stapel jeden Lauf erneut
        // entwirft, statt weiterzuruecken (Review-Befund F/G-2 #4).
        const jetzt1 = clockPort.now();
        const bestaetigtesFenster = state.wirklichVollstaendig
          ? { sinceMs: state.scanStartMs, recentIds: mergeRecentIds(state.priorRecentIds, state.seenIds) }
          : { sinceMs: state.sinceMs, recentIds: mergeRecentIds(state.priorRecentIds, state.seenIds) };
        const advanceCommandId = `source-check-advance:${runKey}:${SOURCE_ID}`;
        const advanceOut = await coreMutate(corePort, advanceCommandId, jetzt1, fencedDomainCommand(
          "recordSourceCheck",
          { date: datum, sourceId: SOURCE_ID, cursor: JSON.stringify(bestaetigtesFenster), outcome: state.sourceOutcome, detail: `pages=${state.pagesSeen}` },
          ADAPTER_ACTOR, jetzt1, advanceCommandId, policy, leaseScope, state.fence, clockPort,
        ));
        if (!advanceOut.result.ok) {
          // Der Entwurf steht bereits sicher; nur die Wasserzeichen-
          // Bestaetigung schlug fehl (z. B. Fuehrung inzwischen verloren).
          // Sichtbar protokolliert, aber kein Fehler dieses Schritts — beim
          // naechsten Lauf werden dieselben Nachrichten (dank `recentIds`
          // noch nicht dabei bekannt) einfach erneut korrekt bewertet.
          await logFehler(corePort, clockPort, policy, leaseScope, state.fence, runKey, "watermark_advance_failed", advanceOut.result.code);
        }
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
