import { DurableObject } from "cloudflare:workers";

const clampSeconds = (value, fallback = 120) => Math.max(5, Math.min(Number(value) || fallback, 3600));
const MAILBOX_URL = "https://raw.githubusercontent.com/amzsdq/RCloud/main/control/mailbox.json";
const MAILBOX_API_URL = "https://api.github.com/repos/amzsdq/RCloud/contents/control/mailbox.json?ref=main";
const AI_MODEL = "@cf/zai-org/glm-4.7-flash";
const LEDGER_LIMIT = 100;
const PROCESSING_STALE_MS = 5 * 60 * 1000;
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

  async getLedger() { return (await this.ctx.storage.get("request_ledger")) ?? {}; }
  async putLedgerEntry(requestId, entry) {
    const ledger = await this.getLedger(); ledger[requestId] = entry;
    const ids = Object.keys(ledger).sort((a, b) => String(ledger[a]?.updated_at ?? "").localeCompare(String(ledger[b]?.updated_at ?? "")));
    while (ids.length > LEDGER_LIMIT) { const oldest = ids.shift(); if (ledger[oldest]?.status === "PROCESSING") { ids.push(oldest); if (ids.every(id => ledger[id]?.status === "PROCESSING")) break; } else delete ledger[oldest]; }
    await this.ctx.storage.put("request_ledger", ledger);
  }

  async quarantineStale(payload, reconcilerId) {
    const targetId = typeof payload?.target_request_id === "string" ? payload.target_request_id.trim() : "";
    if (!targetId || targetId === reconcilerId) return { ok: false, error: "INVALID_TARGET_REQUEST" };
    const ledger = await this.getLedger(), existing = ledger[targetId];
    if (!existing) return { ok: false, error: "TARGET_NOT_FOUND", target_request_id: targetId };
    if (existing.status !== "PROCESSING") return { ok: false, error: "TARGET_NOT_PROCESSING", target_request_id: targetId, target_status: existing.status };

    const startedMs = Date.parse(existing.started_at ?? "");
    const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Number.POSITIVE_INFINITY;
    if (ageMs < PROCESSING_STALE_MS) {
      return { ok: false, error: "PROCESSING_NOT_STALE", target_request_id: targetId, age_seconds: Math.max(0, Math.floor(ageMs / 1000)), stale_after_seconds: PROCESSING_STALE_MS / 1000 };
    }

    const now = new Date().toISOString();
    const targetReceipt = {
      ok: false,
      status: "FAILED_AMBIGUOUS",
      request_id: targetId,
      fingerprint: existing.fingerprint,
      action: existing.action,
      started_at: existing.started_at ?? null,
      processed_at: now,
      error: "STALE_PROCESSING_QUARANTINED",
      automatic_retry: false,
      reconciled_outcome: false,
      quarantined_by: reconcilerId
    };
    await this.putLedgerEntry(targetId, { ...existing, status: "FAILED_AMBIGUOUS", updated_at: now, receipt: targetReceipt, quarantined_at: now, quarantined_by: reconcilerId });
    await this.saveReceipt(targetReceipt);
    return { ok: true, target_request_id: targetId, previous_status: "PROCESSING", new_status: "FAILED_AMBIGUOUS", automatic_retry: false, outcome_still_ambiguous: true };
  }

  async processMailbox(command) {
    if (!command || command.schema_version !== 1 || typeof command.request_id !== "string" || !command.request_id) {
      const receipt = { ok: false, status: "REJECTED", error: "INVALID_COMMAND", processed_at: new Date().toISOString() }; await this.saveReceipt(receipt); return receipt;
    }
    const fingerprint = await sha256(stableCommand(command)), ledger = await this.getLedger(), existing = ledger[command.request_id];
    if (existing) {
      if (existing.fingerprint !== fingerprint) { const conflict = { ok: false, status: "REJECTED", error: "REQUEST_ID_COLLISION", request_id: command.request_id, processed_at: new Date().toISOString(), expected_fingerprint: existing.fingerprint, received_fingerprint: fingerprint }; await this.saveReceipt(conflict); return conflict; }
      if (existing.status === "PROCESSING") { const held = { ok: false, status: "PROCESSING", duplicate: true, retry_suppressed: true, request_id: command.request_id, fingerprint, started_at: existing.started_at, processed_at: new Date().toISOString() }; await this.saveReceipt(held); return held; }
      return { ...(existing.receipt ?? {}), status: "DUPLICATE", duplicate: true, fingerprint, original_status: existing.status };
    }

    const startedAt = new Date().toISOString();
    await this.putLedgerEntry(command.request_id, { fingerprint, action: command.action, status: "PROCESSING", started_at: startedAt, updated_at: startedAt });
    let accepted = true, result;
    try {
      if (command.action === "NOOP") result = { acknowledged: true };
      else if (command.action === "START_LOOP") result = await this.startLoop(command.payload?.seconds ?? 120);
      else if (command.action === "STOP_LOOP") result = await this.stopLoop();
      else if (command.action === "AI_PROMPT") { result = await this.runAI(command.payload); accepted = result.ok === true; }
      else if (command.action === "QUARANTINE_STALE") { result = await this.quarantineStale(command.payload, command.request_id); accepted = result.ok === true; }
      else { accepted = false; result = { error: "UNSUPPORTED_ACTION" }; }
      const receipt = { ok: accepted, status: accepted ? "COMPLETED" : "REJECTED", request_id: command.request_id, fingerprint, action: command.action, started_at: startedAt, processed_at: new Date().toISOString(), result };
      await this.putLedgerEntry(command.request_id, { fingerprint, action: command.action, status: receipt.status, started_at: startedAt, updated_at: receipt.processed_at, receipt });
      await this.saveReceipt(receipt); return receipt;
    } catch (error) {
      const receipt = { ok: false, status: "FAILED_AMBIGUOUS", request_id: command.request_id, fingerprint, action: command.action, started_at: startedAt, processed_at: new Date().toISOString(), error: String(error), automatic_retry: false };
      await this.putLedgerEntry(command.request_id, { fingerprint, action: command.action, status: "FAILED_AMBIGUOUS", started_at: startedAt, updated_at: receipt.processed_at, receipt });
      await this.saveReceipt(receipt); return receipt;
    }
  }

  async recordPoll(observation) { const history = (await this.ctx.storage.get("poll_history")) ?? []; history.push(observation); while (history.length > 20) history.shift(); await this.ctx.storage.put("poll_history", history); await this.ctx.storage.put("last_poll", observation); }
  async getMailboxStatus() {
    const ledger = await this.getLedger();
    const allEntries = Object.entries(ledger).map(([request_id, v]) => ({ request_id, fingerprint: v.fingerprint, action: v.action, status: v.status, started_at: v.started_at, updated_at: v.updated_at }));
    const ledgerEntries = [...allEntries].sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,20);
    const now = Date.now();
    const staleProcessing = allEntries.filter(x => {
      if (x.status !== "PROCESSING") return false;
      const started = Date.parse(x.started_at ?? "");
      return !Number.isFinite(started) || now - started >= PROCESSING_STALE_MS;
    }).map(x => ({ ...x, stale_seconds: Number.isFinite(Date.parse(x.started_at ?? "")) ? Math.floor((now - Date.parse(x.started_at)) / 1000) : null }));
    return { receipt: (await this.ctx.storage.get("mailbox_receipt")) ?? null, recent_receipts: (await this.ctx.storage.get("receipt_history")) ?? [], ledger_size: Object.keys(ledger).length, recent_ledger: ledgerEntries, stale_processing: staleProcessing, processing_stale_after_seconds: PROCESSING_STALE_MS / 1000, last_ai_result: (await this.ctx.storage.get("last_ai_result")) ?? null, last_poll: (await this.ctx.storage.get("last_poll")) ?? null, recent_polls: (await this.ctx.storage.get("poll_history")) ?? [] };
  }

  async alarm() {
    const previous = (await this.ctx.storage.get("state")) ?? {}, config = (await this.ctx.storage.get("loop_config")) ?? { enabled: false, interval_seconds: null };
    const nextCount = ((await this.ctx.storage.get("loop_count")) ?? 0) + 1, firedAt = new Date().toISOString(); await this.ctx.storage.put("loop_count", nextCount);
    let nextFireAt = null; if (config.enabled && config.interval_seconds) { nextFireAt = Date.now() + Number(config.interval_seconds) * 1000; await this.ctx.storage.setAlarm(nextFireAt); }
    const evidence = (await this.ctx.storage.get("loop_evidence")) ?? []; evidence.push({ count: nextCount, fired_at: firedAt, next_fire_at: nextFireAt == null ? null : new Date(nextFireAt).toISOString() }); while (evidence.length > 20) evidence.shift(); await this.ctx.storage.put("loop_evidence", evidence);
    const state = { ...previous, value: config.enabled ? "CLOUD_LOOP_RUNNING" : "CLOUD_TAKEOVER", updated_at: firedAt, alarm_fired_at: firedAt, loop_enabled: !!config.enabled, loop_count: nextCount, alarm_interval_seconds: config.interval_seconds ?? previous.alarm_interval_seconds ?? null, alarm_fire_at: nextFireAt == null ? null : new Date(nextFireAt).toISOString() };
    await this.ctx.storage.put("state", state);
  }
}

