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
#   * erkennt den vorhandenen Reverse Proxy (Traefik im Docker, nginx, Caddy)
#     und waehlt die passende Konfiguration
#   * fasst FREMDE Stacks nie an: kein Restart, kein down, keine Aenderung an
#     deren Compose-Dateien
#   * installiert NIE Chromium auf dem Host (steckt im Container-Image)
#   * installiert Caddy NUR, wenn gar kein Reverse Proxy laeuft
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
# Beim Laden als Bibliothek (Tests) erbt das Skript die Argumente des Aufrufers
# — die duerfen hier nicht als Optionen missverstanden werden.
if [ "${NEKO_DEPLOY_LIB_ONLY:-0}" != "1" ]; then
  case "${1:-}" in
    --check)  MODE="check" ;;
    --update) MODE="update" ;;
    --smoke)  MODE="smoke" ;;
    --help|-h)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    "") ;;
    *) echo "Unbekannte Option: $1 (--check | --update | --smoke)" >&2; exit 2 ;;
  esac
fi

# ── Ausgabe ───────────────────────────────────────────────────────────────────
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info()  { printf '  \033[36mi\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()   { fail "$*"; exit 1; }

FAILED=0
note_fail() { fail "$*"; FAILED=1; }

# Liest einen Wert aus der serverseitigen .env, ohne sie zu sourcen (die Datei
# enthaelt Passwoerter — die sollen nicht in der Shell-Umgebung landen).
env_get() {
  [ -f "${APP_DIR}/.env" ] || return 0
  sed -n "s/^$1=//p" "${APP_DIR}/.env" | head -n1
}

# Setzt einen Schluessel in der .env — vorhandenen Wert ersetzen, sonst anhaengen.
# Beruehrt keine anderen Zeilen und ist damit beliebig oft wiederholbar.
env_set() {
  local key="$1" value="$2" file="${APP_DIR}/.env"
  touch "${file}"; chmod 600 "${file}"
  if grep -q "^${key}=" "${file}"; then
    local current; current="$(sed -n "s/^${key}=//p" "${file}" | head -n1)"
    [ "${current}" = "${value}" ] && return 0
    local tmp; tmp="$(mktemp "${APP_DIR}/.env.XXXXXX")"; chmod 600 "${tmp}"
    awk -v k="${key}" -v v="${value}" \
      'index($0, k "=") == 1 { print k "=" v; next } { print }' "${file}" > "${tmp}"
    mv "${tmp}" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
  chmod 600 "${file}"
}

# UID/GID des Container-Users "neko" im gepinnten Image. Nur numerisch; per
# NEKO_DATA_UID/NEKO_DATA_GID in der .env ueberschreibbar, falls ein kuenftiges
# Image einen anderen User mitbringt.
data_uid() { local v; v="$(env_get NEKO_DATA_UID)"; printf '%s' "${v:-1000}"; }
data_gid() { local v; v="$(env_get NEKO_DATA_GID)"; printf '%s' "${v:-1000}"; }

# Bringt ein gemountetes Datenverzeichnis idempotent in den Besitz des
# Container-Users. NIE destruktiv: ausschliesslich mkdir/chown/chmod, kein
# Loeschen, kein Umbenennen — bestehende Profile/Downloads bleiben erhalten.
#
# Hintergrund (Live-Befund): die Verzeichnisse entstanden frueher als
# root:root — damit konnte UID 1000 im Container weder sessions.json noch
# Downloads schreiben, und Chromium crashte im Loop (SIGTRAP), weil sein
# --user-data-dir nicht beschreibbar war.
ensure_data_dir() {
  local dir="$1" uid="$2" gid="$3"
  mkdir -p "${dir}"
  # chown nur, wenn tatsaechlich etwas falsch gehoert — so bleibt der Lauf
  # auch mit einem grossen Chromium-Profil billig.
  if find "${dir}" \( ! -uid "${uid}" -o ! -gid "${gid}" \) -print -quit 2>/dev/null | grep -q .; then
    chown -R "${uid}:${gid}" "${dir}"
  fi
  # root legte die Verzeichnisse teils mit 700 an — nach dem chown braucht der
  # Eigentuemer in jedem Fall Vollzugriff auf das Verzeichnis selbst.
  chmod u+rwX "${dir}"
}

PROXY="none"
TRAEFIK_CID=""
TRAEFIK_NETWORKS=""
TRAEFIK_NETWORK=""
TRAEFIK_RESOLVER=""
TRAEFIK_EP_HTTPS=""
TRAEFIK_EP_HTTP=""

# Traefik-Container finden: Image heisst traefik bzw. <registry>/traefik.
find_traefik() {
  docker ps --format '{{.ID}}\t{{.Image}}' 2>/dev/null \
    | awk -F'\t' '$2 ~ /(^|\/)traefik(:|@|$)/ {print $1; exit}'
}

# Alles, woraus Traefik seine statische Konfiguration beziehen kann: Startbefehl,
# Umgebungsvariablen und Labels. Reicht fuer EntryPoints und ACME-Resolver, wenn
# Traefik per CLI-Flags oder ENV konfiguriert ist (der uebliche Docker-Fall).
traefik_config_blob() {
  [ -n "${TRAEFIK_CID}" ] || return 0
  {
    docker inspect -f '{{json .Config.Cmd}}'    "${TRAEFIK_CID}" 2>/dev/null || true
    docker inspect -f '{{json .Args}}'          "${TRAEFIK_CID}" 2>/dev/null || true
    docker inspect -f '{{json .Config.Env}}'    "${TRAEFIK_CID}" 2>/dev/null || true
    docker inspect -f '{{json .Config.Labels}}' "${TRAEFIK_CID}" 2>/dev/null || true
  } | tr 'A-Z' 'a-z' | tr ',' '\n'
}

inspect_traefik() {
  TRAEFIK_NETWORKS="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${TRAEFIK_CID}" 2>/dev/null || true)"
  local blob; blob="$(traefik_config_blob)"

  # ACME-Resolver: --certificatesresolvers.<name>.acme...  bzw.
  # TRAEFIK_CERTIFICATESRESOLVERS_<NAME>_ACME_...
  TRAEFIK_RESOLVER="$(printf '%s' "${blob}" \
    | grep -oE 'certificatesresolvers[._-]+[a-z0-9_-]+[._-]+acme' \
    | head -n1 | sed -E 's/^certificatesresolvers[._-]+//; s/[._-]+acme$//' || true)"

  # EntryPoints: --entrypoints.<name>.address=:443
  TRAEFIK_EP_HTTPS="$(printf '%s' "${blob}" \
    | grep -oE 'entrypoints[._-]+[a-z0-9_-]+[._-]+address="?:443' \
    | head -n1 | sed -E 's/^entrypoints[._-]+//; s/[._-]+address.*$//' || true)"
  TRAEFIK_EP_HTTP="$(printf '%s' "${blob}" \
    | grep -oE 'entrypoints[._-]+[a-z0-9_-]+[._-]+address="?:80($|[^0-9])' \
    | head -n1 | sed -E 's/^entrypoints[._-]+//; s/[._-]+address.*$//' || true)"

  # Aus .env vorbelegte Werte gewinnen, wenn nichts erkannt wurde.
  TRAEFIK_RESOLVER="${TRAEFIK_RESOLVER:-$(env_get NEKO_TRAEFIK_CERTRESOLVER)}"
  TRAEFIK_EP_HTTPS="${TRAEFIK_EP_HTTPS:-$(env_get NEKO_TRAEFIK_ENTRYPOINT_HTTPS)}"
  TRAEFIK_EP_HTTP="${TRAEFIK_EP_HTTP:-$(env_get NEKO_TRAEFIK_ENTRYPOINT_HTTP)}"
  TRAEFIK_RESOLVER="${TRAEFIK_RESOLVER:-mytlschallenge}"
  TRAEFIK_EP_HTTPS="${TRAEFIK_EP_HTTPS:-websecure}"
  TRAEFIK_EP_HTTP="${TRAEFIK_EP_HTTP:-web}"

  # Netz: bevorzugt das in der .env hinterlegte, sonst das erste Nicht-Bridge-
  # Netz von Traefik (bei n8n typischerweise n8n_default).
  local wanted; wanted="$(env_get NEKO_TRAEFIK_NETWORK)"
  if [ -n "${wanted}" ] && printf '%s' "${TRAEFIK_NETWORKS}" | tr ' ' '\n' | grep -qx "${wanted}"; then
    TRAEFIK_NETWORK="${wanted}"
  else
    TRAEFIK_NETWORK="$(printf '%s' "${TRAEFIK_NETWORKS}" | tr ' ' '\n' | grep -v '^bridge$' | grep -v '^$' | head -n1 || true)"
  fi
}

