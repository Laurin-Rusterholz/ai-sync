# Smarter — Modul-Dokumentation & Quantus Logbuch

Session-Tag: `smarter-2026-07-14-wkv4xt` · Branch: `claude/quantus-smarter-module-wkv4xt`

**Smarter** liefert taeglich automatisch aufbereiteten Lernstoff: hochgeladene
Quellen (HTML/PDF) werden verlustfrei in Units geschnitten, ein n8n-Schedule
generiert daraus jeden Morgen um 04:00 Theorie-HTML + Fragen + Flashcards + ein
PDF. Der App-Teil (dieses Repo) zeigt den Tagesstoff, die Upload-Funktion, die
Warteschlange und die Einstellungen. Der n8n-Teil wird von Claude im Browser
gebaut (siehe Handoff-Prompt am Ende).

Architektur: Single-File HTML (`public/index.html`), IIFE-JS, `data-action`
Event-Delegation, Design-System „Schiefer/Leinen" (bereits im Repo als
`:root`-Tokens vorhanden). Modul-Akzente: Koralle `#D96B5B`, Petrol `#2F8C80`,
Sand `#C9A96E`.

---

## 1 · Discovery (real ausgelesene Werte)

### Firebase
- Projekt-ID: `jupidu-36804`
- RTDB-URL: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`
  (Region `europe-west1`)
- `FIREBASE_CONFIG` (public, in `public/index.html` ~Zeile 5301):
  - apiKey `AIzaSyC6xVo-wmXC4JjG7qMQnOExIjU-UDvBluE`
  - authDomain `jupidu-36804.firebaseapp.com`
  - storageBucket `jupidu-36804.firebasestorage.app`
  - messagingSenderId `11390726952`
  - appId `1:11390726952:web:aba2f101b6c5ca2bc5561d`
- SDK: firebase-compat 10.8.0 (app, auth, storage, database)
- RTDB-Zugriff in-App: Helper `rtdbDbRef(path)` (~Zeile 6380) →
  `firebase.app().database(RTDB_DB_URL).ref(path)`.

### RTDB-Rules (`firebase/database.rules.json`)
- Explizit: `appStore`, `settings` (auth!=null); `driveInbox`,
  `communicator_inbox`, `quantus_task_inbox`, `nobraine` (offen).
- Wildcard `"$andere": { ".read": true, ".write": true }` — jeder nicht explizit
  gelistete Top-Level-Key ist **offen lesbar/schreibbar**.
- ⇒ `smarter/` faellt unter `$andere` ⇒ App und n8n schreiben ohne Credential
  (n8n via plain HTTP-Request auf `…/smarter/….json`).

### Flashcards-Schema (RecallLab — das bestehende Flashcards-System)
- localStorage-Key: `recalllab`. Container:
  `{ decks:[], cards:[], reviewLogs:[], user:{xp,level,streak,lastStudyDate}, settings:{newCardsPerDay,reviewCardsPerDay,showAgainCards} }`
- **Deck**: `{ id, name, description, createdAt, newCardsPerDay }`
- **Card** (exakte Feldnamen, verifiziert `public/index.html` ~37273 / ~61939):
  `{ id, deckId, front, back, reversible:true, cardType:'basic', createdAt:<ms>, tags?:[], srs }`
  - `front` = Vorderseite (Frage), `back` = Rueckseite (Antwort).
  - `srs` = `null` bei neuer Karte, sonst
    `{ ease:2.5, intervalDays, repetitions, nextReview:<ms>, phase:'new'|'learning'|'review'|'relearning', step, lapses }`.
  - **Faelligkeits-Feld = `srs.nextReview` (Unix-ms)** — es gibt KEIN Feld namens
    `dueDate`. „dueDate = morgen" ⇒ `srs.nextReview = morgen 00:00 (ms)`.
- Cloud-Sync: RecallLab wird NICHT einzeln, sondern eingebettet im Haupt-Blob
  synchronisiert: `buildRemoteAppPayload()` setzt `payload.recallLabData = rlData`
  (~6212). Haupt-Blob-Key = `app-data.json`. RTDB-Spiegel via
  `firebaseJsonPut('app-data.json', payload)` → Pfad `cloud-sync/app-data.json`
  (`getFirebaseShadowPath` = `'cloud-sync/'+key`, ~5811).
- **Merge beim Laden** (verifiziert ~10838): remote `recallLabData.cards` werden
  per **Karten-ID (Union)** in den lokalen Stand gemergt — neue Remote-Karten mit
  eigener ID bleiben erhalten. Decks: Union. ⇒ n8n kann Karten in
  `cloud-sync/app-data.json` → `.recallLabData.cards[]` **anhaengen** (read →
  push → `.meta.updatedAt` = now ISO → write); sie erscheinen beim naechsten
  App-Load in RecallLab.
- Standard-Decks existieren bereits: `deck_general` („📋 Allgemein"),
  `deck_en_de`, `deck_c1`. Smarter kann `deck_general` nutzen oder ein Deck
  `deck_smarter` anlegen.

### n8n
- Basis-Host (aus `public/index.html`, `public/nobraine.html`,
  `public/docstudio.html`): `https://n8n.srv1757990.hstgr.cloud`
  - Webhook-Basis: `https://n8n.srv1757990.hstgr.cloud/webhook/…`
  - REST-API-Basis (Standard n8n): `https://n8n.srv1757990.hstgr.cloud/api/v1/`
