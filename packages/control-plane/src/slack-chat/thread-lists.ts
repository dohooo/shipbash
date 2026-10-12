/**
 * A conversation thread's to-do lists in Slack (todo-list.ts), drawn as the
 * work in them moves, and the thread's Working… status.
 *
 * The reply that announces new work carries its list (`forReply`, then
 * `announce`: the turn's, where a turn that said nothing posts the list
 * alone), and is recorded with the blocks it was posted with. From then on
 * the list is drawn from the work as it stands by whoever sees the work
 * move: the worker walking a run or a walk — at most once every few seconds
 * while it moves (a run's Journey reaching a checkpoint, a walk saying the
 * step it is on), at once when its job is taken up, turns to its owner, goes
 * on again, parks or ends (the DispatchWorker's `workProgress`, throttled by
 * work-progress.ts); a Sandbox, which holds no bot token, asks the job API to
 * draw each time instead (job-api/methods/progress.ts), and its Workflow makes
 * the last draw once the Sandbox has stopped (`settleJobWorkProgress`); the
 * turn that opens on a report of it, which settles a list a lost worker left;
 * and the owner's Stop, which draws the lists of what it stopped (`redraw`).
 * Work its owner stopped (store/slack-thread-stops.ts) is drawn as such: its
 * line struck through, who stopped it under it, and no Stop beside it; a
 * reply whose every piece of work was stopped is drawn as those lines alone,
 * without its words or its caption, so the thread keeps a short record of the
 * Stop. A draw is of a list — the reply's — whichever of its work moved:
 * `chat.update` replaces every block of a message, so the draw sends the
 * reply's recorded blocks back with the list's own swapped for the work as it
 * stands, and never reads the message back from Slack. In one process the
 * draws of a list never overlap, and at most one waits behind the draw under
 * way; across processes there is no claim on a list and no sweep: two draws
 * that cross each show the work as it stood, and the next one shows it as it
 * stands. A Stop that lands between a turn reading its new work and recording
 * the reply that carries it finds no list to draw, so the reply shows a walk
 * that Stop canceled while queued as starting: a narrow race, accepted.
 *
 * The thread shows ShipBash at work — Slack's Working… with its Stop — while
 * its conversation's turn, or a run or a walk it started, is at work
 * (store/slack-thread-work.ts), shown again whenever a job of its work is
 * taken up, turns to its owner, goes on again or is done, and at a turn's
 * end. Work waiting on the owner — a sign-in, a question — is not at work,
 * so a thread whose every piece of work waits on its owner shows idle.
 *
 * Drawing needs only the bot token the store opens and Chat SDK's posting
 * adapter, handed the token per call, which tries each call once and bounds
 * it: a draw that fails is logged, and holds up nothing that waits on it.
 * Nothing reachable from `apps/console/workflows/` may import this outside a
 * step: `chat` needs `node:crypto`.
 */
import type { SlackBlock } from "@chat-adapter/slack";

import { type WorkProgress, type WorkRef, workKey } from "../dispatch-worker-types.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { ThreadListItem, ThreadListPlace, ThreadWorkPlace } from "../store/slack-thread-lists.ts";
import type { SlackThreadAddress } from "../store/slack-threads.ts";
import { type ShipBashSlackAdapter, createPostingAdapter, isSlackBlock } from "./adapter.ts";
import { type TodoList, todoList, withTodoList } from "./todo-list.ts";
import { jobWork, throttledWorkProgress } from "./work-progress.ts";

export type ThreadListStore = Pick<
  InternalSlackStore,
  | "openSlackInstallationInternal"
  | "readThreadWorkPlaceInternal"
  | "readThreadListInternal"
  | "readUnannouncedThreadWorkInternal"
  | "announceThreadWorkInternal"
  | "readSlackThreadAtWorkInternal"
>;

/** What a list is drawn through: Chat SDK's Slack adapter, handed the token per call. */
export type ThreadListSlack = Pick<ShipBashSlackAdapter, "withBotToken" | "webClient" | "encodeThreadId" | "startTyping" | "endTyping">;

/** The list a reply announcing the thread's new work carries, and the rows it announces once it has posted. */
export interface ReplyList extends TodoList {
  threadId: string;
  workIds: string[];
}

export interface ThreadLists extends WorkProgress {
  /** The list a reply carries: the thread's work no reply has carried yet; null when there is none. Never throws. */
  forReply(thread: ThreadListPlace): Promise<ReplyList | null>;
  /** The reply carrying the list posted with these blocks: it is recorded, and its work is that reply's from now on. Never throws. */
  announce(list: ReplyList, reply: { ts: string; blocks: readonly SlackBlock[] }): Promise<void>;
  /** The lists this work rides in, each drawn once as its work stands. Never throws. */
  redraw(works: readonly WorkRef[]): Promise<void>;
  /** The thread shows whether ShipBash is at work in it: a turn's end. Never throws. */
  showStatus(thread: SlackThreadAddress & { threadId: string }): Promise<void>;
}

