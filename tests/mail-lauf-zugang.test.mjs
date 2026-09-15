/* ══ Die Tür des SERVERLAUFS ════════════════════════════════════════════════
 *
 * BEFUND (Durchsicht 15.09.2026, an main 721d0ab nachgelesen):
 * `netlify/functions/mail-queue-run.mjs` entschied so, wer den Versandlauf
 * auslösen darf:
 *
 *     let rumpf = null;
 *     try { rumpf = await req.json(); } catch (e) { rumpf = null; }
 *     if (rumpf && rumpf.next_run) return true;          // „vom Zeitplan"
 *     const tuer = zugangPruefen(req.headers.get("Authorization"), …);
 *     return tuer.ok;
 *
 * Der Rumpf kommt vom Aufrufer. `{"next_run":"egal"}` war damit ein Ausweis,
 * den sich jeder selbst ausstellt — und ein FALSCHER Zugangsschlüssel fiel
 * vorher auf genau diesen Weg zurück und kam trotzdem durch. Ein Rumpfwert ist
 * keine Authentifizierung, sondern eine Behauptung.
 *
 * Dieser Test hält die neue Regel fest (netlify/lib/mail-queue-endpunkt.mjs,
 * `laufZugang`) und fährt am Ende die GEGENPROBE gegen den Stand von damals:
 * dort müssen dieselben Prüfungen durchfallen, sonst prüft dieser Test nichts.
 *
 * Was NICHT geprüft werden kann und auch nicht behauptet wird: ob Netlify die
 * Scheduled Function von aussen erreichbar macht. Laut Netlify-Doku ist sie das
 * nicht („You can't invoke scheduled functions directly with a URL"). Geprüft
 * wird hier nur, was in unserem Code steht — und dort hängt seit dem 15.09.
 * keine Erlaubnis mehr an einem Wert aus dem Rumpf.
 * ═════════════════════════════════════════════════════════════════════════ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASIS = process.env.MAIL_LAUF_BASIS_COMMIT || "721d0ab";

let checks = 0;
const fehler = [];
const pruefe = (bedingung, text) => { checks++; if (!bedingung) fehler.push(text); };
const gleich = (a, b, text) => pruefe(a === b, `${text} (war: ${JSON.stringify(a)})`);

const { laufZugang, zugangPruefen } =
  await import(path.join(WURZEL, "netlify/lib/mail-queue-endpunkt.mjs"));

const TOKEN = "geheim-nur-fuer-den-test";

/* ══ 1. `next_run` ist kein Ausweis ═══════════════════════════════════════
   Der entscheidende Fall: eine Anfrage von aussen, die so tut, als käme sie
   vom Zeitplan. Der Rumpf geht `laufZugang` nichts an — die Funktion nimmt
   ihn gar nicht erst entgegen. Geprüft wird deshalb, was mit den Kopfzeilen
   passiert, die so eine Anfrage mitbringt. */
{
  // Kein Ausweis, aber ein Rumpf voller Behauptungen: ohne Schlüssel gesperrt.
  const ohneSchluessel = laufZugang(null, "");
  pruefe(!ohneSchluessel.ok, "ohne Serverschlüssel läuft der Versandlauf trotzdem");
  gleich(ohneSchluessel.status, 503, "ohne Serverschlüssel ist die Absage nicht „gesperrt“");
  gleich(ohneSchluessel.koerper.error, "GESPERRT", "die Absage nennt den Zustand nicht");
  pruefe(/MAIL_QUEUE_AUTH_TOKEN/.test(ohneSchluessel.koerper.grund || ""),
    "die Absage sagt nicht, welcher Schlüssel fehlt");
  pruefe(/nichts gesendet|bleiben stehen/i.test(ohneSchluessel.koerper.grund || ""),
    "die Absage sagt nicht, dass nichts verlorengeht");

  // FALSCHER Ausweis: fällt NICHT mehr auf den Zeitplan-Weg zurück.
  for (const kopf of ["Bearer falsch", "falsch", "Bearer " + TOKEN + "x",
                      "Bearer " + TOKEN.slice(0, -1), "Bearer " + TOKEN.toUpperCase()]) {
    const r = laufZugang(kopf, TOKEN);
    pruefe(!r.ok, `„${kopf}" löst den Lauf trotzdem aus`);
    gleich(r.status, 401, `„${kopf}" wird nicht mit 401 abgewiesen`);
    gleich(r.weg, "abgewiesen", `„${kopf}" wird nicht als abgewiesen vermerkt`);
  }
}

