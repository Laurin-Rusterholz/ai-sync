# Quantus Tagesbriefing v3 — Laufzeit-Bausteine (Paket E1)

> **Stand:** zwei unabhaengige Pruefungsrunden, beide **nicht abgenommen**.
> Runde 1 gegen `022e844`: neun Gegenbeispiele, behoben in `8031323`,
> Tests in `tests/quantus-v3-runtime-gegenbeispiele.test.mjs`.
> Runde 2 gegen `8031323`: sechs weitere Gegenbeispiele in vier Gruppen,
> behoben in dieser Fassung, Tests in
> `tests/quantus-v3-runtime-r2-gegenbeispiele.test.mjs`. Abgenommen ist
> damit nichts: es ist eine Korrektur zur erneuten Pruefung.

Zwei neue, noch **nicht angebundene** Module. Kein Deployment, kein Scheduler,
kein Provider, kein Produktionsdatensatz, keine echten Zugangsdaten, kein
bezahlter Modellaufruf. Nichts in diesem Paket wird von einer bestehenden
Netlify-Funktion oder von `public/index.html` importiert.

| Datei | Rolle |
| --- | --- |
| `netlify/lib/quantus-v3-runtime-plan.mjs` | rechnen und planen, ohne Bestand |
| `netlify/lib/quantus-v3-runtime-state.mjs` | reine CAS-Mutatoren auf dem Bestand |

Die Abhaengigkeit laeuft nur in eine Richtung: `state` importiert `plan`.

## Was die Module garantieren

* **Keine Uhr, keine UUID, kein Zufall, kein Hash, kein Netz.** `now` ist
  immer eine Millisekundenzahl von aussen; Kennungen und Inhaltshashes
  bestimmt der Aufrufer serverseitig vor dem CAS.
* **Synchron und wiederholbar.** Jeder Mutator darf in der CAS-Schleife
  mehrfach auf verschiedenen Schnappschuessen laufen. Ein `await` gibt es
  nirgends.
* **Fail closed.** Fehlender, kaputter oder nicht migrierter Kern
  (`entities` + `automation` mit `schemaVersion: 3`, ganzzahliger
  `dataRevision`, `idempotencyByKey`) fuehrt zu `RuntimeStateError` mit
  Status 503. Es wird nie ein Bestand aus `null` angelegt.
* **Nichts geht verloren.** Mutiert wird eine `structuredClone`-Kopie;
  unbekannte Felder, `_deleteLog` und fremde `automation`-Bereiche bleiben
  unveraendert. Belegt in `tests/quantus-v3-runtime-state.test.mjs`.
* **Ein vorhandener Laufzeitbereich wird geprueft, nie ergaenzt.** Ist
  einer da und unvollstaendig, widerspruechlich oder negativ, ist das 503 —
  kein Auffuellen, kein Nullsetzen, kein Raten.
* **"Bereich fehlt" heisst nicht "erste Initialisierung".** Der Nachweis
  liegt neben dem loeschbaren Bereich (`automation.runtimeInit`). Fehlt der
  Bereich, obwohl der Nachweis da ist — etwa nach einem unsauberen Restore
  —, ist das 503 und der Kern bleibt unveraendert. Ein Bereich ohne
  Nachweis ebenso. Nur wenn beides fehlt, entstehen Bereich und Nachweis
  zusammen in derselben Mutation.
* **`unchanged: true` heisst byteidentisch.** Fachliche Absagen und doppelte
  Zustellungen geben dieselbe Referenz zurueck; der Schreibpfad fuehrt dann
  gar kein PUT aus. Strukturelle Fehler werfen.

## Mutator-Vertrag

```
mutator(data, input) -> { data, result, unchanged? }
```

`result.ok === false` ist ein **Ergebnis**, kein Fehler: der Konflikt wird
sichtbar, ohne dass etwas geschrieben wird. `result` enthaelt nie die
reservierten Antwortfelder des Umschlags (`ok` wird gesetzt, `replayed`,
`serverNow`, `dataRevision`, `requestId` gehoeren dem Umschlag).

Der Umschlag ist bereits vorhanden und wird hier **nicht** veraendert:

* `netlify/lib/firebase-admin.mjs` → `mutateAppData` (acht Versuche, CAS mit
  If-Match, verweigert asynchrone Mutatoren, prueft `unchanged` gegen den
  Eingangstext, unklarer Ausgang ist 503)
