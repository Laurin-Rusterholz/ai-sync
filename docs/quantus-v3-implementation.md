# Quantus Tagesbriefing v3: implementation and acceptance ledger

Source of requirements: `Quantus-Tagesbriefing-Gesamtkonzept-v3.pdf`, 36 pages,
provided by the owner on 2026-09-19. This ledger records implementation evidence,
not approval and not a replacement for the complete specification.

## Non-negotiable release boundaries

- Keep `appStore/app-data_json` and the existing entities authoritative.
- No parallel lead/task/status database; run items are references only.
- API writes, runners and providers start disabled or in dry-run mode.
- No production cutover before all writers, authorization, restore, monitoring,
  cost limits and acceptance tests pass. Never use CORS as authentication.
- Four main slots: 04:00, 09:00, 14:00, 23:00 Europe/Zurich, not five.
- Independent five-minute monitor and 22:30 deterministic preflight.
- Preserve existing schedules until the verified cutover. Do not create local
  Codex schedules as a substitute for the specified Cloud Scheduler/Tasks/Run.
- A real 14-day trial is required. Week one is draft/shadow only; week two uses
  only documented low-risk permissions. Simulated dates do not count as a trial.
- No invented credentials, model prices, budget approval or operational success.

## Source-control baseline

| App | Repository | Inspected main |
| --- | --- | --- |
| Desktop/backend | Laurin-Rusterholz/ai-sync | 721d0ab |
| Tablet | Laurin-Rusterholz/quantus-tablet-version | 75ef8fb |
| Mobile | Laurin-Rusterholz/mobile-management | ccb11b7 |

Separate `codex/quantus-v3-integration` worktrees preserve the existing review
checkouts. No production data was read or modified for the initial code work.

## Work packages

| Package | Scope | Current evidence |
| --- | --- | --- |
| A | Writer, automation, schema and regression inventory | Initial and supplementary source inventories; deployed service inventory still open |
| B | Canonical states, migration, server traffic lights, closure | Reviewed pure kernel 9b6a564 integrated with 27 authored + 16 independent tests; no live migration or API wiring |
| C | Auth, four strict APIs, idempotency, entity versions, CAS | Reviewed C1/C2 1a8d08c integrated disabled; 88 + 64 authored and 5 + 13 independent tests; real domain/identity binding and MCP remain open |
| D | Desktop/tablet/mobile command writers, offline queue, old-client gate | Disabled transport/IndexedDB component tested, including real Chrome recovery; no app wired yet |
| E | Cloud runtime, slots, leases, fencing, retry, checkpoints, cost ledger | E1 f6d6a16/307ee47 passes 120 authored + 16 independent tests; E2 1537336 has three independent failures, corrections delegated; not integrated |
| F | Authorized source adapters, mail ledger, document extraction, live UI | Open |
| G | Job-scoped Claude/Gemini providers, review and untrusted-input isolation | Pure G1 d803f57 integrated with 14 authored + 6 independent tests; provider dispatch and actual backend attestation remain open |
| H | T01-T40, production gates, cutover, 14-day trial and final acceptance | Open |

Development delegation: Claude Code session
`session_01Ls9ej6nh17wu9Wrd78Tugk` owns B/G1 and the separate C3a domain adapter. Integration owns this
ledger, the all-writer audit and existing Firebase CAS hardening. Development
delegation through the UI is not the eventual API-based daily runtime.

Package B commit `590dc78` (branch `claude/gallant-franklin-1jx7vb`) passes its
17 authored tests, but independent counterexamples fail: legacy status overrides
canonical state, ambiguous waits are guessed, prose resets deferrals, invented
evidence/missing waiting start becomes green, cancelled jobs can return, parsed
documents can close without processing evidence, closure omissions hide later
contradictions, array-shaped entities pass validation, policy can weaken hard
bounds, and a second idempotency ledger conflicts with the verified envelope.
This initial submission was not accepted. It is superseded by the reviewed
9b6a564 component described below; these historical defects remain regression
tests, not current known failures.

### Reviewed pure kernel

