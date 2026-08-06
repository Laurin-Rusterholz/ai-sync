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
