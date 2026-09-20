# Quantus v3 — Paket C3a: der kanonische Domaenen-Adapter

`netlify/lib/quantus-v3-domain-adapter.mjs` ist die einzige Bruecke zwischen
der C2-Kette (`quantus-v3-service.mjs`: Verben, Ressourcen, Anker, Rechte,
Versionen) und dem echten Kern aus Paket B (`assistant-core.mjs`). Er kennt
keinen Ersatzbestand: kein `entities.leads`, kein `entities.runs`. Alles, was
er liest oder schreibt, ist der migrierte Bestand in `appStore/app-data_json`.

Tests: `tests/quantus-v3-domain-adapter.test.mjs` (10 Tests). Sie laufen gegen
die ECHTE C2-Kette, den ECHTEN Idempotenz-Umschlag und die ECHTE E1-Laufzeit
des Integrationsstands `1d17cf7` sowie die C3b-Verdrahtung `a422670`, aus dem
Git-Objektspeicher in ein temporaeres Verzeichnis gespiegelt. Fehlt ein
Objekt, scheitert die Testdatei laut — es gibt keine Nachbildung. `jose`
(Abhaengigkeit des Integrationsstands) muss installiert sein; `package.json`
dieses Pakets bleibt unveraendert.

## 1. Der Fabrikvertrag (C3b, a422670)

```
createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now, ports? })
  → { resolveTarget, assertActiveBinding, applyVerb, loadObject, listPage }
```

`policyVersion`, `tenantId`, `mode` und `now` kommen aus der C3b-Verdrahtung
(`buildDomainAdapter`). Sie sind **nicht** die Fachkonfiguration: die Fabrik
braucht ausserdem die echte Tagesbriefing-Policy, den Eigentuemer des
Haushalts und die E1-Laufzeit. Diese Ports kommen

* ueber `ports` — `{ policy, ownerId, runtimeState, read }` — fuer Integration
  und Tests, oder
* aus der Umgebung: `QUANTUS_V3_TAGESBRIEFING_POLICY_JSON` (die B-Policy
  `tagesbriefing-policy/3` als JSON) und `QUANTUS_V3_OWNER_UID`; die
  E1-Laufzeit wird beim Laden optional aus `./quantus-v3-runtime-state.mjs`
  importiert.

Fehlt einer, wirft die Fabrik `{ code: "auth_not_configured", status: 503,
reason }` mit benanntem Grund (`domain_policy_missing:<VAR>`,
`domain_policy_unparsable`, `domain_policy_invalid:<B-Fehler>`,
`domain_policy_version_mismatch`, `domain_policy_tenant_mismatch`,
`domain_owner_missing:<VAR>`, `domain_runtime_state_port_missing`,
`domain_tenant_missing`, `domain_mode_invalid`, `domain_clock_missing`).
Die Policy-Version aus C2 muss der `version` der B-Policy entsprechen, der
Mandant ihrem `tenant`. `describeDomainPorts({ read, ports })` sagt, WAS
fehlt (Namen, nie Werte).

### Explizite Erweiterung fuer C3b (Vorschlag, nicht umgesetzt)

`buildDomainAdapter` faengt eine werfende Fabrik als `domain_factory_failed`
ab und verwirft den Grund. Damit die 503 im Betrieb konkret bleibt, sollte
C3b `err.reason` in `wiring.domainReason` uebernehmen (etwa
`domain_factory_failed:domain_policy_missing:QUANTUS_V3_TAGESBRIEFING_POLICY_JSON`).
Bis dahin liefert `describeDomainPorts` dieselbe Auskunft.

## 2. Abbildung des Bestands

