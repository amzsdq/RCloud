import { DurableObject } from "cloudflare:workers";

const clampSeconds = (value, fallback = 120) => Math.max(5, Math.min(Number(value) || fallback, 3600));
const MAILBOX_URL = "https://raw.githubusercontent.com/amzsdq/RCloud/main/control/mailbox.json";
const AI_MODEL = "@cf/zai-org/glm-4.7-flash";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stableCommand = command => JSON.stringify({ schema_version: command?.schema_version, request_id: command?.request_id, action: command?.action, payload: command?.payload ?? null });
async function sha256(text) { const bytes = new TextEncoder().encode(text); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }

export class RuntimeState extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  async getState() { return (await this.ctx.storage.get("state")) ?? { value: "UNINITIALIZED", updated_at: null }; }

  async startLoop(seconds = 120) {
    const safeSeconds = clampSeconds(seconds), fireAt = Date.now() + safeSeconds * 1000;
    await this.ctx.storage.put("autoboot_enabled", true); await this.ctx.storage.put("loop_config", { enabled: true, interval_seconds: safeSeconds });
    await this.ctx.storage.put("loop_count", 0); await this.ctx.storage.put("loop_evidence", []); await this.ctx.storage.setAlarm(fireAt);
    const state = { value: "LOOP_ARMED", updated_at: new Date().toISOString(), alarm_fire_at: new Date(fireAt).toISOString(), alarm_interval_seconds: safeSeconds, loop_enabled: true, loop_count: 0, autoboot_enabled: true };
    await this.ctx.storage.put("state", state); return { state, alarm_time_ms: fireAt };
  }

  async ensureLoop(seconds = 120) {
    const autoboot = await this.ctx.storage.get("autoboot_enabled"); if (autoboot === false) return { ok: true, action: "DISABLED", reason: "AUTOBOOT_DISABLED" };
    const safeSeconds = clampSeconds(seconds), config = (await this.ctx.storage.get("loop_config")) ?? { enabled: false, interval_seconds: safeSeconds };
    const alarmTime = await this.ctx.storage.getAlarm(), count = (await this.ctx.storage.get("loop_count")) ?? 0;
    if (config.enabled && alarmTime != null) return { ok: true, action: "ALREADY_RUNNING", loop_count: count, alarm_time_ms: alarmTime, alarm_fire_at: new Date(alarmTime).toISOString() };
    const interval = config.enabled && config.interval_seconds ? Number(config.interval_seconds) : safeSeconds, fireAt = Date.now() + interval * 1000;
    await this.ctx.storage.put("autoboot_enabled", true); await this.ctx.storage.put("loop_config", { enabled: true, interval_seconds: interval }); await this.ctx.storage.setAlarm(fireAt);
    const previous = (await this.ctx.storage.get("state")) ?? {}, state = { ...previous, value: "LOOP_ARMED", updated_at: new Date().toISOString(), alarm_fire_at: new Date(fireAt).toISOString(), alarm_interval_seconds: interval, loop_enabled: true, loop_count: count, autoboot_enabled: true, bootstrapped_by: "CLOUD_CRON" };
    await this.ctx.storage.put("state", state); return { ok: true, action: "BOOTSTRAPPED", state, alarm_time_ms: fireAt };
  }

  async stopLoop() {
    await this.ctx.storage.put("autoboot_enabled", false); await this.ctx.storage.put("loop_config", { enabled: false, interval_seconds: null }); await this.ctx.storage.deleteAlarm();
    const previous = (await this.ctx.storage.get("state")) ?? {}, state = { ...previous, value: "LOOP_STOPPED", updated_at: new Date().toISOString(), loop_enabled: false, autoboot_enabled: false, alarm_fire_at: null };
    await this.ctx.storage.put("state", state); return state;
  }

  async getLoopStatus() {
    const state = await this.getState(), config = (await this.ctx.storage.get("loop_config")) ?? { enabled: false, interval_seconds: null };
    const alarmTime = await this.ctx.storage.getAlarm(), count = (await this.ctx.storage.get("loop_count")) ?? 0, evidence = (await this.ctx.storage.get("loop_evidence")) ?? [];
    return { state, config, autoboot_enabled: (await this.ctx.storage.get("autoboot_enabled")) !== false, loop_count: count, verified_two_plus_fires: evidence.length >= 2, recent_alarm_fires: evidence, alarm_time_ms: alarmTime, alarm_fire_at: alarmTime == null ? null : new Date(alarmTime).toISOString() };
  }

  async runAI(payload) {
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt || prompt.length > 4000) return { ok: false, error: "INVALID_PROMPT", max_chars: 4000 };
    const startedAt = new Date().toISOString();
    const output = await this.env.AI.run(AI_MODEL, { messages: [{ role: "system", content: "You are the bounded RCloud cloud executor. Return concise plain text. Do not claim external side effects." }, { role: "user", content: prompt }], max_tokens: 512, temperature: 0.2 });
    const text = typeof output === "string" ? output : (output?.response ?? output?.result?.response ?? JSON.stringify(output));
    const result = { ok: true, model: AI_MODEL, started_at: startedAt, finished_at: new Date().toISOString(), output: String(text).slice(0, 8000) };
    await this.ctx.storage.put("last_ai_result", result); return result;
  }

  async saveReceipt(receipt) {
    await this.ctx.storage.put("mailbox_receipt", receipt);
    const history = (await this.ctx.storage.get("receipt_history")) ?? []; history.push(receipt); while (history.length > 20) history.shift(); await this.ctx.storage.put("receipt_history", history);
  }

  async processMailbox(command) {
    if (!command || command.schema_version !== 1 || typeof command.request_id !== "string" || !command.request_id) {
      const receipt = { ok: false, status: "REJECTED", error: "INVALID_COMMAND", processed_at: new Date().toISOString() }; await this.saveReceipt(receipt); return receipt;
    }
    const fingerprint = await sha256(stableCommand(command));
    const lastRequestId = await this.ctx.storage.get("mailbox_last_request_id"), lastFingerprint = await this.ctx.storage.get("mailbox_last_fingerprint");
    if (lastRequestId === command.request_id) {
      if (lastFingerprint && lastFingerprint !== fingerprint) { const conflict = { ok: false, status: "REJECTED", error: "REQUEST_ID_COLLISION", request_id: command.request_id, processed_at: new Date().toISOString(), expected_fingerprint: lastFingerprint, received_fingerprint: fingerprint }; await this.saveReceipt(conflict); return conflict; }
      const previous = await this.ctx.storage.get("mailbox_receipt"); return { ...(previous ?? {}), ok: true, status: "DUPLICATE", duplicate: true, fingerprint };
    }
    let accepted = true, result;
    if (command.action === "NOOP") result = { acknowledged: true };
    else if (command.action === "START_LOOP") result = await this.startLoop(command.payload?.seconds ?? 120);
    else if (command.action === "STOP_LOOP") result = await this.stopLoop();
    else if (command.action === "AI_PROMPT") { result = await this.runAI(command.payload); accepted = result.ok === true; }
    else { accepted = false; result = { error: "UNSUPPORTED_ACTION" }; }
    const receipt = { ok: accepted, status: accepted ? "COMPLETED" : "REJECTED", request_id: command.request_id, fingerprint, action: command.action, processed_at: new Date().toISOString(), result };
    await this.ctx.storage.put("mailbox_last_request_id", command.request_id); await this.ctx.storage.put("mailbox_last_fingerprint", fingerprint); await this.saveReceipt(receipt); return receipt;
  }

  async recordPoll(observation) { const history = (await this.ctx.storage.get("poll_history")) ?? []; history.push(observation); while (history.length > 20) history.shift(); await this.ctx.storage.put("poll_history", history); await this.ctx.storage.put("last_poll", observation); }
  async getMailboxStatus() { return { last_request_id: (await this.ctx.storage.get("mailbox_last_request_id")) ?? null, last_fingerprint: (await this.ctx.storage.get("mailbox_last_fingerprint")) ?? null, receipt: (await this.ctx.storage.get("mailbox_receipt")) ?? null, recent_receipts: (await this.ctx.storage.get("receipt_history")) ?? [], last_ai_result: (await this.ctx.storage.get("last_ai_result")) ?? null, last_poll: (await this.ctx.storage.get("last_poll")) ?? null, recent_polls: (await this.ctx.storage.get("poll_history")) ?? [] }; }

  async alarm() {
    const previous = (await this.ctx.storage.get("state")) ?? {}, config = (await this.ctx.storage.get("loop_config")) ?? { enabled: false, interval_seconds: null };
    const nextCount = ((await this.ctx.storage.get("loop_count")) ?? 0) + 1, firedAt = new Date().toISOString(); await this.ctx.storage.put("loop_count", nextCount);
    let nextFireAt = null; if (config.enabled && config.interval_seconds) { nextFireAt = Date.now() + Number(config.interval_seconds) * 1000; await this.ctx.storage.setAlarm(nextFireAt); }
    const evidence = (await this.ctx.storage.get("loop_evidence")) ?? []; evidence.push({ count: nextCount, fired_at: firedAt, next_fire_at: nextFireAt == null ? null : new Date(nextFireAt).toISOString() }); while (evidence.length > 20) evidence.shift(); await this.ctx.storage.put("loop_evidence", evidence);
    const state = { ...previous, value: config.enabled ? "CLOUD_LOOP_RUNNING" : "CLOUD_TAKEOVER", updated_at: firedAt, alarm_fired_at: firedAt, loop_enabled: !!config.enabled, loop_count: nextCount, alarm_interval_seconds: config.interval_seconds ?? previous.alarm_interval_seconds ?? null, alarm_fire_at: nextFireAt == null ? null : new Date(nextFireAt).toISOString() };
    await this.ctx.storage.put("state", state);
  }
}

