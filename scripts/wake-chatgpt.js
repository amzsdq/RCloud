const fs = require('node:fs');
const { chromium } = require('playwright');

const RESULT_PATH = process.env.WAKE_RESULT_PATH || 'wake-result.json';
const COMPOSERS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'textarea'
];
const SEND = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="메시지 보내기"], button[aria-label="보내기"]';
const STOP = 'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="응답 중지"]';
const USERS = '[data-message-author-role="user"]';

function writeResult(result) {
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n');
}

function fail(status, error, extra = {}) {
  const result = {
    ok: false,
    status,
    request_id: process.env.WAKE_REQUEST_ID || process.env.GITHUB_RUN_ID || 'unknown',
    error: String(error || '').slice(0, 1200),
    ...extra
  };
  writeResult(result);
  console.error(`RCloud wake failed: ${status}`);
  process.exitCode = 1;
  return result;
}

function decodeState(encoded) {
  const raw = Buffer.from(encoded, 'base64').toString('utf8');
  const state = JSON.parse(raw);
  if (Array.isArray(state.cookies)) {
    state.cookies = state.cookies.filter(cookie => {
      const name = String(cookie?.name || '').toLowerCase();
      return name !== 'cf_clearance' && name !== '__cf_bm' && !name.startsWith('cf_chl_');
    });
  }
  return state;
}

function validTarget(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && /^\/c\/[A-Za-z0-9-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function visibleFirst(page, selectors, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.count() && await locator.isVisible() && await locator.isEnabled()) return locator;
      } catch {}
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function authenticated(page) {
  try {
    const response = await page.request.get('https://chatgpt.com/api/auth/session', { timeout: 15000 });
    const text = await response.text();
    return response.ok() && text.trim() !== '{}' && /user|email|expires/i.test(text);
  } catch {
    return false;
  }
}

async function waitIdle(page, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const stop = page.locator(STOP).first();
    try {
      if (!(await stop.count()) || !(await stop.isVisible())) return true;
    } catch {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function fillComposer(page, composer, message) {
  try {
    await composer.fill(message, { timeout: 10000 });
    return;
  } catch {}
  const editable = await composer.evaluate(node => node instanceof HTMLElement && node.isContentEditable === true).catch(() => false);
  if (!editable) throw new Error('Composer is not editable');
  await composer.focus();
  await composer.press('ControlOrMeta+A');
  await composer.press('Backspace');
  await page.keyboard.insertText(message);
}

async function main() {
  const encoded = String(process.env.CHATGPT_STORAGE_STATE_B64 || '').trim();
  const target = String(process.env.CHATGPT_WAKE_TARGET_URL || '').trim();
  const message = String(process.env.WAKE_MESSAGE || '1');
  const requestId = String(process.env.WAKE_REQUEST_ID || process.env.GITHUB_RUN_ID || 'unknown');

  if (!encoded) return fail('MISSING_ENV_SECRET', 'CHATGPT_STORAGE_STATE_B64 is not configured in the chatgpt-wake Environment.');
  if (!target) return fail('MISSING_TARGET_SECRET', 'CHATGPT_WAKE_TARGET_URL is not configured in the chatgpt-wake Environment.');
  if (!validTarget(target)) return fail('INVALID_TARGET', 'Configured target must be an https://chatgpt.com/c/<id> URL.');
  if (!message.length || message.length > 4000) return fail('INVALID_MESSAGE', 'Wake message must contain 1..4000 characters.');

  let state;
  try { state = decodeState(encoded); }
  catch (error) { return fail('INVALID_STORAGE_STATE', error); }

  const statePath = `/tmp/rcloud-chatgpt-state-${process.pid}.json`;
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

  let browser;
  let submitted = false;
  try {
    browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!(await authenticated(page))) return fail('AUTH_EXPIRED', 'Stored ChatGPT session is not authenticated.');

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!page.url().startsWith(target.replace(/\/$/, ''))) {
      return fail('TARGET_NOT_REACHED', 'Browser did not remain on the configured ChatGPT conversation.');
    }

    if (!(await waitIdle(page))) return fail('TARGET_BUSY', 'Target conversation remained busy.');

    const composer = await visibleFirst(page, COMPOSERS, 15000);
    if (!composer) return fail('COMPOSER_NOT_READY', 'ChatGPT composer was not available.');

    const users = page.locator(USERS);
    const before = await users.count();
    await fillComposer(page, composer, message);

    let send = null;
    const sendEnd = Date.now() + 10000;
    while (Date.now() < sendEnd) {
      const candidate = page.locator(SEND).first();
      try {
        if (await candidate.count() && await candidate.isVisible() && await candidate.isEnabled()) {
          send = candidate;
          break;
        }
      } catch {}
      await page.waitForTimeout(250);
    }
    if (!send) return fail('SEND_BUTTON_NOT_READY', 'ChatGPT send button did not become ready.', { before });

    submitted = true;
    await send.click();

    const verifyEnd = Date.now() + 15000;
    let after = before;
    let lastText = '';
    while (Date.now() < verifyEnd) {
      after = await users.count();
      if (after > before) {
        lastText = String(await users.nth(after - 1).innerText().catch(() => ''));
        if (lastText.trim() === message.trim() || lastText.includes(message)) {
          const result = {
            ok: true,
            status: 'SENT_VERIFIED',
            request_id: requestId,
            submitted: true,
            user_messages_before: before,
            user_messages_after: after
          };
          writeResult(result);
          console.log(`RCloud wake SENT_VERIFIED request_id=${requestId}`);
          return result;
        }
      }
      await page.waitForTimeout(250);
    }

    return fail('DELIVERY_UNCONFIRMED', 'Submit was attempted but the new user message was not verified.', {
      submitted,
      user_messages_before: before,
      user_messages_after: after
    });
  } catch (error) {
    return fail(submitted ? 'DELIVERY_UNCONFIRMED' : 'WAKE_EXCEPTION', error, { submitted });
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { fs.rmSync(statePath, { force: true }); } catch {}
  }
}

main().catch(error => {
  fail('FATAL_WAKE_ERROR', error);
});