detect_proxy() {
  TRAEFIK_CID="$(find_traefik)"
  if [ -n "${TRAEFIK_CID}" ]; then PROXY="traefik-docker"; inspect_traefik; return; fi
  if systemctl is-active --quiet nginx 2>/dev/null; then PROXY="nginx"; return; fi
  if systemctl is-active --quiet caddy 2>/dev/null; then PROXY="caddy"; return; fi
  if docker ps --format '{{.Image}}' 2>/dev/null | grep -Eqi '(^|/)(nginx|nginx-proxy|swag)(:|@|$)'; then PROXY="nginx-docker"; return; fi
  if docker ps --format '{{.Image}}' 2>/dev/null | grep -Eqi '(^|/)caddy(:|@|$)'; then PROXY="caddy-docker"; return; fi
}

# Das Profil-Volume ueberdeckt /home/neko/.config/chromium — und damit die
# Voreinstellungen, die das Image dort ablegt (Home-Knopf, Lesezeichenleiste).
# Bei einem Bind-Mount kopiert Docker den Image-Inhalt NICHT ins leere
# Verzeichnis (anders als bei einem benannten Volume), die Defaults fehlen also
# beim ersten Start. Sie werden deshalb einmalig aus dem Image geholt.
# Idempotent und nicht destruktiv: ein vorhandenes Profil bleibt unberuehrt.
seed_chromium_preferences() {
  local uid="$1" gid="$2" tag img target
  target="${APP_DIR}/data/profile/Default/Preferences"
  [ -e "${target}" ] && return 1
  tag="$(env_get NEKO_IMAGE_TAG)"; tag="${tag:-3.1.5}"
  img="ghcr.io/m1k1o/neko/chromium:${tag}"
  docker image inspect "${img}" >/dev/null 2>&1 || return 1
  mkdir -p "${APP_DIR}/data/profile/Default"
  if docker run --rm --network none --entrypoint cat "${img}" \
       /home/neko/.config/chromium/Default/Preferences > "${target}.tmp" 2>/dev/null \
     && [ -s "${target}.tmp" ]; then
    mv "${target}.tmp" "${target}"
    chown "${uid}:${gid}" "${target}" "${APP_DIR}/data/profile/Default" 2>/dev/null || true
    return 0
  fi
  rm -f "${target}.tmp"
  return 1
}

