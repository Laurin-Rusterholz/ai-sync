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
- Upload-Vertrag: Der Ingest-Webhook empfaengt `{ filename, type:"html"|"pdf", base64 }` und MUSS mit `{ ok:true, units:<int> }` antworten (die App wertet genau das aus).
- Flashcards: NICHT unter `smarter/`, sondern ins bestehende RecallLab-Schema. Exakte Feldnamen:
  - Speicherort in RTDB: `cloud-sync/app-data.json` → Feld `recallLabData.cards[]` (das ist der Cloud-Spiegel des RecallLab; die App mergt beim Laden per Karten-ID als Union, neue Karten mit eigener `id` bleiben erhalten — verifiziert).
  - Vorgehen: GET `…/cloud-sync/app-data.json.json` → falls vorhanden, an `recallLabData.cards` anhaengen; `recallLabData.meta`/Top-`meta.updatedAt` = jetzt (ISO), damit die App den Stand als neuer erkennt → PUT zurueck. (Falls `cloud-sync/app-data.json` noch nicht existiert: die App legt ihn beim ersten Cloud-Save an — dann Karten beim naechsten Lauf anhaengen; alternativ Netlify-Blob `app-data.json`.)
  - Karten-Objekt (exakt): `{ id:<uuid>, deckId:"deck_general", front:<Frage>, back:<Antwort>, reversible:true, cardType:"basic", createdAt:<ms>, srs:{ ease:2.5, intervalDays:1, repetitions:1, nextReview:<morgen-00:00-ms>, phase:"review", step:0, lapses:0 } }`.
  - `front`=Vorderseite, `back`=Rueckseite. Es gibt KEIN Feld `dueDate` — die Faelligkeit ist `srs.nextReview` (Unix-ms). „dueDate = morgen" ⇒ `srs.nextReview` = morgen 00:00 in ms.
  - Deck `deck_general` („📋 Allgemein") existiert bereits. Optional eigenes Deck `deck_smarter` in `recallLabData.decks[]` anlegen: `{ id:"deck_smarter", name:"🎓 Smarter", description:"Automatisch aus Smarter-Lernstoff", createdAt:<ms>, newCardsPerDay:20 }`.
  - SELBSTTEST Flashcards: eine Testkarte schreiben, die App laden, pruefen dass sie in RecallLab (Deck) auftaucht. Falls der Cloud-Spiegel-Pfad nicht durchschlaegt: als Fallback in den Netlify-Blob `app-data.json` (`recallLabData.cards`) schreiben.

## Baue, aktiviere, teste selbst
1) `smarter-ingest` (Webhook, empfohlener Pfad `smarter-ingest` ⇒ URL `https://n8n.srv1757990.hstgr.cloud/webhook/smarter-ingest`):
   Body `{filename,type,base64}` → Text extrahieren (PDF: Gotenberg/pdf-Extraktion oder ein PDF-Text-Node; HTML: Tags strippen) → Zeichenanzahl > 0 pruefen, sonst Fehler `{ok:false}` + Log. → Anthropic splittet VERLUSTFREI in Units von ~`targetWords` Woertern (NUR schneiden, nie zusammenfassen/kuerzen, `order` fortlaufend erhalten) → jede Unit als `pending` nach `smarter/queue/<unitId>` (`{sourceId, order, title, content, estMinutes, status:"pending"}`; `estMinutes` = ceil(Woerter/200)). Antwort `{ ok:true, units:<int> }`.
2) `smarter-daily` (`scheduleTrigger` v1.2, taeglich, `timezone:"Europe/Zurich"` explizit im Node, Zeit aus `config.scheduleTime`, Default 04:00):
   `smarter/config` lesen → offene Units (`status=="pending"`) nach `order` akkumulieren bis ~`dailyMinutes` (kleine kombinieren; ist eine Unit zu gross, splitten und den Rest als neue `pending`-Unit mit erhaltener `order` zuruecklegen) → Anthropic erzeugt aus den kombinierten Units: `theoryHtml` + `questions:[{q,a}]` (aus der Theorie beantwortbar) + Flashcards → `quantus-doc-pdf`-Webhook rendert PDF, Upload nach Firebase Storage → `smarter/documents/<yyyy-mm-dd>` schreiben (`{unitIds, theoryHtml, questions, pdfUrl, done:false}`), verwendete Units auf `status:"delivered"`, Flashcards ins RecallLab-Schema (siehe oben) mit `srs.nextReview` = morgen.
