# Quantus v3: supplementary writer inventory

Source inspection: 2026-09-20. This is a static inventory, not evidence of the
deployed Firebase rules, deployed workflows or production scheduler settings.
Desktop baseline 721d0ab; tablet 75ef8fb; mobile ccb11b7. The integration branch
retains all existing client writers until their replacements pass acceptance.

## Baustein D — the real desktop boundary for protected v3 run data (corrected, F-27)

Independently confirmed befund: `mergeData()` (`public/index.html`) had no
dedicated branch for `automation` (E1 lease/fence, idempotency ledger, cost
accounting, package-B coordination: `questionsById`/`answersById`/`jobsById`/
`evidenceById`/`sourceCursors`/`dataRevision`) or `dailyBriefing.assistantRuns`
(package B: one run per calendar day, `revision`, `phase`, `finalEvaluation`,
`sourceChecks`, `slotReceipts`). Both root keys already exist in the local
clone, so the catch-all safety net at the end of `mergeData()` — which only
fills in *missing* root keys — never reached them.

**A first fix (revision-comparison) was independently reviewed and rejected.**
It let the side with the higher `dataRevision`/`revision` win, local winning
ties. Four counterexamples against the real, extracted `mergeData()` proved
this wrong: a local revision number is no evidence of a server commit — it
can be mutated, arbitrarily inflated, or simply stale after archival.
(1) same `dataRevision`, locally mutated data → local won regardless;
(2) a locally inflated `dataRevision` beat a genuine, lower server revision;
(3) an archived, now-empty server `assistantRuns` (`{}`) let a removed local
run come back; (4) a server with no v3 namespace at all kept the old local
`automation`/runs standing, to be uploaded whole on the next push.

**Corrected model: verbatim server adoption, fail-closed on a gap — never a
comparison.** `mergeData()` now:
- Adopts `automation` and `dailyBriefing.assistantRuns` **exactly** as the
  freshly read server holds them whenever that namespace is structurally
  present — including an *empty* one (an archived/rotated day is a valid,
  authoritative state, not something to reconstruct from a stale local
  copy). No revision is compared; no field-level merge; local's differing
  copy of these namespaces is never part of what gets adopted.
- Marks a **gap** (`merged._v3ProtectedGap`, via `markV3ProtectedGap()`)
  when the server namespace is missing entirely while local holds a
  non-empty one — this is the case a real commit can never explain away,
  and it is never resolved by keeping or uploading the local copy.

**The gap blocks the actual write, at every real write path — it is not a
merge-level decision.** A new `guardV3ProtectedWrite(merged)` — called after
`mergeData()` at each of `canonicalWrite()`'s own merge step, the RTDB
transaction callback inside `rtdbJsonPut()` (checked on **every** invocation
Firebase makes of that callback, including internal retries on write
contention — not just the first), the Netlify 412 conflict retry inside
`netlifyBlobPut()`, and the device-heuristic remerge inside
`firebaseJsonPut()` — detects the flag, strips it from the payload (so it can
never leak into anything actually written or persisted), and turns the write
into a visible, sourced failure (`reason: 'v3_protected_gap'`) instead of
proceeding. No root-snapshot upload happens in this case.

**The differing local state is not silently lost.** `guardV3ProtectedWrite()`
hands off to `retainV3ProtectedGapLocally()`, a real (not documented-only)
handler wired to the already-tested, previously-unused
`public/quantus-v3-command-client.mjs`: it opens the durable intent queue
(`openCommandQueue()`) and calls the sanctioned `retainLegacy()` — never
`enqueue()`, since this is not a command to submit, just a local record kept
separate from the authoritative run — with a content-derived, idempotent
operation id, then shows a throttled, visible toast naming the affected
namespaces and stating plainly that the write was held back and the local
copy kept separately, not uploaded. No user-answer-to-a-briefing-question UI
is invented; this is the real protection/retention handler that a future
answer feature would also need to route around, not a placeholder for it.

Verified two ways:
- **Merge-model level** (`tests/quantus-v3-desktop-boundary.test.mjs`, same
  extraction technique as `tests/sync-merge.test.mjs`, extended to also cut
  out the three new helper functions): the four counterexamples now behave
  correctly — a present server namespace always wins verbatim regardless of
  either side's revision number, an archived empty server map is adopted
  as-is (no revival), and a fully absent server namespace against a
  non-empty local one marks a gap without touching what mergeData returns
  for retention. 19 checks.
