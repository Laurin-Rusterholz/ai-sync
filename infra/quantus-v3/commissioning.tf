# Explicit isolated permissions. No source budget allocation, scheduler
# activation or successful live/trial gate is inferred from these inputs.
variable "commissioning_worker" {
  description = "Reviewed isolated worker permission without provider credentials; null preserves the ordinary worker."
  type = object({
    connection = object({
      audience       = string
      serviceAccount = string
      bindingHash    = string
      allocationId   = string
      profiles       = map(object({ id = string, hash = string }))
    })
    isolatedDomain = bool
    sourceReadIds  = list(string)
  })
  default = null
  validation {
    condition = var.commissioning_worker == null ? true : (
      var.runtime_mode == "shadow" && var.shadow_binding != null && var.commissioning_worker.isolatedDomain &&
      can(regex("^[a-f0-9]{64}$", var.commissioning_worker.connection.bindingHash)) &&
      can(regex("^https://[a-z0-9.-]+(:[0-9]+)?/v4/commissioning/respond$", var.commissioning_worker.connection.audience)) &&
      can(regex("^[A-Za-z0-9_.:-]{1,120}$", var.commissioning_worker.connection.allocationId)) &&
      !strcontains(var.commissioning_worker.connection.allocationId, "__") &&
      length(var.commissioning_worker.sourceReadIds) == length(distinct(var.commissioning_worker.sourceReadIds)) &&
      alltrue([for id in var.commissioning_worker.sourceReadIds : length(trimspace(id)) > 0]) &&
      length(var.commissioning_worker.connection.profiles) > 0 &&
      alltrue([for slot, profile in var.commissioning_worker.connection.profiles :
        contains(["briefing04", "process09", "continue14", "close23"], slot) &&
        can(regex("^[A-Za-z0-9_.:-]{1,120}$", profile.id)) && !strcontains(profile.id, "__") &&
        can(regex("^[a-f0-9]{64}$", profile.hash))
      ])
    )
    error_message = "Commissioning requires isolated shadow storage, explicit domain permission and valid reviewed source profiles."
  }
}

variable "commissioning_tasks" {
  description = "Reviewed time window and isolation hash for this deployment's exact continuation queue and worker."
  type        = object({ binding_hash = string, approved_at_ms = number, expires_at_ms = number })
  default     = null
  validation {
    condition = var.commissioning_tasks == null ? true : (
      var.runtime_mode == "shadow" && var.shadow_binding != null &&
      can(regex("^[a-f0-9]{64}$", var.commissioning_tasks.binding_hash)) &&
      var.commissioning_tasks.approved_at_ms > 0 && floor(var.commissioning_tasks.approved_at_ms) == var.commissioning_tasks.approved_at_ms &&
      var.commissioning_tasks.expires_at_ms > var.commissioning_tasks.approved_at_ms &&
      var.commissioning_tasks.expires_at_ms <= 9007199254740991 && floor(var.commissioning_tasks.expires_at_ms) == var.commissioning_tasks.expires_at_ms &&
      (var.commissioning_worker == null ? true : var.commissioning_tasks.binding_hash == var.commissioning_worker.connection.bindingHash)
    )
    error_message = "Continuation permission requires isolated shadow storage, matching binding and a finite integer time window."
  }
}

locals {
  commissioning_worker_env = var.commissioning_worker == null ? {} : {
    QUANTUS_V4_COMMISSIONING_WORKER_JSON = jsonencode(merge({ schemaVersion = 1 }, var.commissioning_worker))
  }
  commissioning_tasks_env = var.commissioning_tasks == null ? {} : {
    QUANTUS_V4_COMMISSIONING_TASKS_JSON = jsonencode({
      schemaVersion      = 1
      bindingHash        = var.commissioning_tasks.binding_hash
      queue              = "projects/${var.project_id}/locations/${var.region}/queues/${google_cloud_tasks_queue.continuations.name}"
      targetUrl          = "${local.worker_url}/v3/run/continue"
      audience           = "${local.worker_url}/v3/run/continue"
      oidcServiceAccount = google_service_account.tasks.email
      approvedAtMs       = var.commissioning_tasks.approved_at_ms
      expiresAtMs        = var.commissioning_tasks.expires_at_ms
    })
  }
}
