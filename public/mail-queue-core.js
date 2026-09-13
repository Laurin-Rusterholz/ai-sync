/* ══ Quantus — geplanter Mailversand: der Kern ═══════════════════════════════
 *
 * AUFTRAG (13.09.2026): Ausgehende Mails gehen standardmaessig erst in DREI
 * STUNDEN raus und bleiben bis dahin in Quantus sichtbar — bearbeitbar,
 * abbrechbar, auf Wunsch sofort oder zu einer anderen Zeit.
 *
 * WAS GOOGLE DAZU HERGIBT — nachgeschlagen, nicht vermutet:
 * Das offizielle Discovery-Dokument der Gmail API
 * (https://gmail.googleapis.com/$discovery/rest?version=v1, Revision 20260907,
 * documentationLink https://developers.google.com/workspace/gmail/api/) kennt
 * KEINE Versandplanung:
 *   · users.messages.send nimmt ausser userId nur eine Message entgegen
 *     (payload, raw, threadId, labelIds, …) — kein sendAt, kein scheduleTime;
 *   · users.drafts.send nimmt einen Draft entgegen;
 *   · in 79 Methoden und allen Schemata kommt "schedul", "sendAt",
 *     "sendLater" und "deliveryTime" KEIN EINZIGES MAL vor;
 *   · auch die Label-Liste kennt kein SCHEDULED — Gmails Ansicht
 *     „Geplant" ist eine Oberflaechenfunktion und ueber die API nicht sichtbar.
 * Folge: Die Planung gehoert uns. Gmail ist AUSSCHLIESSLICH Versandkanal und
 * die Quelle der Wahrheit darueber, ob eine Mail wirklich raus ist. Eine
 * Gmail-Geplant-Ansicht wird NICHT vorgetaeuscht.
 *
 * WIE DIE PLANUNG TRAEGT
 * Ein Eintrag liegt serverseitig (RTDB) und wird von einem Serverlauf
 * abgearbeitet — kein Browser-Timer. Der Versand ist zweistufig, damit ein
 * zweiter Lauf keine zweite Mail erzeugt:
 *   1. Entwurf anlegen (users.drafts.create) → draftId merken;
 *   2. Entwurf senden (users.drafts.send)    → messageId merken.
 * Ein Lauf, der einen Eintrag mit draftId und ohne messageId findet, fragt
 * Gmail, ob dieser Entwurf noch existiert: existiert er, ist nichts gesendet;
 * existiert er nicht mehr, wurde er gesendet — dann wird nur der Stand
 * nachgezogen. Gesendet heisst erst gesendet, wenn Gmail die Nachricht mit dem
 * Label SENT bestaetigt.
 *
 * Diese Datei ist REIN: keine Uhr, kein Netz, kein DOM. Die Zeit kommt immer
 * als Argument herein — nur so lassen sich Zeitzonen, Offlinegeraete und
 * Wiederholungen pruefen, ohne zu warten. Dieselbe Datei benutzen die
 * Serverfunktion, Quantus im Browser und die Mobil-/Tabletoberflaechen.
 * ═════════════════════════════════════════════════════════════════════════ */

export const VERSANDZONE = "Europe/Zurich";
export const STANDARD_VERZOEGERUNG_MS = 3 * 60 * 60 * 1000;   // drei Stunden
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;               // verwaister Lauf
export const MAX_VERSUCHE = 5;

/* Die Zustaende. Mehr gibt es nicht, und jeder Uebergang steht unten. */
export const STATUS = {
  geplant: "geplant",           // wartet auf seine Zeit — aenderbar, abbrechbar
  sendet: "sendet",             // ein Serverlauf hat ihn uebernommen
  gesendet: "gesendet",         // Gmail hat SENT bestaetigt — endgueltig
  abgebrochen: "abgebrochen",   // vor dem Versand zurueckgenommen — endgueltig
  fehlgeschlagen: "fehlgeschlagen", // nach MAX_VERSUCHE aufgegeben, bleibt sichtbar
  unklar: "unklar",             // Versand angestossen, Ausgang ungeklaert — NIE automatisch wiederholen
};
const ENDGUELTIG = new Set([STATUS.gesendet, STATUS.abgebrochen]);

