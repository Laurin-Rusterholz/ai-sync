# Quantus Drive — Ablage-Modul mit KI-Klassifizierung

Single-File-Modul **`public/drive.html`** (CSS+JS inline, kein Build) plus
n8n-Workflow **`n8n/drive-klassifizierung.json`**. Dateien werden in Firebase
Storage hochgeladen, der Text wird **clientseitig** extrahiert (gleiches
Muster wie der „ATTACHMENT TEXT EXTRACTION"-Block der Hauptapp: gevendortes
pdf.js UMD v3 mit `disableWorker`, mammoth.js für DOCX), und über eine
RTDB-Queue klassifiziert Claude die Dokumente in eine feste Taxonomie.

**Kein Webhook.** Die Kommunikation läuft wie bei `entityInbox`/`draftRequests`
ausschliesslich über die RTDB: Frontend schreibt `driveInbox` (status
`pending`), n8n konsumiert die Queue und schreibt Vorschlag + Status nach
`driveDocs` zurück; das Frontend zeigt Änderungen live per `on('value')`.

- Firebase-Projekt: `jupidu-36804` · Bucket: `jupidu-36804.firebasestorage.app`
- RTDB: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`
- SDK: Firebase **compat v10.8.0** (wie `index.html`), zusätzlich `firebase-auth-compat`
- Auth: **Google-Login** (`signInWithPopup` mit `GoogleAuthProvider`, Redirect-Fallback),
  Regel-Gate `auth != null`. Die Session wird pro Browser persistiert (einmal anmelden
  genügt) und gilt pro Origin — auch `index.html` ist damit angemeldet.

## Datenmodell (RTDB)

| Pfad | Inhalt |
|---|---|
| `driveFolders/<id>` | `{ name, bereich, parentId (null=Wurzel), typ ("bereich"\|"unterordner"\|"thema"), erstellt }` |
| `driveDocs/<id>` | `{ dateiname, titel_final, storagePath, downloadUrl, mimeType, groesse, hash (SHA-256), status, folderId (null bis Übernahme), vorschlag, textauszug (~2000 Zeichen), erstellt, aktualisiert }` |
| `driveInbox/<docId>` | `{ docId, dateiname, mimeType, text (~6000 Zeichen), hash, duplikat_verdacht, status ("pending"\|"processing"\|"processed"\|"error"), processing_seit (ISO, beim Wechsel auf `processing` gesetzt — Basis für Stale-Reclaim), fehler (bei `error`), verarbeitet (ISO, bei `processed`), erstellt }` |

`vorschlag` (von n8n geschrieben):
`{ bereich, unterordner, thema, tags[], titel_vorschlag, confidence, begruendung, duplikat_verdacht }`

Status von `driveDocs`:
`eingang → wird_klassifiziert → klassifiziert | review_noetig → abgelegt` · `papierkorb` (kein Hard-Delete; endgültiges Löschen nur mit expliziter Bestätigung).
`review_noetig` gilt bei Parse-Fehler, `confidence < 0.6` **oder** hartem API-Fehler (dann zusätzlich Feld `fehler`).

Storage-Ablage: `drive/<docId>/<dateiname>`.

## Upload-Ablauf (clientseitig)

1. Storage-Upload → `downloadUrl`
2. Text extrahieren (PDF/DOCX/Textformate; Bilder ohne Text). **OCR-Fallback:**
   liefert ein PDF < 20 Zeichen Text (gescannt/bildbasiert), werden die ersten
   5 Seiten via pdf.js gerendert und mit **Tesseract.js** (deu+eng, lazy per
   CDN — nur bei Bedarf geladen) gelesen; das Ergebnis wird mit `[OCR] `
   markiert. Fortschritt per `toast()`, Fehler werden nie geworfen.
3. SHA-256 bilden und gegen bestehende `driveDocs`-Hashes prüfen → `duplikat_verdacht`
4. `driveDocs/<id>` mit Status `eingang` anlegen (inkl. `textauszug` — max.
   12 000 Zeichen —, `hash`)
5. `driveInbox/<docId>` mit `text` (max. 6 000) + `hash` + Status `pending` schreiben

## Ablage & Auto-Ablage (Ordner-Zuordnung)

Das Ordner-Link-Feld auf `driveDocs` ist **`folderId`** — die Ordner-Ansicht
filtert darüber (inkl. Eltern-Kette). `vorschlagAblegen(docId, doc)` mappt den
KI-Vorschlag (`vorschlag.bereich`/`unterordner`/`thema`) auf echte
`driveFolders`-IDs: Namensvergleich **case-insensitive und Umlaut-tolerant**
(„Persönlich" ≡ „Persoenlich"); fehlende Ebenen werden als
`driveFolders`-Eintrag (`name`, `bereich`, `parentId`, `typ`) angelegt;
unbekannte Bereiche fallen auf „Eingang" zurück. Gesetzt werden `folderId`,
`bereich` (Wurzel-Ordnername), `titel_final` (= `titel_vorschlag`) und
Status `abgelegt`.

- **„Übernehmen"** im Drawer nutzt genau diesen Pfad — das Dokument erscheint
  sofort im richtigen Ordner.
- **Auto-Ablage:** Dokumente mit `vorschlag.confidence ≥ 0.85` werden nach der
  Klassifizierung automatisch abgelegt (läuft über die RTDB-Listener beim
  Öffnen des Drives). Darunter bleibt es bei manueller Bestätigung;
  `review_noetig` ist immer manuell.
- „🔄 Eingang neu einreihen" umfasst zusätzlich `review_noetig`-Dokumente
  ohne Textauszug (gescannte PDFs): OCR liefert Text, n8n klassifiziert neu.

n8n lädt die Datei **nicht** erneut — der Text kommt aus dem Queue-Eintrag.

## Dokumente öffnen (typabhängig)

Ein Klick auf die Zeile **öffnet** das Dokument (Details/Ablage weiterhin über
den ℹ️-Knopf der Zeile):

| Typ | Verhalten |
|---|---|
| PDF | Öffnet automatisch den vollwertigen **PDF-Editor** der Hauptapp. Eingebettet (Drive-App in `index.html`): `postMessage` `quantus-open-pdf` an den Parent (Origin-geprüft). Standalone: Deep-Link `index.html?openpdf=<URL>&pdfname=<Name>&pdfpath=<StoragePath>` in neuem Tab. „Speichern" im Editor schreibt über den `storagePath` in dieselbe Drive-Datei zurück; `_syncDriveDocAfterSave` (Hauptapp) führt danach `driveDocs.downloadUrl`/`groesse` nach, weil beim Überschreiben eine neue Token-URL entsteht. |
| Bild (jpg/png/gif/webp/svg/heic/…) | Lightbox-Overlay mit Download-Knopf. |
| Word `.docx` | Word-Ansicht: mammoth.js rendert das Dokument als HTML („Papier"-Ansicht). Schlägt das fehl (z. B. Adblocker), wird stattdessen heruntergeladen. |
| Word alt `.doc`/`.odt` | Download (Browser kann sie nicht rendern). |
| Textformate (txt/md/csv/json/…) | Text-Ansicht im Overlay. |
| Sonstige (xlsx, zip, …) | Drawer mit Metadaten/Download wie bisher. |

Im Drawer gibt es zusätzlich „📝 Im PDF-Editor öffnen" (PDF) bzw. „📖 Öffnen"
(Bild/Word/Text); `Esc` schliesst das Viewer-Overlay.

## Drive-Anbindung der Hauptapp (Anhänge)

In **allen** Entity-Anhang-Bereichen der Hauptapp (Projekte, Aufgaben,
Notizen, Meetings, … — überall, wo `renderFileAttachments` rendert) gibt es
den Knopf **„🗄️ Aus Drive"**. Er öffnet einen Picker mit:

- **Suche** über Name, Titel, Tags, Bereich/Thema (KI-Vorschlag) und
  Textauszug; Auswahl hängt das Dokument als **Referenz** an `entity.files[]`
  an (gleiche Storage-Datei, kein Re-Upload; Felder `fromDrive:true`,
  `driveDocId`). Bereits angehängte Dokumente sind markiert. Beim Entfernen
  eines solchen Anhangs wird **nur die Referenz** gelöscht — die Datei bleibt
  im Drive und im Storage erhalten (Guard im `delete-file`-Handler).
- **Upload-Zone**: neue Dateien landen unter `drive/<docId>/<Dateiname>`,
  bekommen einen `driveDocs`-Eintrag (Status `eingang`) plus
  `driveInbox`-Queue-Eintrag (`pending`) — gleiche Klassifizierungs-Pipeline
  wie der Upload im Drive — und werden sofort an die Entität angehängt.

Zusätzlich gibt es den globalen **📤 Quick-Upload** (Topbar-Knopf und
Befehls-Palette Ctrl/Cmd+K): gleicher Ablauf, ohne Anhängen an eine Entität.

## Nach-Einreihen bestehender Eingang-Dokumente

Sidebar-Knopf **„🔄 Eingang neu einreihen"** (`data-action="drive-rescan"`,
nur eingeloggt sichtbar): reiht alle `driveDocs` mit Status `eingang`, die
nicht bereits als `pending`/`processing` in der Queue stehen, erneut zur
KI-Klassifizierung ein. Kern ist `driveEnqueueForClassification(docId, doc)`
(auch als `window.driveEnqueueForClassification` exportiert): lädt die Datei
(`downloadUrl`, sonst via `storagePath`), extrahiert den Text frisch, ergänzt
fehlende Hashes, aktualisiert `driveDocs` (`textauszug`/`hash`) und schreibt
`driveInbox/<docId>` mit Status `pending` im Upload-Schema:

```json
{
  "docId": "<driveDocs-Schlüssel>",
  "dateiname": "Beispiel.pdf",
  "mimeType": "application/pdf",
  "text": "<frischer Textauszug, max. 6000 Zeichen>",
  "hash": "<sha256 hex>",
  "storagePath": "drive/<docId>/Beispiel.pdf",
  "duplikat_verdacht": false,
  "status": "pending",
  "erstellt": "2026-07-07T12:00:00.000Z"
}
```

Der n8n-Poll („Pending filtern") liest daraus `docId`, `dateiname`,
`mimeType`, `hash`, `duplikat_verdacht` und `text` — das Schema ist mit dem
Upload-Pfad identisch. Der Storage-**Backfill** („🧺 Bestehende Dateien
scannen") bleibt für Dateien zuständig, die noch gar keinen (vollständigen)
`driveDocs`-Eintrag haben.

## Einrichtung

### 1. Firebase

1. **Google-Provider aktivieren:** Firebase-Konsole → Authentication →
   Sign-in method → „Google" aktivieren (Anonymous wird NICHT benötigt).
   Unter Authentication → Settings → „Autorisierte Domains" muss die
   Deploy-Domain stehen (z. B. `management-xo2-pro.netlify.app`;
   `localhost` ist standardmässig erlaubt), sonst schlägt das Popup fehl.
2. **RTDB-Regeln ergänzen:** Block aus `firebase/database.rules.json`
   übernehmen. Nur `driveFolders`/`driveDocs`/`driveInbox` werden mit
   `auth != null` gegated; der `$andere`-Wildcard repliziert das bisherige
   offene Verhalten aller Bestandspfade. **Achtung:** kein `.read`/`.write`
   direkt auf Wurzelebene stehen lassen — eine Erlaubnis am Elternknoten
   vererbt sich in der RTDB nach unten und würde das Gate aushebeln.

### 2. n8n

1. `n8n/drive-klassifizierung.json` importieren.
2. Credentials zuweisen (im Export nur Platzhalter, keine Secrets):
   - **Google Service-Konto (RTDB):** Google-API-Credential (Service
     Account) mit den Scopes `https://www.googleapis.com/auth/userinfo.email`
     und `https://www.googleapis.com/auth/firebase.database` — wird von allen
     RTDB-HTTP-Nodes genutzt (Service-Konto umgeht die `auth != null`-Regeln).
   - **Anthropic API-Key:** Header-Auth-Credential, Header-Name `x-api-key`,
     Wert = Claude-API-Key. Modell: `claude-sonnet-4-6`.
