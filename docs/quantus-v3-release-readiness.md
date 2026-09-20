# Quantus v3: independent release review, 2026-09-20

## Decision

NOT READY TO MERGE OR DEPLOY. Existing production services and schedules remain
unchanged. The owner currently requests independent work only, without new
Claude assignments. This document prepares the next integration and acceptance
steps; it does not authorize costs, migration, or a trial.

## Completed independent checks

- Full desktop integration `npm test`: exit 0 at local38c8283, corresponding
  to remote1d17cf7, treef064d149726021442c665d97ccdb17a9a3930842.
- Tablet75ef8fb and mobileccb11b7: full `npm test` exit0. These are baseline
  checks, not evidence that the v3 client migration exists.
- Desktop production-dependency audit: zero reported vulnerabilities.
- PR260 remains draft/open/unmerged; base721d0ab. No production cutover.
- E2db6f29e:113 authored tests pass. Four original worker counterexamples
  pass. Seven original cost-adapter counterexamples pass with the actual
  integrated idempotency reducer. Two NEW counterexamples below fail.
- C3b4379061:22 authored tests pass; nine original independent checks pass.
  The NEW concurrent cache-bound counterexample below fails.
- C3a branch remains d803f57: no canonical domain adapter delivered there.
- Existing schedules inventoried: weekday follow-up active; old continuation,
  Sam Sparking and AXA/Smile checks paused. None changed or substituted for
  Cloud Scheduler/Tasks/Run.

All network/provider/credential examples in the review tests are synthetic.
No real paid call or user-data mutation occurred. Earlier passes are not
silently replaced by a blanket success claim after new failures were found.

## Reproducible programming blockers

### E2: stale dispatch authority after core I/O

Source:db6f29e, `runtime/quantus-v3/src/cost-adapter.mjs`, claimAndDispatch.
The clock is read before an awaited core read. After claiming, another core
read is awaited, but the lease/time is not revalidated immediately before send.
With a valid reservation and the real integrated idempotency envelope, advancing
the clock121000ms during either the third or fourth core read still calls send
once. The lease has expired; settlement then cannot establish a valid outcome.

Required correction: validate current authority with fresh time after awaited
storage work and before the external side effect; preserve claim/replay safety,
policy/day limits and unknown-outcome handling. Test slow reads, slow CAS and
fencing changes, with positive dispatch controls. No integration until fixed.

Independent evidence: workspace `outputs/quantus-v3/cost-adapter-review.test.mjs`,
COST-06-read-3 and COST-06-read-4, both expected0 calls but observed1.

### C3b: advertised cache bound is not enforced under concurrency

Source:4379061, `netlify/lib/quantus-v3-identity-access.mjs`, eintragFuer/begrenze.
Eviction skips in-flight entries and never enforces the limit after completion.
Sixteen distinct simultaneous synthetic sources create16 cache entries despite
MAX_CACHE_ENTRIES8. The test releases and settles every acquisition before
checking/cleanup; this is not an abandoned-promise artefact.

Required correction: bounded admission or equivalent strict resource control,
including in-flight entries; retain same-source deduplication, sanitised errors
and credential separation. Existing nine independent cases must remain green.
Do not copy this branch's old dependency lock over the patched integration lock.

Independent evidence: workspace `outputs/quantus-v3/c3b-review.test.mjs`, C3B-07.

## Dependency order before publication

1. Correct the two components above and deliver C3a against the real B/E1
   policy, original entities and active bindings. Re-run independent tests.
2. Integrate only reviewed changes into the protected integration tree; keep
   writing disabled. Run full desktop, tablet and mobile regressions and CI.
3. Implement remaining command writers, offline/old-build protection, source
   adapters, MCP, live views, provider bindings and privileged recovery. These
   are programming work, not configuration that review can truthfully finish.
4. Verify deployed writer/service inventory, actual credentials/permissions,
   approved provider costs, infrastructure and migration/rollback rehearsal.
   Do not infer live configuration from repository files or invent approvals.
5. Run T01-T40 against the integrated release candidate; capture source,
   expected result, actual result, revision and evidence for each requirement.
   Missing evidence means OPEN, never passed by a unit-test count.
6. Deploy only after the required gates pass. Verify public UI and authenticated
   read/write, offline recovery, replay, scheduling, monitoring and rollback.
7. Replace old automations only after successful cutover; perform the real
   14-day trial (week1 shadow/drafts, week2 documented low-risk permissions).

Steps4-7 are dependent operational work and elapsed-time requirements, not
completed work and not necessarily work requiring Claude itself. They cannot
be completed safely before steps1-3. The full goal remains incomplete.
