mock_provider "google" {
  mock_data "google_project" { defaults = { number = "123456789012" } }
}

override_resource {
  target = google_service_account.broker
  values = {
    email = "quantus-v4-broker@source-invalid.iam.gserviceaccount.com"
    name  = "projects/source-invalid/serviceAccounts/quantus-v4-broker@source-invalid.iam.gserviceaccount.com"
  }
}

run "render_source_broker" {
  command = apply
  assert {
    condition     = google_cloud_run_v2_service.broker.template[0].containers[0].command == tolist(["node"]) && google_cloud_run_v2_service.broker.template[0].containers[0].args == tolist(["runtime/quantus-v3/src/commissioning-server.mjs"])
    error_message = "The service must start the dedicated broker, not the ordinary worker."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service_iam_binding.caller.members) == toset(["serviceAccount:${var.shadow.worker_service_account}"]) && google_cloud_run_v2_service_iam_binding.caller.role == "roles/run.invoker"
    error_message = "Only the approved shadow account receives invocation permission."
  }
  assert {
    condition     = toset(google_cloud_run_v2_service.broker.custom_audiences) == toset([local.authority.audience]) && local.authority.audience == output.worker_connection.audience
    error_message = "Cloud Run, application and isolated client must use the same route audience."
  }
  assert {
    condition     = google_cloud_run_v2_service.broker.template[0].service_account == google_service_account.broker.email && local.public_env.QUANTUS_V4_COMMISSIONING_SOURCE_SERVICE_ACCOUNT == google_service_account.broker.email
    error_message = "Attached and secret-backed source identities must agree."
  }
  assert {
    condition     = toset([for env in google_cloud_run_v2_service.broker.template[0].containers[0].env : env.name]) == setunion(toset(keys(local.public_env)), toset(keys(local.secret_env)))
    error_message = "The broker receives its exact environment, no ordinary live flags, queue permission or tool credential."
  }
  assert {
    condition     = alltrue([for name, key in local.secret_env : one([for env in google_cloud_run_v2_service.broker.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].secret if env.name == name]) == var.secrets[key].id && one([for env in google_cloud_run_v2_service.broker.template[0].containers[0].env : env.value_source[0].secret_key_ref[0].version if env.name == name]) == var.secrets[key].version])
    error_message = "Secret names and pinned versions must reach the correct runtime variables."
  }
  assert {
    condition     = alltrue([for binding in values(google_secret_manager_secret_iam_member.runtime) : binding.member == "serviceAccount:${google_service_account.broker.email}" && binding.role == "roles/secretmanager.secretAccessor"])
    error_message = "Source/provider secrets may only be read by the broker account."
  }
  assert {
    condition     = google_storage_bucket.responses.uniform_bucket_level_access && google_storage_bucket.responses.public_access_prevention == "enforced" && !google_storage_bucket.responses.force_destroy && toset(google_project_iam_custom_role.responses.permissions) == toset(["storage.buckets.get", "storage.objects.get", "storage.objects.create"]) && google_storage_bucket_iam_member.responses.member == "serviceAccount:${google_service_account.broker.email}"
    error_message = "Response artifacts require private immutable access for the actual source credential identity."
  }
  assert {
    condition     = output.worker_connection.bindingHash == local.authority.bindingHash && alltrue([for section, profile in var.commissioning.profiles : output.worker_connection.profiles[profile.slot].id == section && output.worker_connection.profiles[profile.slot].hash == local.authority.profiles[section]])
    error_message = "The isolated client must receive the exact reviewed source profile hashes."
  }
}

run "reject_shared_source_project" {
  command = plan
  variables {
    shadow = { project_id = "source-invalid", tenant = "shadow", worker_service_account = "worker@source-invalid.iam.gserviceaccount.com" }
  }
  expect_failures = [var.shadow]
}

run "reject_wrong_caller_project" {
  command = plan
  variables {
    shadow = { project_id = "shadow-invalid", tenant = "shadow", worker_service_account = "worker@foreign-invalid.iam.gserviceaccount.com" }
  }
  expect_failures = [var.shadow]
}

run "reject_source_run" {
  command = plan
  variables {
    commissioning = merge(jsondecode(file("tests/broker-fixture.json")).commissioning, { allowed_runs = ["quantus:2026-10-02:process09:4.0"] })
  }
  expect_failures = [var.commissioning]
}

run "reject_mutable_image" {
  command = plan
  variables { image = "registry.invalid/quantus:latest" }
  expect_failures = [var.image]
}

run "reject_foreign_database" {
  command = plan
  variables { database_url = "https://shadow-invalid.firebaseio.com" }
  expect_failures = [var.database_url]
}

run "reject_extra_secret" {
  command = plan
  variables {
    secrets = merge(jsondecode(file("tests/broker-fixture.json")).secrets, { tool = { id = "test-tool", version = "1" } })
  }
  expect_failures = [var.secrets]
}

run "reject_unpinned_secret" {
  command = plan
  variables {
    secrets = merge(jsondecode(file("tests/broker-fixture.json")).secrets, { openai = { id = "test-openai", version = "latest" } })
  }
  expect_failures = [var.secrets]
}
