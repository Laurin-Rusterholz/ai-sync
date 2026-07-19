#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────
   build-quantus-data.mjs

   Liest die sechs Theorie-Lehrbuecher unter public/theorie/<fach>.html,
   extrahiert je den eingebetteten <script id="kompendium-data"> JSON-Block
   und schreibt eine kompakte, gebuendelte Datengrundlage nach
   public/theorie/kompendium.json — die Quelle fuer die Quantus-Lern-App
   (Themen-Uebersicht, Repetitionsaufgaben, Quiz, Fortschritt).

   Die Original-HTMLs bleiben unveraendert (Byte-fuer-Byte); nur der bereits
   enthaltene JSON-Block wird ausgelesen. Bei Aenderung der Theorie-Dateien
   dieses Skript erneut ausfuehren:  node scripts/build-quantus-data.mjs
   ──────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const theorieDir = join(root, "public", "theorie");

// Reihenfolge = Anzeigereihenfolge der Faecher in der App
const FILES = ["frw", "deutsch", "geschichte", "technik-umwelt", "mathematik", "wirtschaft"];

function extractKompendium(html) {
  // Tag-Attribute koennen einfache ODER doppelte Anfuehrungszeichen nutzen.
  const m = html.match(/<script[^>]*id=['"]kompendium-data['"][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error("kompendium-data Block nicht gefunden");
  return JSON.parse(m[1]);
}

const faecher = [];
let totalThemen = 0;
let totalAufgaben = 0;

for (const key of FILES) {
  const file = `${key}.html`;
  const html = readFileSync(join(theorieDir, file), "utf8");
  const data = extractKompendium(html);
  const themen = Array.isArray(data.themen) ? data.themen : [];
  totalThemen += themen.length;
  for (const t of themen) totalAufgaben += Array.isArray(t.aufgaben) ? t.aufgaben.length : 0;
  faecher.push({
    key,                 // stabiler Schluessel (== Dateiname ohne .html)
    file,                // /theorie/<file> fuer die Lehrbuch-Ansicht
    fach: data.fach || key,
    quelle: data.quelle || "",
    themen,
  });
}

const out = {
  schema: 1,
  faecher,
  stats: { faecher: faecher.length, themen: totalThemen, aufgaben: totalAufgaben },
};

const outPath = join(theorieDir, "kompendium.json");
writeFileSync(outPath, JSON.stringify(out), "utf8");
console.log(`geschrieben: ${outPath}`);
console.log(`  Faecher=${faecher.length}  Themen=${totalThemen}  Aufgaben=${totalAufgaben}`);
