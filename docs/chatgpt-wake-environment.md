# ChatGPT wake Environment setup

RCloud's primary ChatGPT wake actuator uses GitHub Actions + Playwright.

The public repository never stores the ChatGPT session state or target conversation URL.

## One-time setup

Create a GitHub Environment named `chatgpt-wake`.

Add these Environment secrets:

- `CHATGPT_STORAGE_STATE_B64` — Base64-encoded Playwright storage state.
- `CHATGPT_WAKE_TARGET_URL` — the exact `https://chatgpt.com/c/<conversation-id>` target used for the first canary.

Recommended protection for the Environment:

- restrict deployment branches to `main`;
- do not require a reviewer, because human approval would break autonomous wake;
- keep repository write access limited to trusted maintainers.

## Canary

Run **Actions → ChatGPT Wake Canary → Run workflow**.

Leave `message` as `1` for the first test.

PASS requires the workflow result `SENT_VERIFIED`. Missing or expired authentication must fail closed and must not attempt a second blind send.

## Security

Base64 is transport encoding, not encryption. Security comes from GitHub Environment secret storage.

Never commit the decoded storage state, Base64 value, cookies, or session tokens. The wake script writes the decoded state only to a mode-0600 temporary file and deletes it after the browser closes.

The canary is manual-only until authentication and delivery are verified. After PASS, the same actuator can be connected to the durable wake mailbox/control event.