/* ══ 2. Mit Schlüssel geht es durch — und nur damit ═══════════════════════ */
{
  for (const kopf of ["Bearer " + TOKEN, TOKEN, "  Bearer " + TOKEN + "  "]) {
    const r = laufZugang(kopf, TOKEN);
    pruefe(r.ok, `mit „${kopf.trim().slice(0, 10)}…" kam der Lauf nicht durch`);
    gleich(r.weg, "schluessel", "der Weg wird nicht als Schlüssel vermerkt");
  }
}

/* ══ 3. Der Zeitplan selbst: ohne Kopfzeile, ohne Extrarechte ════════════
   Netlify ruft Scheduled Functions intern und kann keine Kopfzeile mitgeben.
   Dieser Weg bleibt offen — aber er bekommt NICHTS zusätzlich: der Lauf
   arbeitet ohnehin nur ab, was bereits fällig ist. Wichtig ist, dass er
   erkennbar ein anderer Weg ist als „Schlüssel vorgezeigt". */
{
  for (const kopf of [null, undefined, "", "   "]) {
    const r = laufZugang(kopf, TOKEN);
    pruefe(r.ok, "der Zeitplan selbst kommt nicht mehr durch — der Lauf stünde still");
    gleich(r.weg, "zeitplan", "der Zeitplan-Weg ist nicht als solcher erkennbar");
  }
  // Ohne Serverschlüssel gilt auch für den Zeitplan: gesperrt.
  gleich(laufZugang(null, "").weg, "gesperrt", "ohne Schlüssel läuft der Zeitplan trotzdem");
}

/* ══ 4. Der Rumpf wird nicht mehr gelesen ════════════════════════════════
   Belegt an der echten Funktion: ein Request, dessen `json()` beim Aufruf
   SCHREIT. Kommt der Aufruf durch, ohne zu schreien, hat niemand den Rumpf
   angefasst. Braucht npm-Pakete (gcal-shared → @netlify/blobs); fehlen sie im
   Prüfstand, wird dieser Teil ausdrücklich übersprungen statt stillschweigend
   als bestanden gezählt. */
{
  let laufErlaubt = null;
  try {
    ({ laufErlaubt } = await import(path.join(WURZEL, "netlify/functions/mail-queue-run.mjs")));
  } catch (e) {
    console.log("  (Live-Aufruf übersprungen — " + (e && e.message) + ")");
  }
  if (typeof laufErlaubt === "function") {
    const schreiender = (kopf) => ({
      method: "POST",
      headers: { get: (n) => (String(n).toLowerCase() === "authorization" ? kopf : null) },
      json: async () => { throw new Error("Der Rumpf wurde gelesen — das darf er nicht"); },
    });
    const vorher = process.env.MAIL_QUEUE_AUTH_TOKEN;
    process.env.MAIL_QUEUE_AUTH_TOKEN = TOKEN;
    try {
      const abgewiesen = laufErlaubt(schreiender("Bearer falsch"));
      pruefe(!abgewiesen.ok, "ein falscher Schlüssel löst den echten Lauf aus");
      const durch = laufErlaubt(schreiender("Bearer " + TOKEN));
      pruefe(durch.ok, "der richtige Schlüssel kommt am echten Lauf nicht durch");
      gleich(durch.weg, "schluessel", "der echte Lauf vermerkt den Weg nicht");
    } finally {
      if (vorher === undefined) delete process.env.MAIL_QUEUE_AUTH_TOKEN;
      else process.env.MAIL_QUEUE_AUTH_TOKEN = vorher;
    }
  }
}

