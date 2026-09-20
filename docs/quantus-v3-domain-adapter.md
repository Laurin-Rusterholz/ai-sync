# Quantus v3 — Paket C3a: der kanonische Domaenen-Adapter

`netlify/lib/quantus-v3-domain-adapter.mjs` ist die einzige Bruecke zwischen
der C2-Kette (`quantus-v3-service.mjs`: Verben, Ressourcen, Anker, Rechte,
Versionen) und dem echten Kern aus Paket B (`assistant-core.mjs`). Es gibt
keinen Ersatzbestand: alles, was er liest oder schreibt, ist der migrierte
Bestand in `appStore/app-data_json`. Lease und Fencing kommen aus E1
(`quantus-v3-runtime-state.mjs`), statisch gebunden, nie nachgebaut.

Stand: alle 23 Verben des Umschlags sind gebunden (22 des Konzepts plus
`run.sourceCheck`). Tests: `tests/quantus-v3-domain-adapter.test.mjs`
(11 Tests) gegen die echte C2-Kette, den echten Idempotenz-Umschlag und die
echte E1-Laufzeit dieses Checkouts (Integrationsstand 48dc1fe8, Tree
`d309cc657ffbc918f124314be6c21f874c443ffb`, plus die engen Anpassungen
unten) und die C3b-Verdrahtung 4379061 (im Checkout, Blob-Hash wird im Test
verifiziert). Ausweise sind synthetisch signiert.

## 1. Fabrikvertrag (C3b)

```
createQuantusV3DomainAdapter({ policyVersion, tenantId, mode, now, ports? })
  → { resolveTarget, assertActiveBinding, applyVerb, loadObject, listPage }
```

`policyVersion`, `tenantId`, `mode`, `now` kommen aus `buildRuntimeDeps`
(C3b). Sie sind nicht die Fachkonfiguration: die Fabrik braucht die echte
Tagesbriefing-Policy (B) und den Eigentuemer des Haushalts — ueber
`ports { policy, ownerId, read }` (Integration, Tests) oder die Umgebung
`QUANTUS_V3_TAGESBRIEFING_POLICY_JSON` / `QUANTUS_V3_OWNER_UID`. Die
Policy-Version aus C2 muss der `version` der B-Policy entsprechen, der
Mandant ihrem `tenant`. Fehlt etwas, wirft die Fabrik
`{ code: "auth_not_configured", status: 503, reason }` mit benanntem Grund
(`domain_policy_missing:<VAR>`, `domain_policy_unparsable`,
`domain_policy_invalid:<B-Fehler>`, `domain_policy_version_mismatch`,
`domain_policy_tenant_mismatch`, `domain_owner_missing:<VAR>`,
`domain_tenant_missing`, `domain_mode_invalid`, `domain_clock_missing`).
`describeDomainPorts({ read, ports })` nennt, WAS fehlt (Namen, nie Werte).
C3b faengt eine werfende Fabrik als `domain_factory_failed` ab und der Dienst
antwortet 503 `domain_adapter_not_available`.

## 2. Abbildung

| C2-Objektart | Kern | Kennung | `jobId` (C1-Bindung) | Version |
|---|---|---|---|---|
| `lead` | `entities.chatgptLeads[id]` | Lead-Id | juengster Lauf mit `itemRef` | `operationalStateVersion` (B-Zustandsversion) |
| `task` | `entities.tasks[id]`, sonst `chatgptTasks[id]` | Id | wie `lead` | wie `lead` |
| `run`, `briefing`, `run_context` (Scope) | `dailyBriefing.assistantRuns[date]` | `run_<date>` | der Lauf selbst; fuer Spezialisten der Auftrag (`runId`-Parameter) | `run.revision` |
| `run_status` | derselbe Lauf | `status_<date>` | Lauf | `run.revision` |
| `intake`, `question`, `briefing_answer`, `document` | `automation.*ById` | Karten-Id | Lauf der Frage (`runDate`) bzw. der verknuepften Quelle | Kartenversion: Projektion des Inhalts (48-Bit aus dem Fingerabdruck; jede Aenderung aendert sie) |
| `assignment` | `automation.jobsById[id]` | Auftrags-Id | **die eigene Kennung** (Ausweis des Spezialisten) | Kartenversion |
| `worker_result` | Auftrag mit `result.ref === id` (genau einer) | `result.ref` | Lauf des Auftrags (Leitung) | Kartenversion |
| `note` | `comments[]` an Lead/Aufgabe, ChatGPT-Notizen mit `assistantNote` | Kommentar-/Notiz-Id | Lauf | Kartenversion |
| `policy` | serverseitige B-Policy | `policy_<version>` | — | 1 |

