/* ══ Geplanter Mailversand — die Bedienung ═══════════════════════════════════
 * Quantus plant, aendert, verschiebt, bricht ab und sieht nach. Gesendet wird
 * hier NICHT: das macht der Serverlauf (mail-queue-run). So kann kein Klick im
 * Browser eine Mail vorzeitig hinausschicken, und ein geschlossener Rechner
 * haelt nichts auf.
 *
 * POST { aktion: "plane"|"liste"|"aendere"|"abbrechen"|"sofort"
 *                 |"geklaert-gesendet"|"geklaert-nicht-gesendet", … }
 * Die beiden Klaerungen gehoeren zum Zustand „unklar": Wenn ein Versand
 * angestossen war und sich nicht feststellen laesst, ob die Mail draussen ist,
 * wiederholt die Warteschlange NICHTS. Dann entscheidet ein Mensch, der in
 * Gmail nachgesehen hat.
 * Die Gmail-API kennt keine Versandplanung (Discovery v1, Revision 20260907) —
 * die Planung ist unsere, Gmail ist Versandkanal und Quelle des bestaetigten
 * Versands. Gmails Ansicht „Geplant" wird nicht vorgetaeuscht.
 * ═════════════════════════════════════════════════════════════════════════ */
import { CORS, json, requireAuth } from "../lib/gcal-shared.mjs";
import { firebaseDbGet, firebaseDbGetWithEtag, firebaseDbSet, firebaseDbRemove } from "../lib/firebase-admin.mjs";
import { createQueue } from "../lib/mail-queue.mjs";
import { gmailRuf } from "../lib/mail-queue-gmail.mjs";

function warteschlange() {
  return createQueue({
    dbGet: firebaseDbGet,
    dbGetEtag: async (p) => { const r = await firebaseDbGetWithEtag(p); return { value: r.value, etag: r.serverEtag }; },
    dbSet: firebaseDbSet,
    dbRemove: firebaseDbRemove,
    gmail: gmailRuf,
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = requireAuth(req);
  if (auth) return auth;

  let p;
  try { p = await req.json(); } catch (e) { return json({ error: "Invalid JSON body" }, 400); }
  const q = warteschlange();
  const aktion = String(p.aktion || "");

  try {
    if (aktion === "liste") return json({ ok: true, eintraege: await q.liste() });
    if (aktion === "plane") {
      const r = await q.plane({
        raw: p.raw, threadId: p.threadId, to: p.to, cc: p.cc, bcc: p.bcc,
        subject: p.subject, vorschau: p.vorschau, quelle: p.quelle,
        koerper: p.koerper, hatAnhaenge: p.hatAnhaenge,
        inReplyTo: p.inReplyTo, references: p.references, zitat: p.zitat,
        zeitpunkt: p.zeitpunkt, verzoegerungMs: p.verzoegerungMs,
      });
      return json(r, r.ok ? 201 : 400);
    }
    if (!p.id) return json({ error: "Ohne Id geht das nicht." }, 400);
    if (aktion === "aendere") {
      /* koerperTeil ist eine fertige MIME-Koerper-Entitaet aus dem
         Verfassen-Dialog. Nur damit laesst sich eine Mail MIT ANHANG aendern,
         ohne den Anhang wegzuwerfen: ersetzt wird genau dieser eine Teil. */
      const r = await q.aendere(String(p.id), {
        raw: p.raw, koerperTeil: p.koerperTeil,
        to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject,
        vorschau: p.vorschau, koerper: p.koerper,
        zeitpunkt: p.zeitpunkt, verzoegerungMs: p.verzoegerungMs,
      });
      return json(r, r.ok ? 200 : 409);
    }
    if (aktion === "geklaert-gesendet") { const r = await q.klaereGesendet(String(p.id)); return json(r, r.ok ? 200 : 409); }
    if (aktion === "geklaert-nicht-gesendet") { const r = await q.klaereNichtGesendet(String(p.id)); return json(r, r.ok ? 200 : 409); }
    if (aktion === "abbrechen") { const r = await q.brichAb(String(p.id)); return json(r, r.ok ? 200 : 409); }
    if (aktion === "sofort") { const r = await q.sofort(String(p.id)); return json(r, r.ok ? 200 : 409); }
    return json({ error: "Unbekannte Aktion: " + aktion }, 400);
  } catch (err) {
    console.error("[mail-queue]", aktion, err && err.message);
    return json({ error: "Die Warteschlange antwortet gerade nicht." }, 502);
  }
};

export const config = { path: "/.netlify/functions/mail-queue" };
