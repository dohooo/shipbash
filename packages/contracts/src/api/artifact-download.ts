/**
 * How a link asks for a run artifact as a file to save rather than to show:
 * `?download=1` on its route (GET /api/projects/:projectId/verifications/
 * :runId/artifacts/:artifactId). The route redirects to Storage's origin,
 * where a link's own `download` attribute no longer applies, so it signs the
 * file as an attachment named for its label instead. The console's download
 * controls build the link here and the route reads it here.
 */
const DOWNLOAD_PARAM = "download";

/** The artifact's route, asking to save the file. */
export function artifactDownloadUrl(url: string): string {
	return `${url}?${DOWNLOAD_PARAM}=1`;
}

/** Whether a request to the artifact's route asks to save the file. */
export function asksArtifactDownload(url: URL): boolean {
	return url.searchParams.get(DOWNLOAD_PARAM) === "1";
}
