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

# Dateirechte oktal lesen — portabel. GNU coreutils kennt `stat -c`, BSD/macOS
# dagegen nur `stat -f`. Ohne diese Weiche lieferte macOS
# "stat: illegal option -- c" und der Modus-Vergleich lief gegen einen leeren
# Wert, statt zu greifen.
#
# Die Variante wird EINMAL an einer bekannten Datei ermittelt, nicht pro Aufruf
# ueber einen Fehlschlag: GNU deutet `-f` als Dateisystem-Abfrage und wuerde
# sonst stillschweigend etwas voellig anderes liefern.
if stat -c '%a' "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
  STAT_MODE_FMT=(-c '%a')
else
  STAT_MODE_FMT=(-f '%Lp')
fi
file_mode() {
  stat "${STAT_MODE_FMT[@]}" "$1"
}
# Fuer Subshells, die den Helfer nicht sehen (bash -c), einzeln exportiert.
export STAT_FMT_A="${STAT_MODE_FMT[0]}"
export STAT_FMT_B="${STAT_MODE_FMT[1]}"

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
  STAT_FMT_A="${STAT_FMT_A}" STAT_FMT_B="${STAT_FMT_B}" \
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
    printf "MODE=%s\n"   "$(stat "${STAT_FMT_A}" "${STAT_FMT_B}" "${APP_DIR}/.env")"
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
echo "6. Datenverzeichnisse: Eigentuemer idempotent und nie destruktiv"
# ensure_data_dir muss root:root-Altbestand reparieren (Live-Befund: permission
# denied fuer sessions.json/Downloads, Chromium-SIGTRAP-Loop wegen
# unbeschreibbarem Profil), darf aber bei korrektem Eigentuemer NICHTS anfassen
# und unter keinen Umstaenden loeschen. chown ist gestubbt — der Test laeuft
# auch ohne root (CI); geprueft wird die Entscheidung, nicht der Syscall.
OWNTEST="$(QUANTUS_NEKO_DIR="${WORK}/app3" NEKO_DEPLOY_LIB_ONLY=1 \
  STAT_FMT_A="${STAT_FMT_A}" STAT_FMT_B="${STAT_FMT_B}" bash -c '
  set -uo pipefail
  export QUANTUS_NEKO_DIR
  mkdir -p "${QUANTUS_NEKO_DIR}"
  source "$1"

  STUB="${QUANTUS_NEKO_DIR}/stub"; LOG="${STUB}/chown.log"
  mkdir -p "${STUB}"; : > "${LOG}"
  printf "#!/usr/bin/env bash\necho \"\$*\" >> \"%s\"\n" "${LOG}" > "${STUB}/chown"
  chmod +x "${STUB}/chown"
  export PATH="${STUB}:${PATH}"

  ME_UID="$(id -u)"; ME_GID="$(id -g)"
  D="${QUANTUS_NEKO_DIR}/data/profile"
  mkdir -p "${D}"
  printf "wichtig" > "${D}/bookmark.bak"

  # 1) Eigentuemer stimmt bereits -> KEIN chown (idempotent und billig)
  ensure_data_dir "${D}" "${ME_UID}" "${ME_GID}"
  printf "CALLS_OK=%s\n" "$(grep -c . "${LOG}")"

  # 2) Eigentuemer weicht ab -> genau EIN rekursives chown auf uid:gid
  ensure_data_dir "${D}" 4242 4243
  printf "CALLS_BAD=%s\n" "$(grep -c . "${LOG}")"
  printf "CALL_ARGS=%s\n" "$(tail -n1 "${LOG}")"

  # 3) Bestehende Daten ueberleben die Reparatur unangetastet
  printf "DATA=%s\n" "$(cat "${D}/bookmark.bak")"

  # 4) Ein fuer den Eigentuemer unbenutzbares Verzeichnis (500) wird geoeffnet
  E="${QUANTUS_NEKO_DIR}/data/neko"
  mkdir -p "${E}"; chmod 500 "${E}"
  ensure_data_dir "${E}" "${ME_UID}" "${ME_GID}"
  printf "MODE=%s\n" "$(stat "${STAT_FMT_A}" "${STAT_FMT_B}" "${E}")"
  chmod 700 "${E}"

  # 5) data_uid/data_gid: Default 1000, per .env uebersteuerbar
  printf "UID_DEFAULT=%s\n" "$(data_uid)"
  env_set NEKO_DATA_UID 1234
  printf "UID_ENV=%s\n" "$(data_uid)"
