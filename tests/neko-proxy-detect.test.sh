#!/usr/bin/env bash
#
# Proxy-Erkennung und .env-Verwaltung aus scripts/deploy-neko-hostinger.sh.
#
# Der VPS hat einen bestehenden n8n-Stack mit Traefik im Docker. Genau dieser
# Fall wird hier nachgestellt: ein gestubbter `docker`-Befehl liefert die
# Ausgaben, die das echte Setup liefert (Traefik v3.7.5, Docker-Provider,
# exposedByDefault=false, EntryPoints web/websecure, ACME-Resolver
# mytlschallenge, Netz n8n_default). Geprueft wird, dass das Skript daraus die
# richtige Route ableitet — statt wie vorher abzuwinken.
#
# Getestet wird die Logik, nicht Docker: die Funktionen werden ueber
# NEKO_DEPLOY_LIB_ONLY=1 geladen, ohne dass das Skript etwas ausfuehrt.

set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_DIR}/scripts/deploy-neko-hostinger.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

PASS=0
check() {
  local label="$1" actual="$2" expected="$3"
  if [ "${actual}" = "${expected}" ]; then
    printf '  ✓ %s\n' "${label}"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %s\n      erwartet: %s\n      erhalten: %s\n' "${label}" "${expected}" "${actual}"
    exit 1
  fi
}

# ── Stub: verhaelt sich wie der `docker` auf dem echten VPS ───────────────────
make_docker_stub() {
  local scenario="$1"
  mkdir -p "${WORK}/bin"
  cat > "${WORK}/bin/docker" <<STUB
#!/usr/bin/env bash
SCENARIO="${scenario}"
STUB
  cat >> "${WORK}/bin/docker" <<'STUB'
case "$1 $2" in
  "ps --format")
    fmt="$3"
    case "${SCENARIO}" in
      traefik)
        if [ "${fmt#*.ID}" != "${fmt}" ]; then
          printf 'aa11bb22cc33\ttraefik:v3.7.5\n'
          printf 'dd44ee55ff66\tdocker.n8n.io/n8nio/n8n:latest\n'
        else
          printf 'traefik:v3.7.5\ndocker.n8n.io/n8nio/n8n:latest\n'
        fi ;;
      registry-traefik)
        if [ "${fmt#*.ID}" != "${fmt}" ]; then
          printf 'aa11bb22cc33\tghcr.io/example/traefik:v3.7.5\n'
        else
          printf 'ghcr.io/example/traefik:v3.7.5\n'
        fi ;;
      nginx-docker)
        if [ "${fmt#*.ID}" != "${fmt}" ]; then printf 'ff99\tnginx:1.27\n'; else printf 'nginx:1.27\n'; fi ;;
      # Ein Container, der bloss "traefik" im NAMEN traegt, ist kein Traefik.
      lookalike)
        if [ "${fmt#*.ID}" != "${fmt}" ]; then printf 'ab12\tmycorp/traefik-metrics-exporter:1.0\n'; else printf 'mycorp/traefik-metrics-exporter:1.0\n'; fi ;;
      empty) : ;;
    esac ;;
  "inspect -f")
    tmpl="$3"
    case "${tmpl}" in
      *Config.Cmd*)
        # Genau die Flags des bestehenden n8n-Setups.
        printf '%s\n' '["--api.dashboard=true","--providers.docker=true","--providers.docker.exposedByDefault=false","--entryPoints.web.address=:80","--entryPoints.web.http.redirections.entryPoint.to=websecure","--entryPoints.web.http.redirections.entryPoint.scheme=https","--entryPoints.websecure.address=:443","--certificatesresolvers.mytlschallenge.acme.tlschallenge=true","--certificatesresolvers.mytlschallenge.acme.email=admin@example.com","--certificatesresolvers.mytlschallenge.acme.storage=/letsencrypt/acme.json"]' ;;
      *.Args*)          printf '%s\n' '[]' ;;
      *Config.Env*)     printf '%s\n' '["PATH=/usr/local/bin","TZ=Europe/Zurich"]' ;;
      *Config.Labels*)  printf '%s\n' '{"org.opencontainers.image.title":"Traefik"}' ;;
      *Config.Image*)   printf 'traefik:v3.7.5\n' ;;
      *.Name*)          printf '/n8n-traefik-1\n' ;;
      *NetworkSettings.Networks*) printf 'n8n_default \n' ;;
      *) printf '\n' ;;
    esac ;;
  "network inspect") exit 0 ;;
  "compose version")  printf 'v5.1.4\n' ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "${WORK}/bin/docker"
}

