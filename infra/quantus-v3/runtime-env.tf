locals {
  runtime_contract          = jsondecode(file("${path.module}/runtime-env.json"))
  runtime_settings_required = toset(flatten(values(local.runtime_contract.public)))
  runtime_secret_ids = merge(var.runtime_secret_ids, {
    tool_credential = var.tool_credential_secret_id
    cost_policy     = var.cost_policy_secret_id
  }, var.gmail == null ? {} : var.gmail.secret_ids)
  runtime_public = {
    for role, names in local.runtime_contract.public : role => merge(
      { for name in names : name => var.runtime_settings[name] },
      { QUANTUS_V3_EXPECTED_SERVICE_ACCOUNT = local.runtime_accounts[role] },
      role == "worker" ? { QUANTUS_V3_FIREBASE_TENANT = var.tenant, QUANTUS_V3_MODE = "enforce" } : {},
      role == "worker" && var.gmail != null ? var.gmail.settings : {}
    )
  }
  runtime_secrets = {
    for role, mapping in local.runtime_contract.secrets : role => merge(mapping,
    role == "worker" && var.gmail != null ? local.runtime_contract.gmail.secrets : {})
  }
  runtime_secret_bindings = merge([
    for role, mapping in local.runtime_secrets : {
      for key in distinct(values(mapping)) : "${role}-${key}" => { role = role, key = key }
    }
  ]...)
  runtime_accounts = {
    worker   = google_service_account.worker.email
    monitor  = google_service_account.monitor.email
    watchdog = google_service_account.watchdog.email
  }
}

variable "runtime_settings" {
  description = "Non-secret values for exactly the public environment names in runtime-env.json; never credentials."
  type        = map(string)
  validation {
    condition     = length(setsubtract(local.runtime_settings_required, toset(keys(var.runtime_settings)))) == 0 && length(setsubtract(toset(keys(var.runtime_settings)), local.runtime_settings_required)) == 0
    error_message = "runtime_settings must match the public runtime environment contract exactly."
  }
  validation {
    condition     = alltrue([for value in values(var.runtime_settings) : length(trimspace(value)) > 0 && !can(regex("(?i)REPLACE|BEGIN.*PRIVATE KEY|^sk-", value))])
    error_message = "Public runtime settings must be non-empty, concrete and contain no credentials."
  }
}

variable "runtime_secret_ids" {
  description = "Existing Secret Manager NAMES only, with role-specific Firebase service-account JSON; no secret values."
  type        = map(string)
  validation {
    condition     = toset(keys(var.runtime_secret_ids)) == toset(["firebase_worker", "firebase_monitor", "firebase_watchdog", "assistant_policy", "worker_token_keys", "service_credentials", "openai_api_key"])
    error_message = "runtime_secret_ids must provide exactly the seven required secret references."
  }
  validation {
    condition     = alltrue([for id in values(var.runtime_secret_ids) : can(regex("^[A-Za-z0-9_-]{1,255}$", id)) && !can(regex("(?i)REPLACE|TODO|CHANGEME", id))]) && length(distinct(concat(values(var.runtime_secret_ids), [var.tool_credential_secret_id, var.cost_policy_secret_id], var.gmail == null ? [] : values(var.gmail.secret_ids)))) == length(var.runtime_secret_ids) + 2 + (var.gmail == null ? 0 : length(var.gmail.secret_ids))
    error_message = "Secret names must be concrete, valid and distinct."
  }
}

variable "gmail" {
  description = "Optional, complete Gmail configuration. Required when the policy declares a Gmail/mail source. No secret values."
  type        = object({ settings = map(string), secret_ids = map(string) })
  default     = null
  validation {
    condition     = var.gmail == null ? true : toset(keys(var.gmail.settings)) == toset(local.runtime_contract.gmail.public) && toset(keys(var.gmail.secret_ids)) == toset(values(local.runtime_contract.gmail.secrets))
    error_message = "Gmail configuration must include all and only its public settings and secret names."
  }
  validation {
    condition     = var.gmail == null ? true : alltrue([for id in values(var.gmail.secret_ids) : can(regex("^[A-Za-z0-9_-]{1,255}$", id)) && !can(regex("(?i)REPLACE|TODO|CHANGEME", id))])
    error_message = "Gmail secret references must be real Secret Manager names."
  }
}

data "google_secret_manager_secret" "runtime" {
  for_each  = local.runtime_secret_ids
  secret_id = each.value
}
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = local.runtime_secret_bindings
  secret_id = data.google_secret_manager_secret.runtime[each.value.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_accounts[each.value.role]}"
}

resource "google_storage_bucket" "artifacts" {
  name                        = var.runtime_settings["QUANTUS_V4_ARTIFACT_BUCKET"]
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
}
resource "google_project_iam_custom_role" "artifact_worker" {
  role_id     = "quantusArtifact${substr(sha256(var.tenant), 0, 24)}"
  title       = "Quantus immutable artifact writer"
  permissions = ["storage.buckets.get", "storage.objects.get", "storage.objects.create"]
}
resource "google_storage_bucket_iam_member" "artifact_worker" {
  bucket = google_storage_bucket.artifacts.name
  role   = google_project_iam_custom_role.artifact_worker.name
  member = "serviceAccount:${google_service_account.worker.email}"
}