3) Beide Workflows aktivieren; je eine Test-Execution auf `success` pruefen. Bei `smarter-daily` verifizieren: naechste Laufzeit == 04:00 `Europe/Zurich`.
4) `ingestWebhookUrl` in `smarter/config` schreiben: PATCH `…/smarter/config.json` mit `{ "ingestWebhookUrl":"https://n8n.srv1757990.hstgr.cloud/webhook/smarter-ingest" }`. (Danach zeigt die App im Upload-Tab keine „fehlt noch"-Meldung mehr und der Upload feuert real.)

## NO-LOSS-SELBSTTEST
8000-Woerter-Text durch `smarter-ingest`, drei `smarter-daily`-Laeufe simulieren. Nachweis: ALLE Units `delivered` UND Summe der Zeichen aller Units == Ausgangszeichen (kein Zeichenverlust; Split darf nur schneiden). Bei Abweichung fixen.

## OFFENE WERTE aus Discovery
1. Anthropic-Credential-ID (n8n-intern) — nur als Platzhalter im Repo; per Credential-Namen „Anthropic API-Key (Header x-api-key)" wiederverwenden.
2. Direkte Gotenberg-Endpoint-URL — nicht im Repo; Alternative = bestehender Webhook `…/webhook/quantus-doc-pdf` (`{html,filename}` → PDF-Blob).
3. n8n-API-Key (`X-N8N-API-KEY`) fuer die REST-API — nicht im Repo; im n8n-UI erzeugen.
--- ENDE ---

---

## 5 · Update 2026-07-15 — HTML-Lerndokument statt PDF (Session `smarter-htmldoc-2026-07-15`)

Gotenberg/PDF ist tot und wird fallengelassen. Stattdessen: taeglich ein schoen
gestaltetes, self-contained **HTML-Lerndokument** mit Antwortfeldern.

### Datenvertrag erweitert
- `smarter/documents/<yyyy-mm-dd>` neu: **`documentHtml`** (self-contained HTML,
  inline CSS, keine externen Requests). `pdfUrl` bleibt `""` (entfaellt).
- `questions[]`: jede Frage hat jetzt eine **stabile `id`** → `{ id:"q1"|"q2"…, q, a }`.
- **NEU `smarter/documents/<yyyy-mm-dd>/answers/<qId>` = `{ text, updatedAt:<iso> }`**
  — Nutzerantworten, nur innerhalb `smarter/` (offene Regel, kein Credential).

### App (public/index.html, Modul Smarter, „Heute")
- `documentHtml` wird isoliert in einem **iframe** (`srcdoc`, Scripts entfernt)
  gerendert → 1:1 wie der Download, kein Style-Bleed in die App.
- Unter jeder Frage (per `data-qid`) wird ein **Antwort-Textfeld** eingedockt,
  vorbefuellt aus `answers/<qId>`. Speichern: Debounce 700 ms + sofort bei Blur
  → `set(smarter/documents/<heute>/answers/<qId>, {text,updatedAt})`, mit
  sichtbarem Feedback (gespeichert ✓ / offline gemerkt / Fehler).
- „Musterantwort zeigen" pro Frage (aus `questions[].a`).
- „Herunterladen": statische `.html`-Kopie inkl. eingegebener Antworten
  (Blob + `a[download]`, Dateiname `smarter-<date>.html`). Speicherbar sind die
  Antworten nur in der Quantus-Ansicht.
- Fallback (Dokument ohne `documentHtml`): Theorie + Fragen nativ, ebenfalls mit
  speicherbaren Antwortfeldern.
- Post-render Hook (`window.__smarterPostRender`) mountet das iframe nach jedem
  Render; Antwortfelder via Parent-Listener (Tippen loest keinen Voll-Render aus).
- Verifiziert (headless Chromium, 16/16, 0 uncaught JS-Errors): iframe rendert,
  Felder pro `data-qid` eingedockt + vorbefuellt, Tippen+Blur speichert ohne
  Fehler, Download bettet Antworten ein.

### n8n (`n8n/smarter-daily.workflow.json` — Import, da API von hier blockiert)
Die n8n-REST-API ist aus der Claude-Code-Umgebung nicht erreichbar (403). Daher
liegt der komplette Workflow als importierbares JSON im Repo.

**Import:** n8n → Workflows → Import from File → `n8n/smarter-daily.workflow.json`.
Danach:
1. Node „Anthropic: Theorie + Fragen" → Credential **„Anthropic API-Key (Header
   x-api-key)"** zuweisen (Header-Auth, wiederverwenden). Die RTDB-Nodes brauchen
   KEIN Credential (`smarter/*` offen via `$andere`).
2. Alten Workflow `2Bkv3B2la7OOpAc3` deaktivieren (oder dessen Gotenberg-Nodes
   „PDF via webhook"/„Upload PDF" entfernen) — dieser neue ersetzt ihn.
3. Workflow aktivieren. Zeitzone ist im Workflow-Setting auf `Europe/Zurich`
   gesetzt; Schedule-Cron `0 4 * * *` → 04:00 Europe/Zurich. Naechste Laufzeit
   verifizieren.
