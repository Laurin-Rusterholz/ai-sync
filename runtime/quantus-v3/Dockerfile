# ══ Quantus Tagesbriefing v3 — Laufzeitabbild (Paket E2) ═══════════════════
#
# Bauen aus dem REPOSITORY-WURZELVERZEICHNIS:
#     docker build -f runtime/quantus-v3/Dockerfile -t quantus-v3-runtime:dev .
#
# Das Abbild enthaelt genau drei Dinge: die beiden reinen E1-Module, die
# Laufzeitquellen und eine Node-Umgebung. Keine Abhaengigkeiten, kein
# Bauschritt, kein Paketmanager im Abbild, kein Geheimnis. Geheimnisse
# kommen zur Laufzeit ueber Secret-Manager-Verweise in der Dienstdefinition.
#
# Derselbe Container bedient alle drei Rollen; welche, entscheidet
# QUANTUS_V3_RUNTIME_ROLE. Fehlt die Konfiguration, antwortet jede Route
# mit 503 und nennt die fehlenden Variablennamen.
# ═════════════════════════════════════════════════════════════════════════
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--disable-proto=throw

WORKDIR /app

# Fachlogik (Paket E1) — unveraendert wiederverwendet, nicht kopiert.
COPY netlify/lib/quantus-v3-runtime-plan.mjs netlify/lib/quantus-v3-runtime-state.mjs ./netlify/lib/
# Laufzeit (Paket E2).
COPY runtime/quantus-v3/package.json ./runtime/quantus-v3/package.json
COPY runtime/quantus-v3/src ./runtime/quantus-v3/src

USER node
EXPOSE 8080

# Cloud Run prueft den Start per TCP. Es gibt bewusst KEINE anonyme
# HTTP-Gesundheitsroute.
CMD ["node", "runtime/quantus-v3/src/server.mjs"]
