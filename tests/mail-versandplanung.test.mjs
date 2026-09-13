/*
 * Geplanter Mailversand — der Kern, gegen eine gestellte Uhr.
 * ---------------------------------------------------------------------------
 * AUFTRAG (13.09.2026): Ausgehende Mails gehen standardmaessig erst in drei
 * Stunden raus und bleiben bis dahin in Quantus sichtbar, aenderbar und
 * abbrechbar; auf Wunsch sofort oder zu einer anderen Zeit.
 *
 * WAS GOOGLE HERGIBT — nachgeschlagen im offiziellen Discovery-Dokument
 * (https://gmail.googleapis.com/$discovery/rest?version=v1, Revision 20260907):
 * users.messages.send nimmt ausser userId nur eine Message (payload, raw,
 * threadId, labelIds …); users.drafts.send nimmt einen Draft. In allen 79
 * Methoden und allen Schemata kommt "schedul"/"sendAt"/"sendLater"/
 * "deliveryTime" NULL Mal vor, und die Labelliste kennt kein SCHEDULED.
 * Die Gmail-API kann also NICHT planen — die Planung ist unsere, Gmail ist
 * Versandkanal und die Quelle fuer den bestaetigten Versand.
 *
 * Diese Tests fahren den ECHTEN Kern (public/mail-queue-core.js) gegen eine
 * gestellte Uhr und einen Gmail-Doppel. Es geht KEINE Mail nach draussen, es
 * wird kein Entwurf angelegt, keine Adresse benutzt, die es gibt.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const K = (await import(path.join(root, "public/mail-queue-core.js"))).default;

let checks = 0;
const ok = (b, t) => { assert.ok(b, t); checks++; };
const eq = (a, b, t) => { assert.equal(a, b, t); checks++; };

// Eine gestellte Uhr. Nichts in diesem Test wartet auf echte Zeit.
const UHR = (start) => { let t = start; return { jetzt: () => t, vor: (ms) => { t += ms; return t; } }; };
const T0 = Date.parse("2026-09-13T09:00:00+02:00");      // 09:00 Zuerich
const STUNDE = 60 * 60 * 1000;

const bauen = (uhr, extra = {}) => K.neuerEintrag(Object.assign({
  id: "out_1", raw: "cmF3LWJlaXNwaWVs", to: "beispiel@example.com",
  subject: "Beispielbetreff", vorschau: "Kurzer Beispieltext", threadId: "thr_1",
  jetzt: uhr.jetzt(),
}, extra)).eintrag;

/* ══ 1. Standard: drei Stunden, sichtbar in Zuercher Zeit ═════════════════ */
{
  const uhr = UHR(T0);
  const e = bauen(uhr);
  eq(e.status, K.STATUS.geplant, "eine neue Mail ist nicht „geplant“");
  eq(e.sendAt - T0, 3 * STUNDE, "die Standardverzoegerung sind nicht drei Stunden");
  eq(K.zeigeZeit(e.sendAt), "13.09.2026, 12:00", `die Zuercher Zeit stimmt nicht: ${K.zeigeZeit(e.sendAt)}`);
  const z = K.zeile(e, uhr.jetzt());
  eq(z.status, "Geplant", "die Zeile sagt nicht „Geplant“");
  eq(z.richtung, "ausgehend", "die Zeile ist nicht als ausgehend markiert");
  ok(/12:00/.test(z.text) && /Europe\/Zurich/.test(z.text), `die Zeile nennt Zeit und Zone nicht: ${z.text}`);
  ok(!K.istFaellig(e, uhr.jetzt()), "eine frisch geplante Mail gilt sofort als faellig");
}

/* ══ 2. Zeitzonen und Sommerzeit: gerechnet wird in Millisekunden ═════════ */
{
  // Ein Geraet in Tokio plant um 16:00 Ortszeit (= 09:00 Zuerich).
  const tokio = Date.parse("2026-09-13T16:00:00+09:00");
  eq(tokio, T0, "Vorbedingung: dieselbe Sekunde in zwei Zeitzonen");
  const e = K.neuerEintrag({ id: "o2", raw: "cmF3", to: "a@example.com", jetzt: tokio }).eintrag;
  eq(K.zeigeZeit(e.sendAt), "13.09.2026, 12:00", "die Anzeige folgt dem Geraet statt Zuerich");
  // Ueber die Zeitumstellung hinweg (26.10.2026, 03:00 → 02:00 MEZ):
  const vorUmstellung = Date.parse("2026-10-25T01:30:00+02:00");   // 01:30 Sommerzeit
  const e2 = K.neuerEintrag({ id: "o3", raw: "cmF3", to: "a@example.com", jetzt: vorUmstellung }).eintrag;
  eq(e2.sendAt - vorUmstellung, 3 * STUNDE, "die Verzoegerung verrutscht bei der Zeitumstellung");
  eq(K.zeigeZeit(e2.sendAt), "25.10.2026, 03:30",
    `nach der Umstellung zeigt Quantus die falsche Uhrzeit: ${K.zeigeZeit(e2.sendAt)}`);
}

