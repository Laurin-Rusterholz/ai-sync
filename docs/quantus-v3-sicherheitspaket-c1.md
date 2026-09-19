# Quantus v3 — Sicherheitspaket C1

Dieses Dokument beschreibt das Paket **C1**: die Tür vor den vier geplanten
v3-Werkzeugen. Es beschreibt, was geprüft wird, wie der Server konfiguriert
sein muss, wie ein späteres Paket das benutzt — und was C1 **nicht** leistet.

> **Quantus ist damit nicht abgesichert und nicht umgestellt.** C1 schaltet
> keinen Endpunkt frei. Die bestehenden Funktionen (`blob-put`, `blob-get`,
> `gcal-*`, `gmail-api`, `mail-queue*`, `flowertech-*`) sind unverändert und
> hängen weiter am optionalen `SYNC_AUTH_TOKEN`. Fertig ist v3 erst nach
> T01–T40, der All-Writer-Migration in Desktop/Tablet/Mobile und einem echten
> 14-Tage-Probebetrieb.

## 1. Umfang

| Datei | Inhalt |
| --- | --- |
| `netlify/lib/quantus-v3-auth.mjs` | Konfiguration (fail closed), Firebase-ID-Token-Prüfung, Dienst-Zugangsdaten, Job-Token, Rollenmatrix, Transport, Rate-Limiter-Vertrag |
| `netlify/lib/quantus-v3-cursor.mjs` | signierte, seitenweise Kontextcursor |
| `tests/quantus-v3-auth-*.test.mjs` | 62 Verhaltenstests (`node:test`), ohne Netz, ohne Abhängigkeiten |
| `tests/fixtures/quantus-v3-auth-fixtures.mjs` | flüchtige Schlüssel und Attrappen für die Tests |

Neue Abhängigkeiten: **keine.** In `package.json` kam nur das eigene
Testskript `test:quantus-v3` dazu (und ein Aufruf davon am Ende von `test`).

Nicht Teil von C1 und bewusst nicht angefasst: `netlify/lib/assistant-*.mjs`
(Schema, Migration, Ampel, Abschluss), `netlify/lib/quantus-v3-idempotency.mjs`,
`firebase-admin.mjs` inkl. `mutateAppData`, `date-invite*`,
`flowertech-sync/inquiry`, CI, `docs/quantus-v3-implementation.md`.

## 2. Die vier Werkzeuge

| Werkzeug | Route | Verb | Stand |
| --- | --- | --- | --- |
| `quantus_context` | `quantus-context` | `context.read` | nicht freigeschaltet |
| `quantus_read` | `quantus-read` | `object.read` | nicht freigeschaltet |
| `quantus_command` | `quantus-ingest` | `command.submit` | nicht freigeschaltet |
| `quantus_run_status` | `quantus-run-status` | `run_status.read` | nicht freigeschaltet |

`QUANTUS_V3_TOOLS[...].enabled` ist überall `false`; ein Test hält fest, dass
zu keiner dieser Routen eine Netlify-Funktion existiert. Die Geschäftslogik
bringt ein folgendes Paket.

## 3. Erwartete Serverkonfiguration

Alle Werte sind **Serverkonfiguration**. Keiner davon gehört in den Browser,
in `public/`, in ein Repository oder in einen Test. Fehlt oder bricht einer,
antwortet jede Prüfung mit **503 `auth_not_configured`** und nennt nur den
**Namen** der Variable — nie ihren Inhalt.

