/*
 * Die Schluesselpolitik der Blob-Fassade — EINE Quelle fuer alle Schreibwege.
 *
 * Warum es sie gibt: blob-put nimmt einen beliebigen key aus der URL entgegen
 * und schreibt darunter nach appStore/<sanitizedKey>. Ohne Politik konnte
 * jeder Aufrufer einen beliebigen Knoten anlegen — und ueber eine
 * Sanitizing-Variante sogar den Kerndatensatz unbedingt ueberschreiben
 * (F-25 Commit K).
 *
 * Zwei Regeln:
 *   KERN   Alles, was auf appStore/app-data_json auflöst, wird ausschliesslich
 *          BEDINGT geschrieben. Ohne If-Match: 428.
 *   REST   Genau vier Familien sind erlaubt. Alles andere: 403. Default DENY.
 *
 * Der Codec ist zeichengleich mit dem des Clients (public/index.html,
 * _attSegEncode/_attSegDecode, F-25 M1a). Weichen beide auseinander, lehnt der
 * Server gueltige Schluessel ab oder laesst mehrdeutige durch — deshalb steht
 * er hier einmal und wird von blob-put UND firebase-admin importiert, nicht
 * kopiert.
 */

// ── Sanitizing: die EINZIGE Implementierung ─────────────────────────────
// RTDB-Schluessel duerfen . # $ [ ] / nicht enthalten; die Fassade ersetzt sie
// durch _. Zwei verschieden geschriebene Schluessel koennen damit auf denselben
// Knoten zeigen. firebase-admin importiert diese Funktion, statt eine zweite zu
// fuehren — sonst liefen Politik und Ablage semantisch auseinander.
export function firebaseNodeKey(key) {
  return String(key || "app-data.json").replace(/[.#$\[\]\/]/g, "_");
}

export const CORE_KEY = "app-data.json";
const CORE_NODE = firebaseNodeKey(CORE_KEY);

export function isCoreKey(key) {
  return firebaseNodeKey(String(key || "")) === CORE_NODE;
}

// ── Der Codec, zeichengleich mit dem Client (M1a) ───────────────────────
// UTF-8 → base64url (RFC 4648 §5, Alphabet A-Za-z0-9-_, ohne Padding), danach
// jedes "_" zu "~". Ergebnisalphabet exakt [A-Za-z0-9~-]: ein Segment kann den
// Trenner "__" nicht erzeugen, die Zerlegung ist eindeutig.
export function attSegEncode(segment) {
  const s = (segment == null) ? "" : String(segment);
  if (!s) throw new Error("attSegEncode: leeres Segment");
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .replace(/_/g, "~");
}

export function attSegDecode(enc) {
  const s = (enc == null) ? "" : String(enc);
  if (!s) throw new Error("attSegDecode: leeres Segment");
  if (!/^[A-Za-z0-9~-]+$/.test(s)) throw new Error("attSegDecode: fremdes Alphabet");
  let b64 = s.replace(/~/g, "_").replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // KANONIZITAET: base64 hat Alias-Formen — die ueberzaehligen Bits im letzten
  // Zeichen muessen null sein. "AA" und "AB" ergeben beide das Byte 0x00, aber
  // nur "AA" ist kanonisch. Ohne diese Pruefung gaebe es fuer denselben Inhalt
  // mehrere gueltige Schluessel, also wieder Mehrdeutigkeit.
  if (attSegEncode(text) !== s) throw new Error("attSegDecode: nicht-kanonische Kodierung");
  return text;
}

// ── Groessengrenze ──────────────────────────────────────────────────────
// Ein RTDB-Schluessel darf hoechstens 768 BYTES lang sein. Der Blob-Schluessel
// wird nach dem Sanitizing zum Knotennamen unter appStore/, faellt also unter
// dieses Limit. 700 laesst 68 Bytes Reserve fuer kuenftige Praefixe und fuer den
// Fall, dass die Fassade den Namen noch einmal anfasst. Gemessen wird in
// UTF-8-Bytes, nicht in JS-Zeichen: ein Umlaut ist ein Zeichen und zwei Bytes.
export const BLOB_KEY_MAX_BYTES = 700;
export const RTDB_KEY_LIMIT_BYTES = 768;

export function blobKeyByteLength(key) {
  return new TextEncoder().encode(String(key == null ? "" : key)).length;
}

// ── Die vier erlaubten Nebenschluessel-Familien ─────────────────────────
const EXAKTE_NEBENKEYS = new Set(["recalllab-mobile.json", "readinghub-data.json"]);
const DIAGNOSE_MUSTER = /^_diagnose-[A-Za-z0-9._-]+$/;
const ATTACHMENT_PRAEFIX = "attachment-text";
const SEGMENT_ALPHABET = /^[A-Za-z0-9~-]+$/;

function pruefeAttachmentKey(key) {
  const teile = key.split("__");
  if (teile.length !== 4) {
    return { ok: false, reason: "attachment_segment_count", detail: `${teile.length} statt 4 Teile` };
  }
  if (teile[0] !== ATTACHMENT_PRAEFIX) {
    return { ok: false, reason: "attachment_prefix" };
  }
  for (let i = 1; i < 4; i++) {
    const seg = teile[i];
    if (!seg) return { ok: false, reason: "attachment_empty_segment", detail: `Segment ${i + 1}` };
    if (!SEGMENT_ALPHABET.test(seg)) {
      return { ok: false, reason: "attachment_segment_alphabet", detail: `Segment ${i + 1}` };
    }
    try {
      attSegDecode(seg);   // wirft bei fremdem Alphabet, fatalem UTF-8 und Alias-Formen
    } catch (e) {
      return { ok: false, reason: "attachment_segment_not_canonical", detail: `Segment ${i + 1}: ${e.message}` };
    }
  }
  return { ok: true };
}

/*
 * Klassifiziert einen Schluessel fuer SCHREIBZUGRIFFE.
 * Lesezugriffe (blob-get) sind bewusst NICHT betroffen — ein Altstand muss
 * lesbar bleiben, auch wenn er unter einem heute unzulaessigen Schluessel liegt.
 *
 * Rueckgabe:
 *   { kind: "core" }                      Kernschluessel, If-Match-Pflicht
 *   { kind: "side", family: "..." }       erlaubter Nebenschluessel
 *   { kind: "denied", reason, detail? }   alles andere
 */
export function classifyBlobKey(key) {
  const k = String(key == null ? "" : key);
  if (!k) return { kind: "denied", reason: "empty_key" };
  if (isCoreKey(k)) return { kind: "core" };

  const bytes = blobKeyByteLength(k);
  if (bytes > BLOB_KEY_MAX_BYTES) {
    return { kind: "denied", reason: "key_too_long", detail: `${bytes} > ${BLOB_KEY_MAX_BYTES} Bytes` };
  }
  if (k.includes("/")) return { kind: "denied", reason: "slash_in_key" };

  if (EXAKTE_NEBENKEYS.has(k)) return { kind: "side", family: k };
  if (DIAGNOSE_MUSTER.test(k)) return { kind: "side", family: "_diagnose-*" };
  if (k.startsWith(ATTACHMENT_PRAEFIX)) {
    // Kein startsWith-Match als Freibrief: der Schluessel muss die strenge Form
    // erfuellen. Die Altformate (rohe Segmente zwischen "__", Doppelpunkte)
    // fallen hier durch — sie bleiben LESBAR, aber nicht mehr beschreibbar.
    const p = pruefeAttachmentKey(k);
    if (p.ok) return { kind: "side", family: "attachment-text__*" };
    return { kind: "denied", reason: p.reason, detail: p.detail };
  }
  return { kind: "denied", reason: "not_whitelisted" };
}