- Anthropic-Credential: Typ `httpHeaderAuth`, **Name „Anthropic API-Key (Header
  x-api-key)"**, Header `x-api-key`. Aufruf via `httpRequest`-Node (v4.2) →
  `https://api.anthropic.com/v1/messages`, Header `anthropic-version: 2023-06-01`.
  Genutzte Modelle in bestehenden Workflows: `claude-sonnet-4-6`,
  `claude-sonnet-5`.
  - Die interne n8n-Credential-**ID** steht NICHT im Repo (Exporte tragen
    `"id":"ERSETZEN-NACH-IMPORT"`). ⇒ In n8n per Credential-**Namen**
    wiederverwenden. → **OFFEN: numerische/hashige Credential-ID.**
- Gotenberg: kein direktes Node-Muster im Repo. Es existiert aber ein fertiger
  n8n-Webhook `POST https://n8n.srv1757990.hstgr.cloud/webhook/quantus-doc-pdf`
  mit Body `{ html, filename }` → Antwort = PDF-Blob (`application/pdf`, via
  Gotenberg gerendert) — genutzt von `public/docstudio.html` (~Zeile 331/353).
  ⇒ Smarter-Daily kann diesen Webhook wiederverwenden statt Gotenberg direkt
  aufzurufen. → **OFFEN: direkte Gotenberg-Endpoint-URL (`/forms/chromium/…`).**
- Node-/typeVersion-Vorlage (aus `n8n/*.json`, alle importfaehig):
  `n8n-nodes-base.webhook` v2, `…scheduleTrigger` v1.2, `…httpRequest` v4.2,
  `…code` v2, `…if` v2, `…respondToWebhook` v1.1, `…stickyNote` v1.
  Beste Gesamt-Vorlage: `n8n/polaris-webhooks.json` (Webhook + Code + httpRequest
  + respondToWebhook) und `n8n/nobraine-weekly-planner.workflow.json`
  (scheduleTrigger + Anthropic-httpRequest + RTDB-Multi-Path-Update).
- RTDB-Schreiben in bestehenden Workflows: entweder `googleApi`-Service-Konto
  („Google Service-Konto (RTDB)") ODER — bei offenen `$andere`-Pfaden wie
  `polaris/*`, `nobraine/*` — plain `httpRequest` ohne Credential. `smarter/*`
  ist offen ⇒ plain httpRequest genuegt.

### Umgebungs-Einschraenkung (dokumentiert)
- Die RTDB ist aus der Claude-Code-Umgebung **nicht** erreichbar (Egress-Policy:
  CONNECT → 403 fuer `…firebasedatabase.app`). ⇒ Das Seeden von `smarter/config`
  kann nicht per curl von hier erfolgen. Loesung: Die App **seedet
  `smarter/config` idempotent selbst** beim ersten Laden des Moduls im Browser
  des Nutzers (dort ist die RTDB erreichbar). Verifikation „zurueckgelesene
  config == geschrieben" erfolgt in-App (read-back nach write).

---

## 2 · OFFENE Werte (fuer den n8n-Handoff)
1. **Anthropic-Credential-ID (n8n-intern)** — im Repo nur als Platzhalter. In n8n
   per Credential-Namen „Anthropic API-Key (Header x-api-key)" wiederverwenden.
2. **Direkte Gotenberg-Endpoint-URL** — nicht im Repo. Alternative: bestehenden
   Webhook `…/webhook/quantus-doc-pdf` (`{html,filename}` → PDF) wiederverwenden.
3. **n8n-API-Key / X-N8N-API-KEY** — nicht im Repo (nur Host bekannt).

---

## 3 · Logbuch (chronologisch)
- 2026-07-14 · Discovery abgeschlossen (Firebase, Rules, RecallLab-Schema, n8n
  Host/Anthropic/Gotenberg/typeVersions). RTDB-Egress geblockt → Self-Seed-Ansatz
  gewaehlt. Werte oben festgehalten.