| C2-Objektart | Kern | Kennung | Version |
|---|---|---|---|
| `lead` | `entities.chatgptLeads[id]` | Lead-Id | `operationalStateVersion` (B-Zustandsversion; `null` wenn unmigriert) |
| `task` | `entities.tasks[id]`, sonst `entities.chatgptTasks[id]` | Id | wie `lead` |
| `run`, `briefing`, `run_context` (Scope) | `dailyBriefing.assistantRuns[date]` | `run_<date>` (B: `run.id`) | `run.revision` |
| `run_status` | derselbe Lauf | `status_<date>` | `run.revision` |
| `intake`, `question`, `briefing_answer`, `document`, `assignment` | `automation.intakeById/questionsById/answersById/documentsById/jobsById` | Karten-Id | Kartenversion (Projektion des Inhalts, 48-Bit-Ganzzahl aus dem Fingerabdruck — jede Aenderung aendert sie, kein erfundener Zaehler) |
| `worker_result` | der Auftrag mit `result.ref === id` (genau einer) | `result.ref` | Kartenversion des Auftrags |
| `note` | `chatgptLeads[*].comments[]` | Kommentar-Id | Kartenversion |
| `policy` | die serverseitige B-Policy | `policy_<version>` | 1 |

Jedes Objekt traegt `tenant` und `ownerId` aus der Serverkonfiguration (nie
aus der Anfrage) und `jobId` = der Lauf, in dem es gefuehrt wird (Quelle:
juengster Lauf mit passendem `itemRef`; Auftrag: Lauf des Assistententags
seiner Erstellung; Frage/Antwort: `runDate`). Ueber `jobId` bindet C1 den
Leitungsagenten (`assignedJobIds`) und den Spezialisten (`principal.jobId`).

Rollen → B-Akteure: `user`→`user`, `lead_agent`→`agent`,
`specialist_*`→`worker`, `scheduler`/`backend_checker`→`system`. Der Akteur
ist der gepruefte Ausweis; B prueft je Kommando, ob die Art erlaubt ist.

## 3. Lesen

Benannte Abfragen (`listPage`), stabil nach Codepunkten sortiert, Seiten mit
wahrem `hasMore`/`nextAfterId`; eine unbekannte Fortsetzungsmarke ergibt
`aborted: true, abortReason: "after_id_unknown"`, ein unbekannter Scope
`scope_not_found`. GET schreibt nie.

* `notes.recent` (Scope Lead): die Kommentare des Leads mit Inhalt, juengste
  zuerst. Geheimnisse filtert der Dienst (`assertNoProviderSecrets`).
* `lead.context`: der Lead selbst (Zustand, Version, `waitUntil`,
  `openQuestionId`).
* `run.context` (Scope Lauf): alle `itemRefs` des Laufs als
  `ctx_<sourceType>_<sourceId>` mit Titel, `rawInput` als Text und den
  Beleg-Ids der Quelle. Spezialisten sehen NUR Quelle und `contextRefs`
  ihrer aktiven Auftraege dieses Laufs; Scheduler/Pruefer haben laut C1
  keinen Lead-/Kontextzugriff.
* `run.queue`: alle Laeufe, juengster zuerst, mit letztem quittiertem Slot und
  `leaseExpiresAt` (aus der E1-Lease, wenn sie zu diesem Lauf gehoert).
* `run.status`: je Lauf der echte gemeinsame B-Status ueber den GANZEN
  Bestand — `dailyAssistantTrafficLight` (bzw. `finalEvaluation`, nur wenn
  `isEvaluationCurrent` sie fuer die aktuelle Revision bestaetigt), Zahl der
  offenen Fragen, `blocked` bei `exception_open` oder nicht gruener Ampel.
  Dafuer braucht der Adapter die gestellte Uhr `now`.
* `policy.current`: Version, Modus, `maxWaitDays`.

`loadObject` liefert das Scope-Objekt fuer den Leseweg. Der Dienst faengt
`loadObject` nicht ab; ein kaputter Kern ergibt dort deshalb „nicht gefunden"
(403) statt 503 — `listPage` wirft dagegen `CORE_*` und der Dienst antwortet
503 `domain_adapter_failed`. Vorschlag fuer C2: `loadObject` wie `listPage`
in `try/catch` nehmen.

## 4. Schreiben

