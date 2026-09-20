/* Quantus v3 — Route quantus-ingest (Werkzeug `quantus_command`).
 *
 * Dünne Hülle: Abhängigkeiten bauen, Kette laufen lassen, Antwort umformen.
 * Jede Prüfung steht in netlify/lib/quantus-v3-service.mjs und ist dort ohne
 * HTTP prüfbar. Fehlt der Fach-, Idempotenz- oder Speicheradapter, antwortet
 * die Kette 503 — diese Datei kennt keinen Ersatzweg.
 *
 * Schreiben ist standardmässig AUS: ohne QUANTUS_V3_API_WRITES=enabled UND
 * QUANTUS_V3_MODE=enforce läuft jeder Befehl vollständig durch alle Prüfungen
 * und antwortet `applied: false`.
 */
import { handleCommandRequest } from "../lib/quantus-v3-service.mjs";
import { buildRuntimeDeps, toResponse } from "../lib/quantus-v3-runtime.mjs";

export default async (req) => toResponse(await handleCommandRequest(req, await buildRuntimeDeps({ write: true })));

export const config = { path: "/.netlify/functions/quantus-ingest" };