# ── Anmelde-Probe fuer die Smoke-Tests ────────────────────────────────────────
# JSON-String mit Escaping, damit Sonderzeichen im Passwort die Anfrage nicht
# zerlegen. Der Wert wird nirgends ausgegeben.
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }

# Meldet die Probe-Sitzung wieder ab. Der Token geht ueber eine
# curl-Konfigurationsdatei (Modus 600) statt ueber die Kommandozeile — sonst
# stuende er in der Prozessliste des Hosts.
neko_logout() {
  local port="$1" token="$2" cfg
  [ -n "${token}" ] || return 0
  cfg="$(mktemp)"; chmod 600 "${cfg}"
  printf 'header = "Authorization: Bearer %s"\n' "${token}" > "${cfg}"
  curl -sS -o /dev/null -m 10 -K "${cfg}" -X POST \
    "http://127.0.0.1:${port}/api/logout" >/dev/null 2>&1 || true
  rm -f "${cfg}"
}

# Spielt die Anmeldung wirklich durch — die Konfiguration allein beweist nicht,
# dass der laufende Container sie auch uebernommen hat. Gibt genau ein Wort aus:
#   token       — Anmeldung erfolgreich UND fuer den mitgelieferten Client
#                 brauchbar (Token steht im Antwort-Body)
#   cookie      — Anmeldung erfolgreich, aber nur per Cookie: der Client
#                 scheitert dann mit "token not found …" (der Live-Fehler)
#   denied      — Passwort passt nicht zum laufenden Container
#   unreachable — neko antwortet lokal gar nicht
# Das Passwort geht ausschliesslich ueber stdin: nie als Argument
# (Prozessliste) und nie in eine Ausgabe.
neko_login_probe() {
  local port="$1" user="$2" pass="$3" body code token result
  body="$(mktemp)"; chmod 600 "${body}"
  code="$(printf '{"username":%s,"password":%s}' "$(json_str "${user}")" "$(json_str "${pass}")" \
    | curl -sS -o "${body}" -w '%{http_code}' -m 10 \
        -H 'Content-Type: application/json' --data-binary @- \
        "http://127.0.0.1:${port}/api/login" 2>/dev/null)" || true
  case "${code:-000}" in
    200)
      if grep -q '"token"' "${body}" 2>/dev/null; then
        token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${body}")"
        neko_logout "${port}" "${token}"
        result="token"
      else
        result="cookie"
      fi ;;
    401|403) result="denied" ;;
    000|"")  result="unreachable" ;;
    *)       result="http-${code}" ;;
  esac
  rm -f "${body}"
  printf '%s' "${result}"
}

# Tests laden nur die Funktionen, ohne dass das Skript etwas ausfuehrt:
#   NEKO_DEPLOY_LIB_ONLY=1 source scripts/deploy-neko-hostinger.sh
if [ "${NEKO_DEPLOY_LIB_ONLY:-0}" = "1" ]; then
  return 0
fi

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

RESOLVED="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -n1 || true)"
if [ -n "${RESOLVED}" ]; then
  ok "DNS ${DOMAIN} -> ${RESOLVED}"
