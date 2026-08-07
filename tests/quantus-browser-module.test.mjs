/*
 * Quantus Browser (#/browser) — statische Pruefungen.
 *
 * Drei Regressionen werden hier festgehalten:
 *
 *   1. SECRET IM FRONTEND. `public/index.html` enthielt das neko-User-Passwort
 *      im Klartext und haengte es als `?pwd=` an die iframe-URL. Damit stand es
 *      im ausgelieferten HTML, in der Browser-History und in Server-Logs. Der
 *      Test verbietet sowohl den konkreten alten Wert als auch jede erneute
 *      Passwort-Uebergabe per Querystring.
 *
 *   2. ROHER CSS-TEXT UNTER DEM iframe. Beim Wiederherstellen der
 *      FlowerTech-Quellen (Commit c3d3106) ging der Kopf eines <style>-Blocks
 *      verloren — oeffnendes Tag, <link> und die ersten CSS-Zeilen. Der Rest
 *      des Stylesheets landete als sichtbarer Text im <body> und erschien in
 *      Quantus unterhalb des Browser-iframes. Der Test parst das echte
 *      HTML-Geruest (Script-/Style-Inhalte werden wie im Browser uebersprungen)
 *      und laesst keine langen Textknoten mehr zu.
 *
 *   3. VPS-KONFIGURATION. Compose-Datei, Chromium-Policies und Deploy-Skript
 *      muessen die Zusagen aus docs/quantus-browser-setup.md tatsaechlich
 *      einhalten: gepinnte Version, HTTP nur auf 127.0.0.1, Persistenz,
 *      Healthcheck, keine Secrets im Git.
 *
 * Zusaetzlich wird geprueft, dass andere Quantus-Module unangetastet sind.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const index = read("public/index.html");
const compose = read("neko/docker-compose.yml");
const policies = read("neko/chromium-policies.json");
const envExample = read("neko/.env.example");
const deployScript = read("scripts/deploy-neko-hostinger.sh");
const runbook = read("docs/quantus-browser-setup.md");

// Ausgeliefert wird nicht public/index.html, sondern das Ergebnis beider Edge
// Functions. Genau dieser Stand wird weiter unten geprueft.
const { injectUniversalAssets } = await import("../netlify/edge-functions/quantus-universal-bootstrap.js");
const { injectQuantusApps, readBuildTag } = await import("../netlify/edge-functions/quantus-app-registry.js");
const deliveredHtml = injectQuantusApps(injectUniversalAssets(index));

let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log("  ✓ " + label); };

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n1. Keine Secrets im Repo");

// Das frueher hart codierte neko-Passwort. Es steht weiterhin im Git-Verlauf
// und ist deshalb als kompromittiert zu behandeln — es darf im Arbeitsstand
// nirgends mehr auftauchen.
const LEAKED_PASSWORD = ["gwpZSmYtGb6Y6QG", "NiHzbXwZO1153cu5"].join("/");

const TRACKED_TEXT_FILES = [
  "public/index.html",
  "neko/docker-compose.yml",
  "neko/chromium-policies.json",
  "neko/.env.example",
  "neko/nginx-neko.conf",
  "neko/Caddyfile.snippet",
  "scripts/deploy-neko-hostinger.sh",
  "docs/quantus-browser-setup.md"
];

check("das frueher hart codierte neko-Passwort ist nirgends mehr im Repo", () => {
  for (const rel of TRACKED_TEXT_FILES) {
    assert.ok(!read(rel).includes(LEAKED_PASSWORD), `Passwort steht noch in ${rel}`);
  }
});

check("keine QUANTUS_BROWSER_PW-Konstante mehr im Frontend", () => {
  assert.doesNotMatch(index, /QUANTUS_BROWSER_PW/,
    "Passwort-Konstante im Frontend gefunden");
});

check("die iframe-URL uebergibt kein Passwort per Querystring", () => {
  const src = index.slice(index.indexOf("function quantusBrowserSrc()"),
                          index.indexOf("async function quantusBrowserProbe"));
  assert.ok(src.length > 50, "quantusBrowserSrc() nicht gefunden");
  assert.doesNotMatch(src, /[?&]pwd=/, "pwd= in der Embed-URL gefunden");
  assert.match(src, /usr=/, "Benutzername sollte weiterhin vorbelegt werden");
});

check(".env.example enthaelt keine echten Werte", () => {
  assert.match(envExample, /^NEKO_USER_PASSWORD=\s*$/m,
    "NEKO_USER_PASSWORD muss in der Vorlage leer bleiben");
  assert.match(envExample, /^NEKO_ADMIN_PASSWORD=\s*$/m,
    "NEKO_ADMIN_PASSWORD muss in der Vorlage leer bleiben");
  assert.doesNotMatch(envExample, /CHANGE_ME/,
    "Platzhalter-Passwoerter laden zum versehentlichen Uebernehmen ein");
});

check("neko/.env ist von Git ausgeschlossen", () => {
  assert.match(read(".gitignore"), /^neko\/\.env$/m);
  assert.ok(!fs.existsSync(path.join(root, "neko/.env")),
    "neko/.env darf nicht im Arbeitsverzeichnis liegen");
});

check("Secrets stehen nur in der serverseitigen .env", () => {
  // Im Skript duerfen Passwoerter ausschliesslich erzeugt und in die .env
  // geschrieben werden — nie fest verdrahtet.
  assert.match(deployScript, /openssl rand -base64 24/);
  assert.match(deployScript, /chmod 600 "\$\{APP_DIR\}\/\.env"/);
  assert.doesNotMatch(deployScript, /NEKO_USER_PASSWORD=[A-Za-z0-9+/]{8,}/,
    "hart codiertes Passwort im Deploy-Skript");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n2. Browser-Route, Buehne und Status-UI");

// Die Huelle steht als festes Markup neben <main>; die Logik liegt im grossen
// App-Skript. Beide Bereiche werden getrennt geschnitten, damit ein Treffer
// nicht versehentlich aus einer anderen Stelle der 6-MB-Datei stammt.
const HOST_MARKUP = index.slice(index.indexOf('<section class="qbr-host"'),
                                index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
const BROWSER_JS = index.slice(index.indexOf("// ── QUANTUS BROWSER —"),
                               index.indexOf("\nfunction goBack() {"));

check("Route, App-Eintrag und View sind vorhanden", () => {
  assert.match(index, /case "browser": html = viewBrowser\(\); break;/);
  assert.match(index, /\{key:"browser", icon:"🌐", label:"Browser"/);
  assert.match(index, /function viewBrowser\(\)/);
  assert.ok(HOST_MARKUP.length > 500, "die Browser-Huelle wurde nicht gefunden");
  assert.ok(BROWSER_JS.length > 2000, "der Browser-Programmteil wurde nicht gefunden");
});

check("die Buehne liegt neben #main und ueberlebt jeden Re-Render", () => {
  // Laege sie in #main, wuerde jeder render() das iframe neu bauen — Anmeldung,
  // offene Chromium-Tabs und Scrollposition waeren jedes Mal weg.
  const mainAt = index.indexOf('<main class="main" id="main"></main>');
  const hostAt = index.indexOf('<section class="qbr-host" id="quantusBrowserHost"');
  assert.ok(mainAt > 0 && hostAt > mainAt, "#quantusBrowserHost steht nicht neben <main>");
  assert.ok(hostAt - mainAt < 400, "#quantusBrowserHost gehoert direkt neben <main>");
  // viewBrowser() darf keinerlei Buehne mehr erzeugen, sondern nur einblenden.
  const view = BROWSER_JS.slice(BROWSER_JS.indexOf("function viewBrowser()"));
  assert.doesNotMatch(view, /<iframe|qbr-stage|<style/,
    "viewBrowser() baut wieder eigenes Buehnen-Markup — damit geht der Zustand verloren");
  assert.match(view, /quantusBrowserEnter/, "viewBrowser() blendet die Buehne nicht ein");
  // Beim Wechsel auf eine andere Route muss sie aktiv verschwinden.
  assert.match(index, /if \(route !== "browser"\) \{ quantusBrowserLeave\(\); \}/);
  assert.match(HOST_MARKUP, /<section class="qbr-host" id="quantusBrowserHost" hidden/,
    "die Buehne ist nicht standardmaessig ausgeblendet");
});

check("das iframe wird mit den noetigen Berechtigungen erzeugt", () => {
  assert.match(BROWSER_JS, /frame\.id = "quantusBrowserFrame"/);
  for (const perm of ["autoplay", "fullscreen", "clipboard-read", "clipboard-write"]) {
    assert.ok(BROWSER_JS.includes(perm), `allow="${perm}" fehlt`);
  }
  assert.match(BROWSER_JS, /frame\.setAttribute\("allowfullscreen", ""\)/);
});

check("Status-/Retry-UI statt roher Fehlerseite", () => {
  assert.match(BROWSER_JS, /function quantusBrowserStatusHtml\(/);
  assert.match(BROWSER_JS, /Quantus Browser ist gerade nicht erreichbar/);
  assert.match(BROWSER_JS, /data-action="browser-retry"/);
  assert.match(BROWSER_JS, /data-action="browser-open-tab"/);
  // Erreichbarkeit wird vor dem Einhaengen geprueft (no-cors-Probe).
  assert.match(BROWSER_JS, /mode: "no-cors"/);
  // Watchdog, falls die Verbindung steht, der Stream aber nicht laedt.
  assert.match(BROWSER_JS, /QUANTUS_BROWSER_LOAD_MS/);
  // Automatischer Wiederholungsversuch.
  assert.match(BROWSER_JS, /QUANTUS_BROWSER_RETRY_MS/);
  // Alle vier Zustaende, die der Nutzer sehen kann.
  for (const state of ["checking", "tiny", "idle", "offline"]) {
    assert.ok(BROWSER_JS.includes(`"${state}"`), `Zustand ${state} fehlt in der Status-UI`);
  }
  // Der Verbindungsstatus steht sichtbar in der Kopfzeile.
  assert.match(HOST_MARKUP, /id="quantusBrowserStatus"/);
  for (const label of ["Verbunden", "Verbinde…", "Nicht erreichbar"]) {
    assert.ok(BROWSER_JS.includes(label), `Statustext fehlt: ${label}`);
  }
});

check("alle data-action-Werte der Browser-UI haben einen Handler", () => {
  const used = new Set();
  for (const m of HOST_MARKUP.matchAll(/data-action="(browser-[a-z-]+)"/g)) used.add(m[1]);
  for (const m of BROWSER_JS.matchAll(/data-action="(browser-[a-z-]+)"/g)) used.add(m[1]);
  assert.ok(used.size >= 6, `zu wenige Browser-Aktionen gefunden: ${[...used]}`);
  for (const action of used) {
    assert.ok(index.includes(`case "${action}":`), `kein Handler fuer ${action}`);
  }
});

check("die Kopfzeile baut keine zweite Browseroberflaeche nach", () => {
  // Chromium zeigt Tab-, Adress- und Erweiterungsleiste selbst. Eine
  // nachgebaute Quantus-Variante darueber waere doppelt und irrefuehrend.
  assert.doesNotMatch(HOST_MARKUP, /type="url"|placeholder="[^"]*(Adresse|URL|Suche)/i,
    "nachgebaute Adressleiste ueber dem echten Chromium");
  assert.doesNotMatch(HOST_MARKUP, /qbr-tabbar|qbr-tabs|class="qbr-tab"/,
    "nachgebaute Tableiste ueber dem echten Chromium");
  // Genau eine Toolbar in der Huelle.
  assert.equal((HOST_MARKUP.match(/<header class="qbr-bar"/g) || []).length, 1,
    "mehr als eine Toolbar in der Browser-Huelle");
});

check("„Neuer Tab“ bleibt Rueckfallebene, nicht der Hauptweg", () => {
  const newTab = HOST_MARKUP.match(/<button[^>]*data-action="browser-open-tab"[^>]*>/);
  assert.ok(newTab, "Button fuer den neuen Tab nicht gefunden");
  assert.match(newTab[0], /qbr-btn-quiet/,
    "„Neuer Tab“ ist als Hauptaktion gestaltet — er darf nur dezente Rueckfallebene sein");
  // Der hervorgehobene Knopf ist das In-App-Vollbild.
  const full = HOST_MARKUP.match(/<button[^>]*id="quantusBrowserFullBtn"[^>]*>/);
  assert.ok(full && /qbr-btn-main/.test(full[0]), "Vollbild ist nicht die hervorgehobene Aktion");
  // Auch in der Offline-Karte ist „Erneut versuchen“ primaer.
  const offline = BROWSER_JS.slice(BROWSER_JS.indexOf("Quantus Browser ist gerade nicht erreichbar"));
  const retryBtn = offline.match(/<button class="btn sm ([a-z]+)" data-action="browser-retry"/);
  assert.ok(retryBtn && retryBtn[1] === "primary", "„Erneut versuchen“ ist nicht die Hauptaktion");
  assert.match(offline, /<button class="btn sm ghost" data-action="browser-open-tab"/);
});

check("Browser-first-Layout: die Buehne bekommt die ganze Zelle", () => {
  const css = index.slice(index.indexOf('<style id="quantusBrowserCss">'),
                          index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
  // #main wird im Browsermodus abgeschaltet — keine zweite Toolbar, keine
  // doppelten Innenabstaende, kein Scrollcontainer um die Buehne.
  assert.match(css, /body\.qbr-mode #main\{display:none\}/);
  assert.match(css, /\.qbr-host\{grid-column:2;grid-row:2;display:flex;flex-direction:column/);
  assert.match(css, /\.qbr-stage\{[^}]*flex:1 1 auto/, "die Buehne waechst nicht mit");
  assert.match(css, /\.qbr-stage\{[^}]*min-height:0/, "ohne min-height:0 laeuft die Buehne ueber");
  // Kein Innenabstand rund um den Stream.
  assert.doesNotMatch(css, /\.qbr-stage\{[^}]*padding:[1-9]/, "unnoetiger Innenabstand an der Buehne");
  // 1280x720 bleibt unverzerrt: exaktes Seitenverhaeltnis als CSS-Rueckfall.
  assert.match(css, /\.qbr-canvas\{[^}]*aspect-ratio:16 \/ 9/);
  assert.match(BROWSER_JS, /const QUANTUS_BROWSER_REMOTE_W = 1280/);
  assert.match(BROWSER_JS, /const QUANTUS_BROWSER_REMOTE_H = 720/);
  assert.match(BROWSER_JS, /function quantusBrowserFitBox\(/, "keine Groessenberechnung");
});

check("Vollbild laeuft in der App und hat einen CSS-Rueckfall", () => {
  const css = index.slice(index.indexOf('<style id="quantusBrowserCss">'),
                          index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
  // Der CSS-Weg wird IMMER gesetzt — er wirkt auch, wenn die Fullscreen-API
  // fehlt oder im eingebetteten Kontext abgelehnt wird.
  assert.match(css, /body\.qbr-full #quantusBrowserHost\{position:fixed;inset:0/);
  assert.match(css, /body\.qbr-full #quantusBrowserHost\{[^}]*100dvh/,
    "dvh-Hoehe fehlt (Mobile-Adressleiste)");
  assert.match(css, /\.qbr-stage:fullscreen/, "kein Vollbild-Styling fuer die native API");
  const toggle = BROWSER_JS.slice(BROWSER_JS.indexOf("function quantusBrowserToggleFullscreen"));
  assert.ok(toggle.indexOf("quantusBrowserSetFullscreen(true)") <
            toggle.indexOf("host.requestFullscreen"),
    "der CSS-Modus muss vor der nativen API gesetzt werden, sonst bleibt der Fallback aus");
  // Rueckweg: Escape und der Schliessen-Knopf.
  assert.match(BROWSER_JS, /e\.key !== "Escape"/);
  assert.match(BROWSER_JS, /addEventListener\("fullscreenchange"/);
  assert.match(HOST_MARKUP, /data-action="browser-exit-fullscreen"/);
  // Der Wechsel darf das iframe nicht anfassen.
  assert.doesNotMatch(toggle.slice(0, toggle.indexOf("\n}\n")), /createElement|\.src =/,
    "der Vollbildwechsel baut den Stream neu auf — der Zustand ginge verloren");
});

check("Seitenbereiche draengen die Buehne nicht zusammen", () => {
  const css = index.slice(index.indexOf('<style id="quantusBrowserCss">'),
                          index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
  // Navigation bleibt erreichbar, faehrt aber schmaler; der bestehende
  // Einklapp-Schalter gilt weiter.
  assert.match(css, /body\.qbr-mode #app\{grid-template-columns:var\(--qbr-nav,188px\)/);
  assert.match(css, /body\.qbr-mode #app\.sidebar-collapsed\{grid-template-columns:0 /);
  // Split-Screen-Panels werden zur Schublade statt zur dritten Spalte.
  assert.match(css, /body\.qbr-mode\.has-app-panels #app\{grid-template-columns:var\(--qbr-nav,188px\)/);
  assert.match(css, /body\.qbr-mode #panelDock\{position:fixed/);
  // Das Details-Panel startet im Browsermodus immer geschlossen.
  const enter = BROWSER_JS.slice(BROWSER_JS.indexOf("function quantusBrowserEnter"));
  assert.match(enter.slice(0, enter.indexOf("\n}\n")), /closeSlidePanel\(\)/);
});

check("nichts schluckt Klicks ueber der Buehne, der Fokus kommt an", () => {
  const css = index.slice(index.indexOf('<style id="quantusBrowserCss">'),
                          index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
  // Die Statusflaeche wird per display:none weggeschaltet, nicht nur
  // transparent — eine unsichtbare klickbare Schicht waere fatal.
  assert.match(css, /\.qbr-overlay\[hidden\]\{display:none\}/);
  assert.doesNotMatch(css, /\.qbr-overlay\[hidden\]\{opacity:0\}/);
  assert.match(css, /\.qbr-stage > \*:not\(\.qbr-canvas\):not\(\.qbr-overlay\)\{pointer-events:none\}/);
  assert.match(BROWSER_JS, /ov\.hidden = true/);
  // Ohne Fokus kaeme keine Tastatureingabe im Remote-Chromium an.
  assert.match(BROWSER_JS, /function quantusBrowserFocusFrame\(/);
  assert.match(BROWSER_JS, /frame\.focus\(\{ preventScroll: true \}\)/);
  // ... aber nie auf Kosten eines Eingabefelds: ein Re-Render darf dem Nutzer
  // nicht mitten im Tippen die Tastatur wegnehmen.
  const focusFn = BROWSER_JS.slice(BROWSER_JS.indexOf("function quantusBrowserFocusFrame("));
  assert.match(focusFn.slice(0, focusFn.indexOf("\n}\n")), /tag === "INPUT"[\s\S]{0,200}isContentEditable/);
});

check("Layout ist responsiv und der Kleinfenster-Fall ist abgefangen", () => {
  const css = index.slice(index.indexOf('<style id="quantusBrowserCss">'),
                          index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
  assert.match(css, /@media \(max-width:1100px\)/, "kein Breakpoint fuer schmale Laptops");
  assert.match(css, /@media \(max-width:900px\)/, "kein Breakpoint fuer den Tablet-Umbruch");
  assert.match(css, /@media \(max-width:820px\)/, "kein Breakpoint fuer Tablet/Handy");
  // Die Spaltenregeln duerfen den mobilen Einspalter (<=900px) nicht kippen.
  assert.match(css, /@media \(min-width:901px\)\{[\s\S]*?body\.qbr-mode #app\{/,
    "die Browser-Spaltenregel greift auch unterhalb von 900px");
  // Unterhalb von 900px zieht die Kopfleiste die App-Spalte auf ihre
  // Mindestbreite — die ist breiter als der Viewport. Die Buehne misst sich
  // dort deshalb am Viewport statt am Grid, sonst laeuft sie seitlich weg.
  assert.match(css, /@media \(max-width:900px\)\{\s*\.qbr-host\{position:fixed;left:0;right:0;top:52px;bottom:0/);
  assert.match(css, /body\.tabs-on \.qbr-host\{top:90px\}/,
    "mit Tab-Leiste startet die Buehne nicht unterhalb der Kopfzeile");
  // Statt einer unbedienbaren Briefmarke: Hinweis mit Vollbild-Aufruf.
  assert.match(BROWSER_JS, /function quantusBrowserViewportClass\(/);
  assert.match(BROWSER_JS, /Zu wenig Platz fuer den Browser/);
  const tiny = BROWSER_JS.slice(BROWSER_JS.indexOf("Zu wenig Platz fuer den Browser"));
  assert.match(tiny.slice(0, 600), /data-action="browser-fullscreen"/);
});

check("Farben kommen aus den Theme-Variablen (Dark und Light)", () => {
  const css = index.slice(index.indexOf('<style id="quantusBrowserCss">'),
                          index.indexOf("</style>", index.indexOf('<style id="quantusBrowserCss">')));
  for (const token of ["var(--bg)", "var(--panel)", "var(--panel2)", "var(--text)", "var(--muted)", "var(--border)"]) {
    assert.ok(css.includes(token), `Theme-Variable fehlt: ${token}`);
  }
  // Erlaubt sind nur die neko-eigene Buehnenfarbe und weiche Schatten —
  // sonst keine fest verdrahteten Flaechenfarben, die im hellen Theme brechen.
  const hardcoded = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0])
    .filter(v => !["#2B3134", "#333", "#4ade80", "#ef4444", "#f59e0b", "#86a895"].includes(v));
  assert.deepEqual(hardcoded, [], "fest verdrahtete Farben im Browser-CSS");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n3. Keine rohe CSS-Text-Ausgabe im HTML");

/**
 * Minimaler HTML-Scanner mit derselben Regel wie ein Browser: der Inhalt von
 * script/style/textarea/title ist kein Markup, wird also uebersprungen. Alles
 * Uebrige zwischen Tags ist sichtbarer Text.
 */
