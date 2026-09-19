# Tagesbriefing v3 — serverseitiger Datenkern (Paket B)

Stand: 19.09.2026, zweite Fassung nach dem Review von 590dc78 (elf
reproduzierte Luecken, alle behoben, je mit adversarialem Regressionstest
R1–R11). Dieses Paket ist **bewusst nicht der produktive Cutover**. Kein
Deployment, keine Provider-Aufrufe, keine Aenderung an Scheduler,
Firebase-Regeln, Clients, CAS-Wegen (`firebase-admin.mjs`, `date-invite*`,
`flowertech-*`) oder am Idempotenz-Umschlag (`quantus-v3-idempotency.mjs`).

## Dateien

| Datei | Inhalt |
|---|---|
| `netlify/lib/assistant-zeit.mjs` | Europe/Zurich: Assistententag (04:00-Regel), Slots, Wandzeit → ms mit Sommer-/Winterzeit, Slot-Schluessel |
| `netlify/lib/assistant-schema.mjs` | Zustandsmodell mit Uebergaengen und Versionen, einmaliges Altstatus-Mapping, `effektiverZustand`, Policy mit festen Grenzen, Schutzfelder, Command-Schemas mit erlaubten Aufrufern, browserfaehiger Fingerabdruck |
| `netlify/lib/assistant-migration.mjs` | `parseCoreDocument`, `migrateCore`, `requireCore` (streng) |
| `netlify/lib/assistant-buchhaltung.mjs` | reine Mutationen: Lauf, Notizen, Quittungen, Quellen, itemRefs, Carry-over, Fortschritt/Deferrals, Belege, Warten, Zustandswechsel, Eingang, Fragen/Antworten, Dokumente, Jobs |
| `netlify/lib/assistant-ampel.mjs` | `dailyAssistantTrafficLight`, `isEvaluationCurrent`, `bestandsFingerabdruck` |
| `netlify/lib/assistant-abschluss.mjs` | `verpflichtungsmenge`, `pruefeAbschluss`, `closeRun`, `pruefeWiderspruch`, `invalidateClosure` |
| `netlify/lib/assistant-core.mjs` | `applyCommand` (Domain-Aktion), `commandReducer` (Adapter fuer `applyIdempotentCommand`), `serializeCore` |
| `tests/tagesbriefing-v3-kern.test.mjs` | 17 Tests, `npm run test:tagesbriefing` (auch in `npm test`) |

Alle Module sind reines JavaScript **ohne `node:`-Importe** (der Test prueft
das) und damit direkt im Browser nutzbar. Form jeder Mutation:
`f(data, payload, ctx) → { ok, data, … }` mit tiefer Kopie; `ctx` traegt
`now` (ms), `policy`, `actor`. Kein `Date.now()`, keine UUID, kein Netz.

## Grundsatz: operationalState ist fuehrend, keine zweite Statusdatenbank

Die Arbeit lebt in `entities.chatgptLeads`, `entities.chatgptTasks`,
`entities.tasks` (Projekte tragen nur Fristen bei). Der Kern haelt an diesen
Objekten:

```
operationalState         doing | waiting_external | waiting_user | delegated | review | done | cancelled | null
operationalStateVersion  ganzzahlig ab 1, +1 je Kommando (erwartete Version ist Pflicht)
operationalRoles         { accountable: chatgpt|user, executor: openai|claude|gemini|user|external|null }
operationalStateSource   { model, legacyField, legacyValue, mappedAt, changedAt?, note, closure? }
operationalStateUnmapped "unknown" | "ambiguous"   (nur bei Migrationskonflikt)
```

**Nach der Migration ist `operationalState` fuehrend.** Der Altstatus
(`status`/`state`) bleibt das Feld der Clients und wird in diesem Paket nicht
zurueckgeschrieben; er ist eine lesbare Ableitung (`legacyFuer`). Aendert ein
Client ihn spaeter, aendert das den Serverzustand **nicht** — es ist Drift,
sichtbar in `effektiverZustand().drift` und in der Ampel als `LEGACY_DRIFT`
(rot). Ein Altstatus „abgeschlossen“ kann kein `done` vortaeuschen (R1).

