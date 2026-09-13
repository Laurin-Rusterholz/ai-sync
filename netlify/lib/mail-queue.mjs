/* ══ Geplanter Mailversand — der Serverteil ══════════════════════════════════
 *
 * Die Planung liegt serverseitig (RTDB `mail/outbox/<id>`) und wird von einem
 * Serverlauf abgearbeitet. Kein Browser-Timer: ein geschlossener Rechner, ein
 * Neuladen oder ein Gerät in einer anderen Zeitzone ändert nichts daran, dass
 * die Mail zu ihrer Zeit rausgeht.
 *
 * Gmail kann Versand NICHT planen (Discovery v1, Revision 20260907: weder
 * users.messages.send noch users.drafts.send kennen ein Feld dafür, und es
 * gibt kein Label SCHEDULED). Gmail ist deshalb ausschliesslich Versandkanal
 * und die Quelle für den BESTÄTIGTEN Versand. Gmails eigene Ansicht „Geplant"
 * wird nicht vorgetäuscht.
 *
 * ── WAS DIE DURCHSICHT VOM 13.09.2026 KORRIGIERT HAT ──────────────────────
 * Die erste Fassung hatte drei Löcher, jedes davon ein möglicher Doppelversand
 * oder eine falsche Auskunft:
 *
 * 1. DIE STUFE WURDE NICHT VORHER FESTGEHALTEN. Die draftId lebte nur in einer
 *    lokalen Variablen und wurde erst NACH dem Senden geschrieben. Ging die
 *    Antwort verloren (oder starb der Lauf), stand im Speicher ein Eintrag
 *    OHNE draftId — der nächste Lauf legte einen zweiten Entwurf an und sandte
 *    ein zweites Mal. Jetzt wird jede unumkehrbare Handlung VORHER vermerkt
 *    (K.STUFE: entwurf → entwurf-ok → senden) und der Vermerk überlebt jeden
 *    Absturz.
 *
 * 2. ÄNDERN UND ABBRECHEN SCHRIEBEN OHNE VERGLEICH. Zwischen Lesen und
 *    Schreiben konnte ein Lauf den Eintrag übernehmen; der Abbruch meldete
 *    dann Erfolg, während Gmail bereits sandte. Jetzt läuft JEDER Schreibgang
 *    über die Kennung (ETag, if-match), und der Lauf schreibt nur, solange der
 *    Zugriff noch ihm gehört (Fencing).
 *
 * 3. draft.message.id IST NICHT DIE ID DER GESENDETEN NACHRICHT. Das
 *    Discovery-Dokument sagt zur Draft-Id ausdrücklich „The immutable ID of
 *    the draft" — über die message.id nach dem Senden sagt es NICHTS. Darauf
 *    einen Abgleich zu stützen, war eine Annahme. Wiedergefunden wird die
 *    Nachricht jetzt über eine Message-ID, die WIR in die Nachricht schreiben,
 *    gesucht mit `rfc822msgid:` (im Discovery-Dokument als Suchbegriff von
 *    users.messages.list dokumentiert). Findet sich nichts, wird NICHT erneut
 *    gesendet: der Eintrag geht in den Zustand „unklar" und fragt den Menschen.
 *
 * GRUNDSATZ: Eine zweite Mail ist schlimmer als eine offene Frage.
 *
 * Alles Äussere kommt als Abhängigkeit herein (db, gmail, jetzt, neueId),
 * damit der Test den ganzen Lauf ohne Netz und ohne echte Uhr fahren kann.
 * ═════════════════════════════════════════════════════════════════════════ */
import K from "../../public/mail-queue-core.js";
import M from "./mail-mime.mjs";

const WURZEL = "mail/outbox";
const MAX_PRO_LAUF = 10;

/* Zwei Fehlerarten, die der Lauf auseinanderhalten muss. */
class UnklarFehler extends Error { constructor(grund) { super(grund); this.unklar = true; } }
class FremdgriffFehler extends Error { constructor() { super("Der Eintrag gehört diesem Lauf nicht mehr."); this.fremdgriff = true; } }

