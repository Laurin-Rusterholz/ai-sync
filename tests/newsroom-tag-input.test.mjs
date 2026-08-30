// Produktionsbefund (Review PR #220, P1-2):
//
// Der Newsroom-Tag-Input mkTI (News- und Topic-Dialog) baute das <input> bei
// JEDEM input-Event per innerHTML neu. Der Browser setzte den Caret dabei auf
// Position 0 — aus "Buch" wurde beim Tippen "hcuB", und die gerade neu
// gebaute Vorschlagsliste konnte nie aufklappen. Gemessen mit Chromium:
// value "hcuB", caret 0, options [].
//
// Der Fix laesst das Eingabefeld stehen und aktualisiert bei input NUR die
// <datalist>. Dieser Test verankert genau das im Quelltext: der input-Handler
// darf ausschliesslich die Listen-Aktualisierung aufrufen, nie das Re-Render.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

const start = index.indexOf("function mkTI(id,init=[]){");
assert.ok(start > 0, "mkTI muss existieren");
const end = index.indexOf("\n}", index.indexOf("return{get:", start));
const mkTI = index.slice(start, end);

assert.match(mkTI, /const refreshList=\(\)=>\{/,
  "mkTI braucht eine reine Listen-Aktualisierung getrennt vom Re-Render");
assert.match(mkTI, /inp\.addEventListener\('input',refreshList\)/,
  "der input-Handler darf nur die Datalist aktualisieren (Caret-Schutz)");
assert.doesNotMatch(mkTI, /addEventListener\('input',\s*\(\)\s*=>\s*\{[^}]*r\(/,
  "der input-Handler darf das Feld nicht neu bauen — das setzte den Caret auf 0");
assert.match(mkTI, /dl\.innerHTML=suggestions/,
  "Vorschlaege werden in die bestehende Datalist geschrieben");
assert.match(mkTI, /quantusGetTagSuggestions/,
  "die Vorschlaege kommen aus dem gemeinsamen, buchstabenweisen Tag-Pool");
// Enter/Backspace duerfen weiterhin strukturell neu rendern — dann mit Fokus:
assert.match(mkTI, /e\.key==='Enter'[\s\S]*r\(true\)/);
assert.match(mkTI, /e\.key==='Backspace'[\s\S]*r\(true\)/);

console.log("Newsroom-Tag-Input (stabiles Feld, Caret-Schutz): ok");
