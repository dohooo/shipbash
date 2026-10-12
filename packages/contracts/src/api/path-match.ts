/**
 * The raw path segments a route template names, or null when the path is not
 * that route: as many segments, each `:name` segment non-empty, every literal
 * segment equal. Segments come back exactly as they appear in the path.
 */
export function matchApiPath(
	template: string,
	pathname: string,
): Record<string, string> | null {
	const expected = template.split("/");
	const actual = pathname.split("/");
	if (expected.length !== actual.length) return null;
	const params: Record<string, string> = {};
	for (const [index, segment] of expected.entries()) {
		const value = actual[index] ?? "";
		if (segment.startsWith(":") && value) params[segment.slice(1)] = value;
		else if (segment !== value) return null;
	}
	return params;
}
