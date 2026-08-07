#!/usr/bin/env bash
#
# Gegenprobe: schlaegt der Smoke-Test in den vier Live-Fehlerfaellen WIRKLICH an?
#
# Die uebrigen Tests pruefen die Bausteine einzeln (neko_login_probe entscheidet
# richtig, ensure_data_dir chownt nur bei Abweichung, …). Was dabei offen
# bleibt, ist die VERDRAHTUNG: ob der Smoke-Abschnitt ein schlechtes Ergebnis
# auch tatsaechlich in ein ✗ verwandelt, statt es zu verschlucken. Ein
# Smoke-Test, der nicht fehlschlagen kann, ist wertlos — und genau das war die
# Ausgangslage: der alte HTTPS-Check konnte nur falsch negativ sein, und ein
# Crash-Loop blieb voellig unsichtbar.
#
# Jeder Fall stellt eine kaputte Aussenwelt nach (gestubbtes docker/curl/ss/…)
# und erwartet eine bestimmte Fehlermeldung. Es laeuft kein echter Container,
# kein Netz und nichts als root.
set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_DIR}/scripts/deploy-neko-hostinger.sh"
PASS=0
FAILED=0

# Baut die kaputte Aussenwelt fuer ein Szenario, laesst den Smoke-Teil des
# Deploy-Skripts darauf laufen und gibt dessen Ausgabe zurueck.
run_smoke() {
  local scenario="$1"
  local W; W="$(mktemp -d)"
  mkdir -p "${W}/bin" "${W}/app/data/profile" "${W}/app/data/downloads" "${W}/app/data/neko"

  # Erwarteter Eigentuemer. Im Fall "ownership" weicht er absichtlich vom
  # echten ab — das ist der Live-Zustand root:root aus Sicht des Skripts.
  local uid gid; uid="$(id -u)"; gid="$(id -g)"
  if [ "${scenario}" = "ownership" ]; then uid=1000; gid=1000; fi

  cat > "${W}/app/.env" <<EOF
NEKO_USER_PASSWORD=geheim
NEKO_ADMIN_PASSWORD=geheim2
NEKO_HTTP_PORT=8080
NEKO_WEBRTC_PORT=59000
NEKO_TRAEFIK_NETWORK=n8n_default
NEKO_TRAEFIK_CERTRESOLVER=mytlschallenge
NEKO_DATA_UID=${uid}
NEKO_DATA_GID=${gid}
EOF
  chmod 600 "${W}/app/.env"
  : > "${W}/pidcount"

  cat > "${W}/bin/docker" <<STUB
#!/usr/bin/env bash
SCENARIO="${scenario}"
COUNT="${W}/pidcount"
STUB
  cat >> "${W}/bin/docker" <<'STUB'
case "$*" in
  "--version") echo "Docker version 27.0.0" ;;
  "compose version"*) echo "v2.29.0" ;;
  "compose ps") echo "quantus-neko    Up 3 minutes (healthy)" ;;
  *"/proc/"*)
    # crashloop: jede Stichprobe sieht eine andere PID — genau das Bild einer
    # supervisord-Neustartschleife.
    if [ "${SCENARIO}" = "crashloop" ]; then
      echo x >> "${COUNT}"; echo $(( 200 + $(wc -l < "${COUNT}") ))
    else echo 235; fi ;;
  *"chromium --version"*) echo "Chromium 138.0.7204.100" ;;
  *"quantus-rw-probe"*)
    # Bei root-eigenen Verzeichnissen scheitert die Schreibprobe als UID 1000.
    if [ "${SCENARIO}" = "ownership" ]; then exit 1; fi; exit 0 ;;
  *"chromium.log"*) echo "  Failed to create data directory" ;;
  "ps --format"*) printf 'aa11\ttraefik:v3.7.5\n' ;;
  "inspect -f {{json .Config.Cmd}}"*) echo '["--providers.docker.exposedbydefault=false","--entrypoints.web.address=:80","--entrypoints.websecure.address=:443","--certificatesresolvers.mytlschallenge.acme.tlschallenge=true"]' ;;
  "inspect -f {{json .Args}}"*|"inspect -f {{json .Config.Env}}"*) echo '[]' ;;
  "inspect -f {{json .Config.Labels}}"*) echo '{"traefik.enable":"true","traefik.docker.network":"n8n_default","traefik.http.services.quantus-neko.loadbalancer.server.port":"8080","traefik.http.routers.quantus-neko.rule":"Host(`neko.laurin-rusterholz.ch`)","traefik.http.routers.quantus-neko.tls.certresolver":"mytlschallenge"}' ;;
  "inspect -f {{.Config.Image}}"*) echo "ghcr.io/m1k1o/neko/chromium:3.1.5" ;;
  "inspect -f {{.HostConfig.RestartPolicy.Name}}"*) echo "unless-stopped" ;;
  "inspect -f "*NetworkSettings*) echo "n8n_default " ;;
  "inspect -f {{.Name}}"*) echo "/traefik" ;;
  *) : ;;
