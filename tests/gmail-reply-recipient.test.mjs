/*
 * Antworten auf eine SELBST GESENDETE Mail gingen an einen selbst.
 * ---------------------------------------------------------------------------
 * Befund (10.09.2026): Wer in Quantus eine Mail aus „Gesendet" oeffnete und auf
 * „Antworten" drueckte, fand die eigene Adresse (contact@laurin-rusterholz.ch)
 * im An-Feld. Die Antwort ging damit an einen selbst — der Gegenkontakt hoerte
 * nichts, und im Thread stand eine Nachricht, die niemanden erreichte.
 *
 * Die Ursache war eine Annahme, die nur fuer eingehende Mail stimmt: Der
 * Gegenkontakt stehe im Absender (`to: parseAddr(o.from).email`). Bei einer
 * gesendeten Mail ist der Absender aber man selbst; der Gegenkontakt steht in
 * An (und bei mehreren Beteiligten zusaetzlich in Kopie).
 *
 * Geprueft wird die ECHTE Regel aus public/index.html (gmailReplyTargets), an
 * allen drei Faellen, die im Betrieb vorkommen:
 *   1. gewoehnliche eingehende Mail (Antworten und „Allen antworten"),
 *   2. selbst gesendete Mail (der gemeldete Fehler),
 *   3. Thread mit mehreren Beteiligten (niemand faellt weg, niemand doppelt).
 * Dazu: Die eigene Adresse taucht NIE als Empfaenger auf — ausser die Mail
 * ging wirklich nur an einen selbst.
 *
 * NACHTRAG (10.09.2026, Live-Abnahme). Die Regel allein genuegte nicht — der
 * Wert muss auch im Feld ANKOMMEN. Drei weitere Befunde, hier mitgeprueft:
 *
 *   · Das An-Feld ging leer auf. Ohne geladenes Profil (loadProfile schluckt
 *     seinen Fehler still) hielt die Regel eine gesendete Mail fuer eine
 *     fremde und nahm den Absender — bei einer Nachricht ganz ohne
 *     From-Kopfzeile blieb dann gar nichts uebrig.
 *   · Ein Anzeigename mit Komma ("Muster, Anna" <anna@muster.ch>) zerfiel
 *     beim Zerlegen der Empfaengerzeile in zwei Bruchstuecke.
 *   · Entwuerfe zeigten «adresse <adresse>», bei mehreren Empfaengern
 *     «a, b <a, b>»: toName trug die Adresse selbst.
 *
 * Deshalb prueft dieser Test nicht nur die Regel, sondern die ganze Kette bis
 * zum WIRKLICHEN Markup des An-Feldes (row('gmlTo', …) aus gmailCompose).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const ok = (bedingung, text) => { assert.ok(bedingung, text); checks++; };
const eq = (a, b, text) => { assert.equal(a, b, text); checks++; };

// ── Die echten Funktionen herausschneiden ─────────────────────────────────
function einzeiler(name) {
  const kopf = "\n  function " + name + "(";
  const a = index.indexOf(kopf);
  ok(a > 0, `${name}() wurde in public/index.html nicht gefunden`);
  return index.slice(a, index.indexOf("\n", a + 1));
}
function block(name) {
  const kopf = "\n  function " + name + "(";
  const a = index.indexOf(kopf);
  ok(a > 0, `${name}() wurde in public/index.html nicht gefunden`);
  const ende = "\n  }\n";
  return index.slice(a, index.indexOf(ende, a) + ende.length);
}

const QUELLE = [einzeiler("parseAddr"), block("gmlSplitList"), einzeiler("splitAddrs"), block("gmailReplyTargets")].join("\n");
const gmailReplyTargets = new Function(QUELLE + "\nreturn gmailReplyTargets;")();

const ICH = "contact@laurin-rusterholz.ch";

// ── 1. Gewoehnliche eingehende Mail ───────────────────────────────────────
{
  const mail = {
    from: "Anna Muster <anna@muster.ch>",
    to: ICH,
    cc: "",
  };
  const antwort = gmailReplyTargets(mail, ICH, false);
  eq(antwort.to, "anna@muster.ch", "die Antwort geht nicht an die Absenderin");
  eq(antwort.cc, "", "eine einfache Antwort setzt eine Kopie");
  ok(antwort.ownMessage === false, "eine fremde Mail gilt als eigene");
  ok(!antwort.to.includes(ICH), "die eigene Adresse steht im An-Feld");
}

// ── 2. Selbst gesendete Mail — der gemeldete Fehler ───────────────────────
{
  const gesendet = {
    from: "Laurin Rusterholz <" + ICH + ">",
    to: "Kundschaft GmbH <info@kundschaft.ch>",
    cc: "",
  };
  const antwort = gmailReplyTargets(gesendet, ICH, false);
  eq(antwort.to, "info@kundschaft.ch",
    `die Antwort auf die eigene Mail geht an „${antwort.to}" statt an den urspruenglichen Empfaenger`);
  ok(antwort.to !== ICH, "die Antwort adressiert weiterhin einen selbst");
  ok(antwort.ownMessage === true, "die eigene Mail wird nicht als eigene erkannt");
}

// ── 3. Gesendete Mail an mehrere — alle bleiben Gegenkontakt ──────────────
{
  const gesendet = {
    from: ICH,
    to: "info@kundschaft.ch, Zweite Person <zwei@kundschaft.ch>",
    cc: "buchhaltung@kundschaft.ch",
  };
  const einfach = gmailReplyTargets(gesendet, ICH, false);
  eq(einfach.to, "info@kundschaft.ch, zwei@kundschaft.ch",
    `die Antwort erreicht nicht alle urspruenglichen Empfaenger: ${einfach.to}`);
  eq(einfach.cc, "", "die einfache Antwort zieht die Kopie mit hinein");

  const allen = gmailReplyTargets(gesendet, ICH, true);
  eq(allen.to, "info@kundschaft.ch, zwei@kundschaft.ch", "„Allen antworten“ verliert Empfaenger");
  eq(allen.cc, "buchhaltung@kundschaft.ch", "„Allen antworten“ verliert die Kopie");
}

// ── 4. Gesendete Mail NUR mit Kopie-Empfaengern ───────────────────────────
{
  const gesendet = { from: ICH, to: "", cc: "info@kundschaft.ch" };
  const antwort = gmailReplyTargets(gesendet, ICH, false);
  eq(antwort.to, "info@kundschaft.ch",
    "ohne An-Empfaenger wird die Kopie nicht als Gegenkontakt gelesen");
}

// ── 5. Thread mit mehreren Beteiligten (eingehend) ────────────────────────
{
  const mail = {
    from: "Anna Muster <anna@muster.ch>",
    to: ICH + ", Bernd Beispiel <bernd@beispiel.ch>",
    cc: "Clara Cordes <clara@cordes.ch>, ANNA@muster.ch",
  };
  const einfach = gmailReplyTargets(mail, ICH, false);
  eq(einfach.to, "anna@muster.ch", "die einfache Antwort geht nicht nur an die Absenderin");
  eq(einfach.cc, "", "die einfache Antwort setzt eine Kopie");

  const allen = gmailReplyTargets(mail, ICH, true);
  eq(allen.to, "anna@muster.ch", "„Allen antworten“ verliert die Absenderin");
  eq(allen.cc, "bernd@beispiel.ch, clara@cordes.ch",
    `„Allen antworten" trifft den falschen Kreis: ${allen.cc}`);
  ok(!allen.cc.toLowerCase().includes(ICH), "die eigene Adresse steht in der Kopie");
  ok(!/anna@muster\.ch/i.test(allen.cc),
    "die Absenderin steht zusaetzlich in der Kopie — die Adresse kam in anderer Schreibweise erneut vor");
}

// ── 6. Wirklich nur an sich selbst: kein leeres Feld ──────────────────────
{
  const notiz = { from: ICH, to: ICH, cc: "" };
  const antwort = gmailReplyTargets(notiz, ICH, false);
  eq(antwort.to, ICH, "eine Notiz an sich selbst laesst das An-Feld leer");
}

// ── 7. Profil noch nicht geladen: Verhalten wie bisher ────────────────────
{
  const mail = { from: "anna@muster.ch", to: ICH, cc: "" };
  eq(gmailReplyTargets(mail, "", false).to, "anna@muster.ch",
    "ohne bekannte eigene Adresse geht die Antwort nicht mehr an den Absender");
}

// ── 8. Gross-/Kleinschreibung und Doppelte ────────────────────────────────
{
  const gesendet = {
    from: "Contact@Laurin-Rusterholz.CH",
    to: "Info@Kundschaft.ch, info@kundschaft.ch, CONTACT@laurin-rusterholz.ch",
    cc: "",
  };
  const antwort = gmailReplyTargets(gesendet, ICH, false);
  eq(antwort.to, "Info@Kundschaft.ch",
    `Schreibweise oder Doppelte werden nicht behandelt: ${antwort.to}`);
}

// ── 9. Alle Antwort-Wege benutzen dieselbe Regel ──────────────────────────
// Sonst haette die Korrektur nur einen Knopf erreicht — „3 Antworten", die
// KI-Antwort und die Antwort aus einem Element heraus adressierten weiter den
// Absender.
{
  const wege = [
    ["replyInternal", /var ziele = gmailReplyTargets\(o, gmailMe\(\), all\);/],
    ["gmailReplyWithContext", /title:"KI-Antwort mit Kontext", to:gmailReplyTargets\(o, gmailMe\(\), false\)\.to/],
    ["gmailUseReplyVariant", /var email=gmailReplyTargets\(o, gmailMe\(\), false\)\.to;/],
    ["gmailReplyFromEntity", /title:"↩︎ Antwort", to:gmailReplyTargets\(o, gmailMe\(\), false\)\.to/],
  ];
  wege.forEach(([name, re]) => {
    ok(re.test(index), `${name} bestimmt den Empfaenger nicht ueber gmailReplyTargets`);
  });
  // Die Antwort aus einem Element heraus braucht An/Kopie der Originalmail —
  // ohne sie kann sie den Gegenkontakt einer gesendeten Mail nicht kennen.
  ok(/var o = \{ id:msg\.id, threadId:msg\.threadId, from:h\.from\|\|"", to:h\.to\|\|"", cc:h\.cc\|\|""/.test(index),
    "gmailReplyFromEntity liest An/Kopie der Nachricht nicht mehr mit");
}

// ── 10. Die Kette bis ins Feld: prefill.to landet wirklich im An-Feld ─────
// Der Live-Befund war ein LEERES An-Feld — die Regel allein beweist also
// nichts. Hier laeuft der echte Feldbauer aus gmailCompose (row) mit dem
// echten esc gegen das Ergebnis der echten Regel.
{
  const escSrc = index.slice(index.indexOf("const esc = (s) =>"), index.indexOf("\n", index.indexOf("const esc = (s) =>")));
  const rowStart = index.indexOf("\n    function row(id,label,value,o){ o=o||{};");
  ok(rowStart > 0, "der Feldbauer row() aus gmailCompose wurde nicht gefunden");
  const rowEnde = "\n    }\n";
  const rowSrc = index.slice(rowStart, index.indexOf(rowEnde, rowStart) + rowEnde.length);
  const row = new Function(escSrc + "\n" + rowSrc + "\nreturn row;")();

  const feld = (wert) => row("gmlTo", "An", wert, { ph: "Name oder E-Mail eingeben…", tail: "", ac: true });

  const gesendet = { from: "Laurin Rusterholz <" + ICH + ">", to: "Kundschaft GmbH <info@kundschaft.ch>", cc: "" };
  const html = feld(gmailReplyTargets(gesendet, ICH, false).to);
  ok(/id="gmlTo"/.test(html), "das An-Feld traegt seine Kennung nicht mehr");
  ok(/value="info@kundschaft\.ch"/.test(html),
    `das An-Feld kommt nicht gefuellt heraus: ${(/value="([^"]*)"/.exec(html) || [])[1]}`);
  ok(!/value=""/.test(html), "das An-Feld geht leer auf");

  // Und der Weg dorthin ist wirklich verdrahtet: gmailCompose gibt prefill.to
  // an genau dieses Feld weiter, replyInternal fuellt prefill.to aus der Regel.
  ok(/row\('gmlTo','An',prefill\.to,/.test(index),
    "gmailCompose fuellt das An-Feld nicht mehr aus prefill.to");
  ok(/to: ziele\.to, cc: ziele\.cc, subject: subject,/.test(index),
    "replyInternal gibt das Ergebnis der Regel nicht an den Composer weiter");
}

// ── 11. Ohne geladenes Profil bleibt die Antwort richtig ──────────────────
// loadProfile() schluckt seinen Fehler still (GM.profile=null). Fiel er aus,
// galt die eigene Mail als fremde — und die Antwort ging wieder an einen
// selbst. Die eigene Adresse kommt deshalb auch aus dem Anmeldestand.
{
  ok(/\(GM\.profile && GM\.profile\.emailAddress\) \|\| \(GM\.status && GM\.status\.email\)/.test(index),
    "gmailMe() kennt nur das Profil — faellt es aus, adressiert die Antwort wieder einen selbst");
}

// ── 12. Kein leeres An-Feld, was auch immer die Nachricht hergibt ─────────
{
  const faelle = [
    ["ohne From-Kopfzeile, ohne Profil", { from: "", to: "info@kundschaft.ch", cc: "" }, "", "info@kundschaft.ch"],
    ["ohne From-Kopfzeile, mit Profil", { from: "", to: "info@kundschaft.ch", cc: "" }, ICH, "info@kundschaft.ch"],
    ["nur Kopie-Empfaenger", { from: ICH, to: "", cc: "info@kundschaft.ch" }, ICH, "info@kundschaft.ch"],
    ["gar nichts ausser mir", { from: ICH, to: ICH, cc: "" }, ICH, ICH],
  ];
  faelle.forEach(([was, mail, me, erwartet]) => {
    const t = gmailReplyTargets(mail, me, false).to;
    eq(t, erwartet, `${was}: das An-Feld wird ${t ? "falsch" : "leer"} gefuellt (${JSON.stringify(t)})`);
  });
}

// ── 13. Anzeigename mit Komma zerfaellt nicht mehr ────────────────────────
{
  const gmlSplitList = new Function(block("gmlSplitList") + "\nreturn gmlSplitList;")();
  eq(gmlSplitList('"Muster, Anna" <anna@muster.ch>, bernd@beispiel.ch').length, 2,
    "eine Empfaengerzeile mit Komma im Anzeigenamen wird falsch zerlegt");

  const mail = { from: '"Muster, Anna" <anna@muster.ch>', to: ICH, cc: "" };
  eq(gmailReplyTargets(mail, ICH, false).to, "anna@muster.ch",
    "ein Anzeigename mit Komma landet als Bruchstueck im An-Feld");

  const gesendet = { from: ICH, to: '"Kundschaft GmbH, Einkauf" <info@kundschaft.ch>, zwei@kundschaft.ch', cc: "" };
  eq(gmailReplyTargets(gesendet, ICH, false).to, "info@kundschaft.ch, zwei@kundschaft.ch",
    "bei mehreren Empfaengern mit Komma-Namen stimmt die Liste nicht");
}

// ── 14. Entwuerfe: «adresse <adresse>» verschwindet, ohne Daten anzufassen ─
{
  const gmlToName = new Function(
    [einzeiler("parseAddr"), block("gmlSplitList"), einzeiler("splitAddrs"), block("gmlToName")].join("\n")
    + "\nreturn gmlToName;")();
  eq(gmlToName("adresse@x.ch"), "", "eine nackte Adresse wird als Anzeigename gespeichert");
  eq(gmlToName("a@x.ch, b@x.ch"), "", "eine ganze Empfaengerliste wird als Anzeigename gespeichert");
  eq(gmlToName("Anna Muster <anna@muster.ch>"), "Anna Muster", "ein echter Anzeigename geht verloren");
  eq(gmlToName('"Muster, Anna" <anna@muster.ch>'), "Muster, Anna",
    "ein Anzeigename mit Komma geht verloren");

  const gmlDraftTo = new Function(block("gmlDraftTo") + "\nreturn gmlDraftTo;")();
  // Genau die Entwuerfe, die heute schon in der Datenbank liegen — sie werden
  // nur ANDERS ANGEZEIGT, nicht angefasst.
  const alt = { to: "adresse@x.ch", toName: "adresse@x.ch" };
  eq(gmlDraftTo(alt).label, "adresse@x.ch", "der Alt-Entwurf zeigt seinen Empfaenger nicht");
  eq(gmlDraftTo(alt).name, "", "der Alt-Entwurf zeigt weiterhin «adresse <adresse>»");
  const altListe = { to: "a@x.ch, b@x.ch", toName: "a@x.ch, b@x.ch" };
  eq(gmlDraftTo(altListe).name, "", "die Empfaengerliste erscheint weiterhin doppelt");
  eq(gmlDraftTo(altListe).label, "a@x.ch, b@x.ch", "die Empfaengerliste fehlt in der Anzeige");
  const echt = { to: "anna@muster.ch", toName: "Anna Muster" };
  eq(gmlDraftTo(echt).name, "Anna Muster", "ein echter Anzeigename verschwindet aus der Anzeige");
  eq(gmlDraftTo(echt).addr, "anna@muster.ch", "die Adresse fehlt neben dem Namen");
  // Der Entwurf selbst bleibt unveraendert — die Anzeige rechnet nur.
  eq(JSON.stringify(alt), JSON.stringify({ to: "adresse@x.ch", toName: "adresse@x.ch" }),
    "die Anzeige veraendert den gespeicherten Entwurf");
  // Und beim Speichern entsteht der Fehler gar nicht erst.
  ok(/toName: gmlToName\(to\),/.test(index) && !/toName: toA\.name/.test(index),
    "das Speichern legt weiterhin die Adresse als Anzeigenamen ab");
}

console.log(`gmail antwort-empfaenger: ok (${checks} Pruefungen)`);
