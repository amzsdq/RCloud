import baseWorker, { RuntimeState } from "./index.js";
import { drainQueue } from "./queue.js";

// Extend the existing Durable Object class without changing its binding/class
// identity, so deployed Durable Object storage remains intact across rollout.
RuntimeState.prototype.getTerminalRequestIds = async function () {
  const ledger = await this.getLedger();
  return Object.entries(ledger)
    .filter(([, entry]) => entry?.status && entry.status !== "PROCESSING")
    .map(([requestId]) => requestId);
};

RuntimeState.prototype.recordQueuePoll = async function (observation) {
  await this.ctx.storage.put("last_queue_poll", observation);
  const history = (await this.ctx.storage.get("queue_poll_history")) ?? [];
  history.push(observation);
  while (history.length > 20) history.shift();
  await this.ctx.storage.put("queue_poll_history", history);
};

RuntimeState.prototype.getQueueStatus = async function () {
  return {
    last_queue_poll: (await this.ctx.storage.get("last_queue_poll")) ?? null,
    recent_queue_polls: (await this.ctx.storage.get("queue_poll_history")) ?? []
  };
};

export { RuntimeState };

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
      return Response.json({ ok: true, ...(await runtime.getQueueStatus()) });
    }
    return baseWorker.fetch(request, env);
  },

  async scheduled(controller, env, ctx) {
    // Preserve the proven loop + legacy mailbox path during queue canaries.
    await baseWorker.scheduled(controller, env, ctx);
    const runtime = env.RUNTIME_STATE.getByName("main");
    ctx.waitUntil(pollQueue(runtime));
  }
};
