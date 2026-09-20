# Quantus v3 — Paket C3b: die tatsächliche Laufzeitverdrahtung

Dieses Paket beantwortet eine einzige Frage: **woher bekommen die vier dünnen
Routen aus C2 ihre Abhängigkeiten — und was passiert, wenn eine fehlt?**

Antwort in einem Satz: aus benannten Ports, die geprüft werden; und wenn eine
fehlt, antwortet der Dienst **503**, ohne etwas zu tun.

> Stand: `QUANTUS_V3_API_WRITES` bleibt aus, die vier Routen sind nicht
> ausgeliefert, und **Quantus ist damit nicht umgestellt und nicht
> abgesichert**. C3b ist die Verdrahtung, nicht die Inbetriebnahme.

## 0. Stand der Prüfung

| Fassung | Stand |
| --- | --- |
| `1a8d08c` | C2 unabhängig geprüft (64 eigene Tests, 13 unabhängige Gegenprüfungen). Befund: die Verdrahtung selbst war **nicht** belastbar |
| `a422670` | C3b-01 … C3b-03 behoben, 16 eigene Tests. Unabhängig geprüft: Positivfall bestanden, aber **acht Gegenproben** am Zugriffstoken fehlgeschlagen |
| `4379061` | G-1 … G-8 behoben, 22 eigene Tests. Release-Review (`48dc1fe`): alle 22 plus neun frühere Prüfungen grün, **eine neue Gegenprobe** (C3B-07) fehlgeschlagen |
| diese Fassung | C3B-07 behoben (strenge Admission), Gate G1 im Code geschlossen (scope-gebundener Export in firebase-admin, mit Regressionsprüfung), Fachadapter-Gründe auf eine Allowlist; 33 eigene Tests |

| # | Befund (`1a8d08c`) | Jetzt |
| --- | --- | --- |
| C3b-01 | `buildRuntimeDeps` baute einen Speicher über ein **eigenes Testmodell** (`entities.leads`) mit Rückfall auf den Wurzelknoten — nicht über den echten CAS | `createCoreStore` benutzt ausschliesslich `readAppDataDocument`/`mutateAppData` und prüft deren Vorhandensein; der Schlüssel ist auf `app-data.json` **festgenagelt** (anderer Schlüssel ⇒ `key_denied`), kein Wurzel-Rückfall |
| C3b-02 | Der Fachadapter war `modul?.default \|\| modul` — ein Modul, das zufällig die richtigen Namen trägt, wäre zum Rechtegeber geworden | Genau **ein** Port: die benannte Fabrik `createQuantusV3DomainAdapter`, aufgerufen mit serverseitiger Politik und Mandant. Fehlt sie, wirft sie, oder fehlt eine Methode ⇒ 503 (`domain_factory_missing` / `domain_factory_failed` / `domain_adapter_incomplete`) |
| C3b-03 | Die Widerrufsprüfung brauchte ein Zugriffstoken, das **nirgends** herkam — und wurde stillschweigend nicht verdrahtet | `quantus-v3-identity-access.mjs`: eine streng benannte Reihenfolge, scope- und projektgebunden, mit Cache und gebündeltem Abruf. Gibt es keinen Weg, bleibt `userLookup` **null**, und C1 antwortet 503 `user_lookup_missing` — ein ID-Token ohne Widerrufsprüfung gilt nie |

### Runde 2 — die acht Gegenproben (Review `a422670`)

Alle acht betrafen **denselben Bereich**: das Zugriffstoken. Jede ist gegen
den alten Stand nachgestellt und schlägt dort fehl.

