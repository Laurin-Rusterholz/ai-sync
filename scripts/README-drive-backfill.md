# Drive-Backfill — Bestandsdateien in die Klassifizierungs-Queue holen

`scripts/drive-backfill.js` geht **einmalig** per Firebase Admin SDK durch alle
Storage-Ordner des Buckets `jupidu-36804.firebasestorage.app`
(`attachments/`, `belege/`, `buchhaltung-sp-ar/`, `cloud-sync/`, `drive/`,
`project-inbox/`, `task-files/`) und legt für jede echte Datei (PDF, DOCX,
Bilder — JSON-Sync-Dateien und andere Typen werden übersprungen) an:

- `driveDocs/<docId>` mit Status `eingang` (inkl. `textauszug`, `hash`,
  Download-URL im Firebase-Format)
- `driveInbox/<docId>` mit Status `pending` und extrahiertem Text
  (PDF via `pdf-parse`, DOCX via `mammoth`, ~6000 Zeichen)

Der laufende n8n-Workflow (`n8n/drive-klassifizierung.json`) greift die
Einträge dann automatisch auf — im Drive-Modul erscheinen die Dokumente
unter **Eingang / Neu** und wandern durch die normale Klassifizierung.

**Idempotent:** `docId = "bf_" + SHA-256(storagePath)` — Mehrfachläufe legen
nichts doppelt an. Zusätzlich werden alle `storagePath`s bestehender
`driveDocs` übersprungen (deckt auch die vom Drive-Modul selbst
hochgeladenen Dateien unter `drive/<pushKey>/…` ab). Der Inhalt-Hash wird
gegen bestehende Dokumente geprüft und setzt ggf. `duplikat_verdacht`.

## Voraussetzungen

1. **Service-Account-JSON** (Firebase-Konsole → Projekteinstellungen →
   Dienstkonten → „Neuen privaten Schlüssel generieren"). Das Konto braucht
   Zugriff auf RTDB + Storage (Standardrollen des Firebase-Admin-Dienstkontos
   genügen). **Die Datei niemals committen** — `service-account*.json` steht
   in `.gitignore`.
2. Abhängigkeiten lokal installieren (ohne `package.json` zu verändern):

   ```bash
   npm install --no-save firebase-admin pdf-parse mammoth
   ```

3. RTDB-Regeln spielen keine Rolle: Der Service-Account umgeht `auth != null`.

## Starten

```bash
# Variante A: Standard-Umgebungsvariable
GOOGLE_APPLICATION_CREDENTIALS=/pfad/zum/service-account.json \
  node scripts/drive-backfill.js --dry-run

# Variante B: eigene Variable
SERVICE_ACCOUNT_FILE=/pfad/zum/service-account.json node scripts/drive-backfill.js

# Variante C: Datei liegt als ./service-account.json im Repo-Root (gitignored)
node scripts/drive-backfill.js
```

**Empfohlener Ablauf:**

```bash
node scripts/drive-backfill.js --dry-run              # 1. Nur anschauen, was angelegt würde
node scripts/drive-backfill.js --limit 3              # 2. Mit 3 Dateien antesten, im Drive-Modul prüfen
node scripts/drive-backfill.js                        # 3. Vollständiger Lauf
node scripts/drive-backfill.js --prefix belege/       #    (optional: nur einen Ordner)
```

Das Skript loggt pro Datei `NEU` / `SKIP` / `DRY` / `FEHLER` und am Ende eine
Zusammenfassung. Exit-Code 0 = sauber durchgelaufen, 2 = mit Einzelfehlern
(diese Dateien beim nächsten Lauf erneut versucht — idempotent).

## Hinweise

- Dateien > 50 MB werden übersprungen (Log) — Limit im Skript anpassbar
  (`MAX_BYTES`).
- Für Dateien ohne vorhandenen Download-Token schreibt das Skript einen
  `firebaseStorageDownloadTokens`-Metadaten-Eintrag, damit die Download-URL
  dieselbe Form hat wie bei Uploads aus dem Web-SDK.
- Bilder bekommen keinen Text — n8n klassifiziert sie nur anhand des
  Dateinamens (typisch niedrigere Confidence → `review_noetig`).
