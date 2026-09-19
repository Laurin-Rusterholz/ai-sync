/* ══ Tagesbriefing v3 — der Kern (Einstieg) ═════════════════════════════════
 *
 * Buendelt die reinen Module und stellt die Domain-Aktion bereit:
 *
 *     applyCommand(data, command, { policy, actor })
 *
 * command = { type, commandId, now, payload }
 *   · type       ein Schluessel aus COMMAND_SCHEMAS
 *   · commandId  Kennung des Aufrufers (nur Form geprueft; die Idempotenz
 *                ist Sache des Transaktionsumschlags, siehe unten)
 *   · now        Zeitpunkt in ms, VON AUSSEN gestellt
 *   · payload    nur die im Schema erlaubten Felder; Schutzfelder in
 *                beliebiger Tiefe → Ablehnung
 * actor = { kind: agent|user|adapter|worker|system, id }
 *   Jedes Kommando nennt, wer es ausfuehren darf. Ohne Aufrufer laeuft
 *   nichts; Belege/Dokumente/Parse nur Adapter, Job-Rueckgabe nur Worker,
 *   Antworten nur Nutzer.
 *
 * DER KERN FUEHRT KEINE EIGENE IDEMPOTENZ UND KEINE LEASE. Beides gehoert
 * dem Transaktionsumschlag netlify/lib/quantus-v3-idempotency.mjs
 * (principal/tenant/key/hash/result-Ledger) bzw. Paket E1
 * (quantus-v3-runtime-state.mjs). commandReducer() ist der Adapter fuer
 * applyIdempotentCommand: synchron, ohne Nebenwirkung, {data, result},
 * Revision hoechstens einmal, Ledger unberuehrt.
 * ═════════════════════════════════════════════════════════════════════════ */
import { COMMAND_SCHEMAS, validateCommandShape, validateActor, validatePolicy } from "./assistant-schema.mjs";
import { requireCore } from "./assistant-migration.mjs";
import * as B from "./assistant-buchhaltung.mjs";
import { closeRun, invalidateClosure } from "./assistant-abschluss.mjs";

export * from "./assistant-zeit.mjs";
export * from "./assistant-schema.mjs";
export * from "./assistant-migration.mjs";
export * from "./assistant-buchhaltung.mjs";
export * from "./assistant-ampel.mjs";
export * from "./assistant-abschluss.mjs";

const HANDLER = Object.freeze({
  ensureRun: B.ensureRun,
  ensureStartNote: B.ensureStartNote,
  recordSlotReceipt: B.recordSlotReceipt,
  recordSourceCheck: B.recordSourceCheck,
  addItemRef: B.addItemRef,
  carryOverRefs: B.carryOverRefs,
  observeSource: B.observeSource,
  setWaiting: B.setWaiting,
  transitionState: B.transitionState,
  registerIntake: B.registerIntake,
  askQuestion: B.askQuestion,
  recordAnswer: B.recordAnswer,
  consumeAnswer: B.consumeAnswer,
  registerEvidence: B.registerEvidence,
  registerDocument: B.registerDocument,
  recordDocumentParse: B.recordDocumentParse,
  createJob: B.createJob,
  cancelJob: B.cancelJob,
  recordJobReturn: B.recordJobReturn,
  reviewJobResult: B.reviewJobResult,
  closeRun,
  invalidateClosure,
});
for (const k of Object.keys(COMMAND_SCHEMAS)) if (!HANDLER[k]) throw new Error("Kommando ohne Handler: " + k);
for (const k of Object.keys(HANDLER)) if (!COMMAND_SCHEMAS[k]) throw new Error("Handler ohne Schema: " + k);

/* Die Domain-Aktion. Rueckgabe { ok, data, ... } — data ist bei Ablehnung
 * die unveraenderte Eingabe. Invarianten, die hier zugesichert werden:
 * Revision +0 oder +1, idempotencyByKey und activeLease byteidentisch. */
export function applyCommand(input, command, { policy, actor } = {}) {
  const shape = validateCommandShape(command);
  if (!shape.ok) return { ok: false, error: "COMMAND_REJECTED", detail: shape.errors, data: input };
  const wer = validateActor(command.type, actor);
  if (!wer.ok) return { ok: false, error: "ACTOR_REJECTED", detail: wer.errors, data: input };
  const pv = validatePolicy(policy);
  if (!pv.ok) return { ok: false, error: "POLICY_INVALID", detail: pv.errors, data: input };
  let core;
  try { core = requireCore(input); } catch (e) { return { ok: false, error: e.code || "CORE_INVALID", detail: e.message, data: input }; }

  const r = HANDLER[command.type](core, command.payload, { now: command.now, policy, actor: { kind: actor.kind, id: actor.id } });
  if (!r.ok) return { ...r, data: input };
  const vorher = core.automation, nachher = r.data.automation;
  if (nachher.dataRevision !== vorher.dataRevision && nachher.dataRevision !== vorher.dataRevision + 1) throw new Error("Kern-Invariante verletzt: Revision mehr als einmal erhoeht");
  if (JSON.stringify(nachher.idempotencyByKey) !== JSON.stringify(vorher.idempotencyByKey)) throw new Error("Kern-Invariante verletzt: idempotencyByKey veraendert");
  if (JSON.stringify(nachher.activeLease ?? null) !== JSON.stringify(vorher.activeLease ?? null)) throw new Error("Kern-Invariante verletzt: activeLease veraendert");
  if (nachher.dataRevision === vorher.dataRevision) return { ...r, data: input, noop: true };
  return { ...r, noop: false };
}

/* Adapter fuer applyIdempotentCommand(current, prepared, reducer):
 * reducer(snapshot, command, prepared) → { data, result }. Ablehnungen
 * werden als Fehler mit code/status geworfen (wie im Umschlag ueblich);
 * result enthaelt keine reservierten Felder und kein data. */
export function commandReducer({ policy, actor }) {
  return function reducer(snapshot, command, prepared) {
    const cmd = {
      type: command.type, payload: command.payload,
      commandId: typeof command.commandId === "string" ? command.commandId : (prepared && prepared.requestId) || "",
      now: typeof command.now === "number" ? command.now : Date.parse(prepared && prepared.now),
    };
    const r = applyCommand(snapshot, cmd, { policy, actor });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, status: r.error === "CORE_INVALID" || r.error?.startsWith("CORE_") ? 503 : 400, detail: r.detail });
    const { data, ok, noop, ...rest } = r;
    return { data, result: { ...rest, noop: !!noop } };
  };
}

/* Serialisierung in die Form von appStore/app-data_json. */
export function serializeCore(data) {
  return JSON.stringify(requireCore(data));
}
