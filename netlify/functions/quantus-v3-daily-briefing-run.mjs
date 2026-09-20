/* ══ Kompatibler Betriebsweg: taegliches Tagesbriefing ueber eine Netlify
 * Scheduled Function (echt ausgeliefert, kein Cloud Run/Cloud Scheduler
 * noetig — s. netlify/lib/quantus-v3-daily-briefing.mjs fuer die
 * Begruendung und Abgrenzung). Vorbild fuer den Zugangsschutz:
 * netlify/functions/mail-queue-run.mjs (`darfLaufen`).
 *
 * 04:00 Europe/Zurich = 02:00 UTC waehrend der Sommerzeit (aktuell, Ende
 * September). Der Cron-Ausdruck ist UTC-fest; im Winter (MEZ, UTC+1) laeuft
 * dieselbe Angabe um 03:00 Ortszeit — fuer ein taegliches Morgenbriefing
 * unkritisch. Eine zeitzonenechte Verschiebung ist eine spaetere,
 * eigenstaendige Aenderung, kein Blocker fuer morgen.
 * ═════════════════════════════════════════════════════════════════════════ */
import { runDailyBriefing, checkDailyBriefingConfig } from "../lib/quantus-v3-daily-briefing.mjs";
import { zugangPruefen } from "../lib/mail-queue-endpunkt.mjs";

async function darfLaufen(req) {
  if (!req || typeof req.json !== "function") return true; // direkter Aufruf im Lauf selbst (Tests)
  let rumpf = null;
  try { rumpf = await req.json(); } catch { rumpf = null; }
  if (rumpf && rumpf.next_run) return true; // vom Netlify-Zeitplan gerufen
  const erwartet = String(process.env.SYNC_AUTH_TOKEN || "").trim();
  const tuer = zugangPruefen(req.headers && req.headers.get("Authorization"), erwartet);
  return tuer.ok;
}

export default async (req) => {
  if (!(await darfLaufen(req))) {
    return new Response(JSON.stringify({ ok: false, error: "KEIN_ZUGANG", grund: "Dieser Lauf loest der Zeitplan aus. Von aussen braucht es den bestehenden SYNC_AUTH_TOKEN." }), { status: 401, headers: { "Content-Type": "application/json" } });
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

// 02:00 UTC = 04:00 Europe/Zurich (Sommerzeit, s. o.).
export const config = { schedule: "0 2 * * *" };
