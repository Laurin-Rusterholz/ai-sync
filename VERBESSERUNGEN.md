# 100 Verbesserungen fuer Produktivitaet und Speicherung

Teil 3 von 3: **ai-sync** — Verbesserungen 81–100.
(1–50 in `quantus-tablet-version`, 51–80 in `journal-mobile`.)

## Sync-Backend (netlify/functions)

81. `blob-get` beantwortet `If-None-Match` mit **304 Not Modified** ohne Datenkoerper — das minutliche Polling der Clients kostet praktisch kein Datenvolumen mehr.
82. Neuer Meta-Modus `blob-get?meta=1`: liefert nur ETag und Groesse statt des kompletten Datenstands — ideal fuer leichte Status-Checks.
83. `Cache-Control: no-store` auf allen Sync-Antworten — kein Zwischenspeicher kann mehr veraltete Datenstaende ausliefern.
84. CORS der Sync-Funktionen erlaubt jetzt `If-None-Match` — Voraussetzung fuer die bedingten Abrufe von journal-mobile und Tablet.
85. `blob-put` mit Groessenlimit (20 MB) und sauberem **413**-Fehler — schuetzt den Blob-Store vor versehentlich riesigen Uploads.
86. `blob-put` beantwortet falsche Methoden mit 405 **plus `Allow`-Header** (korrektes HTTP-Verhalten).
87. `blob-put`: die ETag-Nachlese ist jetzt fehlertolerant — ein erfolgreiches Speichern schlaegt nicht mehr mit 500 fehl, nur weil die ETag-Abfrage danach scheitert; die Antwort enthaelt zudem die gespeicherte Groesse.
88. `netlify.toml`: globale CORS-Header um `If-None-Match` ergaenzt (konsistent zu den Funktionen).
89. `netlify.toml`: Icons und Embleme (`favicon.svg`, `emblem.svg`, `apple-touch-icon.svg`) werden einen Tag im Browser gecacht — weniger Requests bei jedem App-Start.

## Download-Proxy (netlify/functions/download-proxy.mjs)

90. SSRF-Haertung: nur noch `http(s)`-Ziele, lokale und interne Adressen (localhost, 10.x, 192.168.x, 172.16–31.x, 169.254.x, `.internal`, IPv6-Loopback/Link-Local) werden abgelehnt.
91. `Content-Length` wird durchgereicht — der Browser zeigt beim Herunterladen einen echten Fortschrittsbalken.
92. 25-Sekunden-Timeout mit korrektem **504** statt endlosem Haengen an einem toten Ziel.

## Backup und Wiederherstellung (scripts/backup-blob.mjs)

93. Neues Backup-CLI: laedt den kompletten Datenstand und sichert ihn mit Zeitstempel als Datei (`npm run backup`).
94. Restore-Modus mit **If-Match-Schutz**: wurde der Server-Stand seit dem Backup veraendert, bricht der Restore mit ETag-Konflikt ab, statt neuere Daten zu ueberschreiben.
95. `--force` fuer bewusstes Ueberschreiben, wenn der alte Stand wirklich zurueck soll.
96. `SYNC_AUTH_TOKEN`-Unterstuetzung: das CLI schickt das Token automatisch als Bearer-Header mit.
97. Neue npm-Skripte `backup`, `restore` und `test:backup` in `package.json`.
98. Backup-Dateien sind selbstbeschreibend: Quelle, Schluessel, ETag, Zeitpunkt und Groesse stecken als Metadaten in der Datei.
99. Selbsttest `scripts/backup-blob.test.mjs` fuer Argument-Parsing und sichere Dateinamen.
100. Neue Anleitung `docs/backup-wiederherstellung.md` — Backup, Restore, Zugriffsschutz und die sparsamen Status-Checks dokumentiert.
