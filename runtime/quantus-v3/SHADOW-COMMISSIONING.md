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

## Durable response recovery without productive conversation writes

`createCommissioningResponseJournal` stores one immutable private-artifact
reference on the exact source cost call. It reuses the existing artifact store,
payload validation, CAS/idempotency port, lease fencing and cost reconciliation.
It never initializes a productive run, maps a shadow run into a source run, or
writes a productive leadership conversation. Original model output lives in
private storage with generation/hash/byte and source bucket/tenant checks.

Only an admitted, already claimed call with the exact run, model, provider,
request hash and token contract may gain a response. Response recording requires
current source leadership, including after artifact I/O and inside every CAS
retry. An immutable recorded marker makes a missing pointer fail closed. A
changed response cannot reuse a successful command receipt. Readback verifies
the artifact and current pointer independently; a settled call must agree with
its retained receipt. An unknown response never becomes a settled receipt.

A response to an already claimed operation can still be recorded and reconciled
after its original token or spending window expires. This grants no permission
to dispatch. A new authenticated ingress request may recover that same claimed
operation after allocation expiry; an unclaimed or new operation remains
blocked. The cost adapter's dispatch checks are unchanged. Settlement uses only
the retained response, including recovery of a cost previously marked unknown.

Commissioning reservations now reserve core capacity for future response
references in the same CAS before any send. Failed artifact storage/readback or
failed reference persistence is visible and cannot be acknowledged as success.
A lost commit acknowledgement is recovered by reading the retained reference.
The broker coordinator must invoke this journal before returning results or
settling the normal provider path; automatic dispatch and runtime activation
remain unimplemented by this package.

## Source provider coordination

`createCommissioningBroker` connects opaque admission, a genuinely acquired
source lease, the existing cost adapter, the reviewed OpenAI transport instance
and response recovery. Each execution generates its own source holder and
acquires `sourceTenant:mainrun` through the real CAS. A currently held productive
lease returns busy; it is never stolen. Lost acquisition acknowledgement is
resolved by reading the actual lease. Cleanup releases only that holder/fence
and independently reads the resulting state, preserving replacement holders.

The broker checks for a retained response before attempting new spending. A
claimed call without a response remains unresolved and cannot be resent. A
verified settled response reconciles its cost and is returned on later requests;
a retained unknown outcome remains unknown. For new calls, reservation is
followed by a private artifact write/read preflight using a deterministic request
manifest. Provider output is persisted before the adapter settles or the HTTP
caller receives acknowledgement. Lost persistence/settlement acknowledgements
are recovered from the durable source evidence.

`createCommissioningCostAdapter` is a separate provider-only factory with a
private branded context, fixed shared monthly cap, opaque admitted operation
and branded source core. Its private `commissioning` mode is not a new ordinary
runtime mode and is not accepted by the generic configuration resolver. It does
not set or bypass the normal runtime's live/Tasks/tool/mail activation gates.
A plain mode string or constructed admission cannot invoke it. Real policy,
lease, exact prepared bytes and admission expiry remain mandatory. Reservation
and dispatch CAS retries use fresh time; dispatch verification binds the actual
committed claim timestamp rather than an earlier request timestamp.

This coordinator is not mounted or deployed by the existing server. A dedicated
source entrypoint, reviewed environment/IAM and the isolated worker's broker
client still need implementation/commissioning. No general effects, source
synchronization, Tasks scheduling or real trial evidence follows from this
module. Current tests use actual admission/CAS/artifact/cost machinery with
synthetic Google signatures, provider responses and explicit fixture policies.

## Dedicated source process

The same image now contains a separate command:

```
node runtime/quantus-v3/src/commissioning-server.mjs
```

It is not selected by the ordinary image CMD. The source service must use this
explicit command and source-project credentials. `createCommissioningService`
connects the real integration CAS port, source binding, Google OIDC keys,
fresh environment cost policy, private Cloud Storage, reviewed OpenAI transport,
broker and authenticated ingress. Startup creates no allocation and performs no
provider or storage operation. Invalid configuration serves only a generic 503;
raw configuration or credential errors are never logged.

Required reviewed configuration, in addition to the explicit Firebase service
account/project/database values, is:

- `QUANTUS_V4_COMMISSIONING_AUTHORITY_JSON`: the exact existing ingress authority.
- `QUANTUS_V4_COMMISSIONING_PROFILE_SLOTS_JSON`: a JSON object mapping every
  authority profile/section ID to a reviewed slot (`briefing04`, `process09`,
  `continue14`, `close23`). Its keys must equal the authority profile keys.
- `QUANTUS_V4_PROMPT_VERSION`, `QUANTUS_V4_OPENAI_API_KEY`,
  `QUANTUS_V4_OPENAI_MODEL`, both `QUANTUS_V4_OPENAI_*_MICROS_PER_MTOK` rates,
  `QUANTUS_V4_ARTIFACT_BUCKET`, and the fresh `QUANTUS_V3_COST_POLICY_JSON`.
- Optional `QUANTUS_V4_OPENAI_COMPACT_THRESHOLD`, with the transport's existing
  bounds. It must agree with the isolated caller's approved contract.

