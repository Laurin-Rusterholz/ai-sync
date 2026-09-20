# Quantus v3 — Paket C2: die vier dünnen Routen

C2 baut auf **C1** (Auth, Rollen, Cursor) auf und liefert den HTTP-Weg: vier
Netlify-Funktionen, den Befehlsumschlag, die Kette dahinter, die Lesehilfen und
einen instanzübergreifenden Ratenzähler.

> **Nichts davon ist eine Abnahme.** Ohne Fachadapter liefern die Routen 503,
> Schreiben ist standardmässig aus, und die Produktion bleibt unverändert bis
> zum All-Writer-Cutover und T01–T40. Ein Integrationsstub ist keine fertige
> Funktion.

## 0. Stand der Prüfung

| Fassung | Stand |
| --- | --- |
| `39728bc` | erste C2-Fassung, unabhängig geprüft — 48/48 eigene Tests, aber **elf Gegenbeispiele in neun Gruppen** |
| diese Fassung | C2-01 … C2-09 korrigiert, je als Test in `tests/quantus-v3-c2-gegenbeispiele.test.mjs`; zusätzlich alle 22 Verben positiv und negativ geprüft |

| # | Befund (39728bc) | Jetzt |
| --- | --- | --- |
| C2-01 | Nur der **Scope** wurde autorisiert — ein fremder Eintrag in einer erlaubten Seite ging mit 200 hinaus | **Jeder** gelieferte Eintrag wird frisch geprüft (Mandant, Eigentum/Auftrag, Kategorie) **und** auf seine Scope-Beziehung; ein Verstoss ist 403 ohne Daten, keine stille Auslassung |
| C2-02 | Fehlendes `hasMore` wurde zu `false` und damit zu „vollständig" | Nur ein echtes Boolesches zählt; sonst `aborted`. Ein `hasMore: true` braucht einen **belastbaren** Weiterzeiger (gültige Id, letzter Eintrag, nicht derselbe wie zuvor) |
| C2-03 | `pageSize=1`, zwei Einträge geliefert ⇒ beide ausgeliefert, `complete: true` | Übervolle Seite ⇒ 503 `page_overfull`, keine Daten |
| C2-04 | Im Trockenlauf wurde eine fehlende `dataRevision` zu 0 erfunden | `assertCoreSnapshot` gilt auf **jedem** Weg — Lesen, Prüfen, Schreiben |
| C2-05 | Ausgeschaltetes Schreiben antwortete 200 mit quittungsähnlichen Feldern | **503 `api_writes_disabled`**, ohne ein einziges Quittungsfeld. Prüfen ohne Schreiben gibt es nur **ausdrücklich** über `X-Quantus-Validate-Only`, mit `domainConditionsEvaluated: false` |
| C2-06 | Der Ratenzähler schrieb auch ohne echten ETag (`null`, `""`, `*`) | Ohne echten, nicht-Wildcard-Stempel: **kein** Schreibvorgang, Fehler ⇒ 503 |
| C2-07 | Ein Stand von `-1000` wurde zu `-999` fortgeschrieben | Nicht negative sichere Ganzzahl, passendes Fenster, Overflow-Prüfung; ein kaputter Zähler wird **nicht repariert**, sondern gemeldet. Zeitmarke steht ausserhalb der Wiederholungen. Zusätzlich ein **Gesamtbudget je Principal**, nicht nur je Verb |
| C2-08 | Die Lease wurde gegen eine **vor** `store.mutate` gemerkte Zeit geprüft | Bindung **und** Zeit je CAS-Versuch frisch, auch bei Wiederholung. Die Bindung kommt aus dem Fachadapter (E1: gemeinsame Leitungs-Lease bzw. aktuelle Auftragszuweisung) — C2 erfindet keine eigenen Lease-Felder |
| C2-09 | Anlegen scheiterte an `data_category_not_allowed_for_role`, `run.ensure` war unmöglich | **Ressource und Anker sind getrennt**: die Kategorie prüft die Ressource, die Bindung den Anker. `run.ensure` darf einen fehlenden Lauf anlegen |
| Körper | `req.text()` las unbegrenzt vor der 64-KiB-Prüfung | `readBoundedBody` bricht beim Lesen ab; eine zu grosse `Content-Length` genügt schon vorher |

## 1. Dateien