Ein abgeschlossener Zustand ist nur belegt, wenn er aus der Migration stammt
(Altstatus war damals abgeschlossen) oder `operationalStateSource.closure`
den Abschlussbeleg des Kommandos traegt. Ein direkt hingeschriebenes `done`
ist `STATE_CLAIM_UNPROVEN` (rot).

### Einmaliges Mapping (nur in `migrateCore`, R2)

| Quelle | Altwert | Ergebnis |
|---|---|---|
| chatgptLead | neu, verstanden, in_arbeit | doing |
| chatgptLead | assignee cowork + handoverAt ohne returnedAt | delegated (Altbestand ohne Job-Beleg → in der Ampel `WAITING_UNVERIFIED`, bis setWaiting mit Beleg) |
| chatgptLead | assignee cowork + returnedAt | review |
| chatgptLead | abgeschlossen | done; mit closedBy laurin + obsoleteReason: cancelled |
| chatgptLead | **wartet** | **null, `ambiguous`** — Migrationskonflikt, nicht geraten |
| chatgptTask | offen / erledigt / **wartet** | doing / done / **null, `ambiguous`** |
| task | todo, doing / review / done / **waiting** | doing / review / done / **null, `ambiguous`** |
| alle | unbekannt | null, `unknown` |

Konflikte stehen in `automation.migration.conflicts` (kind, sourceType,
sourceId, legacyValue) und in der Ampel als `AMBIGUOUS_LEGACY_STATE` /
`UNKNOWN_LEGACY_STATE` (rot), bis ein Kommando den Zustand setzt
(`transitionState → doing` mit Grund, `cancelled` mit Grund, oder
`setWaiting` mit Beleg). Ein Objekt mit `operationalStateSource` wird von
keiner spaeteren Migration mehr aus seinen Altfeldern abgeleitet. Rollen
werden einmal explizit gespeichert; `assignee` regulaerer Aufgaben bleibt
unangetastet.

### Uebergaenge (`TRANSITIONS`)

```
doing            → review | done | cancelled
waiting_*        → doing | review | cancelled      (betreten nur ueber setWaiting)
delegated        → doing | review | cancelled      (betreten nur ueber setWaiting mit Job)
review           → doing | done | cancelled
done | cancelled → doing   (nur mit Grund: Wiedereroeffnung)
```

`transitionState` verlangt `expectedVersion`. `done` verlangt zusaetzlich:
keine offene Frage, kein laufender Job, keine ungepruefte Rueckgabe, fuer
KI-Leads den vollstaendigen Ablauf (Interpretation, Recherche, Plan,
Ausfuehrung, Ergebnis, Raster, Zuweisung, Begruendung, Verknuepfung) und
einen **passenden Beleg**: registrierter Beleg, angenommenes Job-Ergebnis
oder konsumierte Nutzerantwort zu genau diesem Element. Eine Nutzeraufgabe
(`accountable=user`) schliesst der Nutzer selbst (actor `user`) ohne Beleg;
ein Agent braucht auch dafuer einen Beleg. `cancelled` eines Leads darf nur
der Nutzer („Lead ist hinfaellig, nur Laurin“).

## Belege, Warten, Fortschritt

**Belege** (`automation.evidenceById`) registriert **nur ein Adapter**
(`actor.kind === "adapter"`): `{ id, kind: mail|calendar|ticket|message|url|document, ref, sourceType, sourceId, origin: {adapter, ref}, observedAt ≤ now, fingerprint, registeredAt, verifiedBy }`.
Unveraenderlich. Ein Agent kann keinen Beleg erfinden; Text oder URL im
Payload sind keine Belege (R4).

**Warten** (`setWaiting`, nur Agent, mit `expectedVersion`) verlangt
Gegenpartei (nicht man selbst, nicht der eigene Executor/Accountable),
`nextAction`, `followUpAt` (nach `waitingSince`, ≤ `maxWaitDays`) und einen
Beleg, der im Bestand existiert **und zu diesem Element gehoert**:

