import { getSlackConnectContract } from "@shipbash/contracts/api/slack";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { serverLoad } from "../../../lib/server-client";
import { getVerifiedUser } from "../../../lib/supabase/server";
import { AuthPageLoading } from "../../_components/auth-page-loading";
import { route } from "../../_lib/route";
import { SlackConnect, type SlackConnectScreen } from "./slack-connect";

export const metadata: Metadata = { title: "Sign in from Slack" };

type SlackConnectQuery = "team" | "channel" | "signIn" | "failed";

const QUERY: readonly SlackConnectQuery[] = ["team", "channel", "signIn", "failed"];

interface SlackConnectPageProps {
	searchParams: Promise<Partial<Record<SlackConnectQuery, string | string[]>>>;
}

/**
 * What the page shows for its query. Slack's answer comes back as the sign-in
 * to confirm (`signIn`), named from what Slack verified, or as why there is
 * none (`failed`); before that, the card's workspace and channel send the
 * browser on to Slack.
 */
async function screenFor(first: (name: SlackConnectQuery) => string): Promise<SlackConnectScreen> {
	const signInId = first("signIn");
	if (signInId) {
		const request = await serverLoad(getSlackConnectContract, { params: { signInId } })
			.then((payload) => payload.request)
			.catch(() => null);
		return request ? { kind: "confirm", signInId, request } : { kind: "failed", reason: "expired" };
	}
	const failed = first("failed");
	const team = first("team");
	const channel = first("channel");
	if (!failed && team && channel) {
		return { kind: "leaving", href: `/api/slack/sign-in?${new URLSearchParams({ team, channel }).toString()}` };
	}
	return { kind: "failed", reason: failed === "workspace" || failed === "refused" ? failed : "expired" };
}

/**
 * Where @ShipBash's sign-in card lands a Slack user, and where Sign in with
 * Slack brings them back: the login page's chassis. Without a session it goes
 * through /login and comes back to the same address.
 */
async function SlackConnectContent({ searchParams }: SlackConnectPageProps) {
	await connection();
	const query = await searchParams;
	// The browser reads the first value of a repeated parameter; so does this.
	const first = (name: SlackConnectQuery): string => [query[name]].flat()[0] ?? "";
	const here = new URLSearchParams(QUERY.flatMap((name) => (first(name) ? [[name, first(name)]] : [])));
	const user = await getVerifiedUser();
	if (!user) redirect(route(`/login?next=${encodeURIComponent(`/slack/connect?${here.toString()}`)}`));
	return (
		<SlackConnect
			account={user.email ?? user.user_metadata?.user_name ?? "your account"}
			screen={await screenFor(first)}
		/>
	);
}

export default function SlackConnectPage(props: SlackConnectPageProps) {
	return (
		<Suspense fallback={<AuthPageLoading />}>
			<SlackConnectContent {...props} />
		</Suspense>
	);
}