3. Workflow aktivieren.

**Trigger-Umsetzung:** n8n-Core bietet keinen push-basierten RTDB-Trigger-Node.
Der Workflow pollt daher alle 60 s `driveInbox` auf `status == "pending"`
(kein Webhook). Verarbeitete Einträge bleiben mit Status stehen (Muster
`entityInbox`), der Poll ist dadurch idempotent. Für `driveInbox` ist
`.indexOn: ["status"]` in den Regeln hinterlegt, falls der Poll später auf
eine gefilterte REST-Query (`orderBy="status"&equalTo="pending"`) umgestellt
werden soll.

**Stale-Reclaim (hängende `processing`-Einträge):** Der In-Progress-Status
wird gesetzt, *bevor* die Klassifizierung abgeschlossen ist. Bricht ein
Downstream-Node hart ab (n8n-Neustart, Netzwerkfehler eines RTDB-PATCH,
Timeout), bliebe der Eintrag ohne Sicherung für immer auf `processing` und
würde vom reinen `pending`-Filter nie wieder aufgegriffen. Daher:
- Beim Wechsel auf `processing` schreibt der Node **Inbox → processing**
  zusätzlich `processing_seit` (ISO-Zeitstempel).
- Der Node **Pending filtern** greift neben `pending` auch `processing`-
  Einträge wieder auf, deren `processing_seit` älter als **10 Min** ist
  (Timeout) **oder** die kein `processing_seit` haben (Altdaten → gelten als
  stale). Der Reclaim re-stempelt `processing_seit` auf „jetzt", sodass ein
  erneut scheiternder Lauf wieder 10 Min Karenz erhält.
