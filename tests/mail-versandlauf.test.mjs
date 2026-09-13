/*
 * Geplanter Mailversand — der Serverlauf, gegen Gmail-Doppel und gestellte Uhr.
 * ---------------------------------------------------------------------------
 * Geprueft wird die ECHTE netlify/lib/mail-queue.mjs. Nichts geht nach
 * draussen: Gmail ist ein Doppel, die Uhr wird gestellt, die Ablage ist eine
 * Map im Speicher. Es entsteht keine Mail, kein Entwurf, keine Adresse, die es
 * wirklich gibt.
 *
 * Die Fragen, die hier beantwortet werden:
 *   · Geht nichts vor der Zeit raus?
 *   · Erzeugt ein zweiter Lauf — oder ein abgestuerzter erster — eine zweite
 *     Mail? (Nein: der Entwurf ist die Sperre.)
 *   · Gilt eine Mail erst als gesendet, wenn Gmail SENT bestaetigt?
 *   · Ueberlebt Abbrechen/Bearbeiten den Lauf, ohne Fruehversand?
 *   · Wird ein Fehlschlag verschoben statt verworfen?
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { createQueue } = await import(path.join(root, "netlify/lib/mail-queue.mjs"));
const K = (await import(path.join(root, "public/mail-queue-core.js"))).default;

let checks = 0;
const ok = (b, t) => { assert.ok(b, t); checks++; };
const eq = (a, b, t) => { assert.equal(a, b, t); checks++; };

const T0 = Date.parse("2026-09-13T09:00:00+02:00");
const STUNDE = 60 * 60 * 1000;

/* Ein Gmail-Doppel, das sich wie die echte API verhaelt: Entwuerfe entstehen,
   verschwinden beim Senden, gesendete Nachrichten tragen SENT. */
function gmailDoppel(optionen = {}) {
  const zustand = { drafts: new Map(), messages: new Map(), aufrufe: [], sendCount: 0, fehler: null };
  let n = 0;
  async function gmail(method, pfad, opt = {}) {
    zustand.aufrufe.push(method + " " + pfad);
    if (zustand.fehler) { const f = zustand.fehler; zustand.fehler = null; throw f; }
    if (method === "POST" && pfad === "/users/me/drafts") {
      const draftId = "draft_" + (++n);
      const msgId = "dmsg_" + n;
      zustand.drafts.set(draftId, { id: draftId, message: { id: msgId, threadId: (opt.body.message || {}).threadId || "thr_" + n, labelIds: ["DRAFT"] } });
      return zustand.drafts.get(draftId);
    }
    if (method === "GET" && /^\/users\/me\/drafts\//.test(pfad)) {
      const d = zustand.drafts.get(decodeURIComponent(pfad.split("/").pop()));
      if (!d) { const e = new Error("Not Found"); e.status = 404; throw e; }
      return d;
    }
    if (method === "PUT" && /^\/users\/me\/drafts\//.test(pfad)) {
      const id = decodeURIComponent(pfad.split("/").pop());
      if (!zustand.drafts.has(id)) { const e = new Error("Not Found"); e.status = 404; throw e; }
      zustand.drafts.get(id).message.raw = (opt.body.message || {}).raw;
      return zustand.drafts.get(id);
    }
    if (method === "DELETE" && /^\/users\/me\/drafts\//.test(pfad)) {
      zustand.drafts.delete(decodeURIComponent(pfad.split("/").pop()));
      return {};
    }
    if (method === "POST" && pfad === "/users/me/drafts/send") {
      const d = zustand.drafts.get(opt.body.id);
      if (!d) { const e = new Error("Not Found"); e.status = 404; throw e; }
      zustand.drafts.delete(opt.body.id);
      zustand.sendCount++;
      const m = { id: "msg_" + zustand.sendCount, threadId: d.message.threadId,
        labelIds: optionen.ohneLabelInAntwort ? [] : ["SENT"] };
      zustand.messages.set(m.id, { id: m.id, threadId: m.threadId, labelIds: ["SENT"] });
      zustand.messages.set(d.message.id, { id: d.message.id, threadId: m.threadId, labelIds: ["SENT"] });
      return m;
    }
    if (method === "GET" && /^\/users\/me\/messages\//.test(pfad)) {
      const m = zustand.messages.get(decodeURIComponent(pfad.split("/").pop()));
      if (!m) { const e = new Error("Not Found"); e.status = 404; throw e; }
      return m;
    }
    throw new Error("unerwarteter Aufruf: " + method + " " + pfad);
  }
  return { gmail, zustand };
}

