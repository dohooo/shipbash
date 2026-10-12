import { getProductionRuntimeResources, isVercelRuntime } from "../../../../../lib/production-resources";
import { privateJson } from "../../../../../lib/private-json";
import { handleJobApiRequest } from "../../../../../lib/server-contracts";

type RouteContext = { params: Promise<{ jobId: string; method: string }> };

// A task Sandbox's call, forwarded by its firewall with the Sandbox's signed
// identity; no session is involved (job-api/server.ts). The heaviest calls
// are a run's evidence batches and a leg's saved session, well inside this.
// Node is the default runtime; cacheComponents refuses a `runtime` export.
export const maxDuration = 60;

export async function POST(request: Request, context: RouteContext): Promise<Response> {
	// Only a deployment's own Sandboxes reach it, by its own Vercel identity.
	if (!isVercelRuntime()) return privateJson({ ok: false, error: "NOT_FOUND" }, 404);
	const { jobId, method } = await context.params;
	return handleJobApiRequest(request, { jobId, method }, getProductionRuntimeResources().jobApi);
}
