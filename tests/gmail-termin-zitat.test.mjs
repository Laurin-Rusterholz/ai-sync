/*
 * Terminerkennung im Gmail-Hub: zitierte Versanddaten sind keine Termine.
 *
 * PRODUKTIONSBEFUND (11.09., zwei Mails):
 *   1. Aktueller Text „diesen Sonntag, 13.9 um 16 Uhr auf den Obstmarkt“,
 *      darunter das Zitat „Am 04.09.2026 um 21:42 schrieb …“.
 *      Die Oberfläche schlug 04.09. 21:42 vor.
 *   2. Aktueller Text „Montag, 14. September, 19 Uhr bei mir“, darunter
 *      „Gesendet: Freitag, 11.09.2026 05:02“. Vorgeschlagen wurde 11.09. 05:02.
 *
 * URSACHE, an anonymisierten Nachbauten mit der ECHTEN Funktion nachgemessen:
 *   ruleDetectAppt las Betreff + GANZEN Text und nahm den ERSTEN Treffer. In
 *   einer Antwortmail steht der zuerst im zitierten Verlauf, und dessen
 *   Kopfzeilen tragen Versanddaten. Dieselben Werte gingen an die KI.
 *   Dazu kam: der aktuelle Text war für den Regelweg gar nicht lesbar —
 *   „13.9“ (ohne Schlusspunkt, ohne Jahr) und „14. September“ (ohne Jahr)
 *   kannte er nicht. Selbst ohne Zitat hätte er beide Termine verfehlt.
 *
 * KORREKTUR:
 *   · gmailZitatTrennen schneidet an der frühesten Zitatmarke.
 *   · apptKopfzeilenMaskieren macht übrig gebliebene Kopf- und Zitatzeilen
 *     längengleich unkenntlich.
 *   · ruleDetectAppt und der KI-Aufruf sehen nur noch den aktuellen Teil.
 *   · Der Regelweg versteht jetzt „13.9“ und „14. September“.
 *   · Steht ein Datum NUR im Zitat, wird gefragt statt behauptet
 *     (gmailZitatBefund → Rückfragekarte, keine Kalenderaktion).
 *
 * Geprüft wird gegen die ECHTEN Funktionen aus public/index.html, mit
 * eingefrorenem „heute“ (2026-09-11), damit der Test nicht mit der Zeit kippt.
 * Die Fälle liegen als anonymisierte Fixtures in
 * tests/fixtures/gmail-termin-zitate.json — keine echten Mails, Namen oder
 * Adressen. Kein Browser, kein Netz, keine Datei wird geschrieben.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/gmail-termin-zitate.json"), "utf8"));

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

function schneide(start, ende) {
  const a = index.indexOf(start);
  if (a < 0) return null;
  const b = index.indexOf(ende, a);
  return b < 0 ? null : index.slice(a, b);
}

// ═══ Die echten Funktionen herausschneiden und laufen lassen ══════════════
const quelle = schneide("function apptPad(n)", "function apptParseJson(txt)");
ok(!!quelle, "der Erkennungsblock (apptPad … apptParseJson) wurde nicht gefunden");
if (!quelle) { console.error("kein Code zum Prüfen"); process.exit(1); }

// „heute“ einfrieren: der echte Code ruft new Date() ohne Argumente.
const HEUTE = "2026-09-11T12:00:00";
const EchtesDate = Date;
class FestesDate extends EchtesDate {
  constructor(...a) { if (a.length === 0) super(HEUTE); else super(...a); }
  static now() { return new EchtesDate(HEUTE).getTime(); }
}
const api = new Function("Date", quelle +
  "\nreturn { ruleDetectAppt, apptHasDateHint, gmailZitatTrennen, apptKopfzeilenMaskieren, apptLesbarerText, apptJahrFuer, apptTodayZurich };")(FestesDate);

ok(typeof api.gmailZitatTrennen === "function", "gmailZitatTrennen fehlt");
ok(typeof api.apptLesbarerText === "function", "apptLesbarerText fehlt");
ok(api.apptTodayZurich() === "2026-09-11", `das eingefrorene Datum greift nicht (${api.apptTodayZurich()})`);

// ═══ 1. Die gemeldeten Fälle ══════════════════════════════════════════════
for (const f of fixtures.faelle) {
  const r = api.ruleDetectAppt(f.subject, f.text);
  const ist = r ? { datum: r.startISO.slice(0, 10), zeit: r.startISO.slice(11, 16) } : null;
  if (f.erwartet) {
    ok(!!ist, `${f.name}: gar kein Termin erkannt (erwartet ${f.erwartet.datum} ${f.erwartet.zeit})`);
    if (ist) {
      ok(ist.datum === f.erwartet.datum && ist.zeit === f.erwartet.zeit,
        `${f.name}: erkannt ${ist.datum} ${ist.zeit}, erwartet ${f.erwartet.datum} ${f.erwartet.zeit}`);
    }
  } else {
    ok(ist === null, `${f.name}: es wird ein Termin behauptet (${ist && ist.datum + " " + ist.zeit}), obwohl nur das Zitat ein Datum trägt`);
  }
  if (f.falschWaere && ist) {
    ok(!(ist.datum === f.falschWaere.datum && ist.zeit === f.falschWaere.zeit),
      `${f.name}: es kommt weiterhin genau das Versanddatum heraus (${f.falschWaere.datum} ${f.falschWaere.zeit})`);
  }
}

// ═══ 2. Die Trennung selbst ═══════════════════════════════════════════════
const trennFaelle = [
  { name: "Gmail deutsch", text: "Neuer Text 13.09.2026\n\nAm 04.09.2026 um 21:42 schrieb X:\n> alt", markeIn: "Am 04.09.2026" },
  { name: "englisch", text: "New text\n\nOn 02.09.2026 at 08:15, X wrote:\n> old", markeIn: "On 02.09.2026", anfang: "New" },
  { name: "Outlook-Linie", text: "Neu\n\n________________________________\nVon: X\nGesendet: 11.09.2026", markeIn: "____" },
  { name: "Outlook-Kopf ohne Linie", text: "Neu\n\nVon: X\nGesendet: Freitag, 11.09.2026 05:02\nAn: Y", markeIn: "Von: X" },
  { name: "Ursprüngliche Nachricht", text: "Neu\n\n-----Ursprüngliche Nachricht-----\nVon: X", markeIn: "-----Ursprüngliche" },
  { name: "nur >-Zeilen", text: "Neu\n\n> alt 03.09.2026", markeIn: "> alt" },
];
for (const t of trennFaelle) {
  const teile = api.gmailZitatTrennen(t.text);
  ok(teile.zitat.includes(t.markeIn), `Trennung „${t.name}“: das Zitat beginnt nicht bei „${t.markeIn}“`);
  ok(teile.aktuell.startsWith(t.anfang || "Neu"), `Trennung „${t.name}“: der aktuelle Teil wurde mit abgeschnitten`);
  ok(!teile.aktuell.includes(t.markeIn), `Trennung „${t.name}“: die Marke steckt noch im aktuellen Teil`);
}
const ohne = api.gmailZitatTrennen("Nur ein Satz am 20.09.2026 um 14:00.");
ok(ohne.zitat === "" && ohne.aktuell.includes("20.09.2026"),
  "eine Mail ohne Zitat wird fälschlich zerschnitten");
ok(api.gmailZitatTrennen("").aktuell === "" && api.gmailZitatTrennen(null).aktuell === "",
  "leerer Text bringt die Trennung aus dem Tritt");

// ═══ 3. Die Maskierung ════════════════════════════════════════════════════
const maskiert = api.apptKopfzeilenMaskieren("Gesendet: Freitag, 11.09.2026 05:02\nTreffen am 14.09.2026 um 19:00");
ok(!/11\.09\.2026/.test(maskiert), "die Kopfzeile „Gesendet:“ bleibt lesbar");
ok(/14\.09\.2026/.test(maskiert), "die Maskierung frisst den echten Satz mit");
const m2 = api.apptKopfzeilenMaskieren("Am 04.09.2026 um 21:42 schrieb X: siehe 20.09.2026");
ok(!/04\.09\.2026/.test(m2) && /20\.09\.2026/.test(m2), "„Am … schrieb“ wird nicht sauber ausgeblendet");
ok(api.apptKopfzeilenMaskieren("Zeile A\nZeile B").split("\n").length === 2,
  "die Maskierung verändert den Zeilenbau");
// Längengleich: Positionen im Text bleiben erhalten.
const vorher = "Gesendet: 11.09.2026 05:02\nRest";
ok(api.apptKopfzeilenMaskieren(vorher).length === vorher.length,
  "die Maskierung ist nicht längengleich");

// ═══ 4. Der Regelweg versteht die gängigen deutschen Formen ═══════════════
const formen = [
  { text: "Treffen am 13.9 um 16 Uhr", datum: "2026-09-13", zeit: "16:00", was: "„13.9“ ohne Schlusspunkt und Jahr" },
  { text: "Montag, 14. September, 19 Uhr", datum: "2026-09-14", zeit: "19:00", was: "„14. September“ ohne Jahr" },
  { text: "am 5.7. um 08:30", datum: "2027-07-05", zeit: "08:30", was: "„5.7.“ — vorbei, also nächstes Jahr" },
  { text: "am 20.09.2026 um 14:00", datum: "2026-09-20", zeit: "14:00", was: "volles Datum" },
  { text: "am 12. Oktober 2026 um 11:00", datum: "2026-10-12", zeit: "11:00", was: "Monatsname mit Jahr" },
];
for (const f of formen) {
  const r = api.ruleDetectAppt("", f.text);
  const ist = r ? r.startISO.slice(0, 10) + " " + r.startISO.slice(11, 16) : null;
  ok(ist === f.datum + " " + f.zeit, `${f.was}: erkannt ${ist}, erwartet ${f.datum} ${f.zeit}`);
}
// Keine Phantomtermine aus Zahlen, die keine sind.
ok(api.ruleDetectAppt("", "Version 13.99 ist da") === null,
  "„13.99“ wird als Datum gelesen — der Monat muss 1..12 sein");

// ═══ 5. Rückfrage statt Behauptung ════════════════════════════════════════
const befundQuelle = schneide("function gmailZitatBefund(text)", "function apptWhenText(a)");
ok(!!befundQuelle, "gmailZitatBefund() fehlt — dann gäbe es keine Rückfrage");
if (befundQuelle) {
  const befund = new Function("Date", "gmailZitatTrennen", "apptHasDateHint", "ruleDetectAppt",
    befundQuelle + "\nreturn gmailZitatBefund;")(FestesDate, api.gmailZitatTrennen, api.apptHasDateHint, api.ruleDetectAppt);
  const nurZitat = fixtures.faelle.find((f) => f.name === "nur-im-zitat-ein-datum");
  const b = befund(nurZitat.text);
  ok(b && b.unsicher === true, "ein Datum nur im Zitat löst keine Rückfrage aus");
  ok(b && typeof b.zitatDatum === "string", "die Rückfrage nennt das gefundene Datum nicht");
  ok(befund("Ganz ohne Zitat und ohne Datum.") === null, "ohne Zitat wird trotzdem gefragt");
  ok(befund("Neu\n\n> nur Text, kein Datum") === null, "ein Zitat ohne Datum löst eine Rückfrage aus");
}

// ═══ 6. Die Oberfläche: fragen, nicht eintragen ═══════════════════════════
const kartenQuelle = schneide("function renderApptCard(o)", "function apptToPrefill(a, desc)");
ok(!!kartenQuelle, "renderApptCard() nicht gefunden");
if (kartenQuelle) {
  ok(/a && a\.unsicher/.test(kartenQuelle), "die Karte kennt den unsicheren Fall nicht");
  ok(/Kein Termin im aktuellen Text/.test(kartenQuelle), "die Rückfrage sagt nicht, was Sache ist");
  ok(/vermutlich das Versanddatum/.test(kartenQuelle), "die Rückfrage ordnet den Fund nicht ein");
  ok(/gmailApptVonHand/.test(kartenQuelle) && /gmailZitatBefundWeg/.test(kartenQuelle),
    "der Rückfrage fehlen die beiden Wege (selbst erfassen / ignorieren)");
  // Entscheidend: die Rückfragekarte darf KEINE Kalenderaktion anbieten.
  const rueckfrage = kartenQuelle.slice(kartenQuelle.indexOf("a.unsicher"), kartenQuelle.indexOf("var multi"));
  ok(!/gmailAddDetectedToCalendar/.test(rueckfrage),
    "die Rückfragekarte bietet trotzdem „In Google Kalender eintragen“ an");
  ok(/aus dem Text geraten, bitte prüfen/.test(kartenQuelle),
    "ein Treffer aus dem Regelweg wird nicht als geraten gekennzeichnet");
}
// Nichts trägt von selbst ein: der Kalenderweg führt weiter über den Editor.
const kalQuelle = schneide("window.gmailAddDetectedToCalendar = function(id, idx)", "window.gmailEditDetectedAppt");
ok(!!kalQuelle && /gcalQuickCreateInline/.test(kalQuelle),
  "der Kalenderweg umgeht den Editor");
const handQuelle = schneide("window.gmailApptVonHand = function(id)", "// Korrektur des erkannten");
ok(!!handQuelle && /gmailEditDetectedAppt/.test(handQuelle) && !/gcApi|gcalQuickCreateInline|calendar\.google/.test(handQuelle),
  "„selbst erfassen“ trägt etwas ein, statt nur das Formular zu öffnen");

// ═══ 7. Die KI bekommt nur den aktuellen Teil ═════════════════════════════
const aiQuelle = schneide("async function aiDetectAppt(subject, text, schonBereinigt)", "function gmailDetectAppointment(o)");
ok(!!aiQuelle, "aiDetectAppt() nicht gefunden");
if (aiQuelle) {
  ok(/schonBereinigt \? String\(text\|\|""\) : apptLesbarerText\(text\)/.test(aiQuelle),
    "der KI wird weiterhin der ganze Text samt Zitat vorgelegt");
  ok(/VERSANDdaten, keine Termine/.test(aiQuelle),
    "die KI wird nicht ausdrücklich auf Zitatdaten hingewiesen");
}
const detectQuelle = schneide("function gmailDetectAppointment(o)", "/* Kein Termin im aktuellen Text");
ok(!!detectQuelle, "gmailDetectAppointment() nicht gefunden");
if (detectQuelle) {
  ok(/apptHasDateHint\(subject\+"\\n"\+bodyLesbar\)/.test(detectQuelle),
    "der Vorfilter schaut weiterhin ins Zitat und löst dort KI-Aufrufe aus");
  ok(/gmailZitatBefund\(/.test(detectQuelle),
    "ohne Treffer im aktuellen Text wird der Zitatfund nicht gemeldet");
  ok(/x\.quelle = quelle/.test(detectQuelle),
    "die Herkunft (KI oder Regelweg) wird nicht mitgeführt");
}

// ═══ 8. Der ECHTE Weg: gmailDetectAppointment mit Anhang ══════════════════
/*
 * Der Regelweg allein reicht als Nachweis nicht. gmailDetectAppointment hängt
 * den Anhang-Inhalt an den Body an — und hängte ihn vorher an den GANZEN Body,
 * also hinter dessen Zitat. Die Trennung schnitt an der Zitatmarke und warf den
 * Anhang gleich mit weg: ein Termin, der nur im angehängten PDF stand, war bei
 * jeder Antwortmail verloren. Gemessen am Beispiel „Details stehen im Anhang"
 * + Zitat + Anhang „Besprechung am 15. September 2026 um 10:30": erkannt wurde
 * nichts, stattdessen erschien die Rückfragekarte.
 *
 * Zweitens lief der synchrone Zweig (kein Datumshinweis, kein Anhang) ohne
 * eigenen Anstoss: der Zwischenspeicher trug die Rückfrage, gezeichnet wurde
 * sie aber erst beim nächsten Rendern aus anderem Anlass. Beim ersten Öffnen
 * der Mail blieb die Karte weg. Deshalb wird hier auch gezählt, wie oft
 * rerender gerufen wurde.
 */