```
waiting_external  evidence { kind:"evidence", evidenceId }   Gegenpartei ≠ user
waiting_user      evidence { kind:"question", questionId }   Gegenpartei = user, Frage offen
delegated         evidence { kind:"job", jobId }             Gegenpartei = job.executor, Job aktiv
```

Die Wartekarte (`automation.waitingById[sourceType:sourceId]`) wird in der
Ampel mit **derselben Funktion** geprueft wie beim Setzen
(`pruefeWarteKarte`): fehlt `waitingSince`, ist es in der Zukunft, fehlt
`nextAction`, wurde der Beleg getauscht — `WAITING_INCOMPLETE` rot (R5).
Eine harte Frist (Aufgabe faellig) verschwindet durch Warten nicht:
`HARD_DEADLINE_DUE` rot.

**Fortschritt** (`progressById`) zaehlt nur **serververifizierte
Ereignisse** mit unveraenderlicher Kennung: neue Belege, angenommene
Job-Ergebnisse, konsumierte Antworten, behandelte Dokumente — jeweils fuer
dieses Element (`verifizierteEreignisse`). Freitext in Interpretation,
Recherche, Plan, Ausfuehrung, Ergebnis, Titel, Kommentare, Zuweisung,
Gegenparteiwechsel, Retry-Zaehler oder eine Statusrundreise setzen den
Zaehler **nicht** zurueck (R3). Eine Verschiebung ist ein spaeteres
`followUpAt` bzw. `dueDate` ohne neues Ereignis; `setWaiting` zaehlt sie
**atomar**, `observeSource` fuer Client-Aenderungen (dueDate). Ab
`deferralLimit` (max. 3): `DEFERRAL_LIMIT` rot.

## Jobs, Dokumente, Fragen, Eingang

**Jobs** (`createJob`, Agent/System): `inputVersion` = aktuelle Version des
Elements, `contextRefs` (jeder Verweis muss existieren), `purpose`,
`executor`, `expiresAt` (≤ 7 Tage). Atomar dazu ein Ausgangseintrag
`outboxById["job:<id>"]` im `dry_run` — es wird nichts versandt. Ein
Ruecklauf (`recordJobReturn`, **nur Worker**) ist nur fuer `queued|running`
und vor `expiresAt` moeglich; abgebrochene, ersetzte, abgelaufene Jobs werden
abgewiesen. Er speichert nur `result {ref, hash, stale}` — **das Element
bleibt unveraendert** (R6). Erst `reviewJobResult` (Agent oder Nutzer) mit
`accepted` setzt das Element auf `review`; `stale` (Element inhaltlich
weiterentwickelt seit Eingangsversion; die Delegation selbst zaehlt nicht)
kann nicht angenommen werden. Ein Lead-Abschluss setzt nie automatisch
`reviewedAt`.

**Dokumente** (`registerDocument`, **nur Adapter**): bestaetigte
`attachmentId` (gueltiger `attachment-text__*`-Schluessel nach
`blob-key-policy`), `hash` (sha256 hex), `mime`, `size`, `origin
{channel, ref}`, `linkedTo` (muss existieren). `recordDocumentParse`
(Adapter) mit `parsed` verlangt `textRef` (gueltiger Attachment-Schluessel)
und `extractHash`; `unreadable|failed` laesst das Dokument offen.
`transitionState(document → done)` verlangt `parsed` **und** `results[]`
(existierende Elemente). Unlesbar, fremd oder unbelegt bleibt offen (R7).

**Fragen/Antworten**: Frage (Agent) unveraenderlich; Antwort **nur Nutzer**
(`actor.kind === "user"`), unveraenderlich, genau einmal konsumierbar; eine
offene Frage sperrt `done` und ist nie eine Freigabe.

**Eingang** (`registerIntake`, Nutzer/Adapter/System): offen sperrt
(`INTAKE_UNCLARIFIED`), geklaert nur mit Verknuepfung oder Grund.

## Schema

### `dailyBriefing.assistantRuns[YYYY-MM-DD]`

