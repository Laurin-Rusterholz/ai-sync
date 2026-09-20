/* Quantus v3 — Route quantus-read (Werkzeug `quantus_read`).
 *
 * Dünne Hülle für den LESEWEG: benannte Abfrage, seitenweise, signierter
 * Cursor. Gelesen wird erst nach geprüftem Ausweis; geschrieben wird hier
 * nichts — auch keine Migration beim Start.
 */
import { handleReadRequest } from "../lib/quantus-v3-service.mjs";
import { buildRuntimeDeps, toResponse } from "../lib/quantus-v3-runtime.mjs";

export default async (req) => toResponse(await handleReadRequest(req, await buildRuntimeDeps({ write: false }), { route: "quantus-read" }));

export const config = { path: "/.netlify/functions/quantus-read" };
