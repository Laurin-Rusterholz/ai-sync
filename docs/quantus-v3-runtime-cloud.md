# Quantus Tagesbriefing v3 — Cloud-Laufzeit (Paket E2)

Ausfuehrbares Grundgeruest und pruefbare Infrastrukturdefinitionen fuer den
im Konzept beschriebenen API-Betrieb. **Kein Deployment, kein bezahlter
Aufruf, keine echten Zugangsdaten, kein Produktionsdatensatz.** Bestehende
Scheduler und Firebase-Regeln sind unveraendert; `public/index.html` ist
nicht angefasst.

| Verzeichnis | Inhalt |
| --- | --- |
| `runtime/quantus-v3/` | kurzer HTTP-Worker, Monitor, Watchdog (ein Abbild, drei Rollen) |
| `infra/quantus-v3/` | Terraform, Manifest und eine Abnahmepruefung vor dem Anwenden |

E1 (`netlify/lib/quantus-v3-runtime-{plan,state}.mjs`) bleibt die
Fachlogik. E2 baut **keine** zweite Lease-, Kosten- oder Zeitimplementierung:
Lease und Fence, Abschnittsbudget, Werkzeugschritte, Checkpoint,
Fortsetzung, Abschluss, Slotzeiten, Monitorplan und Wiederholungsregeln
kommen alle aus E1.

## Aufbau

```
Cloud Scheduler  04:00 09:00 14:00 23:00 Europe/Zurich   (vier benannte Jobs)
        │  OIDC, Konto quantus-v3-sched-start
        ▼
Cloud Run  worker   POST /v3/slot/start
        │                     │ Checkpoint nach hoechstens 90 s
        │                     ▼
        │            Cloud Tasks  (stabiler Taskname)
        │                     │  OIDC, Konto quantus-v3-tasks
        │                     ▼
        └──────────► POST /v3/run/continue

Cloud Scheduler  */5        → monitor   /v3/monitor/tick
Cloud Scheduler  22:30      → monitor   /v3/monitor/preflight
Cloud Scheduler  7-59/15    → watchdog  /v3/watchdog/check   (eigener Dienst)
```

Sieben getrennte Dienstkonten: drei Laufzeitidentitaeten und vier
Aufruferidentitaeten. Jede Route nimmt **genau ein** Konto an. Das Konto,
das den Slot startet, kann keine Fortsetzung einwerfen.

## Vertrauenswuerdige Grenze

Je Anfrage, in dieser Reihenfolge und ohne Ausnahme:

1. Methode und Pfad exakt; sonst 404. Es gibt keine anonyme Route.
2. TLS an der Grenze (`x-forwarded-proto: https`); sonst 403.
3. **Serverzeit einmal holen.** Alles Weitere rechnet mit diesem Wert.
4. **OIDC pruefen**: feste Algorithmenliste (RS256, kein `none`), `kid`
   vorhanden und eindeutig, Signatur gegen genau diesen Schluessel,
   Aussteller aus fester Liste, `aud` **exakt** die fuer diese Route
   konfigurierte Kennung, `exp` ohne Toleranz, `iat` hoechstens 60 s in der
   Zukunft, `email_verified === true` und `email` in der Aufruferliste
   **dieser** Route. Jede Absage ist dieselbe (`401 unauthenticated`); der
   Grund steht nur im Log.
5. Rumpf: nur `application/json`, nur Objekte, hoechstens 16 KiB.
6. **Nichts aus dem Rumpf wird geglaubt, was der Server bestimmt.** Rolle,
   Principal, Mandant, Policy-Version, `now`, Fence, IAM-Bindung, Budget,
   Featureflags — in beliebiger Tiefe: 400.

Mandant, Policy-Version und lokales Datum kommen aus Konfiguration und
Serverzeit, nie aus der Nutzlast.

## Genau ein Versuch arbeitet

Die unabhaengige Pruefung hat gezeigt, dass zwei gleichzeitige, gleich
gueltige Zustellungen desselben Slots BEIDE in den externen Aufruf liefen:
der Besitz haftete am Dienst (`leaseHolder`), nicht am Versuch, und eine
noch lebende Ausfuehrung wurde uebernommen.

Seither gilt:

* **Der Besitz gehoert dem VERSUCH.** Der Besitzername traegt die Kennung
  dieser Anfrage (`<leaseHolder>:<requestId>`). Zwei gleichzeitige
  Zustellungen haben damit verschiedene Besitzer — die zweite bekommt
  ehrlich `409 already_running` samt `retryAfterMs`, bevor irgendetwas
  Externes passiert.