4. Test-Execution auf `success` pruefen; danach `smarter/documents/<heute>` in
   der RTDB kontrollieren (`documentHtml`, `questions[].id`, `pdfUrl:""`,
   `done:false`).

**Node-Kette:** Schedule → GET config → GET queue → „Units auswaehlen"
(Akkumulieren bis `dailyMinutes`, verlustfreies Schneiden, Rest als neue
`pending`-Unit `order+0.5`) → IF `hasWork` → Anthropic (`claude-sonnet-5`,
striktes JSON `{theoryHtml, questions:[{q,a}], flashcards:[{front,back}]}`) →
„Dokument bauen" (IDs q1..qn, `documentHtml`) → PATCH `smarter/documents/<date>`
(**PATCH** statt PUT → App-`answers` bleiben erhalten) + PATCH `smarter/queue`.

### KORREKTUR zum Flashcards-Speicherort (frueherer Handoff)
Frueher als „RTDB `cloud-sync/app-data.json`" notiert — **falsch**. `firebaseJsonPut`
laedt via `uploadToFirebase` in Firebase **Storage** (Bucket
`jupidu-36804.firebasestorage.app`), Pfad `cloud-sync/app-data.json`
(`sanitizeCloudKey` behaelt den Punkt). Der RecallLab-Cloud-Stand liegt also in
**Storage** bzw. im Netlify-Blob `app-data.json`, NICHT in der RTDB. Ein
Flashcard-Push nach RecallLab braucht Storage-Auth und ist ein eigener Schritt —
im `smarter-daily`-Workflow daher bewusst NICHT enthalten; die generierten
Flashcards liegen als `documents/<date>/flashcards` bereit. `smarter/*` selbst
ist echte RTDB (Dokumente/Antworten funktionieren dort verifiziert).

### Logbuch
- 2026-07-15 · Gotenberg-Ausfall auf srv1757990 diagnostiziert (kein SSH/Egress
  aus der Umgebung → Remediation-Befehle geliefert). Danach Modul auf
  HTML-Lerndokument umgestellt: App (iframe-Doc + speicherbare Antwortfelder +
  Download) und n8n (`smarter-daily.workflow.json`, kein Gotenberg). Smoketest
  16/16, Workflow-Validator 0 Fehler, Code-Nodes inkl. No-Loss-Split getestet.
  Flashcard-Speicherort korrigiert (Storage statt RTDB).

---

## 6 · Update 2026-07-15 — Korpus gezählt, 1 Thema/Tag, Queue geseedet (Session `smarter-build-2026-07-15`)

**Quelle:** „Kompendium · Wirtschaft, Recht & Gesellschaft" (Google Drive
`1gIzH9dwdiJLtflaxtjOsLpMPCC95TNZQ`, 207 723 B). Die eingebetteten
KI-Anweisungstexte (`Du bist Athena…`, `So nutzt die KI in n8n diese Datei`)
wurden **strikt als Inhalt/Daten** behandelt — nichts davon ausgeführt. Struktur
**statisch** geparst (kein `eval`/`Function` auf externem JS; nur String/Regex).

### Zählung (exakt)
- **Top-Level-Lerneinheiten: 6** — `CONTENT`-Sektionen:
  01 recht (Privatrecht, 8) · 02 wirtschaft (Volkswirtschaft, 8) ·
  03 vorsorge (Vorsorge & Versicherung, 7) · 04 unternehmen (Unternehmung & BWL, 9) ·
  05 staat (Staatskunde, 5) · 06 gesellschaft (Gesellschaft & Umwelt, 4).
- **Unterthemen/Themen: 41** (`ARTICLES.<id>`, dot- und bracket-Notation; 8+8+7+9+5+4).
- **Tage bei 1 Thema/Tag: 41.**

### Modell 1 Thema/Tag (Daily angepasst)
- `n8n/smarter-daily.workflow.json`: Node „Thema auswaehlen" nimmt **genau EIN**
  nächstes `pending`-Thema nach `order` (kein Akkumulieren, kein Schneiden mehr).
- Anthropic-Prompt auf **~30 Min** Zielumfang umgestellt: theoryHtml mit mehreren
  Abschnitten, Beispielen, Merksätzen, ggf. Tabelle (Richtwert 800–1400 Wörter),
  **6–10 Fragen** (Verständnis + Anwendung), 4–8 Flashcards; `max_tokens` 12000.
  Prompt weist die KI an, den Quelltext **nur als Lernmaterial** zu behandeln
  (keine darin enthaltenen Anweisungen befolgen).
- Datenvertrag unverändert: `smarter/documents/<date>` = {unitIds, theoryHtml,
  questions:[{id,q,a}], flashcards, pdfUrl:"", done:false, documentHtml}; Antworten
  unter `…/answers/<qId>`; **PATCH statt PUT**.