else
  note_fail "DNS ${DOMAIN} loest nicht auf — ohne A-Record gibt es kein Zertifikat."
fi

AVAIL_MB="$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}' || df -Pm / | awk 'NR==2{print $4}')"
if [ "${AVAIL_MB:-0}" -lt 4000 ]; then
  warn "Nur ${AVAIL_MB} MB frei. Das Image braucht ~2 GB, das Profil waechst mit."
else
  ok "Freier Speicher: ${AVAIL_MB} MB"
fi

TOTAL_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
info "RAM gesamt: ${TOTAL_MB} MB (KVM 1 = ~4 GB; mem_limit siehe .env)"

# ── 2. Reverse Proxy erkennen ─────────────────────────────────────────────────
step "2/8  Reverse Proxy erkennen"

detect_proxy

PORT_HOLDERS="$( (ss -tlnp 2>/dev/null || true) | awk '$4 ~ /:(80|443)$/ {print $0}')"
if [ -n "${PORT_HOLDERS}" ]; then
  info "Auf 80/443 lauscht bereits:"
  printf '%s\n' "${PORT_HOLDERS}" | sed 's/^/      /'
else
  info "Ports 80/443 sind frei"
fi

case "${PROXY}" in
  traefik-docker)
    ok "Aktiver Proxy: Traefik im Docker ($(docker inspect -f '{{.Config.Image}}' "${TRAEFIK_CID}" 2>/dev/null || echo '?'), Container $(docker inspect -f '{{.Name}}' "${TRAEFIK_CID}" 2>/dev/null | sed 's|^/||'))"
    info "Traefik-Netze: ${TRAEFIK_NETWORKS:-keine}"
    if [ -n "${TRAEFIK_NETWORK}" ]; then
      ok "neko wird an das vorhandene Netz \"${TRAEFIK_NETWORK}\" angehaengt (kein neues Netz)"
    else
      note_fail "Kein gemeinsames Traefik-Netz gefunden — bitte NEKO_TRAEFIK_NETWORK in ${APP_DIR}/.env setzen."
    fi
    ok "ACME-Resolver: ${TRAEFIK_RESOLVER}   EntryPoints: ${TRAEFIK_EP_HTTP} / ${TRAEFIK_EP_HTTPS}"
    if printf '%s' "$(traefik_config_blob)" | grep -q 'exposedbydefault=\{0,1\}"\{0,1\}false'; then
      info "exposedByDefault=false erkannt — neko setzt traefik.enable=true"
    fi
    info "Der Traefik- und der n8n-Stack werden NICHT angefasst (kein Restart, keine Konfigaenderung)."
    ;;
  nginx)  ok "Aktiver Proxy: nginx (Host-Dienst) — neko bekommt einen zusaetzlichen Server-Block, Caddy wird NICHT installiert" ;;
  caddy)  ok "Aktiver Proxy: Caddy (Host-Dienst) — neko bekommt einen zusaetzlichen Site-Block" ;;
  nginx-docker|caddy-docker)
    warn "Aktiver Proxy laeuft als Container (${PROXY}). Das Skript fasst ihn NICHT an."
    warn "Route ${DOMAIN} -> quantus-neko:8080 bitte dort selbst eintragen (Vorlage: neko/nginx-neko.conf)." ;;
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
  if [ "${FAILED}" -eq 0 ]; then
    ok "Alle Vorabpruefungen bestanden."
    [ "${PROXY}" = "traefik-docker" ] && info "Deploy wuerde die Traefik-Labels aus neko/docker-compose.traefik.yml aktivieren."
    exit 0
  fi
  die "Vorabpruefungen fehlgeschlagen — siehe ✗ oben."
fi

[ "${FAILED}" -eq 0 ] || die "Vorabpruefungen fehlgeschlagen — Abbruch vor jeder Aenderung."

# ── 3. Verzeichnisse + Dateien ────────────────────────────────────────────────
if [ "${MODE}" != "smoke" ]; then
step "3/8  Verzeichnisse und Konfiguration"

mkdir -p "${APP_DIR}"/data/{profile,downloads,neko} "${BACKUP_DIR}"

# Eigentuemer/Rechte der Mounts: Chromium, das Datei-Transfer-Ziel und
# sessions.json laufen im Container unter UID/GID 1000 ("neko").
for d in profile downloads neko; do
  ensure_data_dir "${APP_DIR}/data/${d}" "$(data_uid)" "$(data_gid)"
done
ok "data/{profile,downloads,neko} gehoeren $(data_uid):$(data_gid) (idempotent gesetzt, nichts geloescht)"

