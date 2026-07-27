#!/usr/bin/env node
// ============================================================================
//  QUANTUS BLOB-BACKUP — Datenstand sichern und wiederherstellen
//  ---------------------------------------------------------------------------
//  Backup:   node scripts/backup-blob.mjs [--base URL] [--key app-data.json] [--out backups]
//  Restore:  node scripts/backup-blob.mjs --restore backups/<datei>.json [--force]
//
//  - Das Backup laedt den aktuellen Datenstand ueber blob-get und legt ihn mit
//    Zeitstempel und ETag als JSON-Datei ab.
//  - Restore schreibt den Datenstand per blob-put zurueck. Ohne --force wird
//    das im Backup gespeicherte ETag als If-Match mitgeschickt: Wurde der
//    Server-Stand seither veraendert, bricht der Restore mit 412 ab, statt
//    neuere Daten zu ueberschreiben.
//  - Optionaler Schutz: SYNC_AUTH_TOKEN wird als Authorization-Header gesendet.
// ============================================================================

import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE = "https://management-xo2-pro.netlify.app";
const DEFAULT_KEY = "app-data.json";

export function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, key: DEFAULT_KEY, out: "backups", restore: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") args.base = argv[++i] || args.base;
    else if (arg === "--key") args.key = argv[++i] || args.key;
    else if (arg === "--out") args.out = argv[++i] || args.out;
    else if (arg === "--restore") args.restore = argv[++i] || null;
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  args.base = String(args.base).replace(/\/+$/, "");
  return args;
}

export function buildBackupName(key, date) {
  const stamp = (date || new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${String(key).replace(/[^a-z0-9._-]/gi, "_")}.${stamp}.backup.json`;
}

function authHeaders() {
  const token = process.env.SYNC_AUTH_TOKEN;
  return token ? { "Authorization": "Bearer " + token } : {};
}

async function backup(args) {
  const url = `${args.base}/.netlify/functions/blob-get?key=${encodeURIComponent(args.key)}`;
  process.stdout.write(`Lade ${args.key} von ${args.base} … `);
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`blob-get antwortete mit HTTP ${res.status}`);
  const text = await res.text();
  const etag = res.headers.get("ETag") || null;
  JSON.parse(text); // Backup nur schreiben, wenn der Datenstand gueltiges JSON ist

  const wrapper = {
    tool: "backup-blob",
    key: args.key,
    base: args.base,
    etag,
    savedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(text, "utf8"),
    data: JSON.parse(text)
  };

  await mkdir(args.out, { recursive: true });
  const file = path.join(args.out, buildBackupName(args.key));
  await writeFile(file, JSON.stringify(wrapper, null, 2), "utf8");
  console.log(`ok`);
  console.log(`Backup geschrieben: ${file} (${(wrapper.bytes / 1024).toFixed(1)} KB, ETag ${etag || "—"})`);
  return file;
}

async function restore(args) {
  const raw = await readFile(args.restore, "utf8");
  const wrapper = JSON.parse(raw);
  const data = wrapper && wrapper.tool === "backup-blob" ? wrapper.data : wrapper;
  const key = (wrapper && wrapper.key) || args.key;
  const body = JSON.stringify(data);

  const headers = { "Content-Type": "application/json", ...authHeaders() };
  if (!args.force && wrapper && wrapper.etag) headers["If-Match"] = wrapper.etag;

  const url = `${args.base}/.netlify/functions/blob-put?key=${encodeURIComponent(key)}`;
  process.stdout.write(`Stelle ${key} auf ${args.base} wieder her${headers["If-Match"] ? " (mit If-Match-Schutz)" : ""} … `);
  const res = await fetch(url, { method: "PUT", headers, body });
  if (res.status === 412) {
    throw new Error(
      "Der Server-Stand wurde seit diesem Backup veraendert (ETag-Konflikt).\n" +
      "Pruefe zuerst den aktuellen Stand oder erzwinge den Restore mit --force."
    );
  }
  if (!res.ok) throw new Error(`blob-put antwortete mit HTTP ${res.status}`);
  const result = await res.json().catch(() => ({}));
  console.log("ok");
  console.log(`Wiederhergestellt (neues ETag ${result.etag || "—"}).`);
}

function printHelp() {
  console.log(`Quantus Blob-Backup

  Backup:   node scripts/backup-blob.mjs [--base URL] [--key ${DEFAULT_KEY}] [--out backups]
  Restore:  node scripts/backup-blob.mjs --restore backups/<datei>.json [--force]

  SYNC_AUTH_TOKEN wird, falls gesetzt, als Bearer-Token mitgeschickt.`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const run = args.help ? Promise.resolve(printHelp()) : args.restore ? restore(args) : backup(args);
  run.catch((error) => {
    console.error("\nFehler: " + error.message);
    process.exitCode = 1;
  });
}