```
id, date, timezone, revision, policyVersion, phase (created|active|final|exception_open)
slotReceipts { briefing04, process09, continue14, close23 }  je null | { receiptId, slotKey, at, note }
startNoteId, finalNoteId, closureRevision, closureCutoff, finalAt, invalidatedAt, archiveRef (unbenutzt)
itemRefs [{ sourceType, sourceId, includedAt, carriedFrom? }]   — Arbeitsliste, KEINE Status-/Evidenzfelder
sourceChecks { sourceId: { cursor, checkedAt, outcome, detail, checkedBy } }
closureOutcomes { "typ:id": { state, version, evidence? } }   — die GESAMTE Verpflichtungsmenge beim Abschluss
finalEvaluation, corrections [] (append-only), createdAt, updatedAt
```

### `automation`

```
schemaVersion 3, dataRevision, updatedAt
intakeById, questionsById, answersById, documentsById, jobsById, outboxById, evidenceById
sourceCursors, policyRef (null, API-Paket), progressById, waitingById, migration
idempotencyByKey   gehoert dem Umschlag quantus-v3-idempotency.mjs — der Kern liest und schreibt es NIE
activeLease        gehoert Paket E1 (quantus-v3-runtime-state.mjs) — der Kern liest und schreibt es NIE
```

`requireCore` prueft alle Karten, Revisionszahlen und Laeufe; korrupte
Strukturen sind Fehler (`CORE_*`), nichts wird geleert oder als erledigt
gedeutet. `parseCoreDocument` lehnt `entities` als Array ab (R9). Unbekannte
Kartenzustaende sind in der Ampel `CARD_STATE_UNKNOWN` (rot), nie
uebersprungen.

Notizen (Start, Final, Korrektur) liegen im bestehenden Notizmodul
`entities.notes` in der Form, die `normalizeData()` erwartet, mit
`assistantNote { kind, runDate }` und Tags `tagesbriefing` + `start|final|korrektur`.

### Policy (`tagesbriefing-policy/3`) — feste Grenzen (R10)

```
sourceMaxAgeMinutes ≤ 15, evaluationTtlMinutes ≤ 15, deferralLimit ≤ 3, maxWaitDays ≤ 30
closure.earliestLocalTime ≥ "23:00" (gueltige HH:MM), closure.requiredReceipts ⊇ ["process09","close23"], nur echte Slotnamen
requiredSources: genau EINE Quelle kind "quantus-core" (Pflicht) + externe; noExternalSources:true nur ohne externe
featureFlags { writes, runner, providers } ∈ dry_run|live, Vorlage: alle dry_run
```

## Ampel

`dailyAssistantTrafficLight(run, data, now, policy)` prueft den ganzen
Bestand. Stufen: **gelb** = offen, aber nicht faellig (Lead/ChatGPT-Aufgabe
in Arbeit, laufender Job, Lead ohne Executor); **rot** = faellig, verletzt,
unbelegt, unbekannt, widerspruechlich. Nicht faellige Nutzeraufgaben sind
kein Befund (nur Grenze fuer `validUntil`). Nur **gruen** erlaubt den
Abschluss.

Reason-Codes coverage: `NOT_MIGRATED`, `UNKNOWN_LEGACY_STATE`,
`AMBIGUOUS_LEGACY_STATE`, `STATE_VERSION_INVALID`, `LEGACY_DRIFT`,
`STATE_CLAIM_UNPROVEN`, `ROLES_MISSING`, `LEAD_UNASSIGNED` (gelb),
`INTAKE_UNCLARIFIED`, `DEFERRAL_LIMIT`, `ITEM_NOT_IN_RUN`, `ITEM_OPEN`
(gelb), `ITEM_DUE_OPEN`, `REVIEW_PENDING` (gelb), `REVIEW_DUE`,
`QUESTION_OPEN`, `WAITING_UNVERIFIED`, `WAITING_STATE_MISMATCH`,
`WAITING_INCOMPLETE`, `WAITING_CARD_ORPHAN`, `HARD_DEADLINE_DUE`,
`FOLLOWUP_DUE`, `ANSWER_UNCONSUMED`, `JOB_PENDING` (gelb), `JOB_EXPIRED`,
`JOB_RETURN_UNREVIEWED`, `JOB_FAILED`, `DOCUMENT_UNPROCESSED`,
`DOCUMENT_UNREADABLE`, `DOCUMENT_UNHANDLED`, `PROJECT_DEADLINE_DUE`,
`CARD_STATE_UNKNOWN`, `ENTITY_CORRUPT`.
operations: `CORE_MISSING`, `CORE_NOT_MIGRATED`, `POLICY_INCOMPLETE`,
`RUN_MISSING`, `RUN_DATE_MISMATCH` (gelb), `RUN_START_NOTE_MISSING`,
`SLOT_RECEIPT_MISSING`, `SOURCE_NOT_CHECKED`, `SOURCE_CHECK_INVALID`,
`SOURCE_STALE`, `SOURCE_AUTH_ERROR`, `SOURCE_BUDGET_EXCEEDED`,
`SOURCE_UNREACHABLE`, `SOURCE_PARTIAL` (gelb), `RUN_POLICY_MISMATCH`,
`RUN_EXCEPTION_OPEN`, `AGENT_CLAIM_IGNORED` (gelb).