* **Beansprucht wird VOR dem externen Aufruf.** Der Besitz steht im
  zentralen CAS, bevor `sectionWork` zum ersten Mal gerufen wird.
* **Ein lebender Vorgaenger wird nie uebernommen.** Eine Uebernahme gibt
  es erst, wenn seine Sperre abgelaufen ist — und sie setzt die Arbeit
  nicht fort: der haengengebliebene Abschnitt wird protokolliert
  geschlossen und eine Ausnahme geoeffnet, weil niemand weiss, was
  waehrend seines externen Aufrufs geschah.
* **Am Ende jedes Versuchs wird der Besitz freigegeben**, damit die
  Fortsetzung nicht bis zum Ablauf warten muss.
* **Ein schon aufgezeichneter Schritt wird nicht erneut ausgefuehrt.**
  Liefert der Anbieter eine Schrittkennung, die es im Bestand schon gibt,
  ist sein Ausgang nicht belegt — der Abschnitt endet als Ausnahme statt
  ihn zu wiederholen.

## Wiederholsicherheit

**Startschluessel** ist `tenant:lokalesDatum:slot:policyVersion` (E1
`slotRunKey`). Das lokale Datum wird serverseitig aus dem **letzten
geplanten Auftreten** des Slots bei oder vor `now` hergeleitet, nicht aus
der Ankunftszeit. Eine Scheduler-Wiederholung des 23-Uhr-Auftrags um 00:05
trifft damit den 19., nicht den 20. — sie erzeugt keinen zweiten Lauf.
(Weil das Spaetfenster um 23:30 endet, startet sie dann gar nicht mehr und
bekommt `409 slot_window_closed`; nachgeholt wird ueber den Monitor.)

Zwei Lagen, in dieser Reihenfolge:

1. **Zustellung.** Der Task-Name ist umkehrbar aus Lauf und Fortsetzung
   kodiert; ein vorhandener Name wird von Cloud Tasks mit ALREADY_EXISTS
   abgewiesen und vom Worker als Dublette behandelt, nicht als Fehler. Die
   Grabsteinfrist (bei ueber die Cloud-Tasks-API angelegten Queues
   standardmaessig etwa eine Stunde) macht das zur ersten, nicht zur
   verbindlichen Linie.
2. **E1.** Derselbe Abschnitt ist ein Nulldurchlauf, eine Fortsetzung wird
   genau einmal verbraucht, ein Checkpoint ist idempotent. Das ist die
   massgebliche Regel.

Eine wiederholte Zustellung des Slotstarts liest **zuerst den Zustand** und
schreibt bei einem fertigen Lauf gar nichts — auch keine Lease-Erneuerung.
Ist der Lauf mit Checkpoint stehengeblieben (Absturz zwischen Checkpoint
und Einreihen), wird nur das Einreihen nachgeholt; ist er noch aktiv, wird
weitergearbeitet, weil jeder Schritt seine eigene Kennung hat.

## Kurz bleiben: 90 Sekunden

Der Abschnitt endet spaetestens nach `sectionDeadlineMs` (hoechstens 90 s)
abzueglich eines Polsters fuer Checkpoint und Einreihen — oder frueher,
wenn E1 das Abschnittsbudget fuer erschoepft haelt. Dann:

1. **Checkpoint schreiben** (dauerhafter Cursor, genau eine
   Fortsetzungsabsicht) — und erst danach
2. **einreihen**.

Die Reihenfolge ist Absicht: der Stand ist dauerhaft, bevor irgendjemand
davon erfaehrt. Scheitert das Einreihen, bleibt die Absicht offen und der
Monitor stellt sie zu. Die Lease (120 s) wird auf der Fortsetzung erneuert,
statt abzulaufen; ein Verlust der Fuehrung beendet den Abschnitt, statt
weiterzuschreiben.

Der Aufruf bekommt ein **Abbruchsignal** und eine harte Frist mit. Laeuft
er darueber hinaus, wird nicht auf ihn gewartet: sein Ausgang gilt als
**unklar**, der Lauf endet als Ausnahme mit sicherer Fortsetzung, und er
wird nicht wiederholt. Kehrt er im selben Augenblick doch noch zurueck,
wird sein Ergebnis verwendet — nur ein wirklich haengender Aufruf gilt als
unklar.

Die **Fuehrung wird waehrend des Aufrufs erneuert**, spaetestens zum
`renewByMs` des Datensatzes (60 s bei 120 s Laufzeit), nicht erst kurz vor
Ablauf. Erneuerung und Abbruch haengen an derselben Uhr wie alles andere:
der Uhrport liefert `now()` UND `setTimer()`. Eine Testuhr mit echten
Wallclock-Timern zu mischen wuerde jede Aussage ueber Fristen wertlos
machen; fehlt `setTimer`, antwortet die Route mit 503.

