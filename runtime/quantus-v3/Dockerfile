# ══ Quantus Tagesbriefing v3 — Laufzeitabbild (Paket E2) ═══════════════════
#
# Bauen aus dem REPOSITORY-WURZELVERZEICHNIS:
#     docker build -f runtime/quantus-v3/Dockerfile -t quantus-v3-runtime:dev .
#
# Das Abbild enthaelt die Laufzeit, ihre Backend-Module, versionierte
# Anweisungen und die gesperrten Produktionsabhaengigkeiten. Geheimnisse
# kommen zur Laufzeit ueber Secret-Manager-Verweise in der Dienstdefinition.
#
# Derselbe Container bedient alle drei Rollen; welche, entscheidet
# QUANTUS_V3_RUNTIME_ROLE. Fehlt die Konfiguration, antwortet jede Route
# mit 503 und nennt die fehlenden Variablennamen.
# ═════════════════════════════════════════════════════════════════════════
FROM node:22-slim AS dependencies
WORKDIR /dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--disable-proto=throw

WORKDIR /app

# Auch dynamische Adapterimporte muessen im ausgelieferten Abbild aufloesen.
COPY --from=dependencies /dependencies/node_modules ./node_modules
COPY package.json ./package.json
COPY netlify/lib ./netlify/lib
COPY prompts ./prompts
# Laufzeit (Paket E2).
COPY runtime/quantus-v3/package.json ./runtime/quantus-v3/package.json
COPY runtime/quantus-v3/src ./runtime/quantus-v3/src

USER node
EXPOSE 8080

# Cloud Run prueft den Start per TCP. Es gibt bewusst KEINE anonyme
# HTTP-Gesundheitsroute.
CMD ["node", "runtime/quantus-v3/src/server.mjs"]
