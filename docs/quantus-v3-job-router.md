# Quantus v3 — Paket G1: versionierter wirtschaftlicher Job-Router

Stand: 20.09.2026. Quelle: Gesamtkonzept v3, Kapitel 12.1 (Jobmanifest) und
12.2 (Routing). Reine Planfunktion **ohne Provideraufrufe**, ohne Uhr, ohne
Zufall, ohne HTTP. Keine Ausfuehrungsfreigabe, kein Versand, keine Mutation,
kein Kostenanspruch. Kein Deployment.

| Datei | Inhalt |
|---|---|
| `netlify/lib/quantus-v3-job-router.mjs` | `planJobRoute`, `validateRouterPolicy`, `validateRouterFacts`, `factsFingerprint`, `manifestBauen`, Konstanten |
| `tests/quantus-v3-job-router.test.mjs` | 9 Tests, `node --test tests/quantus-v3-job-router.test.mjs` (nicht in `package.json` eingehaengt — Vorgabe: package.json unveraendert) |

Der Router importiert aus Paket B nur `canonicalJson`, `stringFingerprint`,
`EXECUTORS` und `ROUTING_SCHEMA`; B-Dateien sind unveraendert.

## Aufruf

```
planJobRoute({ policy, facts, now }) → Plan | { ok:false, error, errors }
```

* `policy` — versionierte Backend-Policy `job-router-policy/3.1`. Nur sie
  bestimmt Modelle, Freigaben, Kontextgrenzen, Werkzeuge, Sandbox,
  Zweitpruefungs-Obergrenze und Kosteneinheit. Modellkennungen sind opake
  Werte aus der Backend-Konfiguration; der Router kennt keine Modell-IDs
  und keine Preise (der Test prueft, dass keine hartkodiert sind).
* `facts` — serverbestaetigte Fakten `job-router-facts/3.1` mit
  `attestation { by:"backend", at, fingerprint }`; der Fingerabdruck muss
  zum Inhalt passen, sonst kein Plan. Freitext (`goal`) ist Datum, nie
  Regel: der Router liest daraus keine Policy, Freigabe oder Klasse.
* `now` — vertrauenswuerdiger Zeitpunkt (ms) → `decidedAt`.

### Policy

```
schema, version, tenant, costUnit
models { key: { provider: openai|claude|gemini, modelId, tested, approvedFor[], contextTokensMax, revokedAt|null, releasedAt? } }
tools { openai|claude|gemini: [toolIds] }
secondOpinion { maxUnits }
sandbox { isolatedAvailable }
featureFlags { providers: dry_run|live }
freshness { attestationMaxAgeMs ≤ 7 d, measurementMaxAgeMs ≤ 30 d }   — der Frischevertrag, versioniert mit der Policy
```

### Fakten

```
task { sourceType, sourceId, sourceVersion ≥ 1, taskClass, deterministicKind?, goal ≤ 4000, requiredTools[] (Ids, eindeutig), expectedReturn { format ≤ 64 }, acceptanceCriteria[] (≤ 50 Texte) }
context { requiredDataIds[], tokensMeasured|null, grants { executor: { dataIds[], revokedDataIds[], tools[] } } }
capabilities { leadershipCanDo }
budget { availableUnits|null, unit }
measurements { self: { units, …nachweis }|null, delegation { executor: { executionUnits, handoverUnits, reviewUnits, …nachweis } } }
  nachweis = { unit, measuredAt, modelKey, policyVersion, sourceVersion }
risk { flagged, authorityConfirmed, confidence? (0..1), votes? (Karte ganzer Zahlen) }
deterministicChecks { deadline, duplicate, permission, state: ok|failed|not_run }
attestation { by:"backend", at, fingerprint }
```

Die Aufgabenklasse ist ein bestaetigtes Faktum, das deterministischer Code
vorher bestimmt hat — kein Modell, keine Textanalyse im Router.

Alle Zahlen muessen endlich sein (Ganzzahlen dort, wo gezaehlt wird); jede
Formverletzung ist eine strukturierte Ablehnung (`FACTS_INVALID` /
`POLICY_INVALID` mit benannten Fehlern), nie eine Ausnahme.

### Bindung an Policy und Uhr (Vertrag 3.1)

Formgueltige Fakten werden zusaetzlich an Policy und gestellte Uhr gebunden,
sonst gibt es keinen Plan (`FACTS_NOT_BOUND`):

* `budget.unit` muss `policy.costUnit` entsprechen — Kosteneinheiten werden
  nie still gleichgesetzt. Eine Umrechnung ist Sache des attestierenden
  Backends (versioniert in den Fakten), nicht des Routers.
* `attestation.at` liegt nicht in der Zukunft (`ATTESTATION_IN_FUTURE`) und
  nicht weiter zurueck als `freshness.attestationMaxAgeMs`
  (`ATTESTATION_STALE`).

