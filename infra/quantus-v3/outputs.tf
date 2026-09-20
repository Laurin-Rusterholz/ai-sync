# ── Ausgaben ─────────────────────────────────────────────────────────────
# Nur Namen und Adressen. Kein Geheimnis, kein Token, kein Schluessel.

output "service_urls" {
  description = "Adressen der drei Dienste."
  value = {
    worker   = google_cloud_run_v2_service.worker.uri
    monitor  = google_cloud_run_v2_service.monitor.uri
    watchdog = google_cloud_run_v2_service.watchdog.uri
  }
}

output "service_accounts" {
  description = "Die sieben getrennten Dienstkonten."
  value = {
    worker             = google_service_account.worker.email
    monitor            = google_service_account.monitor.email
    watchdog           = google_service_account.watchdog.email
    scheduler_start    = google_service_account.scheduler_start.email
    scheduler_monitor  = google_service_account.scheduler_monitor.email
    scheduler_watchdog = google_service_account.scheduler_watchdog.email
    tasks              = google_service_account.tasks.email
  }
}

output "tasks_queue" {
  description = "Vollstaendiger Pfad der Fortsetzungswarteschlange."
  value       = "projects/${var.project_id}/locations/${var.region}/queues/${google_cloud_tasks_queue.continuations.name}"
}

output "scheduler_jobs_paused" {
  description = "Solange dies true ist, feuert nichts."
  value = alltrue(concat(
    [for job in google_cloud_scheduler_job.slot : job.paused],
    [google_cloud_scheduler_job.monitor_tick.paused,
    google_cloud_scheduler_job.monitor_preflight.paused,
    google_cloud_scheduler_job.watchdog.paused],
  ))
}
