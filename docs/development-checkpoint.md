# RCloud development checkpoint

Updated: 2026-09-22 19:30 KST

## Confirmed deployed evidence

- Self-rescheduling Durable Object loop: PASS (multiple consecutive fires and next alarm observed).
- GitHub mailbox -> cron -> Workers AI -> durable receipt: PASS.
- Same-ID/different-fingerprint rejection: PASS under hardened runtime evidence.
- Non-consecutive A -> B -> A suppression: PASS under hardened exact-command correlation in run 35715423144.
- Deployed v0.12.2 was observed by the hardened probe.

## Work completed this run

1. Added loss-resistant queue namespace: immutable `control/requests/<request_id>.json` bodies plus ordered `control/queue-index.json`.
2. Added `src/queue.js` bounded queue transport with cache-busted reads, path/body identity validation, explicit `runtime:main` target fence, retry, and per-item error isolation so one poison item does not block later requests.
3. Added `src/worker.js` queue-capable entrypoint while preserving exported Durable Object class name/storage identity and legacy mailbox/loop path. Added `/queue/status` and queue poll history.
4. Switched `wrangler.jsonc` entrypoint to queue-capable worker and exposed runtime version `0.13.0` for deployed correlation.
5. Added unit tests and lightweight unit workflow. Latest observed unit run 35716142963 succeeded before the final safety gate change; final source change has a new queued evidence cycle.
6. Added dedicated `queue-evidence` workflow and enqueued side-effect-free `QUEUE-CANARY-A` + `QUEUE-CANARY-B` before one poll.
7. Extended runtime-evidence mailbox wait to two cron windows to avoid false negatives caused by cron phase/propagation timing.

## Important correctness finding / hard floor

The request ledger is finite (retained window), while immutable queue requests may live indefinitely. Therefore ledger membership alone cannot be the long-term queue replay barrier: after ledger eviction, an old request could be observed as new and replay a side effect.

Until a monotonic durable `queue_cursor` is implemented and deployed, the experimental queue is intentionally gated to `NOOP` only (`QUEUE_ACTION_NOT_PROMOTED`). This keeps current A/B canaries safe while preventing AI or other side effects from being promoted prematurely.

## Next implementation order

1. Implement monotonic Durable Object `queue_cursor`: terminal receipt persisted -> cursor persisted -> item consumed.
2. Distinguish transient fetch failure (do not advance) from immutable invalid request (durable transport rejection then advance).
3. Verify deployed v0.13.0 `/queue/status` and A+B terminal receipts using `queue-evidence`.
4. Canary 10 NOOP backlog, redeploy-with-pending, and safe ledger-eviction replay test.
5. Only after cursor canaries pass, lift NOOP-only gate and promote queue transport for real self/cross-worker wake requests.
6. Then implement target routing/wake adapters, stale-PROCESSING deployed canary, retry/stop/observability hardening.

Latest strict production evidence remains v0.12.2 until queue-evidence proves v0.13.0 deployment.