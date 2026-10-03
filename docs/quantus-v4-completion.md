# Quantus v4 — verbindliche Fertigstellung

Auftrag vom 02.10.2026: **das vollständige Konzept implementieren**, nicht nur
Oberfläche und Audit. Referenz: Gesamtkonzept v4 vom 28.09.2026, 36 Seiten.
Ausgangsstand: main `f4d2b3a0acb72fb99f4596333a74ece92bbd0f5b`, lokal gleicher
Tree `5ab240104b8bf6854e63406df820165249ab387b`.

## Festgestellter Ausgangspunkt

- Gemeinsamer Fachkern, CAS/Idempotenz, Auth, vier API-Routen, Jobrouter,
  Laufzustand, Kostenreservierung und Infrastrukturdefinitionen existieren.
- `runtime/quantus-v3/src/f-composition.mjs` verdrahtet bisher Gmail und Anthropic;
  `section-work.mjs` erzeugt einen Entwurf, keinen OpenAI-geführten Werkzeugzyklus.
- `tool-ports.mjs` bietet Scheduler-/Prüfer-Verben, aber noch keinen vollständigen
  Werkzeugkatalog der Leitungsrolle für Originalobjekte.
- Desktopänderungen laufen noch über lokale Entitäten und Snapshot-Synchronisation.
  Die neue UI ist deshalb kein Nachweis eines API-only-Cutovers.
- Vorhandene Tests und alte Reviewberichte sind Hinweise auf Teilabdeckung,
  keine Abnahme des aktuellen integrierten Produktionsstands.

## Aktuelle Inventur der Begleitclients

- Tablet `de7d5950d97c22602fdec963669decb1878e9b95`: `public/app.js`
  `transactionOperation()` schreibt direkt per Firebase-Transaktion auf
  `appStore/app-data_json`; `public/sync-core.js` wendet die gespeicherten
  Offline-Operationen an. Queue und Konfliktablage müssen bei der Migration
  erhalten bleiben. Native BM-/Smarter-Schreibwege sind separate Knoten.
- Mobile `11def7943ba3c1029be031af8765a37d55b86423`: `js/store.js`
  `pushData()` sendet den ganzen Bestand per `PUT blob-put`, mit optionalem
  If-Match, aber ohne Auth-Header. `netlify/functions/blob-put.mjs` in diesem
  Repo besitzt außerdem einen eigenen Netlify-Blob-Schreiber mit optionaler,
  nicht atomarer Vorabprüfung. Welches Ziel produktiv konfiguriert ist, ist
  damit noch nicht belegt. Kein Abschalten vor Ersatz und Queue-Abnahme.
- Statuszugriff korrigiert: `ROLE_POLICY.lead_agent` erlaubt jetzt
  `run_status` nur mit der bestehenden Auftragsbindung. Positive und negative
  Tests durch den echten C2-Leseweg prüfen eigene und fremde Laufzuordnung.
  Kein Scheduler-Credential wird für Modellwünsche verwendet.

## Arbeitspakete und Reihenfolge

1. Inventur aller Writer und drei Client-Repositories aktualisieren; Backup und
   Restore mit unbekannten Nebenwirkungen im Testprojekt prüfen.
2. Fachkern/Command-Verträge gegen alle v4-Pflichten prüfen und Lücken schließen.
3. OpenAI-Leitungszyklus: vier Werkzeuge, vollständiger paginierter Kontext,
   persistierte Modellresultate, stabile Kommandos, Readback, Checkpoint und
   Wiederaufnahme; atomare Kostenreservierung und nachgewiesene Abrechnung.
4. Desktop, Tablet, Mobile und übrige Mutatoren migrieren; Offline-Queue und
   alte Änderungen erhalten; API-only erst nach Writer-Abnahme aktivieren.
5. Gmail/Calendar/Drive, Message-ID-Register und Gap-Recovery, Dokumentbelege,
   jobgebundene Claude-/Gemini-Rückläufe, MCP und verständliche Live-Ansicht.
6. Scheduler/Tasks/Run, unabhängiges Monitoring, Warnzustellung, Archivierung,
   Deployment/Rollback und reale Ende-zu-Ende-Prüfungen T01–T40.
7. Tatsächlicher 14-Tage-Probebetrieb: Woche 1 Schatten/Entwürfe; Woche 2 nur
   dokumentierte risikoarme Rechte. Zeit und fehlende Belege nicht simulieren.

## In dieser Phase implementiert

`openai-transport.mjs`: Responses-Transport mit explizit konfiguriertem Modell
und Preisen; unveränderlich vorbereitete Anfrage für die Kostenreservierung;
nur die vier Quantus-Werkzeuge; strikte lokale Validierung von Modellaufrufen;
keine Werkzeugausführung im Transport; Frist über Header und Body, Bytegrenze,
keine automatischen Wiederholungen, keine Provider-Fehlertexte in Rückgaben.
Bestätigter Verbrauch wird auch bei unbrauchbarem Modellresultat abgerechnet;
unklare Ergebnisse behalten den Status `unknown`. Statelose Fortsetzung erhält
Reasoning-Items. Noch nicht mit dem produktiven Leitungszyklus verdrahtet.

Referenz: https://developers.openai.com/api/docs/guides/function-calling
Prüfung: `npm run test:v4-leadership` (Netz durch kontrollierte Responses ersetzt;
keine kostenpflichtigen Provideraufrufe und kein Nachweis produktiver Freigabe).

### Werkzeugzugang (zweites Paket)

`leadership-gateway.mjs` definiert die vier Modellwerkzeuge und führt sie über
C2 mit kurzlebigem Job-Token aus. Lauf-ID, Lease und Idempotenzschlüssel bleiben
Laufzeitdaten. Command-Nutzlasten werden durch `parseCommandEnvelope` validiert;
Benutzerantworten, Policyänderungen und Finalisierung sind keine Modellverben.
Schreibbestätigungen benötigen die ausdrückliche Serverquittung samt Revision;
Pagination bleibt sichtbar. Ein Test führt den Gateway-Statusabruf durch echte
C2-Authentifizierung, Jobbindung und Feldprojektion aus.

Der C2-Transport begrenzt nun auch den Antwortkörper zeitlich und nach Bytes.
Er wiederholt unklare Befehle nicht automatisch und folgt keinen Redirects mit
Credentials. 363 gezielte Auth-/C2-/Laufzeit-/v4-Prüfungen bestanden.

Noch offen: Gateway mit dem dauerhaften Arbeitszyklus verbinden, Modellantwort
vor Aktion sichern, vollständigen Kontext/Readback/Checkpoint-Wiederaufnahme
integrieren. Der Gateway ist nach vollständiger CI-Prüfung als PR #277 übernommen.
Der lokale vollständige Testlauf des ersten Pakets endete ebenfalls erfolgreich.

### Serverbewertung in der Statusschnittstelle

Der bestehende Fachkern liefert jetzt beide Ampeln, Gesamtstatus, Bewertungszeit,
Gültigkeitsende, geprüfte Revision und Policyversion über den echten C2-Leseweg.
Abgelaufene oder durch neue Daten ungültige Bewertungen werden dort neu berechnet.
Die Gründe werden nach Achse, Code und Schwere mit Häufigkeiten zusammengefasst;
Quellkennungen und Freitext aus anderen Objekten werden dabei nicht offengelegt.
Bei mehr als 50 unterschiedlichen Gruppen oder ungültigen Gründen meldet die
Projektion ausdrücklich `evaluationReasonsComplete: false` samt Gesamtzahlen.
Die Originalobjekte bleiben über ihre gesondert autorisierten Kontextabfragen lesbar.

26 Prüfungen bestanden, einschließlich echter Kern-/C2-Abschlusskette, zeitlich
abgelaufener grüner Bewertung, nachträglichem Widerspruch, Begrenzung und
Feldprojektion. Das ist kein Nachweis eines produktiv laufenden Leitungszyklus.

### Dauerhafter OpenAI-Werkzeugzyklus

`leadership-journal.mjs` speichert aktive Anfragen, Modellantworten und
Werkzeugquittungen unveränderlich im geprüften Dateispeicher; ihre Referenzen
werden über den echten Core-Port samt CAS und Idempotenz bestätigt. Jede Mutation
prüft die Lease erneut; bestätigte Schreibvorgänge
werden unabhängig nachgelesen. Payload-Hashes binden die gespeicherten Inhalte.
Wiederholungsbelege enthalten nur kleine Quittungen statt vollständiger Antworten.
Ein Initialisierungsmarker verhindert stillen Neuaufbau eines gelöschten Journals.
Vor dem nächsten Modellaufruf wird Platz für Antworten und Werkzeugquittungen
berücksichtigt; bei Kapazitätsmangel stoppt der Ablauf sichtbar.

`leadership-loop.mjs` setzt je Aufruf eine Phase fort: bezahlte Modellantwort,
Werkzeugquittung oder Modellabschluss. Die Antwort wird vor Werkzeugausführung
gespeichert; bestätigte Kosten werden aus dem dauerhaften Providerbeleg abgeglichen.
Auch ein Absturz zwischen Speicherung und Abrechnung benötigt keinen zweiten
Modellaufruf. Ohne gespeicherte Antwort bleibt eine beanspruchte Anfrage gesperrt.
Werkzeugwiederholungen behalten die ursprünglichen Response-/Call-Kennungen.
Unklare Schreibquittungen bleiben blockiert; belegte Versionskonflikte dürfen dem
Modell zur bewussten Neubewertung zurückgegeben werden. Modelltext finalisiert
keinen Tageslauf. Modellkonfiguration, Werkzeugkatalog und Leitungsinstruktionen
bleiben gebunden; Transportpreise müssen bei Reservierung und Versand mit der
frischen Kostenrichtlinie übereinstimmen.

58 gezielte v4-/Kostenadapterprüfungen bestanden. Die neue Integrationsstrecke
verwendet das echte Kostenbuch, den echten Idempotenzumschlag, CAS-Prüfstand und
Responses-Transport mit kontrolliertem Netzersatz. Werkzeugwirkungen werden in
diesen Loop-Tests durch einen deterministischen Testport dargestellt; die echte
Gateway-/C2-Strecke hat gesonderte Tests. Noch offen sind die produktive
Zusammenstellung, vollständiges Kontextladen, verbindlicher Objekt-Readback,
Archivierung abgeschlossener Journale und die integrierte Abnahme T01–T40.
Die neue Schleife ist noch nicht als `sectionWork` aktiviert.

