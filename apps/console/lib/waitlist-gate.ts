/**
 * The waiting list's gate, as a decision rather than a request.
 *
 * "Is in a team" cannot be the test: `bootstrap_current_user` gives
 * every account a personal team on its first sign-in, so every signed-in
 * reader is already a member of something. The claim is per account and lives
 * in `auth.users.raw_app_meta_data`, which the proxy's existing `getUser()`
 * already fetches — GoTrue reads that row from the database on every call, so
 * letting someone in takes effect on their next page load and the gate costs
 * no query of its own.
 *
 * Kept here, away from the proxy, so both halves can be read and tested as
 * what they are: two pure predicates.
 */

/** The key `shipbash_private.grant_membership` merges into the account's metadata. */
const SHIPBASH_MEMBER_CLAIM = "shipbash_member";

/**
 * Whether the reader is past the waiting list: anyone when the deployment
 * keeps none (`waitlist`, from its configuration), else an account with the
 * claim.
 */
export function isAdmitted(
	user: { app_metadata?: Record<string, unknown> | null } | null | undefined,
	waitlist: boolean,
): boolean {
	return !waitlist || user?.app_metadata?.[SHIPBASH_MEMBER_CLAIM] === true;
}

const INVITATION_PAGE = /^\/invitations\/[^/]+$/u;

/**
 * What a signed-in non-member may still reach. Deliberately three things:
 *
 * - `/waitlist` itself, read and posted to, or the wall could not be answered.
 * - `/invitations/<token>`, the page an invitation link lands on, and
 *   `POST /api/invitations/accept`, the single call its button makes. An
 *   invitation is an admission, so it has to work from behind the wall; after
 *   it lands the account carries the claim and needs nothing special again.
 *
 * Everything else — including `/cli/authorize`, which is what keeps the CLI
 * out — goes to the wall. `/auth/*`, `/login` and the static assets never
 * reach this decision at all: the proxy's matcher excludes them.
 */
export function nonMemberMayReach(method: string, pathname: string): boolean {
	const reading = method === "GET" || method === "HEAD";
	if (pathname === "/waitlist") return reading || method === "POST";
	if (INVITATION_PAGE.test(pathname)) return reading;
	return method === "POST" && pathname === "/api/invitations/accept";
}
