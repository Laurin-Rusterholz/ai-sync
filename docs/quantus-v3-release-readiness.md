# Quantus v3: independent release review, 2026-09-20

## Decision

### Integration update, 20 September

The owner now requests finalization and publication with minimal Claude use.
C3a e783240, C3b f39cad2 and E2 e723035 are integrated locally. The
previous two programming blockers below are fixed: 720 combined tests and
16 independent cloud/cost/core checks pass, as does the full app regression.
Fixture assumptions were updated for the real integrated core and identity
provider; production protections were not relaxed. Dependency lock unchanged.

This supports publishing reviewed code with v3 writes and paid execution
disabled, NOT enabling or claiming the complete v3 service. Remaining gates:
writer/client migration, MCP/source/provider bindings, production configuration,
rollback rehearsal, live T01-T40 and the real 14-day trial. Cloud transport
follow-up 2436783 is under review. The historical findings below are retained
as evidence of what was tested and corrected, not current failing results.

NOT READY FOR V3 PRODUCTION ACTIVATION. Existing production services and schedules remain
unchanged. The owner currently requests independent work only, without new
Claude assignments. This document prepares the next integration and acceptance
steps; it does not authorize costs, migration, or a trial.

### Integration update, 20 September (cloud transport 2436783 finalized against public main)

`main` ac6484e is now the base (C3a e783240 + C3b f39cad2 + E2 e723035
integrated, 720 tests). Branch `claude/dreamy-darwin-nimaif` was rebased
onto this base per the merged-PR restart rule, carrying two follow-up
commits (5a7ec6f, 2436783) plus this update. Full `npm run test:v3-cloud`
165/165, `npm run test:v3-runtime` 120/120.

Three real defects, found by checking the E2 closure-evidence path against
the code that is ACTUALLY on this checkout (not a historical `git show`
snapshot), were fixed — none of them weakened a check, all four make an
existing gate function correctly for the first time:

1. **Invented run-id encoding replaced by the real B/C3a convention.**
   `runtime/quantus-v3/src/run-ids.mjs` previously invented an `r-`/`s-`
   hex-escaped id scheme. Package B (`quantus-v3-domain-adapter.mjs`,
   `assistant-abschluss.mjs`) runs exactly one run per calendar day under
   `run_YYYY-MM-DD` (`dailyBriefing.assistantRuns[date]`) and its status
   record under `status_YYYY-MM-DD`. Both are simple, already-valid C2 ids;
   the invented encoding was pure fabrication and never matched what B
   actually stores. Fixed to derive the calendar date from the E1 slot run
   key and build the real B id directly.
2. **`context.run` was bound to the wrong role.** The real role matrix
   (`ROLE_POLICY`, `quantus-v3-auth.mjs`) allows `context.read` on the
   `run_context` data category (per-source evidence) ONLY to `lead_agent`
   (job token, `binding: assigned`) and the specialists (job token,
   `binding: job`) — never to a service credential (`scheduler` or
   `backend_checker`). A prior draft of this port used `role: scheduler`
   and would have failed with 403 on every real call; the port's own
   self-check only validated verbs, not per-verb data categories, so the
   mistake was invisible. `context.run` is kept (not removed) and is now
   correctly bound to `lead_agent`, with a new, real job-token issuer
   (`job-token-issuer.mjs`) that mints a run-bound token through C1's
   existing `mintJobToken`/`resolveAuthConfig` — no new signing key, no new
   credential type. The port self-check now cross-validates every port's
   `(role, verb, dataCategory)` triple against the real `ROLE_POLICY`
   instead of a hand-maintained copy.
3. **Closure evidence now composes two real reads instead of one fabricated
   shape.** `run.status` (service credential, `state`/`blocked`/
   `openQuestions`, B's own `dailyAssistantTrafficLight`/`closeRun` verdict)
   and `run.context` (job token, per-source `entityVersion` → `sources`)
   are both called; their `dataRevision` must match or the evidence is
   rejected (`data_revision_inconsistent`). `validateClosureEvidence`
   (E2, `worker-handlers.mjs`) requires all four criteria jointly, none
   optional: current fence (E1's own, never attested by C2), a complete
   required source set (`sources[].status === "ok"`, fresh
   `checkedAtMs`, no missing/unexpected id), a proven B closure
   (`state === "final" && blocked === false`), and a current/fresh
   version (`dataRevision`, `verifiedAtMs`). Any one of these failing
   fails the whole evidence — none can be skipped by another passing.

New contract test `tests/quantus-v3-e2-c2-contract.test.mjs` drives a real
B day end to end — `ensureRun` → `recordSourceCheck` → `registerEvidence`
→ `transitionState` (bound to that evidence) → `closeRun` — entirely
through `assistant-core.mjs`'s real command reducer and the real
`createQuantusV3DomainAdapter`, then reads it back through the real
`quantus-v3-service.mjs` (`handleReadRequest`) using a real service
credential for `run.status` and a real, freshly minted job token for
`run.context`. It also proves the negative cases: a service credential on
`run.context` is a genuine 403 from the real chain; an incomplete required
source set fails `sources_incomplete`; a stale or fence-mismatched
evidence fails; a run before `closeRun` never reports final. Nothing in
this file loads from the git object store; every module comes from this
checkout's `netlify/lib/` and `runtime/quantus-v3/src/`.

**`sectionWork`/`costPolicy` audited, unchanged.** No real AI-provider
client (OpenAI/Anthropic/Gemini) and no approved cost/price policy
document exist anywhere in this checkout — `prompts/quantus-v3/` holds
prompt text only, not an executable provider binding. Both ports remain
`unavailablePort` with their existing reasons
(`section_work_provider_not_wired`, `cost_policy_not_wired`); nothing was
invented to make them appear available.

**New configuration surface**, all optional and fail-closed:
`QUANTUS_V3_C2_BASE_URL`, `QUANTUS_V3_TOOLS_ENABLED` (per-tool booleans,
default all false), `QUANTUS_V3_TOOL_CREDENTIAL_SCHEDULER`. The job-token
issuer introduces no new secret of its own — it reads C1's existing
`QUANTUS_V3_WORKER_TOKEN_KEYS` via `resolveAuthConfig`, which means **E2
and C1 must run in the same environment/secret scope** for `context.run`
(and therefore for any real closure evidence) to ever succeed; this is a
deployment-topology decision still open, not a code gap.

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
