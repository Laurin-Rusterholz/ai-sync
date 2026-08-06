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
console.log("\n2. Browser-Route, iframe und Status-UI");

check("Route, App-Eintrag und View sind vorhanden", () => {
  assert.match(index, /case "browser": html = viewBrowser\(\); break;/);
  assert.match(index, /\{key:"browser", icon:"🌐", label:"Browser"/);
  assert.match(index, /function viewBrowser\(\)/);
});

check("das iframe wird mit den noetigen Berechtigungen erzeugt", () => {
  assert.match(index, /frame\.id = "quantusBrowserFrame"/);
  for (const perm of ["autoplay", "fullscreen", "clipboard-read", "clipboard-write"]) {
    assert.ok(index.includes(perm), `allow="${perm}" fehlt`);
  }
  assert.match(index, /frame\.setAttribute\("allowfullscreen", ""\)/);
});

check("Status-/Retry-UI statt roher Fehlerseite", () => {
  assert.match(index, /function quantusBrowserStatusHtml\(/);
  assert.match(index, /Quantus Browser ist gerade nicht erreichbar/);
  assert.match(index, /data-action="browser-retry"/);
  assert.match(index, /data-action="browser-open-tab"/);
  // Erreichbarkeit wird vor dem Einhaengen geprueft (no-cors-Probe).
  assert.match(index, /mode: "no-cors"/);
  // Watchdog, falls die Verbindung steht, der Stream aber nicht laedt.
  assert.match(index, /QUANTUS_BROWSER_LOAD_MS/);
  // Automatischer Wiederholungsversuch.
  assert.match(index, /QUANTUS_BROWSER_RETRY_MS/);
});

check("alle data-action-Werte der Browser-UI haben einen Handler", () => {
  const view = index.slice(index.indexOf("function viewBrowser()"),
                           index.indexOf("function goBack()"));
  const used = new Set([...view.matchAll(/data-action="(browser-[a-z-]+)"/g)].map(m => m[1]));
  const status = index.slice(index.indexOf("function quantusBrowserStatusHtml("),
                             index.indexOf("const quantusBrowserState"));
  for (const m of status.matchAll(/data-action="(browser-[a-z-]+)"/g)) used.add(m[1]);
  assert.ok(used.size >= 4, `zu wenige Browser-Aktionen gefunden: ${[...used]}`);
  for (const action of used) {
    assert.ok(index.includes(`case "${action}":`), `kein Handler fuer ${action}`);
  }
});

check("Layout ist responsiv und vollbildfaehig", () => {
  assert.match(index, /\.qbr-stage\{[^}]*100dvh/s, "dvh-Hoehe fehlt (Mobile-Adressleiste)");
  assert.match(index, /@media \(max-width:820px\)/, "kein Breakpoint fuer Tablet/Handy");
  assert.match(index, /\.qbr-stage:fullscreen/, "kein Vollbild-Styling");
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
  assert.match(compose, /pids_limit: \d+/);
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

check("Sitzungs-Cookie ist HttpOnly + Secure (SameSite=None fuer das iframe)", () => {
  assert.match(compose, /NEKO_SESSION_COOKIE_ENABLED: "true"/);
  assert.match(compose, /NEKO_SESSION_COOKIE_SECURE: "true"/);
  assert.match(compose, /NEKO_SESSION_COOKIE_HTTP_ONLY: "true"/);
  assert.match(compose, /NEKO_SESSION_FILE: "\/home\/neko\/\.neko\/sessions\.json"/);
  assert.match(compose, /NEKO_SERVER_PROXY: "true"/);
});

check("Passwoerter kommen aus der .env und fehlen nicht stillschweigend", () => {
  assert.match(compose, /NEKO_MEMBER_MULTIUSER_USER_PASSWORD: "\$\{NEKO_USER_PASSWORD:\?/);
  assert.match(compose, /NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: "\$\{NEKO_ADMIN_PASSWORD:\?/);
});

check("docker compose config validiert die Datei", () => {
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.log("    (uebersprungen — docker compose steht hier nicht zur Verfuegung)");
    return;
  }
  // Platzhalterwerte nur fuer die Validierung; sie landen nirgends auf Platte.
  const res = spawnSync("docker", ["compose", "-f", "neko/docker-compose.yml", "config", "-q"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NEKO_USER_PASSWORD: "validation-placeholder",
      NEKO_ADMIN_PASSWORD: "validation-placeholder",
      NEKO_PUBLIC_IP: "203.0.113.10"
    }
  });
  assert.equal(res.status, 0, `docker compose config schlug fehl:\n${res.stderr}`);
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
    "Rollback:"
  ]) {
    assert.ok(deployScript.includes(needle), `"${needle}" fehlt im Deploy-Skript`);
  }
});

check("Smoke-Test gibt die Chromium-Version aus dem Container aus", () => {
  assert.match(deployScript, /docker compose exec -T neko \/usr\/bin\/chromium --version/);
});

check("kein Chromium wird auf dem Host installiert", () => {
  assert.doesNotMatch(deployScript, /apt-get install[^\n]*chromium/,
    "Chromium darf nicht per apt auf den Host");
  assert.match(deployScript, /Chromium steckt im Container-Image/);
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