| # | Befund (`a422670`) | Jetzt |
| --- | --- | --- |
| G-1..3 | Ein Port, der `expiresAt = jetzt-1`, `jetzt` oder `jetzt+59999` lieferte (Marge 60 s), wurde **akzeptiert**: die Marge galt nur dem alten Cache-Eintrag, nie der frischen Antwort | Dieselbe Schranke für **jedes** Token, gleich woher: `expiresAt - MARGE > jetzt`, sonst `identity_token_expired`. Genau eine Millisekunde jenseits der Marge gilt weiterhin — die Schranke ist eine Grenze, keine Pauschalablehnung |
| G-4 | Ein Erwerb, der 121 s dauerte, lieferte ein Token, das bis Start+120 s gültig war — geprüft wurde mit der Zeit **vom Start** | Die Schranke wird **nach** dem `await` mit neu abgefragter Zeit gezogen. Nicht die Dauer entscheidet, sondern die Frist danach |
| G-5 | `expires_in: -60` wurde still zu einer Stunde | Fehlende, negative, nicht numerische, nicht endliche oder `NaN`-Frist ⇒ `identity_token_lifetime_invalid` — auf **jedem** Weg. Auch ein hereingegebener Port muss seine Frist nennen; eine nackte Zeichenkette ist keine Zusicherung mehr |
| G-6 | Zwei echte `buildRuntimeDeps` für **dieselbe** Konfiguration ergaben bei parallelem `userLookup` **zwei** Tokenabrufe: der Cache lag im Provider-Abschluss, die Handler bauen ihre Abhängigkeiten aber **pro Request** | Der Speicher liegt im Modul und wirkt über Requests. Gebunden an Projekt, Mandant, Scope, Tokenquelle (Portidentität), Verkehr und die **aktuelle** Zugangskonfiguration (als Hash — die Werte werden nicht gespeichert und nirgends zurückgegeben). Begrenzt auf `MAX_CACHE_ENTRIES` (8), ausdrücklich verwerfbar über `invalidateIdentityAccessCache()`. Jeder Wechsel von Projekt, Mandant, Scope, Quelle oder Zugangsdaten ergibt einen anderen Schlüssel. Der **Widerrufslookup** selbst wird **nie** gecacht |
| G-7..8 | Ein werfender Port (oder `getIdentityAccessToken`) wurde mit Originalfehler weitergereicht — Nachricht, `body` und `cause` konnten ein Zugangsdatum tragen | An der Modulgrenze wird **jeder** Fehler in einen neuen übersetzt: `message` = Kennung, ein einziges eigenes Feld (`code`), kein `cause`, kein `body`, kein Tokenwert. Das ist ein Grenznachweis am Modul — keine Aussage über eine HTTP-Antwort |

### Runde 3 — C3B-07, Gate G1, Allowlist (Release-Review `48dc1fe`)

| # | Befund | Jetzt |
| --- | --- | --- |
| C3B-07 | Die angekündigte Speichergrenze galt unter Last **nicht**: `eintragFuer` legte den Eintrag bedingungslos an, und die Verdrängung übersprang jeden Eintrag mit laufendem Abruf. 16 gleichzeitige, verschiedene Quellen ergaben 16 Einträge bei `MAX_CACHE_ENTRIES` 8 — während des Abrufs **und** nach dem Abschluss, da niemand nachträglich begrenzte | **Strenge Admission vor dem Anlegen.** Ist der Eintrag schon da, ändert sich nichts (die Bündelung derselben Quelle bleibt unberührt und kostet keinen Platz). Sonst: freier Platz ⇒ anlegen; kein freier Platz ⇒ erst unbrauchbare, dann die ältesten Einträge **ohne** laufenden Abruf verdrängen; bleibt alles in Arbeit ⇒ **kontrollierte Ablehnung** `identity_access_busy`. Damit gilt `entries <= 8` zu jedem Zeitpunkt. Ein fehlgeschlagener Erwerb gibt seinen Platz zurück. Jedes Versprechen wird zurückgegeben — der Test prüft auf `unhandledRejection` |
| G1 | Der scope-gebundene Token existierte nur als **dokumentiertes Gate**: firebase-admin exportierte keine solche Funktion, und die Admin-Scopes tragen kein `identitytoolkit`. Damit blieb jeder Nutzer-Ausweis 503 | `netlify/lib/firebase-admin.mjs` exportiert jetzt `getIdentityAccessToken({ scope, projectId })` — **dieselbe** Zugangsauflösung, **derselbe** Tausch, nur mit anderem Scope (siehe §3a). Die Laufzeit nimmt ihn automatisch (`identityAccessSource: firebase:getIdentityAccessToken`) |
| Gründe | `domainReason` war zwar bereits eine feste Zeichenkette, aber ohne Schranke: ein künftiger Zweig hätte einen fremden Fehlercode durchreichen können | `DOMAIN_FACTORY_REASONS` ist die **Allowlist**; alles andere wird zu `domain_factory_failed`. Der Fehler der Fabrik wird nicht gelesen — keine Nachricht, kein Code, kein `cause`. Auch eine Fabrik, die selbst einen „Grund" behauptet, bestimmt ihn nicht |

