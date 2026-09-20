/* ══ E2 — Ports: was fehlt, scheitert mit 503 ═════════════════════════════
 *
 * Dieses Paket baut das Geruest, nicht die Anbindung. Jede Aussenwirkung
 * laeuft ueber einen benannten Port. Fehlt einer, antwortet die Route mit
 * 503 und nennt den Port — es gibt KEIN Ersatzverhalten, das so tut, als
 * waere etwas geschehen.
 *
 * Ports dieses Pakets:
 *   clock          Serverzeit an der vertrauenswuerdigen Grenze (einmal je
 *                  Anfrage) UND Zeitgeber: `now()` und
 *                  `setTimer(delayMs, cb) -> cancel`. Der Zeitgeber muss
 *                  aus derselben Uhr kommen wie `now()` — eine Testuhr mit
 *                  echten Wallclock-Timern zu mischen macht jede Aussage
 *                  ueber Fristen wertlos.
 *   jwks           oeffentliche Google-Schluessel fuer die OIDC-Pruefung
 *   core           der ECHTE CAS-/Idempotenzumschlag (mutateAppData +
 *                  applyIdempotentCommand). Liegt auf der Integration und
 *                  ist hier bewusst NICHT nachgebaut.
 *                  `mutate(...)` MUSS `{ result, replayed, wrote }`
 *                  liefern: `replayed` sagt, ob der Beleg wiedergegeben
 *                  wurde, `wrote`, ob wirklich geschrieben wurde. Fehlt
 *                  eines davon, gilt ein bezahlter Aufruf als nicht
 *                  berechtigt — eine wiedergegebene Buchung ist keine
 *                  neue Sendeberechtigung.
 *   tasks          Cloud Tasks einreihen (stabile Namen)
 *   sectionWork    die fachlichen Schritte eines Abschnitts. `next` bekommt
 *                  ein `signal` und eine Frist und muss beides beachten.
 *   closureEvidence  `load({ runKey, fence, now, tenant })` — der streng
 *                  gepruefte Abschlussnachweis. Ohne ihn wird kein Lauf
 *                  gruen.
 *   costPolicy     freigegebener Preis- und Budgetstand. `load({ now, step })`
 *                  liefert den AKTUELL freigegebenen Stand und wird fuer
 *                  jeden Schritt neu gerufen — eine gemerkte Policy wuerde
 *                  einen zwischenzeitlichen Widerruf verdecken.
 *   toolTransport  HTTP zu den vier Quantus-Werkzeugen
 *   toolCredential Dienstzugangsdatum fuer diese Werkzeuge (nie geloggt)
 *   alert          Warnweg des Watchdogs
 * ═════════════════════════════════════════════════════════════════════════ */
import { HttpError } from "./errors.mjs";

export const PORT_NAMES = Object.freeze([
  "clock", "jwks", "core", "tasks", "sectionWork", "costPolicy",
  "closureEvidence", "toolTransport", "toolCredential", "alert",
]);

export const REQUIRED_PORTS = Object.freeze({
  worker: Object.freeze(["clock", "jwks", "core", "tasks", "sectionWork", "costPolicy", "closureEvidence"]),
  monitor: Object.freeze(["clock", "jwks", "core", "tasks"]),
  watchdog: Object.freeze(["clock", "jwks", "core", "alert"]),
});

/* Der Watchdog ist NUR dann unabhaengig, wenn er nichts vom Monitor braucht
 * und nichts einreihen kann. Sonst faellt er mit ihm zusammen aus. */
export const FORBIDDEN_PORTS = Object.freeze({
  worker: Object.freeze([]),
  monitor: Object.freeze([]),
  watchdog: Object.freeze(["tasks", "sectionWork", "monitorInvoke", "closureEvidence"]),
});

export function unavailablePort(name, reason) {
  return Object.freeze({ name, available: false, reason: String(reason || "not_configured"), impl: null });
}

export function availablePort(name, impl) {
  if (impl === null || typeof impl !== "object") throw new TypeError(`Port ${name}: Implementierung erwartet`);
  return Object.freeze({ name, available: true, reason: null, impl });
}

export function createPortRegistry(role, ports = {}) {
  if (!Object.hasOwn(REQUIRED_PORTS, role)) throw new TypeError(`unbekannte Rolle ${role}`);
  const entries = new Map();
  for (const [name, entry] of Object.entries(ports)) {
    if (!PORT_NAMES.includes(name)) throw new TypeError(`unbekannter Port ${name}`);
    if (FORBIDDEN_PORTS[role].includes(name)) {
      throw new TypeError(`Rolle ${role} darf den Port ${name} nicht haben — Unabhaengigkeit verletzt`);
    }
    entries.set(name, entry && entry.available ? entry : unavailablePort(name, entry?.reason));
  }
  for (const name of REQUIRED_PORTS[role]) {
    if (!entries.has(name)) entries.set(name, unavailablePort(name, "not_configured"));
  }

  return Object.freeze({
    role,
    has(name) { return entries.has(name) && entries.get(name).available; },
    /* Wirft 503 mit dem Portnamen — kein Ersatz, keine Beschoenigung. */
    require(name) {
      const entry = entries.get(name);
      if (!entry || !entry.available) {
        throw new HttpError(503, "port_unavailable", { port: name, reason: entry ? entry.reason : "not_registered" });
      }
      return entry.impl;
    },
    describe() {
      return Object.fromEntries([...entries].map(([name, e]) => [name, { available: e.available, reason: e.reason }]));
    },
    missingRequired() {
      return REQUIRED_PORTS[role].filter((name) => !entries.get(name)?.available);
    },
  });
}

/* Die Anbindung an den echten Kernumschlag steht in
 * `integration-ports.mjs` (`createIntegrationCorePort`). Sie importiert
 * `mutateAppData` und das Idempotenzpaket der Integration und baut
 * NICHTS davon nach; fehlt eines, bleibt der Port leer und meldet das. */
