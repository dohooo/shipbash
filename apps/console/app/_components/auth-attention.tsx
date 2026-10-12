"use client";

import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { readQuery, type webClient } from "../../lib/web-client";
import type { AttentionItem } from "../_lib/journeys";
import { QueryError } from "./shell";

type AuthAttention = Awaited<
	ReturnType<typeof webClient.authAttention>
>["items"][number];
type TeamHref = (pathname: string) => Route;

function target(item: AuthAttention, teamHref: TeamHref): Route {
	const suffix = item.signInId
		? `?signIn=${encodeURIComponent(item.signInId)}`
		: "";
	return teamHref(`/settings/sign-ins${suffix}`);
}

function description(item: AuthAttention): string {
  return item.accountLogin ? `GitHub @${item.accountLogin}: ${item.message}` : item.message;
}

export function authAttentionItems(
	items: readonly AuthAttention[],
	teamHref: TeamHref,
): AttentionItem[] {
	return items.map((item) => ({
		id: `auth-attention-${item.id}`,
		title: "GitHub sign-in needs authorization",
		body: description(item),
		actionLabel: "Manage sign-in",
		href: target(item, teamHref),
	}));
}

function useAuthAttention(projectId: string, runId: string, live = false) {
  return useQuery({ ...readQuery("authAttention", projectId, runId), refetchInterval: live ? 5_000 : false });
}

/** One persisted authorization request, on the run that produced it. */
export function RunAuthAttention({
  projectId,
  runId,
  teamHref,
  live,
}: {
  projectId: string;
  runId: string;
  teamHref: TeamHref;
  live: boolean;
}) {
  const query = useAuthAttention(projectId, runId, live);
	// A failed poll leaves the requests on screen; the next poll retries.
	if (query.isLoadingError)
		return (
			<div className="page">
				<QueryError error={query.error} retry={() => void query.refetch()} />
			</div>
		);
	if (!query.data?.items.length) return null;
	return (
		<section
			className="section page"
			aria-labelledby="run-auth-attention-title"
		>
			<header className="section-head">
				<h2 id="run-auth-attention-title">Authorization needed</h2>
			</header>
			<ul className="attention">
				{query.data.items.map((item) => (
					<li key={item.id}>
						<div>
							<strong>GitHub sign-in needs authorization</strong>
							<span>{description(item)}</span>
						</div>
						<Link className="button" href={target(item, teamHref)}>
							Manage sign-in
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
