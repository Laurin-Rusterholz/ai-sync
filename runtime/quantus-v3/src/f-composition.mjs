/* ══ F/G — Zusammenbau der beiden bisher leeren Ports fuer den Worker ═════
 *
 * Fuellt `sectionWork` und `costPolicy` NUR, wenn alle noetigen Angaben da
 * sind — sonst bleibt der jeweilige Port leer mit benanntem Grund (503),
 * exakt wie die drei schon gebauten Ports in `integration-ports.mjs`. Kein
 * Modul wird nachgebaut: Gmail-Zugriff kommt aus dem vorhandenen
 * `netlify/lib/gcal-shared.mjs` (Firebase-gestuetzte Tokenerneuerung), die
 * Tagesbriefing-Policy aus derselben Variable wie der C2-Domain-Adapter.
 * ═════════════════════════════════════════════════════════════════════════ */
import { unavailablePort } from "./ports.mjs";
import { createGmailSourceReader } from "./gmail-source.mjs";
import { createAnthropicTransport } from "./anthropic-transport.mjs";
import { createEnvCostPolicyPort } from "./cost-policy-port.mjs";
import { createSectionWorkProvider, loadAssistantPolicy } from "./section-work.mjs";

/**
 * @param envRead   `(name) => string|undefined`, wie `resolveRuntimeConfig`.
 * @param loadGmailToken  nur fuer Tests: ersetzt den dynamischen Import.
 */
export async function createFSourcePorts({ config, corePort, clockPort, envRead = (n) => process.env[n], loadGmailToken } = {}) {
  const costPolicy = createEnvCostPolicyPort(envRead);

  const gmailLader = typeof loadGmailToken === "function" ? loadGmailToken : async () => {
    const mod = await import("../../../netlify/lib/gcal-shared.mjs");
    if (typeof mod.getValidAccessToken !== "function") throw Object.assign(new Error("missing_export:getValidAccessToken"), { code: "missing_export" });
    return mod.getValidAccessToken;
  };

  const apiKey = envRead("QUANTUS_V3_ANTHROPIC_API_KEY");
  const model = envRead("QUANTUS_V3_ANTHROPIC_MODEL");
  const inputRate = Number(envRead("QUANTUS_V3_ANTHROPIC_INPUT_MICROS_PER_MTOK"));
  const outputRate = Number(envRead("QUANTUS_V3_ANTHROPIC_OUTPUT_MICROS_PER_MTOK"));
  const policyResult = loadAssistantPolicy(envRead);

  if (!apiKey || !model || !Number.isSafeInteger(inputRate) || !Number.isSafeInteger(outputRate)) {
    return { sectionWork: unavailablePort("sectionWork", "section_work_provider_not_configured"), costPolicy };
  }
  if (!policyResult.ok) {
    return { sectionWork: unavailablePort("sectionWork", "assistant_" + policyResult.reason), costPolicy };
  }
  let getAccessToken;
  try { getAccessToken = await gmailLader(); } catch (e) {
    return { sectionWork: unavailablePort("sectionWork", e && e.code === "missing_export" ? e.message : "gmail_source_not_wired"), costPolicy };
  }

  const gmailSource = createGmailSourceReader({ getAccessToken });
  const anthropic = createAnthropicTransport({
    apiKey, model, modelPricing: { inputMicrosPerMillionTokens: inputRate, outputMicrosPerMillionTokens: outputRate },
  });
  let sectionWork;
  try {
    sectionWork = createSectionWorkProvider({
      // `costPolicy` ist jetzt immer verfuegbar (s. cost-policy-port.mjs) —
      // `.load()` selbst meldet frisch, ob GERADE JETZT eine gueltige
      // Richtlinie konfiguriert ist. Der frueher hier gebaute always-null-
      // Ersatz haette eine spaeter (im selben warmen Prozess) gesetzte
      // Variable nie mehr gesehen.
      corePort, costPolicyPort: costPolicy.impl,
      clockPort, gmailSource, anthropic, leaseScope: config.leaseScope, policy: policyResult.policy,
      runtimeConfig: config,
    });
  } catch (e) {
    return { sectionWork: unavailablePort("sectionWork", "section_work_construction_failed:" + e.message), costPolicy };
  }
  return { sectionWork, costPolicy };
}