The seven `assistant-*.mjs` modules, documentation and 27 authored tests are
integrated unchanged from Claude commit `9b6a564`. Sixteen additional independent
tests are now part of `npm run test:assistant-core` and `pretest`, including the
actual integrated idempotency reducer. All 43 tests and the full desktop
`npm test` pass. No runtime imports these modules in a production writer yet.

Validated behaviors include fail-closed repeated migration of partial v3 data,
full-source evaluation rather than supplied item references, trusted server
time, immutable ChatGPT Notes, verified waiting/closure evidence, and fresh
source/result checks when accepting worker returns. Loss or modification of
bound proof invalidates the evaluation and closure without rewriting history.
The obsolete manual six-criteria assessment is not a completion requirement.

This is component acceptance, not complete package or release acceptance.
Authenticated domain bindings, UI writers, source adapters, archive handling,
actual lease/fencing checks, production migration and live tests remain open.
The kernel contains no competing lease or idempotency implementation.

### Reviewed API components

The 29 new C1/C2 source, documentation and fixture/test files come from
`1a8d08c`. All28 unadapted files match their source blobs exactly; the route
composition test now explicitly requires the real integrated idempotency port
instead of asserting that the module is absent. The five independent C1 and thirteen independent
C2 tests are also checked in. The latter use genuinely signed synthetic Firebase
credentials and the actual integrated idempotency module, not its stand-in.
New resources correctly use expectedEntityVersion 0; a separate negative test
rejects using the existing authorization anchor's version instead.

The earlier C2 findings are fixed: each returned original object is authorized,
page completeness requires explicit valid pagination, disabled writes cannot
acknowledge a commit, invalid core/rate records fail closed, and active binding
is checked with fresh time on every CAS attempt and receipt replay. Resource
authorization and existing-object anchors are separate for create operations.
The exact-case production domain adapter is not present yet: this is component
acceptance, not an operational API or all-writer cutover.

Writing remains disabled by default. The canonical domain adapter, identity
access-token provider, real runtime composition and MCP bindings are still
required. Missing configuration/ports return 503; no credentials, production
settings, Firebase rules or existing client writers were changed. The lockfile
adds only jose 6.2.12 and retains the reviewed image-size 2.0.4 security fix.
The integrated suites pass93 authentication and77 API tests, with the API
fixture explicitly reporting `checkout` for the real idempotency module.
Full `npm test` exits0; `npm ci` reports zero vulnerabilities. The initial
integration failures were test-wiring assumptions (script placement and a
module expected to be absent), not suppressed runtime failures.

### Reviewed routing planner

The pure routing planner, documentation and 14 authored tests from `d803f57`
are integrated unchanged. Six independent tests, including a positive measured
delegation control, also pass and run in `pretest`. Test fixtures were updated
to the stricter 3.1 measurement contract; assertions were not weakened.
The planner now rejects mismatched currencies, absent comparison evidence,
future/stale or incorrectly bound measurements, contradictory risk authority
and malformed required tools. Plans remain non-authorizing and send nothing.

Actual server attestation of facts, source-scoped job creation, cost reservation,
provider execution and result acceptance still need end-to-end integration.
No model identifiers, prices, credentials or cost approvals were created.

The five versioned instructions from concept chapters 15/16 are now stored in
`prompts/quantus-v3/`. Their operative bodies match the supplied PDF after only
whitespace/heading normalization. `quantus-v3-prompts.mjs` verifies the pinned
version and hashes; eight tests cover all four slots, tampering, missing files,
invalid versions and path traversal. This does not install or enable a runner.

