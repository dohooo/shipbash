/**
 * A run page's address, `/<team slug>/<project slug>/verifications/<run id>`,
 * in the only forms the database writes: slugs from `shipbash_slugify`
 * (lowercase letters, digits and dashes, with a `-N` suffix on a clash) and
 * run ids from `generatedTextId("suite_run")`. The anonymous run card answers
 * nothing else, so a value outside these forms is refused before any lookup.
 *
 * Dependency-free so the console's proxy can read it.
 */
export const SLUG_PATTERN = /^[a-z0-9-]{1,200}$/u;
export const RUN_ID_PATTERN = /^suite_run_[0-9a-f]{32}$/u;

/** Whether three path segments could name a run page. */
export function isRunAddress(
	teamSlug: string | undefined,
	projectSlug: string | undefined,
	runId: string | undefined,
): boolean {
	return (
		SLUG_PATTERN.test(teamSlug ?? "") &&
		SLUG_PATTERN.test(projectSlug ?? "") &&
		RUN_ID_PATTERN.test(runId ?? "")
	);
}
