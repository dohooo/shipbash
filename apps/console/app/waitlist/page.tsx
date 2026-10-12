import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache, Suspense } from "react";

import { waitlistStandingContract } from "../../lib/api-contracts";
import { serverLoad } from "../../lib/server-client";
import { configuration } from "../../lib/server-contracts";
import { getVerifiedUser } from "../../lib/supabase/server";
import { isAdmitted } from "../../lib/waitlist-gate";
import { AuthPageLoading } from "../_components/auth-page-loading";
import { type WaitlistReceipt, WaitlistWall } from "./waitlist-wall";

/** One read serves both the title and the page. */
const standing = cache(async () => serverLoad(waitlistStandingContract, {}));

function receiptOf(request: {
	email: string;
	site: string;
}): WaitlistReceipt {
	let siteHost = request.site;
	try {
		siteHost = new URL(request.site).host;
	} catch {
		// Stored as `new URL(site).href`, so this cannot normally happen; showing
		// the raw string back is still better than showing nothing.
	}
	return {
		email: request.email,
		siteHost,
	};
}

export async function generateMetadata(): Promise<Metadata> {
	await connection();
	const { request } = await standing().catch(() => ({ request: null }));
	return { title: request ? "On the waitlist" : "Join the waitlist" };
}

/**
 * The wall itself.
 *
 * The proxy has already decided that whoever reaches this page is signed in
 * and not a member. The claim is read again here because this is the page that
 * would tell a member something untrue: what it says about somebody must not
 * depend on an entry in a matcher to be right.
 */
async function WaitlistContent() {
	await connection();
	const user = await getVerifiedUser();
	if (!user) redirect("/login?next=%2Fwaitlist");
	if (isAdmitted(user, configuration().waitlist)) redirect("/");
	const { request } = await standing();
	return (
		<WaitlistWall
			account={user.email ?? ""}
			receipt={request ? receiptOf(request) : null}
		/>
	);
}

export default function WaitlistPage() {
	return (
		<Suspense
			fallback={<AuthPageLoading />}
		>
			<WaitlistContent />
		</Suspense>
	);
}
