# Quantus v3: legacy recovery boundary

The existing privileged `scripts/restore-core.mjs` is a whole-document recovery
tool, not the new v3 disaster-recovery procedure. A snapshot can contain old
leases, replay receipts, pending jobs and already delivered external actions.
Restoring that snapshot and starting runners would not prove that sending again
is safe.

## Enforced Now

- Refuse a v3 or partially migrated backup before acquiring a target lock.
- Refuse a legacy backup against a v3 or partially migrated current core.
- Recognize the actual `*ById` maps, cursor/policy markers and runtime ledger
  even without `schemaVersion` or `dataRevision`. A present but null map is
  evidence of a damaged v3 snapshot, not permission to replace it.
- Treat a nonempty unreadable wrapper as corrupt, not as a missing document.
- Retain the Firebase server ETag from the actual read, including an absent node.
- Require that exact non-wildcard ETag on the single restore write. The local
  lock only coordinates local restores; the conditional write also protects
  against other devices, servers and a migration during operator confirmation.
- Do not retry a conflict using a new ETag and an old human decision.
- Preserve unknown wrapper extension fields and record the read precondition in
  the audit intent. A conflict records no successful replacement or new ETag.

No override flag bypasses the v3 boundary. The legacy recovery flow remains
available for a genuine pre-v3 core with its existing explicit confirmation and
durable intent. Dry-run inspection still performs no remote write.

## Still Required Before Cutover

1. Make every deployed writer, including `backup-blob.mjs` through the HTTP
   compatibility facade and all privileged tools, obey the v3 cutover policy.
2. Test a hash-verified restore into an isolated project, never the live core.
3. Pause scheduling, dispatch and command writes through independently retained
   recovery controls; a restored old flag must not reactivate them.
4. Reconcile external delivery/provider receipts and idempotency archives. Hold
   uncertain outcomes without resending. Losing an archive must not make an old
   operation new.
5. Invalidate old leases and dispatch credentials, establish a new monotonic
   recovery epoch, and retain all unreconciled jobs, answers and questions.
6. Prove safe read-only rollback and explicitly approve resuming low-risk work.

The 51 local behavior tests and 218 existing restore-contract checks establish
the legacy boundary only. They do not satisfy the entire T40 acceptance test,
constitute an operational backup, or count as a day of the required real trial.
