/**
 * Which project a mention is about, when its author is in several and nothing
 * else says. The thread gets a select of their projects; the mention waits in
 * Chat SDK's state until the author picks one, then starts the thread's
 * conversation on it exactly as a mention in a one-project workspace does.
 *
 * Nothing is guessed: a conversation run on the wrong project is worse than
 * one more click. The choice holds for the thread, because a thread is one
 * conversation on one project (conversation.ts).
 */
import { Actions, Card, CardText, type ActionEvent, Message, type SerializedMessage, Select, SelectOption, type StateAdapter, type Thread } from "chat";

import { mrkdwn } from "../slack-block-kit.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { SlackAuthorProject } from "../store/slack-user-links.ts";
import { resolveThreadAuthor } from "./actor.ts";
import { type ConversationContext, converse } from "./conversation.ts";

/** The select's action id, which routes its pick back here. */
export const PROJECT_CHOICE_ACTION = "shipbash:project";

/** An hour to choose: the mention is held no longer, and asking again is one @. */
const CHOICE_TTL_MS = 60 * 60 * 1_000;

/** Slack's limit on an option's text. */
const OPTION_LABEL_LIMIT = 75;

export interface ProjectChoiceContext extends ConversationContext {
  slack: ConversationContext["slack"] & { deliverySlackTeamId(): string | null };
  store: ConversationContext["store"] & Pick<InternalSlackStore, "readSlackThreadAuthorInternal">;
  state: Pick<StateAdapter, "get" | "set" | "delete">;
}

/** The mention that is waiting, and the projects its author was offered. */
interface PendingChoice {
  message: SerializedMessage;
  slackUserId: string;
  projects: SlackAuthorProject[];
}

function pendingKey(threadId: string, messageId: string): string {
  return `shipbash:slack-project-choice:${threadId}:${messageId}`;
}

/** What an option carries: the waiting mention and the project it picks. A project id may hold ":", a message id never does. */
function optionValue(messageId: string, projectId: string): string {
  return `${messageId}:${projectId}`;
}

function parseOptionValue(value: string | undefined): { messageId: string; projectId: string } | null {
  const separator = value?.indexOf(":") ?? -1;
  if (value === undefined || separator < 0) return null;
  return { messageId: value.slice(0, separator), projectId: value.slice(separator + 1) };
}

/** A project's name, with its team when the choices span several: two teams may each have an "App". */
function optionLabel(project: SlackAuthorProject, byTeam: boolean): string {
  const label = byTeam ? `${project.projectName} · ${project.teamName}` : project.projectName;
  return label.slice(0, OPTION_LABEL_LIMIT);
}

/** Asks the author, in the thread, which of their projects the mention is about. */
export async function offerProjects(
  context: ProjectChoiceContext,
  thread: Thread,
  message: Message,
  projects: SlackAuthorProject[],
): Promise<void> {
  const pending: PendingChoice = { message: message.toJSON(), slackUserId: message.author.userId, projects };
  await context.state.set(pendingKey(thread.id, message.id), pending, CHOICE_TTL_MS);
  const byTeam = new Set(projects.map((project) => project.teamId)).size > 1;
  await thread.post(Card({
    children: [
      CardText("Which project is this about?"),
      Actions([Select({
        id: PROJECT_CHOICE_ACTION,
        label: "Project",
        placeholder: "Choose a project",
        options: projects.map((project) => SelectOption({
          label: optionLabel(project, byTeam),
          value: optionValue(message.id, project.projectId),
        })),
      })]),
    ],
  }));
}

/**
 * The author's pick: the card says which project was chosen, and the mention
 * starts the conversation on it as them. Anyone else's pick, a pick of a
 * project they were not offered, and a pick after the hour has passed do
 * nothing; the author's standing in the project's team is read again, since
 * it may have changed while the card stood.
 */
export async function chooseProject(context: ProjectChoiceContext, event: ActionEvent): Promise<void> {
  const slackTeamId = context.slack.deliverySlackTeamId();
  const picked = parseOptionValue(event.value);
  if (!event.thread || !slackTeamId || !picked) return;
  const key = pendingKey(event.threadId, picked.messageId);
  const pending = await context.state.get<PendingChoice>(key);
  if (!pending || pending.slackUserId !== event.user.userId) return;
  const project = pending.projects.find((entry) => entry.projectId === picked.projectId);
  if (!project) return;
  const actor = await resolveThreadAuthor(context, { slackTeamId, slackUserId: pending.slackUserId, project });
  if (actor.kind !== "member") return;
  await context.state.delete(key);
  await event.adapter.editMessage(
    event.threadId,
    event.messageId,
    Card({ children: [CardText(`Asking about ${mrkdwn(project.projectName)}.`)] }),
  ).catch((error: unknown) => console.error("[slack-chat] the project choice could not be marked chosen:", error));
  await converse(context, event.thread, Message.fromJSON(pending.message), { member: actor, slackTeamId });
}