interface Dependencies {
  store: ThreadListStore;
  slack: ThreadListSlack;
  publicOrigin: string;
}

/** A list: the reply carrying it, in its thread. */
interface ListPlace {
  thread: ThreadListPlace;
  replyTs: string;
}

function listKey(list: ListPlace): string {
  return `${list.thread.threadId}:${list.replyTs}`;
}

/** The list the work rides in; null until a reply carried it. */
function listOf(place: ThreadWorkPlace | null): ListPlace | null {
  return place?.replyTs ? { thread: place.thread, replyTs: place.replyTs } : null;
}

/** The list of these items; `alone` when it is the whole of its reply. */
function drawList(deps: Dependencies, thread: ThreadListPlace, items: readonly ThreadListItem[], alone: boolean): TodoList {
  const links = { publicOrigin: deps.publicOrigin, teamSlug: thread.teamSlug, projectSlug: thread.projectSlug };
  return todoList({ items, links, conversationId: thread.conversationId, at: new Date(), alone });
}

/** Acts as the thread's workspace bot; a workspace that revoked ShipBash sees nothing more. */
async function asBot(deps: Dependencies, thread: SlackThreadAddress, act: () => Promise<unknown>): Promise<void> {
  const installation = await deps.store.openSlackInstallationInternal(thread.slackTeamId);
  if (!installation) return;
  await deps.slack.withBotToken(installation.botToken, act, { installationId: thread.slackTeamId });
}

/**
 * The reply's recorded blocks sent back with its list swapped for the work as
 * it stands; once every piece of its work was stopped, the list alone.
 */
async function paint(deps: Dependencies, { thread, replyTs }: ListPlace): Promise<void> {
  const list = await deps.store.readThreadListInternal({ teamId: thread.teamId, threadId: thread.threadId, replyTs });
  if (!list || list.items.length === 0) return;
  const alone = list.items.every((item) => item.stopped !== null);
  const drawn = drawList(deps, thread, list.items, alone).blocks;
  const blocks = alone ? drawn : withTodoList(list.blocks.filter(isSlackBlock), drawn);
  await asBot(deps, thread, () => deps.slack.webClient.chat.update({ channel: thread.channelId, ts: replyTs, blocks }));
}

/** The thread's work no reply has carried yet, as the list a reply carries. */
async function replyList(deps: Dependencies, thread: ThreadListPlace): Promise<ReplyList | null> {
  try {
    const work = await deps.store.readUnannouncedThreadWorkInternal({ teamId: thread.teamId, threadId: thread.threadId });
    const list = drawList(deps, thread, work.items, false);
    return list.blocks.length === 0 ? null : { threadId: thread.threadId, workIds: work.workIds, ...list };
  } catch (error) {
    console.error(`[slack-chat] the new work of thread ${thread.threadTs} could not be read:`, error);
    return null;
  }
}

async function announce(deps: Dependencies, list: ReplyList, reply: { ts: string; blocks: readonly SlackBlock[] }): Promise<void> {
  await deps.store.announceThreadWorkInternal({ threadId: list.threadId, workIds: list.workIds, replyTs: reply.ts, blocks: reply.blocks })
    .catch((error: unknown) => {
      console.error(`[slack-chat] the work reply ${reply.ts} carried was not recorded as announced:`, error);
    });
}

async function showStatus(deps: Dependencies, thread: SlackThreadAddress & { threadId: string }): Promise<void> {
  try {
    const atWork = await deps.store.readSlackThreadAtWorkInternal(thread.threadId);
    const threadId = deps.slack.encodeThreadId({ channel: thread.channelId, threadTs: thread.threadTs });
    await asBot(deps, thread, () => (atWork ? deps.slack.startTyping(threadId) : deps.slack.endTyping(threadId)));
  } catch (error) {
    console.error(`[slack-chat] the working status of thread ${thread.threadTs} was not shown:`, error);
  }
}

/** A work's list, drawn as the work stands. */
export interface ThreadListPainter {
  /** The work's list drawn now, after any draw of that list under way, then whether its thread is at work. Never throws. */
  show(work: WorkRef): Promise<void>;
  /** The lists this work rides in, each drawn once as its work stands. Never throws. */
  redraw(works: readonly WorkRef[]): Promise<void>;
  /** The work is done: where its list is is looked up again if it is shown again. */
  forget(work: WorkRef): void;
}

