# Quantus v3: supplementary writer inventory

Source inspection: 2026-09-20. This is a static inventory, not evidence of the
deployed Firebase rules, deployed workflows or production scheduler settings.
Desktop baseline 721d0ab; tablet 75ef8fb; mobile ccb11b7. The integration branch
retains all existing client writers until their replacements pass acceptance.

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
| Desktop/tablet merge | dailyBriefing has dedicated merge logic; assistantRuns is not explicitly revision-merged | Shared protected nested-state reconciliation; a generic top-level merge is insufficient. |
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
