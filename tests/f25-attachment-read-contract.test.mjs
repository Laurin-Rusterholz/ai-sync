/*
 * F-25 M1a — ein Lesekey-Vertrag, ein Decoder, eine Bytegrenze.
 *
 * Befund nach M1: der Lesepfad hatte ZWEI Schluesselkonstruktionen. Die
 * Schleife ueber netlifyBlobGet probierte alle drei Formate, der direkte
 * fetch-Rueckfall danach aber nur den kanonischen. Steckte der Helper im
 * Backoff (result.skipped) oder fehlte er, fand der Rueckfall keinen einzigen
 * Altstand mehr — der Text war unauffindbar, obwohl er dalag.
 *
 * Dazu zwei Punkte, die M1 offen liess:
 *   Kanonizitaet  base64 hat Alias-Formen ("AA" und "AB" ergeben beide 0x00).
 *                 Ohne Pruefung gaebe es fuer denselben Inhalt mehrere gueltige
 *                 Schluessel — wieder Mehrdeutigkeit.
 *   Bytegrenze    Der Schluessel war nirgends begrenzt. Gemessen wird in
 *                 UTF-8-BYTES, nicht in JS-Zeichen.
 *
 * Getestet wird die ECHTE _loadExtractedText gegen Attrappen.
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
const wirft = (fn) => { try { fn(); return false; } catch (e) { return true; } };
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

function schnipsel(name, praefix = "function ") {
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
const BAUER = ["_attSegEncode", "_attSegDecode", "_textBlobKey", "_textBlobKeyLegacyRaw",
  "_textBlobKeyLegacyColon", "attachmentReadKeys", "_attKeyByteLength"];
const BAUER_SRC = BAUER.map((n) => schnipsel(n)).join("\n");
const codec = new Function("TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error",
  BAUER_SRC + "\nreturn { " + BAUER.join(", ") + " };")(
  TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error);
const { _attSegEncode, _attSegDecode, _textBlobKey, attachmentReadKeys, _attKeyByteLength } = codec;

// Die ECHTE Lesefunktion, mit steuerbarem Helper und steuerbarem fetch.
function laden({ helperVerfuegbar = true, helper = () => ({ skipped: true }), direkt = () => null } = {}) {
  const log = { helper: [], direkt: [] };
  const a = index.indexOf("window._loadExtractedText = async function");
  const src = index.slice(a, index.indexOf("\n};", a) + 3);
  const fn = new Function("window", "APP", "netlifyBlobGet", "fetch", "console",
    "TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error",
    BAUER_SRC + "\n" + src + "\nreturn window._loadExtractedText;")(
    {}, { state: { settings: { storage: { getUrl: "https://x/{key}" } } } },
    helperVerfuegbar ? (async (k) => { log.helper.push(k); return helper(k); }) : undefined,
    async (url) => {
      const k = decodeURIComponent(url.replace("https://x/", ""));
      log.direkt.push(k);
      const t = direkt(k);
      return t === null
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ text: t }) };
    },
    { log() {}, warn() {} },
    TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error);
  return { fn, log };
}

const K = "meeting", E = "n8n:2026:08", F = "f_abc_1234";
const [ENC, RAW, COLON] = attachmentReadKeys(K, E, F);

// ── a) Helper im Backoff, kanonisch 404, RAW 200 -> Text sichtbar ───────
{
  const h = laden({ helper: () => ({ skipped: true }), direkt: (k) => (k === RAW ? "aus dem Altformat" : null) });
  const text = await h.fn(K, E, F);
  ok(text === "aus dem Altformat",
    `a) der Altstand unter dem rohen Schluessel blieb unauffindbar (bekommen: ${JSON.stringify(text)}) — ` +
    "der Direkt-Rueckfall probierte nur den kanonischen Schluessel");
  ok(h.log.direkt.length === 2 && h.log.direkt[0] === ENC && h.log.direkt[1] === RAW,
    `a) der Direkt-Rueckfall probierte ${JSON.stringify(h.log.direkt)}`);
}

// ── b) Helper im Backoff, kanonisch+raw 404, COLON 200 -> Text sichtbar ─
{
  const h = laden({ helper: () => ({ skipped: true }), direkt: (k) => (k === COLON ? "aus dem Doppelpunkt-Format" : null) });
  const text = await h.fn(K, E, F);
  ok(text === "aus dem Doppelpunkt-Format",
    `b) der Altstand unter dem Doppelpunkt-Schluessel blieb unauffindbar (bekommen: ${JSON.stringify(text)})`);
  ok(h.log.direkt.length === 3, `b) es wurden ${h.log.direkt.length} Schluessel direkt probiert statt drei`);
}

// ── c) Reihenfolge in BEIDEN Wegen: kanonisch -> raw -> colon ───────────
{
  const h = laden({ helper: () => ({ ok: false }), direkt: () => null });
  await h.fn(K, E, F);
  ok(JSON.stringify(h.log.helper) === JSON.stringify([ENC, RAW, COLON]),
    `c) Helper-Reihenfolge: ${JSON.stringify(h.log.helper)}`);
  ok(JSON.stringify(h.log.direkt) === JSON.stringify([ENC, RAW, COLON]),
    `c) Direkt-Reihenfolge: ${JSON.stringify(h.log.direkt)}`);
  ok(JSON.stringify(h.log.helper) === JSON.stringify(h.log.direkt),
    "c) beide Wege gehen NICHT ueber dieselbe Liste");

  const h2 = laden({ helper: (k) => (k === ENC ? { ok: true, data: { text: "kanonisch" } } : { ok: false }) });
  ok(await h2.fn(K, E, F) === "kanonisch", "c) der kanonische Schluessel hat nicht Vorrang");
  ok(h2.log.helper.length === 1, "c) es wurde ueber den Treffer hinaus weitergesucht");

  const h3 = laden({ helperVerfuegbar: false, direkt: (k) => (k === COLON ? "trotzdem" : null) });
  ok(await h3.fn(K, E, F) === "trotzdem", "ohne netlifyBlobGet gibt es gar keinen Rueckfall mehr");
}

// ── d) Genau EINE Schluesselkonstruktion im Lesepfad ────────────────────
{
  const a = index.indexOf("window._loadExtractedText = async function");
  const src = ohneKommentare(index.slice(a, index.indexOf("\n};", a) + 3));
  ok((src.match(/attachmentReadKeys\(/g) || []).length === 1,
    "der Lesepfad ruft den Vertrag nicht genau einmal auf");
  for (const n of ["_textBlobKey(", "_textBlobKeyLegacyRaw(", "_textBlobKeyLegacyColon("]) {
    ok(!src.includes(n), `der Lesepfad baut den Schluessel zusaetzlich selbst: ${n}`);
  }
  ok(!/migrate|delete/i.test(src), "der Lesepfad migriert oder loescht");
  ok(!/netlifyBlobPut|method: 'PUT'/.test(src), "der Lesepfad schreibt");
}

// ── e) Kanonischer Decoder: Alias-Formen abweisen ───────────────────────
{
  const NUL = "\u0000";   // "AA" ist base64url fuer das Byte 0x00
  ok(_attSegDecode("AA") === NUL, "die kanonische Form AA wird abgelehnt");
  for (const alias of ["AB", "AC", "AP"]) {
    ok(wirft(() => _attSegDecode(alias)),
      `der Alias ${JSON.stringify(alias)} wird akzeptiert — dann gibt es fuer denselben Inhalt mehrere gueltige Schluessel`);
  }
  const kanonisch3 = _attSegEncode("ab");
  ok(kanonisch3.length === 3, `enc("ab") ist ${kanonisch3.length} Zeichen lang`);
  ok(_attSegDecode(kanonisch3) === "ab", "die kanonische 3er-Form wird abgelehnt");
  // Einen ECHTEN Alias suchen: dasselbe letzte Zeichen durch jedes andere des
  // Alphabets ersetzen und nehmen, was DIESELBEN Bytes ergibt. Ein beliebig
  // veraendertes Zeichen waere kein Alias, sondern ein anderer Inhalt.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~";
  const roh = (enc) => {
    let b64 = enc.replace(/~/g, "_").replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return Buffer.from(b64, "base64").toString("hex");
  };
  const aliase = [...ALPHABET]
    .map((c) => kanonisch3.slice(0, -1) + c)
    .filter((k) => k !== kanonisch3 && roh(k) === roh(kanonisch3));
  ok(aliase.length > 0, "es gibt keinen 3er-Alias — dann ist die Pruefung gegenstandslos");
  for (const alias of aliase) {
    ok(wirft(() => _attSegDecode(alias)),
      `der 3er-Alias ${JSON.stringify(alias)} von ${JSON.stringify(kanonisch3)} wird akzeptiert`);
  }

  ok(wirft(() => _attSegDecode("_A")), "ein '_' im Alphabet wird akzeptiert");
  ok(wirft(() => _attSegDecode("A+B")), "'+' im Alphabet wird akzeptiert");
  ok(wirft(() => _attSegDecode("gA")), "ungueltiges UTF-8 wird akzeptiert");
  ok(wirft(() => _attSegDecode("")), "die leere Eingabe wird akzeptiert");

  for (const f of ["Besprechung 2026-08-25", "Übergabe", "kick-off@kunde", "n8n:2026:08",
    "a__b", "__vorn", "hinten__", "a,b", "meeting+1", "note", "\u{1F642} Emoji", " "]) {
    ok(_attSegDecode(_attSegEncode(f)) === f, `Roundtrip verloren fuer ${JSON.stringify(f)}`);
  }
}

// ── f) Der 700-Byte-Vertrag ────────────────────────────────────────────
{
  const a = index.indexOf("window._saveExtractedText = async function");
  const speichern = ohneKommentare(index.slice(a, index.indexOf("window._loadExtractedText = async function")));
  ok(/const ATTACHMENT_KEY_MAX_BYTES = 700;/.test(index), "die Grenze ist keine benannte Konstante");
  ok(/_attKeyByteLength\(key\)/.test(speichern), "der Schluessel wird nicht in Bytes gemessen");
  ok(/Anhangtext-Key zu lang, Extraktion nicht persistiert/.test(speichern),
    "die Ueberlaenge wird nicht sichtbar geloggt");
  ok(speichern.indexOf("keyBytes > ATTACHMENT_KEY_MAX_BYTES") < speichern.indexOf("netlifyBlobPut("),
    "die Bytegrenze wird erst NACH dem Schreibvorgang geprueft");
  ok(/let key;\s*try \{\s*key = _textBlobKey\(/.test(speichern),
    "der Schluesselbau steht ungeschuetzt vor dem try und kann unbehandelt werfen");
  const nachGrenze = speichern.split("keyBytes > ATTACHMENT_KEY_MAX_BYTES")[1] || "";
  ok(!/slice\(0,|substring\(|hash|sha/i.test(nachGrenze.slice(0, 400)),
    "es gibt einen gekuerzten oder gehashten Ersatzschluessel");

  ok(_attKeyByteLength("ä") === 2 && _attKeyByteLength("\u{1F642}") === 4,
    "die Laenge wird in JS-Zeichen statt in UTF-8-Bytes gemessen");

  const passend = (ziel) => {
    for (let n = 1; n < 2000; n++) {
      if (_attKeyByteLength(_textBlobKey("note", "x".repeat(n), "f1")) === ziel) return "x".repeat(n);
    }
    return null;
  };
  const id700 = passend(700), id701 = passend(701);
  ok(!!id700, "es liess sich kein Schluessel mit exakt 700 Bytes bauen");
  ok(!!id701, "es liess sich kein Schluessel mit exakt 701 Bytes bauen");
  if (id700) ok(_attKeyByteLength(_textBlobKey("note", id700, "f1")) === 700, "der 700-Byte-Schluessel misst nicht 700");
  if (id701) ok(_attKeyByteLength(_textBlobKey("note", id701, "f1")) === 701, "der 701-Byte-Schluessel misst nicht 701");

  const unicodeId = "Ü".repeat(300);
  ok(_attKeyByteLength(_textBlobKey("note", unicodeId, "f1")) > 700,
    "eine 300-Zeichen-Unicode-Id bleibt unter der Grenze — dann greift der Verzicht nie");

  ok(!/entityId\s*=\s*[^=]/.test(speichern), "der Schreibpfad transformiert die Entitaets-Id");
}

if (luecken.length) {
  console.error("F-25 ATTACHMENT READ CONTRACT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 attachment read contract: ok (${checks} Pruefungen)`);
