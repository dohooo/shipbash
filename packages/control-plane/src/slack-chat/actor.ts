/**
 * Who a Slack message's author is to ShipBash, and which project it is about.
 *
 * A message counts only when its author has signed in to ShipBash from Slack
 * and is in a team that connected the workspace. No channel names the project:
 * an author in one project's team is answered on it, and one in several is
 * asked which (project-choice.ts). Every other answer names what the author is
 * instead, for the caller to tell them: not signed in, outside the team, or in
 * a team with no project yet.
 */
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { SlackAuthorProject } from "../store/slack-user-links.ts";

export type SlackActor =
  /** No ShipBash team has the workspace connected, so there is nobody to ask. */
  | { kind: "disconnected" }
  /** Not signed in yet. */
  | { kind: "unlinked" }
  | { kind: "not_member"; team: { slug: string; name: string } }
  /** In a team of the workspace, which has no live project. */
  | { kind: "no_project"; team: { slug: string; name: string } }
  /** In more than one project, and the message does not say which. */
  | { kind: "choose"; userId: string; projects: SlackAuthorProject[] }
  | { kind: "member"; userId: string; teamId: string; projectId: string };

export interface SlackActorContext {
  store: Pick<InternalSlackStore, "readSlackAuthorStandingInternal">;
}

export async function resolveSlackActor(
  context: SlackActorContext,
  input: { slackTeamId: string; slackUserId: string },
): Promise<SlackActor> {
  const { userId, teams, projects } = await context.store.readSlackAuthorStandingInternal(input);
  const [first] = teams;
  if (!first) return { kind: "disconnected" };
  if (!userId) return { kind: "unlinked" };
  const [only, ...others] = projects;
  if (!only) {
    const member = teams.find((entry) => entry.member);
    return member
      ? { kind: "no_project", team: { slug: member.slug, name: member.name } }
      : { kind: "not_member", team: { slug: first.slug, name: first.name } };
  }
  if (others.length > 0) return { kind: "choose", userId, projects };
  return { kind: "member", userId, teamId: only.teamId, projectId: only.projectId };
}

/**
 * Who a message's author is to the project a thread already belongs to: the
 * one its conversation is on, or the one whose alert it hangs under. Only the
 * author's sign-in and their place in that team count.
 */
export async function resolveThreadAuthor(
  context: { store: Pick<InternalSlackStore, "readSlackThreadAuthorInternal"> },
  input: { slackTeamId: string; slackUserId: string; project: { teamId: string; projectId: string } },
): Promise<Exclude<SlackActor, { kind: "choose" | "no_project" }>> {
  const { slackTeamId, slackUserId, project } = input;
  const author = await context.store.readSlackThreadAuthorInternal({ slackTeamId, slackUserId, teamId: project.teamId });
  if (!author) return { kind: "disconnected" };
  if (!author.userId) return { kind: "unlinked" };
  if (!author.member) return { kind: "not_member", team: author.team };
  return { kind: "member", userId: author.userId, teamId: project.teamId, projectId: project.projectId };
}