/* ── Die Stufen des Versands ──────────────────────────────────────────────
   Befund aus der Durchsicht (13.09.2026): Es genuegt NICHT, den Entwurf erst
   nach dem Senden zu vermerken. Stuerzt der Lauf zwischen zwei Gmail-Aufrufen
   ab — oder geht nur die Antwort verloren —, weiss der naechste Lauf sonst
   nicht, wie weit der vorige kam, legt einen zweiten Entwurf an und sendet ein
   zweites Mal. Deshalb wird JEDE unumkehrbare Handlung VORHER festgehalten:

     ""            noch nichts angefasst
     "entwurf"     ein drafts.create ist unterwegs (Antwort noch offen)
     "entwurf-ok"  die draftId liegt gespeichert vor
     "senden"      ein drafts.send ist unterwegs (Antwort noch offen)

   Nur so laesst sich nach einem Absturz sagen: „Hier kann nichts draussen
   sein" (Stufe entwurf: ein Entwurf verschickt nichts) oder „Hier ist der
   Ausgang ungeklaert" (Stufe senden) — und im zweiten Fall wird NICHT erneut
   gesendet, sondern gefragt. */
export const STUFE = {
  neu: "",
  entwurf: "entwurf",
  entwurfOk: "entwurf-ok",
  senden: "senden",
};

const zahl = (v, ersatz) => (Number.isFinite(Number(v)) ? Number(v) : ersatz);
const text = (v, max) => String(v == null ? "" : v).slice(0, max || 400);

/* ── Zeit ─────────────────────────────────────────────────────────────────
   Die Anzeige ist immer Europe/Zurich, egal wo das Geraet steht: Wer in
   Quantus „18:30" liest, meint Zuerich. Gerechnet wird ausschliesslich in
   Millisekunden seit 1970 — das ueberlebt Zeitzonenwechsel und Sommerzeit. */
export function plane(jetzt, { verzoegerungMs = STANDARD_VERZOEGERUNG_MS, zeitpunkt = null } = {}) {
  const start = zahl(jetzt, 0);
  if (zeitpunkt != null) {
    const ziel = zahl(typeof zeitpunkt === "string" ? Date.parse(zeitpunkt) : zeitpunkt, NaN);
    if (!Number.isFinite(ziel)) return { ok: false, grund: "Zeitpunkt unlesbar" };
    // Eine Zeit in der Vergangenheit ist kein Plan, sondern ein Sofortversand.
    return { ok: true, sendAt: Math.max(ziel, start) };
  }
  const v = zahl(verzoegerungMs, STANDARD_VERZOEGERUNG_MS);
  return { ok: true, sendAt: start + Math.max(0, v) };
}