esac
STUB

  cat > "${W}/bin/curl" <<STUB
#!/usr/bin/env bash
SCENARIO="${scenario}"
STUB
  cat >> "${W}/bin/curl" <<'STUB'
out=""; prev=""
for a in "$@"; do [ "${prev}" = "-o" ] && out="${a}"; prev="${a}"; done
case "$*" in
  *"/api/login"*)
    cat >/dev/null
    # cookie: Anmeldung geht durch, aber OHNE Token im Body — der Live-Fehler.
    if [ "${SCENARIO}" = "cookie" ]; then body='{"id":"quantus-ab12c","profile":{}}'
    else body='{"id":"quantus-ab12c","token":"tok123","profile":{}}'; fi
    if [ -n "${out}" ] && [ "${out}" != "/dev/null" ]; then printf '%s' "${body}" > "${out}"; fi
    printf '200' ;;
  *"/api/logout"*) printf '200' ;;
  *"/ws"*) printf '101' ;;
  # head405: der Server antwortet wie neko auf HEAD — 405 statt 200.
  *"https://"*) if [ "${SCENARIO}" = "head405" ]; then printf '405'; else printf '200'; fi ;;
  *"127.0.0.1"*) exit 0 ;;
  *) printf '200' ;;
esac
STUB

  # Das Skript besteht auf root (auf dem VPS voellig richtig). Der CI-Runner ist
  # aber `runner`, und ohne diesen Stub braeche es schon in den Vorabpruefungen
  # ab — die Smoke-Tests liefen dann nie, und der Test meldete faelschlich
  # "blind". Genau das hat die CI aufgedeckt.
  printf '#!/usr/bin/env bash\nif [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi\n' > "${W}/bin/id"
  printf '#!/usr/bin/env bash\nexit 1\n' > "${W}/bin/systemctl"
  printf '#!/usr/bin/env bash\necho "203.0.113.10 neko.laurin-rusterholz.ch"\n' > "${W}/bin/getent"
  printf '#!/usr/bin/env bash\ncase "$*" in *-uln*) echo ":59000" ;; *-tln*) echo "127.0.0.1:8080" ;; esac\n' > "${W}/bin/ss"
  printf '#!/usr/bin/env bash\ncat >/dev/null 2>&1; :\n' > "${W}/bin/openssl"
  chmod +x "${W}/bin"/*

  PATH="${W}/bin:${PATH}" QUANTUS_NEKO_DIR="${W}/app" NEKO_SMOKE_GAP=0 \
    bash "${SCRIPT}" --smoke 2>&1
  rm -rf "${W}"
}

# Sicherung gegen einen kaputten Testaufbau: erreicht der Lauf die Smoke-Tests
# gar nicht — etwa weil eine Vorabpruefung abbricht —, waere jedes Urteil
# darunter wertlos. Dann soll der Test LAUT scheitern statt "der Smoke ist
# blind" zu behaupten. (Genau dieser Fall trat auf: ohne root-Stub starb das
# Skript in den Vorabpruefungen.)
assert_reached_smoke() {
  local out="$1" ctx="$2"
  if printf '%s' "${out}" | grep -q '7/8  Smoke-Tests'; then return 0; fi
  printf '  ✗ Testaufbau kaputt (%s): der Lauf erreicht die Smoke-Tests nicht\n' "${ctx}"
  printf '%s\n' "${out}" | tail -n 3 | sed 's/^/        /'
  FAILED=1
  return 1
}

# Der kaputte Fall MUSS die Meldung bringen.
expect_detected() {
  local name="$1" expect="$2" scenario="$3" out
  out="$(run_smoke "${scenario}")"
  assert_reached_smoke "${out}" "${scenario}" || return
  if printf '%s' "${out}" | grep -qF "${expect}"; then
    printf '  ✓ %s\n' "${name}"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %s\n      Smoke bleibt BLIND — erwartet war: %s\n' "${name}" "${expect}"
    printf '%s\n' "${out}" | grep -E '✗' | sed 's/^/        /'
    FAILED=1
  fi
}

echo
echo "Gegenprobe: faengt der Smoke-Test die vier Live-Fehler?"
expect_detected "Cookie-Auth im laufenden Container wird gemeldet" \
         "Cookie-Auth im laufenden Container aktiv" cookie
expect_detected "Chromium-Neustartschleife wird gemeldet" \
         "Chromium-Crash-Loop"                      crashloop
expect_detected "root-eigene Datenverzeichnisse werden gemeldet" \
         "Falscher Eigentuemer"                     ownership
expect_detected "HTTPS mit 405 statt 200 wird gemeldet" \
         "statt 200 auf GET"                        head405

# Gegenprobe zur Gegenprobe: im heilen Fall darf KEINE dieser Meldungen
# erscheinen. Ohne diesen Fall waere der Test auch dann gruen, wenn der Smoke
# blind alles bemaengelt.
HEALTHY="$(run_smoke ok)"
healthy_ok=1
if assert_reached_smoke "${HEALTHY}" "heiler Fall"; then
  # Abwesenheit allein genuegt nicht — ein abgebrochener Lauf haette sie auch.
  # Es muss belegt sein, dass die Pruefungen wirklich gelaufen und gruen sind.
  for e in "Anmeldung erfolgreich und Client-tauglich" "Chromium laeuft stabil" \
           "liefert HTTP 200 auf GET"; do
    if ! printf '%s' "${HEALTHY}" | grep -qF "${e}"; then
      printf '  ✗ im heilen Fall fehlt der Beleg, dass geprueft wurde: %s\n' "${e}"
      healthy_ok=0; FAILED=1
    fi
  done
  for e in "Cookie-Auth im laufenden Container aktiv" "Chromium-Crash-Loop" \
           "Falscher Eigentuemer" "statt 200 auf GET"; do
    if printf '%s' "${HEALTHY}" | grep -qF "${e}"; then
      printf '  ✗ im heilen Fall faelschlich gemeldet: %s\n' "${e}"
      healthy_ok=0; FAILED=1
    fi
  done
else
  healthy_ok=0
fi
if [ "${healthy_ok}" -eq 1 ]; then
  printf '  ✓ im heilen Fall laufen die Pruefungen und melden keinen dieser Fehler\n'
  PASS=$((PASS + 1))
fi

echo
if [ "${FAILED}" -eq 0 ]; then
  printf '✓ Smoke-Fehlerfaelle: %s Pruefungen bestanden\n\n' "${PASS}"
else
  printf '✗ Mindestens ein Live-Fehler wuerde unentdeckt bleiben\n\n'
  exit 1
fi
