# ══ Quantus Tagesbriefing v3 — Infrastruktur (Paket E2) ═══════════════════
#
# NICHT AUSGEROLLT. Diese Definitionen sind zur Pruefung da, nicht zum
# Anwenden. Es wurde kein `terraform init`, `plan` oder `apply` ausgefuehrt,
# kein Projekt angelegt, keine API aktiviert, kein Dienstkonto erzeugt und
# kein Schluessel angefasst.
#
# Bewusst NICHT enthalten:
#   · `google_project_service` — dieses Paket aktiviert keine
#     kostenpflichtigen Dienste. Welche APIs noetig sind, steht in README.md
#     als ausdruecklicher, von Hand zu pruefender Schritt.
#   · `google_secret_manager_secret_version` — in dieser Konfiguration
#     entsteht kein Geheimniswert. Geheimnisse werden ausserhalb angelegt
#     und hier nur ueber ihren Namen referenziert.
#   · jede konkrete Projekt-, Abrechnungs- oder Ressourcen-Id. Alles kommt
#     aus Variablen ohne Vorgabewert.
# ═════════════════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