/* ══ 3. Faellig wird sie erst zur Zeit — kein Fruehversand ════════════════ */
{
  const uhr = UHR(T0);
  const e = bauen(uhr);
  uhr.vor(3 * STUNDE - 1000);
  ok(!K.istFaellig(e, uhr.jetzt()), "eine Sekunde zu frueh gilt schon als faellig");
  uhr.vor(1000);
  ok(K.istFaellig(e, uhr.jetzt()), "zur geplanten Zeit ist sie nicht faellig");
  eq(K.faellige([e], uhr.jetzt()).length, 1, "die Liste der faelligen Mails ist leer");
}

/* ══ 4. Aendern, verschieben, sofort senden, abbrechen ════════════════════ */
{
  const uhr = UHR(T0);
  let e = bauen(uhr);
  uhr.vor(30 * 60 * 1000);
  const g = K.aendere(e, { raw: "bmV1ZXItdGV4dA", subject: "Neuer Betreff" }, uhr.jetzt());
  ok(g.ok, "eine geplante Mail laesst sich nicht mehr bearbeiten");
  eq(g.eintrag.subject, "Neuer Betreff", "der neue Betreff kommt nicht an");
  eq(g.eintrag.sendAt, e.sendAt, "das Bearbeiten verschiebt heimlich die Versandzeit");

  const spaeter = K.aendere(g.eintrag, { zeitpunkt: T0 + 8 * STUNDE }, uhr.jetzt());
  eq(K.zeigeZeit(spaeter.eintrag.sendAt), "13.09.2026, 17:00", "die gewaehlte Zeit wird nicht uebernommen");

  const jetzt = K.sofort(spaeter.eintrag, uhr.jetzt());
  eq(jetzt.eintrag.sendAt, uhr.jetzt(), "„Jetzt senden“ plant nicht auf sofort");
  ok(K.istFaellig(jetzt.eintrag, uhr.jetzt()), "„Jetzt senden“ macht die Mail nicht faellig");

  const ab = K.brichAb(jetzt.eintrag, uhr.jetzt());
  eq(ab.eintrag.status, K.STATUS.abgebrochen, "der Abbruch greift nicht");
  ok(!K.istFaellig(ab.eintrag, uhr.jetzt() + 10 * STUNDE), "eine abgebrochene Mail wird spaeter doch gesendet");
  ok(!K.aendere(ab.eintrag, { subject: "x" }, uhr.jetzt()).ok, "eine abgebrochene Mail laesst sich bearbeiten");
}

/* ══ 5. Vergangene Zeit ist kein Rueckdatieren ════════════════════════════ */
{
  const uhr = UHR(T0);
  const e = K.neuerEintrag({ id: "o4", raw: "cmF3", to: "a@example.com",
    jetzt: uhr.jetzt(), zeitpunkt: T0 - 5 * STUNDE }).eintrag;
  eq(e.sendAt, T0, "eine Zeit in der Vergangenheit wird uebernommen statt auf jetzt gesetzt");
}

/* ══ 6. Der Serverlauf: uebernehmen, senden, bestaetigen ══════════════════ */
{
  const uhr = UHR(T0);
  let e = bauen(uhr);
  uhr.vor(3 * STUNDE);

  const u = K.uebernimm(e, uhr.jetzt(), "lauf-1");
  ok(u.ok && u.eintrag.status === K.STATUS.sendet, "der Lauf kann die Mail nicht uebernehmen");
  e = u.eintrag;

  // Ein zweiter Lauf zur selben Zeit sieht sie NICHT mehr — kein Doppelversand.
  ok(!K.istFaellig(e, uhr.jetzt()), "ein zweiter Lauf greift dieselbe Mail ab");
  ok(!K.uebernimm(e, uhr.jetzt(), "lauf-2").ok, "ein zweiter Lauf uebernimmt sie trotzdem");

  // Waehrend des Versands ist sie tabu.
  ok(!K.aendere(e, { subject: "zu spaet" }, uhr.jetzt()).ok, "waehrend des Versands laesst sie sich aendern");
  ok(!K.brichAb(e, uhr.jetzt()).ok, "waehrend des Versands laesst sie sich abbrechen");

  // Stufe 1: Entwurf. Stufe 2: senden — erst SENT gilt.
  e = K.merkeEntwurf(e, "draft_abc", uhr.jetzt());
  eq(e.draftId, "draft_abc", "die Entwurfs-Id wird nicht gemerkt");
  const ohneLabel = K.markiereGesendet(e, { id: "msg_1", threadId: "thr_1", labelIds: ["INBOX"] }, uhr.jetzt());
  ok(!ohneLabel.ok, "ohne SENT gilt die Mail schon als gesendet");
  const mit = K.markiereGesendet(e, { id: "msg_1", threadId: "thr_1", labelIds: ["SENT"] }, uhr.jetzt());
  ok(mit.ok, "mit SENT gilt sie nicht als gesendet");
  e = mit.eintrag;
  eq(e.status, K.STATUS.gesendet, "der Status steht nach der Bestaetigung nicht auf gesendet");
  eq(e.gmailMessageId, "msg_1", "die Gmail-Id wird nicht festgehalten");
  ok(!K.istFaellig(e, uhr.jetzt() + 10 * STUNDE), "eine gesendete Mail wird noch einmal gesendet");
  ok(!K.aendere(e, { subject: "x" }, uhr.jetzt()).ok, "eine gesendete Mail laesst sich bearbeiten");
  ok(!K.brichAb(e, uhr.jetzt()).ok, "eine gesendete Mail laesst sich abbrechen");
  eq(K.zeile(e, uhr.jetzt()).status, "Gesendet", "die Zeile zeigt den gesendeten Stand nicht");
}

