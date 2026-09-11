/*
 * Kopfzeile auf Handy und Tablet (768 / 390).
 *
 * PRODUKTIONSBEFUND, im Browser gemessen (Aufgabenseite, 768px und 390px):
 *   .topbar trägt height:52px, .app eine Rasterzeile von 52px. Unterhalb 900px
 *   kommt flex-wrap:wrap dazu — der Inhalt brauchte 148px, der Kasten blieb
 *   52px hoch. 96px ragten nach unten heraus, mitten in die Seite. Der Punkt
 *   auf dem Seitentitel lieferte nicht die Überschrift, sondern ein Kind der
 *   Kopfzeile (voiceOrb): die Bedienelemente lagen über dem Text und fingen
 *   die Klicks ab.
 *
 *   Zweiter Teil desselben Befunds: die rechte Knopfreihe trägt 18 Schalter
 *   (892px Inhalt). Sie konnte weder schrumpfen noch umbrechen und lief bei
 *   768px wie bei 390px bis x=900 aus dem Bild — abgeschnitten, ohne dass die
 *   Seite überhaupt seitlich scrollte. Erreichbar waren 14 von 18 Schaltern
 *   bei 768px und nur 6 von 18 bei 390px.
 *
 *   Dritter Teil: die drei Aufklappmenüs der Kopfzeile (Anzeigemodus,
 *   Seitenpanels, Angepinntes) hängen an ihrem Knopf IN dieser Reihe. Bei
 *   390px lagen zwei davon bei x=616..856 vollständig ausserhalb des
 *   Bildschirms und waren nicht anklickbar.
 *
 * NACH DER KORREKTUR, dieselbe Messung:
 *   Kasten 97px, Überlauf −9px (der Inhalt endet innerhalb), kein seitlicher
 *   Scroll, über dem Seitentitel liegt die Überschrift selbst, 17 von 18
 *   Schaltern erreichbar (der 18. ist schmaler als 34px und fällt durch das
 *   Messraster), alle drei Menüs auf dem Bildschirm und anklickbar.
 *   Ab 1024px unverändert: Kasten 52px, main ab y=90.
 *
 * Geprüft wird gegen die ECHTEN Regeln aus public/index.html: der Test parst
 * die ausgelieferten <style>-Blöcke und löst die Kaskade für eine konkrete
 * Fensterbreite auf. Kein Browser, kein Netz, keine Datei wird geschrieben.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ═══ CSS lesen: flache Regeln und @media(max-width) ═══════════════════════
function regelnLesen() {
  const regeln = [];
  let ordnung = 0;
  function block(text, fenster) {
    let j = 0;
    while (j < text.length) {
      const auf = text.indexOf("{", j);
      if (auf < 0) break;
      const kopf = text.slice(j, auf).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      let tiefe = 1, k = auf + 1;
      while (k < text.length && tiefe > 0) {
        if (text[k] === "{") tiefe++;
        else if (text[k] === "}") tiefe--;
        k++;
      }
      const inhalt = text.slice(auf + 1, k - 1);
      if (kopf.startsWith("@media")) {
        const mm = /max-width\s*:\s*(\d+)px/.exec(kopf);
        block(inhalt, mm ? Number(mm[1]) : fenster);
      } else if (kopf.startsWith("@")) {
        /* @container, @keyframes, @supports — hier ohne Belang */
      } else if (kopf) {
        for (const sel of kopf.split(",")) {
          const s = sel.trim();
          if (s) regeln.push({ selektor: s, deklarationen: inhalt, fenster, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  }
  const teile = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(index))) teile.push(m[1]);
  block(teile.join("\n"), null);
  return regeln;
}
const REGELN = regelnLesen();
ok(REGELN.length > 500, `zu wenige Regeln geparst (${REGELN.length}) — der Parser passt nicht mehr`);

