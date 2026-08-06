#!/usr/bin/env bash
#
# Quantus Browser — idempotentes Deploy/Update fuer den bestehenden
# Hostinger-KVM-1-VPS (Ubuntu 24.04).
#
#   bash scripts/deploy-neko-hostinger.sh            # pruefen + deployen
#   bash scripts/deploy-neko-hostinger.sh --check    # nur pruefen, nichts aendern
#   bash scripts/deploy-neko-hostinger.sh --update   # Image-Update + Neustart
#   bash scripts/deploy-neko-hostinger.sh --smoke    # nur Smoke-Tests
#
# Eigenschaften:
#   * idempotent — mehrfaches Ausfuehren ist unschaedlich
#   * nicht interaktiv, keine destruktiven Schritte ohne Vorwarnung
#   * sichert eine vorhandene Reverse-Proxy-Konfiguration vor jeder Aenderung
#   * installiert NIE Chromium auf dem Host (steckt im Container-Image)
#   * installiert Caddy NUR, wenn kein anderer Reverse Proxy laeuft
#   * Secrets ausschliesslich in /opt/quantus-neko/.env (Modus 600)
#
# Rollback-Befehle stehen am Ende der Ausgabe und in
# docs/quantus-browser-setup.md.

set -euo pipefail

# ── Konstanten ────────────────────────────────────────────────────────────────
APP_DIR="${QUANTUS_NEKO_DIR:-/opt/quantus-neko}"
DOMAIN="${QUANTUS_NEKO_DOMAIN:-neko.laurin-rusterholz.ch}"
BACKUP_DIR="${APP_DIR}/backups"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${REPO_DIR}/neko"
STAMP="$(date +%Y%m%d-%H%M%S)"

MODE="deploy"
case "${1:-}" in
  --check)  MODE="check" ;;
  --update) MODE="update" ;;
  --smoke)  MODE="smoke" ;;
  --help|-h)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  "") ;;
  *) echo "Unbekannte Option: $1 (--check | --update | --smoke)" >&2; exit 2 ;;
esac

# ── Ausgabe ───────────────────────────────────────────────────────────────────
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info()  { printf '  \033[36mi\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()   { fail "$*"; exit 1; }

FAILED=0
note_fail() { fail "$*"; FAILED=1; }

# ── 1. Vorabpruefungen ────────────────────────────────────────────────────────
step "1/8  Vorabpruefungen"

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (im hPanel-Terminal bist du root)."

if [ -r /etc/os-release ]; then
  . /etc/os-release
  info "System: ${PRETTY_NAME:-unbekannt}"
  case "${VERSION_ID:-}" in
    24.04|22.04) ok "Ubuntu-Version unterstuetzt" ;;
    *) warn "Getestet auf Ubuntu 24.04 — hier laeuft ${ID:-?} ${VERSION_ID:-?}. Fortsetzung auf eigene Verantwortung." ;;
  esac
fi

if command -v docker >/dev/null 2>&1; then
  ok "Docker vorhanden: $(docker --version)"
else
  note_fail "Docker fehlt. Installation: curl -fsSL https://get.docker.com | sh"
fi

if docker compose version >/dev/null 2>&1; then
  ok "Compose-Plugin vorhanden: $(docker compose version --short 2>/dev/null || docker compose version)"
else
  note_fail "docker compose (Plugin) fehlt. Installation: apt-get install -y docker-compose-plugin"
fi

# Chromium gehoert NICHT auf den Host.
if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
  warn "Auf dem Host ist Chromium installiert. Fuer Quantus wird es nicht gebraucht —"
  warn "der Remote-Browser laeuft ausschliesslich im neko-Container."
else
  ok "Kein Host-Chromium — korrekt, Chromium steckt im Container-Image"
fi

# DNS
RESOLVED="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -n1 || true)"
if [ -n "${RESOLVED}" ]; then
  ok "DNS ${DOMAIN} -> ${RESOLVED}"
else
  note_fail "DNS ${DOMAIN} loest nicht auf — ohne A-Record gibt es kein Zertifikat."
fi

# Freier Speicher
AVAIL_MB="$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}' || df -Pm / | awk 'NR==2{print $4}')"
if [ "${AVAIL_MB:-0}" -lt 4000 ]; then
  warn "Nur ${AVAIL_MB} MB frei. Das Image braucht ~2 GB, das Profil waechst mit."
else
  ok "Freier Speicher: ${AVAIL_MB} MB"
