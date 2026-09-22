# RCloud development checkpoint

Updated: 2026-09-22 19:20 KST

## Confirmed deployed evidence

- Self-rescheduling Durable Object loop: PASS (multiple consecutive fires and next alarm observed).
- GitHub mailbox -> cron -> Workers AI -> durable receipt: PASS.
- Same-ID/different-fingerprint rejection: PASS under the hardened predicate in runtime-evidence run 35714954029. The canary required the deployed poll to report LEDGER-CANARY-A as REJECTED with REQUEST_ID_COLLISION semantics, not merely find an old ledger ID.
- Deployed runtime version 0.12.0 was observed in run 35715053588.

## Correctness findings this run

1. The original evidence predicate produced false positives because an already-retained request_id was enough to satisfy the wait condition.
2. The predicate was hardened to correlate request ID, fingerprint, issued_at-relative poll time, and expected receipt transition.
3. Non-consecutive A -> B -> A strict revalidation (run 35715053588) failed: current A-v1 was expected to be DUPLICATE but the deployed poll still reported REJECTED. The current GitHub command is byte-for-byte execution-equivalent to original A-v1 (issued_at is intentionally excluded from the fingerprint).
4. Most likely transport cause: the Worker fetched raw.githubusercontent.com/main without a cache-busting URL and re-observed the prior A-v2 collision payload. This is treated as a control-plane stale-read defect, not as an idempotency PASS/FAIL result.

## Main changes awaiting/under deployed verification

- a5b42080: runtime evidence reads the mailbox from immutable trigger commit github.sha.
- 6717f5d6: Worker mailbox fetch uses a per-poll cache-busting query and no-store.
- 0ea6c15c: source version 0.12.2 records command_issued_at and observed_fingerprint in every successful mailbox poll.
- 85e2b806: evidence correlates the exact observed command identity when v0.12.2 telemetry is available.
- 8a78c851: stale PROCESSING observability plus QUARANTINE_STALE. It never replays an executor; >=5 minute stale entries are terminalized as FAILED_AMBIGUOUS while outcome_still_ambiguous remains explicit.

Latest evidence run at checkpoint: 35715423144, queued.

## Next

1. Inspect run 35715423144 / next non-cancelled run and verify deployed v0.12.2.
2. Require LEDGER-CANARY-A/A-v1 to produce a post-issued_at poll with matching observed_fingerprint and receipt_status=DUPLICATE; only then promote A -> B -> A to PASS.
3. Return mailbox to a fresh neutral NOOP after the canary.
4. Add a deployed stale-PROCESSING/quarantine canary without introducing a replay-capable recovery path.
5. Verify forced mailbox-fetch retry/failure observability, then proceed to broader stop/recovery and routing/wake work.
