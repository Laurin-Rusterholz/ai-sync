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
/* Ein Versionsstempel, der wirklich einer ist.
 *
 * BEFUND (Review 33a4b3d): `ifMatch: aktuell?.serverEtag ?? null` schrieb auch
 * dann, wenn der Speicher gar keinen Stempel lieferte (null, "" oder das
 * Wildcard "*"). Damit war der Schreibvorgang unbedingt — also kein CAS.
 * Fehlt ein echter Stempel, wird NICHT geschrieben. Auch ein fehlender
 * Datensatz braucht einen: den Stempel des leeren Knotens. */
function istEchterEtag(wert) {
  return typeof wert === "string" && wert.length > 0 && wert !== "*" && wert.trim() !== "";
}

export function createCasRateLimiter({ getWithEtag, set, attempts = DEFAULT_ATTEMPTS, now = () => Date.now() } = {}) {
  if (typeof getWithEtag !== "function" || typeof set !== "function") {
    throw new Error("createCasRateLimiter: getWithEtag und set sind Pflicht");
  }
  const nichtVerfuegbar = (grund) => Object.assign(new Error(grund), { code: "rate_limiter_unavailable" });

  return {
    atomic: true,
    scope: "shared",
    multiInstanceSafe: true,
    async increment({ key, windowStartMs, windowMs }) {
      const fenster = Number(windowStartMs);
      if (!Number.isSafeInteger(fenster) || fenster < 0) throw nichtVerfuegbar("rate_window_invalid");
      const path = rateNodePath(key, fenster);
      // Die Zeitmarke steht EINMAL fest, ausserhalb der Wiederholungen — ein
      // wiederholter Versuch soll denselben Datensatz schreiben, nicht einen
      // leicht anderen.
      const updatedAt = new Date(now()).toISOString();

      for (let versuch = 0; versuch < attempts; versuch++) {
        const aktuell = await getWithEtag(path);
        if (!istEchterEtag(aktuell?.serverEtag)) throw nichtVerfuegbar("rate_etag_missing");

        const stand = aktuell.value;
        let zaehler = 0;
        if (stand != null) {
          if (typeof stand !== "object" || Array.isArray(stand)) throw nichtVerfuegbar("rate_counter_invalid");
          const gespeichertesFenster = Number(stand.windowStartMs);
          if (Number.isSafeInteger(gespeichertesFenster) && gespeichertesFenster === fenster) {
            // Derselbe Zeitraum: der Stand zählt — aber nur, wenn er brauchbar
            // ist. Ein kaputter Zähler (negativ, gebrochen, riesig) wird NICHT
            // stillschweigend auf 0 „repariert"; das wäre ein Freibrief.
            const gespeichert = stand.count;
            if (typeof gespeichert !== "number" || !Number.isSafeInteger(gespeichert) || gespeichert < 0) {
              throw nichtVerfuegbar("rate_counter_invalid");
            }
            zaehler = gespeichert;
          } else if (!Number.isSafeInteger(gespeichertesFenster)) {
            // Ein Datensatz ohne brauchbares Fenster ist unbrauchbar.
            throw nichtVerfuegbar("rate_counter_invalid");
          }
          // Ein Stand aus einem ANDEREN Fenster zählt nicht mit (Rest eines
          // früheren Laufs unter demselben Knotennamen).
        }

        const naechster = zaehler + 1;
        if (!Number.isSafeInteger(naechster)) throw nichtVerfuegbar("rate_counter_overflow");

        const ergebnis = await set(path, {
          count: naechster,
          windowStartMs: fenster,
          windowMs: Number.isSafeInteger(Number(windowMs)) ? Number(windowMs) : 60_000,
          updatedAt,
        }, { ifMatch: aktuell.serverEtag });

        if (ergebnis?.ok) return { count: naechster };
        if (ergebnis?.conflict) continue;
        // Unklarer Ausgang: NICHT so tun, als wäre gezählt worden.
        throw nichtVerfuegbar("rate_counter_unavailable");
      }
      throw nichtVerfuegbar("rate_counter_exhausted");
    },
  };
}

export default { createCasRateLimiter, rateNodePath, RATE_NODE_PREFIX };