Nach fuenf Task-Zustellungen gibt es `exception_open` mit sicherer
naechster Fortsetzung — nie ein vorgetaeuschter Erfolg.

## Gruen nur mit Nachweis

Frueher erfand der Worker seine eigene Abschlusskennung
(`run-evidence:<runKey>`), und E1 pruefte nur, dass es eine Zeichenkette
war. Ein Lauf konnte damit gruen werden, obwohl es keinen fachlichen
Abschluss gab. Arbeit erschoepft ist kein Abschlussnachweis.

`completed` verlangt jetzt einen Nachweis aus dem Port `closureEvidence`,
der streng geprueft wird:

| Feld | Pruefung |
| --- | --- |
| `runKey`, `tenant`, `policyVersion` | muessen zum Lauf und zur Serverkonfiguration passen |
| `fence` | muss der Fence dieses Versuchs sein |
| `dataRevision` | wird **im selben CAS** gegen den Bestand abgeglichen; bewegt sich der Stand, wird der Nachweis einmal frisch geholt |
| `sources` | muss den in der Serverkonfiguration hinterlegten Quellensatz vollstaendig, mit Status `ok` und frisch abdecken — nicht mehr und nicht weniger |
| `evidenceRef` | eigene Kennung des Nachweisgebers; die frueher selbst erzeugte Form wird namentlich abgewiesen |
| `verifiedAtMs` | hoechstens 60 s alt, nie in der Zukunft |

Fehlt der Port, fehlt der Nachweis oder stimmt eines dieser Felder nicht,
endet der Lauf **ehrlich unvollstaendig**: `exception_open`, `green: false`,
kein Abschluss im Bestand, und eine sichere Fortsetzung. Im dry_run und im
Schattenbetrieb wird gar nicht erst nach einem Nachweis gefragt — dort gibt
es ohnehin kein Gruen.

Im Live-Betrieb ist `QUANTUS_V3_REQUIRED_SOURCES` Pflicht und darf nicht
leer sein; sonst waere jeder Abschluss trivial gruen.

## Integrationsports zu den vier Quantus-Werkzeugen

Kein Vollzugriffsport. Jeder Port ist **eine** benannte Operation mit
festem Werkzeug, fester Route, festem Verb, fester handelnder Rolle und
festem Nutzlastschema. Die Route- und Verbnamen stammen aus dem
Sicherheitspaket C1 (`docs/quantus-v3-sicherheitspaket-c1.md`); C1 ist noch
im Review, alle vier Werkzeuge stehen dort auf `enabled: false`, und dieses
Paket importiert C1 nicht und schaltet nichts frei.

| Port | Werkzeug | Route | Verb | Rolle |
| --- | --- | --- | --- | --- |
| `context.run` | `quantus_context` | `quantus-context` | `context.read` | scheduler |
| `status.run` | `quantus_run_status` | `quantus-run-status` | `context.read` | scheduler |
| `run.ensure` | `quantus_command` | `quantus-ingest` | `run.ensure` | scheduler |
| `run.claim` | `quantus_command` | `quantus-ingest` | `run.claim` | scheduler |
| `run.renew` | `quantus_command` | `quantus-ingest` | `run.renew` | scheduler |
| `run.log` | `quantus_command` | `quantus-ingest` | `run.log` | scheduler |
| `run.checkpoint` | `quantus_command` | `quantus-ingest` | `run.checkpoint` | backend_checker |
| `run.finalize` | `quantus_command` | `quantus-ingest` | `run.finalize` | backend_checker |

Beim Laden wird geprueft, dass jeder Port zu Werkzeug **und** Rollenmatrix
passt. Ein nicht erlaubtes Verb, eine kaputte Nutzlast oder eine
Identitaetsbehauptung im Rumpf verlassen den Prozess gar nicht erst. Ein
abgeschaltetes Werkzeug ist `503 tool_disabled` mit Route — kein
Ueberspringen, kein vorgetaeuschtes Ergebnis.

Ausdruecklich **nicht** als Port vorhanden, obwohl C1 sie der Rolle
`backend_checker` erlaubt: `briefing.consumeAnswer`, `document.processed`,
`note.append`. Dieses Paket braucht sie nicht. Ein Port entsteht mit seinem
Bedarf, nicht auf Vorrat.

## Adaptervertrag fuer bezahlte Aufrufe

