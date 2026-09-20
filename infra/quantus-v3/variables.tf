# ── Eingaben ─────────────────────────────────────────────────────────────
# Keine Vorgabewerte fuer alles, was ein echtes Projekt bezeichnet. Die
# Validierungen weisen Platzhalter ausdruecklich ab, damit eine halb
# ausgefuellte Datei nicht versehentlich angewendet werden kann.

variable "project_id" {
  description = "Google-Cloud-Projekt. Muss vorhanden sein; wird hier nicht angelegt."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{5,29}$", var.project_id)) && !can(regex("(?i)replace|example|todo|changeme|xxx", var.project_id))
    error_message = "project_id fehlt oder ist noch ein Platzhalter."
  }
}

variable "region" {
  description = "Region fuer Cloud Run, Cloud Tasks und Cloud Scheduler."
  type        = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "region ist keine gueltige Google-Cloud-Region."
  }
}

variable "tenant" {
  description = "Mandantenkennung, geht in den Startschluessel tenant:datum:slot:policyVersion ein."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.tenant))
    error_message = "tenant ist unzulaessig."
  }
}

variable "policy_version" {
  description = "Fassung des Rechte- und Regelmodells, ebenfalls Teil des Startschluessels."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,32}$", var.policy_version))
    error_message = "policy_version ist unzulaessig."
  }
}

variable "runtime_mode" {
  description = "dry_run (Standard), shadow oder live. live ist nur mit allen Freigabetoren gueltig."
  type        = string
  default     = "dry_run"
  validation {
    condition     = contains(["dry_run", "shadow", "live"], var.runtime_mode)
    error_message = "runtime_mode muss dry_run, shadow oder live sein."
  }
}

variable "allow_external_effects" {
  description = "Nur zusammen mit runtime_mode=live UND allen Freigabetoren wirksam."
  type        = bool
  default     = false
}

variable "activation_gates" {
  description = <<-EOT
    Freigabetore mit Nachweis. ALLE muessen bestanden sein, bevor live
    erlaubt ist. Beispiel:
      { allWriterMigration = { passed = false, ref = "" }, ... }
  EOT
  type = map(object({
    passed = bool
    ref    = string
  }))
  default = {
    allWriterMigration    = { passed = false, ref = "" }
    authPackageAccepted   = { passed = false, ref = "" }
    costPolicyApproved    = { passed = false, ref = "" }
    restoreDrill          = { passed = false, ref = "" }
    monitorWatchdogProven = { passed = false, ref = "" }
    trial14Days           = { passed = false, ref = "" }
  }
  validation {
    condition = length(setsubtract(
      ["allWriterMigration", "authPackageAccepted", "costPolicyApproved", "restoreDrill", "monitorWatchdogProven", "trial14Days"],
      keys(var.activation_gates)
    )) == 0
    error_message = "activation_gates muss alle sechs Tore nennen."
  }
}

variable "image" {
  description = "Vollstaendige Abbildreferenz mit Digest. Ein beweglicher Tag ist nicht zulaessig."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.image))
    error_message = "image muss auf einen sha256-Digest zeigen (kein :latest)."
  }
}

variable "monitor_start_local_date" {
  description = "Ab diesem lokalen Datum sucht der Monitor nach fehlenden Slots."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", var.monitor_start_local_date))
    error_message = "monitor_start_local_date muss YYYY-MM-DD sein."
  }
}

# ── Geheimnisse: nur Namen, nie Werte ────────────────────────────────────

variable "tool_credential_secret_id" {
  description = "Secret-Manager-Name (nicht der Wert!) des Dienstzugangsdatums fuer die vier Quantus-Werkzeuge."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,255}$", var.tool_credential_secret_id))
    error_message = "tool_credential_secret_id ist ein Secret-NAME, kein Wert."
  }
}

variable "cost_policy_secret_id" {
  description = "Secret-Manager-Name des freigegebenen Preis- und Budgetstands."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,255}$", var.cost_policy_secret_id))
    error_message = "cost_policy_secret_id ist ein Secret-NAME, kein Wert."
  }
}

variable "secret_version" {
  description = "Version der referenzierten Geheimnisse. 'latest' oder eine Zahl."
  type        = string
  default     = "latest"
}

# ── Optional: Dienstagenten fuer die OIDC-Ausstellung ────────────────────
# Ohne Wert werden diese Bindungen nicht angelegt; sie stehen dann als
# ausdruecklicher Handgriff in der README.

variable "scheduler_service_agent_email" {
  description = "Dienstagent von Cloud Scheduler. Leer lassen, wenn die Bindung von Hand gesetzt wird."
  type        = string
  default     = ""
}

variable "tasks_service_agent_email" {
  description = "Dienstagent von Cloud Tasks. Leer lassen, wenn die Bindung von Hand gesetzt wird."
  type        = string
  default     = ""
}

variable "ingress" {
  description = <<-EOT
    Cloud-Run-Ingress. Die Zugangskontrolle ist IAM (run.invoker je genau
    einem Dienstkonto); Ingress ist die zweite Schranke. Vor dem Anwenden
    gegen die aktuelle Google-Dokumentation pruefen, ob Scheduler und Tasks
    im gewaehlten Aufbau als internal gelten.
  EOT
  type    = string
  default = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  validation {
    condition     = contains(["INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.ingress)
    error_message = "Oeffentlicher Ingress ist fuer diese Dienste nicht zulaessig."
  }
}

variable "deletion_protection" {
  description = "Loeschschutz der Cloud-Run-Dienste."
  type        = bool
  default     = true
}