export function createQueue({
  dbGet, dbGetEtag, dbSet, dbRemove, gmail, jetzt = () => Date.now(), neueId,
  wurzel = WURZEL, maxProLauf = MAX_PRO_LAUF, messageIdDomain = "quantus.mail",
} = {}) {
  const pfad = (id) => `${wurzel}/${id}`;
  const id = neueId || (() => "out_" + Math.random().toString(36).slice(2, 12));

  async function alle() {
    const roh = (await dbGet(wurzel)) || {};
    return Object.keys(roh).map((k) => roh[k]).filter((e) => e && e.id);
  }
  const liesMitKennung = async (idWert) => {
    if (typeof dbGetEtag === "function") return dbGetEtag(pfad(idWert));
    return { value: await dbGet(pfad(idWert)), etag: null };
  };

  /* ── Was die Oberfläche aufruft ──────────────────────────────────────────
     Jeder dieser Wege liest MIT Kennung und schreibt MIT derselben Kennung.
     Wer dazwischen kommt, verliert — und bekommt gesagt, warum. */
  async function plane(eingabe = {}) {
    const neueKennung = eingabe.id || id();
    /* Die eigene Message-ID wird HIER gesetzt, nicht im Browser: sie muss zur
       Nachricht gehören, die wirklich abgeschickt wird. */
    const mime = M.dekodiere(eingabe.raw || "");
    const gesetzt = M.setzeMessageId(mime, neueKennung + "." + jetzt().toString(36) + "@" + messageIdDomain);
    const neu = K.neuerEintrag(Object.assign({}, eingabe, {
      id: neueKennung,
      raw: M.kodiere(gesetzt.mime),
      messageIdKopf: gesetzt.id,
      hatAnhaenge: eingabe.hatAnhaenge !== undefined ? eingabe.hatAnhaenge : M.hatAnhaenge(gesetzt.mime),
      jetzt: jetzt(),
    }));
    if (!neu.ok) return { ok: false, grund: neu.grund };
    const r = await dbSet(pfad(neu.eintrag.id), neu.eintrag);
    if (r && r.conflict) return { ok: false, grund: "Diese Mail wurde gerade woanders angelegt." };
    return { ok: true, eintrag: neu.eintrag };
  }

  async function liste() {
    const e = await alle();
    return e.sort((a, b) => (a.sendAt || 0) - (b.sendAt || 0));
  }

  /* Der gemeinsame Kern von ändern, abbrechen und klären: lesen mit Kennung,
     prüfen, schreiben mit derselben Kennung. Kommt jemand dazwischen, wird
     EINMAL frisch gelesen und neu geprüft — dann steht das Ergebnis. */
  async function mitVergleich(idWert, wandle, versuche = 2) {
    for (let n = 0; n < versuche; n++) {
      const { value: e, etag } = await liesMitKennung(idWert);
      if (!e) return { ok: false, grund: "Diese Mail gibt es nicht mehr." };
      const r = wandle(e);
      if (!r.ok) return r;
      const gesetzt = await dbSet(pfad(idWert), r.eintrag, { ifMatch: etag });
      if (!(gesetzt && gesetzt.conflict)) return r;
      // Konflikt: jemand anders war schneller — noch einmal frisch ansehen.
    }
    return { ok: false, grund: "Diese Mail ist gerade in Bewegung — bitte gleich noch einmal versuchen." };
  }

  /* Ändern hält die Anhänge. Es wird NICHT die ganze Nachricht neu gebaut,
     sondern im gespeicherten MIME genau der Körper (und bei Bedarf der
     Betreff) ersetzt; jeder Anhang bleibt Zeichen für Zeichen stehen. */
  function neuesRaw(e, patch) {
    if (patch.koerperTeil === undefined && patch.koerper === undefined
      && patch.subject === undefined && patch.raw === undefined) return null;
    const alt = M.dekodiere(e.raw || "");
    if (patch.raw !== undefined && patch.koerperTeil === undefined) {
      /* Eine komplett neue Nachricht darf nur dann kommen, wenn die alte
         keine Anhänge hat — sonst gingen sie unbemerkt verloren. */
      if (M.hatAnhaenge(alt)) return { fehler: "Diese Mail hat einen Anhang — sie lässt sich nur über den Körper ändern." };
      const neu = M.dekodiere(patch.raw);
      const mitId = e.messageIdKopf ? M.setzeMessageId(neu, e.messageIdKopf).mime : neu;
      return { mime: mitId };
    }
    let mime = alt;
    if (patch.koerperTeil !== undefined) mime = M.ersetzeKoerper(mime, String(patch.koerperTeil));
    else if (patch.koerper !== undefined) mime = M.ersetzeKoerper(mime, M.textTeil(patch.koerper));
    if (patch.subject !== undefined) mime = M.ersetzeBetreff(mime, patch.subject);
    return { mime };
  }

  async function aendere(idWert, patch = {}) {
    return mitVergleich(idWert, (e) => {
      const gebaut = neuesRaw(e, patch);
      if (gebaut && gebaut.fehler) return { ok: false, grund: gebaut.fehler };
      const feld = Object.assign({}, patch);
      delete feld.koerperTeil;
      if (gebaut && gebaut.mime) feld.raw = M.kodiere(gebaut.mime);
      const r = K.aendere(e, feld, jetzt());
      if (r.ok && gebaut && gebaut.mime) r.eintrag.hatAnhaenge = M.hatAnhaenge(gebaut.mime);
      return r;
    });
  }

  async function brichAb(idWert) {
    const r = await mitVergleich(idWert, (e) => K.brichAb(e, jetzt()));
    if (!r.ok) return r;
    /* Der Entwurf bei Gmail gehört zu dieser Planung — mit dem Abbruch geht
       auch er weg. Schlägt das fehl, bleibt der Abbruch trotzdem stehen: die
       Mail geht nicht raus, und ein verwaister Entwurf ist das kleinere Übel. */
    if (r.eintrag.draftId) {
      try { await gmail("DELETE", "/users/me/drafts/" + encodeURIComponent(r.eintrag.draftId)); }
      catch (err) { /* best effort — der Abbruch steht bereits */ }
    }
    return r;
  }

  async function sofort(idWert) {
    return aendere(idWert, { zeitpunkt: jetzt() });
  }

  /* Die beiden ausdrücklichen Klärungen eines ungeklärten Versands. Beide
     setzen einen Menschen voraus, der in Gmail nachgesehen hat. */
  async function klaereGesendet(idWert) {
    return mitVergleich(idWert, (e) => K.klaereGesendet(e, jetzt()));
  }
  async function klaereNichtGesendet(idWert) {
    return mitVergleich(idWert, (e) => K.klaereNichtGesendet(e, jetzt()));
  }

  /* ── Der Lauf ──────────────────────────────────────────────────────────── */
  async function lauf(laufId = "lauf_" + Date.now().toString(36)) {
    const bericht = { gesendet: [], verschoben: [], aufgegeben: [], nachgezogen: [], ungeklaert: [], uebersprungen: 0 };
    const faellig = K.faellige(await alle(), jetzt()).slice(0, maxProLauf);
    for (const roh of faellig) {
      /* Der Zugriff ist die heikle Stelle: Zwei Läufe zur selben Sekunde
         dürfen NICHT dieselbe Mail nehmen. Deshalb wird frisch MIT Kennung
         gelesen und mit genau dieser Kennung geschrieben (if-match). Wer die
         Kennung nicht mehr trifft, hat verloren und lässt die Finger davon. */
      const { value: e0, etag } = await liesMitKennung(roh.id);
      if (!e0 || !K.istFaellig(e0, jetzt())) { bericht.uebersprungen++; continue; }
      const uebernommen = K.uebernimm(e0, jetzt(), laufId);
      if (!uebernommen.ok) { bericht.uebersprungen++; continue; }
      const gesetzt = await dbSet(pfad(e0.id), uebernommen.eintrag, { ifMatch: etag });
      if (gesetzt && gesetzt.conflict) { bericht.uebersprungen++; continue; }

      const zaun = zaunFuer(e0.id, laufId);
      let e = uebernommen.eintrag;
      try {
        e = await versende(e, zaun);
        if (e.status === K.STATUS.gesendet) bericht.gesendet.push(e.id);
        else if (e.status === K.STATUS.unklar) bericht.ungeklaert.push(e.id);
      } catch (err) {
        if (err && err.fremdgriff) { bericht.uebersprungen++; continue; }  // NICHTS schreiben
        if (err && err.unklar) {
          e = K.markiereUnklar(e, err.message, jetzt()).eintrag;
          await zaun.schreibeUnbedingt(e);
          bericht.ungeklaert.push(e.id);
          continue;
        }
        /* Ein Fehlschlag VOR dem Senden darf wiederholt werden. War der
           Versand schon angestossen, kommen wir hier gar nicht mehr an:
           versende() klärt diesen Fall selbst und wirft UnklarFehler. */
        const f = K.markiereFehler(e, err, jetzt());
        e = f.eintrag;
        try { await zaun.schreibe(e); } catch (zweit) { bericht.uebersprungen++; continue; }
        (e.status === K.STATUS.fehlgeschlagen ? bericht.aufgegeben : bericht.verschoben).push(e.id);
      }
    }
    return bericht;
  }

  /* Der Zaun (Fencing): Dieser Lauf schreibt nur, solange der Zugriff noch
     ihm gehört. Läuft sein Claim ab und übernimmt ein anderer, ist jeder
     weitere Schreibgang ein Fremdgriff — bis auf einen: einen BESTÄTIGTEN
     Versand muss er festhalten, koste es, was es wolle. Ginge diese Auskunft
     verloren, sendete ein späterer Lauf dieselbe Mail ein zweites Mal. */
  function zaunFuer(idWert, laufId) {
    return {
      async schreibe(neu) {
        const { value: da, etag } = await liesMitKennung(idWert);
        if (!da) throw new FremdgriffFehler();
        if (!da.claim || da.claim.lauf !== laufId) throw new FremdgriffFehler();
        const r = await dbSet(pfad(idWert), neu, { ifMatch: etag });
        if (r && r.conflict) throw new FremdgriffFehler();
        return neu;
      },
      async schreibeUnbedingt(neu) {
        for (let n = 0; n < 3; n++) {
          const { etag } = await liesMitKennung(idWert);
          const r = await dbSet(pfad(idWert), neu, { ifMatch: etag });
          if (!(r && r.conflict)) return neu;
        }
        await dbSet(pfad(idWert), neu);   // letzter Ausweg: die Wahrheit muss stehen
        return neu;
      },
    };
  }

  /* Wiederfinden statt raten: Gibt es zu unserer Message-ID eine Nachricht mit
     Label SENT? users.messages.list kennt den Suchbegriff `rfc822msgid:`
     (Discovery-Dokument, Parameter q). Findet sich nichts, heisst das NICHT
     „nicht gesendet" — es heisst „unbekannt". */
  async function suchePerMessageId(e) {
    if (!e.messageIdKopf) return null;
    try {
      const treffer = await gmail("GET", "/users/me/messages",
        { query: { q: "rfc822msgid:" + e.messageIdKopf, maxResults: 5 } });
      for (const m of (treffer && treffer.messages) || []) {
        const voll = await gmail("GET", "/users/me/messages/" + encodeURIComponent(m.id),
          { query: { format: "minimal" } });
        if (K.bestaetigtGesendet(voll)) return voll;
      }
    } catch (err) { /* eine erfolglose Suche ist kein Beweis — sie bleibt still */ }
    return null;
  }

  async function entwurfLesen(draftId) {
    try {
      const d = await gmail("GET", "/users/me/drafts/" + encodeURIComponent(draftId), { query: { format: "minimal" } });
      return d && d.id ? d : null;
    } catch (err) {
      if (err && (err.status === 404 || /404/.test(String(err.message)))) return null;
      throw err;
    }
  }

  /* Nach einem angestossenen Versand: Was ist wirklich passiert?
     Reihenfolge mit Absicht — erst der Beweis, dass etwas draussen ist, dann
     der Beweis, dass nichts draussen ist, und erst danach das Eingeständnis,
     es nicht zu wissen. */
  async function klaerung(e, zaun, grund) {
    const nachricht = await suchePerMessageId(e);
    if (nachricht) {
      const fertig = K.markiereGesendet(e, nachricht, jetzt());
      if (fertig.ok) return await zaun.schreibeUnbedingt(fertig.eintrag);
    }
    if (e.draftId) {
      let steht = null;
      try { steht = await entwurfLesen(e.draftId); } catch (err) { steht = null; }
      if (steht) return { weiter: true };   // der Entwurf liegt noch da: es ist nichts raus
    }
    throw new UnklarFehler(grund || "Der Versand wurde angestossen; ob die Mail draussen ist, "
      + "liess sich nicht feststellen. Es wird nichts wiederholt — bitte in Gmail nachsehen.");
  }

  async function versende(eintrag, zaun) {
    let e = eintrag;

    /* Schon eine bestätigte Nachricht? Dann nur den Stand nachziehen. */
    if (e.gmailMessageId) {
      const m = await gmail("GET", "/users/me/messages/" + encodeURIComponent(e.gmailMessageId),
        { query: { format: "minimal" } });
      const fertig = K.markiereGesendet(e, m, jetzt());
      if (fertig.ok) return await zaun.schreibeUnbedingt(fertig.eintrag);
      throw new UnklarFehler("Gmail bestätigt die gemerkte Nachricht nicht als gesendet.");
    }

    /* Ein früherer Lauf war schon beim Senden — hier wird NICHT einfach noch
       einmal gesendet, sondern erst geklärt. */
    if (e.stufe === K.STUFE.senden) {
      const r = await klaerung(e, zaun);
      if (r && r.weiter !== true) return r;   // geklärt: gesendet
      // sonst: der Entwurf steht noch, es ist nichts raus — weiter unten senden
    }

    /* Stufe 1 — Entwurf. Er ist die Duplikatsperre, und dass es ihn gibt,
       wird VOR dem Aufruf vermerkt. */
    if (!e.draftId) {
      if (e.stufe !== K.STUFE.entwurf) e = await zaun.schreibe(K.setzeStufe(e, K.STUFE.entwurf, jetzt()));
      const nachricht = { raw: e.raw };
      if (e.threadId) nachricht.threadId = e.threadId;
      const entwurf = await gmail("POST", "/users/me/drafts", { body: { message: nachricht } });
      if (!entwurf || !entwurf.id) throw new Error("Gmail hat keinen Entwurf angelegt");
      const gemerkt = K.merkeEntwurf(e, entwurf.id, jetzt());
      gemerkt.gmailThreadId = (entwurf.message && entwurf.message.threadId) || e.threadId || null;
      e = await zaun.schreibe(gemerkt);
    } else if (e.entwurfVeraltet) {
      const vorhanden = await entwurfLesen(e.draftId);
      if (!vorhanden) {
        /* Der Entwurf ist weg, ohne dass wir gesendet hätten: entweder hat ihn
           ein Mensch gelöscht oder er ist doch hinausgegangen. Nicht raten. */
        const r = await klaerung(e, zaun, "Der Entwurf ist bei Gmail verschwunden, bevor diese Planung ihn senden konnte.");
        if (r && r.weiter !== true) return r;
      } else {
        const nachricht = { raw: e.raw };
        if (e.threadId) nachricht.threadId = e.threadId;
        await gmail("PUT", "/users/me/drafts/" + encodeURIComponent(e.draftId),
          { body: { id: e.draftId, message: nachricht } });
        e = await zaun.schreibe(Object.assign({}, e, { entwurfVeraltet: false }));
      }
    }

    /* Stufe 2 — senden. Der Vermerk steht VOR dem Aufruf: Ab hier kann die
       Mail draussen sein, auch wenn niemand die Antwort gesehen hat. */
    e = await zaun.schreibe(K.setzeStufe(e, K.STUFE.senden, jetzt()));
    let gesendet;
    try {
      gesendet = await gmail("POST", "/users/me/drafts/send", { body: { id: e.draftId } });
    } catch (err) {
      const r = await klaerung(e, zaun, "Gmail hat den Versand nicht beantwortet (" + ((err && err.message) || "Fehler")
        + "). Ob die Mail draussen ist, ist ungeklärt — es wird nichts wiederholt.");
      if (r && r.weiter !== true) return r;
      throw new UnklarFehler("Der Versand ist ungeklärt.");
    }

    /* Gesendet ist erst, was SENT trägt. Die Antwort von drafts.send ist eine
       Message — ihre Id gilt hier NUR aus dieser Antwort; die alte message.id
       des Entwurfs wird bewusst nicht mehr herangezogen. */
    let nachricht = gesendet;
    if (!K.bestaetigtGesendet(nachricht) && gesendet && gesendet.id) {
      try {
        nachricht = await gmail("GET", "/users/me/messages/" + encodeURIComponent(gesendet.id),
          { query: { format: "minimal" } });
      } catch (err) { nachricht = gesendet; }
    }
    const fertig = K.markiereGesendet(e, nachricht, jetzt());
    if (fertig.ok) return await zaun.schreibeUnbedingt(fertig.eintrag);

    // Keine Bestätigung — aber angestossen. Also klären, nicht wiederholen.
    const r = await klaerung(e, zaun, "Gmail hat den Versand nicht als SENT bestätigt.");
    if (r && r.weiter !== true) return r;
    throw new UnklarFehler("Gmail hat den Versand nicht bestätigt.");
  }

  return {
    plane, liste, aendere, brichAb, sofort, lauf,
    klaereGesendet, klaereNichtGesendet,
    _versende: versende, _zaunFuer: zaunFuer,
  };
}

export default { createQueue, WURZEL };