- Harte API-/HTTP-Fehler setzen `driveInbox.status = "error"` **plus**
  `fehler` (inkl. HTTP-Status, soweit verfügbar). `error` wird vom Filter
  **nicht** erneut aufgegriffen — fehlerhafte Einträge laufen nicht in eine
  Endlosschleife, der Grund bleibt aber im Drawer sichtbar. Nichts wird je
  gelöscht (nur Status-Wechsel).

## Testanleitung: eingang → wird_klassifiziert → Vorschlag → Übernehmen

1. `public/drive.html` öffnen (lokal via `npx serve public` oder über das
   Netlify-Deployment). Unten links muss „Verbunden (anonym)" mit grünem
   Punkt stehen. Beim allerersten Start wird der Ordnerbaum einmalig aus der
   Taxonomie initialisiert (8 Bereiche; nur falls `driveFolders` leer ist).
2. Ein Test-PDF per Button oder Drag&Drop hochladen (Mehrfach-Upload geht).
   Die Fortschrittskarte zeigt „Lädt hoch … → Extrahiere Text …"; danach
   erscheint das Dokument in **Eingang / Neu** mit grauem Badge **Eingang**.
   Kontrolle in der RTDB: `driveDocs/<id>.status == "eingang"`,
   `driveInbox/<id>.status == "pending"` inkl. `text`.
