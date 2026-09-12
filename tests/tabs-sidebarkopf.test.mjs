/*
 * Tab-Leiste ueber dem Kopf der Seitenleiste — und ein ✕, das nie gebunden war.
 *
 * PRODUKTIONSBEFUND (live gemessen, management-xo2-pro, Tabmodus mit
 * angehefteter Leiste):
 *
 *   390x844 und 768x1024, body: "tabs-on mode-tablet"
 *     #browserTabBar ist fixiert, top:0, 38 px hoch, z-index 2147483600.
 *     .sidebar ist in dieser Breite ebenfalls fixiert (top:0, z-index 500).
 *     Der Kopf der ausgeklappten Leiste lag damit UNTER der Tab-Leiste:
 *       document.elementsFromPoint(201,34)  ->  .bt-tab  statt  #sidebarCloseBtn
 *     Playwright meldete beim Klick auf das ✕ woertlich
 *       "<div id=\"browserTabBar\">…</div> intercepts pointer events".
 *     Das body-Padding von 38px hilft dort nichts: es verschiebt den Fluss,
 *     ein fixiertes Element haengt am Viewport.
 *
 *   Zweiter, unabhaengiger Befund derselben Messung: nachdem das ✕ frei lag,
 *   passierte beim Klick trotzdem NICHTS. Im Browser gemessen:
 *       typeof window.setSidebarCollapsed === "undefined"
 *       document.getElementById("sidebarCloseBtn").onclick === null
 *       document.getElementById("sidebarScrim").onclick   === null
 *       document.getElementById("sidebarToggleBtn").onclick === "function"
 *   Grund: index.html deklariert `init` ZWEIMAL (erst `function init()`, spaeter
 *   `async function init()`). Die spaetere Deklaration gewinnt, die fruehere
 *   laeuft nie — und genau dort standen setSidebarCollapsed sowie die Bindung
 *   von ✕ und Backdrop. tests/m6-sidebar-close.test.mjs prueft seither die
 *   TOTE Fassung und war deshalb gruen, waehrend im Browser nichts geschah.
 *   Diese Datei prueft, dass die Bindung in der Fassung steht, die laeuft.
 *
 *   Ausdruecklich NICHT Teil des Befunds: der seitliche #sidebarToggleBtn
 *   (top:60px) lag schon vorher unter der Leiste und hat funktioniert. Die
 *   Leiste war also nie grundsaetzlich unverschliessbar.
 *
 * Geprueft wird gegen die ECHTEN Regeln und die ECHTE Funktion aus
 * public/index.html. Kein Browser, kein Netz, keine Datei wird geschrieben.
 * Der Browserlauf dazu: scripts/tableiste-sidebarkopf-browsercheck.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };

// ═══ CSS: flache Regeln und @media(max-width) ═══════════════════════════
/* Jeder <style>-Block wird EINZELN geparst. Aneinandergehaengt verlaeuft sich
   die Klammerzaehlung irgendwo in den 628'000 Zeichen CSS (eine Klammer in
   einem Inhaltswert genuegt) — gemessen: 2030 statt 4998 Regeln, und die
   Tab-Bar-Regeln fielen still hinten runter. Blockweise bleibt ein solcher
   Schaden lokal. */
