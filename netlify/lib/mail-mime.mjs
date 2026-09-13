/* ══ MIME-Werkzeug für die Warteschlange ═════════════════════════════════════
 *
 * WARUM ES DAS GIBT (Durchsicht 13.09.2026): Eine geplante Mail soll bis zum
 * Versand BEARBEITBAR bleiben — auch eine mit Anhang. Der Anhang steckt aber
 * ausschliesslich in der fertigen MIME-Nachricht; wer den Text neu baut, wirft
 * ihn weg. Deshalb wird hier nicht neu gebaut, sondern GENAU EIN TEIL ersetzt:
 * der Körper. Alles andere — Empfänger, Antwort-Kopfzeilen, Grenzen, Anhänge —
 * bleibt Zeichen für Zeichen stehen.
 *
 * Ausserdem bekommt jede Nachricht hier ihre eigene RFC-822-Message-ID. Sie
 * ist der einzige Faden, an dem sich eine Nachricht nach einem Absturz
 * WIEDERFINDEN lässt: users.messages.list kennt laut Discovery-Dokument
 * (Revision 20260907) den Suchbegriff „rfc822msgid:" — ausdrücklich im
 * Beispiel des Parameters q. Ob Gmail eine mitgegebene Message-ID behält, ist
 * nirgends zugesichert; deshalb ist sie ein BESTÄTIGUNGSweg und niemals ein
 * Grund, noch einmal zu senden.
 *
 * Reine Funktionen: keine Uhr, kein Netz, kein Zustand.
 * ═════════════════════════════════════════════════════════════════════════ */