* `netlify/lib/quantus-v3-idempotency.mjs` →
  `prepareIdempotentCommand` / `applyIdempotentCommand`

`dataRevision` wird je echter Aenderung um genau eins erhoeht — das ist
innerhalb dessen, was `applyIdempotentCommand` erlaubt (unveraendert oder
genau ein Schritt), und es ist zugleich das No-op-Kriterium von
`assistant-core.applyCommand` aus Paket B.

Autorisierung, Mandanten-/Objektpruefung, Schema des Transports und
ETag-Umschlag bleiben vollstaendig ausserhalb. Ein Beleg ist keine
Zugangsberechtigung.

## Zustand im Kern

```
data.automation.runtimeInit              Nachweis der Erstinitialisierung
data.automation.activeLease              der EINE fuehrende Besitz samt Fence
data.automation.runtime = {
  schemaVersion: 1,
  leaseFenceCounter,                     monoton, ueberlebt jedes Release
  runsByKey[runKey],                     Abschnitte, Schritte, Checkpoint
  continuationsById[id],                 Fortsetzungsabsichten
  incidentsById[id],                     Vorfaelle, werden nie geloescht
  cost { policyRef, callsById, receiptIndex, providerRequestIndex,
         contentHashIndex, byDay, byRun, unresolved, overrunMicros },
  monitor { lastTickAtMs, lastHeartbeatAtMs, warnFailures, ticksById }
}
```

`automation.runtime` wird nur angelegt, wenn er **und** `automation.runtimeInit`
fehlen; sonst wird er vollstaendig validiert (`validateRuntimeArea`). Es gibt keine zweite Aufgaben-, Lead-, Status- oder
Kostendatenbank; `runKey` ist `tenant:localDate:slot:policyVersion` und
verweist nur.

## E1-A · Lease und Fencing

| Funktion | Verhalten |
| --- | --- |
| `acquireLease(data, {holder, scope, ttlMs, now})` | TTL 120 s (Default und Maximum). Der Fence kommt **ausschliesslich** aus dem persistierten `leaseFenceCounter`; fehlt er, ist das 503 (nie 0). Neuer Besitz erhaelt einen **streng hoeheren** Fence — auch derselbe Besitzer nach Ablauf. Derselbe Besitzer waehrend eines aktiven Besitzes: `duplicate: true`, kein neuer Fence, kein Schreibvorgang. Fremder aktiver Besitzer: `lease_held`. |
| `renewLease(data, {holder, fence, scope, ttlMs, now})` | Nur mit **exakt** holder + fence + scope. Nach Ablauf `lease_expired` — eine Erneuerung ist nie eine Wiederbelebung. Eine spaete, aber gueltige Erneuerung meldet `lateRenewal: true`. Erneuerung faellig nach 60 s (`renewByMs`). |
| `releaseLease(data, {holder, fence, scope, now})` | Nur mit exakt holder + fence. `leaseFenceCounter` bleibt erhalten. Doppelte Freigabe ist ein Nulldurchlauf. |
| `checkLeadership(data, verifiedScope, now)` | Verdikt ohne Ausnahme. |
| `assertLeadership(data, verifiedScope, now)` | **Die eine Pruefung am Anfang jedes leitenden CAS-Mutators.** Wirft mit Code (`lease_absent`, `lease_fenced`, `lease_expired`, `lease_scope_mismatch`, `lease_foreign_holder`). |
| `requiresLeadership(origin)` | `runner` → true; `user`, `monitor`, `system` → false. **Nutzeraktionen werden nicht pauschal gesperrt.** |

`verifiedScope = { holder, fence, scope }` muss aus der **verifizierten**
Identitaet des Laeufers stammen, nicht aus der Nutzlast.

`readLease` prueft **alle** Zeitinvarianten, nicht nur "positive Zahl":
`ttlMs` in `[10 s, 120 s]`, `expiresAtMs === renewedAtMs + ttlMs`,
`renewByMs === renewedAtMs + min(60 s, ttlMs)`, `renewByMs <= expiresAtMs`,
`acquiredAtMs <= renewedAtMs` und `fence <= leaseFenceCounter`. Eine Lease,
die nicht nach genau diesen Regeln entstanden sein kann — etwa mit zehn
Stunden Laufzeit —, ist ein kaputter Datensatz (503), kein Besitz.

