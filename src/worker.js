import baseWorker, { RuntimeState as BaseRuntimeState } from "./index.js";
import { drainQueue } from "./queue.js";

const QUEUE_RUNTIME_VERSION = "0.15.0";

// Keep the exported/bound class name `RuntimeState` unchanged so the existing
// Durable Object namespace and storage survive this rollout.
export class RuntimeState extends BaseRuntimeState {
  async getTerminalRequestIds() {
    const ledger = await this.getLedger();
    return Object.entries(ledger)
      .filter(([, entry]) => entry?.status && entry.status !== "PROCESSING")
      .map(([requestId]) => requestId);
  }

  async recordQueuePoll(observation) {
    await this.ctx.storage.put("last_queue_poll", observation);
    const history = (await this.ctx.storage.get("queue_poll_history")) ?? [];
    history.push(observation);
    while (history.length > 20) history.shift();
    await this.ctx.storage.put("queue_poll_history", history);
  }

  async getQueueStatus() {
    return {
      last_queue_poll: (await this.ctx.storage.get("last_queue_poll")) ?? null,
      recent_queue_polls: (await this.ctx.storage.get("queue_poll_history")) ?? []
    };
  }
}

async function pollQueue(runtime) {
  const startedAt = new Date().toISOString();
  try {
    const terminal = new Set(await runtime.getTerminalRequestIds());
    const result = await drainQueue({
      isTerminal: async requestId => terminal.has(requestId),
      process: command => runtime.processMailbox(command),
      limit: 5
    });
    const observation = { ...result, status: "QUEUE_POLL_OK", started_at: startedAt, finished_at: new Date().toISOString() };
    await runtime.recordQueuePoll(observation);
    return observation;
  } catch (error) {
    const observation = { ok: false, status: "QUEUE_POLL_FAILED", started_at: startedAt, finished_at: new Date().toISOString(), error: String(error) };
    await runtime.recordQueuePoll(observation);
    return observation;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/queue/status") {
      const runtime = env.RUNTIME_STATE.getByName("main");
      return Response.json({ ok: true, version: QUEUE_RUNTIME_VERSION, ...(await runtime.getQueueStatus()) });
    }
    if (url.pathname === "/health") {
      const base = await baseWorker.fetch(request, env);
      const body = await base.json();
      return Response.json({ ...body, version: QUEUE_RUNTIME_VERSION, queue_transport: "github-immutable-request-files" });
    }
    return baseWorker.fetch(request, env);
  },

  async scheduled(controller, env, ctx) {
    await baseWorker.scheduled(controller, env, ctx);
    const runtime = env.RUNTIME_STATE.getByName("main");
    ctx.waitUntil(pollQueue(runtime));
  }
};
