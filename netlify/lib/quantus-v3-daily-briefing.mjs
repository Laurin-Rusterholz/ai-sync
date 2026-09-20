/* ══ E-Mail-Auswertung fuer das Tagesbriefing: AUF ABRUF, NICHT autonom
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * VERBINDLICHE KLARSTELLUNG DES NUTZERS: die taegliche Orchestrierung
 * (Aufgaben/Notes/Briefing) macht ein von IHM selbst lokal geplanter
 * ChatGPT-Lauf auf seinem eigenen Rechner — AUSSERHALB dieses Repos. Dieses
 * Modul ist NICHT dieser Orchestrator und darf keiner sein. Es ist
 * ausschliesslich die E-Mail-Auswertung, die der lokale Agent bei Bedarf
 * ueber einen authentifizierten Aufruf ANFORDERT — nie ein zweiter,
 * konkurrierender Zeitplan. Die Netlify Function, die dieses Modul aufruft
 * (`netlify/functions/quantus-v3-daily-briefing-run.mjs`), hat DESHALB
 * bewusst KEIN `export const config = { schedule: ... }`: sie darf sich
 * nicht selbst ausloesen, sondern nur auf einen authentifizierten,
 * eingehenden Aufruf reagieren (Zugangsschutz: bestehender
 * `SYNC_AUTH_TOKEN`, s. dortige `darfLaufen`).
 *
 * `runtime/quantus-v3/src/server.mjs` (Cloud-Run-Worker, Cloud-Scheduler-
 * Ausloesung) ist ausserdem NICHT ausgerollt — `infra/quantus-v3/README.md`
 * sagt das ausdruecklich ("kein terraform apply, kein Projekt, kein
 * Dienstkonto") — ist aber ohnehin nicht das Ziel: selbst wenn er ausgerollt
 * waere, wuerde er denselben Fehler machen (ein zweiter autonomer
 * Scheduler). Dieses Modul fuehrt die eigentliche Arbeit (Gmail lesen,
 * Sonnet-Aufruf, Kosten-Ledger, Notiz in DailyBriefing) stattdessen ueber
 * eine ECHTE, bereits ausgelieferte Infrastruktur aus: eine gewoehnliche
 * Netlify Function (Vorbild fuer den Zugangsschutz:
 * netlify/functions/mail-queue-run.mjs), von aussen aufgerufen — nie von
 * einem Netlify-Zeitplan.
 *
 * Wiederverwendet, NICHT nachgebaut:
 *   · netlify/lib/firebase-admin.mjs  `mutateAppData`/`readAppDataDocument`
 *     — derselbe reale CAS-Kern wie jeder andere Schreibpfad der App.
 *   · netlify/lib/assistant-core.mjs  `applyCommand` — dieselbe Aktor-/
 *     Policy-/Schutzfeldpruefung wie jedes andere B-Kommando.
 *   · netlify/lib/quantus-v3-runtime-state.mjs (E1) — Pacht/Fence,
 *     Kosten-Ledger (`reserveCost`/`claimCostDispatch`/`settleCost`).
 *   · runtime/quantus-v3/src/{gmail-source,anthropic-transport,
 *     monthly-cost-cap,section-work}.mjs — dieselben, in diesem Paket
 *     bereits getesteten reinen Module (kein Cloud-Run-Bezug in ihnen
 *     selbst: sie nehmen `fetchImpl`/`getAccessToken` als Parameter).
 *
 * ABSICHTLICH EINFACHER als der (unausgerollte) Cloud-Run-Pfad:
 *   · EIN Durchlauf pro Aufruf, kein Fortsetzen ueber mehrere Aufrufe hinweg
 *     (Cloud Tasks/Checkpoints) — bei taeglich wenigen Dutzend Mails passt
 *     das in einen einzigen Funktionsaufruf.
 *   · Kein `recentIds`-Ueberlappungsfenster zwischen Laeufen — ein
 *     Mengenlimit-Ueberlauf bleibt ehrlich `partial` (Wasserzeichen wandert
 *     nicht), wird aber erst beim NAECHSTEN Tag erneut versucht, nicht
 *     innerhalb desselben Tages nachgeholt. Das ist eine bewusste
 *     Vereinfachung, kein Datenverlust: nichts wird als erledigt behauptet,
 *     was es nicht ist.
 *
 * SICHERHEIT DES ANTHROPIC-SCHLUESSELS: der Nutzer hat ihn bereits in den
 * Quantus-Einstellungen hinterlegt (`APP.state.settings.anthropicApiKey`),
 * eingebettet in `data._settings` und ueber denselben Sync-Pfad wie der
 * Rest der App nach Firebase gespiegelt. Dieses Modul liest ihn NUR aus dem
 * ohnehin schon vorhandenen `FIREBASE_SERVICE_ACCOUNT_JSON`-Zugang
 * (`readAppDataDocument`) — kein neues Zugangsdatum, keine neue
 * Berechtigung. Der Wert wird NIE geloggt, NIE in einer Fehlermeldung
 * ausgegeben und NIE in einer Antwort zurueckgegeben — er verlaesst diese
 * Funktion ausschliesslich als `Authorization`-Header an die Anthropic-API
 * (innerhalb von `anthropic-transport.mjs`, das selbst nichts loggt).
 *
 * Preflight (`checkDailyBriefingConfig`) meldet ausschliesslich NAMEN
 * fehlender Variablen — nie Werte, nie ob ein Geheimnis "falsch" ist.
 *
 * UMFANG DES ANTHROPIC-AUFRUFS: `anthropic.dispatch(...)` weiter unten
 * erhaelt ausschliesslich die gescannten Gmail-Nachrichten
 * (`sourceMessages`) als Nutzinhalt — keine Aufgaben, Notizen, Ziele oder
 * sonstigen Quantus-Daten. Wer diese Funktion erweitert, darf diesen Umfang
 * nicht stillschweigend vergroessern: "E-Mail-Auswertung" heisst nur E-Mail.
 * ═════════════════════════════════════════════════════════════════════════ */