async function fetchFreshMailbox() {
  const apiResponse = await fetch(`${MAILBOX_API_URL}&cb=${Date.now()}`, {
    headers: {
      "accept": "application/vnd.github+json",
      "user-agent": "RCloud/0.15.0",
      "cache-control": "no-cache"
    }
  });
  if (apiResponse.ok) {
    const envelope = await apiResponse.json();
    if (typeof envelope?.content === "string" && envelope.content) {
      const compact = envelope.content.replace(/\s/g, "");
      const bytes = Uint8Array.from(atob(compact), ch => ch.charCodeAt(0));
      return {
        command: JSON.parse(new TextDecoder().decode(bytes)),
        source: "github-contents-api",
        source_sha: envelope.sha ?? null
      };
    }
  }

  const rawResponse = await fetch(`${MAILBOX_URL}?cb=${Date.now()}`, {
    headers: { "user-agent": "RCloud/0.15.0", "cache-control": "no-store" }
  });
  if (!rawResponse.ok) throw new Error(`MAILBOX_FETCH_FAILED_API_${apiResponse.status}_RAW_${rawResponse.status}`);
  return { command: await rawResponse.json(), source: "raw-main-fallback", source_sha: null };
}

async function pollMailbox(runtime) {
  const startedAt = new Date().toISOString(); let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fetched = await fetchFreshMailbox();
      const command = fetched.command;
      const receipt = await runtime.processMailbox(command);
      const observedFingerprint = receipt.received_fingerprint ?? receipt.fingerprint ?? null;
      const observation = { ok: true, status: "POLL_OK", attempt, started_at: startedAt, finished_at: new Date().toISOString(), request_id: receipt.request_id ?? null, receipt_status: receipt.status, command_issued_at: command?.issued_at ?? null, observed_fingerprint: observedFingerprint, mailbox_source: fetched.source, mailbox_source_sha: fetched.source_sha };
      await runtime.recordPoll(observation); return observation;
    } catch (error) { lastError = String(error); if (attempt < 3) await sleep(250 * (2 ** (attempt - 1))); }
  }
  const observation = { ok: false, status: "POLL_FAILED", attempts: 3, started_at: startedAt, finished_at: new Date().toISOString(), error: lastError }; await runtime.recordPoll(observation); return observation;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), runtime = env.RUNTIME_STATE.getByName("main");
    if (url.pathname === "/health") return Response.json({ ok: true, service: "RCloud", version: "0.12.2", runtime: "cloudflare-worker+durable-object+alarm+cron+github-mailbox+workers-ai+request-ledger+stale-quarantine", control_plane: "github-main", ai_model: AI_MODEL, time: new Date().toISOString() });
    if (url.pathname === "/state") return Response.json({ ok: true, state: await runtime.getState() });
    if (url.pathname === "/loop/status") return Response.json({ ok: true, ...(await runtime.getLoopStatus()) });
    if (url.pathname === "/mailbox/status") return Response.json({ ok: true, ...(await runtime.getMailboxStatus()) });
    return new Response("RCloud read-only API. Try /health, /state, /loop/status, or /mailbox/status", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
  async scheduled(controller, env, ctx) { const runtime = env.RUNTIME_STATE.getByName("main"); ctx.waitUntil(Promise.all([runtime.ensureLoop(120), pollMailbox(runtime)])); }
};
