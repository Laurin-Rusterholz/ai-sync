/*
 * Die Tür des Ausgangs — und dass sie VOR der Datenbank steht.
 *
 * BEFUND (Durchsicht 13.09.2026): Der neue Endpunkt hing an `requireAuth` aus
 * gcal-shared. Das gibt ohne gesetztes SYNC_AUTH_TOKEN `null` zurück — also
 * „durchlassen". Für diesen Endpunkt ist das die falsche Richtung: Hier liegen
 * vollständige MIME-Nachrichten samt Anhängen, und wer planen darf, kann in
 * fremdem Namen Mail verschicken. Eine fehlende Konfiguration darf nichts
 * öffnen, sie muss sperren — und das auch sagen.
 *
 * Gemessen wird am echten Ablauf (netlify/lib/mail-queue-endpunkt.mjs), mit
 * einer Warteschlange, die beim ersten Zugriff SCHREIT. Damit ist nicht nur
 * die Antwort geprüft, sondern auch die Reihenfolge: ohne Schlüssel wird die
 * Datenbank nicht einmal angefasst.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { bearbeiteAnfrage, zugangPruefen, queueSchluessel } = await import(path.join(root, "netlify/lib/mail-queue-endpunkt.mjs"));

let checks = 0;
const ok = (b, t) => { assert.ok(b, t); checks++; };
const eq = (a, b, t) => { assert.equal(a, b, t); checks++; };

const TOKEN = "geheim-nur-fuer-den-test";

function anfrage(koerper, authKopf) {
  const kopf = new Map();
  if (authKopf) kopf.set("authorization", authKopf);
  return {
    method: "POST",
    headers: { get: (n) => kopf.get(String(n).toLowerCase()) || null },
    json: async () => koerper,
  };
}

/* Eine Warteschlange, die jeden Zugriff meldet — und beim ersten Datenzugriff
   auffliegt, wenn die Tür ihn hätte verhindern müssen. */
function warteschlange(spur) {
  return () => {
    spur.gebaut++;
    const meld = (name) => async () => { spur.aufrufe.push(name); return { ok: true, eintraege: [] }; };
    return { liste: meld("liste"), plane: meld("plane"), aendere: meld("aendere"),
      brichAb: meld("abbrechen"), sofort: meld("sofort"),
      klaereGesendet: meld("klaer+"), klaereNichtGesendet: meld("klaer-") };
  };
}

/* ══ 1. Ohne Schlüssel auf dem Server: gesperrt, nicht offen ══════════════ */
{
  const spur = { gebaut: 0, aufrufe: [] };
  for (const fehlt of [undefined, null, "", "   "]) {
    const antwort = await bearbeiteAnfrage(anfrage({ aktion: "liste" }, "Bearer " + TOKEN),
      { queueFactory: warteschlange(spur), token: fehlt });
    eq(antwort.status, 503, "ohne hinterlegten Schlüssel antwortet der Ausgang nicht mit „gesperrt“");
    const daten = await antwort.json();
    eq(daten.error, "GESPERRT", "die Absage nennt den Zustand nicht");
    ok(/SYNC_AUTH_TOKEN/.test(daten.grund || ""), "die Absage sagt nicht, was fehlt");
    ok(!/eintraege/.test(JSON.stringify(daten)), "die Absage liefert trotzdem Daten mit");
  }
  eq(spur.gebaut, 0, "die Warteschlange wurde gebaut, obwohl die Tür zu war");
  eq(spur.aufrufe.length, 0, "es wurde auf die Datenbank zugegriffen, obwohl die Tür zu war");
}

/* ══ 2. Falscher oder fehlender Schlüssel beim Aufrufer ═══════════════════ */
{
  const spur = { gebaut: 0, aufrufe: [] };
  const schlecht = [undefined, "", "Bearer ", "Bearer falsch", "falsch",
    "Bearer " + TOKEN + "x", "Bearer " + TOKEN.slice(0, -1)];
  for (const kopf of schlecht) {
    const antwort = await bearbeiteAnfrage(anfrage({ aktion: "liste" }, kopf),
      { queueFactory: warteschlange(spur), token: TOKEN });
    eq(antwort.status, 401, `„${kopf}" wurde durchgelassen`);
    const daten = await antwort.json();
    eq(daten.error, "KEIN_ZUGANG", "die Absage nennt den Zustand nicht");
  }
  eq(spur.gebaut, 0, "die Warteschlange wurde trotz falschem Schlüssel gebaut");
  eq(spur.aufrufe.length, 0, "es wurde trotz falschem Schlüssel auf die Datenbank zugegriffen");
}

/* ══ 3. Auch Schreibaktionen kommen nicht vorbei ══════════════════════════ */
{
  const spur = { gebaut: 0, aufrufe: [] };
  for (const aktion of ["plane", "aendere", "abbrechen", "sofort", "geklaert-gesendet", "geklaert-nicht-gesendet"]) {
    const antwort = await bearbeiteAnfrage(anfrage({ aktion, id: "out_1", raw: "cmF3", to: "x@example.com" }, null),
      { queueFactory: warteschlange(spur), token: TOKEN });
    eq(antwort.status, 401, `„${aktion}" liess sich ohne Schlüssel auslösen`);
  }
  eq(spur.aufrufe.length, 0, "eine Schreibaktion erreichte ohne Schlüssel die Warteschlange");
}

