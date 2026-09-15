/* ══ Alle Sendewege gehen über den Ausgang ═══════════════════════════════════
 *
 * PRODUKTIONSBEFUND (13.09.2026, im damaligen main selbst nachgesehen):
 * Quantus hatte DREI Stellen, die eine Mail unmittelbar hinausschickten —
 *   1. window.gmailSend (Verfassen-Knopf)            → POST messages/send
 *   2. gmailProcessScheduledDrafts (Browser-Takt)    → POST messages/send,
 *      mit attachments:[] und status:"sent" ohne Rückfrage bei Gmail
 *   3. gmailAIExec("SEND") (KI-/Entity-Composer)     → POST messages/send
 * KORREKTUR DES AUFTRAGS (15.09.2026): Der Standard ist wieder der
 * DIREKTVERSAND. Verzögert wird nur noch, wer es ausdrücklich anklickt
 * („🕒 Später", Vorschlag drei Stunden). Was vom 13.09. bleibt, ist die
 * Bedingung dahinter: es darf genau EINEN Weg geben, der unmittelbar sendet
 * (window.gmailSendNow), und der Browser-Takt von früher darf nicht
 * zurückkommen — zwei parallele Sender schicken dieselbe Mail zweimal.
 *
 * Und eine zweite Bedingung, die der Live-Stand vom 15.09. nötig gemacht hat
 * (Ausgang gesperrt, MAIL_QUEUE_AUTH_TOKEN fehlt): Eine ausdrückliche Planung
 * darf bei gesperrtem Ausgang NICHT stillschweigend zum Sofortversand werden.
 * Eine fehlende Konfiguration wird gesagt, nicht umgangen.
 *
 * Dieser Test liest den ausgelieferten Quelltext. Er ist bewusst grob: er
 * fragt nicht, ob eine Funktion hübsch ist, sondern ob es überhaupt noch einen
 * zweiten Weg gibt, der unmittelbar sendet.
 *
 * GEGENPROBE: Dieselben Prüfungen laufen am Ende gegen den Stand VOR der
 * Änderung (Basis-Commit). Dort müssen sie fehlschlagen — sonst prüfte dieser
 * Test nichts.
 * ═════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASIS = process.env.MAIL_BASIS_COMMIT || "b4ac28f";

let ok = 0; const fehler = [];
function pruefe(name, bedingung) {
  if (bedingung) { ok++; return true; }
  fehler.push(name); return false;
}

/* ── Die Prüfungen als Funktionen über den Quelltext ──────────────────────
   Jede gibt true zurück, wenn der Quelltext in Ordnung ist. */
