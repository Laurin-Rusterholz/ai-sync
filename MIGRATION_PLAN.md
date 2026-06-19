# Migrationsplan: Speicherung von Netlify Blobs → Firebase

> Status: **Analyse / Entwurf** — noch kein Code geändert. Umbau erst nach Freigabe durch Laurin.
> Bezug: `public/index.html` (single-file SPA), Branch-Basis `main` (`bfb7cf8`).

---

## 0. Executive Summary

Die App speichert **den gesamten Zustand** (`APP.state.data`, inkl. `entities.persons`, `entities.organizations`, alle Module) als **eine JSON-Datei** unter dem Key **`app-data.json`**. Es existiert bereits eine **Provider-Abstraktion** mit zwei Backends:

- **Netlify Blobs** = aktueller **Primär**-Provider (Store `app-sync`, via `/.netlify/functions/blob-put|get`), mit **ETag/`If-Match`-Konfliktschutz**.
- **Firebase _Storage_** = bereits aktiver **Schatten**-Provider (Datei `cloud-sync/app-data.json` im Bucket `jupidu-36804.firebasestorage.app`).

**Wichtig:** Es ist **Firebase _Storage_** (Datei-Bucket) initialisiert — **nicht** RTDB, **nicht** Firestore. Die RTDB (`…europe-west1`) wird nur für die n8n-Queues genutzt.