function umgebung(optionen = {}) {
  const speicher = new Map();
  let t = T0;
  const uhr = { jetzt: () => t, vor: (ms) => { t += ms; return t; } };
  const { gmail, zustand } = gmailDoppel(optionen);
  /* Die Ablage fuehrt Kennungen (ETags) wie die echte RTDB — sonst liesse
     sich der atomare Zugriff zweier Laeufe gar nicht pruefen. */
  const kennungen = new Map();
  let lauf = 0;
  const setze = (p, v) => { speicher.set(p, JSON.parse(JSON.stringify(v))); kennungen.set(p, "e" + (++lauf)); };
  const q = createQueue({
    dbGet: async (p) => {
      if (p === "mail/outbox") {
        const alle = {};
        speicher.forEach((v, k) => { alle[k.split("/").pop()] = v; });
        return alle;
      }
      return speicher.get(p) || null;
    },
    dbGetEtag: async (p) => ({ value: speicher.get(p) || null, etag: kennungen.get(p) || null }),
    dbSet: async (p, v, opt = {}) => {
      if (opt.ifMatch && kennungen.get(p) !== opt.ifMatch) return { ok: false, conflict: true };
      setze(p, v);
      return { ok: true, conflict: false };
    },
    dbRemove: async (p) => { speicher.delete(p); },
    gmail, jetzt: uhr.jetzt, neueId: (() => { let i = 0; return () => "out_" + (++i); })(),
  });
  const lies = async (id) => speicher.get("mail/outbox/" + id);
  return { q, uhr, gmail: zustand, lies, speicher, setze };
}

const MAIL = { raw: "cmF3LWJlaXNwaWVs", to: "beispiel@example.com", subject: "Beispiel", threadId: "thr_1" };

/* ══ 1. Nichts geht vor der Zeit raus ═════════════════════════════════════ */
{
  const { q, uhr, gmail, lies } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  eq(K.zeigeZeit(eintrag.sendAt), "13.09.2026, 12:00", "die Mail ist nicht auf 12:00 Zuerich geplant");

  uhr.vor(2 * STUNDE + 59 * 60 * 1000);
  let bericht = await q.lauf("l1");
  eq(gmail.sendCount, 0, "eine Minute zu frueh ging die Mail raus");
  eq(bericht.gesendet.length, 0, "der Lauf meldet einen Versand, den es nicht gab");
  eq((await lies(eintrag.id)).status, K.STATUS.geplant, "der Status wurde ohne Grund veraendert");

  uhr.vor(60 * 1000);
  bericht = await q.lauf("l2");
  eq(gmail.sendCount, 1, "zur geplanten Zeit ging die Mail nicht raus");
  const e = await lies(eintrag.id);
  eq(e.status, K.STATUS.gesendet, "der Status steht nicht auf gesendet");
  ok(e.gmailMessageId && e.sentAt, "Nachrichten-Id oder Sendezeitpunkt fehlen");
  ok(gmail.aufrufe.includes("POST /users/me/drafts"), "es wurde kein Entwurf angelegt");
  ok(gmail.aufrufe.includes("POST /users/me/drafts/send"), "es wurde nicht ueber den Entwurf gesendet");
  ok(!gmail.aufrufe.some((a) => /messages\/send/.test(a)), "es wurde am Entwurf vorbei gesendet");
}

/* ══ 2. Zwei Laeufe, eine Mail ════════════════════════════════════════════ */
{
  const { q, uhr, gmail, lies } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  await Promise.all([q.lauf("a"), q.lauf("b")]);
  eq(gmail.sendCount, 1, `zwei Laeufe haben ${gmail.sendCount} Mails gesendet`);
  eq((await lies(eintrag.id)).status, K.STATUS.gesendet, "die Mail gilt danach nicht als gesendet");

  // Und ein dritter Lauf danach schickt sie nicht noch einmal.
  uhr.vor(STUNDE);
  await q.lauf("c");
  eq(gmail.sendCount, 1, "ein spaeterer Lauf sendet die gesendete Mail erneut");
}

/* ══ 3. Abgestuerzter Lauf: Entwurf da, Versand offen ════════════════════ */
{
  const { q, uhr, gmail, lies, speicher } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  // Der Lauf stuerzt nach Stufe 1 ab: Entwurf existiert, Claim bleibt stehen.
  gmail.fehler = Object.assign(new Error("Verbindung abgebrochen"), { status: 503 });
  await q.lauf("absturz");
  let e = await lies(eintrag.id);
  eq(gmail.sendCount, 0, "trotz Absturz wurde gesendet");
  eq(e.status, K.STATUS.geplant, "nach dem Absturz steht der Eintrag nicht wieder bereit");
  eq(e.versuche, 1, "der Versuch wurde nicht gezaehlt");

  // Zweiter Anlauf nach der Rueckwartezeit: jetzt entsteht der Entwurf und geht raus.
  uhr.vor(2 * 60 * 1000);
  await q.lauf("zweiter");
  e = await lies(eintrag.id);
  eq(gmail.sendCount, 1, "der zweite Anlauf sendet nicht");
  eq(e.status, K.STATUS.gesendet, "der zweite Anlauf bestaetigt den Versand nicht");
}

