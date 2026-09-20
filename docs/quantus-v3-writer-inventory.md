# Quantus v3: supplementary writer inventory

Source inspection: 2026-09-20. This is a static inventory, not evidence of the
deployed Firebase rules, deployed workflows or production scheduler settings.
Desktop baseline 721d0ab; tablet 75ef8fb; mobile ccb11b7. The integration branch
retains all existing client writers until their replacements pass acceptance.

## Baustein D — the real desktop boundary for protected v3 run data (done, narrow)

Independently confirmed befund: `mergeData()` (`public/index.html`) had no
dedicated branch for `automation` (E1 lease/fence, idempotency ledger, cost
accounting, package-B coordination: `questionsById`/`answersById`/`jobsById`/
`evidenceById`/`sourceCursors`/`dataRevision`) or `dailyBriefing.assistantRuns`
(package B: one run per calendar day, `revision`, `phase`, `finalEvaluation`,
`sourceChecks`, `slotReceipts`). Both root keys already exist in the local
clone, so the catch-all safety net at the end of `mergeData()` — which only
fills in *missing* root keys — never reached them. Any desktop tab left open
longer than one v3 program run (the four daily slots are hours apart) wrote
its stale copy back on the *next* save of anything at all (checking a habit is
enough): a lease the server had already released, a reset fence counter, an
idempotency ledger missing entries recorded since, an already-closed day
(`closeRun`) reverting to open.

