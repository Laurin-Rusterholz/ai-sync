/*
 * Zwei volle Mails standen als „Spam" bzw. „kein Inhalt" da.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026, Quantus-Update):
 *   · Arthur Lenart, Leserbrief und Präsentation, 02.09. 18:21,
 *     Thread 1a062ec91de39422, vier Anhänge
 *   · Marlies, Hauptversammlung Spielgruppe Jupidu, 02.09. 21:31,
 *     Thread 1a0639b1d16ee15e, zwei PDF
 * Beide sind inhaltsreich. Quantus zeigte „kein Inhalt" und eine
 * Spam-Einschätzung.
 *
 * Zwei verschiedene Fehler, die zusammen dieses Bild ergaben:
 *
 *   1. Gmail liefert den Körper nicht immer mit. Ist ein Teil gross genug,
 *      steht in `body` statt `data` nur eine `attachmentId` — der Inhalt muss
 *      in einem zweiten Aufruf geholt werden. extractBodies verlangte `data`,
 *      und collectAttachmentRefs sammelte nur Teile MIT Dateinamen. Ein
 *      Körper hat keinen Dateinamen. Er fiel durch beide Raster und war
 *      lautlos weg — der Leser zeigte „(Kein Textinhalt)", als sei die Mail
 *      leer.
 *   2. Die Kategorie aus der automatischen Einschätzung stand als blosses
 *      Wort da, ununterscheidbar von einer Tatsache des Postfachs. „spam" aus
 *      der Einschätzung und „Gmail hat sie als Spam einsortiert" sind aber
 *      nicht dasselbe — erst recht nicht, wenn der Inhalt gar nicht vorlag.
 *
 * Dazu die dritte Sache aus dem Auftrag: Ein „erledigt", das nicht vom
 * Menschen kam, darf nicht wie eine Tatsache aussehen.
 *
 * Geprüft wird der ECHTE Code aus index.html gegen Mock-Nachrichten. Es
 * werden keine Labels gesetzt, keine Nachrichten geändert, nichts gesendet.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

function schnitt(von, bis, was) {
  const a = index.indexOf(von);
  const b = index.indexOf(bis, a + 1);
  assert.ok(a > -1 && b > a, `${was} wurde in index.html nicht gefunden`);
  checks++;
  return index.slice(a, b);
}

/* ── Die echten Funktionen ────────────────────────────────────────────── */
const quelleExtrakt = schnitt("  function extractBodies(payload){", "  function htmlToText(html){",
  "die Körper-Auswertung");
const quelleLeer = schnitt("  function gmailLeerText(o){", "  window.gmailFitFrame = function(frame){",
  "der Leerfall des Lesers");
const quelleKi = schnitt("  var GMAIL_VERMUTUNG =", "  // ── Termin-Erkennung im Reader",
  "die Anzeige der Einschätzung");
const quelleRefs = schnitt("  function collectAttachmentRefs(payload){", "  function extractInlineAttachText",
  "die Anhangsliste");

function bauen(geholt) {
  const gerufen = [];
  const GM = { classifications: {}, open: null };
  const win = {};
  const scope = {
    window: win, GM,
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    b64urlDecode: (d) => Buffer.from(String(d).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    gmApi: async (verb, pfad) => {
      gerufen.push(verb + " " + pfad);
      const id = pfad.split("/attachments/")[1];
      if (geholt && Object.prototype.hasOwnProperty.call(geholt, id)) {
        if (geholt[id] === null) throw new Error("HTTP 404");
        return { data: Buffer.from(geholt[id], "utf8").toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
      }
      throw new Error("unbekannter Anhang");
    },
    rerender: () => {},
    clsOf: (m) => (m && GM.classifications[m.id]) || null,
  };
  win.window = win;
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return Object.assign(new Function(...namen,
    "with (window) {\n" + quelleExtrakt + "\n" + quelleRefs + "\n" + quelleLeer + "\n" + quelleKi +
    "\nreturn { extractBodies, gmailLoadPendingBodies, gmailLeerText, renderKiPanel, collectAttachmentRefs };\n}")(
    ...namen.map((n) => scope[n])), { GM, gerufen });
}

/* Der Leserbrief: vier Anhänge, und der HTML-Körper kommt als Nachlieferung. */
const LESERBRIEF = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { attachmentId: "koerper-text", size: 40000 } },
      { mimeType: "text/html", body: { attachmentId: "koerper-html", size: 220000 } },
    ] },
    { mimeType: "application/pdf", filename: "Leserbrief.pdf", body: { attachmentId: "a1", size: 120000 } },
    { mimeType: "application/pdf", filename: "Praesentation.pdf", body: { attachmentId: "a2", size: 900000 } },
    { mimeType: "image/png", filename: "Bild1.png", body: { attachmentId: "a3", size: 50000 } },
    { mimeType: "image/png", filename: "Bild2.png", body: { attachmentId: "a4", size: 60000 } },
  ],
};
/* Die Einladung: zwei PDF, Körper als Nachlieferung, nur text/plain. */
const EINLADUNG = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "text/plain", body: { attachmentId: "einl-text", size: 30000 } },
    { mimeType: "application/pdf", filename: "Traktanden.pdf", body: { attachmentId: "b1", size: 80000 } },
    { mimeType: "application/pdf", filename: "Jahresrechnung.pdf", body: { attachmentId: "b2", size: 95000 } },
  ],
};

