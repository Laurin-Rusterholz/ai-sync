/* ══ E-Mail-Auswertung AUF ABRUF — kein Zeitplan, kein zweiter Scheduler ═══
 *
 * Verbindliche Nutzerklarstellung: die taegliche Orchestrierung macht ein
 * vom Nutzer selbst lokal geplanter ChatGPT-Lauf auf seinem eigenen
 * Rechner. Diese Funktion darf KEIN eigener, konkurrierender Zeitplan sein
 * — sie reagiert AUSSCHLIESSLICH auf einen authentifizierten, von aussen
 * kommenden Aufruf des lokalen Agenten (deshalb bewusst KEIN
 * `export const config = { schedule: ... }`). Der Zugangsschutz ist
 * derselbe wie bei netlify/functions/mail-queue-run.mjs (`darfLaufen`):
 * ein gueltiger `SYNC_AUTH_TOKEN` als Bearer-Token, sonst 401.
 *
 * Aufruf (fuer den lokalen Agenten):
 *   POST https://<site>/.netlify/functions/quantus-v3-daily-briefing-run
 *   Authorization: Bearer <SYNC_AUTH_TOKEN>
 * Antwort: JSON, u.a. {ok, sourceOutcome, drafted, ...} bzw.
 * {ok:false, blocked:"missing_configuration", missing:[...]} bei fehlender
 * Konfiguration — nie ein Geheimnis, nur Namen.
 * ═════════════════════════════════════════════════════════════════════════ */
import { runDailyBriefing, checkDailyBriefingConfig } from "../lib/quantus-v3-daily-briefing.mjs";
import { zugangPruefen } from "../lib/mail-queue-endpunkt.mjs";

function darfLaufen(req) {
  if (!req || typeof req.headers !== "object" || req.headers === null) return true; // direkter Aufruf im Lauf selbst (Tests)
  const erwartet = String(process.env.SYNC_AUTH_TOKEN || "").trim();
  const tuer = zugangPruefen(req.headers.get("Authorization"), erwartet);
  return tuer.ok;
}

export default async (req) => {
  if (!darfLaufen(req)) {
    return new Response(JSON.stringify({ ok: false, error: "KEIN_ZUGANG", grund: "Dieser Aufruf braucht den bestehenden SYNC_AUTH_TOKEN als Bearer-Token. Es gibt keinen Zeitplan, der ihn ersatzweise ausloest." }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const config = checkDailyBriefingConfig();
  if (!config.ok) {
    // Nur NAMEN — nie Werte, nie ob ein vorhandener Wert "richtig" ist.
    return new Response(JSON.stringify({ ok: false, blocked: "missing_configuration", missing: config.missing }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  try {
    const ergebnis = await runDailyBriefing({ now: Date.now() });
    return new Response(JSON.stringify(ergebnis), { status: ergebnis.ok ? 200 : 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    // Nie den Fehler eines fremden Aufrufs (der einen Schluesselwert
    // enthalten koennte) unveraendert nach aussen reichen.
    console.error("[quantus-v3-daily-briefing-run] Lauf gescheitert:", err && err.code, err && err.status);
    return new Response(JSON.stringify({ ok: false, error: "run_failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

// Bewusst KEIN `export const config = { schedule: ... }`: kein Netlify-
// Zeitplan, kein zweiter Scheduler neben dem lokalen ChatGPT-Lauf des
// Nutzers. Diese Funktion darf sich nie selbst ausloesen.