/* ══ 5. Am Quelltext: die alte Hintertür ist zu ══════════════════════════ */
const RUN = readFileSync(path.join(WURZEL, "netlify/functions/mail-queue-run.mjs"), "utf8");
const RUN_CODE = RUN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
{
  pruefe(!/rumpf\s*\.\s*next_run|\.next_run\s*\)/.test(RUN_CODE),
    "der Lauf liest immer noch `next_run` aus dem Rumpf");
  pruefe(!/req\.json\(\)/.test(RUN_CODE),
    "der Lauf liest immer noch den Rumpf der Anfrage");
  pruefe(RUN_CODE.includes("laufZugang("),
    "der Lauf entscheidet nicht über laufZugang()");
  pruefe(/schedule:\s*"\*\s\*\s\*\s\*\s\*"/.test(RUN),
    "der Lauf ist keine Scheduled Function mehr (ohne config.schedule wäre er eine offene Adresse)");
  pruefe(!/messages\/send/.test(RUN),
    "die Lauf-Funktion sendet selbst, statt über die Warteschlange zu gehen");
}

/* ══ 6. Keine Abkürzung an der Tür vorbei ════════════════════════════════
   netlify.toml darf keine Weiterleitung auf den Lauf legen: sie machte aus der
   internen Scheduled Function eine öffentliche Adresse. */
{
  const TOML = readFileSync(path.join(WURZEL, "netlify.toml"), "utf8");
  pruefe(!/mail-queue-run/.test(TOML),
    "netlify.toml nennt mail-queue-run — eine Weiterleitung darauf wäre eine offene Adresse");
}

/* ══ 7. Die Tür des Ausgangs bleibt, wie sie war ═════════════════════════
   `laufZugang` darf `zugangPruefen` nicht aufweichen: der Ausgang selbst
   verlangt weiterhin IMMER eine Kopfzeile. */
{
  pruefe(!zugangPruefen("", TOKEN).ok, "der Ausgang lässt jetzt ohne Kopfzeile durch");
  gleich(zugangPruefen("", TOKEN).status, 401, "der Ausgang weist ohne Kopfzeile nicht mit 401 ab");
  pruefe(zugangPruefen("Bearer " + TOKEN, TOKEN).ok, "der richtige Schlüssel wird am Ausgang abgewiesen");
}

/* ══ Gegenprobe: dieselben Regeln gegen den Stand von vorher ═════════════ */
console.log("── Gegenprobe gegen " + BASIS + " (dort MUSS es durchfallen) ──");
{
  let alt = null;
  try {
    alt = execFileSync("git", ["show", BASIS + ":netlify/functions/mail-queue-run.mjs"],
      { cwd: WURZEL, maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
  } catch (e) {
    console.log("  (übersprungen — " + BASIS + " nicht lesbar: " + (e && e.message) + ")");
  }
  if (alt) {
    const altCode = alt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    pruefe(/next_run/.test(altCode),
      "Gegenprobe: im alten Stand steht gar kein next_run — dann prüft dieser Test die falsche Stelle");
    pruefe(/req\.json\(\)/.test(altCode),
      "Gegenprobe: im alten Stand wurde der Rumpf gar nicht gelesen");

    /* Und die alte Entscheidung wirklich ausführen: der Rumpf allein genügte. */
    const i = altCode.indexOf("async function darfLaufen(req)");
    if (i >= 0) {
      const ende = altCode.indexOf("\n}", i);
      const quelle = altCode.slice(i, ende + 2);
      const gebaut = new Function("zugangPruefen", "queueSchluessel",
        quelle + "; return darfLaufen;");
      const altDarf = gebaut(
        () => ({ ok: false, status: 401 }),          // Schlüssel stimmt NICHT
        () => TOKEN);
      const gefaelscht = {
        headers: { get: () => "Bearer voellig-falsch" },
        json: async () => ({ next_run: "2026-09-15T10:00:00Z" }),
      };
      const durchgelassen = await altDarf(gefaelscht);
      pruefe(durchgelassen === true,
        "Gegenprobe: der alte Stand liess `next_run` NICHT als Ausweis gelten — Befund stimmt nicht");
      console.log("  ✓ belegt: alter Stand lässt {\"next_run\":…} mit falschem Schlüssel durch");
    } else {
      console.log("  (darfLaufen im alten Stand nicht gefunden)");
    }
  }
}

console.log((fehler.length ? "✗ " : "✓ ") + `mail lauf zugang: ${checks} Prüfungen, ${fehler.length} fehlgeschlagen`);
if (fehler.length) { fehler.forEach((f) => console.log("   ✗ " + f)); process.exit(1); }
