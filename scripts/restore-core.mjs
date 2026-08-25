#!/usr/bin/env node
// ============================================================================
//  QUANTUS CORE-RESTORE — den Kerndatensatz bewusst wiederherstellen
//  ---------------------------------------------------------------------------
//  node scripts/restore-core.mjs --from <backup.json> --i-know-what-i-am-doing
//  node scripts/restore-core.mjs --from <backup.json> --dry-run
//
//  WARUM ES DIESES SKRIPT GIBT
//  Seit dem endgueltigen Kernvertrag (2026-08-25) kennt der Kerndatensatz genau
//  EINE Schreibform: mit gueltigem If-Match. Es gibt keine Erstanlage per
//  Kopfzeile mehr. Ein fehlendes Kerndokument entsteht ueber den normalen
//  Schreibweg NIE — weil eine Erstanlage per Header von aussen ausloesbar waere
//  und keine Spur hinterliesse.
//
//  Ein Kern-Restore ist dagegen ein bewusster, auditierter Eingriff: lokal, mit
//  Pflichtflag, mit Vorher-Zusammenfassung, mit Bestaetigung durch einen
//  Menschen — und mit einem Protokoll, das VOR dem Schreibvorgang auf der
//  Platte liegt.
//
//  WAS ES NICHT IST
//  Kein HTTP-Endpunkt. Keine Netlify-Function. Kein Header-Trick.
//
//  ABLAUF (die Reihenfolge ist der Punkt)
//    1. Argumente pruefen — ohne Pflichtflag passiert nichts
//    2. Backup-Datei lesen und VOLLSTAENDIG validieren
//    3. EXKLUSIV-LOCK erwerben — vor jedem Blick auf den Ist-Stand
//    4. aktuellen Serverstand lesen und BEWERTEN
//         vorhanden / fehlt / unlesbar — unlesbar ist ein harter Abbruch
//    5. Preflight: Protokollverzeichnis anlegen und Schreibbarkeit BEWEISEN
//    6. Zusammenfassung zeigen
//    7. interaktiv bestaetigen lassen
//    8. INTENT exklusiv anlegen und fsyncen — erst danach darf geschrieben werden
//    9. direkter RTDB-Write
//   10. Intent mit Ergebnis aktualisieren und fsyncen (auch bei einem Wurf)
//   11. Lock im finally freigeben
//
//  Ein Restore ohne persistierten Intent ist technisch nicht moeglich: der
//  Schreibaufruf steht hinter dem fsync des Intents.
// ============================================================================

import { readFile, mkdir, unlink, open } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";

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

export function pruefeArgumente(args) {
  if (args.help) return { ok: false, grund: "help" };
  if (!args.from) return { ok: false, grund: "kein --from <backup.json> angegeben" };
  if (!args.confirmed && !args.dryRun) {
    return { ok: false, grund: `ohne ${RESTORE_FLAG} passiert nichts — ein Kern-Restore ueberschreibt den gesamten Datenstand` };
  }
  if (args.key !== CORE_KEY) {
    return { ok: false, grund: `dieses Skript stellt ausschliesslich "${CORE_KEY}" wieder her` };
  }
  return { ok: true };
}

/*
 * Bewertet das Ergebnis von readAppDataDocument.
 *
 * Das Resultatformat ist { exists, data, parsed, etag, wrap } — data ist der
 * JSON-TEXT, parsed das Objekt. Wer data fuer ein Objekt haelt, zaehlt null
 * Entitaeten und zeigt dem Operator einen leeren Ist-Stand: die
 * Zusammenfassung sieht dann so aus, als gaebe es nichts zu verlieren.
 *
 * Drei Faelle, die auseinandergehalten werden MUESSEN:
 *   vorhanden  data und parsed da — der Normalfall
 *   fehlt      kein Dokument (Katastrophenfall). Wird ausdruecklich als
 *              "KEIN Core-Dokument vorhanden" gezeigt, nicht als 0 Entitaeten.
 *   unlesbar   data da, parsed null — der Stand existiert, laesst sich aber
 *              nicht parsen. NIEMALS als leer behandeln: dann wuerde ein
 *              Restore einen Stand ueberschreiben, dessen Inhalt niemand kennt.
 */