import * as E1 from "./quantus-v3-runtime-state.mjs";
import { localDate as zurichLocalDate } from "./quantus-v3-runtime-plan.mjs";
import { applyCommand } from "./assistant-core.mjs";
import { CORE_KEY } from "./quantus-v3-service.mjs";
import { mutateAppData, readAppDataDocument } from "./firebase-admin.mjs";
import { getValidAccessToken } from "./gcal-shared.mjs";
import { loadAssistantPolicy, SOURCE_ID } from "../../runtime/quantus-v3/src/section-work.mjs";
import { createGmailSourceReader } from "../../runtime/quantus-v3/src/gmail-source.mjs";
import { createAnthropicTransport, estimateRequestTokenCap, MAX_SOURCE_BLOCKS } from "../../runtime/quantus-v3/src/anthropic-transport.mjs";
import { MONTHLY_CAP_MICROS, reserveCostWithMonthlyCap } from "../../runtime/quantus-v3/src/monthly-cost-cap.mjs";
import { createEnvCostPolicyPort } from "../../runtime/quantus-v3/src/cost-policy-port.mjs";

const LEASE_SCOPE_SUFFIX = "netlify-daily-briefing";
const LEASE_TTL_MS = 120_000; // E1-Hoechstwert (LEASE_MAX_TTL_MS) - reicht fuer einen kleinen Lauf
const LEASE_HOLDER = "netlify-scheduled";
const ACTOR = Object.freeze({ kind: "system", id: "quantus-v3-netlify-daily-briefing" });
const MAX_PAGES = 3;
const MAX_MESSAGES = MAX_SOURCE_BLOCKS; // MUSS mit anthropic-transport.mjs uebereinstimmen (dieselbe Regel wie section-work.mjs)

