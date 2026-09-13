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
  /* Ein Anfrageschlüssel kommt von aussen und wird zur Ablagestelle — er muss
     deshalb ein harmloser Name sein, lang genug, um nicht zufällig zu kollidieren. */
  function schluesselVon(wert) {
    const s = String(wert == null ? "" : wert).trim();
    return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
  }

  /* PLANEN IST WIEDERHOLBAR
     Befund der unabhängigen Gegenprobe (13.09.2026): Ging die Antwort auf
     „plane" verloren, entstand beim zweiten Klick ein ZWEITER Eintrag — und
     damit später eine zweite Mail. Der Browser schickt deshalb einen stabilen
     Anfrageschlüssel mit; er wird zur Kennung des Eintrags. Zweiter Versuch
     heisst dann: dieselbe Stelle. Angelegt wird nur, wenn dort noch NICHTS
     liegt (if-match auf die leere Stelle); liegt schon etwas, kommt genau
     dieser Eintrag unverändert zurück. Eine Wiederholung überschreibt also
     nie den Inhalt — auch nicht mit einer abweichenden Nutzlast. */
  async function plane(eingabe = {}) {
    const schluessel = schluesselVon(eingabe.anfrageSchluessel);
    const neueKennung = eingabe.id || (schluessel ? "out_" + schluessel : id());

    if (schluessel) {
      const vorher = await liesMitKennung(neueKennung);
      if (vorher.value && vorher.value.id) return { ok: true, eintrag: vorher.value, bestand: true };
      const gebaut = baueEintrag(eingabe, neueKennung);
      if (!gebaut.ok) return gebaut;
      const r = await dbSet(pfad(neueKennung), gebaut.eintrag, { ifMatch: vorher.etag });
      if (r && r.conflict) {
        const jetztDa = await liesMitKennung(neueKennung);
        if (jetztDa.value && jetztDa.value.id) return { ok: true, eintrag: jetztDa.value, bestand: true };
        return { ok: false, grund: "Diese Mail wurde gerade woanders angelegt." };
      }
      return { ok: true, eintrag: gebaut.eintrag };
    }

    const gebaut = baueEintrag(eingabe, neueKennung);
    if (!gebaut.ok) return gebaut;
    const r = await dbSet(pfad(neueKennung), gebaut.eintrag);
    if (r && r.conflict) return { ok: false, grund: "Diese Mail wurde gerade woanders angelegt." };
    return { ok: true, eintrag: gebaut.eintrag };
  }

  function baueEintrag(eingabe, kennung) {
    /* Die eigene Message-ID wird HIER gesetzt, nicht im Browser: sie muss zur
       Nachricht gehören, die wirklich abgeschickt wird. */
    const mime = M.dekodiere(eingabe.raw || "");
    const gesetzt = M.setzeMessageId(mime, kennung + "." + jetzt().toString(36) + "@" + messageIdDomain);
    const neu = K.neuerEintrag(Object.assign({}, eingabe, {
      id: kennung,
      raw: M.kodiere(gesetzt.mime),
      messageIdKopf: gesetzt.id,
      hatAnhaenge: eingabe.hatAnhaenge !== undefined ? eingabe.hatAnhaenge : M.hatAnhaenge(gesetzt.mime),
      jetzt: jetzt(),
    }));
    if (!neu.ok) return { ok: false, grund: neu.grund };
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
  /* WAS BEIM ÄNDERN WIRKLICH IN DER NACHRICHT LANDEN MUSS
     Befund der unabhängigen Gegenprobe (13.09.2026): Hier wurden nur Körper
     und Betreff ersetzt — `to`, `cc` und `bcc` gingen ausschliesslich in die
     ANZEIGEFELDER des Eintrags. In Quantus stand danach der neue Empfänger,
     hinausgegangen wäre die Mail an den alten. Ein Release-Blocker: Was die
     Oberfläche zeigt, muss das sein, was Gmail zugestellt bekommt.
     Deshalb wandern Empfänger, Betreff, Körper und neue Anhänge alle in
     dieselbe gespeicherte MIME-Nachricht — und nur dort steht die Wahrheit. */
  function neuesRaw(e, patch) {
    const beruehrt = ["koerperTeil", "koerper", "subject", "raw", "to", "cc", "bcc", "neueAnhaenge"]
      .some((k) => patch[k] !== undefined);
    if (!beruehrt) return null;
    const alt = M.dekodiere(e.raw || "");
    let mime = alt;
    if (patch.raw !== undefined && patch.koerperTeil === undefined) {
      /* Eine komplett neue Nachricht darf nur dann kommen, wenn die alte
         keine Anhänge hat — sonst gingen sie unbemerkt verloren. */
      if (M.hatAnhaenge(alt)) return { fehler: "Diese Mail hat einen Anhang — sie lässt sich nur über den Körper ändern." };
      mime = M.dekodiere(patch.raw);
      if (e.messageIdKopf) mime = M.setzeMessageId(mime, e.messageIdKopf).mime;
    } else {
      if (patch.koerperTeil !== undefined) mime = M.ersetzeKoerper(mime, String(patch.koerperTeil));
      else if (patch.koerper !== undefined) mime = M.ersetzeKoerper(mime, M.textTeil(patch.koerper));
    }
    if (patch.subject !== undefined) mime = M.ersetzeBetreff(mime, patch.subject);
    // Empfänger IMMER mitziehen — injektionssicher, leeres Cc/Bcc fliegt raus.
    if (patch.to !== undefined || patch.cc !== undefined || patch.bcc !== undefined) {
      mime = M.ersetzeEmpfaenger(mime, { to: patch.to, cc: patch.cc, bcc: patch.bcc });
    }
    /* Nachgereichte Anhänge kommen HINZU. Ohne diesen Weg würde eine Datei,
       die jemand im Bearbeiten-Dialog anhängt, still verschwinden. */
    if (Array.isArray(patch.neueAnhaenge) && patch.neueAnhaenge.length) {
      mime = M.fuegeAnhaengeAn(mime, patch.neueAnhaenge.map((a) => (
        typeof a === "string" ? a : M.anhangTeil({ name: a && a.name, typ: a && a.typ, daten: a && a.daten })
      )));
    }
    return { mime };
  }

  async function aendere(idWert, patch = {}) {
    return mitVergleich(idWert, (e) => {
      const gebaut = neuesRaw(e, patch);
      if (gebaut && gebaut.fehler) return { ok: false, grund: gebaut.fehler };
      const feld = Object.assign({}, patch);
      delete feld.koerperTeil; delete feld.neueAnhaenge;
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
        if (err && err.fremdgriff) { bericht.uebersprungen++; continue; }
        /* AB HIER NIE MEHR MIT `e` ARBEITEN.
           Befund der unabhängigen Gegenprobe (13.09.2026): Hier stand
           `K.markiereFehler(e, …)` mit `e` = dem Stand VOR dem Versand. Schlug
           der Schreibgang nach einem BESTÄTIGTEN Versand fehl, machte dieser
           Zweig daraus wieder „geplant" — Stufe und draftId waren überschrieben,
           und der nächste Lauf sandte ein zweites Mal. Jeder Abschluss liest
           deshalb den GESPEICHERTEN Stand und schreibt nur darauf. */
        const schluss = err && err.unklar
          ? await zaun.festhaltenUnklar(err.message)
          : await zaun.festhaltenFehler(err);
        if (!schluss) { bericht.uebersprungen++; continue; }
        if (schluss.status === K.STATUS.gesendet) bericht.gesendet.push(schluss.id);
        else if (schluss.status === K.STATUS.unklar) bericht.ungeklaert.push(schluss.id);
        else if (schluss.status === K.STATUS.fehlgeschlagen) bericht.aufgegeben.push(schluss.id);
        else bericht.verschoben.push(schluss.id);
      }
    }
    return bericht;
  }

  /* DER ZAUN (Fencing)
     Dieser Lauf schreibt nur, solange der Zugriff noch ihm gehört. Läuft sein
     Claim ab und übernimmt ein anderer, ist jeder weitere Schreibgang ein
     Fremdgriff.

     Zwei Dinge sind hier wichtiger als Bequemlichkeit:
     1. KEIN SNAPSHOT. Jeder Abschluss (gesendet, ungeklärt, Fehlschlag) liest
        den GESPEICHERTEN Stand und rechnet auf ihm weiter. Ein mitgeführtes
        Objekt aus der Zeit vor dem Versand darf nie zurückgeschrieben werden —
        es enthielte weder Stufe noch draftId und machte den Versand wiederholbar.
     2. KEINE RÜCKSTUFUNG. Was gespeichert schon „gesendet" oder „abgebrochen"
        ist, wird von hier aus nicht mehr verändert. Auch ein Notschreibgang
        überschreibt das nicht. */
  function zaunFuer(idWert, laufId) {
    const zaun = {
      angestossen: false,        // ab hier kann die Mail draussen sein

      async schreibe(neu) {
        const { value: da, etag } = await liesMitKennung(idWert);
        if (!da) throw new FremdgriffFehler();
        if (!da.claim || da.claim.lauf !== laufId) throw new FremdgriffFehler();
        const r = await dbSet(pfad(idWert), neu, { ifMatch: etag });
        if (r && r.conflict) throw new FremdgriffFehler();
        return neu;
      },

      /* Ein bestätigter Versand MUSS stehenbleiben — ginge die Auskunft
         verloren, sendete ein späterer Lauf dieselbe Mail noch einmal.
         Gerechnet wird dabei auf dem frisch gelesenen Stand. */
      async festhaltenGesendet(nachricht) {
        for (let n = 0; n < 4; n++) {
          const { value: da, etag } = await liesMitKennung(idWert);
          if (!da) return null;
          if (da.status === K.STATUS.gesendet) return da;       // jemand war schneller: gut so
          const fertig = K.markiereGesendet(da, nachricht, jetzt());
          if (!fertig.ok) return null;
          const r = await dbSet(pfad(idWert), fertig.eintrag, { ifMatch: etag });
          if (!(r && r.conflict)) return fertig.eintrag;
        }
        /* Letzter Ausweg — aber immer noch auf dem aktuellen Stand, nie auf
           einem alten: die Wahrheit „gesendet" darf nicht verlorengehen. */
        const { value: da } = await liesMitKennung(idWert);
        if (!da || da.status === K.STATUS.gesendet) return da || null;
        const fertig = K.markiereGesendet(da, nachricht, jetzt());
        if (!fertig.ok) return null;
        await dbSet(pfad(idWert), fertig.eintrag);
        return fertig.eintrag;
      },

      /* Ungeklärt: nur setzen, wenn der gespeicherte Stand nichts Besseres
         weiss. Ein „gesendet" oder „abgebrochen" wird NICHT überschrieben. */
      async festhaltenUnklar(grund) {
        for (let n = 0; n < 3; n++) {
          const { value: da, etag } = await liesMitKennung(idWert);
          if (!da) return null;
          if (da.status === K.STATUS.gesendet || da.status === K.STATUS.abgebrochen) return da;
          if (da.status === K.STATUS.unklar) return da;
          const r = await dbSet(pfad(idWert), K.markiereUnklar(da, grund, jetzt()).eintrag, { ifMatch: etag });
          if (!(r && r.conflict)) return (await liesMitKennung(idWert)).value;
        }
        return (await liesMitKennung(idWert)).value || null;
      },

      /* Ein Fehlschlag VOR dem Versand darf wiederholt werden. War der Versand
         schon angestossen — und sei es nur, dass die Stufe „senden" im Speicher
         steht —, wird daraus KEIN Rückversuch, sondern ein ungeklärter Fall. */
      async festhaltenFehler(fehler) {
        const { value: da, etag } = await liesMitKennung(idWert);
        if (!da) return null;
        if (da.status === K.STATUS.gesendet || da.status === K.STATUS.abgebrochen) return da;
        if (zaun.angestossen || da.stufe === K.STUFE.senden) {
          return zaun.festhaltenUnklar("Der Versand war angestossen und liess sich nicht abschliessen ("
            + ((fehler && fehler.message) || "Fehler") + "). Ob die Mail draussen ist, ist ungeklärt — "
            + "es wird nichts wiederholt.");
        }
        const f = K.markiereFehler(da, fehler, jetzt());
        const r = await dbSet(pfad(idWert), f.eintrag, { ifMatch: etag });
        if (r && r.conflict) return (await liesMitKennung(idWert)).value || null;
        return f.eintrag;
      },
    };
    return zaun;
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
      const festgehalten = await zaun.festhaltenGesendet(nachricht);
      if (festgehalten) return festgehalten;
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
      if (K.bestaetigtGesendet(m)) return await zaun.festhaltenGesendet(m);
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
    /* Ab hier kann die Mail draussen sein. Der Zaun weiss das und lässt von
       jetzt an keinen Rückversuch mehr zu — auch nicht, wenn ein Schreibgang
       scheitert. */
    zaun.angestossen = true;
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
    if (K.bestaetigtGesendet(nachricht)) {
      const festgehalten = await zaun.festhaltenGesendet(nachricht);
      if (festgehalten) return festgehalten;
      throw new UnklarFehler("Der Versand ist bestätigt, liess sich aber nicht festhalten.");
    }

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