Jede Messung wird an ihren Kandidaten gebunden; passt eines nicht, ist sie
wirtschaftlich ungueltig und der Kandidat traegt die Ablehnung
(`MEASUREMENT_UNIT_MISMATCH`, `MEASUREMENT_POLICY_MISMATCH`,
`MEASUREMENT_SOURCE_MISMATCH`, `MEASUREMENT_MODEL_MISMATCH`,
`MEASUREMENT_IN_FUTURE`, `MEASUREMENT_AFTER_ATTESTATION`,
`MEASUREMENT_STALE`, jeweils `:<executor|self>`). Ein gueltiger Nachweis
wird als `route.evidence` und `manifest.measurementEvidence` mitgefuehrt —
aus den Fakten, nie erfunden.

## Entscheidungsregeln (12.2)

| Klasse | Weg | Bedingungen |
|---|---|---|
| `deterministic` (deadline/duplicate/permission/state) | Code, kein Modell | immer; braucht kein Budget, keine Messung |
| jede Modellklasse | — | scheitert eine deterministische Vorpruefung (`failed`) oder lief sie nicht (`not_run`), ist der Plan `blocked` — vor jedem Modellweg |
| jede Modellklasse | Risikoschranke | `risk.flagged` ohne `authorityConfirmed` ist `draft` mit `AUTHORITY_UNCONFIRMED` — unabhaengig von der Klassifikation, ohne Kandidaten. `risk.flagged` **mit** bestaetigter Befugnis bei einer Nicht-Risikoklasse ist ein Widerspruch zwischen Marke und Klassifikation: `blocked` mit `RISK_CLASS_CONTRADICTION`; der Router klassifiziert nicht um |
| `short_context` | `self` = OpenAI-Leitung | Modell getestet + freigegeben fuer `leadership`, Daten/Werkzeuge freigegeben, Kontext gemessen und passend, Selbstkosten gemessen, Budget bekannt und ausreichend. Sonst `blocked` mit `LEADERSHIP_UNAVAILABLE_NO_FALLBACK` — Claude/Gemini sind nicht einmal Kandidaten |
| `bounded_text` / `bounded_file` / `bounded_code` | `delegate` an Claude oder `self` | beide Kandidaten werden geprueft; Delegation nur, wenn **gemessen** `execution + handover + review < self`, oder die Leitung **nachweislich** nicht kann: `leadershipCanDo:false`, Kontextgrenze gemessen ueberschritten, gemessene Selbstkosten ausserhalb des Budgets. Gleich teuer ist keine Ersparnis. Fehlende, veraltete oder fremd gebundene Selbstmessung ist **keine** Faehigkeitsluecke und kein Kostenbeweis: dann `blocked` mit `DELEGATION_REQUIRES_COMPARISON` (ebenso bei ungemessenem Kontext oder fehlender Datenfreigabe der Leitung — kein Fallback). Ohne gueltige Delegationsmessung keine Delegation; beides fehlend → `blocked`. `bounded_code` nur mit `sandbox.isolatedAvailable`; Manifest traegt `{ isolated:true, prodSecrets:false, deploy:false }` |
| `ocr` / `audio` / `structured_extraction` | `delegate` an Gemini | Modell getestet und fuer genau diese Faehigkeit freigegeben; sonst `blocked` mit `CAPABILITY_MISSING` und der Faehigkeit im Blocker — kein Ausweichen auf andere Provider |
| `risky_unclear` | `second_opinion` (Claude oder Gemini, Obergrenze `secondOpinion.maxUnits`) | nur bei `authorityConfirmed:true`; sonst `draft` mit `AUTHORITY_UNCONFIRMED` — Konfidenz und Mehrheiten sind Daten, keine Freigabe, und es wird kein Modell bewertet |

Kandidatenpruefung vor jedem Ranking (`candidates[]` im Plan, jede
Ablehnung benannt): `MODEL_NOT_TESTED`, `MODEL_REVOKED`,
`MODEL_NOT_RELEASED`, `MODEL_NOT_APPROVED_FOR:<cap>`, `MODEL_NOT_CONFIGURED`,
`DATA_GRANT_MISSING`, `DATA_NOT_GRANTED:<ids>`, `DATA_GRANT_REVOKED:<ids>`,
`TOOL_NOT_ALLOWED:<tools>`, `CONTEXT_NOT_MEASURED`, `CONTEXT_LIMIT_EXCEEDED`,
`MEASUREMENT_MISSING:<executor|self>`, die sieben `MEASUREMENT_*`-Bindungsfehler
oben, `BUDGET_UNKNOWN`, `BUDGET_ZERO`,
`BUDGET_INSUFFICIENT`, `SECOND_OPINION_CAP_EXCEEDED`, `SANDBOX_NOT_AVAILABLE`,
`LEADERSHIP_CANNOT_DO:<cap>`. Bei gleichen Kosten entscheidet der
Modellschluessel alphabetisch — deterministisch.

## Plan

