# Source commissioning broker

This separate Terraform root deploys the existing commissioning server in the
**source project**, using the same digest-pinned runtime image as the isolated
worker. It does not activate ordinary production workers, reserve a source
allocation, enable APIs, generate keys, create secret values or start a scheduler.
The configuration and offline evidence are not evidence of a deployed service.

The dedicated Cloud Run command is
`node runtime/quantus-v3/src/commissioning-server.mjs`. The full response route is
registered as a custom audience. An authoritative `roles/run.invoker` binding
allows only the reviewed shadow worker account; application authentication checks
that same signed identity independently. The cross-project route permits network
ingress because no shared VPC is assumed, but does not permit anonymous invocation.
The client sends the token in both `X-Serverless-Authorization` (Cloud Run) and
`Authorization` (application). See Google's
[service identity authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
and [custom audiences](https://docs.cloud.google.com/run/docs/configuring/custom-audiences).
An organization requiring internal-only traffic needs an explicitly proven
cross-project VPC route before changing the ingress configuration.

## Configuration and identity

Supply real values in a separate, uncommitted variable file. The file under
`tests/` contains synthetic fixtures and must never be used for deployment.
The source project, source tenant and canonical Firebase URL must already exist.
The shadow project/tenant must be distinct, and the caller must belong to it.
`commissioning` contains the existing source allocation ID, isolation binding hash,
exact reviewed instruction/tool profile hashes, unique allowed run keys and maximum
step index. Deployment does not create that allocation. Runtime admission checks
its current authority, budget and source cost ledger on each call.

Exactly three pre-existing secret references with pinned numeric versions are
accepted: `firebase`, `openai`, `cost_policy`. Only the dedicated broker account
receives access. The Firebase credential must identify the **same account as the
attached broker service account**, in the source project. The runtime checks this
before admitting requests. This matters because the current CAS and Google access
token adapters both use that credential. The deployment grants its private bucket
get/create permissions to that exact account, without object delete or list rights.
Firebase access to the existing source ledger must be granted and verified
separately; this module cannot infer the existing database's authorization model.
No key is created or read by Terraform, and the source credential/provider key must
never be copied into the isolated worker. Policy changes require a new pinned
secret version and revision; deployers must verify the policy's effective window,
rates and approval against the current ledger before any call.

The response bucket enforces public-access prevention and uniform access, with no
forced deletion or automatic expiry. Cloud Run has deletion protection. Retained
receipts are needed to recover uncertain outcomes without repeating a paid call.
Private image repository access, enabled Cloud Run/Secret Manager/Storage/IAM APIs,
and deployer permissions are prerequisites. No broad project role is added here.

`worker_connection` is the public connection object consumed by
`infra/quantus-v3`'s `commissioning_worker.connection`; profile IDs/hashes and the
route audience derive from this exact source configuration. Use the same isolation
binding and allocation, verify the caller's actual attached account, and separately
configure bounded Tasks permission in the isolated deployment. Do not mark any
ordinary activation or 14-day-trial gate passed merely because deployment succeeds.

## Offline proof

From this directory, using Terraform 1.13.3 and the locked production Node
dependencies from the repository root:

```sh
terraform fmt -check -recursive
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test -var-file=tests/broker-fixture.json -json -verbose > /tmp/quantus-broker-tests.jsonl
node ../../scripts/check-quantus-broker-env.mjs /tmp/quantus-broker-tests.jsonl
```

Terraform's Google mock renders the real service and IAM resources. Negative cases
reject shared projects, foreign callers/databases, mutable images, extra credentials
and unpinned secret versions. The bridge consumes the actual rendered environment,
constructs the actual source service and executes its authentication, source
allocation, provider journal and replay paths against synthetic CAS/artifact/token
dependencies. A call without a source allocation cannot spend; two identical
authorized requests produce one synthetic provider response. All real network use
is disabled. Real front-door authentication, credential permissions, budget review,
source/isolated readback, recovery and the genuine 14-day trial remain required.
