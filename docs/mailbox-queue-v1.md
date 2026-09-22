# Mailbox Queue v1

## Why this is the next control-plane primitive

The current `control/mailbox.json` is a single mutable slot. It is sufficient for canaries but not sufficient for self-wake and cross-worker wake: a later producer can replace an unobserved command. Durable idempotency prevents duplicate execution but does not prevent loss before observation.

## Minimal design

Use one immutable GitHub file per request under `control/requests/` plus ordered `control/queue-index.json`. Producers create request files, never mutate them, and update the manifest with optimistic GitHub SHA semantics so concurrent writers conflict/retry instead of silently overwriting.

```json
{
  "schema_version": 1,
  "request_id": "globally-unique-id",
  "target": "runtime:main",
  "action": "NOOP | START_LOOP | STOP_LOOP | AI_PROMPT | QUARANTINE_STALE",
  "issued_at": "ISO-8601 timestamp",
  "payload": {}
}
```

No credentials or secrets are allowed in request files.

## Consumer algorithm

1. Cron wakes once per minute.
2. Fetch ordered manifest from GitHub main.
3. Read durable `queue_cursor` from the Durable Object. The cursor, not the finite request ledger, is the long-term replay barrier.
4. Starting at the cursor, fetch a bounded batch and validate filename/body identity and target.
5. Execute through existing `processMailbox()`; the request ledger remains the side-effect idempotency authority for in-flight/recent requests.
6. Persist terminal receipt before advancing the cursor.
7. Persist cursor before considering an item consumed.
8. Keep the old single-slot mailbox only for compatibility/canaries until queue canaries pass.

## Critical retention invariant

The Durable request ledger is finite. Therefore **queue promotion is blocked until durable cursor semantics exist**. Ledger membership alone cannot be the long-term processed marker: after an old terminal entry is evicted, an immutable queue request still present in the manifest could otherwise replay an old side effect.

The cursor is monotonic over the append-only manifest. Producers MUST NOT reorder/delete entries at or beyond the cursor. Prefix compaction requires a later explicit base-offset/version protocol and is not part of v1.

## Poison/transient failure rule

A malformed immutable request must not head-of-line block forever, while transient fetch failure must not be consumed.

- network/HTTP availability failure: do not advance; retry later;
- immutable schema/body-ID/target violation: persist durable transport-rejection receipt, then advance;
- executor `FAILED_AMBIGUOUS`: persist terminal ambiguous receipt and advance; never blindly replay;
- `PROCESSING`: do not execute again; stale reconciliation policy applies.

## Delivery semantics

Target guarantee is at-least-once observation plus effectively-once execution. A producer considers delivery complete only after deployed runtime evidence contains a terminal receipt. A GitHub commit alone is not delivery proof.

## Backpressure and observability

Process a bounded batch per cron. Expose backlog depth, oldest pending age, cursor position, last successful queue poll, and last queue error. Never silently drop old requests.

## Multi-target extension

`target` is explicit now so transport need not be redesigned for cross-worker wake. v1 accepts only `runtime:main`; unknown targets receive a durable transport rejection. Later adapters may map stable target IDs to other cloud executors/wake transports.

## Security floor

- Public GitHub content is command data only, never secret material.
- Credentialed executors remain behind Cloudflare bindings/secrets.
- Unknown action/target/schema is rejected.
- Immutable request files are never edited after creation.
- Irreversible executors retain the ambiguous-outcome rule: no blind replay.

## Canary sequence before promotion

1. enqueue A+B before one cron tick; prove both terminal receipts;
2. re-observe A; prove no second execution;
3. same request ID/different body; prove conflict/collision rejection;
4. enqueue 10 NOOP requests; prove bounded drain without loss;
5. redeploy with pending requests; prove survival and drain;
6. force safe NOOP ledger eviction and prove consumed queue entries do not replay because durable cursor is authoritative;
7. only then promote queue over the single-slot mailbox.

This reuses GitHub durable state, existing cron, Durable Object ledger, receipts, and external evidence rather than adding a broker.