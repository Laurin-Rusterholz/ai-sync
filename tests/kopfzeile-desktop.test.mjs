/*
 * Kopfzeile auf dem Desktop (1440 / 1280).
 *
 * PRODUKTIONSBEFUND, im Browser gemessen (Aufgabenseite):
 *   Die rechte Reihe der Kopfzeile trägt 21 sichtbare Bedienelemente mit
 *   zusammen 1148px Breite — 18 Symbolschalter, der Sprachknopf und die beiden
 *   Schnelleingaben für Idee und Update. Sie war unschrumpfbar (kein
 *   min-width:0) und lief deshalb über den rechten Rand der Kopfzeile hinaus:
 *
 *     1440px  Reihe 518..1666, Kopfzeile endet bei 1440
 *             ausserhalb: Gedanke notieren, Tag abschliessen, Ruhestand,
 *             Seitenpanels, Anzeigemodus, Einstellungen
 *             erreichbar 16 von 21
 *     1280px  dieselbe Reihe, zusätzlich ausserhalb: Speichern, Push, Pull
 *             erreichbar 12 von 21
 *
 *   Die Seite scrollte dabei NICHT seitlich — es war schlicht abgeschnitten,
 *   die Schalter waren ohne jeden Umweg unerreichbar. Betroffen unter anderem
 *   Einstellungen und Anzeigemodus.
 *
 *   Dazu passend öffneten zwei der drei Aufklappmenüs ins Leere: Anzeigemodus
 *   bei x=1382..1622 und Seitenpanels bei x=1338..1578, also jenseits des
 *   Fensterrands — weil ihr Knopf selbst schon dort lag.
 *
 * NACH DER KORREKTUR, dieselbe Messung:
 *   1440px und 1280px: 21 von 21 erreichbar, alle drei Menüs im Bild und
 *   anklickbar, Kopfzeile weiterhin 52px, main weiterhin ab y=90, kein
 *   seitlicher Querlauf. 900/768/390 unverändert gegenüber PR249.
 *
 *   Ausdrücklich mitgemessen sind die beiden schmalen Bedienelemente, die eine
 *   frühere Messung mit ihrem 34px-Filter ausgeschlossen hatte: der
 *   Sprachknopf (30px) und „Tag abschliessen" (31px). Beide sind bei jeder
 *   Breite erreichbar.
 *
 * Geprüft wird gegen die ECHTEN Regeln und den ECHTEN Radhandler aus
 * public/index.html. Kein Browser, kein Netz, keine Datei wird geschrieben.
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

function wert(selektor, eigenschaft, fensterBreite) {
  let best = null;
  for (const r of REGELN) {
    if (r.selektor !== selektor) continue;
    if (r.fenster !== null && fensterBreite > r.fenster) continue;
    const re = new RegExp("(?:^|;)\\s*" + eigenschaft + "\\s*:\\s*([^;}]+)", "i");
    const mm = re.exec(r.deklarationen);
    if (!mm) continue;
    const roh = mm[1].trim();
    const g = (/!important/i.test(roh) ? 1000000 : 0);
    if (!best || g > best.g || (g === best.g && r.ordnung > best.ordnung))
      best = { g, ordnung: r.ordnung, v: roh.replace(/\s*!important/i, "").trim() };
  }
  return best ? best.v : null;
}

// ═══ 1. Die Reihe darf schmaler werden als ihr Inhalt — bei JEDER Breite ══
for (const breite of [1440, 1280, 1024, 900, 768, 390]) {
  ok(wert(".topbar-right", "min-width", breite) === "0",
    `${breite}px: ohne min-width:0 kann die Reihe nicht schmaler als ihr Inhalt werden — sie laeuft wieder aus dem Bild`);
  ok(wert(".topbar-right", "overflow-x", breite) === "auto",
    `${breite}px: ohne overflow-x bleibt abgeschnitten, was nicht passt`);
  ok(wert(".topbar-right", "overflow-y", breite) === "hidden",
    `${breite}px: ohne overflow-y:hidden bekommt die Reihe zusaetzlich einen senkrechten Balken`);
  ok(wert(".topbar-right *", "flex-shrink", breite) === "0",
    `${breite}px: ohne flex-shrink:0 quetscht Flexbox die Schalter zusammen, statt zu scrollen`);
  ok(wert(".topbar-right", "overscroll-behavior-x", breite) === "contain",
    `${breite}px: ohne overscroll-behavior-x:contain loest ein Wisch am Ende die Zurueck-Geste aus`);
}

// ═══ 2. Scrollbalken: auf dem Desktop sichtbar, auf dem Handy nicht ═══════
for (const breite of [1440, 1280, 1024]) {
  ok(wert(".topbar-right", "scrollbar-width", breite) === "thin",
    `${breite}px: ohne sichtbaren Balken merkt am Zeigergeraet niemand, dass es weitergeht`);
}
for (const breite of [900, 768, 390]) {
  ok(wert(".topbar-right", "scrollbar-width", breite) === "none",
    `${breite}px: auf dem Handy nimmt ein Balken nur Platz weg (dort wird gewischt)`);
}
const balken = REGELN.find((r) => r.selektor === ".topbar-right::-webkit-scrollbar" && r.fenster === null);
ok(!!balken && /height\s*:\s*6px/.test(balken.deklarationen),
  "der Balken hat keine flache Hoehe — er wuerde die 36px-Schalter beschneiden");
const balkenAus = REGELN.find((r) => r.selektor === ".topbar-right::-webkit-scrollbar" && r.fenster === 900);
ok(!!balkenAus && /display\s*:\s*none/.test(balkenAus.deklarationen),
  "der Balken wird auf schmalen Geraeten nicht ausgeblendet");
ok(!!balken && !!balkenAus && balkenAus.ordnung > balken.ordnung,
  "die schmale Balkenregel steht vor der Grundregel — dann gewinnt die Grundregel");

// ═══ 3. Aufklappmenues haengen am Fenster, mit eigener Breite auf dem Desktop
for (const breite of [1440, 1280, 1024, 900, 768, 390]) {
  for (const sel of [".topbar-menu", "#pinnedDropdown"]) {
    ok(wert(sel, "position", breite) === "fixed",
      `${breite}px: ${sel} haengt weiter am Knopf — im scrollenden Streifen wird es abgeschnitten`);
    ok(wert(sel, "right", breite) === "8px",
      `${breite}px: ${sel} steht nicht am rechten Rand der Kopfzeile`);
    ok(wert(sel, "max-height", breite) === "70vh",
      `${breite}px: ${sel} kann laenger als der Bildschirm werden`);
  }
}
// Desktop: eigene Menuebreite behalten, nicht ueber die ganze Kopfzeile ziehen
ok(wert(".topbar-menu", "width", 1440) === "240px",
  `1440px: das Menue wird ueber die ganze Breite gezogen (${wert(".topbar-menu", "width", 1440)})`);
ok(wert(".topbar-menu", "left", 1440) === "auto",
  `1440px: das Menue wird links verankert und damit breitgezogen`);
// Schmal: ueber die Fensterbreite, mit Abstand zum schwebenden Sidebar-Schalter
ok(wert(".topbar-menu", "width", 390) === "auto",
  "390px: das Menue behaelt seine 240px statt die Fensterbreite zu nutzen");
ok(wert(".topbar-menu", "left", 390) === "60px",
  "390px: der Abstand zum schwebenden Sidebar-Schalter fehlt");
// Die Grundregel muss NACH der alten absolute-Regel stehen, sonst wirkt sie nicht.
const altRegel = REGELN.find((r) => r.selektor === ".topbar-menu" && r.fenster === null && /position\s*:\s*absolute/.test(r.deklarationen));
const neuRegel = REGELN.find((r) => r.selektor === ".topbar-menu" && r.fenster === null && /position\s*:\s*fixed/.test(r.deklarationen));
ok(!!altRegel && !!neuRegel, "alte oder neue Positionsregel fuer .topbar-menu nicht gefunden");
if (altRegel && neuRegel) ok(neuRegel.ordnung > altRegel.ordnung,
  "die neue Menueregel steht VOR der alten — bei gleicher Spezifitaet gewinnt dann die alte");
const pinnedNeu = REGELN.find((r) => r.selektor === "#pinnedDropdown" && r.fenster === null);
ok(!!pinnedNeu && /position\s*:\s*fixed\s*!important/i.test(pinnedNeu.deklarationen),
  "#pinnedDropdown ohne !important — die Inline-Masse im HTML gewinnen");
ok(/id="pinnedDropdown"[^>]*style="[^"]*position:absolute/.test(index),
  "die Inline-Masse an #pinnedDropdown sind weg — dann darf das !important auch weg");

// ═══ 4. Der Radhandler ════════════════════════════════════════════════════
const a = index.indexOf("KOPFZEILE — Mausrad ueber der rechten Knopfreihe");
ok(a > 0, "der Radhandler ist nicht da — mit blosser Maus bliebe der hintere Teil der Reihe unerreichbar");
if (a > 0) {
  const quelle = index.slice(a, index.indexOf("</script>", a));
  ok(/addEventListener\("wheel"/.test(quelle) && /\{ passive: false \}/.test(quelle),
    "der Radhandler ist nicht als aktiver Zuhoerer angemeldet — preventDefault waere wirkungslos");
  ok(/if \(verborgen <= 1\) return;/.test(quelle),
    "der Handler greift auch, wenn gar nichts verborgen ist");
  ok(/if \(ev\.ctrlKey \|\| ev\.metaKey\) return;/.test(quelle),
    "Strg+Rad wird abgefangen — das ist der Browserzoom, der gehoert nicht uns");
  ok(/if \(senkrechtScrollbarDarunter\(ev\.target\)\) return;/.test(quelle),
    "ein Rad aus einem senkrecht scrollbaren Nachfahren wird nicht durchgelassen");
  ok(/Math\.abs\(ev\.deltaX\) > Math\.abs\(ev\.deltaY\)\) return/.test(quelle),
    "waagrechte Gesten werden nicht durchgelassen — Trackpad-Wische wuerden doppelt wirken");
  ok(/if \(reihe\.scrollLeft !== vorher\) ev\.preventDefault\(\)/.test(quelle),
    "der Handler schluckt das Rad auch dann, wenn er nichts bewegt hat");

  // Den echten Handler laufen lassen — an einer Attrappe der Reihe samt
  // Nachfahren, so wie die Aufklappmenues wirklich darin haengen.
  const rumpf = quelle.replace(/^[\s\S]*?\(function\(\)\{/, "(function(){");
  function bau(reihe) {
    // getComputedStyle liefert overflowY aus dem Knoten selbst.
    const gcs = (el) => ({ overflowY: el.overflowY || "visible" });
    new Function("document", "getComputedStyle", rumpf)({ querySelector: () => reihe }, gcs);
    return (ziel, dx, dy, tasten) => {
      let verhindert = false;
      reihe._f(Object.assign({ deltaX: dx, deltaY: dy, target: ziel,
        preventDefault() { verhindert = true; } }, tasten || {}));
      return verhindert;
    };
  }
  const reihe = { scrollWidth: 1148, clientWidth: 906, scrollLeft: 0, nodeType: 1,
    addEventListener(_t, f) { this._f = f; } };
  const knopf = { nodeType: 1, parentElement: reihe, scrollHeight: 36, clientHeight: 36 };
  const rad = bau(reihe);

  ok(rad(knopf, 0, 100) === true && reihe.scrollLeft === 100, `senkrechtes Rad bewegt die Reihe nicht (${reihe.scrollLeft})`);
  ok(rad(knopf, 0, 1000) === true && reihe.scrollLeft === 242, `die Reihe faehrt nicht sauber ans Ende (${reihe.scrollLeft})`);
  ok(rad(knopf, 0, 100) === false && reihe.scrollLeft === 242,
    "am Ende wird das Rad weiter geschluckt, obwohl sich nichts mehr bewegt");
  ok(rad(knopf, 0, -1000) === true && reihe.scrollLeft === 0, `zurueck an den Anfang geht nicht (${reihe.scrollLeft})`);
  ok(rad(knopf, 50, 0) === false, "eine waagrechte Geste wird zusaetzlich verarbeitet");

  // Strg+Rad und Cmd+Rad gehoeren dem Browser (Zoom).
  reihe.scrollLeft = 0;
  ok(rad(knopf, 0, 120, { ctrlKey: true }) === false && reihe.scrollLeft === 0,
    `Strg+Rad wird abgefangen — Browserzoom waere blockiert (scrollLeft ${reihe.scrollLeft})`);
  ok(rad(knopf, 0, 120, { metaKey: true }) === false && reihe.scrollLeft === 0,
    `Cmd+Rad wird abgefangen (scrollLeft ${reihe.scrollLeft})`);

  // Rad ueber einem offenen, senkrecht scrollbaren Menue: gehoert dem Menue.
  // (Gemessen: dockMenu hat 2153px Inhalt in einem 488px hohen Kasten und
  //  haengt als Nachfahre in der Reihe.)
  const menue = { nodeType: 1, parentElement: reihe, overflowY: "auto",
    scrollHeight: 2153, clientHeight: 488 };
  const menueZeile = { nodeType: 1, parentElement: menue, scrollHeight: 20, clientHeight: 20 };
  reihe.scrollLeft = 0;
  ok(rad(menue, 0, 150) === false && reihe.scrollLeft === 0,
    `das Rad ueber dem Menue bewegt die Reihe (scrollLeft ${reihe.scrollLeft})`);
  ok(rad(menueZeile, 0, 150) === false && reihe.scrollLeft === 0,
    "ein Rad auf einer Zeile IM Menue wird nicht bis zum Menue hinauf erkannt");
  // Auch beim Zurueckdrehen, und auch wenn das Menue schon gescrollt ist.
  menue.scrollTop = 1665;
  ok(rad(menueZeile, 0, -150) === false && reihe.scrollLeft === 0,
    "beim Zurueckdrehen im Menue uebernimmt die Reihe doch");
  // Ein Textknoten als Ziel darf den Aufstieg nicht abbrechen.
  ok(rad({ nodeType: 3, parentElement: menueZeile }, 0, 150) === false && reihe.scrollLeft === 0,
    "ein Textknoten im Menue laesst den Aufstieg scheitern");
  // Ein nicht scrollbarer Kasten mit overflow-y:auto darf NICHT ausnehmen.
  const kurz = { nodeType: 1, parentElement: reihe, overflowY: "auto", scrollHeight: 40, clientHeight: 40 };
  reihe.scrollLeft = 0;
  ok(rad(kurz, 0, 100) === true && reihe.scrollLeft === 100,
    "ein Kasten ohne verborgenen Inhalt nimmt die Reihe faelschlich aus");

  const eng = { scrollWidth: 400, clientWidth: 400, scrollLeft: 0, nodeType: 1,
    addEventListener(_t, f) { this._f = f; } };
  const radEng = bau(eng);
  ok(radEng({ nodeType: 1, parentElement: eng }, 0, 100) === false && eng.scrollLeft === 0,
    "ohne verborgenen Inhalt wird das Rad trotzdem abgefangen");
}

// ═══ 5. Was NICHT anders werden durfte ════════════════════════════════════
for (const breite of [1440, 1280, 1024]) {
  ok(wert(".topbar", "height", breite) === "52px",
    `${breite}px: die Kopfzeile ist nicht mehr 52px hoch (${wert(".topbar", "height", breite)})`);
  ok(/^52px/.test(wert(".app", "grid-template-rows", breite) || ""),
    `${breite}px: die Rasterzeile der Kopfzeile hat sich geaendert`);
  ok(wert(".topbar", "flex-wrap", breite) === null,
    `${breite}px: hier darf die Kopfzeile nicht umbrechen`);
}
for (const breite of [900, 768, 390]) {
  ok(wert(".topbar", "height", breite) === "auto", `${breite}px: die schmale Korrektur aus PR249 ist weg`);
  ok(wert(".topbar-center", "flex", breite) === "0 0 100%", `${breite}px: die Suchzeile verliert ihre eigene Reihe`);
}

ok(/name="quantus-build"[^>]*kopfzeile-desktop/.test(index),
  "die Bau-Kennung nennt die Aenderung nicht");

if (luecken.length) {
  console.error(`kopfzeile desktop: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`kopfzeile desktop: ${checks} Pruefungen bestanden`);