/* Ein Modellpreis von $0 oder darunter ist NIE gueltig — er wuerde jeden
 * Aufruf als kostenlos ausweisen und die $50/Monat-Grenze wirkungslos
 * machen. Eine leere Variable ergibt `Number("")=0`, eine negative Zahl
 * ist ebenso ein `Number.isSafeInteger`-Wert — beides muss ausdruecklich
 * ausgeschlossen werden, nicht nur "irgendeine Zahl". */
function strengPositiveMicros(envRead, name) {
  const n = Number(envRead(name));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * NUR Namen, nie Werte — fuer eine Status-/Preflight-Anzeige, die nichts
 * Geheimes offenlegt.
 */
export function checkDailyBriefingConfig(envRead = (n) => process.env[n]) {
  const missing = [];
  if (!String(envRead("QUANTUS_V3_ANTHROPIC_MODEL") || "").trim()) missing.push("QUANTUS_V3_ANTHROPIC_MODEL");
  if (strengPositiveMicros(envRead, "QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK") === null) missing.push("QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK");
  if (strengPositiveMicros(envRead, "QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK") === null) missing.push("QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK");
  if (!String(envRead("QUANTUS_V3_TENANT") || "").trim()) missing.push("QUANTUS_V3_TENANT");
  const policyResult = loadAssistantPolicy(envRead);
  if (!policyResult.ok) missing.push("QUANTUS_V3_TAGESBRIEFING_POLICY_JSON");
  if (!String(envRead("QUANTUS_V3_COST_POLICY_JSON") || "").trim()) missing.push("QUANTUS_V3_COST_POLICY_JSON");
  return { ok: missing.length === 0, missing };
}

/* Dieselbe Fence-CAS-Pruefung wie section-work.mjs `fencedDomainCommand` —
 * frischer Bestand UND frische Uhr bei jedem CAS-Versuch, keine adoptierte
 * fremde Pacht. */
function fencedCommand(type, payload, now, commandId, policy, leaseScope, expectedFence, clock) {
  return (draft) => {
    const lease = draft.automation ? draft.automation.activeLease : null;
    const fenceOk = lease && typeof lease === "object" && lease.scope === leaseScope
      && Number.isSafeInteger(lease.fence) && lease.fence === expectedFence
      && Number.isSafeInteger(lease.expiresAtMs) && lease.expiresAtMs > clock();
    if (!fenceOk) return { data: draft, result: { ok: false, code: "lease_fenced_out" } };
    const result = applyCommand(draft, { type, commandId, now, payload }, { policy, actor: ACTOR });
    return { data: result.ok ? result.data : draft, result };
  };
}

async function stableHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64);
}

function worseOutcome(a, b) {
  const rang = { ok: 0, partial: 1, unreachable: 2, budget_exceeded: 2, auth_error: 3 };
  return (rang[b] ?? 1) > (rang[a] ?? 0) ? b : a;
}

/**
 * Ein einziger, beschraenkter, headless-faehiger Tagesbriefing-Lauf. Wird
 * NIE zweimal gleichzeitig ausgefuehrt (echte E1-Pacht) und blockiert JEDE
 * KI-Anfrage, sobald die $50/Monat-Grenze erreicht ist — beides ueber
 * denselben CAS-Kern wie jeder andere Schreibpfad, kein Umgehen.
 */