`resolveTarget` und `assertActiveBinding` laufen im CAS-Mutator je Versuch,
`applyVerb` innerhalb von `applyIdempotentCommand`; Zeit (`prepared.now`) und
Kennung (`prepared.requestId`) kommen ausschliesslich aus dem Umschlag. Jede
Wirkung ist ein Aufruf von `B.commandReducer` (also `applyCommand` mit allen
Kern-Invarianten) oder des E1-Ports. Ablehnungen von B werden in C2-Codes
uebersetzt, der B-Code steht in `reason`: 409 → `stale_entity_version`
(z. B. `TRANSITION_NOT_ALLOWED`, `CLOSURE_BLOCKED`, `RUN_EXCEPTION_OPEN`),
`CORE_*`/500 → `core_invalid`, sonst `invalid_request`
(z. B. `DONE_EVIDENCE_MISSING`, `WAITING_INCOMPLETE:WAIT_COUNTERPARTY_SELF`,
`ACTOR_REJECTED:ACTOR_NOT_ALLOWED:user`). Details werden nur uebernommen, wenn
sie selbst Codes sind — nie Nutzertext.

Bindung (`assertActiveBinding`): `user` muss der konfigurierte Eigentuemer
sein; `lead_agent` braucht die aktive E1-Lease (`E1.checkLeadership`) mit
Halter = Ausweis, Scope = `<tenant>:<date>:<slot>:<policyVersion>` des Laufs;
`specialist_*` braucht einen aktiven, nicht abgelaufenen Auftrag seines
Executors im Lauf des Ausweises; Dienste sind mandantengebunden (C1).

### Die 22 Verben

| Verb | Bindung | Bemerkung |
|---|---|---|
| `intake.create` | `registerIntake` | Id abgeleitet (`intake_<fp>`); Text = Titel + Text; `evidenceRefs` nicht gebunden |
| `intake.accept` | `transitionState(intake → done)` | mit `leadId` als `linkTo`, sonst Grund `intake.accept` |
| `lead.transition` | `transitionState` | `expectedEntityVersion` ↔ `expectedVersion`; `evidenceRefs[0]` wird eindeutig als Beleg/Auftrag/Antwort aufgeloest; Wartezustaende → `use_lead_schedule_for_waiting` |
| `lead.schedule` | `setWaiting` | Zustand aus der Belegart (Beleg → `waiting_external`, Frage → `waiting_user`, Auftrag → `delegated`); B erlaubt nur `agent` |
| `briefing.answer` | `recordAnswer` | Antwort-Id abgeleitet; Frage muss zum Lauf gehoeren; `decision` nicht gebunden |
| `briefing.consumeAnswer` | `consumeAnswer` | Konsument = Ausweis |
| `question.create` | `askQuestion` | Id abgeleitet, `date` = Lauf; `options` nicht gebunden |
| `question.resolve` | `recordAnswer` | wie `briefing.answer` |
| `worker.review` | `reviewJobResult` | `resultId` = `result.ref`; `revise` nicht gebunden |
| `run.ensure` | `ensureRun` | `jobId` muss `run_<date>` sein; `slot` wird geprueft, aber B kennt keine Slot-Quittung ueber C2 (siehe Luecke SLOT_RECEIPT) |
| `run.claim` | `E1.acquireLease` | Scope = Slot-Schluessel des aktuellen Slots; `leaseSeconds` > 120 → `runtime:invalid_ttl` |
| `run.renew` | `E1.renewLease` | Fence aus der gespeicherten Lease (Luecke FENCE) |
| `run.finalize` | `closeRun` | nur `outcome: complete`; `summaryRef` = Finalnotiz-Id |
| `task.create` | — | `B_HAS_NO_TASK_CREATE` |
| `lead.comment` | — | `B_HAS_NO_COMMENT_COMMAND` |
| `document.register`, `document.processed` | — | `ATTACHMENT_KEY_NOT_EXPRESSIBLE_IN_C2_ID` |
| `worker.assign` | — | `C2_PAYLOAD_LACKS_SOURCE_AND_PURPOSE` |
| `worker.return` | — | `C2_PAYLOAD_LACKS_RESULT_HASH` |
| `run.checkpoint` | — | `C2_PAYLOAD_LACKS_E1_CHECKPOINT_INPUTS` |
| `note.append` | — | `B_HAS_NO_FREE_NOTE_COMMAND` |
| `run.log` | — | `B_HAS_NO_RUN_LOG_COMMAND` |