`validUntil` = Minimum aus TTL, Quellablauf, naechster Slotgrenze, naechstem
`followUpAt`, naechster Frist, Job-Ablauf. `isEvaluationCurrent` verneint
nach `validUntil`, bei anderer Revision oder anderem Bestands-Fingerabdruck.

## Abschluss (R8)

`closeRun`: ≥ 23:00 Ortszeit und < 04:00 des Folgetages, Startnotiz
vorhanden, Quittungen 09 und 23, Ampel beide Achsen gruen (damit alle Quellen
inkl. Quantus-Kern ≤ 15 min alt). Atomar: `phase=final`, `finalAt`,
`closureRevision`, `closureCutoff`, `finalNoteId`, `closureOutcomes` =
**vollstaendige Verpflichtungsmenge** (jedes Element mit Zustand, Version,
Beleg; jede Karte), genau eine Finalnotiz. Wiederholung: No-op.

`pruefeWiderspruch` vergleicht die gesamte Menge: abgeschlossen → offen,
belegtes Warten → doing / Karte weg / Beleg getauscht, erledigte Karte →
offen. Neuer Eingang nach `closureCutoff` ist kein Widerspruch
(`newIntake`, `nextRunDate`). `invalidateClosure` nur bei echtem
Widerspruch: `exception_open`, `corrections` append-only, Korrekturnotiz;
historische Finalnotiz und `finalNoteId/finalAt/closureRevision` bleiben.

## Kommandos, Aufrufer, Umschlag (R11)

`applyCommand(data, { type, commandId, now, payload }, { policy, actor })`.
Jedes Schema nennt Felder **und** erlaubte `actor.kind`
(agent|user|adapter|worker|system); ohne Aufrufer: `ACTOR_REJECTED`.
Schutzfelder (`finalAt`, `phase`, `operationalState*`, `consumedAt`,
`reviewedAt`, `handledAt`, `waitingSince`, `idempotencyByKey`,
`activeLease`, …) in beliebiger Tiefe: `COMMAND_REJECTED`.

**Der Kern fuehrt keine eigene Idempotenz und keine Lease.** `applyCommand`
sichert zu: Revision +0 oder +1 je Aktion (auch `carryOverRefs` ueber
mehrere Elemente), `idempotencyByKey` und `activeLease` byteidentisch.
`commandReducer({ policy, actor })` ist der synchrone Adapter fuer
`applyIdempotentCommand(current, prepared, reducer)` aus
`quantus-v3-idempotency.mjs`: `{ data, result }` ohne reservierte Felder,
Ablehnungen als Fehler mit `code`/`status`. Die Komposition mit dem echten
Umschlag (51cc666) wurde lokal geprueft (Replay, 409-Konflikt bei anderem
Inhalt, Domain-Ablehnung, No-op); der Umschlag liegt nicht auf diesem Branch,
der Test ueberspringt diesen Teil dann.

`acquireLease`/`releaseLease` sind **entfernt**; Lease/Fencing (120 s,
Erneuerung, Fence, staleOwner an jeder Leitungsaktion) ist Paket E1. Bis
dahin ist dieser Kern ohne Umschlag und ohne E1 nicht schreibend zu benutzen.

