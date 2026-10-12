/**
 * What every route group shares: the per-request context, the project scope
 * resolver, the archived-project gate, and the two long-poll event servers.
 */
import type { TenantActor } from "../types.ts";
import type { ApiOptions } from "../api.ts";
import type { ApiRequest, ApiResponse } from "./http.ts";
import { ApiError, NO_STORE_CACHE_CONTROL } from "./http.ts";
import { activityEventView, terminalActivityStatuses } from "./views.ts";
import type { StoreActivityStreamTick, StoreRunStreamState } from "./gateways.ts";
import { suiteRunTickFrames } from "./run-stream-views.ts";
import type { ActivitySummary } from "../types.ts";
import {
  activityDoneFrameSchema,
  activityEventFrameSchema,
  runDoneFrameSchema,
} from "@shipbash/contracts/api/streams";

export interface RouteContext {
  url: URL;
  request: ApiRequest;
  response: ApiResponse;
  actor: TenantActor;
  /** The CLI token the caller presented, when the actor came from one. */
  cliToken: { id: string } | null;
  options: ApiOptions;
}

export function requireTeamAdmin(teamRole: string, message: string): void {
  if (teamRole !== "admin") throw new ApiError(403, "FORBIDDEN", message);
}

/**
 * An archived Project must refuse new work at creation time. Without this
 * gate the run row is created, its job is silently reaped seconds later by
 * the archived-project reconciler, and the user watches a verification that
 * will never start.
 */
export function assertProjectAcceptsRuns(project: { lifecycleStatus: string }): void {
  if (project.lifecycleStatus === "archived") {
    throw new ApiError(
      409,
      "PROJECT_ARCHIVED",
      "This Project is archived. Restore it before starting new work.",
    );
  }
}

export async function projectContext(
  store: ApiOptions["store"],
  actor: TenantActor,
  projectId: string,
): Promise<{
  project: NonNullable<Awaited<ReturnType<ApiOptions["store"]["getProject"]>>>;
  teamId: string;
  teamRole: "admin" | "member";
}> {
  const teams = await store.listTeams(actor);
  for (const team of teams) {
    const project = await store.getProject(actor, team.id, projectId);
    if (project) return { project, teamId: team.id, teamRole: team.role };
  }
  throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
}

// End event streams before Vercel's 300-second Function limit force-kills the
// invocation (which logs a runtime timeout error). Clients reconnect through
// the SSE retry directive and resume from their last event id.
const MAX_EVENT_STREAM_LIFETIME_MS = 270_000;

/**
 * The long-poll SSE skeleton both event servers share: stream headers, the
 * retry directive, 750ms polling, 15s heartbeats, the lifetime cap, and the
 * stop/done/close plumbing. Each lane keeps its own detail fetch, frame
 * assembly (emit, owning the lane's cursor), and done-frame encoding as
 * explicit parameters.
 */
async function serveEventStream<Detail, Status extends string>(
  response: ApiResponse,
  lane: {
    fetch(): Promise<Detail | null>;
    notFound: { code: string; message: string };
    /** Write this lane's frames; a returned status ends the stream. */
    emit(detail: Detail): Status | null;
    doneFrame(status: Status): unknown;
  },
): Promise<void> {
  const initial = await lane.fetch();
  if (!initial) throw new ApiError(404, lane.notFound.code, lane.notFound.message);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": NO_STORE_CACHE_CONTROL,
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write("retry: 1000\n\n");
  let stopped = false;
  let polling = false;
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let lifetime: NodeJS.Timeout | null = null;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolvePromise) => {
    resolveCompletion = resolvePromise;
  });
  const stop = (status?: Status): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    if (status && !response.writableEnded) {
      response.write(`event: done\ndata: ${JSON.stringify(lane.doneFrame(status))}\n\n`);
    }
    if (!response.writableEnded) response.end();
    resolveCompletion();
  };
  const emit = (detail: Detail): void => {
    const terminalStatus = lane.emit(detail);
    if (terminalStatus) stop(terminalStatus);
  };
  response.once("close", () => stop());
  emit(initial);
  if (stopped) return completion;
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const detail = await lane.fetch();
      if (!detail) stop();
      else emit(detail);
    } catch {
      stop();
    } finally {
      polling = false;
    }
  };
  timer = setInterval(() => void poll(), 750);
  timer.unref();
  heartbeat = setInterval(() => {
    if (!stopped && !response.writableEnded) response.write(": keepalive\n\n");
  }, 15_000);
  heartbeat.unref();
  lifetime = setTimeout(() => stop(), MAX_EVENT_STREAM_LIFETIME_MS);
  lifetime.unref();
  return completion;
}

