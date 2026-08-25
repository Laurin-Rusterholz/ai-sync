/*
 * F-25 M1 — der kanonische Schluessel fuer Anhangstexte.
 *
 * Der alte Bauplan setzte kind, entityId und fileId ROH zwischen "__":
 *     attachment-text__${kind}__${entityId}__${fileId}
 * Zwei Brueche zugleich:
 *
 *   ZEICHENRAUM  Seit F-23 kann eine Entitaets-Id von aussen kommen —
 *                plInboxApply reicht den polaris/inbox-Schluessel als forcedId
 *                an createEntity weiter, ohne Bereinigung (index.html:112902 /
 *                :14135). RTDB-Schluessel verbieten nur . # $ [ ] /;
 *                Leerzeichen, Umlaute, @ + : , sind erlaubt und landeten so im
 *                Blob-Schluessel. Am echten Pfad gemessen entstand etwa
 *                "attachment-text__meeting__Besprechung 2026-08-25__f_abc".
 *
 *   TRENNER      Eine Id, die selbst "__" enthaelt, sprengt die Segmentzahl.
 *                "a__b"+"c" und "a"+"b__c" ergaben DIESELBE Zeichenkette — der
 *                Schluessel war nicht eindeutig zerlegbar.
 *
 * Jedes Segment wird jetzt kodiert: UTF-8 → base64url ohne Padding, danach "_"
 * zu "~". Ergebnisalphabet [A-Za-z0-9~-]; "__" kann in keinem Segment mehr
 * entstehen. Altformate werden weiterhin GELESEN, aber nie geschrieben.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

function schnipsel(name) {
  const a = index.indexOf("\nfunction " + name + "(");
  assert.ok(a > 0, `${name} wurde in public/index.html nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
// Die ECHTEN Funktionen, gegen die Browser-Globalen von Node.
const NAMEN = ["_attSegEncode", "_attSegDecode", "_textBlobKey", "_textBlobKeyLegacyRaw", "_textBlobKeyLegacyColon"];
const api = new Function("TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error",
  NAMEN.map(schnipsel).join("\n") + "\nreturn { " + NAMEN.join(", ") + " };")(
  TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error);
const { _attSegEncode, _attSegDecode, _textBlobKey, _textBlobKeyLegacyRaw, _textBlobKeyLegacyColon } = api;

// ── 1. Roundtrip ueber genau die Faelle, die den alten Bau zerbrachen ───
const FAELLE = [
  "Besprechung 2026-08-25",   // Leerzeichen
  "Übergabe",                 // Unicode
  "kick-off@kunde",           // @
  "n8n:2026:08",              // :
  "a__b",                     // der Trenner selbst
  "__vorn",
  "hinten__",
  "a,b", "meeting+1", "f_abc_1234", "note", "einfach",
  "ä ö ü ß / \\ # $ [ ] . %",  // alles, was RTDB verbietet oder erlaubt
  "🙂 Emoji",
];
for (const f of FAELLE) {
  const enc = _attSegEncode(f);
  ok(_attSegDecode(enc) === f, `Roundtrip verloren fuer ${JSON.stringify(f)} (enc=${enc})`);
  ok(/^[A-Za-z0-9~-]+$/.test(enc),
    `das Ergebnisalphabet ist verletzt fuer ${JSON.stringify(f)}: ${JSON.stringify(enc)}`);
  ok(!enc.includes("__"), `das kodierte Segment enthaelt den Trenner: ${JSON.stringify(enc)}`);
  ok(!enc.includes("_"), `das kodierte Segment enthaelt "_" — dann ist "__" wieder moeglich: ${JSON.stringify(enc)}`);
  ok(!/=/.test(enc), `das kodierte Segment traegt Padding: ${JSON.stringify(enc)}`);
}

// ── 2. Leere Grenzfaelle werden abgewiesen ─────────────────────────────
// wirft() liefert einen Wahrheitswert, damit ein Fehlschlag in die Luecken-Liste
// wandert statt den Lauf abzubrechen — sonst saehe man nur den ersten.
const wirft = (fn) => { try { fn(); return false; } catch (e) { return true; } };
for (const [wert, was] of [["", "leere Zeichenkette"], [null, "null"], [undefined, "undefined"]]) {
  ok(wirft(() => _attSegEncode(wert)), `encode nimmt ${was} an`);
  ok(wirft(() => _attSegDecode(wert)), `decode nimmt ${was} an`);
}
ok(wirft(() => _attSegDecode("nicht base64!")), "decode nimmt ein fremdes Alphabet an");
ok(wirft(() => _textBlobKey("note", "", "f1")), "der Bauplan nimmt ein leeres Segment an");

// ── 3. Kollisionsfreiheit — der eigentliche Punkt ──────────────────────
{
  // Der alte Bau warf diese beiden Tripel auf DENSELBEN Schluessel.
  const a = _textBlobKey("meeting", "a__b", "c");
  const b = _textBlobKey("meeting", "a", "b__c");
  ok(a !== b,
    `(a__b, c) und (a, b__c) ergeben denselben Schluessel: ${a}`);
  ok(_textBlobKeyLegacyRaw("meeting", "a__b", "c") === _textBlobKeyLegacyRaw("meeting", "a", "b__c"),
    "der Altbau kollidiert NICHT mehr — dann waere die Begruendung dieses Tests hinfaellig");

  // dieselbe Verwechslung an der anderen Segmentgrenze
  ok(_textBlobKey("k__e", "n", "f") !== _textBlobKey("k", "e__n", "f"),
    "(k__e, n) und (k, e__n) kollidieren");

  // und ueber eine breite Menge hinweg
  const tripel = [];
  for (const k of ["note", "meeting", "no__te"]) {
    for (const e of FAELLE) {
      for (const f of ["f_1", "f__1"]) tripel.push([k, e, f]);
    }
  }
  const gesehen = new Map();
  for (const [k, e, f] of tripel) {
    const key = _textBlobKey(k, e, f);
    const sig = JSON.stringify([k, e, f]);
    if (gesehen.has(key) && gesehen.get(key) !== sig) {
      ok(false, `Kollision: ${gesehen.get(key)} und ${sig} ergeben ${key}`);
    }
    gesehen.set(key, sig);
  }
  ok(gesehen.size === tripel.length,
    `${tripel.length} Tripel ergaben nur ${gesehen.size} verschiedene Schluessel`);
}

// ── 4. Aufbau: exakt vier Segmente, eindeutig zerlegbar ────────────────
for (const [k, e, f] of [["meeting", "a__b", "c"], ["note", "Übergabe", "f_abc_1234"], ["task", "n8n:1", "f__x"]]) {
  const key = _textBlobKey(k, e, f);
  const teile = key.split("__");
  ok(teile.length === 4, `${key} zerfaellt in ${teile.length} Segmente statt vier`);
  ok(teile[0] === "attachment-text", `Segment 1 lautet "${teile[0]}" statt attachment-text`);
  ok(_attSegDecode(teile[1]) === k && _attSegDecode(teile[2]) === e && _attSegDecode(teile[3]) === f,
    `${key} laesst sich nicht verlustfrei zurueckrechnen`);
  ok(!key.includes("/"), `${key} enthaelt einen Slash`);
  ok(/^attachment-text__[A-Za-z0-9~-]+__[A-Za-z0-9~-]+__[A-Za-z0-9~-]+$/.test(key),
    `${key} passt nicht auf die strenge Form`);
}

// ── 5. Altformate bleiben LESBAR ───────────────────────────────────────
{
  ok(_textBlobKeyLegacyRaw("note", "n1", "f1") === "attachment-text__note__n1__f1",
    "das rohe Altformat wurde veraendert");
  ok(_textBlobKeyLegacyColon("note", "n1", "f1") === "attachment-text:note:n1:f1",
    "das Doppelpunkt-Altformat wurde veraendert");
  const laden = ohneKommentare(index.slice(index.indexOf("window._loadExtractedText = async function"),
    index.indexOf("window._loadExtractedText = async function") + 1400));
  const reihenfolge = ["_textBlobKey(kind, entityId, fileId)", "_textBlobKeyLegacyRaw(", "_textBlobKeyLegacyColon("]
    .map((n) => laden.indexOf(n));
  ok(reihenfolge.every((i) => i >= 0), "eines der drei Formate fehlt im Lesepfad");
  ok(reihenfolge[0] < reihenfolge[1] && reihenfolge[1] < reihenfolge[2],
    `die Lesereihenfolge stimmt nicht: kodiert/raw/colon liegen bei ${reihenfolge.join(", ")}`);
}

// ── 6. Geschrieben wird AUSSCHLIESSLICH das kodierte Format ────────────
{
  const quelle = ohneKommentare(index);
  // Jeder Schreibvorgang auf einen Anhangstext geht ueber _textBlobKey oder
  // ueber fileObj.textKey, das ebenfalls daraus stammt.
  const schreiben = ohneKommentare(index.slice(index.indexOf("window._saveExtractedText = async function"),
    index.indexOf("window._saveExtractedText = async function") + 1600));
  ok(/const key = _textBlobKey\(kind, entityId, fileId\);/.test(schreiben),
    "der Schreibpfad baut den Schluessel nicht mehr ueber _textBlobKey");
  ok(!/LegacyRaw|LegacyColon/.test(schreiben),
    "der Schreibpfad greift auf ein Altformat zurueck — im Freeze wird nichts umgeschrieben");
  ok(/fileObj\.textKey = _textBlobKey\(kind, entityId, fileObj\.id\);/.test(quelle),
    "der gemerkte textKey stammt nicht aus dem kanonischen Bauplan");
  // die Altbauer existieren, werden aber nirgends zum Schreiben benutzt
  for (const n of ["_textBlobKeyLegacyRaw", "_textBlobKeyLegacyColon"]) {
    const treffer = [...quelle.matchAll(new RegExp("netlifyBlobPut\\([^)]*" + n, "g"))];
    ok(treffer.length === 0, `${n} wird in einem Schreibvorgang verwendet`);
  }
  ok(!/`attachment-text__\$\{kind\}__\$\{entityId\}__\$\{fileId\}`/.test(
    ohneKommentare(schnipsel("_textBlobKey"))),
    "_textBlobKey baut weiterhin den rohen Schluessel");
}

if (luecken.length) {
  console.error("F-25 ATTACHMENT KEY CODEC — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 attachment key codec: ok (${checks} Pruefungen)`);