/* ══ 7. Verwaister Lauf: kein Haenger, kein Doppelversand ═════════════════ */
{
  const uhr = UHR(T0);
  let e = bauen(uhr);
  uhr.vor(3 * STUNDE);
  e = K.uebernimm(e, uhr.jetzt(), "lauf-abgestuerzt").eintrag;

  uhr.vor(K.CLAIM_TIMEOUT_MS - 1000);
  ok(!K.istFaellig(e, uhr.jetzt()), "ein laufender Versand wird zu frueh fuer verwaist gehalten");
  uhr.vor(2000);
  ok(K.istFaellig(e, uhr.jetzt()), "ein abgestuerzter Lauf haelt die Mail fuer immer fest");

  // Der zweite Lauf findet die Entwurfs-Id — daran haengt die Duplikatsperre.
  e = K.merkeEntwurf(e, "draft_abc", uhr.jetzt());
  ok(e.draftId && !e.gmailMessageId,
    "nach Stufe 1 muss die Entwurfs-Id da sein und die Nachrichten-Id fehlen");
  // Ist die Nachricht bereits draussen, wird nur nachgezogen — nicht neu gesendet.
  const nachgezogen = K.markiereGesendet(e, { id: "msg_7", labelIds: ["SENT"] }, uhr.jetzt());
  ok(nachgezogen.ok && nachgezogen.eintrag.status === K.STATUS.gesendet,
    "ein bereits gesendeter Entwurf laesst sich nicht nachziehen");
}

/* ══ 8. Fehlschlag: verschieben statt verwerfen ═══════════════════════════ */
{
  const uhr = UHR(T0);
  let e = bauen(uhr);
  uhr.vor(3 * STUNDE);
  e = K.uebernimm(e, uhr.jetzt(), "l1").eintrag;
  const f1 = K.markiereFehler(e, new Error("Gmail 503"), uhr.jetzt());
  eq(f1.eintrag.status, K.STATUS.geplant, "ein Fehlschlag verwirft die Mail");
  eq(f1.eintrag.versuche, 1, "der Versuch wird nicht gezaehlt");
  eq(f1.eintrag.sendAt, uhr.jetzt() + 60 * 1000, "der Rueckversuch kommt nicht nach einer Minute");
  ok(/503/.test(f1.eintrag.letzterFehler), "der Grund wird nicht festgehalten");
  ok(!K.istFaellig(f1.eintrag, uhr.jetzt()), "der Rueckversuch laeuft sofort wieder los");

  let e2 = f1.eintrag;
  for (let i = 2; i <= K.MAX_VERSUCHE; i++) {
    e2 = K.markiereFehler(K.uebernimm(Object.assign({}, e2, { sendAt: uhr.jetzt() }), uhr.jetzt(), "l" + i).eintrag,
      new Error("Gmail 503"), uhr.jetzt());
    e2 = e2.eintrag || e2;
  }
  eq(e2.status, K.STATUS.fehlgeschlagen, `nach ${K.MAX_VERSUCHE} Versuchen wird nicht aufgegeben`);
  ok(!K.istFaellig(e2, uhr.jetzt() + 10 * STUNDE), "eine aufgegebene Mail laeuft weiter");
  eq(K.zeile(e2, uhr.jetzt()).status, "Fehlgeschlagen", "die Zeile verschweigt den Fehlschlag");
  ok(K.zeile(e2, uhr.jetzt()).offen, "die fehlgeschlagene Mail verschwindet aus der Sicht");
  ok(K.aendere(e2, { zeitpunkt: uhr.jetzt() + STUNDE }, uhr.jetzt()).ok,
    "eine fehlgeschlagene Mail laesst sich nicht neu ansetzen");
}