Ungebundene Verben loesen Ziel und Bindung normal auf (Rechte und Bindung
werden geprueft), `applyVerb` lehnt dann mit 400
`verb_not_bound:<verb>:<luecke>` ab; nichts wird geschrieben, keine Quittung
entsteht. `VERB_BINDINGS` ist exportiert.

## 5. Luecken und Vertragsprobleme (gemeldet, nicht still geloest)

* **B_HAS_NO_TASK_CREATE** — B hat kein Kommando, das eine Aufgabe migriert
  anlegt; eine direkt geschriebene Aufgabe waere unmigriert und rot.
  Vorschlag: B-Kommando `createTask { taskId, title, dueDate?, notes? }` mit
  `operationalStateSource` (Akteure `user`, `agent`).
* **B_HAS_NO_COMMENT_COMMAND** — Lead-Kommentare sind Client-Konvention.
  Vorschlag: B-Kommando `addComment { sourceType, sourceId, commentId, text }`
  ohne Zustandswirkung.
* **B_HAS_NO_FREE_NOTE_COMMAND / B_HAS_NO_RUN_LOG_COMMAND** — ChatGPT-Notizen
  entstehen nur ueber `ensureStartNote`/`closeRun`/`invalidateClosure`; einen
  Laufeintrag gibt es nicht. Vorschlag: `appendRunNote { date, noteId, text }`
  bzw. `recordRunEvent { date, event, detail }` (begrenzt, ohne Zustand).
* **ATTACHMENT_KEY_NOT_EXPRESSIBLE_IN_C2_ID** — B verlangt fuer Dokumente den
  Anhangsschluessel `attachment-text__…` (Blob-Key-Policy); C2-Kennungen
  verbieten `__`. Ausserdem erlaubt B `registerDocument`/`recordDocumentParse`
  nur dem Akteur `adapter`, C2 dem Nutzer bzw. der Leitung. Vorschlag: eigenes
  C2-Feld `attachmentKey` mit Blob-Key-Muster, und die Dokumentverben bleiben
  serverseitigen Adaptern vorbehalten.
* **C2_PAYLOAD_LACKS_SOURCE_AND_PURPOSE** — `worker.assign` traegt keine
  Quelle (`sourceType/sourceId`) und keinen Zweck; `createJob` braucht beides.
  Vorschlag: Felder `sourceType`, `sourceId`, `purpose`.
* **C2_PAYLOAD_LACKS_RESULT_HASH** — `recordJobReturn` verlangt fuer
  `returned` einen 64-Hex-Hash; `worker.return` hat nur `resultRef` und
  `summary`. Vorschlag: Feld `resultHash: hash()`.
* **C2_PAYLOAD_LACKS_E1_CHECKPOINT_INPUTS** — `checkpointRunSection` braucht
  `runKey`, `sectionId`, `checkpointId`, `continuationId`, `reason`;
  `run.checkpoint` hat `stage`/`note`. Vorschlag: die E1-Felder in den
  Umschlag aufnehmen oder das Verb dem Runner (E2) vorbehalten.
* **FENCE_NOT_PRESENTED_BY_C2** — E1 verlangt fuer `renewLease` den Fence des
  Halters; kein C2-Verb und kein Ausweis traegt ihn. `run.renew` liest ihn aus
  der gespeicherten Lease und prueft nur den Halter — das ist schwaecher als
  E1 es vorsieht. Vorschlag: `fence` als Pflichtfeld in `run.renew`
  (und `run.checkpoint`), von `run.claim` zurueckgegeben (`effect.fence`).
* **LEASE_TTL** — C2 erlaubt `leaseSeconds` bis 900, E1 hoechstens 120.
  Der Adapter kuerzt nicht: `runtime:invalid_ttl`.