/* ══ 1. Der nachgereichte Körper wird geholt ══════════════════════════════ */
{
  const t = bauen({
    "koerper-html": "<p>Sehr geehrte Redaktion, anbei mein Leserbrief …</p>",
    "koerper-text": "Sehr geehrte Redaktion, anbei mein Leserbrief …",
  });
  const b = t.extractBodies(LESERBRIEF);
  eq(b.html, "", "der Körper stand unerwartet schon im Payload — der Testfall trifft nicht");
  eq(b.nachzuladen.length, 2, "die nachgereichten Körperteile werden nicht erkannt");
  eq(b.nachzuladen.map((x) => x.mimeType).sort(), ["text/html", "text/plain"],
    "es werden die falschen Teile als Nachlieferung geführt");
  // Der Körper ist KEIN Anhang — er darf die Anhangsliste nicht verfälschen.
  const refs = t.collectAttachmentRefs(LESERBRIEF);
  eq(refs.length, 4, "die Anhangsliste stimmt nicht — der Körper zählt als Anhang mit");
  eq(refs.map((r) => r.filename),
    ["Leserbrief.pdf", "Praesentation.pdf", "Bild1.png", "Bild2.png"], "die Anhänge stimmen nicht");

  const o = { id: "m_leserbrief", html: b.html, text: b.text, nachzuladen: b.nachzuladen, attachRefs: refs };
  const geholt = await t.gmailLoadPendingBodies(o);
  ok(geholt, "der nachgereichte Körper wurde nicht geholt");
  ok(/Leserbrief/.test(o.html), `der HTML-Körper fehlt weiterhin: ${JSON.stringify(o.html)}`);
  ok(/Leserbrief/.test(o.text), "der Textkörper fehlt weiterhin");
  ok(!o.koerperFehler, `es wird ein Fehler gemeldet, obwohl geladen wurde: ${o.koerperFehler}`);
  // Gelesen, nicht geschrieben — und nur der Körper, keine Anhänge.
  ok(t.gerufen.every((r) => r.startsWith("GET ")), "beim Nachladen wird geschrieben");
  ok(t.gerufen.every((r) => /koerper-(html|text)/.test(r)),
    `es wurden fremde Anhänge geladen: ${t.gerufen.join(", ")}`);
  eq(o.nachzuladen.length, 0, "die Nachlieferung wird beim nächsten Zeichnen erneut geholt");
}

/* ══ 2. Die Einladung — nur Text, zwei PDF ════════════════════════════════ */
{
  const t = bauen({ "einl-text": "Einladung zur Hauptversammlung der Spielgruppe Jupidu …" });
  const b = t.extractBodies(EINLADUNG);
  eq(b.nachzuladen.length, 1, "der nachgereichte Text wird nicht erkannt");
  const o = { id: "m_einladung", html: "", text: "", nachzuladen: b.nachzuladen,
    attachRefs: t.collectAttachmentRefs(EINLADUNG) };
  await t.gmailLoadPendingBodies(o);
  ok(/Hauptversammlung/.test(o.text), "der Text der Einladung fehlt weiterhin");
  eq(o.attachRefs.length, 2, "die beiden PDF fehlen in der Anhangsliste");
}

/* ══ 3. Was der Leser sagt, wenn nichts da ist ════════════════════════════
   „(Kein Textinhalt)" ist eine Behauptung über die Mail. Sie stimmt nur in
   einem der drei Fälle. */
{
  const t = bauen({});
  ok(/nachgeladen/.test(t.gmailLeerText({ koerperLaedt: true })),
    "während des Nachladens behauptet der Leser schon, es gebe nichts");
  const fehler = t.gmailLeerText({ koerperFehler: "Netzwerkfehler" });
  ok(/nicht leer/.test(fehler), "ein Ladefehler wird als leere Mail ausgegeben");
  ok(/Netzwerkfehler/.test(fehler), "der Grund wird verschwiegen");
  const nurAnhang = t.gmailLeerText({ attachRefs: [{ filename: "a.pdf" }, { filename: "b.pdf" }] });
  ok(/2 Anhänge/.test(nurAnhang), "eine Mail aus lauter Anhängen wird als leer ausgegeben");
  eq(t.gmailLeerText({}), "Diese Mail enthält keinen Textinhalt.",
    "der echte Leerfall wird nicht mehr benannt");
}

