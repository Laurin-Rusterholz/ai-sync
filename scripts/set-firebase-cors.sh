#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Setzt die CORS-Konfiguration fuer den Firebase-Storage-Bucket, damit der
# Browser (Origin management-xo2-pro.netlify.app) Firebase Storage nicht mehr
# per CORS blockiert. Behebt den in der App gezeigten Hinweis dauerhaft.
#
# Voraussetzung:
#   - gsutil (Google Cloud SDK): https://cloud.google.com/sdk/docs/install
#   - Authentifizierung fuer das Projekt jupidu-36804:  gcloud auth login
# ---------------------------------------------------------------------------
set -euo pipefail
BUCKET="gs://jupidu-36804.firebasestorage.app"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORS_FILE="$DIR/firebase/cors.json"

if ! command -v gsutil >/dev/null 2>&1; then
  echo "gsutil nicht gefunden. Bitte Google Cloud SDK installieren:"
  echo "  https://cloud.google.com/sdk/docs/install"
  echo "Danach einmalig:  gcloud auth login   (Zugriff auf Projekt jupidu-36804)"
  exit 1
fi

echo "-> Setze CORS auf ${BUCKET} aus ${CORS_FILE} ..."
gsutil cors set "${CORS_FILE}" "${BUCKET}"
echo "OK. Pruefen mit:  gsutil cors get ${BUCKET}"
echo "Danach in der App im Firebase-Hinweis auf 'Erneut versuchen' klicken."
