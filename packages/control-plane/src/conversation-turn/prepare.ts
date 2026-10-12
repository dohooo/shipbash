/**
 * A conversation turn's ground and its opening, the twin of a Sandbox leg's
 * preparation (vercel-sandbox-task/prepare-activity.ts).
 *
 * The worker's preparation only claims the ground: a directory of the turn's
 * own and the thread it answers in. The record the turn opens on is read when
 * the turn starts (openTurn, from runtime.ts), so whatever fails there on
 * ShipBash's side ends the turn needing attention, with the notice in the
 * thread, and the next message wakes it.
 *
 * The opening is what every leg starts out knowing (agent-data/opening.ts),
 * read in-process under the turn's lease — the pi session the last turn
 * saved, the newest run and session with its console page — and then, in the newest user message so
 * the cached prefix is untouched: on a fresh session the product it is about,
 * then the saved ways in as they are bound now, then when the Suite runs on
 * its own, then the work in flight, then the messages owed to it in order —
 * each message to it headed by who wrote it and where it stands in its Slack
 * thread, then its words as they wrote them; each report rendered from its
 * work as it stands now (reports.ts); the asides said in the thread
 * meanwhile, by anyone, as a quoted run under its own heading, context that
 * ends where the quoting does — with the images the owner's carry after the
 * words (images.ts). Recall and the history are read on demand when the turn
 * asks (tools.ts).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { savedWaysInList } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { boundRepositoryLine } from "@shipbash/contracts/runtime/production-prompts.mjs";
import type { SteerImage } from "@shipbash/contracts/steer-images";

import type { ConsoleLinks } from "../console-links.ts";
import { type PreparedActivityRuntime, type WorkRef, workKey } from "../dispatch-worker-types.ts";
import { runtimeRepository } from "../job-repository.ts";
import { pickSeedSuite } from "../service/dispatch-activity-journeys.ts";
import { writeActivitySession } from "../service/dispatch-activity-session.ts";
import type { OwedSteer } from "../store/activities.ts";
import { parseReportKey, reportedWorkOf } from "../store/conversation-reports.ts";
import type { InternalSlackStore } from "../store/internal-lanes-slack.ts";
import type { TenantStore } from "../store/tenant-store.ts";
import type { ActivityExecutionInput, DispatchJobLeaseCapability } from "../types.ts";
import { ASIDE_HEADING, asideLine, messageToYou, newestWithin, omittedNote } from "./asides.ts";
import { type ImageSource, type OwnerImage, fetchTurnImages } from "./images.ts";
import { type ReportScope, type ReportStore, renderInFlight, renderReport, renderSchedule } from "./reports.ts";

/** The thread a turn answers in, and the slugs its links are built from. */
export type TurnThread = NonNullable<Awaited<ReturnType<InternalSlackStore["readSlackThreadOfConversationInternal"]>>>;

/** A turn the worker claimed: the lease it acts under, its input, its directory, and its thread. */
export interface ClaimedTurn {
  capability: DispatchJobLeaseCapability;
  input: ActivityExecutionInput;
  directory: string;
  thread: TurnThread;
}

/** What a turn opens on, read from the record as it starts. */
export interface TurnOpening {
  /** The transcript the last turn saved, or null for a new conversation. */
  transcriptPath: string | null;
  opening: string;
  /** The images of the owner's messages it answers, which ride after its words: a walk this turn starts carries them too. */
  images: OwnerImage[];
  /** The keys of the messages the opening delivers, acknowledged once the transcript is saved. */
  delivered: string[];
  /** The owner's own messages among them: a walk this turn starts carries them. */
  ownerMessages: string[];
  /** The work the reports are about, whose to-do lists are drawn as it stands now. */
  reported: WorkRef[];
  /** The console pages of the thread's project: every link the turn gives is built from them. */
  links: ConsoleLinks;
}

/** Where the turn's links point: its thread's team and project in the console. */
function turnLinks(publicOrigin: string, thread: TurnThread): ConsoleLinks {
  return { publicOrigin, teamSlug: thread.teamSlug, projectSlug: thread.projectSlug };
}

/** Where in its directory a turn keeps its pi session and its control mount. */
export function turnDirectories(directory: string): { session: string; control: string } {
  return { session: join(directory, "pi-session"), control: join(directory, "control") };
}

/** The worker's preparation: the thread, and a directory whose control mount is ready for the Stop. */
export async function claimConversationTurn(
  store: Pick<InternalSlackStore, "readSlackThreadOfConversationInternal">,
  input: ActivityExecutionInput,
  capability: DispatchJobLeaseCapability,
): Promise<ClaimedTurn> {
  const thread = await store.readSlackThreadOfConversationInternal({ teamId: input.job.teamId, activityId: input.activity.id });
  if (!thread) throw new Error("A conversation turn needs the Slack thread it answers in.");
  const directory = await mkdtemp(join(tmpdir(), "shipbash-turn-"));
  await mkdir(turnDirectories(directory).control, { recursive: true });
  return { capability, input, directory, thread };
}

