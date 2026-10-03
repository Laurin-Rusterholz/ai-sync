data "google_project" "source" {}

resource "google_service_account" "broker" {
  account_id   = var.service_name
  display_name = "Quantus source commissioning broker"
}

locals {
  audience = "https://${var.service_name}-${data.google_project.source.number}.${var.region}.run.app/v4/commissioning/respond"
  authority = {
    schemaVersion   = 1
    audience        = local.audience
    serviceAccount  = var.shadow.worker_service_account
    sourceProjectId = var.project_id
    sourceTenant    = var.source_tenant
    shadowProjectId = var.shadow.project_id
    shadowTenant    = var.shadow.tenant
    bindingHash     = var.commissioning.binding_hash
    allocationId    = var.commissioning.allocation_id
    model           = var.commissioning.model
    profiles        = { for section, profile in var.commissioning.profiles : section => profile.hash }
    allowedRuns     = var.commissioning.allowed_runs
    maxStepIndex    = var.commissioning.max_step_index
  }
  public_env = merge({
    QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON         = jsonencode(local.authority)
    QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON     = jsonencode({ for section, profile in var.commissioning.profiles : section => profile.slot })
    QUANTUS_V4_COMMISSIONING_SOURCE_SERVICE_ACCOUNT = google_service_account.broker.email
    QUANTUS_V4_PROMPT_VERSION                       = var.prompt_version
    QUANTUS_V4_OPENAI_MODEL                         = var.commissioning.model
    QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK         = tostring(var.pricing.input_micros_per_million)
    QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK        = tostring(var.pricing.output_micros_per_million)
    QUANTUS_V4_ARTIFACT_BUCKET                      = google_storage_bucket.responses.name
    FIREBASE_PROJECT_ID                             = var.project_id
    FIREBASE_DATABASE_URL                           = var.database_url
  }, var.compaction_threshold == null ? {} : { QUANTUS_V4_OPENAI_COMPACT_THRESHOLD = tostring(var.compaction_threshold) })
  secret_env = {
    FIREBASE_SERVICE_ACCOUNT_JSON = "firebase"
    QUANTUS_V4_OPENAI_API_KEY     = "openai"
    QUANTUS_V3_COST_POLICY_JSON   = "cost_policy"
  }
}

data "google_secret_manager_secret" "runtime" {
  for_each  = var.secrets
  secret_id = each.value.id
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = var.secrets
  secret_id = data.google_secret_manager_secret.runtime[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.broker.email}"
}

resource "google_storage_bucket" "responses" {
  name                        = var.artifact_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
}

resource "google_project_iam_custom_role" "responses" {
  role_id     = "quantusBroker${substr(sha256(var.service_name), 0, 24)}"
  title       = "Quantus immutable source response storage"
  permissions = ["storage.buckets.get", "storage.objects.get", "storage.objects.create"]
}

resource "google_storage_bucket_iam_member" "responses" {
  bucket = google_storage_bucket.responses.name
  role   = google_project_iam_custom_role.responses.name
  member = "serviceAccount:${google_service_account.broker.email}"
}

resource "google_cloud_run_v2_service" "broker" {
  name                = var.service_name
  location            = var.region
  deletion_protection = true
  # The caller is in a separate project with no shared VPC assumed. Network
  # reachability does not confer permission: IAM and the signed route token
  # independently require the one reviewed shadow account.
  ingress          = "INGRESS_TRAFFIC_ALL"
  custom_audiences = [local.audience]
  depends_on       = [google_secret_manager_secret_iam_member.runtime, google_storage_bucket_iam_member.responses]

  template {
    service_account                  = google_service_account.broker.email
    timeout                          = "90s"
    max_instance_request_concurrency = 1
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image   = var.image
      command = ["node"]
      args    = ["runtime/quantus-v3/src/commissioning-server.mjs"]
      dynamic "env" {
        for_each = local.public_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = data.google_secret_manager_secret.runtime[env.value].secret_id
              version = var.secrets[env.value].version
            }
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
}

# Authoritative for this role on this dedicated service. Do not combine with
# other run.invoker member/binding resources for the same service.
resource "google_cloud_run_v2_service_iam_binding" "caller" {
  location = google_cloud_run_v2_service.broker.location
  name     = google_cloud_run_v2_service.broker.name
  role     = "roles/run.invoker"
  members  = ["serviceAccount:${var.shadow.worker_service_account}"]
}

output "worker_connection" {
  description = "Public reviewed connection for the isolated module; contains no provider key or source credential."
  value = {
    audience       = local.audience
    serviceAccount = var.shadow.worker_service_account
    bindingHash    = var.commissioning.binding_hash
    allocationId   = var.commissioning.allocation_id
    profiles       = { for section, profile in var.commissioning.profiles : profile.slot => { id = section, hash = profile.hash } }
  }
}

output "source_service_account" {
  description = "The existing Firebase credential secret must contain exactly this project/account. No key is generated here."
  value       = google_service_account.broker.email
}
