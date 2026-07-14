# Quantus Browser — Setup & Runbook

Remote-Browser (neko) auf `neko.laurin-rusterholz.ch`, eingebettet als App
`#/browser` in Quantus.

Session-Tag: `quantus-browser-setup-3owr6a`
Datum: 2026-07-13

---

## Status auf einen Blick

| Teil | Status |
|------|--------|
| **TEIL B — Code (dieses Repo)** | ✅ **fertig** — implementiert, committet, gepusht |
| **TEIL A — VPS (via SSH)** | ⚠️ **muss auf dem VPS ausgefuehrt werden** (Runbook unten) |
| DNS `neko` -> `82.180.155.81` | ✅ **loest korrekt auf** (verifiziert) |

### Warum TEIL A nicht aus dieser Session heraus lief
Diese Claude-Code-Session laeuft in einer isolierten Cloud-Sandbox **ohne
SSH-Client, ohne VPS-Zugangsdaten und mit auf HTTPS/443 beschraenktem
Ausgangs-Netzwerk** (Ports 22/8080 zum VPS sind gefiltert, ein Agent-Proxy
blockt zudem `neko.laurin-rusterholz.ch` und die Firebase-RTDB per Allowlist mit
403). Der VPS-Teil kann daher nicht von hier ausgefuehrt oder verifiziert
werden. Alle noetigen Artefakte (Compose-Datei, Caddyfile, Befehle) liegen
fertig vor — bitte einmal auf dem VPS abarbeiten (ca. 5 Minuten).

---

## DNS-Check (erledigt)
```
getent hosts neko.laurin-rusterholz.ch  ->  82.180.155.81
python3 socket.gethostbyname(...)       ->  82.180.155.81
```
`neko.laurin-rusterholz.ch` loest **bereits korrekt** auf `82.180.155.81` auf.
Die Parking-Nameserver (ns1/ns2.dns-parking.com) liefern den A-Record aus —
**keine Nameserver-Umstellung noetig.** Caddy kann direkt ein Let's-Encrypt-Zertifikat ziehen.

---

## TEIL A — VPS-Runbook (auf dem VPS als root ausfuehren)

### 0. Secrets (aus sicherer Uebergabe / Chat-Report)
```
NEKO_USER_PASSWORD  = <USER-Passwort aus dem Chat-Report>   # == QUANTUS_BROWSER_PW in index.html
NEKO_ADMIN_PASSWORD = <ADMIN-Passwort aus dem Chat-Report>  # nur serverseitig, nie im Client
```

### 1. Docker pruefen / installieren
```bash
docker --version && docker compose version || curl -fsSL https://get.docker.com | sh
```

### 2. neko-Verzeichnis + Dateien anlegen
```bash
mkdir -p ~/neko && cd ~/neko
# docker-compose.yml und .env.example aus repo neko/ hierher kopieren
# (z.B. per scp, git clone oder direkt anlegen)
cp .env.example .env
# .env editieren: die zwei echten Passwoerter eintragen
nano .env
```
`~/neko/docker-compose.yml` und `.env.example` liegen im Repo unter `neko/`.

### 3. Starten + Health
```bash
cd ~/neko && docker compose up -d
docker compose ps
docker compose logs -f neko    # bis "serving at :8080" o.ae.
```

### 4. OS-Firewall (falls ufw aktiv)
```bash
ufw status
ufw allow 56000:56100/udp
ufw allow 80,443/tcp
```

### 5. Reverse Proxy + TLS
Falls bereits **Traefik/nginx** (fuer n8n) laeuft: neko als Route
`neko.laurin-rusterholz.ch -> localhost:8080` einhaengen.

Sonst **Caddy** (automatisches TLS):
```bash
apt-get install -y caddy          # oder offizielles Caddy-Repo
# repo-Datei neko/Caddyfile -> /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -f            # auf Zertifikatsausstellung warten
```
`/etc/caddy/Caddyfile`:
```
neko.laurin-rusterholz.ch {
    reverse_proxy localhost:8080
}
```

### 6. Verifizieren
```bash
curl -I https://neko.laurin-rusterholz.ch     # erwartet: HTTP/2 200, gueltiges TLS
```