### Vollständigkeit und Erreichbarkeit von Kontextabfragen

`leadership-context.mjs` liest benannte Abfragen seitenweise und erklärt sie nur
bei bestätigter letzter Seite und gleicher Datenrevision für vollständig. Falscher
Scope, doppelte Kennungen, wiederholte Cursor, Teilantworten und Seiten-/Bytegrenzen
bleiben ausdrücklich unvollständig. Die Begrenzung dient dem Checkpoint-/Batching-
Pfad; sie ist keine Erlaubnis, verbleibende Einträge zu überspringen.

Der Gateway hält die queryabhängige Seitengrösse ein; `policy.current` erlaubt
zehn statt fünfzig Einträge. `policy_current` ist ein versionsunabhängiger Scope
auch für Richtlinienversionen mit Punkt. Richtlinienzugriff der Leitung bindet an
den tatsächlich vorhandenen zugewiesenen Lauf; Statusabfragen liefern nur den
adressierten Tag. Kontextobjekte behalten Quelltyp und Originalkennung. Die
Policyprojektion zeigt aktive Grenzen, Pflichtquellen, Abschlussregeln und Flags,
aber keine beliebigen verschachtelten Zusatzdaten.

28 gezielte Kontext-/Gateway-/Domänentests bestanden. Wichtig für die weitere
Zusammenstellung: Vollständige Pagination beweist nur die jeweilige Abfrage.
`run.context` enthält bisher die `itemRefs` des Laufs; der deterministische Aufbau
dieser Arbeitsmenge aus allen relevanten Originalobjekten und das Batch-Verfahren
bei grossem Kontext sind noch zu integrieren. Eine vollständige V4-Abnahme wird
daraus nicht abgeleitet.

### Inventur aus Originalobjekten

Der bestehende `run.ensure`-Pfad ergänzt beim neuen Slot die Arbeitsverweise nun
in derselben Revision aus den Originalsammlungen. Erfasst werden offene oder
nicht verlässlich abgeschlossene Leads und Aufgaben (auch spätere Nutzeraufgaben
als Kontext), aktive Projekte, offene Eingänge/Dokumente, Fragen mit unbearbeiteten
Antworten, diese Antworten selbst, nicht abgeschlossene Spezialistenarbeit,
registrierte Belege und nicht archivierte ChatGPT Notes. Es entstehen nur Verweise;
Originalzustände, Nutzerantworten, NoteFlow und Habits bleiben unverändert.

`syncRunInventory` kann spätere Eingänge nachtragen; dieser Kernbefehl gehört
nur dem Backend und akzeptiert keine vom Modell ausgewählte Teilmenge. Wiederholung
ist ein No-op; historische Verweise werden nicht gelöscht. Der Kontext liefert
alle diese Typen mit Originaltext, Fristen, Zuständigkeiten, Verbindungen und enger
Detailprojektion. Ein fehlendes Original wird sichtbar als `sourceMissing` markiert.
Beleglisten werden nicht mehr still nach 50 Kennungen abgeschnitten. Spezialisten
sehen weiterhin nur Quelle und explizite Kontextverweise ihres eigenen Auftrags.

52 gezielte Inventur-/Fachkern-/Domänenprüfungen und 448 erweiterte Prüfungen
bestanden. Die Aktualisierung bei ereignisgesteuerten Fortsetzungen, Quellenadapter,
Modell-Batching und produktive Worker-Zusammenstellung bleiben zu verdrahten.
Inventur ist keine Fortschrittsbestätigung oder Erlaubnis für externe Aktionen.

## Abnahmeregister

Jede Zeile braucht konkrete Prüfung, geprüfte Revision, tatsächliches Ergebnis
und verlinkten Nachweis. Ein fehlender Nachweis bleibt offen. Vorhandene ähnliche
Tests sind kein automatisches Bestehen. Das Register ist kein Erfolgszähler.

| ID | Verbindliches Ergebnis | Integrierter Nachweis |
|---|---|---|
| T01 | Ohne Auth-Konfiguration keine geschützte Lese-/Schreiboperation; 503 statt offener Endpunkt. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T02 | Falscher Principal, fremder Mandant oder fremder Lead: 401/403, keine Nebenwirkung. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T03 | Unbekanntes Verb, Feld, Blob-Key, Pfad oder zu grosse Nutzlast wird verworfen. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T04 | Gleicher Idempotenzschlüssel und Body erzeugt genau eine fachliche Mutation. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T05 | Gleicher Schlüssel mit anderem Body: 409; nach verlorener HTTP-Antwort kein Duplikat. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T06 | Innerer CAS-Retry darf keinen externen Call wiederholen; acht Konflikte enden sichtbar. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T07 | Fehlender oder unlesbarer Kern wird nicht als leere App überschrieben. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T08 | Desktop, Tablet, Mobile und Worker ändern parallel; Antworten, Runs und fremde Felder bleiben erhalten. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T09 | Verschachteltes assistantRuns überlebt explizites Merge, Reload und Gerätewechsel. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T10 | Alter Offline-Client kann weder geschützte Felder noch Löschmarkierungen überschreiben. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T11 | Benutzerantwort während Agentenupdate bleibt erhalten; veralteter Agentenschritt wird abgewiesen. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T12 | Legacy-Statusmigration ist wiederholbar; unbekannte Zustände werden nicht geraten. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T13 | Vom Agenten ausgelassener Lead oder nicht geladene Listenseite verhindert falsches Grün. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T14 | Wartender Lead ohne vollständigen und belegten Folgeschritt bleibt gelb/rot. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T15 | Drei Verschiebungen ohne fachlichen Fortschritt sperren Grün; neue Texte setzen den Zähler nicht zurück. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T16 | Vom Agenten übergebenes overall=green, finalAt oder eine Finalnote wird abgewiesen. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T17 | Finalisierung, Abschlussrevision und Finalnote sind atomar und idempotent. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T18 | Neue widersprechende Information invalidiert den Abschluss; unveränderte historische Note ist erkennbar. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T19 | Abgelaufene Lease oder alter Fencing-Token sperrt einen verspäteten Worker. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T20 | Doppelte Queue-Auslieferung, Outbox-Neuzustellung und Workerabbruch verlieren keinen Job. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T21 | Fehlender 04:00-Start wird unabhängig erkannt und nachgeholt; Ausfallhistorie bleibt bestehen. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T22 | Europe/Zurich, Sommer-/Winterzeit und nachgeholte Slots erzeugen eindeutige Laufnachweise. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T23 | 23:00 erstellt nicht das morgige Briefing; 04:00 übernimmt offene Referenzen ohne Kopien. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T24 | Zeit-/Kostenlimit speichert Restarbeit; kein grüner Abschluss und keine Endlosschleife. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T25 | Parallele Kostenreservierungen können das genehmigte Limit nicht überziehen. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T26 | Versand-Timeout bleibt outcome_unknown; kein Blind-Resend und kein falsches „gesendet“. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T27 | Widerrufene Freigabe oder geänderter Inhalt stoppt eine wartende Outbox-Aktion. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T28 | Mailcursor-Lücke führt zum Nachabgleich; Message-ID bleibt eindeutig; keine stumme Mailverluste. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T29 | Risikomail wird trotz hoher Modellkonfidenz und trotz Modellmehrheit nicht unberechtigt ausgeführt. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T30 | Manipulierte Mail/PDF/Workerantwort kann weder Policy ändern noch Daten an fremde Ziele exportieren. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T31 | Unlesbare Datei bleibt offen; OCR und Verknüpfungen benötigen prüfbare Belege. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T32 | Claude/Gemini sieht nur den Jobkontext; veralteter Rücklauf kann keinen Lead abschliessen. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T33 | Frage erscheint sofort; Antwort wird einmal konsumiert; kein automatischer Chat-Unterbruch. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T34 | Snooze, Urlaub und Minimalbetrieb verschieben keine harten Fristen und erzeugen kein falsches Grün. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T35 | Archivfehler verhindert Kürzung; offene Jobs und alte Replays bleiben sicher behandelt. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T36 | Start-/Finalnoten und Cache-Status überleben Reload; offline wird keine aktuelle Prüfung behauptet. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T37 | Appübergreifende Handler funktionieren tatsächlich; benötigte Desktop-window-Exporte sind vorhanden. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T38 | Bestehende Notes-, Lead-, Task-, Link-, Attachment- und Sync-Tests bleiben grün. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T39 | Monitor erkennt fehlenden eigenen Heartbeat und gestörte Benachrichtigungszustellung. | Offen: gegen aktuellen integrierten Stand auszuführen. |
| T40 | Backup/Restore im Testprojekt reaktiviert keine bereits versandte externe Aktion. | Offen: gegen aktuellen integrierten Stand auszuführen. |

## Verbindung zwischen Worker und Tageslauf

Der produktiv konfigurierte Quellen-Worker legt vor dem ersten Quellenzugriff
den Tageslauf mit Slotbeleg und genau einer Startnotiz pro Tag an. Jeder neue
Arbeitsabschnitt synchronisiert die offenen Originalreferenzen erneut. Die
Schritte verwenden die bestehenden Domain-Kommandos und den vorhandenen
CAS-/Idempotenzumschlag; eine separate Lesekontrolle bestätigt den Bestand,
bevor die eigentliche Quellenarbeit beginnen darf.

Mandant, Policy-Version, aktueller Abschnitt, Besitzer und Lease werden auch
bei wiedergegebenen Belegen geprüft. Fehlende Startnotizen, abgelaufene Rechte
und nicht gespeicherte Schreibvorgänge sperren die Quellenarbeit. Nach einem
Checkpoint darf die neue Lease nur den exakt gespeicherten, vom aktuellen
Abschnitt konsumierten Zwischenstand übernehmen. Der historische Checkpoint
bleibt unverändert.