export function zeigeZeit(ms, zone = VERSANDZONE) {
  const t = zahl(ms, NaN);
  if (!Number.isFinite(t)) return "";
  try {
    return new Intl.DateTimeFormat("de-CH", {
      timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(t));
  } catch (e) {
    return new Date(t).toISOString();
  }
}

/* ── Anlegen ──────────────────────────────────────────────────────────────
   `raw` ist die fertige MIME-Nachricht (base64url) — genau das, was der
   bisherige Sendeweg ohnehin baut. Empfaenger, Betreff und Thread reisen
   zusaetzlich mit, damit Quantus die Zeile anzeigen kann, ohne die Nachricht
   auseinanderzunehmen. Anhaenge stecken bereits im raw. */
export function neuerEintrag({
  id, raw, threadId = null, to = "", cc = "", bcc = "", subject = "",
  vorschau = "", quelle = "quantus", jetzt = 0, verzoegerungMs, zeitpunkt,
  koerper = "", hatAnhaenge = false, inReplyTo = "", references = "",
  messageIdKopf = "", zitat = null,
} = {}) {
  if (!text(id)) return { ok: false, grund: "Ohne Id kein Eintrag" };
  if (!text(raw, 20)) return { ok: false, grund: "Ohne Nachricht kein Versand" };
  if (!text(to)) return { ok: false, grund: "Ohne Empfaenger kein Versand" };
  const geplant = plane(jetzt, { verzoegerungMs, zeitpunkt });
  if (!geplant.ok) return geplant;
  return {
    ok: true,
    eintrag: {
      id: text(id, 80),
      status: STATUS.geplant,
      sendAt: geplant.sendAt,
      createdAt: zahl(jetzt, 0),
      updatedAt: zahl(jetzt, 0),
      zone: VERSANDZONE,
      raw: String(raw),
      threadId: threadId ? text(threadId, 80) : null,
      to: text(to), cc: text(cc), bcc: text(bcc),
      subject: text(subject, 300),
      vorschau: text(vorschau, 500),
      quelle: text(quelle, 40),
      /* Der Klartext liegt zusaetzlich bei, damit sich ein geplanter Eintrag
         spaeter wirklich BEARBEITEN laesst: aus dem fertigen MIME-`raw` liesse
         er sich nicht verlustfrei zurueckgewinnen. Steckt ein Anhang drin, ist
         Neubauen ohne die Anhangsbytes unmoeglich — `hatAnhaenge` sagt der
         Oberflaeche, dass sie den Text dann nicht stillschweigend neu bauen
         darf (sonst faellt der Anhang weg). */
      koerper: text(koerper, 20000),
      hatAnhaenge: !!hatAnhaenge,
      /* Die Antwort-Kopfzeilen liegen ebenfalls bei: wird der Text spaeter
         bearbeitet, muss die neue Nachricht im SELBEN Thread landen. */
      inReplyTo: text(inReplyTo, 400),
      references: text(references, 2000),
      zitat: zitat && typeof zitat === "object" ? zitat : null,
      versuche: 0,
      claim: null,             // { lauf, seit }
      stufe: STUFE.neu,        // wie weit der Versand gekommen ist (siehe oben)
      draftId: null,           // Stufe 1 des Versands
      gmailMessageId: null,    // Stufe 2
      gmailThreadId: null,
      sentAt: null,
      letzterFehler: null,
      /* Unsere eigene RFC-822-Message-ID. Sie steckt im raw und ist der
         einzige Faden, an dem sich eine Nachricht nach einem Absturz
         WIEDERFINDEN laesst: users.messages.list kennt laut Discovery-Dokument
         den Suchbegriff „rfc822msgid:". Ob Gmail eine mitgegebene Message-ID
         behaelt, ist nirgends zugesichert — deshalb ist sie ein
         BESTAETIGUNGSweg und nie ein Grund, noch einmal zu senden. */
      messageIdKopf: text(messageIdKopf, 200) || null,
      ungeklaertSeit: null,    // wann der Ausgang ungeklaert wurde
    },
  };
}

/* ── Was darf man noch? ───────────────────────────────────────────────────
   Ein Eintrag, den ein Lauf gerade uebernommen hat, ist tabu: sonst aendert
   jemand den Text, waehrend Gmail ihn schon verschickt. Ein verwaister Claim
   (Lauf abgestuerzt) gibt den Eintrag nach CLAIM_TIMEOUT_MS wieder frei. */
export function claimOffen(eintrag, jetzt, timeoutMs = CLAIM_TIMEOUT_MS) {
  const c = eintrag && eintrag.claim;
  if (!c || !zahl(c.seit, 0)) return false;
  return zahl(jetzt, 0) - zahl(c.seit, 0) < zahl(timeoutMs, CLAIM_TIMEOUT_MS);
}

export function darfAendern(eintrag, jetzt) {
  if (!eintrag || ENDGUELTIG.has(eintrag.status)) return false;
  if (eintrag.gmailMessageId) return false;          // draussen ist draussen
  if (eintrag.status === STATUS.unklar) return false; // erst klaeren, dann anfassen
  if (claimOffen(eintrag, jetzt)) return false;
  /* Ein verwaister Claim gibt den Eintrag frei — ABER nur, solange kein
     Versand angestossen war. Stand die Stufe schon auf „senden", kann die Mail
     draussen sein; dann darf hier niemand mehr etwas aendern oder abbrechen
     und damit „nicht gesendet" behaupten. Solche Eintraege gehen in den
     Zustand unklar und werden ausdruecklich geklaert. */
  if (eintrag.status === STATUS.sendet && eintrag.stufe === STUFE.senden) return false;
  return eintrag.status === STATUS.geplant || eintrag.status === STATUS.fehlgeschlagen
    || eintrag.status === STATUS.sendet;             // nur mit verwaistem Claim
}

export const darfAbbrechen = darfAendern;

/* ── Aendern, verschieben, abbrechen, sofort senden ───────────────────────── */
export function aendere(eintrag, patch = {}, jetzt = 0) {
  if (!darfAendern(eintrag, jetzt)) {
    return { ok: false, grund: begruendung(eintrag, jetzt) };
  }
  const neu = Object.assign({}, eintrag, { updatedAt: zahl(jetzt, 0) });
  const GRENZE = { subject: 300, koerper: 20000 };
  ["raw", "to", "cc", "bcc", "subject", "vorschau", "koerper"].forEach((k) => {
    if (patch[k] !== undefined) neu[k] = k === "raw" ? String(patch[k]) : text(patch[k], GRENZE[k] || 500);
  });
  if (patch.zeitpunkt !== undefined || patch.verzoegerungMs !== undefined) {
    const geplant = plane(jetzt, { zeitpunkt: patch.zeitpunkt, verzoegerungMs: patch.verzoegerungMs });
    if (!geplant.ok) return geplant;
    neu.sendAt = geplant.sendAt;
  }
  /* Ein bereits angelegter Entwurf traegt jetzt einen ueberholten Text. Er
     wird beim naechsten Lauf erneuert (drafts.update) — deshalb der Vermerk. */
  if (patch.raw !== undefined && neu.draftId) neu.entwurfVeraltet = true;
  neu.status = STATUS.geplant;
  neu.claim = null;
  neu.letzterFehler = null;
  return { ok: true, eintrag: neu };
}

export function brichAb(eintrag, jetzt = 0) {
  if (!darfAbbrechen(eintrag, jetzt)) return { ok: false, grund: begruendung(eintrag, jetzt) };
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: STATUS.abgebrochen, claim: null, updatedAt: zahl(jetzt, 0) }) };
}

