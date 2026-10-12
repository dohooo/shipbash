/**
 * The evidence bundles `shipbash evidence <id>` pulls, one route per thing an
 * id names: a Journey's walk by its case run id, a walk or a Discovery by its
 * Activity id. Each resolves its id to the project it belongs to, reads what
 * its page reads, and streams one zip (evidence-bundle.ts lays it out).
 */
import { activityEvidenceParamsSchema } from "@shipbash/contracts/api/activities";
import { caseRunEvidenceParamsSchema } from "@shipbash/contracts/api/runs";
import { activityPageView } from "./activity-views.ts";
import { parseParams } from "./contracts/server.ts";
import { activityBundleLayout, bundleLayout, journeyOfWalk, runRecord } from "./evidence-bundle.ts";
import type { BundleFile } from "./gateways.ts";
import { ApiError, requireConfigured } from "./http.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { suiteRunDetailView } from "./views.ts";
import { type ZipEntry, writeZip } from "./zip-stream.ts";

/**
 * The bundle as one zip named after the id: README.md, each record the route
 * read as a JSON file, then the stored files, read ahead from Storage in the
 * order given.
 */
async function sendBundle(
  context: RouteContext,
  id: string,
  bundle: { readme: string; records: Record<string, object>; stored: readonly BundleFile[] },
): Promise<true> {
  const { response, options } = context;
  const artifacts = requireConfigured(options.artifacts, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact Storage is unavailable.");
  const reads = artifacts.readBundleFiles({ files: bundle.stored });
  let closed = false;
  response.once("close", () => { closed = true; });
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { path: "README.md", data: Buffer.from(bundle.readme) };
    for (const [path, record] of Object.entries(bundle.records)) {
      yield { path, data: Buffer.from(`${JSON.stringify(record, null, 2)}\n`) };
    }
    for await (const entry of reads) {
      if (closed) return;
      yield entry;
    }
  }
  response.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="shipbash-evidence-${id.replace(/^case_run_/u, "").slice(0, 8)}.zip"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  // Once the headers are out an error cannot be a status: the zip is left without its end, which the reader refuses.
  await writeZip(entries(), (chunk) => response.write(chunk)).catch((error: unknown) => {
    console.error(`[evidence-bundle] ${id} stopped:`, error);
  });
  response.end();
  return true;
}

async function handleCaseRunBundle(context: RouteContext): Promise<boolean> {
  const { url, request, actor, options } = context;
  const match = url.pathname.match(/^\/api\/case-runs\/([^/]+)\/evidence\.zip$/u);
  if (!match || request.method !== "GET") return false;
  const { caseRunId } = parseParams(caseRunEvidenceParamsSchema, { caseRunId: match[1] });
  const page = await options.store.getCaseRunPage(actor, caseRunId);
  if (!page) throw new ApiError(404, "CASE_RUN_NOT_FOUND", "Walk was not found.");
  const { teamId, projectId, runId } = page;
  const detail = await options.store.getSuiteRunDetail(actor, teamId, projectId, runId);
  const focus = detail ? journeyOfWalk(detail, caseRunId) : null;
  if (!detail || !focus) throw new ApiError(404, "CASE_RUN_NOT_FOUND", "Walk was not found.");
  const walkIds = focus.attempts.map((attempt) => attempt.caseRunId);
  const stored = await options.store.listCaseRunArtifacts(actor, teamId, projectId, walkIds);
  const { readme, evidence, files } = bundleLayout({ detail, focus, caseRunId, stored });
  const run = runRecord(suiteRunDetailView(detail, projectId));
  return sendBundle(context, caseRunId, { readme, records: { "evidence.json": evidence, "run.json": run }, stored: files });
}

async function handleActivityBundle(context: RouteContext): Promise<boolean> {
  const { url, request, actor, options } = context;
  const match = url.pathname.match(/^\/api\/activities\/([^/]+)\/evidence\.zip$/u);
  if (!match || request.method !== "GET") return false;
  const { activityId } = parseParams(activityEvidenceParamsSchema, { activityId: match[1] });
  const page = await options.store.getActivityPage(actor, activityId);
  const detail = page ? await options.store.getActivityDetail(actor, page.teamId, page.projectId, activityId) : null;
  if (!page || !detail) throw new ApiError(404, "ACTIVITY_NOT_FOUND", "No walk or Discovery you can read has that id.");
  const view = await activityPageView(context, page, detail);
  const { readme, evidence, record, files } = activityBundleLayout({ detail, view });
  return sendBundle(context, activityId, { readme, records: { "evidence.json": evidence, "activity.json": record }, stored: files });
}

export const handleEvidence = firstHandled(handleCaseRunBundle, handleActivityBundle);
