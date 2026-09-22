# Durable request ledger — implementation contract

Status: REQUIRED before credentialed or irreversible executors.

## Problem

v0.10 stores only `mailbox_last_request_id` and `mailbox_last_fingerprint`. This protects consecutive polling of an unchanged mailbox, but does not protect `A → B → A`. The second A can execute again.

## Minimal durable model

Store a bounded ledger in Durable Object storage keyed by request ID:

```text
request_ledger = {
  request_id: {
    fingerprint,
    state: PROCESSING | COMPLETED | REJECTED | FAILED_RETRYABLE,
    first_seen_at,
    updated_at,
    receipt
  }
}
request_order = [request_id, ...]
```

Keep at least the latest 100 terminal request IDs for the prototype. Never evict `PROCESSING` entries. Eviction is oldest-terminal-first. A production executor with irreversible side effects needs a retention policy tied to the external idempotency horizon rather than an arbitrary count.

## Admission rules

1. Compute fingerprint from schema version, request ID, action and payload.
2. If request ID is absent: create `PROCESSING` before invoking the executor.
3. If request ID exists with a different fingerprint: reject `REQUEST_ID_COLLISION`; do not invoke executor.
4. If request ID exists as `COMPLETED` or `REJECTED` with same fingerprint: return stored terminal receipt; do not invoke executor.
5. If request ID exists as `PROCESSING`: do not blindly re-run. Return/record `IN_FLIGHT_OR_INTERRUPTED` until action-specific recovery resolves it.
6. `FAILED_RETRYABLE` may be retried only when the action explicitly declares retry safety.

## Crash semantics

Durable admission must happen before the external side effect. A crash after admission but before terminal receipt creates ambiguity. Therefore executor classes must declare one of:

- `PURE`: safe to recompute; no external side effect. Workers AI inference is treated as bounded/recomputable but can consume quota.
- `IDEMPOTENT_EXTERNAL`: retry only with the same idempotency key propagated to the external service.
- `IRREVERSIBLE`: automatic retry forbidden after ambiguous failure; requires reconciliation/receipt lookup.

RCloud must not infer success from a timeout.

## Canary matrix

The implementation is not PASS until deployed evidence demonstrates:

- `A → A`: second A does not execute.
- `A → B → A`: final A does not execute.
- `A(payload=1) → A(payload=2)`: collision rejected.
- forced executor failure: terminal/retry state is explicit; no false `COMPLETED`.
- simulated `PROCESSING` recovery: no blind duplicate side effect.

## Promotion rule

Repository code and unit reasoning are insufficient. PASS requires runtime receipts from the deployed Durable Object showing the above transitions.