export function sofort(eintrag, jetzt = 0) {
  return aendere(eintrag, { zeitpunkt: zahl(jetzt, 0) }, jetzt);
}

function begruendung(eintrag, jetzt) {
  if (!eintrag) return "Diese Mail gibt es nicht mehr.";
  if (eintrag.status === STATUS.gesendet) return "Diese Mail ist bereits gesendet.";
  if (eintrag.status === STATUS.abgebrochen) return "Diese Mail wurde abgebrochen.";
  if (eintrag.status === STATUS.unklar || (eintrag.status === STATUS.sendet && eintrag.stufe === STUFE.senden)) {
    return "Für diese Mail läuft oder lief bereits ein Versand — ob sie draussen ist, "
      + "ist ungeklärt. Bitte in Gmail nachsehen und dort entscheiden.";
  }
  if (eintrag.gmailMessageId) return "Diese Mail ist bereits bei Gmail — sie lässt sich nicht mehr ändern.";
  if (claimOffen(eintrag, jetzt)) return "Diese Mail wird gerade gesendet.";
  return "Diese Mail lässt sich nicht mehr ändern.";
}

/* ── Der Serverlauf ───────────────────────────────────────────────────────── */
export function istFaellig(eintrag, jetzt, timeoutMs = CLAIM_TIMEOUT_MS) {
  if (!eintrag || ENDGUELTIG.has(eintrag.status)) return false;
  if (eintrag.status === STATUS.fehlgeschlagen) return false;
  /* Ein ungeklaerter Ausgang wird NIE von selbst noch einmal angefasst. Hier
     endet die Automatik und beginnt die Frage an den Menschen. */
  if (eintrag.status === STATUS.unklar) return false;
  if (claimOffen(eintrag, jetzt, timeoutMs)) return false;   // ein Lauf ist dran
  // Ein uebernommener, aber verwaister Eintrag ist faellig — unabhaengig von
  // der Uhr: er haengt sonst fuer immer.
  if (eintrag.status === STATUS.sendet) return true;
  return zahl(eintrag.sendAt, Infinity) <= zahl(jetzt, 0);
}

