# ── Geheimnisse: nur Verweise ────────────────────────────────────────────
#
# Hier entsteht KEIN Geheimniswert. Es gibt bewusst keine
# `google_secret_manager_secret_version` — damit kann auch nichts davon im
# Terraform-Zustand landen. Die Geheimnisse werden ausserhalb angelegt und
# hier nur ueber ihren Namen gelesen.

data "google_secret_manager_secret" "tool_credential" {
  secret_id = var.tool_credential_secret_id
}

data "google_secret_manager_secret" "cost_policy" {
  secret_id = var.cost_policy_secret_id
}

# Nur der Worker liest das Werkzeug-Zugangsdatum. Monitor und Watchdog
# brauchen es nicht und bekommen es nicht.
resource "google_secret_manager_secret_iam_member" "worker_tool_credential" {
  secret_id = data.google_secret_manager_secret.tool_credential.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_cost_policy" {
  secret_id = data.google_secret_manager_secret.cost_policy.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}
