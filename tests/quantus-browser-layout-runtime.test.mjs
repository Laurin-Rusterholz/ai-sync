/*
 * Quantus Browser (#/browser) — Laufzeittest der Buehne.
 *
 * Live-Befund vom 07.08.2026: Der neko-Dienst lief einwandfrei, direkt auf der
 * Origin zeigte der Stream ein vollstaendiges Chromium. In Quantus wirkte
 * dasselbe Bild dagegen zusammengedraengt: Die Buehne rechnete mit einer festen
 * Hoehe (`100vh - 96px`), die weder die Kopfzeile noch die Innenabstaende von
 * #main kannte, sass in einem Scrollcontainer und wurde von den Seitenpanels
 * zusammengeschoben. Ein Routenwechsel baute das iframe komplett neu auf —
 * Anmeldung und offene Chromium-Tabs waren jedes Mal weg.
 *
 * Dieser Test prueft deshalb nicht den Quelltext, sondern SCHNEIDET das echte
 * Browsermodul aus public/index.html heraus und FUEHRT ES AUS — gegen ein
 * nachgebautes DOM mit steuerbarer Uhr, steuerbarem `fetch` und ohne
 * Fullscreen-API, wo der CSS-Rueckfall greifen muss.
 *
 * Nachgewiesen werden:
 *   1. Skalierung: das 1280x720-Bild bleibt unverzerrt und so gross wie moeglich
 *   2. Viewport-Logik inklusive Kleinfenster-Fall
 *   3. Zustandserhalt ueber Routen- und Vollbildwechsel
 *   4. In-App-Vollbild ohne Fullscreen-API (CSS-Rueckfall) und zurueck
 *   5. Loading / Offline / Reconnect ohne kleine oder leere Restflaeche
 *   6. Standardzustand der Seitenpanels, Fokus und Klickdurchlaessigkeit
 *   7. keine Geheimnisse in der iframe-URL
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

// ── Das echte Modul aus der Seite schneiden ────────────────────────────────
const from = index.indexOf("const QUANTUS_BROWSER_ORIGIN =");
const to = index.indexOf("\nfunction goBack() {", from);
ok(from > 0 && to > from, "das Browsermodul wurde in public/index.html nicht gefunden");
const MODULE_SOURCE = index.slice(from, to);
ok(MODULE_SOURCE.includes("function viewBrowser()"), "viewBrowser() fehlt im geschnittenen Modul");

// ── Minimales DOM ──────────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...c) { c.forEach((x) => this._set.add(x)); }
  remove(...c) { c.forEach((x) => this._set.delete(x)); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this._set.has(c) : !!force;
    if (on) this._set.add(c); else this._set.delete(c);
    return on;
  }
  get list() { return [...this._set]; }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this._doc = doc;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.hidden = false;
    this.id = "";
    this.className = "";
    this.title = "";
    this.textContent = "";
    this.src = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.focusCount = 0;
    this.clickCount = 0;
    this._html = "";
    this._listeners = new Map();
  }
  set innerHTML(v) {
    this._html = String(v);
    // Wie im echten DOM: abgeraeumte Knoten sind ueber getElementById weg.
    const drop = (node) => {
      for (const child of node.children) {
        if (child.id) this._doc._byId.delete(child.id);
        child.parentNode = null;
        drop(child);
      }
      node.children = [];
    };
    drop(this);
  }
  get innerHTML() { return this._html; }
  set class(v) { this.className = v; }
  appendChild(el) {
    el.parentNode = this;
    this.children.push(el);
    if (el.id) this._doc._byId.set(el.id, el);
    return el;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "id") { this.id = value; } }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type);
    if (l) this._listeners.set(type, l.filter((f) => f !== fn));
  }
  dispatch(type, event) { for (const fn of this._listeners.get(type) || []) fn(event || { type }); }
  focus() { this.focusCount++; }
  click() { this.clickCount++; this.dispatch("click", { type: "click" }); }
  contains(el) {
    for (let n = el; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  querySelector(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const walk = (node) => {
      for (const child of node.children) {
        if (cls && child.classList.contains(cls)) return child;
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}

// Baut genau die Huelle nach, die als Markup in public/index.html steht.
function makeDom() {
  const doc = { _byId: new Map(), _listeners: new Map() };
  const el = (tag, id, cls) => {
    const e = new FakeElement(tag, doc);
    if (id) { e.id = id; doc._byId.set(id, e); }
    if (cls) e.classList.add(...cls.split(" "));
    return e;
  };

  const body = el("body");
  const app = el("div", "app");
  const main = el("main", "main");
  const panelDock = el("aside", "panelDock");
  const host = el("section", "quantusBrowserHost", "qbr-host");
  const bar = el("header", null, "qbr-bar");
  const status = el("span", "quantusBrowserStatus", "qbr-status");
  const statusText = el("span", null, "qbr-status-text");
  const fullBtn = el("button", "quantusBrowserFullBtn", "qbr-btn qbr-btn-main");
  const note = el("div", "quantusBrowserNote", "qbr-note");
  const stage = el("div", "quantusBrowserStage", "qbr-stage");
  const canvas = el("div", "quantusBrowserCanvas", "qbr-canvas");
  const overlay = el("div", "quantusBrowserOverlay", "qbr-overlay");
  const qcFab = el("button", "qc-fab");

  host.hidden = true;
  note.hidden = true;
  overlay.hidden = true;
  status.dataset.state = "idle";
  statusText.textContent = "Pausiert";

  status.appendChild(statusText);
  bar.appendChild(status);
  bar.appendChild(fullBtn);
  host.appendChild(bar);
  host.appendChild(note);
  stage.appendChild(canvas);
  stage.appendChild(overlay);
  host.appendChild(stage);
  app.appendChild(main);
  app.appendChild(panelDock);
  app.appendChild(host);
  body.appendChild(app);
  body.appendChild(qcFab);

  doc.body = body;
  doc.activeElement = body;
  doc.documentElement = el("html");
  doc.fullscreenElement = null;
  doc.webkitFullscreenElement = null;
  doc.getElementById = (id) => doc._byId.get(id) || null;
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.addEventListener = (type, fn) => {
    if (!doc._listeners.has(type)) doc._listeners.set(type, []);
    doc._listeners.get(type).push(fn);
  };
  doc.removeEventListener = () => {};
  doc.dispatch = (type, event) => { for (const fn of doc._listeners.get(type) || []) fn(event || { type }); };

  return { doc, nodes: { body, app, main, panelDock, host, bar, status, statusText, fullBtn, note, stage, canvas, overlay, qcFab } };
}

// ── Steuerbare Uhr ─────────────────────────────────────────────────────────
function makeClock() {
  let now = 1_754_500_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms;
      // In Faelligkeitsreihenfolge feuern, damit Nachfolgetimer korrekt greifen.
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    }
  };
}

// Mikrotasks abarbeiten lassen (der Test selbst nutzt echte Timer).
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((res) => setImmediate(res));
};

// ── Modulinstanz mit frischem DOM ──────────────────────────────────────────
function makeApp(options = {}) {
  const { doc, nodes } = makeDom();
  const clock = makeClock();
  const calls = { closeSlidePanel: 0, openedTabs: [], fetches: [] };
  const store = new Map();

  const win = {
    innerWidth: options.innerWidth ?? 1440,
    innerHeight: options.innerHeight ?? 900,
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!win._listeners.has(type)) win._listeners.set(type, []);
      win._listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type) { for (const fn of win._listeners.get(type) || []) fn({ type }); },
    open: (url) => { calls.openedTabs.push(url); }
  };

  // Die Buehne bekommt so viel Platz, wie sie im Grid tatsaechlich haette.
  const layout = () => {
    const nav = nodes.app.classList.contains("sidebar-collapsed") ? 0 : 188;
    const full = doc.body.classList.contains("qbr-full");
    const barH = 40 + (nodes.note.hidden ? 0 : 26);
    nodes.stage.clientWidth = full ? win.innerWidth : Math.max(0, win.innerWidth - nav);
    nodes.stage.clientHeight = full ? win.innerHeight - barH : Math.max(0, win.innerHeight - 52 - barH);
  };
  layout();

  const net = {
    fetch: async (url) => {
      calls.fetches.push(url);
      if (net.offline) throw Object.assign(new Error("nope"), { name: "TypeError" });
      return { ok: true };
    },
    offline: !!options.offline
  };

  const sandbox = {
    document: doc,
    window: win,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    Date: { now: () => clock.now() },
    AbortController: function AbortController() { this.signal = {}; this.abort = () => {}; },
    ResizeObserver: options.resizeObserver === false ? undefined : function ResizeObserver(fn) {
      this.observe = () => { sandbox.__onResize = fn; };
      this.disconnect = () => {};
    },
    // Ueber die Kapsel, damit ein Test das Netz mitten im Lauf umschalten kann.
    fetch: (url) => net.fetch(url),
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    closeSlidePanel: () => { calls.closeSlidePanel++; },
    console: { warn() {}, error() {}, log() {} }
  };

  const factory = new Function(
    ...Object.keys(sandbox),
    MODULE_SOURCE + `
    return {
      state: quantusBrowserState,
      src: quantusBrowserSrc,
      fitBox: quantusBrowserFitBox,
      viewportClass: quantusBrowserViewportClass,
      fit: quantusBrowserFit,
      enter: quantusBrowserEnter,
      leave: quantusBrowserLeave,
      connect: quantusBrowserConnect,
      unmount: quantusBrowserUnmount,
      toggleFullscreen: quantusBrowserToggleFullscreen,
      setFullscreen: quantusBrowserSetFullscreen,
      statusHtml: quantusBrowserStatusHtml,
      dismissNote: quantusBrowserDismissNote,
      view: viewBrowser,
      IDLE_MS: QUANTUS_BROWSER_IDLE_MS,
      RETRY_MS: QUANTUS_BROWSER_RETRY_MS,
      LOAD_MS: QUANTUS_BROWSER_LOAD_MS
    };`
  );
  const api = factory(...Object.values(sandbox));

  const frame = () => doc.getElementById("quantusBrowserFrame");
  return {
    api, doc, nodes, clock, calls, win, layout, sandbox, net, frame,
    // Erst Grosse nachziehen, dann rechnen — genau wie der echte Resize-Pfad.
    resize(w, h) { win.innerWidth = w; win.innerHeight = h; layout(); win.dispatch("resize"); },
    // Der Browser meldet den fertigen Stream. Danach noch einmal umbrechen:
    // der eingeblendete Anmeldehinweis veraendert die Resthoehe.
    loadFrame() {
      layout();
      const f = frame();
      ok(!!f, "kein iframe zum Laden vorhanden");
      f.dispatch("load");
      layout();
      api.fit();
    }
  };
}

// ═══ 1. Skalierung: unverzerrt und so gross wie moeglich ═══════════════════
console.log("\n1. Skalierung des 1280x720-Bildes");
{
  const app = makeApp();
  const { fitBox } = app.api;
  const R = 16 / 9;

  eq(fitBox(1200, 700, R), { width: 1200, height: 675 }, "breite Flaeche: volle Breite nutzen");
  eq(fitBox(1200, 500, R), { width: 889, height: 500 }, "flache Flaeche: an der Hoehe ausrichten");
  eq(fitBox(1280, 720, R), { width: 1280, height: 720 }, "exakt passende Flaeche bleibt exakt");
  eq(fitBox(0, 700, R), { width: 0, height: 0 }, "keine Flaeche, keine Groesse");
  eq(fitBox(-40, -40, R), { width: 0, height: 0 }, "negative Werte ergeben keine Groesse");

  // Nie ueber die verfuegbare Flaeche hinaus — sonst wird abgeschnitten.
  for (const [w, h] of [[1252, 808], [1092, 628], [646, 980], [1400, 300], [300, 1400]]) {
    const box = fitBox(w, h, R);
    ok(box.width <= w && box.height <= h, `Buehne laeuft ueber: ${w}x${h} -> ${box.width}x${box.height}`);
    if (box.width && box.height) {
      // Rundung auf ganze Pixel darf das Verhaeltnis nur minimal verschieben.
      ok(Math.abs(box.width / box.height - R) < 0.01,
        `Verzerrung bei ${w}x${h}: ${box.width}x${box.height}`);
      // Und es muss die groesste passende Flaeche sein: eine Seite liegt an.
      ok(box.width === w || box.height === h,
        `Buehne bleibt unnoetig klein bei ${w}x${h}: ${box.width}x${box.height}`);
    }
  }

  // Ohne brauchbares Verhaeltnis wird auf 1280x720 zurueckgefallen.
  eq(fitBox(1280, 2000, 0), { width: 1280, height: 720 }, "Rueckfall auf das Remote-Verhaeltnis");
  eq(fitBox(1280, 2000, NaN), { width: 1280, height: 720 }, "NaN faellt auf das Remote-Verhaeltnis zurueck");
}

// ═══ 2. Viewport-Klassen ═══════════════════════════════════════════════════
console.log("\n2. Viewport-Klassen und Abnahmegroessen");
{
  const { viewportClass } = makeApp().api;
  eq(viewportClass(1440, 900), "wide", "1440x900 ist die volle Arbeitsflaeche");
  eq(viewportClass(1280, 720), "wide", "1280x720 ist die volle Arbeitsflaeche");
  eq(viewportClass(1024, 768), "compact", "schmaler Tablet-Viewport ist kompakt");
  eq(viewportClass(834, 1112), "compact", "hochkantes Tablet ist kompakt");
  eq(viewportClass(1440, 560), "compact", "flaches Fenster ist kompakt");
  eq(viewportClass(390, 844), "tiny", "Handy ist zu klein fuer die Buehne");
  eq(viewportClass(1440, 400), "tiny", "sehr flaches Fenster ist zu klein");
  eq(viewportClass(0, 0), "tiny", "ohne Viewport gibt es keine Buehne");
}

// ═══ 3. Verbinden, Groesse, Status ═════════════════════════════════════════
console.log("\n3. Verbinden, Flaechenberechnung und Statusanzeige");
{
  const app = makeApp({ innerWidth: 1440, innerHeight: 900 });
  eq(app.api.view(), "", "viewBrowser() darf kein Markup mehr nach #main schreiben");
  ok(app.doc.body.classList.contains("qbr-mode") === false, "der Browsermodus startet aus");

  app.clock.advance(1); // das setTimeout(quantusBrowserEnter, 0) aus viewBrowser()
  ok(app.doc.body.classList.contains("qbr-mode"), "Browsermodus wurde nicht gesetzt");
  ok(app.nodes.host.hidden === false, "die Buehne bleibt versteckt");
  eq(app.calls.closeSlidePanel, 1, "das Details-Panel wird beim Betreten nicht geschlossen");
  eq(app.nodes.status.dataset.state, "checking", "kein Ladezustand in der Kopfzeile");
  ok(app.nodes.overlay.hidden === false, "kein Ladehinweis auf der Buehne");
  ok(app.nodes.overlay.innerHTML.includes("Verbinde mit dem Quantus Browser"), "falscher Ladehinweis");

  await flush();
  ok(!!app.frame(), "nach erfolgreicher Erreichbarkeitspruefung fehlt das iframe");
  eq(app.frame().attributes.allowfullscreen, "", "allowfullscreen fehlt am iframe");
  ok(/clipboard-read/.test(app.frame().attributes.allow), "Zwischenablage-Rechte fehlen am iframe");

  app.loadFrame();
  eq(app.nodes.status.dataset.state, "online", "Verbindungsstatus wird nicht auf verbunden gesetzt");
  eq(app.nodes.statusText.textContent, "Verbunden", "kein lesbarer Verbindungsstatus");
  ok(app.nodes.overlay.hidden === true, "der Ladehinweis bleibt ueber dem Stream stehen");
  eq(app.nodes.overlay.innerHTML, "", "der Ladehinweis wurde nicht geleert");
  ok(app.nodes.note.hidden === false, "der Anmeldehinweis erscheint nicht");

  // 1440x900: 188px Navigation, 52px Topbar, 40px Kopfzeile, 26px Hinweis.
  eq(app.nodes.canvas.style.width, "1252px", "die Buehne nutzt die Breite nicht aus");
  eq(app.nodes.canvas.style.height, "704px", "die Buehne nutzt die Hoehe nicht aus");
  ok(parseInt(app.nodes.canvas.style.width, 10) > 1000 && parseInt(app.nodes.canvas.style.height, 10) > 600,
    "auf 1440x900 entsteht eine Briefmarke statt einer Arbeitsflaeche");
  ok(app.frame().focusCount > 0, "das iframe bekommt keinen Fokus — Tastatur kaeme nie an");

  // Hinweis wegklicken gibt Hoehe frei; auf 1440x900 ist die Breite die
  // begrenzende Seite, die Buehne bleibt also formatfuellend.
  const stageHBefore = app.nodes.stage.clientHeight;
  app.api.dismissNote();
  ok(app.nodes.note.hidden === true, "der Anmeldehinweis laesst sich nicht ausblenden");
  app.resize(1440, 900);
  ok(app.nodes.stage.clientHeight > stageHBefore, "der weggeklickte Hinweis gibt keine Hoehe frei");
  eq(app.nodes.canvas.style.width, "1252px", "die Buehne nutzt die Breite nicht mehr aus");
  eq(app.nodes.canvas.style.height, "704px", "die Buehne haelt das Seitenverhaeltnis nicht");

  // 1280x720 und Tablet — beide bleiben unverzerrt und formatfuellend.
  app.resize(1280, 720);
  eq(app.nodes.canvas.style.width, "1092px", "1280x720: Breite falsch");
  eq(app.nodes.canvas.style.height, "614px", "1280x720: Hoehe falsch");
  eq(app.nodes.host.dataset.viewport, "wide", "1280x720 wird nicht als volle Flaeche gefuehrt");

  app.resize(1024, 768);
  eq(app.nodes.host.dataset.viewport, "compact", "Tablet wird nicht als kompakt gefuehrt");
  const tabletW = parseInt(app.nodes.canvas.style.width, 10);
  const tabletH = parseInt(app.nodes.canvas.style.height, 10);
  ok(Math.abs(tabletW / tabletH - 16 / 9) < 0.01, "Tablet: das Bild wird verzerrt");
  ok(app.nodes.overlay.hidden === true, "auf dem Tablet wird der Stream unnoetig verdeckt");
}

// ═══ 4. Zustand ueberlebt Routenwechsel ════════════════════════════════════
console.log("\n4. Zustandserhalt ueber Routen- und Vollbildwechsel");
{
  const app = makeApp();
  app.api.enter();
  await flush();
  app.loadFrame();
  const first = app.frame();
  ok(!!first, "kein iframe nach dem Verbinden");

  // Wechsel auf eine andere Route: ausblenden, aber nicht neu aufbauen.
  app.api.leave();
  ok(app.nodes.host.hidden === true, "die Buehne bleibt sichtbar, obwohl die Route weg ist");
  ok(app.doc.body.classList.contains("qbr-mode") === false, "der Browsermodus bleibt haengen");
  ok(app.frame() === first, "das iframe wurde beim Verlassen abgeraeumt");

  // Und zurueck: dasselbe iframe, ohne neuen Netzwerk-Roundtrip.
  const fetchesBefore = app.calls.fetches.length;
  app.api.enter();
  await flush();
  ok(app.frame() === first, "beim Zurueckkommen wird die Sitzung neu aufgebaut");
  eq(app.calls.fetches.length, fetchesBefore, "beim Zurueckkommen wird unnoetig neu geprueft");
  eq(app.nodes.status.dataset.state, "online", "der Verbindungsstatus wurde zurueckgesetzt");
  ok(app.nodes.host.hidden === false, "die Buehne kommt nicht zurueck");

  // Erst nach langer Abwesenheit wird der Stream abgehaengt.
  app.api.leave();
  app.clock.advance(app.api.IDLE_MS - 1000);
  ok(app.frame() === first, "der Stream wurde zu frueh abgehaengt");
  app.clock.advance(2000);
  ok(app.frame() === null, "der Stream laeuft nach langer Abwesenheit weiter");
  eq(app.nodes.status.dataset.state, "idle", "der pausierte Zustand wird nicht angezeigt");

  // Zurueck nach dem Abhaengen: sauberer Neuaufbau.
  app.api.enter();
  await flush();
  ok(!!app.frame() && app.frame() !== first, "nach dem Abhaengen wird nicht neu verbunden");
}

// ═══ 5. In-App-Vollbild ohne Fullscreen-API ════════════════════════════════
console.log("\n5. In-App-Vollbild und CSS-Rueckfall");
{
  const app = makeApp({ innerWidth: 1440, innerHeight: 900 });
  app.api.enter();
  await flush();
  app.loadFrame();
  app.api.dismissNote();
  const frameBefore = app.frame();
  const widthBefore = app.nodes.canvas.style.width;

  // Kein requestFullscreen im DOM — der CSS-Weg muss allein tragen.
  ok(typeof app.nodes.host.requestFullscreen === "undefined", "Testaufbau: Fullscreen-API muss fehlen");
  app.api.toggleFullscreen();
  ok(app.doc.body.classList.contains("qbr-full"), "ohne Fullscreen-API bleibt der CSS-Rueckfall aus");
  eq(app.nodes.host.dataset.fullscreen, "1", "die Buehne kennt ihren Vollbildzustand nicht");
  eq(app.nodes.fullBtn.getAttribute("aria-pressed"), "true", "der Vollbild-Knopf meldet keinen Zustand");
  ok(app.frame() === frameBefore, "der Vollbildwechsel baut den Stream neu auf");

  // Im Vollbild waechst die Flaeche spuerbar.
  app.layout();
  app.api.fit();
  const fullW = parseInt(app.nodes.canvas.style.width, 10);
  ok(fullW > parseInt(widthBefore, 10), `im Vollbild wird die Buehne nicht groesser (${widthBefore} -> ${fullW}px)`);
  eq(app.nodes.canvas.style.width, "1440px", "im Vollbild wird die Breite nicht ausgenutzt");
  eq(app.nodes.canvas.style.height, "810px", "im Vollbild stimmt die Hoehe nicht");

  // Escape schaltet zurueck — ohne die Sitzung zu verlieren.
  app.doc.dispatch("keydown", { key: "Escape" });
  ok(app.doc.body.classList.contains("qbr-full") === false, "Escape beendet das Vollbild nicht");
  eq(app.nodes.host.dataset.fullscreen, "0", "der Vollbildzustand wird nicht zurueckgesetzt");
  ok(app.frame() === frameBefore, "das Verlassen des Vollbilds baut den Stream neu auf");
  ok(app.nodes.host.hidden === false, "nach dem Vollbild ist die Buehne verschwunden");

  // Der Schliessen-Knopf tut dasselbe.
  app.api.toggleFullscreen();
  ok(app.doc.body.classList.contains("qbr-full"), "Vollbild laesst sich nicht erneut oeffnen");
  app.api.setFullscreen(false);
  ok(app.doc.body.classList.contains("qbr-full") === false, "der Schliessen-Weg funktioniert nicht");

  // Und ein Routenwechsel im Vollbild raeumt sauber auf.
  app.api.toggleFullscreen();
  app.api.leave();
  ok(app.doc.body.classList.contains("qbr-full") === false, "das Vollbild ueberlebt den Routenwechsel");
}

// ═══ 6. Native Fullscreen-API und Escape ═══════════════════════════════════
console.log("\n6. Native Fullscreen-API");
{
  const app = makeApp();
  const requested = [];
  app.nodes.host.requestFullscreen = function () {
    requested.push("host");
    app.doc.fullscreenElement = app.nodes.host;
    app.doc.dispatch("fullscreenchange");
    return Promise.resolve();
  };
  app.api.enter();
  await flush();
  app.loadFrame();

  app.api.toggleFullscreen();
  eq(requested, ["host"], "die native Fullscreen-API wird nicht genutzt");
  ok(app.doc.body.classList.contains("qbr-full"), "die CSS-Klasse fehlt trotz nativem Vollbild");

  // Escape beendet die native Sitzung — der Browser meldet fullscreenchange.
  app.doc.fullscreenElement = null;
  app.doc.dispatch("fullscreenchange");
  ok(app.doc.body.classList.contains("qbr-full") === false,
    "nach dem nativen Escape bleibt die Buehne als Overlay ueber der App stehen");

  // Eine abgelehnte Anfrage darf den CSS-Modus nicht kippen.
  const app2 = makeApp();
  app2.nodes.host.requestFullscreen = () => Promise.reject(new Error("nicht erlaubt"));
  app2.api.enter();
  await flush();
  app2.loadFrame();
  app2.api.toggleFullscreen();
  await flush();
  ok(app2.doc.body.classList.contains("qbr-full"),
    "bei abgelehnter Fullscreen-API faellt das In-App-Vollbild aus");
}

// ═══ 7. Offline, Wiederverbinden, keine kleine Restflaeche ═════════════════
console.log("\n7. Offline-, Retry- und Reconnect-Darstellung");
{
  const app = makeApp({ offline: true });
  app.api.enter();
  await flush();

  eq(app.nodes.status.dataset.state, "offline", "der Offline-Zustand steht nicht in der Kopfzeile");
  ok(app.nodes.overlay.hidden === false, "keine Offline-Darstellung");
  ok(app.nodes.overlay.innerHTML.includes("Quantus Browser ist gerade nicht erreichbar"),
    "keine verstaendliche Offline-Meldung");
  ok(!/[.#][a-zA-Z][\w-]*\s*\{/.test(app.nodes.overlay.innerHTML), "CSS-Rohtext in der Offline-Meldung");
  ok(app.nodes.overlay.innerHTML.includes('data-action="browser-retry"'), "kein Wiederholungsversuch angeboten");
  ok(app.frame() === null, "trotz Fehlschlag steht ein leerer iframe-Rahmen");

  // Automatischer Wiederholungsversuch — und diesmal klappt es.
  app.net.offline = false;
  app.clock.advance(app.api.RETRY_MS + 10);
  await flush();
  ok(!!app.frame(), "nach dem Wiederverbinden fehlt das iframe");
  app.loadFrame();
  eq(app.nodes.status.dataset.state, "online", "nach dem Reconnect bleibt der Status haengen");
  ok(app.nodes.overlay.hidden === true, "nach dem Reconnect bleibt die Fehlermeldung stehen");

  // Die eigentliche Regression: nach dem Reconnect darf die Flaeche weder
  // leer noch winzig bleiben.
  const w = parseInt(app.nodes.canvas.style.width, 10);
  const h = parseInt(app.nodes.canvas.style.height, 10);
  ok(w > 1000 && h > 550, `nach dem Reconnect ist die Buehne zu klein: ${w}x${h}`);
  ok(Math.abs(w / h - 16 / 9) < 0.01, "nach dem Reconnect ist das Bild verzerrt");

  // Im Hintergrund wird nicht endlos weiterprobiert.
  const app2 = makeApp({ offline: true });
  app2.api.enter();
  await flush();
  app2.api.leave();
  const tries = app2.calls.fetches.length;
  app2.clock.advance(app2.api.RETRY_MS * 3);
  await flush();
  eq(app2.calls.fetches.length, tries, "der Browser probiert im Hintergrund weiter");
}

// ═══ 8. Watchdog: Verbindung steht, Stream laedt nicht ═════════════════════
console.log("\n8. Watchdog fuer haengende Streams");
{
  const app = makeApp();
  app.api.enter();
  await flush();
  ok(!!app.frame(), "kein iframe zum Ueberwachen");
  app.clock.advance(app.api.LOAD_MS + 10);
  eq(app.nodes.status.dataset.state, "offline", "der haengende Stream wird nicht erkannt");
  ok(app.nodes.overlay.innerHTML.includes("nicht fertig geladen"), "kein Hinweis auf den haengenden Stream");
  ok(app.frame() === null, "der haengende Rahmen bleibt stehen");
}

// ═══ 9. Kleinfenster: Hinweis statt Briefmarke ═════════════════════════════
console.log("\n9. Kleinfenster-Fall");
{
  const app = makeApp({ innerWidth: 390, innerHeight: 844 });
  app.api.enter();
  await flush();
  app.loadFrame();

  eq(app.nodes.host.dataset.viewport, "tiny", "das kleine Fenster wird nicht erkannt");
  ok(app.nodes.overlay.hidden === false, "auf dem kleinen Fenster fehlt der Hinweis");
  ok(app.nodes.overlay.innerHTML.includes("Zu wenig Platz fuer den Browser"), "falscher Hinweis");
  ok(app.nodes.overlay.innerHTML.includes('data-action="browser-fullscreen"'), "kein Vollbild-Aufruf angeboten");
  ok(!!app.frame(), "der Stream wurde fuer den Hinweis abgeraeumt — der Zustand ginge verloren");

  // Im Vollbild greift die Regel bewusst nicht.
  app.api.toggleFullscreen();
  eq(app.nodes.host.dataset.viewport, "wide", "im Vollbild gilt das Fenster weiter als zu klein");
  ok(app.nodes.overlay.hidden === true, "im Vollbild verdeckt der Hinweis den Stream");

  app.api.setFullscreen(false);
  ok(app.nodes.overlay.hidden === false, "nach dem Vollbild fehlt der Hinweis wieder");

  // Wird das Fenster gross genug, verschwindet der Hinweis von selbst.
  app.resize(1440, 900);
  ok(app.nodes.overlay.hidden === true, "auf grossem Fenster bleibt der Hinweis stehen");
  ok(parseInt(app.nodes.canvas.style.width, 10) > 1000, "nach dem Vergroessern bleibt die Buehne klein");
}

// ═══ 10. Sicherheit und Klickdurchlaessigkeit ══════════════════════════════
console.log("\n10. Sicherheit, Fokus und Klickdurchlaessigkeit");
{
  const app = makeApp();
  const src = app.api.src();
  ok(src.startsWith("https://"), "die Buehne laedt nicht ueber HTTPS");
  ok(!/[?&]pwd=/.test(src), "die iframe-URL uebergibt ein Passwort");
  ok(!/pass|secret|token/i.test(src), "die iframe-URL enthaelt ein Geheimnis");
  ok(src.includes("usr=quantus"), "der Benutzername wird nicht vorbelegt");
  ok(src.includes("embed=1"), "der Einbettungsmodus fehlt");

  app.api.enter();
  await flush();
  app.loadFrame();

  // Nach dem Laden liegt nichts Klickbares mehr ueber dem Stream.
  ok(app.nodes.overlay.hidden === true, "die Statusflaeche bleibt ueber dem Stream");
  eq(app.nodes.overlay.innerHTML, "", "die Statusflaeche behaelt klickbaren Inhalt");
  eq(app.nodes.overlay.dataset.state, "", "die Statusflaeche meldet weiterhin einen Zustand");

  // Fokus kommt beim Zurueckkommen erneut an.
  const before = app.frame().focusCount;
  app.api.leave();
  app.api.enter();
  await flush();
  ok(app.frame().focusCount > before, "beim Zurueckkommen bekommt das iframe keinen Fokus");

  // Und der Merker fuer den Anmeldehinweis landet nicht im iframe-Aufruf.
  app.api.dismissNote();
  ok(!app.api.src().includes("note"), "der Hinweis-Merker landet in der URL");

  // Ein Re-Render darf niemandem mitten im Tippen die Tastatur wegnehmen.
  const typing = { tagName: "INPUT", isContentEditable: false, focus() {} };
  app.doc.activeElement = typing;
  const guarded = app.frame().focusCount;
  app.api.enter();
  await flush();
  eq(app.frame().focusCount, guarded,
    "der Re-Render reisst den Fokus aus dem Eingabefeld");
  // Ausdrueckliche Wuensche — Vollbild — holen den Fokus trotzdem.
  app.api.toggleFullscreen();
  ok(app.frame().focusCount > guarded, "das Vollbild holt den Fokus nicht in den Stream");
  app.api.setFullscreen(false);
  app.doc.activeElement = app.doc.body;
}

// ═══ 11. Ohne ResizeObserver bleibt die Buehne bedienbar ═══════════════════
console.log("\n11. Rueckfall ohne ResizeObserver");
{
  const app = makeApp({ resizeObserver: false, innerWidth: 1440, innerHeight: 900 });
  app.api.enter();
  await flush();
  app.loadFrame();
  app.api.dismissNote();
  app.resize(1280, 720);
  eq(app.nodes.canvas.style.width, "1092px", "ohne ResizeObserver wird nicht neu gerechnet");
  eq(app.nodes.canvas.style.height, "614px", "ohne ResizeObserver stimmt die Hoehe nicht");
}

console.log(`\n✓ Quantus-Browser-Buehne: ${checks} Laufzeitpruefungen bestanden\n`);
