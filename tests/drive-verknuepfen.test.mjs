/*
 * Eine Datei, die schon in Google Drive liegt, liess sich nicht einbinden.
 * ---------------------------------------------------------------------------
 * Befund (11.09.2026): Eine XLSX wurde direkt in Google Drive abgelegt
 * (Id 1jfmPGHfXqXXPfkL6zKCd3_smeO0I3ikA). „Aus Drive" zeigte sie nicht — und
 * konnte das auch nicht: Diese Liste ist der EIGENE Index von Quantus
 * (driveDocs in Firebase), nicht der Inhalt des Google-Kontos. Der Weg über
 * „Hochladen" schied aus, weil der native Dateidialog bei gesperrtem Rechner
 * nicht bedienbar ist — derselbe Blocker wie bei den nativen Dialogen zuvor.
 *
 * Es gibt jetzt einen dritten Weg: Adresse oder Id einsetzen, verknüpfen. Es
 * wird NICHTS kopiert und nichts hochgeladen — die Datei bleibt, wo sie ist.
 * Nichts geschieht von selbst: Die Id kommt von Hand, erst ein Klick legt die
 * Verknüpfung an.
 *
 * Und damit eine so verknüpfte Datei auch indexierbar ist, nutzt die
 * Indexierung als dritte Strategie den VORHANDENEN download-proxy. Kein neuer
 * Zugang, keine neue Berechtigung — er holt nur, was ohnehin unter dieser
 * Adresse liegt. Ist die Datei nicht freigegeben, wird das gesagt.
 *
 * Geprüft wird der ECHTE Code aus index.html. Es werden keine fremden Daten
 * importiert und nichts hochgeladen.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (b, m) => { assert.ok(b, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

function schnitt(von, bis, was) {
  const a = index.indexOf(von);
  const b = index.indexOf(bis, a + 1);
  assert.ok(a > -1 && b > a, `${was} wurde in index.html nicht gefunden`);
  checks++;
  return index.slice(a, b);
}
const quelle = schnitt("window._driveIdAus = function(text){",
  "window._attachFromDriveFilter = function(q){", "der Weg über Adresse oder Id");

function bauen(entity) {
  const felder = new Map([
    ["drvLinkId", { value: "" }], ["drvLinkName", { value: "" }],
    ["drvLinkHinweis", { textContent: "", style: {} }],
  ]);
  const meldungen = [];
  let gezeichnet = 0, gespeichert = 0;
  const win = {};
  const scope = {
    window: win,
    document: { getElementById: (id) => felder.get(id) || null },
    _drvEntity: () => entity,
    scheduleSave: () => { gespeichert++; },
    toast: (typ, titel, text) => meldungen.push({ typ, titel, text }),
    render: () => { gezeichnet++; },
    Date, Math,
  };
  win.window = win;
  const namen = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  new Function(...namen, "with (window) {\n" + quelle + "\n}")(...namen.map((n) => scope[n]));
  return { win, felder, meldungen, entity,
    hinweis: () => felder.get("drvLinkHinweis").textContent,
    gespeichert: () => gespeichert, gezeichnet: () => gezeichnet };
}

const ID = "1jfmPGHfXqXXPfkL6zKCd3_smeO0I3ikA";

/* ══ 1. Die Id wird aus jeder üblichen Form gelesen ═══════════════════════ */
{
  const t = bauen({ files: [] });
  const formen = [
    ID,
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/edit`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/uc?export=download&id=${ID}`,
    `  https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0  `,
  ];
  formen.forEach((f) => eq(t.win._driveIdAus(f), ID, `die Id wird aus „${f.slice(0, 46)}…“ nicht gelesen`));
  ["", "   ", "kein link", "https://example.test/", "abc"].forEach((f) =>
    eq(t.win._driveIdAus(f), "", `„${f}“ wird fälschlich als Id genommen`));
}

/* ══ 2. Verknüpfen — ohne Kopie, ohne Upload ══════════════════════════════ */
{
  const entity = { id: "prj_1", files: [] };
  const t = bauen(entity);
  t.felder.get("drvLinkId").value = `https://drive.google.com/file/d/${ID}/view`;
  t.felder.get("drvLinkName").value = "Budget 2026.xlsx";
  t.win._attachDriveByLink("project", "prj_1");

  eq(entity.files.length, 1, "die Datei wurde nicht verknüpft");
  const f = entity.files[0];
  eq(f.name, "Budget 2026.xlsx", "der Anzeigename fehlt");
  eq(f.driveFileId, ID, "die Drive-Id wurde nicht festgehalten");
  eq(f.source, "gdrive", "die Herkunft wurde nicht vermerkt");
  eq(f.url, `https://drive.google.com/uc?export=download&id=${ID}`,
    "die Adresse zeigt nicht auf die Drive-Datei");
  // Das Entscheidende: KEINE Kopie, KEIN eigener Speicherort.
  ok(!f.storagePath, "die Datei wurde in den eigenen Speicher kopiert — das wäre der Doppel-Upload");
  ok(!f.textExtracted, "die Datei gilt ohne Prüfung als indexiert");
  ok(f.id && f.uploadedAt, "der Eintrag ist unvollständig");
  eq(t.gespeichert(), 1, "die Verknüpfung wurde nicht gespeichert");
  ok(t.meldungen.some((m) => /kopiert/.test(m.text || "")), "es wird nicht gesagt, dass nichts kopiert wurde");
  ok(/Google Drive/.test(t.hinweis()), "der Hinweis am Feld fehlt");
}