export function faellige(eintraege, jetzt, timeoutMs = CLAIM_TIMEOUT_MS) {
  return (Array.isArray(eintraege) ? eintraege : Object.values(eintraege || {}))
    .filter((e) => istFaellig(e, jetzt, timeoutMs))
    .sort((a, b) => zahl(a.sendAt, 0) - zahl(b.sendAt, 0));
}

export function uebernimm(eintrag, jetzt, lauf) {
  if (!istFaellig(eintrag, jetzt)) return { ok: false, grund: "nicht faellig" };
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: STATUS.sendet, claim: { lauf: text(lauf, 60), seit: zahl(jetzt, 0) },
    updatedAt: zahl(jetzt, 0) }) };
}

export function merkeEntwurf(eintrag, draftId, jetzt) {
  return Object.assign({}, eintrag, { draftId: text(draftId, 120),
    stufe: STUFE.entwurfOk, entwurfVeraltet: false, updatedAt: zahl(jetzt, 0) });
}

/* Die Stufe wird VOR dem Gmail-Aufruf festgehalten — deshalb ein eigener,
   winziger Schritt statt eines Nebeneffekts. */
export function setzeStufe(eintrag, stufe, jetzt) {
  return Object.assign({}, eintrag, { stufe: text(stufe, 20), updatedAt: zahl(jetzt, 0) });
}

/* Ungeklaert: Ein Versand war angestossen, und weder Gmail noch unsere eigene
   Message-ID sagen, ob die Mail draussen ist. Der Eintrag bleibt stehen,
   sichtbar, ohne Wiederholung — die Entscheidung trifft ein Mensch. */
export function markiereUnklar(eintrag, grund, jetzt) {
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: STATUS.unklar,
    claim: null,
    ungeklaertSeit: zahl(jetzt, 0),
    letzterFehler: text(grund || "Der Ausgang dieses Versands ist ungeklärt.", 300),
    updatedAt: zahl(jetzt, 0) }) };
}

/* Die beiden ausdruecklichen Klaerungen. Beide setzen einen MENSCHEN voraus,
   der in Gmail nachgesehen hat; automatisch geschieht hier nichts. */
export function klaereGesendet(eintrag, jetzt, gmailMessageId = null) {
  if (!eintrag || eintrag.status !== STATUS.unklar) {
    return { ok: false, grund: "Nur ein ungeklärter Versand lässt sich so klären." };
  }
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: STATUS.gesendet,
    gmailMessageId: gmailMessageId ? text(gmailMessageId, 120) : eintrag.gmailMessageId,
    sentAt: zahl(eintrag.sentAt, 0) || zahl(jetzt, 0),
    geklaertDurch: "nutzer", claim: null, letzterFehler: null, updatedAt: zahl(jetzt, 0) }) };
}

export function klaereNichtGesendet(eintrag, jetzt) {
  if (!eintrag || eintrag.status !== STATUS.unklar) {
    return { ok: false, grund: "Nur ein ungeklärter Versand lässt sich so klären." };
  }
  /* Der Mensch sagt: nichts angekommen. Erst dann beginnt der Versand wieder
     bei null — ohne alten Entwurf, ohne alte Stufe, mit neuer Message-ID
     (die vergibt die Warteschlange beim naechsten Anlauf). */
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: STATUS.geplant, sendAt: zahl(jetzt, 0), stufe: STUFE.neu,
    draftId: null, draftMessageId: null, entwurfVeraltet: false,
    geklaertDurch: "nutzer", claim: null, versuche: 0,
    letzterFehler: null, ungeklaertSeit: null, updatedAt: zahl(jetzt, 0) }) };
}

/* Gesendet ist erst, was Gmail mit dem Label SENT bestaetigt. Ohne diese
   Bestaetigung bleibt der Eintrag in Arbeit — lieber ein zweiter Blick als
   eine Mail, die als gesendet gilt und nie ankam. */
export function bestaetigtGesendet(gmailNachricht) {
  const m = gmailNachricht && typeof gmailNachricht === "object" ? gmailNachricht : null;
  if (!m || !text(m.id)) return false;
  const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
  return labels.indexOf("SENT") >= 0;
}