Dieselben Grenzen, die die zweite E1-Pruefung erzwungen hat, gelten eine
Ebene hoeher (`runtime/quantus-v3/src/cost-adapter.mjs`), damit ein
spaeterer Provideranbinder sie nicht umgehen kann:

Die zweite E2-Pruefung hat den Adapter gegen den echten
Idempotenzumschlag laufen lassen. Sechs Faelle kamen durch, alle auf zwei
Ursachen zurueckzufuehren: ein **wiedergegebener Buchungsbeleg** wurde als
Sendeberechtigung gelesen, und gerechnet wurde mit der Zeit vom
**Anfragebeginn** statt mit einer frischen. Daraus:

1. **Die Zeit kommt bei jedem Schritt frisch aus dem Uhrport** — und
   ausdruecklich NACH dem Laden des Preisstands, weil genau dort die
   Verzoegerung sitzt. Ein Laden, das zwei Minuten dauert, laesst die
   Fuehrung ablaufen, und dann wird nicht gesendet; eines, das ueber
   Mitternacht laeuft, faellt in den Tageswechsel.
2. Der freigegebene Preis- und Budgetstand wird **fuer jeden Schritt**
   frisch vom `costPolicy`-Port geladen — einmal fuer die Reservierung,
   einmal fuer die Sendefreigabe. Ein gemerktes Objekt wuerde einen
   zwischenzeitlichen Widerruf, einen Ablauf oder eine Rueckstufung auf
   `dry_run` verdecken.
3. **Gesendet wird nur, wenn der Anspruch WIRKLICH GESCHRIEBEN wurde:**
   `wrote === true` und `replayed !== true`. Eine wiedergegebene
   erfolgreiche Buchung liefert die Antwort von damals samt
   `dispatchAllowed: true` — sie ist keine neue Sendeberechtigung. Meldet
   der Kernport die beiden Angaben nicht, ist das ein Vertragsbruch (502);
   im Zweifel wird nicht gesendet.
4. **Danach wird der Bestand noch einmal gelesen:** der Anspruch muss zu
   diesem Aufruf gehoeren, offen sein und aus diesem Augenblick stammen.
   Das faengt auch einen Port ab, der ueber `replayed` falsch berichtet.
5. **Vor der Sendung muss die Fuehrung noch lange genug reichen**, um den
   Ausgang danach auch verbuchen zu koennen (30 s). Sonst wird gar nicht
   gesendet.
6. Ein Tageswechsel zwischen Reservierung und Sendung bricht ab
   (`billing_day_rolled_over`); die Reservierung muss belegt freigegeben
   und neu gestellt werden.
7. Nach der Sendung gibt es genau zwei Ausgaenge: belegter Verbrauch oder
   ausdruecklich unklarer Ausgang. Ein Fehler, ein Abbruch oder eine
   unbrauchbare Antwort ergeben **unklar** — gebunden, wiederholgesperrt,
   nie stillschweigend als "nicht passiert" verbucht. Nach einem unklaren
   Ausgang wird auch mit neuer Anspruchskennung nicht wiederholt.
   Laesst sich ein Ausgang nicht mehr verbuchen, ist das ein lauter
   Fehler (`dispatch_outcome_unrecorded`), kein stiller.
8. Fehlt der `costPolicy`-Port, scheitert schon die Reservierung mit 503.
   Freigabetore und der Initialisierungsnachweis des Kerns werden bei
   jedem Schritt frisch geprueft — auch dann, wenn eine Mutation als
   Beleg wiederholt wird und ihren Mutator gar nicht ausfuehrt.
9. **Zwischen der letzten Pruefung und dem Aufruf liegt kein `await`.**
   Jedes gewartete Kern-I/O kann dauern: ein Lesen, ein CAS-Durchlauf mit
   Wiederholungen, ein langsamer Preisstand. Deshalb ist die Reihenfolge
   fest — letztes Lesen, dann frische Zeit, dann eine REINE Endkontrolle
   (Fuehrung, Fence, Abrechnungstag, Preisstand), dann `send`. Ein
   Fencewechsel oder eine abgelaufene Fuehrung faellt damit auch dann
   auf, wenn er erst waehrend des letzten Lesens eintritt. Schlaegt die
   Endkontrolle fehl, wird nicht gesendet; der schon geschriebene
   Anspruch bleibt beansprucht und unaufgeloest stehen und sperrt jede
   Wiederholung desselben Inhalts (`dispatch_aborted_before_send`).

## Fail closed

* Betriebsart ohne Angabe: **`dry_run`**. `shadow` liest, wirkt aber nicht.
* `live` verlangt **alle sechs Freigabetore mit Nachweis** UND
  `QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS=true`. Eine unvollstaendige Freigabe
  ist ein Konfigurationsfehler, keine stille Rueckstufung.