fi

TOTAL_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
info "RAM gesamt: ${TOTAL_MB} MB (KVM 1 = ~4 GB; mem_limit steht auf ${NEKO_MEM_LIMIT:-2600m})"

# ── 2. Reverse Proxy erkennen ─────────────────────────────────────────────────
step "2/8  Reverse Proxy erkennen"

PROXY="none"
detect_proxy() {
  if systemctl is-active --quiet nginx 2>/dev/null; then PROXY="nginx"; return; fi
  if systemctl is-active --quiet caddy 2>/dev/null; then PROXY="caddy"; return; fi
  if docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -Eqi '(^|/)traefik'; then PROXY="traefik-docker"; return; fi
  if docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -Eqi '(^|/)nginx|nginx-proxy|swag'; then PROXY="nginx-docker"; return; fi
  if docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -Eqi '(^|/)caddy'; then PROXY="caddy-docker"; return; fi
}
detect_proxy

# Wer haelt 80/443?
PORT_HOLDERS="$( (ss -tlnp 2>/dev/null || true) | awk '$4 ~ /:(80|443)$/ {print $0}')"
if [ -n "${PORT_HOLDERS}" ]; then
  info "Auf 80/443 lauscht bereits:"
  printf '%s\n' "${PORT_HOLDERS}" | sed 's/^/      /'
else
  info "Ports 80/443 sind frei"
fi

case "${PROXY}" in
  nginx)  ok "Aktiver Proxy: nginx (Host-Dienst) — neko bekommt einen zusaetzlichen Server-Block, Caddy wird NICHT installiert" ;;
  caddy)  ok "Aktiver Proxy: Caddy (Host-Dienst) — neko bekommt einen zusaetzlichen Site-Block" ;;
  traefik-docker|nginx-docker|caddy-docker)
          warn "Aktiver Proxy laeuft als Container (${PROXY}). Das Skript fasst ihn NICHT an."
          warn "Route ${DOMAIN} -> 127.0.0.1:${NEKO_HTTP_PORT:-8080} bitte dort selbst eintragen (Vorlage: neko/nginx-neko.conf)." ;;
  none)
    if [ -n "${PORT_HOLDERS}" ]; then
      warn "Kein bekannter Proxy-Dienst erkannt, aber 80/443 sind belegt — es wird nichts installiert."
      PROXY="unknown-listener"
    else
      info "Kein Reverse Proxy gefunden — Caddy wird installiert (kostenlos, automatisches Let's Encrypt)"
    fi ;;
esac

if [ "${MODE}" = "check" ]; then
  step "Ergebnis"
  [ "${FAILED}" -eq 0 ] && { ok "Alle Vorabpruefungen bestanden."; exit 0; }
  die "Vorabpruefungen fehlgeschlagen — siehe ✗ oben."
fi

[ "${FAILED}" -eq 0 ] || die "Vorabpruefungen fehlgeschlagen — Abbruch vor jeder Aenderung."

# ── 3. Verzeichnisse + Dateien ────────────────────────────────────────────────
if [ "${MODE}" != "smoke" ]; then
step "3/8  Verzeichnisse und Konfiguration"

mkdir -p "${APP_DIR}"/data/{profile,downloads,neko} "${BACKUP_DIR}"

# Vorhandene Compose-/Policy-Datei sichern, bevor sie ueberschrieben wird.
for f in docker-compose.yml chromium-policies.json; do
  if [ -f "${APP_DIR}/${f}" ] && ! cmp -s "${SRC_DIR}/${f}" "${APP_DIR}/${f}"; then
    cp -a "${APP_DIR}/${f}" "${BACKUP_DIR}/${f}.${STAMP}.bak"
    info "Backup: ${BACKUP_DIR}/${f}.${STAMP}.bak"
  fi
done

install -m 0644 "${SRC_DIR}/docker-compose.yml"      "${APP_DIR}/docker-compose.yml"
install -m 0644 "${SRC_DIR}/chromium-policies.json"  "${APP_DIR}/chromium-policies.json"
ok "docker-compose.yml und chromium-policies.json aktualisiert"

# .env: nur beim ersten Mal anlegen, danach nie ueberschreiben.
NEW_ENV=0
if [ ! -f "${APP_DIR}/.env" ]; then
  USER_PW="$(openssl rand -base64 24)"
  ADMIN_PW="$(openssl rand -base64 24)"
  PUBLIC_IP="${RESOLVED:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')}"
  [ -n "${PUBLIC_IP}" ] || die "Oeffentliche IP nicht ermittelbar — bitte NEKO_PUBLIC_IP in ${APP_DIR}/.env manuell setzen."
  umask 077
  cat > "${APP_DIR}/.env" <<EOF