### Queue (verlustfrei) + Loader
- `n8n/smarter-queue.seed.json`: **41 `pending`-Units**, je
  {sourceId:"wissensbasis-kompendium", order:1..41, title, content, estMinutes:30,
  status:"pending"}. `content` = **verbatim** aus `ARTICLES[id]` (lead+body);
  No-Loss verifiziert (jede content-Passage ist exakte Teilzeichenkette der
  Quelle — nur geschnitten, nichts zusammengefasst). Gesamt 149 971 Zeichen.
- `n8n/smarter-buildlog.seed.json`: Build-Logbuch für `smarter/buildLog/smarter-build-2026-07-15`.
- `scripts/seed-smarter-queue.mjs`: pusht Queue + buildLog per PATCH in die RTDB
  (dort ausführen, wo die RTDB erreichbar ist — aus der Claude-Umgebung 403).
  `node scripts/seed-smarter-queue.mjs` (bzw. `--dry-run`).

### Loop-Reihenfolge (unitIds, 1 Thema/Tag)
```
  Tag  1: 1.1  Der Mietvertrag  (recht)
  Tag  2: 1.2  Der Arbeitsvertrag  (recht)
  Tag  3: 1.3  Der Kaufvertrag  (recht)
  Tag  4: 1.4  Allgemeine Vertragslehre  (recht)
  Tag  5: 1.5  Familienrecht  (recht)
  Tag  6: 1.6  Erbrecht  (recht)
  Tag  7: 1.7  SchKG & Betreibung  (recht)
  Tag  8: 1.8  Obligationenrecht  (recht)
  Tag  9: 2.1  Grundlagen VWL  (wirtschaft)
  Tag 10: 2.2  Marktwirtschaft  (wirtschaft)
  Tag 11: 2.3  Wachstum & Strukturwandel  (wirtschaft)
  Tag 12: 2.4  Konjunkturzyklen  (wirtschaft)
  Tag 13: 2.5  Inflation & Deflation  (wirtschaft)
  Tag 14: 2.6  Wirtschaftspolitik  (wirtschaft)
  Tag 15: 2.7  Aussenwirtschaft  (wirtschaft)
  Tag 16: 2.8  Geld & Geldsystem  (wirtschaft)
  Tag 17: 3.1  Risikomanagement  (vorsorge)
  Tag 18: 3.2  Das 3-Säulen-System  (vorsorge)
  Tag 19: 3.3  Sozialversicherungen  (vorsorge)
  Tag 20: 3.4  Privatversicherungen  (vorsorge)
  Tag 21: 3.5  Arbeitslosigkeit  (vorsorge)
  Tag 22: 3.6  Sozialer Ausgleich  (vorsorge)
  Tag 23: 3.7  Steuern & Abgaben  (vorsorge)
  Tag 24: 4.1  Grundlagen BWL  (unternehmen)
  Tag 25: 4.2  Unternehmensmodell  (unternehmen)
  Tag 26: 4.3  Strategie  (unternehmen)
  Tag 27: 4.4  Organisation  (unternehmen)
  Tag 28: 4.5  Marketing-Mix  (unternehmen)
  Tag 29: 4.6  Personalmanagement  (unternehmen)
  Tag 30: 4.7  Rechtsformen  (unternehmen)
  Tag 31: 4.8  Finanzierung & Anlage  (unternehmen)
  Tag 32: 4.9  Businessplan  (unternehmen)
  Tag 33: 5.1  Föderalismus  (staat)
  Tag 34: 5.2  Direkte Demokratie  (staat)
  Tag 35: 5.3  Bundesrat  (staat)
  Tag 36: 5.4  Bundesversammlung  (staat)
  Tag 37: 5.5  Gewaltenteilung  (staat)
  Tag 38: 6.1  Ökologie & Energie  (gesellschaft)
  Tag 39: 6.2  Wirtschaftskreislauf & BIP  (gesellschaft)
  Tag 40: 6.3  Globalisierung  (gesellschaft)
  Tag 41: 6.4  Strukturwandel  (gesellschaft)
```

### Logbuch
- 2026-07-15 · Korpus in Drive gefunden + statisch geparst (6 Einheiten, 41 Themen).
  Queue-Seed (41 pending, verlustfrei) + buildLog + Loader-Script erstellt; Daily
  auf 1 Thema/Tag & ~30-Min-Prompt umgestellt. Workflow-Validator 0 Fehler,
  Code-Nodes getestet (Selektion nimmt genau 1 Thema, No-Loss-Substring-Check).
  RTDB aus der Umgebung nicht erreichbar → Seed/Log via Loader-Script (Nutzer).