Zusaetzlich prueft `validateRuntimeArea`, dass der Zaehler nicht hinter
irgendeinem tatsaechlich vergebenen Fence liegt (Lease, Abschnitte,
Checkpoints, Ausnahmen, Abschluesse, Kostenbelege). Ein zurueckgedrehter
Zaehler ist 503 — ein alter Fence bekommt nie wieder Rechte.

Ein vorhandener `activeLease`-Eintrag, der nicht dieser Form entspricht — etwa
der alte Sechs-Stunden-Platzhalter aus Paket B —, fuehrt ebenfalls zu
`lease_record_invalid` (503). Er wird weder umgedeutet noch ueberschrieben.
Die Migration dieses Feldes ist eine offene Aufgabe der Integration.

## E1-A · Laufzeitgrenzen, Checkpoint, Fortsetzung

Grenzen: 20 min aktive Laufzeit und 30 Werkzeugschritte je Hauptlauf,
90 s je HTTP-Abschnitt. `evaluateRuntimeBudget` ist rein und liefert
`{ mustStop, reasons, activeMs, allowedActiveMs, remaining… }`.

**Aktive Zeit ist Wandzeit.** `effectiveActiveMs` rechnet die Wandzeit aller
abgeschlossenen Abschnitte plus die des offenen, mindestens aber die
gemeldete Werkzeugzeit. Damit zaehlt auch Arbeit, die kein Werkzeugschritt
war — sonst liesse sich das 20-Minuten-Budget aushebeln.

**Es gibt immer hoechstens EINEN offenen Abschnitt.** Ein zweiter entsteht
nur nach einem geordneten Checkpoint, Abschluss oder Ausnahmezustand — oder
nach einer ausdruecklich protokollierten Wiederaufnahme
(`crashRecovery: { previousSectionId, reason }`), die den haengengebliebenen
Abschnitt mit seiner Wandzeit schliesst und in `run.recoveries` vermerkt.
Sonst `section_already_open`.

**Haupt- und Zusatzbudget sind getrennt.** Die erlaubte aktive Zeit ist
`20 min + 5 min je bewilligtem Spaetfenster`. Ein aufgebrauchtes Hauptbudget
verhindert also nicht das erste Zusatzfenster; die 30 Schritte, der harte
Schluss um 23:30 und das Finanzbudget gelten unveraendert weiter. Die
vollstaendige 20+5+5-Folge ist als Test hinterlegt.

* `startRunSection` — legt den Lauf bei Bedarf an, lehnt bei erschoepftem
  Budget ab, verbraucht eine Fortsetzungsabsicht in **derselben** Mutation.
  Dieselbe `sectionId` noch einmal: Nulldurchlauf.
* `recordToolStep` — idempotent je `stepId`. Ein Schritt, der eine Grenze
  reisst, wird trotzdem verbucht und die Verletzung gemeldet
  (`violations`, `mustCheckpoint`), statt still weggeraeumt zu werden.
* `checkpointRunSection` — dauerhafter Cursor (max. 8 KiB) plus **genau eine**
  offene Fortsetzungsabsicht je Lauf. Eine zweite, andere Absicht ist
  `continuation_conflict`.
* `recordContinuationDelivery` — doppelte Zustellung wird gezaehlt, erzeugt
  aber nie eine zweite Arbeit (`work: false`).
* `openException` — `phase: "exception_open"`, Vorfall und sichere naechste
  Fortsetzung. Nie gruen.
* `finishRun` — `outcome: "completed"` nur bei `runnerMode: "live"`, mit
  Beleg, ohne offene Fortsetzung und ohne offene Kostenaufrufe. Sonst
  `false_green_blocked`. Ein nicht angebundener Laeufer kann kein Gruen
  erzeugen.

**Spaetfenster 23:00:** hoechstens zwei weitere Abschnitte zu je 5 Minuten,
nur mit `budgetAvailable: true`, harter Schluss um 23:30 Ortszeit
(`late_hard_stop`). Danach bleibt nur `openException`.

## E1-B · Kostenbelege

Reihenfolge: **Reservierung**, dann **genau eine Sendefreigabe**, dann genau
eine Aufloesung.

