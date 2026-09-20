/* ══ G — der costPolicy-Port: NUR aus Konfiguration, nie erfunden ═════════
 *
 * Keine Preise, Limits oder Freigaben werden hier festgelegt — sie kommen
 * ausschliesslich aus `QUANTUS_V3_COST_POLICY_JSON` (ein vom Betreiber
 * gepflegtes JSON-Dokument, Form siehe `validateCostPolicy` in
 * `quantus-v3-runtime-state.mjs`). Fehlt die Variable oder ist sie kein
 * gueltiges JSON-Objekt, bleibt der Port leer — kein Rueckfall auf
 * Vorgabewerte, insbesondere keine aus einem Test-/Kontingentbetrag
 * abgeleitete Zahl.
 * ═════════════════════════════════════════════════════════════════════════ */
import { COST_POLICY_SCHEMA } from "../../../netlify/lib/quantus-v3-runtime-state.mjs";
import { availablePort, unavailablePort } from "./ports.mjs";

export function createEnvCostPolicyPort(envRead, envName = "QUANTUS_V3_COST_POLICY_JSON") {
  const raw = envRead(envName);
  if (typeof raw !== "string" || !raw.trim()) return unavailablePort("costPolicy", "cost_policy_not_configured");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return unavailablePort("costPolicy", "cost_policy_json_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unavailablePort("costPolicy", "cost_policy_json_invalid");
  // `schema` wird hier gesetzt, nicht vom Betreiber verlangt — alles
  // andere (Preise, Limits, Freigabe, Gueltigkeit) muss die Variable tragen.
  const policy = Object.freeze({ ...parsed, schema: COST_POLICY_SCHEMA });
  return availablePort("costPolicy", {
    // `now`/`step` werden bewusst ignoriert: die Richtlinie ist das, was in
    // der Konfiguration steht, und wird bei jedem Aufruf frisch aus ihr
    // gelesen (kein Zwischenspeicher, der einen Widerruf verdecken koennte).
    async load() { return policy; },
  });
}