**Empfehlung (geringstes Risiko/Aufwand):** **Option A — Firebase Storage als Primär** (1:1, gleiches „eine-Datei"-Modell). Die Schatten-Schreibung existiert schon; die Migration ist im Kern ein Umlegen von `preferProvider` + Härtung. Für die n8n-Anbindung an Personen/Orgs **zusätzlich gezielt** einzelne Entitäten in RTDB spiegeln (additiv, klein) — statt die **gesamte** DB nach RTDB zu verschieben (Option C, groß/riskant).

**Kritischer Sicherheitspunkt:** Sobald personenbezogene Daten (Geburtsdaten, Adressen, E-Mails) nach Firebase wandern, ist das aktuelle **offene Regelwerk inakzeptabel**. Netlify wird heute über einen Bearer-Token (`SYNC_AUTH_TOKEN`) geschützt; Firebase-Client-SDK kennt kein Token-Modell → **Firebase Auth ist zwingend einzuführen** (siehe §4). Regeln ändert Laurin selbst.

---

## 1. IST-Zustand (alle Lese-/Schreibstellen)

Datei: `public/index.html`. Zeilennummern ~ Stand `main bfb7cf8`.

### 1.1 Firebase-Initialisierung
| Was | Stelle | Detail |
|---|---|---|
| `FIREBASE_CONFIG` | ~5033–5046 | `projectId: jupidu-36804`, `storageBucket: jupidu-36804.firebasestorage.app` |
| Init | ~5048–5060 | `firebaseApp = firebase.initializeApp(...)`, `firebaseStorage = firebase.storage()` — **nur Storage** |
| RTDB (separat) | 93520/93587 | `firebase.app().database(DB_URL)` nur im Communicator-/Gmail-Modul (Queues) |

### 1.2 Provider-Auswahl / Health
| Funktion | Zeile | Zweck |
|---|---|---|
| `isBlobSyncConfigured()` | 5163 | getUrl/putUrl/blobKey gesetzt? |
| `isFirebaseCloudAvailable()` | 5177 | `return !!firebaseStorage` |
| `shouldTryCloudProvider(p, opts)` | 5180 | Provider aktiv/gesund? |
| `hasAnyCloudProviderAvailable()` | 5197 | irgendein Provider verfügbar? |
| `getCloudProviderOrder(prefer)` | 5683 | Reihenfolge `[prefer, lastGood, 'netlify', 'firebase']` (dedupe) |

### 1.3 Low-Level Provider-I/O
| Funktion | Zeile | Detail |
|---|---|---|
| `netlifyBlobGet(key)` | 5541 | GET `getUrl` (`/.netlify/functions/blob-get?key={key}`) + `buildStorageAuthHeaders(authToken)`; ETag → `APP.state.storage.etag`, `_remoteEtags[key]` |
| `netlifyBlobPut(key,data)` | 5568 | PUT `putUrl`; **`If-Match: etag`** (optimistische Sperre); 412-Retry ohne If-Match |
| `firebaseJsonGet(key)` | 5602 | Download `firebaseStorage.ref(getFirebaseShadowPath(key))` → `cloud-sync/app-data.json` |
| `firebaseJsonPut(key,data)` | 5644 | Upload JSON-`File` via `uploadToFirebase(file, path)`; optionaler `mergeFn`-Merge vor Schreiben; **kein ETag/Precondition** |
| `uploadToFirebase(file,path)` | 5063 | `firebaseStorage.ref(path).put(...)` |
| `getFirebaseShadowPath(key)` | 5149 | `'cloud-sync/' + sanitizeCloudKey(key)` |
| `sanitizeCloudKey(key)` | 5146 | Key-Normalisierung |

### 1.4 Adapter (key-agnostisch)
| Funktion | Zeile | Detail |
|---|---|---|
| `remoteGetByKey(key,opts)` | 5690 | probiert Provider in Reihenfolge, erstes `ok` gewinnt |
| `remotePutByKey(key,data,opts)` | 5702 | schreibt via Provider; bei `shadowToFirebase` zusätzlich Firebase-Schatten (gedrosselt `_lastFirebaseShadowWriteAt`, Default **45 s**) |

### 1.5 App-Daten-Wrapper (`app-data.json`)
| Funktion | Zeile | Detail |
|---|---|---|
| `remoteGet(opts)` | 10133 | `remoteGetByKey(blobKey, { preferProvider:'netlify', ... })` |
| `remotePut(data,opts)` | 10137 | `remotePutByKey(blobKey, data, { preferProvider:'netlify', **shadowToFirebase:true**, mergeFn:mergeData, ... })` |
| Defaults | 9983–9985 / 5168–5170 | `blobKey:"app-data.json"`, `getUrl/putUrl:"/.netlify/functions/blob-get|put?key={key}"` |

### 1.6 Lokale Persistenz & Orchestrierung
| Funktion | Zeile | Detail |
|---|---|---|
| `loadLocalData()` / `saveLocalData()` | 10063 / 10096 | localStorage (offline-first) |
| `mergeData(local,remote)` | 9705 | Feld-/Entity-Merge (last-write-wins via `meta.updatedAt` + `meta.lastSavedBy`/deviceId) |
| `doSave(silent)` | 11226 | Concurrency-Guard `_saving`; **Pull-before-Push** (`pullAndMergeBeforeSave`); `buildRemoteAppPayload()` → `remotePut`; **412 → remoteGet+mergeData+Retry** |
| `scheduleSave()` | (Aufrufer überall) | debounced → `doSave` |
| `mhSave()` | 89013 | Personen/Orgs-Modul → `scheduleSave()`; Personen-Schreiben direkt in `entities.persons[id]` (89047, 90649) |

### 1.7 Boot/Load
| Stelle | Zeile |
|---|---|
| `init()` (Boot) | 58011, via `DOMContentLoaded` 68838 |
| `remoteGet()` beim Boot/Freshness/Sync | 9386, 9477, 10684, 11311, 58823 |

### 1.8 Weitere Cloud-Datensätze (nicht `app-data.json`, separat zu beachten)
| Datensatz | Stelle | Backend |
|---|---|---|
| ReadingHub (`rhDataKey`) | 73322/73343 | **bereits `preferProvider:'firebase'`** (Storage) — Beleg, dass Firebase-Primär funktioniert |
| Datei-Anhänge (`storagePath`) | 6224/7497/47605 … | Firebase Storage (Dateien) |
| RTDB-Queues | gmail/Communicator-Module | RTDB (n8n) — **bleiben unverändert** |
| Netlify-Functions | `netlify/functions/blob-get.mjs`, `blob-put.mjs` | Store `"app-sync"` |

---

## 2. ZIEL-Architektur — Optionen

### Option A — **Firebase Storage als Primär (1:1, minimal-invasiv)** ✅ empfohlen
Gleiches Modell („eine `app-data.json`"), nur anderer Primär-Provider. Der Firebase-Pfad existiert bereits (`firebaseJsonGet/Put`), ReadingHub nutzt ihn schon produktiv.

- **Umbau:** `remoteGet`/`remotePut` (10133/10137) `preferProvider` → `'firebase'`; `shadowToFirebase` → optional `shadowToNetlify` (oder Netlify als reiner Fallback); Default `getUrl/putUrl`/`blobKey` bleiben als Fallback.
- **Aufwand:** **gering** (wenige Stellen, hinter bestehender Abstraktion).
- **Risiko:** **niedrig** (erprobter Pfad), ABER:
  - **Konfliktschutz schwächer:** Firebase Storage hat hier **kein** `If-Match`/ETag. Heute liefert Netlify die Sperre. Ersatz nötig: Storage-`generation`/`metageneration`-Precondition **oder** der vorhandene `mergeData`+`lastSavedBy`-Mechanismus als alleinige Strategie (Pull-before-Push + Merge ist schon da).
  - **CORS/Storage-Rules** müssen den Browser-Zugriff auf `cloud-sync/` erlauben (Code kennt `_firebaseCorsBlocked`).
- **n8n:** liest/schreibt die **Datei** `cloud-sync/app-data.json` (Admin SDK / Storage API) und parst `entities.*`. Funktioniert, aber „ganze Datei"-Schreiben kollidiert mit App-Schreiben → Disziplin via `meta.lastSavedBy`/Merge nötig.

### Option B — **Firebase RTDB, ein JSON-Dokument**
Ganzes `app-data.json` als **ein** RTDB-Knoten (z. B. `/appData`).

- **Umbau:** neuen Provider `firebaseRtdbGet/Put` in den Adapter (`firebase.app().database(DB_URL).ref('/appData').once/set`) + in `getCloudProviderOrder`.
- **Aufwand:** **mittel**. **Risiko:** **mittel** — jeder Save schreibt den **gesamten** Baum (App-Daten können mehrere MB sein); RTDB ist für einen Riesen-Blob suboptimal, aber machbar. Vorteil: echte **Rules + `transaction()`** (Konflikt) + n8n liest aus derselben DB.

### Option C — **RTDB/Firestore normalisiert (Entitäten getrennt)**
`entities.persons`, `…organizations`, … als separate Pfade/Collections.

- **Umbau:** Lade-/Speicher-/Merge-Schicht **komplett** neu, pro-Entity-Sync, Offline-Handling, sämtliche CRUD-Pfade.
- **Aufwand:** **groß**. **Risiko:** **hoch** (viele Regressionsflächen). Vorteil: granularer Sync, kleinste Writes, n8n-freundlichste Struktur, Realtime pro Entity.

### Empfehlung
1. **Kern-Migration:** **Option A** (Storage-Primär, 1:1) — geringstes Risiko, Schatten existiert bereits.
2. **n8n-Bedarf (Personen/Orgs):** **gezielte RTDB-Spiegelung** einzelner Entitäten (analog `orgMailInstructions`/`publishOrgMail`) — additiv, klein. So bekommt n8n saubere Pfade, **ohne** den gesamten Datenbestand hinter offene RTDB-Regeln zu legen.
3. **Option C** nur, wenn echter granularer Multi-Writer-Sync zwingend wird — separat planen.

---

## 3. Daten-Migration (verlustfrei)

**Ausgangslage hilft:** Der Firebase-Storage-Schatten `cloud-sync/app-data.json` wird **bereits laufend** geschrieben — die Daten liegen also schon in Firebase.

**Option A:**
1. **Einmaliges „Force-Shadow"**: Admin-Aktion/Konsole ruft `remotePut(buildRemoteAppPayload(), { force:true })` bzw. direkt `firebaseJsonPut(blobKey, data, {force:true})` → garantiert aktuelle Firebase-Kopie.
2. **Verify-Roundtrip:** `firebaseJsonGet(blobKey)` lesen, gegen lokalen Stand `countEntities`/`meta.updatedAt` prüfen.
3. **Flip** `preferProvider:'firebase'` (Feature-Flag, s. §5).
4. **Rollback:** Flag zurück auf `'netlify'`; der Netlify-Blob bleibt unverändert erhalten (nicht löschen, bis stabil).

**Option B/C:** zusätzlich ein **einmaliges Migrations-Skript** (Button im Settings/Admin oder Node-Script): liest `app-data.json` vom aktuellen Primär → schreibt in RTDB-Ziel(e) → Verify (`once('value')` Vergleich) → Flag-Flip. Rollback identisch (Netlify-Blob bleibt Quelle der Wahrheit bis Abnahme).

**Generell:** Migration **idempotent** halten (mehrfach ausführbar), `meta.updatedAt`/`lastSavedBy` als Korrektheitsanker, **vor** dem Flip ein Voll-Backup (Download `app-data.json`).

---

## 4. Sicherheit (kritisch)

**Heute:**
- Netlify-Blob: geschützt über **Bearer-Token** `SYNC_AUTH_TOKEN` (`buildStorageAuthHeaders`). Einfaches Shared-Secret-Modell.
- RTDB-Queues: **Regeln offen (`.read/.write: true`)** — für jeden mit der URL.
- Firebase Storage `cloud-sync/`: aktuell vom Browser beschreibbar → Storage-Rules vermutlich offen/lasch.

**Problem:** Wandert der **gesamte** Bestand (Personen mit Geburtsdaten, Adressen, E-Mails, Notizen) nach Firebase, ist „offen für jeden mit URL" ein **ernster Datenschutzverstoß** (DSGVO-relevant).

**Was nötig ist (Regeln setzt Laurin selbst):**
- **Firebase Auth einführen** (z. B. Owner-Login via Google/E-Mail, oder anonyme Auth mit fester UID-Bindung). Das Client-SDK hat **kein** Token-Header-Modell wie Netlify → Auth ist der einzige saubere Weg.
- **Storage-Rules** (Option A): `cloud-sync/**` nur für authentifizierten Owner les-/schreibbar, z. B. `allow read, write: if request.auth != null && request.auth.uid == '<OWNER_UID>'`.
- **RTDB-Rules** (Option B/C **und** für die n8n-Queues): `".read"/".write"` an `auth != null` bzw. feste UID binden statt `true`. n8n nutzt eine **Service-Account/Admin-SDK** (umgeht Rules serverseitig) — Clients aber nicht mehr offen.
- **⚠️ Logikänderung:** Auth-Einführung berührt App-Logik (Login-Gate, Token-Refresh) → **vor Umsetzung mit Laurin abstimmen** (STOPP-Regel). Die Migration sollte Auth als eigene Etappe **vor** dem produktiven Flip haben.

---

## 5. Schritt-für-Schritt (jede Etappe einzeln testbar, kein halb-migrierter Zustand)

Alles hinter der bestehenden Provider-Abstraktion + einem **Feature-Flag** (`APP.state.settings.storage.primaryProvider`), damit jederzeit reversibel.

**Etappe 0 — Vorbereitung (kein Verhaltenswechsel)**
- Firebase-Storage-Schatten-Gesundheit prüfen; „Force-Shadow-now"-Aktion; Verify-Roundtrip-Lesen aus Firebase. Testbar: Lesen aus Firebase liefert identische Daten.

**Etappe 1 — Firebase als gleichwertige Lese-Quelle**
- Fallback-Lesen aus Firebase erzwingen (Netlify „aus" simulieren). Testbar: App lädt vollständig nur aus Firebase.

**Etappe 2 — Auth + Rules (SICHERHEIT, vor Schreib-Flip)**
- Firebase Auth (Owner) einführen; Storage-/RTDB-Rules härten (Laurin). Testbar: ohne Login kein Zugriff; mit Login voller Zugriff.

**Etappe 3 — Schreib-Flip hinter Flag**
- `preferProvider:'firebase'` für `app-data.json`; Netlify als Schatten/Fallback. Testbar: Save→Reload-Roundtrip, **Multi-Device**.

**Etappe 4 — Konfliktschutz**
- Storage-`generation`-Precondition **oder** alleinige `mergeData`+Pull-before-Push-Strategie verifizieren. Testbar: simulierter Parallel-Edit zweier Geräte → kein Datenverlust.

**Etappe 5 — (optional) gezielte RTDB-Spiegelung für n8n**
- Personen/Orgs additiv nach RTDB spiegeln (z. B. `quantusPersons/<id>`, `quantusOrgs/<id>`). Testbar: n8n liest erwartete Felder; App bleibt Quelle der Wahrheit.

**Etappe 6 — Netlify-Abkündigung**
- Nach Stabilitätsfenster (z. B. 7–14 Tage) Netlify-Provider + Functions entfernen. Testbar: App ohne Netlify voll funktional. (Netlify-Blob als kaltes Backup behalten.)

Jede Etappe ist per Flag/Branch **einzeln** ein-/ausschaltbar → nie „halb migriert".

---

## 6. Auswirkungen auf die n8n-Anbindung

- **Queues (gmailDrafts, gmailClassifications, taskRequests/Suggestions, suggestions, orgMailInstructions, quantus_task_inbox):** **unverändert** in RTDB.
- **Option A (Storage-Primär):** n8n liest Personen/Orgs aus der **Datei** `cloud-sync/app-data.json` (Storage Admin API) und parst `entities.persons/organizations`. Schreiben durch n8n: ganze Datei → Kollisionsrisiko mit App → besser nur **lesen**, Änderungen über Queues an die App geben.
- **Option B/C (RTDB):** n8n liest/schreibt Personen/Orgs **direkt** aus RTDB-Pfaden (sauber), via Service-Account (umgeht Rules). Setzt §4-Härtung voraus.
- **Empfohlener Mittelweg:** Kern via Storage (A) **+** gezielte RTDB-Spiegel für genau die Entitäten, die n8n braucht (Personen/Orgs) — n8n bekommt saubere Pfade, ohne den gesamten Bestand offen in die RTDB zu legen.

---

## Offene Entscheidungen für Laurin
1. **Ziel-Backend:** A (Storage-Primär, empfohlen) · B (RTDB ein-Dokument) · C (normalisiert)?
2. **n8n-Zugriff auf Personen/Orgs:** Datei parsen (A) **oder** gezielte RTDB-Spiegel (empfohlen) **oder** Voll-RTDB (B/C)?
3. **Auth-Modell:** Firebase Auth (Owner-Login) bestätigen — ist Voraussetzung für sichere Firebase-Speicherung (Logikänderung, daher Freigabe nötig).
4. **Netlify-Abkündigung** sofort nach Flip oder nach Stabilitätsfenster?

> Nach Freigabe setze ich die gewählte Option etappenweise um (jede Etappe als eigener, testbarer Schritt). Der Design-PR (#12-Merge → Teil A+B+C) läuft davon **unabhängig** weiter.
