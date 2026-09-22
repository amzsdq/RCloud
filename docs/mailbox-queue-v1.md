# Mailbox Queue v1

## Why this is the next control-plane primitive

The current `control/mailbox.json` is a single mutable slot. It is sufficient for canaries but not sufficient for the RCloud goal of self-wake and cross-worker wake: two producers can race, a later commit can replace an unobserved command, and one-minute polling creates a real overwrite window. Durable idempotency prevents duplicate execution but does not prevent command loss before observation.

## Minimal design

Use one append-only GitHub file per request under `control/requests/`:

`control/requests/<request_id>.json`

The filename and body `request_id` MUST match. Producers create a new file and never mutate an existing request. GitHub create-file conflict therefore becomes a natural duplicate/collision signal rather than an overwrite hazard.

Schema stays intentionally close to the current command schema:

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

1. Cron wakes once per minute as today.
2. Fetch a bounded page of request filenames from GitHub main, oldest first.
3. For each request not already terminal in the Durable Object request ledger, fetch the immutable body and validate filename/body identity.
4. Run the existing `processMailbox()` path unchanged. The Durable Object ledger remains the execution idempotency authority.
5. Persist receipt/ledger state before advancing.
6. Process at most a bounded batch per cron invocation so one backlog cannot monopolize the Worker.
7. Keep `control/mailbox.json` temporarily as a compatibility/canary path until queue canaries pass, then remove its role as the production transport.

## Delivery semantics

The intended guarantee is at-least-once observation plus effectively-once execution within the retained Durable ledger window. GitHub stores the immutable request; Cloudflare may observe it repeatedly; the Durable Object ledger suppresses repeated side effects.

A producer considers delivery complete only after the target `request_id` appears in deployed `/mailbox/status` with a terminal receipt. A GitHub commit alone is not delivery proof.

## Backpressure and retention

Do not scan unbounded history every minute. The consumer maintains a durable cursor/checkpoint and reads a bounded batch. Processed request files may remain as audit evidence initially; compaction/archival is a later optimization and MUST NOT be required for correctness.

If backlog age or depth exceeds a configured threshold, expose it through observability and continue bounded draining. Do not silently drop old requests.

## Multi-target extension

`target` is explicit now so the transport does not have to be redesigned for cross-worker wake. v1 may accept only `runtime:main`; unknown targets are rejected with a durable receipt. Later adapters can map stable target IDs to other cloud executors or wake transports without changing request identity/idempotency semantics.

## Security floor

- Public GitHub content is command data only, never secret material.
- Credentialed executors remain behind Cloudflare bindings/secrets.
- Unknown action/target/schema is rejected.
- Immutable request files are never edited after creation.
- Irreversible executors retain the existing ambiguous-outcome rule: no blind replay.

## Canary sequence before promotion

1. enqueue A and B before one cron tick; prove both receive terminal receipts;
2. re-observe A; prove no second execution;
3. attempt same request ID with different body; prove create conflict or runtime collision rejection;
4. enqueue 10 NOOP requests; prove bounded drain without loss;
5. stop/redeploy consumer with pending requests; prove pending requests survive and drain after recovery;
6. only then promote queue transport over the single-slot mailbox.

This deliberately reuses GitHub immutable files, the existing cron, Durable Object ledger, receipts, and external evidence workflow rather than introducing a new broker.