/* ══ 4. Mit richtigem Schlüssel geht es durch ═════════════════════════════ */
{
  const spur = { gebaut: 0, aufrufe: [] };
  for (const kopf of ["Bearer " + TOKEN, TOKEN]) {
    const antwort = await bearbeiteAnfrage(anfrage({ aktion: "liste" }, kopf),
      { queueFactory: warteschlange(spur), token: TOKEN });
    eq(antwort.status, 200, `mit „${kopf.slice(0, 8)}…" kam nichts durch`);
  }
  eq(spur.aufrufe.length, 2, "die Anfrage erreichte die Warteschlange nicht");
}

/* ══ 5. Die reine Prüfung für sich ════════════════════════════════════════ */
{
  ok(!zugangPruefen("Bearer x", "").ok, "ohne Serverschlüssel gilt der Zugang als erteilt");
  eq(zugangPruefen("Bearer x", "").status, 503, "ohne Serverschlüssel ist die Absage nicht „gesperrt“");
  ok(!zugangPruefen("", TOKEN).ok, "ohne Kopfzeile gilt der Zugang als erteilt");
  ok(zugangPruefen("Bearer " + TOKEN, TOKEN).ok, "der richtige Schlüssel wurde abgewiesen");
  ok(!zugangPruefen("Bearer " + TOKEN.toUpperCase(), TOKEN).ok, "der Schlüssel wird nicht genau verglichen");
}

/* ══ 6. Was nicht POST ist, kommt gar nicht erst zur Sache ════════════════ */
{
  const spur = { gebaut: 0, aufrufe: [] };
  const vorab = await bearbeiteAnfrage({ method: "OPTIONS", headers: { get: () => null } },
    { queueFactory: warteschlange(spur), token: TOKEN });
  eq(vorab.status, 204, "die Vorabfrage (CORS) wird nicht beantwortet");
  const falsch = await bearbeiteAnfrage({ method: "GET", headers: { get: () => null } },
    { queueFactory: warteschlange(spur), token: TOKEN });
  eq(falsch.status, 405, "ein GET auf den Ausgang wird nicht abgewiesen");
  eq(spur.aufrufe.length, 0, "eine Vorabfrage erreichte die Warteschlange");
}

/* ══ 7. Der Ausgang hat einen EIGENEN Schlüssel ═══════════════════════════
   Integrationsbefund (13.09.2026): SYNC_AUTH_TOKEN ist der gemeinsame
   Schlüssel der BESTEHENDEN Endpunkte. Wer ihn setzt, um den Ausgang
   aufzuschliessen, sperrt damit gleichzeitig blob-put, gcal-* und gmail-api —
   und die Mobil-App schickt bei ihren Gmail-Aufrufen keine Kopfzeile mit.
   Deshalb: eigener MAIL_QUEUE_AUTH_TOKEN, der gemeinsame nur als Rückfall. */
{
  const lies = (werte) => (name) => werte[name];

  eq(queueSchluessel(lies({ MAIL_QUEUE_AUTH_TOKEN: "eigen", SYNC_AUTH_TOKEN: "gemeinsam" })), "eigen",
    "der eigene Schlüssel des Ausgangs hat keinen Vorrang");
  eq(queueSchluessel(lies({ SYNC_AUTH_TOKEN: "gemeinsam" })), "gemeinsam",
    "ein vorhandener gemeinsamer Schlüssel wird nicht als Rückfall genommen");
  eq(queueSchluessel(lies({ MAIL_QUEUE_AUTH_TOKEN: "eigen" })), "eigen",
    "der eigene Schlüssel allein genügt nicht");
  eq(queueSchluessel(lies({})), "", "ohne jeden Schlüssel gilt der Ausgang nicht als gesperrt");
  eq(queueSchluessel(lies({ MAIL_QUEUE_AUTH_TOKEN: "   " , SYNC_AUTH_TOKEN: "gemeinsam" })), "gemeinsam",
    "ein leerer eigener Schlüssel verdeckt den Rückfall");

  // Die Absage sagt, WELCHER Schlüssel gemeint ist — und was er kostet.
  const antwort = await bearbeiteAnfrage(anfrage({ aktion: "liste" }, "Bearer x"),
    { queueFactory: warteschlange({ gebaut: 0, aufrufe: [] }), token: queueSchluessel(lies({})) });
  const daten = await antwort.json();
  ok(/MAIL_QUEUE_AUTH_TOKEN/.test(daten.grund || ""), "die Absage nennt den eigenen Schlüssel nicht");
  ok(/SYNC_AUTH_TOKEN/.test(daten.grund || ""), "die Absage nennt den Rückfall nicht");
  ok(/übrigen Endpunkte|andere/i.test(daten.grund || ""),
    "die Absage verschweigt, dass der gemeinsame Schlüssel auch die übrigen Endpunkte verlangt");
}

console.log(`mail queue zugang: ok (${checks} Prüfungen)`);