* Tore: `allWriterMigration`, `authPackageAccepted`, `costPolicyApproved`,
  `restoreDrill`, `monitorWatchdogProven`, `trial14Days`.
* Alle Zeitplaene stehen in der IaC auf `paused = true`.
* Fehlt ein Port, antwortet die Route mit `503 port_unavailable` und nennt
  ihn. Es gibt kein Ersatzverhalten.
* Geheimnisse ausschliesslich als Secret-Manager-Verweis; in der
  Konfiguration stehen nur Namen, nie Werte.

## Belege

`npm run test:v3-cloud` — 134 Pruefungen, ohne Netz, ohne Zugangsdaten, ohne
bezahlten Aufruf.

| Datei | Inhalt |
| --- | --- |
| `tests/quantus-v3-e2-worker.test.mjs` | 22 — echter lokaler Dienst: Start, Wiederholung, 90-s-Grenze, Checkpoint, Fortsetzung, doppelte Zustellung, fehlender Port |
| `tests/quantus-v3-e2-auth.test.mjs` | 11 — echte RSA-Schluessel, echte Signaturen; falsches Konto, falsche Kennung, `alg: none`, verbogener Inhalt, fremder Schluessel, mehrdeutige `kid` |
| `tests/quantus-v3-e2-monitor.test.mjs` | 13 — Monitor, Vorabcheck, Watchdog, fehlgeschlagene Warnzustellung |
| `tests/quantus-v3-e2-config.test.mjs` | 15 — Nullkonfiguration, Freigabetore, Portablage, Werkzeugports |
| `tests/quantus-v3-e2-infra.test.mjs` | 19 — die Abnahmepruefung gegen gute und schlechte Deployments und gegen die Terraform-Dateien selbst |
| `tests/quantus-v3-e2-cost-adapter.test.mjs` | 12 — frischer Preisstand je Schritt, keine Sendung ohne Freigabe, Tageswechsel, unklarer Ausgang, Belegwiederholung, fehlender Initialisierungsnachweis |
| `tests/quantus-v3-e2-cost-review-gegenbeispiele.test.mjs` | 16 — die sechs Befunde der Adapterpruefung, die zwei Befunde zum langsamen Kern-I/O, Fencewechsel, Widerruf unmittelbar vor der Sendung, unbekannter Rueckgabebeleg und die reine Endkontrolle |
| `tests/quantus-v3-e2-integration-ports.test.mjs` | 15 — die drei echten Portanbindungen: Verdrahtung an den Umschlag, Inhalt der Cloud-Tasks-Anfrage, strenge Abbildung des Abschlussnachweises |
| `tests/quantus-v3-e2-review-gegenbeispiele.test.mjs` | 11 — die drei Befunde der unabhaengigen E2-Pruefung, mit Positivkontrollen |

Die Tests starten die echten Dienste auf einem lokalen Port und sprechen sie
ueber HTTP an. Der Kernport laeuft im Test ueber die echte CAS-Schleife mit
den echten E1-Mutatoren; Cloud Tasks wird durch eine Attrappe ersetzt, die
einen vorhandenen Namen wirklich abweist.

## Echte Portanbindungen

Drei Ports sind gebaut, nicht nur beschrieben
(`runtime/quantus-v3/src/integration-ports.mjs`). Keiner erfindet einen
Erfolg: wo eine Abhaengigkeit fehlt, ist die Antwort ein leerer Port mit
Grund, und die Route antwortet mit 503.

