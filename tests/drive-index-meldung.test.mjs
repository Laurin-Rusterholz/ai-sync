/*
 * Indexierung einer Google-Drive-Verknüpfung: die Meldung muss stimmen.
 *
 * PRODUKTIONSBEFUND (12.09.2026, Gmail-Aufgabe mit sieben „Aus Drive"-Belegen,
 * private Datei LESEHINWEIS_*.md, Knopf „jetzt indexieren"):
 *   Zuerst erschien zutreffend „Nicht lesbar — Die Datei liegt privat in
 *   Google Drive …", unmittelbar danach aber „CORS blockt Download — bitte
 *   Datei neu hochladen". Die zweite Meldung legte sich über die erste und ist
 *   für eine Drive-VERKNÜPFUNG falsch: es liegt gar keine Kopie vor, die man
 *   neu hochladen könnte, und der lokale Weg über das Dateifeld ist auf diesem
 *   Rechner ohnehin gesperrt („setFiles: Not allowed"). Am Ende stand ein Rat,
 *   den niemand befolgen kann, über der richtigen Auskunft.
 *
 * URSACHE im Code: window._reindexFile sammelte den Grund nicht ein. Strategie
 * 3 (download-proxy) erkannte die Anmeldeseite zwar, zeigte die Auskunft aber
 * sofort als Toast und verwarf den Grund; danach warf der gemeinsame Abschluss
 * unbesehen „CORS blockt Download — bitte Datei neu hochladen", und der
 * catch-Block setzte noch einen gleichlautenden Toast darauf.
 *
 * WAS HIER NICHT PASSIERT: Drive-Verknüpfungen werden nicht pauschal
 * abgeschaltet. Eine frei lesbare Drive-Datei liefert über den Proxy die
 * echten Bytes und wird ganz normal indexiert; ein vorübergehender Fehler
 * bleibt ein vorübergehender Fehler. Es wird auch nichts automatisch
 * wiederholt — jeder Lauf beginnt mit einem Klick; der Knopf „erneut
 * versuchen" bleibt in jedem Fall stehen, damit ein Versuch nach geänderter
 * Zugriffslage möglich ist.
 *
 * Geprüft wird die ECHTE Funktion aus public/index.html gegen Attrappen von
 * fetch/DOM/Speicher. Kein Netz, keine Datei, keine Berechtigung wird
 * angefasst; die Testdaten sind erfunden.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ── Die echte Funktion herausschneiden ────────────────────────────────────
const a = index.indexOf("window._reindexFile = async function(kind, entityId, fileId)");
const b = index.indexOf("window._extractQueueProcess();\n};", a);
ok(a > 0 && b > a, "window._reindexFile wurde nicht gefunden");
const quelle = index.slice(a, b + "window._extractQueueProcess();\n};".length);

// ── Ein Lauf mit Attrappen ────────────────────────────────────────────────
// proxyAntwort beschreibt, was der download-proxy zurückgibt.
async function lauf({ dateiname, quelleFeld, proxy, adresse }) {
  const datei = {
    id: "f_test", name: dateiname,
    url: adresse || "https://drive.google.com/uc?export=download&id=TESTID",
    driveFileId: quelleFeld === "gdrive" ? "TESTID" : undefined,
    source: quelleFeld, uploadedAt: "2026-09-12T08:00:00.000Z",
  };
  const APP = { state: { data: { entities: { tasks: { t1: { id: "t1", files: [datei] } } } } } };
  const toasts = [];
  const anzeige = { style: {}, innerHTML: "" };
  const win = { _extractQueue: [], _extractQueueRunning: false, _extractQueueProcess() { this._geprozesst = true; } };
  const warnungen = [];
  const fn = new Function(
    "window", "APP", "ATTACHMENT_KIND_STORES", "toast", "document", "fetch",
    "XMLHttpRequest", "esc", "scheduleSave", "console",
    quelle + "\nreturn window._reindexFile;"
  )(
    win, APP, { task: "tasks" },
    (art, titel, text) => { toasts.push({ art, titel, text }); },
    { querySelector: () => anzeige },
    async () => {
      if (proxy.wirft) throw new TypeError("Failed to fetch");
      return {
        ok: proxy.status === 200, status: proxy.status,
        blob: async () => new Blob([proxy.inhalt || ""], { type: proxy.typ || "application/octet-stream" }),
      };
    },
    // XHR scheitert wie im Browser bei einer fremden Adresse (CORS).
    function () {
      return { open() {}, send() { setTimeout(() => this.onerror && this.onerror(), 0); },
        set responseType(_v) {}, set timeout(_v) {} };
    },
    (x) => String(x), () => {}, { warn() { warnungen.push([...arguments]); }, error() {} }
  );
  await fn("task", "t1", "f_test");
  // Der erste Toast ist die Startmeldung („Indexierung gestartet"). Gezaehlt
  // wird, was am ENDE gesagt wird — dort lagen die widerspruechlichen Saetze.
  const schluss = toasts.filter((t) => t.art !== "info");
  return { toasts: schluss, alleToasts: toasts, anzeige, datei, win };
}

// ═══ 1. Anmeldeseite statt Datei (der gemeldete Fall) ═════════════════════
{
  const r = await lauf({ dateiname: "LESEHINWEIS.md", quelleFeld: "gdrive",
    proxy: { status: 200, typ: "text/html; charset=utf-8", inhalt: "<html>Anmelden</html>" } });
  ok(r.toasts.length === 1, `es erscheinen ${r.toasts.length} Meldungen statt genau einer — die zweite legt sich über die erste`);
  const t = r.toasts[0] || {};
  ok(/Kein Drive-Zugriff/.test(t.titel || ""), `die Meldung heisst „${t.titel}“ statt „Kein Drive-Zugriff“`);
  ok(/keinen angemeldeten Drive-Zugriff/.test(t.text || ""),
    "die Meldung nennt den fehlenden angemeldeten Drive-Zugriff nicht");
  ok(!/neu hochladen/i.test(JSON.stringify(r.toasts)),
    "es wird weiterhin geraten, die Datei neu hochzuladen — bei einer Verknüpfung gibt es nichts hochzuladen");
  ok(!/CORS/i.test(JSON.stringify(r.toasts)), "die CORS-Meldung liegt weiterhin darüber");
  ok(/Anmeldeseite/.test(r.anzeige.innerHTML) && !/neu hochladen/i.test(r.anzeige.innerHTML),
    "die Zeile an der Datei sagt etwas anderes als die Meldung");
  // Manueller Neuversuch muss möglich bleiben.
  ok(/_reindexFile\('task','t1','f_test'\)/.test(r.anzeige.innerHTML),
    "der Knopf „erneut versuchen“ fehlt — nach geänderter Zugriffslage gäbe es keinen Weg mehr");
  ok(r.datei.textExtractStatus === "failed", `der Status ist ${r.datei.textExtractStatus} statt failed`);
  ok(r.win._extractQueue.length === 0, "eine unlesbare Datei landet trotzdem in der Warteschlange");
}

// ═══ 2. Echte Textdatei über denselben Weg: wird ganz normal indexiert ════
{
  const r = await lauf({ dateiname: "NOTIZ.md", quelleFeld: "gdrive",
    proxy: { status: 200, typ: "text/markdown", inhalt: "# Titel\nInhalt" } });
  ok(r.toasts.length === 0,
    `eine lesbare Drive-Datei meldet einen Fehler (${JSON.stringify(r.toasts)})`);
  ok(r.win._extractQueue.length === 1,
    "eine lesbare Drive-Datei wird nicht mehr zur Extraktion gegeben — Drive-Verknüpfungen dürfen nicht pauschal abgeschaltet sein");
  ok(r.win._extractQueue[0] && r.win._extractQueue[0].originalFile,
    "die geladene Datei fehlt in der Warteschlange");
  ok(r.datei.textExtractStatus !== "failed", "eine lesbare Datei wird als fehlgeschlagen geführt");
}

// ═══ 3. Vorübergehender Fehler bleibt ein vorübergehender Fehler ══════════
for (const [name, proxy] of [
  ["Proxy meldet 502", { status: 502 }],
  ["Proxy nicht erreichbar", { wirft: true }],
]) {
  const r = await lauf({ dateiname: "BERICHT.md", quelleFeld: "gdrive", proxy });
  ok(r.toasts.length === 1, `${name}: ${r.toasts.length} Meldungen statt einer`);
  const t = r.toasts[0] || {};
  ok(/Download fehlgeschlagen/.test(t.titel || ""),
    `${name}: die Meldung heisst „${t.titel}“ — ein Aussetzer ist kein fehlender Zugriff`);
  ok(/späterer Versuch kann klappen/.test(t.text || ""),
    `${name}: die Meldung sagt nicht, dass ein späterer Versuch klappen kann`);
  ok(!/Drive-Zugriff/.test(JSON.stringify(r.toasts)),
    `${name}: ein Aussetzer wird als fehlender Drive-Zugriff ausgegeben`);
  ok(!/neu hochladen/i.test(JSON.stringify(r.toasts)), `${name}: es wird zum Neuhochladen geraten`);
  ok(/_reindexFile\('task','t1','f_test'\)/.test(r.anzeige.innerHTML),
    `${name}: der Knopf für den nächsten Versuch fehlt`);
}

// ═══ 4. Rangfolge der Meldungen ═══════════════════════════════════════════
{
  // Eine HTML-Antwort für eine NICHT-Drive-Adresse ist kein Drive-Problem.
  const r = await lauf({ dateiname: "FREMD.md", quelleFeld: "upload",
    adresse: "https://beispiel.invalid/datei.md",
    proxy: { status: 200, typ: "text/html", inhalt: "<html>x</html>" } });
  ok(!/Drive-Zugriff/.test(JSON.stringify(r.toasts)),
    "eine fremde Quelle wird als Drive-Problem gemeldet");
  // …aber eine Drive-Adresse zählt auch ohne source-Feld als Drive.
  ok(/(^|\n)\s*const ausDrive =/.test(quelle) || /const ausDrive = \(function\(\)/.test(quelle),
    "die Herkunftsprüfung fehlt");
  ok(/drive\\?\.google\\?\.com/.test(quelle),
    "die Herkunftsprüfung schaut nicht auf die Adresse, sondern nur auf das source-Feld");

  // Der allgemeine CORS-Satz darf nur noch als letzter Ausweg stehen.
  const geworfen = (quelle.match(/throw new Error\('CORS blockt Download/g) || []).length;
  ok(geworfen === 1, `„CORS blockt Download“ wird ${geworfen}-mal geworfen statt genau einmal`);
  const abschluss = quelle.slice(quelle.indexOf("if (!blob){"), quelle.indexOf("file = new File"));
  ok(abschluss.indexOf("drive-anmeldung") < abschluss.indexOf("zeitweise")
    && abschluss.indexOf("zeitweise") < abschluss.indexOf("CORS blockt Download"),
    "die Rangfolge stimmt nicht: die genaueste Auskunft muss zuerst greifen");
}

// ═══ 5. Nichts wiederholt sich von selbst ═════════════════════════════════
{
  // _reindexFile wird ausschliesslich durch einen Klick oder die
  // ausdrückliche Bestätigung ausgelöst — kein Timer, kein Selbstaufruf.
  const aufrufe = index.split("window._reindexFile(").length - 1;
  const ausKlick = (index.match(/onclick="window\._reindexFile\(/g) || []).length;
  ok(aufrufe - ausKlick <= 1,
    `_reindexFile wird ${aufrufe - ausKlick}-mal ohne Klick aufgerufen — es darf nur die bestätigte Sammelaktion sein`);
  ok(!/setTimeout\([^)]*_reindexFile/.test(index) && !/setInterval\([^)]*_reindexFile/.test(index),
    "es gibt einen zeitgesteuerten Wiederholungslauf");
}

ok(/name="quantus-build"[^>]*drive-meldung-ehrlich/.test(index),
  "die Bau-Kennung nennt die Änderung nicht");

if (luecken.length) {
  console.error(`drive index meldung: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`drive index meldung: ${checks} Pruefungen bestanden`);
