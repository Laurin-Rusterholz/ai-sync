/*
 * F-25 M2b — der Restore-Pfad, Datenvertrag und Audit-Reihenfolge.
 *
 * BEFUND M2a: das Skript las aktuellDoc.data und behandelte es als Objekt.
 * readAppDataDocument liefert aber { exists, data, parsed, etag, wrap } — data
 * ist der JSON-TEXT, parsed das Objekt. Entitaetszahlen auf einem String ergeben
 * NULL. Die Zusammenfassung zeigte dem Operator einen leeren Ist-Stand: es sah
 * aus, als gaebe es nichts zu verlieren. Genau vor dieser Anzeige soll er
 * entscheiden.
 *
 * Drei Lagen muessen auseinandergehalten werden:
 *   vorhanden  Normalfall
 *   fehlt      Katastrophenfall — ausdruecklich als "KEIN Core-Dokument
 *              vorhanden" anzeigen, nicht als 0 Entitaeten
 *   unlesbar   data da, parsed null — HARTER ABBRUCH. Ein Stand, dessen Inhalt
 *              niemand kennt, darf nicht ueberschrieben werden.
 *
 * Dazu die Audit-Reihenfolge: Intent VOR Aktion. Ein Restore ohne persistierten
 * Intent darf technisch nicht moeglich sein.
 *
 * Kein Test schreibt in die RTDB, und keiner fasst den Produktiv-Core an.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../scripts/restore-core.mjs";
import { readAppDataDocument, jsonEtag, firebaseNodeKey } from "../netlify/lib/firebase-admin.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skriptSrc = fs.readFileSync(path.join(root, "scripts/restore-core.mjs"), "utf8");
const adminSrc = fs.readFileSync(path.join(root, "netlify/lib/firebase-admin.mjs"), "utf8");
let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };
const ohneKommentare = (src) => src.replace(/^\s*\/\/.*$/gm, "");

const KERN_DATEN = {
  entities: { notes: { a: {}, b: {} }, tasks: { t: {} } },
  meta: { updatedAt: "2026-08-25T10:00:00.000Z" },
  journal: {},
};
const BACKUP_DATEN = {
  entities: { notes: { a: {}, b: {}, c: {} }, tasks: {} },
  meta: { updatedAt: "2026-08-24T09:00:00.000Z" },
  weekPlan: {},
};

// ── 1. CALLER-CONTRACT: gegen das ECHTE Resultatformat ─────────────────
{
  // Das Format wird aus der ECHTEN readAppDataDocument gewonnen, nicht von Hand
  // gebaut: der Transport wird ersetzt, die Funktion selbst laeuft.
  const a = adminSrc.indexOf("export async function readAppDataDocument(");
  const koerper = adminSrc.slice(a, adminSrc.indexOf("\n}\n", a) + 3).replace("export async function", "async function");
  const u = adminSrc.indexOf("function unwrapData(value) {");
  const unwrap = adminSrc.slice(u, adminSrc.indexOf("\n}\n", u) + 3);
  const echteLese = (wrap) => new Function("firebaseDbGetWithEtag", "appStorePath", "jsonEtag", "JSON",
    unwrap + "\n" + koerper + "\nreturn readAppDataDocument;")(
    async () => ({ exists: wrap !== null, value: wrap, serverEtag: "srv" }),
    (k) => "appStore/" + firebaseNodeKey(k), jsonEtag, JSON);

  ok(typeof readAppDataDocument === "function", "readAppDataDocument ist nicht importierbar");

  // vorhanden
  const text = JSON.stringify(KERN_DATEN);
  const doc = await echteLese({ data: text, etag: "e1" })("app-data.json");
  ok(typeof doc.data === "string", `readAppDataDocument liefert data als ${typeof doc.data} — der Vertrag hat sich geaendert`);
  ok(doc.parsed && typeof doc.parsed === "object", "readAppDataDocument liefert parsed nicht als Objekt");

  const b = R.bewerteAktuellenStand(doc);
  ok(b.art === "vorhanden", `der echte Lesestand wird als "${b.art}" bewertet`);
  const d = R.diffZusammenfassung(b, BACKUP_DATEN, {});
  ok(d.summeAktuell === 3,
    `DER BEFUND: die Zusammenfassung zeigt ${d.summeAktuell} statt 3 Entitaeten — ` +
    "aktuellDoc.data ist der JSON-TEXT, nicht das Objekt; der Operator saehe einen leeren Ist-Stand");
  ok(d.summeBackup === 3, `Backup-Summe ${d.summeBackup} statt 3`);
  ok(d.wurzelfelder.nurAktuell.join() === "journal", "verlorene Wurzelfelder werden nicht erkannt");
  ok(d.wurzelfelder.nurBackup.join() === "weekPlan", "hinzukommende Wurzelfelder werden nicht erkannt");
  ok(d.updatedAt.aktuell === KERN_DATEN.meta.updatedAt, "updatedAt des Ist-Standes fehlt");

  // fehlt
  const leer = await echteLese(null)("app-data.json");
  ok(leer.exists === false && leer.data === null, "das echte Format meldet ein fehlendes Dokument anders");
  ok(R.bewerteAktuellenStand(leer).art === "fehlt", "ein fehlendes Dokument wird nicht als fehlend bewertet");

  // unlesbar: data da, parsed null
  const kaputt = await echteLese({ data: "{kaputt", etag: "e2" })("app-data.json");
  ok(kaputt.exists === true && kaputt.data != null && kaputt.parsed === null,
    "das echte Format liefert bei kaputtem Inhalt nicht mehr data ohne parsed");
  ok(R.bewerteAktuellenStand(kaputt).art === "unlesbar", "ein unlesbarer Stand wird nicht als solcher erkannt");
}

// ── 2. Anzeige der drei Lagen ──────────────────────────────────────────
{
  const fehlt = R.diffZusammenfassung(R.bewerteAktuellenStand(null), BACKUP_DATEN, {});
  const t = R.formatiereZusammenfassung(fehlt, "app-data.json");
  ok(/aktuell: KEIN Core-Dokument vorhanden/.test(t),
    `ein fehlender Core wird nicht ausdruecklich angezeigt:\n${t}`);
  ok(!/Wurzelfelder: aktuell 0/.test(t),
    "ein fehlender Core wird als 0-Entities-Objekt gezeigt statt als fehlend");

  const da = R.diffZusammenfassung(
    R.bewerteAktuellenStand({ exists: true, data: JSON.stringify(KERN_DATEN), parsed: KERN_DATEN, etag: "e1" }),
    BACKUP_DATEN, { updatedAt: BACKUP_DATEN.meta.updatedAt });
  const t2 = R.formatiereZusammenfassung(da, "app-data.json");
  ok(/GEHEN VERLOREN: journal/.test(t2), "verlorene Wurzelfelder werden nicht genannt");
  ok(/ACHTUNG/.test(t2), "der Verlust in tasks wird nicht als Warnung gezeigt");
  ok(/updatedAt: aktuell 2026-08-25.*im Backup 2026-08-24/.test(t2),
    `beide updatedAt fehlen in der Anzeige:\n${t2}`);
}

// ── 3. Backup-Validierung VOR jeder Anzeige ────────────────────────────
{
  const gut = { tool: "backup-blob", key: "app-data.json", etag: "e", savedAt: "x", data: BACKUP_DATEN };
  ok(R.pruefeBackup(gut, "app-data.json").ok === true, "ein gueltiges Backup wird abgelehnt");
  ok(R.pruefeBackup({ ...gut, data: JSON.stringify(BACKUP_DATEN) }, "app-data.json").ok === true,
    "ein Backup mit data als JSON-TEXT wird abgelehnt — beide Formen muessen gehen");

  const schlecht = [
    [null, "null"],
    [[], "Array"],
    [{ key: "app-data.json" }, "Wrapper ohne data"],
    [{ key: "recalllab-mobile.json", data: BACKUP_DATEN }, "falscher Key"],
    [{ key: "app-data.json", data: "{kaputt" }, "malformed data-JSON"],
    [{ key: "app-data.json", data: 42 }, "data ist kein Objekt"],
    [{ key: "app-data.json", data: { meta: {} } }, "entities fehlt"],
    [{ key: "app-data.json", data: { entities: [] } }, "entities ist ein Array"],
    [{ key: "app-data.json", data: { entities: {} } }, "nur ein Wurzelfeld"],
  ];
  for (const [roh, was] of schlecht) {
    const r = R.pruefeBackup(roh, "app-data.json");
    ok(r.ok === false, `${was}: wurde akzeptiert`);
    ok(typeof r.grund === "string" && r.grund.length > 10, `${was}: kein brauchbarer Grund`);
  }
}

// ── Ein Lauf von fuehreRestoreAus, komplett injiziert ──────────────────
async function lauf({ backup, doc, bestaetigung = "app-data.json", dryRun = false,
  writeErgebnis = { ok: true }, writeWirft = null, logDirOk = true, logDir = null } = {}) {
  const spurFs = [];
  const dateien = new Map();
  const tmp = logDir || fs.mkdtempSync(path.join(os.tmpdir(), "restore-log-"));
  const fsApi = {
    mkdir: async (d, o) => { spurFs.push("mkdir:" + d); if (!logDirOk) throw new Error("EACCES"); return fsp.mkdir(d, o); },
    open: async (datei, modus) => {
      spurFs.push("open:" + path.basename(datei));
      if (!logDirOk) throw new Error("EACCES");
      const fh = await fsp.open(datei, modus);
      return {
        writeFile: async (t) => { dateien.set(datei, t); spurFs.push("write:" + path.basename(datei)); return fh.writeFile(t, "utf8"); },
        sync: async () => { spurFs.push("fsync:" + path.basename(datei)); return fh.sync(); },
        close: async () => fh.close(),
      };
    },
    unlink: async (d) => { spurFs.push("unlink:" + path.basename(d)); return fsp.unlink(d); },
  };
  const writes = [];
  const ergebnis = await R.fuehreRestoreAus(
    { from: "backup.json", key: "app-data.json", confirmed: true, dryRun, help: false },
    {
      readFile: async () => JSON.stringify(backup),
      readAppDataDocument: async () => doc,
      firebaseDbSet: async (p, w) => {
        spurFs.push("RTDB-WRITE");
        writes.push({ pfad: p, wrap: w });
        if (writeWirft) throw new Error(writeWirft);
        return writeErgebnis;
      },
      firebaseNodeKey, jsonEtag,
      fsApi, logDir: tmp,
      frage: async () => bestaetigung,
      zeige: () => { spurFs.push("ANZEIGE"); },
      log: () => {},
    });
  return { ergebnis, spurFs, writes, dateien, tmp };
}

const GUTES_BACKUP = { tool: "backup-blob", key: "app-data.json", etag: "be", savedAt: "s", data: BACKUP_DATEN };
const DOC_DA = { exists: true, data: JSON.stringify(KERN_DATEN), parsed: KERN_DATEN, etag: "e1" };
const DOC_FEHLT = { exists: false, data: null, parsed: null, etag: null };
const DOC_KAPUTT = { exists: true, data: "{kaputt", parsed: null, etag: "e2" };

// ── 4. Unlesbarer Ist-Stand: harter Abbruch, keine Anzeige, kein Write ──
{
  const l = await lauf({ backup: GUTES_BACKUP, doc: DOC_KAPUTT });
  ok(l.ergebnis.ok === false && l.ergebnis.schritt === "ist-stand",
    `unlesbarer Core: Abbruch bei "${l.ergebnis.schritt}"`);
  ok(/aktueller Core unlesbar — Restore verweigert, manuell pruefen/.test(l.ergebnis.grund || ""),
    `die Meldung lautet "${l.ergebnis.grund}"`);
  ok(!l.spurFs.includes("RTDB-WRITE"), "unlesbarer Core: es wurde geschrieben");
  ok(!l.spurFs.includes("ANZEIGE"), "unlesbarer Core: es wurde trotzdem eine Zusammenfassung gezeigt");
}

// ── 5. Fehlender Core: laeuft, aber ausdruecklich benannt ──────────────
{
  const l = await lauf({ backup: GUTES_BACKUP, doc: DOC_FEHLT });
  ok(l.ergebnis.ok === true && l.ergebnis.geschrieben === true,
    `fehlender Core: ${l.ergebnis.schritt} / ${l.ergebnis.grund || ""}`);
  ok(l.ergebnis.zusammenfassung.art === "fehlt", "der fehlende Core wird nicht als solcher gefuehrt");
  ok(l.ergebnis.zusammenfassung.summeAktuell === 0 && l.ergebnis.zusammenfassung.summeBackup === 3,
    "die Zahlen des Katastrophenfalls stimmen nicht");
}

// ── 6. Kaputtes Backup: Abbruch VOR Anzeige und vor jeder Aktion ───────
for (const [backup, was] of [
  [{ key: "recalllab-mobile.json", data: BACKUP_DATEN }, "falscher Key"],
  [{ key: "app-data.json", data: "{kaputt" }, "malformed data"],
  [{ key: "app-data.json", data: { meta: {} } }, "entities fehlt"],
  [{ key: "app-data.json" }, "kein data"],
]) {
  const l = await lauf({ backup, doc: DOC_DA });
  ok(l.ergebnis.ok === false && l.ergebnis.schritt === "backup",
    `${was}: Abbruch bei "${l.ergebnis.schritt}" statt bei backup`);
  ok(!l.spurFs.includes("ANZEIGE"), `${was}: es wurde eine Zusammenfassung gezeigt`);
  ok(!l.spurFs.includes("RTDB-WRITE"), `${was}: es wurde geschrieben`);
  ok(!l.spurFs.some((s) => s.startsWith("mkdir")), `${was}: der Preflight lief trotz kaputtem Backup`);
}

// ── 7. AUDIT-REIHENFOLGE ───────────────────────────────────────────────
{
  const l = await lauf({ backup: GUTES_BACKUP, doc: DOC_DA });
  const s = l.spurFs;
  const i = (t) => s.findIndex((x) => x === t || x.startsWith(t));
  ok(l.ergebnis.ok === true, `Normallauf: ${l.ergebnis.grund || ""}`);

  // a) Preflight vor der Anzeige und vor der Frage
  ok(i("mkdir") >= 0, "der Preflight legt das Protokollverzeichnis nicht an");
  ok(i("mkdir") < i("ANZEIGE"), "der Preflight laeuft NACH der Anzeige");
  ok(s.some((x) => x.startsWith("open:.schreibprobe")), "die Schreibbarkeit wird nicht per Probedatei bewiesen");
  ok(s.some((x) => x.startsWith("fsync:.schreibprobe")), "die Probedatei wird nicht gefsynct");
  ok(s.some((x) => x.startsWith("unlink:.schreibprobe")), "die Probedatei wird nicht aufgeraeumt");
  ok(!fs.readdirSync(l.tmp).some((f) => f.startsWith(".schreibprobe")),
    "die Probedatei liegt noch im Protokollverzeichnis");

  // b/c) Intent geschrieben UND gefsynct, beides vor dem Write
  const intentDatei = [...l.dateien.keys()].find((k) => k.endsWith(".restore.json"));
  ok(!!intentDatei, "es wurde kein Protokoll geschrieben");
  const iIntentWrite = s.findIndex((x) => x === "write:" + path.basename(intentDatei));
  const iIntentSync = s.findIndex((x) => x === "fsync:" + path.basename(intentDatei));
  const iWrite = s.indexOf("RTDB-WRITE");
  ok(iIntentWrite >= 0 && iIntentWrite < iWrite, "der Intent wird nicht VOR dem RTDB-Write geschrieben");
  ok(iIntentSync >= 0 && iIntentSync < iWrite,
    `der RTDB-Write laeuft vor dem fsync des Intents (fsync@${iIntentSync}, write@${iWrite})`);
  // Die Bestaetigung steht zwischen Anzeige und Intent.
  ok(i("ANZEIGE") < iIntentWrite, "der Intent wird vor der Anzeige geschrieben");

  // d) Nach dem Write wird derselbe Eintrag aktualisiert und gefsynct
  const nachWrite = s.slice(iWrite);
  ok(nachWrite.includes("write:" + path.basename(intentDatei)), "der Intent wird nach dem Write nicht aktualisiert");
  ok(nachWrite.includes("fsync:" + path.basename(intentDatei)), "die Aktualisierung wird nicht gefsynct");

  const inhalt = JSON.parse(fs.readFileSync(intentDatei, "utf8"));
  ok(inhalt.status === "erfolgreich", `der Endstatus lautet "${inhalt.status}"`);
  ok(typeof inhalt.zeitpunktIntent === "string" && typeof inhalt.zeitpunktErgebnis === "string",
    "beide Zeitstempel fehlen im Protokoll");
  ok(inhalt.backupSha256 === R.sha256(JSON.stringify(GUTES_BACKUP)),
    "der SHA der Backup-Datei stimmt nicht");
  ok(inhalt.quelle && /backup\.json$/.test(inhalt.quelle), "die Backup-Datei ist nicht vermerkt");
  ok(inhalt.operatorBestaetigung === "app-data.json", "die Operator-Bestaetigung fehlt");
  ok(inhalt.vorher && inhalt.vorher.summeAktuell === 3, "die Vorher-Zusammenfassung fehlt oder ist leer");
  ok(inhalt.ergebnis && inhalt.ergebnis.etagNachher, "der Nachher-ETag fehlt");
  ok(inhalt.ergebnis.updatedAtNachher, "der Nachher-Zeitstempel fehlt");
  fs.rmSync(l.tmp, { recursive: true, force: true });
}

// ── 8. Preflight schlaegt fehl: Abbruch VOR der Bestaetigungsfrage ─────
{
  let gefragt = false;
  const l = await R.fuehreRestoreAus(
    { from: "b.json", key: "app-data.json", confirmed: true, dryRun: false, help: false },
    {
      readFile: async () => JSON.stringify(GUTES_BACKUP),
      readAppDataDocument: async () => DOC_DA,
      firebaseDbSet: async () => { throw new Error("darf nicht laufen"); },
      firebaseNodeKey, jsonEtag,
      fsApi: { mkdir: async () => { throw new Error("EACCES"); }, open: async () => { throw new Error("EACCES"); }, unlink: async () => {} },
      logDir: "/nicht/beschreibbar",
      frage: async () => { gefragt = true; return "app-data.json"; },
      zeige: () => {}, log: () => {},
    });
  ok(l.ok === false && l.schritt === "preflight", `Preflight-Fehler: Abbruch bei "${l.schritt}"`);
  ok(gefragt === false, "der Operator wurde trotz nicht beschreibbarem Protokollverzeichnis gefragt");
}

// ── 9. Nicht bestaetigt: kein Intent, kein Write ───────────────────────
{
  const l = await lauf({ backup: GUTES_BACKUP, doc: DOC_DA, bestaetigung: "nein" });
  ok(l.ergebnis.ok === false && l.ergebnis.schritt === "bestaetigung", "die Bestaetigung wird nicht verlangt");
  ok(!l.spurFs.includes("RTDB-WRITE"), "ohne Bestaetigung wurde geschrieben");
  ok(![...l.dateien.keys()].some((k) => k.endsWith(".restore.json")), "ohne Bestaetigung entstand ein Intent");
  fs.rmSync(l.tmp, { recursive: true, force: true });
}

// ── 10. Dry-Run: Anzeige, aber kein Intent und kein Write ──────────────
{
  const l = await lauf({ backup: GUTES_BACKUP, doc: DOC_DA, dryRun: true });
  ok(l.ergebnis.ok === true && l.ergebnis.geschrieben === false, "der Dry-Run schrieb");
  ok(l.spurFs.includes("ANZEIGE"), "der Dry-Run zeigt keine Zusammenfassung");
  ok(!l.spurFs.includes("RTDB-WRITE"), "der Dry-Run schrieb in die RTDB");
  ok(![...l.dateien.keys()].some((k) => k.endsWith(".restore.json")), "der Dry-Run schrieb ein Protokoll");
  fs.rmSync(l.tmp, { recursive: true, force: true });
}

// ── 11. Schreibfehler landet im BESTEHENDEN Intent ─────────────────────
{
  // (a) Der Server meldet ok:false
  const l1 = await lauf({ backup: GUTES_BACKUP, doc: DOC_DA, writeErgebnis: { ok: false } });
  const d1 = [...l1.dateien.keys()].find((k) => k.endsWith(".restore.json"));
  const i1 = JSON.parse(fs.readFileSync(d1, "utf8"));
  ok(l1.ergebnis.ok === false, "ein fehlgeschlagener Write wird als Erfolg gemeldet");
  ok(i1.status === "fehlgeschlagen", `der Status lautet "${i1.status}"`);
  fs.rmSync(l1.tmp, { recursive: true, force: true });

  // (b) Der Write WIRFT — der Fehler wird protokolliert und weitergereicht
  let geworfen = null;
  let l2 = null;
  try {
    l2 = await lauf({ backup: GUTES_BACKUP, doc: DOC_DA, writeWirft: "Netz weg" });
  } catch (e) { geworfen = e; }
  ok(!!geworfen, "ein geworfener Schreibfehler wird verschluckt statt weitergereicht");
  ok(/Netz weg/.test(geworfen?.message || ""), "der weitergereichte Fehler ist ein anderer");
  // Das Protokoll liegt trotzdem — mit dem Fehler.
  const logDirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("restore-log-"));
  let gefunden = false;
  for (const d of logDirs) {
    const voll = path.join(os.tmpdir(), d);
    for (const f of fs.readdirSync(voll)) {
      if (!f.endsWith(".restore.json")) continue;
      const j = JSON.parse(fs.readFileSync(path.join(voll, f), "utf8"));
      if (j.ergebnis && /Netz weg/.test(j.ergebnis.fehler || "")) gefunden = true;
    }
    fs.rmSync(voll, { recursive: true, force: true });
  }
  ok(gefunden, "der geworfene Schreibfehler steht nicht im Protokoll");
}

// ── 12. Quelltextregeln: kein Endpunkt, Intent vor Write ───────────────
{
  const code = ohneKommentare(skriptSrc);
  ok(!/export const config/.test(code) && !/Response\.json/.test(code),
    "das Skript sieht wie eine Netlify-Function aus");
  ok(!/blob-put|writeAppDataText/.test(code), "der Restore laeuft ueber die Fassade");
  ok(/RESTORE_FLAG = "--i-know-what-i-am-doing"/.test(code), "das Bestaetigungsflag fehlt");
  ok(/readline/.test(code), "es gibt keine interaktive Bestaetigung");
  ok(/firebaseDbSet\(/.test(code), "der Restore schreibt nicht direkt in die RTDB");
  ok(R.LOG_DIR.startsWith("work/"), `das Protokoll landet in "${R.LOG_DIR}" statt unter work/`);
  // Der Schreibaufruf steht HINTER dem Intent — nicht nur in der Absicht.
  const ablauf = code.slice(code.indexOf("export async function fuehreRestoreAus"));
  ok(ablauf.indexOf("schreibeIntent(") < ablauf.indexOf("deps.firebaseDbSet("),
    "der RTDB-Write steht im Quelltext VOR dem Intent");
  ok(ablauf.indexOf("preflightLogDir(") < ablauf.indexOf("deps.frage("),
    "der Preflight steht im Quelltext NACH der Bestaetigungsfrage");
  ok(ablauf.indexOf("pruefeBackup(") < ablauf.indexOf("preflightLogDir("),
    "die Backup-Pruefung steht NACH dem Preflight");
  ok(/await fh\.sync\(\)/.test(code), "es wird nirgends gefsynct");
  ok(!/aktuellDoc\.data\b(?!\s*==)/.test(code) || /doc\.parsed/.test(code),
    "das Skript liest weiterhin data als Objekt");
  ok(/doc\.parsed/.test(code), "das Skript wertet parsed nicht aus");
}

if (luecken.length) {
  console.error("F-25 RESTORE CORE CONTRACT — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`f25 restore core contract: ok (${checks} Pruefungen)`);
