/*
 * „🧠 n indexieren" hielt den ganzen Browser an.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026, Fernsteuerung bei gesperrtem Rechner): Der Knopf in der
 * Dokumentenkarte loeste ein natives window.confirm aus. Ein solcher Dialog
 * blockiert alles — er laesst sich weder anklicken noch annehmen, wenn der
 * Rechner gesperrt ist oder die Bedienung von aussen kommt. Die Indexierung
 * war damit gar nicht mehr ausloesbar; derselbe Befund wie zuvor beim
 * Wiederherstellen eines Fragebogens.
 *
 * Die Rueckfrage ist jetzt gewoehnliches HTML in der Karte: sie nennt, wie
 * viele und WELCHE Dateien gelesen werden, und traegt zwei klare Knoepfe.
 * Geprueft wird der ECHTE Code aus index.html. Es werden keine echten Daten
 * angefasst; gelesen wird ohnehin nur, geschrieben wird nichts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quelle = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

/* ── Der echte Abschnitt: Kandidaten, Frage, Zusage, Abbruch ──────────── */
const von = quelle.indexOf("function _reindexKandidaten(kind, entityId) {");
const bis = quelle.indexOf("// Wrapper der nach Upload aufgerufen wird");
ok(von > -1 && bis > von, "der Indexierungs-Knopf wurde in index.html nicht gefunden");
const abschnitt = quelle.slice(von, bis);

/* ── Und das echte Markup der Dokumentenkarte ─────────────────────────── */
const kartenVon = quelle.indexOf("function renderFileAttachments(kind, entityId) {");
const kartenBis = quelle.indexOf("window.renderFileAttachments = renderFileAttachments;");
ok(kartenVon > -1 && kartenBis > kartenVon, "die Dokumentenkarte wurde nicht gefunden");
const karte = quelle.slice(kartenVon, kartenBis);