## Offene Abhaengigkeiten (nicht in diesem Paket)

* **Auth / command-CAS / API** (Paket C): kein HTTP, keine Principal-Zuordnung
  zu `actor`. Vorgesehen: `mutateAppData` → `parseCoreDocument` →
  `applyIdempotentCommand(…, commandReducer({policy, actor}))`.
* **Writer-Migration** in drei Apps (Paket D), **Runtime/Lease/Kosten**
  (E/E1), **Adapter/Extraktion/UI** (F), **Provider** (G), **T01–T40 und
  Probebetrieb** (H): offen. `featureFlags` dry_run, `outboxById` wird nicht
  ausgeliefert.
* **Client-Merge (Cutover-Blocker):** `mergeData()` in `public/index.html`
  kennt `dailyBriefing.assistantRuns` nicht (eigener dailyBriefing-Zweig) und
  vereinigt `automation` nur generisch (`dataRevision` bleibt lokal). Vor jedem
  Client-Schreiben braucht es dort Zweige; dieses Paket aendert keine Clients.
* `policyRef`, `archiveRef` unbenutzt; Altstatus-Rueckschreibung
  (`legacyFuer`) ist bewusst nicht aktiv.

## Testabdeckung (ehrlich)

`tests/tagesbriefing-v3-kern.test.mjs`, 17 Tests (`node --test`), ohne Netz:

| Punkt | Test |
|---|---|
| R9 kaputter Kern, `entities:[]`, korrupte Karten/Revisionen, unbekannte Kartenzustaende | ja |
| R2 wartet/waiting → ambiguous, unknown, Konfliktliste, explizite Rollen, nie erneut aus Altfeldern | ja |
| R1 Altstatus abgeschlossen → kein done, Drift rot, Version/Matrix/Beleg, fremder Beleg, unvollstaendiger Lead, cancel nur Nutzer, Nutzer schliesst Aufgabe, assignee erhalten | ja |
| R10 feste Policy-Grenzen (11 Faelle), Startnotiz, Kernquelle, 23:00, 09/23 | ja |
| R5 gelb vor Faelligkeit, rot faellig, harte Frist trotz Warten, Kartenmanipulation (9 Varianten), Karte weg, Leiche | ja |
| R4 erfundener/URL-Beleg abgewiesen, Beleg nur Adapter, fremder Beleg/Frage/Job | ja |
| R3 drei Verschiebungen atomar in setWaiting trotz Freitext/Kommentar/Titel/Retry/Gegenpartei/Statusrundreise; nur neuer Adapter-Beleg bzw. konsumierte Antwort setzt zurueck; dueDate via observe | ja |
| T16 Agentenbehauptung, unbelegtes done, Schutzfelder, Aufrufer | ja |
| R11 kein Ledger im Kern, kein stilles Replay, Revision genau einmal (carryOverRefs), Ledger/Lease byteidentisch, Reducer-Adapter, Lease-Kommandos entfernt; Umschlag-Komposition wenn vorhanden | ja |
| R6 cancelled→returned abgewiesen, abgelaufen, Ruecklauf aendert Lead nicht, Review setzt review, stale nicht annehmbar, Outbox atomar dry_run, failed sichtbar | ja |
| R7 Attachment-Id/Hash/Typ/Groesse/Herkunft/Verknuepfung, erfundener textRef, done ohne Ergebnisse, unlesbar offen | ja |
| T11 Antworten nur Nutzer, unveraenderlich, einmal konsumierbar, offene Frage sperrt | ja |
| R8 Verpflichtungsmenge inkl. Lead ohne itemRef, Widerspruch bei Reopen, Warten-Widersprueche, Historie byteidentisch, Notizen im Notizmodul | ja |
| T22 DST, T23 Carry-over, Serialisierung | ja |
| kein `node:`-Import in den Kernmodulen | ja |

Nicht geprueft (nicht gebaut): HTTP, Auth, CAS-412 im echten
`mutateAppData`, Lease/Fencing, Provider, Client-Merge, Oberflaechen.
