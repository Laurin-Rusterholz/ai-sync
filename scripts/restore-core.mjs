#!/usr/bin/env node
// ============================================================================
//  QUANTUS CORE-RESTORE — den Kerndatensatz bewusst wiederherstellen
//  ---------------------------------------------------------------------------
//  node scripts/restore-core.mjs --from <backup.json> --i-know-what-i-am-doing
//
//  WARUM ES DIESES SKRIPT GIBT
//  Seit dem endgueltigen Kernvertrag (2026-08-25) kennt der Kerndatensatz genau
//  EINE Schreibform: mit gueltigem If-Match. Es gibt keine Erstanlage per
//  Kopfzeile mehr — kein If-None-Match, auf keinem Pfad. Ein fehlendes
//  Kerndokument entsteht ueber den normalen Schreibweg NIE.
//
//  Das ist Absicht: eine Erstanlage per Header ist von aussen ausloesbar und
//  hinterlaesst keine Spur. Ein Kern-Restore ist dagegen ein bewusster,
//  auditierter Eingriff — und genau das ist dieses Skript.
//
//  WAS ES NICHT IST
//  Kein HTTP-Endpunkt. Keine Netlify-Function. Kein Header-Trick. Es laeuft
//  ausschliesslich lokal, mit dem Dienstkonto aus der Umgebung, und schreibt
//  DIREKT in die RTDB — an blob-put und seiner Politik vorbei, weil es der
//  einzige Weg sein soll, der einen Menschen vor die Entscheidung stellt.
//
//  ABLAUF
//    1. Backup-Datei lesen und pruefen
//    2. aktuellen Serverstand lesen
//    3. Unterschiede zusammenfassen: Wurzelfelder und Entitaetszahlen
//    4. interaktiv bestaetigen lassen (Eingabe des Schluesselnamens)
//    5. direkt in die RTDB schreiben
//    6. Protokoll nach work/forensics/restore-log/ schreiben
//
//  Ohne --i-know-what-i-am-doing passiert NICHTS. Ohne Bestaetigung ebenso.
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export const RESTORE_FLAG = "--i-know-what-i-am-doing";
export const CORE_KEY = "app-data.json";
export const LOG_DIR = "work/forensics/restore-log";

