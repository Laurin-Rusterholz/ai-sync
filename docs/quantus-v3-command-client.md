# Durable browser command intents

This is a tested transport/queue component, **not an enabled app migration**.
No existing app writer imports it yet. It does not enable API-only storage,
prove tablet/mobile integration, or replace server authentication/authorization.

## Contract

`public/quantus-v3-command-client.mjs` is a browser-native ESM module. It has no
runtime dependency, global `window` export or top-level database/network effect.

- `serializeCommand` accepts the v3 public envelope and its 22 named verbs.
  Unknown root fields, arbitrary paths, malformed versions and non-JSON values
  are rejected. Payload is capped at 64 KiB of UTF-8. Per-verb field validation
  remains authoritative on the server.
- `createCommandTransport` defaults to writes disabled. A trusted app setting,
  not source content, must enable it after the all-writer cutover gate. It sends
  only to the configured HTTPS origin's `quantus-ingest` function, with a fresh
  Firebase user token and the unchanged operation ID as idempotency key.
  Redirects and ambient cookies are disabled. User tokens are never persisted.
- `openCommandQueue` creates an IndexedDB intent journal. Each key is the pair
  of account identity and operation ID. `enqueue` resolves only after the
  read/write transaction commits. Reusing a key for changed content is an error.
  Failure to open or persist storage is visible; no in-memory success fallback.
- Each command retains its original payload, expected entity version and ID.
  A conflict is retained for reevaluation, never silently rebased to the current
  server version. Signing in resumes only that account's auth-held operations.
- A local timestamp orders intents and controls retry delays. It never decides
  which version of business data wins. No domain snapshot or run cache is sent.
- Unknown legacy operations can be retained as `legacy_unmapped`; they are
  never automatically converted to root uploads or dispatched as commands.
  Existing legacy storage is not deleted or changed by this component.

## Outcomes

A server dry-run or `503 api_writes_disabled` pauses dispatch without consuming
attempts or acknowledging the intent. The original pending operation survives
reload and resumes with the same key when writes are enabled. Explicit
`applied: false` or `dryRun: true` can never be stored as a commit receipt, even
if a custom transport incorrectly labels it successful.

| State | Meaning |
| --- | --- |
| `pending` | Saved locally, not server-confirmed |
| `retry_wait` | Temporary failure or unknown outcome; same key only |
| `acknowledged` | Valid server receipt persisted locally |
| `needs_sign_in` | Matching user must sign in again |
| `conflict` | Server rejected an obsolete or conflicting operation |
| `upgrade_required` | Server requires a new client; keep original intent |
| `needs_review` | Permanent error, malformed retry delay or retry exhaustion |
| `legacy_unmapped` | Preserved old operation requires explicit mapping |

Transient retries are bounded to five attempts, with 30-second exponential
backoff capped at ten minutes. A longer valid `Retry-After` is respected rather
than capped. No blind retry follows an authentication, authorization, schema or
version rejection. An acknowledged entry is not deleted and cannot be downgraded
by a delayed failure from another tab. Concurrent tabs may deliver the same key;
the server's atomic idempotency ledger, not a device lock, ensures one effect.

## Verification

`npm run test:assistant-client` exercises real IndexedDB transactions through
`fake-indexeddb` 6.2.5, including independent connections, concurrent inserts,
account switching, interrupted replies, conflict retention and retry limits.
The suite has 36 tests, including dry-run/disabled-server persistence and
recovery. A separate composition with the proposed C2 HTTP service reproduced
the dry-run false-acknowledgement and verifies this client correction.
The lost-response test composes the queue with the actual
`applyIdempotentCommand` server helper; the domain mutation happens once.
The suite is included in `npm test` and the CI path filter covers the module.

A separate Chrome check on 20 September 2026 (Europe/Zurich) used a local-only
fixture server, real Chrome IndexedDB and invented data. The server deliberately
closed the first HTTP response after committing the command:

1. Enqueue and reload: same ID, body and version remained `pending`.
2. Dispatch: server had one comment, version 18 and revision 2; the client
   correctly retained `retry_wait` with `outcome_unknown`.
3. Reload again: the uncertain entry remained durable.
4. Retry with the same key: `acknowledged`, `replayed: true`, original receipt.
   Server counts were two requests but only one committed comment; version and
   revision remained 18 and 2.

This verifies the component in Chrome, not an authenticated deployed API or a
real device-to-device sync. All three app adapters, live readback, UI handling,
offline migration and all-writer acceptance remain required before activation.
