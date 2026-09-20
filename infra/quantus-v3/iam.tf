# ── Aufrufrechte: je Dienst genau EIN Konto ──────────────────────────────
#
# Es gibt nirgends `allUsers` oder `allAuthenticatedUsers`. Ein Dienst ist
# genau fuer das Konto aufrufbar, das ihn ausloesen soll.

resource "google_cloud_run_v2_service_iam_member" "worker_from_scheduler" {
  location = google_cloud_run_v2_service.worker.location
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_start.email}"
}

resource "google_cloud_run_v2_service_iam_member" "worker_from_tasks" {
  location = google_cloud_run_v2_service.worker.location
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.tasks.email}"
}

resource "google_cloud_run_v2_service_iam_member" "monitor_from_scheduler" {
  location = google_cloud_run_v2_service.monitor.location
  name     = google_cloud_run_v2_service.monitor.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_monitor.email}"
}

resource "google_cloud_run_v2_service_iam_member" "watchdog_from_scheduler" {
  location = google_cloud_run_v2_service.watchdog.location
  name     = google_cloud_run_v2_service.watchdog.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_watchdog.email}"
}

# Nur der Worker und der Monitor duerfen in die Warteschlange einreihen.
resource "google_cloud_tasks_queue_iam_member" "worker_enqueue" {
  location = google_cloud_tasks_queue.continuations.location
  name     = google_cloud_tasks_queue.continuations.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_cloud_tasks_queue_iam_member" "monitor_enqueue" {
  location = google_cloud_tasks_queue.continuations.location
  name     = google_cloud_tasks_queue.continuations.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.monitor.email}"
}

# Damit Worker und Monitor einen Task mit OIDC-Token des Task-Kontos
# erzeugen duerfen, brauchen sie darauf das Recht, Token auszustellen.
resource "google_service_account_iam_member" "worker_uses_tasks_identity" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_service_account_iam_member" "monitor_uses_tasks_identity" {
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.monitor.email}"
}

# ── Dienstagenten ────────────────────────────────────────────────────────
# Cloud Scheduler und Cloud Tasks stellen die OIDC-Token im Namen der oben
# angelegten Aufruferkonten aus. Dafuer braucht ihr jeweiliger Dienstagent
# das Recht, auf diesen Konten Token zu erzeugen. Die Adressen der
# Dienstagenten werden hier NICHT erfunden: ohne Variable entstehen die
# Bindungen nicht und muessen ausdruecklich von Hand gesetzt werden
# (siehe README).

locals {
  scheduler_caller_accounts = var.scheduler_service_agent_email == "" ? {} : {
    start    = google_service_account.scheduler_start.name
    monitor  = google_service_account.scheduler_monitor.name
    watchdog = google_service_account.scheduler_watchdog.name
  }
}

resource "google_service_account_iam_member" "scheduler_agent_tokens" {
  for_each           = local.scheduler_caller_accounts
  service_account_id = each.value
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.scheduler_service_agent_email}"
}

resource "google_service_account_iam_member" "tasks_agent_tokens" {
  count              = var.tasks_service_agent_email == "" ? 0 : 1
  service_account_id = google_service_account.tasks.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.tasks_service_agent_email}"
}