Geprüft mit dem echten lokalen HTTP-Worker und der produktiven
Quellen-Komposition, zusätzlich mit dem echten Idempotenzumschlag einschließlich
CAS-Konflikt, Lease-Wechsel, falscher Schreibbestätigung und manipulierter
Fortsetzung. Dies schließt weder die OpenAI-Gesamtkomposition noch den
produktiven Probebetrieb ab. Begrenzte Quellen-Artefakte, vollständige
Kontext-Batches und der Leitungszyklus müssen noch gemeinsam verdrahtet werden.

## Große Arbeitsinhalte und dauerhafte Fortsetzung

Der Quellen-Worker speichert Arbeitsinhalte als unveränderliche Objekte in
einem ausdrücklich konfigurierten Cloud-Storage-Bucket. Im Kern stehen nur
Hash, Objektname, Generation und Größe. Der Fortsetzungscursor bleibt unter
500 Byte, auch wenn die gelesenen Nachrichten mehrere hundert KiB umfassen.
Ein Upload überschreibt kein bestehendes Objekt (`ifGenerationMatch=0`);
Metadaten und generationsgebundener Download werden vor der Kernreferenz
unabhängig geprüft. Fremde Buckets, Mandantenpfade, falsche Hashes und nicht
mehr vorhandene Generationen werden abgewiesen.

Vor jedem Zugriff werden erzwungener Schutz gegen öffentliche Freigabe und
einheitliche Bucket-IAM-Rechte geprüft. Der Runtime-Parameter
`QUANTUS_V4_ARTIFACT_BUCKET` ist zwingend; es gibt keinen Rückfall auf den
vorhandenen Firebase-Standardbucket oder auf Mailtexte im Kern. Der Worker
benötigt `storage.buckets.get`, `storage.objects.create` und
`storage.objects.get` für diesen Bucket. Der konkrete Bucket und seine
produktiven IAM-Rechte sind noch separat nachzuweisen.

Ein kleiner CAS-Beleg beansprucht jeden Schritt vor seiner Ausführung.
Bestätigte Ergebnisse werden nach Neustart wiedergegeben; ein beanspruchter
Schritt ohne bestätigtes Ergebnis bleibt unklar und wird nicht automatisch
wiederholt. Aktive Inhalte und Belege werden hier nicht gekürzt. Die spätere
Archivierung abgeschlossener Abläufe und die vollständige OpenAI-Komposition
sind weiterhin offen.

Auch das Leitungsjournal speichert Anfragen, Modellantworten und Werkzeug-
Ergebnisse extern. Der Kern enthält ausschließlich unveränderliche Referenzen;
die Kostenabrechnung verwendet nur eine separat gelesene und hashgeprüfte
Providerquittung, deren Referenz im selben CAS erneut abgeglichen wird.
Anfragen/Werkzeug-Ergebnisse bleiben auf 512 KiB, Providerantworten auf 3 MiB
und ein vollständiger Journal-Lesevorgang auf 16 MiB begrenzt.

Bestehende Inline-Journale werden vor einem neuen Leitungszyklus umgestellt:
erst sämtliche Inhalte extern schreiben und zurücklesen, dann ausschließlich
die weiterhin identische Journalrevision per CAS durch Referenzen ersetzen.
Speicherfehler, Abbruch, verlorene Lease oder zwischenzeitliche Änderungen
lassen die alten Inhalte ungekürzt bestehen. Eine fehlende externe Antwort
berechtigt weder zu einem erneuten Modellaufruf noch zur Werkzeugausführung.

