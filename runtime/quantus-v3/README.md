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

## v4 OpenAI-Leitung im Worker

`server.mjs` verwendet jetzt `createOpenAIWorkerPorts`, nicht mehr den alten
Gmail/Anthropic-Entwurfsport. Fehlende Konfiguration sperrt den Worker; sie löst
keinen Providerwechsel aus. Zusätzlich zu der vorhandenen Runtime-/C2-/Policy-
Konfiguration werden ausdrücklich benötigt:

- `QUANTUS_V4_OPENAI_API_KEY` als Secret zur Laufzeit
- `QUANTUS_V4_OPENAI_MODEL` als freigegebene Modellkennung
- `QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK` und
  `QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK`: ganzzahlige Mikro-USD je Million
  Tokens; müssen zur aktuell freigegebenen Kostenrichtlinie passen
- `QUANTUS_V4_PROMPT_VERSION=4.0.0`
- `QUANTUS_V4_ARTIFACT_BUCKET`: expliziter privater Bucket, dessen öffentliche
  Zugriffe verhindert sind und der einheitliche Bucket-Rechte nutzt
- bestehende C1-Job-Token-Konfiguration sowie aktivierte Quantus-Werkzeuge

Für ein Modell mit geprüfter Unterstützung der Responses-Serverkompaktierung
kann zusätzlich `QUANTUS_V4_OPENAI_COMPACT_THRESHOLD` als ganze Tokenzahl
zwischen 1000 und 100000 gesetzt werden. Ohne diesen expliziten Wert bleibt die
Funktion aus; ungültige Werte sperren die Komposition. Die Schwelle muss zum
freigegebenen Modell und dessen Kontextfenster passen. Sie ist Teil der
unveränderlichen Laufkonfiguration und darf in einem offenen Journal nicht
geändert werden. Produktive Unterstützung und geeignete Schwelle sind vor
Aktivierung nachzuweisen.

Der Worker übergibt `context_management` im bestehenden, kostenreservierten
Responses-Aufruf mit `store:false`. Nur ein geprüftes Compaction-Element der
gespeicherten Providerantwort ersetzt frühere Eingaben in der nächsten Anfrage.
Originale und Lesebelege bleiben im privaten Journal vollständig erhalten; die
Abschlusskontrolle liest weiterhin diese Originalbelege und den aktuellen Kern.
Ein Compaction-Element hinter einem noch offenen Werkzeugaufruf wird abgewiesen,
damit keine verwaiste Werkzeugantwort entsteht. Reicht die Verdichtung nicht
oder liefert der Provider keine, ergibt die 512-KiB-Anfragegrenze eine explizite
Sperre ohne weitere Kostenreservierung. Diese Funktion ersetzt weder die noch
offene Paketierung grosser Arbeitsbestände noch den produktiven Probebetrieb.

Quellcode und Konfiguration erteilen keine Aktivierungsfreigabe. Der bekannte
Live-Gate, die frische Kostenrichtlinie, Lease/Fence und die gemeinsame atomare
Monatsgrenze gelten unverändert. Ein Abschnitt nutzt den externen Journalstand
zur Wiederaufnahme. Ein unbekanntes Provider-Ergebnis bleibt blockiert, ebenso
explizite Budget-/Policy-Sperren; diese werden als offene Ausnahme gespeichert.
Die Abbruchsignale reichen bis zum C2-Antwortstream.

Noch ausstehend: vollständige Quelladapter/Arbeitsdeckung, unabhängiges Rücklesen
veränderter Originale, Backend-Antwortkonsum und Abschluss sowie produktive
Konfiguration/Probebetrieb. Die alte Gmail-F-Komposition bleibt als separat
getestetes Modul erhalten, ist aber kein Fallback des v4-Servers. Ein
`model_complete` bestätigt ausschliesslich das Ende des Modellzyklus; der
Worker benötigt weiterhin den unabhängigen serverseitigen Abschlussnachweis.

### Grosse Arbeitsbestände

Die produktive Komposition liest `run.workset` als zusammenhängenden, vollständig
autorisierten Schnappschuss. C2 begrenzt diese Seiten auf 384 KiB Nutzinhalt;
einzelne grosse Originale werden nach vollständiger Feldprojektion und
Geheimnisprüfung verlustfrei fragmentiert. Jeder Teil trägt die bisherige
Mandanten-/Auftragsbindung und bleibt an einen signierten Revisionscursor
gebunden. Der Worker setzt alle Teile anhand von Identität, Reihenfolge und
SHA-256 wieder zusammen, bevor ein Schnappschuss als vollständig gilt.

Bestände über 128 KiB werden anschliessend in private, unveränderliche
Kontextpakete mit Manifest geschrieben und zurückgelesen. Modell-Fortsetzungen
verwenden `q4packet`-Cursor mit generations- und hashgebundenen Referenzen.
Jede Fortsetzung wird erneut durch die aktuelle Quantus-API autorisiert und
durch die Lease geschützt. Eigene Journalrevisionen entwerten diese Pakete
nicht; eine rückwärts gelaufene Datenrevision, fremder Lauf, fehlendes Original
im Speicher oder widerrufene Berechtigung sperrt die Fortsetzung.

Die Abschlussprüfung verlangt alle Pakete derselben Manifestgeneration in
Reihenfolge. Ein Schreibvorgang währenddessen verlangt einen neuen Schnappschuss.
Eine unterbrochene Kette erhält den nächsten konkreten Cursor; ein finaler Teil
allein zählt nicht als vollständige Lesung. Anschliessend vergleicht der Backend-
Prüfer den Inhalt mit einem unabhängig neu gelesenen Gesamtbestand.