function textNodes(html) {
  const lower = html.toLowerCase();
  const RAW = new Set(["script", "style", "textarea", "title"]);
  const nodes = [];
  let i = 0, buf = "", bufStart = 0;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) nodes.push({ line: html.slice(0, bufStart).split("\n").length, text: trimmed });
    buf = "";
  };

  while (i < html.length) {
    const lt = lower.indexOf("<", i);
    if (lt < 0) { if (!buf) bufStart = i; buf += html.slice(i); flush(); break; }
    if (!buf) bufStart = i;
    buf += html.slice(i, lt);

    const m = /^<\/?([a-z0-9]+)/.exec(lower.slice(lt, lt + 20));
    if (!m) { buf += "<"; i = lt + 1; continue; }
    flush();

    const gt = lower.indexOf(">", lt);
    if (gt < 0) break;
    const isClose = lower.slice(lt, lt + 2) === "</";
    if (!isClose && RAW.has(m[1])) {
      const close = lower.indexOf("</" + m[1], gt);
      if (close < 0) throw new Error(`unabgeschlossenes <${m[1]}> ab Zeile ${html.slice(0, lt).split("\n").length}`);
      i = lower.indexOf(">", close) + 1;
    } else {
      i = gt + 1;
    }
  }
  return nodes;
}

