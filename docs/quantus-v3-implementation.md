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
| A | Writer, automation, schema and regression inventory | Initial source inventory below; deployed service inventory still open |
| B | Canonical states, migration, server traffic lights, closure | Delegated to Claude Code, separate review branch; not yet accepted |
| C | Auth, four strict APIs, idempotency, entity versions, CAS | Existing CAS hardening implemented locally; API and auth open |
| D | Desktop/tablet/mobile command writers, offline queue, old-client gate | Open; do not enable API-only writes yet |
| E | Cloud runtime, slots, leases, fencing, retry, checkpoints, cost ledger | Open |
| F | Authorized source adapters, mail ledger, document extraction, live UI | Open |
| G | Job-scoped Claude/Gemini providers, review and untrusted-input isolation | Open |
| H | T01-T40, production gates, cutover, 14-day trial and final acceptance | Open |

Development delegation: Claude Code session
`session_01Ls9ej6nh17wu9Wrd78Tugk` owns package B only. Integration owns this
ledger, the all-writer audit and existing Firebase CAS hardening. Development
delegation through the UI is not the eventual API-based daily runtime.

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
| Restore | `scripts/restore-core.mjs`, `backup-blob.mjs` | Privileged recovery/full snapshots | Isolated restore drill, replay fencing, audit; never restore live and re-send old outbox. |
| RTDB security | `firebase/database.rules.json` | appStore read/write permits authenticated users; unrelated public satellite nodes exist. | Deny direct core writes only after client migration; do not silently break unrelated satellites. |

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

These are local tests. No live acceptance, provider dispatch or trial day is
implied. A test of the transaction helper does not prove all HTTP entry points.

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
| T01 | Missing auth config returns 503, not access | Open |
| T02 | Wrong user, tenant, lead or role denied | Open |
| T03 | Unknown verb/field/path/key/oversize rejected | Open |
| T04 | Same principal/key/body commits once | Open |
| T05 | Changed body conflicts; lost reply replays result | Open |
| T06 | CAS retries do not repeat effects; exhausted retries visible | Partial: storage retry/503 tests, outbox/command tests open |
| T07 | Missing/corrupt core aborts before mutation | Partial: production mutateAppData behavior tested; all entry points open |
| T08 | Three clients + worker preserve answers/runs/foreign fields | Open |
| T09 | Nested assistantRuns survives merge, reload and device change | Open |
| T10 | Old offline writer cannot replace protected state/tombstones | Open |
| T11 | Immutable user response wins; stale agent rejected | Open |
| T12 | Semantic migration idempotent; unknown state visible | Claude package B, pending review |
| T13 | Omitted lead/page never produces green | Claude package B, pending review |
| T14 | Incomplete waiting proof is not green | Claude package B, pending review |
| T15 | Three unsupported deferrals stay red despite text edits | Claude package B, pending review |
| T16 | Agent cannot assert green/finalAt/final note | Open; pure-core portion delegated |
| T17 | Atomic idempotent final note and closure | Open; pure-core portion delegated |
| T18 | Later contradiction invalidates without editing historical note | Claude package B, pending review |
| T19 | Lease expiry and fencing reject stale owner | Open |
| T20 | Duplicate delivery/crash never loses or duplicates job | Open |
| T21 | Independent monitor detects and catches up missing slot | Open |
| T22 | Zurich DST produces unique expected slots | Claude package B, pending review |
| T23 | 23:00 closes today; 04:00 carries references, not copies | Claude package B, pending review |
| T24 | Time/cost exhaustion checkpoints; no false green/loop | Open |
| T25 | Atomic parallel reservations enforce cost limit | Open |
| T26 | Unknown mail outcome is not blindly resent | Open |
| T27 | Changed recipient/content or revoked approval stops outbox | Open |
| T28 | Mail cursors recover gaps with message-ID dedupe | Open |
| T29 | Risky mail cannot be authorized by confidence/majority | Open |
| T30 | Source injection cannot change policy or export authority | Open |
| T31 | Unreadable document remains open; processed proof required | Open; pure-core portion delegated |
| T32 | Specialist scope limited to job; stale result cannot close | Open |
| T33 | Questions appear now; user answer consumed once | Open; pure-core portion delegated |
| T34 | Snooze/vacation/minimal cannot hide hard deadlines | Open |
| T35 | Archive failure cannot truncate jobs/replay history | Open |
| T36 | Notes refresh and offline/current status are accurate | Open |
| T37 | Real UI handlers and window exports work | Open |
| T38 | Existing Notes/tasks/leads/links/attachments/sync regressions | Baseline partially verified above; full new-build run open |
| T39 | Monitor itself and failed warning delivery are monitored | Open |
| T40 | Backup restore cannot replay external actions | Open |

## Next execution steps

1. Finish the writer inventory and separate remaining desktop baseline suites.
2. Review Claude package B against actual behaviors, not claimed test counts.
3. Build strict command/auth/CAS envelope around that reviewed kernel.
4. Migrate all three app writers and cross-device fixtures before enabling writes.
5. Implement and deploy dry-run runtime only after access/cost gates are explicit.
6. Run all acceptance, rollback and live tests; then begin the dated 14-day trial.