Der Schnappschuss bleibt auf 16 MiB bzw. 2000 API-Seiten begrenzt. Grenzen erzeugen
offene Arbeit und keinen erfolgreichen Abschluss. Lange Journale verwenden den
folgenden dauerhaften Abschnittswechsel.

### Fortsetzung langer Journale

Ab 30 aktiven Modellaufrufen oder 8 MiB aktiven Nachweisen verschiebt der Worker
abgerechnete Vorgänger in einen privaten, unveränderlichen Nachweisabschnitt.
Die jüngste Anfrage bleibt vollständig aktiv, auch mit noch ausstehender
Werkzeugantwort. Schema 3 bindet die fortlaufenden Abschnitte an Originalreferenzen,
Kostenbelege, unveränderte Laufregeln und kompakte, vom Backend abgeleitete
Kontextnachweise. Ein unbekannter Befehlsausgang oder unbestätigte Kosten können
nicht in einen abgeschlossenen Abschnitt überführt werden.

Gewöhnliche Schritte laden nur den aktiven Verlauf und die gesicherten
Nachweismetadaten. Vor einer Abschlussprüfung werden sämtliche Originalanfragen,
Modellantworten und Werkzeugbelege abschnittsweise nochmals zurückgelesen und
die Nachweise daraus neu berechnet. Die Kostenbuchhaltung muss weiterhin passen.
Fehlende Originale oder widersprüchliche Nachweise verhindern den Abschluss.
Aufrufnummern, Kostenkennungen und Befehlsidentitäten laufen ohne Neustart weiter;
ein wiederholter alter Schreibaufruf erzeugt keinen zweiten aktiven Eintrag.

Der Wechsel selbst erfolgt nach Speicher-Readback mit exaktem Journalvergleich
innerhalb CAS und anschliessendem unabhängigem Readback. Abbruch oder verlorene
Quittung berechtigen weder zu erneutem Modellaufruf noch erneutem Kommando. Es
werden keine Originale gelöscht und keine Aufbewahrungsfristen verkürzt. Die
Grenzen von 16 MiB aktivem Verlauf, separat 16 MiB Nachweismetadaten und 1000
Nachweisabschnitten bleiben ausdrücklich durchgesetzt; Zeit-, Lease- und
Kostenlimits gelten über alle Abschnitte hinweg. Modellkontext-Verdichtung
und Journalabschnitte erfüllen getrennte Aufgaben und werden beide benötigt,
wenn auch der Modellkontext die Anfragegrenze erreichen würde.

### Gmail-v4-Leseadapter (Importanbindung noch offen)

`gmail-v4-reader.mjs` stellt einen ausschliesslich lesenden, ausdrücklich
kontogebundenen Zugriff bereit: Profilprüfung, vollständig paginierte Mail-ID-
Auflistung, ungefilterter Änderungsverlauf und vollständige MIME-Nachrichten.
`getMessage` erhält sämtliche Textalternativen und die Originalantwort; über
`attachmentId` ausgelagerte Textkörper werden geladen und ebenfalls original
erhalten. Binäranhänge, unbekannte Kodierungen und fehlende Körper bleiben
ausdrückliche Lücken. `getAttachment` liefert Originalbytes für eine spätere
Dokumentauswertung; der Download allein behauptet keine inhaltliche Prüfung.

Der Listenbereich ist fest `-in:chats -in:spam -in:trash`, der Änderungsverlauf
ohne Label-/Ereignisfilter. History-404 bedeutet `resetRequired`; andere
Providerfehler sind feste, geheime Inhalte ausschliessende Diagnosen. Ein
Nachrichten-404 beweist keine Löschung. Kontowechsel, falsche Nachricht-ID,
ungültige Kodierung und rückwärts laufende History-IDs werden abgewiesen.
Der Adapter schreibt weder Gmail noch den Quantus-Cursor. Der Import muss
Originale sichern und unabhängig zurücklesen, bevor er eine Seite quittiert.

Grenzen: 100 IDs/History-Datensätze pro API-Seite, 8 MiB pro HTTP-Antwort,
6 MiB dekodierte Textbytes pro Nachricht, 1000 MIME-Teile, 32 Ebenen und
20 Sekunden je Nachricht einschliesslich ausgelagerter Textteile. Überschreitungen
sind offene Fehler. Das bisherige F-Modul bleibt unverändert; der neue Adapter
ist noch nicht mit der v4-Produktionskomposition verbunden. T28 benötigt den
dauerhaften Import, Wiederaufnahme/Gaps und produktive Nachweise.

`gmail-original-store.mjs` ergänzt die private Speicherung vollständiger
Leser-Ausgaben. `put({messageId,text})` verlangt die unveränderte JSON-Nachricht
mit passendem Konto und Provider-ID. Originalbytes werden in 256-KiB-Teilen
gesichert, durch ein unveränderliches Manifest verbunden und vollständig
zurückgelesen. `read({messageId,reference})` prüft dieselben Konto-/Quellenbindungen,
Generationen, Teilreihenfolge, Längen und Gesamt-Hash. Nur bestätigte Referenzen
dürfen anschliessend in einer eigenen CAS-Importtransaktion verwendet werden.
Die benötigte aktuelle Leaseprüfung ist ein Pflichtport; keine Speicheroperation
darf sie umgehen. Grenzen: 32 MiB pro Bündel und 128 Teile. Noch keine produktive
Import-/Cursoranbindung; der Baustein schreibt nicht in den Core oder nach Gmail.