| Variable | Pflicht | Inhalt |
| --- | --- | --- |
| `QUANTUS_V3_FIREBASE_PROJECT_ID` | ja | Projekt-Id; daraus folgt der erwartete Aussteller `https://securetoken.google.com/<projectId>` und die erwartete `aud` |
| `QUANTUS_V3_POLICY_VERSION` | ja | Fassung des Rechtemodells, z. B. `v3-2026-09-19` |
| `QUANTUS_V3_ALLOWED_ORIGINS` | ja | Kommaliste vollständiger https-Origins. Kein `*`, kein Teil-Wildcard, kein `http` |
| `QUANTUS_V3_SERVICE_CREDENTIALS` | ja | JSON-Liste `{id, principal, role, tenant, secretSha256, status, notAfter?}` — **nur SHA-256-Abdrücke**, nie das Geheimnis |
| `QUANTUS_V3_WORKER_TOKEN_KEYS` | ja | JSON-Liste `{kid, secret, status}` für Job-Token (HMAC-SHA256) |
| `QUANTUS_V3_CURSOR_KEYS` | ja | JSON-Liste `{kid, secret, status}` für Cursor — **eigener Schlüsselsatz**, nicht derselbe wie oben |
| `QUANTUS_V3_FIREBASE_TENANT` | optional | ist er gesetzt, MUSS jedes Nutzer-Token diesen Mandanten tragen; ist er nicht gesetzt, darf kein Token einen tragen |
| `QUANTUS_V3_MODE` | optional | `dry_run` (Standard) oder `enforce` |

`status` ist `active` (stellt aus und gilt), `retiring` (gilt noch; bei
Dienst-Zugangsdaten bis `notAfter`) oder `revoked` (gilt nie). Mindestens ein
`active`-Eintrag ist Pflicht, sonst 503. Geheimnisse sind mindestens 32 Zeichen;
empfohlen sind 32 zufällige Bytes als Hex.

**Rotation** (ohne Ausfall): neuen Eintrag als `active` voranstellen, alten auf
`retiring` setzen (bei Dienst-Zugangsdaten mit `notAfter`), Aufrufer umstellen,
alten Eintrag entfernen oder auf `revoked` setzen. Ausgestellte Job-Token und
Cursor leben höchstens 15 Minuten; ein `revoked`-Schlüssel entwertet sie sofort.

`SYNC_AUTH_TOKEN` ist **kein** v3-Standard: optional, für alle alten Endpunkte
derselbe, und im Browser gewesen. Der v3-Code liest ihn nicht.

## 4. Was geprüft wird

### 4.1 Nutzer — Firebase-ID-Token

`verifyFirebaseIdToken(idToken, { config, keySource, userLookup, now })`
prüft in dieser Reihenfolge (eine gefälschte Signatur kostet keinen Netzaufruf):

1. Form; Header `alg === "RS256"` (`none`, `HS256`, `RS512` ⇒ 401), `kid` vorhanden.
2. **Signatur** gegen Googles öffentlichen Schlüssel — `crypto.verify("RSA-SHA256", …)`,
   Schlüssel aus
   `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`,
   zwischengespeichert nach `max-age` der `Cache-Control`-Kopfzeile, bei
   unbekannter `kid` genau eine Auffrischung. Es wird **nie** nur dekodiert.
3. `exp` in der Zukunft (ohne Toleranz), `iat`/`auth_time` nicht in der Zukunft
   (60 s Uhrenversatz), `aud` = Projekt-Id, `iss` = `https://securetoken.google.com/<projectId>`,
   `sub` nicht leer und ≤ 128 Zeichen.
4. **Mandant**: `firebase.tenant` bzw. `tenant_id`; widersprechen sie sich, 401.
   Erwarteter Mandant fehlt oder ist fremd ⇒ 403.
5. **Widerruf und Sperre** über die offizielle Admin-API `accounts:lookup`:
   `disabled` ⇒ 403 `user_disabled`; `validSince > iat` ⇒ 401 `token_revoked`;
   `tenantId` des Datensatzes muss zur Konfiguration passen. Fällt die Abfrage
   aus, wird **nicht** durchgelassen.

`userLookup` und `keySource` kommen als Abhängigkeit herein — für Tests als
Attrappe, in Produktion über
`createGooglePublicKeySource()` und `createIdentityToolkitUserLookup({ getAccessToken, projectId, tenantId })`.
Fehlt eine der beiden, ist die Antwort 503, nie 200. Dieses Modul hält selbst
kein Dienstkonto und liest keines; den Zugriffstoken für `accounts:lookup`
liefert der Aufrufer.

