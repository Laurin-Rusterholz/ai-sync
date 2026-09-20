/* ══ Betriebs-Kostenfreigabe: globale $50/Kalendermonat-Grenze ════════════
 *
 * Explizite, vom Nutzer angeforderte Grenze — GETRENNT von jeder anderen
 * Kosten-Policy (Tages-/Lauf-/Anruflimit aus `QUANTUS_V3_COST_POLICY_JSON`)
 * und getrennt von Codex-Arbeitscredits. Sie ist HIER als Server-Konstante
 * verdrahtet, NICHT aus der Umgebung, der UI oder einem Modelltext lesbar —
 * eine Freigabe/Aenderung kann also nur durch einen neuen Commit erfolgen,
 * nie zur Laufzeit.
 *
 * Zaehlung: verbraucht (`settled`) PLUS reserviert/unklar (`reserved`,
 * `unknown` — jeweils zum vollen `maxMicros`-Hoechstwert, dem WORST CASE,
 * nicht der Schaetzung) — EXAKT der bestehende Kosten-Ledger
 * (`automation.runtime.cost.callsById`), keine zweite Datenbank. Ein Aufruf
 * im Zustand `released` zaehlt 0 (er wurde nachweislich nicht abgerechnet).
 *
 * Monatszuordnung: `billingLocalDate` (Europe/Zurich, vom Server bei der
 * Reservierung fest vergeben — s. `quantus-v3-runtime-state.mjs`
 * `reserveCost`) bestimmt den Monat. Das ist BEWUSST der Monat der
 * RESERVIERUNG, nicht der spaeteren Abrechnung: ein Aufruf, der Ende Monat
 * reserviert und erst im Folgemonat abgerechnet wird (spaeter Beleg), zaehlt
 * weiterhin zum Monat, in dem er reserviert wurde — der Monatswechsel
 * setzt nichts zurueck und erfindet auch nichts neu.
 *
 * Atomaritaet: `reserveCostWithMonthlyCap` ist ein reiner, synchroner
 * Ersatz fuer `E1.reserveCost` als CAS-Mutator (`corePort.mutate`). Die
 * CAS-Schleife liest bei jedem Versuch FRISCH und wiederholt den GESAMTEN
 * Mutator bei einem Versionskonflikt — zwei gleichzeitige Reservierungen
 * sehen deshalb nacheinander, nie gemeinsam, denselben (unveraenderten)
 * Ausgangsstand; die zweite sieht immer die bereits geschriebene erste.
 * Gemeinsam koennen sie die Grenze deshalb nicht ueberschreiten.
 * ═════════════════════════════════════════════════════════════════════════ */
import { reserveCost, readRuntime } from "../../../netlify/lib/quantus-v3-runtime-state.mjs";
import { localDate as zurichLocalDate } from "../../../netlify/lib/quantus-v3-runtime-plan.mjs";

// $50.00 — 1 USD = 1_000_000 Micros (dieselbe Einheit wie der gesamte
// Kosten-Ledger, s. `dayLimitMicros`/`runLimitMicros`/`callLimitMicros`).
export const MONTHLY_CAP_MICROS = 50_000_000;
// $30.00 — Warnschwelle, DIESELBE Monatssumme wie die Grenze oben.
export const MONTHLY_WARN_MICROS = 30_000_000;

/**
 * Monat-bis-heute-Summe (Europe/Zurich) aus dem BESTEHENDEN Ledger — reine
 * Funktion, kein I/O. `settled` zaehlt den tatsaechlich abgerechneten
 * Betrag, `reserved`/`unknown` den vollen reservierten Hoechstbetrag (worst
 * case), `released` nichts.
 */
export function monthToDateMicros(data, nowMs) {
  const runtime = readRuntime(data);
  const cost = runtime.cost && typeof runtime.cost === "object" ? runtime.cost : { callsById: {} };
  const callsById = cost.callsById && typeof cost.callsById === "object" ? cost.callsById : {};
  const month = zurichLocalDate(nowMs).slice(0, 7);
  let totalMicros = 0;
  let settledMicros = 0;
  let openMicros = 0;
  for (const call of Object.values(callsById)) {
    if (!call || typeof call !== "object") continue;
    if (typeof call.billingLocalDate !== "string" || call.billingLocalDate.slice(0, 7) !== month) continue;
    if (call.state === "settled") {
      const v = Number.isSafeInteger(call.settledMicros) ? call.settledMicros : 0;
      settledMicros += v; totalMicros += v;
    } else if (call.state === "reserved" || call.state === "unknown") {
      const v = Number.isSafeInteger(call.maxMicros) ? call.maxMicros : 0;
      openMicros += v; totalMicros += v;
    }
    // "released" traegt bewusst nichts bei — nachweislich nicht abgerechnet.
  }
  return { month, totalMicros, settledMicros, openMicros };
}

/**
 * Drop-in-Ersatz fuer `E1.reserveCost` als CAS-Mutator, MIT der zusaetzlichen
 * Monatsgrenze. Ohne `monthlyCap` (oder ohne gueltiges `capMicros`) ist das
 * Verhalten IDENTISCH zu `E1.reserveCost` — additiv, kein bestehender Aufrufer
 * wird veraendert.
 */
export function reserveCostWithMonthlyCap(data, input, monthlyCap) {
  const outcome = reserveCost(data, input);
  if (!outcome.result.ok) return outcome;
  if (!monthlyCap || !Number.isSafeInteger(monthlyCap.capMicros)) return outcome;
  // Eine WIEDERGEGEBENE Reservierung (`unchanged: true`, derselbe Aufruf
  // existiert bereits) fuegt NICHTS Neues hinzu — sie schreibt nicht, ihr
  // Kostenanteil steckt schon im Bestand. Sie gegen die Monatsgrenze zu
  // pruefen wuerde eine laengst genehmigte, idempotente Wiederholung
  // nachtraeglich UND FAELSCHLICH ablehnen, sobald ANDERE Aufrufe
  // inzwischen die Grenze erreicht haben — das waere kein Schutz, nur ein
  // widerspruechlicher Fehlschlag ohne jede zusaetzliche Ausgabe.
  if (outcome.unchanged === true) return outcome;
  // NACH der (noch nicht geschriebenen) Reservierung geprueft: `outcome.data`
  // ist der Stand, der geschrieben WUERDE — inklusive dieses neuen Anspruchs.
  const { totalMicros, month } = monthToDateMicros(outcome.data, input.now);
  if (totalMicros > monthlyCap.capMicros) {
    // Abgelehnt: der urspruengliche, UNVERAENDERTE Bestand wird zurueckgegeben
    // — die soeben simulierte Reservierung wird NICHT geschrieben.
    return { data, result: { ok: false, code: "monthly_budget_exceeded", detail: { monthTotalMicros: totalMicros, capMicros: monthlyCap.capMicros, month } }, unchanged: true };
  }
  return outcome;
}