Die Kennungen, die das Modul nach aussen gibt (`IDENTITY_ACCESS_ERRORS`):
`identity_access_not_configured`, `identity_project_mismatch`,
`identity_token_failed`, `identity_scope_missing`,
`identity_token_lifetime_invalid`, `identity_token_expired`,
`identity_access_busy`. C1 übersetzt einen
gescheiterten Lookup wie bisher zu 401 `user_lookup_failed`; ein fehlender
Lookup bleibt 503 `user_lookup_missing`.

## 1. Dateien

| Datei | Inhalt |
| --- | --- |
| `netlify/lib/quantus-v3-runtime.mjs` | die Verdrahtung: Ports, Diagnose, `toResponse` |
| `netlify/lib/quantus-v3-identity-access.mjs` | das Zugriffstoken für `accounts:lookup` — und nur dieses |
| `tests/quantus-v3-c3b-identity-access.test.mjs` | 6 Tests: Reihenfolge, Scope, Projektbindung, Cache, Bündelung, Fehlerformen |
| `tests/quantus-v3-c3b-gegenbeispiele.test.mjs` | 9 Tests: die acht Gegenproben G-1 … G-8, C3B-07 (Last und Bündelung), die Gründe-Allowlist |
| `tests/quantus-v3-c3b-firebase-export.test.mjs` | 8 Tests: der scope-gebundene Token (Scope, Projekt, Frist, Dienstkonto-Signatur, kein Cache) und die **Regression** der bestehenden Admin-Funktionen |
| `tests/quantus-v3-c3b-runtime.test.mjs` | 10 Tests an der **gebauten** Laufzeit gegen konditionale Fake-HTTP-Transporte |

Eng geändert: `netlify/lib/firebase-admin.mjs` — genau der Tokenbereich (§3a).
Nicht angefasst: `netlify.toml`, Umgebungsvariablen, Secrets, Firebase-Regeln,
IAM, Abhängigkeiten und Lockfile (das gepatchte `image-size` der Integration
bleibt unberührt), bestehende Automationen, alles unter
`netlify/lib/assistant-*` und die Dateien des Fachadapters (Paket C3a) sowie
B/C2-Fachlogik und die Cloud-Laufzeit (E2).

## 2. Die Ports — der Übergangsvertrag für C3a

`buildRuntimeDeps({ write, read, firebaseModule, idempotencyModule, domainFactory, obtainAccessToken, fetchImpl, now })`.
Alle Einspeisepunkte sind **optional**; ohne sie wird das echte Modul geladen.
Sie sind der Vertrag, mit dem C3a (und die Tests) andocken, **ohne** dass hier
irgendwo ein Ersatzmodell einzieht.

### 2.1 Fachadapter (C3a)

Ein Modul `netlify/lib/quantus-v3-domain-adapter.mjs` mit **genau diesem**
Export:

```js
export function createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now }) {
  return { resolveTarget, assertActiveBinding, applyVerb, loadObject, listPage };
}
```

* Die Fabrik bekommt die **serverseitige** Politik und den Mandanten — nie den
  Request, nie Nutzinhalt. Rechte entstehen nicht aus dem Body.
* `assertActiveBinding({ snapshot, principal, jobId, nowMs, resource })` ist die
  **E1-Bindung**: die gemeinsame Leitungs-Lease bzw. die aktuelle
  Auftragszuweisung. C2/C3b erfinden dafür keine eigenen Felder und lesen die
  Lease nicht selbst; sie fragen den Adapter, bei **jedem** CAS-Versuch mit
  frischer Zeit.
