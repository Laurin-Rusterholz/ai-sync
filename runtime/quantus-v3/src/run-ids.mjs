/* ══ E2 — die Zuordnung E1-Laufschluessel ⇄ echte B/C3a-Id ════════════════
 *
 * BEFUND (Review-Auftrag): eine fruehere Fassung erfand eine eigene
 * `r-`/`s-`-Kodierung fuer C2-Ids. Das war unnoetig UND falsch — Paket B
 * (`quantus-v3-domain-adapter.mjs`, `assistant-abschluss.mjs`) fuehrt genau
 * EINEN Lauf pro Kalendertag, unter der Kennung
 *
 *     run.id            "run_" + YYYY-MM-DD           (dailyBriefing.assistantRuns[date])
 *     Statusdatensatz   "status_" + YYYY-MM-DD         (objektLaden Fall "run_status")
 *
 * Beides sind einfache, feste Zeichenketten ohne Sonderzeichen — sie
 * erfuellen `quantus-v3-service.mjs`s Id-Regel (`^[A-Za-z0-9_:-]{1,120}$`,
 * kein `__`) ohnehin, jede Umkodierung waere reine Erfindung.
 *
 * WAS HIER WIRKLICH GEBRAUCHT WIRD: E1 fuehrt Laeufe PRO SLOT
 * (`tenant:localDate:slot:policyVersion`, vier am Tag), B fuehrt sie PRO
 * TAG. Die einzige echte Aufgabe dieser Datei ist, aus einem E1-Laufschluessel
 * das lokale Datum zu ziehen (ueber `parseSlotRunKey`, keine eigene
 * Zerlegung) und daraus die B-Id zu bilden. Mehrere E1-Slot-Laeufe desselben
 * Tages ergeben also dieselbe B-Id — das ist keine Kollision, sondern genau
 * das Modell: der Status eines Kalendertags ist EINER, unabhaengig davon,
 * welcher Slot ihn zuletzt fortgeschrieben hat.
 * ═════════════════════════════════════════════════════════════════════════ */
import { parseSlotRunKey } from "../../../netlify/lib/quantus-v3-runtime-plan.mjs";

export const RUN_ID_PREFIX = "run_";
export const STATUS_SCOPE_PREFIX = "status_";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RunIdError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = "RunIdError";
    this.code = code;
    this.detail = detail;
  }
}

function localDateOf(runKey) {
  let parsed;
  try {
    parsed = parseSlotRunKey(runKey);
  } catch (err) {
    throw new RunIdError("run_key_invalid", { cause: err?.code || null });
  }
  if (!DATE_RE.test(parsed.localDate)) throw new RunIdError("run_key_invalid_date");
  return parsed.localDate;
}

/** Die B-Lauf-Id fuer diesen Kalendertag (`jobId`, `item.runId`). */
export function runIdForRunKey(runKey) { return RUN_ID_PREFIX + localDateOf(runKey); }

/** Der `scopeId` der Statusabfrage (`quantus-run-status`, Query `run.status`). */
export function statusScopeIdForRunKey(runKey) { return STATUS_SCOPE_PREFIX + localDateOf(runKey); }

export default { RUN_ID_PREFIX, STATUS_SCOPE_PREFIX, RunIdError, runIdForRunKey, statusScopeIdForRunKey };
