# Tagesbriefing v3 — serverseitiger Datenkern (Paket 1)

Stand: 19.09.2026. Dieses Paket ist **bewusst nicht der produktive Cutover**.
Es liefert den gemeinsamen Datenkern unter `netlify/lib/assistant-*.mjs`, die
Migration, die reine Ampel- und Abschlusslogik und einen ausfuehrbaren Test.
Kein Deployment, keine Provider-Aufrufe, keine Aenderung an Scheduler,
Firebase-Regeln, Clients oder an den bestehenden CAS-Wegen
(`firebase-admin.mjs`, `date-invite*`, `flowertech-*`).

## Dateien

| Datei | Inhalt |
|---|---|
| `netlify/lib/assistant-zeit.mjs` | Europe/Zurich: Assistententag (04:00-Regel), Slots, Wandzeit → ms mit Sommer-/Winterzeit, Slot-Schluessel |
| `netlify/lib/assistant-schema.mjs` | Schema-Konstanten, Altstatus-Mapping, `effektiverZustand`, Policy-Pruefung, Schutzfelder, Command-Schemas |
| `netlify/lib/assistant-migration.mjs` | `parseCoreDocument`, `migrateCore`, `requireCore` |
| `netlify/lib/assistant-buchhaltung.mjs` | reine Mutationen: Lauf, Notizen, Quittungen, Quellen, itemRefs, Carry-over, Fortschritt/Deferrals, Warten, Zustandswechsel, Eingang, Fragen/Antworten, Dokumente, Jobs, Lease |
| `netlify/lib/assistant-ampel.mjs` | `dailyAssistantTrafficLight`, `isEvaluationCurrent`, `bestandsFingerabdruck` |
| `netlify/lib/assistant-abschluss.mjs` | `pruefeAbschluss`, `closeRun`, `pruefeWiderspruch`, `invalidateClosure` |
| `netlify/lib/assistant-core.mjs` | Einstieg: Re-Exports, `applyCommand` (Dispatcher mit Idempotenz), `serializeCore` |
| `tests/tagesbriefing-v3-kern.test.mjs` | 17 Tests, `npm run test:tagesbriefing` (laeuft auch in `npm test`) |

Alles sind reine Funktionen: `f(data, payload, ctx) → { ok, data, … }`.
`data` ist der geparste Vollbestand aus `appStore/app-data_json`; das Ergebnis
ist eine tiefe Kopie, die Eingabe bleibt unveraendert. `ctx.now` (ms) und alle
Kennungen kommen von aussen — im Kern gibt es kein `Date.now()`, keine UUID,
keinen Netzzugriff.

## Grundsatz: keine zweite Statusdatenbank

Die Arbeit lebt weiter in `entities.chatgptLeads`, `entities.chatgptTasks`,
`entities.tasks` und `entities.projects` (Fristen). Der Kern schreibt an diese
Objekte genau zwei abgeleitete Felder:

```
operationalState        doing | waiting_external | waiting_user | delegated | review | done | cancelled | null
operationalStateSource  { legacyField, legacyValue, mappedAt, note }
operationalStateUnmapped  true   (nur bei unbekanntem Altstatus)
```

Der Altstatus (`status` / `state`) bleibt das Feld, das die Clients schreiben.
`effektiverZustand()` entscheidet so:

1. Hat sich der Altstatus seit dem letzten Mapping veraendert (Client hat
   weitergearbeitet), gilt die Ableitung aus dem Altstatus.
2. Sonst gilt das gespeicherte `operationalState` — **ausser** es behauptet
   `done`/`cancelled`, ohne dass der Altstatus den Abschluss bestaetigt. Das
   ist dann `inconsistent` und in der Ampel `STATE_CLAIM_INCONSISTENT`.

### Mapping der Altstatus

