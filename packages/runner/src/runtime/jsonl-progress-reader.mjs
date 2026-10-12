/**
 * The 100ms JSONL tail both runners point at their agent's progress channel.
 * The reader owns the file mechanics — unlink before start, offset tracking,
 * a truncation guard, one serialized drain chain, an unref'd interval, and a
 * stop() that flags a partial trailing event — while each caller supplies the
 * per-line parse-and-emit behavior. onLine receives the raw line and the
 * revision it must carry (1-based); the reader advances its count only after
 * onLine returns without throwing, and the first onLine failure latches until
 * stop() rethrows it.
 */
import { readFile, unlink } from "node:fs/promises";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

/**
 * The envelope every revisioned JSONL line must carry: valid JSON, an object,
 * schemaVersion 1 and exactly the expected revision. Returns the parsed
 * object; event-level validation stays with each channel's own parser. Error
 * messages open with the channel's name verbatim.
 */
export function parseRevisionEnvelope(line, expectedRevision, channelName) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`${channelName} emitted invalid JSON.`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.revision !== expectedRevision) {
    throw new Error(`${channelName} emitted an invalid or out-of-order event.`);
  }
  return value;
}

export async function createJsonlRevisionReader(eventPath, { channelName, onLine }) {
  await unlink(eventPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  let revision = 0;
  let offset = 0;
  let buffered = "";
  let failure = null;
  let draining = Promise.resolve();

  const drain = () => {
    draining = draining.then(async () => {
      if (failure) return;
      let contents;
      try {
        contents = await readFile(eventPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (contents.length < offset) {
        throw new Error(`${channelName} was truncated during execution.`);
      }
      buffered += contents.slice(offset);
      offset = contents.length;
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        await onLine(line, revision + 1);
        revision += 1;
      }
    }).catch((error) => {
      failure = error;
    });
    return draining;
  };

  const interval = setInterval(() => void drain(), 100);
  interval.unref();
  return {
    async stop() {
      clearInterval(interval);
      await drain();
      if (buffered.trim()) {
        failure ??= new Error(`${channelName} ended with a partial event.`);
      }
      if (failure) throw failure;
      return revision;
    },
  };
}
