import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import {
	listTeamUsage,
	listWaitlistRequests,
	type TeamUsageView,
	type WaitlistRequestView,
} from "../../../lib/waitlist-client";
import { AuthPageLoading } from "../../_components/auth-page-loading";
import { TeamUsageTable, type TeamUsageRow } from "./team-usage-table";
import { unlockedWaitlistAdminPassword } from "./unlocked";
import { WaitlistAdminGate } from "./waitlist-admin-gate";
import {
	WaitlistAdminList,
	type WaitlistCounts,
	type WaitlistRow,
} from "./waitlist-admin-list";

export const metadata: Metadata = { title: "Internal" };

const ASKED_ON = new Intl.DateTimeFormat("en", {
	day: "numeric",
	month: "short",
	timeZone: "UTC",
});

function hostOf(site: string): string {
	try {
		return new URL(site).host;
	} catch {
		return site;
	}
}

function rowOf(request: WaitlistRequestView): WaitlistRow {
	const siteHost = hostOf(request.site);
	return {
		userId: request.userId,
		siteHost,
		mark: siteHost.slice(0, 2).toUpperCase(),
		email: request.email,
		askedOn: ASKED_ON.format(new Date(request.requestedAt)),
		shelved: request.state === "shelved",
	};
}

const USD = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

function teamRowOf(team: TeamUsageView): TeamUsageRow {
	return {
		teamId: team.teamId,
		name: team.name,
		slug: team.slug,
		runs: team.runsThisMonth,
		cost: USD.format(team.costThisMonthUsd),
		quota: team.monthlyRunQuota,
	};
}

function countsOf(requests: readonly WaitlistRequestView[]): WaitlistCounts {
	return {
		waiting: requests.filter((request) => request.state === "waiting").length,
		shelved: requests.filter((request) => request.state === "shelved").length,
		admitted: requests.filter((request) => request.state === "admitted").length,
	};
}

/**
 * The waiting list, as the deployment's operator works through it. Nothing
 * links here, and one shared password from the environment stands in for the
 * account there is none of. The table lists only what is still open — an
 * admitted row has nothing left to decide, and its number is in the counts.
 * Below it, every team's month: its Runs, its priced usage and its quota.
 */
async function WaitlistAdminContent() {
	await connection();
	const password = await unlockedWaitlistAdminPassword();
	if (!password) return <WaitlistAdminGate />;
	const [requests, teams] = await Promise.all([
		listWaitlistRequests(password),
		listTeamUsage(password),
	]);
	return (
		<WaitlistAdminList
			counts={countsOf(requests)}
			rows={requests
				.filter((request) => request.state !== "admitted")
				.map(rowOf)}
		>
			<TeamUsageTable rows={teams.map(teamRowOf)} />
		</WaitlistAdminList>
	);
}

export default function WaitlistAdminPage() {
	return (
		<Suspense
			fallback={<AuthPageLoading />}
		>
			<WaitlistAdminContent />
		</Suspense>
	);
}