| Quelle | Altwert | operationalState |
|---|---|---|
| chatgptLead | neu, verstanden, in_arbeit | doing |
| chatgptLead | in_arbeit/wartet + assignee cowork + handoverAt, kein returnedAt | delegated |
| chatgptLead | assignee cowork + returnedAt (nicht abgeschlossen) | review |
| chatgptLead | wartet | waiting_user (ohne Evidenz → nicht gruen) |
| chatgptLead | abgeschlossen | done; mit closedBy laurin + obsoleteReason: cancelled |
| chatgptTask | offen | doing |
| chatgptTask | wartet | waiting_user (ohne Evidenz → nicht gruen) |
| chatgptTask | erledigt | done |
| task | todo, doing | doing |
| task | waiting | waiting_external (ohne Evidenz → nicht gruen) |
| task | review | review |
| task | done | done |
| alle | unbekannt | null + `operationalStateUnmapped`, im Migrationsbericht, Ampel `UNKNOWN_LEGACY_STATE` |

Rollen: KI-Leads `accountable=chatgpt`, `executor` = openai (assignee chatgpt)
oder claude (assignee cowork). ChatGPT-Aufgaben `chatgpt/openai`. Regulaere
Aufgaben `user/user`; ihr `assignee`-Feld wird nicht angefasst. Projekte werden
nicht in `operationalState` uebersetzt; sie tragen nur faellige, nicht erledigte
`deadlines` bei (`PROJECT_DEADLINE_DUE`).

## Schema

### `dailyBriefing.assistantRuns[YYYY-MM-DD]`

```
id, date, timezone ("Europe/Zurich"), revision, policyVersion,
phase            created | active | final | exception_open
slotReceipts     { briefing04, process09, continue14, close23 }  je null | { receiptId, slotKey, at, note }
startNoteId, finalNoteId
closureRevision, closureCutoff, finalAt, invalidatedAt, archiveRef (null, unbenutzt)
itemRefs         [{ sourceType, sourceId, includedAt, carriedFrom? }]      — KEINE Status-/Evidenz-/nextAction-Felder
sourceChecks     { sourceId: { cursor, checkedAt, outcome, detail } }
closureOutcomes  { "sourceType:sourceId": zustandsname }   — gesetzt beim Abschluss, Vergleichsbasis fuer Widersprueche
finalEvaluation  { coverage, operations, evaluatedRevision, evaluatedFingerprint, evaluatedAt }
corrections      [{ id, at, revision, reason, contradiction, invalidatedFinalNoteId, invalidatedClosureRevision, invalidatedFinalAt, correctionNoteId }]   — append-only
createdAt, updatedAt
```

### `automation`

```
schemaVersion (3), dataRevision, updatedAt
intakeById       { id: { id, text, channel, receivedAt, registeredAt, status open|done|cancelled, linkedTo, handledAt, origin, reason } }
questionsById    { id: { id, sourceType, sourceId, text, askedAt, status open|answered, answerId, answeredAt, runDate } }
answersById      { id: { id, questionId, text, answeredAt, consumedAt, consumedBy } }   — unveraenderlich, einmal konsumierbar
documentsById    { id: { id, name, storageRef, mime, size, uploadedAt, status open|done|cancelled, handledAt, parse: { outcome pending|parsed|unreadable|failed, checkedAt, error, textRef, attempts }, linkedTo } }
jobsById         { id: { id, kind, sourceType, sourceId, executor, state queued|running|returned|failed|cancelled, createdAt, returnedAt, reviewedAt, resultRef, error, mode } }
outboxById       {}   — angelegt, in diesem Paket unbenutzt (Provider-Paket)
idempotencyByKey { commandId: { type, at, revision, result } }
activeLease      null | { holder, acquiredAt, renewedAt, expiresAt, revision }
sourceCursors    { sourceId: { cursor, checkedAt, outcome } }
policyRef        null   — wird vom API-Paket gesetzt
progressById     { "sourceType:sourceId": { fingerprint, dueMarker, deferrals, lastProgressAt, observedAt, history[≤20] } }   — Zusatz zum Zielmodell
waitingById      { "sourceType:sourceId": { state, counterparty, waitingSince, nextAction, followUpAt, evidence: { kind, ref }, setAt } }   — Zusatz zum Zielmodell
migration        { schemaVersion, migratedAt, unknownStates[], conflicts[] }
```

`progressById` und `waitingById` sind zwei Bereiche **zusaetzlich** zum
Zielmodell: Deferral-Zaehler und Warte-Evidenz muessen serverseitig liegen und
duerfen nicht an den itemRefs oder als Freitext am Element haengen.