/**
 * One process's drawing of lists. Draws of one list never overlap: each
 * waits for the one before it, so the newer reading lands last. A work's
 * list is looked up once it is in a list, or found in no thread, until the
 * work is forgotten.
 */
function painter(deps: Dependencies): ThreadListPainter {
  /** Where each piece of work shown has its list, by work. */
  const places = new Map<string, Promise<ThreadWorkPlace | null>>();
  /** By list: the last draw asked for, and one asked for that has not begun. */
  const drawing = new Map<string, Promise<void>>();
  const waiting = new Map<string, Promise<void>>();

  /** Where the work's list is. Work no reply has carried yet is looked up again next time: a reply may carry it by then. */
  function find(work: WorkRef): Promise<ThreadWorkPlace | null> {
    const key = workKey(work);
    const known = places.get(key);
    if (known) return known;
    const found = deps.store.readThreadWorkPlaceInternal(work);
    const forget = () => {
      if (places.get(key) === found) places.delete(key);
    };
    places.set(key, found);
    found.then((place) => (place && place.replyTs === null ? forget() : undefined), forget);
    return found;
  }

  /** The list drawn now, after any draw under way; one already waiting to begin is this one, and reads the work when it does. */
  function draw(list: ListPlace): Promise<void> {
    const key = listKey(list);
    const queued = waiting.get(key);
    if (queued) return queued;
    const next = (drawing.get(key) ?? Promise.resolve())
      .then(() => {
        waiting.delete(key);
        return paint(deps, list);
      })
      .catch((error: unknown) => {
        console.error(`[slack-chat] the to-do list under reply ${list.replyTs} was not drawn:`, error);
      })
      .finally(() => {
        if (drawing.get(key) === next) drawing.delete(key);
      });
    drawing.set(key, next);
    waiting.set(key, next);
    return next;
  }

  return {
    async show(work) {
      try {
        const place = await find(work);
        if (!place) return;
        const list = listOf(place);
        if (list) await draw(list);
        await showStatus(deps, place.thread);
      } catch (error) {
        console.error(`[slack-chat] the to-do list of ${workKey(work)} could not be shown:`, error);
      }
    },
    async redraw(works) {
      try {
        const lists = new Map<string, ListPlace>();
        for (const place of await Promise.all(works.map((work) => deps.store.readThreadWorkPlaceInternal(work)))) {
          const list = listOf(place);
          if (list) lists.set(listKey(list), list);
        }
        await Promise.all([...lists.values()].map(draw));
      } catch (error) {
        console.error("[slack-chat] the to-do lists of the thread's work could not be drawn:", error);
      }
    },
    forget(work) {
      places.delete(workKey(work));
    },
  };
}

/** One draw's painter, for a process that draws now and then: the job API's draw, and the Workflow's last one. */
export function threadListPainter(input: { store: ThreadListStore; publicOrigin: string; slack?: ThreadListSlack }): ThreadListPainter {
  return painter({ store: input.store, slack: input.slack ?? createPostingAdapter(), publicOrigin: input.publicOrigin });
}

/** A worker's lists: its work drawn through the throttle, each list one draw at a time. */
export function createThreadLists(input: {
  store: ThreadListStore;
  publicOrigin: string;
  slack?: ThreadListSlack;
  intervalMs?: number;
}): ThreadLists {
  const deps: Dependencies = { store: input.store, slack: input.slack ?? createPostingAdapter(), publicOrigin: input.publicOrigin };
  const lists = painter(deps);
  const progress = throttledWorkProgress((work) => lists.show(work), input.intervalMs);
  return {
    moved: progress.moved,
    changed: progress.changed,
    async settle(work) {
      await progress.settle(work);
      lists.forget(work);
    },
    redraw: (works) => lists.redraw(works),
    forReply: (thread) => replyList(deps, thread),
    announce: (list, reply) => announce(deps, list, reply),
    showStatus: (thread) => showStatus(deps, thread),
  };
}

/**
 * The job's work drawn as it stands, once its Sandbox has stopped: the last
 * draw, which the Sandbox could not make once the run's end released its
 * lease. Never throws.
 */
export async function settleJobWorkProgress(
  store: ThreadListStore & Pick<InternalSlackStore, "readDispatchJobWorkInternal">,
  jobId: string,
  deps: { publicOrigin: string; slack?: ThreadListSlack },
): Promise<void> {
  try {
    const job = await store.readDispatchJobWorkInternal(jobId);
    const work = job && jobWork(job);
    if (work) await threadListPainter({ store, ...deps }).show(work);
  } catch (error) {
    console.error(`[slack-chat] the to-do list of job ${jobId} could not be settled:`, error);
  }
}