# Voreinstellungen aus dem Image nur ins NOCH LEERE Profil nachziehen — der
# Bind-Mount verdeckt sie sonst (Home-Knopf, Lesezeichenleiste).
if seed_chromium_preferences "$(data_uid)" "$(data_gid)"; then
  info "Chromium-Voreinstellungen aus dem Image ins leere Profil uebernommen"
fi

for f in docker-compose.yml docker-compose.traefik.yml chromium-policies.json; do
  if [ -f "${APP_DIR}/${f}" ] && ! cmp -s "${SRC_DIR}/${f}" "${APP_DIR}/${f}"; then
    cp -a "${APP_DIR}/${f}" "${BACKUP_DIR}/${f}.${STAMP}.bak"
    info "Backup: ${BACKUP_DIR}/${f}.${STAMP}.bak"
  fi
  install -m 0644 "${SRC_DIR}/${f}" "${APP_DIR}/${f}"
done
ok "Compose-Dateien und Chromium-Policies aktualisiert"

# .env: Passwoerter nur beim allerersten Mal erzeugen, danach nie ueberschreiben.
NEW_ENV=0
if [ ! -f "${APP_DIR}/.env" ] || ! grep -q '^NEKO_USER_PASSWORD=.' "${APP_DIR}/.env"; then
  PUBLIC_IP="${RESOLVED:-$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')}"
  [ -n "${PUBLIC_IP}" ] || die "Oeffentliche IP nicht ermittelbar — bitte NEKO_PUBLIC_IP in ${APP_DIR}/.env manuell setzen."
  umask 077
  touch "${APP_DIR}/.env"; chmod 600 "${APP_DIR}/.env"
  env_set NEKO_USER_PASSWORD  "$(openssl rand -base64 24)"
  env_set NEKO_ADMIN_PASSWORD "$(openssl rand -base64 24)"
  env_set NEKO_PUBLIC_IP      "${PUBLIC_IP}"
  NEW_ENV=1
  ok ".env erzeugt (Modus 600) mit zufaelligen Passwoertern"
else
  chmod 600 "${APP_DIR}/.env"
  ok ".env vorhanden — Passwoerter unveraendert uebernommen"
fi

# Nicht-geheime Defaults nur ergaenzen, wenn sie fehlen.
for kv in "NEKO_IMAGE_TAG=3.1.5" "NEKO_HTTP_PORT=8080" "NEKO_WEBRTC_PORT=59000" \
          "NEKO_SCREEN=1280x720@30" "NEKO_MEM_LIMIT=2600m" "NEKO_FILE_CHOOSER=true" \
          "NEKO_DOMAIN=${DOMAIN}" "COMPOSE_PROJECT_NAME=quantus-neko"; do
  key="${kv%%=*}"
  [ -n "$(env_get "${key}")" ] || env_set "${key}" "${kv#*=}"
done

# Proxy-abhaengige Compose-Auswahl. Wird bei jedem Lauf neu gesetzt, damit ein
# Proxy-Wechsel nicht in einer falschen COMPOSE_FILE haengen bleibt.
if [ "${PROXY}" = "traefik-docker" ]; then
  env_set NEKO_TRAEFIK_NETWORK          "${TRAEFIK_NETWORK}"
  env_set NEKO_TRAEFIK_CERTRESOLVER     "${TRAEFIK_RESOLVER}"
  env_set NEKO_TRAEFIK_ENTRYPOINT_HTTPS "${TRAEFIK_EP_HTTPS}"
  env_set NEKO_TRAEFIK_ENTRYPOINT_HTTP  "${TRAEFIK_EP_HTTP}"
  env_set COMPOSE_FILE                  "docker-compose.yml:docker-compose.traefik.yml"
  ok "Compose-Overlay fuer Traefik aktiviert (COMPOSE_FILE in .env)"
else
  env_set COMPOSE_FILE "docker-compose.yml"
  ok "Compose ohne Proxy-Overlay (COMPOSE_FILE in .env)"
fi

# ── 4. Firewall ───────────────────────────────────────────────────────────────
step "4/8  Firewall"

WEBRTC_PORT="$(env_get NEKO_WEBRTC_PORT)"; WEBRTC_PORT="${WEBRTC_PORT:-59000}"

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
  traefik-docker)
    # Traefik entdeckt neko selbst ueber den Docker-Provider, sobald der
    # Container mit den Labels im gemeinsamen Netz laeuft. Es gibt hier also
    # bewusst NICHTS zu installieren, nichts zu schreiben und nichts neu zu
    # starten — genau das ist der Punkt bei einem Label-basierten Setup.
    docker network inspect "${TRAEFIK_NETWORK}" >/dev/null 2>&1 \
      || die "Netz \"${TRAEFIK_NETWORK}\" existiert nicht — Abbruch vor dem Start."
    ok "Netz \"${TRAEFIK_NETWORK}\" existiert und wird als extern eingebunden"
    docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${TRAEFIK_CID}" \
      | tr ' ' '\n' | grep -qx "${TRAEFIK_NETWORK}" \
      || die "Traefik haengt nicht an \"${TRAEFIK_NETWORK}\" — Route waere tot."
    ok "Traefik haengt am selben Netz — Route wird ueber Labels aufgebaut"
    info "Keine Datei ausserhalb von ${APP_DIR} wird veraendert; n8n/Traefik laufen unberuehrt weiter."
    ;;
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
    warn "Bitte ${DOMAIN} manuell auf quantus-neko:8080 routen, Vorlage: neko/nginx-neko.conf" ;;
