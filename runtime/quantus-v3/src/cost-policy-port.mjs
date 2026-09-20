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
import { availablePort } from "./ports.mjs";

/* Der Dienst (`server.mjs`) ist ein LANGLEBIGER Prozess (Cloud Run/Node,
 * nicht eine Netlify-Function pro Aufruf) — `createEnvCostPolicyPort` wird
 * EINMAL beim Start aufgerufen, `.load()` aber vor JEDEM Reservieren/Senden
 * (`cost-adapter.mjs` `ladePolicy()`). Frueher wurde die Umgebungsvariable
 * nur beim Bau des Ports gelesen und das Ergebnis eingefroren zurueckgegeben
 * — ein Widerruf oder eine Preisaenderung waere bis zum naechsten
 * Prozessneustart unsichtbar geblieben. `.load()` liest jetzt bei JEDEM
 * Aufruf frisch, deshalb ist der Port immer "verfuegbar"; fehlt/ungueltig
 * ist die Variable GERADE JETZT, liefert `.load()` `null` — genau der
 * Vertrag, den `cost-adapter.mjs` bereits kennt (503 `cost_policy_unavailable`). */
export function createEnvCostPolicyPort(envRead, envName = "QUANTUS_V3_COST_POLICY_JSON") {
  function leseFrisch() {
    const raw = envRead(envName);
    if (typeof raw !== "string" || !raw.trim()) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // `schema` wird hier gesetzt, nicht vom Betreiber verlangt — alles
    // andere (Preise, Limits, Freigabe, Gueltigkeit) muss die Variable tragen.
    return Object.freeze({ ...parsed, schema: COST_POLICY_SCHEMA });
  }
  return availablePort("costPolicy", {
    // `now`/`step` werden bewusst ignoriert: die Richtlinie ist das, was
    // JETZT in der Konfiguration steht — bei jedem Aufruf frisch gelesen.
    async load() { return leseFrisch(); },
  });
}