Fixed in `mergeData()`: both namespaces now use explicit, server-revision-
faithful whole-object replacement — never a generic field-by-field/shallow
merge, since a mixed combination (e.g. an old lease next to a new fence
counter, or one field of a closed run next to another field of the still-open
run underneath it) is a state neither side ever actually had.
- `automation`: the side with the higher `automation.dataRevision` wins
  entirely; local wins on a tie (so a tab that just wrote through the real v3
  command API doesn't overtake itself in the same merge round); a remote
  copy with no local counterpart is adopted whole.
- `dailyBriefing.assistantRuns`: per calendar date, the side with the higher
  `revision` wins entirely; a date known only to one side is kept.

This closes the funnel at its single choke point: `canonicalWrite()` always
reads a fresh remote snapshot before calling `mergeData(basis, fresh)`, and
every desktop save path (`doSave` → `remotePut` → `canonicalWrite`, and the
periodic `syncFreshness()` pull-and-merge) goes through it — no separate
patch path bypasses the merge, so none needed to be touched or newly
introduced. `TRANSPORT_ROOTS` (fields excluded from the merge/backup funnel)
does not list `automation`, confirming it already flows through this same
funnel today, unprotected until this fix.

Verified with the real, extracted `mergeData()` function (same technique as
`tests/sync-merge.test.mjs`) in `tests/quantus-v3-desktop-boundary.test.mjs`:
higher-revision server automation/run wins wholly; a lower-revision remote
never displaces a newer local copy; a remote-only namespace is adopted; the
winning side stays internally consistent (lease and fence counter come from
the same side, never mixed); an offline/invalid remote snapshot leaves local
untouched (Offline-Gegenprobe); and a reload-shaped round trip (stale
localStorage snapshot merged against a fresh server read, as `syncFreshness`
does) ends up with the server's revision, not the pre-reload local one
(Reload-Gegenprobe) — 21 checks, plus the existing `sync-merge.test.mjs`
(89 checks) re-run clean as a regression check. Full `npm test` exit 0.

**Explicitly not done by this step, and left open:**
- **Local user answers to a v3 briefing question are not yet a feature of
  the desktop client** (no code path exists — confirmed by grep: zero
  references to `assistantRuns` anywhere in `public/index.html` before this
  change). The constraint stands as a design boundary for when that feature
  is built: such an answer is a separate, durably stored intent with its own
  stable id (`openCommandQueue().enqueue()` from the already-tested,
  still-unused-by-the-app `public/quantus-v3-command-client.mjs`), submitted
  through the real command API — never a value embedded in or copied from
  the locally held `automation`/`assistantRuns` snapshot this merge fix
  protects. `openCommandQueue().retainLegacy()` is the sanctioned place to
  durably keep an old/unmapped local operation that cannot be resolved into
  a v3 command, so it is preserved and can be surfaced to the user, instead
  of being silently dropped or forced through as an uncoordinated whole-
  document overwrite ("root patch"). No such code path exists yet either;
  this documents where it must go if and when one is written.
- **`public/quantus-v3-command-client.mjs` remains unused by the running
  app.** This step protects the existing generic merge funnel against the
  concrete corruption risk; it does not migrate any UI writer onto the
  command-client/command-API path. That migration (`canonicalWrite`'s many
  existing callers converting whole-snapshot writes into bounded commands)
  is the substantially larger remaining item from "Confirmed core writers"
  above and is not part of this step.
- **Tablet (`public/app.js`) and mobile (`js/store.js`) are untouched and
  remain exactly as risky as described above** — their own whole-wrapper
  transaction and whole-JSON-PUT writers have no equivalent protection yet.
  Only the desktop (`public/index.html`) merge funnel was hardened.
- **Desktop Polaris (`plInboxApply`) and StickyBoard (`onSbMessage`)**
  writers, listed above as needing their own authorization/origin boundary,
  are unrelated to this fix and remain open.
- No production activation, Firebase rule, secret, or external call was
  touched or changed. Existing non-v3 desktop behavior (habits, tasks,
  notes, everything not `automation`/`assistantRuns`) is unchanged — the
  fix is additive and only engages when either namespace is present.

## Confirmed core writers

| Surface | Source | Observed route | Required v3 boundary |
| --- | --- | --- | --- |
| Desktop | `public/index.html`, `canonicalWrite` at 14395 | Whole-core read/merge/conditional write; many UI callers eventually use this funnel | Convert original user operations to bounded owner commands; preserve pending intents. No general agent JSON patch. |
| Desktop Polaris | `public/index.html`, `plInboxApply` at 118433 | Claims satellite inbox entries, then creates or updates canonical entities and schedules a save | Authorized, idempotent intake with durable source binding and reconciliation; a satellite claim is not proof of a core commit. |
| Desktop StickyBoard | `public/index.html`, `onSbMessage` at 120353 | Receives `__sbSave`, updates note htmlState, then persists | Validate the exact owned iframe/source, origin contract and bounded message shape before forming an owner operation. The current receiver does not establish that sender boundary. |
| Tablet | `public/app.js`, `transactionOperation` at 820 | Authenticated whole-wrapper RTDB transaction with local pending operations | Migrate actual user handlers, persist stable command IDs/versions and retain rejected legacy edits. |
| Mobile | `js/store.js`, `pushData` at 131 | Whole JSON PUT to blob-put, If-Match only when known, no Authorization header on this PUT; pending list cleared on success | Authenticated command transport with validated commit receipts, bounded retry, conflicts and 426 retention. |
| Backend/admin | `firebase-admin.mjs`, blob-put, date-invite, FlowerTech sync/inquiry, privileged restore | Core mutation or full replacement with distinct authorization/source assumptions | Every protected mutation must pass common invariants. Keep exact CAS, stable prepared IDs and original entities; no privileged bypass after cutover. |

The tablet's old additional `polaris/inbox` mirror was removed before this
work. Its source explicitly reserves that inbox for n8n/voice. Do not migrate
or test a tablet mirror as though it were still an active writer.

## Readers, satellites and bridges

| Surface | Inspected behavior | Remaining work |
| --- | --- | --- |
| Desktop merge | `automation` and `dailyBriefing.assistantRuns` are now explicit, revision-faithful whole-object merges (see Baustein D above); everything else in `dailyBriefing` keeps its existing field-level merge | Tablet has no equivalent protection — its own whole-wrapper transaction writer can still overwrite these namespaces with a stale copy. |
| DocStudio | Reads canonical core through APP_BLOB_PATH; writes docOrgs/docExamples/docDocuments satellite nodes | Authorized source projection and import contract; do not incorrectly label every satellite write a core replacement. Move client-embedded webhook credential handling behind the server boundary without copying its value into documentation. |
| Universal UI | Core live listener in quantus-universal-ui.js | Reader freshness/revision handling, no observed independent core mutation. |
| Drive | postMessage bridge opens the PDF editor | Bind bridge input to an allowed source; no observed independent core writer in this scan. |
| Career/retirement iframe bridges | Observed close/fullscreen messages | Keep UI-only messages separate from data-write authority. |
| Briefings store | Separate briefings/items and Storage, optional legacy sync token | Cannot substitute for canonical v3 assistantRuns, immutable start/final notes or trial evidence; authorize source and asset access. |
| Checked-in smarter-daily n8n workflow | Inactive JSON template; reads settings/queue, external model call and satellite document/queue updates | No assumption about deployed status. Bind provider authorization, reservations, job context and source outcomes before any replacement. |
| Checked-in polaris-budget n8n workflow | Reads the root core; no explicit active state in the file | Replace unrestricted reads with least-privilege authorized projection; inspect the real deployed workflow separately. |
| Mail queue | Separate minute runner and queue | Content/recipient/approval-bound outbox, unknown-outcome reconciliation and actual provider evidence; never infer successful send from a local queue flag. |

## Cutover evidence still required

- Enumerate deployed writers and versions, including old open tabs, installed
  mobile/tablet clients, restored backups and actual n8n/cloud automations.
- Bind the four APIs to the original B data model and central E1 lease/fence,
  with the actual CAS/idempotency envelope rather than synthetic entity maps.
- Exercise real UI handlers, exported window functions, satellite imports,
  simultaneous edits, reloads, offline queues and changed user answers.
- Only then deny direct core writes and enable the minimum-build gate. Rejected
  old clients must retain their unsynced data and explain how to recover it.
- Rehearse backup recovery and reconciliation without losing retained receipts,
  cost records, runtime initialization proof or monotonic fence counters.

No existing Habits, business leads, schedules, credentials or production records
were changed by this inventory. All-writer acceptance remains open.
