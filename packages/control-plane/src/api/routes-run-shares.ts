import {
  getVerificationShareContract,
  updateVerificationShareContract,
} from "@shipbash/contracts/api/public-verifications";
import { parseBody, parseParams, sendContractJson } from "./contracts/server.ts";
import { ApiError } from "./http.ts";
import { matchRoute } from "./match-route.ts";
import { projectContext, type RouteContext } from "./route-support.ts";

export async function handleRunShares(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, getVerificationShareContract, updateVerificationShareContract);
  if (!hit) return false;
  const contract = hit.route;
  const { projectId, runId } = parseParams(contract.params, hit.raw);
  const { teamId, teamRole } = await projectContext(options.store, actor, projectId);
  if (teamRole !== "admin") throw new ApiError(403, "ADMIN_REQUIRED", "Project Admin required.");
  const share = request.method === "PUT"
    ? await options.store.setSuiteRunShare(
        actor, teamId, projectId, runId,
        (await parseBody(request, updateVerificationShareContract.body)).isPublic,
      )
    : await options.store.getSuiteRunShare(actor, teamId, projectId, runId);
  if (!share) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found.");
  const shareUrl = share.token
    ? `/share/verifications/${encodeURIComponent(share.token)}`
    : null;
  sendContractJson(response, 200, contract, { isPublic: share.isPublic, shareUrl, caseIds: share.caseIds });
  return true;
}
