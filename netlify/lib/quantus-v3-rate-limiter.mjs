/* ══ Quantus v3 — C2: instanzübergreifender Ratenzähler (CAS) ═════════════
 *
 * C1 hat den VERTRAG festgehalten: ein Zähler im Arbeitsspeicher zählt pro
 * Instanz, und Netlify wie Cloud Run laufen mehrinstanzig — wer damit „10 pro
 * Minute" verspricht, erlaubt bei fünf Instanzen fünfzig. `requireHandlerRateLimiter`
 * lehnt so einen Zähler deshalb ab.
 *
 * Hier ist die Erfüllung: ein Zähler, der über ein Compare-and-Swap auf EINEM
 * gemeinsamen Knoten hochzählt. Er meldet sich als `atomic: true` und
 * `scope: "shared"` — und das ist keine Behauptung, sondern die Bauweise: bei
 * einem Versionskonflikt wird neu gelesen und erneut versucht; bleibt der
 * Ausgang unklar, wird NICHT hochgezählt und der Aufrufer bekommt einen
 * Fehler statt eines stillen Freibriefs.
 *
 * Abgrenzung: Das ist ein SCHUTZZÄHLER, keine Fachdatenbank. Unter
 * `quantusV3RateLimits/` liegen nur Zählerstände mit Zeitfenster; es gibt hier
 * keine Leads, keine Aufgaben, keinen Zustand, nichts, was jemand lesen
 * wollen würde. Der Kerndatensatz wird dabei nicht angefasst.
 *
 * Der Verkehr ist injiziert (`getWithEtag`/`set`), damit Konflikte, Ausfälle
 * und Fensterwechsel ohne Netz geprüft werden können.
 * ═══════════════════════════════════════════════════════════════════════ */

import { createHash } from "node:crypto";

export const RATE_NODE_PREFIX = "quantusV3RateLimits";
export const DEFAULT_ATTEMPTS = 8;

/* Der Knotenname enthält keinen Principal im Klartext: er ist ein Hash.
   Ein Zählerknoten soll nicht verraten, wer wann gearbeitet hat. */
export function rateNodePath(key, windowStartMs) {
  const digest = createHash("sha256").update(String(key), "utf8").digest("hex").slice(0, 32);
  return `${RATE_NODE_PREFIX}/${digest}/${Math.floor(Number(windowStartMs) || 0)}`;
}

/*
 * `getWithEtag(path)` → { value, serverEtag }
 * `set(path, value, { ifMatch })` → { ok } | { conflict: true } | { ok: false }
 * Beides genau die Form, die firebase-admin.mjs bereits liefert.
 */
export function createCasRateLimiter({ getWithEtag, set, attempts = DEFAULT_ATTEMPTS, now = () => Date.now() } = {}) {
  if (typeof getWithEtag !== "function" || typeof set !== "function") {
    throw new Error("createCasRateLimiter: getWithEtag und set sind Pflicht");
  }
  return {
    atomic: true,
    scope: "shared",
    multiInstanceSafe: true,
    async increment({ key, windowStartMs, windowMs }) {
      const path = rateNodePath(key, windowStartMs);
      let letzterKonflikt = null;
      for (let versuch = 0; versuch < attempts; versuch++) {
        const aktuell = await getWithEtag(path);
        const stand = aktuell?.value;
        // Ein Stand aus einem ALTEN Fenster zählt nicht mit: der Knotenname
        // enthält das Fenster, aber ein Rest aus einem früheren Lauf könnte
        // hier liegen. Nur was zum Fenster passt, wird fortgeschrieben.
        const zaehler = (stand && Number(stand.windowStartMs) === Number(windowStartMs) && Number.isFinite(Number(stand.count)))
          ? Number(stand.count) : 0;
        const naechster = zaehler + 1;
        const neu = {
          count: naechster,
          windowStartMs: Number(windowStartMs),
          windowMs: Number(windowMs) || 60_000,
          updatedAt: new Date(now()).toISOString(),
        };
        const ergebnis = await set(path, neu, { ifMatch: aktuell?.serverEtag ?? null });
        if (ergebnis?.ok) return { count: naechster };
        if (ergebnis?.conflict) { letzterKonflikt = "conflict"; continue; }
        // Unklarer Ausgang: NICHT so tun, als wäre gezählt worden.
        throw Object.assign(new Error("rate_counter_unavailable"), { code: "rate_limiter_unavailable" });
      }
      throw Object.assign(new Error(letzterKonflikt || "rate_counter_exhausted"), { code: "rate_limiter_unavailable" });
    },
  };
}

export default { createCasRateLimiter, rateNodePath, RATE_NODE_PREFIX };
