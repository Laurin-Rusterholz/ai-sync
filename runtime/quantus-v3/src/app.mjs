/* ══ E2 — Zusammenbau der drei Dienste ════════════════════════════════════
 *
 * Drei getrennte Cloud-Run-Dienste mit drei getrennten Dienstkonten:
 *
 *   worker    /v3/slot/start      vom Scheduler (vier benannte Jobs)
 *             /v3/run/continue    von Cloud Tasks
 *   monitor   /v3/monitor/tick    alle fuenf Minuten
 *             /v3/monitor/preflight  22:30 Ortszeit
 *   watchdog  /v3/watchdog/check  eigener Zeitplan, ohne Task-Port
 *
 * Ein Dienst weiss nur von seinen eigenen Routen. Die Portablage lehnt
 * verbotene Ports (Watchdog: `tasks`) beim Zusammenbau ab.
 * ═════════════════════════════════════════════════════════════════════════ */
import { createRouter } from "./http.mjs";
import { createPortRegistry } from "./ports.mjs";
import { handleSlotStart, handleRunContinue } from "./worker-handlers.mjs";
import { handleMonitorTick, handleMonitorPreflight, handleWatchdogCheck } from "./monitor-handlers.mjs";

export const ROUTE_TABLE = Object.freeze({
  worker: Object.freeze([
    Object.freeze({ method: "POST", path: "/v3/slot/start", endpointKey: "slot.start", handler: handleSlotStart }),
    Object.freeze({ method: "POST", path: "/v3/run/continue", endpointKey: "run.continue", handler: handleRunContinue }),
  ]),
  monitor: Object.freeze([
    Object.freeze({ method: "POST", path: "/v3/monitor/tick", endpointKey: "monitor.tick", handler: handleMonitorTick }),
    Object.freeze({ method: "POST", path: "/v3/monitor/preflight", endpointKey: "monitor.preflight", handler: handleMonitorPreflight }),
  ]),
  watchdog: Object.freeze([
    Object.freeze({ method: "POST", path: "/v3/watchdog/check", endpointKey: "watchdog.check", handler: handleWatchdogCheck }),
  ]),
});

export function createApp({ config, ports, logger = null }) {
  const routes = ROUTE_TABLE[config.role];
  if (!routes) throw new Error(`unbekannte Rolle ${config.role}`);
  const registry = ports && typeof ports.require === "function" ? ports : createPortRegistry(config.role, ports || {});
  if (registry.role !== config.role) throw new Error("Portablage und Rolle passen nicht zusammen");
  const router = createRouter({ config, ports: registry, routes, logger });
  return Object.freeze({
    role: config.role,
    mode: config.mode,
    router,
    ports: registry,
    missingPorts: registry.missingRequired(),
  });
}

/* Ohne Konfiguration gibt es keinen Dienst — nur eine Antwort, die sagt,
 * was fehlt. Kein Ersatzbetrieb, kein stiller Start. */
export function createUnconfiguredApp(failure) {
  return Object.freeze({
    role: null,
    mode: null,
    missingPorts: [],
    router: {
      routes: [],
      async handle() {
        return {
          status: failure.status,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          body: JSON.stringify(failure.body),
        };
      },
    },
  });
}