| Port | Was hier wirklich gebaut ist | Was noch fehlt |
| --- | --- | --- |
| `core` | `createIntegrationCorePort` importiert `mutateAppData` (firebase-admin) und `prepareIdempotentCommand`/`applyIdempotentCommand` (Idempotenzpaket) **dynamisch** und verdrahtet sie. Es wird nichts davon nachgebaut. Fehlt ein Modul oder eine Ausfuhr, nennt der Port sie beim Namen. Das Laufzeitergebnis bekommt im Umschlag ein eigenes Fach, `replayed` und `wrote` werden durchgereicht, kodierte Kernfehler bleiben kodiert. | Die Module liegen auf der Integration, nicht auf diesem Zweig — dort meldet der Port `integration_cas_envelope_not_wired`. Ein Lauf gegen den echten Umschlag steht aus. |
| `tasks` | `createCloudTasksPort` baut die vollstaendige Anfrage fuer `projects.locations.queues.tasks.create`: stabiler Name, Zustellfrist, `scheduleTime`, HTTP-Ziel, OIDC-Angabe und ein Rumpf aus genau Lauf und Fortsetzung — keine Identitaet. `409`/`ALREADY_EXISTS` ist eine Dublette, jede andere Antwort ein Fehler. Der Transport (`createCloudTasksHttpTransport`) setzt sie ab und holt sein Zugriffstoken aus der **vorhandenen** Google-Identitaet: `getIdentityAccessToken({ scope: cloud-platform })` aus `firebase-admin.mjs` (C3b `f39cad2`), dynamisch, nur beim Namen genannt, nichts nachgebaut. | Der Export liegt auf der Integration, nicht auf diesem Zweig — hier meldet der Port `missing_export:getIdentityAccessToken`. Ohne freigegebene Aussenwirkung gibt es gar keinen Transport (`external_effects_not_allowed`). |
| `jwks` | `createGoogleJwksPort` holt `https://www.googleapis.com/oauth2/v3/certs` — oeffentlich, ohne jedes Zugangsdatum. Streng geprueft (nur RSA, eindeutige `kid`, `alg` nur RS256), gecacht bis zu dem von Google genannten Ablauf (auf 60 s … 6 h begrenzt), ein gemeinsamer Abruf fuer parallele Anfragen. Ein Ausfall reicht **keinen** alten Stand weiter: wer nicht frisch pruefen kann, prueft nicht. | Nichts — dieser Port ist vollstaendig und braucht keine Konfiguration. |
| `closureEvidence` | `createRunStatusClosureEvidencePort` liest ueber den Werkzeugport `status.run` — **GET** auf `quantus-run-status`, alles im Query-String, C2-taugliche Ids — und bildet die **echte Seite** ab. Was nicht eindeutig abgeschlossen ist, wird `null`, und der Worker beendet den Lauf ehrlich unvollstaendig. | Das Werkzeug ist in C1 abgeschaltet (`503 tool_disabled`), und es fehlen `QUANTUS_V3_C2_BASE_URL` und das Dienstzugangsdatum. Ausserdem bezeugt C2 weder Lease-Fence noch Quellensatz — siehe unten. |

Der Dienst verdrahtet diese Ports beim Start und protokolliert fuer jeden,
ob er da ist und warum nicht. Auf diesem Zweig sieht das so aus:

```
started  role=worker mode=dry_run gatesComplete=false
         missingPorts=[core, tasks, sectionWork, costPolicy, closureEvidence]
         core:            integration_cas_envelope_not_wired
         tasks:           missing_export:getIdentityAccessToken
         sectionWork:     section_work_provider_not_wired
         costPolicy:      cost_policy_not_wired
         closureEvidence: c2_base_url_not_configured
```

## Die C2-Lesestrecke — gegen die Integration geprueft, nicht angenommen

Der Statusnachweis war gegen eine erfundene Antwort gebaut. Gegen
`48dc1fe` geprueft, gilt:

| Frage | Befund an der Integration | Folge in E2 |
| --- | --- | --- |
| Verb | `handleReadRequest` nimmt **nur GET**; alles andere ist 400 `method_not_allowed`, ein Rumpf wird nie gelesen | die zwei Leseports sind GET mit `transport: "query"`; eine Routen-Query-Kreuzprobe schlaegt schon beim Laden fehl |
| Parameter | `query`, `scopeId`, optional `pageSize`, `cursor`, `jobId` — alle aus dem Query-String | `toSearchParams` baut genau diese, jeder Wert als Zeichenkette |
| Id-Form | `scopeId` muss `^[A-Za-z0-9_-]{1,128}$` erfuellen und darf kein `__` enthalten | ein Laufschluessel (`tenant:localDate:slot:policyVersion`) passt da **nie** hinein — `run-ids.mjs` rechnet um |
| Antwort | eine **Seite**: `ok, requestId, serverNow, dataRevision, query, scopeId, items, count, hasMore, complete, pageStatus, pageReason, cursor, entityVersions` | `mapRunStatusPageToEvidence` liest genau diese Felder |
| Eintraege | beschnitten auf `VISIBLE_FIELDS.run_status`: `id, runId, state, stage, entityVersion, updatedAt, openQuestions, blocked` | der Nachweis haengt an Datensatz-Id und Entitaetsversion (`runstatus:<id>:v<n>`), die Zeit an `serverNow` |
| Filter | `SCOPE_RELATION["run.status"]` prueft nur, dass ein Eintrag eine Id hat — der Dienst filtert **nicht** nach Lauf | der Port sucht den Eintrag mit `runId === runIdForRunKey(runKey)`; kein Treffer oder mehrere sind kein Nachweis |