/* ══ 3. Nichts geschieht von selbst — und nichts doppelt ══════════════════ */
{
  const entity = { id: "prj_1", files: [] };
  const t = bauen(entity);
  // Leeres Feld: keine Verknüpfung, aber eine Erklärung.
  t.win._attachDriveByLink("project", "prj_1");
  eq(entity.files.length, 0, "aus einem leeren Feld entstand eine Verknüpfung");
  ok(/Drive-Adresse oder Id/.test(t.hinweis()), "es wird nicht gesagt, was fehlt");

  // Unsinn: ebenso.
  t.felder.get("drvLinkId").value = "das ist kein link";
  t.win._attachDriveByLink("project", "prj_1");
  eq(entity.files.length, 0, "aus einer Nicht-Adresse entstand eine Verknüpfung");

  // Zweimal dieselbe Datei: nur einmal.
  t.felder.get("drvLinkId").value = ID;
  t.win._attachDriveByLink("project", "prj_1");
  t.win._attachDriveByLink("project", "prj_1");
  eq(entity.files.length, 1, "dieselbe Drive-Datei wurde zweimal verknüpft");
  ok(/bereits verknüpft/.test(t.hinweis()), "die Doppelung wird nicht erklärt");
  // Ohne Namen bekommt sie einen brauchbaren.
  ok(/^Drive-Datei /.test(entity.files[0].name), "ohne Namen bleibt der Eintrag namenlos");
}

/* ══ 4. Indexieren über den vorhandenen Proxy ═════════════════════════════ */
{
  const reindex = schnitt("window._reindexFile = async function(kind, entityId, fileId) {",
    "// Wrapper der nach Upload aufgerufen wird", "die Indexierung");
  ok(/download-proxy\?url=/.test(reindex),
    "die Indexierung kennt den vorhandenen Download-Proxy nicht — eine verknüpfte Drive-Datei bliebe unlesbar");
  ok(/encodeURIComponent\(fileObj\.url\)/.test(reindex), "die Adresse wird nicht sauber übergeben");
  // Eine Anmeldeseite ist kein Dokument — und das wird gesagt, nicht verschwiegen.
  ok(/Anmeldeseite/.test(reindex), "eine private Datei wird stillschweigend als leer behandelt");
  /* Die Meldung ist eine FESTSTELLUNG, keine Empfehlung. Sie lautete zuerst
     „In Drive ‚Jeder mit dem Link‘ erlauben" — das ist ein Rat, Zugriffsrechte
     zu lockern, damit eine Indexierung bequemer wird. Solche Entscheidungen
     trifft niemand nebenbei, und schon gar nicht auf Zuruf der Oberflaeche. */
  ok(/privat in Google Drive/.test(reindex), "es wird nicht gesagt, woran es liegt");
  ok(!/Jeder mit dem Link/.test(reindex),
    "die Meldung empfiehlt weiterhin, die Datei öffentlich freizugeben");
  ok(!/erlauben|freigeben|freigebe/.test(reindex),
    "die Meldung rät weiterhin zu einer Rechteänderung");
  ok(/Verknüpfung bleibt bestehen/.test(reindex),
    "es wird nicht gesagt, dass die Verknüpfung erhalten bleibt");
  // Die bisherigen zwei Strategien bleiben, der Proxy kommt danach.
  ok(reindex.indexOf("Strategie 1") < reindex.indexOf("download-proxy")
    && reindex.indexOf("XHR") < reindex.indexOf("download-proxy"),
    "der Proxy drängt sich vor die bisherigen Wege");
  // Und der Proxy selbst schützt weiterhin vor internen Zielen.
  const proxy = fs.readFileSync(path.join(root, "netlify/functions/download-proxy.mjs"), "utf8");
  ok(/isBlockedTarget/.test(proxy) && /127\\\./.test(proxy),
    "der Download-Proxy schützt nicht mehr vor internen Adressen");
}

/* ══ 5. Sichtbar als Verknüpfung, nicht als Kopie ═════════════════════════ */
{
  ok(/🔗 Drive/.test(index), "eine verknüpfte Datei ist in der Liste nicht als solche erkennbar");
  ok(/verknüpft aus Google Drive, nicht kopiert/.test(index),
    "es steht nirgends, dass nichts kopiert wurde");
  const dialog = schnitt("window._attachFromDrive = async function(kind, entityId){",
    "window._driveIdAus", "der Drive-Dialog");
  ok(/drvLinkId/.test(dialog), "im Dialog fehlt das Feld für Adresse oder Id");
  ok(/nichts wird kopiert oder erneut hochgeladen/.test(dialog),
    "der Dialog sagt nicht, dass nichts kopiert wird");
}

console.log(`drive verknuepfen: ok (${checks} Pruefungen)`);
