/*
 * M6 — die Haupt-Seitenleiste laesst sich auf dem Telefon wieder schliessen.
 *
 * BEFUND (Telefon, Bildschirmfoto): bei <=900 px liegt .sidebar als fixiertes
 * Overlay mit z-index 500 ueber dem Inhalt. Der EINZIGE Weg zurueck war
 * #sidebarToggleBtn — 28x28 px, bei left:248px, also genau auf der Lupe der
 * Topbar. Es gab keinen Backdrop und keinen sichtbaren Schliesser in der Leiste
 * selbst. Wer die Leiste geoeffnet hatte, kam nicht mehr heraus.
 *
 * Jetzt drei offensichtliche Wege, alle durch DENSELBEN Trichter:
 *   - Tipp neben die Leiste (Backdrop)
 *   - ✕ in der Kopfzeile der Leiste
 *   - der bisherige Umschalter, auf 44x44 gebracht
 *
 * Auf breiten Schirmen aendert sich nichts — dort verdeckt die Leiste nichts.
 *
 * Geprueft wird gegen die ECHTE Funktion gegen DOM-Attrappen und gegen die
 * ausgelieferten <style>-Bloecke.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (b, t) => { checks++; if (!b) luecken.push(t); };

// ═══ CSS ════════════════════════════════════════════════════════════════
const CSS = (index.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
  .map((b) => b.replace(/^<style[^>]*>/i, "").replace(/<\/style>$/i, "")).join("\n");
ok(CSS.length > 10000, `die <style>-Bloecke wurden nicht gelesen (${CSS.length})`);

function regeln(css) {
  const out = []; let ordnung = 0;
  (function block(text, breite) {
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
        block(inhalt, mm ? Number(mm[1]) : breite);
      } else if (!kopf.startsWith("@") && kopf) {
        for (const sel of kopf.split(",")) {
          const t = sel.trim();
          if (t) out.push({ selektor: t, dekl: inhalt, breite: breite ?? null, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  })(css, null);
  return out;
}
const REGELN = regeln(CSS);
const eig = (d, n) => {
  const m = new RegExp("(?:^|;)\\s*" + n + "\\s*:\\s*([^;]+)", "i").exec(d.replace(/\/\*[\s\S]*?\*\//g, ""));
  return m ? m[1].trim() : null;
};
function loese(selektor, name, breite) {
  let sieger = null;
  for (const r of REGELN) {
    if (r.selektor !== selektor) continue;
    if (r.breite !== null && breite > r.breite) continue;
    const w = eig(r.dekl, name);
    if (w === null) continue;
    if (!sieger || r.ordnung > sieger.ordnung) sieger = { wert: w, ordnung: r.ordnung };
  }
  return sieger;
}
const zahl = (v) => (v == null ? NaN : parseFloat(String(v)));

// ── Schmal: alle drei Wege sind da, der Scrim liegt richtig ────────────
// Im Band 901..1099 greift der 900er-Media-Block nicht mehr; dort traegt allein
// body.mode-tablet die Schmal-Darstellung — auch den z-index der Leiste. Der
// Vergleich muss deshalb je Lage den WIRKSAMEN Selektor nehmen, nicht stur
// ".sidebar": sonst misst er die Basisregel (z-index 50) und meldet einen
// Fehler, den es nicht gibt.
for (const [name, breite, offenSel, sideSel] of [
  ["390x844", 390, ".app:not(.sidebar-collapsed) .sidebar-scrim", ".sidebar"],
  ["820x1180", 820, ".app:not(.sidebar-collapsed) .sidebar-scrim", ".sidebar"],
  ["1000 (mode-tablet)", 1000, "body.mode-tablet .app:not(.sidebar-collapsed) .sidebar-scrim",
    "body.mode-tablet .sidebar"],
]) {
  const d = loese(offenSel, "display", breite);
  ok(d && d.wert === "block", `${name}: der Backdrop ist ${d ? '"' + d.wert + '"' : "ohne Regel"} statt block`);
  ok(loese(offenSel, "position", breite)?.wert === "fixed", `${name}: der Backdrop ist nicht fixiert`);
  ok(loese(offenSel, "inset", breite)?.wert === "0", `${name}: der Backdrop deckt nicht die ganze Flaeche`);

  // Stapelordnung: Inhalt < Backdrop < Leiste. Sonst faengt der Backdrop
  // entweder nichts ab oder er sperrt die Leiste selbst.
  const zScrim = zahl(loese(offenSel, "z-index", breite)?.wert);
  const zSide = zahl(loese(sideSel, "z-index", breite)?.wert);
  ok(Number.isFinite(zScrim), `${name}: der Backdrop hat keinen z-index`);
  ok(zScrim < zSide, `${name}: Backdrop (${zScrim}) liegt nicht unter der Leiste (${zSide})`);
  ok(zScrim > 10, `${name}: Backdrop (${zScrim}) liegt nicht ueber der Topbar`);

  const closeSel = breite <= 900 ? ".sidebar-close-btn" : "body.mode-tablet .sidebar-close-btn";
  const dc = loese(closeSel, "display", breite);
  ok(dc && dc.wert !== "none", `${name}: das ✕ in der Kopfzeile ist ${dc ? '"' + dc.wert + '"' : "ohne Regel"}`);
  ok(zahl(loese(closeSel, "width", breite)?.wert) >= 44, `${name}: das ✕ ist schmaler als 44 px`);
  ok(zahl(loese(closeSel, "height", breite)?.wert) >= 44, `${name}: das ✕ ist niedriger als 44 px`);

  const togSel = breite <= 900 ? ".sidebar-toggle-btn" : "body.mode-tablet .sidebar-toggle-btn";
  ok(zahl(loese(togSel, "width", breite)?.wert) >= 44,
    `${name}: der Umschalter ist ${zahl(loese(togSel, "width", breite)?.wert)} px breit — die gemessenen 28 px trifft kein Daumen`);
  ok(zahl(loese(togSel, "height", breite)?.wert) >= 44, `${name}: der Umschalter ist niedriger als 44 px`);
}

// ── Eingeklappt: kein Backdrop, sonst waere der Inhalt gesperrt ────────
for (const breite of [390, 820]) {
  const d = loese(".sidebar-scrim", "display", breite);
  ok(d && d.wert === "none",
    `${breite} eingeklappt: der Backdrop ist ${d ? '"' + d.wert + '"' : "ohne Regel"} — er wuerde den Inhalt sperren`);
}

// ── Breit: nichts aendert sich ────────────────────────────────────────
for (const breite of [1180, 1440]) {
  ok(loese(".sidebar-scrim", "display", breite)?.wert === "none",
    `${breite}: der Backdrop erscheint auf dem breiten Schirm`);
  ok(loese(".app:not(.sidebar-collapsed) .sidebar-scrim", "display", breite) === null,
    `${breite}: die Backdrop-Regel greift bis auf den Desktop`);
  ok(loese(".sidebar-close-btn", "display", breite)?.wert === "none",
    `${breite}: das ✕ erscheint auf dem breiten Schirm`);
  ok(zahl(loese(".sidebar-toggle-btn", "width", breite)?.wert) === 28,
    `${breite}: der Umschalter ist ${zahl(loese(".sidebar-toggle-btn", "width", breite)?.wert)} px statt der bisherigen 28 — Desktopregression`);
}
for (const r of REGELN.filter((x) => /sidebar-scrim|sidebar-close-btn/.test(x.selektor))) {
  ok(!/!important/.test(r.dekl.replace(/\/\*[\s\S]*?\*\//g, "")),
    `die Regel "${r.selektor}" arbeitet mit !important`);
}

// ═══ MARKUP ════════════════════════════════════════════════════════════
ok(/id="sidebarScrim"/.test(index), "der Backdrop fehlt im Markup");
ok(/id="sidebarCloseBtn"/.test(index), "das ✕ fehlt im Markup");
ok(/id="sidebarCloseBtn"[^>]*aria-label="Seitenleiste schliessen"/.test(index),
  "das ✕ sagt nicht, was es schliesst");
ok(/id="sidebarCloseBtn"[^>]*aria-controls="sidebar"/.test(index), "das ✕ benennt die Leiste nicht");
ok(/id="sidebarToggleBtn"[^>]*aria-expanded=/.test(index), "der Umschalter traegt kein aria-expanded");
// Das ✕ steht IN der Kopfzeile, nicht irgendwo — sonst findet es niemand.
{
  const a = index.indexOf('<div class="sidebar-header">');
  const kopf = index.slice(a, index.indexOf("</div>", index.indexOf("sidebarPinBtn", a)));
  ok(kopf.includes("sidebarCloseBtn"), "das ✕ steht nicht in der Kopfzeile der Leiste");
}

// ═══ VERHALTEN: die echte Funktion ═════════════════════════════════════
function welt({ zuStart = false } = {}) {
  const a = index.indexOf("  function setSidebarCollapsed(zu) {");
  ok(a > 0, "setSidebarCollapsed wurde nicht gefunden — es gibt keinen Trichter");
  if (a < 0) return null;
  const src = index.slice(a, index.indexOf("\n  window.setSidebarCollapsed", a));

  const klassen = new Set(zuStart ? ["sidebar-collapsed"] : []);
  const attr = {};
  const speicher = {};
  const knoten = {
    app: { classList: { toggle: (k, an) => { if (an) klassen.add(k); else klassen.delete(k); },
      contains: (k) => klassen.has(k) } },
    sidebarToggleBtn: { textContent: "◀", setAttribute: (k, v) => { attr["tog:" + k] = v; } },
    sidebarScrim: { setAttribute: (k, v) => { attr["scrim:" + k] = v; } },
  };
  const fn = new Function("$", "localStorage", src + "\nreturn setSidebarCollapsed;")(
    (sel) => knoten[String(sel).replace("#", "")] || null,
    { setItem: (k, v) => { speicher[k] = v; }, getItem: (k) => speicher[k] });
  return { fn, klassen, attr, speicher, knoten };
}
{
  const w = welt();
  if (w) {
    ok(!w.klassen.has("sidebar-collapsed"), "Vorbedingung: die Leiste war offen");
    w.fn(true);
    ok(w.klassen.has("sidebar-collapsed"), "setSidebarCollapsed(true) schliesst die Leiste nicht");
    ok(w.knoten.sidebarToggleBtn.textContent === "▶", `die Beschriftung ist "${w.knoten.sidebarToggleBtn.textContent}"`);
    ok(w.attr["tog:aria-expanded"] === "false", `aria-expanded ist "${w.attr["tog:aria-expanded"]}"`);
    ok(w.attr["scrim:aria-hidden"] === "true", "der Backdrop bleibt fuer Hilfsmittel sichtbar");
    ok(w.speicher["sidebar-collapsed"] === "1", "der Zustand wurde nicht gemerkt");

    w.fn(false);
    ok(!w.klassen.has("sidebar-collapsed"), "setSidebarCollapsed(false) oeffnet nicht");
    ok(w.knoten.sidebarToggleBtn.textContent === "◀", "die Beschriftung wurde beim Oeffnen nicht nachgezogen");
    ok(w.attr["tog:aria-expanded"] === "true", "aria-expanded beim Oeffnen falsch");
    ok(w.speicher["sidebar-collapsed"] === "0", "der offene Zustand wurde nicht gemerkt");
  }
}

// Alle drei Wege gehen durch den Trichter, und die Schliesswege schliessen NUR.
{
  const bereich = index.slice(index.indexOf("  function setSidebarCollapsed(zu) {"),
    index.indexOf("  // Delegierter Click-Handler als Fallback"));
  const ohneKommentare = bereich.replace(/^\s*\/\/.*$/gm, "");
  for (const [was, muster] of [
    ["Backdrop", /sidebarScrim[\s\S]{0,200}?setSidebarCollapsed\(true\)/],
    ["das ✕", /sidebarCloseBtn[\s\S]{0,200}?setSidebarCollapsed\(true\)/],
    ["der Umschalter", /sidebarToggleBtn[\s\S]{0,300}?setSidebarCollapsed\(/],
  ]) {
    ok(muster.test(ohneKommentare), `${was} geht nicht durch setSidebarCollapsed`);
  }
  // Kein Schliessweg darf navigieren oder die App verlassen.
  for (const verboten of ["location.hash", "closeApp", "openApp(", "render()"]) {
    const teil = ohneKommentare.slice(ohneKommentare.indexOf("sidebarScrim"),
      ohneKommentare.indexOf("const sidebarToggleBtn"));
    ok(!teil.includes(verboten), `ein Schliessweg ruft ${verboten}`);
  }
}

// ═══ Fremde Bereiche unberuehrt ════════════════════════════════════════
for (const anker of [
  "async function canonicalWrite(quelle, options = {})",
  "function openRenameSheet(opt) {",
  "function openConfirmSheet(opt) {",
  "function wennFirebaseBereit(kennung, fn, maxMs) {",
  ".app,\n      .app.sidebar-collapsed{grid-template-columns:minmax(0,1fr)}",
]) {
  ok(index.includes(anker), `ein fremder Bereich wurde beruehrt: "${anker}" fehlt`);
}

if (luecken.length) {
  console.error("M6 SIDEBAR CLOSE — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`m6 sidebar close: ok (${checks} Pruefungen)`);