// Sieht der Text nach CSS/JS aus, statt nach Prosa oder HTML-Kommentar?
const looksLikeCode = (t) =>
  !t.startsWith("<!--") &&
  (/[.#][a-zA-Z][\w-]*\s*\{/.test(t) ||   // Selektor + {
   /^--[\w-]+\s*:/m.test(t) ||            // CSS-Custom-Property am Zeilenanfang
   /@(keyframes|media|font-face)\b/.test(t) ||
   /^\s*[\w-]+\s*:\s*[^;\n]+;\s*$/m.test(t));

check("public/index.html hat kein unabgeschlossenes script/style", () => {
  textNodes(index); // wirft bei unbalancierten Raw-Text-Elementen
});

check("kein CSS-/JS-Rohtext im sichtbaren HTML", () => {
  const leaks = textNodes(index).filter(n => n.text.length > 60 && looksLikeCode(n.text));
  assert.deepEqual(
    leaks.map(n => `Zeile ${n.line}: ${n.text.slice(0, 80)}`),
    [],
    "sichtbarer Code-Text im HTML gefunden"
  );
});

check("der Newsroom-Hub-Style-Block ist vollstaendig", () => {
  // Genau die Zeilen, die bei c3d3106 verloren gingen.
  assert.match(index, /<!-- ===== NEWSROOM HUB OVERLAY ===== -->/);
  assert.match(index, /\.nh\{position:fixed;inset:0;z-index:999999/);
  assert.match(index, /--purple:var\(--accent\);--purple-l:var\(--accent-soft\);--purple-b:var\(--accent-soft\);/);
  assert.doesNotMatch(index, /^rple-b:/m, "abgeschnittene CSS-Zeile wieder aufgetaucht");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4. neko-Compose-Konfiguration");

check("Image-Version ist gepinnt, kein :latest", () => {
  assert.doesNotMatch(compose, /image:.*:latest/, ":latest im Compose gefunden");
  assert.match(compose, /image: ghcr\.io\/m1k1o\/neko\/chromium:\$\{NEKO_IMAGE_TAG:-\d+\.\d+\.\d+\}/);
  assert.match(envExample, /^NEKO_IMAGE_TAG=\d+\.\d+\.\d+$/m, "keine Default-Version in der .env-Vorlage");
});

check("HTTP-Port ist nur an 127.0.0.1 gebunden", () => {
  assert.match(compose, /"127\.0\.0\.1:\$\{NEKO_HTTP_PORT:-8080\}:8080"/);
  const ports = compose.slice(compose.indexOf("ports:"), compose.indexOf("environment:"));
  for (const line of ports.split("\n")) {
    const mapping = /^\s*- "([^"]+)"/.exec(line);
    if (!mapping) continue;
    const parts = mapping[1].split(":");
    // Entweder explizit an 127.0.0.1 gebunden oder ein WebRTC-Port.
    if (parts[0] === "127.0.0.1") continue;
    assert.match(mapping[1], /NEKO_WEBRTC_PORT/,
      `Port ${mapping[1]} ist ohne Not von aussen erreichbar`);
  }
});

check("nur ein Dienst — keine unnoetigen Nebencontainer", () => {
  const services = [...compose.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(m => m[1]);
  assert.deepEqual(services, ["neko"]);
});

check("Restart-Policy, Healthcheck, shm_size und Limits sind gesetzt", () => {
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /shm_size: "2gb"/);
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /start_period: 60s/);
  assert.match(compose, /mem_limit: \$\{NEKO_MEM_LIMIT:-\d+m\}/);
  // pids_limit zaehlt Threads mit; Chromium braucht mehrere hundert. Bei 512
  // schlug clone() fehl und Chromium stuerzte live mit SIGTRAP ab.
  const pids = Number((/pids_limit: (\d+)/.exec(compose) || [])[1]);
  assert.ok(Number.isFinite(pids), "pids_limit fehlt");
  assert.ok(pids >= 1024, `pids_limit ${pids} ist zu knapp fuer Chromium-Threads (SIGTRAP-Gefahr)`);
  assert.match(compose, /max-size: "10m"/, "unbegrenzte Logs fuellen die Platte");
});

check("Persistenz ist vollstaendig gemountet", () => {
  for (const target of [
    "/home/neko/.config/chromium",   // Profil, Cookies, Lesezeichen, Tabs
    "/home/neko/Downloads",          // Downloads
    "/home/neko/.neko"               // neko-Sitzungen
  ]) {
    assert.ok(compose.includes(target), `Volume fuer ${target} fehlt`);
  }
  assert.match(compose, /chromium-policies\.json:\/etc\/chromium\/policies\/managed\/policies\.json:ro/);
});

check("WebRTC nutzt einen gemultiplexten Port statt eines Portbereichs", () => {
  assert.match(compose, /NEKO_WEBRTC_UDPMUX/);
  assert.match(compose, /NEKO_WEBRTC_TCPMUX/);
  assert.doesNotMatch(compose, /NEKO_WEBRTC_EPR/, "Portbereich kostet auf KVM 1 ~100 docker-proxy-Prozesse");
  assert.match(compose, /NEKO_WEBRTC_NAT1TO1: "\$\{NEKO_PUBLIC_IP\}"/);
});

check("Cookie-Auth ist AUS — der Legacy-Client des 3.1.5-Images kann sie nicht", () => {
  // Live-Befund: Der im Image ausgelieferte v2-Client spricht die Legacy-API.
  // Deren Login liest den Token aus dem Antwort-Body; mit Cookie-Auth laesst
  // neko ihn weg und JEDER Login scheitert mit "token not found - make sure
  // you are not using Cookie auth on the server"
  // (server/internal/http/legacy/session.go: "if Cookie auth, the token will
  // be empty"). Cookie-Auth darf hier also nie wieder aktiviert werden,
  // solange das Image den Legacy-Client ausliefert.
  assert.match(compose, /NEKO_SESSION_COOKIE_ENABLED: "false"/);
  assert.doesNotMatch(compose, /NEKO_SESSION_COOKIE_ENABLED: "true"/,
    "Cookie-Auth bricht den Login des Legacy-Clients (iframe UND neuer Tab)");
  assert.match(compose, /NEKO_SESSION_FILE: "\/home\/neko\/\.neko\/sessions\.json"/);
  assert.match(compose, /NEKO_SERVER_PROXY: "true"/);
  // Die Legacy-Bruecke ist die Voraussetzung dafuer, dass der mitgelieferte
  // Client ueberhaupt eine Anmeldung durchbekommt. Sie haengt sonst am
  // Image-Default — faellt der einmal, waere der Login wieder tot.
  assert.match(compose, /NEKO_LEGACY: "true"/,
    "der Client des Images spricht nur die v2-Endpunkte (/ws, /file)");
});

check("Passwoerter kommen aus der .env und fehlen nicht stillschweigend", () => {
  assert.match(compose, /NEKO_MEMBER_MULTIUSER_USER_PASSWORD: "\$\{NEKO_USER_PASSWORD:\?/);
  assert.match(compose, /NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: "\$\{NEKO_ADMIN_PASSWORD:\?/);
});

// Platzhalterwerte nur fuer die Validierung; sie landen nirgends auf Platte.
const COMPOSE_ENV = {
  NEKO_USER_PASSWORD: "validation-placeholder",
  NEKO_ADMIN_PASSWORD: "validation-placeholder",
  NEKO_PUBLIC_IP: "203.0.113.10"
};

function composeConfig(files) {
  const args = [];
  for (const f of files) args.push("-f", f);
  return spawnSync("docker", ["compose", ...args, "config"], {
    cwd: root, encoding: "utf8", env: { ...process.env, ...COMPOSE_ENV }
  });
}

const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

check("docker compose config validiert die Basisdatei", () => {
  if (!dockerAvailable) { console.log("    (uebersprungen — docker compose fehlt hier)"); return; }
  const res = composeConfig(["neko/docker-compose.yml"]);
  assert.equal(res.status, 0, `docker compose config schlug fehl:\n${res.stderr}`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4b. Traefik-Overlay fuer den bestehenden n8n-Stack");

const traefikCompose = read("neko/docker-compose.traefik.yml");

check("Overlay bindet nur ein VORHANDENES externes Netz ein", () => {
  assert.match(traefikCompose, /external: true/);
  assert.match(traefikCompose, /name: "\$\{NEKO_TRAEFIK_NETWORK:-n8n_default\}"/);
  // Ein eigenes Netz waere fatal: Traefik haengt dort nicht dran.
  assert.doesNotMatch(traefikCompose, /driver:\s*bridge/);
});

check("Overlay fasst n8n/Traefik nicht an", () => {
  // Kommentare duerfen den fremden Stack erwaehnen — Konfiguration nicht.
  const effective = traefikCompose
    .split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  for (const forbidden of [/\/docker\/n8n/, /image:\s*\S*traefik/, /volumes:/, /docker\.sock/]) {
    assert.doesNotMatch(effective, forbidden,
      `Overlay greift auf den fremden Stack zu: ${forbidden}`);
  }
  // Nur der services:-Block zaehlt — networks: hat eigene Zwei-Leerzeichen-Keys.
  const servicesBlock = traefikCompose.slice(
    traefikCompose.indexOf("services:"),
    traefikCompose.indexOf("\nnetworks:")
  );
  const services = [...servicesBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(m => m[1]);
  assert.deepEqual(services, ["neko"], "Overlay definiert fremde Dienste");
});

check("Traefik-Labels sind vollstaendig und korrekt", () => {
  if (!dockerAvailable) { console.log("    (uebersprungen — docker compose fehlt hier)"); return; }
  const res = composeConfig(["neko/docker-compose.yml", "neko/docker-compose.traefik.yml"]);
  assert.equal(res.status, 0, `Overlay-Validierung schlug fehl:\n${res.stderr}`);
  const cfg = res.stdout;

  for (const [needle, why] of [
    ['traefik.enable: "true"', "exposedByDefault=false verlangt das ausdrueckliche Opt-in"],
    ["traefik.docker.network: n8n_default", "ohne Netz-Label waehlt Traefik u. U. das falsche Netz"],
    ["traefik.http.routers.quantus-neko.entrypoints: websecure", "HTTPS-EntryPoint"],
    ["traefik.http.routers.quantus-neko.tls: \"true\"", "TLS aktiv"],
    ["traefik.http.routers.quantus-neko.tls.certresolver: mytlschallenge", "ACME-Resolver des Bestands"],
    ['traefik.http.services.quantus-neko.loadbalancer.server.port: "8080"', "Container-interner Port"],
    ["traefik.http.routers.quantus-neko-web.entrypoints: web", "HTTP-EntryPoint"],
    ["traefik.http.middlewares.quantus-neko-https.redirectscheme.scheme: https", "HTTP->HTTPS auch ohne globalen Redirect"]
  ]) {
    assert.ok(cfg.includes(needle), `Label fehlt (${why}): ${needle}`);
  }

  assert.match(cfg, /Host\(`neko\.laurin-rusterholz\.ch`\)/, "Router-Regel fehlt");
  // Der Dienst haengt genau an dem externen Netz — sonst ist die Route tot.
  assert.match(cfg, /networks:\n {6}proxy: null/, "neko haengt nicht am Traefik-Netz");
  assert.match(cfg, /name: n8n_default\n {4}external: true/, "Netz ist nicht als extern deklariert");
  // Compose-Projektname darf nicht mit dem n8n-Projekt kollidieren.
  assert.doesNotMatch(cfg, /^name: n8n$/m);
});

check("WebRTC laeuft an Traefik vorbei direkt am Host", () => {
  // Traefik kann kein UDP fuer diesen Stack routen — der Medienport muss
  // deshalb weiterhin direkt veroeffentlicht sein.
  assert.match(compose, /\$\{NEKO_WEBRTC_PORT:-59000\}\/udp/);
  const effective = traefikCompose.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(effective, /udp/i, "UDP gehoert nicht in die Traefik-Labels");
  assert.doesNotMatch(effective, /^\s*ports:/m, "Ports gehoeren in die Basisdatei, nicht ins Overlay");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n5. Chromium-Policies");

check("policies.json ist gueltiges JSON", () => { JSON.parse(policies); });

check("Downloads, Uploads, Lesezeichen und Persistenz sind freigeschaltet", () => {
  const p = JSON.parse(policies);
  assert.equal(p.DownloadRestrictions, 0, "Downloads waeren blockiert");
  assert.equal(p.AllowFileSelectionDialogs, true, "Datei-Upload waere blockiert");
  assert.equal(p.EditBookmarksEnabled, true);
  assert.equal(p.BookmarkBarEnabled, true);
  assert.equal(p.DefaultCookiesSetting, 1, "Logins wuerden nicht ueberleben");
  assert.equal(p.RestoreOnStartup, 1, "Tabs/Tab-Gruppen wuerden nicht wiederhergestellt");
  assert.equal(p.FullscreenAllowed, true);
  assert.equal(p.AutoplayAllowed, true);
});

check("keine proprietaeren Google-Dienste vorgetaeuscht", () => {
  const p = JSON.parse(policies);
  assert.equal(p.SyncDisabled, true, "Chrome-Sync gibt es hier nicht");
  assert.equal(p.BrowserSignin, 0, "Google-Konto-Anmeldung bleibt aus");
});

check("sicherheitsrelevante Voreinstellungen bleiben restriktiv", () => {
  const p = JSON.parse(policies);
  assert.equal(p.PasswordManagerEnabled, false, "Passwoerter gehoeren nicht ins VPS-Profil");
  assert.equal(p.AutofillCreditCardEnabled, false);
  assert.deepEqual(p.ExtensionInstallBlocklist, ["*"]);
  assert.ok(p.URLBlocklist.includes("file://*"), "file://-Zugriff muss gesperrt bleiben");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n6. Deploy-Skript");

check("Skript ist ausfuehrbar und bricht bei Fehlern ab", () => {
  assert.match(deployScript, /^#!\/usr\/bin\/env bash$/m);
  assert.match(deployScript, /^set -euo pipefail$/m);
  const mode = fs.statSync(path.join(root, "scripts/deploy-neko-hostinger.sh")).mode;
  assert.ok(mode & 0o111, "Skript ist nicht ausfuehrbar");
});

check("Vorabpruefungen, Backup, Smoke-Tests und Rollback sind enthalten", () => {
  for (const needle of [
    "--check", "--update", "--smoke",          // Betriebsarten
    "getent hosts",                             // DNS-Vorabpruefung
    "docker compose version",                   // Compose-Vorabpruefung
    "backups",                                  // Backup-Verzeichnis
    "nginx -t", "caddy validate",               // Konfiguration wird validiert
    "docker compose up -d",
    "Rollback"
  ]) {
    assert.ok(deployScript.includes(needle), `"${needle}" fehlt im Deploy-Skript`);
  }
});

check("Smoke-Test gibt die Chromium-Version aus dem Container aus", () => {
  assert.match(deployScript, /docker compose exec -T neko \/usr\/bin\/chromium --version/);
});

check("Deploy-Skript setzt Eigentuemer/Rechte der Daten-Mounts idempotent", () => {
  // Live-Befund: root:root-Verzeichnisse -> "permission denied" fuer
  // sessions.json und Downloads, Chromium-SIGTRAP-Loop (Profil unbeschreibbar).
  assert.match(deployScript, /ensure_data_dir\(\)/, "Ownership-Funktion fehlt");
  assert.match(deployScript, /chown -R "\$\{uid\}:\$\{gid\}"/, "chown auf den Container-User fehlt");
  assert.match(deployScript, /chmod u\+rwX/, "Verzeichnis muss fuer den Eigentuemer nutzbar sein");
  // chown nur bei Abweichung — sonst wird jeder Lauf mit grossem Profil teuer.
  assert.match(deployScript, /find "\$\{dir\}" \\\( ! -uid "\$\{uid\}" -o ! -gid "\$\{gid\}" \\\)/);
  // Nie destruktiv: die Reparatur darf unter keinen Umstaenden loeschen.
  const fn = deployScript.slice(deployScript.indexOf("ensure_data_dir()"),
                                deployScript.indexOf("PROXY=\"none\""));
  assert.ok(fn.length > 100, "ensure_data_dir nicht gefunden");
  assert.doesNotMatch(fn, /\brm\b|\bmv\b/, "Ownership-Reparatur darf nichts loeschen/verschieben");
});

check("Smoke prueft die Persistenz per Schreibprobe aus Container-Sicht", () => {
  assert.match(deployScript, /\.quantus-rw-probe/);
  assert.match(deployScript, /--user "\$\{DATA_UID\}:\$\{DATA_GID\}"/,
    "die Schreibprobe muss als Container-User laufen, nicht als root");
});

check("Smoke erkennt einen Chromium-Crash-Loop (zwei PID-Stichproben)", () => {
  // Ein blosser Versions-Check uebersieht einen Crash-Loop — live crashte
  // Chromium mit SIGTRAP, waehrend der Container "healthy" blieb.
  assert.match(deployScript, /chromium_pid\(\)/);
  assert.match(deployScript, /Crash-Loop/);
  assert.match(deployScript, /\/var\/log\/neko\/chromium\.log/,
    "im Fehlerfall muss das Chromium-Log gezeigt werden");
});

// Die Compose-Datei zu reparieren beweist nicht, dass der LAUFENDE Container
// die Reparatur uebernommen hat. Der Smoke meldet sich deshalb echt an.
check("Smoke spielt die Anmeldung wirklich durch", () => {
  assert.match(deployScript, /neko_login_probe\(\)/, "Anmelde-Probe fehlt");
  assert.match(deployScript, /api\/login/);
  // Sitzung wieder aufraeumen statt sie offen liegen zu lassen.
  assert.match(deployScript, /neko_logout\(\)/);
  assert.match(deployScript, /api\/logout/);
  // Die Diagnose muss den Live-Fehler beim Namen nennen.
  assert.match(deployScript, /Cookie-Auth im laufenden Container aktiv/);
  assert.match(deployScript, /NEKO_SESSION_COOKIE_ENABLED muss/);
});

check("die Anmelde-Probe gibt weder Passwort noch Token preis", () => {
  const probe = deployScript.slice(
    deployScript.indexOf("neko_login_probe() {"),
    deployScript.indexOf("# Tests laden nur die Funktionen")
  );
  assert.ok(probe.length > 200, "neko_login_probe nicht gefunden");
  // Beides gehoert nicht in die Prozessliste: Passwort ueber stdin,
  // Token ueber eine curl-Konfigurationsdatei.
  assert.match(probe, /--data-binary @-/, "das Passwort muss ueber stdin gehen");
  assert.doesNotMatch(probe, /--data(-binary)? ['"]?\{/, "Passwort stuende in der Prozessliste");
  assert.match(deployScript, /printf 'header = "Authorization: Bearer/);
  assert.doesNotMatch(deployScript, /-H "Authorization: Bearer/);
  assert.doesNotMatch(deployScript, /set -x/);

  // Genau eine erlaubte Passwortausgabe: die angekuendigte Einmalausgabe der
  // frisch erzeugten Zugangsdaten beim allerersten Lauf.
  const start = deployScript.indexOf('warn "EINMALIGE AUSGABE');
  assert.ok(start > 0, "die angekuendigte Einmalausgabe fehlt");
  const end = deployScript.indexOf("\nfi\n", start);
  const rest = deployScript.slice(0, start) + deployScript.slice(end);
  for (const line of rest.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (!/NEKO_PW\b|NEKO_USER_PASSWORD/.test(line)) continue;
    assert.doesNotMatch(line, /^\s*(echo|printf)\s/,
      `Passwort landet in der Ausgabe: ${line.trim()}`);
  }
});

check("Smoke prueft auch den Legacy-Pfad /ws, den der Client wirklich nutzt", () => {
  // Der v2-Client verbindet sich nicht mit /api/ws, sondern mit /ws.
  assert.match(deployScript, /"https:\/\/\$\{DOMAIN\}\/ws"/);
  assert.match(deployScript, /Legacy-WebSocket \/ws/);
});

// Der Bind-Mount auf ./data/profile verdeckt die Voreinstellungen aus dem
// Image (Home-Knopf, Lesezeichenleiste). Docker kopiert Image-Inhalte nur in
// LEERE benannte Volumes, nicht in Bind-Mounts — sie fehlen also.
check("Chromium-Voreinstellungen werden ins leere Profil nachgezogen", () => {
  assert.match(deployScript, /seed_chromium_preferences\(\)/);
  assert.match(deployScript, /Default\/Preferences/);
  const fn = deployScript.slice(
    deployScript.indexOf("seed_chromium_preferences() {"),
    deployScript.indexOf("json_str()")
  );
  assert.ok(fn.length > 200, "seed_chromium_preferences nicht gefunden");
  // Nur ins leere Profil — ein bestehendes darf nie ueberschrieben werden.
  assert.match(fn, /\[ -e "\$\{target\}" \] && return 1/);
});

check("HTTPS-Smoke prueft per GET, nicht per HEAD", () => {
  // neko beantwortet HEAD live mit 405 — curl -fsSI meldete einen Fehler,
  // wo keiner war. Der Smoke muss das tun, was der Browser tut: GET.
  assert.doesNotMatch(deployScript, /curl -fsSI/, "HEAD-Smoke ist falsch negativ (neko: 405)");
  assert.match(deployScript, /curl -sS -o \/dev\/null -w '%\{http_code\}' -m 20 "https:\/\/\$\{DOMAIN\}\/"/);
});

check("kein Chromium wird auf dem Host installiert", () => {
  assert.doesNotMatch(deployScript, /apt-get install[^\n]*chromium/,
    "Chromium darf nicht per apt auf den Host");
  assert.match(deployScript, /Chromium steckt im Container-Image/);
});

check("Traefik im Docker wird unterstuetzt statt abgelehnt", () => {
  // Vorher endete dieser Fall mit "Route bitte selbst eintragen". Jetzt muss
  // das Skript das Overlay aktivieren und das Netz pruefen.
  assert.match(deployScript, /COMPOSE_FILE\s+"docker-compose\.yml:docker-compose\.traefik\.yml"/);
  assert.match(deployScript, /docker network inspect "\$\{TRAEFIK_NETWORK\}"/);
  assert.match(deployScript, /NEKO_TRAEFIK_CERTRESOLVER/);
  assert.match(deployScript, /NEKO_TRAEFIK_ENTRYPOINT_HTTPS/);
  // WebSocket-Smoketest ueber den Proxy.
  assert.match(deployScript, /Sec-WebSocket-Key/);
  assert.match(deployScript, /101/);
  // Die alte Ablehnung darf nicht mehr im Traefik-Zweig stehen.
  const traefikBranch = deployScript.slice(
    deployScript.indexOf("  traefik-docker)"),
    deployScript.indexOf("  nginx)\n    TARGET=")
  );
  assert.ok(traefikBranch.length > 100, "Traefik-Zweig nicht gefunden");
  assert.doesNotMatch(traefikBranch, /bitte selbst eintragen/,
    "Traefik-Zweig verweigert die Route noch immer");
});

check("fremde Stacks werden nie neu gestartet oder veraendert", () => {
  for (const forbidden of [/docker restart/, /systemctl restart docker/, /\/docker\/n8n/]) {
    assert.doesNotMatch(deployScript, forbidden,
      `Deploy-Skript greift in einen fremden Stack ein: ${forbidden}`);
  }
  assert.match(deployScript, /COMPOSE_PROJECT_NAME.*quantus-neko/,
    "eigenes Compose-Projekt fehlt — sonst kollidiert es mit dem n8n-Projekt");
});

check("das Skript ist als Bibliothek testbar", () => {
  assert.match(deployScript, /NEKO_DEPLOY_LIB_ONLY/);
  const res = spawnSync("bash", ["tests/neko-proxy-detect.test.sh"], { cwd: root, encoding: "utf8" });
  assert.equal(res.status, 0, `Proxy-Erkennungstests fehlgeschlagen:\n${res.stdout}\n${res.stderr}`);
  console.log(res.stdout.split("\n").filter(l => l.includes("Pruefungen bestanden")).join("").trim()
    ? "    " + res.stdout.split("\n").filter(l => l.includes("Pruefungen bestanden"))[0].trim() : "");
});

check("Reverse Proxy wird erkannt, statt blind Caddy zu installieren", () => {
  assert.match(deployScript, /systemctl is-active --quiet nginx/);
  assert.match(deployScript, /systemctl is-active --quiet caddy/);
  assert.match(deployScript, /traefik/i);
  // Caddy nur im Zweig "kein Proxy gefunden".
  const install = deployScript.indexOf("apt-get install -y caddy");
  const noneBranch = deployScript.indexOf("  none)\n    info \"Installiere Caddy");
  assert.ok(install > 0 && noneBranch > 0 && install > noneBranch,
    "Caddy-Installation haengt nicht am none-Zweig");
});

check("keine destruktiven Ueberraschungen", () => {
  assert.doesNotMatch(deployScript, /rm -rf \/(\s|$)/);
  assert.doesNotMatch(deployScript, /docker compose down -v(?![^\n]*#)/,
    "down -v wuerde Daten loeschen und darf nur in der Rollback-Doku stehen");
  assert.doesNotMatch(deployScript, /\bread -[rp]\b/, "keine interaktiven Abfragen");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n7. Runbook");

check("Runbook trennt Code-Deploy und VPS-Deploy", () => {
  assert.match(runbook, /Code-Deploy \(Netlify\)/);
  assert.match(runbook, /VPS-Deploy \(Hostinger\)/);
});

check("Runbook nennt den Chromium-Check und verbietet apt-Chromium", () => {
  assert.match(runbook, /docker compose exec -T neko \/usr\/bin\/chromium --version/);
  assert.match(runbook.replace(/\s+/g, " "), /kein Chromium per `apt` installiert/);
  assert.match(runbook.replace(/\s+/g, " "), /Chromium ist bereits im Container-Image enthalten/i);
});

check("Runbook enthaelt Capability-Matrix und manuelle UI-Tests", () => {
  assert.match(runbook, /Capability-Matrix/);
  assert.match(runbook, /Tab-Gruppen/);
  assert.match(runbook, /Manuelle UI-Akzeptanztests/);
  // Google-Exklusivfunktionen werden ausdruecklich als fehlend gefuehrt.
  assert.match(runbook, /Google-Konto-Sync[\s\S]{0,200}nicht verfuegbar/);
  assert.match(runbook, /Gemini[\s\S]{0,200}nicht verfuegbar/);
});

check("Runbook dokumentiert Update-Verfahren und Rollback", () => {
  assert.match(runbook, /Kontrolliertes Update/);
  assert.match(runbook, /NEKO_IMAGE_TAG/);
  assert.match(runbook, /## 8\. Rollback/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n8. Andere Quantus-Module unveraendert");

check("Marker der uebrigen Module sind weiterhin vorhanden", () => {
  const markers = [
    ['case "gmail": html =', "Gmail"],
    ['case "drive": html = viewDrive();', "Drive"],
    ['case "polaris": html =', "Polaris"],
    ['case "briefings": html =', "Briefings"],
    ['case "googlecalendar": html =', "Google Calendar"],
    ["function viewDailyBriefing()", "Daily Briefing"],
    ["window.qxRouteHtml", "Split-Screen-Dock"],
    ['id="browserTabBar"', "Tab-Leiste des Quantus-Shells"],
    [".jb-container", "Journal Booklet"],
    [".nh .side{", "Newsroom Hub"]
  ];
  for (const [needle, label] of markers) {
    assert.ok(index.includes(needle), `${label} fehlt (Marker: ${needle})`);
  }
});

check("die gesamte Auslieferungskette liefert sauberes HTML", () => {
  // Bis hierher wurde nur die Quelldatei geprueft. Ausgeliefert wird aber das
  // Ergebnis beider Edge Functions — genau dort koennte ein CSS-Block erneut
  // aus seinem <style> fallen, ohne dass die Quelldatei etwas davon zeigt.
  const delivered = deliveredHtml;

  const leaks = textNodes(delivered).filter(n => n.text.length > 60 && looksLikeCode(n.text));
  assert.deepEqual(leaks.map(n => `Zeile ${n.line}: ${n.text.slice(0, 80)}`), [],
    "Code-Text im ausgelieferten HTML");

  // Die Kopf-Injektion muss im echten <head> landen, nicht in einem
  // JavaScript-String, der zufaellig ein </head> enthaelt.
  const lower = delivered.toLowerCase();
  assert.ok(lower.indexOf("</head>") < lower.indexOf("<body>"),
    "das erste </head> steht nicht mehr vor <body> — die Injektion trifft einen JS-String");
  assert.ok(delivered.includes("/quantus-device-sync.js"), "Universal-Assets fehlen");
  assert.ok(delivered.includes('key:"englishc1"') && delivered.includes('key:"career"'),
    "App-Registry-Injektion fehlt");
  // Die Marker-Skripte gehoeren ans Dokumentende.
  assert.ok(delivered.lastIndexOf("quantusEnglishC1HubLink") < lower.lastIndexOf("</body>"));
});

check("der ausgelieferte Stand ist ohne Volldownload pruefbar", () => {
  // Als live noch der alte Stand zu sehen war, liess sich nicht feststellen,
  // welcher Build ankommt. Die Bau-Kennung wird deshalb als Header gespiegelt.
  const tag = readBuildTag(index);
  assert.notEqual(tag, "unknown", "<meta name=\"quantus-build\"> fehlt");
  assert.ok(tag.length > 3, "Bau-Kennung ist zu unspezifisch");
  assert.equal(readBuildTag(deliveredHtml), tag,
    "die Kennung ueberlebt die Edge Functions nicht");

  const registry = read("netlify/edge-functions/quantus-app-registry.js");
  assert.match(registry, /headers\.set\("x-quantus-build", readBuildTag\(transformed\)\)/);

  // HTML darf nirgends zwischengespeichert werden — beide Edge Functions
  // entfernen den ETag, eine gecachte Fassung waere sonst nicht mehr
  // revalidierbar und ein Fix kaeme trotz Deploy nicht an.
  const bootstrap = read("netlify/edge-functions/quantus-universal-bootstrap.js");
  for (const [src, name] of [[registry, "app-registry"], [bootstrap, "universal-bootstrap"]]) {
    assert.match(src, /headers\.delete\("etag"\)/, `${name}: ETag-Behandlung fehlt`);
    assert.match(src, /cache-control", "no-store, no-cache, must-revalidate/,
      `${name}: setzt kein unbedingtes no-store`);
  }
  const toml = read("netlify.toml");
  assert.match(toml, /for = "\/index\.html"[\s\S]{0,200}Cache-Control = "no-store/);
  assert.match(toml, /for = "\/"\n {2}\[headers\.values\]\n {4}Cache-Control = "no-store/);
});

check("die Edge-Function-Injektion findet weiterhin ihre Anker", () => {
  // quantus-app-registry.js haengt neue Apps vor dem polaris-Eintrag bzw. vor
  // dem ruhestand-Router-Fall ein. Beide Anker muessen erhalten bleiben.
  assert.match(index, /\n[ \t]*\{[ \t]*key[ \t]*:[ \t]*["']polaris["'][ \t]*,/);
  assert.match(index, /\n[ \t]*case\s+["']ruhestand["']\s*:/);
  // Das echte </body> muss das letzte im Dokument sein (insertBeforeFinalClosingTag).
  assert.ok(index.trimEnd().endsWith("</html>"));
  const lastBody = index.toLowerCase().lastIndexOf("</body>");
  assert.ok(lastBody > index.toLowerCase().lastIndexOf("</script>"),
    "das letzte </body> steht nicht mehr am Dokumentende");
});

console.log(`\n✓ Quantus-Browser-Modul: ${checks} Pruefungen bestanden\n`);
