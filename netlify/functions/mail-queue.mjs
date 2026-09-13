/* ══ Geplanter Mailversand — die Bedienung ═══════════════════════════════════
 * Quantus plant, aendert, verschiebt, bricht ab und sieht nach. Gesendet wird
 * hier NICHT: das macht der Serverlauf (mail-queue-run). So kann kein Klick im
 * Browser eine Mail vorzeitig hinausschicken, und ein geschlossener Rechner
 * haelt nichts auf.
 *
 * POST { aktion: "plane"|"liste"|"aendere"|"abbrechen"|"sofort"
 *                |"geklaert-gesendet"|"geklaert-nicht-gesendet", … }
 *
 * FAIL-CLOSED: Ohne hinterlegten Zugangsschluessel (MAIL_QUEUE_AUTH_TOKEN, ersatzweise
 * SYNC_AUTH_TOKEN) antwortet
 * dieser Endpunkt GESPERRT und ruehrt die Datenbank nicht an — hier liegen
 * vollstaendige MIME-Nachrichten samt Anhaengen, und wer planen darf, kann in
 * fremdem Namen Mail verschicken. Der Ablauf steht in
 * netlify/lib/mail-queue-endpunkt.mjs, damit die Tuer selbst pruefbar ist
 * (tests/mail-queue-zugang.test.mjs).
 *
 * Die Gmail-API kennt keine Versandplanung (Discovery v1, Revision 20260907) —
 * die Planung ist unsere, Gmail ist Versandkanal und Quelle des bestaetigten
 * Versands. Gmails Ansicht „Geplant" wird nicht vorgetaeuscht.
 * ═════════════════════════════════════════════════════════════════════════ */
import { firebaseDbGet, firebaseDbGetWithEtag, firebaseDbSet, firebaseDbRemove } from "../lib/firebase-admin.mjs";
import { createQueue } from "../lib/mail-queue.mjs";
import { gmailRuf } from "../lib/mail-queue-gmail.mjs";
import { bearbeiteAnfrage, queueSchluessel } from "../lib/mail-queue-endpunkt.mjs";

function warteschlange() {
  return createQueue({
    dbGet: firebaseDbGet,
    dbGetEtag: async (p) => { const r = await firebaseDbGetWithEtag(p); return { value: r.value, etag: r.serverEtag }; },
    dbSet: firebaseDbSet,
    dbRemove: firebaseDbRemove,
    gmail: gmailRuf,
  });
}

export default async (req) => bearbeiteAnfrage(req, {
  queueFactory: warteschlange,
  token: queueSchluessel(),
});

export const config = { path: "/.netlify/functions/mail-queue" };
