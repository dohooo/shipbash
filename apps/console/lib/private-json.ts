/** A JSON answer only its caller may keep, and only as JSON. */
export function privateJson(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
