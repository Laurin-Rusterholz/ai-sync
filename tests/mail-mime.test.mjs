/*
 * Bearbeiten, ohne den Anhang zu verlieren.
 *
 * BEFUND (Durchsicht 13.09.2026): Die erste Fassung liess eine geplante Mail
 * MIT Anhang gar nicht erst bearbeiten — die Oberfläche sperrte den Knopf. Das
 * war ehrlich, aber es war nicht die Aufgabe: gefordert ist „änderbar bis zum
 * Versand" UND „Anhänge erhalten".
 *
 * Der Anhang steckt ausschliesslich in der fertigen MIME-Nachricht. Wer den
 * Text neu baut, wirft ihn weg. Deshalb wird hier NICHT neu gebaut, sondern
 * genau ein Teil ersetzt: der Körper — der erste Teil von multipart/mixed, so
 * wie Quantus die Nachricht baut (Körper, danach die Anhänge).
 *
 * Gemessen wird an einer echten Nachricht mit zwei Anhängen, Zeichen für
 * Zeichen: Bleiben die Anhangsdaten unberührt? Bleiben Empfänger und
 * Antwort-Kopfzeilen stehen? Und lehnt die Warteschlange einen Austausch der
 * GANZEN Nachricht ab, wenn dabei Anhänge verloren gingen?
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const M = (await import(path.join(root, "netlify/lib/mail-mime.mjs"))).default;
const { createQueue } = await import(path.join(root, "netlify/lib/mail-queue.mjs"));

let checks = 0;
const ok = (b, t) => { assert.ok(b, t); checks++; };
const eq = (a, b, t) => { assert.equal(a, b, t); checks++; };

const ANHANG_A = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";     // „ABC…Z", base64
const ANHANG_B = "MDEyMzQ1Njc4OQ==";                          // „0123456789"

/* Genauso baut Quantus eine Mail mit Anhängen: Kopf, multipart/mixed,
   erster Teil = Körper, danach die Anhänge. */
function mailMitAnhaengen() {
  return [
    "To: beispiel@example.com",
    "Subject: Alter Betreff",
    "In-Reply-To: <vorher@example.com>",
    "References: <erst@example.com> <vorher@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix_1"',
    "",
    "--mix_1",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Alter Text", "utf8").toString("base64"),
    "--mix_1",
    'Content-Type: application/pdf; name="offerte.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="offerte.pdf"',
    "",
    ANHANG_A,
    "--mix_1",
    'Content-Type: text/csv; name="zahlen.csv"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="zahlen.csv"',
    "",
    ANHANG_B,
    "--mix_1--",
  ].join("\r\n");
}

/* ══ 1. Der Körper wird ersetzt, die Anhänge bleiben ══════════════════════ */
{
  const alt = mailMitAnhaengen();
  ok(M.hatAnhaenge(alt), "die Nachricht wird nicht als Nachricht mit Anhang erkannt");
  const neuerTeil = M.textTeil("Neuer Text");
  const neu = M.ersetzeKoerper(alt, neuerTeil);

  ok(neu.includes(ANHANG_A), "der erste Anhang ist beim Bearbeiten verloren gegangen");
  ok(neu.includes(ANHANG_B), "der zweite Anhang ist beim Bearbeiten verloren gegangen");
  ok(neu.includes('filename="offerte.pdf"'), "der Dateiname des Anhangs ging verloren");
  ok(neu.includes(Buffer.from("Neuer Text", "utf8").toString("base64")), "der neue Text steht nicht drin");
  ok(!neu.includes(Buffer.from("Alter Text", "utf8").toString("base64")), "der alte Text steht noch drin");
  eq(M.liesKopfzeile(neu, "To"), "beispiel@example.com", "der Empfänger ging verloren");
  eq(M.liesKopfzeile(neu, "In-Reply-To"), "<vorher@example.com>", "die Antwort-Kopfzeile ging verloren");
  eq((neu.match(/--mix_1/g) || []).length, (alt.match(/--mix_1/g) || []).length,
    "die Zahl der Teile hat sich verändert");
  ok(neu.trimEnd().endsWith("--mix_1--"), "die Nachricht endet nicht mehr sauber");
}

/* ══ 2. Der Betreff allein ════════════════════════════════════════════════ */
{
  const alt = mailMitAnhaengen();
  const neu = M.ersetzeBetreff(alt, "Neuer Betreff mit Ümlaut");
  ok(/^Subject: =\?UTF-8\?B\?/m.test(neu), "der Betreff wurde nicht richtig kodiert");
  ok(!neu.includes("Alter Betreff"), "der alte Betreff steht noch da");
  ok(neu.includes(ANHANG_A), "beim Betreff ging ein Anhang verloren");
  eq((neu.match(/^Subject:/gm) || []).length, 1, "es gibt jetzt zwei Betreffzeilen");
}

