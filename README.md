# RCloud

Cloud-first persistent runtime prototype using Cloudflare Workers, Durable Objects, alarms, cron bootstrap, and GitHub as a durable control plane.

## Current runtime

- `GET /health` — deployed version and runtime identity.
- `GET /state` — durable runtime state.
- `GET /loop/status` — self-rescheduling alarm evidence and next wake.
- `GET /mailbox/status` — last GitHub mailbox receipt plus recent polling observations.
- Public HTTP surface is read-only. Runtime mutations are accepted only through `control/mailbox.json` on GitHub main.

## Mailbox schema

```json
{
  "schema_version": 1,
  "request_id": "globally-unique-id",
  "action": "NOOP | START_LOOP | STOP_LOOP",
  "issued_at": "ISO-8601 timestamp",
  "payload": {}
}
```

`request_id` is the idempotency key. Re-reading the same command returns `DUPLICATE` rather than re-running its side effect. Cron polls the mailbox once per minute and retries transient fetch failures up to three times with bounded exponential backoff. Poll outcomes are retained in Durable Object storage for observability.

## Safety model

The repository is the authority for commands. Do not put credentials or secrets in `control/mailbox.json`, source files, commit history, logs, or public receipts. Any future executor requiring credentials must use Cloudflare secrets/bindings rather than repository content.

## Verified / pending

Previously verified manually: Worker health, Durable Object persistence across redeploy, and one-shot Durable Object alarm execution. The runtime now records up to 20 alarm firings so repeated self-rescheduling can be verified without relying on browser timing. GitHub mailbox control, duplicate suppression, retry evidence, and any future cloud executor must be verified from deployed runtime evidence before being promoted from canary to verified.
