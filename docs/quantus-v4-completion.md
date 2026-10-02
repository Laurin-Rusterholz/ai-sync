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
Werkzeugquittungen unveränderlich über den echten Core-Port samt CAS und
Idempotenz. Jede Mutation prüft die Lease erneut; bestätigte Schreibvorgänge
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

## Betriebsfreigabe

Keine neuen bezahlten Aufrufe ohne vorhandene genehmigte Kostenkonfiguration.
Keine zusätzliche parallele Leitung. Vorhandene Hauptläufe werden erst beim
geprüften Cutover ersetzt. Schutzregeln niemals zum Bestehen eines Tests lockern.