export function bewerteAktuellenStand(doc) {
  if (!doc || doc.exists !== true || doc.data == null) {
    return { art: "fehlt", daten: null, etag: null, updatedAt: null };
  }
  if (doc.parsed == null || typeof doc.parsed !== "object") {
    return {
      art: "unlesbar", daten: null, etag: doc.etag || null, updatedAt: null,
      bytes: typeof doc.data === "string" ? Buffer.byteLength(doc.data, "utf8") : null,
    };
  }
  return {
    art: "vorhanden", daten: doc.parsed, etag: doc.etag || null,
    updatedAt: doc.parsed?.meta?.updatedAt || null,
  };
}

/*
 * Validiert die Backup-Datei VOLLSTAENDIG, bevor irgendetwas angezeigt oder
 * getan wird. Gibt { ok, grund } zurueck statt zu werfen — der Test kann das
 * ohne Seiteneffekte pruefen.
 */
export const PROVENIENZ_TOOL = "backup-blob";
const PROVENIENZ_MELDUNG = "Backup-Provenienz nicht nachweisbar — Restore verweigert";
// Ein Vollexport aus der S0-Konsole ist KEIN gueltiger Input: er traegt weder
// tool noch key, also laesst sich nicht belegen, aus welchem Knoten er stammt.
// Wer so eine Datei hat, extrahiert sie zuerst ins backup-blob-Format
// ({ tool, key, etag, savedAt, data }). Ein Extraktionswerkzeug dafuer ist ein
// P2-Punkt und wird hier bewusst NICHT gebaut.
const PROVENIENZ_HINWEIS =
  "Ein S0-Konsolen-Vollexport ist kein gueltiger Input. Zuerst ins " +
  "backup-blob-Format extrahieren ({ tool: \"backup-blob\", key, etag, savedAt, data }); " +
  "ein Extraktionswerkzeug ist als P2 vorgemerkt.";

export function pruefeBackup(roh, key) {
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) {
    return { ok: false, grund: "die Backup-Datei enthaelt kein Objekt" };
  }
  // PROVENIENZ ZUERST: ohne Herkunftsnachweis wird gar nicht weitergeschaut.
  // tool und key sind PFLICHT und muessen exakt stimmen — ein fehlender key
  // ist keine Nachlaessigkeit, sondern ein fehlender Nachweis.
  if (roh.tool !== PROVENIENZ_TOOL) {
    return {
      ok: false,
      grund: `${PROVENIENZ_MELDUNG}: tool ist ${JSON.stringify(roh.tool)} statt "${PROVENIENZ_TOOL}". ${PROVENIENZ_HINWEIS}`,
    };
  }
  if (roh.key !== key) {
    return {
      ok: false,
      grund: `${PROVENIENZ_MELDUNG}: key ist ${JSON.stringify(roh.key)} statt "${key}". ${PROVENIENZ_HINWEIS}`,
    };
  }
  if (!("data" in roh)) {
    return { ok: false, grund: "Wrapper ohne data-Feld — stammt die Datei aus scripts/backup-blob.mjs?" };
  }
  let daten = roh.data;
  if (typeof daten === "string") {
    // Aeltere oder anders erzeugte Backups legen data als JSON-TEXT ab.
    try { daten = JSON.parse(daten); } catch (e) {
      return { ok: false, grund: "das eingebettete data-JSON laesst sich nicht parsen" };
    }
  }
  if (!daten || typeof daten !== "object" || Array.isArray(daten)) {
    return { ok: false, grund: "das eingebettete data ist kein Objekt" };
  }
  if (!daten.entities || typeof daten.entities !== "object" || Array.isArray(daten.entities)) {
    return { ok: false, grund: "im Backup fehlt entities — das ist kein Quantus-Datenstand" };
  }
  const wurzeln = Object.keys(daten).length;
  if (wurzeln < 2) {
    return { ok: false, grund: `nur ${wurzeln} Wurzelfeld(er) im Backup — das ist kein vollstaendiger Datenstand` };
  }
  return {
    ok: true, daten,
    meta: {
      key: roh.key,
      savedAt: roh.savedAt || null,
      etag: roh.etag || null,
      updatedAt: daten?.meta?.updatedAt || null,
      wurzeln,
    },
  };
}

