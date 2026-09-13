/* ══ Geplanter Mailversand — der Serverlauf ══════════════════════════════════
 * Laeuft nach Plan (Netlify Scheduled Function) und schickt, was faellig ist.
 * Kein Browser-Timer: geschlossener Rechner, Neuladen, Offlinegeraet oder eine
 * andere Zeitzone aendern daran nichts.
 *
 * Der Lauf ist doppelt abgesichert:
 *   · Zugriff per if-match (ETag) — zwei gleichzeitige Laeufe nehmen nie
 *     dieselbe Mail;
 *   · Versand ueber Entwurf (drafts.create → drafts.send) — ein abgestuerzter
 *     Lauf erzeugt keine zweite Mail, sondern zieht den Stand nach.
 * Gesendet heisst erst gesendet, wenn Gmail die Nachricht mit SENT bestaetigt.
 * ═════════════════════════════════════════════════════════════════════════ */
import { firebaseDbGet, firebaseDbGetWithEtag, firebaseDbSet, firebaseDbRemove } from "../lib/firebase-admin.mjs";
import { createQueue } from "../lib/mail-queue.mjs";
import { gmailRuf } from "../lib/mail-queue-gmail.mjs";
import { zugangPruefen, umgebungswert, json } from "../lib/mail-queue-endpunkt.mjs";

/* Wer darf diesen Lauf ausloesen? Der Zeitplan — und sonst nur, wer den
   Zugangsschluessel hat. Eine geplante Ausfuehrung schickt den naechsten
   Termin im Rumpf mit; daran ist sie zu erkennen. Ein Fremder koennte sonst
   faellige Mails vorzeitig hinausschicken lassen. */
async function darfLaufen(req) {
  if (!req || typeof req.json !== "function") return true;   // direkter Aufruf im Lauf selbst
  let rumpf = null;
  try { rumpf = await req.json(); } catch (e) { rumpf = null; }
  if (rumpf && rumpf.next_run) return true;                  // vom Zeitplan gerufen
  const tuer = zugangPruefen(req.headers && req.headers.get("Authorization"), umgebungswert("SYNC_AUTH_TOKEN"));
  return tuer.ok;
}

export default async (req) => {
  if (!(await darfLaufen(req))) {
    return json({ ok: false, error: "KEIN_ZUGANG",
      grund: "Diesen Lauf loest der Zeitplan aus. Von aussen braucht es den Zugangsschluessel." }, 401);
  }
  return laufen();
};

async function laufen() {
  const q = createQueue({
    dbGet: firebaseDbGet,
    dbGetEtag: async (p) => { const r = await firebaseDbGetWithEtag(p); return { value: r.value, etag: r.serverEtag }; },
    dbSet: firebaseDbSet,
    dbRemove: firebaseDbRemove,
    gmail: gmailRuf,
  });
  try {
    const bericht = await q.lauf();
    if (bericht.gesendet.length || bericht.aufgegeben.length) {
      console.log("[mail-queue-run]", JSON.stringify({
        gesendet: bericht.gesendet.length, verschoben: bericht.verschoben.length,
        aufgegeben: bericht.aufgegeben.length, uebersprungen: bericht.uebersprungen,
      }));
    }
    return new Response(JSON.stringify(bericht), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    // Ein Fehlschlag des ganzen Laufes darf nichts verlieren: die Eintraege
    // bleiben stehen und kommen beim naechsten Lauf wieder dran.
    console.error("[mail-queue-run] Lauf gescheitert:", err && err.message);
    return new Response(JSON.stringify({ ok: false, error: String((err && err.message) || err) }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

/* Jede Minute. Die Planung ist minutengenau; haeufiger braucht es nicht, und
   seltener waere bei „Jetzt senden" spuerbar. */
export const config = { schedule: "* * * * *" };