const PRUEFUNGEN = {
  "genau ein Sofort-Sendepfad im Quelltext": (s) =>
    (s.match(/gmApi\("POST","\/users\/me\/messages\/send"/g) || []).length === 1,

  "der eine Sofortpfad heisst gmailSendNow und ist ausdrücklich": (s) => {
    const i = s.indexOf("window.gmailSendNow");
    const j = s.indexOf('/users/me/messages/send');
    return i > 0 && j > i && (j - i) < 4000;
  },

  /* 15.09.2026: „Senden" sendet wieder direkt — aber NUR bei einer neuen Mail.
     Wird ein bereits geplanter Eintrag bearbeitet, heisst der Knopf „Änderung
     speichern" und darf nichts hinausschicken. */
  "„Senden“ sendet direkt — und speichert beim Bearbeiten nur": (s) => {
    const i = s.indexOf("window.gmailSend = function()");
    if (i < 0) return false;
    const block = s.slice(i, i + 700);
    return /ctx\.ausgangId\)\s*return\s+window\.gmailPlanSend\(\{\}\)/.test(block)
      && /return\s+window\.gmailSendNow\(\)/.test(block)
      && block.indexOf("ausgangId") < block.indexOf("gmailSendNow");
  },

  "der Knopf heisst wieder „Senden“, nicht „Senden (in 3 h)“": (s) =>
    s.includes("prefill.ausgangId?'Änderung speichern':'Senden'") && !s.includes("'Senden (in 3 h)'"),

  /* Zwei Knöpfe, die dasselbe tun, sind eine Falle: der frühere zweite
     „📨 Jetzt senden" neben einem „Senden", das ebenfalls sofort sendet. */
  "es gibt keinen zweiten Sofort-Knopf mehr": (s) => !s.includes("gmlSendNowBtn"),

  "drei Stunden sind der Vorschlag der ausdrücklichen Planung": (s) =>
    s.includes('label:"In 3 Stunden (Vorschlag)"'),

  "geplant wird über die Server-Warteschlange, nicht im Browser": (s) =>
    s.includes('fetch("/.netlify/functions/mail-queue"') &&
    /gmQueue\("plane"/.test(s),

  "der KI-/Entity-Composer plant ebenfalls": (s) => {
    const i = s.indexOf('if (cmd==="SEND"){');
    if (i < 0) return false;
    const block = s.slice(i, i + 1600);
    return block.includes('gmQueue("plane"') && !block.includes("/users/me/messages/send");
  },

  "der alte Browser-Takt ist entfernt": (s) =>
    !s.includes("gmailProcessScheduledDrafts") &&
    !/setInterval\([^)]*Scheduled[^)]*\)/.test(s),

  "kein zweiter Planungsschreiber mehr nach /gmailDrafts": (s) =>
    !s.includes("gmailScheduleSendAlt"),

  "alte Planungen werden nur auf Klick übernommen, nie von selbst": (s) =>
    s.includes("window.gmailAltplanungUebernehmen") &&
    s.includes("gmailAltplanungUebernehmen(\\'"),

  "Anhänge reisen in der geplanten Nachricht mit": (s) => {
    const i = s.indexOf("window.gmailPlanSend = async function");
    if (i < 0) return false;
    const block = s.slice(i, i + 2600);
    return block.includes("attachments:(GM._attachments||[])") && block.includes("hatAnhaenge");
  },

  "der Eingangs-Thread bleibt unberührt: geplant wird nur, nicht modifiziert": (s) => {
    const i = s.indexOf("window.gmailPlanSend = async function");
    const block = s.slice(i, i + 2600);
    return i > 0 && !block.includes("/modify") && !block.includes("addLabelIds");
  },

  "„Später senden“ geht denselben Weg": (s) =>
    /window\.gmailScheduleSend\s*=\s*async function\(sendAt\)\{[\s\S]{0,900}?gmailPlanSend\(\{ zeitpunkt: sendAt \}\)/.test(s),

  "es gibt eine ausgehende Ausgangsansicht (keine Selbstmail im Posteingang)": (s) =>
    s.includes("function renderAusgangPane()") &&
    s.includes('GM.smart==="ausgang"') &&
    s.includes("📤 An: "),

  "der Ausgang kann ändern, verschieben, sofort senden und abbrechen": (s) =>
    ["gmailAusgangBearbeiten", "gmailAusgangVerschieben", "gmailAusgangJetzt", "gmailAusgangAbbrechen"]
      .every((f) => s.includes("window." + f)),

  "die Anzeige nennt die Zeitzone Europe/Zurich": (s) =>
    s.includes('timeZone:"Europe/Zurich"') && s.includes("(Europe/Zurich)"),

  "Gmails Ansicht „Geplant“ wird nicht vorgetäuscht": (s) =>
    !s.includes('"SCHEDULED"') && !s.includes("'SCHEDULED'"),

  /* Durchsicht 13.09.2026: Bearbeiten darf einen Anhang nicht kosten. Statt
     den Knopf zu sperren, wird nur der KÖRPER ersetzt — den baut die Seite und
     der Server setzt ihn an die Stelle des alten. */
  "Bearbeiten schickt den Körper, nicht eine neue Nachricht": (s) => {
    const i = s.indexOf("window.gmailPlanSend = async function");
    const block = s.slice(i, i + 3600);
    return i > 0 && block.includes("anfrage.koerperTeil = gmlBodyEntity(") && block.includes("delete anfrage.raw");
  },

  "eine geplante Mail mit Anhang lässt sich bearbeiten": (s) => {
    const i = s.indexOf("window.gmailAusgangBearbeiten");
    const block = s.slice(i, i + 1400);
    return i > 0 && !/hatAnhaenge\)\{ toast/.test(block) && block.includes("replyQuote:(e.zitat||null)");
  },

  "ein ungeklärter Versand wird gezeigt und nur vom Menschen geklärt": (s) =>
    s.includes('e.status==="unklar"') && s.includes("window.gmailAusgangGeklaert")
    && s.includes("geklaert-gesendet") && s.includes("geklaert-nicht-gesendet")
    && s.includes("Quantus wiederholt hier nichts von selbst"),

  /* Wiederholbar planen: ohne stabilen Schlüssel legt ein zweiter Klick nach
     verlorener Antwort einen zweiten Eintrag an — und damit eine zweite Mail. */
  "die Seite schickt einen stabilen Anfrageschlüssel mit": (s) =>
    s.includes("function gmlAnfrageSchluessel()") && s.includes("anfrageSchluessel:(ctx.anfrageSchluessel||null)"),
  /* Der Schlüssel gehört zum Verfassen-Vorgang, nicht zum Modul: ein
     liegengebliebener würde nach einem Fehlschlag auf die nächste, andere Mail
     durchschlagen — der Server bestätigte dann den alten Eintrag. */
  "der Schlüssel wird beim Öffnen des Verfassen-Fensters vergeben": (s) =>
    s.includes("anfrageSchluessel: (typeof gmlAnfrageSchluessel===\"function\" ? gmlAnfrageSchluessel() : null)"),
  "der KI-Sendeweg hält keinen Schlüssel über Aufrufe hinweg": (s) =>
    !s.includes("GM._kiSendeSchluessel") && s.includes("var kiSchluessel = gmlAnfrageSchluessel();"),
  /* Der Ausgang hat einen eigenen Schlüssel — der gemeinsame würde auch alle
     übrigen Endpunkte verlangen. */
  "der Ausgang nutzt einen eigenen Schlüssel mit Rückfall": (s) =>
    s.includes("function gmQueueKopf()") && s.includes("sp.mailQueueToken || sp.authToken")
    && s.includes("gmQueueKopf()"),
  "die bestehenden Endpunkte behalten ihren Kopf": (s) =>
    s.includes("function authHeaders()") && !/gmApi[\s\S]{0,200}gmQueueKopf/.test(s),

  /* Der Ausgang ist fail-closed. Wenn er gesperrt ist, darf Mail nicht
     unbrauchbar werden: der ausdrückliche Sofortversand ist erreichbar und
     wird genannt. */
  /* Der Schutz aus dem Bearbeiten-Fenster bleibt: gmailSendNow baut die
     Nachricht aus dem Fenster NEU — ohne die Anhänge, die nur in der
     gespeicherten Nachricht liegen — und der geplante Eintrag ginge daneben
     später ein zweites Mal raus. */
  "beim Bearbeiten weigert sich der Sofortversand": (s) => {
    const i = s.indexOf("window.gmailSendNow = async function(){");
    const kopf = s.slice(i, i + 900);
    return i > 0 && kopf.includes("GM._composeCtx.ausgangId")
      && kopf.indexOf("GM._composeCtx.ausgangId") < kopf.indexOf("GM._composeBusy");
  },
  "ein gesperrter Ausgang wird erklärt statt verschleiert": (s) =>
    s.includes("Ausgang gesperrt") && s.includes("SYNC_AUTH_TOKEN"),

  /* DER PUNKT AUS DEM LIVE-BEFUND 15.09.: Eine ausdrückliche Planung, die am
     gesperrten Ausgang scheitert, darf NICHT still zum Sofortversand werden.
     Geprüft am Fehlerzweig von gmailPlanSend: dort wird gemeldet — und nichts
     gesendet. */
  "eine gescheiterte Planung sendet nicht ersatzweise": (s) => {
    const i = s.indexOf("window.gmailPlanSend = async function");
    if (i < 0) return false;
    const j = s.indexOf("window.gmailSend = function()", i);
    const block = s.slice(i, j > i ? j : i + 6000);
    const fehlerzweig = block.slice(block.indexOf("} catch(e){"));
    /* Kommentare erklären den neuen Standard und nennen dabei gmailSendNow —
       geprüft wird der CODE. */
    const nurCode = fehlerzweig.replace(/\/\*[\s\S]*?\*\//g, "");
    return fehlerzweig.includes("Nicht geplant")
      && fehlerzweig.includes("nichts eingeplant und nichts gesendet")
      && !/gmailSendNow|messages\/send|gmApi\(/.test(nurCode);
  },

  /* Neue Anhänge beim Bearbeiten: sie reisen mit, statt still zu verschwinden. */
  "im Bearbeiten angehängte Dateien gehen mit": (s) => {
    const i = s.indexOf("window.gmailPlanSend = async function");
    const block = s.slice(i, i + 4200);
    return i > 0 && block.includes("anfrage.neueAnhaenge = neueAnh") && block.includes("GM._attachments||[]");
  },

  "der Sofortversand verlangt eine SENT-Bestätigung": (s) => {
    const i = s.indexOf("window.gmailSendNow");
    const block = s.slice(i, i + 4000);
    return i > 0 && block.includes('indexOf("SENT")') && block.includes("hat den Versand nicht bestätigt");
  },
};

const JETZT = readFileSync(path.join(WURZEL, "public/index.html"), "utf8");

console.log("── Der ausgelieferte Stand ──");
for (const [name, fn] of Object.entries(PRUEFUNGEN)) {
  let r = false;
  try { r = !!fn(JETZT); } catch (e) { r = false; }
  if (!pruefe(name, r)) console.log("  ✗ " + name);
}

/* ── Der Rest ist Buchhaltung am Kern und an der Serverfunktion ─────────── */
const KERN = readFileSync(path.join(WURZEL, "public/mail-queue-core.js"), "utf8");
pruefe("Standard sind drei Stunden", /STANDARD_VERZOEGERUNG_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(KERN));
pruefe("der Klartext liegt für das Bearbeiten bei", KERN.includes("koerper: text(koerper"));
pruefe("ein Anhang ist als solcher vermerkt", KERN.includes("hatAnhaenge: !!hatAnhaenge"));
pruefe("die Antwort-Kopfzeilen überleben das Bearbeiten",
  KERN.includes("inReplyTo: text(inReplyTo") && KERN.includes("references: text(references"));

const LAUF = readFileSync(path.join(WURZEL, "netlify/lib/mail-queue.mjs"), "utf8");
pruefe("jede unumkehrbare Handlung wird VORHER vermerkt",
  LAUF.includes("K.setzeStufe(e, K.STUFE.entwurf") && LAUF.includes("K.setzeStufe(e, K.STUFE.senden"));
pruefe("ändern und abbrechen schreiben nur mit Kennung (CAS)",
  LAUF.includes("async function mitVergleich") && LAUF.includes("{ ifMatch: etag }"));
pruefe("der Lauf schreibt nur, solange der Zugriff ihm gehört (Fencing)",
  LAUF.includes("function zaunFuer") && LAUF.includes("da.claim.lauf !== laufId"));
pruefe("wiedergefunden wird über die eigene Message-ID, nicht über die Entwurfs-Id",
  LAUF.includes("rfc822msgid:") && !LAUF.includes("e.draftMessageId"));
pruefe("bei ungeklärtem Ausgang wird nichts wiederholt",
  LAUF.includes("UnklarFehler") && LAUF.includes("markiereUnklar"));
/* Kommentare erklären den alten Fehler — geprüft wird der CODE. */
const LAUF_CODE = LAUF.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
pruefe("nach angestossenem Versand wird kein alter Stand zurückgeschrieben",
  LAUF.includes("festhaltenUnklar") && LAUF.includes("festhaltenFehler")
  && !LAUF_CODE.includes("K.markiereFehler(e,") && !LAUF_CODE.includes("schreibeUnbedingt"));
pruefe("Empfänger wandern in die gespeicherte Nachricht",
  LAUF.includes("M.ersetzeEmpfaenger(mime,"));
pruefe("nachgereichte Anhänge werden angehängt, nicht verworfen",
  LAUF.includes("M.fuegeAnhaengeAn(mime,"));
pruefe("Planen ist über einen Anfrageschlüssel wiederholbar",
  LAUF.includes("schluesselVon") && LAUF.includes("bestand: true"));

const MIME = readFileSync(path.join(WURZEL, "netlify/lib/mail-mime.mjs"), "utf8");
pruefe("Kopfzeilenwerte werden von Zeilenschaltungen befreit (keine Einschleusung)",
  MIME.includes("export function kopfwertSicher") && /\[\\r\\n/.test(MIME));

const TUER = readFileSync(path.join(WURZEL, "netlify/lib/mail-queue-endpunkt.mjs"), "utf8");
pruefe("der Ausgang ist fail-closed und sagt, was fehlt",
  TUER.includes('error: "GESPERRT"') && TUER.includes("MAIL_QUEUE_AUTH_TOKEN") && TUER.includes("SYNC_AUTH_TOKEN"));
pruefe("der Ausgang hat einen eigenen Schlüssel mit Rückfall",
  TUER.includes("export function queueSchluessel"));
pruefe("die Tür steht vor der Datenbank",
  TUER.indexOf("zugangPruefen(") < TUER.indexOf("queueFactory()"));

const FUNK = readFileSync(path.join(WURZEL, "netlify/functions/mail-queue.mjs"), "utf8");
pruefe("die Bedien-Funktion sendet selbst nichts",
  !FUNK.includes("messages/send") && !FUNK.includes("drafts/send"));
pruefe("gesendet wird nur im geplanten Serverlauf",
  readFileSync(path.join(WURZEL, "netlify/functions/mail-queue-run.mjs"), "utf8").includes('schedule: "* * * * *"'));

/* ── Die Ausgangszeile echt ausführen ────────────────────────────────────
   Quelltext lesen sagt nicht, was herauskommt. Die beiden Anzeige-Funktionen
   werden deshalb aus der Datei geschnitten und wirklich ausgeführt — mit
   einem erfundenen Eintrag, ohne Browser, ohne Netz. */
function schneide(src, kopf) {
  const i = src.indexOf(kopf);
  if (i < 0) throw new Error("nicht gefunden: " + kopf);
  let tiefe = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") tiefe++;
    else if (src[k] === "}") { tiefe--; if (!tiefe) return src.slice(i, k + 1); }
  }
  throw new Error("Klammern gehen nicht auf: " + kopf);
}

{
  const quelle = [
    schneide(JETZT, "  function gmlZuercherZeit(ms){"),
    schneide(JETZT, "  function gmlLokalEingabe(ms){"),
    schneide(JETZT, "  function gmlAusgangZeile(e){"),
    schneide(JETZT, "  function renderAusgangPane(){"),
  ].join("\n");

  const hilfen = `
    function esc(v){ return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
    function jsStr(v){ return String(v==null?"":v).replace(/\\\\/g,"\\\\\\\\").replace(/'/g,"\\\\'"); }
  `;
  const bauen = new Function("GM", hilfen + quelle + "; return { zeile: gmlAusgangZeile, seite: renderAusgangPane };");

  const eintrag = {
    id: "out_beispiel", status: "geplant", to: "empfaenger@example.com",
    subject: "Beispielbetreff", vorschau: "Kurzer Beispieltext",
    sendAt: Date.UTC(2026, 8, 13, 10, 0, 0), hatAnhaenge: true,
  };
  const GM = { ausgang: [eintrag], drafts: [] };
  const { zeile, seite } = bauen(GM);
  const html = zeile(eintrag);

  pruefe("die Zeile ist ausgehend, keine Mail an sich selbst", /📤 An: /.test(html) && !/Posteingang/.test(html));
  pruefe("die Zeile nennt den Status Geplant", /🕒 Geplant/.test(html));
  pruefe("die Zeile zeigt Zürcher Zeit (12:00 bei 10:00 UTC im Sommer)",
    html.includes("13.09.2026, 12:00") && html.includes("(Europe/Zurich)"));
  pruefe("die Zeile zeigt den Anhang an", html.includes("📎"));
  pruefe("die Zeile bietet Bearbeiten, Jetzt senden, Abbrechen, Verschieben",
    ["gmailAusgangBearbeiten", "gmailAusgangJetzt", "gmailAusgangAbbrechen", "gmailAusgangVerschiebenAus"]
      .every((f) => html.includes(f)));

  const laufend = zeile(Object.assign({}, eintrag, { status: "sendet" }));
  pruefe("während des Versands gibt es keine Knöpfe mehr",
    !/gmailAusgangAbbrechen|gmailAusgangJetzt/.test(laufend) && /Wird gerade gesendet/.test(laufend));

  const gescheitert = zeile(Object.assign({}, eintrag, { status: "fehlgeschlagen", letzterFehler: "Gmail 503" }));
  pruefe("ein Fehlschlag wird benannt und bleibt bedienbar",
    /Nicht gesendet/.test(gescheitert) && /Gmail 503/.test(gescheitert) && /gmailAusgangAbbrechen/.test(gescheitert));

  pruefe("die Seite zeigt den Eintrag", seite().includes("Beispielbetreff"));
  GM.ausgang = [];
  pruefe("ohne Eintrag steht da, was „Senden“ jetzt bedeutet",
    /Nichts geplant/.test(seite()) && /drei Stunden/.test(seite()));
  GM.drafts = [{ _key: "alt1", status: "scheduled", to: "alt@example.com" }];
  pruefe("alte Browser-Planungen werden sichtbar gemeldet, nicht heimlich übernommen",
    /alte Planung/i.test(seite()) && /nicht mehr von selbst/.test(seite()));
}

/* ── Der Sofort-Knopf im Bearbeiten-Fenster ──────────────────────────────
   Befund der unabhängigen Prüfung (13.09.2026): Der neu eingebaute Knopf
   „📨 Jetzt senden" erschien auch beim Bearbeiten eines BEREITS GEPLANTEN
   Eintrags. `gmailSendNow` baut die Nachricht aus dem Fenster neu — ohne die
   Anhänge, die nur in der gespeicherten Nachricht liegen — und schickt sie
   direkt an Gmail. Der geplante Eintrag bliebe daneben stehen und ginge später
   ein zweites Mal raus.

   Geprüft wird hier die tatsächliche Verzweigung: Die echte Funktion wird aus
   der Datei geschnitten und ausgeführt. Mit `ausgangId` muss sie den Eintrag
   fällig setzen und darf Gmail NICHT anfassen. */
{
  const quelle = schneide(JETZT, "  window.gmailSendNow = async function(){");
  const gebaut = new Function("fenster", "GM", "gmApi", "document", "toast", "buildRaw", "closeModal",
    "const window = fenster; " + quelle + "; return fenster.gmailSendNow;");

  // Fall 1: ein geplanter Eintrag wird bearbeitet.
  {
    const gerufen = { plan: [], gmail: [] };
    const fenster = { gmailPlanSend: async (o) => { gerufen.plan.push(o); return { ok: true }; } };
    const GM = { _composeCtx: { ausgangId: "out_1" }, _attachments: [] };
    const gmApi = async (m, p) => { gerufen.gmail.push(m + " " + p); return {}; };
    const fn = gebaut(fenster, GM, gmApi, { getElementById: () => null }, () => {}, () => "raw", () => {});
    const vorher = Date.now();
    await fn();

    pruefe("beim Bearbeiten wird der geplante Eintrag fällig gesetzt", gerufen.plan.length === 1);
    pruefe("dabei geht KEIN Aufruf direkt an Gmail", gerufen.gmail.length === 0);
    const z = gerufen.plan[0] && Number(gerufen.plan[0].zeitpunkt);
    pruefe("der Eintrag bekommt einen Sofort-Termin", Number.isFinite(z) && z >= vorher && z <= Date.now() + 1000);
  }

  // Fall 2: eine neue Mail — hier ist der Sofortversand gewollt.
  {
    const gerufen = { plan: [], gmail: [] };
    const fenster = { gmailPlanSend: async (o) => { gerufen.plan.push(o); return { ok: true }; } };
    const GM = { _composeCtx: {}, _attachments: [] };
    const felder = { gmlTo: { value: "beispiel@example.com" }, gmlSubject: { value: "B" }, gmlBody: { value: "T" } };
    const gmApi = async (m, p) => { gerufen.gmail.push(m + " " + p); throw new Error("Abbruch im Test"); };
    const fn = gebaut(fenster, GM, gmApi,
      { getElementById: (id) => felder[id] || null }, () => {}, () => "raw", () => {});
    await fn();
    pruefe("bei einer neuen Mail geht der Sofortversand wirklich an Gmail",
      gerufen.gmail.some((a) => /messages\/send/.test(a)));
    pruefe("bei einer neuen Mail wird nicht heimlich geplant", gerufen.plan.length === 0);
  }
}

/* ── „Senden" wirklich ausführen ─────────────────────────────────────────
   Quelltext lesen sagt nicht, was passiert. Die echte Weiche wird deshalb aus
   der Datei geschnitten und ausgeführt — einmal für eine neue Mail, einmal für
   einen bereits geplanten Eintrag, der nur bearbeitet wird. */
{
  const quelle = schneide(JETZT, "  window.gmailSend = function(){");
  const bauen = new Function("fenster", "GM",
    "const window = fenster; " + quelle + "; return fenster.gmailSend;");

  // Fall 1: neue Mail → direkt raus (gmailSendNow), keine Planung.
  {
    const gerufen = { sofort: 0, plan: [] };
    const fenster = {
      gmailSendNow: async () => { gerufen.sofort++; return true; },
      gmailPlanSend: async (o) => { gerufen.plan.push(o); return { ok: true }; },
    };
    const fn = bauen(fenster, { _composeCtx: {} });
    await fn();
    pruefe("eine neue Mail geht über „Senden“ SOFORT raus", gerufen.sofort === 1);
    pruefe("eine neue Mail wird dabei nicht geplant", gerufen.plan.length === 0);
  }

  // Fall 2: ein geplanter Eintrag wird bearbeitet → nur speichern, kein Versand,
  //         und vor allem KEIN neuer Zeitpunkt (sonst ginge er sofort raus).
  {
    const gerufen = { sofort: 0, plan: [] };
    const fenster = {
      gmailSendNow: async () => { gerufen.sofort++; return true; },
      gmailPlanSend: async (o) => { gerufen.plan.push(o); return { ok: true }; },
    };
    const fn = bauen(fenster, { _composeCtx: { ausgangId: "out_1" } });
    await fn();
    pruefe("„Änderung speichern“ sendet nichts direkt", gerufen.sofort === 0);
    pruefe("„Änderung speichern“ geht über den Ausgang", gerufen.plan.length === 1);
    pruefe("„Änderung speichern“ verschiebt den Termin nicht",
      gerufen.plan[0] && gerufen.plan[0].zeitpunkt === undefined);
  }

  // Fall 3: ohne Verfassen-Kontext darf nichts krachen — und es wird gesendet,
  //         nicht geplant (es gibt keinen Eintrag, den man ändern könnte).
  {
    const gerufen = { sofort: 0, plan: [] };
    const fenster = {
      gmailSendNow: async () => { gerufen.sofort++; return true; },
      gmailPlanSend: async (o) => { gerufen.plan.push(o); return { ok: true }; },
    };
    const fn = bauen(fenster, {});
    await fn();
    pruefe("ohne Kontext sendet „Senden“ und plant nicht",
      gerufen.sofort === 1 && gerufen.plan.length === 0);
  }
}

/* ── Gegenprobe: derselbe Test gegen den Stand vor der Änderung ─────────── */
console.log("\n── Gegenprobe gegen " + BASIS + " (dort MUSS es fehlschlagen) ──");
let alt = null;
try {
  alt = execFileSync("git", ["show", BASIS + ":public/index.html"], { cwd: WURZEL, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
} catch (e) {
  console.log("  (übersprungen — " + BASIS + " nicht lesbar: " + (e && e.message) + ")");
}
if (alt) {
  const durchgefallen = [];
  for (const [name, fn] of Object.entries(PRUEFUNGEN)) {
    let r = false;
    try { r = !!fn(alt); } catch (e) { r = false; }
    if (!r) durchgefallen.push(name);
  }
  console.log("  im alten Stand fallen " + durchgefallen.length + " von " + Object.keys(PRUEFUNGEN).length + " Prüfungen durch:");
  durchgefallen.forEach((n) => console.log("    ✗ " + n));
  pruefe("Gegenprobe: der alte Stand hat mehrere Sofort-Sendepfade",
    durchgefallen.includes("genau ein Sofort-Sendepfad im Quelltext"));
  pruefe("Gegenprobe: im alten Stand sendet der Browser-Takt",
    durchgefallen.includes("der alte Browser-Takt ist entfernt"));
  pruefe("Gegenprobe: im alten Stand sendet der KI-Composer sofort",
    durchgefallen.includes("der KI-/Entity-Composer plant ebenfalls"));
  pruefe("Gegenprobe: im alten Stand gibt es keinen Ausgang",
    durchgefallen.includes("es gibt eine ausgehende Ausgangsansicht (keine Selbstmail im Posteingang)"));
}

/* ── Zweite Gegenprobe: gegen den Stand VOM 13.–15.09. ───────────────────
   Dort war „Senden" die Planung. Genau die Prüfungen, die den neuen Standard
   festhalten, müssen in jenem Stand durchfallen — sonst prüfen sie nichts. */
const ZWISCHEN = process.env.MAIL_STANDARD_BASIS_COMMIT || "721d0ab";
console.log("\n── Gegenprobe gegen " + ZWISCHEN + " (dort plante „Senden“) ──");
{
  let zwischen = null;
  try {
    zwischen = execFileSync("git", ["show", ZWISCHEN + ":public/index.html"],
      { cwd: WURZEL, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  } catch (e) {
    console.log("  (übersprungen — " + ZWISCHEN + " nicht lesbar: " + (e && e.message) + ")");
  }
  if (zwischen) {
    const mussDortFallen = [
      "„Senden“ sendet direkt — und speichert beim Bearbeiten nur",
      "der Knopf heisst wieder „Senden“, nicht „Senden (in 3 h)“",
      "es gibt keinen zweiten Sofort-Knopf mehr",
      "drei Stunden sind der Vorschlag der ausdrücklichen Planung",
      "eine gescheiterte Planung sendet nicht ersatzweise",
    ];
    for (const name of mussDortFallen) {
      let r = true;
      try { r = !!PRUEFUNGEN[name](zwischen); } catch (e) { r = false; }
      pruefe("Gegenprobe " + ZWISCHEN + ": " + name, r === false);
      if (r) console.log("  ✗ hielt auch im alten Stand: " + name);
      else console.log("  ✓ fällt dort durch: " + name);
    }
    /* Und dass dort wirklich geplant wurde — sonst zeigt die Gegenprobe auf
       den falschen Stand. */
    pruefe("Gegenprobe " + ZWISCHEN + ": dort plante „Senden“ standardmässig",
      /window\.gmailSend\s*=\s*function\s*\(\)\s*\{\s*return\s+window\.gmailPlanSend\(\{\}\);\s*\}/.test(zwischen));
    pruefe("Gegenprobe " + ZWISCHEN + ": dort stand „Senden (in 3 h)“ auf dem Knopf",
      zwischen.includes("'Senden (in 3 h)'"));
  }
}

console.log("\n" + (fehler.length ? "✗ " : "✓ ") + ok + " Prüfungen bestanden, " + fehler.length + " fehlgeschlagen");
if (fehler.length) { fehler.forEach((f) => console.log("   ✗ " + f)); process.exit(1); }