esac

# ── 6. Container starten ──────────────────────────────────────────────────────
step "6/8  Container starten"

cd "${APP_DIR}"
docker compose config >/dev/null || die "docker compose config ungueltig — nichts gestartet."
ok "Compose-Konfiguration validiert ($(env_get COMPOSE_FILE))"

if [ "${MODE}" = "update" ]; then
  docker compose pull
  ok "Image auf die in .env gepinnte Version gezogen"
fi
docker compose up -d
ok "docker compose up -d ausgefuehrt (nur Projekt quantus-neko)"

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
info "Image (gepinnt): $(docker inspect -f '{{.Config.Image}}' quantus-neko 2>/dev/null || echo '?')"

# Chromium muss nicht nur starten, sondern stabil LAUFEN. Live-Befund: mit
# root-eigenem Profil crashte Chromium im Loop (SIGTRAP/core dumped) und
# supervisord startete es endlos neu — die Version oben war trotzdem lesbar.
# Zwei Stichproben im Abstand von 15 s muessen denselben Prozess zeigen.
# Kommt ohne pgrep/ps aus (im Image nicht zugesichert): /proc reicht.
chromium_pid() {
  docker compose exec -T neko sh -c \
    'for f in /proc/[0-9]*/comm; do c="$(cat "$f" 2>/dev/null)" || continue;
       case "$c" in chromium*) p="${f#/proc/}"; printf "%s\n" "${p%%/*}";; esac;
     done | sort -n | head -n1' 2>/dev/null | tr -d '\r'
}
PID_A="$(chromium_pid)"
if [ -z "${PID_A}" ]; then
  note_fail "Kein laufender Chromium-Prozess im Container — 'docker compose logs neko' pruefen"
else
  # Abstand der beiden Stichproben. Nur fuer die Regressionstests kuerzbar
  # (NEKO_SMOKE_GAP=0) — auf dem VPS bleibt es bei 15 s, sonst wuerde eine
  # Neustartschleife zwischen den Messungen unentdeckt bleiben.
  SMOKE_GAP="${NEKO_SMOKE_GAP:-15}"
  info "Chromium-Stabilitaet wird geprueft (${SMOKE_GAP} s) …"
  # Bewusst if/fi statt `[ … ] && sleep`: bei Gap 0 liefert der Test 1 zurueck
  # und `set -e` wuerde das Skript an dieser Stelle beenden.
  if [ "${SMOKE_GAP}" -gt 0 ]; then sleep "${SMOKE_GAP}"; fi
  PID_B="$(chromium_pid)"
  if [ "${PID_A}" = "${PID_B}" ]; then
    ok "Chromium laeuft stabil (PID ${PID_A} unveraendert ueber 15 s — kein Crash-Loop)"
  else
    note_fail "Chromium-Crash-Loop: PID wechselte von ${PID_A} zu ${PID_B:-<leer>} innerhalb von 15 s"
    docker compose exec -T neko sh -c 'tail -n 15 /var/log/neko/chromium.log 2>/dev/null' \
      | sed 's/^/      /' || true
  fi
fi

HTTP_PORT="$(env_get NEKO_HTTP_PORT)"; HTTP_PORT="${HTTP_PORT:-8080}"
if curl -fsS -o /dev/null -m 10 "http://127.0.0.1:${HTTP_PORT}/"; then
  ok "neko antwortet lokal auf 127.0.0.1:${HTTP_PORT}"
else
  note_fail "neko antwortet lokal NICHT — 'docker compose logs neko' pruefen"
fi

if ss -tln 2>/dev/null | grep -qE "0\.0\.0\.0:${HTTP_PORT}|\*:${HTTP_PORT}"; then
  note_fail "Port ${HTTP_PORT} lauscht auf allen Interfaces — muss 127.0.0.1 sein!"
else
  ok "HTTP-Port nur an 127.0.0.1 gebunden"
fi

