# Backup und Wiederherstellung des Quantus-Datenstands

Der zentrale Datenstand (`app-data.json`) liegt in Firebase RTDB unter
`appStore/app-data_json`. Die kompatiblen Netlify-Functions `blob-get` /
`blob-put` lesen und schreiben intern ausschliesslich Firebase. Mit dem
CLI `scripts/backup-blob.mjs` laesst er sich jederzeit als Datei sichern und
kontrolliert wiederherstellen.

## Backup erstellen

```bash
npm run backup
# oder mit Optionen:
node scripts/backup-blob.mjs --base https://management-xo2-pro.netlify.app --key app-data.json --out backups
```

Das Backup landet als `backups/app-data.json.<zeitstempel>.backup.json` und
enthaelt neben den Daten auch das Server-ETag und Metadaten (Quelle, Zeitpunkt,
Groesse).

## Wiederherstellen

```bash
npm run restore -- backups/app-data.json.2026-07-27T09-30-15.backup.json
```

Ohne `--force` schickt der Restore das im Backup gespeicherte ETag als
`If-Match` mit: Wurde der Server-Stand seit dem Backup veraendert, bricht der
Restore mit einem ETag-Konflikt (HTTP 412) ab, statt neuere Daten zu
ueberschreiben. Wer den aktuellen Server-Stand bewusst ersetzen will:

```bash
node scripts/backup-blob.mjs --restore backups/<datei>.json --force
```

## Zugriffsschutz

Ist auf der Netlify-Seite die Umgebungsvariable `SYNC_AUTH_TOKEN` gesetzt,
muss dasselbe Token beim CLI als Umgebungsvariable vorhanden sein — es wird
als `Authorization: Bearer …` mitgeschickt:

```bash
SYNC_AUTH_TOKEN=xxx npm run backup
```

## Leichte Status-Checks

`blob-get` unterstuetzt zwei sparsame Abfragearten:

- `?meta=1` liefert nur `{ key, etag, size }` statt des kompletten Datenstands.
- Der Header `If-None-Match: <etag>` liefert `304 Not Modified` ohne
  Datenkoerper, wenn sich seit dem letzten Abruf nichts geaendert hat.

Beide sparen beim regelmaessigen Polling (Tablet, journal-mobile) Datenvolumen
und Akku.

Die Functions benötigen für Firebase Admin entweder
`FIREBASE_SERVICE_ACCOUNT_JSON` oder `FIREBASE_CLIENT_EMAIL` plus
`FIREBASE_PRIVATE_KEY`. Secrets gehören nur in die Netlify-Umgebung, nie ins
Repository.

## Selbsttest

```bash
npm run test:backup
```
