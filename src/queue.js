const RAW_ROOT = "https://raw.githubusercontent.com/amzsdq/RCloud/main";
export const QUEUE_INDEX_URL = `${RAW_ROOT}/control/queue-index.json`;
export const QUEUE_BATCH_LIMIT = 5;
export const QUEUE_TARGET = "runtime:main";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const separator = url.includes("?") ? "&" : "?";
      const response = await fetch(`${url}${separator}cb=${Date.now()}-${attempt}`, { headers: { "user-agent": "RCloud-Queue/0.1", "cache-control": "no-store" } });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(250 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export function validateQueueIndex(index) {
  if (!index || index.schema_version !== 1 || !Array.isArray(index.requests)) throw new Error("INVALID_QUEUE_INDEX");
  const seen = new Set();
  for (const item of index.requests) {
    if (!item || typeof item.request_id !== "string" || !item.request_id || typeof item.path !== "string" || !item.path) throw new Error("INVALID_QUEUE_ITEM");
    if (seen.has(item.request_id)) throw new Error("DUPLICATE_QUEUE_REQUEST_ID");
    seen.add(item.request_id);
    if (item.path !== `control/requests/${item.request_id}.json`) throw new Error("QUEUE_PATH_ID_MISMATCH");
  }
  return index;
}

export async function readQueueIndex() { return validateQueueIndex(await fetchJson(QUEUE_INDEX_URL)); }

export async function fetchQueuedCommand(item) {
  const command = await fetchJson(`${RAW_ROOT}/${item.path}`);
  if (!command || command.request_id !== item.request_id) throw new Error("QUEUE_BODY_ID_MISMATCH");
  if (command.target !== QUEUE_TARGET) throw new Error("QUEUE_TARGET_MISMATCH");
  return command;
}

export async function drainQueue({ isTerminal, process, limit = QUEUE_BATCH_LIMIT }) {
  const index = await readQueueIndex();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || QUEUE_BATCH_LIMIT, 20));
  let attempted = 0;
  let processed = 0;
  let skippedTerminal = 0;
  let rejectedTransport = 0;
  const results = [];

  for (const item of index.requests) {
    if (attempted >= boundedLimit) break;
    if (await isTerminal(item.request_id)) { skippedTerminal += 1; continue; }
    attempted += 1;
    try {
      const command = await fetchQueuedCommand(item);
      const receipt = await process(command);
      results.push({ request_id: item.request_id, status: receipt?.status ?? "UNKNOWN" });
      processed += 1;
    } catch (error) {
      // One malformed/unavailable request must not head-of-line block unrelated
      // later requests. Keep it visible in poll evidence and retry on a later cron.
      rejectedTransport += 1;
      results.push({ request_id: item.request_id, status: "TRANSPORT_ERROR", error: String(error) });
    }
  }

  return { ok: true, indexed: index.requests.length, attempted, processed, rejected_transport: rejectedTransport, skipped_terminal: skippedTerminal, batch_limit: boundedLimit, results };
}