export function entitaetsZahlen(daten) {
  const out = {};
  const e = (daten && daten.entities) || {};
  for (const [name, karte] of Object.entries(e)) {
    if (karte && typeof karte === "object" && !Array.isArray(karte)) out[name] = Object.keys(karte).length;
  }
  return out;
}

/*
 * Die Entscheidungsgrundlage fuer den Menschen. Nimmt die BEWERTUNG des
 * aktuellen Standes entgegen, nicht rohe Daten — damit "fehlt" und "unlesbar"
 * nicht als leerer Stand durchrutschen koennen.
 */
export function diffZusammenfassung(bewertung, backupDaten, backupMeta) {
  const aktuell = bewertung && bewertung.art === "vorhanden" ? bewertung.daten : null;
  const wurzelA = new Set(Object.keys(aktuell || {}));
  const wurzelB = new Set(Object.keys(backupDaten || {}));
  const nurAktuell = [...wurzelA].filter((k) => !wurzelB.has(k)).sort();
  const nurBackup = [...wurzelB].filter((k) => !wurzelA.has(k)).sort();

  const zA = entitaetsZahlen(aktuell);
  const zB = entitaetsZahlen(backupDaten);
  const sammlungen = [...new Set([...Object.keys(zA), ...Object.keys(zB)])].sort();
  const entitaeten = sammlungen.map((n) => ({
    sammlung: n, aktuell: zA[n] || 0, backup: zB[n] || 0, delta: (zB[n] || 0) - (zA[n] || 0),
  }));
  return {
    art: bewertung ? bewertung.art : "fehlt",
    wurzelfelder: { nurAktuell, nurBackup, aktuell: wurzelA.size, backup: wurzelB.size },
    entitaeten,
    summeAktuell: entitaeten.reduce((s, z) => s + z.aktuell, 0),
    summeBackup: entitaeten.reduce((s, z) => s + z.backup, 0),
    verlust: entitaeten.filter((z) => z.delta < 0),
    updatedAt: { aktuell: (bewertung && bewertung.updatedAt) || null, backup: (backupMeta && backupMeta.updatedAt) || null },
    etag: { aktuell: (bewertung && bewertung.etag) || null, backup: (backupMeta && backupMeta.etag) || null },
  };
}

export function formatiereZusammenfassung(d, key) {
  const z = [];
  z.push(`Kerndatensatz: ${key}`);
  if (d.art === "fehlt") {
    z.push("aktuell: KEIN Core-Dokument vorhanden");
  } else {
    z.push(`Wurzelfelder: aktuell ${d.wurzelfelder.aktuell}, im Backup ${d.wurzelfelder.backup}`);
    if (d.wurzelfelder.nurAktuell.length) z.push(`  GEHEN VERLOREN: ${d.wurzelfelder.nurAktuell.join(", ")}`);
    if (d.wurzelfelder.nurBackup.length) z.push(`  kommen dazu:    ${d.wurzelfelder.nurBackup.join(", ")}`);
  }
  z.push(`Entitaeten: aktuell ${d.summeAktuell}, im Backup ${d.summeBackup}`);
  for (const e of d.entitaeten) {
    if (e.delta !== 0) {
      z.push(`  ${e.sammlung.padEnd(22)} ${String(e.aktuell).padStart(5)} -> ${String(e.backup).padStart(5)}  (${e.delta > 0 ? "+" : ""}${e.delta})`);
    }
  }
  z.push(`updatedAt: aktuell ${d.updatedAt.aktuell || "—"}, im Backup ${d.updatedAt.backup || "—"}`);
  if (d.verlust.length) {
    z.push("");
    z.push(`ACHTUNG: ${d.verlust.length} Sammlung(en) verlieren Eintraege.`);
  }
  return z.join("\n");
}

