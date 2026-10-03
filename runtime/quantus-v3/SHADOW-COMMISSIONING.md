# Shadow commissioning: isolation before activation

The v4 concept requires four real daily slots in draft/test/shadow operation
before the fourteen-day trial can be accepted. The existing `live` gates must
not be marked passed to make that trial possible.

## Implemented storage boundary

In `shadow` mode the deployed worker, monitor and watchdog use a core port
bound to an explicit `QUANTUS_V4_SHADOW_BINDING`. An absent or invalid binding
makes that port unavailable. The OpenAI composition independently refuses an
unwrapped core in shadow mode. A dry-run OpenAI section stops before creating
daily runs, start notes or source/model work.

The binding has exactly these fields:

```json
{
  "schemaVersion": 1,
  "sourceProjectId": "production-project-id",
  "sourceTenant": "production-tenant",
  "sourceC2Origin": "https://production.invalid",
  "projectId": "isolated-project-id",
  "tenant": "isolated-tenant",
  "c2Origin": "https://isolated.invalid",
  "databaseUrl": "https://isolated-project-id-default-rtdb.europe-west1.firebasedatabase.app",
  "ref": "operator-reviewed-isolation-record"
}
```

These are examples, not existing resources or approvals. The target project,
tenant and origin must differ from production. The explicit Firebase URL,
Firebase project settings, service-account JSON and Tasks queue must match the
target project. Refresh-token overrides and implicit database defaults are
rejected. Only canonical project database hosts and HTTPS origins are accepted.
The Firebase credential remains a secret; it is never part of this binding.

The isolated core must already contain `automation.shadowIsolation` equal to
`shadowIsolationMarker(resolveShadowBinding({config, envRead}))`. This marker
binds the complete reviewed configuration, including its source identity and
reference. The runtime never initializes it in an arbitrary existing database.
Provision and review the isolated snapshot separately; do not add this marker
to the productive core. Every read, every request including a replay, and each
CAS mutation before and after applying its change check the marker.

Terraform accepts an optional `shadow_binding` object and passes it to all
three roles. It neither creates a Firebase clone nor activates provider calls.

## Still required before a genuine trial

Storage isolation alone is not permission to spend or to act externally.
Provider calls, Gmail acquisition and Tasks dispatch still retain the existing
effect gates. A subsequent commissioning capability must allow only approved
source reads, provider calls and isolated domain mutations, while preserving
the real cost policy, reservations, ambiguous-outcome handling and aggregate
monthly cap. In particular, a second database must not create a second,
independently spendable copy of the user's monthly allowance.

Before enabling that capability, verify the C2 deployment actually uses the
isolated project and tenant; establish how current production sources enter
the isolated workset without replaying old external actions; verify storage,
job-token and artifact bindings; and prove monitor/watchdog and notification
delivery. Test mutation results and notes must remain visibly distinguishable
from productive completion. Only actual observed slots count toward the trial.

No live gates, credentials, IAM grants, source data, provider permissions or
trial records are changed by this code package.

## Shared monthly allocation accounting

`reserveCommissioningWithMonthlyCap` can reserve an immutable, explicitly
approved hold in the authoritative source core's cost ledger, under its current
leadership fence and fresh cost policy. Productive reservations and holds share
the same CAS and USD 50 Zurich calendar-month ceiling. A hold is counted in full
as an open obligation for its original month, including after approval expiry.
Retries cannot duplicate it or change its binding, amount or approval. There is
no release operation, automatic expiry refund or provider dispatch permission.
Malformed allocation records block normal cost reads and reservations as well.
Existing cores without allocations remain compatible.

This is accounting infrastructure, not an authenticated approval endpoint:
`approvedBy` and `approvalRef` are immutable records, not proof of caller identity.
No runtime route currently exposes or creates these holds. Before activating
commissioning, the authenticated source broker must bind reviewed authorization
to the exact isolation binding, allocate child claims only within the held sum,
and fence restored or copied child stores against replay. The source ledger must
remain authoritative for obligations throughout ambiguous replies and restores.
Day/run/call limits and actual provider settlement also remain required. A cloned
ledger, a caller-supplied approval object or a held amount alone grants no right
to spend. No real allocation or trial was created by this implementation.

## Source-ledger child calls

The normal cost reducer and adapter now accept an optional internal
`commissioning` binding containing `allocationId`, `bindingHash` and a stable
`operationId`. This does not expose an endpoint or change activation gates.
The authenticated broker must provide these values from its reviewed run/job
identity, not accept a fresh identity from a restored child's request.

Each child call lives in the existing authoritative `callsById` ledger. Its
maximum commitment consumes the allocation once. All children together must
fit the held maximum, including settled and released calls. Reusing an
operation with a new call ID conflicts; dropping or changing its binding also
conflicts. Ordinary day/run/call limits, cost-policy checks, source leadership,
claim-once, ambiguous outcomes and settlement continue to use the existing
cost machinery. Provider dispatch checks allocation expiry both in the CAS
claim and again after the final awaited source read, immediately before send.

Monthly accounting keeps the allocation's full maximum reserved: settlement
moves its covered amount from open to settled without charging it twice.
Actual cost above an individual reservation is added and blocks new work under
the existing overrun rule. Release does not free the parent hold or make its
operation reusable. Missing, foreign, malformed or overcommitted child links
fail closed for ordinary cost reads as well.

The remaining commissioning ingress must authenticate the shadow principal,
verify the exact source/isolation deployment binding, derive stable operation
identities across child restore/retry, enforce approved model/request scope,
and execute through the source cost adapter. This package does not configure
that ingress, permit shadow external effects, or prove the full restore drill.

## Authenticated admission before broker activation

`createCommissioningIngress` builds a single POST route at
`/v4/commissioning/respond` using the existing Google RS256 OIDC router. It is
not mounted by the production entrypoint. Reviewed server authority fixes the
exact audience, shadow service account, source/shadow projects and tenants,
allocation and isolation binding, model, instruction/tool profile hashes,
allowed run keys and bounded step range. Callers supply only a permitted run,
section and step plus serialized model input. Input remains context data; it
cannot select instructions, tools, provider credentials, cost policy or IDs.

`bindCommissioningSourcePort` requires explicit matching source Firebase
credentials/database configuration and forbids refresh-token fallback. Its
branded port rejects a shadow marker on every read, receipt replay and CAS
mutation. Admission requires that branded source port and the actual held
allocation. Tokens are rechecked for expiry after the source read.

Operation identity is a hash of the approved allocation/binding and canonical
run/section/step tuple, independent of request UUID and input bytes. Changed
bytes keep that identity and conflict with the source call already recorded.
Admission produces an in-process capability; serializing or constructing an
object cannot reproduce it. The cost adapter optionally consumes this
capability, binds its exact prepared model request and checks it with fresh
source data before reservation/claim and after the final awaited read before
send. This adds no general permission to bypass existing effect gates.

Missing execution returns an explicit 503. The actual broker coordinator,
source lease acquisition/release, persisted response recovery, deployment/IAM
and the narrowly scoped commissioning effect capability are still required.
Admission tests use real signatures and existing reducers/adapter with
synthetic credentials, prices and provider responses; they do not establish a
running broker, successful production access or any day of the real trial.