```
{ ok:true, routerVersion:"job-router/3.1.0", policyVersion, factsFingerprint, decidedAt, taskClass,
  route { kind: deterministic|self|delegate|second_opinion|draft|blocked, executor, modelKey, model {provider, modelId}, cost {execution, handover, review, total}, sandbox, blockers? },
  reasons [{ code, detail }], candidates [...], manifest, routing, fingerprint,
  isExecutionAuthorization:false, sendsNothing:true, mutatesNothing:true, spendClaim:false, providersMode }
```

`routing` ist das zu Paket B kompatible Objekt `lead-routing/3`
(`routerVersion`, `policyVersion`, `executor`, `decidedAt`, `reason`,
`fingerprint`) — nur wenn ein Executor zugewiesen wurde; `leadUnvollstaendig`
akzeptiert es, wenn der Executor zu den Rollen passt. `fingerprint` ist die
Signatur ueber den ganzen Plan.

### Jobmanifest (12.1)

```
schema "job-manifest/3", task { sourceType, sourceId, sourceVersion, goal, taskClass, deterministicKind },
accountable "chatgpt", executor, model, sources (nur freigegebene, nicht widerrufene Daten-IDs — nie Vollbestand),
fullDatasetAccess false, secrets "none", allowedTools, resultFormat, acceptanceCriteria,
expectedReturn { format, maxUnits, resultHashRequired, reviewRequired }, budget { unit, execution, handover, review, total, reservation:"pending_E1", spendClaim:false },
sandbox, routerReason[], blockers[], executionAuthorized false
```

`accountable` bleibt `chatgpt`; der Executor ist getrennt. Die eigentliche
Kostenreservierung macht E1 atomar; `reservation: "pending_E1"` ist kein
Anspruch.

## Was der Router bewusst nicht tut

* keine Provider-, Netz- oder Uhraufrufe; keine Ausfuehrung, kein Versand
* keine Modell-IDs, Preise, API- oder Aboguthaben-Annahmen; keine
  erfundenen Messwerte — ohne Messung keine Ersparnisbehauptung
* keine Klassifikation oder Freigabe aus Text (Mail, PDF, Modellantwort)
* keine Umrechnung von Kosteneinheiten, keine Toleranz fuer Uhren aus der
  Zukunft, keine Verlaengerung des Frischevertrags ueber die Policy hinaus
* keine Rechteausweitung, keine erfundenen Benutzerauftraege, kein
  automatischer Fallback bei fehlendem Zugriff oder Budget
* kein manuelles Sechs-Kriterien-Raster

## Testabdeckung

`tests/quantus-v3-job-router.test.mjs`, 14 Tests: Positivfall je Klasse mit
Manifest- und Routing-Kompatibilitaet; 10 ungueltige Policies; fehlende/
verfaelschte/fremde Attestierung, fehlende Quellversion, unbekannte Klasse;
fremde Kontext-IDs, widerrufene Freigabe, fehlendes Werkzeug, Leitung ohne
Zugriff ohne Fallback; nicht getestetes/widerrufenes/nicht freigegebenes
Modell, fehlende Faehigkeit (OCR ohne Gemini), Kontextgrenze, Codejob ohne
Sandbox; Uebergabe+Pruefung zu teuer, gleich teuer, fehlende
Delegations-/Selbst-/Kontextmessung, Budget 0/unbekannt/knapp,
Zweitpruefung ueber Obergrenze; riskanter Fall mit Konfidenz 0.99 und 5:0
bleibt Entwurf; fehlgeschlagene/nicht gelaufene Vorpruefung; Prompt-Injection
als Datum; deterministische Wiederholung, unveraenderte Eingaben, keine
Uhr/Zufall/HTTP/Modellkennungen im Quelltext.

G1-Abnahme (Vertrag 3.1), fuenf Gegenbeispiele, die vorher fehlschlugen:
G1-01 `budget.unit` JPY gegen `costUnit` microUSD (kein Plan; Messungen in
fremder Einheit machen den Kandidaten ungueltig); G1-02 `self:null` bei
`leadershipCanDo:true` (blocked statt delegate; veraltete/fremd gebundene
Selbstmessung ebenso; echte Luecke, Budget- und Kontextnachweis delegieren
weiterhin); G1-03 Messwerte now+24h, nach der Attestierung, veraltet,
Attestierung aus der Zukunft/veraltet, Bindung an Modell/Policy-Version/
Quellversion, Frischevertrag als Policy-Pflicht, Nachweis im Manifest;
G1-04 Risikomarke ohne Befugnis bei jeder Modellklasse Entwurf, mit Befugnis
und Nicht-Risikoklasse Widerspruch, Vorpruefungen gehen vor, deterministische
Klasse bleibt Code; G1-05 `requiredTools` als String, Ruecklaufformat,
Kriterien, NaN/Infinity/Brueche/Strings ueberall, grob verformte Policy und
Fakten — nie eine Ausnahme, immer eine benannte Ablehnung.

Nicht Teil dieses Pakets: die deterministische Klassifikation der Aufgabe,
die Erhebung der Messwerte, die Attestierung der Fakten (Backend), die
Kostenreservierung (E1), Provider-Adapter (G2) und jeder Aufruf.
