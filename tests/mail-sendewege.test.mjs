/* ══ Alle Sendewege gehen über den Ausgang ═══════════════════════════════════
 *
 * PRODUKTIONSBEFUND (13.09.2026, im damaligen main selbst nachgesehen):
 * Quantus hatte DREI Stellen, die eine Mail unmittelbar hinausschickten —
 *   1. window.gmailSend (Verfassen-Knopf)            → POST messages/send
 *   2. gmailProcessScheduledDrafts (Browser-Takt)    → POST messages/send,
 *      mit attachments:[] und status:"sent" ohne Rückfrage bei Gmail
 *   3. gmailAIExec("SEND") (KI-/Entity-Composer)     → POST messages/send
 * Der Auftrag verlangt EINEN sicheren Standard: drei Stunden Verzögerung,
 * sichtbar und abbrechbar, gesendet vom Server. Ein einziger übriggebliebener
 * Sofortpfad hebt den Standard auf — und zwei parallele Sender (Takt UND
 * Warteschlange) schicken dieselbe Mail zweimal.
 *
 * Dieser Test liest den ausgelieferten Quelltext. Er ist bewusst grob: er
 * fragt nicht, ob eine Funktion hübsch ist, sondern ob es überhaupt noch einen
 * Weg gibt, der an der Warteschlange vorbei sendet.
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

  "„Senden“ plant, statt zu senden": (s) =>
    /window\.gmailSend\s*=\s*function\s*\(\)\s*\{\s*return\s+window\.gmailPlanSend\(\{\}\);\s*\}/.test(s),

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
    const i = s.indexOf("window.gmailPlanSend");
    if (i < 0) return false;
    const block = s.slice(i, i + 2600);
    return block.includes("attachments:(GM._attachments||[])") && block.includes("hatAnhaenge");
  },

  "der Eingangs-Thread bleibt unberührt: geplant wird nur, nicht modifiziert": (s) => {
    const i = s.indexOf("window.gmailPlanSend");
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

console.log("\n" + (fehler.length ? "✗ " : "✓ ") + ok + " Prüfungen bestanden, " + fehler.length + " fehlgeschlagen");
if (fehler.length) { fehler.forEach((f) => console.log("   ✗ " + f)); process.exit(1); }