Package C1 (auth/cursors), commit `5ac0bf7`, was independently reviewed, not
accepted or integrated. Its authored suite passes 61/62 locally; the X.509
fixture fails on macOS. Twelve additional counterexamples fail: wrong revocation
timestamp, missing authentication time, optional auth configuration/policy,
principal kind and object-category confusion, service-checker role minted as a
worker, ignored active credential expiry, unbounded unknown-kid key refresh,
missing expected cursor object scope, malformed pages declared complete, and
missing explicit hasMore. The public verb matrix and job-token format also need
alignment with the concept. Corrections are in progress in Claude session
`session_01X99qvGAx8bbM8RCqMiMqZp`. The revocation requirement is documented by
[Firebase's session-management guide](https://firebase.google.com/docs/auth/admin/manage-sessions).

Package E1 is delegated in
Claude Code session `session_01CJXkQx2wVSo5733NENbThs`, restricted to pure runtime
state/planning helpers and their own tests. It owns the correct lease/fencing and
cost reservation design; package B's unsafe lease placeholder is not accepted.

## Initial writer audit

| Writer | Current source | Observed behavior | Required change / gate |
| --- | --- | --- | --- |
| Desktop main | `public/index.html`: `canonicalWrite`, `rtdbJsonPut`, `netlifyBlobPut` | Whole-blob Firebase transaction or logical ETag + server CAS. Existing 412 retry does retain a fresh ETag. | Move protected fields and module operations to command API; prohibit root patches; preserve unsynced local data. |
| Desktop merge | `public/index.html`: `mergeData` | Explicit `dailyBriefing` branch lacks `assistantRuns`; generic top-level merge cannot repair that omission. | Explicit server-revision-aware nested merge; no local write-back of derived status. |
| Tablet | `public/app.js`: `transactionOperation`; `public/sync-core.js` | Direct authenticated RTDB whole-wrapper transaction; local pending operation queue. | Command transport, stable operation IDs/entity versions, read-only old-build failure. |
| Tablet merge | `public/sync-core.js`: `mergePayloads` | Shallow dailyBriefing merge; explicitly merges routines/beliefs but not assistantRuns. | Shared protected-field and nested run merge contract. |
| Mobile | `js/store.js`: `pushData`, `pullData`, pending changes | Sends entire JSON through blob-put; conditional header only if ETag present; no user bearer token on that PUT. 412 saves pending operations then pulls. | Authenticated command transport and replay, 426 gate without discarding offline edits. |
| Blob facade | `netlify/functions/blob-get.mjs`, `blob-put.mjs` | Optional SYNC_AUTH_TOKEN; missing configuration permits access. PUT requires core If-Match but still replaces whole core. | Fail-closed auth and build gate at controlled all-client cutover; side-key allowlist retained. |
| Admin full write | `netlify/lib/firebase-admin.mjs`: `writeAppDataText` | Logical + Firebase ETag CAS, full replacement, five inner attempts. | Disallow legacy protected-field replacements after cutover; no privileged bypass. |
| Admin mutation | `netlify/lib/firebase-admin.mjs`: `mutateAppData` | Eight-attempt CAS; formerly passed null on missing/corrupt core and allowed mutation to recreate it. | Initial local patch rejects invalid core/missing ETag/async mutation/uncertain outcome; full command invariants still open. |
| Date invite | `netlify/functions/date-invite.mjs`, `date-invite-core.mjs` | Server task mutation, optional token; generated task ID/time inside retry. | Local patch allocates stable ID/time before CAS. Auth/source-specific command adaptation still open. |
| FlowerTech sync | `netlify/functions/flowertech-sync.mjs` | Reads inquiry/video nodes then mutates core; optional token. | Local patch fixes retry timestamp and result handling; command policy/cursors still open. |
| FlowerTech inquiry | `netlify/functions/flowertech-inquiry.mjs` | Persists inquiry outside core, then core task mutation. | Needs durable reconciliation/outbox contract for partial failure; not claimed atomic. |
| FlowerTech portal/uploads | `netlify/functions/flowertech-portal.mjs`, `flowertech-upload.mjs` | Separate scoped portal/intake nodes, custom tokens and uploads. | Preserve public customer workflow; inspect imports into core and explicit allowed fields. |
| Mail queue | `netlify/functions/mail-queue*.mjs`, `netlify/lib/mail-queue.mjs` | Separate server queue and minute runner. | Integrate authorization/content-bound outbox and unknown-outcome reconciliation, never duplicate sends. |
| Restore | `scripts/restore-core.mjs`, `backup-blob.mjs` | Privileged recovery/full snapshots | Legacy privileged restore now refuses v3/partial-v3 snapshots and targets; exact server ETag prevents overwriting changes during operator confirmation. HTTP legacy restore, isolated v3 recovery and replay reconciliation remain cutover gates. |
| RTDB security | `firebase/database.rules.json` | appStore read/write permits authenticated users; unrelated public satellite nodes exist. | Deny direct core writes only after client migration; do not silently break unrelated satellites. |

The supplementary source audit is in `docs/quantus-v3-writer-inventory.md`.
Satellite scan and deployed writer inventory are not yet complete. Inspect
iframe/postMessage bridges, alternate builds, n8n and server jobs before marking
the all-writer gate passed. Do not infer production rules from checked-in rules.

## Local regression baseline

- Desktop main: `npm test` ran through the browser Node suites, then failed in
  the existing Linux-specific `tests/neko-smoke-failure-modes.test.sh` on macOS:
  `awk: can't open file /proc/meminfo`. This is a baseline failure, not a passed
  suite and not yet repaired. Later scripts in the chained test need separate runs.
- Tablet main: `npm test` exit 0.
- Mobile main: `npm test` exit 0.
- Initial CAS patch: `node --test tests/quantus-v3-cas-safety.test.mjs`: 27/27.
- Initial CAS patch: `npm run test:persistence`: exit 0.
- Initial CAS patch: `npm run test:mailversand`: exit 0.
- Initial CAS patch: `node scripts/flowertech-sync.test.mjs`: exit 0.
- Final CAS patch adds real HTTP-handler tests: 30/30, now included in `pretest`.
- Fixed the Linux smoke-test fixtures for macOS without changing the deployment
  script or skipping any scenario: all five simulated cases pass. Full desktop
  `npm test` now exits 0, including the formerly unreachable later suites.
- Locked dependencies installed: all 18 Netlify function modules load; none skipped.
  CI now installs the lockfile too, so import checks cannot silently omit packages.
- Updated only transitive `image-size` 2.0.2 to 2.0.4 within its declared range;
  `npm audit` now reports zero vulnerabilities. Earlier audit flagged
  [ICNS parser DoS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
  [JXL/HEIF parser DoS](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
- Legacy privileged restore: 53 behavior tests pass, including a real call
  through the restore orchestration with conditional in-memory storage and
  on-disk audit writes. Concurrent changes or migration during confirmation are
  not overwritten; missing/wildcard preconditions fail closed. Existing restore
  contract: 218 checks pass. Partial states containing only an actual `*ById`
  map, source cursor, policy marker, runtime ledger or runtime initialization
  marker also refuse restoration
  before confirmation, even without a schema/revision marker. No actual target
  database was restored.

These are local tests. No live acceptance, provider dispatch or trial day is
implied. A test of the transaction helper does not prove all HTTP entry points.

## Browser intent queue component

The browser-native command transport and IndexedDB journal are implemented, but
not imported by production app handlers yet. Writes default disabled. The
36 behavioral tests cover account isolation, stable IDs, retained conflicts,
bounded retry, malformed receipts, legacy intent preservation and a real
composition with the server idempotency helper. A Chrome test independently
verified reload persistence and recovery after the server committed but its
HTTP reply was lost: two requests, one effect, original receipt replayed.
See `docs/quantus-v3-command-client.md`. This is partial T05/T10 evidence only;
T08/T09/T11/T36/T37 and the all-writer gate remain open.

Cross-component review also caught a proposed server dry-run resembling a
successful commit. The client now pauses on explicit dry-run/not-applied results
or a disabled-server error, retaining the operation without consuming attempts.
Server correction is delegated; a component fix is not an enabled deployment.

The independent C2 review used genuine synthetic Firebase signatures and the
actual integrated idempotency module: its positive commit/replay control passed.
Eleven further cases failed: foreign returned objects, missing pagination state,
overfull pages, fabricated dry-run revision, false dry-run acknowledgement,
absent rate-counter CAS conditions, negative counters, lease expiry during the
CAS wait, and three ordinary user verbs denied by conflicting role/target kinds.
The client-side false acknowledgement is repaired here; the server issues remain
delegated and the API package is not integrated. This is not a live data test.

Package B correction `6e829d5` still fails nine independent second-review
counterexamples: corrupt map/revision green results, stale cache validation,
lost waiting proof and reopened project deadline not invalidating closure,
notes in the wrong original store, and untrusted command time overriding the
prepared server time. Sent to Claude for correction; not integrated or released.

The intermediate B correction `c4f8ac4` passed ten B2 tests, but six B3 tests
exposed lost migration ledgers, stale review acceptance and missing/changed done
proof. All are fixed in the integrated `9b6a564` component. C1 `33a4b3d` passes
88 authored and all five second-round independent tests, but C2 remains under
correction following the actual HTTP/idempotency composition review above.

E1 `8031323` passes 107 authored tests and the nine first-round independent
tests, including charging historical catch-up against the real billing day.
A second review found six further failures in four groups: dispatch ignores a
missing/expired/revoked current policy; an old-day reservation can dispatch
against yesterday's allowance; two pre-existing reservations for the same
unresolved content both receive dispatch permission; and deleting the entire
initialized runtime after lease release resets the fence and cost ledger.
All six were reproduced with real pure functions and a passing normal-dispatch
control. The subsequent E1 correction f6d6a16, checked at307ee47, passes all16
independent runtime tests and120 authored tests. It adds a separate runtimeInit
marker. The legacy restore guard now also rejects a partial state containing
only this marker, both in a backup and in the current core. Explicit runtime
migration and isolated v3 recovery remain required integration gates.

The E2 cloud component1537336 passes80 authored tests but fails three independent
HTTP-level counterexamples: simultaneous same-slot delivery enters external work
twice, work exhaustion fabricates a green evidence reference, and leadership
renewal is deferred beyond the required60seconds. A normal signed dry-run control
passes. The tests use genuine synthetic OIDC signatures and E2's storage stand-in,
not the real core envelope. Corrections, including bounded in-flight work, are
delegated. E1/E2 remain unintegrated and no Cloud deployment occurred.

An additional independent review of the E2 cost adapter307ee47 uses the actual
integrated idempotency envelope and E1 reducers with local conditional storage.
The normal dispatch control passes, but six counterexamples fail: receipt replay
after settled/unknown outcomes dispatches again, duplicate concurrent claims
dispatch twice, and request-start time permits dispatch after lease expiry or
midnight during policy loading. The same receipt-replay bug is reproduced with
E2's own fixture. Correction is delegated; these are not real provider calls.

The initial G1 router78e6829 passed its nine authored tests and an independent normal case,
but five counterexamples failed: mismatched cost units, missing self-cost comparison,
future measurements, a risk flag bypassed by task classification, and malformed
requiredTools throwing rather than structured denial. These are fixed in the
integrated d803f57 planner described above. No paid call or execution authority
was created by these tests.

## Existing schedule snapshot (not changed)

- Codex Follow-up-Monitor: active, weekdays 09:00.
- Codex former 5-minute continuation / 10-minute prompt review: paused.
- Codex Sam Sparking monitor: paused, separate scope.
- Codex AXA/Smile checks: paused, separate scope.
- Claude UI lists Weekday Morning Brief; exact schedule and state not yet read.
- ChatGPT, n8n and cloud schedules require a fresh authoritative inventory.
- Checked-in `n8n/quantus-morning-briefing.workflow.json`: inactive template at
  05:02 Europe/Zurich, separate briefing-deliver endpoint; not evidence of the
  deployed n8n state. Its open-context/optional-auth assumptions are not v3-safe.

## T01-T40 evidence register

`Open` means not accepted; `partial` never satisfies the release gate.

| ID | Required behavior | Evidence/status |
| --- | --- | --- |
| T01 | Missing auth config returns 503, not access | Partial: all four real route handlers tested locally; live configuration open |
| T02 | Wrong user, tenant, lead or role denied | Partial: signed HTTP and cursor/object tests pass; original-domain binding and live access open |
| T03 | Unknown verb/field/path/key/oversize rejected | Partial: strict envelope and bounded streaming tests pass; final live entry points open |
| T04 | Same principal/key/body commits once | Partial: signed HTTP uses actual idempotency helper; real domain/production storage concurrency open |
| T05 | Changed body conflicts; lost reply replays result | Partial: actual helper, signed HTTP and Chrome queue recovery pass; enabled three-client paths open |
| T06 | CAS retries do not repeat effects; exhausted retries visible | Partial: storage retry/503 tests, outbox/command tests open |
| T07 | Missing/corrupt core aborts before mutation | Partial: production mutateAppData behavior tested; all entry points open |
| T08 | Three clients + worker preserve answers/runs/foreign fields | Open |
| T09 | Nested assistantRuns survives merge, reload and device change | Open |
| T10 | Old offline writer cannot replace protected state/tombstones | Open |
| T11 | Immutable user response wins; stale agent rejected | Partial: pure response/version and stale-result tests pass; real client concurrency open |
| T12 | Semantic migration idempotent; unknown state visible | Partial: pure migration tests pass; production migration rehearsal open |
| T13 | Omitted lead/page never produces green | Partial: full-set kernel evaluation tested; authenticated paging open |
| T14 | Incomplete waiting proof is not green | Partial: kernel and changed/lost-proof tests pass; real source adapter proof open |
| T15 | Three unsupported deferrals stay red despite text edits | Partial: pure state-transition tests pass; enabled writer tests open |
| T16 | Agent cannot assert green/finalAt/final note | Partial: pure strict command guard tested; authenticated HTTP binding open |
| T17 | Atomic idempotent final note and closure | Partial: kernel and actual idempotency composition pass; endpoint/readback open |
| T18 | Later contradiction invalidates without editing historical note | Partial: pure closure manifest and immutable-note regressions pass |
| T19 | Lease expiry and fencing reject stale owner | Open |
| T20 | Duplicate delivery/crash never loses or duplicates job | Open |
| T21 | Independent monitor detects and catches up missing slot | Open |
| T22 | Zurich DST produces unique expected slots | Partial: pure calendar/slot tests pass; deployed scheduler evidence open |
| T23 | 23:00 closes today; 04:00 carries references, not copies | Partial: pure cutoff/carry-over tests pass; runner composition open |
| T24 | Time/cost exhaustion checkpoints; no false green/loop | Open |
| T25 | Atomic parallel reservations enforce cost limit | Open |
| T26 | Unknown mail outcome is not blindly resent | Open |
| T27 | Changed recipient/content or revoked approval stops outbox | Open |
| T28 | Mail cursors recover gaps with message-ID dedupe | Open |
| T29 | Risky mail cannot be authorized by confidence/majority | Open |
| T30 | Source injection cannot change policy or export authority | Open |
| T31 | Unreadable document remains open; processed proof required | Partial: kernel parse/processed-proof tests pass; actual extraction adapter open |
| T32 | Specialist scope limited to job; stale result cannot close | Partial: fresh job-result/source binding tested; provider and HTTP scopes open |
| T33 | Questions appear now; user answer consumed once | Partial: immutable answer/consumption tested; UI and worker composition open |
| T34 | Snooze/vacation/minimal cannot hide hard deadlines | Open |
| T35 | Archive failure cannot truncate jobs/replay history | Open |
| T36 | Notes refresh and offline/current status are accurate | Open |
| T37 | Real UI handlers and window exports work | Open |
| T38 | Existing Notes/tasks/leads/links/attachments/sync regressions | Partial: integrated desktop full npm test passes; final three-client build open |
| T39 | Monitor itself and failed warning delivery are monitored | Open |
| T40 | Backup restore cannot replay external actions | Partial: unsafe legacy privileged v3 restore blocked and restore race tested; full isolated v3 recovery/reconciliation drill open |

## Next execution steps

1. Finish the all-writer and deployed-service inventory.
2. Review C3 domain/runtime binding and corrected E2 against independent tests.
3. Bind strict command/auth/CAS routes to the reviewed kernel and real lease.
4. Migrate all three app writers and cross-device fixtures before enabling writes.
5. Implement and deploy dry-run runtime only after access/cost gates are explicit.
6. Run all acceptance, rollback and live tests; then begin the dated 14-day trial.