### Die Zuordnung Laufschluessel ⇄ Lauf-Id

```
Laufschluessel  quantus:2026-09-20:process09:3.0
Lauf-Id         r-quantus_3a2026-09-20_3aprocess09_3a3_2e0   (jobId, item.runId)
Status-Scope    s-quantus_3a2026-09-20_3aprocess09_3a3_2e0   (scopeId)
```

Umkehrbar, injektiv, nie `__`, hoechstens 128 Zeichen; ein zu langer
Schluessel wird **abgelehnt**, nicht gekuerzt. Das ist eine **Konvention**,
kein Beweis: ob der Fachadapter seine Statusdatensaetze wirklich so
fuehrt, entscheidet Paket B. E2 kann nur die Id so bilden, dass C2 sie
annimmt, und die Antwort ablehnen, wenn der gelieferte Eintrag eine
andere Lauf-Id traegt.

### Was C2 nicht bezeugen kann

`VISIBLE_FIELDS.run_status` kennt weder einen Lease-Fence noch einen
Quellensatz. Der Nachweis traegt deshalb `fence: null`,
`fenceAttestedByC2: false` und `sources: null` — und
`validateClosureEvidence` meldet `sources_missing`, solange
`QUANTUS_V3_REQUIRED_SOURCES` etwas verlangt. **Ein Lauf wird dadurch
heute nicht gruen.** Das ist fail closed und kein Mangel dieses Adapters:
den Quellensatz muesste C2 sichtbar machen oder ein eigener
Nachweisport liefern. Der Fence gehoert E1 und wird vom Aufrufer gesetzt;
er ist ausdruecklich als nicht fremdbestaetigt markiert, damit ihn
niemand fuer eine Bestaetigung von aussen haelt.

### Der Vertragstest

`tests/quantus-v3-e2-c2-contract.test.mjs` laedt die fuenf C2-Module
kontrolliert aus dem Git-Objektspeicher (`git show 48dc1fe:…`) in ein
temporaeres Verzeichnis — kein Kopieren ins Paket, keine Aenderung an
C2 — und faehrt Transport, Werkzeugklient, Port und Abbildung gegen die
**echte** Kette. Keine Ersatzantwort. Ist der Stand nicht erreichbar,
schlaegt der Lauf fehl statt stillschweigend gegen eine Nachbildung zu
laufen.

## Baustein F/G — `sectionWork` und `costPolicy` sind jetzt gefuellt

Auf diesem Checkout liegen `netlify/lib/firebase-admin.mjs` (`mutateAppData`,
`readAppDataDocument`) und `netlify/lib/quantus-v3-idempotency.mjs`
tatsaechlich vor — der `core`-Port (Punkt 2 unten, historisch) wird also
wirklich verdrahtet, nicht nur gegen einen Ersatz geprueft.

Zwei der bislang immer leeren Ports (`server.mjs`) haben jetzt eine echte
Fuellung, `runtime/quantus-v3/src/f-composition.mjs` entscheidet je nach
Konfiguration:

| Port | Fuellung | Ohne Konfiguration |
| --- | --- | --- |
| `sectionWork` | `section-work.mjs`: Nur-Lese-Gmail-Seiten (`gmail-source.mjs`, echtes HTTP, paginiert) → EIN `recordSourceCheck`-Kommando (echter Domain-Kern `assistant-core.applyCommand`, dieselbe Tagesbriefing-Policy wie der C2-Domain-Adapter, `QUANTUS_V3_TAGESBRIEFING_POLICY_JSON`) → bei mindestens einer gelesenen Quelle: Kostenreservierung + Sendung ueber das UNVERAENDERTE `cost-adapter.mjs` an einen echten Sonnet-Transport (`anthropic-transport.mjs`) → `appendRunNote` mit dem Ergebnis. | `503 section_work_provider_not_configured` (Anthropic-Schluessel/-Modell/-Preise fehlen) oder ein benannter Grund fuer eine fehlende Policy/Gmail-Anbindung. |
| `costPolicy` | `cost-policy-port.mjs`: liest `QUANTUS_V3_COST_POLICY_JSON` unveraendert (Preise, Limits, Freigabe, Gueltigkeit — **nichts** davon wird hier festgelegt) und liefert es `cost-adapter.mjs`. | `503 cost_policy_not_configured`. |

