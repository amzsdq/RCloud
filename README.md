# RCloud

Cloud-first persistent runtime prototype using Cloudflare Workers, Durable Objects, alarms, cron bootstrap, GitHub as a durable control plane, and a bounded Workers AI executor.

## Current runtime

- `GET /health` — deployed version and runtime identity.
- `GET /state` — durable runtime state.
- `GET /loop/status` — self-rescheduling alarm evidence and next wake.
- `GET /mailbox/status` — mailbox receipt/history, bounded durable request ledger, AI result, and polling observations.
- Public HTTP surface is read-only. Runtime mutations are accepted only through `control/mailbox.json` on GitHub main.

## Mailbox schema

```json
{
  "schema_version": 1,
  "request_id": "globally-unique-id",
  "action": "NOOP | START_LOOP | STOP_LOOP | AI_PROMPT | QUARANTINE_STALE",
  "issued_at": "ISO-8601 timestamp",
  "payload": {}
}
```

## Durable idempotency ledger

v0.11 uses a bounded Durable Object ledger keyed by `request_id` rather than only comparing the immediately preceding request. Each retained entry stores a SHA-256 fingerprint over execution-relevant fields, action, lifecycle state, timestamps, and terminal receipt.

Semantics:

- unseen ID → persist `PROCESSING` **before** executor invocation;
- same ID + same fingerprint + terminal state → return `DUPLICATE` without re-execution;
- same ID + different fingerprint → reject `REQUEST_ID_COLLISION`;
- same ID while `PROCESSING` → suppress retry/re-execution;
- executor exception → persist `FAILED_AMBIGUOUS`; automatic retry is suppressed because the side effect may have occurred before the failure became observable.

The ledger retains up to 100 entries and never intentionally evicts a `PROCESSING` entry merely to satisfy the bound. This closes the previous `A → B → A` correctness gap for retained IDs. It is still a bounded deduplication window, not permanent global uniqueness.

The latest 20 receipts and polling observations are retained as operational evidence. Cron polls the mailbox once per minute and retries transient **mailbox fetch** failures up to three times with bounded exponential backoff. Executor ambiguity is not automatically retried.

v0.12 also exposes stale `PROCESSING` entries in `/mailbox/status`. After 5 minutes, a separate `QUARANTINE_STALE` command may terminalize a stale entry as `FAILED_AMBIGUOUS` without re-running its executor. This is deliberately not an assertion of success or failure of the original side effect: `outcome_still_ambiguous=true`, and a credentialed/irreversible action still requires external reconciliation before any replacement side effect is issued.

For `AI_PROMPT`, `payload.prompt` must be non-empty and at most 4,000 characters. The executor caps generation at 512 tokens and persists the bounded result in Durable Object storage. It has no credentialed external side-effect tools.

## Safety model

The repository is the authority for commands. Do not put credentials or secrets in `control/mailbox.json`, source files, commit history, logs, or public receipts. Any future executor requiring credentials must use Cloudflare secrets/bindings rather than repository content. Public HTTP endpoints remain read-only.

The command fingerprint intentionally excludes `issued_at`: changing metadata alone does not create a new side effect. A genuinely new execution must use a new `request_id`.

Before credentialed or irreversible executors are added, recovery of stale `PROCESSING` / `FAILED_AMBIGUOUS` entries must require action-specific reconciliation rather than blind replay. No irreversible side effect should be promoted while outcome is ambiguous.

## Evidence policy

Repository state proves only what was committed. Runtime capabilities are promoted to PASS only from deployed runtime evidence. In particular, a commit containing an executor is not proof that Cloudflare deployed it or that the executor ran.

Verified runtime evidence:

- Worker health: PASS (manual earlier verification; external probe also reached deployed v0.11.0).
- Durable Object persistence across redeploy: PASS (manual earlier verification).
- one-shot Durable Object alarm: PASS (manual earlier verification).
- repeated self-rescheduling loop: **PASS** — external probe run `35713529719` observed `loop_count=16`, 14 retained consecutive alarm-fire records, `verified_two_plus_fires=true`, and a next alarm scheduled for 2026-09-22T10:01:15.388Z.
- GitHub mailbox → Cloudflare cron poll → Workers AI → durable receipt: **PASS** — the same external probe observed `AI-CANARY-001` completed with `RCLOUD_AI_ALIVE`, model `@cf/zai-org/glm-4.7-flash`, and a durable terminal ledger entry.
- repeated same-ID suppression: **PASS for consecutive polling** — poll history repeatedly returned `DUPLICATE` for the same AI canary without another execution while the same deployed ledger was active.

Strict deployed canary now verified:
- same-ID/different-fingerprint collision rejection: **PASS** — hardened runtime-evidence run `35714954029` required a post-`issued_at` poll for `LEDGER-CANARY-A`, detected that the retained ledger fingerprint differed from the current command fingerprint, and passed only after the deployed runtime reported `receipt_status=REJECTED` with a matching `REQUEST_ID_COLLISION` receipt.

- non-consecutive `A → B → A` suppression: **PASS** — hardened runtime-evidence run `35715423144` observed deployed v0.12.2 and accepted the reissued original `LEDGER-CANARY-A/A-v1` only after the deployed poll reported `receipt_status=DUPLICATE` under the exact command-correlation predicate.

Still pending dedicated deployed canaries: stale `PROCESSING` quarantine and forced mailbox-fetch retry/failure behavior. Earlier pre-hardening workflow successes that matched only an already-retained request ID are not counted as proof.

### Independent external probe

`.github/workflows/runtime-evidence.yml` provides a second observation path that does not depend on the ChatGPT/web client being able to reach `workers.dev`. It probes `/health`, `/loop/status`, and `/mailbox/status` from a GitHub-hosted runner, retries transient HTTP failures, validates JSON, derives loop/AI canary evidence, and uploads the raw responses plus `summary.json` as a short-lived artifact. It is read-only against RCloud and has `contents: read` repository permission only.

The probe runs on relevant main pushes, can be dispatched manually, and has a 15-minute scheduled backstop. A successful repository commit is still not a runtime PASS; the probe's captured deployed responses are the evidence.

## Stop / recovery semantics

- `STOP_LOOP` disables the self-rescheduling Durable Object alarm and sets `autoboot_enabled=false`.
- The 1-minute cron control plane intentionally remains alive while the work loop is stopped, so GitHub can later deliver a new `START_LOOP` request.
- `QUARANTINE_STALE` never replays an executor. It only moves a >=5 minute stale `PROCESSING` record to `FAILED_AMBIGUOUS` and preserves the ambiguity for explicit reconciliation.
