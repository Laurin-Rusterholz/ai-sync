# Quantus Browser — Setup, Runbook & Betrieb

Vollwertiger **Chromium-Remote-Browser** ([neko](https://github.com/m1k1o/neko))
auf dem bereits vorhandenen Hostinger-KVM-1-VPS, eingebettet als App
`#/browser` in Quantus.

> **Keine neuen kostenpflichtigen Dienste.** Es werden ausschliesslich der
> bestehende VPS, der bestehende Netlify-Plan, die bestehende Domain und
> Open-Source-Software (neko, Chromium, Docker, nginx/Caddy, Let's Encrypt)
> verwendet.

---

## 0. Die zwei Deploys sauber trennen

Es gibt **zwei voneinander unabhaengige Deployments**. Sie werden oft
verwechselt — hier die klare Trennung:

| | **Code-Deploy (Netlify)** | **VPS-Deploy (Hostinger)** |
|---|---|---|
| Was | Quantus-Frontend, `public/index.html` | neko-Container = der eigentliche Browser |
| Wie | `git push` -> Netlify baut automatisch | `bash scripts/deploy-neko-hostinger.sh` im hPanel-Terminal |
| Wo | `management-xo2-pro.netlify.app` | `srv1757990.hstgr.cloud` / `82.180.155.81` |
| Ergebnis | App `#/browser` mit iframe + Status-UI | `https://neko.laurin-rusterholz.ch` liefert den Stream |
| Secrets | **keine** | `/opt/quantus-neko/.env` (Modus 600) |

Der Code-Deploy funktioniert **ohne** den VPS: `#/browser` zeigt dann die
Status-/Retry-UI statt einer rohen Browser-Fehlerseite. Erst der VPS-Deploy
macht den Browser nutzbar.

**Aktueller Stand:** Code-Deploy fertig; VPS-Deploy von `main` (32e70e5) wurde
laut Live-Abnahme vom 2026-08-06 durchgefuehrt (HTTPS live, Container healthy).
Dieselbe Abnahme deckte drei Produktionsfehler auf, deren Fixes in diesem
Stand stecken: Login scheiterte mit „token not found" (Cookie-Auth vs.
Legacy-Client, Abschnitt 4), `data/` gehoerte `root:root` (permission denied
fuer `sessions.json`/Downloads, Chromium-SIGTRAP-Crash-Loop, Abschnitte 2/3)
und der HTTPS-Smoke prüfte per HEAD statt GET (falsch negativ, Abschnitt 6).
Nach `git pull` + erneutem Skriptlauf ist ein **Live-Retest** noetig — diese
Datei behauptet keinen Live-Zustand.

---

## 1. Was auf dem Host gebraucht wird — und was nicht

**Chromium ist bereits im Container-Image enthalten**
(`ghcr.io/m1k1o/neko/chromium`). Auf dem Ubuntu-Host wird **kein Chromium per
`apt` installiert**. Ein Host-Chromium waere nutzlos: der Stream kommt aus dem
Container, nicht vom Host.

| Host-Voraussetzung | Pflicht | Anmerkung |
|---|---|---|
| Docker Engine | ✅ | `curl -fsSL https://get.docker.com \| sh` |
| Compose-Plugin (`docker compose`) | ✅ | Teil moderner Docker-Installationen |
| Reverse Proxy | ✅ | auf diesem VPS: **Traefik im Docker** (n8n-Stack) — wird benutzt, nicht ersetzt |
| Zertifikat (Let's Encrypt) | ✅ | Traefik: ACME-Resolver des Bestands; nginx: certbot; Caddy: automatisch |
| `chromium` / `chromium-browser` per apt | ❌ | **nicht installieren** |
| X-Server, Desktop, VNC auf dem Host | ❌ | steckt alles im Container |

### Verifizierbarer Chromium-Check

Die im Container tatsaechlich laufende Chromium-Version ausgeben:

```bash
cd /opt/quantus-neko && docker compose exec -T neko /usr/bin/chromium --version
# erwartete Ausgabe, z. B.:  Chromium 13x.0.xxxx.xx
```

Gegenprobe, dass der Host **kein** Chromium braucht:

```bash
command -v chromium chromium-browser || echo "kein Host-Chromium — genau richtig"
```

Das Deploy-Skript fuehrt beide Pruefungen in seinen Smoke-Tests automatisch aus.

---

## 2. VPS-Deploy — Schritt fuer Schritt im hPanel-Terminal

Alle Befehle als `root` im **Hostinger hPanel -> VPS -> Browser-Terminal**.

```bash
# 1) Repo holen bzw. aktualisieren (kein Chromium, keine Systempakete)
apt-get update -qq && apt-get install -y git
git clone https://github.com/Laurin-Rusterholz/ai-sync.git /opt/ai-sync 2>/dev/null \
  || git -C /opt/ai-sync pull --ff-only

# 2) Trockenlauf: prueft alles, aendert nichts
bash /opt/ai-sync/scripts/deploy-neko-hostinger.sh --check

# 3) Deployen
bash /opt/ai-sync/scripts/deploy-neko-hostinger.sh
```

Der letzte Befehl gibt das **User-Passwort genau einmal** aus. Sofort in den
Quantus-Passwortmanager uebernehmen. Spaeter jederzeit nachlesbar mit:

```bash
grep NEKO_USER_PASSWORD /opt/quantus-neko/.env
```

### Was das Skript tut

1. **Vorabpruefungen** — root, Ubuntu-Version, Docker/Compose, DNS, Speicher,
   RAM; warnt, falls jemand Chromium auf dem Host installiert hat.
2. **Reverse-Proxy-Erkennung** — nginx/Caddy als Host-Dienst, Traefik/nginx/
   Caddy als Container, oder gar nichts. Es wird **nur dann Caddy installiert,
   wenn kein anderer Proxy laeuft und 80/443 frei sind**. Laeuft bereits ein
   Proxy fuer n8n, bekommt neko lediglich eine zusaetzliche Route — das
   bestehende n8n bleibt unangetastet.
3. **Backup** jeder Proxy-/Compose-Datei nach `/opt/quantus-neko/backups/`
   *vor* der Aenderung; `nginx -t` bzw. `caddy validate` schlaegt fehl ->
   automatischer Rueckbau.
4. **`.env`** wird nur beim allerersten Lauf mit `openssl rand -base64 24`
   erzeugt (Modus 600) und danach nie ueberschrieben.
5. **Rechte** — `data/{profile,downloads,neko}` gehoert `1000:1000` (User
   `neko` im Container; per `NEKO_DATA_UID`/`NEKO_DATA_GID` uebersteuerbar).
   Das Skript repariert Eigentuemer/Rechte bei **jedem** Lauf idempotent:
   `chown -R` nur bei Abweichung, nie loeschend — bestehende Profile und
   Downloads bleiben erhalten. Ohne diesen Schritt (root:root-Verzeichnisse)
   scheitern `sessions.json` und Downloads mit „permission denied" und
   Chromium crasht im Loop, weil sein `--user-data-dir` nicht beschreibbar ist.
6. **Firewall** — `ufw`-Regeln, falls ufw aktiv; ausserdem der Hinweis auf die
   Hostinger-Panel-Firewall.
7. **`docker compose up -d`** und Warten auf `healthy`.
8. **Smoke-Tests** — siehe Abschnitt 6.

Das Skript ist **idempotent**: mehrfaches Ausfuehren ist unschaedlich.

### Hostinger-Panel-Firewall

Die Panel-Firewall sitzt **vor** dem Betriebssystem, `ufw` allein reicht nicht.
Im hPanel freigeben:

| Port | Protokoll | Wofuer |
|---|---|---|
| 80 | TCP | Let's-Encrypt-Challenge, HTTP -> HTTPS |
| 443 | TCP | HTTPS + WebSocket (Signalisierung) |
| 59000 | **UDP** | WebRTC-Medienstrom — **ohne diesen Port bleibt das Bild schwarz** |
| 59000 | TCP | WebRTC-Fallback in restriktiven Netzen |

---

## 2b. Der bestehende Traefik-Stack (so laeuft es auf diesem VPS)

Auf dem VPS laeuft bereits ein n8n-Stack mit **Traefik v3.7.5** als Reverse
Proxy (Compose-Projekt `n8n`, Datei `/docker/n8n/docker-compose.yml`, Docker-
Provider mit `exposedByDefault=false`, EntryPoints `web`/`websecure`, globaler
HTTP→HTTPS-Redirect, ACME-Resolver `mytlschallenge`, Netz `n8n_default`).

**Dieser Stack wird nicht angefasst.** Kein Restart, kein `down`, keine
Aenderung an seiner Compose-Datei, keine Aenderung an der Traefik-Konfiguration.
neko meldet sich stattdessen selbst bei Traefik an — genau dafuer ist der
Docker-Provider da.

### Wie die Route entsteht

Das Deploy-Skript erkennt Traefik und laedt zusaetzlich
`neko/docker-compose.traefik.yml`. Das Overlay tut zwei Dinge:

1. Es haengt den neko-Container an das **bereits vorhandene** externe Netz
   `n8n_default` (`external: true` — es wird kein Netz erzeugt).
2. Es setzt Labels, die Traefik von selbst aufgreift:

| Label | Wert | Warum |
|---|---|---|
| `traefik.enable` | `true` | zwingend, weil `exposedByDefault=false` gilt |
| `traefik.docker.network` | `n8n_default` | sonst waehlt Traefik u. U. das falsche Netz und die Route ist tot |
| `…routers.quantus-neko.rule` | ``Host(`neko.laurin-rusterholz.ch`)`` | eigene Subdomain, kollidiert nicht mit n8n |
| `…routers.quantus-neko.entrypoints` | `websecure` | HTTPS |
| `…routers.quantus-neko.tls.certresolver` | `mytlschallenge` | derselbe ACME-Resolver wie n8n |
| `…routers.quantus-neko-web.entrypoints` | `web` | HTTP |
| `…middlewares.quantus-neko-https.redirectscheme` | `https` | eigener Redirect, falls der globale einmal entfaellt |
| `…services.quantus-neko.loadbalancer.server.port` | `8080` | container-interner Port |

Alle Namen sind mit `quantus-neko` praefixiert und koennen deshalb keine
n8n-Router oder -Middlewares ueberschreiben.

### Was Traefik NICHT macht

**WebRTC laeuft an Traefik vorbei.** Der Medienstrom braucht UDP; Traefik ist
hier fuer HTTP/TLS zustaendig. Port **59000 (UDP + TCP)** bleibt deshalb direkt
am Host veroeffentlicht. Ueber Traefik laufen nur HTTPS und der WebSocket, mit
dem der Stream ausgehandelt wird — WebSockets reicht Traefik v3 ohne
Zusatzkonfiguration durch.

### Was das kostet: neko sitzt im n8n-Netz

Weil Traefik nicht veraendert werden darf, ist das gemeinsame Netz der einzige
Weg. Damit kann der Remote-Browser n8n-Container direkt ueber deren interne
Ports erreichen. Das ist bewusst in Kauf genommen und hier festgehalten: Wer
den Browser bedient, hat ohnehin ein Passwort fuer diese Umgebung. Wer es
strenger will, muss Traefik ein zweites Netz geben — das aendert aber den
n8n-Stack und ist deshalb hier ausgeschlossen.

### Der Compose-Kontext bleibt getrennt

Das Deploy-Skript schreibt in `/opt/quantus-neko/.env`:

```
COMPOSE_PROJECT_NAME=quantus-neko
COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml
```

Dadurch ist `docker compose` in `/opt/quantus-neko` **immer** nur fuer den
neko-Stack zustaendig; das Projekt `n8n` bleibt unberuehrt — auch bei
`docker compose down`.

---

## 3. Architektur & Designentscheidungen

```
Browser des Nutzers
   │  https://management-xo2-pro.netlify.app/#/browser      (Netlify)
   │      └─ iframe ──────────────────────────────────────┐
   ▼                                                      │
https://neko.laurin-rusterholz.ch  (TLS, Let's Encrypt)    │
   │  Traefik im Docker (bestehender n8n-Stack, unveraendert)
   ├─ HTTP/WebSocket ──▶ quantus-neko:8080 ueber das Netz n8n_default
   │                     (zusaetzlich 127.0.0.1:8080 nur fuer lokale Diagnose)
   └─ WebRTC UDP/TCP 59000 ──▶ direkt am Host, an Traefik vorbei
                                   │
                            Chromium im Container
                                   │
                    /opt/quantus-neko/data/{profile,downloads,neko}
```

**Nur ein Container.** Keine Nebencontainer (kein TURN, kein separater Proxy,
keine Datenbank) — das waere auf 1 vCPU / 4 GB verschwendet.

### Ein UDP-Port statt eines Portbereichs

Das alte Setup exponierte `56000-56100/udp`. Docker startet dafuer **pro Port
einen `docker-proxy`-Prozess** — auf KVM 1 rund 100 unnoetige Prozesse. Statt-
dessen nutzt dieses Setup den **UDP-Mux** von neko: ein einziger Port (59000)
bedient alle Verbindungen, plus TCP-Fallback auf demselben Port.

### Ressourcen (KVM 1: 1 vCPU / 4 GB)

| Einstellung | Wert | Warum |
|---|---|---|
| `shm_size` | `2gb` | Reserve fuer X-Server und GStreamer. **Nicht** die Ursache der Live-Abstuerze: das Image startet Chromium mit `--disable-dev-shm-usage`, es nutzt `/tmp` |
| `mem_limit` | `2600m` | laesst ~1,4 GB fuer Host + n8n; OOM trifft den Container, nicht den Host |
| `cpu_shares` | `512` | halbe Gewichtung gegenueber n8n statt harter CPU-Deckelung |
| `pids_limit` | `2048` | Schutz vor Prozess-Explosionen. Zaehlt **Threads** mit — Chromium belegt schon mit wenigen Tabs mehrere hundert; bei `512` schlug `clone()` fehl und Chromium stuerzte mit SIGTRAP ab |
| `NEKO_DESKTOP_SCREEN` | `1280x720@30` | Software-Encoding auf 1 vCPU; hoehere Aufloesung nur bei Bedarf |
| `restart` | `unless-stopped` | Autostart nach Reboot |
| `logging` | 10 MB × 3 | die 50-GB-Platte laeuft nicht mit Logs voll |

#### Warum `SIGTRAP` — und was ausgeschlossen wurde

`SIGTRAP` ist bei Chromium kein Speicher- und kein Netzwerkproblem: jedes
fatale `CHECK` endet in `IMMEDIATE_CRASH()`, und das ist auf x86 ein `int3`,
also genau `SIGTRAP (core dumped)`. Ein OOM saehe anders aus (`SIGKILL`,
Exit 137). Gesucht war folglich ein fatales `CHECK` beim Start:

| Verdacht | Befund |
|---|---|
| **Profil-Mount nicht beschreibbar** | **Hauptursache.** `--user-data-dir=/home/neko/.config/chromium` ist das gemountete `data/profile`; es gehoerte `root`, Chromium laeuft als `neko`. Ohne beschreibbares Profil bricht Chromium fatal ab, `supervisord` startet es wegen `autorestart=true` endlos neu |
| **`pids_limit` erreicht** | zweiter, gleichwertiger Pfad: die Grenze zaehlt Threads, ein fehlgeschlagenes `clone()` endet ebenfalls im `CHECK`. Deshalb von `512` auf `2048` erhoeht |
| `/dev/shm` zu klein | ausgeschlossen — das Image startet Chromium mit `--disable-dev-shm-usage` |
| Sandbox / seccomp | ausgeschlossen — das Image startet mit `--no-sandbox`, `SYS_ADMIN` und `seccomp:unconfined` sind gesetzt |
| Chromium-Policies | ausgeschlossen — ungueltige Policies ignoriert Chromium, es bricht deswegen nicht ab |
| `mem_limit` | ausgeschlossen als Ursache **dieses** Symptoms (waere `SIGKILL`) |

Die **Startargumente kommen aus dem Image** (`--no-sandbox`,
`--disable-dev-shm-usage`, `--disable-gpu`, `--user-data-dir=…`) und werden
bewusst nicht ueberschrieben — dafuer waere ein eigenes Image noetig.

Warum das in `docker logs` schwer zu sehen war: Chromiums eigene Ausgabe geht
nach `/var/log/neko/chromium.log` **im Container**, nicht auf stdout. Der
Smoke-Test liest deshalb im Crash-Fall genau diese Datei mit aus.

Aufloesung spaeter aendern: `NEKO_SCREEN` in `/opt/quantus-neko/.env`, dann
`docker compose up -d`. Alternativ zur Laufzeit als Admin in der neko-UI.

### Persistenz

| Pfad im Container | Pfad auf dem VPS | Inhalt |
|---|---|---|
| `/home/neko/.config/chromium` | `/opt/quantus-neko/data/profile` | Profil, Cookies/Logins, Verlauf, Lesezeichen, Tabs & Tab-Gruppen, Einstellungen |
| `/home/neko/Downloads` | `/opt/quantus-neko/data/downloads` | Downloads + Ziel des Datei-Transfers |
| `/home/neko/.neko` | `/opt/quantus-neko/data/neko` | neko-Sitzungsdatei (`NEKO_SESSION_FILE`) — Anmeldung ueberlebt Neustarts |

Alle drei gehoeren `1000:1000` (Container-User `neko`). Das Deploy-Skript
setzt Eigentuemer und Rechte bei jedem Lauf idempotent (`ensure_data_dir`:
`chown -R` nur bei Abweichung, `chmod u+rwX` auf das Verzeichnis, nie
loeschend) und der Smoke-Test macht zusaetzlich eine **Schreibprobe aus
Container-Sicht** (als UID 1000 in allen drei Pfaden).

`RestoreOnStartup: 1` in den Chromium-Policies stellt beim Start die letzte
Sitzung wieder her — offene Tabs und Tab-Gruppen sind nach
`docker compose restart` wieder da.

**Nebenwirkung des Profil-Mounts:** `data/profile` verdeckt
`/home/neko/.config/chromium` und damit die Voreinstellungen, die das Image
dort ablegt (Home-Knopf, Lesezeichenleiste). Docker kopiert Image-Inhalte nur
in leere **benannte** Volumes, nicht in Bind-Mounts — beim ersten Start fehlten
sie also. Das Deploy-Skript holt sie deshalb einmalig aus dem Image
(`seed_chromium_preferences`); ein bereits vorhandenes Profil bleibt dabei
unangetastet.

---

## 4. Sicherheit

### Kein Passwort im Frontend

Das bisherige Setup hatte das neko-User-Passwort **im Klartext in
`public/index.html`** und schickte es zusaetzlich als `?pwd=` in der URL. Damit
stand es im ausgelieferten HTML, in der Browser-History, in Proxy-/Server-Logs
und im Git-Verlauf. Das ist entfernt.

Stattdessen:

* Die iframe-URL enthaelt nur `?usr=quantus&embed=1&lang=de` — **kein
  Geheimnis**. Der Benutzername ist vorbelegt, das Passwortfeld nicht.
* Der Nutzer meldet sich **einmal** in der neko-Login-Maske an.
* Serverseitig ist **Cookie-Auth aus** (`NEKO_SESSION_COOKIE_ENABLED=false`).
  Das ist kein Stil-, sondern ein Kompatibilitaetsentscheid: Das gepinnte
  Image `3.1.5` liefert den **v2-Client** aus, der ausschliesslich die
  **Legacy-API** spricht. Deren Login liest den Token aus dem Antwort-Body von
  `/api/login` — bei aktivierter Cookie-Auth laesst neko ihn dort bewusst weg,
  und **jeder** Login endet mit „token not found - make sure you are not using
  Cookie auth on the server". Genau das zeigte die Live-Abnahme. Beleg im
  neko-Quelltext (`server/internal/http/legacy/session.go`): der Kommentar
  „if Cookie auth, the token will be empty" steht direkt ueber dieser
  Fehlermeldung.
* Ohne Cookies haengt der Login an **keiner** Third-Party-Cookie-Regel mehr:
  er funktioniert im Cross-Site-iframe genauso wie im neuen Tab — auch in
  Safari. Der v2-Client merkt sich die Anmeldung nach dem ersten Login selbst
  im **localStorage seiner Origin** (Quelle: `client/src/store/index.ts` im
  neko-Repo) — Reloads fragen nicht erneut. Im iframe gilt dafuer der ggf.
  partitionierte Speicher des jeweiligen Browsers.
* `NEKO_SESSION_FILE` legt serverseitige Sitzungen auf Platte ab — sie
  ueberleben `docker compose restart` und einen VPS-Reboot.
* `NEKO_LEGACY=true` steht ausdruecklich in der Compose-Datei. Die
  Legacy-Bruecke ist heute der Image-Default — faellt sie in einer kuenftigen
  Version weg, waere die Anmeldung wieder tot. Der Smoke-Test prueft deshalb
  auch den Pfad `/ws`, den der Client wirklich benutzt (nicht `/api/ws`).

### Ehrlich benannt: das Passwort steht in der Anfrage des Clients

Der mitgelieferte v2-Client haengt Benutzer und Passwort als
**Query-Parameter** an seine eigenen Anfragen (`/ws?password=…`,
`/file?pwd=…`). Das laesst sich ohne einen selbst gebauten Client nicht
abstellen — und ein eigener Client ist hier bewusst nicht das Ziel. Was daraus
folgt, statt es zu verschweigen:

* Uebertragen wird ausschliesslich ueber TLS.
* neko protokolliert **erfolgreiche** Anfragen nur auf `debug`; im
  Normalbetrieb (`info`) steht die URL nicht im Log. Bei einer
  **fehlgeschlagenen** `/file`-Anfrage landet sie mit im Warn-Eintrag.
  `docker logs quantus-neko` ist deshalb wie ein Secret zu behandeln: nur
  root, Rotation 10 MB × 3, nicht weitergeben.
* Traefiks Access-Log ist im bestehenden n8n-Stack nicht aktiviert — und wird
  von hier aus auch nicht angefasst.
* **In Quantus, im Repo und in der iframe-URL steht das Passwort nirgends.**
  Auch das Deploy-Skript gibt es nie aus: die Anmelde-Probe schickt es ueber
  `stdin`, den Sitzungstoken ueber eine curl-Konfigurationsdatei (Modus 600) —
  beides taucht nicht in der Prozessliste des Hosts auf.

**UX-Trade-off, ehrlich benannt:** ein echter passwortloser Auto-Login ist mit
neko nur moeglich, indem das Passwort im Client offengelegt wird. Das wird
bewusst **nicht** gemacht. Der Preis: gelegentlich einmal Passwort eintippen
(z. B. wenn der Browser partitionierten iframe-Speicher leert). Der Knopf
**„↗ Neuer Tab"** in der Browser-Kopfzeile bleibt als Ausweichweg — dort ist
neko First-Party mit unpartitioniertem Speicher.

### Wichtig nach dem Deploy: altes Passwort rotieren

Das frueher hart codierte Passwort steht weiterhin im **Git-Verlauf** (Commit
`abb9330` und aelter). Es ist damit dauerhaft als kompromittiert zu behandeln.
Das Deploy-Skript erzeugt beim ersten Lauf ohnehin ein neues Zufallspasswort.
Falls auf dem VPS bereits eine `.env` mit dem alten Wert existiert:

```bash
NEW_PW="$(openssl rand -base64 24)"
sed -i "s|^NEKO_USER_PASSWORD=.*|NEKO_USER_PASSWORD=${NEW_PW}|" /opt/quantus-neko/.env
cd /opt/quantus-neko && docker compose up -d
echo "Neues Passwort: ${NEW_PW}"   # in den Quantus-Passwortmanager uebernehmen
```

### Weitere Entscheidungen

| Entscheidung | Warum |
|---|---|
| HTTP-Port nur an `127.0.0.1` gebunden | neko ist nur ueber den TLS-Proxy erreichbar, nie unverschluesselt |
| `NEKO_SERVER_PROXY=true` | neko vertraut `X-Forwarded-*` nur hinter dem Proxy |
| Admin-Passwort nie im Client | Aufloesung/Nutzerverwaltung bleibt serverseitig |
| `PasswordManagerEnabled: false` | gespeicherte Passwoerter laegen im Profil auf dem VPS; Website-Cookies im Chromium-Profil genuegen fuer „eingeloggt bleiben" |
| `SyncDisabled`, `BrowserSignin: 0` | keine Google-Kontoanmeldung — wir taeuschen keinen Chrome-Sync vor |
| `ExtensionInstallBlocklist: ["*"]` | keine beliebigen Erweiterungen; Freigabe einzelner IDs siehe Abschnitt 5 |
| `.env` Modus 600, in `.gitignore` | Secrets nur serverseitig |
| Container ohne `--privileged` | nur `SYS_ADMIN` + `seccomp:unconfined` (Empfehlung der neko-Doku fuer Chromium-Images), sonst nichts |

---

## 5. Capability-Matrix — Desktop-Chrome vs. Quantus Browser

Ehrliche Gegenueberstellung. „Chrome" = Google Chrome auf dem eigenen Rechner,
„Quantus Browser" = Chromium im neko-Container, gestreamt ins Quantus-iframe.

### Funktioniert gleichwertig

| Funktion | Chrome | Quantus Browser | Anmerkung |
|---|---|---|---|
| Sichtbare Tab-Leiste | ✅ | ✅ | echtes Chromium-Fenster, keine Kiosk-Maske |
| Adress-/Suchleiste (Omnibox) | ✅ | ✅ | inkl. Suchvorschlaege |
| Vor / Zurueck / Reload / Home | ✅ | ✅ | `show_home_button` ist im Image gesetzt |
| Mehrere Tabs & Fenster | ✅ | ✅ | |
| **Tab-Gruppen** (farbig, benannt, klappbar) | ✅ | ✅ | Chromium-Kernfunktion, kein Google-Konto noetig |
| Verlauf (`Strg+H`) | ✅ | ✅ | ueberlebt Neustarts (Profil-Volume) |
| Lesezeichen + Lesezeichenleiste | ✅ | ✅ | per Policy aktiviert (`EditBookmarksEnabled`, `BookmarkBarEnabled`) |
| Downloads (`Strg+J`) | ✅ | ✅ | landen in `data/downloads` auf dem VPS |
| Datei-Upload (`<input type=file>`) | ✅ | ✅ | `AllowFileSelectionDialogs` + neko-Dateidialog |
| Drag & Drop von Dateien | ✅ | ✅ | `NEKO_DESKTOP_UPLOAD_DROP` |
| Tastatur, Maus, Scrollen, Kontextmenue | ✅ | ✅ | inkl. Rechtsklick-Menue von Chromium |
| Audio | ✅ | ✅ | via WebRTC-Audiospur |
| Vollbild | ✅ | ✅ | Knopf „⛶ Vollbild" bzw. F11 im Stream |
| DevTools (F12) | ✅ | ✅ | per Policy freigeschaltet |
| Inkognito-Fenster | ✅ | ✅ | per Policy freigeschaltet |
| Cookies/Logins bleiben erhalten | ✅ | ✅ | `DefaultCookiesSetting: 1` + Profil-Volume |
| Letzte Sitzung wiederherstellen | ✅ | ✅ | `RestoreOnStartup: 1` |
| PDF-Viewer, Druckvorschau | ✅ | ✅ | Chromium-intern |
| Profile / Persistenz | ✅ | ⚠️ | **ein** persistentes Profil; mehrere Nutzerprofile sind bewusst deaktiviert (`BrowserAddPersonEnabled: false`) |

### Anders oder eingeschraenkt — bewusst

| Funktion | Chrome | Quantus Browser | Warum |
|---|---|---|---|
| Zwischenablage | ✅ nativ | ⚠️ | Text-Sync klappt in Chromium-basierten Clients ueber die Async-Clipboard-API (`can_access_clipboard` ist aktiv). In Firefox/Safari erlaubt die Browser-Sicherheitsregel keinen automatischen Zugriff — dort ueber das Clipboard-Feld der neko-UI. Bilder werden nicht synchronisiert. |
| Erweiterungen (uBlock etc.) | ✅ | ⚠️ | standardmaessig gesperrt; einzelne IDs freischaltbar, siehe unten |
| Gespeicherte Passwoerter | ✅ | ❌ bewusst aus | Profil liegt auf dem VPS |
| Kamera/Mikrofon der eigenen Hardware | ✅ | ❌ | der Container hat keine physische Kamera; neko kann eine Medienspur teilen, das ist nicht dasselbe |
| Latenz / Reaktion | nativ | ⚠️ | Video-Stream; auf 1 vCPU bei 720p30 fluessig, aber spuerbar langsamer als lokal |

### Proprietaere Google-Funktionen — nicht vorhanden, nicht vorgetaeuscht

| Funktion | Status |
|---|---|
| Google-Konto-Sync (Lesezeichen/Tabs/Passwoerter geraeteuebergreifend) | ❌ nicht verfuegbar — Chromium ohne Google-Sync-API-Schluessel; `SyncDisabled: true` |
| In Chrome integriertes Gemini / „Hilf mir schreiben" / KI-Tab-Gruppierung | ❌ nicht verfuegbar — Chrome-exklusiv, nicht Teil von Chromium |
| Chrome Web Store „mit einem Klick" | ⚠️ eingeschraenkt — funktioniert in Chromium nicht zuverlaessig und ist per Policy gesperrt |
| Widevine-DRM (Netflix, Disney+ in HD) | ⚠️ ungetestet in diesem Setup — nicht als funktionierend zugesichert |
| Passwortmanager mit Google-Konto | ❌ nicht verfuegbar |

**KI in Quantus:** Die KI-Funktionen bleiben dort, wo sie schon sind — in
Quantus selbst (Claude-/Gemini-/OpenAI-Anbindung in den Quantus-Modulen, mit
den bereits hinterlegten API-Schluesseln). Der Remote-Browser ist bewusst
**kein** zweiter KI-Ort: Inhalte aus dem Browser werden per Zwischenablage nach
Quantus uebernommen und dort mit der vorhandenen KI verarbeitet. Es wird keine
neue KI-Plattform und kein zusaetzliches Abo eingefuehrt. Laufende API-Kosten
entstehen nur ueber die bereits genutzten Quantus-Integrationen.

**„Projekte"/Arbeitsbereiche:** Chromiums **Tab-Gruppen** sind das
Arbeitsbereichs-Konzept hier — benannt, farbig, klappbar, und dank
`RestoreOnStartup: 1` nach Neustart wieder da. Ein separates
„Workspaces"-Produkt (wie in Vivaldi oder Arc) gibt es nicht und wird nicht
vorgetaeuscht.

### Einzelne Erweiterung freischalten (optional, kostenlos)

```bash
# ID aus der Chrome-Web-Store-URL, dann in chromium-policies.json ergaenzen:
#   "ExtensionInstallAllowlist": [..., "<extension-id>"]
#   "ExtensionInstallForcelist": [..., "<extension-id>;https://clients2.google.com/service/update2/crx"]
nano /opt/quantus-neko/chromium-policies.json
cd /opt/quantus-neko && docker compose restart neko
```

Die beiden bereits eingetragenen IDs stammen aus dem neko-Image und bleiben
drin.

---

## 5b. Welcher Frontend-Stand ist live?

Nach einem Merge auf `main` baut Netlify neu. Ob der neue Stand tatsaechlich
ankommt, laesst sich ohne 5-MB-Download pruefen — `index.html` traegt eine
Bau-Kennung, die die Edge Function als Header spiegelt:

```bash
curl -sSI https://management-xo2-pro.netlify.app/ | grep -i x-quantus-build
# erwartet z. B.: x-quantus-build: neko-traefik+nh-style-restore · 2026-08-06
```

Steht dort eine aeltere Kennung, ist der Build noch nicht durch — nicht der
Code. Zusaetzlich liefern `netlify.toml` und beide Edge Functions fuer `/` und
`/index.html` jetzt `Cache-Control: no-store, no-cache, must-revalidate`: die
Funktionen entfernen den ETag, eine zwischengespeicherte Fassung waere sonst
nicht mehr revalidierbar und ein Fix kaeme trotz Deploy nicht an.

Im Browser hartnaeckige Reste loswerden: Shift+Reload bzw. Entwicklertools →
Netzwerk → "Cache deaktivieren".

---

## 6. Abnahme

### Automatische Smoke-Tests (Skript)

```bash
bash /opt/ai-sync/scripts/deploy-neko-hostinger.sh --smoke
```

Prueft: `docker compose ps`, Chromium-Version **im Container**,
**Chromium-Stabilitaet** (zwei PID-Stichproben im Abstand von 15 s — erkennt
den SIGTRAP-Crash-Loop, den ein blosser Versions-Check uebersieht), gepinntes
Image, lokale HTTP-Antwort, dass Port 8080 **nicht** auf `0.0.0.0` lauscht,
HTTPS **per GET** (neko beantwortet HEAD mit 405 — ein `curl -I`-Smoke war
live falsch negativ) + Zertifikatsaussteller/-laufzeit, WebSocket-Upgrade auf
`/api/ws` **und** auf `/ws` (den Pfad, den der Client des Images wirklich
nutzt), WebRTC-UDP-Port, Existenz, **Eigentuemer** und Rechte der
Persistenz-Verzeichnisse inklusive **Schreibprobe aus Container-Sicht**
(als UID 1000), Autostart-Konfiguration.

Dazu die **echte Anmeldung**: der Smoke meldet sich per `/api/login` an,
prueft, ob der Token im Antwort-Body steht (nur dann kann der mitgelieferte
Client ihn verwenden), und meldet sich sofort wieder ab. Das ist die einzige
Pruefung, die den Live-Fehler wirklich ausschliesst — dass in der
Compose-Datei `NEKO_SESSION_COOKIE_ENABLED="false"` steht, heisst noch nicht,
dass der **laufende** Container es uebernommen hat. Schlaegt sie an, nennt die
Ausgabe den Grund im Klartext (Cookie-Auth aktiv, falsches Passwort oder API
nicht erreichbar). Passwort und Token erscheinen dabei in keiner Ausgabe.

### Manuelle Kommandozeilen-Checks

```bash
# GET, nicht HEAD (-I) — neko beantwortet HEAD mit 405:
curl -fsS -o /dev/null -w '%{http_code}\n' https://neko.laurin-rusterholz.ch/   # erwartet: 200
cd /opt/quantus-neko && docker compose ps             # State: running (healthy)
docker compose exec -T neko /usr/bin/chromium --version
```

### Manuelle UI-Akzeptanztests

In Quantus `#/browser` oeffnen, anmelden (Benutzer `quantus`), dann der Reihe
nach:

| # | Test | Erwartet |
|---|---|---|
| 1 | Seite `#/browser` oeffnen | Chromium-Fenster erscheint; **kein** CSS-Text unterhalb; keine rohe Fehlerseite |
| 2 | Adressleiste: `wikipedia.org` eintippen, Enter | Seite laedt, Omnibox zeigt die URL |
| 3 | Zweiten Tab per `Strg+T` oeffnen, `github.com` laden | zwei Tabs sichtbar in der Tab-Leiste |
| 4 | Dritten Tab oeffnen, zwischen Tabs klicken | Wechsel funktioniert, Inhalte bleiben |
| 5 | Zwei Tabs markieren -> Rechtsklick -> „Tabs zu neuer Gruppe hinzufuegen", Gruppe benennen (z. B. „Projekt Quantus") und faerben | farbige, benannte Tab-Gruppe erscheint |
| 6 | Gruppe zuklappen und wieder aufklappen | funktioniert |
| 7 | Zurueck / Vor / Reload ueber die Chromium-Knoepfe | Navigation korrekt |
| 8 | `Strg+D` -> Lesezeichen setzen; `Strg+Umschalt+O` -> Lesezeichenverwaltung | Lesezeichen wird gespeichert und ist auffindbar |
| 9 | `Strg+H` -> Verlauf | besuchte Seiten sind gelistet |
| 10 | Auf einer Seite eine Datei herunterladen; `Strg+J` | Download erscheint; auf dem VPS in `/opt/quantus-neko/data/downloads` |
| 11 | Eine Upload-Seite oeffnen, „Datei auswaehlen" | neko fragt nach der lokalen Datei, Upload klappt |
| 12 | Datei per Drag & Drop ins Stream-Fenster ziehen | Datei landet im Remote-Browser |
| 13 | YouTube-Video oeffnen | Bild **und** Ton kommen an |
| 14 | Knopf „⛶ Vollbild" | Stream fuellt den Bildschirm, Bedienung bleibt |
| 15 | Rechtsklick auf einer Seite | Chromium-Kontextmenue erscheint (nicht das des eigenen Browsers) |
| 16 | Text im Stream markieren, kopieren, in Quantus einfuegen | funktioniert in Chromium-Clients (siehe Zwischenablage-Zeile oben) |
| 17 | Fenster auf Handybreite verkleinern / Tablet drehen | Buehne skaliert, keine Ueberlaeufe, keine horizontale Scrollleiste |
| 18 | **KI-Zugriff:** Inhalt aus dem Browser kopieren, in Quantus `#/chat` bzw. ein KI-Modul einfuegen und verarbeiten | Quantus-KI antwortet mit den vorhandenen API-Schluesseln — kein zusaetzlicher Dienst |
| 19 | Irgendwo einloggen (z. B. ein Webmail), dann `docker compose restart` | nach Neustart noch eingeloggt, Tabs wiederhergestellt, Lesezeichen und Downloads da |
| 20 | `reboot` des VPS | Container startet automatisch, `docker compose ps` zeigt wieder `healthy` |
| 21 | Container stoppen (`docker compose stop`), `#/browser` neu laden | freundliche Status-UI mit „Erneut versuchen" statt Browser-Fehlerseite; nach `docker compose start` verbindet die Auto-Wiederholung selbstaendig |

---

## 7. Kontrolliertes Update

**Nie `:latest`.** Die Version steht als `NEKO_IMAGE_TAG` in
`/opt/quantus-neko/.env` (aktuell `3.1.5`).

```bash
# 1) Aktuelle Version notieren (fuer den Rollback)
grep NEKO_IMAGE_TAG /opt/quantus-neko/.env

# 2) Release Notes lesen: https://github.com/m1k1o/neko/releases

# 3) Profil sichern (Downloads/Cookies/Lesezeichen)
tar czf /root/neko-profile-$(date +%F).tar.gz -C /opt/quantus-neko data

# 4) Neue Version eintragen und ziehen
sed -i 's/^NEKO_IMAGE_TAG=.*/NEKO_IMAGE_TAG=<neue-version>/' /opt/quantus-neko/.env
bash /opt/ai-sync/scripts/deploy-neko-hostinger.sh --update

# 5) Abnahme
bash /opt/ai-sync/scripts/deploy-neko-hostinger.sh --smoke
```

Rollback bei Problemen: alten Tag zuruecksetzen, `docker compose up -d`.

Alte Images aufraeumen (die 50-GB-Platte):
`docker image prune -a --filter "until=720h"`

---

## 8. Rollback

```bash
# Dienst stoppen — alle Daten bleiben erhalten
cd /opt/quantus-neko && docker compose down

# Proxy-Konfiguration zuruecknehmen
ls /opt/quantus-neko/backups/
#   nginx:
rm -f /etc/nginx/sites-enabled/neko.conf && nginx -t && systemctl reload nginx
#   Caddy:
cp /opt/quantus-neko/backups/Caddyfile.<stamp>.bak /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

# Image-Version zurueckrollen
sed -i 's/^NEKO_IMAGE_TAG=.*/NEKO_IMAGE_TAG=<alte-version>/' /opt/quantus-neko/.env
cd /opt/quantus-neko && docker compose up -d

# Frontend zurueckrollen: den PR in GitHub reverten, Netlify deployt automatisch
```

`docker compose down -v` **nur**, wenn auch das Browserprofil verschwinden
soll. Die Bind-Mounts unter `data/` bleiben davon unberuehrt — sie werden nur
durch `rm -rf /opt/quantus-neko/data` geloescht.

---

## 9. Stoerungssuche

| Symptom | Ursache | Vorgehen |
|---|---|---|
| Status-UI „Server ist nicht erreichbar" | Container aus, Proxy/DNS/TLS defekt | `docker compose ps`; `curl -fsS -o /dev/null -w '%{http_code}\n' https://neko.laurin-rusterholz.ch/` (GET — HEAD liefert 405) |
| Login scheitert mit „token not found - … Cookie auth" | Cookie-Auth am Server aktiv — mit dem Legacy-Client des 3.1.5-Images unvereinbar | `NEKO_SESSION_COOKIE_ENABLED` muss `false` sein (Standard dieses Repos); `cd /opt/quantus-neko && docker compose up -d` |
| Login-Maske erscheint, aber Bild bleibt schwarz | UDP 59000 zu (meist Hostinger-Panel-Firewall) | Panel-Firewall pruefen; `ss -uln \| grep 59000` |
| Chromium crasht wiederholt (SIGTRAP/core dumped) | `data/` gehoert root (Profil nicht beschreibbar) oder `pids_limit` zu knapp | Deploy-Skript (ohne `--smoke`) erneut ausfuehren — es setzt Eigentuemer/Rechte; `--smoke` prueft die Stabilitaet |
| `permission denied` fuer `sessions.json`/Downloads | `data/` gehoert root statt `1000:1000` | Deploy-Skript erneut ausfuehren; Smoke macht die Schreibprobe |
| Container startet, faellt aber staendig um | `/dev/shm` zu klein oder OOM | `docker compose logs neko`, `shm_size` und `mem_limit` pruefen |
| Muss sich staendig neu anmelden | Browser leert den (partitionierten) iframe-Speicher der neko-Origin | Knopf „↗ Neuer Tab" nutzen — dort unpartitionierter First-Party-Speicher |
| Downloads werden verweigert | Policy-Datei nicht gemountet | `docker compose exec -T neko cat /etc/chromium/policies/managed/policies.json` |
| Bild ruckelt | 1 vCPU am Limit | `NEKO_SCREEN` auf `1152x648@25` senken, `docker compose up -d` |
| Zertifikat wird nicht ausgestellt | Port 80 zu oder DNS falsch | `journalctl -u caddy -f` bzw. `certbot certificates` |
| Nach Reboot laeuft nichts | Docker nicht enabled | `systemctl enable --now docker` |
| Traefik liefert 404 fuer die Domain | Labels fehlen oder falsches Netz | `docker inspect -f '{{json .Config.Labels}}' quantus-neko`; `docker network inspect n8n_default` |
| Zertifikat kommt nicht | falscher Resolver-Name | `grep NEKO_TRAEFIK_CERTRESOLVER /opt/quantus-neko/.env` mit den Traefik-Flags vergleichen |
| Live-Seite zeigt einen alten Stand | HTML aus dem Cache | `curl -sSI https://management-xo2-pro.netlify.app/ \| grep -i x-quantus-build` |

Logs:
```bash
cd /opt/quantus-neko && docker compose logs -f --tail=200 neko
```

---

## 10. Dateien in diesem Repo

| Datei | Zweck |
|---|---|
| `neko/docker-compose.yml` | Container-Definition (gepinnte Version, Ports, Volumes, Limits, Healthcheck) |
| `neko/chromium-policies.json` | Chromium-Policies (Downloads, Lesezeichen, Dateidialoge, Cookies) |
| `neko/.env.example` | Vorlage — **ohne** echte Werte |
| `neko/docker-compose.traefik.yml` | Overlay mit den Traefik-Labels (bestehender n8n-Stack) |
| `neko/nginx-neko.conf` | Server-Block, wenn nginx bereits laeuft |
| `neko/Caddyfile.snippet` | Site-Block, wenn Caddy laeuft/installiert wird |
| `scripts/deploy-neko-hostinger.sh` | idempotentes Deploy/Update/Smoke-Skript |
| `public/index.html` | Quantus-App `#/browser` (iframe + Status-/Retry-UI, **kein Secret**) |
| `tests/quantus-browser-module.test.mjs` | statische Pruefungen (Secrets, Compose, Labels, UI, Regressionen) |
| `tests/neko-proxy-detect.test.sh` | Proxy-Erkennung gegen einen gestubbten Docker |
