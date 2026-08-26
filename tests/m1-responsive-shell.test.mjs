/*
 * M1 — die responsive Shell auf schmalen Geraeten.
 *
 * PRODUKTIONSBEFUND (live, 390x844 UND 820x1180, identische Zahlen):
 *   body traegt "mode-laptop"; Sidebar offen -> main 1165,10 px;
 *   Sidebar eingeklappt -> main 51,98 px, topbar 15,99 px.
 *
 * Drei Ursachen, alle drei hier festgenagelt:
 *
 * 1. SPEZIFITAET. Media Queries erhoehen die Spezifitaet NICHT. Die Basisregel
 *    .app.sidebar-collapsed (0,2,0) schlug daher die Mobile-Regel .app (0,1,0).
 *    Eingeklappt blieben drei Spuren (0 | minmax(0,1fr) | auto) stehen, waehrend
 *    dieselbe Media Query topbar/main nach grid-column:1 schiebt — also in die
 *    0-Spur. Daher 52 px und 16 px.
 *
 * 2. MIN-CONTENT. 1fr ist minmax(auto,1fr) und behaelt einen Min-Content-Boden.
 *    Dass 1165,10 px bei 390 und bei 820 IDENTISCH gemessen wurde, ist der
 *    Beweis: die Spur wird vom Inhalt bestimmt, nicht vom Viewport. Der Fix
 *    setzt minmax(0,1fr) und nimmt topbar/main zusaetzlich die automatische
 *    Mindestbreite (min-width:0) — ohne die kann ein einzelnes nicht
 *    schrumpfbares Kind die Spur wieder aufblasen.
 *
 * 3. MODUS. effectiveMode() gab eine fixierte Wahl unbesehen zurueck; bei
 *    gespeichertem "laptop" wurde detectMode() nie befragt. Damit fehlte die
 *    Klasse mode-tablet — und an ihr haengt die gesamte Schmal-Darstellung.
 *
 * Geprueft wird gegen die ECHTEN Regeln aus public/index.html: der Test parst
 * die ausgelieferten <style>-Bloecke, rechnet Spezifitaeten und loest die
 * Kaskade fuer eine konkrete Lage auf. Die Modus-Logik laeuft als echte
 * Funktion gegen eine localStorage-Attrappe.
 *
 * Kein Browser, kein Netz, keine Datei wird geschrieben.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ═══ CSS: die ausgelieferten <style>-Bloecke parsen ══════════════════════
function styleQuellen() {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(index))) out.push(m[1]);
  return out.join("\n");
}
const CSS = styleQuellen();
ok(CSS.length > 10000, `die <style>-Bloecke wurden nicht gefunden (${CSS.length} Zeichen)`);

/*
 * Ein bewusst kleiner Parser: er kennt nur, was dieser Test braucht —
 * @media(max-width:N) und flache Regeln. Verschachtelte At-Regeln werden
 * uebersprungen statt falsch gedeutet.
 */
