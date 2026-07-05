#!/usr/bin/env node
/* ============================================================================
 *  QUANTUS DRIVE — EINMALIGES BACKFILL-SKRIPT
 *  ---------------------------------------------------------------------------
 *  Geht per Firebase Admin SDK (Service-Account) durch alle Storage-Ordner des
 *  Buckets jupidu-36804.firebasestorage.app und legt für jede echte Datei
 *  (PDF / DOCX / Bilder — JSON-Sync-Dateien und alles andere wird übersprungen)
 *  einen driveDocs/<docId>-Eintrag (status "eingang") plus einen
 *  driveInbox/<docId>-Eintrag (status "pending") an, inkl. extrahiertem Text
 *  (PDF via pdf-parse, DOCX via mammoth). Der bestehende n8n-Workflow
 *  (n8n/drive-klassifizierung.json) greift die Einträge dann automatisch auf.
 *
 *  IDEMPOTENT:
 *   - docId = "bf_" + SHA-256(storagePath) → derselbe Pfad ergibt immer
 *     dieselbe docId; existiert driveDocs/<docId> bereits, wird übersprungen.
 *   - Zusätzlich werden alle storagePaths bestehender driveDocs übersprungen
 *     (deckt auch die vom Drive-Modul selbst hochgeladenen Dateien unter
 *     drive/<pushKey>/… ab, die eine andere docId-Form haben).
 *
 *  SERVICE-ACCOUNT (nichts davon committen!):
 *   - Umgebungsvariable GOOGLE_APPLICATION_CREDENTIALS=/pfad/zum/sa.json  ODER
 *   - Umgebungsvariable SERVICE_ACCOUNT_FILE=/pfad/zum/sa.json            ODER
 *   - lokale Datei ./service-account.json (steht in .gitignore)
 *
 *  AUFRUF:
 *    node scripts/drive-backfill.js [--dry-run] [--limit N] [--prefix ordner/]
 *      --dry-run   nur auflisten, was angelegt WÜRDE (keine Schreibzugriffe)
 *      --limit N   höchstens N neue Dokumente anlegen (zum Antesten)
 *      --prefix p  nur diesen Storage-Ordner verarbeiten (z. B. belege/)
 *
 *  Abhängigkeiten (lokal, ohne package.json anzufassen):
 *    npm install --no-save firebase-admin pdf-parse mammoth
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Konfiguration (identisch zu public/drive.html / index.html) ─────────────
const BUCKET = "jupidu-36804.firebasestorage.app";
const RTDB_DB_URL = "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app";
const PREFIXES = ["attachments/", "belege/", "buchhaltung-sp-ar/", "cloud-sync/", "drive/", "project-inbox/", "task-files/"];

// Nur echte Dokumente/Bilder — JSON-Sync-Dateien u. ä. werden übersprungen.
const ERLAUBTE_ENDUNGEN = new Set([
  "pdf", "docx",
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif", "svg"
]);
const MAX_BYTES = 50 * 1024 * 1024; // Einzeldateien > 50 MB überspringen (Log)

// ── CLI-Argumente ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const limitIdx = argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) || 0 : 0;
const prefixIdx = argv.indexOf("--prefix");
const nurPrefix = prefixIdx >= 0 ? String(argv[prefixIdx + 1] || "") : "";

// ── Service-Account laden (NUR aus Env/lokaler Datei) ───────────────────────
function serviceAccountLaden() {
  const kandidaten = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.SERVICE_ACCOUNT_FILE,
    path.join(process.cwd(), "service-account.json")
  ].filter(Boolean);
  for (const p of kandidaten) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      konsole("FEHLER", "Service-Account-Datei unlesbar: " + p + " — " + e.message);
      process.exit(1);
    }
  }
  konsole("FEHLER", "Kein Service-Account gefunden. Setze GOOGLE_APPLICATION_CREDENTIALS oder SERVICE_ACCOUNT_FILE, oder lege ./service-account.json ab (siehe scripts/README-drive-backfill.md).");
  process.exit(1);
}

function modulLaden(name, wofuer) {
  try { return require(name); }
  catch (e) {
    konsole("FEHLER", "Modul '" + name + "' fehlt (" + wofuer + "). Installieren mit:\n  npm install --no-save firebase-admin pdf-parse mammoth");
    process.exit(1);
  }
}

function konsole(tag, msg) { console.log("[" + tag + "] " + msg); }
function sha256Hex(input) { return crypto.createHash("sha256").update(input).digest("hex"); }
function endung(name) { return (String(name).split(".").pop() || "").toLowerCase(); }

function mimeAusEndung(ext) {
  const map = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
    tiff: "image/tiff", tif: "image/tiff", svg: "image/svg+xml"
  };
  return map[ext] || "application/octet-stream";
}

// ── Textextraktion (PDF: pdf-parse · DOCX: mammoth · Bilder: kein Text) ─────
async function extrahiereText(ext, buffer) {
  try {
    if (ext === "pdf") {
      const pdfParse = modulLaden("pdf-parse", "PDF-Textextraktion");
      const data = await pdfParse(buffer);
      return String(data.text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
    if (ext === "docx") {
      const mammoth = modulLaden("mammoth", "DOCX-Textextraktion");
      const res = await mammoth.extractRawText({ buffer });
      return String((res && res.value) || "").trim();
    }
  } catch (e) {
    konsole("WARN", "Textextraktion fehlgeschlagen (" + e.message + ") — Eintrag wird ohne Text angelegt");
  }
  return ""; // Bilder & Fehlerfall: leerer Text (n8n klassifiziert dann nur nach Dateiname)
}

// Download-URL im Firebase-Format sicherstellen (bestehenden Token wieder-
// verwenden, sonst neuen Token in die Objekt-Metadaten schreiben) — ergibt
// dieselbe URL-Form, die auch das Web-SDK / drive.html liefert.
async function downloadUrlSicherstellen(file, dryRunAktiv) {
  const meta = file.metadata || {};
  let token = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
  if (token) token = String(token).split(",")[0].trim();
  if (!token) {
    token = crypto.randomUUID();
    if (!dryRunAktiv) {
      await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
  }
  return "https://firebasestorage.googleapis.com/v0/b/" + BUCKET + "/o/" +
    encodeURIComponent(file.name) + "?alt=media&token=" + token;
}

// ── Hauptlauf ────────────────────────────────────────────────────────────────
async function main() {
  const admin = modulLaden("firebase-admin", "Firebase Admin SDK");
  const sa = serviceAccountLaden();
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: RTDB_DB_URL,
    storageBucket: BUCKET
  });
  const db = admin.database();
  const bucket = admin.storage().bucket();

  konsole("INFO", "Modus: " + (dryRun ? "DRY-RUN (keine Schreibzugriffe)" : "SCHREIBEND") +
    (limit ? " · Limit: " + limit : "") + (nurPrefix ? " · Nur Prefix: " + nurPrefix : ""));

  // Bestehende driveDocs einmal laden → Idempotenz + Hash-Duplikat-Abgleich
  const docsSnap = await db.ref("driveDocs").once("value");
  const bestehende = docsSnap.val() || {};
  const bekanntePfade = new Set();
  const bekannteHashes = new Set();
  for (const id of Object.keys(bestehende)) {
    const d = bestehende[id] || {};
    if (d.storagePath) bekanntePfade.add(d.storagePath);
    if (d.hash) bekannteHashes.add(d.hash);
  }
  konsole("INFO", "Bestehende driveDocs: " + Object.keys(bestehende).length +
    " (" + bekanntePfade.size + " Storage-Pfade, " + bekannteHashes.size + " Hashes)");

  const prefixe = nurPrefix ? [nurPrefix] : PREFIXES;
  let angelegt = 0, uebersprungen = 0, gefiltert = 0, fehler = 0;

  aussen:
  for (const prefix of prefixe) {
    konsole("ORDNER", prefix);
    const [dateien] = await bucket.getFiles({ prefix });
    for (const file of dateien) {
      const name = file.name;
      if (name.endsWith("/")) continue; // Ordner-Platzhalter

      const ext = endung(name);
      if (ext === "json") { gefiltert++; continue; } // JSON-Sync-Dateien
      if (!ERLAUBTE_ENDUNGEN.has(ext)) { gefiltert++; continue; }

      // Idempotenz: deterministische docId aus dem Storage-Pfad + Pfad-Abgleich
      const docId = "bf_" + sha256Hex(name).slice(0, 24);
      if (bestehende[docId] || bekanntePfade.has(name)) { uebersprungen++; continue; }

      const groesse = Number((file.metadata && file.metadata.size) || 0);
      if (groesse > MAX_BYTES) {
        konsole("SKIP", name + " (" + Math.round(groesse / 1048576) + " MB > Limit)");
        gefiltert++;
        continue;
      }

      if (dryRun) {
        konsole("DRY", "würde anlegen: " + name + " → " + docId);
        angelegt++;
        if (limit && angelegt >= limit) break aussen;
        continue;
      }

      try {
        const [buffer] = await file.download();
        const hash = sha256Hex(buffer);
        const duplikat = bekannteHashes.has(hash);
        const text = await extrahiereText(ext, buffer);
        const downloadUrl = await downloadUrlSicherstellen(file, false);
        const mimeType = (file.metadata && file.metadata.contentType) || mimeAusEndung(ext);
        const jetzt = new Date().toISOString();
        const erstellt = (file.metadata && file.metadata.timeCreated) || jetzt;
        const dateiname = path.posix.basename(name);

        await db.ref("driveDocs/" + docId).set({
          dateiname: dateiname,
          titel_final: "",
          storagePath: name,
          downloadUrl: downloadUrl,
          mimeType: mimeType,
          groesse: groesse,
          hash: hash,
          status: "eingang",
          folderId: null,
          vorschlag: null,
          textauszug: text.slice(0, 2000),
          erstellt: erstellt,
          aktualisiert: jetzt
        });
        await db.ref("driveInbox/" + docId).set({
          docId: docId,
          dateiname: dateiname,
          mimeType: mimeType,
          text: text.slice(0, 6000),
          hash: hash,
          duplikat_verdacht: duplikat,
          status: "pending",
          erstellt: jetzt
        });

        bekanntePfade.add(name);
        bekannteHashes.add(hash);
        angelegt++;
        konsole("NEU", name + " → " + docId + (duplikat ? " (Duplikat-Verdacht)" : "") +
          (text ? " · " + text.length + " Zeichen Text" : " · kein Text"));
        if (limit && angelegt >= limit) break aussen;
      } catch (e) {
        fehler++;
        konsole("FEHLER", name + ": " + (e && e.message));
      }
    }
  }

  konsole("FERTIG", "Neu angelegt: " + angelegt + " · Bereits vorhanden: " + uebersprungen +
    " · Gefiltert (Typ/Grösse): " + gefiltert + " · Fehler: " + fehler +
    (dryRun ? " — DRY-RUN, nichts geschrieben." : ""));

  await admin.app().delete(); // offene RTDB-Verbindungen schliessen → Prozess endet
  process.exit(fehler ? 2 : 0);
}

main().catch(function (e) {
  konsole("FEHLER", "Abbruch: " + (e && e.stack || e));
  process.exit(1);
});