Jedes Objekt traegt `tenant` und `ownerId` aus der Serverkonfiguration.
Rollen → B-Akteure: `user`→`user`, `lead_agent`→`agent`,
`specialist_*`→`worker`, `scheduler`/`backend_checker`→`system`.

Kennungen: das C2-Alphabet ist jetzt `[A-Za-z0-9_:-]{1,120}` — wie der Kern
mit Doppelpunkt, damit Originalkennungen adressierbar sind; der Punkt bleibt
verboten (dateinamenartige Kennungen), `__` ebenfalls (Blob-Segmenttrenner).
Der Adapter codiert nichts um (Test C3a-02/-05 mit `l:9`).

## 3. Bindung je CAS-Versuch

`resolveTarget` und `assertActiveBinding` laufen im CAS-Mutator in jedem
Versuch neu, auch vor einer Wiederholungsquittung.

* **user**: muss der konfigurierte Eigentuemer sein (`not_household_owner`).
* **lead_agent**: muss die Lease MITFUEHREN — Umschlagfeld
  `lease { holder, fence }`, wie von `run.claim` zurueckgegeben
  (`effect.fence`, `effect.scope`). Geprueft wird sie durch
  `E1.checkLeadership` (Halter, Fence, Ablauf; `lease_not_presented`,
  `lease_invalid`, `lease_absent`, `lease_fenced`, `lease_foreign_holder`,
  `lease_expired`) und gegen den Lauf (`lease_scope_mismatch`: Mandant,
  Datum, Policy-Version des Lease-Scopes). Der gespeicherte Fence ist nie
  Ersatznachweis (Test C3a-07, Review 7bbbd42/2). Verschwindet die Lease
  zwischen zwei CAS-Versuchen, ist der zweite Versuch 403.
* **specialist_claude/gemini**: der Ausweis (`jobId`) ist die Kennung SEINES
  Auftrags. Der Auftrag muss existieren, seinem Executor gehoeren, aktiv
  (`queued|running`) und nicht abgelaufen sein und die aktuelle Quellversion
  muss in `acceptedVersions` liegen (`assignment_not_found`,
  `assignment_foreign_executor`, `assignment_not_active:<state>`,
  `assignment_expired`, `assignment_stale_source`, `assignment_run_mismatch`).
  Das gilt beim Schreiben (`worker.return`) UND beim Lesen (`run.context`
  mit `jobId=<Auftrag>`): der Kontext ist Quelle und `contextRefs` genau
  dieses Auftrags, nie die Vereinigung aller Auftraege des Executors
  (Test C3a-03, Review 7bbbd42/1).
* **scheduler/backend_checker**: mandantengebunden (C1); `run.renew`
  verlangt zusaetzlich die praesentierte Lease mit Halter = Ausweis.

## 4. Die 23 Verben

