/* ══ Tagesbriefing v3 — der Kern (Einstieg) ═════════════════════════════════
 *
 * Buendelt die reinen Module und stellt den EINZIGEN Zugang bereit, ueber
 * den spaeter Kommandos in den Bestand kommen:
 *
 *     applyCommand(data, command, { policy })
 *
 * command = { type, commandId, now, payload }
 *
 *   · type       ein Schluessel aus COMMAND_SCHEMAS (assistant-schema.mjs)
 *   · commandId  stabile Kennung des Aufrufers — dieselbe Id noch einmal
 *                liefert das gespeicherte Ergebnis, ohne etwas zu tun
 *   · now        Zeitpunkt in ms, VON AUSSEN gestellt (kein Date.now hier)
 *   · payload    ausschliesslich die im Schema erlaubten Felder; ein
 *                Schutzfeld (finalAt, overallGreen, userApproval …) in
 *                beliebiger Tiefe lehnt das Kommando ab
 *
 * Es gibt hier KEINEN Netz-, Firebase- oder Uhrzugriff. Der CAS-Schreibpfad
 * (Paket "command/CAS", offen) ruft applyCommand innerhalb seiner Lese-
 * Vergleich-Schreib-Schleife; alles Aeussere kommt als Abhaengigkeit.
 *
 * Feature-Schalter (policy.featureFlags) stehen auf dry_run: der Kern
 * verzeichnet Jobs und Ausgang, loest aber nichts aus. Ein "live" wird
 * erst mit Laeufer/Provider-Adaptern (spaetere Pakete) wirksam.
 * ═════════════════════════════════════════════════════════════════════════ */
import { COMMAND_SCHEMAS, validateCommandShape, validatePolicy } from "./assistant-schema.mjs";
import { requireCore, klon } from "./assistant-migration.mjs";
import * as B from "./assistant-buchhaltung.mjs";
import { closeRun, invalidateClosure } from "./assistant-abschluss.mjs";
import { isoAus } from "./assistant-zeit.mjs";

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
  registerDocument: B.registerDocument,
  recordDocumentParse: B.recordDocumentParse,
  createJob: B.createJob,
  recordJobReturn: B.recordJobReturn,
  acquireLease: B.acquireLease,
  releaseLease: B.releaseLease,
  closeRun,
  invalidateClosure,
});

// Jedes Schema hat einen Handler und umgekehrt — sonst laege ein Kommando
// ohne Schutz oder ein Schema ohne Wirkung herum.
for (const k of Object.keys(COMMAND_SCHEMAS)) if (!HANDLER[k]) throw new Error("Kommando ohne Handler: " + k);
for (const k of Object.keys(HANDLER)) if (!COMMAND_SCHEMAS[k]) throw new Error("Handler ohne Schema: " + k);

function ohneData(r) {
  if (!r || typeof r !== "object") return r;
  const { data, ...rest } = r;
  return rest;
}

export function applyCommand(input, command, { policy } = {}) {
  const shape = validateCommandShape(command);
  if (!shape.ok) return { ok: false, error: "COMMAND_REJECTED", detail: shape.errors, data: input };
  const pv = validatePolicy(policy);
  if (!pv.ok) return { ok: false, error: "POLICY_INVALID", detail: pv.errors, data: input };
  let core;
  try { core = requireCore(input); } catch (e) { return { ok: false, error: e.code || "CORE_INVALID", detail: e.message, data: input }; }

  const idem = core.automation.idempotencyByKey || {};
  const bekannt = idem[command.commandId];
  if (bekannt) {
    if (bekannt.type !== command.type) return { ok: false, error: "COMMAND_ID_REUSED", detail: { storedType: bekannt.type }, data: input };
    return { ...bekannt.result, ok: bekannt.result.ok, replayed: true, data: input };
  }

  const ctx = { now: command.now, policy };
  const r = HANDLER[command.type](core, command.payload, ctx);
  if (!r.ok) return { ...r, data: input, replayed: false };

  // Ein fachlicher No-op (bereits abgeschlossen, bereits vorhanden, nichts
  // veraendert) hinterlaesst KEINE Spur: der Bestand bleibt byteidentisch,
  // ein Schreibpfad hat nichts zu schreiben.
  const unveraendert = r.data.automation.dataRevision === core.automation.dataRevision;
  if (unveraendert) return { ...r, data: input, replayed: false, noop: true };

  // Ergebnis (ohne Bestand) unter der commandId ablegen — Wiederholung ist
  // damit ein Lesen, kein zweites Schreiben.
  const data = r.data;
  data.automation.idempotencyByKey = data.automation.idempotencyByKey || {};
  data.automation.idempotencyByKey[command.commandId] = { type: command.type, at: isoAus(command.now), revision: data.automation.dataRevision, result: klon(ohneData(r)) };
  return { ...r, data, replayed: false };
}

/* Serialisierung zurueck in die Form, die appStore/app-data_json erwartet:
 * ein JSON-String des Vollbestands. Der Schreibende haengt If-Match an. */
export function serializeCore(data) {
  return JSON.stringify(requireCore(data));
}