Grundlage: Firebase-Anleitung „Verify ID tokens using a third-party JWT
library" (Header- und Payload-Tabelle, Schlüsselendpunkt, `max-age`) und die
Identity-Platform-Referenz zu `accounts:lookup` (`disabled`, `validSince`,
`tenantId`). Der Schlüsselendpunkt wurde am 19.09.2026 direkt abgefragt und
liefert `cache-control: public, max-age=…, must-revalidate`.

Ein Wechsel auf das offizielle Admin-SDK (`verifyIdToken(token, true)`,
`tenantManager().authForTenant()`) ist an derselben Stelle möglich: er ersetzt
`verifyFirebaseIdToken` als Ganzes; die Schnittstelle (Token rein, Principal
oder Absage raus) bleibt.

### 4.2 Dienste

`verifyServiceCredential(presented, { config })`: eigener, rotierbarer
Pflicht-Ausweis pro Dienst. Der Server hält nur den SHA-256-Abdruck, verglichen
in gleichbleibender Zeit. Fehlend/falsch/zu kurz ⇒ **401** mit identischem
Grund (die Länge verrät nichts). Rolle, Mandant und Principal stammen aus der
Serverkonfiguration; ein Dienst kann nie die Rolle `user` tragen.

### 4.3 Worker

`mintJobToken` / `verifyJobToken`: eigenes, minimales Format
(`qv3j1.<kid>.<payload>.<hmac>`) — **kein JWT**, also auch keine
`alg`-Verwechslung. Signatur HMAC-SHA256 aus `node:crypto` mit Domänentrennung
`qv3-job-token.v1|<kid>|<payload>`; derselbe Schlüsselwert könnte keinen Cursor
signieren. Höchstlaufzeit 15 Minuten, **beim Ausstellen** erzwungen.
`verifyJobToken` verlangt `expectedAudience` **und** `expectedJobId`; falsche
audience, fremder Job, fehlende Jobbindung, Ablauf, Policy-Wechsel und
`revoked`-Schlüssel führen zur Absage. Rollen kommen vom Aussteller, nie aus
dem Body: `role: "user"` lässt sich nicht ausstellen.
`assertNoProviderSecrets(jobContext)` weist Anbieter-Schlüssel im Job-Kontext ab.

### 4.4 Rollen (`authorize`)

Eine Matrix, eine Quelle. Unbekannte Rolle, unbekanntes Verb, unbekannte
Datenkategorie ⇒ **403**. Geprüft wird beim **Lesen wie beim Schreiben**:
jedes Verb verlangt Datenkategorie und Objekt (`{kind, id, tenant, ownerId?,
jobId?, assignedTo?}`), der Mandant immer.

| Rolle | Bindung | darf |
| --- | --- | --- |
| `user` | eigenes Objekt (`ownerId`) | eigene Aufträge, Antworten, Freigaben, Aufgaben, Mail, Lead-Abschluss, Lesen des Eigenen |
| `lead_agent` | zugewiesen | zugewiesenen Kontext lesen, bestehende Aufträge weiterschalten, Ergebnis schreiben, Aufgabe anlegen — **keine** Nutzerantwort, Freigabe, Policy, Rechtevergabe, Mail, Lead-Abschluss, kein `job.create` |
| `specialist_claude` / `specialist_gemini` | genau ein Job | **nur** `context.read` auf den Kontext dieses Jobs und `job.result.write` an diesen Job — sonst nichts |
| `scheduler` | Mandant | fällige Jobs weiterschalten, Betriebsstatus lesen — **keine** Inhaltsfreigabe |
| `backend_checker` | Mandant | Status lesen und Systemstatus/Abschluss rechnen — **keine** externen Aktionen |