const BLOECKE = (index.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
  .map((b) => b.replace(/^<style[^>]*>/i, "").replace(/<\/style>$/i, ""));
ok(BLOECKE.join("").length > 10000, `die <style>-Bloecke wurden nicht gelesen (${BLOECKE.length})`);

function regelnLesen(bloecke) {
  const out = []; let ordnung = 0;
  function block(text, fenster) {
    let j = 0;
    while (j < text.length) {
      const auf = text.indexOf("{", j);
      if (auf < 0) break;
      const kopf = text.slice(j, auf).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      let tiefe = 1, k = auf + 1;
      while (k < text.length && tiefe > 0) { if (text[k] === "{") tiefe++; else if (text[k] === "}") tiefe--; k++; }
      const inhalt = text.slice(auf + 1, k - 1);
      if (kopf.startsWith("@media")) {
        const mm = /max-width\s*:\s*(\d+)px/.exec(kopf);
        block(inhalt, mm ? Number(mm[1]) : fenster);
      } else if (!kopf.startsWith("@") && kopf) {
        for (const sel of kopf.split(",")) {
          const t = sel.trim();
          if (t) out.push({ selektor: t, dekl: inhalt, fenster: fenster ?? null, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  }
  for (const b of bloecke) block(b, null);
  return out;
}
const REGELN = regelnLesen(BLOECKE);
ok(REGELN.length > 3000, `zu wenige Regeln gelesen (${REGELN.length}) — der Parser passt nicht mehr`);

/* Spezifitaet (a,b,c) ohne Pseudoelemente; :not(x) zaehlt wie x. */
function spez(sel) {
  const s = sel.replace(/:not\(([^)]*)\)/g, " $1 ");
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const kl = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length
    + (s.match(/:(?!:)(?!not\b)[\w-]+/g) || []).length;
  const el = (s.replace(/[#.][\w-]+/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, kl, el];
}
const hoeher = (a, b) => a[0] !== b[0] ? a[0] > b[0] : (a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2]);

/* Welcher Wert gilt fuer ein Element mit den Klassen `klassen` bei Breite
   `breite`? Nur die Regeln, deren Selektor auf genau dieses Element passt. */
function gilt(_unbenutzt, eigenschaft, breite, treffer) {
  const besser = (a, b) => {
    if (a.wichtig !== b.wichtig) return a.wichtig;
    for (let i = 0; i < 3; i++) if (a.spez[i] !== b.spez[i]) return a.spez[i] > b.spez[i];
    return a.ordnung > b.ordnung;           // gleich spezifisch: die spaetere gewinnt
  };
  let best = null;
  for (const r of REGELN) {
    if (r.fenster !== null && breite > r.fenster) continue;
    if (!treffer(r.selektor)) continue;
    const dekl = r.dekl.replace(/\/\*[\s\S]*?\*\//g, "");
    const re = new RegExp("(^|;|\\s)" + eigenschaft + "\\s*:\\s*([^;}]+)", "g");
    let m, letzter = null;
    while ((m = re.exec(dekl))) letzter = m[2].trim();
    if (letzter === null) continue;
    const kand = { wert: letzter.replace(/\s*!important/, "").trim(), wichtig: /!important/.test(letzter),
      spez: spez(r.selektor), ordnung: r.ordnung, selektor: r.selektor };
    if (!best || besser(kand, best)) best = kand;
  }
  return best;
}
const zahl = (w) => (w ? Number(String(w).replace("px", "")) : NaN);

// ── Die Tab-Leiste bleibt, wie sie ist: oben, 38px, ganz vorn ──────────
const barHoehe = zahl(gilt(null, "height", 390, (s) => s === "#browserTabBar")?.wert);
ok(barHoehe === 38, `die Tab-Leiste ist ${barHoehe}px hoch — der Versatz unten muss mitziehen`);
ok(zahl(gilt(null, "z-index", 390, (s) => s === "#browserTabBar")?.wert) > 1000,
  "die Tab-Leiste hat ihren hohen z-index verloren — dann loest sie andere Ueberlagerungen aus");
ok(zahl(gilt(null, "z-index", 390, (s) => s === "body.mode-tablet .sidebar")?.wert) === 500,
  "die schmale Seitenleiste hat ihren z-index 500 verloren");
ok(zahl(gilt(null, "padding-top", 390, (s) => s === "body.tabs-on")?.wert) === barHoehe,
  "body.tabs-on gleicht die Leiste nicht mehr mit padding-top aus");

/* Die Korrektur selbst: im Tabmodus beginnt die fixierte Seitenleiste unter
   der Tab-Leiste — auf beiden Wegen, ueber die die schmale Darstellung
   erreicht wird (Klasse mode-tablet und der 900er-Media-Block). */
const schmalTablet = (s) => /(^|\s)(body\.[\w.-]*\s*)?\.sidebar$/.test(s) && (!/body\./.test(s) || /mode-tablet/.test(s))
  && (!/tabs-on/.test(s) || /tabs-on/.test(s));
for (const [breite, klassen] of [[390, "tabs-on mode-tablet"], [768, "tabs-on mode-tablet"], [1000, "tabs-on mode-tablet"]]) {
  const t = gilt(null, "top", breite, (s) => {
    // Selektoren, die auf <aside class="sidebar"> in body.tabs-on.mode-tablet
    // innerhalb von .app (nicht eingeklappt) passen.
    if (!/\.sidebar$/.test(s)) return false;
    const koerper = /^body[\w.-]*/.exec(s);
    if (koerper && /mode-(computer|laptop)/.test(koerper[0])) return false;
    if (koerper && /tabs-off/.test(koerper[0])) return false;
    return true;
  });
  ok(zahl(t?.wert) === barHoehe,
    `${breite}px (${klassen}): die Seitenleiste beginnt bei "${t?.wert}" statt ${barHoehe}px — sie liegt wieder unter der Tab-Leiste (Regel: ${t?.selektor})`);
}

// Ohne Tabmodus bleibt alles beim Alten: die Leiste beginnt ganz oben.
for (const breite of [390, 768]) {
  const t = gilt(null, "top", breite, (s) => /\.sidebar$/.test(s) && !/tabs-on/.test(s));
  ok(zahl(t?.wert) === 0, `${breite}px ohne Tabmodus: die Seitenleiste beginnt bei "${t?.wert}" statt 0`);
}

// Der Backdrop rueckt mit, damit die Tab-Leiste bedienbar bleibt.
{
  const t = gilt(null, "top", 390, (s) => /\.sidebar-scrim$/.test(s) && /tabs-on/.test(s));
  ok(zahl(t?.wert) === barHoehe, `der Backdrop beginnt bei "${t?.wert}" statt ${barHoehe}px`);
}

// Breite Schirme: die Leiste steht in der Rasterspur, kein Versatz, kein ✕.
for (const breite of [1280, 1440]) {
  const versatz = REGELN.some((r) => /tabs-on/.test(r.selektor) && /\.sidebar$/.test(r.selektor)
    && (r.fenster === null ? !/mode-tablet/.test(r.selektor) : breite <= r.fenster));
  ok(!versatz, `${breite}px: eine Versatzregel greift bis auf den breiten Schirm durch`);
}

// Kein !important — die Regel gewinnt ueber Spezifitaet, wie der Rest der Datei.
for (const r of REGELN.filter((x) => /tabs-on/.test(x.selektor) && /(\.sidebar|\.sidebar-scrim)$/.test(x.selektor))) {
  ok(!/!important/.test(r.dekl), `die Regel "${r.selektor}" arbeitet mit !important`);
}

// ═══ Der zweite Befund: die Bindung muss im LEBENDEN init stehen ════════
const initStellen = [...index.matchAll(/^(?:async )?function init\(\) \{/gm)].map((m) => m.index);
ok(initStellen.length >= 2,
  `es gibt nur ${initStellen.length} init-Deklaration(en) — falls die Dublette aufgeloest wurde, ist diese Pruefung neu zu fassen`);
const lebend = initStellen[initStellen.length - 1];   // die letzte Deklaration gewinnt
const ende = index.indexOf("\n}\n", index.indexOf("Init error details", lebend));
ok(ende > lebend, "das Ende des laufenden init wurde nicht gefunden");
const koerper = index.slice(lebend, ende);
ok(koerper.includes("Init failsafe triggered"),
  "der gelesene init-Koerper ist nicht der erwartete — die Pruefung waere blind");

ok(/function setSidebarCollapsed\(zu\)/.test(koerper),
  "setSidebarCollapsed steht nicht im init, das wirklich laeuft — genau daran lag der Befund");
ok(/window\.setSidebarCollapsed\s*=\s*setSidebarCollapsed/.test(koerper),
  "setSidebarCollapsed haengt im laufenden init nicht an window");
for (const [was, muster] of [
  ["das ✕", /sidebarCloseBtn[\s\S]{0,260}?setSidebarCollapsed\(true\)/],
  ["der Backdrop", /sidebarScrim[\s\S]{0,260}?setSidebarCollapsed\(true\)/],
  ["der Umschalter", /sidebarToggleBtn\.onclick[\s\S]{0,300}?setSidebarCollapsed\(/],
]) {
  ok(muster.test(koerper.replace(/^\s*\/\/.*$/gm, "")),
    `${was} ist im laufenden init nicht an setSidebarCollapsed gebunden`);
}
// Kein Schliessweg navigiert oder rendert.
{
  const a = koerper.indexOf("const sidebarCloseBtn");
  const b = koerper.indexOf("// Navigation buttons");
  const teil = koerper.slice(a, b > a ? b : a + 3000).replace(/^\s*\/\/.*$/gm, "");
  for (const v of ["location.hash", "render()", "openApp(", "closeApp"]) {
    ok(!teil.includes(v), `ein Schliessweg ruft ${v}`);
  }
}

// ═══ VERHALTEN: die echte Funktion aus dem laufenden init ══════════════
{
  const a = koerper.indexOf("    function setSidebarCollapsed(zu) {");
  ok(a > 0, "die laufende setSidebarCollapsed wurde nicht gefunden");
  if (a > 0) {
    const src = koerper.slice(a, koerper.indexOf("\n    window.setSidebarCollapsed", a));
    const klassen = new Set();
    const attr = {}, speicher = {};
    const knoten = {
      app: { classList: { toggle: (k, an) => { if (an) klassen.add(k); else klassen.delete(k); },
        contains: (k) => klassen.has(k) } },
      sidebarToggleBtn: { textContent: "◀", setAttribute: (k, v) => { attr["tog:" + k] = v; } },
      sidebarScrim: { setAttribute: (k, v) => { attr["scrim:" + k] = v; } },
    };
    const fn = new Function("$", "localStorage", src + "\nreturn setSidebarCollapsed;")(
      (sel) => knoten[String(sel).replace("#", "")] || null,
      { setItem: (k, v) => { speicher[k] = v; }, getItem: (k) => speicher[k] });

    fn(true);
    ok(klassen.has("sidebar-collapsed"), "setSidebarCollapsed(true) schliesst die Leiste nicht");
    ok(knoten.sidebarToggleBtn.textContent === "▶", `die Beschriftung ist "${knoten.sidebarToggleBtn.textContent}"`);
    ok(attr["tog:aria-expanded"] === "false", `aria-expanded ist "${attr["tog:aria-expanded"]}"`);
    ok(attr["scrim:aria-hidden"] === "true", "der Backdrop bleibt fuer Hilfsmittel sichtbar");
    ok(speicher["sidebar-collapsed"] === "1", "der geschlossene Zustand wurde nicht gemerkt");

    fn(false);
    ok(!klassen.has("sidebar-collapsed"), "setSidebarCollapsed(false) oeffnet nicht");
    ok(knoten.sidebarToggleBtn.textContent === "◀", "die Beschriftung wurde beim Oeffnen nicht nachgezogen");
    ok(attr["tog:aria-expanded"] === "true", "aria-expanded beim Oeffnen falsch");
    ok(speicher["sidebar-collapsed"] === "0", "der offene Zustand wurde nicht gemerkt");

    // Sie fasst NUR die Leiste an: kein Datenmodell, kein Abgleich, keine Route.
    for (const v of ["APP.state", "scheduleSave", "location.hash", "render("]) {
      ok(!src.includes(v), `setSidebarCollapsed greift auf ${v} zu`);
    }
  }
}

// ═══ Markup und Nachbarschaft unberuehrt ═══════════════════════════════
ok(/id="sidebarCloseBtn"[^>]*aria-controls="sidebar"/.test(index), "das ✕ benennt die Leiste nicht mehr");
ok(/id="sidebarScrim"/.test(index), "der Backdrop fehlt im Markup");
for (const anker of [
  "body.tabs-on .noteflow-container,",
  "body.tabs-on .rh-sidebar {",
  "body.mode-tablet .sidebar{position:fixed;left:0;top:0;bottom:0;width:240px;z-index:500;box-shadow:var(--shadow-lg)}",
  "body.mode-tablet .sidebar-toggle-btn{left:8px;top:60px;width:44px;height:44px;font-size:16px}",
  "function setTabsEnabled(on) {",
]) {
  ok(index.includes(anker), `ein fremder Bereich wurde beruehrt: "${anker}" fehlt`);
}
ok(/name="quantus-build"[^>]*tabs-sidebarkopf/.test(index), "die Bau-Kennung nennt die Aenderung nicht");

if (luecken.length) {
  console.error(`tabs sidebarkopf: ${luecken.length} von ${checks} Pruefungen offen`);
  for (const l of luecken) console.error("  - " + l);
  process.exit(1);
}
console.log(`tabs sidebarkopf: ok (${checks} Pruefungen)`);
