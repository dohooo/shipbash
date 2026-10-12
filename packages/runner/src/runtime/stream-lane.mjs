/**
 * The runner side of the browser stream lane, shared by the suite and
 * Activity runners. In hosted mode the wrapper owns the public stream
 * gateway and provides the upstream announcement channel; without one the
 * runner serves viewers itself on the published port (local docker).
 */
import {
  announceStreamUpstream,
  startStreamGateway,
  startStreamGatewayFromEnvironment,
  streamUpstreamChannelPath,
} from "./stream-gateway.mjs";

export const STREAM_GATEWAY_PORT = 9224;

/**
 * Creates the lane bound to this runner's work directory and pointer
 * channel. The factory holds the gateway binding; the runner only announces
 * ports and closes the lane on the way out.
 */
export function createStreamLane({ workDirectory, pointerChannelPath, env = process.env }) {
  const upstreamChannelPath = env.SHIPBASH_STREAM_UPSTREAM_CHANNEL?.trim()
    || streamUpstreamChannelPath(workDirectory);
  const ownsStreamGateway = !env.SHIPBASH_STREAM_UPSTREAM_CHANNEL?.trim();
  let streamGateway = null;

  /**
   * Publishes the current agent-browser stream port on the announcement
   * channel. The gateway follows announcements without dropping viewers, so a
   * restarted screencast resumes on the viewer's existing socket.
   */
  async function announceStreamPort(port) {
    if (ownsStreamGateway && !streamGateway) {
      // A lane reached over the Sandbox's public domain with no wrapper in
      // front of it (the hosted sign-in takeover) is handed the capability
      // path and allowed Origin the wrapper would have read; without them
      // the gateway serves "/" on the published local port, as docker does.
      streamGateway = env.SHIPBASH_BROWSER_STREAM_PATH?.trim()
        ? await startStreamGatewayFromEnvironment(env, { upstreamChannelPath, pointerChannelPath })
        : await startStreamGateway({ listenPort: STREAM_GATEWAY_PORT, upstreamChannelPath, pointerChannelPath });
    }
    await announceStreamUpstream(upstreamChannelPath, port);
  }

  async function closeStreamGateway() {
    const gateway = streamGateway;
    streamGateway = null;
    if (!gateway) return;
    await gateway.close().catch(() => {});
  }

  return {
    announceStreamPort,
    closeStreamGateway,
    viewerCount: () => streamGateway?.viewerCount() ?? 0,
  };
}