```
reserveCost  (bindet den Aufrufvertrag, sendet NICHTS)
  → claimCostDispatch          genau einmal, mit FRISCHER Policy;
      │                        danach ist der Ausgang offen
      → settleCost             bestaetigter Verbrauch, Rest frei
      → markCostOutcomeUnknown unklar: bleibt gebunden
           → resolveUnknownCost  nur mit Beleg
  → releaseCostReservation     nie beansprucht, Provider hat abgelehnt
                               oder Tageswechsel (`day_rollover`)
```

**`claimCostDispatch` prueft im selben CAS**, und zwar gegen einen
serverseitig **frisch geladenen** Preisstand, nie gegen den alten
Reservierungsbeleg und nie gegen etwas aus einem Anfragerumpf:

1. Die Policy ist vorhanden, freigegeben, jetzt gueltig und steht auf
   `providers: live` — sonst 503 bzw. 409, ohne Schreibvorgang.
2. Modell, Preis und Tokenumfang ergeben noch genau den Betrag des
   Vertrags (`policy_price_changed`), und die Aufrufgrenze liegt nicht
   darunter (`call_limit_lowered`).
3. Der Abrechnungstag ist noch derselbe. Ein Tageswechsel zwischen
   Reservierung und Sendung ist `billing_day_rolled_over`: die
   Reservierung muss mit `evidence.kind = "day_rollover"` belegt
   freigegeben und neu gestellt werden. Sonst haette das Budget von
   gestern eine Ausgabe von heute gedeckt.
4. Es gibt keinen zweiten Aufruf mit demselben Inhaltshash, dessen Ausgang
   offen ist — auch keinen, der nur vorbereitet und dann beansprucht
   wurde. Zwei vorbereitete Duplikate koennen also nicht beide senden.
5. Die verbleibenden Tages-, Lauf- und Aufrufgrenzen halten noch, und es
   gibt weder eine offene Ueberschreitung noch zu viel Ungeklaertes.

* **Die Summen werden immer aus den Belegen abgeleitet** (`deriveCostTotals`)
  und beim Lesen gegen die gespeicherten Aggregate geprueft. Ein geloeschter
  Tagesbeleg, eine negative Summe, ein verwaister Index oder eine nicht
  passende Ungeklaert-Liste sind `cost_ledger_inconsistent` (503) — nie eine
  stille 0. Nach jeder Aenderung werden die Aggregate neu geschrieben; es
  gibt keine inkrementelle Buchhaltung mehr, die auseinanderlaufen koennte.
* **`reserveCost` gibt niemals `dispatchAllowed: true`.** Die Sendefreigabe
  ist ein eigener, genau einmal moeglicher Anspruch mit eigener Pruefung. Ein Absturz nach dem
  Provideraufruf kann damit kein zweites Mal senden: der naechste Anspruch
  ist `dispatch_already_claimed` mit `blocksRetry`, und ein neuer Aufruf mit
  demselben Inhaltshash ist gesperrt, bis der Ausgang belegt aufgeloest ist.
  Nach einem Anspruch ist „nie abgeschickt" keine zulaessige Freigabe mehr —
  es braucht einen Provider-Beleg.
* **Gebunden wird der ganze Aufrufvertrag**: Inhaltshash, Anbieter, Modell,
  Lauf, Laufdatum, Abrechnungstag, Token-Obergrenzen, Policy-Version,
  Betriebsart, Hoechstbetrag und Aufruflimit. Jede Abweichung unter derselben
  `callId` ist `cost_call_conflict` und nennt die abweichenden Felder.
* **Der Abrechnungstag kommt aus der vertrauenswuerdigen Serverzeit**
  (`now` → Europe/Zurich), nicht aus dem Datum im Laufschluessel. Ein
  Nachholauf vom Vortag belastet damit das heutige Tagesbudget; das Datum im
  Laufschluessel bleibt reine Laufidentitaet (`runLocalDate`). Ein
  mitgeschicktes abweichendes Datum ist `billing_date_mismatch`.

* Betraege sind ganzzahlige **Mikrobetraege**; `estimateCostMicros` rundet auf
  und prueft Ueberlauf sowie Modell- und Policy-Obergrenzen.