const integrationQuelle = schneide("function apptPad(n)", "function apptWhenText(a)");
ok(!!integrationQuelle, "der Block bis gmailZitatBefund wurde nicht gefunden");
if (integrationQuelle) {
  const lauf = (fall) => {
    const GM = { _apptCache: {}, open: null };
    let rerenderRufe = 0;
    const rerender = () => { rerenderRufe++; };
    const api = new Function("Date", "GM", "rerender", "htmlToText", "gmailGatherAttachText", "window",
      integrationQuelle + "\nreturn { gmailDetectAppointment };")(
      FestesDate, GM, rerender, () => "", () => Promise.resolve(fall.attachText || ""), {});
    api.gmailDetectAppointment({
      id: "m1", subject: fall.subject, text: fall.bodyText, html: "",
      attachRefs: fall.hatAnhang ? [{ id: "a1", filename: "anhang.pdf" }] : [], attachText: null,
    });
    return new Promise((r) => setTimeout(() => {
      const c = GM._apptCache.m1;
      r({ cache: c, rerenderRufe,
        termin: Array.isArray(c) && c[0] ? { datum: c[0].startISO.slice(0, 10), zeit: c[0].startISO.slice(11, 16) } : null,
        unsicher: !!(c && c.unsicher) });
    }, 30));
  };
  for (const f of fixtures.integration) {
    const r = await lauf(f);
    if (f.erwartet === "rueckfrage") {
      ok(r.unsicher && !r.termin, `${f.name}: keine Rückfragekarte (stattdessen ${JSON.stringify(r.termin)})`);
      ok(r.rerenderRufe > 0,
        `${f.name}: der Zwischenspeicher wird gesetzt, aber nichts neu gezeichnet — beim ersten Öffnen bliebe die Karte weg`);
    } else {
      ok(!!r.termin, `${f.name}: gar kein Termin erkannt (erwartet ${f.erwartet.datum} ${f.erwartet.zeit})`);
      if (r.termin) {
        ok(r.termin.datum === f.erwartet.datum && r.termin.zeit === f.erwartet.zeit,
          `${f.name}: erkannt ${r.termin.datum} ${r.termin.zeit}, erwartet ${f.erwartet.datum} ${f.erwartet.zeit}`);
      }
      ok(r.rerenderRufe > 0, `${f.name}: nach dem Erkennen wird nicht neu gezeichnet`);
    }
  }
}