| Datei | Inhalt |
| --- | --- |
| `netlify/functions/quantus-ingest.mjs` | Route für `quantus_command` (POST) |
| `netlify/functions/quantus-context.mjs` | Route für `quantus_context` (GET) |
| `netlify/functions/quantus-read.mjs` | Route für `quantus_read` (GET) |
| `netlify/functions/quantus-run-status.mjs` | Route für `quantus_run_status` (GET) |
| `netlify/lib/quantus-v3-command-envelope.mjs` | Umschlag, geschlossene Schemata je Fachverb |
| `netlify/lib/quantus-v3-service.mjs` | die Kette: Auth → Herkunft → Körper → Rate → Adapter → Daten → CAS |
| `netlify/lib/quantus-v3-read-helpers.mjs` | sichtbare Felder, Seitengrösse, Entitätsversionen |
| `netlify/lib/quantus-v3-rate-limiter.mjs` | CAS-Schutzzähler (RTDB), atomar und geteilt |
| `netlify/lib/quantus-v3-runtime.mjs` | Verdrahtung der Routen, Adapter über `import()` |
| `tests/quantus-v3-c2-*.test.mjs` | 64 Tests an der echten Kette, darunter alle 22 Verben positiv und negativ |

Die vier Routendateien sind Hüllen von je unter zwölf Codezeilen; ein Test
misst das und lässt nur zwei Importe zu.

## 2. Der öffentliche Umschlag

```
POST /.netlify/functions/quantus-ingest
Authorization: Bearer <Laufzeit-Zugangsdatum>
Content-Type: application/json
Idempotency-Key: <Schlüssel>

{
  "schemaVersion": 3,
  "verb": "lead.comment",
  "jobId": "job_20260920_42",
  "expectedEntityVersion": 17,
  "payload": { "leadId": "lead_123", "text": "...", "evidenceRefs": ["artifact_456"] }
}
```

* **Geschlossen, auch verschachtelt.** Ein unbekanntes Feld im Umschlag oder im
  Nutzinhalt ist 400 — nicht „wird ignoriert". Jedes Fachverb hat sein eigenes
  Schema (Typ, Länge, Aufzählung, Grenzen).
* **Serverbestimmtes gehört nicht in den Körper.** `now`, `requestId`, `actor`,
  `tenant`, Rolle, Policy, `dataRevision`, `idempotencyKey`: 400
  `payload_forbidden_field`.
* **Keine Pfade.** Ids sind `[A-Za-z0-9_-]`, höchstens 128 Zeichen, ohne `__`
  (Segmenttrenner der Blob-Schlüssel). Felder wie `path`, `patch`, `op`, `$set`,
  `entities`, `automation`, `root` gibt es nicht.
* **64 KiB**, gemessen am bereinigten Befehl.
* Der **Idempotenz-Schlüssel kommt aus der Kopfzeile**, nie aus dem Körper.

Die Fachverben sind dieselben wie in der C1-Matrix (ohne das Leseverb).
`COMMAND_VERBS` nennt für jedes zwei Dinge getrennt:

* **resource** — worauf das Verb wirkt; daraus folgt die Datenkategorie der
  Rechteprüfung. `creates` = wird angelegt, `fromJob` = der Lauf aus `jobId`,
  `ensure` = darf anlegen, wenn er fehlt.
* **anchor** — woran die Bindung hängt (Mandant, Eigentum, Auftrag, Zuweisung);
  `self` = die Ressource selbst.

Die Nutzinhalte sind mit dem Kernvertrag abgeglichen: `lead.schedule` verlangt
Gegenpartei, nächste Handlung und Belege (Nachfasszeitpunkt optional),
`document.register` Anhang, SHA-256-Inhaltsabdruck und Herkunft, `worker.assign`
Ausführer, Quellversion und die erlaubten Kontext-Ids, `worker.return` die
Quellversion. Fehlt eines dieser Felder, wird **nichts erfunden** — der Befehl
wird abgewiesen.

## 3. Die Kette (Befehlsweg)

1. **Konfiguration** — fehlt sie, 503 `auth_not_configured`, **bevor** der Kern
   gelesen wird.
2. **TLS** — sonst 403.
3. **Körperform** — Content-Type, 64 KiB, striktes JSON, Identitätsfelder
   abgewiesen, Umschlag geprüft, `Idempotency-Key` vorhanden.
4. **Ausweis** — an der Form erkannt (Job-Token / Firebase-ID-Token /
   Dienst-Zugangsdatum), kein Durchprobieren. Ein Job-Token gilt nur für die
   Route (audience) und den Lauf (`jobId` aus dem Umschlag).
5. **Herkunft** — Origin-Allowlist; Browser originlos abgewiesen,
   Server-zu-Server originlos erlaubt.
6. **Ratenbegrenzung** — atomar und instanzübergreifend, pro geprüftem
   Principal; 429 mit `Retry-After`. Ein untauglicher Zähler ist 503, kein
   Freibrief.
7. **Adapter** — fehlender Fach-, Idempotenz- oder Speicheradapter: 503.
8. **Daten** — erst jetzt. Ein ungeprüftes Token sieht den Kern nie (Tests
   prüfen den Lesezähler des Speichers).

