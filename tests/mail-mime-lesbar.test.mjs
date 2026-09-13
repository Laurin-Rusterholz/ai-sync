/*
 * Was am Ende WIRKLICH in der Mail steht — gelesen, nicht behauptet.
 *
 * ZWEI BEFUNDE aus der unabhängigen Gegenprobe (Laurin, 13.09.2026):
 *
 * 1. EMPFÄNGER: `aendere` nahm to/cc/bcc entgegen und schrieb sie in die
 *    Anzeigefelder — die gespeicherte Nachricht behielt ihre alten Kopfzeilen.
 *    In Quantus stand der neue Empfänger, hinausgegangen wäre die Mail an den
 *    alten. Repro: To: old@example.invalid → aendere({to:"neu@…"}) → altes To.
 *
 * 2. TRENNZEILE: `ersetzeKoerper` ohne multipart/mixed entfernte die alten
 *    Content-Zeilen und setzte dann Leerzeile + Körper-Entität. Damit endete
 *    der Kopf VOR den Content-Zeilen der Entität — Gmail zeigte
 *    „Content-Type: …" und den Base64-Block als Mailtext.
 *
 * Beides lässt sich nur durch LESEN prüfen. Dieses Repo hat bewusst keine
 * npm-Abhängigkeiten in den Tests, also steht unten ein eigener, kleiner
 * MIME-Leser: bewusst UNABHÄNGIG von netlify/lib/mail-mime.mjs geschrieben
 * (eigene Zerlegung, eigene Dekodierung), damit er nicht denselben Fehler
 * wiederholt wie der Code, den er prüfen soll.
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

/* ── Ein unabhängiger MIME-Leser ────────────────────────────────────────────
   Kopf/Rumpf trennen, Kopfzeilen entfalten, multiparts an ihren Grenzen
   zerlegen, base64 und quoted-printable auflösen. Er weiss nichts vom
   Produktionscode — er liest nur, was dasteht. */
function lies(mime) {
  const text = String(mime).replace(/\r\n/g, "\n");
  const trennung = text.indexOf("\n\n");
  const kopfRoh = trennung >= 0 ? text.slice(0, trennung) : text;
  const rumpf = trennung >= 0 ? text.slice(trennung + 2) : "";
  const kopf = {};
  let letzter = null;
  for (const zeile of kopfRoh.split("\n")) {
    if (/^[ \t]/.test(zeile) && letzter) { kopf[letzter] += " " + zeile.trim(); continue; }
    const i = zeile.indexOf(":");
    if (i < 0) continue;
    letzter = zeile.slice(0, i).toLowerCase();
    kopf[letzter] = zeile.slice(i + 1).trim();
  }
  const ct = kopf["content-type"] || "text/plain";
  const art = ct.split(";")[0].trim().toLowerCase();
  const grenze = (/boundary="?([^";]+)"?/i.exec(ct) || [])[1];
  const knoten = { art, kopf, teile: [], inhalt: "" };
  if (grenze) {
    const stuecke = rumpf.split("--" + grenze);
    for (const st of stuecke.slice(1)) {
      if (/^--\s*$/.test(st.trim()) || st.trim() === "--") continue;
      const sauber = st.replace(/^\n/, "");
      if (!sauber.trim()) continue;
      knoten.teile.push(lies(sauber));
    }
    return knoten;
  }
  const kodierung = (kopf["content-transfer-encoding"] || "7bit").toLowerCase();
  if (kodierung === "base64") {
    knoten.inhalt = Buffer.from(rumpf.replace(/\s+/g, ""), "base64").toString("utf8");
    knoten.rohdaten = rumpf.replace(/\s+/g, "");
  } else if (kodierung === "quoted-printable") {
    knoten.inhalt = rumpf.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
  } else {
    knoten.inhalt = rumpf;
  }
  return knoten;
}

function alleTeile(knoten, aus = []) {
  aus.push(knoten);
  (knoten.teile || []).forEach((t) => alleTeile(t, aus));
  return aus;
}
function textVon(knoten, art) {
  return alleTeile(knoten).filter((t) => t.art === art).map((t) => t.inhalt).join("\n");
}
function anhaenge(knoten) {
  return alleTeile(knoten).filter((t) => /attachment/i.test(t.kopf["content-disposition"] || ""));
}

