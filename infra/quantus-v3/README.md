# Quantus v3 — Infrastruktur (Paket E2)

**Nicht produktiv ausgerollt.** Terraform initialisiert und validiert; die Infrastrukturtests verwenden ausschliesslich einen simulierten Google-Provider. Kein produktives `plan`/`apply`, keine angelegten Cloud-Ressourcen, keine gelesenen Geheimniswerte.

## Was hier steht

| Datei | Inhalt |
| --- | --- |
| `variables.tf` | Eingaben ohne Vorgabewerte; Validierungen weisen Platzhalter ab |
| `service-accounts.tf` | sieben getrennte Dienstkonten mit je einer Aufgabe |
| `run.tf` | drei Cloud-Run-Dienste (worker, monitor, watchdog) aus EINEM Abbild |
| `tasks.tf` | die Fortsetzungswarteschlange (5 Versuche, 30 s bis 10 min) |
| `scheduler.tf` | vier Hauptlaeufe, Monitor, Vorabcheck, Watchdog — **alle pausiert** |
| `iam.tf` | `run.invoker` je Dienst fuer genau EIN Konto; kein `allUsers` |
| `runtime-env.json` / `runtime-env.tf` | Laufzeitvertrag, rollenbezogene Geheimnisverweise und privater Originalspeicher |
| `tests/runtime.tftest.hcl` | echte Terraform-Auswertung mit simuliertem Google-Provider |
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

Diese bisherige JSON-Pruefung behandelt die E2-Topologie. Sie prueft **nicht** die Vollstaendigkeit der v4-Laufzeitumgebung. Fuer diese gelten zusaetzlich der Vertrag `runtime-env.json`, die Terraform-Validierungen und die Laufzeittests. Keine dieser Offline-Pruefungen beweist die echte Cloud.

## Von Hand, vor dem ersten Anwenden

Diese Schritte stehen ausdruecklich hier und nicht im Code, damit niemand
sie versehentlich ausloest:

1. **APIs aktivieren** (kostenpflichtige Dienste — bewusste Entscheidung):
   Cloud Run, Cloud Scheduler, Cloud Tasks, Secret Manager, Artifact
   Registry, IAM und Cloud Storage. Vorher Kosten und Kontingente pruefen.
2. **Geheimnisse bereitstellen**: die zwei bisherigen Referenzen, alle sieben Eintraege von `runtime_secret_ids` und gegebenenfalls die drei Gmail-Referenzen. Werte ausschliesslich ausserhalb von Terraform verwalten. Bestehende Geheimnisse duerfen nicht durch neue ersetzt werden, ohne ihre Nutzung zu pruefen.
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

## Laufzeitvertrag v4

`runtime-env.json` ist die gemeinsame Zuordnung der vom Programm gelesenen Variablennamen zu oeffentlichen Einstellungen und Geheimnisreferenzen. `runtime_settings` muss genau alle oeffentlichen Namen enthalten; `runtime_secret_ids` genau die sieben zusaetzlichen Referenzen. Die absichtlich unbrauchbare Beispieldatei zeigt den gesamten Umfang. Alle Geheimnisnamen muessen verschieden sein. Kein Geheimniswert wird durch Terraform geladen oder als Ausgabe gespeichert.

Die drei Firebase-JSON-Geheimnisse muessen jeweils das **entsprechende Laufzeit-Dienstkonto** enthalten. Terraform setzt `QUANTUS_V3_EXPECTED_SERVICE_ACCOUNT` aus dem tatsaechlich angelegten Konto. Die Anwendung verweigert ihren Start mit arbeitsfaehigen Routen bei fehlender/fremder Identitaet oder einem vorrangigen Benutzer-OAuth-Refresh. Das prueft die Identitaetszuordnung, nicht die Gueltigkeit des privaten Schluessels oder die tatsaechlichen Firebase-Rechte; diese bleiben durch einen produktiven Zugriff nachzuweisen. Fuer bestehende Installationen ohne diese neue Vorgabe bleibt das bisherige Verhalten erhalten.

