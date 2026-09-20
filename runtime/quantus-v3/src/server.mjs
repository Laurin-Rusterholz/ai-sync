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
import { createC2HttpTransport } from "./c2-transport.mjs";
import { createToolClient } from "./tool-ports.mjs";
import { createGoogleJwksPort, createGoogleAccessTokenSource, createCloudTasksHttpTransport } from "./google-transport.mjs";
import { createJobTokenIssuer } from "./job-token-issuer.mjs";
import { externalEffectsAllowed } from "./config.mjs";
import { createFSourcePorts } from "./f-composition.mjs";

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
  /*
   * Cloud Tasks: Transport ueber die VORHANDENE Google-Identitaet
   * (`getIdentityAccessToken` aus firebase-admin, Scope cloud-platform).
   * Fehlt der Export, fehlen die Zugangsdaten, oder ist die Aussenwirkung
   * nicht freigegeben, bleibt der Port leer und nennt den Grund.
   */
  const tokenQuelle = await createGoogleAccessTokenSource({});
  const tasksTransport = tokenQuelle.ok
    ? createCloudTasksHttpTransport({
      accessTokenSource: tokenQuelle,
      allowExternalEffects: externalEffectsAllowed(config),
    })
    : { ok: false, reason: tokenQuelle.reason, transport: null };
  const tasksPort = tasksTransport.ok
    ? createCloudTasksPort({ transport: tasksTransport.transport })
    : unavailablePort("tasks", tasksTransport.reason);

  /*
   * Der Statusnachweis laeuft ueber die echte C2-Route (GET, Query-String).
   * Ohne Ursprung, ohne Dienstzugangsdatum oder mit abgeschaltetem
   * Werkzeug gibt es keinen Port — und damit kein gruenes Ende.
   */
  const toolCredential = process.env.QUANTUS_V3_TOOL_CREDENTIAL_SCHEDULER;
  let closurePort;
  if (!config.c2BaseUrl) {
    closurePort = unavailablePort("closureEvidence", "c2_base_url_not_configured");
  } else if (typeof toolCredential !== "string" || !toolCredential) {
    closurePort = unavailablePort("closureEvidence", "tool_credential_not_configured");
  } else {
    // Der Abschlussnachweis (`status.run` + `sourceChecks.run`) braucht
    // KEIN Job-Token mehr — beide laufen ueber das Dienst-Zugangsdatum.
    // `context.run` (Kategorie `run_context`, nur `lead_agent` erlaubt)
    // bleibt als eigener Werkzeugport bestehen und braucht dafuer weiterhin
    // ein laufgebundenes Job-Token; fehlt dessen Konfiguration (C1-eigene
    // `QUANTUS_V3_WORKER_TOKEN_KEYS` u.a.), scheitert NUR ein Aufruf von
    // `context.run` selbst — der Abschlussnachweis ist davon unabhaengig.
    const jobTokenIssuer = await createJobTokenIssuer({});
    const toolClient = createToolClient({
      transport: createC2HttpTransport({ baseUrl: config.c2BaseUrl }),
      // Das Geheimnis wird NUR hier gereicht und nie protokolliert.
      credential: { async get() { return toolCredential; } },
      jobTokenIssuer: jobTokenIssuer.available ? jobTokenIssuer : null,
      tenant: config.tenant,
      policyVersion: config.policyVersion,
      toolsEnabled: config.toolsEnabled,
    });
    closurePort = createRunStatusClosureEvidencePort({
      toolClient, tenant: config.tenant, policyVersion: config.policyVersion,
    });
  }

  const jwks = createGoogleJwksPort({});
  const clockPort = availablePort("clock", {
    now: () => Date.now(),
    setTimer: (delayMs, cb) => {
      const t = setTimeout(cb, Math.max(0, delayMs));
      if (typeof t.unref === "function") t.unref();
      return () => clearTimeout(t);
    },
  });
  // Baustein F/G: die frueher immer leeren Ports. Fehlt eine Angabe
  // (Anthropic-Schluessel/-Modell/-Preise, Tagesbriefing-Policy, Gmail-
  // Zugangsdatum, Kostenrichtlinie), bleibt der jeweilige Port leer mit
  // benanntem Grund — kein Ersatzbetrieb.
  const fPorts = config.role === "worker"
    ? await createFSourcePorts({ config, corePort, clockPort: clockPort.impl })
    : { sectionWork: null, costPolicy: null };
  const registry = createPortRegistry(config.role, {
    clock: clockPort,
    jwks: jwks.available ? availablePort("jwks", jwks.impl) : unavailablePort("jwks", jwks.reason),
    core: corePort,
    ...(config.role === "watchdog" ? {} : { tasks: tasksPort }),
    ...(config.role === "worker" ? {
      sectionWork: fPorts.sectionWork,
      costPolicy: fPorts.costPolicy,
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