- **Real write-path level** (`tests/quantus-v3-protected-write-boundary.test.mjs`,
  new): extracts and runs the actual `canonicalWrite()` and `rtdbJsonPut()`
  from `public/index.html` (only network/Firebase-SDK leaf dependencies are
  injected, never the merge/guard/write logic itself) against a controllable
  fake RTDB `ref.transaction()` and fake `remoteGetByKey`/`remotePutByKey`.
  Confirms: `canonicalWrite()` never calls `remotePutByKey()` when the fresh
  server read lacks the v3 namespace (no root upload), while it writes the
  server's automation **verbatim** — discarding a fabricated local
  `dataRevision: 999` — when the server does hold one; the RTDB transaction
  aborts (`return undefined`, nothing committed) if the gap is detected only
  on a **later** invocation of the callback, simulating Firebase's own
  internal retry under write contention; and `retainV3ProtectedGapLocally()`
  is actually invoked with the correct namespaces and data on every abort.
  27 checks. Full `npm test` exit 0 (all counts above plus the existing
  `sync-merge.test.mjs` and every other extraction-based test in
  `tests/f25-*`/`tests/f26-*`/`tests/sync-rtdb-transaction.test.mjs` that
  independently cuts out `canonicalWrite`/`rtdbJsonPut`/`netlifyBlobPut`,
  each updated with a no-op `guardV3ProtectedWrite` stub where their own
  fixtures carry no v3 namespace).

**Explicitly not done by this step, and left open:**
- **Local user answers to a v3 briefing question are not yet a feature of
  the desktop client.** The retention path this step wires
  (`retainLegacy()`) is the sanctioned place such an answer would also need
  to go through if it could not be resolved into a real v3 command — this
  step does not add that feature, only the boundary and a working handler
  a future one must route around.
- **`public/quantus-v3-command-client.mjs`'s `enqueue()`/command-submission
  path remains unused by the running app** — only `retainLegacy()` is now
  wired, and only from this protection boundary. Migrating any UI writer
  onto the command-API path is unchanged, substantially larger remaining
  work.
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

**Round 2 correction (independently reviewed, ada9665 rejected):** an empty
server `automation` (`{}`) was adopted as a valid archived state exactly like
`assistantRuns`, though `automation` always carries `schemaVersion`/
`dataRevision` once v3 has written at all — now treated as the same gap as a
fully missing namespace. A valid, present-but-different server state
silently discarded the differing local copy with no trace — `mergeData()`
now also marks `_v3LocalDivergence` in that case, and every write path
retains it (quietly, non-blocking — the write still proceeds with the
server's verbatim value). `guardV3ProtectedWrite()` is `async` and was being
awaited from inside the synchronous, Firebase-repeatable RTDB transaction
callback (its Promise return value is always truthy, so `if (v3Luecke)` would
have treated every invocation as a gap); the callback now only calls the pure,
side-effect-free `detectV3ProtectedGap()`/`detectV3LocalDivergence()`, and the
actual `retainV3ProtectedGapLocally()`/`retainV3LocalDivergenceQuietly()` run
exactly once, after the transaction settles. `retainV3ProtectedGapLocally()`
previously reported "retained separately" regardless of whether the queue
write actually committed; it now only claims success after a real
`retainLegacy()` commit, and surfaces a failure (never throttled, unlike a
success toast) when it does not, leaving the original untouched either way.
The retention operation id is now a SHA-256 of the canonicalized
`legacyOperation` with no live timestamp inside it (a fresh `capturedAt` on
every retry made an identical retry collide with itself as
`operation_id_conflict`; the queue's own `createdAt` already answers "first
seen").

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
| Desktop merge | `automation` and `dailyBriefing.assistantRuns` are adopted verbatim from the freshly read server (never compared by revision) or flagged as a gap that blocks the write at every real write path and retains the differing local copy separately (see Baustein D above); everything else in `dailyBriefing` keeps its existing field-level merge | Tablet has no equivalent protection — its own whole-wrapper transaction writer can still overwrite these namespaces with a stale copy. |
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
