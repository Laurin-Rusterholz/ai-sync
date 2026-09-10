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

const QUELLE = [einzeiler("parseAddr"), einzeiler("splitAddrs"), block("gmailReplyTargets")].join("\n");
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

console.log(`gmail antwort-empfaenger: ok (${checks} Pruefungen)`);