// Und der Weg selbst: Body und Anhang getrennt bereinigen, nie die Kombination.
if (detectQuelle) {
  ok(/var bodyLesbar = apptLesbarerText\(bodyText\)/.test(detectQuelle),
    "der Body wird nicht einmalig und für sich bereinigt");
  ok(/var anhangLesbar = attachText \? apptLesbarerText\(attachText\) : ""/.test(detectQuelle),
    "der Anhang-Inhalt wird nicht unabhängig bereinigt");
  ok(/aiDetectAppt\(subject, lesbar, true\)/.test(detectQuelle) && /ruleDetectAppt\(subject, lesbar, true\)/.test(detectQuelle),
    "die Trennung läuft ein zweites Mal über die Kombination — der Anhang fiele wieder weg");
  ok(/setTimeout\(rerender, 0\)/.test(detectQuelle),
    "der synchrone Zweig stösst kein Neuzeichnen an");
  ok(/gmailZitatBefund\(bodyText\)/.test(detectQuelle) && !/gmailZitatBefund\(text\)/.test(detectQuelle),
    "die Rückfrage speist sich aus der Kombination statt aus dem Body");
}
// Der Schalter muss beide Wege können: ohne ihn wird weiterhin bereinigt.
{
  const roh = "Termin am 20.09.2026 um 10:00\n\nAm 04.09.2026 um 21:42 schrieb X:\n> alt 01.01.2026 um 07:00";
  const ohneSchalter = api.ruleDetectAppt("", roh);
  ok(ohneSchalter && ohneSchalter.startISO.slice(0, 10) === "2026-09-20",
    "ohne Schalter wird nicht mehr bereinigt — der alte Aufrufweg bräche");
  const mitSchalter = api.ruleDetectAppt("", "Termin am 20.09.2026 um 10:00", true);
  ok(mitSchalter && mitSchalter.startISO.slice(0, 10) === "2026-09-20",
    "mit Schalter wird bereits bereinigter Text nicht mehr gelesen");
}

ok(/name="quantus-build"[^>]*termin-zitat-getrennt/.test(index),
  "die Bau-Kennung nennt die Änderung nicht");

if (luecken.length) {
  console.error(`gmail termin zitat: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`gmail termin zitat: ${checks} Pruefungen bestanden`);
