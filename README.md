# RCloud

Cloud-first persistent runtime prototype using Cloudflare Workers, Durable Objects, alarms, cron bootstrap, GitHub as a durable control plane, and a bounded Workers AI executor.

## Current runtime

- `GET /health` — deployed version and runtime identity.
- `GET /state` — durable runtime state.
- `GET /loop/status` — self-rescheduling alarm evidence and next wake.
- `GET /mailbox/status` — last GitHub mailbox receipt, last AI result, and recent polling observations.
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

`request_id` is the idempotency key. Re-reading the same command returns `DUPLICATE` rather than re-running its side effect. Cron polls the mailbox once per minute and retries transient fetch failures up to three times with bounded exponential backoff. Poll outcomes are retained in Durable Object storage for observability.

For `AI_PROMPT`, `payload.prompt` must be non-empty and at most 4,000 characters. The executor caps generation at 512 tokens and persists the bounded result in Durable Object storage. It has no credentialed external side-effect tools.

## Safety model

The repository is the authority for commands. Do not put credentials or secrets in `control/mailbox.json`, source files, commit history, logs, or public receipts. Any future executor requiring credentials must use Cloudflare secrets/bindings rather than repository content. Public HTTP endpoints remain read-only.

## Verified / pending

Previously verified manually: Worker health, Durable Object persistence across redeploy, and one-shot Durable Object alarm execution. The runtime records up to 20 alarm firings so repeated self-rescheduling can be verified without relying on browser timing. GitHub mailbox control, duplicate suppression, retry evidence, repeated self-loop execution, and Workers AI execution remain canary/pending until deployed runtime evidence confirms them.

Current AI canary: `AI-CANARY-001` requests the exact response `RCLOUD_AI_ALIVE`. Promotion requires a deployed `/mailbox/status` receipt proving execution; repository code or a successful commit alone is not sufficient evidence.
