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
- 2026-07-14 · App-Modul gebaut: Nav-Eintrag + Route `smarter`, vier Views
  (Heute/Upload/Warteschlange/Einstellungen), Single-File/IIFE, data-action.
  config wird idempotent selbst geseedet & read-back-verifiziert. Smoketest
  (headless Chromium): 0 uncaught JS-Errors, alle vier Views schalten um, Upload
  feuert gegen leere ingestWebhookUrl ohne Fehler. Zwei Commits.
- 2026-07-14 · Adversarialer Code-Review (4 Lenses, verifiziert): 6 bestaetigte
  Findings behoben — Offline-Erststart-Skeleton (high), Warteschlange-Reorder bei
  doppelten order-Werten (med), Reveal-Reset bei Hintergrund-Reload (med),
  Datumsschluessel nutzt jetzt config.timezone (med), config-Read-back prueft alle
  5 Keys (low), Offline-loadedAt (low). 1 Finding (null in questions[]) als
  REFUTED verworfen (RTDB speichert keine null-Array-Elemente). Re-Smoketest
  12/12 inkl. passivem Offline-Erststart; Reorder per Unit-Test gegen
  doppelte/fehlende order. Branch gepusht.
- 2026-07-14 · Deploy: Branch `claude/quantus-smarter-module-wkv4xt` gepusht
  (Netlify baut daraus die Branch-Preview). Produktions-Deploy = Merge nach
  `main` — bewusst dem Nutzer ueberlassen (kein eigenmaechtiger Merge/PR).

---

## 4 · Handoff-Prompt für Claude im Browser (n8n)
Der folgende Prompt ist mit allen real entdeckten Werten ausgefuellt (keine
Platzhalter ausser den drei OFFENEN Punkten, die nachweislich nicht im Repo
stehen und in n8n selbst zu holen sind).

--- PROMPT FÜR CLAUDE IM BROWSER (n8n) ---
Rolle: Du baust den kompletten n8n-Teil des Quantus-Moduls „Smarter". Der App-Teil ist fertig, getestet und deployed (Single-File `public/index.html`, Modul-Route `#/smarter`, vier Views). Halte dich EXAKT an die unten gelieferten realen Werte. Nicht nachfragen, sinnvolle Defaults waehlen und notieren, nie „geht nicht" ohne Alternative. Sehr haeufig ins Quantus Logbuch loggen, eigener Session-Tag.

## Umgebung (real ausgelesen)
- n8n-Host: `https://n8n.srv1757990.hstgr.cloud`
  - REST-API-Basis: `https://n8n.srv1757990.hstgr.cloud/api/v1/` (Header `X-N8N-API-KEY: <n8n-API-Key>` — OFFEN, im UI unter Settings → n8n API erzeugen/holen)
  - Webhook-Basis (Production): `https://n8n.srv1757990.hstgr.cloud/webhook/<pfad>`
- Anthropic-Credential: WIEDERVERWENDEN, keine neue anlegen. Typ `httpHeaderAuth`, Name exakt „Anthropic API-Key (Header x-api-key)", Header-Name `x-api-key`. Interne Credential-ID = OFFEN (steht nicht im Repo) → in n8n per diesem Namen auswaehlen. Aufruf: `n8n-nodes-base.httpRequest` v4.2 → `POST https://api.anthropic.com/v1/messages`, zusaetzlicher Header `anthropic-version: 2023-06-01`, Body `{ model, max_tokens, system, messages:[{role:'user',content}] }`. Modell: `claude-sonnet-5` (auf dieser Instanz bereits produktiv genutzt; alternativ `claude-sonnet-4-6`).
- Gotenberg-Aufrufmuster: Es existiert bereits ein fertiger n8n→Gotenberg-Webhook — WIEDERVERWENDEN:
  `POST https://n8n.srv1757990.hstgr.cloud/webhook/quantus-doc-pdf`, Body `{ html, filename }`, Antwort = PDF-Blob (`application/pdf`). Das PDF danach nach Firebase Storage (Bucket `jupidu-36804.firebasestorage.app`) hochladen und die Download-URL als `pdfUrl` speichern. Direkte Gotenberg-Endpoint-URL (`/forms/chromium/convert/html`) = OFFEN → falls du direkt rendern willst, oeffne den Workflow hinter `quantus-doc-pdf` und kopiere dessen Gotenberg-Node.
- Workflow-Node-Vorlage (Typen + typeVersions, alle im Repo unter `n8n/`):
  `n8n-nodes-base.webhook` v2, `n8n-nodes-base.scheduleTrigger` v1.2, `n8n-nodes-base.httpRequest` v4.2, `n8n-nodes-base.code` v2, `n8n-nodes-base.if` v2, `n8n-nodes-base.respondToWebhook` v1.1, `n8n-nodes-base.stickyNote` v1.
  Beste Vorlagen: `n8n/nobraine-weekly-planner.workflow.json` (scheduleTrigger + Anthropic-httpRequest + RTDB-Multi-Path-Update via PATCH) und `n8n/polaris-webhooks.json` (webhook + code + httpRequest + respondToWebhook).
- Firebase RTDB `jupidu-36804`, REST-Basis: `https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app`. `smarter/*` faellt unter die offene Regel `$andere` (`.read/.write:true`) ⇒ RTDB-Schreiben via plain `httpRequest` OHNE Credential:
  - GET `…/smarter/config.json`, PATCH `…/smarter/config.json`
  - GET `…/smarter/queue.json`, PATCH/PUT `…/smarter/queue/<unitId>.json`
  - PUT `…/smarter/documents/<yyyy-mm-dd>.json`

## Datenvertrag (exakt einhalten)
- `smarter/config` = `{ dailyMinutes:30, targetWords:2800, scheduleTime:"04:00", timezone:"Europe/Zurich", ingestWebhookUrl }`. (Die App seedet diese config bereits selbst; du liest sie und schreibst NUR `ingestWebhookUrl` hinein.)
- `smarter/queue/<unitId>` = `{ sourceId, order, title, content, estMinutes, status:"pending"|"delivered"|"split" }`.
- `smarter/documents/<yyyy-mm-dd>` = `{ unitIds:[…], theoryHtml:"<html>", questions:[{ q, a }], pdfUrl:"…", done:false }`.
  - `<yyyy-mm-dd>` = lokales Datum in `config.timezone` (Default `Europe/Zurich`) — die App bildet den Schluessel mit exakt dieser Zeitzone, also identisch nummerieren. `questions` = Array von Objekten `{ q:Frage, a:Antwort }` (aus der Theorie beantwortbar). Die App rendert genau dieses Schema (Frage + „Antwort zeigen").
- Upload-Vertrag: Der Ingest-Webhook empfaengt `{ filen