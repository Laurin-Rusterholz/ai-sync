# Quantus v3 atomic command receipts

This is an inactive service component, not a deployed command API or authorization
system. Existing production routes do not import it. It must be composed with the
reviewed identity, object-authorization, schema, domain and fencing checks before
the v3 routes may accept writes.

## Transaction boundary

`prepareIdempotentCommand` runs once after verified authentication, outside CAS.
The service supplies the real principal/tenant, header idempotency key, validated
command, request ID and fixed server timestamp. The private command snapshot is
deeply frozen. Canonical JSON rejects unsupported values rather than silently
hashing different requests alike; the complete canonical request is limited to
64 KiB. Transport bytes and business payload schemas still need their own checks.

`applyIdempotentCommand` runs synchronously inside `mutateAppData`. It reads the
receipt from the same snapshot as the domain data. A new request returns one data
mutation containing the domain change, any domain-created dispatch intent, global
revision and immutable confirmed response. There is no I/O in this module. The
domain reducer must not make provider calls or send anything, even on a CAS retry.
It owns entity versions. Global revision may be left unchanged or incremented
once by the reducer; the transaction envelope always commits exactly one advance.
The reducer cannot replace the existing idempotency ledger or spoof response
status, timestamp, revision or request ID.

An exact replay bypasses the domain reducer and returns the stored response with
`replayed: true`. `mutateAppData` handles this as `unchanged: true`, verifies that
the data really is byte-identical to its parsed input and performs no PUT. This
also means a lost HTTP reply after a successful write can be recovered safely.
Request keys are scoped by a length-safe tuple of tenant and principal. Changed
content under the same scoped key produces 409 `idempotency_conflict`.

Authentication and current object permissions must be checked even on a replay;
a receipt is not an access grant. Do not put those checks only inside the reducer,
which is intentionally skipped for a replay. The integration must not accept an
arbitrary caller-chosen principal, tenant, clock or storage path.

## Retention and restore boundary

Active receipts remain valid for 60 days. A known older receipt or an `archived`
marker returns 409 `replay_too_old`. The immutable archive lookup is a later
component; this one never deletes a key. After an archive is verified, its stable
compact marker must remain discoverable in the authoritative deduplication index.
Removing a key and treating a later replay as new would violate the contract.

This package does not yet prove archive/restore safety, mail dispatch, cost
reservation, source uniqueness or user/agent conflict priority. It makes no claim
that the full T04-T07 or T20-T40 release gates have passed at the HTTP boundary.

## Evidence

`tests/quantus-v3-idempotency.test.mjs` uses the production Firebase CAS loop with
only its transport replaced by a conditional in-memory store. Tests cover truly
concurrent duplicate requests, competing entity versions, committed writes with
lost replies, bounded CAS retries, invalid/missing core, immutable response copies,
malformed JSON, scoped keys, expired/archive records and no-write replays.
No live data, credentials, sends or model calls are used.
