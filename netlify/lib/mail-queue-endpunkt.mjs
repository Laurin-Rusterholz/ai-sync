/* ══ Der Ausgang als Endpunkt — Tür zuerst, Datenbank danach ═════════════════
 *
 * BEFUND (Durchsicht 13.09.2026): Der neue Endpunkt hing an `requireAuth` aus
 * gcal-shared. Das gibt OHNE gesetztes SYNC_AUTH_TOKEN `null` zurück, also
 * „durchlassen" — die gemeinsame Fassade der bestehenden Endpunkte. Für den
 * Ausgang ist das falsch herum: Dort liegen vollständige MIME-Nachrichten
 * samt Anhängen, und wer planen darf, kann in fremdem Namen Mail verschicken.
 * Eine fehlende Konfiguration darf das nicht öffnen.
 *
 * Deshalb ist dieser Endpunkt FAIL-CLOSED: Ohne Zugangsschlüssel antwortet er
 * GESPERRT (503) und rührt die Datenbank nicht an. Die bestehenden
 * Gmail-Endpunkte bleiben unverändert — sie werden hier nicht still umgebaut.
 *
 * EIGENER SCHLÜSSEL, MIT ABSICHT (Integrationsprüfung 13.09.2026):
 * `SYNC_AUTH_TOKEN` ist der gemeinsame Schlüssel der BESTEHENDEN Endpunkte
 * (blob-put, gcal-*, gmail-api …). Wer ihn setzt, sperrt damit auch sie — und
 * die Mobil-App schickt bei ihren Gmail-Aufrufen bis heute keine Kopfzeile
 * mit. Diesen Ausgang aufzuschliessen dürfte also nicht bedeuten, alles andere
 * zuzusperren. Darum hat die Warteschlange einen EIGENEN Schlüssel:
 *     MAIL_QUEUE_AUTH_TOKEN   (bevorzugt — betrifft nur Ausgang und Lauf)
 *     SYNC_AUTH_TOKEN         (Rückfall, falls schon vorhanden)
 * Ist keiner von beiden gesetzt, bleibt der Ausgang gesperrt.
 *
 * Die Reihenfolge ist Absicht und wird geprüft: Erst die Tür, dann die
 * Warteschlange. `queueFactory` wird erst NACH bestandener Prüfung gerufen,
 * damit ein Test beweisen kann, dass ohne Schlüssel nichts gelesen wird.
 * ═════════════════════════════════════════════════════════════════════════ */

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(daten, status = 200) {
  return new Response(JSON.stringify(daten), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* Der Schlüssel dieses Endpunkts: erst der eigene, dann der gemeinsame. */
export function queueSchluessel(lies = umgebungswert) {
  const eigen = String(lies("MAIL_QUEUE_AUTH_TOKEN") || "").trim();
  if (eigen) return eigen;
  return String(lies("SYNC_AUTH_TOKEN") || "").trim();
}

export function umgebungswert(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name);
  } catch (e) { /* ignore */ }
  return (typeof process !== "undefined" && process.env) ? process.env[name] : undefined;
}

/* Rein, ohne Netz und ohne Request-Objekt — damit die Prüfung selbst prüfbar
   ist. Zurück kommt entweder { ok: true } oder eine fertige Absage. */
export function zugangPruefen(authKopf, erwartet) {
  const schluessel = String(erwartet || "").trim();
  if (!schluessel) {
    return { ok: false, status: 503, koerper: { ok: false, error: "GESPERRT",
      grund: "Der Ausgang ist gesperrt: Auf dem Server ist kein Zugangsschlüssel hinterlegt. "
        + "Nötig ist MAIL_QUEUE_AUTH_TOKEN (empfohlen — betrifft nur den Ausgang); ersatzweise gilt ein "
        + "vorhandener SYNC_AUTH_TOKEN, der allerdings auch die übrigen Endpunkte verlangt. "
        + "Ohne Schlüssel wird weder etwas ausgeliefert noch etwas eingeplant." } };
  }
  const gegeben = String(authKopf || "").trim();
  if (!gegeben) {
    return { ok: false, status: 401, koerper: { ok: false, error: "KEIN_ZUGANG",
      grund: "Ohne Zugangsschlüssel geht hier nichts — auch nicht lesen." } };
  }
  const ohnePraefix = gegeben.replace(/^Bearer\s+/i, "");
  if (!gleichLang(ohnePraefix, schluessel) && !gleichLang(gegeben, schluessel)) {
    return { ok: false, status: 401, koerper: { ok: false, error: "KEIN_ZUGANG",
      grund: "Der Zugangsschlüssel stimmt nicht." } };
  }
  return { ok: true };
}