/* ══ 4. Entwurf weg, Versand offen: NICHT noch einmal senden ═════════════ */
{
  const { q, uhr, gmail, lies, speicher, setze } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  // Zustand nachstellen: Stufe 1 gelaufen, Entwurf bei Gmail bereits gesendet
  // (also weg), unser Eintrag weiss noch nichts davon.
  const e0 = await lies(eintrag.id);
  const entwurf = await gmailSendeVorbei(gmail);
  setze("mail/outbox/" + eintrag.id, Object.assign({}, e0, {
    status: K.STATUS.sendet, claim: { lauf: "tot", seit: T0 },
    draftId: entwurf.draftId, draftMessageId: entwurf.messageId }));
  uhr.vor(K.CLAIM_TIMEOUT_MS + 1000);
  const vorher = gmail.sendCount;
  await q.lauf("aufraeumer");
  const e = await lies(eintrag.id);
  eq(gmail.sendCount, vorher, "der verwaiste Eintrag wurde ein zweites Mal gesendet");
  eq(e.status, K.STATUS.gesendet, "der bereits gesendete Stand wurde nicht nachgezogen");
  ok(e.gmailMessageId, "die Nachrichten-Id fehlt nach dem Nachziehen");
}

async function gmailSendeVorbei(zustand) {
  // Ein Entwurf, der ausserhalb unserer Warteschlange gesendet wurde.
  const draftId = "draft_extern";
  const messageId = "dmsg_extern";
  zustand.messages.set(messageId, { id: messageId, threadId: "thr_1", labelIds: ["SENT"] });
  return { draftId, messageId };
}

/* ══ 5. Ohne SENT keine Erfolgsmeldung ═══════════════════════════════════ */
{
  const { q, uhr, gmail, lies } = umgebung({ ohneLabelInAntwort: true });
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  await q.lauf("l");
  const e = await lies(eintrag.id);
  // Die Antwort trug kein Label — der Lauf fragt nach und bekommt SENT.
  eq(e.status, K.STATUS.gesendet, "die Nachfrage nach dem Label fehlt");
  ok(gmail.aufrufe.some((a) => /GET \/users\/me\/messages\//.test(a)),
    "es wurde nicht bei Gmail nachgefragt, ob die Mail wirklich gesendet ist");
}

/* ══ 6. Abbrechen und Bearbeiten ═════════════════════════════════════════ */
{
  const { q, uhr, gmail, lies } = umgebung();
  const a = (await q.plane(MAIL)).eintrag;
  const b = (await q.plane(Object.assign({}, MAIL, { subject: "Zweite" }))).eintrag;

  uhr.vor(STUNDE);
  const geaendert = await q.aendere(a.id, { subject: "Anders", raw: "bmV1", zeitpunkt: T0 + 6 * STUNDE });
  ok(geaendert.ok, "die geplante Mail liess sich nicht bearbeiten");
  eq(K.zeigeZeit(geaendert.eintrag.sendAt), "13.09.2026, 15:00", "die neue Zeit wurde nicht uebernommen");

  const abgebrochen = await q.brichAb(b.id);
  ok(abgebrochen.ok, "der Abbruch scheiterte");

  uhr.vor(3 * STUNDE);   // 13:00 — a ist auf 15:00 verschoben, b abgebrochen
  await q.lauf("l");
  eq(gmail.sendCount, 0, "trotz Verschiebung und Abbruch ging etwas raus");
  eq((await lies(b.id)).status, K.STATUS.abgebrochen, "die abgebrochene Mail wurde wiederbelebt");

  uhr.vor(2 * STUNDE);   // 15:00
  await q.lauf("l2");
  eq(gmail.sendCount, 1, "die verschobene Mail ging zu ihrer neuen Zeit nicht raus");
  eq((await lies(a.id)).status, K.STATUS.gesendet, "die verschobene Mail gilt nicht als gesendet");
}

/* ══ 7. „Jetzt senden" ════════════════════════════════════════════════════ */
{
  const { q, uhr, gmail, lies } = umgebung();
  const e = (await q.plane(MAIL)).eintrag;
  uhr.vor(5 * 60 * 1000);
  await q.sofort(e.id);
  await q.lauf("l");
  eq(gmail.sendCount, 1, "„Jetzt senden“ sendet nicht");
  eq((await lies(e.id)).status, K.STATUS.gesendet, "„Jetzt senden“ bestaetigt den Versand nicht");
}

/* ══ 8. Der Eingangsthread bleibt unberuehrt ═════════════════════════════ */
{
  const { q, uhr, gmail } = umgebung();
  await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  await q.lauf("l");
  ok(!gmail.aufrufe.some((a) => /threads\/.+\/modify|messages\/.+\/modify|batchModify/.test(a)),
    "der Lauf fasst Threads oder Labels an — der Posteingang gehoert ihm nicht");
  ok(!gmail.aufrufe.some((a) => /messages\/send/.test(a)),
    "es wurde eine Mail an der Warteschlange vorbei gesendet");
}

console.log(`mail versandlauf (Server): ok (${checks} Pruefungen)`);