' _ "${SCRIPT}")"
check "korrekter Eigentuemer: kein chown"       "$(field "${OWNTEST}" CALLS_OK)"    "0"
check "falscher Eigentuemer: genau ein chown"   "$(field "${OWNTEST}" CALLS_BAD)"   "1"
check "chown ist rekursiv auf uid:gid"          "$(field "${OWNTEST}" CALL_ARGS)"   "-R 4242:4243 ${WORK}/app3/data/profile"
check "bestehende Daten bleiben erhalten"       "$(field "${OWNTEST}" DATA)"        "wichtig"
check "500er-Verzeichnis wird u+rwX repariert"  "$(field "${OWNTEST}" MODE)"        "700"
check "NEKO_DATA_UID: Default 1000"             "$(field "${OWNTEST}" UID_DEFAULT)" "1000"
check "NEKO_DATA_UID: .env uebersteuert"        "$(field "${OWNTEST}" UID_ENV)"     "1234"

echo
echo "7. Anmelde-Probe: Token im Body statt Cookie — und ohne Secret-Leck"
# Der Live-Fehler war nicht die Compose-Datei, sondern der laufende Container:
# mit Cookie-Auth liefert /api/login keinen Token im Body und JEDER Login des
# mitgelieferten Clients scheitert. neko_login_probe muss diesen Fall vom
# falschen Passwort und von einer toten API unterscheiden — und dabei weder
# Passwort noch Token in die Kommandozeile schreiben (Prozessliste!).
REC="${WORK}/rec"; mkdir -p "${REC}"

# curl-Stub: schreibt Argumente und stdin mit und legt den gewuenschten
# Antwort-Body in die mit -o benannte Datei.
cat > "${WORK}/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${REC}/curl.args"
case "$*" in *--data-binary\ @-*) cat >> "${REC}/curl.stdin" ;; esac
out=""; prev=""
for a in "$@"; do [ "${prev}" = "-o" ] && out="${a}"; prev="${a}"; done
if [ -n "${out}" ] && [ "${out}" != "/dev/null" ]; then printf '%s' "${CURL_BODY:-}" > "${out}"; fi
printf '%s' "${CURL_CODE:-200}"
exit "${CURL_EXIT:-0}"
STUB
chmod +x "${WORK}/bin/curl"

login_probe() {
  PATH="${WORK}/bin:${PATH}" REC="${REC}" \
  CURL_BODY="$1" CURL_CODE="$2" CURL_EXIT="${3:-0}" \
  QUANTUS_NEKO_DIR="${WORK}/app" NEKO_DEPLOY_LIB_ONLY=1 \
  bash -c 'set -uo pipefail
    export PATH REC QUANTUS_NEKO_DIR CURL_BODY CURL_CODE CURL_EXIT
    source "$1"
    printf "RESULT=%s\n" "$(neko_login_probe 8080 quantus "$2")"
  ' _ "${SCRIPT}" "$4"
}

# Absichtlich mit Anfuehrungszeichen: daran zerbricht eine handgebaute
# JSON-Zeile. So muss es escaped im Body ankommen.
SECRET='p@ss"wort/mit+zeichen'
SECRET_JSON='p@ss\"wort/mit+zeichen'
SECRET_MARK='wort/mit+zeichen'

: > "${REC}/curl.args"; : > "${REC}/curl.stdin"
OUT="$(login_probe '{"id":"quantus-ab12c","token":"tok-geheim-123","profile":{}}' 200 0 "${SECRET}")"
check "Token im Body -> Client kann sich anmelden" "$(field "${OUT}" RESULT)" "token"
check "die Probe-Sitzung wird wieder abgemeldet"   "$(grep -c 'api/logout' "${REC}/curl.args")" "1"

if grep -qF "${SECRET_MARK}" "${REC}/curl.args"; then
  printf '  ✗ Passwort steht in der curl-Kommandozeile (Prozessliste!)\n'; exit 1
fi
printf '  ✓ Passwort steht nicht in der Kommandozeile\n'; PASS=$((PASS + 1))
if ! grep -qF "${SECRET_JSON}" "${REC}/curl.stdin"; then
  printf '  ✗ Passwort kam nicht korrekt escaped im Body an — der Test pruefte nichts\n'; exit 1
fi
printf '  ✓ Passwort geht ueber stdin und ist korrekt JSON-escaped\n'; PASS=$((PASS + 1))
if grep -qF 'tok-geheim-123' "${REC}/curl.args"; then
  printf '  ✗ Sitzungstoken steht in der Kommandozeile\n'; exit 1
fi
printf '  ✓ Sitzungstoken steht nicht in der Kommandozeile\n'; PASS=$((PASS + 1))

# Der Live-Fehler: Anmeldung geht durch, aber ohne Token im Body.
OUT="$(login_probe '{"id":"quantus-ab12c","profile":{}}' 200 0 "${SECRET}")"
check "Cookie-Auth wird als Fehler erkannt" "$(field "${OUT}" RESULT)" "cookie"
OUT="$(login_probe '' 401 0 "${SECRET}")"
check "falsches Passwort -> denied"         "$(field "${OUT}" RESULT)" "denied"
OUT="$(login_probe '' 000 7 "${SECRET}")"
check "keine Antwort -> unreachable"        "$(field "${OUT}" RESULT)" "unreachable"

echo
printf '✓ Proxy-Erkennung: %s Pruefungen bestanden\n\n' "${PASS}"