/** One Run tick: what the frames carry is read only when the tick says something moved. */
interface RunStreamRead {
  /** The run's greatest event sequence when the tick was read. */
  lastSequence: number;
  streamUrl: string;
  state: StoreRunStreamState | null;
}

function terminalRunStatus(status: StoreRunStreamState["run"]["status"]): "completed" | "canceled" | null {
  return status === "completed" || status === "canceled" ? status : null;
}

export async function serveSuiteRunEvents(
  response: ApiResponse,
  store: Pick<ApiOptions["store"], "getSuiteRunStreamTick" | "getSuiteRunStreamState">,
  actor: TenantActor,
  teamId: string,
  projectId: string,
  runId: string,
  afterSequence: number,
): Promise<void> {
  let lastSequence = afterSequence;
  let lastStatus: string | null = null;
  return serveEventStream<RunStreamRead, "completed" | "canceled">(response, {
    fetch: async () => {
      const tick = await store.getSuiteRunStreamTick(actor, teamId, projectId, runId);
      if (!tick) return null;
      const read = { lastSequence: tick.lastSequence, streamUrl: tick.streamUrl ?? "" };
      // lastStatus starts null, so the first tick always reads the run and the
      // connection opens with its backlog or a status frame, as it always has.
      if (tick.lastSequence <= lastSequence && tick.status === lastStatus) return { ...read, state: null };
      const state = await store.getSuiteRunStreamState(actor, teamId, projectId, runId, lastSequence);
      return state ? { ...read, state } : null;
    },
    notFound: { code: "RUN_NOT_FOUND", message: "Run was not found." },
    emit: (read) => {
      if (!read.state) return null;
      const next = suiteRunTickFrames(read.state, projectId, read.streamUrl, lastStatus);
      for (const { sequence, frame } of next.events) {
        response.write(`id: ${String(sequence)}\ndata: ${JSON.stringify(frame)}\n\n`);
      }
      if (next.status) response.write(`data: ${JSON.stringify(next.status)}\n\n`);
      lastStatus = next.liveStatus;
      // The cursor belongs to the side that read with one: it moves over the
      // last row read, not the last frame written. The view projects some
      // events away (an artifact_saved naming no artifact), and a cursor stuck
      // behind one would re-read the run on every tick and never end it.
      lastSequence = read.state.events.at(-1)?.sequence ?? lastSequence;
      // A backlog longer than one read's event page pages forward on the
      // next ticks; done waits until the read caught up with the tick.
      return lastSequence >= read.lastSequence ? terminalRunStatus(read.state.run.status) : null;
    },
    doneFrame: (status) => runDoneFrameSchema.parse({ status, lastSequence }),
  });
}

export async function serveActivityEvents(
  response: ApiResponse,
  options: ApiOptions,
  actor: TenantActor,
  teamId: string,
  projectId: string,
  activityId: string,
  afterSequence: number,
): Promise<void> {
  let lastSequence = afterSequence;
  return serveEventStream<StoreActivityStreamTick, ActivitySummary["status"]>(response, {
    // The cursor the closure reads is the one emit just advanced, so each
    // tick asks only for what it has not sent.
    fetch: () => options.store.getActivityStreamTick(actor, teamId, projectId, activityId, lastSequence),
    notFound: { code: "ACTIVITY_NOT_FOUND", message: "Activity was not found." },
    emit: (tick) => {
      for (const event of tick.events) {
        const frame = activityEventFrameSchema.parse({
          ...activityEventView(event),
          status: tick.status,
        });
        response.write(`id: ${String(event.sequence)}\ndata: ${JSON.stringify(frame)}\n\n`);
        lastSequence = event.sequence;
      }
      // A backlog longer than one page outlives the terminal status: done
      // still means every event before it was delivered.
      return !tick.hasMore && terminalActivityStatuses.has(tick.status) ? tick.status : null;
    },
    doneFrame: (status) => activityDoneFrameSchema.parse({ status, lastSequence }),
  });
}