load_lib() {
  # systemctl darf im Test nichts finden — sonst wuerde ein Host-nginx der
  # Testmaschine das Ergebnis verfaelschen.
  printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/bin/systemctl"
  chmod +x "${WORK}/bin/systemctl"
  PATH="${WORK}/bin:${PATH}" \
  QUANTUS_NEKO_DIR="${WORK}/app" \
  NEKO_DEPLOY_LIB_ONLY=1 \
  bash -c 'set -uo pipefail
    export PATH QUANTUS_NEKO_DIR
    source "$1"
    detect_proxy
    printf "PROXY=%s\n"     "${PROXY}"
    printf "NETWORK=%s\n"   "${TRAEFIK_NETWORK}"
    printf "RESOLVER=%s\n"  "${TRAEFIK_RESOLVER}"
    printf "EP_HTTPS=%s\n"  "${TRAEFIK_EP_HTTPS}"
    printf "EP_HTTP=%s\n"   "${TRAEFIK_EP_HTTP}"
  ' _ "${SCRIPT}"
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

echo
echo "1. Bestehendes n8n-Traefik-Setup wird erkannt"
mkdir -p "${WORK}/app"
make_docker_stub traefik
OUT="$(load_lib)"
check "Proxy-Typ"            "$(field "${OUT}" PROXY)"    "traefik-docker"
check "Netz aus Traefik"     "$(field "${OUT}" NETWORK)"  "n8n_default"
check "ACME-Resolver"        "$(field "${OUT}" RESOLVER)" "mytlschallenge"
check "HTTPS-EntryPoint"     "$(field "${OUT}" EP_HTTPS)" "websecure"
check "HTTP-EntryPoint"      "$(field "${OUT}" EP_HTTP)"  "web"

echo
echo "2. Traefik aus einer eigenen Registry wird ebenfalls erkannt"
make_docker_stub registry-traefik
check "Proxy-Typ" "$(field "$(load_lib)" PROXY)" "traefik-docker"

echo
echo "3. Abgrenzung gegen Fehlerkennungen"
# Ein "traefik-metrics-exporter" ist kein Traefik. Wuerde er als solcher
# durchgehen, wuerde neko Labels fuer einen Proxy setzen, den es nicht gibt —
# die Route waere tot, ohne dass es jemand merkt.
make_docker_stub lookalike
check "traefik-exporter ist kein Traefik" "$(field "$(load_lib)" PROXY)" "none"
make_docker_stub nginx-docker
check "nginx-Container"       "$(field "$(load_lib)" PROXY)" "nginx-docker"
make_docker_stub empty
check "kein Proxy vorhanden"  "$(field "$(load_lib)" PROXY)" "none"

echo
echo "4. .env wird idempotent gepflegt"
ENVTEST="$(PATH="${WORK}/bin:${PATH}" QUANTUS_NEKO_DIR="${WORK}/app2" NEKO_DEPLOY_LIB_ONLY=1 \
  bash -c 'set -uo pipefail
    export QUANTUS_NEKO_DIR
    mkdir -p "${QUANTUS_NEKO_DIR}"
    source "$1"
    printf "NEKO_USER_PASSWORD=geheim\nNEKO_PUBLIC_IP=203.0.113.10\n" > "${APP_DIR}/.env"
    env_set COMPOSE_FILE "docker-compose.yml:docker-compose.traefik.yml"
    env_set COMPOSE_FILE "docker-compose.yml:docker-compose.traefik.yml"   # zweimal = einmal
    env_set NEKO_PUBLIC_IP "198.51.100.7"
    printf "GET=%s\n"    "$(env_get COMPOSE_FILE)"
    printf "IP=%s\n"     "$(env_get NEKO_PUBLIC_IP)"
    printf "PW=%s\n"     "$(env_get NEKO_USER_PASSWORD)"
    printf "LINES=%s\n"  "$(grep -c "^COMPOSE_FILE=" "${APP_DIR}/.env")"
    printf "MODE=%s\n"   "$(stat -c "%a" "${APP_DIR}/.env")"
  ' _ "${SCRIPT}")"
check "COMPOSE_FILE gesetzt"        "$(field "${ENVTEST}" GET)"   "docker-compose.yml:docker-compose.traefik.yml"
check "vorhandener Wert ersetzt"    "$(field "${ENVTEST}" IP)"    "198.51.100.7"
check "fremde Zeile unberuehrt"     "$(field "${ENVTEST}" PW)"    "geheim"
check "kein doppelter Eintrag"      "$(field "${ENVTEST}" LINES)" "1"
check ".env bleibt Modus 600"       "$(field "${ENVTEST}" MODE)"  "600"

echo
echo "5. Das Skript fasst fremde Stacks nicht an"
for forbidden in 'docker restart' 'docker compose -f /docker' 'systemctl restart docker' '/docker/n8n'; do
  if grep -qF "${forbidden}" "${SCRIPT}"; then
    printf '  ✗ Skript enthaelt "%s"\n' "${forbidden}"; exit 1
  fi
done
printf '  ✓ kein Restart und kein Zugriff auf /docker/n8n\n'; PASS=$((PASS + 1))

# `docker compose down` darf nur in der Rollback-AUSGABE stehen, nie als
# ausgefuehrter Befehl. Dafuer muessen Here-Doc-Bloecke und Kommentare vorher
# raus — sonst schlaegt die Pruefung schon an der Rollback-Anleitung an.
# POSIX-awk (mawk kann kein match() mit drittem Argument) — sonst liefe die
# Pruefung ins Leere und waere falsch gruen.
EXECUTABLE="$(awk '
  /<<-?'"'"'?[A-Za-z][A-Za-z0-9_]*'"'"'?$/ {
    t = $0
    sub(/^.*<<-?'"'"'?/, "", t)
    sub(/'"'"'$/, "", t)
    term = t; skip = 1; next
  }
  skip == 1 && $0 == term { skip = 0; next }
  skip == 1 { next }
  /^[[:space:]]*#/ { next }
  { print }
' "${SCRIPT}")"

# Schutz gegen eine stillschweigend leere Extraktion.
if [ "$(printf '%s\n' "${EXECUTABLE}" | grep -c 'docker compose up -d')" -lt 1 ]; then
  printf '  ✗ Extraktion des ausfuehrbaren Teils fehlgeschlagen (kein "docker compose up -d" gefunden)\n'; exit 1
fi

if printf '%s\n' "${EXECUTABLE}" | grep -qE '(^|[;&|[:space:]])docker compose (down|stop|rm)'; then
  printf '  ✗ Skript fuehrt selbst ein docker compose down/stop aus\n'
  printf '%s\n' "${EXECUTABLE}" | grep -nE 'docker compose (down|stop|rm)'
  exit 1
fi
printf '  ✓ kein ausgefuehrtes docker compose down/stop\n'; PASS=$((PASS + 1))

# Gegenprobe, dass die Pruefung oben ueberhaupt greift.
if ! printf 'docker compose down\n' | grep -qE '(^|[;&|[:space:]])docker compose (down|stop|rm)'; then
  printf '  ✗ Pruefmuster erkennt nicht einmal den Klartextfall\n'; exit 1
fi
printf '  ✓ Pruefmuster selbst verifiziert\n'; PASS=$((PASS + 1))

echo
printf '✓ Proxy-Erkennung: %s Pruefungen bestanden\n\n' "${PASS}"
