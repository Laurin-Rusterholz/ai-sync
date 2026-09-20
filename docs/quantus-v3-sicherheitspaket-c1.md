# Quantus v3 — Sicherheitspaket C1

Dieses Dokument beschreibt **C1**: die Tür vor den vier geplanten v3-Werkzeugen.
Was geprüft wird, wie der Server konfiguriert sein muss, wie ein späteres Paket
das benutzt — und was C1 **nicht** leistet.

> **Quantus ist damit nicht abgesichert und nicht umgestellt.** C1 schaltet
> keinen Endpunkt frei. Die bestehenden Funktionen (`blob-put`, `blob-get`,
> `gcal-*`, `gmail-api`, `mail-queue*`, `flowertech-*`) sind unverändert und
> hängen weiter am optionalen `SYNC_AUTH_TOKEN`. Fertig ist v3 erst nach
> T01–T40, der All-Writer-Migration in Desktop/Tablet/Mobile und einem echten
> 14-Tage-Probebetrieb.

## 0. Stand der Prüfung

| Fassung | Stand |
| --- | --- |
| `5ac0bf7` | erste Fassung, unabhängig geprüft — **nicht abgenommen** |
| `9ff3423` | zwölf Gegenbeispiele der ersten Runde korrigiert (`tests/quantus-v3-auth-gegenbeispiele.test.mjs`), Vertragsänderungen (JOSE, Fachverben); unabhängig geprüft — 79/79 grün, aber **fünf neue Gegenbeispiele** |
| diese Fassung | die fünf Befunde der zweiten Runde korrigiert, je ein Test in `tests/quantus-v3-auth-gegenbeispiele-runde2.test.mjs`; beide Gegenbeispiel-Dateien bleiben stehen |

Beide Gegenbeispiel-Dateien nennen jeden Fall mit seiner Nummer und dem
gemeldeten Verhalten. Sie bleiben stehen, damit nichts davon zurückfällt.

**Der gemeinsame Nenner der zweiten Runde:** eine Prüfung, die nicht zu Ende
kam oder einen Wert nur umgeformt hat, gab „in Ordnung" zurück. Ein Netzfehler,
ein `NaN`, eine gültige `0`, eine zu tiefe Struktur — jedes Mal wurde aus
„weiss nicht" ein „ja". Die Korrektur zeigt überall in dieselbe Richtung:
**nicht geprüft heisst nicht bestätigt.**

| # | Befund (9ff3423) | Jetzt |
| --- | --- | --- |
| 1 | Bei leerem oder abgelaufenem Cache lief jeder Aufruf ins Netz — fünf erfundene kids bei ausgefallenem Endpunkt ergaben fünf Abrufe | Abkühlzeit und Singleflight gelten für **beide** Wege; ein abgelaufener Cache wird nicht weiterbenutzt |
| 2 | `Number(record.validSince \|\| 0)` deutete `NaN` zu „nie widerrufen" um | `validSince` muss fehlen oder eine endliche, nicht negative **ganze** Zahl sein (0 gültig); auch die Lookup-Funktion erzeugt kein `NaN` mehr; `disabled` muss ein echtes `false` sein |
| 3 | `dataRevision: 0` — der frische Kernstand — wurde abgelehnt | 0 ist gültig, beim Ausstellen wie beim Prüfen |
| 4 | `-1`, `1.5`, `{}`, `"not-a-revision"` kamen per Zeichenkettenumwandlung durch | ein Vertrag (`isDataRevision`): nicht negative sichere Ganzzahl, keine stillen Umwandlungen, im Cursor als Zahl signiert |
| 5 | Die Geheimnissuche meldete „sauber", wenn sie ihre Tiefengrenze erreichte | Tiefe, Knotenzahl, Zyklen, Getter, Symbole und fremde Objektarten führen zu `provider_secret_scan_incomplete:*` — einer Absage; Getter werden nicht aufgerufen, der gefundene Wert steht nie im Fehler |

## 1. Umfang

| Datei | Inhalt |
| --- | --- |
| `netlify/lib/quantus-v3-auth.mjs` | Konfiguration (fail closed), Firebase-ID-Token, Dienst-Zugangsdaten, Job-Token, Rollenmatrix, Transport, Rate-Limiter-Vertrag |
| `netlify/lib/quantus-v3-cursor.mjs` | signierte, seitenweise Kontextcursor |
| `tests/quantus-v3-auth-*.test.mjs` | 88 Verhaltenstests (`node:test`), ohne Netz |
| `tests/fixtures/quantus-v3-auth-fixtures.mjs` | flüchtige Schlüssel, Attrappen, X.509-Bau in reinem JS |

