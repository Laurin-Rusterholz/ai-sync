/* ══ Geplanter Mailversand — der Serverteil ══════════════════════════════════
 *
 * Die Planung liegt serverseitig (RTDB `mail/outbox/<id>`) und wird von einem
 * Serverlauf abgearbeitet. Kein Browser-Timer: ein geschlossener Rechner, ein
 * Neuladen oder ein Geraet in einer anderen Zeitzone aendert nichts daran, dass
 * die Mail zu ihrer Zeit rausgeht.
 *
 * Gmail kann Versand NICHT planen (Discovery v1, Revision 20260907: weder
 * users.messages.send noch users.drafts.send kennen ein Feld dafuer, und es
 * gibt kein Label SCHEDULED). Gmail ist deshalb ausschliesslich Versandkanal
 * und die Quelle fuer den BESTAETIGTEN Versand. Gmails eigene Ansicht
 * „Geplant" wird nicht vorgetaeuscht.
 *
 * ZWEI STUFEN GEGEN DOPPELVERSAND
 *   1. users.drafts.create  → draftId + message.id merken
 *   2. users.drafts.send    → Nachricht mit Label SENT
 * Ein zweiter Lauf, der einen Eintrag mit draftId und ohne bestaetigte
 * Nachricht findet, fragt erst Gmail:
 *   · Entwurf existiert noch  → nichts ist raus, also senden;
 *   · Entwurf ist weg         → er wurde gesendet. Dann wird der Stand ueber
 *     die gemerkte message.id NACHGEZOGEN und NICHT noch einmal gesendet.
 *     Laesst sich das nicht bestaetigen, bleibt der Eintrag stehen und sagt
 *     das — lieber eine offene Frage als eine zweite Mail.
 *
 * Alles Aeussere kommt als Abhaengigkeit herein (db, gmail, jetzt, neueId),
 * damit der Test den ganzen Lauf ohne Netz und ohne echte Uhr fahren kann.
 * ═════════════════════════════════════════════════════════════════════════ */
import K from "../../public/mail-queue-core.js";

const WURZEL = "mail/outbox";
const MAX_PRO_LAUF = 10;

