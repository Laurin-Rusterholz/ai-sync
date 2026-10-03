override_resource {
  target = google_service_account.worker
  values = {
    email = "quantus-worker@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-worker@quantus-test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.monitor
  values = {
    email = "quantus-monitor@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-monitor@quantus-test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.watchdog
  values = {
    email = "quantus-watchdog@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-watchdog@quantus-test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.scheduler_start
  values = {
    email = "quantus-scheduler-start@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-scheduler-start@quantus-test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.scheduler_monitor
  values = {
    email = "quantus-scheduler-monitor@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-scheduler-monitor@quantus-test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.scheduler_watchdog
  values = {
    email = "quantus-scheduler-watchdog@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-scheduler-watchdog@quantus-test-project.iam.gserviceaccount.com"
  }
}
override_resource {
  target = google_service_account.tasks
  values = {
    email = "quantus-tasks@quantus-test-project.iam.gserviceaccount.com"
    name  = "projects/quantus-test-project/serviceAccounts/quantus-tasks@quantus-test-project.iam.gserviceaccount.com"
  }
}
mock_provider "google" {
  mock_data "google_project" { defaults = { number = "123456789012" } }
}

run "render_runtime" {
  command = apply
  assert {
    condition     = toset([for env in google_cloud_run_v2_service.worker.template[0].containers[0].env : env.name if length(env.value_source) > 0]) == toset(keys(local.runtime_secrets.worker))
    error_message = "No role may receive secrets outside its declared contract."
  }
  assert {
    condition     = toset([for env in google_cloud_run_v2_service.monitor.template[0].containers[0].env : env.name if length(env.value_source) > 0]) == toset(keys(local.runtime_secrets.monitor))
    error_message = "No role may receive secrets outside its declared contract."
  }
  assert {
    condition     = toset([for env in google_cloud_run_v2_service.watchdog.template[0].containers[0].env : env.name if length(env.value_source) > 0]) == toset(keys(local.runtime_secrets.watchdog))
    error_message = "No role may receive secrets outside its declared contract."
  }
  assert {
    condition     = alltrue([for key, binding in local.runtime_secret_bindings : google_secret_manager_secret_iam_member.runtime[key].member == "serviceAccount:${local.runtime_accounts[binding.role]}" && google_secret_manager_secret_iam_member.runtime[key].role == "roles/secretmanager.secretAccessor"])
    error_message = "Secret access must belong to the corresponding role only."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service.worker.custom_audiences) == toset([for endpoint in values(jsondecode(local.endpoints_worker)) : endpoint.audience])
    error_message = "Cloud Run must accept every route-specific OIDC audience."
  }
  assert {
    condition     = alltrue([for name, value in local.runtime_public.worker : one([for env in google_cloud_run_v2_service.worker.template[0].containers[0].env : env.value if env.name == name]) == value])
    error_message = "The actual container must receive its complete public runtime configuration."
  }
  assert {
    condition     = alltrue([for name, key in local.runtime_secrets.worker : one([for env in google_cloud_run_v2_service.worker.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == name]) == local.runtime_secret_ids[key]])
    error_message = "Secret references must reach the actual runtime variable names."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service.monitor.custom_audiences) == toset([for endpoint in values(jsondecode(local.endpoints_monitor)) : endpoint.audience])
    error_message = "Cloud Run must accept every route-specific OIDC audience."
  }
  assert {
    condition     = alltrue([for name, value in local.runtime_public.monitor : one([for env in google_cloud_run_v2_service.monitor.template[0].containers[0].env : env.value if env.name == name]) == value])
    error_message = "The actual container must receive its complete public runtime configuration."
  }
  assert {
    condition     = alltrue([for name, key in local.runtime_secrets.monitor : one([for env in google_cloud_run_v2_service.monitor.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == name]) == local.runtime_secret_ids[key]])
    error_message = "Secret references must reach the actual runtime variable names."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service.watchdog.custom_audiences) == toset([for endpoint in values(jsondecode(local.endpoints_watchdog)) : endpoint.audience])
    error_message = "Cloud Run must accept every route-specific OIDC audience."
  }
  assert {
    condition     = alltrue([for name, value in local.runtime_public.watchdog : one([for env in google_cloud_run_v2_service.watchdog.template[0].containers[0].env : env.value if env.name == name]) == value])
    error_message = "The actual container must receive its complete public runtime configuration."
  }
  assert {
    condition     = alltrue([for name, key in local.runtime_secrets.watchdog : one([for env in google_cloud_run_v2_service.watchdog.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == name]) == local.runtime_secret_ids[key]])
    error_message = "Secret references must reach the actual runtime variable names."
  }
  assert {
    condition     = google_cloud_scheduler_job.slot["briefing04"].http_target[0].uri == "${local.worker_url}/v3/slot/start" && google_cloud_scheduler_job.slot["briefing04"].http_target[0].oidc_token[0].audience == jsondecode(local.endpoints_worker)["slot.start"].audience
    error_message = "Scheduler target and audience must agree with runtime authorization."
  }
  assert {
    condition     = google_storage_bucket.artifacts.public_access_prevention == "enforced" && google_storage_bucket.artifacts.uniform_bucket_level_access && !google_storage_bucket.artifacts.force_destroy
    error_message = "Original artifacts must be private and protected from forced deletion."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.artifact_worker.permissions) == toset(["storage.buckets.get", "storage.objects.get", "storage.objects.create"])
    error_message = "Artifact writer must not gain delete or IAM mutation permissions."
  }
  assert {
    condition     = output.scheduler_jobs_paused && var.runtime_mode == "dry_run" && !var.allow_external_effects
    error_message = "The infrastructure test must not enable live work."
  }
}

run "missing_setting_is_rejected" {
  command = plan
  variables { runtime_settings = {} }
  expect_failures = [var.runtime_settings]
}

run "missing_secret_is_rejected" {
  command = plan
  variables { runtime_secret_ids = {} }
  expect_failures = [var.runtime_secret_ids]
}

run "gmail_only_on_worker" {
  command = apply
  variables {
    gmail = {
      settings = {
        QUANTUS_V4_GMAIL_ACCOUNT          = "mail@quantus.test.invalid"
        QUANTUS_V4_GMAIL_SOURCE_ID        = "gmail-inbox"
        QUANTUS_V4_GOOGLE_NETLIFY_SITE_ID = "synthetic-site"
      }
      secret_ids = {
        gmail_netlify_token = "synthetic-netlify-token"
        gmail_client_id     = "synthetic-client-id"
        gmail_client_secret = "synthetic-client-secret"
      }
    }
  }
  assert {
    condition     = alltrue([for name in keys(local.runtime_contract.gmail.secrets) : contains([for env in google_cloud_run_v2_service.worker.template[0].containers[0].env : env.name], name)]) && alltrue([for role in ["monitor", "watchdog"] : length(setintersection(toset(keys(local.runtime_secrets[role])), toset(keys(local.runtime_contract.gmail.secrets)))) == 0])
    error_message = "Gmail credentials belong only to the worker."
  }
}

run "shared_secret_is_rejected" {
  command = plan
  variables { tool_credential_secret_id = "quantus-test-openai-api-key" }
  expect_failures = [var.runtime_secret_ids]
}

run "shadow_binding_reaches_each_runtime_without_opening_live_gates" {
  command = plan
  variables {
    runtime_mode = "shadow"
    shadow_binding = {
      schemaVersion   = 1
      sourceProjectId = "quantus-production-test"
      sourceTenant    = "production"
      sourceC2Origin  = "https://production.invalid"
      projectId       = "quantus-test-project"
      tenant          = "quantus"
      c2Origin        = "https://quantus.test.invalid"
      databaseUrl     = "https://quantus-test-project.firebaseio.com"
      ref             = "synthetic-test-only-isolation"
    }
  }
  assert {
    condition     = alltrue([for service in [google_cloud_run_v2_service.worker, google_cloud_run_v2_service.monitor, google_cloud_run_v2_service.watchdog] : length([for env in service.template[0].containers[0].env : env if env.name == "QUANTUS_V4_SHADOW_BINDING"]) == 1]) && var.activation_gates.trial14Days.passed == false && var.allow_external_effects == false
    error_message = "Every shadow role needs the same isolation binding without a fabricated live/trial approval."
  }
}

run "shadow_cannot_reuse_the_production_project" {
  command = plan
  variables {
    runtime_mode = "shadow"
    shadow_binding = {
      schemaVersion   = 1
      sourceProjectId = "quantus-test-project"
      sourceTenant    = "production"
      sourceC2Origin  = "https://production.invalid"
      projectId       = "quantus-test-project"
      tenant          = "quantus"
      c2Origin        = "https://quantus.test.invalid"
      databaseUrl     = "https://quantus-test-project.firebaseio.com"
      ref             = "synthetic-test-only-isolation"
    }
  }
  expect_failures = [var.shadow_binding]
}