# ── Anmeldung wirklich durchspielen ──
# Dass NEKO_SESSION_COOKIE_ENABLED="false" in der Compose-Datei steht, beweist
# noch nicht, dass der LAUFENDE Container es uebernommen hat (alte .env, alter
# Container, halb durchgezogenes Update). Genau das war der Live-Fehler: der
# Login scheiterte trotz richtigem Passwort mit "token not found - make sure
# you are not using Cookie auth on the server". Der Smoke meldet sich deshalb
# echt an und sofort wieder ab. Passwort und Token tauchen dabei in keiner
# Ausgabe und in keiner Prozessliste auf.
NEKO_PW="$(env_get NEKO_USER_PASSWORD)"
if [ -z "${NEKO_PW}" ]; then
  warn "Kein NEKO_USER_PASSWORD in der .env — die Anmeldung ist nicht pruefbar"
else
  case "$(neko_login_probe "${HTTP_PORT}" "quantus" "${NEKO_PW}")" in
    token)
      ok "Anmeldung erfolgreich und Client-tauglich (Token im Antwort-Body)" ;;
    cookie)
      note_fail "Cookie-Auth im laufenden Container aktiv — der Login scheitert mit \"token not found\"."
      note_fail "NEKO_SESSION_COOKIE_ENABLED muss \"false\" sein, danach: docker compose up -d" ;;
    denied)
      note_fail "Anmeldung abgelehnt — das Passwort in der .env passt nicht zum laufenden Container (docker compose up -d)" ;;
    unreachable)
      note_fail "Login-API lokal nicht erreichbar" ;;
    *)
      note_fail "Login-API antwortet unerwartet" ;;
  esac
fi
unset NEKO_PW

# ── Traefik-spezifische Smoke-Tests ──
if [ "${PROXY}" = "traefik-docker" ]; then
  NET="$(env_get NEKO_TRAEFIK_NETWORK)"; NET="${NET:-${TRAEFIK_NETWORK}}"
  if docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' quantus-neko 2>/dev/null | tr ' ' '\n' | grep -qx "${NET}"; then
    ok "neko haengt am Traefik-Netz \"${NET}\""
  else
    note_fail "neko haengt NICHT an \"${NET}\" — Traefik kann den Container nicht erreichen"
  fi

  LBL="$(docker inspect -f '{{json .Config.Labels}}' quantus-neko 2>/dev/null || echo '{}')"
  for needle in \
    '"traefik.enable":"true"' \
    '"traefik.docker.network":"'"${NET}"'"' \
    '"traefik.http.services.quantus-neko.loadbalancer.server.port":"8080"'; do
    if printf '%s' "${LBL}" | grep -qF "${needle}"; then
      ok "Label gesetzt: ${needle}"
    else
      note_fail "Label fehlt: ${needle}"
    fi
  done
  printf '%s' "${LBL}" | grep -qF "Host(\`${DOMAIN}\`)" \
    && ok "Router-Regel: Host(\`${DOMAIN}\`)" \
    || note_fail "Router-Regel fehlt oder zeigt auf eine andere Domain"
  printf '%s' "${LBL}" | grep -qF '.tls.certresolver' \
    && ok "TLS-Resolver-Label gesetzt: $(env_get NEKO_TRAEFIK_CERTRESOLVER)" \
    || note_fail "certresolver-Label fehlt — Traefik stellt kein Zertifikat aus"

  # Gegenprobe: Traefik und n8n laufen unveraendert weiter. Ihre Uptime ist der
  # Beleg dafuer, dass dieses Skript sie nicht neu gestartet hat.
  info "Fremde Container (von diesem Skript nicht angefasst):"
  docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null \
    | grep -v '^quantus-neko' | sed 's/^/      /' || true
fi

# TLS von aussen — bewusst per GET: neko beantwortet HEAD live mit 405, ein
# HEAD-Smoke (curl -I) meldete deshalb einen Fehler, wo keiner war.
HTTPS_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "https://${DOMAIN}/" 2>/dev/null || echo 000)"
if [ "${HTTPS_CODE}" = "200" ]; then
  ok "HTTPS https://${DOMAIN} liefert HTTP 200 auf GET (gueltiges Zertifikat)"
  echo | openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" 2>/dev/null \
    | openssl x509 -noout -issuer -dates 2>/dev/null | sed 's/^/      /' || true
else
  note_fail "HTTPS https://${DOMAIN} liefert HTTP ${HTTPS_CODE} statt 200 auf GET (Zertifikat, DNS oder Proxy pruefen)"
  [ "${PROXY}" = "traefik-docker" ] && info "Bei Traefik dauert die ACME-Ausstellung nach dem ersten Start bis zu 2 Minuten: docker logs \$(docker ps -qf name=traefik) --tail 50"
fi

