# RCloud development checkpoint

Updated: 2026-09-22 19:24 KST

## Confirmed deployed evidence

- Self-rescheduling Durable Object loop: PASS (multiple consecutive fires and next alarm observed).
- GitHub mailbox -> cron -> Workers AI -> durable receipt: PASS.
- Same-ID/different-fingerprint rejection: PASS under hardened runtime evidence.
- Non-consecutive A -> B -> A suppression: PASS under hardened exact-command correlation in run 35715423144.
- Deployed v0.12.2 was observed by the hardened probe.

## Correctness findings

1. The original evidence predicate could false-positive on an already-retained request ID; it now correlates request ID, fingerprint, issued-at-relative poll time, and expected receipt transition.
2. GitHub raw mailbox caching caused stale command observation. Worker mailbox reads now use cache busting/no-store and the evidence workflow pins expected input to the trigger commit.
3. Durable ledger correctness now covers non-consecutive duplicates and request-ID collisions for retained entries.
4. Stale PROCESSING is observable and can be quarantined to FAILED_AMBIGUOUS without replay.
5. New highest-value transport gap: `control/mailbox.json` is a single mutable slot. Idempotency prevents duplicate execution but cannot prevent an unobserved request from being overwritten by a second producer. This is unacceptable for self-wake/cross-worker wake as the number of producers grows.

## Queue decision

Adopt the minimal append-only request queue specified in `docs/mailbox-queue-v1.md`: one immutable GitHub file per request, existing cron as consumer wake, existing Durable Object ledger as execution-idempotency authority, bounded draining, and explicit target IDs. Keep the current mailbox temporarily only for compatibility/canaries until queue deployed canaries pass.

This is preferred over adding a new broker because it reuses already-proven GitHub durable state, cron, Durable Object ledger, receipts, and runtime-evidence primitives.

## Next implementation order

1. Implement bounded `control/requests/<request_id>.json` queue consumption while preserving current single-slot mailbox compatibility.
2. Canary: enqueue A+B before one cron tick and prove both terminal receipts; then 10 NOOP backlog, redeploy-with-pending, and duplicate/collision checks.
3. Add queue depth/oldest-age/last-success observability and durable consumer cursor/checkpoint.
4. Add a deployed stale-PROCESSING/quarantine canary without introducing replay-capable recovery.
5. Verify forced mailbox-fetch retry/failure observability.
6. Promote queue transport, then proceed to target routing/wake adapters and broader stop/recovery.

Latest strict evidence before this checkpoint: runtime-evidence run 35715423144, SUCCESS, deployed v0.12.2, A -> B -> A DUPLICATE PASS.