Die Finalnotiz, Startnotiz und Korrekturnotiz sind normale Eintraege in
`entities.notes` mit `assistantNote: { kind: assistantStart|assistantFinal|assistantCorrection, runDate }`
und Tags `tagesbriefing` + `start|final|korrektur`.

### Policy (`POLICY_SCHEMA = "tagesbriefing-policy/3"`)

```
schema, version, tenant, timezone ("Europe/Zurich"),
sourceMaxAgeMinutes (15), evaluationTtlMinutes, deferralLimit (3), maxWaitDays,
requiredSources [{ id, kind }]  (leer nur mit noExternalSources: true),
closure { earliestLocalTime "23:00", requiredReceipts ["process09","close23"] },
featureFlags { writes, runner, providers }  — je dry_run | live, Vorlage: alle dry_run
```

`POLICY_TEMPLATE` ist absichtlich **ungueltig** (keine Quellen), bis jemand die
Quellen ausdruecklich benennt. Ohne gueltige Policy: Ampel rot
(`POLICY_INCOMPLETE`), kein Kommando.

## Ampel

`dailyAssistantTrafficLight(run, data, now, policy)` prueft immer den ganzen
Bestand — nicht die itemRefs, nicht `run.overallGreen` (wird nur als
`AGENT_CLAIM_IGNORED` sichtbar gemacht). Ergebnis:

```
{ coverage, operations, overall, reasons: [{ axis, code, sourceType, sourceId, detail, severity }],
  counted, runDate, runPhase, evaluatedRevision, evaluatedFingerprint, evaluatedAt, validUntil, policyVersion }
```

Reason-Codes (Auswahl): `ITEM_OPEN`, `TASK_DUE_OPEN`, `ITEM_NOT_IN_RUN`,
`INTAKE_UNCLARIFIED`, `LEAD_UNASSIGNED`, `WAITING_UNVERIFIED`,
`WAITING_INCOMPLETE`, `FOLLOWUP_DUE`, `DEFERRAL_LIMIT`, `QUESTION_OPEN`,
`ANSWER_UNCONSUMED`, `REVIEW_PENDING`, `JOB_RETURN_UNREVIEWED`, `JOB_FAILED`,
`JOB_PENDING` (gelb), `DOCUMENT_UNPROCESSED`, `DOCUMENT_UNREADABLE`,
`DOCUMENT_UNHANDLED`, `PROJECT_DEADLINE_DUE`, `UNKNOWN_LEGACY_STATE`,
`STATE_CLAIM_INCONSISTENT` (Achse coverage) — `POLICY_INCOMPLETE`, `RUN_MISSING`,
`CORE_NOT_MIGRATED`, `SLOT_RECEIPT_MISSING`, `SOURCE_NOT_CHECKED`,
`SOURCE_STALE`, `SOURCE_AUTH_ERROR`, `SOURCE_BUDGET_EXCEEDED`,
`SOURCE_UNREACHABLE`, `SOURCE_PARTIAL` (gelb), `LEASE_EXPIRED` (gelb),
`RUN_EXCEPTION_OPEN`, `RUN_POLICY_MISMATCH`, `AGENT_CLAIM_IGNORED` (gelb)
(Achse operations).

`validUntil` = Minimum aus Policy-TTL, Ablauf der frischesten Quelle,
naechster Slotgrenze, naechstem `followUpAt` und naechster Frist.
`isEvaluationCurrent(evaluation, data, now)` verneint nach `validUntil`, bei
anderer `dataRevision` **oder** anderem Bestands-Fingerabdruck (der
Fingerabdruck erfasst Client-Aenderungen, die `dataRevision` nicht sieht).

Warten ist nur gruen mit Gegenpartei (nicht man selbst, nicht der eigene
Executor), `nextAction`, `followUpAt` in der Zukunft (≤ `maxWaitDays`) und
Evidenz `{ kind: mail|question|job|calendar|document|ticket|message|url, ref }`.
`waiting_user` verlangt Gegenpartei `user`, `waiting_external` verbietet sie,
`delegated` verlangt einen Executor.

Deferrals zaehlt nur `observeSource`: Fingerabdruck aus substanziellen Feldern
(Zustand, Lead-Schritte, handover/returned/closed, Task-Workflow/Massnahmen,
Warte-Evidenz); Frist = `followUpAt` bzw. `dueDate`. Frist nach hinten ohne
Fingerabdruck-Aenderung = Verschiebung. Titel, Kommentare, Zuweisung, Tags,
Retry-Zaehler sind nicht im Fingerabdruck.