export async function runDailyBriefing({
  now, envRead = (n) => process.env[n], mutateCore = mutateAppData, readCore = readAppDataDocument,
  fetchImpl = fetch, getGmailToken = getValidAccessToken,
  gmailApiBase, anthropicApiBase, // nur fuer Tests: lokale Attrappen statt der echten APIs
  clock = Date.now, // nur fuer Tests ersetzbar: JEDE 'frische' Uhr in diesem Lauf kommt von hier, nicht direkt von Date.now()
} = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError("now (ms) erforderlich");

  const config = checkDailyBriefingConfig(envRead);
  if (!config.ok) return { ok: false, blocked: "missing_configuration", missing: config.missing };
  const model = String(envRead("QUANTUS_V3_ANTHROPIC_MODEL")).trim();
  // Erneut (nicht nur im Preflight) streng positiv geprueft: ein $0- oder
  // negativer Preis darf hier nie ankommen, selbst wenn sich die Umgebung
  // zwischen Preflight und diesem Lauf geaendert haette.
  const inputRate = strengPositiveMicros(envRead, "QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK");
  const outputRate = strengPositiveMicros(envRead, "QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK");
  if (inputRate === null || outputRate === null) return { ok: false, blocked: "missing_configuration", missing: config.missing };
  const tenant = String(envRead("QUANTUS_V3_TENANT")).trim();
  const policy = loadAssistantPolicy(envRead).policy;

  const coreDoc = await readCore(CORE_KEY);
  if (!coreDoc.exists || !coreDoc.parsed) return { ok: false, blocked: "core_unavailable" };
  // NIE geloggt, NIE zurueckgegeben — verlaesst diese Funktion nur als
  // Authorization-Header an Anthropic (anthropic-transport.mjs). Absichtlich
  // HIER NUR gelesen, NICHT sofort geprueft: der Quellenscan (Gmail) soll
  // auch OHNE Schluessel laufen und einen ehrlichen Status hinterlassen —
  // erst der Entwurf selbst braucht ihn (s. u.).
  const apiKey = String(coreDoc.parsed?._settings?.anthropicApiKey || "").trim();

  const date = zurichLocalDate(now);
  const leaseScope = `${tenant}:${LEASE_SCOPE_SUFFIX}`;
  const acquire = await mutateCore(CORE_KEY, (data) => E1.acquireLease(data, { holder: LEASE_HOLDER, scope: leaseScope, ttlMs: LEASE_TTL_MS, now }));
  if (!acquire.result.ok) return { ok: false, blocked: `lease_conflict:${acquire.result.code}` };
  if (acquire.result.duplicate === true) {
    // Dieselbe (noch nicht abgelaufene) Zustellung — kein zweiter Lauf,
    // kein zweiter Aufruf, keine zweite Abrechnung.
    return { ok: true, skipped: "duplicate_delivery" };
  }
  const fence = acquire.result.fence;

  const costPolicyPort = createEnvCostPolicyPort(envRead);
  try {
    return await einLauf({ now, date, tenant, policy, costPolicyPort, model, inputRate, outputRate, apiKey, mutateCore, fetchImpl, getGmailToken, leaseScope, fence, gmailApiBase, anthropicApiBase, clock });
  } finally {
    await mutateCore(CORE_KEY, (data) => E1.releaseLease(data, { holder: LEASE_HOLDER, scope: leaseScope, fence, now: clock() })).catch(() => {});
  }
}

