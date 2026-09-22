# RCloud development checkpoint

Updated: 2026-09-22 19:31 KST

## Confirmed deployed evidence

- Self-rescheduling Durable Object loop: PASS.
- GitHub mailbox -> cron -> Workers AI -> durable receipt: PASS.
- Same-ID/different-fingerprint rejection: PASS.
- Non-consecutive A -> B -> A suppression: PASS (runtime-evidence 35715423144).
- Queue-capable runtime v0.13.0 deployment: PASS (`queue-evidence` 35716287947, SUCCESS). `/health` and `/queue/status` both returned v0.13.0.

## Work completed this run

1. Added immutable `control/requests/<request_id>.json` queue bodies and ordered `control/queue-index.json`.
2. Added bounded queue transport with retry, path/body identity validation, explicit `runtime:main` target fence, and per-item isolation so a poison item cannot block later work.
3. Added queue-capable worker entrypoint without renaming the existing Durable Object binding/class; legacy mailbox and loop remain active during canary.
4. Added `/queue/status`, queue poll history, unit tests, unit workflow, and dedicated deployed queue evidence workflow.
5. Enqueued side-effect-free `QUEUE-CANARY-A` + `QUEUE-CANARY-B` before one poll.
6. Extended mailbox runtime-evidence wait to two cron windows to reduce cron-phase false negatives.
7. Added hard safety gate: experimental queue accepts `NOOP` only until durable cursor correctness is proven.

## Correctness findings / hard floors

### Finite-ledger replay hazard

The request ledger is finite while immutable queue requests may live indefinitely. Ledger membership alone cannot be the long-term queue replay barrier. After ledger eviction an old queue request could otherwise replay. Queue promotion is blocked until a monotonic durable `queue_cursor` exists and is canary-proven.

### Raw GitHub branch freshness gap

Run 35716287947 proved v0.13.0 is deployed, but `/queue/status` at 10:30Z still reported `indexed: 0` for polls through 10:29Z even though fresh GitHub main contains A+B in `control/queue-index.json`. Cache-busting/no-store on `raw.githubusercontent.com/.../main/...` therefore is not sufficient evidence of prompt branch-head visibility. This is the next transport correctness issue; do not mark A+B PASS yet.

Next candidate: use the GitHub Contents API for the mutable queue manifest (bounded frequency / rate-budgeted), while immutable request bodies can be addressed by commit/blob identity stored in the manifest. Do not add credentials unless the unauthenticated rate/freshness path proves insufficient.

## Next implementation order

1. Replace mutable queue-manifest raw-main read with a freshness-correct source and measure rate budget; prefer GitHub Contents API with bounded polling and immutable body commit/blob references.
2. Implement monotonic Durable Object `queue_cursor`: terminal receipt -> persisted cursor -> consumed.
3. Re-run A+B same-window canary and prove both terminal receipts.
4. Canary 10 NOOP backlog, redeploy-with-pending, and safe ledger-eviction replay test.
5. Only then lift NOOP-only gate and promote queue for real self/cross-worker wake requests.
6. Proceed to target routing/wake adapters, stale-PROCESSING canary, retry/stop/observability.