* Der Preis- und Budgetstand kommt **ausschliesslich** vom Backend
  (`validateCostPolicy`). Das Modul enthaelt keinen Modellnamen und keinen
  Preis. Fehlende, nicht freigegebene, noch nicht oder nicht mehr gueltige
  Konfiguration sperrt jeden Aufruf. `featureFlags.providers` ist ohne
  ausdrueckliche Angabe **`dry_run`**; dann ist `dispatchAllowed: false` und
  es wird nichts belastet — der Preis wird trotzdem gerechnet, damit eine
  fehlende Preiszeile sofort auffaellt.
* Testvorlagen tragen `fixture: true` und werden ohne `allowFixture`
  abgelehnt. Alle Preise und Freigaben in den Tests sind synthetisch.
* Parallelreservierungen koennen Tages- und Laufbudget nicht ueberschreiten:
  die Pruefung liegt im selben CAS wie die Buchung.
* `callId` ist idempotent und an einen Inhaltshash gebunden; anderer Inhalt
  unter derselben Kennung ist `cost_call_conflict`.
* `usageReceiptId` und `providerRequestId` sind eindeutig indiziert — keine
  doppelte Belastung, keine doppelte Erstattung.
* Ein unklarer Ausgang — und ebenso eine beanspruchte, aber nicht
  aufgeloeste Sendung — bleibt **reserviert**, zaehlt in `unresolved` und
  blockiert die blinde Wiederholung desselben Inhalts
  (`unknown_outcome_blocks_retry`). Weder ein Tageswechsel noch eine
  Freigabe loest ihn auf; nur `resolveUnknownCost` mit Beleg tut das.
* Eine Abrechnung ueber der Reservierung wird verbucht **und** sichtbar
  gemacht (`settled_overrun`) und sperrt weitere Reservierungen.

Kostenbuckets sind nach lokalem Datum (Europe/Zurich) und nach `runKey`
getrennt; das lokale Datum kommt aus dem `runKey`, nicht aus einer Uhr.

## E1-C · Sollplan und Monitor

* Genau **vier** Hauptslots: 04:00, 09:00, 14:00, 23:00 Europe/Zurich.
  `MAIN_SLOTS` ist eingefroren; ein fuenfter Eintrag ist die einzige Stelle,
  an der ein fuenfter Hauptlauf entstehen koennte.
* Zeitrechnung ueber `Intl` mit der IANA-Zone, keine feste Verschiebung.
  Beide Umstellungstage 2026 (29.03., 25.10.) sind mit exakten
  UTC-Millisekunden geprueft, ebenso Luecke und Doppelung der Wandzeit.
* `slotRunKey(tenant, localDate, slot, policyVersion)` — stabil, ohne
  Zeitstempel und ohne Zufallsanteil.
* `buildMonitorPlan(view, …)` — rein. Ein fehlender Start nach 10 Minuten
  Toleranz ergibt Vorfall **und** idempotente Nachholabsicht fuer denselben
  Slot, **auch wenn gar kein Lauf existiert**. Kennungen sind stabil
  (`inc:missed_start:<runKey>`, `catchup:<runKey>`), die `tickId` haengt am
  Fuenf-Minuten-Fenster. Neue Eintraege je Tick sind auf acht gedeckelt
  (`truncated` wird vermerkt), der Startzeitraum ist konfiguriert — damit
  kann ein leerer Bestand keine Historienflut ausloesen.
* `applyMonitorPlan(data, {plan, now})` — schreibt idempotent, legt keinen
  Lauf an, ueberschreibt keinen Vorfall. Nachholen setzt `resolvedAtMs`;
  der historische Vorfall bleibt stehen.
* `buildPreflightPlan` (22:30 ± 5 min) liefert **nur** Reparaturen
  bestehender Verpflichtungen; `intents`, `incidents` und `newMainRuns` sind
  dort strukturell immer leer.
* `planDeliveryRetry` — hoechstens 5 Zustellungen, Backoff 30 s / 60 s /
  120 s / 240 s (Deckel 10 min), 429 beachtet `Retry-After` (nie kuerzer als
  der Backoff, Deckel 30 min). `auth`, `forbidden`, `schema`, `budget`,
  `policy`, `not_found` werden nicht wiederholt. Unklarer Ausgang und jede
  **unbekannte** Fehlerklasse fuehren zu Abgleich statt Wiederholung. Immer
  Checkpoint statt Endlosschleife.
