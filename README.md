# RCloud

Cloud-first persistent runtime prototype using Cloudflare Workers, Durable Objects, alarms, cron bootstrap, GitHub as a durable control plane, and a bounded Workers AI executor.

## Current runtime

- `GET /health` — deployed version and runtime identity.
- `GET /state` — durable runtime state.
- `GET /loop/status` — self-rescheduling alarm evidence and next wake.
- `GET /mailbox/status` — last GitHub mailbox receipt, recent receipt history, last AI result, and recent polling observations.
- Public HTTP surface is read-only. Runtime mutations are accepted only through `control/mailbox.json` on GitHub main.

## Mailbox schema

```json
{
  "schema_version": 1,
  "request_id": "globally-unique-id",
  "action": "NOOP | START_LOOP | STOP_LOOP | AI_PROMPT",
  "issued_at": "ISO-8601 timestamp",
  "payload": {}
}
```

`request_id` is intended to be the idempotency key. Each command gets a SHA-256 fingerprint over its execution-relevant fields. **Current v0.10 implementation only compares against the immediately preceding request.** Therefore it suppresses consecutive re-reads of the same mailbox command and rejects an immediate same-ID/different-payload collision, but it does **not yet provide global idempotency after a different request has been processed**. Example: `A → B → A` can execute A twice. This is a correctness gap, not a verified capability. The next hardening step is a bounded durable request ledger keyed by `request_id`, retaining fingerprint and terminal receipt so any retained ID is duplicate/collision checked independently of mailbox order.

The latest 20 receipts are retained as operational evidence, but receipt history alone is not currently used as the idempotency index.

Cron polls the mailbox once per minute and retries transient fetch/execution failures up to three times with bounded exponential backoff. Poll outcomes are retained in Durable Object storage for observability.

For `AI_PROMPT`, `payload.prompt` must be non-empty and at most 4,000 characters. The executor caps generation at 512 tokens and persists the bounded result in Durable Object storage. It has no credentialed external side-effect tools.

## Safety model

The repository is the authority for commands. Do not put credentials or secrets in `control/mailbox.json`, source files, commit history, logs, or public receipts. Any future executor requiring credentials must use Cloudflare secrets/bindings rather than repository content. Public HTTP endpoints remain read-only.

The command fingerprint intentionally excludes `issued_at`: changing metadata alone does not create a new side effect. A genuinely new execution must use a new `request_id`.

Before credentialed or irreversible executors are added, RCloud must replace last-request-only suppression with the durable request ledger and define recovery semantics for `PROCESSING` entries. No irreversible side effect should be promoted while execution is merely at-least-once.

## Evidence policy

Repository state proves only what was committed. Runtime capabilities are promoted to PASS only from deployed runtime evidence. In particular, a commit containing an executor is not proof that Cloudflare deployed it or that the executor ran.

Previously verified manually: Worker health, Durable Object persistence across redeploy, and one-shot Durable Object alarm execution. The runtime records up to 20 alarm firings so repeated self-rescheduling can be verified without relying on browser timing. GitHub mailbox control, durable non-consecutive idempotency, collision rejection, retry evidence, repeated self-loop execution, and Workers AI execution remain canary/pending until deployed runtime evidence confirms them.

Current AI canary: `AI-CANARY-001` requests the exact response `RCLOUD_AI_ALIVE`. Promotion requires a deployed `/mailbox/status` receipt proving execution; repository code or a successful commit alone is not sufficient evidence.