| Verb | Kern/E1 | Bemerkung |
|---|---|---|
| `intake.create` | `registerIntake` | `intakeId` optional, sonst abgeleitet; Text = Titel + Text |
| `intake.accept` | `transitionState(intake→done)` | mit `leadId` als `linkTo`, sonst Grund `intake.accept` |
| `task.create` | `createTask` | MIGRIERTE Aufgabe (doing, Version 1, Rollen); `dueAt` → Zuercher Tag; Lead als `linkedChatgptLeads` |
| `lead.comment` | `addComment` | Kommentar mit Urheber, Art, `evidenceRefs` (geprueft) |
| `lead.transition` | `transitionState` | `expectedEntityVersion` ↔ `expectedVersion`; `evidenceRefs[0]` eindeutig als Beleg/Auftrag/Antwort; Wartezustaende → `use_lead_schedule_for_waiting` |
| `lead.schedule` | `setWaiting` | Zustand aus der Belegart (Beleg → `waiting_external`, Frage → `waiting_user`, Auftrag → `delegated`); B erlaubt nur `agent` |
| `briefing.answer` | `recordAnswer` | Frage muss zum Lauf gehoeren; `answerId` optional |
| `briefing.consumeAnswer` | `consumeAnswer` | Konsument = Ausweis |
| `question.create` | `askQuestion` | mit `options` (im Kern gespeichert), `date` = Lauf |
| `question.resolve` | `recordAnswer` | wie `briefing.answer` |
| `document.register` | `registerDocument` | `attachmentRef` ist der Anhangsschluessel (`blobKey`, Kern prueft ihn), `mime`, `size`, `leadId`; Herkunft `{ channel: origin, ref: requestId }` |
| `document.processed` | `recordDocumentParse(parsed)` | `extractionRef` Anhangsschluessel, `contentHash` = Extrakt-Hash |
| `worker.assign` | `createJob` | `sourceType/sourceId/purpose/jobKind/dueAt`; `allowedContextIds` werden eindeutig als Kontextreferenzen aufgeloest |
| `worker.return` | `recordJobReturn(returned)` | `resultHash` Pflicht, `summary` am Ergebnis; `sourceVersion` muss akzeptiert sein (`source_version_not_accepted`, 409) |
| `worker.review` | `reviewJobResult` | `resultId` = `result.ref`; Verdikte `accepted|rejected` |
| `run.ensure` | `ensureRunSlot` | legt den Lauf an UND quittiert den Slot (eine Revision); `receiptId` optional; `jobId` = `run_<date>` |
| `run.claim` | `E1.acquireLease` | Scope = Slot-Schluessel des aktuellen Slots; Rueckgabe `effect.fence/scope/expiresAtMs`; TTL 10..120 s (Umschlag) |
| `run.renew` | `E1.renewLease` | nur mit praesentierter Lease (Halter = Ausweis, Fence); `lease:lease_fenced` bei falschem Fence |
| `run.checkpoint` | `recordRunCheckpoint` | Stufe, Notiz, `checkpointId` optional; Status zeigt die Stufe |
| `run.finalize` | `closeRun` / `recordRunEvent` | `complete` → `closeRun` (Zeit, Quittungen, Ampel — kein done ohne Nachweis, sonst 409 `CLOSURE_BLOCKED`); `partial`/`failed` → Laufereignis `finalize:<outcome>`, der Lauf bleibt offen |
| `note.append` | `appendRunNote` | ChatGPT-Notiz `assistantEntry` zum Lauf, `leadId` bei `noteScope: lead` Pflicht |
| `run.log` | `recordRunEvent` | begrenztes Protokoll (500), `eventId` optional |
| `run.sourceCheck` | `recordSourceCheck` | Pruefer; Quellenpruefung fuer den Abschluss |

Fehler: B-Ablehnungen werden in C2-Codes uebersetzt, der B-Code steht in
`reason` (Details nur, wenn sie selbst Codes sind): 409 → `domain_conflict`
(z. B. `TRANSITION_NOT_ALLOWED`, `CLOSURE_BLOCKED`, `RUN_EXCEPTION_OPEN`,
`lease:lease_held`), `CORE_*`/500 → `core_invalid` (503), sonst
`invalid_request`. E1-Ausnahmen erscheinen als `runtime:<code>`.

## 5. Lesen

Benannte Abfragen (`listPage`), nach Codepunkten sortiert, Seiten mit wahrem
`hasMore`/`nextAfterId`; unbekannte Fortsetzungsmarke → `aborted`
(`after_id_unknown`), unbekannter Scope → `scope_not_found`. GET schreibt nie.
Ein kaputter Kern wirft `core_invalid` (503) — `loadObject` und `listPage`
werden vom Dienst kontrolliert abgefangen (bekannte Codes behalten ihren
Status, alles andere ist 503 `domain_adapter_failed`).

* `notes.recent` (Lead): Kommentare mit Inhalt, juengste zuerst.
* `lead.context`: der Lead (Zustand, Version, `waitUntil`, `openQuestionId`).
* `run.context` (Lauf): alle `itemRefs` als `ctx_<sourceType>_<sourceId>`
  mit Titel, `rawInput` als Text, Beleg-Ids. Spezialisten: nur ihr Auftrag.
* `run.queue`: alle Laeufe, juengster zuerst, letzter quittierter Slot,
  `leaseExpiresAt` aus der E1-Lease des Tages.
* `run.status`: je Lauf der echte gemeinsame B-Status ueber den ganzen
  Bestand (`dailyAssistantTrafficLight` bzw. `finalEvaluation`, nur wenn
  `isEvaluationCurrent` sie bestaetigt), offene Fragen, `stage` (letzter
  Checkpoint oder Slot), `blocked` bei `exception_open` oder nicht gruener
  Ampel. Dafuer braucht der Adapter die gestellte Uhr `now`.
* `policy.current`: Version, Modus, `maxWaitDays`.