`policy.write` und `grant.write` hat **keine** Rolle. Die Policy-Version ist
Teil der Entscheidung: ein Aufrufer mit veralteter Fassung bekommt 403.
`rejectIdentityInPayload(body)` weist einen Body ab, der Rolle, Principal,
Mandant, Scopes oder Rechte behauptet — auch eine Ebene tiefer.

### 4.5 Transport

* `enforceTls(req)` — `x-forwarded-proto: https` oder https-URL, sonst 403.
* `evaluateOrigin({ origin, principalKind, config })` — feste Allowlist, kein
  Wildcard; die Absage nennt weder die abgelehnte noch die erlaubten Origins
  und trägt keine CORS-Kopfzeile. **Browser** (`principalKind: "user"`) ohne
  Origin ⇒ 403; **Dienst/Worker** ohne Origin ⇒ erlaubt (Server-zu-Server hat
  keine); sendet ein Dienst doch eine, muss sie passen. CORS ersetzt nie den
  Ausweis — eine erlaubte Origin ohne gültiges Zugangsdatum bleibt 401.
* `enforceJsonCommand({ contentType, rawBody })` — genau `application/json`,
  höchstens **64 KiB in UTF-8-Bytes**, Ergebnis muss ein Objekt sein,
  `__proto__` verboten.

### 4.6 Ratenbegrenzung

C1 liefert **keinen** Zähler, sondern den Vertrag. `requireHandlerRateLimiter`
verlangt `atomic: true` und `scope: "shared"` und antwortet sonst 503
`rate_limiter_not_configured`. `createInMemoryRateLimiter()` weist sich selbst
als `multiInstanceSafe: false` aus und wird abgewiesen — Netlify und Cloud Run
laufen mehrinstanzig, ein Zähler pro Instanz ist kein Schutz. Der Schlüssel
(`rateLimitKey`) hängt an Principal + Mandant + Verb, nie an der IP allein.

### 4.7 Cursor

`signCursor` / `verifyCursor` binden eine Seite an Principal, Principal-Art,
Mandant, **benannte** Abfrage (`job.context`, `lead.context`, `job.queue`,
`run.status`), Objektscope, Policy-Version, Datenrevision und Ablauf
(≤ 15 min). Manipulation, fremder Principal/Mandant, andere Abfrage, grössere
Seite, Revisions- oder Policy-Wechsel, unbekannter oder zurückgezogener
Schlüssel ⇒ Absage. Der Scope ist eine **Id**, kein Pfad: `/`, `.`, `__`,
Leerzeichen und alles ausserhalb `[A-Za-z0-9_-]` fallen durch, also gibt es
weder Firebase-Pfade noch Blob-Keys im Cursor. Die Feldliste ist
abgeschlossen — Freitext (Mailinhalt) lässt sich nicht mitgeben; der Beleg ist
signiert, nicht verschlüsselt. `describePage` trennt `done` / `more` /
`aborted`: eine abgebrochene Seite ist **nie** `complete: true`.

## 5. Integrationsschnittstelle für den Command-Handler

Erwartete Reihenfolge im späteren Handler — jeder Schritt bricht ab:

1. `resolveAuthConfig(envRead)` → bei `ok: false` sofort 503 mit `body`.
2. `enforceTls(req)`.
3. Ausweis bestimmen: `Authorization`-Kopfzeile → Firebase-ID-Token
   (`verifyFirebaseIdToken`), Dienst-Zugangsdatum (`verifyServiceCredential`)
   oder Job-Token (`verifyJobToken` mit der Route als audience und der Job-Id
   **aus dem Pfad/Kontext**, nicht aus dem Body).
4. `evaluateOrigin({ origin, principalKind: principal.kind, config })`.
5. `enforceJsonCommand({ contentType, rawBody })` und
   `rejectIdentityInPayload(value)`.
6. `requireHandlerRateLimiter(store)` und `rateLimitKey({ principal, verb })` —
   atomarer, geteilter Zähler.
7. `authorize({ principal, verb, dataCategory, object, policyVersion, config })`
   für **jedes** angefasste Objekt, lesend wie schreibend.