/* ══ 4. Einschätzung ≠ Tatsache ═══════════════════════════════════════════ */
{
  const t = bauen({});
  const mail = { id: "m_leserbrief", labelIds: ["INBOX"], html: "<p>Leserbrief …</p>", text: "Leserbrief …" };
  t.GM.classifications.m_leserbrief = { category: "spam", priority: 3, summary: "Wirkt wie Werbung." };
  const html = t.renderKiPanel(mail);
  ok(/spam · vermutet/.test(html), "die Kategorie steht weiterhin als blosse Tatsache da");
  ok(/Automatische Einschätzung/.test(html), "die Überschrift nennt es nicht als Einschätzung");
  ok(/NICHT als Spam einsortiert/.test(html),
    "es wird nicht gesagt, dass Gmail diese Mail gar nicht als Spam führt");
  ok(/Priorität: Niedrig · vermutet/.test(html), "auch die Priorität muss als Vermutung kenntlich sein");

  // Gmails eigenes Urteil ist dagegen eine Tatsache — und wird so benannt.
  const echt = t.renderKiPanel({ id: "m_leserbrief", labelIds: ["SPAM"], html: "<p>x</p>", text: "x" });
  ok(/Tatsache des Postfachs/.test(echt), "echter Gmail-Spam wird nicht als Tatsache benannt");
  ok(!/NICHT als Spam einsortiert/.test(echt), "bei echtem Spam steht der Gegenhinweis");

  // Ohne Inhalt trägt keine Einschätzung.
  const ohne = t.renderKiPanel({ id: "m_leserbrief", labelIds: ["INBOX"], html: "", text: "",
    koerperFehler: "HTTP 404" });
  ok(/nicht belastbar/.test(ohne), "eine Einschätzung ohne Inhalt wird nicht eingeschränkt");
  ok(/HTTP 404/.test(ohne), "der Grund für den fehlenden Inhalt wird verschwiegen");
  // Während des Nachladens wird noch nichts behauptet.
  const laedt = t.renderKiPanel({ id: "m_leserbrief", labelIds: ["INBOX"], html: "", text: "",
    koerperLaedt: true });
  ok(!/nicht belastbar/.test(laedt), "schon beim Laden wird der Inhalt für fehlend erklärt");
}

/* ══ 5. „Erledigt" nur dann als Tatsache, wenn es der Mensch war ══════════ */
{
  const t = bauen({});
  const mail = { id: "m1", labelIds: ["INBOX"], html: "<p>x</p>", text: "x" };
  t.GM.classifications.m1 = { done: true };
  const auto = t.renderKiPanel(mail);
  ok(/automatisch, nicht bestätigt/.test(auto),
    "ein automatisches „erledigt“ sieht aus wie eine bestätigte Tatsache");
  ok(/gml-ki-warn/.test(auto), "die unbestätigte Behauptung ist nicht als solche hervorgehoben");

  t.GM.classifications.m1 = { done: true, doneBy: "laurin", doneAt: "2026-09-11T06:00:00.000Z" };
  const vonHand = t.renderKiPanel(mail);
  ok(/von dir erledigt/.test(vonHand), "ein selbst gesetztes „erledigt“ wird nicht als solches gezeigt");
  ok(!/nicht bestätigt/.test(vonHand), "ein selbst gesetztes „erledigt“ wird als unbestätigt gezeigt");
}

/* ══ 6. Quelltext: der Mensch hinterlässt seine Spur ══════════════════════ */
{
  const toggle = schnitt("  window.gmailToggleDone = async function(id){", "\n  window.gmailBulk",
    "der Erledigt-Schalter");
  ok(/cc\.doneBy="laurin"/.test(toggle), "der Schalter vermerkt nicht, wer erledigt hat");
  ok(/doneBy", !isDone \? "laurin" : null/.test(toggle),
    "der Vermerk wird nicht mitgespeichert — nach einem Reload wäre es wieder „automatisch“");
  // Und es wird nach wie vor nichts Fremdes angefasst.
  ok(!/labels\/.*delete|messages\/.*delete/i.test(toggle), "der Schalter löscht etwas");
}

console.log(`gmail inhalt & einschaetzung: ok (${checks} Pruefungen)`);