Abhängigkeit: **`jose`** (v6, keine Transitivabhängigkeiten) — auf Verlangen der
Review, statt eines eigenen Tokenformats. `npm ci` ist damit Voraussetzung für
`npm run test:quantus-v3`. Sonst nur das eigene Testskript in `package.json`.

Nicht Teil von C1 und nicht angefasst: `netlify/lib/assistant-*.mjs`,
`netlify/lib/quantus-v3-idempotency.mjs`, `firebase-admin.mjs` inkl.
`mutateAppData`, `date-invite*`, `flowertech-sync/inquiry`, CI,
`docs/quantus-v3-implementation.md`.

## 2. Die vier Werkzeuge

| Werkzeug | Route | Stand |
| --- | --- | --- |
| `quantus_context` | `quantus-context` | nicht freigeschaltet |
| `quantus_read` | `quantus-read` | nicht freigeschaltet |
| `quantus_command` | `quantus-ingest` | nicht freigeschaltet |
| `quantus_run_status` | `quantus-run-status` | nicht freigeschaltet |

`QUANTUS_V3_TOOLS[...].enabled` ist überall `false`. C1 selbst verdrahtet
nichts: ein Test hält fest, dass die beiden Module ausser `node:`, sich selbst
und `jose` nichts importieren. Die Routendateien kamen mit **C2** dazu (siehe
`docs/quantus-v3-c2-routen.md`); sie importieren nur Dienst und Verdrahtung,
antworten ohne Konfiguration 503 und schreiben nur, wenn zwei Schalter
ausdrücklich stehen — auch das prüft derselbe Test.

## 3. Erwartete Serverkonfiguration

Alle Werte sind Serverkonfiguration. Keiner gehört in den Browser, nach
`public/`, ins Repository oder in einen Test. Fehlt oder bricht einer, antwortet
jede Prüfung mit **503 `auth_not_configured`** und nennt nur den **Namen** der
Variable.

| Variable | Pflicht | Inhalt |
| --- | --- | --- |
| `QUANTUS_V3_FIREBASE_PROJECT_ID` | ja | Projekt-Id; daraus folgen erwarteter `iss` und `aud` |
| `QUANTUS_V3_POLICY_VERSION` | ja | Fassung des Rechtemodells |
| `QUANTUS_V3_ALLOWED_ORIGINS` | ja | Kommaliste vollständiger https-Origins; kein `*` |
| `QUANTUS_V3_SERVICE_CREDENTIALS` | ja | JSON-Liste `{id, principal, role, tenant, secretSha256, status, notAfter?}` — **nur SHA-256-Abdrücke** |
| `QUANTUS_V3_WORKER_TOKEN_KEYS` | ja | JSON-Liste `{kid, secret, status}` für Job-Token |
| `QUANTUS_V3_CURSOR_KEYS` | ja | JSON-Liste `{kid, secret, status}` für Cursor — **eigener Schlüsselsatz** |
| `QUANTUS_V3_FIREBASE_TENANT` | optional | gesetzt ⇒ jedes Nutzer-Token muss diesen Mandanten tragen; nicht gesetzt ⇒ keines darf einen tragen |
| `QUANTUS_V3_MODE` | optional | `dry_run` (Standard) oder `enforce` |

`status`: `active` (stellt aus und gilt), `retiring` (gilt noch, bei
Dienst-Zugangsdaten **nur mit** `notAfter`), `revoked` (gilt nie). Mindestens ein
`active` ist Pflicht. **`notAfter` gilt in jedem Status** — auch bei `active`;
ein unlesbarer Zeitpunkt sperrt schon die Konfiguration. Geheimnisse mindestens
32 Zeichen; empfohlen 32 zufällige Bytes als Hex.

Dienst-Zugangsdaten gibt es **nur** für `scheduler` und `backend_checker`.
`lead_agent` und die Spezialisten arbeiten ausschliesslich mit kurzlebigen,
auftragsgebundenen Job-Token; ein Dauer-Zugangsdatum für sie lässt die
Konfiguration nicht zu.

**Rotation:** neuen Eintrag als `active` voranstellen, alten auf `retiring` mit
`notAfter` setzen, Aufrufer umstellen, alten entfernen oder auf `revoked`.
Job-Token und Cursor leben höchstens 15 Minuten; ein `revoked`-Schlüssel
entwertet sie sofort.

`SYNC_AUTH_TOKEN` ist **kein** v3-Standard und wird vom v3-Code nicht gelesen.