### 7. Hostinger-Panel-Firewall (nur falls UDP dicht bleibt)
Bleiben die UDP-Ports 56000-56100 von aussen trotz `ufw allow` geschlossen
(WebRTC verbindet nicht / kein Bild), hat Hostinger vermutlich **eine
zusaetzliche Panel-Firewall vor dem OS**. Diese muss Laurin im **hPanel**
manuell freigeben (UDP 56000-56100 + TCP 80,443) — das ist der einzige Punkt,
der nicht aus dem OS heraus loesbar ist.

---

## Auto-Login + neko-UI ausblenden (neko v3)

Der Client baut die Embed-URL so (siehe `quantusBrowserSrc()` in `index.html`):
```
https://neko.laurin-rusterholz.ch/?usr=quantus&pwd=<USER_PW>&embed=1
```
- `usr` + `pwd` zusammen ⇒ **Auto-Join-Link**, keine Login-Maske.
- `embed=1` ⇒ blendet die **neko-Sidebar / Zusatzkomponenten** aus, Stream
  bleibt **interaktiv** (im Gegensatz zu `cast=1`, das nur zuschauen liesse).

Quelle: neko v3 „Customizing the UI" (Query-Parameter `usr`, `pwd`, `cast`,
`embed`, `volume`, `lang`).

**Sicherheitshinweis:** Das USER-Passwort steht im Auto-Login-Link und ist damit
im ausgelieferten `index.html` sichtbar (unvermeidbar bei „ohne Login-Maske" mit
neko-multiuser). Es ist bewusst das **eingeschraenkte User-Passwort**, nicht das
Admin-Passwort. Das **Admin-Passwort bleibt rein serverseitig** (nur in
`~/neko/.env`).

---

## TEIL B — Code (fertig, in diesem Repo)

In `public/index.html`:
1. Config-Konstanten `QUANTUS_BROWSER_URL` / `_USER` / `_PW` + `quantusBrowserSrc()`.
2. `viewBrowser()` — Browser-Bar (Titel „Quantus Browser", Neu laden, Vollbild)
   + iframe (`allow="autoplay; fullscreen; clipboard-read; clipboard-write"`,
   `background:#2B3134`, `height:calc(100vh - 96px)`, `border-radius:12px`,
   `loading="lazy"`).
3. Nav-/App-Eintrag `{key:"browser", …}` in `getAllApps()` — nutzt die
   bestehende `data-action="nav"`-Logik.
4. Dispatch `case "browser": html = viewBrowser(); break;`.
5. Delegation-Handler `browser-reload` (src neu setzen) + `browser-fullscreen`
   (`requestFullscreen()`).

Konventionen: single-file HTML, kein Build-Step, `data-action`-Delegation (keine
Inline-onclick), Design-Tokens, deutsche UI (Swiss, kein Eszett).

---

## Definition of Done

| Kriterium | Status |
|-----------|--------|
| `https://neko.laurin-rusterholz.ch` liefert Browser mit gueltigem TLS | ⏳ nach VPS-Runbook |
| Auto-Login aktiv, keine neko-UI sichtbar | ✅ Code fertig (`?usr&pwd&embed=1`), greift nach VPS-Start |
| Quantus-Modul: View + Nav + Lazy-Load + Reload + Vollbild | ✅ fertig |
| Konventionen eingehalten | ✅ |
| Branch | ✅ `claude/quantus-browser-setup-3owr6a` |
| Logbuch-Eintrag (Firebase RTDB) | ⚠️ RTDB aus Sandbox geblockt — Eintrag siehe unten, bitte in Quantus einfuegen |

---

## Logbuch-Eintrag (bitte in Quantus / PRJ-UCHWW einfuegen)

Die Firebase-RTDB ist aus dieser Sandbox nicht erreichbar (Proxy-Allowlist 403),
daher hier der fertige Eintrag zum Einfuegen ins Quantus-Logbuch:

> **Quantus Browser aufgesetzt** — Remote-Browser (neko, chromium) unter
> `neko.laurin-rusterholz.ch`. Code fertig: neue App `#/browser` (View, Nav,
> Lazy-Load, Reload, Vollbild), Auto-Login + ausgeblendete neko-UI via
> `?usr&pwd&embed=1`. VPS-Artefakte (docker-compose, Caddyfile, Runbook) liegen
> unter `neko/` + `docs/quantus-browser-setup.md`. Offen: VPS-Runbook einmal
> ausfuehren (Docker/Compose, ufw, Caddy-TLS) + ggf. Hostinger-Panel-Firewall
> fuer UDP 56000-56100. DNS `neko` -> `82.180.155.81` verifiziert.