/* ══ 9. Was die Planung NICHT tut ═════════════════════════════════════════ */
{
  const uhr = UHR(T0);
  const e = bauen(uhr);
  // Keine Mail an sich selbst, kein Posteingang: die Zeile ist ausgehend.
  eq(K.zeile(e, uhr.jetzt()).richtung, "ausgehend", "die geplante Mail gilt als eingehend");
  // Der Eingangsthread wird nicht angefasst: der Eintrag merkt ihn sich nur.
  eq(e.threadId, "thr_1", "der Thread geht verloren");
  ok(!("archiviert" in e) && !("labelIds" in e),
    "der Kern greift in Gmail-Labels ein — das ist nicht seine Aufgabe");
  // Ohne Empfaenger oder ohne Nachricht entsteht gar kein Eintrag.
  ok(!K.neuerEintrag({ id: "x", raw: "cmF3", to: "", jetzt: T0 }).ok, "ohne Empfaenger entsteht ein Eintrag");
  ok(!K.neuerEintrag({ id: "x", raw: "", to: "a@example.com", jetzt: T0 }).ok, "ohne Nachricht entsteht ein Eintrag");
}

/* ══ 10. Bearbeiten bis zum Versand — ohne Anhang zu verlieren ════════════
   Befund 13.09.2026 aus der Bedienung: Wer eine geplante Mail aendern will,
   braucht ihren KLARTEXT zurueck. Aus der fertigen MIME-Nachricht laesst er
   sich nicht verlustfrei zurueckholen, und ein Anhang steckt ueberhaupt nur
   dort. Der Eintrag traegt deshalb Klartext, Anhangsmerkmal und die
   Antwort-Kopfzeilen bei sich — sonst landete die geaenderte Antwort in einem
   neuen Thread oder der Anhang verschwaende stillschweigend. */
{
  const uhr = UHR(T0);
  const e = bauen(uhr, {
    koerper: "Guten Tag\n\nAnbei wie besprochen.", hatAnhaenge: true,
    inReplyTo: "<nachricht-1@example.com>",
    references: "<nachricht-0@example.com> <nachricht-1@example.com>",
  });
  eq(e.koerper, "Guten Tag\n\nAnbei wie besprochen.", "der Klartext fehlt — Bearbeiten waere Raten");
  eq(e.hatAnhaenge, true, "der Anhang ist nicht vermerkt");
  eq(e.inReplyTo, "<nachricht-1@example.com>", "die Antwort-Kopfzeile geht verloren");
  ok(/nachricht-0/.test(e.references), "die Referenzkette geht verloren");

  // Aendern ersetzt Text UND Klartext, laesst Thread und Kopfzeilen stehen.
  uhr.vor(30 * 60 * 1000);
  const g = K.aendere(e, { raw: "bmV1ZXItcm9odGV4dA", koerper: "Neuer Text", subject: "Neuer Betreff" }, uhr.jetzt());
  ok(g.ok, "eine geplante Mail laesst sich nicht mehr aendern");
  eq(g.eintrag.koerper, "Neuer Text", "der Klartext bleibt auf dem alten Stand");
  eq(g.eintrag.threadId, "thr_1", "der Thread geht beim Aendern verloren");
  eq(g.eintrag.inReplyTo, "<nachricht-1@example.com>", "die Antwort-Kopfzeile geht beim Aendern verloren");
  eq(g.eintrag.hatAnhaenge, true, "das Anhangsmerkmal geht beim Aendern verloren");
  eq(g.eintrag.sendAt, e.sendAt, "Aendern verschiebt den Zeitpunkt heimlich");
  eq(g.eintrag.entwurfVeraltet, undefined, "ohne angelegten Entwurf wird einer als veraltet vermerkt");

  // Mit bereits angelegtem Gmail-Entwurf: neuer Text ⇒ Entwurf ist veraltet.
  const mitEntwurf = K.merkeEntwurf(e, "dr_1", uhr.jetzt());
  const g2 = K.aendere(mitEntwurf, { raw: "bmV1", koerper: "Noch neuer" }, uhr.jetzt());
  eq(g2.eintrag.entwurfVeraltet, true, "der veraltete Gmail-Entwurf wird nicht erneuert");

  // Der Klartext wird begrenzt, damit ein Eintrag nicht unbegrenzt waechst.
  const lang = bauen(UHR(T0), { koerper: "x".repeat(30000) });
  eq(lang.koerper.length, 20000, "der Klartext wird nicht begrenzt");
}

console.log(`mail versandplanung (Kern): ok (${checks} Pruefungen)`);