* **SLOT_RECEIPT** — die Pflichtquittungen (`process09`, `close23`) und
  `recordSourceCheck` haben kein C2-Verb; ohne sie bleibt `run.finalize`
  (`closeRun`) blockiert. Vorschlag: `run.receipt { slot, receiptId }` fuer
  den Scheduler.
* **ID_CHARSET** — B-Kennungen duerfen `.` und `:` enthalten
  (`ID_MUSTER`), C2-Kennungen nicht. Solche Objekte erscheinen in Seiten mit
  ihrer echten Kennung, sind ueber C2 aber nicht adressierbar
  (`lead.context?scopeId=l:9` → 400). Der Adapter codiert nichts um
  (Test C3a-03). Vorschlag: C2-Kennungsmuster auf `ID_MUSTER` angleichen oder
  Kennungen im Client normieren.
* **DERIVED_IDS** — `intake.create`, `question.create`, `briefing.answer`,
  `question.resolve` tragen keine Kennung; der Adapter leitet sie
  deterministisch aus Mandant, Ausweis, Lauf, Verb und Nutzlast ab. Identische
  Wiederholung mit anderem Idempotenzschluessel trifft dieselbe Karte (B ist
  dort idempotent, `effect.created: false`). Vorschlag: Kennungsfelder im
  Umschlag (`intakeId`, `questionId`, `answerId`).
* **ERROR_TABLE** — `STATUS_BY_CODE` in C2 kennt keine Fachkonflikte; der
  Adapter uebersetzt B-409 auf `stale_entity_version` mit dem B-Code als
  Grund. Vorschlag: eigener C2-Code `domain_conflict: 409`.
* **CACHED_STATUS** — `run.finalEvaluation` traegt kein `validUntil`;
  `isEvaluationCurrent` verwirft sie, `run.status` rechnet die Ampel deshalb
  bei jedem Aufruf frisch (`evaluationCached: false`). Korrekt, aber teurer
  als noetig.

## 6. Testabdeckung

C3a-01 Fabrikvertrag, elf 503-Gruende mit Namen, Policy aus der Umgebung,
`describeDomainPorts`, C3b-`buildRuntimeDeps` mit der benannten Fabrik
(`wiring.domain: true`) und mit fehlenden Ports (`domain_factory_failed`,
503 im Dienst). C3a-02 kanonisches Lesen aller sechs Abfragen mit Anker,
Kategorie, Version; Status ueber den ganzen Bestand; GET schreibt nicht;
fremder Eigentuemer, fremder Mandant, Spezialist ohne Leadzugriff und nur mit
eigenem Auftragskontext, Scheduler ohne Leadzugriff. C3a-03 Seiten
vollstaendig, Fortsetzung, unbekannte Marke abgebrochen, Doppelpunkt-Kennung
nicht umcodiert. C3a-04 vertikal: `lead.transition` als `transitionState`,
nachgelesen, Wiederholung, Idempotenzkonflikt, veraltete Version, uebersetzte
B-Ablehnung, kein done ohne Beleg, CAS-Konflikte je Versuch, unklarer
Ausgang, Nur-Pruefen. C3a-05 Nutzer: Intake anlegen/annehmen, unveraenderliche
Antwort, `question.resolve`, `lead.schedule` fuer Nutzer abgelehnt. C3a-06
Leitung: ohne/fremde/abgelaufene Lease 403, Frage im Lauf, Warten mit echtem
Beleg (Selbst-Gegenpartei, Frist, erfundener Beleg abgelehnt), Review mit
Ergebnisbindung. C3a-07 Scheduler/Pruefer: `run.ensure` mit Version 0,
`run.claim`/`run.renew` ueber E1 (Duplikat, TTL, fremder Halter),
`consumeAnswer`, `finalize` blockiert ohne Nachweis. C3a-08 Spezialist:
fremder Executor, abgebrochener, abgelaufener, zurueckgegebener, fremder
Lauf — und die benannte Luecke ohne Schreiben. C3a-09 alle 22 Verben.
C3a-10 Status nach Abschluss und nach Widerspruch (`exception_open`,
`blocked`, Bewertung frisch), `finalize` danach 409 `RUN_EXCEPTION_OPEN`.
