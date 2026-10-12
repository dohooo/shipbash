import { getCliLoginContract } from "@shipbash/contracts/api/cli";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { serverLoad } from "../../../lib/server-client";
import { getVerifiedUser } from "../../../lib/supabase/server";
import { AuthPageLoading } from "../../_components/auth-page-loading";
import { route } from "../../_lib/route";
import {
	CliAuthorizeExperience,
	type CliAuthorizeState,
} from "./cli-authorize";
import { normalizePairingCode } from "./pairing-code";

export const metadata: Metadata = { title: "Authorize the CLI" };

interface AuthorizePageProps {
	searchParams: Promise<{ code?: string | string[] }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
	return typeof value === "string" ? value : value?.[0];
}

/** The screen a stored request opens on; an unknown code opens on `expired`. */
function initialState(state: string): CliAuthorizeState {
	switch (state) {
		case "pending":
			return "review";
		case "approved":
			return "working";
		case "taken":
			return "done";
		case "denied":
			return "denied";
		default:
			return "expired";
	}
}

/**
 * The browser half of `shipbash login`: the login page's chassis with the
 * pairing request in the right column. Without a session it goes through
 * /login and comes back to the same code; with one it shows the request.
 */
async function AuthorizeContent({ searchParams }: AuthorizePageProps) {
	await connection();
	const query = await searchParams;
	const code = normalizePairingCode(firstValue(query.code) ?? "");
	const returnTo = code
		? `/cli/authorize?code=${encodeURIComponent(code)}`
		: "/cli/authorize";
	const user = await getVerifiedUser();
	if (!user) redirect(route(`/login?next=${encodeURIComponent(returnTo)}`));
	const account = user.email ?? user.user_metadata?.user_name ?? "your account";

	if (!code) {
		return (
			<CliAuthorizeExperience
				account={account}
				code={null}
				initial="entry"
				request={null}
				returnTo={returnTo}
			/>
		);
	}
	const request = await serverLoad(getCliLoginContract, { params: { code } })
		.then((payload) => payload.request)
		.catch(() => null);
	return (
		<CliAuthorizeExperience
			account={account}
			code={code}
			initial={request ? initialState(request.state) : "expired"}
			request={
				request
					? {
							client: request.client,
							device: request.device,
							expiresAt: request.expiresAt,
						}
					: null
			}
			returnTo={returnTo}
		/>
	);
}

export default function AuthorizePage(props: AuthorizePageProps) {
	return (
		<Suspense
			fallback={<AuthPageLoading />}
		>
			<AuthorizeContent {...props} />
		</Suspense>
	);
}
