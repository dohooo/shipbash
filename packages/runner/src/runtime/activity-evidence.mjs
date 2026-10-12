/**
 * The Activity runner's presentation-only evidence capture: narrative
 * thumbnails, pointer republication, and public page metadata. The factory
 * owns the two bounded counters (pointer events, screenshot sequence) so the
 * runner carries no mid-file mutable state for them; any capture failure
 * returns null and never fails the Activity.
 */
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { startAgentPointerChannelReader } from "./agent-pointer.mjs";
import { screencastBlackedOut } from "./screencast-blackout.mjs";

const MAX_AGENT_POINTER_EVENTS = 300;

const NARRATIVE_SCREENSHOT_MAX_DATA_URL = 48_000;

const PAGE_METADATA_SCRIPT = `(async () => {
  const icons = Array.from(document.querySelectorAll('link[rel~="icon"]'));
  const icon = icons.find((candidate) => candidate.type === 'image/svg+xml') ?? icons[0] ?? null;
  let faviconDataUrl = null;
  if (icon) {
    try {
      const blob = await (await fetch(icon.href, { credentials: 'include', signal: AbortSignal.timeout(2000) })).blob();
      if (blob.size <= 16384) {
        faviconDataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch {}
  }
  return {
    title: document.title,
    url: location.href,
    favicon: icon?.href ?? null,
    faviconDataUrl,
  };
})()`;

function publicPageUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function createActivityEvidence({
  agentBrowser,
  runProcess,
  emit,
  redactString,
  outputRoot,
  pointerChannelPath,
}) {
  let agentPointerEvents = 0;
  let narrativeScreenshotSequence = 0;

  /**
   * Captures the current viewport as a small JPEG thumbnail data URL for a
   * `finding` narrative beat. Presentation-only: any failure returns null and
   * never fails the Activity, and so does a screen hidden for a one-time code.
   */
  async function captureNarrativeThumbnail(env) {
    if (screencastBlackedOut()) return null;
    narrativeScreenshotSequence += 1;
    const shotPath = join(outputRoot, `narrative-shot-${narrativeScreenshotSequence}.png`);
    const thumbPath = join(outputRoot, `narrative-shot-${narrativeScreenshotSequence}.jpg`);
    try {
      await agentBrowser(["screenshot", shotPath], env);
      const scaled = await runProcess(
        "ffmpeg",
        ["-y", "-i", shotPath, "-vf", "scale=480:-2", "-q:v", "10", thumbPath],
        { timeoutMs: 15_000, captureStdout: false, logStderr: false },
      );
      if (scaled.code !== 0 || scaled.timedOut || scaled.canceled) return null;
      const thumbnail = await readFile(thumbPath);
      const dataUrl = `data:image/jpeg;base64,${thumbnail.toString("base64")}`;
      return dataUrl.length <= NARRATIVE_SCREENSHOT_MAX_DATA_URL ? dataUrl : null;
    } catch {
      return null;
    } finally {
      await unlink(shotPath).catch(() => {});
      await unlink(thumbPath).catch(() => {});
    }
  }

  /**
   * Tails the pointer channel the MCP proxy writes and republishes each
   * pointer as an `agent_pointer` evidence event plus a recording cue. The
   * proxy resolves coordinates BEFORE forwarding the action, so receipt time
   * is the causal anchor — the cursor leads the click instead of trailing it.
   * @param {(pointer: object) => void} [capturePointer] the walk's recording, which places it
   */
  function startActivityPointerReader(capturePointer = () => {}) {
    return startAgentPointerChannelReader(pointerChannelPath, (pointer) => {
      if (agentPointerEvents >= MAX_AGENT_POINTER_EVENTS) return;
      agentPointerEvents += 1;
      emit("evidence", "Agent pointer", {
        safeData: {
          event: "agent_pointer",
          action: pointer.action,
          x: pointer.x,
          y: pointer.y,
          width: pointer.width,
          height: pointer.height,
        },
      });
      capturePointer(pointer);
    });
  }

  async function readBrowserPageMetadata(env) {
    // The favicon fetch above self-aborts at 2s; this outer bound covers a
    // wedged renderer so the initial call can never stall the stream for the
    // CLI's full 45s default.
    const response = await agentBrowser(["eval", PAGE_METADATA_SCRIPT], env, { timeoutMs: 10_000 });
    const data = isRecord(response?.data) ? response.data : null;
    const result = isRecord(data?.result) ? data.result : null;
    const url = publicPageUrl(result?.url);
    if (!url) return null;
    const title = typeof result?.title === "string" && result.title.trim()
      ? redactString(result.title, 300).trim()
      : new URL(url).hostname;
    return {
      title,
      url,
      faviconUrl: publicPageUrl(result?.favicon),
      faviconDataUrl: typeof result?.faviconDataUrl === "string"
        && result.faviconDataUrl.length <= 24_000
        && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|ico);base64,/iu.test(result.faviconDataUrl)
        ? result.faviconDataUrl
        : null,
    };
  }

  return {
    captureNarrativeThumbnail,
    startActivityPointerReader,
    readBrowserPageMetadata,
  };
}