# Erzeugt von deploy-neko-hostinger.sh am ${STAMP}. Nicht ins Git kopieren.
NEKO_USER_PASSWORD=${USER_PW}
NEKO_ADMIN_PASSWORD=${ADMIN_PW}
NEKO_PUBLIC_IP=${PUBLIC_IP}
NEKO_IMAGE_TAG=3.1.5
NEKO_HTTP_PORT=8080
NEKO_WEBRTC_PORT=59000
NEKO_SCREEN=1280x720@30
NEKO_MEM_LIMIT=2600m
NEKO_FILE_CHOOSER=true
EOF
  chmod 600 "${APP_DIR}/.env"
  NEW_ENV=1
  ok ".env neu erzeugt (Modus 600) mit zufaelligen Passwoertern"
else
  chmod 600 "${APP_DIR}/.env"
  ok ".env vorhanden — unveraendert uebernommen"
fi

# Rechte der persistenten Verzeichnisse: im Container laeuft User neko (1000).
chown -R 1000:1000 "${APP_DIR}/data"
chmod 700 "${APP_DIR}/data/profile" "${APP_DIR}/data/neko"
chmod 755 "${APP_DIR}/data/downloads"
ok "Persistente Verzeichnisse gehoeren 1000:1000"

# ── 4. Firewall ───────────────────────────────────────────────────────────────
step "4/8  Firewall"

WEBRTC_PORT="$(grep -E '^NEKO_WEBRTC_PORT=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || true)"
WEBRTC_PORT="${WEBRTC_PORT:-59000}"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80,443/tcp >/dev/null 2>&1 && ok "ufw: 80,443/tcp freigegeben" || warn "ufw: 80,443/tcp konnte nicht gesetzt werden"
  ufw allow "${WEBRTC_PORT}"/udp >/dev/null 2>&1 && ok "ufw: ${WEBRTC_PORT}/udp freigegeben" || warn "ufw: ${WEBRTC_PORT}/udp konnte nicht gesetzt werden"
  ufw allow "${WEBRTC_PORT}"/tcp >/dev/null 2>&1 && ok "ufw: ${WEBRTC_PORT}/tcp freigegeben" || warn "ufw: ${WEBRTC_PORT}/tcp konnte nicht gesetzt werden"
else
  info "ufw nicht aktiv — es wird keine Host-Firewall angefasst."
fi
warn "Hostinger hat zusaetzlich eine Panel-Firewall VOR dem Betriebssystem."
warn "Dort muessen offen sein: TCP 80, TCP 443, UDP ${WEBRTC_PORT}, TCP ${WEBRTC_PORT}."
warn "Ohne UDP ${WEBRTC_PORT} verbindet WebRTC nicht (kein Bild)."

# ── 5. Reverse Proxy einrichten ───────────────────────────────────────────────
step "5/8  Reverse Proxy einrichten"