Andere in `QUANTUS_V3_REQUIRED_SOURCES`/der Policy genannte Quellen als
Gmail werden von `section-work.mjs` NICHT verarbeitet — sie bekommen keinen
`recordSourceCheck`-Eintrag. `validateClosureEvidence` verlangt weiterhin
den vollstaendigen Quellensatz; eine fehlende Quelle bleibt also ehrlich
`sources_missing`, nie ein erfundener Erfolg. Anhaenge werden nur als
Metadaten gelesen (Name/Typ/Groesse), nie als Bytes. Siehe
`tests/quantus-v3-f-source-processing.test.mjs` (echter lokaler
Worker-Dienst, echte lokale HTTP-Attrappen fuer Gmail/Anthropic): 401 wird
`auth_error`, eine unvollstaendige Anhangsangabe `partial`, eine
Teilseite wird ueber einen zweiten Schritt fortgesetzt, eine haengende
Modellantwort verbucht `unknown` (nie erneut versucht), ein zweiter
Slotstart nach einem fertigen Lauf sendet kein zweites Mal und legt keine
zweite Notiz an, eine zu niedrige Kostengrenze und eine fehlende
Kostenrichtlinie verhindern die Sendung sichtbar statt sie zu erzwingen,
und eine Anweisung im E-Mail-Betreff bleibt nachweislich in ihrem
markierten Datenblock, ohne das System- oder Modellfeld der Anfrage zu
veraendern.

**Offen:** Dokumentenextraktion und jede Quelle ausser Gmail; Gemini als
zweiter Provider; menschliche Pruefung des Modell-Ergebnisses vor
Veroeffentlichung; ein echter Gmail-OAuth-Zugang, ein echter Anthropic-
Schluessel und eine vom Betreiber tatsaechlich freigegebene Kostenrichtlinie
(`featureFlags.providers: "live"`) — ohne die bleibt jede Sendung im
`dry_run`, wie es sein soll.

## Restluecken

1. **Kein Live-Nachweis.** Kein `terraform plan`, kein `apply`, kein
   IAM-Nachweis, keine echte OIDC-Strecke gegen Googles Zertifikate, keine
   Messung eines echten Laufs. Nichts hier behauptet das.
2. **Der `core`-Port ist verdrahtet.** Auf FRUEHEREN Checkouts fehlten
   `mutateAppData`/das Idempotenzpaket noch, und jede Route antwortete mit
   `503 port_unavailable: core (integration_cas_envelope_not_wired)`. Auf
   diesem Checkout liegen beide Module vor (siehe oben) — ungeprueft bleibt
   weiterhin ein echter Lauf gegen eine ECHTE Firebase-Instanz (Zugangsdaten,
   Netz), nicht die Verdrahtung selbst.
3. **C1/C2 sind nicht abgenommen.** Die Werkzeugports zeigen auf Routen, die
   es noch nicht gibt; `toolsEnabled` ist ueberall falsch, also `503`.
4. **`sectionWork`/`costPolicy` sind jetzt gefuellt (Baustein F/G, oben),
   aber nur fuer Gmail als einzige Quelle und Anthropic als einzigen
   Provider.** Ohne Konfiguration (Anthropic-Schluessel, Kostenrichtlinie,
   Gmail-Zugang) bleiben sie leer — kein Hauptlauf, kein bezahlter Aufruf,
   mit Absicht.
   **Cloud Tasks:** Anfrage und Transport sind gebaut und geprueft. Was
   fehlt, ist Konfiguration, nicht Code: `getIdentityAccessToken` liegt
   auf der Integration, und ohne `mode=live` plus alle sechs Tore ist die
   Aussenwirkung nicht freigegeben.
   **Statusnachweis:** ohne `QUANTUS_V3_C2_BASE_URL`, ohne
   `QUANTUS_V3_TOOL_CREDENTIAL_SCHEDULER` und ohne
   `QUANTUS_V3_TOOLS_ENABLED.quantus_run_status` gibt es keinen Port.
   Selbst mit allem dreien fehlt der Quellensatz (siehe oben).
5. **Kein Warnweg.** Der Watchdog stellt Veralterung fest und scheitert mit
   `503 warning_delivery_failed`, solange kein `alert`-Port da ist. Die
   fehlgeschlagene Warnung wird verbucht, gilt aber nie als zugestellt.
6. **Ingress.** Die Zugangskontrolle ist IAM. Ob Scheduler und Tasks im
   gewaehlten Aufbau als interner Verkehr gelten, ist vor dem Anwenden
   gegen die aktuelle Google-Dokumentation zu pruefen.
7. **Kostenabschaetzung und Kontingente** sind nicht gerechnet; es wurden
   keine kostenpflichtigen Dienste aktiviert.
8. **Kein 14-Tage-Probebetrieb**, keine Alarmierung, keine Protokollsenken,
   kein Rollback-Drehbuch.