* Fehlt die Fabrik oder eine der fünf Methoden: **503**. Ein Rohmodul, das die
  Namen zufällig trägt, wird nicht übernommen (Test: „nur die benannte Fabrik
  gilt").

### 2.2 Speicher

```
store.readSnapshot()                    → geparster Kern oder Fehler core_unavailable
store.mutate("app-data.json", mutator)  → nur mit write: true
```

Beides direkt auf `readAppDataDocument`/`mutateAppData`. Ein leerer oder
unlesbarer Kern ist ein **Restore-Fall** (`scripts/restore-core.mjs`), keine
leere Arbeitsgrundlage. Ein anderer Schlüssel als der Kern wird abgewiesen.

### 2.3 Idempotenz

Aus `quantus-v3-idempotency.mjs` (Integrationspaket) werden genau
`prepareIdempotentCommand` und `applyIdempotentCommand` verdrahtet. C3b legt
**keine** zweite Ledgerlogik an; fehlt das Modul, ist der Schreibweg 503.

### 2.4 Ratenzähler

`createCasRateLimiter` über `firebaseDbGetWithEtag`/`firebaseDbSet` — atomar,
geteilt, auf dem Schutzknoten `quantusV3RateLimits/`. Der Kerndatensatz wird
dafür nicht angefasst.

### 2.5 Schlüsselbezug und Widerrufsprüfung

`createGooglePublicKeySource` (gebündelt, mit Abkühlzeit) und
`createIdentityToolkitUserLookup` mit dem Token aus 3.

## 3. Das Zugriffstoken für `accounts:lookup`

Streng benannte Reihenfolge, ohne Zwischentöne:

1. `obtainAccessToken` — ausdrücklich hereingegebener Port.
2. `getIdentityAccessToken` aus `firebase-admin.mjs` — **wenn** der Eigentümer
   dieser Datei einen scope-gebundenen Token exportiert. Nur der Name zählt;
   nichts wird nachgebaut.
3. Refresh-Token-Tausch über `userRefreshTokenFromEnv()` — die einzige
   Zugangsauflösung, die `firebase-admin.mjs` heute exportiert.
4. Sonst **503**, mit dem Namen des fehlenden Gates.

Regeln:

* **Scope.** Der Token muss `identitytoolkit` (oder `cloud-platform`) tragen —
  Google nennt die gewährten Scopes, und ein zu enger Token wird **verworfen**,
  statt bei jedem Lookup 403 zu erzeugen.
* **Projekt.** Das v3-Projekt muss dasselbe sein wie das Firebase-Projekt, sonst
  sähe die Sperrprüfung im falschen Verzeichnis nach und hielte jeden für
  ungesperrt.
* **Frist.** Jedes Token wird an derselben Schranke gemessen —
  `expiresAt - 60 s > jetzt`, geprüft **nach** dem Erwerb mit frischer Zeit. Eine
  fehlende oder unbrauchbare Frist wird nie zu einer erfundenen Stunde.
* **Speicher.** Der Cache liegt im Modul und wirkt damit über Requests hinweg
  (die Handler bauen ihre Abhängigkeiten pro Request). Schlüssel ist ein Abdruck
  über Projekt, Mandant, Scope, Quelle und die aktuelle Zugangskonfiguration;
  begrenzt auf 8 Einträge, verwerfbar über `invalidateIdentityAccessCache()`.
  Parallele Anfragen teilen **einen** Abruf, Fehlschläge werden nicht gecacht.
* **Der Widerrufslookup selbst wird nie gecacht.** Er ist die Prüfung.
* **Fehler.** Nur feste Kennungen, ohne `cause`, ohne `body`, ohne Tokenwert.
  Kein Tokenwert erscheint in Log, Antwort oder Diagnose; der Zugangs-Abdruck
  verlässt das Modul nicht.

## 3a. Die enge Änderung an `firebase-admin.mjs`

Zwei Dinge, beide im Tokenbereich:

1. **Ein gemeinsamer Tausch.** `getAdminAccessToken` wurde in
   `exchangeAccessToken({ scope, sendScope })` zerlegt, damit es weiterhin nur
   **eine** Zugangs- und Signaturlogik gibt. Der Admin-Weg verhält sich
   unverändert: beim Refresh-Tausch nennt er **keinen** Scope (ein
   Scope-Parameter kann nur einschränken und hätte den bestehenden Zugang
   verändert), das Dienstkonto-JWT trägt weiterhin genau `ADMIN_SCOPES`, Cache,
   401-Räumung und Fehlermeldungen sind dieselben. Genau das prüft die zweite
   Hälfte von `tests/quantus-v3-c3b-firebase-export.test.mjs` nach.
2. **Der scope-gebundene Export** `getIdentityAccessToken({ scope, projectId })`:
   * nur `identitytoolkit` oder `cloud-platform` — keine allgemeine
     Tokenausgabe (`scope_not_supported`),
   * **echte Projektprüfung** gegen `firebaseConfiguredProjectId()`
     (`project_mismatch`) — im falschen Verzeichnis nachzusehen hiesse, jeden
     für ungesperrt zu halten,
   * **echte Scope-Prüfung** der Antwort, auch über `cloud-platform`
     (`scope_missing`),
   * **explizite Frist** aus `expires_in`, nichts geraten (`lifetime_invalid`),
   * ohne Zugangsdaten gar kein Versuch (`credentials_missing`),
   * **kein eigener Cache** — den hält der Aufrufer, begrenzt und mit Marge.
     Ein zweiter Cache könnte nur veralten.
   Dazu `firebaseAccessCredentialsConfigured()`: damit die Laufzeit einen Weg,
   der nur scheitern kann, gar nicht verdrahtet (ehrliche 503 statt 401).

Keine neuen Variablen, keine neuen Secrets, keine IAM-Änderung, kein
Deployment. Gegen den Integrationsstand `48dc1fe` ist die Änderung
konfliktfrei (`git merge-file` exit 0; der zusammengeführte Stand trägt
sowohl `getIdentityAccessToken` als auch die dortige `unchanged`-Prüfung).

## 4. Diagnose — Namen und Gründe, nie Werte

`buildRuntimeDeps().wiring`:

```
firebase, store, idempotency, rateLimiter          Boolesche
domain, domainReason                               domain_factory_missing | domain_factory_failed | domain_adapter_incomplete
identityAccess, identityAccessReason               identity_project_missing | firebase_project_unknown | identity_project_mismatch | identity_access_not_configured
identityAccessSource                               injected | firebase:getIdentityAccessToken | oauth_refresh_exchange
```

Was hier `false` ist, wird zu einer 503 des Dienstes — das macht eine
Fehlersuche im Betrieb möglich, ohne irgendetwas offenzulegen.

## 5. PFLICHT-GATES von aussen

Ohne diese Schritte bleibt der Weg 503. Sie liegen **nicht** in diesem Paket;
C3b nimmt sie ausdrücklich nicht selbst vor.

| # | Gate | Warum | Wer |
| --- | --- | --- | --- |
| ~~G1~~ | **Der Code-Teil ist geschlossen:** `getIdentityAccessToken` ist implementiert, scope-, projekt- und fristgeprüft, die Laufzeit nimmt ihn, und 8 Tests belegen es (synthetisch). | — | erledigt in dieser Fassung |
| G1-B | **Die Zustimmung bzw. die Berechtigung selbst.** Der Refresh-Token braucht eine OAuth-Zustimmung, die `identitytoolkit` einschliesst, **oder** es braucht ein Dienstkonto mit der passenden Rolle. Ein Refresh-Tausch kann Scopes nur **einschränken**, nicht hinzufügen | Das ist **Betrieb**, nicht Programmierung: niemand kann sie im Repository herstellen. Fehlt sie, scheitert der Erwerb fail closed (`scope_missing` ⇒ 401), statt einen Token zu benutzen, der bei jedem Lookup 403 erzeugte | Betreiber (Google-Zustimmung bzw. IAM) |
| G2 | **Serverkonfiguration** `QUANTUS_V3_FIREBASE_PROJECT_ID`, `QUANTUS_V3_POLICY_VERSION`, `QUANTUS_V3_ALLOWED_ORIGINS`, `QUANTUS_V3_SERVICE_CREDENTIALS`, `QUANTUS_V3_WORKER_TOKEN_KEYS`, `QUANTUS_V3_CURSOR_KEYS`, optional `QUANTUS_V3_FIREBASE_TENANT` | fail closed: fehlt eine, antwortet jede Route 503 und nennt nur den **Namen** | Betreiber (keine Werte in diesem Repo, keine im Test) |
| G3 | **Projektgleichheit** `FIREBASE_PROJECT_ID` = `QUANTUS_V3_FIREBASE_PROJECT_ID` | sonst `identity_project_mismatch` | Betreiber |
| G4 | **Fachadapter C3a** liefert `createQuantusV3DomainAdapter` mit den fünf Methoden | sonst 503 `domain_adapter_not_available` | Paket C3a |
| G5 | **Idempotenzmodul** `quantus-v3-idempotency.mjs` im Zweig (Integrationsstand) | sonst 503 auf dem Schreibweg | Integration |
| G6 | **Schreibfreigabe** `QUANTUS_V3_API_WRITES=enabled` **und** `QUANTUS_V3_MODE=enforce` | heute **aus**; ohne Freigabe 503 `api_writes_disabled` — nie eine quittungsähnliche 200 | bewusste Entscheidung, nach Prüfung |
| G7 | **Firebase-Regeln und IAM** bleiben unverändert, bis G1–G6 stehen | C3b ändert keine Rechte und erzeugt keine Zugangsdaten | Betreiber |

## 6. Tests

```
npm run test:quantus-v3-c3b     # 33 Tests
```

Der Laufzeittest baut die Abhängigkeiten **wirklich** über `buildRuntimeDeps`
und fährt `handleCommandRequest`/`handleReadRequest` dagegen:

* Der Prüfstand ist zuerst der **aktuelle Checkout** (Idempotenzmodul vorhanden
  **und** `mutateAppData` mit geprüfter `unchanged`-Rückgabe) — nach der
  Integration also zwingend der Stand, der wirklich läuft. Erst als Rückfall
  kommt der geprüfte Commit `52b0641`, kontrolliert in ein temporäres
  Verzeichnis. Der Lauf schreibt die Herkunft mit (`# C3b: … aus checkout`
  bzw. `… aus git:52b0641`). Fehlt beides — etwa in einem flachen CI-Klon —
  **scheitert** der Lauf und nennt beide Gründe. Es wird nichts übersprungen
  und nichts nachgebildet.
* Ersetzt ist nur der **Transport**: ein konditionaler Fake für den
  OAuth-Endpunkt, Googles Zertifikatsendpunkt, `accounts:lookup`, den
  Kernknoten (mit echtem `if-match`, 412 bei falschem Stempel) und die
  Zählerknoten. Alle Schlüssel und Zugangsdaten entstehen zur Laufzeit; kein
  Netz, kein Anbieteraufruf, keine Kosten.
* Belegt werden dadurch: echter Schlüsselbezug, echte Widerrufsprüfung, echtes
  CAS (genau **ein** PUT, jeder mit If-Match), echter Ledger im geschriebenen
  Kern, **kein** zweiter Schreibvorgang bei Wiederholung, 409 bei veralteter
  Version, kein Kernschreibvorgang beim Lesen, ein Zugriffstoken für zwei
  gleichzeitige Anfragen.

Die C2-Tests laden den Idempotenz-Ledger aus demselben Stand `52b0641`
(vorher `40a448c`; die Datei ist zwischen beiden unverändert).

## 7. Was C3b NICHT tut

* Keine Auslieferung, kein Deployment, keine Änderung an `netlify.toml`,
  Umgebung, Secrets, IAM, Firebase-Regeln, Abhängigkeiten oder Lockfile.
* Keine Aussage darüber, welche Scopes die **echte** Zustimmung trägt: das
  prüft erst der Betrieb, und der Code scheitert dabei fail closed (G1-B).
* Keine zweite Credentiallogik: kein Dienstkonto-JWT aus diesen Dateien, kein
  Client-Schlüssel, kein Browser-Weg.
* Kein neues MCP-Protokoll. Die vier Werkzeuge
  (`quantus_context/read/command/run_status`) sind eine **getrennte spätere
  Schicht** über den vorhandenen Routen.
* Keine Übernahme eines Fachadapters aus einem nicht angenommenen Paket.
