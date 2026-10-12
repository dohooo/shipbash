import {
  getProductionRuntimeResources,
  isVercelRuntime,
} from "../../../../lib/production-resources";
import { sweepProductionChatState, sweepProductionSlackAlerts } from "../../../../lib/production-runtime";
import { privateJson } from "../../../../lib/private-json";
import { wakeProductionSchedules } from "../../../../lib/production-schedule-wakeup";
import { dispatchVercelSandboxWork, hostedConfiguration, sameSecret } from "../../../../lib/server-contracts";

function cronAuthorized(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  return sameSecret(authorization, `Bearer ${hostedConfiguration().hosted.cronSecret}`);
}

export async function GET(request: Request): Promise<Response> {
  if (!isVercelRuntime()) {
    return privateJson({ ok: false, error: "NOT_FOUND" }, 404);
  }
  if (!cronAuthorized(request)) {
    return privateJson({ ok: false, error: "UNAUTHORIZED" }, 401);
  }
  try {
    const resources = getProductionRuntimeResources();
    const result = await wakeProductionSchedules({
      store: resources.store.internal,
      onWorkAvailable: () => dispatchVercelSandboxWork(resources.store.internal, resources.workflows),
    });
    // After the wakeup has dispatched, so no run waits on the Slack sweeps. The
    // bot's expired state goes first and on its own: it logs a failure rather
    // than failing the wakeup, and an alert sweep that throws cannot skip it.
    await sweepProductionChatState(resources);
    await sweepProductionSlackAlerts(resources);
    // Last, so no dispatch or Slack sweep waits on GitHub: the bound
    // repositories whose read went stale are read again, and the runs
    // created from now on carry what this found. GitHub not answering is
    // nothing read.
    const repositoriesRead = await resources.github?.readStaleRepositories().catch(() => null);
    return privateJson({ ok: true, ...result, repositoriesRead: repositoriesRead?.read ?? 0 });
  } catch {
    return privateJson(
      {
        ok: false,
        error: "SCHEDULE_WAKEUP_UNAVAILABLE",
        message: "Production Schedule wakeup is temporarily unavailable.",
      },
      503,
    );
  }
}