* `planItemHandling` / `coalesceFollowUps` — tagsueber (09–23) Antworten und
  bestaetigte Rueckgaben sofort, faellige Nachfassungen je Lead
  zusammengefasst, nicht dringender Neuintake in den naechsten Hauptslot,
  nachts sammeln. Eine **belegte harte Frist** vor dem naechsten Slot wird
  zuerst geprueft und kann von Snooze oder Minimalmodus nicht verdeckt
  werden; ohne Mandat oder Budget wird sie eskaliert, nicht verschoben.
* `planHeartbeat` / `planWarningEscalation` / `recordWarningFailure` — der
  Monitor stellt nur fest, ob sein eigener Herzschlag alt ist. Der
  Watchdog-Vertrag ist ausdruecklich extern und darf Scheduler, Laufzeit und
  Zugaenge nicht mit dem Monitor teilen. `availabilityClaim` ist `null`: es
  wird keine Verfuegbarkeit behauptet. Eine fehlgeschlagene Warnung gilt nie
  als zugestellt.

## Schnittstelle zu Paket B (`assistant-*.mjs`)

Paket B liegt auf `claude/gallant-franklin-1jx7vb` und wird gerade
korrigiert; es ist hier weder importiert noch veraendert worden.

| Paket B | E1 | Uebergabe |
| --- | --- | --- |
| `assistant-buchhaltung.acquireLease` / `releaseLease` (Platzhalter, 6 h, ohne Fence) | `acquireLease` / `renewLease` / `releaseLease` / `assertLeadership` | **E1 ersetzt B.** Die beiden Kommandos `acquireLease`/`releaseLease` samt Schema und Handler entfallen bei der Zusammenfuehrung; jeder leitende Handler ruft stattdessen `assertLeadership(data, verifiedScope, now)` als erstes. |
| `assistant-zeit.mjs` (Zone, Slots, `slotKey`) | `quantus-v3-runtime-plan.mjs` (Zone, Slots, `slotRunKey`) | **Doppelt vorhanden, genau eine Fassung darf ueberleben.** Beide berechnen dieselben vier Slots mit demselben Schluesselformat; E1 nutzt Millisekunden statt ISO-Strings. Wer zusammenfuehrt, waehlt eine Datei und laesst die andere re-exportieren. |
| `automation.activeLease` in B-Form (ISO-Strings, `revision`) | `automation.activeLease` in E1-Form (ms, `fence`, `scope`) | Migration noetig. E1 sperrt eine fremde Form mit 503 statt sie umzudeuten. |
| `assistant-core.applyCommand` | E1-Mutatoren | E1-Mutatoren passen als weitere Handler in denselben Dispatcher: gleiche Signatur `(data, payload, ctx)` bis auf die Benennung, gleiches No-op-Kriterium ueber `dataRevision`. `PROTECTED_FIELDS` aus B muss um die E1-Felder (`fence`, `maxMicros`, `settledMicros`, `state`, `green`, `phase`) erweitert werden, bevor Kommandos von aussen angenommen werden. |

## Belege

`npm run test:v3-runtime` — 120 Tests, ohne Netz, ohne Zugangsdaten.

| Datei | Inhalt |
| --- | --- |
| `tests/quantus-v3-runtime-plan.test.mjs` | 30 — Slots, DST 2026, Monitorplan, Vorabcheck, Wiederholung, Tagesbetrieb, Heartbeat |
| `tests/quantus-v3-runtime-state.test.mjs` | 30 — Lease, Fencing, Laufzeitgrenzen, Checkpoint, Fortsetzung, Spaetfenster |
| `tests/quantus-v3-runtime-cost.test.mjs` | 22 — Policy, Reservierung, Verbrauch, Freigabe, unklarer Ausgang |
| `tests/quantus-v3-runtime-monitor.test.mjs` | 13 — Monitorplan im Kern, Nachholen, Warnzustellung |
| `tests/quantus-v3-runtime-gegenbeispiele.test.mjs` | 12 — die neun Befunde der ersten Pruefungsrunde, je als eigener Ablauf |
| `tests/quantus-v3-runtime-r2-gegenbeispiele.test.mjs` | 13 — die sechs Befunde der zweiten Runde in vier Gruppen, mit Positivkontrollen |
| `tests/quantus-v3-runtime-cas-harness.mjs` | Pruefstand, der den Vertrag von `mutateAppData` nachbildet |