async function pollMailbox(runtime) {
  const startedAt = new Date().toISOString(); let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(MAILBOX_URL, { headers: { "user-agent": "RCloud/0.10", "cache-control": "no-cache" } }); if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const receipt = await runtime.processMailbox(await response.json()); const observation = { ok: true, status: "POLL_OK", attempt, started_at: startedAt, finished_at: new Date().toISOString(), request_id: receipt.request_id ?? null, receipt_status: receipt.status };
      await runtime.recordPoll(observation); return observation;
    } catch (error) { lastError = String(error); if (attempt < 3) await sleep(250 * (2 ** (attempt - 1))); }
  }
  const observation = { ok: false, status: "POLL_FAILED", attempts: 3, started_at: startedAt, finished_at: new Date().toISOString(), error: lastError }; await runtime.recordPoll(observation); return observation;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), runtime = env.RUNTIME_STATE.getByName("main");
    if (url.pathname === "/health") return Response.json({ ok: true, service: "RCloud", version: "0.10.0", runtime: "cloudflare-worker+durable-object+alarm+cron+github-mailbox+workers-ai", control_plane: "github-main", ai_model: AI_MODEL, time: new Date().toISOString() });
    if (url.pathname === "/state") return Response.json({ ok: true, state: await runtime.getState() });
    if (url.pathname === "/loop/status") return Response.json({ ok: true, ...(await runtime.getLoopStatus()) });
    if (url.pathname === "/mailbox/status") return Response.json({ ok: true, ...(await runtime.getMailboxStatus()) });
    return new Response("RCloud read-only API. Try /health, /state, /loop/status, or /mailbox/status", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  async scheduled(controller, env, ctx) { const runtime = env.RUNTIME_STATE.getByName("main"); ctx.waitUntil(Promise.all([runtime.ensureLoop(120), pollMailbox(runtime)])); }
};
