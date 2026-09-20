# ── Dienstkonten: getrennt, mit je einer Aufgabe ─────────────────────────
#
# Sieben Konten statt eines. Der Sinn ist nicht Ordnung, sondern Wirkung:
# das Konto, das den Slot startet, kann keine Fortsetzung einwerfen, und
# der Watchdog kommt an nichts heran, was der Monitor braucht. Jede
# Cloud-Run-Route nimmt genau EIN Aufruferkonto an.

locals {
  prefix = "quantus-v3"
}

# Laufzeitkonten (identity der Dienste)
resource "google_service_account" "worker" {
  account_id   = "${local.prefix}-worker"
  display_name = "Quantus v3 Worker (Slotstart und Fortsetzung)"
  description  = "Laufzeitidentitaet des kurzen HTTP-Workers. Darf Tasks einreihen und die freigegebenen Geheimnisse lesen."
}

resource "google_service_account" "monitor" {
  account_id   = "${local.prefix}-monitor"
  display_name = "Quantus v3 Monitor (5 Minuten und Vorabcheck)"
  description  = "Laufzeitidentitaet des unabhaengigen Monitors."
}

resource "google_service_account" "watchdog" {
  account_id   = "${local.prefix}-watchdog"
  display_name = "Quantus v3 Watchdog"
  description  = "Laufzeitidentitaet des Watchdogs. Bewusst OHNE Zugriff auf Cloud Tasks und ohne Aufruf des Monitors."
}

# Aufruferkonten (identity der Ausloeser)
resource "google_service_account" "scheduler_start" {
  account_id   = "${local.prefix}-sched-start"
  display_name = "Quantus v3 Scheduler -> Slotstart"
  description  = "Darf ausschliesslich /v3/slot/start aufrufen."
}

resource "google_service_account" "scheduler_monitor" {
  account_id   = "${local.prefix}-sched-monitor"
  display_name = "Quantus v3 Scheduler -> Monitor"
  description  = "Darf ausschliesslich /v3/monitor/tick und /v3/monitor/preflight aufrufen."
}

resource "google_service_account" "scheduler_watchdog" {
  account_id   = "${local.prefix}-sched-watchdog"
  display_name = "Quantus v3 Scheduler -> Watchdog"
  description  = "Darf ausschliesslich /v3/watchdog/check aufrufen."
}

resource "google_service_account" "tasks" {
  account_id   = "${local.prefix}-tasks"
  display_name = "Quantus v3 Cloud Tasks -> Fortsetzung"
  description  = "Darf ausschliesslich /v3/run/continue aufrufen."
}