case "${PROXY}" in
  nginx)
    TARGET="/etc/nginx/sites-available/neko.conf"
    if [ -f "${TARGET}" ]; then
      cp -a "${TARGET}" "${BACKUP_DIR}/nginx-neko.conf.${STAMP}.bak"
      info "Backup: ${BACKUP_DIR}/nginx-neko.conf.${STAMP}.bak"
    fi
    install -m 0644 "${SRC_DIR}/nginx-neko.conf" "${TARGET}"
    ln -sfn "${TARGET}" /etc/nginx/sites-enabled/neko.conf
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      ok "nginx-Server-Block aktiv und neu geladen"
      if command -v certbot >/dev/null 2>&1; then
        if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
          ok "Zertifikat fuer ${DOMAIN} existiert bereits"
        else
          info "Zertifikat anfordern:"
          info "  certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m admin@${DOMAIN#*.}"
          warn "Bewusst NICHT automatisch ausgefuehrt — certbot aendert die nginx-Konfiguration."
        fi
      else
        warn "certbot fehlt: apt-get install -y certbot python3-certbot-nginx"
      fi
    else
      cp -a "${BACKUP_DIR}/nginx-neko.conf.${STAMP}.bak" "${TARGET}" 2>/dev/null || rm -f "${TARGET}" /etc/nginx/sites-enabled/neko.conf
      die "nginx -t fehlgeschlagen — Aenderung zurueckgenommen, nginx unveraendert."
    fi ;;
  caddy)
    CADDYFILE="/etc/caddy/Caddyfile"
    cp -a "${CADDYFILE}" "${BACKUP_DIR}/Caddyfile.${STAMP}.bak"
    info "Backup: ${BACKUP_DIR}/Caddyfile.${STAMP}.bak"
    if grep -q "${DOMAIN}" "${CADDYFILE}"; then
      ok "Caddy kennt ${DOMAIN} bereits — keine Aenderung"
    else
      printf '\n' >> "${CADDYFILE}"
      cat "${SRC_DIR}/Caddyfile.snippet" >> "${CADDYFILE}"
      if caddy validate --config "${CADDYFILE}" >/dev/null 2>&1; then
        systemctl reload caddy
        ok "Caddy-Site-Block ergaenzt und neu geladen"
      else
        cp -a "${BACKUP_DIR}/Caddyfile.${STAMP}.bak" "${CADDYFILE}"
        die "caddy validate fehlgeschlagen — Caddyfile zurueckgesetzt."
      fi
    fi ;;
  none)
    info "Installiere Caddy aus dem offiziellen Repository…"
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y caddy >/dev/null
    cp -a /etc/caddy/Caddyfile "${BACKUP_DIR}/Caddyfile.${STAMP}.bak"
    cat "${SRC_DIR}/Caddyfile.snippet" > /etc/caddy/Caddyfile
    caddy validate --config /etc/caddy/Caddyfile >/dev/null
    systemctl enable --now caddy
    systemctl reload caddy
    ok "Caddy installiert und aktiv (TLS wird automatisch ausgestellt)" ;;
  *)
    warn "Proxy wird nicht automatisch konfiguriert (${PROXY})."
    warn "Bitte ${DOMAIN} manuell auf 127.0.0.1:8080 routen, Vorlage: neko/nginx-neko.conf" ;;
esac

# ── 6. Container starten ──────────────────────────────────────────────────────
step "6/8  Container starten"

cd "${APP_DIR}"
if [ "${MODE}" = "update" ]; then
  docker compose pull
  ok "Image auf die in .env gepinnte Version gezogen"
fi
docker compose config >/dev/null || die "docker compose config ungueltig — nichts gestartet."
docker compose up -d
ok "docker compose up -d ausgefuehrt"

printf '  '
for _ in $(seq 1 60); do
  STATE="$(docker inspect -f '{{.State.Health.Status}}' quantus-neko 2>/dev/null || echo starting)"
  [ "${STATE}" = "healthy" ] && break
  printf '.'
  sleep 5
done
printf '\n'
STATE="$(docker inspect -f '{{.State.Health.Status}}' quantus-neko 2>/dev/null || echo unknown)"
if [ "${STATE}" = "healthy" ]; then ok "Container-Health: healthy"; else note_fail "Container-Health: ${STATE} — 'docker compose logs neko' pruefen"; fi
fi  # MODE != smoke

# ── 7. Smoke-Tests ────────────────────────────────────────────────────────────
step "7/8  Smoke-Tests"

cd "${APP_DIR}"
docker compose ps

# Chromium-Version AUS DEM CONTAINER — Beleg, dass kein Host-Chromium noetig ist.
CHROMIUM_VER="$(docker compose exec -T neko /usr/bin/chromium --version 2>/dev/null | tr -d '\r' || true)"
if [ -n "${CHROMIUM_VER}" ]; then
  ok "Chromium im Container: ${CHROMIUM_VER}"
else
  note_fail "Chromium-Version im Container nicht auslesbar"
fi

NEKO_VER="$(docker compose exec -T neko /usr/bin/neko --version 2>/dev/null | head -n1 | tr -d '\r' || true)"
[ -n "${NEKO_VER}" ] && info "neko: ${NEKO_VER}"
info "Image (gepinnt): $(docker inspect -f '{{.Config.Image}}' quantus-neko 2>/dev/null || echo '?')"

# Lokaler HTTP-Check hinter dem Proxy vorbei.
if curl -fsS -o /dev/null -m 10 "http://127.0.0.1:${NEKO_HTTP_PORT:-8080}/"; then
  ok "neko antwortet lokal auf 127.0.0.1:${NEKO_HTTP_PORT:-8080}"
