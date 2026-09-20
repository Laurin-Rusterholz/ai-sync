# Quantus v3 — Laufzeit (Paket E2)

Kurzer HTTP-Worker, unabhaengiger Monitor und getrennter Watchdog. **Nicht
ausgerollt**: es gibt kein Deployment, keinen Google-Aufruf und keinen
bezahlten Provideraufruf. Die fachlichen Entscheidungen kommen vollstaendig
aus Paket E1 (`netlify/lib/quantus-v3-runtime-{plan,state}.mjs`); hier steht
nur der Umschlag.

## Rollen und Routen

Ein Abbild, drei Rollen. `QUANTUS_V3_RUNTIME_ROLE` entscheidet, welche
Routen es gibt.

| Rolle | Route | Ausloeser |
| --- | --- | --- |
| `worker` | `POST /v3/slot/start` | Cloud Scheduler, vier benannte Jobs |
| `worker` | `POST /v3/run/continue` | Cloud Tasks |
| `monitor` | `POST /v3/monitor/tick` | Cloud Scheduler, alle fuenf Minuten |
| `monitor` | `POST /v3/monitor/preflight` | Cloud Scheduler, 22:30 Ortszeit |
| `watchdog` | `POST /v3/watchdog/check` | eigener Zeitplan, eigenes Konto |

Es gibt **keine anonyme Route** — auch keine Gesundheitsroute. Die
Startpruefung von Cloud Run laeuft als TCP-Pruefung.

## Umgebung

Fehlt etwas, startet der Prozess trotzdem und antwortet auf jeder Route mit
`503 runtime_not_configured` samt der Liste der fehlenden **Namen**. Werte
stehen nie in einer Antwort und nie in einem Log.

| Variable | Pflicht | Inhalt |
| --- | --- | --- |
| `QUANTUS_V3_RUNTIME_ROLE` | ja | `worker`, `monitor` oder `watchdog` |
| `QUANTUS_V3_TENANT` | ja | Mandant, Teil des Startschluessels |
| `QUANTUS_V3_POLICY_VERSION` | ja | Fassung des Regelmodells, Teil des Startschluessels |
| `QUANTUS_V3_ENDPOINTS` | ja | JSON: je Route `{ audience, allowedServiceAccounts }` |
| `QUANTUS_V3_RUNTIME_MODE` | nein | `dry_run` (Standard), `shadow`, `live` |
| `QUANTUS_V3_ACTIVATION_GATES` | nein | JSON: sechs Tore mit `{ passed, ref }` |
| `QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS` | nein | nur zusammen mit `live` und allen Toren |
| `QUANTUS_V3_TASKS_QUEUE` | worker/monitor | `projects/…/locations/…/queues/…` |
| `QUANTUS_V3_TASKS_TARGET_URL` | worker/monitor | Adresse von `/v3/run/continue` |
| `QUANTUS_V3_TASKS_OIDC_SERVICE_ACCOUNT` | worker/monitor | Konto, in dessen Namen Tasks aufruft |
| `QUANTUS_V3_LEASE_HOLDER` | worker | Besitzername fuer die Lease |
| `QUANTUS_V3_MONITOR_START_LOCAL_DATE` | monitor | ab wann der Monitor sucht |
| `QUANTUS_V3_SECTION_DEADLINE_MS` | nein | senkbar, nie ueber 90 000 |
| `QUANTUS_V3_SLOT_MAX_LATENESS_MS` | nein | wie spaet ein Direktstart noch zaehlt |

`live` ohne vollstaendige Freigabetore oder ohne ausdrueckliche Erlaubnis ist
ein **Konfigurationsfehler**, keine stille Rueckstufung.

## Ports — was fehlt, scheitert mit 503

Jede Aussenwirkung laeuft ueber einen benannten Port. In diesem Zweig ist
keiner davon verdrahtet; jede Route antwortet deshalb mit
`503 port_unavailable` und nennt den Port.

| Port | Vertrag | Stand |
| --- | --- | --- |
| `clock` | `now(): number` und `setTimer(delayMs, cb) -> cancel` — Zeit und Zeitgeber aus derselben Quelle | verdrahtet |
| `jwks` | `getKeys(): { keys }` — Googles oeffentliche Schluessel | offen |
| `core` | `read()`, `mutate({ commandKey, requestId, now, mutate })` → `{ result, replayed, wrote }` ueber den **echten** Umschlag der Integration; `createIntegrationCorePort` verdrahtet ihn | Adapter da, Module der Integration fehlen hier |
| `tasks` | `enqueueContinuation({ taskId, … }) → { enqueued, duplicate }`; `createCloudTasksPort` baut die vollstaendige Anfrage | Adapter da, Transport braucht Zugangsdaten |
| `sectionWork` | `next({ runKey, sectionId, cursor, deadlineAtMs, signal, … }) → { done, stepId, cursor }`; muss Frist und Abbruchsignal beachten | offen |
| `closureEvidence` | `load({ runKey, fence, now, tenant })` — der streng gepruefte Abschlussnachweis; `createRunStatusClosureEvidencePort` liest ihn ueber das Werkzeug `status.run` | Adapter da, Werkzeug in C1 abgeschaltet |
| `costPolicy` | `load({ now, step })` — der **aktuell** freigegebene Preis- und Budgetstand, je Schritt neu geladen | offen |
| `toolTransport` / `toolCredential` | HTTP zu den vier Quantus-Werkzeugen | offen |
| `alert` | Warnweg des Watchdogs | offen |

Der `core`-Port wirft kodierte Fehler mit `status` und `code`; der HTTP-Rand
uebersetzt sie (ein 409 aus dem Lease-Fencing bleibt ein 409).

`integration-ports.mjs` enthaelt die echten Anbindungen fuer `core`,
`tasks` und `closureEvidence`. Keine davon erfindet einen Erfolg: fehlt
eine Abhaengigkeit, bleibt der Port leer und nennt den Grund, und der
Dienst protokolliert das beim Start.

`cost-adapter.mjs` setzt den Vertrag fuer bezahlte Aufrufe durch: Policy je
Schritt frisch laden, senden nur nach erfolgreicher Sendefreigabe,
Tageswechsel abbrechen, jeden unklaren Ausgang binden, und zwischen der
letzten Pruefung und dem Aufruf kein `await` mehr. Siehe
`docs/quantus-v3-runtime-cloud.md`.

Der Watchdog darf die Ports `tasks`, `sectionWork` und `monitorInvoke`
**nicht** besitzen — die Portablage lehnt das beim Zusammenbau ab.

## Bauen

Aus dem Repositoriumswurzelverzeichnis:

```
docker build -f runtime/quantus-v3/Dockerfile -t quantus-v3-runtime:dev .
```

Keine Abhaengigkeiten, kein Bauschritt, kein Geheimnis im Abbild.

## Tests

`npm run test:v3-cloud` startet die echten Dienste auf einem lokalen Port
und spricht sie ueber HTTP an, mit echten RSA-Schluesseln und echten
Signaturen. Ohne Netz, ohne Zugangsdaten, ohne bezahlten Aufruf.
