/*
 * Halten die Serverfunktionen überhaupt zusammen?
 *
 * BEFUND (Netlify-Deploy von e78468b, FAILED):
 *   „No matching export in netlify/lib/firebase-admin.mjs for import
 *    firebaseDbGetWithEtag" — mail-queue-run.mjs:13
 * `firebaseDbGetWithEtag` war in firebase-admin.mjs intern, die neuen
 * Mail-Funktionen importierten sie trotzdem. `npm test` merkte davon nichts:
 * die Tests fahren die Warteschlange mit eigenen Attrappen und fassen die
 * Netlify-Funktionen gar nicht an. Der Fehler tauchte erst beim Bündeln auf —
 * also nach dem Push, im Deploy.
 *
 * Dieser Test schliesst genau diese Lücke: Er folgt JEDEM lokalen Import in
 * netlify/ und prüft, ob die benannte Ausfuhr auf der anderen Seite wirklich
 * existiert. Ohne Netz, ohne node_modules, ohne Netlify — reine Buchhaltung
 * über den Quelltext, so wie der Bündler sie auch macht.
 *
 * Zusätzlich wird jede Funktion wirklich geladen, wenn ihre Abhängigkeiten
 * dastehen; fehlt ein npm-Paket (wie hier im Prüfstand), wird dieser Teil
 * ausdrücklich übersprungen statt stillschweigend als bestanden gezählt.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };

function dateien(ordner) {
  const voll = path.join(WURZEL, ordner);
  if (!existsSync(voll)) return [];
  return readdirSync(voll).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .map((f) => path.join(ordner, f));
}

/* Welche Namen führt eine Datei aus? Dieselben Formen, die der Bündler kennt. */
function ausfuhren(quelle) {
  const namen = new Set();
  let standard = false;
  const s = quelle;
  for (const m of s.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) namen.add(m[1]);
  for (const m of s.matchAll(/^\s*export\s+class\s+([A-Za-z0-9_$]+)/gm)) namen.add(m[1]);
  for (const m of s.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) namen.add(m[1]);
  for (const m of s.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const teil of m[1].split(",")) {
      const t = teil.trim();
      if (!t) continue;
      const als = /\sas\s+([A-Za-z0-9_$]+)$/.exec(t);
      namen.add(als ? als[1] : t);
    }
  }
  if (/^\s*export\s+default\b/m.test(s)) standard = true;
  return { namen, standard };
}

/* Was holt eine Datei woher? */
function einfuhren(quelle) {
  const liste = [];
  for (const m of quelle.matchAll(/^\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["']/gm)) {
    const was = m[1].trim();
    const ziel = m[2];
    const namen = [];
    let standard = null;
    const geschweift = /\{([^}]*)\}/.exec(was);
    if (geschweift) {
      for (const teil of geschweift[1].split(",")) {
        const t = teil.trim();
        if (!t) continue;
        namen.push(t.split(/\s+as\s+/)[0].trim());
      }
    }
    const vorn = was.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    if (vorn && !vorn.startsWith("*")) standard = vorn;
    liste.push({ ziel, namen, standard });
  }
  return liste;
}

const zuPruefen = [...dateien("netlify/functions"), ...dateien("netlify/lib")];
ok(zuPruefen.length > 0, "es wurden gar keine Serverfunktionen gefunden");

for (const rel of zuPruefen) {
  const quelle = readFileSync(path.join(WURZEL, rel), "utf8");
  for (const imp of einfuhren(quelle)) {
    if (!imp.ziel.startsWith(".")) continue;            // npm-Pakete: siehe unten
    const zielPfad = path.resolve(path.dirname(path.join(WURZEL, rel)), imp.ziel);
    if (!existsSync(zielPfad)) { ok(false, `${rel}: die Datei ${imp.ziel} gibt es nicht`); continue; }
    const { namen, standard } = ausfuhren(readFileSync(zielPfad, "utf8"));
    for (const n of imp.namen) {
      ok(namen.has(n), `${rel}: ${imp.ziel} führt „${n}" nicht aus — genau daran scheitert der Netlify-Build`);
    }
    if (imp.standard) ok(standard, `${rel}: ${imp.ziel} hat keine Standard-Ausfuhr für „${imp.standard}"`);
  }
}

/* Jede Funktion braucht einen Einstieg — sonst bündelt Netlify eine Datei,
   die nie gerufen wird. */
for (const rel of dateien("netlify/functions")) {
  const quelle = readFileSync(path.join(WURZEL, rel), "utf8");
  ok(/^\s*export\s+default\b/m.test(quelle), `${rel}: ohne Standard-Ausfuhr gibt es keinen Einstiegspunkt`);
}

/* Die beiden Mail-Funktionen ausdrücklich: der Auslöser dieses Tests. */
{
  const admin = readFileSync(path.join(WURZEL, "netlify/lib/firebase-admin.mjs"), "utf8");
  const { namen } = ausfuhren(admin);
  for (const n of ["firebaseDbGet", "firebaseDbGetWithEtag", "firebaseDbSet", "firebaseDbRemove"]) {
    ok(namen.has(n), `firebase-admin.mjs führt „${n}" nicht aus — die Mail-Warteschlange braucht es`);
  }
  const lauf = readFileSync(path.join(WURZEL, "netlify/functions/mail-queue-run.mjs"), "utf8");
  ok(/schedule:\s*"\* \* \* \* \*"/.test(lauf), "der Serverlauf hat keinen Zeitplan mehr");
}

/* Und wenn die npm-Abhängigkeiten dastehen: wirklich laden. Fehlt ein Paket,
   wird das GESAGT und nicht als bestanden verbucht. */
let echtGeladen = 0, uebersprungen = 0;
for (const rel of dateien("netlify/functions")) {
  try {
    await import(pathToFileURL(path.join(WURZEL, rel)).href);
    echtGeladen++;
  } catch (e) {
    const txt = String((e && e.message) || e);
    if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(txt) && !/\.mjs'/.test(txt)) { uebersprungen++; continue; }
    ok(false, `${rel} lässt sich nicht laden: ${txt}`);
  }
}
console.log(`  wirklich geladen: ${echtGeladen}, übersprungen (npm-Paket fehlt im Prüfstand): ${uebersprungen}`);

if (luecken.length) {
  console.error("netlify function importe: FEHLER");
  luecken.forEach((l) => console.error("  ✗ " + l));
  process.exit(1);
}
console.log(`netlify function importe: ok (${checks} Prüfungen)`);
