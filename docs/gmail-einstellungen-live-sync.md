# Gmail-Steuerung, Massenmail, Verbindungs-Check und Live-Sync

## Automatische Rückantwort (Abwesenheitsnotiz)

Einstellungen → Tab **📧 Gmail**. Die Abwesenheitsnotiz des verbundenen
Gmail-Kontos laesst sich dort direkt lesen und speichern — ohne die Gmail-App:

- Ein/Aus, Betreff, Nachricht
- optional erster/letzter Tag (der letzte Tag zaehlt bis Tagesende)
- optional „nur an Personen in meinen Kontakten“

Technik: `gmail-api` proxied neu auch `GET/PUT /users/me/settings/vacation`.
Der noetige OAuth-Scope `gmail.settings.basic` ist bereits Teil der bestehenden
Google-Verbindung; aeltere Verbindungen brauchen einmalig ein erneutes
„Mit Google verbinden“.

## Massenmail (Serienmail)

Einstellungen → Tab **📧 Gmail** → „Massenmail verfassen“:

- Empfaenger aus den Quantus-Kontakten (Personen mit E-Mail, Organisationen)
  per Checkbox, plus manuell eingetragene Adressen
- Platzhalter `{name}` wird pro Empfaenger ersetzt
- Jede Mail geht einzeln ueber das eigene Gmail-Konto raus, mit 1,2 s Pause;
  bei Quota-Fehlern stoppt der Versand automatisch, „Stoppen“ jederzeit moeglich
- Ergebnis-Zusammenfassung inkl. fehlgeschlagener Adressen

Gmail-Tageslimits gelten unveraendert — die Funktion ist fuer Serienmails an
eigene Kontakte gedacht (Einladungen, Rundschreiben), nicht fuer Spam.

## Verbindungs-Check

Einstellungen → Tab **💾 Speicher** → Karte „🔌 Verbindungen & Live-Sync“:

- Ein Klick prueft Netlify Blob (inkl. gespeicherter Groesse via `meta=1`),
  Firebase RTDB (inkl. Datenstand-Zeitpunkt), Google-Verbindung und den
  Live-Sync-Kanal — jeweils mit Antwortzeit
- „Pausierte Verbindungen reaktivieren“ hebt Fehler-Backoffs sofort auf
- Bei Netz-Rueckkehr (`online`-Event) werden Backoffs automatisch geloescht
  und sofort abgeglichen

## Live-Sync (an zwei Geraeten parallel arbeiten)

Ein Firebase-RTDB-Listener lauscht auf den zentralen Datenknoten
(`appStore/app-data_json`) — denselben, den Desktop und Tablet beschreiben.
Speichert ein anderes Geraet, uebernimmt `syncFreshness('live_update')` den
neuen Stand sofort ueber den bewaehrten Merge-Pfad (inklusive
Konflikt-Snapshot und Schutz ungespeicherter lokaler Aenderungen). Eigene
Schreibvorgaenge werden am `savedBy`-Geraete-Kennzeichen erkannt und ignoriert.

- Sichtbar am Sync-Chip: Suffix „· Live“, solange der Kanal steht
- Schalter in den Einstellungen („⚡ Live-Synchronisation“), Standard: an
- Faellt der Kanal aus, laeuft der bisherige 30-Sekunden-Abgleich unveraendert
  weiter; der Listener verbindet sich nach 60 s automatisch neu