Grundlagen: [Cloud Storage Preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
und [Bucket-IAM-Konfiguration](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets).

## Betriebsfreigabe

Keine neuen bezahlten Aufrufe ohne vorhandene genehmigte Kostenkonfiguration.
Keine zusätzliche parallele Leitung. Vorhandene Hauptläufe werden erst beim
geprüften Cutover ersetzt. Schutzregeln niemals zum Bestehen eines Tests lockern.

### Vollständige v4-Anweisungen und auslieferbare Laufzeit

Die fünf Textblöcke aus Kapitel 15/16 sind als Version 4.0.0 mit einzeln
geprüften Hashes hinterlegt. Die v4-Leitung bindet den tatsächlichen Slot,
Mandanten, Tagesauftrag und die Befehlsverträge der Leitungsrolle; spätere
Aufrufparameter können die Anweisungen nicht ersetzen. Startanlage,
Antwortkonsum und Finalisierung erhalten dadurch keine erweiterten Modellrechte.
23 Prompt-/Schleifenprüfungen inklusive echter Kostenbuchung, dauerhafter
Wiederaufnahme und Zurückweisung fremder Mandanten/alter Versionen bestehen.

Das bisherige Dockerfile kopierte nur zwei Backend-Dateien und keine
Abhängigkeiten oder Prompts. Es kopiert jetzt die Backend-Module und Prompts
sowie per Lockdatei installierte Produktionsabhängigkeiten. Die CI baut das
wirkliche Abbild und prüft darin ohne externes Netzwerk alle Laufzeitimporte,
dynamische OAuth-/Kernimporte, beide Prompt-Versionen und einen HTTP-Start
mit fehlender Konfiguration (503). Die neue v4-Factory muss noch mit dem
produktiven Abschnittsablauf verbunden werden; vollständige Kontextdeckung,
Original-Rücklesen, Backend-Prüfung und 14-Tage-Nachweis bleiben offen.

### OpenAI im produktiven Worker-Aufrufweg

`server.mjs` verwendet die neue OpenAI-Komposition. Sie verbindet Startanlage,
Originalinventar, v4-Anweisungen, echte C2-Werkzeuge, externe Journalablage und
frische Kostenprüfung mit dem Abschnittsablauf. Die feste gemeinsame
50-USD-Monatsgrenze wird innerhalb derselben Reservierung geprüft. Fehlende
Konfiguration wechselt nicht zu Anthropic. Der alte F-Entwurfsadapter bleibt
separat erhalten, ist nicht mehr der Server-Einstieg.

Explizite Sperren erzeugen eine dauerhafte offene Ausnahme. Ein unbekanntes
Provider-Ergebnis wird über neu aufgebaute Worker hinweg nicht erneut gesendet.
Das Abschnitts-Abbruchsignal unterbricht auch hängende C2-Antwortstreams und
verhindert Werkzeugversand nach abgebrochener Token-Ausstellung.

Nachweise: 158 gezielte v4-/Worker-/C2-/Kostenprüfungen bestehen, einschliesslich
des expliziten Budget-Sperrpfads. Keine produktiven Provideraufrufe oder Gate-Freigaben wurden ausgeführt.
Quellaktualisierung, Kontextdeckung, Original-Rücklesen und Backend-Finalisierung
bleiben unvollständig; `model_complete` ersetzt keinen dieser Nachweise.

### Unabhängiges Rücklesen nach Leitungsbefehlen

Erfolgreiche Leitungsbefehle liefern typisierte Referenzen mit Objektversion und
SHA-256 des vollständigen Originalinhalts (bei Leads/Tasks einschliesslich
Wartedatensatz). Die neue enge Abfrage `run.readback` liest genau dieses Original
frisch aus dem Kern, gebunden an den zugewiesenen Tageslauf. Sie ist nur der
Leitung zugänglich, erlaubt keine Cursor oder beliebigen Pfade und liefert
Fingerabdrücke statt zusätzliche Rohdaten. Neu angelegte Tasks bleiben über
ihren bereits zugewiesenen Lead prüfbar, bevor das nächste Inventar läuft.

Der produktive Gateway bestätigt einen Schreibvorgang erst nach den separaten
Leseaufrufen für alle betroffenen Originale. Identität, Fingerabdruck, Version,
Tageslauf, vollständige Antwort und Datenrevision müssen passen. Ein fehlender
Beleg alter Server, ausgeschaltetes Lesewerkzeug, widersprüchliche Version oder
Leseausfall bleiben unbestätigt. Es entsteht kein zweiter Schreibaufruf.

Die echte C2-Kette bestätigt Lead und Kommentar; die Wiederholung bleibt
idempotent. Nach Änderung des Originaltexts ohne Änderung des Zustandszählers
wird der alte Erfolg nicht mehr bestätigt. Die Fachadapterprüfungen lesen auch
die Belege der übrigen Leitungsverben unmittelbar zurück. Kontextdeckung,
Quelladapter, Wiederabgleich blockierter Fälle, Backend-Abschluss und
produktiver Probebetrieb bleiben offene Integrationspunkte.

### Vollständige Kontextlesung und verbindliche Abschlusskontrolle

Ein echter Integrationsfehler war die eigene Protokollierung zwischen
Kontextseiten: Sie erhöht die Datenrevision und entwertet dadurch den nächsten
signierten Cursor. Der Gateway liest jetzt zusammenhängende Seiten vor dem
Journal-Schreibvorgang. Jede Seite muss vollständig, eindeutig und an dieselbe
Revision gebunden sein. Grenzen, Wiederholungen, Drift oder Leseausfälle ergeben
einen begrenzten Fehlerbeleg, keine abgeschnittene Erfolgsantwort.

Die neue Leitungsabfrage `run.workset` vereinigt historische Run-Referenzen mit
dem frisch bestimmten vollständigen Inventar. Neue offene Vorgänge werden auch
innerhalb eines Abschnitts sichtbar; der Bootstrap bindet sie vor der nächsten
Arbeitsphase an den Lauf. Spezialisten erhalten keinen erweiterten Kontext.

Ein v4-Modellabschluss braucht protokollierte vollständige Policy-, Workset- und
Statuslesungen. Nach Schreibvorgängen sind Workset und Status erneut erforderlich.
Die Backend-Prüfung liest anschliessend alle drei nochmals, vergleicht Inhalte
und bindet sie an eine gemeinsame aktuelle Revision. Fehlende Lesungen und neue
Inhalte führen den Modellzyklus weiter; unlesbare Originale oder widersprüchliche
Policy bleiben blockiert. Vor dem Speichern des Kontextnachweises prüft CAS die
Revision nochmals und liest den gespeicherten Nachweis unabhängig zurück.

Diese Durchsetzung ersetzt nicht den Tagesabschluss. Übergrosse Arbeitsbestände
und wachsende Modellhistorien benötigen weiterhin dauerhafte Kontextpakete;
der jetzige Leseweg hält bei 384 KiB oder 100 Seiten ausdrücklich unvollständig
an. Quellaktualisierung, Backend-Antwortkonsum/Finalisierung, Wiederabgleich
blockierter Fälle, vollständige Client-Umstellung und Probebetrieb bleiben offen.

### Verdichtung langer Modellverläufe mit erhaltenen Originalbelegen

Die produktive OpenAI-Komposition unterstützt jetzt explizit konfigurierte
serverseitige Responses-Kompaktierung. Die Schwelle ist Bestandteil des
unveränderlichen Laufvertrags. Providerwechsel, zusätzliche unprotokollierte
Modellaufrufe und automatisches Abschneiden von Quelltexten entstehen dadurch
nicht. Kostenreservierung, gesicherte Providerantwort, Verbrauchsabgleich und
Wiederaufnahme verwenden denselben bestehenden Weg.

Ein gültiges verschlüsseltes Compaction-Element darf frühere Eingaben nur im
nächsten Modellkontext ersetzen. Das Journal enthält weiterhin die vollständigen
ursprünglichen Anfragen und Werkzeugantworten; insbesondere bleibt die
unabhängige Kontextdeckung nach Verdichtung prüfbar. Falsche Marker, doppelte IDs,
unerwartete Reihenfolge nach einem offenen Werkzeugaufruf und nicht konfigurierte
Kompaktierung werden abgewiesen. Ein verlorenes Schreib-Acknowledgement lässt
sich aus dem gespeicherten Originalresultat ohne erneuten Provideraufruf erholen.

Ein Integrationstest führt zwei grosse Werkzeugantworten über frische Worker-
Instanzen fort: Der unverdichtete Folgeverlauf überschreitet 512 KiB, der geprüfte
Fortsetzungsstand bleibt innerhalb der Grenze. Die Produktionskomposition weist
nach der Verdichtung weiterhin echte Policy-/Workset-/Statusdeckung nach.
Ohne gültige Verdichtung hält ein zu grosser Verlauf ausdrücklich vor einem
weiteren bezahlten Aufruf an. Die lokale Durchsetzung folgt der
[offiziellen Responses-Kompaktierung](https://developers.openai.com/api/docs/guides/compaction).
Modellunterstützung, Schwelle und echte Providerantworten sind produktiv noch
nachzuweisen; grosse einzelne Arbeitsbestände benötigen weiterhin Kontextpakete.

### Dauerhafte Kontextpakete mit vollständiger Lesekette

`run.workset` kann jetzt auch grosse Originale über bytebegrenzte C2-Seiten
ausliefern. Die Feldprojektion und Geheimnisprüfung erfolgen vor jeder Aufteilung;
dadurch können weder interne Felder noch ein über eine Fragmentgrenze laufender
Geheimniswert den bisherigen Schutz umgehen. Standardlesungen behalten ihre
bestehende Textgrenze; nur die vertrauenswürdige Vorprüfung eines ganzen Workset-
Originals nutzt eine ausdrücklich begrenzte 16-MiB-Textprüfung.

Der Leitungsworker liest den vollständigen Bestand bei einer gemeinsamen Revision,
setzt grosse Originale mit Hashprüfung wieder zusammen und schreibt unveränderliche
128-KiB-Pakete samt vollständigem Manifest in den privaten Artefaktspeicher.
Generation, Hash, Lauf, Mandant, Umfang und Originalinhalt sind gebunden. Vor jeder
Paketfortsetzung erfolgen eine aktuelle C2-Autorisierung und Leaseprüfung; eigene
Journalmutationen verändern den gesicherten Inhalt nicht. Restore auf eine ältere
Datenrevision, Speicherverlust, fremder Lauf und widerrufene Rechte bleiben gesperrt.

Der Abschlussprüfer zählt nur eine lückenlose, geordnete Manifestkette. Fehlende
Pakete ergeben den konkreten nächsten Cursor. Nach einer Änderung während der
Lesekette ist eine neue vollständige Lesung erforderlich; vermischte Generationen
oder nur das letzte Paket genügen nicht. Der anschliessende Frischabgleich liest
den Gesamtbestand neu und vergleicht dessen vollständigen Inhaltsfingerabdruck.

Belegt sind der echte autorisierte C2-Weg mit einem Original über einem Megabyte,
verlustfreie Unicode-Rekonstruktion, geschützte interne Felder, fortgesetzte
Produktionskomposition über neue Workerinstanzen und unabhängige Kontextdeckung.
Schnappschüsse sind noch auf 16 MiB/2000 API-Seiten begrenzt. Der nachfolgende
Baustein ergänzt den dauerhaften Abschnittswechsel für lange Journale.
Quellaktualisierung, Antwortkonsum/Tagesabschluss, Client-
Umstellung und produktiver Probebetrieb bleiben ebenfalls offen.

### Lange Journale über dauerhafte Nachweisabschnitte fortsetzen

Der Worker wechselt jetzt vor dem bisherigen globalen 30-Aufrufe-/16-MiB-Stopp
in ein neues aktives Journalfenster. Ab 30 aktiven Einträgen oder 8 MiB Nutzinhalt
werden ausschliesslich bestätigte Vorgänger mit ihren unveränderten Original-
referenzen und Kostenbindungen privat gespeichert und unabhängig zurückgelesen.
Die jüngste Anfrage bleibt vollständig aktiv. CAS ersetzt den aktiven Abschnitt
erst nach exaktem Vergleich und erneuter Lease-/Kostenprüfung; der neue Zustand
wird anschliessend unabhängig bestätigt.

Die fortlaufende Aufrufsequenz und sämtliche Idempotenzkennungen bleiben erhalten.
Bei verlorener Wechselquittung wird die offene Werkzeugphase mit derselben
Identität fortgesetzt. Frühere Kommandos werden nicht neu ausgeführt. Ein Replay
eines archivierten Journalaufrufs liest den bestehenden Originaleintrag zurück;
geänderte Nutzinhalte werden weiterhin abgewiesen.

Für normale Schritte genügen die unveränderlichen Kontextnachweise der früheren
Abschnitte. Vor jedem vorgeschlagenen Abschluss liest der Worker deren vollständige
Originalanfragen, Modellantworten und Werkzeugbelege abschnittsweise zurück,
berechnet die Nachweise neu und gleicht Kostenbelege ab. Danach folgt weiterhin
die frische, unabhängige Gesamtbestandsprüfung. Fehlende Originale, falsche
Zusammenfassungen, unvollständige Paketketten und widersprüchliche Kosten können
keinen erfolgreichen Abschluss erzeugen.

Belegt sind 66 Modellaufrufe mit echter Kostenbuchhaltung und synthetischen
Providerantworten über mehr als 16 MiB erhaltene Originalbelege,
eine vollständige Produktionskomposition mit mehr als 30 Aufrufen und über
Abschnittsgrenzen gelesenen Kontextpaketen, verlorene Quittung, konkurrierende
Benutzeränderung, abgelaufene Lease sowie fehlende/abweichende Originalnachweise.
Die künstlichen Testkosten sind keine produktive Aktivierungsfreigabe. Es werden
keine Payloads gelöscht; 60-Tage-Aufbewahrung, reale Quellenaktualisierung,
Antwortkonsum/Tagesabschluss, Clientumstellung und Probebetrieb bleiben offen.

### Vollständiger, kontogebundener Gmail-Leseadapter

Der neue `gmail-v4-reader` ersetzt als Grundlage des nächsten Importpfads die
1200-Zeichen-Kürzung und den ausschliesslich zeitbasierten Mailabruf. Er liest
vollständige MIME-Bäume mit allen Textalternativen, gemischter Schreibweise von
Headern und auch Textkörper, deren Bytes erst über die Attachment-API erreichbar
sind. Originalantworten und nachgeladene Körper bleiben unverändert verfügbar.
Anhänge, nicht unterstützte Kodierungen und fehlende Körper werden als konkrete
Lücken zurückgegeben. HTML wird weder dargestellt noch als Anweisung ausgeführt.

Die paginierte vollständige Auflistung umfasst archivierte Nachrichten und
schliesst explizit Chats, Spam und Papierkorb aus. Der ungefilterte Änderungsverlauf
liefert Hinzufügen, Löschen und Labeländerungen; grosse History-IDs bleiben Strings.
Ein abgelaufener Verlauf liefert ausdrücklich `resetRequired`, keinen erfolgreichen
Leerbestand. Dies folgt dem [offiziellen Gmail-Abgleich](https://developers.google.com/workspace/gmail/api/guides/sync).
Jeder HTTP-Aufruf ist an das konfigurierte Konto und den festen Google-Ursprung
gebunden; Redirects, beliebige URLs, Schreiboperationen und Geheimnisse in
Fehlermeldungen sind ausgeschlossen. Zeit- und Grössenlimits führen zum offenen
Fehler, niemals zur stillen Kürzung. Die Nachricht besitzt zusätzlich eine
Gesamtfrist über alle nachgeladenen Körper hinweg.

Die Verhaltenstests verwenden synthetische Gmail-Antworten, einschliesslich
mehr als 500000 Zeichen Unicode, Out-of-line-Körpern, Charset-Lücken,
History-404, Kontoverwechslung, unterbrochener Tokenbeschaffung und endlosen
Antwortströmen. Der Adapter allein setzt keinen Quellcursor und meldet keinen
produktiven Quellenabschluss. Die dauerhafte Message-ID-Registry, CAS-Import mit
Original-Readback, Gap-Nachabgleich, Anhangsauswertung und Einbindung in die
OpenAI-Produktionskomposition folgen noch; T28 bleibt offen.

### Vollständige Mailoriginale in privaten Speicherteilen

`gmail-original-store` sichert die unveränderte JSON-Antwort des neuen Mail-
Leseadapters einschliesslich aller Originale und nachgeladenen Körper ausserhalb
des Kerndokuments. 256-KiB-Byteabschnitte halten jedes Speicherobjekt unter der
bisherigen Grenze. Ein unveränderliches Manifest bindet Konto, Mandant, Quelle,
Provider-Message-ID, vollständigen Inhaltshash, Bytezahl und geordnete Teile.
Unicode über Abschnittsgrenzen bleibt bei der Rekonstruktion exakt erhalten.

Jeder Schreibschritt wird separat zurückgelesen. Vor Rückgabe einer bestätigten
Speicherreferenz werden Manifest und sämtliche Teile nochmals vollständig gelesen
und der Gesamtinhalt mit dem ursprünglichen Text verglichen. Die aktuelle Lease
und Abbruchbedingung werden vor und nach jeder Speicheroperation geprüft. Ein
verlorener Uploadbeleg lässt sich über dieselben unveränderlichen Inhaltshashes
fortsetzen; ein fehlender oder veränderter Teil, falsche Generation, fremdes Konto,
entzogene Speicherprivatheit und Leaseverlust verhindern eine Bestätigung.

Belegt sind vollständige Leser-Ausgaben über 3 MiB, neue Workerinstanz, identische
Wiederholung, manipulierte oder vertauschte Teile sowie Speicher-/Leasefehler.
Die Grenze liegt bei 32 MiB pro Originalbündel und 128 Teilen; darüber wird
ausdrücklich abgebrochen. Noch setzt dieser Baustein keinen Quellcursor und legt
keine Intake-Karte an. Registry, CAS-Übernahme, autorisierte Quellenanbindung und
die Einbindung der Originale in den Arbeitsbestand bleiben der nächste Schritt.
T28 und der produktive Gesamtabschluss bleiben offen.

### Dauerhaftes Mailregister mit atomarer Originalübernahme

`gmail-message-registry` führt unter dem geschützten Laufzeitbestand ein
kontogebundenes Register je Provider-Message-ID. Es gibt keinen flüchtigen Ring
der letzten 300 Kennungen mehr in diesem neuen Importpfad. Im Kern stehen nur
die aktuelle Originalreferenz, Inhaltshash, History-ID, Version und tatsächliche
Leselücken. Frühere Versionen bleiben als unveränderliche private Referenzkette
erhalten. Eine andere Mailbox oder Quelle besitzt einen getrennten Namensraum.

Der Import speichert und liest das vollständige Original vor der CAS-Transaktion.
CAS übernimmt die neue Version nur bei weiterhin passender Lease, Laufsektion
und exakt unverändertem Vorgänger. Uploads und Quellenzugriffe erfolgen nie im
wiederholbaren Mutator. Unabhängiges Rücklesen prüft anschliessend den gespeicherten
Registereintrag und dessen vollständiges Original. Gleichzeitige Benutzeränderungen
bleiben erhalten; ein verlorener Transaktionsbeleg wird über den vorhandenen
Eintrag bestätigt, ohne eine weitere Version oder einen zweiten Core-Schreibvorgang.

History-Rückschritte, abweichende Inhalte bei gleicher History-ID, fehlende
Originale und ein nach Initialisierung verschwundenes Register werden nicht
stillschweigend repariert oder als leer gewertet. Die Vorgängerlesung folgt nur
der tatsächlich gespeicherten Referenzkette und prüft die direkte Versionsfolge.
Die bestehende 18-MiB-Core-Grenze bleibt durchgesetzt; keine Registereinträge oder
Originale werden zur Platzgewinnung gelöscht.

Die Tests verwenden den echten Integrations-/Idempotenzumschlag mit CAS-Prüfstand
und privatem Artefaktspeicher-Prüfstand. Sie prüfen über 300 Nachrichten,
Wiederaufnahme, Versionshistorie, verlorene Quittung, Benutzerkonflikt, Änderungen
während des Rücklesens und Leaseverlust vor CAS. Der Worker importiert damit noch
nicht produktiv: Seiten-/History-Fortsetzung, Intake-/Arbeitsbestandseinbindung,
autorisierter OAuth-Zugang und produktive T28-Nachweise bleiben offen. Registrierung
allein bedeutet weder Klassifikation noch Bearbeitung oder erfolgreichen Quellenabschluss.

### Fortsetzbarer Gmail-Seitenabgleich und History-Gap-Nachabgleich

`gmail-source-sync` verbindet den vollständigen Leser mit dem dauerhaften Register.
Jeder Aufruf erledigt genau einen Quellenarbeitsschritt: Profil/Wasserzeichen,
Seitenabruf, einzelne Nachrichtenübernahme oder bestätigter Seitenwechsel. Die
unveränderliche Seite wird vor dem ersten Eintrag privat gespeichert und unabhängig
zurückgelesen; im Core bleiben nur Referenz, Position, Suchumfang und Abgleichstand.
Jede Nachrichtenposition wird erst nach bestätigter Registrierung weitergesetzt.
Innerhalb derselben CAS-Transaktion muss der betreffende Registereintrag weiterhin
exakt dem zuvor unabhängig gelesenen Beleg entsprechen.

Der erste vollständige Abruf sichert vorab die aktuelle Profil-History-ID. Nach
der letzten Listenseite zieht der Worker sämtliche seitdem eingegangenen Änderungen
über den Verlauf nach. Nur die vollständig verarbeitete letzte Verlaufsseite
schreibt das neue Wasserzeichen. Ein History-404 startet einen neuen vollständigen
Nachabgleich; bestehende Registereinträge, Originale und Leselücken bleiben erhalten.
Seitenschleifen und rückwärts laufende History-IDs erzeugen einen offenen Fehler.

Verlorene Register- oder Checkpointquittungen überspringen keine Nachricht und
erzeugen keine zweite Originalversion. Ein neuer Lauf übernimmt eine noch offene
Seite mit ihrer gespeicherten Position. Nach abgeschlossenem Abruf beginnt der
nächste Lauf inkrementell am zuletzt bestätigten Wasserzeichen. Ein Message-404
ist ausdrücklich eine fehlende Quelle und kein Löschbeweis; ungelesene Anhänge
bleiben ebenfalls sichtbare Lücken. Diese Lücken überleben einen Gap-Nachabgleich.

Belegt ist die Kette aus echtem Gmail-Leser, Artefaktspeicher, Originalbündeln,
Register und CAS-Umschlag mit synthetischen Gmail-/Storage-Antworten. Seiten sind
auf 3 MiB und 10000 IDs begrenzt; darüber bleibt der Abgleich offen. Der Baustein
meldet ausschliesslich das Ende des Abrufs, keinen fachlichen Quellenabschluss.
Intake-/Arbeitsbestandseinbindung, Anhangsauswertung, OAuth-/Produktionsanbindung
und Laufzeitnachweise im 90-Sekunden-Worker folgen noch. T28 bleibt produktiv offen.

### Expliziter Google-Zugang für den Cloud-Worker

`google-oauth-token-source` ergänzt eine serverinterne Verbindung zum bestehenden
siteweiten Netlify-Store `quantus-google-oauth`, Schlüssel `tokens`. Cloud Run
benötigt dafür ausdrücklich konfigurierte Site-ID, Netlify-Zugang und Google-
Clientdaten; fehlende Werte führen zu `unavailable`, ohne eine andere Site oder
ein Dienstkonto als Gmail-Nutzer zu erraten. Die Schnittstelle folgt dem
[Netlify-Blobs-Zugriff](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
und der [Google-Token-Erneuerung](https://developers.google.com/identity/protocols/oauth2/web-server).

Jeder Aufruf liest die aktuelle Verbindung mit starker Konsistenz. Ein abgelaufener
Zugang wird ausschliesslich am festen Google-OAuth-Endpunkt erneuert, mit begrenzter
Zeit, Antwortgrösse und Gültigkeitsdauer. Der neue Datensatz darf den alten nur
unter dessen ETag ersetzen; anschliessend erfolgt ein unabhängiges Rücklesen.
Neue Anmeldung, Trennung, verlorene Quittung, fehlender Gmail-Leseumfang und
abweichende Speicherung erzeugen keinen bestätigten Zugang. Aufrufer erhalten nur
das Access-Token; Refresh-Token und Clientgeheimnisse bleiben im privaten Adapter.
Fehler enthalten feste Kennungen und keine Provider- oder Speicherantworten.

Ein konkreter Befund der installierten Blobs-Bibliothek wurde berücksichtigt:
`setJSON` reicht die Schreibbedingung dort nicht korrekt an den Client weiter.
Der Adapter nutzt deshalb `set` mit serialisiertem JSON und `onlyIfMatch`.
Ein Test über die echte installierte Bibliothek bestätigt den tatsächlichen
`If-Match`-Header sowie die Ablehnung einer konkurrierenden Verbindung.

Die Tests verwenden künstliche Zugangsdaten und HTTP-Antworten. Produktive Secrets
wurden weder gelesen noch konfiguriert; ein tatsächlicher Kontozugriff ist noch
nicht nachgewiesen. Die aktuelle Workeranbindung ist weiter unten beschrieben.
Der bisherige Netlify-Refreshpfad in `gcal-shared` verwendet nun denselben
bedingten Schreibweg und unterstützt weiterhin erzwungenes Erneuern. Bestehende
Kalender-Anmeldungen benötigen dort keinen zusätzlichen Gmail-Scope. Auch die
nachträgliche Kontoadresse wird nur bei passendem Access-Token und ETag gespeichert;
eine gleichzeitig getrennte Verbindung wird nicht dadurch wieder angelegt.
Ein Test über den echten gemeinsamen Netlify-Helfer und Blobs-Client bestätigt
diese Kompatibilität und den Konkurrenzschutz mit künstlichen HTTP-Antworten.

### Vollständige Originale aus dem Gmail-Register lesen

`gmail-message-registry.readPage` liefert pro Aufruf genau ein unabhängig
zurückgelesenes Original samt verbindlicher Registerversion, Hash, Anhangslücken
und Fortsetzungsposition. Die Reihenfolge entsteht aus dem vollständigen Register,
nicht aus einer vom Modell ausgewählten ID-Liste. Der Fingerabdruck bindet Konto,
Quelle, Registerrevision und sämtliche aktuellen Datensätze. Fortsetzungen sind
auch über neue Instanzen möglich; Änderungen an irgendeinem Registereintrag
während oder zwischen Seiten lassen den Durchlauf scheitern. Ein fehlendes
Register gilt nicht als leere, erfolgreich gelesene Quelle.

Die Tests lesen alle 301 Nachrichten über frische Instanzen genau einmal und ohne
Kernschreibvorgang zurück. Weitere Gegenproben decken vollständigen grossen Inhalt,
ungelesene Anhänge, fremde und veraltete Fortsetzungen, fehlende Originale,
Änderungen einer anderen Nachricht ohne Revisionsanstieg und abgelaufene Leases ab.
Unabhängige Benutzereingaben ausserhalb des Registers bleiben möglich.

Dies ist die serverinterne Lesegrundlage für die nächste Arbeitsbestandseinbindung.
Eine Fortsetzungsposition ist ausdrücklich kein Vollständigkeitsnachweis für das
Modell. Der Verbraucher muss die gesamte Seitenkette speichern und prüfen; die
Verbindung zu Intake, Kontextpaketen und automatischer Quellenaufnahme ist unten
beschrieben; produktiver Nachweis und fachlicher Abschluss bleiben offen.

### Registrierte Mailversion als offener Eingang

`gmail-intake-binding` verbindet eine unabhängig zurückgelesene Registerversion
mit einem offenen Domain-Eingang. Die Kennung bindet Konto, Quelle, Nachrichten-ID,
Version und Inhaltshash; der Eingang enthält eine kompakte serverseitige Referenz
mit dem unveränderten Originalbeleg. Anlage und Referenz werden in derselben
CAS-Transaktion mit genau einer Domainrevision gespeichert. Innerhalb der
Transaktion findet kein externer Abruf statt. Eine währenddessen geänderte
Registerversion wird abgewiesen; Wiederholungen prüfen Original und Bindung erneut
und erhalten den Bearbeitungszustand eines bereits angelegten Eingangs.

Eine neue Mailversion erzeugt einen eigenen offenen Eingang. Frühere Eingänge
und Originalreferenzen bleiben erhalten. Der vorhandene Bestandsabgleich nimmt
den Eingang in den Tageslauf auf. C2 kennzeichnet solche externen Inhalte bis zur
vollständigen Originalauflösung ausdrücklich als `sourceMissing` mit
`external_read_required`; interne Speicherorte werden nicht an das Modell gegeben.
Normale Intake-Kommandos dürfen das serverseitige Referenzfeld nicht setzen.

Die anschliessende Auflösung und automatische Quellenaufnahme sind unten
beschrieben. Produktive Konfiguration und Nachweis fehlen weiterhin.
Ein kompakter Eingang ist kein gelesener Mailinhalt und kein Quellenabschluss.
T28 und die integrierte Abnahme bleiben offen.

### Vollständige gebundene Mailinhalte in der OpenAI-Verarbeitung

Die tatsächliche OpenAI-Komposition schliesst jetzt `gmail-context-hydrator` an
den vollständig autorisierten C2-Arbeitsbestand an. Der Leser prüft die aktuelle
Domainrevision, Intake-Identität, Mandant, Quellbindung und aktive Laufsektion.
Historische offene Versionen werden ausschliesslich über die bestätigte private
Registerkette erreicht. Ein neueres Original ohne eigenen gebundenen Eingang
stoppt die Auslieferung, damit ein älterer Eingang keine neue Nachrichtenversion
verdeckt. Ganze Originalbündel werden unabhängig zurückgelesen und vor/nach dem
Lesen gegen Änderungen abgesichert.

Der vollständige serialisierte Mailinhalt ersetzt den kompakten Referenztext.
Versionsangabe, Hash, Kennzeichnung als untrusted source sowie offene Anhangslücken
bleiben erhalten; interne Speicherorte werden nicht projiziert. Fehlende Inhalte
bleiben `sourceMissing`. Vor der Paketzerlegung prüft dieselbe Positivliste und
Geheimnissuche den gesamten Text. Die bisherige Schlüsselprüfung wurde um
Bindestriche und Unterstriche innerhalb langer `sk-`-Schlüssel erweitert, nachdem
eine Gegenprobe die bisherige Lücke nachgewiesen hatte.

Die unveränderlichen Kontextpakete und deren unabhängige Abschlussprüfung binden
nun den tatsächlichen vollständigen Mailinhalt ein. Direkte Tests und die echte
OpenAI-Komposition mit künstlichem Modelltransport prüfen vollständige Inhalte,
Unicode über mehrere Pakete, alte Versionen, fremde Identitäten, fehlende Originale,
konkurrierende Änderungen, Geheimnisse sowie den verweigerten Abschluss bei
ungelesenen Anhängen. Es erfolgt kein echter Provideraufruf in diesen Tests.

Der gesamte Kontext bleibt derzeit auf 16 MiB begrenzt und die historische
Versionssuche auf 1000 Vorgänger; Überschreitungen brechen ausdrücklich ab. Die
produktive Aktivierung von Quellenaufnahme und Bindung, grössere Bestände,
Anhangsauswertung und Laufzeitnachweise bleiben offen. Dies ist kein produktiver
T28-Nachweis und kein abgeschlossener Probebetrieb.

### Automatischer Quellenabgleich und Eingang vor dem Modell

`gmail-worker-preparation` ist jetzt in die tatsächliche OpenAI-Komposition
eingebunden. Eine ausdrücklich konfigurierte Pflichtquelle und ein festes
Mailkonto sind erforderlich; allgemeine Mailquellen benötigen eine explizite
Gmail-Zuordnung. Fehlende Credentials, mehrere Mailkonten oder widersprüchliche
Policy-Zuordnung bleiben unavailable. Vor jedem externen Abruf gelten weiterhin
die vorhandenen Betriebs-/Freigabetore. Der reine Core-Betrieb benötigt keine
Gmail-Zugangsdaten, sofern keine Mailquelle als Pflichtquelle deklariert ist.

Der Adapter führt dauerhaften Abgleich und aktuelle Originalbindung in Batches
von höchstens acht internen Checkpoint-Einheiten aus. Jeder zurückgegebene Batch
wird vom bestehenden Worker als Werkzeugschritt gezählt; 30 Schritte, 20 Minuten
und Abschnittsfristen werden nicht erweitert. Fehlende Bindungen werden anhand
des validierten dauerhaften Registers gefunden. Bereits angelegte Eingänge
behalten Zustand und Kennung. Nach abgeschlossener Aufnahme werden Quellenstatus
und Laufmarker in derselben CAS-Transaktion geschrieben und zurückgelesen. Vor
dem ersten Modellaufruf nimmt der nächste Bootstrap alle neuen Eingänge in den
Tageslauf auf. Quellenstatus `ok` bedeutet Aufnahme und Einbindung, keine fachliche
Erledigung; Quelllücken bleiben `partial` und erhalten ihre Belege.

Tests mit echtem Gmail-Leser, Originalspeicher, Register, Domain und tatsächlicher
OpenAI-Komposition belegen die automatische Kette bis zum Modelltransport. Weitere
Gegenproben prüfen leeres Postfach gegenüber Message-404, verlorene Bestätigung,
konkurrierende Nutzereingaben, manipulierte Bindungen/Quellenchecks und abgelaufene
Lease. Alle externen Antworten sind künstlich; produktive Credentials wurden nicht
eingerichtet. Die tatsächliche Laufzeit grosser Bestände, der Gesamtumfang von
Anhängen und der vollständige produktive Worker-/14-Tage-Nachweis bleiben offen.

### Antworten einmalig in offene Arbeit übernehmen

Die tatsächliche OpenAI-Komposition übernimmt neue Nutzerantworten vor dem
Quellenabruf und Modellschritt durch `answer-preparation`. Frage, Antwort und
ursprüngliche Quelle bleiben verknüpft. Ein lesbarer Eingang mit Frage,
Antwortoptionen und unverändertem Antworttext entsteht zusammen mit dem
Verbrauchsvermerk in derselben Domain-Revision. Nur der Backend-Systemakteur
darf diesen neuen Befehl ausführen. Bestehende Aktivierungs-, Lease- und
Abschnittsprüfungen gelten weiterhin.

CAS-Wiederholungen prüfen die unveränderten Originalereignisse. Unabhängiges
Zurücklesen bestätigt Eingang und Verbrauch; nach verlorener Bestätigung wird
kein zweiter Eingang angelegt. Jeder spätere Durchlauf kontrolliert die vorhandene
Verknüpfung erneut, ohne bereits bearbeitete Eingänge wieder zu öffnen. Fehlende
übernommene Arbeit verhindert stillen Fortschritt. Der nächste Bootstrap nimmt
neue Eingänge in den Tageslauf und den vollständigen Modellkontext auf.

Eine so übernommene Anweisung ist ausdrücklich kein Abschlussbeleg für den Lead:
Auch ein bereits verknüpfter Eingang und eine behauptete Erledigung genügen
nicht. Der ältere allgemeine `consumeAnswer`-Pfad wurde damit nicht ersetzt;
dessen bestehende Belegsemantik bleibt getrennt zu prüfen. Tests decken die
atomare Übernahme, Wiederholung, verlorene Bestätigung, parallele Nutzereingaben,
geänderte Originale, fehlenden Rücklesebeleg, Rollen und den tatsächlichen
Modellkontext ab. Externe Antworten sind künstlich. Produktiver T33-Nachweis,
fachliche Ausführung des Auftrags und Tagesfinalisierung bleiben offen.

### Backend-Abschluss nach vollständigem Modellkontext

Der `close23`-Pfad der tatsächlichen OpenAI-Komposition ruft jetzt
`daily-finalization` nach der unabhängigen Kontextprüfung auf. Deren Nachweis
bindet Originalrevision und die direkt folgende Checkpoint-Revision; ein
beliebiger späterer Stand oder eine parallele Nutzeränderung reicht nicht.
Nur der neue Systembefehl `closeRunAfterCoreRead` darf den gerade in derselben
CAS gelesenen Quantus-Kern prüfen. Externe Quellen behalten ihre echten
Adapter-Ergebnisse und Zeitpunkte. Anschliessend gelten unverändert alle
Domain-Bedingungen: Zeitfenster, Slotquittungen, vollständiger Bestand, frische
Quellen, gültige Belege und beide grünen Achsen.

Kernprüfung, finaler Zustand, Abschlussrevision, Finalnote und Laufmarker werden
atomar mit einer Domain-Revision gespeichert. Bei verweigertem Abschluss wird
auch keine vorläufige Kernprüfung geschrieben. Unabhängiges Zurücklesen bindet
die vollständige Note und den Domain-Bestand. Wiederholung nach verlorener
Bestätigung oder Fortsetzung mit neuem Fence kann ohne Modellaufruf denselben
Abschluss bestätigen. Dafür dürfen sich ausschliesslich Laufzeitdaten,
Idempotenzprotokoll und globale Revision geändert haben; geänderte fachliche
Originale verweigern diese Wiederholung. Die bestehenden unabhängigen
Worker-Abschlussbelege bleiben zusätzlich erforderlich.

Tests mit echtem CAS-Umschlag und tatsächlicher OpenAI-Komposition decken den
berechtigten Abschluss sowie offene Leads, fehlende externe Quellen, geänderte
Originale, Rollen, verlorene Bestätigung und echte Lease-Fortsetzung ab. Die
Modell- und Infrastrukturantworten sind künstlich. Tageswellen vor `close23`
erstellen weiterhin keine Finalnote; ihre Laufzeit-Disposition benötigt noch
eine explizite Lösung ohne unnötige Abschlusswiederholung. Produktiver T17-/T36-
Nachweis, spätere Invalidierung im tatsächlichen Worker und Probebetrieb sind
damit weiterhin nicht abgeschlossen.

### Tageswelle beenden, ohne den Tag abzuschliessen

Vor `close23` liefert die OpenAI-Komposition jetzt die ausdrückliche Disposition
`wave_processed`. Der echte HTTP-Worker prüft dafür innerhalb seiner Abschluss-
CAS den vollständigen gespeicherten Kontextnachweis erneut: Lauf, Policy-Version,
Checkpoint-Revision, Originalbestand, höchstens 60 Sekunden alte Prüfzeit und
aktueller Abschnitt samt Lease. Technische Laufzeitänderungen dürfen die globale
Revision erhöhen; jeder geänderte fachliche Inhalt verweigert den Nachweis.

Erst danach darf der Lauf mit dem eigenen Ergebnis `wave_processed` enden.
Dieser Zustand ist immer ohne Grün; Tagesphase, offene Leads, Nachfragen und
Follow-ups werden nicht geschlossen oder gelöscht. Offene Kosten und bestehende
Fortsetzungen verhindern auch diesen technischen Abschluss. Der gespeicherte
Lauf wird unabhängig zurückgelesen. Wiederholte Scheduler-Zustellung führt keine
zweite Arbeit aus. Ein `close23`-Lauf darf diesen Pfad nicht verwenden und bleibt
an den vollständigen Tagesabschluss gebunden. Andere Worker ohne die explizite
Disposition behalten den bisherigen unabhängigen Abschlussnachweis.

Tests sprechen den tatsächlichen HTTP-Dienst mit gültiger synthetischer Identität
an und nutzen den echten Idempotenz-/CAS-Umschlag. Sie prüfen offene Arbeit,
Wiederholung, technische Revisionen, fehlende/veraltete Nachweise, parallele
Nutzeränderungen, Abendmissbrauch und unaufgelöste Kosten. Die Kontextnachweise
dieser HTTP-Gegenproben sind künstlich; die Modell-Komposition wird zusätzlich
separat integriert geprüft. Produktive Gesamtkette, Ereignis-Fortsetzungen,
spätere Invalidierung und Probebetrieb bleiben offene Nachweise.

### Regelmässige Prüfung später widerlegter Abschlüsse

Der produktive Monitor-Einstieg bindet jetzt den erforderlichen Port
`closureReview` ein. Jeder authentifizierte Tick prüft vor seinem Laufplan die
gespeicherten finalen Tage gegen die vollständige Domain-Verpflichtungsmenge.
Die Policy stammt aus derselben ausdrücklich konfigurierten Quelle wie im
Worker. Fehlende Konfiguration, fehlende historische Abschlussbelege oder eine
nicht verfügbare historische Policy-Version bleiben Fehler. Der unabhängige
Watchdog darf diesen schreibenden Port nicht erhalten.

Ein echter Widerspruch wird mit dem bestehenden Domain-Befehl
`invalidateClosure` in einer CAS erneut geprüft und korrigiert. Die historische
Finalnote und Abschlussbelege bleiben erhalten. Eine verknüpfte Korrekturnotiz,
`exception_open`, ein überprüfbarer Marker und die Rücknahme des Laufzeit-Grüns
entstehen atomar mit einer Revision. Die aktive Leitungs-Lease wird nicht
übernommen oder verändert. Parallele Originaländerungen werden über CAS erneut
bewertet; ein zwischenzeitlich verschwundener Widerspruch wird nicht korrigiert.
Neue Eingänge nach dem Abschluss bleiben nächste Arbeit und widerlegen den alten
Abschluss nicht automatisch.

Jede Korrektur wird unabhängig zurückgelesen. Wiederholungen prüfen historische
Notiz, Korrektur, Abschlussbelege und Marker erneut; verlorene Bestätigung und
parallele Zustellung erzeugen keine doppelte Notiz oder doppelte Erfolgszählung.
Ein Tick bearbeitet höchstens acht Korrekturen und startet nach 20 Sekunden keine
weitere. Verbleibende Tage werden als `closurePending` ausgewiesen und bleiben
für den nächsten Tick erhalten. Dies ist kein harter I/O-Zeitnachweis.

Tests prüfen echte Domain-Abschlüsse, echten Idempotenz-/CAS-Umschlag und den
authentifizierten HTTP-Monitor. Abgedeckt sind mehrere Tage, neue Eingänge,
Parallelität, aufgehobene Widersprüche, fehlende Notizen/Marker, deaktivierte
Schreibwirkungen und Policy-Grenzen. Produktive Monitor-Konfiguration, Warnkanal,
Archivierung alter Korrekturbelege und der T18-/14-Tage-Nachweis bleiben offen.


## Bereitstellungsvertrag und Rollenidentitaet (2026-10-03)

Die Terraform-Definition verwendete veraltete Namen fuer Werkzeugzugang und Kostenpolicy; weitere von der v4-Laufzeit verlangte Einstellungen fehlten. Der gemeinsame Vertrag `infra/quantus-v3/runtime-env.json` versorgt jetzt die drei Rollen mit ihren konkreten oeffentlichen Variablen und getrennten Secret-Manager-Verweisen. Der Worker bekommt Modell-, Prompt-, Preis-, Policy-, C2- und Auftragstoken-Konfiguration, optional den vorhandenen Gmail-OAuth-Speicher; Monitor und Watchdog erhalten ausschliesslich ihre erforderlichen Geheimnisse. Der private Originalspeicher wird mit einheitlichen Bucket-Rechten, Public-Access-Prevention und einem auf Lesen/Anlegen beschraenkten Worker-Recht definiert.

Selbstreferenzen auf die erst zu erstellenden Dienstadressen sind entfernt. Deterministische Adressen und routenspezifische Cloud-Run-Custom-Audiences stimmen mit den Scheduler- und Fortsetzungszielen ueberein. Der Runtime-Konfigurator weist fremde/mangelhafte Dienstkonto-JSON und einen vorrangigen Benutzer-OAuth-Refresh zurueck, wenn die von Terraform gesetzte erwartete Rollenidentitaet vorliegt. Das beweist weder Schluesselgueltigkeit noch tatsaechlich vorhandene Cloud-Berechtigungen.

Pruefstand: Terraform 1.13.3, gesperrter Google-Provider 6.50.0; echte Terraform-Validierung und fuenf simulierte Infrastrukturtests (vollstaendige Rollen, fehlende Angaben, Gmail-Isolation, geteilte Geheimnisse). Zehn Node-Vertragstests initialisieren die wirklichen Runtime-/Auth-/Policy-/Leitungs-Ports mit derselben Zuordnung und pruefen Identitaetsfehler ohne Geheimnisausgabe. CI fuehrt diese Infrastrukturtests sowie die Runtime-/v4-Regressionssuite aus. Geheimnisse und Cloud-Ressourcen werden dabei nicht produktiv verwendet.

Weiter offen: konkrete produktive Werte und Secret-Versionen, C2-Gleichstand, Firebase-/IAM-Zugriff, erfolgreicher authentifizierter Aufruf durch die echte Cloud-Run-Schicht, Alarmkanal, alle Schreibclients, vollstaendige Quellen-/Spezialisten-/Archivierungsstrecken und echter 14-Tage-Probebetrieb. Kein Abnahmepunkt wird allein durch diese Offline-Konfiguration als produktiv bestanden markiert; alle Zeitplaene bleiben pausiert.


## Warnfehler trotz wieder laufendem Monitor nachverfolgen (2026-10-03)

Im Watchdog war ein frischer Heartbeat bisher ein bedingungsloser Erfolgspfad. Damit verschwanden fehlgeschlagene Warnzustellungen aus der weiteren Pruefung. Er wertet nun zusaetzlich offene Warnfehler aus. Ein separater Kanal-Belegabruf muss Warnkennung, Quittungskennung, Kanal und plausiblen Zustellzeitpunkt bestaetigen. Eine reine `delivered`-Behauptung aus `send` genuegt nicht. Zeit wird nach dem Kanalabruf frisch gelesen, damit echte Zustellungen nach Anfragebeginn nicht faelschlich abgewiesen werden.

`recordWarningDelivery` speichert den Beleg und bestaetigt atomar nur den vorher beobachteten Fehlerzaehler. Neuere parallele Fehler bleiben offen; bestehende Belege sind unveraenderlich und werden unabhaengig zurueckgelesen. Neue fehlgeschlagene Eskalationen erzeugen keine unendliche Kette weiterer Fehlerzaehler. Ein stabiler Warnschluessel wird an den verpflichtend idempotenten Kanaladapter gegeben. Dry-run und Schattenbetrieb versenden und quittieren nichts.

16 gezielte Tests pruefen den wirklichen authentifizierten HTTP-/CAS-Weg mit synthetischem Kanal: frischer Heartbeat mit Warnfehler, konkurrierender neuer Fehler, falsche/fehlende/verfruehte/zukuenftige Belege, verlorener Readback, zeitversetzte Zustellung, parallele Aufrufe, unveraenderlicher Replay und die Betriebsarten. Die bisherige Monitor-Suite wurde fuer den jetzt ausdruecklich erforderlichen Live-Testmodus und Belegabruf angepasst.

Kein produktiver T39-Abschluss: Kanalwahl ist angefragt; der Server hat weiterhin keinen produktiven Warnadapter. Dauerhafte Provider-Idempotenz, reale Zustellung, separater technischer Pruefpfad ausserhalb des Kernblobs und Warnung bei Ausfall dieses Speichers muessen noch umgesetzt und nachgewiesen werden. Der Belegvertrag allein ist kein Nachweis dieser Eigenschaften.

## Desktop: kanonische Server-Fragen beantworten (2026-10-03)

Das Tagesbriefing zeigt jetzt zusaetzlich die offenen Fragen aus `automation.questionsById`, ihre Antwortoptionen und den zugehoerigen Lead. Datierte, eindeutig adressierbare Fragen nutzen `briefing.answer` mit dem bestehenden Firebase-Nutzerausweis. Der Browser schreibt dafuer weder den Root-Blob noch lokale Abschluss-/Lead-Zustaende. Eine unveraenderliche Antwort wird zuerst kontogetrennt in IndexedDB gesichert. Ihr stabiler Nutzer-/Frage-Schluessel bleibt ueber Neuladen, parallele Tabs und verlorene Antworten erhalten. Ein anderer Antworttext kann die bereits gesicherte Absicht nicht ersetzen.

Die Anzeige unterscheidet lokalen Commit, ausstehende Uebertragung, Konflikt, notwendige Anmeldung und serverseitigen Beleg. Zur Bestaetigung muss der Beleg sowohl Frage als auch Antwort enthalten. Offene lokale Absichten bleiben auch sichtbar, wenn die Frage inzwischen auf einem anderen Geraet beantwortet wurde. Solange der Bereich offen ist, werden faellige Uebertragungen mit Rueckstaustufen erneut versucht; zusaetzlich gibt es einen Pruefknopf. Optionen fuellen die Antwort aus, versendet wird durch den ausdruecklichen Antwortknopf. Entwuerfe ueberstehen das Neuzeichnen der Ansicht innerhalb der Sitzung und sind nach Konto getrennt; erst das Senden sichert sie dauerhaft.

Der Integrationstest fuehrt den wirklichen Browser-Transport durch Firebase-Pruefung, C2, Domaenen-Adapter und CAS. Ein nach dem Commit verlorener Beleg wird mit unveraendertem Schluessel wiederholt, ohne zweite Antwort oder Revision. Weitere Tests pruefen Offline-Neuladen, Kontowechsel, abweichende zweite Antwort, Schreibsperre, unvollstaendige Belege und escaped UI-Inhalte. Die Authentifizierung und der Speicher dieser Tests sind synthetisch; dies ist kein produktiver End-to-End-Nachweis.

Noch offen: alte `pendingQuestion`-Eintraege eindeutig migrieren, weitere Desktop-Schreibaktionen sowie Tablet und Mobile auf die API umstellen, produktive Schreibfreigabe und Geraetenachweise. Fragen ohne Tageslauf bleiben sichtbar, werden aber nicht durch erfundene Zuordnungen versandfaehig gemacht. Keine API-only-Geraeteabnahme aus diesem einzelnen Antwortweg ableiten.

## Bestehende Lead-Fragen in die Server-Verarbeitung uebernehmen (2026-10-03)

Der OpenAI-Verarbeitungsweg uebernimmt jetzt vor Antwortverarbeitung und Provider-Aufrufen alte `pendingQuestion`-Eintraege aktiver Leads in die normalisierte Fragenkoordination. Ein systemexklusives Kernkommando verarbeitet hoechstens 32 Quellen je Schritt. Die Identitaet umfasst den vollstaendigen Originalinhalt einschliesslich unbekannter Felder; ein weiterer Zustandsbeleg bindet Schliessung, Loeschung und vorhandene Migrationsfragen. CAS prueft beides erneut. So kann eine alte Quittung nicht die spaetere Ruecknahme einer Frage ersetzen, deren Text gleich geblieben ist.

Die Original-Leads und Loeschmarkierungen bleiben unveraendert. Geschlossene historische Leads werden nicht reaktiviert. Wird eine uebernommene offene Frage geaendert, entfernt oder ihr Lead geschlossen, wird die bisherige Server-Frage zurueckgenommen. Ein neuer Nutzerantwort-Befehl prueft die weiterhin identische Quelle; ein veralteter Stand wird abgelehnt. Bereits bestaetigte Antworten bleiben historische Ereignisse und werden durch die Migration nicht erneut erzeugt.

Alte Antworttexte besitzen keinen separaten authentifizierten Antwortbeleg. Sie erscheinen deshalb als ausdruecklich zu pruefender Entwurf, nicht als bestaetigte Nutzerantwort und nicht als automatisch zu konsumierende Anweisung. Die vorhandene Quelle bleibt nachlesbar; erst eine neue, ausdrueckliche Bestaetigung erzeugt ein regulaeres Antwortereignis. Empfehlungen erscheinen im Fragenbereich. Nicht zuordenbare oder beschaedigte Altwerte werden als `legacy_questions_require_review` gemeldet; die Verarbeitung behauptet fuer sie keine erfolgreiche Migration.

Jede schreibende Uebernahme verlangt dieselben Aktivierungsriegel und die aktuelle Lease wie die weitere Laufzeit. Ergebnis und Frageinhalte werden separat zurueckgelesen; verlorene Quittungen, parallele Aufrufe und normale Benutzer-Aenderungen werden mit dem echten Integrations-/CAS-Weg getestet. Ein Test der tatsaechlichen OpenAI-Komposition zeigt die Migration vor dem ersten Provider-Aufruf und die Schreibsperre im Dry-run. Kein synthetischer Test gilt als produktiver Geraete- oder 14-Tage-Nachweis.

Weiter offen: die alten Desktop-Antwortaktionen vollstaendig auf den kanonischen Antwortweg umstellen und ihre lokale Warteschlange anbinden; nach Umstellung aller Clients die alten Fragefelder als Schreibquelle abloesen. Derzeit bewahrt die Migration sie fuer Kompatibilitaet und Herkunftspruefung. Auch weitere Desktop-, Tablet- und Mobile-Schreibaktionen sowie die produktive Migration/Freigabe bleiben offen.

## Bestehenden Desktop-Antwortknopf an dauerhafte Einzelbefehle anbinden (2026-10-03)

Auch `cgl-answer-question` sichert jetzt eine nach Konto und vollstaendigem Original gebundene Antwort in IndexedDB. Der Klick aendert weder den Lead-Zustand noch `pendingQuestion`, `answeredAt` oder den gemeinsamen Kern. Vor der Server-Migration bleibt der Originaltext mit seiner Antwort sichtbar erhalten. Erst eine exakt zugeordnete offene Server-Frage erlaubt den bestehenden `briefing.answer`-Befehl. Andere Antworten mit derselben Identitaet ueberschreiben die erste Absicht nicht; Konflikte bleiben sichtbar.

Lokale Sicherung und Serverbestaetigung werden getrennt gemeldet. Erst ein Beleg mit Frage und Antwort fuehrt zur bestaetigten Meldung und einem normalen Aktualisierungslauf. Wiederholte Klicks, mehrere Tabs, Kontowechsel, fehlende Zuordnung, zurueckgenommene Fragen und verlorene Antworten werden geprueft. Der Test des tatsaechlichen Desktop-Helfers haelt die Netzantwort an und prueft, dass vorher keine Serverbestaetigung erscheint. Die Tests ersetzen keine produktive Geraeteabnahme.

Weiter offen bleiben andere Desktop-Schreibaktionen, Tablet/Mobile, die Ablösung alter Fragefelder nach kompletter Client-Umstellung sowie die produktive Freigabe. Die lokale Warteschlange benoetigt fuer den Versand die angemeldete App und die freigegebene API; sie behauptet keinen Hintergrundversand bei geschlossener App. Alte und normalisierte Fragenbereiche bestehen waehrend dieser Umstellung nebeneinander.

## Gemeinsame Fragenanzeige statt doppelter Antwortfelder (2026-10-03)

Nach dem Laden des gemeinsamen Fragenbereichs gleicht der Desktop alte Cockpit-Fragen anhand des vollstaendigen Original-Fingerprints und der kanonischen Fragefelder ab. Erst wenn das zugehoerige Antwortfeld wirklich vorhanden ist, verschwindet die alte Eingabe; ihre Bereichszaehler werden korrigiert. Gleicher sichtbarer Text oder derselbe Lead genuegen nicht. Fehlende, ungueltige oder veraenderte Zuordnungen lassen die alte Frage sichtbar.

Ein ungesendeter Entwurf und der Fokus wechseln in das gemeinsame Feld. Ein anderer Entwurf oder eine schon gesicherte andere Antwort wird nicht ueberschrieben. Unterschiedliche Texte bleiben sichtbar zum Vergleichen. Entwuerfe werden getrennt je angemeldetem Konto und vollstaendigem Original in der Sitzung gehalten, auch bei erneutem Zeichnen der Ansicht; erst ausdrueckliches Senden sichert dauerhaft. Bei beantworteten oder zurueckgenommenen Fragen entfaellt der alte Sendeknopf; ein noch vorhandener Entwurf bleibt lesbar. Lokal gesicherte, noch nicht zugeordnete Antworten bleiben mit ihrem Uebertragungsstatus im gemeinsamen Bereich sichtbar.

Die Lead-Detailansicht verwendet fuer ihre Betriebsaktionen jetzt den kanonischen Zustand statt eines eventuell veralteten Abschlussfelds. Tests pruefen unbekannte Originalfelder, abweichende kanonische Inhalte, Kontowechsel waehrend des Hashens, Tippen waehrend des Abgleichs, fehlende Zielfelder, konkurrierende Entwuerfe und kanonisch geoeffnete/geschlossene Leads. Weitere Client-Schreibwege und die produktive Gesamtfreigabe bleiben offen.