## Abschluss

`closeRun(data, { date, finalNoteId }, { now, policy })`:

* Ortszeit ≥ `closure.earliestLocalTime` am Lauftag und < 04:00 des Folgetages
* alle `closure.requiredReceipts` vorhanden
* Ampel beide Achsen gruen (damit: Quellen ≤ 15 min alt, alle Aktionen
  abgeschlossen oder echtes Warten)
* atomar: `phase=final`, `finalAt`, `closureRevision`, `closureCutoff`,
  `finalNoteId`, `closureOutcomes`, `finalEvaluation`, genau eine Notiz
* Wiederholung (andere Notiz-Id, andere Zeit): No-op mit `already: true`,
  Bestand byteidentisch

`pruefeWiderspruch` liefert Elemente, die beim Abschluss abgeschlossen waren
und es nicht mehr sind (`contradictions`), sowie Eingang nach `closureCutoff`
(`newIntake`, `nextRunDate`). `invalidateClosure` akzeptiert nur echte
Widersprueche (`NOT_A_CONTRADICTION` sonst), setzt `exception_open`, haengt an
`corrections` an, legt eine Korrekturnotiz an und laesst die historische
Finalnotiz und `finalNoteId`/`finalAt`/`closureRevision` unveraendert.

## Kommandos

`applyCommand(data, { type, commandId, now, payload }, { policy })`. Nur die
Felder aus `COMMAND_SCHEMAS`; unbekannte Felder und Schutzfelder
(`finalAt`, `phase`, `closureRevision`, `closureCutoff`, `invalidatedAt`,
`overallGreen`, `userApproval`, `operationalState`, `consumedAt`, `deferrals`,
`dataRevision`, `revision`, `validUntil`, `coverage`, `operations` …) in
beliebiger Tiefe → `COMMAND_REJECTED`. `commandId` wird mit Ergebnis in
`idempotencyByKey` abgelegt; Wiederholung liefert `replayed: true` ohne
Schreiben; dieselbe Id mit anderem Typ → `COMMAND_ID_REUSED`. Fachliche
No-ops (`noop: true`) veraendern den Bestand nicht.

`transitionState → done` verlangt den bestaetigenden Altstatus
(`DONE_REQUIRES_LEGACY_CLOSE`) und keine offene Frage (`QUESTION_OPEN`).
Wartezustaende nur ueber `setWaiting`. `recordJobReturn(returned)` setzt die
Quelle auf `review`, nie `done`. `recordDocumentParse(unreadable|failed)` laesst
das Dokument offen; `parsed` ebenfalls, bis `transitionState → done`.

## Offene Abhaengigkeiten (nicht in diesem Paket)

* **Auth / command-CAS:** Es gibt noch keinen Schreibpfad. Vorgesehen:
  `readAppDataDocument` → `parseCoreDocument` → `migrateCore`/`applyCommand`
  → `writeAppDataText(key, serializeCore(data), { ifMatch: etag })`, bei 412
  wiederholen mit denselben Kommandos (Ids und `now` sind Eingaben). Die
  Zuordnung von Aufrufern (Agent, Handy, Tablet) zu erlaubten Kommandos und die
  Token-Pruefung fehlen.
* **API-Paket:** `quantus-context/read/ingest/run-status` sind nicht gebaut.
  `intakeById`/`registerIntake` ist die vorgesehene Landestelle fuer `ingest`.
* **Writer-Inventar / All-Writer-Migration** in ai-sync, quantus-tablet-version,
  mobile-management: nicht Teil dieses Pakets; die Clients schreiben weiter nur
  den Altstatus, der Kern leitet ab.
* **Runtime:** kein Scheduler, keine Slot-Ausfuehrung, kein Laeufer, keine
  Cost-Reservations, keine Provider-Adapter. `featureFlags` stehen auf
  `dry_run`; `outboxById` ist leer.
* **Live-UI:** nichts. `isEvaluationCurrent` ist die Regel, nach der eine
  Oberflaeche eine gespeicherte Ampel zeigen darf.
