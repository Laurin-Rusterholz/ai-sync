# ── Cloud Run: drei Dienste, ein Abbild ──────────────────────────────────
#
# Derselbe Container, drei Rollen. Die Trennung ist keine Kosmetik: jeder
# Dienst hat sein eigenes Dienstkonto, seine eigenen Aufruferrechte und
# seine eigenen Geheimnisse. Der Watchdog bekommt weder das
# Werkzeug-Zugangsdatum noch Rechte an der Warteschlange.
#
# Die Zeitgrenze des Dienstes (120 s) liegt bewusst ueber der eigenen
# Abschnittsfrist (90 s): der Worker beendet sich selbst mit einem
# Checkpoint, bevor die Plattform ihn abschneidet.

locals {
  gates_json = jsonencode(var.activation_gates)

  worker_url   = google_cloud_run_v2_service.worker.uri
  monitor_url  = google_cloud_run_v2_service.monitor.uri
  watchdog_url = google_cloud_run_v2_service.watchdog.uri

  endpoints_worker = jsonencode({
    "slot.start" = {
      audience               = "${google_cloud_run_v2_service.worker.uri}/v3/slot/start"
      allowedServiceAccounts = [google_service_account.scheduler_start.email]
    }
    "run.continue" = {
      audience               = "${google_cloud_run_v2_service.worker.uri}/v3/run/continue"
      allowedServiceAccounts = [google_service_account.tasks.email]
    }
  })

  endpoints_monitor = jsonencode({
    "monitor.tick" = {
      audience               = "${google_cloud_run_v2_service.monitor.uri}/v3/monitor/tick"
      allowedServiceAccounts = [google_service_account.scheduler_monitor.email]
    }
    "monitor.preflight" = {
      audience               = "${google_cloud_run_v2_service.monitor.uri}/v3/monitor/preflight"
      allowedServiceAccounts = [google_service_account.scheduler_monitor.email]
    }
  })

  endpoints_watchdog = jsonencode({
    "watchdog.check" = {
      audience               = "${google_cloud_run_v2_service.watchdog.uri}/v3/watchdog/check"
      allowedServiceAccounts = [google_service_account.scheduler_watchdog.email]
    }
  })

  common_env = [
    { name = "QUANTUS_V3_TENANT", value = var.tenant },
    { name = "QUANTUS_V3_POLICY_VERSION", value = var.policy_version },
    { name = "QUANTUS_V3_RUNTIME_MODE", value = var.runtime_mode },
    { name = "QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS", value = tostring(var.allow_external_effects) },
    { name = "QUANTUS_V3_ACTIVATION_GATES", value = local.gates_json },
  ]
}

resource "google_cloud_run_v2_service" "worker" {
  name                = "${local.prefix}-worker"
  location            = var.region
  ingress             = var.ingress
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.worker.email
    timeout                          = "120s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.image

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      env {
        name  = "QUANTUS_V3_RUNTIME_ROLE"
        value = "worker"
      }
      env {
        name  = "QUANTUS_V3_ENDPOINTS"
        value = local.endpoints_worker
      }
      env {
        name  = "QUANTUS_V3_TASKS_QUEUE"
        value = "projects/${var.project_id}/locations/${var.region}/queues/${google_cloud_tasks_queue.continuations.name}"
      }
      env {
        name  = "QUANTUS_V3_TASKS_TARGET_URL"
        value = "${google_cloud_run_v2_service.worker.uri}/v3/run/continue"
      }
      env {
        name  = "QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT"
        value = google_service_account.tasks.email
      }
      env {
        name  = "QUANTUS_V3_LEASE_HOLDER"
        # Jede Revision ist ein eigener Besitzer; ein Fence unterscheidet
        # zusaetzlich die Instanzen derselben Revision.
        value = "${local.prefix}-worker"
      }

      # Geheimnisse ausschliesslich als Verweis.
      env {
        name = "QUANTUS_V3_TOOL_SERVICE_CREDENTIAL"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.tool_credential.secret_id
            version = var.secret_version
          }
        }
      }
      env {
        name = "QUANTUS_V3_COST_POLICY"
        value_source {
          secret_key_ref {
            secret  = data.google_secret_manager_secret.cost_policy.secret_id
            version = var.secret_version
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  lifecycle {
    # Die Adresse des eigenen Dienstes wird in seine eigene Umgebung
    # geschrieben; das ist beim ersten Anlegen zwangslaeufig zweistufig.
    ignore_changes = []
  }
}

resource "google_cloud_run_v2_service" "monitor" {
  name                = "${local.prefix}-monitor"
  location            = var.region
  ingress             = var.ingress
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.monitor.email
    timeout                          = "120s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.image

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      env {
        name  = "QUANTUS_V3_RUNTIME_ROLE"
        value = "monitor"
      }
      env {
        name  = "QUANTUS_V3_ENDPOINTS"
        value = local.endpoints_monitor
      }
      env {
        name  = "QUANTUS_V3_MONITOR_START_LOCAL_DATE"
        value = var.monitor_start_local_date
      }
      env {
        name  = "QUANTUS_V3_TASKS_QUEUE"
        value = "projects/${var.project_id}/locations/${var.region}/queues/${google_cloud_tasks_queue.continuations.name}"
      }
      env {
        name  = "QUANTUS_V3_TASKS_TARGET_URL"
        value = "${google_cloud_run_v2_service.worker.uri}/v3/run/continue"
      }
      env {
        name  = "QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT"
        value = google_service_account.tasks.email
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "watchdog" {
  name                = "${local.prefix}-watchdog"
  location            = var.region
  ingress             = var.ingress
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.watchdog.email
    timeout                          = "60s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.image

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      env {
        name  = "QUANTUS_V3_RUNTIME_ROLE"
        value = "watchdog"
      }
      env {
        name  = "QUANTUS_V3_ENDPOINTS"
        value = local.endpoints_watchdog
      }
      # Kein QUANTUS_V3_TASKS_*: der Watchdog reiht nichts ein. Kein
      # Werkzeug-Zugangsdatum: er ruft keine Werkzeuge auf.

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }
    }
  }
}