Profile hashes are calculated from the shared `loadV4LeadershipInstructions`
output and `leadershipToolDefinitions`, not operator-provided free-form prompt
text. The ordinary loop uses the same instructions helper. Ingress validates
exact profile hashes; execution additionally checks the run slot against its
configured section profile before source lease/cost mutation. No fixture-policy
permission is exposed by this composition.

Deployment must still establish the reviewed source Cloud Run service, invoker
IAM, isolated worker client, actual held allocation and source access. This
source entrypoint does not activate shadow scheduling, Gmail, tools or the
14-day trial. Request recovery remains through the existing source broker.

## Isolated caller transport

`createCommissioningClient` requires the branded isolated core and its immutable
reviewed binding. It checks the actual shadow lease/active section before and
after I/O, validates its Google-signed identity token for the exact approved
broker audience/service account, and sends only run, reviewed profile ID, stable
step ordinal and input JSON. The profile ID is chosen by slot, not by a changing
HTTP continuation section. No token, caller lease or role is accepted in the
body. Redirects are refused; request time and response bytes are bounded; errors
expose neither broker bodies nor tokens. There is no automatic retry.

The exported keyless `createOpenAIRequestContract` prepares the same immutable
bytes as the paid transport, with no credential or dispatch method. A source
receipt must match the allocation/binding, operation ID, run/profile/ordinal,
request hash, token contract, model and settled usage before it is returned.
Unknown outcomes stay unknown. The source broker returns these fields only from
its admitted operation and independently read cost/response evidence. The
caller creates no shadow cost reservation or copied spending authority.

The client is not yet installed into the leadership loop. That integration must
preserve the loop's run/index identity across sections, persist source receipts,
and verify source settlement when archiving journal history. The current
journal's local-cost verification cannot be satisfied with invented shadow cost
rows. A real Google ID-token source, deployment and trial still remain open.

## Isolated worker composition and workload identity

`createOpenAIWorkerPorts` now accepts shadow commissioning only through the
existing isolated core binding plus `QUANTUS_V4_COMMISSIONING_WORKER_JSON`. The
JSON object has exactly four fields: `schemaVersion: 1`, `connection`,
`isolatedDomain: true`, and `sourceReadIds`. `connection` is the reviewed broker
client configuration (audience, service account, binding hash, allocation ID
and slot/profile identities and hashes). `sourceReadIds` must exactly enumerate
the configured Gmail/mail source IDs; use an empty array for core-only work.
Unknown profiles and changed reviewed instructions/tool definitions are refused
before any briefing bootstrap. Missing permission does not fall back to a direct
provider transport.

The worker uses a keyless OpenAI request contract and the source broker; its
OpenAI API key and local cost claims are unnecessary. Preparation, genuine
answer consumption and daily finalization use the existing domain code only
inside the branded isolated core. Model tools retain the configured tool gates,
job identities, per-object authorization and isolated C2 origin. This permission
does not enable Tasks, monitor notifications or productive external actions.
The original live and dry-run rules are unchanged.

The default identity source obtains a Google-signed ID token from the fixed
Google Cloud metadata identity endpoint for the attached service account. It
checks metadata provenance, bounds time and body size, verifies signature,
recipient, account and fresh expiry, propagates cancellation and never retries
or falls back to an OAuth access token. Construction performs no network work.
No metadata or credential request is made on the developer machine by tests.

For private Cloud Run deployment, register the exact broker route audience as a
custom audience and grant the reviewed caller invocation access. The client
sends the same token in `X-Serverless-Authorization` for the Cloud Run front
door and `Authorization` for the application's independent signature check.
Google checks the dedicated header when both exist, preserving the application
credential. See [Google service-to-service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).
Actual audience configuration, workload identity, IAM, artifact and isolated C2
bindings still require deployed verification. No real trial is implied by the
synthetic metadata, broker and worker tests.

## Isolated continuation dispatch

`QUANTUS_V4_COMMISSIONING_TASKS_JSON` grants only continuation enqueueing for
a branded isolated worker or monitor. Its exact fields are `schemaVersion: 1`,
`bindingHash`, `queue`, `targetUrl`, `oidcServiceAccount`, `audience`,
`approvedAtMs` and `expiresAtMs`. The queue must belong to the isolated project;
the caller identity must also belong to it. Queue, target, service account and
audience must match the resolved runtime Tasks configuration, and the audience
is the exact `/v3/run/continue` target. The time window is checked before and
after asynchronous credential/core reads.

The resulting in-process capability cannot be recreated from JSON. Each
outgoing request must have the exact task envelope, canonical stable task name,
reviewed destination and OIDC identity, and a valid schedule. The isolated core
must retain the same pending continuation, bound to its run. Consumed/missing
intents and completed runs cannot enqueue again. A monitor's persisted
`slot_catchup` intent can schedule a never-started run. The immutable isolation
marker is rechecked immediately before sending, including after token lookup.
Caller-owned payloads are copied before asynchronous work.

This is wired into the server's existing Cloud Tasks transport without setting
generic live gates. It grants no provider, notification, productive queue or
arbitrary HTTP action. Real IAM/queue deployment, monitor warning delivery and
the observed four-slot trial remain separate required evidence.