export function dekodiere(rawB64url) {
  const b64 = String(rawB64url || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

export function kodiere(mime) {
  return Buffer.from(String(mime), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* Kopf und Rumpf trennen. Beide Zeilenenden kommen vor — Gmail liefert
   \r\n, handgeschriebene Nachrichten auch \n. */
export function trenne(mime) {
  const text = String(mime || "");
  const i = text.indexOf("\r\n\r\n");
  if (i >= 0) return { kopf: text.slice(0, i), rumpf: text.slice(i + 4), br: "\r\n" };
  const j = text.indexOf("\n\n");
  if (j >= 0) return { kopf: text.slice(0, j), rumpf: text.slice(j + 2), br: "\n" };
  return { kopf: text, rumpf: "", br: "\r\n" };
}

/* Kopfzeilen entfalten: eine Zeile, die mit Leerzeichen oder Tabulator
   beginnt, gehört zur vorigen. */
function kopfzeilen(kopf) {
  const zeilen = String(kopf).split(/\r?\n/);
  const out = [];
  for (const z of zeilen) {
    if (/^[ \t]/.test(z) && out.length) out[out.length - 1] += "\n" + z;
    else out.push(z);
  }
  return out;
}

export function liesKopfzeile(mime, name) {
  const { kopf } = trenne(mime);
  const treffer = kopfzeilen(kopf).find((z) => z.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return treffer ? treffer.slice(name.length + 1).replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

export function liesMessageId(mime) {
  const wert = liesKopfzeile(mime, "Message-ID") || liesKopfzeile(mime, "Message-Id");
  const m = /<([^>]+)>/.exec(wert);
  return m ? m[1] : (wert || "");
}

/* Die eigene Message-ID setzen — nur, wenn die Nachricht noch keine trägt.
   Eine vorhandene wird NICHT überschrieben: sie könnte von einem anderen
   Programm stammen und wäre dann eine Lüge über die Herkunft. */
export function setzeMessageId(mime, id) {
  const vorhanden = liesMessageId(mime);
  if (vorhanden) return { mime: String(mime), id: vorhanden, neu: false };
  const { kopf, rumpf, br } = trenne(mime);
  const zeile = "Message-ID: <" + String(id) + ">";
  return { mime: kopf + br + zeile + br + br + rumpf, id: String(id), neu: true };
}

function betreffKodiert(subject) {
  const s = String(subject == null ? "" : subject);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

export function ersetzeBetreff(mime, subject) {
  const { kopf, rumpf, br } = trenne(mime);
  const zeilen = kopfzeilen(kopf);
  const neu = "Subject: " + betreffKodiert(subject);
  const i = zeilen.findIndex((z) => z.toLowerCase().startsWith("subject:"));
  if (i >= 0) zeilen[i] = neu; else zeilen.push(neu);
  return zeilen.join(br) + br + br + rumpf;
}

/* Ein Kopfzeilenwert darf keine Zeilenschaltung enthalten. Sonst schreibt
   jemand mit einem „\n" in einem Empfängerfeld eigene Kopfzeilen in die
   Nachricht (Header-Injection) — etwa ein zusätzliches Bcc. Steuerzeichen
   fliegen deshalb raus, bevor irgendetwas gesetzt wird. */
export function kopfwertSicher(wert) {
  return String(wert == null ? "" : wert)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

/* DIE EMPFÄNGER — der Befund, der einen Release gekostet hätte:
   `aendere` nahm to/cc/bcc entgegen und schrieb sie in die Anzeigefelder,
   aber die GESPEICHERTE Nachricht behielt ihre alten Kopfzeilen. In Quantus
   stand der neue Empfänger, hinaus gegangen wäre die Mail an den alten.
   Deshalb werden die drei Felder hier im MIME mitgezogen — und ein leeres
   Cc/Bcc entfernt die Zeile, statt eine leere stehen zu lassen.
   `undefined` heisst „nicht anfassen", "" heisst „weg damit" (bei To nicht:
   eine Nachricht ohne Empfänger gibt es nicht — dort bleibt der alte Wert). */
export function ersetzeEmpfaenger(mime, { to, cc, bcc } = {}) {
  const { kopf, rumpf, br } = trenne(mime);
  let zeilen = kopfzeilen(kopf);
  const setze = (name, wert, loeschbar) => {
    if (wert === undefined) return;
    const sauber = kopfwertSicher(wert);
    const i = zeilen.findIndex((z) => z.toLowerCase().startsWith(name.toLowerCase() + ":"));
    if (!sauber) {
      if (!loeschbar) return;                       // To bleibt stehen
      if (i >= 0) zeilen.splice(i, 1);
      return;
    }
    const zeile = name + ": " + sauber;
    if (i >= 0) zeilen[i] = zeile; else zeilen.splice(Math.max(0, zeilen.length - 1), 0, zeile);
  };
  setze("To", to, false);
  setze("Cc", cc, true);
  setze("Bcc", bcc, true);
  return zeilen.join(br) + br + br + rumpf;
}

/* Neue Anhänge kommen HINZU, sie ersetzen nichts. Hat die Nachricht noch
   keinen multipart/mixed-Rahmen, bekommt sie einen — der bisherige Körper
   wird dabei zum ersten Teil. So geht beim Nachreichen einer Datei weder der
   Text noch ein früherer Anhang verloren. */
export function fuegeAnhaengeAn(mime, teile) {
  const liste = (Array.isArray(teile) ? teile : []).filter((t) => String(t || "").trim());
  if (!liste.length) return String(mime);
  const { kopf, rumpf, br } = trenne(mime);
  const grenze = grenzeVon(mime);
  if (grenze) {
    const schluss = "--" + grenze + "--";
    const i = rumpf.lastIndexOf(schluss);
    const vorher = i >= 0 ? rumpf.slice(0, i) : (rumpf + br);
    const nachher = i >= 0 ? rumpf.slice(i) : schluss;
    const neu = liste.map((t) => "--" + grenze + br + t + br).join("");
    return kopf + br + br + vorher + neu + nachher;
  }
  const neueGrenze = "mix_" + Math.random().toString(36).slice(2, 10);
  const zeilen = kopfzeilen(kopf).filter((z) => !/^content-(type|transfer-encoding):/i.test(z));
  const alteContent = kopfzeilen(kopf).filter((z) => /^content-(type|transfer-encoding):/i.test(z));
  zeilen.push('Content-Type: multipart/mixed; boundary="' + neueGrenze + '"');
  const alterKoerper = (alteContent.length ? alteContent.join(br) + br + br : "") + rumpf;
  return zeilen.join(br) + br + br
    + "--" + neueGrenze + br + alterKoerper + br
    + liste.map((t) => "--" + neueGrenze + br + t + br).join("")
    + "--" + neueGrenze + "--";
}

/* Eine Anhang-Entität aus Name, Typ und base64-Daten — genau so, wie der
   Verfassen-Dialog sie baut. */
export function anhangTeil({ name, typ, daten }) {
  const dateiname = kopfwertSicher(name || "datei").replace(/"/g, "'");
  const art = kopfwertSicher(typ || "application/octet-stream").replace(/"/g, "'");
  return 'Content-Type: ' + art + '; name="' + dateiname + '"\r\n'
    + "Content-Transfer-Encoding: base64\r\n"
    + 'Content-Disposition: attachment; filename="' + dateiname + '"\r\n\r\n'
    + String(daten || "").replace(/\s+/g, "").replace(/.{76}/g, "$&\r\n");
}

/* Die Grenze eines multipart-Rumpfes aus dem Kopf lesen. */
export function grenzeVon(mime) {
  const ct = liesKopfzeile(mime, "Content-Type");
  if (!/multipart\/mixed/i.test(ct)) return null;
  const m = /boundary="?([^";]+)"?/i.exec(ct);
  return m ? m[1] : null;
}

export function hatAnhaenge(mime) {
  return !!grenzeVon(mime);
}

/* DER KERN: Nur den Körper ersetzen.
   · Ohne Anhänge ist der ganze Rumpf der Körper — er wird ausgetauscht.
   · Mit Anhängen ist der Körper der ERSTE Teil von multipart/mixed (so baut
     Quantus die Nachricht: Körper, danach die Anhänge). Ersetzt wird genau
     dieser Teil; alle weiteren Teile bleiben unangetastet — Zeichen für
     Zeichen, mitsamt ihren Grenzen.
   `koerperTeil` ist eine fertige MIME-Entität (eigene Content-Type-Zeile,
   Leerzeile, Inhalt) — dieselbe, die der Verfassen-Dialog baut. */
export function ersetzeKoerper(mime, koerperTeil) {
  const teil = String(koerperTeil || "");
  const grenze = grenzeVon(mime);
  const { kopf, rumpf, br } = trenne(mime);
  if (!grenze) {
    /* Ohne Anhänge bringt die Körper-Entität ihre eigenen Inhaltszeilen mit —
       alte Content-Zeilen im Kopf müssten sonst doppelt gelten.

       BEFUND aus der unabhängigen Gegenprobe (13.09.2026): Hier stand
       `... + br + br + teil`. Damit endete der Kopf, und die Content-Zeilen
       DER KÖRPER-ENTITÄT landeten im Rumpf — Gmail zeigte dann „Content-Type:
       …" und den Base64-Block als Mailtext. Richtig ist EINE Zeilenschaltung:
       die Entität bringt ihre eigene Leerzeile mit, und die trennt Kopf von
       Inhalt. */
    const zeilen = kopfzeilen(kopf).filter((z) => !/^content-(type|transfer-encoding):/i.test(z));
    return zeilen.join(br) + br + teil;
  }
  const marke = "--" + grenze;
  const stellen = [];
  let von = rumpf.indexOf(marke);
  while (von >= 0) { stellen.push(von); von = rumpf.indexOf(marke, von + marke.length); }
  if (stellen.length < 2) return mime;                   // nichts Verständliches — lieber nichts anfassen
  const ersterStart = stellen[0] + marke.length;         // hinter der ersten Grenzmarke
  const naechste = stellen[1];                           // vor der zweiten Grenzmarke
  const vorspann = rumpf.slice(0, ersterStart);
  const rest = rumpf.slice(naechste);
  return kopf + br + br + vorspann + br + teil + br + rest;
}

/* Eine Körper-Entität aus reinem Text — der Rückfall, wenn die Oberfläche
   keine mitschickt. */
export function textTeil(text) {
  return 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    + Buffer.from(String(text == null ? "" : text), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
}

export default {
  dekodiere, kodiere, trenne, liesKopfzeile, liesMessageId, setzeMessageId,
  ersetzeBetreff, ersetzeKoerper, grenzeVon, hatAnhaenge, textTeil,
  ersetzeEmpfaenger, kopfwertSicher, fuegeAnhaengeAn, anhangTeil,
};