function spezifitaet(sel) {
  let a = 0, b = 0, c = 0;
  for (const teil of sel.replace(/:not\(([^)]*)\)/g, " $1 ").split(/[\s>+~]+/)) {
    if (!teil) continue;
    a += (teil.match(/#[\w-]+/g) || []).length;
    b += (teil.match(/\.[\w-]+/g) || []).length;
    b += (teil.match(/\[[^\]]*\]/g) || []).length;
    b += (teil.match(/::?[\w-]+/g) || []).length;
    const el = teil.replace(/[#.:[][^#.:[]*/g, "").trim();
    if (el && el !== "*") c += 1;
  }
  return a * 10000 + b * 100 + c;
}

// Loest eine Eigenschaft fuer EINEN Selektor (exakte Schreibweise) auf.
function wert(selektor, eigenschaft, fensterBreite) {
  let best = null;
  for (const r of REGELN) {
    if (r.selektor !== selektor) continue;
    if (r.fenster !== null && fensterBreite > r.fenster) continue;
    const re = new RegExp("(?:^|;)\\s*" + eigenschaft + "\\s*:\\s*([^;}]+)", "i");
    const mm = re.exec(r.deklarationen);
    if (!mm) continue;
    const roh = mm[1].trim();
    const wichtig = /!important/i.test(roh);
    const g = spezifitaet(r.selektor) + (wichtig ? 1000000 : 0);
    if (!best || g > best.g || (g === best.g && r.ordnung > best.ordnung))
      best = { g, ordnung: r.ordnung, v: roh.replace(/\s*!important/i, "").trim() };
  }
  return best ? best.v : null;
}

// ═══ 1. Oberhalb der Schwelle bleibt alles, wie es war ════════════════════
for (const breite of [1440, 1280, 1024]) {
  ok(wert(".topbar", "height", breite) === "52px",
    `${breite}px: .topbar sollte weiterhin 52px hoch sein, ist aber ${wert(".topbar", "height", breite)}`);
  ok(/^52px/.test(wert(".app", "grid-template-rows", breite) || ""),
    `${breite}px: die Rasterzeile der Kopfzeile sollte 52px bleiben, ist aber ${wert(".app", "grid-template-rows", breite)}`);
  ok(wert(".topbar", "flex-wrap", breite) === null,
    `${breite}px: hier darf die Kopfzeile gar nicht umbrechen`);
  // Knopfreihe und Aufklappmenues wurden spaeter auch oberhalb der Schwelle
  // korrigiert (derselbe Ueberlauf, andere Zahlen) — geprueft wird das in
  // tests/kopfzeile-desktop.test.mjs. Hier zaehlt nur, dass die schmale
  // Korrektur nichts an Kopfhoehe, Rasterzeile und Umbruch veraendert hat.
  ok(wert(".topbar", "padding", breite) !== "8px",
    `${breite}px: der schmale Innenabstand greift zu weit nach oben`);
}

// ═══ 2. Unterhalb 900: der Kasten waechst mit ═════════════════════════════
for (const breite of [900, 768, 600, 390]) {
  ok(wert(".topbar", "flex-wrap", breite) === "wrap",
    `${breite}px: der Umbruch der Kopfzeile ist weg — dann stimmt der Befund nicht mehr`);
  ok(wert(".topbar", "height", breite) === "auto",
    `${breite}px: .topbar haelt an einer festen Hoehe fest (${wert(".topbar", "height", breite)}) — der Inhalt ragt wieder heraus`);
  ok(wert(".topbar", "min-height", breite) === "52px",
    `${breite}px: ohne min-height:52px schrumpft die Kopfzeile unter ihr gewohntes Mass`);
  const zeilen = wert(".app", "grid-template-rows", breite) || "";
  ok(/^auto\b/.test(zeilen),
    `${breite}px: die Rasterzeile der Kopfzeile ist weiterhin fest (${zeilen}) — dann hilft height:auto nichts`);
  ok(/minmax\(0,\s*1fr\)/.test(zeilen),
    `${breite}px: die Inhaltszeile braucht minmax(0,1fr), sonst blaeht sie der Inhalt auf`);
}

// ═══ 3. Die Knopfreihe: scrollbar statt abgeschnitten ═════════════════════
for (const breite of [768, 390]) {
  ok(wert(".topbar-right", "overflow-x", breite) === "auto",
    `${breite}px: die Knopfreihe ist nicht seitlich scrollbar — abgeschnittene Schalter bleiben unerreichbar`);
  ok(wert(".topbar-right", "min-width", breite) === "0",
    `${breite}px: ohne min-width:0 kann die Reihe nicht schmaler als ihr Inhalt werden`);
  ok(/^1 1 0/.test(wert(".topbar-right", "flex", breite) || ""),
    `${breite}px: die Reihe nimmt nicht den uebrigen Platz — ${wert(".topbar-right", "flex", breite)}`);
  ok(wert(".topbar-right *", "flex-shrink", breite) === "0",
    `${breite}px: ohne flex-shrink:0 quetscht Flexbox die Schalter zusammen, statt zu scrollen`);
  ok(wert(".topbar-center", "flex", breite) === "0 0 100%",
    `${breite}px: die Suchzeile bekommt keine eigene Reihe (${wert(".topbar-center", "flex", breite)})`);
}

// ═══ 4. Aufklappmenues ans Fenster, und zwar wirksam ══════════════════════
for (const breite of [900, 768, 390]) {
  for (const sel of [".topbar-menu", "#pinnedDropdown"]) {
    ok(wert(sel, "position", breite) === "fixed",
      `${breite}px: ${sel} haengt weiter am Knopf — im scrollenden Streifen wird es abgeschnitten`);
    ok(wert(sel, "left", breite) === "60px",
      `${breite}px: ${sel} haelt keinen Abstand zum schwebenden Sidebar-Schalter (${wert(sel, "left", breite)})`);
    ok(wert(sel, "right", breite) === "8px", `${breite}px: ${sel} steht rechts nicht am Fensterrand`);
    ok(wert(sel, "max-height", breite) === "70vh", `${breite}px: ${sel} kann laenger als der Bildschirm werden`);
  }
}
// Reihenfolge: die schmale Regel MUSS nach der Grundregel stehen, sonst
// gewinnt bei gleicher Spezifitaet die Grundregel (genau das ist hier im
// ersten Anlauf passiert — die Menues blieben absolut positioniert).
const grund = REGELN.find((r) => r.selektor === ".topbar-menu" && r.fenster === null && /position\s*:\s*absolute/.test(r.deklarationen));
const schmal = REGELN.find((r) => r.selektor === ".topbar-menu" && r.fenster === 900 && /left\s*:\s*60px/.test(r.deklarationen));
ok(!!grund && !!schmal, "Grund- oder Schmalregel fuer .topbar-menu nicht gefunden");
if (grund && schmal) ok(schmal.ordnung > grund.ordnung,
  "die schmale Menueregel steht VOR der Grundregel — bei gleicher Spezifitaet gewinnt dann die Grundregel");
// #pinnedDropdown traegt seine Masse inline; ohne !important zieht die
// Stilregel gar nicht.
const pinned = REGELN.find((r) => r.selektor === "#pinnedDropdown" && r.fenster === 900);
ok(!!pinned && /left\s*:\s*60px\s*!important/i.test(pinned.deklarationen),
  "#pinnedDropdown wird ohne !important gesetzt — die Inline-Masse im HTML gewinnen");
ok(/id="pinnedDropdown"[^>]*style="[^"]*position:absolute/.test(index),
  "die Inline-Masse an #pinnedDropdown sind weg — dann darf das !important auch weg");

// ═══ 5. Bau-Kennung ═══════════════════════════════════════════════════════
ok(/name="quantus-build"[^>]*kopfzeile-schmal/.test(index),
  "die Bau-Kennung nennt die Aenderung nicht");

if (luecken.length) {
  console.error(`kopfzeile schmal: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`kopfzeile schmal: ${checks} Pruefungen bestanden`);