export function createQueue({
  dbGet, dbGetEtag, dbSet, dbRemove, gmail, jetzt = () => Date.now(), neueId,
  wurzel = WURZEL, maxProLauf = MAX_PRO_LAUF,
} = {}) {
  const pfad = (id) => `${wurzel}/${id}`;
  const id = neueId || (() => "out_" + Math.random().toString(36).slice(2, 12));

  async function alle() {
    const roh = (await dbGet(wurzel)) || {};
    return Object.keys(roh).map((k) => roh[k]).filter((e) => e && e.id);
  }
  const schreibe = (e) => dbSet(pfad(e.id), e);
  /* Lesen MIT Kennung (ETag). Nur damit laesst sich der Zugriff eines Laufes
     atomar setzen: Wer die Kennung nicht mehr trifft, war zu spaet. */
  const liesMitKennung = async (id) => {
    if (typeof dbGetEtag === "function") return dbGetEtag(pfad(id));
    return { value: await dbGet(pfad(id)), etag: null };
  };

  /* ── Was die Oberflaeche aufruft ─────────────────────────────────────── */
  async function plane(eingabe = {}) {
    const neu = K.neuerEintrag(Object.assign({}, eingabe, { id: eingabe.id || id(), jetzt: jetzt() }));
    if (!neu.ok) return { ok: false, grund: neu.grund };
    await schreibe(neu.eintrag);
    return { ok: true, eintrag: neu.eintrag };
  }

  async function liste() {
    const e = await alle();
    return e.sort((a, b) => (a.sendAt || 0) - (b.sendAt || 0));
  }

  async function aendere(idWert, patch = {}) {
    const e = await dbGet(pfad(idWert));
    if (!e) return { ok: false, grund: "Diese Mail gibt es nicht mehr." };
    const r = K.aendere(e, patch, jetzt());
    if (!r.ok) return r;
    await schreibe(r.eintrag);
    return r;
  }

  async function brichAb(idWert) {
    const e = await dbGet(pfad(idWert));
    if (!e) return { ok: false, grund: "Diese Mail gibt es nicht mehr." };
    const r = K.brichAb(e, jetzt());
    if (!r.ok) return r;
    /* Der Entwurf bei Gmail gehoert zu dieser Planung — mit dem Abbruch geht
       auch er weg. Schlaegt das fehl, bleibt der Abbruch trotzdem stehen: die
       Mail geht nicht raus, und ein verwaister Entwurf ist das kleinere Uebel. */
    if (e.draftId) {
      try { await gmail("DELETE", "/users/me/drafts/" + encodeURIComponent(e.draftId)); }
      catch (err) { r.eintrag.letzterFehler = "Entwurf blieb bei Gmail: " + (err && err.message); }
    }
    await schreibe(r.eintrag);
    return r;
  }

  async function sofort(idWert) {
    return aendere(idWert, { zeitpunkt: jetzt() });
  }

  /* ── Der Lauf ────────────────────────────────────────────────────────── */
  async function lauf(laufId = "lauf_" + Date.now().toString(36)) {
    const bericht = { gesendet: [], verschoben: [], aufgegeben: [], nachgezogen: [], uebersprungen: 0 };
    const faellig = K.faellige(await alle(), jetzt()).slice(0, maxProLauf);
    for (const roh of faellig) {
      /* Der Zugriff ist die heikle Stelle: Zwei Laeufe zur selben Sekunde
         duerfen NICHT dieselbe Mail nehmen. Deshalb wird frisch MIT Kennung
         gelesen und mit genau dieser Kennung geschrieben (if-match). Wer die
         Kennung nicht mehr trifft, hat verloren und laesst die Finger davon —
         ohne diesen Schritt ging die Mail im Test zweimal raus. */
      const { value: e0, etag } = await liesMitKennung(roh.id);
      if (!e0 || !K.istFaellig(e0, jetzt())) { bericht.uebersprungen++; continue; }
      const uebernommen = K.uebernimm(e0, jetzt(), laufId);
      if (!uebernommen.ok) { bericht.uebersprungen++; continue; }
      let e = uebernommen.eintrag;
      const gesetzt = await dbSet(pfad(e.id), e, { ifMatch: etag });
      if (gesetzt && gesetzt.conflict) { bericht.uebersprungen++; continue; }
      try {
        e = await versende(e);
        if (e.status === K.STATUS.gesendet) bericht.gesendet.push(e.id);
      } catch (err) {
        const f = K.markiereFehler(e, err, jetzt());
        e = f.eintrag;
        (e.status === K.STATUS.fehlgeschlagen ? bericht.aufgegeben : bericht.verschoben).push(e.id);
      }
      await schreibe(e);
    }
    return bericht;
  }

  async function versende(eintrag) {
    let e = eintrag;

    /* Bereits eine bestaetigte Nachricht? Dann nur den Stand nachziehen. */
    if (e.gmailMessageId) {
      const m = await gmail("GET", "/users/me/messages/" + encodeURIComponent(e.gmailMessageId),
        { query: { format: "minimal" } });
      const fertig = K.markiereGesendet(e, m, jetzt());
      if (fertig.ok) return fertig.eintrag;
      throw new Error("Gmail bestaetigt die Nachricht nicht als gesendet");
    }

    /* Stufe 1 — Entwurf. Er ist die Duplikatsperre. */
    if (!e.draftId) {
      const nachricht = { raw: e.raw };
      if (e.threadId) nachricht.threadId = e.threadId;
      const entwurf = await gmail("POST", "/users/me/drafts", { body: { message: nachricht } });
      if (!entwurf || !entwurf.id) throw new Error("Gmail hat keinen Entwurf angelegt");
      e = K.merkeEntwurf(e, entwurf.id, jetzt());
      e.draftMessageId = (entwurf.message && entwurf.message.id) || null;
      e.gmailThreadId = (entwurf.message && entwurf.message.threadId) || e.threadId || null;
    } else {
      /* Es gibt schon einen Entwurf: Existiert er noch? */
      const vorhanden = await entwurfLesen(e.draftId);
      if (!vorhanden) {
        // Der Entwurf ist weg — also gesendet. NICHT noch einmal senden.
        const nachgezogen = await nachziehen(e);
        if (nachgezogen) return nachgezogen;
        throw new Error("Der Entwurf ist bei Gmail verschwunden und der Versand liess sich nicht "
          + "bestaetigen. Es wird nichts erneut gesendet — bitte in Gmail nachsehen.");
      }
      if (e.entwurfVeraltet) {
        const nachricht = { raw: e.raw };
        if (e.threadId) nachricht.threadId = e.threadId;
        await gmail("PUT", "/users/me/drafts/" + encodeURIComponent(e.draftId),
          { body: { id: e.draftId, message: nachricht } });
        e = Object.assign({}, e, { entwurfVeraltet: false });
      }
    }

    /* Stufe 2 — senden. Gesendet ist erst, was SENT traegt. */
    const gesendet = await gmail("POST", "/users/me/drafts/send", { body: { id: e.draftId } });
    let nachricht = gesendet;
    if (!K.bestaetigtGesendet(nachricht) && gesendet && gesendet.id) {
      // Manche Antworten tragen die Labels nicht mit — dann wird nachgefragt.
      nachricht = await gmail("GET", "/users/me/messages/" + encodeURIComponent(gesendet.id),
        { query: { format: "minimal" } });
    }
    const fertig = K.markiereGesendet(e, nachricht, jetzt());
    if (!fertig.ok) throw new Error(fertig.grund);
    return fertig.eintrag;
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

  async function nachziehen(e) {
    if (!e.draftMessageId) return null;
    try {
      const m = await gmail("GET", "/users/me/messages/" + encodeURIComponent(e.draftMessageId),
        { query: { format: "minimal" } });
      const fertig = K.markiereGesendet(e, m, jetzt());
      return fertig.ok ? fertig.eintrag : null;
    } catch (err) { return null; }
  }

  return { plane, liste, aendere, brichAb, sofort, lauf, _versende: versende };
}

export default { createQueue, WURZEL };