## 4. Was geprüft wird

### 4.1 Nutzer — Firebase-ID-Token

`verifyFirebaseIdToken(idToken, { config, keySource, userLookup, now })`:

1. Kopfzeile: `alg === "RS256"` (`none`, `HS256`, `RS512` ⇒ 401), `kid` vorhanden.
2. **Signatur und Standardansprüche über `jose`** (`jwtVerify`, feste
   Algorithmenliste, `issuer`, `audience`, `clockTolerance: 0`,
   `requiredClaims: sub, iat, exp, auth_time`). Schlüssel aus Googles
   X.509-Endpunkt.
3. Eigene Zusatzprüfungen: endliche ganzzahlige Sekunden für `exp`, `iat`,
   `auth_time`; `iat`/`auth_time` nicht in der Zukunft (60 s Versatz);
   `auth_time ≤ iat`; `sub` ≤ 128 Zeichen.
4. **Mandant**: `firebase.tenant` bzw. `tenant_id`; Widerspruch ⇒ 401; fremder
   oder fehlender erwarteter Mandant ⇒ 403.
5. **Widerruf und Sperre** über `accounts:lookup`: `disabled` (alles ausser
   einem echten `false` oder „fehlt") ⇒ 403;
   **`validSince > auth_time` ⇒ 401 `token_revoked`**. `validSince` muss fehlen
   (= 0) oder eine endliche, nicht negative ganze Sekundenzahl sein — ein
   `NaN` aus einer beschädigten Antwort wird **nicht** zu 0. Gemessen wird an
   `auth_time`, nicht an `iat` (Firebase „Manage user sessions"; das Admin-SDK
   tut mit `verifyIdToken(token, true)` dasselbe) — ein nach dem Widerruf nur
   frisch ausgestelltes Token trägt eine neue `iat`, aber die alte Anmeldezeit.
   Fällt die Abfrage aus, wird nicht durchgelassen.

**Schlüsselbezug:** Cache nach `max-age`, **Singleflight** (parallele Aufrufe
teilen einen Abruf) und **Abkühlzeit** von 60 s — und zwar auf **beiden**
Wegen: für die unbekannte `kid` wie für den leeren oder abgelaufenen Cache.
Eine Flut gefälschter Token mit erfundenen `kid`s kostet also höchstens einen
Abruf je Minute, und ein ausgefallener Endpunkt wird nicht in einer Schleife
angefragt. Ein **abgelaufener Cache wird nicht weiterbenutzt**: ohne frisches
Schlüsselmaterial gibt es kein Ja. Ein echter Schlüsselwechsel wirkt trotzdem —
spätestens nach der Abkühlzeit.

### 4.2 Dienste

`verifyServiceCredential`: SHA-256-Abdruck, Vergleich in gleichbleibender Zeit.
Fehlend/falsch/zu kurz ⇒ 401 mit identischem Grund; abgelaufener `notAfter` ⇒
401 `credential_expired`; `revoked` ⇒ 401. Rolle, Mandant und Principal kommen
aus der Serverkonfiguration.

### 4.3 Worker

`mintJobToken` / `verifyJobToken`: **JWT (JWS compact) über `jose`**, feste
Algorithmenliste (`HS256`), fester Aussteller `quantus-v3/job-token`, eigenes
`typ`, `kid` im Kopf für die Rotation, `job` als Pflichtanspruch. Höchstlaufzeit
15 Minuten, beim Ausstellen erzwungen. `verifyJobToken` verlangt
`expectedAudience` **und** `expectedJobId`. **Scheduler- und Backend-Rollen sind
hier nicht ausstellbar** und werden auch dann abgewiesen, wenn ein Token mit
gültigem Schlüssel signiert wurde. `assertNoProviderSecrets` weist
Anbieter-Schlüssel im Job-Kontext ab.

### 4.4 Rollen (`authorize`)

Ohne Serverkonfiguration ⇒ 503; ohne Policy-Version ⇒ 403; abweichende
Policy-Version ⇒ 403. Rolle, **Art** (`user`/`worker`/`service`) und
**Ausstellweg** (`firebase`/`job_token`/`service_credential`) müssen
zusammenpassen — ein Principal, der `{kind:"worker", role:"user"}` behauptet,
bekommt keine Nutzerrechte. Die **Datenkategorie wird aus der Art des
serverseitig geladenen Objekts abgeleitet**; was der Aufrufer behauptet, muss
dazu passen. Gelesen wird wie geschrieben.

| Rolle | Art / Ausstellweg | Bindung | Verben |
| --- | --- | --- | --- |
| `user` | user / firebase | eigenes Objekt | `context.read`, `intake.create`, `intake.accept`, `task.create`, `lead.comment`, `lead.transition`, `lead.schedule`, **`briefing.answer`**, `question.resolve`, `document.register`, `note.append` |
| `lead_agent` | worker / job_token | zugewiesen | `context.read`, `lead.comment`, `lead.transition`, `lead.schedule`, `task.create`, `question.create`, `document.processed`, `worker.assign`, `worker.review`, `run.checkpoint`, `run.log` |
| `specialist_claude` / `specialist_gemini` | worker / job_token | genau ein Auftrag | `context.read` (nur `run_context` dieses Auftrags), `worker.return` |
| `scheduler` | service / service_credential | Mandant | `context.read` (`run`, `run_status`), `run.ensure`, `run.claim`, `run.renew`, `run.log` |
| `backend_checker` | service / service_credential | Mandant | `context.read`, **`briefing.consumeAnswer`**, `document.processed`, `run.checkpoint`, **`run.finalize`**, `run.log`, **`note.append`** |

`briefing.answer` gibt es nur beim Nutzer, `briefing.consumeAnswer` und
`run.finalize` nur beim Backend — je ein Test hält das fest. Sammelverben
(`command.submit`, `job.advance`, `mail.send`, `lead.finalize`, `policy.write`,
`grant.write`) gibt es nicht; ein Test prüft ihre Abwesenheit.
Domänenbedingungen (welche Übergänge, welche Pflichtfelder) sind C2.

`rejectIdentityInPayload(body)` weist einen Body ab, der Rolle, Principal,
Mandant, Art, Ausstellweg, Scopes oder Rechte behauptet — auch eine Ebene tiefer.

### 4.5 Transport

* `enforceTls(req)` — `x-forwarded-proto: https` oder https-URL, sonst 403.
* `evaluateOrigin(...)` — feste Allowlist, kein Wildcard; die Absage nennt weder
  die abgelehnte noch die erlaubten Origins und trägt keine CORS-Kopfzeile.
  Browser ohne Origin ⇒ 403; Dienst/Worker ohne Origin ⇒ erlaubt; sendet ein
  Dienst eine Origin, muss sie passen. CORS ersetzt nie den Ausweis.
* `enforceJsonCommand(...)` — genau `application/json`, höchstens **64 KiB in
  UTF-8-Bytes**, Objekt, kein `__proto__`.

### 4.6 Ratenbegrenzung

Nur der Vertrag: `requireHandlerRateLimiter` verlangt `atomic: true` und
`scope: "shared"`, sonst 503 `rate_limiter_not_configured`.
`createInMemoryRateLimiter()` weist sich selbst als `multiInstanceSafe: false`
aus und wird abgelehnt. Schlüssel: Principal + Mandant + Verb.

### 4.7 Cursor

`signCursor` / `verifyCursor`: **JWT über `jose`**, eigener Aussteller, eigenes
`typ`, eigener Schlüsselsatz. Gebunden an Principal, Principal-Art, Mandant,
benannte Abfrage, Objektscope, Policy-Version, Datenrevision, Seitenposition,
Ablauf (≤ 15 min). Die **Datenrevision ist eine nicht negative sichere
Ganzzahl** (`isDataRevision`) — `0` eingeschlossen, alles andere abgelehnt,
ohne stille Umwandlung, beim Ausstellen wie beim Prüfen.

`verifyCursor` verlangt **zwingend** `expectedQuery`, `expectedScopeKind`,
`expectedScopeId`, `policyVersion`, `dataRevision`, `principal`, `authConfig`
und das serverseitig geladene `scopeObject` — fehlt eines, wird gesperrt statt
geprüft. Anschliessend läuft **`authorize()` erneut**: Rolle, Art, Ausstellweg,
Mandant, Eigentum und Auftragsbindung werden auf **jeder Seite** neu geprüft.

Benannte Abfragen: `run.context`, `lead.context`, `run.queue`, `run.status`,
`notes.recent`, `policy.current`. Der Scope ist eine Id, kein Pfad (`/`, `.`,
`__`, Leerzeichen fallen durch) — weder Firebase-Pfade noch Blob-Keys. Die
Feldliste ist abgeschlossen; der Beleg ist signiert, nicht verschlüsselt.

`describePage` trennt `done` / `more` / `aborted`. **`items` muss eine Liste
brauchbarer Datensätze sein** (kein Fehlerobjekt, kein Eintrag mit `error`) und
**`hasMore` ausdrücklich gesetzt** — sonst gilt die Seite als abgebrochen. Eine
abgebrochene oder gedeckelte Seite ist nie `complete: true` und trägt keinen
Folgecursor.

## 5. Integrationsschnittstelle für den Command-Handler

1. `resolveAuthConfig(envRead)` → `ok: false` ⇒ sofort 503 mit `body`.
2. `enforceTls(req)`.
3. Ausweis: Firebase-ID-Token (`verifyFirebaseIdToken`), Dienst-Zugangsdatum
   (`verifyServiceCredential`) oder Job-Token (`verifyJobToken` mit der Route
   als audience und der Auftrags-Id **aus dem Pfad/Kontext**, nicht aus dem Body).
4. `evaluateOrigin({ origin, principalKind: principal.kind, config })`.
5. `enforceJsonCommand(...)` und `rejectIdentityInPayload(value)`.
6. `requireHandlerRateLimiter(store)` + `rateLimitKey({ principal, verb })`.
7. `authorize({ principal, verb, dataCategory, object, policyVersion, config })`
   für **jedes** Objekt, mit dem frisch geladenen Datensatz — lesend wie
   schreibend.
8. Erst danach Daten: Seiten über `verifyCursor` (mit Erwartung und
   Scope-Objekt), Schreibwege über das Idempotenz- und Schema-Paket der
   Nachbarsessions.

Alle Prüfungen geben `{ ok: true, … }` oder `{ ok: false, status, error, reason,
body }` zurück. `body` darf hinaus; `reason` ist immer ein fester Bezeichner.
Voreinstellung ist `dry_run`.

## 6. Tests

`npm run test:quantus-v3` (Teil von `npm test`): 88 Fälle über den Dateinamen-Glob
`tests/quantus-v3-auth-*.test.mjs`, ohne Netz, ohne bezahlte Aufrufe. Alle
Schlüssel entstehen zur Laufzeit; im Repo steht kein Credentialwert.

Kryptografie wird echt geprüft: ID-Token mit frischem RSA signiert und danach am
Nutzinhalt verbogen (gleiche Signatur ⇒ 401); Job-Token und Cursor ebenso, samt
`alg: none`, fremdem Aussteller, falschem `typ` und fremdem Schlüsselsatz. Das
X.509-Zertifikat für die Zertifikatsstrecke wird **in reinem JavaScript**
(ASN.1/DER + `node:crypto`) erzeugt — portabel, ohne `openssl`, ohne
übersprungenen Test.

## 7. Bekannte Lücken — was C1 **nicht** beweist

1. **Kein Handler, keine Kette.** Bewiesen sind die einzelnen Prüfungen und die
   Neu-Autorisierung je Cursorseite. Die vollständige Reihenfolge im echten
   HTTP-Weg zeigt erst C2.
2. **Ratenbegrenzung.** Nur der Vertrag; der atomare, instanzübergreifende
   Zähler pro Principal fehlt.
3. **Widerrufsprüfung im Betrieb.** `accounts:lookup` ist angebunden, aber nie
   gegen echte Google-Antworten gelaufen (Latenz, Kontingent, 429/5xx).
4. **Zertifikatsstrecke.** Geprüft mit erzeugten Schlüsseln und einem selbst
   gebauten Zertifikat; die echten Google-Zertifikate samt Schlüsselwechsel
   sieht erst der Betrieb.
5. **Mandantenmodell.** Die Bindung ist geprüft, aber nie unter mehreren echten
   Mandanten gelaufen.
6. **Objektdaten.** `authorize` prüft den übergebenen Datensatz. Dass
   `ownerId`, `jobId`, `assignedTo`, `tenant` und `kind` frisch und
   unverfälscht aus den autoritativen Beständen geladen werden, muss C2 zeigen —
   ein falsch gefülltes Objekt macht jede Prüfung wertlos.
7. **Datenrevision.** Der Cursor bindet an eine Revision; woher sie kommt und
   dass sie sich bei jeder Änderung ändert, ist noch nicht gebaut.
8. **Domänenbedingungen.** Welche Übergänge ein Verb auslösen darf, welche
   Pflichtfelder gelten, wie Leases und Idempotenz zusammenspielen: C2 und das
   Idempotenzpaket.
9. **Alte Endpunkte.** `blob-put` & Co. bleiben wie sie sind. „Quantus ist
   abgesichert" ist erst nach dem All-Writer-Cutover zulässig.
10. **Dry-Run.** In `dry_run` entstehen keine wirksamen Rechte; was `enforce`
    im Produktivsystem auslöst, ist nicht erprobt.