export function parseArgs(argv) {
  const args = { from: null, key: CORE_KEY, confirmed: false, help: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i] || null;
    else if (a === "--key") args.key = argv[++i] || args.key;
    else if (a === RESTORE_FLAG) args.confirmed = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

/*
 * Prueft, ob ueberhaupt losgelegt werden darf. Gibt { ok, grund } zurueck statt
 * zu werfen, damit der Test das ohne Seiteneffekte pruefen kann.
 */
export function pruefeArgumente(args) {
  if (args.help) return { ok: false, grund: "help" };
  if (!args.from) return { ok: false, grund: "kein --from <backup.json> angegeben" };
  if (!args.confirmed) {
    return { ok: false, grund: `ohne ${RESTORE_FLAG} passiert nichts — ein Kern-Restore ueberschreibt den gesamten Datenstand` };
  }
  if (args.key !== CORE_KEY) {
    return { ok: false, grund: `dieses Skript stellt ausschliesslich "${CORE_KEY}" wieder her` };
  }
  return { ok: true };
}

/*
 * Zaehlt Entitaeten je Sammlung. Reine Funktion — der Test kann sie direkt
 * pruefen, ohne irgendetwas zu lesen oder zu schreiben.
 */
export function entitaetsZahlen(daten) {
  const out = {};
  const e = (daten && daten.entities) || {};
  for (const [name, karte] of Object.entries(e)) {
    if (karte && typeof karte === "object" && !Array.isArray(karte)) out[name] = Object.keys(karte).length;
  }
  return out;
}

/*
 * Fasst die Unterschiede zusammen: welche Wurzelfelder dazukommen, welche
 * verschwinden, und wie sich die Entitaetszahlen aendern. Das ist die
 * Entscheidungsgrundlage, die dem Menschen vorgelegt wird.
 */
export function diffZusammenfassung(aktuell, backup) {
  const wurzelA = new Set(Object.keys(aktuell || {}));
  const wurzelB = new Set(Object.keys(backup || {}));
  const nurAktuell = [...wurzelA].filter((k) => !wurzelB.has(k)).sort();
  const nurBackup = [...wurzelB].filter((k) => !wurzelA.has(k)).sort();

  const zA = entitaetsZahlen(aktuell);
  const zB = entitaetsZahlen(backup);
  const sammlungen = [...new Set([...Object.keys(zA), ...Object.keys(zB)])].sort();
  const entitaeten = sammlungen.map((n) => ({
    sammlung: n, aktuell: zA[n] || 0, backup: zB[n] || 0, delta: (zB[n] || 0) - (zA[n] || 0),
  }));
  const verlust = entitaeten.filter((z) => z.delta < 0);
  return {
    wurzelfelder: { nurAktuell, nurBackup, aktuell: wurzelA.size, backup: wurzelB.size },
    entitaeten,
    summeAktuell: entitaeten.reduce((s, z) => s + z.aktuell, 0),
    summeBackup: entitaeten.reduce((s, z) => s + z.backup, 0),
    verlust,
  };
}

export function formatiereZusammenfassung(d, key) {
  const z = [];
  z.push(`Kerndatensatz: ${key}`);
  z.push(`Wurzelfelder: aktuell ${d.wurzelfelder.aktuell}, im Backup ${d.wurzelfelder.backup}`);
  if (d.wurzelfelder.nurAktuell.length) z.push(`  GEHEN VERLOREN: ${d.wurzelfelder.nurAktuell.join(", ")}`);
  if (d.wurzelfelder.nurBackup.length) z.push(`  kommen dazu:    ${d.wurzelfelder.nurBackup.join(", ")}`);
  z.push(`Entitaeten: aktuell ${d.summeAktuell}, im Backup ${d.summeBackup}`);
  for (const e of d.entitaeten) {
    if (e.delta !== 0) {
      z.push(`  ${e.sammlung.padEnd(22)} ${String(e.aktuell).padStart(5)} -> ${String(e.backup).padStart(5)}  (${e.delta > 0 ? "+" : ""}${e.delta})`);
    }
  }
  if (d.verlust.length) {
    z.push("");
    z.push(`ACHTUNG: ${d.verlust.length} Sammlung(en) verlieren Eintraege.`);
  }
  return z.join("\n");
}

export function protokollName(key, date) {
  const stamp = (date || new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${String(key).replace(/[^a-z0-9._-]/gi, "_")}.${stamp}.restore.json`;
}

async function frage(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(text, (a) => { rl.close(); r(String(a || "").trim()); }));
}

// ── Ab hier nur noch der ausfuehrende Teil ──────────────────────────────
const istMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (istMain) {
  const args = parseArgs(process.argv.slice(2));
  const pruefung = pruefeArgumente(args);
  if (!pruefung.ok) {
    if (pruefung.grund === "help") {
      console.log(`Verwendung:\n  node scripts/restore-core.mjs --from <backup.json> ${RESTORE_FLAG}\n\n` +
        `  --from <datei>   Backup aus scripts/backup-blob.mjs\n` +
        `  --dry-run        nur die Zusammenfassung zeigen, nichts schreiben\n` +
        `  ${RESTORE_FLAG}\n                   Pflicht. Ohne diese Angabe passiert nichts.\n`);
      process.exit(0);
    }
    console.error("Abbruch: " + pruefung.grund);
    process.exit(2);
  }

  const roh = JSON.parse(await readFile(args.from, "utf8"));
  const backupDaten = roh && roh.data ? roh.data : roh;
  if (!backupDaten || typeof backupDaten !== "object" || !backupDaten.entities) {
    console.error("Abbruch: die Backup-Datei enthaelt keinen brauchbaren Datenstand (entities fehlt).");
    process.exit(2);
  }

  // Der Zugriff kommt aus derselben Bibliothek wie die Functions — dasselbe
  // Dienstkonto, aber lokal ausgefuehrt und ohne HTTP-Fassade.
  const admin = await import("../netlify/lib/firebase-admin.mjs");
  const aktuellDoc = await admin.readAppDataDocument(args.key);
  const aktuellDaten = (aktuellDoc && aktuellDoc.data) || {};

  const d = diffZusammenfassung(aktuellDaten, backupDaten);
  console.log("");
  console.log(formatiereZusammenfassung(d, args.key));
  console.log("");

  if (args.dryRun) {
    console.log("--dry-run: es wurde NICHTS geschrieben.");
    process.exit(0);
  }

  const antwort = await frage(`Zum Bestaetigen den Schluesselnamen eintippen ("${args.key}"): `);
  if (antwort !== args.key) {
    console.error("Abbruch: nicht bestaetigt.");
    process.exit(3);
  }

  const text = JSON.stringify(backupDaten);
  const wrap = {
    data: text,
    etag: admin.jsonEtag(text),
    updatedAt: backupDaten?.meta?.updatedAt || new Date().toISOString(),
    savedAt: Date.now(),
    savedBy: "restore-core-script",
  };
  const pfad = "appStore/" + admin.firebaseNodeKey(args.key);
  const ergebnis = await admin.firebaseDbSet(pfad, wrap);

  await mkdir(LOG_DIR, { recursive: true });
  const protokoll = {
    zeitpunkt: new Date().toISOString(),
    key: args.key,
    pfad,
    quelle: path.resolve(args.from),
    bestaetigt: true,
    ok: !!(ergebnis && ergebnis.ok),
    zusammenfassung: d,
  };
  const ziel = path.join(LOG_DIR, protokollName(args.key, new Date()));
  await writeFile(ziel, JSON.stringify(protokoll, null, 2), "utf8");
  console.log((protokoll.ok ? "Wiederhergestellt." : "FEHLGESCHLAGEN.") + " Protokoll: " + ziel);
  process.exit(protokoll.ok ? 0 : 1);
}