## 6. Enge Vertragsanpassungen (in diesem Paket, eigene Commits)

**Kern (B)**: `createTask`, `addComment` (mit `evidenceRefs`),
`appendRunNote` (Notizart `assistantEntry`), `recordRunEvent`,
`recordRunCheckpoint`, `ensureRunSlot`; `askQuestion` mit `options`,
`recordJobReturn` mit `summary`; `registerDocument` auch fuer `user`,
`recordDocumentParse` auch fuer `agent`/`system`. Test
`tests/tagesbriefing-v3-kern-c3a.test.mjs` (7 Tests); die akzeptierte
Kern-Suite bleibt gruen (eine Zeile prueft jetzt Worker/Nutzer als weiterhin
abgelehnte Parse-Akteure).

**C2 (Umschlag, C1, Dienst, Cursor)**: Kennungsalphabet mit Doppelpunkt;
Feldtyp `blobKey`; Umschlagfeld `lease { holder, fence }`; `leaseSeconds`
10..120; Kernpflichtfelder (`document.register` mime/size/leadId,
`worker.assign` sourceType/sourceId/purpose/jobKind/dueAt, `worker.return`
resultHash); optionale Kennungen; Felder ohne Kernbindung entfernt
(`decision`, `followUpAt`/`reason` beim Warten, `summary` beim Parsen,
`linkedLeadIds`/`sourceRef`, `evidenceRefs` beim Intake und bei der
Rueckgabe, Verdikt `revise`); neues Backend-Verb `run.sourceCheck`;
`command` an `assertActiveBinding`; `loadObject`/`listPage` in try/catch mit
kontrollierter 503; `domain_conflict: 409`. Die C2-/C1-Tests sind angepasst
(23 Verben, TTL, Pflichtfelder, Lease-Nachweis, Alphabet).

Nicht in diesem Paket: der Browser-Client (`public/quantus-v3-command-
client.mjs`, 22 Nutzerverben; `run.sourceCheck` ist ein Backend-Verb),
`firebase-admin.mjs`, C3b `identity-access`, E2. Die Tests
`quantus-v3-c2-independent` (prueft den Client) und
`quantus-v3-idempotency` (prueft den `firebase-admin` des Integrationsstands)
wurden deshalb nicht uebernommen.

## 7. Testabdeckung (`tests/quantus-v3-domain-adapter.test.mjs`)

C3a-01 Fabrikvertrag, C3b-Blobs verifiziert, elf 503-Gruende, Policy aus der
Umgebung, `buildRuntimeDeps` mit der benannten Fabrik, alle 23 Verben
gebunden. C3a-02 kanonisches Lesen aller Abfragen, Rollen, Doppelpunkt-
Kennung, GET schreibt nicht, kaputter Kern 503. C3a-03 Spezialist liest nur
seinen Auftrag; alle Auftraege abgelaufen, abgebrochen, fremder Executor,
veraltete Quelle, fremder Lauf, unbekannter Auftrag → 403; zweiter Claude-
Auftrag bleibt unsichtbar. C3a-04 Seiten. C3a-05 vertikal `lead.transition`:
nachgelesen, Wiederholung, Idempotenzkonflikt, veraltete Version,
`domain_conflict`, kein done ohne Beleg, fremder Eigentuemer/Mandant, `l:9`,
CAS-Konflikte je Versuch, unklarer Ausgang, Nur-Pruefen. C3a-06 Nutzerverben
positiv/negativ. C3a-07 Leitung: Lease nicht praesentiert, falscher Fence
(Fence−1 direkt am Adapter), fremder Halter, abgelaufen, fremder Tag, Lease
verschwindet zwischen CAS-Versuchen; dann neun Verben mit Wirkung.
C3a-08 Scheduler/Pruefer: `run.ensure` mit Quittung, Slot vor seiner Zeit,
`run.claim`/`run.renew` mit Fence, TTL-Grenzen, `run.sourceCheck`,
`consumeAnswer`, `finalize` blockiert bzw. `partial` als Ereignis.
C3a-09 Spezialist `worker.return` negativ/positiv, danach keine Bindung mehr.
C3a-10 ein ganzer Tag ueber C2 bis `closeRun` (Quittungen, Quellenpruefungen,
Belege, Abschluss, No-op-Wiederholung), Widerspruch → `exception_open`,
`blocked`, `finalize` 409. C3a-11 Bilanz: alle 23 Verben positiv nachgewiesen.
