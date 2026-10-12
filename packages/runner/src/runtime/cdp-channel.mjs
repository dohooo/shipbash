// One CDP socket held open for a conversation: commands with their answers
// matched by id, and events routed to whoever asked for them by method.
// browser-state-capture.mjs opens a socket per command because a capture
// is a handful of one-shot reads; a restore intercepts requests and waits
// for loads, which needs the events between the commands.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

/**
 * @param {string} webSocketUrl A page or browser-wide CDP socket.
 * @param {{ timeoutMs?: number, label?: string }} [options] The default
 *   command timeout and the browser's name in an error.
 * @returns {Promise<{
 *   command: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<any>,
 *   on: (method: string, handler: (params: unknown) => void) => void,
 *   off: (method: string) => void,
 *   close: () => void,
 * }>}
 */
export async function openCdpChannel(webSocketUrl, options = {}) {
  const { timeoutMs = 10_000, label = "browser" } = options;
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const handlers = new Map();
  let nextId = 0;
  let closed = false;

  const command = (method, params = {}, commandOptions = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error(`The ${label} CDP channel is closed.`));
      return;
    }
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The ${label} CDP command ${method} timed out.`));
    }, commandOptions.timeoutMs ?? timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (Number.isSafeInteger(message.id) && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`The ${label} CDP command failed: ${String(isRecord(message.error) ? message.error.message ?? "unknown" : "unknown")}`));
      else request.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string" && handlers.has(message.method)) handlers.get(message.method)(message.params);
  });
  socket.addEventListener("close", () => {
    closed = true;
    for (const request of pending.values()) request.reject(new Error(`The ${label} CDP channel disconnected.`));
    pending.clear();
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The ${label} CDP channel timed out connecting.`)), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`The ${label} CDP channel could not connect.`));
    }, { once: true });
  });

  return {
    command,
    on: (method, handler) => handlers.set(method, handler),
    off: (method) => handlers.delete(method),
    close: () => {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
}
