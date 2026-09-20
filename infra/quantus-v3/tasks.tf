# ── Cloud Tasks: die Fortsetzungswarteschlange ───────────────────────────
#
# Die Werte spiegeln die Regeln aus Paket E1 wider:
#   hoechstens 5 Zustellungen, Backoff von 30 s bis 10 Minuten.
# Ein Task-Name ist stabil aus Lauf und Fortsetzung abgeleitet; ein bereits
# vorhandener Name wird von Cloud Tasks abgewiesen (ALREADY_EXISTS) und
# vom Worker als Dublette behandelt, nicht als Fehler.
#
# Die Grabsteinfrist eines Namens (bei ueber die Cloud-Tasks-API angelegten
# Queues standardmaessig etwa eine Stunde nach Ausfuehrung oder Loeschung)
# ist damit die ERSTE Verteidigungslinie. Verbindlich ist E1: eine
# Fortsetzung wird genau einmal verbraucht.

resource "google_cloud_tasks_queue" "continuations" {
  name     = "${local.prefix}-continuations"
  location = var.region

  rate_limits {
    # Ein Hauptlauf fuehrt zur Zeit, also wird auch nur eine Fortsetzung
    # zugestellt. Parallelitaet wuerde nur Lease-Konflikte erzeugen.
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 1
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "30s"
    max_backoff        = "600s"
    max_doublings      = 2
    max_retry_duration = "1800s"
  }

  stackdriver_logging_config {
    sampling_ratio = 1.0
  }
}