async function einLauf({ now, date, tenant, policy, costPolicyPort, model, inputRate, outputRate, apiKey, mutateCore, fetchImpl, getGmailToken, leaseScope, fence, gmailApiBase, anthropicApiBase, clock }) {
  const ensureId = `ensure-run:${date}`;
  const ensureOut = await mutateCore(CORE_KEY, fencedCommand("ensureRun", { date }, now, ensureId, policy, leaseScope, fence, clock));
  if (!ensureOut.result.ok) return { ok: false, blocked: `ensure_run:${ensureOut.result.code ?? ensureOut.result.error ?? "failed"}` };

  // ── Quelle: Gmail, EIN beschraenkter Durchlauf ──────────────────────────
  // `ensureOut.data` ist der frisch geschriebene Bestand aus dem
  // ensureRun-Schreibvorgang oben — kein weiteres Lesen noetig.
  let sinceMs = null;
  try {
    const prevCursor = ensureOut.data?.automation?.sourceCursors?.[SOURCE_ID]?.cursor;
    if (typeof prevCursor === "string") sinceMs = JSON.parse(prevCursor)?.sinceMs ?? null;
  } catch { sinceMs = null; }

  const gmailSource = createGmailSourceReader({ getAccessToken: getGmailToken, fetchImpl, ...(gmailApiBase ? { apiBase: gmailApiBase } : {}) });
  const messages = [];
  let outcome = "ok";
  let pageToken = null;
  let pagesSeen = 0;
  let vollstaendig = false;
  let mengenlimitErreicht = false;
  while (pagesSeen < MAX_PAGES) {
    const seite = await gmailSource.listPage({ pageToken, sinceMs });
    pagesSeen++;
    if (!seite.ok) { outcome = seite.error.code; break; }
    for (const id of seite.ids) {
      if (messages.length >= MAX_MESSAGES) {
        // Ab hier KEIN weiterer getMessage()-Aufruf: jeder zusaetzliche
        // HTTP-Umlauf waere verlorene Zeit innerhalb der knappen
        // Scheduled-Function-/Pacht-Frist, ohne dass sein Ergebnis je
        // verwendet wuerde (Review-Befund #3).
        mengenlimitErreicht = true;
        break;
      }
      const nachricht = await gmailSource.getMessage({ id });
      if (!nachricht.ok) { outcome = worseOutcome(outcome, nachricht.error.code === "auth_error" ? "auth_error" : "partial"); continue; }
      if (nachricht.partial) outcome = worseOutcome(outcome, "partial");
      messages.push({ evidenceRef: nachricht.message.id, subject: nachricht.message.subject, snippet: nachricht.message.snippet, body: nachricht.message.body, attachments: nachricht.message.attachments });
    }
    pageToken = seite.nextPageToken;
    if (mengenlimitErreicht) break;
    if (!pageToken) { vollstaendig = true; break; }
  }
  // Nur ein wirklich von Gmail bestaetigtes Ende ("keine weitere Seite")
  // gilt als vollstaendig — ein Abbruch durch das Mengenlimit, das
  // Seitenlimit (MAX_PAGES erschoepft) oder einen Fehler ist IMMER
  // hoechstens `partial`, nie `ok` (Review-Befund #3+#4).
  if (!vollstaendig) outcome = worseOutcome(outcome, "partial");
  const wirklichVollstaendig = vollstaendig && outcome === "ok";

  // ── Pachterweiterung: der Quellenscan (oben, ohne jeden CAS-Zugriff) kann
  // je nach Postfachgroesse einen spuerbaren Teil der 120-Sekunden-Pacht
  // verbraucht haben. VOR dem ERSTEN Schreibvorgang danach wird sie EINMAL,
  // mit einer FRISCHEN Uhr, auf die volle Frist verlaengert — reicht die
  // Fuehrung dafuer nicht mehr (echt abgelaufen/uebernommen), wird ehrlich
  // abgebrochen, statt mit einer veralteten `now` weiterzurechnen, die eine
  // in Wirklichkeit bereits abgelaufene Pacht faelschlich gueltig erscheinen
  // liesse (Review-Befund #1).
  const renewOut = await mutateCore(CORE_KEY, (data) => E1.renewLease(data, { holder: LEASE_HOLDER, scope: leaseScope, fence, ttlMs: LEASE_TTL_MS, now: clock() }));
  if (!renewOut.result.ok) return { ok: false, blocked: `lease_lost_during_scan:${renewOut.result.code}` };

  // Das Wasserzeichen wandert NUR vorgezogen, wenn nichts zu entwerfen ist
  // UND der Scan sauber war — sonst erst nach einem wirklich gelungenen
  // Entwurf (s. u.), genau wie section-work.mjs (Review-Befund F/G-2 #3).
  const wasserzeichenSofort = messages.length === 0 && wirklichVollstaendig ? { sinceMs: now } : { sinceMs };
  const checkId = `source-check:${date}:${SOURCE_ID}`;
  const checkOut = await mutateCore(CORE_KEY, fencedCommand(
    "recordSourceCheck",
    { date, sourceId: SOURCE_ID, cursor: JSON.stringify(wasserzeichenSofort), outcome, detail: `pages=${pagesSeen}` },
    clock(), checkId, policy, leaseScope, fence, clock,
  ));
  if (!checkOut.result.ok) return { ok: false, blocked: `source_check:${checkOut.result.code}` };

  if (messages.length === 0) return { ok: true, sourceOutcome: outcome, drafted: false };

  // ── Kostenreservierung MIT der $50/Monat-Grenze, EXAKT dieselbe
  // Anfrage-Byteobergrenze wie tatsaechlich gesendet wird ───────────────
  // Der Anthropic-Schluessel wird ERST HIER verlangt: der Quellenstatus
  // oben steht bereits ehrlich, auch wenn kein Entwurf folgt (Review-
  // Befund #5 — "kein Gmail heute" darf nicht bedeuten, dass gar nichts
  // sichtbar wird).
  if (!apiKey) return { ok: false, blocked: "anthropic_key_not_configured", sourceOutcome: outcome };
  // Die KOSTENrichtlinie (QUANTUS_V3_COST_POLICY_JSON, Preise/Freigabe) ist
  // NICHT dieselbe wie die Tagesbriefing-Policy oben (`policy`,
  // QUANTUS_V3_TAGESBRIEFING_POLICY_JSON) — zwei getrennte Vertraege, wie
  // auch in cost-adapter.mjs. Frisch geladen, unmittelbar vor der
  // Reservierung (kein Zwischenspeicher, ein Widerruf muss sofort greifen).
  const costPolicy = await costPolicyPort.impl.load();
  if (!costPolicy) return { ok: false, blocked: "cost_policy_unavailable", sourceOutcome: outcome };
  const jetztVorReservierung = clock();
  const anthropic = createAnthropicTransport({ apiKey, model, modelPricing: { inputMicrosPerMillionTokens: inputRate, outputMicrosPerMillionTokens: outputRate }, fetchImpl, ...(anthropicApiBase ? { apiBase: anthropicApiBase } : {}) });
  // "briefing04" ist ein ECHTER Slot-Name aus quantus-v3-runtime-plan.mjs
  // MAIN_SLOTS (04:00, "Tag eroeffnen") — parseSlotRunKey() akzeptiert nur
  // diese feste Liste; ein erfundener Name wie "dailybriefing" waere
  // ungueltig. Derselbe runKey traegt auch die Notiz-Id (s. u.) — DASSELBE
  // Schema, das renderV3AutomationStatus() in public/index.html bereits
  // erwartet ("v3-draft:<tenant>:<date>:<slot>:<policyVersion>"), damit ein
  // ueber diesen Betriebsweg erzeugter Entwurf in der bestehenden
  // DailyBriefing-Anzeige auch wirklich erscheint.
  const runKey = `${tenant}:${date}:briefing04:${policy.version}`;
  const callId = `daily:${date}`;
  const tokenObergrenze = estimateRequestTokenCap(messages);
  const contentHash = await stableHash(tokenObergrenze + "|" + JSON.stringify(messages));
  const reserveOut = await mutateCore(CORE_KEY, (data) => reserveCostWithMonthlyCap(data, {
    callId, runKey, provider: "anthropic", model,
    contentHash, inputTokens: tokenObergrenze, outputTokens: anthropic.maxOutputTokens,
    now: jetztVorReservierung, verifiedScope: { holder: LEASE_HOLDER, fence, scope: leaseScope }, policy: costPolicy,
  }, { capMicros: MONTHLY_CAP_MICROS }));
  if (!reserveOut.result.ok) return { ok: false, blocked: `reserve:${reserveOut.result.code}`, sourceOutcome: outcome };

  // Frisch, unmittelbar vor dem Anspruch UND vor der eigentlichen Sendung —
  // dieselbe Disziplin wie cost-adapter.mjs ("Zeit kommt bei jedem Schritt
  // frisch aus dem Uhrport, ausdruecklich NACH jedem gewarteten I/O").
  const claimId = `${callId}:1`;
  const claimOut = await mutateCore(CORE_KEY, (data) => E1.claimCostDispatch(data, {
    callId, claimId, now: clock(), verifiedScope: { holder: LEASE_HOLDER, fence, scope: leaseScope }, policy: costPolicy,
  }));
  if (!claimOut.result.ok || claimOut.result.dispatchAllowed !== true) {
    return { ok: false, blocked: `claim:${claimOut.result.code ?? "not_allowed"}`, sourceOutcome: outcome };
  }

  let antwort;
  try {
    antwort = await anthropic.dispatch({ sourceMessages: messages, requestId: callId });
  } catch (e) {
    await mutateCore(CORE_KEY, (data) => E1.markCostOutcomeUnknown(data, { callId, reason: "dispatch_threw", now: clock(), verifiedScope: { holder: LEASE_HOLDER, fence, scope: leaseScope } })).catch(() => {});
    return { ok: false, blocked: "dispatch_failed", sourceOutcome: outcome };
  }
  if (antwort.outcome !== "settled") {
    await mutateCore(CORE_KEY, (data) => E1.markCostOutcomeUnknown(data, { callId, reason: antwort.reason || "unknown", providerRequestId: antwort.providerRequestId ?? null, now: clock(), verifiedScope: { holder: LEASE_HOLDER, fence, scope: leaseScope } }));
    return { ok: false, blocked: "dispatch_unknown", sourceOutcome: outcome };
  }

  // Notiz VOR der Kostenabrechnung persistieren — ein Absturz danach
  // verliert die Ausgabe nicht (Review-Befund F/G #1).
  const noteId = `v3-draft:${runKey}`;
  const noteCommandId = `draft-note:${date}`;
  const text = `Quelle ${SOURCE_ID} (${outcome}), ${messages.length} Beleg(e): ${antwort.draftText}`;
  const noteOut = await mutateCore(CORE_KEY, fencedCommand("appendRunNote", { date, noteId, text: text.slice(0, 4000) }, clock(), noteCommandId, policy, leaseScope, fence, clock));
  if (!noteOut.result.ok) {
    await mutateCore(CORE_KEY, (data) => E1.markCostOutcomeUnknown(data, { callId, reason: "note_persist_failed", now: clock(), verifiedScope: { holder: LEASE_HOLDER, fence, scope: leaseScope } })).catch(() => {});
    return { ok: false, blocked: `note_persist:${noteOut.result.code}`, sourceOutcome: outcome };
  }

  const settleOut = await mutateCore(CORE_KEY, (data) => E1.settleCost(data, {
    callId, actualMicros: antwort.actualMicros, usageReceiptId: antwort.usageReceiptId ?? null, providerRequestId: antwort.providerRequestId ?? null,
    now: clock(), verifiedScope: { holder: LEASE_HOLDER, fence, scope: leaseScope },
  }));
  if (!settleOut.result.ok) return { ok: false, blocked: `settle:${settleOut.result.code}`, sourceOutcome: outcome, noteWritten: true };

  // Erst NACH dem wirklich gelungenen, dauerhaft gespeicherten Entwurf wird
  // das Wasserzeichen bestaetigt (Review-Befund F/G-2 #3+#4).
  const advanceOut = await mutateCore(CORE_KEY, fencedCommand(
    "recordSourceCheck",
    { date, sourceId: SOURCE_ID, cursor: JSON.stringify(wirklichVollstaendig ? { sinceMs: now } : { sinceMs }), outcome, detail: `pages=${pagesSeen}` },
    clock(), `source-check-advance:${date}:${SOURCE_ID}`, policy, leaseScope, fence, clock,
  ));

  return { ok: true, sourceOutcome: outcome, drafted: true, watermarkAdvanced: wirklichVollstaendig && advanceOut.result.ok === true };
}