export function markiereGesendet(eintrag, gmailNachricht, jetzt) {
  if (!bestaetigtGesendet(gmailNachricht)) {
    return { ok: false, grund: "Gmail hat den Versand nicht bestaetigt (kein SENT)" };
  }
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: STATUS.gesendet,
    stufe: STUFE.neu,
    gmailMessageId: text(gmailNachricht.id, 120),
    gmailThreadId: gmailNachricht.threadId ? text(gmailNachricht.threadId, 120) : eintrag.threadId,
    sentAt: zahl(jetzt, 0),
    claim: null, letzterFehler: null, updatedAt: zahl(jetzt, 0) }) };
}

/* Ein Fehlschlag verschiebt, er verwirft nicht: 1, 5, 25 … Minuten, hoechstens
   eine Stunde. Erst nach MAX_VERSUCHE bleibt der Eintrag sichtbar stehen —
   sichtbar, weil eine stumm verschwundene Mail das Schlimmste waere. */
export function ruecksprungMs(versuche) {
  const n = Math.max(1, zahl(versuche, 1));
  return Math.min(60 * 60 * 1000, Math.round(60 * 1000 * Math.pow(5, n - 1)));
}

export function markiereFehler(eintrag, fehler, jetzt) {
  const versuche = zahl(eintrag && eintrag.versuche, 0) + 1;
  const aufgegeben = versuche >= MAX_VERSUCHE;
  return { ok: true, eintrag: Object.assign({}, eintrag, {
    status: aufgegeben ? STATUS.fehlgeschlagen : STATUS.geplant,
    versuche,
    sendAt: aufgegeben ? eintrag.sendAt : zahl(jetzt, 0) + ruecksprungMs(versuche),
    claim: null,
    letzterFehler: text((fehler && fehler.message) || fehler, 300),
    updatedAt: zahl(jetzt, 0) }) };
}

/* ── Was Quantus anzeigt ──────────────────────────────────────────────────
   Eine geplante Mail ist eine AUSGEHENDE Zeile in Quantus — kein Posteingang,
   keine Mail an sich selbst. Der Eingangsthread bleibt unberuehrt, bis der
   Versand bestaetigt ist. */
export function zeile(eintrag, jetzt = 0, zone = VERSANDZONE) {
  if (!eintrag) return null;
  const s = eintrag.status;
  const zeit = zeigeZeit(eintrag.sendAt, zone);
  const marke = { richtung: "ausgehend", geplant: s === STATUS.geplant };
  if (s === STATUS.geplant) {
    return Object.assign(marke, { status: "Geplant", text: "Geht " + zeit + " raus (" + zone + ")",
      offen: true, restMs: Math.max(0, zahl(eintrag.sendAt, 0) - zahl(jetzt, 0)) });
  }
  if (s === STATUS.sendet) return Object.assign(marke, { status: "Wird gesendet", text: "Gmail übernimmt gerade", offen: false });
  if (s === STATUS.gesendet) {
    return Object.assign(marke, { geplant: false, status: "Gesendet",
      text: "Gesendet " + zeigeZeit(eintrag.sentAt, zone) + " (" + zone + ")", offen: false });
  }
  if (s === STATUS.abgebrochen) return Object.assign(marke, { geplant: false, status: "Abgebrochen", text: "Nicht gesendet", offen: false });
  if (s === STATUS.unklar) {
    return Object.assign(marke, { geplant: false, status: "Ungeklärt",
      text: "Der Versand wurde angestossen, der Ausgang ist ungeklärt — bitte in Gmail nachsehen. "
        + "Es wird nichts von selbst wiederholt.",
      offen: true, klaerung: true });
  }
  return Object.assign(marke, { geplant: false, status: "Fehlgeschlagen",
    text: "Nicht gesendet — " + (eintrag.letzterFehler || "Grund unbekannt"), offen: true });
}

export default {
  VERSANDZONE, STANDARD_VERZOEGERUNG_MS, CLAIM_TIMEOUT_MS, MAX_VERSUCHE, STATUS, STUFE,
  plane, zeigeZeit, neuerEintrag, claimOffen, darfAendern, darfAbbrechen,
  aendere, brichAb, sofort, istFaellig, faellige, uebernimm, merkeEntwurf, setzeStufe,
  bestaetigtGesendet, markiereGesendet, ruecksprungMs, markiereFehler, zeile,
  markiereUnklar, klaereGesendet, klaereNichtGesendet,
};
