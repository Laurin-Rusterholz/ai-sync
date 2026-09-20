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
| diese Fassung | die drei Befunde unten behoben, 16 eigene Tests (`tests/quantus-v3-c3b-*.test.mjs`) |

| # | Befund (`1a8d08c`) | Jetzt |
| --- | --- | --- |
| C3b-01 | `buildRuntimeDeps` baute einen Speicher über ein **eigenes Testmodell** (`entities.leads`) mit Rückfall auf den Wurzelknoten — nicht über den echten CAS | `createCoreStore` benutzt ausschliesslich `readAppDataDocument`/`mutateAppData` und prüft deren Vorhandensein; der Schlüssel ist auf `app-data.json` **festgenagelt** (anderer Schlüssel ⇒ `key_denied`), kein Wurzel-Rückfall |
| C3b-02 | Der Fachadapter war `modul?.default \|\| modul` — ein Modul, das zufällig die richtigen Namen trägt, wäre zum Rechtegeber geworden | Genau **ein** Port: die benannte Fabrik `createQuantusV3DomainAdapter`, aufgerufen mit serverseitiger Politik und Mandant. Fehlt sie, wirft sie, oder fehlt eine Methode ⇒ 503 (`domain_factory_missing` / `domain_factory_failed` / `domain_adapter_incomplete`) |
| C3b-03 | Die Widerrufsprüfung brauchte ein Zugriffstoken, das **nirgends** herkam — und wurde stillschweigend nicht verdrahtet | `quantus-v3-identity-access.mjs`: eine streng benannte Reihenfolge, scope- und projektgebunden, mit Cache und gebündeltem Abruf. Gibt es keinen Weg, bleibt `userLookup` **null**, und C1 antwortet 503 `user_lookup_missing` — ein ID-Token ohne Widerrufsprüfung gilt nie |

## 1. Dateien

| Datei | Inhalt |
| --- | --- |
| `netlify/lib/quantus-v3-runtime.mjs` | die Verdrahtung: Ports, Diagnose, `toResponse` |
| `netlify/lib/quantus-v3-identity-access.mjs` | das Zugriffstoken für `accounts:lookup` — und nur dieses |
| `tests/quantus-v3-c3b-identity-access.test.mjs` | 6 Tests: Reihenfolge, Scope, Projektbindung, Cache, Bündelung, Fehlerformen |
| `tests/quantus-v3-c3b-runtime.test.mjs` | 10 Tests an der **gebauten** Laufzeit gegen konditionale Fake-HTTP-Transporte |

Nicht angefasst: `firebase-admin.mjs`, `netlify.toml`, Umgebungsvariablen,
Firebase-Regeln, IAM, bestehende Automationen, alles unter
`netlify/lib/assistant-*` und die Dateien des Fachadapters (Paket C3a).

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

Regeln: der Token muss `identitytoolkit` (oder `cloud-platform`) tragen —
Google nennt die gewährten Scopes, und ein zu enger Token wird **verworfen**,
statt bei jedem Lookup 403 zu erzeugen. Das v3-Projekt muss dasselbe sein wie
das Firebase-Projekt (sonst sähe die Sperrprüfung im falschen Verzeichnis nach
und hielte jeden für ungesperrt). Cache mit 60 s Marge, parallele Anfragen
teilen **einen** Abruf, Fehlschläge werden nicht gecacht. Kein Tokenwert
erscheint in Log, Antwort oder Diagnose.

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
| G1 | **Ein scope-gebundenes Zugriffstoken.** Entweder eine Zeile Export in `firebase-admin.mjs` (`getIdentityAccessToken({ scope })`), oder eine OAuth-Zustimmung, die `https://www.googleapis.com/auth/identitytoolkit` einschliesst | Die vorhandenen Admin-Scopes sind `firebase.database`, `userinfo.email`, `devstorage.full_control` — **kein** `identitytoolkit`; und ein Refresh-Tausch kann Scopes nur **einschränken**, nicht hinzufügen. Ohne G1 gilt **kein** Nutzer-ID-Token (503 `user_lookup_missing`) | Eigentümer von `firebase-admin.mjs` bzw. der Google-Zustimmung |
| G2 | **Serverkonfiguration** `QUANTUS_V3_FIREBASE_PROJECT_ID`, `QUANTUS_V3_POLICY_VERSION`, `QUANTUS_V3_ALLOWED_ORIGINS`, `QUANTUS_V3_SERVICE_CREDENTIALS`, `QUANTUS_V3_WORKER_TOKEN_KEYS`, `QUANTUS_V3_CURSOR_KEYS`, optional `QUANTUS_V3_FIREBASE_TENANT` | fail closed: fehlt eine, antwortet jede Route 503 und nennt nur den **Namen** | Betreiber (keine Werte in diesem Repo, keine im Test) |
| G3 | **Projektgleichheit** `FIREBASE_PROJECT_ID` = `QUANTUS_V3_FIREBASE_PROJECT_ID` | sonst `identity_project_mismatch` | Betreiber |
| G4 | **Fachadapter C3a** liefert `createQuantusV3DomainAdapter` mit den fünf Methoden | sonst 503 `domain_adapter_not_available` | Paket C3a |
| G5 | **Idempotenzmodul** `quantus-v3-idempotency.mjs` im Zweig (Integrationsstand) | sonst 503 auf dem Schreibweg | Integration |
| G6 | **Schreibfreigabe** `QUANTUS_V3_API_WRITES=enabled` **und** `QUANTUS_V3_MODE=enforce` | heute **aus**; ohne Freigabe 503 `api_writes_disabled` — nie eine quittungsähnliche 200 | bewusste Entscheidung, nach Prüfung |
| G7 | **Firebase-Regeln und IAM** bleiben unverändert, bis G1–G6 stehen | C3b ändert keine Rechte und erzeugt keine Zugangsdaten | Betreiber |

## 6. Tests

```
npm run test:quantus-v3-c3b     # 16 Tests
```

Der Laufzeittest baut die Abhängigkeiten **wirklich** über `buildRuntimeDeps`
und fährt `handleCommandRequest`/`handleReadRequest` dagegen:

* `firebase-admin.mjs` **und** `quantus-v3-idempotency.mjs` werden aus dem
  geprüften Integrationsstand `52b0641` kontrolliert in ein temporäres
  Verzeichnis gelegt und von dort geladen — der Lauf schreibt die Herkunft mit
  (`# C3b: … aus git:52b0641, unchanged geprüft: true`). Lässt sich der Stand
  nicht laden, werden die Tests der echten Kette **übersprungen** und als
  „kein Integrationsnachweis" benannt, statt eine Nachbildung als Beleg
  auszugeben.
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
  Umgebung, Secrets, IAM oder Firebase-Regeln.
* Keine zweite Credentiallogik: kein Dienstkonto-JWT aus diesen Dateien, kein
  Client-Schlüssel, kein Browser-Weg.
* Kein neues MCP-Protokoll. Die vier Werkzeuge
  (`quantus_context/read/command/run_status`) sind eine **getrennte spätere
  Schicht** über den vorhandenen Routen.
* Keine Übernahme eines Fachadapters aus einem nicht angenommenen Paket.
