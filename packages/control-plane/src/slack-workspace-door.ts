/**
 * The one door onto a workspace's token, and the one place a dead token is
 * read as one.
 *
 * Slack answering `invalid_auth` for a workspace the pane still calls
 * connected is the failure this whole feature exists to prevent, so the
 * revocation the uninstall webhook would have written is written here instead
 * — before the caller ever learns what went wrong.
 *
 * Two callers go through it and they differ only in how the token is opened:
 * an admin in Settings, whose store lane proves their Team role, and the alert
 * sender, which has no actor and is trusted by construction. The rule about
 * what Slack's refusal means belongs to neither of them, so it lives here once.
 */
import { SLACK_DEAD_TOKEN_CODES, SlackCallError } from "./slack-channels.ts";

/**
 * There is no live token for this workspace: it is not this team's, or Slack
 * has stopped honouring it. Either way nothing can be delivered, and the pane
 * shows it as the revoked state rather than as one row's error.
 */
export class SlackNotDeliveringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackNotDeliveringError";
  }
}

/** How one caller opens a workspace's token and how it writes the revocation. */
export interface SlackWorkspaceDoor {
  open: () => Promise<{ botToken: string; slackTeamId: string } | null>;
  revoke: (slackTeamId: string) => Promise<void>;
}

/** Runs `call` on this workspace's live token, told which workspace it is, or raises why it could not. */
export async function inSlackWorkspace<T>(
  door: SlackWorkspaceDoor,
  call: (token: string, slackTeamId: string) => Promise<T>,
): Promise<T> {
  const opened = await door.open();
  if (!opened) throw new SlackNotDeliveringError("This Slack workspace is no longer delivering.");
  try {
    return await call(opened.botToken, opened.slackTeamId);
  } catch (error) {
    if (!(error instanceof SlackCallError) || !SLACK_DEAD_TOKEN_CODES.has(error.code)) throw error;
    await door.revoke(opened.slackTeamId);
    throw new SlackNotDeliveringError("Slack has stopped honouring this connection.");
  }
}
