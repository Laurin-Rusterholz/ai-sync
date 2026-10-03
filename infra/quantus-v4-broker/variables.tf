variable "project_id" {
  description = "Existing source project, containing the authoritative cost ledger and Firebase database."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "A valid source project ID is required."
  }
}

variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "A Google Cloud region is required."
  }
}

variable "service_name" {
  description = "Dedicated broker service and attached account ID."
  type        = string
  default     = "quantus-v4-broker"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.service_name))
    error_message = "Use a 6-30 character service/account ID."
  }
}

variable "image" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.image))
    error_message = "The reviewed runtime image must be pinned by digest."
  }
}

variable "source_tenant" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.source_tenant)) && !strcontains(var.source_tenant, "__")
    error_message = "A concrete source tenant is required."
  }
}

variable "database_url" {
  type = string
  validation {
    condition     = can(regex("^https://(${var.project_id}\\.firebaseio\\.com|${var.project_id}-default-rtdb(\\.[a-z0-9-]+)?\\.firebasedatabase\\.app)$", var.database_url))
    error_message = "The database URL must be the canonical source project's Firebase endpoint."
  }
}

variable "shadow" {
  description = "Reviewed isolated caller; no grants to a project, group or anonymous caller."
  type = object({
    project_id             = string
    tenant                 = string
    worker_service_account = string
  })
  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.shadow.project_id)) &&
      var.shadow.project_id != var.project_id && var.shadow.tenant != var.source_tenant &&
      can(regex("^[A-Za-z0-9_-]{1,64}$", var.shadow.tenant)) && !strcontains(var.shadow.tenant, "__") &&
      can(regex("^[a-z][a-z0-9-]*@${var.shadow.project_id}\\.iam\\.gserviceaccount\\.com$", var.shadow.worker_service_account))
    )
    error_message = "The caller must be one service account in a distinct shadow project and tenant."
  }
}

variable "commissioning" {
  description = "Reviewed source allocation identity and bounded run/profile allowlist. This does not reserve an allocation."
  type = object({
    binding_hash   = string
    allocation_id  = string
    model          = string
    profiles       = map(object({ slot = string, hash = string }))
    allowed_runs   = list(string)
    max_step_index = number
  })
  validation {
    condition = (
      can(regex("^[a-f0-9]{64}$", var.commissioning.binding_hash)) &&
      can(regex("^[A-Za-z0-9_.:-]{1,120}$", var.commissioning.allocation_id)) && !strcontains(var.commissioning.allocation_id, "__") &&
      length(trimspace(var.commissioning.model)) > 0 &&
      length(var.commissioning.profiles) > 0 && length(var.commissioning.profiles) <= 4 &&
      length(distinct([for profile in values(var.commissioning.profiles) : profile.slot])) == length(var.commissioning.profiles) &&
      alltrue([for section, profile in var.commissioning.profiles :
        can(regex("^[A-Za-z0-9_.:-]{1,120}$", section)) && !strcontains(section, "__") &&
      contains(["briefing04", "process09", "continue14", "close23"], profile.slot) && can(regex("^[a-f0-9]{64}$", profile.hash))]) &&
      length(var.commissioning.allowed_runs) > 0 && length(var.commissioning.allowed_runs) <= 124 &&
      length(distinct(var.commissioning.allowed_runs)) == length(var.commissioning.allowed_runs) &&
      alltrue([for run in var.commissioning.allowed_runs : can(regex("^${var.shadow.tenant}:[0-9]{4}-[0-9]{2}-[0-9]{2}:(briefing04|process09|continue14|close23):[A-Za-z0-9._-]{1,32}$", run))]) &&
      var.commissioning.max_step_index >= 0 && var.commissioning.max_step_index <= 4095 && floor(var.commissioning.max_step_index) == var.commissioning.max_step_index
    )
    error_message = "Commissioning requires bounded unique shadow runs, unique reviewed slot profiles, a SHA256 binding and an integer step limit."
  }
}

variable "prompt_version" {
  type    = string
  default = "4.0.0"
  validation {
    condition     = var.prompt_version == "4.0.0"
    error_message = "Only the reviewed v4 prompt is supported."
  }
}

variable "pricing" {
  description = "Approved integer USD micros per million tokens; must agree with the separately stored cost policy."
  type = object({
    input_micros_per_million  = number
    output_micros_per_million = number
  })
  validation {
    condition     = alltrue([for n in values(var.pricing) : n >= 0 && n <= 9007199254740991 && floor(n) == n])
    error_message = "Pricing must contain safe non-negative integers."
  }
}

variable "compaction_threshold" {
  type    = number
  default = null
  validation {
    condition     = var.compaction_threshold == null ? true : var.compaction_threshold >= 1000 && var.compaction_threshold <= 100000 && floor(var.compaction_threshold) == var.compaction_threshold
    error_message = "Optional compaction threshold must be an integer from 1000 to 100000."
  }
}

variable "artifact_bucket_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$", var.artifact_bucket_name))
    error_message = "Use a dedicated valid private artifact bucket name."
  }
}

variable "secrets" {
  description = "Exactly three pre-existing secret references and pinned numeric versions; never secret values."
  type        = map(object({ id = string, version = string }))
  validation {
    condition = (
      toset(keys(var.secrets)) == toset(["firebase", "openai", "cost_policy"]) &&
      length(distinct([for secret in values(var.secrets) : secret.id])) == 3 &&
      alltrue([for secret in values(var.secrets) : can(regex("^[A-Za-z0-9_-]{1,255}$", secret.id)) && can(regex("^[1-9][0-9]*$", secret.version))])
    )
    error_message = "Provide distinct Firebase, OpenAI and cost-policy secret names with pinned positive versions."
  }
}
