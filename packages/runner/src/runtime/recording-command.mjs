// The commands a recording's assembly and export shell out to (ffmpeg,
// ffprobe), and the one check every step makes of a file it wrote.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const COMMAND_TIMEOUT_MS = 10 * 60_000;
/** A filter graph cannot quote a path, so an odd one is refused rather than mangled. */
const SAFE_FILTER_PATH = /^[A-Za-z0-9/_.-]+$/u;

/** A path as a filter graph names it: the export's overlays, smart pacing's still stretches. */
export function filterPath(path) {
  if (!SAFE_FILTER_PATH.test(path)) {
    throw new Error("A recording path needs escaping the filter graph cannot do.");
  }
  return path;
}

export async function nonEmptyFile(path) {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

export async function runRecordingCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-64_000);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out while finalizing browser recording.`));
    }, COMMAND_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${String(code)}: ${stderr || stdout}`));
    });
  });
}
