import "server-only";

export { withActorEnvelope } from "@shipbash/control-plane/actor-envelope";

/** The public CLI's bearer token, when the request carries one; the Runner resolves it. */
export function bearerToken(request: Request): string | null {
	const value = request.headers.get("authorization");
	return value?.startsWith("Bearer ")
		? value.slice("Bearer ".length).trim() || null
		: null;
}