# WebSocket-Handshake ueber den Proxy — der Stream steht und faellt damit.
WS_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: cXVhbnR1cy1zbW9rZS10ZXN0" \
  "https://${DOMAIN}/api/ws" 2>/dev/null || echo 000)"
case "${WS_CODE}" in
  101) ok "WebSocket-Upgrade ueber den Proxy: 101 Switching Protocols" ;;
  400|401|403) ok "WebSocket-Endpunkt erreichbar (HTTP ${WS_CODE} — neko lehnt ohne Anmeldung ab, der Proxy leitet aber durch)" ;;
  000) note_fail "WebSocket-Endpunkt nicht erreichbar" ;;
  *)   warn "WebSocket-Endpunkt antwortet mit HTTP ${WS_CODE} — im Browser gegenpruefen" ;;
esac

# Der mitgelieferte Client verbindet sich nicht mit /api/ws, sondern mit /ws
# (Legacy-Bruecke). Fuer den Stream im iframe zaehlt genau dieser Pfad.
WS_LEGACY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: cXVhbnR1cy1zbW9rZS10ZXN0" \
  "https://${DOMAIN}/ws" 2>/dev/null || echo 000)"
case "${WS_LEGACY_CODE}" in
  101)         ok "Legacy-WebSocket /ws erreichbar (101) — der Client des Images kommt durch" ;;
  400|401|403) ok "Legacy-WebSocket /ws erreichbar (HTTP ${WS_LEGACY_CODE})" ;;
  404)         note_fail "/ws liefert 404 — Legacy-Bruecke aus (NEKO_LEGACY) oder Route falsch" ;;
  000)         note_fail "/ws nicht erreichbar" ;;
  *)           warn "/ws antwortet mit HTTP ${WS_LEGACY_CODE} — im Browser gegenpruefen" ;;
esac

WEBRTC_PORT="$(env_get NEKO_WEBRTC_PORT)"; WEBRTC_PORT="${WEBRTC_PORT:-59000}"
if ss -uln 2>/dev/null | grep -q ":${WEBRTC_PORT}"; then
  ok "WebRTC UDP ${WEBRTC_PORT} lauscht (direkt am Host, an Traefik vorbei)"
else
  note_fail "WebRTC UDP ${WEBRTC_PORT} lauscht nicht"
fi
info "Von aussen pruefbar nur mit einem zweiten Host: nc -vzu ${DOMAIN} ${WEBRTC_PORT}"

# Persistenz: Existenz UND Eigentuemer — root:root hiess live "permission
# denied" fuer sessions.json/Downloads und Chromium-Crash-Loop.
DATA_UID="$(data_uid)"; DATA_GID="$(data_gid)"
for d in profile downloads neko; do
  dir="${APP_DIR}/data/${d}"
  if [ ! -d "${dir}" ]; then
    note_fail "Fehlt: ${dir}"
  elif [ "$(stat -c '%u:%g' "${dir}")" = "${DATA_UID}:${DATA_GID}" ]; then
    ok "Persistent: ${dir} ($(stat -c '%u:%g %a' "${dir}"))"
  else
    note_fail "Falscher Eigentuemer: ${dir} gehoert $(stat -c '%u:%g' "${dir}") statt ${DATA_UID}:${DATA_GID} — Deploy-Skript (ohne --smoke) erneut ausfuehren"
  fi
done

# Schreibprobe AUS SICHT DES CONTAINERS — das ist der Test, der zaehlt:
# genau hier scheiterten sessions.json und der Datei-Transfer live.
if docker compose exec -T --user "${DATA_UID}:${DATA_GID}" neko sh -c \
  'set -e; for d in /home/neko/.neko /home/neko/Downloads /home/neko/.config/chromium; do
     touch "$d/.quantus-rw-probe" && rm -f "$d/.quantus-rw-probe"; done' >/dev/null 2>&1; then
  ok "Schreibprobe als UID ${DATA_UID}: Profil, Downloads und .neko sind beschreibbar"
else
  note_fail "Schreibprobe als UID ${DATA_UID} fehlgeschlagen — Eigentuemer/Rechte unter ${APP_DIR}/data pruefen"
fi

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
  echo "      Passwort: $(env_get NEKO_USER_PASSWORD)"
  warn "Bitte im Quantus-Passwortmanager ablegen. Erneut auslesbar mit:"
  echo "      grep NEKO_USER_PASSWORD ${APP_DIR}/.env"
  echo
fi

cat <<EOF

  Rollback (beruehrt n8n/Traefik nicht):
    cd ${APP_DIR} && docker compose down            # nur quantus-neko stoppen
    # Damit verschwinden auch die Traefik-Labels -> die Route ist sofort weg.
    ls ${BACKUP_DIR}                                # gesicherte Konfigurationen
    docker compose down -v                          # NUR wenn auch das Profil weg soll

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
