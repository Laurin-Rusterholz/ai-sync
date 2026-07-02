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
- Auth: **Anonymous Auth** (`firebase.auth().signInAnonymously()`), Regel-Gate `auth != null`

## Datenmodell (RTDB)

| Pfad | Inhalt |
|---|---|
| `driveFolders/<id>` | `{ name, bereich, parentId (null=Wurzel), typ ("bereich"\|"unterordner"\|"thema"), erstellt }` |
| `driveDocs/<id>` | `{ dateiname, titel_final, storagePath, downloadUrl, mimeType, groesse, hash (SHA-256), status, folderId (null bis Übernahme), vorschlag, textauszug (~2000 Zeichen), erstellt, aktualisiert }` |
| `driveInbox/<docId>` | `{ docId, dateiname, mimeType, text (~6000 Zeichen), hash, duplikat_verdacht, status ("pending"\|"processing"\|"processed"\|"error"), erstellt }` |

`vorschlag` (von n8n geschrieben):
`{ bereich, unterordner, thema, tags[], titel_vorschlag, confidence, begruendung, duplikat_verdacht }`

Status von `driveDocs`:
`eingang → wird_klassifiziert → klassifiziert | review_noetig → abgelegt` · `papierkorb` (kein Hard-Delete; endgültiges Löschen nur mit expliziter Bestätigung).
`review_noetig` gilt bei Parse-Fehler, `confidence < 0.6` **oder** hartem API-Fehler (dann zusätzlich Feld `fehler`).

Storage-Ablage: `drive/<docId>/<dateiname>`.

## Upload-Ablauf (clientseitig)

1. Storage-Upload → `downloadUrl`
2. Text extrahieren (PDF/DOCX/Textformate; Bilder ohne Text)
3. SHA-256 bilden und gegen bestehende `driveDocs`-Hashes prüfen → `duplikat_verdacht`
4. `driveDocs/<id>` mit Status `eingang` anlegen (inkl. `textauszug`, `hash`)
5. `driveInbox/<docId>` mit `text` + `hash` + Status `pending` schreiben

n8n lädt die Datei **nicht** erneut — der Text kommt aus dem Queue-Eintrag.

## Einrichtung

### 1. Firebase

1. **Anonymous Auth aktivieren:** Firebase-Konsole → Authentication →
   Sign-in method → „Anonym" aktivieren. Ohne diesen Schritt bleibt das
   Modul bei „Anmeldung fehlgeschlagen" stehen.
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
7. Papierkorb: „🗑 Papierkorb" im Drawer setzt nur den Status; unter
   **Papierkorb** lässt sich das Dokument wiederherstellen oder — nur nach
   expliziter Bestätigung — endgültig löschen (Storage + RTDB).

## Sicherheit

- Im Frontend liegt ausschliesslich die öffentliche Firebase-Web-Config
  (wie in `index.html`); Claude-API-Key und Service-Konto existieren nur
  als n8n-Credential-Platzhalter.
- Es werden keine Bestandsdaten gelöscht oder migriert; der Ordnerbaum wird
  nur initialisiert, falls `driveFolders` leer ist.
