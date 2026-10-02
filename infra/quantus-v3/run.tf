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

data "google_project" "current" {}

locals {
  gates_json = jsonencode(var.activation_gates)

  worker_url   = "https://${local.prefix}-worker-${data.google_project.current.number}.${var.region}.run.app"
  monitor_url  = "https://${local.prefix}-monitor-${data.google_project.current.number}.${var.region}.run.app"
  watchdog_url = "https://${local.prefix}-watchdog-${data.google_project.current.number}.${var.region}.run.app"

  endpoints_worker = jsonencode({
    "slot.start" = {
      audience               = "${local.worker_url}/v3/slot/start"
      allowedServiceAccounts = [google_service_account.scheduler_start.email]
    }
    "run.continue" = {
      audience               = "${local.worker_url}/v3/run/continue"
      allowedServiceAccounts = [google_service_account.tasks.email]
    }
  })

  endpoints_monitor = jsonencode({
    "monitor.tick" = {
      audience               = "${local.monitor_url}/v3/monitor/tick"
      allowedServiceAccounts = [google_service_account.scheduler_monitor.email]
    }
    "monitor.preflight" = {
      audience               = "${local.monitor_url}/v3/monitor/preflight"
      allowedServiceAccounts = [google_service_account.scheduler_monitor.email]
    }
  })

  endpoints_watchdog = jsonencode({
    "watchdog.check" = {
      audience               = "${local.watchdog_url}/v3/watchdog/check"
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
  depends_on          = [google_secret_manager_secret_iam_member.runtime, google_storage_bucket_iam_member.artifact_worker]
  custom_audiences    = [for endpoint in values(jsondecode(local.endpoints_worker)) : endpoint.audience]
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
        for_each = local.runtime_public.worker
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.runtime_secrets.worker
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = data.google_secret_manager_secret.runtime[env.value].secret_id
              version = var.secret_version
            }
          }
        }
      }

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
        value = "${local.worker_url}/v3/run/continue"
      }
      env {
        name  = "QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT"
        value = google_service_account.tasks.email
      }
      env {
        name = "QUANTUS_V3_LEASE_HOLDER"
        # Jede Revision ist ein eigener Besitzer; ein Fence unterscheidet
        # zusaetzlich die Instanzen derselben Revision.
        value = "${local.prefix}-worker"
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

resource "google_cloud_run_v2_service" "monitor" {
  depends_on          = [google_secret_manager_secret_iam_member.runtime]
  custom_audiences    = [for endpoint in values(jsondecode(local.endpoints_monitor)) : endpoint.audience]
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
        for_each = local.runtime_public.monitor
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.runtime_secrets.monitor
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = data.google_secret_manager_secret.runtime[env.value].secret_id
              version = var.secret_version
            }
          }
        }
      }

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
        value = "${local.worker_url}/v3/run/continue"
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
  depends_on          = [google_secret_manager_secret_iam_member.runtime]
  custom_audiences    = [for endpoint in values(jsondecode(local.endpoints_watchdog)) : endpoint.audience]
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
        for_each = local.runtime_public.watchdog
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.runtime_secrets.watchdog
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = data.google_secret_manager_secret.runtime[env.value].secret_id
              version = var.secret_version
            }
          }
        }
      }

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