/* ══ 1. Genau der gemeldete Repro-Fall ════════════════════════════════════ */
{
  const alt = "To: old@example.invalid\r\nSubject: test\r\nContent-Type: text/plain\r\n\r\nHello";
  const neu = M.ersetzeEmpfaenger(M.ersetzeKoerper(alt, M.textTeil("Updated")),
    { to: "new@example.invalid", cc: "", bcc: "" });
  const gelesen = lies(neu);

  eq(gelesen.kopf.to, "new@example.invalid", "die Mail ginge weiterhin an den ALTEN Empfänger");
  ok(!/old@example\.invalid/.test(neu), "die alte Adresse steht noch in der Nachricht");
  eq(gelesen.art, "text/plain", "die Nachricht ist keine lesbare Textmail mehr");
  eq(gelesen.inhalt.trim(), "Updated", "der neue Text kommt beim Lesen nicht heraus");
  ok(!/Content-Type/i.test(gelesen.inhalt), "die MIME-Kopfzeilen stehen im sichtbaren Mailtext");
  ok(!/^[A-Za-z0-9+/=\s]{16,}$/.test(gelesen.inhalt.trim()), "im Mailtext steht sichtbares Base64 statt Text");
  ok(!("cc" in gelesen.kopf) && !("bcc" in gelesen.kopf), "leeres Cc/Bcc steht als leere Kopfzeile in der Mail");
}

/* ══ 2. Antwortzitat: multipart/alternative bleibt lesbar ═════════════════ */
{
  const alt = [
    "To: a@example.invalid", "Subject: Antwort", "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alt_1"', "",
    "--alt_1", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("alter Text", "utf8").toString("base64"),
    "--alt_1", 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("<p>alter Text</p>", "utf8").toString("base64"),
    "--alt_1--",
  ].join("\r\n");

  const neuerTeil = [
    'Content-Type: multipart/alternative; boundary="alt_2"', "",
    "--alt_2", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("Neue Antwort\n\n> Zitat vom Absender", "utf8").toString("base64"),
    "--alt_2", 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("<p>Neue Antwort</p><blockquote>Zitat vom Absender</blockquote>", "utf8").toString("base64"),
    "--alt_2--",
  ].join("\r\n");

  const neu = M.ersetzeKoerper(alt, neuerTeil);
  const gelesen = lies(neu);
  eq(gelesen.art, "multipart/alternative", "aus der Antwort wurde etwas anderes als multipart/alternative");
  ok(/Neue Antwort/.test(textVon(gelesen, "text/plain")), "der neue Text fehlt in der Textfassung");
  ok(/Zitat vom Absender/.test(textVon(gelesen, "text/plain")), "das Zitat fehlt in der Textfassung");
  ok(/<blockquote>/.test(textVon(gelesen, "text/html")), "die HTML-Fassung hat ihr Zitat verloren");
  ok(!/alter Text/.test(textVon(gelesen, "text/plain") + textVon(gelesen, "text/html")), "der alte Text steht noch da");
  ok(!/Content-Type/i.test(textVon(gelesen, "text/plain")), "im sichtbaren Text stehen MIME-Kopfzeilen");
}

/* ══ 3. Mit Anhängen: Text neu, Anhänge unberührt ═════════════════════════ */
{
  const daten = Buffer.from("PDF-Beispielinhalt", "utf8").toString("base64");
  const alt = [
    "To: a@example.invalid", "Cc: alt-cc@example.invalid", "Subject: Mit Anhang", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mix_1"', "",
    "--mix_1", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("alter Text", "utf8").toString("base64"),
    "--mix_1", 'Content-Type: application/pdf; name="beispiel.pdf"', "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="beispiel.pdf"', "", daten,
    "--mix_1--",
  ].join("\r\n");

  let neu = M.ersetzeKoerper(alt, M.textTeil("Neuer Text"));
  neu = M.ersetzeEmpfaenger(neu, { to: "neu@example.invalid", cc: "", bcc: "still@example.invalid" });
  const gelesen = lies(neu);

  eq(gelesen.art, "multipart/mixed", "der Rahmen mit Anhang ging verloren");
  eq(gelesen.kopf.to, "neu@example.invalid", "der neue Empfänger steht nicht in der Nachricht");
  ok(!("cc" in gelesen.kopf), "das geleerte Cc steht noch in der Nachricht");
  eq(gelesen.kopf.bcc, "still@example.invalid", "das neue Bcc fehlt");
  ok(/Neuer Text/.test(textVon(gelesen, "text/plain")), "der neue Text fehlt");
  ok(!/alter Text/.test(textVon(gelesen, "text/plain")), "der alte Text steht noch da");
  const anh = anhaenge(gelesen);
  eq(anh.length, 1, "der Anhang ist verschwunden oder hat sich vermehrt");
  eq(anh[0].rohdaten, daten, "die Anhangsdaten haben sich verändert");
  ok(/beispiel\.pdf/.test(anh[0].kopf["content-disposition"]), "der Dateiname ging verloren");
}

