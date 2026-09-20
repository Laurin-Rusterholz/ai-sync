#!/usr/bin/env node
/* ══ E2 — Eintritt im Container ═══════════════════════════════════════════
 *
 * Cloud Run gibt den Port in $PORT vor. Fehlt die Konfiguration, startet
 * der Dienst trotzdem — und antwortet auf JEDER Route mit 503 und der
 * Liste der fehlenden Variablennamen. So sieht man im Log sofort, was
 * fehlt, statt einen Container zu bekommen, der gar nicht hochkommt oder,
 * schlimmer, mit Vorgabewerten losarbeitet.
 *
 * Die produktiven Ports sind hier ABSICHTLICH nicht verdrahtet: der echte
 * CAS-Umschlag, Cloud Tasks, die Werkzeugstrecke und der Warnweg gehoeren
 * der Integration. Bis dahin meldet jede Route `port_unavailable` mit dem
 * Namen des fehlenden Ports.
 * ═════════════════════════════════════════════════════════════════════════ */
import { createServer } from "node:http";
import { resolveRuntimeConfig } from "./config.mjs";
import { createApp, createUnconfiguredApp } from "./app.mjs";
import { createNodeRequestListener } from "./http.mjs";
import { availablePort, unavailablePort, createPortRegistry } from "./ports.mjs";
import { createIntegrationCorePort, createCloudTasksPort, createRunStatusClosureEvidencePort } from "./integration-ports.mjs";

function structuredLog(entry) {
  process.stdout.write(`${JSON.stringify({ ...entry, service: "quantus-v3" })}\n`);
}

const resolved = resolveRuntimeConfig((name) => process.env[name]);
let app;
if (!resolved.ok) {
  structuredLog({ severity: "ERROR", message: "runtime_not_configured", ...resolved.body });
  app = createUnconfiguredApp(resolved);
} else {
  const config = resolved.config;
  // Der Kernport wird an den ECHTEN Umschlag verdrahtet. Liegt er nicht
  // vor, bleibt der Port leer und nennt den Grund — es wird nichts
  // nachgebaut und nichts vorgetaeuscht.
  const corePort = await createIntegrationCorePort({
    tenantId: config.tenant,
    principalId: config.leaseHolder || `quantus-v3-${config.role}`,
  });
  // Cloud Tasks und das Statuswerkzeug brauchen einen Transport mit
  // Zugangsdaten. Der gehoert nicht in dieses Paket; ohne ihn bleiben die
  // Ports leer.
  const tasksPort = createCloudTasksPort({});
  const closurePort = createRunStatusClosureEvidencePort({});
  const registry = createPortRegistry(config.role, {
    clock: availablePort("clock", {
      now: () => Date.now(),
      setTimer: (delayMs, cb) => {
        const t = setTimeout(cb, Math.max(0, delayMs));
        if (typeof t.unref === "function") t.unref();
        return () => clearTimeout(t);
      },
    }),
    // Diese drei kommen aus der Integration und sind hier nicht verdrahtet.
    jwks: unavailablePort("jwks", "google_jwks_fetch_not_wired"),
    core: corePort,
    ...(config.role === "watchdog" ? {} : { tasks: tasksPort }),
    ...(config.role === "worker" ? {
      sectionWork: unavailablePort("sectionWork", "section_work_provider_not_wired"),
      costPolicy: unavailablePort("costPolicy", "cost_policy_not_wired"),
      closureEvidence: closurePort,
    } : {}),
    ...(config.role === "watchdog" ? { alert: unavailablePort("alert", "alert_channel_not_wired") } : {}),
  });
  app = createApp({ config, ports: registry, logger: structuredLog });
  structuredLog({
    severity: "NOTICE", message: "started",
    role: config.role, mode: config.mode,
    gatesComplete: config.gatesComplete,
    externalEffectsAllowed: config.allowExternalEffects,
    missingPorts: app.missingPorts,
    portStatus: app.ports.describe(),
    routes: app.router.routes,
  });
}

const port = Number(process.env.PORT || 8080);
const maxBytes = resolved.ok ? resolved.config.maxRequestBytes : 16 * 1024;
createServer(createNodeRequestListener(app.router, { maxBytes })).listen(port, () => {
  structuredLog({ severity: "NOTICE", message: "listening", port });
});
