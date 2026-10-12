import type { ActivityRuntimeEvent } from "../activity-runtime.ts";
import type { DockerRuntimeEvent } from "../docker-runtime.ts";

export interface VercelSandboxBrowserStream {
  host: string;
  hostPort: number;
  protocol: "ws" | "wss";
  path?: string;
}

export type ResolveBrowserStream = (
  containerPort: number,
  context: { kind: "suite_run" | "activity"; taskId: string },
) => VercelSandboxBrowserStream | Promise<VercelSandboxBrowserStream>;

function browserPort(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535
    ? Number(value)
    : null;
}

/**
 * The stream to graft onto a Suite `browser_stream_ready` event, or null when
 * the event is not one, its port is outside the TCP range, or the caller
 * exposes no streams. Deliberately not async: the resolver is called, and its
 * result awaited, at exactly the points the inline decoration used.
 */
export function suiteBrowserStream(
  event: DockerRuntimeEvent,
  resolveBrowserStream: ResolveBrowserStream | undefined,
  taskId: string,
): VercelSandboxBrowserStream | Promise<VercelSandboxBrowserStream> | null {
  const port = event.type === "browser_stream_ready" ? browserPort(event.containerPort) : null;
  if (!port || !resolveBrowserStream) return null;
  return resolveBrowserStream(port, { kind: "suite_run", taskId });
}

export function activityBrowserStream(
  event: ActivityRuntimeEvent,
  resolveBrowserStream: ResolveBrowserStream | undefined,
  taskId: string,
): VercelSandboxBrowserStream | Promise<VercelSandboxBrowserStream> | null {
  const port = event.kind === "evidence" && event.safeData.event === "browser_stream_ready"
    ? browserPort(event.safeData.containerPort)
    : null;
  if (!port || !resolveBrowserStream) return null;
  return resolveBrowserStream(port, { kind: "activity", taskId });
}