function regelnLesen(css) {
  const regeln = [];
  let i = 0, ordnung = 0;
  function block(text, versatz, medienBreite) {
    let j = 0;
    while (j < text.length) {
      const auf = text.indexOf("{", j);
      if (auf < 0) break;
      let kopf = text.slice(j, auf).trim();
      // Kommentare aus dem Kopf entfernen
      kopf = kopf.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      // passendes } finden
      let tiefe = 1, k = auf + 1;
      while (k < text.length && tiefe > 0) {
        if (text[k] === "{") tiefe++;
        else if (text[k] === "}") tiefe--;
        k++;
      }
      const inhalt = text.slice(auf + 1, k - 1);
      if (kopf.startsWith("@media")) {
        const mm = /max-width\s*:\s*(\d+)px/.exec(kopf);
        block(inhalt, versatz + auf + 1, mm ? Number(mm[1]) : (medienBreite ?? null));
      } else if (kopf.startsWith("@")) {
        // @keyframes, @supports … interessieren hier nicht
      } else if (kopf) {
        for (const sel of kopf.split(",")) {
          const s = sel.trim();
          if (s) regeln.push({ selektor: s, deklarationen: inhalt, medienBreite: medienBreite ?? null, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  }
  block(css, 0, null);
  return regeln;
}
const REGELN = regelnLesen(CSS);
ok(REGELN.length > 500, `zu wenige Regeln geparst (${REGELN.length}) — der Parser passt nicht mehr`);

function spezifitaet(sel) {
  let a = 0, b = 0, c = 0;
  const ohnePseudoFn = sel.replace(/:not\(([^)]*)\)/g, " $1 ");
  for (const teil of ohnePseudoFn.split(/[\s>+~]+/)) {
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
// Kontrolle des Rechners an bekannten Werten
ok(spezifitaet(".app") === 100, "Spezifitaet .app falsch berechnet");
ok(spezifitaet(".app.sidebar-collapsed") === 200, "Spezifitaet .app.sidebar-collapsed falsch berechnet");
ok(spezifitaet("body.mode-tablet .app") === 201, "Spezifitaet body.mode-tablet .app falsch berechnet");

/*
 * Kette: body -> #app -> ziel. Reicht fuer alle hier geprueften Selektoren.
 */
function passt(sel, lage) {
  const kette = [
    { el: "body", ids: [], klassen: lage.bodyKlassen },
    { el: "div", ids: ["app"], klassen: ["app"].concat(lage.appEingeklappt ? ["sidebar-collapsed"] : []) },
    { el: "div", ids: [], klassen: [lage.ziel] },
  ];
  const teile = sel.trim().split(/\s+/);
  if (teile.some((t) => /[>+~]/.test(t))) return false;   // kennen wir nicht -> nicht anwenden
  let k = kette.length - 1;
  for (let t = teile.length - 1; t >= 0; t--) {
    let gefunden = false;
    while (k >= 0) {
      if (compoundPasst(teile[t], kette[k])) { gefunden = true; k--; break; }
      k--;
    }
    if (!gefunden) return false;
  }
  return true;
}
function compoundPasst(compound, knoten) {
  const nots = [...compound.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1]);
  const rest = compound.replace(/:not\([^)]*\)/g, "");
  for (const n of nots) if (compoundPasst(n, knoten)) return false;
  const ids = (rest.match(/#[\w-]+/g) || []).map((x) => x.slice(1));
  const klassen = (rest.match(/\.[\w-]+/g) || []).map((x) => x.slice(1));
  const el = rest.replace(/[#.][\w-]+/g, "").replace(/:[\w-]+/g, "").trim();
  if (el && el !== "*" && el !== knoten.el) return false;
  if (ids.some((x) => !knoten.ids.includes(x))) return false;
  if (klassen.some((x) => !knoten.klassen.includes(x))) return false;
  return true;
}

function eigenschaft(deklarationen, name) {
  const re = new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([^;]+)", "i");
  const m = re.exec(deklarationen.replace(/\/\*[\s\S]*?\*\//g, ""));
  return m ? m[1].trim() : null;
}

/*
 * Kaskade fuer EINE Eigenschaft an EINER Lage aufloesen. Media Queries zaehlen
 * nur, wenn sie zur Viewport-Breite passen — und sie erhoehen die Spezifitaet
 * nicht. Genau das ist der Kern des Befunds.
 */
function aufloesen(name, lage) {
  let sieger = null;
  for (const r of REGELN) {
    if (r.medienBreite !== null && lage.breite > r.medienBreite) continue;
    if (!passt(r.selektor, lage)) continue;
    const wert = eigenschaft(r.deklarationen, name);
    if (wert === null) continue;
    const spez = spezifitaet(r.selektor);
    if (!sieger || spez > sieger.spez || (spez === sieger.spez && r.ordnung > sieger.ordnung)) {
      sieger = { wert, spez, ordnung: r.ordnung, selektor: r.selektor, media: r.medienBreite };
    }
  }
  return sieger;
}

function spuren(wert) {
  // "minmax(0,1fr)" / "0 minmax(0,1fr) auto" / "240px minmax(0,1fr) auto"
  const out = []; let tiefe = 0, akt = "";
  for (const ch of wert) {
    if (ch === "(") tiefe++;
    if (ch === ")") tiefe--;
    if (/\s/.test(ch) && tiefe === 0) { if (akt) out.push(akt); akt = ""; }
    else akt += ch;
  }
  if (akt) out.push(akt);
  return out;
}

// ═══ 1. CSS-VERTRAG: schmale Klasse, offen UND eingeklappt ═══════════════
const SCHMAL = [
  { name: "390x844 Telefon", breite: 390 },
  { name: "820x1180 Tablet hoch", breite: 820 },
  // 901..1099 ist das Band, in dem der 900er-Media-Block NICHT mehr greift,
  // detectMode() aber schon "tablet" liefert. Dort traegt allein body.mode-tablet
  // die ganze Schmal-Darstellung — wer nur den Media-Block repariert, laesst
  // dieses Band kaputt.
  { name: "1000 px Zwischenband", breite: 1000, nurTablet: true },
];
for (const modus of ["mode-tablet", "mode-laptop"]) {
  for (const v of SCHMAL) {
    // Im Zwischenband kann mode-laptop gar nicht mehr entstehen (detectMode
    // liefert dort tablet); die Lage waere konstruiert.
    if (v.nurTablet && modus !== "mode-tablet") continue;
    for (const eingeklappt of [false, true]) {
      const basis = { breite: v.breite, bodyKlassen: ["tabs-on", modus], appEingeklappt: eingeklappt };
      const grid = aufloesen("grid-template-columns", { ...basis, ziel: "app" });
      const lage = `${v.name} / ${modus} / ${eingeklappt ? "eingeklappt" : "offen"}`;

      ok(grid !== null, `${lage}: keine Regel setzt grid-template-columns`);
      if (!grid) continue;
      const tr = spuren(grid.wert);
      ok(tr.length === 1,
        `${lage}: ${tr.length} Spuren ("${grid.wert}" aus "${grid.selektor}") — erwartet genau eine`);
      ok(/^minmax\(0\s*,\s*1fr\)$/.test(tr[0] || ""),
        `${lage}: Spur ist "${tr[0]}" statt minmax(0,1fr) — ein Min-Content-Boden bleibt`);

      // topbar und main duerfen nie in einer 0-Spur landen
      for (const ziel of ["topbar", "main"]) {
        const gc = aufloesen("grid-column", { ...basis, ziel });
        const spalte = gc ? Number(String(gc.wert).split("/")[0].trim()) : 1;
        ok(Number.isFinite(spalte) && spalte >= 1 && spalte <= tr.length,
          `${lage}: .${ziel} liegt in Spalte ${gc && gc.wert} bei ${tr.length} Spur(en)`);
        const spurWert = tr[Math.max(0, spalte - 1)];
        ok(spurWert !== "0",
          `${lage}: .${ziel} landet in einer 0-Spur — genau der gemessene 52-px-/16-px-Fall`);
        const mw = aufloesen("min-width", { ...basis, ziel });
        ok(mw && mw.wert === "0",
          `${lage}: .${ziel} hat kein min-width:0 — die automatische Mindestbreite kann die Spur aufblasen`);
      }
    }
  }
}

// Das Panel-Dock steht auf grid-column:3. Bei EINER Spur wuerde es eine
// implizite dritte Spalte aufziehen und den Ueberlauf zurueckholen — es muss in
// der schmalen Klasse also ohne Box sein.
for (const breite of [390, 820, 1000]) {
  const d = aufloesen("display", { breite, bodyKlassen: ["mode-tablet"], appEingeklappt: true, ziel: "panel-dock" });
  ok(d && /^none/.test(d.wert),
    `${breite} px: .panel-dock ist "${d && d.wert}" — auf grid-column:3 zieht es eine implizite Spur auf`);
}

// ═══ 2. KEINE REGRESSION OBERHALB DER SCHWELLE ══════════════════════════
// Querformat 1180x820 und Laptop-Breiten behalten das dreispaltige Layout.
for (const v of [{ name: "1180x820 Tablet quer", breite: 1180 }, { name: "1440 Laptop", breite: 1440 }]) {
  for (const eingeklappt of [false, true]) {
    const basis = { breite: v.breite, bodyKlassen: ["tabs-on", "mode-laptop"], appEingeklappt: eingeklappt };
    const grid = aufloesen("grid-template-columns", { ...basis, ziel: "app" });
    const tr = grid ? spuren(grid.wert) : [];
    const lage = `${v.name} / mode-laptop / ${eingeklappt ? "eingeklappt" : "offen"}`;
    ok(tr.length === 3, `${lage}: ${tr.length} Spuren statt 3 — das Breitbild-Layout wurde beschaedigt`);
    ok(tr[0] === (eingeklappt ? "0" : "240px"), `${lage}: erste Spur "${tr[0]}"`);
    ok(/^minmax\(0\s*,\s*1fr\)$/.test(tr[1] || ""), `${lage}: zweite Spur "${tr[1]}"`);
    for (const ziel of ["topbar", "main"]) {
      const gc = aufloesen("grid-column", { ...basis, ziel });
      ok(gc && String(gc.wert).trim().startsWith("2"),
        `${lage}: .${ziel} steht auf Spalte "${gc && gc.wert}" statt 2 — Inhalt liefe unter die Sidebar`);
    }
  }
}

// Gegenprobe zum Parser: die Mobile-Regel MUSS beide Selektoren fuehren.
{
  const mobil = REGELN.filter((r) => r.medienBreite === 900 &&
    /grid-template-columns/.test(r.deklarationen) &&
    (r.selektor === ".app" || r.selektor === ".app.sidebar-collapsed"));
  ok(mobil.length === 2,
    `im 900er-Block setzen ${mobil.length} statt 2 Selektoren die Spalten — die Collapse-Regel fehlt`);
  ok(!/!important/.test(CSS.slice(0, 0) + (mobil.map((r) => r.deklarationen).join(";"))),
    "die Mobile-Regel arbeitet mit !important");
}

// ═══ 3. MODUS-LOGIK: die ECHTEN Funktionen ══════════════════════════════
function modusApi({ gespeichert = null, breite = 390, appDa = true } = {}) {
  // WICHTIG: der Ausschnitt MUSS bei var LM_KEY beginnen. Ohne die Konstante
  // wirft lmSetting() eine ReferenceError, sein eigener catch verschluckt sie,
  // und die Funktion liefert stumm "auto" — der Test waere dann gruen bzw. rot
  // aus dem falschen Grund und haette die Fixierung nie geprueft.
  const a = index.indexOf('  var LM_KEY = "quantusLayoutMode";');
  const b = index.indexOf("\n  var _prevMode = null;", a);
  ok(a > 0 && b > a, "der Modus-Block wurde in public/index.html nicht gefunden");
  const c = index.indexOf("  function applyLayoutMode(){", b);
  const ENDE = "\n    renderDock();\n  }";
  const d = index.indexOf(ENDE, c);
  ok(c > 0 && d > c, "applyLayoutMode wurde nicht gefunden");

  const speicher = new Map();
  if (gespeichert !== null) speicher.set("quantusLayoutMode", gespeichert);
  const protokoll = { klassen: [], renderDock: 0 };
  const appEl = { classList: { add: (k) => protokoll.klassen.push(k), remove: () => {} } };
  const body = { classList: { add: (k) => protokoll.klassen.push("body:" + k), remove: () => {} } };

  const quelle = index.slice(a, b) + "\n  var _prevMode = null;\n" +
    index.slice(c, d) + ENDE + "\n" +
    "  return { effectiveMode: effectiveMode, detectMode: detectMode, lmSetting: lmSetting," +
    " applyLayoutMode: applyLayoutMode, gelesen: function(){ return _prevMode; } };";

  const api = new Function("localStorage", "window", "document", "MODE_META", "renderDock",
    "Math", "Number", "String", quelle)(
    { getItem: (k) => (speicher.has(k) ? speicher.get(k) : null),
      setItem: (k, v) => speicher.set(k, String(v)) },
    { innerWidth: breite },
    { body, getElementById: (id) => (id === "app" ? (appDa ? appEl : null) : null) },
    { computer: { icon: "x", label: "Computer" }, laptop: { icon: "x", label: "Laptop" },
      tablet: { icon: "x", label: "Tablet" } },
    () => { protokoll.renderDock++; },
    Math, Number, String);
  return Object.assign(api, { protokoll, speicher });
}

// MATRIX: drei Viewports x drei gespeicherte Werte
const MATRIX = [
  { breite: 390,  hoehe: 844,  name: "390x844" },
  { breite: 820,  hoehe: 1180, name: "820x1180" },
  { breite: 1180, hoehe: 820,  name: "1180x820" },
];
for (const v of MATRIX) {
  for (const gespeichert of [null, "auto", "laptop", "computer", "tablet"]) {
    const api = modusApi({ gespeichert, breite: v.breite });
    const m = api.effectiveMode();
    const erkannt = api.detectMode();
    const lage = `${v.name} / gespeichert=${gespeichert === null ? "(nichts)" : gespeichert}`;

    if (v.breite < 1100) {
      ok(m === "tablet",
        `${lage}: effectiveMode liefert "${m}" statt "tablet" — eine fixierte Wahl uebersteuert den schmalen Viewport`);
    } else if (gespeichert === "computer") {
      ok(m === "computer", `${lage}: effectiveMode liefert "${m}" statt "computer"`);
    } else if (gespeichert === "laptop") {
      ok(m === "laptop", `${lage}: effectiveMode liefert "${m}" statt "laptop" — ab 1100 px darf Laptop gelten`);
    } else if (gespeichert === "tablet") {
      ok(m === "tablet", `${lage}: eine bewusst fixierte Enge wurde verworfen ("${m}")`);
    } else {
      ok(m === erkannt, `${lage}: ohne Fixierung muss die Erkennung gelten ("${m}" vs "${erkannt}")`);
    }

    // Die gespeicherte Wahl bleibt UNANGETASTET.
    ok(api.lmSetting() === (gespeichert === null ? "auto" : gespeichert),
      `${lage}: die gespeicherte Wahl wurde veraendert ("${api.lmSetting()}")`);
  }
}

// detectMode-Schwellen unveraendert
{
  ok(modusApi({ breite: 1099 }).detectMode() === "tablet", "detectMode: 1099 px ist nicht tablet");
  ok(modusApi({ breite: 1100 }).detectMode() === "laptop", "detectMode: 1100 px ist nicht laptop");
  ok(modusApi({ breite: 1719 }).detectMode() === "laptop", "detectMode: 1719 px ist nicht laptop");
  ok(modusApi({ breite: 1720 }).detectMode() === "computer", "detectMode: 1720 px ist nicht computer");
}

// ═══ 4. EINTRITT IN DIE SCHMALE KLASSE: Sidebar einklappen ══════════════
// Struktureller Wächter fuer die Trefferflaechen: bei <=900 px ist die Sidebar
// position:fixed mit z-index 500 ueber dem Inhalt ab x=0. Sichtbare App-Kacheln
// liegen dann unter ihr — ein Klick trifft den Sidebar-Knopf statt der Kachel.
// Ohne Browser laesst sich das nur so pruefen: die Ueberlappung darf gar nicht
// erst entstehen, also MUSS der Eintritt zuverlaessig einklappen.
{
  const sb = aufloesen("position", { breite: 390, bodyKlassen: ["mode-tablet"], appEingeklappt: false, ziel: "sidebar" });
  ok(sb && sb.wert === "fixed",
    `bei 390 px ist .sidebar "${sb && sb.wert}" statt fixed — die Annahme dieses Waechters stimmt nicht mehr`);

  for (const gespeichert of [null, "laptop", "computer"]) {
    const api = modusApi({ gespeichert, breite: 390 });
    api.applyLayoutMode();
    ok(api.protokoll.klassen.includes("sidebar-collapsed"),
      `390 px / gespeichert=${gespeichert}: die Sidebar wurde beim Eintritt nicht eingeklappt — ` +
      "sie liegt als fixiertes Overlay ueber den App-Kacheln");
    ok(api.protokoll.klassen.includes("body:mode-tablet"),
      `390 px / gespeichert=${gespeichert}: body bekam nicht mode-tablet`);
  }

  // Oberhalb der Schwelle wird NICHT eingeklappt.
  for (const gespeichert of [null, "laptop", "computer"]) {
    const api = modusApi({ gespeichert, breite: 1440 });
    api.applyLayoutMode();
    ok(!api.protokoll.klassen.includes("sidebar-collapsed"),
      `1440 px / gespeichert=${gespeichert}: die Sidebar wurde eingeklappt — Regression oberhalb der Schwelle`);
  }

  // Zuverlaessigkeit: fehlt #app noch, darf der Uebergang NICHT als erledigt
  // gelten — sonst bleibt die Sidebar fuer den Rest der Sitzung offen.
  const spaet = modusApi({ gespeichert: "laptop", breite: 390, appDa: false });
  spaet.applyLayoutMode();
  ok(!spaet.protokoll.klassen.includes("sidebar-collapsed"), "ohne #app kann nichts eingeklappt werden");
  ok(spaet.gelesen() !== "tablet",
    "der Uebergang gilt als vollzogen, obwohl #app fehlte — der naechste Lauf holt das Einklappen nie nach");
}

// ═══ 5. Der Sync-Vertrag bleibt unberuehrt ══════════════════════════════
// M1 ist ein reiner Shell-Auftrag. Faellt hier etwas, wurde am Schreibpfad
// gearbeitet — das ist unter dem F-25-Freeze ausgeschlossen.
{
  for (const anker of [
    "async function canonicalWrite(quelle, options = {})",
    "const CORE_PROVIDER_ORDER = ['rtdb', 'netlify'];",
    "reason: 'missing_if_match'",
    "function coreWriteGuard(fnName, key, options)",
  ]) {
    ok(index.includes(anker), `der Sync-Vertrag wurde beruehrt: "${anker}" fehlt`);
  }
}

// ── Bericht ─────────────────────────────────────────────────────────────
if (luecken.length) {
  console.error("M1 RESPONSIVE SHELL — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`m1 responsive shell: ok (${checks} Pruefungen)`);