// Der Name traegt den Zeitstempel MIT Millisekunden und eine kryptografische
// Nonce. Zwei Laeufe in derselben Millisekunde bekommen damit verschiedene
// Dateien — vorher schnitt der Name auf Sekunden, und zwei Restores im selben
// Moment haetten sich gegenseitig ueberschrieben. Genau das darf ein
// Auditprotokoll nicht koennen.
export function protokollName(key, date, nonce) {
  const stamp = (date || new Date()).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const n = nonce || randomBytes(6).toString("hex");
  return `${String(key).replace(/[^a-z0-9._-]/gi, "_")}.${stamp}.${n}.restore.json`;
}
export const INTENT_MAX_VERSUCHE = 8;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ── Audit: Preflight, Intent, Ergebnis ──────────────────────────────────
// fsync ist kein Detail. Ohne ihn liegt der Intent im Seitencache, und ein
// Absturz zwischen Write und Flush hinterliesse einen Restore ohne Spur.
async function schreibeUndSynce(datei, text, api, modus) {
  const fh = await api.open(datei, modus || "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/*
 * Beweist die Schreibbarkeit des Protokollverzeichnisses, BEVOR der Operator
 * gefragt wird. Ein Restore, dessen Protokoll hinterher nicht schreibbar ist,
 * waere ein unbelegter Eingriff — und dann steht der Knoten schon.
 */
export async function preflightLogDir(dir, api) {
  const probe = path.join(dir, ".schreibprobe-" + Date.now() + ".tmp");
  try {
    await api.mkdir(dir, { recursive: true });
    await schreibeUndSynce(probe, "probe", api);
    return { ok: true, probe };
  } catch (e) {
    return { ok: false, grund: `Protokollverzeichnis "${dir}" nicht beschreibbar: ${e.message}` };
  } finally {
    try { await api.unlink(probe); } catch (e) { /* Probedatei war nie da */ }
  }
}

export function baueIntent({ key, pfad, quelle, sha, zusammenfassung, bestaetigung, zeit }) {
  return {
    schema: "quantus-core-restore/1",
    status: "intent",
    zeitpunktIntent: (zeit || new Date()).toISOString(),
    key, pfad, quelle, backupSha256: sha,
    operatorBestaetigung: bestaetigung,
    vorher: zusammenfassung,
    zeitpunktErgebnis: null,
    ergebnis: null,
  };
}

/*
 * Legt den Intent EXKLUSIV an ("wx"). Existiert der Name schon, wird ein
 * frischer erzeugt und begrenzt erneut versucht — niemals ueberschrieben. Ein
 * Auditprotokoll, das ein anderes ueberschreiben kann, belegt nichts.
 * Gibt den tatsaechlich benutzten Pfad zurueck; nur DER wird spaeter
 * aktualisiert, und zwar aus dem Prozesszustand, nie rekonstruiert.
 */
export async function schreibeIntentExklusiv(dir, key, intent, api, zeit) {
  let letzter = null;
  for (let versuch = 0; versuch < INTENT_MAX_VERSUCHE; versuch++) {
    const nonce = randomBytes(6).toString("hex");
    const datei = path.join(dir, protokollName(key, zeit || new Date(), nonce));
    try {
      await schreibeUndSynce(datei, JSON.stringify({ ...intent, nonce }, null, 2), api, "wx");
      return { ok: true, datei, nonce };
    } catch (e) {
      letzter = e;
      if (e && e.code === "EEXIST") continue;   // Name belegt -> neuer Name
      throw e;                                   // alles andere ist ein echter Fehler
    }
  }
  const e = new Error(`Intent konnte nach ${INTENT_MAX_VERSUCHE} Versuchen nicht exklusiv angelegt werden: ${letzter && letzter.message}`);
  e.code = "INTENT_EEXIST";
  throw e;
}

export const LOCK_NAME = "restore-core.lock";

/*
 * Ein Restore darf nicht zweimal gleichzeitig laufen. Sonst lesen zwei Laeufe
 * denselben Ist-Stand, zeigen zwei Operatoren dieselbe Zusammenfassung, und
 * beide bestaetigen auf Basis eines Snapshots, den der jeweils andere gerade
 * ueberschreibt.
 *
 * Der Lock wird VOR dem Lesen des Ist-Standes erworben, exklusiv ("wx"), mit
 * Inhalt und fsync. Ein bestehender Lock ist ein HARTER ABBRUCH mit Alter und
 * Inhalt — es gibt KEINE automatische Uebernahme nach Zeitablauf. Ein
 * verwaister Lock wird von einem Menschen geprueft und von Hand geloescht.
 */
export async function erwerbeLock(dir, api, info) {
  const datei = path.join(dir, LOCK_NAME);
  const inhalt = {
    laufId: info?.laufId || randomUUID(),
    zeitpunkt: new Date().toISOString(),
    pid: info?.pid ?? null,
    host: info?.host ?? null,
    benutzer: info?.benutzer ?? null,
  };
  try {
    await api.mkdir(dir, { recursive: true });
    await schreibeUndSynce(datei, JSON.stringify(inhalt, null, 2), api, "wx");
    return { ok: true, datei, inhalt };
  } catch (e) {
    if (e && e.code === "EEXIST") {
      let fremd = null, alterMs = null;
      try {
        fremd = JSON.parse(await api.readFile(datei, "utf8"));
        const t = Date.parse(fremd.zeitpunkt);
        if (!Number.isNaN(t)) alterMs = Date.now() - t;
      } catch (e2) { fremd = { unlesbar: String(e2.message || e2) }; }
      return {
        ok: false, datei, fremd, alterMs,
        grund: "Ein anderer Restore-Lauf haelt den Lock" +
          (fremd?.laufId ? ` (Lauf ${fremd.laufId}` +
            (fremd.pid != null ? `, pid ${fremd.pid}` : "") +
            (fremd.host ? `, host ${fremd.host}` : "") +
            `, seit ${fremd.zeitpunkt}` +
            (alterMs != null ? `, Alter ${Math.round(alterMs / 1000)} s` : "") + ")" : "") +
          ". Kein automatisches Uebernehmen: einen verwaisten Lock erst nach " +
          `menschlicher Pruefung von Hand loeschen (${datei}).`,
      };
    }
    return { ok: false, datei, grund: `Lock nicht erwerbbar: ${e.message}` };
  }
}

export async function gibLockFrei(datei, api) {
  try { await api.unlink(datei); return { ok: true }; }
  catch (e) { return { ok: false, grund: String(e.message || e) }; }
}

export async function aktualisiereIntent(datei, intent, ergebnis, api) {
  const fertig = {
    ...intent,
    status: ergebnis.ok ? "erfolgreich" : "fehlgeschlagen",
    zeitpunktErgebnis: new Date().toISOString(),
    ergebnis,
  };
  await schreibeUndSynce(datei, JSON.stringify(fertig, null, 2), api);
  return fertig;
}

/*
 * Der Ablauf als eine injizierbare Funktion — damit die REIHENFOLGE testbar
 * ist, ohne dass irgendetwas Echtes geschrieben wird.
 */
export async function fuehreRestoreAus(args, deps) {
  const spur = [];
  const sag = (t) => { spur.push(t); if (deps.log) deps.log(t); };
  const dir = deps.logDir || LOG_DIR;
  let lockDatei = null;          // nur gesetzt, wenn DIESER Lauf den Lock haelt
  let intentPfad = null;         // der in DIESEM Lauf erzeugte Pfad — nie rekonstruiert
  let intent = null;

  try {
    const pruefung = pruefeArgumente(args);
    if (!pruefung.ok) return { ok: false, schritt: "argumente", grund: pruefung.grund, spur };

    // 2. Backup lesen und VOLLSTAENDIG validieren — vor Lock und vor jeder Anzeige.
    //    Ein untaugliches Backup soll den Lock gar nicht erst belegen.
    spur.push("backup-lesen");
    const rohText = await deps.readFile(args.from, "utf8");
    const sha = sha256(rohText);
    let roh;
    try { roh = JSON.parse(rohText); } catch (e) {
      return { ok: false, schritt: "backup", grund: "die Backup-Datei ist kein gueltiges JSON", spur };
    }
    const geprueft = pruefeBackup(roh, args.key);
    if (!geprueft.ok) return { ok: false, schritt: "backup", grund: geprueft.grund, spur };
    spur.push("backup-geprueft");

    // 3. LOCK — VOR dem Lesen des Ist-Standes. Zwei gleichzeitige Laeufe wuerden
    //    sonst denselben Snapshot lesen und beide darauf bestaetigen.
    const lock = await erwerbeLock(dir, deps.fsApi, deps.lockInfo || {});
    spur.push("lock:" + (lock.ok ? "erworben" : "belegt"));
    if (!lock.ok) {
      return { ok: false, schritt: "lock", grund: lock.grund, fremderLock: lock.fremd || null,
        alterMs: lock.alterMs ?? null, spur };
    }
    lockDatei = lock.datei;

    // 4. Aktuellen Stand lesen und bewerten.
    const doc = await deps.readAppDataDocument(args.key);
    const bewertung = bewerteAktuellenStand(doc);
    spur.push("ist-bewertet:" + bewertung.art);
    if (bewertung.art === "unlesbar") {
      return {
        ok: false, schritt: "ist-stand",
        grund: "aktueller Core unlesbar — Restore verweigert, manuell pruefen",
        spur,
      };
    }

    const d = diffZusammenfassung(bewertung, geprueft.daten, geprueft.meta);

    // 5. Preflight VOR der Anzeige und VOR der Frage.
    const pre = await preflightLogDir(dir, deps.fsApi);
    spur.push("preflight:" + (pre.ok ? "ok" : "fehler"));
    if (!pre.ok) return { ok: false, schritt: "preflight", grund: pre.grund, spur };

    // 6. Anzeigen.
    sag("zusammenfassung");
    if (deps.zeige) deps.zeige(formatiereZusammenfassung(d, args.key));

    if (args.dryRun) {
      spur.push("dry-run-ende");
      return { ok: true, schritt: "dry-run", geschrieben: false, zusammenfassung: d, spur };
    }

    // 7. Bestaetigen lassen.
    const antwort = await deps.frage(`Zum Bestaetigen den Schluesselnamen eintippen ("${args.key}"): `);
    spur.push("bestaetigung:" + (antwort === args.key ? "ja" : "nein"));
    if (antwort !== args.key) {
      return { ok: false, schritt: "bestaetigung", grund: "nicht bestaetigt", spur };
    }

    // 8. INTENT exklusiv schreiben und fsyncen — VOR dem Schreibvorgang.
    const pfad = "appStore/" + deps.firebaseNodeKey(args.key);
    intent = baueIntent({
      key: args.key, pfad, quelle: path.resolve(args.from), sha,
      zusammenfassung: d, bestaetigung: antwort, zeit: new Date(),
    });
    intent.laufId = lock.inhalt.laufId;
    const angelegt = await schreibeIntentExklusiv(dir, args.key, intent, deps.fsApi, new Date());
    intentPfad = angelegt.datei;          // NUR dieser Pfad wird spaeter aktualisiert
    intent.nonce = angelegt.nonce;
    spur.push("intent-persistiert");

    // 9. Erst JETZT schreiben.
    const text = JSON.stringify(geprueft.daten);
    const wrap = {
      data: text,
      etag: deps.jsonEtag(text),
      updatedAt: geprueft.meta.updatedAt || new Date().toISOString(),
      savedAt: Date.now(),
      savedBy: "restore-core-script",
    };
    let ergebnis;
    try {
      spur.push("write");
      const r = await deps.firebaseDbSet(pfad, wrap);
      ergebnis = { ok: !!(r && r.ok), etagNachher: wrap.etag, updatedAtNachher: wrap.updatedAt };
    } catch (e) {
      // Auch ein geworfener Schreibfehler landet im BESTEHENDEN Intent — in
      // genau der Datei, die dieser Lauf angelegt hat.
      ergebnis = { ok: false, fehler: String(e && e.message || e), etagNachher: null, updatedAtNachher: null };
      await aktualisiereIntent(intentPfad, intent, ergebnis, deps.fsApi);
      spur.push("intent-aktualisiert:wurf");
      throw e;
    }
    await aktualisiereIntent(intentPfad, intent, ergebnis, deps.fsApi);
    spur.push("intent-aktualisiert:" + (ergebnis.ok ? "ok" : "fehler"));
    return { ok: ergebnis.ok, schritt: "fertig", geschrieben: true, protokoll: intentPfad, zusammenfassung: d, spur };
  } finally {
    // Der Lock wird IMMER freigegeben, wenn dieser Lauf ihn haelt — nach dem
    // Outcome-Update, und auch auf jedem Fehlerpfad.
    if (lockDatei) {
      const frei = await gibLockFrei(lockDatei, deps.fsApi);
      spur.push("lock-frei:" + (frei.ok ? "ok" : "fehler"));
    }
  }
}

async function frage(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(text, (a) => { rl.close(); r(String(a || "").trim()); }));
}

// ── Ab hier nur noch der ausfuehrende Teil ──────────────────────────────
const istMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (istMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Verwendung:\n  node scripts/restore-core.mjs --from <backup.json> ${RESTORE_FLAG}\n\n` +
      `  --from <datei>   Backup aus scripts/backup-blob.mjs\n` +
      `  --dry-run        nur die Zusammenfassung zeigen, nichts schreiben\n` +
      `  ${RESTORE_FLAG}\n                   Pflicht fuer den echten Restore.\n`);
    process.exit(0);
  }
  const admin = await import("../netlify/lib/firebase-admin.mjs");
  let ergebnis;
  try {
    ergebnis = await fuehreRestoreAus(args, {
      readFile,
      readAppDataDocument: admin.readAppDataDocument,
      firebaseDbSet: admin.firebaseDbSet,
      firebaseNodeKey: admin.firebaseNodeKey,
      jsonEtag: admin.jsonEtag,
      // readFile gehoert dazu: erwerbeLock liest einen bestehenden Lock, um zu
      // sagen WER ihn haelt und seit wann.
      fsApi: { mkdir, open, unlink, readFile },
      lockInfo: {
        laufId: randomUUID(),
        pid: process.pid,
        host: os.hostname(),
        benutzer: (os.userInfo && (() => { try { return os.userInfo().username; } catch (e) { return null; } })()) || null,
      },
      frage,
      zeige: (t) => { console.log(""); console.log(t); console.log(""); },
      log: () => {},
    });
  } catch (e) {
    console.error("Schreibfehler (im Protokoll vermerkt): " + (e && e.message || e));
    process.exit(1);
  }
  if (!ergebnis.ok) {
    console.error("Abbruch (" + ergebnis.schritt + "): " + ergebnis.grund);
    process.exit(ergebnis.schritt === "bestaetigung" ? 3 : ergebnis.schritt === "lock" ? 4 : 2);
  }
  if (!ergebnis.geschrieben) {
    console.log("--dry-run: es wurde NICHTS geschrieben.");
    process.exit(0);
  }
  console.log("Wiederhergestellt. Protokoll: " + ergebnis.protokoll);
  process.exit(0);
}
