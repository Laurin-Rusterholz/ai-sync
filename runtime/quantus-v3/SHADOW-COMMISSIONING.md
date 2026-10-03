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