Der Worker erhaelt Policy, Kostenpolicy, Scheduler-Zugang, Token-Signierschluessel, Service-Credential-Hashes und OpenAI-Zugang. Der Monitor erhaelt seine Firebase-Identitaet und die Policy fuer die Nachkontrolle. Der Watchdog erhaelt ausschliesslich seine Firebase-Identitaet. Gmail-Konfiguration ist optional im Terraform-Schema, aber fachlich erforderlich, sobald die Policy eine Gmail-/Mailquelle enthaelt. Konto und Quellenkennung muessen zur Policy passen; OAuth-Client und Netlify-Token referenzieren den vorhandenen OAuth-Speicher. C2 muss dieselben Policy-, Tenant- und Tokenkonfigurationen verwenden.

Der Originalspeicher hat erzwungenen privaten Zugriff und einheitliche Bucket-Berechtigungen. Das eigene Worker-Recht erlaubt nur Bucket-Metadaten lesen sowie Objekte lesen/anlegen, keine Loeschung und keine IAM-Aenderung. Ein bereits vorhandener Bucket muss vor der Verwaltung gezielt importiert werden. Er wird nicht pauschal geleert oder ersetzt.

Die [deterministischen Cloud-Run-Adressen](https://docs.cloud.google.com/run/docs/triggering/https-request) vermeiden Selbstabhaengigkeiten beim Anlegen. Die routenspezifischen Audiences sind zugleich als [Custom Audiences](https://docs.cloud.google.com/run/docs/configuring/custom-audiences) an den Diensten eingetragen. Scheduler, Fortsetzungen und Anwendung verwenden dieselben Adressen. Die Geheimnisrechte und der Originalspeicherzugriff werden vor dem Dienst angelegt. Alle Zeitplaene bleiben pausiert.

## Reproduzierbare Offline-Pruefung

Terraform 1.13.3 und der gesperrte Google-Provider 6.50.0 werden in CI verwendet:

```sh
terraform -chdir=infra/quantus-v3 fmt -check -recursive
terraform -chdir=infra/quantus-v3 init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/quantus-v3 validate
terraform -chdir=infra/quantus-v3 test -var-file=tests/runtime.auto.tfvars.json
node --test tests/quantus-v4-runtime-deployment.test.mjs
```

Die Testdatei verwendet `mock_provider "google"`; ihre `apply`-Abschnitte laufen vollstaendig gegen Attrappen, ohne Cloud-Zugriff. Die Werte unter `tests/` sind synthetisch und duerfen niemals fuer ein produktives Deployment benutzt werden. Die Node-Tests geben dieselben oeffentlichen Werte und die gemeinsame Namenszuordnung an die echten Runtime-/Auth-/Policy-/Leitungs-Konstruktoren. Geheimnisse entstehen nur temporaer im Testprozess. Der bestehende E2-Topologie-Validator bleibt eine zusaetzliche Pruefung.

## Explicit shadow commissioning inputs

The optional `commissioning_worker` input supplies the reviewed broker
connection, `isolatedDomain = true` and exact `sourceReadIds`. It is accepted
only with `runtime_mode = "shadow"` and an explicit `shadow_binding`. The broker
caller must be the worker service's actual attached account. Its profile hashes
must match the reviewed runtime prompts/tools; runtime validation remains
authoritative. In this mode `runtime_secret_ids` contains the six normal
non-provider references and omits `openai_api_key`. No provider secret is
looked up, mounted or granted to the shadow worker. Ordinary deployments retain
the seven-reference contract.

Optional `commissioning_tasks` supplies `binding_hash`, `approved_at_ms` and
`expires_at_ms`. The module derives the permission's exact queue, worker target
and Tasks identity from its own resources, and emits it only for worker and
monitor. Its binding must match the worker connection when both are configured.
These inputs do not unpause Scheduler jobs, approve any activation gate, create
a source cost allocation or deploy the source broker.

The offline Terraform test renders all three service environments. CI feeds the
actual rendered settings to the real runtime/isolation/commissioning constructors
using synthetic secret values and prohibited network calls. This checks the
configuration boundary; it does not prove actual IAM, credentials, C2 storage
bindings or a live trial. See `runtime/quantus-v3/SHADOW-COMMISSIONING.md` in the
repository root for runtime fields and remaining source deployment requirements.
