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

export default async () => {
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
