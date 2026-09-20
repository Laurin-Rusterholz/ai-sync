/* ══ E2 — welcher Slot ist gemeint? ═══════════════════════════════════════
 *
 * Cloud Scheduler schickt beim HTTP-Ziel keine Sollzeit mit, und ein
 * Wiederholungsversuch kann nach Mitternacht ankommen. Wer das lokale Datum
 * einfach aus der Zustellzeit nimmt, erzeugt fuer denselben 23-Uhr-Lauf
 * beim zweiten Versuch einen anderen Startschluessel — und damit einen
 * zweiten Lauf.
 *
 * Deshalb wird das Vorkommen SERVERSEITIG hergeleitet: das letzte geplante
 * Auftreten dieses Slots bei oder vor `now`. Ein Versuch, der spaeter als
 * das erlaubte Fenster ankommt, wird abgewiesen — dafuer gibt es den
 * Nachholweg des Monitors, nicht einen verspaeteten Direktstart.
 *
 * Die Zeitrechnung kommt vollstaendig aus E1 (Paket
 * `quantus-v3-runtime-plan.mjs`). Hier entsteht KEINE zweite Zeitlogik.
 * ═════════════════════════════════════════════════════════════════════════ */
import {
  MAIN_SLOTS, SLOT_NAMES, wallTimeToMs, localDate, addDays, slotRunKey, requireSlot,
} from "../../../netlify/lib/quantus-v3-runtime-plan.mjs";
import { HttpError, badRequest } from "./errors.mjs";

export { SLOT_NAMES };

export function resolveSlotOccurrence(slot, now, options = {}) {
  const { tenant, policyVersion, maxLatenessMs } = options;
  if (!SLOT_NAMES.includes(slot)) throw badRequest("unknown_slot", { slot: String(slot).slice(0, 32) });
  requireSlot(slot);
  if (!Number.isSafeInteger(now) || now <= 0) throw new HttpError(500, "server_clock_invalid");
  if (!Number.isSafeInteger(maxLatenessMs) || maxLatenessMs <= 0) throw new HttpError(503, "runtime_not_configured", { missing: ["QUANTUS_V3_SLOT_MAX_LATENESS_MS"] });

  const definition = MAIN_SLOTS.find((s) => s.slot === slot);
  const today = localDate(now);
  let date = today;
  let plannedAtMs = wallTimeToMs(today, definition.hour, definition.minute);
  if (plannedAtMs > now) {
    date = addDays(today, -1);
    plannedAtMs = wallTimeToMs(date, definition.hour, definition.minute);
  }
  const latenessMs = now - plannedAtMs;
  if (latenessMs > maxLatenessMs) {
    // Kein verspaeteter Direktstart. Der Monitor holt den Slot nach, und
    // sein Vorfall bleibt als Beleg stehen.
    throw new HttpError(409, "slot_start_too_late", { slot, plannedAtMs, latenessMs, maxLatenessMs });
  }
  return Object.freeze({
    slot, localDate: date, plannedAtMs, latenessMs,
    runKey: slotRunKey(tenant, date, slot, policyVersion),
  });
}