function bauen(dateien) {
  const entity = { id: "prj_1", title: "Aljia", files: dateien, fileFolders: [] };
  const gestartet = [];
  const meldungen = [];
  let gezeichnet = 0;
  const win = {};
  const scope = {
    window: win,
    APP: { state: { data: { entities: { projects: { prj_1: entity } } } } },
    ATTACHMENT_KIND_STORES: { project: "projects" },
    attachmentEntity: () => entity,
    firebaseStorage: {},
    esc: (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    getFileIcon: () => "📄",
    isImageFile: () => false,
    canPreviewFile: () => false,
    formatFileSize: () => "1 KB",
    renderUploadZone: () => "",
    toast: (typ, titel, text) => meldungen.push({ typ, titel, text }),
    render: () => { gezeichnet++; },
    confirm: () => { throw new Error("window.confirm wurde aufgerufen — genau das blockiert die Bedienung"); },
    document: { getElementById: () => null },
  };
  win.window = win;
  win._reindexFile = (kind, id, fileId) => gestartet.push(fileId);
  scope._reindexFile = win._reindexFile;
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const bauen2 = new Function(...namen,
    "with (window) {\n" + abschnitt + "\n" + karte + "\nreturn renderFileAttachments;\n}");
  const renderKarte = bauen2(...namen.map((n) => scope[n]));
  const karteHtml = () => String(renderKarte("project", "prj_1"));
  // Nur der Rueckfrage-Block — die Karte listet daneben ja alle Dateien.
  const frage = () => {
    const html = karteHtml();
    const a = html.indexOf('role="alertdialog"');
    if (a < 0) return "";
    const start = html.lastIndexOf("<div", a);
    const ende = html.indexOf("</div>\n        </div>", a);
    return html.slice(start, ende < 0 ? a + 2500 : ende + 20);
  };
  return { win, gestartet, meldungen, entity, karte: karteHtml, frage, gezeichnet: () => gezeichnet };
}

const DATEIEN = [
  { id: "f1", name: "Offerte.pdf", url: "https://example.test/1", textExtracted: false },
  { id: "f2", name: "Notizen.docx", url: "https://example.test/2", textExtracted: false },
  { id: "f3", name: "Logo.png", url: "https://example.test/3", textExtracted: false },
  { id: "f4", name: "Alt.pdf", url: "https://example.test/4", textExtracted: "schon da" },
];

/* ══ 1. Der Knopf fragt sichtbar — und startet noch nichts ════════════════ */
{
  const t = bauen(JSON.parse(JSON.stringify(DATEIEN)));
  ok(t.frage() === "", "die Rückfrage steht schon da, bevor jemand geklickt hat");

  t.win._reindexAllFiles("project", "prj_1");        // haette frueher blockiert
  eq(t.gestartet, [], "die Indexierung läuft schon vor der Bestätigung los");
  const gefragt = t.frage();
  ok(/role="alertdialog"/.test(gefragt), "die Rückfrage ist für Bedienhilfen nicht erkennbar");
  ok(/2 Datei\(en\) jetzt indexieren\?/.test(gefragt),
    "die Rückfrage nennt die Zahl der Dateien nicht — nur PDF und DOCX sind lesbar");
  ok(/Offerte\.pdf/.test(gefragt) && /Notizen\.docx/.test(gefragt),
    "die Rückfrage nennt die Dateien nicht");
  ok(!/Logo\.png/.test(gefragt), "eine nicht lesbare Datei steht in der Rückfrage");
  ok(!/Alt\.pdf/.test(gefragt), "eine längst indexierte Datei steht in der Rückfrage");
  ok(/nichts geändert, nichts gelöscht, nichts verschickt/.test(gefragt),
    "die Rückfrage sagt nicht, was NICHT geschieht");
  ok(/_reindexBestaetigen\(\)/.test(gefragt) && /Ja, indexieren/.test(gefragt),
    "der Rückfrage fehlt der zustimmende Knopf");
  ok(/_reindexAbbrechen\(\)/.test(gefragt) && /Abbrechen/.test(gefragt),
    "der Rückfrage fehlt der ablehnende Knopf");

  // Abbrechen: folgenlos.
  t.win._reindexAbbrechen();
  eq(t.gestartet, [], "das Abbrechen hat die Indexierung gestartet");
  ok(t.frage() === "", "die Rückfrage bleibt nach dem Abbrechen stehen");

  // Zustimmen: jetzt läuft es — und nur für die lesbaren, noch offenen Dateien.
  t.win._reindexAllFiles("project", "prj_1");
  t.win._reindexBestaetigen();
  eq(t.gestartet, ["f1", "f2"], "es wurden die falschen Dateien indexiert");
  ok(t.frage() === "", "die Rückfrage bleibt nach dem Zustimmen stehen");
  ok(t.meldungen.some((m) => /Re-Index gestartet/.test(m.titel || "")), "der Start wird nicht gemeldet");
}

/* ══ 2. Nichts zu tun heisst: keine Rückfrage ═════════════════════════════ */
{
  const t = bauen([{ id: "f9", name: "Fertig.pdf", url: "https://example.test/9", textExtracted: "da" }]);
  t.win._reindexAllFiles("project", "prj_1");
  ok(t.frage() === "", "es wird nach etwas gefragt, das es nicht gibt");
  ok(t.meldungen.some((m) => /Alle indexiert/.test(m.titel || "")), "es wird nicht gemeldet, dass nichts offen ist");
  eq(t.gestartet, [], "es wurde trotzdem etwas gestartet");
}

/* ══ 3. Die Rückfrage gehört zu GENAU dieser Karte ════════════════════════ */
{
  const t = bauen(JSON.parse(JSON.stringify(DATEIEN)));
  t.win._reindexFrage = { kind: "note", entityId: "note_7", namen: ["Fremd.pdf"] };
  ok(t.frage() === "", "die Rückfrage einer anderen Karte erscheint hier mit");
}

/* ══ 4. Quelltext: kein natives confirm mehr auf diesem Weg ═══════════════ */
{
  ["_reindexAllFiles", "_reindexBestaetigen", "_reindexAbbrechen", "_reindexKandidaten"].forEach((n) => {
    const start = abschnitt.indexOf(n);
    ok(start > -1, `${n} wurde nicht gefunden`);
  });
  ok(!/(^|[^.\w])confirm\s*\(/.test(abschnitt),
    "der Indexierungs-Knopf hält den Browser weiterhin mit einem nativen confirm an");
  ok(!/re-indexieren\?\\n\\n/.test(quelle), "der alte confirm-Text steht noch in index.html");
}

console.log(`dokumentindex bestaetigung: ok (${checks} Pruefungen)`);