3. Spätestens nach dem nächsten n8n-Poll (≤ 60 s) wechselt das Badge live
   auf **Wird klassifiziert** (teal, pulsierend) — n8n hat den Eintrag auf
   `processing` gezogen.
4. Nach der Claude-Antwort wechselt das Badge auf **Klassifiziert** (grün)
   bzw. **Review nötig** (coral, bei `confidence < 0.6`, Parse- oder
   API-Fehler). Dokument anklicken: Der Drawer zeigt den KI-Vorschlag
   (Bereich › Unterordner › Thema, Tags, Titelvorschlag, Confidence-Balken,
   Begründung) sowie ggf. Duplikat-Hinweis und Fehlertext.
5. **Übernehmen** klicken: Das Dokument erhält `folderId` (fehlende Ordner-
   ebenen werden angelegt), den Titelvorschlag als `titel_final` und Status
   **Abgelegt** — es liegt jetzt im Zielordner des Baums. Alternativ
   **Ändern …** für manuelle Zielwahl/Umbenennung.
6. Gegenprobe Fehlerpfad: n8n-Credential kurz entfernen und erneut hochladen
   → Badge **Review nötig** + Fehlertext im Drawer, `driveInbox`-Status
   `error`. Nichts wird stumm verworfen.
7. Gegenprobe Stale-Reclaim: einen `driveInbox`-Eintrag manuell auf
   `status: "processing"` mit `processing_seit` > 10 Min in der Vergangenheit
   (oder ganz ohne `processing_seit`) setzen. Beim nächsten Poll (≤ 60 s) greift
   **Pending filtern** ihn erneut auf und führt ihn zu `processed`/`error` —
   kein dauerhaftes Hängenbleiben mehr. Ein `processing`-Eintrag jünger als
   10 Min wird dagegen in Ruhe gelassen (kein Doppelanlauf).
8. Papierkorb: „🗑 Papierkorb" im Drawer setzt nur den Status; unter
   **Papierkorb** lässt sich das Dokument wiederherstellen oder — nur nach
   expliziter Bestätigung — endgültig löschen (Storage + RTDB).

## Sicherheit

- Im Frontend liegt ausschliesslich die öffentliche Firebase-Web-Config
  (wie in `index.html`); Claude-API-Key und Service-Konto existieren nur
  als n8n-Credential-Platzhalter.
- Es werden keine Bestandsdaten gelöscht oder migriert; der Ordnerbaum wird
  nur initialisiert, falls `driveFolders` leer ist.