/** The claimed turn as the worker hands it to the runtime; the runtime saves the transcript itself. */
export function preparedTurnRuntime(turn: ClaimedTurn): PreparedActivityRuntime {
  const { input } = turn;
  return {
    input: {
      activityId: input.activity.id,
      kind: input.activity.kind,
      projectId: input.job.projectId,
      productionUrl: input.productionUrl,
      testingContext: input.testingContext,
      boundSignIns: input.boundSignIns,
      targetSuiteId: null,
      promptContractVersion: input.promptContractVersion,
      repositoryCheckoutLocator: turn.directory,
      // A turn runs on the host and checks out nothing; it reads the bound repository on GitHub.
      repositoryAvailable: false,
      repositoryCommitSha: null,
      repository: runtimeRepository(input.repository),
      suites: input.suites,
      recordScreen: false,
    },
    dispose: () => rm(turn.directory, { recursive: true, force: true }),
  };
}

/**
 * The saved ways into the product as they are bound now, the Activity brief's
 * words: method and account label, never a credential. Every turn opens on
 * it, since a binding can change between two messages of one thread.
 */
function savedWaysInLine(signIns: ActivityExecutionInput["boundSignIns"]): string {
  return signIns.length > 0
    ? `Saved ways in for this product (bound to this project and ready; a walk signs in with them itself): ${savedWaysInList(signIns)}.`
    : "Saved ways in for this product: none bound to this project.";
}

/**
 * The bound repository as every agent's brief names it, when the turn reads it
 * on GitHub (github.ts); every turn opens on it, since a binding can change
 * between two messages.
 */
function repositoryLine(input: ActivityExecutionInput, readable: boolean): string {
  const repository = readable ? runtimeRepository(input.repository) : null;
  return repository ? boundRepositoryLine(repository) : "Repository: none bound to this project.";
}

/** What a new conversation opens on: the product it is about, and ShipBash's latest work on it. */
function freshBrief(input: ActivityExecutionInput, testingContext: string | null, historyNote: string | null): string {
  return [
    `This conversation is about the product at ${input.productionUrl}.`,
    `Testing context (the owner's words, then what ShipBash recorded): ${testingContext ?? "None provided."}`,
    ...(historyNote ? [historyNote] : []),
  ].join("\n");
}

async function turnMessages(store: ReportStore, scope: ReportScope, steers: readonly OwedSteer[]) {
  const messages: string[] = [];
  const ownerMessages: string[] = [];
  const ownerImages: SteerImage[] = [];
  const reported = new Map<string, WorkRef>();
  const told = new Set<string>();
  let asides: OwedSteer[] = [];
  // A run of asides is read up to its token budget: its newest lines, and how many earlier ones are not.
  // Every one of them is still delivered, so none is owed again.
  const closeAsides = async () => {
    if (asides.length === 0) return;
    const read = await newestWithin(asides);
    asides = [];
    const note = read.omitted > 0 ? [asideLine(omittedNote(read.omitted))] : [];
    messages.push([ASIDE_HEADING, ...note, ...read.lines.map(asideLine)].join("\n"));
    // An aside's images ride as the opening's earlier messages' do; its words are no request a walk carries.
    for (const aside of read.lines) ownerImages.push(...aside.images);
  };
  for (const steer of steers) {
    if (steer.kind === "aside") {
      asides.push(steer);
      continue;
    }
    await closeAsides();
    const work = parseReportKey(steer.clientKey);
    if (!work) {
      messages.push(messageToYou(steer));
      ownerMessages.push(steer.message);
      ownerImages.push(...steer.images);
      continue;
    }
    const reportedWork = reportedWorkOf(steer.clientKey);
    if (reportedWork) reported.set(workKey(reportedWork), reportedWork);
    // A walk is rendered as it stands now, so two of its reports read alike: it is told once.
    const subject = work.kind === "walk" ? `walk:${work.id}` : steer.clientKey;
    if (told.has(subject)) continue;
    told.add(subject);
    messages.push(await renderReport(store, scope, work));
  }
  await closeAsides();
  return { messages, ownerMessages, ownerImages, reported: [...reported.values()] };
}

export async function openTurn(
  context: { store: TenantStore; publicOrigin: string } & ImageSource,
  turn: ClaimedTurn,
  readsGitHub: boolean,
): Promise<TurnOpening> {
  const { store } = context;
  const { input, thread } = turn;
  const directories = turnDirectories(turn.directory);
  const links = turnLinks(context.publicOrigin, thread);
  const opening = await store.agentData.activityOpening(turn.capability, input, links);
  await writeActivitySession(directories.session, opening);
  const scope: ReportScope = { teamId: input.job.teamId, projectId: input.job.projectId, conversationId: input.activity.id, links };
  // None of the opening's parts reads another's: they are read at once.
  const [owed, schedule, inFlight] = await Promise.all([
    turnMessages(store.internal, scope, opening.pendingSteers),
    renderSchedule(store.internal, scope, pickSeedSuite(input.suites)?.id ?? null),
    renderInFlight(store.internal, scope),
  ]);
  const brief = opening.session ? null : freshBrief(input, opening.testingContext, opening.historyOpening);
  const shown = await fetchTurnImages(context, thread, owed.ownerImages);
  return {
    transcriptPath: opening.session ? join(directories.session, opening.session.transcriptFile) : null,
    opening: [brief, savedWaysInLine(input.boundSignIns), repositoryLine(input, readsGitHub), schedule, inFlight, ...owed.messages, ...shown.notes]
      .filter((part) => part !== null).join("\n\n"),
    images: shown.images,
    delivered: opening.pendingSteers.map((steer) => steer.clientKey),
    ownerMessages: owed.ownerMessages,
    reported: owed.reported,
    links,
  };
}