8. Erst danach Daten: Cursor über `verifyCursor`, Schreibwege über das
   Idempotenz- und Schema-Paket der Nachbarsessions.

Alle Prüfungen geben dieselbe Form zurück: `{ ok: true, … }` oder
`{ ok: false, status, error, reason, body }`. `body` ist das, was hinausgehen
darf; `reason` ist immer ein fester Bezeichner aus dem Code, nie ein Wert aus
der Anfrage.

Voreinstellung ist `dry_run`. Ein Handler darf im `dry_run` prüfen und
protokollieren, aber nichts wirksam machen; `enforce` ist eine bewusste,
einzelne Umstellung.

## 6. Tests

`npm run test:quantus-v3` (Teil von `npm test`): 62 Fälle, ohne Netz, ohne
Abhängigkeiten, ohne bezahlte Aufrufe. Alle Schlüssel entstehen zur Laufzeit
(`randomBytes`, `generateKeyPairSync`) und sterben mit dem Prozess; im Repo
steht kein Credentialwert.

Kryptografie wird **echt** geprüft, nicht mit einem „Mock, der ja sagt":
ID-Token werden mit einem frischen RSA-Schlüssel signiert und danach am
Nutzinhalt verbogen (gleiche Signatur ⇒ 401); Job-Token und Cursor ebenso mit
HMAC. Der Zertifikatspfad (`X509Certificate`) wird mit einem zur Laufzeit
erzeugten, selbstsignierten Zertifikat geprüft, sofern `openssl` vorhanden ist,
sonst übersprungen.

## 7. Bekannte Lücken — was C1 **nicht** beweist

1. **Kein Handler, keine Kette.** Bewiesen sind die einzelnen Prüfungen. Dass
   sie in der richtigen Reihenfolge und vollständig aufgerufen werden, kann
   erst der Command-Handler zeigen.
2. **Ratenbegrenzung.** Nur der Vertrag steht. Ein echter atomarer,
   instanzübergreifender Zähler pro Principal fehlt und muss im Handler
   nachgewiesen werden (RTDB-Transaktion, Firestore oder Redis).
3. **Widerrufsprüfung im Betrieb.** `accounts:lookup` ist angebunden, aber
   ungetestet gegen echte Google-Antworten; Latenz, Kontingent und das
   Verhalten bei 429/5xx sind offen. Fail-closed heisst hier: bei Ausfall
   keine Anmeldung.
4. **Zertifikatsstrecke.** Geprüft wird mit erzeugten Schlüsseln und einem
   selbstsignierten Zertifikat; die echten Google-Zertifikate samt
   Schlüsselwechsel sieht erst der Betrieb.
5. **Mandantenmodell.** Es gibt heute genau einen Nutzer und faktisch einen
   Mandanten. Die Bindung ist geprüft, aber nie unter echten mehreren
   Mandanten gelaufen.
6. **Objektdaten.** `authorize` prüft das übergebene Objekt. Dass `ownerId`,
   `jobId`, `assignedTo` und `tenant` beim Laden aus der Datenbank korrekt und
   unverfälscht gefüllt werden, ist Sache des Datenzugriffs im nächsten Paket —
   ein falsch gefülltes Objekt macht jede Prüfung wertlos.
7. **Datenrevision.** Der Cursor bindet an eine Revision; woher die Revision
   kommt und dass sie sich bei jeder Änderung ändert, ist noch nicht gebaut.
8. **Alte Endpunkte.** `blob-put` & Co. bleiben wie sie sind. Solange ein
   Client sie schreibend erreicht, gilt das Sicherheitsmodell von C1 nur für
   den neuen Weg — die Aussage „Quantus ist abgesichert" ist erst nach dem
   All-Writer-Cutover in Desktop, Tablet und Mobile zulässig.
9. **Dry-Run.** In `dry_run` entstehen keine wirksamen Rechte. Was `enforce`
   im Produktivsystem auslöst, ist nicht erprobt.