/* ══ 4. Nachgereichte Anhänge verschwinden nicht ══════════════════════════ */
{
  const alt = "To: a@example.invalid\r\nSubject: Ohne\r\nContent-Type: text/plain\r\n\r\nText";
  const neu = M.fuegeAnhaengeAn(alt, [M.anhangTeil({
    name: "nachgereicht.txt", typ: "text/plain", daten: Buffer.from("Inhalt", "utf8").toString("base64") })]);
  const gelesen = lies(neu);
  eq(gelesen.art, "multipart/mixed", "die Nachricht bekam keinen Rahmen für den Anhang");
  ok(/Text/.test(textVon(gelesen, "text/plain")), "der bisherige Text ging beim Anhängen verloren");
  eq(anhaenge(gelesen).length, 1, "der nachgereichte Anhang fehlt");
  eq(gelesen.kopf.to, "a@example.invalid", "der Empfänger ging beim Anhängen verloren");

  // Und noch einer dazu: der erste bleibt.
  const zweit = lies(M.fuegeAnhaengeAn(neu, [M.anhangTeil({
    name: "zweiter.txt", typ: "text/plain", daten: Buffer.from("Zwei", "utf8").toString("base64") })]));
  eq(anhaenge(zweit).length, 2, "beim zweiten Anhängen ging der erste verloren");
}

/* ══ 5. Kopfzeilen-Einschleusung ══════════════════════════════════════════ */
{
  const alt = "To: a@example.invalid\r\nSubject: X\r\nContent-Type: text/plain\r\n\r\nText";
  const boese = "opfer@example.invalid\r\nBcc: heimlich@example.invalid";
  const neu = M.ersetzeEmpfaenger(alt, { to: boese });
  const gelesen = lies(neu);
  ok(!("bcc" in gelesen.kopf), "über das An-Feld liess sich eine Bcc-Kopfzeile einschleusen");
  ok(/heimlich@example\.invalid/.test(gelesen.kopf.to), "der eingeschleuste Teil wurde nicht in die Adresszeile gezwungen");
  eq(Object.keys(gelesen.kopf).filter((k) => k === "to").length, 1, "es gibt jetzt zwei An-Zeilen");
  ok(!/\n/.test(gelesen.kopf.to), "in der Adresszeile steht noch ein Zeilenumbruch");
}

/* ══ 6. Durch die Warteschlange hindurch — genau der Repro ════════════════ */
{
  const speicher = new Map(); const kennungen = new Map(); let n = 0;
  const setze = (p, v) => { speicher.set(p, JSON.parse(JSON.stringify(v))); kennungen.set(p, "e" + (++n)); };
  const q = createQueue({
    dbGet: async (p) => speicher.get(p) || null,
    dbGetEtag: async (p) => ({ value: speicher.get(p) || null, etag: kennungen.get(p) || "leer" }),
    dbSet: async (p, v, opt = {}) => {
      if (opt.ifMatch && (kennungen.get(p) || "leer") !== opt.ifMatch) return { ok: false, conflict: true };
      setze(p, v); return { ok: true, conflict: false };
    },
    dbRemove: async (p) => { speicher.delete(p); },
    gmail: async () => { throw new Error("beim Bearbeiten darf Gmail nicht gerufen werden"); },
    jetzt: () => Date.parse("2026-09-13T09:00:00+02:00"),
    neueId: () => "out_repro",
  });

  const roh = M.kodiere("To: old@example.invalid\r\nSubject: test\r\nContent-Type: text/plain\r\n\r\nHello");
  await q.plane({ raw: roh, to: "old@example.invalid", subject: "test", koerper: "Hello" });
  const r = await q.aendere("out_repro", { to: "new@example.invalid", cc: "", bcc: "", koerper: "Updated" });
  ok(r.ok, "die Änderung wurde abgewiesen");

  const gelesen = lies(M.dekodiere(r.eintrag.raw));
  eq(gelesen.kopf.to, "new@example.invalid", "DIE MAIL GINGE AN DEN ALTEN EMPFÄNGER");
  eq(r.eintrag.to, "new@example.invalid", "die Anzeige zeigt den neuen Empfänger nicht");
  eq(gelesen.kopf.to, r.eintrag.to, "Anzeige und Nachricht nennen verschiedene Empfänger");
  eq(gelesen.inhalt.trim(), "Updated", "der neue Text steht nicht lesbar in der Nachricht");
  ok(!/Content-Type/i.test(gelesen.inhalt), "die MIME-Kopfzeilen stehen im sichtbaren Mailtext");
  ok(M.liesMessageId(M.dekodiere(r.eintrag.raw)), "die Message-ID ging beim Ändern verloren");
}

console.log(`mail mime lesbar (unabhängiger Leser): ok (${checks} Prüfungen)`);
