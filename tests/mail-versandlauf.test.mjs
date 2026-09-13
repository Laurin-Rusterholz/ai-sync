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
function msgIdAusRaw(raw) {
  const mime = Buffer.from(String(raw || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const m = /^message-id:\s*<([^>]+)>/im.exec(mime);
  return m ? m[1] : null;
}

function gmailDoppel(optionen = {}) {
  const zustand = { drafts: new Map(), messages: new Map(), aufrufe: [], sendCount: 0, fehler: null,
    /* Barrieren: genau steuerbar, was WANN schiefgeht. `nachSenden` laeuft,
       NACHDEM Gmail die Mail tatsaechlich verschickt hat — so laesst sich die
       verlorene Antwort nachstellen, ohne zu raten. */
    nachSenden: null, verlierMessageId: false };
  let n = 0;
  async function gmail(method, pfad, opt = {}) {
    zustand.aufrufe.push(method + " " + pfad);
    if (zustand.fehler) { const f = zustand.fehler; zustand.fehler = null; throw f; }
    if (method === "POST" && pfad === "/users/me/drafts") {
      const draftId = "draft_" + (++n);
      const msgId = "dmsg_" + n;
      const raw = (opt.body.message || {}).raw;
      zustand.drafts.set(draftId, { id: draftId, rfc822: msgIdAusRaw(raw),
        message: { id: msgId, threadId: (opt.body.message || {}).threadId || "thr_" + n, labelIds: ["DRAFT"] } });
      return zustand.drafts.get(draftId);
    }
    if (method === "GET" && pfad === "/users/me/messages") {
      // users.messages.list mit q=rfc822msgid:<id> (Discovery: Parameter q)
      const q = String((opt.query || {}).q || "");
      const treffer = /rfc822msgid:(\S+)/.exec(q);
      if (!treffer) return { messages: [] };
      const gesucht = treffer[1];
      const ids = [];
      zustand.messages.forEach((m, k) => { if (m.rfc822 === gesucht) ids.push({ id: k }); });
      return { messages: ids };
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
      /* Wie bei Gmail: der Entwurf ist weg, und die gesendete Nachricht hat
         eine NEUE Id — die alte message.id des Entwurfs fuehrt ins Leere.
         Genau das war die falsche Annahme der ersten Fassung. */
      const m = { id: "msg_" + zustand.sendCount, threadId: d.message.threadId,
        labelIds: optionen.ohneLabelInAntwort ? [] : ["SENT"] };
      zustand.messages.set(m.id, { id: m.id, threadId: m.threadId, labelIds: ["SENT"],
        rfc822: zustand.verlierMessageId ? "von-gmail-ersetzt" : d.rfc822 });
      if (zustand.nachSenden) { const f = zustand.nachSenden; zustand.nachSenden = null; throw f; }
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
  const haken = { vorSchreiben: null };
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
    /* Wie die echte RTDB: auch eine LEERE Stelle hat eine Kennung
       (null_etag). Nur damit ist „anlegen, wenn nichts da ist" atomar. */
    dbGetEtag: async (p) => ({ value: speicher.get(p) || null, etag: kennungen.get(p) || "leer" }),
    dbSet: async (p, v, opt = {}) => {
      /* Deterministische Barriere: Wer hier einhaengt, entscheidet genau, was
         ZWISCHEN Lesen und Schreiben passiert — kein Timing, kein Zufall. */
      if (haken.vorSchreiben) await haken.vorSchreiben(p, v, opt);
      const aktuelleKennung = kennungen.get(p) || "leer";   // leere Stelle: wie RTDBs null_etag
      if (opt.ifMatch && aktuelleKennung !== opt.ifMatch) return { ok: false, conflict: true };
      setze(p, v);
      return { ok: true, conflict: false };
    },
    dbRemove: async (p) => { speicher.delete(p); },
    gmail, jetzt: uhr.jetzt, neueId: (() => { let i = 0; return () => "out_" + (++i); })(),
  });
  const lies = async (id) => speicher.get("mail/outbox/" + id);
  return { q, uhr, gmail: zustand, lies, speicher, setze, haken };
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

/* ══ 4. Entwurf weg, Versand offen: NICHT noch einmal senden ═════════════
   Wiedergefunden wird die Nachricht ueber UNSERE Message-ID (rfc822msgid:),
   nicht ueber die message.id des Entwurfs: die ist nach dem Senden eine
   andere. Genau daran waere die erste Fassung gescheitert. */
{
  const { q, uhr, gmail, lies, setze } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  ok(eintrag.messageIdKopf, "die Planung vergibt keine eigene Message-ID");
  uhr.vor(3 * STUNDE);
  // Zustand nachstellen: Versand war angestossen, der Entwurf ist bei Gmail
  // weg, die Nachricht liegt mit UNSERER Message-ID im Postausgang.
  const e0 = await lies(eintrag.id);
  gmail.messages.set("msg_extern", { id: "msg_extern", threadId: "thr_1",
    labelIds: ["SENT"], rfc822: e0.messageIdKopf });
  setze("mail/outbox/" + eintrag.id, Object.assign({}, e0, {
    status: K.STATUS.sendet, stufe: K.STUFE.senden, claim: { lauf: "tot", seit: T0 },
    draftId: "draft_weg" }));
  uhr.vor(K.CLAIM_TIMEOUT_MS + 1000);
  const vorher = gmail.sendCount;
  await q.lauf("aufraeumer");
  const e = await lies(eintrag.id);
  eq(gmail.sendCount, vorher, "der verwaiste Eintrag wurde ein zweites Mal gesendet");
  eq(e.status, K.STATUS.gesendet, "der bereits gesendete Stand wurde nicht nachgezogen");
  eq(e.gmailMessageId, "msg_extern", "es wurde die falsche Nachricht als die gesendete vermerkt");
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

/* ══ 9. Die Antwort geht verloren, NACHDEM Gmail gesendet hat ═════════════
   Das ist der Fall, an dem die erste Fassung eine zweite Mail erzeugt haette:
   drafts/send hat gewirkt, die Antwort kam nie an, der Eintrag trug keinen
   Vermerk. Jetzt steht die Stufe „senden" VOR dem Aufruf im Speicher, und die
   eigene Message-ID fuehrt zur wirklich gesendeten Nachricht. */
{
  const { q, uhr, gmail, lies } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  gmail.nachSenden = Object.assign(new Error("Verbindung abgebrochen"), { status: 502 });
  await q.lauf("l1");
  eq(gmail.sendCount, 1, "die Mail ging gar nicht raus");
  let e = await lies(eintrag.id);
  eq(e.status, K.STATUS.gesendet, "der verlorene Erfolg wurde nicht wiedergefunden");
  ok(e.gmailMessageId && e.gmailMessageId !== "dmsg_1",
    "es wurde die alte Entwurfs-Nachricht als gesendete vermerkt");

  // Und kein spaeterer Lauf legt nach.
  uhr.vor(2 * STUNDE);
  await q.lauf("l2"); await q.lauf("l3");
  eq(gmail.sendCount, 1, `nach dem verlorenen Erfolg wurden ${gmail.sendCount} Mails gesendet`);
}

/* ══ 10. Ungeklaert heisst ungeklaert — und wird nie wiederholt ═══════════
   Wenn Gmail unsere Message-ID nicht behaelt UND der Entwurf weg ist, laesst
   sich der Ausgang nicht feststellen. Dann wird NICHT gesendet, sondern
   gefragt. Geklaert wird ausschliesslich durch einen Menschen. */
{
  const { q, uhr, gmail, lies } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  gmail.verlierMessageId = true;
  gmail.nachSenden = Object.assign(new Error("Verbindung abgebrochen"), { status: 502 });
  await q.lauf("l1");
  eq(gmail.sendCount, 1, "die Mail ging gar nicht raus");
  let e = await lies(eintrag.id);
  eq(e.status, K.STATUS.unklar, "ein ungeklaerter Ausgang wurde als etwas anderes verbucht");
  ok(/ungeklärt|nicht feststellen|nicht beantwortet/i.test(e.letzterFehler || ""),
    "der ungeklaerte Zustand wird nicht benannt");
  eq(K.zeile(e, uhr.jetzt()).status, "Ungeklärt", "die Zeile sagt nicht, dass es ungeklaert ist");

  for (const l of ["l2", "l3", "l4", "l5", "l6"]) { uhr.vor(STUNDE); await q.lauf(l); }
  eq(gmail.sendCount, 1, `der ungeklaerte Eintrag wurde ${gmail.sendCount - 1}-mal wiederholt`);
  eq((await lies(eintrag.id)).status, K.STATUS.unklar, "der ungeklaerte Eintrag wurde still weiterbewegt");

  // Auch aendern und abbrechen sind hier gesperrt: niemand darf „nicht
  // gesendet" behaupten, solange das keiner weiss.
  ok(!(await q.aendere(eintrag.id, { subject: "X" })).ok, "ein ungeklaerter Versand liess sich bearbeiten");
  ok(!(await q.brichAb(eintrag.id)).ok, "ein ungeklaerter Versand liess sich abbrechen");

  // Der Mensch hat nachgesehen: sie ist raus.
  const geklaert = await q.klaereGesendet(eintrag.id);
  ok(geklaert.ok, "die Klaerung durch den Menschen wurde abgewiesen");
  e = await lies(eintrag.id);
  eq(e.status, K.STATUS.gesendet, "nach der Klaerung steht der Eintrag nicht auf gesendet");
  eq(e.geklaertDurch, "nutzer", "die Klaerung ist nicht als menschliche Entscheidung vermerkt");
  eq(gmail.sendCount, 1, "die Klaerung hat selbst gesendet");
}

/* ══ 11. Der andere Weg der Klaerung: doch nicht gesendet ════════════════ */
{
  const { q, uhr, gmail, lies } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  gmail.verlierMessageId = true;
  gmail.nachSenden = Object.assign(new Error("Zeitüberschreitung"), { status: 504 });
  await q.lauf("l1");
  eq((await lies(eintrag.id)).status, K.STATUS.unklar, "der Zustand ist nicht ungeklaert");

  const klar = await q.klaereNichtGesendet(eintrag.id);
  ok(klar.ok, "die Klaerung „nicht gesendet“ wurde abgewiesen");
  const e = await lies(eintrag.id);
  eq(e.status, K.STATUS.geplant, "nach der Klaerung ist der Eintrag nicht wieder geplant");
  eq(e.draftId, null, "der alte Entwurf blieb haengen — der naechste Lauf wuerde ihn senden");
  eq(e.stufe, K.STUFE.neu, "die alte Stufe blieb stehen");

  await q.lauf("l2");
  eq(gmail.sendCount, 2, "nach der ausdruecklichen Freigabe wurde nicht erneut gesendet");
  eq((await lies(eintrag.id)).status, K.STATUS.gesendet, "der zweite Versand wurde nicht bestaetigt");
}

/* ══ 12. Absturz zwischen Entwurf und Vermerk ════════════════════════════
   Der Entwurf entsteht, der Vermerk geht verloren. Das darf hoechstens einen
   verwaisten Entwurf kosten — niemals eine zweite Mail. */
{
  const { q, uhr, gmail, lies, speicher, setze, haken } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  let gestoert = false;
  haken.vorSchreiben = async (pf, wert) => {
    if (!gestoert && wert && wert.draftId) {      // genau der Vermerk „Entwurf steht"
      gestoert = true;
      setze(pf, speicher.get(pf));                // fremde Kennung ⇒ der Vermerk scheitert
    }
  };
  await q.lauf("abgestuerzt");
  haken.vorSchreiben = null;
  eq(gmail.sendCount, 0, "trotz verlorenem Vermerk wurde gesendet");
  let e = await lies(eintrag.id);
  eq(e.stufe, K.STUFE.entwurf, "die Stufe „Entwurf unterwegs“ wurde nicht festgehalten");
  ok(!e.draftId, "der Entwurf gilt als vermerkt, obwohl der Vermerk scheiterte");

  uhr.vor(K.CLAIM_TIMEOUT_MS + 1000);
  await q.lauf("zweiter");
  e = await lies(eintrag.id);
  eq(gmail.sendCount, 1, `nach dem verlorenen Vermerk gingen ${gmail.sendCount} Mails raus`);
  eq(e.status, K.STATUS.gesendet, "der zweite Lauf bestaetigt den Versand nicht");
}

/* ══ 13. Abbrechen im Wettlauf mit dem Lauf ══════════════════════════════
   Zwischen Lesen und Schreiben uebernimmt der Lauf den Eintrag. Der Abbruch
   darf dann NICHT Erfolg melden — sonst steht „abgebrochen" ueber einer Mail,
   die gerade hinausgeht. */
{
  const { q, uhr, gmail, lies, haken } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  let einmal = false;
  haken.vorSchreiben = async (pf, wert) => {
    if (!einmal && wert && wert.status === K.STATUS.abgebrochen) {
      einmal = true;
      haken.vorSchreiben = null;
      await q.lauf("worker");        // genau jetzt uebernimmt der Lauf und sendet
    }
  };
  const abbruch = await q.brichAb(eintrag.id);
  haken.vorSchreiben = null;
  eq(abbruch.ok, false, "der Abbruch meldete Erfolg, obwohl der Lauf bereits sandte");
  ok(/gesendet|Versand|ungeklärt/i.test(abbruch.grund || ""), "der Grund nennt den laufenden Versand nicht");
  eq(gmail.sendCount, 1, "der Lauf kam gar nicht zum Zug");
  eq((await lies(eintrag.id)).status, K.STATUS.gesendet, "der Abbruch hat den Versand ueberschrieben");
}

/* ══ 14. Der Zaun: ein fremd gewordener Lauf schreibt nicht mehr ═════════
   Ausnahme mit Ansage: einen BESTAETIGTEN Versand haelt er trotzdem fest —
   ginge diese Auskunft verloren, sendete ein spaeterer Lauf noch einmal. */
{
  const { q, uhr, lies, setze } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  const e0 = await lies(eintrag.id);
  setze("mail/outbox/" + eintrag.id, Object.assign({}, e0, {
    status: K.STATUS.sendet, claim: { lauf: "jemand-anders", seit: T0 } }));
  const zaun = q._zaunFuer(eintrag.id, "ich");
  let abgewiesen = false;
  try { await zaun.schreibe(Object.assign({}, e0, { subject: "geklaut" })); }
  catch (err) { abgewiesen = !!(err && err.fremdgriff); }
  ok(abgewiesen, "ein fremd gewordener Lauf durfte schreiben");
  eq((await lies(eintrag.id)).claim.lauf, "jemand-anders", "der fremde Zugriff wurde ueberschrieben");

  /* Der bestaetigte Versand wird trotzdem festgehalten — aber NICHT aus einem
     alten Abzug heraus: gerechnet wird auf dem gespeicherten Stand. */
  await zaun.festhaltenGesendet({ id: "msg_x", threadId: "thr_1", labelIds: ["SENT"] });
  const danach = await lies(eintrag.id);
  eq(danach.status, K.STATUS.gesendet, "der bestaetigte Versand wurde nicht festgehalten");
  eq(danach.gmailMessageId, "msg_x", "die bestaetigte Nachricht wurde nicht vermerkt");
  eq(danach.claim, null, "der fremde Zugriff blieb stehen");
}

/* ══ 15. Datenbank faellt AUS, nachdem Gmail bestaetigt hat ══════════════
   Unabhaengiger Repro (Laurin, 13.09.2026): drafts/send liefert SENT zurueck,
   und genau beim Schreiben von „gesendet" faellt die Ablage EINMAL aus. Der
   aeussere Fehlerzweig schrieb daraufhin den Stand VOR dem Versand zurueck —
   ohne Stufe, ohne draftId — und der naechste Lauf sandte ein zweites Mal.
   Hier wird genau das gemessen: ein einmaliger Schreibfehler nach SENT. */
{
  const { q, uhr, gmail, lies, haken } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  uhr.vor(3 * STUNDE);
  let gestoert = false;
  haken.vorSchreiben = async (pf, wert) => {
    if (!gestoert && wert && wert.status === K.STATUS.gesendet) {
      gestoert = true;
      throw new Error("Temporary database failure");
    }
  };
  await q.lauf("l1");
  haken.vorSchreiben = null;
  eq(gmail.sendCount, 1, "die Mail ging beim ersten Lauf gar nicht raus");
  ok(gestoert, "der Schreibfehler nach SENT ist gar nicht eingetreten — der Test misst nichts");

  let e = await lies(eintrag.id);
  ok(e.status !== K.STATUS.geplant,
    "nach bestaetigtem Versand wurde der Eintrag wieder auf „geplant“ zurueckgestuft — der naechste Lauf sendet erneut");
  ok(e.status === K.STATUS.unklar || e.status === K.STATUS.gesendet,
    "der Eintrag steht nach dem Schreibfehler weder auf gesendet noch auf ungeklaert, sondern auf " + e.status);
  ok(e.stufe === K.STUFE.senden || e.status === K.STATUS.gesendet,
    "die Stufe „senden“ wurde vom Fehlerzweig ueberschrieben");
  ok(e.draftId || e.status === K.STATUS.gesendet, "die draftId wurde vom Fehlerzweig geloescht");

  // Und jetzt die eigentliche Frage: sendet irgendein spaeterer Lauf nach?
  for (const l of ["l2", "l3", "l4"]) { uhr.vor(24 * STUNDE); await q.lauf(l); }
  eq(gmail.sendCount, 1, `nach dem Schreibfehler wurden insgesamt ${gmail.sendCount} Mails gesendet`);

  // Ein ungeklaerter Fall bleibt ungeklaert, bis ein Mensch entscheidet.
  e = await lies(eintrag.id);
  if (e.status === K.STATUS.unklar) {
    ok(!(await q.brichAb(eintrag.id)).ok, "der ungeklaerte Eintrag liess sich abbrechen");
    const geklaert = await q.klaereGesendet(eintrag.id);
    ok(geklaert.ok, "die menschliche Klaerung wurde abgewiesen");
    eq((await lies(eintrag.id)).status, K.STATUS.gesendet, "nach der Klaerung steht der Eintrag nicht auf gesendet");
  }
  eq(gmail.sendCount, 1, "die Klaerung hat selbst gesendet");
}

/* ══ 16. Ein Notschreibgang stuft nichts zurueck ═════════════════════════
   Auch der letzte Ausweg darf ein gespeichertes „gesendet" nicht ueberschreiben. */
{
  const { q, uhr, lies, setze } = umgebung();
  const { eintrag } = await q.plane(MAIL);
  const e0 = await lies(eintrag.id);
  setze("mail/outbox/" + eintrag.id, Object.assign({}, e0, {
    status: K.STATUS.gesendet, gmailMessageId: "msg_fertig", sentAt: uhr.jetzt(),
    claim: { lauf: "ich", seit: uhr.jetzt() } }));
  const zaun = q._zaunFuer(eintrag.id, "ich");
  zaun.angestossen = true;
  await zaun.festhaltenUnklar("angeblich ungeklaert");
  eq((await lies(eintrag.id)).status, K.STATUS.gesendet, "ein gespeichertes „gesendet“ wurde zu „unklar“ zurueckgestuft");
  await zaun.festhaltenFehler(new Error("angeblicher Fehler"));
  eq((await lies(eintrag.id)).status, K.STATUS.gesendet, "ein gespeichertes „gesendet“ wurde vom Fehlerzweig ueberschrieben");
}

/* ══ 17. Planen ist wiederholbar ═════════════════════════════════════════
   Repro: Die Antwort auf „plane" geht verloren, jemand klickt noch einmal.
   Mit stabilem Anfrageschluessel entsteht KEIN zweiter Eintrag — und der
   bestehende wird auch nicht mit der neuen Nutzlast ueberschrieben. */
{
  const { q, uhr, gmail, lies, speicher } = umgebung();
  const schluessel = "abcdefgh12345678";
  const erst = await q.plane(Object.assign({}, MAIL, { anfrageSchluessel: schluessel }));
  ok(erst.ok, "die erste Planung scheiterte");
  ok(!erst.bestand, "die erste Planung galt schon als Bestand");

  const zweit = await q.plane(Object.assign({}, MAIL, { anfrageSchluessel: schluessel,
    subject: "Versehentlich anders", raw: "YW5kZXJz" }));
  ok(zweit.ok, "die Wiederholung scheiterte");
  eq(zweit.bestand, true, "die Wiederholung gilt nicht als Bestand");
  eq(zweit.eintrag.id, erst.eintrag.id, "die Wiederholung legte einen ZWEITEN Eintrag an");
  eq(zweit.eintrag.subject, MAIL.subject, "die Wiederholung hat die bestehende Nutzlast ueberschrieben");
  eq(zweit.eintrag.raw, erst.eintrag.raw, "die Wiederholung hat die Nachricht ueberschrieben");

  let anzahl = 0;
  speicher.forEach((v, k) => { if (k.startsWith("mail/outbox/")) anzahl++; });
  eq(anzahl, 1, `nach der Wiederholung liegen ${anzahl} Eintraege im Ausgang`);

  uhr.vor(3 * STUNDE);
  await q.lauf("l");
  eq(gmail.sendCount, 1, "aus der wiederholten Planung wurden zwei Mails");

  // Ohne Schluessel bleibt es beim alten Verhalten: jeder Aufruf ein Eintrag.
  const ohne1 = await q.plane(MAIL);
  const ohne2 = await q.plane(MAIL);
  ok(ohne1.eintrag.id !== ohne2.eintrag.id, "ohne Schluessel landen zwei Planungen auf derselben Stelle");
  // Ein unbrauchbarer Schluessel wird nicht zur Ablagestelle.
  const krumm = await q.plane(Object.assign({}, MAIL, { anfrageSchluessel: "../boese" }));
  ok(krumm.ok && !/boese/.test(krumm.eintrag.id), "ein krummer Schluessel wurde zur Ablagestelle");
}

console.log(`mail versandlauf (Server): ok (${checks} Pruefungen)`);
