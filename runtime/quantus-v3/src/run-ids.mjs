/* ══ E2 — die Zuordnung Laufschluessel ⇄ C2-Id ════════════════════════════
 *
 * E1 kennt einen Lauf unter seinem LAUFSCHLUESSEL
 * `tenant:localDate:slot:policyVersion`. C2 kennt Laeufe unter IDs, und
 * seine Ids sind eng: `^[A-Za-z0-9_-]{1,128}$`, und `__` ist verboten (es
 * trennt Segmente in den Blob-Schluesseln). Ein Laufschluessel enthaelt
 * `:` und meistens auch `.` — er kann also NIE direkt als Id auftreten.
 *
 * Fruehere Fassung dieses Pakets schickte den Laufschluessel dennoch als
 * `scopeId` an die Statusroute. Das haette der echte Dienst mit
 * 400 `scope_id_invalid` beantwortet, noch bevor irgendetwas gelesen
 * worden waere — der Nachweisweg war damit nie begehbar.
 *
 * Deshalb hier EINE Zuordnung, umkehrbar und an einer Stelle:
 *
 *   Laufschluessel  quantus:2026-09-20:process09:3.0
 *   Lauf-Id         r-quantus_3a2026-09-20_3aprocess09_3a3_2e0
 *   Status-Scope    s-quantus_3a2026-09-20_3aprocess09_3a3_2e0
 *
 * Die Kodierung ist dieselbe wie bei den Cloud-Tasks-Namen: jedes Zeichen
 * ausserhalb `[A-Za-z0-9-]` wird zu `_` plus zwei Hexziffern. Damit
 *   · ergeben zwei verschiedene Schluessel nie dieselbe Id (injektiv),
 *   · entsteht nie `__` (auf `_` folgt immer eine Hexziffer),
 *   · und die Id laesst sich zurueckrechnen.
 *
 * WICHTIG — DAS IST EINE KONVENTION, KEIN BEWEIS. Ob der Fachadapter
 * (Paket B) seine Laufdatensaetze wirklich unter diesen Ids fuehrt, kann
 * dieses Paket nicht entscheiden. Es kann nur zweierlei, und tut beides:
 * die Id so bilden, dass C2 sie ueberhaupt annimmt — und die Antwort
 * ABLEHNEN, wenn der gelieferte Eintrag eine andere Lauf-Id traegt.
 * Geraten wird nichts.
 * ═════════════════════════════════════════════════════════════════════════ */
import { encodeTaskSegment, decodeTaskSegment } from "./task-names.mjs";

/* Die Id-Regel aus C2 (`quantus-v3-service.mjs`, Leseweg und Umschlag). */
export const C2_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const C2_ID_MAX = 128;

export const RUN_ID_PREFIX = "r-";
export const STATUS_SCOPE_PREFIX = "s-";

export class RunIdError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = "RunIdError";
    this.code = code;
    this.detail = detail;
  }
}

/* Genau die Form, die E1 ausgibt — hier nur geprueft, nicht nachgebaut. */
const RUN_KEY_RE = /^[A-Za-z0-9_-]{1,64}:\d{4}-\d{2}-\d{2}:[a-z0-9]{1,24}:[A-Za-z0-9._-]{1,32}$/;

export function isRunKey(value) {
  return typeof value === "string" && RUN_KEY_RE.test(value);
}

function kodiere(prefix, runKey) {
  if (!isRunKey(runKey)) throw new RunIdError("run_key_invalid");
  const id = prefix + encodeTaskSegment(runKey);
  // Die Kodierung kann wachsen (jedes Sonderzeichen wird dreimal so lang).
  // Eine zu lange Id wird NICHT gekuerzt — das waere das Ende der
  // Eindeutigkeit. Sie wird abgelehnt.
  if (id.length > C2_ID_MAX) throw new RunIdError("run_id_too_long", { length: id.length, max: C2_ID_MAX });
  if (!C2_ID_RE.test(id) || id.includes("__")) throw new RunIdError("run_id_unusable");
  return id;
}

function dekodiere(prefix, id) {
  if (typeof id !== "string" || !C2_ID_RE.test(id) || id.includes("__")) throw new RunIdError("run_id_invalid");
  if (!id.startsWith(prefix)) throw new RunIdError("run_id_prefix");
  let runKey;
  try { runKey = decodeTaskSegment(id.slice(prefix.length)); } catch { throw new RunIdError("run_id_undecodable"); }
  if (!isRunKey(runKey)) throw new RunIdError("run_key_invalid");
  return runKey;
}

/** Die Lauf-Id, unter der C2 diesen Lauf fuehren soll (`jobId`, `item.runId`). */
export function runIdForRunKey(runKey) { return kodiere(RUN_ID_PREFIX, runKey); }

/** Die Umkehrung — damit eine gelieferte Id gegengerechnet werden kann. */
export function runKeyFromRunId(runId) { return dekodiere(RUN_ID_PREFIX, runId); }

/** Der `scopeId` der Statusabfrage: der Statusdatensatz DIESES Laufs. */
export function statusScopeIdForRunKey(runKey) { return kodiere(STATUS_SCOPE_PREFIX, runKey); }

export function runKeyFromStatusScopeId(scopeId) { return dekodiere(STATUS_SCOPE_PREFIX, scopeId); }

export default {
  C2_ID_RE, C2_ID_MAX, RUN_ID_PREFIX, STATUS_SCOPE_PREFIX, RunIdError, isRunKey,
  runIdForRunKey, runKeyFromRunId, statusScopeIdForRunKey, runKeyFromStatusScopeId,
};
