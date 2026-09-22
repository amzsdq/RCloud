import test from "node:test";
import assert from "node:assert/strict";
import { validateQueueIndex, drainQueue } from "../src/queue.js";

test("queue index requires immutable path/request identity", () => {
  assert.throws(() => validateQueueIndex({ schema_version: 1, requests: [{ request_id: "A", path: "control/requests/B.json" }] }), /QUEUE_PATH_ID_MISMATCH/);
  assert.throws(() => validateQueueIndex({ schema_version: 1, requests: [{ request_id: "A", path: "control/requests/A.json" }, { request_id: "A", path: "control/requests/A.json" }] }), /DUPLICATE_QUEUE_REQUEST_ID/);
});

test("bounded drain skips terminal entries and processes unseen requests", async () => {
  const oldFetch = globalThis.fetch;
  const bodies = {
    "A": { schema_version: 1, request_id: "A", target: "runtime:main", action: "NOOP", payload: {} },
    "B": { schema_version: 1, request_id: "B", target: "runtime:main", action: "NOOP", payload: {} },
    "C": { schema_version: 1, request_id: "C", target: "runtime:main", action: "NOOP", payload: {} }
  };
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes("queue-index.json")) return new Response(JSON.stringify({ schema_version: 1, requests: Object.keys(bodies).map(request_id => ({ request_id, path: `control/requests/${request_id}.json` })) }));
    const id = Object.keys(bodies).find(x => u.includes(`/control/requests/${x}.json`));
    return id ? new Response(JSON.stringify(bodies[id])) : new Response("missing", { status: 404 });
  };
  try {
    const executed = [];
    const result = await drainQueue({
      isTerminal: async id => id === "A",
      process: async command => { executed.push(command.request_id); return { status: "COMPLETED" }; },
      limit: 1
    });
    assert.deepEqual(executed, ["B"]);
    assert.equal(result.processed, 1);
    assert.equal(result.skipped_terminal, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("queue rejects a command routed to another target", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes("queue-index.json")) return new Response(JSON.stringify({ schema_version: 1, requests: [{ request_id: "X", path: "control/requests/X.json" }] }));
    return new Response(JSON.stringify({ schema_version: 1, request_id: "X", target: "runtime:other", action: "NOOP", payload: {} }));
  };
  try {
    await assert.rejects(() => drainQueue({ isTerminal: async () => false, process: async () => ({ status: "COMPLETED" }) }), /QUEUE_TARGET_MISMATCH/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
