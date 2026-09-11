/*
 * Seitenmodus im Computermodus — Raster, Lebenszyklus der Schnellansicht und
 * Wiederherstellung interner Tabs.
 *
 * PRODUKTIONSBEFUND (Quantus-Aufgabe f6fee275, offen seit 20.07.):
 *
 * 1. RASTER. Die Kollapsregeln standen als NACHFAHREN-Selektor da:
 *        .grid-12 .col-4 { grid-column: span 12 }
 *    Gemeint war die grosse Seitenspalte (direktes Kind von .grid-12), getroffen
 *    wurde zusaetzlich jedes Formularfeld, das in dieser Spalte steckt — denn
 *    .form traegt dieselben col-Klassen. Die Schwelle lag bei 1200px, gemessen
 *    am Inhaltsbereich (@container). Bei 1440px Fensterbreite ist der
 *    Inhaltsbereich mit Seitenleiste genau 1200 — die Regel griff also auf dem
 *    typischen Laptopbildschirm. Ergebnis im Browser gemessen: jede Detailseite
 *    eine einzige Spalte, Titelfeld 1114px breit, 1 Feld pro Reihe.
 *    Nach der Trennung (Seitensplit ueber ">", Formular mit eigener Staffel):
 *    3 Felder pro Reihe, Formular 618px, kein Querlauf bei 1440/1280/1024/768/390.
 *
 * 2. SCHNELLANSICHT. closeSlidePanel() nahm nur die Klasse .open weg. Ohne sie
 *    war das Panel opacity:0 und pointer-events:none — also unsichtbar und
 *    mausdicht, aber weiterhin im Layout, im Tabbfluss und im Vorlesebaum, samt
 *    ausgefuellter Formularfelder. Nach „Vollstaendig oeffnen" standen deshalb
 *    ZWEI Statusfelder zugleich bereit; im Browser nachgemessen nimmt das Feld
 *    der geschlossenen Schnellansicht den Fokus an. Beim Tabwechsel (der die
 *    Adresse per history.replaceState umschreibt, ohne hashchange) blieb das
 *    Panel sogar voll sichtbar ueber der neuen Seite liegen.
 *
 * 3. TABS. Die Tabliste liegt im localStorage und gilt fuer das ganze
 *    Browserprofil. initTabs() zog den zuletzt aktiven Vollbild-Tab nach 1,5 s
 *    ueber die App — auch in einem frisch geoeffneten Browsertab mit der
 *    Basis-Adresse. NoteFlow deckt mit position:fixed;inset:0 auch den
 *    Quantus-Kopf zu, waehrend die Adresszeile Dashboard sagte.
 *
 * Geprueft wird gegen die ECHTEN Regeln und die ECHTEN Funktionen aus
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

// ═══ CSS lesen: flache Regeln, @media(max-width) und @container(max-width) ══
function regelnLesen(css) {
  const regeln = [];
  let ordnung = 0;
  function block(text, fenster, container) {
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
        block(inhalt, mm ? Number(mm[1]) : fenster, container);
      } else if (kopf.startsWith("@container")) {
        const cm = /max-width\s*:\s*(\d+)px/.exec(kopf);
        block(inhalt, fenster, cm ? Number(cm[1]) : container);
      } else if (kopf.startsWith("@")) {
        /* @keyframes, @supports … hier ohne Belang */
      } else if (kopf) {
        for (const sel of kopf.split(",")) {
          const s = sel.trim();
          if (s) regeln.push({ selektor: s, deklarationen: inhalt, fenster, container, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  }
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m; const teile = [];
  while ((m = re.exec(index))) teile.push(m[1]);
  block(teile.join("\n"), null, null);
  return regeln;
}
const REGELN = regelnLesen(index);
ok(REGELN.length > 500, `zu wenige Regeln geparst (${REGELN.length}) — der Parser passt nicht mehr`);

function spezifitaet(sel) {
  let a = 0, b = 0, c = 0;
  for (const teil of sel.replace(/:not\(([^)]*)\)/g, " $1 ").split(/[\s>+~]+/)) {
    if (!teil) continue;
    a += (teil.match(/#[\w-]+/g) || []).length;
    b += (teil.match(/\.[\w-]+/g) || []).length;
    b += (teil.match(/\[[^\]]*\]/g) || []).length;
    b += (teil.match(/:[\w-]+/g) || []).length;
    const el = teil.replace(/[#.:[][^#.:[]*/g, "").trim();
    if (el && el !== "*") c += 1;
  }
  return a * 10000 + b * 100 + c;
}

/*
 * Matcher fuer eine feste Ahnenkette, MIT Kindkombinator. Genau das ist der
 * Unterschied, um den es hier geht: ">" darf die Formularfelder nicht mehr
 * treffen, " " (Leerzeichen) hat sie getroffen.
 */
function knotenPasst(compound, knoten) {
  const rest = compound.replace(/:not\([^)]*\)/g, "");
  const ids = (rest.match(/#[\w-]+/g) || []).map((x) => x.slice(1));
  const klassen = (rest.match(/\.[\w-]+/g) || []).map((x) => x.slice(1));
  const attr = [...rest.matchAll(/\[class\*="([^"]+)"\]/g)].map((x) => x[1]);
  const el = rest.replace(/\[[^\]]*\]/g, "").replace(/[#.][\w-]+/g, "").replace(/:[\w-]+/g, "").trim();
  if (el && el !== "*" && el !== knoten.el) return false;
  if (ids.some((x) => !(knoten.ids || []).includes(x))) return false;
  if (klassen.some((x) => !knoten.klassen.includes(x))) return false;
  if (attr.some((p) => !knoten.klassen.some((kl) => kl.includes(p)))) return false;
  return true;
}
function passt(sel, kette) {
  const teile = sel.trim().split(/\s+/).filter(Boolean);
  let k = kette.length - 1;
  let erwarteKind = false;
  // Der rechteste Teil muss das ZIEL selbst treffen, nicht irgendeinen Ahnen.
  if (!teile.length || !knotenPasst(teile[teile.length - 1], kette[k])) return false;
  for (let t = teile.length - 1; t >= 0; t--) {
    if (teile[t] === ">") { erwarteKind = true; continue; }
    if (erwarteKind) {
      if (k < 0 || !knotenPasst(teile[t], kette[k])) return false;
      k--; erwarteKind = false; continue;
    }
    let gefunden = false;
    while (k >= 0) { if (knotenPasst(teile[t], kette[k])) { gefunden = true; k--; break; } k--; }
    if (!gefunden) return false;
  }
  return true;
}
function aufloesen(eigenschaft, kette, fensterBreite, containerBreite) {
  let best = null;
  for (const r of REGELN) {
    if (r.fenster !== null && fensterBreite > r.fenster) continue;
    if (r.container !== null && containerBreite > r.container) continue;
    if (!passt(r.selektor, kette)) continue;
    const re = new RegExp("(?:^|;)\\s*" + eigenschaft + "\\s*:\\s*([^;}]+)", "i");
    const mm = re.exec(r.deklarationen);
    if (!mm) continue;
    const gewicht = spezifitaet(r.selektor);
    if (!best || gewicht > best.gewicht || (gewicht === best.gewicht && r.ordnung > best.ordnung))
      best = { gewicht, ordnung: r.ordnung, wert: mm[1].trim() };
  }
  return best ? best.wert : null;
}

// Kontrolle des Rechners an bekannten Werten
ok(spezifitaet(".col-4") === 100, "Spezifitaet .col-4 falsch berechnet");
ok(spezifitaet(".grid-12 > .col-8") === 200, "Spezifitaet .grid-12 > .col-8 falsch berechnet");

// ── Die beiden Lagen, um die es geht ──────────────────────────────────────
const seitenspalte = [
  { el: "div", klassen: ["main"] },
  { el: "div", klassen: ["page"] },
  { el: "div", klassen: ["grid", "grid-12"] },
  { el: "div", klassen: ["col-8"] },
];
const formularfeld = [
  { el: "div", klassen: ["main"] },
  { el: "div", klassen: ["page"] },
  { el: "div", klassen: ["grid", "grid-12"] },
  { el: "div", klassen: ["col-8"] },
  { el: "div", klassen: ["card"] },
  { el: "div", klassen: ["form"] },
  { el: "label", klassen: ["col-4"] },
];

// 1440px Fenster, Inhaltsbereich 1200px — die im Browser gemessene Lage.
ok(aufloesen("grid-column", formularfeld, 1440, 1200) !== "span 12",
  "1440/1200: das Formularfeld col-4 faellt weiterhin auf volle Breite — der Nachfahren-Selektor lebt noch");
ok(aufloesen("grid-column", formularfeld, 1440, 1200) === "span 4",
  `1440/1200: col-4 im Formular sollte span 4 bleiben, ist aber ${aufloesen("grid-column", formularfeld, 1440, 1200)}`);
ok(aufloesen("grid-column", seitenspalte, 1440, 1200) === "span 7",
  `1440/1200: die Seitenspalte col-8 sollte span 7 sein, ist aber ${aufloesen("grid-column", seitenspalte, 1440, 1200)}`);

// 1280px Fenster, Inhaltsbereich 1040px: Seitensplit stapelt, Formular bleibt mehrspaltig.
ok(aufloesen("grid-column", seitenspalte, 1280, 1040) === "span 12",
  "1280/1040: die Seitenspalte sollte stapeln");
ok(aufloesen("grid-column", formularfeld, 1280, 1040) === "span 4",
  `1280/1040: das Formularfeld sollte mehrspaltig bleiben, ist aber ${aufloesen("grid-column", formularfeld, 1280, 1040)}`);

// Enger Inhaltsbereich: erst zwei nebeneinander, ganz schmal untereinander.
ok(aufloesen("grid-column", formularfeld, 900, 700) === "span 6",
  `700er Inhaltsbereich: col-4 sollte span 6 werden, ist aber ${aufloesen("grid-column", formularfeld, 900, 700)}`);
ok(aufloesen("grid-column", formularfeld, 390, 360) === "span 12",
  `360er Inhaltsbereich: col-4 sollte volle Breite werden, ist aber ${aufloesen("grid-column", formularfeld, 390, 360)}`);

// Kein Nachfahren-Kollaps mehr im Bestand (das war die Ursache).
const nachfahren = REGELN.filter((r) => /^\.grid-12\s+\.col-\d+$/.test(r.selektor) && /span\s*12/.test(r.deklarationen));
ok(nachfahren.length === 0,
  `es gibt noch ${nachfahren.length} Nachfahren-Kollapsregeln .grid-12 .col-N{span 12}`);

// ═══ Schnellansicht: geschlossen heisst geschlossen ════════════════════════
const zu   = REGELN.filter((r) => r.selektor === ".slide-panel");
const auf  = REGELN.filter((r) => r.selektor === ".slide-panel.open");
ok(zu.some((r) => /visibility\s*:\s*hidden/.test(r.deklarationen)),
  ".slide-panel (geschlossen) hat kein visibility:hidden — Felder bleiben fokussierbar");
ok(auf.some((r) => /visibility\s*:\s*visible/.test(r.deklarationen)),
  ".slide-panel.open hat kein visibility:visible — das Panel liesse sich nicht mehr oeffnen");
ok(zu.some((r) => /transition\s*:[^;}]*visibility\s+0s\s+linear\s+\.25s/.test(r.deklarationen)),
  "der Sichtbarkeitswechsel wird nicht ans Ende der Blende gelegt — das Zuklappen waere nicht mehr zu sehen");
ok(REGELN.some((r) => r.selektor === ".slide-panel-backdrop" && /visibility\s*:\s*hidden/.test(r.deklarationen)),
  "der Hintergrund der Schnellansicht bleibt im Baum stehen");

function schneide(quelle, start, ende) {
  const a = quelle.indexOf(start);
  if (a < 0) return null;
  const b = quelle.indexOf(ende, a);
  return b < 0 ? null : quelle.slice(a, b);
}
const closeQuelle = schneide(index, "function closeSlidePanel()", "\n// ====");
ok(!!closeQuelle, "closeSlidePanel() nicht gefunden");
if (closeQuelle) {
  ok(/setAttribute\("inert"/.test(closeQuelle), "closeSlidePanel setzt kein inert");
  ok(/setAttribute\("aria-hidden", "true"\)/.test(closeQuelle), "closeSlidePanel setzt kein aria-hidden");
  ok(/slidePanelBody/.test(closeQuelle) && /innerHTML = ""/.test(closeQuelle),
    "closeSlidePanel leert den Rumpf nicht — die Felder der Schnellansicht bleiben im Dokument");
  ok(/classList\.contains\("open"\)\) return/.test(closeQuelle),
    "das verzoegerte Leeren prueft nicht, ob die Schnellansicht inzwischen wieder offen ist");
}
const openQuelle = schneide(index, "function openSlidePanel(kind, id)", "function closeSlidePanel()");
ok(!!openQuelle, "openSlidePanel() nicht gefunden");
if (openQuelle) {
  ok(/clearTimeout\(window\._slideLeerUhr\)/.test(openQuelle),
    "openSlidePanel bestellt das laufende Aufraeumen nicht ab — es wuerde den frischen Rumpf leeren");
  ok(/removeAttribute\("inert"\)/.test(openQuelle) && /removeAttribute\("aria-hidden"\)/.test(openQuelle),
    "openSlidePanel nimmt inert/aria-hidden nicht zurueck");
}

// Der Lebenszyklus haengt an genau einer Stelle im Seitenaufbau.
const renderQuelle = schneide(index, "function renderMain()", "// ═══ Globaler App-Lock-Check");
ok(!!renderQuelle, "renderMain() nicht gefunden");
if (renderQuelle) {
  ok(/_panelOrt\s*=\s*route \+ "\|" \+ \(id \|\| ""\)/.test(renderQuelle),
    "die Ortsmarke der Schnellansicht enthaelt die id nicht — #/tasks -> #/tasks/<id> bliebe unbemerkt");
  ok(/if \(APP\.state\.ui\.slidePanel\) closeSlidePanel\(\)/.test(renderQuelle),
    "renderMain schliesst die Schnellansicht beim Ortswechsel nicht");
  const a = renderQuelle.indexOf("_lastPanelOrt !== _panelOrt");
  const b = renderQuelle.indexOf("window._lastPanelOrt = _panelOrt");
  ok(a > 0 && b > a, "die Ortsmarke wird gesetzt, bevor sie verglichen wird — der Wechsel faellt aus");
  ok(/window\._lastPanelOrt !== undefined/.test(renderQuelle),
    "der erste Aufbau wird nicht als Wechsel ausgenommen");
}

// ═══ Stehengebliebene Dialoge ══════════════════════════════════════════════
// Ein Dialog blieb ueber jeden Seiten- und Tabwechsel hinweg offen (im Browser
// nachgemessen: nach #/tasks -> #/dashboard weiterhin display:flex). Abgeraeumt
// wird er nur, wenn er zur VERLASSENEN Seite gehoert — wer erst navigiert und
// dann fragt, behaelt seinen Dialog.
const openModalQuelle = schneide(index, 'function openModal(title, body, footer = "")', "function closeModal()");
ok(!!openModalQuelle, "openModal() nicht gefunden");
if (openModalQuelle) {
  ok(/window\._modalOrt = modalOrtJetzt\(\)/.test(openModalQuelle),
    "openModal merkt sich die Seite nicht — ein Dialog zur neuen Seite wuerde sofort abgeraeumt");
}
const ortQuelle = schneide(index, "function modalOrtJetzt()", "\n// ====");
ok(!!ortQuelle && /h\.route \+ "\|" \+ \(h\.id \|\| ""\)/.test(ortQuelle),
  "modalOrtJetzt() fehlt oder laesst die id weg");
if (renderQuelle) {
  ok(/_mb\.classList\.contains\("open"\) && window\._modalOrt && window\._modalOrt !== _panelOrt/.test(renderQuelle),
    "der Dialog wird beim Seitenwechsel nicht oder ohne Herkunftspruefung geschlossen");
  ok(/closeModal\(\);/.test(renderQuelle), "renderMain schliesst den stehengebliebenen Dialog nicht");
}

// ═══ Tabs: die Adresse gewinnt ═════════════════════════════════════════════
const hubQuelle = schneide(index, "function hubWiederherstellenErlaubt()", "\nfunction initTabs()");
ok(!!hubQuelle, "hubWiederherstellenErlaubt() nicht gefunden");
if (hubQuelle) {
  const fn = new Function("window", "performance", hubQuelle + "\nreturn hubWiederherstellenErlaubt;");
  const lauf = (hash, navTyp) => fn(
    { location: { hash } },
    { getEntriesByType: (t) => (t === "navigation" && navTyp ? [{ type: navTyp }] : []) }
  )();
  ok(lauf("", "reload") === true, "Neuladen der Basis-Adresse soll die Ansicht wiederherstellen");
  ok(lauf("#/dashboard", "reload") === true, "Neuladen auf dem Dashboard soll wiederherstellen");
  ok(lauf("", "navigate") === false, "ein frisch geoeffneter Browsertab darf kein Overlay wiederherstellen");
  ok(lauf("#/tasks/t1", "reload") === false, "eine konkrete Route darf nicht ueberdeckt werden");
  ok(lauf("#/notes", "navigate") === false, "ohne Neuladen wird nichts wiederhergestellt");
  ok(lauf("", null) === false, "ohne Auskunft ueber die Navigationsart wird nicht ueberdeckt");
}
const initQuelle = schneide(index, "function initTabs()", "function escHTML(s)");
ok(!!initQuelle, "initTabs() nicht gefunden");
if (initQuelle) {
  ok(/if \(_hubKind && !hubWiederherstellenErlaubt\(\)\)/.test(initQuelle),
    "initTabs fragt vor dem Wiederherstellen nicht nach der Adresse");
  ok(/_activeTabId = zurueck\.id/.test(initQuelle),
    "die Tabmarkierung wandert nicht auf den passenden Tab — Leiste und Inhalt saegen dann Verschiedenes");
  ok(/applyView\(active\)/.test(initQuelle),
    "der Weg zum Wiederherstellen ist verschwunden — Neuladen wuerde nicht mehr zurueckfinden");
}

// ═══ Computermodus: Raender und Lesebreite ════════════════════════════════
ok(REGELN.some((r) => r.selektor === "body.mode-computer .main" && /padding\s*:\s*20px clamp\(24px,2\.2vw,64px\) 48px/.test(r.deklarationen)),
  "die Raender im Computermodus wachsen nicht mit dem Bildschirm");
ok(REGELN.some((r) => r.selektor === ".main .card > .form" && /max-width\s*:\s*1160px/.test(r.deklarationen)),
  "Formularkarten haben keine Lesebreite — auf sehr breiten Bildschirmen laeuft ein Eingabefeld ueber die ganze Breite");
ok(REGELN.some((r) => r.selektor === "body.mode-computer .main .page" && /max-width\s*:\s*none/.test(r.deklarationen)),
  "der Computermodus begrenzt die Seite jetzt doch — Uebersichten sollen die Breite behalten");

// ═══ Bau-Kennung ═══════════════════════════════════════════════════════════
ok(/name="quantus-build"[^>]*seitenmodus-computer/.test(index),
  "die Bau-Kennung nennt die Aenderung nicht");

if (luecken.length) {
  console.error(`seitenmodus-computer: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`seitenmodus-computer: ${checks} Pruefungen bestanden`);