Die Tests rufen die echten Funktionen auf. Mehrere Faelle lassen zwei
Mutatoren **denselben** Schnappschuss lesen und beide schreiben wollen
(`casRace`): einer kommt durch, der andere laeuft in den ETag-Konflikt und
wiederholt gegen den frischen Stand. Genau dort wuerde ein nicht
wiederholbarer Mutator doppelt arbeiten.

### T-Bezug

| ID | Was dieses Paket belegt | Was fehlt |
| --- | --- | --- |
| T19 | Ablauf, strenge Fence-Monotonie, exakte holder+fence-Pruefung, abgelaufener Besitzer ohne Rechte, gleichzeitige Uebernahme | echte Laeufer, echter Scheduler |
| T20 | doppelte Zustellung von Job, Checkpoint und Fortsetzung ohne zweite Arbeit; Absturz-Ersatz ueber Checkpoint + Absicht | echte Zustellung ueber Cloud Tasks |
| T21 | Erkennung ohne vorhandenen Lauf, idempotente Nachholabsicht, keine Duplikate, keine Historienflut, Vorfall bleibt erhalten | unabhaengiger Monitor als eigener Dienst |
| T22 | beide Umstellungstage 2026 mit exakten UTC-Zeitpunkten, eindeutige Slotschluessel | — |
| T24 | 20 min / 30 Schritte / 90 s, Checkpoint statt Abbruch, 23:30 → exception_open, kein Gruen im dry_run | Zeitmessung eines echten Laufs |
| T25 | atomare Reservierung, Tages- und Laufgrenze unter echter Konkurrenz | echte Providerabrechnung |
| T39 | Heartbeat-Alter, Eskalationsvertrag an einen externen Watchdog, verbuchte Warnfehlschlaege | der Watchdog selbst |

## Restluecken (nicht behoben, bewusst benannt)

1. **Kein Deployment, kein Runner, kein Scheduler.** Cloud Scheduler/Tasks/Run
   sind nicht angelegt und nicht konfiguriert. Nichts hier belegt Cloud-IAM
   oder eine Live-Abnahme.
2. **Kein HTTP-Rand.** Authentifizierung, Mandanten-/Objektpruefung,
   Transportschema und der ETag-Umschlag fehlen. Die Mutatoren sind ohne
   diesen Rand nicht benutzbar.
3. **Die gehaertete `mutateAppData` liegt auf `codex/quantus-v3-integration`,
   nicht auf diesem Zweig.** Die Tests laufen gegen einen Pruefstand, der
   deren dokumentierten Vertrag nachbildet. Nach der Zusammenfuehrung muss
   mindestens ein Test gegen die echte Funktion laufen.
4. **Alter `activeLease`-Eintrag, alter Laufzeitbereich, fehlender
   Initialisierungsnachweis.** E1 sperrt alle drei mit 503. Ein
   Migrationsschritt fehlt und ist jetzt zwingend: ein Bestand, in den eine
   aeltere Fassung dieses Pakets geschrieben hat, traegt `runtime` ohne
   `runtimeInit` und kommt ohne diesen Schritt nicht mehr hoch. Das ist
   Absicht — die Alternative waere gewesen, einen geloeschten Bereich
   stillschweigend neu anzulegen.
5. **Kostenpruefung ist O(Belege).** `deriveCostTotals` liest bei jeder
   Reservierung alle Belege. Bei den erwarteten Groessenordnungen (Dutzende
   je Tag) ist das richtig; ohne Archivpfad waechst es unbegrenzt mit.
6. **Restore.** Ein zurueckgespielter aelterer Schnappschuss kann den
   `unknown`-Vermerk eines Kostenaufrufs verlieren. Innerhalb eines Standes
   ist er gebunden; ein Restore-Schutz (T40) ist nicht Teil dieses Pakets.
7. **Archiv.** Vorfaelle und Kostenaufrufe wachsen unbegrenzt; nur die
   Tick-Historie ist gedeckelt. Ein Archivierungspfad fehlt (T35).
8. **Kein Mail-, Quellen- oder Provideradapter.** T26–T33 sind nicht beruehrt.
   `planDeliveryRetry` sagt nur, dass ein unklarer Ausgang abgeglichen werden
   muss — den Abgleich selbst gibt es noch nicht.
9. **Kein 14-Tage-Probebetrieb.** Simulierte Daten zaehlen nicht.
