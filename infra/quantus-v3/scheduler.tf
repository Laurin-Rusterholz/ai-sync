# ── Cloud Scheduler: vier benannte Hauptlaeufe, ein Monitor, ein Vorabcheck,
#    ein getrennter Watchdog ──────────────────────────────────────────────
#
# Genau VIER Hauptslots — 04:00, 09:00, 14:00, 23:00 Europe/Zurich. Der
# 22:30-Vorabcheck ist KEIN fuenfter Hauptauftrag: er ruft eine andere
# Route auf, die strukturell nur bestehende Verpflichtungen reparieren kann.
#
# ALLE Jobs stehen auf `paused = true`. Nichts feuert, bevor jemand die
# Freigabetore geprueft und den Job ausdruecklich aktiviert hat. Das ist
# die wichtigste einzelne Zeile in dieser Datei.
#
# `attempt_deadline` liegt fuer die Hauptlaeufe bei 100 s: der Worker
# beendet seinen Abschnitt selbst nach hoechstens 90 s mit einem
# Checkpoint. Der erlaubte Bereich ist 15 s bis 30 min.

locals {
  slots = {
    briefing04 = { cron = "0 4 * * *", purpose = "Tag eroeffnen" }
    process09  = { cron = "0 9 * * *", purpose = "bearbeiten" }
    continue14 = { cron = "0 14 * * *", purpose = "fortsetzen" }
    close23    = { cron = "0 23 * * *", purpose = "abschliessen" }
  }

  slot_retry = {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "600s"
    max_doublings        = 2
    max_retry_duration   = "1800s"
  }
}

resource "google_cloud_scheduler_job" "slot" {
  for_each = local.slots

  name        = "${local.prefix}-slot-${each.key}"
  description = "Quantus v3 Hauptlauf ${each.key} (${each.value.purpose})"
  region      = var.region
  schedule    = each.value.cron
  time_zone   = "Europe/Zurich"
  paused      = true

  attempt_deadline = "100s"

  retry_config {
    retry_count          = local.slot_retry.retry_count
    min_backoff_duration = local.slot_retry.min_backoff_duration
    max_backoff_duration = local.slot_retry.max_backoff_duration
    max_doublings        = local.slot_retry.max_doublings
    max_retry_duration   = local.slot_retry.max_retry_duration
  }

  http_target {
    uri         = "${google_cloud_run_v2_service.worker.uri}/v3/slot/start"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    # Nur der Slotname. Mandant, Policy-Version und lokales Datum bestimmt
    # der Server; eine Wiederholung nach Mitternacht trifft deshalb
    # denselben Slot und nicht den Folgetag.
    body = base64encode(jsonencode({ slot = each.key }))

    oidc_token {
      service_account_email = google_service_account.scheduler_start.email
      audience              = "${google_cloud_run_v2_service.worker.uri}/v3/slot/start"
    }
  }
}

resource "google_cloud_scheduler_job" "monitor_tick" {
  name        = "${local.prefix}-monitor-tick"
  description = "Quantus v3 unabhaengiger Monitor, alle fuenf Minuten"
  region      = var.region
  schedule    = "*/5 * * * *"
  time_zone   = "Europe/Zurich"
  paused      = true

  attempt_deadline = "60s"

  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
    max_doublings        = 1
    max_retry_duration   = "240s"
  }

  http_target {
    uri         = "${google_cloud_run_v2_service.monitor.uri}/v3/monitor/tick"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler_monitor.email
      audience              = "${google_cloud_run_v2_service.monitor.uri}/v3/monitor/tick"
    }
  }
}

resource "google_cloud_scheduler_job" "monitor_preflight" {
  name        = "${local.prefix}-monitor-preflight"
  description = "Quantus v3 Vorabcheck 22:30 — repariert nur Bestehendes, kein fuenfter Hauptauftrag"
  region      = var.region
  schedule    = "30 22 * * *"
  time_zone   = "Europe/Zurich"
  paused      = true

  attempt_deadline = "60s"

  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
    max_doublings        = 1
    max_retry_duration   = "240s"
  }

  http_target {
    uri         = "${google_cloud_run_v2_service.monitor.uri}/v3/monitor/preflight"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler_monitor.email
      audience              = "${google_cloud_run_v2_service.monitor.uri}/v3/monitor/preflight"
    }
  }
}

# Der Watchdog laeuft versetzt und in einem eigenen Dienst mit eigenem
# Konto. Wuerde er denselben Zeitplan, dieselbe Laufzeit und dieselben
# Zugaenge benutzen, fiele er mit dem Monitor zusammen aus.
resource "google_cloud_scheduler_job" "watchdog" {
  name        = "${local.prefix}-watchdog"
  description = "Quantus v3 Watchdog ueber den Monitor — eigener Zeitplan, eigenes Konto, keine Warteschlange"
  region      = var.region
  schedule    = "7-59/15 * * * *"
  time_zone   = "Europe/Zurich"
  paused      = true

  attempt_deadline = "60s"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
    max_doublings        = 1
    max_retry_duration   = "900s"
  }

  http_target {
    uri         = "${google_cloud_run_v2_service.watchdog.uri}/v3/watchdog/check"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler_watchdog.email
      audience              = "${google_cloud_run_v2_service.watchdog.uri}/v3/watchdog/check"
    }
  }
}
