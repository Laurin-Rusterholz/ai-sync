/* ══ E-Mail-Auswertung AUF ABRUF — kein Zeitplan, kein zweiter Scheduler ═══
 *
 * Verbindliche Nutzerklarstellung: die taegliche Orchestrierung macht ein
 * vom Nutzer selbst lokal geplanter ChatGPT-Lauf auf seinem eigenen
 * Rechner. Diese Funktion darf KEIN eigener, konkurrierender Zeitplan sein
 * — sie reagiert AUSSCHLIESSLICH auf einen authentifizierten, von aussen
 * kommenden Aufruf (lokaler Agent ODER der manuelle Knopf im DailyBriefing,
 * s. public/index.html `dbRunV3EmailBriefing`), deshalb bewusst KEIN
 * `export const config = { schedule: ... }`.
 *
 * ZUGANGSSCHLUESSEL, GETRENNT von den bestehenden Endpunkten:
 * `SYNC_AUTH_TOKEN` ist in Netlify aktuell NICHT gesetzt — ihn jetzt neu zu
 * setzen wuerde alle Endpunkte, die ueber `gcal-shared.mjs` `requireAuth`
 * laufen (Gmail/gcal/blob-put/…), von "offen ohne Token" auf "Token
 * zwingend" umschalten und damit sperren (dieselbe Falle, die
 * netlify/lib/mail-queue-endpunkt.mjs fuer den Mail-Ausgang schon
 * dokumentiert). Deshalb hat DIESER Endpunkt einen EIGENEN, bevorzugten
 * Schluessel:
 *   QUANTUS_EMAIL_AUTH_TOKEN   (bevorzugt — betrifft nur diesen Endpunkt)
 *   SYNC_AUTH_TOKEN            (Ruckfall, NUR falls ohnehin schon gesetzt)
 * Ist keiner von beiden gesetzt, bleibt der Endpunkt gesperrt (503) — fail
 * closed, kein stiller Passthrough wie bei den Alt-Endpunkten ohne Token.
 * Der Vergleich selbst (Bearer-Praefix, zeitkonstant) ist derselbe wie bei
 * netlify/functions/mail-queue-run.mjs (`zugangPruefen`).
 *
 * Aufruf:
 *   POST https://<site>/.netlify/functions/quantus-v3-daily-briefing-run
 *   Authorization: Bearer <QUANTUS_EMAIL_AUTH_TOKEN>
 * Antwort: JSON, u.a. {ok, sourceOutcome, drafted, ...} bzw.
 * {ok:false, blocked:"missing_configuration", missing:[...]} bei fehlender
 * Konfiguration — nie ein Geheimnis, nur Namen.
 * ═════════════════════════════════════════════════════════════════════════ */
import { runDailyBriefing, checkDailyBriefingConfig, sichereViolations } from "../lib/quantus-v3-daily-briefing.mjs";
import { zugangPruefen } from "../lib/mail-queue-endpunkt.mjs";

function pruefeZugang(req) {
  if (!req || typeof req.headers !== "object" || req.headers === null) return { ok: true }; // direkter Aufruf im Lauf selbst (Tests)
  const bevorzugt = String(process.env.QUANTUS_EMAIL_AUTH_TOKEN || "").trim();
  const rueckfall = String(process.env.SYNC_AUTH_TOKEN || "").trim();
  const tuer = zugangPruefen(req.headers.get("Authorization"), bevorzugt || rueckfall);
  if (tuer.ok) return tuer;
  if (tuer.status === 503) {
    return { ok: false, status: 503, koerper: { ok: false, error: "GESPERRT",
      grund: "Kein Zugangsschluessel konfiguriert: QUANTUS_EMAIL_AUTH_TOKEN (empfohlen, betrifft nur diesen Endpunkt) oder ersatzweise ein bereits vorhandener SYNC_AUTH_TOKEN muss in Netlify gesetzt sein." } };
  }
  return { ok: false, status: 401, koerper: { ok: false, error: "KEIN_ZUGANG",
    grund: "Der Zugangsschluessel stimmt nicht mit QUANTUS_EMAIL_AUTH_TOKEN (oder ersatzweise SYNC_AUTH_TOKEN) ueberein." } };
}

export default async (req) => {
  const zugang = pruefeZugang(req);
  if (!zugang.ok) {
    return new Response(JSON.stringify(zugang.koerper), { status: zugang.status, headers: { "Content-Type": "application/json" } });
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
    // Review-Fix (25.09.2026, belegter Fehler): runDailyBriefing() faengt
    // seit diesem Fix JEDEN bekannten Fehlschlagspunkt selbst ab (siehe
    // mitPhase() in quantus-v3-daily-briefing.mjs) und gibt IMMER ein
    // strukturiertes { ok:false, blocked, code } zurueck — dieser Zweig
    // erreicht daher nur noch einen wirklich unklassifizierten
    // Programmierfehler. Trotzdem gilt weiterhin: nie den Fehler eines
    // fremden Aufrufs (der einen Schluesselwert oder Mailinhalt enthalten
    // koennte) unveraendert nach aussen reichen — nur ein sicherer, kurzer
    // Code, nie err.message.
    const code = (err && typeof err.code === "string" && /^[a-zA-Z][a-zA-Z0-9_]{1,60}$/.test(err.code)) ? err.code
      : (err && typeof err.name === "string" && /^[a-zA-Z][a-zA-Z0-9]{1,60}$/.test(err.name)) ? err.name
      : "unknown_error";
    const violations = sichereViolations(err);
    console.error("[quantus-v3-daily-briefing-run] Lauf gescheitert (unklassifiziert):", code, err && err.status);
    return new Response(JSON.stringify({ ok: false, error: "run_failed", phase: "unclassified", code, ...(violations ? { violations } : {}) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

// Bewusst KEIN `export const config = { schedule: ... }`: kein Netlify-
// Zeitplan, kein zweiter Scheduler neben dem lokalen ChatGPT-Lauf des
// Nutzers. Diese Funktion darf sich nie selbst ausloesen.