* **Probebetrieb (14 Tage) und T01–T40 vollstaendig:** nicht begonnen.
* **Bekannte Luecken im Kern:** `policyRef` wird nicht gesetzt; `archiveRef`
  ist unbenutzt.
* **Client-Merge — Cutover-Blocker (CLAUDE.md, Fallstrick 2):** `mergeData()`
  in `public/index.html` fuehrt `dailyBriefing` als eigenen Zweig und kopiert
  darin nur die bekannten Felder (selectedProjects, routines, dailyLog,
  timeBlocks …). **`dailyBriefing.assistantRuns` wird von diesem Zweig nicht
  uebernommen.** Ein Rechner, dessen lokaler Stand aelter ist als ein
  Server-Schreibvorgang des Kerns, wuerde beim naechsten Pull-Merge-Push die
  Laeufe vom Server loeschen. `automation` faellt dagegen in den Auffangzweig
  (`unionMap`): Karten werden vereinigt, aber `dataRevision` und andere
  Zahlen/Schalter bleiben lokal — ein Client koennte eine alte Revision
  zurueckschreiben. Bevor irgendein Client wieder schreibt, braucht
  `mergeData` einen Zweig fuer `assistantRuns` (Karte nach Datum, neuere
  `updatedAt` gewinnt, `corrections` append-only vereinigen) und fuer
  `automation` (Server-Revision gewinnt, `answersById` nie ueberschreiben).
  In diesem Paket ist das absichtlich nicht angefasst (keine
  Client-Aenderungen); solange nur der Server schreibt und die Clients den
  Serverstand als Ganzes uebernehmen, tritt es nicht auf.

## Testabdeckung (ehrlich)

`tests/tagesbriefing-v3-kern.test.mjs`, 17 Tests, `node --test`, ohne Netz:

| Abnahme | geprueft |
|---|---|
| fehlender/kaputter Kern = Fehler | ja (5 Fehlerarten) |
| Migration idempotent, Fremdes/_deleteLog erhalten, vorhandene Struktur wiederverwendet | ja |
| Altstatus-Mapping inkl. unbekannt sichtbar, spaetere Client-Aenderung gewinnt | ja |
| Policy fehlt/unvollstaendig → nie gruen, Vorlage ungueltig, Flags dry_run | ja |
| ausgelassener Lead / ungelesener Lead / nicht geprüfte Quelle / stale / auth / budget / unreachable / Projektfrist | ja |
| validUntil, isEvaluationCurrent (Ablauf, Revision, Fingerabdruck) | ja |
| unvollstaendiges Warten (10 Varianten), Selbst-Warten, followUpAt-Ablauf, itemRefs ohne Statusfelder | ja |
| drei Deferrals trotz Titel/Kommentar/Zuweisung/Retry → rot; Fortschritt setzt zurueck; auch fuer followUpAt | ja |
| Agentenbehauptung (overallGreen, operationalState:done, Schutzfelder in Payloads, unbekanntes Kommando) | ja |
| Abschluss: zu frueh, ohne 09, ohne 23, offener Lead, stale Quelle, Tag vorbei; Erfolg atomar; Wiederholung No-op; commandId-Replay | ja |
| Widerspruch: neuer Eingang → naechster Lauf; Reopen → exception_open, append-only, Finalnotiz byteidentisch | ja |
| DST: 28./29.03. und 24./25.10.2026, 23h/25h-Tage, doppelte/fehlende Stunde, 04:00-Regel, Slot-Schluessel, SLOT_NOT_STARTED | ja |
| Fragen unveraenderlich, Antworten einmal konsumierbar, offene Frage sperrt done | ja |
| unlesbares Dokument offen, parsed ≠ behandelt, Eingang klaeren | ja |
| Spezialistenrueckgabe → review; failed sichtbar; Executor-Whitelist | ja |
| Carry-over ohne neue Aufgaben | ja |
| Lease, Serialisierung round-trip | ja |

Nicht geprueft (weil nicht gebaut): CAS-Konflikt und 412-Wiederholung, Auth,
HTTP-APIs, Scheduler-Zeitpunkte in Produktion, Provider, Client-Merge von
`automation`, Verhalten der bestehenden Oberflaechen mit den neuen Feldern.
