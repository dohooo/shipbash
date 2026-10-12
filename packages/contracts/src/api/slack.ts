import { z } from "zod";

import { PUBLIC_SLACK_CHANNEL_BINDINGS_DELIVERY_ERROR_VALUES } from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import { idSchema, teamParamsSchema, timestampSchema } from "./primitives.ts";

/**
 * Why a delivery was refused. Slack's own error codes are mapped onto these
 * four once, in the control plane, so the pane has a fixed vocabulary to turn
 * into a sentence and an instruction. An auth failure is deliberately not one
 * of them: that is the workspace, and `revokedAt` already says it.
 */
export const slackDeliveryErrorSchema = z.enum(
	PUBLIC_SLACK_CHANNEL_BINDINGS_DELIVERY_ERROR_VALUES,
);

/** A channel the bot may post in: every public one, plus the private ones it is in. */
const slackChannelSchema = z.object({
	id: idSchema,
	name: z.string(),
	isPrivate: z.boolean(),
});

/**
 * One channel a project's failures are announced in; a project with several
 * channels appears once per channel. The channel is what an admin chose;
 * `lastDeliveredAt` is never a claim about that choice — it is the last time a
 * message really arrived, and null until a test or an alert does.
 */
const slackChannelBindingSchema = z.object({
	projectId: idSchema,
	/** Named here and not looked up: a project may be archived and still be bound. */
	projectName: z.string(),
	channel: slackChannelSchema,
	lastDeliveredAt: timestampSchema.nullable(),
	deliveryError: slackDeliveryErrorSchema.nullable(),
	/**
	 * Failures this project had to announce and could not, counted over the
	 * window the current silence opened: since the workspace was revoked, or
	 * since this channel last took a message. It is a count of outbox rows and
	 * never a re-reading of the runs, so nothing has to be reset — reconnecting
	 * or a delivery landing moves the window's start and the number falls away.
	 */
	unannouncedFailures: z.number().int().nonnegative(),
});

/**
 * One connected Slack workspace. There is no status field: `revokedAt` is the
 * status — set means Slack stopped honouring the token, and nothing else about
 * the connection changed, bindings included.
 */
const slackWorkspaceSchema = z.object({
	id: idSchema,
	slackTeamId: idSchema,
	name: z.string(),
	iconUrl: z.string().nullable(),
	/** Who installed it, as the team knows them; null when their profile is gone. */
	connectedBy: z.string().nullable(),
	connectedAt: timestampSchema,
	revokedAt: timestampSchema.nullable(),
	/** One entry per channel of this workspace a project alerts into; projects that alert nowhere here are not rows. */
	bindings: z.array(slackChannelBindingSchema),
	/** The same loss summed across those projects: what the revoked card closes with. */
	unannouncedFailures: z.number().int().nonnegative(),
});

/**
 * An install this team started and never finished. There is no deadline on it
 * and no claim about why: Slack does not call back when an install needs an
 * admin's approval, so all that is known is who started it and when.
 */
const slackPendingInstallSchema = z.object({
	startedBy: z.string().nullable(),
	startedAt: timestampSchema,
});

export const teamSlackConnectionsContract = defineApiContract({
	id: "slack.connections",
	method: "GET",
	path: "/api/teams/:teamId/slack",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.object({
		workspaces: z.array(slackWorkspaceSchema),
		pendingInstall: slackPendingInstallSchema.nullable(),
	}),
	successStatuses: [200],
});

const slackWorkspaceParamsSchema = teamParamsSchema.extend({
	workspaceId: idSchema,
});

