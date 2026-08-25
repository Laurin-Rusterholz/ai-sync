/*
 * F-25 M1b — der Loeschmarker fuer Anhangstexte.
 *
 * Zwei Befunde:
 *
 *   SCHREIBZIEL   Der Marker ging auf fileObj.textKey. Bei Altbestaenden ist
 *                 das ein Altformat-Schluessel — der Marker landete also auf
 *                 einem Altobjekt (im Freeze ausgeschlossen), waehrend der
 *                 kanonische Schluessel unmarkiert blieb. Ein spaeterer
 *                 Lesevorgang haette den Text ueber den kanonischen Weg gar
 *                 nicht als geloescht erkannt.
 *
 *   RUECKFALL     Selbst mit Marker auf dem kanonischen Schluessel lief der
 *                 Lesepfad danach weiter auf roh-__ und Doppelpunkt. Ein
 *                 liegengebliebener Legacy-Text brachte den geloeschten Inhalt
 *                 zurueck. Der kanonische Marker ist jetzt TERMINAL.
 *
 * Dazu: der Marker lief mit .catch(() => {}) — ein Fehlschlag war unsichtbar,
 * und der Loeschmarker liegt in einem ANDEREN Skript-Block als _textBlobKey
 * (Block 16 gegen Block 5), brauchte also erst Exporte.
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

function schnipsel(name, praefix = "function ") {
  const a = index.indexOf("\n" + praefix + name + "(");
  assert.ok(a > 0, `${name} wurde nicht gefunden`);
  return index.slice(a, index.indexOf("\n}\n", a) + 3);
}
const BAUER = ["_attSegEncode", "_attSegDecode", "_textBlobKey", "_textBlobKeyLegacyRaw",
  "_textBlobKeyLegacyColon", "attachmentReadKeys", "_attKeyByteLength"];
const BAUER_SRC = BAUER.map((n) => schnipsel(n)).join("\n");
const GLOBALE = ["TextEncoder", "TextDecoder", "btoa", "atob", "Uint8Array", "String", "Error"];
const GLOBALE_WERTE = [TextEncoder, TextDecoder, btoa, atob, Uint8Array, String, Error];
const codec = new Function(...GLOBALE,
  BAUER_SRC + "\nreturn { " + BAUER.join(", ") + " };")(...GLOBALE_WERTE);
const { _textBlobKey, attachmentReadKeys, _attKeyByteLength } = codec;

const MAX = Number((index.match(/const ATTACHMENT_KEY_MAX_BYTES = (\d+);/) || [, "700"])[1]);

// ── Der ECHTE Loeschzweig aus dem Klick-Handler ────────────────────────
// Herausgeschnitten von der Marker-Bemerkung bis zum splice.
function loeschzweig() {
  const a = index.indexOf("    // Text-Blob (Netlify) als geloescht markieren");
  assert.ok(a > 0, "der Loeschzweig wurde nicht gefunden");
  const b = index.indexOf("_entDel.files.splice(fIdx, 1);", a);
  assert.ok(b > a, "das Ende des Loeschzweigs wurde nicht gefunden");
  return index.slice(a, b);
}
const ZWEIG = loeschzweig();

function loeschen({ fKind = "meeting", fId = "n8n:2026:08", fileId = "f_abc_1234",
  textExtracted = true, textKey = undefined, putErgebnis = { ok: true }, exporteDa = true } = {}) {
  const log = { puts: [], warn: [], error: [], info: [] };
  const win = exporteDa ? {
    netlifyBlobPut: async (k, v) => { log.puts.push({ key: k, wert: v }); return putErgebnis; },
    _textBlobKey, _attKeyByteLength, ATTACHMENT_KEY_MAX_BYTES: MAX,
  } : {};
  const fileObj = { id: fileId, textExtracted, textKey };
  const gespliced = { wert: false };
  const fn = new Function("window", "fKind", "fId", "fileObj", "console", "Date", "_ende",
    ZWEIG + "\n_ende();")
  ;
  fn(win, fKind, fId, fileObj,
    { log: (...a) => log.info.push(a.join(" ")), warn: (...a) => log.warn.push(a.join(" ")), error: (...a) => log.error.push(a.join(" ")) },
    Date, () => { gespliced.wert = true; });
  return { log, gespliced, fileObj };
}

// ── 1. Altbestand: kanonischer Marker, NULL Legacy-Writes ──────────────
for (const altFormat of ["raw", "colon"]) {
  const fKind = "meeting", fId = "n8n:2026:08", fileId = "f_abc_1234";
  const [ENC, RAW, COLON] = attachmentReadKeys(fKind, fId, fileId);
  const altKey = altFormat === "raw" ? RAW : COLON;
  const h = loeschen({ fKind, fId, fileId, textKey: altKey });
  await new Promise((r) => setTimeout(r, 5));

  ok(h.log.puts.length === 1,
    `${altFormat}: es gab ${h.log.puts.length} Schreibvorgaenge statt genau einem`);
  ok(h.log.puts[0]?.key === ENC,
    `${altFormat}: der Marker ging auf ${JSON.stringify(h.log.puts[0]?.key)} statt auf den kanonischen Schluessel — ` +
    "ein Schreibvorgang auf ein Altobjekt ist im Freeze ausgeschlossen");
  ok(h.log.puts.every((p) => p.key !== RAW && p.key !== COLON),
    `${altFormat}: es ging ein Schreibvorgang auf ein Altformat hinaus`);
  ok(h.log.puts[0]?.wert?.deleted === true && h.log.puts[0]?.wert?.text === "",
    `${altFormat}: der Marker traegt nicht { text:'', deleted:true }`);
  ok(h.gespliced.wert === true, `${altFormat}: die Datei-Referenz wurde nicht entfernt`);
}

// ── 2. Ohne Alttext: kanonischer Marker, idempotent und harmlos ────────
{
  const h = loeschen({ textKey: undefined });
  await new Promise((r) => setTimeout(r, 5));
  const [ENC] = attachmentReadKeys("meeting", "n8n:2026:08", "f_abc_1234");
  ok(h.log.puts.length === 1 && h.log.puts[0].key === ENC,
    "ohne fileObj.textKey wird kein kanonischer Marker gesetzt — frueher haing der Zweig an textKey");
  ok(h.gespliced.wert === true, "die Datei-Referenz wurde nicht entfernt");

  // zweimal loeschen schreibt zweimal denselben Marker — harmlos
  const h2 = loeschen({ textKey: ENC });
  await new Promise((r) => setTimeout(r, 5));
  ok(h2.log.puts.length === 1 && h2.log.puts[0].key === ENC,
    "ein erneuter Marker geht nicht auf denselben kanonischen Schluessel");
}

// ── 3. Nicht extrahiert: gar kein Schreibvorgang ───────────────────────
{
  const h = loeschen({ textExtracted: false });
  await new Promise((r) => setTimeout(r, 5));
  ok(h.log.puts.length === 0, "fuer eine Datei ohne extrahierten Text wurde ein Marker geschrieben");
  ok(h.gespliced.wert === true, "die Datei-Referenz wurde nicht entfernt");
}

// ── 4. Ueberlange Id: kein Write, sichtbares Log, Loeschung laeuft weiter ──
{
  let langeId = null;
  for (let n = 1; n < 2000; n++) {
    if (_attKeyByteLength(_textBlobKey("meeting", "x".repeat(n), "f1")) > MAX) { langeId = "x".repeat(n); break; }
  }
  ok(!!langeId, "es liess sich keine Id finden, die die Bytegrenze sprengt");
  const h = loeschen({ fId: langeId, fileId: "f1" });
  await new Promise((r) => setTimeout(r, 5));
  ok(h.log.puts.length === 0, "bei uebergrossem Schluessel wurde trotzdem geschrieben");
  ok(h.log.warn.some((z) => /Loeschmarker-Key zu lang/.test(z) && /P2-Cleanup/.test(z)),
    `das Log nennt die Ueberlaenge nicht sichtbar: ${JSON.stringify(h.log.warn)}`);
  ok(h.gespliced.wert === true,
    "die Datei-Referenz wurde wegen des zu langen Schluessels NICHT entfernt — die Loeschung darf nicht abbrechen");

  // auch eine Unicode-Id, die in Zeichen kurz, in Bytes aber lang ist
  const h2 = loeschen({ fId: "Ü".repeat(300), fileId: "f1" });
  await new Promise((r) => setTimeout(r, 5));
  ok(h2.log.puts.length === 0, "eine 300-Zeichen-Unicode-Id wurde geschrieben");
  ok(h2.gespliced.wert === true, "die Loeschung brach bei der Unicode-Id ab");
}

// ── 5. Fehler werden nicht verschluckt ─────────────────────────────────
{
  const h = loeschen({ putErgebnis: { ok: false, reason: "storage_not_cas_capable" } });
  await new Promise((r) => setTimeout(r, 5));
  ok(h.log.warn.some((z) => /Loeschmarker NICHT gesetzt/.test(z) && /storage_not_cas_capable/.test(z)),
    `ein fehlgeschlagener Marker bleibt unsichtbar: ${JSON.stringify(h.log.warn)}`);

  const h2 = loeschen({ putErgebnis: { ok: true } });
  await new Promise((r) => setTimeout(r, 5));
  ok(h2.log.info.some((z) => /Loeschmarker gesetzt/.test(z)), "ein Erfolg wird nicht protokolliert");

  const zweig = ohneKommentare(ZWEIG);
  ok(!/\.catch\(\(\) => \{\}\)/.test(zweig) && !/\.catch\(\(\)=>\{\}\)/.test(zweig),
    "es gibt weiterhin ein blindes .catch(() => {})");
  ok(!/fileObj\.textKey/.test(zweig),
    "fileObj.textKey wird weiterhin als Schreibziel benutzt");
  ok(/_key\(fKind, fId, fileObj\.id\)/.test(zweig),
    "der Marker baut den Schluessel nicht kanonisch aus kind/entityId/fileId");
  ok(/P2-Cleanup/.test(ZWEIG) || /P2-AUFRAEUMPUNKT/.test(ZWEIG),
    "der P2-Aufraeumpunkt ist nicht dokumentiert");
}

// ── 6. Fehlende Exporte fallen auf, statt still nichts zu tun ──────────
{
  const h = loeschen({ exporteDa: false });
  await new Promise((r) => setTimeout(r, 5));
  ok(h.log.puts.length === 0, "ohne Exporte wurde geschrieben");
  ok(h.log.error.some((z) => /fehlende Exporte/.test(z)),
    `ein fehlender Export bleibt still: ${JSON.stringify(h.log.error)}`);
  ok(h.gespliced.wert === true, "ohne Exporte brach die Loeschung ab");
  // und die Exporte existieren wirklich
  for (const n of ["_textBlobKey", "_attKeyByteLength", "ATTACHMENT_KEY_MAX_BYTES"]) {
    ok(new RegExp("window\\." + n + " = " + n + ";").test(index),
      `${n} ist nicht nach window exportiert — der Loeschmarker liegt in einem anderen Skript-Block`);
  }
}

// ── 7. Terminaler Grabstein im Lesepfad ────────────────────────────────
function laden({ helper = () => ({ skipped: true }), direkt = () => null } = {}) {
  const log = { helper: [], direkt: [] };
  const a = index.indexOf("window._loadExtractedText = async function");
  const src = index.slice(a, index.indexOf("\n};", a) + 3);
  const fn = new Function("window", "APP", "netlifyBlobGet", "fetch", "console", ...GLOBALE,
    BAUER_SRC + "\n" + src + "\nreturn window._loadExtractedText;")(
    {}, { state: { settings: { storage: { getUrl: "https://x/{key}" } } } },
    async (k) => { log.helper.push(k); return helper(k); },
    async (url) => {
      const k = decodeURIComponent(url.replace("https://x/", ""));
      log.direkt.push(k);
      const d = direkt(k);
      return d === null
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => d };
    },
    { log() {}, warn() {} }, ...GLOBALE_WERTE);
  return { fn, log };
}
{
  const K = "meeting", E = "n8n:2026:08", F = "f_abc_1234";
  const [ENC, RAW, COLON] = attachmentReadKeys(K, E, F);
  const GRAB = { text: "", deleted: true, deletedAt: "2026-08-25T12:00:00.000Z" };

  // kanonischer Grabstein + vorhandener Legacy-Text -> bleibt geloescht
  const h = laden({
    helper: (k) => (k === ENC ? { ok: true, data: GRAB }
      : { ok: true, data: { text: "alter Text, laengst geloescht" } }),
  });
  ok(await h.fn(K, E, F) === null,
    "ein kanonischer Grabstein ist nicht terminal — ein liegengebliebener Legacy-Text bringt den geloeschten Inhalt zurueck");
  ok(h.log.helper.length === 1,
    `nach dem kanonischen Grabstein wurde weitergesucht: ${JSON.stringify(h.log.helper)}`);

  // dasselbe auf dem Direkt-Rueckfall
  const h2 = laden({
    helper: () => ({ skipped: true }),
    direkt: (k) => (k === ENC ? GRAB : { text: "alter Text" }),
  });
  ok(await h2.fn(K, E, F) === null, "der Direkt-Rueckfall achtet den kanonischen Grabstein nicht");
  ok(h2.log.direkt.length === 1,
    `der Direkt-Rueckfall suchte nach dem Grabstein weiter: ${JSON.stringify(h2.log.direkt)}`);

  // Ein Grabstein auf einem ALTschluessel beendet die Suche NICHT
  const h3 = laden({
    helper: (k) => (k === ENC ? { ok: false, status: 404 }
      : k === RAW ? { ok: true, data: GRAB }
        : { ok: true, data: { text: "gueltiger Doppelpunkt-Text" } }),
  });
  ok(await h3.fn(K, E, F) === "gueltiger Doppelpunkt-Text",
    "ein Grabstein auf einem ALTschluessel beendet die Suche — er kann aus einer frueheren Loeschung stammen");

  // ohne Grabstein bleibt encoded -> raw -> colon
  const h4 = laden({ helper: (k) => (k === COLON ? { ok: true, data: { text: "colon" } } : { ok: false, status: 404 }) });
  ok(await h4.fn(K, E, F) === "colon", "ohne Grabstein greift die Reihenfolge nicht mehr");
  ok(JSON.stringify(h4.log.helper) === JSON.stringify([ENC, RAW, COLON]),
    `die Reihenfolge stimmt nicht: ${JSON.stringify(h4.log.helper)}`);

  const laden_src = ohneKommentare(index.slice(index.indexOf("window._loadExtractedText = async function"),
    index.indexOf("window._loadExtractedText = async function") + 2400));
  ok(/i === 0 && _istTerminal\(result\)/.test(laden_src), "der terminale Grabstein fehlt im Helper-Weg");
  ok(/i === 0 && data && data\.deleted === true/.test(laden_src), "der terminale Grabstein fehlt im Direkt-Weg");
  ok(!/migrate|netlifyBlobPut/.test(laden_src), "der Lesepfad schreibt oder migriert");
}

if (luecken.length) {
  console.error("F-25 ATTACHMENT TOMBSTONE — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 attachment tombstone: ok (${checks} Pruefungen)`);