/* ══ 3. Ohne Anhänge wird der ganze Rumpf getauscht ═══════════════════════ */
{
  const alt = [
    "To: beispiel@example.com", "Subject: Ohne", "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64",
    "", Buffer.from("alt", "utf8").toString("base64"),
  ].join("\r\n");
  const neu = M.ersetzeKoerper(alt, M.textTeil("neu"));
  ok(neu.includes(Buffer.from("neu", "utf8").toString("base64")), "der neue Text fehlt");
  eq((neu.match(/^Content-Type:/gm) || []).length, 1, "die Nachricht hat jetzt zwei Content-Type-Zeilen");
  eq(M.liesKopfzeile(neu, "To"), "beispiel@example.com", "der Empfänger ging verloren");
}

/* ══ 4. Die eigene Message-ID ═════════════════════════════════════════════ */
{
  const alt = mailMitAnhaengen();
  const gesetzt = M.setzeMessageId(alt, "out_1.abc@quantus.mail");
  eq(gesetzt.neu, true, "die Message-ID wurde nicht gesetzt");
  eq(M.liesMessageId(gesetzt.mime), "out_1.abc@quantus.mail", "die Message-ID steht nicht in der Nachricht");
  // Eine vorhandene wird NICHT überschrieben.
  const zweit = M.setzeMessageId(gesetzt.mime, "andere@quantus.mail");
  eq(zweit.neu, false, "eine vorhandene Message-ID wurde überschrieben");
  eq(zweit.id, "out_1.abc@quantus.mail", "die vorhandene Message-ID hat sich geändert");
  // Und sie überlebt das Bearbeiten.
  const bearbeitet = M.ersetzeKoerper(M.ersetzeBetreff(gesetzt.mime, "Anders"), M.textTeil("Anders"));
  eq(M.liesMessageId(bearbeitet), "out_1.abc@quantus.mail", "die Message-ID ging beim Bearbeiten verloren");
}

/* ══ 5. Dieselbe Zusage durch die Warteschlange hindurch ══════════════════ */
{
  const speicher = new Map();
  const kennungen = new Map();
  let n = 0;
  const setze = (p, v) => { speicher.set(p, JSON.parse(JSON.stringify(v))); kennungen.set(p, "e" + (++n)); };
  const q = createQueue({
    dbGet: async (p) => speicher.get(p) || null,
    dbGetEtag: async (p) => ({ value: speicher.get(p) || null, etag: kennungen.get(p) || null }),
    dbSet: async (p, v, opt = {}) => {
      if (opt.ifMatch && kennungen.get(p) !== opt.ifMatch) return { ok: false, conflict: true };
      setze(p, v); return { ok: true, conflict: false };
    },
    dbRemove: async (p) => { speicher.delete(p); },
    gmail: async () => { throw new Error("im Bearbeiten darf Gmail nicht gerufen werden"); },
    jetzt: () => Date.parse("2026-09-13T09:00:00+02:00"),
    neueId: () => "out_anhang",
  });

  const { eintrag } = await q.plane({ raw: M.kodiere(mailMitAnhaengen()), to: "beispiel@example.com",
    subject: "Alter Betreff", koerper: "Alter Text" });
  eq(eintrag.hatAnhaenge, true, "die Warteschlange erkennt den Anhang nicht");
  ok(eintrag.messageIdKopf, "die Planung vergibt keine Message-ID");

  const geaendert = await q.aendere("out_anhang", {
    koerperTeil: M.textTeil("Ganz neuer Text"), subject: "Ganz neuer Betreff", koerper: "Ganz neuer Text",
  });
  ok(geaendert.ok, "eine Mail mit Anhang liess sich nicht bearbeiten");
  const mime = M.dekodiere(geaendert.eintrag.raw);
  ok(mime.includes(ANHANG_A) && mime.includes(ANHANG_B), "beim Bearbeiten gingen die Anhänge verloren");
  ok(mime.includes(Buffer.from("Ganz neuer Text", "utf8").toString("base64")), "der neue Text fehlt");
  ok(/Subject: =\?UTF-8\?B\?|Subject: Ganz neuer Betreff/.test(mime), "der neue Betreff fehlt");
  eq(geaendert.eintrag.hatAnhaenge, true, "der Anhang gilt danach als verschwunden");
  eq(geaendert.eintrag.koerper, "Ganz neuer Text", "der Klartext wurde nicht mitgeführt");
  eq(M.liesMessageId(mime), eintrag.messageIdKopf, "die Message-ID wurde beim Bearbeiten getauscht");

  // Eine GANZ neue Nachricht statt nur des Körpers: das würde die Anhänge
  // wegwerfen — also wird es abgelehnt, statt es still zu tun.
  const verweigert = await q.aendere("out_anhang", { raw: M.kodiere("To: x@example.com\r\n\r\nnur Text") });
  eq(verweigert.ok, false, "eine Mail mit Anhang liess sich blind überschreiben");
  ok(/Anhang/i.test(verweigert.grund || ""), "der Grund nennt den Anhang nicht");
  const unveraendert = M.dekodiere(speicher.get("mail/outbox/out_anhang").raw);
  ok(unveraendert.includes(ANHANG_A), "die abgelehnte Änderung hat die Nachricht trotzdem angefasst");
}

console.log(`mail mime (Anhänge bleiben): ok (${checks} Prüfungen)`);