export const disconnectSlackWorkspaceContract = defineApiContract({
	id: "slack.disconnectWorkspace",
	method: "DELETE",
	path: "/api/teams/:teamId/slack/workspaces/:workspaceId",
	params: slackWorkspaceParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

export const abandonSlackInstallContract = defineApiContract({
	id: "slack.abandonInstall",
	method: "DELETE",
	path: "/api/teams/:teamId/slack/install",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

/**
 * The channels this workspace offers, read on demand because it costs a call
 * to Slack. A bot token only ever lists private channels the bot is already in,
 * so what comes back is every public channel plus the private ones ShipBash
 * has been invited to — never the private channels it cannot see.
 */
export const slackChannelsContract = defineApiContract({
	id: "slack.channels",
	method: "GET",
	path: "/api/teams/:teamId/slack/workspaces/:workspaceId/channels",
	params: slackWorkspaceParamsSchema,
	query: null,
	body: null,
	response: z.object({
		channels: z.array(slackChannelSchema),
		/** Slack has more than this pane will read; the reader is told rather than misled. */
		truncated: z.boolean(),
	}),
	successStatuses: [200],
});

const slackChannelRouteParamsSchema = teamParamsSchema.extend({ projectId: idSchema, channelId: idSchema });

/**
 * Adds a channel to the ones a project alerts into; a project may have several,
 * and a channel may serve several projects. Slack is asked about the channel
 * before anything is written, so one that is gone, archived or closed to
 * ShipBash answers with the reason and the project keeps the routes it had. A
 * channel added anew is sent the test message; how that ended is the binding's
 * delivery, read with the connections, never this answer. Adding a channel the
 * project already alerts into changes nothing.
 */
export const bindSlackChannelContract = defineApiContract({
	id: "slack.bindChannel",
	method: "PUT",
	path: "/api/teams/:teamId/slack/bindings/:projectId/channels/:channelId",
	params: slackChannelRouteParamsSchema,
	query: null,
	body: z.object({ workspaceId: idSchema }),
	response: z.object({ refused: slackDeliveryErrorSchema.nullable() }),
	successStatuses: [200],
});

/**
 * Sends a test message to one of the project's channels, and records how it
 * ended exactly as an alert's delivery would. It never adds or removes a
 * channel.
 */
export const testSlackBindingContract = defineApiContract({
	id: "slack.testBinding",
	method: "POST",
	path: "/api/teams/:teamId/slack/bindings/:projectId/channels/:channelId/test",
	params: slackChannelRouteParamsSchema,
	query: null,
	body: null,
	response: z.object({ deliveryError: slackDeliveryErrorSchema.nullable() }),
	successStatuses: [200],
});

/** The project stops alerting into this channel; its other channels and the workspace are untouched. */
export const unbindSlackChannelContract = defineApiContract({
	id: "slack.unbindChannel",
	method: "DELETE",
	path: "/api/teams/:teamId/slack/bindings/:projectId/channels/:channelId",
	params: slackChannelRouteParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

/**
 * One Sign in with Slack attempt the caller started and Slack answered. It
 * belongs to the account that started it, so to anyone else it is not found.
 */
const slackConnectParamsSchema = z.object({ signInId: z.uuid() }).strict();

/**
 * Who the attempt signs in, as the confirm screen names them: the Slack user
 * and workspace Slack's verified id_token named, and the channel to go back
 * to. One that expired or was already confirmed is not found.
 */
const slackConnectRequestSchema = z
	.object({
		slackTeamId: idSchema,
		slackTeamName: z.string(),
		slackUserName: z.string(),
		channelId: idSchema,
	})
	.strict();

export const getSlackConnectContract = defineApiContract({
	id: "slack.connect.get",
	method: "GET",
	path: "/api/slack/connect/:signInId",
	params: slackConnectParamsSchema,
	query: null,
	body: null,
	response: z.object({ request: slackConnectRequestSchema }).strict(),
	successStatuses: [200],
});

/**
 * The Slack user the attempt verified signs in as the caller from now on, and
 * the attempt is spent. Only the console session that was shown the confirm
 * screen may: a CLI token is refused.
 */
export const confirmSlackConnectContract = defineApiContract({
	id: "slack.connect.confirm",
	method: "POST",
	path: "/api/slack/connect/:signInId",
	params: slackConnectParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