/* Vergleich in gleichbleibender Zeit: Ein Vergleich, der beim ersten
   abweichenden Zeichen abbricht, verrät über die Dauer, wie viel schon
   stimmte. */
function gleichLang(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* Der ganze Ablauf des Endpunkts, ohne Netlify und ohne Firebase: Was von
   aussen kommt, ist ein Request; was gebraucht wird, kommt als Abhängigkeit
   herein. */
export async function bearbeiteAnfrage(req, { queueFactory, token } = {}) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Methode nicht erlaubt" }, 405);

  // ── Die Tür. Vor allem anderen, insbesondere vor jedem Datenbankzugriff. ──
  const tuer = zugangPruefen(req.headers.get("Authorization"), token);
  if (!tuer.ok) return json(tuer.koerper, tuer.status);

  let p;
  try { p = await req.json(); } catch (e) { return json({ ok: false, error: "Unlesbarer Inhalt" }, 400); }

  const q = queueFactory();
  const aktion = String(p.aktion || "");
  try {
    if (aktion === "liste") return json({ ok: true, eintraege: await q.liste() });
    if (aktion === "plane") {
      const r = await q.plane({
        raw: p.raw, threadId: p.threadId, to: p.to, cc: p.cc, bcc: p.bcc,
        subject: p.subject, vorschau: p.vorschau, quelle: p.quelle,
        koerper: p.koerper, hatAnhaenge: p.hatAnhaenge,
        inReplyTo: p.inReplyTo, references: p.references, zitat: p.zitat,
        anfrageSchluessel: p.anfrageSchluessel,
        zeitpunkt: p.zeitpunkt, verzoegerungMs: p.verzoegerungMs,
      });
      return json(r, r.ok ? (r.bestand ? 200 : 201) : 400);
    }
    if (!p.id) return json({ ok: false, error: "Ohne Id geht das nicht." }, 400);
    if (aktion === "aendere") {
      const r = await q.aendere(String(p.id), {
        raw: p.raw, koerperTeil: p.koerperTeil, neueAnhaenge: p.neueAnhaenge,
        to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject,
        vorschau: p.vorschau, koerper: p.koerper,
        zeitpunkt: p.zeitpunkt, verzoegerungMs: p.verzoegerungMs,
      });
      return json(r, r.ok ? 200 : 409);
    }
    if (aktion === "abbrechen") { const r = await q.brichAb(String(p.id)); return json(r, r.ok ? 200 : 409); }
    if (aktion === "sofort") { const r = await q.sofort(String(p.id)); return json(r, r.ok ? 200 : 409); }
    if (aktion === "geklaert-gesendet") { const r = await q.klaereGesendet(String(p.id)); return json(r, r.ok ? 200 : 409); }
    if (aktion === "geklaert-nicht-gesendet") { const r = await q.klaereNichtGesendet(String(p.id)); return json(r, r.ok ? 200 : 409); }
    return json({ ok: false, error: "Unbekannte Aktion: " + aktion }, 400);
  } catch (err) {
    console.error("[mail-queue]", aktion, err && err.message);
    return json({ ok: false, error: "Die Warteschlange antwortet gerade nicht." }, 502);
  }
}

export default { bearbeiteAnfrage, zugangPruefen, umgebungswert, json, CORS };