else
  note_fail "neko antwortet lokal NICHT — 'docker compose logs neko' pruefen"
fi

# Der interne Port darf von aussen nicht erreichbar sein.
if ss -tln 2>/dev/null | grep -qE "0\.0\.0\.0:${NEKO_HTTP_PORT:-8080}|\*:${NEKO_HTTP_PORT:-8080}"; then
  note_fail "Port ${NEKO_HTTP_PORT:-8080} lauscht auf allen Interfaces — muss 127.0.0.1 sein!"
else
  ok "HTTP-Port nur an 127.0.0.1 gebunden"
fi

# TLS von aussen.
if curl -fsSI -m 20 "https://${DOMAIN}" >/dev/null 2>&1; then
  ok "HTTPS https://${DOMAIN} liefert eine Antwort mit gueltigem Zertifikat"
  curl -sSI -m 20 "https://${DOMAIN}" | head -n 1 | sed 's/^/      /'
  echo | openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" 2>/dev/null \
    | openssl x509 -noout -issuer -dates 2>/dev/null | sed 's/^/      /' || true
else
  note_fail "HTTPS https://${DOMAIN} noch nicht erfolgreich (Zertifikat, DNS oder Proxy pruefen)"
fi

# WebRTC-Port.
WEBRTC_PORT="$(grep -E '^NEKO_WEBRTC_PORT=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2 || true)"
WEBRTC_PORT="${WEBRTC_PORT:-59000}"
if ss -uln 2>/dev/null | grep -q ":${WEBRTC_PORT}"; then
  ok "WebRTC UDP ${WEBRTC_PORT} lauscht"
else
  note_fail "WebRTC UDP ${WEBRTC_PORT} lauscht nicht"
fi
info "Von aussen pruefbar nur mit einem zweiten Host: nc -vzu ${DOMAIN} ${WEBRTC_PORT}"

# Persistenz.
for d in profile downloads neko; do
  if [ -d "${APP_DIR}/data/${d}" ]; then
    ok "Persistent: ${APP_DIR}/data/${d} ($(stat -c '%U:%G %a' "${APP_DIR}/data/${d}"))"
  else
    note_fail "Fehlt: ${APP_DIR}/data/${d}"
  fi
done

# Autostart nach Reboot.
if [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' quantus-neko 2>/dev/null)" = "unless-stopped" ] \
   && systemctl is-enabled --quiet docker 2>/dev/null; then
  ok "Autostart nach Reboot aktiv (restart=unless-stopped + docker.service enabled)"
else
  note_fail "Autostart unsicher — 'systemctl enable docker' pruefen"
fi

# ── 8. Abschluss ──────────────────────────────────────────────────────────────
step "8/8  Ergebnis"

if [ "${MODE}" != "smoke" ] && [ "${NEW_ENV:-0}" = "1" ]; then
  echo
  warn "EINMALIGE AUSGABE — Zugangsdaten fuer den neko-Login im Quantus-iframe:"
  echo "      Benutzer: quantus"
  echo "      Passwort: $(grep -E '^NEKO_USER_PASSWORD=' "${APP_DIR}/.env" | cut -d= -f2-)"
  warn "Bitte im Quantus-Passwortmanager ablegen. Erneut auslesbar mit:"
  echo "      grep NEKO_USER_PASSWORD ${APP_DIR}/.env"
  echo
fi

cat <<EOF

  Rollback:
    cd ${APP_DIR} && docker compose down            # Dienst stoppen (Daten bleiben)
    ls ${BACKUP_DIR}                                # gesicherte Proxy-/Compose-Dateien
    cp ${BACKUP_DIR}/<datei>.bak /etc/nginx/sites-available/neko.conf   # bzw. /etc/caddy/Caddyfile
    nginx -t && systemctl reload nginx              # bzw. caddy validate + systemctl reload caddy
    rm -f /etc/nginx/sites-enabled/neko.conf        # Route wieder entfernen
    docker compose down -v                          # NUR wenn auch das Browserprofil weg soll

  Version zurueckrollen:
    sed -i 's/^NEKO_IMAGE_TAG=.*/NEKO_IMAGE_TAG=<alte-version>/' ${APP_DIR}/.env
    cd ${APP_DIR} && docker compose up -d

EOF

if [ "${FAILED}" -eq 0 ]; then
  ok "Fertig — alle Pruefungen bestanden."
else
  fail "Fertig, aber mit offenen Punkten (siehe ✗ oben)."
  exit 1
fi
