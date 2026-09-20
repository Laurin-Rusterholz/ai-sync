# Quantus v3 — Infrastruktur (Paket E2)

**Nicht ausgerollt.** Kein `terraform init`, kein `plan`, kein `apply`, kein
Projekt, keine aktivierte API, kein Dienstkonto, kein Schluessel. Diese
Dateien sind zur Pruefung da.

## Was hier steht

| Datei | Inhalt |
| --- | --- |
| `variables.tf` | Eingaben ohne Vorgabewerte; Validierungen weisen Platzhalter ab |
| `service-accounts.tf` | sieben getrennte Dienstkonten mit je einer Aufgabe |
| `run.tf` | drei Cloud-Run-Dienste (worker, monitor, watchdog) aus EINEM Abbild |
| `tasks.tf` | die Fortsetzungswarteschlange (5 Versuche, 30 s bis 10 min) |
| `scheduler.tf` | vier Hauptlaeufe, Monitor, Vorabcheck, Watchdog — **alle pausiert** |
| `iam.tf` | `run.invoker` je Dienst fuer genau EIN Konto; kein `allUsers` |
| `secrets.tf` | nur Verweise auf bestehende Geheimnisse, keine Werte |
| `manifest.json` | maschinenlesbare Beschreibung der beabsichtigten Topologie |
| `validate.mjs` | Abnahmepruefung vor dem Anwenden |

Bewusst **nicht** enthalten: `google_project_service` (dieses Paket
aktiviert keinen kostenpflichtigen Dienst), `google_secret_manager_secret_version`
(hier entsteht kein Geheimniswert) und jede konkrete Projekt-,
Abrechnungs- oder Ressourcen-Id.

## Pruefen

```
node infra/quantus-v3/validate.mjs pfad/zu/deployment.json
```

Exitcode 1 bei jeder Beanstandung. Ohne Konfigurationsdatei verweigert die
Pruefung ausdruecklich — ein unkonfiguriertes Deployment kommt nicht durch.
Geprueft werden unter anderem: Platzhalter, Geheimniswerte, bewegliche
Abbildreferenzen, geteilte Dienstkonten, geteilte Kennungen, ein fuenfter
Hauptauftrag, abweichende Slotzeiten oder Zeitzonen, nicht pausierte
Zeitplaene bei offenen Freigabetoren und ein Watchdog, der Takt, Konto oder
Ziel mit dem Monitor teilt.

Die Pruefung ersetzt **kein** `terraform plan` und beweist nichts ueber die
echte Cloud.

## Von Hand, vor dem ersten Anwenden

Diese Schritte stehen ausdruecklich hier und nicht im Code, damit niemand
sie versehentlich ausloest:

1. **APIs aktivieren** (kostenpflichtige Dienste — bewusste Entscheidung):
   Cloud Run, Cloud Scheduler, Cloud Tasks, Secret Manager, Artifact
   Registry, IAM. Vorher Kosten und Kontingente pruefen.
2. **Geheimnisse anlegen** (`tool_credential_secret_id`,
   `cost_policy_secret_id`) — ausserhalb von Terraform, damit kein Wert in
   den Zustand geraet.
3. **Dienstagenten binden**: Cloud Scheduler und Cloud Tasks stellen die
   OIDC-Token im Namen der Aufruferkonten aus und brauchen dafuer
   `roles/iam.serviceAccountTokenCreator` auf genau diesen Konten. Die
   Adressen der Dienstagenten werden hier nicht erfunden; entweder
   `scheduler_service_agent_email` / `tasks_service_agent_email` setzen oder
   die Bindung von Hand vergeben.
4. **Ingress pruefen**: Die Zugangskontrolle ist IAM. Ob Scheduler und Tasks
   im gewaehlten Aufbau als internen Verkehr gelten, gegen die aktuelle
   Google-Dokumentation pruefen, bevor `INGRESS_TRAFFIC_INTERNAL_ONLY`
   uebernommen wird.
5. **Freigabetore**: Solange ein Tor offen ist, bleibt jeder Zeitplan
   pausiert und `runtime_mode` auf `dry_run`. Das Aktivieren eines Jobs ist
   ein eigener, sichtbarer Schritt.

## Was noch fehlt

Kein Live-IAM-Nachweis, kein Ausrollen, kein Probebetrieb, keine
Kostenabschaetzung gegen echte Preise, keine Alarmierung und keine
Protokollsenken. Der Watchdog hat hier einen Zeitplan, aber noch keinen
angebundenen Warnweg — der `alert`-Port ist offen und die Route antwortet
bis dahin mit 503.