Beim Schreiben:

* `prepareIdempotentCommand(...)` **einmal, ausserhalb** der CAS-Schleife.
* In **jedem** CAS-Versuch: vollständige Autorisierung gegen den gerade
  gelesenen Schnappschuss — Rolle, Art, Ausstellweg, Mandant, Eigentum,
  Auftragsbindung, **Lease** (für Job-Token) und `expectedEntityVersion`.
* `applyIdempotentCommand(...)` **innerhalb** von `mutateAppData`; der
  Fachreduzierer läuft darin, synchron, ohne Uhr, ohne Ids, ohne externe
  Wirkung.
* **Wiederholung:** Rechte werden erneut geprüft (ein Beleg im Ledger ersetzt
  keine Autorisierung — ein Test zeigt, dass eine Wiederholung nach Entzug des
  Rechts 403 bekommt). Die **einzige** Ausnahme betrifft die
  Versionsvorbedingung: bei einer erkannten Wiederholung wird
  `expectedEntityVersion` nicht erneut verlangt, weil der erste Anlauf die
  Version bereits erhöht hat. Ob es eine Wiederholung ist, wird am vorhandenen
  Beleg **gelesen**; geschrieben wird der Ledger allein vom Idempotenzmodul.

## 4. HTTP-Antworten

| Status | Wann |
| --- | --- |
| 200 | erledigt (`applied: true`) oder Trockenlauf (`applied: false`, `dryRun: true`) oder Wiederholung (`replayed: true`) |
| 400 | Umschlag, Feld, Idempotenz-Schlüssel, Seitengrösse |
| 401 | fehlender/falscher Ausweis |
| 403 | Rolle, Mandant, Eigentum, Auftrag, Lease, Origin, TLS |
| 409 | `stale_entity_version`, `idempotency_conflict`, `replay_too_old` |
| 413 | über 64 KiB |
| 415 | falscher Content-Type |
| 429 | Ratenbegrenzung, mit `Retry-After` |
| 503 | `api_writes_disabled` (Schreiben aus), `auth_not_configured`, fehlender Adapter, untauglicher Ratenzähler, CAS erschöpft (8 Konflikte), unklarer Schreibausgang, Kern nicht lesbar oder ohne brauchbare Revision, Vertragsbruch der Seite (`page_overfull`, `page_cursor_unusable`) |
| 500 | Vertragsbruch eines Adapters — Körper ohne Details |

Jede Antwort trägt `requestId`; erfolgreiche Antworten zusätzlich `serverNow`,
`dataRevision` und `entityVersions`. Absagen tragen nur feste Bezeichner, nie
einen Wert aus der Anfrage, nie einen Bibliothekstext.

## 5. Leseweg

* Nur **benannte Abfragen**, und nur die der jeweiligen Route:
  `quantus-context` → `run.context`, `lead.context`, `notes.recent`,
  `policy.current`; `quantus-read` → `lead.context`, `notes.recent`,
  `policy.current`, `run.queue`; `quantus-run-status` → `run.status`,
  `run.queue`.
* Das **Scope-Objekt wird frisch geladen** und autorisiert — auf der ersten wie
  auf jeder Folgeseite (`verifyCursor` ruft `authorize` erneut).
* **Sichtbare Felder sind eine Liste** (`VISIBLE_FIELDS`); alles andere wird
  abgeschnitten. Ein Test führt einen internen Mailtext im Prüfbestand mit und
  belegt, dass er nicht hinausgeht. Vor dem Ausliefern läuft zusätzlich die
  Geheimnissuche aus C1.
* Antwort: `items`, `count`, `hasMore`, `complete`, `pageStatus`, `cursor`,
  `entityVersions`, `dataRevision`, `serverNow`, `requestId`. Die
  `dataRevision` ist eine Zahl (0 eingeschlossen) und wird unverändert aus dem
  Kern übernommen; ein Bestand ohne brauchbare Revision ist 503, nicht 0.
* **Abgebrochene oder gedeckelte Seiten sind nie vollständig** und tragen
  keinen Folgecursor.
* Beim Lesen wird **nicht geschrieben** — keine Migration, kein Startup-Write.
  Der Lesepfad hat keinen Schreibport.

## 6. Ratenzähler

`createCasRateLimiter` zählt über Compare-and-Swap auf einem gemeinsamen Knoten
(`quantusV3RateLimits/<sha256-Kürzel>/<Fenster>`), meldet sich als
`atomic: true`/`scope: "shared"` und erfüllt damit den C1-Vertrag. Bei
Konflikten wird neu gelesen und erneut versucht; bei unklarem Ausgang gibt es
einen Fehler statt eines stillen Erfolgs. Der Knotenname enthält weder
Principal noch Mandant im Klartext. Das ist ein **Schutzzähler**, keine
Fachdatenbank, und liegt nicht im Kerndatensatz.

