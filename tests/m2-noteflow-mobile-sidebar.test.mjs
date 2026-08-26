/*
 * M2 — die NoteFlow-Seitenleiste auf Telefon und Tablet.
 *
 * PRODUKTIONSBEFUND (live, 390x844):
 *   .nf2-side liegt bei <=900 px absolut, ~262 px breit, z-index 20 — also
 *   ueber .nf2-main, das weder position noch z-index hatte. #nf2SideToggle
 *   sitzt als erstes Kind der Topbar bei x ~ 12 und liegt damit UNTER der
 *   offenen Leiste: der einzige Weg, sie zu schliessen, war unerreichbar.
 *   Sichtbar war an dieser Stelle nur das ✕ der Leisten-Kopfzeile — und das
 *   ruft close(), verliess also die ganze App. Einen Backdrop gab es nicht.
 *
 * Damit oeffnete NoteFlow auf einem Telefon mit einer Leiste ueber dem Inhalt
 * und ohne Weg zurueck. Der Fix besteht aus drei Teilen, die nur zusammen
 * wirken: die Leiste startet schmal eingeklappt, sie hat einen eigenen
 * Schliessknopf, und hinter ihr liegt ein Scrim.
 *
 * Geprueft wird gegen die ECHTEN Artefakte: das NoteFlow-CSS wird aus dem
 * Template in injectCSS() geschnitten und als CSS geparst; setSide, sideOffen,
 * istSchmal, onGlobalKey und openPage laufen als echte Funktionen gegen
 * DOM-Attrappen. Kein Browser, kein Netz, keine Datei wird geschrieben.
 *
 * Der wichtigste Nachweis steht in Abschnitt 4: der neue Schliessweg darf
 * NIEMALS close(), closeApp(), openApp('allapps') oder eine Navigation
 * ausloesen. Genau diese Verwechslung war der Befund.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const luecken = [];
const ok = (bedingung, text) => { checks++; if (!bedingung) luecken.push(text); };

// ═══ Das NoteFlow-CSS aus injectCSS() schneiden ══════════════════════════
function nf2Css() {
  const anker = index.lastIndexOf('st.id = "nf2Styles";');
  ok(anker > 0, "injectCSS() mit nf2Styles wurde nicht gefunden");
  if (anker < 0) return "";
  const auf = index.indexOf("st.textContent = `", anker);
  const zu = index.indexOf("`;", auf + 18);
  ok(auf > 0 && zu > auf, "das CSS-Template in injectCSS() ist nicht abgrenzbar");
  return index.slice(auf + "st.textContent = `".length, zu);
}
const CSS = nf2Css();
ok(CSS.length > 5000, `das NoteFlow-CSS wurde nicht gelesen (${CSS.length} Zeichen)`);
ok(CSS.includes(".nf2-side{"), "der Ausschnitt enthaelt .nf2-side nicht — der Anker stimmt nicht mehr");

function regelnLesen(css) {
  const regeln = []; let ordnung = 0;
  (function block(text, medienBreite) {
    let j = 0;
    while (j < text.length) {
      const auf = text.indexOf("{", j);
      if (auf < 0) break;
      const kopf = text.slice(j, auf).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      let tiefe = 1, k = auf + 1;
      while (k < text.length && tiefe > 0) {
        if (text[k] === "{") tiefe++; else if (text[k] === "}") tiefe--;
        k++;
      }
      const inhalt = text.slice(auf + 1, k - 1);
      if (kopf.startsWith("@media")) {
        const mm = /max-width\s*:\s*(\d+)px/.exec(kopf);
        block(inhalt, mm ? Number(mm[1]) : medienBreite);
      } else if (!kopf.startsWith("@") && kopf) {
        for (const sel of kopf.split(",")) {
          const t = sel.trim();
          if (t) regeln.push({ selektor: t, deklarationen: inhalt, medienBreite: medienBreite ?? null, ordnung: ordnung++ });
        }
      }
      j = k;
    }
  })(CSS, null);
  return regeln;
}
const REGELN = regelnLesen(CSS);
ok(REGELN.length > 100, `zu wenige NoteFlow-Regeln geparst (${REGELN.length})`);

function spezifitaet(sel) {
  let a = 0, b = 0, c = 0;
  const flach = sel.replace(/:not\(([^)]*)\)/g, " $1 ");
  for (const teil of flach.split(/[\s>+~]+/)) {
    if (!teil) continue;
    a += (teil.match(/#[\w-]+/g) || []).length;
    b += (teil.match(/\.[\w-]+/g) || []).length + (teil.match(/:[\w-]+/g) || []).length;
    const el = teil.replace(/[#.:[][^#.:[]*/g, "").trim();
    if (el && el !== "*") c += 1;
  }
  return a * 10000 + b * 100 + c;
}
function passt(sel, lage) {
  // Kette: .nf2(#nf2Root) -> [optionale Zwischenknoten] -> ziel
  const kette = [
    { el: "div", ids: [], klassen: ["nf2"].concat(lage.sideOffen ? [] : ["side-hidden"]) },
    ...(lage.eltern || []).map((k) => ({ el: "div", ids: [], klassen: [].concat(k) })),
    { el: lage.zielEl || "div", ids: lage.zielId ? [lage.zielId] : [],
      klassen: [].concat(lage.ziel) },
  ];
  const teile = sel.trim().split(/\s+/);
  if (teile.some((t) => /[>+~]/.test(t))) return false;
  // Der LETZTE Compound muss das ZIEL treffen, nicht irgendeinen Vorfahren.
  // Ohne diese Zeile galt .nf2{display:flex} auch fuer .nf2-scrim, und der
  // Test meldete auf einem Stand ohne Scrim ein munteres "flex" statt der
  // Wahrheit: es gibt die Regel gar nicht.
  if (!compoundPasst(teile[teile.length - 1], kette[kette.length - 1])) return false;
  let k = kette.length - 2;
  for (let t = teile.length - 2; t >= 0; t--) {
    let gefunden = false;
    while (k >= 0) { if (compoundPasst(teile[t], kette[k])) { gefunden = true; k--; break; } k--; }
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
  if (ids.some((x) => !(knoten.ids || []).includes(x))) return false;
  return !klassen.some((x) => !knoten.klassen.includes(x));
}
function eigenschaft(dekl, name) {
  const m = new RegExp("(?:^|;)\\s*" + name + "\\s*:\\s*([^;]+)", "i")
    .exec(dekl.replace(/\/\*[\s\S]*?\*\//g, ""));
  return m ? m[1].trim() : null;
}
function aufloesen(name, lage) {
  let sieger = null;
  for (const r of REGELN) {
    if (r.medienBreite !== null && lage.breite > r.medienBreite) continue;
    if (!passt(r.selektor, lage)) continue;
    const wert = eigenschaft(r.deklarationen, name);
    if (wert === null) continue;
    const spez = spezifitaet(r.selektor);
    if (!sieger || spez > sieger.spez || (spez === sieger.spez && r.ordnung > sieger.ordnung)) {
      sieger = { wert, spez, ordnung: r.ordnung, selektor: r.selektor };
    }
  }
  return sieger;
}
const zahl = (v) => (v === null || v === undefined ? NaN : parseFloat(String(v)));

// ═══ 1. CSS-VERTRAG: schmal, Leiste OFFEN ═══════════════════════════════
const SCHMAL = [{ name: "390x844", breite: 390 }, { name: "820x1180", breite: 820 }];
for (const v of SCHMAL) {
  const offen = { breite: v.breite, sideOffen: true };

  // Stapelordnung main < Scrim < Leiste
  const zMain = zahl(aufloesen("z-index", { ...offen, ziel: "nf2-main", zielEl: "main" })?.wert);
  const zScrim = zahl(aufloesen("z-index", { ...offen, ziel: "nf2-scrim" })?.wert);
  const zSide = zahl(aufloesen("z-index", { ...offen, ziel: "nf2-side", zielEl: "aside" })?.wert);
  ok(Number.isFinite(zMain), `${v.name}: .nf2-main hat keinen z-index — es liegt im Auto-Stapel unter der Leiste`);
  ok(Number.isFinite(zScrim), `${v.name}: .nf2-scrim hat keinen z-index`);
  ok(zScrim > zMain, `${v.name}: Scrim (${zScrim}) liegt nicht ueber dem Inhalt (${zMain})`);
  ok(zSide > zScrim, `${v.name}: die Leiste (${zSide}) liegt nicht ueber dem Scrim (${zScrim})`);

  // Der Scrim ist sichtbar, wenn die Leiste offen ist …
  const dScrimOffen = aufloesen("display", { ...offen, ziel: "nf2-scrim" });
  ok(dScrimOffen && dScrimOffen.wert === "block",
    `${v.name}: bei offener Leiste ist .nf2-scrim ${dScrimOffen ? '"' + dScrimOffen.wert + '"' : "ohne jede Regel"} statt block — es gibt keinen Backdrop`);
  ok(aufloesen("position", { ...offen, ziel: "nf2-scrim" })?.wert === "absolute",
    `${v.name}: der Scrim ist nicht absolut positioniert`);
  ok(aufloesen("inset", { ...offen, ziel: "nf2-scrim" })?.wert === "0",
    `${v.name}: der Scrim spannt nicht die ganze Flaeche auf`);

  // … und verschwindet, sobald sie eingeklappt ist.
  const dScrimZu = aufloesen("display", { breite: v.breite, sideOffen: false, ziel: "nf2-scrim" });
  ok(dScrimZu && dScrimZu.wert === "none",
    `${v.name}: bei eingeklappter Leiste ist der Scrim ${dScrimZu ? '"' + dScrimZu.wert + '"' : "ohne jede Regel"} statt none`);

  // Eigener Schliesser IN der Leiste, sichtbar nur schmal.
  const dClose = aufloesen("display", { ...offen, ziel: "nf2-sideclose", zielEl: "button" });
  ok(dClose && dClose.wert !== "none",
    `${v.name}: .nf2-sideclose ist ${dClose ? '"' + dClose.wert + '"' : "ohne jede Regel (es gibt ihn nicht)"} — die Leiste hat keinen eigenen Schliesser`);

  // Touch-Ziele — GEZIELT, nicht global. Jede Steuerung, die hier ein Daumen
  // trifft, misst mindestens 44 px.
  const TOUCH = [
    { name: "#nf2SideToggle", ziel: ["nf2-iconbtn", "nf2-sidetoggle"], eltern: ["nf2-topbar"] },
    { name: "#nf2SideClose", ziel: ["nf2-iconbtn", "nf2-sideclose"], eltern: ["nf2-side-head"] },
    { name: "#nf2ThemeBtn", ziel: ["nf2-iconbtn"], eltern: ["nf2-side-head"] },
    { name: "#nf2MoreBtn", ziel: ["nf2-iconbtn"], eltern: ["nf2-topbar", "nf2-top-actions"] },
  ];
  for (const t of TOUCH) {
    const l = { ...offen, ziel: t.ziel, eltern: t.eltern, zielEl: "button" };
    const w = zahl(aufloesen("width", l)?.wert);
    const h = zahl(aufloesen("height", l)?.wert);
    ok(w >= 44, `${v.name}: ${t.name} ist ${w} px breit — unter dem Mindestmass 44`);
    ok(h >= 44, `${v.name}: ${t.name} ist ${h} px hoch — unter dem Mindestmass 44`);
  }
  // Und der App-Rueckweg, der schmal der Hauptausgang ist.
  ok(zahl(aufloesen("min-height", { ...offen, ziel: "nf2-ws", eltern: ["nf2-side-head"] })?.wert) >= 44,
    `${v.name}: der App-Rueckweg ist niedriger als 44 px`);

  // ── Codex-Review 4: eindeutige Schliesswege ──────────────────────────
  const dX = aufloesen("display", { ...offen, ziel: "nf2-iconbtn", zielId: "nf2CloseBtn",
    eltern: ["nf2-side-head"], zielEl: "button" });
  ok(dX && dX.wert === "none",
    `${v.name}: das mehrdeutige ✕ ist ${dX ? '"' + dX.wert + '"' : "sichtbar"} — es steht neben dem Leisten-Schliesser`);
  ok(aufloesen("display", { ...offen, ziel: "nf2-ws-back", eltern: ["nf2-side-head", "nf2-ws"] })?.wert === "inline",
    `${v.name}: der Klartext-Rueckweg "← Quantus" ist nicht sichtbar`);
  for (const versteckt of ["nf2-ws-ic", "nf2-ws-name"]) {
    ok(aufloesen("display", { ...offen, ziel: versteckt, eltern: ["nf2-side-head", "nf2-ws"] })?.wert === "none",
      `${v.name}: .${versteckt} bleibt sichtbar — zwei Beschriftungen nebeneinander`);
  }

  // Kein Min-Content-Ueberlauf im Inhalt
  ok(aufloesen("min-width", { ...offen, ziel: "nf2-main", zielEl: "main" })?.wert === "0",
    `${v.name}: .nf2-main hat kein min-width:0`);
}

// ═══ 2. KEINE REGRESSION AUF BREITEN SCHIRMEN ═══════════════════════════
for (const v of [{ name: "1180x820", breite: 1180 }, { name: "1440x900", breite: 1440 }]) {
  for (const sideOffen of [true, false]) {
    const l = { breite: v.breite, sideOffen };
    const lage = `${v.name} / Leiste ${sideOffen ? "offen" : "zu"}`;
    const ds = aufloesen("display", { ...l, ziel: "nf2-scrim" });
    ok(ds && ds.wert === "none",
      `${lage}: der Scrim ist ${ds ? '"' + ds.wert + '"' : "ohne Regel (es gibt ihn nicht)"} statt none`);
    const dc = aufloesen("display", { ...l, ziel: "nf2-sideclose", zielEl: "button" });
    ok(dc && dc.wert === "none",
      `${lage}: der Seitenleisten-Schliesser ist ${dc ? '"' + dc.wert + '"' : "ohne Regel (es gibt ihn nicht)"} statt none`);
    const pos = aufloesen("position", { ...l, ziel: "nf2-side", zielEl: "aside" });
    ok(!pos || pos.wert !== "absolute",
      `${lage}: die Leiste ist absolut positioniert — das Desktop-Layout wurde veraendert`);
    // Der gemessene Produktionswert bei innerWidth 1290 ist 27,99 px — die
    // Basisregel .nf2-iconbtn{width:28px}. Sie darf schmal nirgends global
    // ueberschrieben werden, sonst waechst auch der Desktop mit.
    for (const t of [
      { name: ".nf2-iconbtn (Basis)", ziel: ["nf2-iconbtn"], eltern: [] },
      { name: "#nf2SideToggle", ziel: ["nf2-iconbtn", "nf2-sidetoggle"], eltern: ["nf2-topbar"] },
      { name: "#nf2CloseBtn", ziel: ["nf2-iconbtn"], zielId: "nf2CloseBtn", eltern: ["nf2-side-head"] },
    ]) {
      const q = { ...l, ziel: t.ziel, eltern: t.eltern, zielId: t.zielId, zielEl: "button" };
      ok(zahl(aufloesen("width", q)?.wert) === 28,
        `${lage}: ${t.name} ist ${zahl(aufloesen("width", q)?.wert)} px statt 28 — Desktop-Regression`);
      ok(zahl(aufloesen("height", q)?.wert) === 28,
        `${lage}: ${t.name} ist ${zahl(aufloesen("height", q)?.wert)} px hoch statt 28 — Desktop-Regression`);
    }
    // Desktop behaelt Branding und App-Close unveraendert.
    const db = aufloesen("display", { ...l, ziel: "nf2-ws-back", eltern: ["nf2-side-head", "nf2-ws"] });
    ok(db && db.wert === "none",
      `${lage}: der Klartext-Rueckweg ist ${db ? '"' + db.wert + '" statt none' : "ohne jede Regel (es gibt ihn nicht)"}`);
    const dn = aufloesen("display", { ...l, ziel: "nf2-ws-name", eltern: ["nf2-side-head", "nf2-ws"] });
    ok(!dn || dn.wert !== "none", `${lage}: das NoteFlow-Branding wurde ausgeblendet`);
    const dx = aufloesen("display", { ...l, ziel: "nf2-iconbtn", zielId: "nf2CloseBtn",
      eltern: ["nf2-side-head"], zielEl: "button" });
    ok(!dx || dx.wert !== "none", `${lage}: das ✕ wurde auf dem breiten Schirm ausgeblendet`);
    // Es darf keine schmale Regel geben, die .nf2-iconbtn GLOBAL vergroessert.
    const global44 = REGELN.filter((r) => r.medienBreite !== null && r.selektor === ".nf2-iconbtn" &&
      /width\s*:\s*44/.test(r.deklarationen));
    ok(global44.length === 0,
      `${lage}: eine Media-Regel setzt .nf2-iconbtn global auf 44 px — das trifft auch den Desktop-Selektor`);
  }
}

// Kein NEUES !important. Der Bestand (zweimal .nf2-mention) bleibt unangetastet — geprueft wird, dass
// keine der von M2 angefassten Regeln zum Holzhammer greift. Kommentare
// werden vorher entfernt, sonst schlaegt der Test auf seiner eigenen
// Begruendung an.
{
  const M2_SELEKTOREN = [".nf2-scrim", ".nf2-sideclose", ".nf2-main", ".nf2-iconbtn",
    ".nf2:not(.side-hidden) .nf2-scrim"];
  for (const r of REGELN) {
    if (!M2_SELEKTOREN.includes(r.selektor)) continue;
    const rein = r.deklarationen.replace(/\/\*[\s\S]*?\*\//g, "");
    ok(!/!important/.test(rein), `die M2-Regel "${r.selektor}" arbeitet mit !important`);
  }
  const neueImportant = (CSS.replace(/\/\*[\s\S]*?\*\//g, "").match(/!important/g) || []).length;
  ok(neueImportant === 2,
    `${neueImportant} !important im injectCSS-Template statt der zwei bekannten ` +
    "(beide in .nf2-mention) — M2 hat eines hinzugefuegt");
}

// ═══ 3. MARKUP UND VERDRAHTUNG ══════════════════════════════════════════
{
  const sh = index.indexOf("  function buildShell() {");
  const shEnde = index.indexOf("\n  function ", sh + 10);
  const SHELL = index.slice(sh, shEnde);

  ok(/id="nf2Scrim"/.test(SHELL), "der Scrim fehlt im Markup");
  ok(/id="nf2SideClose"/.test(SHELL), "der Seitenleisten-Schliesser fehlt im Markup");
  ok(/id="nf2SideToggle"[^>]*aria-controls="nf2Side"/.test(SHELL),
    "der Umschalter benennt die Leiste nicht ueber aria-controls");
  ok(/id="nf2SideToggle"[^>]*aria-expanded=/.test(SHELL),
    "der Umschalter traegt kein aria-expanded");
  ok(/id="nf2SideClose"[^>]*aria-label="Seitenleiste schliessen"/.test(SHELL),
    "der Schliesser sagt nicht, was er schliesst — auf dem Telefon steht er neben dem ✕");
  ok(/id="nf2CloseBtn"[^>]*aria-label="NoteFlow schliessen"/.test(SHELL),
    "das ✕ sagt nicht, dass es NoteFlow verlaesst");
  // Codex-Review 4: schmal muss der App-Rueckweg im KLARTEXT dastehen —
  // ein aria-label allein sieht ein Daumen nicht.
  ok(/<span class="nf2-ws-back">← Quantus<\/span>/.test(SHELL),
    "der sichtbare Klartext-Rueckweg \"← Quantus\" fehlt im Markup");
  ok(/id="nf2Back"[^>]*role="button"/.test(SHELL),
    "der App-Rueckweg ist fuer Hilfsmittel kein Bedienelement");
  ok(/id="nf2Back"[^>]*aria-label="Zurück zu Quantus"/.test(SHELL),
    "der App-Rueckweg traegt kein aria-label");
  ok(/<span class="nf2-ws-name">NoteFlow<\/span>/.test(SHELL),
    "das NoteFlow-Branding wurde aus dem Markup entfernt — der Desktop verliert es");
  // Und der Rueckweg ruft weiterhin close(), waehrend Schliesser und Scrim das
  // niemals tun. Genau diese Trennung ist der Kern des Reviews.
  const wire2 = (id) => {
    const m = new RegExp('\\$\\("#' + id + '"\\)\\.onclick\\s*=\\s*([^;]+);').exec(SHELL);
    return m ? m[1].trim() : null;
  };
  ok(wire2("nf2Back") === "close", `#nf2Back ist verdrahtet als "${wire2("nf2Back")}" statt close`);
  ok(!/close/.test(wire2("nf2SideClose") || ""), "#nf2SideClose ruft close()");
  ok(!/close/.test(wire2("nf2Scrim") || ""), "#nf2Scrim ruft close()");

  const wire = (id) => {
    const m = new RegExp('\\$\\("#' + id + '"\\)\\.onclick\\s*=\\s*([^;]+);').exec(SHELL);
    return m ? m[1].trim() : null;
  };
  ok(/setSide\(!sideOffen\(\)\)/.test(wire("nf2SideToggle") || ""),
    `der Umschalter ist verdrahtet als "${wire("nf2SideToggle")}" — erwartet der setSide-Trichter`);
  ok(wire("nf2SideClose") === "() => setSide(false)",
    `#nf2SideClose ist verdrahtet als "${wire("nf2SideClose")}"`);
  ok(wire("nf2Scrim") === "() => setSide(false)",
    `#nf2Scrim ist verdrahtet als "${wire("nf2Scrim")}"`);
}

// ═══ 4. DER KERNNACHWEIS: der neue Weg verlaesst NIE die App ════════════
function api({ breite = 390, sideOffen = true, aktiv = true } = {}) {
  // TOLERANT laden. Auf einem Stand VOR dem Fix gibt es setSide/istSchmal/
  // sideOffen nicht. Ein harter Ausschnitt liesse den Test dann mit einer
  // ReferenceError sterben — rot aus dem falschen Grund, ohne je das
  // Verhalten von onGlobalKey oder openPage zu zeigen. Fehlende Namen kommen
  // deshalb als null zurueck; ihre Abwesenheit wird unten als eigener Befund
  // gemeldet, und alles, was es gibt, laeuft echt weiter.
  const holen = (name) => {
    const a = index.indexOf("  function " + name + "(");
    if (a < 0) return "";
    const e = index.indexOf("\n  }\n", a);
    return e > a ? index.slice(a, e + 5) : "";
  };
  const NAMEN = ["istSchmal", "sideOffen", "setSide", "registriereResponsiveEintritt",
    "onGlobalKey", "openPage"];
  const quelle = NAMEN.map(holen).join("\n") + "\nreturn {" +
    NAMEN.map((n) => `${n}: typeof ${n} === "function" ? ${n} : null`).join(",") + "};";

  const protokoll = { close: 0, closeApp: 0, openApp: [], navigation: [], fokus: [],
    renderSidebar: 0, renderPage: 0, open: 0, flushSave: 0 };
  const klassen = new Set(["nf2"]);
  if (!sideOffen) klassen.add("side-hidden");
  const attribute = {};
  const mach = (id) => ({
    id,
    classList: {
      contains: (k) => klassen.has(k),
      add: (k) => klassen.add(k),
      remove: (k) => klassen.delete(k),
      toggle: (k, an) => { if (an) klassen.add(k); else klassen.delete(k); },
    },
    setAttribute: (k, v) => { attribute[id + ":" + k] = v; },
    getAttribute: (k) => attribute[id + ":" + k],
    focus: () => protokoll.fokus.push(id),
    style: {},
  });
  const knoten = {};
  const $ = (sel) => {
    const id = String(sel).replace("#", "");
    if (!knoten[id]) knoten[id] = mach(id);
    return knoten[id];
  };
  knoten.nf2Menu = Object.assign(mach("nf2Menu"), { style: { display: "none" } });
  knoten.nf2Bubble = Object.assign(mach("nf2Bubble"), { style: { display: "none" } });
  knoten.nf2Palette = Object.assign(mach("nf2Palette"), { style: { display: "none" } });

  const behaelter = { classList: { contains: (k) => (k === "active" ? aktiv : false) } };
  const S = { noteId: "n1", view: "page" };
  // Eine matchMedia-Attrappe, die man wirklich feuern kann. Nur so laesst sich
  // ein echter Uebergang 1180 -> 820 -> 390 -> 1180 nachstellen, statt bloss zu
  // pruefen, dass irgendwo ein addEventListener steht.
  const mq = { breite, hoerer: [], listenerAlt: 0,
    get matches() { return this.breite <= 900; },
    addEventListener(typ, fn) { if (typ === "change") this.hoerer.push(fn); },
    addListener(fn) { this.listenerAlt++; this.hoerer.push(fn); },
  };
  const fn = new Function(
    "$", "window", "container", "notesMap", "flushSave", "S", "renderSidebar", "renderPage",
    "open", "close", "hideMenu", "newNote", "styleSelection", "String", "Number",
    quelle)(
    $,
    { matchMedia: () => mq, get innerWidth() { return mq.breite; } },
    () => behaelter,
    () => ({ n1: { id: "n1" }, n2: { id: "n2" } }),
    () => { protokoll.flushSave++; },
    S,
    () => { protokoll.renderSidebar++; },
    () => { protokoll.renderPage++; },
    () => { protokoll.open++; },
    () => { protokoll.close++; },
    () => {}, () => {}, () => {},
    String, Number);
  // Einen echten Viewport-Wechsel ausloesen — genau wie der Browser es taete.
  const wechsle = (neueBreite) => {
    const vorher = mq.matches;
    mq.breite = neueBreite;
    const nachher = mq.matches;
    if (vorher === nachher) return;   // kein Uebergang, kein Ereignis
    mq.hoerer.forEach((h) => h({ matches: nachher, media: "(max-width:900px)" }));
  };
  return { ...fn, protokoll, klassen, attribute, knoten, S, mq, wechsle };
}

// Der Scrim-/Schliesser-Weg
for (const v of [390, 820]) {
  const a = api({ breite: v, sideOffen: true });
  if (!a.setSide) { ok(false, `${v} px: setSide() existiert nicht — es gibt keinen Trichter fuer den Leistenzustand`); continue; }
  a.setSide(false);
  ok(a.klassen.has("side-hidden"), `${v} px: setSide(false) klappt die Leiste nicht ein`);
  ok(a.protokoll.close === 0,
    `${v} px: DER BEFUND — der Schliessweg rief close() und verliess NoteFlow`);
  ok(a.protokoll.open === 0 && a.protokoll.openApp.length === 0 && a.protokoll.navigation.length === 0,
    `${v} px: der Schliessweg loeste eine App-Navigation aus`);
  ok(a.attribute["nf2SideToggle:aria-expanded"] === "false",
    `${v} px: aria-expanded ist "${a.attribute["nf2SideToggle:aria-expanded"]}" statt false`);
  ok(a.attribute["nf2Scrim:aria-hidden"] === "true", `${v} px: der Scrim bleibt fuer Hilfsmittel sichtbar`);
  ok(a.protokoll.fokus.includes("nf2SideToggle"),
    `${v} px: der Fokus blieb in der unsichtbar gewordenen Leiste`);

  a.setSide(true);
  ok(!a.klassen.has("side-hidden"), `${v} px: setSide(true) oeffnet die Leiste nicht`);
  ok(a.attribute["nf2SideToggle:aria-expanded"] === "true", `${v} px: aria-expanded nach dem Oeffnen falsch`);
  ok(a.protokoll.fokus.includes("nf2SideClose"),
    `${v} px: beim Oeffnen bekommt nicht der Leisten-Schliesser den Fokus (protokoll: ${a.protokoll.fokus.join(",")})`);
  ok(!a.protokoll.fokus.includes("nf2Search"),
    `${v} px: der Fokus sprang in das Suchfeld — auf einem Telefon faehrt dann ungefragt die Tastatur hoch`);
  ok(a.protokoll.close === 0, `${v} px: das Oeffnen rief close()`);
}

// Escape: schmal + offen -> nur die Leiste; sonst wie bisher NoteFlow
{
  const halt = () => {};
  for (const v of [390, 820]) {
    const a = api({ breite: v, sideOffen: true });
    a.onGlobalKey({ key: "Escape", preventDefault: halt, stopPropagation: halt });
    ok(a.klassen.has("side-hidden"), `${v} px: Escape schloss die offene Leiste nicht`);
    ok(a.protokoll.close === 0,
      `${v} px: DER BEFUND — Escape verliess bei offener Leiste sofort die ganze App`);

    const b = api({ breite: v, sideOffen: false });
    b.onGlobalKey({ key: "Escape", preventDefault: halt, stopPropagation: halt });
    ok(b.protokoll.close === 1,
      `${v} px: bei eingeklappter Leiste muss Escape NoteFlow schliessen (close: ${b.protokoll.close})`);
  }
  for (const v of [1180, 1440]) {
    const a = api({ breite: v, sideOffen: true });
    a.onGlobalKey({ key: "Escape", preventDefault: halt, stopPropagation: halt });
    ok(a.protokoll.close === 1,
      `${v} px: auf dem breiten Schirm muss Escape wie bisher NoteFlow schliessen (close: ${a.protokoll.close})`);
    ok(!a.klassen.has("side-hidden"), `${v} px: Escape klappte die Leiste ein — Desktop-Regression`);
  }
}

// Nach der Auswahl einer Seite gibt die Leiste schmal den Platz frei
{
  for (const v of [390, 820]) {
    const a = api({ breite: v, sideOffen: true });
    a.openPage("n2");
    ok(a.klassen.has("side-hidden"), `${v} px: nach der Seitenauswahl deckt die Leiste den Inhalt weiter ab`);
    ok(a.protokoll.close === 0, `${v} px: die Seitenauswahl rief close()`);
    ok(a.protokoll.renderPage === 1, `${v} px: die gewaehlte Seite wurde nicht gerendert`);
  }
  for (const v of [1180, 1440]) {
    const a = api({ breite: v, sideOffen: true });
    a.openPage("n2");
    ok(!a.klassen.has("side-hidden"),
      `${v} px: die Leiste klappte nach der Auswahl ein — auf dem breiten Schirm verdeckt sie nichts`);
  }
}

// istSchmal an den Grenzen
{
  const g = api({ breite: 900 });
  ok(!!g.istSchmal, "istSchmal() existiert nicht — es gibt keine Schwelle fuer schmale Geraete");
  if (g.istSchmal) {
    ok(g.istSchmal() === true, "900 px gilt nicht als schmal");
    ok(api({ breite: 901 }).istSchmal() === false, "901 px gilt als schmal");
  }
}

// ═══ 4b. RESPONSIVE EINTRITT — ein ECHTER Uebergang ════════════════════
// Codex-Review 3: open() laeuft beim Verkleinern nicht noch einmal. Wer
// NoteFlow breit geoeffnet hat und dann dreht oder das Fenster zieht, haette
// die Leiste weiter offen ueber dem Inhalt. Geprueft wird deshalb der echte
// matchMedia-Uebergang, nicht die blosse Anwesenheit eines Listeners.
{
  const a = api({ breite: 1180, sideOffen: true });
  ok(!!a.registriereResponsiveEintritt,
    "registriereResponsiveEintritt() existiert nicht — ein Uebergang Desktop->schmal bleibt unbehandelt");
  if (a.registriereResponsiveEintritt) {
    a.registriereResponsiveEintritt();
    ok(a.mq.hoerer.length === 1, `nach der Registrierung sind ${a.mq.hoerer.length} Hoerer angemeldet statt 1`);
    ok(!!a.S.mqEintritt, "die Registrierung hinterlaesst keinen Merker — sie liefe bei jedem open() erneut");

    // IDEMPOTENZ: dreimal aufrufen, ein Hoerer.
    a.registriereResponsiveEintritt();
    a.registriereResponsiveEintritt();
    ok(a.mq.hoerer.length === 1,
      `nach drei Aufrufen sind ${a.mq.hoerer.length} Hoerer angemeldet — jedes open() haengt einen weiteren an`);

    // 1180 -> 820: der echte Eintritt. NUR die Leiste schliesst.
    ok(!a.klassen.has("side-hidden"), "Vorbedingung: die Leiste war breit offen");
    a.wechsle(820);
    ok(a.klassen.has("side-hidden"),
      "beim Uebergang 1180 -> 820 blieb die Leiste offen — sie liegt dann ueber dem Inhalt und ueber ihrem Umschalter");
    ok(a.protokoll.close === 0, "der Uebergang rief close() — er haette NoteFlow verlassen");
    ok(a.protokoll.open === 0, "der Uebergang rief open() — ein zweiter App-Start");
    ok(a.protokoll.openApp.length === 0 && a.protokoll.navigation.length === 0,
      "der Uebergang loeste eine App-Navigation aus");
    ok(a.attribute["nf2SideToggle:aria-expanded"] === "false",
      "aria-expanded wurde beim Uebergang nicht nachgezogen");

    // 820 -> 390: schon schmal, kein zweiter Uebergang, kein Ereignis.
    const vorher = { close: a.protokoll.close, open: a.protokoll.open };
    a.wechsle(390);
    ok(a.protokoll.close === vorher.close && a.protokoll.open === vorher.open,
      "ein Wechsel innerhalb der schmalen Klasse loeste etwas aus");

    // 390 -> 1180: zurueck nach breit. GAR NICHTS.
    const zustandVorher = a.klassen.has("side-hidden");
    a.wechsle(1180);
    ok(a.klassen.has("side-hidden") === zustandVorher,
      "der Rueckweg nach breit veraenderte den Leistenzustand — er ueberschreibt die Wahl des Nutzers");
    ok(a.protokoll.close === 0 && a.protokoll.open === 0,
      "der Rueckweg nach breit rief close() oder open()");
    ok(a.protokoll.openApp.length === 0 && a.protokoll.navigation.length === 0,
      "der Rueckweg nach breit loeste eine App-Navigation aus");

    // Hin und her, fuenfmal: keine Schleife, kein Aufschaukeln.
    for (let i = 0; i < 5; i++) { a.wechsle(390); a.wechsle(1440); }
    ok(a.protokoll.close === 0 && a.protokoll.open === 0,
      "wiederholtes Drehen erzeugte App-Aufrufe — der Vertrag schaukelt sich auf");
    ok(a.mq.hoerer.length === 1, `nach zehn Wechseln sind ${a.mq.hoerer.length} Hoerer angemeldet`);
  }

  // Ein bereits eingeklappter Zustand bleibt beim Eintritt unberuehrt.
  const b = api({ breite: 1180, sideOffen: false });
  if (b.registriereResponsiveEintritt) {
    b.registriereResponsiveEintritt();
    b.wechsle(390);
    ok(b.protokoll.fokus.length === 0,
      "der Eintritt sprang mit dem Fokus herum, obwohl die Leiste schon zu war");
  }

  // Ist NoteFlow gar nicht offen, tut der Eintritt nichts.
  const c = api({ breite: 1180, sideOffen: true, aktiv: false });
  if (c.registriereResponsiveEintritt) {
    c.registriereResponsiveEintritt();
    c.wechsle(390);
    ok(!c.klassen.has("side-hidden"), "der Eintritt fasste eine geschlossene NoteFlow-Instanz an");
    ok(c.protokoll.close === 0, "der Eintritt rief close() bei geschlossenem NoteFlow");
  }

  // Und open() registriert ihn ueberhaupt.
  {
    const src = index.slice(index.indexOf("  function open(noteId) {"),
      index.indexOf("\n  function close()", index.indexOf("  function open(noteId) {")));
    ok(/registriereResponsiveEintritt\(\)/.test(src),
      "open() registriert den Responsive-Eintritt nicht — er waere nie aktiv");
  }
}

// ═══ 5. open(): schmal startet die Leiste eingeklappt ═══════════════════
{
  const a = index.indexOf("  function open(noteId) {");
  const koerper = index.slice(a, index.indexOf("\n  function close()", a));
  ok(/istSchmal\(\) && !already\) setSide\(false\)/.test(koerper),
    "open() startet auf schmalen Geraeten nicht eingeklappt — die Leiste liegt dann wieder ueber ihrem eigenen Umschalter");
  ok(!/closeApp|openApp\(/.test(koerper), "open() ruft App-Navigation");
}

// ═══ 6. Fremde Bereiche unberuehrt ═════════════════════════════════════
for (const anker of [
  "async function canonicalWrite(quelle, options = {})",
  "const CORE_PROVIDER_ORDER = ['rtdb', 'netlify'];",
  "if (typeof logDeletion === 'function') logDeletion(kind, id);",
  "function coreWriteGuard(fnName, key, options)",
  'SMARTER.noFirebase = true; SMARTER.loaded = true;',
  'case "bmpruefung": window.location.href = "bm.html"; return;',
]) {
  ok(index.includes(anker), `ein fremder Bereich wurde beruehrt: "${anker}" fehlt`);
}
ok(/\.app,\n      \.app\.sidebar-collapsed\{grid-template-columns:minmax\(0,1fr\)\}/.test(index),
  "die M1-Regel wurde veraendert — M1 ist produktiv und darf nicht nachbearbeitet werden");

// ── Bericht ─────────────────────────────────────────────────────────────
if (luecken.length) {
  console.error("M2 NOTEFLOW MOBILE SIDEBAR — " + luecken.length + " von " + checks + " Pruefungen:");
  luecken.forEach((l) => console.error("   - " + l));
  process.exit(1);
}
console.log(`m2 noteflow mobile sidebar: ok (${checks} Pruefungen)`);