Grenzwerte je Rolle und Minute: `user` 60, `lead_agent` 120, Spezialisten je 60,
`scheduler` 120, `backend_checker` 120 — **je Verb und als Gesamtbudget des
Principals**; beide Zähler müssen halten.

Der Stand im Knoten wird streng gelesen: nicht negative sichere Ganzzahl,
passendes Zeitfenster, Overflow geprüft. Ein kaputter Stand wird nicht auf 0
„repariert", und ohne echten ETag (kein `null`, `""` oder `*`) findet kein
Schreibvorgang statt.

## 7. Konfiguration (zusätzlich zu C1)

| Variable | Standard | Wirkung |
| --- | --- | --- |
| `QUANTUS_V3_API_WRITES` | *(leer)* = aus | Nur `enabled` erlaubt Schreiben — **und nur zusammen mit** `QUANTUS_V3_MODE=enforce` |

Ohne beide Schalter läuft jeder Befehl vollständig durch alle Prüfungen und
antwortet `applied: false, dryRun: true`. Runner- und Provider-Schalter gehören
zu anderen Paketen und bleiben ebenfalls aus.

## 8. Adapter, die C2 **nicht** mitbringt

| Port | Erwartet | Fehlt er |
| --- | --- | --- |
| `domain.loadObject/applyVerb/listPage` | Fachadapter (eigenes Paket) | 503 `domain_adapter_not_available` |
| `domain.resolveTarget` | Ressource und Anker aus dem autoritativen Bestand | 503 `domain_adapter_not_available` |
| `domain.assertActiveBinding` | aktive Leitungs-Lease bzw. Auftragszuweisung (Paket E1) | 503 `domain_adapter_not_available` |
| `idempotency.prepare/apply` | `netlify/lib/quantus-v3-idempotency.mjs` des Integrationsstandes | 503 `idempotency_adapter_not_available` |
| `store.readSnapshot/mutate` | `readAppDataDocument` / `mutateAppData` | 503 `store_adapter_not_available` |
| Zugriffstoken für `accounts:lookup` | eigener Anbieter | 503 `user_lookup_missing` — ein ID-Token ohne Widerrufsprüfung wird nicht akzeptiert |

C2 bringt **keine** zweite Ledgerlogik und **keine** Fachlogik mit. Das
Idempotenzmodul liegt nicht in diesem Zweig; die Tests laden deshalb den
geprüften Integrationsstand **kontrolliert** aus dem Git-Objektspeicher
(`git show 40a448c:netlify/lib/quantus-v3-idempotency.mjs` in ein temporäres
Verzeichnis — kein Kopieren ins Paket) und fahren die Kette dagegen. Welche
Fassung lief, schreibt der Testlauf: `# Idempotenz-Fassung im Lauf: git:40a448c`.
Ist der Stand nicht erreichbar, tritt eine vertragstreue Nachbildung an seine
Stelle — und der Lauf sagt ausdrücklich, dass dann **kein Integrationsnachweis**
vorliegt.

## 9. Tests

`npm run test:quantus-v3-c2` (Teil von `npm test`): 64 Fälle an der **echten**
Kette — echt signierte Token, ein Speicher mit CAS-Verhalten (Konflikte,
Erschöpfung, unklarer Ausgang), Cursor über mehrere Seiten, Ratenzähler mit
eingespeistem Verkehr, und die vier Routen als echte `Request`/`Response`.
Kein Netz, kein Anbieteraufruf, keine Produktivkonfiguration.

## 10. Offene Punkte

1. **Fachadapter fehlt** — ohne ihn ist keine Wirkung nachweisbar. Ressource
   und Anker je Verb sind hier gesetzt und dokumentiert; die Domänenbedingungen
   (erlaubte Übergänge, Wartelogik, Beleganforderungen) gehören zu B, die
   aktive Bindung zu E1. Beide sind hier nur als Port vorhanden.
2. **Idempotenzmodul** liegt nicht im Zweig; die Tests laden den Stand
   `40a448c` kontrolliert und fahren die Kette dagegen (Commit und Wiederholung
   ergeben genau einen Effekt).
3. **Widerrufsprüfung** braucht einen Zugriffstoken-Anbieter; solange er fehlt,
   sind Nutzer-Token nicht verifizierbar (503).
4. **Ratenzähler** ist gegen eingespeisten Verkehr geprüft, nicht gegen echtes
   RTDB — Latenz und Kontingent sind offen.
5. **MCP-Werkzeugadapter** sind nicht Teil von C2 und werden nicht als
   installierbar erklärt.
6. **Kein Deploy, keine Produktivkonfiguration, kein Providerzugriff.**
